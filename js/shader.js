// Shader Studio의 시작 화면에 사용할 기본 예제. 모든 GLSL을 한 곳에서 관리한다.
const vertex = `#version 300 es

void main() {
    // VBO 없이 세 정점으로 화면 전체를 덮는 Fullscreen Triangle.
    vec2 position = vec2(
        gl_VertexID == 1 ? 3.0 : -1.0,
        gl_VertexID == 2 ? 3.0 : -1.0
    );
    gl_Position = vec4(position, 0.0, 1.0);
}`;
const raymarch = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uDeltaTime;
uniform int uFrame;
uniform vec2 uMouse;
uniform bool uRMHeatmap;
// Buffer/Image 패스에서 동일하게 사용하는 입력 채널(최대 4개).
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform vec3 iChannelResolution[4];


// 고정 반복 상한: WebGL2 루프 최적화를 위한 안전 장치. 실제 반복 수는 uRMMaxSteps로 제한한다.
const int MAX_STEPS_CAP = 512;
uniform int uRMMaxSteps;
uniform float uRMMaxDistance;
uniform float uRMSurfaceEpsilon;
uniform float uRMNormalEpsilon;

// 재질 ID와 거리를 분리해 두면 장면이 커져도 raymarch 코드는 바꾸지 않아도 된다.
struct SDFResult {
    float dist;
    float id;
};

// --- SDF 도형 ---

// p는 도형 중심 기준의 로컬 좌표다.
float sdSphere(vec3 p, float radius) {
    return length(p) - radius;
}

// b: 직육면체의 반쪽 크기(half extents).
float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}


// --- 기본 장면 ---

SDFResult map(vec3 p) {
    // 구는 중심 (0,0,0), 반지름 1. 바닥은 y = -1 평면.
    float sphere = sdSphere(p, 1.0);
    float ground = p.y + 1.0;
    if(sphere < ground) return SDFResult(sphere, 2.0);
    return SDFResult(ground, 1.0);
}

vec3 getAlbedo(float id) {
    if(id == 2.0) return vec3(0.25, 0.57, 0.90);
    return vec3(0.43, 0.46, 0.51);
}


// --- Ray Marching ---

// rd는 정규화된 광선 방향. (t, id)를 반환하며 미스 시 (-1,-1).
vec2 rayMarch(vec3 ro, vec3 rd, out int steps, out bool limitReached) {
    float t = 0.0;
    steps = 0;
    limitReached = false;

    for(int i = 0; i < MAX_STEPS_CAP; i++) {
        if(i >= uRMMaxSteps) break;
        SDFResult result = map(ro + rd * t);
        steps = i + 1;
        if(result.dist < uRMSurfaceEpsilon) return vec2(t, result.id);
        t += result.dist;
        if(t > uRMMaxDistance) return vec2(-1.0);
    }

    limitReached = true;
    return vec2(-1.0);
}

// 정사면체 방향 4회 샘플링으로 표면 기울기(법선)를 근사한다.
vec3 calcNormal(vec3 p) {
    float h = uRMNormalEpsilon;
    const vec2 k = vec2(1.0, -1.0);
    return normalize(
        k.xyy * map(p + k.xyy * h).dist +
        k.yyx * map(p + k.yyx * h).dist +
        k.yxy * map(p + k.yxy * h).dist +
        k.xxx * map(p + k.xxx * h).dist
    );
}


// --- 카메라와 화면 출력 ---

// 카메라 상태는 Buffer A(iChannel0)가 키보드·마우스로 갱신해 저장한다: x = 방위각, y = 높이각, z = 거리.
vec3 readCamera() {
    vec3 camera = texelFetch(iChannel0, ivec2(0), 0).xyz;
    // Buffer A가 아직 없거나(썸네일 등) 비어 있으면 기본 시점을 쓴다.
    return camera.z > 0.0 ? camera : vec3(0.0, 0.5236, 5.196);
}

mat3 cameraBasis(vec3 ro, vec3 target) {
    vec3 forward = normalize(target - ro);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, forward);
    return mat3(right, up, forward);
}

