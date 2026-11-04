// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 편집기 선택 영역의 띠가 줄 상자와 같은 높이·위치로 그려지는지 본다.
// (CodeMirror 기본 drawSelection은 줄 일부만 선택된 첫·마지막 줄을 글자 높이로만 칠해 띠 굵기가 줄마다 달랐다.)
(async () => {
  const studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const before = studio.getProject();
  const wrapButton = $("studioLineWrap"), wasWrapped = wrapButton.getAttribute("aria-pressed") === "true";
  const long = "    float x = " + Array.from({ length: 40 }, (_, i) => `${i}.0`).join(" + ") + ";";
  const source = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
${long}
    fragColor = vec4(x);
}`;
  // 띠 하나하나가 어떤 줄(또는 화면 행) 상자의 위·아래 경계와 맞는지 본다.
  const check = (from, to, label) => {
    const code = $("studioCode");
    code.focus();
    code.setSelectionRange(from, to);
    return frame().then(() => {
      const bands = [...document.querySelectorAll(".studio-selection-layer .cm-selectionBackground")].map(e => e.getBoundingClientRect());
      const rows = [...document.querySelectorAll(".cm-content .cm-line")].flatMap(line => {
        const r = line.getBoundingClientRect(), h = parseFloat(getComputedStyle(line).lineHeight) || r.height;
        const n = Math.max(1, Math.round(r.height / h));
        return Array.from({ length: n + 1 }, (_, k) => r.top + (k * r.height) / n);
      });
      const onEdge = y => rows.some(edge => Math.abs(edge - y) < 0.6);
      test(bands.length > 0, `${label}: 선택 띠가 그려짐`);
      test(bands.every(b => onEdge(b.top) && onEdge(b.bottom)), `${label}: 띠 위·아래가 줄 경계에 맞음`);
      const lineHeight = parseFloat(getComputedStyle(document.querySelector(".cm-line")).lineHeight);
      test(bands.every(b => b.height >= lineHeight - 0.6), `${label}: 띠 높이가 한 줄 높이 이상`);
      // 기본 레이어는 숨겨져 있어야 띠가 두 겹으로 보이지 않는다.
      const hidden = [...document.querySelectorAll(".cm-selectionLayer:not(.studio-selection-layer)")];
      test(hidden.every(layer => getComputedStyle(layer).display === "none"), `${label}: 기본 선택 레이어 숨김`);
    });
  };
  try {
    studio.open();
    test(studio.setProject({ image: source, passes: [], imageChannels: {} }), "테스트 코드 적용");
    await frame();
    const text = $("studioCode").value, start = text.indexOf("precision") + 4, end = text.indexOf("fragColor = ") + 5;
    await check(start, end, "여러 줄");
    await check(text.indexOf("highp"), text.indexOf("highp") + 5, "한 줄 안");
    if (!wasWrapped) wrapButton.click();
    await frame();
    const x = text.indexOf("float x") + 2;
    await check(x, x + long.length - 6, "줄바꿈된 긴 줄");
  } finally {
    if ((wrapButton.getAttribute("aria-pressed") === "true") !== wasWrapped) wrapButton.click();
    if (!studio.setProject(before)) console.warn("테스트 이전 프로젝트 복원 실패");
  }
})();
