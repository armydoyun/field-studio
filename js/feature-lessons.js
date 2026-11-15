// 기법 배우기 · 앱 기능 예제: 코드보다 FIELD Studio의 기능(파라미터 연결 · 타임라인 · 프리셋 · 이미지 · 웹캠 · 소리 입력)을
// 직접 만져 보게 하는 작은 프로젝트. 주석이 곧 설명서다. 갤러리(gallery.js)가 LESSONS를 기법 배우기 칸에 넣는다.
// project.presets · project.links는 예제를 열 때 함께 들어간다(studio.js replaceProject — 프리셋은 {name, values}만 적는다).

// ---- 1) Motion Links: 키프레임 · 흔들기(LFO) 연결과 프리셋 ----
const motion = `#version 300 es
precision highp float;
// 값을 코드가 아니라 "연결"이 움직인다. 파라미터 줄의 사슬 버튼이 파란 것은 연결이 값을 정하고 있다는 뜻이다.
//  · uBounce · uSquash = 키프레임 연결(1초 반복 · 처음으로 잇기). T로 타임라인을 열어 키를 끌거나, 키를 우클릭해 잇기를 바꿔 보세요.
//    올라갈 때는 '천천히 끝'(점점 느려짐), 떨어질 때는 '천천히 시작'(점점 빨라짐)이라 진짜 공처럼 튄다.
//  · uSwing = 흔들기(LFO) 연결. 사슬 버튼 → 연결 설정에서 모양(사인 · 삼각 · 톱니 · 사각)과 주기를 바꿔 보세요.
//  · 색(vec3)은 연결할 수 없는 대신 프리셋으로 바꾼다. 프리셋 칩(저녁 · 한낮 · 네온)을 눌러 보세요(전환 시간만큼 부드럽게).
uniform vec2 uResolution;
uniform float uBounce;  // 공의 높이(키프레임 연결) · @range 0 1 @step 0.001 @default 0 @group 움직임
uniform float uSquash;  // 착지할 때 눌림(키프레임 연결) · @range 0 0.5 @step 0.001 @default 0 @group 움직임
uniform float uSwing;   // 진자 각도(흔들기 연결) · @range -1 1 @step 0.001 @default 0 @group 움직임
uniform vec3 uSky;      // 하늘 · @color @default 0.07 0.08 0.14 @group 색(프리셋으로 바뀜)
uniform vec3 uGround;   // 바닥 · @color @default 0.16 0.12 0.2 @group 색(프리셋으로 바뀜)
uniform vec3 uBall;     // 공 · @color @default 1 0.45 0.25 @group 색(프리셋으로 바뀜)
uniform vec3 uBob;      // 진자 추 · @color @default 0.35 0.75 1 @group 색(프리셋으로 바뀜)
float fill(float d, float px) { return 1.0 - smoothstep(-px, px, d); }
float segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    float side = min(uResolution.x, uResolution.y), px = 1.5 / side;
    vec2 p = (2.0 * fragCoord - uResolution) / side;      // 짧은 변 기준 -1 ~ 1
    const float floorY = -0.7;
    vec3 col = mix(uSky * 0.6, uSky * 1.4, smoothstep(-1.0, 1.0, p.y));
    col = mix(col, uGround, fill(p.y - floorY, px));
    // 공: 높이 = 키프레임, 눌림 = 키프레임(가로로 퍼지고 세로로 줄어든다 — 부피를 지키는 느낌)
    float r = 0.18;
    vec2 scale = vec2(1.0 + uSquash, 1.0 - uSquash);
    vec2 center = vec2(-0.45, floorY + r * scale.y + uBounce * 0.95);
    float shadow = fill(length((p - vec2(center.x, floorY)) / vec2(r * (1.4 - 0.6 * uBounce), 0.035)) - 1.0, 0.08);
    col = mix(col, col * 0.45, shadow * (1.0 - 0.6 * uBounce));
    float ball = length((p - center) / scale) - r;
    col = mix(col, uBall * (0.75 + 0.35 * dot(normalize(vec3(p - center, 0.15)), normalize(vec3(-0.5, 0.7, 0.6)))), fill(ball, px));
    // 진자: 각도 = 흔들기(LFO). -1 ~ 1을 ±40도로 옮긴다.
    vec2 pivot = vec2(0.5, 0.85);
    float angle = uSwing * 0.7;
    vec2 bob = pivot + 1.05 * vec2(sin(angle), -cos(angle));
    col = mix(col, vec3(0.85), fill(segment(p, pivot, bob) - 0.008, px));
    col = mix(col, uBob, fill(length(p - bob) - 0.12, px));
    col = mix(col, vec3(0.9), fill(length(p - pivot) - 0.025, px));
    fragColor = vec4(col, 1.0);
}
`;
// 키: [시간, 값, 이 키에서 다음 키까지의 잇기]. 반복 1초 · 처음으로 잇기(wrap)라 마지막 키에서 다음 바퀴의 첫 키로 이어진다.
const motionLinks = [
  {
    name: "uBounce",
    source: "keys",
    min: 0,
    max: 1,
    smooth: 0,
    keys: [
      [0, 0, "out"],
      [0.5, 1, "in"],
    ],
    loop: 1,
    wrap: true,
    ease: "smooth",
  },
  {
    name: "uSquash",
    source: "keys",
    min: 0,
    max: 0.5,
    smooth: 0,
    keys: [
      [0, 0.3, "out"],
      [0.08, 0, "linear"],
      [0.92, 0, "in"],
    ],
    loop: 1,
    wrap: true,
    ease: "smooth",
  },
  { name: "uSwing", source: "lfo", min: -1, max: 1, smooth: 0, shape: "sine", period: 2.4, phase: 0 },
];
const motionPresets = [
  {
    name: "저녁",
    values: { uSky: [0.07, 0.08, 0.14], uGround: [0.16, 0.12, 0.2], uBall: [1, 0.45, 0.25], uBob: [0.35, 0.75, 1] },
  },
  {
    name: "한낮",
    values: { uSky: [0.45, 0.7, 0.95], uGround: [0.35, 0.55, 0.25], uBall: [0.95, 0.2, 0.25], uBob: [1, 0.85, 0.2] },
  },
  {
    name: "네온",
    values: { uSky: [0.02, 0.01, 0.05], uGround: [0.05, 0.02, 0.1], uBall: [1, 0.2, 0.8], uBob: [0.2, 1, 0.85] },
  },
];

