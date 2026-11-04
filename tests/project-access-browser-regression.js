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
    const chips = [0, 1, 2, 3].map(i => $(`studioChannel${i}`));
    test(chips.every(visible), "iChannel0–3 칩 4개");
    const rows = new Set(chips.map(c => Math.round(c.getBoundingClientRect().top)));
    test(rows.size <= 2, "칩은 한두 줄 안에 들어감");
    test(chips[0].dataset.kind === "buffer" && /A\s*cur/.test(chips[0].textContent) && chips[2].dataset.kind === "empty", "칩: 버퍼는 배지·시점, 빈 칸은 ＋");

    // 칩을 누르면 팝오버: 시점 · 버퍼 · 이미지 · 해제. 키보드로 이동하고 Esc로 닫는다.
    chips[1].click();
    await frame();
    const picker = $("studioChannelPicker");
    test(visible(picker) && chips[1].getAttribute("aria-expanded") === "true", "칩 → 고르기 팝오버");
    test(picker.querySelector('[data-frame="previous"]') && picker.querySelector('[data-value="A:current"]'), "시점과 버퍼 선택지");
    test(document.activeElement && picker.contains(document.activeElement), "팝오버 안으로 포커스");
    const pbox = picker.getBoundingClientRect(), dock = $("studioDock").getBoundingClientRect();
    test(pbox.left >= dock.left - 1 && pbox.right <= dock.right + 1, "팝오버가 편집기 폭 안에");
    test(document.elementFromPoint(pbox.left + pbox.width / 2, pbox.top + pbox.height / 2)?.closest("#studioChannelPicker"), "팝오버가 코드 위에 보임");
    picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    test(picker.hidden && document.activeElement === chips[1], "Esc → 닫고 칩으로");

    // 이미지 불러오기…를 고르면 파일 고르기가 열리고, 연결은 그대로다
    let picked = 0;
    const input = $("studioTextureFile"), click = input.click;
    input.click = () => { picked++; };
    const old = chips[1].value;
    chips[1].click();
    await frame();
    picker.querySelector('[data-value="load"]').click();
    input.click = click;
    test(picked === 1 && $("studioChannel1").value === old && picker.hidden, "이미지 불러오기… → 파일 고르기, 연결 유지");

    // 버퍼 고르기 → 칩에 배지·시점 표시
    chips[1].click();
    await frame();
    picker.querySelector('[data-frame="previous"]').click();
    picker.querySelector('[data-value="A:previous"]').click();
    await frame();
    test($("studioChannel1").value === "A:previous" && /A\s*prev/.test($("studioChannel1").textContent), "A previous 연결 → 칩에 A prev");

    // 이미지 파일을 칩에 끌어다 놓으면 그 채널에 연결된다
    const canvas = Object.assign(document.createElement("canvas"), { width: 2, height: 2 });
    canvas.getContext("2d").fillRect(0, 0, 2, 2);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    const drop = new DataTransfer();
    drop.items.add(new File([blob], "drop-test.png", { type: "image/png" }));
    chips[2].dispatchEvent(new DragEvent("dragover", { dataTransfer: drop, bubbles: true, cancelable: true }));
    chips[2].dispatchEvent(new DragEvent("drop", { dataTransfer: drop, bubbles: true, cancelable: true }));
    for (let i = 0; i < 50 && !studio.getProject().imageChannels[2]?.texture; i++) await new Promise(r => setTimeout(r, 50));
    test(!!studio.getProject().imageChannels[2]?.texture && $("studioChannel2").dataset.kind === "image", "칩에 이미지 드롭 → 그 채널에 연결");
    test(studio.getProject().imageChannels[0]?.buffer === "A", "다른 채널 연결은 그대로");

    // 패스 탭 title에 입력 요약
    test(/iChannel0 ← Buffer A/.test($("studioTab-Image").title), "Image 탭 title에 입력 요약");

    // 패스 연결 그래프는 성능 탭에서, 누르면 편집기에서 그 패스를 연다
    test($("view-profile").contains($("studioGraph")), "패스 연결 그래프는 성능 탭에");
    const row = [...$("studioGraph").querySelectorAll("button")].find(b => /Buffer A/.test(b.textContent));
    $("studioHide").click();
    row.click();
    await frame();
    test(!$("studioDock").hidden && $("studioTab-A").getAttribute("aria-selected") === "true", "그래프에서 누르면 편집기에서 A 열림");

    // 편집기가 열려 있어도 메뉴는 미리보기에 잘리지 않고 편집기 위로 올라온다(미리보기 영역은 overflow:hidden).
    $("projectMenuToggle").click();
    await frame();
    const box = $("projectMenu").getBoundingClientRect();
    test(box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight, "메뉴가 창 안에 들어옴");
    const points = [[box.left + 10, box.top + 10], [box.right - 10, box.top + box.height / 2], [box.left + box.width / 2, box.bottom - 10]];
    test(points.every(([x, y]) => document.elementFromPoint(x, y)?.closest("#projectMenu")), "메뉴의 어느 곳도 편집기·손잡이에 가려지지 않음");
    $("projectMenuToggle").click();
  } finally {
    if (!studio.setProject(before)) console.warn("테스트 이전 프로젝트 복원 실패");
  }
})();
