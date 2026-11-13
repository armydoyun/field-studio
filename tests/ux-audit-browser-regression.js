// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// UX 검수(까다로운 CEO 기준)에서 고친 약속들:
//  · 처음 여는 탭은 파라미터 · 기본 폭(300px)에서 탭은 한 줄 · 파라미터가 첫 화면 위쪽에 보인다
//  · 설정 패널 버튼은 도구 막대에 바로 · 카메라는 한 번에 스크린샷(▾는 메뉴)
//  · 바뀐 작업이 있으면 프로젝트 이름 옆에 '저장' 버튼(누르면 바로 저장 흐름)
//  · 연결 방식을 눌러 비교해도 앞서 만든 설정이 지워지지 않는다 · 키프레임을 고르면 타임라인이 그 레인과 함께 열린다
//  · 미리보기 통계는 FPS 한 칸만 보이다가 누르면 펼친다 · 프리셋은 이름을 묻지 않고 바로 저장
(async () => {
  const autoAnswer = setInterval(() => { const d = document.getElementById("studioPromptDialog"), alt = document.getElementById("studioDialogAlt"); if (d?.open && !alt.hidden) alt.click(); }, 50);
  const studio = window.shaderStudio, settings = window.shaderSettings, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return; throw new Error(`FAIL: 시간 초과 — ${label}`); };
  const visible = node => !!node && node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== "hidden";
  const before = studio.getProject(), linksBefore = settings.getLinks(), timelineWasOpen = !$("timelineDock").hidden;
  try {
    // ---- 탭 · 첫 화면 ----
    test($("tab-uniforms").classList.contains("is-active") && !$("view-uniforms").hidden, "처음 여는 탭은 파라미터");
    test($("panelTabs").firstElementChild === $("tab-uniforms"), "파라미터 탭이 맨 앞");
    const tops = [...$("panelTabs").children].map(tab => Math.round(tab.getBoundingClientRect().top));
    test(new Set(tops).size === 1, `기본 폭에서 탭은 한 줄 (${tops})`);
    test(!document.querySelector(".view-intro"), "탭 이름을 되풀이하는 소개 블록 없음");

    test(studio.setProject({
      image: [
        "uniform float uGain;  // 세기 · @range 0 1 @default 0.2",
        "uniform float uWave;  // 물결 · @range -2 2",
        "void mainImage(out vec4 c, in vec2 p) { c = vec4(uGain, uWave, 0.0, 1.0); }",
      ].join("\n"), passes: [], imageChannels: {},
    }), "파라미터 둘인 장면");
    await until(() => document.querySelectorAll(".uniform-row").length === 2, "파라미터 줄");
    const first = document.querySelector(".uniform-row");
    test(first.getBoundingClientRect().top < 420, `첫 파라미터가 첫 화면 위쪽에 (${Math.round(first.getBoundingClientRect().top)}px)`);

    // ---- 도구 막대 ----
    const toolbar = [...$("stageToolbar").children].filter(n => n.tagName === "BUTTON" && visible(n)).map(n => n.id);
    test(toolbar[0] === "panelToggle", `설정 패널 버튼이 도구 막대 맨 앞 (${toolbar})`);
    test(toolbar.includes("quickShot") && !$("captureMenu").contains($("quickShot")), "카메라는 메뉴 밖에서 바로 누른다");
    let shots = 0;
    const realClick = $("screenshotButton").click.bind($("screenshotButton"));
    $("screenshotButton").click = () => { shots++; };
    $("quickShot").click();
    $("screenshotButton").click = realClick;
    test(shots === 1 && $("captureMenu").hidden, "카메라 한 번 = 스크린샷 한 번(메뉴는 안 열림)");

    // ---- 저장 버튼 ----
    await until(() => $("projectMenuToggle").dataset.modified === "true", "바뀐 작업 표시", 3000);
    test(visible($("projectMenuState")) && $("projectMenuState").tagName === "BUTTON", "바뀐 작업이면 이름 옆에 '저장' 버튼");
    $("projectMenuState").click();
    await until(() => $("studioPromptDialog").open, "누르면 바로 이름 묻기(메뉴를 거치지 않음)");
    $("studioDialogCancel").click();
    await until(() => !$("studioPromptDialog").open, "취소");

    // ---- 연결: 방식별 기억 · 키프레임은 타임라인과 함께 ----
    settings.setLinks([]);
    if (!$("timelineDock").hidden) $("timelineToggle").click();
    const row = name => document.querySelector(`.uniform-row[data-name="${name}"]`) || [...document.querySelectorAll(".uniform-row")].find(x => x.querySelector(".uniform-name")?.textContent === name);
    row("uGain").querySelector(".link-uniform").click();
    const pick = text => [...document.querySelectorAll(".link-sources [role=radio]")].find(b => b.textContent === text).click();
    await until(() => document.querySelector(".link-sources"), "연결 시트");
    pick("키프레임");
    await until(() => settings.getLinks()[0]?.source === "keys", "키프레임 연결");
    await until(() => !$("timelineDock").hidden && $("timelineDock").querySelector('.timeline-lane[data-name="uGain"] .timeline-key.is-selected'), "키프레임을 고르면 타임라인이 그 레인 · 첫 키와 함께 열림");
    settings.setLinks([{ ...settings.getLinks()[0], keys: [[0, 0.1], [2, 0.9]] }]);
    await wait(50);
    pick("흔들기");
    await until(() => settings.getLinks()[0]?.source === "lfo", "흔들기로 바꿈");
    pick("키프레임");
    await until(() => settings.getLinks()[0]?.source === "keys", "다시 키프레임");
    test(JSON.stringify(settings.getLinks()[0].keys) === "[[0,0.1],[2,0.9]]", `다른 방식을 눌러 봐도 키가 그대로 (${JSON.stringify(settings.getLinks()[0].keys)})`);

    // ---- 통계 ----
    const shown = () => [...$("stats").querySelectorAll(".stat-item")].filter(visible).length;
    if ($("stats").dataset.expanded === "true") $("stats").click();
    test(shown() === 1, "통계는 평소 FPS 한 칸");
    $("stats").click();
    test(shown() === 5 && $("stats").getAttribute("aria-expanded") === "true", "누르면 다섯 칸");
    $("stats").click();
    test(shown() === 1, "다시 누르면 접힘");
  } finally {
    clearInterval(autoAnswer);
    settings.setLinks(linksBefore);
    if ($("timelineDock").hidden !== !timelineWasOpen) $("timelineToggle").click();
    studio.setProject(before);
  }
  console.log("ux-audit browser regression: OK");
})();
