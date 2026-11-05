// 뷰포트 녹화: 렌더된 화면을 MediaRecorder로 녹화해 WebM(지원하지 않으면 MP4) 파일로 내려받는다.
// WebGL 캔버스를 바로 captureStream()하면 새로 그릴 때만 프레임이 생겨, 일시정지 중이거나 렌더가 아주 느리면 영상이 비었다.
// 그런데 이 캔버스는 preserveDrawingBuffer:false라 그린 직후가 아니면 내용을 읽을 수 없다(복사하면 검게 나온다).
// 그래서 렌더러가 그린 직후(renderer.onFrame) 2D 캔버스(mirror)에 옮겨 그리고, 그 2D 캔버스를 녹화한다:
//   · 그릴 때마다 mirror에 복사 → track.requestFrame()으로 한 프레임
//   · 한동안 새로 그리지 않으면(일시정지) KEEPALIVE_MS마다 mirror의 마지막 화면을 다시 넣는다 → 멈춘 화면도 녹화된다
// 시작할 때는 renderer.redraw()로 지금 화면을 한 번 그린다(일시정지 중 스크린샷과 같은 방식).
// MediaRecorder는 start() 뒤 인코더를 준비하고 나서야 실제로 녹화를 시작한다(start 이벤트). 느린 컴퓨터에서는 1초 넘게 걸리고,
// 그 전에 넣은 프레임은 버려진다. 그래서 경과 시간은 start 이벤트부터 세고, 그때 지금 화면을 첫 프레임으로 넣는다.
// 그 전에 중지를 누르면 시작된 뒤 MIN_RECORD_MS만큼 담고 멈춘다(빈 파일이 되지 않게).
// 녹화 크기는 캔버스의 실제 렌더 해상도(렌더링 › 해상도 배율·최대 픽셀 수)를 따른다.
const MIME_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1",
  "video/mp4",
];
const KEEPALIVE_MS = 250, // 이만큼 새로 그리지 않으면 마지막 화면을 다시 넣는다(멈춘 화면은 4fps)
  MIN_RECORD_MS = 300, // 준비 중에 중지를 눌렀을 때, 시작된 뒤 최소한 이만큼은 담는다
  BITRATE = 16_000_000; // 16 Mbps: 셰이더의 세밀한 무늬·그라디언트가 뭉개지지 않을 정도

const pickMimeType = (Recorder = globalThis.MediaRecorder) =>
  MIME_TYPES.find(type => typeof Recorder?.isTypeSupported === "function" && Recorder.isTypeSupported(type)) || "";

const supported = (canvas, Recorder = globalThis.MediaRecorder) =>
  typeof Recorder === "function" && typeof canvas?.captureStream === "function";

