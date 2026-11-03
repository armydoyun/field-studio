# FIELD Studio — ES Modules (2026-10-18)

WebGL2 / GLSL ES 3.00 기반 Shader Art Studio. 개발 소스는 **표준 JavaScript ES Modules**, 외부 의존성·npm·CDN 없음. 2026-10-15 `a(1).zip` 실행 소스에서 로더 계층만 교체했으며 기능 구현 로직을 보존했습니다.

## 개발용 실행 (`index.html`)

개발 소스 10개는 `import` / `export`로 연결되며 `js/loader.js`와 AMD `define()`은 제거되었습니다.

**주의:** Chrome/Edge에서 ES Module의 `file://` 상대 import는 CORS 정책으로 차단될 수 있습니다. 인터넷은 필요 없지만, 로컬 HTTP 서버로 열어야 합니다.

Python이 설치되어 있다면 프로젝트 루트에서:

```shell
python -m http.server 8000
```

Windows Python Launcher라면 `py -m http.server 8000`도 됩니다. 브라우저에서 `http://127.0.0.1:8000/`으로 접속합니다. 이 서버는 로컬 컴퓨터에서만 작업할 때 `python -m http.server 8000 --bind 127.0.0.1`처럼 localhost 바인딩을 권장합니다.

## 오프라인 배포 (`deploy/index.html`)

`deploy/`에는 `index.html`, `style.css`, `js/min.js` 세 파일만 있습니다. `deploy/index.html`은 `file://`에서 일반 `<script>` 하나로 실행됩니다. **배포 대상에서는 Python, npm, 서버가 필요하지 않습니다.**

ESM 소스를 고친 다음에는 개발 컴퓨터에서 아래 명령으로 번들을 다시 생성합니다. Python 표준 라이브러리만 사용합니다.

```shell
python tools/build_deploy.py
```

이 번들러는 프로젝트의 현재 정적 ES Module 구문에 한정됩니다. 지원하지 않는 import/export 구문에서는 조용히 손실된 번들을 만들지 않고 오류를 냅니다. JS 문법 수준의 정교한 압축·트리셰이킹 도구는 아니며, 변수명 단축까지 원한다면 esbuild 같은 전문 번들러를 별도 이용할 수 있습니다. `min.js`는 기존 배포본과 이름을 맞추기 위한 것이고 완전한 미니파이 결과는 아닙니다.

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
tools/build_deploy.py # 순수 Python 배포 번들 생성기
tools/codemirror/     # js/codemirror.js 생성 도구 (npm은 이 파일을 다시 만들 때만 필요)
tools/update_sha_manifest.py # 실행 소스 SHA-256 목록 갱신
deploy/index.html      # file:// 오프라인 실행 가능
deploy/style.css
deploy/js/min.js
```

## 검증

- `node tests/runtime-integrity.js` — ESM 의존성, 순환 참조, DOM ID, SHA-256, 배포 산출물 구조.
- 기존 Node 기반 회귀 테스트는 `tests/esm-vm-bridge.cjs`를 통해 ESM 소스를 모의 DOM/GPU에서 테스트합니다. 이 호환 변환기는 테스트 전용입니다.
- `tests/gpu-validation.html`은 로컬 HTTP 서버에서 열어서 실제 Chrome/Edge의 WebGL2 검증을 실행합니다.
- 브라우저 에디터 테스트 스크립트도 테스트 전용 ESM 변환 도우미를 사용합니다.

**검증 한계:** 자동화 테스트 환경은 페이지 네비게이션 및 WebGL2가 제한되어 개발용 ES Module의 실제 HTTP 구동, `file://`로 연 배포본의 실제 GPU 렌더링은 대상 브라우저에서 직접 최종 확인해야 합니다.

원본 2026-10-15 AMD 개발 기록은 `README_2026-10-15_AMD_기록.md`에 보존했습니다.
