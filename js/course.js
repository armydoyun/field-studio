// 입문 과정: C와 GLSL 문법은 알지만 셰이더는 처음인 사람이 자기 프로젝트를 만들 때까지 따라가는 단계별 수업.
// 가이드(guide.js)가 이 데이터를 렌더링한다. 문단 안에서는 `코드`와 **강조**만 서식으로 해석한다.
// 블록 형식(guide.js의 기본 블록 외 추가분):
//   {heading}                         소제목
//   {compare:{c, glsl, cTitle?, glslTitle?}}   C 코드와 GLSL 코드를 나란히 비교
//   {code, title, start:true}         "이 코드로 시작" — 단일 패스 프로젝트로 불러온다(Undo 가능)
//   {try:[…]}                         직접 해보기 과제 목록
//   {solution, title?}                접힌 정답 코드(펼쳐서 보고 바로 불러올 수 있음)
//   {project:<PROJECTS 키>, label}    멀티 패스 프로젝트 불러오기 버튼
//   {progress:true}                   과정 진행률 표시

  const HEAD = `#version 300 es
precision highp float;
uniform vec2 uResolution;   // 화면 크기(픽셀)
uniform float uTime;        // 경과 시간(초)
out vec4 fragColor;         // 이 픽셀의 최종 색`;

  const SD = `float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}`;

  const HASH = `// 같은 입력 → 항상 같은 출력. 상태가 없는 '난수'.
// 좌표의 비트를 uint로 읽어 C처럼 곱셈·xor·시프트로 섞습니다(pcg3d).
// uint 곱셈은 C의 unsigned처럼 2^32에서 감기므로 좌표가 아무리 커져도 무늬가 생기지 않아요.
uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
float hash21(vec2 p) {
    uint h = pcg3d(uvec3(floatBitsToUint(p), 0u)).x;
    return float(h >> 8u) / 16777216.0;   // 상위 24비트 → 0~1 (1.0은 나오지 않음)
}`;

  // ---------------------------------------------------------------- 1. 픽셀 하나의 관점
  const L1 = `${HEAD}

void main() {
    // gl_FragCoord.xy: 이 호출이 맡은 픽셀의 중심 좌표 (0.5, 0.5) ~ (W-0.5, H-0.5)
    // 원점은 '왼쪽 아래'입니다. C 이미지 배열(왼쪽 위)과 반대예요.
    vec2 uv = gl_FragCoord.xy / uResolution;   // 0~1로 정규화

    // 빨강 = x, 초록 = y. 화면 전체가 '좌표의 그래프'가 됩니다.
    fragColor = vec4(uv.x, uv.y, 0.0, 1.0);
}`;
  const L1_SOL = `${HEAD}

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;

    // 과제 3: 세로 줄무늬 10개 — floor로 '몇 번째 칸인지'(정수 인덱스)를 구하고
    // mod로 짝수/홀수를 가립니다. C의 (x / w) % 2 와 같은 생각입니다.
    float stripe = mod(floor(uv.x * 10.0), 2.0);

    // 과제 2: 왼쪽 절반만 빨갛게 — if 대신 step(가장자리, 값)을 써도 됩니다.
    float right = step(0.5, uv.x);

    vec3 color = vec3(stripe);
    color *= mix(vec3(1.0, 0.3, 0.3), vec3(1.0), right);
    fragColor = vec4(color, 1.0);
}`;

  // ---------------------------------------------------------------- 3. 좌표계
  const L3 = `${HEAD}
uniform vec2 uMouse;        // 포인터 픽셀 좌표(화면 밖이면 -1)

void main() {
    // 중심이 (0,0), 세로가 -1~1, 가로는 화면 비율만큼 넓어지는 좌표.
    // 거의 모든 셰이더가 이 한 줄로 시작합니다.
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    float px = 2.0 / uResolution.y;          // 이 좌표계에서 '픽셀 1개'의 크기
    float d = length(p) - 0.5;               // 원까지의 거리: 안쪽 < 0 < 바깥쪽

    // 경계를 픽셀 1개 폭으로 부드럽게 → 계단 현상(앨리어싱) 없음
    float inside = smoothstep(px, -px, d);

    vec3 bg = vec3(0.08, 0.09, 0.12);
    vec3 col = mix(bg, vec3(1.0, 0.6, 0.25), inside);
    fragColor = vec4(col, 1.0);
}`;
  const L3_SOL = `${HEAD}
uniform vec2 uMouse;

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec2 m = (2.0 * uMouse - uResolution) / uResolution.y;  // 마우스도 같은 좌표계로
    float px = 2.0 / uResolution.y;

    // 과제 1: 마우스를 따라다니는 원 — 점을 옮기는 대신 '좌표를 빼서' 원점을 옮깁니다.
    float dMouse = length(p - m) - 0.2;
    // 과제 2: 고리 — 거리의 절댓값에서 두께를 빼면 경계선만 남습니다.
    float dRing = abs(length(p) - 0.6) - 0.03;

    vec3 col = vec3(0.08, 0.09, 0.12);
    col = mix(col, vec3(0.3, 0.7, 1.0), smoothstep(px, -px, dRing));
    col = mix(col, vec3(1.0, 0.6, 0.25), smoothstep(px, -px, dMouse));
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 4. SDF
  const L4 = `${HEAD}

${SD}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    // 도형을 '움직이는' 대신 질의 좌표를 반대로 옮깁니다: sd(p - 위치)
    float circle = sdCircle(p - vec2(-0.35, 0.0), 0.4);
    float box    = sdBox(p - vec2(0.35, 0.0), vec2(0.3, 0.25));

    float d = min(circle, box);              // 합집합 = 더 가까운 쪽

    // 디버그 시각화: 바깥 주황 / 안쪽 파랑, 등고선은 거리 0.05마다
    vec3 col = d > 0.0 ? vec3(0.95, 0.6, 0.3) : vec3(0.4, 0.7, 1.0);
    col *= 1.0 - exp(-5.0 * abs(d));
    col *= 0.8 + 0.2 * cos(125.0 * d);
    col = mix(col, vec3(1.0), 1.0 - smoothstep(0.0, 0.012, abs(d)));  // 경계선 d = 0
    fragColor = vec4(col, 1.0);
}`;
  const L4_SOL = `${HEAD}

