// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행 — 미디어 인코더를 쓰므로 하나씩).
// 영상 렌더링(오프라인)의 미디어(js/video-render.js · media-input.js prepareOffline/seekOffline):
//  · 오디오 파일 채널의 소리 분석이 렌더 시간에 맞는다: 앞 1초 무음 + 뒤 1초 440Hz 파일에서 0.5초는 조용하고 1.5초는 크다.
//    uChannelTime도 렌더 시간(파일 위치)이다. 실시간 재생과 무관하게 같은 결과
//  · 결과 파일에 소리: WebM(· MP4가 되면 MP4)을 디코딩하면 뒤쪽 절반만 소리가 난다 · PNG ZIP에는 audio.wav
//  · 영상 파일 채널은 렌더 시간으로 탐색한다: 위에서 만든 WebM(앞 1초 검정 · 뒤 1초 흰색)을 영상 채널로 읽으면 0.5초는 어둡고 1.5초는 밝다
//  · 끝나면 오디오가 다시 실시간으로 재생된다
(async () => {
  setInterval(() => { const d = document.getElementById("studioPromptDialog"), b = document.getElementById("studioDialogAlt"); if (d?.open && !b.hidden) b.click(); }, 50);
  const $ = id => document.getElementById(id), r = window.shaderPlayground, studio = window.shaderStudio;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(30)) if (condition()) return true; return condition(); };
  const downloads = [], realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) downloads.push({ name: this.download, blob: fetch(this.href).then(res => res.blob()) });
    else realClick.call(this);
  };
  // 앞 1초 무음 + 뒤 1초 440Hz(44.1kHz 모노)
  const silenceThenTone = () => {
    const rate = 44100, n = rate * 2, bytes = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (at, s) => [...s].forEach((ch, i) => bytes.setUint8(at + i, ch.charCodeAt(0)));
    text(0, "RIFF"); bytes.setUint32(4, 36 + n * 2, true); text(8, "WAVEfmt "); bytes.setUint32(16, 16, true);
    bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true); bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 2, true);
    bytes.setUint16(32, 2, true); bytes.setUint16(34, 16, true); text(36, "data"); bytes.setUint32(40, n * 2, true);
    for (let i = rate; i < n; i++) bytes.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 20000), true);
    return new File([bytes.buffer], "half-tone.wav", { type: "audio/wav" });
  };
  const bin = Math.round(440 / (44100 / 1024));
  // Buffer A(4×1, RGBA32F) 픽셀 0 = (440Hz 칸의 주파수 크기, iChannelTime[0] = uChannelTime[0], 0, 1)
  const project = {
    image: "void mainImage(out vec4 c, in vec2 p) { c = vec4(texelFetch(iChannel0, ivec2(0), 0).rrr, 1.0); }",
    passes: [{
      name: "A", format: "rgba32f", scale: 1, size: [4, 1], filter: "nearest", channels: { 0: { media: "audio" } },
      fragment: `void mainImage(out vec4 c, in vec2 p) { c = vec4(texture(iChannel0, vec2((${bin}.0 + 0.5) / 512.0, 0.25)).r, iChannelTime[0], 0.0, 1.0); }`,
    }],
    imageChannels: { 0: { buffer: "A", frame: "current" } },
  };
  const rms = (buffer, from, to) => {
    const data = buffer.getChannelData(0), a = Math.floor(from * buffer.sampleRate), b = Math.floor(to * buffer.sampleRate);
    let sum = 0;
    for (let i = a; i < b; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / Math.max(1, b - a));
  };
  const set = (id, value) => { const node = $(id); node.value = String(value); node.dispatchEvent(new Event("change", { bubbles: true })); };
  const dialog = $("videoRenderDialog");
  const runRender = async () => {
    const before = downloads.length;
    $("videoRenderStart").click();
    await until(() => dialog.dataset.state !== "running" && downloads.length > before, 120000);
    test(downloads.length === before + 1, `파일 내려받음: ${$("videoRenderStatus").textContent}`);
    const { name, blob } = downloads.at(-1);
    return { name, blob: await blob, status: $("videoRenderStatus").textContent };
  };
  const before = studio.getProject();
  try {
    test(studio.setProject(project), "오디오 파일 채널을 읽는 프로젝트");
    test(await r.startMedia("audio", silenceThenTone()), "앞 무음 · 뒤 440Hz 파일 켜기");

    // 1) 렌더 시간에 맞춘 소리 분석
    await r.prepareOfflineMedia();
    r.beginOffline({ width: 32, height: 32 });
    const at = async t => { await r.seekOfflineMedia(t); r.renderOfflineFrame({ time: t, delta: 0.05, frame: Math.round(t * 20) }); return Array.from(r.readPassPixel("A", 0, 0)); };
    try {
      let quiet;
      for (const t of [0.4, 0.45, 0.5]) quiet = await at(t);
      let loud;
      for (const t of [1.4, 1.45, 1.5]) loud = await at(t);
      test(quiet[0] < 0.2 && Math.abs(quiet[1] - 0.5) < 1e-4, `0.5초(무음 구간): 크기 ${quiet[0].toFixed(3)} · uChannelTime ${quiet[1]}`);
      test(loud[0] > 0.8 && Math.abs(loud[1] - 1.5) < 1e-4, `1.5초(440Hz 구간): 크기 ${loud[0].toFixed(3)} · uChannelTime ${loud[1]}`);
      const wrapped = await at(2.5);
      test(Math.abs(wrapped[1] - 0.5) < 1e-4, `파일 길이(2초)를 넘으면 처음부터: 2.5초 → 위치 ${wrapped[1]}`);
    } finally {
      r.endOffline();
      r.endOfflineMedia();
    }
    test(r.mediaState("audio").state === "on", "끝나면 오디오가 다시 실시간으로");

    // 2) 결과 파일의 소리(대화상자로 렌더링)
    $("videoRenderOpen").click();
    // 인코더 지원 조사(비동기)가 끝난 뒤에 형식 목록을 읽는다 — 끝나기 전에는 모든 형식이 쓸 수 있는 것처럼 보인다.
    test(await until(() => dialog.dataset.probed === "true", 30000), "인코더 지원 조사 끝남");
    const formats = [...$("videoFormat").options].filter(o => !o.disabled).map(o => o.value);
    let rendered = null;
    const containers = [formats.find(f => f.startsWith("webm")), formats.includes("mp4-h264") ? "mp4-h264" : null].filter(Boolean);
    if (!formats.includes("mp4-h264")) console.warn("이 브라우저는 H.264 인코딩이 없어 MP4 소리 검사를 건너뜀");
    for (const format of containers) {
      set("videoFormat", format); set("videoStart", 0); set("videoDuration", 2); set("videoFps", 10); set("videoSize", "custom"); set("videoWidth", 64); set("videoHeight", 36);
      test(!$("videoRenderStart").disabled, `${format}: 렌더링 시작 가능 — ${$("videoRenderSummary").textContent}`);
      const video = await runRender();
      if (format.startsWith("webm")) rendered = video.blob;
      test(/소리 포함/.test(video.status), `${format}: 완료 메시지에 '소리 포함' — ${video.status}`);
      const sound = await new AudioContext().decodeAudioData(await video.blob.arrayBuffer());
      const first = rms(sound, 0.1, 0.9), second = rms(sound, 1.1, 1.9);
      test(Math.abs(sound.duration - 2) < 0.1, `${format}: 소리 길이 ≈ 2초 (${sound.duration.toFixed(2)})`);
      test(first < 0.02 && second > 0.2, `${format}: 앞 1초 무음 · 뒤 1초 소리 (RMS ${first.toFixed(3)} / ${second.toFixed(3)})`);
      const element = document.createElement("video");
      element.muted = true; element.src = URL.createObjectURL(video.blob);
      await new Promise((resolve, reject) => { element.onloadedmetadata = resolve; element.onerror = () => reject(new Error(`video error ${element.error?.code}`)); });
      test(element.videoWidth === 64 && Math.abs(element.duration - 2) < 0.1, `${format}: 영상도 그대로 재생 (${element.videoWidth}px · ${element.duration.toFixed(2)}초)`);
      URL.revokeObjectURL(element.src);
    }
    // 3) 영상 파일 채널: 방금 만든 WebM(앞 검정 · 뒤 흰색)을 렌더 시간으로 탐색
    r.stopMedia("audio");
    const videoProject = structuredClone(project);
    videoProject.passes[0].channels = { 0: { media: "video" } };
    videoProject.passes[0].fragment = "void mainImage(out vec4 c, in vec2 p) { c = vec4(texture(iChannel0, vec2(0.5)).r, iChannelTime[0], 0.0, 1.0); }";
    test(studio.setProject(videoProject), "영상 파일 채널을 읽는 프로젝트");
    test(await r.startMedia("video", new File([rendered], "half-white.webm", { type: "video/webm" })), "만든 WebM을 영상 채널로");
    await r.prepareOfflineMedia();
    r.beginOffline({ width: 32, height: 32 });
    try {
      const frameAt = async t => { await r.seekOfflineMedia(t); r.renderOfflineFrame({ time: t, delta: 0.1, frame: 0 }); return Array.from(r.readPassPixel("A", 0, 0)); };
      const dark = await frameAt(0.5), bright = await frameAt(1.5), back = await frameAt(0.3);
      test(dark[0] < 0.2 && Math.abs(dark[1] - 0.5) < 1e-3, `영상 0.5초: 어둡다 ${dark[0].toFixed(2)} · 위치 ${dark[1]}`);
      test(bright[0] > 0.8 && Math.abs(bright[1] - 1.5) < 1e-3, `영상 1.5초: 밝다 ${bright[0].toFixed(2)} · 위치 ${bright[1]}`);
      test(back[0] < 0.2, `뒤로 탐색해도 그 시각 프레임: 0.3초 ${back[0].toFixed(2)}`);
    } finally {
      r.endOffline();
      r.endOfflineMedia();
    }
    r.stopMedia("video");
    test(studio.setProject(project), "다시 오디오 프로젝트");
    test(await r.startMedia("audio", silenceThenTone()), "오디오 다시 켜기");

    set("videoFormat", "png"); set("videoDuration", 0.5); set("videoFps", 4);
    const zip = await runRender(), text = new TextDecoder().decode(new Uint8Array(await zip.blob.arrayBuffer()));
    test(text.includes("audio.wav") && text.includes("-i audio.wav"), "PNG ZIP에 audio.wav와 ffmpeg 예시");
    $("videoRenderClose").click();
  } finally {
    HTMLAnchorElement.prototype.click = realClick;
    r.stopMedia("audio");
    r.stopMedia("video");
    studio.setProject(before);
  }
  console.log("영상 렌더링 미디어 회귀 테스트 완료");
})();
