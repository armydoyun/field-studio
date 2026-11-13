// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 짧은 머리말(#version · precision 생략)과 가짜 진입점(mainImage)이 실제 GLSL 컴파일러에서 동작하는지,
// 컴파일 오류가 편집기의 줄 번호로 나오는지 본다(js/glsl-prepare.js).
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const pixel = () => Array.from(r.readPassPixel("A", 0, 0)).map(v => Math.round(v * 100) / 100);
  const IMAGE = "uniform sampler2D iChannel0;\nuniform vec2 uResolution;\nout vec4 fragColor;\nvoid main() { fragColor = texture(iChannel0, gl_FragCoord.xy / uResolution); }";
  const project = buffer => ({
    image: IMAGE,
    passes: [{ name: "A", fragment: buffer, format: "rgba32f", scale: 1, size: [4, 4], filter: "nearest", channels: {} }],
    imageChannels: { 0: { buffer: "A", frame: "current" } },
  });
  const diagnostics = () => [...$("studioDiagnostics").querySelectorAll("button")].map(b => b.textContent);
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    if (!wasRunning) studio.togglePlayback();

    // 1) 머리말도 main도 없이 mainImage만: 4×4 버퍼를 (0.25, 0.5, 0.75, 1)로 채운다
    test(studio.setProject(project(
      "// #version과 precision 없이, Shadertoy처럼 mainImage만 쓴다\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord) {\n    fragColor = vec4(0.25, 0.5, 0.75, 1.0);\n}")), "머리말 없는 mainImage 버퍼 · 머리말 없는 Image 적용");
    await frames(3);
    test(JSON.stringify(pixel()) === JSON.stringify([0.25, 0.5, 0.75, 1]), `mainImage가 버퍼에 쓴 값 ${pixel()}`);

    // 2) fragCoord는 픽셀 중심 좌표(gl_FragCoord.xy)다
    test(studio.setProject(project("void mainImage(out vec4 c, in vec2 p) { c = vec4(p, 0.0, 1.0); }")), "fragCoord를 쓰는 mainImage");
    await frames(3);
    test(pixel()[0] === 0.5 && pixel()[1] === 0.5, `(0,0) 픽셀의 fragCoord는 (0.5, 0.5): ${pixel()}`);

    // 3) 전역 out vec4를 선언해 둔 코드도 그 변수로 출력한다
    test(studio.setProject(project("out vec4 result;\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(1.0, 0.0, 0.0, 1.0); }")), "전역 out을 둔 mainImage");
    await frames(3);
    test(pixel()[0] === 1 && pixel()[1] === 0, "선언한 out 변수로 출력");

    // 4) 오류 줄 번호: 머리말 없는 코드의 3번 줄 오류는 3번 줄로 보인다
    studio.open();
    test(!studio.setProject(project("out vec4 o;\nvoid main() {\n    o = vec4(oops);\n}")), "오류가 있는 코드는 적용되지 않음");
    test(diagnostics().some(text => /Line 3 · .*oops/.test(text)), `오류는 편집기 3번 줄: ${diagnostics()}`);

    // 5) mainImage 모양이 틀리면(인자 부족) 진입점 오류가 mainImage 줄을 가리킨다
    test(!studio.setProject(project("// 설명\nvoid mainImage(out vec4 c) {\n    c = vec4(1.0);\n}")), "모양이 틀린 mainImage는 적용되지 않음");
    test(diagnostics().some(text => /Line 2 · .*mainImage/.test(text)), `진입점 오류는 mainImage 정의 줄(2): ${diagnostics()}`);

    // 6) #version이 있는 예전 코드는 그대로 동작한다
    test(studio.setProject(project("#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(0.0, 1.0, 0.0, 1.0); }")), "#version이 있는 코드");
    await frames(3);
    test(pixel()[1] === 1, "예전 형식 그대로 동작");
  } finally {
    studio.setProject(before);
    studio.close();
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("짧은 머리말 · mainImage 진입점 회귀 테스트 완료");
})();
