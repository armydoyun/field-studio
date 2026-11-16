// 프리셋을 부드럽게 바꾸는 동안: 값은 행에서 바로 움직이고, 목록 전체를 다시 그리지 않는다(깜빡임 · 눌러 둔 곳을 잃지 않게).
// 행이 바로 보여 줄 수 없는 종류(색 · 벡터)가 섞이면 이전처럼 목록을 다시 그려 값을 맞춘다.
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
          "void mainImage(out vec4 c, in vec2 p) { c = vec4(uTint * uGain + float(uMode), 1.0); }",
        ].join("\n"),
        passes: [],
        imageChannels: {},
      }),
      "검사 장면"
    );
    await until(() => r.getUserUniforms().length === 3, "파라미터 등록");
    $("tab-uniforms").click();
    settings.setPresets([
      { name: "숫자만", values: { uGain: 1, uMode: 2 } },
      { name: "색 포함", values: { uGain: 0, uTint: [1, 1, 1] } },
    ]);
    await until(() => document.querySelectorAll(".preset-apply").length === 2, "프리셋 막대");
    const apply = name => [...document.querySelectorAll(".preset-apply")].find(b => b.textContent === name).click();
    $("presetBlend").value = "4"; // 넉넉히: 동시에 도는 테스트로 느려져도 중간에서 볼 수 있게

    // 숫자 · 선택지만 바뀌는 전환: 행이 그대로 남고 슬라이더가 따라 움직인다
    const gainRow = row("uGain"),
      modeRow = row("uMode");
    apply("숫자만");
    await wait(650); // updateStats(0.5초)가 적어도 한 번 지나간다
    const middle = value("uGain");
    test(middle > 0 && middle < 1, "전환 중간값");
    test(row("uGain") === gainRow && row("uMode") === modeRow, "전환 중에는 목록을 다시 그리지 않는다");
    const slider = gainRow.querySelector('input[type="range"]');
    test(!slider || Math.abs(Number(slider.value) - middle) < 0.05, "슬라이더가 지금 값을 보여 준다");
    await until(() => value("uGain") === 1 && value("uMode") === 2, "전환 끝", 15000);

    // 색이 섞이면 이전처럼 목록을 다시 그려 값을 맞춘다(색 칸이 바로 따라가는 함수를 갖지 않음)
    const tintRow = row("uTint");
    apply("색 포함");
    await until(() => row("uTint") !== tintRow, "색이 섞인 전환은 목록을 다시 그린다", 3000);
    await until(() => value("uGain") === 0, "두 번째 전환 끝", 15000);
  } finally {
    $("presetBlend").value = blend;
    settings.setPresets(presets);
    studio.setProject(before);
  }
  console.log("프리셋 전환 중 행 갱신 검사 통과");
})();
