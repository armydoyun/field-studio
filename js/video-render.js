// 영상 렌더링(오프라인): 실시간 녹화(recorder.js)와 달리 시간을 프레임마다 정확히 정해 한 장씩 그려 파일로 만든다.
//   · 프레임 i의 uTime = 시작 + i / fps, uDeltaTime = 1 / fps. 화면이 느려도 결과 영상은 끊기지 않는다.
//   · 크기는 화면과 상관없이 지정한 너비×높이(renderer.beginOffline)로 그린다.
//   · WebM: WebCodecs VideoEncoder(VP9/VP8)로 인코딩하고, 아래의 작은 WebM(Matroska) 먹서로 파일을 만든다(외부 의존성 없음).
//   · PNG 연속 이미지: 프레임마다 PNG를 만들어 압축 없는(store) ZIP 한 파일로 묶는다. 편집 프로그램·ffmpeg용.
//   · 버퍼 패스(피드백 시뮬레이션)가 있으면 시작 시간 전까지의 프레임을 먼저 그려(저장하지 않음) 상태를 쌓는다.
// 순수 함수(normalizeSettings · createWebmMuxer · createZipWriter · crc32)는 DOM·GPU 없이 node 테스트에서 검사한다.

const FORMATS = Object.freeze({
  "webm-vp9": {
    label: "WebM · VP9",
    ext: "webm",
    codecId: "V_VP9",
    codecs: ["vp09.00.51.08", "vp09.00.41.08", "vp09.00.10.08"],
  },
  "webm-vp8": { label: "WebM · VP8", ext: "webm", codecId: "V_VP8", codecs: ["vp8"] },
  png: { label: "PNG 연속 이미지 (ZIP)", ext: "zip" },
});
// 품질: 픽셀·프레임당 비트 수. 셰이더의 세밀한 무늬·그라디언트는 일반 영상보다 비트가 많이 든다.
const QUALITY = Object.freeze({ standard: 0.08, high: 0.15, max: 0.3 });
const LIMITS = Object.freeze({
  maxDuration: 600, // 초
  maxStart: 86400,
  minFps: 1,
  maxFps: 120,
  minSize: 16,
  maxZipFrames: 65535, // ZIP64 없이 담을 수 있는 파일 수
  maxZipBytes: 0xffffffff - 1024 * 1024,
});
const KEYFRAME_SECONDS = 2; // 키프레임 간격 = WebM 클러스터 길이(탐색 단위)

