// 설정 패널 배치: 너비 조절(리사이저)과 자리(왼쪽 · 오른쪽).
// - 너비는 패널과 미리보기 사이의 경계를 끌거나, 경계에 초점을 두고 ←→ · Home/End로 바꾼다. 두 번 클릭하면 기본 너비.
// - 자리는 패널 머리의 손잡이를 끌어 화면 왼쪽·오른쪽 가장자리에 놓거나, 손잡이에서 ←→를 누른다.
// - 사용자가 직접 정한 값만 저장한다. 좁은 화면(≤820px)에서는 패널이 왼쪽에서 열리는 서랍이라 이 설정을 쓰지 않는다.
// - '화면 배치 초기화'(#layoutReset)는 패널을 기본값으로 되돌리고 workspace-layout-reset 이벤트로 편집기 배치도 되돌리게 한다.
// WebGL과 무관하게 동작하도록 렌더러보다 먼저 연결한다(main.js).
import * as Store from "./storage.js";
import * as DockDrag from "./dock-drag.js";

const KEY = "field.panel.layout.v1";
const WIDTH = { min: 240, max: 560, initial: 300, step: 16 };
const NARROW = "(max-width:820px)";
// 미리보기가 너무 좁아지지 않게 패널은 창 너비의 45%를 넘지 않는다.
const maxWidth = viewWidth =>
  Math.max(WIDTH.min, Math.min(WIDTH.max, Math.round((viewWidth || 0) * 0.45) || WIDTH.max));
const clampWidth = (value, viewWidth) => Math.round(Math.max(WIDTH.min, Math.min(maxWidth(viewWidth), value)));

const mount = ({ doc = document } = {}) => {
  const view = doc.defaultView || window,
    $ = id => doc.getElementById(id);
  const workspace = $("workspace"),
    handle = $("panelResize"),
    grip = $("panelGrip");
  const controller = new AbortController(),
    signal = controller.signal;
  const listen = (node, type, fn, options = {}) => node?.addEventListener?.(type, fn, { ...options, signal });
  const narrow = () => view.matchMedia?.(NARROW).matches === true;

  let side = "left",
    width = WIDTH.initial,
    widthChosen = false;
  {
    const saved = Store.readJSON(KEY, {}) || {};
    if (saved.side === "right") side = "right";
    if (Number.isFinite(saved.width)) {
      width = saved.width;
      widthChosen = true;
    }
  }
  const save = () => Store.writeJSON(KEY, { side, ...(widthChosen ? { width } : {}) });
  // 저장한 너비가 지금 창에 비해 크면 보이는 너비만 줄인다(저장값은 그대로라 창을 넓히면 돌아온다).
  const shownWidth = () => clampWidth(width, view.innerWidth);
  const applyWidth = () => {
    const shown = shownWidth();
    workspace?.style.setProperty("--panel-width", `${shown}px`);
    if (!handle) return;
    handle.setAttribute("aria-valuemin", String(WIDTH.min));
    handle.setAttribute("aria-valuemax", String(maxWidth(view.innerWidth)));
    handle.setAttribute("aria-valuenow", String(shown));
  };
  const applySide = () => {
    // <html>에 단다: index.html의 첫 그리기 전 스크립트가 같은 자리에 미리 달아 둔다.
    doc.documentElement.classList.toggle("panel-right", side === "right");
    if (grip) {
      const here = DockDrag.LABEL[side];
      grip.title = `끌어서 설정 패널을 화면 왼쪽·오른쪽으로 옮기기 · ←→로도 옮김 (지금 ${here})`;
      grip.setAttribute("aria-label", `설정 패널 위치 옮기기 (지금 ${here})`);
    }
  };
  const setWidth = (value, persist = true) => {
    width = clampWidth(value, view.innerWidth);
    if (persist) {
      widthChosen = true;
      save();
    }
    applyWidth();
  };
  const resetWidth = () => {
    widthChosen = false;
    width = WIDTH.initial;
    save();
    applyWidth();
  };
  const setSide = next => {
    if (next !== "left" && next !== "right") return;
    side = next;
    save();
    applySide();
  };
  const reset = () => {
    side = "left";
    width = WIDTH.initial;
    widthChosen = false;
    Store.remove(KEY);
    applySide();
    applyWidth();
  };

  // ---- 너비 리사이저 ----
  let sizing = null;
  listen(handle, "pointerdown", event => {
    if (event.button !== 0 || narrow()) return;
    sizing = event.pointerId;
    try {
      handle.setPointerCapture?.(sizing);
    } catch (_) {
      /* 이미 끝난 포인터면 붙잡지 못해도 이어지는 이벤트로 처리한다. */
    }
    doc.body.classList.add("panel-resizing");
    event.preventDefault();
  });
  listen(handle, "pointermove", event => {
    if (event.pointerId !== sizing || !workspace) return;
    const rect = workspace.getBoundingClientRect();
    setWidth(side === "left" ? event.clientX - rect.left : rect.right - event.clientX);
  });
  const stopSizing = event => {
    if (event.pointerId !== sizing) return;
    sizing = null;
    doc.body.classList.remove("panel-resizing");
  };
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) listen(handle, type, stopSizing);
  listen(handle, "dblclick", resetWidth);
  listen(handle, "keydown", event => {
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft",
      shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    let next = null;
    if (event.key === grow) next = shownWidth() + WIDTH.step;
    else if (event.key === shrink) next = shownWidth() - WIDTH.step;
    else if (event.key === "Home") next = WIDTH.min;
    else if (event.key === "End") next = maxWidth(view.innerWidth);
    if (next === null) return;
    event.preventDefault();
    setWidth(next);
  });

  // ---- 자리 손잡이 ----
  const drag = DockDrag.create({
    grip,
    target: () => workspace,
    sides: ["left", "right"],
    current: () => side,
    onDrop: setSide,
    name: "설정 패널",
    enabled: () => !narrow(),
    size: () => {
      const rect = workspace?.getBoundingClientRect?.();
      return rect?.width ? shownWidth() / rect.width : 0.25;
    },
  });

  // ---- 화면 배치 초기화 ----
  listen($("layoutReset"), "click", () => {
    reset();
    doc.dispatchEvent(new view.CustomEvent("workspace-layout-reset"));
  });

  listen(view, "resize", applyWidth);
  applySide();
  applyWidth();

  return {
    get side() {
      return side;
    },
    get width() {
      return shownWidth();
    },
    setSide,
    setWidth,
    reset,
    dispose: () => {
      drag.dispose();
      controller.abort();
    },
  };
};

export { mount, clampWidth, maxWidth, KEY, WIDTH };
