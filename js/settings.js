import * as Presets from "./presets.js";
import * as Links from "./links.js";
// localStorage 저장은 렌더러와 분리한다. WebGL 상태 대신 복원 가능한 설정만 직렬화한다.
// 브라우저 저장소가 제한될 수 있으므로 실패해도 렌더링을 중단하지 않는다.
// 저장소 키 이름은 초기 버전에서 정해졌다. 바꾸면 사용자의 저장된 설정이 사라지므로 그대로 둔다.
const KEY = "webgl.raymarch-template.settings.v1";
const mount = renderer => {
  const defaults = {
    fpsLimit: 0,
    resolutionScale: 1,
    maxPixels: 0,
    timeScale: 1,
  };
  let available = true,
    errorMessage = "",
    savedText = null,
    disposed = false;
  // 파라미터 프리셋(presets.js): 이 프로젝트의 파라미터 값 묶음. 설정과 함께 저장소 · 보관함 · Pack에 담긴다.
  let presets = [];
  const changed = () => document.dispatchEvent(new Event("shader-presets-changed"));
  const getPresets = () => presets.map(preset => ({ name: preset.name, values: { ...preset.values } }));
  const setPresets = list => {
    presets = Presets.validate(list);
    changed();
    save();
    return getPresets();
  };
  // 파라미터 연결(links.js): 렌더러가 프레임마다 적용한다. 설정과 함께 저장된다.
  const getLinks = () => renderer.getLinks?.() || [];
  const setLinks = list => {
    renderer.setLinks(Links.validate(list));
    document.dispatchEvent(new Event("shader-links-changed"));
    save();
    return getLinks();
  };
  // 파라미터 이름이 바뀌면(편집기 F2) 프리셋 값과 연결도 따라 바꾼다.
  const renameParameter = (from, to) => {
    if (presets.some(preset => Object.hasOwn(preset.values, from)))
      setPresets(
        presets.map(preset => ({
          name: preset.name,
          values: Object.fromEntries(
            Object.entries(preset.values).map(([key, value]) => [key === from ? to : key, value])
          ),
        }))
      );
    const links = getLinks();
    if (links.some(link => link.name === from))
      setLinks(links.map(link => (link.name === from ? { ...link, name: to } : link)));
  };
  const readState = () => {
    const stats = renderer.getStats();
    return {
      version: 1,
      rendering: {
        fpsLimit: stats.fpsLimit,
        resolutionScale: stats.resolutionScale,
        maxPixels: stats.maxPixels,
        timeScale: stats.timeScale,
      },
      user: renderer.getUserUniforms().map(({ name, type, value, options }) => ({ name, type, value, options })),
      presets: getPresets(),
      links: getLinks(),
      panelHidden: document.body.classList.contains("panel-hidden"),
    };
  };
  const failStorage = error => {
    available = false;
    errorMessage = `브라우저 저장소 사용 불가: ${error.message}`;
  };
  const status = () => ({
    available,
    message: available ? "렌더링·파라미터 설정 자동 저장" : errorMessage,
  });
  const save = () => {
    if (disposed || !available) return false;
    const text = JSON.stringify(readState());
    if (text === savedText) return true;
    try {
      window.localStorage.setItem(KEY, text);
      savedText = text;
      return true;
    } catch (error) {
      failStorage(error);
      return false;
    }
  };
  const load = () => {
    let raw;
    try {
      raw = window.localStorage.getItem(KEY);
    } catch (error) {
      failStorage(error);
      return false;
    }
    if (!raw) {
      // 처음 여는 좁은 화면(휴대폰)도 작품부터 보이게: 패널은 뷰포트를 덮는 서랍이라 닫힌 채로 시작한다.
      if (globalThis.matchMedia?.("(max-width:820px)").matches === true) document.body.classList.add("panel-hidden");
      savedText = JSON.stringify(readState());
      return false;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      errorMessage = "기존 설정 형식이 올바르지 않아 기본값으로 시작함";
      return false;
    }
    if (!data || data.version !== 1) {
      errorMessage = "지원하지 않는 저장 형식이므로 기본값으로 시작함";
      return false;
    }
    // 예전 저장 데이터의 required(초기 템플릿의 필수 Uniform)는 더 이상 쓰지 않으므로 무시한다.
    // 저장값은 외부 입력이다. 항목마다 검증해서 잘못된 값은 건너뛴다.
    const rendering = data.rendering || {};
    for (const [key, setter] of [
      ["fpsLimit", "setFpsLimit"],
      ["resolutionScale", "setResolutionScale"],
      ["maxPixels", "setMaxPixels"],
      ["timeScale", "setTimeScale"],
    ]) {
      if (Object.prototype.hasOwnProperty.call(rendering, key)) {
        try {
          renderer[setter](rendering[key]);
        } catch (error) {
          console.warn(`저장된 ${key} 무시:`, error.message);
        }
      }
    }
    // 예전 저장 데이터의 raymarch(레이마칭 전용 설정)·rendering.debugHeatmap은 더 이상 쓰지 않으므로 무시한다.
    if (Array.isArray(data.user) && (data.user.length || renderer.getUserUniforms().length)) {
      const users = data.user.slice(0, 64);
      try {
        renderer.setUserUniforms(users);
      } catch (error) {
        for (const item of users) {
          if (!item || typeof item !== "object") continue;
          try {
            renderer.defineUniform(item.name, item.type, item.value, item.options || {});
          } catch (error) {
            console.warn(`저장된 사용자 Uniform 무시 (${item.name}):`, error.message);
          }
        }
      }
    }
    // 프리셋(예전 저장에는 없다). 잘못된 목록은 버린다.
    try {
      presets = Presets.validate(Array.isArray(data.presets) ? data.presets : []);
    } catch (error) {
      console.warn("저장된 프리셋 무시:", error.message);
      presets = [];
    }
    changed();
    try {
      renderer.setLinks?.(Links.validate(Array.isArray(data.links) ? data.links : []));
    } catch (error) {
      console.warn("저장된 파라미터 연결 무시:", error.message);
    }
    document.dispatchEvent(new Event("shader-links-changed"));
    // 좁은 화면에서 패널은 뷰포트를 덮는 서랍이므로, 저장 상태와 관계없이 닫힌 채로 시작한다.
    const overlayPanel = globalThis.matchMedia?.("(max-width:820px)").matches === true;
    document.body.classList.toggle("panel-hidden", data.panelHidden === true || overlayPanel);
    savedText = null; // 유효하지 않은 항목을 제외한 안전한 스냅샷으로 갱신한다.
    save();
    return true;
  }; // Pack에 포함되는 설정은 저장소 포맷을 그대로 사용하되, 적용 전에 전체 검증한다.
  const validatePack = data => {
    if (
      !data ||
      data.version !== 1 ||
      !data.rendering ||
      !Array.isArray(data.user) ||
      typeof data.panelHidden !== "boolean"
    )
      throw new Error("Pack 설정 형식이 올바르지 않습니다.");
    const limits = {
      fpsLimit: [0, 240, 1],
      resolutionScale: [0.25, 1],
      maxPixels: [0, Number.MAX_SAFE_INTEGER, 1],
    };
    for (const [name, range] of Object.entries(limits)) {
      const value = data.rendering[name];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < range[0] ||
        value > range[1] ||
        (range[2] && !Number.isInteger(value))
      )
        throw new Error(`Pack 설정 범위 오류: ${name}`);
    }
    // 예전 Pack의 raymarch(레이마칭 전용 설정)·rendering.debugHeatmap은 열 수 있게 받아 두되 쓰지 않는다.
    // 재생 배속은 나중에 더한 항목이라 예전 Pack에는 없다(없으면 1×).
    const scale = data.rendering.timeScale;
    if (scale !== undefined && (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0.05 || scale > 8))
      throw new Error("Pack 설정 범위 오류: timeScale");
    // 프리셋은 나중에 더한 항목이라 예전 Pack에는 없다(없으면 빈 목록).
    if (data.presets !== undefined) Presets.validate(data.presets);
    if (data.links !== undefined) Links.validate(data.links);
    return data;
  };
  const applyPack = data => {
    data = validatePack(data);
    const s = data.rendering;
    renderer.setFpsLimit(s.fpsLimit);
    renderer.setResolutionScale(s.resolutionScale);
    renderer.setMaxPixels(s.maxPixels);
    renderer.setTimeScale(s.timeScale ?? defaults.timeScale);
    presets = Presets.validate(data.presets ?? []);
    changed();
    renderer.setLinks?.(Links.validate(data.links ?? []));
    document.dispatchEvent(new Event("shader-links-changed"));
    // panelHidden은 Pack 형식 호환을 위해 검증·저장만 한다. 패널 표시는 이 기기의 화면 배치이므로 프로젝트를 열어도 바꾸지 않는다.
    document.dispatchEvent(new Event("shader-settings-applied"));
    save();
  };
  const reset = () => {
    if (available) errorMessage = "";
    renderer.setFpsLimit(defaults.fpsLimit);
    renderer.setResolutionScale(defaults.resolutionScale);
    renderer.setMaxPixels(defaults.maxPixels);
    renderer.setTimeScale(defaults.timeScale);
    document.body.classList.remove("panel-hidden");
    savedText = null;
    save();
  };
  // 외부 JS에서 renderer.setUniform()을 호출한 경우도 별도 구독 없이 저장한다.
  // 매 프레임 저장하지 않고 700ms마다 바뀐 스냅샷만 기록한다.
  const timer = setInterval(save, 700);
  const onPageHide = () => save();
  window.addEventListener("pagehide", onPageHide);
  const dispose = () => {
    if (disposed) return;
    save();
    disposed = true;
    clearInterval(timer);
    window.removeEventListener("pagehide", onPageHide);
  };
  return {
    load,
    save,
    reset,
    status,
    dispose,
    snapshot: readState,
    validatePack,
    applyPack,
    getPresets,
    setPresets,
    getLinks,
    setLinks,
    renameParameter,
  };
};
export { mount };
