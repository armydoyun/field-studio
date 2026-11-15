// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 우클릭 메뉴(js/context-menu.js + 각 모듈이 등록한 영역 메뉴):
//  · 영역마다 알맞은 메뉴가 포인터 자리에 뜬다(뷰포트 · 파라미터 줄 · 파라미터 빈 곳 · 프리셋 칩 · 패스 탭 · 편집기 · 타임라인 키 · 레인 · 바탕)
//  · 글 입력 칸 · 선택한 글자 · Shift+우클릭은 브라우저 기본 메뉴를 그대로 둔다
//  · 항목은 실제 동작을 한다(잠금 · 잇기 · 시간 기준 · 키 추가) · Esc · 바깥 누르기로 닫힌다
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    settings = window.shaderSettings,
    $ = id => document.getElementById(id);
  const check = (ok, label) => {
    if (!ok) throw new Error(label);
    console.log(`PASS ${label}`);
  };
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const menu = () => document.querySelector("body > .ui-context-menu");
  const labels = () => [...(menu()?.querySelectorAll(".ui-menu-item") || [])].map(node => node.textContent.trim());
  const item = text => [...(menu()?.querySelectorAll(".ui-menu-item") || [])].find(node => node.textContent.trim().startsWith(text));
  const closeMenu = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const right = (node, { shiftKey = false, dx, dy } = {}) => {
    const box = node.getBoundingClientRect(),
      event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        shiftKey,
        clientX: box.left + (dx ?? box.width / 2),
        clientY: box.top + (dy ?? box.height / 2),
      });
    node.dispatchEvent(event);
    return event;
  };
  const before = studio.getProject(),
    users = r.getUserUniforms(),
    links = settings.getLinks(),
    presets = settings.getPresets(),
    editorOpen = !$("studioDock").hidden,
    timelineOpen = !$("timelineDock").hidden,
    panelHidden = document.body.classList.contains("panel-hidden");
  try {
    check(
      studio.setProject({
        image:
          "uniform float uRadius; // @range 0.1 0.4 @default 0.2\nuniform vec3 uTint; // @color @default 1 0.5 0.25\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(uTint * uRadius, 1.0); }",
        passes: [],
        imageChannels: {},
      }),
      "우클릭 검사 장면"
    );
    settings.setLinks([
      { name: "uRadius", source: "keys", min: 0, max: 1, smooth: 0, keys: [[0.1, 0.1], [0.5, 0.3]], loop: 0, ease: "smooth" },
    ]);
    settings.setPresets([{ name: "낮", values: { uRadius: 0.3 } }]);
    if (panelHidden) $("panelToggle").click();
    $("tab-uniforms").click();
    if ($("studioDock").hidden) studio.open();
    if ($("timelineDock").hidden) $("timelineToggle").click();
    await frames();

    // 뷰포트
    let event = right($("screen"));
    check(event.defaultPrevented && menu(), "뷰포트: 기본 메뉴 대신 앱 메뉴");
    check(["일시정지", "재생"].some(text => labels()[0].startsWith(text)) && labels().some(text => text.startsWith("스크린샷 저장")), "뷰포트 메뉴: 재생 · 캡처");
    const box = menu().getBoundingClientRect(),
      screen = $("screen").getBoundingClientRect();
    check(Math.abs(box.left - (screen.left + screen.width / 2)) <= 1 || box.right <= innerWidth - 7, "포인터 자리에 열림");
    check(document.activeElement === menu(), "포인터로 열면 메뉴 자체에 초점(첫 항목을 고른 것처럼 보이지 않음)");
    closeMenu();
    check(!menu(), "Esc로 닫힘");

    // 파라미터 줄 · 실제 동작(잠금)
    const row = document.querySelector('.uniform-row[data-name="uTint"]');
    right(row.querySelector(".uniform-top"));
    check(labels().includes("값을 GLSL로 복사") && labels().includes("파라미터 삭제"), "파라미터 줄 메뉴: 복사 · 삭제");
    check(menu().querySelector(".ui-menu-title").textContent === "uTint · vec3", "파라미터 줄 메뉴 제목");
    item("잠금").click();
    await frames();
    check(document.querySelector('.uniform-row[data-name="uTint"] .lock-uniform').getAttribute("aria-pressed") === "true", "메뉴로 잠금");
    right(document.querySelector('.uniform-row[data-name="uTint"] .uniform-top'));
    check(item("잠금").getAttribute("aria-pressed") === "true", "잠금 상태가 체크로 보임");
    item("잠금").click();
    await frames();

    // 파라미터 빈 곳 · 프리셋 칩
    right(document.querySelector("#view-uniforms .parameter-toolbar"), { dx: 150 });
    check(labels().includes("전체 무작위") && labels().includes("파라미터 추가…"), "파라미터 빈 곳: 일괄 작업");
    closeMenu();
    right(document.querySelector("#presetList .preset-chip"));
    check(labels().join() === "적용,지금 값으로 덮어쓰기…,이름 바꾸기…,삭제", "프리셋 칩: 적용 · 관리");
    closeMenu();

    // 패스 탭 · 편집기
    right(document.querySelector("#studioPassTabs [role=tab]"));
    check(labels().some(text => text.startsWith("새 버퍼 패스 추가")), "패스 탭 메뉴");
    check(item("삭제")?.disabled, "Image 패스는 삭제할 수 없음");
    closeMenu();
    right(document.querySelector(".studio-cm-host .cm-content"));
    check(labels().some(text => text.startsWith("정의로 이동")) && labels().some(text => text.startsWith("명령 팔레트")), "편집기 메뉴");
    check(item("복사").disabled, "선택이 없으면 복사는 꺼짐");
    closeMenu();

    // 타임라인: 키 잇기 · 레인 시간 기준 · 빈 곳에 키 추가
    const key = () => document.querySelector('.timeline-lane[data-name="uRadius"] .timeline-key');
    right(key());
    check(labels().includes("직선") && labels().some(text => text.startsWith("키 지우기")), "타임라인 키 메뉴");
    item("직선").click();
    await frames();
    check(settings.getLinks()[0].keys[0][2] === "linear", "메뉴로 키 잇기 바꿈");
    right(document.querySelector('.timeline-lane[data-name="uRadius"] .timeline-lane-head'));
    item("반복 · 처음으로 잇기").click();
    await frames();
    check(settings.getLinks()[0].loop > 0 && settings.getLinks()[0].wrap, "레인 머리 메뉴로 시간 기준 바꿈");
    const area = document.querySelector('.timeline-lane[data-name="uRadius"] .timeline-area');
    right(area, { dx: area.clientWidth * 0.12 });
    const count = settings.getLinks()[0].keys.length;
    item("여기에 키 추가").click();
    await frames();
    check(settings.getLinks()[0].keys.length === count + 1, "레인 빈 곳에서 키 추가");

    // 바탕
    right($("panelTabs"));
    check(labels().some(text => text.startsWith("예제 갤러리")) && labels().some(text => text.startsWith("타임라인")), "바탕 메뉴");
    closeMenu();

    // 기본 메뉴를 남기는 곳
    check(!right($("uniformSearch")).defaultPrevented && !menu(), "글 입력 칸은 브라우저 기본 메뉴");
    check(!right($("screen"), { shiftKey: true }).defaultPrevented && !menu(), "Shift+우클릭은 브라우저 기본 메뉴");
    const hint = document.querySelector("#view-uniforms .ui-section-head h2");
    getSelection().selectAllChildren(hint);
    check(!right(hint).defaultPrevented, "선택한 글자 위는 복사할 수 있게 기본 메뉴");
    getSelection().removeAllRanges();
    right($("screen"));
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    check(!menu(), "바깥을 누르면 닫힘");
  } finally {
    closeMenu();
    menu()?.remove();
    settings.setLinks(links);
    settings.setPresets(presets);
    studio.setProject(before);
    r.setUserUniforms(users);
    if (editorOpen !== !$("studioDock").hidden) editorOpen ? studio.open() : studio.close();
    if (timelineOpen === $("timelineDock").hidden) $("timelineToggle").click();
    if (panelHidden !== document.body.classList.contains("panel-hidden")) $("panelToggle").click();
  }
})();
