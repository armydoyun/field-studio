// "기법 배우기"의 3D 레이마칭 예제: 궤도 카메라 · 유리 굴절 · 반사 재질 · 키보드 탐험.
// 모두 FIELD Studio를 위해 새로 짠 교육용 코드다. 셰이더마다 머리말에 "읽는 순서"와 원리를 적고,
// 단계별 중간 결과를 볼 수 있는 보기(uView)를 둔다. 파라미터는 셰이더의 @어노테이션에만 적는다(갤러리가 소스에서 읽는다).
//
// 공통 구조: Buffer A가 지난 프레임의 자기 자신(previous)을 읽어 카메라·플레이어 상태를 몇 픽셀에 저장하고,
// Image가 그 픽셀을 texelFetch로 읽어 장면을 그린다. 상태 버퍼는 rgba32f여야 한다(반정밀도면 위치가 반올림돼 흔들린다).
// Image는 상태가 비어 있으면(첫 프레임 · 갤러리 썸네일) 기본 시점을 쓰므로 버퍼 없이도 그림이 나온다.

// ---------------------------------------------------------------------------
// 공통: 궤도 카메라 상태 버퍼(Buffer A) — 궤도 카메라 · 유리 · 반사 재질 예제가 함께 쓴다
// ---------------------------------------------------------------------------
// home: 처음 시점(방위각, 높이각, 거리). Image의 기본 시점과 같아야 하므로 JS에서 한곳에 적고 두 셰이더에 넣는다.
const orbitBuffer = ({ home, pitch = [-0.2, 1.45], distance = [1.6, 30] }) => `#version 300 es
precision highp float;
// Buffer A · 카메라 상태 · RGBA32F · 3×1 픽셀. iChannel0 = A (previous, 지난 프레임의 나), iChannel1 = 키보드
// 셰이더는 프레임마다 처음부터 다시 실행되므로 "지난 프레임의 값"을 스스로 기억하지 못한다.
// 그래서 작은 버퍼에 상태를 써 두고, 다음 프레임에 그 버퍼(previous)를 읽어 이어서 고친다.
//
//   픽셀 0: (방위각 yaw, 높이각 pitch, 거리, 0)        ← Image가 읽는 카메라
//   픽셀 1: (yaw 속도, pitch 속도, 지난 휠 값, 0)      ← 관성 · 휠 변화량 계산용
//   픽셀 2: (지난 마우스 x, y, 누르고 있었나, 0)        ← 드래그 이동량 계산용
//
// 조작(뷰포트를 클릭한 뒤): 끌기 = 회전 · 휠 = 확대/축소 · A·D/←→ 회전 · ↑↓ 높이 · W·S 확대/축소 · Shift 빠르게 · R 처음 시점
uniform vec2 uResolution;   // 이 버퍼의 크기(3×1). 마우스 좌표를 0~1로 바꿀 때 쓴다
uniform float uDeltaTime;
uniform int uFrame;
uniform vec4 uMouse;        // xy = 마우스 위치(이 버퍼의 픽셀 단위), z > 0 = 버튼을 누르고 있음
uniform float uWheel;       // 뷰포트에서 굴린 휠의 누적 칸 수(위로 +1)
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform float uDragSpeed;   // 드래그 감도(화면 너비를 끌면 몇 바퀴) · @range 0.2 3 @step 0.01 @default 1 @group 카메라
uniform float uInertia;     // 놓은 뒤 미끄러지는 정도(0 = 바로 멈춤) · @range 0 1 @step 0.01 @default 0.8 @group 카메라

const vec3 HOME = vec3(${home.join(", ")});
const float TAU = 6.2831853;
// 키보드 텍스처: x = 키 코드, y = 0 지금 누름 · 1 이번 프레임에 눌림
const int KEY_SHIFT = 16, KEY_LEFT = 37, KEY_UP = 38, KEY_RIGHT = 39, KEY_DOWN = 40;
const int KEY_A = 65, KEY_D = 68, KEY_R = 82, KEY_S = 83, KEY_W = 87;
float keyDown(int k)    { return texelFetch(iChannel1, ivec2(k, 0), 0).x; }
float keyPressed(int k) { return texelFetch(iChannel1, ivec2(k, 1), 0).x; }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    int pixel = int(fragCoord.x);
    vec4 camera = texelFetch(iChannel0, ivec2(0, 0), 0);
    vec4 motion = texelFetch(iChannel0, ivec2(1, 0), 0);
    vec4 last   = texelFetch(iChannel0, ivec2(2, 0), 0);
    // 프레임 간격은 상한을 둔다: 탭을 오래 비웠다 돌아오면 큰 값이 한 번 들어와 카메라가 튄다.
    float dt = clamp(uDeltaTime, 0.0, 0.05);
    vec2 mouse = uMouse.xy / uResolution;   // 0~1 (화면 전체 기준)
    bool down = uMouse.z > 0.0;

    // 0) 첫 프레임 · 비어 있음 · R: 처음 시점. 휠 값은 "지금 값"을 기준점으로 삼는다(누적값을 그대로 쓰면 튄다).
    if (uFrame == 0 || camera.z <= 0.0 || keyPressed(KEY_R) > 0.5) {
        camera = vec4(HOME, 0.0);
        motion = vec4(0.0, 0.0, uWheel, 0.0);
        last = vec4(mouse, 0.0, 0.0);
    }
    vec2 velocity = motion.xy;

    // 1) 끌기: "직전 프레임에도 누르고 있었으면" 그 사이 마우스 이동량만큼 돌린다.
    //    절대 위치(마우스 x → 각도)로 정하면 누르는 순간 시점이 그 위치로 튀므로, 반드시 이동량(차이)을 쓴다.
    //    부호: 오른쪽으로 끌면 장면이 오른쪽으로 따라 돈다(손으로 잡고 돌리는 느낌) → 방위각을 줄인다.
    if (down && last.z > 0.5) {
        vec2 delta = (mouse - last.xy) * vec2(-TAU, -0.5 * TAU) * uDragSpeed;
        camera.xy += delta;
        // 놓는 순간의 속도를 관성으로 쓰기 위해 각속도를 부드럽게(지수 평균) 기록한다.
        velocity = mix(velocity, delta / max(dt, 1e-3), 0.5);
    } else if (down) {
        velocity = vec2(0.0);   // 막 눌렀다: 미끄러지던 카메라를 붙잡는다
    } else {
        // 2) 관성: 놓은 뒤에도 속도만큼 계속 돌고, 속도는 시간에 따라 지수적으로 준다.
        //    exp(-k·dt)를 쓰면 프레임률이 달라도(30fps · 144fps) 같은 시간에 같은 만큼 멈춘다.
        camera.xy += velocity * dt;
        float damping = mix(40.0, 1.2, uInertia);
        velocity *= exp(-damping * dt);
    }

    // 3) 키보드: 누르고 있는 동안 초당 일정한 속도로(dt를 곱해 프레임률과 무관하게).
    float fast = keyDown(KEY_SHIFT) > 0.5 ? 3.0 : 1.0;
    float turn = max(keyDown(KEY_A), keyDown(KEY_LEFT)) - max(keyDown(KEY_D), keyDown(KEY_RIGHT));
    camera.x += turn * 1.4 * fast * dt;
    camera.y += (keyDown(KEY_UP) - keyDown(KEY_DOWN)) * 1.0 * fast * dt;

    // 4) 확대·축소: 거리에 곱하는 방식(지수)이라 가까이서도 멀리서도 같은 "비율"로 다가간다.
    //    휠은 누적값이므로 지난 프레임과의 차이(이번에 굴린 칸 수)만 쓴다.
    float wheelSteps = uWheel - motion.z;
    float zoomKeys = keyDown(KEY_S) - keyDown(KEY_W);
    camera.z *= exp(zoomKeys * 1.4 * fast * dt - wheelSteps * 0.12);

    // 5) 범위: 방위각은 한 바퀴로 감고(값이 끝없이 커지면 정밀도가 떨어진다), 높이각은 머리 위·바닥 아래로 넘지 않게.
    camera.x = mod(camera.x, TAU);
    if (camera.y < ${pitch[0].toFixed(2)} || camera.y > ${pitch[1].toFixed(2)}) velocity.y = 0.0;   // 끝에 닿으면 그 방향 관성은 버린다
    camera.y = clamp(camera.y, ${pitch[0].toFixed(2)}, ${pitch[1].toFixed(2)});
    camera.z = clamp(camera.z, ${distance[0].toFixed(1)}, ${distance[1].toFixed(1)});

    fragColor = pixel == 0 ? camera
              : pixel == 1 ? vec4(velocity, uWheel, 0.0)
              :              vec4(mouse, down ? 1.0 : 0.0, 0.0);
}`;

