// 예제 갤러리와 첫 실행 안내. 썸네일은 별도의 작은 WebGL2 컨텍스트에서 한 번만 그리고 즉시 해제한다.
// 예제 적용은 Studio API(loadExample/example*)만 사용하므로 Undo·미적용 변경 확인이 그대로 동작한다.
import * as Annotations from "./annotations.js";
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
  const aurora = head("uniform float uSpeed;\nuniform float uWarp;\nuniform vec3 uTint;\n") + `
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
    vec2 q = vec2(fbm(uv * 2.0 + t * 0.1), fbm(uv * 2.0 + vec2(5.2, 1.3) - t * 0.08));
    vec2 r = vec2(fbm(uv * 2.0 + uWarp * q + vec2(1.7, 9.2) + t * 0.15), fbm(uv * 2.0 + uWarp * q + vec2(8.3, 2.8)));
    float f = fbm(uv * 2.0 + uWarp * r);
    vec3 col = mix(vec3(0.02, 0.03, 0.08), uTint, smoothstep(0.2, 0.9, f));
    col = mix(col, vec3(0.95, 0.4, 0.8), smoothstep(0.6, 1.2, length(q) * f));
    col += 0.25 * vec3(0.4, 0.9, 1.0) * pow(r.y, 4.0);
    fragColor = vec4(pow(col, vec3(0.9)), 1.0);
}`;
  const kaleido = head("uniform float uSegments;\nuniform float uZoom;\n") + `
// 극좌표를 uSegments 조각으로 접어 만든 만화경. 마우스를 움직이면 중심이 따라간다.
vec3 palette(float t) { return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    if (uMouse.x >= 0.0) uv -= 0.25 * (uMouse - 0.5 * uResolution) / uResolution.y;
    float a = atan(uv.y, uv.x), r = length(uv);
    float seg = 6.28318 / max(uSegments, 1.0);
    a = abs(mod(a, seg) - 0.5 * seg);
    vec2 p = r * vec2(cos(a), sin(a)) * uZoom;
    vec3 col = vec3(0.0);
    for (float i = 0.0; i < 4.0; i++) {
        p = fract(p * 1.5 + 0.1 * uTime) - 0.5;
        float d = length(p) * exp(-r);
        d = abs(sin(d * 8.0 + uTime) / 8.0);
        col += palette(r + i * 0.4 + uTime * 0.2) * pow(0.012 / d, 1.2);
    }
    fragColor = vec4(col * smoothstep(1.4, 0.2, r), 1.0);
}`;
  const lava = head("uniform float uSoftness;\nuniform vec3 uHot;\nuniform vec3 uCool;\n") + `
// 2D 메타볼: 원 거리장을 smooth-min으로 합쳐 서로 녹아 붙는 덩어리를 만든다.
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    float d = 1e3;
    for (int i = 0; i < 7; i++) {
        float fi = float(i);
        vec2 c = 0.55 * vec2(sin(uTime * (0.31 + 0.07 * fi) + fi * 1.7), cos(uTime * (0.23 + 0.05 * fi) + fi * 2.3));
        d = smin(d, length(uv - c) - (0.12 + 0.04 * sin(fi + uTime)), uSoftness);
    }
    if (uMouse.x >= 0.0) d = smin(d, length(uv - (uMouse - 0.5 * uResolution) / uResolution.y) - 0.1, uSoftness);
    float edge = smoothstep(0.01, -0.01, d);
    float glow = exp(-12.0 * max(d, 0.0));
    vec3 col = mix(vec3(0.03, 0.02, 0.05), uCool, glow * 0.6);
    col = mix(col, mix(uHot, vec3(1.0, 0.95, 0.8), smoothstep(0.0, -0.15, d)), edge);
    fragColor = vec4(col, 1.0);
}`;
  const horizon = head("uniform float uGridSpeed;\nuniform vec3 uGlow;\n") + `
// 원근 격자와 줄무늬 태양: 화면 아래 절반을 바닥 평면으로 투영한다.
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    vec3 sky = mix(vec3(0.05, 0.02, 0.12), vec3(0.6, 0.1, 0.45), smoothstep(-0.1, 0.5, -uv.y + 0.3));
    vec3 col = sky;
    vec2 sp = uv - vec2(0.0, 0.12);
    float sun = smoothstep(0.30, 0.29, length(sp));
    float stripes = step(0.0, sin(sp.y * 60.0 - uTime * 2.0)) + step(0.05, sp.y);
    col = mix(col, mix(vec3(1.0, 0.25, 0.5), vec3(1.0, 0.85, 0.3), smoothstep(-0.3, 0.3, sp.y)), sun * min(stripes, 1.0));
    if (uv.y < -0.05) {
        float z = 0.35 / (-uv.y - 0.03);
        vec2 g = vec2(uv.x * z, z + uTime * uGridSpeed);
        vec2 w = fwidth(g);
        vec2 d = 0.5 - abs(fract(g) - 0.5); // 가장 가까운 격자선까지의 거리
        vec2 line = 1.0 - smoothstep(vec2(0.0), w * 1.5, d);
        float grid = max(line.x, line.y) * exp(-0.06 * z);
        col = mix(vec3(0.02, 0.0, 0.05), uGlow, grid) + uGlow * 0.15 * exp(-8.0 * (-uv.y - 0.05));
    }
    col += uGlow * 0.4 * exp(-60.0 * abs(uv.y + 0.05));
    fragColor = vec4(col, 1.0);
}`;
  const truchet = head("uniform float uScale;\nuniform vec3 uInk;\n") + `
// Truchet 타일: 셀마다 무작위로 회전한 사분원 두 개가 끊김 없는 미로를 만든다.
${HASH}
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y * uScale + vec2(uTime * 0.25, 0.0);
    vec2 id = floor(uv), f = fract(uv) - 0.5;
    if (hash(id) > 0.5) f.x = -f.x;
    vec2 c = f - sign(f.x + f.y + 1e-4) * 0.5;
    float d = abs(length(c) - 0.5);
    float w = 0.09 + 0.04 * sin(uTime + hash(id) * 6.28);
    float px = uScale / uResolution.y;
    float line = smoothstep(w + px, w - px, d);
    float shade = 0.5 + 0.5 * sin(atan(c.y, c.x) * 2.0 + uTime * 3.0);
    vec3 col = mix(vec3(0.95, 0.93, 0.88), uInk * (0.6 + 0.4 * shade), line);
    fragColor = vec4(col * (1.0 - 0.25 * length((gl_FragCoord.xy / uResolution) - 0.5)), 1.0);
}`;
  const voronoi = head("uniform float uScale;\nuniform float uEdge;\nuniform vec3 uLead;\n") + `
// 보로노이(셀) 무늬: 칸마다 해시로 점 하나를 두고, 픽셀에서 가장 가까운 점과 두 번째로 가까운 점을 찾는다.
// 점은 이웃 칸에도 있으므로 3×3 칸만 보면 된다. 두 거리의 차(d2 - d1)가 작을수록 경계에 가깝다.
${HASH3}
vec3 palette(float t) { return 0.55 + 0.45 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    vec2 p = uv * uScale + uTime * vec2(0.15, 0.05);   // 계속 흐르므로 칸 번호가 커진다 → 정수 해시
    vec2 g = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    vec3 cell = vec3(0.0);
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(x, y);
        vec3 h = hash3(g + o);                                   // xy = 점의 움직임 위상, z = 칸 색
        vec2 point = o + 0.5 + 0.38 * sin(uTime * 0.7 + 6.2831 * h.xy);
        float d = length(point - f);
        if (d < d1) { d2 = d1; d1 = d; cell = h; } else if (d < d2) d2 = d;
    }
    float edge = d2 - d1;
    vec3 glass = palette(cell.z + 0.05 * uTime) * (0.65 + 0.35 * smoothstep(0.7, 0.0, d1)); // 가운데가 밝은 유리
    vec3 col = mix(uLead, glass, smoothstep(uEdge * 0.5, uEdge, edge));                      // 납 테두리
    col += glass * 0.35 * exp(-30.0 * edge);                                                  // 테두리에 번지는 빛
    fragColor = vec4(pow(col, vec3(0.95)), 1.0);
}`;
  const starfield = head("uniform float uSpeed;\nuniform vec3 uTint;\n") + `
// 시차(parallax) 별밭: 별이 든 격자를 4겹 겹쳐 서로 다른 속도로 흘린다. 앞 겹일수록 별이 크고 빠르다.
// 시간이 갈수록 좌표가 끝없이 커지지만 정수 해시라 몇 시간을 흘려도 별 배치에 무늬가 생기지 않는다.
${HASH3}
float stars(vec2 p, float t) {
    vec2 id = floor(p), f = fract(p) - 0.5;
    vec3 h = hash3(id);
    if (h.z < 0.6) return 0.0;                          // 40% 칸에만 별
    vec2 pos = (h.xy - 0.5) * 0.6;                      // 칸 안 무작위 위치 (가장자리 여유를 남김)
    float d = length(f - pos);
    float twinkle = 0.6 + 0.4 * sin(t * (1.0 + 4.0 * h.x) + 6.2831 * h.y);
    float core = smoothstep(0.035 + 0.06 * (h.z - 0.6), 0.0, d);
    float glow = 0.004 / (d * d + 0.004) * smoothstep(0.45, 0.1, d);   // 칸 경계 전에 0으로 줄인다
    return twinkle * (core + 0.35 * glow);
}
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    vec3 col = mix(vec3(0.005, 0.006, 0.02), vec3(0.04, 0.02, 0.08), smoothstep(-0.6, 0.6, uv.y));
    for (int i = 0; i < 4; i++) {
        float depth = 1.0 + float(i);                   // 1 = 가장 앞
        vec2 p = uv * (5.0 * depth) + vec2(uTime * uSpeed * 3.0 / depth, 41.0 * float(i));
        vec3 tint = mix(vec3(1.0, 0.9, 0.8), uTint, float(i) / 3.0);
        col += tint * stars(p, uTime + 7.0 * float(i)) / depth;
    }
    fragColor = vec4(1.0 - exp(-1.6 * col), 1.0);      // 밝은 별이 하얗게 날아가지 않게 톤 매핑
}`;
  const p = (name, type, value, options = {}) => ({name, type, value, options});
  const ART = [
    {id:"aurora", title:"Aurora Flow", tag:"Noise · Domain warp", description:"fbm으로 좌표를 두 번 비트는 도메인 워핑. 흐르는 오로라.", image:aurora,
      users:[p("uSpeed","float",0.6,{min:0,max:3,step:0.01}), p("uWarp","float",4,{min:0,max:10,step:0.1}), p("uTint","vec3",[0.2,0.75,0.9])]},
    {id:"kaleido", title:"Kaleido Bloom", tag:"Polar · Pattern", description:"극좌표 접기로 만든 만화경. 마우스로 중심을 옮겨 보세요.", image:kaleido,
      users:[p("uSegments","float",8,{min:1,max:24,step:1}), p("uZoom","float",1.2,{min:0.2,max:4,step:0.01})]},
    {id:"lava", title:"Metaball Lava", tag:"SDF · 2D", description:"smooth-min으로 녹아 붙는 메타볼. 커서도 덩어리가 됩니다.", image:lava,
      users:[p("uSoftness","float",0.18,{min:0.01,max:0.6,step:0.01}), p("uHot","vec3",[1,0.35,0.1]), p("uCool","vec3",[0.5,0.1,0.6])]},
    {id:"horizon", title:"Neon Horizon", tag:"Projection · Grid", description:"화면 하단을 바닥 평면으로 투영한 원근 격자와 줄무늬 태양.", image:horizon,
      users:[p("uGridSpeed","float",1.5,{min:0,max:6,step:0.01}), p("uGlow","vec3",[0.2,0.9,1])]},
    {id:"truchet", title:"Truchet Weave", tag:"Tiling · Hash", description:"셀마다 무작위로 뒤집힌 사분원이 끝없는 미로를 엮습니다.", image:truchet,
      users:[p("uScale","float",6,{min:2,max:20,step:0.1}), p("uInk","vec3",[0.15,0.2,0.55])]},
    {id:"voronoi", title:"Voronoi Glass", tag:"Cellular · Hash", description:"칸마다 해시로 둔 점이 흔들리는 셀 무늬 스테인드글라스.", image:voronoi,
      users:[p("uScale","float",5,{min:1,max:16,step:0.1}), p("uEdge","float",0.08,{min:0.01,max:0.3,step:0.005}), p("uLead","vec3",[0.04,0.03,0.05])]},
    {id:"starfield", title:"Starfield Drift", tag:"Layers · Hash", description:"속도가 다른 별 격자 4겹이 끝없이 흐르는 시차 별밭.", image:starfield,
      users:[p("uSpeed","float",0.4,{min:0,max:3,step:0.01}), p("uTint","vec3",[0.55,0.75,1])]}
  ];
  // ---- 기법 배우기: 기능 하나씩을 보여주는 작은 프로젝트. 주석이 곧 설명서다. ----
  const annotated = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
