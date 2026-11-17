// 파라미터를 직접 바꾼 뒤 '기본값으로 되돌리기'를 누르면 행의 조작도 기본값을 보여 준다(ui.js 행 캐시 · parameter-row.js):
//  · 그라데이션에 정지점을 더한 뒤 되돌리면 더한 정지점 손잡이가 사라지고, 남은 손잡이를 끌어도 지운 정지점이 되살아나지 않는다
//  · 곡선에 점을 더한 뒤 되돌려도 같다 · 슬라이더도 기본값 자리로 돌아온다
//  (행을 남겨 두고 값만 갱신하는 목록이, 행이 보여 주는 값을 처음 값으로 기억하고 있어 '바뀐 것 없음'으로 보던 버그)
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    $ = id => document.getElementById(id);
  const check = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS ${label}`);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const row = name => [...$("uniformList").querySelectorAll(".uniform-row")].find(node => node.dataset.name === name);
  const value = name => r.getUserUniforms().find(item => item.name === name)?.value;
  const pointer = (node, type, clientX, clientY = 0) =>
    node.dispatchEvent(
      new PointerEvent(type, { button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 7, clientX, clientY, bubbles: true, cancelable: true })
    );
  const release = () => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
  const capture = Element.prototype.setPointerCapture;
  const before = studio.getProject(),
    users = r.getUserUniforms(),
    panelHidden = document.body.classList.contains("panel-hidden");
  try {
    Element.prototype.setPointerCapture = () => {};
    check(
      studio.setProject({
        image: [
          "uniform sampler2D uRamp; // @gradient @default 0 #000000 1 #ffffff",
          "uniform sampler2D uBend; // @curve @default 0 0 1 1",
          "uniform float uGain;     // @range 0 1 @default 0.25",
          "void mainImage(out vec4 c, in vec2 p) { c = vec4(texture(uRamp, vec2(0.5)).rgb * texture(uBend, vec2(0.5)).r * uGain, 1.0); }",
        ].join("\n"),
        passes: [],
        imageChannels: {},
      }),
      "검사 장면"
    );
    if (panelHidden) $("panelToggle").click();
    $("tab-uniforms").click();
    await wait(100);
    const initialRamp = JSON.stringify(value("uRamp"));
    // 1) 그라데이션: 정지점 더하기 → 되돌리기
    const handles = () => row("uRamp").querySelectorAll(".uniform-ramp-stop");
    const track = row("uRamp").querySelector(".uniform-ramp-track"),
      box = track.getBoundingClientRect();
    pointer(track, "pointerdown", box.left + box.width * 0.5);
    release();
    check(handles().length === 3 && value("uRamp").length === 15, "정지점 더함(3개)");
    row("uRamp").querySelector(".reset-uniform").click();
    await wait(50);
    check(JSON.stringify(value("uRamp")) === initialRamp, "값은 기본값으로");
    check(handles().length === 2, `손잡이도 기본값의 정지점 2개만(${handles().length})`);
    // 남은 손잡이를 끌어도 지운 정지점이 되살아나지 않는다
    const first = handles()[0],
      start = first.getBoundingClientRect(),
      x = start.left + start.width / 2;
    pointer(first, "pointerdown", x);
    pointer(first, "pointermove", x + box.width * 0.1);
    pointer(first, "pointerup", x + box.width * 0.1);
    release();
    check(value("uRamp").length === 10 && Math.abs(value("uRamp")[0] - 0.1) < 0.02, `끌면 정지점 2개 그대로 · 첫 정지점만 이동(${value("uRamp").length / 5}개)`);
    // 2) 곡선: 점 더하기 → 되돌리기
    const pad = row("uBend").querySelector(".uniform-curve-pad"),
      padBox = pad.getBoundingClientRect();
    const initialBend = JSON.stringify(value("uBend"));
    pointer(pad, "pointerdown", padBox.left + padBox.width * 0.5, padBox.top + padBox.height * 0.2);
    pointer(pad, "pointerup", padBox.left + padBox.width * 0.5, padBox.top + padBox.height * 0.2);
    release();
    check(value("uBend").length > 4, "곡선 점 더함");
    row("uBend").querySelector(".reset-uniform").click();
    await wait(50);
    check(JSON.stringify(value("uBend")) === initialBend, "곡선 값은 기본값으로");
    const [px, py] = [padBox.left + padBox.width * 0.5, padBox.top + padBox.height * 0.2];
    pointer(pad, "pointerdown", px, py);
    pointer(pad, "pointermove", px, py + 4);
    pointer(pad, "pointerup", px, py + 4);
    release();
    check(value("uBend").length <= 6, `되돌린 뒤 곡선을 만져도 지운 점이 되살아나지 않음(${value("uBend").length / 2}점)`);
    // 3) 슬라이더: 직접 바꾸기 → 되돌리기
    const slider = row("uGain").querySelector('input[type="range"]');
    slider.value = "0.8";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(30);
    check(Math.abs(value("uGain") - 0.8) < 1e-6, "슬라이더로 0.8");
    row("uGain").querySelector(".reset-uniform").click();
    await wait(50);
    check(value("uGain") === 0.25 && Math.abs(Number(row("uGain").querySelector('input[type="range"]').value) - 0.25) < 1e-6, `슬라이더도 기본값 자리로(${row("uGain").querySelector('input[type="range"]').value})`);
  } finally {
    Element.prototype.setPointerCapture = capture;
    studio.setProject(before);
    r.setUserUniforms(users);
    if (panelHidden !== document.body.classList.contains("panel-hidden")) $("panelToggle").click();
  }
  console.log("되돌리기 뒤 조작 동기화 검사 통과");
})();
