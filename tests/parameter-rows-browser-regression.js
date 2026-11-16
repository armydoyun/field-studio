// 파라미터 목록을 행 단위로 그린다(ui.js renderUniforms · buildRow):
//  · 검색 · 변경만 보기 · @if로 걸러도 남는 행은 그대로, 다시 보이는 행도 새로 만들지 않는다
//  · 밖에서 값만 바뀌면(값 묶음 적용 · 되돌리기) 행을 남긴 채 보이는 값만 바뀐다 — 숫자 · 켜기 · 선택지 · 색 · 벡터 · 위치 · 방향 · 행렬
//  · 그라데이션처럼 값만 고치는 함수가 없는 행은 그 행만 다시 만든다
//  · 코드 주석(@range 등)을 바꾸면 그 파라미터 행만 다시 만들고, 연결 시트를 열고 닫아도 그 행만 바뀐다
//  · 지운 파라미터의 행은 사라지고 같은 이름을 다시 만들면 새 행이 된다 · 묶음 접기도 그대로 동작한다
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
  const row = name => document.querySelector(`#uniformList .uniform-row[data-name="${name}"]`);
  const rows = () => [...document.querySelectorAll("#uniformList .uniform-row")];
  const snapshot = () => new Map(rows().map(node => [node.dataset.name, node]));
  const search = text => {
    $("uniformSearch").value = text;
    $("uniformSearch").dispatchEvent(new Event("input", { bubbles: true }));
  };
  const user = name => r.getUserUniforms().find(u => u.name === name);
  const setValues = values => studio.setParameterValues(Object.entries(values).map(([name, value]) => ({ ...user(name), value })));
  const image = (range = "@range 0 1") =>
    [
      `uniform float uGain;   // 밝기 · ${range} @default 0.5`,
      "uniform bool uOn;      // 켜기 · @default true",
      "uniform int uMode;     // 보기 · @enum 가 나 다 @default 0",
      "uniform vec3 uTint;    // 색 · @color @default 1 0 0 @group 모양",
      "uniform vec3 uOffset;  // @range -1 1 @default 0 0 0 @group 모양",
      "uniform vec2 uSpot;    // @pos @default 0.5 0.5 @group 모양",
      "uniform vec3 uSun;     // @dir @default 0 1 0 @group 빛",
      "uniform mat2 uTurn;    // @default 1",
      "uniform sampler2D uRamp; // @gradient @group 빛",
      "uniform float uFog;    // @range 0 1 @default 0 @if uOn",
      "void mainImage(out vec4 c, in vec2 p) {",
      "  c = vec4(texture(uRamp, p / iResolution.xy).rgb * uTint * uGain + uOffset + vec3(uSpot, float(uMode)) + uSun * uFog, 1.0);",
      "  c.xy = uTurn * c.xy; if (!uOn) c *= 0.5;",
      "}",
    ].join("\n");
  const before = studio.getProject(),
    links = settings.getLinks();
  try {
    settings.setLinks([]);
    test(studio.setProject({ image: image(), passes: [], imageChannels: {} }), "검사 장면");
    await until(() => r.getUserUniforms().length === 10, "파라미터 10개 등록");
    $("tab-uniforms").click();
    search("");
    await wait(50);
    const all = snapshot();
    test(all.size === 10, "처음에는 10개 행");

    // 1) 검색: 남는 행은 그대로, 지우면 걸렀던 행도 새로 만들지 않고 돌아온다
    search("uG");
    test(rows().length === 1 && row("uGain") === all.get("uGain"), "검색: 남는 행은 같은 요소");
    search("");
    test(rows().length === 10 && [...snapshot()].every(([name, node]) => node === all.get(name)), "검색을 지우면 모든 행이 같은 요소로 돌아온다");

    // 2) 밖에서 값만 바뀜: 행을 남긴 채 보이는 값만 바뀐다
    setValues({ uGain: 0.25, uOn: false, uMode: 2, uTint: [0, 0, 1], uOffset: [0.5, -0.5, 0], uSpot: [0.1, 0.9], uSun: [1, 0, 0], uTurn: [0, 1, -1, 0] });
    await wait(50);
    const kept = ["uGain", "uOn", "uMode", "uTint", "uOffset", "uSpot", "uSun", "uTurn"];
    test(kept.every(name => row(name) === all.get(name)), `값만 바뀐 행은 그대로(${kept.filter(name => row(name) !== all.get(name)).join(", ") || "모두"})`);
    test(Number(row("uGain").querySelector('input[type="number"]').value) === 0.25, "숫자 칸이 새 값");
    test(row("uOn").querySelector('input[role="switch"]').checked === false, "켜기 스위치가 새 값");
    test(row("uMode").querySelector('[aria-pressed="true"]')?.textContent.includes("다"), "선택지가 새 값");
    test(row("uTint").querySelector('input[type="color"]').value === "#0000ff", "색 견본이 새 값");
    test(Number(row("uOffset").querySelector('input[type="number"]').value) === 0.5, "벡터 성분이 새 값");
    // 되돌리기도 같다
    studio.undo();
    await wait(50);
    test(kept.every(name => row(name) === all.get(name)), "되돌리기도 행을 남긴다");
    test(Number(row("uGain").querySelector('input[type="number"]').value) === 0.5, "되돌린 값을 보여 준다");

    // 3) @if: uOn을 끄면 uFog 행만 떼어 두고, 다시 켜면 같은 요소가 돌아온다
    setValues({ uOn: false });
    await wait(50);
    test(!row("uFog") && row("uGain") === all.get("uGain"), "@if로 숨으면 그 행만 빠진다");
    setValues({ uOn: true });
    await wait(50);
    test(row("uFog") === all.get("uFog"), "@if로 다시 보이면 같은 요소");

    // 4) 그라데이션은 값만 고치는 함수가 없어 그 행만 다시 만든다
    const ramp = user("uRamp");
    setValues({ uRamp: ramp.value.map((v, i) => (i === 1 ? 1 - v : v)) });
    await wait(50);
    test(row("uRamp") !== all.get("uRamp") && row("uGain") === all.get("uGain"), "그라데이션 값이 바뀌면 그 행만 다시 만든다");

    // 5) 코드 주석을 바꾸면 그 행만 다시 만든다
    const mid = snapshot();
    test(studio.setProject({ image: image("@range 0 2"), passes: [], imageChannels: {} }), "@range 바꾸기");
    await until(() => row("uGain") !== mid.get("uGain"), "uGain 행을 다시 만든다");
    test(row("uMode") === mid.get("uMode") && row("uTint") === mid.get("uTint"), "다른 행은 그대로");
    test(row("uGain").querySelector('input[type="range"]').max === "2", "새 범위");

    // 6) 연결 시트를 열고 닫아도 그 행만
    const beforeLink = snapshot();
    row("uGain").querySelector(".link-uniform").click();
    await wait(50);
    test(row("uGain").querySelector(".link-editor") && row("uMode") === beforeLink.get("uMode"), "시트를 열면 그 행만 바뀐다");
    row("uGain").querySelector(".link-uniform").click();
    await wait(50);
    test(!row("uGain").querySelector(".link-editor") && row("uTint") === beforeLink.get("uTint"), "시트를 닫아도 그 행만");

    // 7) 묶음 접기 · 펴기는 그대로
    const head = [...document.querySelectorAll(".uniform-group-head")].find(node => node.textContent.includes("모양"));
    head.click();
    await wait(30);
    test(head.closest(".uniform-group").classList.contains("is-collapsed") && head.getAttribute("aria-expanded") === "false", "묶음 접기");
    head.click();
    await wait(30);
    test(!head.closest(".uniform-group").classList.contains("is-collapsed") && row("uTint") === beforeLink.get("uTint"), "묶음 펴기 · 행은 그대로");

    // 8) 지운 파라미터의 행은 사라지고, 같은 이름을 다시 만들면 새 행
    const fog = row("uFog");
    row("uFog").querySelector(".remove-uniform").click();
    await until(() => !row("uFog"), "지운 행이 사라진다");
    test(row("uGain") && rows().length === 9, "다른 행은 남는다");
    studio.undo();
    await until(() => row("uFog"), "되돌리면 다시 생긴다");
    test(row("uFog") !== fog, "다시 만든 파라미터는 새 행");
  } finally {
    search("");
    settings.setLinks(links);
    studio.setProject(before);
  }
  console.log("파라미터 행 단위 그리기 검사 통과");
})();
