# Shader Studio — UX 04: GLSL 들여쓰기 개선

## 적용 기능

- **Enter**: 현재 줄의 선행 공백/탭을 이어 받고, 코드에서 여는 중괄호 `{` 뒤라면 설정된 Tab 크기(2 또는 4)만큼 추가 들여쓰기합니다. `{   }`처럼 중괄호 주변에 공백이 있어도 줄을 분리해 올바르게 정렬하고, `{` 뒤 불필요한 공백은 제거합니다.
- **주석·문자열 안전성**: `// {`, `/* {`, `"{"`의 중괄호는 새로운 코드 블록으로 인식하지 않습니다.
- **닫는 중괄호 `}`**: 공백/탭으로만 구성된 들여쓰기 위치에서 입력하면 한 단계 내어쓰기 후 삽입합니다. 커서 바로 뒤에 `}`가 있는 경우에는 중복 삽입 대신 기존 기호 위로 커서를 이동합니다.
- **Tab / Shift+Tab, Ctrl+] / Ctrl+[**: 기존 선택 줄 들여쓰기·내어쓰기 기능을 유지하면서, 빈 줄에 불필요한 공백을 추가하지 않습니다. 내용이 변화하지 않는 입력은 Undo 기록도 만들지 않습니다.
- **Undo/Redo**: 자동 들여쓰기와 내어쓰기를 기존 프로젝트 편집 기록으로 관리합니다.

이 기능은 일반적인 코드 **자동 정렬/전체 포매터**가 아닙니다. 매크로, 전처리 지시문, 복잡한 GLSL 문법을 일괄 수정하지 않습니다. 키 입력 직후의 국소 들여쓰기만 처리하므로 기존 소스를 의도치 않게 재작성하지 않습니다.

## 수정 범위

- 프로덕션: `js/code-editor.js` **1개 파일 수정**. 나머지 12개 실행 파일은 변경하지 않았습니다. 외부 라이브러리·AMD 모듈·HTML/CSS 요소는 추가하지 않았습니다.
- 신규 검사: `tests/indent-browser-regression.py` (Chromium + Playwright, GPU 없이 33개 PASS 검사).
- 문서: 이 파일과 `README.md` 상단 안내, 실행 파일/전체 파일 SHA-256 목록 갱신.

## 실행 방법

1. `index.html`을 브라우저에서 열고 **E**를 눌러 GLSL 에디터를 실행합니다.
2. `{` 입력 → **Enter**, `}` 입력, 다중 줄 선택 → **Tab/Shift+Tab**, 설정에서 들여쓰기 크기를 2/4로 바꿔 동작을 확인합니다.
3. 자동 테스트가 가능한 개발 환경에서는 아래 명령을 실행합니다.

```sh
python tests/indent-browser-regression.py
python tests/autopair-browser-regression.py
python tests/undo-browser-regression.py
node tests/architecture-regression.js
node tests/runtime-integrity.js
```

GPU 검증 페이지는 기존 23개 검사를 그대로 유지합니다. GPU 렌더러 및 패스 관리는 이번 변경에서 수정되지 않았습니다. 기존 GPU 23/23 PASS는 직전 기준본에서 사용자가 검증한 결과이며, 이번 ZIP의 새 브라우저 GPU 검사를 수행한 것은 아닙니다.
