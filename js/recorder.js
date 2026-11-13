// 뷰포트 녹화: 렌더된 화면을 MediaRecorder로 녹화해 WebM(지원하지 않으면 MP4) 파일로 내려받는다.
// WebGL 캔버스를 바로 captureStream()하면 새로 그릴 때만 프레임이 생겨, 일시정지 중이거나 렌더가 아주 느리면 영상이 비었다.
// 그런데 이 캔버스는 preserveDrawingBuffer:false라 그린 직후가 아니면 내용을 읽을 수 없다(복사하면 검게 나온다).
// 그래서 렌더러가 그린 직후(renderer.onFrame) 2D 캔버스(mirror)에 옮겨 그리고, 그 2D 캔버스를 녹화한다:
//   · 그릴 때마다 mirror에 복사 → track.requestFrame()으로 한 프레임
//   · 한동안 새로 그리지 않으면(일시정지) KEEPALIVE_MS마다 mirror의 마지막 화면을 다시 넣는다 → 멈춘 화면도 녹화된다
// 시작할 때는 renderer.redraw()로 지금 화면을 한 번 그린다(일시정지 중 스크린샷과 같은 방식).
// 첫 렌더 프레임을 mirror에 옮긴 뒤에만 스트림·인코더를 만든다. 그 전에는 캔버스 크기와 내용이 아직 초기값일 수 있다.
// MediaRecorder는 start() 뒤 인코더를 준비하고 나서야 실제로 녹화를 시작한다(start 이벤트). 느린 컴퓨터에서는 1초 넘게 걸리고,
// 그 전에 넣은 프레임은 버려진다. 그래서 경과 시간은 start 이벤트부터 세고, 그때 지금 화면을 첫 프레임으로 넣는다.
// 그 전에 중지를 누르면 시작된 뒤 MIN_RECORD_MS만큼 담고 멈춘다(빈 파일이 되지 않게).
// 첫 렌더 프레임이 오기 전에 누른 중지는 담을 것이 없으므로 파일 없이 바로 취소한다.
// 녹화 크기는 캔버스의 실제 렌더 해상도(렌더링 › 해상도 배율·최대 픽셀 수)를 따른다.
// 소리가 있을 때: 오디오 코덱까지 적은 형식을 먼저 고른다.
const AUDIO_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
];
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

