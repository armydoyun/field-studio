// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 키보드 입력 채널: 갤러리 예제(Keyboard Control)를 열고, 뷰포트에 포커스를 준 채 키를 눌러
// 셰이더가 읽는 키 상태 텍스처·상태 버퍼가 바뀌는지, 앱 단축키가 양보하는지, Esc로 빠져나오는지 본다.
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const key = (type, k, keyCode) => window.dispatchEvent(new KeyboardEvent(type, { key: k, keyCode, bubbles: true, cancelable: true }));
  const before = studio.getProject();
  const wasRunning = r.getStats().running;
  try {
    if (!wasRunning) studio.togglePlayback();
    // 갤러리 예제 열기
    $("galleryToggle").click();
    await frames(2);
    const card = [...$("gallery").querySelectorAll("button")].find(b => /Keyboard Control/.test(b.textContent));
    test(!!card, "갤러리에 Keyboard Control 예제");
    card.click();
    await frames(4);
    const project = studio.getProject();
    test(project.passes[0]?.channels?.[1]?.keyboard === true && project.imageChannels[1]?.keyboard === true, "예제가 키보드 채널을 연결");
    test(r.usesKeyboard(), "렌더러가 키보드 사용을 인식");
    if (!$("studioDock").hidden) $("studioHide").click();

    // 뷰포트 포커스 전에는 키가 셰이더로 가지 않는다
    key("keydown", "ArrowRight", 39);
    test(r.readKey(39) === 0, "포커스 없으면 키를 넘기지 않음");
    key("keyup", "ArrowRight", 39);

    // 뷰포트를 클릭해 포커스 → 키보드 입력 모드
    $("stage").focus();
    await frames(1);
    test(!$("keyboardHint").hidden, "키보드 입력 중 표시");
    const read = () => r.readPassPixel("A", 0, 0);
    await frames(3);
    const start = read();
    key("keydown", "ArrowRight", 39);
    test(r.readKey(39) === 1 && r.readKey(39, 1) === 1, "→ 누름: y=0 · y=1");
    await frames(20);
    test(r.readKey(39, 1) === 0, "이번 프레임에 눌림(y=1)은 한 프레임 뒤 지워짐");
    const moved = read();
    test(moved[0] > start[0] + 0.01, `→를 누르는 동안 점이 오른쪽으로 이동 (${start[0].toFixed(3)} → ${moved[0].toFixed(3)})`);
    key("keyup", "ArrowRight", 39);
    await frames(2);
    test(r.readKey(39) === 0, "→ 뗌");

    // Space: 토글(y=2)과 누른 횟수
    const toggledBefore = read()[2];
    key("keydown", " ", 32);
    key("keyup", " ", 32);
    await frames(4);
    const afterSpace = read();
    test(Math.abs(afterSpace[2] - toggledBefore) > 0.5 && r.readKey(32, 2) === (toggledBefore > 0.5 ? 0 : 1), "Space → 토글 바뀜");
    test(afterSpace[3] >= 1, "Space 누른 횟수 기록(이번 프레임에 눌림)");

    // 한 글자 단축키는 셰이더에 양보: E를 눌러도 편집기가 열리지 않는다
    key("keydown", "e", 69);
    key("keyup", "e", 69);
    await frames(1);
    test($("studioDock").hidden, "키보드 입력 중에는 E가 편집기를 열지 않음");
    test(r.readKey(69, 2) === 1, "E는 셰이더로 전달됨");

    // Esc: 빠져나오고 단축키가 돌아온다
    key("keydown", "Escape", 27);
    await frames(1);
    test(document.activeElement !== $("stage") && $("keyboardHint").hidden, "Esc → 뷰포트에서 빠져나옴");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", keyCode: 69, bubbles: true, cancelable: true }));
    await frames(1);
    test(!$("studioDock").hidden, "빠져나온 뒤에는 E가 편집기를 엶");
    $("studioHide").click();

    // 키가 눌린 채 포커스를 잃어도 남지 않는다
    $("stage").focus();
    key("keydown", "ArrowLeft", 37);
    test(r.readKey(37) === 1, "← 누름");
    $("stage").blur();
    await frames(1);
    test(r.readKey(37) === 0, "포커스를 잃으면 눌린 키를 모두 뗌");
    key("keyup", "ArrowLeft", 37);

    // 뷰포트 안의 UI(툴바·편집기)에서 초점을 못 받는 곳을 눌러 초점이 #stage로 떨어져도 키보드 입력 모드가 되지 않는다
    test($("studioDock").tabIndex === -1, "편집기 창은 tabindex=-1 (빈 곳을 눌러도 초점이 창에 머묾)");
    $("stageToolbar").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    $("stage").focus(); // 브라우저가 초점을 가장 가까운 조상(#stage)으로 넘기는 상황
    await frames(1);
    test(document.activeElement !== $("stage") && $("keyboardHint").hidden, "툴바 UI를 누른 뒤 떨어진 초점은 뷰포트 선택이 아님");
    await new Promise(resolve => setTimeout(resolve, 0));
    $("screen").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse" }));
    $("screen").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse" }));
    await frames(1);
    test(document.activeElement === $("stage") && !$("keyboardHint").hidden, "캔버스를 누르면 그대로 키보드 입력 모드");
    key("keydown", "Escape", 27);
  } finally {
    if (!studio.setProject(before)) console.warn("테스트 이전 프로젝트 복원 실패");
    if (!wasRunning && r.getStats().running) studio.togglePlayback();
  }
})();
