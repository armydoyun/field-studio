// 코드 편집기 명령(cm-editor.js)의 결과 — 실제 앱에서 키를 눌러 문서가 어떻게 바뀌는지 본다.
//  · Ctrl+Shift+L / Ctrl+F2: 선택이 비어 있으면 커서 아래 단어와 단어 전체가 같은 곳만 고른다(float · main 안의 a는 빼고)
//  · 선택이 있으면 그 글자가 들어간 곳을 모두 고른다
(async () => {
  const studio = window.shaderStudio,
    $ = id => document.getElementById(id);
  const test = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const before = studio.getProject(),
    wasOpen = !$("studioDock").hidden;
  const area = $("studioCode");
  const content = () => document.querySelector(".studio-cm-host .cm-content");
  // 문서와 선택을 정하고 편집기에 초점을 둔다(#studioCode는 CodeMirror의 textarea 창구)
  const setDoc = async (text, from, to = from) => {
    test(studio.setProject({ image: text, passes: [], imageChannels: {} }), "장면을 바꾼다");
    await frames(2);
    area.setSelectionRange(from, to);
    content().focus();
    await frames(1);
  };
  const key = (key, options = {}) =>
    content().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
  // 실제 입력처럼 넣는다(커서가 여러 개면 모두에 들어간다)
  const type = async text => {
    content().focus();
    document.execCommand("insertText", false, text);
    await frames(1);
  };
  try {
    studio.open();
    await frames(4);
    const src = "#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() {\n    float a = 1.0;\n    float b = a + 2.0;\n    o = vec4(a, b, 0.0, 1.0);\n}\n";
    for (const [label, options] of [
      ["Ctrl+Shift+L", { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true }],
      ["Ctrl+F2", { key: "F2", code: "F2", ctrlKey: true }],
    ]) {
      await setDoc(src, src.indexOf("a = 1"));
      key(options.key, options);
      await frames(1);
      await type("Q");
      test(area.value.includes("precision highp float;") && area.value.includes("void main()"), `${label}: float · main 안의 a는 바뀌지 않는다`);
      test((area.value.match(/\bQ\b/g) || []).length === 3, `${label}: 변수 a 세 곳이 함께 바뀐다`);
    }
    // 선택이 있으면 글자가 들어간 곳 모두(단어 경계를 보지 않는다)
    await setDoc(src, src.indexOf("oat"), src.indexOf("oat") + 3);
    key("L", { code: "KeyL", ctrlKey: true, shiftKey: true });
    await frames(1);
    await type("OAT");
    test((area.value.match(/flOAT/g) || []).length === 3, "선택한 글자 oat가 들어간 곳 모두 바뀐다");
  } finally {
    studio.setProject(before);
    if (!wasOpen) studio.close();
  }
  console.log("편집기 명령 검사 통과");
})();
