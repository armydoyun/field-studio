// GLSL 주석 어노테이션 → 파라미터 정의. DOM·GPU에 의존하지 않는 순수 파서다.
// 형식: uniform <type> <name>; // @range <min> <max> [step] @min <v> @max <v> @step <v> @default <v...> @color
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
    num = value => Number(value),
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
  else value = Array(n).fill(options.min !== undefined ? Math.min(Math.max(0, options.min), options.max) : 0);
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
  if (!Number.isFinite(options.min) || !Number.isFinite(options.max)) return value;
  const clamp = v => (typeof v === "number" ? Math.min(options.max, Math.max(options.min, v)) : v);
  return Array.isArray(value) ? value.map(clamp) : clamp(value);
};
const sameOptions = (a = {}, b = {}) => ["min", "max", "step", "color"].every(key => a[key] === b[key]);
export { collect, clampValue, sameOptions };
