// 코드 조각 미리보기: 조각 하나를 작은 그림으로 그려 가이드의 조각 카드에 붙인다.
// 공용 WebGL2 컨텍스트 하나를 돌려 쓰며, 그린 결과는 조각 id별로 보관해 목록을 다시 그려도 다시 컴파일하지 않는다.
// 미리보기 정의(PREVIEWS)는 조각 id → 그림 함수 본문이다. 본문은 vec3 previewColor(vec2 uv, vec2 p) 안에 들어간다.
//   uv = 0~1 화면 좌표, p = 가운데가 (0,0)이고 세로 -1~1인 좌표(가로는 -2~2).
//   {map:"..."}이 있으면 3D 조각: float pvMap(vec3 p) 본문이 되고, 그림은 기본 3D 렌더(pvRender)로 그린다.
//   {self:true}는 패스 전체를 바꾸는 템플릿: 조각 소스 자체를 그대로 그린다.
// 조각 코드가 쓰는 앱 Uniform(uTime·uResolution·iChannel0…)은 머리에 선언되며, iChannel0·1에는 시험용 그림이 연결된다.
import * as Lazy from "./lazy-render.js";

const WIDTH = 320,
  HEIGHT = 160,
  TIME = 2.0;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uResolution;
uniform float uTime;
uniform float uDeltaTime;
uniform int uFrame;
uniform vec4 uMouse;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform vec3 iChannelResolution[4];
out vec4 fragColor;
`;
// 미리보기 도우미. 이름은 pv로 시작해 조각의 함수 이름과 겹치지 않는다.
const HELPERS = `
vec3 pvSdf(float d) {                       // 거리장: 안쪽 주황, 바깥 파랑, 등고선, 0 경계는 흰색
    vec3 col = d > 0.0 ? vec3(0.55, 0.75, 0.95) : vec3(0.95, 0.6, 0.3);
    col *= 1.0 - exp(-5.0 * abs(d));
    col *= 0.82 + 0.18 * cos(90.0 * d);
    return mix(col, vec3(1.0), 1.0 - smoothstep(0.0, 0.015, abs(d)));
}
vec3 pvBack(vec2 uv) {                      // 곡선 그래프 배경: 0과 1 기준선
    vec3 col = vec3(0.07, 0.08, 0.1);
    float y0 = abs(uv.y - 0.12), y1 = abs(uv.y - 0.88), w = fwidth(uv.y);
    return col + 0.12 * (1.0 - smoothstep(0.0, w * 1.5, min(y0, y1)));
}
float pvCurve(vec2 uv, float y) {           // y(0~1)를 그래프 높이 0.12~0.88에 그린 선
    float f = uv.y - (0.12 + 0.76 * y);
    return 1.0 - smoothstep(0.0, 1.5, abs(f) / max(fwidth(f), 1e-5));
}
vec3 pvImage(vec2 uv) { return texture(iChannel0, uv).rgb; }
vec3 pvSplit(vec2 uv, vec3 before, vec3 after) {   // 왼쪽 = 원본, 오른쪽 = 적용 결과
    vec3 col = uv.x < 0.5 ? before : after;
    return mix(col, vec3(1.0, 0.55, 0.2), 1.0 - smoothstep(0.0, 1.5 * fwidth(uv.x), abs(uv.x - 0.5)));
}
vec3 pvChecker(vec2 p) {                    // 좌표 변환을 보여 주는 바둑판 + 축
    vec2 c = floor(p * 4.0);
    vec3 col = mix(vec3(0.16, 0.18, 0.24), vec3(0.85, 0.87, 0.92), mod(c.x + c.y, 2.0));
    col = mix(col, vec3(1.0, 0.3, 0.3), (1.0 - smoothstep(0.02, 0.04, abs(p.y))) * step(0.0, p.x));   // +x 축 빨강
    return mix(col, vec3(0.3, 1.0, 0.4), (1.0 - smoothstep(0.02, 0.04, abs(p.x))) * step(0.0, p.y));   // +y 축 초록
}
float pvCircle(vec2 p, float r) { return length(p) - r; }   // 조각의 의존성과 상관없이 쓰는 기본 도형
float pvBox2(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float pvBox3(vec3 p, vec3 b) { vec3 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0); }
float pvCell(vec2 id) { uvec2 u = uvec2(ivec2(id) + 4096); uint h = (u.x * 1597334677u) ^ (u.y * 3812015801u); h = h * 747796405u + 2891336453u; h ^= h >> 16u; return float(h & 0xFFFFu) / 65535.0; }   // 칸 색 구분용 정수 해시
vec3 pvRainbow(float t) { return 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67))); }
bool pvSphere(vec2 p, out vec3 n, out vec3 v) {   // 화면 가운데 구: 법선 n, 시선 v (조명 미리보기)
    vec2 q = p / 0.85; float r2 = dot(q, q);
    v = vec3(0.0, 0.0, 1.0); n = vec3(q, sqrt(max(1.0 - r2, 0.0)));
    return r2 < 1.0;
}`;
// 3D: pvMap을 따라 광선을 진행해 표면을 그린다(조각의 map 계약도 pvMap으로 이어 준다).
const HELPERS_3D = `
float pvMarch(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) { float d = pvMap(ro + rd * t); if (d < 0.001 * t) return t; t += d * 0.9; if (t > 12.0) break; }
    return -1.0;
}
vec3 pvNormal(vec3 p) {
    const vec2 e = vec2(1.0, -1.0) * 0.0015;
    return normalize(e.xyy * pvMap(p + e.xyy) + e.yyx * pvMap(p + e.yyx) + e.yxy * pvMap(p + e.yxy) + e.xxx * pvMap(p + e.xxx));
}
void pvCamera(vec2 p, out vec3 ro, out vec3 rd) {
    ro = vec3(1.75, 1.15, 1.95);
    vec3 f = normalize(-ro), r = normalize(cross(f, vec3(0.0, 1.0, 0.0))), u = cross(r, f);
    rd = normalize(p.x * r + p.y * u + 1.7 * f);
}
vec3 pvRender(vec2 p) {
    vec3 ro, rd; pvCamera(p, ro, rd);
    vec3 col = mix(vec3(0.1, 0.11, 0.14), vec3(0.2, 0.24, 0.32), 0.5 + 0.5 * rd.y);
    float t = pvMarch(ro, rd);
    if (t > 0.0) {
        vec3 pos = ro + rd * t, n = pvNormal(pos), l = normalize(vec3(0.6, 0.8, 0.4));
        float dif = max(dot(n, l), 0.0), amb = 0.5 + 0.5 * n.y, spe = pow(max(dot(reflect(rd, n), l), 0.0), 24.0);
        col = vec3(0.95, 0.72, 0.45) * (0.2 * amb + 0.8 * dif) + 0.35 * spe;
    }
    return pow(col, vec3(0.9));
}`;

// 조각 id → 미리보기. 그림이 의미 없는 조각(main 안 문장 대부분·계약 함수가 필요한 조각)은 넣지 않는다.
const PREVIEWS = {
  // ---- 해시 · 난수 ----
  hash11: "return vec3(hash11(floor(uv.x * 64.0) + 64.0 * floor(uv.y * 32.0)));",
  hash21: "return vec3(hash21(floor(uv * vec2(64.0, 32.0))));",
  hash22: "return vec3(hash22(floor(uv * vec2(64.0, 32.0))), 0.15);",
  hash13: "return vec3(hash13(vec3(floor(uv * vec2(64.0, 32.0)), 7.0)));",
  hash33: "return hash33(vec3(floor(uv * vec2(64.0, 32.0)), 7.0));",
  hash31: "return hash31(floor(uv.x * 32.0) + 32.0 * floor(uv.y * 16.0));",
  hash32: "return hash32(floor(uv * vec2(32.0, 16.0)));",
  uhash11: "return vec3(uhash11(floor(uv.x * 64.0) + 64.0 * floor(uv.y * 32.0)));",
  uhash21: "return vec3(uhash21(floor(uv * vec2(64.0, 32.0))));",
  uhash22: "return vec3(uhash22(floor(uv * vec2(64.0, 32.0))), 0.15);",
  uhash13: "return vec3(uhash13(vec3(floor(uv * vec2(64.0, 32.0)), 7.0)));",
  uhash33: "return uhash33(vec3(floor(uv * vec2(64.0, 32.0)), 7.0));",
  uintToUnit: "return vec3(uintToUnit(uint(uv.x * 4294967040.0)));   // 0 → 0xFFFFFF00: 왼쪽 0, 오른쪽 1 직전",
  lowbias32:
    "uvec2 c = uvec2(uv * vec2(128.0, 64.0)); return vec3(float(lowbias32(c.x + c.y * 128u) >> 8u) / 16777216.0);",
  pcg3d: "return vec3(pcg3d(uvec3(uvec2(uv * vec2(128.0, 64.0)), 7u)) >> 8u) / 16777216.0;",
  pcg4d: "return vec3(pcg4d(uvec4(uvec2(uv * vec2(128.0, 64.0)), 3u, 9u)).xyz >> 8u) / 16777216.0;",
  xxhash32: "return vec3(float(xxhash32(uvec3(uvec2(uv * vec2(128.0, 64.0)), 5u)) >> 8u) / 16777216.0);",
  pcg: "return vec3(randPCG(uvec2(uv * vec2(128.0, 64.0)), 1u));",
  // ---- 노이즈 2D ----
  noise1D: "return mix(pvBack(uv), vec3(0.4, 0.8, 1.0), pvCurve(uv, noise1D(uv.x * 10.0)));",
  valueNoise: "return vec3(valueNoise(p * 4.0));",
  tileableNoise: "return vec3(tileableNoise(uv * vec2(8.0, 4.0), vec2(4.0, 4.0)));   // 가로 4칸마다 반복",
  gradientNoise: "return vec3(gradientNoise(p * 4.0) * 0.5 + 0.5);",
  simplex: "return vec3(simplexNoise(p * 2.0) * 0.5 + 0.5);",
  fbm: "return vec3(fbm(p * 2.5));",
  fbmGradient: "return vec3(fbmGradient(p * 2.5) + 0.5);",
  turbulence: "return vec3(smoothstep(0.0, 0.5, turbulence(p * 2.0)));",
  curlNoise: "vec2 v = curlNoise(p * 2.0); return vec3(0.5 + 0.45 * v / (1.0 + length(v)), 0.6);   // 방향을 색으로",
  ridged: "return vec3(ridgedFbm(p * 2.0));",
  domainWarp: "return vec3(domainWarp(p * 1.5, 1.0));",
  voronoi:
    "vec3 v = voronoi(p * 4.0); vec3 c = 0.5 + 0.4 * cos(6.2831 * (v.z + vec3(0.0, 0.33, 0.67))); return c * (0.55 + 0.45 * v.x) * smoothstep(0.0, 0.08, v.y);",
  // ---- 노이즈 3D (z = 0.5 단면) ----
  valueNoise3: "return vec3(valueNoise3(vec3(p * 4.0, 0.5)));",
  gradientNoise3: "return vec3(gradientNoise3(vec3(p * 4.0, 0.5)) * 0.5 + 0.5);",
  simplex3: "return vec3(simplexNoise3(vec3(p * 2.0, 0.5)) * 0.5 + 0.5);",
  fbm3: "return vec3(fbm3(vec3(p * 2.5, 0.5)));",
  fbm3Simplex: "return vec3(fbm3Simplex(vec3(p * 2.0, 0.5)) * 0.5 + 0.5);",
  ridged3: "return vec3(ridgedFbm3(vec3(p * 2.0, 0.5)));",
  turbulence3: "return vec3(smoothstep(0.0, 0.45, turbulence3(vec3(p * 2.0, 0.5))));",
  voronoi3:
    "vec3 v = voronoi3(vec3(p * 4.0, 0.5)); vec3 c = 0.5 + 0.4 * cos(6.2831 * (v.z + vec3(0.0, 0.33, 0.67))); return c * (0.55 + 0.45 * v.x) * smoothstep(0.0, 0.08, v.y);",
  domainWarp3: "return vec3(domainWarp3(vec3(p * 1.5, 0.0), 1.0));",
  volumeClouds: { self: true },
  // ---- 패턴 ----
  checkerAA: "return vec3(0.15 + 0.7 * checkerAA(p * 3.0));",
  stripesAA: "return vec3(0.15 + 0.7 * stripesAA(dot(p, vec2(0.7, 0.7)) * 6.0, 0.4));",
  contour:
    "float v = length(p - vec2(0.5, 0.0)) * (1.0 + 0.3 * sin(atan(p.y, p.x - 0.5) * 5.0)); return mix(vec3(0.5 - 0.3 * v), vec3(1.0, 0.7, 0.3), contourLines(v, 0.1, 1.0));",
  dotsGrid: "return vec3(0.1 + 0.8 * dotsGrid(p * 5.0, 0.7));",
  truchet:
    "float d = truchet(p * 5.0); return mix(vec3(0.95, 0.93, 0.88), vec3(0.15, 0.2, 0.55), 1.0 - smoothstep(0.08, 0.1, d));",
  brick:
    "vec4 b = brickTile(p * 3.0, vec2(1.0, 0.5)); float mortar = smoothstep(0.42, 0.45, max(abs(b.x), abs(b.y) * 1.0)); return mix(vec3(0.62, 0.28, 0.2) * (0.75 + 0.5 * pvCell(b.zw)), vec3(0.85), mortar);",
  starLayer:
    "return vec3(0.02, 0.02, 0.06) + vec3(starLayer(p * 8.0, uTime) + 0.6 * starLayer(p * 16.0 + 3.0, uTime));",
  waveLines: "return mix(vec3(0.06, 0.07, 0.1), vec3(0.4, 0.9, 1.0), waveLines(p, 6.0, uTime));",
  // ---- 프랙털 ----
  mandelbrot:
    "float m = mandelbrot(p * 1.2 + vec2(-0.6, 0.0)); return m >= 1.0 ? vec3(0.0) : 0.5 + 0.5 * cos(6.2831 * (sqrt(m) * 3.0 + vec3(0.0, 0.15, 0.3)));",
  julia:
    "float m = julia(p * 1.2, vec2(-0.8, 0.156)); return m >= 1.0 ? vec3(0.0) : 0.5 + 0.5 * cos(6.2831 * (sqrt(m) * 2.5 + vec3(0.6, 0.4, 0.2)));",
  sdMenger: { map: "return sdMenger(p * 1.2) / 1.2;" },
  sdMandelbulb: { map: "return sdMandelbulb(p * 0.9, 8.0) / 0.9;" },
  kifs: {
    map: "float s; vec3 q = kifsFold(p * 1.3, 0.0, s); return (length(max(abs(q) - vec3(0.6), 0.0)) / s) / 1.3;",
  },
  // ---- 2D SDF ----
  sdCircle: "return pvSdf(sdCircle(p, 0.6));",
  sdBox2: "return pvSdf(sdBox2D(p, vec2(0.8, 0.45)));",
  sdRoundBox2: "return pvSdf(sdRoundBox2D(p, vec2(0.8, 0.45), 0.2));",
  sdSegment: "return pvSdf(sdSegment(p, vec2(-0.8, -0.4), vec2(0.8, 0.4)) - 0.08);",
  sdTriangle: "return pvSdf(sdEquilateralTriangle(p, 0.6));",
  sdHexagon: "return pvSdf(sdHexagon(p, 0.6));",
  sdStar5: "return pvSdf(sdStar5(p, 0.75, 0.45));",
  sdRing: "return pvSdf(sdRing(p, 0.55, 0.08));",
  sdEllipse: "return pvSdf(sdEllipseApprox(p, vec2(0.9, 0.5)));",
  sdHeart: "return pvSdf(sdHeart(p * 1.2 + vec2(0.0, 0.6)) / 1.2);",
  sdRhombus: "return pvSdf(sdRhombus(p, vec2(0.9, 0.55)));",
  sdPie: "return pvSdf(sdPie(p, 0.9, 0.7));",
  sdArc: "return pvSdf(sdArc(p, 1.2, 0.55, 0.08));",
  sdCross: "return pvSdf(sdCross(p, vec2(0.7, 0.22), 0.05));",
  sdfFill:
    "float d = pvCircle(p - vec2(-0.7, 0.0), 0.55); float e = pvCircle(p - vec2(0.7, 0.0), 0.55); return vec3(0.08) + vec3(0.95, 0.6, 0.3) * fillSDF(d) + vec3(0.4, 0.8, 1.0) * strokeSDF(e, 0.03);",
  sdfDebug: "return debugSDF(length(p) - 0.6);",
  // ---- 3D SDF ----
  sdSphere: { map: "return sdSphere(p, 0.9);" },
  sdBox3: { map: "return sdBox(p, vec3(0.7, 0.5, 0.6));" },
  sdRoundBox3: { map: "return sdRoundBox(p, vec3(0.6, 0.4, 0.5), 0.15);" },
  sdTorus: { map: "return sdTorus(p, vec2(0.75, 0.25));" },
  sdCapsule: { map: "return sdCapsule(p, vec3(-0.6, -0.5, 0.0), vec3(0.6, 0.5, 0.0), 0.3);" },
  sdCylinder: { map: "return sdCylinder(p, 0.6, 0.5);" },
  sdPlane: { map: "return min(sdPlane(p, vec3(0.0, 1.0, 0.0), 0.6), length(p) - 0.5);" },
  sdOctahedron: { map: "return sdOctahedron(p, 0.95);" },
  sdEllipsoid: { map: "return sdEllipsoid(p, vec3(0.9, 0.5, 0.6));" },
  sdCappedCone: { map: "return sdCappedCone(p, 0.6, 0.6, 0.2);" },
  sdHexPrism: { map: "return sdHexPrism(p, vec2(0.6, 0.4));" },
  sdBoxFrame: { map: "return sdBoxFrame(p, vec3(0.7, 0.6, 0.6), 0.06);" },
  sdLink: { map: "return sdLink(p, 0.35, 0.45, 0.13);" },
  sdPyramid: { map: "return sdPyramid(p + vec3(0.0, 0.6, 0.0), 1.2);" },
  // ---- 도형 합성 · 반복 ----
  opBool:
    "float a = pvCircle(p - vec2(-0.25, 0.0), 0.6), b = pvCircle(p - vec2(0.35, 0.0), 0.45); return pvSdf(opSubtraction(a, b));",
  smin: "float a = pvCircle(p - vec2(-0.45, 0.0), 0.45), b = pvCircle(p - vec2(0.45, 0.1), 0.4); return pvSdf(smin(a, b, 0.35));",
  smax: "float a = pvCircle(p - vec2(-0.2, 0.0), 0.65), b = pvCircle(p - vec2(0.45, 0.0), 0.4); return pvSdf(smoothSubtraction(a, b, 0.2));",
  opRound: "return pvSdf(opOnion(pvBox2(p, vec2(0.6, 0.35)), 0.08));",
  opRepeat2: "vec2 q = opRepeat(p, vec2(0.6)); return pvSdf(pvCircle(q, 0.18));",
  opPolar: "vec2 q = opPolarRepeat(p, 7.0); return pvSdf(pvCircle(q - vec2(0.6, 0.0), 0.15));",
  opMirror: { map: "vec3 q = opTwist(p, 1.6); return pvBox3(q, vec3(0.45, 0.85, 0.45)) * 0.6;" },
  sminBlend:
    "vec2 r = sminBlend(pvCircle(p - vec2(-0.45, 0.0), 0.45), pvCircle(p - vec2(0.45, 0.0), 0.45), 0.4); vec3 c = mix(vec3(0.95, 0.5, 0.3), vec3(0.35, 0.65, 1.0), r.y); return mix(vec3(0.08), c, 1.0 - smoothstep(0.0, 0.01, r.x));",
  opExtrude: { map: "return opExtrude(p, abs(pvCircle(p.xy, 0.6)) - 0.15, 0.2);" },
  opRevolution: { map: "return pvBox2(opRevolution(p, 0.6), vec2(0.15, 0.4));" },
  opElongate: { map: "vec3 q = opElongate(p, vec3(0.5, 0.0, 0.0)); return length(q) - 0.45;" },
  opDisplace: { map: "return opDisplace(p, length(p) - 0.85, 9.0, 0.04) * 0.8;" },
  // ---- 좌표 · 변환 ----
  rot2: "return pvChecker(rot2(0.5) * p);",
  rot3: { map: "return pvBox3(rotateAxis(normalize(vec3(1.0, 1.0, 0.0)), 0.7) * p, vec3(0.6));" },
  rotXYZ: { map: "return pvBox3(rotY(0.6) * rotX(0.4) * p, vec3(0.6, 0.45, 0.6));" },
  hexGrid:
    "vec4 h = hexGrid(p * 4.0); float edge = 0.5 - max(abs(h.x) * 0.866 + abs(h.y) * 0.5, abs(h.y)); return (0.4 + 0.6 * pvCell(h.zw)) * vec3(0.95, 0.75, 0.35) * smoothstep(0.0, 0.05, edge);",
  kaleido: "return pvChecker(kaleidoscope(p - vec2(0.0, 0.0), 6.0) + vec2(0.3, 0.1));",
  polar:
    "vec2 polar = vec2(length(p), atan(p.y, p.x) / 6.2831853 + 0.5); return vec3(fract(polar.x * 4.0), polar.y, 0.4);",
  tile: "vec2 grid = uv * vec2(16.0, 8.0); vec2 cellId = floor(grid), cellUv = fract(grid) - 0.5; return vec3(cellUv + 0.5, 0.0) * 0.7 + 0.3 * pvCell(cellId);",
  // ---- 색 ----
  cosPalette: "return cosPalette(uv.x, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67));",
  hsv2rgb: "return hsv2rgb(vec3(uv.x, 1.0, uv.y));",
  rgb2hsv:
    "vec3 c = pvRainbow(uv.x); vec3 h = rgb2hsv(c); return uv.y > 0.5 ? c : vec3(h.x);   // 위 = 색, 아래 = 다시 구한 색상(hue)",
  srgb: "float g = uv.x; return uv.y > 0.5 ? vec3(linearToSrgb(vec3(g))) : vec3(g);   // 위 = sRGB로 바꾼 같은 선형 값",
  luminance: "vec3 c = pvRainbow(uv.x); return uv.y > 0.5 ? c : vec3(luminance(c));",
  saturation: "vec3 c = pvImage(uv); return adjustSaturation(c, uv.y * 2.0);   // 아래 0(흑백) → 위 2(강조)",
  oklab:
    "vec3 a = vec3(0.05, 0.25, 1.0), b = vec3(1.0, 0.85, 0.05); return pow(uv.y > 0.5 ? mixOklab(a, b, uv.x) : mix(a, b, uv.x), vec3(1.0 / 2.2));   // 위 = Oklab, 아래 = RGB",
  blackbody: "return blackbody(mix(1000.0, 12000.0, uv.x));",
  turbo: "return turboColormap(uv.x);",
  palettePresets:
    "float t = uv.x; int row = int(uv.y * 6.0); return row == 0 ? paletteRainbow(t) : row == 1 ? paletteSunset(t) : row == 2 ? paletteOcean(t) : row == 3 ? paletteFire(t) : row == 4 ? paletteNeon(t) : paletteEarth(t);",
  // ---- 레이마칭 ----
  camera:
    "vec3 ro = vec3(2.5, 1.5, 2.5), rd = setCamera(ro, vec3(0.0), 0.0) * normalize(vec3(p, 1.8)); vec3 sky = vec3(0.35, 0.5, 0.75) + 0.3 * max(rd.y, 0.0); if (rd.y >= 0.0) return sky; vec2 g = ro.xz - rd.xz * ro.y / rd.y; float c = mod(floor(g.x * 2.0) + floor(g.y * 2.0), 2.0); return mix(sky, vec3(0.2 + 0.6 * c), exp(-0.03 * dot(g, g)));   // 원점을 바라보는 카메라에서 본 바둑판 바닥",
  intersect:
    "vec3 ro = vec3(0.0, 0.3, 3.0), rd = normalize(vec3(p, -1.8)); float t = iSphere(ro, rd, vec3(0.0), 0.8); vec3 col = vec3(0.12, 0.13, 0.17); if (t > 0.0) { vec3 n = normalize(ro + rd * t); col = vec3(0.95, 0.72, 0.45) * (0.25 + 0.75 * max(dot(n, normalize(vec3(0.6, 0.8, 0.4))), 0.0)); } return col;",
  triplanar:
    "vec3 n, v; if (!pvSphere(p, n, v)) return vec3(0.1); return triplanar(iChannel0, n * 0.85, n, 1.0) * (0.35 + 0.65 * max(dot(n, normalize(vec3(0.5, 0.6, 0.6))), 0.0));",
  rmTemplate: { self: true },
  // ---- 조명 (가운데 구) ----
  fresnel:
    "vec3 n, v; if (!pvSphere(p, n, v)) return vec3(0.08); return vec3(0.2, 0.25, 0.3) + vec3(0.7, 0.85, 1.0) * fresnelSchlick(dot(n, v), 0.04);",
  blinnPhong:
    "vec3 n, v; if (!pvSphere(p, n, v)) return vec3(0.08); return blinnPhong(n, normalize(vec3(0.6, 0.7, 0.5)), v, vec3(0.9, 0.45, 0.3), 48.0);",
  ggx: "vec3 n, v; if (!pvSphere(p, n, v)) return vec3(0.08); vec3 l = normalize(vec3(0.6, 0.7, 0.5)); float r = mix(0.15, 0.7, uv.x); return vec3(0.35, 0.5, 0.9) * max(dot(n, l), 0.0) * 0.8 + ggxSpecular(n, v, l, r, 0.04) * 2.0;",
  hemiAmbient:
    "vec3 n, v; if (!pvSphere(p, n, v)) return vec3(0.08); return hemiAmbient(n, vec3(0.45, 0.65, 1.0), vec3(0.45, 0.3, 0.15));",
  rim: "vec3 n, v; if (!pvSphere(p, n, v)) return vec3(0.04); return vec3(0.08, 0.1, 0.14) + vec3(0.4, 0.9, 1.0) * rimLight(n, v, 3.0);",
  sky: "vec3 rd = normalize(vec3(p.x, p.y + 0.4, 1.4)); return skyColor(rd, normalize(vec3(0.3, 0.25, 1.0)));",
  fog: "float t = uv.x * 20.0; vec3 rd = normalize(vec3(p, 1.5)); return applyFog(vec3(0.9, 0.5, 0.3) * step(0.3, uv.y), t, rd, normalize(vec3(0.0, 0.2, 1.0)), 0.12);",
  // ---- 애니메이션 · 이징 (가로 = 시간 0~1) ----
  remap: "return mix(pvBack(uv), vec3(0.4, 0.8, 1.0), pvCurve(uv, linearstep(0.25, 0.75, uv.x)));",
  easing:
    "vec3 col = pvBack(uv); col = mix(col, vec3(0.4, 0.8, 1.0), pvCurve(uv, easeInOutCubic(uv.x))); col = mix(col, vec3(1.0, 0.6, 0.3), pvCurve(uv, easeOutBack(uv.x))); return mix(col, vec3(0.5, 1.0, 0.5), pvCurve(uv, easeOutElastic(uv.x)));",
  pingpong: "return mix(pvBack(uv), vec3(0.4, 0.8, 1.0), pvCurve(uv, pingPong(uv.x * 4.0)));",
  pulse:
    "vec3 col = mix(pvBack(uv), vec3(0.4, 0.8, 1.0), pvCurve(uv, pulse(0.3, 0.1, uv.x))); return mix(col, vec3(1.0, 0.6, 0.3), pvCurve(uv, impulse(8.0, uv.x)));",
  shake:
    "vec2 s = shake(uv.x * 6.0, 2.0, 0.4); vec3 col = mix(pvBack(uv), vec3(0.4, 0.8, 1.0), pvCurve(uv, 0.5 + s.x)); return mix(col, vec3(1.0, 0.6, 0.3), pvCurve(uv, 0.5 + s.y));",
  bounce: "return mix(pvBack(uv), vec3(0.4, 0.8, 1.0), pvCurve(uv, bounce(uv.x * 3.0, 1.0)));",
  stepped: "return mix(pvBack(uv), vec3(0.4, 0.8, 1.0), pvCurve(uv, steppedTime(uv.x, 8.0)));",
  spring: "return mix(pvBack(uv), vec3(0.4, 0.8, 1.0), pvCurve(uv, 0.75 * dampedSpring(uv.x * 2.0, 14.0, 3.0)));",
  // ---- 후처리 (왼쪽 원본 · 오른쪽 적용) ----
  aces: "vec3 hdr = pvImage(uv) * 4.0; return pvSplit(uv, clamp(hdr, 0.0, 1.0), acesTonemap(hdr));",
  vignette: "return pvSplit(uv, pvImage(uv), pvImage(uv) * vignette(uv, 1.2));",
  grain: "return pvSplit(uv, pvImage(uv), filmGrain(pvImage(uv), gl_FragCoord.xy, uTime, 0.25));",
  chromatic: "return pvSplit(uv, pvImage(uv), chromaticAberration(iChannel0, uv, 0.03));",
  posterize: "return pvSplit(uv, pvImage(uv), posterize(pvImage(uv), 4.0));",
  liftGammaGain:
    "return pvSplit(uv, pvImage(uv), liftGammaGain(pvImage(uv), vec3(0.05, 0.0, 0.1), vec3(1.0, 1.1, 0.9), vec3(1.1, 1.0, 0.85)));",
  bayer: "float v = luminance3(pvImage(uv)); return pvSplit(uv, vec3(v), vec3(step(bayer4(gl_FragCoord.xy), v)));",
  halftone:
    "float v = luminance3(pvImage(uv)); return pvSplit(uv, vec3(v), vec3(1.0 - halftone(gl_FragCoord.xy, 1.0 - v, 8.0, 0.5)));",
  barrel:
    "vec2 q = barrelDistort(uv, 0.4); vec3 c = all(greaterThanEqual(q, vec2(0.0))) && all(lessThanEqual(q, vec2(1.0))) ? pvImage(q) : vec3(0.0); return pvSplit(uv, pvImage(uv), c);",
  sharpen: "return pvSplit(uv, pvImage(uv), sharpen(iChannel0, uv, 1.0 / uResolution, 1.5).rgb);",
  scanline: "return pvSplit(uv, pvImage(uv), scanlines(pvImage(uv), gl_FragCoord.y, 0.5));",
  // ---- 버퍼 · 텍스처 (iChannel0 = 시험용 그림) ----
  blur9: "return pvSplit(uv, pvImage(uv), blur9(iChannel0, uv, 3.0 / uResolution).rgb);",
  gaussian: "return pvSplit(uv, pvImage(uv), gaussianBlur(iChannel0, uv, vec2(3.0 / uResolution.x, 0.0)).rgb);",
  sobel: "return pvSplit(uv, pvImage(uv), vec3(sobelEdge(iChannel0, uv, 1.0 / uResolution)));",
  laplacian: "return pvSplit(uv, pvImage(uv), abs(laplacian(iChannel0, uv, 1.0 / uResolution).rgb) * 6.0);",
  advect:
    "return pvSplit(uv, pvImage(uv), advect(iChannel0, gl_FragCoord.xy, 12.0 * vec2(sin(uv.y * 12.0), 0.0), uResolution).rgb);",
};
// 그림 함수 본문에서 쓰지만 조각이 정의하지 않는 이름: 도우미로 함께 넣는다.
const EXTRA = {
  luminance3: "float luminance3(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }",
};

// 조각 + 미리보기 → 완성된 프래그먼트 셰이더 (미리보기가 없으면 null). plan은 snippets.plan.
const source = (item, plan) => {
  const preview = PREVIEWS[item.id];
  if (!preview) return null;
  if (preview.self) return item.code;
  const globals = plan(item.id, "")
    .globals.filter(entry => (entry.scope || "global") === "global")
    .map(entry => entry.code)
    .join("\n\n");
  const body = typeof preview === "string" ? preview : "return pvRender(p);";
  const map = typeof preview === "object" && preview.map ? preview.map : null;
  const usesMap = map !== null,
    contract = /\bmap\s*\(/.test(globals) && !/\bfloat\s+map\s*\(/.test(globals);
  const extra = Object.entries(EXTRA)
    .filter(([name]) => new RegExp(`\\b${name}\\s*\\(`).test(body))
    .map(([, code]) => code)
    .join("\n");
  return (
    HEADER +
    (usesMap ? "float pvMap(vec3 p);\n" : "") +
    (contract ? "float map(vec3 p);\n" : "") +
    globals +
    "\n" +
    HELPERS +
    "\n" +
    extra +
    "\n" +
    (usesMap ? `float pvMap(vec3 p) {\n    ${map}\n}\n${HELPERS_3D}\n` : "") +
    (contract ? "float map(vec3 p) { return pvMap(p); }\n" : "") +
    `vec3 previewColor(vec2 uv, vec2 p) {\n    ${body}\n}\n` +
    "void main() {\n    vec2 uv = gl_FragCoord.xy / uResolution, p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;\n    fragColor = vec4(clamp(previewColor(uv, p), 0.0, 1.0), 1.0);\n}\n"
  );
};

// 시험용 그림: 하늘 그라디언트 · 원 · 줄무늬 · 바둑판. 후처리·버퍼 조각의 미리보기에 iChannel0으로 들어간다.
const testImage = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const sky = g.createLinearGradient(0, 0, 0, 128);
  sky.addColorStop(0, "#2b4a8c");
  sky.addColorStop(0.6, "#e0807a");
  sky.addColorStop(1, "#f4c86a");
  g.fillStyle = sky;
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 16; i++) {
    g.fillStyle = i % 2 ? "#1b1f2b" : "#f2efe6";
    g.fillRect(i * 16, 104, 16, 24);
  }
  // 왼쪽·오른쪽 반에 같은 종류의 모양을 둔다: 미리보기는 왼쪽 = 원본, 오른쪽 = 적용 결과로 나눠 보여 준다.
  for (const x of [0, 128]) {
    g.fillStyle = "#ffd34d";
    g.beginPath();
    g.arc(x + 82, 54, 24, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#2fbf8f";
    g.beginPath();
    g.moveTo(x + 10, 104);
    g.lineTo(x + 50, 62);
    g.lineTo(x + 92, 104);
    g.fill();
    g.strokeStyle = "#ffffff";
    g.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.moveTo(x + 10, 14 + i * 10);
      g.lineTo(x + 54, 24 + i * 10);
      g.stroke();
    }
  }
  return canvas;
};

const create = ({ plan }) => {
  let gl = null,
    surface = null,
    vao = null,
    vs = null,
    ready = false,
    unavailable = false;
  const done = new Map(), // 조각 id → 그린 결과 캔버스(실패하면 null)
    pending = new Map(); // 조각 id → 그리는 중인 Promise
  const init = () => {
    if (ready || unavailable) return ready;
    surface = document.createElement("canvas");
    surface.width = WIDTH;
    surface.height = HEIGHT;
    gl = surface.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
    if (!gl) {
      unavailable = true;
      return false;
    }
    vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(
      vs,
      "#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0.0,1.0);}"
    );
    gl.compileShader(vs);
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.viewport(0, 0, WIDTH, HEIGHT);
    const image = testImage();
    for (const unit of [0, 1]) {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // 캔버스 위쪽이 텍스처 v = 1(화면 위)이 되도록
      if (image) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      else
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          1,
          1,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          new Uint8Array([128, 128, 128, 255])
        );
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }
    ready = true;
    return true;
  };
  // 링크된 프로그램으로 한 장 그려 결과 캔버스(WIDTH×HEIGHT)를 만든다.
  const paint = program => {
    gl.bindVertexArray(vao);
    gl.viewport(0, 0, WIDTH, HEIGHT);
    gl.useProgram(program);
    const at = name => gl.getUniformLocation(program, name);
    gl.uniform2f(at("uResolution"), WIDTH, HEIGHT);
    gl.uniform1f(at("uTime"), TIME);
    gl.uniform1f(at("uDeltaTime"), 1 / 60);
    gl.uniform1i(at("uFrame"), 120);
    gl.uniform4f(at("uMouse"), -1, -1, 0, 0);
    gl.uniform1i(at("iChannel0"), 0);
    gl.uniform1i(at("iChannel1"), 1);
    gl.uniform3fv(at("iChannelResolution"), [256, 128, 1, 256, 128, 1, 0, 0, 0, 0, 0, 0]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const result = document.createElement("canvas");
    result.width = WIDTH;
    result.height = HEIGHT;
    result.getContext("2d")?.drawImage(surface, 0, 0);
    return result;
  };
  // 조각 하나를 그려 결과 캔버스를 돌려준다. 컴파일 실패나 WebGL2가 없으면 null. 컴파일을 기다리며 멈추는 동기식이다
  // (테스트·내보내기용). 화면의 조각 카드는 draw()가 비동기로 그린다.
  const render = item => {
    if (done.has(item.id)) return done.get(item.id);
    const fragment = source(item, plan);
    if (!fragment || !init()) {
      done.set(item.id, null);
      return null;
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragment);
    gl.compileShader(fs);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(fs);
    let result = null;
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) result = paint(program);
    else console.warn(`코드 조각 미리보기 실패: ${item.id}`, gl.getProgramInfoLog(program) || gl.getShaderInfoLog(fs));
    gl.deleteProgram(program);
    done.set(item.id, result);
    return result;
  };
  // 비동기판: 컴파일은 브라우저가 뒤에서 하고(KHR_parallel_shader_compile), 끝나면 그린다. 같은 조각은 한 번만 그린다.
  const renderAsync = item => {
    if (done.has(item.id)) return Promise.resolve(done.get(item.id));
    if (pending.has(item.id)) return pending.get(item.id);
    const fragment = source(item, plan);
    if (!fragment || !init()) {
      done.set(item.id, null);
      return Promise.resolve(null);
    }
    const promise = Lazy.compileProgram(gl, vs, fragment).then(({ program, log }) => {
      let result = null;
      if (program && gl) {
        result = paint(program);
        gl.deleteProgram(program);
      } else if (!program) console.warn(`코드 조각 미리보기 실패: ${item.id}`, log);
      pending.delete(item.id);
      done.set(item.id, result);
      return result;
    });
    pending.set(item.id, promise);
    return promise;
  };
  const apply = (canvas, image) => {
    if (image) {
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.closest(".snippet-preview")?.classList.add("is-ready");
    } else canvas.closest(".snippet-preview")?.remove();
  };
  // 카드가 화면에 보일 때만, 한 프레임에 하나씩 그린다(lazy-render.js). 범주를 바꾸거나 검색해 목록을 다시 그려도
  // 이미 그린 조각은 바로 붙이고, 사라진 카드는 대기열에서 빠진다.
  let lazy = Lazy.createVisibleQueue({ margin: "240px" });
  const draw = (item, canvas) => {
    if (!PREVIEWS[item.id] || unavailable) return false;
    if (done.has(item.id)) {
      apply(canvas, done.get(item.id));
      return true;
    }
    lazy.add(canvas, async () => {
      const image = await renderAsync(item);
      if (canvas.isConnected) apply(canvas, image);
    });
    return true;
  };
  const dispose = () => {
    lazy.dispose();
    lazy = Lazy.createVisibleQueue({ margin: "240px" });
    pending.clear();
    done.clear();
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    gl = null;
    ready = false;
  };
  return { draw, render, renderAsync, has: id => !!PREVIEWS[id] && !unavailable, dispose };
};
export { create, source, PREVIEWS, WIDTH, HEIGHT };