// 카메라 수학: 구면 좌표 → 위치, 바라보기 행렬. 궤도 카메라와 키보드 탐험(플레이어를 따라가는 카메라)이 함께 쓴다.
const CAMERA_MATH = `// 구면 좌표 → 카메라 위치: 목표점을 중심으로 반지름(거리)인 구 위의 한 점.
//   방위각 = 바닥에서 돈 각도(y축 둘레), 높이각 = 바닥에서 올려다본 각도.
vec3 orbitPosition(vec3 orbit, vec3 target) {
    float yaw = orbit.x, pitch = orbit.y, dist = orbit.z;
    return target + dist * vec3(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
}
// 바라보기 행렬: 앞(목표 쪽) · 오른쪽 · 위 세 축. 화면 좌표(uv)를 이 축들로 펼치면 광선 방향이 된다.
mat3 lookAt(vec3 eye, vec3 target) {
    vec3 forward = normalize(target - eye);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, forward);
    return mat3(right, up, forward);
}`;
// Image 쪽 카메라 함수. 상태가 비어 있으면(썸네일 · 첫 프레임) HOME을 쓴다.
const orbitCamera = home => `// ---- 카메라: Buffer A(iChannel0) 픽셀 0 = (방위각, 높이각, 거리) ----
vec3 readOrbit() {
    vec3 c = texelFetch(iChannel0, ivec2(0, 0), 0).xyz;
    return c.z > 0.0 ? c : vec3(${home.join(", ")});
}
${CAMERA_MATH}`;

const orbitPass = home => ({
  name: "A",
  fragment: orbitBuffer({ home }),
  format: "rgba32f",
  scale: 1,
  size: [3, 1],
  filter: "nearest",
  channels: { 0: { buffer: "A", frame: "previous" }, 1: { keyboard: true } },
});
const orbitProject = (image, home) => ({
  image,
  passes: [orbitPass(home)],
  imageChannels: { 0: { buffer: "A", frame: "current" } },
});

// 공통 SDF 도형(모두 원점 중심의 로컬 좌표 p).
const SHAPES = `// ---- SDF 도형: 점 p에서 표면까지의 최단 거리(안쪽이면 음수) ----
float sdSphere(vec3 p, float r) { return length(p) - r; }
float sdBox(vec3 p, vec3 b) {                       // b = 반쪽 크기
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
float sdRoundBox(vec3 p, vec3 b, float r) { return sdBox(p, b - r) - r; }
float sdTorus(vec3 p, vec2 t) {                     // t.x = 큰 반지름, t.y = 굵기
    return length(vec2(length(p.xz) - t.x, p.y)) - t.y;
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
    vec3 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)) - r;
}
float sdCylinder(vec3 p, float r, float h) {        // y축 방향, h = 반쪽 높이
    vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }`;

// ---------------------------------------------------------------------------
// 1. 궤도 카메라
// ---------------------------------------------------------------------------
const ORBIT_HOME = [0.75, 0.42, 7.5];
const orbitImage = `#version 300 es
precision highp float;
// Image · 장면 그리기. iChannel0 = A (current, 카메라 상태)
// 궤도 카메라 — 마우스로 "끌어서" 시점을 돌리고, 놓으면 관성으로 미끄러지는 3D 카메라.
//
// 읽는 순서:
//  1. Buffer A        → 카메라 상태를 픽셀 3개에 저장하고 프레임마다 고친다. 끌기 · 관성 · 휠 · 키보드가 모두 여기 있다.
//  2. readOrbit       → (방위각, 높이각, 거리)를 읽는다. 버퍼가 비어 있으면 처음 시점.
//  3. orbitPosition   → 구면 좌표로 카메라 위치를 정한다. 목표점(흰 공) 둘레의 구 위를 움직인다.
//  4. lookAt          → 카메라가 목표점을 보도록 앞 · 오른쪽 · 위 축을 만든다.
//  5. mainImage       → 화면 좌표마다 광선을 쏘아(레이마칭) 장면을 그리고, 오른쪽 위에 위에서 본 지도를 겹친다.
// 지도에서 흰 점 = 목표점, 노란 점 = 카메라, 노란 부채꼴 = 보는 방향과 화각이다. 끌면서 지도를 함께 보자.
// 조작(뷰포트를 클릭한 뒤): 끌기 = 회전 · 휠 = 확대/축소 · A·D/←→ · ↑↓ · W·S · Shift · R(처음 시점)
uniform vec2 uResolution;
uniform float uTime;
uniform sampler2D iChannel0;
uniform float uFocal;   // 초점 거리(클수록 망원, 좁게 보인다) · @range 0.8 3.5 @step 0.01 @default 1.7 @group 카메라
uniform bool uMap;      // 오른쪽 위에 위에서 본 지도 · @default true @group 보기
uniform bool uAxes;     // 목표점에 x(빨강)·y(초록)·z(파랑) 축 표시 · @default true @group 보기

${orbitCamera(ORBIT_HOME)}

${SHAPES}

// ---- 장면: x = 거리, y = 재질 번호 ----
vec2 pick(vec2 a, vec2 b) { return a.x < b.x ? a : b; }   // 두 물체 중 가까운 쪽(합집합)
vec2 map(vec3 p) {
    vec2 res = vec2(p.y + 1.0, 1.0);                                              // 1 바닥(y = -1)
    res = pick(res, vec2(sdSphere(p - vec3(-2.2, 0.0, 0.4), 1.0), 2.0));        // 2 구
    res = pick(res, vec2(sdRoundBox(p - vec3(2.1, -0.25, -0.3), vec3(0.75), 0.12), 3.0)); // 3 상자
    vec3 q = p - vec3(0.2, -0.55, -2.6);
    q.xy *= rot(0.5);
    res = pick(res, vec2(sdTorus(q, vec2(0.9, 0.28)), 4.0));                    // 4 도넛
    res = pick(res, vec2(sdSphere(p, 0.09), 5.0));                                // 5 목표점
    if (uAxes) {
        res = pick(res, vec2(sdCapsule(p, vec3(0.0), vec3(0.8, 0.0, 0.0), 0.025), 6.0));
        res = pick(res, vec2(sdCapsule(p, vec3(0.0), vec3(0.0, 0.8, 0.0), 0.025), 7.0));
        res = pick(res, vec2(sdCapsule(p, vec3(0.0), vec3(0.0, 0.0, 0.8), 0.025), 8.0));
    }
    return res;
}
vec3 normalAt(vec3 p) {   // 거리의 기울기 = 표면의 바깥 방향
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.0008;
    return normalize(k.xyy * map(p + k.xyy * h).x + k.yyx * map(p + k.yyx * h).x +
                     k.yxy * map(p + k.yxy * h).x + k.xxx * map(p + k.xxx * h).x);
}
// 레이마칭: 거리만큼 성큼 걸어도 아무것도 뚫지 않는다(그 거리 안에는 표면이 없으니까).
vec2 march(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) {
        vec2 h = map(ro + rd * t);
        if (h.x < 0.001 * t) return vec2(t, h.y);   // 멀수록 허용 오차를 넓힌다(먼 곳은 한 픽셀이 크다)
        t += h.x;
        if (t > 60.0) break;
    }
    return vec2(-1.0);
}
// 부드러운 그림자: 빛 쪽으로 걸으며 "가장 아슬아슬하게 스친 정도"를 기록한다.
float softShadow(vec3 ro, vec3 rd) {
    float res = 1.0, t = 0.02;
    for (int i = 0; i < 48; i++) {
        float h = map(ro + rd * t).x;
        res = min(res, 10.0 * h / t);
        t += clamp(h, 0.02, 0.4);
        if (res < 0.002 || t > 12.0) break;
    }
    return clamp(res, 0.0, 1.0);
}
vec3 albedo(float id, vec3 p) {
    if (id == 1.0) {   // 바닥: 1칸 격자 + 원점을 지나는 굵은 선(x축 빨강, z축 파랑)
        vec2 g = abs(fract(p.xz + 0.5) - 0.5);
        float line = 1.0 - smoothstep(0.0, 0.03, min(g.x, g.y));
        vec3 col = mix(vec3(0.34, 0.36, 0.40), vec3(0.22, 0.24, 0.28), line);
        col = mix(col, vec3(0.75, 0.25, 0.22), 1.0 - smoothstep(0.02, 0.05, abs(p.z)));
        return mix(col, vec3(0.25, 0.40, 0.85), 1.0 - smoothstep(0.02, 0.05, abs(p.x)));
    }
    if (id == 2.0) return vec3(0.90, 0.45, 0.20);
    if (id == 3.0) return vec3(0.25, 0.60, 0.85);
    if (id == 4.0) return vec3(0.55, 0.80, 0.35);
    if (id == 5.0) return vec3(1.0);
    if (id == 6.0) return vec3(1.0, 0.15, 0.1);
    if (id == 7.0) return vec3(0.2, 0.9, 0.2);
    return vec3(0.2, 0.4, 1.0);
}
vec3 sky(vec3 rd) { return mix(vec3(0.55, 0.62, 0.72), vec3(0.20, 0.33, 0.55), clamp(rd.y * 1.5, 0.0, 1.0)); }
vec3 render(vec3 ro, vec3 rd) {
    vec2 hit = march(ro, rd);
    if (hit.x < 0.0) return sky(rd);
    vec3 p = ro + rd * hit.x, n = normalAt(p);
    vec3 sun = normalize(vec3(0.6, 0.9, 0.35));
    float diffuse = max(dot(n, sun), 0.0) * softShadow(p + n * 0.01, sun);
    float spec = pow(max(dot(reflect(rd, n), sun), 0.0), 40.0) * diffuse;
    vec3 col = albedo(hit.y, p) * (vec3(1.0, 0.95, 0.85) * diffuse + sky(n) * 0.45) + 0.3 * spec;
    if (hit.y >= 5.0) col = albedo(hit.y, p) * (0.6 + 0.4 * diffuse);   // 표시용 물체는 밝게
    return mix(col, sky(rd), 1.0 - exp(-0.0015 * hit.x * hit.x));        // 멀어질수록 하늘색(안개)
}

// ---- 위에서 본 지도: 2D 거리 함수로 그린다 ----
float segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
vec3 drawMap(vec3 col, vec2 frag, vec3 orbit, vec3 eye) {
    float size = 0.32 * uResolution.y, px = 30.0 / size;          // 지도 한 변 = 30칸(세계 단위)
    vec2 corner = vec2(uResolution.x - size - 0.02 * uResolution.y, uResolution.y - size - 0.11 * uResolution.y);   // 미리보기 도구 막대 아래
    vec2 m = (frag - corner) / size;                              // 지도 안 0~1
    if (any(lessThan(m, vec2(0.0))) || any(greaterThan(m, vec2(1.0)))) return col;
    vec2 w = (m - 0.5) * 30.0;                                    // 세계의 (x, z)
    w.y = -w.y;                                                   // 지도 위쪽 = -z(먼 쪽)
    vec3 c = vec3(0.07, 0.08, 0.10);
    vec2 g = abs(fract(w / 5.0 + 0.5) - 0.5) * 5.0;               // 5칸 격자
    c = mix(c, vec3(0.16, 0.18, 0.22), 1.0 - smoothstep(0.0, px, min(g.x, g.y)));
    float ring = abs(length(w) - length(eye.xz));                 // 카메라가 도는 원(거리 × cos 높이각)
    c = mix(c, vec3(0.45, 0.42, 0.30), 0.6 * (1.0 - smoothstep(0.0, px * 1.5, ring)));
    // 화각 부채꼴: 카메라에서 목표 쪽으로, 초점 거리에 맞는 반각만큼 벌린다.
    vec2 cam = eye.xz, dir = normalize(-cam);
    float halfAngle = atan(uResolution.x / uResolution.y / uFocal);
    vec2 to = w - cam;
    float inside = step(cos(halfAngle), dot(normalize(to), dir)) * step(length(to), 6.0);
    c = mix(c, vec3(1.0, 0.85, 0.3), 0.18 * inside);
    c = mix(c, vec3(1.0, 0.85, 0.3), 1.0 - smoothstep(0.0, px * 1.5, segment(w, cam, cam + dir * 2.5)));
    c = mix(c, vec3(1.0, 0.85, 0.3), 1.0 - smoothstep(0.25, 0.25 + px * 2.0, length(w - cam)));   // 카메라
    c = mix(c, vec3(1.0), 1.0 - smoothstep(0.18, 0.18 + px * 2.0, length(w)));                     // 목표점
    float edge = min(min(m.x, m.y), min(1.0 - m.x, 1.0 - m.y)) * size;
    c = mix(c, vec3(0.35), 1.0 - smoothstep(0.0, 1.5, edge));
    return mix(col, c, 0.92);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (2.0 * fragCoord - uResolution) / uResolution.y;   // 세로 -1~1, 가운데 0
    vec3 target = vec3(0.0);
    vec3 orbit = readOrbit();
    vec3 eye = orbitPosition(orbit, target);
    vec3 rd = normalize(lookAt(eye, target) * vec3(uv, uFocal));      // z = 초점 거리(화각)
    vec3 col = render(eye, rd);
    col = pow(col, vec3(0.4545));                                       // 선형 → 화면(감마)
    if (uMap) col = drawMap(col, fragCoord, orbit, eye - target);
    fragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// 2. 유리 굴절
// ---------------------------------------------------------------------------
const GLASS_HOME = [0.55, 0.32, 6.2];
const glassImage = `#version 300 es
precision highp float;
// Image · 장면 그리기. iChannel0 = A (current, 카메라 상태 — 궤도 카메라 예제와 같은 버퍼)
// 유리 굴절 — 빛이 유리에 들어가 꺾이고, 안에서 튕기고, 다시 꺾여 나오는 길을 레이마칭으로 따라간다.
//
// 읽는 순서:
//  1. mainImage    → 처음 광선이 유리에 닿으면 shadeGlass, 아니면 불투명 장면(shadeScene).
//  2. fresnel      → 표면이 빛을 얼마나 "반사"하는지. 정면은 4%쯤, 스치듯 보면 거의 100%. 유리가 유리로 보이는 가장 큰 이유다.
//  3. shadeGlass   → 반사(겉면에서 튕긴 빛)와 굴절(안을 지나온 빛)을 프레넬 비율로 섞는다.
//  4. refractPath  → 들어갈 때 굴절 → 안에서 레이마칭(marchInside) → 나갈 면에서 다시 굴절.
//                    나가는 각도가 너무 비스듬하면 빠져나가지 못하고 안으로 튕긴다(내부 전반사). 그래서 반복문이다.
//                    안에서 지나온 길이만큼 색을 흡수한다(Beer–Lambert): 두꺼운 곳일수록 진하다.
//  5. 분산(uDispersion) → 빨강·초록·파랑의 굴절률을 조금씩 달리해 세 번 따라가면 가장자리에 무지개빛이 생긴다.
// uView로 반사만 · 굴절만 · 프레넬 · 지나온 두께를 따로 보자. 체커 바닥과 기둥이 유리 너머로 뒤집혀 보이는 것은 물리적으로 맞다.
//
// 흔한 실수: ① 들어갈 때 refract(rd, n, 1/IOR), 나갈 때 refract(rd, -n, IOR) — 비율과 법선 방향이 반대다.
//           ② refract가 vec3(0)을 주면(전반사) 그대로 쓰지 말고 reflect로 안에서 다시 걷는다.
//           ③ 표면에서 출발할 때 조금 밀어 내지 않으면 출발점에서 바로 다시 표면에 "닿아" 점무늬가 생긴다(OFFSET).
// 조작(뷰포트를 클릭한 뒤): 끌기 = 회전 · 휠 = 확대/축소 · R(처음 시점)
uniform vec2 uResolution;
uniform float uTime;
uniform sampler2D iChannel0;
uniform int uShape;          // 유리 모양 · @enum 구 둥근상자 도넛 팔면체 @default 0 @group 유리
uniform float uIOR;          // 굴절률(물 1.33 · 유리 1.5 · 다이아몬드 2.42) · @range 1 2.5 @step 0.01 @default 1.5 @group 유리
uniform float uDispersion;   // 분산(빨강~파랑 굴절률 차이, 0이면 끔) · @range 0 0.15 @step 0.001 @default 0.02 @group 유리
uniform vec3 uGlassTint;     // 유리 색(두꺼운 곳일수록 이 색으로 물든다) · @color @default 0.62 0.92 0.86 @group 유리
uniform float uDensity;      // 흡수 세기(0 = 완전히 맑음) · @range 0 4 @step 0.01 @default 0.8 @group 유리
uniform int uBounces;        // 안에서 튕길 수 있는 최대 횟수(내부 전반사) · @range 1 8 @step 1 @default 4 @group 유리
uniform float uSpin;         // 유리가 도는 속도 · @range 0 1 @step 0.01 @default 0.15 @group 유리
uniform int uView;           // 보기(▶: 차례로) · @enum 결과 반사만 굴절만 프레넬 두께 @default 0 @anim 2

