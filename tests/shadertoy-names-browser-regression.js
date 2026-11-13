// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// Shadertoy 이름의 실제 값(renderer.js · pass-manager.js · glsl-prepare.js):
//  · iDate = (연, 월 0~11, 일, 자정부터 지난 초) · iFrameRate > 0 · iChannelTime = 채널 시간(버퍼는 uTime) · iSampleRate = 44100
//  · iMouse는 Shadertoy와 똑같다: 누르지 않고 움직이면 xy가 그대로(0), 누르면 그 위치, 놓은 뒤 움직여도 마지막 위치
// 4×4 RGBA32F 버퍼에 값을 적고 readPassPixel로 읽는다.
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const pixel = (x = 0) => Array.from(r.readPassPixel("A", x, 0));
  const project = fragment => ({
    image: "uniform sampler2D iChannel0;\nvoid mainImage(out vec4 c, in vec2 p) { c = texture(iChannel0, p / iResolution.xy); }",
    passes: [{ name: "A", fragment, format: "rgba32f", scale: 1, size: [4, 4], filter: "nearest", channels: { 0: { buffer: "A", frame: "previous" } } }],
    imageChannels: { 0: { buffer: "A", frame: "current" } },
  });
  const canvas = $("screen");
  const pointer = (type, fx, fy, buttons = 0) => {
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent(type, { clientX: box.left + fx * box.width, clientY: box.top + (1 - fy) * box.height, button: 0, buttons, pointerId: 1, bubbles: true }));
  };
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    if (!wasRunning) studio.togglePlayback();

    // 1) 픽셀 x = 0: iDate · 1: (iFrameRate, iSampleRate, iChannelTime[0] - iTime, iChannelTime[3] - iTime)
    test(studio.setProject(project([
      "void mainImage(out vec4 c, in vec2 p) {",
      "    c = int(p.x) == 0 ? iDate : vec4(iFrameRate, iSampleRate, iChannelTime[0] - iTime, iChannelTime[3] - iTime);",
      "}",
    ].join("\n"))), "Shadertoy 이름 iDate · iFrameRate · iChannelTime · iSampleRate");
    await frames(6);
    const now = new Date(), date = pixel(0), misc = pixel(1);
    const seconds = (now - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 1000;
    test(date[0] === now.getFullYear() && date[1] === now.getMonth() && date[2] === now.getDate(), `iDate 날짜: ${date}`);
    test(Math.abs(date[3] - seconds) < 5, `iDate 자정부터 지난 초 ≈ ${seconds.toFixed(1)}: ${date[3]}`);
    test(misc[0] > 0 && misc[0] < 1000 && misc[1] === 44100, `iFrameRate · iSampleRate: ${misc}`);
    test(misc[2] === 0 && misc[3] === 0, `iChannelTime = iTime(버퍼 · 빈 채널): ${misc}`);

    // 2) iMouse(Shadertoy) · uMouse(FIELD)를 함께: x = 0 → iMouse, x = 1 → uMouse
    test(studio.setProject(project([
      "uniform vec4 uMouse;",
      "void mainImage(out vec4 c, in vec2 p) { c = int(p.x) == 0 ? iMouse : uMouse; }",
    ].join("\n"))), "iMouse · uMouse");
    pointer("pointermove", 0.25, 0.75);
    await frames(3);
    test(pixel(0)[0] === 0 && pixel(0)[1] === 0, `누르지 않고 움직이면 iMouse.xy는 0: ${pixel(0)}`);
    test(pixel(1)[0] === 1 && pixel(1)[1] === 3, `uMouse는 포인터를 따라간다(4×4 버퍼에서 1, 3): ${pixel(1)}`);
    pointer("pointerdown", 0.5, 0.5, 1);
    await frames(1);
    pointer("pointermove", 0.75, 0.25, 1);
    await frames(3);
    test(pixel(0)[0] === 3 && pixel(0)[1] === 1 && pixel(0)[2] === 2 && pixel(0)[3] < 0, `누른 채 끌면 xy는 지금 위치, z = 클릭 x(+), w는 첫 프레임 뒤 음수: ${pixel(0)}`);
    pointer("pointerup", 0.75, 0.25);
    pointer("pointermove", 0.0, 1.0);
    await frames(3);
    test(pixel(0)[0] === 3 && pixel(0)[1] === 1 && pixel(0)[2] === -2, `놓은 뒤 움직여도 xy는 마지막 위치, z는 음수: ${pixel(0)}`);
    test(pixel(1)[0] === 0 && pixel(1)[1] === 4, `uMouse는 계속 포인터를 따라간다: ${pixel(1)}`);
  } finally {
    canvas.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
    studio.setProject(before);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("Shadertoy 이름 회귀 테스트 완료");
})();