${SD}
// 매끄러운 합집합: k 거리 안에서 두 도형이 녹아 붙습니다.
float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    float px = 2.0 / uResolution.y;

    float circle = sdCircle(p - vec2(-0.3 + 0.2 * sin(uTime), 0.0), 0.35);
    float box    = sdBox(p - vec2(0.3, 0.0), vec2(0.3, 0.25));
    float hole   = sdCircle(p - vec2(0.3, 0.0), 0.12);

    float d = smin(circle, box, 0.15);   // 과제 2: 매끄러운 합집합
    d = max(d, -hole);                   // 과제 1: 차집합 = max(A, -B)

    vec3 col = vec3(0.08, 0.09, 0.12);
    col = mix(col, vec3(0.4, 0.7, 1.0), smoothstep(px, -px, d));
    col = mix(col, vec3(1.0), smoothstep(px, -px, abs(d) - 0.004));  // 과제 3: 외곽선
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 5. 시간
  const ROT = `// 2D 회전 행렬. GLSL 행렬은 '열 우선(column-major)'으로 채워집니다.
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }`;
  const L5 = `${HEAD}

${SD}
${ROT}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    float px = 2.0 / uResolution.y;
    float t = uTime;

    // 애니메이션 = 시간의 '닫힌 식'. 지난 프레임의 위치를 기억하지 않습니다.
    vec2 center = 0.5 * vec2(cos(t), sin(t));           // 원 궤도
    vec2 q = rot(-t * 2.0) * (p - center);              // 질의 좌표를 반대로 회전 = 도형이 회전
    float pulse = 0.12 + 0.04 * sin(t * 6.0);           // 숨쉬는 크기

    float d = sdBox(q, vec2(pulse));

    vec3 col = vec3(0.08, 0.09, 0.12) + 0.05 * p.y;
    col = mix(col, vec3(1.0, 0.75, 0.3), smoothstep(px, -px, d));
    fragColor = vec4(col, 1.0);
}`;
  const L5_SOL = `${HEAD}

${SD}
${ROT}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    float px = 2.0 / uResolution.y;

    // 과제 2: 6개를 원 위에 — 각 도형까지의 거리 중 최솟값(합집합)을 루프로 구합니다.
    // 루프 상한은 상수로 두세요. 모든 픽셀이 6번씩 돕니다(비용 = 픽셀 수 × 6).
    float d = 1e9;
    for (int i = 0; i < 6; i++) {
        float a = uTime + float(i) * 6.2831853 / 6.0;   // int → float는 명시적으로
        vec2 q = p - 0.55 * vec2(cos(a), sin(a));
        d = min(d, sdBox(rot(uTime * 2.0 + float(i)) * q, vec2(0.09)));
    }
    // 과제 3: 이징 — fract로 0→1 반복, smoothstep으로 가감속
    float k = smoothstep(0.0, 1.0, fract(uTime * 0.5));
    d = min(d, sdCircle(p, 0.1 + 0.1 * k));

    vec3 col = vec3(0.08, 0.09, 0.12);
    col = mix(col, vec3(1.0, 0.75, 0.3), smoothstep(px, -px, d));
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 6. 반복 · 해시
  const L6 = `${HEAD}

${HASH}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    float cells = 8.0;
    vec2 g  = p * cells;
    vec2 id = floor(g);              // 몇 번째 칸인가  (C: i / N)
    vec2 f  = fract(g) - 0.5;        // 칸 안의 위치 -0.5~0.5 (C: i % N)
    float px = 2.0 * cells / uResolution.y;   // 칸 좌표에서 픽셀 1개

    float r = hash21(id);            // 칸마다 다르지만 매 프레임 같은 값
    float radius = 0.15 + 0.25 * r * (0.6 + 0.4 * sin(uTime * 2.0 + r * 6.28));
    float d = length(f) - radius;

    vec3 tint = 0.5 + 0.5 * cos(6.2831 * (r + vec3(0.0, 0.33, 0.67)));
    vec3 col = vec3(0.06, 0.07, 0.1);
    col = mix(col, tint, smoothstep(px, -px, d));
    fragColor = vec4(col, 1.0);
}`;
  const L6_SOL = `${HEAD}

${HASH}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    float cells = 8.0;
    vec2 g = p * cells, id = floor(g), f = fract(g) - 0.5;
    float px = 2.0 * cells / uResolution.y;
    float r = hash21(id);

    // 과제 1: 체커보드 — 인덱스 합의 짝/홀
    float checker = mod(id.x + id.y, 2.0);
    vec3 col = mix(vec3(0.06, 0.07, 0.1), vec3(0.1, 0.11, 0.15), checker);

    // 과제 2: 칸마다 다른 회전 / 과제 3: 절반의 칸은 비우기
    if (r > 0.5) {
        float d = sdBox(rot(uTime * (r - 0.5) * 8.0) * f, vec2(0.25));
        col = mix(col, vec3(1.0, 0.7, 0.3), smoothstep(px, -px, d));
    }
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 7. 색
  const PALETTE = `// 코사인 팔레트: t 하나(0~1)로 부드러운 색 띠를 만듭니다. a,b,c,d를 바꿔 분위기를 고르세요.
vec3 palette(float t) {
    vec3 a = vec3(0.5), b = vec3(0.5), c = vec3(1.0), d = vec3(0.0, 0.33, 0.67);
    return a + b * cos(6.2831853 * (c * t + d));
}`;
  const L7 = `${HEAD}

${PALETTE}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    // 레이어 1: 배경 그라디언트
    vec3 col = mix(vec3(0.02, 0.02, 0.05), vec3(0.08, 0.05, 0.15), p.y * 0.5 + 0.5);

    // 레이어 2: 빛나는 고리 — 거리에 반비례하는 밝기를 '더하기'(가산 합성)
    float d = abs(length(p) - 0.55);
    vec3 glow = palette(atan(p.y, p.x) / 6.2831853 + uTime * 0.1);
    col += glow * 0.012 / max(d, 0.002);

    // 레이어 3: 가운데 원판 — 위에 '덮어 그리기'(mix = 알파 합성)
    float disc = smoothstep(0.32, 0.3, length(p));
    col = mix(col, palette(uTime * 0.2) * 0.9, disc);

    // 마무리: 가장자리를 어둡게(비네트), 1을 넘은 값은 부드럽게 눌러주기(톤 매핑)
    col *= 1.0 - 0.35 * dot(p * 0.6, p * 0.6);
    col = 1.0 - exp(-col * 1.4);
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 8. 노이즈
  const NOISE = `${HASH}

