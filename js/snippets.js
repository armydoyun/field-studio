// GLSL 코드 조각 라이브러리. 순수 데이터 모듈(DOM·GPU 비의존)이며 가이드의 "코드 조각" 탭이 사용한다.
// 항목: {id, title, desc, code, requires?:[id…], scope?:"global"|"main"}
//  - scope "global"(기본): 함수·상수 정의 → 편집기가 main() 바깥(전역)에 넣는다.
//  - scope "main": main() 안에 쓰는 문장 → 커서 위치에 넣는다.
//  - requires: 먼저 필요한 다른 조각. 삽입 시 코드에 아직 없는 것만 함께 넣는다.
// 공식 출처: 해시는 Dave Hoskins "Hash without Sine"(MIT), 심플렉스 노이즈는 Ashima Arts/Stefan Gustavson(MIT),
// SDF·스무스 연산은 Inigo Quilez가 공개한 표준 공식을 따른다.
  const CATEGORIES = [
    {id:"hash", title:"해시 · 난수", desc:"좌표를 넣으면 0~1 의사난수를 돌려주는 함수. 노이즈·패턴·랜덤 배치의 기초입니다.", items:[
      {id:"hash11", title:"hash11", desc:"float → float 난수", code:`float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}`},
      {id:"hash21", title:"hash21", desc:"vec2 → float 난수 (셀·픽셀마다 하나의 값)", code:`float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}`},
      {id:"hash22", title:"hash22", desc:"vec2 → vec2 난수 (셀 안의 무작위 위치·방향)", code:`vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}`},
      {id:"hash13", title:"hash13", desc:"vec3 → float 난수 (3D 셀)", code:`float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}`},
      {id:"hash33", title:"hash33", desc:"vec3 → vec3 난수 (3D 무작위 벡터)", code:`vec3 hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
}`},
      {id:"hash31", title:"hash31", desc:"float → vec3 난수 (번호 하나로 색·위치 3개)", code:`vec3 hash31(float p) {
    vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}`},
      {id:"hash32", title:"hash32", desc:"vec2 → vec3 난수 (칸마다 무작위 색)", code:`vec3 hash32(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}`},
      {id:"pcg", title:"PCG 정수 해시", desc:"uint 기반 고품질 난수. 큰 좌표·누적 시뮬레이션에서도 패턴이 생기지 않음", code:`uint pcgHash(uint v) {
    uint state = v * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}
// 픽셀 좌표 + 시드 → 0~1 난수
float randPCG(uvec2 p, uint seed) {
    return float(pcgHash(p.x + pcgHash(p.y + pcgHash(seed)))) / 4294967295.0;
}`},
      {id:"frameRandom", title:"프레임마다 바뀌는 난수", desc:"픽셀·프레임별로 다른 값 (노이즈 디더·누적 렌더링). uFrame 필요", scope:"main", requires:["pcg"], code:`float rnd = randPCG(uvec2(gl_FragCoord.xy), uint(uFrame));`}]},
    {id:"noise", title:"노이즈 2D", desc:"부드럽게 변하는 무작위 값. 구름·지형·흐름·질감에 씁니다. 3D 버전은 '노이즈 3D' 범주에 있습니다.", items:[
      {id:"noise1D", title:"noise1D", desc:"1D 부드러운 노이즈, 0~1. 카메라 흔들림·깜빡임·값의 자연스러운 흔들림", requires:["hash11"], code:`float noise1D(float x) {
    float i = floor(x), f = fract(x);
    return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}`},
      {id:"valueNoise", title:"valueNoise (2D)", desc:"격자 값 보간 노이즈, 0~1", requires:["hash21"], code:`float valueNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
               mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}`},
      {id:"tileableNoise", title:"tileableNoise (반복 이음매 없음)", desc:"period 칸마다 정확히 반복되는 값 노이즈. 타일 텍스처·루프 애니메이션", requires:["hash21"], code:`float tileableNoise(vec2 p, vec2 period) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 i0 = mod(i, period), i1 = mod(i + 1.0, period);   // 격자 번호를 감싸면 가장자리가 이어진다
    return mix(mix(hash21(i0), hash21(vec2(i1.x, i0.y)), u.x),
               mix(hash21(vec2(i0.x, i1.y)), hash21(i1), u.x), u.y);
}`},
      {id:"gradientNoise", title:"gradientNoise (2D)", desc:"퍼린 계열 그래디언트 노이즈, 대략 -1~1. 값 노이즈보다 덜 각짐", requires:["hash22"], code:`float gradientNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic
    float n00 = dot(hash22(i) * 2.0 - 1.0, f);
    float n10 = dot(hash22(i + vec2(1, 0)) * 2.0 - 1.0, f - vec2(1, 0));
    float n01 = dot(hash22(i + vec2(0, 1)) * 2.0 - 1.0, f - vec2(0, 1));
    float n11 = dot(hash22(i + vec2(1, 1)) * 2.0 - 1.0, f - vec2(1, 1));
    return 1.4142 * mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}`},
      {id:"simplex", title:"simplexNoise (2D)", desc:"심플렉스 노이즈, 약 -1~1. 방향성 결이 적고 빠름", code:`vec3 permute289(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float simplexNoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute289(permute289(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 a0 = x - floor(x + 0.5);
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g = vec3(a0.x * x0.x + h.x * x0.y, a0.yz * x12.xz + h.yz * x12.yw);
    return 130.0 * dot(m, g);
}`},
      {id:"fbm", title:"fbm", desc:"여러 옥타브를 겹친 프랙털 노이즈, 0~1. 구름·지형", requires:["valueNoise"], code:`float fbm(vec2 p) {
    float value = 0.0, amplitude = 0.5;
    const mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);   // 옥타브마다 회전해 격자 결을 숨긴다
    for (int i = 0; i < 6; i++) {
        value += amplitude * valueNoise(p);
        p = rot * p * 2.02 + 17.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"fbmGradient", title:"fbmGradient", desc:"그래디언트 노이즈 fbm, 대략 -1~1. 값 노이즈 fbm보다 매끄럽고 덜 각짐", requires:["gradientNoise"], code:`float fbmGradient(vec2 p) {
    float value = 0.0, amplitude = 0.5;
    const mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 6; i++) {
        value += amplitude * gradientNoise(p);
        p = rot * p * 2.02 + 17.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"turbulence", title:"turbulence", desc:"|노이즈|를 겹친 난류, 0~1. 불꽃·연기·대리석 결", requires:["gradientNoise"], code:`float turbulence(vec2 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 6; i++) {
        value += amplitude * abs(gradientNoise(p));
        p = p * 2.03 + 7.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"curlNoise", title:"curlNoise (2D)", desc:"발산 없는 흐름 벡터장. 입자·잉크가 소용돌이치며 흐르게 (모이거나 흩어지지 않음)", requires:["gradientNoise"], code:`vec2 curlNoise(vec2 p) {
    const float e = 0.01;
    float dx = gradientNoise(p + vec2(e, 0.0)) - gradientNoise(p - vec2(e, 0.0));
    float dy = gradientNoise(p + vec2(0.0, e)) - gradientNoise(p - vec2(0.0, e));
    return vec2(dy, -dx) / (2.0 * e);   // 스칼라장의 기울기를 90° 돌린 것
}`},
      {id:"ridged", title:"ridgedFbm", desc:"능선형 프랙털. 산맥·번개·균열 느낌", requires:["gradientNoise"], code:`float ridgedFbm(vec2 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
        float n = 1.0 - abs(gradientNoise(p));
        value += amplitude * n * n;
        p = p * 2.03 + 11.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"domainWarp", title:"domainWarp", desc:"fbm으로 좌표를 비틀어 유체·대리석 같은 흐름 만들기", requires:["fbm"], code:`float domainWarp(vec2 p, float t) {
    vec2 q = vec2(fbm(p + vec2(0.0, t * 0.1)), fbm(p + vec2(5.2, 1.3)));
    vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + t * 0.15), fbm(p + 4.0 * q + vec2(8.3, 2.8)));
    return fbm(p + 4.0 * r);
}`},
      {id:"voronoi", title:"voronoi", desc:"셀 노이즈. x=가까운 점 거리, y=경계까지 여유(F2-F1), z=셀 고유값", requires:["hash22","hash21"], code:`vec3 voronoi(vec2 p) {
    vec2 n = floor(p), f = fract(p), id = vec2(0);
    float d1 = 8.0, d2 = 8.0;
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(i, j);
        vec2 r = g + hash22(n + g) - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = n + g; }
        else if (d < d2) { d2 = d; }
    }
    return vec3(sqrt(d1), sqrt(d2) - sqrt(d1), hash21(id));
}`}]},
    {id:"noise3d", title:"노이즈 3D", desc:"3차원 노이즈와 프랙털. 레이마칭 표면·구름 같은 부피 표현에 쓰고, 2D 화면에서는 z에 시간을 넣어 '형태가 변하며 흐르는' 노이즈로 씁니다.", items:[
      {id:"valueNoise3", title:"valueNoise3 (3D)", desc:"3D 값 노이즈, 0~1. 가장 싸고 단순", requires:["hash13"], code:`float valueNoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float a = mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x);
    float b = mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x);
    float c = mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x);
    float d = mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x);
    return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}`},
      {id:"gradientNoise3", title:"gradientNoise3 (3D 퍼린)", desc:"3D 그래디언트(퍼린) 노이즈, 대략 -1~1. 값 노이즈보다 결이 고름", requires:["hash33"], code:`float gradientNoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic
    // 격자 꼭짓점 8개의 무작위 기울기와 꼭짓점→점 벡터의 내적을 삼선형 보간
    #define GRAD(o) dot(hash33(i + o) * 2.0 - 1.0, f - o)
    float n000 = GRAD(vec3(0, 0, 0)), n100 = GRAD(vec3(1, 0, 0));
    float n010 = GRAD(vec3(0, 1, 0)), n110 = GRAD(vec3(1, 1, 0));
    float n001 = GRAD(vec3(0, 0, 1)), n101 = GRAD(vec3(1, 0, 1));
    float n011 = GRAD(vec3(0, 1, 1)), n111 = GRAD(vec3(1, 1, 1));
    #undef GRAD
    return 1.1547 * mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
                        mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}`},
      {id:"simplex3", title:"simplexNoise3 (3D 심플렉스)", desc:"3D 심플렉스 노이즈, 약 -1~1. 고품질·방향 결이 거의 없음 (Ashima/Gustavson, MIT)", code:`vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289v4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute4(vec4 x) { return mod289v4(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt4(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float simplexNoise3(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz), l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy), i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx, x2 = x0 - i2 + C.yyy, x3 = x0 - D.yyy;
    i = mod289v3(i);
    vec4 p = permute4(permute4(permute4(i.z + vec4(0.0, i1.z, i2.z, 1.0))
                             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                             + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    vec3 ns = 0.142857142857 * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z), y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy, y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy), b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0, s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy, a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x), p1 = vec3(a0.zw, h.y), p2 = vec3(a1.xy, h.z), p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt4(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}`},
      {id:"fbm3", title:"fbm3 (3D fbm)", desc:"3D 프랙털 노이즈, 0~1. 구름 밀도·암석 표면·흐르는 연기", requires:["valueNoise3"], code:`float fbm3(vec3 p) {
    float value = 0.0, amplitude = 0.5;
    const mat3 rot = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);   // 옥타브마다 회전
    for (int i = 0; i < 5; i++) {
        value += amplitude * valueNoise3(p);
        p = rot * p * 2.02;
        amplitude *= 0.5;
    }
    return value / 0.96875;   // 5옥타브 진폭 합으로 나눠 0~1로
}`},
      {id:"fbm3Simplex", title:"fbm3Simplex", desc:"심플렉스 기반 3D fbm, 대략 -1~1. 더 매끄럽지만 조금 무거움", requires:["simplex3"], code:`float fbm3Simplex(vec3 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
        value += amplitude * simplexNoise3(p);
        p = p * 2.03 + vec3(11.0, 7.0, 3.0);
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"ridged3", title:"ridgedFbm3", desc:"3D 능선 프랙털, 0~1. 산 표면·용암 균열", requires:["gradientNoise3"], code:`float ridgedFbm3(vec3 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
        float n = 1.0 - abs(gradientNoise3(p));
        value += amplitude * n * n;
        p = p * 2.03 + 5.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"turbulence3", title:"turbulence3", desc:"3D 난류, 0~1. 불꽃·연기를 시간축으로 흘리기 좋음", requires:["gradientNoise3"], code:`float turbulence3(vec3 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
        value += amplitude * abs(gradientNoise3(p));
        p = p * 2.03 + 3.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"voronoi3", title:"voronoi3 (3D 셀)", desc:"3D 셀 노이즈. x = 가까운 점 거리(F1), y = F2 − F1(경계), z = 셀 고유값", requires:["hash33","hash13"], code:`vec3 voronoi3(vec3 p) {
    vec3 n = floor(p), f = fract(p), id = vec3(0);
    float d1 = 8.0, d2 = 8.0;
    for (int k = -1; k <= 1; k++)
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
        vec3 g = vec3(i, j, k);
        vec3 r = g + hash33(n + g) - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = n + g; }
        else if (d < d2) { d2 = d; }
    }
    return vec3(sqrt(d1), sqrt(d2) - sqrt(d1), hash13(id));
}`},
      {id:"domainWarp3", title:"domainWarp3", desc:"3D fbm으로 좌표를 비튼 흐름 (t = 시간). 2D 화면에선 p = vec3(uv, 0)", requires:["fbm3"], code:`float domainWarp3(vec3 p, float t) {
    vec3 q = vec3(fbm3(p + vec3(0.0, 0.0, t)), fbm3(p + vec3(5.2, 1.3, 2.8)), fbm3(p + vec3(1.7, 9.2, t * 0.5)));
    return fbm3(p + 3.0 * q);
}`},
      {id:"flowNoise", title:"시간으로 흐르는 노이즈", desc:"2D 화면에서 3D fbm의 z축을 시간으로 — 미끄러지지 않고 형태 자체가 변함", requires:["fbm3"], scope:"main", code:`float n = fbm3(vec3(uv * 3.0, uTime * 0.25));`},
      {id:"volumeClouds", title:"부피 구름 (3D fbm 레이마칭)", desc:"fbm3 밀도장을 광선으로 누적하는 완성 장면 (현재 패스를 교체). 무거우면 렌더링 탭의 해상도 배율을 낮추세요", replace:true, code:`#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;

float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}
float valueNoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float a = mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x);
    float b = mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x);
    float c = mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x);
    float d = mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x);
    return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}
