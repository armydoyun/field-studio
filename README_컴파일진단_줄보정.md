# Shader Studio — 첫 사용자 편의 개선: GLSL 오류 줄 번호 보정

## 변경 목적

기존 에디터에는 컴파일 오류 버튼을 눌러 줄로 이동하는 기능이 이미 있었습니다. 하지만 Renderer가 사용자 Uniform 선언을 자동 삽입하면 GPU 컴파일러가 보고하는 줄 번호는 **확장된 GLSL 기준**이라 원본 소스의 줄 번호와 달라졌습니다.

## 변경 파일

- `js/renderer.js` — Image, Buffer, Pack 모두 원본 GLSL로 컴파일을 시작하도록 공유 `compileFragment` 함수로 통일. 컴파일에 실패했을 때만 자동 Uniform의 삽입 시작 줄과 추가된 줄 수를 오류 객체에 첨부. 기존 `buildFragment` 동작, 실제 GLSL 문자열 및 GPU 리소스 롤백 방식은 유지.
- `js/studio.js` — 기존 오류 버튼을 재사용해 원본의 줄 번호로 보정. 자동 생성된 Uniform 자체에서 오류가 난 줄은 편집 가능한 줄이 아니므로 이동 버튼을 비활성화.
- `tests/architecture-regression.js` — GPU 모의 컴파일 오류의 실제 줄 번호를 생성하고, 자동 선언/명시적 선언/Buffer 실패 후 롤백에 대한 세 가지 회귀 테스트 추가.
- `tests/compiler-lines-browser-regression.py` — 실제 Chromium DOM에서 진단 버튼·줄 이동·생성 줄 비활성화를 검증. GPU 렌더링은 모의 객체로 대체.
- `tests/gpu-validation.js` — 실GPU 컴파일러의 반환 줄 번호를 검사하는 23번 검사 추가. 기존 1~22번은 그대로 유지.

프로덕션 실행 파일은 **위 두 JavaScript 파일만 수정**, 다른 앱 소스 및 HTML/CSS는 변경하지 않았습니다.

## 실브라우저 검사

1. ZIP을 압축 해제합니다.
2. `tests/gpu-validation.html`을 Chrome/Edge에서 열고 전체 GPU 테스트를 실행합니다.
3. 예상 결과: **PASS 23 / FAIL 0 / SKIP 0** (선택 확장을 모두 제공하는 환경 기준). 23번은 새 기능에 대한 검증입니다.
4. 실제 편집기에서도 확인하려면 `index.html`을 열고 Shader Studio의 오류 줄 이동을 사용합니다. 등록한 사용자 Uniform이 자동 주입되는 상태에서 의도적인 GLSL 오류를 만들고, `Line N`을 눌러 원본 위치로 이동하는지 확인합니다. 기존 프로젝트를 보존하려면 Export Pack으로 먼저 백업합니다.

참고: Chromium 계열 GPU 컴파일러의 `ERROR: 0:LINE: ...` 형식을 기준으로 줄 이동을 제공합니다. 브라우저마다 출력 형식이 달라 오류 버튼 대신 전체 Compiler output만 표시될 수 있습니다. GPU 검증은 브라우저별로 별도 수행해야 합니다.

## 작성 환경에서 완료한 검사

- `node tests/architecture-regression.js` → **44개 PASS**.
- `python tests/compiler-lines-browser-regression.py` → **6개 PASS** (실제 Chromium DOM / 모의 GPU).
- 그 외 기존 Node/Python 회귀 검사 및 SHA-256 파일 검증은 최종 패키지 생성 시 실행.
- 실제 WebGL2 픽셀/컴파일러 검사는 작성 환경에서 실행할 수 없으므로 **사용자 브라우저에서 23번 검사 필요**.
