// 편집기 화면 배치: 높이·너비 리사이저, 미리보기의 왼쪽·오른쪽·위·아래 배치, 편집기 메뉴 열림 상태 저장.
// 사용자가 직접 정한 높이·배치만 저장한다. 정하기 전에는 창 크기(반·4분할 창 포함)에 맞는 기본값(right·bottom)을 따른다.
// 배치는 DOM 순서를 바꾸지 않고 #stage의 클래스(studio-layout-<자리>)와 CSS flex 방향으로만 정한다.
// 좁은 화면(≤820px)에서는 CSS가 언제나 아래 배치로 되돌린다.
// 리사이저를 최소 크기의 절반보다 작게 끌면 편집기에 '놓으면 숨김'이 뜨고, 그대로 놓으면 편집기를 닫는다(onCollapse).
// 닫을 때는 끌기 전 크기로 되돌려 두어 다시 열면 원래 크기로 열린다.
import * as Store from "./storage.js";
import * as DockDrag from "./dock-drag.js";

const HEIGHT_KEY = "webgl.shader-studio.height.v2",
  LAYOUT_KEY = "webgl.shader-studio.layout.v1",
  WORKSPACE_KEY = "webgl.shader-studio.workspace.v1";
const GROUPS = ["studioCodeTools"];
const HEIGHT = { min: 25, max: 85 },
  WIDTH = { min: 30, max: 75, initial: 46 };
const clamp = (value, { min, max }) => Math.max(min, Math.min(max, value));
const SIDES = ["right", "left", "bottom", "top"];
const HORIZONTAL = new Set(["right", "left"]);
// 메뉴 버튼·Ctrl+\: 옆 ↔ 위아래를 오간다(오른쪽 ↔ 아래, 왼쪽 ↔ 위).
const SWAP = { right: "bottom", bottom: "right", left: "top", top: "left" };

// 좁거나 낮은 창은 편집기를 더 높게 연다.
const responsiveHeight = () => (window.matchMedia("(max-width:600px), (max-height:650px)").matches ? 75 : 55);
// 넓은 화면, 또는 4분할 창처럼 가로로 길고 낮은 창은 아래 배치가 미리보기와 코드를 모두 납작하게 만드므로 옆 배치가 기본이다.
const fitLayout = () => {
  const w = window.innerWidth || 0,
    h = window.innerHeight || 0;
  return w >= 1200 || (w >= 900 && h > 0 && w >= h * 1.6) ? "right" : "bottom";
};

