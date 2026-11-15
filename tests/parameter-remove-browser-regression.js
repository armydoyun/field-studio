// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 코드가 uniform 선언 없이 쓰는 파라미터를 지울 때(앱이 선언을 대신 넣어 왔다):
//  · 컴파일 오류 원문을 띄우지 않고, 이유를 알리며 '선언 남기고 삭제'를 묻는다
//  · 취소하면 그대로 · 확인하면 코드에 uniform 선언을 넣고 지워 셰이더가 계속 컴파일된다(Common도 쓰면 Common 한 곳에만)
//  · 코드가 선언해 둔 파라미터 · 쓰지 않는 파라미터는 묻지 않고 바로 지운다
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    $ = id => document.getElementById(id);
  const check = (ok, label) => {
    if (!ok) throw new Error(label);
    console.log(`PASS ${label}`);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn, label, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (fn()) return;
    throw new Error(`시간 초과: ${label}`);
  };
  const row = name => document.querySelector(`.uniform-row[data-name="${name}"]`);
  const refresh = () => $("uniformSearch").dispatchEvent(new Event("input", { bubbles: true }));
  const names = () => r.getUserUniforms().map(item => item.name);
  const before = studio.getProject(),
    users = r.getUserUniforms(),
    panelHidden = document.body.classList.contains("panel-hidden");
  const image =
    "#version 300 es\nprecision highp float;\nuniform vec2 uResolution;\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  fragColor = vec4(vec3(uA), 1.0) + vec4(uDeclared, 0.0, 0.0, 0.0);\n}\n";
  try {
    if (panelHidden) $("panelToggle").click();
    // 파라미터를 먼저 등록하고, 코드는 uA를 선언 없이 쓴다(uDeclared는 코드에 선언, uUnused는 쓰지 않는다 — 아래에서 따로)
    check(studio.setProject({ image: "void mainImage(out vec4 c, in vec2 p) { c = vec4(0.0); }", passes: [], imageChannels: {} }), "빈 장면");
    r.defineUniform("uA", "float", 0.5);
    r.defineUniform("uDeclared", "float", 0.2);
    r.defineUniform("uUnused", "float", 0.1);
    check(studio.setProject({ image: image.replace("uniform vec2 uResolution;", "uniform vec2 uResolution;\nuniform float uDeclared;"), passes: [], imageChannels: {} }), "uA를 선언 없이 쓰는 코드가 컴파일됨(파라미터가 선언을 대신함)");
    $("tab-uniforms").click();
    refresh();
    await wait(30);
    check(JSON.stringify(studio.implicitParameterUses("uA")) === '["Image"]' && !studio.implicitParameterUses("uDeclared").length, "선언 없이 쓰는 탭을 찾음");

    // 취소: 그대로
    row("uA").querySelector(".remove-uniform").click();
    await until(() => $("studioPromptDialog").open, "확인 창");
    check(/선언 없이/.test($("studioDialogMessage").textContent) && /uniform float uA;/.test($("studioDialogMessage").textContent), "이유와 넣을 선언을 알림");
    $("studioDialogCancel").click();
    await wait(30);
    check(names().includes("uA") && !$("uiError").textContent, "취소하면 지우지 않고 오류도 없음");

    // 확인: 선언을 넣고 지운다
    row("uA").querySelector(".remove-uniform").click();
    await until(() => $("studioPromptDialog").open, "확인 창");
    $("studioDialogOK").click();
    await until(() => !names().includes("uA"), "uA 삭제");
    check(/uniform float uA;/.test(studio.getProject().image), "코드에 uniform 선언을 남김");
    check(!$("uiError").textContent && !/컴파일 실패/.test($("toastMessage").textContent), "컴파일 오류 없이 삭제");
    check(r.getFragmentSource().includes("uniform float uA;"), "셰이더가 선언과 함께 실행됨");

    // 코드가 선언한 파라미터 · 쓰지 않는 파라미터는 묻지 않고 지운다
    row("uUnused").querySelector(".remove-uniform").click();
    await wait(30);
    check(!$("studioPromptDialog").open && !names().includes("uUnused"), "쓰지 않는 파라미터는 바로 삭제");

    // Common도 쓰면 Common 한 곳에만 선언
    r.defineUniform("uB", "float", 0.3);
    check(
      studio.setProject({
        image: "void mainImage(out vec4 c, in vec2 p) { c = vec4(shade() + uB); }",
        common: "float shade() { return uB; }",
        passes: [],
        imageChannels: {},
      }),
      "Common과 Image가 uB를 선언 없이 쓰는 장면"
    );
    refresh();
    await wait(30);
    check(studio.implicitParameterUses("uB").includes("Common"), "Common의 선언 없는 사용");
    row("uB").querySelector(".remove-uniform").click();
    await until(() => $("studioPromptDialog").open, "확인 창");
    $("studioDialogOK").click();
    await until(() => !names().includes("uB"), "uB 삭제");
    const project = studio.getProject();
    check(/uniform float uB;/.test(project.common) && !/uniform float uB;/.test(project.image), "Common 한 곳에만 선언(겹치지 않음)");
    check(!$("uiError").textContent, "Common 장면도 컴파일 오류 없이 삭제");
  } finally {
    if ($("studioPromptDialog").open) $("studioDialogCancel").click();
    studio.setProject(before);
    r.setUserUniforms(users);
    if (panelHidden !== document.body.classList.contains("panel-hidden")) $("panelToggle").click();
  }
})();