// 0:07 · 1:02:03
const formatElapsed = ms => {
  const total = Math.max(0, Math.floor(ms / 1000)),
    h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

const fileName = (mimeType, date = new Date()) => {
  const pad = n => String(n).padStart(2, "0"),
    stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `shader-${stamp}.${mimeType.startsWith("video/mp4") ? "mp4" : "webm"}`;
};

// source: { canvas, onFrame(listener) → 해제 함수, redraw() } — renderer.js의 공개 API
// onChange({ recording, ready, elapsed }) · onSave(blob, name) · onError(message)
//   ready=false: 녹화를 눌렀지만 인코더가 아직 준비 중(경과 시간 0)
const create = ({
  canvas,
  onFrame = () => () => {},
  redraw = () => {},
  onChange = () => {},
  onSave,
  onError = () => {},
  Recorder = globalThis.MediaRecorder,
  createCanvas = () => document.createElement("canvas"),
}) => {
  let recorder = null,
    stream = null,
    unsubscribe = null,
    lastFrameAt = 0,
    chunks = [],
    startedAt = 0,
    timer = 0,
    keepalive = 0,
    ready = false,
    stopRequested = false,
    discard = false;
  const now = () => performance.now();
  const notify = () =>
    onChange({ recording: !!recorder, ready: !!recorder && ready, elapsed: recorder && ready ? now() - startedAt : 0 });
  const cleanup = () => {
    clearInterval(timer);
    clearInterval(keepalive);
    timer = keepalive = 0;
    unsubscribe?.();
    unsubscribe = null;
    for (const track of stream?.getTracks?.() || []) track.stop();
    stream = null;
    recorder = null;
    notify();
  };
  const start = () => {
    if (recorder) return false;
    if (typeof Recorder !== "function") {
      onError("이 브라우저는 캔버스 녹화(MediaRecorder)를 지원하지 않습니다.");
      return false;
    }
    const mirror = createCanvas(),
      context = mirror.getContext?.("2d");
    if (!context || typeof mirror.captureStream !== "function") {
      onError("이 브라우저는 캔버스 녹화를 지원하지 않습니다.");
      return false;
    }
    try {
      const mimeType = pickMimeType(Recorder);
      mirror.width = Math.max(2, canvas.width);
      mirror.height = Math.max(2, canvas.height);
      stream = mirror.captureStream(0); // 프레임은 requestFrame()으로만 넣는다
      recorder = new Recorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: BITRATE });
    } catch (error) {
      for (const track of stream?.getTracks?.() || []) track.stop();
      stream = recorder = null;
      onError(`녹화를 시작하지 못했습니다: ${error.message}`);
      return false;
    }
    chunks = [];
    discard = stopRequested = ready = false;
    const active = recorder;
    active.addEventListener("dataavailable", event => {
      if (event.data?.size) chunks.push(event.data);
    });
    active.addEventListener("stop", () => {
      const type = active.mimeType || chunks[0]?.type || "video/webm",
        parts = chunks;
      chunks = [];
      cleanup();
      if (discard) return;
      if (!parts.length) return onError("녹화된 영상이 없습니다. 화면이 그려지는 동안 녹화해 주세요.");
      onSave(new Blob(parts, { type }), fileName(type));
    });
    active.addEventListener("error", event => {
      onError(`녹화 중 오류: ${event.error?.message || "알 수 없는 오류"}`);
      discard = true;
      if (active.state !== "inactive") active.stop();
    });
    const track = stream.getVideoTracks?.()[0],
      push = () => {
        if (track?.readyState === "ended") return;
        track?.requestFrame?.();
        lastFrameAt = now();
      };
    // 실제로 녹화가 시작된 순간: 시간을 0부터 세고, 지금 화면을 첫 프레임으로 넣는다.
    active.addEventListener("start", () => {
      if (recorder !== active) return;
      ready = true;
      startedAt = now();
      context.drawImage(mirror, 0, 0);
      push();
      notify();
      if (stopRequested) setTimeout(() => active.state === "recording" && active.stop(), MIN_RECORD_MS);
    });
    active.start(1000); // 1초마다 조각을 받아 둔다(긴 녹화에서도 메모리를 한 번에 크게 쓰지 않게).
    startedAt = now();
    timer = setInterval(notify, 500);
    unsubscribe = onFrame(source => {
      // 렌더 해상도가 바뀌면 녹화 크기도 따라간다(인코더가 크기 변화를 처리한다).
      if (mirror.width !== source.width || mirror.height !== source.height) {
        mirror.width = Math.max(2, source.width);
        mirror.height = Math.max(2, source.height);
      }
      context.drawImage(source, 0, 0);
      push();
    });
    keepalive = setInterval(() => {
      if (now() - lastFrameAt < KEEPALIVE_MS) return;
      // 바뀌지 않은 캔버스의 requestFrame()은 브라우저가 건너뛴다. 같은 그림을 제자리에 다시 그려 '바뀜'으로 만든다.
      context.drawImage(mirror, 0, 0);
      push();
    }, KEEPALIVE_MS);
    redraw(); // 일시정지 중이어도 지금 화면을 첫 프레임으로
    notify();
    return true;
  };
  const stop = () => {
    if (!recorder || recorder.state === "inactive" || stopRequested) return false;
    // 아직 준비 중이면 시작된 뒤 잠깐 담고 멈춘다(start 이벤트에서). 버리는 경우(dispose)는 바로 멈춘다.
    if (!ready && !discard) {
      stopRequested = true;
      return true;
    }
    recorder.stop();
    return true;
  };
  const toggle = () => (recorder ? stop() : start());
  const dispose = () => {
    if (!recorder) return;
    discard = true;
    stop();
  };
  return { start, stop, toggle, dispose, isRecording: () => !!recorder };
};

export { create, supported, pickMimeType, formatElapsed, fileName };
