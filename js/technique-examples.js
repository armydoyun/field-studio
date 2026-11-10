// "기법 배우기" 예제 중 주제가 큰 것: PBR 재질, 볼류메트릭 구름, 2D 유체. 모두 FIELD Studio를 위해 새로 짠 교육용 코드다.
// 셰이더마다 "읽는 순서"와 원리를 머리말에 적고, 단계별 중간 결과를 볼 수 있는 보기(uView)를 둔다.
// 파라미터는 셰이더의 @어노테이션에만 적는다(갤러리가 소스에서 읽어 등록한다).

// 정수 해시(pcg3d): 좌표가 커져도 격자 무늬가 생기지 않는다. 갤러리 예제 공용 규칙.
const PCG = `uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}`;

// ---------------------------------------------------------------------------
// PBR 재질 구
// ---------------------------------------------------------------------------
const pbr = `#version 300 es
precision highp float;
// PBR 재질 구 — 물리 기반 셰이딩(Cook-Torrance)을 한 단계씩 나눠 본다.
//
// 읽는 순서:
//  1. main            → 화면을 칸으로 나눠 칸마다 구 하나. 구는 레이마칭 없이 식으로 바로 그린다(정사영).
//  2. shade           → 빛 하나의 반사 = 난반사(Lambert) + 정반사(D·G·F / 4(n·l)(n·v)). 에너지 보존: 반사된 만큼 난반사를 줄인다.
//  3. distributionGGX → D: 미세면 중 빛을 눈으로 튕길 방향의 비율. 거칠수록 하이라이트가 넓고 흐려진다.
//  4. geometrySmith   → G: 미세면끼리 가려 빛이 막히는 정도. 거칠고 비스듬할수록 어두워진다.
//  5. fresnelSchlick  → F: 비스듬히 볼수록 더 많이 반사한다. 금속은 F0(정면 반사율)가 바탕색 자체다.
//  6. ambient         → 주변 빛(하늘): 반사는 거칠기만큼 흐린 하늘을, 난반사는 법선 방향 하늘을 쓴다.
// uView로 D · G · F · 난반사 · 정반사를 따로 보며 슬라이더를 움직여 보자.
// 격자 보기(uGrid): 가로 = 거칠기 0 → 1, 세로 = 금속성 0(아래) · 0.5 · 1(위). 커서 가로 위치로 빛을 돌린다.
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
uniform vec3 uBaseColor;  // 바탕색(albedo) · @color @default 0.95 0.55 0.25 @group 재질
uniform float uRoughness; // 거칠기(격자 보기가 꺼졌을 때) · @range 0.02 1 @step 0.01 @default 0.35 @anim 6 @group 재질
uniform float uMetallic;  // 금속성(격자 보기가 꺼졌을 때) · @range 0 1 @step 0.01 @default 0 @group 재질
uniform float uLight;     // 빛 세기 · @range 0 10 @step 0.1 @default 4 @group 빛
uniform float uAmbient;   // 하늘빛 세기 · @range 0 2 @step 0.01 @default 0.6 @group 빛
uniform bool uGrid;       // 거칠기 × 금속성 격자로 보기 · @default true
uniform int uView;        // 보기 · @enum 결과 D G F 난반사만 정반사만 @default 0
out vec4 fragColor;

const float PI = 3.14159265;

// D — GGX(Trowbridge-Reitz) 법선 분포. a = 거칠기²(지각상 고르게 바뀌도록 제곱한다).
float distributionGGX(float NdotH, float roughness) {
    float a = roughness * roughness, a2 = a * a;
    float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}
// G — Smith 가림(Schlick-GGX 근사). 빛 쪽(l)과 눈 쪽(v) 둘 다 가려질 수 있어 곱한다.
float geometrySchlick(float NdotX, float roughness) {
    float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    return NdotX / (NdotX * (1.0 - k) + k);
}
float geometrySmith(float NdotV, float NdotL, float roughness) {
    return geometrySchlick(NdotV, roughness) * geometrySchlick(NdotL, roughness);
}
// F — Schlick 프레넬. cosTheta가 0(스치듯 볼 때)에 가까울수록 1(완전 반사)로 간다.
vec3 fresnelSchlick(float cosTheta, vec3 F0) {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}
// 하늘(환경): 위는 푸르고 아래는 어두운 바닥, 해 쪽이 밝다. blur(0~1)가 클수록 무늬 없이 평균에 가까워진다.
vec3 sky(vec3 dir, float blur) {
    vec3 col = mix(vec3(0.10, 0.09, 0.08), vec3(0.45, 0.62, 0.9), smoothstep(-0.25, 0.6, dir.y));
    col += vec3(1.0, 0.9, 0.75) * pow(max(dot(dir, normalize(vec3(-0.4, 0.7, 0.6))), 0.0), mix(64.0, 2.0, blur)) * (1.0 - 0.6 * blur);
    return col;
}
// 주변 빛. 정반사 쪽은 Karis의 근사식(EnvBRDFApprox)으로 "흐린 하늘 × 프레넬"을 보정한다.
vec3 ambient(vec3 n, vec3 v, vec3 albedo, float roughness, float metallic, out vec3 diffuse, out vec3 specular) {
    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    float NdotV = max(dot(n, v), 1e-4);
    const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022), c1 = vec4(1.0, 0.0425, 1.04, -0.04);
    vec4 r = roughness * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
    vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
    specular = sky(reflect(-v, n), roughness) * (F0 * AB.x + AB.y);
    diffuse = sky(n, 1.0) * albedo * (1.0 - metallic);
    return diffuse + specular;
}
// 빛 하나(방향 l)의 반사. view: 보기 선택(uView)에 따라 중간값을 돌려준다.
vec3 shade(vec3 n, vec3 v, vec3 l, vec3 albedo, float roughness, float metallic, out vec3 diffuse, out vec3 specular) {
    vec3 h = normalize(v + l);                                   // 반사 방향의 절반(half vector)
    float NdotL = max(dot(n, l), 0.0), NdotV = max(dot(n, v), 1e-4), NdotH = max(dot(n, h), 0.0);
    vec3 F0 = mix(vec3(0.04), albedo, metallic);                 // 유전체는 4%, 금속은 바탕색만큼 반사
    float D = distributionGGX(NdotH, roughness), G = geometrySmith(NdotV, NdotL, roughness);
    vec3 F = fresnelSchlick(max(dot(h, v), 0.0), F0);
    if (uView == 1) return vec3(D / (1.0 + D)); // 밝기를 눌러 보여 준다
    if (uView == 2) return vec3(G);
    // 보기 F: 빛 하나의 F(h·v)는 구 전체에서 거의 같아 보이므로, 시선 각도(n·v)로 보여 준다 — 가장자리일수록 밝아진다.
    if (uView == 3) return fresnelSchlick(NdotV, F0);
    specular = D * G * F / (4.0 * NdotV * max(NdotL, 1e-4)) * NdotL;
    vec3 kd = (1.0 - F) * (1.0 - metallic);                      // 반사된 만큼 난반사를 줄이고, 금속은 난반사가 없다
    diffuse = kd * albedo / PI * NdotL;
    return diffuse + specular;
}
void main() {
    float side = min(uResolution.x, uResolution.y);
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / side;
    // 칸 나누기: 격자 보기면 5 × 3칸, 아니면 가운데 구 하나
    vec2 grid = uGrid ? vec2(5.0, 3.0) : vec2(1.0);
    vec2 area = uResolution / side * 2.0;                        // 화면 전체 크기(p 단위)
    float cellSize = min(area.x / grid.x, area.y / grid.y);
    vec2 cell = clamp(floor((p + 0.5 * grid * cellSize) / cellSize), vec2(0.0), grid - 1.0);
    vec2 q = (p + 0.5 * grid * cellSize - (cell + 0.5) * cellSize) / (0.42 * cellSize);
    float roughness = uGrid ? mix(0.05, 1.0, cell.x / 4.0) : uRoughness;
    float metallic = uGrid ? cell.y / 2.0 : uMetallic;
    vec3 col = vec3(0.035, 0.037, 0.045) * (1.2 - 0.3 * length(p));
    float r2 = dot(q, q);
    if (r2 < 1.0 && all(lessThan(abs(p), 0.5 * grid * cellSize))) {
        vec3 n = vec3(q.x, q.y, sqrt(1.0 - r2)), v = vec3(0.0, 0.0, 1.0);
        float angle = uMouse.x >= 0.0 ? (uMouse.x / uResolution.x - 0.5) * 4.0 : 0.6 * sin(uTime * 0.4);
        vec3 l = normalize(vec3(sin(angle), 0.6, cos(angle) * 0.8 + 0.2));
        vec3 d1, s1, d2, s2;
        vec3 direct = shade(n, v, l, uBaseColor, roughness, metallic, d1, s1);
        if (uView >= 1 && uView <= 3) col = direct;
        else {
            ambient(n, v, uBaseColor, roughness, metallic, d2, s2);
            vec3 lit = uLight * (uView == 5 ? s1 : uView == 4 ? d1 : direct) + uAmbient * (uView == 5 ? s2 : uView == 4 ? d2 : d2 + s2);
            lit = clamp(lit * (2.51 * lit + 0.03) / (lit * (2.43 * lit + 0.59) + 0.14), 0.0, 1.0);   // ACES 톤 매핑
            col = pow(lit, vec3(1.0 / 2.2));                                                         // 감마
        }
        col *= smoothstep(1.0, 0.98, r2);   // 구 테두리를 부드럽게
    }
    fragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// 볼류메트릭 구름
// ---------------------------------------------------------------------------
const clouds = `#version 300 es
precision highp float;
// 볼류메트릭 구름 — 표면이 없는 것(구름·안개·연기)을 그리는 법: 광선을 따라 밀도를 모은다.
//
// 읽는 순서:
//  1. main       → 카메라 광선이 구름층(높이 uBottom~uTop)을 지나는 구간을 구하고 그 사이만 행진한다.
//  2. density    → 그 자리의 구름 밀도 = fbm 노이즈 - (1 - 덮인 정도), 아래·위 끝은 부드럽게 줄인다.
//  3. 행진 루프   → 한 걸음마다 투과율 T(뒤가 비쳐 보이는 정도)를 Beer 법칙 exp(-밀도·흡수·걸음)으로 줄이고,
//                  그 걸음이 받은 빛 × (이번에 막힌 양)을 색에 더한다. T가 거의 0이면 뒤는 안 보이니 멈춘다.
//  4. lightMarch → 그 자리에서 해 쪽으로 몇 걸음 더 가며 밀도를 모아, 해빛이 얼마나 남아 도착하는지 구한다(자기 그림자).
//  5. phaseHG    → 빛이 흩어지는 방향: 해를 등지고 보면 구름 가장자리가 은빛으로 빛난다(앞쪽 산란, g > 0).
// uView로 밀도 · 투과율 · 받은 해빛을 따로 볼 수 있다. 걸음 수를 줄이면 빨라지지만 띠 무늬가 생긴다 —
// 시작 위치를 픽셀마다 조금 흔드는(dither) 이유다.
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
uniform float uCoverage;   // 덮인 정도 · @range 0 1 @step 0.01 @default 0.45 @anim 8 @group 구름
uniform float uDensity;    // 밀도(흡수) · @range 0.1 4 @step 0.01 @default 1.4 @group 구름
uniform float uAnisotropy; // 앞쪽 산란(g) · @range -0.5 0.9 @step 0.01 @default 0.6 @group 구름
uniform int uSteps;        // 행진 걸음 수 · @min 8 @max 96 @default 48 @group 품질
uniform int uLightSteps;   // 해 쪽 걸음 수 · @min 0 @max 12 @default 6 @group 품질
uniform float uWind;       // 바람 · @range 0 2 @step 0.01 @default 0.4 @group 구름
uniform vec3 uSunCol;      // 햇빛 · @color @default 1 0.92 0.8 @group 빛
uniform vec3 uSkyCol;      // 하늘빛(그늘을 채움) · @color @default 0.45 0.6 0.85 @group 빛
uniform vec3 uSunDir;      // 해 방향 · @dir hemi @default 0.6 0.35 0.7 @group 빛
uniform int uView;         // 보기 · @enum 결과 밀도 투과율 받은_해빛 @default 0
out vec4 fragColor;