${orbitCamera(GLASS_HOME)}

${SHAPES}
float sdOctahedron(vec3 p, float s) { p = abs(p); return (p.x + p.y + p.z - s) * 0.57735027; }

const float EPS = 0.001;      // 표면에 닿았다고 볼 거리
const float OFFSET = 0.004;   // 표면에서 다시 출발할 때 밀어 내는 거리(EPS의 몇 배)
const vec3 SUN = normalize(vec3(-0.5, 0.75, 0.45));

// ---- 장면은 둘로 나눈다: 유리(mapGlass)와 불투명한 나머지(mapScene) ----
// 유리 안을 걸을 때는 유리만, 유리를 나온 뒤에는 나머지만 보면 되므로 따로 두는 편이 빠르고 단순하다.
float mapGlass(vec3 p) {
    p.y -= 0.15;
    p.xz *= rot(uTime * uSpin);
    if (uShape == 1) return sdRoundBox(p, vec3(0.85), 0.18);
    if (uShape == 2) { p.yz *= rot(1.2); return sdTorus(p, vec2(0.85, 0.38)); }
    if (uShape == 3) return sdOctahedron(p, 1.35) - 0.03;   // 모서리를 아주 조금 둥글게(법선이 튀지 않게)
    return sdSphere(p, 1.05);
}
vec2 pick(vec2 a, vec2 b) { return a.x < b.x ? a : b; }
vec2 mapScene(vec3 p) {   // x = 거리, y = 재질: 1 바닥 · 2 기둥
    vec2 res = vec2(p.y + 1.0, 1.0);
    for (int i = 0; i < 5; i++) {   // 유리 뒤쪽에 반원으로 늘어선 줄무늬 기둥 — 굴절이 잘 보이게 하는 "배경"
        float a = 1.9 + float(i) * 0.62;
        vec3 q = p - vec3(3.4 * cos(a), 0.3, -3.4 * sin(a) + 0.6);
        res = pick(res, vec2(sdCylinder(q, 0.32, 1.3), 2.0 + float(i) * 0.1));
    }
    return res;
}
vec3 normalGlass(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    return normalize(k.xyy * mapGlass(p + k.xyy * EPS) + k.yyx * mapGlass(p + k.yyx * EPS) +
                     k.yxy * mapGlass(p + k.yxy * EPS) + k.xxx * mapGlass(p + k.xxx * EPS));
}
vec3 normalScene(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    return normalize(k.xyy * mapScene(p + k.xyy * EPS).x + k.yyx * mapScene(p + k.yyx * EPS).x +
                     k.yxy * mapScene(p + k.yxy * EPS).x + k.xxx * mapScene(p + k.xxx * EPS).x);
}
// 바깥 레이마칭: x = 거리(-1이면 못 맞힘), y = 재질(0이면 유리)
vec2 march(vec3 ro, vec3 rd, bool withGlass) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) {
        vec3 p = ro + rd * t;
        vec2 h = mapScene(p);
        if (withGlass) h = pick(h, vec2(mapGlass(p), 0.0));
        if (h.x < EPS) return vec2(t, h.y);
        t += h.x;
        if (t > 40.0) break;
    }
    return vec2(-1.0);
}
// 안쪽 레이마칭: 유리 안에서는 mapGlass가 음수다. 그래서 -mapGlass(= 안쪽 표면까지 거리)만큼 걷는다.
float marchInside(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 64; i++) {
        float d = -mapGlass(ro + rd * t);
        if (d < EPS) break;
        t += max(d, EPS);
        if (t > 6.0) break;
    }
    return t;
}

