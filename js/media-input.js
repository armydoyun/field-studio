// 미디어 입력 채널: 마이크 · 오디오 파일 · 웹캠 · 영상 파일. 채널에 {media: 종류}로 연결한다.
//   mic · audio  → 512×2 R8 텍스처(Shadertoy와 같은 배치): 0행(y = 0.25) = 주파수 크기(FFT, 낮은 음 → 높은 음),
//                  1행(y = 0.75) = 파형(0.5가 무음). 값은 0~1.
//   webcam · video → 영상 텍스처(RGBA). 이미지 채널처럼 위쪽이 v = 1이다.
// 마이크 · 카메라는 권한이 필요하고 파일은 저장하지 않으므로(이 탭에서만 쓴다), 프로젝트에는 연결만 남는다.
// 켜지지 않은 종류의 채널은 빈 텍스처(검정, iChannelResolution = 0)로 읽힌다.
// 오디오 텍스처를 만드는 일(audioRows)은 GPU와 무관한 순수 함수라 node에서 검사한다.
const KINDS = ["mic", "audio", "webcam", "video"];
const AUDIO_KINDS = new Set(["mic", "audio"]);
const AUDIO_WIDTH = 512,
  AUDIO_HEIGHT = 2;
const LABELS = { mic: "마이크", audio: "오디오 파일", webcam: "웹캠", video: "영상 파일" };
const FILE_TYPES = { audio: "audio/", video: "video/" };
const MAX_FILE = 512 * 1024 * 1024;

// 주파수 크기(앞 512개)와 파형(앞 512개)을 512×2 한 장으로. out을 주면 그 배열에 쓴다.
const audioRows = (frequency, wave, out = new Uint8Array(AUDIO_WIDTH * AUDIO_HEIGHT)) => {
  out.fill(0, 0, AUDIO_WIDTH);
  out.fill(128, AUDIO_WIDTH);
  out.set(frequency.subarray(0, AUDIO_WIDTH), 0);
  out.set(wave.subarray(0, AUDIO_WIDTH), AUDIO_WIDTH);
  return out;
};

// 고른 파일이 그 종류에 맞는지. 맞지 않으면 이유 문자열, 맞으면 "".
const fileProblem = (kind, file) => {
  if (!FILE_TYPES[kind]) return `${kind}은(는) 파일로 여는 입력이 아닙니다.`;
  if (!file) return "파일이 없습니다.";
  if (!String(file.type || "").startsWith(FILE_TYPES[kind]))
    return `${LABELS[kind]}이 아닙니다(${file.type || "형식을 알 수 없음"}).`;
  if (file.size > MAX_FILE) return "512MB 이하 파일만 쓸 수 있습니다.";
  return "";
};

