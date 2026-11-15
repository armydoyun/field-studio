// 일시정지 중에도 파라미터 연결의 변경이 바로 값에 반영된다(renderer.setLinks가 한 번 그린다).
// 연결 시트 말고 다른 길 — 되돌리기 · 타임라인 레인 지우기 · 프로젝트 열기 — 도 settings.setLinks를 지난다.
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    settings = window.shaderSettings;
  const test = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const settle = async () => {
    for (let i = 0; i < 3; i++) await frames();
  };
  const before = studio.getProject(),
    links = settings.getLinks(),
    wasRunning = r.getStats().running;
  const value = () => r.getUserUniforms().find(u => u.name === "uGain").value;
  const keys = v => [{ name: "uGain", source: "keys", keys: [[0, v]], loop: 0, ease: "linear", smooth: 0 }];
  try {
    settings.setLinks([]);
    test(
      studio.setProject({
        image: "uniform float uGain; // @range 0 1 @default 0.2\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(uGain); }",
        passes: [],
        imageChannels: {},
      }),
      "검사 장면"
    );
    await settle();
    r.stop();
    await settle();
    test(!r.getStats().running, "일시정지");
    settings.setLinks(keys(0.33));
    await settle();
    test(Math.abs(value() - 0.33) < 1e-6, "일시정지 중 연결을 만들면 값이 바로 바뀜");
    settings.setLinks(keys(0.8));
    await settle();
    test(Math.abs(value() - 0.8) < 1e-6, "일시정지 중 연결을 바꾸면 값이 바로 바뀜");
    studio.undo();
    await settle();
    test(JSON.stringify(settings.getLinks()[0]?.keys) === "[[0,0.33]]", "되돌리기로 이전 연결");
    test(Math.abs(value() - 0.33) < 1e-6, "일시정지 중 되돌리기도 연결 값을 반영");
    test(!r.getStats().running, "한 번 그린 뒤에도 일시정지 유지");
  } finally {
    settings.setLinks(links);
    studio.setProject(before);
    if (wasRunning && !r.getStats().running) r.start();
  }
  console.log("일시정지 중 연결 반영 검사 통과");
})();