// 입력값을 검사해 렌더링 설정으로 만든다. 잘못된 값은 RangeError. limit = 이 GPU가 그릴 수 있는 최대 변 길이.
const normalizeSettings = (raw, { limit = 4096 } = {}) => {
  const format = raw.format ?? "webm-vp9";
  if (!Object.hasOwn(FORMATS, format)) throw new RangeError(`지원하지 않는 형식입니다: ${format}`);
  const quality = raw.quality ?? "high";
  if (!Object.hasOwn(QUALITY, quality)) throw new RangeError(`지원하지 않는 품질입니다: ${quality}`);
  const start = Number(raw.start ?? 0),
    duration = Number(raw.duration),
    fps = Number(raw.fps);
  if (!Number.isFinite(start) || start < 0 || start > LIMITS.maxStart)
    throw new RangeError(`시작 시간은 0~${LIMITS.maxStart}초여야 합니다.`);
  if (!Number.isFinite(duration) || duration <= 0 || duration > LIMITS.maxDuration)
    throw new RangeError(`길이는 0초 초과 ${LIMITS.maxDuration}초 이하여야 합니다.`);
  if (!Number.isInteger(fps) || fps < LIMITS.minFps || fps > LIMITS.maxFps)
    throw new RangeError(`FPS는 ${LIMITS.minFps}~${LIMITS.maxFps} 사이의 정수여야 합니다.`);
  let width = Number(raw.width),
    height = Number(raw.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new RangeError("너비와 높이는 정수여야 합니다.");
  if (Math.min(width, height) < LIMITS.minSize || Math.max(width, height) > limit)
    throw new RangeError(`크기는 ${LIMITS.minSize}~${limit}px이어야 합니다.`);
  // VP8·VP9(4:2:0)는 짝수 크기만 받는다.
  if (format !== "png") {
    width -= width % 2;
    height -= height % 2;
  }
  const frames = Math.max(1, Math.round(duration * fps));
  if (format === "png" && frames > LIMITS.maxZipFrames)
    throw new RangeError(`PNG 연속 이미지는 ${LIMITS.maxZipFrames}장까지만 만들 수 있습니다.`);
  const bitrate = Math.round(Math.min(200e6, Math.max(1e6, width * height * fps * QUALITY[quality])));
  return { format, quality, start, duration: frames / fps, fps, width, height, frames, bitrate };
};
// 대략의 파일 크기(바이트). PNG는 그림에 따라 크게 달라서 픽셀당 1.5바이트로 어림한다.
const estimateBytes = s => (s.format === "png" ? s.frames * s.width * s.height * 1.5 : (s.bitrate / 8) * s.duration);

// ---- WebM(Matroska) 먹서 ----
// EBML: ID 바이트 + 길이(가변 길이 정수) + 내용. 모든 청크를 모은 뒤 한 번에 쓰므로 길이를 미리 안다.
const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
};
const idBytes = id => {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Uint8Array.from(out);
};
// 길이: 1~8바이트 가변 길이 정수. 모든 비트가 1인 값은 "길이 모름"이라 쓰지 않는다.
const vint = n => {
  for (let k = 1; k <= 8; k++)
    if (n < 2 ** (7 * k) - 1) {
      const out = new Uint8Array(k);
      let v = n;
      for (let i = k - 1; i >= 0; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
      }
      out[0] |= 1 << (8 - k);
      return out;
    }
  throw new RangeError("EBML 길이가 너무 큽니다.");
};
const uint = (n, width = 0) => {
  const out = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  while (out.length < Math.max(1, width)) out.unshift(0);
  return Uint8Array.from(out);
};
const float64 = n => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, n);
  return out;
};
const ascii = text => Uint8Array.from(text, c => c.charCodeAt(0) & 0x7f);
const sizeOf = parts => parts.reduce((sum, p) => sum + (p.byteLength ?? p.size), 0);
// 요소 하나 = [ID, 길이, ...내용 조각]. 조각은 Uint8Array 또는 Blob(인코딩된 프레임 데이터를 복사하지 않으려고).
const element = (id, children) => {
  const body = children.flat();
  return [idBytes(id), vint(sizeOf(body)), ...body];
};

