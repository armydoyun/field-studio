# Shader Studio — UX 06: GLSL 이름 자동 완성

## 사용

1. `index.html`에서 `E`를 눌러 편집기를 열고 `vec`, `tex`, `nor`처럼 식별자를 입력합니다.
2. `Ctrl+Space` 또는 툴바의 `Complete`를 클릭하면 후보가 나타납니다.
3. `↑/↓`로 선택하고 `Enter` 또는 `Tab`으로 확정합니다. 마우스로 후보를 클릭해도 됩니다. `Esc`는 취소합니다.
4. 후보에는 주요 GLSL ES 3.00 내장 함수·타입·예약어·프로젝트 Uniform 이름 및 **현재 편집 중인 소스의 함수 정의**가 포함됩니다. 최대 8개까지 이름순으로 표시합니다.
5. 단순한 이름 보완 기능이며 매개변수 자동 채우기, GLSL 타입 추론, 외부 라이브러리, 백그라운드 분석은 제공하지 않습니다. 현재 `Image`/`Buffer` 소스가 바뀌면 다시 검색합니다.

## 안전성 및 변경 범위

- **런타임 3개 파일만 변경**: `js/code-editor.js`, `index.html`, `style.css`. 기존 `scanFunctions`, `replaceSelection`, `beforeEdit` 및 Undo/Redo를 재사용합니다.
- `Ctrl+Space` 호출 시에만 후보를 계산하며 자동 입력 중 팝업을 띄우지 않습니다. 이 방식은 긴 GLSL 코드에서 불필요한 비용과 오작동을 줄입니다.
- 주석·문자열이나 선택 영역에서는 자동 완성을 열지 않습니다. 정규식으로 식별자를 판별하므로 완전한 GLSL 파서는 아닙니다.
- 사용자가 승인하기 전에는 GLSL을 수정하지 않습니다. 기존 줄 이동, 자동 괄호, 검색 및 GPU 실행 코드는 유지합니다.
- `tests/completion-browser-regression.py`에 Chromium 상호작용·예외·Undo/Redo 검사를 추가했습니다.

## 개발 환경에서 실행한 검사

```sh
python tests/completion-browser-regression.py
python tests/autopair-browser-regression.py
python tests/indent-browser-regression.py
python tests/move-lines-browser-regression.py
python tests/function-navigation-browser-regression.py
python tests/compiler-lines-browser-regression.py
python tests/undo-browser-regression.py
python tests/undo-cursor-regression.py
node tests/architecture-regression.js
node tests/runtime-integrity.js
```

실제 GPU 검사는 이전 사용자 환경에서 23/23 통과했지만 UX 06 변경 후 재실행하지 않았습니다. 렌더러/GPU 파일은 UX 05 기준본과 동일합니다.
