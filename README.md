# FIELD Studio — ES Modules (2026-10-18)

WebGL2 / GLSL ES 3.00 기반 Shader Art Studio. 개발 소스는 **표준 JavaScript ES Modules**, 외부 의존성·npm·CDN 없음. 2026-10-15 `a(1).zip` 실행 소스에서 로더 계층만 교체했으며 기능 구현 로직을 보존했습니다.

## 개발용 실행 (`index.html`)

개발 소스(`js/*.js`)는 `import` / `export`로 연결되며 `js/loader.js`와 AMD `define()`은 제거되었습니다.

**주의:** Chrome/Edge에서 ES Module의 `file://` 상대 import는 CORS 정책으로 차단될 수 있습니다. 인터넷은 필요 없지만, 로컬 HTTP 서버로 열어야 합니다.

Python이 설치되어 있다면 프로젝트 루트에서:

```shell
python -m http.server 8000
```

Windows Python Launcher라면 `py -m http.server 8000`도 됩니다. 브라우저에서 `http://127.0.0.1:8000/`으로 접속합니다. 이 서버는 로컬 컴퓨터에서만 작업할 때 `python -m http.server 8000 --bind 127.0.0.1`처럼 localhost 바인딩을 권장합니다.

## 오프라인 배포 (`deploy/index.html`)

배포본은 **`deploy/index.html` 파일 하나**입니다. HTML 안에 압축된 CSS(`<style>`)와 JS(`<script>`)가 모두 들어 있어, 파일을 더블클릭해 `file://`로 열어도 동작하고 메일·메신저로 그대로 보낼 수 있습니다. **배포 대상에서는 Python, npm, 서버, 인터넷이 필요하지 않습니다.**

소스를 고친 다음에는 개발 컴퓨터에서 다시 만듭니다.

```shell
npm install      # 처음 한 번 (esbuild)
npm run build    # → deploy/index.html
```

- `tools/build.mjs`가 esbuild로 `js/main.js`부터 import를 따라 모든 모듈을 묶고 압축한 뒤, `tools/inline-html.mjs`가 `index.html`의 `<link>`·`<script type="module">` 자리에 넣습니다. 모듈 목록을 따로 관리하지 않습니다.
- 예전 3파일 배포본(`deploy/style.css`, `deploy/js/min.js`)이 남아 있으면 빌드가 지웁니다.
- GitHub Actions는 lint와 테스트가 모두 통과하면 같은 빌드를 만들어 실행 페이지의 **Artifacts → field-studio-deploy-<커밋 SHA>**에 올립니다. 셸이 없는 환경에서도 거기서 받으면 됩니다.
- `tests/build-regression.js`가 임시 폴더에 빌드해 보고, 만든 파일을 `file://`로 Chromium에서 열어 앱이 오류·네트워크 요청 없이 뜨는지 확인합니다.
- `python tools/build_deploy.py`(예전 Python 번들러)는 더 이상 쓰지 않습니다.

## 프로젝트 구조

```text
index.html            # 개발용 ESM 진입점
style.css
js/
  main.js             # type=module 진입점
  renderer.js
  gpu-diagnostics.js  # GL 오류 격리, Uniform 리플렉션, GPU 타이머 (README_확장기반_정비.md)
  profiler.js         # 성능·디버그 탭 (README_UX_v2_재설계.md)
  gallery.js          # 예제 갤러리·첫 실행 안내
  annotations.js      # GLSL 주석 @range/@color 파서 (README_파라미터_버퍼_업데이트.md)
  snippets.js         # GLSL 코드 조각 라이브러리(16범주 · 의존성 정보 · 실수/정수 해시) — 조각 추가는 여기 CATEGORIES에
  snippet-preview.js  # 코드 조각 결과 미리보기(조각 id → 그림 함수 PREVIEWS · 공용 WebGL2 컨텍스트) — 새 조각의 그림은 여기에
  guide.js            # 앱 내장 가이드(주제·검색·코드 삽입)·UI 둘러보기·문맥 ? 버튼 — 사용자 설명은 여기 TOPICS에서 관리
  pass-manager.js
  texture-input.js
  studio.js
  codemirror.js       # CodeMirror 6 (MIT, 미리 번들링 · tools/codemirror에서 재생성) — 손으로 고치지 않는다
  cm-editor.js        # GLSL 코드 편집기: CodeMirror 화면 + studio용 #studioCode 창구 · 팔레트 · 툴바
  cm-glsl-features.js # 시그니처 도움말 · 숫자 조절 · 색 견본 · 정의로 이동 · 이름 바꾸기 · 들여쓰기 안내선 · 줄 끝 오류
  glsl-language.js    # GLSL 언어 정보(키워드·타입·앱 Uniform·심볼 표·자동 완성 후보)
  glsl-highlight.js   # 가이드 코드 예시의 GLSL 강조
  ui.js
  input.js
  settings.js
  shader.js
  package.json        # Node.js 검증을 위한 ESM 지정
  (loader.js 제거됨)
tools/build.mjs       # npm run build: esbuild로 묶어 한 파일짜리 배포본 생성
tools/inline-html.mjs # index.html에 CSS·JS를 넣는 순수 함수(빌드와 검사가 같이 씀)
tools/codemirror/     # js/codemirror.js 생성 도구 (이 파일을 다시 만들 때만 필요)
tools/update_sha_manifest.py # 실행 소스 SHA-256 목록 갱신
tests/run.mjs         # npm test: 모든 테스트 실행기
deploy/index.html     # 한 파일짜리 오프라인 배포본 (npm run build가 생성, file://로 실행)
```

