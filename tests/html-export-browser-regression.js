// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// HTML로 내보내기(js/html-export.js): 만든 HTML을 iframe에 열어, 앱과 같은 그림이 나오는지 본다.
// Common · Shadertoy 이름 · 피드백 버퍼(previous) · current 읽기 · 어노테이션 파라미터(float · @gradient 램프) ·
// 이미지 채널이 모두 들어간 프로젝트를 쓴다. 재생기의 window.fieldPlayer.readPixel로 화면 픽셀을 읽는다.
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const near = (a, b, tolerance = 3) => Math.abs(a - b) <= tolerance;
  // 2×2 빨간 PNG
  const redPng = await new Promise(resolve => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 2, 2);
    canvas.toBlob(blob => resolve(new File([blob], "red.png", { type: "image/png" })), "image/png");
  });
  const before = studio.getProject(), wasRunning = r.getStats().running;
  let frame = null, textureId = null;
  try {
    if (!wasRunning) studio.togglePlayback();
    textureId = (await r.addTexture(redPng)).id;
    // 왼쪽 절반: (A의 current.x = Common tint().x = 0.25, uGain = 0.6, 램프 가운데 ≈ 0.5)
    // 오른쪽 절반: (이미지 빨강 = 1, A의 피드백 누적 y > 0, iFrame > 0 && iTime ≥ 0 && iResolution.z == 1)
    const project = {
      common: "vec3 tint() { return vec3(0.25, 0.5, 0.75); }",
      passes: [{
        name: "A", format: "rgba8", scale: 1, size: [4, 4], filter: "nearest",
        fragment: "uniform sampler2D iChannel0;\nvoid mainImage(out vec4 c, in vec2 p) {\n    float acc = texelFetch(iChannel0, ivec2(0), 0).y;\n    c = vec4(tint().x, min(1.0, acc + 0.02), 0.0, 1.0);\n}",
        channels: { 0: { buffer: "A", frame: "previous" } },
      }],
      image: [
        "uniform sampler2D iChannel0;",
        "uniform sampler2D iChannel1;",
        "uniform float uGain;      // @range 0 1 @default 0.6",
        "uniform sampler2D uRamp;  // @gradient @default 0 #000000 1 #ffffff",
        "void mainImage(out vec4 c, in vec2 p) {",
        "    vec4 a = texelFetch(iChannel0, ivec2(0), 0);",
        "    bool ok = iFrame > 0 && iTime >= 0.0 && iResolution.z == 1.0;",
        "    c = p.x < iResolution.x * 0.5",
        "        ? vec4(a.x, uGain, texture(uRamp, vec2(0.5, 0.5)).r, 1.0)",
        "        : vec4(texture(iChannel1, vec2(0.5)).r, a.y > 0.05 ? 1.0 : 0.0, ok ? 1.0 : 0.0, 1.0);",
        "}",
      ].join("\n"),
      imageChannels: { 0: { buffer: "A", frame: "current" }, 1: { texture: textureId } },
    };
    test(studio.setProject(project), "내보낼 프로젝트 적용");
    await frames(5);
    const users = r.getUserUniforms().map(u => u.name);
    test(users.includes("uGain") && users.includes("uRamp"), `어노테이션 파라미터 등록: ${users}`);

    // 1) HTML 만들기: 한 파일 · 외부 요청 없음 · </script>가 데이터에 섞여도 안전
    const { html, data } = await studio.buildPlayerHTML();
    test(html.startsWith("<!doctype html>") && html.includes("window.fieldPlayer"), "재생기가 들어 있는 HTML");
    test(!/<script[^>]+src=|<link[^>]+href=/.test(html), "외부 스크립트 · 스타일을 부르지 않는다");
    test((html.match(/<\/script>/g) || []).length === 1, "</script>는 끝에 하나뿐(데이터 안의 <는 이스케이프)");
    test(data.passes.length === 1 && Object.keys(data.textures).length === 1 && data.uniforms.length === 2, "버퍼 1 · 이미지 1 · 파라미터 2개를 담는다");
    test(data.image.source.startsWith("#version 300 es") && data.image.source.includes("vec3 tint()"), "컴파일 직전 소스(머리말 · Common 포함)");

    // 2) iframe에서 재생해 픽셀 비교
    frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;left:0;top:0;width:200px;height:100px;border:0;z-index:99999";
    document.body.append(frame);
    await new Promise(resolve => { frame.onload = resolve; frame.srcdoc = html; });
    const player = frame.contentWindow.fieldPlayer;
    test(!!player, "iframe 안에 fieldPlayer");
    await player.ready;
    test(frame.contentDocument.getElementById("note").hidden, `오류 표시 없음: ${frame.contentDocument.getElementById("note").textContent}`);
    for (let i = 0; i < 10; i++) await player.readPixel(0, 0); // 피드백이 쌓이도록 몇 프레임
    const canvas = frame.contentDocument.getElementById("field"),
      left = await player.readPixel(2, 2),
      right = await player.readPixel(canvas.width - 3, 2);
    test(near(left[0], 64) && near(left[1], 153) && near(left[2], 128, 6), `왼쪽: Common 0.25 · uGain 0.6 · 램프 가운데 ≈ 0.5 → ${left}`);
    test(right[0] === 255 && right[1] === 255 && right[2] === 255, `오른쪽: 이미지 빨강 · 피드백 누적 · Shadertoy 이름 → ${right}`);
    test(player.frame > 10, `프레임이 진행 중: ${player.frame}`);
  } finally {
    frame?.remove();
    studio.setProject(before);
    if (textureId) r.removeTexture?.(textureId);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("HTML 내보내기 회귀 테스트 완료");
})();
