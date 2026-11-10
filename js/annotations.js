// GLSL 주석 어노테이션 → 파라미터 정의. DOM·GPU에 의존하지 않는 순수 파서다.
// 형식: uniform <type> <name>; // @range <min> <max> [step] @min <v> @max <v> @step <v> @default <v...> + 표시 방식 태그
// @dir: vec2/vec3 단위 방향 벡터. 값은 항상 길이 1로 정규화한다. hemi면 +Y 반구(반원)로 제한한다.
// 표시 방식 태그(하나만): @color · @dir [hemi] · @angle(float, 라디안을 다이얼로) · @pos/@xy(vec2, 2D 패드, 범위 없으면 -1~1)
//  · @log(float, 0보다 큰 @range를 로그 눈금 슬라이더로) · @enum 이름…(int/uint, 0부터 차례로 선택지. 이름의 _는 빈칸)
// @default 값 끝에 deg(또는 °)를 붙이면 도 단위로 읽어 라디안으로 바꾼다: @angle @default 45deg
// 덧붙이는 태그: @color hdr [최대 밝기](색 + 밝기 배율, 값이 1을 넘을 수 있다) · @seed(🎲 무작위 버튼, float/int/uint)
//  · @anim [초](▶ 버튼: 범위를 왕복, @angle이면 한 바퀴씩 돈다, int/uint는 한 칸씩 왕복, @enum은 선택지마다 [초]씩 머물며 순환.
//    기본 4초) · @group 이름(패널에서 접히는 묶음)
// 첫 @ 앞의 주석 글은 설명(description)으로 이름 아래에 보여 준다: // 햇빛 · @color
// 램프(uniform sampler2D, 셰이더에서 texture(u, vec2(t, 0.5))로 읽는다):
//  · @gradient [linear|smooth|step] @default 0 #000000 0.5 #ff8000 1 #ffffff(위치 + #RRGGBB[AA], 또는 위치 r g b a 다섯 개씩)
//  · @curve [smooth|linear] [@range ymin ymax] @default 0 0 0.5 0.8 1 1(x y 쌍) — 값은 .r에 들어간다
// 같은 줄의 단일 선언만 인식한다. 값 검증(타입·범위)은 Renderer.normalizeEntry가 최종 판단한다.
const DECLARATION = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;\s*\/\/(.*)$/;
const SIZES = {
  float: 1,
  int: 1,
  uint: 1,
  bool: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
  ivec2: 2,
  ivec3: 3,
  ivec4: 4,
  uvec2: 2,
  uvec3: 3,
  uvec4: 4,
  bvec2: 2,
  bvec3: 3,
  bvec4: 4,
  mat2: 4,
  mat3: 9,
  mat4: 16,
};
const kindOf = type =>
  type.startsWith("b")
    ? "b"
    : type.startsWith("mat")
      ? "m"
      : /^(int|ivec)/.test(type)
        ? "i"
        : /^(uint|uvec)/.test(type)
          ? "u"
          : "f";
