// 파라미터 연결: 파라미터 값을 소리 · MIDI · 흔들기(LFO) · 키프레임이 정하게 한다. DOM · GPU와 무관한 순수 함수.
// 연결 = { name: 파라미터, source, min, max, smooth, ...소스별 설정 }
//   source "audio": band = "bass"(20~250Hz) | "mid"(250~2kHz) | "treble"(2k~8kHz) | "volume"(파형 크기) → 0~1
//   source "midi" : cc(0~127), channel(0 = 모든 채널, 1~16) → 컨트롤러 값 0~1
//   source "lfo"  : shape = "sine" | "triangle" | "saw" | "square", period(초), phase(0~1) → 0~1(uTime 기준)
//   source "keys" : keys = [[시간, 값], …](시간 순), loop(초, 0이면 반복하지 않고 끝 값 유지), ease("linear" | "smooth")
//                   → 값 자체(min · max로 옮기지 않는다)
// 0~1 소스는 min + (max - min) × 값으로 옮긴다(키프레임은 값 그대로). smooth(초)만큼 부드럽게 따라간다(0이면 바로).
// 파라미터 타입이 int · uint면 반올림, bool이면 0.5 이상이 참. 벡터 · 행렬 · 램프는 연결할 수 없다.
// 렌더러가 프레임마다 evaluate로 값을 정하므로 영상 렌더링에서도 렌더 시간에 맞는다.
const SOURCES = ["audio", "midi", "lfo", "keys"];
const BANDS = Object.freeze({ bass: [20, 250], mid: [250, 2000], treble: [2000, 8000] });
const SHAPES = ["sine", "triangle", "saw", "square"];
const MAX_LINKS = 64,
  MAX_KEYS = 256;
const LINKABLE = new Set(["float", "int", "uint", "bool"]);

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const clamp01 = v => Math.min(1, Math.max(0, v));

// 저장소 · Pack에서 온 목록을 검사한 사본. 형식이 틀리면 던진다.
const validate = list => {
  if (!Array.isArray(list) || list.length > MAX_LINKS) throw new Error(`연결은 최대 ${MAX_LINKS}개입니다.`);
  const names = new Set();
  return list.map(raw => {
    if (!raw || typeof raw !== "object") throw new Error("연결 형식이 올바르지 않습니다.");
    const { name, source } = raw;
    if (typeof name !== "string" || !/^[A-Za-z_]\w*$/.test(name))
      throw new Error("연결할 파라미터 이름이 올바르지 않습니다.");
    if (names.has(name)) throw new Error(`${name}: 파라미터 하나에는 연결 하나만 둘 수 있습니다.`);
    names.add(name);
    if (!SOURCES.includes(source)) throw new Error(`${name}: 알 수 없는 연결 소스 ${source}`);
    const link = {
      name,
      source,
      min: finite(raw.min, 0),
      max: finite(raw.max, 1),
      smooth: Math.min(10, Math.max(0, finite(raw.smooth, 0))),
    };
    if (source === "audio") link.band = ["bass", "mid", "treble", "volume"].includes(raw.band) ? raw.band : "bass";
    if (source === "midi") {
      link.cc = Math.min(127, Math.max(0, Math.round(finite(raw.cc, 1))));
      link.channel = Math.min(16, Math.max(0, Math.round(finite(raw.channel, 0))));
    }
    if (source === "lfo") {
      link.shape = SHAPES.includes(raw.shape) ? raw.shape : "sine";
      link.period = Math.min(3600, Math.max(0.05, finite(raw.period, 4)));
      link.phase = clamp01(finite(raw.phase, 0));
    }
    if (source === "keys") {
      const keys = Array.isArray(raw.keys) ? raw.keys : [];
      if (keys.length > MAX_KEYS) throw new Error(`${name}: 키프레임은 최대 ${MAX_KEYS}개입니다.`);
      link.keys = keys
        .filter(k => Array.isArray(k) && k.length === 2 && Number.isFinite(k[0]) && Number.isFinite(k[1]))
        .map(([t, v]) => [Math.max(0, t), v])
        .sort((a, b) => a[0] - b[0]);
      link.loop = Math.max(0, finite(raw.loop, 0));
      link.ease = raw.ease === "linear" ? "linear" : "smooth";
    }
    return link;
  });
};

