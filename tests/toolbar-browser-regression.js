// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 뷰포트 툴바: 자주 쓰는 버튼만 남기고 나머지는 ⋯ 더보기 · 캡처 ▾ 메뉴로 옮겼다. 메뉴 동작과 실제 녹화(WebM 내려받기)를 확인한다.
(async () => {
  const $ = id => document.getElementById(id), stage = $("stage");
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = node => !!node && !node.hidden && node.getClientRects().length > 0; // offsetParent는 fixed 요소에서 늘 null이라 쓰지 않는다
  const key = k => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  // 내려받기를 가로챈다: a[download].click()이 만든 파일 이름과 Blob을 기록한다.
  const downloads = [], blobs = new Map(), originalUrl = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = blob => { const url = originalUrl.call(URL, blob); blobs.set(url, blob); return url; };
  HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: blobs.get(this.href) }); else originalClick.call(this); };
  const hudBefore = stage.classList.contains("hud-hidden");
  try {
    const direct = [...$("stageToolbar").children].filter(n => n.tagName === "BUTTON" && visible(n)).map(n => n.id);
    test(JSON.stringify(direct) === JSON.stringify(["previewPause", "studioToggle", "captureToggle", "fullscreenToggle", "moreToggle"]), `툴바에는 자주 쓰는 버튼 5개만: ${direct}`);
    for (const id of ["galleryToggle", "helpToggle", "panelToggle", "hudToggle", "previewPopout", "themeToggle"])
      test($("moreMenu").contains($(id)) && !visible($(id)), `${id}는 닫힌 ⋯ 메뉴 안에`);
    test($("captureMenu").contains($("screenshotButton")) && $("captureMenu").contains($("recordButton")), "스크린샷·녹화는 캡처 메뉴 안에");

    // ⋯ 메뉴: 열면 첫 항목에 초점, ↓로 이동, Esc로 닫고 메뉴 버튼에 초점
    $("moreToggle").click(); await wait(0);
    test(visible($("moreMenu")) && $("moreToggle").getAttribute("aria-expanded") === "true" && document.activeElement === $("galleryToggle"), "⋯ 메뉴 열기 → 첫 항목에 초점");
    const r = $("moreMenu").getBoundingClientRect(), t = $("moreToggle").getBoundingClientRect();
    test(r.top >= t.bottom && r.right <= window.innerWidth && r.left >= 0, "메뉴는 버튼 아래, 화면 안에");
    key("ArrowDown"); test(document.activeElement === $("helpToggle"), "↓로 다음 항목");
    key("End"); test(document.activeElement === $("themeToggle"), "End로 마지막 항목");
    key("Escape"); await wait(0);
    test(!visible($("moreMenu")) && document.activeElement === $("moreToggle"), "Esc로 닫고 메뉴 버튼에 초점");
    // 항목을 누르면 동작하고 메뉴가 닫힌다
    $("moreToggle").click(); $("hudToggle").click(); await wait(0);
    test(stage.classList.contains("hud-hidden") !== hudBefore && !visible($("moreMenu")), "HUD 항목: 동작 후 메뉴 닫힘");
    test($("hudToggle").getAttribute("aria-pressed") === String(hudBefore), "HUD 켜짐 표시(aria-pressed) 갱신");
    $("hudToggle").click();
    // 바깥을 누르면 닫힌다. 한 메뉴를 열면 다른 메뉴는 닫힌다.
    $("moreToggle").click(); document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await wait(0);
    test(!visible($("moreMenu")), "바깥을 누르면 닫힘");
    $("moreToggle").click(); $("captureToggle").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); $("captureToggle").click(); await wait(0);
    test(visible($("captureMenu")) && !visible($("moreMenu")), "캡처 메뉴를 열면 ⋯ 메뉴는 닫힘");

    // 녹화: 시작 → 툴바에 경과 시간 → 중지하면 영상 파일을 내려받는다
    test(!$("recordButton").disabled, "녹화 지원(Chromium)");
    $("recordButton").click(); await wait(1600);
    test(visible($("recordStop")) && /^0:0[1-9]$/.test($("recordTime").textContent) && stage.classList.contains("is-recording"), `녹화 중 표시 ${$("recordTime").textContent}`);
    test(!visible($("captureMenu")), "녹화를 시작하면 메뉴가 닫힘");
    $("captureToggle").click(); await wait(0);
    test($("recordButtonLabel").textContent === "녹화 중지", "녹화 중에는 메뉴 항목이 '녹화 중지'");
    $("captureToggle").click();
    $("recordStop").click();
    for (let i = 0; i < 40 && !downloads.length; i++) await wait(50);
    const file = downloads.at(-1);
    test(!!file && /^shader-\d{8}-\d{6}\.(webm|mp4)$/.test(file.name) && file.blob?.size > 1000 && /^video\//.test(file.blob.type), `영상 파일 내려받기: ${file?.name} ${file?.blob?.size}B ${file?.blob?.type}`);
    test(!visible($("recordStop")) && !stage.classList.contains("is-recording") && $("recordButtonLabel").textContent === "녹화 시작", "중지 후 표시 원래대로");
    // 스크린샷도 캡처 메뉴에서
    $("captureToggle").click(); $("screenshotButton").click();
    for (let i = 0; i < 40 && downloads.length < 2; i++) await wait(50);
    test(/\.png$/.test(downloads.at(-1)?.name || "") && !visible($("captureMenu")), "캡처 메뉴의 스크린샷 저장");
  } finally {
    URL.createObjectURL = originalUrl;
    HTMLAnchorElement.prototype.click = originalClick;
    if (stage.classList.contains("hud-hidden") !== hudBefore) $("hudToggle").click();
    if (!$("recordStop").hidden) $("recordStop").click();
  }
  console.log("툴바 · 녹화 회귀 테스트 완료");
})();
