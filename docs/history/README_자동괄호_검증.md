# Shader Studio — UX 03: GLSL 자동 괄호 편집

## 사용

- 편집기에서 `(`, `[`, `{`, `"`를 입력하면 커서 뒤에 닫는 문자를 자동으로 추가합니다.
- 선택 영역이 있을 때 여는 문자를 입력하면 선택 영역을 감싸고, 원래 선택 영역을 계속 선택된 상태로 둡니다.
- 닫는 괄호·따옴표가 커서 바로 뒤에 있을 때 해당 닫는 문자를 누르면 중복 입력하지 않고 넘깁니다.
- 빈 괄호/따옴표 사이에서 Backspace를 누르면 쌍을 함께 삭제합니다.
- `{}` 안에서 Enter를 누르면 안쪽 들여쓰기와 닫는 중괄호 줄을 자동으로 배치합니다. 기존 Tab 크기 2/4와 선행 들여쓰기를 따릅니다.
- GLSL `//` 및 `/* */` 주석, 문자열 내부에서는 불필요한 자동 닫기를 수행하지 않습니다. 편집기 내부 Undo/Redo와 커서 복원은 유지됩니다.

닫는 괄호 건너뛰기와 빈 쌍 삭제는 커서 주변의 문자 패턴에 따라 작동하며, 자동 생성 여부를 따로 저장하지 않습니다. 따라서 기존 소스의 연속된 괄호 사이에서도 동일한 동작을 할 수 있습니다. `codeMode`는 의도적으로 경량화된 주석/문자열 스캐너이며 완전한 GLSL 파서가 아닙니다.

## 변경 파일

- **프로덕션:** `js/code-editor.js` 한 파일만 수정. 기존 입력 이벤트와 Undo/Redo 시스템을 재사용하고 새 AMD 모듈, HTML/CSS 요소, 외부 라이브러리는 추가하지 않았습니다.
- **테스트:** `tests/autopair-browser-regression.py` (Chromium/Playwright, 실제 GPU 불필요). 23개 키보드/선택 영역/Undo/Redo/주석/문자열 검사와 Chromium 오류 없음 확인.
- **문서:** 이 파일과 README 개요, 새 소스 체크섬 반영.

## 실행 및 검증

```sh
python tests/autopair-browser-regression.py
node tests/architecture-regression.js
node tests/runtime-integrity.js
```

마지막 실GPU 기준은 이전 버전에 대해 사용자가 보고한 **23 PASS / 0 FAIL / 0 SKIP**입니다. 이번 패치는 `js/renderer.js`, `js/pass-manager.js`, GPU 검증 코드에 손대지 않았으며, 이 새 ZIP에 대한 실GPU 재실행 결과는 아직 받지 않았습니다.

실행에 필수인 파일은 그대로 `index.html`, `style.css`, `js/*.js` 13개입니다. 테스트와 README 파일은 최종 인쇄본에서 제외할 수 있습니다.
