// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 3D 레이마칭 예제(raymarch-lessons.js)의 상태 버퍼가 입력대로 움직이는지 본다.
//  · Orbit Camera: 끌면 회전 · 놓으면 관성으로 조금 더 돌다 멈춤 · 누르고만 있으면 그대로 · R로 처음 시점
//  · Keyboard Explorer: W로 앞(-z)으로 이동 · Space로 점프 · 바닥 위에 서 있음 · R로 처음 자리
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const canvas = $("screen"), stage = $("stage");
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const key = (type, k, keyCode) => window.dispatchEvent(new KeyboardEvent(type, { key: k, keyCode, bubbles: true, cancelable: true }));
  const pixel = i => Array.from(r.readPassPixel("A", i, 0));
  const rect = () => canvas.getBoundingClientRect();
  const pointer = (type, fx, fy) => { const b = rect(); canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: b.left + b.width * fx, clientY: b.top + b.height * fy, bubbles: true })); };
  const L = await import("./js/raymarch-lessons.js"), A = await import("./js/annotations.js");
  const load = async project => {
    const users = A.collect([project.image, ...project.passes.map(p => p.fragment)]).filter(x => !x.error).map(({ name, type, value, options }) => ({ name, type, value, options }));
    test(await studio.loadExample(project, users), "예제 불러오기");
    await frames(4);
  };
  const before = studio.getProject(), wasRunning = r.getStats().running, scale = r.getStats().resolutionScale;
  try {
    if (!wasRunning) studio.togglePlayback();
    r.setResolutionScale(0.25);   // GPU 없는 환경(소프트웨어 렌더)에서도 제때 끝나게 화면만 작게 그린다. 상태 버퍼는 그대로다
    test(L.LESSONS.length === 4 && L.LESSONS.every(item => item.project && item.liveThumb), "레슨 4개 · 모두 프로젝트와 실시간 썸네일");

    // ---- Orbit Camera ----
    await load(L.orbitProject(L.orbitImage, L.ORBIT_HOME));
    const pass = studio.getProject().passes[0];
    test(pass.format === "rgba32f" && pass.size?.[0] === 3, "카메라 버퍼는 rgba32f · 3×1");
    test(Math.abs(pixel(0)[0] - L.ORBIT_HOME[0]) < 1e-3 && Math.abs(pixel(0)[2] - L.ORBIT_HOME[2]) < 1e-3, "처음 시점");
    // 누르고만 있으면 시점이 그대로다
    pointer("pointermove", 0.4, 0.6); await frames(2);
    const still = pixel(0);
    pointer("pointerdown", 0.4, 0.6); await frames(20);
    test(pixel(0).every((v, i) => Math.abs(v - still[i]) < 1e-5), "누르고만 있으면 시점 고정");
    // 끌면 돈다
    for (let i = 1; i <= 8; i++) { pointer("pointermove", 0.4 + i * 0.03, 0.6); await frames(1); }
    const dragged = pixel(0)[0];
    test(Math.abs(dragged - still[0]) > 0.3, `끌기로 회전 (${still[0].toFixed(2)} → ${dragged.toFixed(2)})`);
    // 움직이던 채로 놓으면 관성으로 조금 더 돌고, 곧 멈춘다
    pointer("pointerup", 0.64, 0.6); await frames(6);
    const coasting = pixel(0)[0];
    test(Math.abs(coasting - dragged) > 1e-3, "놓은 뒤 관성으로 더 돈다");
    await frames(80);
    const settled = pixel(0)[0]; await frames(10);
    test(Math.abs(pixel(0)[0] - settled) < 1e-3, "관성은 곧 멈춘다");
    stage.focus({ preventScroll: true });
    key("keydown", "r", 82); await frames(2); key("keyup", "r", 82); await frames(2);
    test(Math.abs(pixel(0)[0] - L.ORBIT_HOME[0]) < 1e-3, "R 키로 처음 시점");
    key("keydown", "Escape", 27); key("keyup", "Escape", 27);

    // ---- Keyboard Explorer ----
    await load(L.explorerProject());
    const start = pixel(0);
    test(Math.abs(start[2] - 6) < 1e-3 && Math.abs(start[1] - 0.5) < 0.02, "처음 자리(바닥 위 공)");
    stage.focus({ preventScroll: true });
    key("keydown", "w", 87); await frames(30); key("keyup", "w", 87); await frames(10);
    const moved = pixel(0);
    test(moved[2] < start[2] - 0.3, `W로 앞(-z)으로 이동 (z ${start[2].toFixed(2)} → ${moved[2].toFixed(2)})`);
    test(Math.abs(moved[1] - 0.5) < 0.05 && pixel(1)[3] > 0.5, "바닥 위에 서 있다(충돌 · 땅 판정)");
    key("keydown", " ", 32); await frames(3); key("keyup", " ", 32);
    test(pixel(0)[1] > 0.55 && pixel(1)[1] > 0, "Space로 점프");
    await frames(60);
    test(Math.abs(pixel(0)[1] - 0.5) < 0.05, "착지");
    key("keydown", "r", 82); await frames(2); key("keyup", "r", 82); await frames(2);
    test(Math.abs(pixel(0)[2] - 6) < 1e-3, "R 키로 처음 자리");
    key("keydown", "Escape", 27); key("keyup", "Escape", 27);
  } finally {
    r.setResolutionScale(scale);
    studio.setProject(before);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("3D 레이마칭 예제 상태 버퍼 회귀 테스트 완료");
})();
