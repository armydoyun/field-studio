// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 갤러리 지연 로딩 + 성능 배지: 카드가 화면에 보일 때만 썸네일을 그리고 성능을 잰다(갤러리를 열 때 전부 하지 않는다).
// 메인 미리보기는 카드 하나를 재는 동안만 멈춘다. 닫으면 멈추고, 다시 열거나 스크롤하면 이어서 한다.
// 배지는 지금 미리보기 크기(해상도 배율 반영)로 환산한다.
// CI(소프트웨어 렌더링 · 동시 실행)에서는 무거운 예제 하나에 수 초가 걸리므로, 28개를 모두 재지 않고
// 처음 보이는 카드와 맨 아래 가벼운 레슨 몇 개만 잰다.
(async () => {
  const $ = id => document.getElementById(id), renderer = window.shaderPlayground, dialog = $("gallery");
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (condition()) return true; return condition(); };
  const card = id => document.querySelector(`.gallery-card[data-id="${id}"]`);
  const badge = id => card(id).querySelector(".gallery-perf");
  const measured = id => !["pending", "unknown"].includes(badge(id).dataset.level);
  const badges = () => [...document.querySelectorAll(".gallery-card .gallery-perf")];
  const pending = () => badges().filter(node => node.dataset.level === "pending").length;
  const LEVELS = new Set(["light", "medium", "heavy", "extreme"]);
  const wasRunning = renderer.getStats().running;
  const body = dialog.querySelector(".gallery-body");
  const started = Date.now(), elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  try {
    test(badges().length >= 28 && badges().length === document.querySelectorAll(".gallery-card").length, `카드마다 성능 배지 (${badges().length})`);
    test(pending() === badges().length && badges().every(node => node.textContent === "대기"), "열기 전에는 모두 '대기'");
    test(!!body.querySelector(".gallery-perf-legend"), "배지 단계 설명이 갤러리에 있다");
    if (!wasRunning) $("previewPause").click();
    $("galleryToggle").click();
    test(dialog.open, "갤러리 열림");
    body.scrollTop = 0;
    // 처음 보이는 카드부터 잰다. 재는 동안 메인 미리보기를 멈추고, 그 카드를 다 재면 다시 켠다.
    let sawPaused = false;
    test(await until(() => (sawPaused ||= !renderer.getStats().running) && measured("aurora"), 90_000), `보이는 첫 카드를 잰다 (${elapsed()})`);
    test(sawPaused, "재는 동안 메인 미리보기를 멈춘다");
    let sawRunning = false;
    test(await until(() => (sawRunning ||= renderer.getStats().running), 30_000), `카드를 하나 재고 나면 미리보기를 다시 켠다 (${elapsed()})`);
    // 아래쪽(화면 밖) 카드는 보이기 전에는 재지 않는다 — 지연 로딩.
    const lessons = [...document.querySelectorAll("#galleryLessons .gallery-card")].map(node => node.dataset.id);
    test(lessons.every(id => badge(id).dataset.level === "pending"), "화면 밖 카드(기법 배우기)는 아직 재지 않는다");
    // 닫으면 멈추고, 미리보기는 돌아간다.
    $("galleryClose").click();
    await wait(300);
    test(!dialog.open && renderer.getStats().running, "닫으면 미리보기가 돈다");
    const closed = pending();
    await wait(800);
    test(pending() === closed, "닫혀 있는 동안은 재지 않는다");
    // 다시 열고 맨 아래로 스크롤하면 그쪽 카드를 잰다(가벼운 레슨).
    $("galleryToggle").click();
    const targets = ["annotations", "keyboard", "mrt"];
    card(targets[0]).scrollIntoView({ block: "start" });
    for (const id of targets) {
      card(id).scrollIntoView({ block: "nearest" });
      test(await until(() => measured(id), 90_000), `스크롤해 보이면 잰다: ${id} (${elapsed()})`);
    }
    // 배지는 지금 미리보기 크기로 환산한다.
    const { width, height } = renderer.getStats();
    const done = badges().filter(node => node.dataset.level !== "pending");
    test(done.every(node => LEVELS.has(node.dataset.level)), `잰 카드는 모두 단계가 있다: ${done.map(node => node.closest(".gallery-card").dataset.id + ":" + node.dataset.level).join(", ")}`);
    test(done.every(node => node.title.includes(`(${width}×${height})에서 한 프레임 약`)), `배지 툴팁이 지금 미리보기 크기 ${width}×${height} 기준`);
    // 보인 카드의 썸네일이 실제로 그려졌다(단일 패스 예제).
    const pixel = card("aurora").querySelector("canvas").getContext("2d").getImageData(160, 100, 1, 1).data;
    test(pixel[3] > 0, "보인 카드의 썸네일이 그려졌다");
    // 값의 크기 비교는 하지 않는다: 소프트웨어 렌더링에서 다른 테스트와 CPU를 나눠 쓰면 몇 배씩 흔들린다.
    // 계산 자체는 gallery-perf-regression.js가 가짜 GL로 검사한다. 여기서는 기록만 남긴다.
    const ms = id => Number(/약 ([\d.]+)ms/.exec(badge(id).title)[1]);
    test(done.every(node => ms(node.closest(".gallery-card").dataset.id) > 0), "잰 값은 모두 0보다 크다");
    await until(() => renderer.getStats().running, 10_000);
    test(renderer.getStats().running, "재지 않을 때는 미리보기가 돈다");
    console.log(`잰 카드 ${done.length}개: ${done.map(node => `${node.closest(".gallery-card").dataset.id}=${ms(node.closest(".gallery-card").dataset.id)}ms`).join(" ")}`);
  } finally {
    if (dialog.open) $("galleryClose").click();
    if (renderer.getStats().running !== wasRunning) $("previewPause").click();
  }
  console.log("갤러리 지연 로딩 · 성능 배지 회귀 테스트 완료");
})();
