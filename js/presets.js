// 파라미터 프리셋: 파라미터 값 묶음을 이름 붙여 두고 전환한다. DOM · GPU와 무관한 순수 함수(node에서 검사).
// 프리셋 = { name, values: { 파라미터 이름: 값 } }. 프로젝트 설정(settings.js의 presets)에 함께 저장된다.
// 전환은 즉시 또는 몇 초에 걸쳐 부드럽게(blend). 위젯 종류에 맞게 섞는다:
//   실수 · 벡터 · 행렬 · 색 → 선형 · @dir → 섞은 뒤 길이 1 · @angle → 가까운 쪽으로 도는 각도
//   int · uint → 섞은 뒤 반올림(@enum은 가운데에서 바뀜) · bool → 가운데에서 바뀜
//   램프(@gradient · @curve) → 점 수가 같으면 값마다 선형, 다르면 가운데에서 바뀜
const MAX_PRESETS = 32,
  MAX_NAME = 60;

const copyValue = value => (Array.isArray(value) ? [...value] : value);

// 지금 파라미터(renderer.getUserUniforms())에서 프리셋을 만든다.
const capture = (name, users) => ({
  name,
  values: Object.fromEntries(users.map(item => [item.name, copyValue(item.value)])),
});

// 저장소 · Pack에서 온 목록을 검사한 사본. 잘못된 형식이면 던진다.
const validate = list => {
  if (!Array.isArray(list) || list.length > MAX_PRESETS) throw new Error(`프리셋은 최대 ${MAX_PRESETS}개입니다.`);
  const names = new Set();
  return list.map(preset => {
    const name = typeof preset?.name === "string" ? preset.name.trim() : "";
    if (!name || name.length > MAX_NAME) throw new Error(`프리셋 이름은 1~${MAX_NAME}자여야 합니다.`);
    if (names.has(name)) throw new Error(`같은 이름의 프리셋이 있습니다: ${name}`);
    names.add(name);
    if (!preset.values || typeof preset.values !== "object" || Array.isArray(preset.values))
      throw new Error(`${name}: 프리셋 값이 올바르지 않습니다.`);
    const values = {};
    for (const [key, value] of Object.entries(preset.values)) {
      const ok =
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (Array.isArray(value) &&
          value.length <= 5 * 64 &&
          value.every(v => typeof v === "boolean" || Number.isFinite(v)));
      if (/^[A-Za-z_]\w*$/.test(key) && ok) values[key] = copyValue(value);
    }
    return { name, values };
  });
};

const lerp = (a, b, t) => a + (b - a) * t;
// 각도: 차이를 -π ~ π로 접어 가까운 쪽으로 돈다.
const angleLerp = (a, b, t) => {
  const turn = 2 * Math.PI;
  const diff = ((((b - a + Math.PI) % turn) + turn) % turn) - Math.PI;
  return a + diff * t;
};
const integer = item => /^(int|uint|ivec|uvec)/.test(item.type);

// 파라미터 하나의 값: from → to를 t(0~1)만큼. item = { type, options }. 섞을 수 없으면 가운데(t ≥ 0.5)에서 바꾼다.
const blendValue = (item, from, to, t) => {
  const half = t < 0.5 ? copyValue(from) : copyValue(to);
  if (t <= 0) return copyValue(from);
  if (t >= 1) return copyValue(to);
  const options = item.options || {};
  if (typeof from === "boolean" || typeof to === "boolean" || item.type.startsWith("b")) return half;
  if (typeof from === "number" && typeof to === "number") {
    if (options.enum) return half;
    if (options.angle) return angleLerp(from, to, t);
    const value = lerp(from, to, t);
    return integer(item) ? Math.round(value) : value;
  }
  if (!Array.isArray(from) || !Array.isArray(to) || from.length !== to.length) return half;
  const mixed = from.map((a, i) => lerp(a, to[i], t));
  if (options.dir && item.type.includes("[")) return mixed; // 배열 방향: 렌더러가 원소마다 길이 1로 맞춘다
  if (options.dir) {
    const length = Math.hypot(...mixed);
    return length > 1e-6 ? mixed.map(v => v / length) : half;
  }
  return integer(item) ? mixed.map(Math.round) : mixed;
};

// 전환의 한 순간: users(지금 파라미터 목록)마다 from(시작 값 맵) → preset.values를 t만큼 섞은 [이름, 값] 목록.
// 프리셋에 없거나 시작 값이 없는 파라미터는 건드리지 않는다.
const blend = (users, from, preset, t) =>
  users
    .filter(item => Object.hasOwn(preset.values, item.name) && Object.hasOwn(from, item.name))
    .map(item => [item.name, blendValue(item, from[item.name], preset.values[item.name], t)]);

// 전환 곡선(천천히 시작해 천천히 끝남)
const ease = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export { MAX_PRESETS, MAX_NAME, capture, validate, blendValue, blend, ease };
