// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 갤러리 성능 배지: 갤러리를 열면 예제마다 성능을 재 배지를 채운다. 재는 동안 메인 미리보기를 멈췄다가 끝나면 다시 켠다.
// 닫으면 측정을 멈추고(미리보기는 바로 다시 켠다), 다시 열면 이어서 잰다.
(async () => {
  const $ = id => document.getElementById(id), renderer = window.shaderPlayground, dialog = $("gallery");
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const badges = () => [...document.querySelectorAll(".gallery-card .gallery-perf")];
  const pending = () => badges().filter(badge => badge.dataset.level === "pending").length;
  const LEVELS = new Set(["light", "medium", "heavy", "extreme"]);
  const wasRunning = renderer.getStats().running;
  try {
    test(badges().length >= 28 && badges().length === document.querySelectorAll(".gallery-card").length, `카드마다 성능 배지 (${badges().length})`);
    test(pending() === badges().length, "열기 전에는 모두 '측정 중'");
    test(!!$("galleryCommunity").closest(".gallery-body")?.querySelector(".gallery-perf-legend"), "배지 단계 설명이 갤러리에 있다");
    if (!wasRunning) $("previewPause").click();
    $("galleryToggle").click();
    test(dialog.open, "갤러리 열림");
    // 재기 시작하면 메인 미리보기를 멈춘다.
    let sawPaused = false;
    for (let i = 0; i < 100 && !sawPaused; i++) { await wait(50); sawPaused = !renderer.getStats().running; }
    test(sawPaused, "재는 동안 메인 미리보기를 멈춘다");
    // 중간에 닫으면 측정이 멈추고 미리보기가 다시 돈다.
    for (let i = 0; i < 400 && pending() === badges().length; i++) await wait(50);
    const before = pending();
    test(before < badges().length, `측정이 진행된다 (남은 ${before}개)`);
    $("galleryClose").click();
    await wait(200);
    test(!dialog.open && renderer.getStats().running, "닫으면 미리보기가 다시 돈다");
    const paused = pending();
    await wait(800);
    test(pending() === paused, "닫혀 있는 동안은 재지 않는다");
    // 다시 열면 이어서 끝까지 잰다(소프트웨어 렌더링 + 동시 실행이라 넉넉히 기다린다).
    $("galleryToggle").click();
    for (let i = 0; i < 2400 && pending(); i++) await wait(50);
    test(pending() === 0, `다시 열면 이어서 모두 잰다 (남은 ${pending()}개)`);
    const states = badges().map(badge => ({ id: badge.closest(".gallery-card").dataset.id, level: badge.dataset.level, label: badge.textContent, title: badge.title }));
    const failed = states.filter(state => !LEVELS.has(state.level)).map(state => `${state.id}:${state.level}`);
    test(!failed.length, `모든 예제를 재는 데 성공 ${failed.join(", ")}`);
    test(states.every(state => /1920×1080 한 프레임 약 [\d.]+ms/.test(state.title) && state.label.length > 0), "배지 툴팁에 1080p 한 프레임 어림값");
    await wait(300);
    test(renderer.getStats().running, "다 재면 미리보기를 다시 켠다");
    // 아주 가벼운 예제가 아주 무거운 예제보다 무겁게 나오지 않는다(측정이 뒤섞이지 않았는지).
    const ms = id => Number(/약 ([\d.]+)ms/.exec(states.find(state => state.id === id).title)[1]);
    test(ms("annotations") < ms("terrain") && ms("hexplasma") < ms("skyline"), `가벼운 예제 < 무거운 예제 (${ms("annotations")} < ${ms("terrain")}, ${ms("hexplasma")} < ${ms("skyline")})`);
  } finally {
    if (dialog.open) $("galleryClose").click();
    if (renderer.getStats().running !== wasRunning) $("previewPause").click();
  }
  console.log("갤러리 성능 배지 회귀 테스트 완료");
})();
