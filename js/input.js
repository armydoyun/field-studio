// 입력은 Renderer와 분리한다. 이 모듈은 뷰포트의 포인터/키 상태를 수집하고, 키보드 채널을 쓰는 셰이더에 키를 넘긴다.
// 카메라처럼 키로 값을 쌓아 가는 조작은 셰이더가 키보드 채널과 상태 버퍼로 직접 한다(갤러리의 Ray Marching SDF 예제).
const mount = (canvas, renderer) => {
  const stage = document.getElementById("stage");
  if (!stage) throw new Error("#stage 요소가 없습니다.");
  const keys = new Set(),
    keyListeners = new Set(),
    dragListeners = new Set();
  const controller = new AbortController(),
    signal = controller.signal;
  const listen = (target, type, callback, options = {}) =>
    target.addEventListener(type, callback, { ...options, signal });
  let pointerId = null,
    lastX = 0,
    lastY = 0,
    disposed = false;
  stage.tabIndex = 0;
  canvas.style.touchAction = "none"; // 터치 드래그가 브라우저 스크롤로 해석되지 않도록 한다.
  const isDown = code => keys.has(code);
  const onKey = callback => {
    keyListeners.add(callback);
    return () => keyListeners.delete(callback);
  };
  const onDrag = callback => {
    dragListeners.add(callback);
    return () => dragListeners.delete(callback);
  };
  const stopKeyboard = () => keys.clear();
  // 분리 창(popout.js)의 요소는 그 창의 Element라 instanceof로 가리지 않는다.
  const isTyping = target => !!target?.closest?.("input, textarea, select, [contenteditable]");
  // 캔버스가 별도 창으로 분리돼 있으면(popout.js) 그 창에서 캔버스에 초점이 있을 때가 '뷰포트 선택'이다.
  const canvasDocument = () => canvas.ownerDocument || document,
    popped = () => canvasDocument() !== document;
  const isStageActive = () =>
    popped()
      ? canvasDocument().activeElement === canvas
      : document.activeElement === stage || document.activeElement === canvas;
  const onKeyDown = event => {
    if (
      disposed ||
      canvasDocument().hidden ||
      event.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      isTyping(event.target) ||
      !isStageActive() ||
      keys.has(event.code)
    )
      return;
    keys.add(event.code);
    for (const callback of keyListeners) callback({ code: event.code, down: true, event });
  };
  // ---- 키보드 입력 채널 ----
  // 뷰포트(stage·캔버스)에 포커스가 있고, 실행 중인 구성에 키보드 채널이 있을 때만 키를 셰이더에 넘긴다.
  // 이때는 앱의 한 글자 단축키(E·X·H·G·F·Space·/)가 셰이더에 양보한다: window의 capture 단계에서 먼저 받아 전파를 멈춘다.
  // Ctrl·Cmd·Alt 조합(Ctrl+O 등)과 Tab은 앱에 남기고, Esc는 뷰포트에서 빠져나와 단축키를 되돌린다.
  const hint = document.getElementById("keyboardHint");
  const shaderKeys = () => !disposed && isStageActive() && !!renderer.usesKeyboard?.();
  const syncHint = () => {
    if (hint) hint.hidden = !shaderKeys();
  };
  const releaseShaderKeys = () => renderer.releaseKeys?.();
  const onShaderKeyDown = event => {
    if (event.isComposing || !shaderKeys()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      releaseShaderKeys();
      (popped() ? canvas : stage).blur?.();
      syncHint();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    renderer.setKey(event.keyCode, true);
    syncHint();
  };
  const onShaderKeyUp = event => {
    // 뗀 키는 포커스와 관계없이 항상 뗀다(눌린 채 남지 않게).
    renderer.setKey?.(event.keyCode, false);
    if (shaderKeys() && !event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
  };
  const onKeyUp = event => {
    if (!keys.delete(event.code)) return;
    for (const callback of keyListeners) callback({ code: event.code, down: false, event });
  };
  const stopDrag = () => {
    if (pointerId === null) return;
    const id = pointerId;
    pointerId = null;
    canvas.classList.remove("is-dragging");
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  };
  // 캔버스가 별도 창으로 분리돼 있으면(popout.js) 메인 stage에 초점을 주지 않는다. 주면 분리 창의 키 입력(Space·Esc)을 메인이 가져간다.
  // 분리 창에서는 캔버스 자체에 초점을 준다(그 창의 키 입력을 셰이더로 넘기는 기준).
  const focusStage = () => {
    if (popped()) canvas.focus?.({ preventScroll: true });
    else if (stage.contains?.(canvas) !== false) stage.focus({ preventScroll: true });
  };
  const onPointerDown = event => {
    if (disposed || event.button !== 0 || pointerId !== null) return;
    focusStage();
    pointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(pointerId);
    canvas.classList.add("is-dragging");
    event.preventDefault();
  };
  const onPointerMove = event => {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - lastX,
      dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (!dx && !dy) return;
    for (const callback of dragListeners) callback({ dx, dy, event });
  };
  const onPointerEnd = event => {
    if (event.pointerId === pointerId) stopDrag();
  };
  const onVisibilityChange = () => {
    if (document.hidden) {
      releaseShaderKeys();
      stopKeyboard();
      stopDrag();
    }
  };
  // 뷰포트 선택(키를 셰이더로 넘김)은 캔버스를 누르거나 키보드(Tab)로 #stage에 왔을 때만이다.
  // #stage는 tabindex=0이라, 그 안의 UI(툴바·알림 등)에서 초점을 못 받는 곳(빈 공간·비활성 버튼·Safari의 버튼)을 누르면
  // 브라우저가 초점을 가장 가까운 조상인 #stage로 넘긴다. 그 초점은 뷰포트 선택으로 치지 않고 놓아 준다.
  // (편집기 창은 tabindex=-1이라 그 안을 누르면 초점이 편집기 창에 머문다.)
  let uiPointer = false;
  const onStagePointerDown = event => {
    uiPointer = event.target !== canvas && event.target !== stage;
    if (uiPointer) setTimeout(() => (uiPointer = false), 0); // 이 누름의 초점 이동이 끝나면 잊는다.
  };
  const onStageFocusIn = event => {
    if (uiPointer && event.target === stage) {
      uiPointer = false;
      stage.blur();
      return;
    }
    syncHint();
  };
  const onFocusOut = event => {
    if (event.relatedTarget !== stage && event.relatedTarget !== canvas) {
      stopKeyboard();
      releaseShaderKeys();
    }
    queueMicrotask(syncHint);
  };
  listen(canvas, "pointerdown", onPointerDown);
  listen(canvas, "pointermove", onPointerMove);
  listen(canvas, "pointerup", onPointerEnd);
  listen(canvas, "pointercancel", onPointerEnd);
  listen(canvas, "lostpointercapture", onPointerEnd);
  listen(window, "keydown", onShaderKeyDown, { capture: true });
  listen(window, "keyup", onShaderKeyUp, { capture: true });
  listen(stage, "pointerdown", onStagePointerDown, { capture: true });
  listen(stage, "focusin", onStageFocusIn);
  listen(document, "keydown", onKeyDown);
  listen(document, "keyup", onKeyUp);
  listen(window, "blur", () => {
    releaseShaderKeys();
    syncHint();
    stopKeyboard();
    stopDrag();
  });
  listen(document, "visibilitychange", onVisibilityChange);
  listen(stage, "focusout", onFocusOut);
  // ---- 분리 창 ----
  // 캔버스를 별도 창으로 옮기면 키 이벤트는 그 창에서 일어나므로, 같은 처리기를 그 창에도 단다.
  // 캔버스는 그 창에서 초점을 받을 수 있게(tabindex=-1) 하고, 창을 열면 바로 키 입력을 받도록 초점을 준다.
  let popoutListeners = null;
  const detachPopout = () => {
    popoutListeners?.abort();
    popoutListeners = null;
    canvas.removeAttribute?.("tabindex");
  };
  const attachPopout = () => {
    detachPopout();
    const doc = canvasDocument(),
      win = doc.defaultView;
    if (!win || doc === document) return;
    popoutListeners = new AbortController();
    const opts = (capture = false) => ({ capture, signal: popoutListeners.signal });
    canvas.tabIndex = -1;
    win.addEventListener("keydown", onShaderKeyDown, opts(true));
    win.addEventListener("keyup", onShaderKeyUp, opts(true));
    doc.addEventListener("keydown", onKeyDown, opts());
    doc.addEventListener("keyup", onKeyUp, opts());
    win.addEventListener(
      "blur",
      () => {
        releaseShaderKeys();
        syncHint();
        stopKeyboard();
        stopDrag();
      },
      opts()
    );
    canvas.addEventListener(
      "focusout",
      () => {
        stopKeyboard();
        releaseShaderKeys();
        queueMicrotask(syncHint);
      },
      opts()
    );
    canvas.addEventListener("focusin", syncHint, opts());
    canvas.focus?.({ preventScroll: true });
  };
  listen(document, "preview-popout-changed", event => {
    releaseShaderKeys();
    stopKeyboard();
    if (event.detail?.open && popped()) attachPopout();
    else detachPopout();
    syncHint();
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    detachPopout();
    stopKeyboard();
    stopDrag();
    controller.abort();
    keyListeners.clear();
    dragListeners.clear();
    canvas.classList.remove("is-dragging");
    canvas.style.touchAction = "";
  };
  return { isDown, onKey, onDrag, syncKeyboardHint: syncHint, dispose };
};
export { mount };
