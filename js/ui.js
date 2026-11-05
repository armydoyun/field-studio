// Renderer의 공개 API만 호출하는 설정 패널. WebGL 리소스를 소유하지 않는다.
import * as StageMenu from "./stage-menu.js";
import * as Recorder from "./recorder.js";
const mount = (renderer, input, settings) => {
  const $ = id => document.getElementById(id);
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
  const typeInfo = type =>
    typeTable.get(type) || {
      type,
      components: Number(/^vec([234])$/.exec(type)?.[1]) || 1,
      kind: type === "bool" ? "b" : type === "int" ? "i" : "f",
    };
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
  const renderUniforms = () => {
    const userList = $("uniformList"),
      items = renderer.getUserUniforms();
    const search = $("uniformSearch").value.trim().toLowerCase();
    uniformSnapshot = JSON.stringify(items);
    userList.replaceChildren();
    $("uniformCount").textContent = `${items.length} / 64`;
    $("uniformCreate").disabled = items.length >= 64;
    for (const item of items) {
      if (search && !`${item.name} ${item.type}`.toLowerCase().includes(search)) continue;
      const row = element("div");
      row.className = "uniform-row";
      row.dataset.type = item.type;
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
      top.append(title, remove);
      const commit = (field, value) => {
        try {
          renderer.setUniform(item.name, value);
          item.value = value;
          field.removeAttribute("aria-invalid");
          showError("");
          return true;
        } catch (error) {
          field.setAttribute("aria-invalid", "true");
          showError(`${item.name}: ${error.message}`);
          return false;
        }
      };
      row.append(top);
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
        let alpha = null,
          alphaNumber = null;
        const show = values => {
          picker.value = hex(values);
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
        const current = () => [...(renderer.getUserUniforms().find(u => u.name === item.name)?.value || item.value)];
        const setRGB = (field, text) => {
          const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
          if (!match) {
            field.setAttribute("aria-invalid", "true");
            showError(`${item.name}: #RRGGBB 형식의 HEX 색을 입력하세요.`);
            return;
          }
          const values = current();
          values.splice(0, 3, ...match[1].match(/../g).map(h => parseInt(h, 16) / 255));
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
            const values = renderer.getUserUniforms().find(u => u.name === item.name)?.value;
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
            if (update(input, kind === "b" ? input.checked : input.value.trim() ? Number(input.value) : NaN) && slider)
              slider.value = input.value;
          });
          if (kind !== "b" && !dim)
            scrubbable(label, {
              kind,
              min: opts.min,
              max: opts.max,
              step: opts.step,
              read: () => renderer.getUserUniforms().find(u => u.name === item.name)?.value?.[index],
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
            slider.min = String(opts.min);
            slider.max = String(opts.max);
            slider.step = String(opts.step);
            slider.value = String(value);
            slider.setAttribute("aria-label", `${item.name} ${label.textContent} 슬라이더`);
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
          row.append(rangeEnds(opts, true));
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
            if (range) range.value = String(value);
            showNumber(number, value);
          } else showNumber(number, item.value);
        };
        number.addEventListener("change", changeNumber);
        if (ranged) {
          range = element("input");
          range.type = "range";
          range.min = String(opts.min);
          range.max = String(opts.max);
          range.step = String(opts.step);
          range.setAttribute("aria-label", `${item.name} 슬라이더`);
          range.value = String(item.value);
          range.addEventListener("input", () => {
            if (commit(range, Number(range.value))) showNumber(number, item.value);
          });
          pair.append(range);
        }
        pair.append(number);
        row.append(pair);
        if (ranged) {
          row.style.setProperty("--number-width", rangedWidth(opts));
          row.append(rangeEnds(opts, false));
        }
        scrubbable(name, {
          kind,
          min: opts.min,
          max: opts.max,
          step: opts.step,
          read: () => renderer.getUserUniforms().find(u => u.name === item.name)?.value,
          write: next => {
            if (commit(number, next)) {
              showNumber(number, next);
              if (range) range.value = String(next);
            }
          },
        });
      }
      userList.append(row);
    }
    const count = userList.children.length;
    $("uniformResults").textContent = search ? `${items.length}개 중 ${count}개 표시` : "";
    if (!count) {
      const hint = element("div");
      hint.className = "uniform-empty";
      hint.textContent = search
        ? "검색 결과가 없습니다. 이름이나 타입을 확인하세요."
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
  const updateTypeFields = () => {
    const t = $("uniformType").value,
      bool = t === "bool",
      { components: size, kind } = typeInfo(t);
    $("uniformValue").hidden = bool;
    $("uniformValue").required = !bool;
    $("uniformBoolValue").hidden = !bool;
    $("uniformValueHelp").textContent = bool
      ? "선택한 상태가 GLSL의 true/false로 전달됩니다."
      : kind === "m"
        ? `${size}개 숫자를 column-major 순서로 입력하세요. 기본값은 단위 행렬입니다.`
        : kind === "b"
          ? `${size}개의 true/false를 쉼표로 구분하세요.`
          : size > 1
            ? `${size}개 ${kind === "f" ? "숫자" : kind === "u" ? "0 이상 정수" : "정수"}를 쉼표로 구분하세요. 예: ${defaultValue(t)}`
            : "숫자를 입력하세요. 슬라이더 범위는 선택 사항입니다.";
    $("rangeFields").hidden = !["f", "i", "u"].includes(kind);
    $("uniformColorField").hidden = !["vec3", "vec4"].includes(t);
    if ($("uniformColorField").hidden) $("uniformColor").checked = false;
    $("uniformValue").value = defaultValue(t);
  };
  listen($("uniformType"), "change", updateTypeFields);
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
      const value = parseValue(type, type === "bool" ? $("uniformBoolValue").value : $("uniformValue").value);
      const min = $("uniformMin").value.trim(),
        max = $("uniformMax").value.trim(),
        step = $("uniformStep").value.trim();
      const hasBounds = ["f", "i", "u"].includes(typeInfo(type).kind) && [min, max, step].some(Boolean);
      if (hasBounds && ![min, max, step].every(Boolean))
        throw new Error("슬라이더의 Min, Max, Step을 모두 입력하세요.");
      const opts = hasBounds ? { min: Number(min), max: Number(max), step: Number(step) } : {};
      if ($("uniformColor").checked && ["vec3", "vec4"].includes(type)) opts.color = true;
      renderer.defineUniform($("uniformName").value.trim(), type, value, opts);
      clearDeleted();
      $("uniformSearch").value = "";
      renderUniforms();
      $("uniformName").value = "";
      $("uniformMin").value = $("uniformMax").value = $("uniformStep").value = "";
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
  const toggleHud = () => {
    const hidden = stage.classList.toggle("hud-hidden");
    $("hudToggle").setAttribute("aria-label", hidden ? "HUD 표시" : "HUD 숨기기");
    $("hudToggle").setAttribute("aria-pressed", String(!hidden));
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
      if (document.fullscreenElement === stage) await document.exitFullscreen();
      else await stage.requestFullscreen();
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
    })
  );
  listen($("screen"), "pointerdown", () => stage.classList.add("has-interacted"));
  listen($("screen"), "wheel", () => stage.classList.add("has-interacted"));
  listen(document, "fullscreenchange", () => {
    const active = document.fullscreenElement === stage;
    $("fullscreenToggle").setAttribute("aria-label", active ? "전체화면 종료" : "전체화면");
    $("fullscreenToggle").title = active ? "전체화면 종료 (F)" : "전체화면 (F)";
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
    } else if (key === "g") {
      event.preventDefault();
      toggleHud();
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
      uniformSnapshot !== JSON.stringify(renderer.getUserUniforms())
    )
      renderUniforms();
    $("statFps").textContent = s.fps.toFixed(1) + (s.fpsLimit ? ` / ${s.fpsLimit}` : "");
    $("statResolution").textContent = `${s.width} × ${s.height}`;
    $("statFrame").textContent = s.frame.toLocaleString("ko-KR");
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
    $("studioPreviewTarget").textContent = `미리보기 · ${s.previewPass ? `Buffer ${s.previewPass}` : "Image"}`;
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
  return {
    dispose: () => {
      clearInterval(timer);
      recorder.dispose(); // 창을 닫는 중에는 녹화 파일을 내려받지 않고 버린다.
      controller.abort();
    },
  };
};
export { mount };