const float BOTTOM = 1.5, TOP = 4.0;                           // 구름층 높이
#define SUN uSunDir                                             // 해 방향(@dir라 늘 길이 1)

${PCG}
float hash3(vec3 p) { return float(pcg3d(uvec3(ivec3(floor(p)) + 32768)).x >> 8u) * (1.0 / 16777216.0); }
// 3D 값 노이즈: 정육면체 꼭짓점 8곳의 해시를 부드럽게 섞는다.
float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), u.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), u.x), u.y),
               mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), u.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
    return v;
}
// 구름 밀도: 큰 덩어리(fbm) 모양에 덮인 정도를 빼고, 층의 아래·위 끝에서 0으로 줄인다.
float density(vec3 p) {
    float h = (p.y - BOTTOM) / (TOP - BOTTOM);
    float profile = smoothstep(0.0, 0.15, h) * smoothstep(1.0, 0.45, h);
    vec3 q = p * 0.45 + vec3(uTime * uWind * 0.3, 0.0, uTime * uWind * 0.1);
    // 덮인 정도를 빼고 남은 부분만 구름. 6배로 키워 가장자리를 또렷하게(작게 하면 안개처럼 흐려진다).
    return max(fbm(q) - (1.0 - uCoverage), 0.0) * profile * 6.0;
}
// Henyey-Greenstein 위상 함수: 빛이 들어온 방향과 보는 방향의 각도에 따라 얼마나 흩어져 오는지.
float phaseHG(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}
// 해 쪽으로 몇 걸음 가며 밀도를 모아 도착하는 해빛의 비율(0~1)을 구한다.
float lightMarch(vec3 p) {
    float sum = 0.0, stepSize = 0.5;
    for (int i = 0; i < 12; i++) {
        if (i >= uLightSteps) break;
        p += SUN * stepSize;
        sum += density(p) * stepSize;
    }
    return exp(-sum * uDensity);
}
vec3 skyColor(vec3 rd) {
    if (rd.y < 0.0) return mix(vec3(0.42, 0.45, 0.5), vec3(0.16, 0.17, 0.19), smoothstep(0.0, -0.3, rd.y));   // 땅(안개 낀 지평선)
    vec3 col = mix(vec3(0.62, 0.7, 0.8), vec3(0.18, 0.36, 0.7), smoothstep(0.0, 0.6, rd.y));
    return col + uSunCol * (pow(max(dot(rd, SUN), 0.0), 400.0) * 3.0 + pow(max(dot(rd, SUN), 0.0), 8.0) * 0.2);
}
void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    // 카메라: 땅 위에서 하늘을 올려다본다. 커서로 둘러본다.
    float yaw = uMouse.x >= 0.0 ? (uMouse.x / uResolution.x - 0.5) * 6.0 : -1.6;   // 기본 시점은 해를 옆으로 둔다(그늘이 보이게)
    float pitch = uMouse.x >= 0.0 ? uMouse.y / uResolution.y * 0.8 : 0.35;
    vec3 ro = vec3(0.0, 0.2, 0.0), ww = normalize(vec3(sin(yaw), pitch, cos(yaw)));
    vec3 uu = normalize(cross(ww, vec3(0, 1, 0))), vv = cross(uu, ww);
    vec3 rd = normalize(p.x * uu + p.y * vv + 1.5 * ww);
    vec3 sky = skyColor(rd), col = vec3(0.0);
    float T = 1.0, sunSum = 0.0, densSum = 0.0;
    if (rd.y > 0.01) {
        // 구름층 안 구간 [t0, t1]: 수평 평면 두 장과 만나는 거리. 너무 먼 지평선 쪽은 잘라 낸다.
        float t0 = (BOTTOM - ro.y) / rd.y, t1 = min((TOP - ro.y) / rd.y, 40.0);
        float dt = (t1 - t0) / float(uSteps);
        // 시작 위치를 픽셀마다 걸음의 0~1배만큼 흔든다(dither) → 띠 무늬 대신 고운 노이즈
        float t = t0 + dt * (float(pcg3d(uvec3(gl_FragCoord.xy, 7u)).x >> 8u) * (1.0 / 16777216.0));
        // 위상: 앞쪽 산란(g)과 약한 뒤쪽 산란을 섞는다(한쪽만 쓰면 해를 등질 때 구름이 너무 어둡다). 4π를 곱해 등방이면 1.
        float cosTheta = dot(rd, SUN);
        float phase = mix(phaseHG(cosTheta, uAnisotropy), phaseHG(cosTheta, -0.25), 0.4) * 4.0 * 3.14159265;
        for (int i = 0; i < 96; i++) {
            if (i >= uSteps || T < 0.01) break;
            vec3 pos = ro + rd * t;
            float d = density(pos);
            if (d > 0.0) {
                float sunLight = lightMarch(pos);
                float h = clamp((pos.y - BOTTOM) / (TOP - BOTTOM), 0.0, 1.0);
                // 이 걸음이 받은 빛: 해빛 × 위상 + 하늘빛(위쪽일수록 많이 받는다)
                vec3 light = uSunCol * sunLight * phase * 1.4 + uSkyCol * (0.08 + 0.3 * h);
                float absorbed = 1.0 - exp(-d * uDensity * dt);        // 이번 걸음에서 막힌 비율(Beer 법칙)
                col += T * absorbed * light;
                sunSum += T * absorbed * sunLight;
                densSum += d * dt;
                T *= 1.0 - absorbed;
            }
            t += dt;
        }
        // 멀리 있는 구름일수록 하늘색에 묻히게(공기 원근)
        float haze = exp(-0.02 * t0);
        col = mix(sky * (1.0 - T), col, haze);
    }
    vec3 result = sky * T + col;
    if (uView == 1) result = vec3(1.0 - exp(-densSum * 0.5));
    else if (uView == 2) result = vec3(T);
    else if (uView == 3) result = vec3(sunSum);
    else result = pow(clamp(result * (2.51 * result + 0.03) / (result * (2.43 * result + 0.59) + 0.14), 0.0, 1.0), vec3(1.0 / 2.2));   // ACES + 감마
    fragColor = vec4(result, 1.0);
}`;

// ---------------------------------------------------------------------------
// 2D 유체 (Stable Fluids 방식, 버퍼 6개)
// ---------------------------------------------------------------------------
// 순서: A 속도(이류 + 힘 + 압력 빼기) → B 발산 → C·D·E 압력(야코비 반복 3번) → F 염료(이류) → Image.
// 모든 버퍼는 같은 크기(scale 0.5)라 픽셀 하나 = 격자 한 칸. 속도의 단위는 "칸 / 프레임"이다.
const FLUID_COMMON = `// 이웃 칸 읽기: 가장자리 밖은 가장자리 값을 쓴다(벽에서 압력이 새지 않게 — 노이만 경계)
vec4 at(sampler2D tex, ivec2 c) { return texelFetch(tex, clamp(c, ivec2(0), ivec2(uResolution) - 1), 0); }`;
const fluidVelocity = `#version 300 es
precision highp float;
// Buffer A · 속도(rg) · RGBA16F · 0.5배. iChannel0 = A (previous), iChannel1 = E (previous, 압력)
// 유체를 푸는 순서(Jos Stam, "Stable Fluids"):
//  1) 이류(advection): 속도가 속도 자신을 실어 나른다. "이 칸에 지금 있는 것은 한 프레임 전 (위치 - 속도)에 있던 것"이라
//     뒤로 거슬러 가서 읽는다(semi-Lagrangian). 앞으로 밀면 빈틈이 생기지만 뒤에서 읽으면 늘 안정적이다.
//  2) 힘: 움직이는 분사구 두 개와 마우스(누르고 있는 동안 바깥으로 민다).
//  3) 압력 빼기(projection): 압력 경사만큼 속도를 빼 "들어온 만큼 나가게"(발산 0) 만든다 → 소용돌이가 생기는 이유.
//     압력은 지난 프레임에 B·C·D·E가 푼 값을 쓴다(한 프레임 늦지만 매 프레임 이어서 풀어 충분히 맞는다).
uniform vec2 uResolution;
uniform float uTime;
uniform int uFrame;
uniform vec4 uMouse;          // xy = 커서(이 버퍼의 픽셀 좌표), z > 0 = 누르는 중
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform float uForce;         // 분사구 힘 · @range 0 2 @step 0.01 @default 0.6
uniform float uDissipation;   // 속도 유지율(1 = 줄지 않음) · @range 0.95 1 @step 0.001 @default 0.995
out vec4 fragColor;
${FLUID_COMMON}
// 분사구 i의 위치와 방향: 화면을 천천히 돌며 안쪽을 향해 뿜는다.
void jet(int i, out vec2 pos, out vec2 dir) {
    float a = uTime * 0.35 + float(i) * 3.14159265;
    pos = uResolution * (0.5 + 0.32 * vec2(cos(a), sin(a * 1.3)));
    dir = normalize(uResolution * 0.5 - pos + 60.0 * vec2(-sin(a * 2.0), cos(a * 2.0)));
}
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    if (uFrame == 0) { fragColor = vec4(0.0); return; }
    // 1) 이류: 한 프레임 전 (위치 - 속도)에서 읽는다(이중선형 보간)
    vec2 vel = at(iChannel0, c).xy;
    vel = texture(iChannel0, (gl_FragCoord.xy - vel) / uResolution).xy * uDissipation;
    // 2) 힘
    for (int i = 0; i < 2; i++) {
        vec2 pos, dir;
        jet(i, pos, dir);
        float r = 0.025 * uResolution.y;
        vel += dir * uForce * exp(-dot(gl_FragCoord.xy - pos, gl_FragCoord.xy - pos) / (r * r));
    }
    if (uMouse.z > 0.0) {
        vec2 d = gl_FragCoord.xy - uMouse.xy;
        float r = 0.04 * uResolution.y;
        vel += normalize(d + 1e-4) * 1.5 * exp(-dot(d, d) / (r * r));
    }
    // 3) 압력 빼기: v -= ∇p (중앙 차분)
    vel -= 0.5 * vec2(at(iChannel1, c + ivec2(1, 0)).x - at(iChannel1, c - ivec2(1, 0)).x,
                      at(iChannel1, c + ivec2(0, 1)).x - at(iChannel1, c - ivec2(0, 1)).x);
    // 벽: 가장자리 칸은 멈춘다. 너무 빠르면 한 프레임에 여러 칸을 건너뛰어 불안정해지니 상한을 둔다.
    if (c.x < 1 || c.y < 1 || c.x >= int(uResolution.x) - 1 || c.y >= int(uResolution.y) - 1) vel = vec2(0.0);
    float speed = length(vel);
    if (speed > 6.0) vel *= 6.0 / speed;
    fragColor = vec4(vel, 0.0, 1.0);
}`;
const fluidDivergence = `#version 300 es
precision highp float;
// Buffer B · 발산 · RGBA16F · 0.5배. iChannel0 = A (current)
// 발산 = 이 칸에서 나가는 양 - 들어오는 양. 양수면 퍼져 나가고, 음수면 모여든다. 물은 압축되지 않으니 0이어야 한다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
out vec4 fragColor;
${FLUID_COMMON}
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    float div = 0.5 * (at(iChannel0, c + ivec2(1, 0)).x - at(iChannel0, c - ivec2(1, 0)).x +
                       at(iChannel0, c + ivec2(0, 1)).y - at(iChannel0, c - ivec2(0, 1)).y);
    fragColor = vec4(div, 0.0, 0.0, 1.0);
}`;
// 압력 패스 셋은 같은 코드: 이전 추정값(iChannel0)을 한 번 더 다듬는다.
const fluidPressure = (name, from) => `#version 300 es
precision highp float;
// Buffer ${name} · 압력 · RGBA16F · 0.5배. iChannel0 = ${from}, iChannel1 = B (current, 발산)
// 압력 풀기(야코비 반복): 압력 p는 "∇²p = 발산"을 만족해야 한다. 한 번에 풀 수 없으니
// 이웃 네 칸 평균에서 발산을 빼는 일을 되풀이하면 답에 가까워진다. C → D → E로 세 번, 다음 프레임은 E에서 이어서.
// 반복이 많을수록 소용돌이가 또렷해진다(패스를 더 이으면 된다). 적으면 물이 조금씩 "새는" 것처럼 보인다.
uniform vec2 uResolution;
uniform int uFrame;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
out vec4 fragColor;
${FLUID_COMMON}
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    if (uFrame == 0) { fragColor = vec4(0.0); return; }
    float p = (at(iChannel0, c + ivec2(1, 0)).x + at(iChannel0, c - ivec2(1, 0)).x +
               at(iChannel0, c + ivec2(0, 1)).x + at(iChannel0, c - ivec2(0, 1)).x - at(iChannel1, c).x) * 0.25;
    fragColor = vec4(p, 0.0, 0.0, 1.0);
}`;
const fluidDye = `#version 300 es
precision highp float;
// Buffer F · 염료(rgb) · RGBA16F · 0.5배. iChannel0 = F (previous), iChannel1 = A (current, 속도)
// 눈에 보이는 것은 속도가 아니라 물에 푼 물감이다. 물감도 속도로 실어 나르고(이류), 분사구에서 새로 넣고, 천천히 옅어진다.
uniform vec2 uResolution;
uniform float uTime;
uniform int uFrame;
uniform vec4 uMouse;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform float uDyeFade;       // 물감 유지율 · @range 0.95 1 @step 0.001 @default 0.992
out vec4 fragColor;
${FLUID_COMMON}
void jet(int i, out vec2 pos, out vec2 dir) {   // Buffer A와 같은 분사구
    float a = uTime * 0.35 + float(i) * 3.14159265;
    pos = uResolution * (0.5 + 0.32 * vec2(cos(a), sin(a * 1.3)));
    dir = normalize(uResolution * 0.5 - pos + 60.0 * vec2(-sin(a * 2.0), cos(a * 2.0)));
}
void main() {
    if (uFrame == 0) { fragColor = vec4(0.0); return; }
    vec2 vel = at(iChannel1, ivec2(gl_FragCoord.xy)).xy;
    vec3 dye = texture(iChannel0, (gl_FragCoord.xy - vel) / uResolution).rgb * uDyeFade;
    for (int i = 0; i < 2; i++) {
        vec2 pos, dir;
        jet(i, pos, dir);
        float r = 0.02 * uResolution.y;
        vec3 tint = i == 0 ? vec3(1.0, 0.35, 0.1) : vec3(0.1, 0.45, 1.0);
        dye += tint * 0.6 * exp(-dot(gl_FragCoord.xy - pos, gl_FragCoord.xy - pos) / (r * r));
    }
    if (uMouse.z > 0.0) {
        vec2 d = gl_FragCoord.xy - uMouse.xy;
        float r = 0.03 * uResolution.y;
        dye += vec3(0.9, 0.9, 0.3) * 0.5 * exp(-dot(d, d) / (r * r));
    }
    fragColor = vec4(min(dye, vec3(4.0)), 1.0);
}`;
const fluidImage = `#version 300 es
precision highp float;
// Image · 보기. iChannel0 = F (물감), iChannel1 = A (속도), iChannel2 = E (압력), iChannel3 = B (발산)
// 2D 유체 — 읽는 순서: Buffer A(속도) → B(발산) → C·D·E(압력) → F(물감) → 여기. 각 버퍼 머리말에 그 단계의 원리가 있다.
// 뷰포트를 누른 채 움직이면 물을 밀고 물감을 넣는다. uView로 속도·압력·발산을 직접 보자.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform int uView;            // 보기(속도: 방향 = 색상, 압력: 빨강 +, 파랑 -) · @enum 물감 속도 압력 발산 @default 0
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 col;
    if (uView == 1) {
        vec2 v = texture(iChannel1, uv).xy;
        col = (0.5 + 0.5 * cos(atan(v.y, v.x) + vec3(0.0, 2.1, 4.2))) * min(length(v) * 0.6, 1.0);
    } else if (uView == 2) {
        float p = texture(iChannel2, uv).x * 0.3;
        col = vec3(max(p, 0.0), 0.0, max(-p, 0.0));
    } else if (uView == 3) {
        col = vec3(abs(texture(iChannel3, uv).x) * 20.0);
    } else {
        vec3 dye = texture(iChannel0, uv).rgb;
        col = 1.0 - exp(-dye * 1.5);                             // 진할수록 서서히 포화(톤 매핑)
        col = mix(vec3(0.02, 0.02, 0.03), col, clamp(length(dye) * 2.0, 0.0, 1.0)) + col * 0.2;
    }
    fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;
