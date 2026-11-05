// 뷰포트 녹화: 캔버스를 MediaRecorder로 녹화해 WebM(지원하지 않으면 MP4) 파일로 내려받는다.
// canvas.captureStream()은 캔버스에 새 프레임이 그려질 때마다 영상 프레임을 만든다. 일시정지 중에는 화면이 멈춘 채로 녹화된다.
// 녹화 크기는 캔버스의 실제 렌더 해상도(렌더링 › 해상도 배율·최대 픽셀 수)를 따른다.
// 미리보기를 별도 창으로 분리해도(popout.js) 캔버스 요소가 그대로라 녹화가 이어진다.
const MIME_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1",
  "video/mp4",
];
const FPS = 60,
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

// onChange({ recording, elapsed }) · onSave(blob, name) · onError(message)
const create = ({ canvas, onChange = () => {}, onSave, onError = () => {}, Recorder = globalThis.MediaRecorder }) => {
  let recorder = null,
    stream = null,
    chunks = [],
    startedAt = 0,
    timer = 0,
    discard = false;
  const now = () => performance.now();
  const notify = () => onChange({ recording: !!recorder, elapsed: recorder ? now() - startedAt : 0 });
  const cleanup = () => {
    clearInterval(timer);
    timer = 0;
    for (const track of stream?.getTracks?.() || []) track.stop();
    stream = null;
    recorder = null;
    notify();
  };
  const start = () => {
    if (recorder) return false;
    if (!supported(canvas, Recorder)) {
      onError("이 브라우저는 캔버스 녹화(MediaRecorder)를 지원하지 않습니다.");
      return false;
    }
    try {
      const mimeType = pickMimeType(Recorder);
      stream = canvas.captureStream(FPS);
      recorder = new Recorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: BITRATE });
    } catch (error) {
      for (const track of stream?.getTracks?.() || []) track.stop();
      stream = recorder = null;
      onError(`녹화를 시작하지 못했습니다: ${error.message}`);
      return false;
    }
    chunks = [];
    discard = false;
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
    active.start(1000); // 1초마다 조각을 받아 둔다(긴 녹화에서도 메모리를 한 번에 크게 쓰지 않게).
    startedAt = now();
    timer = setInterval(notify, 500);
    notify();
    return true;
  };
  const stop = () => {
    if (!recorder || recorder.state === "inactive") return false;
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