// ---- 2) Image Filters: 이미지 · 웹캠 · 영상을 iChannel0로 받아 걸러 보기 ----
const imageFilters = `#version 300 es
precision highp float;
// 이미지 입력: 편집기(E)의 '입력' 줄에서 iChannel0 칩을 눌러 이미지를 고르거나(파일을 끌어다 놓아도 된다),
// 웹캠 · 영상 파일을 고르세요. 아무것도 연결하지 않으면 iChannelResolution[0]이 0이라 아래의 시험 화면을 대신 그린다.
// 필터는 모두 "주변 픽셀을 몇 개 읽어 섞는" 일이다. 텍셀 크기(1 / 이미지 크기)만큼 옮겨 이웃을 읽는다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform vec3 iChannelResolution[4];
uniform int uFilter;     // 필터 · @enum 원본 흑백 윤곽(소벨) 픽셀화 하프톤 색수차 포스터 @default 2 @group 필터
uniform float uAmount;   // 세기 · @range 0 1 @step 0.01 @default 1 @group 필터 @if uFilter != 원본
uniform float uCell;     // 칸 크기(px) · @range 2 48 @step 1 @default 10 @group 필터 @if uFilter == 픽셀화 || uFilter == 하프톤
uniform int uLevels;     // 색 단계 수 · @range 2 8 @default 4 @group 필터 @if uFilter == 포스터
uniform int uFit;        // 화면에 맞추기 · @enum 맞추기 채우기 @default 0 @group 보기
uniform bool uCompare;   // 왼쪽 절반은 원본으로 비교 · @default true @group 보기
// 시험 화면: 색 막대 · 회색 계단 · 원 · 가는 선(윤곽 · 색수차가 잘 보이게)
vec3 testCard(vec2 uv) {
    vec3 bars = 0.5 + 0.5 * cos(6.2831853 * (floor(uv.x * 7.0) / 7.0 + vec3(0.0, 0.33, 0.67)));
    vec3 col = uv.y > 0.55 ? bars : vec3(floor(uv.x * 8.0) / 7.0);
    vec2 c = (uv - 0.5) * vec2(1.6, 1.0);
    col = mix(col, vec3(0.95, 0.85, 0.3), step(length(c - vec2(0.25, -0.18)), 0.16));
    col = mix(col, vec3(0.1), step(abs(fract(length(c) * 10.0) - 0.5), 0.04) * step(length(c), 0.45));
    return col;
}
vec2 imageSize() { return iChannelResolution[0].x > 0.0 ? iChannelResolution[0].xy : vec2(640.0, 400.0); }
vec3 source(vec2 uv) {
    if (iChannelResolution[0].x <= 0.0) return testCard(uv);
    return texture(iChannel0, uv).rgb;
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 filtered(vec2 uv) {
    vec2 texel = 1.0 / imageSize();
    vec3 col = source(uv);
    if (uFilter == 1) return vec3(luma(col));
    if (uFilter == 2) {   // 소벨: 가로 · 세로 밝기 변화(기울기)의 크기 = 윤곽
        float g[9];
        for (int i = 0; i < 9; i++) g[i] = luma(source(uv + texel * vec2(i % 3 - 1, i / 3 - 1)));
        float gx = (g[2] + 2.0 * g[5] + g[8]) - (g[0] + 2.0 * g[3] + g[6]);
        float gy = (g[6] + 2.0 * g[7] + g[8]) - (g[0] + 2.0 * g[1] + g[2]);
        return vec3(length(vec2(gx, gy)));
    }
    if (uFilter == 3) {   // 픽셀화: 칸 가운데 한 점만 읽는다
        vec2 cell = uCell * texel;
        return source((floor(uv / cell) + 0.5) * cell);
    }
    if (uFilter == 4) {   // 하프톤: 칸마다 밝기만큼 큰 점
        vec2 cell = uCell * texel, local = fract(uv / cell) - 0.5;
        float l = luma(source((floor(uv / cell) + 0.5) * cell));
        return vec3(step(length(local), 0.55 * sqrt(l)));
    }
    if (uFilter == 5) {   // 색수차: R · B를 가장자리 쪽으로 조금씩 밀어 읽는다
        vec2 shift = (uv - 0.5) * 0.015;
        return vec3(source(uv + shift).r, col.g, source(uv - shift).b);
    }
    if (uFilter == 6) return floor(col * float(uLevels) + 0.5) / float(uLevels);   // 포스터: 색을 몇 단계로
    return col;
}
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // 이미지 비율을 지키며 화면에 맞추기(남는 곳은 어둡게) · 채우기(넘치는 곳은 잘림)
    vec2 screen = fragCoord / uResolution, size = imageSize();
    float fit = uFit == 0 ? min(uResolution.x / size.x, uResolution.y / size.y) : max(uResolution.x / size.x, uResolution.y / size.y);
    vec2 uv = (fragCoord - 0.5 * uResolution) / (size * fit) + 0.5;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { fragColor = vec4(vec3(0.05), 1.0); return; }
    vec3 col = mix(source(uv), filtered(uv), uAmount);
    if (uCompare && screen.x < 0.5) col = source(uv);
    if (uCompare) col = mix(col, vec3(1.0, 0.55, 0.2), 1.0 - smoothstep(0.0, 1.5 / uResolution.x, abs(screen.x - 0.5)));
    fragColor = vec4(col, 1.0);
}
`;

