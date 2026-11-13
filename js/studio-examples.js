// Studio가 직접 만드는 예제 셰이더와 버퍼 예제 프로젝트. 갤러리 예제는 gallery.js에 있다.
// tests/examples-compile-browser-regression.py가 이 파일에서 "#version 300 es"로 시작하는 템플릿 문자열 상수를 모두 찾아 실제 GLSL 컴파일러로 검사한다.

const comparison = `#version 300 es
precision highp float;
// Image: iChannel0 = B (current), iChannel1 = A (current).
// 왼쪽은 A 원본, 오른쪽은 B 처리 결과. 각 화면에 같은 UV를 사용한다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / uResolution;
    bool original = uv.x < 0.5;
    uv.x = fract(uv.x * 2.0);
    vec3 color = original ? texture(iChannel1, uv).rgb : texture(iChannel0, uv).rgb;
    fragColor = vec4(color, 1.0);
}`;
// 새 버퍼 패스의 시작 코드
const blank = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / uResolution;
    fragColor = vec4(uv, 0.5 + 0.5 * sin(uTime), 1.0);
}`;
// Common 탭의 시작 코드: 모든 패스(Image · Buffer) 앞에 붙는다. 함수 · 상수 · 구조체를 두는 곳이다.
const common = `// Common: 여기에 쓴 함수 · 상수 · #define은 모든 패스(Image · Buffer)에서 쓸 수 있습니다.
// 패스의 머리말(#version · precision) 다음, 패스 코드보다 앞에 붙습니다(mainImage는 각 패스에 둡니다).
// uTime · uResolution · iChannel0 · iTime 같은 앱 Uniform은 선언 없이, 파라미터는 여기나 어느 한 패스에 선언해 씁니다.
// 여기 이름을 F2로 바꾸면 모든 패스의 쓰는 곳도 함께 바뀝니다.
#define PI 3.14159265

// 0~1 정수 해시(칸 번호가 커져도 무늬가 무너지지 않는다)
float hash12(vec2 p) {
    uvec2 q = uvec2(ivec2(floor(p))) * uvec2(1597334673u, 3812015801u);
    uint n = (q.x ^ q.y) * 1597334673u;
    return float(n) * (1.0 / float(0xffffffffu));
}
`;
const movingDot = `#version 300 es
precision highp float;
// Buffer A: 외부 입력 없이 움직이는 원을 만든다. B가 A의 current를 읽는다.
uniform vec2 uResolution;
uniform float uTime;
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 p = (2.0 * fragCoord - uResolution) / uResolution.y;
    vec2 center = 0.5 * vec2(cos(uTime), sin(uTime * 1.4));
    float dotMask = 1.0 - smoothstep(0.09, 0.11, length(p - center));
    fragColor = vec4(vec3(0.1, 0.65, 1.0) * dotMask, 1.0);
}`;
const colorFilter = `#version 300 es
precision highp float;
// Buffer B: iChannel0 = A (current). 반드시 A 다음에 실행한다.
// A의 이번 프레임 결과를 읽어 RGB 순서를 바꾼다. 자기 자신은 읽지 않는다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / uResolution;
    vec3 source = texture(iChannel0, uv).rgb;
    fragColor = vec4(source.brg, 1.0);
}`;
const feedback = `#version 300 es
precision highp float;
// Buffer B: iChannel0 = A (current), iChannel1 = B (previous).
// A의 새 원을 현재 프레임에서 읽고, B의 직전 프레임에 남은 잔상과 합친다.
// B를 current로 자기 참조하면 안 된다. previous는 별도 Texture를 읽는다.
uniform vec2 uResolution;
uniform float uDeltaTime;
uniform int uFrame;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / uResolution;
    vec3 source = texture(iChannel0, uv).rgb;
    // 첫 프레임에는 이전 누적 결과를 사용하지 않는다. Reset으로 다시 시작한다.
    vec3 history = uFrame == 0 ? vec3(0.0) : texture(iChannel1, uv).rgb;
    // 초 단위로 밝기를 줄이되, RGBA8에서 반올림되어 잔상이 고착되지 않게 최소 1단계 감쇠한다.
    float fade = max(0.8 * uDeltaTime, 1.0 / 255.0);
    fragColor = vec4(max(source, history - fade), 1.0);
}`;

// 버퍼 연결 배우기: A(움직이는 원) → B(색 바꾸기, A의 current) → Image(A·B 나란히 비교)
const pipelineProject = () => ({
  image: comparison,
  passes: [
    { name: "A", fragment: movingDot, format: "rgba8", scale: 1, channels: {} },
    { name: "B", fragment: colorFilter, format: "rgba8", scale: 1, channels: { 0: { buffer: "A", frame: "current" } } },
  ],
  imageChannels: { 0: { buffer: "B", frame: "current" }, 1: { buffer: "A", frame: "current" } },
});

// 피드백(잔상): B가 A의 current와 자기 자신의 previous를 합친다.
const feedbackProject = () => ({
  image: comparison,
  passes: [
    { name: "A", fragment: movingDot, format: "rgba8", scale: 1, channels: {} },
    {
      name: "B",
      fragment: feedback,
      format: "rgba8",
      scale: 1,
      channels: { 0: { buffer: "A", frame: "current" }, 1: { buffer: "B", frame: "previous" } },
    },
  ],
  imageChannels: { 0: { buffer: "B", frame: "current" }, 1: { buffer: "A", frame: "current" } },
});

export { blank, common, pipelineProject, feedbackProject };