// 아래 주석의 @태그가 파라미터 패널의 슬라이더·색상 선택기를 자동으로 만든다.
uniform float uRadius;   // @range 0.05 0.6 @step 0.005 @default 0.28
uniform float uSoftness; // @range 0.001 0.2 @step 0.001 @default 0.02
uniform int   uCount;    // @min 1 @max 12 @default 6
uniform vec2  uCenter;   // @range -1 1 @default 0
uniform vec3  uColor;    // @color @default 1.0 0.45 0.2
uniform vec3  uBack;     // @color @default 0.05 0.04 0.09
out vec4 fragColor;
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y - uCenter * 0.5;
    float d = 1e3;
    for (int i = 0; i < 12; i++) {
        if (i >= uCount) break;
        float a = 6.28318 * float(i) / float(uCount) + uTime * 0.4;
        d = min(d, length(uv - 0.45 * vec2(cos(a), sin(a))) - uRadius * 0.4);
    }
    d = min(d, length(uv) - uRadius);
    float shape = 1.0 - smoothstep(-uSoftness, uSoftness, d);
    fragColor = vec4(mix(uBack, uColor, shape), 1.0);
}`;
  const hashPrecision = `#version 300 es
precision highp float;
uniform vec2 uResolution;
// 해시와 큰 좌표: 같은 칸 번호를 두 해시에 넣어 비교한다. 왼쪽 = 실수 해시(예전 방식), 오른쪽 = 정수 해시.
// 해시 값이 상위 4%인 칸만 점으로 찍으면 규칙성이 눈에 잘 띈다. 무작위라면 점이 어디에도 줄지어 서지 않는다.
// uOffset을 0부터 올려 보세요. 실수 해시는 수십만부터 점이 행·열로 줄을 서고, 천만 근처에서는 격자가 됩니다.
uniform float uOffset;  // @range 0 10000000 @step 1000 @default 10000000
uniform float uCell;    // @range 1 8 @step 1 @default 2
uniform int   uShowRaw; // @min 0 @max 1 @default 0
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
uniform float uBlur;  // @range 0 8 @step 0.1 @default 5
uniform float uFocus; // @range 0 1 @step 0.01 @default 0.5
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float lod = uBlur * smoothstep(0.05, 0.45, abs(uv.y - uFocus));
    fragColor = textureLod(iChannel0, uv, lod);
}`;
  const reactionSource = `#version 300 es
