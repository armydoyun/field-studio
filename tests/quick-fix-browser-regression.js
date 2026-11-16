// 컴파일 오류 빠른 수정(glsl-fix.js · cm-editor.js · studio.js 오류 줄):
//  · 자주 나는 오류(float에 정수 · 빠진 세미콜론 · 오타 이름 · 오타 함수 · vec4 자리에 vec3)에 고친 줄을 제안한다
//  · 오류 줄에 '빠른 수정' 꼬리표 · 편집기 오류 말풍선에 고치기 버튼(CodeMirror actions) · Ctrl+.로 적용 → 다시 실행하면 오류 없음
//  · 수정 한 번은 되돌리기 한 칸 · 그사이 그 줄이 바뀌었으면 적용하지 않는다
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
  const before = studio.getProject(),
    live = $("studioLive").checked;
  const header = "uniform float uGain; // @range 0 1 @default 0.5\n";
  const setCode = text => {
    const area = $("studioCode");
    area.value = text;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const run = async () => {
    $("studioRun").click();
    await wait(80);
  };
  const failed = () => !$("studioDiagnostics").hidden && $("studioDiagnostics").children.length > 0;
  const ctrlDot = () => {
    const content = document.querySelector(".studio-cm-host .cm-content");
    content.focus();
    content.dispatchEvent(new KeyboardEvent("keydown", { key: ".", code: "Period", ctrlKey: true, bubbles: true, cancelable: true }));
  };
  const cases = [
    ["float에 정수", "void mainImage(out vec4 c, in vec2 p) {\n  float x = uGain * 2;\n  c = vec4(x);\n}", "uGain * 2.0"],
    ["빠진 세미콜론", "void mainImage(out vec4 c, in vec2 p) {\n  vec2 uv = p / iResolution.xy\n  c = vec4(uv, uGain, 1.0);\n}", "iResolution.xy;"],
    ["오타 이름", "void mainImage(out vec4 c, in vec2 p) {\n  c = vec4(uGian);\n}", "vec4(uGain)"],
    ["오타 함수", "void mainImage(out vec4 c, in vec2 p) {\n  c = vec4(smothstep(0.0, 1.0, uGain));\n}", "smoothstep("],
    ["vec4 자리에 vec3", "void mainImage(out vec4 c, in vec2 p) {\n  c = vec3(uGain, 0.0, 0.0);\n}", "c = vec4(vec3(uGain, 0.0, 0.0), 1.0);"],
  ];
  try {
    test(studio.setProject({ image: header + "void mainImage(out vec4 c, in vec2 p) { c = vec4(uGain); }", passes: [], imageChannels: {} }), "검사 장면");
    studio.open();
    $("studioLive").checked = false;
    await wait(200);
    for (const [label, code, expected] of cases) {
      setCode(header + code);
      await run();
      await until(failed, `${label}: 컴파일 오류`);
      const row = $("studioDiagnostics").querySelector("button");
      test(row.querySelector(".studio-diagnostic-fix"), `${label}: 오류 줄에 빠른 수정 꼬리표`);
      test(/Ctrl\+\.로 빠른 수정/.test($("studioMessage").textContent), `${label}: 상태 줄 안내`);
      ctrlDot();
      await wait(50);
      test(studio.getProject().image.includes(expected), `${label}: Ctrl+.로 고침(${expected})`);
      await run();
      await until(() => !failed(), `${label}: 고친 뒤 실행하면 오류 없음`);
    }
    // 오류 말풍선의 고치기 버튼(CodeMirror lint actions) · 되돌리기 한 칸
    setCode(header + cases[0][1]);
    await run();
    await until(failed, "말풍선 검사: 오류");
    const errorLine = [...document.querySelectorAll(".studio-cm-host .cm-line")].find(node => node.textContent.includes("uGain * 2"));
    const marked = errorLine.querySelector(".cm-lintRange-error") || errorLine;
    const box = marked.getBoundingClientRect();
    marked.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: box.left + 4, clientY: box.top + box.height / 2 }));
    await until(() => document.querySelector(".cm-tooltip-lint .cm-diagnosticAction"), "오류 말풍선에 고치기 버튼", 3000);
    const action = document.querySelector(".cm-tooltip-lint .cm-diagnosticAction");
    test(/정수를 실수로/.test(action.textContent), `말풍선 버튼 이름: ${action.textContent}`);
    action.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    action.click();
    await wait(50);
    test(studio.getProject().image.includes("uGain * 2.0"), "말풍선 버튼으로 고침");
    studio.undo();
    await wait(50);
    test(studio.getProject().image.includes("uGain * 2;"), "수정 한 번은 되돌리기 한 칸");
    // 그사이 그 줄을 고쳤으면 적용하지 않는다(엉뚱한 줄을 고치지 않게)
    setCode(header + cases[0][1]);
    await run();
    await until(failed, "엇갈림 검사: 오류");
    const area = $("studioCode");
    setCode(area.value.replace("uGain * 2;", "uGain * 2 + 0.0;"));
    await wait(30);
    ctrlDot();
    await wait(50);
    test(studio.getProject().image.includes("uGain * 2 + 0.0;") && /적용하지 않았/.test($("studioMessage").textContent), "줄이 바뀌었으면 적용하지 않고 알린다");
  } finally {
    $("studioLive").checked = live;
    studio.setProject(before);
  }
  console.log("빠른 수정 검사 통과");
})();
