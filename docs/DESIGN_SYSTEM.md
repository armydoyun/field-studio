# FIELD Studio 디자인 시스템

화면을 고치거나 새 기능을 붙일 때 이 문서부터 본다. 원칙은 하나다.

> **모양은 컴포넌트가 정하고, 기능은 자리만 정한다.**
> 버튼 · 칸 · 세그먼트 · 메뉴 · 대화상자의 색 · 테두리 · 높이 · 글자는 `css/components/`에 한 번만 정의되어 있다.
> 기능 CSS(`css/features/`, `css/layout/`)에는 배치(격자 · 여백 · 폭)와 그 기능에만 있는 그림(타임라인 키, 방향 패드 등)만 둔다.

눈으로 확인하는 카탈로그: `docs/design-system.html` (로컬 서버를 띄우고 `http://127.0.0.1:8000/docs/design-system.html`).

## 1. 파일 구조

```text
css/
  tokens.css            색 · 크기 · 간격 · 글자 · 층(z-index) 토큰. 다크/라이트
  base.css              초기화 · 문서 기본 · 초점. 요소 선택자는 :where()라 우선순위 0
  icons.css             glyph-icon + icon-* (SVG 마스크)
  components/           ← 디자인 시스템 본체. 클래스는 모두 ui- 로 시작한다
    button.css          ui-btn · ui-icon-btn · ui-link · ui-btn-group · ui-toolbar · ui-sep
    field.css           input · select · ui-number · ui-dense · ui-field · ui-label · ui-hint · ui-error · ui-input-group · ui-search
    choice.css          checkbox · radio · ui-check · ui-switch · range · ui-range-ends · ui-meter · progress
    segmented.css       ui-seg · ui-tabs
    tag.css             ui-tag · ui-chip · ui-dot · ui-count · kbd
    menu.css            ui-popover · ui-menu · ui-menu-item …
    dialog.css          ui-dialog · ui-dialog-head · -body · -foot …
    notice.css          ui-notice · ui-empty
    surface.css         ui-card · ui-section · ui-disclosure · ui-resizer · ui-hud · ui-stack · ui-readout
  layout/               화면의 큰 틀: workspace(격자) · panel(설정 패널) · stage(뷰포트 · HUD) · dock(자리 옮기기)
  features/             기능별: parameters · presets · links · timeline · project-menu · channels · editor ·
                        editor-codemirror · video-dialog · gallery · guide · profiler · popout
js/ui-kit.js            컴포넌트를 JS로 만드는 함수(UI.button · UI.segmented · UI.menu …)
js/studio-dialog.js     묻기 · 확인 대화상자(ask · confirm)
```

- **순서가 우선순위다.** `index.html`의 `<link>` 순서(토큰 → 기본 → 아이콘 → 컴포넌트 → 배치 → 기능)가 단일 출처이고,
  빌드 · 해시 목록 · 테스트는 `tools/css-files.cjs`로 같은 순서를 읽는다. 새 CSS 파일은 `index.html`에 링크를 추가하면 끝이다
  (링크하지 않은 파일이 있으면 `tests/runtime-integrity.js`가 실패한다).
- CSS는 한 줄에 규칙 하나(`선택자 { 속성:값;속성:값; }`)로 쓴다. 같은 맥락에서 같은 선택자에 같은 속성을 두 번 쓰면
  `tests/ui-geometry-regression.js`가 실패한다 — 한 속성은 한곳에서만 정한다.

## 2. 토큰 (`css/tokens.css`)

값을 직접 쓰지 말고 토큰을 쓴다.