precision highp float;
// Buffer A · 512×512 고정 · RGBA16F · Wrap Repeat · iChannel0 = A previous (자기 자신의 지난 프레임)
// Gray-Scott 반응-확산: r = 물질 U, g = 물질 V. 매 프레임 한 단계씩 시뮬레이션한다.
uniform vec2 uResolution;
uniform int uFrame;
uniform vec4 uMouse;          // 누르고 있는 동안 커서 주변에 V를 심는다
uniform sampler2D iChannel0;
uniform float uFeed;          // @range 0.01 0.09 @step 0.0005 @default 0.037
uniform float uKill;          // @range 0.04 0.07 @step 0.0005 @default 0.06
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
uniform vec3 uLow;   // @color @default 0.03 0.02 0.08
uniform vec3 uHigh;  // @color @default 0.35 0.95 1.0
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float v = texture(iChannel0, uv).g;
    vec3 col = mix(uLow, uHigh, smoothstep(0.12, 0.4, v));
    col += vec3(1.0, 0.4, 0.8) * smoothstep(0.4, 0.6, v) * 0.5;
    fragColor = vec4(col, 1.0);
}`;
  // 기존 Studio 예제(멀티 패스·3D)는 Studio가 소유한 정의를 그대로 호출한다. project가 있는 항목은 갤러리가 직접 정의한다.
  // users 없이 열면 소스의 @어노테이션이 파라미터를 자동 등록한다(어노테이션 기능 자체를 보여주기 위함).
  const LESSONS = [
    {id:"annotations", title:"Annotated Parameters", tag:"@range · @color", description:"GLSL 주석만으로 슬라이더·색상 파라미터를 만드는 법.", image:annotated, thumb:"annotations",
      project:{image:annotated, passes:[], imageChannels:{}}},
    {id:"hashprecision", title:"Hash Precision", tag:"Hash · 큰 좌표", description:"실수 해시와 정수 해시를 나란히 비교. 좌표가 커지면 실수 해시에만 격자가 생깁니다.", image:hashPrecision, thumb:"hashprecision",
      project:{image:hashPrecision, passes:[], imageChannels:{}}},
    {id:"reaction", title:"Reaction–Diffusion", tag:"Fixed size · RGBA16F · Repeat", description:"고정 해상도 피드백 시뮬레이션. 화면을 눌러 끌면 패턴을 심습니다.", thumb:"reaction",
      project:{image:reactionImage, passes:[{name:"A", fragment:reactionSource, format:"rgba16f", scale:1, size:[512,512], wrap:"repeat", channels:{0:{buffer:"A", frame:"previous"}}}], imageChannels:{0:{buffer:"A", frame:"current"}}}},
    {id:"mrt", title:"MRT Outputs", tag:"Out = 2 · A[1]", description:"한 패스에서 색과 거리장을 동시에 쓰고 Image에서 따로 읽기.", thumb:"mrt",
      project:{image:mrtImage, passes:[{name:"A", fragment:mrtSource, format:"rgba16f", scale:1, outputs:2, channels:{}}], imageChannels:{0:{buffer:"A", frame:"current"}, 1:{buffer:"A", frame:"current", attachment:1}}}},
    {id:"mipblur", title:"Mipmap Blur", tag:"Mip · textureLod", description:"밉맵 레벨을 골라 읽는 저비용 블러(틸트 시프트).", thumb:"mipblur",
      project:{image:mipImage, passes:[{name:"A", fragment:mipSource, format:"rgba8", scale:1, mipmap:true, channels:{}}], imageChannels:{0:{buffer:"A", frame:"current"}}}},
    {id:"raymarch", title:"Ray Marching SDF", tag:"3D · Camera", description:"SDF 장면, Orbit 카메라, 스텝 히트맵 디버그.", action:"exampleRaymarch", thumb:"raymarch"},
    {id:"pipeline", title:"Buffer Pipeline", tag:"Multi-pass", description:"A → B 후처리 → Image. 버퍼 연결의 기본.", action:"examplePipeline", thumb:"pipeline"},
    {id:"feedback", title:"Feedback Trails", tag:"Multi-pass · previous", description:"이전 프레임을 읽어 잔상을 누적하는 피드백 루프.", action:"exampleFeedback", thumb:"feedback"}
  ];
  const mount = ({studio, Shader}) => {
    const $ = id => document.getElementById(id), controller = new AbortController(), signal = controller.signal;
    const dialog = $("gallery"), grid = $("galleryGrid"), lessons = $("galleryLessons");
    let thumbsDrawn = false;
    const element = (tag, className = "", text = "") => { const node = document.createElement(tag); if(className) node.className = className; if(text) node.textContent = text; return node; };
    const card = (item, onPick) => {
      const button = element("button","gallery-card"); button.type = "button"; button.dataset.id = item.id;
      const art = element("canvas","gallery-thumb"); art.width = 320; art.height = 200; art.dataset.thumb = item.thumb || item.id; art.setAttribute("aria-hidden","true");
      const meta = element("span","gallery-meta"); meta.append(element("span","gallery-tag",item.tag), element("strong","",item.title), element("span","gallery-desc",item.description));
      button.append(art, meta); button.addEventListener("click", () => onPick(item)); return button;
    };
    const finishOnboarding = () => { try { localStorage.setItem(ONBOARD_KEY, "1"); } catch (_) {} };
    const pick = async item => {
      if(dialog.open) dialog.close(); finishOnboarding();
      const project = item.project || {image:item.image, passes:[], imageChannels:{}};
      const ok = await (item.action ? studio[item.action]() : studio.loadExample(project, item.users || []));
      if(ok) studio.open();
      return ok;
    };
    // 가이드의 "예제 열기" 버튼용: id로 예제를 바로 연다.
    const loadLesson = id => { const item = [...ART, ...LESSONS].find(entry => entry.id === id); return item ? pick(item) : false; };
    grid.replaceChildren(...ART.map(item => card(item, pick)));
    lessons.replaceChildren(...LESSONS.map(item => card(item, pick)));
    // 썸네일 전용 임시 컨텍스트: 각 예제를 t=2.5초로 한 프레임 그린 뒤 카드 캔버스로 복사하고 컨텍스트를 해제한다.
    const drawThumbs = () => {
      if(thumbsDrawn) return; thumbsDrawn = true;
      const surface = document.createElement("canvas"); surface.width = 320; surface.height = 200;
      const gl = surface.getContext("webgl2", {preserveDrawingBuffer:true, antialias:false}); if(!gl) return;
      const compile = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn("썸네일 컴파일 실패", gl.getShaderInfoLog(s)); gl.deleteShader(s); return null; } return s; };
      const vs = compile(gl.VERTEX_SHADER, Shader.vertex), vao = gl.createVertexArray(); gl.bindVertexArray(vao); gl.viewport(0, 0, 320, 200);
      const render = (fragment, users) => {
        const fs = compile(gl.FRAGMENT_SHADER, fragment); if(!vs || !fs) return false;
        const program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program); gl.deleteShader(fs);
        if(!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return false; }
        gl.useProgram(program); const at = name => gl.getUniformLocation(program, name);
        gl.uniform2f(at("uResolution"), 320, 200); gl.uniform1f(at("uTime"), 2.5); gl.uniform2f(at("uMouse"), -1, -1);
        for(const {name, type, value} of users) {
          const loc = at(name); if(!loc) continue;
          if(type === "float") gl.uniform1f(loc, value); else if(type === "int" || type === "bool") gl.uniform1i(loc, Number(value));
          else if(type === "uint") gl.uniform1ui(loc, value);
          else if(type === "vec2") gl.uniform2fv(loc, value); else if(type === "vec3") gl.uniform3fv(loc, value); else if(type === "vec4") gl.uniform4fv(loc, value);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3); gl.deleteProgram(program); return true;
      };
      const copy = id => { for(const target of dialog.querySelectorAll(`canvas[data-thumb="${id}"]`)) target.getContext("2d")?.drawImage(surface, 0, 0); };
      for(const item of ART) if(render(item.image, item.users)) copy(item.id);
      // 단일 패스 레슨은 어노테이션 기본값으로 썸네일을 그린다(파라미터를 소스에서 읽음).
      for(const item of LESSONS) if(item.image) render(item.image, Annotations.collect([item.image])) && copy(item.thumb || item.id);
      const ray = Shader.rayUniforms.map(([name, type, value]) => ({name, type, value}));
      if(render(Shader.raymarch, ray)) copy("raymarch");
      if(vs) gl.deleteShader(vs); gl.deleteVertexArray(vao); gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    const open = (welcome = false) => {
      dialog.dataset.welcome = String(welcome); if(!dialog.open) dialog.showModal();
      requestAnimationFrame(drawThumbs); $("galleryClose").focus();
    };
    const close = () => { finishOnboarding(); dialog.close(); };
    $("galleryToggle").addEventListener("click", () => open(false), {signal});
    $("galleryClose").addEventListener("click", close, {signal}); $("galleryBlank").addEventListener("click", close, {signal});
    dialog.addEventListener("close", finishOnboarding, {signal});
    dialog.addEventListener("click", event => { if(event.target === dialog) close(); }, {signal});
    document.addEventListener("keydown", event => {
      if(event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) return;
      if(event.key.toLowerCase() === "x" && !document.querySelector("dialog[open]")) { event.preventDefault(); open(false); }
    }, {signal});
    // 처음 방문한 사용자에게만 환영 화면과 함께 갤러리를 연다.
    let first = false; try { first = !localStorage.getItem(ONBOARD_KEY); } catch (_) {}
    if(first) setTimeout(() => open(true), 400);
    return {open, close, loadLesson, dispose:() => controller.abort()};
  }; export {mount};
