// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 화면 배치: 설정 패널 너비 조절 · 패널 자리(왼쪽·오른쪽) · 편집기 자리(미리보기의 왼쪽·오른쪽·위·아래) · 초기화.
// 손잡이 끌기는 포인터 이벤트로, 키보드 조작은 손잡이·경계에서 방향키로 확인한다.
(async () => {
  const studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const rect = id => $(id).getBoundingClientRect();
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const pointer = (el, type, x, y) =>
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y }));
  // 손잡이를 (x, y)까지 끌어 놓는다. 놓기 전 오버레이 상태를 돌려준다.
  const drag = async (grip, x, y, { cancel = false } = {}) => {
    const g = grip.getBoundingClientRect(), sx = g.left + g.width / 2, sy = g.top + g.height / 2;
    pointer(grip, "pointerdown", sx, sy);
    pointer(grip, "pointermove", sx + 2, sy + 2);
    const beforeThreshold = !!document.querySelector(".dock-overlay");
    pointer(grip, "pointermove", (sx + x) / 2, (sy + y) / 2);
    pointer(grip, "pointermove", x, y);
    const overlay = document.querySelector(".dock-overlay");
    const seen = { beforeThreshold, overlay: !!overlay, zones: overlay?.querySelectorAll(".dock-zone").length || 0, active: overlay?.querySelector(".dock-zone.is-active")?.dataset.side || null };
    if (cancel) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    pointer(grip, "pointerup", x, y);
    await frames(2);
    return seen;
  };
  const panelSide = () => (document.documentElement.classList.contains("panel-right") ? "right" : "left");
  const editorSide = () => ["left", "right", "top"].find(s => $("stage").classList.contains(`studio-layout-${s}`)) || "bottom";
  const panelWasHidden = document.body.classList.contains("panel-hidden");
  const editorWasOpen = !$("studioDock").hidden;
  try {
    test(window.innerWidth > 820, `넓은 창 (${window.innerWidth}px)`);
    $("layoutReset").click();
    document.body.classList.remove("panel-hidden");
    document.dispatchEvent(new Event("shader-panel-changed"));
    if (!editorWasOpen) studio.open();
    await frames(2);
    test(panelSide() === "left" && Math.round(rect("panel").width) === 300, "기본: 패널 왼쪽 · 300px");

    // ---- 1) 패널 너비 ----
    const handle = $("panelResize");
    test(handle.getAttribute("role") === "separator" && handle.tabIndex === 0, "패널 경계는 초점을 받는 separator");
    handle.focus();
    key(handle, "ArrowRight");
    await frames(1);
    test(Math.round(rect("panel").width) === 316 && handle.getAttribute("aria-valuenow") === "316", "→: 패널 16px 넓힘");
    key(handle, "Home");
    await frames(1);
    test(Math.round(rect("panel").width) === 240, "Home: 최소 240px");
    key(handle, "End");
    await frames(1);
    const max = Math.min(560, Math.round(window.innerWidth * 0.45));
    test(Math.round(rect("panel").width) === max, `End: 최대 ${max}px`);
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await frames(1);
    test(Math.round(rect("panel").width) === 300, "두 번 클릭: 기본 너비");
    const h = handle.getBoundingClientRect(), hx = h.left + h.width / 2, hy = h.top + 200;
    pointer(handle, "pointerdown", hx, hy);
    pointer(handle, "pointermove", hx + 60, hy);
    pointer(handle, "pointermove", hx + 100, hy);
    pointer(handle, "pointerup", hx + 100, hy);
    await frames(2);
    test(Math.abs(rect("panel").width - 400) <= 2, `경계를 끌어 너비 조절 (${Math.round(rect("panel").width)}px)`);
    test(JSON.parse(localStorage.getItem("field.panel.layout.v1")).width === 400, "직접 정한 너비는 저장");
    test(Math.abs(rect("panelResize").left - rect("panel").right) <= 1 && Math.abs(rect("stage").left - rect("panelResize").right) <= 1, "패널 · 너비 막대 · 미리보기가 빈틈 없이 이어진다");
    // 편집기 옆 배치 막대와 같은 모양(너비 · 배경 · 경계선 · 가운데 손잡이 선)
    const look = el => { const cs = getComputedStyle(el), grip = getComputedStyle(el, "::before"); return [Math.round(el.getBoundingClientRect().width), cs.backgroundColor, cs.borderLeftWidth, cs.borderRightWidth, cs.borderLeftColor, cs.cursor, grip.width, grip.height, grip.backgroundColor].join("|"); };
    if (!$("stage").classList.contains("studio-layout-right")) key($("studioDockGrip"), "ArrowRight");
    handle.blur();
    $("studioResize").blur();
    await frames(1);
    test(look($("panelResize")) === look($("studioResize")), `설정 패널 막대와 편집기 막대의 모양이 같다 (${look($("panelResize"))})`);

    // ---- 2) 패널 자리 ----
    const panelGrip = $("panelGrip");
    const ws = rect("workspace");
    const tiny = await drag(panelGrip, ws.left + 300, ws.top + 300, { cancel: true });
    test(!tiny.beforeThreshold && tiny.overlay && tiny.zones === 2, "패널 손잡이를 끌면(조금 움직인 뒤) 왼쪽·오른쪽 두 자리가 보인다");
    test(panelSide() === "left" && !document.querySelector(".dock-overlay"), "Esc로 그만두면 그대로");
    const toRight = await drag(panelGrip, ws.right - 20, ws.top + ws.height / 2);
    test(toRight.active === "right", "오른쪽 가장자리로 끌면 오른쪽 자리 강조");
    test(panelSide() === "right" && rect("panel").left > rect("stage").left, "놓으면 패널이 오른쪽으로");
    test(Math.abs(rect("panel").width - 400) <= 2, "자리를 옮겨도 너비 유지");
    handle.focus();
    key(handle, "ArrowLeft");
    await frames(1);
    test(Math.abs(rect("panel").width - 416) <= 2, "오른쪽 패널: ←가 넓힌다(경계를 그 방향으로 민다)");
    await drag(panelGrip, ws.left - 50, ws.top + 100);
    test(panelSide() === "right", "영역 밖에서 놓으면 바꾸지 않는다");
    panelGrip.focus();
    key(panelGrip, "ArrowLeft");
    await frames(1);
    test(panelSide() === "left" && rect("panel").left < rect("stage").left, "손잡이에서 ←: 패널 왼쪽으로");
    key(panelGrip, "ArrowUp");
    test(panelSide() === "left", "패널은 위·아래로 가지 않는다");

    // ---- 3) 편집기 자리 ----
    const grip = $("studioDockGrip");
    test(!!grip && grip.closest("#studioDock"), "편집기 머리에 손잡이");
    const st = rect("stage");
    const toLeft = await drag(grip, st.left + 15, st.top + st.height / 2);
    test(toLeft.zones === 4 && toLeft.active === "left", "편집기 손잡이: 네 자리 · 왼쪽 강조");
    test(editorSide() === "left" && rect("studioDock").right <= rect("renderViewport").left + 1, "놓으면 편집기가 미리보기 왼쪽으로");
    test($("studioResize").getAttribute("aria-orientation") === "vertical", "왼쪽 배치: 리사이저는 좌우로");
    const w0 = rect("studioDock").width;
    key($("studioResize"), "ArrowRight");
    await frames(1);
    test(rect("studioDock").width > w0, "왼쪽 배치: 경계에서 →가 편집기를 넓힌다");
    await drag(grip, st.left + st.width / 2, st.top + 10);
    test(editorSide() === "top" && rect("studioDock").bottom <= rect("renderViewport").top + 1, "위로 끌어 놓으면 편집기가 미리보기 위로");
    test($("studioResize").getAttribute("aria-orientation") === "horizontal", "위 배치: 리사이저는 위아래로");
    const h0 = rect("studioDock").height;
    key($("studioResize"), "ArrowDown");
    await frames(1);
    test(rect("studioDock").height > h0, "위 배치: 경계에서 ↓가 편집기를 키운다");
    $("studioLayout").click();
    await frames(1);
    test(editorSide() === "left", "메뉴의 배치 바꾸기: 위 ↔ 왼쪽");
    grip.focus();
    key(grip, "ArrowDown");
    await frames(1);
    test(editorSide() === "bottom" && rect("studioDock").top >= rect("renderViewport").bottom - 1, "손잡이에서 ↓: 아래 배치");
    key(grip, "ArrowRight");
    await frames(1);
    test(editorSide() === "right" && rect("studioDock").left >= rect("renderViewport").right - 1, "손잡이에서 →: 오른쪽 배치");
    test(JSON.parse(localStorage.getItem("webgl.shader-studio.layout.v1")).layout === "right", "편집기 자리 저장");
    const same = await drag(grip, st.right - 10, st.top + st.height / 2);
    test(same.active === "right" && editorSide() === "right", "지금 자리에 놓으면 그대로");

    // ---- 4) 초기화 ----
    await drag(grip, st.left + 15, st.top + st.height / 2);
    panelGrip.focus();
    key(panelGrip, "ArrowRight");
    $("layoutReset").click();
    await frames(2);
    test(panelSide() === "left" && Math.round(rect("panel").width) === 300, "초기화: 패널 왼쪽 · 300px");
    test(editorSide() === "right" && localStorage.getItem("webgl.shader-studio.layout.v1") === null && localStorage.getItem("field.panel.layout.v1") === null, "초기화: 편집기 기본 자리 · 저장값 삭제");
  } finally {
    $("layoutReset").click();
    document.body.classList.toggle("panel-hidden", panelWasHidden);
    document.dispatchEvent(new Event("shader-panel-changed"));
    if (!editorWasOpen && !$("studioDock").hidden) studio.close();
  }
})();
