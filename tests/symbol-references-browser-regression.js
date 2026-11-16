// 같은 기호 강조 · 참조 찾기(glsl-scope.js referencesAt · cm-glsl-features.js · cm-editor.js 팔레트):
//  · 커서를 이름 위에 두면 그 기호가 쓰인 곳을 모두 강조(.cm-symbol-ref, 선언은 .is-decl) — 같은 이름의 다른 지역 변수는 빼고
//  · Shift+F12: 쓰인 곳 목록을 팔레트에(줄 · 선언 표시) · 고르면 그 자리로 · Esc는 원래 자리로
(async () => {
  const studio = window.shaderStudio,
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
  const before = studio.getProject();
  const code = [
    "float shade(float x) { return x * 0.5; }",
    "void mainImage(out vec4 c, in vec2 p) {",
    "  float x = shade(p.x);",
    "  { float x = 2.0; x += 1.0; }",
    "  c = vec4(x, x * 0.5, shade(x), 1.0);",
    "}",
  ].join("\n");
  const marks = () => [...document.querySelectorAll(".studio-cm-host .cm-symbol-ref")];
  const area = $("studioCode");
  const caret = at => {
    document.querySelector(".studio-cm-host .cm-content").focus();
    area.setSelectionRange(at, at);
  };
  const key = (name, extra = {}) =>
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra }));
  try {
    studio.open();
    area.value = code;
    area.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(50);
    // mainImage의 x(선언 1 + 쓰인 곳 3)
    const declAt = code.indexOf("float x = shade") + 6;
    caret(declAt + 1);
    await until(() => marks().length === 4, `강조 4곳(${marks().length})`);
    test(marks().filter(node => node.classList.contains("is-decl")).length === 1, "선언은 한 곳(is-decl)");
    test(marks().every(node => node.textContent === "x"), "강조는 이름만");
    // 안쪽 블록의 x: 그 블록 안 두 곳만
    caret(code.indexOf("x += 1.0"));
    await until(() => marks().length === 2, `안쪽 x는 따로(${marks().length})`);
    // 편집하면 강조가 지워졌다가 다시
    caret(code.indexOf("shade(p.x)") + 2);
    await until(() => marks().length === 3, "함수 shade: 정의 + 호출 두 곳");
    // Shift+F12: 참조 목록
    caret(declAt + 1);
    key("F12", { code: "F12", shiftKey: true });
    const palette = document.querySelector(".studio-palette"),
      rows = () => [...document.querySelectorAll(".studio-palette-list button")];
    await until(() => !palette.hidden && rows().length === 4, `참조 목록 4줄(${rows().length})`);
    test(/x — mainImage 함수의 지역 변수 · 4곳/.test(document.querySelector(".studio-palette-input").placeholder), "제목: 이름 · 종류 · 개수");
    test(rows()[0].classList.contains("is-selected") && /Ln 3 · 선언/.test(rows()[0].textContent), "커서 자리(선언)를 먼저 고름");
    key("ArrowDown");
    key("ArrowDown");
    await wait(20);
    const third = rows()[2].textContent;
    test(/Ln 5/.test(third), `세 번째: 5번째 줄(${third})`);
    key("Enter");
    await until(() => palette.hidden, "고르면 닫힘");
    const head = area.selectionStart;
    test(head > code.indexOf("c = vec4(") && code.slice(head, area.selectionEnd) === "x", "고른 자리로 이동 · 이름 선택");
    // Esc는 원래 자리로
    caret(declAt + 1);
    key("F12", { code: "F12", shiftKey: true });
    await until(() => !palette.hidden, "다시 열기");
    key("ArrowDown");
    await wait(20);
    key("Escape");
    await until(() => palette.hidden, "Esc로 닫힘");
    test(area.selectionStart === declAt + 1, "Esc는 원래 커서로");
    // 이름이 아닌 곳: 안내만
    caret(code.indexOf("0.5"));
    key("F12", { code: "F12", shiftKey: true });
    await wait(30);
    test(palette.hidden && /이름 위에 두세요/.test($("studioMessage").textContent), "이름이 아니면 안내");
  } finally {
    studio.setProject(before);
  }
  console.log("같은 기호 강조 · 참조 찾기 검사 통과");
})();