// 값 노이즈: 정수 격자점마다 해시 값을 두고 사이를 부드럽게 보간합니다.
// 2D 배열을 bilinear로 읽는 것과 같은 구조예요(배열 대신 해시 함수).
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);          // smoothstep 보간 가중치
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// fbm: 주파수를 2배, 진폭을 1/2로 줄이며 노이즈를 겹칩니다(옥타브).
float fbm(vec2 p) {
    float sum = 0.0, amp = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);        // 옥타브마다 회전+확대 → 격자 무늬 숨김
    for (int i = 0; i < 5; i++) {
        sum += amp * noise(p);
        p = m * p;
        amp *= 0.5;
    }
    return sum;
}`;
  const L8 = `${HEAD}

${NOISE}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    float n = fbm(p * 2.5 + vec2(uTime * 0.15, 0.0));

    vec3 sky   = vec3(0.12, 0.28, 0.55);
    vec3 cloud = vec3(0.95, 0.96, 1.0);
    vec3 col = mix(sky, cloud, smoothstep(0.35, 0.75, n));
    fragColor = vec4(col, 1.0);
}`;
  const L8_SOL = `${HEAD}

${NOISE}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y * 2.0;
    float t = uTime * 0.1;

    // 과제 3: 도메인 워핑 — 노이즈 값으로 좌표 자체를 비틉니다.
    vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
    float n = fbm(p + 2.0 * q);

    // 과제 2: 능선 노이즈 — 0.5 근처를 날카로운 선으로
    float ridge = 1.0 - abs(n * 2.0 - 1.0);

    vec3 col = mix(vec3(0.05, 0.02, 0.1), vec3(0.9, 0.4, 0.2), n);
    col += vec3(1.0, 0.8, 0.5) * pow(ridge, 8.0);
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 9. 파라미터
  const L9 = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;

// 주석의 @태그가 파라미터 탭에 슬라이더·색상 선택기를 만듭니다.
uniform float uCells;  // @range 2 24 @step 1 @default 8
uniform float uSpeed;  // @range 0 4 @default 1
uniform float uFill;   // @range 0 1 @default 0.6
uniform vec3  uTint;   // @color @default 1.0 0.6 0.25
uniform vec3  uBack;   // @color @default 0.06 0.07 0.1
out vec4 fragColor;

