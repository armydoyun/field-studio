// 파라미터 프리셋: 파라미터 값 묶음을 이름 붙여 두고 전환한다. DOM · GPU와 무관한 순수 함수(node에서 검사).
// 프리셋 = { name, values, schema? }. schema가 없는 이전 파일도 값의 형태를 검증해 읽는다.
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
  schema: Object.fromEntries(
    users.map(item => [
      item.name,
      {
        type: item.type,
        ...(item.options?.enum ? { enum: [...item.options.enum] } : {}),
        ...(item.options?.gradient ? { ramp: "gradient" } : item.options?.curve ? { ramp: "curve" } : {}),
      },
    ])
  ),
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
          value.length <= 1024 &&
          value.every(v => typeof v === "boolean" || Number.isFinite(v)));
      if (/^[A-Za-z_]\w*$/.test(key) && ok) values[key] = copyValue(value);
    }
    if (preset.schema === undefined) return { name, values };
    if (!preset.schema || typeof preset.schema !== "object" || Array.isArray(preset.schema))
      throw new Error(`${name}: 프리셋 타입 정보가 올바르지 않습니다.`);
    const schema = Object.fromEntries(
      Object.keys(values)
        .filter(key => Object.hasOwn(preset.schema, key))
        .map(key => {
          const entry = preset.schema[key];
          if (
            !entry ||
            typeof entry.type !== "string" ||
            !/^(?:float|int|uint|bool|[biu]?vec[234]|mat[234]|sampler2D)(?:\[(?:[2-9]|[1-5]\d|6[0-4])\])?$/.test(
              entry.type
            ) ||
            (entry.enum !== undefined &&
              (!Array.isArray(entry.enum) ||
                entry.enum.length > 32 ||
                !entry.enum.every(label => typeof label === "string" && label.length <= 40))) ||
            (entry.ramp !== undefined && !["gradient", "curve"].includes(entry.ramp))
          )
            throw new Error(`${name}: ${key} 타입 정보가 올바르지 않습니다.`);
          return [
            key,
            {
              type: entry.type,
              ...(entry.enum ? { enum: [...entry.enum] } : {}),
              ...(entry.ramp ? { ramp: entry.ramp } : {}),
            },
          ];
        })
    );
    return { name, values, schema };
  });
};

// Build an immutable application plan before any renderer write.
const plan = (users, preset, links = []) => {
  const byName = new Map(users.map(item => [item.name, item])),
    linked = new Set(links.map(link => link.name));
  const applied = [],
    skipped = [];
  let legacy = false;
  for (const [name, raw] of Object.entries(preset.values)) {
    const item = byName.get(name),
      saved = preset.schema?.[name];
    const reject = reason => skipped.push({ name, reason });
    if (!item) {
      reject("현재 프로젝트에 없는 파라미터");
      continue;
    }
    if (linked.has(name)) {
      reject("연결이 값을 제어함 · 연결을 해제한 뒤 적용하세요");
      continue;
    }
    if (saved && saved.type !== item.type) {
      reject(`타입 변경: ${saved.type} → ${item.type}`);
      continue;
    }
    const options = item.options || {};
    if (saved && JSON.stringify(saved.enum) !== JSON.stringify(options.enum)) {
      reject("선택지 구성이 달라짐");
      continue;
    }
    if (saved && saved.ramp !== (options.gradient ? "gradient" : options.curve ? "curve" : undefined)) {
      reject("색 램프·곡선 종류가 달라짐");
      continue;
    }
    if (!saved) legacy = true;
    const array = /^(\w+)\[(\d+)\]$/.exec(item.type),
      base = array ? array[1] : item.type;
    const dim = Number(base.at(-1)) || 1,
      size = base.startsWith("mat") ? dim * dim : dim;
    const values = Array.isArray(raw) ? raw : [raw];
    if (base === "sampler2D") {
      const stride = options.gradient ? 5 : options.curve ? 2 : 0;
      if (
        !Array.isArray(raw) ||
        !stride ||
        values.length % stride ||
        values.length / stride < 2 ||
        values.length / stride > 16 ||
        !values.every(
          (v, i) =>
            typeof v === "number" &&
            Number.isFinite(v) &&
            (i % stride === 0 || options.gradient ? v >= 0 && v <= 1 : true)
        ) ||
        values.some((v, i) => i % stride === 0 && i > 0 && v < values[i - stride])
      ) {
        reject("램프 값의 형태·정지점·범위가 맞지 않음");
        continue;
      }
    } else {
      if (
        (array || size > 1 ? !Array.isArray(raw) : Array.isArray(raw)) ||
        values.length !== size * (array ? Number(array[2]) : 1)
      ) {
        reject("값의 성분 수가 맞지 않음");
        continue;
      }
      const bool = base.startsWith("b"),
        signed = /^(int|ivec)/.test(base),
        unsigned = /^(uint|uvec)/.test(base);
      if (
        !values.every(v =>
          bool
            ? typeof v === "boolean"
            : typeof v === "number" &&
              Number.isFinite(v) &&
              (!(signed || unsigned) ||
                (Number.isInteger(v) && v >= (unsigned ? 0 : -2147483648) && v <= (unsigned ? 4294967295 : 2147483647)))
        )
      ) {
        reject("현재 타입에 맞지 않는 값");
        continue;
      }
      if (
        !bool &&
        values.some((v, i) => {
          const range = options.ranges?.[i];
          if (range) return v < range[0] || v > range[1];
          if (options.color) return v < 0 || v > (size === 4 && i % size === 3 ? 1 : options.hdr || 1);
          return options.min !== undefined && (v < options.min || v > options.max);
        })
      ) {
        reject("현재 허용 범위를 벗어난 값");
        continue;
      }
    }
    let value = copyValue(raw);
    if (options.dir) {
      const next = [];
      for (let i = 0; i < values.length; i += size) {
        const part = values.slice(i, i + size);
        if (options.dir === "hemi") part[1] = Math.abs(part[1]);
        const length = Math.hypot(...part);
        if (!(length > 1e-9) || !Number.isFinite(length)) break;
        next.push(...part.map(v => v / length));
      }
      if (next.length !== values.length) {
        reject("방향 벡터는 0일 수 없음");
        continue;
      }
      value = next;
    }
    applied.push({ ...item, value });
  }
  return { applied, skipped, legacy };
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
  if (options.dir && item.type.includes("[")) {
    const size = Number(/^vec([23])/.exec(item.type)?.[1]);
    return mixed.flatMap((_, i) => {
      if (i % size) return [];
      const part = mixed.slice(i, i + size),
        length = Math.hypot(...part);
      return length > 1e-9 ? part.map(v => v / length) : half.slice(i, i + size);
    });
  }
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

export { MAX_PRESETS, MAX_NAME, capture, validate, plan, blendValue, blend, ease };