// codecId: "V_VP9" · "V_VP8". addChunk({ type: "key"|"delta", timestamp: µs, data: Uint8Array }) · finish() → Blob 조각 배열
const createWebmMuxer = ({ codecId, width, height, fps }) => {
  const clusters = [];
  let current = null,
    lastMs = 0,
    count = 0;
  const addChunk = ({ type, timestamp, data }) => {
    const ms = Math.round(timestamp / 1000),
      key = type === "key";
    if (!count && !key) throw new Error("첫 프레임은 키프레임이어야 합니다.");
    if (count && ms < lastMs) throw new Error("프레임 시간이 거꾸로 갑니다.");
    // 키프레임마다(또는 상대 시간이 int16을 넘기 전에) 새 클러스터를 연다.
    if (!current || key || ms - current.ms > 32000) {
      current = { ms, key, blocks: [] };
      clusters.push(current);
    }
    const rel = ms - current.ms,
      head = new Uint8Array(4);
    head[0] = 0x81; // 트랙 번호 1 (가변 길이 정수)
    head[1] = (rel >> 8) & 0xff;
    head[2] = rel & 0xff;
    head[3] = key ? 0x80 : 0;
    current.blocks.push(element(ID.SimpleBlock, [head, data]));
    lastMs = ms;
    count++;
  };
  const finish = () => {
    if (!count) throw new Error("인코딩된 프레임이 없습니다.");
    const header = element(ID.EBML, [
      element(ID.EBMLVersion, [uint(1)]),
      element(ID.EBMLReadVersion, [uint(1)]),
      element(ID.EBMLMaxIDLength, [uint(4)]),
      element(ID.EBMLMaxSizeLength, [uint(8)]),
      element(ID.DocType, [ascii("webm")]),
      element(ID.DocTypeVersion, [uint(2)]),
      element(ID.DocTypeReadVersion, [uint(2)]),
    ]);
    const durationMs = (count * 1000) / fps;
    const info = element(ID.Info, [
      element(ID.TimestampScale, [uint(1_000_000)]), // 1ms 단위
      element(ID.Duration, [float64(durationMs)]),
      element(ID.MuxingApp, [ascii("FIELD Studio")]),
      element(ID.WritingApp, [ascii("FIELD Studio")]),
    ]);
    const tracks = element(ID.Tracks, [
      element(ID.TrackEntry, [
        element(ID.TrackNumber, [uint(1)]),
        element(ID.TrackUID, [uint(1)]),
        element(ID.TrackType, [uint(1)]), // 비디오
        element(ID.FlagLacing, [uint(0)]),
        element(ID.CodecID, [ascii(codecId)]),
        element(ID.DefaultDuration, [uint(Math.round(1e9 / fps))]),
        element(ID.Video, [element(ID.PixelWidth, [uint(width)]), element(ID.PixelHeight, [uint(height)])]),
      ]),
    ]);
    const clusterParts = clusters.map(c => element(ID.Cluster, [element(ID.Timestamp, [uint(c.ms)]), ...c.blocks]));
    // Cues(탐색 색인)는 클러스터 앞에 둔다. 위치 값을 8바이트 고정 폭으로 써서 Cues 크기가 위치에 따라 바뀌지 않게 한다.
    const keyed = clusters.map((c, i) => ({ c, i })).filter(({ c }) => c.key);
    const cuesFor = positions =>
      element(
        ID.Cues,
        keyed.map(({ c }, n) =>
          element(ID.CuePoint, [
            element(ID.CueTime, [uint(c.ms, 8)]),
            element(ID.CueTrackPositions, [
              element(ID.CueTrack, [uint(1)]),
              element(ID.CueClusterPosition, [uint(positions[n], 8)]),
            ]),
          ])
        )
      );
    const cuesSize = sizeOf(cuesFor(keyed.map(() => 0))),
      offsets = [];
    let at = sizeOf(info) + sizeOf(tracks) + cuesSize;
    for (const parts of clusterParts) {
      offsets.push(at);
      at += sizeOf(parts);
    }
    const segment = element(ID.Segment, [info, tracks, cuesFor(keyed.map(({ i }) => offsets[i])), ...clusterParts]);
    return [...header, ...segment];
  };
  return { addChunk, finish, frames: () => count };
};

// ---- ZIP(압축 없음) ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (bytes, crc = 0) => {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
};
const createZipWriter = (date = new Date()) => {
  const parts = [],
    entries = [];
  let offset = 0;
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const header = (size, fields) => {
    const out = new Uint8Array(size),
      view = new DataView(out.buffer);
    let at = 0;
    for (const [bytes, value] of fields) {
      if (bytes === 4) view.setUint32(at, value, true);
      else view.setUint16(at, value, true);
      at += bytes;
    }
    return out;
  };
  // data: Uint8Array. 같은 내용을 Blob으로 넘기면(blob) 복사본 대신 그것을 담는다.
  const add = (name, data, blob = null) => {
    if (entries.length >= LIMITS.maxZipFrames) throw new RangeError("ZIP에 담을 수 있는 파일 수를 넘었습니다.");
    const nameBytes = new TextEncoder().encode(name),
      crc = crc32(data),
      size = data.byteLength;
    if (offset + size + 30 + nameBytes.length > LIMITS.maxZipBytes)
      throw new RangeError("ZIP이 4GB를 넘습니다. 길이·크기를 줄이세요.");
    const local = header(30, [
      [4, 0x04034b50],
      [2, 20],
      [2, 0x0800], // 파일 이름 UTF-8
      [2, 0], // 압축 없음
      [2, dosTime],
      [2, dosDate],
      [4, crc],
      [4, size],
      [4, size],
      [2, nameBytes.length],
      [2, 0],
    ]);
    parts.push(local, nameBytes, blob || data);
    entries.push({ nameBytes, crc, size, offset });
    offset += local.length + nameBytes.length + size;
  };
  const finish = () => {
    const start = offset;
    for (const e of entries) {
      const central = header(46, [
        [4, 0x02014b50],
        [2, 20],
        [2, 20],
        [2, 0x0800],
        [2, 0],
        [2, dosTime],
        [2, dosDate],
        [4, e.crc],
        [4, e.size],
        [4, e.size],
        [2, e.nameBytes.length],
        [2, 0],
        [2, 0],
        [2, 0],
        [2, 0],
        [4, 0],
        [4, e.offset],
      ]);
      parts.push(central, e.nameBytes);
      offset += central.length + e.nameBytes.length;
    }
    parts.push(
      header(22, [
        [4, 0x06054b50],
        [2, 0],
        [2, 0],
        [2, entries.length],
        [2, entries.length],
        [4, offset - start],
        [4, start],
        [2, 0],
      ])
    );
    return parts;
  };
  return { add, finish, count: () => entries.length };
};

