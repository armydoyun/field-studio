// 앱 내장 가이드: 주제별 설명·검색·코드 예시(편집기 삽입)·UI 둘러보기 투어·문맥 도움말(?) 버튼.
// 내용은 아래 TOPICS 데이터로만 정의한다. 문단 안의 `코드`와 **강조**만 서식으로 해석하고 HTML은 해석하지 않는다.
// 코드 조각 라이브러리의 내용은 snippets.js가 소유하고, 여기서는 범주 탭·검색·삽입 UI만 담당한다.
// 입문 과정(단계별 수업·예제 프로젝트)의 내용은 course.js가 소유하고, 여기서는 진행률·이전/다음·완료 표시를 담당한다.
import * as Snippets from "./snippets.js";
import * as Course from "./course.js";
import * as Reference from "./glsl-reference.js";
import * as Highlight from "./glsl-highlight.js";
import * as SnippetPreview from "./snippet-preview.js";
import * as Store from "./storage.js";
import * as PreviewDOM from "./preview-dom.js";
// 블록 형식: {p}, {list:[…]}, {steps:[…]}, {table:{head, rows}}, {code, title, insert?:true}, {keys:[[설명, 키]…]},
//            {note}, {actions:[{label, run:"tour"|"gallery"|"topic:<id>"|"example:<id>"}]}
const TOPICS = [
  {
    id: "start",
    title: "시작하기",
    summary: "처음 3분 안에 셰이더를 고쳐 보기",
    blocks: [
      {
        p: "FIELD Studio는 브라우저에서 GLSL 프래그먼트 셰이더를 작성하고 결과를 바로 보는 오프라인 셰이더 작업실입니다. 서버나 인터넷이 필요 없습니다.",
      },
      {
        steps: [
          "**예제 고르기** — 뷰포트 툴바의 ⋯ 더보기 › **예제 갤러리**(또는 `X`)로 갤러리를 열고 마음에 드는 예제를 선택합니다. 맨 위 검색창(`/`)에 `SDF`·`유체`·작가 이름 등을 넣어 찾을 수도 있어요.",
          "**코드 고치기** — `E`로 편집기를 열고 숫자 하나를 바꿔 보세요. 0.9초 뒤 자동으로 적용됩니다(`Alt+Enter`는 즉시 실행, `Ctrl+S`는 프로젝트 저장).",
          "**값 조절하기** — 설정 패널의 **파라미터** 탭에서 슬라이더·색상으로 Uniform 값을 실시간으로 바꿉니다.",
          "**확인하기** — **성능** 탭에서 GPU 시간과 버퍼 내용을 들여다봅니다.",
        ],
      },
      {
        p: "**가장 작은 셰이더** — 아래 코드는 화면 좌표를 색으로 바꿉니다. **이 코드로 시작**을 누른 뒤 `0.5`나 `sin` 안의 값을 바꿔 보세요.",
      },
      {
        code: `#version 300 es
precision highp float;
uniform vec2 uResolution;   // 화면 픽셀 크기
uniform float uTime;        // 재생 시간(초)

void mainImage(out vec4 fragColor, in vec2 fragCoord) {   // 픽셀마다 실행된다
    vec2 uv = fragCoord / uResolution;              // 0~1 화면 좌표
    vec3 col = vec3(uv, 0.5 + 0.5 * sin(uTime));    // x → 빨강, y → 초록, 시간 → 파랑
    fragColor = vec4(col, 1.0);
}`,
        title: "첫 셰이더 · 좌표를 색으로",
        start: true,
      },
      {
        actions: [
          { label: "UI 둘러보기 시작", run: "tour" },
          { label: "예제 갤러리 열기", run: "gallery" },
          { label: "첫 셰이더 구조 보기", run: "topic:editor" },
        ],
      },
      {
        note: "**셰이더가 처음인가요?** C와 GLSL 문법을 안다면 **입문 과정**(12단계)을 따라가 보세요. 픽셀 하나의 관점부터 버퍼로 만드는 시뮬레이션까지, 단계마다 바로 실행되는 예제와 과제가 있습니다.",
      },
      { actions: [{ label: "입문 과정 시작 →", run: "topic:course" }] },
      { note: "실수해도 괜찮습니다. 편집기의 `Ctrl+Z`는 코드뿐 아니라 버퍼 구성·파라미터 변경까지 되돌립니다." },
    ],
  },
  {
    id: "screen",
    title: "화면 구성",
    summary: "뷰포트 · 툴바 · 설정 패널 · 편집기",
    blocks: [
      {
        table: {
          head: ["영역", "역할"],
          rows: [
            ["뷰포트", "셰이더 결과. 3D 예제에서는 드래그로 회전, 휠로 확대합니다."],
            [
              "툴바(오른쪽 위)",
              "재생/일시정지 · 편집기 · 캡처(스크린샷·녹화) · 전체화면 · ⋯ 더보기(갤러리·가이드·패널·HUD·분리 창·테마)",
            ],
            [
              "HUD(오른쪽 아래)",
              "FPS · 렌더 해상도 · 시간(uTime, 배속) · 프레임 수 · GPU 시간(지원 시). 미리보기를 분리 창으로 옮기면 HUD도 그 창에 보이고, 분리 창에서도 G로 숨깁니다. G는 위쪽 도구 막대까지 모든 HUD를 숨겨 셰이더만 남기고, 다시 G나 Esc로 되돌립니다",
            ],
            ["설정 패널(기본 왼쪽)", "렌더링 품질 · 파라미터 · 성능/디버그 · 작업공간 탭"],
            ["편집기", "패스 탭(Image · Common · Buffer) · 입력 채널 · GLSL 코드 · 오류 표시"],
          ],
        },
      },
      {
        p: "넓은 화면에서는 편집기가 캔버스 오른쪽에 나란히 열립니다. 편집기 머리의 손잡이(⠿)를 끌어 미리보기의 왼쪽·오른쪽·위·아래 중 원하는 자리에 놓을 수 있고, 설정 패널도 머리의 손잡이를 끌어 화면 왼쪽·오른쪽으로 옮깁니다. 손잡이에 초점을 두고 방향키를 눌러도 됩니다. 경계선을 끌면 편집기와 패널의 크기가 바뀌고, 두 번 클릭하면 기본 크기로 돌아갑니다. 작업공간 탭의 '화면 배치 초기화'로 한 번에 처음 배치로 되돌립니다. 좁은 화면에서는 패널이 서랍으로, 편집기가 아래로 고정됩니다.",
      },
      { actions: [{ label: "UI 둘러보기로 직접 확인", run: "tour" }] },
    ],
  },
  {
    id: "editor",
    title: "셰이더 작성 기본",
    summary: "GLSL ES 3.00 구조 · 실행 · 오류 읽기",
    blocks: [
      {
        p: "모든 패스는 GLSL ES 3.00(`#version 300 es`) 프래그먼트 셰이더입니다. 화면의 각 픽셀마다 `mainImage(fragColor, fragCoord)`가 실행되어 `fragColor`에 그 픽셀의 색을 씁니다. `fragCoord`는 픽셀 중심 좌표(`gl_FragCoord.xy`)입니다. 갤러리 예제와 입문 과정도 모두 이 모양입니다.",
      },
      {
        code: `#version 300 es
precision highp float;
uniform vec2 uResolution;   // 현재 패스의 픽셀 크기
uniform float uTime;        // 재생 시간(초)

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / uResolution;   // 0~1 좌표
    vec3 color = 0.5 + 0.5 * cos(uTime + uv.xyx + vec3(0, 2, 4));
    fragColor = vec4(color, 1.0);
}`,
        title: "가장 작은 셰이더",
        insert: "replace",
      },
      { heading: "mainImage와 main() · 짧게 쓰기" },
      {
        p: "GPU가 실제로 부르는 진입점은 GLSL의 `main()`입니다. 코드에 `main()`이 없으면 실행할 때 앱이 `main()`을 만들어 `mainImage(색, gl_FragCoord.xy)`를 부르고 그 색을 출력합니다(Shadertoy와 같은 방식). 여러 출력(MRT)은 `out vec4` 매개변수를 출력 수만큼 받습니다(**MRT · 다중 출력**).",
      },
      {
        p: "`#version 300 es`와 `precision highp float;`도 생략할 수 있습니다. 없으면 실행할 때 자동으로 붙이고, 오류 줄 번호는 편집기 줄 그대로 나옵니다.",
      },
      {
        code: `uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;

void main() {   // main()을 직접 쓰면 그쪽이 진입점이고 mainImage는 보통 함수다
    vec2 uv = gl_FragCoord.xy / uResolution;
    fragColor = vec4(0.5 + 0.5 * cos(uTime + uv.xyx + vec3(0, 2, 4)), 1.0);
}`,
        title: "머리말 없이 · main()으로 직접",
        insert: "replace",
      },
      {
        list: [
          "앱 이름의 Uniform은 직접 선언합니다: `uTime` · `uResolution`(vec2) · `uMouse` · `uFrame` · `uDeltaTime`(**내장 Uniform** 참고). 자동 완성으로 고르면 선언 줄도 함께 들어갑니다.",
          "Shadertoy 이름 `iTime` · `iTimeDelta` · `iFrame` · `iResolution`(vec3) · `iMouse`는 선언 없이 그대로 써도 됩니다. 실행할 때 앱이 위 Uniform에 연결합니다(필요하면 그 Uniform 선언도 넣습니다). 그래서 Shadertoy 코드를 붙여 넣으면 대부분 바로 돌아갑니다.",
          "`iMouse`는 `uMouse`(vec4)와 같은 값입니다. Shadertoy와 달리 xy는 누르지 않아도 포인터를 따라가고, 포인터가 뷰포트 밖이면 -1입니다. `iDate` · `iFrameRate` · `iChannelTime`은 아직 없습니다.",
          "`mainImage`를 쓰면서 출력 변수(`out vec4 …;`)를 직접 선언했으면 그 변수로 출력합니다.",
          "`.frag`로 저장한 파일은 쓴 그대로라, 다른 프로그램에서 쓰려면 머리말 · `main()` · Common을 직접 넣고 Shadertoy 이름은 앱 이름으로 바꿔야 합니다. 작품을 그대로 보여 주려면 **HTML로 내보내기**(프로젝트 메뉴)를 쓰세요.",
        ],
      },
      {
        list: [
          "**자동**이 켜져 있으면 입력을 멈춘 뒤 0.9초에 자동 적용, 꺼져 있으면 **실행**(`Alt+Enter`)으로 적용합니다. 예전처럼 `Ctrl+S`로 실행하려면 편집기 ⋯ 메뉴의 **Ctrl+S로 실행**을 켭니다.",
          "컴파일 오류는 해당 줄이 **빨간 띠**로 표시되고 줄 끝에 메시지가 나옵니다. 아래 목록을 누르면 그 줄로 이동합니다.",
          "오류가 있어도 화면은 마지막으로 성공한 결과를 유지합니다.",
          "`Ctrl+Space` 자동 완성, `Ctrl+F` 검색, `Ctrl+/` 주석, `Alt+↑↓` 줄 이동을 지원합니다.",
        ],
      },
      { heading: "편집기 화면" },
      {
        table: {
          head: ["위치", "내용"],
          rows: [
            [
              "맨 위 줄",
              "패스 탭과 **+**(버퍼 추가) · **+ Common**(공용 코드 탭, 없을 때만) · 되돌리기/다시 실행 · **자동** · **실행** · 재생/정지 · 시간 초기화 · 집중 모드 · 닫기",
            ],
            [
              "입력 줄",
              "선택한 패스의 **iChannel0–3** 칩. `A cur`처럼 버퍼와 읽는 시점을, 빈 칸은 **＋**를 보여 줍니다. 칩을 누르면 읽는 시점(current/previous) · 버퍼 · 이미지 · **이미지 불러오기…** · 연결 해제를 고릅니다. 이미지 파일을 칩에 끌어다 놓아도 됩니다. 코드가 읽지 않는 채널은 흐리게, **코드가 읽는데 비어 있으면 노란 점**으로 알려 줍니다. 연결이 없는 패스에서는 이 줄이 접혀 있습니다. 코드 머리줄 파일 이름 옆의 **입력 ▾** 버튼으로 펴고 접으며, 버튼에는 연결 수와 빈 채널 경고 점이 표시됩니다.",
            ],
            [
              "버퍼 설정",
              "Buffer 탭을 고르면 나타나는 한 줄 요약. 누르면 형식·크기·출력 수·필터·가장자리·밉맵과 순서·복제·삭제가 펼쳐집니다. Common 탭에서는 삭제만 있습니다.",
            ],
            [
              "코드 머리줄",
              "파일 이름과 실행 상태 · 함수 목록 · 검색 · 줄 이동 · 자동 완성 · 코드 조각 · **⋯ 메뉴**(찾아 바꾸기, 텍스처 코드 삽입, .frag 파일, 글자 크기·들여쓰기·줄바꿈, 배치, 도움말)",
            ],
            ["맨 아래 줄", "최근 메시지 · 브라우저 보관 상태 · 커서 위치"],
          ],
        },
      },
      { heading: "자동 완성" },
      {
        list: [
          "이름을 치기 시작하면 **커서 바로 아래**에 후보가 뜹니다(`Ctrl+Space`로 직접 열 수도 있음). `↑↓`·`PageUp/Down`으로 고르고 `Enter`·`Tab`으로 넣습니다.",
          "글자를 건너뛰어도 찾습니다: `smst` → `smoothstep`, `fbmS` → `fbm3Simplex`. 이 파일의 변수·함수가 먼저, 그다음 Uniform·내장 함수 순으로 정렬됩니다.",
          "오른쪽(좁으면 아래) 설명 칸에 시그니처와 설명이 나옵니다. 아이콘: `x` 변수 · `ƒ` 함수 · `u` Uniform · `T` 타입 · `k` 키워드 · `{}` 템플릿 · `+` 코드 조각 모음.",
          "`uv.` · `col.`처럼 **점을 찍으면** 그 변수 타입에 맞는 성분(`x y xy rgb …`)이나 구조체 필드를 제안합니다.",
          "**템플릿**: `for` · `if` · `ifelse` · `func` · `main` · `struct` · `uniform-range` · `uniform-color` · `uv-center` · `frag` … 넣은 뒤 `Tab`으로 다음 자리로 이동하고, `Esc`로 끝냅니다.",
          "`uTime`·`uMouse`·`iChannel0`처럼 **선언하지 않은 앱 Uniform**을 고르면 선언 줄을 맨 위에 함께 넣습니다. `iTime`·`iResolution` 같은 Shadertoy 이름은 선언 없이 쓰는 이름이라 이름만 넣습니다.",
          "`fbm3`·`sdHexagon`처럼 **코드 조각 모음의 함수 이름**(`+` 아이콘)을 고르면 함수 정의(필요한 보조 함수 포함)가 위쪽에 자동으로 추가됩니다. `Ctrl+Z` 한 번이면 정의만 되돌아갑니다.",
          "새 변수 이름을 짓는 자리(`float ` 다음 등)에서는 목록이 저절로 뜨지 않습니다.",
        ],
      },
      { heading: "코드 다루기 도우미" },
      {
        list: [
          "**시그니처 도움말** — `mix(`처럼 호출 괄호 안에 있으면 커서 위에 매개변수가 뜨고, 지금 쓰는 인수가 **굵게 밑줄**로 표시됩니다. 내장 함수와 이 패스의 함수 모두 지원합니다.",
          "**마우스 설명** — 이름 위에 마우스를 잠시 올리면 내장 함수 설명, 변수 타입과 선언 줄, Uniform 설명이 뜹니다.",
          "**화면 표시** — 현재 줄, 커서 옆 괄호의 짝, 선택한 이름과 같은 다른 위치가 은은하게 강조됩니다. 들여쓰기는 세로 **안내선**으로 보입니다.",
          "**색 견본** — `vec3(1.0, 0.5, 0.0)`·`vec4(…)`처럼 0~1 숫자로만 된 색 앞에 작은 색 견본이 붙습니다. 누르면 **색상 선택기**로 값을 바꿉니다(`Ctrl+Z`로 되돌리기). 값은 변환 없이 0~1로 들어갑니다.",
          "**여러 커서** — `Ctrl+D`는 커서 아래 단어를 고르고 다시 누를 때마다 다음 같은 이름을 더합니다(`Ctrl+Shift+L`은 모두). `Alt+클릭`으로 커서를 추가하고, `Ctrl+Alt+↑/↓`로 위·아래 줄에 커서를 놓고, `Shift+Alt+I`로 선택한 줄마다 줄 끝에 커서를 두고, `Shift+Alt+드래그`로 사각형 영역을 고릅니다. 화살표·입력이 모든 커서에 함께 적용되고 `Esc`로 하나로 돌아갑니다.",
          "**코드 접기** — 줄 번호 옆 화살표나 `Ctrl+Shift+[` / `Ctrl+Shift+]`로 `{ }` 블록을 접고 폅니다. `Ctrl+K Ctrl+0` / `Ctrl+K Ctrl+J`는 모두 접기·펴기(VS Code와 같은 연속 입력).",
          "**찾기 · 바꾸기** — `Ctrl+F`는 찾기만, `Ctrl+H`는 찾아 바꾸기(바꿀 내용 줄이 함께 열림)입니다. 창 안에서도 두 키로 오가고, 찾기 칸 왼쪽 `›` 버튼으로 바꾸기 줄을 여닫습니다. 찾기 칸에서 `Enter`/`Shift+Enter`로 다음·이전 일치로 가고, 바꾸기 줄이 열려 있으면 `Tab`으로 바로 바꿀 내용 칸으로 갑니다. 대소문자(`Alt+C`)·단어 단위(`Alt+W`)·정규식(`Alt+R`)을 켤 수 있고, 정규식으로 바꿀 때 `$1`·`$&`를 씁니다.",
          "**오류** — 컴파일 오류가 난 줄에 표시가 붙고 줄 끝에 이유가 나옵니다. `F8`·`Shift+F8`로 오류 사이를 오가고, `Ctrl+Shift+M`으로 목록을 엽니다.",
          "**주석** — `Ctrl+/` 줄 주석, `Shift+Alt+A` 블록 주석(`/* */`).",
          "**정의로 이동** — `F12` 또는 `Ctrl+클릭`. **이름 바꾸기** — `F2`. VS Code처럼 커서 아래 이름이 가리키는 그 변수·함수만 바꿉니다(다른 함수의 같은 이름, 안쪽 블록에서 가린 이름은 그대로). Uniform은 다른 패스의 같은 Uniform과 파라미터 값까지 함께 바꾸고, 새 이름이 겹치면 무엇이 바뀌는지 보여 주고 다시 묻습니다. 구조체 필드도 그 구조체의 필드만 바꿉니다(`.` 앞 식의 타입을 따라가므로 다른 구조체의 같은 이름 필드·벡터 성분 `.xyz`는 그대로). 내장 이름은 바꾸지 않고, `#define` 매크로는 이 패스의 같은 이름을 모두 바꿉니다.",
          "**명령 팔레트** — VS Code와 같습니다. `Ctrl+Shift+P`(또는 `F1`, ⋯ 메뉴)는 `>` 명령, `Ctrl+P`는 패스(Image · Common · Buffer)로 이동, `Ctrl+Shift+O`는 `@` 함수·Uniform, `Ctrl+G`는 `:` 줄 번호. 입력 칸에서 접두어를 바꿔 다른 목록으로 넘어갈 수 있습니다.",
          "**숫자 조절** — 숫자 위에 커서를 두고 `Ctrl+↑`/`Ctrl+↓`로 마지막 자릿수 단위만큼 올리고 내립니다(`Shift`를 함께 누르면 10배). `0.25`는 0.01씩, `3.`은 1씩 바뀝니다.",
          "**끌어서 조절** — `Alt`를 누른 채 숫자를 좌우로 끌면 값이 바뀌며 화면이 바로 따라옵니다. 한 번 끈 것은 `Ctrl+Z` 한 번으로 되돌아갑니다.",
        ],
      },
    ],
  },
  {
    id: "builtins",
    title: "GLSL 내장 함수",
    summary: "수학 · 벡터 · 텍스처 · 미분 · 문법 레퍼런스",
    blocks: [
      {
        p: "GLSL ES 3.00(WebGL2)에서 쓸 수 있는 내장 함수와 변수입니다. 범주를 고르거나 위 검색창에 이름·설명으로 찾으세요(예: `mix`, `보간`, `atan2`). **C 대응** 줄은 C 표준 라이브러리로 쓰면 무엇인지 보여줍니다.",
      },
      {
        note: "시그니처의 **T**는 `float`·`vec2`·`vec3`·`vec4` 중 하나로, 벡터에 쓰면 성분마다 따로 계산합니다. **I**는 int 계열, **U**는 uint 계열, **B**는 bool 계열입니다.",
      },
      { reference: true },
    ],
  },
  {
    id: "uniforms",
    title: "내장 Uniform",
    summary: "렌더러가 자동으로 넣어주는 값",
    blocks: [
      {
        p: "아래 이름을 GLSL에 선언하기만 하면 렌더러가 매 프레임 값을 넣습니다. 별도 등록이 필요 없습니다. 허용 타입이 아니면 값 전달을 건너뛰고 상태줄에 알려줍니다. Shadertoy 이름(`iTime` 등)은 선언 없이 씁니다(아래).",
      },
      {
        table: {
          head: ["이름", "타입", "내용"],
          rows: [
            ["uResolution", "vec2 | vec3", "현재 패스의 픽셀 크기 (vec3이면 z=1)"],
            ["uTime / uDeltaTime", "float", "재생 시간 / 직전 프레임 간격(초). 일시정지 중에는 멈춤"],
            ["uFrame", "int | float | uint", "누적 프레임 수. Reset·구조 변경 시 0"],
            [
              "uMouse",
              "vec2 | vec4",
              "포인터 픽셀 좌표(밖이면 -1). vec4면 zw=클릭 위치, z>0 누르는 중, w>0 누른 첫 프레임",
            ],
            [
              "uWheel",
              "float",
              "뷰포트에서 굴린 휠의 누적 칸 수(위로 +1). 시간 초기화 시 0. 선언하면 휠이 페이지 대신 셰이더로 갑니다",
            ],
            [
              "iChannel0~3",
              "sampler2D",
              "편집기에서 연결한 버퍼 · 이미지 · 키보드 · 미디어(마이크 · 오디오 · 웹캠 · 영상)",
            ],
            ["iChannelResolution[4]", "vec3", "각 채널 입력의 크기(연결이 없거나 꺼진 미디어는 0)"],
          ],
        },
      },
      {
        p: "**Shadertoy 이름** — 아래 이름은 선언하지 않고 쓰면 실행할 때 앱이 위 Uniform에 연결합니다(코드에서 같은 이름을 직접 선언하거나 `#define`했으면 건드리지 않습니다).",
      },
      {
        table: {
          head: ["Shadertoy 이름", "타입", "연결되는 값"],
          rows: [
            ["iTime / iTimeDelta", "float", "uTime / uDeltaTime"],
            ["iFrame", "int", "uFrame"],
            ["iResolution", "vec3", "(uResolution.xy, 1.0)"],
            ["iMouse", "vec4", "uMouse — xy는 누르지 않아도 포인터를 따라가고 뷰포트 밖이면 -1(Shadertoy와 다름)"],
          ],
        },
      },
      { note: "`iDate` · `iFrameRate` · `iChannelTime` · `iSampleRate`는 아직 없습니다." },
      {
        code: `uniform vec4 uMouse;
// ...
bool held   = uMouse.z > 0.0;          // 버튼을 누르고 있는 동안
bool tapped = uMouse.w > 0.0;          // 누른 직후 첫 프레임만
vec2 click  = abs(uMouse.zw);          // 마지막 클릭 위치(픽셀)`,
        title: "마우스 클릭 읽기",
        insert: "cursor",
      },
      {
        code: `uniform float uWheel;
// ...
float zoom = exp2(uWheel * 0.25);      // 휠 한 칸마다 약 1.19배, 위로 굴리면 확대
vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y / zoom;`,
        title: "휠로 확대하기",
        insert: "cursor",
      },
    ],
  },
  {
    id: "params",
    title: "파라미터 · 어노테이션",
    summary: "슬라이더·색상으로 값 조절",
    blocks: [
      {
        p: "파라미터는 직접 등록하는 Uniform입니다. **파라미터** 탭의 **+ 파라미터 추가**로 만들거나, 아래처럼 **GLSL 주석에 어노테이션**을 달면 컴파일 성공 시 자동으로 등록됩니다.",
      },
      {
        code: `uniform float uSpeed;  // @range 0 4 @step 0.01 @default 1.5
uniform vec3  uTint;   // @color @default 0.9 0.3 0.6
uniform vec3  uSun;    // @dir @default 0.4 0.8 0.45
uniform float uSpin;   // @angle @default 45deg
uniform vec2  uCenter; // @pos @range 0 1 @default 0.5
uniform float uScale;  // @log @range 0.01 100 @default 1
uniform int   uView;   // @enum 결과 밀도 법선 @default 0
uniform vec3  uGlow;   // 발광 · @color hdr 20 @default 2 1 0.4 @group 빛
uniform float uSeed;   // 무늬 고르기 · @seed @range 0 100 @step 1 @group 무늬
uniform float uWave;   // 물결 · @range 0 2 @anim 3 @group 무늬
uniform vec2  uOffset; // @range -1 1 @default 0
uniform int   uCount;  // @min 1 @max 32 @default 8`,
        title: "어노테이션 예시",
        insert: "cursor",
      },
      {
        table: {
          head: ["태그", "의미"],
          rows: [
            ["@range min max [step]", "슬라이더 범위(벡터는 성분마다 같은 범위)"],
            ["@min · @max · @step", "범위를 따로 지정"],
            ["@default v…", "처음 등록할 때의 값이자 ↺ 버튼으로 되돌아갈 값. 값 하나면 모든 성분에 적용"],
            ["@color", "vec3/vec4를 색상 선택기로 표시(값 0~1)"],
            [
              "@dir [hemi]",
              "vec2/vec3를 단위 방향으로 표시. vec2는 다이얼, vec3는 빛 받은 구 패드 + 방위각·고도. 값은 늘 길이 1. hemi는 +Y 쪽 반구만",
            ],
            [
              "@angle",
              "float 각도를 다이얼로. 화면은 0~360°와 누적 회전 수, 셰이더·저장은 누적 라디안. 숫자·프리셋은 현재 값과 가까운 회전으로 연결. 720°·-90°처럼 범위 밖 숫자는 누적 각도로 직접 지정",
            ],
            [
              "@pos · @xy",
              "vec2 위치를 2D 패드로. 범위는 @range(없으면 -1~1), 화면 위쪽이 +Y. Shift로 1/8 격자에 맞춤",
            ],
            ["@log", "float를 로그 눈금 슬라이더로. 0보다 큰 @range 필요(예: 0.01~100)"],
            ["@enum 이름…", "int/uint를 이름 붙은 버튼(많으면 드롭다운)으로. 0부터 차례로, 이름의 _는 빈칸"],
            ["값 끝 deg", "@default 45deg처럼 쓰면 도를 라디안으로 바꿔 읽음"],
            ["@color hdr [최대]", "색 + 밝기 배율(I) 슬라이더. 값이 1을 넘는 발광·조명 색. 최대 밝기 기본 10"],
            ["@seed", "🎲 버튼으로 무작위 값(범위 안, step 단위). 범위가 없으면 int 0~99999 · float 0~1000"],
            [
              "@anim [초]",
              "▶ 버튼으로 범위를 왕복 재생(기본 4초, 값은 @step 단위로 맞춘다). @angle이면 그 시간에 한 바퀴, int/uint는 한 칸씩 왕복, @enum은 선택지마다 그 시간씩 머물며 순환. 값을 직접 바꾸면 멈춤",
            ],
            ["@group 이름", "패널에서 접히는 묶음으로 모은다. 묶음 없는 파라미터가 먼저 나온다"],
            ["설명", "주석에서 첫 @ 앞의 글(`// 햇빛 · @color`)은 이름 아래 설명으로 보인다"],
            [
              "@gradient [linear·smooth·step]",
              "sampler2D를 색 램프로. 정지점을 끌어 옮기고 빈 곳을 눌러 추가. @default 0 #000000 1 #ffffff(위치 + #RRGGBB[AA])",
            ],
            [
              "@curve [smooth·linear]",
              "sampler2D를 값 곡선으로(.r). 점을 끌거나 빈 곳을 눌러 추가, 더블클릭으로 삭제. y 범위는 @range(기본 0~1)",
            ],
          ],
        },
      },
      {
        list: [
          "이미 등록된 파라미터는 **값을 유지**하고 범위·표시 방식만 갱신합니다(범위를 벗어난 값은 안으로 보정).",
          "**기본값으로 되돌리기** — 어노테이션이 달린 파라미터는 이름 옆 **↺** 버튼이나 **슬라이더 더블클릭**으로 `@default` 값(없으면 처음 등록된 값)으로 돌아갑니다. 이미 기본값이면 버튼이 흐려집니다.",
          "지원 타입: float · int · uint · bool · vec2~4 · ivec · uvec · bvec · mat2~4 · sampler2D(그라데이션·곡선, 최대 8개) (모두 합쳐 최대 64개).",
          "**램프 읽기** — `texture(uRamp, vec2(t, 0.5)).rgb`(그라데이션 색), `texture(uCurve, vec2(x, 0.5)).r`(곡선 값). t·x는 0~1이고 밖은 끝 값으로 고정됩니다. 256칸이라 사이는 선형으로 이어집니다(step 모드는 끊김).",
          "**성능** 탭의 Uniform 진단에서 선언만 하고 등록하지 않은(값이 항상 0인) Uniform을 찾아 **등록** 버튼으로 바로 파라미터로 만들 수 있습니다.",
        ],
      },
      { actions: [{ label: "어노테이션 예제 열기", run: "example:annotations" }] },
    ],
  },
  {
    id: "buffers",
    title: "버퍼 · 멀티패스",
    summary: "여러 패스를 연결하고 이전 프레임 읽기",
    blocks: [
      {
        p: "편집기 패스 탭 옆의 **+**로 오프스크린 패스(A~H)를 추가합니다. 각 패스는 위에서 아래 순서로 실행되고, 마지막에 **Image**가 화면에 그려집니다.",
      },
      {
        p: "**미리보기** — 패스 탭을 고르면 뷰포트가 그 버퍼를 보여 줍니다. 코드 머리줄의 **미리보기 버튼**(눈 아이콘 + `Buffer A`)을 누르면 최종 Image와 오가고, 버퍼를 고치는 동안에도 고른 미리보기가 그대로 유지됩니다. 옆의 **고정**(핀)을 켜면 탭을 바꿔도 미리보기가 바뀌지 않습니다(예: 버퍼를 고치며 Image만 보기).",
      },
      {
        table: {
          head: ["연결", "의미"],
          rows: [
            ["current", "이번 프레임에 **앞서 실행된** 버퍼의 결과. 자기 자신·뒤 패스는 선택 불가"],
            ["previous", "직전 프레임에 저장된 결과. 자기 자신을 연결하면 **피드백(누적)**"],
          ],
        },
      },
      {
        code: `uniform sampler2D iChannel0;   // 자기 자신(previous)을 연결
uniform int uFrame;
// ...
vec4 history = uFrame == 0 ? vec4(0.0) : texture(iChannel0, gl_FragCoord.xy / uResolution);
fragColor = max(newColor, history * 0.97);   // 잔상 누적`,
        title: "피드백 읽기",
        insert: "cursor",
      },
      {
        p: "**Common** — 패스 탭 옆의 **+ Common**을 누르면 모든 패스(Image · Buffer)가 같이 쓰는 공용 코드 탭이 생깁니다. 여기에 쓴 함수 · 상수 · `#define` · 구조체는 실행할 때 각 패스의 머리말 바로 뒤, 패스 코드보다 앞에 붙으므로, 해시 · 노이즈 같은 함수를 패스마다 복사하지 않아도 됩니다. `mainImage`는 각 패스에 둡니다.",
      },
      {
        code: `// Common — uTime · uResolution · iChannel0 · iTime 같은 이름을 그대로 쓴다
uniform float uSpeed;   // Common이 쓰는 파라미터는 Common에 선언 · @range 0 4 @default 1
float wave(vec2 p) { return sin(p.x * 10.0 + uTime * uSpeed); }
vec4 history(vec2 fragCoord) { return texture(iChannel0, fragCoord / uResolution); }

// Buffer A · Image — 여느 함수처럼 부른다
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    fragColor = vec4(vec3(0.5 + 0.5 * wave(fragCoord / uResolution.y)), 1.0);
}`,
        title: "Common의 함수를 패스에서 쓰기",
      },
      {
        list: [
          "Common에서 앱 Uniform(`uTime` · `uResolution` · `uMouse` · `uFrame` · `uDeltaTime` · `uWheel` · `iChannel0~3` · `iChannelResolution`)과 Shadertoy 이름(`iTime` …)을 선언 없이 그대로 씁니다. 패스가 선언하지 않았으면 실행할 때 그 패스에 선언을 넣고, 패스가 선언했으면 그 선언(타입)을 씁니다.",
          "패스가 선언한 Uniform도 Common에서 쓸 수 있습니다: 실행할 때 패스의 `uniform` 선언을 Common 앞으로 옮깁니다(편집기 코드는 그대로이고, 오류 줄 번호도 원래 줄입니다). 다만 Common은 **모든** 패스에 붙으므로, 한 패스에만 선언한 Uniform을 쓰면 다른 패스에서 오류가 납니다 — 여러 패스가 쓰는 **파라미터는 Common에 선언**하세요(어노테이션도 Common에서 읽습니다).",
          "`iChannelN`은 패스마다 그 패스에 연결된 입력을 읽습니다. Common의 함수가 `iChannel1`을 읽으면, 그 함수를 부르는 패스마다 iChannel1에 같은 종류(예: 키보드)를 연결하세요. 예제 갤러리의 **Keyboard Control**이 이렇게 씁니다.",
          "Image · Buffer 탭의 자동 완성 · 마우스 설명 · 시그니처 도움말이 Common의 함수 · 상수 · 구조체 · `#define`도 압니다. `F12`(또는 `Ctrl+클릭`)로 Common에 있는 정의로 바로 갑니다.",
          "Common만 고쳐도 모든 패스가 다시 컴파일됩니다. Common에서 난 오류는 **Common** 탭의 그 줄로 표시됩니다(어느 패스를 컴파일하다 났는지도 함께 적습니다).",
          "Common 탭을 고른 뒤 설정 줄의 **삭제**로 지울 수 있습니다(Undo로 복원). `Common`은 Buffer 이름으로 쓸 수 없습니다.",
        ],
      },
      {
        p: "Buffer 탭을 선택하면 코드 위에 **버퍼 설정** 요약 줄(예: `A · RGBA8 · 100% · Linear · Clamp`)이 나타나고, 누르면 아래 설정이 펼쳐집니다.",
      },
      {
        table: {
          head: ["설정", "설명"],
          rows: [
            ["형식", "RGBA8(일반) · RGBA16F/32F(HDR·음수·시뮬레이션)"],
            ["크기", "화면 비율(100%~12.5%) 또는 고정 해상도(64²~1024²)"],
            ["출력 수", "출력 수(MRT) 1~4 — 아래 MRT 주제 참고"],
            ["필터 · 가장자리", "다른 패스가 읽을 때의 필터, 0~1 밖 좌표 처리(clamp/repeat/mirror)"],
            ["밉맵", "매 프레임 밉맵 생성 → `textureLod`로 흐림·평균 (메모리 +33%)"],
          ],
        },
      },
      {
        actions: [
          { label: "반응-확산 시뮬레이션 열기", run: "example:reaction" },
          { label: "밉맵 블러 예제 열기", run: "example:mipblur" },
          { label: "MRT 주제 보기", run: "topic:mrt" },
        ],
      },
    ],
  },
  {
    id: "mrt",
    title: "MRT · 다중 출력",
    summary: "한 패스에서 여러 텍스처에 쓰기",
    blocks: [
      {
        p: "버퍼 설정의 **출력 수**를 2 이상으로 하면 한 번의 실행으로 여러 출력에 씁니다. 위치·속도처럼 묶인 데이터를 저장할 때 유용합니다.",
      },
      {
        code: `void mainImage(out vec4 outColor, out vec4 outData, in vec2 fragCoord) {
    outColor = vec4(1.0);                 // 출력 0
    outData = vec4(fragCoord, 0.0, 1.0);  // 출력 1
}`,
        title: "mainImage로 쓰기 (출력 수 = 2)",
        insert: "replace",
      },
      {
        p: "`mainImage`의 `out vec4` 매개변수 순서가 출력 번호(0, 1, …)입니다. `main()`으로 쓸 때는 출력마다 `layout(location = N)`을 붙여 선언합니다.",
      },
      {
        code: `layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outData;`,
        title: "main()으로 쓸 때의 출력 선언",
        insert: "cursor",
      },
      {
        list: [
          "다른 패스의 입력 채널에서 `A[1] · current`처럼 **출력 번호**를 골라 읽습니다.",
          "출력 수를 줄이면 사라진 출력을 읽던 연결은 자동으로 0번 출력으로 되돌아갑니다.",
          "**성능 → 버퍼 뷰어**에는 출력마다 썸네일이 따로 표시됩니다.",
        ],
      },
      { actions: [{ label: "MRT 예제 열기", run: "example:mrt" }] },
    ],
  },
  {
    id: "inputs",
    title: "이미지 · 키보드 · 미디어 입력",
    summary: "이미지 · 키보드 · 마이크 · 오디오 · 웹캠 · 영상을 채널에 연결",
    blocks: [
      { heading: "이미지" },
      {
        list: [
          "편집기 입력 줄의 채널 칩을 눌러 **이미지 불러오기…**를 고르면 그 채널에 바로 연결됩니다. 이미지 파일을 칩에 끌어다 놓아도 됩니다. 편집기 아무 곳에나 놓으면 첫 빈 채널에 연결됩니다.",
          "불러온 이미지 목록과 Filter(Linear/Nearest)·Wrap(Clamp/Repeat/Mirror) 설정은 **프로젝트 메뉴**(Ctrl+O)의 이미지에 있습니다.",
          "이미지는 브라우저(IndexedDB)에 보관되어 새로고침 후에도 복원됩니다. 다른 컴퓨터로 옮길 때는 **프로젝트 파일 내보내기**를 사용하세요.",
        ],
      },
      {
        code: `vec4 tex   = texture(iChannel0, gl_FragCoord.xy / uResolution);           // 화면에 맞춰 늘림
vec4 texel = texelFetch(iChannel0, ivec2(gl_FragCoord.xy), 0);              // 픽셀 정확히`,
        title: "텍스처 읽기 두 가지",
        insert: "cursor",
      },
      { heading: "키보드" },
      {
        p: "채널 칩의 **입력 › 키보드**를 고르면 그 채널로 쉐이더토이와 같은 키 상태 텍스처(256×3)가 들어옵니다. x는 JavaScript 키 코드(A=65, ←=37, Space=32), y는 어떤 상태인지입니다.",
      },
      {
        table: {
          head: ["y", "값이 1인 때", "쓰임"],
          rows: [
            ["0", "지금 누르고 있음", "이동처럼 누르는 동안 계속"],
            ["1", "이번 프레임에 눌림(한 프레임만)", "점프·발사처럼 한 번"],
            ["2", "누를 때마다 켜짐/꺼짐", "모드 전환"],
          ],
        },
      },
      { keycode: true },
      {
        list: [
          "**뷰포트를 클릭해 포커스를 주면** 키가 셰이더로 갑니다. 화면 위쪽에 '키보드 입력 중'이 표시됩니다.",
          "이 동안에는 E·X·H·F·Space 같은 한 글자 단축키가 셰이더에 양보합니다. **Esc**로 빠져나오면 단축키가 돌아옵니다. Ctrl 조합(Ctrl+O 등)은 그대로 동작합니다.",
          "키를 쌓아 쓰는 상태(위치·점수·카메라)는 버퍼에 저장하세요. 예제 갤러리의 **Keyboard Control**은 점의 위치를, **Ray Marching SDF**는 카메라 시점(방향키·WASD·드래그, R 초기화)을 버퍼에 저장하는 예입니다.",
          "키보드 연결이 들어간 프로젝트는 이 기능이 없는 예전 버전에서 열리지 않을 수 있습니다.",
        ],
      },
      {
        code: `uniform sampler2D iChannel1;   // 키보드 연결
const int KEY_LEFT = 37, KEY_UP = 38, KEY_RIGHT = 39, KEY_DOWN = 40, KEY_SPACE = 32;
bool keyDown(int k)    { return texelFetch(iChannel1, ivec2(k, 0), 0).x > 0.5; }
bool keyPressed(int k) { return texelFetch(iChannel1, ivec2(k, 1), 0).x > 0.5; }
bool keyToggled(int k) { return texelFetch(iChannel1, ivec2(k, 2), 0).x > 0.5; }`,
        title: "키 읽기",
        insert: "cursor",
      },
      { heading: "마이크 · 오디오 · 웹캠 · 영상" },
      {
        p: "채널 칩의 **입력**에서 **마이크** · **웹캠**을 고르면 권한을 묻고 켭니다. **오디오 파일…** · **영상 파일…**은 파일을 고르면 그 채널에 연결하고 재생합니다(반복 재생, 오디오는 소리도 납니다).",
      },
      {
        table: {
          head: ["입력", "텍스처", "읽는 법"],
          rows: [
            [
              "마이크 · 오디오 파일",
              "512×2 (Shadertoy와 같음)",
              "y = 0.25 줄: 주파수 크기(x = 0 낮은 음 → 1 높은 음) · y = 0.75 줄: 파형(0.5 = 무음)",
            ],
            [
              "웹캠 · 영상 파일",
              "영상 크기",
              "이미지처럼 `texture(iChannel0, uv)` · 위쪽이 v = 1 · 크기는 `iChannelResolution`",
            ],
          ],
        },
      },
      {
        list: [
          "켜지 않은 채널은 검정 · `iChannelResolution` = 0으로 읽힙니다. 칩에 **꺼짐**이 보이면 칩을 눌러 같은 입력을 다시 고르세요.",
          "마이크 · 카메라 권한과 고른 파일은 **저장되지 않습니다**. 프로젝트에는 연결만 남으므로, 다시 열면 다시 켜거나 파일을 다시 고릅니다.",
          "어떤 채널도 읽지 않게 되면(연결 해제 · 프로젝트 바꾸기) 마이크 · 카메라를 바로 끕니다.",
          "마이크 · 카메라는 `http://localhost`나 `https`, 또는 파일로 연 배포본에서 쓸 수 있습니다. 영상 렌더링(오프라인)에서는 렌더링하는 순간의 화면 · 소리가 들어갑니다.",
        ],
      },
      {
        code: `uniform sampler2D iChannel0;   // 마이크 또는 오디오 파일 연결
float spectrum(float x) { return texture(iChannel0, vec2(x, 0.25)).x; }   // 0~1 주파수 크기
float waveform(float x) { return texture(iChannel0, vec2(x, 0.75)).x; }   // 0.5 = 무음`,
        title: "소리 읽기",
        insert: "cursor",
      },
    ],
  },
  {
    id: "debug",
    title: "디버깅 · 성능",
    summary: "GPU 시간 · 버퍼 뷰어 · 픽셀 값",
    blocks: [
      {
        list: [
          "**프레임 타임라인** — 최근 18초의 GPU/CPU/프레임 시간 그래프. 60fps(16.7ms) 기준선을 넘으면 끊김이 생깁니다.",
          "**패스별 GPU 시간** — 어느 패스가 무거운지 막대로 비교(8ms 초과는 경고색). 브라우저가 GPU 타이머를 지원할 때만 표시됩니다.",
          "**버퍼 뷰어** — 모든 버퍼 출력의 실시간 썸네일. 누르면 뷰포트에 표시, 다시 누르면 Image로 복귀.",
          "**채널·노출** — R/G/B/A를 따로 보거나 노출을 올려 아주 작은 값·HDR 값을 확인합니다.",
          "**픽셀 값** — 버퍼를 표시한 상태에서 뷰포트에 포인터를 올리면 그 위치의 실제 값(음수·1 초과 포함)을 읽습니다.",
          "**Uniform 진단** — 셰이더가 실제로 쓰는 Uniform과 미등록·타입 불일치 항목을 보여줍니다.",
          "**재생 속도 · 한 프레임 진행** — 렌더링 탭에서 `uTime`이 흐르는 빠르기(0.25×~2×)를 바꾸고, **한 프레임 진행**(`.`)으로 멈춘 채 1/60초씩 넘겨 봅니다. 시간·프레임 수·피드백 버퍼가 함께 나아가서 시뮬레이션을 한 단계씩 살펴볼 때 좋습니다. HUD의 TIME에 지금 시간과 배속이 보입니다.",
          "**무거운 예제 안내** — 갤러리에서 연 예제가 몇 초 동안 30 FPS를 넘지 못하면 해상도 배율을 75%(또는 50%)로 낮추자고 한 번 묻습니다. 렌더링 탭의 **해상도 배율**로 언제든 직접 바꿀 수 있어요.",
        ],
      },
      {
        code: `// 값 범위를 눈으로 확인하는 디버그 출력: 음수는 빨강, 1 초과는 초록
vec3 debugValue(float v) { return v < 0.0 ? vec3(-v, 0, 0) : v > 1.0 ? vec3(0, v - 1.0, 0) : vec3(v); }`,
        title: "값 시각화 함수",
        insert: "cursor",
      },
      { actions: [{ label: "성능 탭 열기", run: "panel:profile" }] },
    ],
  },
  {
    id: "snippets",
    title: "코드 조각 모음",
    summary: "해시·노이즈·SDF 등 범주별 함수 라이브러리",
    blocks: [
      {
        p: "범주를 고르고 **삽입**을 누르면 현재 편집 중인 패스에 들어갑니다. 함수는 자동으로 `main()` 바깥(전역)에, 문장 조각은 함수 안 커서 위치에 들어가며, 필요한 함수(예: `fbm` → `valueNoise` → `uhash21` → `pcg3d`)도 **코드에 없을 때만** 함께 넣습니다.",
      },
      { library: true },
    ],
  },
  {
    id: "shortcuts",
    title: "단축키",
    summary: "키보드로 빠르게",
    blocks: [
      {
        keys: [
          ["가이드 열기/닫기", "?"],
          ["셰이더 편집기", "E"],
          ["미리보기 분리 + 편집기 확대 (다시 누르면 원래대로)", "P · 편집기 안에서 Ctrl+K P"],
          ["프로젝트 메뉴 (저장·열기·이미지)", "Ctrl+O"],
          ["프로젝트 저장 / 다른 이름으로 저장", "Ctrl+S / Ctrl+Shift+S"],
          ["명령 팔레트 (어디서나)", "Ctrl+Shift+P / F1"],
          ["예제 갤러리", "X"],
          ["재생/일시정지 (뷰포트 선택 시)", "Space"],
          ["한 프레임 진행 (멈춘 채로)", "."],
          ["전체화면", "F"],
          ["설정 패널", "H"],
          ["HUD 숨기기 (셰이더만 보기) / 다시 보기", "G · Esc"],
          ["파라미터 검색", "/"],
          ["갤러리 검색 (갤러리 안에서) · 첫 결과 열기", "/ · Enter"],
        ],
      },
      {
        p: "셰이더에서 쓸 키의 번호(키 코드)가 궁금하면 아래 칸을 누르고 키를 눌러 보세요.",
      },
      { keycode: true },
      {
        p: "**편집기 안에서** — VS Code 기본 단축키와 같습니다(Mac은 Ctrl 대신 Cmd). `Ctrl+K Ctrl+0`처럼 적힌 키는 두 번 이어서 누릅니다. Ctrl+W·Ctrl+N·Ctrl+Tab·Ctrl+PageUp/PageDown은 브라우저가 먼저 가져가므로, 패스 전환은 `Alt+PageUp/PageDown`을 씁니다. PageUp/PageDown 키가 없거나(노트북) 오른쪽 Alt가 한/영 키라 안 되면 **왼쪽** Alt와 `,` `.`(`Alt+,` / `Alt+.`)도 됩니다.",
      },
      {
        keys: [
          ["코드 실행 (적용)", "Alt+Enter (이전 방식: Ctrl+S)"],
          ["되돌리기 / 다시 실행", "Ctrl+Z / Ctrl+Y · Ctrl+Shift+Z"],
          ["자동 완성", "Ctrl+Space / Ctrl+I"],
          ["명령 팔레트", "Ctrl+Shift+P / F1"],
          ["패스(Image · Common · Buffer)로 이동", "Ctrl+P"],
          ["함수·Uniform으로 이동", "Ctrl+Shift+O"],
          ["줄 번호로 이동", "Ctrl+G"],
          ["찾기만 / 찾아 바꾸기", "Ctrl+F / Ctrl+H"],
          ["정의로 이동", "F12 / Ctrl+클릭"],
          ["이름 바꾸기", "F2"],
          ["주석 전환 / 블록 주석", "Ctrl+/ / Shift+Alt+A"],
          ["줄 주석 추가 / 제거", "Ctrl+K Ctrl+C / Ctrl+K Ctrl+U"],
          ["다음 일치 항목 선택 추가 / 모든 일치 선택", "Ctrl+D / Ctrl+Shift+L · Ctrl+F2"],
          ["선택 영역 확장 / 축소", "Shift+Alt+→ / Shift+Alt+←"],
          ["줄 선택 (반복하면 다음 줄까지)", "Ctrl+L"],
          ["커서 추가 (클릭 · 위아래 줄 · 선택 줄 끝마다)", "Alt+클릭 · Ctrl+Alt+↑↓ · Shift+Alt+I"],
          ["사각(열) 선택", "Shift+Alt+드래그"],
          ["줄 위/아래 이동", "Alt+↑ / Alt+↓"],
          ["줄 위/아래로 복사", "Shift+Alt+↑ / Shift+Alt+↓ (예전 키 Ctrl+Shift+D)"],
          ["줄 삭제", "Ctrl+Shift+K"],
          ["아래에 줄 삽입 / 위에 줄 삽입", "Ctrl+Enter / Ctrl+Shift+Enter"],
          ["들여쓰기 / 내어쓰기", "Tab / Shift+Tab · Ctrl+] / Ctrl+["],
          ["짝 괄호로 이동", "Ctrl+Shift+\\"],
          ["블록 접기 / 펴기", "Ctrl+Shift+[ / Ctrl+Shift+]"],
          ["모두 접기 / 모두 펴기", "Ctrl+K Ctrl+0 / Ctrl+K Ctrl+J"],
          [
            "Ctrl+K 연속 키: 오른쪽 아래 대기 표시가 뜨면 다음 키 (한글이 조합 중이면 조합을 끝낸 뒤 Ctrl+K)",
            "Ctrl+K → 다음 키 · Esc 취소",
          ],
          ["다음 · 이전 오류 / 오류 목록 / 아래 패널", "F8 · Shift+F8 / Ctrl+Shift+M / Ctrl+J"],
          ["편집기 배치 바꾸기(옆 ↔ 위아래) / 집중 모드(Zen)", "Ctrl+\\ / Ctrl+K Z"],
          ["미리보기 분리 + 편집기 확대", "Ctrl+K P"],
          ["편집기·설정 패널 자리 옮기기 (손잡이 ⠿에서)", "끌어 놓기 · 방향키"],
          ["글자 크게 / 작게", "Ctrl+= / Ctrl+-"],
          ["긴 줄 자동 줄바꿈", "Alt+Z"],
          ["이전·다음 패스", "Alt+PageUp / Alt+PageDown · Alt+, / Alt+."],
          ["커서 위 숫자 올리기 / 내리기 (Shift = 10배, 숫자 밖에서는 스크롤)", "Ctrl+↑ / Ctrl+↓"],
          ["숫자 끌어서 조절", "Alt + 좌우 드래그"],
          ["템플릿 다음 / 이전 자리", "Tab / Shift+Tab"],
          ["Tab 키로 포커스 이동 켜기/끄기 (접근성)", "Ctrl+M"],
        ],
      },
    ],
  },
  {
    id: "files",
    title: "저장 · 내보내기",
    summary: "작업을 보관하고 옮기기",
    blocks: [
      {
        table: {
          head: ["방법", "포함 내용"],
          rows: [
            ["브라우저 자동 저장", "코드·버퍼 구성(미적용 편집본 포함), 렌더 설정, 파라미터. 새로고침해도 유지"],
            ["프로젝트 파일 내보내기 (Pack)", "코드·버퍼·파라미터·연결된 이미지·렌더 설정 — 다른 컴퓨터로 옮길 때"],
            [
              "HTML로 내보내기 (재생 전용)",
              "지금 적용된 작품을 HTML 한 파일로 — 서버·인터넷 없이 더블클릭해 전체 화면으로 재생(더블클릭 · F: 전체 화면). 코드·버퍼·Common·파라미터 값·이미지 포함, 마우스·휠·키보드 동작. 편집은 안 되고 미디어 입력(마이크·카메라·파일)은 빠집니다",
            ],
            ["코드만 내보내기 (고급)", "코드와 버퍼 연결 구성만(이미지·파라미터 제외)"],
            [
              ".frag 파일로 저장",
              "현재 탭의 코드만 쓴 그대로 .frag 파일로(Common 탭은 Common.glsl) — 편집기 ⋯ 메뉴. Common · 자동 머리말은 들어가지 않습니다",
            ],
            ["스크린샷", "툴바의 캡처(카메라) › 스크린샷 저장 → 현재 화면 PNG"],
            [
              "고해상도 스크린샷",
              "캡처 › 고해상도 저장 2× · 4K → 지금 시간 그대로 더 크게 다시 그린 PNG(4K는 긴 변 3840px). 버퍼 패스가 없는 프로젝트만",
            ],
            [
              "녹화",
              "캡처 › 녹화 시작 → 툴바의 빨간 시간 버튼으로 중지 → WebM 영상(Safari는 MP4). 크기는 실제 렌더 해상도. 화면에 보이는 그대로 실시간으로 담는다",
            ],
            [
              "영상 렌더링",
              "캡처 › 영상 렌더링… → 시작 시간·길이·FPS·크기를 정해 프레임마다 정확히 그린 MP4(H.264)·WebM(VP9·VP8) 또는 PNG 연속 이미지(ZIP). 화면이 느려도 끊기지 않는다",
            ],
          ],
        },
      },
      {
        list: [
          "**녹화 vs 영상 렌더링** — 녹화는 지금 화면을 실시간으로 담아서, 셰이더가 무거우면 영상도 끊기고 크기도 화면을 따릅니다. **영상 렌더링**은 시간을 직접 진행하며 한 장씩 그리므로 무거운 셰이더도 매끄러운 영상이 되고, 4K처럼 화면보다 큰 크기도 만들 수 있습니다(대신 그리는 동안 기다려야 합니다).",
          "프레임 i의 `uTime` = 시작 시간 + i ÷ FPS, `uDeltaTime` = 1 ÷ FPS, `uFrame` = 시작 시간 × FPS + i. 재생 배속과 상관없고, 렌더링하는 동안 마우스·휠·키 값은 그대로 고정됩니다.",
          "버퍼 패스(피드백 시뮬레이션)가 있으면 0초부터 시작 시간까지를 먼저 계산한 뒤 저장을 시작합니다. 이 계산은 따로 하므로 화면의 시뮬레이션은 렌더링 전 상태 그대로 이어집니다.",
          "MP4·WebM은 브라우저의 WebCodecs 인코더를 씁니다(Chrome·Edge·최신 Firefox·Safari). **MP4(H.264)** 는 대부분의 플레이어·편집 프로그램·SNS에서 바로 열립니다. 고를 수 없는 형식은 '지원 안 됨'으로 표시되고, 그때는 **PNG 연속 이미지**를 고르세요(ZIP 안의 README에 ffmpeg 명령이 있습니다). PNG ZIP은 크기·장 수 제한이 없습니다(4GB가 넘으면 ZIP64).",
          "렌더링 중에는 진행률과 남은 시간이 보이고, **Esc** 또는 **렌더링 취소**로 멈춥니다(파일은 만들지 않음).",
          "**무거운 셰이더** — 큰 크기로 한 번에 그리면 GPU가 몇 초씩 붙잡혀 브라우저가 WebGL을 초기화합니다(컨텍스트 손실). 그래서 영상 렌더링은 프레임을 **타일로 나눠** 그리고 타일마다 GPU가 끝나기를 기다립니다. 타일 크기는 잰 시간으로 자동으로 정해서, 가벼운 셰이더는 한 장으로 그대로 빠르게 그립니다(진행 표시에 타일 수가 나옵니다). 그래도 컨텍스트를 잃으면 렌더링을 멈추고 안내하며, 앱은 스스로 복구합니다. 그때는 크기를 줄여 다시 시도하세요.",
        ],
      },
      {
        note: "이 기능들은 뷰포트 왼쪽 위의 **프로젝트 메뉴**(지금 작업 이름 버튼, `Ctrl+O`)에 있습니다. 편집기를 열지 않아도 쓸 수 있고, `Ctrl+S`로 바로 보관함에 저장합니다. 같은 브라우저라도 저장소를 지우면 자동 저장본이 사라지니 중요한 작업은 Pack으로 보관하세요. 브라우저 탭 제목에는 지금 작업 이름이 보이고, 보관함에 저장(또는 보관함에서 연) 뒤 코드·파라미터·렌더링 설정이 바뀌었으면 **●**(프로젝트 메뉴 이름 옆에도 점)가 붙습니다. 저장하거나 저장한 값으로 되돌리면 사라지고, 새로고침해도 비교가 이어집니다. 실행에 반영하지 않은 코드 편집은 **✎**, 마지막 적용이 컴파일 오류로 실패했으면 **⚠**입니다.",
      },
    ],
  },
];
// UI 둘러보기: target은 CSS 선택자, prepare는 대상이 보이도록 패널·편집기를 연다.
const TOUR = [
  {
    target: "#renderViewport",
    title: "뷰포트",
    text: "셰이더 결과가 그려지는 곳입니다. 뷰포트를 클릭하면 키보드 채널을 쓰는 셰이더가 키 입력을 받아요(Esc로 나가기). 3D 예제는 드래그·방향키로 시점을 돌립니다.",
    prepare: "close-editor",
  },
  {
    target: "#stageToolbar",
    title: "툴바",
    text: "재생/일시정지 · 편집기 · 캡처(스크린샷·녹화) · 전체화면, 그리고 ⋯ 더보기(갤러리·가이드·패널·HUD·분리 창·테마)입니다. 버튼 위에 포인터를 올리면 설명이 나와요.",
    prepare: "stage",
  },
  {
    target: "#stats",
    title: "HUD",
    text: "FPS, 실제 렌더 해상도, 시간(uTime), 프레임 수, GPU 시간을 실시간으로 보여줍니다. G 키를 누르면 이 HUD와 위쪽 도구 막대까지 모두 숨겨 셰이더만 볼 수 있어요(다시 G · Esc).",
    prepare: "stage",
  },
  {
    target: "#panelTabs",
    title: "설정 패널",
    text: "렌더링 품질, 파라미터, 성능/디버그, 작업공간 설정이 탭으로 나뉘어 있습니다. H 키로 패널을 열고 닫아요.",
    prepare: "panel:render",
  },
  {
    target: "#view-uniforms",
    title: "파라미터",
    text: "슬라이더·색상·방향·패드로 Uniform 값을 실시간 조절합니다. GLSL 주석에 @range, @color, @dir, @enum 등을 달면 자동으로 여기에 생겨요.",
    prepare: "panel:uniforms",
  },
  {
    target: "#view-profile",
    title: "성능 · 디버그",
    text: "패스별 GPU 시간, 버퍼 썸네일, 픽셀 값, Uniform 진단을 확인합니다. 셰이더가 느리거나 결과가 이상할 때 먼저 보세요.",
    prepare: "panel:profile",
  },
  {
    target: "#studioPassTabs",
    title: "패스 탭",
    text: "Image(화면) · Common(공용 코드) · Buffer 패스를 오갑니다. 옆의 +로 오프스크린 패스를 추가해 여러 단계를 연결하고, + Common으로 모든 패스가 같이 쓰는 함수를 한 곳에 둘 수 있어요.",
    prepare: "open-editor",
  },
  {
    target: ".studio-editor-frame",
    title: "코드 편집기",
    text: "GLSL을 고치면 0.9초 뒤 자동 적용됩니다. 오류가 나면 해당 줄이 빨갛게 표시되고 줄 끝에 이유가 나와요.",
    prepare: "open-editor",
  },
  {
    target: "#studioRun",
    title: "실행 · 되돌리기",
    text: "Alt+Enter로 즉시 실행, Ctrl+S로 프로젝트 저장, Ctrl+Z로 코드·버퍼·파라미터 변경을 되돌립니다.",
    prepare: "open-editor",
  },
  {
    target: "#moreToggle",
    title: "가이드는 언제든",
    text: "⋯ 더보기 메뉴의 가이드나 ? 키로 가이드를 다시 열 수 있어요. 각 패널의 작은 ? 버튼은 해당 주제로 바로 이동합니다.",
    prepare: "close-editor",
  },
];
const mount = ({ studio, gallery }) => {
  const $ = PreviewDOM.createLookup(),
    controller = new AbortController(),
    signal = controller.signal;
  const dialog = $("quickHelp"),
    nav = $("guideNav"),
    content = $("guideContent"),
    search = $("guideSearch");
  const element = (tag, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const listen = (target, type, fn, options = {}) => target?.addEventListener(type, fn, { ...options, signal });
  let current = "start";
  // 가이드의 GLSL 예시도 편집기와 같은 규칙으로 강조한다. 내장 함수 이름은 레퍼런스에서 가져온다("sin · cos" → sin, cos).
  const highlighter = Highlight.create(
    Reference.ALL.flatMap(item => item.name.split("·").map(name => name.replace(/\(.*\)/, "").trim()))
  );
  const codeBlock = source => highlighter.paint(element("pre"), source);
  // 탐색 목록: 시작하기 → 입문 과정 → 기능 레퍼런스. group이 바뀌는 곳에 목록 제목을 넣는다.
  const ALL = [
    { ...TOPICS[0], group: "" },
    ...Course.LESSONS.map(lesson => ({ ...lesson, group: "입문 과정 · C 개발자용" })),
    ...TOPICS.slice(1).map(topic => ({ ...topic, group: "기능 레퍼런스" })),
  ];
  const LESSON_IDS = Course.LESSONS.filter(lesson => lesson.step).map(lesson => lesson.id),
    COURSE_ORDER = Course.LESSONS.map(lesson => lesson.id);
  const navTitle = topic => (topic.step ? `${topic.step}. ${topic.title}` : topic.title);
  // 과정 진행(완료한 단계)과 마지막으로 본 주제는 이 브라우저에 보관한다. 저장소가 막혀 있어도 가이드는 동작한다.
  const PROGRESS_KEY = "field.guide.course.v1",
    LAST_KEY = "field.guide.last.v1";
  const done = (() => {
    const saved = Store.readJSON(PROGRESS_KEY, []);
    return new Set(Array.isArray(saved) ? saved.filter(id => LESSON_IDS.includes(id)) : []);
  })();
  const saveDone = () => Store.writeJSON(PROGRESS_KEY, [...done]);
  const last = Store.read(LAST_KEY);
  if (ALL.some(topic => topic.id === last)) current = last;
  // `code`와 **강조**만 해석한다. 나머지는 모두 텍스트 노드.
  const rich = (tag, text, className = "") => {
    const node = element(tag, className);
    for (const part of String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
      if (!part) continue;
      if (part.startsWith("`")) node.append(element("code", "", part.slice(1, -1)));
      else if (part.startsWith("**")) node.append(element("b", "", part.slice(2, -2)));
      else node.append(document.createTextNode(part));
    }
    return node;
  };
  const flash = (button, text) => {
    const before = button.textContent;
    button.textContent = text;
    button.disabled = true;
    setTimeout(() => {
      button.textContent = before;
      button.disabled = false;
    }, 1400);
  };
  // "복사" 버튼: 누를 때 text()의 결과를 클립보드에 넣는다.
  const copyButton = text => {
    const copy = element("button", "", "복사");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text());
        flash(copy, "복사됨");
      } catch (_) {
        flash(copy, "복사 실패");
      }
    });
    return copy;
  };
  // 범주 탭 버튼: 누르면 select(id)로 범주를 바꾼다.
  const categoryChip = (chips, id, label, count, select) => {
    const button = element("button");
    button.type = "button";
    button.dataset.category = id;
    button.setAttribute("role", "tab");
    button.append(document.createTextNode(label), element("span", "", String(count)));
    button.addEventListener("click", () => select(id));
    chips.append(button);
  };
  const runAction = action => {
    if (action === "tour") {
      dialog.close();
      startTour();
    } else if (action === "gallery") {
      dialog.close();
      gallery?.open(false);
    } else if (action.startsWith("topic:")) show(action.slice(6));
    else if (action.startsWith("panel:")) {
      dialog.close();
      openPanel(action.slice(6));
    } else if (action.startsWith("example:")) {
      dialog.close();
      gallery?.loadLesson?.(action.slice(8));
    } else if (action.startsWith("course:")) {
      const project = Course.PROJECTS[action.slice(7)];
      if (project) loadProject(project);
    }
  };
  // 과정 예제 불러오기: 현재 프로젝트를 교체한다(미적용 편집이 있으면 확인, Ctrl+Z로 복원 가능).
  // 가이드는 닫고, 다시 열면(? 키) 같은 단계로 돌아온다. 편집기 열림 상태는 바꾸지 않는다(코드는 E로 연다).
  const loadProject = async project => {
    dialog.close();
    return studio.loadExample(project, []);
  };
  // ---- 코드 조각 라이브러리 (범주 탭 + 검색 필터 + 의존성 포함 삽입) ----
  let snippetCategory = Snippets.CATEGORIES[0].id;
  const titleOf = id => Snippets.ALL.find(item => item.id === id)?.title || id;
  const insertItem = (item, button) => {
    if (item.replace) {
      if (
        studio.insertCode({ replace: item.code, note: `${item.title}로 현재 패스를 교체했습니다 · Ctrl+Z로 되돌리기` })
      )
        dialog.close();
      return;
    }
    const plan = Snippets.plan(item.id, studio.getEditorSource?.() || "");
    if (plan.alreadyDefined && !plan.mainCode) {
      flash(button, "이미 있음");
      return;
    }
    const extra = plan.added.length ? ` (+ ${plan.added.join(", ")} 함께)` : "",
      reused = plan.skipped.length ? ` · 기존 ${plan.skipped.join(", ")} 사용` : "";
    if (
      studio.insertCode({
        global: plan.globals.map(entry => entry.code).join("\n\n"),
        main: plan.mainCode || "",
        note: `코드 조각 삽입: ${item.title}${extra}${reused} · Ctrl+Z로 되돌리기`,
      })
    )
      dialog.close();
  };
  const previews = SnippetPreview.create({ plan: Snippets.plan });
  const snippetCard = item => {
    const figure = element("figure", "guide-code snippet-card"),
      bar = element("figcaption"),
      head = element("span", "snippet-head");
    head.append(element("strong", "", item.title), element("small", "", item.desc));
    const tags = element("span", "snippet-tags");
    tags.append(
      element(
        "em",
        item.replace ? "is-replace" : item.scope === "main" ? "is-main" : "is-global",
        item.replace ? "패스 교체" : item.scope === "main" ? "main() 안" : "전역 함수"
      )
    );
    if (item.requires?.length) tags.append(element("em", "is-dep", `+ ${item.requires.map(titleOf).join(", ")}`));
    const copy = copyButton(() => {
      const plan = Snippets.plan(item.id, "");
      return [...plan.globals.map(entry => entry.code), plan.mainCode].filter(Boolean).join("\n\n");
    });
    const insert = element("button", "guide-insert", item.replace ? "패스 교체" : "삽입");
    insert.type = "button";
    insert.title = item.replace
      ? "현재 편집 중인 패스 전체를 이 코드로 바꿉니다"
      : "필요한 함수와 함께 편집기에 넣습니다";
    insert.addEventListener("click", () => insertItem(item, insert));
    bar.append(head, tags, copy, insert);
    // 미리보기가 있는 조각은 코드 왼쪽에 결과 그림을 붙인다(한 프레임에 하나씩 그려 넣음).
    if (previews.has(item.id)) {
      const body = element("div", "snippet-body"),
        frame = element("div", "snippet-preview"),
        canvas = element("canvas");
      canvas.width = SnippetPreview.WIDTH;
      canvas.height = SnippetPreview.HEIGHT;
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `${item.title} 결과 미리보기`);
      frame.append(canvas);
      body.append(frame, codeBlock(item.code));
      figure.append(bar, body);
      previews.draw(item, canvas);
    } else figure.append(bar, codeBlock(item.code));
    return figure;
  };
  const renderLibrary = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = item => words.every(word => `${item.title} ${item.desc} ${item.code}`.toLowerCase().includes(word));
    const wrap = element("div", "snippet-library"),
      chips = element("div", "snippet-categories"),
      intro = element("p", "snippet-intro"),
      list = element("div", "snippet-list");
    chips.setAttribute("role", "tablist");
    chips.setAttribute("aria-label", "코드 조각 범주");
    const fill = () => {
      const category = Snippets.CATEGORIES.find(entry => entry.id === snippetCategory);
      const items =
        words.length && snippetCategory === "all"
          ? Snippets.ALL.filter(matches)
          : (category?.items || []).filter(item => !words.length || matches(item));
      intro.textContent = snippetCategory === "all" ? `검색 결과 ${items.length}개` : category?.desc || "";
      list.replaceChildren(...items.map(snippetCard));
      if (!items.length) list.append(element("p", "guide-empty", "이 범주에는 검색어와 맞는 조각이 없습니다."));
      for (const chip of chips.children) {
        const active = chip.dataset.category === snippetCategory;
        chip.classList.toggle("is-active", active);
        chip.setAttribute("aria-selected", String(active));
      }
    };
    const chip = (id, label, count) =>
      categoryChip(chips, id, label, count, next => {
        snippetCategory = next;
        fill();
      });
    if (words.length) chip("all", "전체 검색", Snippets.ALL.filter(matches).length);
    for (const category of Snippets.CATEGORIES) {
      const count = words.length ? category.items.filter(matches).length : category.items.length;
      if (!words.length || count) chip(category.id, category.title, count);
    }
    if (words.length && snippetCategory !== "all") snippetCategory = "all";
    if (!words.length && snippetCategory === "all") snippetCategory = Snippets.CATEGORIES[0].id;
    fill();
    wrap.append(chips, intro, list);
    return wrap;
  };
  // ---- GLSL 내장 함수 레퍼런스 (범주 탭 + 검색 필터) ----
  let referenceCategory = Reference.CATEGORIES[0].id;
  const referenceItem = item => {
    const row = element("article", "ref-item"),
      head = element("header", "ref-head");
    head.append(element("strong", "ref-name", item.name), highlighter.paint(element("code", "ref-sig"), item.sig));
    row.append(head, rich("p", item.desc, "ref-desc"));
    if (item.c) {
      const c = element("p", "ref-c");
      c.append(element("span", "", "C 대응"), element("code", "", item.c));
      row.append(c);
    }
    if (item.ex) {
      const ex = element("div", "ref-ex");
      ex.append(
        codeBlock(item.ex),
        copyButton(() => item.ex)
      );
      row.append(ex);
    }
    return row;
  };
  const renderReference = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = item =>
      words.every(word =>
        `${item.name} ${item.sig} ${item.desc} ${item.c || ""} ${item.ex || ""}`.toLowerCase().includes(word)
      );
    const wrap = element("div", "snippet-library ref-library"),
      chips = element("div", "snippet-categories"),
      intro = element("p", "snippet-intro"),
      list = element("div", "ref-list");
    chips.setAttribute("role", "tablist");
    chips.setAttribute("aria-label", "내장 함수 범주");
    if (words.length) referenceCategory = "all";
    else if (referenceCategory === "all") referenceCategory = Reference.CATEGORIES[0].id;
    const fill = () => {
      const category = Reference.CATEGORIES.find(entry => entry.id === referenceCategory);
      const items = referenceCategory === "all" ? Reference.ALL.filter(matches) : category?.items || [];
      intro.textContent = referenceCategory === "all" ? `검색 결과 ${items.length}개` : category?.desc || "";
      list.replaceChildren(...items.map(referenceItem));
      if (!items.length) list.append(element("p", "guide-empty", "검색어와 맞는 내장 함수가 없습니다."));
      for (const chip of chips.children) {
        const active = chip.dataset.category === referenceCategory;
        chip.classList.toggle("is-active", active);
        chip.setAttribute("aria-selected", String(active));
      }
    };
    const chip = (id, label, count) =>
      categoryChip(chips, id, label, count, next => {
        referenceCategory = next;
        fill();
      });
    if (words.length) chip("all", "검색 결과", Reference.ALL.filter(matches).length);
    else for (const category of Reference.CATEGORIES) chip(category.id, category.title, category.items.length);
    fill();
    wrap.append(chips, intro, list);
    return wrap;
  };
  // 키 코드 확인: 칸에 초점을 두고 키를 누르면 키보드 채널에서 쓰는 번호(event.keyCode)를 보여 준다.
  // 누른 키는 앱 단축키로 넘기지 않는다(Esc는 가이드를 닫고, Tab은 초점을 옮긴다).
  const keyCodeBlock = () => {
    const box = element("div", "guide-keycode"),
      pad = element("div", "guide-keycode-pad"),
      number = element("strong", "guide-keycode-number", "?"),
      detail = element("span", "guide-keycode-detail", "여기를 누르고 키를 눌러 보세요"),
      line = element("code", "guide-keycode-line", "");
    pad.tabIndex = 0;
    pad.setAttribute("role", "textbox");
    pad.setAttribute("aria-readonly", "true");
    pad.setAttribute("aria-label", "키 코드 확인: 키를 누르면 번호를 알려 줍니다");
    const status = element("span", "guide-keycode-status");
    status.setAttribute("role", "status");
    pad.append(number, detail);
    let last = "";
    const constName = event => {
      const key = event.key;
      if (/^[a-z0-9]$/i.test(key)) return `KEY_${key.toUpperCase()}`;
      const named = { " ": "SPACE", ArrowLeft: "LEFT", ArrowRight: "RIGHT", ArrowUp: "UP", ArrowDown: "DOWN" };
      if (named[key]) return `KEY_${named[key]}`;
      return `KEY_${(event.code || key || "CODE")
        .replace(/(Left|Right)$/, "")
        .replace(/\W/g, "")
        .toUpperCase()}`;
    };
    pad.addEventListener("keydown", event => {
      if (event.isComposing) return;
      const code = event.keyCode;
      const name = event.key === " " ? "Space" : event.key;
      number.textContent = String(code);
      detail.textContent = `key "${name}" · code ${event.code || "-"}`;
      last = code > 0 && code < 256 ? `const int ${constName(event)} = ${code};` : "";
      line.textContent = last || "키보드 채널은 1~255 번호만 읽습니다";
      status.textContent = `${name} 키의 번호는 ${code}입니다`;
      if (event.key === "Escape" || event.key === "Tab") return;
      event.preventDefault();
      event.stopPropagation();
    });
    const bar = element("div", "guide-keycode-bar");
    bar.append(
      line,
      copyButton(() => last || line.textContent)
    );
    box.append(pad, bar, status);
    return box;
  };
  const renderBlock = block => {
    if (block.library) return renderLibrary();
    if (block.reference) return renderReference();
    if (block.p) return rich("p", block.p);
    if (block.note) return rich("p", block.note, "guide-note");
    if (block.list || block.steps) {
      const list = element(block.steps ? "ol" : "ul", block.steps ? "guide-steps" : "guide-list");
      for (const item of block.list || block.steps) list.append(rich("li", item));
      return list;
    }
    if (block.table) {
      const table = element("table", "guide-table"),
        head = element("tr");
      for (const cell of block.table.head) head.append(element("th", "", cell));
      table.append(head);
      for (const row of block.table.rows) {
        const tr = element("tr");
        row.forEach((cell, i) => tr.append(i === 0 ? element("td", "guide-key", cell) : rich("td", cell)));
        table.append(tr);
      }
      const wrap = element("div", "guide-table-wrap");
      wrap.append(table);
      return wrap;
    }
    if (block.keycode) return keyCodeBlock();
    if (block.keys) {
      const list = element("div", "guide-keys");
      for (const [label, key] of block.keys) list.append(element("span", "", label), element("kbd", "", key));
      return list;
    }
    if (block.actions) {
      const row = element("div", "guide-actions");
      for (const action of block.actions) {
        const button = element("button", "", action.label);
        button.type = "button";
        button.addEventListener("click", () => runAction(action.run));
        row.append(button);
      }
      return row;
    }
    if (block.code) return codeFigure(block);
    // ---- 입문 과정 블록 ----
    if (block.heading) return rich("h4", block.heading, "guide-subhead");
    if (block.progress) return progressBlock();
    if (block.try) {
      const box = element("section", "guide-try"),
        list = element("ol");
      box.append(element("strong", "", "직접 해보기"));
      for (const item of block.try) list.append(rich("li", item));
      box.append(list);
      return box;
    }
    if (block.compare) {
      const grid = element("div", "guide-compare");
      grid.append(
        codeFigure({ code: block.compare.c, title: block.compare.cTitle || "C" }),
        codeFigure({ code: block.compare.glsl, title: block.compare.glslTitle || "GLSL" })
      );
      return grid;
    }
    if (block.solution) {
      const box = element("details", "guide-solution");
      box.append(
        element("summary", "", block.title || "정답 보기 · 예시 풀이"),
        codeFigure({ code: block.solution, title: "예시 풀이", start: true })
      );
      return box;
    }
    if (block.project) {
      const row = element("div", "guide-actions guide-project"),
        button = element("button", "primary", block.label || "프로젝트 불러오기");
      button.type = "button";
      button.addEventListener("click", () => runAction(`course:${block.project}`));
      row.append(button);
      return row;
    }
    return element("div");
  };
  // 코드 블록: 복사 + (선택) 커서 위치 삽입 · 현재 패스 교체 · 이 코드로 새 프로젝트 시작.
  const codeFigure = block => {
    const figure = element("figure", "guide-code"),
      bar = element("figcaption"),
      pre = codeBlock(block.code);
    bar.append(element("span", "", block.title || "GLSL"));
    bar.append(copyButton(() => block.code));
    if (block.insert) {
      const insert = element(
        "button",
        "guide-insert",
        block.insert === "replace" ? "현재 패스를 이 코드로 교체" : "편집기에 삽입"
      );
      insert.type = "button";
      insert.addEventListener("click", async () => {
        const ok = await studio.insertSnippet(block.code, block.insert === "replace");
        if (ok) {
          dialog.close();
        } else flash(insert, "삽입 취소됨");
      });
      bar.append(insert);
    }
    if (block.start) {
      const start = element("button", "guide-insert", "이 코드로 시작");
      start.type = "button";
      start.title = "현재 프로젝트를 이 코드 하나(단일 패스)로 바꿉니다 · 편집기에서 Ctrl+Z로 되돌릴 수 있습니다";
      start.addEventListener("click", () => loadProject({ image: block.code, passes: [], imageChannels: {} }));
      bar.append(start);
    }
    figure.append(bar, pre);
    return figure;
  };
  const progressBlock = () => {
    const count = LESSON_IDS.filter(id => done.has(id)).length,
      total = LESSON_IDS.length,
      wrap = element("div", "guide-progress");
    const bar = element("div", "guide-progress-bar"),
      fill = element("span");
    fill.style.width = `${Math.round((count / total) * 100)}%`;
    bar.append(fill);
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", "입문 과정 진행률");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(total));
    bar.setAttribute("aria-valuenow", String(count));
    wrap.append(
      element(
        "span",
        "guide-progress-label",
        count === total ? `모든 단계를 마쳤습니다 · ${total} / ${total}` : `진행 ${count} / ${total}`
      ),
      bar
    );
    const next = ALL.find(topic => topic.id === LESSON_IDS.find(id => !done.has(id)));
    if (next && count) {
      const resume = element("button", "primary", `이어서: ${navTitle(next)} →`);
      resume.type = "button";
      resume.addEventListener("click", () => show(next.id));
      wrap.append(resume);
    }
    return wrap;
  };
  // 단계 하단: 이전 / 완료 표시 / 다음
  const lessonFoot = topic => {
    const at = COURSE_ORDER.indexOf(topic.id),
      foot = element("nav", "guide-lesson-foot");
    foot.setAttribute("aria-label", "입문 과정 이동");
    const go = (id, label, className = "") => {
      const button = element("button", className, label);
      button.type = "button";
      button.addEventListener("click", () => show(id));
      return button;
    };
    const titleOfTopic = id => navTitle(ALL.find(item => item.id === id));
    foot.append(
      at > 0
        ? go(COURSE_ORDER[at - 1], `← ${titleOfTopic(COURSE_ORDER[at - 1])}`, "guide-lesson-prev")
        : element("span")
    );
    if (topic.step) {
      const finished = done.has(topic.id),
        mark = element(
          "button",
          finished ? "guide-lesson-mark is-done" : "guide-lesson-mark",
          finished ? "완료함" : "완료로 표시"
        );
      mark.type = "button";
      mark.setAttribute("aria-pressed", String(finished));
      mark.addEventListener("click", () => {
        if (done.has(topic.id)) done.delete(topic.id);
        else done.add(topic.id);
        saveDone();
        markNav();
        const fresh = lessonFoot(topic);
        foot.replaceWith(fresh);
        fresh.querySelector(".guide-lesson-mark")?.focus();
      });
      foot.append(mark);
    }
    if (at < COURSE_ORDER.length - 1)
      foot.append(go(COURSE_ORDER[at + 1], `${titleOfTopic(COURSE_ORDER[at + 1])} →`, "primary guide-lesson-next"));
    return foot;
  };
  const markNav = () => {
    for (const button of nav.querySelectorAll("button"))
      button.classList.toggle("is-done", done.has(button.dataset.topic));
  };
  const show = id => {
    const topic = ALL.find(item => item.id === id) || ALL[0];
    current = topic.id;
    Store.write(LAST_KEY, topic.id);
    const header = element("header", "guide-topic-head");
    if (topic.step)
      header.append(
        element(
          "span",
          "section-index",
          `입문 과정 · STEP ${String(topic.step).padStart(2, "0")} / ${LESSON_IDS.length}`
        )
      );
    header.append(element("h3", "", topic.title), element("p", "", topic.summary));
    content.replaceChildren(header, ...topic.blocks.map(renderBlock), ...(topic.course ? [lessonFoot(topic)] : []));
    content.scrollTop = 0;
    for (const button of nav.querySelectorAll("button")) {
      const active = button.dataset.topic === topic.id;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
      if (active && dialog.open) button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  };
  // 검색: 제목·요약·본문 텍스트에서 모든 단어를 포함하는 주제만 남긴다.
  const topicText = topic =>
    [
      topic.title,
      topic.summary,
      ...topic.blocks.flatMap(b => [
        b.p,
        b.note,
        b.code,
        b.title,
        b.heading,
        b.solution,
        b.compare?.c,
        b.compare?.glsl,
        ...(b.list || b.steps || b.try || []),
        ...(b.table ? b.table.rows.flat() : []),
        ...(b.keys ? b.keys.flat() : []),
        ...(b.keycode ? ["키 코드 확인 keyCode 키 번호"] : []),
        ...(b.library ? Snippets.ALL.flatMap(item => [item.title, item.desc, item.code]) : []),
        ...(b.reference ? Reference.ALL.flatMap(item => [item.name, item.sig, item.desc, item.c, item.ex]) : []),
      ]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  const index = new Map(ALL.map(topic => [topic.id, topicText(topic)]));
  const renderNav = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const visible = ALL.filter(topic => words.every(word => index.get(topic.id).includes(word)));
    const items = [];
    let group = "";
    for (const topic of visible) {
      // 검색 중에는 결과만 촘촘하게 보이도록 묶음 제목을 생략한다.
      if (!words.length && topic.group && topic.group !== group)
        items.push(element("p", "guide-nav-group", topic.group));
      group = topic.group;
      const button = element("button", done.has(topic.id) ? "is-done" : "");
      button.type = "button";
      button.dataset.topic = topic.id;
      button.title = `${topic.title} — ${topic.summary}`;
      button.append(element("strong", "", navTitle(topic)), element("span", "", topic.summary));
      button.addEventListener("click", () => show(topic.id));
      items.push(button);
    }
    nav.replaceChildren(...items);
    if (!visible.length) nav.append(element("p", "guide-empty", "검색 결과가 없습니다."));
    else if (!visible.some(topic => topic.id === current)) show(visible[0].id);
    else show(current);
  };
  // 터치 기기에서는 검색창에 자동 포커스하면 가상 키보드가 본문을 가리므로 본문에 포커스한다.
  const touchOnly = window.matchMedia?.("(hover:none) and (pointer:coarse)").matches === true;
  if (touchOnly) content.autofocus = true;
  const open = (id = current) => {
    search.value = "";
    renderNav();
    show(id);
    if (!dialog.open) dialog.showModal();
    if (!touchOnly) setTimeout(() => search.focus(), 0);
  };
  listen(search, "input", renderNav);
  listen(search, "keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      nav.querySelector("button")?.click();
      content.focus();
    }
  });
  listen($("guideTour"), "click", () => {
    dialog.close();
    startTour();
  });
  // ui.js가 dialog를 직접 여는 경우(? 키·툴바)에도 내용이 채워져 있도록 열릴 때마다 동기화한다.
  // ? 키·툴바 버튼(ui.js)은 이 요청 이벤트로 가이드를 연다. 처리했음을 preventDefault로 알린다.
  listen(document, "guide-open-request", event => {
    event.preventDefault();
    open();
  });
  // dialog를 다른 경로로 직접 연 경우의 보조 동기화. toggle 이벤트는 최신 브라우저에서만 발생한다(Chrome 132+ 등).
  listen(dialog, "toggle", () => {
    if (dialog.open && !nav.children.length) {
      renderNav();
      show(current);
    }
  });
  // 목록은 처음부터 채워 둔다. toggle 이벤트가 없는 브라우저에서도 dialog를 열면 바로 목록이 보인다.
  renderNav();
  // 문맥 도움말: data-guide="주제" 요소를 누르면 그 주제를 연다.
  listen(
    document,
    "click",
    event => {
      const trigger = event.target instanceof Element ? event.target.closest("[data-guide]") : null;
      if (!trigger) return;
      event.preventDefault();
      event.stopPropagation();
      open(trigger.dataset.guide);
    },
    { capture: true }
  );
  // ---- UI 둘러보기 ----
  const openPanel = tab => {
    if (document.body.classList.contains("panel-hidden")) $("panelToggle").click();
    document.querySelector(`#panelTabs [data-tab="${tab}"]`)?.click();
  };
  // 좁은 화면에서는 패널이 뷰포트를 덮으므로, 화면 요소를 설명하는 단계에서는 패널을 닫는다.
  const closeOverlayPanel = () => {
    if (window.matchMedia?.("(max-width:820px)").matches && !document.body.classList.contains("panel-hidden"))
      $("panelToggle").click();
  };
  const prepareStep = action => {
    if (!action) return;
    if (action.startsWith("panel:")) openPanel(action.slice(6));
    else if (action === "open-editor") {
      // 편집기를 열어도 패널은 그대로이므로, 좁은 화면에서 편집기를 덮는 서랍은 투어가 직접 닫는다(끝나면 되돌린다).
      closeOverlayPanel();
      studio.open();
    } else if (action === "stage") closeOverlayPanel();
    else if (action === "close-editor") {
      if (!$("studioDock").hidden) studio.close();
      closeOverlayPanel();
    }
  };
  const overlay = element("div", "guide-tour");
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "guideTourTitle");
  const spot = element("div", "guide-tour-spot"),
    card = element("div", "guide-tour-card");
  const stepLabel = element("span", "guide-tour-step"),
    title = element("h3"),
    text = element("p"),
    tools = element("div", "guide-tour-tools");
  title.id = "guideTourTitle";
  const prev = element("button", "", "이전"),
    next = element("button", "primary", "다음"),
    skip = element("button", "guide-tour-skip", "닫기");
  for (const button of [prev, next, skip]) button.type = "button";
  tools.append(skip, prev, next);
  card.append(stepLabel, title, text, tools);
  overlay.append(spot, card);
  document.body.append(overlay);
  let step = 0,
    tourActive = false;
  const place = () => {
    if (!tourActive) return;
    const item = TOUR[step],
      target = document.querySelector(item.target),
      rect = target?.getBoundingClientRect();
    const visible = rect && rect.width > 0 && rect.height > 0,
      pad = 6,
      vw = window.innerWidth,
      vh = window.innerHeight;
    // 화면보다 긴 패널은 보이는 부분만 강조한다.
    if (visible) {
      const top = Math.max(rect.top - pad, 4),
        bottom = Math.min(rect.bottom + pad, vh - 4);
      Object.assign(spot.style, {
        left: `${rect.left - pad}px`,
        top: `${top}px`,
        width: `${rect.width + pad * 2}px`,
        height: `${Math.max(0, bottom - top)}px`,
      });
      spot.hidden = false;
    } else spot.hidden = true;
    // 카드: 대상 아래 → 위 → 오른쪽 → 화면 중앙 순으로 들어갈 자리를 찾는다.
    const cw = Math.min(340, vw - 24),
      ch = card.offsetHeight || 180;
    let left = (vw - cw) / 2,
      top = (vh - ch) / 2;
    if (visible) {
      left = Math.min(Math.max(12, rect.left), vw - cw - 12);
      if (rect.bottom + 14 + ch < vh) top = rect.bottom + 14;
      else if (rect.top - 14 - ch > 0) top = rect.top - 14 - ch;
      else if (rect.right + 14 + cw < vw) {
        left = rect.right + 14;
        top = Math.min(Math.max(12, rect.top), vh - ch - 12);
      } else if (rect.left - 14 - cw > 0) {
        left = rect.left - 14 - cw;
        top = Math.min(Math.max(12, rect.top), vh - ch - 12);
      }
      // 들어갈 자리가 없을 만큼 큰 대상은 제목·상단 내용이 보이도록 카드를 화면 아래쪽에 붙인다.
      else {
        left = (vw - cw) / 2;
        top = Math.max(12, vh - ch - 12);
      }
    }
    Object.assign(card.style, { left: `${left}px`, top: `${top}px`, width: `${cw}px` });
  };
  const showStep = index => {
    step = Math.max(0, Math.min(TOUR.length - 1, index));
    const item = TOUR[step];
    prepareStep(item.prepare);
    stepLabel.textContent = `${step + 1} / ${TOUR.length}`;
    title.textContent = item.title;
    text.textContent = item.text;
    prev.disabled = step === 0;
    next.textContent = step === TOUR.length - 1 ? "완료" : "다음";
    document.querySelector(item.target)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    // 패널·편집기가 열리며 레이아웃이 바뀌므로 다음 프레임에 위치를 계산한다.
    requestAnimationFrame(() => requestAnimationFrame(place));
    next.focus();
  };
  // 투어는 설명을 위해 편집기·설정 패널을 열고 닫으므로, 시작 전 화면(편집기 열림·패널 표시·패널 탭)을 기억했다가 끝나면 되돌린다.
  let beforeTour = null;
  const uiState = () => ({
    editor: !$("studioDock").hidden,
    panelHidden: document.body.classList.contains("panel-hidden"),
    tab: document.querySelector('#panelTabs [aria-selected="true"]')?.dataset.tab,
  });
  const restoreUi = state => {
    if (!state) return;
    if (state.editor && $("studioDock").hidden) studio.open();
    else if (!state.editor && !$("studioDock").hidden) studio.close();
    if (state.panelHidden !== document.body.classList.contains("panel-hidden")) $("panelToggle").click();
    if (state.tab) document.querySelector(`#panelTabs [data-tab="${state.tab}"]`)?.click();
  };
  const endTour = () => {
    if (!tourActive) return;
    tourActive = false;
    overlay.hidden = true;
    const state = beforeTour;
    beforeTour = null;
    restoreUi(state);
    $("moreToggle")?.focus(); // 가이드 버튼은 ⋯ 메뉴 안에 있어 닫힌 상태에서는 초점을 받지 못한다.
  };
  const startTour = () => {
    if (dialog.open) dialog.close();
    if (!tourActive) beforeTour = uiState();
    tourActive = true;
    overlay.hidden = false;
    showStep(0);
  };
  listen(prev, "click", () => showStep(step - 1));
  listen(next, "click", () => (step === TOUR.length - 1 ? endTour() : showStep(step + 1)));
  listen(skip, "click", endTour);
  listen(overlay, "keydown", event => {
    event.stopPropagation(); // 투어 중에는 E/H/F 같은 전역 단축키가 화면을 바꾸지 않게 한다.
    if (event.key === "Escape") {
      event.preventDefault();
      endTour();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      next.click();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (step) showStep(step - 1);
    }
  });
  listen(window, "resize", place);
  listen($("galleryTour"), "click", () => {
    $("gallery")?.close();
    startTour();
  });
  return {
    open,
    show,
    startTour,
    dispose: () => {
      controller.abort();
      overlay.remove();
      previews.dispose();
    },
  };
};
export { mount };