// ---- 3) Audio Spectrum: 마이크 · 오디오 파일을 iChannel0로 읽기 + 소리 연결 ----
const audioSpectrum = `#version 300 es
precision highp float;
// 소리 입력: 편집기(E)의 '입력' 줄에서 iChannel0 칩 → 마이크(권한 필요) 또는 오디오 파일을 켜세요.
// 켜기 전에는 iChannelResolution[0]이 0이라 아래의 시험 신호로 그린다(화면 위쪽 가운데에 주황 점이 깜빡인다).
// 소리 텍스처는 512 × 2(Shadertoy와 같은 배치):
//   y = 0.25 줄 = 주파수별 크기(FFT, 왼쪽 = 낮은 음). 0 ~ 1
//   y = 0.75 줄 = 파형(0.5가 무음). 0 ~ 1
// 낮은 음일수록 칸이 촘촘하게 필요해 가로를 로그 눈금으로 읽는다(사람 귀도 로그로 듣는다).
// 코드 없이도 된다: uKick은 '소리 · 저음' 연결이라 사슬 버튼 → 연결 설정에서 대역(저음 · 중음 · 고음 · 음량)을 바꿀 수 있다.
uniform vec2 uResolution;
uniform float uTime;
uniform sampler2D iChannel0;
uniform vec3 iChannelResolution[4];
uniform int uStyle;     // 모양 · @enum 막대 원형 @default 0 @group 보기
uniform float uBars;    // 막대 수 · @range 16 128 @step 1 @default 64 @group 보기
uniform float uGain;    // 크기 배율 · @log @range 0.25 4 @default 1 @group 보기
uniform bool uLog;      // 로그 눈금(낮은 음을 넓게) · @default true @group 보기
uniform float uKick;    // 저음에 맞춰 커지는 원(소리 연결) · @range 0 1 @step 0.001 @default 0 @group 소리 연결
uniform sampler2D uColors; // 낮은 음 → 높은 음 색 · @gradient @default 0 #ff3d7f 0.5 #ffc93d 1 #3df2ff @group 보기
float fill(float d, float px) { return 1.0 - smoothstep(-px, px, d); }
bool live() { return iChannelResolution[0].x > 0.0; }
// 0 ~ 1 위치(낮은 음 → 높은 음)의 크기. 입력이 없으면 시간에 따라 움직이는 시험 신호.
float spectrum(float x) {
    if (uLog) x = (exp2(x * 8.0) - 1.0) / 255.0;      // 로그 눈금: 왼쪽 절반에 낮은 음 대역을 넓게 편다
    if (live()) return texture(iChannel0, vec2(x, 0.25)).r;
    float beat = exp(-6.0 * fract(uTime * 2.0));
    return clamp(0.85 * exp(-x * 9.0) * (0.4 + 0.6 * beat) + 0.25 * (0.5 + 0.5 * sin(x * 40.0 - uTime * 3.0)) * (1.0 - x), 0.0, 1.0);
}
float wave(float x) {
    if (live()) return texture(iChannel0, vec2(x, 0.75)).r - 0.5;
    return 0.25 * sin(x * 50.0 + uTime * 9.0) * sin(x * 7.0 - uTime * 2.0);
}
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / uResolution;
    float side = min(uResolution.x, uResolution.y), px = 1.5 / side;
    vec2 p = (2.0 * fragCoord - uResolution) / side;
    vec3 col = vec3(0.03, 0.03, 0.06);
    float kick = live() ? uKick : exp(-6.0 * fract(uTime * 2.0));   // 시험 신호일 때는 박자를 직접 만든다
    if (uStyle == 0) {
        // 막대: 칸 번호 → 그 칸 가운데의 크기
        float bar = floor(uv.x * uBars), x = (bar + 0.5) / uBars;
        float h = clamp(spectrum(x) * uGain, 0.0, 1.0) * 0.8;
        float inside = step(fract(uv.x * uBars), 0.8) * step(uv.y - 0.1, h) * step(0.1, uv.y);
        col = mix(col, texture(uColors, vec2(x, 0.5)).rgb * (0.6 + 0.6 * uv.y), inside);
    } else {
        // 원형: 각도 → 위치(좌우 대칭), 반지름 = 크기
        float a = abs(atan(p.x, p.y)) / 3.14159265, h = clamp(spectrum(a) * uGain, 0.0, 1.0);
        float ring = length(p) - (0.35 + 0.5 * h);
        col = mix(col, texture(uColors, vec2(a, 0.5)).rgb, fill(ring, px) * step(0.3, length(p)));
    }
    // 파형: 화면 아래쪽 가는 선
    float w = wave(uv.x) * uGain;
    col = mix(col, vec3(0.9), 1.0 - smoothstep(0.0, 2.0 / uResolution.y, abs(uv.y - 0.06 - w * 0.08)));
    // 저음 고리(uKick 연결): 저음이 세면 크고 밝게 퍼진다
    float ring = abs(length(p - vec2(0.0, 0.2)) - 0.12 - 0.3 * kick);
    col += vec3(1.0, 0.35, 0.55) * kick * (1.0 - smoothstep(0.0, 0.025 + 0.02 * kick, ring));
    // 시험 신호일 때 위쪽 가운데에 깜빡이는 점
    if (!live()) col = mix(col, vec3(1.0, 0.55, 0.2), (1.0 - smoothstep(6.0, 7.5, length(fragCoord - vec2(0.5 * uResolution.x, uResolution.y - 18.0)))) * step(0.5, fract(uTime)));
    fragColor = vec4(col, 1.0);
}
`;
const audioLinks = [{ name: "uKick", source: "audio", band: "bass", min: 0, max: 1, smooth: 0.08 }];

