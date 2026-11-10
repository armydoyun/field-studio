// 실제 DOM·WebGL에서 각도 표시는 감싸고 누적 Uniform은 유지하는지 확인한다.
(async () => {
  const renderer = window.shaderPlayground, studio = window.shaderStudio;
  const area = document.getElementById("studioCode"), live = document.getElementById("studioLive");
  const original = area.value, wasLive = live.checked;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const close = (actual, expected) => Math.abs(actual - expected) < 1e-8;
  const value = () => renderer.getUserUniforms().find(u => u.name === "uAngle").value;
  const setCode = text => { area.value = text; area.dispatchEvent(new Event("input", {bubbles:true})); };
  const controls = () => {
    const row = [...document.querySelectorAll("#uniformList .uniform-row")].find(r => r.querySelector(".uniform-name")?.textContent === "uAngle");
    return {row, number:row.querySelector('input[type="number"]'), slider:row.querySelector('input[type="range"]'),
      pad:row.querySelector("canvas"), turns:row.querySelector(".uniform-angle-turns")};
  };
  const edit = degrees => {
    const {number} = controls(); number.value = String(degrees); number.dispatchEvent(new Event("change", {bubbles:true}));
  };
  studio.open();
  live.checked = false; live.dispatchEvent(new Event("change"));
  try {
    setCode(`#version 300 es
precision highp float;
uniform float uAngle; // @angle @default 730deg @anim 0.1
out vec4 fragColor;
void main() { fragColor = vec4(vec3(0.5 + 0.5 * sin(uAngle * 0.5)), 1.0); }`);
    test(studio.apply(), "각도 장면 적용");
    document.getElementById("tab-uniforms").click();
    document.getElementById("uniformSearch").dispatchEvent(new Event("input"));
    let {number, slider, turns} = controls();
    test(number.value === "10" && slider.min === "0" && slider.max === "360", "730°를 10°로 표시, 슬라이더는 0~360°");
    test(turns.textContent === "누적 2회전" && close(value(), 730 * Math.PI / 180), "초기 누적 라디안 유지");
    edit(20);
    test(close(value(), 740 * Math.PI / 180) && controls().number.value === "20", "숫자 입력은 현재 회전 수에서 연결");
    controls().row.querySelector('[aria-label="uAngle을 270°로"]').click();
    test(close(value(), 630 * Math.PI / 180) && controls().number.value === "270", "프리셋은 가장 가까운 회전으로 연결");
    edit(-10);
    test(controls().number.value === "350" && controls().turns.textContent === "누적 -1회전", "음수 각도의 양수 표시와 회전 수");
    edit(0);
    controls().pad.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowRight", bubbles:true}));
    test(close(value(), -Math.PI / 180) && controls().number.value === "359", "역방향 0° 경계에서도 내부 값 연속");
    edit(719.96);
    test(controls().number.value === "0" && controls().slider.value === "0" && controls().turns.textContent === "누적 2회전", "반올림된 360°도 0°로 표시");
    test(close(value(), 719.96 * Math.PI / 180), "반올림은 실제 값을 바꾸지 않는다");
    edit(710);
    const {pad} = controls(), box = pad.getBoundingClientRect();
    test(box.width > 0 && box.height > 0, "다이얼 패드가 화면에 표시됨");
    const pointer = (type, degrees) => pad.dispatchEvent(new PointerEvent(type, {bubbles:true, pointerId:1, button:0,
      clientX:box.left + box.width / 2 + 20 * Math.cos(degrees * Math.PI / 180),
      clientY:box.top + box.height / 2 - 20 * Math.sin(degrees * Math.PI / 180)}));
    // 합성 이벤트에는 활성 포인터가 없으므로 실제 포인터 캡처만 생략한다.
    const capture = pad.setPointerCapture; pad.setPointerCapture = () => {};
    try { pointer("pointerdown", 350); pointer("pointermove", 0); pointer("pointermove", 10); pointer("pointerup", 10); }
    finally { pad.setPointerCapture = capture; }
    test(close(value(), 730 * Math.PI / 180) && controls().number.value === "10", "다이얼 드래그가 한 바퀴 경계를 지나도 누적값 유지");
    controls().row.querySelector(".play-uniform").click();
    await new Promise(resolve => setTimeout(resolve, 250));
    controls().row.querySelector(".play-uniform").click();
    ({number, turns} = controls());
    test(value() > 4 * Math.PI && Number(number.value) >= 0 && Number(number.value) < 360, "자동 재생도 표시만 정규화");
    test(turns.textContent === `누적 ${Math.floor(Math.round(value() * 180 / Math.PI * 10) / 10 / 360)}회전`, "재생 중 회전 수 갱신");
  } finally {
    setCode(original); studio.apply(); live.checked = wasLive; live.dispatchEvent(new Event("change"));
  }
})();
