// 화면 표시 상태와 포커스: 설정 패널 · HUD · 툴바 메뉴 · 전체화면.
// 렌더링·파라미터 UI와 분리하고, 버튼·단축키가 같은 상태 변경 함수를 쓴다.
import * as StageMenu from "./stage-menu.js";
import * as PreviewDOM from "./preview-dom.js";

const create = ({ $, on, signal, activeTab, savePanel, showError }) => {
  const stage = $("stage");
  const captureMenu = StageMenu.create({ toggle: $("captureToggle"), menu: $("captureMenu"), signal }),
    moreMenu = StageMenu.create({ toggle: $("moreToggle"), menu: $("moreMenu"), signal });
  const focusToolbar = id => {
    const node = $(id);
    const toggle = node?.closest?.("#moreMenu") ? moreMenu.toggle : captureMenu.toggle;
    const menu = document.querySelector('#menuBar [data-menu="view"]');
    PreviewDOM.focusVisible([node, toggle, menu, $("hudReveal"), $("screen")]);
  };
  const syncPanel = () => {
    const hidden = document.body.classList.contains("panel-hidden");
    stage.inert = !hidden && window.matchMedia("(max-width:820px)").matches;
    $("panelToggle").setAttribute("aria-label", hidden ? "설정 패널 열기" : "설정 패널 숨기기");
    $("panelToggle").setAttribute("aria-pressed", String(!hidden));
    $("panelClose").title = hidden ? "패널 열기" : "패널 숨기기";
  };
  const setPanelHidden = (hidden, { focus = false } = {}) => {
    document.body.classList.toggle("panel-hidden", hidden);
    syncPanel();
    savePanel();
    if (focus) {
      if (hidden) focusToolbar("panelToggle");
      else $("panelTabs").querySelector(`[data-tab="${activeTab()}"]`)?.focus();
    }
  };
  const togglePanel = () => setPanelHidden(!document.body.classList.contains("panel-hidden"), { focus: true });

  let revealTimer = 0;
  const showReveal = () => {
    if (!stage.classList.contains("hud-hidden")) return;
    $("hudReveal").classList.add("is-visible");
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => $("hudReveal").classList.remove("is-visible"), 1600);
  };
  const setHud = visible => {
    const reveal = $("hudReveal"),
      doc = reveal.ownerDocument || document,
      focused = doc.activeElement;
    stage.classList.toggle("hud-hidden", !visible);
    $("hudToggle").setAttribute("aria-label", visible ? "HUD 숨기기" : "HUD 표시");
    $("hudToggle").setAttribute("aria-pressed", String(visible));
    reveal.classList.remove("is-visible");
    clearTimeout(revealTimer);
    if (!visible) {
      // 메뉴의 화면과 aria-expanded를 함께 닫는다.
      captureMenu.close();
      moreMenu.close();
      showReveal();
      if ($("stageHeader").contains?.(focused) && focused !== reveal) reveal.focus({ preventScroll: true });
    } else if (focused === reveal) focusToolbar("hudToggle");
  };
  const toggleHud = () => setHud(stage.classList.contains("hud-hidden"));

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
  const toggleFullscreen = async () => {
    try {
      const doc = $("screen").ownerDocument || document;
      if (doc.fullscreenElement) await doc.exitFullscreen();
      else await (doc === document ? stage : doc.body).requestFullscreen();
      showError("");
    } catch (error) {
      showError(`전체화면 전환 실패: ${error.message}`);
    }
  };
  const fullscreenDocs = new WeakSet();
  const bindFullscreen = () => {
    const doc = $("screen").ownerDocument || document;
    if (!fullscreenDocs.has(doc)) {
      fullscreenDocs.add(doc);
      on(doc, "fullscreenchange", syncFullscreen);
    }
    syncFullscreen();
  };
  for (const id of ["panelClose", "panelBackdrop", "panelToggle"]) on($(id), "click", togglePanel);
  on(document, "shader-panel-changed", syncPanel);
  on(window, "resize", syncPanel);
  on($("hudToggle"), "click", toggleHud);
  on($("hudReveal"), "click", () => setHud(true));
  on($("screen"), "pointermove", showReveal);
  on($("fullscreenToggle"), "click", toggleFullscreen);
  on(document, "preview-popout-changed", bindFullscreen);
  on(document, "menubar-visibility-changed", () => {
    captureMenu.close();
    moreMenu.close();
  });
  signal.addEventListener("abort", () => clearTimeout(revealTimer), { once: true });
  bindFullscreen();
  return { syncPanel, setPanelHidden, togglePanel, setHud, toggleHud, toggleFullscreen };
};

export { create };
