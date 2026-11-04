// 편집기 화면 배치: 높이·너비 리사이저, 옆(right)·아래(bottom) 배치, 도구 서랍, 접이식 묶음 열림 상태 저장.
// 사용자가 직접 정한 높이·배치만 저장한다. 정하기 전에는 창 크기(반·4분할 창 포함)에 맞는 기본값을 따른다.
import * as Store from "./storage.js";

const HEIGHT_KEY = "webgl.shader-studio.height.v2", LAYOUT_KEY = "webgl.shader-studio.layout.v1", WORKSPACE_KEY = "webgl.shader-studio.workspace.v1";
const GROUPS = ["studioInputs", "studioFiles", "studioImages", "studioDependencies", "studioInspector", "studioCodeTools"];
const HEIGHT = {min:25, max:85}, WIDTH = {min:30, max:75, initial:46};
const clamp = (value, {min, max}) => Math.max(min, Math.min(max, value));

// 좁거나 낮은 창은 편집기를 더 높게 연다.
const responsiveHeight = () => window.matchMedia("(max-width:600px), (max-height:650px)").matches ? 75 : 55;
// 넓은 화면, 또는 4분할 창처럼 가로로 길고 낮은 창은 아래 배치가 미리보기와 코드를 모두 납작하게 만드므로 옆 배치가 기본이다.
const fitLayout = () => { const w = window.innerWidth || 0, h = window.innerHeight || 0; return w >= 1200 || (w >= 900 && h > 0 && w >= h * 1.6) ? "right" : "bottom"; };

