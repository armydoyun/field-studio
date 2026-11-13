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

    // 6-1) Common이 패스의 Uniform · iChannel · 앱 Uniform · Shadertoy 이름을 직접 쓴다(패스 선언을 Common 앞으로 끌어올림).
    //      Common이 쓰는 파라미터는 Common에 선언한다(모든 패스에 들어가고, 어노테이션도 Common에서 읽는다).
    const shared = "// Common\nuniform float uGain;   // @range 0 1 @default 0.25\nvec3 tint() { return vec3(uGain, texelFetch(iChannel0, ivec2(0), 0).r, iResolution.x / 8.0) * step(0.0, uTime); }";
    const withUniforms = project(shared, "uniform float uTime;\nuniform sampler2D iChannel0;\nvoid mainImage(out vec4 c, in vec2 p) {\n    c = vec4(tint(), 1.0);\n}");
    withUniforms.passes[0].channels = { 0: { buffer: "A", frame: "previous" } };
    test(studio.setProject(withUniforms), "Common이 패스 Uniform · 파라미터 · iChannel을 쓰는 프로젝트");
    await frames(4);
    test(pixel()[0] === 0.25 && pixel()[2] === 0.5, `Common의 uGain(0.25) · iResolution.x / 8(0.5): ${pixel()}`);
    // Image는 uTime을 선언하지 않았지만 Common이 쓰므로 앱이 선언을 넣는다
    test(!diagnostics().length, `오류 없음: ${diagnostics()}`);
    test(r.getUserUniforms().some(u => u.name === "uGain"), "Common의 어노테이션으로 파라미터 등록");
    // 끌어올린 선언에서 난 오류도 원래 줄로: 3번 줄의 잘못된 선언
    test(!studio.setProject(project(shared, "uniform float uTime;\nuniform vec2 iChannel0;\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(tint(), 1.0); }")), "타입이 틀린 iChannel0 선언");
    test(diagnostics().some(text => /^Common · Line 3 · /.test(text)), `Common에서 쓰는 곳(3번 줄)에 오류: ${diagnostics()}`);

    // 6-1b) Common이 쓰는 파라미터를 한 패스(A)에만 선언해도 된다: 다른 패스(Image)에는 앱이 A의 선언을 넣는다
    const onlyInA = project("vec3 tint() { return vec3(uLevel, 0.0, 0.0); }", "uniform float uLevel;   // @range 0 1 @default 0.75\nvoid mainImage(out vec4 c, in vec2 p) {\n    c = vec4(tint(), 1.0);\n}");
    test(studio.setProject(onlyInA), "Common의 파라미터를 A에만 선언한 프로젝트");
    await frames(4);
    test(pixel()[0] === 0.75 && !diagnostics().length, `A의 선언으로 Image도 컴파일 · uLevel 0.75: ${pixel()} ${diagnostics()}`);
    test(r.getUserUniforms().some(u => u.name === "uLevel"), "A의 어노테이션으로 파라미터 등록");

    // 6-2) 정의로 이동(F12): Image 탭에서 Common의 함수를 가리키면 Common 탭의 그 줄로 간다
    const jump = project("// 1\n// 2\nvec3 tint() { return vec3(0.5); }");
    jump.image = "uniform sampler2D iChannel0;\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(tint(), 1.0); }";
    test(studio.setProject(jump), "F12용 프로젝트");
    $("studioTab-Image").click();
    await frames(1);
    const area = $("studioCode"), at = area.value.indexOf("tint()") + 1;
    area.focus();
    area.setSelectionRange(at, at);
    document.querySelector(".cm-content").dispatchEvent(new KeyboardEvent("keydown", { key: "F12", code: "F12", keyCode: 123, bubbles: true, cancelable: true }));
    await frames(2);
    const caretLine = $("studioCode").value.slice(0, $("studioCode").selectionStart).split("\n").length;
    test(activeTab() === "Common" && caretLine === 3, `F12 → Common 탭 3번째 줄: ${activeTab()} · ${caretLine}`);

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
