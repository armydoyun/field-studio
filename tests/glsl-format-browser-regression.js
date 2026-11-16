// 코드 정리(glsl-format.js)가 앱의 모든 GLSL에서 뜻을 바꾸지 않는다:
//  · 정리 전후의 토큰 목록(공백 제외)이 같다 — 붙으면 뜻이 바뀌는 a - -b → a--b 같은 것까지 잡는다
//  · 두 번 정리해도 같다(멱등) · 주석 · 어노테이션 · 전처리 줄은 그대로
//  · 원래 컴파일되던 예제 · 레슨 · 과정 셰이더는 정리 뒤에도 실제 WebGL 컴파일러를 통과한다
(async () => {
  const r = window.shaderPlayground;
  const test = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const F = await import("./js/glsl-format.js");
  const modules = await Promise.all(
    ["shader", "studio-examples", "course", "snippets", "feature-lessons", "technique-examples", "community-examples", "raymarch-lessons"].map(
      async name => [name, await import(`./js/${name}.js`)]
    )
  );
  // 내보낸 값 속의 GLSL 문자열(세미콜론과 줄바꿈이 있는 것)과 프로젝트({ image, passes })를 모두 모은다
  const sources = new Map(),
    projects = [];
  const seen = new Set();
  const walk = (value, where) => {
    if (typeof value === "string") {
      if (value.includes(";") && value.includes("\n") && !sources.has(value)) sources.set(value, where);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (typeof value.image === "string" && value.image.includes("main"))
      projects.push({ project: { passes: [], imageChannels: {}, ...value }, where });
    for (const [key, child] of Object.entries(value)) walk(child, `${where}.${key}`);
  };
  for (const [name, mod] of modules) {
    for (const [key, value] of Object.entries(mod)) {
      walk(typeof value === "function" && value.length === 0 && /Project$/.test(key) ? value() : value, `${name}.${key}`);
    }
  }
  test(sources.size > 100, `GLSL 문자열 ${sources.size}개 · 프로젝트 ${projects.length}개`);
  // 줄 끝 공백 지우기는 의도한 정리라, 주석 토큰의 끝 공백은 빼고 비교한다
  const tokens = text =>
    text
      .split(/\r?\n/)
      .flatMap(F.tokenize)
      .map(token => token.trimEnd());
  const changedTokens = [],
    notIdempotent = [];
  let changed = 0;
  for (const [source, where] of sources) {
    for (const indent of ["    ", "  "]) {
      const out = F.format(source, { indent });
      if (out !== source) changed++;
      if (JSON.stringify(tokens(out)) !== JSON.stringify(tokens(source))) changedTokens.push(where);
      if (F.format(out, { indent }) !== out) notIdempotent.push(where);
    }
    // 주석 줄(어노테이션 포함)은 글자 그대로 남는다
    const comments = (source.match(/\/\/[^\n]*/g) || []).map(comment => comment.trimEnd());
    const out = F.format(source);
    if (!comments.every(comment => out.includes(comment))) changedTokens.push(`${where} (주석)`);
  }
  test(!changedTokens.length, `토큰 · 주석 그대로${changedTokens.length ? ` — ${changedTokens.slice(0, 5).join(", ")}` : ""}`);
  test(!notIdempotent.length, `두 번 정리해도 같다${notIdempotent.length ? ` — ${notIdempotent.slice(0, 5).join(", ")}` : ""}`);
  test(changed > 0, `실제로 서식을 바꾼 경우가 있다(${changed})`);
  // 컴파일: 원래 통과하던 셰이더(Image · 버퍼 패스)는 정리 뒤에도 통과
  const broken = [];
  let compiled = 0;
  for (const { project, where } of projects) {
    const scene = { ...project, common: project.common ? F.format(project.common) : project.common };
    for (const [label, source, channels] of [
      ["Image", project.image, project.imageChannels],
      ...project.passes.map(pass => [pass.name, pass.fragment, pass.channels]),
    ]) {
      let before = true;
      try {
        r.validateFragment(source, project, channels || {});
      } catch (_) {
        before = false;
      }
      if (!before) continue;
      try {
        r.validateFragment(F.format(source), scene, channels || {});
        compiled++;
      } catch (error) {
        broken.push(`${where}/${label}: ${String(error.message).split("\n")[1] || error.message}`);
      }
    }
  }
  test(compiled > 40 && !broken.length, `정리 뒤에도 컴파일(${compiled}개)${broken.length ? ` — ${broken.slice(0, 3).join(" / ")}` : ""}`);
  // 편집기: ⋯ 메뉴 · Shift+Alt+F로 정리, 프로젝트에 반영, Ctrl+Z 한 번으로 원래대로
  const studio = window.shaderStudio,
    $ = id => document.getElementById(id),
    wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const before = studio.getProject(),
    messy = "void mainImage( out vec4 c,in vec2 p ){\nvec2 uv=p/iResolution.xy;\n  c=vec4(uv,0.0,1.0);\n}\n";
  try {
    test(studio.setProject({ image: messy, passes: [], imageChannels: {} }), "편집기 검사 장면");
    studio.open();
    await wait(300);
    $("studioTidy").click();
    await wait(50);
    const tidy = studio.getProject().image;
    test(tidy.includes("vec2 uv = p / iResolution.xy;") && tidy.includes("void mainImage(out vec4 c, in vec2 p) {"), "메뉴로 정리 · 프로젝트에 반영");
    test(/\n {2,4}c = vec4\(uv, 0\.0, 1\.0\);/.test(tidy), "들여쓰기");
    studio.undo();
    await wait(50);
    test(studio.getProject().image === messy, "Ctrl+Z 한 번으로 원래 코드");
    const content = document.querySelector(".studio-cm-host .cm-content");
    content.focus();
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "F", code: "KeyF", shiftKey: true, altKey: true, bubbles: true, cancelable: true }));
    await wait(50);
    test(studio.getProject().image === tidy, "Shift+Alt+F로 같은 결과");
    $("studioTidy").click();
    await wait(50);
    test(studio.getProject().image === tidy && /이미 정리된/.test($("studioMessage").textContent), "이미 정리된 코드는 그대로 · 알림");
  } finally {
    studio.setProject(before);
  }
  console.log(`코드 정리 검사 통과 · 문자열 ${sources.size} · 컴파일 ${compiled}`);
})();