| 종류 | 토큰 | 쓰임 |
|---|---|---|
| 면 | `--bg` `--panel` `--surface` `--surface-hover` `--elevated` `--sunken` `--stage-bg` `--hud-bg` | 바탕 → 패널 → 카드 → 떠 있는 면. `--sunken`은 입력 칸 · 트랙 |
| 선 | `--line` `--line-strong` `--line-hover` | 구역 구분 / 조작 테두리 / 포인터 올림 |
| 글자 | `--text` `--text-soft` `--muted` `--faint` | 제목 / 본문 · 버튼 / 설명 / 보조 |
| 액센트 | `--accent` `--accent-strong` `--accent-fill` `--accent-ink` `--accent-soft` `--accent-line` | 선 · 글자 · 채운 버튼 바탕 · 그 위 글자 · 옅은 면 · 옅은 선 |
| 뜻 | `--success` `--warning` `--danger` + `-line` `-soft` `-surface` | 상태 색과 그 옅은 선 · 면 |
| 조작 높이 | `--control-xs` 24 · `--control-sm` 28 · `--control-md` 32 · `--control-lg` 36 | 줄 안 아이콘 / 촘촘한 도구 / 기본 / 대화상자 · 큰 버튼 |
| 모서리 | `--radius-xs` 3 · `--radius-sm` 5 · `--radius` 6 · `--radius-pill` | 견본 / 조작 / 면 / 알약 |
| 간격 | `--space-1`(2px) … `--space-12`(24px) | 2px 격자 |
| 글자 크기 | `--text-2xs` 10 · `-xs` 11 · `-sm` 12 · `-md` 13 · `-lg` 14 · `-xl` 16 · `-2xl` 20 | 꼬리표 / 설명 / 조작 / 본문 / 제목들 |
| 글꼴 | `--sans` `--mono` | 화면 글자 / 코드 · 숫자 |
| 층 | `--z-hud` `--z-resizer` `--z-panel` `--z-toast` `--z-cover` `--z-tooltip` `--z-popover` `--z-tour` `--z-drag` | z-index는 이 이름으로 |

디자인 계약(테스트 `tests/ui-matte-regression.js`가 지킨다): 장식용 그라데이션 · 글자 번짐 · 블러 없음. 그림자는 `--shadow` 하나(떠 있는 면).
아이콘은 글자 기호가 아니라 SVG 마스크. 라이트 테마는 다크 테마의 모든 색 토큰을 정의한다.

## 3. 컴포넌트 빠른 표

| 필요한 것 | 클래스 | 비고 |
|---|---|---|
| 버튼 | `<button>` (= `ui-btn`) | 변형 `ui-btn--primary · --ghost · --tonal · --danger · --danger-solid · --dashed`, 크기 `--xs · --sm · --lg`, 폭 `--block` |
| 아이콘 버튼 | `ui-icon-btn glyph-icon icon-이름` | 크기 `ui-icon-btn--xs · --sm · --lg`. `aria-label` 필수 |
| 켜고 끄는 버튼 | 위 + `aria-pressed="true"` | 켜지면 옅은 액센트 면. `ui-btn` 또는 `ui-icon-btn` 클래스가 있어야 한다 |
| 붙은 버튼 묶음 | `ui-btn-group` > button | ◀ ◆ ▶, − + |
| 도구 막대 | `ui-toolbar` (+ `ui-sep`) | |
| 글자 링크 | `ui-link` | |
| 하나 고르기 | `ui-seg` > button | 고른 칸: `aria-pressed/checked/selected="true"` 또는 `.is-active/.is-selected`. 크기 `ui-seg--sm · --lg` |
| 화면 탭 | `ui-tabs` > button · `ui-tabs--line`(문서 탭) | |
| 글자 · 숫자 칸 | `<input>` | 크기 `ui-input--sm · --lg`. 숫자 전용 `ui-number` |
| 선택 상자 | `<select>` | 같은 크기 클래스 |
| 촘촘한 영역 | 감싸는 요소에 `ui-dense` | 안의 칸 28px · 숫자 고정폭 |
| 라벨 + 칸 + 설명 | `ui-field` > `ui-label`(+`ui-label-hint`) + 칸 + `ui-hint` / `ui-error` | |
| 칸 + 단위 | `ui-input-group` > input + `ui-unit` | |
| 검색 칸 | `ui-search` > `ui-search-icon` + input (+ kbd) | |
| 체크 · 라디오 | `ui-check` > input + 글자 | |
| 스위치 | `ui-switch` > input[type=checkbox] + span | |
| 슬라이더 | `<input type="range">` (+ `ui-range-ends`) | 브라우저 기본 그리기 + 액센트 색 |
| 읽기 전용 막대 | `ui-meter` > `ui-meter-fill`(width) | `ui-meter--lg · --success` |
| 꼬리표 | `ui-tag` | `--plain · --pill · --dot · --accent · --success · --warning · --danger` |
| 누르는 칩 | `ui-chip` | 켜짐 `aria-pressed` · `.is-active` · 안의 체크박스. `--pill · --lg` |
| 상태 점 · 개수 | `ui-dot`(`--success …`) · `ui-count` | |
| 메뉴 | `ui-popover ui-menu` > `ui-menu-item` | `ui-menu-title · -sep · -row · -note`. 위험 항목 `.is-danger`, 토글 항목 `aria-pressed` |
| 떠 있는 면 | `ui-popover` | 자리(position)는 쓰는 쪽에서 |
| 대화상자 | `<dialog class="ui-dialog">` | 폭 `--md · --lg · --xl · --2xl`, 세로 구성 `--column`. 뼈대 `ui-dialog-head / -body / -foot` |
| 알림 | `ui-notice` | `--accent · --success · --warning · --danger`, 띠 `--bar` |
| 빈 상태 | `ui-empty` | |
| 카드 | `ui-card` (+ `--pad`) | |
| 패널 구역 | `ui-section` > `ui-section-head` > h2 | |
| 접이식 | `<details class="ui-disclosure">` | |
| 크기 조절 막대 | `ui-resizer` + `aria-orientation` | |
| 화면 위 면 | `ui-hud` | |

