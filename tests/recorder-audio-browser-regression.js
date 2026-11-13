// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행 — 미디어 인코더를 쓰므로 하나씩).
// 녹화에 소리(recorder.js · media-input.js audioTracks): 오디오 파일 채널이 켜져 있으면 녹화 파일에 그 소리가 담긴다.
// 440Hz 사인파 WAV를 켜고 1초 남짓 녹화한 뒤, 내려받은 파일의 오디오를 디코딩해 소리가 있는지(진폭) 본다.
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const downloads = [], blobs = new Map(), originalUrl = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = blob => { const url = originalUrl.call(URL, blob); blobs.set(url, blob); return url; };
  HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: blobs.get(this.href) }); else originalClick.call(this); };
  const sine = () => {
    const rate = 44100, n = rate * 4, bytes = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (at, s) => [...s].forEach((ch, i) => bytes.setUint8(at + i, ch.charCodeAt(0)));
    text(0, "RIFF"); bytes.setUint32(4, 36 + n * 2, true); text(8, "WAVEfmt "); bytes.setUint32(16, 16, true);
    bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true); bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 2, true);
    bytes.setUint16(32, 2, true); bytes.setUint16(34, 16, true); text(36, "data"); bytes.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) bytes.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 20000), true);
    return new File([bytes.buffer], "tone.wav", { type: "audio/wav" });
  };
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    if (!wasRunning) studio.togglePlayback();
    test(studio.setProject({ image: "void mainImage(out vec4 c, in vec2 p) { c = vec4(texture(iChannel0, vec2(0.1, 0.25)).rrr, 1.0); }", passes: [], imageChannels: { 0: { media: "audio" } } }), "오디오 파일 채널");
    test(await r.startMedia("audio", sine()), "오디오 파일 켜기");
    test(r.mediaAudioTracks().length === 1, "녹화에 넣을 소리 트랙이 있다");
    $("recordButton").click();
    for (let i = 0; i < 300 && $("recordTime").textContent === "준비"; i++) await wait(50);
    await wait(1500);
    $("recordStop").click();
    for (let i = 0; i < 300 && !downloads.length; i++) await wait(50);
    const file = downloads[0];
    test(!!file?.blob && /\.(webm|mp4)$/.test(file.name), `녹화 파일: ${file?.name} ${file?.blob?.type}`);
    test(/opus|mp4a|webm|mp4/.test(file.blob.type), `오디오가 담길 수 있는 형식: ${file.blob.type}`);
    const audio = await new AudioContext().decodeAudioData(await file.blob.arrayBuffer());
    const data = audio.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    test(audio.duration > 0.5 && rms > 0.05, `녹화 파일의 소리: ${audio.duration.toFixed(2)}초 · RMS ${rms.toFixed(3)}`);
    test(r.mediaState("audio").state === "on" && r.mediaAudioTracks()[0].readyState === "live", "녹화를 멈춰도 오디오와 원래 트랙은 그대로");
  } finally {
    URL.createObjectURL = originalUrl;
    HTMLAnchorElement.prototype.click = originalClick;
    studio.setProject(before);
    r.stopMedia("audio");
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("녹화 소리 회귀 테스트 완료");
})();
