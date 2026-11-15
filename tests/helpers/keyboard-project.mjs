// 테스트 전용: 키보드 입력 채널을 검사할 기반 장면(예전 갤러리의 Keyboard Control 예제).
// Buffer A(1×1)가 점의 상태를 저장한다: r = x, g = y, b = Space 토글, a = Space 누른 횟수.
// 브라우저 테스트가 await import("./tests/helpers/keyboard-project.js")로 불러 studio.setProject에 넘긴다.
// 키보드로 점 움직이기: Buffer A(1×1)가 점의 상태를 저장한다. iChannel0 = A · previous(직전 상태), iChannel1 = 키보드.
// 뷰포트를 클릭하면 키가 셰이더로 간다. 방향키·WASD로 이동, Space로 색 바꾸기(토글), Esc로 빠져나오기.
// 키 읽기 함수와 키 코드는 두 패스가 같이 쓰므로 Common 탭에 둔다(두 패스 모두 iChannel1에 키보드를 연결했다).
const keyboardCommon = `// Keyboard Control · Common: A(상태)와 Image(그리기)가 같이 쓰는 키 읽기.
// iChannel1은 패스마다 그 패스에 연결된 입력이다 — 이 예제는 두 패스 모두 iChannel1에 키보드를 연결했다.
// 키보드 텍스처 256×3: x = 키 코드, y = 0 지금 누름 · 1 이번 프레임에 눌림 · 2 누를 때마다 켜짐/꺼짐
const int KEY_LEFT = 37, KEY_UP = 38, KEY_RIGHT = 39, KEY_DOWN = 40, KEY_SPACE = 32;
const int KEY_A = 65, KEY_D = 68, KEY_S = 83, KEY_W = 87;
float keyDown(int k)    { return texelFetch(iChannel1, ivec2(k, 0), 0).x; }
float keyPressed(int k) { return texelFetch(iChannel1, ivec2(k, 1), 0).x; }
float keyToggled(int k) { return texelFetch(iChannel1, ivec2(k, 2), 0).x; }
`;
const keyboardState = `#version 300 es
precision highp float;
// Buffer A (1×1 상태 버퍼): xy = 점의 위치(0~1), z = 색 토글, w = Space를 누른 횟수
uniform int uFrame;
uniform float uDeltaTime;
uniform sampler2D iChannel0;   // A · previous
uniform sampler2D iChannel1;   // 키보드
// keyDown · keyPressed · keyToggled와 KEY_ 코드는 Common 탭에 있다.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 state = uFrame == 0 ? vec4(0.5, 0.5, 0.0, 0.0) : texelFetch(iChannel0, ivec2(0), 0);
    vec2 dir = vec2(max(keyDown(KEY_RIGHT), keyDown(KEY_D)) - max(keyDown(KEY_LEFT), keyDown(KEY_A)),
                    max(keyDown(KEY_UP), keyDown(KEY_W)) - max(keyDown(KEY_DOWN), keyDown(KEY_S)));
    if (dot(dir, dir) > 0.0) dir = normalize(dir);
    state.xy = clamp(state.xy + dir * 0.5 * uDeltaTime, 0.03, 0.97);
    state.z = keyToggled(KEY_SPACE);     // 누를 때마다 켜짐/꺼짐
    state.w += keyPressed(KEY_SPACE);    // 누른 순간 한 번만 더해진다
    fragColor = state;
}`;
const keyboardImage = `#version 300 es
precision highp float;
// Image: A의 상태를 읽어 점을 그리고, 방향키 네 개의 눌림 상태를 아래에 보여 준다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;   // A · current
uniform sampler2D iChannel1;   // 키보드
// keyDown과 KEY_ 코드는 Common 탭에 있다.

float box(vec2 p, vec2 c, float r) { vec2 d = abs(p - c) - r; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / uResolution, aspect = vec2(uResolution.x / uResolution.y, 1.0);
    vec4 state = texelFetch(iChannel0, ivec2(0), 0);
    vec3 col = mix(vec3(0.05, 0.06, 0.09), vec3(0.11, 0.13, 0.2), uv.y);
    // 점: Space 토글로 색이 바뀐다. 누른 횟수(w)만큼 고리가 생긴다.
    float d = length((uv - state.xy) * aspect);
    vec3 dotColor = state.z > 0.5 ? vec3(1.0, 0.5, 0.2) : vec3(0.3, 0.75, 1.0);
    col = mix(col, dotColor, smoothstep(0.032, 0.028, d));
    float rings = min(state.w, 6.0);
    col += dotColor * 0.5 * smoothstep(0.004, 0.0, abs(d - 0.05 - 0.012 * floor(mod(rings, 7.0)))) * step(0.5, rings);
    // 방향키 표시(←↓→, ↑): 누르면 밝아진다
    vec2 p = (uv - vec2(0.5, 0.11)) * aspect / 0.05;
    float k[4] = float[4](keyDown(KEY_LEFT), keyDown(KEY_DOWN), keyDown(KEY_RIGHT), keyDown(KEY_UP));
    vec2 at[4] = vec2[4](vec2(-1.1, 0.0), vec2(0.0, 0.0), vec2(1.1, 0.0), vec2(0.0, 1.1));
    for (int i = 0; i < 4; i++) {
        float b = box(p, at[i], 0.45);
        col = mix(col, mix(vec3(0.22, 0.25, 0.32), vec3(0.95), k[i]), smoothstep(0.04, 0.0, b));
    }
    fragColor = vec4(col, 1.0);
}`;

const project = {
      image: keyboardImage,
      common: keyboardCommon,
      passes: [
        {
          name: "A",
          fragment: keyboardState,
          format: "rgba16f",
          scale: 1,
          size: [1, 1],
          filter: "nearest",
          channels: { 0: { buffer: "A", frame: "previous" }, 1: { keyboard: true } },
        },
      ],
      imageChannels: { 0: { buffer: "A", frame: "current" }, 1: { keyboard: true } },
    };

export { project };