## 검증

모든 테스트는 `tests/run.mjs` 하나로 돌립니다. 앱 자체는 여전히 의존성이 없고, `package.json`·`requirements-test.txt`는 빌드·테스트 도구만 정의합니다.

```shell
npm install                                   # playwright (browser 묶음용)
npx playwright install chromium
python -m pip install -r requirements-test.txt # py 묶음용
python -m playwright install chromium

npm test              # 세 묶음 모두
npm run test:node     # node 묶음만 — 설치 없이 Node만 있으면 됨
npm run test:list     # 어떤 파일이 어느 묶음인지
node tests/run.mjs browser --grep=undo   # 묶음·파일 이름으로 골라 실행
```

| 묶음 | 대상 | 방식 |
|---|---|---|
| `node` | `tests/*.js` 중 `require()`를 쓰는 파일 | 모의 DOM/GPU. `tests/esm-vm-bridge.cjs`로 ESM 소스를 읽는다 |
| `browser` | 나머지 `tests/*.js`(개발자 콘솔용) + `tests/gpu-validation.html` | 실행기가 임시 정적 서버를 띄우고 Playwright Chromium(SwiftShader WebGL2)에서 실제 앱에 붙여 넣듯 실행. 테스트마다 빈 저장소의 새 컨텍스트 |
| `py` | `tests/*-regression.py` | Python Playwright. 실행기가 `PYTHONUTF8=1`을 넣어 Windows에서도 UTF-8로 읽는다 |

- 콘솔용 테스트는 던진 오류뿐 아니라 실행 중 `console.error`나 잡히지 않은 오류가 한 번이라도 나와도 FAIL입니다. 그러니 `.catch(console.error)`로 실패를 삼키지 말고, 일부러 남기는 경고는 `console.warn`을 씁니다.
- 준비되지 않은 묶음(playwright·Python 없음)은 SKIP으로 표시하고 계속합니다. `--strict`(=`npm run test:ci`)는 SKIP도 실패로 칩니다.
- GitHub Actions(`.github/workflows/test.yml`)는 push·PR마다 `lint` → `test (node)` · `test (browser)` · `test (py)` 세 작업을 나란히 돌리고(각각 `node tests/run.mjs <묶음> --strict`), 모두 통과하면 `build`가 배포본을 올립니다. 의존성은 `package-lock.json` 기준으로 `npm ci`로 설치하고, npm·pip·Playwright Chromium은 캐시합니다.
- 개발 도구를 추가·변경할 때는 `npm install -D <패키지>@<버전>`으로 `package-lock.json`도 함께 갱신해 커밋합니다.
- 새 테스트는 `tests/`에 두기만 하면 위 규칙으로 자동 분류됩니다. 다른 파일이 불러 쓰는 도우미는 `tests/run.mjs`의 `HELPERS`에 추가합니다.
- `index.html`·`style.css`·`js/*.js`를 고친 뒤에는 `npm run sha`(= `python tools/update_sha_manifest.py`)로 `SOURCE_SHA256_Runtime.txt`를 갱신합니다(해시는 줄바꿈을 LF로 맞춰 계산하므로 Windows·Linux 결과가 같습니다). CI의 lint 작업이 `npm run sha:check`로 갱신 누락을 바로 알려 줍니다.
- 커밋 전에 `npm run lint`(경고도 실패), `npm run format:check`를 돌립니다. 포맷은 `npm run format`으로 맞춥니다.
- 콘솔용 테스트는 예전처럼 개발자 콘솔에 붙여 넣어 돌릴 수도 있고, `tests/gpu-validation.html`도 브라우저에서 직접 열어 실제 GPU로 검사할 수 있습니다.

**검증 한계:** 자동화 테스트 환경은 페이지 네비게이션 및 WebGL2가 제한되어 개발용 ES Module의 실제 HTTP 구동, `file://`로 연 배포본의 실제 GPU 렌더링은 대상 브라우저에서 직접 최종 확인해야 합니다.

원본 2026-10-15 AMD 개발 기록은 `README_2026-10-15_AMD_기록.md`에 보존했습니다.
