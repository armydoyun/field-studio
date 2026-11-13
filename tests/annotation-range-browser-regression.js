// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 어노테이션 표현 범위(annotations.js · renderer 배열 Uniform · ui.js):
//  · 한 줄 여러 선언: uniform float uA, uB; // @range … → 두 파라미터
//  · 성분별 범위: vec3 @range 0 1 -5 5 0 100 → 성분마다 다른 슬라이더 범위 · 범위 밖 값은 끌어들임
//  · 배열: float[4] · vec3[2] @color → 원소마다 위젯 · 셰이더가 원소 값을 읽는다(버퍼 픽셀) · 원소 하나를 바꾸면 그 원소만
//  · @if: 조건이 거짓이면 패널에서 숨기고, 조건 값을 바꾸면 바로 보이고 숨는다
(async () => {
  const autoAnswer = setInterval(() => { const d = document.getElementById("studioPromptDialog"), alt = document.getElementById("studioDialogAlt"); if (d?.open && !alt.hidden) alt.click(); }, 50);
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return; throw new Error(`FAIL: 시간 초과 — ${label}`); };
  const user = name => r.getUserUniforms().find(u => u.name === name);
  const row = name => [...$("uniformList").querySelectorAll(".uniform-row")].find(node => node.dataset.name === name);
  const pixel = async () => { await wait(120); return Array.from(r.readPassPixel("A", 0, 0)); };
  const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-4);
  const image = [
    "uniform float uA, uB;          // 둘 · @range 0 2 @default 1",
    "uniform vec3 uBox;             // @range 0 1 -5 5 0 100 @default 0.5 2 50",
    "uniform int uMode;             // @enum 숨김 보임",
    "uniform float uW[4];           // @range 0 1 @default 0.1 0.2 0.3 0.4",
    "uniform vec3 uCols[2];         // @color @default 1 0 0 0 0 1 @if uMode == 보임",
    "uniform bool uOn;              // @if !uMode",
    "void mainImage(out vec4 c, in vec2 p) { c = texelFetch(iChannel0, ivec2(0), 0); }",
  ].join("\n");
  const pass = {
    name: "A", format: "rgba32f", scale: 1, size: [1, 1], filter: "nearest", channels: {},
    fragment: "uniform float uW[4];\nuniform vec3 uCols[2];\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(uW[1], uW[3], uCols[1].b, uCols[0].r); }",
  };
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    if (!wasRunning) studio.togglePlayback();
    const applied = studio.setProject({ image, passes: [pass], imageChannels: { 0: { buffer: "A", frame: "current" } } });
    test(applied, `프로젝트 적용(배열 Uniform 컴파일): ${applied || $("studioMessage").textContent + " / " + ($("studioError")?.textContent || "")}`);
    await until(() => r.getUserUniforms().length === 7, `파라미터 7개 등록: ${r.getUserUniforms().map(u => u.name)} · ${$("studioMessage").textContent}`).catch(e => { throw new Error(`${e.message} → ${r.getUserUniforms().map(u => u.name)} · ${$("studioMessage").textContent}`); });

    // 1) 한 줄 여러 선언
    test(user("uA").value === 1 && user("uB").value === 1 && user("uB").options.max === 2, "uA, uB 둘 다 @range · @default");

    // 2) 성분별 범위
    test(JSON.stringify(user("uBox").options.ranges) === JSON.stringify([[0, 1, 0.001], [-5, 5, 0.01], [0, 100, 0.1]]), "성분별 범위 저장");
    $("tab-uniforms").click();
    await wait(80);
    const sliders = [...row("uBox").querySelectorAll('input[type="range"]')];
    test(sliders.map(s => `${s.min}~${s.max}`).join() === "0~1,-5~5,0~100", `성분마다 슬라이더 범위: ${sliders.map(s => `${s.min}~${s.max}`)}`);
    sliders[2].value = "80";
    sliders[2].dispatchEvent(new Event("input", { bubbles: true }));
    test(near(user("uBox").value, [0.5, 2, 80]), "Z 슬라이더가 Z만 바꾼다");

    // 3) 배열: 셰이더가 원소를 읽는다
    test(user("uW").type === "float[4]" && user("uCols").type === "vec3[2]", "배열 타입");
    test(near(await pixel(), [0.2, 0.4, 1, 1]), "셰이더가 uW[1] · uW[3] · uCols[1].b · uCols[0].r를 읽는다");
    const cells = [...row("uW").querySelectorAll(".uniform-array-item")];
    test(cells.length === 4 && cells[2].querySelector(".uniform-array-index").textContent === "[2]", "uW 원소 칸 4개");
    const third = cells[3].querySelector('input[type="range"]');
    third.value = "0.9";
    third.dispatchEvent(new Event("input", { bubbles: true }));
    test(near(user("uW").value, [0.1, 0.2, 0.3, 0.9]), "원소 [3]만 바뀐다");
    test(near(await pixel(), [0.2, 0.9, 1, 1]), "바꾼 원소가 셰이더에 들어간다");
    r.setUniform("uW", [0.5, 0.6, 0.7, 0.8]);
    test(near(user("uW").value, [0.5, 0.6, 0.7, 0.8]), "setUniform으로 배열 전체");
    let threw = false;
    try { r.setUniform("uW", [1, 2]); } catch { threw = true; }
    test(threw, "원소 수가 틀리면 거절");

    // 4) @if: uMode == 보임일 때만 uCols, uMode가 0일 때만 uOn
    test(!row("uCols") && !!row("uOn"), "처음(uMode = 숨김): uCols 숨김 · uOn 보임");
    test($("uniformResults").textContent.includes("uCols"), `숨긴 파라미터 안내: ${$("uniformResults").textContent}`);
    const choice = [...row("uMode").querySelectorAll("button,input")].find(node => (node.textContent || node.value || "").includes("보임") || node.getAttribute("aria-label")?.includes("보임"));
    test(!!choice, "@enum '보임' 선택지");
    choice.click();
    await until(() => !!row("uCols") && !row("uOn"), "조건이 바뀌면 바로 다시 그림");
    test(row("uCols").querySelectorAll(".uniform-array-item").length === 2 && row("uCols").querySelectorAll('input[type="color"]').length === 2, "uCols 원소마다 색 견본");
    $("uniformSearch").value = "uOn";
    $("uniformSearch").dispatchEvent(new Event("input", { bubbles: true }));
    await wait(50);
    test(!!row("uOn"), "검색 중에는 숨긴 파라미터도 보인다");
    $("uniformSearch").value = "";
    $("uniformSearch").dispatchEvent(new Event("input", { bubbles: true }));

    // 5) 되돌리기(기본값): 배열 전체가 @default로
    row("uW").querySelector(".reset-uniform")?.click();
    await wait(30);
    test(near(user("uW").value, [0.1, 0.2, 0.3, 0.4]), "되돌리기는 배열 전체를 @default로");
  } finally {
    clearInterval(autoAnswer);
    window.shaderSettings?.setPresets?.([]);
    studio.setProject(before);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("어노테이션 표현 범위 회귀 테스트 완료");
})();
