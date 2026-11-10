// 예제 갤러리와 첫 실행 안내. 썸네일은 별도의 작은 WebGL2 컨텍스트에서 한 번만 그리고 즉시 해제한다.
// 예제 적용은 Studio API(loadExample/example*)만 사용하므로 Undo·미적용 변경 확인이 그대로 동작한다.
import * as Annotations from "./annotations.js";
import * as Community from "./community-examples.js";
import * as Perf from "./gallery-perf.js";
import * as Ramp from "./ramp.js";
import * as Lazy from "./lazy-render.js";
import * as Examples from "./studio-examples.js";
import * as Store from "./storage.js";
import * as Technique from "./technique-examples.js";
const { COMMUNITY } = Community;
// 예제의 파라미터(범위·기본값·색상)는 셰이더 소스의 @어노테이션 한곳에만 적는다.
// 코드를 복사해 다른 곳에 붙여도 슬라이더가 그대로 따라오게 하기 위해서다.
const params = sources =>
  Annotations.collect(sources)
    .filter(item => !item.error)
    .map(({ name, type, value, options }) => ({ name, type, value, options }));
const sourcesOf = item => {
  const project = item.project || { image: item.image, passes: [] };
  return [project.image, ...project.passes.map(pass => pass.fragment)];
};
const ONBOARD_KEY = "field.onboarded.v1";
const head = params => `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
${params}out vec4 fragColor;
`;
// 예제 공용 해시: 정수 해시(pcg3d)라 시간이 흘러 좌표가 커져도(스크롤·드리프트) 격자 무늬나 편향이 생기지 않는다.
const PCG = `uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}`;
const HASH = `// 정수 해시(pcg3d): 좌표 비트를 섞으므로 좌표가 아무리 커져도 고르다. 코드 조각 '해시 · 정수'의 uhash21과 같다.
${PCG}
float hash(vec2 p) { return float(pcg3d(uvec3(floatBitsToUint(p), 0u)).x >> 8u) * (1.0 / 16777216.0); }`;
// 한 번의 해시로 0~1 값 3개(칸 안 위치 x·y + 색 등)를 얻는다.
const HASH3 = `// 정수 해시(pcg3d) 한 번으로 서로 독립인 0~1 값 3개를 얻는다.
${PCG}
vec3 hash3(vec2 p) { return vec3(pcg3d(uvec3(floatBitsToUint(p), 0u)) >> 8u) * (1.0 / 16777216.0); }`;
const aurora =
  head(
    "uniform float uSpeed; // 흐름 속도 · @range 0 3 @step 0.01 @default 0.6 @group 흐름\nuniform float uWarp; // 비틀림 세기 · @range 0 10 @step 0.1 @default 4 @anim 20 @group 흐름\nuniform float uZoom; // 무늬 촘촘함 · @log @range 0.5 8 @default 2 @group 흐름\nuniform vec3 uTint; // 오로라 · @color @default 0.2 0.75 0.9 @group 색\nuniform vec3 uNight; // 밤하늘 · @color @default 0.02 0.03 0.08 @group 색\nuniform vec3 uAccent; // 소용돌이 강조 · @color @default 0.95 0.4 0.8 @group 색\nuniform vec3 uShine; // 가장자리 빛(1보다 밝게) · @color hdr 2 @default 0.1 0.225 0.25 @group 색\n"
  ) +
  `
// Domain warping: fbm으로 좌표를 두 번 비틀어 오로라 같은 흐름을 만든다.
${HASH}
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return v;
}
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    float t = uTime * uSpeed;
    vec2 p = uv * uZoom;
    vec2 q = vec2(fbm(p + t * 0.1), fbm(p + vec2(5.2, 1.3) - t * 0.08));
    vec2 r = vec2(fbm(p + uWarp * q + vec2(1.7, 9.2) + t * 0.15), fbm(p + uWarp * q + vec2(8.3, 2.8)));
    float f = fbm(p + uWarp * r);
    vec3 col = mix(uNight, uTint, smoothstep(0.2, 0.9, f));
    col = mix(col, uAccent, smoothstep(0.6, 1.2, length(q) * f));
    col += uShine * pow(r.y, 4.0);
    fragColor = vec4(pow(col, vec3(0.9)), 1.0);
}`;
const kaleido =
  head(
    "uniform float uSegments; // 조각 수(step이 잘아 재생하면 조각이 녹아 바뀐다) · @range 1 24 @step 0.01 @default 8 @anim 16 @group 모양\nuniform float uZoom; // 확대 · @log @range 0.2 4 @default 1.2 @group 모양\nuniform float uTwist; // 돌리기 · @angle @anim 20 @default 0 @group 모양\nuniform float uFlow; // 무늬 흐름 속도 · @range 0 3 @step 0.01 @default 1 @group 모양\nuniform sampler2D uPalette; // 빛깔(끝 색 = 처음 색이라 이어서 돈다) · @gradient @default 0 #ff4242 0.125 #da05a3 0.25 #8010ef 0.375 #255cfa 0.5 #00bdbd 0.625 #25fa5c 0.75 #7fef10 0.875 #daa305 1 #ff4242 @group 색\nuniform float uGlow; // 빛 세기 · @range 0.2 3 @step 0.01 @default 1 @group 색\n"
  ) +
  `
// 극좌표를 uSegments 조각으로 접어 만든 만화경. 마우스를 움직이면 중심이 따라간다.
// 빛깔은 uPalette 그라데이션을 한 바퀴 돌며 읽는다(fract). 끝 색과 처음 색을 같게 두면 이음매가 없다.
vec3 palette(float t) { return texture(uPalette, vec2(fract(t), 0.5)).rgb; }
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    if (uMouse.x >= 0.0) uv -= 0.25 * (uMouse - 0.5 * uResolution) / uResolution.y;
    float a = atan(uv.y, uv.x) + uTwist, r = length(uv), t = uTime * uFlow;
    float seg = 6.28318 / max(uSegments, 1.0);
    a = abs(mod(a, seg) - 0.5 * seg);
    vec2 p = r * vec2(cos(a), sin(a)) * uZoom;
    vec3 col = vec3(0.0);
    for (float i = 0.0; i < 4.0; i++) {
        p = fract(p * 1.5 + 0.1 * t) - 0.5;
        float d = length(p) * exp(-r);
        d = abs(sin(d * 8.0 + t) / 8.0);
        col += palette(r + i * 0.4 + t * 0.2) * pow(0.012 * uGlow / d, 1.2);
    }
    fragColor = vec4(col * smoothstep(1.4, 0.2, r), 1.0);
}`;
const lava =
  head(
    "uniform float uSoftness; // 녹아 붙는 정도 · @range 0.01 0.6 @step 0.01 @default 0.18 @anim 6 @group 덩어리\nuniform int uBlobs; // 덩어리 수 · @min 1 @max 12 @default 7 @group 덩어리\nuniform float uFlow; // 떠다니는 속도 · @range 0 3 @step 0.01 @default 1 @group 덩어리\nuniform vec3 uHot; // 뜨거운 겉 · @color @default 1 0.35 0.1 @group 색\nuniform vec3 uCore; // 가운데 · @color @default 1 0.95 0.8 @group 색\nuniform vec3 uCool; // 둘레 빛 · @color @default 0.5 0.1 0.6 @group 색\nuniform vec3 uBack; // 바탕 · @color @default 0.03 0.02 0.05 @group 색\nuniform sampler2D uFalloff; // 둘레 빛이 줄어드는 모양(거리 → 세기) · @curve @default 0 1 0.1 0.741 0.25 0.472 0.5 0.223 0.75 0.105 1 0.05 @group 색\n"
  ) +
  `
// 2D 메타볼: 원 거리장을 smooth-min으로 합쳐 서로 녹아 붙는 덩어리를 만든다.
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    float d = 1e3;
    float t = uTime * uFlow;
    for (int i = 0; i < 12; i++) {
        if (i >= uBlobs) break;
        float fi = float(i);
        vec2 c = 0.55 * vec2(sin(t * (0.31 + 0.07 * fi) + fi * 1.7), cos(t * (0.23 + 0.05 * fi) + fi * 2.3));
        d = smin(d, length(uv - c) - (0.12 + 0.04 * sin(fi + t)), uSoftness);
    }
    if (uMouse.x >= 0.0) d = smin(d, length(uv - (uMouse - 0.5 * uResolution) / uResolution.y) - 0.1, uSoftness);
    float edge = smoothstep(0.01, -0.01, d);
    // 둘레 빛: 겉에서 0.25만큼 떨어질 때까지를 곡선(uFalloff)으로 읽는다. 기본 곡선은 exp(-12·거리)와 같은 모양.
    float glow = texture(uFalloff, vec2(clamp(max(d, 0.0) * 4.0, 0.0, 1.0), 0.5)).r;
    vec3 col = mix(uBack, uCool, glow * 0.6);
    col = mix(col, mix(uHot, uCore, smoothstep(0.0, -0.15, d)), edge);
    fragColor = vec4(col, 1.0);
}`;
const horizon =
  head(
    "uniform float uGridSpeed; // 격자 속도 · @range 0 6 @step 0.01 @default 1.5 @group 바닥\nuniform vec3 uGlow; // 격자 빛(1보다 밝게 하면 번쩍인다) · @color hdr 4 @default 0.2 0.9 1 @group 바닥\nuniform float uGridSize; // 격자 칸 크기 · @log @range 0.25 4 @default 1 @group 바닥\nuniform sampler2D uSky; // 하늘(지평선 → 위) · @gradient smooth @default 0 #991a73 1 #0d051f @group 하늘과 해\nuniform sampler2D uSun; // 해(아래 → 위) · @gradient smooth @default 0 #ff4080 1 #ffd94d @group 하늘과 해\nuniform float uSunSize; // 해 크기 · @range 0.1 0.5 @step 0.005 @default 0.3 @group 하늘과 해\nuniform float uStripes; // 해 줄무늬 촘촘함 · @log @range 10 200 @default 60 @group 하늘과 해\n"
  ) +
  `
// 원근 격자와 줄무늬 태양: 화면 아래 절반을 바닥 평면으로 투영한다.
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    // 하늘·해 색은 그라데이션에서 읽는다. smooth 모드의 정지점 두 개 = 예전 mix(a, b, smoothstep(…))와 같다.
    vec3 sky = texture(uSky, vec2(clamp((uv.y + 0.2) / 0.6, 0.0, 1.0), 0.5)).rgb;
    vec3 col = sky;
    vec2 sp = uv - vec2(0.0, 0.12);
    float sun = smoothstep(uSunSize, uSunSize - 0.01, length(sp));
    float stripes = step(0.0, sin(sp.y * uStripes - uTime * 2.0)) + step(0.05, sp.y);
    vec3 sunCol = texture(uSun, vec2(clamp((sp.y + 0.3) / 0.6, 0.0, 1.0), 0.5)).rgb;
    col = mix(col, sunCol, sun * min(stripes, 1.0));
    if (uv.y < -0.05) {
        float z = 0.35 / (-uv.y - 0.03);
        vec2 g = vec2(uv.x * z, z + uTime * uGridSpeed) / uGridSize;
        vec2 w = fwidth(g);
        vec2 d = 0.5 - abs(fract(g) - 0.5); // 가장 가까운 격자선까지의 거리
        vec2 line = 1.0 - smoothstep(vec2(0.0), w * 1.5, d);
        float grid = max(line.x, line.y) * exp(-0.06 * z);
        col = mix(vec3(0.02, 0.0, 0.05), uGlow, grid) + uGlow * 0.15 * exp(-8.0 * (-uv.y - 0.05));
    }
    col += uGlow * 0.4 * exp(-60.0 * abs(uv.y + 0.05));
    fragColor = vec4(col, 1.0);
}`;
const truchet =
  head(
    "uniform float uScale; // 타일 수 · @log @range 2 20 @default 6 @group 무늬\nuniform float uSeed; // 미로 고르기 · @seed @range 0 999 @step 1 @default 0 @group 무늬\nuniform vec2 uFlow; // 흐르는 방향 · @dir @default 1 0 @group 무늬\nuniform float uFlowSpeed; // 흐르는 속도 · @range 0 2 @step 0.01 @default 0.25 @group 무늬\nuniform float uWidth; // 선 굵기 · @range 0.02 0.25 @step 0.005 @default 0.09 @group 무늬\nuniform vec3 uInk; // 잉크 · @color @default 0.15 0.2 0.55 @group 색\nuniform vec3 uPaper; // 종이 · @color @default 0.95 0.93 0.88 @group 색\n"
  ) +
  `
// Truchet 타일: 셀마다 무작위로 회전한 사분원 두 개가 끊김 없는 미로를 만든다.
${HASH}
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y * uScale + uFlow * uTime * uFlowSpeed;
    vec2 id = floor(uv), f = fract(uv) - 0.5;
    float h = hash(id + vec2(uSeed * 101.0, 0.0));   // uSeed가 바뀌면 칸마다 다른 해시 → 다른 미로
    if (h > 0.5) f.x = -f.x;
    vec2 c = f - sign(f.x + f.y + 1e-4) * 0.5;
    float d = abs(length(c) - 0.5);
    float w = uWidth + 0.04 * sin(uTime + h * 6.28);
    float px = uScale / uResolution.y;
    float line = smoothstep(w + px, w - px, d);
    float shade = 0.5 + 0.5 * sin(atan(c.y, c.x) * 2.0 + uTime * 3.0);
    vec3 col = mix(uPaper, uInk * (0.6 + 0.4 * shade), line);
    fragColor = vec4(col * (1.0 - 0.25 * length((gl_FragCoord.xy / uResolution) - 0.5)), 1.0);
}`;
const voronoi =
  head(
    "uniform float uScale; // 칸 수 · @log @range 1 16 @default 5 @group 무늬\nuniform float uSeed; // 칸 배치 고르기 · @seed @range 0 999 @step 1 @default 0 @group 무늬\nuniform float uWobble; // 점이 흔들리는 폭 · @range 0 0.5 @step 0.01 @default 0.38 @group 무늬\nuniform float uEdge; // 납 테두리 두께 · @range 0.01 0.3 @step 0.005 @default 0.08 @group 무늬\nuniform vec3 uLead; // 납 · @color @default 0.04 0.03 0.05 @group 색\nuniform sampler2D uGlass; // 유리 빛깔(끝 색 = 처음 색) · @gradient @default 0 #ff5555 0.125 #dd1eac 0.25 #8c28f1 0.375 #3b6cfa 0.5 #1ac4c4 0.625 #3bfa6c 0.75 #8cf128 0.875 #ddac1e 1 #ff5555 @group 색\nuniform float uShine; // 테두리에 번지는 빛 · @range 0 1 @step 0.01 @default 0.35 @group 색\n"
  ) +
  `
// 보로노이(셀) 무늬: 칸마다 해시로 점 하나를 두고, 픽셀에서 가장 가까운 점과 두 번째로 가까운 점을 찾는다.
// 점은 이웃 칸에도 있으므로 3×3 칸만 보면 된다. 두 거리의 차(d2 - d1)가 작을수록 경계에 가깝다.
${HASH3}
// 유리 빛깔은 uGlass 그라데이션을 한 바퀴 돌며 읽는다(fract).
vec3 palette(float t) { return texture(uGlass, vec2(fract(t), 0.5)).rgb; }
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    vec2 p = uv * uScale + uTime * vec2(0.15, 0.05);   // 계속 흐르므로 칸 번호가 커진다 → 정수 해시
    vec2 g = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    vec3 cell = vec3(0.0);
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(x, y);
        vec3 h = hash3(g + o + vec2(uSeed * 101.0, 0.0));         // xy = 점의 움직임 위상, z = 칸 색
        vec2 point = o + 0.5 + uWobble * sin(uTime * 0.7 + 6.2831 * h.xy);
        float d = length(point - f);
        if (d < d1) { d2 = d1; d1 = d; cell = h; } else if (d < d2) d2 = d;
    }
    float edge = d2 - d1;
    vec3 glass = palette(cell.z + 0.05 * uTime) * (0.65 + 0.35 * smoothstep(0.7, 0.0, d1)); // 가운데가 밝은 유리
    vec3 col = mix(uLead, glass, smoothstep(uEdge * 0.5, uEdge, edge));                      // 납 테두리
    col += glass * uShine * exp(-30.0 * edge);                                                  // 테두리에 번지는 빛
    fragColor = vec4(pow(col, vec3(0.95)), 1.0);
}`;
const starfield =
  head(
    "uniform float uSpeed; // 흐르는 속도 · @range 0 3 @step 0.01 @default 0.4 @group 별\nuniform vec2 uDrift; // 흐르는 방향 · @dir @default 1 0 @group 별\nuniform float uDensity; // 별이 있는 칸 비율 · @range 0.05 1 @step 0.01 @default 0.4 @group 별\nuniform int uLayers; // 겹 수(앞에서부터) · @min 1 @max 4 @default 4 @group 별\nuniform float uSeed; // 별 배치 고르기 · @seed @range 0 999 @step 1 @default 0 @group 별\nuniform vec3 uTint; // 먼 별 · @color @default 0.55 0.75 1 @group 색\nuniform vec3 uNear; // 가까운 별 · @color @default 1 0.9 0.8 @group 색\nuniform sampler2D uSky; // 밤하늘(아래 → 위) · @gradient smooth @default 0 #010205 1 #0a0514 @group 색\n"
  ) +
  `
// 시차(parallax) 별밭: 별이 든 격자를 4겹 겹쳐 서로 다른 속도로 흘린다. 앞 겹일수록 별이 크고 빠르다.
// 시간이 갈수록 좌표가 끝없이 커지지만 정수 해시라 몇 시간을 흘려도 별 배치에 무늬가 생기지 않는다.
${HASH3}
float stars(vec2 p, float t) {
    vec2 id = floor(p), f = fract(p) - 0.5;
    vec3 h = hash3(id + vec2(uSeed * 101.0, 0.0));
    float cut = 1.0 - uDensity;
    if (h.z < cut) return 0.0;                          // uDensity만큼의 칸에만 별
    vec2 pos = (h.xy - 0.5) * 0.6;                      // 칸 안 무작위 위치 (가장자리 여유를 남김)
    float d = length(f - pos);
    float twinkle = 0.6 + 0.4 * sin(t * (1.0 + 4.0 * h.x) + 6.2831 * h.y);
    float core = smoothstep(0.035 + 0.06 * (h.z - cut), 0.0, d);
    float glow = 0.004 / (d * d + 0.004) * smoothstep(0.45, 0.1, d);   // 칸 경계 전에 0으로 줄인다
    return twinkle * (core + 0.35 * glow);
}
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    vec3 col = texture(uSky, vec2(clamp((uv.y + 0.6) / 1.2, 0.0, 1.0), 0.5)).rgb;
    for (int i = 0; i < 4; i++) {
        if (i >= uLayers) break;
        float depth = 1.0 + float(i);                   // 1 = 가장 앞
        vec2 p = uv * (5.0 * depth) + uDrift * (uTime * uSpeed * 3.0 / depth) + vec2(0.0, 41.0 * float(i));
        vec3 tint = mix(uNear, uTint, float(i) / 3.0);
        col += tint * stars(p, uTime + 7.0 * float(i)) / depth;
    }
    fragColor = vec4(1.0 - exp(-1.6 * col), 1.0);      // 밝은 별이 하얗게 날아가지 않게 톤 매핑
}`;
const ART = [
  {
    id: "aurora",
    title: "Aurora Flow",
    tag: "Noise · Domain warp",
    description: "fbm으로 좌표를 두 번 비트는 도메인 워핑. 흐르는 오로라.",
    image: aurora,
  },
  {
    id: "kaleido",
    title: "Kaleido Bloom",
    tag: "Polar · Pattern",
    description: "극좌표 접기로 만든 만화경. 마우스로 중심을 옮겨 보세요.",
    image: kaleido,
  },
  {
    id: "lava",
    title: "Metaball Lava",
    tag: "SDF · 2D",
    description: "smooth-min으로 녹아 붙는 메타볼. 커서도 덩어리가 됩니다.",
    image: lava,
  },
  {
    id: "horizon",
    title: "Neon Horizon",
    tag: "Projection · Grid",
    description: "화면 하단을 바닥 평면으로 투영한 원근 격자와 줄무늬 태양.",
    image: horizon,
  },
  {
    id: "truchet",
    title: "Truchet Weave",
    tag: "Tiling · Hash",
    description: "셀마다 무작위로 뒤집힌 사분원이 끝없는 미로를 엮습니다.",
    image: truchet,
  },
  {
    id: "voronoi",
    title: "Voronoi Glass",
    tag: "Cellular · Hash",
    description: "칸마다 해시로 둔 점이 흔들리는 셀 무늬 스테인드글라스.",
    image: voronoi,
  },
  {
    id: "starfield",
    title: "Starfield Drift",
    tag: "Layers · Hash",
    description: "속도가 다른 별 격자 4겹이 끝없이 흐르는 시차 별밭.",
    image: starfield,
  },
];
// ---- 기법 배우기: 기능 하나씩을 보여주는 작은 프로젝트. 주석이 곧 설명서다. ----
// 어노테이션 안내 예제: 지금 있는 태그를 모두 한 장면에 쓴다. 각 줄 주석이 "이 태그는 이렇게 쓴다"는 설명을 겸한다.
// 장면: 빛을 받는 행성(툰 셰이딩) + 도는 위성 + 흐르는 별 + 빛 번짐. 보기(uView)로 명암·거리장·램프를 따로 볼 수 있다.
const annotated = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
// ── 주석 어노테이션 안내 ─────────────────────────────────────────────────────────────
// 선언 줄 끝 주석에 @태그를 달면 컴파일할 때 파라미터 패널에 맞는 조절기가 생긴다. 첫 @ 앞의 글은 설명이 된다.
// 범위: @range min max [step] · @min/@max/@step · 기본값: @default(값 하나면 모든 성분, 45deg는 라디안으로)
// 표시 방식(하나만): @color [hdr 최대] · @dir [hemi] · @angle · @pos(@xy) · @log · @enum 이름…
// 덧붙이기: @seed(🎲) · @anim [초](▶) · @group 이름(접히는 묶음) · 램프: sampler2D에 @gradient / @curve
// ── 모양 ──
uniform float uRadius;   // 행성 크기 · @range 0.1 0.4 0.005 @default 0.24 @group 모양
uniform int   uCount;    // 위성 수(▶: int는 한 칸씩 왕복) · @min 0 @max 9 @default 5 @anim 6 @group 모양
uniform float uOrbit;    // 궤도 반지름 · @range 0.3 0.8 @step 0.01 @default 0.5 @group 모양
uniform float uSpin;     // 위성 돌리기(▶: 한 바퀴씩) · @angle @default 30deg @anim 12 @group 모양
uniform vec2  uCenter;   // 화면 중심(xy 태그도 같다) · @pos @range -1 1 @default 0 @group 모양
uniform float uZoom;     // 확대(로그 눈금: 0.25~4를 고르게) · @log @range 0.25 4 @default 1 @group 모양
// ── 빛 ──
uniform vec3  uLightDir; // 빛 방향(위쪽 반구만) · @dir hemi @default 0.55 0.6 0.58 @group 빛
uniform vec3  uLight;    // 빛 색(밝기 배율로 1보다 밝게) · @color hdr 4 @default 1.3 1.2 1 @group 빛
uniform sampler2D uToon; // 명암 계단(빛 세기 → 색, step = 툰) · @gradient step @default 0 #141833 0.3 #33438a 0.65 #7c9cf0 0.92 #e8f0ff @group 빛
uniform sampler2D uGlow; // 빛 번짐(거리 → 세기) · @curve @default 0 1 0.15 0.4 0.45 0.1 1 0 @group 빛
uniform float uGlowSize; // 빛 번짐 범위 · @range 0.05 0.6 @step 0.01 @default 0.3 @group 빛
// ── 배경 ──
uniform vec3  uBack;     // 바탕 · @color @default 0.02 0.02 0.04 @group 배경
uniform sampler2D uSky;  // 하늘(아래 → 위) · @gradient smooth @default 0 #120a2e 0.6 #05060f 1 #000000 @group 배경
uniform sampler2D uMoons;// 위성 색(첫 위성 → 마지막) · @gradient linear @default 0 #ffb347 0.5 #ff5e7e 1 #8f7bff @group 배경
uniform float uStars;    // 별 밀도 · @range 0 1 @step 0.01 @default 0.35 @group 배경
uniform float uSeed;     // 별 배치(🎲) · @seed @range 0 999 @step 1 @default 0 @group 배경
uniform vec2  uDrift;    // 별이 흐르는 방향 · @dir @default 1 0.25 @group 배경
uniform float uTwinkle;  // 위성 깜빡임(▶: 범위를 왕복) · @range 0 1 @step 0.01 @default 0.4 @anim 3 @group 배경
// ── 보기 ──
uniform int   uView;     // 보기(▶: 차례로) · @enum 결과 명암만 거리장 램프 @default 0 @anim 2
uniform bool  uOrbitLine;// 궤도선 · @default true
out vec4 fragColor;
${HASH}
// 램프 읽기: 그라데이션은 .rgb(0~1 위치의 색), 곡선은 .r(x의 y). 0~1 밖은 끝 값으로 고정된다.
vec3 ramp(sampler2D s, float t) { return texture(s, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb; }
float curve(sampler2D s, float x) { return texture(s, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y / uZoom - uCenter * 0.5;
    float px = 1.5 / uResolution.y / uZoom;
    // 하늘 + 흐르는 별(uSeed가 배치를, uDrift가 방향을 정한다)
    vec3 col = uBack + ramp(uSky, gl_FragCoord.y / uResolution.y);
    vec2 sp = uv * 14.0 + uDrift * uTime * 0.5;
    vec2 id = floor(sp), f = fract(sp) - 0.5;
    float h = hash(id + vec2(uSeed * 101.0, 0.0));
    vec2 at = vec2(hash(id + vec2(17.0, uSeed)), hash(id + vec2(uSeed, 29.0))) - 0.5;
    col += step(1.0 - uStars * 0.3, h) * smoothstep(0.06, 0.0, length(f - at * 0.7)) * 0.9;
    // 행성: 구의 법선으로 빛 세기를 구하고, 그 세기를 명암 계단(uToon)에서 색으로 바꾼다
    float dPlanet = length(uv) - uRadius;
    vec3 n = vec3(uv / uRadius, 0.0);
    n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
    float light = max(dot(n, uLightDir), 0.0);
    vec3 planet = ramp(uToon, light) * uLight;
    // 위성: 개수(uCount)만큼 궤도에 늘어놓고, 위성 색 그라데이션에서 순서대로 색을 읽는다
    float dMoon = 1e3;
    vec3 moon = vec3(0.0);
    for (int i = 0; i < 9; i++) {
        if (i >= uCount) break;
        float k = float(i) / float(max(uCount, 1));
        float a = uSpin + 6.28318 * k + uTime * 0.25;
        float d = length(uv - uOrbit * vec2(cos(a), sin(a))) - uRadius * 0.2;
        if (d < dMoon) {
            dMoon = d;
            moon = ramp(uMoons, float(i) / max(float(uCount - 1), 1.0)) * (1.0 - uTwinkle * 0.5 * (0.5 + 0.5 * sin(uTime * 4.0 + float(i))));
        }
    }
    float dScene = min(dPlanet, dMoon);
    // 빛 번짐: 가장 가까운 물체까지의 거리를 곡선(uGlow)으로 세기로 바꾼다
    col += uLight * 0.35 * curve(uGlow, max(dScene, 0.0) / uGlowSize);
    if (uOrbitLine) col += vec3(0.35, 0.45, 0.9) * 0.3 * (1.0 - smoothstep(0.0, px * 2.0, abs(length(uv) - uOrbit)));
    col = mix(col, moon, 1.0 - smoothstep(-px, px, dMoon));
    col = mix(col, planet, 1.0 - smoothstep(-px, px, dPlanet));
    // 보기: 1 명암만 · 2 거리장(등고선, 안쪽은 주황) · 3 램프 넷을 띠로(위부터 하늘·명암·위성·빛 번짐 곡선)
    if (uView == 1) col = vec3(0.06 + 0.94 * light) * step(dPlanet, 0.0);   // 그림자 쪽도 옅게 남겨 윤곽이 보이게
    else if (uView == 2) col = mix(vec3(0.25, 0.55, 1.0), vec3(1.0, 0.55, 0.2), step(dScene, 0.0)) * (0.55 + 0.45 * cos(dScene * 120.0));
    else if (uView == 3) {
        vec2 q = gl_FragCoord.xy / uResolution;
        float band = floor(q.y * 4.0);
        col = band == 3.0 ? ramp(uSky, q.x) : band == 2.0 ? ramp(uToon, q.x) : band == 1.0 ? ramp(uMoons, q.x) : vec3(0.06);
        if (band == 0.0) col += vec3(1.0, 0.8, 0.3) * (1.0 - smoothstep(0.0, 0.012, abs(q.y * 4.0 - curve(uGlow, q.x))));
    }
    fragColor = vec4(col, 1.0);
}`;
const hashPrecision = `#version 300 es
precision highp float;
uniform vec2 uResolution;
// 해시와 큰 좌표: 같은 칸 번호를 두 해시에 넣어 비교한다. 왼쪽 = 실수 해시(예전 방식), 오른쪽 = 정수 해시.
// 해시 값이 상위 4%인 칸만 점으로 찍으면 규칙성이 눈에 잘 띈다. 무작위라면 점이 어디에도 줄지어 서지 않는다.
// uOffset을 0부터 올려 보세요. 실수 해시는 수십만부터 점이 행·열로 줄을 서고, 천만 근처에서는 격자가 됩니다.
uniform float uOffset;  // 칸 번호에 더할 값(▶로 0 ↔ 1천만을 오간다) · @range 0 10000000 @step 1000 @default 10000000 @anim 20
uniform float uCell;    // 칸 크기(px) · @range 1 8 @step 1 @default 2
uniform int   uShowRaw; // 보기 · @enum 상위_4%만_점으로 해시_값_그대로 @default 0
out vec4 fragColor;
// 예전 방식: fract로 소수부만 남겨 섞는다(Hoskins "Hash without Sine"). float의 유효숫자 24비트에 묶인다.
float hashFloat(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
// 정수 해시: float의 비트를 uint로 읽어 곱셈·xor·시프트로 섞는다. 크기와 관계없이 고르다.
${PCG}
float hashInt(vec2 p) { return float(pcg3d(uvec3(floatBitsToUint(p), 0u)).x >> 8u) * (1.0 / 16777216.0); }
void main() {
    vec2 cell = floor(gl_FragCoord.xy / uCell) + uOffset;       // 칸 번호 (정수값, 1천만까지 float로 정확)
    bool right = gl_FragCoord.x > 0.5 * uResolution.x;
    float h = right ? hashInt(cell) : hashFloat(cell);
    vec3 col = uShowRaw == 1 ? vec3(h) : vec3(step(0.96, h));   // 0: 상위 4%만 점으로 · 1: 해시 값 그대로
    float divider = 1.0 - smoothstep(1.0, 2.0, abs(gl_FragCoord.x - 0.5 * uResolution.x));
    fragColor = vec4(mix(col, vec3(1.0, 0.55, 0.2), divider), 1.0);
}
// 참고: 노이즈처럼 소수부가 필요한 계산은 좌표 자체가 수백만이면 float에 소수부가 남지 않는다.
// 그럴 때는 격자 번호(정수)와 칸 안 위치(소수)를 따로 계산해 해시에는 정수부만 넘기세요.
`;
// 키보드로 점 움직이기: Buffer A(1×1)가 점의 상태를 저장한다. iChannel0 = A · previous(직전 상태), iChannel1 = 키보드.
// 뷰포트를 클릭하면 키가 셰이더로 간다. 방향키·WASD로 이동, Space로 색 바꾸기(토글), Esc로 빠져나오기.
const keyboardState = `#version 300 es
precision highp float;
// Buffer A (1×1 상태 버퍼): xy = 점의 위치(0~1), z = 색 토글, w = Space를 누른 횟수
uniform int uFrame;
uniform float uDeltaTime;
uniform sampler2D iChannel0;   // A · previous
uniform sampler2D iChannel1;   // 키보드
out vec4 fragColor;

const int KEY_LEFT = 37, KEY_UP = 38, KEY_RIGHT = 39, KEY_DOWN = 40, KEY_SPACE = 32;
const int KEY_A = 65, KEY_D = 68, KEY_S = 83, KEY_W = 87;
float keyDown(int k)    { return texelFetch(iChannel1, ivec2(k, 0), 0).x; }
float keyPressed(int k) { return texelFetch(iChannel1, ivec2(k, 1), 0).x; }
float keyToggled(int k) { return texelFetch(iChannel1, ivec2(k, 2), 0).x; }

void main() {
    vec4 state = uFrame == 0 ? vec4(0.5, 0.5, 0.0, 0.0) : texelFetch(iChannel0, ivec2(0), 0);
    vec2 dir = vec2(max(keyDown(KEY_RIGHT), keyDown(KEY_D)) - max(keyDown(KEY_LEFT), keyDown(KEY_A)),
                    max(keyDown(KEY_UP), keyDown(KEY_W)) - max(keyDown(KEY_DOWN), keyDown(KEY_S)));
    if (dot(dir, dir) > 0.0) dir = normalize(dir);
    state.xy = clamp(state.xy + dir * 0.5 * uDeltaTime, 0.03, 0.97);
    state.z = keyToggled(KEY_SPACE);     // 누를 때마다 켜짐/꺼짐
    state.w += keyPressed(KEY_SPACE);    // 누른 순간 한 번만 더해진다
    fragColor = state;
}`;
const keyboardImage = `#version 300 es
precision highp float;
// Image: A의 상태를 읽어 점을 그리고, 방향키 네 개의 눌림 상태를 아래에 보여 준다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;   // A · current
uniform sampler2D iChannel1;   // 키보드
out vec4 fragColor;

float keyDown(int k) { return texelFetch(iChannel1, ivec2(k, 0), 0).x; }
float box(vec2 p, vec2 c, float r) { vec2 d = abs(p - c) - r; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution, aspect = vec2(uResolution.x / uResolution.y, 1.0);
    vec4 state = texelFetch(iChannel0, ivec2(0), 0);
    vec3 col = mix(vec3(0.05, 0.06, 0.09), vec3(0.11, 0.13, 0.2), uv.y);
    // 점: Space 토글로 색이 바뀐다. 누른 횟수(w)만큼 고리가 생긴다.
    float d = length((uv - state.xy) * aspect);
    vec3 dotColor = state.z > 0.5 ? vec3(1.0, 0.5, 0.2) : vec3(0.3, 0.75, 1.0);
    col = mix(col, dotColor, smoothstep(0.032, 0.028, d));
    float rings = min(state.w, 6.0);
    col += dotColor * 0.5 * smoothstep(0.004, 0.0, abs(d - 0.05 - 0.012 * floor(mod(rings, 7.0)))) * step(0.5, rings);
    // 방향키 표시(←↓→, ↑): 누르면 밝아진다
    vec2 p = (uv - vec2(0.5, 0.11)) * aspect / 0.05;
    float k[4] = float[4](keyDown(37), keyDown(40), keyDown(39), keyDown(38));
    vec2 at[4] = vec2[4](vec2(-1.1, 0.0), vec2(0.0, 0.0), vec2(1.1, 0.0), vec2(0.0, 1.1));
    for (int i = 0; i < 4; i++) {
        float b = box(p, at[i], 0.45);
        col = mix(col, mix(vec3(0.22, 0.25, 0.32), vec3(0.95), k[i]), smoothstep(0.04, 0.0, b));
    }
    fragColor = vec4(col, 1.0);
}`;
const mrtSource = `#version 300 es
precision highp float;
// Buffer A · Out = 2 (MRT). 한 번의 실행으로 두 출력에 서로 다른 데이터를 쓴다.
uniform vec2 uResolution;
uniform float uTime;
layout(location = 0) out vec4 outColor;  // 출력 0: 보이는 색
layout(location = 1) out vec4 outField;  // 출력 1: 거리장 데이터(채널 선택에서 A[1])
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    float d = 1e3;
    for (int i = 0; i < 5; i++) {
        float t = uTime * 0.6 + float(i) * 1.26;
        d = min(d, length(uv - 0.5 * vec2(cos(t), sin(t * 1.3))) - 0.12);
    }
    outColor = vec4(0.5 + 0.5 * cos(6.28 * (uv.x + uTime * 0.1) + vec3(0, 2, 4)), 1.0) * step(d, 0.0);
    outField = vec4(d, d, d, 1.0);
}`;
const mrtImage = `#version 300 es
precision highp float;
// Image: iChannel0 = A[0] (색), iChannel1 = A[1] (거리장). 왼쪽은 색, 오른쪽은 거리장을 등고선으로 표시.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    if (uv.x < 0.5) { fragColor = texture(iChannel0, uv); return; }
    float d = texture(iChannel1, uv).r;
    vec3 col = d < 0.0 ? vec3(1.0, 0.55, 0.2) : vec3(0.25, 0.55, 1.0);
    col *= 0.6 + 0.4 * cos(120.0 * d);                  // 등고선
    col = mix(col, vec3(1.0), 1.0 - smoothstep(0.0, 0.006, abs(d)));
    fragColor = vec4(col, 1.0);
}`;
const mipSource = `#version 300 es
precision highp float;
// Buffer A · Mip 켜짐. 선명한 패턴을 그리면 매 프레임 밉맵(축소 사본)이 자동 생성된다.
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    vec2 g = fract(uv * 6.0 + uTime * 0.2) - 0.5;
    float ring = abs(fract(length(uv) * 8.0 - uTime * 0.5) - 0.5);
    vec3 col = 0.5 + 0.5 * cos(6.28 * length(uv) + vec3(0, 2, 4) + uTime);
    fragColor = vec4(col * step(0.25, ring) * step(abs(g.x) + abs(g.y), 0.45), 1.0);
}`;
const mipImage = `#version 300 es
precision highp float;
// Image: textureLod로 밉 레벨을 골라 읽는다. 위아래로 갈수록 높은 레벨 = 더 흐림 (틸트 시프트).
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform float uBlur;  // 가장 흐린 곳의 밉 레벨 · @range 0 8 @step 0.1 @default 5
uniform float uFocus; // 또렷한 줄의 높이(▶로 위아래로 훑는다) · @range 0 1 @step 0.01 @default 0.5 @anim 8
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float lod = uBlur * smoothstep(0.05, 0.45, abs(uv.y - uFocus));
    fragColor = textureLod(iChannel0, uv, lod);
}`;
// 블룸(Bloom) 후처리: 밝은 빛이 주변으로 번져 보이는 효과. 장면 → 밝은 부분 추출 → 흐리게 → 합성 → 톤 매핑.
// 버퍼를 이어 쓰는 후처리의 기본 모양이라 단계마다 패스를 나눴다. 각 패스를 미리보기로 골라 단계별 결과를 볼 수 있다.
const bloomScene = `#version 300 es
precision highp float;
// Buffer A · 장면 · RGBA16F(HDR). 블룸의 재료: 밝기가 1을 넘는 빛.
// 화면(8비트)은 1보다 밝은 값을 그냥 하얗게 자르지만, 16비트 실수 버퍼는 "얼마나 밝은지"를 그대로 기억한다.
// RGBA8 버퍼였다면 3짜리 네온과 0.9짜리 흰 사각형이 똑같이 1로 잘려, 무엇이 번져야 하는지 알 수 없다.
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;
vec3 hue(float t) { return 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67))); }
void main() {
    // 짧은 변 기준 좌표: 화면이 가로로 길든 세로로 길든 가운데 -1~1 정사각형 안의 것이 다 보인다
    float side = min(uResolution.x, uResolution.y);
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / side;
    float px = 2.0 / side;                                // 픽셀 하나의 크기(테두리를 부드럽게)
    vec3 col = vec3(0.015, 0.02, 0.035) * (1.3 - 0.4 * length(p));   // 어두운 배경(1보다 한참 작다 → 번지지 않는다)
    // 네온 고리: 밝기 4
    float ring = abs(length(p - vec2(-0.5, 0.4)) - 0.28) - 0.012;
    col += vec3(0.15, 0.75, 1.0) * 4.0 * (1.0 - smoothstep(0.0, px, ring));
    // 네온 막대: 밝기 2 — 기준값(uThreshold)을 올리면 이 막대부터 번지지 않는다
    vec2 q = abs(p - vec2(0.0, -0.62)) - vec2(0.55, 0.012);
    col += vec3(1.0, 0.3, 0.6) * 2.0 * (1.0 - smoothstep(0.0, px, max(q.x, q.y)));
    // 흰 사각형: 밝기 0.9 — 화면에서는 거의 하얗지만 1보다 어두워 번지지 않는다(비교용)
    vec2 b = abs(p - vec2(0.55, 0.45)) - vec2(0.14);
    col = mix(col, vec3(0.9), 1.0 - smoothstep(0.0, px, max(b.x, b.y)));
    // 떠다니는 빛 구슬 3개: 밝기 10
    for (int i = 0; i < 3; i++) {
        float f = float(i);
        vec2 c = vec2(0.0, -0.05) + vec2(0.6, 0.32) * vec2(cos(uTime * 0.6 + f * 2.1), sin(uTime * 0.8 + f * 1.7));
        col += hue(f * 0.31 + 0.1) * 10.0 * (1.0 - smoothstep(0.035, 0.035 + px, length(p - c)));
    }
    fragColor = vec4(col, 1.0);
}`;
const bloomBright = `#version 300 es
precision highp float;
// Buffer B · 밝은 부분 추출 · RGBA16F · 해상도 0.5 · Mip 켜짐. iChannel0 = A (current)
// 기준값보다 밝은 만큼만 남긴다. 그대로 자르면(max(c - 기준, 0)) 경계가 뚝 끊기므로 knee 구간에서 부드럽게 시작한다.
// 절반 해상도로 줄여도 어차피 흐리게 만들 것이라 티가 안 나고, 계산은 1/4로 준다.
// Mip을 켜 두면 매 프레임 1/2, 1/4, 1/8 … 크기 사본(밉맵)이 저절로 생긴다 → Image가 이것을 흐린 사본으로 쓴다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform float uThreshold; // 이 밝기부터 번진다 · @range 0 4 @step 0.01 @default 1 @group 밝은 부분 추출
uniform float uKnee;      // 경계를 부드럽게 하는 폭 · @range 0 1 @step 0.01 @default 0.5 @group 밝은 부분 추출
out vec4 fragColor;
void main() {
    vec3 c = texture(iChannel0, gl_FragCoord.xy / uResolution).rgb;
    float bright = max(c.r, max(c.g, c.b));
    // soft knee: 기준값 - knee부터 서서히 커지다가 기준값 위에서는 (밝기 - 기준값)이 된다
    float knee = max(uKnee, 1e-4), soft = clamp(bright - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee);
    float amount = max(soft, bright - uThreshold) / max(bright, 1e-4);
    fragColor = vec4(c * amount, 1.0);
}`;
const bloomImage = `#version 300 es
precision highp float;
// Image · 합성. iChannel0 = A (current) 원래 장면, iChannel1 = B (current) 밝은 부분(밉맵 있음)
// 1) 흐리게: B의 밉 레벨 0~6을 겹친다. 레벨이 하나 오를 때마다 크기가 반이라, 같은 픽셀이 두 배 넓게 번진다.
//    레벨마다 가운데와 둘레 8곳을 1:2:1 무게로 읽어(3×3 텐트 필터) 밉맵의 네모난 계단을 숨긴다.
//    (대각선 4곳만 읽으면 작은 빛 둘레가 X자로 번진다.) 가우시안 블러 패스를 여러 번 도는 것보다 훨씬 싸다.
// 2) 합성: 장면 + 블룸 × 세기. 3) 노출을 곱하고 톤 매핑으로 1보다 밝은 값을 화면 범위(0~1)로 눌러 담는다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform float uIntensity; // 블룸 세기 · @range 0 3 @step 0.01 @default 0.8 @group 합성
uniform float uRadius;    // 겹칠 밉 레벨 수(클수록 넓게 번짐) · @range 1 7 @step 0.1 @default 6 @group 합성
uniform float uExposure;  // 노출(배율) · @log @range 0.05 8 @default 1 @group 화면에 담기
uniform int uToneMap;     // 톤 매핑(▶로 차례로 비교) · @enum 자르기 Reinhard ACES @default 2 @anim 2 @group 화면에 담기
uniform bool uCompare;    // 왼쪽 절반은 블룸 없이 보여 준다 · @default false @group 화면에 담기
out vec4 fragColor;
vec3 blurLevel(vec2 uv, int lod) {
    vec2 texel = 1.0 / vec2(textureSize(iChannel1, lod));
    float l = float(lod);
    vec3 sum = vec3(0.0);
    for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
            float w = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0);   // 1 2 1 / 2 4 2 / 1 2 1
            sum += w * textureLod(iChannel1, uv + texel * vec2(x, y), l).rgb;
        }
    return sum / 16.0;
}
vec3 toneMap(vec3 c) {
    if (uToneMap == 1) return c / (1.0 + c);                                        // Reinhard: 단순, 밝은 색이 바랜다
    if (uToneMap == 2) return clamp(c * (2.51 * c + 0.03) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);   // ACES(근사): 영화 같은 대비
    return clamp(c, 0.0, 1.0);                                                      // 자르기: 1보다 밝으면 하얗게 날아간다
}
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 scene = texture(iChannel0, uv).rgb, bloom = vec3(0.0);
    float total = 0.0;
    for (int lod = 0; lod < 7; lod++) {
        float w = clamp(uRadius - float(lod), 0.0, 1.0);   // 소수 부분만큼 마지막 레벨을 부드럽게 더한다
        bloom += w * blurLevel(uv, lod);
        total += w;
    }
    bloom /= max(total, 1.0);
    bool plain = uCompare && uv.x < 0.5;
    vec3 hdr = (scene + (plain ? vec3(0.0) : bloom * uIntensity)) * uExposure;
    vec3 col = pow(toneMap(hdr), vec3(1.0 / 2.2));                                 // 감마: 선형 값 → 화면 값
    if (uCompare) col = mix(col, vec3(1.0), 1.0 - smoothstep(0.0, 1.5 / uResolution.x, abs(uv.x - 0.5)));
    fragColor = vec4(col, 1.0);
}`;
const reactionSource = `#version 300 es
precision highp float;
// Buffer A · 512×512 고정 · RGBA16F · Wrap Repeat · iChannel0 = A previous (자기 자신의 지난 프레임)
// Gray-Scott 반응-확산: r = 물질 U, g = 물질 V. 매 프레임 한 단계씩 시뮬레이션한다.
uniform vec2 uResolution;
uniform int uFrame;
uniform vec4 uMouse;          // 누르고 있는 동안 커서 주변에 V를 심는다
uniform sampler2D iChannel0;
uniform float uFeed;          // 먹이 공급률 F(U를 채운다) · @range 0.01 0.09 @step 0.0005 @default 0.037 @group 반응
uniform float uKill;          // 제거율 k(V를 없앤다) · @range 0.04 0.07 @step 0.0005 @default 0.06 @group 반응
out vec4 fragColor;
${HASH}
void main() {
    vec2 px = 1.0 / uResolution, uv = gl_FragCoord.xy * px;
    if (uFrame == 0) {   // 초기 상태: U=1, 무작위 점과 중앙 사각형에만 V
        float seed = step(0.997, hash(floor(gl_FragCoord.xy / 6.0))) + step(abs(uv.x - 0.5), 0.04) * step(abs(uv.y - 0.5), 0.04);
        fragColor = vec4(1.0, min(seed, 1.0), 0.0, 1.0);
        return;
    }
    vec2 c = texture(iChannel0, uv).rg;
    // 9점 라플라시안 (가중치 합 = 1)
    vec2 lap = -c
        + 0.2  * (texture(iChannel0, uv + vec2(px.x, 0)).rg + texture(iChannel0, uv - vec2(px.x, 0)).rg
                + texture(iChannel0, uv + vec2(0, px.y)).rg + texture(iChannel0, uv - vec2(0, px.y)).rg)
        + 0.05 * (texture(iChannel0, uv + px).rg + texture(iChannel0, uv - px).rg
                + texture(iChannel0, uv + vec2(px.x, -px.y)).rg + texture(iChannel0, uv + vec2(-px.x, px.y)).rg);
    float u = c.r, v = c.g, uvv = u * v * v;
    u += 1.0 * lap.r - uvv + uFeed * (1.0 - u);
    v += 0.5 * lap.g + uvv - (uKill + uFeed) * v;
    if (uMouse.z > 0.0 && length(gl_FragCoord.xy - uMouse.xy) < 10.0) v = 1.0;
    fragColor = vec4(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0), 0.0, 1.0);
}`;
const reactionImage = `#version 300 es
precision highp float;
// Image: iChannel0 = A current. 시뮬레이션 값(V)을 색으로 바꿔 보여준다. 화면을 누르고 끌어 보세요.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
// 농도 V(0~1)를 그라데이션에서 색으로 읽는다. 정지점 위치가 곧 "어느 농도부터 이 색"이다.
uniform sampler2D uPalette; // 농도 V → 색 · @gradient smooth @default 0.12 #080514 0.4 #59f2ff 0.6 #d9ffff
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float v = texture(iChannel0, uv).g;
    fragColor = vec4(texture(uPalette, vec2(v, 0.5)).rgb, 1.0);
}`;
// 기존 Studio 예제(멀티 패스·3D)는 Studio가 소유한 정의를 그대로 호출한다. project가 있는 항목은 갤러리가 직접 정의한다.
// users 없이 열면 소스의 @어노테이션이 파라미터를 자동 등록한다(어노테이션 기능 자체를 보여주기 위함).
const LESSONS = [
  {
    id: "annotations",
    title: "Annotated Parameters",
    tag: "모든 @태그 한눈에",
    description: "주석 태그만으로 만드는 모든 조절기: 색·방향·각도·패드·로그·선택지·🎲·▶·묶음·그라데이션·곡선.",
    image: annotated,
    thumb: "annotations",
    project: { image: annotated, passes: [], imageChannels: {} },
  },
  {
    id: "hashprecision",
    title: "Hash Precision",
    tag: "Hash · 큰 좌표",
    description: "실수 해시와 정수 해시를 나란히 비교. 좌표가 커지면 실수 해시에만 격자가 생깁니다.",
    image: hashPrecision,
    thumb: "hashprecision",
    project: { image: hashPrecision, passes: [], imageChannels: {} },
  },
  {
    id: "reaction",
    title: "Reaction–Diffusion",
    tag: "Fixed size · RGBA16F · Repeat",
    description: "고정 해상도 피드백 시뮬레이션. 화면을 눌러 끌면 패턴을 심습니다.",
    thumb: "reaction",
    project: {
      image: reactionImage,
      passes: [
        {
          name: "A",
          fragment: reactionSource,
          format: "rgba16f",
          scale: 1,
          size: [512, 512],
          wrap: "repeat",
          channels: { 0: { buffer: "A", frame: "previous" } },
        },
      ],
      imageChannels: { 0: { buffer: "A", frame: "current" } },
    },
  },
  {
    id: "keyboard",
    title: "Keyboard Control",
    tag: "키보드 입력 · 상태 버퍼",
    description: "뷰포트를 클릭하고 방향키·WASD로 점을 움직이기. Space로 색 바꾸기, Esc로 나가기.",
    thumb: "keyboard",
    project: {
      image: keyboardImage,
      passes: [
        {
          name: "A",
          fragment: keyboardState,
          format: "rgba16f",
          scale: 1,
          size: [1, 1],
          filter: "nearest",
          channels: { 0: { buffer: "A", frame: "previous" }, 1: { keyboard: true } },
        },
      ],
      imageChannels: { 0: { buffer: "A", frame: "current" }, 1: { keyboard: true } },
    },
  },
  {
    id: "mrt",
    title: "MRT Outputs",
    tag: "Out = 2 · A[1]",
    description: "한 패스에서 색과 거리장을 동시에 쓰고 Image에서 따로 읽기.",
    thumb: "mrt",
    project: {
      image: mrtImage,
      passes: [{ name: "A", fragment: mrtSource, format: "rgba16f", scale: 1, outputs: 2, channels: {} }],
      imageChannels: { 0: { buffer: "A", frame: "current" }, 1: { buffer: "A", frame: "current", attachment: 1 } },
    },
  },
  {
    id: "mipblur",
    title: "Mipmap Blur",
    tag: "Mip · textureLod",
    description: "밉맵 레벨을 골라 읽는 저비용 블러(틸트 시프트).",
    thumb: "mipblur",
    project: {
      image: mipImage,
      passes: [{ name: "A", fragment: mipSource, format: "rgba8", scale: 1, mipmap: true, channels: {} }],
      imageChannels: { 0: { buffer: "A", frame: "current" } },
    },
  },
  {
    id: "bloom",
    title: "Bloom",
    tag: "Post-process · HDR · Mip",
    description: "장면 → 밝은 부분 추출 → 밉맵으로 흐리게 → 합성 → 톤 매핑. 단계마다 패스를 나눈 후처리의 기본.",
    thumb: "bloom",
    project: {
      image: bloomImage,
      passes: [
        { name: "A", fragment: bloomScene, format: "rgba16f", scale: 1, channels: {} },
        {
          name: "B",
          fragment: bloomBright,
          format: "rgba16f",
          scale: 0.5,
          mipmap: true,
          channels: { 0: { buffer: "A", frame: "current" } },
        },
      ],
      imageChannels: { 0: { buffer: "A", frame: "current" }, 1: { buffer: "B", frame: "current" } },
    },
  },
  // 주제가 큰 예제(PBR · 볼류메트릭 구름 · 2D 유체)는 technique-examples.js에 있다.
  ...Technique.LESSONS,
  {
    id: "raymarch",
    title: "Ray Marching SDF",
    tag: "3D · 키보드 카메라",
    description: "SDF 장면, 키보드·드래그 카메라(상태 버퍼), 스텝 히트맵 디버그.",
    action: "exampleRaymarch",
    thumb: "raymarch",
  },
  {
    id: "pipeline",
    title: "Buffer Pipeline",
    tag: "Multi-pass",
    description: "A → B 후처리 → Image. 버퍼 연결의 기본.",
    action: "examplePipeline",
    thumb: "pipeline",
  },
  {
    id: "feedback",
    title: "Feedback Trails",
    tag: "Multi-pass · previous",
    description: "이전 프레임을 읽어 잔상을 누적하는 피드백 루프.",
    action: "exampleFeedback",
    thumb: "feedback",
  },
];
// preview: { pause() → 멈췄으면 true, resume(), size() → { width, height } } — 성능을 재는 동안 메인 미리보기를 멈추고,
// 배지는 미리보기가 지금 그리는 크기로 환산한다(없으면 그대로 재고 1920×1080으로 환산).
const mount = ({ studio, Shader, preview = null }) => {
  const $ = id => document.getElementById(id),
    controller = new AbortController(),
    signal = controller.signal;
  const dialog = $("gallery"),
    grid = $("galleryGrid"),
    community = $("galleryCommunity"),
    lessons = $("galleryLessons");
  const element = (tag, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  // 검색 대상: 제목·태그·설명·원작자·원작 이름·id. 소문자로 한 번 만들어 카드에 둔다.
  const searchText = item =>
    [item.title, item.tag, item.description, item.id, item.credit?.author, item.credit?.work, item.credit?.license]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  const card = (item, onPick) => {
    const button = element("button", "gallery-card");
    button.type = "button";
    button.dataset.id = item.id;
    button.dataset.search = searchText(item);
    const art = element("canvas", "gallery-thumb");
    art.width = 320;
    art.height = 200;
    art.dataset.thumb = item.thumb || item.id;
    art.setAttribute("aria-hidden", "true");
    const meta = element("span", "gallery-meta");
    meta.append(
      element("span", "gallery-tag", item.tag),
      element("strong", "", item.title),
      element("span", "gallery-desc", item.description)
    );
    // 다른 사람의 작품: 원작자와 라이선스를 카드에 보인다(자세한 출처는 셰이더 맨 위 주석).
    if (item.credit) {
      const license = item.credit.license === "Permission" ? "자유 사용 허락" : item.credit.license;
      const credit = element("span", "gallery-credit", `${item.credit.author} · ${license}`);
      credit.title = `${item.credit.work} — ${item.credit.url}`;
      meta.append(credit);
    }
    // 성능 배지: 카드가 화면에 보이면 이 컴퓨터에서 재서 채운다(startThumbs).
    const badge = element("span", "gallery-perf", "대기");
    badge.dataset.level = "pending";
    badge.title = "카드가 화면에 보이면 이 컴퓨터에서 성능을 잽니다.";
    button.append(art, badge, meta);
    button.addEventListener("click", () => onPick(item));
    return button;
  };
  const finishOnboarding = () => Store.write(ONBOARD_KEY, "1");
  const pick = async item => {
    if (dialog.open) dialog.close();
    finishOnboarding();
    const project = item.project || { image: item.image, passes: [], imageChannels: {} };
    const ok = await (item.action ? studio[item.action]() : studio.loadExample(project, params(sourcesOf(item))));
    // 예제를 열어도 편집기 열림 상태는 그대로 둔다(보기만 하려는 사람이 예제를 바꿀 때마다 편집기를 닫지 않게).
    // 코드를 보려면 편집기 버튼(E)으로 연다.
    if (ok) {
      // 설정 패널이 실제 FPS를 보고 무거우면 해상도를 낮추자고 제안한다(ui.js).
      document.dispatchEvent(
        new CustomEvent("gallery-example-loaded", {
          detail: { id: item.id, title: item.title, level: perfResults.get(item.id)?.level ?? null },
        })
      );
    }
    return ok;
  };
  // 가이드의 "예제 열기" 버튼용: id로 예제를 바로 연다.
  const loadLesson = id => {
    const item = [...ART, ...COMMUNITY, ...LESSONS].find(entry => entry.id === id);
    return item ? pick(item) : false;
  };
  grid.replaceChildren(...ART.map(item => card(item, pick)));
  community.replaceChildren(...COMMUNITY.map(item => card(item, pick)));
  lessons.replaceChildren(...LESSONS.map(item => card(item, pick)));
  // 썸네일과 성능 배지는 카드가 화면에 보일 때 하나씩 채운다(lazy-render.js).
  // 갤러리를 열 때 모든 예제를 한꺼번에 컴파일·그리면 브라우저가 크게 멈춘다. 카드 하나마다:
  //  1) 필요한 셰이더를 비동기로 컴파일(끝날 때까지 메인 스레드를 막지 않는다)
  //  2) 썸네일을 t=2.5초로 한 프레임 그려 카드 캔버스로 복사
  //  3) 다음 프레임에 성능을 잰다(gallery-perf.js). 카드 하나를 재는 동안만 메인 미리보기를 멈춘다.
  // 갤러리를 닫으면 멈췄다가 다시 열면 이어서 한다. 모든 카드를 다 채우면 임시 컨텍스트를 해제한다.
  let lazy = null;
  const perfResults = new Map();
  const perfBadges = id => dialog.querySelectorAll(`.gallery-card[data-id="${id}"] .gallery-perf`);
  const setBadge = (id, state) => {
    for (const badge of perfBadges(id)) {
      badge.dataset.level = state.level;
      badge.textContent = state.label;
      badge.title = state.title;
    }
  };
  // 지금 미리보기가 실제로 그리는 크기(해상도 배율 반영). 모르면 1920×1080.
  const screenSize = () => {
    const size = preview?.size?.();
    return size && size.width > 0 && size.height > 0 ? size : Perf.REFERENCE;
  };
  // 잰 값(픽셀당 시간)을 지금 미리보기 크기로 환산해 배지를 다시 쓴다. 갤러리를 열 때마다 부른다(창 크기가 바뀌었을 수 있다).
  const showPerf = id => {
    const result = perfResults.get(id);
    if (!result) return;
    const size = screenSize(),
      ms = Perf.estimateFrameMs(result.samples(size), result.baseline),
      state = Perf.describe(ms, size);
    if (result.software) state.title += " · GPU 없이 소프트웨어로 그리는 환경이라 실제 GPU보다 훨씬 느리게 나옵니다";
    Object.assign(result, { ms, size, ...state });
    setBadge(id, state);
  };
  // 성능을 잴 프로젝트: 예제 카드가 Studio에 넘기는 것과 같은 패스 구성. Studio 소유 예제는 그 소스를 직접 쓴다.
  const perfProject = item => {
    if (item.action === "exampleRaymarch")
      return {
        project: { image: Shader.raymarch, passes: Shader.raymarchPasses },
        uniforms: Shader.rayUniforms.map(([name, type, value]) => ({ name, type, value })),
      };
    if (item.action === "examplePipeline") return { project: Examples.pipelineProject(), uniforms: [] };
    if (item.action === "exampleFeedback") return { project: Examples.feedbackProject(), uniforms: [] };
    const project = item.project || { image: item.image, passes: [] };
    return { project, uniforms: params(sourcesOf(item)) };
  };
  // 썸네일로 그릴 소스: 단일 패스 예제와 Ray Marching. 버퍼가 필요한 예제는 CSS 그림(data-thumb)을 쓴다.
  const thumbSource = item =>
    item.image
      ? { fragment: item.image, uniforms: params([item.image]) }
      : item.action === "exampleRaymarch"
        ? { fragment: Shader.raymarch, uniforms: perfProject(item).uniforms }
        : null;
  const startLazy = () => {
    const surface = document.createElement("canvas");
    surface.width = 320;
    surface.height = 200;
    const gl = surface.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
    if (!gl) {
      for (const item of [...ART, ...COMMUNITY, ...LESSONS])
        setBadge(item.id, {
          level: "unknown",
          label: "측정 불가",
          title: "WebGL2를 쓸 수 없어 성능을 재지 못했습니다.",
        });
      return null;
    }
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, Shader.vertex);
    gl.compileShader(vs);
    const vao = gl.createVertexArray(),
      programs = new Map(), // fragment → Promise<program | null>
      abort = new AbortController();
    gl.bindVertexArray(vao);
    // 같은 소스는 한 번만 컴파일한다(썸네일과 성능 측정이 같이 쓴다).
    const program = fragment => {
      if (!programs.has(fragment))
        programs.set(
          fragment,
          Lazy.compileProgram(gl, vs, fragment, { signal: abort.signal }).then(({ program, log }) => {
            if (!program && log) console.warn("썸네일 컴파일 실패", log);
            return program;
          })
        );
      return programs.get(fragment);
    };
    // 렌더러가 넣는 기본 Uniform과 예제 파라미터. uMouse·uResolution은 선언한 타입에 맞춰 넣는다(vec2/vec4, vec2/vec3).
    // 썸네일용 램프 텍스처(이름별, 대화상자가 닫힐 때 컨텍스트와 함께 사라진다).
    const ramps = new Map();
    const bindRamp = (name, options, value, unit, loc) => {
      const key = JSON.stringify([options, value]);
      let entry = ramps.get(name);
      gl.activeTexture(gl.TEXTURE0 + unit);
      if (!entry || entry.key !== key) {
        entry ??= { texture: gl.createTexture() };
        entry.key = key;
        ramps.set(name, entry);
        gl.bindTexture(gl.TEXTURE_2D, entry.texture);
        const data = Ramp.bakeRamp(options, value);
        if (options.gradient)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, Ramp.RAMP_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, Ramp.RAMP_SIZE, 1, 0, gl.RED, gl.FLOAT, data);
        const filter = options.gradient === "step" ? gl.NEAREST : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.uniform1i(loc, unit);
      gl.activeTexture(gl.TEXTURE0);
    };
    const setup = (linked, users, { width, height }) => {
      gl.useProgram(linked);
      const types = new Map();
      for (let i = 0, n = gl.getProgramParameter(linked, gl.ACTIVE_UNIFORMS); i < n; i++) {
        const info = gl.getActiveUniform(linked, i);
        types.set(info.name.replace(/\[0\]$/, ""), info.type);
      }
      const at = name => gl.getUniformLocation(linked, name);
      if (types.get("uResolution") === gl.FLOAT_VEC3) gl.uniform3f(at("uResolution"), width, height, 1);
      else gl.uniform2f(at("uResolution"), width, height);
      gl.uniform1f(at("uTime"), 2.5);
      gl.uniform1f(at("uDeltaTime"), 1 / 60);
      gl.uniform1i(at("uFrame"), 150);
      if (types.get("uMouse") === gl.FLOAT_VEC4) gl.uniform4f(at("uMouse"), -1, -1, 0, 0);
      else gl.uniform2f(at("uMouse"), -1, -1);
      for (let unit = 0; unit < 4; unit++) gl.uniform1i(at(`iChannel${unit}`), unit);
      if (types.has("iChannelResolution")) gl.uniform3fv(at("iChannelResolution"), new Float32Array(12).fill(1));
      let rampUnit = 4;
      for (const { name, type, value, options } of users) {
        const loc = at(name);
        // 램프(@gradient · @curve)는 본 화면 렌더러처럼 4번 유닛부터 256×1 텍스처로 굽는다.
        if (type === "sampler2D") {
          const unit = rampUnit++;
          if (loc) bindRamp(name, options, value, unit, loc);
          continue;
        }
        if (!loc) continue;
        if (type === "float") gl.uniform1f(loc, value);
        else if (type === "int" || type === "bool") gl.uniform1i(loc, Number(value));
        else if (type === "uint") gl.uniform1ui(loc, value);
        else if (type === "vec2") gl.uniform2fv(loc, value);
        else if (type === "vec3") gl.uniform3fv(loc, value);
        else if (type === "vec4") gl.uniform4fv(loc, value);
      }
    };
    const drawThumb = (linked, users, id) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, 320, 200);
      setup(linked, users, { width: 320, height: 200 });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      for (const target of dialog.querySelectorAll(`canvas[data-thumb="${id}"]`))
        target.getContext("2d")?.drawImage(surface, 0, 0);
    };
    // ---- 성능 측정 준비 ----
    const debug = gl.getExtension("WEBGL_debug_renderer_info"),
      renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      software = Perf.isSoftware(renderer),
      // GPU 없이 그리는 환경(소프트웨어 렌더링)에서는 작게 잰다. 무거운 예제 하나에 수 초씩 멈추지 않게.
      meter = Perf.createMeter(gl, software ? { width: 160, height: 90 } : { width: 640, height: 360 }),
      empty = program(
        "#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main() { fragColor = vec4(0.0); }"
      );
    // 빈 셰이더 시간 = 고정 비용(호출·동기화). 가장 작게 나온 값을 기준으로 삼는다.
    // 예제를 재기 직전마다 다시 재 보고, 기준보다 한참 길면 GPU가 다른 일(멈추기 직전 메인 프레임, 다른 탭)로 바쁜 것이니
    // 잠시 뒤 다시 잰다. 미리보기를 새로 멈춘 직후에는 기준값부터 몇 번 잰다(그 전 프레임이 끝나기를 기다리며).
    let baseline = Infinity,
      paused = false;
    const probe = async () => {
      const linked = await empty;
      const ms = linked ? await meter.time(size => setup(linked, [], size)) : 0;
      baseline = Math.min(baseline, ms);
      return ms;
    };
    // 미리보기는 카드 하나를 재는 동안만 멈춘다(느린 컴퓨터에서 보이는 카드를 다 재느라 오래 멈춰 있지 않게).
    // 멈춘 직후에는 그 전에 보낸 메인 프레임이 아직 GPU에서 돌 수 있으니, 빈 셰이더가 기준값 근처로 돌아올 때까지
    // 짧게 기다린다(최대 6번). 처음에는 기준값이 없으므로 적어도 두 번 잰다.
    const pausePreview = async () => {
      if (!paused) paused = !!preview?.pause();
      for (let i = 0; i < 6 && dialog.open; i++) {
        await Lazy.wait(i ? 60 : paused ? 100 : 0);
        const ms = await probe();
        if (i >= 1 && ms <= baseline * 3 + 0.3) break;
      }
    };
    const resumePreview = () => {
      if (paused) preview?.resume();
      paused = false;
    };
    const measure = async item => {
      const { project, uniforms } = perfProject(item),
        passes = [
          ...project.passes.map(pass => ({ source: pass.fragment, pass })),
          { source: project.image, pass: {} },
        ],
        linked = await Promise.all(passes.map(({ source }) => program(source)));
      if (linked.some(entry => !entry)) return null;
      // 픽셀당 시간만 보관한다. 배지는 그때그때 지금 미리보기 크기로 환산한다(showPerf).
      const timed = [];
      if (!dialog.open) return interrupted;
      await pausePreview();
      try {
        for (const [i, { pass }] of passes.entries()) {
          if (!dialog.open) return interrupted; // 재는 도중에 닫으면 그만두고 미리보기를 바로 돌려준다
          timed.push({ ms: await meter.time(size => setup(linked[i], uniforms, size)), pass });
        }
      } finally {
        resumePreview();
      }
      return {
        samples: screen =>
          timed.map(({ ms, pass }) => ({ ms, measured: meter.pixels, pixels: Perf.passPixels(pass, screen) })),
        // 고정 비용은 지금까지 잰 가장 작은 값을 쓴다(처음에는 바쁜 GPU 때문에 크게 잡힐 수 있어, 뒤에 잰 값이 더 정확하다).
        get baseline() {
          return Number.isFinite(baseline) ? baseline : 0;
        },
        software,
      };
    };
    // 갤러리가 닫혀 있으면 재지 않는다(닫은 뒤에 미리보기를 멈추지 않게). 그 카드는 대기열에 되돌려 다시 열 때 잰다.
    const interrupted = Symbol("interrupted");
    const job = (item, node) => async () => {
      if (abort.signal.aborted) return;
      const thumb = thumbSource(item);
      if (thumb) {
        const linked = await program(thumb.fragment);
        if (linked && !abort.signal.aborted) drawThumb(linked, thumb.uniforms, item.thumb || item.id);
        await Lazy.nextFrame();
      }
      if (abort.signal.aborted || perfResults.has(item.id)) return;
      let result = null;
      try {
        result = await measure(item);
      } catch (error) {
        console.warn("성능 측정 실패", item.id, error);
      }
      if (result === interrupted) {
        queue.add(node, job(item, node));
        return;
      }
      if (!result) {
        setBadge(item.id, { level: "unknown", label: "측정 실패", title: "이 예제는 성능을 재지 못했습니다." });
        return;
      }
      perfResults.set(item.id, result);
      // 기준값이 더 작아졌을 수 있으니 이미 잰 카드도 다시 환산한다.
      for (const id of perfResults.keys()) showPerf(id);
      // 다음 카드를 재기 전에 미리보기를 잠깐 돌린다(무거운 카드가 이어져도 미리보기가 계속 멈춰 있지 않게).
      await Lazy.wait(250);
    };
    const finish = () => {
      resumePreview();
      if (abort.signal.aborted) return;
      abort.abort();
      queue.dispose();
      meter.dispose();
      Promise.all(programs.values()).then(list => {
        for (const linked of list) if (linked) gl.deleteProgram(linked);
        gl.deleteShader(vs);
        gl.deleteVertexArray(vao);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      });
    };
    // 모든 카드를 다 채우면 컨텍스트를 해제한다.
    const queue = Lazy.createVisibleQueue({
      margin: "160px",
      onIdle: remaining => {
        if (!remaining) finish();
      },
    });
    for (const item of [...ART, ...COMMUNITY, ...LESSONS])
      for (const cardNode of dialog.querySelectorAll(`.gallery-card[data-id="${item.id}"]`))
        queue.add(cardNode, job(item, cardNode));
    return {
      resume: () => {
        if (!abort.signal.aborted) queue.resume();
      },
      pause: () => {
        queue.pause();
        resumePreview();
      },
      stop: finish,
    };
  };
  // 갤러리 검색: 공백으로 나눈 낱말이 모두 들어 있는 카드만 남긴다. 결과가 없는 묶음은 제목째 숨긴다.
  const search = $("gallerySearch");
  const filter = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0,
      total = 0;
    for (const section of dialog.querySelectorAll(".gallery-section")) {
      let any = false;
      for (const node of section.querySelectorAll(".gallery-card")) {
        const match = words.every(word => node.dataset.search.includes(word));
        node.hidden = !match;
        any ||= match;
        shown += match ? 1 : 0;
        total++;
      }
      section.hidden = !any;
    }
    dialog.classList.toggle("is-searching", words.length > 0);
    $("galleryEmpty").hidden = shown > 0;
    $("galleryCount").textContent = words.length ? `${shown} / ${total}개` : "";
    // 숨긴 카드는 화면에 보이지 않으므로 지연 렌더링 대기열이 알아서 건너뛴다. 새로 드러난 카드는 다시 확인시킨다.
    if (dialog.open) lazy?.resume();
  };
  search.addEventListener("input", filter, { signal });
  dialog.addEventListener(
    "keydown",
    event => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) return;
      event.preventDefault();
      search.focus();
      search.select();
    },
    { signal }
  );
  // 검색어가 있을 때 Esc는 갤러리를 닫지 않고 검색어만 지운다.
  search.addEventListener(
    "keydown",
    event => {
      if (event.key === "Escape" && search.value) {
        event.preventDefault();
        event.stopPropagation();
        search.value = "";
        filter();
      } else if (event.key === "Enter") {
        event.preventDefault();
        dialog.querySelector(".gallery-card:not([hidden])")?.click();
      }
    },
    { signal }
  );
  const startThumbs = () => {
    lazy ??= startLazy();
    lazy?.resume();
    for (const id of perfResults.keys()) showPerf(id);
  };
  const open = (welcome = false) => {
    dialog.dataset.welcome = String(welcome);
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(startThumbs);
    $("galleryClose").focus();
  };
  const close = () => {
    finishOnboarding();
    dialog.close();
  };
  $("galleryToggle").addEventListener("click", () => open(false), { signal });
  $("galleryClose").addEventListener("click", close, { signal });
  $("galleryBlank").addEventListener("click", close, { signal });
  // 첫 실행의 세 가지 시작: 기본 예제(지금 장면의 코드 열기) · 빈 프로젝트(편집기를 열고 새로 작성) · 프로젝트 파일 열기
  // 두 시작 카드는 버튼 설명에 '편집기·코드를 연다'고 적혀 있어 편집기를 연다. 그 밖의 예제 열기는 편집기를 열지 않는다.
  $("galleryStartDefault")?.addEventListener(
    "click",
    () => {
      close();
      studio.open();
    },
    { signal }
  );
  $("galleryStartBlank")?.addEventListener(
    "click",
    async () => {
      close();
      if (await studio.loadExample({ image: Examples.blank, passes: [], imageChannels: {} }, [])) studio.open();
    },
    { signal }
  );
  $("galleryStartFile")?.addEventListener(
    "click",
    () => {
      close();
      document.getElementById("studioImportPack")?.click();
    },
    { signal }
  );
  dialog.addEventListener(
    "close",
    () => {
      finishOnboarding();
      lazy?.pause();
    },
    { signal }
  );
  dialog.addEventListener(
    "click",
    event => {
      if (event.target === dialog) close();
    },
    { signal }
  );
  document.addEventListener(
    "keydown",
    event => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) return;
      if (event.key.toLowerCase() === "x" && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        open(false);
      }
    },
    { signal }
  );
  // 처음 방문한 사용자에게만 환영 화면과 함께 갤러리를 연다.
  let first = false;
  try {
    first = !localStorage.getItem(ONBOARD_KEY);
  } catch (_) {
    /* 읽기가 막힌 브라우저: 안내를 띄우지 않는다. */
  }
  if (first) setTimeout(() => open(true), 400);
  return {
    open,
    close,
    loadLesson,
    // 잰 성능(예제 id → { ms, size, level, label, title, software }). 테스트와 진단용.
    getPerformance: () =>
      Object.fromEntries(
        [...perfResults].map(([id, { ms, size, level, label, title, software }]) => [
          id,
          { ms, size, level, label, title, software },
        ])
      ),
    dispose: () => {
      lazy?.stop();
      controller.abort();
    },
  };
};
export { mount };
