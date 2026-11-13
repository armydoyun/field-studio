// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// F2 이름 바꾸기가 Common까지 가는지(studio.js renameShared · renameUniform · cm-glsl-features.js):
//  · 패스 탭에서 Common의 함수 이름을 바꾸면 Common의 정의와 모든 패스의 쓰는 곳이 함께 바뀐다(패스 안에서 따로 선언한 같은 이름은 그대로)
//  · Common 탭에서 #define을 바꿔도 모든 패스가 따라온다 · 이름이 겹치면 바꾸지 않는다 · Undo 한 번으로 되돌린다
//  · Common이 선언한 Uniform(파라미터)을 패스 탭에서 바꾸면 Common · 모든 패스 · 파라미터가 함께 바뀐다
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const until = async (check, label) => { for (let i = 0; i < 60; i++) { if (check()) return; await frames(1); } throw new Error(`FAIL: 시간 초과 — ${label}`); };
  // 편집 중인 탭에서 text가 처음 나오는 곳에 커서를 두고 F2 → 새 이름 입력 → 확인
  const renameAt = async (tab, text, next, offset = 1) => {
    $(`studioTab-${tab}`).click();
    await frames(1);
    const area = $("studioCode"), at = area.value.indexOf(text) + offset;
    area.focus();
    area.setSelectionRange(at, at);
    document.querySelector(".cm-content").dispatchEvent(new KeyboardEvent("keydown", { key: "F2", code: "F2", keyCode: 113, bubbles: true, cancelable: true }));
    await until(() => $("studioPromptDialog").open, "이름 입력 창");
    $("studioDialogInput").value = next;
    $("studioDialogOK").click();
    await until(() => !$("studioPromptDialog").open, "이름 입력 창 닫힘");
    await frames(2);
  };
  const COMMON = "#define GAIN 0.5\nuniform float uAmount;   // @range 0 1 @default 0.5\nfloat wobble(float t) { return sin(t) * GAIN * uAmount; }";
  const project = () => ({
    common: COMMON,
    image: "uniform sampler2D iChannel0;\nvoid mainImage(out vec4 c, in vec2 p) { c = texture(iChannel0, p / iResolution.xy) + wobble(1.0) * GAIN; }",
    passes: [{
      name: "A", format: "rgba8", scale: 1, size: [4, 4], filter: "nearest", channels: {},
      // A는 자기 안에 wobble 지역 변수를 따로 둔다: 이 이름은 Common의 것이 아니라 그대로 남아야 한다
      fragment: "void mainImage(out vec4 c, in vec2 p) {\n    float a = wobble(iTime);\n    { float wobble = 2.0; a += wobble; }\n    c = vec4(a * uAmount);\n}",
    }],
    imageChannels: { 0: { buffer: "A", frame: "current" } },
  });
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    if (!wasRunning) studio.togglePlayback();
    studio.open();
    test(studio.setProject(project()), "Common을 쓰는 프로젝트");
    await frames(3);
    test(r.getUserUniforms().some(u => u.name === "uAmount"), "Common의 파라미터 등록");

    // 1) Image 탭에서 Common의 함수 wobble → wave
    await renameAt("Image", "wobble(1.0)", "wave");
    let p = studio.getProject();
    test(p.common.includes("float wave(float t)") && !p.common.includes("wobble"), `Common의 정의: ${p.common}`);
    test(p.image.includes("wave(1.0)"), "Image의 쓰는 곳");
    test(p.passes[0].fragment.includes("float a = wave(iTime);") && p.passes[0].fragment.includes("float wobble = 2.0; a += wobble;"), `A: Common 것만 바뀌고 지역 변수는 그대로 — ${p.passes[0].fragment}`);
    test($("studioDiagnostics").hidden, "바꾼 뒤에도 컴파일 오류 없음");

    // 2) 겹치는 이름은 거부: A에 지역이 아닌 전역 이름이 있으면 그 이름으로 못 바꾼다
    const clash = project();
    clash.passes[0].fragment = "float shine = 1.0;\n" + clash.passes[0].fragment;
    test(studio.setProject(clash), "겹칠 이름이 있는 프로젝트");
    await renameAt("Image", "wobble(1.0)", "shine");
    test(studio.getProject().common.includes("float wobble("), "겹치면 Common을 바꾸지 않는다");

    // 3) Common 탭에서 #define GAIN → STRENGTH: Image의 쓰는 곳도 바뀐다 · Undo 한 번으로 모두 되돌린다
    test(studio.setProject(project()), "다시 원래 프로젝트");
    await renameAt("Common", "GAIN 0.5", "STRENGTH");
    p = studio.getProject();
    test(p.common.includes("#define STRENGTH 0.5") && p.common.includes("* STRENGTH *") && p.image.includes("* STRENGTH;"), `Common · Image의 GAIN: ${p.image}`);
    $("studioUndo").click();
    await frames(2);
    p = studio.getProject();
    test(p.common.includes("#define GAIN 0.5") && p.image.includes("* GAIN;"), "Undo 한 번으로 Common과 Image가 함께 돌아온다");

    // 4) A 탭에서 Common이 선언한 Uniform uAmount → uMix: Common 선언 · A의 쓰는 곳 · 파라미터가 함께
    await renameAt("A", "uAmount", "uMix");
    p = studio.getProject();
    test(p.common.includes("uniform float uMix;") && p.passes[0].fragment.includes("a * uMix"), `Common 선언과 A의 쓰는 곳: ${p.passes[0].fragment}`);
    test(r.getUserUniforms().some(u => u.name === "uMix") && !r.getUserUniforms().some(u => u.name === "uAmount"), "파라미터 이름도 바뀐다");
  } finally {
    studio.setProject(before);
    studio.close();
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("Common 이름 바꾸기 회귀 테스트 완료");
})();
