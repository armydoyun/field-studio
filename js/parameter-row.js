// 파라미터 목록의 행 하나(이름 · 설명 · 버튼들 · 값 조작 · 연결 시트)를 만든다. ui.js의 renderUniforms가 행 단위로 맞추며 부른다.
// 행이 쓰는 등록표(playViews · resetSyncs · changeSyncs · playButtons · liveLinks · parameterViews · 패드 다시 그리기)와
// 함수들은 ui.js가 ctx로 넘긴다. 다른 곳에서도 바뀌는 값(열린 연결 시트 · 삭제 되돌리기 · 바꾸기 전 값 보기 · 조건 다시 그리기 …)은
// ctx.이름으로 그때그때 읽고 쓴다(getter · setter). item은 행이 계속 붙잡는 객체 — 값이 바뀌면 ui.js가 같은 객체를 고친다.
//   create(ctx) → buildRow(item, defaults) → { row, group }
import * as ParameterTools from "./parameter-tools.js";
import * as ValueEditor from "./value-editor.js";
import * as MatrixControl from "./matrix-control.js";
import * as Annotations from "./annotations.js";
import * as Links from "./links.js";
import * as LinkSheet from "./link-sheet.js";

const create = ctx => (item, defaults) => {
  const {
    $,
    renderer,
    element,
    showError,
    attempt,
    typeInfo,
    liveValue,
    displayNumber,
    showNumber,
    rangedWidth,
    rangeEnds,
    scrubbable,
    directionControl,
    positionControl,
    enumControl,
    gradientControl,
    curveControl,
    parseValue,
    parameterViews,
    annotatedDefaults,
    formatDefault,
    changeSyncs,
    syncChanges,
    playing,
    playViews,
    playButtons,
    resetSyncs,
    syncPlayButtons,
    togglePlay,
    randomValue,
    lockedParameters,
    writeDefaults,
    stopMorph,
    linkOf,
    watchLink,
    pendingKeys,
    flushKeys,
    recordKey,
    heldNav,
    keyNav,
    linkEditor,
    conditionHidden,
    renderUniforms,
  } = ctx;
  const userList = $("uniformList");
  const row = element("div");
  row.className = "uniform-row";
  row.dataset.type = item.type;
  row.dataset.name = item.name;
  const top = element("div");
  top.className = "uniform-top";
  const title = element("div");
  title.className = "uniform-title";
  const name = element("span");
  name.className = "uniform-name";
  name.textContent = item.name;
  const type = element("span");
  type.className = "uniform-type";
  type.textContent = item.type;
  title.append(name, type);
  const spec = defaults.get(item.name),
    annotated = spec && spec.type === item.type;
  const changedTag = element("span");
  changedTag.className = "ui-tag ui-tag--accent uniform-changed";
  changedTag.textContent = annotated ? "변경됨" : "기본값 없음";
  changedTag.title = annotated
    ? "코드 기본값과 다른 값입니다."
    : "비교할 코드 기본값이 없습니다. 현재 값을 코드에 반영해 기본값을 정하세요.";
  title.append(changedTag);
  const syncChanged = (value = liveValue(item)) => {
    const changed = ParameterTools.changedFromDefault({ ...item, value }, spec);
    changedTag.classList.toggle("is-unchanged", !changed);
    changedTag.setAttribute("aria-hidden", String(!changed));
    row.dataset.changed = String(changed);
  };
  changeSyncs.set(item.name, syncChanged);
  syncChanged();
  // 설명: 주석에서 첫 태그 앞에 쓴 글.
  let description = null;
  if (annotated && spec.description) {
    description = element("span");
    description.className = "uniform-desc";
    description.textContent = spec.description;
  }
  const remove = element("button");
  remove.className = "ui-icon-btn ui-icon-btn--xs ui-icon-btn--danger remove-uniform glyph-icon icon-trash";
  remove.type = "button";
  remove.title = `${item.name} 삭제 · 코드의 선언도 함께 지웁니다(삭제 되돌리기 · Ctrl+Z)`;
  remove.setAttribute("aria-label", `${item.name} 삭제`);
  // 지우기: 코드가 uniform 선언 없이 이 이름을 쓰고 있었으면(파라미터가 선언을 대신해 왔다) 다시 컴파일이 실패한다.
  // 그래도 지운 채로 두고, 그 오류는 편집기의 오류 표시(해당 줄 · 상태 줄 · 뷰포트 안내)로 보여 준다 — 화면은 마지막 성공 결과.
  // 코드를 고치거나 '삭제 되돌리기'를 누르면 풀린다.
  remove.addEventListener("click", () =>
    attempt(() => {
      const current = renderer.getUserUniforms().find(u => u.name === item.name);
      if (!current) return renderUniforms();
      // 코드가 선언한 파라미터: 선언 줄도 함께 지운다(Undo 한 번). 코드가 아직 그 이름을 쓰면 오류는 편집기에 보인다.
      // 컴파일을 기다리는 동안은 '적용 중'으로 두고, 끝나면 결과로 바꾼다(확장이 없으면 바로 결과).
      let settled = false;
      const viaCode = window.shaderStudio?.removeParameter?.(item.name, applied => {
        settled = true;
        $("uniformNotice").textContent = applied
          ? `${item.name} 삭제됨 · 코드의 선언도 지웠습니다`
          : `${item.name} 삭제됨 · 코드가 아직 ${item.name}을(를) 써서 컴파일 오류 — 편집기에서 고치거나 삭제 되돌리기`;
      });
      if (viaCode) {
        ctx.deletedUniform = { ...current, viaCode: true };
        $("undoUniform").hidden = false;
        if (!settled) $("uniformNotice").textContent = `${item.name} 삭제됨 · 코드 적용 중…`;
        renderUniforms();
        $("undoUniform").focus();
        return;
      }
      // 코드에 선언이 없는 파라미터: 셰이더가 쓰지 않으니 등록만 지운다(다시 컴파일하지 않는다)
      renderer.removeUniform(item.name);
      ctx.deletedUniform = { ...current };
      $("undoUniform").hidden = false;
      $("uniformNotice").textContent = `${item.name} 삭제됨`;
      renderUniforms();
      $("undoUniform").focus();
    })
  );
  let reset = null,
    syncReset = null;
  if (annotated) {
    // 기본값으로 되돌리기: 버튼 또는 슬라이더 더블클릭. 이미 기본값이면 버튼을 비활성화한다.
    const fallback = Annotations.clampValue(spec.value, item.options || {}, item.type);
    reset = element("button");
    reset.className = "ui-icon-btn ui-icon-btn--xs reset-uniform glyph-icon icon-reset";
    reset.type = "button";
    reset.title = `기본값(${formatDefault(fallback)})으로 되돌리기 · 슬라이더 더블클릭`;
    reset.setAttribute("aria-label", `${item.name} 기본값으로 되돌리기`);
    // 소리 · MIDI · 흔들기 연결이 값을 정하는 동안은 되돌려도 다음 프레임에 덮어써지므로 끈다(키프레임은 재생선에 키로 남는다)
    const drivenLink = Links.LINKABLE.has(item.type) ? linkOf(item.name) : null,
      driven = drivenLink && drivenLink.source !== "keys";
    if (driven) reset.title = "연결이 값을 정하는 동안은 되돌릴 수 없습니다(연결을 끄면 다시 쓸 수 있음)";
    syncReset = (value = liveValue(item)) => {
      reset.disabled = driven || ParameterTools.equalValue(value, fallback);
    };
    syncReset();
    resetSyncs.set(item.name, syncReset);
    const restore = () => {
      if (ParameterTools.equalValue(liveValue(item), fallback)) return;
      if (!commit(reset, Array.isArray(fallback) ? [...fallback] : fallback)) return;
      renderUniforms();
      $("uniformNotice").textContent = `${item.name} 기본값으로 되돌림`;
      [...userList.querySelectorAll(".uniform-row")]
        .find(r => r.querySelector(".uniform-name")?.textContent === item.name)
        ?.querySelector(".reset-uniform, input")
        ?.focus();
    };
    reset.addEventListener("click", restore);
    row.addEventListener("dblclick", event => {
      if (event.target instanceof HTMLInputElement && event.target.type === "range") restore();
    });
  }
  // 덧붙이는 버튼: 무작위(@seed) · 재생(@anim).
  const extras = [];
  const lock = element("button");
  lock.className = "ui-icon-btn ui-icon-btn--xs lock-uniform glyph-icon";
  lock.type = "button";
  const syncLock = () => {
    const locked = lockedParameters.has(item.name);
    lock.classList.toggle("icon-lock", locked);
    lock.classList.toggle("icon-unlock", !locked);
    lock.setAttribute("aria-pressed", String(locked));
    lock.setAttribute("aria-label", `${item.name} 무작위 변경 잠금`);
    lock.title = locked ? "잠금 해제: 전체 무작위·조금씩 바꾸기에 포함" : "잠금: 전체 무작위·조금씩 바꾸기에서 제외";
  };
  syncLock();
  lock.addEventListener("click", () => {
    if (lockedParameters.has(item.name)) lockedParameters.delete(item.name);
    else lockedParameters.add(item.name);
    syncLock();
  });
  const write = element("button");
  write.className = "ui-icon-btn ui-icon-btn--xs write-default-uniform glyph-icon icon-down";
  write.type = "button";
  write.title = "현재 값을 코드 기본값에 반영";
  write.setAttribute("aria-label", `${item.name} 현재 값을 코드에 반영`);
  write.addEventListener("click", () => writeDefaults([item.name]));
  extras.push(lock, write);
  if (item.options?.seed) {
    const dice = element("button");
    dice.className = "ui-icon-btn ui-icon-btn--xs seed-uniform glyph-icon icon-dice";
    dice.type = "button";
    dice.title = "무작위 값";
    dice.setAttribute("aria-label", `${item.name} 무작위 값`);
    dice.addEventListener("click", () => {
      if (!commit(dice, randomValue(item))) return;
      renderUniforms();
      $("uniformNotice").textContent = `${item.name} = ${formatDefault(item.value)}`;
      userList.querySelector?.(`.seed-uniform[data-name="${item.name}"]`)?.focus();
    });
    dice.dataset.name = item.name;
    extras.push(dice);
  }
  if (item.options?.anim) {
    const play = element("button");
    play.className = `ui-icon-btn ui-icon-btn--xs play-uniform glyph-icon ${playing.has(item.name) ? "icon-pause" : "icon-play"}`;
    play.type = "button";
    play.title = item.options.angle
      ? `재생: ${displayNumber(item.options.anim)}초에 한 바퀴`
      : item.options.enum
        ? `재생: 선택지마다 ${displayNumber(item.options.anim)}초씩 차례로`
        : item.type === "float"
          ? `재생: ${displayNumber(item.options.anim)}초 주기로 범위 왕복`
          : `재생: ${displayNumber(item.options.anim)}초 주기로 한 칸씩 왕복`;
    play.setAttribute("aria-label", `${item.name} 재생`);
    play.setAttribute("aria-pressed", String(playing.has(item.name)));
    play.addEventListener("click", () => {
      togglePlay(item);
      syncPlayButtons();
    });
    playButtons.set(item.name, play);
    extras.push(play);
  }
  const link = Links.LINKABLE.has(item.type) ? linkOf(item.name) : null,
    keyed = link?.source === "keys"; // 키프레임 줄: 슬라이더는 살려 두고 바꾸면 자동 키
  if (Links.LINKABLE.has(item.type)) {
    const linkButton = element("button");
    linkButton.className = "ui-icon-btn ui-icon-btn--xs link-uniform glyph-icon icon-link";
    linkButton.type = "button";
    linkButton.title = link
      ? `연결됨: ${LinkSheet.describe(link)} · 누르면 연결 설정`
      : "연결: 소리 · MIDI · 흔들기 · 키프레임이 이 값을 정하게 하기";
    linkButton.setAttribute("aria-label", `${item.name} 연결 설정`);
    linkButton.setAttribute("aria-expanded", String(ctx.openLink === item.name));
    linkButton.setAttribute("aria-pressed", String(!!link));
    linkButton.addEventListener("click", () => {
      ctx.openLink = ctx.openLink === item.name ? null : item.name;
      renderUniforms();
      $("uniformList").querySelector(`.link-editor[data-name="${item.name}"] [role="radio"][tabindex="0"]`)?.focus();
    });
    extras.push(linkButton);
  }
  if (link) {
    row.classList.add("is-linked");
    const badge = element("span");
    badge.className = "ui-tag ui-tag--dot link-badge";
    badge.textContent = LinkSheet.describe(link);
    badge.title = "연결이 값을 제어합니다";
    title.append(badge);
  }
  const valueEditor = (target, change, compact = true) => {
    const view = ValueEditor.create({
      name: target.name,
      type: target.type,
      options: target.options,
      read: () => liveValue(target),
      onChange: change,
      compact,
      getContext: () => renderer.getFragmentSource(),
      onApplied: () => {
        renderUniforms();
        [...$("uniformList").querySelectorAll(".value-edit-open")]
          .find(button => button.dataset.name === target.name)
          ?.focus();
      },
    });
    parameterViews.push(view);
    return view;
  };
  if (!typeInfo(item.type).count && ["f", "i", "u", "b"].includes(typeInfo(item.type).kind) && !(link && !keyed)) {
    const editor = valueEditor(item, (source, next) => commit(source, next));
    extras.push(editor.button);
  }
  top.append(title, ...extras, ...(reset ? [reset] : []), remove);
  if (description) top.append(description);
  const commit = (field, value) => {
    if (ctx.viewingA) return false;
    // 사용자가 직접 바꾸면 그 파라미터의 재생과 프리셋 전환을 멈춘다(전환을 멈췄다고 알린다).
    if (playing.delete(item.name)) syncPlayButtons();
    stopMorph(true);
    try {
      renderer.setUniform(item.name, value);
      item.value = value;
      if (keyed) recordKey(item.name, value);
      syncReset?.();
      syncChanged();
      syncChanges();
      field.removeAttribute("aria-invalid");
      showError("");
      // 이 값이 다른 파라미터의 @if를 바꾸면 목록을 다시 그리고 초점은 이 파라미터 줄로 돌려 둔다.
      // 슬라이더 · 패드를 끄는 중이면 다시 그리는 순간 끌던 조작이 사라져 끌기가 끊기므로, 손을 뗄 때까지 미룬다.
      if (!$("uniformSearch").value.trim()) {
        const users = renderer.getUserUniforms();
        if (conditionHidden(users, annotatedDefaults()).join() !== ctx.hiddenKey) {
          // 그사이 다른 갱신(0.5초마다 도는 updateStats)이 이미 목록을 맞췄을 수 있다 — 그래도 초점은 이 줄로
          // 돌려 둔다(예전에는 이미 맞춰져 있으면 초점 옮기기까지 건너뛰어, 끄던 줄을 가끔 잃었다).
          const redraw = () => {
            if ($("uniformSearch").value.trim()) return;
            if (conditionHidden(renderer.getUserUniforms(), annotatedDefaults()).join() !== ctx.hiddenKey)
              renderUniforms();
            const target = [...$("uniformList").querySelectorAll(".uniform-row")].find(
              node => node.dataset.name === item.name
            );
            if (target && !target.contains(document.activeElement))
              target.querySelector("input,button,select")?.focus();
          };
          if (ctx.listPointer) ctx.conditionRedraw = redraw;
          else queueMicrotask(redraw);
        }
      }
      return true;
    } catch (error) {
      field.setAttribute("aria-invalid", "true");
      showError(`${item.name}: ${error.message}`);
      return false;
    }
  };
  row.append(top);
  if (keyed) {
    // 키프레임 내비게이터 + 자동 키. 재생 중 값은 지금 키프레임 값으로 따라간다(이 줄을 만지는 동안은 그대로).
    const nav = keyNav(item, link);
    // 연결 시트가 열려 있으면 내비게이터는 시트 안(방식 버튼 아래)에 둔다: 방식을 바꿀 때 생기고 사라지는 칸이
    // 누른 버튼 아래쪽에서만 바뀌어, 버튼이 화면에서 위아래로 튀지 않는다.
    if (ctx.openLink === item.name) heldNav.set(row, nav.node);
    else row.append(nav.node);
    row.classList.add("is-keyed");
    row.addEventListener("pointerdown", () => (ctx.keyPointer = true));
    row.addEventListener("change", () => setTimeout(flushKeys));
    row.addEventListener("keyup", () => pendingKeys.size && setTimeout(flushKeys));
    // 숫자는 자릿수를 고정해(범위 · step 기준) 재생 중에 글자 폭이 흔들리지 않게 한다
    const span = (item.options?.max ?? 1) - (item.options?.min ?? 0),
      step = String(item.options?.step ?? ""),
      digits = ["int", "uint", "bool"].includes(item.type)
        ? 0
        : Math.min(
            4,
            step.includes(".")
              ? step.split(".")[1].length
              : Math.max(2, 3 - Math.floor(Math.log10(Math.max(1e-6, Math.abs(span)))))
          );
    const follow = value => {
      nav.update();
      // 값 칸(숫자 · 슬라이더 · 위젯)을 만지는 중일 때만 멈춘다 — 줄의 다른 곳(연결 시트 · 키 설정)에 초점이 있어도 값은 따라간다
      const active = document.activeElement,
        editing =
          row.contains(active) &&
          !active.closest(".key-nav, .link-editor, .uniform-top") &&
          active.matches("input, select, .ui-select, textarea, [role=slider], [tabindex]");
      if (editing || pendingKeys.has(item.name)) return;
      // 숫자가 아닌 값 · 로그 눈금 · 다이얼 · 선택지 위젯은 위젯 자신의 갱신 함수로
      if (typeof value !== "number" || item.options?.log || item.options?.angle || item.options?.enum)
        return playViews.get(item.name)?.(typeof value === "number" ? Number(value.toFixed(4)) : value);
      // 연결 시트의 반복 길이·부드러움 입력은 파라미터 값이 아니다.
      // 실제 값 위젯만 갱신해야 설정 초안과 저장된 반복 길이를 덮어쓰지 않는다.
      const number = row.querySelector('.uniform-pair > input[type="number"]'),
        slider = row.querySelector('.uniform-pair > input[type="range"]');
      if (number) {
        number.value = value.toFixed(digits);
        number.title = String(value);
      }
      if (slider) slider.value = String(value);
      if (!number && !slider) playViews.get(item.name)?.(value);
    };
    watchLink(item.name, follow);
    // 행을 새로 그린 직후 첫 프레임에는 숫자 칸이 일반 형식(뒤 0을 지운 자릿수)이라, 다음 연결 갱신까지 자릿수가 바뀌어
    // 보였다(시트를 열고 닫을 때마다 깜빡임). 행이 다 만들어진 뒤 지금 값을 같은 고정 자릿수로 한 번 채운다.
    queueMicrotask(() => {
      if (row.isConnected) follow(liveValue(item));
    });
  }
  // 값 편집기(위젯). 배열이면 원소마다 하나씩 그린다: 원소 몫만 읽고(read) 바꾸면 전체 배열을 고쳐 올린다.
  const widget = (row, item, commit, name) => {
    if (item.type === "bool") {
      const label = element("label");
      label.className = "ui-switch ui-switch--field uniform-switch";
      const input = element("input");
      input.type = "checkbox";
      input.checked = item.value;
      input.setAttribute("role", "switch");
      const text = element("span");
      text.textContent = item.value ? "켜짐 · true" : "꺼짐 · false";
      input.setAttribute("aria-label", item.name);
      input.addEventListener("change", () => {
        if (!commit(input, input.checked)) input.checked = item.value;
        text.textContent = input.checked ? "켜짐 · true" : "꺼짐 · false";
      });
      label.append(input, text);
      row.append(label);
      // 밖에서 바뀐 값(프리셋 · 되돌리기)을 행을 다시 만들지 않고 보여 준다
      playViews.set(item.name, value => {
        input.checked = !!value;
        text.textContent = value ? "켜짐 · true" : "꺼짐 · false";
      });
    } else if (item.type === "sampler2D") {
      const current = () => [...(liveValue(item) || item.value)],
        ramp = item.options?.gradient ? gradientControl(item, commit, current) : curveControl(item, commit, current);
      playViews.set(item.name, ramp.refresh);
      row.append(ramp);
    } else if (item.options?.color) {
      // 색상: 견본(컬러 피커) · 직접 고칠 수 있는 HEX · 0~1 선형 값. vec4의 A는 이름이 붙은 슬라이더 줄로 따로 둔다.
      const wrap = element("div");
      wrap.className = "uniform-color";
      const picker = element("input");
      picker.type = "color";
      picker.setAttribute("aria-label", `${item.name} 색상`);
      const hexField = element("input");
      hexField.type = "text";
      hexField.className = "uniform-hex";
      hexField.spellcheck = false;
      hexField.maxLength = 7;
      hexField.setAttribute("aria-label", `${item.name} HEX`);
      const code = element("code");
      const hex = values =>
        "#" +
        values
          .slice(0, 3)
          .map(v =>
            Math.round(Math.max(0, Math.min(1, v)) * 255)
              .toString(16)
              .padStart(2, "0")
          )
          .join("");
      const channels = item.type === "vec4" ? "RGBA" : "RGB";
      // @color hdr: 견본은 가장 밝은 성분을 1로 맞춘 색(base), 밝기 배율 I = 가장 큰 성분. 값 = base × I.
      const hdr = item.options.hdr;
      // 0~1 숫자 줄은 HEX와 같은 말이라 HDR(1을 넘는 값)일 때만 보인다
      wrap.classList.toggle("is-hdr", !!hdr);
      let alpha = null,
        alphaNumber = null,
        intensity = null,
        intensityNumber = null,
        lastBase = [1, 1, 1];
      const split = values => {
        const level = Math.max(0, ...values.slice(0, 3));
        if (level > 0) lastBase = values.slice(0, 3).map(v => Math.max(0, v) / level);
        return { level, base: lastBase };
      };
      const show = values => {
        if (hdr) {
          const { level, base } = split(values);
          picker.value = hex(base);
          intensity.value = String(level);
          showNumber(intensityNumber, level);
        } else picker.value = hex(values);
        hexField.value = picker.value;
        hexField.removeAttribute("aria-invalid");
        code.textContent = values
          .slice(0, 3)
          .map(v => Number(v).toFixed(2))
          .join(" ");
        code.title = `${channels} ${values.map(v => Number(v).toFixed(4)).join(", ")}`;
        if (alpha) {
          alpha.value = String(values[3]);
          showNumber(alphaNumber, values[3]);
        }
      };
      const current = () => [...(liveValue(item) || item.value)];
      const setRGB = (field, text) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
        if (!match) {
          field.setAttribute("aria-invalid", "true");
          showError(`${item.name}: #RRGGBB 형식의 HEX 색을 입력하세요.`);
          return;
        }
        const values = current(),
          picked = match[1].match(/../g).map(h => parseInt(h, 16) / 255);
        // HDR stores peak-normalized color × I. Raw picker RGB would attenuate I on every input.
        // Normalize the picked color first; an explicit black remains black, and zero I revives at 1.
        const level = hdr ? split(values).level || 1 : 1,
          peak = Math.max(...picked),
          base = hdr && peak > 0 ? picked.map(v => v / peak) : picked;
        // Keep HDR radiance precision: fixed decimal rounding can turn small nonzero I into zero.
        values.splice(0, 3, ...base.map(v => (hdr ? v * level : Number(v.toFixed(6)))));
        if (commit(field, values)) show(values);
      };
      picker.addEventListener("input", () => setRGB(picker, picker.value));
      hexField.addEventListener("change", () => setRGB(hexField, hexField.value));
      hexField.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          setRGB(hexField, hexField.value);
        } else if (event.key === "Escape") {
          show(current());
          showError("");
        }
      });
      wrap.append(picker, hexField, code);
      row.append(wrap);
      if (hdr) {
        const line = element("div");
        line.className = "uniform-axis is-ranged uniform-alpha uniform-intensity";
        const label = element("label");
        label.className = "uniform-axis-label";
        label.textContent = "I";
        label.title = "밝기 배율";
        intensity = element("input");
        intensity.type = "range";
        intensity.min = "0";
        intensity.max = String(hdr);
        intensity.step = String(Number((hdr / 1000).toPrecision(2)));
        intensity.setAttribute("aria-label", `${item.name} 밝기 배율`);
        intensityNumber = element("input");
        intensityNumber.type = "number";
        intensityNumber.min = "0";
        intensityNumber.step = "any";
        intensityNumber.setAttribute("aria-label", `${item.name} 밝기 배율 값`);
        const setLevel = (field, level) => {
          if (!Number.isFinite(level)) return show(current());
          const values = current(),
            { base } = split(values);
          values.splice(0, 3, ...base.map(v => v * Math.max(0, level)));
          if (commit(field, values)) show(values);
          else show(current());
        };
        intensity.addEventListener("input", () => setLevel(intensity, Number(intensity.value)));
        intensityNumber.addEventListener("change", () =>
          setLevel(intensityNumber, intensityNumber.value.trim() ? Number(intensityNumber.value) : NaN)
        );
        scrubbable(label, {
          kind: "f",
          read: () => Number(split(current()).level.toFixed(3)),
          write: value => setLevel(intensity, value),
          min: 0,
          step: hdr / 200,
        });
        line.append(label, intensity, intensityNumber);
        row.append(line);
      }
      if (item.type === "vec4") {
        const line = element("div");
        line.className = "uniform-axis is-ranged uniform-alpha";
        const label = element("label");
        label.className = "uniform-axis-label";
        label.textContent = "A";
        alpha = element("input");
        alpha.type = "range";
        alpha.min = "0";
        alpha.max = "1";
        alpha.step = "0.001";
        alpha.setAttribute("aria-label", `${item.name} 알파`);
        alphaNumber = element("input");
        alphaNumber.type = "number";
        alphaNumber.min = "0";
        alphaNumber.max = "1";
        alphaNumber.step = "0.01";
        alphaNumber.setAttribute("aria-label", `${item.name} 알파 값`);
        const setAlpha = (field, value) => {
          const values = current();
          values[3] = Math.max(0, Math.min(1, value));
          if (Number.isFinite(value) && commit(field, values)) show(values);
          else show(current());
        };
        alpha.addEventListener("input", () => setAlpha(alpha, Number(alpha.value)));
        alphaNumber.addEventListener("change", () =>
          setAlpha(alphaNumber, alphaNumber.value.trim() ? Number(alphaNumber.value) : NaN)
        );
        scrubbable(label, {
          kind: "f",
          read: () => current()[3],
          write: value => setAlpha(alpha, value),
          min: 0,
          max: 1,
          step: 0.01,
        });
        line.append(label, alpha, alphaNumber);
        row.append(line);
      }
      show(item.value);
      // 프리셋 전환 · 재생처럼 밖에서 바뀐 값을 목록을 다시 그리지 않고 보여 준다
      playViews.set(item.name, values => Array.isArray(values) && show(values));
    } else if (item.options?.enum) {
      const choices = enumControl(item, commit);
      playViews.set(item.name, choices.refresh);
      row.append(choices);
    } else if (item.options?.pos) {
      const pad = positionControl(item, commit, () => [...(liveValue(item) || item.value)]);
      playViews.set(item.name, pad.refresh);
      row.append(pad);
    } else if (item.options?.angle) {
      const dial = directionControl(item, commit, () => {
        const value = liveValue(item);
        return typeof value === "number" ? value : item.value;
      });
      playViews.set(item.name, dial.refresh);
      row.append(dial);
    } else if (item.options?.dir) {
      const pad = directionControl(item, commit, () => [...(liveValue(item) || item.value)]);
      playViews.set(item.name, pad.refresh);
      row.append(pad);
    } else if (typeInfo(item.type).kind === "m") {
      const view = MatrixControl.create({
        name: item.name,
        size: Math.round(Math.sqrt(item.value.length)),
        read: () => liveValue(item) || item.value,
        onChange: commit,
        getContext: () => renderer.getFragmentSource(),
      });
      parameterViews.push(view);
      playViews.set(item.name, () => view.refresh());
      row.append(view.node);
    } else if (typeInfo(item.type).components > 1) {
      // 벡터는 X/Y/Z/W 성분별로 편집한다. bvec 성분은 체크박스.
      // 범위가 지정된 벡터는 성분마다 슬라이더 + 숫자 입력을 둔다.
      const { kind } = typeInfo(item.type);
      // 배치: bvec은 X·Y… 토글 칩 두 칸씩, 범위 없는 vec2는 두 칸 한 줄, vec3·vec4는 성분마다 한 줄(긴 값도 잘리지 않음),
      // 범위가 있으면 성분마다 [글자 | 슬라이더 | 숫자].
      const opts = item.options || {},
        ranged = kind !== "b" && Number.isFinite(opts.min) && Number.isFinite(opts.max);
      const layout =
        kind === "b" ? "is-bool" : ranged ? "is-ranged" : item.value.length <= 2 ? "is-inline" : "is-stacked";
      const grid = element("div");
      grid.className = `uniform-vector ${layout}`;
      // 성분마다 밖에서 바뀐 값을 보여 주는 함수(프리셋 전환). 입력 중인 숫자 칸은 showNumber가 건드리지 않는다.
      const refreshers = [];
      item.value.forEach((value, index) => {
        const field = element(kind === "b" ? "label" : "div");
        field.className =
          kind === "b"
            ? "ui-chip ui-chip--lg uniform-axis"
            : ranged
              ? "uniform-axis is-ranged"
              : "ui-input-group ui-input-group--prefix uniform-axis";
        const label = element(kind === "b" ? "span" : "label");
        label.className = kind === "b" || ranged ? "uniform-axis-label" : "ui-unit uniform-axis-label";
        label.textContent = ["X", "Y", "Z", "W"][index];
        const input = element("input");
        input.setAttribute("aria-label", `${item.name} ${label.textContent}`);
        input.id = `uniform-component-${++ctx.componentSerial}`;
        label.htmlFor = input.id;
        if (kind === "b") {
          input.type = "checkbox";
          input.checked = value;
        } else {
          input.type = "number";
          input.step = kind === "f" || kind === "m" ? "any" : "1";
          if (kind === "u") input.min = "0";
          showNumber(input, value, () => liveValue(item)?.[index]);
        }
        const update = (source, next) => {
          const values = liveValue(item);
          if (!values) return renderUniforms();
          item.value = [...values];
          values[index] = next;
          if (!commit(source, values)) {
            if (kind === "b") input.checked = item.value[index];
            else showNumber(input, item.value[index]);
            return false;
          }
          if (kind !== "b") showNumber(input, liveValue(item)?.[index] ?? next);
          return true;
        };
        let slider = null;
        input.addEventListener("change", () => {
          if (update(input, kind === "b" ? input.checked : input.value.trim() ? Number(input.value) : NaN) && slider)
            slider.value = input.value;
        });
        // 성분별 범위(@range를 성분마다)면 이 성분의 범위를 쓴다.
        const axis = opts.ranges?.[index]
          ? { min: opts.ranges[index][0], max: opts.ranges[index][1], step: opts.ranges[index][2] }
          : opts;
        if (kind !== "b")
          scrubbable(label, {
            kind,
            min: axis.min,
            max: axis.max,
            step: axis.step,
            read: () => liveValue(item)?.[index],
            write: next => {
              if (update(label, next)) {
                showNumber(input, next);
                if (slider) slider.value = String(next);
              }
            },
          });
        if (ranged) {
          slider = element("input");
          slider.type = "range";
          slider.min = String(axis.min);
          slider.max = String(axis.max);
          slider.step = String(axis.step);
          slider.value = String(value);
          slider.setAttribute("aria-label", `${item.name} ${label.textContent} 슬라이더`);
          if (opts.ranges)
            field.title = `${label.textContent}: ${displayNumber(axis.min)} ~ ${displayNumber(axis.max)}`;
          slider.addEventListener("input", () => {
            if (update(slider, Number(slider.value))) showNumber(input, Number(slider.value));
          });
          field.append(label, slider, input);
        } else if (kind === "b") field.append(input, label);
        else field.append(label, input);
        grid.append(field);
        refreshers.push(values => {
          const next = values[index];
          if (kind === "b") input.checked = !!next;
          else showNumber(input, next);
          if (slider && document.activeElement !== slider) slider.value = String(next);
        });
      });
      row.append(grid);
      playViews.set(item.name, values => Array.isArray(values) && refreshers.forEach(refresh => refresh(values)));
      if (ranged) {
        row.style.setProperty("--number-width", rangedWidth(opts));
        if (!opts.ranges) row.append(rangeEnds(opts, true));
      }
    } else {
      // 숫자 하나: 범위가 있으면 [슬라이더 | 숫자] + 아래에 최소·최대, 없으면 숫자 칸이 줄 전체를 쓴다. 이름을 끌면 값이 바뀐다.
      const pair = element("div");
      const { kind } = typeInfo(item.type);
      const number = element("input");
      number.type = "number";
      number.step = kind === "f" ? "any" : "1";
      if (item.type === "uint") number.min = "0";
      showNumber(number, item.value, () => liveValue(item));
      number.setAttribute("aria-label", item.name);
      const opts = item.options || {},
        ranged = Number.isFinite(opts.min) && Number.isFinite(opts.max);
      // @log: 슬라이더는 0~1 위치를 쓰고 값은 min·(max/min)^t로 바꾼다. 0.001~100처럼 넓은 범위의 아래쪽도 고르게 다룬다.
      const logScale = ranged && opts.log === true && opts.min > 0,
        logSpan = logScale ? Math.log(opts.max / opts.min) : 1,
        toSlider = value =>
          logScale ? Math.min(1, Math.max(0, Math.log(Math.max(value, opts.min) / opts.min) / logSpan)) : value,
        fromSlider = t => (logScale ? Number((opts.min * Math.exp(t * logSpan)).toPrecision(4)) : t);
      let range;
      pair.className = ranged ? "uniform-pair is-ranged" : "uniform-pair";
      const changeNumber = () => {
        let value;
        try {
          value = parseValue(item.type, number.value);
        } catch (error) {
          showError(`${item.name}: ${error.message}`);
          number.setAttribute("aria-invalid", "true");
          showNumber(number, liveValue(item) ?? item.value);
          return;
        }
        if (commit(number, value)) {
          if (range) range.value = String(toSlider(value));
          showNumber(number, value);
        } else showNumber(number, liveValue(item) ?? item.value);
      };
      number.addEventListener("change", changeNumber);
      if (ranged) {
        range = element("input");
        range.type = "range";
        range.min = String(logScale ? 0 : opts.min);
        range.max = String(logScale ? 1 : opts.max);
        range.step = logScale ? "0.001" : String(opts.step);
        range.setAttribute("aria-label", `${item.name} 슬라이더${logScale ? "(로그 눈금)" : ""}`);
        if (logScale) {
          range.classList.add("is-log");
          range.title = "로그 눈금";
        }
        range.value = String(toSlider(item.value));
        range.addEventListener("input", () => {
          if (commit(range, fromSlider(Number(range.value)))) showNumber(number, item.value);
        });
        pair.append(range);
      }
      pair.append(number);
      row.append(pair);
      if (ranged) {
        row.style.setProperty("--number-width", rangedWidth(opts));
        row.append(rangeEnds(opts, false));
      }
      const readValue = () => liveValue(item);
      scrubbable(name, {
        kind,
        // 로그 눈금이면 이름 끌기도 슬라이더 위치(0~1)로 움직여 배율 단위로 바뀌게 한다.
        min: logScale ? 0 : opts.min,
        max: logScale ? 1 : opts.max,
        step: logScale ? 0.005 : opts.step,
        read: () => (logScale ? Number(toSlider(readValue()).toFixed(3)) : readValue()),
        write: next => {
          const value = fromSlider(next);
          if (commit(number, value)) {
            showNumber(number, value);
            if (range) range.value = String(toSlider(value));
          }
        },
      });
      // 재생 값은 이미 step 단위라 반올림 없이 그대로 보여 준다(보이는 값 = 셰이더에 들어간 값).
      playViews.set(item.name, value => {
        showNumber(number, value);
        if (range) range.value = String(toSlider(value));
      });
    }
  };
  const array = typeInfo(item.type).count;
  if (link && !keyed) {
    // 연결이 값을 정하는 동안은 슬라이더 대신 읽기 전용 미터(움직여도 덮어써지는 조작을 두지 않는다)
    const gauge = LinkSheet.meter(item, link, () => renderer.linkActive?.(item.name) ?? true);
    watchLink(item.name, gauge.update);
    row.append(gauge.node);
  } else if (array) {
    const size = typeInfo(typeInfo(item.type).base).components,
      list = element("div");
    list.className = "uniform-array";
    for (let index = 0; index < array; index++) {
      const cell = element("div"),
        label = element("span");
      cell.className = "uniform-array-item";
      cell.dataset.type = typeInfo(item.type).base;
      label.className = "uniform-array-index";
      label.textContent = `[${index}]`;
      cell.append(label);
      const whole = () => [...(liveValue(item) || item.value)],
        read = () => (size === 1 ? whole()[index] : whole().slice(index * size, index * size + size)),
        part = { name: `${item.name}[${index}]`, type: typeInfo(item.type).base, options: item.options, read };
      part.value = read();
      const commitPart = (field, value) => {
        const next = whole();
        next.splice(index * size, size, ...(size === 1 ? [value] : value));
        if (!commit(field, next)) return false;
        part.value = value;
        return true;
      };
      widget(cell, part, commitPart, label);
      if (["f", "i", "u", "b"].includes(typeInfo(part.type).kind))
        cell.append(valueEditor(part, commitPart, false).button);
      list.append(cell);
    }
    row.append(list);
    // 배열 전체의 새 값을 원소 칸마다 나눠 보여 준다. 갱신 함수가 없는 원소가 있으면 false — 그 행을 다시 만든다.
    playViews.set(item.name, values => {
      const views = Array.from({ length: array }, (_, index) => playViews.get(`${item.name}[${index}]`));
      if (!Array.isArray(values) || views.some(view => !view)) return false;
      views.forEach((view, index) =>
        view(size === 1 ? values[index] : values.slice(index * size, index * size + size))
      );
    });
  } else widget(row, item, commit, name);
  if (ctx.openLink === item.name && Links.LINKABLE.has(item.type)) {
    const editor = linkEditor(item),
      held = heldNav.get(row);
    if (held) editor.insertBefore(held, editor.children[1] ?? null);
    // 시트는 이름 바로 아래(조작 칸 위)에 연다: 방식을 바꾸면 조작 칸(다이얼 · 슬라이더 ~ 미터)이 달라지는데,
    // 그 변화가 누른 버튼보다 아래에서만 일어나 버튼이 화면에서 튀지 않는다.
    top.after(editor);
  }
  return { row, group: annotated ? spec.group : "" };
};

export { create };
