# FIELD Studio — 작업 안내

WebGL2 셰이더 스튜디오. 의존성 없는 ES Modules(`js/*.js`) + 여러 CSS 파일(`css/`) + `index.html`. 구조 전체는 `README.md`.

## 화면(UI)을 고칠 때 — 먼저 읽기

- 규칙과 컴포넌트 표: **`docs/DESIGN_SYSTEM.md`** (필요한 파일만 열면 된다. CSS 전체를 읽지 않는다)
- 모양은 `css/components/*.css`의 `ui-*` 컴포넌트가 정한다. 기능 CSS(`css/features/`, `css/layout/`)에는 배치만 쓴다.
- 버튼 · 칸 · 세그먼트 · 메뉴 · 대화상자를 새로 만들 때는 기존 `ui-*` 클래스와 `js/ui-kit.js`(`UI.button` · `UI.segmented` · `UI.menu` …)를 쓴다.
  묻기 · 확인은 `js/studio-dialog.js`. 새 모양이 필요하면 기능 CSS에 예외를 쌓지 말고 컴포넌트에 변형을 추가한다.
- 색 · 크기 · 간격 · z-index는 `css/tokens.css`의 토큰으로만 쓴다.
- 어느 파일을 고칠지: 버튼 모양 → `css/components/button.css`, 파라미터 줄 배치 → `css/features/parameters.css`,
  타임라인 → `css/features/timeline.css` … (파일 머리 주석에 담당 범위가 있다)
- CSS는 한 줄에 규칙 하나. 같은 선택자 · 같은 속성을 두 번 정의하지 않는다(테스트가 막는다).
- 새 CSS 파일은 `index.html`에 `<link>`로 추가한다(이 순서가 빌드 · 테스트의 단일 출처).

## 고친 뒤

```bash
npm run sha            # index.html · css/ · js/ 를 고쳤으면 해시 목록 갱신(안 하면 테스트 실패)
npm run lint && npm run format:check
npm run test:node      # 빠른 정적 · 모의 검사
npm test               # 전체(브라우저 포함). 이 환경에서는 CHROMIUM_PATH=/opt/pw-browsers/chromium 을 붙인다
```

- `js/`를 고치면 `npm run format`. `js/codemirror.js`는 생성물이라 손대지 않는다.
- 테스트가 클래스 이름 · CSS 조각을 문자열로 확인하는 곳이 있다. 이름을 바꾸면 `tests/`에서 같이 찾는다.
- 커밋 메시지는 한국어, 무엇을 왜 바꿨는지 사용자 관점으로.
