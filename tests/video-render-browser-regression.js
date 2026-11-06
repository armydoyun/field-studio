// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 영상 렌더링(오프라인): 대화상자로 렌더링해 내려받은 파일을 열어 본다.
//   · PNG ZIP: 프레임마다 uTime = 시작 + i/fps, uFrame = 시작×fps + i 인지 픽셀로 확인
//   · WebM: <video>로 열어 크기·길이 확인(이 브라우저가 VP9/VP8 인코딩을 지원할 때)
//   · 버퍼 패스가 있으면 시작 시간 전 프레임을 먼저 그린다 · 취소 · 렌더링 중 보호 · 끝나면 원래 상태로
(async () => {
  const $ = id => document.getElementById(id), r = window.shaderPlayground, studio = window.shaderStudio;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(30)) if (condition()) return true; return condition(); };
  const area = $("studioCode"), live = $("studioLive"), original = area.value, wasLive = live.checked;
  const setScene = source => { area.value = source; area.dispatchEvent(new Event("input", { bubbles: true })); return studio.apply(); };
  // 같은 프레임들을 타일로(tilePixels 고정) 또는 한 번에 그려 마지막 프레임 픽셀을 돌려준다
  const offlinePixels = async ({ tiled, tilePixels = 0, frames = 3, width = 97, height = 61 }) => {
    r.beginOffline({ width, height, tilePixels });
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext("2d");
    const perFrame = [];
    try {
      for (let i = 0; i < frames; i++) {
        const frame = { time: 0.3 + i / 10, delta: 0.1, frame: i }, before = r.getOfflineTiling().tiles;
        if (tiled) await r.renderOfflineFrameTiled(frame, drawn => ctx.drawImage(drawn, 0, 0));
        else ctx.drawImage(r.renderOfflineFrame(frame), 0, 0);
        perFrame.push(r.getOfflineTiling().tiles - before);
      }
      return { data: ctx.getImageData(0, 0, width, height).data, perFrame };
    } finally {
      r.endOffline();
    }
  };
  const sameImage = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const set = (id, value) => { const node = $(id); node.value = String(value); node.dispatchEvent(new Event("change", { bubbles: true })); };
  // 내려받기를 가로채 Blob을 얻는다(ui.js의 download는 <a download>.click()을 쓴다).
  const downloads = [];
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) downloads.push({ name: this.download, blob: fetch(this.href).then(res => res.blob()) });
    else realClick.call(this);
  };
  const dialog = $("videoRenderDialog");
  const openDialog = async () => {
    $("videoRenderOpen").click();
    test(dialog.open, "대화상자 열림");
    await until(() => [...$("videoFormat").options].some(o => /지원 안 됨/.test(o.textContent)) || !$("videoRenderSummary").textContent.includes("지원"), 3000);
  };
  const runRender = async () => {
    const before = downloads.length;
    $("videoRenderStart").click();
    await until(() => dialog.dataset.state !== "running" && downloads.length > before, 120000);
    test(downloads.length === before + 1, `파일 내려받음: ${$("videoRenderStatus").textContent}`);
    const { name, blob } = downloads.at(-1);
    return { name, blob: await blob };
  };
  // store 방식 ZIP 읽기
  const unzip = async blob => {
    const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer), files = [];
    for (let at = 0; view.getUint32(at, true) === 0x04034b50; ) {
      const size = view.getUint32(at + 18, true), nameLength = view.getUint16(at + 26, true);
      const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength)), start = at + 30 + nameLength;
      files.push({ name, data: bytes.subarray(start, start + size) });
      at = start + size;
    }
    return files;
  };
  const pixel = async (data, fx = 0.5, fy = 0.5) => {
    const bitmap = await createImageBitmap(new Blob([data], { type: "image/png" })), canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, rgba: [...ctx.getImageData(Math.floor(bitmap.width * fx), Math.floor(bitmap.height * fy), 1, 1).data] };
  };
  live.checked = false;
  live.dispatchEvent(new Event("change"));
  try {
    // ---- 렌더링 중 보호(API) ----
    if (studio.getPlaybackState()) studio.togglePlayback();
    await wait(50);
    let threw = null;
    try { r.beginOffline({ width: 1, height: 64 }); } catch (error) { threw = error; }
    test(threw instanceof RangeError, "너무 작은 크기 거절");
    test(r.beginOffline({ width: 64, height: 36 }).width === 64 && r.getStats().offline, "오프라인 모드 진입");
    try { r.beginOffline({ width: 64, height: 36 }); threw = null; } catch (error) { threw = error; }
    test(/이미/.test(threw?.message), "두 번 들어갈 수 없음");
    try { r.setFragment(original); threw = null; } catch (error) { threw = error; }
    test(/영상 렌더링 중/.test(threw?.message), "렌더링 중에는 셰이더를 바꿀 수 없음");
    try { r.resetSimulation(); threw = null; } catch (error) { threw = error; }
    test(/영상 렌더링 중/.test(threw?.message), "렌더링 중에는 시간 초기화 불가");
    test(await r.captureScreenshot().then(() => false, error => /영상 렌더링 중/.test(error.message)), "렌더링 중에는 스크린샷 불가");
    r.start();
    test(!r.getStats().running, "렌더링 중 재생은 끝난 뒤로 미룸");
    test(r.renderOfflineFrame({ time: 0, delta: 0, frame: 0 }) === $("screen") && r.getStats().width === 64, "지정 크기로 한 프레임");
    test(r.endOffline() && !r.getStats().offline, "오프라인 모드 종료");
    await until(() => r.getStats().running, 2000);
    test(r.getStats().running, "렌더링 중에 누른 재생을 끝난 뒤 이어 감");
    studio.togglePlayback();
    await wait(50);

    // ---- 타일 렌더링: 나눠 그려도 한 번에 그린 것과 같다 ----
    {
      const single = await offlinePixels({ tiled: false });
      const tiles = await offlinePixels({ tiled: true, tilePixels: 300 });
      test(tiles.perFrame.every(n => n > 10), `작은 타일로 나눠 그림 (프레임마다 ${tiles.perFrame.join("·")}개)`);
      test(sameImage(single.data, tiles.data), "타일로 그린 결과 = 한 번에 그린 결과 (Image)");
      const auto = await offlinePixels({ tiled: true, frames: 4, width: 256, height: 144 });
      test(auto.perFrame.at(-1) === 1, `가벼운 셰이더는 잰 시간에 따라 곧 한 장으로 (${auto.perFrame.join("·")})`);
    }

    // ---- PNG 연속 이미지: 프레임마다 정확한 시간 ----
    test(setScene(`#version 300 es
precision highp float;
uniform float uTime;
uniform float uDeltaTime;
uniform int uFrame;
uniform vec2 uResolution;
out vec4 fragColor;
void main() {
  // R = uTime의 소수부, G = uFrame, B = uDeltaTime × 2, 오른쪽 위 1/4은 해상도 확인용 흰색
  vec2 uv = gl_FragCoord.xy / uResolution;
  fragColor = uv.x > 0.75 && uv.y > 0.75 ? vec4(1.0) : vec4(fract(uTime), float(uFrame) / 255.0, uDeltaTime * 2.0, 1.0);
}
`), "시간 확인용 셰이더 적용");
    const time0 = r.getStats().time, size0 = [r.getStats().width, r.getStats().height];
    await openDialog();
    set("videoStart", 1.25);
    set("videoDuration", 1);
    set("videoFps", 4);
    set("videoSize", "custom");
    set("videoWidth", 97);
    set("videoHeight", 33);
    set("videoFormat", "png");
    test($("videoQualityField").hidden, "PNG면 품질 칸 숨김");
    test(/^4프레임 · 97 × 33 · 4fps/.test($("videoRenderSummary").textContent), `요약: ${$("videoRenderSummary").textContent}`);
    const png = await runRender();
    test(/-97x33-4fps\.zip$/.test(png.name) && png.blob.type === "application/zip", `PNG ZIP 파일: ${png.name}`);
    const files = await unzip(png.blob);
    test(files.map(f => f.name).join() === "frame_00000.png,frame_00001.png,frame_00002.png,frame_00003.png,README.txt", "4장 + README");
    for (const [i, file] of files.slice(0, 4).entries()) {
      const { width, height, rgba } = await pixel(file.data, 0.25, 0.25);
      const t = 1.25 + i / 4, expectR = Math.round((t % 1) * 255), expectG = 5 + i;
      test(width === 97 && height === 33, `프레임 ${i} 크기 97×33 (홀수도 그대로)`);
      test(Math.abs(rgba[0] - expectR) <= 1 && rgba[1] === expectG && Math.abs(rgba[2] - 128) <= 1,
        `프레임 ${i}: uTime ${t} → R ${rgba[0]}(${expectR}) · uFrame ${expectG} → G ${rgba[1]} · uDeltaTime 0.25 → B ${rgba[2]}`);
      test((await pixel(file.data, 0.9, 0.1)).rgba.slice(0, 3).join() === "255,255,255", `프레임 ${i}: 위쪽이 위(뒤집히지 않음)`);
    }
    test(/ffmpeg -framerate 4 -i frame_%05d\.png/.test(new TextDecoder().decode(files[4].data)), "README에 ffmpeg 예");
    await wait(100);
    const after = r.getStats();
    test(after.time === time0 && after.width === size0[0] && after.height === size0[1] && !after.running && !after.offline,
      `끝나면 시간·크기·일시정지 상태 복원 ${JSON.stringify([after.time, time0, after.width, size0, after.running, after.offline])}`);

    // ---- 영상(MP4 · WebM) ----
    const formats = [...$("videoFormat").options].filter(o => !o.disabled).map(o => o.value);
    const videoFormats = ["mp4-h264", formats.find(f => f.startsWith("webm"))].filter(f => formats.includes(f));
    if (!videoFormats.includes("mp4-h264")) console.warn("이 브라우저는 WebCodecs H.264 인코딩을 지원하지 않아 MP4 검사를 건너뜀");
    if (!videoFormats.some(f => f.startsWith("webm"))) console.warn("이 브라우저는 WebCodecs VP9/VP8 인코딩을 지원하지 않아 WebM 검사를 건너뜀");
    for (const format of videoFormats) {
      const [container] = format.split("-");
      set("videoFormat", format);
      set("videoStart", 0);
      set("videoDuration", 1);
      set("videoFps", 10);
      set("videoWidth", 129); // 홀수는 짝수로 내림
      set("videoHeight", 72);
      test(/^10프레임 · 128 × 72/.test($("videoRenderSummary").textContent), `${container}: 짝수 크기`);
      const video = await runRender();
      test(video.blob.type === `video/${container}` && new RegExp(`-128x72-10fps\\.${container}$`).test(video.name), `${container} 파일: ${video.name}`);
      const element = document.createElement("video");
      element.muted = true;
      element.src = URL.createObjectURL(video.blob);
      await new Promise((resolve, reject) => { element.onloadedmetadata = resolve; element.onerror = () => reject(new Error(`video error ${element.error?.code}`)); });
      test(element.videoWidth === 128 && element.videoHeight === 72, `${container}: 재생 가능 · ${element.videoWidth}×${element.videoHeight}`);
      test(Math.abs(element.duration - 1) < 0.01, `${container}: 길이 1초 (${element.duration})`);
      // 마지막 프레임까지 디코딩되는지: 끝 근처로 옮겨 그 화면이 나오는지 본다
      element.currentTime = 0.95;
      await new Promise((resolve, reject) => { element.onseeked = resolve; element.onerror = () => reject(new Error(`seek error ${element.error?.code}`)); });
      test(element.readyState >= 2, `${container}: 끝 프레임까지 디코딩`);
      URL.revokeObjectURL(element.src);
    }

    // ---- 버퍼 패스: 시작 시간 전 프레임을 먼저 그린다 ----
    test(await studio.exampleFeedback(), "버퍼 예제 열기");
    {
      // 버퍼(피드백) 패스도 타일로 나눠 그린다: 여러 프레임 뒤의 결과가 한 번에 그린 것과 같아야 한다
      const single = await offlinePixels({ tiled: false, frames: 6 });
      const tiles = await offlinePixels({ tiled: true, tilePixels: 400, frames: 6 });
      test(sameImage(single.data, tiles.data), `타일로 그린 결과 = 한 번에 그린 결과 (버퍼 패스 · 6프레임, 프레임마다 타일 ${tiles.perFrame[0]}개)`);
    }
    // 화면의 시뮬레이션을 조금 돌린 뒤 멈추고, 버퍼 내용·프레임 수·시간을 적어 둔다(렌더링 뒤 그대로여야 한다).
    if (!studio.getPlaybackState()) studio.togglePlayback();
    await until(() => r.getStats().frame > 30, 20000);
    studio.togglePlayback();
    await wait(100);
    const width0 = r.getStats().width, height0 = r.getStats().height;
    const probes = [];
    for (let y = 0.1; y < 1; y += 0.2) for (let x = 0.1; x < 1; x += 0.2) probes.push([Math.floor(width0 * x), Math.floor(height0 * y)]);
    const snapshot = () => ({
      frame: r.getStats().frame,
      time: r.getStats().time,
      pixels: ["A", "B"].map(name => probes.map(([x, y]) => r.readPassPixel(name, x, y).join(",")).join(" ")),
    });
    const sim0 = snapshot();
    test(sim0.pixels[1].split(" ").some(p => p !== "0,0,0,0"), "버퍼 B에 시뮬레이션 내용이 있다");
    const realFrame = r.renderOfflineFrameTiled, seen = [];
    r.renderOfflineFrameTiled = (frame, capture) => { seen.push(frame); return realFrame(frame, capture); };
    try {
      set("videoFormat", "png");
      set("videoStart", 0.5);
      set("videoDuration", 0.2);
      set("videoFps", 10);
      set("videoWidth", 64);
      set("videoHeight", 36);
      await runRender();
    } finally {
      r.renderOfflineFrameTiled = realFrame;
    }
    test(seen.length === 7, `준비 5프레임 + 본 2프레임 (${seen.length})`);
    test(seen.map(f => f.frame).join() === "0,1,2,3,4,5,6" && Math.abs(seen[5].time - 0.5) < 1e-9 && seen[0].time === 0, "uFrame은 0부터 이어지고 본 영상은 0.5초부터");
    await wait(100);
    const sim1 = snapshot();
    test(sim1.frame === sim0.frame && sim1.time === sim0.time, `렌더링 뒤 프레임 수·시간 그대로 (${sim0.frame} → ${sim1.frame})`);
    test(sim1.pixels[0] === sim0.pixels[0] && sim1.pixels[1] === sim0.pixels[1], "렌더링 뒤 버퍼 내용(시뮬레이션 상태) 그대로");
    test(!r.getStats().running && r.getStats().width === width0, "멈춘 상태·화면 크기 그대로");

    // ---- 렌더링 중 WebGL 컨텍스트 손실 ----
    {
      const lose = $("screen").getContext("webgl2").getExtension("WEBGL_lose_context");
      if (!lose) console.warn("WEBGL_lose_context가 없어 컨텍스트 손실 검사를 건너뜀");
      else {
        set("videoFormat", "png");
        set("videoStart", 0);
        set("videoDuration", 600);
        set("videoFps", 30);
        set("videoWidth", 64);
        set("videoHeight", 36);
        const before = downloads.length;
        $("videoRenderStart").click();
        test(await until(() => $("videoRenderProgress").value > 0, 30000), "손실 검사: 렌더링 시작");
        lose.loseContext();
        test(await until(() => dialog.dataset.state !== "running", 10000), "컨텍스트를 잃으면 렌더링이 멈춘다(멈춰 있지 않음)");
        test(/컨텍스트를 잃었습니다/.test($("videoRenderStatus").textContent) && /크기를 줄여/.test($("videoRenderStatus").textContent), `원인과 해결 안내: ${$("videoRenderStatus").textContent}`);
        test(downloads.length === before && !r.getStats().offline, "파일 없음 · 오프라인 모드 해제");
        lose.restoreContext();
        test(await until(() => !$("screen").getContext("webgl2").isContextLost(), 5000), "컨텍스트 복구");
        await wait(200);
        if (!studio.getPlaybackState()) studio.togglePlayback();
        test(await until(() => r.getStats().running && r.getStats().frame > 3, 10000), `복구 뒤 다시 그린다 (프레임 ${r.getStats().frame})`);
        test(await r.captureScreenshot().then(blob => blob.size > 0), "복구 뒤 스크린샷");
        studio.togglePlayback();
        set("videoDuration", 0.2);
        set("videoFps", 10);
        const again = await runRender();
        test(/\.zip$/.test(again.name), "복구 뒤 다시 영상 렌더링");
      }
    }

    // ---- 취소 ----
    set("videoDuration", 600);
    set("videoFps", 60);
    const before = downloads.length;
    $("videoRenderStart").click();
    test(await until(() => $("videoRenderProgress").value > 0, 30000), "렌더링 진행 중");
    test($("videoRenderFields").disabled && dialog.dataset.state === "running", "렌더링 중 설정 잠금");
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    test(await until(() => dialog.dataset.state !== "running", 10000), "Esc로 취소");
    test(dialog.open && /취소/.test($("videoRenderStatus").textContent) && downloads.length === before, "취소하면 파일 없이 대화상자는 열린 채");
    test(!r.getStats().offline && !$("videoRenderFields").disabled, "취소 뒤 원래 상태");
    $("videoRenderClose").click();
    test(!dialog.open, "닫기");
    console.log("영상 렌더링 회귀 검사 통과");
  } finally {
    HTMLAnchorElement.prototype.click = realClick;
    if (dialog.open) dialog.close();
    if (r.getStats().offline) r.endOffline();
    setScene(original);
    live.checked = wasLive;
    live.dispatchEvent(new Event("change"));
  }
})();
