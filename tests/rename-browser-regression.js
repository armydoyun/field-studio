// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 이름 바꾸기(F2)가 실제 코드 편집기처럼 범위를 따르는지 본다.
//   1) 지역 변수: 그 함수 안의 그 변수만 · 다른 함수의 같은 이름 · 구조체 필드는 그대로
//   2) 겹치는 이름: 무엇이 바뀌는지 보여 주고 한 번 더 묻는다(취소하면 그대로)
//   3) Uniform: 다른 패스의 같은 Uniform과 파라미터 값까지 함께 바꾸고 Undo 한 번으로 되돌린다
//   4) 구조체 필드: 그 구조체의 필드만 · 거절: 벡터 성분(스위즐) · 앱 Uniform(uTime 등)
(async () => {
  const $ = id => document.getElementById(id), renderer = window.shaderPlayground, studio = window.shaderStudio;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (condition()) return true; return condition(); };
  const area = $("studioCode"), live = $("studioLive"), wasLive = live.checked;
  const before = studio.getProject();
  // 작업을 바꿀 때 뜨는 '저장하지 않은 변경' 확인에는 '저장하지 않고 계속'으로 답한다(이 검사는 보관함 저장을 다루지 않는다).
  setInterval(() => { const b = $("studioDialogAlt"); if ($("studioPromptDialog").open && $("studioDialogTitle").textContent === "저장하지 않은 변경") (b.hidden ? $("studioDialogOK") : b).click(); }, 10);
  const status = () => $("studioMessage").textContent;
  // 커서를 text의 n번째 등장 + offset에 두고 F2(메뉴의 이름 바꾸기)를 누른다.
  const renameAt = async (text, offset = 0, n = 0) => {
    let at = -1;
    for (let k = 0; k <= n; k++) at = area.value.indexOf(text, at + 1);
    if (at < 0) throw new Error(`없음: ${text}`);
    area.focus();
    area.setSelectionRange(at + offset, at + offset);
    area.dispatchEvent(new Event("select"));
    await wait(30);
    $("studioRename").click();
    await wait(30);
  };
  const setCodeAndApply = text => {
    area.value = text;
    area.dispatchEvent(new Event("input", { bubbles: true }));
    test(studio.apply(), "코드 적용");
  };
  const answer = async value => {
    test(await until(() => $("studioPromptDialog").open), "대화상자 열림");
    $("studioDialogInput").value = value;
    $("studioDialogForm").requestSubmit();
    await until(() => !$("studioPromptDialog").open);
  };
  try {
    studio.open();
    live.checked = false;
    // 1) 지역 변수
    const scene = `#version 300 es
precision highp float;
uniform vec2 uResolution;
out vec4 fragColor;
struct S { float x; };
float glow(float x) { return x * x; }
void main() {
    S value; value . x = 1.0;
    float x = value.x;
    { float x = 0.5; value.x += x; }
    fragColor = vec4(glow(x), x, 0.0, 1.0);
}`;
    test(studio.setProject({ image: scene, passes: [], imageChannels: {} }), "장면 적용");
    await renameAt("float x = value.x", 6);
    test(await until(() => $("studioPromptDialog").open), "F2 대화상자");
    const message = $("studioDialogMessage").textContent;
    test(/main 함수의 지역 변수/.test($("studioDialogTitle").textContent) && /3곳/.test(message), `무엇을 바꾸는지 보여 준다: ${$("studioDialogTitle").textContent} · ${message}`);
    await answer("level");
    test(await until(() => area.value.includes("float level = value.x")), "선언이 바뀐다");
    test(area.value.includes("vec4(glow(level), level,"), "같은 범위의 쓰임이 바뀐다");
    test(area.value.includes("float glow(float x) { return x * x; }"), "다른 함수의 같은 이름(매개변수 x)은 그대로");
    test(area.value.includes("{ float x = 0.5; value.x += x; }"), "안쪽 블록에서 가린 x는 그대로");
    test(area.value.includes("struct S { float x; };") && area.value.includes("value . x = 1.0"), "구조체 필드는 그대로");
    test(studio.undo() && area.value === scene, "Undo 한 번에 되돌아간다");

    // 2) 겹치는 이름: 같은 범위의 이름과 겹치면 한 번 더 묻는다
    await renameAt("float x = 0.5", 6);
    await answer("value");
    test(await until(() => $("studioPromptDialog").open && $("studioDialogTitle").textContent === "이름이 겹칩니다"), "겹치는 이름은 다시 묻는다");
    test(/가리키게 됩니다|같은 범위/.test($("studioDialogMessage").textContent), `겹침 설명: ${$("studioDialogMessage").textContent}`);
    $("studioDialogCancel").click();
    await wait(30);
    test(area.value === scene, "취소하면 그대로");

    // 4) 구조체 필드: 그 구조체의 필드 선언과 필드 참조만(같은 이름의 지역 변수 x는 그대로)
    await renameAt("value.x;", 6);
    test(await until(() => $("studioPromptDialog").open), "필드 F2 대화상자");
    test(/구조체 S의 필드/.test($("studioDialogTitle").textContent) && /4곳/.test($("studioDialogMessage").textContent), `필드 설명: ${$("studioDialogTitle").textContent} · ${$("studioDialogMessage").textContent}`);
    await answer("w");
    test(await until(() => area.value.includes("struct S { float w; };")), "필드 선언이 바뀐다");
    test(area.value.includes("value . w = 1.0;") && area.value.includes("float x = value.w;") && area.value.includes("value.w += x;"), "필드 참조('value . x' 포함)가 모두 바뀐다");
    test(area.value.includes("vec4(glow(x), x,") && area.value.includes("float glow(float x)"), "같은 이름의 변수·매개변수 x는 그대로");
    test(studio.undo() && area.value === scene, "Undo");
    // 거절: 벡터 성분(스위즐) · 앱 Uniform
    setCodeAndApply(scene.replace("fragColor = vec4(glow(x), x, 0.0, 1.0);", "vec3 c = vec3(x); fragColor = vec4(c.xyz, 1.0);"));
    await renameAt("c.xyz", 3);
    test(!$("studioPromptDialog").open && /스위즐/.test(status()), `벡터 성분은 거절: ${status()}`);
    await renameAt("uResolution", 2);
    test(!$("studioPromptDialog").open && /앱이 값을 넣는 Uniform/.test(status()), `앱 Uniform은 거절: ${status()}`);

    // 3) Uniform: 다른 패스 · 파라미터 값 · Undo
    const image = `#version 300 es
precision highp float;
uniform float uGain;
uniform sampler2D iChannel0;
uniform vec2 uResolution;
out vec4 fragColor;
void main() { fragColor = texture(iChannel0, gl_FragCoord.xy / uResolution) * uGain; }`;
    const buffer = `#version 300 es
precision highp float;
uniform float uGain;
out vec4 fragColor;
void main() { float uGainLocal = uGain; fragColor = vec4(uGainLocal); }`;
    test(studio.setProject({ image, passes: [{ name: "A", fragment: buffer, format: "rgba8", scale: 1, channels: {} }], imageChannels: { 0: { buffer: "A", frame: "current" } } }), "두 패스 장면");
    renderer.defineUniform("uGain", "float", 0.7, { min: 0, max: 2, step: 0.1 });
    const undoBase = studio.getProject();
    await renameAt("uGain;", 2);
    test(await until(() => $("studioPromptDialog").open), "Uniform F2 대화상자");
    test(/다른 패스의 같은 Uniform과 파라미터 값도/.test($("studioDialogMessage").textContent), "다른 패스·파라미터도 바뀐다고 알린다");
    await answer("uLevel");
    const project = studio.getProject();
    test(await until(() => /uLevel/.test(studio.getProject().image)), "Image 패스가 바뀐다");
    test(studio.getProject().image.includes("uniform float uLevel;") && studio.getProject().image.includes("* uLevel;"), "Image 패스: 선언과 쓰임");
    test(studio.getProject().passes[0].fragment.includes("uniform float uLevel;") && studio.getProject().passes[0].fragment.includes("= uLevel;"), "Buffer A의 같은 Uniform도 바뀐다");
    test(studio.getProject().passes[0].fragment.includes("uGainLocal"), "이름이 비슷한 다른 변수(uGainLocal)는 그대로");
    const users = renderer.getUserUniforms();
    test(users.some(u => u.name === "uLevel" && u.value === 0.7 && u.options.max === 2) && !users.some(u => u.name === "uGain"), `파라미터 값·범위 유지: ${JSON.stringify(users)}`);
    test(/다른 패스 1개/.test(status()) && /파라미터 값 유지/.test(status()), `결과 알림: ${status()}`);
    test(project && studio.undo(), "Undo");
    test(studio.getProject().image === undoBase.image && studio.getProject().passes[0].fragment === undoBase.passes[0].fragment, "Undo 한 번에 두 패스가 모두 돌아간다");
    test(renderer.getUserUniforms().some(u => u.name === "uGain" && u.value === 0.7) && !renderer.getUserUniforms().some(u => u.name === "uLevel"), "Undo로 파라미터 이름도 돌아간다");
  } finally {
    live.checked = wasLive;
    studio.setProject(before);
    for (const name of ["uGain", "uLevel"]) if (renderer.getUserUniforms().some(u => u.name === name)) renderer.removeUniform(name);
  }
})();
