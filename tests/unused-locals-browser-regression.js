// 쓰지 않는 지역 변수(glsl-scope.js unusedLocals · cm-glsl-features.js):
//  · 선언만 하고 쓰지 않는 지역 변수 이름을 흐리게(.cm-unused) · 마우스를 올리면 설명 · 쓰기 시작하면 표시가 사라진다
//  · 명령 팔레트 '쓰지 않는 변수 지우기': 지울 수 있는 것(그 변수 하나만 선언한 문장)을 한 번에, 되돌리기 한 칸
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
  const setCode = text => {
    const area = $("studioCode");
    area.value = text;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const marked = () => [...document.querySelectorAll(".studio-cm-host .cm-unused")].map(node => node.textContent);
  const code = [
    "void mainImage(out vec4 c, in vec2 p) {",
    "  vec2 uv = p / iResolution.xy;",
    "  float dead = sin(iTime);",
    "  vec3 col = vec3(uv, 0.5), spare = vec3(1.0);",
    "  c = vec4(col, 1.0);",
    "}",
  ].join("\n");
  try {
    studio.open();
    setCode(code);
    await until(() => marked().length === 2, `흐리게 표시: ${marked()}`);
    test(marked().join() === "dead,spare", "쓰지 않는 변수만 흐리게(uv · col은 씀)");
    test(/쓰지 않는 변수: dead/.test(document.querySelector(".studio-cm-host .cm-unused").title), "마우스를 올리면 설명");
    // 쓰기 시작하면 표시가 사라진다
    setCode(code.replace("c = vec4(col, 1.0);", "c = vec4(col * dead, 1.0);"));
    await until(() => marked().join() === "spare", "dead를 쓰면 표시가 사라진다");
    setCode(code);
    await until(() => marked().length === 2, "다시 표시");
    // 명령 팔레트로 지우기
    const content = document.querySelector(".studio-cm-host .cm-content");
    content.focus();
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "F1", code: "F1", bubbles: true, cancelable: true }));
    const input = document.querySelector(".studio-palette-input");
    await until(() => !document.querySelector(".studio-palette").hidden, "팔레트 열림");
    input.value = ">쓰지 않는 변수";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(30);
    test(/쓰지 않는 변수 지우기/.test(document.querySelector(".studio-palette-list button")?.textContent || ""), "팔레트에 '쓰지 않는 변수 지우기'");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until(() => !studio.getEditorSource().includes("float dead"), "dead 줄을 지움");
    const after = studio.getEditorSource();
    test(after.split("\n").length === 5 && after.includes("spare = vec3(1.0)"), "줄째 지우고 · 여럿 선언한 문장은 그대로");
    test(/쓰지 않는 변수 1개를 지웠습니다 \(dead\) · 1개는 직접 지우세요/.test($("studioMessage").textContent), `안내: ${$("studioMessage").textContent}`);
    studio.undo();
    await until(() => studio.getEditorSource() === code, "되돌리기 한 칸으로 돌아온다");
  } finally {
    studio.setProject(before);
  }
  console.log("쓰지 않는 변수 검사 통과");
})();
