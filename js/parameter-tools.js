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
export { writeDefaults, varyValue, canVary };
