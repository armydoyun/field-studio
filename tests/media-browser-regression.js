// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 미디어 입력 채널(js/media-input.js): 웹캠 · 마이크 · 오디오 파일 · 영상 파일이 실제 텍스처로 들어오는지,
// 켜기 전에는 빈 텍스처(iChannelResolution = 0)인지, 연결을 끊으면 꺼지는지, 칩이 상태를 보여 주는지 본다.
// 실행기(tests/run.mjs)는 Chromium을 가짜 카메라 · 마이크(--use-fake-device-for-media-stream)로 띄운다.
// 손으로 돌릴 때는 카메라 · 마이크 권한을 허용하세요.
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const until = async (check, label, ms = 8000) => {
    const end = performance.now() + ms;
    while (performance.now() < end) { if (check()) return; await frames(2); }
    throw new Error(`FAIL: 시간 초과 — ${label}`);
  };
  // Buffer A(4×4, RGBA32F)가 iChannel0의 크기와 한 점을 적는다: (해상도 x, 해상도 y, 값, 1)
  const pixel = () => Array.from(r.readPassPixel("A", 0, 0));
  const project = (ref, sample = "texture(iChannel0, vec2(0.5)).r") => ({
    image: "void mainImage(out vec4 c, in vec2 p) { c = vec4(0.0, 0.0, 0.0, 1.0); }",
    passes: [{
      name: "A", format: "rgba32f", scale: 1, size: [4, 4], filter: "nearest",
      fragment: `uniform sampler2D iChannel0;\nuniform vec3 iChannelResolution[4];\nvoid mainImage(out vec4 c, in vec2 p) {\n    c = vec4(iChannelResolution[0].xy, ${sample}, 1.0);\n}`,
      channels: ref ? { 0: ref } : {},
    }],
    imageChannels: {},
  });
  // 1초짜리 440Hz 사인파 WAV
  const sineWav = () => {
    const rate = 44100, n = rate, bytes = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (at, s) => [...s].forEach((ch, i) => bytes.setUint8(at + i, ch.charCodeAt(0)));
    text(0, "RIFF"); bytes.setUint32(4, 36 + n * 2, true); text(8, "WAVEfmt "); bytes.setUint32(16, 16, true);
    bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true); bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 2, true);
    bytes.setUint16(32, 2, true); bytes.setUint16(34, 16, true); text(36, "data"); bytes.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) bytes.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 20000), true);
    return new File([bytes.buffer], "sine440.wav", { type: "audio/wav" });
  };
  // 빨간 화면 160×90 WebM. 바쁜 CI에서는 타이머로 그린 캔버스 녹화가 빈 파일이나 프레임을 풀 수 없는 아주 짧은 파일이 되곤
  // 했다(재생은 되지만 readyState가 1에 머물러 텍스처가 올라가지 않음 → '영상 프레임' 시간 초과).
  // 그래서 프레임을 직접 밀어 넣고(captureStream(0) + requestFrame), 만든 파일이 실제로 첫 프레임까지 풀리는지 확인해
  // 안 되면 다시 만든다.
  const recordRed = async frames => {
    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext("2d"), stream = canvas.captureStream(0), track = stream.getVideoTracks()[0], chunks = [];
    const paint = () => { ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 160, 90); track.requestFrame?.(); };
    paint();
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    recorder.ondataavailable = event => event.data.size && chunks.push(event.data);
    recorder.start(100);
    for (let i = 0; i < frames; i++) { paint(); await new Promise(resolve => setTimeout(resolve, 33)); }
    await new Promise(resolve => { recorder.onstop = resolve; recorder.stop(); });
    stream.getTracks().forEach(each => each.stop());
    return new File(chunks, "red.webm", { type: "video/webm" });
  };
  // 첫 프레임이 풀리는지(readyState ≥ 2) 따로 열어 본다
  const decodes = file => new Promise(resolve => {
    if (!file.size) return resolve(false);
    const video = document.createElement("video"), url = URL.createObjectURL(file);
    const done = ok => { clearTimeout(timer); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); resolve(ok); };
    const timer = setTimeout(() => done(video.readyState >= 2 && video.videoWidth > 0), 4000);
    video.muted = true;
    video.onloadeddata = () => done(video.videoWidth > 0);
    video.onerror = () => done(false);
    video.src = url;
  });
  const redWebm = async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const file = await recordRed(24 * attempt);
      if (await decodes(file)) return file;
      console.log(`빨간 WebM ${attempt}번째가 풀리지 않아 다시 만듦 (${file.size} B)`);
    }
    throw new Error("FAIL: 테스트용 WebM을 만들지 못함(MediaRecorder)");
  };
  const chipTag = () => $("studioChannel0")?.querySelector(".chip-tag")?.textContent;
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    if (!wasRunning) studio.togglePlayback();
    studio.open();

    // 1) 연결만 하고 켜지 않으면 빈 텍스처(크기 0)를 읽고, 칩은 '꺼짐'
    test(studio.setProject(project({ media: "webcam" })), "웹캠 채널 연결(켜기 전)");
    await frames(3);
    test(pixel()[0] === 0 && pixel()[1] === 0, `켜기 전 iChannelResolution = 0: ${pixel()}`);
    test(r.mediaState("webcam").state === "off", "켜기 전 상태 off");
    // 칩은 Buffer A 탭에서 보인다
    $("studioTab-A").click();
    await frames(1);
    test(chipTag() === "꺼짐" && $("studioChannel0").dataset.state === "off", `칩: 꺼짐 (${chipTag()})`);

    // 2) 웹캠: 켜면 영상 크기와 픽셀이 들어오고, 칩이 켜짐으로 바뀐다
    test(await r.startMedia("webcam"), "웹캠 켜기");
    await until(() => pixel()[0] > 0, "웹캠 프레임");
    const cam = r.mediaState("webcam");
    test(cam.state === "on" && cam.width > 0 && pixel()[0] === cam.width && pixel()[1] === cam.height, `웹캠 ${cam.width}×${cam.height} → iChannelResolution ${pixel()}`);
    test($("studioChannel0").dataset.state === "on" && chipTag() === "웹캠", `칩: 켜짐 (${chipTag()})`);

    // 3) 연결을 끊은 구성을 적용하면 웹캠이 꺼진다(카메라를 놓는다)
    test(studio.setProject(project(null)), "채널 없는 구성 적용");
    test(r.mediaState("webcam").state === "off", "연결이 없어진 웹캠은 꺼진다");

    // 4) 마이크: 512×2 오디오 텍스처, 파형 행(y = 0.75)은 0~1 안
    test(studio.setProject(project({ media: "mic" }, "texture(iChannel0, vec2(0.5, 0.75)).r")), "마이크 채널 연결");
    test(await r.startMedia("mic"), "마이크 켜기");
    await until(() => pixel()[0] === 512, "마이크 텍스처");
    test(pixel()[1] === 2 && pixel()[2] >= 0 && pixel()[2] <= 1, `마이크 512×2 · 파형 값 ${pixel()[2]}`);

    // 5) 오디오 파일: 440Hz 사인파의 주파수 칸(y = 0.25)이 크게 올라온다
    const rate = new AudioContext().sampleRate, bin = Math.round(440 / (rate / 1024));
    test(studio.setProject(project({ media: "audio" }, `texture(iChannel0, vec2((${bin}.0 + 0.5) / 512.0, 0.25)).r`)), "오디오 파일 채널 연결");
    test(r.mediaState("mic").state === "off", "마이크는 연결이 없어져 꺼진다");
    test(await r.startMedia("audio", sineWav()), "오디오 파일 켜기");
    await until(() => pixel()[2] > 0.5, `440Hz 칸(${bin})의 주파수 크기`);
    test(r.mediaState("audio").name === "sine440.wav", "상태에 파일 이름");

    // 5-1) 고른 파일은 브라우저에 보관된다: 끈 뒤 파일을 고르지 않고 '보관한 파일'로 다시 켠다
    await new Promise(resolve => setTimeout(resolve, 200)); // 보관(IndexedDB 쓰기)은 기다리지 않고 진행된다
    const stored = await new Promise((resolve, reject) => {
      const open = indexedDB.open("shader-studio-media-v1");
      open.onsuccess = () => { const req = open.result.transaction("files").objectStore("files").get("audio"); req.onsuccess = () => { open.result.close(); resolve(req.result); }; req.onerror = () => reject(req.error); };
      open.onerror = () => reject(open.error);
    });
    test(stored?.name === "sine440.wav" && stored.blob.size > 80000, `IndexedDB에 오디오 파일 보관: ${stored?.name} ${stored?.blob?.size}`);
    r.stopMedia("audio");
    test(r.mediaState("audio").state === "off" && r.mediaState("audio").savedName === "sine440.wav", "끈 뒤에도 보관한 파일 이름을 안다");
    test(await r.startSavedMedia("audio"), "보관한 파일로 다시 켜기");
    await until(() => pixel()[2] > 0.5, "다시 켠 440Hz");
    test(r.mediaState("audio").name === "sine440.wav", "다시 켠 파일 이름");

    // 6) 영상 파일: 빨간 WebM의 크기와 색
    test(studio.setProject(project({ media: "video" })), "영상 파일 채널 연결");
    test(await r.startMedia("video", await redWebm()), "영상 파일 켜기");
    await until(() => pixel()[0] === 160, "영상 프레임", 15000);
    test(pixel()[1] === 90 && pixel()[2] > 0.8, `영상 160×90 · 빨강 ${pixel()[2]}`);

    // 7) 종류에 맞지 않는 파일은 거부한다
    let refused = null;
    try { await r.startMedia("video", new File(["x"], "note.txt", { type: "text/plain" })); } catch (error) { refused = error; }
    test(/영상 파일이 아닙니다/.test(refused?.message || ""), `잘못된 파일 거부: ${refused?.message}`);
  } finally {
    studio.setProject(before);
    for (const kind of ["mic", "audio", "webcam", "video"]) r.stopMedia(kind);
    studio.close();
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("미디어 입력 채널 회귀 테스트 완료");
})();