// 방향 벡터를 길이 1로 만든다. hemi면 Y가 음수인 쪽을 +Y 반구로 뒤집는다. 0 벡터·비정상 값이면 null.
const normalizeDirection = (value, mode = "full") => {
  if (!Array.isArray(value) || !value.every(Number.isFinite)) return null;
  const v = [...value];
  if (mode === "hemi") v[1] = Math.abs(v[1]);
  const length = Math.hypot(...v);
  if (!(length > 1e-9)) return null;
  return v.map(x => x / length);
};
const WIDGETS = ["color", "dir", "angle", "pos", "log", "enum"];
// 숫자 하나. 45deg·45°는 라디안으로 바꾼다.
const parseNumber = text => {
  const degrees = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(?:deg|°)$/i.exec(text);
  return degrees ? (Number(degrees[1]) * Math.PI) / 180 : Number(text);
};
// 램프 기본값: gradient는 검정 → 흰색, curve는 (0, 아래) → (1, 위) 직선.
const RAMP_MODES = { gradient: ["linear", "smooth", "step"], curve: ["smooth", "linear"] };
const hexColor = text => {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text);
  return match ? [...match[1].match(/../g), match[2] || "ff"].map(h => parseInt(h, 16) / 255) : null;
};
const parseRamp = (name, tags, description, group) => {
  const kind = tags.gradient !== undefined ? "gradient" : tags.curve !== undefined ? "curve" : null;
  if (!kind) return null; // 램프가 아닌 sampler2D(예: 직접 넣는 텍스처)는 어노테이션 대상이 아니다
  const type = "sampler2D",
    options = {},
    mode = tags[kind][0]?.toLowerCase();
  let error = null,
    value;
  if (tags.gradient !== undefined && tags.curve !== undefined) error = "@gradient와 @curve는 함께 쓸 수 없습니다.";
  if (mode && !RAMP_MODES[kind].includes(mode))
    error = `@${kind} 모드는 ${RAMP_MODES[kind].join(" · ")} 중 하나입니다.`;
  options[kind] = RAMP_MODES[kind].includes(mode) ? mode : RAMP_MODES[kind][0];
  const raw = tags.default || [];
  if (kind === "gradient") {
    if (tags.range || tags.min || tags.max) error = "@gradient에는 범위를 쓰지 않습니다.";
    if (!raw.length) value = [0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
    else if (raw.some(token => token.startsWith("#"))) {
      value = [];
      for (let i = 0; i < raw.length; i += 2) {
        const color = hexColor(raw[i + 1] || "");
        if (!color || !Number.isFinite(parseNumber(raw[i]))) {
          error = "@gradient @default는 '위치 #RRGGBB' 쌍이어야 합니다. 예: 0 #000000 1 #ffffff";
          break;
        }
        value.push(parseNumber(raw[i]), ...color);
      }
    } else {
      value = raw.map(parseNumber);
      if (value.length % 5) error = "@gradient @default를 숫자로 쓸 때는 '위치 r g b a' 다섯 개씩이어야 합니다.";
    }
  } else {
    if (tags.range) [options.min, options.max] = tags.range.map(parseNumber);
    if (tags.min) options.min = parseNumber(tags.min[0]);
    if (tags.max) options.max = parseNumber(tags.max[0]);
    if (options.min !== undefined || options.max !== undefined) {
      if (!(options.min < options.max)) error = "@curve의 @range는 ymin < ymax여야 합니다.";
      options.step = Number(((options.max - options.min) / 1000).toPrecision(2)) || 0.001;
    }
    const low = options.min ?? 0,
      high = options.max ?? 1;
    value = raw.length ? raw.map(parseNumber) : [0, low, 1, high];
    if (value.length % 2) error = "@curve @default는 'x y' 쌍이어야 합니다.";
  }
  const stride = kind === "gradient" ? 5 : 2;
  if (!error && !value.every(Number.isFinite)) error = `@${kind} @default에 숫자가 아닌 값이 있습니다.`;
  else if (!error && (value.length / stride < 2 || value.length / stride > 16))
    error = `@${kind}에는 점이 2~16개 필요합니다.`;
  else if (!error && value.some((v, i) => i % stride === 0 && (v < 0 || v > 1)))
    error = `@${kind}의 위치(x)는 0~1이어야 합니다.`;
  if (!error) {
    const points = [];
    for (let i = 0; i < value.length; i += stride) points.push(value.slice(i, i + stride));
    value = points.sort((a, b) => a[0] - b[0]).flat();
  }
  return { name, type, value, options, error, description, group };
};
const parseLine = line => {
  const match = DECLARATION.exec(line);
  if (!match || !match[3].includes("@")) return null;
  const [, type, name, comment] = match;
  if (!Object.hasOwn(SIZES, type) && type !== "sampler2D") return null;
  const tags = {};
  let error = null;
  for (const part of comment.split("@").slice(1)) {
    const [key, ...args] = part
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (!key) continue;
    tags[key.toLowerCase()] = args;
  }
  // 설명: 첫 태그 앞의 주석 글. 끝의 구분 기호(· : - |)는 뗀다.
  const description = comment
    .split("@")[0]
    .trim()
    .replace(/\s*[·:|\-–—]+$/, "")
    .trim();
  const group = tags.group ? tags.group.join(" ").replace(/_/g, " ").trim() : "";
  if (type === "sampler2D") return parseRamp(name, tags, description, group);
  const n = SIZES[type],
    kind = kindOf(type),
    num = parseNumber,
    options = {};
  if (tags.range) {
    [options.min, options.max] = tags.range.map(num);
    if (tags.range[2] !== undefined) options.step = num(tags.range[2]);
  }
  if (tags.min) options.min = num(tags.min[0]);
  if (tags.max) options.max = num(tags.max[0]);
  if (tags.step) options.step = num(tags.step[0]);
  if (options.min !== undefined || options.max !== undefined) {
    if (!Number.isFinite(options.min) || !Number.isFinite(options.max))
      error = "@range에는 min과 max 숫자가 모두 필요합니다.";
    options.step ??= kind === "f" ? Number(((options.max - options.min) / 1000).toPrecision(2)) || 0.001 : 1;
  }
  if (tags.color !== undefined) {
    options.color = true;
    if (tags.color[0]?.toLowerCase() === "hdr") {
      options.hdr = tags.color[1] === undefined ? 10 : num(tags.color[1]);
      if (!(options.hdr > 0 && options.hdr <= 1000))
        error = "@color hdr의 최대 밝기는 0보다 크고 1000 이하여야 합니다.";
    }
  }
  if (tags.dir !== undefined) {
    options.dir = tags.dir[0]?.toLowerCase() === "hemi" ? "hemi" : "full";
    if (type !== "vec2" && type !== "vec3") error = "@dir은 vec2/vec3에만 쓸 수 있습니다.";
    else if (options.color || options.min !== undefined) error = "@dir은 @color·@range와 함께 쓸 수 없습니다.";
  }
  if (tags.angle !== undefined) {
    options.angle = true;
    if (type !== "float") error = "@angle은 float에만 쓸 수 있습니다.";
    else if (options.min !== undefined) error = "@angle은 @range와 함께 쓸 수 없습니다(값은 라디안, 다이얼은 한 바퀴).";
  }
  if (tags.pos !== undefined || tags.xy !== undefined) {
    options.pos = true;
    if (type !== "vec2") error = "@pos(@xy)는 vec2에만 쓸 수 있습니다.";
    else if (options.min === undefined) Object.assign(options, { min: -1, max: 1, step: 0.002 });
  }
  if (tags.log !== undefined) {
    options.log = true;
    if (type !== "float") error = "@log는 float에만 쓸 수 있습니다.";
    else if (!(options.min > 0 && options.max > options.min))
      error = "@log에는 0보다 큰 @range min max가 필요합니다. 예: @log @range 0.01 100";
  }
  if (tags.enum !== undefined) {
    const labels = tags.enum.map(label => label.replace(/_/g, " "));
    options.enum = labels;
    if (type !== "int" && type !== "uint") error = "@enum은 int/uint에만 쓸 수 있습니다.";
    else if (labels.length < 2 || labels.length > 32) error = "@enum에는 선택지 이름이 2~32개 필요합니다.";
    else if (options.min !== undefined) error = "@enum은 @range와 함께 쓸 수 없습니다(선택지 수로 범위가 정해집니다).";
    else Object.assign(options, { min: 0, max: labels.length - 1, step: 1 });
  }
  if (tags.seed !== undefined) {
    options.seed = true;
    if (!["float", "int", "uint"].includes(type)) error = "@seed는 float/int/uint에만 쓸 수 있습니다.";
    else if (options.enum || options.angle) error = "@seed는 @enum·@angle과 함께 쓸 수 없습니다.";
  }
  if (tags.anim !== undefined) {
    options.anim = tags.anim[0] === undefined ? 4 : num(tags.anim[0]);
    if (!(options.anim >= 0.1 && options.anim <= 600)) error = "@anim의 주기는 0.1~600초여야 합니다.";
    else if (!["float", "int", "uint"].includes(type)) error = "@anim은 float/int/uint에만 쓸 수 있습니다.";
    else if (!options.angle && (options.min === undefined || options.log))
      error = "@anim에는 @range(로그 눈금 제외)·@enum이나 @angle이 필요합니다.";
  }
  const shown = WIDGETS.filter(key => options[key] !== undefined);
  if (shown.length > 1) error = `표시 방식 태그는 하나만 쓸 수 있습니다: ${shown.map(key => `@${key}`).join(" ")}`;
  let value;
  if (tags.default) {
    const raw = tags.default.slice(0, n);
    value = kind === "b" ? raw.map(v => v === "true" || v === "1") : raw.map(num);
    if (raw.length === 1 && n > 1) value = Array(n).fill(value[0]); // @default 0.5 → 모든 성분
    if (value.length !== n) error = `@default에는 값 ${n}개가 필요합니다.`;
  } else if (kind === "m") {
    const dim = Math.round(Math.sqrt(n));
    value = Array.from({ length: n }, (_, i) => (i % (dim + 1) === 0 ? 1 : 0));
  } else if (kind === "b") value = Array(n).fill(false);
  else if (options.color) value = Array(n).fill(1);
  else if (options.dir) value = n === 2 ? [1, 0] : [0, 1, 0];
  else value = Array(n).fill(options.min !== undefined ? Math.min(Math.max(0, options.min), options.max) : 0);
  if (options.dir && !error) {
    value = normalizeDirection(value, options.dir);
    if (!value) error = "@dir의 @default는 0이 아닌 벡터여야 합니다.";
  }
  return { name, type, value: n === 1 ? value[0] : value, options, error, description, group };
};
// 여러 패스의 소스를 받아 이름별 첫 정의만 남긴다(Image가 앞에 오도록 호출한다).
const collect = sources => {
  const found = new Map();
  for (const source of sources)
    if (typeof source === "string")
      for (const line of source.split("\n")) {
        const item = parseLine(line);
        if (item && !found.has(item.name)) found.set(item.name, item);
      }
  return [...found.values()];
};
// 범위가 바뀌었을 때 기존 값을 새 범위 안으로 끌어들인다.
const clampValue = (value, options) => {
  if (options.gradient || options.curve) return value; // 램프의 범위는 편집기 표시용이다
  if (options.dir)
    return Array.isArray(value)
      ? normalizeDirection(value, options.dir) || (value.length === 2 ? [1, 0] : [0, 1, 0])
      : value;
  if (!Number.isFinite(options.min) || !Number.isFinite(options.max)) return value;
  const clamp = v => (typeof v === "number" ? Math.min(options.max, Math.max(options.min, v)) : v);
  return Array.isArray(value) ? value.map(clamp) : clamp(value);
};
const sameOptions = (a = {}, b = {}) =>
  ["min", "max", "step", "color", "dir", "angle", "pos", "log", "hdr", "seed", "anim", "gradient", "curve"].every(
    key => a[key] === b[key]
  ) && JSON.stringify(a.enum) === JSON.stringify(b.enum);
export { collect, clampValue, sameOptions, normalizeDirection };
