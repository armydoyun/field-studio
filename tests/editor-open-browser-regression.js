// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 예제·과정 프로젝트를 열어도 편집기 열림 상태는 바뀌지 않는다(닫혀 있으면 닫힌 채, 열려 있으면 열린 채).
// 편집기는 사용자가 열 때, 또는 '코드를 연다'고 적힌 동작(기본 예제로 시작 · 빈 프로젝트 · 편집기에 삽입)에서만 열린다.
(async () => {
  const studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const editorOpen = () => !$("studioDock").hidden;
  const before = studio.getProject();
  const pickCard = async pattern => {
    $("galleryToggle").click();
    await frames(2);
    const card = [...$("gallery").querySelectorAll("button")].find(b => pattern.test(b.textContent));
    test(!!card, `갤러리에 ${pattern} 예제`);
    card.click();
    await frames(4);
  };
  try {
    if (editorOpen()) studio.close();
    await pickCard(/Keyboard Control/);
    test(!editorOpen(), "편집기를 닫은 채 예제를 열면 편집기는 닫힌 채");
    test(studio.getProject().imageChannels[1]?.keyboard === true, "예제는 열렸다");
    await pickCard(/Ray Marching/);
    test(!editorOpen(), "다른 예제로 바꿔도 닫힌 채");

    // 가이드의 과정 프로젝트 불러오기
    $("helpToggle").click();
    await frames(2);
    test($("quickHelp").open && $("guideNav").querySelectorAll("button[data-topic]").length > 0, "가이드 주제 목록");
    let load = null;
    for (const button of $("guideNav").querySelectorAll("button[data-topic]")) {
      button.click();
      await frames(1);
      load = [...$("quickHelp").querySelectorAll(".guide-project button")].find(b => /프로젝트 불러오기/.test(b.textContent));
      if (load) break;
    }
    test(!!load, "과정 주제에 '프로젝트 불러오기' 버튼");
    load.click();
    await frames(4);
    test(!$("quickHelp").open && !editorOpen(), "과정 프로젝트를 불러와도 편집기는 닫힌 채");
    test(studio.getProject().passes.length >= 1, "과정 프로젝트(버퍼 포함)가 열렸다");

    // 편집기를 연 상태라면 예제를 바꿔도 열린 채
    studio.open();
    await pickCard(/Keyboard Control/);
    test(editorOpen(), "편집기를 연 채 예제를 열면 열린 채");
    studio.close();

    // '코드를 연다'고 적힌 동작은 편집기를 연다
    test(/편집기를 열고/.test($("galleryStartBlank").textContent) && /코드를 열고/.test($("galleryStartDefault").textContent), "시작 카드 설명에 편집기·코드를 연다고 적혀 있다");
    $("galleryStartDefault").click();
    await frames(2);
    test(editorOpen(), "기본 예제로 시작: 코드를 연다");
    studio.close();
    await studio.insertCode({ main: "// editor-open test\n" });
    await frames(1);
    test(editorOpen(), "코드 조각 삽입은 넣은 코드를 보여 주려 편집기를 연다");
  } finally {
    if (!studio.setProject(before)) console.warn("테스트 이전 프로젝트 복원 실패");
    if ($("quickHelp").open) $("quickHelp").close();
    if (editorOpen()) studio.close();
  }
})();
