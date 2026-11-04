**2026-10-15 UX 2차:** 채널별 프레임 설명과 제한 이유, 파일명 기반 연결 목록, 편집/실행 구성 구분, 이미지 연결 목적지와 빈 채널 상태를 개선했습니다. 최신 내용은 `README_UX_2차_채널연결.md`입니다.

**2026-10-15 UX 1차:** 실행·소스 보관·내보내기 상태 분리, 패스 이동/삭제 영향 안내와 되돌리기, 프로젝트 문맥 자동 완성, 편집/미리보기 대상 표시를 적용했습니다. 최신 내용은 `README_UX_1차_작업상태_연결.md`입니다.

**2026-10-15 아이콘 정렬 보정:** 삭제·닫기·이동·재생 등 아이콘의 글꼴 의존성을 제거하고 SVG 도형과 정사각형 버튼으로 정리했습니다. 최신 변경과 검증 범위는 `README_아이콘_정렬.md`입니다.

**2026-10-15 HTML/CSS 전면 정리:** 누적 스타일을 컴포넌트별로 통합하고 패널·폼·툴바·모달의 여백/정렬을 재구성했습니다. 실행 JavaScript는 변경하지 않았습니다. 최신 UI 기준과 검증 범위는 `README_UI_정렬_전면정리.md`입니다.

**2026-10-15 모달/간격 보정:** Enter가 포커스된 취소·닫기 버튼을 실행하던 기본 동작을 차단하고 수락 경로로 통일했습니다. 도구 본문의 padding/gap과 카드·입력·모달 간격을 정리했습니다. 최신 내용은 `README_모달_Enter_간격정리.md`입니다.

**2026-10-15 작업공간 개편:** 도구 그룹/보조 도구 분리, 편집·실행 상태 구분, 패스별 커서 복원, 뷰포트 재생·Image 복귀, 파일 처리/저장 범위, 반응형 높이와 모바일 패널 흐름을 개선했습니다. 최신 기준과 검증 한계는 `README_작업공간_UX_개편.md`입니다.

**2026-10-15 입력/예제 개선:** 닫는 괄호 앞 중첩 자동 완성 수정, bool 파라미터 스위치 적용, Doom Fire 제거 및 current 후처리/previous 잔상 학습 예제로 교체. 최신 내용은 `README_괄호_스위치_실용예제.md`를 참고하세요.

**2026-10-15 파라미터 통합/UX:** Required 경로를 제거하고 프로젝트 파라미터 하나로 통합했습니다. 삭제 되돌리기, 입력 오류 복구, 편집기→파라미터 연결, 내장 변수 참조를 추가했습니다. 설정 초기화는 이제 파라미터와 코드를 보존합니다. 최신 기준은 `README_파라미터_UX.md`입니다.

**2026-10-15 Starter 소유권 수정:** Starter는 기존 Custom을 새 목록으로 교체합니다. uCameraOrbit은 고정 Required에서 제거되어 Ray Starter가 등록하는 선택적 Custom 입력이 되었습니다. Undo/Redo·기존 설정 이관·검증은 `README_Starter_카메라_소유권.md`를 참고하세요.

**2026-10-15 2차 심층 수정:** 비동기 파일 입력·캡처 재생·FPS 제한·복구 실패·이미지 저장 순서·Unicode 검색·IME 및 편집 반복 비용을 수정했습니다. 현재 분석과 검증 범위는 `README_추가분석_2차_2026-10-15.md`에 정리했습니다.

**2026-10-15 로직 수정:** Run/Pack/Uniform 적용의 프로그램 교체 순서, Ray Starter 전환, GLSL Uniform 주입, Pack 시점 일관성, 비동기 이미지 수명을 수정했습니다. 현재 검증 범위는 `README_로직수정_2026-10-15.md`를 참고하세요. 아래 과거 검증 기록은 당시 버전에 관한 것입니다.

