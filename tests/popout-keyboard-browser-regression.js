// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 1) 설정 패널은 사용자가 직접 열고 닫는다: 편집기 열기·예제 선택·코드 조각 삽입·편집기 닫기로 패널 표시가 바뀌지 않는다.
// 2) 미리보기를 별도 창으로 분리해도 키보드 채널 셰이더에 키가 전달된다(분리 창의 캔버스에 초점).
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const panelHidden = () => document.body.classList.contains("panel-hidden");
  const before = studio.getProject();
  const wasRunning = r.getStats().running;
  let popoutWin = null;
  try {
    if (!wasRunning) studio.togglePlayback();
    // ---- 1) 설정 패널 ----
    test(window.innerWidth > 820, `패널이 옆에 놓이는 창 (${window.innerWidth}px)`);
    if (panelHidden()) $("panelToggle").click();
    if (!$("studioDock").hidden) $("studioHide").click();
    studio.open();
    await frames(1);
    test(!panelHidden(), "편집기를 열어도 설정 패널이 그대로 열려 있다");
    $("galleryToggle").click();
    await frames(2);
    const card = [...$("gallery").querySelectorAll("button")].find(b => /Keyboard Control/.test(b.textContent));
    test(!!card, "갤러리에 Keyboard Control 예제");
    card.click();
    await frames(4);
    test(!panelHidden(), "예제를 골라도 설정 패널이 그대로 열려 있다");
    test(!$("studioDock").hidden, "편집기는 열린 채");
    test(r.usesKeyboard(), "렌더러가 키보드 사용을 인식");
    studio.insertCode({ main: "// popout-keyboard test\n" });
    await frames(1);
    test(!panelHidden(), "코드 조각 삽입 뒤에도 설정 패널이 그대로 열려 있다");

    $("studioHide").click();
    await frames(1);
    test(!panelHidden(), "편집기를 닫아도 설정 패널이 그대로");
    $("panelToggle").click();
    studio.open();
    await frames(1);
    test(panelHidden(), "사용자가 닫은 패널은 편집기를 열어도 닫힌 채");
    $("studioHide").click();
    await frames(1);
    test(panelHidden(), "편집기를 닫아도 패널이 저절로 열리지 않는다");
    $("panelToggle").click();

    // ---- 2) 분리 창 키보드 ----
    // 헤드리스에서는 PiP 창을 사용자 동작 없이 못 만들므로 일반 팝업 경로로 연다.
    delete Window.prototype.documentPictureInPicture;
    delete window.documentPictureInPicture;
    popoutWin = await window.shaderPopout.open();
    await frames(2);
    const canvas = $("screen") || popoutWin.document.getElementById("screen");
    test(canvas.ownerDocument === popoutWin.document, "캔버스가 분리 창으로 옮겨짐");
    test(popoutWin.document.activeElement === canvas, "분리 창을 열면 캔버스에 초점");
    const key = (type, k, keyCode) =>
      popoutWin.document.activeElement.dispatchEvent(new popoutWin.KeyboardEvent(type, { key: k, keyCode, bubbles: true, cancelable: true }));
    key("keydown", "ArrowRight", 39);
    test(r.readKey(39) === 1, "분리 창에서 → 누름이 셰이더로 전달됨");
    key("keyup", "ArrowRight", 39);
    await frames(1);
    test(r.readKey(39) === 0, "분리 창에서 → 뗌");
    const toggled = r.readKey(32, 2);
    key("keydown", " ", 32);
    key("keyup", " ", 32);
    await frames(1);
    test(r.getStats().running && r.readKey(32, 2) !== toggled, "키보드 입력 중 Space는 재생/정지 대신 셰이더로 간다");
    key("keydown", "Escape", 27);
    await frames(1);
    test(popoutWin.document.activeElement !== canvas && !popoutWin.closed, "Esc → 캔버스에서 빠져나옴(창은 그대로)");
    key("keydown", "ArrowRight", 39);
    test(r.readKey(39) === 0, "빠져나온 뒤에는 키를 넘기지 않음");
    key("keyup", "ArrowRight", 39);
    canvas.dispatchEvent(new popoutWin.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse" }));
    canvas.dispatchEvent(new popoutWin.PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse" }));
    test(popoutWin.document.activeElement === canvas, "캔버스를 누르면 다시 키보드 입력");
    window.shaderPopout.close();
    popoutWin = null;
    await frames(1);
    test($("screen").ownerDocument === document && !$("screen").hasAttribute("tabindex"), "되돌리면 캔버스가 메인 창으로 · tabindex 정리");
    $("stage").focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", keyCode: 37, bubbles: true, cancelable: true }));
    test(r.readKey(37) === 1, "되돌린 뒤 메인 창 키보드 입력도 그대로 동작");
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", keyCode: 37, bubbles: true, cancelable: true }));
    $("stage").blur();
  } finally {
    if (popoutWin) window.shaderPopout.close();
    if (!studio.setProject(before)) console.warn("테스트 이전 프로젝트 복원 실패");
    if (!wasRunning && r.getStats().running) studio.togglePlayback();
  }
})();