const LESSONS = [
  {
    id: "motion",
    title: "Motion Links",
    tag: "키프레임 · 흔들기 · 프리셋",
    description:
      "코드 대신 연결이 값을 움직입니다. 타임라인(T)에서 키를 끌고, 연결 설정에서 흔들기 주기를 바꾸고, 프리셋 칩으로 색을 바꿔 보세요.",
    image: motion,
    project: { image: motion, passes: [], imageChannels: {}, links: motionLinks, presets: motionPresets },
  },
  {
    id: "image-filters",
    title: "Image Filters",
    tag: "이미지 · 웹캠 입력 · 커널",
    description:
      "iChannel0에 내 이미지 · 웹캠 · 영상을 연결해 흑백 · 윤곽 · 픽셀화 · 하프톤 · 색수차 필터를 걸어 보세요. 연결 전에는 시험 화면을 씁니다.",
    image: imageFilters,
    project: { image: imageFilters, passes: [], imageChannels: {} },
  },
  {
    id: "audio",
    title: "Audio Spectrum",
    tag: "마이크 · 오디오 파일 · 소리 연결",
    description:
      "iChannel0에서 마이크나 오디오 파일을 켜면 주파수 막대와 파형이 소리에 맞춰 움직입니다. 저음 원은 코드 없이 '소리' 연결로 움직입니다.",
    image: audioSpectrum,
    project: {
      image: audioSpectrum,
      passes: [],
      imageChannels: { 0: { media: "mic" } },
      links: audioLinks,
    },
  },
];

export { LESSONS };
