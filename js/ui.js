// Renderer의 공개 API만 호출하는 설정 패널. WebGL 리소스를 소유하지 않는다.
import * as StageMenu from "./stage-menu.js";
import * as Recorder from "./recorder.js";
import * as Annotations from "./annotations.js";
import * as VideoDialog from "./video-dialog.js";
import * as PreviewDOM from "./preview-dom.js";
import * as Presets from "./presets.js";
import * as Links from "./links.js";
import * as Timeline from "./timeline.js";
import * as LinkSheet from "./link-sheet.js";
const mount = (renderer, input, settings) => {
  const $ = PreviewDOM.createLookup();
  const controller = new AbortController(),
    signal = controller.signal;
  const element = tag => document.createElement(tag),
    setText = (id, text) => {
      const node = $(id);
      if (node.textContent !== text) node.textContent = text;
    };
  const listen = (el, event, callback) => el.addEventListener(event, callback, { signal });
  const showError = message => {
    $("uiError").textContent = message || "";
    $("toastMessage").textContent = message || "";
    $("uiToast").hidden = !message;
    $("uiToast").classList.toggle("is-visible", !!message);
  };
  const attempt = callback => {
    try {
      callback();
      showError("");
    } catch (error) {
      showError(error.message);
    }
  };
  listen($("uiDismiss"), "click", () => showError(""));
  // 터치 기기에서 검색창에 포커스하면 가상 키보드가 패널을 가리므로 파라미터 탭에 포커스한다.
  const touchOnly = window.matchMedia?.("(hover:none) and (pointer:coarse)").matches === true;
  const focusSearch = () => (touchOnly ? $("tab-uniforms") : $("uniformSearch")).focus();
  // 타입 정보(성분 수, f/i/u/b/m 종류)는 Renderer의 표를 따른다. 새 타입이 추가돼도 UI 분기는 바뀌지 않는다.
  const typeTable = new Map((renderer.getUniformTypes?.() || []).map(item => [item.type, item]));
  const typeInfo = type => {
    // 배열("vec3[4]"): 원소 타입의 정보 + base · count, 성분 수는 전체
    const array = /^(\w+)\[(\d+)\]$/.exec(type);
    if (array) {
      const base = typeInfo(array[1]),
        count = Number(array[2]);
      return { ...base, type, base: array[1], count, components: base.components * count };
    }
    return (
      typeTable.get(type) || {
        type,
        components: Number(/^vec([234])$/.exec(type)?.[1]) || 1,
        kind: type === "bool" ? "b" : type === "int" ? "i" : "f",
      }
    );
  };
  // 파라미터의 지금 값. 배열 원소 편집기가 만든 가짜 항목(read가 있는 것)은 전체 배열에서 자기 몫을 읽는다.
  const liveValue = item =>
    item.read ? item.read() : renderer.getUserUniforms().find(u => u.name === item.name)?.value;
  const parseBool = (raw, type) => {
    if (!["true", "false", "1", "0"].includes(raw.toLowerCase()))
      throw new Error(`${type}은 true/false 또는 1/0으로 입력하세요.`);
    return raw.toLowerCase() === "true" || raw === "1";
  };
  // 슬라이더·외부 JS로 생긴 0.5239193476851991 같은 값은 소수부를 줄여 보이되, 정수부 자릿수는 절대 버리지 않는다
  // (예전처럼 유효숫자 6자리로 자르면 123456.789가 123457로 바뀌어 보였다). 전체 값은 title로 확인할 수 있다.
  const displayNumber = value => {
    if (typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value)) return String(value);
    const integerDigits = Math.max(1, Math.floor(Math.log10(Math.abs(value))) + 1);
    return String(Number(value.toPrecision(Math.min(15, Math.max(6, integerDigits + 4)))));
  };
  const showNumber = (field, value) => {
    field.value = displayNumber(value);
    field.title = String(value);
  };
  // 범위가 있는 숫자 칸의 폭: 최소·최대·step 소수 자릿수로 가장 긴 값을 계산해 고정한다(슬라이더 끝과 최소·최대 표시가 어긋나지 않게).
  const rangedWidth = opts => {
    const decimals = (String(opts.step).split(".")[1] || "").length,
      digits = Math.max(
        displayNumber(Math.trunc(opts.min)).replace("-", "").length,
        displayNumber(Math.trunc(opts.max)).replace("-", "").length
      );
    const chars = Math.min(14, Math.max(3, digits + (decimals ? decimals + 1 : 0) + (opts.min < 0 ? 1 : 0)));
    return `calc(${chars}ch + 20px)`;
  };
  // 슬라이더 아래 최소·최대 표시. 성분 슬라이더(axis)는 글자 칸만큼 들여 맞춘다.
  const rangeEnds = (opts, axis) => {
    const ends = element("div");
    ends.className = axis ? "uniform-range-ends is-axis" : "uniform-range-ends";
    ends.setAttribute("aria-hidden", "true");
    const low = element("span"),
      high = element("span");
    low.textContent = displayNumber(opts.min);
    high.textContent = displayNumber(opts.max);
    ends.append(low, high);
    return ends;
  };
  // 이름·성분 글자를 좌우로 끌어 값을 바꾼다(Blender·Figma 방식). 4px마다 한 걸음, Shift는 1/10, Ctrl은 10배.
  // 걸음 크기: 슬라이더 step → 정수 1 → 실수는 현재 값 크기의 1%(최소 0.01).
  const scrubbable = (handle, { kind, read, write, min, max, step }) => {
    handle.classList.add("is-scrub");
    handle.title = "좌우로 끌어 값 조절 · Shift 정밀 · Ctrl 크게";
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      const start = read();
      if (!Number.isFinite(start)) return;
      event.preventDefault();
      const originX = event.clientX,
        integer = kind === "i" || kind === "u";
      const base = Number.isFinite(step) && step > 0 ? step : integer ? 1 : Math.max(Math.abs(start) * 0.01, 0.01);
      const decimals = integer ? 0 : Math.min(10, Math.max(0, 1 - Math.floor(Math.log10(base))));
      handle.setPointerCapture?.(event.pointerId);
      handle.classList.add("is-scrubbing");
      const move = moveEvent => {
        const factor = moveEvent.shiftKey ? 0.1 : moveEvent.ctrlKey || moveEvent.metaKey ? 10 : 1;
        let next = start + Math.round((moveEvent.clientX - originX) / 4) * base * factor;
        if (Number.isFinite(min)) next = Math.max(min, next);
        if (Number.isFinite(max)) next = Math.min(max, next);
        if (kind === "u") next = Math.max(0, next);
        next = integer ? Math.round(next) : Number(next.toFixed(decimals));
        if (next !== read()) write(next);
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.classList.remove("is-scrubbing");
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end, { once: true });
      handle.addEventListener("pointercancel", end, { once: true });
    });
  };
  // 단위 방향(@dir) 편집기. vec2는 원형 다이얼 + 각도 슬라이더, vec3는 빛 받은 구 패드 + 방위각·고도 슬라이더 + 앞/뒤 반구 전환.
  // 성분을 따로 고치면 길이가 1에서 벗어나므로 자유도(vec2는 1, vec3는 2)에 맞는 손잡이만 준다.
  // 좌표: 화면 오른쪽 +X, 위 +Y, 보는 쪽 +Z. 방위각은 +Z에서 +X 쪽으로 돈 각, 고도는 XZ 평면에서 +Y 쪽으로 든 각이다.
  // hemi는 +Y 반구(vec2는 위쪽 반원)만 허용한다. 끌 때 Shift를 누르면 15° 단위로 맞춘다.
  const DEG = 180 / Math.PI,
    DIR_PAD = 88;
  let directionRedraws = [];
  // CSS 너비만 바뀌면 곡선의 기존 비트맵이 늘어나므로, 표시 크기에 맞춰 프레임을 그리기 전에 다시 그린다.
  const curveRedraws = new Map(),
    curveResizeObserver = window.ResizeObserver
      ? new window.ResizeObserver(entries => {
          for (const { target, contentRect } of entries)
            if (contentRect.width > 0 && contentRect.height > 0) curveRedraws.get(target)?.();
        })
      : null;
  signal.addEventListener("abort", () => {
    curveResizeObserver?.disconnect();
    curveRedraws.clear();
  });
  const PAD_SIZE = DIR_PAD;
  // 패드 색은 테마 토큰에서 고른다. 어두운 테마: 그늘 --sunken → 빛 --text-soft, 밝은 테마: 그늘 --faint → 빛 --surface.
  // 점·선은 CSS border-color(액센트)와 color(보조 선)로 넘겨받는다.
  const padColors = pad => {
    const style = window.getComputedStyle?.(pad),
      token = name => {
        const hex = /#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(style?.getPropertyValue?.(name) || "")?.[1];
        if (!hex) return null;
        return (hex.length === 3 ? [...hex].map(h => h + h) : hex.match(/../g)).map(h => parseInt(h, 16));
      },
      luma = rgb => (rgb ? rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11 : 0),
      dark = luma(token("--text")) >= luma(token("--bg"));
    return {
      lit: token(dark ? "--text-soft" : "--surface") || [200, 200, 205],
      shadow: token(dark ? "--sunken" : "--faint") || [20, 20, 22],
      sunken: token("--sunken") || [18, 19, 21],
      accent: style?.borderTopColor || "#4d8dff",
      line: style?.color || "#888",
    };
  };
  const padCanvas = (className, label, title) => {
    const pad = element("canvas");
    pad.className = `uniform-dir-pad ${className}`;
    pad.ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    pad.width = pad.height = Math.round(PAD_SIZE * pad.ratio);
    pad.tabIndex = 0;
    pad.setAttribute("role", "application");
    pad.setAttribute("aria-label", label);
    pad.title = title;
    return pad;
  };
  // 패드 끌기. 포커스가 목록 안에 있어야 주기적인 목록 다시 그리기가 끄는 도중의 패드를 바꿔치지 않는다.
  // 마우스로 잡은 포커스는 링을 숨기고(data-pointer), 키보드를 쓰면 다시 보인다.
  const padDrag = (pad, onMove) => {
    pad.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      pad.dataset.pointer = "";
      pad.focus({ preventScroll: true });
      pad.setPointerCapture?.(event.pointerId);
      pad.classList.add("is-dragging");
      const end = () => {
        pad.removeEventListener("pointermove", onMove);
        pad.classList.remove("is-dragging");
      };
      onMove(event);
      pad.addEventListener("pointermove", onMove);
      pad.addEventListener("pointerup", end, { once: true });
      pad.addEventListener("pointercancel", end, { once: true });
    });
    pad.addEventListener("keydown", () => delete pad.dataset.pointer);
  };
  // @angle(float 라디안)도 같은 다이얼을 쓴다. 표시는 0~360°로 감싸되 내부 값과 누적 바퀴 수는 유지한다.
  const directionControl = (item, commit, currentValue) => {
    const angleMode = item.options.angle === true,
      current = () => {
        const value = currentValue();
        return angleMode ? [Math.cos(value), Math.sin(value)] : value;
      };
    const hemi = item.options.dir === "hemi",
      sphere = item.type === "vec3",
      round = value => Math.round(value * 10) / 10,
      clamp = (value, low, high) => Math.min(high, Math.max(low, value));
    const wrapAngle = value => ((value % 360) + 360) % 360,
      nearestAngle = value => value + 360 * Math.round((state.angle - value) / 360);
    const wrap = element("div");
    wrap.className = `uniform-dir ${sphere ? "is-sphere" : angleMode ? "is-dial is-angle" : "is-dial"}`;
    const what = angleMode ? "각도" : "방향";
    const pad = padCanvas(
      "is-round",
      sphere
        ? `${item.name} 방향 · 끌어서 지정 · 화살표 키: 좌우 방위각, 위아래 고도 · Shift 15°`
        : `${item.name} ${what} · 끌어서 지정 · 화살표 키로 회전 · Shift 15°`,
      `끌어서 ${what} 지정 · Shift 15° 단위${sphere ? " · 속 빈 점은 뒤쪽(-Z) 반구" : ""}`
    );
    const ratio = pad.ratio;
    const side = element("div");
    side.className = "uniform-dir-side";
    const code = element("code");
    code.className = "uniform-dir-value";
    const turns = angleMode ? element("span") : null;
    if (turns) turns.className = "uniform-dir-value uniform-angle-turns";
    // 각도 상태. 극점(고도 ±90°)에서는 방위각이 정해지지 않으므로 마지막 값을 기억한다.
    const state = { angle: 0, az: 0, el: 0, back: false };
    const fromVector = v => {
      if (angleMode) state.angle = currentValue() * DEG;
      else if (!sphere) state.angle = Math.atan2(v[1], v[0]) * DEG;
      else {
        state.el = Math.asin(clamp(v[1], -1, 1)) * DEG;
        if (Math.hypot(v[0], v[2]) > 1e-6) state.az = Math.atan2(v[0], v[2]) * DEG;
        if (Math.abs(v[2]) > 1e-6) state.back = v[2] < 0;
      }
    };
    const toVector = () => {
      if (!sphere) return [Math.cos(state.angle / DEG), Math.sin(state.angle / DEG)];
      const az = state.az / DEG,
        el = state.el / DEG;
      return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
    };
    // 각도 줄: [글자 | 슬라이더 | 숫자(°)]. 슬라이더 더블클릭은 행 공통 처리로 기본값 되돌리기가 된다.
    const angleLines = [];
    const angleLine = (key, text, title, low, high) => {
      const line = element("div");
      line.className = "uniform-axis is-ranged uniform-dir-angle";
      const label = element("label");
      label.className = "uniform-axis-label";
      label.textContent = text;
      label.title = title;
      const slider = element("input");
      slider.type = "range";
      slider.min = String(low);
      slider.max = String(high);
      slider.step = "0.1";
      slider.setAttribute("aria-label", `${item.name} ${title}(°)`);
      const number = element("input");
      number.type = "number";
      if (!angleMode) {
        number.min = String(low);
        number.max = String(high);
      }
      number.step = "any";
      number.setAttribute("aria-label", `${item.name} ${title} 값(°)`);
      const set = (field, value) => {
        if (!Number.isFinite(value)) return sync(current());
        // 한 바퀴 안의 입력은 현재 값과 가장 가까운 회전으로 연결한다. 범위 밖 숫자는 누적 각도로 직접 지정한다.
        // 라벨 끌기는 누적값을 읽으므로 그대로 적용해 0° 경계에서도 연속으로 움직인다.
        if (angleMode && (field === slider || (field === number && value >= 0 && value <= 360)))
          value = nearestAngle(value);
        state[key] = angleMode ? value : clamp(value, low, high);
        apply(field, toVector());
      };
      slider.addEventListener("input", () => set(slider, Number(slider.value)));
      number.addEventListener("change", () => set(number, number.value.trim() ? Number(number.value) : NaN));
      scrubbable(label, {
        kind: "f",
        read: () => round(state[key]),
        write: value => set(label, value),
        min: angleMode ? undefined : low,
        max: angleMode ? undefined : high,
        step: 1,
      });
      line.append(label, slider, number);
      angleLines.push({ key, slider, number });
      return line;
    };
    if (sphere)
      side.append(angleLine("az", "Az", "방위각", -180, 180), angleLine("el", "El", "고도", hemi ? 0 : -90, 90));
    else side.append(angleLine("angle", "θ", "각도", angleMode || hemi ? 0 : -180, angleMode ? 360 : 180));
    // 축 버튼: 자주 쓰는 방향으로 바로 맞춘다.
    const chips = element("div");
    chips.className = "uniform-dir-chips";
    const axes = sphere
      ? [
          ["+X", [1, 0, 0]],
          ["−X", [-1, 0, 0]],
          ["+Y", [0, 1, 0]],
          ["−Y", [0, -1, 0]],
          ["+Z", [0, 0, 1]],
          ["−Z", [0, 0, -1]],
        ]
      : [
          ["+X", [1, 0]],
          ["−X", [-1, 0]],
          ["+Y", [0, 1]],
          ["−Y", [0, -1]],
        ];
    const presets = angleMode ? [0, 90, 180, 270].map(deg => [`${deg}°`, deg]) : axes;
    for (const [text, target] of presets) {
      if (hemi && target[1] < 0) continue;
      const chip = element("button");
      chip.type = "button";
      chip.className = "uniform-dir-chip";
      chip.textContent = text;
      chip.setAttribute("aria-label", angleMode ? `${item.name}을 ${text}로` : `${item.name}을 ${text} 방향으로`);
      chip.addEventListener("click", () => {
        if (angleMode) state.angle = nearestAngle(target);
        apply(chip, angleMode ? toVector() : target);
      });
      chips.append(chip);
    }
    let flip = null;
    if (sphere) {
      flip = element("button");
      flip.type = "button";
      flip.className = "uniform-dir-chip uniform-dir-flip";
      flip.textContent = "뒤";
      flip.title = "앞(+Z)/뒤(-Z) 반구 전환 · 패드에서 끌 때 어느 쪽 반구를 쓸지 정한다";
      flip.setAttribute("aria-label", `${item.name} 뒤쪽(-Z) 반구`);
      flip.addEventListener("click", () => {
        const v = current();
        state.back = !state.back;
        if (Math.abs(v[2]) > 1e-6) apply(flip, [v[0], v[1], -v[2]]);
        else sync(v);
      });
      chips.append(flip);
    }
    side.append(chips, code);
    if (turns) side.append(turns);
    wrap.append(pad, side);
    const draw = () => {
      const ctx = pad.getContext?.("2d");
      if (typeof ctx?.arc !== "function") return;
      const size = pad.width,
        c = size / 2,
        r = c - 6 * ratio,
        v = current(),
        { lit, shadow, accent, line } = padColors(pad);
      ctx.clearRect(0, 0, size, size);
      if (sphere && ctx.createImageData) {
        // 램버트 음영: 이 방향에서 오는 빛을 받은 구. 가장자리는 1px 안티에일리어싱.
        const image = ctx.createImageData(size, size),
          data = image.data;
        for (let py = 0; py < size; py++)
          for (let px = 0; px < size; px++) {
            const x = (px + 0.5 - c) / r,
              y = (c - py - 0.5) / r,
              d2 = x * x + y * y;
            if (d2 > 1 + 2 / r) continue;
            const z = Math.sqrt(Math.max(0, 1 - d2)),
              light = Math.max(0, x * v[0] + y * v[1] + z * v[2]),
              shade = 0.06 + 0.94 * light,
              i = (py * size + px) * 4;
            for (let k = 0; k < 3; k++) data[i + k] = shadow[k] + (lit[k] - shadow[k]) * shade;
            data[i + 3] = 255 * clamp((1 - Math.sqrt(d2)) * r + 0.5, 0, 1);
          }
        ctx.putImageData(image, 0, 0);
      }
      ctx.lineWidth = ratio;
      ctx.strokeStyle = line;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.moveTo(c - r, c);
      ctx.lineTo(c + r, c);
      ctx.moveTo(c, c - r);
      ctx.lineTo(c, c + r);
      ctx.stroke();
      if (hemi) {
        // 허용되지 않는 아래쪽(-Y)은 흐리게 지워 패널 바탕이 비치게 한다.
        ctx.globalAlpha = 0.6;
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillRect(0, c + ratio, size, size - c);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.globalAlpha = 1;
      const tx = c + v[0] * r,
        ty = c - v[1] * r,
        behind = sphere && v[2] < -1e-6;
      ctx.strokeStyle = ctx.fillStyle = accent;
      ctx.lineWidth = 2 * ratio;
      ctx.setLineDash?.(behind ? [3 * ratio, 3 * ratio] : []);
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash?.([]);
      ctx.beginPath();
      ctx.arc(tx, ty, 4.5 * ratio, 0, Math.PI * 2);
      if (behind) ctx.stroke();
      else ctx.fill();
    };
    const sync = v => {
      fromVector(v);
      for (const { key, slider, number } of angleLines) {
        const degrees = angleMode ? wrapAngle(round(state[key])) : round(state[key]);
        slider.value = String(degrees);
        showNumber(number, degrees);
        number.removeAttribute("aria-invalid");
      }
      if (angleMode) {
        const radians = currentValue(),
          degrees = round(state.angle),
          count = Math.floor(degrees / 360);
        code.textContent = `${(wrapAngle(degrees) / DEG).toFixed(4)} rad`;
        code.title = `셰이더에 전달하는 누적값: float ${+radians.toFixed(6)} (라디안)`;
        turns.textContent = `누적 ${count}회전`;
        turns.title = `누적 ${+state.angle.toFixed(4)}° (표시: ${count} × 360° + ${wrapAngle(degrees)}°)`;
      } else {
        code.textContent = v.map(x => (Math.abs(x) < 5e-5 ? 0 : x).toFixed(3)).join(" ");
        code.title = `${item.type}(${v.map(x => +x.toFixed(6)).join(", ")})`;
      }
      if (flip) {
        flip.setAttribute("aria-pressed", String(state.back));
        flip.classList.toggle("is-active", state.back);
      }
      draw();
    };
    // 렌더러가 길이 1(hemi면 +Y 반구)로 맞춘 값을 다시 읽어 화면을 맞춘다. 실패해도 이전 값으로 되돌려 보여 준다.
    const apply = (field, vector) => {
      commit(field, angleMode ? state.angle / DEG : vector);
      sync(current());
    };
    // 패드 위치 → 방향. 원 밖이면 가장자리(z=0)로 붙인다.
    const fromPointer = event => {
      const box = pad.getBoundingClientRect(),
        rr = (box.width / 2) * ((DIR_PAD / 2 - 6) / (DIR_PAD / 2));
      let x = (event.clientX - box.left - box.width / 2) / rr,
        y = (box.top + box.height / 2 - event.clientY) / rr;
      if (hemi) y = Math.max(0, y);
      if (!sphere) {
        if (Math.hypot(x, y) < 1e-6) return null;
        const previous = state.angle;
        state.angle = Math.atan2(y, x) * DEG;
        // @angle: 지금 값과 가장 가까운 바퀴로 이어 붙여 360°를 넘어 계속 돌릴 수 있게 한다.
        if (angleMode) state.angle += 360 * Math.round((previous - state.angle) / 360);
        if (event.shiftKey) state.angle = Math.round(state.angle / 15) * 15;
        return toVector();
      }
      const length = Math.hypot(x, y);
      if (length > 1) {
        x /= length;
        y /= length;
      }
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y)) * (state.back ? -1 : 1),
        v = [x, y, z];
      if (event.shiftKey) {
        fromVector(v);
        state.az = Math.round(state.az / 15) * 15;
        state.el = Math.round(state.el / 15) * 15;
        return toVector();
      }
      return v;
    };
    padDrag(pad, moveEvent => {
      const v = fromPointer(moveEvent);
      if (v) apply(pad, v);
    });
    pad.addEventListener("keydown", event => {
      const step = event.shiftKey ? 15 : 1,
        keys = sphere
          ? { ArrowLeft: ["az", -step], ArrowRight: ["az", step], ArrowDown: ["el", -step], ArrowUp: ["el", step] }
          : {
              ArrowLeft: ["angle", step],
              ArrowUp: ["angle", step],
              ArrowRight: ["angle", -step],
              ArrowDown: ["angle", -step],
            };
      const move = keys[event.key];
      if (!move) return;
      event.preventDefault();
      const [key, delta] = move;
      if (key === "az" || key === "angle") {
        let next = state[key] + delta;
        if (key === "angle" && hemi) next = clamp(next, 0, 180);
        else if (!angleMode) next = ((((next + 180) % 360) + 360) % 360) - 180;
        state[key] = next;
      } else state.el = clamp(state.el + delta, hemi ? 0 : -90, 90);
      apply(pad, toVector());
    });
    directionRedraws.push(draw);
    sync(current());
    wrap.refresh = () => sync(current());
    return wrap;
  };
  // @pos/@xy: vec2 위치를 정사각형 패드에서 끈다. 두 성분이 같은 범위(@range, 없으면 -1~1)를 쓴다. 화면 위쪽이 +Y.
  // 끌면 step 단위로, Shift를 누르면 범위의 1/8 격자에 맞춘다. 화살표 키는 step만큼(Shift 10배) 옮긴다.
  const positionControl = (item, commit, current) => {
    const { min, max, step } = item.options,
      span = max - min,
      decimals = Math.min(10, Math.max(0, -Math.floor(Math.log10(step)) + 1)),
      clamp = value => Math.min(max, Math.max(min, value)),
      snap = (value, grid) => Number(clamp(min + Math.round((value - min) / grid) * grid).toFixed(decimals));
    const wrap = element("div");
    wrap.className = "uniform-dir is-pos";
    const pad = padCanvas(
      "is-square",
      `${item.name} 위치 · 끌어서 지정 · 화살표 키로 이동 · Shift 크게`,
      `끌어서 위치 지정 · Shift: 범위의 1/8 격자에 맞춤 · 범위 ${displayNumber(min)} ~ ${displayNumber(max)}`
    );
    const ratio = pad.ratio;
    const side = element("div");
    side.className = "uniform-dir-side";
    const code = element("code");
    code.className = "uniform-dir-value";
    const lines = ["X", "Y"].map((axis, index) => {
      const line = element("div");
      line.className = "uniform-axis is-ranged";
      const label = element("label");
      label.className = "uniform-axis-label";
      label.textContent = axis;
      const slider = element("input");
      slider.type = "range";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);
      slider.setAttribute("aria-label", `${item.name} ${axis} 슬라이더`);
      const number = element("input");
      number.type = "number";
      number.step = "any";
      number.setAttribute("aria-label", `${item.name} ${axis}`);
      const set = (field, value) => {
        if (!Number.isFinite(value)) return sync();
        const values = current();
        values[index] = clamp(value);
        apply(field, values);
      };
      slider.addEventListener("input", () => set(slider, Number(slider.value)));
      number.addEventListener("change", () => set(number, number.value.trim() ? Number(number.value) : NaN));
      scrubbable(label, { kind: "f", min, max, step, read: () => current()[index], write: value => set(label, value) });
      line.append(label, slider, number);
      side.append(line);
      return { slider, number };
    });
    const chips = element("div");
    chips.className = "uniform-dir-chips";
    const middle = Number(((min + max) / 2).toFixed(decimals));
    const presets = [["가운데", [middle, middle]], ...(min < 0 && max > 0 && middle !== 0 ? [["원점", [0, 0]]] : [])];
    for (const [text, target] of presets) {
      const chip = element("button");
      chip.type = "button";
      chip.className = "uniform-dir-chip";
      chip.textContent = text;
      chip.title = `(${target.join(", ")})`;
      chip.setAttribute("aria-label", `${item.name}을 ${text}(${target.join(", ")})로`);
      chip.addEventListener("click", () => apply(chip, target));
      chips.append(chip);
    }
    side.append(chips, code);
    wrap.append(pad, side);
    const draw = () => {
      const ctx = pad.getContext?.("2d");
      if (typeof ctx?.arc !== "function") return;
      const size = pad.width,
        inset = 4 * ratio,
        inner = size - inset * 2,
        at = value => (value - min) / span,
        [x, y] = current(),
        { sunken, accent, line } = padColors(pad);
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = `rgb(${sunken.join(",")})`;
      ctx.fillRect(inset, inset, inner, inner);
      // 1/8 격자, 0 축(범위 안에 있을 때)은 더 진하게.
      ctx.strokeStyle = line;
      ctx.lineWidth = ratio;
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      for (let k = 1; k < 8; k++) {
        const p = inset + (inner * k) / 8;
        ctx.moveTo(p, inset);
        ctx.lineTo(p, inset + inner);
        ctx.moveTo(inset, p);
        ctx.lineTo(inset + inner, p);
      }
      ctx.stroke();
      ctx.globalAlpha = 0.45;
      ctx.strokeRect(inset, inset, inner, inner);
      if (min < 0 && max > 0) {
        const zero = inset + at(0) * inner,
          zeroY = inset + (1 - at(0)) * inner;
        ctx.beginPath();
        ctx.moveTo(zero, inset);
        ctx.lineTo(zero, inset + inner);
        ctx.moveTo(inset, zeroY);
        ctx.lineTo(inset + inner, zeroY);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const px = inset + Math.min(1, Math.max(0, at(x))) * inner,
        py = inset + (1 - Math.min(1, Math.max(0, at(y)))) * inner;
      ctx.strokeStyle = ctx.fillStyle = accent;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(px, inset);
      ctx.lineTo(px, inset + inner);
      ctx.moveTo(inset, py);
      ctx.lineTo(inset + inner, py);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(px, py, 4.5 * ratio, 0, Math.PI * 2);
      ctx.fill();
    };
    const sync = () => {
      const values = current();
      lines.forEach(({ slider, number }, index) => {
        slider.value = String(values[index]);
        showNumber(number, values[index]);
        number.removeAttribute("aria-invalid");
      });
      code.textContent = values.map(v => v.toFixed(Math.min(3, decimals))).join(" ");
      code.title = `vec2(${values.join(", ")})`;
      draw();
    };
    const apply = (field, values) => {
      commit(field, values);
      sync();
    };
    padDrag(pad, event => {
      const box = pad.getBoundingClientRect(),
        inset = (box.width * 4) / PAD_SIZE,
        grid = event.shiftKey ? span / 8 : step;
      const x = min + ((event.clientX - box.left - inset) / (box.width - inset * 2)) * span,
        y = min + (1 - (event.clientY - box.top - inset) / (box.height - inset * 2)) * span;
      apply(pad, [snap(x, grid), snap(y, grid)]);
    });
    pad.addEventListener("keydown", event => {
      const moves = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowDown: [1, -1], ArrowUp: [1, 1] },
        move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      const values = current();
      values[move[0]] = Number(clamp(values[move[0]] + move[1] * step * (event.shiftKey ? 10 : 1)).toFixed(decimals));
      apply(pad, values);
    });
    directionRedraws.push(draw);
    sync();
    return wrap;
  };
  // @enum: int/uint를 이름 붙은 선택지로. 짧은 목록은 버튼 묶음(세그먼트), 길면 드롭다운. 값은 0부터의 순번.
  const enumControl = (item, commit) => {
    const labels = item.options.enum,
      current = () => liveValue(item) ?? item.value,
      segmented = labels.length <= 6 && labels.join("").length <= 24;
    const wrap = element("div");
    if (segmented) {
      wrap.className = "uniform-enum";
      wrap.setAttribute("role", "group");
      wrap.setAttribute("aria-label", `${item.name} 선택`);
      const buttons = labels.map((label, index) => {
        const button = element("button");
        button.type = "button";
        button.className = "uniform-enum-option";
        button.textContent = label;
        button.title = `${item.name} = ${index}`;
        button.addEventListener("click", () => {
          commit(button, index);
          sync();
        });
        wrap.append(button);
        return button;
      });
      const sync = () => {
        const value = current();
        buttons.forEach((button, index) => {
          button.setAttribute("aria-pressed", String(index === value));
          button.classList.toggle("is-active", index === value);
        });
      };
      sync();
      wrap.refresh = sync;
    } else {
      wrap.className = "uniform-enum is-select";
      const select = element("select");
      select.setAttribute("aria-label", `${item.name} 선택`);
      labels.forEach((label, index) => {
        const option = element("option");
        option.value = String(index);
        option.textContent = `${index} · ${label}`;
        select.append(option);
      });
      select.value = String(current());
      select.addEventListener("change", () => {
        if (!commit(select, Number(select.value))) select.value = String(current());
      });
      wrap.append(select);
      wrap.refresh = () => (select.value = String(current()));
    }
    return wrap;
  };
  // 램프 편집기(uniform sampler2D · @gradient/@curve). 값은 렌더러가 위치 순으로 정렬해 256×1 텍스처로 굽는다.
  // 편집기는 점 객체 배열을 들고 있어 끄는 동안 순서가 바뀌어도 선택한 점을 놓치지 않는다.
  const RAMP_LIMIT = 16;
  const rampButton = (text, label, onClick) => {
    const button = element("button");
    button.type = "button";
    button.className = "uniform-dir-chip";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", onClick);
    return button;
  };
  const rampNumber = (label, min, max, step) => {
    const input = element("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute("aria-label", label);
    return input;
  };
  const toHex = rgb =>
    "#" +
    rgb
      .slice(0, 3)
      .map(v =>
        Math.round(Math.max(0, Math.min(1, v)) * 255)
          .toString(16)
          .padStart(2, "0")
      )
      .join("");
  // 그라데이션: 미리보기 막대(투명은 체크무늬 위) + 정지점 손잡이 줄 + 선택한 정지점 편집 줄.
  const gradientControl = (item, commit, current) => {
    const mode = item.options.gradient,
      clamp01 = v => Math.min(1, Math.max(0, v));
    let stops = [],
      selected = null;
    const read = () => {
      const value = current(),
        next = [];
      for (let i = 0; i < value.length; i += 5) next.push({ t: value[i], c: value.slice(i + 1, i + 5) });
      return next;
    };
    const wrap = element("div");
    wrap.className = "uniform-ramp is-gradient";
    const bar = element("canvas");
    bar.className = "uniform-ramp-bar";
    bar.ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    bar.setAttribute("aria-hidden", "true");
    const track = element("div");
    track.className = "uniform-ramp-track";
    track.title = "빈 곳을 누르면 정지점 추가 · 손잡이를 끌어 옮기기 · Delete로 지우기";
    const edit = element("div");
    edit.className = "uniform-ramp-edit";
    const picker = element("input");
    picker.type = "color";
    picker.setAttribute("aria-label", `${item.name} 정지점 색`);
    const position = rampNumber(`${item.name} 정지점 위치(0~1)`, 0, 1, 0.01),
      alpha = rampNumber(`${item.name} 정지점 알파(0~1)`, 0, 1, 0.01);
    const positionLabel = element("label"),
      alphaLabel = element("label");
    positionLabel.className = alphaLabel.className = "uniform-axis-label";
    positionLabel.textContent = "t";
    positionLabel.title = "위치";
    alphaLabel.textContent = "A";
    alphaLabel.title = "알파";
    const remove = rampButton("삭제", `${item.name} 선택한 정지점 삭제`, () => removeStop());
    const reverse = rampButton("뒤집기", `${item.name} 그라데이션 좌우 뒤집기`, () => {
      for (const stop of stops) stop.t = 1 - stop.t;
      apply(reverse);
    });
    const info = element("code");
    info.className = "uniform-dir-value";
    edit.append(picker, positionLabel, position, alphaLabel, alpha, remove, reverse);
    wrap.append(bar, track, edit, info);
    const apply = field => {
      stops.sort((a, b) => a.t - b.t);
      commit(
        field,
        stops.flatMap(stop => [stop.t, ...stop.c])
      );
      sync(false);
    };
    const removeStop = () => {
      if (stops.length <= 2 || !selected) return;
      const index = stops.indexOf(selected);
      stops.splice(index, 1);
      selected = stops[Math.min(index, stops.length - 1)];
      apply(remove);
      handles.get(selected)?.focus?.();
    };
    const handles = new Map();
    const draw = () => {
      const ctx = bar.getContext?.("2d");
      if (typeof ctx?.fillRect !== "function") return;
      const width = Math.round((bar.clientWidth || 240) * bar.ratio),
        height = Math.round(22 * bar.ratio);
      if (bar.width !== width) bar.width = width;
      if (bar.height !== height) bar.height = height;
      // 알파를 보이게 체크무늬를 먼저 깐다.
      const cell = 6 * bar.ratio;
      for (let y = 0; y < height; y += cell)
        for (let x = 0; x < width; x += cell) {
          ctx.fillStyle = (x / cell + y / cell) % 2 ? "#9a9da4" : "#d4d6da";
          ctx.fillRect(x, y, cell, cell);
        }
      const samples = renderer.sampleRamp(item.options, current(), width);
      samples.forEach((c, x) => {
        ctx.fillStyle = `rgba(${c
          .slice(0, 3)
          .map(v => Math.round(clamp01(v) * 255))
          .join(",")},${clamp01(c[3])})`;
        ctx.fillRect(x, 0, 1, height);
      });
    };
    const sync = (reread = true) => {
      if (reread) {
        const index = Math.max(0, stops.indexOf(selected));
        stops = read();
        selected = stops[Math.min(index, stops.length - 1)];
      }
      // 손잡이: 정지점 수가 바뀌었을 때만 다시 만들어 끄는 중인 손잡이(포인터 캡처)를 지킨다.
      if (handles.size !== stops.length || stops.some(stop => !handles.has(stop))) {
        handles.clear();
        track.replaceChildren(
          ...stops.map(stop => {
            const handle = element("button");
            handle.type = "button";
            handle.className = "uniform-ramp-stop";
            handles.set(stop, handle);
            padDrag(handle, event => {
              selected = stop;
              const box = track.getBoundingClientRect();
              stop.t = Number(clamp01((event.clientX - box.left) / box.width).toFixed(3));
              apply(handle);
            });
            handle.addEventListener("keydown", event => {
              const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 };
              selected = stop;
              if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                return removeStop();
              }
              if (!(event.key in moves)) return;
              event.preventDefault();
              stop.t = Number(clamp01(stop.t + moves[event.key] * (event.shiftKey ? 0.1 : 0.01)).toFixed(3));
              apply(handle);
            });
            handle.addEventListener("focus", () => {
              if (selected !== stop) {
                selected = stop;
                sync(false);
              }
            });
            return handle;
          })
        );
      }
      stops.forEach((stop, index) => {
        const handle = handles.get(stop);
        handle.style.left = `${stop.t * 100}%`;
        handle.style.setProperty("--stop-color", toHex(stop.c));
        handle.setAttribute(
          "aria-label",
          `${item.name} 정지점 ${index + 1} · 위치 ${stop.t.toFixed(2)} · ${toHex(stop.c)}`
        );
        handle.setAttribute("aria-pressed", String(stop === selected));
        handle.classList.toggle("is-active", stop === selected);
      });
      picker.value = toHex(selected.c);
      showNumber(position, Number(selected.t.toFixed(3)));
      showNumber(alpha, Number(selected.c[3].toFixed(3)));
      remove.disabled = stops.length <= 2;
      info.textContent = `${{ linear: "선형", smooth: "부드럽게", step: "계단" }[mode]} · 정지점 ${stops.length}개`;
      draw();
    };
    // 빈 곳을 누르면 그 위치의 지금 색으로 정지점을 더한다.
    track.addEventListener("pointerdown", event => {
      if (event.target !== track || event.button !== 0 || stops.length >= RAMP_LIMIT) return;
      const box = track.getBoundingClientRect(),
        t = Number(clamp01((event.clientX - box.left) / box.width).toFixed(3)),
        samples = renderer.sampleRamp(item.options, current(), 256);
      selected = { t, c: samples[Math.round(t * 255)].map(v => Number(v.toFixed(4))) };
      stops.push(selected);
      apply(track);
      handles.get(selected)?.focus?.();
    });
    picker.addEventListener("input", () => {
      const rgb = picker.value.match(/[0-9a-f]{2}/gi).map(h => parseInt(h, 16) / 255);
      selected.c = [...rgb, selected.c[3]];
      apply(picker);
    });
    position.addEventListener("change", () => {
      const t = Number(position.value);
      if (position.value.trim() && Number.isFinite(t)) selected.t = clamp01(t);
      apply(position);
    });
    alpha.addEventListener("change", () => {
      const a = Number(alpha.value);
      if (alpha.value.trim() && Number.isFinite(a)) selected.c[3] = clamp01(a);
      apply(alpha);
    });
    directionRedraws.push(draw);
    stops = read();
    selected = stops[0];
    sync(false);
    return wrap;
  };
  // 곡선: 캔버스에서 점을 끌어 모양을 만든다. 빈 곳을 누르면 점 추가, 점을 더블클릭하면 삭제.
  // x는 이웃 점 사이로만 움직여 순서가 바뀌지 않는다. y는 @range(없으면 0~1) 안.
  const curveControl = (item, commit, current) => {
    const low = Number.isFinite(item.options.min) ? item.options.min : 0,
      high = Number.isFinite(item.options.max) ? item.options.max : 1,
      span = high - low,
      ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1)),
      HEIGHT = 128,
      INSET = 8;
    let points = [],
      selected = 0;
    const read = () => {
      const value = current(),
        next = [];
      for (let i = 0; i < value.length; i += 2) next.push({ x: value[i], y: value[i + 1] });
      return next;
    };
    const wrap = element("div");
    wrap.className = "uniform-ramp is-curve";
    const pad = element("canvas");
    pad.className = "uniform-curve-pad";
    pad.tabIndex = 0;
    pad.setAttribute("role", "application");
    pad.setAttribute(
      "aria-label",
      `${item.name} 곡선 · 끌어서 점 옮기기 · 빈 곳 클릭으로 점 추가 · 더블클릭·Delete로 삭제 · [ ] 키로 점 고르기 · 화살표로 이동`
    );
    pad.title = "점을 끌어 모양 만들기 · 빈 곳 클릭: 점 추가 · 더블클릭: 삭제";
    const edit = element("div");
    edit.className = "uniform-ramp-edit";
    const xLabel = element("label"),
      yLabel = element("label");
    xLabel.className = yLabel.className = "uniform-axis-label";
    xLabel.textContent = "X";
    yLabel.textContent = "Y";
    const xField = rampNumber(`${item.name} 선택한 점 X(0~1)`, 0, 1, 0.01),
      yField = rampNumber(`${item.name} 선택한 점 Y`, low, high, "any");
    const remove = rampButton("삭제", `${item.name} 선택한 점 삭제`, () => removePoint(remove));
    const presets = [
      ["직선", () => [low, high].map((y, i) => ({ x: i, y }))],
      [
        "S자",
        () =>
          [
            [0, 0],
            [0.3, 0.1],
            [0.7, 0.9],
            [1, 1],
          ].map(([x, y]) => ({ x, y: low + y * span })),
      ],
      ["뒤집기", () => points.map(p => ({ x: p.x, y: high + low - p.y }))],
    ].map(([text, make]) =>
      rampButton(text, `${item.name} 곡선 ${text}`, event => {
        points = make();
        selected = Math.min(selected, points.length - 1);
        apply(event.currentTarget || pad);
      })
    );
    const info = element("code");
    info.className = "uniform-dir-value";
    edit.append(xLabel, xField, yLabel, yField, remove, ...presets);
    wrap.append(pad, edit, info);
    const decimals = Math.min(6, Math.max(2, Math.ceil(-Math.log10(span / 1000))));
    const apply = field => {
      commit(
        field,
        points.flatMap(p => [p.x, p.y])
      );
      sync(false);
    };
    // 이웃 사이로 x를 제한(간격 0.002)하고 y는 범위 안으로.
    const place = (index, x, y) => {
      const lowX = index ? points[index - 1].x + 0.002 : 0,
        highX = index < points.length - 1 ? points[index + 1].x - 0.002 : 1;
      points[index] = {
        x: Number(Math.min(highX, Math.max(lowX, x)).toFixed(3)),
        y: Number(Math.min(high, Math.max(low, y)).toFixed(decimals)),
      };
    };
    const removePoint = field => {
      if (points.length <= 2) return;
      points.splice(selected, 1);
      selected = Math.min(selected, points.length - 1);
      apply(field);
    };
    const geometry = () => {
      const width = Math.round((pad.clientWidth || 240) * ratio),
        height = Math.round(HEIGHT * ratio),
        inset = INSET * ratio;
      return {
        width,
        height,
        inset,
        toX: x => inset + x * (width - inset * 2),
        toY: y => height - inset - ((y - low) / span) * (height - inset * 2),
      };
    };
    const draw = () => {
      const ctx = pad.getContext?.("2d");
      if (typeof ctx?.arc !== "function") return;
      const { width, height, inset, toX, toY } = geometry(),
        { sunken, accent, line } = padColors(pad);
      if (pad.width !== width) pad.width = width;
      if (pad.height !== height) pad.height = height;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = `rgb(${sunken.join(",")})`;
      ctx.fillRect(inset, inset, width - inset * 2, height - inset * 2);
      ctx.strokeStyle = line;
      ctx.lineWidth = ratio;
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      for (let k = 1; k < 4; k++) {
        const gx = inset + ((width - inset * 2) * k) / 4,
          gy = inset + ((height - inset * 2) * k) / 4;
        ctx.moveTo(gx, inset);
        ctx.lineTo(gx, height - inset);
        ctx.moveTo(inset, gy);
        ctx.lineTo(width - inset, gy);
      }
      ctx.stroke();
      ctx.globalAlpha = 0.45;
      ctx.strokeRect(inset, inset, width - inset * 2, height - inset * 2);
      if (low < 0 && high > 0) {
        ctx.beginPath();
        ctx.moveTo(inset, toY(0));
        ctx.lineTo(width - inset, toY(0));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const samples = renderer.sampleRamp(item.options, current(), Math.max(2, width - inset * 2));
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2 * ratio;
      ctx.beginPath();
      samples.forEach((y, i) => {
        const px = inset + i,
          py = toY(Math.min(high, Math.max(low, y)));
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      });
      ctx.stroke();
      points.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(toX(p.x), toY(p.y), (i === selected ? 5 : 4) * ratio, 0, Math.PI * 2);
        ctx.fillStyle = i === selected ? accent : `rgb(${sunken.join(",")})`;
        ctx.fill();
        ctx.lineWidth = 1.5 * ratio;
        ctx.stroke();
      });
    };
    const sync = (reread = true) => {
      if (reread) {
        points = read();
        selected = Math.min(selected, points.length - 1);
      }
      const p = points[selected];
      showNumber(xField, p.x);
      showNumber(yField, p.y);
      remove.disabled = points.length <= 2;
      info.textContent = `${item.options.curve === "linear" ? "직선 잇기" : "부드럽게"} · 점 ${points.length}개 · ${
        selected + 1
      }번 (${p.x}, ${p.y})`;
      draw();
    };
    // 포인터: 가까운 점(10px 안)을 잡거나, 빈 곳이면 점을 더해 바로 끈다.
    const pointerToValue = event => {
      const box = pad.getBoundingClientRect(),
        scale = box.width / (pad.clientWidth || box.width || 1),
        inset = INSET * scale;
      return {
        x: (event.clientX - box.left - inset) / (box.width - inset * 2),
        y: low + (1 - (event.clientY - box.top - inset) / (box.height - inset * 2)) * span,
        box,
      };
    };
    pad.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      pad.dataset.pointer = "";
      pad.focus({ preventScroll: true });
      const { x, y, box } = pointerToValue(event),
        hit = points
          .map((p, i) => ({
            i,
            d: Math.hypot((p.x - x) * (box.width - INSET * 2), ((p.y - y) / span) * (box.height - INSET * 2)),
          }))
          .sort((a, b) => a.d - b.d)[0];
      if (hit && hit.d <= 10) selected = hit.i;
      else if (points.length < RAMP_LIMIT) {
        const at = points.findIndex(p => p.x > x);
        selected = at < 0 ? points.length : at;
        points.splice(selected, 0, { x, y });
        place(selected, x, y);
        apply(pad);
      } else return;
      sync(false);
      pad.setPointerCapture?.(event.pointerId);
      pad.classList.add("is-dragging");
      const move = moveEvent => {
        const next = pointerToValue(moveEvent);
        place(selected, next.x, next.y);
        apply(pad);
      };
      const end = () => {
        pad.removeEventListener("pointermove", move);
        pad.classList.remove("is-dragging");
      };
      pad.addEventListener("pointermove", move);
      pad.addEventListener("pointerup", end, { once: true });
      pad.addEventListener("pointercancel", end, { once: true });
    });
    pad.addEventListener("dblclick", event => {
      const { x, y, box } = pointerToValue(event),
        index = points.findIndex(
          p => Math.hypot((p.x - x) * (box.width - INSET * 2), ((p.y - y) / span) * (box.height - INSET * 2)) <= 10
        );
      if (index < 0) return;
      selected = index;
      removePoint(pad);
    });
    pad.addEventListener("keydown", event => {
      delete pad.dataset.pointer;
      const big = event.shiftKey ? 10 : 1,
        p = points[selected];
      if (event.key === "[" || event.key === "]") {
        selected = Math.min(points.length - 1, Math.max(0, selected + (event.key === "]" ? 1 : -1)));
        event.preventDefault();
        return sync(false);
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        return removePoint(pad);
      }
      const moves = {
        ArrowLeft: [-0.01 * big, 0],
        ArrowRight: [0.01 * big, 0],
        ArrowDown: [0, (-span / 100) * big],
        ArrowUp: [0, (span / 100) * big],
      }[event.key];
      if (!moves) return;
      event.preventDefault();
      place(selected, p.x + moves[0], p.y + moves[1]);
      apply(pad);
    });
    xField.addEventListener("change", () => {
      const x = Number(xField.value);
      if (xField.value.trim() && Number.isFinite(x)) place(selected, x, points[selected].y);
      apply(xField);
    });
    yField.addEventListener("change", () => {
      const y = Number(yField.value);
      if (yField.value.trim() && Number.isFinite(y)) place(selected, points[selected].x, y);
      apply(yField);
    });
    directionRedraws.push(draw);
    curveRedraws.set(pad, draw);
    curveResizeObserver?.observe(pad);
    sync();
    return wrap;
  };
  listen(document, "theme-changed", () => directionRedraws.forEach(draw => draw()));
  const validNumber = (kind, value) =>
    Number.isFinite(value) &&
    (kind === "f" || kind === "m" || (Number.isInteger(value) && (kind !== "u" || value >= 0)));
  // 입력 중 숫자가 아닌 값이나 잘못된 차원의 벡터가 넘어가지 않도록 경계에서 검증한다.
  const parseValue = (type, text) => {
    const raw = text.trim(),
      { components: size, kind } = typeInfo(type);
    if (!raw) throw new Error("Uniform 값을 입력해야 합니다.");
    if (size > 1) {
      if (/(^,|,$|,\s*,)/.test(raw)) throw new Error("벡터의 각 성분에 숫자를 입력하세요.");
      const parts = raw.split(/[\s,]+/);
      if (kind === "b") {
        if (parts.length !== size) throw new Error(`${type}에는 true/false 값 ${size}개가 필요합니다.`);
        return parts.map(part => parseBool(part, type));
      }
      const result = parts.map(Number);
      if (result.length !== size || !result.every(value => validNumber(kind, value)))
        throw new Error(
          `${type}에는 ${kind === "f" || kind === "m" ? "숫자" : kind === "u" ? "0 이상 정수" : "정수"} ${size}개가 필요합니다.`
        );
      return result;
    }
    if (kind === "b") return parseBool(raw, type);
    const result = Number(raw);
    if (!validNumber(kind, result)) throw new Error(`${type}에 맞는 숫자를 입력하세요.`);
    return result;
  };
  // 기본 입력값: 행렬은 단위 행렬, 그 외는 0(bool은 true).
  const defaultValue = type => {
    const { components: size, kind } = typeInfo(type),
      dim = Math.round(Math.sqrt(size));
    if (kind === "m") return Array.from({ length: size }, (_, i) => (i % (dim + 1) === 0 ? 1 : 0)).join(", ");
    if (kind === "b") return size > 1 ? Array(size).fill("false").join(", ") : "true";
    return size > 1 ? Array(size).fill(0).join(", ") : kind === "f" ? "0.5" : "0";
  };
  let deletedUniform = null;
  const clearDeleted = () => {
    deletedUniform = null;
    $("undoUniform").hidden = true;
    $("uniformNotice").textContent = "";
  };
  let uniformSnapshot = "";
  // 목록을 다시 그릴지 가늠하는 요약. 연결된 파라미터의 값은 프레임마다 바뀌므로 빼고(미터 · 내비게이터가 따로 따라간다)
  // 나머지(이름 · 타입 · 설정 · 연결 없는 값)만 본다 — 그러지 않으면 0.5초마다 목록 전체를 다시 그려 누르기 · 끌기가 끊긴다.
  const snapshotOf = items => {
    const linked = new Set((settings.getLinks?.() || []).map(link => link.name));
    return JSON.stringify(items.map(item => (linked.has(item.name) ? { ...item, value: null } : item)));
  };
  // 셰이더 주석(@default·@range…)에서 읽은 파라미터 기본값. 코드에 어노테이션이 없는 파라미터는 되돌릴 값이 없다.
  const annotatedDefaults = () => {
    const project = window.shaderStudio?.getProject?.();
    if (!project) return new Map();
    const specs = Annotations.collect([project.image, ...(project.passes || []).map(p => p.fragment)]);
    return new Map(specs.filter(spec => !spec.error).map(spec => [spec.name, spec]));
  };
  const sameValue = (a, b) =>
    Array.isArray(a)
      ? Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
      : typeof a === "number" && typeof b === "number"
        ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))
        : a === b;
  const formatDefault = value =>
    (Array.isArray(value) ? value : [value]).map(v => (typeof v === "number" ? +v.toFixed(4) : String(v))).join(", ");
  // @anim 재생: 범위를 코사인으로 왕복(@angle이면 한 바퀴씩 계속 돈다). 지금 값에서 위쪽으로 출발한다.
  // int/uint는 한 칸씩 일정한 속도로 왕복(끝에 오래 머물지 않게 삼각파), @enum은 선택지마다 주기만큼 머물며 다음으로 넘어간다.
  // 값은 렌더러에 바로 쓰고, 화면은 행이 등록한 refresh로 맞춘다. 사용자가 값을 직접 바꾸면 그 파라미터는 멈춘다.
  const playing = new Map(),
    playViews = new Map(),
    playButtons = new Map(),
    // 행의 ↺(기본값으로 되돌리기) 버튼 상태 갱신. 재생은 commit을 거치지 않으므로 여기로 직접 알린다.
    resetSyncs = new Map();
  let playFrame = 0;
  const playStep = now => {
    playFrame = 0;
    const items = renderer.getUserUniforms();
    for (const [name, play] of playing) {
      const item = items.find(u => u.name === name),
        opts = item?.options || {};
      if (!item || !opts.anim || !["float", "int", "uint"].includes(item.type)) {
        playing.delete(name);
        continue;
      }
      play.origin ??= now;
      const turns = (now - play.origin) / 1000 / opts.anim,
        integer = item.type !== "float";
      let value;
      if (opts.angle) value = play.start + turns * 2 * Math.PI;
      else if (opts.enum) value = (play.start + Math.floor(turns)) % opts.enum.length;
      else if (integer) {
        // 삼각파: 주기 동안 min → max → min. 출발 위치는 지금 값.
        const u = turns + play.phase,
          wave = 1 - Math.abs(1 - 2 * (u - Math.floor(u)));
        value = opts.min + Math.round(wave * (opts.max - opts.min));
      } else {
        value = opts.min + (opts.max - opts.min) * (0.5 - 0.5 * Math.cos(turns * 2 * Math.PI + play.phase));
        // @step은 이 파라미터가 가질 수 있는 값의 간격이다. 재생도 슬라이더처럼 step 단위로 맞춰
        // 패널에 보이는 값과 셰이더에 들어가는 값이 같게 한다(부드럽게 움직이려면 step을 잘게 둔다).
        if (opts.step > 0) {
          const decimals = Math.min(10, Math.max(0, Math.ceil(-Math.log10(opts.step)) + 1));
          value = Number(
            Math.min(opts.max, opts.min + Math.round((value - opts.min) / opts.step) * opts.step).toFixed(decimals)
          );
        }
      }
      // 값이 칸(step·정수)을 넘어가지 않았으면 다시 쓰지 않는다.
      if (!opts.angle && value === item.value) continue;
      try {
        renderer.setUniform(name, value);
      } catch {
        playing.delete(name);
        continue;
      }
      playViews.get(name)?.(value);
      resetSyncs.get(name)?.(value);
    }
    // 재생으로 바뀐 값 때문에 목록을 다시 그리지 않게 기준을 맞춘다.
    uniformSnapshot = snapshotOf(renderer.getUserUniforms());
    if (playing.size) playFrame = requestAnimationFrame(playStep);
    else syncPlayButtons();
  };
  const syncPlayButtons = () => {
    for (const [name, button] of playButtons) {
      const on = playing.has(name);
      button.classList.toggle("icon-play", !on);
      button.classList.toggle("icon-pause", on);
      button.setAttribute("aria-pressed", String(on));
    }
  };
  const togglePlay = item => {
    const current = renderer.getUserUniforms().find(u => u.name === item.name);
    if (!current) return;
    if (playing.has(item.name)) playing.delete(item.name);
    else {
      const { min, max } = current.options,
        ratio = current.options.angle ? 0 : Math.min(1, Math.max(0, (current.value - min) / (max - min))),
        // 삼각파(정수)는 위상 ratio/2에서 값이 ratio, 코사인(실수)은 acos로 맞춘다.
        phase = current.type === "float" ? Math.acos(1 - 2 * ratio) : ratio / 2;
      playing.set(item.name, { start: current.value, phase, origin: null });
      if (!playFrame) playFrame = requestAnimationFrame(playStep);
    }
  };
  signal.addEventListener("abort", () => {
    if (playFrame) cancelAnimationFrame(playFrame);
    playing.clear();
  });
  // @seed: 범위가 있으면 그 안(step 단위, 로그 눈금이면 배율로), 없으면 int/uint 0~99999 · float 0~1000.
  const randomValue = item => {
    const { kind } = typeInfo(item.type),
      opts = item.options || {},
      ranged = Number.isFinite(opts.min) && Number.isFinite(opts.max),
      r = Math.random();
    if (kind === "i" || kind === "u")
      return ranged ? Math.min(opts.max, opts.min + Math.floor(r * (opts.max - opts.min + 1))) : Math.floor(r * 100000);
    if (!ranged) return Number((r * 1000).toFixed(3));
    if (opts.log) return Number((opts.min * Math.pow(opts.max / opts.min, r)).toPrecision(4));
    const decimals = Math.min(10, Math.max(0, -Math.floor(Math.log10(opts.step)) + 1));
    return Number(
      Math.min(opts.max, opts.min + Math.round((r * (opts.max - opts.min)) / opts.step) * opts.step).toFixed(decimals)
    );
  };
  // @group 접힘 상태(이 화면에서만 기억).
  const collapsedGroups = new Set();
  // ---- 파라미터 프리셋(presets.js · settings.getPresets/setPresets) ----
  // 칩을 누르면 그 값 묶음으로 바꾼다(전환 시간만큼 부드럽게). 지금 값이 프리셋과 같으면 그 칩이 눌린 상태로 보인다.
  // 고치는 일(지금 값으로 덮어쓰기 · 이름 바꾸기 · 삭제)은 칩 옆 ⋯ 메뉴 안에만 둔다 — 칩을 누르려다 잘못 누르지 않게.
  // 덮어쓰기는 무엇이 바뀌는지 보여 주고 한 번 더 묻는다. 덮어쓰기 · 삭제는 안내 줄의 되돌리기 · Ctrl+Z로 되돌린다.
  let morph = 0,
    presetRestore = null, // 되돌리기: 바로 전 프리셋 목록
    presetMenu = null; // 열린 ⋯ 메뉴 { node, button }
  // undo: 되돌릴 때 다시 쓸 프리셋 목록(없으면 되돌리기 버튼을 숨긴다)
  const presetNotice = (text, undo = null) => {
    $("presetNoticeText").textContent = text;
    presetRestore = undo;
    $("presetUndo").hidden = !undo;
  };
  const closePresetMenu = (focusButton = false) => {
    if (!presetMenu) return;
    const { node, button } = presetMenu;
    presetMenu = null;
    node.remove();
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  };
  listen(document, "pointerdown", event => {
    if (presetMenu && !presetMenu.node.contains(event.target) && event.target !== presetMenu.button) closePresetMenu();
  });
  // 덮어쓰면 바뀌는 파라미터: [이름, 프리셋 값, 지금 값]
  const presetChanges = (preset, users) =>
    users
      .filter(item => !Object.hasOwn(preset.values, item.name) || !sameValue(item.value, preset.values[item.name]))
      .map(item => [item.name, preset.values[item.name], item.value]);
  const formatPresetValue = value =>
    value === undefined
      ? "(없음)"
      : Array.isArray(value)
        ? value.length > 4
          ? `[${value.length}개]`
          : `(${value.map(v => (typeof v === "number" ? displayNumber(Number(v.toFixed(4))) : String(v))).join(", ")})`
        : typeof value === "number"
          ? displayNumber(Number(value.toFixed(4)))
          : String(value);
  const overwritePreset = async index => {
    stopMorph();
    const presets = settings.getPresets(),
      preset = presets[index],
      users = renderer.getUserUniforms(),
      changes = presetChanges(preset, users);
    if (!preset || !changes.length) return;
    const ask = window.shaderStudio?.ask,
      lines = changes
        .slice(0, 6)
        .map(([name, from, to]) => `${name}: ${formatPresetValue(from)} → ${formatPresetValue(to)}`),
      more = changes.length > 6 ? `\n… 외 ${changes.length - 6}개` : "";
    const ok = ask
      ? await ask({
          title: `'${preset.name}' 덮어쓰기`,
          message: `이 프리셋을 지금 파라미터 값으로 바꿉니다. 바뀌는 값 ${changes.length}개:\n${lines.join("\n")}${more}\n\n덮어쓴 뒤에도 '되돌리기'나 Ctrl+Z로 되돌릴 수 있습니다.`,
          ok: "덮어쓰기",
          danger: true,
        })
      : true;
    if (!ok) return;
    attempt(() => {
      settings.setPresets(
        settings.getPresets().map((item, i) => (i === index ? Presets.capture(item.name, users) : item))
      );
      presetNotice(`'${preset.name}'을 지금 값으로 덮어썼습니다(값 ${changes.length}개)`, presets);
      $("presetUndo").focus();
    });
  };
  const renamePreset = async index => {
    stopMorph();
    const presets = settings.getPresets(),
      preset = presets[index],
      others = presets.filter((_, i) => i !== index).map(item => item.name);
    const name = await askName("프리셋 이름 바꾸기", preset.name, others);
    if (!name || name === preset.name) return;
    attempt(() => {
      settings.setPresets(settings.getPresets().map((item, i) => (i === index ? { ...item, name } : item)));
      presetNotice(`'${preset.name}' → '${name}'`, presets);
    });
  };
  const removePreset = index => {
    const presets = settings.getPresets(),
      preset = presets[index];
    attempt(() => {
      settings.setPresets(presets.filter((_, i) => i !== index));
      presetNotice(`'${preset.name}' 삭제됨`, presets);
      $("presetUndo").focus();
    });
  };
  // ⋯ 메뉴: 덮어쓰기(지금 값과 같으면 꺼짐) · 이름 바꾸기 · 삭제. ↑↓로 옮기고 Esc로 닫는다.
  const openPresetMenu = (button, index) => {
    if (presetMenu?.button === button) return closePresetMenu(true);
    closePresetMenu();
    const preset = settings.getPresets()[index],
      same = !presetChanges(preset, renderer.getUserUniforms()).length,
      node = element("div");
    node.className = "preset-menu";
    node.setAttribute("role", "menu");
    node.setAttribute("aria-label", `'${preset.name}' 프리셋 관리`);
    const items = [
      [
        "지금 값으로 덮어쓰기…",
        () => overwritePreset(index),
        same,
        same ? "지금 값과 같습니다" : "바뀌는 값을 확인한 뒤 덮어씁니다",
      ],
      ["이름 바꾸기…", () => renamePreset(index), false, "이름을 두 번 눌러도 바꿀 수 있습니다"],
      ["삭제", () => removePreset(index), false, "삭제한 뒤 되돌릴 수 있습니다"],
    ].map(([text, run, disabled, title]) => {
      const item = element("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.className = text === "삭제" ? "preset-menu-item is-danger" : "preset-menu-item";
      item.textContent = text;
      item.title = title;
      item.disabled = disabled;
      item.addEventListener("click", () => {
        closePresetMenu();
        run();
      });
      return item;
    });
    node.append(...items);
    node.addEventListener("keydown", event => {
      const enabled = items.filter(item => !item.disabled),
        at = enabled.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePresetMenu(true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        enabled[(at + step + enabled.length) % enabled.length]?.focus();
      } else if (event.key === "Tab") closePresetMenu();
    });
    button.after(node);
    // 칩 왼쪽 끝에 맞춰 펼치고, 프리셋 막대 오른쪽을 넘으면 오른쪽 끝에 맞춘다
    const bounds = $("presetBar").getBoundingClientRect();
    if (node.getBoundingClientRect().right > bounds.right) node.classList.add("is-end");
    button.setAttribute("aria-expanded", "true");
    presetMenu = { node, button };
    items.find(item => !item.disabled)?.focus();
  };
  const stopMorph = () => {
    if (morph) cancelAnimationFrame(morph);
    morph = 0;
  };
  const askName = async (title, value, others) => {
    const ask = window.shaderStudio?.ask;
    if (!ask) return value;
    const name = await ask({
      title,
      message: "파라미터 값 전체를 이 이름으로 저장합니다. 같은 프로젝트에 저장되고 프로젝트 파일에도 담깁니다.",
      value,
      label: "프리셋 이름",
      validate: text => {
        const trimmed = text.trim();
        if (!trimmed) return "이름을 적으세요.";
        if (trimmed.length > Presets.MAX_NAME) return `${Presets.MAX_NAME}자 이하로 적으세요.`;
        return others.includes(trimmed) ? "같은 이름의 프리셋이 있습니다." : "";
      },
    });
    return name === null || name === undefined ? null : name.trim();
  };
  const matchesPreset = (preset, users) =>
    users.some(item => Object.hasOwn(preset.values, item.name)) &&
    users.every(item => !Object.hasOwn(preset.values, item.name) || sameValue(item.value, preset.values[item.name]));
  const applyPreset = preset => {
    stopMorph();
    const users = renderer.getUserUniforms(),
      from = Object.fromEntries(users.map(item => [item.name, item.value])),
      names = Object.keys(preset.values),
      used = users.filter(item => names.includes(item.name)).length,
      skipped = names.length - used;
    // 프리셋이 바꾸는 파라미터의 자동 재생(@anim)은 멈춘다(재생이 값을 덮어쓰지 않게).
    let stopped = false;
    for (const item of users) if (names.includes(item.name) && playing.delete(item.name)) stopped = true;
    if (stopped) syncPlayButtons();
    const write = t => {
      for (const [name, value] of Presets.blend(users, from, preset, Presets.ease(t)))
        try {
          renderer.setUniform(name, value);
        } catch (error) {
          console.warn(`프리셋 값 무시 (${name}):`, error.message);
        }
    };
    const finish = () => {
      morph = 0;
      settings.save();
      renderUniforms();
    };
    const seconds = Number($("presetBlend").value) || 0;
    presetNotice(
      `'${preset.name}' · 파라미터 ${used}개${skipped ? ` · 이 프로젝트에 없는 ${skipped}개는 건너뜀` : ""}${seconds ? ` · ${seconds}초 동안 전환` : ""}`
    );
    if (!seconds) {
      write(1);
      return finish();
    }
    const start = performance.now();
    const tick = now => {
      const t = Math.min(1, (now - start) / (seconds * 1000));
      write(t);
      if (t < 1) morph = requestAnimationFrame(tick);
      else finish();
    };
    morph = requestAnimationFrame(tick);
  };
  // force: 프리셋 목록 자체가 바뀌었을 때. 값만 바뀌어 다시 그릴 때(@anim · 외부 변경)는 ⋯ 메뉴가 열려 있으면 그대로 둔다.
  const renderPresets = (force = false) => {
    if (presetMenu && !force) return;
    const list = $("presetList"),
      presets = settings.getPresets?.() || [],
      users = renderer.getUserUniforms();
    closePresetMenu();
    list.replaceChildren();
    $("presetSave").disabled = !users.length || presets.length >= Presets.MAX_PRESETS;
    $("presetSave").title = !users.length
      ? "저장할 파라미터가 없습니다"
      : presets.length >= Presets.MAX_PRESETS
        ? `프리셋은 최대 ${Presets.MAX_PRESETS}개입니다`
        : "지금 파라미터 값 전체를 이름 붙여 저장";
    if (!presets.length) {
      const empty = element("span");
      empty.className = "preset-empty";
      empty.textContent = "저장한 프리셋이 없습니다. 값을 맞춘 뒤 저장하세요.";
      list.append(empty);
      return;
    }
    presets.forEach((preset, index) => {
      const chip = element("div"),
        apply = element("button"),
        more = element("button");
      chip.className = "preset-chip";
      chip.setAttribute("role", "listitem");
      apply.type = more.type = "button";
      apply.className = "preset-apply";
      apply.textContent = preset.name;
      apply.setAttribute("aria-pressed", String(matchesPreset(preset, users)));
      apply.title = `'${preset.name}' 값으로 바꾸기 · 두 번 누르면 이름 바꾸기`;
      apply.addEventListener("click", () => applyPreset(preset));
      apply.addEventListener("dblclick", () => renamePreset(index));
      more.className = "preset-more glyph-icon icon-more";
      more.title = `'${preset.name}' 관리: 덮어쓰기 · 이름 바꾸기 · 삭제`;
      more.setAttribute("aria-label", more.title);
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.addEventListener("click", () => openPresetMenu(more, index));
      chip.append(apply, more);
      list.append(chip);
    });
  };
  listen($("presetSave"), "click", async () => {
    const presets = settings.getPresets(),
      names = presets.map(item => item.name);
    let n = presets.length + 1;
    while (names.includes(`프리셋 ${n}`)) n++;
    const name = await askName("프리셋 저장", `프리셋 ${n}`, names);
    if (!name) return;
    attempt(() => {
      settings.setPresets([...settings.getPresets(), Presets.capture(name, renderer.getUserUniforms())]);
      presetNotice(`'${name}' 저장 · 파라미터 ${renderer.getUserUniforms().length}개`);
    });
  });
  listen($("presetUndo"), "click", () => {
    if (!presetRestore) return;
    const previous = presetRestore;
    attempt(() => {
      settings.setPresets(previous);
      presetNotice("프리셋을 바로 전으로 되돌렸습니다");
    });
  });
  listen(document, "shader-presets-changed", () => renderPresets(true));
  // ---- 파라미터 연결(links.js · renderer.setLinks · settings.getLinks/setLinks) ----
  // 파라미터 줄의 연결 버튼이 아래에 편집 칸을 연다. 바꾸면 settings.setLinks로 저장하고 렌더러가 프레임마다 적용한다.
  let openLink = null; // 연결 시트를 연 파라미터 이름
  const linkOf = name => (settings.getLinks?.() || []).find(link => link.name === name) || null;
  const saveLink = (name, next) =>
    attempt(() => {
      const others = (settings.getLinks?.() || []).filter(link => link.name !== name);
      settings.setLinks(next ? [...others, { ...next, name }] : others); // → shader-links-changed가 다시 그린다
      renderer.redraw?.();
    });
  // 끄는 동안: 렌더러에만 적용(저장 · 다시 그리기 없음). 놓으면(change) saveLink.
  const previewLink = (name, next) =>
    attempt(() => {
      const others = (settings.getLinks?.() || []).filter(link => link.name !== name);
      renderer.setLinks([...others, { ...next, name }]);
      renderer.redraw?.();
    });
  // 연결 미터 · 시트의 실시간 표시: 파라미터 탭이 보이는 동안 매 프레임 지금 값으로 고친다.
  const liveLinks = new Map(); // 이름 → [update(value)…]
  let liveFrame = 0;
  const liveStep = () => {
    liveFrame = 0;
    if (!liveLinks.size) return;
    // 다른 탭이 보이는 동안은 그리지 않고 기다린다
    if ($("view-uniforms").hidden || document.hidden) {
      liveFrame = requestAnimationFrame(liveStep);
      return;
    }
    const values = new Map(renderer.getUserUniforms().map(item => [item.name, item.value]));
    for (const [name, updates] of liveLinks) for (const update of updates) update(values.get(name));
    liveFrame = requestAnimationFrame(liveStep);
  };
  const watchLink = (name, update) => {
    if (!liveLinks.has(name)) liveLinks.set(name, []);
    liveLinks.get(name).push(update);
    if (!liveFrame) liveFrame = requestAnimationFrame(liveStep);
  };
  const openTimeline = name => timeline.open(name);
  // ---- 키프레임 정밀 입력: 키프레임 연결 줄의 내비게이터(◀ ◆ ▶ · 재생 위치) · 자동 키 ----
  // 키프레임 연결 줄에서 값을 바꾸면 재생선 위치에 키를 찍는다(그 시간에 키가 있으면 값만 바꾼다).
  // 끄는 동안은 렌더러에만 적용하고, 놓거나(change · pointerup · keyup) 잠시 멈추면 저장한다 — 끌기가 끊기지 않게.
  const KEY_EPSILON = 5e-4;
  const playTime = () => Number((renderer.getStats().time ?? 0).toFixed(3));
  // 반복(loop)이 있으면 키의 시간은 한 바퀴 안의 시간이다: 재생 위치 t → { local: 바퀴 안 시간, base: 이 바퀴의 시작 }
  const loopTime = (link, t = playTime()) => {
    const loop = link?.loop > 0 ? link.loop : 0,
      local = loop ? Number((((t % loop) + loop) % loop).toFixed(3)) : t;
    return { local, base: t - local };
  };
  const pendingKeys = new Map();
  let keyTimer = 0,
    keyPointer = false;
  const flushKeys = () => {
    clearTimeout(keyTimer);
    keyTimer = 0;
    if (keyPointer || !pendingKeys.size) return;
    const list = [...pendingKeys.values()];
    pendingKeys.clear();
    attempt(() =>
      settings.setLinks(
        list.reduce((all, next) => all.map(l => (l.name === next.name ? next : l)), settings.getLinks())
      )
    );
  };
  const recordKey = (name, value) => {
    const link = linkOf(name),
      v = typeof value === "boolean" ? (value ? 1 : 0) : value;
    if (link?.source !== "keys" || typeof v !== "number") return;
    const t = loopTime(link).local,
      keys = [...link.keys.filter(([k]) => Math.abs(k - t) >= KEY_EPSILON), [t, v]].sort((a, b) => a[0] - b[0]),
      next = { ...link, keys };
    pendingKeys.set(name, next);
    previewLink(name, next);
    clearTimeout(keyTimer);
    keyTimer = setTimeout(flushKeys, 700);
  };
  listen(document, "pointerup", () => {
    keyPointer = false;
    if (pendingKeys.size) setTimeout(flushKeys);
  });
  const keyNav = (item, link) => {
    const nav = element("div"),
      prev = element("button"),
      key = element("button"),
      next = element("button"),
      time = element("input"),
      hint = element("span");
    nav.className = "key-nav";
    for (const [button, label, text] of [
      [prev, "이전 키로", "◀"],
      [key, "이 시간에 키", "◆"],
      [next, "다음 키로", "▶"],
    ]) {
      button.type = "button";
      button.className = "key-nav-button";
      button.textContent = text;
      button.setAttribute("aria-label", `${item.name} ${label}`);
    }
    key.classList.add("key-nav-key");
    prev.title = "이전 키로 재생선 옮기기";
    next.title = "다음 키로 재생선 옮기기";
    time.type = "number";
    time.className = "key-nav-time";
    time.min = "0";
    time.step = "0.01";
    time.setAttribute("aria-label", "재생 위치(초)");
    time.placeholder = "초";
    time.title = "재생 위치(uTime) — 숫자로 옮긴 뒤 값을 바꾸면 이 시간에 키가 찍힙니다";
    hint.className = "key-nav-hint";
    hint.textContent = "값을 바꾸면 이 시간에 키";
    const current = () => linkOf(item.name) || link,
      keys = () => current().keys;
    const at = t => keys().findIndex(([k]) => Math.abs(k - t) < KEY_EPSILON);
    // ◀ ▶는 이 바퀴 안에서 움직인다(반복이 있으면 바퀴 시작 + 키 시간)
    prev.addEventListener("click", () => {
      const { local, base } = loopTime(current()),
        before = keys().filter(([k]) => k < local - KEY_EPSILON);
      if (before.length) attempt(() => renderer.setTime(Number((base + before.at(-1)[0]).toFixed(3))));
    });
    next.addEventListener("click", () => {
      const { local, base } = loopTime(current()),
        after = keys().find(([k]) => k > local + KEY_EPSILON);
      if (after) attempt(() => renderer.setTime(Number((base + after[0]).toFixed(3))));
    });
    key.addEventListener("click", () => {
      const t = loopTime(current()).local,
        index = at(t),
        live = renderer.getUserUniforms().find(u => u.name === item.name)?.value,
        value = typeof live === "boolean" ? (live ? 1 : 0) : live;
      const list =
        index >= 0 ? keys().filter((_, i) => i !== index) : [...keys(), [t, value]].sort((a, b) => a[0] - b[0]);
      saveLink(item.name, { ...linkOf(item.name), keys: list });
    });
    time.addEventListener("change", () => {
      const v = Number(time.value);
      if (time.value.trim() && Number.isFinite(v) && v >= 0) attempt(() => renderer.setTime(v));
    });
    time.addEventListener("keydown", event => {
      if (event.key === "Enter") time.dispatchEvent(new Event("change"));
    });
    // 시간 기준 표시: '한 번'(키 시간 = 재생 시간) · '↻ N초'(재생 시간을 N초로 잘라 되풀이). 반복이면 바퀴 안 시간을 따로 보인다.
    const mode = element("span"),
      inner = element("span");
    mode.className = "key-nav-mode";
    inner.className = "key-nav-local";
    // 한 줄: [한 번 | ↻ N초] ◀ ◆ ▶ [재생 위치] 초 — 둘째 줄(설명): (바퀴 안 X초 ·) 값을 바꾸면 … 키
    const caption = element("div");
    caption.className = "key-nav-caption";
    caption.append(mode, inner, hint);
    const timeLabel = element("label");
    timeLabel.className = "key-nav-time-label";
    timeLabel.textContent = "재생";
    timeLabel.title = "재생 위치(uTime, 초)";
    timeLabel.append(time);
    // 첫 줄: ◀ ◆ ▶ · 재생 [초] — 둘째 줄: [한 번 | ↻ N초] (바퀴 안 X초) · 값을 바꾸면 … 키
    nav.append(prev, key, next, timeLabel, caption);
    let shownLoop = null;
    const update = () => {
      const now = renderer.getStats().time ?? 0,
        t = loopTime(current(), Number(now.toFixed(3))).local,
        here = at(t) >= 0,
        list = keys();
      key.setAttribute("aria-pressed", String(here));
      key.title = here ? "이 시간의 키 지우기" : "이 시간에 지금 값으로 키 찍기";
      prev.disabled = !list.some(([k]) => k < t - KEY_EPSILON);
      next.disabled = !list.some(([k]) => k > t + KEY_EPSILON);
      // 재생 중에는 자릿수를 고정(소수 둘째)해 글자 폭이 흔들리지 않게, 멈췄을 때는 정확한 값(셋째)까지
      const running = renderer.getStats().running;
      if (document.activeElement !== time) time.value = running ? now.toFixed(2) : String(Number(now.toFixed(3)));
      const loop = current().loop > 0 ? current().loop : 0;
      if (loop !== shownLoop) {
        // 글자는 반복 설정이 바뀔 때만 고친다(매 프레임 바뀌는 글자 없음)
        shownLoop = loop;
        mode.textContent = loop ? `↻ ${Number(loop.toFixed(2))}초` : "한 번";
        mode.title = loop
          ? `재생 시간을 ${Number(loop.toFixed(2))}초 길이로 잘라 키를 되풀이합니다 — 키의 시간은 바퀴 안의 시간`
          : "키의 시간 = 재생 시간(uTime). 마지막 키 뒤로는 그 값을 유지합니다";
        mode.classList.toggle("is-loop", !!loop);
        inner.hidden = !loop;
        hint.textContent = loop ? "· 값을 바꾸면 여기에 키" : "값을 바꾸면 이 시간에 키(자동 키)";
        hint.title = loop
          ? "슬라이더 · 숫자로 값을 바꾸면 이 바퀴 안 시간에 키가 찍힙니다(이미 있으면 값만)"
          : "슬라이더 · 숫자로 값을 바꾸면 지금 재생 시간에 키가 찍힙니다(이미 있으면 값만)";
      }
      if (loop) inner.textContent = `바퀴 안 ${t.toFixed(2)}초`;
    };
    update();
    return { node: nav, update };
  };
  const linkEditor = item => {
    const view = LinkSheet.sheet({
      item,
      link: linkOf(item.name),
      renderer,
      save: next => saveLink(item.name, next),
      preview: next => previewLink(item.name, next),
      openTimeline,
    });
    watchLink(item.name, view.update);
    return view.node;
  };
  // 다시 그려도 편집 칸 안의 초점은 같은 자리(같은 파라미터의 n번째 조작)로 돌려 둔다.
  listen(document, "shader-links-changed", () => {
    const active = document.activeElement,
      // 연결 시트 안이면 시트 기준, 아니면 파라미터 줄(◆ · 슬라이더 …) 기준으로 같은 자리를 찾는다
      box = active instanceof Element ? active.closest(".link-editor, .uniform-row") : null,
      selector = box?.classList.contains("link-editor") ? ".link-editor" : ".uniform-row",
      controls = node => [...node.querySelectorAll("select,input,button")],
      index = box ? controls(box).indexOf(active) : -1,
      name = box?.dataset.name;
    renderUniforms();
    if (!box) return;
    const next = [...$("uniformList").querySelectorAll(selector)].find(node => node.dataset.name === name);
    if (!next) return;
    // 라디오(소스 · 모양 …)를 눌렀으면 같은 묶음의 고른 칸으로
    const group = active.closest?.('[role="radiogroup"]'),
      groups = [...box.querySelectorAll('[role="radiogroup"]')].indexOf(group),
      picked = group && next.querySelectorAll('[role="radiogroup"]')[groups]?.querySelector('[aria-checked="true"]');
    (picked || controls(next)[index] || controls(next)[0])?.focus();
  });
  // @if: 조건이 거짓인 파라미터 이름(검색 중에는 숨기지 않는다). 값이 바뀌어 이 목록이 달라지면 다시 그린다.
  let hiddenKey = "";
  const conditionHidden = (items, defaults) => {
    const values = new Map(items.map(item => [item.name, item.value]));
    return items
      .filter(item => {
        const spec = defaults.get(item.name);
        return (
          spec?.when && spec.type === item.type && !Annotations.visible(spec.when, name => values.get(name), defaults)
        );
      })
      .map(item => item.name);
  };
  const renderUniforms = () => {
    const userList = $("uniformList"),
      items = renderer.getUserUniforms();
    const search = $("uniformSearch").value.trim().toLowerCase();
    uniformSnapshot = snapshotOf(items);
    const defaults = annotatedDefaults(),
      hidden = new Set(search ? [] : conditionHidden(items, defaults));
    hiddenKey = [...hidden].join();
    directionRedraws = [];
    curveResizeObserver?.disconnect();
    curveRedraws.clear();
    playViews.clear();
    liveLinks.clear();
    resetSyncs.clear();
    playButtons.clear();
    userList.replaceChildren();
    // @group: 묶음 없는 파라미터가 먼저, 묶음은 처음 나온 순서대로. 검색 중에는 접힌 묶음도 펼쳐 보여 준다.
    const groups = new Map();
    let shown = 0;
    const place = (row, group) => {
      shown++;
      if (!group) return userList.append(row);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(row);
    };
    $("uniformCount").textContent = `${items.length} / 64`;
    renderPresets();
    $("uniformCreate").disabled = items.length >= 64;
    for (const item of items) {
      if (search && !`${item.name} ${item.type}`.toLowerCase().includes(search)) continue;
      if (hidden.has(item.name)) continue;
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
      // 설명: 주석에서 첫 태그 앞에 쓴 글.
      let description = null;
      if (annotated && spec.description) {
        description = element("span");
        description.className = "uniform-desc";
        description.textContent = spec.description;
      }
      const remove = element("button");
      remove.className = "remove-uniform glyph-icon icon-close";
      remove.type = "button";
      remove.title = `${item.name} 삭제 · GLSL에서 참조 중이면 먼저 코드를 수정하세요`;
      remove.setAttribute("aria-label", `${item.name} 삭제`);
      remove.addEventListener("click", () =>
        attempt(() => {
          const current = renderer.getUserUniforms().find(u => u.name === item.name);
          if (!current) return renderUniforms();
          renderer.removeUniform(item.name);
          deletedUniform = current;
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
        reset.className = "reset-uniform glyph-icon icon-reset";
        reset.type = "button";
        reset.title = `기본값(${formatDefault(fallback)})으로 되돌리기 · 슬라이더 더블클릭`;
        reset.setAttribute("aria-label", `${item.name} 기본값으로 되돌리기`);
        // 소리 · MIDI · 흔들기 연결이 값을 정하는 동안은 되돌려도 다음 프레임에 덮어써지므로 끈다(키프레임은 재생선에 키로 남는다)
        const drivenLink = Links.LINKABLE.has(item.type) ? linkOf(item.name) : null,
          driven = drivenLink && drivenLink.source !== "keys";
        if (driven) reset.title = "연결이 값을 정하는 동안은 되돌릴 수 없습니다(연결을 끄면 다시 쓸 수 있음)";
        syncReset = (value = liveValue(item)) => {
          reset.disabled = driven || sameValue(value, fallback);
        };
        syncReset();
        resetSyncs.set(item.name, syncReset);
        const restore = () => {
          if (sameValue(liveValue(item), fallback)) return;
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
      // 덧붙이는 버튼: 🎲 무작위(@seed) · ▶ 재생(@anim).
      const extras = [];
      if (item.options?.seed) {
        const dice = element("button");
        dice.className = "seed-uniform glyph-icon icon-dice";
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
        play.className = `play-uniform glyph-icon ${playing.has(item.name) ? "icon-pause" : "icon-play"}`;
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
        linkButton.className = "link-uniform glyph-icon icon-link";
        linkButton.type = "button";
        linkButton.title = link
          ? `연결됨: ${LinkSheet.describe(link)} · 누르면 연결 설정`
          : "연결: 소리 · MIDI · 흔들기 · 키프레임이 이 값을 정하게 하기";
        linkButton.setAttribute("aria-label", `${item.name} 연결 설정`);
        linkButton.setAttribute("aria-expanded", String(openLink === item.name));
        linkButton.setAttribute("aria-pressed", String(!!link));
        linkButton.addEventListener("click", () => {
          openLink = openLink === item.name ? null : item.name;
          renderUniforms();
          $("uniformList")
            .querySelector(`.link-editor[data-name="${item.name}"] [role="radio"][tabindex="0"]`)
            ?.focus();
        });
        extras.push(linkButton);
      }
      if (link) {
        row.classList.add("is-linked");
        const badge = element("span");
        badge.className = "link-badge";
        badge.textContent = LinkSheet.describe(link);
        badge.title = "연결이 프레임마다 이 값을 정합니다(직접 바꿔도 다음 프레임에 덮어씁니다)";
        title.append(badge);
      }
      top.append(title, ...extras, ...(reset ? [reset] : []), remove);
      if (description) top.append(description);
      const commit = (field, value) => {
        // 사용자가 직접 바꾸면 그 파라미터의 재생과 프리셋 전환을 멈춘다.
        if (playing.delete(item.name)) syncPlayButtons();
        stopMorph();
        try {
          renderer.setUniform(item.name, value);
          item.value = value;
          if (keyed) recordKey(item.name, value);
          syncReset?.();
          field.removeAttribute("aria-invalid");
          showError("");
          // 이 값이 다른 파라미터의 @if를 바꾸면 목록을 다시 그리고 초점은 이 파라미터 줄로 돌려 둔다.
          if (!$("uniformSearch").value.trim()) {
            const users = renderer.getUserUniforms();
            if (conditionHidden(users, annotatedDefaults()).join() !== hiddenKey)
              queueMicrotask(() => {
                renderUniforms();
                [...$("uniformList").querySelectorAll(".uniform-row")]
                  .find(node => node.dataset.name === item.name)
                  ?.querySelector("input,button,select")
                  ?.focus();
              });
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
        row.append(nav.node);
        row.classList.add("is-keyed");
        row.addEventListener("pointerdown", () => (keyPointer = true));
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
        watchLink(item.name, value => {
          nav.update();
          // 값 칸(숫자 · 슬라이더 · 위젯)을 만지는 중일 때만 멈춘다 — 줄의 다른 곳(연결 시트 · ◆)에 초점이 있어도 값은 따라간다
          const active = document.activeElement,
            editing =
              row.contains(active) &&
              !active.closest(".key-nav, .link-editor, .uniform-top") &&
              active.matches("input, select, textarea, [role=slider], [tabindex]");
          if (editing || pendingKeys.has(item.name)) return;
          // 숫자가 아닌 값 · 로그 눈금 · 다이얼 · 선택지 위젯은 위젯 자신의 갱신 함수로
          if (typeof value !== "number" || item.options?.log || item.options?.angle || item.options?.enum)
            return playViews.get(item.name)?.(typeof value === "number" ? Number(value.toFixed(4)) : value);
          const number = row.querySelector('input[type="number"]:not(.key-nav-time)'),
            slider = row.querySelector('input[type="range"]');
          if (number) {
            number.value = value.toFixed(digits);
            number.title = String(value);
          }
          if (slider) slider.value = String(value);
          if (!number && !slider) playViews.get(item.name)?.(value);
        });
      }
      // 값 편집기(위젯). 배열이면 원소마다 하나씩 그린다: 원소 몫만 읽고(read) 바꾸면 전체 배열을 고쳐 올린다.
      const widget = (row, item, commit, name) => {
        if (item.type === "bool") {
          const label = element("label");
          label.className = "uniform-switch";
          const input = element("input");
          input.type = "checkbox";
          input.checked = item.value;
          input.setAttribute("role", "switch");
          const text = element("span");
          text.textContent = String(item.value);
          input.setAttribute("aria-label", item.name);
          input.addEventListener("change", () => {
            if (!commit(input, input.checked)) input.checked = item.value;
            text.textContent = String(input.checked);
          });
          label.append(input, text);
          row.append(label);
        } else if (item.type === "sampler2D") {
          const current = () => [...(liveValue(item) || item.value)];
          row.append(
            item.options?.gradient ? gradientControl(item, commit, current) : curveControl(item, commit, current)
          );
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
          let alpha = null,
            alphaNumber = null,
            intensity = null,
            intensityNumber = null,
            lastBase = [1, 1, 1];
          const split = values => {
            const level = Math.max(0, ...values.slice(0, 3));
            if (level > 1e-6) lastBase = values.slice(0, 3).map(v => Math.max(0, v) / level);
            return { level, base: lastBase };
          };
          const show = values => {
            if (hdr) {
              const { level, base } = split(values);
              picker.value = hex(base);
              intensity.value = String(level);
              showNumber(intensityNumber, Number(level.toFixed(4)));
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
            // HDR: 고른 색에 지금 밝기 배율을 곱한다(배율이 0이면 1로 되살린다).
            const level = hdr ? split(values).level || 1 : 1;
            values.splice(0, 3, ...picked.map(v => Number((v * level).toFixed(6))));
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
              values.splice(0, 3, ...base.map(v => Number((v * Math.max(0, level)).toFixed(6))));
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
        } else if (item.options?.enum) {
          const choices = enumControl(item, commit);
          playViews.set(item.name, choices.refresh);
          row.append(choices);
        } else if (item.options?.pos) {
          row.append(positionControl(item, commit, () => [...(liveValue(item) || item.value)]));
        } else if (item.options?.angle) {
          const dial = directionControl(item, commit, () => {
            const value = liveValue(item);
            return typeof value === "number" ? value : item.value;
          });
          playViews.set(item.name, dial.refresh);
          row.append(dial);
        } else if (item.options?.dir) {
          row.append(directionControl(item, commit, () => [...(liveValue(item) || item.value)]));
        } else if (typeInfo(item.type).components > 1) {
          // 벡터는 X/Y/Z/W, 행렬은 column-major 순서의 [열,행] 칸으로 편집한다. bvec 성분은 체크박스.
          // 범위가 지정된 벡터는 성분마다 슬라이더 + 숫자 입력을 둔다.
          const { kind } = typeInfo(item.type),
            dim = kind === "m" ? Math.round(Math.sqrt(item.value.length)) : 0;
          // 배치: bvec은 X·Y… 토글 칩 한 줄, 범위 없는 vec2는 두 칸 한 줄, vec3·vec4는 성분마다 한 줄(긴 값도 잘리지 않음),
          // 범위가 있으면 성분마다 [글자 | 슬라이더 | 숫자], 행렬은 열 단위 격자.
          const opts = item.options || {},
            ranged = !dim && kind !== "b" && Number.isFinite(opts.min) && Number.isFinite(opts.max);
          const layout = dim
            ? "is-matrix"
            : kind === "b"
              ? "is-bool"
              : ranged
                ? "is-ranged"
                : item.value.length <= 2
                  ? "is-inline"
                  : "is-stacked";
          const grid = element("div");
          grid.className = `uniform-vector ${layout}`;
          if (dim) grid.style.setProperty("--uniform-columns", String(dim));
          item.value.forEach((value, index) => {
            const field = element(kind === "b" ? "label" : "div");
            field.className = ranged ? "uniform-axis is-ranged" : "uniform-axis";
            const label = element(kind === "b" ? "span" : "label");
            label.className = "uniform-axis-label";
            label.textContent = dim ? `${Math.floor(index / dim)},${index % dim}` : ["X", "Y", "Z", "W"][index];
            const input = element("input");
            input.setAttribute(
              "aria-label",
              `${item.name} ${dim ? `열 ${Math.floor(index / dim)} 행 ${index % dim}` : label.textContent}`
            );
            if (kind === "b") {
              input.type = "checkbox";
              input.checked = value;
            } else {
              input.type = "number";
              input.step = kind === "f" || kind === "m" ? "any" : "1";
              if (kind === "u") input.min = "0";
              showNumber(input, value);
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
              return true;
            };
            let slider = null;
            input.addEventListener("change", () => {
              if (
                update(input, kind === "b" ? input.checked : input.value.trim() ? Number(input.value) : NaN) &&
                slider
              )
                slider.value = input.value;
            });
            // 성분별 범위(@range를 성분마다)면 이 성분의 범위를 쓴다.
            const axis = opts.ranges?.[index]
              ? { min: opts.ranges[index][0], max: opts.ranges[index][1], step: opts.ranges[index][2] }
              : opts;
            if (kind !== "b" && !dim)
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
          });
          row.append(grid);
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
          showNumber(number, item.value);
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
              showNumber(number, item.value);
              return;
            }
            if (commit(number, value)) {
              if (range) range.value = String(toSlider(value));
              showNumber(number, value);
            } else showNumber(number, item.value);
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
              range.title = "로그 눈금 · 같은 거리를 움직이면 같은 배율로 바뀐다";
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
          list.append(cell);
        }
        row.append(list);
      } else widget(row, item, commit, name);
      if (openLink === item.name && Links.LINKABLE.has(item.type)) row.append(linkEditor(item));
      place(row, annotated ? spec.group : "");
    }
    // 묶음 순서는 코드에 처음 나온 순서(다른 프로젝트에서 남은 파라미터의 등록 순서가 아니라).
    const codeOrder = [...new Set([...defaults.values()].map(spec => spec.group).filter(Boolean))];
    const rank = group => (codeOrder.includes(group) ? codeOrder.indexOf(group) : codeOrder.length);
    for (const [group, rows] of [...groups].sort((a, b) => rank(a[0]) - rank(b[0]))) {
      const section = element("section"),
        open = Boolean(search) || !collapsedGroups.has(group);
      section.className = open ? "uniform-group" : "uniform-group is-collapsed";
      const head = element("button");
      head.type = "button";
      head.className = "uniform-group-head glyph-icon icon-chevron";
      head.setAttribute("aria-expanded", String(open));
      const label = element("span");
      label.className = "uniform-group-name";
      label.textContent = group;
      const count = element("span");
      count.className = "uniform-group-count";
      count.textContent = String(rows.length);
      head.append(label, count);
      head.addEventListener("click", () => {
        if (collapsedGroups.has(group)) collapsedGroups.delete(group);
        else collapsedGroups.add(group);
        renderUniforms();
        [...userList.querySelectorAll(".uniform-group-name")]
          .find(n => n.textContent === group)
          ?.parentElement?.focus();
      });
      const body = element("div");
      body.className = "uniform-group-body";
      body.hidden = !open;
      body.append(...rows);
      section.append(head, body);
      userList.append(section);
    }
    // 방향 패드는 문서에 붙은 뒤에야 테마 색을 읽을 수 있으므로 한 번 더 그린다.
    for (const draw of directionRedraws) draw();
    const count = shown;
    $("uniformResults").textContent = search
      ? `${items.length}개 중 ${count}개 표시`
      : hidden.size
        ? `조건(@if)으로 숨긴 파라미터 ${hidden.size}개: ${[...hidden].join(", ")}`
        : "";
    if (!count) {
      const hint = element("div");
      hint.className = "uniform-empty";
      hint.textContent = search
        ? "검색 결과가 없습니다. 이름이나 타입을 확인하세요."
        : hidden.size
          ? "모든 파라미터가 조건(@if)으로 숨겨져 있습니다."
          : "아직 파라미터가 없습니다. 위에서 추가하거나 갤러리 예제로 시작하세요.";
      userList.append(hint);
    }
  };
  listen($("undoUniform"), "click", () =>
    attempt(() => {
      if (!deletedUniform) return;
      const { name, type, value, options } = deletedUniform;
      renderer.defineUniform(name, type, value, options);
      clearDeleted();
      $("uniformSearch").value = "";
      renderUniforms();
      focusSearch();
    })
  );
  // Uniform 추가 폼의 표시 방식. 주석 어노테이션(@color·@dir·@angle·@pos·@log·@enum)과 같은 옵션을 만든다.
  const DISPLAY_CHOICES = [
    {
      value: "color",
      label: "색상 선택기 (값 0~1)",
      types: ["vec3", "vec4"],
      help: "견본·HEX로 고릅니다. @color와 같습니다.",
    },
    {
      value: "hdr",
      label: "HDR 색상 (색 + 밝기 배율)",
      types: ["vec3", "vec4"],
      help: "견본 색에 밝기 배율(0~10)을 곱해 1보다 밝은 발광·조명 색을 만듭니다. @color hdr와 같습니다.",
    },
    {
      value: "dir",
      label: "단위 방향 (다이얼·구 패드)",
      types: ["vec2", "vec3"],
      help: "값은 늘 길이 1로 맞춰집니다. @dir와 같습니다.",
    },
    {
      value: "angle",
      label: "각도 다이얼 (라디안)",
      types: ["float"],
      help: "0~360°로 보여 주며 누적 회전 수를 따로 표시합니다. 셰이더에는 누적 라디안을 넘깁니다. @angle과 같습니다.",
    },
    {
      value: "pos",
      label: "2D 패드 (위치)",
      types: ["vec2"],
      help: "슬라이더 범위를 패드의 가로·세로로 씁니다. 비우면 -1~1. @pos와 같습니다.",
    },
    {
      value: "log",
      label: "로그 눈금 슬라이더",
      types: ["float"],
      help: "0보다 큰 Min·Max가 필요합니다. 0.01~100처럼 넓은 범위에 좋습니다. @log와 같습니다.",
    },
    {
      value: "enum",
      label: "선택지 (이름 붙은 버튼)",
      types: ["int", "uint"],
      help: "이름 순서대로 0, 1, 2…가 됩니다. 슬라이더 범위는 이름 수로 정해집니다. @enum과 같습니다.",
    },
    {
      value: "gradient",
      label: "그라데이션 (색 램프)",
      types: ["sampler2D"],
      help: "셰이더에서 texture(이름, vec2(t, 0.5))로 0~1 위치의 색을 읽습니다. @gradient와 같습니다.",
    },
    {
      value: "curve",
      label: "곡선 (값 램프)",
      types: ["sampler2D"],
      help: "셰이더에서 texture(이름, vec2(x, 0.5)).r로 곡선의 y를 읽습니다. @curve와 같습니다.",
    },
  ];
  const updateDisplayFields = () => {
    const display = $("uniformDisplay").value,
      choice = DISPLAY_CHOICES.find(item => item.value === display);
    $("uniformEnumLabels").hidden = display !== "enum";
    $("uniformEnumLabels").required = display === "enum";
    $("uniformDisplayHelp").textContent = choice?.help || "";
    // 범위를 쓰지 않는 표시 방식이면 범위 칸을 숨긴다.
    const kind = typeInfo($("uniformType").value).kind;
    $("rangeFields").hidden =
      !["f", "i", "u"].includes(kind) || ["color", "hdr", "dir", "angle", "enum"].includes(display);
  };
  const updateTypeFields = () => {
    const t = $("uniformType").value,
      bool = t === "bool",
      ramp = t === "sampler2D",
      { components: size, kind } = typeInfo(t);
    $("uniformValue").hidden = bool || ramp;
    $("uniformValue").required = !bool && !ramp;
    $("uniformBoolValue").hidden = !bool;
    $("uniformValueHelp").textContent = ramp
      ? "그라데이션(검정 → 흰색)이나 직선 곡선으로 시작합니다. 만든 뒤 패널에서 정지점·점을 고치세요."
      : bool
        ? "선택한 상태가 GLSL의 true/false로 전달됩니다."
        : kind === "m"
          ? `${size}개 숫자를 column-major 순서로 입력하세요. 기본값은 단위 행렬입니다.`
          : kind === "b"
            ? `${size}개의 true/false를 쉼표로 구분하세요.`
            : size > 1
              ? `${size}개 ${kind === "f" ? "숫자" : kind === "u" ? "0 이상 정수" : "정수"}를 쉼표로 구분하세요. 예: ${defaultValue(t)}`
              : "숫자를 입력하세요. 슬라이더 범위는 선택 사항입니다.";
    // 표시 방식: 타입에 맞는 것만 고를 수 있게 목록을 다시 만든다. 고를 것이 없으면(기본뿐) 칸을 숨긴다.
    const select = $("uniformDisplay"),
      previous = select.value,
      choices = DISPLAY_CHOICES.filter(choice => choice.types.includes(t));
    // sampler2D는 그라데이션·곡선 중 하나여야 하므로 "기본"이 없다.
    select.replaceChildren(
      ...[...(ramp ? [] : [{ value: "", label: "기본 (숫자·슬라이더)" }]), ...choices].map(choice => {
        const option = element("option");
        option.value = choice.value;
        option.textContent = choice.label;
        return option;
      })
    );
    select.value = choices.some(choice => choice.value === previous) ? previous : ramp ? choices[0].value : "";
    $("uniformDisplayField").hidden = !choices.length;
    updateDisplayFields();
    $("uniformValue").value = defaultValue(t);
  };
  listen($("uniformType"), "change", updateTypeFields);
  listen($("uniformDisplay"), "change", updateDisplayFields);
  listen($("uniformSearch"), "input", renderUniforms);
  listen($("uniformEditor"), "toggle", () => {
    if ($("uniformEditor").open) $("uniformName").focus();
  });
  listen($("uniformCancel"), "click", () => {
    $("uniformEditor").open = false;
    showError("");
    $("uniformEditor").querySelector("summary").focus();
  });
  listen($("uniformForm"), "submit", event => {
    event.preventDefault();
    attempt(() => {
      const type = $("uniformType").value;
      if (type === "sampler2D") {
        // 램프는 기본 모양으로 만들고 패널 편집기에서 다듬는다.
        const curve = $("uniformDisplay").value === "curve";
        renderer.defineUniform(
          $("uniformName").value.trim(),
          type,
          curve ? [0, 0, 1, 1] : [0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
          curve ? { curve: "smooth" } : { gradient: "linear" }
        );
        clearDeleted();
        $("uniformSearch").value = "";
        renderUniforms();
        $("uniformName").value = "";
        $("uniformEditor").open = false;
        $("uniformEditor").querySelector("summary").focus();
        return;
      }
      const value = parseValue(type, type === "bool" ? $("uniformBoolValue").value : $("uniformValue").value);
      const min = $("uniformMin").value.trim(),
        max = $("uniformMax").value.trim(),
        step = $("uniformStep").value.trim();
      const display = DISPLAY_CHOICES.find(
        choice => choice.value === $("uniformDisplay").value && choice.types.includes(type)
      )?.value;
      const hasBounds =
        !["color", "hdr", "dir", "angle", "enum"].includes(display) &&
        ["f", "i", "u"].includes(typeInfo(type).kind) &&
        [min, max, step].some(Boolean);
      if (hasBounds && ![min, max, step].every(Boolean))
        throw new Error("슬라이더의 Min, Max, Step을 모두 입력하세요.");
      const opts = hasBounds ? { min: Number(min), max: Number(max), step: Number(step) } : {};
      if (display === "color") opts.color = true;
      else if (display === "hdr") Object.assign(opts, { color: true, hdr: 10 });
      else if (display === "dir") opts.dir = "full";
      else if (display === "angle") opts.angle = true;
      else if (display === "pos") {
        opts.pos = true;
        if (!hasBounds) Object.assign(opts, { min: -1, max: 1, step: 0.002 });
      } else if (display === "log") {
        if (!hasBounds || !(opts.min > 0))
          throw new Error("로그 눈금 슬라이더에는 0보다 큰 Min·Max·Step이 필요합니다.");
        opts.log = true;
      } else if (display === "enum") {
        const labels = $("uniformEnumLabels")
          .value.split(/[\s,]+/)
          .filter(Boolean)
          .map(label => label.replace(/_/g, " "));
        if (labels.length < 2) throw new Error("선택지 이름을 2개 이상 입력하세요. 예: 결과 밀도 투과율");
        Object.assign(opts, { min: 0, max: labels.length - 1, step: 1, enum: labels });
      }
      renderer.defineUniform($("uniformName").value.trim(), type, value, opts);
      clearDeleted();
      $("uniformSearch").value = "";
      renderUniforms();
      $("uniformName").value = "";
      $("uniformMin").value = $("uniformMax").value = $("uniformStep").value = "";
      $("uniformEnumLabels").value = "";
      $("uniformDisplay").value = "";
      updateDisplayFields();
      $("uniformEditor").open = false;
      $("uniformEditor").querySelector("summary").focus();
    });
  });
  listen($("fpsLimit"), "change", event => attempt(() => renderer.setFpsLimit(parseValue("int", event.target.value))));
  for (const button of document.querySelectorAll("[data-fps-preset]")) {
    listen(button, "click", () =>
      attempt(() => {
        const value = Number(button.dataset.fpsPreset);
        renderer.setFpsLimit(value);
        $("fpsLimit").value = String(value);
        syncFpsPresets(value);
      })
    );
  }
  for (const button of document.querySelectorAll("[data-time-scale]"))
    listen(button, "click", () =>
      attempt(() => {
        syncTimeScale(renderer.setTimeScale(Number(button.dataset.timeScale)));
        updateStats();
      })
    );
  listen($("stepFrame"), "click", () => attempt(stepFrame));
  // 무거운 예제 안내: 갤러리에서 예제를 연 뒤 몇 초 동안의 실제 FPS가 낮으면 해상도 배율을 낮추자고 한 번 제안한다.
  // "그대로 두기"를 고른 예제는 이번 세션에서 다시 묻지 않는다.
  const SLOW_FPS = 30,
    declined = new Set();
  let suggestTimer = 0,
    suggestTarget = 1;
  const hideSuggest = () => {
    clearTimeout(suggestTimer);
    suggestTimer = 0;
    $("perfSuggest").hidden = true;
  };
  const checkHeavy = ({ id, title }) => {
    const s = renderer.getStats();
    if (!s.running || s.resolutionScale <= 0.5 || declined.has(id)) return;
    const floor = s.fpsLimit > 0 ? Math.min(SLOW_FPS, s.fpsLimit * 0.8) : SLOW_FPS;
    if (!(s.fps > 0 && s.fps < floor)) return;
    suggestTarget = s.resolutionScale > 0.75 ? 0.75 : 0.5;
    $("perfSuggestText").textContent =
      `이 예제(${title})는 지금 약 ${s.fps.toFixed(0)} FPS로 무겁습니다. 해상도 배율을 낮출까요?`;
    $("perfSuggestApply").textContent = `${Math.round(suggestTarget * 100)}%로 낮추기`;
    $("perfSuggest").dataset.example = id;
    $("perfSuggest").hidden = false;
  };
  listen(document, "gallery-example-loaded", event => {
    hideSuggest();
    const detail = event.detail || {};
    // 예제를 바꾼 직후에는 컴파일·첫 프레임 때문에 FPS가 흔들린다. 1초 구간 FPS가 두 번 갱신될 만큼 기다린다.
    suggestTimer = setTimeout(() => checkHeavy(detail), 3000);
  });
  listen($("perfSuggestApply"), "click", () =>
    attempt(() => {
      renderer.setResolutionScale(suggestTarget);
      hideSuggest();
      updateStats();
    })
  );
  listen($("perfSuggestDismiss"), "click", () => {
    if ($("perfSuggest").dataset.example) declined.add($("perfSuggest").dataset.example);
    hideSuggest();
  });
  signal.addEventListener("abort", () => clearTimeout(suggestTimer));
  listen($("resolutionScale"), "input", event =>
    attempt(() => {
      const value = Number(event.target.value);
      renderer.setResolutionScale(value);
      $("resolutionLabel").textContent = `${Math.round(value * 100)}%`;
    })
  );
  listen($("maxPixels"), "change", event =>
    attempt(() => renderer.setMaxPixels(parseValue("int", event.target.value)))
  );
  const stage = $("stage"),
    tabScroll = new Map();
  let activeTab = "render";
  const setActiveTab = tab => {
    const scroll = $("panel").querySelector(".panel-scroll");
    tabScroll.set(activeTab, scroll.scrollTop);
    activeTab = tab;
    for (const button of document.querySelectorAll("#panelTabs [data-tab]")) {
      const active = button.dataset.tab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const view of document.querySelectorAll(".panel-view")) {
      const active = view.dataset.panel === tab;
      view.classList.toggle("is-active", active);
      view.hidden = !active;
    }
    scroll.scrollTop = tabScroll.get(tab) || 0;
    if (tab === "uniforms") renderUniforms();
  };
  listen($("studioParameters"), "click", () => {
    // 좁은 화면에서 패널은 편집기 위에 겹쳐 열리므로 편집기를 닫지 않는다. 패널을 닫으면 편집하던 화면으로 그대로 돌아간다.
    document.body.classList.remove("panel-hidden");
    syncPanel();
    setActiveTab("uniforms");
    focusSearch();
  });
  // 버퍼 결과·픽셀 값은 성능 탭의 버퍼 뷰어 한 곳에서 본다.
  listen($("openBufferViewer"), "click", () => {
    setActiveTab("profile");
    $("profileBuffers").closest?.("section")?.scrollIntoView?.({ block: "start" });
  });
  const tabButtons = [...document.querySelectorAll("#panelTabs [data-tab]")];
  for (const button of tabButtons) listen(button, "click", () => setActiveTab(button.dataset.tab));
  listen($("panelTabs"), "keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = tabButtons.indexOf(document.activeElement);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabButtons.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabButtons.length) % tabButtons.length;
    setActiveTab(tabButtons[index].dataset.tab);
    tabButtons[index].focus();
  });
  const syncPanel = () => {
    const hidden = document.body.classList.contains("panel-hidden");
    stage.inert = !hidden && window.matchMedia("(max-width:820px)").matches;
    $("panelToggle").setAttribute("aria-label", hidden ? "설정 패널 열기" : "설정 패널 숨기기");
    $("panelToggle").setAttribute("aria-pressed", String(!hidden));
    $("panelClose").title = hidden ? "패널 열기" : "패널 숨기기";
  };
  const togglePanel = () => {
    document.body.classList.toggle("panel-hidden");
    syncPanel();
    if (!document.body.classList.contains("panel-hidden"))
      $("panelTabs").querySelector(`[data-tab="${activeTab}"]`)?.focus();
    else focusToolbar("panelToggle");
  };
  // HUD 숨기기(G · ⋯ 메뉴의 HUD): 위쪽 도구 막대·프로젝트 이름·안내와 아래쪽 미리보기 정보·FPS까지 모두 숨기고 셰이더만 남긴다.
  // 포인터를 움직이면 오른쪽 위에 'HUD 다시 보기' 버튼이 잠깐 나타난다. G · Esc로도 되돌린다. 분리 창에도 따라간다(popout.js).
  let revealTimer = 0;
  const showReveal = () => {
    if (!stage.classList.contains("hud-hidden")) return;
    $("hudReveal").classList.add("is-visible");
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => $("hudReveal").classList.remove("is-visible"), 1600);
  };
  const setHud = visible => {
    const hidden = !visible;
    stage.classList.toggle("hud-hidden", hidden);
    $("hudToggle").setAttribute("aria-label", hidden ? "HUD 표시" : "HUD 숨기기");
    $("hudToggle").setAttribute("aria-pressed", String(!hidden));
    $("hudReveal").classList.remove("is-visible");
    clearTimeout(revealTimer);
    if (hidden) {
      for (const id of ["moreMenu", "captureMenu"]) if ($(id) && !$(id).hidden) $(id).hidden = true;
      showReveal();
    }
  };
  const toggleHud = () => setHud(stage.classList.contains("hud-hidden"));
  listen($("hudReveal"), "click", () => setHud(true));
  listen($("screen"), "pointermove", showReveal);
  const syncTimeScale = scale => {
    for (const button of document.querySelectorAll("[data-time-scale]")) {
      const active = Number(button.dataset.timeScale) === scale;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    }
    setText("timeScaleLabel", `${scale}×`);
  };
  // 한 프레임 진행: 재생 중이면 먼저 멈추고, 멈춘 상태에서 1/60초만큼 그린다.
  const stepFrame = () => {
    const studio = window.shaderStudio;
    if (studio ? studio.getPlaybackState() : renderer.getStats().running) {
      if (studio) studio.togglePlayback();
      else renderer.stop();
    }
    renderer.stepFrame();
    requestAnimationFrame(() => requestAnimationFrame(updateStats));
  };
  const syncFpsPresets = fps => {
    for (const button of document.querySelectorAll("[data-fps-preset]")) {
      const active = Number(button.dataset.fpsPreset) === fps;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    }
  };
  const toggleFullscreen = async () => {
    try {
      const doc = $("screen").ownerDocument || document,
        surface = doc === document ? stage : doc.body;
      if (doc.fullscreenElement) await doc.exitFullscreen();
      else await surface.requestFullscreen();
      showError("");
    } catch (error) {
      showError(`전체화면 전환 실패: ${error.message}`);
    }
  };
  listen($("panelClose"), "click", togglePanel);
  // 가이드(guide.js)가 있으면 그쪽에서 목록을 채운 뒤 연다. <dialog>의 toggle 이벤트는 구형 브라우저에서 발생하지 않으므로 그것에 기대지 않는다.
  const helpDialog = $("quickHelp"),
    toggleHelp = () => {
      if (helpDialog.open) return helpDialog.close();
      const request = new CustomEvent("guide-open-request", { cancelable: true });
      if (document.dispatchEvent(request) && !helpDialog.open) helpDialog.showModal();
    };
  for (const id of ["helpToggle", "studioHelp"]) listen($(id), "click", toggleHelp);
  listen($("helpClose"), "click", () => helpDialog.close());
  listen(helpDialog, "click", event => {
    if (event.target === helpDialog) helpDialog.close();
  });
  listen(helpDialog, "keydown", event => {
    if (!["Escape", "?"].includes(event.key)) event.stopPropagation();
  });
  listen(document, "shader-panel-changed", syncPanel);
  listen($("panelBackdrop"), "click", togglePanel);
  listen(window, "resize", syncPanel);
  listen($("panelToggle"), "click", togglePanel);
  listen($("hudToggle"), "click", toggleHud);
  listen($("fullscreenToggle"), "click", toggleFullscreen);
  // ---- 뷰포트 툴바 메뉴: 캡처 ▾ · ⋯ 더보기 (stage-menu.js) ----
  const captureMenu = StageMenu.create({ toggle: $("captureToggle"), menu: $("captureMenu"), signal }),
    moreMenu = StageMenu.create({ toggle: $("moreToggle"), menu: $("moreMenu"), signal });
  // 메뉴 안으로 옮긴 버튼(패널·가이드)은 닫힌 메뉴 속에 있어 초점을 받을 수 없다. 그럴 때는 메뉴 버튼으로 돌려준다.
  const focusToolbar = id => {
    const node = $(id);
    if (node?.offsetParent) node.focus();
    else (node?.closest("#moreMenu") ? moreMenu : captureMenu).toggle.focus();
  };
  const download = (blob, name) => {
    const url = URL.createObjectURL(blob),
      a = element("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  };
  // ---- 녹화 (recorder.js) ----
  // 녹화 중에는 툴바에 빨간 점과 경과 시간이 나오고, 그 버튼이나 캡처 메뉴의 "녹화 중지"로 끝낸다. 끝나면 파일을 내려받는다.
  const recordFormat = Recorder.pickMimeType().startsWith("video/mp4") ? "MP4" : "WebM";
  setText("recordFormat", recordFormat);
  const recorder = Recorder.create({
    canvas: $("screen"),
    onFrame: renderer.onFrame,
    redraw: renderer.redraw,
    audioTracks: () => renderer.mediaAudioTracks?.() || [],
    onChange: ({ recording, ready, elapsed }) => {
      $("recordStop").hidden = !recording;
      // 인코더가 준비되는 동안(느린 컴퓨터에서 1초 남짓)은 '준비'로 보인다. 그동안 누른 중지는 시작된 뒤 잠깐 담고 멈춘다.
      setText("recordTime", ready ? Recorder.formatElapsed(elapsed) : "준비");
      $("recordStop").classList.toggle("is-preparing", recording && !ready);
      $("recordStop").title = ready
        ? `녹화 중지 · ${Recorder.formatElapsed(elapsed)}`
        : "녹화 준비 중 · 누르면 시작 직후 멈춤";
      stage.classList.toggle("is-recording", recording);
      setText("recordButtonLabel", recording ? "녹화 중지" : "녹화 시작");
      $("recordButton").setAttribute("aria-label", recording ? "녹화 중지" : "녹화 시작");
      $("captureToggle").classList.toggle("is-recording", recording);
    },
    onSave: (blob, name) => {
      download(blob, name);
      showError("");
    },
    onError: message => showError(message),
  });
  if (!Recorder.supported($("screen"))) {
    $("recordButton").disabled = true;
    $("recordButton").title = "이 브라우저는 캔버스 녹화를 지원하지 않습니다";
  }
  listen($("recordButton"), "click", () => recorder.toggle());
  // ---- 영상 렌더링 (video-dialog.js · video-render.js) ----
  VideoDialog.mount({
    renderer,
    download,
    isBusy: () => (recorder.isRecording() ? "녹화 중에는 영상 렌더링을 할 수 없습니다. 녹화를 먼저 멈추세요." : ""),
    signal,
  });
  listen($("recordStop"), "click", () => {
    recorder.stop();
    $("captureToggle").focus();
  });
  listen($("screenshotButton"), "click", async () => {
    const button = $("screenshotButton");
    button.disabled = true;
    try {
      download(await renderer.captureScreenshot(), `shader-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      showError("");
    } catch (error) {
      showError(`PNG 저장 실패: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
  // 고해상도 PNG: 2× = 지금 렌더 크기의 두 배, 4K = 긴 변 3840px(비율 유지). Image 패스만 다시 그린다.
  for (const button of document.querySelectorAll("[data-capture]"))
    listen(button, "click", async () => {
      const { width: w, height: h } = renderer.getStats(),
        mode = button.dataset.capture,
        factor = mode === "4k" ? 3840 / Math.max(w, h) : 2,
        width = Math.max(1, Math.round(w * factor)),
        height = Math.max(1, Math.round(h * factor));
      button.disabled = true;
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        download(await renderer.captureScreenshotAt(width, height), `shader-${stamp}-${width}x${height}.png`);
        showError("");
      } catch (error) {
        showError(`고해상도 PNG 저장 실패: ${error.message}`);
      } finally {
        button.disabled = false;
      }
    });
  listen($("previewPause"), "click", () =>
    attempt(() => {
      window.shaderStudio?.togglePlayback();
      updateStats();
    })
  );
  listen($("previewImage"), "click", () =>
    attempt(() => {
      renderer.setPreviewPass(null);
      updateStats();
      document.dispatchEvent(new Event("shader-preview-changed"));
    })
  );
  listen($("screen"), "pointerdown", () => stage.classList.add("has-interacted"));
  listen($("screen"), "wheel", () => stage.classList.add("has-interacted"));
  const syncFullscreen = () => {
    const doc = $("screen").ownerDocument || document,
      active = !!doc.fullscreenElement,
      pip = !!window.documentPictureInPicture?.window && window.documentPictureInPicture.window === doc.defaultView;
    $("fullscreenToggle").disabled = pip;
    $("fullscreenToggle").setAttribute("aria-label", active ? "전체화면 종료" : "전체화면");
    $("fullscreenToggle").title = pip
      ? "항상 위에 표시되는 분리 창에서는 전체화면을 지원하지 않습니다"
      : active
        ? "전체화면 종료 (F)"
        : "전체화면 (F)";
  };
  const fullscreenDocs = new WeakSet();
  const bindFullscreen = () => {
    const doc = $("screen").ownerDocument || document;
    if (!fullscreenDocs.has(doc)) {
      fullscreenDocs.add(doc);
      listen(doc, "fullscreenchange", syncFullscreen);
    }
    syncFullscreen();
  };
  bindFullscreen();
  listen(document, "preview-popout-changed", () => {
    bindFullscreen();
  });
  listen(document, "keydown", event => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
    const key = event.key.toLowerCase();
    if (event.code === "Space" && (document.activeElement === stage || document.activeElement === $("screen"))) {
      event.preventDefault();
      window.shaderStudio?.togglePlayback();
      updateStats();
    } else if (key === "?") {
      event.preventDefault();
      toggleHelp();
    } else if (key === "f") {
      event.preventDefault();
      toggleFullscreen();
    } else if (key === "h") {
      event.preventDefault();
      togglePanel();
    } else if (event.key === "Escape" && stage.classList.contains("hud-hidden")) {
      event.preventDefault();
      setHud(true);
    } else if (key === "g") {
      event.preventDefault();
      toggleHud();
    } else if (key === "t") {
      event.preventDefault();
      $("timelineToggle").click();
    } else if (event.key === ".") {
      event.preventDefault();
      attempt(stepFrame);
    } else if (key === "/") {
      event.preventDefault();
      document.body.classList.remove("panel-hidden");
      syncPanel();
      setActiveTab("uniforms");
      $("uniformSearch").focus();
    }
  });
  syncPanel();
  const updateStats = () => {
    const s = renderer.getStats();
    const storage = settings.status();
    setText("storageStatus", storage.message);
    $("storageStatus").classList.toggle("unavailable", !storage.available);
    // 외부 JS에서 변경한 설정도 패널에 반영한다. 사용자가 편집 중이면 값은 덮어쓰지 않는다.
    const playing = window.shaderStudio?.getPlaybackState() ?? s.running;
    $("previewPause").setAttribute("aria-label", playing ? "일시정지" : "재생");
    $("previewPause").setAttribute("aria-pressed", String(!playing));
    setText("renderState", s.running ? "재생 중" : "일시정지");
    $("renderState").dataset.running = String(s.running);
    {
      const pause = $("studioPause"),
        label = stage.classList.contains("studio-maximized")
          ? playing
            ? "복귀 시 재생"
            : "복귀 시 정지"
          : playing
            ? "일시정지"
            : "재생";
      pause.setAttribute("aria-label", label);
      pause.setAttribute("aria-pressed", String(!playing));
      pause.title = `${label} · 뷰포트에서는 Space`;
    }
    $("previewImage").disabled = !s.previewPass;
    const active = document.activeElement;
    if (active !== $("fpsLimit")) $("fpsLimit").value = s.fpsLimit;
    if (active !== $("resolutionScale")) $("resolutionScale").value = s.resolutionScale;
    $("resolutionLabel").textContent = `${Math.round(s.resolutionScale * 100)}%`;
    const pixelSelect = $("maxPixels");
    let custom = pixelSelect.querySelector("option[data-custom]");
    if (custom && String(s.maxPixels) !== custom.value) {
      custom.remove();
      custom = null;
    }
    if (![...pixelSelect.options].some(o => o.value === String(s.maxPixels))) {
      custom = element("option");
      custom.dataset.custom = "true";
      custom.value = String(s.maxPixels);
      custom.textContent = `사용자 설정 (${s.maxPixels.toLocaleString("ko-KR")}px)`;
      pixelSelect.append(custom);
    }
    if (active !== pixelSelect) pixelSelect.value = String(s.maxPixels);
    if (
      !$("view-uniforms").hidden &&
      !(active instanceof Element && active.closest("#uniformList")) &&
      uniformSnapshot !== snapshotOf(renderer.getUserUniforms())
    )
      renderUniforms();
    $("statFps").textContent = s.fps.toFixed(1) + (s.fpsLimit ? ` / ${s.fpsLimit}` : "");
    $("statResolution").textContent = `${s.width} × ${s.height}`;
    $("statFrame").textContent = s.frame.toLocaleString("ko-KR");
    setText("statTime", `${(s.time ?? 0).toFixed(2)}s` + (s.timeScale && s.timeScale !== 1 ? ` ×${s.timeScale}` : ""));
    syncTimeScale(s.timeScale ?? 1);
    // GPU 시간은 EXT_disjoint_timer_query_webgl2가 있을 때만 측정된다. 없으면 CPU 제출 시간만 표시한다.
    const gpu = s.gpu,
      gpuText =
        gpu?.available && gpu.enabled ? (gpu.totalMs === null ? "측정 중" : `${gpu.totalMs.toFixed(2)}ms`) : "N/A";
    setText("statGpu", gpuText);
    $("statGpu").parentElement?.setAttribute?.(
      "title",
      gpu?.available
        ? `패스별 GPU 시간(이동평균): ${gpu.passes.map(p => `${p.label} ${p.ms.toFixed(2)}ms`).join(" · ") || "측정 대기"} · CPU 제출 ${(s.cpuMs ?? 0).toFixed(2)}ms`
        : `이 브라우저/GPU는 GPU 타이머(EXT_disjoint_timer_query_webgl2)를 지원하지 않습니다. CPU 제출 ${(s.cpuMs ?? 0).toFixed(2)}ms · 프레임 간격 ${(s.frameMs ?? 0).toFixed(2)}ms`
    );
    $("stats").title =
      `${s.fps.toFixed(1)} FPS · ${s.width}×${s.height} · Frame ${s.frame} · GPU ${gpuText} · CPU ${(s.cpuMs ?? 0).toFixed(2)}ms`;
    $("viewportMode").textContent = s.previewPass ? `BUFFER ${s.previewPass}` : "IMAGE";
    const previewName = s.previewPass ? `Buffer ${s.previewPass}` : "Image";
    $("studioPreviewTarget").textContent = previewName;
    $("studioPreviewTarget").setAttribute("aria-label", `미리보기: ${previewName}`);
    syncFpsPresets(s.fpsLimit);
  };
  listen(document, "shader-settings-applied", () => {
    clearDeleted();
    $("uniformSearch").value = "";
    renderUniforms();
    syncPanel();
    updateStats();
  });
  // JS에서 초기 설정이 이미 바뀌어 있더라도 UI 표시와 일치시킨다.
  listen($("resetSettings"), "click", () =>
    attempt(() => {
      settings.reset();
      $("uniformSearch").value = "";
      renderUniforms();
      updateStats();
      syncPanel();
    })
  );
  updateTypeFields();
  clearDeleted();
  renderUniforms();
  updateStats();
  const timer = setInterval(updateStats, 500);
  const timeline = Timeline.mount({ renderer, settings, root: $("timelineDock") });
  timeline.bindToggle($("timelineToggle"));
  return {
    dispose: () => {
      clearInterval(timer);
      timeline.dispose();
      recorder.dispose(); // 창을 닫는 중에는 녹화 파일을 내려받지 않고 버린다.
      controller.abort();
    },
  };
};
export { mount };