// ---- 하늘과 불투명 장면 ----
vec3 sky(vec3 rd) {
    vec3 col = mix(vec3(0.75, 0.80, 0.86), vec3(0.28, 0.45, 0.75), clamp(rd.y * 1.6, 0.0, 1.0));
    float sun = max(dot(rd, SUN), 0.0);
    return col + vec3(1.0, 0.85, 0.6) * (pow(sun, 600.0) * 40.0 + pow(sun, 12.0) * 0.25);   // 해(반사에 하이라이트로 비친다)
}
// 유리 그림자: 유리는 빛을 대부분 통과시키므로 완전히 가리지 않고 유리 색으로 옅게 물들인다(빛이 모이는 초선은 생략).
vec3 shadowAt(vec3 ro) {
    float res = 1.0, t = 0.02;
    for (int i = 0; i < 40; i++) {
        float h = mapScene(ro + SUN * t).x;
        res = min(res, 8.0 * h / t);
        t += clamp(h, 0.02, 0.5);
        if (res < 0.01 || t > 10.0) break;
    }
    float glass = 1.0;
    t = 0.02;
    for (int i = 0; i < 40; i++) {
        float h = mapGlass(ro + SUN * t);
        glass = min(glass, 8.0 * h / t);
        t += clamp(h, 0.02, 0.5);
        if (glass < 0.01 || t > 10.0) break;
    }
    vec3 through = mix(uGlassTint * 0.55, vec3(1.0), clamp(glass, 0.0, 1.0));
    return clamp(res, 0.0, 1.0) * through;
}
vec3 shadeScene(vec3 ro, vec3 rd) {
    vec2 hit = march(ro, rd, false);
    if (hit.x < 0.0) return sky(rd);
    vec3 p = ro + rd * hit.x, n = normalScene(p), base;
    if (hit.y < 1.5) {   // 체커 바닥: 굴절이 얼마나 휘는지 눈금처럼 보인다
        vec2 c = floor(p.xz * 1.5);
        base = mod(c.x + c.y, 2.0) < 1.0 ? vec3(0.85, 0.83, 0.78) : vec3(0.18, 0.2, 0.24);
    } else {             // 기둥: 기둥마다 다른 색 + 가로 줄무늬
        float i = (hit.y - 2.0) * 10.0;
        vec3 hue = 0.5 + 0.5 * cos(6.2831 * (i * 0.17 + vec3(0.0, 0.33, 0.67)));
        base = mix(hue, vec3(0.95), step(0.5, fract(p.y * 2.5)));
    }
    vec3 light = vec3(1.0, 0.92, 0.8) * max(dot(n, SUN), 0.0) * shadowAt(p + n * OFFSET) + sky(n) * 0.35;
    vec3 col = base * light;
    return mix(col, sky(rd), 1.0 - exp(-0.002 * hit.x * hit.x));
}

// ---- 유리 ----
// Schlick 근사. cosTheta = 표면과 광선 사이 각의 cos(정면 1, 스치면 0). F0 = 정면 반사율(IOR 1.5 → 0.04).
float fresnel(float cosTheta, float ior) {
    float f0 = pow((1.0 - ior) / (1.0 + ior), 2.0);
    return f0 + (1.0 - f0) * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}
// 굴절된 빛 한 줄기를 따라간다. 돌려주는 값: 나온 뒤 본 색 × 흡수. thickness = 안에서 지나온 길이.
vec3 refractPath(vec3 p, vec3 rd, vec3 n, float ior, out float thickness) {
    vec3 dir = refract(rd, n, 1.0 / ior);   // 공기(1) → 유리(ior): 비율 = 1 / ior, 법선은 바깥(광선 반대쪽)
    vec3 pos = p - n * OFFSET;              // 표면 바로 안쪽에서 출발
    vec3 absorb = (1.0 - uGlassTint) * uDensity;
    vec3 through = vec3(1.0);
    thickness = 0.0;
    for (int bounce = 0; bounce < 8; bounce++) {
        if (bounce >= uBounces) break;
        float t = marchInside(pos, dir);
        thickness += t;
        through *= exp(-absorb * t);        // Beer–Lambert: 지나온 길이에 지수적으로 흡수
        vec3 q = pos + dir * t;
        vec3 nq = normalGlass(q);           // 바깥을 향한 법선
        // 유리(ior) → 공기(1): 비율 = ior, 법선은 광선과 마주 보도록 안쪽(-nq)
        vec3 outDir = refract(dir, -nq, ior);
        if (dot(outDir, outDir) < 1e-6) {   // 내부 전반사: 빠져나갈 수 없는 각도 → 안으로 튕겨 다시 걷는다
            dir = reflect(dir, -nq);
            pos = q - nq * OFFSET;
            continue;
        }
        // 나가는 면에서도 일부는 안으로 반사된다(프레넬). 여기서는 나가는 몫(1 - F)만 따라간다.
        float leave = 1.0 - fresnel(dot(outDir, nq), ior);
        return through * leave * shadeScene(q + nq * OFFSET, outDir);
    }
    return through * sky(dir);              // 튕길 횟수를 다 썼다: 마지막 방향의 하늘로 채운다(검은 구멍 방지)
}
vec3 shadeGlass(vec3 p, vec3 rd, out float F, out vec3 reflection, out vec3 refraction, out float thickness) {
    vec3 n = normalGlass(p);
    F = fresnel(dot(-rd, n), uIOR);
    reflection = shadeScene(p + n * OFFSET, reflect(rd, n));   // 겉면에서 튕긴 빛(해가 비치면 하이라이트)
    if (uDispersion < 0.0005) {
        refraction = refractPath(p, rd, n, uIOR, thickness);
    } else {
        // 분산: 파장마다 굴절률이 달라 빨강은 덜, 파랑은 더 꺾인다. 채널마다 따로 따라가 그 채널만 쓴다.
        float tr, tg, tb;
        refraction = vec3(refractPath(p, rd, n, uIOR - uDispersion, tr).r,
                          refractPath(p, rd, n, uIOR, tg).g,
                          refractPath(p, rd, n, uIOR + uDispersion, tb).b);
        thickness = tg;
    }
    return mix(refraction, reflection, F);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (2.0 * fragCoord - uResolution) / uResolution.y;
    vec3 target = vec3(0.0, 0.1, 0.0);
    vec3 eye = orbitPosition(readOrbit(), target);
    vec3 rd = normalize(lookAt(eye, target) * vec3(uv, 1.9));

    vec2 hit = march(eye, rd, true);
    vec3 col;
    if (hit.x >= 0.0 && hit.y < 0.5) {
        float F, thickness;
        vec3 reflection, refraction;
        col = shadeGlass(eye + rd * hit.x, rd, F, reflection, refraction, thickness);
        if (uView == 1) col = reflection * F;
        else if (uView == 2) col = refraction * (1.0 - F);
        else if (uView == 3) col = vec3(F);
        else if (uView == 4) {
            // 두께: 파랑(얇음) → 노랑(두꺼움), 0.25마다 등고선. 구는 가장자리 빛도 안쪽으로 꺾여 들어가므로 생각보다 고르다.
            col = mix(vec3(0.05, 0.15, 0.6), vec3(1.0, 0.8, 0.25), clamp(thickness / 3.0, 0.0, 1.0));
            col *= 0.6 + 0.4 * smoothstep(0.0, 0.1, abs(fract(thickness * 4.0) - 0.5));
        }
    } else {
        col = shadeScene(eye, rd);
        if (uView > 0) col *= 0.25;   // 보기 모드에서는 유리만 눈에 띄게 배경을 어둡게
    }
    if (uView < 3) col = col / (1.0 + col);   // 톤 매핑: 해 하이라이트처럼 1을 넘는 밝기를 부드럽게 눌러 담는다(값을 보는 보기는 그대로)
    fragColor = vec4(pow(col, vec3(0.4545)), 1.0);
}`;

// ---------------------------------------------------------------------------
// 3. 반사 재질
// ---------------------------------------------------------------------------
const MATERIAL_HOME = [0.0, 0.3, 9.0];
const materialImage = `#version 300 es
precision highp float;
// Image · 장면 그리기. iChannel0 = A (current, 카메라 상태 — 궤도 카메라 예제와 같은 버퍼)
// 반사 재질 — 같은 모양(구)이라도 재질에 따라 빛을 돌려주는 방식이 다르다. 왼쪽부터:
//   진흙(거친 난반사) · 플라스틱(광택) · 거친 금속 · 거울 · 금 · 빛나는 공
//
// 읽는 순서:
//  1. material   → 재질 = 바탕색(albedo) · 거칠기(roughness) · 금속성(metallic) · 스스로 내는 빛(emission).
//                  금속은 바탕색으로 물든 반사만 하고 난반사가 없다. 비금속(플라스틱 · 바닥)은 정면 반사율이 4%뿐이다.
//  2. directLight→ 해 하나의 빛: 난반사(Lambert) + 하이라이트(GGX). 부드러운 그림자(softShadow)와 틈새 어둠(ambientOcclusion)을 곱한다.
//  3. render     → 반사를 반복문으로 따라간다. 표면에 닿을 때마다
//                    ① 그 표면이 직접 보여 주는 빛을 더하고
//                    ② 반사되는 몫(프레넬 F)만큼 "남은 빛(through)"을 줄인 뒤
//                    ③ 반사 방향으로 다시 레이마칭한다. 남은 빛이 거의 없거나 횟수를 다 쓰면 멈춘다.
//                  그래서 거울 속 금 공에 비친 거울…처럼 반사 속의 반사가 uBounces만큼 보인다.
//  4. 거칠기     → 실제 흐린 반사는 여러 방향으로 퍼진 광선의 평균이다(경로 추적 · 많은 샘플과 누적 버퍼가 필요).
//                  여기서는 근사: 거칠수록 반사 광선을 따라가는 몫을 줄이고, 그만큼 흐린 하늘(blurSky)로 채운다.
// uView로 법선 · 그림자 · 틈새 어둠 · 반사 횟수(0 회색 · 1 파랑 · 2 초록 · 3 노랑 · 4+ 빨강) · 반사만을 따로 보자.
// 빛나는 공은 주변을 비추지는 않지만 반사에는 보인다.
// 조작(뷰포트를 클릭한 뒤): 끌기 = 회전 · 휠 = 확대/축소 · R(처음 시점)
uniform vec2 uResolution;
uniform float uTime;
uniform sampler2D iChannel0;
uniform int uBounces;        // 반사를 따라가는 최대 횟수(0 = 반사 없음) · @range 0 5 @step 1 @default 3 @group 반사
uniform float uRoughScale;   // 모든 구의 거칠기 배율 · @range 0 2 @step 0.01 @default 1 @group 재질
uniform float uFloorRough;   // 바닥 거칠기(0 = 매끈한 바닥에 비친다) · @range 0 1 @step 0.01 @default 0.18 @group 재질
uniform vec3 uSunCol;        // 햇빛 색 · @color @default 1 0.93 0.82 @group 빛
uniform float uSunAngle;     // 해의 방위(천천히 돌려 하이라이트가 움직이는 것을 보자) · @range 0 6.283 @step 0.01 @default 2.2 @anim 20 @group 빛
uniform int uView;           // 보기(▶: 차례로) · @enum 결과 법선 그림자 틈새어둠 반사횟수 반사만 @default 0 @anim 2

