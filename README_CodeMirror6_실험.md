# CodeMirror 6 편집기 엔진 (실험)

브랜치 `claude/codemirror6-trial`. 기본 편집기(textarea)는 그대로 두고, **편집기 엔진을 고를 수 있게** CodeMirror 6를 추가했다.

## 켜는 법

편집기 ⋯ 메뉴 → 표시 → **편집기: CodeMirror (실험)** → 새로고침. 다시 "기본"을 고르면 원래 편집기로 돌아간다.
설정은 브라우저(`localStorage`의 `webgl.shader-studio.editor-engine.v1`)에 저장되고, 기본값은 **기본 편집기**다.

## 구조

| 파일 | 역할 |
|---|---|
| `js/codemirror.js` | 미리 번들링한 CodeMirror 6 (MIT). `load()`를 처음 부를 때 초기화되므로 기본 편집기를 쓸 때는 비용이 없다. **손으로 고치지 않는다.** |
| `js/cm-editor.js` | `code-editor.js`와 같은 `mount()` API를 CodeMirror로 구현. `#studioCode` textarea를 CodeMirror 문서의 창구(facade)로 만들어 `studio.js`를 거의 고치지 않았다. |
| `js/glsl-language.js` | 두 편집기가 함께 쓰는 GLSL 언어 정보(키워드·타입·앱 Uniform·심볼 표·설명·자동 완성 후보). `code-editor.js`에서 글자 그대로 옮겼다. |
| `tools/codemirror/` | `js/codemirror.js` 생성 도구(`npm install && npm run build`). 앱 실행·배포에는 npm이 필요 없다. |

- 되돌리기는 지금처럼 studio가 맡는다(CodeMirror history 미사용). 사용자의 편집·선택·키 입력은 textarea의 `input`·`select`·`keydown` 이벤트로 다시 알린다.
- 배포 번들(`tools/build_deploy.py`)은 그대로 파이썬만으로 동작하고, `file://` 배포본에서도 CodeMirror 모드가 동작한다.

## 옮겨진 기능

GLSL 문법 강조(같은 색 규칙), 줄 번호, 괄호 짝 강조·자동 닫기, `{` 기준 자동 들여쓰기, **코드 접기**, **여러 커서(Ctrl+D · Ctrl+Shift+L · Alt+드래그 사각 선택, 화살표로 함께 이동)**, 검색·바꾸기(대소문자·정규식·단어), 자동 완성(퍼지 일치·앱 Uniform 선언 자동 추가·코드 조각 함수·템플릿), 컴파일 오류 표시(줄 표시·밑줄), 마우스 설명, 명령 팔레트(@ 함수·변수 · : 줄 번호), 함수 목록, 글자 크기·줄바꿈·들여쓰기 설정, 줄 주석·블록 주석, 줄 이동·복사·삭제.

## 아직 옮기지 않은 기능 (2단계)

시그니처 도움말, 숫자 조절(Ctrl+↑/↓ · Alt+드래그), 색상 미리보기·선택기, 정의로 이동(F12·Ctrl+클릭), 이름 바꾸기(F2), 들여쓰기 안내선, 오류 메시지의 줄 끝 표시(지금은 밑줄·줄 표시·말풍선).

## 용량 (압축 후, 배포 번들 기준)

| | 압축(minify) | gzip |
|---|---|---|
| 이전 `main` | 446 KB | 134 KB |
| 두 엔진 모두 포함 | 887 KB | 277 KB |

기본 편집기를 걷어내면 조금 줄어든다.

## 검증

- `tests/cm-editor-browser-regression.py`: CodeMirror 엔진 검사 30개(창구 규칙, studio 연동, 편집 기능).
- 기본 엔진의 기존 테스트는 모두 그대로 통과한다. 브라우저 콘솔 스크립트 13개 중 11개는 CodeMirror 모드에서도 통과하고, 나머지 2개(`compact-polish`, `ux`)는 숨은 textarea에 가짜 키 이벤트를 보내 기본 편집기를 직접 검사하는 스크립트다.
