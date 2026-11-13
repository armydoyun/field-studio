// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 패널 크기를 마음대로 바꿔도 화면이 찌그러지지 않는지: 편집기 옆 배치의 최소 폭(편집기 340px · 미리보기 240px),
// 미리보기 영역이 좁으면 편집기를 잠시 아래로 내렸다가 넓어지면 되돌리기, 좁은 미리보기의 도구 막대 한 줄 · 통계 겹침 없음,
// 좁은 편집기의 창 도구 한 줄, 좁은 타임라인 막대.
(async () => {
  const studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const rect = node => (typeof node === "string" ? $(node) : node).getBoundingClientRect();
  const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  const workspace = $("workspace"), stage = $("stage");
  const panelWidth = workspace.style.getPropertyValue("--panel-width");
  const editorWasOpen = !$("studioDock").hidden, panelWasHidden = document.body.classList.contains("panel-hidden");
  const layoutBefore = localStorage.getItem("webgl.shader-studio.layout.v1");
  // 설정 패널 너비를 바꾸듯 미리보기 영역(#stage)의 폭을 정한다.
  const stageWidth = async width => {
    workspace.style.setProperty("--panel-width", `${Math.max(0, workspace.clientWidth - 6 - width)}px`);
    await frames(3);
  };
  try {
    document.body.classList.remove("panel-hidden");
    if (!editorWasOpen) studio.open();
    studio.setLayout?.("right");
    if (!stage.classList.contains("studio-layout-right")) $("studioDockGrip").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await frames(2);
    test(stage.classList.contains("studio-layout-right"), "편집기 오른쪽 배치");

    // ---- 1) 넓은 미리보기 영역: 비율을 끝까지 키워도 미리보기 240px · 편집기 340px 이상 ----
    await stageWidth(760);
    const handle = $("studioResize");
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    await frames(2);
    test(rect("renderViewport").width >= 239, `편집기를 최대로 넓혀도 미리보기 240px 이상 (${Math.round(rect("renderViewport").width)}px)`);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    await frames(2);
    test(rect("studioDock").width >= 339, `편집기를 최소로 줄여도 340px 이상 (${Math.round(rect("studioDock").width)}px)`);
    test(rect("studioDock").right <= rect(stage).right + 1, "편집기가 미리보기 영역 밖으로 넘치지 않음");

    // 좁은 편집기: 창 도구(실행 · 닫기 포함)가 한 줄에 모두 보이고 서로 겹치지 않는다.
    const tools = [...document.querySelectorAll(".studio-window-tools button, .studio-window-tools label")].filter(node => node.getBoundingClientRect().width > 0);
    const dock = rect("studioDock");
    for (const node of tools) test(rect(node).left >= dock.left - 1 && rect(node).right <= dock.right + 1, `좁은 편집기: ${node.id || node.className} 잘리지 않음`);
    for (let i = 0; i < tools.length; i++) for (let j = i + 1; j < tools.length; j++)
      if (!tools[i].contains(tools[j]) && !tools[j].contains(tools[i])) test(!overlaps(rect(tools[i]), rect(tools[j])), `좁은 편집기: ${tools[i].id || tools[i].className} · ${tools[j].id || tools[j].className} 겹치지 않음`);
    test(new Set(tools.map(node => Math.round(rect(node).top))).size <= 2 && Math.max(...tools.map(node => rect(node).bottom)) - Math.min(...tools.map(node => rect(node).top)) < 40, "좁은 편집기: 창 도구는 한 줄");

    // 좁은 미리보기: 도구 막대는 한 줄, 통계 칸은 서로 겹치지 않는다.
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    await frames(2);
    test(rect("stageToolbar").height < 48, `좁은 미리보기: 도구 막대 한 줄 (${Math.round(rect("stageToolbar").height)}px)`);
    test(rect("stageToolbar").right <= rect("renderViewport").right + 1 && rect("stageToolbar").left >= rect("renderViewport").left - 1, "좁은 미리보기: 도구 막대가 미리보기 안에");
    const stats = [...document.querySelectorAll("#stats .stat-item")].filter(node => node.getBoundingClientRect().width > 0);
    for (const item of stats) for (const part of item.children) test(rect(part).right <= rect(item).right + 1, `좁은 미리보기: ${item.firstElementChild.textContent} 칸 내용이 칸 안에`);
    test(rect("stats").right <= rect("renderViewport").right + 1, "좁은 미리보기: 통계가 미리보기 안에");

    // ---- 2) 좁은 미리보기 영역: 편집기를 잠시 아래로 내리고, 넓어지면 되돌린다 ----
    await stageWidth(540);
    test(!stage.classList.contains("studio-layout-right") && stage.classList.contains("studio-layout-stacked"), "옆 배치가 들어갈 폭이 없으면 편집기를 아래로");
    test(rect("studioDock").top >= rect("renderViewport").bottom - 1 && Math.abs(rect("studioDock").width - rect(stage).width) <= 1, "아래 배치: 편집기가 미리보기 아래 전체 폭");
    test(JSON.parse(localStorage.getItem("webgl.shader-studio.layout.v1") || "{}").layout === "right", "사용자가 고른 배치(오른쪽)는 그대로 저장");
    test($("studioResize").getAttribute("aria-orientation") === "horizontal", "내린 동안 리사이저는 위아래로");
    await stageWidth(610);
    test(stage.classList.contains("studio-layout-stacked"), "경계 근처에서는 바로 되돌리지 않는다(깜빡임 방지)");
    await stageWidth(760);
    test(stage.classList.contains("studio-layout-right") && !stage.classList.contains("studio-layout-stacked"), "다시 넓어지면 원래 자리(오른쪽)로");
  } finally {
    workspace.style.setProperty("--panel-width", panelWidth);
    if (layoutBefore === null) localStorage.removeItem("webgl.shader-studio.layout.v1");
    else localStorage.setItem("webgl.shader-studio.layout.v1", layoutBefore);
    if (!editorWasOpen) studio.close?.();
    document.body.classList.toggle("panel-hidden", panelWasHidden);
    await frames(2);
  }
  console.log("resize-fit browser regression: OK");
})();
