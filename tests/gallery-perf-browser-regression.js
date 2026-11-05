// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 갤러리 지연 로딩 + 성능 배지: 카드가 화면에 보일 때만 썸네일을 그리고 성능을 잰다(갤러리를 열 때 전부 하지 않는다).
// 재는 동안 메인 미리보기를 멈췄다가 보이는 카드를 다 하면 다시 켠다. 닫으면 멈추고, 다시 열거나 스크롤하면 이어서 한다.
// 배지는 지금 미리보기 크기(해상도 배율 반영)로 환산한다.
(async () => {
  const $ = id => document.getElementById(id), renderer = window.shaderPlayground, dialog = $("gallery");
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (condition()) return true; return condition(); };
  const card = id => document.querySelector(`.gallery-card[data-id="${id}"]`);
  const level = id => card(id).querySelector(".gallery-perf").dataset.level;
  const badges = () => [...document.querySelectorAll(".gallery-card .gallery-perf")];
  const pending = () => badges().filter(badge => badge.dataset.level === "pending").length;
  const LEVELS = new Set(["light", "medium", "heavy", "extreme"]);
  const wasRunning = renderer.getStats().running;
  const body = dialog.querySelector(".gallery-body");
  try {
    test(badges().length >= 28 && badges().length === document.querySelectorAll(".gallery-card").length, `카드마다 성능 배지 (${badges().length})`);
    test(pending() === badges().length && badges().every(badge => badge.textContent === "대기"), "열기 전에는 모두 '대기'");
    test(!!body.querySelector(".gallery-perf-legend"), "배지 단계 설명이 갤러리에 있다");
    if (!wasRunning) $("previewPause").click();
    $("galleryToggle").click();
    test(dialog.open, "갤러리 열림");
    body.scrollTop = 0;
    // 처음 보이는 카드(Shader Art 첫 줄)부터 잰다. 재는 동안 메인 미리보기를 멈춘다.
    let sawPaused = false;
    test(await until(() => (sawPaused ||= !renderer.getStats().running) && level("aurora") !== "pending", 60_000), "보이는 첫 카드를 잰다");
    test(sawPaused, "재는 동안 메인 미리보기를 멈춘다");
    // 아래쪽(화면 밖) 카드는 보이기 전에는 재지 않는다 — 지연 로딩.
    await until(() => renderer.getStats().running, 60_000);
    test(renderer.getStats().running, "보이는 카드를 다 하면 미리보기를 다시 켠다");
    const last = [...document.querySelectorAll("#galleryLessons .gallery-card")].at(-1).dataset.id;
    await wait(500);
    test(level(last) === "pending", `화면 밖 카드(${last})는 아직 재지 않는다`);
    test(pending() > 5, `보이는 카드만 쟀다 (남은 ${pending()}개)`);
    // 닫으면 멈추고, 미리보기는 돌아간다.
    $("galleryClose").click();
    await wait(200);
    test(!dialog.open && renderer.getStats().running, "닫으면 미리보기가 돈다");
    const closed = pending();
    body.scrollTop = body.scrollHeight;
    await wait(600);
    test(pending() === closed, "닫혀 있는 동안은 재지 않는다");
    // 다시 열고 끝까지 스크롤하며 모두 채운다.
    $("galleryToggle").click();
    for (const node of document.querySelectorAll(".gallery-card")) {
      node.scrollIntoView({ block: "center" });
      await until(() => node.querySelector(".gallery-perf").dataset.level !== "pending", 60_000);
    }
    test(pending() === 0, `스크롤하면 모두 잰다 (남은 ${pending()}개)`);
    const states = badges().map(badge => ({ id: badge.closest(".gallery-card").dataset.id, level: badge.dataset.level, label: badge.textContent, title: badge.title }));
    const failed = states.filter(state => !LEVELS.has(state.level)).map(state => `${state.id}:${state.level}`);
    test(!failed.length, `모든 예제를 재는 데 성공 ${failed.join(", ")}`);
    // 배지는 지금 미리보기 크기로 환산한다.
    const { width, height } = renderer.getStats();
    test(states.every(state => state.title.includes(`(${width}×${height})에서 한 프레임 약`)), `배지 툴팁이 지금 미리보기 크기 ${width}×${height} 기준`);
    // 썸네일이 실제로 그려졌다(단일 패스 예제).
    const thumb = card("hexplasma").querySelector("canvas"), pixel = thumb.getContext("2d").getImageData(160, 100, 1, 1).data;
    test(pixel[3] > 0, "보인 카드의 썸네일이 그려졌다");
    // 아주 가벼운 예제가 아주 무거운 예제보다 무겁게 나오지 않는다(측정이 뒤섞이지 않았는지).
    const ms = id => Number(/약 ([\d.]+)ms/.exec(states.find(state => state.id === id).title)[1]);
    test(ms("annotations") < ms("terrain") && ms("hexplasma") < ms("skyline"), `가벼운 예제 < 무거운 예제 (${ms("annotations")} < ${ms("terrain")}, ${ms("hexplasma")} < ${ms("skyline")})`);
    await wait(300);
    test(renderer.getStats().running, "다 재면 미리보기를 다시 켠다");
  } finally {
    if (dialog.open) $("galleryClose").click();
    if (renderer.getStats().running !== wasRunning) $("previewPause").click();
  }
  console.log("갤러리 지연 로딩 · 성능 배지 회귀 테스트 완료");
})();
