// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 편집기 사이드바를 없애고 기능을 쓰는 자리로 옮긴 뒤의 계약:
//   프로젝트·이미지 → 머리줄 프로젝트 메뉴(Ctrl+O · Ctrl+Shift+S) · 입력 채널 → 편집기 입력 줄 · 패스 연결 → 성능 탭 · 팔레트 → 어디서나
(async () => {
  const studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const key = (k, mods = {}) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const before = studio.getProject();
  try {
    test(!$("studioTools") && !$("studioToolsToggle"), "편집기 사이드바와 도구 서랍 버튼 없음");
    studio.close?.();
    if (!$("studioDock").hidden) $("studioHide").click();
    test($("studioDock").hidden, "편집기 닫힌 상태에서 시작");

    // 프로젝트 메뉴: 편집기를 열지 않고 바로
    test(visible($("projectMenuToggle")), "머리줄에 프로젝트 메뉴 버튼");
    $("projectMenuToggle").click();
    await frame();
    test(visible($("projectMenu")) && visible($("studioProjectSave")) && visible($("studioTextureAdd")), "메뉴에 저장·이미지 기능");
    test($("projectMenuToggle").getAttribute("aria-expanded") === "true", "메뉴 열림 표시");
    $("projectMenu").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    test($("projectMenu").hidden, "Esc로 닫힘");
    key("o", { ctrlKey: true });
    test(!$("projectMenu").hidden, "Ctrl+O로 열림");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    test($("projectMenu").hidden, "바깥을 누르면 닫힘");
    test($("studioDock").hidden, "메뉴를 써도 편집기는 닫힌 채");

    // Ctrl+Shift+S: 보관함 저장 → 이름 입력 대화상자
    key("S", { ctrlKey: true, shiftKey: true });
    await frame();
    const dialog = $("studioPromptDialog");
    test(dialog?.open, "Ctrl+Shift+S → 저장 이름 묻기");
    $("studioDialogCancel").click();
    await frame();

    // 명령 팔레트: 편집기가 닫혀 있어도 한 번에
    key("P", { ctrlKey: true, shiftKey: true });
    await frame();
    const palette = document.querySelector(".studio-palette");
    test(!$("studioDock").hidden && palette && !palette.hidden, "Ctrl+Shift+P → 편집기 열고 팔레트 표시");
    palette.querySelector("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await frame();

    // 입력 줄: 선택한 패스의 iChannel0–3이 코드 위에 늘 보인다
    const fragment = "#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){fragColor=vec4(1.);}";
    test(studio.setProject({ image: fragment, passes: [{ name: "A", fragment, format: "rgba8", scale: 1, channels: {} }], imageChannels: { 0: { buffer: "A", frame: "current" } } }), "버퍼 하나 있는 프로젝트");
    await frame();
    test(visible($("studioInputs")), "입력 줄 표시");
    const selects = [0, 1, 2, 3].map(i => $(`studioChannel${i}`));
    test(selects.every(visible), "iChannel0–3 칩 4개");
    test(selects.every(s => [...s.options].some(o => o.value === "load")), "칩마다 이미지 불러오기…");
    test(/A/.test(selects[0].title), "칩 title에 연결 설명");

    // 이미지 불러오기…를 고르면 파일 고르기가 열리고, 선택은 원래대로 돌아간다
    let picked = 0;
    const input = $("studioTextureFile"), click = input.click;
    input.click = () => { picked++; };
    const old = selects[1].value;
    selects[1].value = "load";
    selects[1].dispatchEvent(new Event("change", { bubbles: true }));
    input.click = click;
    test(picked === 1 && $("studioChannel1").value === old, "이미지 불러오기… → 파일 고르기, 선택 유지");

    // 패스 탭 title에 입력 요약
    test(/iChannel0 ← Buffer A/.test($("studioTab-Image").title), "Image 탭 title에 입력 요약");

    // 패스 연결 그래프는 성능 탭에서, 누르면 편집기에서 그 패스를 연다
    test($("view-profile").contains($("studioGraph")), "패스 연결 그래프는 성능 탭에");
    const row = [...$("studioGraph").querySelectorAll("button")].find(b => /Buffer A/.test(b.textContent));
    $("studioHide").click();
    row.click();
    await frame();
    test(!$("studioDock").hidden && $("studioTab-A").getAttribute("aria-selected") === "true", "그래프에서 누르면 편집기에서 A 열림");
  } finally {
    if (!studio.setProject(before)) console.warn("테스트 이전 프로젝트 복원 실패");
  }
})();
