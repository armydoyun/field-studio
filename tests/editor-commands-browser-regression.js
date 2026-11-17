// 코드 편집기 명령(cm-editor.js)의 결과 — 실제 앱에서 키를 눌러 문서가 어떻게 바뀌는지 본다.
//  · Ctrl+Shift+L / Ctrl+F2: 선택이 비어 있으면 커서 아래 단어와 단어 전체가 같은 곳만 고른다(float · main 안의 a는 빼고)
//  · 선택이 있으면 그 글자가 들어간 곳을 모두 고른다
//  · 찾기 창: '결과 없음' 뒤에 정규식이 틀리면 개수 글자가 빨갛고, 일치가 생기면 다시 보통 색이다(앞 상태 색이 남지 않는다)
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
    // 찾기 창의 개수 색
    await setDoc(src, 0);
    key("f", { code: "KeyF", ctrlKey: true });
    await frames(2);
    const panel = document.querySelector(".studio-find"),
      field = panel?.querySelector("[name=search]"),
      regexp = panel?.querySelector("[name=re]");
    test(!!field && !!regexp, "찾기 창이 열린다");
    const search = async text => {
      field.value = text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await frames(1);
      return { count: panel.querySelector(".studio-find-count").textContent, red: panel.classList.contains("has-no-match") };
    };
    regexp.click();
    let state = await search("vec\\d");
    test(state.count.endsWith("/2") && !state.red, `정규식 일치 2개는 보통 색(${state.count})`);
    state = await search("(");
    test(state.count === "잘못된 식" && state.red, "틀린 정규식은 빨간 글자로 '잘못된 식'");
    state = await search("vec\\d");
    test(!state.red, "다시 일치하면 빨간색이 풀린다");
    state = await search("zzz");
    test(state.count === "결과 없음" && state.red, "일치가 없으면 빨간 '결과 없음'");
    state = await search("(");
    test(state.red, "결과 없음 다음의 틀린 정규식도 빨갛다");
    state = await search("");
    test(state.count === "" && !state.red, "찾기 칸을 비우면 표시가 없다");
    regexp.click();
    key("Escape", { code: "Escape" });
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  } finally {
    studio.setProject(before);
    if (!wasOpen) studio.close();
  }
  console.log("편집기 명령 검사 통과");
})();
