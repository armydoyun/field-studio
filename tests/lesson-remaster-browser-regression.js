// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 기법 배우기 정리:
//  · 겹치던 예제(Keyboard Control · Mipmap Blur · Ray Marching SDF · Buffer Pipeline · Feedback Trails)는 갤러리에 없다
//  · 새 예제(Motion Links · Image Filters · Audio Spectrum)가 있고, 예제가 담은 연결 · 프리셋이 함께 들어온다
//  · 프리셋은 파라미터 타입 정보(schema)를 붙여 저장되고, Undo하면 이전 작업의 연결 · 프리셋이 돌아온다
//  · MRT는 두 출력(색 · 거리장)을 실제로 쓰고, Reaction–Diffusion은 패턴 프리셋을 갖는다
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
  const answer = setInterval(() => {
    const dialog = $("studioPromptDialog"),
      alt = $("studioDialogAlt");
    if (dialog?.open) (alt && !alt.hidden ? alt : $("studioDialogOK")).click();
  }, 25);
  const open = async id => {
    $("galleryToggle").click();
    await wait(30);
    const card = document.querySelector(`#galleryLessons .gallery-card[data-id="${id}"]`);
    if (!card) throw new Error(`카드 없음: ${id}`);
    card.click();
    await wait(200);
  };
  const before = studio.getProject(),
    users = r.getUserUniforms(),
    links = settings.getLinks(),
    presets = settings.getPresets();
  try {
    const ids = [...document.querySelectorAll("#galleryLessons .gallery-card")].map(node => node.dataset.id);
    for (const gone of ["keyboard", "mipblur", "raymarch", "pipeline", "feedback"])
      check(!ids.includes(gone), `겹치던 예제 제거: ${gone}`);
    for (const added of ["motion", "image-filters", "audio"]) check(ids.includes(added), `새 예제: ${added}`);

    // 이전 작업의 연결 · 프리셋 → 예제를 열면 예제 것으로 → Undo로 돌아온다
    check(studio.setProject({ image: "uniform float uOld; // @range 0 1 @default 0.5\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(uOld); }", passes: [], imageChannels: {} }), "이전 작업");
    await wait(50);
    settings.setLinks([{ name: "uOld", source: "lfo", min: 0, max: 1, smooth: 0, shape: "sine", period: 2, phase: 0 }]);
    settings.setPresets([{ name: "이전", values: { uOld: 0.2 } }]);
    await open("motion");
    const motion = settings.getLinks();
    check(
      motion.map(link => `${link.name}:${link.source}`).join() === "uBounce:keys,uSquash:keys,uSwing:lfo",
      "Motion Links: 키프레임 둘 · 흔들기 하나 연결"
    );
    check(motion[0].loop === 1 && motion[0].wrap && motion[0].keys[0][2] === "out", "키프레임: 1초 반복 · 처음으로 잇기 · 키마다 잇기");
    const motionPresets = settings.getPresets();
    check(motionPresets.map(p => p.name).join() === "저녁,한낮,네온", "Motion Links: 색 프리셋 3개");
    check(motionPresets.every(p => p.schema?.uSky?.type === "vec3" && Array.isArray(p.values.uBall)), "예제 프리셋은 타입 정보(schema)와 함께 저장");
    $("timelineToggle").click();
    await wait(50);
    check(document.querySelectorAll("#timelineDock .timeline-lane").length === 2, "타임라인에 키프레임 레인 2개");
    $("timelineToggle").click();
    studio.undo();
    await wait(50);
    check(settings.getLinks()[0]?.name === "uOld" && settings.getPresets()[0]?.name === "이전", "Undo하면 이전 작업의 연결 · 프리셋 복원");

    await open("audio");
    check(studio.getProject().imageChannels[0]?.media === "mic", "Audio Spectrum: iChannel0 = 마이크");
    check(settings.getLinks()[0]?.source === "audio" && settings.getLinks()[0].band === "bass", "Audio Spectrum: 저음 소리 연결");

    await open("image-filters");
    check(r.getUserUniforms().find(item => item.name === "uFilter")?.options?.enum?.length === 7, "Image Filters: 필터 7가지");
    check(!settings.getLinks().length && !settings.getPresets().length, "연결 · 프리셋이 없는 예제는 비운 채 시작");

    await open("reaction");
    check(settings.getPresets().map(p => p.name).join() === "산호,세포 분열,지렁이,구멍", "Reaction–Diffusion: 패턴 프리셋");
    check(settings.getPresets()[0].values.uFeed === 0.0545 && settings.getPresets()[0].values.uKill === 0.062, "프리셋 값");

    await open("mrt");
    const project = studio.getProject();
    check(project.passes[0].outputs === 2 && project.imageChannels[1]?.attachment === 1, "MRT: 출력 2개 · Image가 A[1]을 읽음");
    check(["uView", "uGlow", "uOutline", "uShadow", "uBlobs", "uBlend"].every(name => r.getUserUniforms().some(item => item.name === name)), "MRT: 보기 · 거리장 꾸미기 파라미터");
  } finally {
    clearInterval(answer);
    if ($("gallery").open) $("galleryClose").click();
    settings.setLinks([]);
    studio.setProject(before);
    r.setUserUniforms(users);
    settings.setPresets(presets);
    settings.setLinks(links);
  }
})();