// 512칸 주파수 크기(0~255, AnalyserNode 배치)에서 대역 평균 0~1. rate = 샘플레이트(칸 너비 = rate / 1024).
const bandLevel = (frequency, [low, high], rate = 48000) => {
  const width = rate / 1024,
    from = Math.max(0, Math.floor(low / width)),
    to = Math.min(frequency.length - 1, Math.ceil(high / width));
  let sum = 0;
  for (let i = from; i <= to; i++) sum += frequency[i];
  return to >= from ? sum / ((to - from + 1) * 255) : 0;
};
// 파형(0~255, 128이 무음)의 RMS → 0~1(최대 진폭이면 약 0.7, 2배 해 1에서 자른다)
const waveLevel = wave => {
  let sum = 0;
  for (let i = 0; i < wave.length; i++) sum += ((wave[i] - 128) / 128) ** 2;
  return clamp01(Math.sqrt(sum / (wave.length || 1)) * 2);
};
// 오디오 텍스처 자료(512×2: 0행 주파수, 1행 파형)에서 네 값
const audioLevels = (rows, rate = 48000) => {
  const frequency = rows.subarray(0, 512),
    wave = rows.subarray(512, 1024);
  return {
    bass: bandLevel(frequency, BANDS.bass, rate),
    mid: bandLevel(frequency, BANDS.mid, rate),
    treble: bandLevel(frequency, BANDS.treble, rate),
    volume: waveLevel(wave),
  };
};

const lfo = (shape, period, phase, time) => {
  const x = (((time / period + phase) % 1) + 1) % 1;
  if (shape === "triangle") return x < 0.5 ? x * 2 : 2 - x * 2;
  if (shape === "saw") return x;
  if (shape === "square") return x < 0.5 ? 1 : 0;
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * x); // 0에서 시작해 반 주기에 1
};

// 키프레임 값(시간 t). loop > 0이면 t를 loop로 나눈 나머지에서 읽는다. 키가 없으면 null.
const keyValue = (keys, t, loop = 0, ease = "smooth") => {
  if (!keys.length) return null;
  const time = loop > 0 ? ((t % loop) + loop) % loop : t;
  if (time <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (time <= t1) {
      const [t0, v0] = keys[i - 1],
        span = t1 - t0,
        u = span > 0 ? (time - t0) / span : 1,
        k = ease === "linear" ? u : u * u * (3 - 2 * u);
      return v0 + (v1 - v0) * k;
    }
  }
  return keys[keys.length - 1][1];
};

// 소스의 지금 목표 값(파라미터 단위). inputs = { time, audio: {bass, mid, treble, volume} | null, midi(channel, cc) → 0~1 | null }
// 쓸 수 있는 입력이 없으면(소리가 꺼짐 · MIDI 신호 없음) null — 파라미터를 건드리지 않는다.
const target = (link, inputs) => {
  let unit = null;
  if (link.source === "keys") return keyValue(link.keys, inputs.time, link.loop, link.ease);
  if (link.source === "lfo") unit = lfo(link.shape, link.period, link.phase, inputs.time);
  else if (link.source === "audio") unit = inputs.audio ? inputs.audio[link.band] : null;
  else if (link.source === "midi") unit = inputs.midi ? inputs.midi(link.channel, link.cc) : null;
  return unit === null || unit === undefined ? null : link.min + (link.max - link.min) * unit;
};

// 부드럽게 따라가기: dt초 동안 이전 값에서 목표로(시간 상수 smooth). 처음(previous가 null)이면 목표 그대로.
const follow = (previous, goal, smooth, dt) =>
  previous === null || previous === undefined || !(smooth > 0)
    ? goal
    : goal + (previous - goal) * Math.exp(-dt / smooth);

// 파라미터 타입에 맞는 값: int · uint 반올림(uint는 0 이상), bool은 0.5 이상이면 참.
const toParameter = (type, value) =>
  type === "bool"
    ? value >= 0.5
    : type === "int"
      ? Math.round(value)
      : type === "uint"
        ? Math.max(0, Math.round(value))
        : value;

export {
  SOURCES,
  BANDS,
  SHAPES,
  LINKABLE,
  MAX_KEYS,
  validate,
  bandLevel,
  waveLevel,
  audioLevels,
  lfo,
  keyValue,
  target,
  follow,
  toParameter,
};
