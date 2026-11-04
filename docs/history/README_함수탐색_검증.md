# Shader Studio — UX 02: GLSL 함수 탐색기

## 사용 방법

1. `index.html`을 열고 `E`로 편집기를 표시합니다.
2. 코드 편집 도구의 `ƒ Functions (N)`을 펼치면 **현재 Image/Buffer 패스**에서 찾은 함수 정의가 선언 순서로 표시됩니다.
3. `이름(매개변수) · Ln 줄번호` 항목을 선택하면 해당 GLSL 원본 줄로 이동합니다. 같은 함수로 여러 번 이동할 수 있습니다.
4. GLSL 편집, Undo/Redo, 패스 전환 시 목록이 자동으로 갱신됩니다. 정의된 함수가 없으면 목록이 비활성화됩니다.

목록은 간단한 **렉시컬 탐색**입니다. GPU/GLSL 컴파일을 호출하지 않으며, 주석·문자열·전처리 지시문(연결된 여러 줄 포함) 내부와 함수 내부의 가짜 선언, 중괄호가 없는 함수 프로토타입을 제외합니다. 오버로드와 여러 줄 매개변수를 구별합니다. 다만 완전한 GLSL 구문 분석기나 전처리기 평가기는 아니므로 `#if 0`처럼 조건부 컴파일로 비활성화된 소스의 실제 유효성까지 판단하지 않습니다.

## 변경 사항

- `js/code-editor.js`: 기존 편집기 안에서 함수 목록을 추출하고, 선택 시 기존 `goToLine` 함수를 재사용. 업데이트는 이미 사용 중인 `requestAnimationFrame` 렌더 배치에서 실행합니다.
- `index.html`: 드롭다운과 빠른 도움말 설명 1개 추가.
- `style.css`: 목록 너비 제한 1개 추가.
- `tests/function-navigation-browser-regression.py`: Chromium + 모의 Renderer 기반 UI/회귀 검사. npm 또는 실제 GPU 필요 없음.
- 새로운 AMD 모듈과 외부 라이브러리 없음. `js/studio.js`, `js/renderer.js`, GPU 검증 23개 항목은 변경하지 않음.

## 검증

프로젝트 루트에서 (테스트 환경에 Python Playwright 및 Chromium이 있는 경우):

```sh
python tests/function-navigation-browser-regression.py
```

테스트에서는 오버로드, 여러 줄 서명, 주석/전처리문/프로토타입 제외, 구조체 내부 제외, 정확한 커서 이동, 중복 선택, Undo 변경 없음, Image ↔ Buffer 전환, 소스 편집, Undo/Redo, 비활성 드롭다운, Chromium 예외 없음 등을 확인합니다.

기존 자동 검증: `node tests/architecture-regression.js`, `node tests/runtime-integrity.js`, 다른 `tests/*-regression.js` (Node 전용), `python tests/undo-browser-regression.py`, `python tests/compiler-lines-browser-regression.py`.

이전 버전에 대해 사용자가 **GPU Validation 23 PASS / 0 FAIL / 0 SKIP**을 보고했습니다(2026-10-14, Windows Chrome 155). 이번 변경은 편집기 DOM/소스 탐색에 한정되므로 GPU 검사 항목은 늘리지 않았고, 수정본에 대한 실GPU 재검증은 수행하지 않았습니다.

## 인쇄/필사

프로그램을 옮길 때 필수 파일은 여전히 `index.html`, `style.css`, `js/*.js`의 총 13개입니다. 검증 파일·README는 실행에 필요하지 않으며 종이 인쇄에서 제외할 수 있습니다.