float fbm3(vec3 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 3; i++) { value += amplitude * valueNoise3(p); p = p * 2.03 + 1.7; amplitude *= 0.5; }
    return value / 0.875;   // 옥타브를 늘리면 디테일↑ 비용↑ (나눗수 = 진폭 합)
}
// 구름층: 높이 1.0~2.2. shape는 층의 아래·위를 부드럽게 깎는 높이 프로파일.
const float CLOUD_BOTTOM = 1.0, CLOUD_TOP = 2.2;
float heightShape(float y) {
    float h = (y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM);
    return smoothstep(0.0, 0.25, h) * smoothstep(1.0, 0.5, h);
}
vec3 wind() { return vec3(uTime * 0.08, 0.0, 0.0); }
float density(vec3 p) {        // 구름 모양: 3D fbm 3옥타브
    return clamp((fbm3(p * 0.45 + wind()) * heightShape(p.y) - 0.3) * 3.0, 0.0, 1.0);
}
float densityCoarse(vec3 p) {  // 그늘 계산용: 1옥타브만 (비용 절감)
    return clamp((valueNoise3(p * 0.45 + wind()) * heightShape(p.y) - 0.3) * 3.0, 0.0, 1.0);
}
void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec3 ro = vec3(0.0, 0.0, uTime * 0.6);                 // 구름 아래를 앞으로 나는 카메라
    vec3 rd = normalize(vec3(uv.x, uv.y + 0.45, 1.6));
    vec3 sun = normalize(vec3(0.5, 0.35, 0.8));
    float sunAmount = max(dot(rd, sun), 0.0);
    vec3 sky = mix(vec3(0.75, 0.82, 0.92), vec3(0.25, 0.45, 0.8), clamp(rd.y * 1.6, 0.0, 1.0));
    sky += vec3(1.0, 0.75, 0.45) * (0.25 * pow(sunAmount, 8.0) + pow(sunAmount, 256.0));

    vec3 col = sky;
    if (rd.y > 0.01) {
        // 광선이 구름층에 들어가고 나오는 거리를 공식으로 구해, 층 안에서만 24걸음 마칭한다.
        float t0 = (CLOUD_BOTTOM - ro.y) / rd.y;
        float t1 = min((CLOUD_TOP - ro.y) / rd.y, t0 + 18.0);
        float dt = (t1 - t0) / 24.0;
        float t = t0 + dt * hash13(vec3(gl_FragCoord.xy, uTime));   // 시작점을 흔들어 띠 무늬 제거
        vec3 acc = vec3(0.0);
        float transmittance = 1.0;
        for (int i = 0; i < 24; i++) {
            vec3 p = ro + rd * t;
            float d = density(p);
            if (d > 0.0) {
                float lit = exp(-2.0 * densityCoarse(p + sun * 0.5));        // 해 쪽이 짙으면 그늘
                vec3 c = mix(vec3(0.42, 0.47, 0.58), vec3(1.0, 0.97, 0.92), lit);
                float a = 1.0 - exp(-d * dt * 2.5);                          // 베르-람베르트 흡수
                acc += transmittance * a * c;                                // 앞에서 뒤로 누적
                transmittance *= 1.0 - a;
                if (transmittance < 0.03) break;
            }
            t += dt;
        }
        col = mix(sky, acc + transmittance * sky, exp(-0.04 * t0));       // 먼 구름은 하늘에 녹아들게
    } else {
        col = mix(vec3(0.3, 0.35, 0.4), sky, exp(rd.y * 30.0));            // 지평선 아래
    }
    fragColor = vec4(col, 1.0);
}`}]},
    {id:"patterns", title:"패턴 · 질감", desc:"타일·줄무늬·별·등고선처럼 화면을 채우는 무늬입니다. 대부분 0~1 마스크를 돌려주므로 mix로 색을 입힙니다.", items:[
      {id:"checkerAA", title:"checker (AA)", desc:"경계가 깨지지 않는 체커보드 마스크, 0~1 (p = 칸 단위 좌표)", code:`float checkerAA(vec2 p) {
    vec2 w = fwidth(p) + 1e-4;
    vec2 i = 2.0 * (abs(fract((p - 0.5 * w) * 0.5) - 0.5) - abs(fract((p + 0.5 * w) * 0.5) - 0.5)) / w;
    return 0.5 - 0.5 * i.x * i.y;
}`},
      {id:"stripesAA", title:"stripes (AA)", desc:"1 간격 줄무늬 마스크 (width = 줄 두께 0~1). x에 각도·거리를 넣으면 사선·동심원", code:`float stripesAA(float x, float width) {
    float d = abs(fract(x) - 0.5) - 0.5 * (1.0 - width);
    float w = fwidth(x);
    return smoothstep(-w, w, d);
}`},
      {id:"contour", title:"등고선", desc:"스칼라 값 v에 spacing 간격의 등고선 마스크 (지형·거리장·노이즈 시각화)", code:`float contourLines(float v, float spacing, float thickness) {
    float x = v / spacing;
    float d = abs(fract(x - 0.5) - 0.5) / max(fwidth(x), 1e-5);
    return 1.0 - smoothstep(thickness - 0.5, thickness + 0.5, d);
}`},
      {id:"dotsGrid", title:"점 격자 (하프톤 점)", desc:"칸마다 원 하나, size(0~1)로 점 크기 조절", code:`float dotsGrid(vec2 p, float size) {
    vec2 f = fract(p) - 0.5;
    float d = length(f) - 0.5 * size;
    float w = fwidth(d);
    return 1.0 - smoothstep(-w, w, d);
}`},
      {id:"truchet", title:"truchet", desc:"칸마다 무작위로 뒤집힌 사분원 → 끊김 없는 곡선 미로. 반환 = 곡선까지 거리", requires:["hash21"], code:`float truchet(vec2 p) {
    vec2 id = floor(p), f = fract(p) - 0.5;
    if (hash21(id) > 0.5) f.x = -f.x;
    vec2 c = f - sign(f.x + f.y + 1e-6) * 0.5;   // 가까운 두 모서리 중 하나를 원의 중심으로
    return abs(length(c) - 0.5);
}`},
      {id:"brick", title:"벽돌 타일", desc:"한 줄씩 반 칸 어긋난 벽돌. xy = 벽돌 안 좌표, zw = 벽돌 id", code:`vec4 brickTile(vec2 p, vec2 size) {
    p /= size;
    p.x += 0.5 * mod(floor(p.y), 2.0);   // 홀수 줄을 반 칸 밀기
    return vec4(fract(p) - 0.5, floor(p));
}`},
      {id:"starLayer", title:"반짝이는 별 한 겹", desc:"밀도를 바꿔 여러 겹 더하면 깊이감 있는 별밭 (p = 화면 좌표 × 밀도)", requires:["hash22","hash21"], code:`float starLayer(vec2 p, float time) {
    vec2 id = floor(p), f = fract(p) - 0.5;
    vec2 pos = (hash22(id) - 0.5) * 0.8;           // 칸 안 무작위 위치
    float r = hash21(id + 7.0);                    // 밝기·깜빡임 속도
    float d = length(f - pos);
    float twinkle = 0.6 + 0.4 * sin(time * (2.0 + 4.0 * r) + r * 6.2831);
    float core = smoothstep(0.05 * (0.5 + r), 0.0, d);
    return step(0.7, r) * twinkle * (core + 0.004 / max(d * d, 0.002));
}`},
      {id:"starfield", title:"별밭 (3겹)", desc:"starLayer를 크기별로 겹친 배경", requires:["starLayer"], scope:"main", code:`float stars = starLayer(uv * 8.0, uTime) + 0.6 * starLayer(uv * 16.0 + 3.1, uTime) + 0.35 * starLayer(uv * 32.0 + 7.7, uTime);`},
      {id:"waveLines", title:"물결 선", desc:"사인으로 휘어진 가로 줄들 (등산 지도·사운드웨이브 느낌)", code:`float waveLines(vec2 p, float count, float time) {
    float y = p.y * count + 0.3 * sin(p.x * 4.0 + time) + 0.15 * sin(p.x * 9.0 - time * 1.3);
    float d = abs(fract(y) - 0.5);
    float w = fwidth(y);
    return 1.0 - smoothstep(0.04 - w, 0.04 + w, d);
}`}]},
    {id:"fractal", title:"프랙털", desc:"같은 규칙을 반복해 끝없는 디테일을 만드는 수학 도형입니다. 반복 횟수가 곧 비용이므로 상한을 조절하세요.", items:[
      {id:"mandelbrot", title:"mandelbrot", desc:"c = 복소평면 좌표. 반환 0~1 (매끄러운 탈출 비율, 1 = 집합 안)", code:`float mandelbrot(vec2 c) {
    vec2 z = vec2(0.0);
    for (int i = 0; i < 256; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;   // z = z² + c
        float m = dot(z, z);
        if (m > 256.0) return (float(i) - log2(log2(m)) + 4.0) / 256.0;
    }
    return 1.0;
}
// 사용 예: float m = mandelbrot(uv * 1.2 + vec2(-0.6, 0.0));`},
      {id:"julia", title:"julia", desc:"z = 픽셀 좌표, c = 고정 상수(시간으로 움직이면 형태가 변함). 반환 0~1", code:`float julia(vec2 z, vec2 c) {
    for (int i = 0; i < 200; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        float m = dot(z, z);
        if (m > 256.0) return (float(i) - log2(log2(m)) + 4.0) / 200.0;
    }
    return 1.0;
}
// 사용 예: julia(uv * 1.3, 0.7885 * vec2(cos(uTime * 0.3), sin(uTime * 0.3)))`},
      {id:"sdMenger", title:"sdMenger (멩거 스펀지)", desc:"3D 프랙털 SDF — 상자에서 십자 구멍을 재귀적으로 뺀 스펀지 (크기 1)", code:`float sdMenger(vec3 p) {
    vec3 q = abs(p) - 1.0;
    float d = length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
    float s = 1.0;
    for (int m = 0; m < 4; m++) {
        vec3 a = mod(p * s, 2.0) - 1.0;
        s *= 3.0;
        vec3 r = abs(1.0 - 3.0 * abs(a));
        float da = max(r.x, r.y), db = max(r.y, r.z), dc = max(r.z, r.x);
        d = max(d, (min(da, min(db, dc)) - 1.0) / s);
    }
    return d;
}`},
      {id:"sdMandelbulb", title:"sdMandelbulb", desc:"3D 만델브롯(만델벌브) 거리 추정. power 8이 고전 형태", code:`float sdMandelbulb(vec3 p, float power) {
    vec3 z = p;
    float dr = 1.0, r = length(z);
    for (int i = 0; i < 8; i++) {
        r = length(z);
        if (r > 2.0 || r < 1e-6) break;
        float theta = acos(clamp(z.z / r, -1.0, 1.0)) * power;
        float phi = atan(z.y, z.x) * power;
        dr = pow(r, power - 1.0) * power * dr + 1.0;
        z = pow(r, power) * vec3(sin(theta) * cos(phi), sin(phi) * sin(theta), cos(theta)) + p;
    }
    return 0.5 * log(max(r, 1e-6)) * r / dr;
}`},
      {id:"kifs", title:"KIFS 접기", desc:"접기+회전+축소를 반복하는 만화경식 3D 프랙털 (rot3 축 회전 필요). 결과 p에 아무 SDF나 적용", requires:["rot3"], code:`vec3 kifsFold(vec3 p, float time, out float scale) {
    scale = 1.0;
    mat3 r = rotateAxis(vec3(1.0, 0.7, 0.3), 0.6 + 0.2 * sin(time));
    for (int i = 0; i < 6; i++) {
        p = abs(p);                                    // 접기
        if (p.x < p.y) p.xy = p.yx;
        if (p.x < p.z) p.xz = p.zx;
        p = r * p * 1.6 - vec3(1.0, 0.4, 0.2);          // 회전·확대·이동
        scale *= 1.6;
    }
    return p;
}
// 사용 예: float s; vec3 q = kifsFold(p, uTime, s); float d = sdBox(q, vec3(0.6)) / s;`}]},
    {id:"sdf2d", title:"2D SDF", desc:"점에서 도형 경계까지의 부호 있는 거리(안쪽 음수). 안티에일리어싱·외곽선·합성이 쉬워집니다.", items:[
      {id:"sdCircle", title:"sdCircle", desc:"원", code:`float sdCircle(vec2 p, float r) { return length(p) - r; }`},
      {id:"sdBox2", title:"sdBox2D", desc:"사각형 (b = 반쪽 크기)", code:`float sdBox2D(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}`},
      {id:"sdRoundBox2", title:"sdRoundBox2D", desc:"둥근 사각형 (r = 모서리 반지름)", requires:["sdBox2"], code:`float sdRoundBox2D(vec2 p, vec2 b, float r) { return sdBox2D(p, b - r) - r; }`},
      {id:"sdSegment", title:"sdSegment", desc:"선분 a–b (두께는 결과에서 빼기)", code:`float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}`},
      {id:"sdTriangle", title:"sdEquilateralTriangle", desc:"정삼각형 (r = 크기)", code:`float sdEquilateralTriangle(vec2 p, float r) {
    const float k = 1.7320508;
    p.x = abs(p.x) - r;
    p.y = p.y + r / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0 * r, 0.0);
    return -length(p) * sign(p.y);
}`},
      {id:"sdHexagon", title:"sdHexagon", desc:"정육각형", code:`float sdHexagon(vec2 p, float r) {
    const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
}`},
      {id:"sdStar5", title:"sdStar5", desc:"별 (r = 크기, rf = 안쪽 비율 0~1)", code:`float sdStar5(vec2 p, float r, float rf) {
    const vec2 k1 = vec2(0.809016994375, -0.587785252292);
    const vec2 k2 = vec2(-0.809016994375, -0.587785252292);
    p.x = abs(p.x);
    p -= 2.0 * max(dot(k1, p), 0.0) * k1;
    p -= 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= r;
    vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0, 1);
    float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}`},
      {id:"sdRing", title:"sdRing", desc:"고리 (r = 반지름, w = 두께의 절반)", code:`float sdRing(vec2 p, float r, float w) { return abs(length(p) - r) - w; }`},
      {id:"sdEllipse", title:"sdEllipseApprox", desc:"타원 (r = 가로·세로 반지름). 빠른 근사 — 외곽선·채우기에 충분", code:`float sdEllipseApprox(vec2 p, vec2 r) {
    float k0 = length(p / r), k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / k1;
}`},
      {id:"sdHeart", title:"sdHeart", desc:"하트 (크기 약 1, 아래 끝이 원점). 사용: sdHeart((p - 위치) / s) * s", code:`float sdHeart(vec2 p) {
    p.x = abs(p.x);
    if (p.y + p.x > 1.0) return length(p - vec2(0.25, 0.75)) - 0.35355339;
    vec2 a = p - vec2(0.0, 1.0), b = p - 0.5 * max(p.x + p.y, 0.0);
    return sqrt(min(dot(a, a), dot(b, b))) * sign(p.x - p.y);
}`},
      {id:"sdRhombus", title:"sdRhombus", desc:"마름모 (b = 가로·세로 반 대각선)", code:`float sdRhombus(vec2 p, vec2 b) {
    p = abs(p);
    vec2 q = b - 2.0 * p;
    float h = clamp((q.x * b.x - q.y * b.y) / dot(b, b), -1.0, 1.0);
    float d = length(p - 0.5 * b * vec2(1.0 - h, 1.0 + h));
    return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}`},
      {id:"sdPie", title:"sdPie", desc:"부채꼴 (aperture = 위쪽 기준 반각 라디안, r = 반지름)", code:`float sdPie(vec2 p, float aperture, float r) {
    vec2 c = vec2(sin(aperture), cos(aperture));
    p.x = abs(p.x);
    float l = length(p) - r;
    float m = length(p - c * clamp(dot(p, c), 0.0, r));
    return max(l, m * sign(c.y * p.x - c.x * p.y));
}`},
      {id:"sdArc", title:"sdArc", desc:"호 — 진행 바·게이지 (aperture = 반각, ra = 반지름, rb = 두께의 절반)", code:`float sdArc(vec2 p, float aperture, float ra, float rb) {
    vec2 sc = vec2(sin(aperture), cos(aperture));
    p.x = abs(p.x);
    return ((sc.y * p.x > sc.x * p.y) ? length(p - sc * ra) : abs(length(p) - ra)) - rb;
}`},
      {id:"sdCross", title:"sdCross", desc:"십자 (b.x = 팔 길이, b.y = 팔 두께의 절반, r = 둥글기)", code:`float sdCross(vec2 p, vec2 b, float r) {
    p = abs(p);
    p = (p.y > p.x) ? p.yx : p.xy;
    vec2 q = p - b;
    float k = max(q.y, q.x);
    vec2 w = (k > 0.0) ? q : vec2(b.y - p.x, -k);
    return sign(k) * length(max(w, 0.0)) + r;
}`},
      {id:"sdfFill", title:"fill · stroke (AA)", desc:"SDF를 픽셀 크기에 맞춰 부드럽게 칠하기·외곽선 그리기", code:`float fillSDF(float d) {
    float w = fwidth(d);
    return 1.0 - smoothstep(-w, w, d);
}
float strokeSDF(float d, float width) {
    float w = fwidth(d);
    return 1.0 - smoothstep(width - w, width + w, abs(d));
}`},
      {id:"sdfDebug", title:"거리장 시각화", desc:"SDF 값을 등고선으로 보기 (안쪽 주황, 바깥 파랑)", code:`vec3 debugSDF(float d) {
    vec3 col = d > 0.0 ? vec3(0.65, 0.85, 1.0) : vec3(0.9, 0.6, 0.3);
    col *= 1.0 - exp(-6.0 * abs(d));
    col *= 0.8 + 0.2 * cos(150.0 * d);
    return mix(col, vec3(1.0), 1.0 - smoothstep(0.0, 0.01, abs(d)));
}`}]},
    {id:"sdf3d", title:"3D SDF", desc:"레이마칭용 3D 도형 거리 함수. 도형의 중심이 원점이므로 p를 옮기거나 회전해 배치합니다.", items:[
      {id:"sdSphere", title:"sdSphere", desc:"구", code:`float sdSphere(vec3 p, float r) { return length(p) - r; }`},
      {id:"sdBox3", title:"sdBox", desc:"상자 (b = 반쪽 크기)", code:`float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}`},
      {id:"sdRoundBox3", title:"sdRoundBox", desc:"둥근 상자", requires:["sdBox3"], code:`float sdRoundBox(vec3 p, vec3 b, float r) { return sdBox(p, b - r) - r; }`},
      {id:"sdTorus", title:"sdTorus", desc:"도넛 (t.x = 큰 반지름, t.y = 굵기)", code:`float sdTorus(vec3 p, vec2 t) {
    vec2 q = vec2(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
}`},
      {id:"sdCapsule", title:"sdCapsule", desc:"캡슐 (a–b 선분 + 반지름)", code:`float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
    vec3 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
}`},
      {id:"sdCylinder", title:"sdCylinder", desc:"세로 원기둥 (h = 높이의 절반)", code:`float sdCylinder(vec3 p, float h, float r) {
    vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}`},
      {id:"sdPlane", title:"sdPlane", desc:"평면 (n = 정규화된 법선, h = 원점에서의 거리)", code:`float sdPlane(vec3 p, vec3 n, float h) { return dot(p, n) + h; }`},
      {id:"sdOctahedron", title:"sdOctahedron", desc:"정팔면체 (근사, 빠름)", code:`float sdOctahedron(vec3 p, float s) {
    p = abs(p);
    return (p.x + p.y + p.z - s) * 0.57735027;
}`},
      {id:"sdEllipsoid", title:"sdEllipsoid", desc:"타원체 (r = 축별 반지름, 근사)", code:`float sdEllipsoid(vec3 p, vec3 r) {
    float k0 = length(p / r), k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / k1;
}`},
      {id:"sdCappedCone", title:"sdCappedCone", desc:"잘린 원뿔 (h = 높이의 절반, r1 = 아래 반지름, r2 = 위 반지름)", code:`float sdCappedCone(vec3 p, float h, float r1, float r2) {
    vec2 q = vec2(length(p.xz), p.y);
    vec2 k1 = vec2(r2, h), k2 = vec2(r2 - r1, 2.0 * h);
    vec2 ca = vec2(q.x - min(q.x, (q.y < 0.0) ? r1 : r2), abs(q.y) - h);
    vec2 cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
    float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
    return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}`},
      {id:"sdHexPrism", title:"sdHexPrism", desc:"육각기둥 (h.x = 반지름, h.y = 길이의 절반, z축 방향)", code:`float sdHexPrism(vec3 p, vec2 h) {
    const vec3 k = vec3(-0.8660254, 0.5, 0.57735);
    p = abs(p);
    p.xy -= 2.0 * min(dot(k.xy, p.xy), 0.0) * k.xy;
    vec2 d = vec2(length(p.xy - vec2(clamp(p.x, -k.z * h.x, k.z * h.x), h.x)) * sign(p.y - h.x), p.z - h.y);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}`},
      {id:"sdBoxFrame", title:"sdBoxFrame", desc:"상자 뼈대(모서리만) (b = 반쪽 크기, e = 테두리 두께)", code:`float sdBoxFrame(vec3 p, vec3 b, float e) {
    p = abs(p) - b;
    vec3 q = abs(p + e) - e;
    return min(min(
        length(max(vec3(p.x, q.y, q.z), 0.0)) + min(max(p.x, max(q.y, q.z)), 0.0),
        length(max(vec3(q.x, p.y, q.z), 0.0)) + min(max(q.x, max(p.y, q.z)), 0.0)),
        length(max(vec3(q.x, q.y, p.z), 0.0)) + min(max(q.x, max(q.y, p.z)), 0.0));
}`},
      {id:"sdLink", title:"sdLink", desc:"사슬 고리 (le = 직선부 길이의 절반, r1 = 고리 반지름, r2 = 굵기)", code:`float sdLink(vec3 p, float le, float r1, float r2) {
    vec3 q = vec3(p.x, max(abs(p.y) - le, 0.0), p.z);
    return length(vec2(length(q.xy) - r1, q.z)) - r2;
}`},
      {id:"sdPyramid", title:"sdPyramid", desc:"사각뿔 (밑면 1×1, h = 높이, 밑면이 y = 0)", code:`float sdPyramid(vec3 p, float h) {
    float m2 = h * h + 0.25;
    p.xz = abs(p.xz);
    p.xz = (p.z > p.x) ? p.zx : p.xz;
    p.xz -= 0.5;
    vec3 q = vec3(p.z, h * p.y - 0.5 * p.x, h * p.x + 0.5 * p.y);
    float s = max(-q.x, 0.0);
    float t = clamp((q.y - 0.5 * p.z) / (m2 + 0.25), 0.0, 1.0);
    float a = m2 * (q.x + s) * (q.x + s) + q.y * q.y;
    float b = m2 * (q.x + 0.5 * t) * (q.x + 0.5 * t) + (q.y - m2 * t) * (q.y - m2 * t);
    float d2 = min(q.y, -q.x * m2 - q.y * 0.5) > 0.0 ? 0.0 : min(a, b);
    return sqrt((d2 + q.z * q.z) / m2) * sign(max(q.z, -p.y));
}`}]},
    {id:"ops", title:"도형 합성 · 반복", desc:"SDF끼리 더하고 빼고 부드럽게 녹이거나, 공간을 접어 무한히 반복합니다.", items:[
      {id:"opBool", title:"합집합 · 교집합 · 차집합", desc:"기본 불리언 연산", code:`float opUnion(float a, float b)        { return min(a, b); }
float opIntersection(float a, float b) { return max(a, b); }
float opSubtraction(float a, float b)  { return max(a, -b); }   // a에서 b를 뺀다`},
      {id:"smin", title:"smin (부드러운 합집합)", desc:"두 도형이 녹아 붙는 메타볼 효과 (k = 녹는 범위)", code:`float smin(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
}`},
      {id:"smax", title:"smax · 부드러운 차집합", desc:"모서리를 둥글게 깎는 교집합·차집합", requires:["smin"], code:`float smax(float a, float b, float k) { return -smin(-a, -b, k); }
float smoothSubtraction(float a, float b, float k) { return smax(a, -b, k); }`},
      {id:"opRound", title:"opRound · opOnion", desc:"모서리 둥글게 / 속이 빈 껍질 만들기", code:`float opRound(float d, float r)     { return d - r; }
float opOnion(float d, float thickness) { return abs(d) - thickness; }`},
      {id:"opRepeat2", title:"opRepeat (2D)", desc:"공간을 s 간격으로 무한 반복", code:`vec2 opRepeat(vec2 p, vec2 s) { return p - s * round(p / s); }`},
      {id:"opRepeat3", title:"opRepeat3 (3D)", desc:"3D 공간 무한 반복", code:`vec3 opRepeat3(vec3 p, vec3 s) { return p - s * round(p / s); }`},
      {id:"opRepeatLimited", title:"opRepeatLimited", desc:"개수 제한 반복 (l = 각 축 최대 칸 수)", code:`vec3 opRepeatLimited(vec3 p, float s, vec3 l) { return p - s * clamp(round(p / s), -l, l); }`},
      {id:"opPolar", title:"opPolarRepeat", desc:"원형 반복 (n 등분 만화경)", code:`vec2 opPolarRepeat(vec2 p, float n) {
    float sector = 6.2831853 / n;
    float a = mod(atan(p.y, p.x) + sector * 0.5, sector) - sector * 0.5;
    return length(p) * vec2(cos(a), sin(a));
}`},
      {id:"opMirror", title:"대칭 · 꼬기 · 휘기", desc:"x축 대칭, 높이에 따라 비틀기, 휘게 하기", requires:["rot2"], code:`vec3 opMirrorX(vec3 p) { p.x = abs(p.x); return p; }
vec3 opTwist(vec3 p, float k) { p.xz = rot2(k * p.y) * p.xz; return p; }
vec3 opBend(vec3 p, float k)  { p.xy = rot2(k * p.x) * p.xy; return p; }`},
      {id:"sminBlend", title:"sminBlend (재질 섞기)", desc:"부드러운 합집합 + 섞임 비율. x = 거리, y = 0(a)~1(b) — 두 도형의 색을 경계에서 섞을 때", code:`vec2 sminBlend(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    float m = h * h * 0.5;
    float s = m * k * 0.5;
    return (a < b) ? vec2(a - s, m) : vec2(b - s, 1.0 - m);
}
// 사용: vec2 r = sminBlend(dA, dB, 0.3); vec3 col = mix(colorA, colorB, r.y);`},
      {id:"opExtrude", title:"opExtrude (2D → 3D)", desc:"2D SDF를 z방향 두께 h만큼 밀어낸 입체. d2d = 2D SDF(p.xy)의 값", code:`float opExtrude(vec3 p, float d2d, float h) {
    vec2 w = vec2(d2d, abs(p.z) - h);
    return min(max(w.x, w.y), 0.0) + length(max(w, 0.0));
}
// 사용: float d = opExtrude(p, sdStar5(p.xy, 0.5, 0.4), 0.1);`},
      {id:"opRevolution", title:"opRevolution (회전체)", desc:"2D 단면을 y축으로 돌려 입체로. 반환 좌표를 2D SDF에 넣기 (o = 축에서 떨어진 거리)", code:`vec2 opRevolution(vec3 p, float o) { return vec2(length(p.xz) - o, p.y); }
// 사용: float d = sdBox2D(opRevolution(p, 0.6), vec2(0.1, 0.3));   // 상자 단면 → 둥근 고리`},
      {id:"opElongate", title:"opElongate", desc:"도형의 가운데를 h만큼 늘리기 (구 → 캡슐, 원환 → 트랙)", code:`vec3 opElongate(vec3 p, vec3 h) { return p - clamp(p, -h, h); }`},
      {id:"opDisplace", title:"opDisplace (표면 요철)", desc:"거리에 작은 파동을 더해 울퉁불퉁하게. amount가 크면 레이마칭 보폭을 줄이세요", code:`float opDisplace(vec3 p, float d, float freq, float amount) {
    return d + amount * sin(freq * p.x) * sin(freq * p.y) * sin(freq * p.z);
}`}]},
    {id:"space", title:"좌표 · 변환", desc:"화면 좌표를 다루기 좋은 공간으로 바꾸는 코드입니다.", items:[
      {id:"uvCenter", title:"중심 좌표 (종횡비 보정)", desc:"화면 중앙이 (0,0), 세로 범위 -1~1", scope:"main", code:`vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;`},
      {id:"uv01", title:"0~1 좌표", desc:"왼쪽 아래 (0,0), 오른쪽 위 (1,1)", scope:"main", code:`vec2 uv = gl_FragCoord.xy / uResolution;`},
      {id:"rot2", title:"rot2 (2D 회전)", desc:"각도(라디안)만큼 회전하는 행렬. 사용: p = rot2(a) * p", code:`mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }`},
      {id:"rot3", title:"축 회전 (3D)", desc:"임의 축 axis를 중심으로 회전하는 행렬", code:`mat3 rotateAxis(vec3 axis, float angle) {
    axis = normalize(axis);
    float s = sin(angle), c = cos(angle), oc = 1.0 - c;
    return mat3(oc * axis.x * axis.x + c,          oc * axis.x * axis.y + axis.z * s, oc * axis.z * axis.x - axis.y * s,
                oc * axis.x * axis.y - axis.z * s, oc * axis.y * axis.y + c,          oc * axis.y * axis.z + axis.x * s,
                oc * axis.z * axis.x + axis.y * s, oc * axis.y * axis.z - axis.x * s, oc * axis.z * axis.z + c);
}`},
      {id:"polar", title:"극좌표 변환", desc:"(반지름, 각도 0~1)로 바꾸기 — 방사형 패턴", scope:"main", code:`vec2 polar = vec2(length(uv), atan(uv.y, uv.x) / 6.2831853 + 0.5);`},
      {id:"tile", title:"타일 나누기 + 셀 번호", desc:"n칸 격자로 나누고 각 칸의 정수 id·내부 좌표 얻기", scope:"main", code:`vec2 grid = uv * 8.0;
vec2 cellId = floor(grid);          // 칸 번호 (hash21(cellId)로 칸마다 다른 값)
vec2 cellUv = fract(grid) - 0.5;    // 칸 안의 -0.5~0.5 좌표`},
      {id:"pixelate", title:"픽셀화", desc:"좌표를 큰 픽셀 단위로 끊기 (레트로·모자이크)", scope:"main", code:`float pixelSize = 8.0;
vec2 pixelUv = (floor(gl_FragCoord.xy / pixelSize) + 0.5) * pixelSize / uResolution;`},
      {id:"mouseUv", title:"마우스 좌표 (중심 기준)", desc:"uMouse를 uv와 같은 공간으로 (밖이면 0)", scope:"main", code:`vec2 mouse = uMouse.x < 0.0 ? vec2(0.0) : (2.0 * uMouse.xy - uResolution) / uResolution.y;`},
      {id:"hexGrid", title:"육각 격자", desc:"벌집 타일. xy = 칸 중심 기준 좌표, zw = 칸 id (hash21(id)로 칸마다 다른 값)", code:`vec4 hexGrid(vec2 p) {
    const vec2 s = vec2(1.0, 1.7320508);
    vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
    vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
    return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hc.xy) : vec4(h.zw, hc.zw + 0.5);
}`},
      {id:"rotXYZ", title:"rotX · rotY · rotZ", desc:"축별 3D 회전 행렬. 사용: p = rotY(uTime) * p", code:`mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }`},
      {id:"orbitCamera", title:"마우스 궤도 카메라", desc:"마우스 x = 방위각, y = 높이로 원점을 도는 카메라 위치 (uMouse 필요, 밖이면 자동 회전)", scope:"main", code:`vec2 m = uMouse.x < 0.0 ? vec2(0.5 + 0.05 * uTime, 0.35) : uMouse.xy / uResolution;
float yaw = m.x * 6.2831853, pitch = mix(-0.2, 1.3, m.y), dist = 4.0;
vec3 ro = dist * vec3(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw));
vec3 ta = vec3(0.0);`},
      {id:"kaleido", title:"만화경 접기", desc:"각도를 n조각으로 접고 반사 — 모든 조각이 거울처럼 이어짐", code:`vec2 kaleidoscope(vec2 p, float n) {
    float sector = 3.14159265 / n;
    float a = atan(p.y, p.x);
    a = abs(mod(a + sector, 2.0 * sector) - sector);   // 접고 뒤집기
    return length(p) * vec2(cos(a), sin(a));
}`}]},
    {id:"color", title:"색 · 팔레트", desc:"색 공간 변환과 아름다운 색 조합을 만드는 함수입니다.", items:[
      {id:"cosPalette", title:"코사인 팔레트", desc:"a + b·cos(2π(c·t + d)) — 숫자 4개로 무한한 그라디언트", code:`vec3 cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
    return a + b * cos(6.2831853 * (c * t + d));
}
// 예: cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67))`},
      {id:"hsv2rgb", title:"hsv2rgb", desc:"색상·채도·명도(모두 0~1) → RGB", code:`vec3 hsv2rgb(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return c.z * mix(vec3(1.0), rgb, c.y);
}`},
      {id:"rgb2hsv", title:"rgb2hsv", desc:"RGB → 색상·채도·명도", code:`vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y), e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}`},
      {id:"srgb", title:"sRGB ↔ 선형", desc:"조명 계산은 선형 공간에서, 출력 직전 sRGB로", code:`vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 linearToSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }`},
      {id:"luminance", title:"luminance", desc:"밝기(흑백 변환·밝기 기준 효과)", code:`float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`},
      {id:"saturation", title:"채도 조절", desc:"amount 0 = 흑백, 1 = 원본, 1 초과 = 강조", requires:["luminance"], code:`vec3 adjustSaturation(vec3 c, float amount) { return mix(vec3(luminance(c)), c, amount); }`},
      {id:"oklab", title:"OKLab · 지각 균일 섞기", desc:"사람 눈에 고르게 보이는 색 공간. mixOklab은 RGB mix보다 중간색이 탁해지지 않음 (선형 RGB 입력)", code:`vec3 linearToOklab(vec3 c) {
    float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
    float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
    float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
    vec3 lms = pow(max(vec3(l, m, s), 0.0), vec3(1.0 / 3.0));
    return vec3(0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,
                1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,
                0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z);
}
vec3 oklabToLinear(vec3 c) {
    float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
    float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
    float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
    l = l * l * l; m = m * m * m; s = s * s * s;
    return vec3( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 mixOklab(vec3 a, vec3 b, float t) { return oklabToLinear(mix(linearToOklab(a), linearToOklab(b), t)); }`},
      {id:"blackbody", title:"흑체 색 (온도 → 색)", desc:"켈빈 온도(1000~12000)를 색으로. 불꽃·용암·별·전구 빛", code:`vec3 blackbody(float kelvin) {
    float t = kelvin / 100.0;
    float r = t <= 66.0 ? 1.0 : clamp(1.29293618606 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
    float g = t <= 66.0 ? clamp(0.39008157876 * log(t) - 0.63184144378, 0.0, 1.0)
                        : clamp(1.12989086089 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
    float b = t >= 66.0 ? 1.0 : t <= 19.0 ? 0.0 : clamp(0.54320678911 * log(t - 10.0) - 1.19625408914, 0.0, 1.0);
    return vec3(r, g, b);
}`},
      {id:"turbo", title:"Turbo 색상맵", desc:"0~1 값을 구분하기 쉬운 무지개 색으로 (히트맵·디버그·데이터 시각화)", code:`vec3 turboColormap(float x) {
    const vec4 kr4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    const vec4 kg4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    const vec4 kb4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    const vec2 kr2 = vec2(-152.94239396, 59.28637943);
    const vec2 kg2 = vec2(4.27729857, 2.82956604);
    const vec2 kb2 = vec2(-89.90310912, 27.34824973);
    x = clamp(x, 0.0, 1.0);
    vec4 v4 = vec4(1.0, x, x * x, x * x * x);
    vec2 v2 = v4.zw * v4.z;
    return vec3(dot(v4, kr4) + dot(v2, kr2), dot(v4, kg4) + dot(v2, kg2), dot(v4, kb4) + dot(v2, kb2));
}`},
      {id:"palettePresets", title:"팔레트 프리셋 모음", desc:"cosPalette에 넣는 검증된 조합 6가지 (t = 0~1)", requires:["cosPalette"], code:`vec3 paletteRainbow(float t) { return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67)); }
vec3 paletteSunset(float t)  { return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 0.5), vec3(0.8, 0.9, 0.3)); }
vec3 paletteOcean(float t)   { return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0, 0.7, 0.4), vec3(0.0, 0.15, 0.2)); }
vec3 paletteFire(float t)    { return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 1.0), vec3(0.0, 0.1, 0.2)); }
vec3 paletteNeon(float t)    { return cosPalette(t, vec3(0.5), vec3(0.5), vec3(2.0, 1.0, 0.0), vec3(0.5, 0.2, 0.25)); }
vec3 paletteEarth(float t)   { return cosPalette(t, vec3(0.8, 0.5, 0.4), vec3(0.2, 0.4, 0.2), vec3(2.0, 1.0, 1.0), vec3(0.0, 0.25, 0.25)); }`}]},
    {id:"raymarch", title:"레이마칭", desc:"3D SDF 장면을 화면에 그리는 기본 골격입니다. map(p)는 직접 작성합니다.", items:[
      {id:"camera", title:"setCamera (lookAt)", desc:"카메라 위치 ro가 목표 ta를 바라보는 회전 행렬", code:`mat3 setCamera(vec3 ro, vec3 ta, float roll) {
    vec3 forward = normalize(ta - ro);
    vec3 right = normalize(cross(forward, vec3(sin(roll), cos(roll), 0.0)));
    vec3 up = cross(right, forward);
    return mat3(right, up, forward);
}
// 사용: vec3 rd = setCamera(ro, ta, 0.0) * normalize(vec3(uv, 1.8));`},
      {id:"march", title:"rayMarch 루프", desc:"광선을 따라 전진하며 표면 거리 찾기 (map 필요). 실패 시 -1", code:`float rayMarch(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) {
        float d = map(ro + rd * t);
        if (d < 0.001 * t) return t;   // 멀수록 허용 오차를 키운다
        t += d;
        if (t > 100.0) break;
    }
    return -1.0;
}`},
      {id:"normal", title:"calcNormal", desc:"정사면체 4번 샘플로 표면 법선 근사 (map 필요)", code:`vec3 calcNormal(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.0005;
    return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) +
                     k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}`},
      {id:"intersect", title:"해석적 교차 (구·평면·상자)", desc:"마칭 없이 공식으로 바로 맞히기 — 빠르고 정확. 실패 시 음수(구·평면) 또는 near > far(상자)", code:`float iSphere(vec3 ro, vec3 rd, vec3 center, float radius) {
    vec3 oc = ro - center;
    float b = dot(oc, rd), c = dot(oc, oc) - radius * radius, h = b * b - c;
    if (h < 0.0) return -1.0;
    h = sqrt(h);
    return (-b - h >= 0.0) ? -b - h : -b + h;   // 구 안에서 쏘면 먼 쪽
}
float iPlane(vec3 ro, vec3 rd, vec3 n, float h) { return -(dot(ro, n) + h) / dot(rd, n); }
vec2 iBox(vec3 ro, vec3 rd, vec3 halfSize) {   // 원점 중심 상자: (near, far)
    vec3 m = 1.0 / rd, n = m * ro, k = abs(m) * halfSize;
    vec3 t1 = -n - k, t2 = -n + k;
    return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}`},
      {id:"marchMaterial", title:"재질 번호 마칭", desc:"map이 vec2(거리, 재질 id)를 돌려줄 때 — 맞힌 지점의 재질별로 색 고르기 (mapMat 필요)", code:`vec2 rayMarchMaterial(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) {
        vec2 h = mapMat(ro + rd * t);   // h.x = 거리, h.y = 재질
        if (h.x < 0.001 * t) return vec2(t, h.y);
        t += h.x;
        if (t > 100.0) break;
    }
    return vec2(-1.0, 0.0);
}
// 합치기: vec2 opU(vec2 a, vec2 b) { return a.x < b.x ? a : b; }`},
      {id:"triplanar", title:"triplanar 텍스처", desc:"UV 없는 3D 표면에 이미지 입히기 — 법선 방향 세 평면에서 읽어 섞음", code:`vec3 triplanar(sampler2D tex, vec3 p, vec3 n, float scale) {
    vec3 w = pow(abs(n), vec3(4.0));
    w /= w.x + w.y + w.z;
    return texture(tex, p.yz * scale).rgb * w.x
         + texture(tex, p.xz * scale).rgb * w.y
         + texture(tex, p.xy * scale).rgb * w.z;
}`},
      {id:"rmTemplate", title:"레이마칭 전체 골격", desc:"카메라·마칭·법선·조명이 들어간 완성 장면 (현재 패스를 교체)", replace:true, code:`#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;

float sdSphere(vec3 p, float r) { return length(p) - r; }
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }

// 장면: 여기만 바꾸면 된다.
float map(vec3 p) {
    float ground = p.y + 1.0;
    float ball = sdSphere(p - vec3(0.0, 0.2 * sin(uTime), 0.0), 0.8);
    float orbit = sdSphere(p - vec3(1.2 * cos(uTime), 0.0, 1.2 * sin(uTime)), 0.35);
    return min(ground, smin(ball, orbit, 0.4));
}
vec3 calcNormal(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.0005;
    return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) +
                     k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}
float rayMarch(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) {
        float d = map(ro + rd * t);
        if (d < 0.001 * t) return t;
        t += d;
        if (t > 50.0) break;
    }
    return -1.0;
}
void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec3 ro = vec3(0.0, 0.8, 4.0), ta = vec3(0.0);
    vec3 forward = normalize(ta - ro), right = normalize(cross(forward, vec3(0, 1, 0))), up = cross(right, forward);
    vec3 rd = normalize(uv.x * right + uv.y * up + 1.8 * forward);
    vec3 col = vec3(0.05, 0.06, 0.09) + 0.1 * rd.y;
    float t = rayMarch(ro, rd);
    if (t > 0.0) {
        vec3 p = ro + rd * t, n = calcNormal(p), light = normalize(vec3(0.6, 1.0, 0.4));
        float diffuse = max(dot(n, light), 0.0);
        col = vec3(0.85, 0.75, 0.6) * (0.15 + 0.85 * diffuse) + 0.2 * pow(max(dot(reflect(rd, n), light), 0.0), 32.0);
        col = mix(col, vec3(0.05, 0.06, 0.09), 1.0 - exp(-0.02 * t * t));   // 거리 안개
    }
    fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`}]},
    {id:"lighting", title:"조명 · 셰이딩", desc:"레이마칭 장면의 그림자·차폐·반사 표현입니다. 대부분 map(p)가 필요합니다.", items:[
      {id:"softShadow", title:"softShadow", desc:"부드러운 그림자 (k가 클수록 선명). map 필요", code:`float softShadow(vec3 ro, vec3 rd, float tmin, float tmax, float k) {
    float result = 1.0, t = tmin;
    for (int i = 0; i < 64; i++) {
        float h = map(ro + rd * t);
        result = min(result, k * h / t);
        t += clamp(h, 0.01, 0.2);
        if (result < 0.001 || t > tmax) break;
    }
    return clamp(result, 0.0, 1.0);
}`},
      {id:"ao", title:"ambientOcclusion", desc:"주변 차폐 — 구석을 어둡게 (map 필요)", code:`float ambientOcclusion(vec3 p, vec3 n) {
    float occlusion = 0.0, scale = 1.0;
    for (int i = 1; i <= 5; i++) {
        float h = 0.02 + 0.12 * float(i);
        occlusion += (h - map(p + n * h)) * scale;
        scale *= 0.75;
    }
    return clamp(1.0 - 2.5 * occlusion, 0.0, 1.0);
}`},
      {id:"fresnel", title:"fresnelSchlick", desc:"비스듬히 볼수록 반사가 강해지는 효과", code:`float fresnelSchlick(float cosTheta, float f0) {
    return f0 + (1.0 - f0) * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}`},
      {id:"blinnPhong", title:"blinnPhong", desc:"확산 + 하이라이트 기본 조명 (n, 광원 방향 l, 시선 방향 v)", code:`vec3 blinnPhong(vec3 n, vec3 l, vec3 v, vec3 albedo, float shininess) {
    float diffuse = max(dot(n, l), 0.0);
    float specular = pow(max(dot(n, normalize(l + v)), 0.0), shininess);
    return albedo * diffuse + vec3(specular) * step(0.0, diffuse);
}`},
      {id:"ggx", title:"GGX 스펙큘러 (PBR)", desc:"거칠기 기반 물리 하이라이트 (roughness 0.05~1, f0 = 0.04 비금속)", code:`float ggxSpecular(vec3 n, vec3 v, vec3 l, float roughness, float f0) {
    vec3 h = normalize(v + l);
    float nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 1e-4), nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
    float a2 = roughness * roughness * roughness * roughness;
    float dn = nh * nh * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * dn * dn);                       // 미세면 분포
    float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    float G = nl / (nl * (1.0 - k) + k) * nv / (nv * (1.0 - k) + k);   // 가림
    float F = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);              // 프레넬
    return D * G * F / (4.0 * nv + 1e-4);                        // nl은 G 안에 포함
}`},
      {id:"hemiAmbient", title:"반구 앰비언트", desc:"위는 하늘색, 아래는 땅색으로 받는 간접광 — 평평한 회색 그림자 대신", code:`vec3 hemiAmbient(vec3 n, vec3 skyCol, vec3 groundCol) { return mix(groundCol, skyCol, 0.5 + 0.5 * n.y); }`},
      {id:"fog", title:"거리 안개 + 해 산란", desc:"멀수록 안개색으로, 해를 향한 방향은 따뜻하게 (t = 거리, rd = 광선)", code:`vec3 applyFog(vec3 col, float t, vec3 rd, vec3 sunDir, float density) {
    float amount = 1.0 - exp(-t * density);
    float sun = max(dot(rd, sunDir), 0.0);
    vec3 fogCol = mix(vec3(0.5, 0.6, 0.7), vec3(1.0, 0.9, 0.7), pow(sun, 8.0));
    return mix(col, fogCol, amount);
}`},
      {id:"rim", title:"림 라이트", desc:"윤곽에 빛 테두리 (n = 법선, v = 시점 방향)", code:`float rimLight(vec3 n, vec3 v, float power) { return pow(1.0 - max(dot(n, v), 0.0), power); }`},
      {id:"sky", title:"간단한 하늘", desc:"광선 방향 rd로 하늘 그라디언트 + 태양", code:`vec3 skyColor(vec3 rd, vec3 sunDir) {
    vec3 col = mix(vec3(0.75, 0.85, 1.0), vec3(0.25, 0.45, 0.85), clamp(rd.y, 0.0, 1.0));
    col += vec3(1.0, 0.8, 0.5) * pow(max(dot(rd, sunDir), 0.0), 256.0);
    return col;
}`}]},
    {id:"motion", title:"애니메이션 · 이징", desc:"시간에 따른 움직임을 자연스럽게 만드는 함수입니다.", items:[
      {id:"remap", title:"remap · linearstep", desc:"값의 범위 바꾸기, 직선형 0~1 보간", code:`float remap(float v, float inMin, float inMax, float outMin, float outMax) {
    return outMin + (v - inMin) * (outMax - outMin) / (inMax - inMin);
}
float linearstep(float a, float b, float x) { return clamp((x - a) / (b - a), 0.0, 1.0); }`},
      {id:"easing", title:"이징 함수", desc:"t(0~1)를 가속·감속 곡선으로", code:`float easeInOutCubic(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) * 0.5; }
float easeOutBack(float t)    { const float c = 1.70158; return 1.0 + (c + 1.0) * pow(t - 1.0, 3.0) + c * pow(t - 1.0, 2.0); }
float easeOutElastic(float t) { return t <= 0.0 ? 0.0 : t >= 1.0 ? 1.0 : pow(2.0, -10.0 * t) * sin((t * 10.0 - 0.75) * 2.0943951) + 1.0; }`},
      {id:"pingpong", title:"pingPong · loop", desc:"0→1→0 왕복, 주기 반복", code:`float pingPong(float t) { return 1.0 - abs(fract(t * 0.5) * 2.0 - 1.0); }
float loopTime(float t, float period) { return mod(t, period) / period; }`},
      {id:"pulse", title:"pulse · impulse", desc:"특정 구간만 켜지는 펄스, 한 번 튀었다 줄어드는 임펄스", code:`float pulse(float center, float width, float x) { return 1.0 - smoothstep(0.0, width, abs(x - center)); }
float impulse(float k, float x) { float h = k * x; return h * exp(1.0 - h); }`},
      {id:"shake", title:"흔들림 (노이즈 기반)", desc:"부드럽게 떨리는 2D 오프셋 — 카메라 흔들림·손떨림 (strength = 세기)", requires:["noise1D"], code:`vec2 shake(float time, float speed, float strength) {
    return strength * (vec2(noise1D(time * speed), noise1D(time * speed + 31.7)) * 2.0 - 1.0);
}`},
      {id:"bounce", title:"공 튀기기", desc:"바닥에 튕기며 점점 낮아지는 높이 0~1 (period = 첫 튕김 주기)", code:`float bounce(float t, float period) {
    float x = fract(t / period);
    return 4.0 * x * (1.0 - x) * exp(-0.4 * floor(t / period));
}`},
      {id:"stepped", title:"끊어진 시간 (스톱모션)", desc:"fps 단위로 끊긴 시간 — 손그림 애니메이션 느낌", code:`float steppedTime(float t, float fps) { return floor(t * fps) / fps; }`},
      {id:"spring", title:"감쇠 진동", desc:"t초 후 흔들리다 멈추는 값 (출렁이는 등장)", code:`float dampedSpring(float t, float frequency, float damping) {
    return 1.0 - exp(-damping * t) * cos(frequency * t);
}`}]},
    {id:"post", title:"후처리 · 출력", desc:"최종 색을 다듬는 코드입니다. 대부분 Image 패스의 마지막에 씁니다.", items:[
      {id:"aces", title:"ACES 톤매핑", desc:"HDR 색을 영화 같은 대비로 0~1에 압축 (근사)", code:`vec3 acesTonemap(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}`},
      {id:"reinhard", title:"Reinhard + 감마", desc:"가장 단순한 톤매핑과 감마 보정", scope:"main", code:`color = color / (color + 1.0);
color = pow(color, vec3(1.0 / 2.2));`},
      {id:"vignette", title:"비네트", desc:"가장자리를 어둡게 (uv는 0~1)", code:`float vignette(vec2 uv, float strength) {
    uv *= 1.0 - uv.yx;
    return pow(uv.x * uv.y * 16.0, strength);
}`},
      {id:"grain", title:"필름 그레인", desc:"프레임마다 바뀌는 미세 노이즈 (밴딩 완화)", requires:["hash21"], code:`vec3 filmGrain(vec3 color, vec2 fragCoord, float time, float amount) {
    float n = hash21(fragCoord + fract(time) * 1000.0) - 0.5;
    return color + n * amount;
}`},
      {id:"dither", title:"디더링", desc:"8bit 출력의 계단(밴딩) 제거", requires:["hash21"], scope:"main", code:`fragColor.rgb += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;`},
      {id:"chromatic", title:"색수차", desc:"iChannel0을 R/G/B로 조금씩 어긋나게 읽기", code:`vec3 chromaticAberration(sampler2D tex, vec2 uv, float amount) {
    vec2 dir = uv - 0.5;
    return vec3(texture(tex, uv + dir * amount).r,
                texture(tex, uv).g,
                texture(tex, uv - dir * amount).b);
}`},
      {id:"posterize", title:"포스터화", desc:"색 단계를 levels개로 줄이기 (툰·레트로)", code:`vec3 posterize(vec3 c, float levels) { return floor(c * levels + 0.5) / levels; }`},
      {id:"liftGammaGain", title:"색보정 (Lift·Gamma·Gain)", desc:"어두운 곳·중간톤·밝은 곳을 따로 물들이기 (기본값 lift 0, gamma 1, gain 1)", code:`vec3 liftGammaGain(vec3 c, vec3 lift, vec3 gamma, vec3 gain) {
    c = c * gain + lift * (1.0 - c);
    return pow(max(c, 0.0), 1.0 / gamma);
}`},
      {id:"bayer", title:"Bayer 순서 디더", desc:"4×4 행렬 임계값 (0~1). 계단식 레트로 디더: step(bayer4(fragCoord), 밝기)", code:`float bayer4(vec2 fragCoord) {
    ivec2 p = ivec2(fragCoord) & 3;
    const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
    return (m[p.y * 4 + p.x] + 0.5) / 16.0;
}`},
      {id:"halftone", title:"하프톤 점", desc:"밝기 value(0~1)를 회전된 점 크기로 — 인쇄물 느낌 (cellSize = 점 간격 픽셀)", code:`float halftone(vec2 fragCoord, float value, float cellSize, float angle) {
    float c = cos(angle), s = sin(angle);
    vec2 f = fract(mat2(c, s, -s, c) * fragCoord / cellSize) - 0.5;
    float r = sqrt(clamp(value, 0.0, 1.0)) * 0.7071;
    float w = 1.0 / cellSize;
    return 1.0 - smoothstep(r - w, r + w, length(f));
}`},
      {id:"barrel", title:"렌즈 왜곡 (배럴)", desc:"uv(0~1)를 볼록하게 휘기 (k > 0 볼록, k < 0 오목) — 색수차와 함께 쓰면 CRT", code:`vec2 barrelDistort(vec2 uv, float k) {
    vec2 c = uv - 0.5;
    return 0.5 + c * (1.0 + k * dot(c, c));
}`},
      {id:"sharpen", title:"샤픈", desc:"주변 4픽셀과의 차이를 더해 윤곽 강조 (px = 1.0 / 해상도)", code:`vec4 sharpen(sampler2D tex, vec2 uv, vec2 px, float amount) {
    vec4 c = texture(tex, uv);
    vec4 n = texture(tex, uv + vec2(px.x, 0)) + texture(tex, uv - vec2(px.x, 0))
           + texture(tex, uv + vec2(0, px.y)) + texture(tex, uv - vec2(0, px.y));
    return c + amount * (4.0 * c - n);
}`},
      {id:"scanline", title:"CRT 스캔라인", desc:"브라운관 느낌의 가로줄 (fragCoord.y 기준)", code:`vec3 scanlines(vec3 color, float y, float strength) {
    return color * (1.0 - strength + strength * 0.5 * (1.0 + sin(y * 3.14159)));
}`}]},
    {id:"buffers", title:"버퍼 · 텍스처", desc:"다른 패스·이전 프레임·이미지를 읽는 패턴입니다.", items:[
      {id:"readPrev", title:"이전 프레임 누적", desc:"자기 자신(previous)을 iChannel0에 연결한 피드백 패스", scope:"main", code:`vec2 uv = gl_FragCoord.xy / uResolution;
vec4 history = uFrame == 0 ? vec4(0.0) : texture(iChannel0, uv);
fragColor = mix(history, newColor, 0.1);   // newColor를 천천히 누적`},
      {id:"texelNeighbors", title:"이웃 픽셀 읽기", desc:"상하좌우 텍셀을 정확히 읽기 (시뮬레이션·엣지 검출)", scope:"main", code:`ivec2 ip = ivec2(gl_FragCoord.xy);
vec4 center = texelFetch(iChannel0, ip, 0);
vec4 left   = texelFetch(iChannel0, ip + ivec2(-1, 0), 0);
vec4 right  = texelFetch(iChannel0, ip + ivec2( 1, 0), 0);
vec4 down   = texelFetch(iChannel0, ip + ivec2(0, -1), 0);
vec4 up     = texelFetch(iChannel0, ip + ivec2(0,  1), 0);`},
      {id:"laplacian", title:"라플라시안", desc:"확산·파동 시뮬레이션의 핵심 (9점, 가중치 합 1)", code:`vec4 laplacian(sampler2D tex, vec2 uv, vec2 px) {
    vec4 c = texture(tex, uv);
    vec4 sides = texture(tex, uv + vec2(px.x, 0)) + texture(tex, uv - vec2(px.x, 0))
               + texture(tex, uv + vec2(0, px.y)) + texture(tex, uv - vec2(0, px.y));
    vec4 corners = texture(tex, uv + px) + texture(tex, uv - px)
                 + texture(tex, uv + vec2(px.x, -px.y)) + texture(tex, uv + vec2(-px.x, px.y));
    return 0.2 * sides + 0.05 * corners - c;
}`},
      {id:"blur9", title:"3×3 박스 블러", desc:"주변 9픽셀 평균 (px = 1.0 / 해상도)", code:`vec4 blur9(sampler2D tex, vec2 uv, vec2 px) {
    vec4 sum = vec4(0.0);
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) sum += texture(tex, uv + vec2(x, y) * px);
    return sum / 9.0;
}`},
      {id:"sobel", title:"소벨 엣지", desc:"밝기 경계 강도 (윤곽선 효과)", requires:["luminance"], code:`float sobelEdge(sampler2D tex, vec2 uv, vec2 px) {
    float tl = luminance(texture(tex, uv + px * vec2(-1,  1)).rgb), t = luminance(texture(tex, uv + px * vec2(0,  1)).rgb), tr = luminance(texture(tex, uv + px * vec2(1,  1)).rgb);
    float l  = luminance(texture(tex, uv + px * vec2(-1,  0)).rgb),                                                        r  = luminance(texture(tex, uv + px * vec2(1,  0)).rgb);
    float bl = luminance(texture(tex, uv + px * vec2(-1, -1)).rgb), b = luminance(texture(tex, uv + px * vec2(0, -1)).rgb), br = luminance(texture(tex, uv + px * vec2(1, -1)).rgb);
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy = -bl - 2.0 * b - br + tl + 2.0 * t + tr;
    return length(vec2(gx, gy));
}`},
      {id:"gaussian", title:"가우시안 블러 (분리형)", desc:"한 방향 9탭 블러 — 가로 패스 + 세로 패스 두 번으로 큰 블러 (dir = (1/w, 0) 또는 (0, 1/h))", code:`vec4 gaussianBlur(sampler2D tex, vec2 uv, vec2 dir) {
    vec4 sum = texture(tex, uv) * 0.2270270270;
    sum += (texture(tex, uv + dir * 1.3846153846) + texture(tex, uv - dir * 1.3846153846)) * 0.3162162162;
    sum += (texture(tex, uv + dir * 3.2307692308) + texture(tex, uv - dir * 3.2307692308)) * 0.0702702703;
    return sum;
}`},
      {id:"advect", title:"이류 (값을 흐름 따라 옮기기)", desc:"속도장 vel(픽셀/프레임)을 거슬러 읽어 값을 실어 나름 (semi-Lagrangian) — 연기·잉크·유체", code:`vec4 advect(sampler2D field, vec2 fragCoord, vec2 vel, vec2 resolution) {
    return texture(field, (fragCoord - vel) / resolution);
}`},
      {id:"waveStep", title:"파동 방정식 한 단계", desc:"물결 시뮬레이션 Buffer (iChannel0 = 자기 자신 previous, RGBA16F 권장). r = 현재 높이, g = 직전 높이. 마우스로 물방울", scope:"main", code:`ivec2 ip = ivec2(gl_FragCoord.xy);
vec4 c = texelFetch(iChannel0, ip, 0);
float sum = texelFetch(iChannel0, ip + ivec2(1, 0), 0).r + texelFetch(iChannel0, ip - ivec2(1, 0), 0).r
          + texelFetch(iChannel0, ip + ivec2(0, 1), 0).r + texelFetch(iChannel0, ip - ivec2(0, 1), 0).r;
float next = (0.5 * sum - c.g) * 0.995;          // 2c − 이전 + ½·라플라시안 = ½·이웃합 − 이전, 감쇠 포함
if (uMouse.z > 0.0 && distance(gl_FragCoord.xy, uMouse.xy) < 6.0) next = 1.0;
fragColor = vec4(next, c.r, 0.0, 1.0);`},
      {id:"mouseBrush", title:"마우스 브러시", desc:"누르는 동안 포인터 주변이 1, 가장자리가 부드러운 마스크 (uMouse는 vec4로 선언)", scope:"main", code:`float brush = uMouse.z > 0.0 ? 1.0 - smoothstep(4.0, 12.0, distance(gl_FragCoord.xy, uMouse.xy)) : 0.0;`},
      {id:"mrtOut", title:"MRT 출력 선언", desc:"Buffer의 Out을 2 이상으로 했을 때. 기존 `out vec4 fragColor;` 줄은 지우세요(출력이 여럿이면 모두 location이 필요)", code:`layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outData;`},
      {id:"initGuard", title:"첫 프레임 초기화", desc:"시뮬레이션 시작 상태를 한 번만 쓰기 (Reset 시 다시 실행)", scope:"main", code:`if (uFrame == 0) {
    fragColor = vec4(0.0);   // 초기 상태
    return;
}`}]}
  ];
  const ALL = CATEGORIES.flatMap(category => category.items.map(item => ({...item, category:category.id})));
  const byId = new Map(ALL.map(item => [item.id, item]));
  // 조각이 정의하는 전역 함수 이름 목록 (중복 정의 방지·의존성 판단에 사용).
  const definedNames = code => [...code.matchAll(/^\s*(?:(?:highp|mediump|lowp)\s+)?(?:float|int|uint|bool|void|[biu]?vec[234]|mat[234](?:x[234])?)\s+([A-Za-z_]\w*)\s*\(/gm)].map(match => match[1]);
  // 삽입 계획: 필요한 조각을 의존 순서대로 모으되, 이미 소스에 정의된 함수는 건너뛴다.
  const plan = (id, source = "") => {
    const has = name => new RegExp(`(?:^|[^\\w.])(?:[biu]?vec[234]|mat[234]|float|int|uint|bool|void)\\s+${name}\\s*\\(`).test(source);
    const order = [], seen = new Set();
    const visit = key => {
      if(seen.has(key)) return; seen.add(key); const item = byId.get(key); if(!item) return;
      for(const dep of item.requires || []) visit(dep);
      order.push(item);
    };
    visit(id);
    const target = byId.get(id), skipped = [], included = [];
    for(const item of order) {
      const names = definedNames(item.code);
      if(names.length && names.every(has)) { if(item !== target) skipped.push(item.title); continue; }
      included.push(item);
    }
    const globals = included.filter(item => item !== target || (target.scope || "global") === "global");
    return {target, globals, mainCode:(target.scope === "main") ? target.code : null,
      alreadyDefined:!!(definedNames(target.code).length && definedNames(target.code).every(has)), skipped,
      added:included.filter(item => item !== target).map(item => item.title)};
  };
  export {CATEGORIES, ALL, plan, definedNames};