**2026-10-14 범용 Shader Art 전환:** 기본 GLSL을 2D 절차적 아트로 변경하고, 기존 SDF Ray Marching은 `Starter Projects > Ray Marching · SDF`로 이동했습니다. 전용 조절값은 `Uniforms > Custom`에 표시되며 이전 Ray API/저장 포맷은 호환성을 위해 유지합니다. `README_범용쉐이더_전환.md` 참고.

**2026-10-14 코드 접기 롤백:** 접힌 상태에서 일반 편집과의 일관성이 부족하여 Folding 기능과 전용 UI를 완전히 제거하고, UX 06 GLSL 자동 완성 상태로 복원했습니다. 자세한 내용은 `README_코드접기_롤백.md`를 참고하세요.

**2026-10-14 UX 06:** GLSL 이름 자동 완성 (`Ctrl+Space` / `Complete`) → `README_자동완성_검증.md` 참조.

**2026-10-14 UX 05:** GLSL 선택 줄 위/아래 이동 (`Alt+↑/↓`) → `README_줄이동_검증.md` 참조.

**2026-10-14 UX 04:** GLSL 자동 들여쓰기·내어쓰기 보강 → `README_들여쓰기_검증.md` 참조.

**2026-10-14 UX 03:** GLSL 자동 괄호·따옴표 닫기 및 편집 회귀 테스트 → `README_자동괄호_검증.md` 참조.

**2026-10-14 최종 검증:** GPU 실패 경로 보강 및 13개 실행 소스 SHA-256 검사 → `README_최종무결성_검증.md` 참조.

**최신 UI: `README_Custom_Modal.md` — 기본 prompt/confirm을 통일된 입력·확인 모달로 교체.**

**최신 디자인: `README_UI_Matte.md` — 민트/블러 제거, Render 예제 버튼 명시적 스타일 적용.**

# WebGL2 Shader Studio — 경량화 통합본

순수 브라우저 JavaScript(AMD)와 GLSL ES 3.00으로 만든 범용 Shader Art / Multi-pass Shader Studio입니다. npm, 빌드, CDN, 외부 에디터가 필요 없습니다.

## 실행

1. ZIP 전체를 같은 폴더 구조로 압축 해제합니다.
2. `index.html`을 WebGL2를 지원하는 브라우저에서 직접 엽니다(`file://` 가능).
3. 우측 상단 편집기 버튼 또는 `E` 키로 Shader Studio를 엽니다.
4. `+ Buffer`로 렌더 패스를 만들고 `iChannel0~3`에 Buffer(current/previous) 또는 로컬 Texture를 연결합니다.
5. `Ctrl+Enter`/Run으로 GLSL을 적용합니다. 잘못된 코드의 컴파일이 실패하면 이전 GPU 프로그램을 유지합니다.
   현재 패스의 함수 정의는 편집기 `ƒ Functions` 목록에서 직접 찾아 이동할 수 있습니다 (`README_함수탐색_검증.md`).
6. Texture 원본은 가능한 경우 IndexedDB, 셰이더 프로젝트와 설정은 localStorage에 저장됩니다. 다른 브라우저로 옮길 때는 **Export Pack / Import Pack**으로 연결된 이미지와 사용자 Uniform·렌더링 설정까지 옮길 수 있습니다. (자세한 내용은 `README_Portable_Pack.md`)

## 프로젝트 구조

```
index.html                설정 패널, Canvas, Shader Studio UI
style.css                 앱 스타일
js/loader.js              file:// 호환 AMD 모듈 로더
js/main.js                앱 초기화 및 모듈 연결
js/renderer.js            GPU 프로그램, Uniform, 애니메이션, Context Loss, 캡처
js/pass-manager.js        Buffer 패스, Ping-Pong FBO, 채널 연결
js/texture-input.js       이미지 업로드, IndexedDB, GPU Texture 관리
js/studio.js              GLSL 편집·프로젝트·버퍼/채널 UI
js/code-editor.js         코드 검색/치환, 함수 탐색·자동 완성, 자동 괄호, 줄번호, 단축키
js/ui.js                  FPS/해상도/Uniform/입력 패널
js/input.js               마우스·키보드 Orbit Camera
js/settings.js            사용자 설정 자동 저장
js/shader.js              범용 기본 GLSL과 SDF Ray Marching Starter
 tests/                   Node 모의 GPU 및 브라우저 회귀 검사
```