${HASH}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec2 g = p * uCells, id = floor(g), f = fract(g) - 0.5;
    float px = 2.0 * uCells / uResolution.y;

    float r = hash21(id);
    float radius = 0.45 * uFill * (0.7 + 0.3 * sin(uTime * uSpeed * 2.0 + r * 6.28));
    float d = length(f) - radius;

    vec3 col = mix(uBack, uTint * (0.6 + 0.4 * r), smoothstep(px, -px, d));
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 10. 버퍼: 생명 게임
  const LIFE_A = `#version 300 es
precision highp float;
// Buffer A: 생명 게임의 '현재 세대'를 저장하는 2D 배열.
// iChannel0 = A · previous (직전 프레임의 자기 자신) → 더블 버퍼링
uniform vec2 uResolution;      // 이 버퍼의 크기(셀 수)
uniform int uFrame;            // 0이면 초기화
uniform vec4 uMouse;           // xy = 포인터(이 버퍼 좌표), z > 0 = 누르는 중
uniform sampler2D iChannel0;
out vec4 fragColor;            // r = 살아 있음(0/1), g = 나이

${HASH}

// 배열 읽기: texelFetch는 정수 인덱스로 정확히 한 칸을 읽습니다(보간 없음).
// 가장자리는 % 로 감싸 토러스(위아래·좌우가 이어진 판)로 만듭니다.
int alive(ivec2 c) {
    ivec2 size = ivec2(uResolution);
    c = (c + size) % size;
    return texelFetch(iChannel0, c, 0).r > 0.5 ? 1 : 0;
}

void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);

    if (uFrame == 0) {                               // 첫 프레임: 무작위로 30% 채우기
        fragColor = vec4(step(0.7, hash21(gl_FragCoord.xy)), 0.0, 0.0, 1.0);
        return;
    }

    int n = 0;                                       // 이웃 8칸 세기
    for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++)
            if (x != 0 || y != 0) n += alive(c + ivec2(x, y));

    int self = alive(c);
    int next = (n == 3 || (self == 1 && n == 2)) ? 1 : 0;   // B3/S23 규칙

    if (uMouse.z > 0.0 && distance(gl_FragCoord.xy, uMouse.xy) < 4.0) next = 1;  // 그려서 살리기

    float age = texelFetch(iChannel0, c, 0).g;
    fragColor = vec4(float(next), next == 1 ? min(age + 0.01, 1.0) : 0.0, 0.0, 1.0);
}`;
  const LIFE_IMAGE = `#version 300 es
precision highp float;
// Image: Buffer A의 내용을 화면에 그립니다. 시뮬레이션 로직은 없습니다(표시 전용).
uniform vec2 uResolution;
uniform sampler2D iChannel0;   // A · current (이번 프레임에 계산된 세대)
out vec4 fragColor;

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec4 cell = texture(iChannel0, uv);          // A는 Filter = Nearest라 칸이 또렷합니다

    vec3 dead  = vec3(0.04, 0.05, 0.08);
    vec3 young = vec3(1.0, 0.85, 0.4);
    vec3 old   = vec3(0.3, 0.6, 1.0);
    vec3 col = cell.r > 0.5 ? mix(young, old, cell.g) : dead;
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 12. 나만의 프로젝트 템플릿
  const TEMPLATE = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
uniform float uSpeed;   // @range 0 3 @default 1
uniform vec3  uColorA;  // @color @default 0.06 0.07 0.12
uniform vec3  uColorB;  // @color @default 1.0 0.55 0.3
out vec4 fragColor;

// ── 1. 도구 상자: 쓰지 않는 함수는 지워도 됩니다 ───────────────
${HASH}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

// ── 2. 장면: 좌표 p와 시간 t를 받아 '거리 하나'를 돌려줍니다 ──────
float scene(vec2 p, float t) {
    // TODO: 도형을 만들고 min / max / smin으로 합치세요.
    float body = sdCircle(p, 0.35 + 0.03 * sin(t * 3.0));
    float arm  = sdBox(rot(t) * p, vec2(0.65, 0.05));
    return smin(body, arm, 0.1);
}

void main() {
    // ── 3. 좌표 ────────────────────────────────────────────
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    float px = 2.0 / uResolution.y;
    float t = uTime * uSpeed;

    // ── 4. 형태 ────────────────────────────────────────────
    float d = scene(p, t);

    // ── 5. 색: 배경 → 채우기 → 외곽 빛 순서로 레이어를 쌓습니다 ─────
    vec3 col = mix(uColorA, uColorA * 1.8, p.y * 0.5 + 0.5);
    col = mix(col, uColorB, smoothstep(px, -px, d));
    col += uColorB * 0.004 / max(abs(d), 0.004);
    fragColor = vec4(col, 1.0);
}`;

  // 멀티 패스 프로젝트: studio.loadExample에 그대로 넘긴다.
  const PROJECTS = {
    life:{image:LIFE_IMAGE, passes:[{name:"A", fragment:LIFE_A, format:"rgba8", scale:0.25, filter:"nearest", wrap:"repeat", channels:{0:{buffer:"A", frame:"previous"}}}],
      imageChannels:{0:{buffer:"A", frame:"current"}}}
  };

  const LESSONS = [
    {id:"course", course:true, title:"입문 과정 안내", summary:"C 개발자를 위한 셰이더 입문 · 12단계", blocks:[
      {p:"이 과정은 **C와 GLSL 문법은 알지만 셰이더는 처음**인 분을 위해 만들었습니다. 컴퓨터 구조와 자료구조 감각을 그대로 활용해서, 마지막 단계에서 **나만의 프로젝트**를 만드는 것이 목표입니다."},
      {progress:true},
      {heading:"가장 먼저 바꿔야 할 생각 하나"},
      {p:"CPU 코드는 \"이미지를 만드는 프로그램\"을 씁니다. 프래그먼트 셰이더는 \"**픽셀 하나의 색을 계산하는 순수 함수**\"를 씁니다. 루프, 스레드 분배, 메모리 쓰기는 GPU가 대신합니다."},
      {table:{head:["이미 아는 것","셰이더에서는"], rows:[
        ["이중 for 루프로 픽셀 채우기","루프 **본문**만 작성(`main`). GPU가 모든 픽셀에 동시에 실행"],
        ["SIMD · 스레드 병렬","수천 개 호출이 묶음(warp)으로 같은 명령을 실행. 분기가 갈리면 양쪽 모두 실행 비용"],
        ["전역 변수 (읽기 전용)","`uniform` — CPU가 프레임마다 넣는 상수(시간·해상도·마우스)"],
        ["출력 배열 `out[y][x] = …`","`fragColor` 하나. **자기 픽셀에만** 쓸 수 있음(gather O, scatter X)"],
        ["2D 배열 읽기","텍스처 — `texelFetch`(정수 인덱스) 또는 `texture`(0~1 좌표 + 하드웨어 보간)"],
        ["static 변수 · 프레임 간 상태","없음. 상태는 **버퍼(텍스처)에 써서** 다음 프레임에 읽음 = 더블 버퍼링"],
        ["printf 디버깅","값을 **색으로** 출력해서 눈으로 확인"]]}},
      {heading:"과정 구성"},
      {steps:[
        "**기초 감각** — 1 픽셀 하나의 관점 · 2 C와 다른 점 · 3 좌표계 만들기",
        "**그리기** — 4 도형은 거리 함수 · 5 시간과 움직임 · 6 반복·타일·해시 · 7 색과 합성",
        "**표현력** — 8 노이즈 · 9 파라미터로 다듬기",
        "**상태와 실전** — 10 버퍼와 상태(생명 게임) · 11 디버깅·성능 감각 · 12 나만의 프로젝트"]},
      {heading:"각 단계 사용법"},
      {list:["**이 코드로 시작**을 누르면 현재 작업이 그 단계의 예제로 바뀝니다. 걱정 마세요 — 편집기에서 `Ctrl+Z`로 언제든 되돌릴 수 있습니다.",
        "가이드는 닫혀도 위치를 기억합니다. `?` 키(또는 툴바의 ? 버튼)로 같은 단계로 돌아오세요.",
        "**직접 해보기** 과제를 먼저 시도하고, 막히면 **정답 보기**를 펼치세요.",
        "끝난 단계는 **완료로 표시**하면 목록에 ✓가 붙습니다."]},
      {actions:[{label:"1단계 시작하기 →", run:"topic:c1"}]}]},

    {id:"c1", course:true, step:1, title:"픽셀 하나의 관점", summary:"루프 본문만 쓰는 프로그래밍", blocks:[
      {p:"C로 그라디언트 이미지를 만든다면 이중 루프를 돌며 배열에 씁니다. 셰이더는 **그 루프의 본문만** 작성합니다. GPU가 화면의 모든 픽셀에 대해 `main()`을 병렬로 호출하고, 각 호출은 `gl_FragCoord`로 \"내가 몇 번째 픽셀인지\"를 압니다."},
      {compare:{cTitle:"C · CPU가 루프를 돈다", c:`for (int y = 0; y < H; y++)
  for (int x = 0; x < W; x++)
    img[y][x] = shade(x, y);`,
        glslTitle:"GLSL · 본문만 쓴다", glsl:`void main() {
  vec2 xy = gl_FragCoord.xy;  // 이번 픽셀
  fragColor = shade(xy);      // img[y][x] = …
}`}},
      {list:["`main()`은 **입력 → 색**인 순수 함수입니다. 다른 픽셀의 결과를 읽을 수도, 다른 픽셀에 쓸 수도 없습니다.",
        "그래서 **실행 순서가 없습니다.** 어떤 픽셀이 먼저 계산되든 결과가 같아야 하고, 그 덕분에 수천 개를 동시에 돌릴 수 있습니다.",
        "`gl_FragCoord.xy`는 픽셀 **중심**(x+0.5, y+0.5)이고 원점은 **왼쪽 아래**입니다.",
        "색은 0~1 실수입니다. `vec4(r, g, b, a)` — 255가 아니라 1.0이 최대입니다."]},
      {code:L1, title:"1단계 예제 · 좌표를 색으로", start:true},
      {p:"화면 왼쪽 아래가 검정(0,0), 오른쪽이 빨강(x=1), 위쪽이 초록(y=1)입니다. 즉 지금 화면은 **좌표 그 자체의 그래프**예요. 셰이더 디버깅의 기본이 이것입니다."},
      {try:["빨강만 남기고 가로 방향 그라디언트로 바꿔 보세요.",
        "화면 왼쪽 절반만 빨갛게 칠해 보세요. `if`로 해도 되고 `step(0.5, uv.x)`를 써도 됩니다.",
        "흑백 세로 줄무늬 10개를 만들어 보세요. 힌트: `floor`로 칸 번호, `mod`로 짝/홀."]},
      {solution:L1_SOL}]},

    {id:"c2", course:true, step:2, title:"C와 다른 점", summary:"포인터·재귀·형변환 없이 쓰는 법", blocks:[
      {p:"GLSL은 C처럼 생겼지만 GPU에 맞춘 제약이 있습니다. 컴파일 오류의 대부분이 여기서 나오니 한 번 훑어 두세요."},
      {table:{head:["C 습관","GLSL에서는"], rows:[
        ["`float x = 1;`","**암묵 형변환 없음** → `1.0`, `float(i)`, `int(f)`처럼 명시"],
        ["포인터 · `malloc`","없음. 값 전달 + `out`/`inout` 매개변수로 결과 돌려받기"],
        ["재귀 함수","금지. 반복문(스택 없이)으로 바꾸기"],
        ["가변 길이 배열","배열 크기는 컴파일 타임 상수. 큰 데이터는 텍스처로"],
        ["`a % b` (실수)","`%`는 정수 전용. 실수는 `mod(a, b)` — 음수에서 C의 `fmod`와 결과가 다름(`mod(-1.0, 3.0)` = 2.0)"],
        ["구조체로 xyz 묶기","`vec2/3/4` + 스위즐: `v.xy`, `v.zyx`, `v.rgb`, `vec3(v.xy, 1.0)`"],
        ["`a * b` (벡터)","**성분별 곱**. 내적은 `dot`, 외적은 `cross`, 행렬곱은 `m * v`"],
        ["행렬 초기화 순서","열 우선(column-major): `mat2(a, b, c, d)`는 열 (a,b), (c,d)"],
        ["`printf`","없음. 값을 색으로 출력해 확인(11단계)"],
        ["`while (!done)`","루프 상한은 상수로 두고 `break`로 빠져나오기. 무한 루프는 GPU 타임아웃"]]}},
      {compare:{cTitle:"C · 포인터로 두 값 반환", c:`void polar(float x, float y,
           float *r, float *a) {
  *r = sqrtf(x*x + y*y);
  *a = atan2f(y, x);
}`,
        glslTitle:"GLSL · out 매개변수", glsl:`void polar(vec2 p,
           out float r, out float a) {
  r = length(p);
  a = atan(p.y, p.x);  // atan2 아님
}`}},
      {heading:"분기와 성능"},
      {p:"GPU는 수십 개 픽셀을 한 묶음으로 **같은 명령을 동시에** 실행합니다. 묶음 안에서 `if`가 갈리면 양쪽 경로를 모두 실행하고 결과만 고릅니다(분기 발산). 그래서 셰이더 코드는 `if` 대신 수학 함수를 즐겨 씁니다."},
      {table:{head:["함수","의미 · C로 쓰면"], rows:[
        ["step(e, x)","`x < e ? 0.0 : 1.0`"],
        ["smoothstep(a, b, x)","a~b 사이에서 0→1로 부드럽게(경계 흐리기·안티앨리어싱)"],
        ["mix(a, b, t)","`a + (b - a) * t` — 선형 보간, t가 0/1이면 선택(select)"],
        ["clamp(x, lo, hi)","`min(max(x, lo), hi)`"],
        ["fract(x) · floor(x)","소수부 · 정수부 — 반복 무늬의 핵심(6단계)"]]}},
      {note:"작은 `if`는 컴파일러가 알아서 select로 바꾸므로 너무 걱정하지 마세요. 비용이 커지는 건 **양쪽 경로가 모두 무거운** 경우입니다."},
      {p:"전체 내장 함수 목록은 **GLSL 내장 함수** 레퍼런스에 범주별로 정리되어 있고, 함수마다 C 대응과 예시 한 줄이 있습니다."},
      {actions:[{label:"GLSL 내장 함수 레퍼런스", run:"topic:builtins"}, {label:"다음: 3단계 좌표계 만들기 →", run:"topic:c3"}]}]},

    {id:"c3", course:true, step:3, title:"좌표계 만들기", summary:"중심 원점 · 화면 비율 · 안티앨리어싱", blocks:[
      {p:"0~1 좌표는 화면이 가로로 길면 원이 타원이 됩니다. 그래서 거의 모든 셰이더가 **중심이 (0,0)이고 세로가 -1~1**인 좌표로 시작합니다. 가로 범위는 화면 비율에 따라 늘어납니다."},
      {code:`vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;`, title:"이 한 줄을 외워 두세요", insert:"cursor"},
      {p:"원은 \"중심까지 거리가 r 이하인 점의 집합\"입니다. `length(p) - r`은 바깥에서 양수, 안에서 음수, 경계에서 0이 됩니다. 이 **부호 있는 거리**가 다음 단계의 핵심입니다."},
      {list:["`d < 0.0 ? 1.0 : 0.0`로 칠하면 경계가 계단처럼 깨집니다(앨리어싱).",
        "`smoothstep(px, -px, d)`는 경계 주변 **픽셀 1개 폭**만 부드럽게 섞어 매끈하게 만듭니다. `px`는 이 좌표계에서 픽셀 하나의 크기인 `2.0 / uResolution.y`입니다."]},
      {code:L3, title:"3단계 예제 · 중심 좌표와 원", start:true},
      {try:["원이 **마우스를 따라다니게** 해 보세요. `uMouse`도 픽셀 좌표이니 같은 공식으로 바꾼 뒤 `length(p - m)`.",
        "속이 빈 **고리**를 그려 보세요. 힌트: `abs(length(p) - 0.6) - 두께`.",
        "창 크기를 바꿔도 원이 찌그러지지 않는지 확인해 보세요."]},
      {solution:L3_SOL}]},

    {id:"c4", course:true, step:4, title:"도형은 거리 함수", summary:"SDF · 합집합/교집합/차집합", blocks:[
      {p:"셰이더에서 도형은 **좌표 → 경계까지의 부호 있는 거리**를 돌려주는 함수(SDF, Signed Distance Function)입니다. 도형을 \"그리는\" 대신 \"이 점이 도형에서 얼마나 떨어져 있는가\"를 묻습니다."},
      {table:{head:["연산","거리 함수로","집합으로"], rows:[
        ["합치기","`min(a, b)`","A ∪ B"],
        ["겹친 부분","`max(a, b)`","A ∩ B"],
        ["빼기","`max(a, -b)`","A − B"],
        ["녹여 붙이기","`smin(a, b, k)`","경계가 매끄러운 합집합"],
        ["외곽선","`abs(d) - w`","두께 w의 테두리"],
        ["둥글게","`d - r`","모서리를 r만큼 둥글게"]]}},
      {p:"도형을 옮기거나 돌릴 때는 **도형이 아니라 질의 좌표를 반대로 변환**합니다. `sdCircle(p - c, r)`은 c로 옮긴 원입니다. 행렬로 생각하면 도형에 M을 적용하는 대신 점에 M⁻¹을 적용하는 것과 같습니다."},
      {code:L4, title:"4단계 예제 · 거리장 시각화", start:true},
      {p:"예제는 거리 값을 **등고선**으로 보여줍니다. 흰 선이 d = 0(경계), 주황이 바깥, 파랑이 안쪽입니다. 도형을 만들다 결과가 이상하면 이렇게 거리장을 직접 보는 것이 가장 빠른 디버깅입니다."},
      {try:["상자에서 작은 원을 **빼서** 구멍을 뚫어 보세요.",
        "`min` 대신 `smin`(정답 코드 참고)으로 원과 상자를 녹여 붙이고, 원을 `sin(uTime)`으로 좌우로 움직여 보세요.",
        "흰 **외곽선만** 남겨 보세요."]},
      {solution:L4_SOL},
      {note:"원·상자 말고도 선분, 삼각형, 별, 하트 등 많은 2D SDF가 알려져 있습니다. **코드 조각 모음**의 SDF 범주에서 바로 삽입할 수 있습니다."},
      {actions:[{label:"코드 조각 모음 열기", run:"topic:snippets"}]}]},

    {id:"c5", course:true, step:5, title:"시간과 움직임", summary:"uTime · 회전 행렬 · 이징", blocks:[
      {p:"게임 루프라면 `pos += vel * dt`처럼 매 프레임 상태를 갱신합니다. 셰이더에는 프레임 사이에 남는 변수가 없으므로, 움직임을 **시간의 닫힌 식** `pos = f(t)`으로 씁니다. 몇 초로 건너뛰어도 같은 화면이 나오는 결정적인 애니메이션입니다."},
      {compare:{cTitle:"C · 상태를 적분", c:`// 매 프레임
angle += speed * dt;
x = cx + r * cosf(angle);`,
        glslTitle:"GLSL · 시간의 함수", glsl:`// 상태 없음
float angle = speed * uTime;
float x = cx + r * cos(angle);`}},
      {table:{head:["재료","효과"], rows:[
        ["sin(t), cos(t)","-1~1 왕복. `0.5 + 0.5 * sin(t)`로 0~1"],
        ["fract(t)","0→1을 반복하는 톱니. 루프 애니메이션"],
        ["smoothstep(0, 1, fract(t))","가속-감속(이징)이 들어간 반복"],
        ["rot(a) * p","좌표를 회전 → 도형이 반대로 회전"]]}},
      {code:L5, title:"5단계 예제 · 궤도를 도는 상자", start:true},
      {try:["회전 속도와 궤도 반지름을 바꿔 보세요.",
        "`for` 루프로 상자 **6개**를 원 위에 배치하세요. 각 도형 거리의 `min`을 누적하면 됩니다.",
        "`fract`와 `smoothstep`으로 1초마다 커졌다 줄어드는 원을 더해 보세요."]},
      {solution:L5_SOL},
      {note:"루프는 **모든 픽셀이** 돕니다. 1920×1080 화면에서 6회 루프는 프레임당 약 1,200만 번 계산입니다. GPU에겐 가볍지만, 루프 안에 루프를 넣을 때는 이 곱셈을 떠올리세요."}]},

    {id:"c6", course:true, step:6, title:"반복 · 타일 · 해시", summary:"fract로 무한 반복 · 칸마다 다른 난수", blocks:[
      {p:"좌표에 N을 곱하고 `fract`를 취하면 화면이 N×N 칸으로 쪼개지고, 모든 칸이 같은 지역 좌표를 받습니다. 도형 하나를 그리는 코드로 **무한히 많은** 도형을 그리는 기법입니다(도메인 반복)."},
      {compare:{cTitle:"C · 정수 인덱스", c:`int cell  = i / N;   // 몇 번째 칸
int local = i % N;   // 칸 안 위치`,
        glslTitle:"GLSL · 실수 좌표", glsl:`vec2 id = floor(p * N);       // 칸 번호
vec2 f  = fract(p * N) - 0.5; // -0.5~0.5`}},
      {p:"칸마다 다르게 하려면 난수가 필요합니다. 하지만 `rand()`는 **숨은 상태**(시드)를 바꾸는 함수라 수천 개가 동시에 호출하는 셰이더에서는 쓸 수 없습니다. 대신 **해시 함수** — 같은 입력에 항상 같은 값을 주는 순수 함수 — 에 칸 번호를 넣습니다. 해시 테이블의 해시와 같은 개념이에요."},
      {code:L6, title:"6단계 예제 · 칸마다 다른 원", start:true},
      {try:["칸 번호로 **체커보드** 배경을 깔아 보세요: `mod(id.x + id.y, 2.0)`.",
        "칸마다 다른 속도로 **회전하는 상자**로 바꿔 보세요.",
        "해시 값이 0.5보다 작은 칸은 **비워** 보세요."]},
      {solution:L6_SOL},
      {note:"이웃 칸의 도형이 경계를 넘어오면 잘려 보입니다. 도형을 칸 안(반지름 0.5 미만)에 두거나, 주변 3×3 칸을 루프로 함께 검사하면 해결됩니다."},
      {note:"예제의 `hash21`은 정수 해시입니다. `floatBitsToUint`로 실수의 비트를 그대로 uint로 읽고(C의 `memcpy`나 공용체로 float 비트를 읽는 것과 같음), 곱셈·xor·시프트로 섞습니다. `fract(sin(...))`처럼 실수 연산만 쓰는 짧은 해시는 좌표가 수만을 넘으면 정밀도가 모자라 줄무늬가 생깁니다. 코드 조각의 **해시 · 정수** 범주에 같은 방식의 함수가 더 있습니다."}]},

    {id:"c7", course:true, step:7, title:"색과 합성", summary:"팔레트 · 레이어 · 빛 번짐", blocks:[
      {p:"색은 0~1 실수 벡터라서 일반 산술이 그대로 됩니다. 장면은 **뒤에서 앞으로 레이어를 쌓는**(화가 알고리즘) 방식으로 칠합니다."},
      {table:{head:["합성","코드","느낌"], rows:[
        ["덮기(알파)","`col = mix(col, layer, alpha)`","불투명한 물체"],
        ["더하기","`col += light`","빛·발광·불꽃"],
        ["곱하기","`col *= shade`","그림자·비네트"],
        ["빛 번짐","`col += c * k / abs(d)`","네온·글로우"],
        ["톤 매핑","`col = 1.0 - exp(-col)`","1을 넘은 값을 부드럽게 압축"]]}},
      {code:PALETTE, title:"코사인 팔레트 (어디서나 쓰는 한 줄 색 생성기)", insert:"cursor"},
      {code:L7, title:"7단계 예제 · 네온 고리", start:true},
      {try:["팔레트의 `d` 값을 `vec3(0.8, 0.9, 0.3)`처럼 바꿔 다른 분위기를 찾아보세요.",
        "고리를 하나 더 겹치되 **다른 반지름·다른 팔레트 위상**으로 더해 보세요.",
        "마지막 톤 매핑 줄을 지웠다 다시 넣어 차이를 비교해 보세요(밝은 곳이 하얗게 날아갑니다)."]}]},

    {id:"c8", course:true, step:8, title:"노이즈", summary:"자연스러운 무작위 · fbm · 도메인 워핑", blocks:[
      {p:"해시는 칸마다 값이 튀어서 자연물처럼 보이지 않습니다. **값 노이즈**는 정수 격자점에만 해시 값을 두고 그 사이를 부드럽게 보간합니다. 2D 배열을 bilinear로 읽는 것과 같은 구조인데, 배열 대신 해시 함수를 씁니다. 메모리가 0바이트인 무한한 격자죠."},
      {list:["**fbm**(fractional Brownian motion): 주파수 2배·진폭 1/2로 노이즈를 몇 겹(옥타브) 쌓습니다. 큰 덩어리 위에 작은 디테일이 얹힌 구름·지형이 됩니다.",
        "**도메인 워핑**: 노이즈 값으로 좌표를 비튼 다음 다시 노이즈를 읽습니다. 연기·마블·오로라 같은 흐름이 생깁니다.",
        "옥타브 수만큼 비용이 늘어납니다. 5옥타브 × 워핑 3회 = 픽셀마다 노이즈 15번."]},
      {code:L8, title:"8단계 예제 · 흐르는 구름", start:true},
      {try:["fbm 루프 횟수를 1, 3, 8로 바꿔 디테일 변화를 보세요.",
        "**능선 노이즈** `1.0 - abs(n * 2.0 - 1.0)`로 산맥·번개 같은 선을 만들어 보세요.",
        "**도메인 워핑** `fbm(p + 2.0 * vec2(fbm(p), fbm(p + 5.2)))`을 시도해 보세요."]},
      {solution:L8_SOL},
      {actions:[{label:"갤러리의 Aurora Flow(도메인 워핑) 열기", run:"example:aurora"}]}]},

    {id:"c9", course:true, step:9, title:"파라미터로 다듬기", summary:"@range · @color 어노테이션", blocks:[
      {p:"숫자를 바꿀 때마다 코드를 고치는 대신, 조절할 값을 **uniform으로 빼고 주석에 범위를 적으면** 파라미터 탭에 슬라이더가 생깁니다. 프로그램의 설정 구조체나 명령줄 옵션을 노출하는 것과 같아요."},
      {code:`uniform float uSpeed;  // @range 0 4 @default 1
uniform vec3  uTint;   // @color @default 1.0 0.6 0.25`, title:"선언 + 주석 = 슬라이더", insert:"cursor"},
      {list:["컴파일에 성공하면 자동으로 등록됩니다. 값을 바꾸면 **다시 컴파일하지 않고** 즉시 반영됩니다.",
        "`@color`는 vec3/vec4를 색상 선택기로 보여줍니다.",
        "등록된 값은 브라우저에 저장되고 **전체 프로젝트 저장(Pack)**에도 포함됩니다."]},
      {code:L9, title:"9단계 예제 · 6단계 무늬를 파라미터로", start:true},
      {actions:[{label:"파라미터 탭 열기", run:"panel:uniforms"}]},
      {try:["파라미터 탭에서 슬라이더를 움직여 보세요. 코드가 다시 실행되지 않고도 바뀝니다.",
        "`uRound`(0~0.5) 같은 파라미터를 직접 추가해 원과 상자 사이를 오가게 해 보세요.",
        "마음에 드는 값 조합을 찾으면 `@default`에 적어 두세요. 다른 컴퓨터에서도 같은 출발점이 됩니다."]}]},

    {id:"c10", course:true, step:10, title:"버퍼와 상태", summary:"더블 버퍼링 · 생명 게임", blocks:[
      {p:"지금까지의 셰이더는 순수 함수라서 **기억이 없습니다.** 시뮬레이션처럼 이전 상태가 필요하면 상태를 **텍스처(버퍼)에 저장**하고 다음 프레임에 그 텍스처를 읽습니다."},
      {compare:{cTitle:"C · 배열 두 개를 교대로", c:`static Cell a[H][W], b[H][W];
Cell (*cur)[W] = a, (*nxt)[W] = b;
for (;;) {               // 매 프레임
  step(cur, nxt);        // cur 읽고 nxt 쓰기
  swap(&cur, &nxt);      // 포인터 교환
}`,
        glslTitle:"FIELD Studio · Buffer A", glsl:`// 입력 채널: iChannel0 = A · previous
// → 직전 프레임에 A가 쓴 결과를 읽음
// 출력 fragColor → 이번 프레임의 A
// 교환(swap)은 렌더러가 자동으로 합니다.
vec4 old = texelFetch(iChannel0,
                      ivec2(gl_FragCoord.xy), 0);`}},
      {table:{head:["개념","FIELD Studio에서"], rows:[
        ["상태 배열","**Buffer** (A~H). 편집기 패스 탭 옆의 `+`로 추가"],
        ["이전 세대 읽기","입력 채널을 자기 자신의 **previous**로 연결"],
        ["다른 단계 결과 읽기","앞에서 실행된 버퍼의 **current**"],
        ["배열 인덱스로 읽기","`texelFetch(채널, ivec2(x, y), 0)` — 정수 좌표, 보간 없음"],
        ["초기화","`uFrame == 0`일 때 초기값 쓰기 (Reset 버튼으로 0으로)"],
        ["배열 크기","버퍼 설정의 크기(화면 비율 또는 고정 해상도), 정밀도는 형식(RGBA8 / 16F / 32F)"]]}},
      {p:"아래 프로젝트는 **콘웨이의 생명 게임**입니다. Buffer A가 셀 배열(화면의 1/4 해상도, Filter = Nearest, Wrap = Repeat)이고 Image는 그 배열을 색으로 보여주기만 합니다. 화면을 누른 채 끌면 셀을 살릴 수 있습니다."},
      {project:"life", label:"생명 게임 프로젝트 불러오기"},
      {list:["편집기 위쪽 패스 탭에서 **A**와 **Image**를 오가며 코드를 비교해 보세요.",
        "**↻ Reset**을 누르면 `uFrame`이 0이 되어 새 무작위 판으로 시작합니다.",
        "**성능 → 버퍼 뷰어**에서 A의 원본 값(r = 생존, g = 나이)을 직접 볼 수 있습니다."]},
      {try:["규칙을 **HighLife(B36/S23)**로 바꿔 보세요: 태어나는 조건에 `n == 6`을 추가.",
        "초기 밀도 `step(0.7, …)`를 0.5, 0.9로 바꿔 보세요.",
        "Buffer A의 **Size**를 12.5%로 낮추면 셀이 커지고, 100%로 올리면 아주 미세해집니다."]},
      {note:"버퍼 하나의 픽셀은 RGBA 4개 값을 담는 **구조체 배열**로 생각하세요. 4개로 부족하면 버퍼 설정의 출력 수(MRT)를 늘리거나 버퍼를 더 만듭니다."},
      {actions:[{label:"버퍼 · 멀티패스 레퍼런스", run:"topic:buffers"}, {label:"반응-확산 시뮬레이션 예제", run:"example:reaction"}]}]},

    {id:"c11", course:true, step:11, title:"디버깅 · 성능 감각", summary:"색으로 printf · 비용 모델", blocks:[
      {heading:"printf 대신 색으로 출력하기"},
      {list:["값 하나를 보고 싶으면 `fragColor = vec4(vec3(값), 1.0); return;`을 원하는 줄에 넣으세요. 그 아래 코드는 무시됩니다.",
        "0~1을 벗어난 값은 잘려 보입니다. 아래 함수로 음수는 빨강, 1 초과는 초록으로 표시하세요.",
        "**성능 → 버퍼 뷰어**에서 버퍼를 고르고 뷰포트에 포인터를 올리면 그 픽셀의 **실제 숫자**를 읽을 수 있습니다(디버거의 watch에 해당).",
        "컴파일 오류는 해당 줄에 빨간 띠로 표시됩니다. 오류가 있어도 화면은 마지막 성공 결과를 유지합니다."]},
      {code:`// 음수는 빨강, 0~1은 회색조, 1 초과는 초록
vec3 debugValue(float v) { return v < 0.0 ? vec3(-v, 0, 0) : v > 1.0 ? vec3(0, v - 1.0, 0) : vec3(v); }`, title:"값 시각화 함수", insert:"cursor"},
      {heading:"비용 모델"},
      {p:"셰이더 비용은 거의 **픽셀 수 × 픽셀당 연산**입니다. 1920×1080은 프레임당 약 200만 번 호출이고, 60fps라면 초당 1억 2천만 번입니다."},
      {table:{head:["무거워지는 원인","대처"], rows:[
        ["루프 안의 루프, 많은 옥타브","반복 횟수 줄이기, 조기 `break`"],
        ["텍스처 읽기 많음(블러 등)","작은 버퍼(Size 50%·25%)에서 처리 후 확대, 밉맵(`textureLod`)"],
        ["화면 전체 고해상도","렌더링 탭의 **해상도 배율**·**최대 픽셀 수**"],
        ["양쪽 다 무거운 분기","공통 부분을 분기 밖으로"]]}},
      {p:"**성능** 탭의 프레임 타임라인과 패스별 GPU 시간으로 어느 패스가 무거운지 확인하세요. 16.7ms를 넘으면 60fps를 못 냅니다."},
      {actions:[{label:"성능 탭 열기", run:"panel:profile"}, {label:"디버깅 레퍼런스", run:"topic:debug"}]}]},

    {id:"c12", course:true, step:12, title:"나만의 프로젝트", summary:"템플릿 · 작업 순서 · 아이디어", blocks:[
      {p:"이제 재료는 모두 갖췄습니다. 아래 템플릿은 지금까지 배운 함수와 **좌표 → 형태 → 색** 구조, 파라미터 3개가 들어 있는 출발점입니다. `scene()` 함수만 고쳐도 작품이 됩니다."},
      {code:TEMPLATE, title:"프로젝트 템플릿", start:true},
      {heading:"작업 순서"},
      {steps:["**한 문장으로 정하기** — \"녹아 붙는 용암 덩어리\", \"째깍거리는 시계\"처럼 결과를 먼저 말로.",
        "**형태부터** — 색은 흑백으로 두고 `scene()`의 거리 함수만 만듭니다. 막히면 4단계의 등고선 시각화를 붙이세요.",
        "**움직임** — `t`의 함수로 위치·회전·크기를 바꿉니다.",
        "**색과 빛** — 팔레트, 레이어, 글로우, 톤 매핑 순서로.",
        "**조절값 빼기** — 자꾸 고치는 숫자는 `@range` 파라미터로.",
        "**보관** — 편집기 도구의 **전체 프로젝트 저장(Pack)**으로 파일을 남기고, 툴바 카메라 아이콘으로 스크린샷."]},
      {heading:"아이디어와 필요한 단계"},
      {table:{head:["프로젝트","핵심 기법","단계"], rows:[
        ["아날로그 시계","상자 SDF + 회전 + 시간","4 · 5"],
        ["용암 램프","smin으로 녹는 원 + 노이즈 배경","4 · 5 · 8"],
        ["별이 흐르는 밤","타일 반복 + 해시 + 글로우","6 · 7"],
        ["만화경","극좌표 `atan`·`length` + 각도 접기","3 · 6"],
        ["물결 시뮬레이션","버퍼 2장 + 파동 방정식(RGBA16F)","10"],
        ["나만의 세포 자동자","생명 게임 규칙 바꾸기","10"]]}},
      {list:["**코드 조각 모음**에 SDF·노이즈·색 함수가 범주별로 정리되어 있습니다. 필요한 함수가 의존 함수와 함께 삽입됩니다.",
        "**예제 갤러리**의 작품 코드를 열어 이 과정에서 배운 기법이 어디에 쓰였는지 찾아보세요."]},
      {actions:[{label:"코드 조각 모음", run:"topic:snippets"}, {label:"예제 갤러리", run:"gallery"}, {label:"과정 안내로 돌아가기", run:"topic:course"}]}]}
  ];

  export {LESSONS, PROJECTS};
