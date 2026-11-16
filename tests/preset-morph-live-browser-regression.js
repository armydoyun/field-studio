// 프리셋을 부드럽게 바꾸는 동안: 값은 행에서 바로 움직이고, 목록 전체를 다시 그리지 않는다(깜빡임 · 눌러 둔 곳을 잃지 않게).
// 숫자 · 선택지 · 각도 · 색 · 벡터는 행이 바로 갱신한다. 그럴 수 없는 종류(위치 패드 @pos)가 섞이면 이전처럼 목록을 다시 그린다.
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    settings = window.shaderSettings,
    $ = id => document.getElementById(id);
  const test = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return;
    throw new Error(`FAIL: 시간 초과 — ${label}`);
  };
  const before = studio.getProject(),
    presets = settings.getPresets(),
    blend = $("presetBlend").value;
  const row = name => document.querySelector(`#uniformList .uniform-row[data-name="${name}"]`);
  const value = name => r.getUserUniforms().find(u => u.name === name).value;
  try {
    test(
      studio.setProject({
        image: [
          "uniform float uGain; // @range 0 1 @default 0",
          "uniform int uMode; // @enum 가 나 다 @default 0",
          "uniform vec3 uTint; // @color @default 0 0 0",
          "uniform vec3 uOffset; // @range -1 1 @default 0 0 0",
          "uniform vec2 uSpot; // @pos @default 0.5 0.5",
          "void mainImage(out vec4 c, in vec2 p) { c = vec4(uTint * uGain + float(uMode) + uOffset + vec3(uSpot, 0.0), 1.0); }",
        ].join("\n"),
        passes: [],
        imageChannels: {},
      }),
      "검사 장면"
    );
    await until(() => r.getUserUniforms().length === 5, "파라미터 등록");
    $("tab-uniforms").click();
    settings.setPresets([
      { name: "숫자만", values: { uGain: 1, uMode: 2 } },
      { name: "색 · 벡터", values: { uGain: 0, uTint: [1, 1, 1], uOffset: [1, -1, 0.5] } },
      { name: "위치 포함", values: { uGain: 1, uSpot: [0.1, 0.9] } },
    ]);
    await until(() => document.querySelectorAll(".preset-apply").length === 3, "프리셋 막대");
    const apply = name => [...document.querySelectorAll(".preset-apply")].find(b => b.textContent === name).click();
    $("presetBlend").value = "4"; // 넉넉히: 동시에 도는 테스트로 느려져도 중간에서 볼 수 있게

    // 숫자 · 선택지만 바뀌는 전환: 행이 그대로 남고 슬라이더가 따라 움직인다
    const gainRow = row("uGain"),
      modeRow = row("uMode");
    apply("숫자만");
    // updateStats(0.5초)가 적어도 한 번 지나가고 값이 움직이기 시작할 때까지(부하가 크면 프레임이 늦다)
    const started = Date.now();
    await until(() => Date.now() - started > 600 && value("uGain") > 0, "전환이 움직인다", 3500);
    const middle = value("uGain");
    test(middle > 0 && middle < 1, "전환 중간값");
    test(row("uGain") === gainRow && row("uMode") === modeRow, "전환 중에는 목록을 다시 그리지 않는다");
    const slider = gainRow.querySelector('input[type="range"]');
    test(!slider || Math.abs(Number(slider.value) - middle) < 0.05, "슬라이더가 지금 값을 보여 준다");
    await until(() => value("uGain") === 1 && value("uMode") === 2, "전환 끝", 15000);

    // 색 · 벡터도 행에서 바로: 목록은 그대로, 색 견본과 성분 칸이 따라 바뀐다
    const tintRow = row("uTint"),
      offsetRow = row("uOffset"),
      swatch = tintRow.querySelector('input[type="color"]'),
      firstAxis = offsetRow.querySelector('input[type="number"]');
    const swatchBefore = swatch.value;
    apply("색 · 벡터");
    const colorStarted = Date.now();
    await until(() => Date.now() - colorStarted > 600 && value("uTint")[0] > 0, "색 전환이 움직인다", 3500);
    test(value("uTint")[0] > 0 && value("uTint")[0] < 1, "색 전환 중간값");
    test(row("uTint") === tintRow && row("uOffset") === offsetRow, "색 · 벡터 전환 중에도 목록을 다시 그리지 않는다");
    test(swatch.value !== swatchBefore, "색 견본이 지금 값을 따라간다");
    test(Math.abs(Number(firstAxis.value) - value("uOffset")[0]) < 0.01, "벡터 성분 칸이 지금 값을 보여 준다");
    await until(() => value("uGain") === 0 && value("uOffset")[0] === 1, "두 번째 전환 끝", 15000);

    // 위치 패드(@pos)는 바로 갱신하는 함수가 없다 — 이전처럼 목록을 다시 그려 값을 맞춘다
    const spotRow = row("uSpot");
    apply("위치 포함");
    await until(() => row("uSpot") !== spotRow, "위치 패드가 섞인 전환은 목록을 다시 그린다", 5000);
    await until(() => value("uGain") === 1, "세 번째 전환 끝", 15000);
  } finally {
    $("presetBlend").value = blend;
    settings.setPresets(presets);
    studio.setProject(before);
  }
  console.log("프리셋 전환 중 행 갱신 검사 통과");
})();