const pad = (n, width = 2) => String(n).padStart(width, "0");
const fileName = (s, date = new Date()) =>
  `shader-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${s.width}x${s.height}-${s.fps}fps.${FORMATS[s.format].ext}`;
const frameName = i => `frame_${pad(i, 5)}.png`;

// 이 브라우저가 고를 수 있는 형식: WebCodecs가 그 코덱을 인코딩할 수 있으면 WebM, PNG는 항상.
// 결과: { "webm-vp9": "vp09.00.51.08" | null, "webm-vp8": "vp8" | null, png: "png" }
const probeFormats = async ({ width = 1920, height = 1080, fps = 30, Encoder = globalThis.VideoEncoder } = {}) => {
  const result = { png: "png" };
  for (const [format, spec] of Object.entries(FORMATS)) {
    if (!spec.codecs) continue;
    result[format] = null;
    if (typeof Encoder?.isConfigSupported !== "function") continue;
    for (const codec of spec.codecs)
      try {
        const { supported } = await Encoder.isConfigSupported({ codec, width, height, framerate: fps, bitrate: 8e6 });
        if (supported) {
          result[format] = codec;
          break;
        }
      } catch (_) {
        /* 이 코덱 문자열은 모른다: 다음 후보 */
      }
  }
  return result;
};

// 다음 작업으로 넘긴다(진행률 표시·취소 버튼이 반응하게). setTimeout(0)은 4ms씩 늦어져 MessageChannel을 쓴다.
const yieldTask = () =>
  new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
const abortError = () => Object.assign(new Error("영상 렌더링을 취소했습니다."), { name: "AbortError" });

