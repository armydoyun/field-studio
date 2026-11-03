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
uniform bool uDebugRaySteps;
// Buffer/Image 패스에서 동일하게 사용하는 입력 채널(최대 4개).
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform vec3 iChannelResolution[4];

out vec4 fragColor;

// 고정 반복 상한: WebGL2 루프 최적화를 위한 안전 장치. 실제 반복 수는 uMaxSteps로 제한한다.
const int MAX_STEPS_CAP = 512;
uniform int uMaxSteps;
uniform float uMaxDistance;
uniform float uSurfaceEpsilon;
uniform float uNormalEpsilon;

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
        if(i >= uMaxSteps) break;
        SDFResult result = map(ro + rd * t);
        steps = i + 1;
        if(result.dist < uSurfaceEpsilon) return vec2(t, result.id);
        t += result.dist;
        if(t > uMaxDistance) return vec2(-1.0);
    }

    limitReached = true;
    return vec2(-1.0);
}

// 정사면체 방향 4회 샘플링으로 표면 기울기(법선)를 근사한다.
vec3 calcNormal(vec3 p) {
    float h = uNormalEpsilon;
    const vec2 k = vec2(1.0, -1.0);
    return normalize(
        k.xyy * map(p + k.xyy * h).dist +
        k.yyx * map(p + k.yyx * h).dist +
        k.yxy * map(p + k.yxy * h).dist +
        k.xxx * map(p + k.xxx * h).dist
    );
}


// --- 카메라와 화면 출력 ---

// 이 프리셋이 소유하는 선택적 Orbit 카메라 입력.
uniform vec3 uCameraOrbit;

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

void main() {
    // 화면 중심을 (0,0), 세로 방향 크기를 2로 맞춰 종횡비 왜곡을 피한다.
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec3 target = vec3(0.0, -0.2, 0.0);
    float yaw = uCameraOrbit.x, pitch = uCameraOrbit.y, distance = uCameraOrbit.z;
    vec3 ro = target + distance * vec3(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
    vec3 rd = normalize(cameraBasis(ro, target) * vec3(uv, 1.8));

    int steps;
    bool limitReached;
    vec2 hit = rayMarch(ro, rd, steps, limitReached);

    // 관찰용 디버그 모드. 장면에 특화되지 않으며 실제 GPU 시간은 의미하지 않는다.
    if(uDebugRaySteps) {
        float cost = sqrt(float(steps) / float(uMaxSteps));
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
  const fragment = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
out vec4 fragColor;
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    vec2 mouse = uMouse.x < 0.0 ? vec2(0.0) : (uMouse - 0.5 * uResolution) / uResolution.y;
    float wave = sin(8.0 * length(uv - mouse) - uTime * 2.0);
    vec3 color = 0.5 + 0.5 * cos(uTime * 0.3 + wave + vec3(0.0, 2.1, 4.2));
    fragColor = vec4(color, 1.0);
}`;
  const orbitHome=[0,Math.atan2(2.6,4.5),Math.hypot(4.5,2.6)];
  const rayUniforms = [
    ["uCameraOrbit","vec3",orbitHome],
    ["uRMMaxSteps","int",128,{min:1,max:512,step:1}], ["uRMMaxDistance","float",100,{min:1,max:1000,step:1}],
    // 슬라이더는 실제로 쓰는 구간만 다룬다. 기본값이 트랙의 1% 근처에 붙으면 조절할 수 없다.
    ["uRMSurfaceEpsilon","float",0.001,{min:0.00001,max:0.01,step:0.00001}],
    ["uRMNormalEpsilon","float",0.001,{min:0.00001,max:0.01,step:0.00001}], ["uRMHeatmap","bool",false]
  ];
  export default {vertex, fragment, raymarch:raymarch.replace(/uMaxSteps/g,"uRMMaxSteps").replace(/uMaxDistance/g,"uRMMaxDistance")
    .replace(/uSurfaceEpsilon/g,"uRMSurfaceEpsilon").replace(/uNormalEpsilon/g,"uRMNormalEpsilon")
    .replace(/uDebugRaySteps/g,"uRMHeatmap"), orbitHome, rayUniforms, passes:[], imageChannels:{}};
