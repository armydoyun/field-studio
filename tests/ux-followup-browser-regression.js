// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 사용자 검수 후속(좁은 패널 · 연결 · 타임라인 · 프리셋):
//  1) 좁은 패널(240px)에서 글자가 넓은 글꼴이어도(자간을 넓혀 흉내) 연결 방식 버튼 · 빠른 선택 버튼의 글자가 칸을 넘지 않는다
//  2) 연결 방식을 눌러도 누른 버튼이 화면에서 움직이지 않는다(키프레임 ↔ 흔들기 ↔ 끄기)
//  3) 타임라인 숫자 칸은 자릿수가 다 보인다
//  4) 잇기의 '서로 다름'은 고른 키들의 잇기가 다를 때만 보인다
//  5) 프리셋 전환 중에는 칩에 진행 막대와 '바로 끝내기' · 직접 만지면 멈추고 알린다
(async () => {
  const autoAnswer = setInterval(() => { const d = document.getElementById("studioPromptDialog"), alt = document.getElementById("studioDialogAlt"); if (d?.open && !alt.hidden) alt.click(); }, 50);
  const r = window.shaderPlayground, studio = window.shaderStudio, settings = window.shaderSettings, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const until = async (check, label, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return; throw new Error(`FAIL: 시간 초과 — ${label}`); };
  // 글자가 칸 안에 들어가는지: 글자 상자가 요소 상자를 넘지 않는다
  const textFits = node => { const box = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()].every(t => !t.width || (t.left >= box.left - 0.5 && t.right <= box.right + 0.5)); };
  const workspace = $("workspace"), panelWidth = workspace.style.getPropertyValue("--panel-width"), layoutBefore = localStorage.getItem("field.panel.layout.v1");
  const before = studio.getProject(), linksBefore = settings.getLinks(), presetsBefore = settings.getPresets(), timelineWasOpen = !$("timelineDock").hidden;
  const wide = document.createElement("style");
  try {
    test(studio.setProject({
      image: [
        "uniform float uGain;  // 세기 · @range 0 1 @step 0.01 @default 0.2",
        "uniform float uSpin;  // 돌리기 · @angle",
        "void mainImage(out vec4 c, in vec2 p) { c = vec4(uGain, uSpin, 0.0, 1.0); }",
      ].join("\n"), passes: [], imageChannels: {},
    }), "파라미터 둘인 장면");
    await until(() => document.querySelectorAll(".uniform-row").length === 2, "파라미터 줄");
    settings.setLinks([]);
    if (!$("timelineDock").hidden) $("timelineToggle").click();
    document.body.classList.remove("panel-hidden");
    $("tab-uniforms").click();

    // ---- 1) 좁은 패널 + 넓은 글꼴 흉내 ----
    // 사용자가 경계를 끌어 줄인 것처럼(저장되는 실제 너비): 경계에서 Home = 최소 240px
    $("panelResize").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    await frames(2);
    test(Math.round($("panel").getBoundingClientRect().width) === 240, "패널 240px");
    wide.textContent = "#panel *{letter-spacing:.08em !important}";
    document.head.append(wide);
    const row = name => [...document.querySelectorAll(".uniform-row")].find(x => x.querySelector(".uniform-name")?.textContent === name);
    row("uGain").querySelector(".link-uniform").click();
    await until(() => document.querySelector(".link-sources"), "연결 시트");
    await frames(2);
    for (const button of document.querySelectorAll(".link-sources [role=radio]"))
      test(textFits(button), `좁은 패널: 연결 방식 '${button.textContent}' 글자가 칸 안에`);
    const sheet = document.querySelector(".link-editor").getBoundingClientRect();
    for (const node of document.querySelectorAll(".link-editor button, .link-editor input"))
      if (node.getBoundingClientRect().width) test(node.getBoundingClientRect().right <= sheet.right + 0.5, `좁은 패널: ${node.className || node.getAttribute("aria-label")}가 시트 밖으로 나가지 않음`);

    // ---- 2) 누른 버튼은 제자리 ----
    const scroller = $("panel").querySelector(".panel-scroll");
    const press = async text => {
      const button = [...document.querySelectorAll(".link-sources [role=radio]")].find(b => b.textContent === text);
      button.focus();
      const y = button.getBoundingClientRect().top;
      button.click();
      await frames(2);
      const after = [...document.querySelectorAll(".link-sources [role=radio]")].find(b => b.textContent === text).getBoundingClientRect().top;
      return after - y;
    };
    scroller.scrollTop = 0;
    for (const text of ["키프레임", "흔들기", "끄기", "키프레임", "소리", "키프레임"]) {
      const moved = await press(text);
      test(Math.abs(moved) <= 1, `'${text}'을 눌러도 버튼이 제자리 (${moved.toFixed(1)}px)`);
    }
    test(document.querySelector(".link-editor > .key-nav"), "시트가 열려 있으면 키프레임 내비게이터는 시트 안(방식 버튼 아래)");
    wide.remove();

    // ---- 3) · 4) 타임라인 ----
    settings.setLinks([{ name: "uGain", source: "keys", min: 0, max: 1, smooth: 0, keys: [[249.083, 0.5], [300, 0.8, "linear"]], loop: 0, ease: "smooth" }]);
    if ($("timelineDock").hidden) $("timelineToggle").click();
    await until(() => $("timelineDock").querySelectorAll(".timeline-key").length === 2, "타임라인 키 둘");
    const body = document.querySelector(".timeline-body"), ease = document.querySelector(".timeline-key-ease"), mixed = [...ease.options].find(o => o.value === "*");
    body.focus();
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    await until(() => document.querySelector(".timeline-selection").textContent === "키 2개", "두 키 고름");
    test(ease.value === "*" && !mixed.hidden && mixed.disabled, "잇기가 서로 다르면 '서로 다름'이 보인다(고를 수는 없음)");
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const key = document.querySelector(".timeline-key");
    key.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, pointerId: 1 }));
    key.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 }));
    await until(() => document.querySelector(".timeline-selection").textContent === "uGain 키", "키 하나");
    test(mixed.hidden && ease.options[0].textContent === "기본 (부드럽게)", `키 하나면 '서로 다름'은 숨고 기본이 무엇인지 보인다 (${ease.options[0].textContent})`);
    const keyTime = document.querySelector(".timeline-key-time");
    test(keyTime.value === "249.083", `키 시간 칸 값 (${keyTime.value})`);
    for (const input of document.querySelectorAll(".timeline-bar input[type=number]")) {
      const style = getComputedStyle(input), canvas = document.createElement("canvas").getContext("2d");
      canvas.font = style.font;
      const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      test(canvas.measureText(input.value || "-123.4567").width <= room, `타임라인 ${input.className}: '${input.value}'가 칸에 다 보임`);
    }
    // 선택 칸(배속 · 스냅 · 잇기): 어떤 항목을 골라도 글자가 잘리지 않는다. 고른 항목 하나만 넣은 같은 모양의 칸을
    // 브라우저가 width:auto로 잰 폭(글꼴 · 화살표 포함)보다 지금 칸이 좁으면 잘린 것이다.
    const naturalWidth = (select, text) => {
      const probe = select.cloneNode(false);
      probe.removeAttribute("id");
      probe.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;width:auto;min-width:0;max-width:none";
      probe.append(new Option(text));
      select.parentNode.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    };
    for (const select of document.querySelectorAll(".timeline-bar select")) {
      const have = select.getBoundingClientRect().width;
      for (const option of select.options)
        if (!option.hidden || option.value === "*")
          test(have >= naturalWidth(select, option.textContent) - 0.5, `타임라인 ${select.className}: '${option.textContent}'가 잘리지 않음 (${Math.round(have)}px)`);
    }
    for (const label of ["기본 (천천히 시작)", "기본 (레인 설정)", "서로 다름"])
      test(ease.getBoundingClientRect().width >= naturalWidth(ease, label) - 0.5, `잇기 칸: 바뀔 수 있는 이름 '${label}'도 들어간다`);
    $("timelineToggle").click();

    // ---- 5) 프리셋 전환 ----
    settings.setLinks([]);
    settings.setPresets([]);
    r.setUniform("uGain", 0);
    $("presetSave").click();
    await until(() => $("presetList").querySelectorAll(".preset-chip").length === 1, "프리셋 1");
    r.setUniform("uGain", 1);
    $("presetSave").click();
    await until(() => $("presetList").querySelectorAll(".preset-chip").length === 2, "프리셋 2");
    $("presetBlend").value = "1";
    const chips = () => [...$("presetList").querySelectorAll(".preset-chip")];
    chips()[0].querySelector(".preset-apply").click();
    await until(() => chips()[0].classList.contains("is-morphing"), "전환 시작: 목표 칩에 진행 표시");
    test(!$("presetFinish").hidden && $("presetNoticeText").textContent.includes("바꾸는 중"), "전환 중이라고 알리고 '바로 끝내기'");
    await wait(300);
    const progress = Number(chips()[0].style.getPropertyValue("--morph"));
    test(progress > 0 && progress < 1, `진행 막대가 차오름 (${progress.toFixed(2)})`);
    const mid = r.getUserUniforms().find(u => u.name === "uGain").value;
    test(Math.abs(mid * 100 - Math.round(mid * 100)) < 1e-6, `전환 중 값은 간격(0.01) 자릿수 (${mid})`);
    $("presetFinish").click();
    await until(() => r.getUserUniforms().find(u => u.name === "uGain").value === 0, "바로 끝내기 → 끝 값");
    test($("presetFinish").hidden && !chips()[0].classList.contains("is-morphing"), "끝나면 전환 표시 사라짐");
    chips()[1].querySelector(".preset-apply").click();
    await until(() => chips()[1].classList.contains("is-morphing"), "다시 전환");
    await wait(200);
    const slider = row("uGain").querySelector('input[type="range"]');
    slider.value = "0.3";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(150);
    test($("presetNoticeText").textContent.includes("멈췄습니다") && $("presetFinish").hidden, "직접 만지면 전환이 멈추고 알린다");
    test(Math.abs(r.getUserUniforms().find(u => u.name === "uGain").value - 0.3) < 1e-9, "직접 바꾼 값이 이긴다");
  } finally {
    clearInterval(autoAnswer);
    wide.remove();
    if (layoutBefore === null) localStorage.removeItem("field.panel.layout.v1");
    else localStorage.setItem("field.panel.layout.v1", layoutBefore);
    workspace.style.setProperty("--panel-width", panelWidth);
    settings.setLinks(linksBefore);
    settings.setPresets(presetsBefore);
    if ($("timelineDock").hidden !== !timelineWasOpen) $("timelineToggle").click();
    studio.setProject(before);
  }
  console.log("ux-followup browser regression: OK");
})();
