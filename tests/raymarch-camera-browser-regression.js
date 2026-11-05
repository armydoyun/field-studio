// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// Ray Marching SDF 예제의 카메라 상태 버퍼(Buffer A): 키·드래그로 시점이 바뀌고,
// 마우스를 누르고만 있을 때는 시점이 그대로인지 본다(rgba16f 반올림으로 생기던 회전 드리프트 회귀 방지).
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const canvas = $("screen"), stage = $("stage");
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const key = (type, k, keyCode) => window.dispatchEvent(new KeyboardEvent(type, { key: k, keyCode, bubbles: true, cancelable: true }));
  const camera = () => Array.from(r.readPassPixel("A", 0, 0)).slice(0, 3);
  const rect = canvas.getBoundingClientRect();
  const pointer = (type, fx, fy) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy, bubbles: true, cancelable: true }));
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    if (!wasRunning) studio.togglePlayback();
    test(studio.exampleRaymarch(), "Ray Marching 예제 시작");
    await frames(4);
    const p = studio.getProject();
    test(p.passes[0]?.format === "rgba32f", "카메라 버퍼는 rgba32f(반정밀도면 드래그 위치가 어긋남)");
    test(Math.abs(camera()[1] - 0.5236) < 1e-3 && Math.abs(camera()[2] - 5.196) < 1e-3, "기본 시점");
    // 여러 위치에서 누르고 움직이지 않으면 시점이 바뀌지 않아야 한다.
    for (const [fx, fy] of [[0.37, 0.61], [0.83, 0.29], [0.11, 0.93]]) {
      pointer("pointermove", fx, fy); await frames(2);
      const start = camera();
      pointer("pointerdown", fx, fy); await frames(40);
      const held = camera();
      pointer("pointerup", fx, fy); await frames(2);
      test(held.every((v, i) => Math.abs(v - start[i]) < 1e-6), `누르고만 있으면 시점 고정 (${fx}, ${fy}): ${start} → ${held}`);
    }
    // 드래그하면 회전한다.
    const start = camera();
    pointer("pointermove", 0.5, 0.5); pointer("pointerdown", 0.5, 0.5); await frames(2);
    for (let i = 1; i <= 10; i++) { pointer("pointermove", 0.5 + i * 0.02, 0.5); await frames(1); }
    pointer("pointerup", 0.7, 0.5); await frames(2);
    test(Math.abs(camera()[0] - start[0]) > 0.1, "드래그로 회전");
    // 뷰포트 포커스 후 R로 초기 시점, ← 키로 회전
    stage.focus({ preventScroll: true });
    key("keydown", "r", 82); await frames(2); key("keyup", "r", 82); await frames(2);
    test(Math.abs(camera()[0]) < 1e-4, "R 키로 초기 시점");
    key("keydown", "ArrowLeft", 37); await frames(20); key("keyup", "ArrowLeft", 37); await frames(2);
    test(camera()[0] > 0.01, "← 키로 회전");
    key("keydown", "Escape", 27);
  } finally {
    studio.setProject(before);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("Ray Marching 카메라 버퍼 회귀 테스트 완료");
})();