${orbitCamera(MATERIAL_HOME)}

${SHAPES}

const float PI = 3.14159265;
const float OFFSET = 0.003;

struct Material { vec3 albedo; float roughness; float metallic; vec3 emission; };

vec2 pick(vec2 a, vec2 b) { return a.x < b.x ? a : b; }
vec3 spherePos(int i) { float x = -4.5 + float(i) * 1.8; return vec3(x, -0.3, -0.06 * x * x); }   // 살짝 휜 줄
vec2 map(vec3 p) {   // x = 거리, y = 재질: 1 바닥 · 10~15 구 · 20~ 기둥
    vec2 res = vec2(p.y + 1.0, 1.0);
    for (int i = 0; i < 6; i++) res = pick(res, vec2(sdSphere(p - spherePos(i), 0.7), 10.0 + float(i)));
    for (int i = 0; i < 8; i++) {   // 둘레의 색 기둥: 반사 속에 비칠 "주변 풍경"
        float a = float(i) * 0.785 + 0.39;
        res = pick(res, vec2(sdCylinder(p - vec3(13.0 * cos(a), 1.5, 13.0 * sin(a)), 0.7, 2.5), 20.0 + float(i)));
    }
    return res;
}
Material material(float id, vec3 p) {
    if (id < 1.5) {   // 바닥: 체커, 비금속, 약간 광택
        vec2 c = floor(p.xz);
        vec3 base = mod(c.x + c.y, 2.0) < 1.0 ? vec3(0.55, 0.52, 0.48) : vec3(0.12, 0.12, 0.13);
        return Material(base, uFloorRough, 0.0, vec3(0.0));
    }
    if (id >= 20.0) {   // 기둥: 기둥마다 다른 색, 스스로 조금 빛난다(어두운 쪽 반사에도 보이게)
        vec3 hue = 0.5 + 0.5 * cos(6.2831 * ((id - 20.0) * 0.125 + vec3(0.0, 0.33, 0.67)));
        return Material(hue, 0.6, 0.0, hue * 0.25);
    }
    int i = int(id - 10.0 + 0.5);
    float k = uRoughScale;
    if (i == 0) return Material(vec3(0.80, 0.74, 0.68), min(1.0 * k, 1.0), 0.0, vec3(0.0));   // 진흙
    if (i == 1) return Material(vec3(0.80, 0.10, 0.08), min(0.12 * k, 1.0), 0.0, vec3(0.0));  // 플라스틱
    if (i == 2) return Material(vec3(0.90, 0.90, 0.92), min(0.45 * k, 1.0), 1.0, vec3(0.0));  // 거친 금속
    if (i == 3) return Material(vec3(0.96, 0.96, 0.97), min(0.0 * k, 1.0), 1.0, vec3(0.0));   // 거울
    if (i == 4) return Material(vec3(1.00, 0.76, 0.33), min(0.08 * k, 1.0), 1.0, vec3(0.0));  // 금
    return Material(vec3(0.05), 0.3, 0.0, vec3(0.2, 1.6, 1.4));                               // 빛나는 공
}
vec3 normalAt(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.0008;
    return normalize(k.xyy * map(p + k.xyy * h).x + k.yyx * map(p + k.yyx * h).x +
                     k.yxy * map(p + k.yxy * h).x + k.xxx * map(p + k.xxx * h).x);
}
vec2 march(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) {
        vec2 h = map(ro + rd * t);
        if (h.x < 0.0008 * (1.0 + t)) return vec2(t, h.y);
        t += h.x;
        if (t > 50.0) break;
    }
    return vec2(-1.0);
}
float softShadow(vec3 ro, vec3 rd) {
    float res = 1.0, t = 0.02;
    for (int i = 0; i < 40; i++) {
        float h = map(ro + rd * t).x;
        res = min(res, 10.0 * h / t);
        t += clamp(h, 0.02, 0.5);
        if (res < 0.005 || t > 15.0) break;
    }
    return clamp(res, 0.0, 1.0);
}
// 틈새 어둠(AO): 법선 쪽으로 조금씩 나가며 "벽이 기대보다 가까운지" 본다. 구가 바닥에 닿는 곳이 어두워진다.
float ambientOcclusion(vec3 p, vec3 n) {
    float occ = 0.0, w = 1.0;
    for (int i = 1; i <= 5; i++) {
        float h = 0.04 * float(i * i);
        occ += (h - map(p + n * h).x) * w;
        w *= 0.6;
    }
    return clamp(1.0 - 2.5 * occ, 0.0, 1.0);
}
vec3 sunDir() { return normalize(vec3(cos(uSunAngle), 0.8, sin(uSunAngle))); }
vec3 sky(vec3 rd) {
    vec3 col = mix(vec3(0.62, 0.68, 0.76), vec3(0.18, 0.30, 0.55), clamp(rd.y * 1.4, 0.0, 1.0));
    col = mix(vec3(0.18, 0.17, 0.16), col, smoothstep(-0.05, 0.05, rd.y));   // 지평선 아래는 어두운 땅
    float s = max(dot(rd, sunDir()), 0.0);
    return col + uSunCol * pow(s, 900.0) * 60.0;   // 해 원반: 매끈한 반사에 작고 강한 점으로 비친다
}
// 흐린 하늘: 거칠수록 해 원반 대신 넓게 번진 빛과 하늘의 평균색에 가까워진다.
vec3 blurSky(vec3 rd, float roughness) {
    vec3 sharp = sky(rd);
    vec3 soft = mix(vec3(0.35, 0.38, 0.42), vec3(0.40, 0.50, 0.66), clamp(rd.y * 0.8 + 0.4, 0.0, 1.0))
              + uSunCol * pow(max(dot(rd, sunDir()), 0.0), 4.0) * 0.6;
    return mix(sharp, soft, smoothstep(0.0, 0.6, roughness));
}
// 해 하나의 직접광: 난반사 + GGX 하이라이트. F0 = 정면 반사율(비금속 4%, 금속은 바탕색).
vec3 directLight(Material m, vec3 n, vec3 v, float shadow, float specScale) {
    vec3 l = sunDir(), h = normalize(l + v);
    float NdotL = max(dot(n, l), 0.0), NdotH = max(dot(n, h), 0.0);
    vec3 f0 = mix(vec3(0.04), m.albedo, m.metallic);
    vec3 F = f0 + (1.0 - f0) * pow(1.0 - max(dot(h, v), 0.0), 5.0);
    float a = max(m.roughness * m.roughness, 0.003), a2 = a * a;
    float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * d * d);
    vec3 spec = D * F * 0.25 * specScale;                          // 가림 항(G)은 단순화
    vec3 diffuse = m.albedo * (1.0 - m.metallic) * (1.0 - F) / PI;
    return (diffuse * PI + spec) * NdotL * shadow * uSunCol * 2.2;
}

