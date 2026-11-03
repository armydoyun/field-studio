# GLSL 코드 편집기 — CodeMirror 6

FIELD Studio의 코드 편집기는 **CodeMirror 6 하나**로 동작한다. 예전 textarea 편집기(`js/code-editor.js`)와 편집기 선택 설정은 제거했다.

## 구조

| 파일 | 역할 |
|---|---|
| `js/codemirror.js` | 미리 번들링한 CodeMirror 6 (MIT, 버전 고정). `load()`로 초기화한다. **손으로 고치지 않는다.** |
| `js/cm-editor.js` | 편집기 본체. CodeMirror 화면, 명령 팔레트, 툴바·메뉴 버튼, 표시 설정, 자동 완성·마우스 설명·접기·검색 연결. |
| `js/cm-glsl-features.js` | GLSL 도우미: 시그니처 도움말, 숫자 조절(Ctrl+↑/↓ · Alt+드래그), 색 견본 위젯과 색상 선택기, 정의로 이동(F12 · Ctrl+클릭), 이름 바꾸기(F2), 들여쓰기 안내선, 줄 끝 오류 메시지. |
| `js/glsl-language.js` | GLSL 언어 정보(키워드·타입·앱 Uniform·심볼 표·설명·자동 완성 후보). 편집기 화면과 무관한 순수 로직. |
| `tools/codemirror/` | `js/codemirror.js` 생성 도구(`npm install && npm run build`). 앱 실행·배포에는 npm이 필요 없다. |

`studio.js`는 `#studioCode` textarea를 읽고 쓴다. 이 textarea는 화면에 보이지 않는 **창구(facade)**로, 값·선택·`setRangeText`·스크롤·포커스가 textarea 규칙대로 CodeMirror 문서를 읽고 쓴다. 사용자의 편집·선택·키 입력은 textarea의 `input`·`select`·`keydown` 이벤트로 다시 알린다. 그래서 되돌리기(코드·버퍼·파라미터를 함께 되돌림), 패스 전환, 자동 적용은 studio가 그대로 맡는다(CodeMirror history는 쓰지 않는다).

## CodeMirror로 쓰는 기능

- **여러 커서**: `Ctrl+D` / `Ctrl+Shift+L`, `Alt+클릭`, `Ctrl+Alt+↑/↓`, `Alt+드래그` 사각 선택. 화살표·입력이 모든 커서에 함께 적용된다.
- **코드 접기**: 줄 번호 옆 화살표, `Ctrl+Shift+[` / `]`, 모두 접기·펴기 `Ctrl+Alt+[` / `]`(편집기 메뉴에도 있음).
- **검색·바꾸기**: `Ctrl+F` / `Ctrl+H`, 대소문자·정규식·단어 단위. 검색 창 문구는 한국어(`EditorState.phrases`).
- **오류**: 줄 표시·밑줄·줄 끝 메시지(편집 후 다음 컴파일 전까지 흐리게), `F8` / `Shift+F8`, 오류 목록 `Ctrl+Shift+M`.
- **자동 완성**: 퍼지 일치, 선언하지 않은 앱 Uniform을 고르면 선언을 함께 추가, 코드 조각 함수·템플릿.
- 괄호 짝 강조·자동 닫기, `{` 기준 자동 들여쓰기, 줄 이동·복사·삭제, 줄·블록 주석, 문서 끝을 지나 스크롤, 빈 문서 안내 문구, `Ctrl+M` Tab 포커스 모드(접근성).

## 용량 (배포 번들, 압축 후)

| | 압축(minify) | gzip |
|---|---|---|
| CodeMirror 도입 전 `main` | 446 KB | 134 KB |
| CodeMirror만 쓰는 지금 | 857 KB | 268 KB |

## 검증

- `tests/cm-editor-browser-regression.py`: 편집기 검사 62개(창구 규칙, studio 연동, 기본 편집, GLSL 도우미, 접기·여러 커서·검색·오류 목록).
- `tests/editor-structure-regression.js`: 편집기 구조 계약(예전 편집기 잔재 없음, 기능·버튼 연결) 정적 검사.
- 되돌리기·진단 줄 번호·시작 예제 브라우저 테스트(`undo-*`, `compiler-lines`, `shader-art`)는 `tests/esm_for_browser.py`의 `EditorModel`로 같은 시나리오를 CodeMirror에서 검사한다.
