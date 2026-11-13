// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 뷰포트 툴바: 자주 쓰는 버튼만 남기고 나머지는 ⋯ 더보기 · 캡처 ▾ 메뉴로 옮겼다. 메뉴 동작과 실제 녹화(WebM 내려받기)를 확인한다.
(async () => {
  const $ = id => document.getElementById(id), stage = $("stage");
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const elapsedSeconds = value => /^\d+:[0-5]\d(?::[0-5]\d)?$/.test(value)
    ? value.split(":").reduce((total, part) => total * 60 + Number(part), 0) : null;
  // 실패 시 runner가 영상 원본과 캡처 요청 수를 보존한다. 타이머 실행과 실제 인코딩을 구분하기 위한 정보다.
  const captures = [], originalCapture = HTMLCanvasElement.prototype.captureStream;
  HTMLCanvasElement.prototype.captureStream = function (...args) {
    const stream = originalCapture.apply(this, args), track = stream.getVideoTracks()[0], request = track.requestFrame;
    const capture = { width: this.width, height: this.height, requests: 0, firstRequest: null, lastRequest: null };
    captures.push(capture);
    if (typeof request === "function") track.requestFrame = function (...values) {
      capture.requests++; capture.firstRequest ??= performance.now(); capture.lastRequest = performance.now();
      return request.apply(this, values);
    };
    return stream;
  };
  const visible = node => !!node && !node.hidden && node.getClientRects().length > 0; // offsetParent는 fixed 요소에서 늘 null이라 쓰지 않는다
  // 실패했을 때 이유가 보이게: 앱의 오류 알림(toast)과 녹화 상태
  const why = () => `toast="${$("uiToast").hidden ? "" : $("toastMessage").textContent}" recording=${stage.classList.contains("is-recording")}`;
  // 내려받기를 기다린다. CI(소프트웨어 렌더링 · 여러 테스트 동시 실행)에서는 녹화를 끝내고 파일이 나오기까지 몇 초 걸릴 수 있다.
  const waitDownload = async count => { for (let i = 0; i < 300 && downloads.length < count; i++) await wait(50); return downloads[count - 1]; };
  // 바이트 수는 화질·해상도·코덱에 따라 달라진다. 실제로 두 프레임 이상 디코딩되고 시간이 진행되는지 검사한다.
  const readVideo = async (file, width, height) => {
    test(!!file && /^shader-\d{8}-\d{6}\.(webm|mp4)$/.test(file.name) && file.blob?.size > 0 && /^video\//.test(file.blob.type), `영상 파일 내려받기: ${file?.name} ${file?.blob?.size}B ${file?.blob?.type} ${why()}`);
    const artifact = { name: file.name, blob: file.blob, capture: {...captures.at(-1)}, expected: {width, height} };
    (window.__recordingTestArtifacts ??= []).push(artifact);
    const video = document.createElement("video"), url = URL.createObjectURL(file.blob);
    video.muted = true;
    let timer, callback;
    try {
      const frame = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`영상 디코딩 시간 초과(두 프레임 필요): readyState=${video.readyState} time=${video.currentTime} decoded=${video.webkitDecodedFrameCount} size=${file.blob.size}`)), 15000);
        video.onerror = () => reject(new Error(`영상 디코딩 실패: ${video.error?.message}`));
        const next = (_, metadata) => {
          // 부하가 크면 표시 프레임은 건너뛸 수 있다. 디코딩한 프레임 수로 검사한다.
          if (video.getVideoPlaybackQuality().totalVideoFrames >= 2 && metadata.mediaTime > 0) resolve(metadata);
          else callback = video.requestVideoFrameCallback(next);
        };
        callback = video.requestVideoFrameCallback(next);
        video.src = url;
        video.play().catch(reject);
      });
      test(video.videoWidth === width && video.videoHeight === height, `디코딩된 영상 크기 ${video.videoWidth}×${video.videoHeight} = 렌더 크기 ${width}×${height}`);
      test(frame.mediaTime > 0, `영상 프레임 진행: ${video.getVideoPlaybackQuality().totalVideoFrames}장 · ${frame.mediaTime.toFixed(3)}초`);
      const image = document.createElement("canvas"); image.width = image.height = 1;
      const context = image.getContext("2d"); context.drawImage(video, 0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data;
    } catch (error) {
      artifact.decoder = {readyState: video.readyState, currentTime: video.currentTime, paused: video.paused, ended: video.ended,
        decoded: video.webkitDecodedFrameCount, totalFrames: video.getVideoPlaybackQuality().totalVideoFrames};
      console.warn(`녹화 진단: ${JSON.stringify({capture: artifact.capture, decoder: artifact.decoder})}`);
      throw error;
    } finally {
      clearTimeout(timer); video.cancelVideoFrameCallback(callback); video.pause();
      video.onerror = null; video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
    }
  };
  const key = k => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  // 내려받기를 가로챈다: a[download].click()이 만든 파일 이름과 Blob을 기록한다.
  const downloads = [], blobs = new Map(), originalUrl = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = blob => { const url = originalUrl.call(URL, blob); blobs.set(url, blob); return url; };
  HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: blobs.get(this.href) }); else originalClick.call(this); };
  const hudBefore = stage.classList.contains("hud-hidden");
  let probeRecorder;
  try {
    const direct = [...$("stageToolbar").children].filter(n => n.tagName === "BUTTON" && visible(n)).map(n => n.id);
    test(JSON.stringify(direct) === JSON.stringify(["panelToggle", "previewPause", "studioToggle", "quickShot", "captureToggle", "fullscreenToggle", "moreToggle"]), `툴바에는 자주 쓰는 버튼만(설정 패널 · 재생 · 편집기 · 스크린샷 · 캡처 ▾ · 전체화면 · 더보기): ${direct}`);
    for (const id of ["galleryToggle", "helpToggle", "hudToggle", "previewPopout", "themeToggle"])
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
    $("recordButton").click(); await wait(0);
    test(visible($("recordStop")) && stage.classList.contains("is-recording"), `녹화 버튼을 누르면 툴바에 녹화 표시: ${$("recordTime").textContent}`);
    // 인코더가 준비되는 동안은 '준비'. 느린 CI에서는 몇 초 걸릴 수 있으니 실제로 시작될 때까지 기다린다.
    for (let i = 0; i < 300 && $("recordTime").textContent === "준비"; i++) await wait(50);
    test(elapsedSeconds($("recordTime").textContent) !== null, `녹화 시작 → 경과 시간 표시: ${$("recordTime").textContent} ${why()}`);
    // 시간이 흐르는지: 고정된 시간만큼 기다리지 않고, 바뀔 때까지 기다린다(CI에서는 타이머가 밀릴 수 있다).
    const shown = $("recordTime").textContent, shownSeconds = elapsedSeconds(shown);
    for (let i = 0; i < 200 && $("recordTime").textContent === shown; i++) await wait(50);
    // CI의 긴 작업 뒤에는 0:00 → 0:10처럼 건너뛸 수 있다. 특정 한 자리 초 대신 실제 증가를 검사한다.
    test(elapsedSeconds($("recordTime").textContent) > shownSeconds, `경과 시간이 흐름: ${shown} → ${$("recordTime").textContent}`);
    test(!visible($("captureMenu")), "녹화를 시작하면 메뉴가 닫힘");
    $("captureToggle").click(); await wait(0);
    test($("recordButtonLabel").textContent === "녹화 중지", "녹화 중에는 메뉴 항목이 '녹화 중지'");
    $("captureToggle").click();
    $("recordStop").click();
    const file = await waitDownload(1);
    await readVideo(file, $("screen").width, $("screen").height);
    test(!visible($("recordStop")) && !stage.classList.contains("is-recording") && $("recordButtonLabel").textContent === "녹화 시작", "중지 후 표시 원래대로");
    // 스크린샷도 캡처 메뉴에서
    $("captureToggle").click(); $("screenshotButton").click();
    test(/\.png$/.test((await waitDownload(2))?.name || "") && !visible($("captureMenu")), `캡처 메뉴의 스크린샷 저장 ${why()}`);

    // 일시정지 중에도 녹화된다: 화면이 새로 그려지지 않아도 멈춘 화면이 영상으로 남는다.
    const wasPlaying = window.shaderStudio.getPlaybackState();
    if (wasPlaying) $("previewPause").click();
    await wait(200);
    $("captureToggle").click(); $("recordButton").click();
    // 준비에 걸린 시간을 녹화 시간에 포함하지 않는다. 실제 시작 뒤 1초 이상 담고 중지한다.
    for (let i = 0; i < 400 && !(elapsedSeconds($("recordTime").textContent) > 0); i++) await wait(50);
    test(elapsedSeconds($("recordTime").textContent) > 0, `일시정지 중에도 실제 녹화 시간이 흐름: ${$("recordTime").textContent} ${why()}`);
    $("recordStop").click();
    const still = await waitDownload(3);
    if (wasPlaying) $("previewPause").click();
    await readVideo(still, $("screen").width, $("screen").height);

    // 첫 프레임이 늦는 상황을 강제로 만든다. 빈 초기 캔버스 대신 실제 첫 프레임의 크기·색이 녹화되어야 한다.
    const Recorder = await import("./js/recorder.js"), source = document.createElement("canvas");
    let draw, state, saved, error;
    probeRecorder = Recorder.create({canvas: source, onFrame: fn => { draw = fn; return () => { draw = null; }; }, redraw() {},
      onChange: value => { state = value; }, onSave: (blob, name) => { saved = {blob, name}; }, onError: value => { error = value; }});
    probeRecorder.start(); await wait(300);
    test(state.recording && !state.ready && state.elapsed === 0, "첫 렌더 프레임이 오기 전에는 준비 중");
    source.width = 96; source.height = 64;
    const context = source.getContext("2d"); context.fillStyle = "#ff0000"; context.fillRect(0, 0, 96, 64); draw(source);
    for (let i = 0; i < 300 && !state.ready && !error; i++) await wait(50);
    test(state.ready && !error, `실제 첫 프레임으로 인코더 시작: ${error || "OK"}`);
    await wait(1000); probeRecorder.stop();
    for (let i = 0; i < 300 && !saved && !error; i++) await wait(50);
    const pixel = await readVideo(saved, 96, 64);
    test(pixel[0] > 200 && pixel[1] < 50 && pixel[2] < 50, `늦게 온 빨간 프레임이 녹화됨: ${[...pixel]}`);
  } finally {
    probeRecorder?.dispose();
    HTMLCanvasElement.prototype.captureStream = originalCapture;
    URL.createObjectURL = originalUrl;
    HTMLAnchorElement.prototype.click = originalClick;
    if (stage.classList.contains("hud-hidden") !== hudBefore) $("hudToggle").click();
    if (!$("recordStop").hidden) $("recordStop").click();
  }
  console.log("툴바 · 녹화 회귀 테스트 완료");
})();