// 반사를 따라가며 색을 모은다. info = (첫 표면의 그림자, 틈새 어둠, 반사 횟수), firstOnly = 첫 표면이 직접 보인 몫.
vec3 render(vec3 ro, vec3 rd, out vec3 normal0, out vec3 info, out vec3 firstOnly) {
    vec3 col = vec3(0.0), through = vec3(1.0);
    normal0 = vec3(0.0);
    info = vec3(1.0, 1.0, 0.0);
    firstOnly = vec3(0.0);
    for (int bounce = 0; bounce <= 5; bounce++) {
        vec2 hit = march(ro, rd);
        if (hit.x < 0.0) { col += through * sky(rd); break; }
        vec3 p = ro + rd * hit.x, n = normalAt(p), v = -rd;
        Material m = material(hit.y, p);
        float shadow = softShadow(p + n * OFFSET, sunDir());
        float ao = ambientOcclusion(p, n);
        if (bounce == 0) { normal0 = n; info = vec3(shadow, ao, 0.0); }

        // 반사되는 비율: 금속은 바탕색으로 물들고, 비금속은 정면 4% → 스치면 100%(프레넬).
        vec3 f0 = mix(vec3(0.04), m.albedo, m.metallic);
        vec3 F = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, v), 0.0), 5.0);
        // 거칠기 근사: 매끈한 몫(sharp)만 반사 광선으로 따라가고, 나머지는 흐린 하늘로 채운다.
        float sharp = 1.0 - smoothstep(0.0, 0.35, m.roughness);
        bool last = bounce >= uBounces;
        if (last) sharp = 0.0;   // 더 따라가지 않을 때는 반사 전체를 흐린 하늘로(검게 끊기지 않게)

        // ① 이 표면이 직접 보여 주는 빛: 스스로 내는 빛 + 햇빛 + 하늘빛(난반사) + 따라가지 않는 반사 몫
        vec3 ambientDiffuse = m.albedo * (1.0 - m.metallic) * (1.0 - F) * blurSky(n, 1.0) * 0.6;
        vec3 here = m.emission
                  + directLight(m, n, v, shadow, 1.0 - sharp)          // 따라갈 매끈한 몫의 하이라이트는 반사 광선이 해를 직접 본다
                  + ambientDiffuse * ao
                  + F * (1.0 - sharp) * blurSky(reflect(rd, n), m.roughness) * ao;
        col += through * here;
        if (bounce == 0) firstOnly = here;

        // ② 반사로 넘길 몫이 거의 없으면 멈춘다(빛나는 공 · 진흙 · 마지막 반사).
        through *= F * sharp;
        if (last || max(through.r, max(through.g, through.b)) < 0.01) break;
        // ③ 반사 방향으로 다시 걷는다. 표면에서 조금 밀어 내고 출발한다.
        info.z = float(bounce + 1);
        ro = p + n * OFFSET;
        rd = reflect(rd, n);
    }
    return col;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (2.0 * fragCoord - uResolution) / uResolution.y;
    vec3 target = vec3(0.0, -0.2, -0.6);
    vec3 eye = orbitPosition(readOrbit(), target);
    vec3 rd = normalize(lookAt(eye, target) * vec3(uv, 2.0));

    vec3 n, info, firstOnly;
    vec3 col = render(eye, rd, n, info, firstOnly);
    if (uView == 1) col = n * 0.5 + 0.5;
    else if (uView == 2) col = vec3(info.x);
    else if (uView == 3) col = vec3(info.y);
    else if (uView == 4) {   // 반사 횟수: 0 회색 · 1 파랑 · 2 초록 · 3 노랑 · 4 이상 빨강
        col = info.z < 0.5 ? vec3(0.12) : info.z < 1.5 ? vec3(0.15, 0.35, 0.9) : info.z < 2.5 ? vec3(0.2, 0.75, 0.3)
            : info.z < 3.5 ? vec3(0.95, 0.8, 0.2) : vec3(0.9, 0.2, 0.15);
    }
    else if (uView == 5) col = max(col - firstOnly, 0.0);
    if (uView == 0 || uView == 5) col = col / (1.0 + col);   // 톤 매핑(해 하이라이트 · 빛나는 공처럼 1을 넘는 밝기)
    fragColor = vec4(pow(col, vec3(0.4545)), 1.0);
}`;

// ---------------------------------------------------------------------------
// 4. 키보드 탐험
// ---------------------------------------------------------------------------
const PLAYER_HOME = [0.0, 0.5, 6.0];
const FOLLOW_HOME = [0.0, 0.42, 7.0];
// 세계 SDF: Buffer A(충돌 계산)와 Image(그리기)가 "똑같은" 함수를 써야 보이는 벽과 부딪히는 벽이 일치한다.
// 그래서 Common 탭(project.common)에 한 번만 두고 두 패스가 같이 쓴다. 고칠 때도 한 곳만 고치면 된다.
const explorerCommon = `// 키보드 탐험 · Common: Buffer A(충돌)와 Image(그리기)가 똑같이 쓰는 세계. 모든 패스의 머리말 바로 뒤에 붙는다.
// 보이는 벽과 부딪히는 벽이 어긋나지 않도록 세계 SDF를 여기 한 곳에만 둔다. x = 거리, y = 재질
const float RADIUS = 0.5;   // 플레이어(공) 반지름
const vec3 HOME = vec3(${PLAYER_HOME.join(", ")});          // 처음 자리(R로 돌아간다)
const vec3 CAMERA_HOME = vec3(${FOLLOW_HOME.join(", ")});   // 처음 카메라(방위각, 높이각, 거리)
${SHAPES}
vec2 pick(vec2 a, vec2 b) { return a.x < b.x ? a : b; }
vec2 world(vec3 p) {
    vec2 res = vec2(p.y, 1.0);                                          // 1 바닥(y = 0)
    res = pick(res, vec2(22.0 - length(p.xz), 2.0));                    // 2 둥근 울타리: 원의 "안쪽"까지 거리
    for (int i = 0; i < 6; i++) {                                       // 3 계단: 한 칸 높이 0.35(점프 없이 오를 만큼 낮다)
        float h = 0.35 * float(i + 1);
        res = pick(res, vec2(sdBox(p - vec3(5.0 + float(i) * 1.1, 0.5 * h, -3.0), vec3(0.55, 0.5 * h, 1.4)), 3.0));
    }
    vec3 q = p - vec3(-6.5, 0.0, -5.0);                                 // 4 경사로: 상자를 기울여 땅에 반쯤 묻었다
    q.xy *= rot(-0.32);                                                 // 오른쪽(+x)으로 갈수록 높아진다
    res = pick(res, vec2(sdBox(q, vec3(4.0, 0.25, 1.5)), 4.0));
    for (int i = 0; i < 6; i++) {                                       // 5 기둥
        float a = float(i) * 1.0472 + 0.26;
        res = pick(res, vec2(sdCylinder(p - vec3(14.0 * cos(a), 3.0, 14.0 * sin(a)), 0.9, 3.0), 5.0));
    }
    for (int i = 0; i < 3; i++) {                                       // 6 떠 있는 발판(경사로 끝에서 점프로 건너기)
        vec3 c = vec3(0.8 + float(i) * 1.9, 1.4 + float(i) * 0.7, -5.2 - float(i) * 1.8);
        res = pick(res, vec2(sdBox(p - c, vec3(0.9, 0.18, 0.9)), 6.0));
    }
    return res;
}
vec3 worldNormal(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.001;
    return normalize(k.xyy * world(p + k.xyy * h).x + k.yyx * world(p + k.yyx * h).x +
                     k.yxy * world(p + k.yxy * h).x + k.xxx * world(p + k.xxx * h).x);
}`;
const explorerState = `#version 300 es
precision highp float;
// Buffer A · 플레이어와 카메라 상태 · RGBA32F · 4×1 픽셀. iChannel0 = A (previous, 지난 프레임의 나), iChannel1 = 키보드
// 셰이더는 매 프레임 처음부터 다시 실행되므로 위치를 "기억"하려면 버퍼에 써 두고 다음 프레임에 읽어야 한다.
// 이 버퍼는 픽셀 4개짜리 작은 메모장이다. 각 픽셀이 자기 몫만 계산하지 않고, 네 픽셀 모두 같은 계산을 한 뒤
// 자기 번호에 맞는 값을 내보낸다(계산이 서로 얽혀 있어 나눌 수 없으니까). 픽셀이 넷뿐이라 비용은 거의 없다.
//
//   픽셀 0: 플레이어 위치 xyz
//   픽셀 1: 속도 xyz, 땅에 서 있나(1/0)
//   픽셀 2: 카메라 (방위각, 높이각, 거리, 지난 휠 값)
//   픽셀 3: 지난 마우스 x, y, 누르고 있었나
//
// 한 프레임의 순서(물리 시뮬레이션의 기본형):
//  1. 카메라   → 끌기 · 휠 · Q/E로 플레이어 둘레를 돈다(궤도 카메라 예제와 같은 원리).
//  2. 입력     → W·A·S·D를 "카메라가 보는 방향" 기준의 이동 방향으로 바꾼다(앞 = 화면 안쪽).
//  3. 속도     → 원하는 속도 쪽으로 서서히 맞춘다(가속 · 감속). 공중에서는 조금만 바꿀 수 있다.
//  4. 점프·중력 → 서 있을 때 Space면 위로 튀고, 매 프레임 중력만큼 아래로 당긴다.
//  5. 이동·충돌 → 위치 += 속도 × 시간. 벽과 겹치면 SDF 법선 방향으로 밀어 내고, 벽을 파고드는 속도는 없앤다.
// 조작(뷰포트를 클릭한 뒤): W·A·S·D/방향키 = 이동 · Space = 점프 · Shift = 달리기 · 끌기 · Q/E = 카메라 돌리기 · 휠 = 거리 · R = 처음으로
uniform vec2 uResolution;   // 이 버퍼의 크기(4×1)
uniform float uDeltaTime;
uniform int uFrame;
uniform vec4 uMouse;        // xy = 마우스 위치(이 버퍼의 픽셀 단위), z > 0 = 누르고 있음
uniform float uWheel;       // 휠 누적 칸 수
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform float uSpeed;       // 걷는 속도(초당 칸) · @range 1 12 @step 0.1 @default 5 @group 움직임
uniform float uJump;        // 점프 세기(처음 위로 튀는 속도) · @range 0 15 @step 0.1 @default 7.5 @group 움직임
uniform float uGravity;     // 중력 · @range 2 40 @step 0.1 @default 20 @group 움직임
uniform float uGrip;        // 땅을 잡는 힘(작을수록 빙판처럼 미끄럽다) · @range 0.5 20 @step 0.1 @default 10 @group 움직임
// 세계(world · worldNormal · RADIUS)와 처음 자리(HOME · CAMERA_HOME)는 Common 탭에 있다 — Image와 같은 함수다.

