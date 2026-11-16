// 파라미터 줄의 값 조작 부품: 숫자 칸 표시 · 끌어서 바꾸기(scrub) · 방향 패드(@dir) · 위치 패드(@pos/@xy) ·
// 선택지(@enum) · 그라데이션(@gradient) · 곡선(@curve). ui.js의 파라미터 목록이 만들어 쓴다.
// 부품은 commit(값)으로만 값을 바꾸고, 렌더러는 liveValue로 읽기만 한다.
//   create(ctx) → { ...부품, reset(): 목록을 다시 그리기 전 패드 다시 그리기 목록 비우기, redraw(): 방향 패드 다시 그리기 }
import * as UI from "./ui-kit.js";

const create = ({ element, listen, signal, showError, liveValue, renderer }) => {
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
  // Summary is presentation only: entering a field restores the exact Number. A focus/blur
  // cycle must never commit the rounded summary or interrupt a running animation.
  const numberEdits = new WeakMap();
  const showNumber = (field, value, read) => {
    let state = numberEdits.get(field);
    if (!state) {
      state = { value, rendered: "", editing: false, dirty: false, read };
      numberEdits.set(field, state);
      field.classList.add("ui-number");
      const latest = () => {
        const live = state.read?.();
        if (Number.isFinite(live)) {
          state.value = live;
          field.title = String(live);
        }
      };
      field.addEventListener("focus", () => {
        latest();
        state.editing = true;
        field.value = state.rendered = String(state.value);
      });
      field.addEventListener("input", () => {
        state.dirty = true;
      });
      field.addEventListener(
        "change",
        event => {
          latest();
          const raw = field.value,
            untouched = !state.dirty && (raw === state.rendered || raw === String(state.value)),
            same = !state.dirty && raw.trim() !== "" && Number(raw) === state.value;
          state.dirty = false;
          if (untouched || same) event.stopImmediatePropagation?.();
        },
        { capture: true }
      );
      field.addEventListener("blur", () => {
        state.editing = false;
        // Native change runs before blur and owns validation/commit. Do not replace a draft
        // merely because the renderer is publishing live values while it is being edited.
        if (!state.dirty) field.value = state.rendered = displayNumber(state.value);
      });
      field.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          field.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          latest();
          state.dirty = false;
          field.value = state.rendered = String(state.value);
          if (field.getAttribute?.("aria-invalid") === "true") showError("");
          field.removeAttribute("aria-invalid");
        }
      });
    }
    if (read) state.read = read;
    state.value = value;
    field.title = String(value);
    if (state.editing && state.dirty) return;
    field.value = state.rendered = state.editing ? String(value) : displayNumber(value);
  };
  // Scrub handles/pads prevent the browser's normal focus change. Commit an active draft
  // before their pointer handlers read the model, so one component cannot overwrite another.
  document.addEventListener(
    "pointerdown",
    event => {
      const active = document.activeElement;
      if (
        event.button !== 0 ||
        active === event.target ||
        !event.target.closest?.(".is-scrub,.uniform-dir-pad,.uniform-curve-pad,.uniform-ramp-track")
      )
        return;
      if (numberEdits.get(active)?.dirty || active?.classList?.contains("ui-matrix-input")) {
        active.dispatchEvent(new Event("change", { bubbles: true }));
        active.blur?.();
      }
    },
    { capture: true, signal }
  );
  // 범위가 있는 숫자 칸의 폭: 최소·최대·step 소수 자릿수로 가장 긴 값을 계산해 고정한다(슬라이더 끝과 최소·최대 표시가 어긋나지 않게).
  const rangedWidth = opts => {
    const [coefficient, exponent = "0"] = String(Number.isFinite(opts.step) ? opts.step : 1)
      .toLowerCase()
      .split("e");
    const decimals = Math.max(0, (coefficient.split(".")[1] || "").length - Number(exponent)),
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
    handle.title = "끌어서 값 조절 · Shift 정밀";
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
  // 다시 그리기 목록: 그리기 함수 → 그 조작의 바깥 요소(wrap). 목록에서 행 하나만 바꿀 때 그 행 안의 것만 잊는다(forget).
  let directionRedraws = new Map();
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
          ["+X", [1, 0, 0], "right"],
          ["−X", [-1, 0, 0], "left"],
          ["+Y", [0, 1, 0], "up"],
          ["−Y", [0, -1, 0], "down"],
          ["+Z", [0, 0, 1], "toward"],
          ["−Z", [0, 0, -1], "away"],
        ]
      : [
          ["+X", [1, 0], "right"],
          ["−X", [-1, 0], "left"],
          ["+Y", [0, 1], "up"],
          ["−Y", [0, -1], "down"],
        ];
    const presets = angleMode
      ? [0, 90, 180, 270].map((deg, index) => [`${deg}°`, deg, ["right", "up", "left", "down"][index]])
      : axes;
    for (const [text, target, icon] of presets) {
      if (hemi && target[1] < 0) continue;
      const chip = UI.iconButton({
        icon,
        size: "sm",
        className: "uniform-dir-chip",
        label: angleMode ? `${item.name}을 ${text}로` : `${item.name}을 ${text} 방향으로`,
        title: angleMode ? `${text}로 맞추기` : `${text} 방향으로 맞추기`,
      });
      chip.dataset.preset = text;
      chip.addEventListener("click", () => {
        if (angleMode) state.angle = nearestAngle(target);
        apply(chip, angleMode ? toVector() : target);
      });
      chips.append(chip);
    }
    let flip = null;
    if (sphere) {
      flip = UI.iconButton({
        icon: "hemisphere",
        size: "sm",
        className: "uniform-dir-chip uniform-dir-flip",
        label: `${item.name} 뒤쪽(-Z) 반구`,
        title: "앞·뒤 반구 전환",
      });
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
    directionRedraws.set(draw, wrap);
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
      const chip = UI.iconButton({
        icon: text === "가운데" ? "center" : "origin",
        size: "sm",
        className: "uniform-dir-chip",
        label: `${item.name}을 ${text}(${target.join(", ")})로`,
        title: `${text} (${target.join(", ")})`,
      });
      chip.dataset.preset = text;
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
    directionRedraws.set(draw, wrap);
    sync();
    // 밖에서 바뀐 값을 보여 준다(프리셋 전환 · 값 되돌리기 — 목록을 다시 그리지 않고)
    wrap.refresh = () => {
      sync();
      draw();
    };
    return wrap;
  };
  // @enum: int/uint를 이름 붙은 선택지로. 짧은 목록은 버튼 묶음(세그먼트), 길면 드롭다운. 값은 0부터의 순번.
  const enumControl = (item, commit) => {
    const labels = item.options.enum,
      current = () => liveValue(item) ?? item.value,
      segmented = labels.length <= 6 && labels.join("").length <= 24;
    const wrap = element("div");
    if (segmented) {
      wrap.className = "ui-seg uniform-enum";
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
  const RAMP_LIMIT = 16,
    RAMP_DRAG_SLOP = 3; // 정지점 손잡이: 이만큼(px) 끌어야 움직인다(타임라인 키와 같은 값)
  const rampButton = (icon, label, onClick) =>
    UI.iconButton({
      icon,
      label,
      size: "sm",
      className: `uniform-dir-chip${icon === "trash" ? " ui-icon-btn--danger" : ""}`,
      onClick,
    });
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
    track.title = "정지점 추가·이동 · Delete 삭제";
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
    const remove = rampButton("trash", `${item.name} 선택한 정지점 삭제`, () => removeStop());
    const reverse = rampButton("flip-horizontal", `${item.name} 그라데이션 좌우 뒤집기`, () => {
      for (const stop of stops) stop.t = 1 - stop.t;
      apply(reverse);
    });
    const info = element("code");
    info.className = "uniform-dir-value";
    const actions = element("div");
    actions.className = "uniform-ramp-actions";
    actions.append(remove, reverse);
    edit.append(picker, positionLabel, position, alphaLabel, alpha, actions);
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
            // 누르기만 하면 선택만 한다(손잡이가 포인터 쪽으로 튀지 않게). 3px 넘게 끌어야 움직이고,
            // 움직임은 누른 지점 기준 상대 거리라 손잡이 가운데를 정확히 누르지 않아도 위치가 바뀌지 않는다.
            handle.addEventListener("pointerdown", event => {
              if (event.button !== 0) return;
              event.preventDefault();
              handle.dataset.pointer = "";
              handle.focus({ preventScroll: true });
              handle.setPointerCapture?.(event.pointerId);
              const width = track.getBoundingClientRect().width || 1,
                startX = event.clientX,
                startT = stop.t;
              let moving = false;
              const move = next => {
                const dx = next.clientX - startX;
                if (!moving && Math.abs(dx) < RAMP_DRAG_SLOP) return;
                if (!moving) handle.classList.add("is-dragging");
                moving = true;
                selected = stop;
                stop.t = Number(clamp01(startT + dx / width).toFixed(3));
                apply(handle);
              };
              const end = () => {
                handle.removeEventListener("pointermove", move);
                handle.classList.remove("is-dragging");
              };
              handle.addEventListener("pointermove", move);
              handle.addEventListener("pointerup", end, { once: true });
              handle.addEventListener("pointercancel", end, { once: true });
            });
            handle.addEventListener("keydown", event => {
              delete handle.dataset.pointer;
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
      // 기본 동작(누른 곳으로 초점 이동)이 새 손잡이의 초점을 빼앗으면, 목록 밖 초점으로 보고 목록을 다시 그려 선택이 첫 정지점으로 돌아간다.
      event.preventDefault();
      const box = track.getBoundingClientRect(),
        t = Number(clamp01((event.clientX - box.left) / box.width).toFixed(3)),
        samples = renderer.sampleRamp(item.options, current(), 256);
      selected = { t, c: samples[Math.round(t * 255)].map(v => Number(v.toFixed(4))) };
      stops.push(selected);
      apply(track);
      const added = handles.get(selected);
      if (added) added.dataset.pointer = "";
      added?.focus?.({ preventScroll: true });
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
    directionRedraws.set(draw, wrap);
    stops = read();
    selected = stops[0];
    sync(false);
    // 밖에서 바뀐 값(프리셋 · 되돌리기)을 다시 읽어 보여 준다 — 고른 정지점 자리는 그대로
    wrap.refresh = () => sync();
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
    pad.title = "곡선 점 추가·이동 · 더블클릭 삭제";
    const edit = element("div");
    edit.className = "uniform-ramp-edit";
    const xLabel = element("label"),
      yLabel = element("label");
    xLabel.className = yLabel.className = "uniform-axis-label";
    xLabel.textContent = "X";
    yLabel.textContent = "Y";
    const xField = rampNumber(`${item.name} 선택한 점 X(0~1)`, 0, 1, 0.01),
      yField = rampNumber(`${item.name} 선택한 점 Y`, low, high, "any");
    const remove = rampButton("trash", `${item.name} 선택한 점 삭제`, () => removePoint(remove));
    const presets = [
      ["직선", "curve-linear", () => [low, high].map((y, i) => ({ x: i, y }))],
      [
        "S자",
        "curve-smooth",
        () =>
          [
            [0, 0],
            [0.3, 0.1],
            [0.7, 0.9],
            [1, 1],
          ].map(([x, y]) => ({ x, y: low + y * span })),
      ],
      ["뒤집기", "swap", () => points.map(p => ({ x: p.x, y: high + low - p.y }))],
    ].map(([text, icon, make]) =>
      rampButton(icon, `${item.name} 곡선 ${text}`, event => {
        points = make();
        selected = Math.min(selected, points.length - 1);
        apply(event.currentTarget || pad);
      })
    );
    const info = element("code");
    info.className = "uniform-dir-value";
    const actions = element("div");
    actions.className = "uniform-ramp-actions";
    actions.append(remove, ...presets);
    edit.append(xLabel, xField, yLabel, yField, actions);
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
      const grabbed = hit && hit.d <= 10;
      if (grabbed) selected = hit.i;
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
      // 기존 점을 잡았으면 누르기만으로는 움직이지 않고(3px 넘게 끌어야), 누른 지점 기준으로 옮겨 점이 포인터로 튀지 않는다.
      const startX = event.clientX,
        startY = event.clientY,
        origin = { ...points[selected] };
      let moving = !grabbed;
      const move = moveEvent => {
        if (!moving && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < RAMP_DRAG_SLOP) return;
        moving = true;
        const next = pointerToValue(moveEvent);
        if (grabbed) place(selected, origin.x + next.x - x, origin.y + next.y - y);
        else place(selected, next.x, next.y);
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
    directionRedraws.set(draw, wrap);
    curveRedraws.set(pad, draw);
    curveResizeObserver?.observe(pad);
    sync();
    wrap.refresh = () => sync(); // 밖에서 바뀐 값을 다시 읽어 보여 준다 — 고른 점 자리는 그대로
    return wrap;
  };
  listen(document, "theme-changed", () => directionRedraws.forEach((_, draw) => draw()));
  const reset = () => {
    directionRedraws = new Map();
    curveResizeObserver?.disconnect();
    curveRedraws.clear();
  };
  // 목록에서 행 하나를 버릴 때: 그 행 안의 조작만 다시 그리기 목록 · 크기 관찰에서 뺀다.
  const forget = container => {
    for (const [draw, node] of directionRedraws) if (container.contains(node)) directionRedraws.delete(draw);
    for (const pad of [...curveRedraws.keys()])
      if (container.contains(pad)) {
        curveRedraws.delete(pad);
        curveResizeObserver?.unobserve(pad);
      }
  };
  const redraw = () => {
    for (const draw of directionRedraws.keys()) draw();
  };
  return {
    parseBool,
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
    reset,
    forget,
    redraw,
  };
};

export { create };
