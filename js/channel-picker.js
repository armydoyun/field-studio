// 입력 채널(iChannel0–3) 칩과 고르기 팝오버.
// 칩 4개는 늘 한 줄에 보인다: 버퍼는 글자 배지 + 읽는 시점(cur/prev), 이미지는 아이콘 + 이름, 빈 칸은 ＋.
// 칩을 누르면 팝오버에서 읽는 시점(current/previous) · 버퍼(출력이 여럿이면 출력별) · 이미지 · 불러오기 · 연결 해제를 고른다.
// 시점을 버퍼와 따로 고르므로 목록은 버퍼 수만큼만 늘어난다. 고를 수 없는 버퍼는 이유와 함께 비활성으로 둔다.
// 코드가 읽는 채널은 진하게, 읽지 않는 채널은 흐리게 두고, "읽는데 비어 있음 / 연결했는데 안 읽음"은 경고 점으로 알린다.
// 연결 규칙(current는 앞선 패스만)은 project-model.js가 정하고, 바뀐 연결을 적용하는 일은 studio.js가 한다.

import * as Cubemap from "./cubemap.js";

// 값 형식(이전 select와 같음): "" 연결 없음 · "tex:<id>" 이미지 · "cube:<id>" 큐브맵 · "keyboard" 키보드 · "media:<종류>" 미디어
// · "<버퍼>:<current|previous>[:<출력>]"
const valueOf = ref =>
  !ref
    ? ""
    : ref.keyboard
      ? "keyboard"
      : ref.media
        ? `media:${ref.media}`
        : ref.cubemap
          ? `cube:${ref.cubemap}`
          : ref.texture
            ? `tex:${ref.texture}`
            : `${ref.buffer}:${ref.frame}${ref.attachment ? `:${ref.attachment}` : ""}`;