// editor: 배치가 바뀌면 다시 재도록 update()를 부른다. editorOpen(): 저장할 편집기 열림 상태.
const create = ({$, on, editor, editorOpen}) => {
  let heightChosen = false, layoutChosen = false, workspaceReady = false;
  let dockHeight = responsiveHeight(), layout = fitLayout(), dockWidth = WIDTH.initial;
  { const stored = Number(Store.read(HEIGHT_KEY)); heightChosen = stored > 0; dockHeight = clamp(stored || dockHeight, HEIGHT); }
  { const saved = Store.readJSON(LAYOUT_KEY, {}) || {};
    if(["right", "bottom"].includes(saved.layout)) { layout = saved.layout; layoutChosen = true; }
    if(Number.isFinite(saved.width)) dockWidth = clamp(saved.width, WIDTH); }

  // 좁은 화면(≤820px)에서는 CSS가 아래 배치로 되돌리므로 리사이저도 세로 방향으로 동작한다.
  const splitRight = () => layout === "right" && !window.matchMedia("(max-width:820px)").matches;
  const saveLayout = () => { layoutChosen = true; Store.writeJSON(LAYOUT_KEY, {layout, width:dockWidth}); };
  const setDockHeight = (value, persist = true) => {
    dockHeight = clamp(value, HEIGHT); $("studioDock").style.setProperty("--studio-height", `${dockHeight}%`);
    if(layout === "bottom") $("studioResize").setAttribute("aria-valuenow", String(Math.round(dockHeight)));
    if(persist) { heightChosen = true; Store.write(HEIGHT_KEY, String(dockHeight)); }
  };
  // 두 번 클릭 복원: 저장한 높이를 지우고 다시 창 크기 기본값을 따른다.
  const resetDockHeight = () => { heightChosen = false; Store.remove(HEIGHT_KEY); setDockHeight(responsiveHeight(), false); };
  const setDockWidth = (value, persist = true) => {
    dockWidth = clamp(value, WIDTH); $("stage").style.setProperty("--studio-width", `${dockWidth}%`);
    if(layout === "right") $("studioResize").setAttribute("aria-valuenow", String(Math.round(dockWidth)));
    if(persist) saveLayout();
  };
  const applyLayout = () => {
    const right = layout === "right"; $("stage").classList.toggle("studio-layout-right", right);
    const handle = $("studioResize"); handle.setAttribute("aria-orientation", right ? "vertical" : "horizontal");
    handle.setAttribute("aria-valuemin", right ? "30" : "25"); handle.setAttribute("aria-valuemax", right ? "75" : "85");
    handle.setAttribute("aria-valuenow", String(Math.round(right ? dockWidth : dockHeight)));
    handle.title = right ? "드래그 또는 ←→로 너비 조절 · 두 번 클릭해 기본 너비 복원" : "드래그 또는 ↑↓로 높이 조절 · Home/End · 두 번 클릭해 기본 높이 복원";
    $("studioLayout").setAttribute("aria-pressed", String(right)); $("studioLayout").title = right ? "편집기를 캔버스 아래로 배치" : "편집기를 캔버스 오른쪽에 나란히 배치";
    $("studioLayout").textContent = right ? "편집기를 아래에 배치" : "편집기를 오른쪽에 배치";
    editor.update();
  };
  const toggleLayout = () => { layout = layout === "right" ? "bottom" : "right"; saveLayout(); applyLayout(); };

  // editor: 편집기 열림 상태 — 새로 고침해도 편집하던 화면으로 돌아온다.
  const saveWorkspace = () => {
    if(!workspaceReady) return;
    Store.writeJSON(WORKSPACE_KEY, {toolsHidden:$("studioTools").hidden, editor:editorOpen(), open:Object.fromEntries(GROUPS.map(id => [id, $(id).open]))});
  };
  // 옆 배치의 도구 서랍은 코드 위에 겹치므로, 코드를 누르거나 프로젝트를 바꾸면 닫아 편집 영역을 돌려준다.
  const closeToolsDrawer = () => { if(!$("studioTools").hidden) { $("studioTools").hidden = true; $("studioToolsToggle").setAttribute("aria-expanded", "false"); } };

  $("studioDock").style.setProperty("--studio-height", `${dockHeight}%`);
  on($("studioToolsToggle"), "click", () => { const hidden = $("studioTools").hidden = !$("studioTools").hidden; $("studioToolsToggle").setAttribute("aria-expanded", String(!hidden)); saveWorkspace(); });
  const resizer = $("studioResize"); let sizing = false;
  on(resizer, "pointerdown", e => { if(e.button !== 0) return; sizing = true; resizer.setPointerCapture(e.pointerId); e.preventDefault(); });
  on(resizer, "pointermove", e => { if(!sizing) return; const rect = $("stage").getBoundingClientRect();
    if(splitRight()) { if(rect.width > 0) setDockWidth((rect.right - e.clientX) / rect.width * 100); }
    else if(rect.height > 0) setDockHeight((rect.bottom - e.clientY) / rect.height * 100); });
  for(const type of ["pointerup", "pointercancel", "lostpointercapture"]) on(resizer, type, () => { sizing = false; });
  on(resizer, "dblclick", () => splitRight() ? setDockWidth(WIDTH.initial) : resetDockHeight());
  on(resizer, "keydown", e => {
    if(splitRight()) { if(["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); setDockWidth(e.key === "Home" ? WIDTH.min : e.key === "End" ? WIDTH.max : dockWidth + (e.key === "ArrowLeft" ? 3 : -3)); } return; }
    if(["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) { e.preventDefault(); setDockHeight(e.key === "Home" ? HEIGHT.min : e.key === "End" ? HEIGHT.max : dockHeight + (e.key === "ArrowUp" ? 3 : -3)); }
  });
  on($("studioLayout"), "click", toggleLayout);
  on($("studioCode"), "pointerdown", () => { if(splitRight()) closeToolsDrawer(); });

  setDockHeight(dockHeight, false); setDockWidth(dockWidth, false); applyLayout();
  // 창 크기를 바꾸면(화면 분할 등) 사용자가 정하지 않은 높이·배치는 새 크기의 기본값으로 다시 맞춘다.
  on(window, "resize", () => {
    if(!heightChosen && dockHeight !== responsiveHeight()) setDockHeight(responsiveHeight(), false);
    const fit = fitLayout(); if(!layoutChosen && layout !== fit) { layout = fit; applyLayout(); if(splitRight()) closeToolsDrawer(); }
  });
  $("studioTools").hidden = window.matchMedia("(max-width:600px)").matches || layout === "right";
  const state = Store.readJSON(WORKSPACE_KEY, {});
  if(typeof state?.toolsHidden === "boolean") $("studioTools").hidden = state.toolsHidden;
  for(const id of GROUPS) if(typeof state?.open?.[id] === "boolean") $(id).open = state.open[id];
  // 옆 배치에서 도구는 코드를 덮는 서랍이므로, 아래 배치에서 저장된 "도구 표시" 상태와 관계없이 닫힌 채로 시작한다.
  if(splitRight()) $("studioTools").hidden = true;
  for(const id of GROUPS) on($(id), "toggle", saveWorkspace);
  $("studioToolsToggle").setAttribute("aria-expanded", String(!$("studioTools").hidden));

  return {
    splitRight, closeToolsDrawer, saveWorkspace,
    // 지난번에 편집기를 연 채로 떠났는지
    reopenEditor:state?.editor === true,
    // 첫 화면 복원이 끝난 뒤부터 저장한다(복원 도중의 열기·닫기는 저장하지 않는다).
    ready:() => { workspaceReady = true; },
  };
};

export {create, responsiveHeight, fitLayout, HEIGHT_KEY, LAYOUT_KEY, WORKSPACE_KEY};
