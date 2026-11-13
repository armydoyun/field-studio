// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// Common 탭: 모든 패스 앞에 붙는 공용 코드(project.common)가 실제 GLSL 컴파일러에서 동작하는지,
// Common만 바꿔도 모든 패스가 다시 만들어지는지, Common에서 난 오류가 Common 탭의 줄로 가는지,
// 편집기의 Common 추가 · 삭제 · Undo가 맞는지 본다(js/glsl-prepare.js · renderer.js · studio.js).
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const pixel = () => Array.from(r.readPassPixel("A", 0, 0)).map(v => Math.round(v * 100) / 100);
  const IMAGE = "uniform sampler2D iChannel0;\nvoid mainImage(out vec4 c, in vec2 p) { c = texture(iChannel0, p / iResolution.xy) * tint().x * 4.0; }";
  const BUFFER = "void mainImage(out vec4 c, in vec2 p) {\n    c = vec4(tint(), 1.0);\n}";
  const project = (common, buffer = BUFFER) => ({
    image: IMAGE,
    common,
    passes: [{ name: "A", fragment: buffer, format: "rgba32f", scale: 1, size: [4, 4], filter: "nearest", channels: {} }],
    imageChannels: { 0: { buffer: "A", frame: "current" } },
  });
  const diagnostics = () => [...$("studioDiagnostics").querySelectorAll("button")].map(b => b.textContent);
  const activeTab = () => $("studioPassTabs").querySelector(".is-active")?.textContent;
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    if (!wasRunning) studio.togglePlayback();
    studio.open();

    // 1) Common의 함수를 Image와 Buffer가 함께 쓴다
    test(studio.setProject(project("// 공용\nvec3 tint() { return vec3(0.25, 0.5, 0.75); }")), "Common 함수를 쓰는 프로젝트 적용");
    await frames(3);
    test(JSON.stringify(pixel()) === JSON.stringify([0.25, 0.5, 0.75, 1]), `Buffer A가 Common의 tint()로 쓴 값: ${pixel()}`);
    test([...$("studioPassTabs").querySelectorAll("button")].map(b => b.textContent).join(",") === "Image,Common,Buffer A", "탭 순서: Image · Common · Buffer");
    test($("studioAddCommon").hidden, "Common이 있으면 Common 추가 버튼을 숨긴다");

    // 2) 패스 코드는 그대로 두고 Common만 바꿔도 모든 패스가 새 Common으로 다시 만들어진다
    test(studio.setProject(project("vec3 tint() { return vec3(1.0, 0.0, 0.5); }")), "Common만 바꾼 프로젝트 적용");
    await frames(3);
    test(JSON.stringify(pixel()) === JSON.stringify([1, 0, 0.5, 1]), `Common만 바꿔도 Buffer A가 다시 그린 값: ${pixel()}`);

    // 3) Common의 3번 줄 오류는 Common 탭의 3번 줄로 보이고, 편집기가 Common 탭으로 간다
    test(!studio.setProject(project("// 1\nvec3 tint() {\n    return oops;\n}")), "Common에 오류가 있으면 적용되지 않음");
    test(diagnostics().some(text => /^Common · Line 3 · .*oops/.test(text)), `Common 오류는 Common 3번 줄: ${diagnostics()}`);

    // 4) Common이 있어도 패스의 오류 줄 번호는 그대로(#version 있는 코드 · 없는 코드 모두)
    const ok = "vec3 tint() { return vec3(0.5); }";
    test(!studio.setProject(project(ok, "void mainImage(out vec4 c, in vec2 p) {\n    c = vec4(tint(), 1.0);\n    c = oops2;\n}")), "패스 오류(머리말 없음)");
    test(diagnostics().some(text => /^A · Line 3 · .*oops2/.test(text)), `패스 오류는 A 3번 줄: ${diagnostics()}`);
    test(!studio.setProject(project(ok, "#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() {\n    o = oops3;\n}")), "패스 오류(#version 있음)");
    test(diagnostics().some(text => /^A · Line 5 · .*oops3/.test(text)), `패스 오류는 A 5번 줄: ${diagnostics()}`);

    // 5) Shadertoy 이름을 Common에서 써도 연결된다
    test(studio.setProject(project("vec3 tint() { return vec3(iResolution.xy / 8.0, iResolution.z); }")), "Common에서 iResolution");
    await frames(3);
    test(JSON.stringify(pixel()) === JSON.stringify([0.5, 0.5, 1, 1]), `Common의 iResolution = (4, 4, 1): ${pixel()}`);

    // 6) "Common"은 Buffer 이름으로 쓸 수 없다
    const clash = project(ok);
    clash.passes[0].name = "Common";
    clash.imageChannels = { 0: { buffer: "Common", frame: "current" } };
    test(!studio.setProject(clash), "Buffer 이름 Common은 거부");

    // 7) 편집기: Common 추가 → 탭이 생기고 고른 상태 · 삭제 → 사라짐 · Undo → 돌아옴
    test(studio.setProject({ image: "void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }", passes: [], imageChannels: {} }), "Common 없는 프로젝트");
    test(!$("studioAddCommon").hidden && !$("studioTab-Common"), "Common이 없으면 추가 버튼만 있다");
    $("studioAddCommon").click();
    await frames(2);
    test(activeTab() === "Common" && typeof studio.getProject().common === "string", `Common 추가 후 Common 탭: ${activeTab()}`);
    test($("studioCodeTitle").textContent === "Common.glsl" && $("studioInputsToggle").hidden, "Common 탭: 파일 이름 Common.glsl · 입력 채널 버튼 없음");
    test(!$("studioPassTools").hidden && !$("studioRemove").disabled && $("studioUp").hidden, "Common 설정 줄에는 삭제만");
    test(!diagnostics().length, `시작 코드는 오류 없이 적용: ${diagnostics()}`);
    $("studioRemove").click();
    await frames(2);
    test(!$("studioTab-Common") && studio.getProject().common === undefined && activeTab() === "Image", "Common 삭제 → 탭 사라지고 Image로");
    $("studioUndo").click();
    await frames(2);
    test(!!$("studioTab-Common") && typeof studio.getProject().common === "string", "Undo로 Common 복원");
  } finally {
    studio.setProject(before);
    studio.close();
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("Common 탭 회귀 테스트 완료");
})();
