// Pure source/value operations shared by the parameter panel and Studio.
import * as Annotations from "./annotations.js";
const serialize = value => (Array.isArray(value) ? value : [value]).map(String).join(" ");
// Split shared declarations so writing one default never changes its siblings.
const writeDefaults = (source, items) => {
  const values = new Map(items.map(item => [item.name, item]));
  let block = false;
  return source
    .split(/(\r?\n)/)
    .map(line => {
      const wasBlock = block;
      // Track block comments, ignoring markers inside trailing line comments.
      for (let i = 0; i < line.length - 1; i++) {
        const pair = line.slice(i, i + 2);
        if (!block && pair === "//") break;
        if (!block && pair === "/*") {
          block = true;
          i++;
        } else if (block && pair === "*/") {
          block = false;
          i++;
        }
      }
      if (wasBlock || /^\s*\/\//.test(line)) return line;
      const match =
        /^(\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?([A-Za-z_]\w*)(\s*\[\s*\d+\s*\])?\s+)([A-Za-z_]\w*(?:\s*\[\s*\d+\s*\])?(?:\s*,\s*[A-Za-z_]\w*(?:\s*\[\s*\d+\s*\])?)*)\s*;(\s*(?:\/\/.*)?)$/.exec(
          line
        );
      if (!match) return line;
      const [, prefix, type, typeSize, names, tail] = match;
      const parts = names.split(",").map(part => part.trim());
      const target = part => {
        const name = /^[A-Za-z_]\w*/.exec(part)[0],
          count = /\[\s*(\d+)\s*\]/.exec(part + (typeSize || "")),
          item = values.get(name);
        return item?.type === type + (count ? `[${Number(count[1])}]` : "") ? item : null;
      };
      if (!parts.some(target)) return line;
      return parts
        .map(part => {
          const item = target(part);
          if (!item) return `${prefix}${part};${tail}`;
          const comment = tail.includes("//") ? tail.slice(tail.indexOf("//") + 2).trimEnd() : " ",
            tag = `@default ${serialize(item.value)}`,
            next = /@default\b[^@]*/.test(comment)
              ? comment.replace(/@default\b[^@]*/g, `${tag} `).trimEnd()
              : `${comment.trimEnd()} ${tag}`;
          return `${prefix}${part}; //${next}`;
        })
        .join("\n");
    })
    .join("");
};
const canVary = item => item.type !== "sampler2D";
// Jitter stays within 10% of the current magnitude (zero uses the range/1).
// All numeric controls respect their bounds, steps, and direction normalization.
// 칸(step)이 없는 실수를 무작위로 정할 때 쓸 자릿수: 바뀔 수 있는 폭의 1/1000 단위까지만(폭 1 → 0.001, 폭 1000 → 1).
// 폭을 모르거나 로그 눈금이면 유효 숫자 4자리. 그래야 '코드에 반영'이 570.874579536 같은 긴 숫자를 쓰지 않는다.
const tidy = (value, width) => {
  if (!Number.isFinite(value) || value === 0) return value;
  const exponent = Math.floor(Math.log10(width > 0 && Number.isFinite(width) ? width : Math.abs(value))) - 3;
  return Number((Math.round(value / 10 ** exponent) * 10 ** exponent).toFixed(Math.max(0, -exponent)));
};
const varyValue = (item, jitter = false, random = Math.random) => {
  const opts = item.options || {},
    base = item.type.replace(/\[\d+\]$/, ""),
    integer = /^(?:int|uint|[iu]vec)/.test(base),
    unsigned = /^(?:uint|uvec)/.test(base);
  const component = (current, i) => {
    if (typeof current === "boolean") return jitter ? current : random() >= 0.5;
    const colorMax = base === "vec4" && i % 4 === 3 ? 1 : opts.hdr || 1,
      range = opts.ranges?.[i],
      low = range?.[0] ?? opts.min ?? (unsigned || opts.color ? 0 : opts.angle ? 0 : opts.dir ? -1 : 0),
      high =
        range?.[1] ??
        opts.max ??
        (opts.color ? colorMax : opts.angle ? 2 * Math.PI : opts.dir ? 1 : integer ? 99999 : 1000),
      step = range?.[2] ?? opts.step ?? (integer ? 1 : 0),
      span = Math.abs(current) || (Number.isFinite(opts.max) ? high - low : 1);
    let value = jitter
      ? current + (random() * 2 - 1) * span * 0.1
      : opts.log
        ? low * Math.pow(high / low, random())
        : low + random() * (high - low);
    // Unbounded jitter must allow negatives and values outside the random fallback range.
    const min = range?.[0] ?? opts.min ?? (unsigned || opts.color ? 0 : opts.dir ? -1 : -Infinity),
      max = range?.[1] ?? opts.max ?? (opts.color ? colorMax : opts.dir ? 1 : Infinity);
    if (step > 0) value = low + Math.round((value - low) / step) * step;
    else if (!integer) value = tidy(value, opts.log ? 0 : jitter ? span * 0.2 : high - low);
    if (integer) value = Math.round(value);
    return Math.min(jitter ? max : high, Math.max(jitter ? min : low, Number(value.toPrecision(12))));
  };
  const value = Array.isArray(item.value) ? item.value.map(component) : component(item.value, 0);
  return Annotations.clampValue(value, opts, item.type);
};
// Relative precision also detects edits to tiny HDR radiance and small-range controls.
const equalValue = (a, b) =>
  Array.isArray(a)
    ? Array.isArray(b) && a.length === b.length && a.every((value, i) => equalValue(value, b[i]))
    : typeof a === "number" && typeof b === "number"
      ? a === b || Math.abs(a - b) <= Number.EPSILON * 8 * Math.max(Math.abs(a), Math.abs(b))
      : a === b;
const changedFromDefault = (item, spec) =>
  !spec ||
  item.type !== spec.type ||
  !equalValue(item.value, Annotations.clampValue(spec.value, item.options || {}, item.type));
// 값을 GLSL 코드 조각으로(우클릭 '값을 GLSL로 복사'): float 1.0 · int 3 · uint 3u · bool true ·
// vec3(0.1, 0.2, 0.3) · ivec2(1, 2) · bvec2(true, false) · mat2(…) · 배열 float[3](…). 램프(sampler2D)는 null.
const glslLiteral = item => {
  const array = /^(\w+)\[(\d+)\]$/.exec(item.type || "");
  const base = array ? array[1] : item.type;
  if (!base || base === "sampler2D") return null;
  const values = (Array.isArray(item.value) ? item.value : [item.value]).map(Number);
  if (values.some(v => !Number.isFinite(v) && typeof v !== "boolean")) return null;
  const kind = /^(?:b|bool)/.test(base) ? "b" : /^(?:u|uint)/.test(base) ? "u" : /^(?:i|int)/.test(base) ? "i" : "f";
  const scalar = v => {
    if (kind === "b") return v ? "true" : "false";
    if (kind === "i") return String(Math.round(v));
    if (kind === "u") return `${Math.max(0, Math.round(v))}u`;
    const text = String(Number(v.toPrecision(7)));
    return /[.e]/.test(text) ? text : `${text}.0`;
  };
  const size = /^(?:vec|ivec|uvec|bvec)([234])$/.exec(base)?.[1] ?? /^mat([234])$/.exec(base)?.[1] ** 2;
  const one = list => (size ? `${base}(${list.map(scalar).join(", ")})` : scalar(list[0]));
  if (!array) return one(values);
  const count = Number(array[2]),
    width = size || 1;
  const parts = Array.from({ length: count }, (_, i) => one(values.slice(i * width, i * width + width)));
  return `${base}[${count}](${parts.join(", ")})`;
};

// 파라미터 하나의 GLSL 선언 줄(어노테이션 주석 포함). '파라미터 추가'가 코드에 직접 써 넣는다 —
// 코드가 선언을 가지고 있어야 셰이더가 그 이름을 안다(앱이 선언을 대신 넣지 않는다). 옵션은 annotations.js가 다시 읽는 형식.
//   declarationLine({ name: "uGain", type: "float", value: 0.5, options: { min: 0, max: 1, step: 0.01 } })
//   → "uniform float uGain; // @range 0 1 0.01 @default 0.5"
const declarationLine = ({ name, type, value, options = {} }) => {
  const array = /^(\w+)\[(\d+)\]$/.exec(type),
    head = array ? `uniform ${array[1]} ${name}[${array[2]}];` : `uniform ${type} ${name};`,
    tags = [],
    number = v => String(Number(Number(v).toPrecision(7)));
  if (type === "sampler2D") {
    tags.push(
      options.curve
        ? `@curve ${options.curve === true ? "smooth" : options.curve}`
        : `@gradient ${options.gradient === true ? "linear" : options.gradient || "linear"}`
    );
    return `${head} // ${tags.join(" ")}`;
  }
  if (options.enum?.length)
    tags.push(`@enum ${options.enum.map(label => String(label).replace(/\s+/g, "_")).join(" ")}`);
  else {
    if (options.color) tags.push(options.hdr ? `@color hdr ${number(options.hdr)}` : "@color");
    else if (options.dir) tags.push(options.dir === "hemi" ? "@dir hemi" : "@dir");
    else if (options.angle) tags.push("@angle");
    else if (options.pos) tags.push("@pos");
    if (options.log) tags.push("@log");
    if ([options.min, options.max].every(Number.isFinite))
      tags.push(
        `@range ${number(options.min)} ${number(options.max)}${Number.isFinite(options.step) ? ` ${number(options.step)}` : ""}`
      );
  }
  const values = (Array.isArray(value) ? value : [value]).map(v => (typeof v === "boolean" ? String(v) : number(v)));
  if (values.length && values.every(v => v !== "NaN")) tags.push(`@default ${values.join(" ")}`);
  return tags.length ? `${head} // ${tags.join(" ")}` : head;
};

// 소스에서 이름 하나의 uniform 선언을 지운다(파라미터 삭제가 코드의 선언도 함께 지운다).
// 그 이름만 선언한 줄은 줄째(주석 포함) 지우고, 여러 이름을 함께 선언한 줄(uniform float uA, uB;)에서는 그 이름만 뺀다.
// 주석 처리된 줄은 건드리지 않는다. → { source, removed: 지운 선언 수 }
const removeDeclaration = (source, name) => {
  let removed = 0;
  const lines = String(source).split("\n"),
    kept = [];
  for (const line of lines) {
    const match = /^(\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+(?:\s*\[\s*\d+\s*\])?\s+)([^;]*);(.*)$/.exec(line);
    const names = match ? match[2].split(",") : [];
    const at = names.findIndex(part => part.trim().match(/^[A-Za-z_]\w*/)?.[0] === name);
    if (at < 0) {
      kept.push(line);
      continue;
    }
    removed++;
    if (names.length === 1) continue;
    names.splice(at, 1);
    kept.push(`${match[1]}${names.map(part => part.trim()).join(", ")};${match[3]}`);
  }
  return { source: kept.join("\n"), removed };
};

export {
  writeDefaults,
  varyValue,
  canVary,
  equalValue,
  changedFromDefault,
  glslLiteral,
  declarationLine,
  removeDeclaration,
};
