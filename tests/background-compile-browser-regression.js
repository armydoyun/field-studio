// 뒤에서 컴파일하기(KHR_parallel_shader_compile): 무거운 셰이더도 화면이 멈추지 않게, 자동 적용 · 파라미터 추가/삭제는
// GPU가 컴파일을 끝냈다고 알린 뒤에 적용한다. 이 환경(SwiftShader)에는 확장이 없으므로 가짜 확장을 꽂아
// "끝났다"를 테스트가 정한다. 렌더러는 컨텍스트를 복구할 때 확장을 다시 묻는다 — 그 길로 가짜를 넘긴다.
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
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
  const gl = $("screen").getContext("webgl2"),
    lose = gl.getExtension("WEBGL_lose_context");
  if (!lose) return console.log("SKIP: WEBGL_lose_context 없음");
  const COMPLETION = 0x91b1;
  let ready = false,
    completionQueries = 0;
  const realExtension = gl.getExtension,
    realProgramParameter = gl.getProgramParameter;
  const once = (node, type) => new Promise(resolve => node.addEventListener(type, resolve, { once: true }));
  const cycle = async () => {
    const lostEvent = once($("screen"), "webglcontextlost");
    lose.loseContext();
    await lostEvent;
    await wait(50); // 손실 이벤트가 끝나기 전에 복구하면 INVALID_OPERATION
    const restored = once($("screen"), "webglcontextrestored");
    lose.restoreContext();
    await restored;
    await wait(200);
  };
  const before = studio.getProject(),
    live = $("studioLive").checked;
  const image = source => ({
    image: `uniform float uGain; // 밝기 · @range 0 1 @default 0.5\nuniform float uKeep; // @range 0 1 @default 0.2\n${source}`,
    passes: [],
    imageChannels: {},
  });
  try {
    gl.getExtension = function (name) {
      return name === "KHR_parallel_shader_compile"
        ? { COMPLETION_STATUS_KHR: COMPLETION }
        : realExtension.call(this, name);
    };
    gl.getProgramParameter = function (program, pname) {
      if (pname !== COMPLETION) return realProgramParameter.call(this, program, pname);
      completionQueries++;
      return ready;
    };
    await cycle();
    ready = true;
    test(
      studio.setProject(image("void mainImage(out vec4 c, in vec2 p) { c = vec4(uGain + uKeep); }")),
      "검사 장면(바로 적용하는 길은 그대로)"
    );
    await until(() => r.getUserUniforms().length === 2, "파라미터 등록");
    studio.open();
    await until(() => !$("studioDock").hidden, "편집기 열림");
    $("studioLive").checked = true;

    // 1) 자동 적용: GPU가 끝내기 전에는 적용하지 않고 '컴파일 중'을 보인다. 그사이 화면은 이전 결과.
    ready = false;
    const applied = r.getFragmentSource(),
      edit = text => {
        const area = $("studioCode");
        area.value = area.value.replace(/c = vec4\([^;]*\);/, text);
        area.dispatchEvent(new Event("input", { bubbles: true }));
      };
    edit("c = vec4(uGain * 0.5 + uKeep);");
    await until(() => $("studioMessage").textContent.includes("컴파일 중"), "컴파일 중 표시", 3000);
    await wait(150);
    test(r.getFragmentSource() === applied, "끝나기 전에는 이전 프로그램 유지");
    test(completionQueries > 0, "끝났는지 멈추지 않고 묻는다");
    // 기다리는 동안 또 고치면 앞의 것은 버리고 마지막 코드만 적용한다
    edit("c = vec4(uGain * 0.25 + uKeep);");
    await until(() => $("studioMessage").textContent.includes("컴파일 중"), "다시 컴파일 중", 3000);
    ready = true;
    await until(() => r.getFragmentSource().includes("uGain * 0.25"), "끝나면 적용");
    test(!$("studioMessage").textContent.includes("컴파일 중"), "적용 뒤 상태 줄 갱신");
    test(studio.getProject().image.includes("uGain * 0.25"), "마지막 수정이 남는다");

    // 2) 파라미터 삭제: 선언을 지운 코드는 GPU가 끝낸 뒤 적용하고, 알림도 그때 결과로 바뀐다
    $("tab-uniforms").click();
    $("uniformSearch").value = "";
    $("uniformSearch").dispatchEvent(new Event("input", { bubbles: true }));
    ready = false;
    edit("c = vec4(uGain);"); // uKeep을 코드가 더 이상 쓰지 않게(자동 적용을 기다리지 않고 아래 삭제가 적용한다)
    await wait(50);
    document.querySelector('.uniform-row[data-name="uKeep"] .remove-uniform').click();
    test($("uniformNotice").textContent.includes("적용 중"), "삭제: 컴파일을 기다리는 동안 '적용 중'");
    test(!studio.getProject().image.includes("uniform float uKeep"), "삭제: 선언은 바로 코드에서 지움");
    ready = true;
    await until(() => $("uniformNotice").textContent.includes("선언도 지웠습니다"), "삭제: 끝나면 결과 알림");
    test(!r.getFragmentSource().includes("uKeep"), "삭제: 지운 코드가 적용됨");

    // 3) 파라미터 추가: 선언을 넣은 코드도 같은 길로 적용한다
    ready = false;
    $("uniformEditor").open = true;
    $("uniformName").value = "uExtra";
    $("uniformType").value = "float";
    $("uniformType").dispatchEvent(new Event("change", { bubbles: true }));
    $("uniformValue").value = "0.3";
    $("uniformForm").requestSubmit();
    test(studio.getProject().image.includes("uniform float uExtra"), "추가: 선언을 코드에 넣음");
    await wait(100);
    test(!r.getFragmentSource().includes("uExtra"), "추가: 끝나기 전에는 이전 프로그램");
    ready = true;
    await until(() => r.getFragmentSource().includes("uniform float uExtra"), "추가: 끝나면 적용");
    test(r.getUserUniforms().some(u => u.name === "uExtra"), "추가: 파라미터 등록 유지");
  } finally {
    gl.getExtension = realExtension;
    gl.getProgramParameter = realProgramParameter;
    $("studioLive").checked = live;
    await cycle();
    studio.setProject(before);
  }
  console.log("뒤에서 컴파일하기 검사 통과");
})();
