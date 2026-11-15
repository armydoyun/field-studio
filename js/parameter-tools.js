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

export { writeDefaults, varyValue, canVary, equalValue, changedFromDefault, glslLiteral };