// gl: WebGL2. onChange(): 켜짐 · 꺼짐 · 오류가 바뀔 때마다 부른다(편집기 칩을 다시 칠한다).
const create = (gl, { onChange = () => {} } = {}) => {
  const sources = new Map(); // 종류 → {state, name, error, element, stream, analyser, url, texture, width, height, …}
  let audioContext = null,
    disposed = false;
  const notify = () => {
    try {
      onChange();
    } catch (error) {
      console.warn("미디어 상태 알림 실패", error);
    }
  };
  const context = async () => {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error("이 브라우저는 Web Audio를 지원하지 않습니다.");
    audioContext ??= new AudioContextClass();
    if (audioContext.state === "suspended") await audioContext.resume();
    return audioContext;
  };
  const media = () => {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error(
        "이 브라우저(또는 http 주소)에서는 마이크 · 카메라를 쓸 수 없습니다. localhost나 https로 여세요."
      );
    return navigator.mediaDevices;
  };
  const release = entry => {
    if (!entry) return;
    entry.stopped = true;
    entry.stream?.getTracks().forEach(track => track.stop());
    if (entry.element) {
      entry.element.pause?.();
      entry.element.removeAttribute?.("src");
      entry.element.srcObject = null;
      entry.element.load?.();
    }
    try {
      entry.node?.disconnect();
      entry.analyser?.disconnect();
    } catch {
      // 이미 끊긴 노드
    }
    if (entry.url) URL.revokeObjectURL(entry.url);
    if (entry.texture) gl.deleteTexture(entry.texture);
  };
  const makeTexture = () => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  };
  // 오디오: 분석기(fftSize 1024 → 주파수 512개)를 만들고, 파일이면 스피커로도 보낸다(마이크는 되울림 때문에 보내지 않는다).
  const startAudio = async (entry, kind, file) => {
    const ctx = await context();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    entry.analyser = analyser;
    entry.frequency = new Uint8Array(analyser.frequencyBinCount);
    entry.wave = new Uint8Array(analyser.fftSize);
    entry.data = new Uint8Array(AUDIO_WIDTH * AUDIO_HEIGHT);
    entry.width = AUDIO_WIDTH;
    entry.height = AUDIO_HEIGHT;
    if (kind === "mic") {
      entry.stream = await media().getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (entry.stopped) return;
      entry.node = ctx.createMediaStreamSource(entry.stream);
      entry.node.connect(analyser);
    } else {
      const element = new Audio();
      entry.element = element;
      entry.url = URL.createObjectURL(file);
      element.src = entry.url;
      element.loop = true;
      entry.node = ctx.createMediaElementSource(element);
      entry.node.connect(analyser);
      analyser.connect(ctx.destination);
      await element.play();
    }
  };
  // 영상: <video>를 재생해 두고 새 프레임이 올 때마다 텍스처로 올린다.
  const startVideo = async (entry, kind, file) => {
    const element = document.createElement("video");
    entry.element = element;
    element.muted = true;
    element.playsInline = true;
    element.loop = kind === "video";
    if (kind === "webcam") {
      entry.stream = await media().getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (entry.stopped) return;
      element.srcObject = entry.stream;
    } else {
      entry.url = URL.createObjectURL(file);
      element.src = entry.url;
    }
    entry.fresh = true;
    // 새 프레임이 왔는지: requestVideoFrameCallback이 있으면 그것으로, 없으면 매 프레임 올린다.
    if (element.requestVideoFrameCallback) {
      const watch = () => {
        if (entry.stopped) return;
        entry.fresh = true;
        element.requestVideoFrameCallback(watch);
      };
      element.requestVideoFrameCallback(watch);
    } else entry.everyFrame = true;
    await element.play();
  };
  // 켜기. 같은 종류가 이미 켜져 있으면 끄고 새로 켠다. 파일 종류는 file이 있어야 한다.
  const start = async (kind, file = null) => {
    if (disposed) throw new Error("이미 폐기된 미디어 입력입니다.");
    if (!KINDS.includes(kind)) throw new Error(`알 수 없는 미디어 입력: ${kind}`);
    if (FILE_TYPES[kind]) {
      const problem = fileProblem(kind, file);
      if (problem) throw new Error(problem);
    }
    release(sources.get(kind));
    const entry = {
      kind,
      state: "starting",
      name: file?.name || LABELS[kind],
      error: "",
      width: 0,
      height: 0,
      started: performance.now(),
    };
    sources.set(kind, entry);
    notify();
    try {
      if (AUDIO_KINDS.has(kind)) await startAudio(entry, kind, file);
      else await startVideo(entry, kind, file);
      if (entry.stopped) return false;
      entry.state = "on";
      notify();
      return true;
    } catch (error) {
      if (entry.stopped) return false;
      release(entry);
      entry.stopped = false;
      entry.state = "error";
      entry.error =
        error?.name === "NotAllowedError"
          ? `${LABELS[kind]} 권한이 거부되었습니다. 브라우저 주소 표시줄에서 권한을 허용하세요.`
          : error?.name === "NotFoundError"
            ? `${LABELS[kind]} 장치를 찾지 못했습니다.`
            : String(error?.message || error);
      Object.assign(entry, { element: null, stream: null, analyser: null, node: null, url: null, texture: null });
      notify();
      throw new Error(entry.error);
    }
  };
  const stop = kind => {
    const entry = sources.get(kind);
    if (!entry) return false;
    release(entry);
    sources.delete(kind);
    notify();
    return true;
  };
  // 지금 쓰는 종류(kinds)만 남기고 끈다(연결을 모두 끊은 마이크 · 카메라가 켜진 채 남지 않게).
  const retain = kinds => {
    let changed = false;
    for (const kind of [...sources.keys()])
      if (!kinds.has(kind)) {
        release(sources.get(kind));
        sources.delete(kind);
        changed = true;
      }
    if (changed) notify();
  };
  // 프레임을 그리기 전에 부른다. kinds: 이번 프레임에 채널이 읽는 종류.
  const update = kinds => {
    for (const kind of kinds) {
      const entry = sources.get(kind);
      if (!entry || entry.state !== "on") continue;
      if (entry.analyser) {
        entry.analyser.getByteFrequencyData(entry.frequency);
        entry.analyser.getByteTimeDomainData(entry.wave);
        audioRows(entry.frequency, entry.wave, entry.data);
        const fresh = !entry.texture;
        entry.texture ??= makeTexture();
        gl.bindTexture(gl.TEXTURE_2D, entry.texture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        if (fresh)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, AUDIO_WIDTH, AUDIO_HEIGHT, 0, gl.RED, gl.UNSIGNED_BYTE, entry.data);
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, AUDIO_WIDTH, AUDIO_HEIGHT, gl.RED, gl.UNSIGNED_BYTE, entry.data);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      } else if (entry.element) {
        const video = entry.element;
        if (video.readyState < 2 || !video.videoWidth) continue; // HAVE_CURRENT_DATA 전
        if (!entry.fresh && !entry.everyFrame && entry.texture) continue;
        entry.fresh = false;
        const fresh = !entry.texture;
        entry.texture ??= makeTexture();
        gl.bindTexture(gl.TEXTURE_2D, entry.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // 이미지 채널과 같이 위쪽이 v = 1
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        entry.width = video.videoWidth;
        entry.height = video.videoHeight;
        if (fresh) notify(); // 크기를 처음 알았다
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  };
  const binding = kind => {
    const entry = sources.get(kind);
    return entry?.texture && entry.state === "on"
      ? { texture: entry.texture, width: entry.width, height: entry.height }
      : { texture: null, width: 0, height: 0 };
  };
  // uChannelTime: 재생 위치(초). 파일은 그 파일의 재생 위치, 마이크 · 웹캠은 켠 뒤 지난 시간, 꺼져 있으면 0.
  const time = kind => {
    const entry = sources.get(kind);
    if (!entry || entry.state !== "on") return 0;
    if (FILE_TYPES[kind] && entry.element) return entry.element.currentTime || 0;
    return (performance.now() - entry.started) / 1000;
  };
  // 편집기용 상태: 종류 → {state: "off" | "starting" | "on" | "error", name, error, width, height}
  const state = kind => {
    const entry = sources.get(kind);
    return entry
      ? { state: entry.state, name: entry.name, error: entry.error, width: entry.width, height: entry.height }
      : { state: "off", name: LABELS[kind], error: "", width: 0, height: 0 };
  };
  // 컨텍스트를 잃으면 텍스처는 사라진다. 다음 update에서 새로 만든다.
  const restore = () => {
    for (const entry of sources.values()) entry.texture = null;
  };
  const dispose = () => {
    disposed = true;
    for (const entry of sources.values()) release(entry);
    sources.clear();
    audioContext?.close?.().catch(() => {});
    audioContext = null;
  };
  return { start, stop, retain, update, binding, state, time, restore, dispose };
};

export { create, audioRows, fileProblem, KINDS, LABELS, AUDIO_WIDTH, AUDIO_HEIGHT };
