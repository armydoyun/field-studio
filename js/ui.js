import * as UI from "./ui-kit.js";
import * as ParameterTools from "./parameter-tools.js";
import * as ParameterControls from "./parameter-controls.js";
import * as PresetPanel from "./preset-panel.js";
import * as ParameterRow from "./parameter-row.js";
// Renderer의 공개 API만 호출하는 설정 패널. WebGL 리소스를 소유하지 않는다.
import * as StageMenu from "./stage-menu.js";
import * as Recorder from "./recorder.js";
import * as Annotations from "./annotations.js";
import * as VideoDialog from "./video-dialog.js";
import * as PreviewDOM from "./preview-dom.js";
import * as Links from "./links.js";
import * as Timeline from "./timeline.js";
import * as LinkSheet from "./link-sheet.js";
import * as Store from "./storage.js";
import * as ContextMenu from "./context-menu.js";
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
  const parameterControls = ParameterControls.create({ element, listen, signal, showError, liveValue, renderer });
  const { parseBool, displayNumber } = parameterControls;
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
  const parameterViews = [];
  let componentSerial = 0;
  // 목록을 다시 그릴지 가늠하는 요약. 연결된 파라미터의 값은 프레임마다 바뀌므로 빼고(미터 · 내비게이터가 따로 따라간다)
  // 나머지(이름 · 타입 · 설정 · 연결 없는 값)만 본다 — 그러지 않으면 0.5초마다 목록 전체를 다시 그려 누르기 · 끌기가 끊긴다.
  const snapshotOf = items => {
    const linked = new Set((settings.getLinks?.() || []).map(link => link.name));
    return JSON.stringify(items.map(item => (linked.has(item.name) ? { ...item, value: null } : item)));
  };
  // 셰이더 주석(@default·@range…)에서 읽은 파라미터 기본값. 코드에 어노테이션이 없는 파라미터는 되돌릴 값이 없다.
  const annotatedDefaults = () => {
    // 초기 복원 중에도 편집기 전역은 아직 없을 수 있다. 실행에 적용된 소스를 읽는다.
    const specs = Annotations.collect([
      renderer.getFragmentSource(),
      renderer.getCommon?.(),
      ...(renderer.getPassDefinitions?.() || []).map(pass => pass.fragment),
    ]);
    return new Map(specs.filter(spec => !spec.error).map(spec => [spec.name, spec]));
  };
  const sameValue = (a, b) =>
    Array.isArray(a)
      ? Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
      : typeof a === "number" && typeof b === "number"
        ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))
        : a === b;
  const formatDefault = value =>
    (Array.isArray(value) ? value : [value])
      .map(v => (typeof v === "number" ? displayNumber(v) : String(v)))
      .join(", ");
  let changedOnly = false,
    changedSnapshot = "",
    comparison = null,
    viewingA = false,
    varyingParameters = false;
  const changeSyncs = new Map();
  const comparisonKey = () =>
    JSON.stringify([
      renderer.getFragmentSource(),
      renderer.getCommon?.(),
      renderer.getPassDefinitions?.(),
      renderer.getImageChannels?.(),
      renderer.getUserUniforms().map(({ name, type, options }) => ({ name, type, options })),
      settings.getLinks?.() || [],
    ]);
  // 바꾸기 전과 비교(A/B): 무작위 · 조금씩 · 프리셋 적용 직전 값(또는 ⋯ 메뉴로 기억한 값)을 '이전'으로 들고 있다가,
  // 비교 바의 버튼을 누르고 있는 동안만 이전 값으로 화면을 그린다(저장 · 편집되는 값은 언제나 지금 값).
  // 무작위 · 프리셋 적용 직전 값을 자동으로 기억해 비교 바를 띄울지(⋯ 메뉴에서 켜고 끈다, 기본은 끔).
  // 켜 두지 않으면 비교 바는 ⋯의 '지금 값을 비교 기준으로 기억'으로만 나타난다 — 프리셋만 바꿨는데 바가 생겨 화면이 밀리지 않게.
  const AUTO_COMPARE_KEY = "field.compare.auto.v1";
  let autoCompare = Store.read(AUTO_COMPARE_KEY) === "1";
  const endComparison = () => {
    if (renderer.isUniformPreviewActive?.()) renderer.setUniformPreview(null);
    comparison = null;
    viewingA = false;
  };
  const pauseParameterMotion = () => {
    stopMorph();
    playing.clear();
    syncPlayButtons();
  };
  const captureComparison = () => {
    pauseParameterMotion();
    if (viewingA) renderer.setUniformPreview(null);
    viewingA = false;
    const linked = new Set((settings.getLinks?.() || []).map(item => item.name));
    comparison = { key: comparisonKey(), items: renderer.getUserUniforms().filter(item => !linked.has(item.name)) };
    if (!comparison.items.length) endComparison();
  };
  const syncComparison = () => {
    if (!$("parameterCompare")) return;
    if (comparison && (comparison.key !== comparisonKey() || (viewingA && !renderer.isUniformPreviewActive?.())))
      endComparison();
    const users = renderer.getUserUniforms(),
      difference = comparison
        ? comparison.items.filter(
            before => !ParameterTools.equalValue(before.value, users.find(item => item.name === before.name)?.value)
          ).length
        : 0;
    $("parameterCompare").hidden = !comparison;
    $("compareA").disabled = !comparison || (!difference && !viewingA);
    $("compareA").setAttribute("aria-pressed", String(viewingA));
    $("compareApply").disabled = !difference || viewingA;
    // 문구는 짧게 한 줄로(CSS가 넘치면 말줄임): 길이가 바뀌어 줄이 늘면 아래 목록이 통째로 밀린다. 자세한 설명은 툴팁.
    if (comparison) {
      setText("compareNotice", viewingA ? "이전 값 보는 중" : difference ? `${difference}개 다름` : "아직 같음");
      $("compareNotice").title = viewingA
        ? "바꾸기 전 값으로 그리는 중 · 손을 떼면 지금 값"
        : difference
          ? `지금 값과 바꾸기 전 값이 ${difference}개 다릅니다`
          : "아직 바꾸기 전과 같습니다 · 값을 바꾸면 비교할 수 있습니다";
    }
    $("comparePreviewNotice").hidden = !viewingA;
    for (const id of ["uniformList", "uniformEditor", "presetBar"]) {
      $(id).inert = viewingA;
      $(id).setAttribute("aria-disabled", String(viewingA));
    }
    for (const id of ["uniformVary", "uniformMore"]) $(id).disabled = viewingA;
  };
  const syncChanges = (items = renderer.getUserUniforms(), defaults = annotatedDefaults()) => {
    const changed = items.filter(item => ParameterTools.changedFromDefault(item, defaults.get(item.name)));
    setText("uniformChangedCount", String(changed.length));
    for (const item of items) changeSyncs.get(item.name)?.(item.value);
    return changed.map(item => item.name).join();
  };
  listen($("uniformChangedOnly"), "click", () => {
    changedOnly = !changedOnly;
    $("uniformChangedOnly").setAttribute("aria-pressed", String(changedOnly));
    renderUniforms();
  });
  // 누르고 있는 동안만 이전 값(A)을 보여 준다: 포인터는 누르기 ~ 떼기, 키보드는 Space · Enter를 누르고 있는 동안.
  const showBefore = () =>
    attempt(() => {
      syncComparison();
      if (!comparison || viewingA || $("compareA").disabled) return;
      pauseParameterMotion();
      closePresetMenu();
      renderer.setUniformPreview(comparison.items);
      viewingA = true;
      syncComparison();
    });
  const showCurrent = () => {
    if (!viewingA) return;
    attempt(() => {
      renderer.setUniformPreview(null);
      viewingA = false;
      syncComparison();
    });
  };
  listen($("compareA"), "pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault(); // 누르는 동안 글자 선택 · 초점 테두리가 생기지 않게
    $("compareA").setPointerCapture?.(event.pointerId);
    showBefore();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture", "blur"])
    listen($("compareA"), type, showCurrent);
  listen($("compareA"), "contextmenu", event => event.preventDefault());
  listen($("compareA"), "keydown", event => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) showBefore();
  });
  listen($("compareA"), "keyup", event => {
    if (event.key === " " || event.key === "Enter") showCurrent();
  });
  listen($("compareClear"), "click", () =>
    attempt(() => {
      endComparison();
      renderUniforms();
      $("uniformChangedOnly").focus({ preventScroll: true });
    })
  );
  listen($("compareApply"), "click", () =>
    attempt(() => {
      syncComparison();
      if (!comparison || viewingA) return;
      const items = comparison.items;
      endComparison();
      window.shaderStudio?.setParameterValues(items);
      renderUniforms();
      $("uniformNotice").textContent = "바꾸기 전 값으로 되돌렸습니다 · Ctrl+Z로 다시 지금 값";
      $("uniformVary").focus({ preventScroll: true });
    })
  );
  // @anim 재생: 범위를 코사인으로 왕복(@angle이면 한 바퀴씩 계속 돈다). 지금 값에서 위쪽으로 출발한다.
  // int/uint는 한 칸씩 일정한 속도로 왕복(끝에 오래 머물지 않게 삼각파), @enum은 선택지마다 주기만큼 머물며 다음으로 넘어간다.
  // 값은 렌더러에 바로 쓰고, 화면은 행이 등록한 refresh로 맞춘다. 사용자가 값을 직접 바꾸면 그 파라미터는 멈춘다.
  const playing = new Map(),
    playViews = new Map(),
    playButtons = new Map(),
    // 행의 기본값 복원(기본값으로 되돌리기) 버튼 상태 갱신. 재생은 commit을 거치지 않으므로 여기로 직접 알린다.
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
      changeSyncs.get(name)?.(value);
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
    renderer.setUniformPreview?.(null);
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
  // Locks affect exploratory batch changes only; presets and direct edits still work.
  const lockedParameters = new Set();
  const writeDefaults = names => {
    if (viewingA) return;
    stopMorph();
    const changed = window.shaderStudio?.writeParameterDefaults(names);
    if (changed) {
      renderUniforms();
      $("uniformNotice").textContent = "현재 값을 코드의 @default에 반영했습니다 · Ctrl+Z로 되돌리기";
    } else $("uniformNotice").textContent = "반영할 변경이 없습니다. GLSL 선언을 확인하세요.";
  };
  const writeChangedDefaults = () => {
    const defaults = annotatedDefaults();
    writeDefaults(
      renderer
        .getUserUniforms()
        .filter(item => {
          const spec = defaults.get(item.name);
          return ParameterTools.changedFromDefault(item, spec);
        })
        .map(item => item.name)
    );
  };
  const varyParameters = jitter => {
    if (viewingA) return;
    stopMorph();
    const hidden = new Set(conditionHidden(renderer.getUserUniforms(), annotatedDefaults())),
      items = renderer
        .getUserUniforms()
        .filter(
          item =>
            !lockedParameters.has(item.name) &&
            !hidden.has(item.name) &&
            !linkOf(item.name) &&
            ParameterTools.canVary(item)
        );
    for (const item of items) playing.delete(item.name);
    syncPlayButtons();
    attempt(() => {
      if (items.length && !comparison && autoCompare) captureComparison();
      varyingParameters = true;
      try {
        window.shaderStudio?.setParameterValues(
          items.map(item => ({
            ...item,
            value: ParameterTools.varyValue(item, jitter),
          }))
        );
      } finally {
        varyingParameters = false;
      }
      renderUniforms();
      $("uniformNotice").textContent =
        `${items.length}개 ${jitter ? "조금씩 바꿈" : "무작위 변경"} · 잠금·숨김·연결·램프 제외 · Ctrl+Z로 되돌리기`;
    });
  };
  // 상단 도구막대: [변경만 보기] …… [무작위 ▾] [⋯]. 자주 쓰지 않는 일괄 작업은 메뉴로 접어 둔다.
  listen($("uniformVary"), "click", () =>
    UI.menu({
      anchor: $("uniformVary"),
      label: "값 바꿔 보기",
      align: "end",
      items: [
        {
          id: "uniformRandomize",
          icon: "dice",
          label: "전체 무작위",
          title: "잠기지 않은 값을 범위 안에서 무작위로 · 잠금 · 숨김 · 연결 · 램프 제외",
          onSelect: () => varyParameters(false),
        },
        {
          id: "uniformJitter",
          label: "조금씩 바꾸기",
          title: "지금 값 주변으로 조금씩 바꾸기",
          onSelect: () => varyParameters(true),
        },
      ],
    })
  );
  // ---- 우클릭 메뉴(context-menu.js) ----
  // 파라미터 줄: 줄에 있는 버튼(되돌리기 · 코드 반영 · 잠금 · 재생 · 연결 · 크게 편집 · 삭제)을 그대로 누르고, 이름 · 값 복사를 더한다.
  const copyText = text =>
    navigator.clipboard
      ?.writeText(text)
      .catch(() => showError("클립보드에 복사하지 못했습니다. 브라우저 권한을 확인하세요."));
  const rowButton = (row, selector, label, extra = {}) => {
    const node = row.querySelector(selector);
    if (!node || node.closest("[hidden]")) return null;
    return {
      label,
      disabled: node.disabled || viewingA,
      onSelect: () => node.click(),
      ...extra,
    };
  };
  ContextMenu.register(
    "#uniformList .uniform-row[data-name]",
    row => {
      const item = renderer.getUserUniforms().find(user => user.name === row.dataset.name);
      if (!item) return null;
      const literal = ParameterTools.glslLiteral(item),
        lock = row.querySelector(".lock-uniform"),
        play = row.querySelector(".play-uniform"),
        link = row.querySelector(".link-uniform");
      return {
        label: `${item.name} 파라미터`,
        items: [
          { title: `${item.name} · ${item.type}` },
          rowButton(row, ".reset-uniform", "기본값으로 되돌리기", { icon: "reset" }),
          rowButton(row, ".write-default-uniform", "지금 값을 코드 기본값으로", { icon: "down" }),
          rowButton(row, ".value-edit-open", "값 크게 편집", { icon: "expand" }),
          { separator: true },
          rowButton(row, ".lock-uniform", "잠금(무작위에서 제외)", {
            pressed: lock?.getAttribute("aria-pressed") === "true",
          }),
          rowButton(row, ".seed-uniform", "새 시드", { icon: "dice" }),
          rowButton(row, ".play-uniform", playing.has(item.name) ? "자동 재생 멈추기" : "자동 재생(@anim)", {
            icon: playing.has(item.name) ? "pause" : "play",
            pressed: play ? playing.has(item.name) : undefined,
          }),
          rowButton(row, ".link-uniform", "연결 설정…", {
            icon: "link",
            pressed: link?.getAttribute("aria-pressed") === "true",
          }),
          { separator: true },
          { label: "이름 복사", icon: "copy", onSelect: () => copyText(item.name) },
          literal && {
            label: "값을 GLSL로 복사",
            title: literal,
            icon: "copy",
            onSelect: () => copyText(literal),
          },
          { separator: true },
          rowButton(row, ".remove-uniform", "파라미터 삭제", { icon: "trash", danger: true }),
        ],
      };
    },
    { signal }
  );
  // 파라미터 탭의 빈 곳: 상단 도구막대와 같은 일괄 작업
  ContextMenu.register(
    "#view-uniforms",
    (node, event) => {
      if (event.target.closest("#presetBar,#uniformEditor form")) return null;
      const users = renderer.getUserUniforms(),
        defaults = annotatedDefaults(),
        changed = users.filter(item => ParameterTools.changedFromDefault(item, defaults.get(item.name))).length;
      return {
        label: "파라미터",
        items: [
          {
            label: "파라미터 추가…",
            icon: "plus",
            disabled: viewingA,
            onSelect: () => {
              $("uniformEditor").open = true;
              $("uniformEditor").scrollIntoView?.({ block: "nearest" });
            },
          },
          { label: "변경만 보기", pressed: changedOnly, onSelect: () => $("uniformChangedOnly").click() },
          { separator: true },
          {
            label: "전체 무작위",
            icon: "dice",
            disabled: viewingA || !users.length,
            onSelect: () => varyParameters(false),
          },
          { label: "조금씩 바꾸기", disabled: viewingA || !users.length, onSelect: () => varyParameters(true) },
          {
            label: changed ? `바뀐 값 ${changed}개 코드에 반영` : "바뀐 값 모두 코드에 반영",
            icon: "down",
            disabled: viewingA || !changed,
            onSelect: writeChangedDefaults,
          },
          { separator: true },
          {
            label: "지금 값을 프리셋으로 저장",
            icon: "plus",
            disabled: viewingA || $("presetSave").disabled || !users.length,
            onSelect: () => $("presetSave").click(),
          },
        ],
      };
    },
    { signal }
  );
  listen($("uniformMore"), "click", () => {
    const defaults = annotatedDefaults(),
      users = renderer.getUserUniforms(),
      changed = users.filter(item => ParameterTools.changedFromDefault(item, defaults.get(item.name))).length,
      linked = new Set((settings.getLinks?.() || []).map(link => link.name));
    UI.menu({
      anchor: $("uniformMore"),
      label: "파라미터 작업",
      align: "end",
      items: [
        {
          id: "uniformWriteDefaults",
          icon: "down",
          label: changed ? `바뀐 값 ${changed}개 코드에 반영` : "바뀐 값 모두 코드에 반영",
          title: "지금 값을 코드의 @default에 써서 기본값으로 삼기 · Ctrl+Z로 되돌리기",
          disabled: !changed,
          onSelect: writeChangedDefaults,
        },
        {
          id: "compareCapture",
          icon: "pin",
          label: comparison ? "지금 값을 비교 기준으로 다시 기억" : "지금 값을 비교 기준으로 기억",
          title: "지금 값을 기억해 두고, 값을 바꾼 뒤 '누르는 동안 이전 보기'로 비교하기",
          disabled: !users.some(item => !linked.has(item.name)),
          onSelect: () =>
            attempt(() => {
              captureComparison();
              renderUniforms();
            }),
        },
        {
          id: "compareAuto",
          label: "무작위 · 프리셋 뒤 자동으로 비교",
          title: "켜면 무작위 · 프리셋을 적용하기 직전 값을 기억해 '바꾸기 전과 비교' 바를 띄웁니다",
          pressed: autoCompare,
          onSelect: () => {
            autoCompare = !autoCompare;
            Store.write(AUTO_COMPARE_KEY, autoCompare ? "1" : "0");
          },
        },
      ],
    });
  });
  // @group 접힘 상태(이 화면에서만 기억).
  const collapsedGroups = new Set();
  // ---- 파라미터 프리셋(preset-panel.js) ----
  const { presetNotice, clearPresetReport, closePresetMenu, stopMorph, renderPresets } = PresetPanel.create({
    $,
    element,
    listen,
    signal,
    attempt,
    setText,
    renderer,
    settings,
    sameValue,
    changeSyncs,
    playViews,
    resetSyncs,
    comparisonKey,
    captureComparison,
    playing,
    syncPlayButtons,
    renderUniforms: () => renderUniforms(), // 아래에서 정의된다 — 부를 때 찾는다
    displayNumber,
    get comparison() {
      return comparison;
    },
    get viewingA() {
      return viewingA;
    },
    get autoCompare() {
      return autoCompare;
    },
    syncSnapshot: () => {
      uniformSnapshot = snapshotOf(renderer.getUserUniforms());
    },
  });
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
  const openTimeline = (name, options) => timeline.open(name, options);
  // 편집기를 열고 입력 채널 줄(iChannel0–3)을 펼친다 — 소리 연결에 오디오가 없을 때의 바로가기
  const openInputs = () => {
    window.shaderStudio?.open?.();
    if ($("studioInputsToggle")?.getAttribute("aria-expanded") !== "true") $("studioInputsToggle")?.click();
    $("studioInputs")?.querySelector("button")?.focus();
  };
  // ---- 키프레임 정밀 입력: 키프레임 연결 줄의 내비게이터(이전 키·키 설정·다음 키 · 재생 위치) · 자동 키 ----
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
  const heldNav = new WeakMap(); // 파라미터 줄 → 연결 시트 안으로 옮겨 둘 키프레임 내비게이터
  const keyNav = (item, link) => {
    const nav = element("div"),
      prev = element("button"),
      key = element("button"),
      next = element("button"),
      time = element("input"),
      hint = element("span");
    nav.className = "key-nav";
    for (const [button, label, icon] of [
      [prev, "이전 키로", "previous-key"],
      [key, "이 시간에 키", "keyframe"],
      [next, "다음 키로", "next-key"],
    ]) {
      button.type = "button";
      button.className = `ui-btn--sm key-nav-button glyph-icon icon-${icon}`;
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
    time.title = "재생 위치(uTime, 초)";
    hint.className = "key-nav-hint";
    hint.textContent = "값을 바꾸면 이 시간에 키";
    const current = () => linkOf(item.name) || link,
      keys = () => current().keys;
    const at = t => keys().findIndex(([k]) => Math.abs(k - t) < KEY_EPSILON);
    // 이전 키 재생는 이 바퀴 안에서 움직인다(반복이 있으면 바퀴 시작 + 키 시간)
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
    // 시간 기준 표시: '한 번'(키 시간 = 재생 시간) · '반복 N초'(재생 시간을 N초로 잘라 되풀이). 반복이면 바퀴 안 시간을 따로 보인다.
    const mode = element("span"),
      inner = element("span");
    mode.className = "ui-tag key-nav-mode";
    inner.className = "key-nav-local";
    // 한 줄: [한 번 | 반복 N초] 이전 키·키 설정·다음 키 [재생 위치] 초 — 둘째 줄(설명): (바퀴 안 X초 ·) 값을 바꾸면 … 키
    const caption = element("div");
    caption.className = "key-nav-caption";
    caption.append(mode, inner, hint);
    const timeLabel = element("label");
    timeLabel.className = "key-nav-time-label";
    timeLabel.textContent = "재생";
    timeLabel.title = "재생 위치(uTime, 초)";
    timeLabel.append(time);
    // 첫 줄: 이전 키·키 설정·다음 키 · 재생 [초] — 둘째 줄: [한 번 | 반복 N초] (바퀴 안 X초) · 값을 바꾸면 … 키
    const group = element("span");
    group.className = "ui-btn-group";
    group.append(prev, key, next);
    nav.append(group, timeLabel, caption);
    let shownLoop = null;
    const update = () => {
      const now = renderer.getStats().time ?? 0,
        t = loopTime(current(), Number(now.toFixed(3))).local,
        here = at(t) >= 0,
        list = keys();
      key.setAttribute("aria-pressed", String(here));
      key.classList.toggle("icon-keyframe", !here);
      key.classList.toggle("icon-keyframe-filled", here);
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
        mode.textContent = loop ? `${Number(loop.toFixed(2))}초` : "한 번";
        mode.classList.toggle("glyph-icon", !!loop);
        mode.classList.toggle("icon-loop", !!loop);
        mode.title = loop ? `${Number(loop.toFixed(2))}초 반복` : "한 번 재생 · 마지막 값 유지";
        mode.classList.toggle("is-loop", !!loop);
        inner.hidden = !loop;
        hint.textContent = "자동 키";
        hint.title = loop ? "반복 안 현재 시간에 기록" : "현재 재생 시간에 기록";
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
      openInputs,
    });
    watchLink(item.name, view.update);
    return view.node;
  };
  // 다시 그려도 편집 칸 안의 초점은 같은 자리(같은 파라미터의 n번째 조작)로 돌려 둔다.
  listen(document, "shader-links-changed", () => {
    const active = document.activeElement,
      // 연결 시트 안이면 시트 기준, 아니면 파라미터 줄(키 설정 · 슬라이더 …) 기준으로 같은 자리를 찾는다
      box = active instanceof Element ? active.closest(".link-editor, .uniform-row") : null,
      selector = box?.classList.contains("link-editor") ? ".link-editor" : ".uniform-row",
      controls = node => [...node.querySelectorAll("select,input,button")],
      index = box ? controls(box).indexOf(active) : -1,
      name = box?.dataset.name;
    // 화면 고정: 다시 그리면 줄 위쪽에 칸이 생기거나 사라질 수 있다(키프레임을 고르면 이전 키·키 설정·다음 키 줄이 생김).
    // 누른 칸(없으면 열린 연결 시트)이 화면에서 같은 자리에 머물도록 다시 그린 뒤 스크롤을 그만큼 옮긴다.
    const scroller = $("panel")?.querySelector?.(".panel-scroll"),
      sheetName = document.querySelector(".link-editor")?.dataset?.name,
      anchorBefore = (box ? active : document.querySelector(".link-editor"))?.getBoundingClientRect?.().top;
    const keepAnchor = node => {
      const after = node?.getBoundingClientRect?.().top;
      if (scroller && Number.isFinite(anchorBefore) && Number.isFinite(after) && Math.abs(after - anchorBefore) > 0.5)
        scroller.scrollTop += after - anchorBefore;
    };
    renderUniforms();
    if (!box) {
      keepAnchor([...$("uniformList").querySelectorAll(".link-editor")].find(node => node.dataset.name === sheetName));
      return;
    }
    const next = [...$("uniformList").querySelectorAll(selector)].find(node => node.dataset.name === name);
    if (!next) return;
    // 라디오(소스 · 모양 …)를 눌렀으면 같은 묶음의 고른 칸으로
    const group = active.closest?.('[role="radiogroup"]'),
      groups = [...box.querySelectorAll('[role="radiogroup"]')].indexOf(group),
      picked = group && next.querySelectorAll('[role="radiogroup"]')[groups]?.querySelector('[aria-checked="true"]'),
      target = picked || controls(next)[index] || controls(next)[0];
    target?.focus({ preventScroll: true });
    keepAnchor(target);
  });
  // @if: 조건이 거짓인 파라미터 이름(검색 중에는 숨기지 않는다). 값이 바뀌어 이 목록이 달라지면 다시 그린다.
  let hiddenKey = "",
    hiddenDisclosureKey = "";
  // 목록 안에서 포인터를 누르고 있는 동안(슬라이더 · 패드 끌기)에는 @if로 인한 다시 그리기를 미뤘다가 놓을 때 한다.
  // 놓은 직후의 change(되돌리기 기록 등)가 먼저 끝나도록 다음 작업으로 넘긴다.
  let listPointer = false,
    conditionRedraw = null;
  listen($("uniformList"), "pointerdown", () => (listPointer = true));
  const releaseListPointer = () => {
    if (!listPointer) return;
    listPointer = false;
    const redraw = conditionRedraw;
    conditionRedraw = null;
    if (redraw) setTimeout(redraw);
  };
  listen(window, "pointerup", releaseListPointer);
  listen(window, "pointercancel", releaseListPointer);
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
  // 파라미터 행 하나를 만든다. 행이 쓰는 등록표(playViews · resetSyncs · changeSyncs · playButtons · liveLinks ·
  // parameterViews · 패드 다시 그리기)는 이름(배열은 이름[i])으로 남고, 행을 버릴 때 dropRow가 그 행 것만 지운다.
  // item은 이 행이 계속 붙잡는 객체다 — 행을 남겨 둔 채 값이 바뀌면 renderUniforms가 같은 객체를 새 값으로 고친다.
  // 행 만들기는 parameter-row.js. 모든 항목을 getter로 넘겨, 아래에서 정의되는 함수도 부를 때 찾는다.
  const buildRow = ParameterRow.create({
    ...parameterControls, // 컨트롤 만들기(parameter-controls.js)는 위에서 이미 만들어졌다
    renderer,
    get $() {
      return $;
    },
    get element() {
      return element;
    },
    get showError() {
      return showError;
    },
    get attempt() {
      return attempt;
    },
    get typeInfo() {
      return typeInfo;
    },
    get liveValue() {
      return liveValue;
    },
    get parseValue() {
      return parseValue;
    },
    get parameterViews() {
      return parameterViews;
    },
    get annotatedDefaults() {
      return annotatedDefaults;
    },
    get formatDefault() {
      return formatDefault;
    },
    get changeSyncs() {
      return changeSyncs;
    },
    get syncChanges() {
      return syncChanges;
    },
    get playing() {
      return playing;
    },
    get playViews() {
      return playViews;
    },
    get playButtons() {
      return playButtons;
    },
    // 행이 보여 주는 값을 목록에 알린다(값 = 그 값, undefined = 다음 renderUniforms에서 반드시 다시 맞춤)
    rowShows: (name, value) => {
      const entry = rowCache.get(name);
      if (entry) entry.value = value === undefined ? null : JSON.stringify(value);
    },
    get resetSyncs() {
      return resetSyncs;
    },
    get syncPlayButtons() {
      return syncPlayButtons;
    },
    get togglePlay() {
      return togglePlay;
    },
    get randomValue() {
      return randomValue;
    },
    get lockedParameters() {
      return lockedParameters;
    },
    get writeDefaults() {
      return writeDefaults;
    },
    get stopMorph() {
      return stopMorph;
    },
    get linkOf() {
      return linkOf;
    },
    get watchLink() {
      return watchLink;
    },
    get pendingKeys() {
      return pendingKeys;
    },
    get flushKeys() {
      return flushKeys;
    },
    get recordKey() {
      return recordKey;
    },
    get heldNav() {
      return heldNav;
    },
    get keyNav() {
      return keyNav;
    },
    get linkEditor() {
      return linkEditor;
    },
    get conditionHidden() {
      return conditionHidden;
    },
    get renderUniforms() {
      return renderUniforms;
    },
    get deletedUniform() {
      return deletedUniform;
    },
    set deletedUniform(value) {
      deletedUniform = value;
    },
    get openLink() {
      return openLink;
    },
    set openLink(value) {
      openLink = value;
    },
    get keyPointer() {
      return keyPointer;
    },
    set keyPointer(value) {
      keyPointer = value;
    },
    get conditionRedraw() {
      return conditionRedraw;
    },
    set conditionRedraw(value) {
      conditionRedraw = value;
    },
    get componentSerial() {
      return componentSerial;
    },
    set componentSerial(value) {
      componentSerial = value;
    },
    get viewingA() {
      return viewingA;
    },
    get hiddenKey() {
      return hiddenKey;
    },
    get listPointer() {
      return listPointer;
    },
  });
  // 파라미터 목록 맞추기. 행마다 '구조 열쇠'(타입 · 설정 · 코드 주석 · 연결 · 열린 시트 · 잠금)를 기억해,
  //  · 열쇠가 같은 행은 남기고 값만 행의 갱신 함수(playViews)로 보여 준다. 갱신 함수가 없는 종류(그라데이션 · 곡선 · 배열)는 그 행만 다시 만든다.
  //  · 열쇠가 바뀐 행 · 새 파라미터만 새로 만들고, 지운 파라미터의 행은 버린다.
  //  · 검색 · 변경만 보기 · @if로 걸러진 행은 떼어 두기만 하고(다시 보이면 그대로 쓴다) 새로 만들지 않는다.
  //  · 순서가 그대로면 DOM을 옮기지 않는다(옮기면 초점 · 누르고 있던 조작이 풀린다).
  // 이전에는 무엇이 바뀌든 목록 전체를 새로 만들어, 깜빡이고 눌러 둔 곳을 잃고, 검색 한 글자마다 수십 개 행을 다시 만들었다.
  const rowCache = new Map(); // 이름 → { row, group, key, item, value }
  const groupViews = new Map(); // 묶음 이름 → { section, head, count, body }
  const rowKey = (item, spec) =>
    JSON.stringify([
      item.type,
      item.options,
      spec ?? null,
      Links.LINKABLE.has(item.type) ? linkOf(item.name) : null,
      openLink === item.name,
      lockedParameters.has(item.name),
    ]);
  const ownedBy = (key, name) => key === name || key.startsWith(`${name}[`);
  const dropRow = name => {
    const entry = rowCache.get(name);
    if (!entry) return;
    rowCache.delete(name);
    for (const registry of [playViews, resetSyncs, changeSyncs, playButtons, liveLinks])
      for (const key of [...registry.keys()]) if (ownedBy(key, name)) registry.delete(key);
    for (const view of entry.views) {
      view.dispose();
      const at = parameterViews.indexOf(view);
      if (at >= 0) parameterViews.splice(at, 1);
    }
    parameterControls.forget(entry.row);
    entry.row.remove();
  };
  const makeRow = (item, defaults, key) => {
    const before = parameterViews.length,
      { row, group } = buildRow(item, defaults);
    const entry = { row, group, key, item, value: JSON.stringify(item.value), views: parameterViews.slice(before) };
    rowCache.set(item.name, entry);
    return entry;
  };
  // 부모의 자식을 이 순서로(이미 그 자리에 있으면 건드리지 않는다)
  const arrange = (parent, nodes) => {
    const current = [...parent.children];
    if (current.length === nodes.length && current.every((node, index) => node === nodes[index])) return;
    if (typeof parent.insertBefore !== "function") return parent.replaceChildren(...nodes); // 단순한 DOM(테스트 모의)
    nodes.forEach((node, index) => {
      if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
    });
    while (parent.children.length > nodes.length) parent.children[parent.children.length - 1].remove();
  };
  const groupView = group => {
    if (groupViews.has(group)) return groupViews.get(group);
    const section = element("section"),
      head = element("button"),
      label = element("span"),
      count = element("span"),
      body = element("div");
    head.type = "button";
    head.className = "uniform-group-head glyph-icon icon-chevron";
    label.className = "uniform-group-name";
    label.textContent = group;
    count.className = "uniform-group-count";
    head.append(label, count);
    head.addEventListener("click", () => {
      if (collapsedGroups.has(group)) collapsedGroups.delete(group);
      else collapsedGroups.add(group);
      renderUniforms();
      head.focus();
    });
    body.className = "uniform-group-body";
    section.append(head, body);
    const view = { section, head, count, body };
    groupViews.set(group, view);
    return view;
  };
  // 걸러져 아직 만들지 않은 행(검색 · @if · 변경만 보기)을 브라우저가 한가할 때 하나씩 미리 만들어 둔다 — 첫 검색에서
  // 수십 개 행을 한꺼번에 만드느라 늦던 것. 문서에 붙지 않은 채 만든 패드는 붙을 때 다시 그려진다(renderUniforms 끝의 redraw).
  let prebuildHandle = 0;
  const prebuildStep = deadline => {
    prebuildHandle = 0;
    if (signal.aborted) return;
    const defaults = annotatedDefaults();
    for (const item of renderer.getUserUniforms()) {
      if (rowCache.has(item.name)) continue;
      if (deadline.timeRemaining() < 4) return schedulePrebuild();
      makeRow(item, defaults, rowKey(item, defaults.get(item.name)));
    }
  };
  const schedulePrebuild = () => {
    if (prebuildHandle || typeof window.requestIdleCallback !== "function") return;
    prebuildHandle = window.requestIdleCallback(prebuildStep, { timeout: 3000 });
  };
  signal.addEventListener("abort", () => prebuildHandle && window.cancelIdleCallback?.(prebuildHandle));
  const renderUniforms = () => {
    const userList = $("uniformList"),
      items = renderer.getUserUniforms();
    syncComparison();
    const search = $("uniformSearch").value.trim().toLowerCase();
    uniformSnapshot = snapshotOf(items);
    const defaults = annotatedDefaults(),
      hidden = new Set(search ? [] : conditionHidden(items, defaults));
    hiddenKey = [...hidden].join();
    $("uniformCount").textContent = `${items.length} / 64`;
    renderPresets();
    $("uniformCreate").disabled = items.length >= 64;
    const names = new Set(items.map(item => item.name));
    for (const name of [...rowCache.keys()]) if (!names.has(name)) dropRow(name);
    // @group: 묶음 없는 파라미터가 먼저, 묶음은 처음 나온 순서대로. 검색 중에는 접힌 묶음도 펼쳐 보여 준다.
    const loose = [],
      groups = new Map();
    for (const item of items) {
      if (changedOnly && !ParameterTools.changedFromDefault(item, defaults.get(item.name))) continue;
      if (search && !`${item.name} ${item.type}`.toLowerCase().includes(search)) continue;
      if (hidden.has(item.name)) continue;
      const spec = defaults.get(item.name),
        key = rowKey(item, spec);
      let entry = rowCache.get(item.name);
      if (entry && entry.key === key) {
        const value = JSON.stringify(item.value);
        if (value !== entry.value) {
          Object.assign(entry.item, item); // 행의 처리기들이 붙잡은 객체를 새 값으로
          entry.value = value;
          // 연결이 정하는 값은 연결 미터 · 내비게이터가 따로 따라간다
          const refresh = playViews.get(item.name);
          if (Links.LINKABLE.has(item.type) && linkOf(item.name)) {
            // 그대로 둔다
          } else if (refresh && refresh(item.value) !== false) {
            resetSyncs.get(item.name)?.(item.value);
            changeSyncs.get(item.name)?.(item.value);
          } else {
            dropRow(item.name);
            entry = null;
          }
        }
      } else if (entry) {
        dropRow(item.name);
        entry = null;
      }
      entry ??= makeRow(item, defaults, key);
      if (!entry.group) loose.push(entry.row);
      else {
        if (!groups.has(entry.group)) groups.set(entry.group, []);
        groups.get(entry.group).push(entry.row);
      }
    }
    // 묶음 순서는 코드에 처음 나온 순서(다른 프로젝트에서 남은 파라미터의 등록 순서가 아니라).
    const codeOrder = [...new Set([...defaults.values()].map(spec => spec.group).filter(Boolean))];
    const rank = group => (codeOrder.includes(group) ? codeOrder.indexOf(group) : codeOrder.length);
    const sections = [];
    for (const [group, rows] of [...groups].sort((a, b) => rank(a[0]) - rank(b[0]))) {
      const view = groupView(group),
        open = Boolean(search) || !collapsedGroups.has(group);
      view.section.className = open ? "uniform-group" : "uniform-group is-collapsed";
      view.head.setAttribute("aria-expanded", String(open));
      view.count.textContent = String(rows.length);
      view.body.hidden = !open;
      arrange(view.body, rows);
      sections.push(view.section);
    }
    for (const [group, view] of [...groupViews])
      if (!groups.has(group)) {
        view.section.remove();
        groupViews.delete(group);
      }
    arrange(userList, [...loose, ...sections]);
    const shown = loose.length + [...groups.values()].reduce((sum, rows) => sum + rows.length, 0);
    if (shown < items.length) schedulePrebuild();
    // 방향 패드는 문서에 붙은 뒤에야 테마 색을 읽을 수 있으므로 한 번 더 그린다.
    parameterControls.redraw();
    const count = shown;
    // 고를 파라미터가 없으면 검색 칸은 쓸모가 없다(검색 중이면 지울 수 있게 남긴다)
    const searchWrap = $("uniformSearch")?.closest?.(".uniform-search-wrap");
    if (searchWrap) searchWrap.hidden = !items.length && !search;
    changedSnapshot = syncChanges(items, defaults);
    $("uniformResults").textContent =
      search || changedOnly ? `${items.length}개 중 ${count}개 표시${changedOnly ? " · 변경된 항목" : ""}` : "";
    // Keep the default panel compact. Details are bounded and names double as search shortcuts.
    const hiddenDetails = $("uniformHidden");
    hiddenDetails.hidden = !hidden.size;
    if (!hidden.size || hiddenDisclosureKey !== hiddenKey) hiddenDetails.open = false;
    if (hiddenDisclosureKey !== hiddenKey) {
      hiddenDisclosureKey = hiddenKey;
      $("uniformHiddenCount").textContent = `${hidden.size}개`;
      $("uniformHiddenList").replaceChildren(
        ...[...hidden].map(name => {
          const button = element("button");
          button.type = "button";
          button.className = "ui-chip ui-chip--pill uniform-hidden-name";
          button.textContent = name;
          button.title = `${name} 검색해서 보기`;
          button.addEventListener("click", () => {
            $("uniformSearch").value = name;
            renderUniforms();
            $("uniformSearch").focus();
          });
          return button;
        })
      );
    }
    if (!count) {
      const hint = element("div");
      hint.className = "ui-empty uniform-empty";
      hint.textContent = search
        ? "검색 결과가 없습니다. 이름이나 타입을 확인하세요."
        : changedOnly
          ? "현재 조건에서 표시할 변경된 파라미터가 없습니다. 필터를 끄거나 이름으로 검색하세요."
          : hidden.size
            ? "모든 파라미터가 조건(@if)으로 숨겨져 있습니다."
            : "아직 파라미터가 없습니다.";
      // 빈 상태에서 할 수 있는 일을 바로 누르게 한다: 예제로 시작 · 직접 추가
      if (!search && !hidden.size && !changedOnly) {
        const actions = element("div"),
          gallery = element("button"),
          add = element("button");
        actions.className = "uniform-empty-actions";
        gallery.type = add.type = "button";
        gallery.className = "ui-btn--primary ui-btn--sm";
        add.className = "ui-btn--sm";
        gallery.textContent = "예제 갤러리 열기";
        gallery.addEventListener("click", () => $("galleryToggle").click());
        add.textContent = "파라미터 추가";
        add.addEventListener("click", () => {
          $("uniformEditor").open = true;
          $("uniformEditor").scrollIntoView?.({ block: "nearest" });
        });
        actions.append(gallery, add);
        hint.append(actions);
      }
      userList.append(hint);
    }
  };
  listen($("undoUniform"), "click", () =>
    attempt(() => {
      if (!deletedUniform) return;
      const { name, type, value, options, broke, viaCode } = deletedUniform;
      // 선언 줄까지 지웠으면 편집 기록으로 되돌린다(코드 · 파라미터를 함께)
      if (viaCode) {
        clearDeleted();
        window.shaderStudio?.undo?.();
        renderUniforms();
        focusSearch();
        return;
      }
      renderer.defineUniform(name, type, value, options);
      clearDeleted();
      // 지워서 생긴 컴파일 오류였으면, 되살린 뒤 다시 적용해 편집기의 오류 표시를 거둔다.
      if (broke) window.shaderStudio?.apply?.();
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
      help: "RGB·알파: 0~1",
    },
    {
      value: "hdr",
      label: "HDR 색상 (색 + 밝기 배율)",
      types: ["vec3", "vec4"],
      help: "RGB 밝기: 0~10 · 알파: 0~1",
    },
    {
      value: "dir",
      label: "단위 방향 (다이얼·구 패드)",
      types: ["vec2", "vec3"],
      help: "0이 아닌 방향 벡터",
    },
    {
      value: "angle",
      label: "각도 다이얼 (라디안)",
      types: ["float"],
      help: "입력 단위: 라디안",
    },
    {
      value: "pos",
      label: "2D 패드 (위치)",
      types: ["vec2"],
      help: "기본 범위: -1~1",
    },
    {
      value: "log",
      label: "로그 눈금 슬라이더",
      types: ["float"],
      help: "0 < Min < Max",
    },
    {
      value: "enum",
      label: "선택지 (이름 붙은 버튼)",
      types: ["int", "uint"],
      help: "첫 선택지의 값은 0",
    },
    {
      value: "gradient",
      label: "그라데이션 (색 램프)",
      types: ["sampler2D"],
      help: "색 정지점",
    },
    {
      value: "curve",
      label: "곡선 (값 램프)",
      types: ["sampler2D"],
      help: "X 위치의 Y 값",
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
  const typeDrafts = new Map();
  const draftFields = [
    "uniformValue",
    "uniformBoolValue",
    "uniformDisplay",
    "uniformEnumLabels",
    "uniformMin",
    "uniformMax",
    "uniformStep",
  ];
  let draftType = null;
  const updateTypeFields = () => {
    const t = $("uniformType").value,
      bool = t === "bool",
      ramp = t === "sampler2D",
      { components: size, kind } = typeInfo(t);
    if (draftType === t) {
      updateDisplayFields();
      return;
    }
    if (draftType !== null) typeDrafts.set(draftType, Object.fromEntries(draftFields.map(id => [id, $(id).value])));
    const draft = typeDrafts.get(t);
    $("uniformValue").hidden = bool || ramp;
    $("uniformValue").required = !bool && !ramp;
    $("uniformBoolValue").hidden = !bool;
    $("uniformValueHelp").textContent = ramp
      ? "기본 램프로 시작합니다."
      : bool
        ? "true / false"
        : kind === "m"
          ? `${size}개 숫자 · 열 우선 순서`
          : kind === "b"
            ? `${size}개의 true/false를 쉼표로 구분하세요.`
            : size > 1
              ? `${size}개 ${kind === "f" ? "숫자" : kind === "u" ? "0 이상 정수" : "정수"}를 쉼표로 구분하세요. 예: ${defaultValue(t)}`
              : "숫자 값 · 범위는 선택 사항";
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
    $("uniformValue").value = defaultValue(t);
    for (const id of ["uniformMin", "uniformMax", "uniformStep", "uniformEnumLabels"]) $(id).value = "";
    if (draft) for (const id of draftFields) $(id).value = draft[id];
    draftType = t;
    updateDisplayFields();
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
  // 파라미터 추가: 이름 · 타입 · 값을 검사해 등록하고(renderer.defineUniform), 그 선언 줄(어노테이션 포함)을 코드에 직접 넣는다.
  // 앱은 선언을 셰이더에 대신 넣지 않으므로, 코드에 선언이 있어야 셰이더에서 그 이름을 쓸 수 있다.
  const addParameter = (name, type, value, options) => {
    renderer.defineUniform(name, type, value, options);
    window.shaderStudio?.addParameterDeclaration?.(ParameterTools.declarationLine({ name, type, value, options }));
  };
  listen($("uniformForm"), "submit", event => {
    event.preventDefault();
    attempt(() => {
      const type = $("uniformType").value;
      if (type === "sampler2D") {
        // 램프는 기본 모양으로 만들고 패널 편집기에서 다듬는다.
        const curve = $("uniformDisplay").value === "curve";
        addParameter(
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
      addParameter($("uniformName").value.trim(), type, value, opts);
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
        fpsCustom = false;
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
  // 처음 여는 탭은 파라미터: 작품을 만지는 사람이 가장 자주 쓰는 곳(렌더링 · 성능 · 작업공간은 가끔 여는 설정).
  let activeTab = "uniforms";
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
  // 프레임 제한: 빠른 선택(Auto · 30 · 60 · 120)이 기본, 그 밖의 값은 '직접'을 눌러 입력한다.
  // 목록에 없는 값이면 '직접'이 눌린 채 입력 칸이 보인다.
  let fpsCustom = false;
  const syncFpsPresets = fps => {
    let matched = false;
    for (const button of document.querySelectorAll("[data-fps-preset]")) {
      const active = !fpsCustom && Number(button.dataset.fpsPreset) === fps;
      matched ||= Number(button.dataset.fpsPreset) === fps;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    }
    const custom = fpsCustom || !matched,
      toggle = document.querySelector("[data-fps-custom]"),
      field = $("fpsLimit")?.closest?.(".fps-control");
    toggle?.classList.toggle("is-selected", custom);
    toggle?.setAttribute("aria-pressed", String(custom));
    if (field) field.hidden = !custom;
  };
  const fpsCustomButton = document.querySelector("[data-fps-custom]");
  if (fpsCustomButton)
    listen(fpsCustomButton, "click", () => {
      fpsCustom = true;
      syncFpsPresets(renderer.getStats().fpsLimit);
      $("fpsLimit").focus();
      $("fpsLimit").select?.();
    });
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
  // ---- 뷰포트 툴바 메뉴: 캡처 펼치기 · ⋯ 더보기 (stage-menu.js) ----
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
  // 도구 막대의 카메라 = 한 번에 스크린샷(PNG). 고해상도 · 영상 · 녹화는 옆의 캡처 메뉴 메뉴.
  if ($("quickShot")) listen($("quickShot"), "click", () => $("screenshotButton").click());
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
  // 미리보기 통계: 평소에는 FPS 한 칸만(작품을 덜 가리게), 누르면 해상도 · 시간 · 프레임 · GPU까지 펼친다. 고른 상태는 기억한다.
  {
    const STATS_KEY = "field.hud.stats.v1",
      stats = $("stats");
    const setStatsOpen = open => {
      stats.dataset.expanded = String(open);
      stats.setAttribute("aria-expanded", String(open));
      stats.title = open ? "누르면 FPS만 보기" : "누르면 해상도 · 시간 · 프레임 · GPU까지 보기";
    };
    if (stats?.setAttribute) {
      stats.setAttribute("role", "button");
      stats.tabIndex = 0;
      stats.setAttribute("aria-label", "미리보기 통계 펼치기/접기");
      setStatsOpen(Store.read(STATS_KEY) === "1");
      const flip = () => {
        const open = stats.dataset.expanded !== "true";
        setStatsOpen(open);
        Store.write(STATS_KEY, open ? "1" : "0");
      };
      listen(stats, "click", flip);
      listen(stats, "keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        flip();
      });
    }
  }
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
    if (
      event.target instanceof Element &&
      event.target.closest("input, textarea, select, .ui-select, [contenteditable]")
    )
      return;
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
    syncComparison();
    const changedKey = syncChanges();
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
    for (const view of parameterViews) view.refresh();
    if (
      !parameterViews.some(view => view.isOpen) &&
      !$("view-uniforms").hidden &&
      !(active instanceof Element && active.closest("#uniformList")) &&
      (uniformSnapshot !== snapshotOf(renderer.getUserUniforms()) || (changedOnly && changedSnapshot !== changedKey))
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
    if ($("viewportInfo")?.dataset) $("viewportInfo").dataset.mode = s.previewPass ? "buffer" : "image";
    const previewName = s.previewPass ? `Buffer ${s.previewPass}` : "Image";
    $("studioPreviewTarget").textContent = previewName;
    $("studioPreviewTarget").setAttribute("aria-label", `미리보기: ${previewName}`);
    syncFpsPresets(s.fpsLimit);
  };
  // @group·설명·@if·기본값은 Uniform 옵션과 별개다. 컴파일 성공 후 메타데이터만 바뀌어도 반영한다.
  listen(document, "shader-annotations-changed", renderUniforms);
  listen(document, "shader-settings-applied", () => {
    stopMorph();
    clearPresetReport();
    // 값 묶음이 다른 길(무작위 · Undo · 프로젝트)로 바뀌면 '적용 결과' 알림은 더 이상 지금 값을 말하지 않는다.
    // (프리셋 적용 자체는 이 이벤트를 내지 않는다 — beginParameterChange)
    presetNotice("");
    if (!varyingParameters) endComparison("프로젝트 또는 값 묶음이 바뀌어 비교를 끝냈습니다. 새 기준을 잡으세요.");
    clearDeleted();
    $("uniformSearch").value = "";
    renderUniforms();
    syncPanel();
    updateStats();
  });
  listen(document, "shader-links-changed", () => {
    if (comparison) {
      endComparison("파라미터 연결이 바뀌어 비교를 끝냈습니다. 새 기준을 잡으세요.");
      syncComparison();
    }
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
      for (const view of parameterViews) view.dispose();
      timeline.dispose();
      recorder.dispose(); // 창을 닫는 중에는 녹화 파일을 내려받지 않고 버린다.
      controller.abort();
    },
  };
};
export { mount };