const fluidPass = (name, fragment, channels) => ({ name, fragment, format: "rgba16f", scale: 0.5, channels });

const LESSONS = [
  {
    id: "pbr",
    title: "PBR Materials",
    tag: "Lighting · GGX · Fresnel",
    description: "거칠기 × 금속성 격자로 보는 물리 기반 셰이딩. D·G·F 항을 하나씩 켜 보세요.",
    image: pbr,
  },
  {
    id: "volumetric",
    title: "Volumetric Clouds",
    tag: "Volume · Beer · Phase",
    description: "밀도를 따라 광선을 행진하며 빛 흡수와 산란을 모으는 3D 구름. 커서로 둘러보세요.",
    image: clouds,
  },
  {
    id: "fluid",
    title: "2D Fluid",
    tag: "Simulation · 6 buffers",
    description: "이류 → 발산 → 압력(야코비) → 속도 보정. 버퍼를 이어 푸는 유체. 눌러서 물을 밀어 보세요.",
    thumb: "fluid",
    project: {
      image: fluidImage,
      passes: [
        fluidPass("A", fluidVelocity, { 0: { buffer: "A", frame: "previous" }, 1: { buffer: "E", frame: "previous" } }),
        fluidPass("B", fluidDivergence, { 0: { buffer: "A", frame: "current" } }),
        fluidPass("C", fluidPressure("C", "E (previous, 지난 프레임의 답)"), {
          0: { buffer: "E", frame: "previous" },
          1: { buffer: "B", frame: "current" },
        }),
        fluidPass("D", fluidPressure("D", "C (current)"), {
          0: { buffer: "C", frame: "current" },
          1: { buffer: "B", frame: "current" },
        }),
        fluidPass("E", fluidPressure("E", "D (current)"), {
          0: { buffer: "D", frame: "current" },
          1: { buffer: "B", frame: "current" },
        }),
        fluidPass("F", fluidDye, { 0: { buffer: "F", frame: "previous" }, 1: { buffer: "A", frame: "current" } }),
      ],
      imageChannels: {
        0: { buffer: "F", frame: "current" },
        1: { buffer: "A", frame: "current" },
        2: { buffer: "E", frame: "current" },
        3: { buffer: "B", frame: "current" },
      },
    },
  },
];
export { LESSONS };