const float TAU = 6.2831853;
const int KEY_SHIFT = 16, KEY_SPACE = 32, KEY_LEFT = 37, KEY_UP = 38, KEY_RIGHT = 39, KEY_DOWN = 40;
const int KEY_A = 65, KEY_D = 68, KEY_E = 69, KEY_Q = 81, KEY_R = 82, KEY_S = 83, KEY_W = 87;
float keyDown(int k)    { return texelFetch(iChannel1, ivec2(k, 0), 0).x; }
float keyPressed(int k) { return texelFetch(iChannel1, ivec2(k, 1), 0).x; }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    int pixel = int(fragCoord.x);
    vec4 s0 = texelFetch(iChannel0, ivec2(0, 0), 0);
    vec4 s1 = texelFetch(iChannel0, ivec2(1, 0), 0);
    vec4 cam = texelFetch(iChannel0, ivec2(2, 0), 0);
    vec4 last = texelFetch(iChannel0, ivec2(3, 0), 0);
    vec3 pos = s0.xyz, vel = s1.xyz;
    float onGround = s1.w;
    // 프레임 간격 상한: 한 프레임에 너무 멀리 움직이면 얇은 벽을 뚫고 지나갈 수 있다(터널링).
    float dt = clamp(uDeltaTime, 0.0, 1.0 / 30.0);
    vec2 mouse = uMouse.xy / uResolution;
    bool down = uMouse.z > 0.0;

    // 0) 처음 · 비어 있음 · R: 처음 자리로
    if (uFrame == 0 || cam.z <= 0.0 || keyPressed(KEY_R) > 0.5) {
        pos = HOME; vel = vec3(0.0); onGround = 0.0;
        cam = vec4(CAMERA_HOME, uWheel);
        last = vec4(mouse, 0.0, 0.0);
    }

    // 1) 카메라: 끌기(직전 프레임과의 마우스 이동량) · Q/E · 휠(이번에 굴린 칸 수)
    if (down && last.z > 0.5) cam.xy += (mouse - last.xy) * vec2(-TAU, -0.5 * TAU);
    cam.x += (keyDown(KEY_Q) - keyDown(KEY_E)) * 2.0 * dt;
    cam.z *= exp(-(uWheel - cam.w) * 0.12);
    cam.w = uWheel;
    cam.x = mod(cam.x, TAU);
    cam.y = clamp(cam.y, 0.05, 1.35);
    cam.z = clamp(cam.z, 2.5, 18.0);

    // 2) 입력 → 이동 방향. 카메라는 플레이어 "뒤"(방위각 쪽)에 있으니 앞 = 그 반대 방향이다.
    vec3 forward = vec3(-sin(cam.x), 0.0, -cos(cam.x));
    vec3 right = vec3(cos(cam.x), 0.0, -sin(cam.x));
    float f = max(keyDown(KEY_W), keyDown(KEY_UP)) - max(keyDown(KEY_S), keyDown(KEY_DOWN));
    float r = max(keyDown(KEY_D), keyDown(KEY_RIGHT)) - max(keyDown(KEY_A), keyDown(KEY_LEFT));
    vec3 wish = forward * f + right * r;
    if (dot(wish, wish) > 1.0) wish = normalize(wish);   // 대각선(W+D)이 더 빠르지 않게

    // 3) 속도: 목표 속도 쪽으로 지수적으로 다가간다(1 - exp(-k·dt): 프레임률과 무관하게 같은 느낌).
    float run = keyDown(KEY_SHIFT) > 0.5 ? 1.8 : 1.0;
    float grip = onGround > 0.5 ? uGrip : 1.5;           // 공중 제어는 약하게
    vel.xz = mix(vel.xz, wish.xz * uSpeed * run, 1.0 - exp(-grip * dt));

    // 4) 점프와 중력. 누르고 있으면 착지할 때마다 다시 뛴다.
    if (onGround > 0.5 && keyDown(KEY_SPACE) > 0.5) vel.y = uJump;
    vel.y -= uGravity * dt;

    // 5) 이동 → 충돌. SDF의 장점: 거리(겹친 정도)와 법선(밀어 낼 방향)을 바로 얻는다.
    pos += vel * dt;
    onGround = 0.0;
    for (int i = 0; i < 4; i++) {                        // 모서리처럼 두 벽에 동시에 닿으면 몇 번 반복해야 풀린다
        float d = world(pos).x;
        if (d >= RADIUS) break;
        vec3 n = worldNormal(pos);
        pos += n * (RADIUS - d);                          // 겹친 만큼 밀어 낸다
        float into = dot(vel, n);
        if (into < 0.0) vel -= n * into;                  // 벽 쪽 속도만 없앤다 → 벽을 따라 미끄러진다
        if (n.y > 0.6) onGround = 1.0;                    // 위를 향한 면(경사 약 53° 이하) = 딛고 설 수 있는 땅
    }
    // 땅에 겹치지 않고 딱 붙어 있을 때도 서 있는 것으로 본다(발밑을 살짝 확인). 없으면 점프가 가끔 안 먹는다.
    if (onGround < 0.5 && vel.y <= 0.0 && world(pos - vec3(0.0, 0.06, 0.0)).x < RADIUS && worldNormal(pos).y > 0.6)
        onGround = 1.0;
    if (pos.y < -20.0) { pos = HOME; vel = vec3(0.0); }   // 세상 밖으로 떨어지면 처음 자리로

    fragColor = pixel == 0 ? vec4(pos, 0.0)
              : pixel == 1 ? vec4(vel, onGround)
              : pixel == 2 ? cam
              :              vec4(mouse, down ? 1.0 : 0.0, 0.0);
}`;
const explorerImage = `#version 300 es
precision highp float;
// Image · 장면 그리기. iChannel0 = A (current, 플레이어 · 카메라 상태)
// 키보드 탐험 — 키보드로 공을 굴려 3D 세계를 돌아다닌다. 위치 · 속도 · 카메라는 Buffer A가 기억한다.
//
// 읽는 순서:
//  1. Buffer A     → 입력 · 물리 · 충돌. 이 예제의 핵심이다(머리말에 한 프레임의 순서가 있다).
//  2. Common(world) → 계단 · 경사로 · 떠 있는 발판 · 기둥 · 울타리. Buffer A와 같은 함수라 보이는 곳에 부딪힌다.
//  3. readState    → 플레이어 위치와 카메라를 읽는다. 비어 있으면(썸네일 · 첫 프레임) 처음 자리.
//  4. 카메라       → 플레이어 조금 위를 목표로 궤도 카메라를 둔다. 카메라와 플레이어 사이에 벽이 있으면
//                    카메라를 벽 앞으로 당긴다(uCameraCollide: 3인칭 게임의 기본 기법).
//  5. 공           → 지나온 거리만큼 무늬를 돌려 굴러가는 것처럼 보이게 한다.
// 조작(뷰포트를 클릭한 뒤): W·A·S·D/방향키 = 이동 · Space = 점프 · Shift = 달리기 · 끌기 · Q/E = 카메라 · 휠 = 거리 · R = 처음으로
uniform vec2 uResolution;
uniform float uTime;
uniform sampler2D iChannel0;
uniform vec3 uBallColor;      // 공 색 · @color @default 1 0.42 0.18 @group 보기
uniform bool uCameraCollide;  // 벽이 가리면 카메라를 앞으로 당기기 · @default true @group 카메라
uniform float uFocal;         // 초점 거리(클수록 망원) · @range 0.8 3 @step 0.01 @default 1.5 @group 카메라
// 세계(world · RADIUS · HOME)는 Common 탭에 있다.