const pickMimeType = (Recorder = globalThis.MediaRecorder, audio = false) =>
  (audio ? AUDIO_MIME_TYPES : MIME_TYPES).find(
    type => typeof Recorder?.isTypeSupported === "function" && Recorder.isTypeSupported(type)
  ) || "";

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
// audioTracks(): 녹화에 함께 담을 소리 트랙(renderer.mediaAudioTracks — 켜진 오디오 파일 · 마이크). 녹화를 시작할 때 한 번 읽는다.
// onChange({ recording, ready, elapsed }) · onSave(blob, name) · onError(message)
//   ready=false: 첫 렌더 프레임이나 인코더를 기다리는 중(경과 시간 0)
const create = ({
  canvas,
  onFrame = () => () => {},
  redraw = () => {},
  audioTracks = () => [],
  onChange = () => {},
  onSave,
  onError = () => {},
  Recorder = globalThis.MediaRecorder,
  createCanvas = () => document.createElement("canvas"),
}) => {
  let recorder = null,
    stream = null,
    unsubscribe = null,
    pending = false,
    chunks = [],
    startedAt = 0,
    timer = 0,
    keepalive = 0,
    stopTimer = 0,
    ready = false,
    stopRequested = false,
    discard = false;
  const now = () => performance.now();
  const isRecording = () => pending || !!recorder;
  const notify = () =>
    onChange({
      recording: isRecording(),
      ready: !!recorder && ready,
      elapsed: recorder && ready ? now() - startedAt : 0,
    });
  // 경과 시간 표시: 녹화가 실제로 시작된 순간부터 1초가 넘어가는 시점마다 갱신한다(0:00 → 0:01 → …가 제때 바뀌게).
  const tick = () => {
    notify();
    if (!recorder || !ready) return;
    const elapsed = now() - startedAt;
    timer = setTimeout(tick, 1000 - (elapsed % 1000) + 5);
  };
  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(keepalive);
    clearTimeout(stopTimer);
    timer = keepalive = stopTimer = 0;
    unsubscribe?.();
    unsubscribe = null;
    for (const track of stream?.getTracks?.() || []) track.stop();
    stream = null;
    recorder = null;
    pending = false;
    notify();
  };
  const start = () => {
    if (isRecording()) return false;
    if (typeof Recorder !== "function") {
      onError("이 브라우저는 캔버스 녹화(MediaRecorder)를 지원하지 않습니다.");
      return false;
    }
    // 매 프레임 읽어 녹화하는 mirror는 CPU 비트맵을 선호한다. Chromium 130 + SwiftShader의
    // 가속 2D 경로에서는 정지 화면을 다시 그려도 실제 캡처가 첫 프레임에서 멈출 수 있다.
    const mirror = createCanvas(),
      context = mirror.getContext?.("2d", { willReadFrequently: true });
    if (!context || typeof mirror.captureStream !== "function") {
      onError("이 브라우저는 캔버스 녹화를 지원하지 않습니다.");
      return false;
    }
    chunks = [];
    discard = stopRequested = ready = false;
    pending = true;
    let track = null;
    const push = () => {
      if (!recorder) return;
      if (track?.readyState === "ended") return;
      track?.requestFrame?.();
      // 마지막 프레임부터 예약한다. interval에서 시간차를 재면 249.9ms 같은 경계에서 한 주기를 건너뛸 수 있다.
      clearTimeout(keepalive);
      keepalive = setTimeout(() => {
        // 바뀌지 않은 캔버스도 다시 그려 브라우저가 캡처를 건너뛰지 않게 한다.
        context.drawImage(mirror, 0, 0);
        push();
      }, KEEPALIVE_MS);
    };
    const begin = () => {
      try {
        stream = mirror.captureStream(0); // 첫 실제 화면과 그 크기가 준비된 뒤에 만든다.
        // 소리: 켜진 오디오가 있으면 그 트랙을 복제해 담는다(녹화를 멈출 때 원본은 그대로 둔다).
        const sound = (audioTracks() || []).map(item => item.clone());
        for (const item of sound) stream.addTrack(item);
        const mimeType = pickMimeType(Recorder, sound.length > 0);
        recorder = new Recorder(stream, {
          ...(mimeType ? { mimeType } : {}),
          videoBitsPerSecond: BITRATE,
          ...(sound.length ? { audioBitsPerSecond: 192_000 } : {}),
        });
        pending = false;
        track = stream.getVideoTracks?.()[0];
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
          else cleanup();
        });
        active.addEventListener("start", () => {
          if (recorder !== active) return;
          ready = true;
          startedAt = now();
          context.drawImage(mirror, 0, 0);
          push();
          clearTimeout(timer);
          tick();
          if (stopRequested) stopTimer = setTimeout(() => active.state === "recording" && active.stop(), MIN_RECORD_MS);
        });
        active.start(1000); // 1초마다 조각을 받아 둔다(긴 녹화에서도 메모리를 한 번에 크게 쓰지 않게).
        return true;
      } catch (error) {
        cleanup();
        onError(`녹화를 시작하지 못했습니다: ${error.message}`);
        return false;
      }
    };
    unsubscribe = onFrame((source = canvas) => {
      if (!isRecording()) return;
      // 렌더 해상도가 바뀌면 녹화 크기도 따라간다(인코더가 크기 변화를 처리한다).
      if (mirror.width !== source.width || mirror.height !== source.height) {
        mirror.width = Math.max(2, source.width);
        mirror.height = Math.max(2, source.height);
      }
      context.drawImage(source, 0, 0);
      if (pending && !begin()) return;
      push();
    });
    // 일시정지 중이어도 지금 화면을 첫 프레임으로. 컨텍스트 손실 등으로 그릴 수 없으면 준비 중에 머무르지 않는다.
    if (redraw() === false) {
      cleanup();
      onError("현재 화면을 녹화할 수 없습니다.");
      return false;
    }
    notify();
    return isRecording();
  };
  const stop = () => {
    if (!isRecording() || stopRequested) return false;
    // 첫 렌더 프레임이 아직 오지 않았으면 담을 것도 인코더도 없다. 바로 취소한다.
    // (기다리면 프레임이 끝내 오지 않을 때 — 예: 컨텍스트 손실 — '준비'에서 빠져나올 수 없다)
    if (pending) {
      cleanup();
      return true;
    }
    // 인코더가 준비 중이면 시작된 뒤 잠깐 담고 멈춘다(start 이벤트에서). 버리는 경우(dispose)는 바로 멈춘다.
    if (!ready) {
      stopRequested = true;
      return true;
    }
    if (recorder.state === "inactive") return false;
    recorder.stop();
    return true;
  };
  const toggle = () => (isRecording() ? stop() : start());
  const dispose = () => {
    if (!isRecording()) return;
    discard = true;
    if (pending) cleanup();
    else if (recorder.state !== "inactive") recorder.stop();
  };
  return { start, stop, toggle, dispose, isRecording };
};

export { create, supported, pickMimeType, formatElapsed, fileName };
