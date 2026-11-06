// 영상 렌더링(오프라인): 실시간 녹화(recorder.js)와 달리 시간을 프레임마다 정확히 정해 한 장씩 그려 파일로 만든다.
//   · 프레임 i의 uTime = 시작 + i / fps, uDeltaTime = 1 / fps. 화면이 느려도 결과 영상은 끊기지 않는다.
//   · 크기는 화면과 상관없이 지정한 너비×높이(renderer.beginOffline)로 그린다.
//   · WebM: WebCodecs VideoEncoder(VP9/VP8)로 인코딩하고, 아래의 작은 WebM(Matroska) 먹서로 파일을 만든다(외부 의존성 없음).
//   · PNG 연속 이미지: 프레임마다 PNG를 만들어 압축 없는(store) ZIP 한 파일로 묶는다(크면 ZIP64). 편집 프로그램·ffmpeg용.
//   · 버퍼 패스(피드백 시뮬레이션)가 있으면 시작 시간 전까지의 프레임을 먼저 그려(저장하지 않음) 상태를 쌓는다.
// 순수 함수(normalizeSettings · createWebmMuxer · createZipWriter · crc32)는 DOM·GPU 없이 node 테스트에서 검사한다.

// H.264 코덱 문자열은 레벨이 낮은 것부터: 이 크기·fps를 감당하는 가장 낮은 레벨을 고른다(브라우저가 레벨 한도를 검사한다).
const H264_LEVELS = ["28", "2a", "32", "33", "34", "3c", "3d", "3e"];
const FORMATS = Object.freeze({
  "mp4-h264": {
    label: "MP4 · H.264",
    ext: "mp4",
    container: "mp4",
    mime: "video/mp4",
    codecs: [...H264_LEVELS.map(level => `avc1.6400${level}`), ...H264_LEVELS.map(level => `avc1.4d00${level}`)],
    encoder: { avc: { format: "avc" } }, // 길이 접두 NAL(AVCC) + description = avcC
  },
  "webm-vp9": {
    label: "WebM · VP9",
    ext: "webm",
    container: "webm",
    mime: "video/webm",
    codecId: "V_VP9",
    codecs: ["vp09.00.51.08", "vp09.00.41.08", "vp09.00.10.08"],
  },
  "webm-vp8": {
    label: "WebM · VP8",
    ext: "webm",
    container: "webm",
    mime: "video/webm",
    codecId: "V_VP8",
    codecs: ["vp8"],
  },
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
});
const KEYFRAME_SECONDS = 2; // 키프레임 간격 = WebM 클러스터 길이(탐색 단위)