${CAMERA_MATH}

const vec3 SUN = normalize(vec3(0.55, 0.8, 0.3));
vec3 player;                  // mainImage에서 읽어 두고 map이 쓴다

vec2 map(vec3 p) { return pick(world(p), vec2(sdSphere(p - player, RADIUS), 10.0)); }
vec3 normalAt(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.001;
    return normalize(k.xyy * map(p + k.xyy * h).x + k.yyx * map(p + k.yyx * h).x +
                     k.yxy * map(p + k.yxy * h).x + k.xxx * map(p + k.xxx * h).x);
}
vec2 march(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 160; i++) {
        vec2 h = map(ro + rd * t);
        if (h.x < 0.001 * (1.0 + t)) return vec2(t, h.y);
        t += h.x;
        if (t > 80.0) break;
    }
    return vec2(-1.0);
}
// 카메라 충돌용: 목표점에서 카메라 쪽으로 걸어 처음 닿는 벽까지 거리(플레이어는 빼고 세계만).
float firstWall(vec3 ro, vec3 rd, float maxT) {
    float t = 0.0;
    for (int i = 0; i < 64; i++) {
        float h = world(ro + rd * t).x;
        if (h < 0.01) return t;
        t += h;
        if (t > maxT) break;
    }
    return maxT;
}
float softShadow(vec3 ro, vec3 rd) {
    float res = 1.0, t = 0.03;
    for (int i = 0; i < 48; i++) {
        float h = map(ro + rd * t).x;
        res = min(res, 10.0 * h / t);
        t += clamp(h, 0.03, 0.6);
        if (res < 0.005 || t > 20.0) break;
    }
    return clamp(res, 0.0, 1.0);
}
float ambientOcclusion(vec3 p, vec3 n) {
    float occ = 0.0, w = 1.0;
    for (int i = 1; i <= 4; i++) {
        float h = 0.06 * float(i * i);
        occ += (h - map(p + n * h).x) * w;
        w *= 0.6;
    }
    return clamp(1.0 - 2.0 * occ, 0.0, 1.0);
}
vec3 sky(vec3 rd) {
    vec3 col = mix(vec3(0.80, 0.82, 0.80), vec3(0.32, 0.52, 0.80), clamp(rd.y * 1.3, 0.0, 1.0));
    return col + vec3(1.0, 0.85, 0.6) * pow(max(dot(rd, SUN), 0.0), 300.0) * 6.0;
}
// 공의 무늬: 공 중심 기준 좌표를 "굴러간 각도"만큼 돌린다. x로 굴렀으면 z축 둘레, z로 굴렀으면 x축 둘레.
// (정확한 회전 누적은 쿼터니언을 버퍼에 저장해야 하지만, 위치만으로도 굴러가는 느낌은 충분히 난다.)
vec3 ballColor(vec3 p) {
    vec3 q = p - player;
    q.xy *= rot(player.x / RADIUS);
    q.yz *= rot(-player.z / RADIUS);
    float band = step(0.0, sin(atan(q.z, q.x) * 3.0));
    return mix(uBallColor, vec3(0.97), band * step(abs(q.y), 0.22));
}
vec3 albedo(float id, vec3 p) {
    if (id < 1.5) {   // 바닥 타일 + 흙빛 얼룩
        vec2 c = floor(p.xz / 2.0);
        vec3 tile = mod(c.x + c.y, 2.0) < 1.0 ? vec3(0.42, 0.55, 0.36) : vec3(0.36, 0.49, 0.31);
        return tile * (0.9 + 0.1 * sin(p.x * 0.7) * sin(p.z * 0.9));
    }
    if (id < 2.5) return vec3(0.55, 0.52, 0.48);                                   // 울타리
    if (id < 3.5) return mix(vec3(0.95, 0.65, 0.35), vec3(0.95, 0.45, 0.30), p.y / 2.1);   // 계단(높을수록 붉게)
    if (id < 4.5) return vec3(0.35, 0.55, 0.85);                                   // 경사로
    if (id < 5.5) return vec3(0.85, 0.85, 0.82) * (0.85 + 0.15 * step(0.5, fract(p.y * 1.5)));   // 기둥
    if (id < 6.5) return vec3(0.65, 0.45, 0.90);                                   // 발판
    return ballColor(p);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (2.0 * fragCoord - uResolution) / uResolution.y;
    // 상태 읽기: 카메라 거리(픽셀 2의 z)가 0이면 버퍼가 비어 있다 → 처음 자리.
    vec4 cam = texelFetch(iChannel0, ivec2(2, 0), 0);
    bool ready = cam.z > 0.0;
    player = ready ? texelFetch(iChannel0, ivec2(0, 0), 0).xyz : HOME;
    vec3 orbit = ready ? cam.xyz : CAMERA_HOME;

    vec3 target = player + vec3(0.0, 0.6, 0.0);           // 공보다 조금 위를 본다(앞이 더 보이게)
    vec3 eye = orbitPosition(orbit, target);
    if (uCameraCollide) {
        vec3 back = normalize(eye - target);
        float wall = firstWall(target, back, orbit.z);
        eye = target + back * max(wall - 0.3, 0.6);        // 벽 바로 앞(0.3)까지 당기되 공에 붙지는 않게
    }
    vec3 rd = normalize(lookAt(eye, target) * vec3(uv, uFocal));

    vec2 hit = march(eye, rd);
    vec3 col = sky(rd);
    if (hit.x >= 0.0) {
        vec3 p = eye + rd * hit.x, n = normalAt(p);
        vec3 base = albedo(hit.y, p);
        float shadow = softShadow(p + n * 0.01, SUN);
        float ao = ambientOcclusion(p, n);
        float diffuse = max(dot(n, SUN), 0.0) * shadow;
        vec3 light = vec3(1.0, 0.93, 0.82) * 1.6 * diffuse + sky(n) * 0.45 * ao;
        col = base * light;
        if (hit.y > 9.5) col += 0.35 * pow(max(dot(reflect(rd, n), SUN), 0.0), 60.0) * shadow;   // 공 하이라이트
        col = mix(col, sky(rd), 1.0 - exp(-0.0006 * hit.x * hit.x));   // 먼 곳은 하늘색으로(공기 원근)
    }
    fragColor = vec4(pow(col, vec3(0.4545)), 1.0);
}`;
const explorerProject = () => ({
  image: explorerImage,
  common: explorerCommon,
  passes: [
    {
      name: "A",
      fragment: explorerState,
      format: "rgba32f",
      scale: 1,
      size: [4, 1],
      filter: "nearest",
      channels: { 0: { buffer: "A", frame: "previous" }, 1: { keyboard: true } },
    },
  ],
  imageChannels: { 0: { buffer: "A", frame: "current" } },
});

// 갤러리 "기법 배우기" 카드. liveThumb: Image 셰이더를 버퍼 없이 그려 썸네일로 쓴다(상태가 비면 처음 시점을 그리므로).
const LESSONS = [
  {
    id: "orbit-camera",
    title: "Orbit Camera",
    tag: "3D · 드래그 · 관성 · 휠",
    description:
      "끌어서 시점을 돌리고, 놓으면 관성으로 미끄러지는 궤도 카메라. 위에서 본 지도로 카메라 위치를 함께 보세요.",
    liveThumb: true,
    project: orbitProject(orbitImage, ORBIT_HOME),
  },
  {
    id: "glass",
    title: "Glass Refraction",
    tag: "Refraction · Fresnel · 전반사",
    description:
      "유리에 들어가 꺾이고 안에서 튕겨 나오는 빛을 따라가기. 프레넬 · 내부 전반사 · 두께 흡수 · 분산을 보기별로 확인하세요.",
    liveThumb: true,
    project: orbitProject(glassImage, GLASS_HOME),
  },
  {
    id: "materials",
    title: "Reflective Materials",
    tag: "Reflection · Metal · Roughness",
    description: "진흙 · 플라스틱 · 거친 금속 · 거울 · 금 · 빛나는 공. 반사 속의 반사를 반복문으로 따라가는 재질 비교.",
    liveThumb: true,
    project: orbitProject(materialImage, MATERIAL_HOME),
  },
  {
    id: "explorer",
    title: "Keyboard Explorer",
    tag: "3D · 키보드 · 물리 · 상태 버퍼",
    description:
      "뷰포트를 클릭하고 WASD로 공을 굴려 계단 · 경사로 · 발판 오르기. 위치와 속도를 버퍼가 기억하고 SDF로 충돌합니다.",
    liveThumb: true,
    project: explorerProject(),
  },
];

export {
  LESSONS,
  orbitProject,
  orbitImage,
  ORBIT_HOME,
  glassImage,
  GLASS_HOME,
  materialImage,
  MATERIAL_HOME,
  explorerProject,
};