const refOf = value => {
  if (!value) return null;
  if (value === "keyboard") return { keyboard: true };
  if (value.startsWith("media:")) return { media: value.slice(6) };
  if (value.startsWith("cube:")) return { cubemap: value.slice(5) };
  if (value.startsWith("tex:")) return { texture: value.slice(4) };
  const [buffer, frame, att] = value.split(":");
  return att ? { buffer, frame, attachment: Number(att) } : { buffer, frame };
};
// 주석을 뺀 소스에서 iChannelN을 읽는지 찾는다.
const usedChannels = source => {
  const code = String(source || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return new Set([...code.matchAll(/\biChannel([0-3])\b/g)].map(m => Number(m[1])));
};

// 미디어 입력(media-input.js): 칩 배지 · 고르기 단추 이름
const MEDIA = {
  mic: { badge: "MIC", label: "마이크" },
  audio: { badge: "♪", label: "오디오 파일…" },
  webcam: { badge: "CAM", label: "웹캠" },
  video: { badge: "▶", label: "영상 파일…" },
};
const MEDIA_STATE = { off: "꺼짐", starting: "켜는 중", error: "오류" };

// inputInfo(ref, assets) → {source, frame, help}: studio.js와 같은 설명 문구
// onChange(i, ref|null): 연결을 바꾼다 · onLoadImage(i): 파일을 골라 i에 연결 · onDropImage(i, file)
// onMedia(i, 종류): 미디어를 켜고(파일 종류는 파일을 골라) i에 연결 · mediaState(종류) → {state, name, error}
const create = ({
  $,
  on,
  element,
  inputInfo,
  onChange,
  onLoadImage,
  onDropImage,
  onMedia = () => {},
  mediaState = () => ({ state: "off" }),
}) => {
  const holder = $("studioChannels"),
    bar = $("studioInputs"),
    picker = element("div");
  picker.id = "studioChannelPicker";
  picker.className = "channel-picker";
  picker.hidden = true;
  picker.setAttribute("role", "dialog");
  bar.append(picker);

  let state = { target: "Image", channels: {}, assets: [], passes: [], validCurrent: () => true },
    chips = [],
    hints = [],
    used = new Set(),
    openIndex = -1,
    frame = "current",
    options = [];

  const short = ref => {
    if (!ref) return { badge: "＋", tag: "", kind: "empty" };
    if (ref.keyboard) return { badge: "⌨", tag: "키보드", kind: "keyboard" };
    if (ref.media) {
      const media = mediaState(ref.media);
      return {
        badge: MEDIA[ref.media]?.badge || "?",
        tag: media.state === "on" ? media.name : MEDIA_STATE[media.state] || media.state,
        kind: "media",
        state: media.state,
      };
    }
    if (ref.cubemap) {
      const asset = state.assets.find(item => item.id === ref.cubemap);
      return { badge: "CUBE", tag: asset?.name || "없는 이미지", kind: asset ? "cube" : "missing" };
    }
    if (ref.texture) {
      const asset = state.assets.find(item => item.id === ref.texture);
      return { badge: "", tag: asset?.name || "없는 이미지", kind: asset ? "image" : "missing" };
    }
    return {
      badge: `${ref.buffer}${ref.attachment ? `[${ref.attachment}]` : ""}`,
      tag: ref.frame === "current" ? "cur" : "prev",
      kind: "buffer",
    };
  };
  // 칩 하나의 내용·설명·경고를 그 자리에서 고친다(포커스와 요소를 그대로 둔다).
  const paint = i => {
    const chip = chips[i],
      hint = hints[i],
      ref = state.channels?.[i],
      info = inputInfo(ref, state.assets),
      view = short(ref),
      badge = element("span"),
      tag = element("span");
    chip.value = valueOf(ref);
    chip.dataset.kind = view.kind;
    chip.dataset.state = view.state || "";
    badge.className =
      view.kind === "image" || view.kind === "missing" ? "chip-badge glyph-icon icon-image" : "chip-badge";
    badge.textContent = view.badge;
    tag.className = "chip-tag";
    tag.textContent = view.tag;
    chip.replaceChildren(badge, ...(view.tag ? [tag] : []));
    const reads = used.has(i),
      warn = reads && !ref ? "empty" : !reads && ref ? "unused" : "";
    chip.dataset.used = String(reads);
    chip.dataset.warn = warn;
    hint.textContent = `${info.source} · ${info.frame} — ${info.help}`;
    const note =
      warn === "empty"
        ? ` · 코드가 iChannel${i}을 읽지만 연결이 없습니다`
        : warn === "unused"
          ? ` · 연결했지만 코드가 iChannel${i}을 읽지 않습니다`
          : "";
    chip.title = `iChannel${i} · ${hint.textContent}${note}`;
    chip.setAttribute("aria-label", `iChannel${i}: ${info.source} · ${info.frame}${note}`);
  };

  const close = ({ refocus = false } = {}) => {
    if (openIndex < 0) return;
    const chip = chips[openIndex];
    picker.hidden = true;
    chip?.setAttribute("aria-expanded", "false");
    openIndex = -1;
    if (refocus) chip?.focus?.();
  };
  const choose = value => {
    const i = openIndex;
    if (value === "load" || value === "loadcube") {
      close({ refocus: true });
      onLoadImage(i, value === "loadcube");
      return;
    }
    if (value.startsWith("media:")) {
      close({ refocus: true });
      onMedia(i, value.slice(6));
      return;
    }
    onChange(i, refOf(value));
    paint(i);
    close({ refocus: true });
  };
  const textNode = reason => {
    const why = element("small");
    why.textContent = reason;
    return why;
  };
  const button = (value, label, { disabled = false, reason = "", pressed, className = "" } = {}) => {
    const item = element("button"),
      text = element("span");
    item.type = "button";
    item.value = value;
    item.dataset.value = value;
    item.className = `channel-option ${className}`.trim();
    item.disabled = disabled;
    text.textContent = label;
    item.append(text, ...(reason ? [textNode(reason)] : []));
    if (pressed !== undefined) item.setAttribute("aria-pressed", String(pressed));
    item.title = reason ? `${label} — ${reason}` : label;
    on(item, "click", () => {
      if (!item.disabled) choose(value);
    });
    options.push(item);
    return item;
  };
  const group = (title, items, note = "") => {
    const box = element("div"),
      head = element("p"),
      row = element("div");
    box.className = "channel-picker-group";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", title);
    head.className = "channel-picker-title";
    head.textContent = title;
    row.className = "channel-picker-items";
    row.append(...items);
    box.append(head, row);
    if (note) {
      const small = element("p");
      small.className = "channel-picker-note";
      small.textContent = note;
      box.append(small);
    }
    return box;
  };
  // 팝오버 내용: 읽는 시점 · 버퍼 · 이미지 · 해제
  const build = () => {
    const i = openIndex,
      ref = state.channels?.[i],
      current = valueOf(ref);
    options = [];
    const head = element("p");
    head.className = "channel-picker-head";
    head.textContent = `${state.target === "Image" ? "Image" : `Buffer ${state.target}`} · iChannel${i}`;
    // 읽는 시점: 바꾸면 지금 연결된 버퍼도 그 시점으로 바꾼다(가능할 때만).
    const frames = ["current", "previous"].map(name => {
      const toggle = element("button");
      toggle.type = "button";
      toggle.className = "channel-frame";
      toggle.dataset.frame = name;
      const word = element("span");
      word.textContent = name;
      toggle.append(word, textNode(name === "current" ? "이번 프레임" : "지난 프레임"));
      toggle.title =
        name === "current"
          ? "앞서 실행된 버퍼의 이번 프레임 결과"
          : "지난 프레임에 저장된 결과 · 자기 자신도 연결 가능(피드백)";
      toggle.setAttribute("aria-pressed", String(frame === name));
      on(toggle, "click", () => {
        frame = name;
        if (ref?.buffer && (name === "previous" || state.validCurrent(ref.buffer))) {
          onChange(i, { ...ref, frame: name });
          paint(i);
        }
        build();
        options.find(item => item.dataset.frame === name)?.focus?.();
      });
      options.push(toggle);
      return toggle;
    });
    const buffers = [],
      blocked = [];
    for (const pass of state.passes) {
      const outputs = pass.outputs || 1,
        allowed = frame === "previous" || state.validCurrent(pass.name);
      if (!allowed) blocked.push(pass.name);
      for (let att = 0; att < outputs; att++) {
        const value = `${pass.name}:${frame}${att ? `:${att}` : ""}`,
          label = outputs > 1 ? `${pass.name}[${att}]` : pass.name;
        buffers.push(
          button(value, label, {
            disabled: !allowed,
            reason: allowed ? "" : pass.name === state.target ? "자기 참조 불가" : "실행 순서상 불가",
            pressed: current === value,
            className: "channel-buffer",
          })
        );
      }
    }
    const images = state.assets.map(asset =>
      button(`tex:${asset.id}`, asset.name, {
        pressed: current === `tex:${asset.id}`,
        className: "channel-image glyph-icon icon-image",
      })
    );
    images.push(button("load", "이미지 불러오기…", { className: "channel-load glyph-icon icon-plus" }));
    // 큐브맵: 같은 이미지를 6면 큐브맵(samplerCube)으로. 비율이 맞지 않는 이미지는 이유와 함께 비활성.
    const cubes = state.assets.map(asset => {
      const layout = Cubemap.layoutOf(asset.width, asset.height);
      return button(`cube:${asset.id}`, asset.name, {
        disabled: !layout.kind,
        reason: layout.kind ? "" : "비율이 맞지 않음",
        pressed: current === `cube:${asset.id}`,
        className: "channel-cube",
      });
    });
    cubes.push(button("loadcube", "큐브맵 이미지 불러오기…", { className: "channel-load glyph-icon icon-plus" }));
    // 입력: 키보드(쉐이더토이 호환 256×3 텍스처). 뷰포트를 클릭하면 키가 셰이더로 간다.
    const inputs = [button("keyboard", "키보드", { pressed: current === "keyboard", className: "channel-keyboard" })];
    // 미디어: 고르면 켜고(권한 · 파일 고르기) 연결한다. 연결돼 있지만 꺼져 있으면 다시 골라 켠다.
    for (const [kind, { label }] of Object.entries(MEDIA)) {
      const media = mediaState(kind),
        reason =
          media.state === "on"
            ? `켜짐 · ${media.name}`
            : media.state === "error"
              ? media.error
              : current === `media:${kind}`
                ? "꺼짐 · 눌러 켜기"
                : "";
      inputs.push(
        button(`media:${kind}`, label, {
          pressed: current === `media:${kind}`,
          reason,
          className: `channel-media channel-${kind}`,
        })
      );
    }
    const clear = button("", "연결 해제", { disabled: !ref, className: "channel-clear" });
    const sections = [
      head,
      group("읽는 시점", frames),
      group(
        "버퍼",
        buffers.length ? buffers : [textNode("버퍼 패스가 없습니다. 패스 탭의 +로 추가하세요.")],
        blocked.length
          ? `${blocked.join(", ")}: current는 앞서 실행되는 버퍼만 읽을 수 있습니다. previous로 연결하세요.`
          : ""
      ),
      group("이미지", images),
      group("큐브맵", cubes, "samplerCube로 읽기 · 4:3 · 3:4 십자, 6:1 · 1:6 띠, 2:1 파노라마"),
      group(
        "입력",
        inputs,
        "키보드 256×3: x = 키 코드, y = 0 누름 · 1 이번 프레임에 눌림 · 2 토글 · 소리 512×2: y = 0.25 주파수 · 0.75 파형 · 카메라 · 영상: 위쪽이 v = 1"
      ),
      clear,
    ];
    picker.replaceChildren(...sections);
    picker.setAttribute("aria-label", `iChannel${i} 입력 고르기`);
  };
  const place = () => {
    const chip = chips[openIndex],
      chipBox = chip?.getBoundingClientRect?.(),
      barBox = bar.getBoundingClientRect?.();
    if (!chipBox || !barBox || !picker.style) return;
    const width = Math.min(300, barBox.width - 16);
    picker.style.width = `${width}px`;
    picker.style.left = `${Math.max(8, Math.min(chipBox.left - barBox.left, barBox.width - width - 8))}px`;
    picker.style.top = `${chipBox.bottom - barBox.top + 4}px`;
  };
  const open = i => {
    if (openIndex === i) {
      close({ refocus: true });
      return;
    }
    close();
    openIndex = i;
    const ref = state.channels?.[i];
    frame = ref?.buffer ? ref.frame : state.target === "Image" ? "current" : "previous";
    build();
    picker.hidden = false;
    chips[i].setAttribute("aria-expanded", "true");
    place();
    (
      options.find(item => item.getAttribute?.("aria-pressed") === "true" && !item.dataset.frame) ||
      options.find(item => !item.disabled)
    )?.focus?.();
  };

  // 팝오버 안 키보드: 화살표로 이동, Esc로 닫고 칩으로 돌아간다.
  on(picker, "keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close({ refocus: true });
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const live = options.filter(item => !item.disabled && item.isConnected !== false);
    const index = live.indexOf(document.activeElement);
    if (!live.length) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1,
      next =
        event.key === "Home" ? 0 : event.key === "End" ? live.length - 1 : (index + step + live.length) % live.length;
    live[next].focus?.();
  });
  on(document, "pointerdown", event => {
    if (openIndex < 0) return;
    const target = event.target;
    if (picker.contains?.(target) || chips.some(chip => chip.contains?.(target))) return;
    close();
  });

  // state: {target, channels, assets, passes:[{name, outputs}], validCurrent(name), source}
  const render = next => {
    close();
    state = next;
    used = usedChannels(next.source);
    chips = [];
    hints = [];
    holder.replaceChildren();
    for (let i = 0; i < 4; i++) {
      const row = element("div"),
        label = element("label"),
        chip = element("button"),
        hint = element("p");
      row.className = "studio-channel";
      label.textContent = `${i}`;
      label.title = `iChannel${i}`;
      label.htmlFor = chip.id = `studioChannel${i}`;
      chip.type = "button";
      chip.className = "studio-channel-chip";
      chip.setAttribute("aria-haspopup", "dialog");
      chip.setAttribute("aria-expanded", "false");
      chip.setAttribute("aria-controls", "studioChannelPicker");
      hint.id = `studioChannelHelp${i}`;
      hint.className = "studio-channel-help";
      chip.setAttribute("aria-describedby", `${hint.id} studioChannelRules`);
      on(chip, "click", () => open(i));
      // 이미지 파일을 칩에 끌어다 놓으면 그 채널에 연결한다(편집기 전체의 드롭보다 먼저 받는다).
      on(chip, "dragover", event => {
        if (!event.dataTransfer?.types?.includes?.("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        chip.dataset.drop = "true";
      });
      on(chip, "dragleave", () => {
        chip.dataset.drop = "";
      });
      on(chip, "drop", event => {
        chip.dataset.drop = "";
        const file = event.dataTransfer?.files?.[0];
        if (!file || !file.type?.startsWith?.("image/")) return;
        event.preventDefault();
        event.stopPropagation();
        onDropImage(i, file);
      });
      chips.push(chip);
      hints.push(hint);
      row.append(label, chip, hint);
      holder.append(row);
      paint(i);
    }
  };
  // 코드를 고칠 때마다 부른다: 읽는 채널 표시·경고만 다시 칠한다.
  const syncUsage = source => {
    const next = usedChannels(source);
    if ([0, 1, 2, 3].every(i => next.has(i) === used.has(i))) return;
    used = next;
    chips.forEach((_, i) => paint(i));
  };
  // 미디어 상태가 바뀌면 칩만 다시 칠한다(열린 팝오버도 다시 만든다).
  const refresh = () => {
    chips.forEach((_, i) => paint(i));
    if (openIndex >= 0) build();
  };
  return { render, syncUsage, close, refresh, isOpen: () => openIndex >= 0 };
};

export { create, valueOf, refOf, usedChannels };