// editor: 배치가 바뀌면 다시 재도록 update()를 부른다. editorOpen(): 저장할 편집기 열림 상태.
// onCollapse(): 리사이저를 끝까지 줄여 놓았을 때 편집기를 닫는다.
const create = ({ $, on, editor, editorOpen, onCollapse = () => {} }) => {
  let heightChosen = false,
    layoutChosen = false,
    workspaceReady = false;
  let dockHeight = responsiveHeight(),
    layout = fitLayout(),
    dockWidth = WIDTH.initial;
  {
    const stored = Number(Store.read(HEIGHT_KEY));
    heightChosen = stored > 0;
    dockHeight = clamp(stored || dockHeight, HEIGHT);
  }
  {
    const saved = Store.readJSON(LAYOUT_KEY, {}) || {};
    if (SIDES.includes(saved.layout)) {
      layout = saved.layout;
      layoutChosen = true;
    }
    if (Number.isFinite(saved.width)) dockWidth = clamp(saved.width, WIDTH);
  }

  // 좁은 화면(≤820px)에서는 CSS가 아래 배치로 되돌리므로 리사이저도 세로 방향으로 동작한다.
  const narrow = () => window.matchMedia("(max-width:820px)").matches;
  // 실제로 보이는 자리(좁은 화면이면 아래)
  const side = () => (narrow() ? "bottom" : layout);
  // 편집기가 미리보기 옆에 있어 너비로 조절하는지
  const splitRight = () => HORIZONTAL.has(side());
  const saveLayout = () => {
    layoutChosen = true;
    Store.writeJSON(LAYOUT_KEY, { layout, width: dockWidth });
  };
  const setDockHeight = (value, persist = true) => {
    dockHeight = clamp(value, HEIGHT);
    $("studioDock").style.setProperty("--studio-height", `${dockHeight}%`);
    if (!splitRight()) $("studioResize").setAttribute("aria-valuenow", String(Math.round(dockHeight)));
    if (persist) {
      heightChosen = true;
      Store.write(HEIGHT_KEY, String(dockHeight));
    }
  };
  // 두 번 클릭 복원: 저장한 높이를 지우고 다시 창 크기 기본값을 따른다.
  const resetDockHeight = () => {
    heightChosen = false;
    Store.remove(HEIGHT_KEY);
    setDockHeight(responsiveHeight(), false);
  };
  const setDockWidth = (value, persist = true) => {
    dockWidth = clamp(value, WIDTH);
    $("stage").style.setProperty("--studio-width", `${dockWidth}%`);
    if (splitRight()) $("studioResize").setAttribute("aria-valuenow", String(Math.round(dockWidth)));
    if (persist) saveLayout();
  };
  // 리사이저의 ARIA 방향·값은 실제로 움직이는 방향을 따른다: 옆 배치라도 좁은 화면(≤820px)에서는 CSS가 아래 배치로
  // 되돌리므로 위아래(높이)로 움직인다.
  const applyLayout = () => {
    for (const each of SIDES)
      $("stage").classList.toggle(`studio-layout-${each}`, layout === each && each !== "bottom");
    const right = splitRight();
    const handle = $("studioResize");
    handle.setAttribute("aria-orientation", right ? "vertical" : "horizontal");
    handle.setAttribute("aria-valuemin", right ? "30" : "25");
    handle.setAttribute("aria-valuemax", right ? "75" : "85");
    handle.setAttribute("aria-valuenow", String(Math.round(right ? dockWidth : dockHeight)));
    handle.title = right
      ? "드래그 또는 ←→로 너비 조절 · 끝까지 줄여 놓으면 편집기 닫기 · 두 번 클릭해 기본 너비 복원"
      : "드래그 또는 ↑↓로 높이 조절 · 끝까지 줄여 놓으면 편집기 닫기 · Home/End · 두 번 클릭해 기본 높이 복원";
    const next = SWAP[layout];
    $("studioLayout").setAttribute("aria-pressed", String(HORIZONTAL.has(layout)));
    $("studioLayout").title =
      `편집기를 미리보기 ${DockDrag.LABEL[next]}에 배치 · 편집기 머리의 손잡이를 끌면 네 방향 어디로든 옮깁니다`;
    $("studioLayout").textContent = `편집기를 ${DockDrag.LABEL[next]}에 배치`;
    const grip = $("studioDockGrip");
    if (grip) {
      grip.title = `끌어서 편집기를 미리보기의 왼쪽·오른쪽·위·아래로 옮기기 · 방향키로도 옮김 (지금 ${DockDrag.LABEL[layout]})`;
      grip.setAttribute("aria-label", `편집기 위치 옮기기 (지금 ${DockDrag.LABEL[layout]})`);
    }
    editor.update();
  };
  const setLayout = next => {
    if (!SIDES.includes(next)) return;
    layout = next;
    saveLayout();
    applyLayout();
  };
  const toggleLayout = () => setLayout(SWAP[layout]);
  // 화면 배치 초기화(설정 패널 · 작업공간 탭): 저장한 배치·높이·너비를 지우고 창 크기 기본값으로 돌아간다.
  const resetLayout = () => {
    layoutChosen = false;
    heightChosen = false;
    Store.remove(LAYOUT_KEY);
    Store.remove(HEIGHT_KEY);
    layout = fitLayout();
    dockWidth = WIDTH.initial;
    setDockHeight(responsiveHeight(), false);
    setDockWidth(dockWidth, false);
    applyLayout();
  };

  // editor: 편집기 열림 상태 — 새로 고침해도 편집하던 화면으로 돌아온다.
  const saveWorkspace = () => {
    if (!workspaceReady) return;
    Store.writeJSON(WORKSPACE_KEY, {
      editor: editorOpen(),
      open: Object.fromEntries(GROUPS.map(id => [id, $(id).open])),
    });
  };

  $("studioDock").style.setProperty("--studio-height", `${dockHeight}%`);
  const resizer = $("studioResize");
  let sizing = false,
    start = null,
    collapsing = false;
  const setCollapsing = value => {
    if (collapsing === value) return;
    collapsing = value;
    $("stage").classList.toggle("studio-collapsing", value);
    resizer.setAttribute("aria-valuetext", value ? "놓으면 편집기를 닫습니다" : "");
    if (!value) resizer.removeAttribute("aria-valuetext");
  };
  on(resizer, "pointerdown", e => {
    if (e.button !== 0) return;
    sizing = true;
    start = { height: dockHeight, width: dockWidth, heightChosen, layoutChosen };
    resizer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  on(resizer, "pointermove", e => {
    if (!sizing) return;
    const rect = $("stage").getBoundingClientRect(),
      at = side();
    // 원하는 크기(%)가 최소의 절반보다 작으면 놓을 때 닫는다. 그동안 편집기는 최소 크기에 머문다.
    const wanted =
      at === "right" && rect.width > 0
        ? ((rect.right - e.clientX) / rect.width) * 100
        : at === "left" && rect.width > 0
          ? ((e.clientX - rect.left) / rect.width) * 100
          : at === "top" && rect.height > 0
            ? ((e.clientY - rect.top) / rect.height) * 100
            : at === "bottom" && rect.height > 0
              ? ((rect.bottom - e.clientY) / rect.height) * 100
              : null;
    if (wanted === null) return;
    const horizontal = at === "right" || at === "left";
    setCollapsing(wanted < (horizontal ? WIDTH.min : HEIGHT.min) / 2);
    if (horizontal) setDockWidth(wanted);
    else setDockHeight(wanted);
  });
  // 끌기 전 크기·저장 상태로 되돌린다(최소 크기가 저장되지 않게).
  const restoreStart = () => {
    if (start.heightChosen) setDockHeight(start.height);
    else resetDockHeight();
    setDockWidth(start.width, start.layoutChosen);
    if (!start.layoutChosen) {
      layoutChosen = false;
      Store.remove(LAYOUT_KEY);
    }
  };
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    on(resizer, type, e => {
      if (!sizing) return;
      sizing = false;
      if (!collapsing) return;
      setCollapsing(false);
      restoreStart();
      if (e.type === "pointerup") onCollapse();
    });
  on(resizer, "dblclick", () => (splitRight() ? setDockWidth(WIDTH.initial) : resetDockHeight()));
  // 방향키는 경계를 그 방향으로 민다: 오른쪽 배치에서 ←는 편집기를 넓히고, 왼쪽 배치에서는 →가 넓힌다.
  on(resizer, "keydown", e => {
    const at = side();
    if (splitRight()) {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const grow = e.key === (at === "right" ? "ArrowLeft" : "ArrowRight");
        setDockWidth(e.key === "Home" ? WIDTH.min : e.key === "End" ? WIDTH.max : dockWidth + (grow ? 3 : -3));
      }
      return;
    }
    if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const grow = e.key === (at === "top" ? "ArrowDown" : "ArrowUp");
      setDockHeight(e.key === "Home" ? HEIGHT.min : e.key === "End" ? HEIGHT.max : dockHeight + (grow ? 3 : -3));
    }
  });
  on($("studioLayout"), "click", toggleLayout);
  // 편집기 머리의 손잡이: 끌어서 미리보기의 네 가장자리 중 하나에 놓는다.
  const dockDrag = DockDrag.create({
    grip: $("studioDockGrip"),
    target: () => $("stage"),
    sides: SIDES,
    current: () => layout,
    onDrop: setLayout,
    name: "편집기",
    enabled: () => !narrow(),
    size: at => (HORIZONTAL.has(at) ? dockWidth : dockHeight) / 100,
  });
  on(document, "workspace-layout-reset", resetLayout);

  setDockHeight(dockHeight, false);
  setDockWidth(dockWidth, false);
  applyLayout();
  let wasNarrow = window.matchMedia("(max-width:820px)").matches;
  // 창 크기를 바꾸면(화면 분할 등) 사용자가 정하지 않은 높이·배치는 새 크기의 기본값으로 다시 맞춘다.
  on(window, "resize", () => {
    if (!heightChosen && dockHeight !== responsiveHeight()) setDockHeight(responsiveHeight(), false);
    const fit = fitLayout(),
      narrow = window.matchMedia("(max-width:820px)").matches;
    if (!layoutChosen && layout !== fit) {
      layout = fit;
      applyLayout();
    } else if (narrow !== wasNarrow) applyLayout(); // 좁은 화면 경계를 넘으면 리사이저 방향을 다시 맞춘다
    wasNarrow = narrow;
  });
  const state = Store.readJSON(WORKSPACE_KEY, {});
  for (const id of GROUPS) if (typeof state?.open?.[id] === "boolean") $(id).open = state.open[id];
  for (const id of GROUPS) on($(id), "toggle", saveWorkspace);

  return {
    splitRight,
    side,
    setLayout,
    resetLayout,
    dispose: () => dockDrag.dispose(),
    saveWorkspace,
    // 지난번에 편집기를 연 채로 떠났는지
    reopenEditor: state?.editor === true,
    // 첫 화면 복원이 끝난 뒤부터 저장한다(복원 도중의 열기·닫기는 저장하지 않는다).
    ready: () => {
      workspaceReady = true;
    },
  };
};

export { create, responsiveHeight, fitLayout, SIDES, HEIGHT_KEY, LAYOUT_KEY, WORKSPACE_KEY };
