// 입력은 Renderer와 분리한다. 이 모듈은 포인터/키 상태를 수집하고 카메라 Uniform만 갱신한다.
// 키 입력은 캔버스를 클릭해 Stage에 초점을 준 상태에서만 카메라 조작에 사용한다.
const mount = (canvas, renderer, home = [0, 0, 5]) => {
  const stage = document.getElementById("stage");
  if (!stage) throw new Error("#stage 요소가 없습니다.");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const initial = { yaw: home[0], pitch: home[1], distance: home[2] };
  const camera = { ...initial },
    keys = new Set(),
    keyListeners = new Set(),
    dragListeners = new Set();
  const controller = new AbortController(),
    signal = controller.signal;
  const listen = (target, type, callback, options = {}) =>
    target.addEventListener(type, callback, { ...options, signal });
  const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
  let pointerId = null,
    lastX = 0,
    lastY = 0,
    frame = 0,
    lastTime = null,
    disposed = false;
  stage.tabIndex = 0;
  canvas.style.touchAction = "none"; // 터치 드래그가 브라우저 스크롤로 해석되지 않도록 한다.
  // UI나 외부 JS에서 uCameraOrbit를 수정한 경우, 다음 조작 전에 카메라 상태로 읽어온다.
  const readCamera = () => {
    const item = renderer.getUserUniforms().find(item => item.name === "uCameraOrbit"),
      value = item?.value;
    if (item?.type !== "vec3" || !Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite))
      return false;
    [camera.yaw, camera.pitch, camera.distance] = value;
    camera.pitch = clamp(camera.pitch, -1.4, 1.4);
    camera.distance = clamp(camera.distance, 1.5, 30);
    return true;
  };
  const syncCamera = () => renderer.setUniform("uCameraOrbit", [camera.yaw, camera.pitch, camera.distance]);
  const getCamera = () => (readCamera() ? { ...camera } : null);
  const setCamera = values => {
    if (disposed) throw new Error("폐기된 Input입니다.");
    if (!readCamera()) return false;
    const next = { ...camera, ...values };
    if (![next.yaw, next.pitch, next.distance].every(Number.isFinite))
      throw new TypeError("카메라 값은 유효한 숫자여야 합니다.");
    camera.yaw = next.yaw;
    camera.pitch = clamp(next.pitch, -1.4, 1.4);
    camera.distance = clamp(next.distance, 1.5, 30);
    syncCamera();
    return true;
  };
  const resetCamera = () => setCamera(initial);
  const isDown = code => keys.has(code);
  const onKey = callback => {
    keyListeners.add(callback);
    return () => keyListeners.delete(callback);
  };
  const onDrag = callback => {
    dragListeners.add(callback);
    return () => dragListeners.delete(callback);
  };
  const stopKeyboard = () => {
    keys.clear();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = null;
  };
  const keyboardFrame = now => {
    frame = 0;
    if (disposed || document.hidden || ![...movementKeys].some(code => keys.has(code))) {
      lastTime = null;
      return;
    }
    if (!readCamera()) {
      stopKeyboard();
      return;
    }
    const delta = lastTime === null ? 0 : Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    const speed = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 3 : 1) * delta;
    const horizontal =
      Number(keys.has("KeyA") || keys.has("ArrowLeft")) - Number(keys.has("KeyD") || keys.has("ArrowRight"));
    const vertical = Number(keys.has("ArrowUp")) - Number(keys.has("ArrowDown"));
    const zoom = Number(keys.has("KeyS")) - Number(keys.has("KeyW"));
    if (horizontal || vertical || zoom) {
      camera.yaw += horizontal * 1.4 * speed;
      camera.pitch = clamp(camera.pitch + vertical * 1.2 * speed, -1.4, 1.4);
      camera.distance = clamp(camera.distance * Math.exp(zoom * 1.4 * speed), 1.5, 30);
      syncCamera();
    }
    frame = requestAnimationFrame(keyboardFrame);
  };
  const startKeyboard = () => {
    if (!frame && [...movementKeys].some(code => keys.has(code))) frame = requestAnimationFrame(keyboardFrame);
  };
  const isTyping = target =>
    target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]");
  const isStageActive = () => document.activeElement === stage || document.activeElement === canvas;
  const onKeyDown = event => {
    if (
      disposed ||
      document.hidden ||
      event.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      isTyping(event.target) ||
      !isStageActive()
    )
      return;
    if (!keys.has(event.code)) {
      keys.add(event.code);
      for (const callback of keyListeners) callback({ code: event.code, down: true, event });
      if (event.code === "KeyR" && readCamera()) {
        event.preventDefault();
        resetCamera();
      }
      if (movementKeys.has(event.code) && readCamera()) startKeyboard();
    }
    if (movementKeys.has(event.code) && readCamera()) event.preventDefault();
  };
  // ---- 키보드 입력 채널 ----
  // 뷰포트(stage·캔버스)에 포커스가 있고, 실행 중인 구성에 키보드 채널이 있을 때만 키를 셰이더에 넘긴다.
  // 이때는 앱의 한 글자 단축키(E·X·H·G·F·R·Space·/)와 카메라 키가 셰이더에 양보한다: window의 capture 단계에서 먼저 받아 전파를 멈춘다.
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
      stage.blur?.();
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
    if (movementKeys.has(event.code) && readCamera()) event.preventDefault();
  };
  const stopDrag = () => {
    if (pointerId === null) return;
    const id = pointerId;
    pointerId = null;
    canvas.classList.remove("is-dragging");
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  };
  // 캔버스가 별도 창으로 분리돼 있으면(popout.js) 메인 stage에 초점을 주지 않는다. 주면 분리 창의 키 입력(Space·Esc)을 메인이 가져간다.
  const focusStage = () => {
    if (stage.contains?.(canvas) !== false) stage.focus({ preventScroll: true });
  };
  const onPointerDown = event => {
    if (disposed || event.button !== 0 || pointerId !== null) return;
    focusStage();
    readCamera();
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
    if (readCamera()) {
      camera.yaw -= dx * 0.005;
      camera.pitch = clamp(camera.pitch - dy * 0.005, -1.4, 1.4);
      syncCamera();
    }
    for (const callback of dragListeners) callback({ dx, dy, yaw: camera.yaw, pitch: camera.pitch, event });
  };
  const onWheel = event => {
    if (disposed || !readCamera()) return;
    event.preventDefault();
    focusStage();
    const amount = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
    camera.distance = clamp(camera.distance * Math.exp(clamp(amount, -1000, 1000) * 0.001), 1.5, 30);
    syncCamera();
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
  listen(canvas, "wheel", onWheel, { passive: false });
  listen(window, "keydown", onShaderKeyDown, { capture: true });
  listen(window, "keyup", onShaderKeyUp, { capture: true });
  listen(stage, "focusin", syncHint);
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
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopKeyboard();
    stopDrag();
    controller.abort();
    keyListeners.clear();
    dragListeners.clear();
    canvas.classList.remove("is-dragging");
    canvas.style.touchAction = "";
  };
  return { isDown, onKey, onDrag, getCamera, setCamera, resetCamera, syncKeyboardHint: syncHint, dispose };
};
export { mount };
