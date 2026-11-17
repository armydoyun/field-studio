// 편집기가 보여 주는 프로젝트 정보(cm-glsl-features.js · studio.js uniformValues · projectReferences):
//  · 파라미터 현재 값: uniform 선언 줄 끝에 '= 값'(색이면 견본) · 값이 바뀌면 따라 바뀜 · 누르면 파라미터 패널의 그 행으로
//  · 참조 찾기(Shift+F12)가 Common의 이름 · 같은 Uniform은 다른 탭에서 쓰인 곳까지 · 고르면 그 탭의 그 자리로
//    (그 패스 안에서 따로 선언한 같은 이름은 빼고)
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    $ = id => document.getElementById(id);
  const test = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(25)) if (check()) return;
    throw new Error(`FAIL: 시간 초과 — ${label}`);
  };
  const values = () => [...document.querySelectorAll(".studio-cm-host .cm-param-value")];
  const COMMON = "uniform float uAmount;   // @range 0 1 @default 0.5\nfloat wobble(float t) { return sin(t) * uAmount; }";
  const project = () => ({
    common: COMMON,
    image:
      "uniform float uGain; // @range 0 1 @default 0.25\nuniform vec3 uTint; // @color @default 1 0.5 0\nuniform sampler2D iChannel0;\nvoid mainImage(out vec4 c, in vec2 p) {\n  c = texture(iChannel0, p / iResolution.xy) + vec4(uTint * wobble(1.0) * uGain, 1.0);\n}",
    passes: [
      {
        name: "A",
        format: "rgba8",
        scale: 1,
        size: [4, 4],
        filter: "nearest",
        channels: {},
        fragment: "void mainImage(out vec4 c, in vec2 p) {\n  float a = wobble(iTime);\n  { float wobble = 2.0; a += wobble; }\n  c = vec4(a);\n}",
      },
    ],
    imageChannels: { 0: { buffer: "A", frame: "current" } },
  });
  const before = studio.getProject();
  try {
    studio.open();
    test(studio.setProject(project()), "Common · 버퍼가 있는 프로젝트");
    $("studioTab-Image").click();
    await until(() => values().length === 2, `값 표시 2개(${values().map(v => v.textContent)})`);
    test(values()[0].textContent === "= 0.25" && values()[0].dataset.name === "uGain", `숫자 값(${values()[0].textContent})`);
    test(values()[1].querySelector(".cm-param-swatch") && /\(1\.0, 0\.5, 0\.0\)/.test(values()[1].textContent), `색 값 · 견본(${values()[1].textContent})`);
    // 값이 바뀌면 따라 바뀐다
    r.setUniform("uGain", 0.8);
    await until(() => values()[0]?.textContent === "= 0.8", "값이 바뀌면 표시도");
    // 누르면 파라미터 패널의 그 행으로
    values()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await until(() => document.querySelector('.uniform-row.is-located[data-name="uGain"]'), "파라미터 행을 찾아 표시");
    // 참조 찾기: Image에서 Common 함수 wobble → Common 정의 · Buffer A에서 쓴 곳(안쪽 블록의 다른 wobble은 빼고)
    const area = $("studioCode"),
      at = area.value.indexOf("wobble(1.0)") + 2;
    document.querySelector(".studio-cm-host .cm-content").focus();
    area.setSelectionRange(at, at);
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", code: "F12", shiftKey: true, bubbles: true, cancelable: true }));
    const rows = () => [...document.querySelectorAll(".studio-palette-list button")];
    await until(() => !document.querySelector(".studio-palette").hidden && rows().length === 3, `참조 3곳(${rows().map(b => b.textContent)})`);
    test(/다른 탭 2곳/.test(document.querySelector(".studio-palette-input").placeholder), "제목에 다른 탭 개수");
    test(rows().some(b => /Common · Ln 2 · 선언/.test(b.textContent)), "Common의 선언");
    const bufferRow = rows().find(b => /Buffer A · Ln 2/.test(b.textContent));
    test(bufferRow && !rows().some(b => /Buffer A · Ln 3/.test(b.textContent)), "Buffer A: Common 것을 쓴 곳만(안쪽 블록의 wobble은 빼고)");
    bufferRow.click();
    await until(() => area.value.includes("float a = wobble(iTime);"), "Buffer A 탭으로 이동");
    test(area.value.slice(area.selectionStart, area.selectionEnd) === "wobble" && /Buffer A 2번째 줄/.test($("studioMessage").textContent), "그 자리의 이름을 선택");
    // 같은 Uniform: Common의 uAmount를 Common 탭에서 찾으면 다른 탭에는 없다(쓰지 않음) — 지역 이름은 다른 탭을 보지 않는다
    $("studioTab-A").click();
    await wait(30);
    const local = area.value.indexOf("float a") + 6;
    document.querySelector(".studio-cm-host .cm-content").focus();
    area.setSelectionRange(local, local);
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", code: "F12", shiftKey: true, bubbles: true, cancelable: true }));
    await until(() => !document.querySelector(".studio-palette").hidden, "지역 변수 참조");
    test(!/다른 탭/.test(document.querySelector(".studio-palette-input").placeholder) && rows().length === 3, "지역 변수는 이 탭만");
    document.querySelector(".studio-palette-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  } finally {
    studio.setProject(before);
  }
  console.log("편집기 정보 표시 검사 통과");
})();
