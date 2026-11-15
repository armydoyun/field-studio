// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 코드가 uniform 선언 없이 쓰는 파라미터를 지울 때(파라미터가 선언을 대신해 왔다):
//  · 묻지 않고 지우고, 다시 컴파일한 오류는 편집기의 오류 표시(줄 · 상태 · 뷰포트 안내)로 보여 준다 — 오류 원문 토스트 없음
//  · 화면은 마지막 성공 결과를 그린다 · 코드가 같아도 '실행'은 다시 컴파일해 오류가 남는다(오류가 거짓으로 사라지지 않음)
//  · 코드에서 그 이름을 지우면 풀리고, '삭제 되돌리기'를 누르면 파라미터와 함께 오류 표시도 거둔다
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    $ = id => document.getElementById(id);
  const check = (ok, label) => {
    if (!ok) throw new Error(label);
    console.log(`PASS ${label}`);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const row = name => document.querySelector(`.uniform-row[data-name="${name}"]`);
  const refresh = () => $("uniformSearch").dispatchEvent(new Event("input", { bubbles: true }));
  const names = () => r.getUserUniforms().map(item => item.name);
  const failed = () => $("studioState").dataset.state === "error";
  const before = studio.getProject(),
    users = r.getUserUniforms(),
    live = $("studioLive").checked,
    panelHidden = document.body.classList.contains("panel-hidden");
  const image = "void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  fragColor = vec4(vec3(uA), 1.0);\n}\n";
  try {
    if (panelHidden) $("panelToggle").click();
    $("studioLive").checked = false;
    check(studio.setProject({ image: "void mainImage(out vec4 c, in vec2 p) { c = vec4(0.0); }", passes: [], imageChannels: {} }), "빈 장면");
    r.defineUniform("uA", "float", 0.5);
    r.defineUniform("uUnused", "float", 0.1);
    check(studio.setProject({ image, passes: [], imageChannels: {} }) && !failed(), "uA를 선언 없이 쓰는 코드가 컴파일됨(파라미터가 선언을 대신함)");
    $("tab-uniforms").click();
    refresh();
    await wait(30);

    // 묻지 않고 지우고, 오류는 편집기 표시로
    row("uA").querySelector(".remove-uniform").click();
    await wait(50);
    check(!$("studioPromptDialog").open && !names().includes("uA"), "묻지 않고 지움");
    check(!$("uiError").textContent && $("uiToast").hidden, "컴파일 오류 원문을 토스트로 띄우지 않음");
    check(failed() && /uA/.test($("studioError").textContent), "편집기 상태가 컴파일 오류 · uA undeclared");
    check(!$("previewNotice").hidden && /마지막 성공/.test($("previewNotice").textContent), "뷰포트에 '화면은 마지막 성공 결과' 안내");
    check(/컴파일 오류/.test($("uniformNotice").textContent) && !$("undoUniform").hidden, "삭제 알림에 이유와 되돌리기");
    // 코드가 같아도 실행하면 다시 컴파일해 오류가 남는다
    check(!studio.apply() && failed(), "같은 코드로 실행해도 오류가 남음");

    // 삭제 되돌리기: 파라미터와 함께 오류 표시도 거둔다
    $("undoUniform").click();
    await wait(30);
    check(names().includes("uA") && !failed() && $("previewNotice").hidden, "삭제 되돌리기로 파라미터 · 정상 상태 복원");

    // 다시 지우고, 코드에서 uA를 지우면 풀린다
    row("uA").querySelector(".remove-uniform").click();
    await wait(30);
    check(failed(), "다시 지우면 오류");
    const project = studio.getProject();
    check(studio.setProject({ ...project, image: image.replace("vec3(uA)", "vec3(0.5)") }) && !failed(), "코드에서 uA를 지우면 컴파일 성공");

    // 코드가 쓰지 않는 파라미터는 오류 없이 지운다
    row("uUnused").querySelector(".remove-uniform").click();
    await wait(30);
    check(!names().includes("uUnused") && !failed() && /uUnused 삭제됨$/.test($("uniformNotice").textContent), "쓰지 않는 파라미터는 그냥 삭제");
  } finally {
    $("studioLive").checked = live;
    studio.setProject(before);
    r.setUserUniforms(users);
    if (panelHidden !== document.body.classList.contains("panel-hidden")) $("panelToggle").click();
  }
})();