## 소스 수정 위치

- **기본 예제 전체**: `js/shader.js`의 `fragment` 문자열(시간·마우스 기반 2D 아트). `raymarch`에는 SDF 프리셋이 있습니다.
- **새로운 셰이더 작성**: 웹 편집기에서 Image 또는 Buffer 패스의 GLSL을 교체합니다.
- **Ray Marching 설정**: Starter Projects에서 Ray Marching 프리셋을 적용한 뒤 `Uniforms > Custom`에서 조정합니다.
- **멀티패스 셰이더**: Shader Studio에서 패스를 생성하고 GLSL과 채널 연결 수정.
- **GPU 버퍼 처리**: `pass-manager.js`. 새 패스마다 2개의 Texture를 번갈아 사용합니다. 동일 Texture에서 동시에 읽기/쓰기는 금지합니다.
- **Uniform**: UI에서 사용자 변수 추가; `window.shaderPlayground.setUniform(name,value)`로 코드에서도 갱신.

## 조작

- `F`: 전체화면, `H`: 설정 패널, `G`: HUD, `E`: 편집기.
- 마우스 드래그: 카메라 회전, 휠: 줌, WASD/방향키: 카메라 조작, `R`: 초기화.
- 편집기: `Ctrl+Enter` 실행, `Ctrl+F` 검색, `Ctrl+H` 치환, `Ctrl+/` 주석, `Ctrl+Shift+D` 줄 복제, `Alt+↑/↓` 현재/선택 줄 이동, `Ctrl+Space` GLSL 자동 완성.
- `.frag`/`.glsl` 파일을 편집기에 끌어오거나 이미지(PNG/JPEG/WebP)를 드롭할 수 있습니다.

## 검증

- 선택 사항(Node.js): `node tests/architecture-regression.js`, `node tests/texture-regression.js`.
- 실제 브라우저 검사는 `tests/ux-regression.js`, `tests/multipass-regression.js` 등의 내용을 개발자 콘솔에서 실행합니다.
- 테스트 전에 미적용 소스와 중요한 GPU 피드백 데이터를 백업하세요. 복원은 GPU 누적 데이터까지 보장하지 않습니다.

## 제한

이 패키지는 원래 v4.1을 경량화한 것으로, GPU 알고리즘과 CSS 디자인은 변경하지 않았습니다. WebGL2 및 브라우저별 `file://` 저장소 지원은 실제 브라우저에서 확인해야 합니다. 일부 GPU 확장(예: RGBA32F 렌더링)은 미지원일 수 있습니다.


## 최종 편집기 미세개선

최근 최종 미세경량화와 Tab/패스 탐색 단축키, 이미지 Context Loss 복구 수정 내용은 `README_최종개선.md`에 정리했습니다.


## 최종 편집기 미세개선

최근 최종 미세경량화와 Tab/패스 탐색 단축키, 이미지 Context Loss 복구 수정 내용은 `README_최종개선.md`에 정리했습니다.


## 버튼 도움말 · 단축키 한눈에 보기 (마지막 개선)