각 파일 머리 주석에 그 컴포넌트의 변형이 모두 적혀 있다.

## 4. JS로 만들기 (`js/ui-kit.js`)

```js
import * as UI from "./ui-kit.js";

UI.button({ label: "저장", variant: "primary", size: "sm", onClick });
UI.iconButton({ icon: "close", label: "닫기", size: "xs", onClick });
UI.segmented({ label: "방식", options: [{ value: "once", label: "한 번" }, { value: "loop", label: "반복" }], value: "once", onChange });
UI.select({ options: [["0", "즉시"], ["1", "1초"]], value: "1", size: "sm", onChange });
UI.numberInput({ value: 0.5, min: 0, max: 1, step: 0.01, size: "sm", onChange });
UI.checkbox({ label: "자동", checked: true, onChange });
UI.field({ label: "이름", control: input, hint: "설명" });
UI.tag("↻ 4초", { tone: "accent" });
UI.notice("저장했습니다.", { tone: "success" });
UI.menu({ anchor: button, items: [{ label: "이름 바꾸기…", onSelect }, { separator: true }, { label: "삭제", danger: true, onSelect }] });

UI.el("div", "my-feature-row", "글자");                 // 요소 하나 만들기
UI.buttonClass({ variant: "ghost", size: "sm" });       // 클래스 글자만 필요할 때
UI.iconButtonClass("reset", "xs", "my-hook");
```

묻기 · 확인은 `js/studio-dialog.js`가 맡는다(`studio.js`가 `ask` · `confirm`으로 쓴다). 브라우저 기본 `prompt()` · `confirm()`은 쓰지 않는다.

## 5. 새 기능을 붙일 때

1. **마크업**: 컴포넌트 클래스로 만든다. 기능 이름 클래스(예: `my-feature-row`)는 배치와 JS · 테스트의 손잡이로만 덧붙인다.
   ```html
   <div class="ui-card my-feature">
     <div class="ui-seg" role="group" aria-label="방식"><button type="button" aria-pressed="true">A</button><button type="button">B</button></div>
     <button type="button" class="ui-btn--primary ui-btn--sm">적용</button>
   </div>
   ```
2. **CSS**: `css/features/내-기능.css`를 만들고 `index.html`에 링크한다. 여기에는 `display · grid · gap · margin · width`처럼 자리 잡는 속성만 쓴다.
   버튼의 `background · border · min-height · font`를 다시 쓰고 싶어지면 멈추고, 맞는 변형 클래스가 있는지 본다.
3. **맞는 변형이 없으면** 기능 CSS에 예외를 쌓지 말고 `css/components/`에 변형을 추가하고, 이 문서의 표와 `docs/design-system.html`에 한 줄 넣는다.
4. **확인**: `npm run sha`(해시 목록) → `npm test`. 화면은 `docs/design-system.html`과 실제 앱에서 다크 · 라이트 둘 다 본다.

### 하지 말 것

- 색 · 크기 값을 직접 쓰기(`#2a66d9`, `min-height:30px`) → 토큰.
- `.my-feature button { … }`처럼 영역 안의 모든 버튼을 한꺼번에 다시 칠하기 → 버튼마다 변형 클래스.
- 같은 모양을 새 이름으로 다시 정의하기(`.my-segmented`) → `ui-seg`.
- id 선택자로 모양 정하기(`#myButton { background… }`) → 클래스. id는 상태 · 자리 예외에만.

### 예외 구역

- `css/features/editor-codemirror.css`: CodeMirror가 자기 스타일을 스크립트로 넣어서, 찾기 창의 칸 · 버튼은 우선순위를 올린 전용 규칙으로 같은 토큰에 맞춘다.
- 그림에 가까운 조작(타임라인 키 · 반복 손잡이, 램프 손잡이, 방향 패드, 갤러리 카드, 채널 칩)은 기능 파일에 고유 모양을 둔다. 그래도 색 · 크기는 토큰을 쓴다.