vec3 shade(vec3 p, vec3 rd, float id) {
    vec3 normal = calcNormal(p);
    vec3 lightDir = normalize(vec3(-0.6, 1.0, 0.8));
    float diffuse = max(dot(normal, lightDir), 0.0);
    vec3 halfDir = normalize(lightDir - rd);
    float specular = pow(max(dot(normal, halfDir), 0.0), 48.0);
    return getAlbedo(id) * (0.18 + 0.82 * diffuse) + vec3(0.18) * specular;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // 화면 중심을 (0,0), 세로 방향 크기를 2로 맞춰 종횡비 왜곡을 피한다.
    vec2 uv = (2.0 * fragCoord - uResolution) / uResolution.y;
    vec3 target = vec3(0.0, -0.2, 0.0);
    vec3 camera = readCamera();
    float yaw = camera.x, pitch = camera.y, distance = camera.z;
    vec3 ro = target + distance * vec3(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
    vec3 rd = normalize(cameraBasis(ro, target) * vec3(uv, 1.8));

    int steps;
    bool limitReached;
    vec2 hit = rayMarch(ro, rd, steps, limitReached);

    // 관찰용 디버그 모드. 장면에 특화되지 않으며 실제 GPU 시간은 의미하지 않는다.
    if(uRMHeatmap) {
        float cost = sqrt(float(steps) / float(uRMMaxSteps));
        vec3 heat = mix(vec3(0.05, 0.20, 0.65), vec3(1.0, 0.25, 0.05), cost);
        if(limitReached) heat = vec3(1.0, 0.0, 1.0);
        fragColor = vec4(heat, 1.0);
        return;
    }

    vec3 color = vec3(0.04, 0.06, 0.09);
    if(hit.x >= 0.0) color = shade(ro + rd * hit.x, rd, hit.y);
    color = color / (color + vec3(1.0));
    color = pow(color, vec3(1.0 / 2.2));
    fragColor = vec4(color, 1.0);
}
`;
// Ray Marching 예제의 카메라 상태 버퍼(Buffer A, 2×1, rgba32f). iChannel0 = A · previous, iChannel1 = 키보드.
// 픽셀 0: (방위각, 높이각, 거리) · 픽셀 1: 직전 마우스 위치와 누름 여부(드래그 계산용).
const raymarchCamera = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform int uFrame;
uniform float uDeltaTime;
uniform vec4 uMouse;          // xy = 위치, z > 0 = 버튼 누름 중
uniform sampler2D iChannel0;  // A · previous
uniform sampler2D iChannel1;  // 키보드

const vec3 HOME = vec3(0.0, 0.5236, 5.196);
const int KEY_SHIFT = 16, KEY_LEFT = 37, KEY_UP = 38, KEY_RIGHT = 39, KEY_DOWN = 40;
const int KEY_A = 65, KEY_D = 68, KEY_R = 82, KEY_S = 83, KEY_W = 87;
float keyDown(int k)    { return texelFetch(iChannel1, ivec2(k, 0), 0).x; }
float keyPressed(int k) { return texelFetch(iChannel1, ivec2(k, 1), 0).x; }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    int pixel = int(fragCoord.x);
    vec4 camera = texelFetch(iChannel0, ivec2(0, 0), 0);
    vec4 drag = texelFetch(iChannel0, ivec2(1, 0), 0);
    if (uFrame == 0 || camera.z <= 0.0 || keyPressed(KEY_R) > 0.5) camera = vec4(HOME, 0.0);
    vec2 mouse = uMouse.xy / uResolution;   // 0~1
    bool down = uMouse.z > 0.0;

    // 뷰포트를 클릭한 뒤 키로 조작: A·D/←→ 회전, ↑↓ 높이, W·S 확대·축소, Shift 빠르게, R 초기 시점
    float speed = (keyDown(KEY_SHIFT) > 0.5 ? 3.0 : 1.0) * min(uDeltaTime, 0.05);
    float horizontal = max(keyDown(KEY_A), keyDown(KEY_LEFT)) - max(keyDown(KEY_D), keyDown(KEY_RIGHT));
    float vertical = keyDown(KEY_UP) - keyDown(KEY_DOWN);
    float zoom = keyDown(KEY_S) - keyDown(KEY_W);
    camera.x += horizontal * 1.4 * speed;
    camera.y += vertical * 1.2 * speed;
    camera.z *= exp(zoom * 1.4 * speed);

    // 드래그: 직전 프레임에도 누르고 있었으면 이동량만큼 회전한다.
    if (down && drag.z > 0.5) {
        vec2 delta = mouse - drag.xy;
        camera.x -= delta.x * 5.0;
        camera.y -= delta.y * 3.0;
    }

    camera.x = mod(camera.x, 6.2831853);   // 방위각이 끝없이 커지지 않게 한 바퀴로 감는다
    camera.y = clamp(camera.y, -1.4, 1.4);
    camera.z = clamp(camera.z, 1.5, 30.0);
    fragColor = pixel == 0 ? camera : vec4(mouse, down ? 1.0 : 0.0, 0.0);
}`;
const fragment = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord - 0.5 * uResolution) / uResolution.y;
    vec2 mouse = uMouse.x < 0.0 ? vec2(0.0) : (uMouse - 0.5 * uResolution) / uResolution.y;
    float wave = sin(8.0 * length(uv - mouse) - uTime * 2.0);
    vec3 color = 0.5 + 0.5 * cos(uTime * 0.3 + wave + vec3(0.0, 2.1, 4.2));
    fragColor = vec4(color, 1.0);
}`;
// [이름, 타입, 기본값, 옵션, {설명, 묶음}]. 작은 값(엡실론)·넓은 범위(거리)는 로그 눈금이라 아래쪽도 고르게 고를 수 있다.
const RAY_GROUP = "레이 마칭";
const rayUniforms = [
  ["uRMMaxSteps", "int", 128, { min: 1, max: 512, step: 1 }, { description: "최대 걸음 수", group: RAY_GROUP }],
  [
    "uRMMaxDistance",
    "float",
    100,
    { min: 1, max: 1000, step: 1, log: true },
    { description: "이보다 멀면 하늘로 본다", group: RAY_GROUP },
  ],
  [
    "uRMSurfaceEpsilon",
    "float",
    0.001,
    { min: 0.00001, max: 0.01, step: 0.00001, log: true },
    { description: "표면에 닿았다고 볼 거리", group: RAY_GROUP },
  ],
  [
    "uRMNormalEpsilon",
    "float",
    0.001,
    { min: 0.00001, max: 0.01, step: 0.00001, log: true },
    { description: "법선을 구할 때 옆으로 비킬 거리", group: RAY_GROUP },
  ],
  ["uRMHeatmap", "bool", false, {}, { description: "걸음 수를 색으로 보기(빨갈수록 많이 걸음)", group: RAY_GROUP }],
];
// 예제 소스의 선언 줄에 rayUniforms와 같은 어노테이션(@range·@step·@default)을 붙인다.
// 코드를 복사해 다른 프로젝트에 붙여도 슬라이더 범위와 기본값이 따라간다. 값은 rayUniforms 한곳에서만 고친다.
const annotate = (source, uniforms) =>
  uniforms.reduce((code, [name, type, value, options = {}, meta = {}]) => {
    const tags = [];
    if (options.log) tags.push("@log");
    if (options.min !== undefined) tags.push(`@range ${options.min} ${options.max}`, `@step ${options.step}`);
    tags.push(`@default ${value}`);
    if (meta.group) tags.push(`@group ${meta.group}`);
    const line = `uniform ${type} ${name};`;
    if (!code.includes(line)) throw new Error(`Ray Marching 예제에 ${line}이 없습니다.`);
    return code.replace(line, `${line} // ${meta.description ? `${meta.description} · ` : ""}${tags.join(" ")}`);
  }, source);
export default {
  vertex,
  fragment,
  raymarch: annotate(raymarch, rayUniforms),
  rayUniforms,
  // Ray Marching 예제 프로젝트: Buffer A가 카메라 상태를 저장하고 Image가 그 값을 읽는다.
  raymarchPasses: [
    {
      name: "A",
      fragment: raymarchCamera,
      // rgba32f여야 한다. rgba16f(반정밀도)는 저장한 마우스 위치가 반올림돼 다음 프레임의 uMouse와 어긋나고,
      // 그 차이가 '이동량'으로 매 프레임 쌓여 마우스를 누르고만 있어도 카메라가 돌아간다.
      format: "rgba32f",
      scale: 1,
      size: [2, 1],
      filter: "nearest",
      channels: { 0: { buffer: "A", frame: "previous" }, 1: { keyboard: true } },
    },
  ],
  raymarchChannels: { 0: { buffer: "A", frame: "current" } },
  passes: [],
  imageChannels: {},
};
