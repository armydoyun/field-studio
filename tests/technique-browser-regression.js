// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// "기법 배우기"의 PBR · 볼류메트릭 구름 · 2D 유체: 갤러리에서 열면 오류 없이 돌고, 파라미터가 어노테이션대로 등록되고,
// 유체는 수백 프레임 뒤에도 값이 터지지 않는다(NaN·무한·속도 상한 넘음 없음). 물감이 실제로 퍼진다.
(async () => {
  // 작업을 바꿀 때 뜨는 '저장하지 않은 변경' 확인에는 '저장하지 않고 계속'으로 답한다(이 검사는 보관함 저장을 다루지 않는다).
  setInterval(() => { const d = document.getElementById("studioPromptDialog"), b = document.getElementById("studioDialogAlt"); if (d?.open && document.getElementById("studioDialogTitle").textContent === "저장하지 않은 변경") (b.hidden ? document.getElementById("studioDialogOK") : b).click(); }, 10);
  const $ = id => document.getElementById(id), renderer = window.shaderPlayground, studio = window.shaderStudio;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (condition()) return true; return condition(); };
  const before = studio.getProject(), scaleBefore = renderer.getStats().resolutionScale;
  const open = async id => {
    $("galleryToggle").click();
    await wait(50);
    document.querySelector(`.gallery-card[data-id="${id}"]`).click();
    await wait(300);
    document.querySelector("dialog[open] button.primary")?.click();   // 저장 안 한 작업이 있으면 바꾸기 확인
    await until(() => !$("gallery").open, 5000);
  };
  const params = () => Object.fromEntries(renderer.getUserUniforms().map(u => [u.name, u]));
  const errorShown = () => !$("uiError").hidden && $("uiError").textContent.trim();
  try {
    if (!renderer.getStats().running) $("previewPause").click();
    renderer.setResolutionScale(0.25);   // CI(소프트웨어 렌더링)에서도 빨리 돌게 작게 그린다
    // ---- PBR ----
    await open("pbr");
    let p = params();
    test(p.uBaseColor?.options.color && p.uRoughness?.options.max === 1 && p.uGrid?.value === true && p.uView?.options.max === 5, "PBR: 파라미터(색 · 거칠기 · 격자 · 보기)");
    let frame = renderer.getStats().frame;
    test(await until(() => renderer.getStats().frame > frame + 3, 20_000) && !errorShown(), "PBR: 오류 없이 그린다");
    // ---- 볼류메트릭 구름 ----
    await open("volumetric");
    p = params();
    test(p.uSunCol?.options.color && p.uSkyCol?.options.color && p.uSteps?.type === "int" && p.uSteps.value === 48, "구름: 파라미터(햇빛 · 하늘빛 · 걸음 수)");
    renderer.setUniform("uSteps", 12);   // 소프트웨어 렌더링에서도 빨리 돌게
    frame = renderer.getStats().frame;
    test(await until(() => renderer.getStats().frame > frame + 2, 60_000) && !errorShown(), "구름: 오류 없이 그린다");
    // ---- 2D 유체 ----
    await open("fluid");
    const passes = renderer.getPasses().map(pass => pass.name).join("");
    test(passes === "ABCDEF", `유체: 버퍼 6개 A~F (${passes})`);
    p = params();
    test(["uForce", "uDissipation", "uDyeFade", "uView"].every(name => p[name]), "유체: 파라미터(힘 · 속도 유지 · 물감 유지 · 보기)");
    test(await until(() => renderer.getStats().frame > 150, 120_000), `유체: 150프레임 진행 (${renderer.getStats().frame})`);
    test(!errorShown(), "유체: 오류 없이 돈다");
    // 버퍼 크기 = 화면의 0.5배. 격자 몇 곳을 읽어 값이 정상인지 본다.
    const { width, height } = renderer.getStats(), w = Math.floor(width / 2), h = Math.floor(height / 2);
    const samples = [];
    for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) samples.push([Math.floor((w * x) / 8), Math.floor((h * y) / 8)]);
    const velocity = samples.map(([x, y]) => renderer.readPassPixel("A", x, y)), dye = samples.map(([x, y]) => renderer.readPassPixel("F", x, y));
    const values = [...velocity, ...dye].flatMap(pixel => [...pixel].slice(0, 3));
    test(values.every(Number.isFinite), "유체: NaN·무한대가 없다");
    test(velocity.every(v => Math.hypot(v[0], v[1]) <= 6.01), `유체: 속도가 상한(6칸/프레임) 안 (최대 ${Math.max(...velocity.map(v => Math.hypot(v[0], v[1]))).toFixed(2)})`);
    test(velocity.some(v => Math.hypot(v[0], v[1]) > 0.01), "유체: 물이 실제로 움직인다");
    test(dye.filter(d => d[0] + d[1] + d[2] > 0.05).length >= 3, `유체: 물감이 퍼졌다 (${dye.filter(d => d[0] + d[1] + d[2] > 0.05).length}/${dye.length}곳)`);
  } finally {
    if ($("gallery").open) $("galleryClose").click();
    studio.setProject(before);
    renderer.setResolutionScale(scaleBefore);
  }
  console.log("기법 배우기(PBR · 구름 · 유체) 회귀 테스트 완료");
})();