// 렌더링 실행. settings는 normalizeSettings 결과. hasBuffers: 버퍼 패스가 있으면 시작 시간 전 프레임을 먼저 그린다.
// onProgress({ phase: "warmup"|"render"|"finish", done, total }). 끝나면 { blob, name, settings, codec }.
const render = async ({
  renderer,
  settings: s,
  hasBuffers = false,
  signal = null,
  onProgress = () => {},
  Encoder = globalThis.VideoEncoder,
  Frame = globalThis.VideoFrame,
  createCanvas = () => document.createElement("canvas"),
}) => {
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  check();
  let codec = null;
  if (s.format !== "png") {
    codec = (await probeFormats({ width: s.width, height: s.height, fps: s.fps, Encoder }))[s.format];
    if (!codec || typeof Frame !== "function")
      throw new Error(
        `이 브라우저는 ${FORMATS[s.format].label} 인코딩을 지원하지 않습니다. PNG 연속 이미지를 고르세요.`
      );
  }
  renderer.beginOffline({ width: s.width, height: s.height });
  let encoder = null;
  try {
    const mirror = createCanvas();
    mirror.width = s.width;
    mirror.height = s.height;
    const context = mirror.getContext("2d", { alpha: false });
    if (!context) throw new Error("2D Canvas를 사용할 수 없습니다.");
    const dt = 1 / s.fps,
      first = Math.round(s.start * s.fps);
    // 버퍼 상태 쌓기: 시작 시간 전의 프레임을 같은 간격으로 그린다(저장하지 않음).
    if (hasBuffers && first > 0)
      for (let j = 0; j < first; j++) {
        renderer.renderOfflineFrame({ time: Math.max(0, s.start - (first - j) * dt), delta: dt, frame: j });
        if (j % 4 === 3 || j === first - 1) {
          onProgress({ phase: "warmup", done: j + 1, total: first });
          await yieldTask();
          check();
        }
      }
    // uFrame은 버퍼가 없어도 "그 시간까지의 프레임 수"(시작 시간 × fps)부터 센다.
    const baseFrame = first;
    let failure = null,
      muxer = null,
      zip = null;
    if (codec) {
      muxer = createWebmMuxer({ codecId: FORMATS[s.format].codecId, width: s.width, height: s.height, fps: s.fps });
      encoder = new Encoder({
        output: chunk => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          try {
            muxer.addChunk({ type: chunk.type, timestamp: chunk.timestamp, data });
          } catch (error) {
            failure ??= error;
          }
        },
        error: error => {
          failure ??= error;
        },
      });
      encoder.configure({
        codec,
        width: s.width,
        height: s.height,
        framerate: s.fps,
        bitrate: s.bitrate,
        bitrateMode: "variable",
        latencyMode: "quality",
      });
    } else zip = createZipWriter();
    const gop = Math.max(1, Math.round(s.fps * KEYFRAME_SECONDS));
    const toBlob = () =>
      new Promise((resolve, reject) =>
        mirror.toBlob(blob => (blob ? resolve(blob) : reject(new Error("PNG 생성 실패"))), "image/png")
      );
    for (let i = 0; i < s.frames; i++) {
      check();
      if (failure) throw failure;
      const drawn = renderer.renderOfflineFrame({ time: s.start + i * dt, delta: dt, frame: baseFrame + i });
      // WebGL 캔버스는 그린 직후(같은 작업 안)에만 읽을 수 있으므로 곧바로 2D 캔버스에 옮긴다.
      context.drawImage(drawn, 0, 0);
      if (encoder) {
        const frame = new Frame(mirror, {
          timestamp: Math.round((i * 1e6) / s.fps),
          duration: Math.round(1e6 / s.fps),
        });
        try {
          encoder.encode(frame, { keyFrame: i % gop === 0 });
        } finally {
          frame.close();
        }
        // 인코더가 밀리면 기다린다(메모리에 원본 프레임이 쌓이지 않게).
        while (encoder.encodeQueueSize > 2 && !failure) await new Promise(resolve => setTimeout(resolve, 1));
      } else {
        const blob = await toBlob();
        zip.add(frameName(i), new Uint8Array(await blob.arrayBuffer()), blob);
      }
      onProgress({ phase: "render", done: i + 1, total: s.frames });
      await yieldTask();
    }
    check();
    onProgress({ phase: "finish", done: s.frames, total: s.frames });
    let parts;
    if (encoder) {
      await encoder.flush();
      if (failure) throw failure;
      encoder.close();
      encoder = null;
      if (muxer.frames() !== s.frames)
        throw new Error(`인코딩된 프레임 수가 맞지 않습니다 (${muxer.frames()}/${s.frames}).`);
      parts = muxer.finish();
    } else {
      const note = [
        `FIELD Studio PNG 연속 이미지 · ${s.width}×${s.height} · ${s.fps}fps · ${s.frames}장`,
        `시작 시간 ${s.start}초 · frame_00000.png = uTime ${s.start}`,
        "",
        "ffmpeg로 영상 만들기 예:",
        `ffmpeg -framerate ${s.fps} -i frame_%05d.png -c:v libx264 -pix_fmt yuv420p -crf 16 out.mp4`,
        "",
      ].join("\n");
      zip.add("README.txt", new TextEncoder().encode(note));
      parts = zip.finish();
    }
    const type = codec ? "video/webm" : "application/zip";
    return { blob: new Blob(parts, { type }), name: fileName(s), settings: s, codec };
  } finally {
    if (encoder && encoder.state !== "closed") encoder.close();
    renderer.endOffline();
  }
};

export {
  FORMATS,
  QUALITY,
  LIMITS,
  normalizeSettings,
  estimateBytes,
  createWebmMuxer,
  createZipWriter,
  crc32,
  vint,
  fileName,
  frameName,
  probeFormats,
  render,
};
