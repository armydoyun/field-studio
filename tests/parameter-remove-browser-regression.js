// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 파라미터 선언은 코드가 가진다(앱이 셰이더에 선언을 대신 넣지 않는다):
//  · '파라미터 추가'는 선언 줄(어노테이션 포함)을 코드에 직접 써 넣는다 · 등록만 하고 코드가 선언하지 않은 이름은 컴파일 오류
//  · 파라미터 삭제는 코드의 선언도 지운다(다음 컴파일에서 다시 등록되지 않게). 코드가 아직 쓰면 오류는 편집기에 보이고,
//    '삭제 되돌리기'는 코드 · 파라미터를 함께 되돌린다
//  · 자동 선언 시절에 저장한 Pack(선언 없이 파라미터를 씀)을 열면 빠진 선언을 코드에 한 번 넣는다
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    settings = window.shaderSettings,
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
  const answer = setInterval(() => {
    if ($("studioPromptDialog")?.open) ($("studioDialogAlt").hidden ? $("studioDialogOK") : $("studioDialogAlt")).click();
  }, 25);
  const before = studio.getProject(),
    users = r.getUserUniforms(),
    live = $("studioLive").checked,
    panelHidden = document.body.classList.contains("panel-hidden");
  const base = "void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  fragColor = vec4(0.2);\n}\n";
  try {
    if (panelHidden) $("panelToggle").click();
    $("studioLive").checked = false;
    check(studio.setProject({ image: base, passes: [], imageChannels: {} }), "빈 장면");
    $("tab-uniforms").click();

    // 등록만 하고 코드가 선언하지 않은 이름은 쓸 수 없다(앱이 선언을 대신 넣지 않음)
    r.defineUniform("uLoose", "float", 0.5);
    check(!studio.setProject({ image: base.replace("vec4(0.2)", "vec4(uLoose)"), passes: [], imageChannels: {} }), "등록만 한 파라미터를 선언 없이 쓰면 컴파일 오류");
    r.removeUniform("uLoose");
    check(studio.setProject({ image: base, passes: [], imageChannels: {} }), "빈 장면 다시");

    // 파라미터 추가: 선언 줄을 코드에 써 넣는다
    $("uniformEditor").open = true;
    $("uniformName").value = "uGain";
    $("uniformType").value = "float";
    $("uniformType").dispatchEvent(new Event("change", { bubbles: true }));
    $("uniformValue").value = "0.4";
    $("uniformMin").value = "0";
    $("uniformMax").value = "1";
    $("uniformStep").value = "0.01";
    $("uniformForm").requestSubmit();
    await wait(50);
    check(/uniform float uGain; \/\/ @range 0 1 0\.01 @default 0\.4/.test(studio.getProject().image), "파라미터 추가가 코드에 선언 줄을 씀");
    check(names().includes("uGain") && !failed(), "등록되고 컴파일 성공");
    // 코드에서 쓰기
    const declared = studio.getProject();
    check(studio.setProject({ ...declared, image: declared.image.replace("vec4(0.2)", "vec4(uGain)") }) && !failed(), "선언한 파라미터를 코드에서 씀");
    refresh();
    await wait(30);

    // 삭제: 선언도 지우고, 코드가 아직 쓰므로 오류는 편집기에
    row("uGain").querySelector(".remove-uniform").click();
    await wait(50);
    check(!names().includes("uGain") && !/uniform float uGain/.test(studio.getProject().image), "삭제하면 코드의 선언도 지움");
    check(failed() && /uGain/.test($("studioError").textContent) && !$("uiError").textContent, "코드가 아직 쓰면 오류는 편집기에(토스트 없음)");
    check(/컴파일 오류/.test($("uniformNotice").textContent) && !$("undoUniform").hidden, "삭제 알림에 이유와 되돌리기");
    // 삭제 되돌리기: 코드 · 파라미터를 함께
    $("undoUniform").click();
    await wait(50);
    check(names().includes("uGain") && /uniform float uGain;/.test(studio.getProject().image) && !failed(), "삭제 되돌리기로 선언 · 파라미터 복원");
    // 쓰지 않는 파라미터는 선언과 함께 깔끔하게 지워진다(다음 컴파일에서 다시 등록되지 않음)
    const used = studio.getProject();
    check(studio.setProject({ ...used, image: used.image.replace("vec4(uGain)", "vec4(0.2)") }), "코드에서 uGain 사용을 지움");
    refresh();
    await wait(30);
    row("uGain").querySelector(".remove-uniform").click();
    await wait(50);
    check(!names().includes("uGain") && !failed() && /코드의 선언도 지웠습니다/.test($("uniformNotice").textContent), "쓰지 않는 파라미터는 선언과 함께 삭제");
    const after = studio.getProject();
    check(studio.setProject({ ...after, image: after.image + "\n// 편집\n" }) && !names().includes("uGain"), "다음 컴파일에서 다시 등록되지 않음");

    // 자동 선언 시절의 Pack: 선언 없이 파라미터를 쓰면, 열 때 선언을 코드에 넣는다
    r.defineUniform("uOld", "float", 0.7);
    const state = settings.snapshot();
    r.removeUniform("uOld");
    const pack = JSON.stringify({
      version: 3,
      project: { image: base.replace("vec4(0.2)", "vec4(uOld)"), passes: [], imageChannels: {} },
      selected: "Image",
      textures: [],
      settings: state,
    });
    await studio.importPack(new File([pack], "old-pack.json", { type: "application/json" }));
    await wait(80);
    check(/uniform float uOld;/.test(studio.getProject().image) && names().includes("uOld") && !failed(), "예전 Pack을 열면 빠진 선언을 코드에 넣고 실행");
  } finally {
    clearInterval(answer);
    $("studioLive").checked = live;
    $("uniformEditor").open = false;
    studio.setProject(before);
    r.setUserUniforms(users);
    if (panelHidden !== document.body.classList.contains("panel-hidden")) $("panelToggle").click();
  }
})();