- 화면 우측 상단 `?` 또는 Shader Studio 상단 `? Help` 버튼으로 도움말을 엽니다. 입력창 밖에서 `?` 키로도 열고 닫습니다. `Esc`는 도움말을 닫습니다.
- 모든 주요 편집·버퍼 버튼에 마우스를 올리면 기능과 단축키를 확인할 수 있습니다. `iChannel` 드롭다운에는 Buffer의 현재/이전 프레임 의미가 표시됩니다.
- 도움말은 처음 사용하는 순서, 화면/카메라, GLSL 편집 단축키, 버퍼 연결 개념을 포함합니다. 외부 라이브러리 없이 네이티브 `<dialog>` 한 개로 구현했습니다.
- GLSL 입력 중 `?` 키는 도움말 대신 텍스트 입력으로 처리합니다. 도움말이 열린 동안 배경 화면의 단축키는 실행하지 않습니다.
- 코드 경량화: 시작 시 초기 설정을 두 번 대입하는 중복을 제거하고 Ray Marching 설정값 재조회도 합쳤습니다. GPU/GLSL 동작은 변경하지 않았습니다.

### 실행 코드량 비교 (JavaScript, GLSL 포함)

| | 이전 | 최종 |
|---|---:|---:|
| 모듈 수 | 15 | 15 |
| 코드 줄(빈줄·주석 포함) | 1823 | 1824 |
| UTF-8 바이트 | 141004 | 141075 |

HTML/CSS 도움말이 추가되었으므로 전체 프로젝트의 파일 크기는 늘었습니다. 코드량 절감은 새로운 사용자 기능을 추가하면서도 실행용 JS의 증가를 억제한 것입니다.

### 검증

- `node tests/architecture-regression.js` (기존 24개 항목)
- `node tests/texture-regression.js` (로컬 이미지 저장·연결)
- 실브라우저 UI 모의 테스트: `?`·`Esc`, 입력창 단축키 충돌, 두 곳의 도움말 버튼, 기존 편집기 들여쓰기·패스 탭 이동
- `tests/help-regression.js`는 실제 브라우저 개발자 콘솔에서 실행할 수 있습니다.

## 실제 GPU 자체 검사

브라우저에서 `tests/gpu-validation.html`을 열고 **GPU 테스트 실행**을 선택하세요. 자세한 설명은 `README_GPU_검증.md`에 있습니다. 이 페이지의 실제 GPU 검사는 실행 환경마다 결과가 달라질 수 있습니다.

## Texture Sampling

Shadertoy식 로컬 이미지 채널을 선택한 뒤 Filter(Nearest/Linear)와 X·Y Wrap(Clamp/Repeat/Mirror)을 바꿀 수 있습니다. 옵션은 이미지별로 적용되고 IndexedDB에 함께 저장됩니다. `README_Texture_Sampling.md`를 참고하세요.

## UI/UX 개선

새 인터페이스의 디자인·호환성·테스트 결과는 `README_UI_Refresh.md`를 참고하세요. 기존 Shader Studio의 데이터 포맷과 단축키는 바뀌지 않았습니다.

## 편집 Undo/Redo 개선

- Undo/Redo는 GPU 적용 성공과 관계없이 GLSL 초안·버퍼/채널 변경을 기록합니다. 컴파일에 실패한 코드도 Undo로 되돌리고 Redo로 재확인할 수 있습니다.
- 연속된 일반 타이핑은 700ms 이내의 동일 패스 입력을 하나의 Undo 단계로 합칩니다(최대 25단계). 붙여넣기·도구 편집은 별도 단계입니다.
- GLSL 입력칸에서 `Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z` (macOS `Cmd` 동일)를 지원합니다. Undo/Redo 시 복구 코드를 컴파일하고 실패하면 이전 GPU 프로그램을 유지합니다.
- 이력은 메모리에서만 관리하며, 새로고침 후까지 유지하지 않습니다. 프로젝트 Pack에도 포함되지 않습니다.
- 테스트: `python tests/undo-browser-regression.py` (Chromium/Playwright 설치 환경); 실제 GPU 동작은 `tests/gpu-validation.html`로 별도 검사합니다.

## Undo 커서 복원 수정
편집기 Undo/Redo가 선택 범위 및 스크롤 위치를 복원합니다. `README_Undo_커서복원.md`를 참고하세요.
