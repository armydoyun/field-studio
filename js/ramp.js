// 램프(@gradient · @curve) 굽기: DOM·GPU와 무관한 순수 함수. 렌더러(텍스처), 패널 미리보기, 갤러리 썸네일이 함께 쓴다.
const RAMP_SIZE = 256,
  RAMP_MAX_POINTS = 16;
// gradient: value = [t, r, g, b, a]…(t 오름차순) · 모드 linear | smooth(smoothstep) | step(왼쪽 색 유지)
// curve:    value = [x, y]…(x 오름차순) · 모드 smooth(단조 3차 Hermite, 넘침 없음) | linear
const rampSegment = (keys, x) => {
  let i = 0;
  while (i < keys.length - 2 && x >= keys[i + 1]) i++;
  return i;
};
const sampleGradient = (value, mode, x) => {
  const count = value.length / 5,
    keys = Array.from({ length: count }, (_, i) => value[i * 5]),
    color = i => value.slice(i * 5 + 1, i * 5 + 5);
  if (x <= keys[0]) return color(0);
  if (x >= keys[count - 1]) return color(count - 1);
  const i = rampSegment(keys, x),
    span = keys[i + 1] - keys[i];
  let f = span > 1e-9 ? (x - keys[i]) / span : 1;
  if (mode === "step") f = 0;
  else if (mode === "smooth") f = f * f * (3 - 2 * f);
  const a = color(i),
    b = color(i + 1);
  return a.map((v, k) => v + (b[k] - v) * f);
};
const curveTangents = (xs, ys) => {
  const n = xs.length,
    d = [],
    m = Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    d.push(dx > 1e-9 ? (ys[i + 1] - ys[i]) / dx : 0);
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  // Fritsch–Carlson: 기울기를 줄여 구간 안에서 넘치지(overshoot) 않게 한다.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i],
      b = m[i + 1] / d[i],
      sum = a * a + b * b;
    if (sum > 9) {
      const t = 3 / Math.sqrt(sum);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return m;
};
const sampleCurve = (value, mode, x, tangents = null) => {
  const n = value.length / 2,
    xs = Array.from({ length: n }, (_, i) => value[i * 2]),
    ys = Array.from({ length: n }, (_, i) => value[i * 2 + 1]);
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  const i = rampSegment(xs, x),
    h = xs[i + 1] - xs[i];
  if (!(h > 1e-9)) return ys[i + 1];
  const t = (x - xs[i]) / h;
  if (mode === "linear") return ys[i] + (ys[i + 1] - ys[i]) * t;
  const m = tangents || curveTangents(xs, ys),
    t2 = t * t,
    t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * ys[i] +
    (t3 - 2 * t2 + t) * h * m[i] +
    (-2 * t3 + 3 * t2) * ys[i + 1] +
    (t3 - t2) * h * m[i + 1]
  );
};
// count개 표본(0~1 균등). gradient는 [r,g,b,a] 배열들, curve는 숫자들.
const sampleRamp = (options, value, count = RAMP_SIZE) => {
  const at = i => (count > 1 ? i / (count - 1) : 0);
  if (options?.gradient) return Array.from({ length: count }, (_, i) => sampleGradient(value, options.gradient, at(i)));
  const n = value.length / 2,
    tangents = curveTangents(
      Array.from({ length: n }, (_, i) => value[i * 2]),
      Array.from({ length: n }, (_, i) => value[i * 2 + 1])
    );
  return Array.from({ length: count }, (_, i) => sampleCurve(value, options?.curve, at(i), tangents));
};
// 256×1 텍스처 자료로 굽는다. gradient → RGBA8(Uint8Array 1024), curve → R16F에 올릴 Float32Array(256).
const bakeRamp = (
  options,
  value,
  out = options.gradient ? new Uint8Array(RAMP_SIZE * 4) : new Float32Array(RAMP_SIZE)
) => {
  const samples = sampleRamp(options, value);
  if (options.gradient)
    samples.forEach((c, i) => c.forEach((v, k) => (out[i * 4 + k] = Math.round(Math.min(1, Math.max(0, v)) * 255))));
  else out.set(samples);
  return out;
};
export { RAMP_MAX_POINTS, RAMP_SIZE, bakeRamp, sampleRamp };
