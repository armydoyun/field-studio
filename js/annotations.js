// GLSL 주석 어노테이션 → 파라미터 정의. DOM·GPU에 의존하지 않는 순수 파서다.
// 형식: uniform <type> <name>; // @range <min> <max> [step] @min <v> @max <v> @step <v> @default <v...> + 표시 방식 태그
// @dir: vec2/vec3 단위 방향 벡터. 값은 항상 길이 1로 정규화한다. hemi면 +Y 반구(반원)로 제한한다.
// 표시 방식 태그(하나만): @color · @dir [hemi] · @angle(float, 라디안을 다이얼로) · @pos/@xy(vec2, 2D 패드, 범위 없으면 -1~1)
//  · @log(float, 0보다 큰 @range를 로그 눈금 슬라이더로) · @enum 이름…(int/uint, 0부터 차례로 선택지. 이름의 _는 빈칸)
// @default 값 끝에 deg(또는 °)를 붙이면 도 단위로 읽어 라디안으로 바꾼다: @angle @default 45deg
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
const parseLine = line => {
  const match = DECLARATION.exec(line);
  if (!match || !match[3].includes("@")) return null;
  const [, type, name, comment] = match;
  if (!Object.hasOwn(SIZES, type)) return null;
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
  if (tags.color !== undefined) options.color = true;
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
  return { name, type, value: n === 1 ? value[0] : value, options, error };
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
  if (options.dir)
    return Array.isArray(value)
      ? normalizeDirection(value, options.dir) || (value.length === 2 ? [1, 0] : [0, 1, 0])
      : value;
  if (!Number.isFinite(options.min) || !Number.isFinite(options.max)) return value;
  const clamp = v => (typeof v === "number" ? Math.min(options.max, Math.max(options.min, v)) : v);
  return Array.isArray(value) ? value.map(clamp) : clamp(value);
};
const sameOptions = (a = {}, b = {}) =>
  ["min", "max", "step", "color", "dir", "angle", "pos", "log"].every(key => a[key] === b[key]) &&
  JSON.stringify(a.enum) === JSON.stringify(b.enum);
export { collect, clampValue, sameOptions, normalizeDirection };