// 입력값을 검사해 렌더링 설정으로 만든다. 잘못된 값은 RangeError. limit = 이 GPU가 그릴 수 있는 최대 변 길이.
const normalizeSettings = (raw, { limit = 4096 } = {}) => {
  const format = raw.format ?? "mp4-h264";
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

// ---- MP4(ISO BMFF) 먹서 ----
// 조각(fragment) 없는 일반 MP4: ftyp · moov(앞쪽 — 받자마자 재생 가능) · mdat. 모든 프레임을 한 덩어리(chunk)에 담는다.
// 샘플 = AVCC(길이 접두 NAL) H.264 프레임. description = avcC(인코더의 decoderConfig.description).
// mdat이 4GB를 넘으면 64비트 크기(largesize)와 co64를 쓴다. B 프레임(표시 순서 ≠ 디코딩 순서)이면 ctts(v1, 부호 있음)를 쓴다.
const fourcc = text => ascii(text);
const be = (bytes, value) => {
  const out = new Uint8Array(bytes),
    view = new DataView(out.buffer);
  if (bytes === 8) view.setBigUint64(0, BigInt(value));
  else if (bytes === 4) view.setUint32(0, value >>> 0);
  else if (bytes === 2) view.setUint16(0, value & 0xffff);
  else out[0] = value & 0xff;
  return out;
};
const box = (type, children) => {
  const body = children.flat();
  return [be(4, 8 + sizeOf(body)), fourcc(type), ...body];
};
const fullBox = (type, version, flags, children) =>
  box(type, [be(1, version), be(1, flags >> 16), be(2, flags), ...children]);
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(v => be(4, v));
const createMp4Muxer = ({ width, height, fps }) => {
  const samples = [];
  let description = null;
  // 트랙 시간 단위: fps로 나누어떨어지는 값(90000이 되면 그것). 프레임 길이(delta)가 정수가 된다.
  const timescale = 90000 % fps === 0 ? 90000 : fps * 1000,
    delta = timescale / fps;
  const setDescription = bytes => {
    if (bytes && !description)
      description = new Uint8Array(
        ArrayBuffer.isView(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes
      );
  };
  const addChunk = ({ type, timestamp, data }) => {
    if (!samples.length && type !== "key") throw new Error("첫 프레임은 키프레임이어야 합니다.");
    samples.push({ key: type === "key", pts: Math.round((timestamp * timescale) / 1e6), data });
  };
  const finish = () => {
    if (!samples.length) throw new Error("인코딩된 프레임이 없습니다.");
    if (!description) throw new Error("H.264 설정(avcC)을 받지 못했습니다.");
    const count = samples.length,
      duration = count * delta,
      movieDuration = Math.round((duration * 1000) / timescale),
      dataSize = samples.reduce((sum, s) => sum + s.data.byteLength, 0),
      large = dataSize + 16 > 0xffffffff;
    // 디코딩 순서 = 인코더 출력 순서. 디코딩 시간 i·delta, 표시 시간 pts.
    const offsets = samples.map((s, i) => s.pts - i * delta),
      reordered = offsets.some(v => v !== 0);
    const ftyp = box("ftyp", [
      fourcc("isom"),
      be(4, 0x200),
      fourcc("isom"),
      fourcc("iso2"),
      fourcc("avc1"),
      fourcc("mp41"),
    ]);
    const stbl = chunkOffset =>
      box("stbl", [
        fullBox("stsd", 0, 0, [
          be(4, 1),
          box("avc1", [
            new Uint8Array(6),
            be(2, 1), // data_reference_index
            new Uint8Array(16),
            be(2, width),
            be(2, height),
            be(4, 0x00480000),
            be(4, 0x00480000),
            be(4, 0),
            be(2, 1), // frame_count
            new Uint8Array(32), // compressorname
            be(2, 0x18),
            be(2, 0xffff),
            box("avcC", [description]),
          ]),
        ]),
        fullBox("stts", 0, 0, [be(4, 1), be(4, count), be(4, delta)]),
        ...(reordered ? [fullBox("ctts", 1, 0, [be(4, count), ...offsets.flatMap(v => [be(4, 1), be(4, v)])])] : []),
        fullBox("stss", 0, 0, [
          be(4, samples.filter(s => s.key).length),
          ...samples.flatMap((s, i) => (s.key ? [be(4, i + 1)] : [])),
        ]),
        fullBox("stsc", 0, 0, [be(4, 1), be(4, 1), be(4, count), be(4, 1)]),
        fullBox("stsz", 0, 0, [be(4, 0), be(4, count), ...samples.map(s => be(4, s.data.byteLength))]),
        large
          ? fullBox("co64", 0, 0, [be(4, 1), be(8, chunkOffset)])
          : fullBox("stco", 0, 0, [be(4, 1), be(4, chunkOffset)]),
      ]);
    const moov = chunkOffset =>
      box("moov", [
        fullBox("mvhd", 0, 0, [
          be(4, 0),
          be(4, 0),
          be(4, 1000),
          be(4, movieDuration),
          be(4, 0x00010000),
          be(2, 0x0100),
          new Uint8Array(10),
          ...MATRIX,
          new Uint8Array(24),
          be(4, 2),
        ]),
        box("trak", [
          fullBox("tkhd", 0, 3, [
            be(4, 0),
            be(4, 0),
            be(4, 1),
            be(4, 0),
            be(4, movieDuration),
            new Uint8Array(8),
            be(2, 0),
            be(2, 0),
            be(2, 0),
            be(2, 0),
            ...MATRIX,
            be(4, width * 65536),
            be(4, height * 65536),
          ]),
          box("mdia", [
            fullBox("mdhd", 0, 0, [be(4, 0), be(4, 0), be(4, timescale), be(4, duration), be(2, 0x55c4), be(2, 0)]), // 언어 und
            fullBox("hdlr", 0, 0, [
              be(4, 0),
              fourcc("vide"),
              new Uint8Array(12),
              ascii("VideoHandler"),
              new Uint8Array(1),
            ]),
            box("minf", [
              fullBox("vmhd", 0, 1, [new Uint8Array(8)]),
              box("dinf", [fullBox("dref", 0, 0, [be(4, 1), fullBox("url ", 0, 1, [])])]),
              stbl(chunkOffset),
            ]),
          ]),
        ]),
      ]);
    // moov 크기는 덩어리 위치 값과 상관없다(고정 폭) → 한 번 재고 위치를 넣어 다시 만든다.
    const mdatHeader = large ? [be(4, 1), fourcc("mdat"), be(8, dataSize + 16)] : [be(4, dataSize + 8), fourcc("mdat")];
    const chunkOffset = sizeOf(ftyp) + sizeOf(moov(0)) + sizeOf(mdatHeader);
    return [...ftyp, ...moov(chunkOffset), ...mdatHeader, ...samples.map(s => s.data)];
  };
  return { addChunk, setDescription, finish, frames: () => samples.length, timescale };
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
// ZIP64: 파일이 65535개를 넘거나 위치가 4GB를 넘으면 ZIP64 기록을 더한다(force64면 항상 — 검사용).
// 파일 하나는 4GB 미만이어야 한다(PNG 한 장은 그보다 훨씬 작다).
const U16 = 0xffff,
  U32 = 0xffffffff;
const createZipWriter = ({ date = new Date(), force64 = false } = {}) => {
  const parts = [],
    entries = [];
  let offset = 0;
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  // fields: [바이트 수(2·4·8), 값] — 리틀 엔디언
  const header = fields => {
    const out = new Uint8Array(fields.reduce((sum, [bytes]) => sum + bytes, 0)),
      view = new DataView(out.buffer);
    let at = 0;
    for (const [bytes, value] of fields) {
      if (bytes === 8) view.setBigUint64(at, BigInt(value), true);
      else if (bytes === 4) view.setUint32(at, value, true);
      else view.setUint16(at, value, true);
      at += bytes;
    }
    return out;
  };
  // data: Uint8Array. 같은 내용을 Blob으로 넘기면(blob) 복사본 대신 그것을 담는다.
  const add = (name, data, blob = null) => {
    const nameBytes = new TextEncoder().encode(name),
      crc = crc32(data),
      size = data.byteLength;
    if (size >= U32) throw new RangeError("ZIP에 넣을 파일 하나가 4GB를 넘습니다.");
    const local = header([
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
      const big = force64 || e.offset >= U32,
        extra = big
          ? header([
              [2, 0x0001],
              [2, 8],
              [8, e.offset],
            ])
          : new Uint8Array(0);
      const central = header([
        [4, 0x02014b50],
        [2, big ? 45 : 20],
        [2, big ? 45 : 20],
        [2, 0x0800],
        [2, 0],
        [2, dosTime],
        [2, dosDate],
        [4, e.crc],
        [4, e.size],
        [4, e.size],
        [2, e.nameBytes.length],
        [2, extra.length],
        [2, 0],
        [2, 0],
        [2, 0],
        [4, 0],
        [4, big ? U32 : e.offset],
      ]);
      parts.push(central, e.nameBytes, extra);
      offset += central.length + e.nameBytes.length + extra.length;
    }
    const count = entries.length,
      size = offset - start,
      zip64 = force64 || count >= U16 || start >= U32 || size >= U32 || offset >= U32;
    if (zip64)
      parts.push(
        header([
          [4, 0x06064b50], // ZIP64 끝 레코드
          [8, 44],
          [2, 45],
          [2, 45],
          [4, 0],
          [4, 0],
          [8, count],
          [8, count],
          [8, size],
          [8, start],
        ]),
        header([
          [4, 0x07064b50], // ZIP64 끝 레코드 위치
          [4, 0],
          [8, offset],
          [4, 1],
        ])
      );
    parts.push(
      header([
        [4, 0x06054b50],
        [2, 0],
        [2, 0],
        [2, zip64 ? U16 : count],
        [2, zip64 ? U16 : count],
        [4, zip64 ? U32 : size],
        [4, zip64 ? U32 : start],
        [2, 0],
      ])
    );
    return parts;
  };
  return { add, finish, count: () => entries.length, zip64: () => force64 || entries.length >= U16 || offset >= U32 };
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
        const { supported } = await Encoder.isConfigSupported({
          codec,
          width,
          height,
          framerate: fps,
          bitrate: 8e6,
          ...(spec.encoder || {}),
        });
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
    // 타일 렌더링(renderer.renderOfflineFrameTiled)이 있으면 쓴다: 무거운 셰이더도 GPU 응답 제한에 걸리지 않게
    // 프레임을 나눠 그리고 타일마다 GPU를 기다린다. capture(canvas)는 다 그린 직후 같은 작업 안에서 불린다.
    const drawFrame = async (frame, capture) =>
      typeof renderer.renderOfflineFrameTiled === "function"
        ? renderer.renderOfflineFrameTiled(frame, capture)
        : capture(renderer.renderOfflineFrame(frame));
    // 버퍼 상태 쌓기: 시작 시간 전의 프레임을 같은 간격으로 그린다(저장하지 않음).
    if (hasBuffers && first > 0)
      for (let j = 0; j < first; j++) {
        await drawFrame({ time: Math.max(0, s.start - (first - j) * dt), delta: dt, frame: j }, () => {});
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
      const spec = FORMATS[s.format];
      muxer =
        spec.container === "mp4"
          ? createMp4Muxer({ width: s.width, height: s.height, fps: s.fps })
          : createWebmMuxer({ codecId: spec.codecId, width: s.width, height: s.height, fps: s.fps });
      encoder = new Encoder({
        output: (chunk, metadata) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          try {
            if (metadata?.decoderConfig?.description) muxer.setDescription?.(metadata.decoderConfig.description);
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
        ...(spec.encoder || {}),
      });
    } else zip = createZipWriter();
    const gop = Math.max(1, Math.round(s.fps * KEYFRAME_SECONDS));
    const toBlob = () =>
      new Promise((resolve, reject) =>
        mirror.toBlob(blob => (blob ? resolve(blob) : reject(new Error("PNG 생성 실패"))), "image/png")
      );
    let lastTiles = renderer.getOfflineTiling?.().tiles ?? 0;
    for (let i = 0; i < s.frames; i++) {
      check();
      if (failure) throw failure;
      // WebGL 캔버스는 그린 직후(같은 작업 안)에만 읽을 수 있으므로 곧바로 2D 캔버스에 옮긴다.
      await drawFrame({ time: s.start + i * dt, delta: dt, frame: baseFrame + i }, drawn =>
        context.drawImage(drawn, 0, 0)
      );
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
      // 이번 프레임을 몇 개의 타일로 나눠 그렸는지(무거운 셰이더일수록 많다)
      const tiling = renderer.getOfflineTiling?.(),
        tiles = tiling ? tiling.tiles - lastTiles : 1;
      lastTiles = tiling?.tiles ?? 0;
      onProgress({ phase: "render", done: i + 1, total: s.frames, tiles });
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
    const type = codec ? FORMATS[s.format].mime : "application/zip";
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
  createMp4Muxer,
  createZipWriter,
  crc32,
  vint,
  fileName,
  frameName,
  probeFormats,
  render,
};
