# FIELD Studio 디자인 시스템

화면을 고치거나 새 기능을 붙일 때 이 문서부터 본다. 원칙은 하나다.

> **모양은 컴포넌트가 정하고, 기능은 자리만 정한다.**
> 버튼 · 칸 · 세그먼트 · 메뉴 · 대화상자의 색 · 테두리 · 높이 · 글자는 `css/components/`에 한 번만 정의되어 있다.
> 기능 CSS(`css/features/`, `css/layout/`)에는 배치(격자 · 여백 · 폭)와 그 기능에만 있는 그림(타임라인 키, 방향 패드 등)만 둔다.

눈으로 확인하는 카탈로그: `docs/design-system.html` (로컬 서버를 띄우고 `http://127.0.0.1:8000/docs/design-system.html`).

## 필수 원칙: 이모지·이모티콘 금지, 아이콘은 SVG만 사용

**이 프로젝트에는 이모지와 이모티콘을 절대로 사용하지 않는다.** 운영체제·글꼴에 따라 모양이 달라지는 문자 그림, 장식용 유니코드 기호, 텍스트 얼굴도 아이콘으로 사용할 수 없다. 이 규칙은 화면, 버튼, 상태 표시, 툴팁, 안내 문구, 가이드, 갤러리 카드, 예제 코드 주석, 디자인 카탈로그와 내보낸 결과에 모두 적용한다.

- 모양을 전달해야 하면 **인라인 SVG 또는 `css/icons.css`의 공통 SVG 마스크**를 사용한다. 기존에 같은 뜻의 아이콘이 있으면 재사용하며, 없으면 같은 체계의 SVG를 추가한다.
- 공통 격자는 `viewBox="0 0 24 24"`, 기본 획은 1.8, 선 끝과 모서리는 둥글게 한다. 단색 SVG는 `currentColor`로, 마스크는 부모의 글자색으로 다크·라이트 테마와 상태색을 따른다.
- 아이콘만 있는 조작에는 `aria-label`과 동작을 설명하는 `title`을 준다. 글자와 함께 있는 장식 SVG에는 `aria-hidden="true"`, `focusable="false"`를 준다. 그림만으로 상태를 전달하지 않는다.
- SVG를 넣을 수 없는 브라우저 탭 제목과 일반 텍스트·코드 주석에는 상태·동작의 **이름을 글자로** 쓴다. 예: `[저장 안 됨]`, `[실행 대기]`, `[컴파일 오류]`, 잠금, 무작위, 재생.
- 수학 기호, 코드 연산자, 단위, 키 이름은 의미 있는 텍스트로 유지한다. 아이콘을 대신하는 문자 그림과 구분한다.
- 새 화면과 문구를 추가할 때 `node tests/no-emoji-regression.js`로 위반을 검사한다. 실제 화면에서는 SVG 마스크 표시, 접근 가능한 이름, 상태 전환, 좁은 패널과 두 테마를 확인한다.

파라미터의 간단한 조작(삭제·방향 맞추기·중앙/원점·앞뒤 전환·직선/S자 곡선·뒤집기·확대)은 `UI.iconButton`과 공통 SVG 마스크를 사용한다. 방향·램프 도구는 28px(`sm`)로 맞추고 삭제는 `ui-icon-btn--danger`를 쓴다. 축 이름·각도·목표 좌표는 접근성 이름과 짧은 툴팁에 남긴다. 앞뒤 전환·범위 뒤집기의 눌림 상태, 삭제 불가 상태도 유지한다. 숫자·행렬 셀·bool·enum처럼 **값을 읽거나 선택하는 텍스트**와 적용/취소 같은 결정 버튼은 내용에 맞게 글자를 유지한다.

- 방향: `right` / `left` / `up` / `down`, +Z는 `toward`(원 안의 점), -Z는 `away`(원 안의 교차선).
- 보조 조작: `hemisphere`, `center`(범위 중앙), `origin`(좌표 원점), `curve-linear`, `curve-smooth`, `flip-horizontal`(그라데이션 좌우), `swap`(곡선 상하·범위 교환), `trash`, `expand`.

## 1. 파일 구조

```text
css/
  tokens.css            색 · 크기 · 간격 · 글자 · 층(z-index) 토큰. 다크/라이트
  base.css              초기화 · 문서 기본 · 초점. 요소 선택자는 :where()라 우선순위 0
  icons.css             glyph-icon + icon-* (SVG 마스크)
  components/           ← 디자인 시스템 본체. 클래스는 모두 ui- 로 시작한다
    button.css          ui-btn · ui-icon-btn · ui-link · ui-btn-group · ui-toolbar · ui-sep
    field.css           input · select · ui-number · ui-dense · ui-field · ui-label · ui-hint · ui-error · ui-input-group · ui-search
    value-editor.css    ui-value-editor: 스칼라·벡터 전체 값 편집 창
    matrix.css          ui-matrix: 고정 N×N 요약 · 전체 값 입력 · 확대 편집
    select.css          ui-select · ui-select-menu · ui-select-option (단일 선택)
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
| 아이콘 버튼 | `ui-icon-btn glyph-icon icon-이름` | 크기 `ui-icon-btn--xs · --sm · --lg` · 삭제류 `--danger`. `aria-label` 필수 · `title`에 하는 일 |
| 켜고 끄는 버튼 | 위 + `aria-pressed="true"` | 켜지면 옅은 액센트 면. `ui-btn` 또는 `ui-icon-btn` 클래스가 있어야 한다 |
| 글자냐 아이콘이냐 | | 도구 막대의 뜻이 하나뿐인 짧은 행동(지우기 · 복제 · 확대/축소 · 맞춤 · 자석)은 아이콘만. 메뉴 항목 · 대화상자 버튼 · 설명이 필요한 행동(되돌리기 알림, 초기화)은 글자로 |
| 붙은 버튼 묶음 | `ui-btn-group` > button | 이전 키·키 설정·다음 키, − + |
| 도구 막대 | `ui-toolbar` (+ `ui-sep`) | |
| 글자 링크 | `ui-link` | |
| 하나 고르기 | `ui-seg` > button | 고른 칸: `aria-pressed/checked/selected="true"` 또는 `.is-active/.is-selected`. 크기 `ui-seg--sm · --lg` |
| 화면 탭 | `ui-tabs` > button · `ui-tabs--line`(문서 탭) | |
| 글자 · 숫자 칸 | `<input>` | 크기 `ui-input--sm · --lg`. 숫자 전용 `ui-number` |
| 선택 상자 | `<select>` → `ui-select` | `js/custom-select.js`가 자동 보강. `ui-input--sm · --lg`, `ui-dense` 공유 |
| 행렬 | `ui-matrix` | `js/matrix-control.js`의 create(). N×N 고정, 선택 셀 전체 값·확대 편집 |
| 촘촘한 영역 | 감싸는 요소에 `ui-dense` | 안의 칸 28px · 숫자 고정폭 |
| 라벨 + 칸 + 설명 | `ui-field` > `ui-label`(+`ui-label-hint`) + 칸 + `ui-hint` / `ui-error` | 구역 첫 설명은 `ui-hint--lead`, 버튼 옆 한 줄 설명은 `ui-hint--inline`(위 여백 없음 → 가운데 정렬 유지) |
| 성분 + 칸 | `ui-input-group ui-input-group--prefix` > `ui-unit` + input | X/Y/Z/W 라벨을 왼쪽에 붙임 |
| 값 편집 | `ui-value-editor` · `ui-value-fields` | `js/value-editor.js`의 create(). 스칼라·벡터 초안 편집 |
| 칸 + 단위 | `ui-input-group` > input + `ui-unit` | |
| 검색 칸 | `ui-search` > `ui-search-icon` + input (+ `ui-search-clear`) (+ kbd) | 지우기는 `ui-icon-btn--xs glyph-icon icon-close ui-search-clear` 버튼. 글자가 있을 때만 보이고 `UI.bindSearchClear`가 처리(브라우저 기본 ×는 감춤) |
| 체크 · 라디오 | `ui-check` > input + 글자 | |
| 스위치 | `ui-switch` > input[type=checkbox] + span | `ui-switch--field`: 입력칸 면·높이·테두리를 공유하는 상태 필드 |
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
| 패널 구역 | `ui-section` > `ui-section-head` > h2 | 첫 구역은 위 선 없음. 앞 요소와 한 덩어리면 `ui-section--flush` |
| 접이식 | `<details class="ui-disclosure">` | |
| 크기 조절 막대 | `ui-resizer` + `aria-orientation` | |
| 화면 위 면 | `ui-hud` | |

각 파일 머리 주석에 그 컴포넌트의 변형이 모두 적혀 있다.

## 4. 간격 규칙

사소한 붙음(선이 조작에 닿음, 초점 링이 잘림)을 눈으로 찾지 않도록 규칙으로 정하고, `tests/spacing-browser-regression.js`가 실제 화면에서 잰다.
새 화면을 만들면 그 테스트에 상태(탭 · 메뉴 · 대화상자 열기)를 한 줄 추가한다.

| 규칙 | 값 | 이유 · 예 |
|---|---|---|
| 조작과 구역 경계선 사이 | **8px 이상**(패널에서는 12px) | 설정 패널 탭 아래 선, 검색 칸 아래 선, 대화상자 머리 · 바닥 선 |
| 조작과 그 밖의 선 사이(도구 막대 · 목록 · 상자) | **4px 이상** | 편집기 머리줄(44px 안의 32px 버튼), 타임라인 '선택한 키' 상자 |
| 조작과 잘리는 가장자리 사이(`overflow`) | **3px 이상** | 초점 링(2px + 간격 2px)이 잘리지 않게. 넘치는 도구 줄은 `padding:4px;margin:-4px` |
| 트랙 · 메뉴 안의 칸 | 초점 링을 **안쪽**(`outline-offset:-2px`) | `ui-seg` · `ui-tabs` · `ui-menu-item`: 링이 트랙 테두리를 덮지 않는다 |
| 글자와 테두리 사이 | **4px 이상** | 카드 · 알림 · 꼬리표 밖의 글자 |
| 나란한 조작 사이 | 도구 아이콘 2px · 버튼 6~8px · 붙이려면 `ui-btn-group` | 0~1px로 어정쩡하게 붙이지 않는다 |
| 같은 줄의 같은 종류 사이 | **같은 간격** | 뷰포트 머리줄의 칩들(프로젝트 · 저장 · 상태)은 모두 8px |
| 선은 한 번만 | 맞닿은 두 영역 중 한쪽만 선을 그린다 | 탭 아래 선은 스크롤 영역이, 그래서 첫 구역(`ui-section`)은 위 선을 그리지 않는다 |
| 한 덩어리는 선으로 끊지 않는다 | 검색 칸 + 그 목록, 라벨 + 칸 | 선은 "다른 주제"를 나눌 때만 |
| 세로 리듬(패널) | 구역 안쪽 18px · 제목 → 내용 16px · 묶음(`ui-field`) 사이 20px · 라벨 → 칸 8px · 칸 → 설명 8px | 컴포넌트가 이미 이렇게 정해 둔다. 기능 CSS에서 다른 값으로 덮지 않는다 |

검사가 일부러 보지 않는 것: 그림에 가까운 조작(타임라인 본문 · 램프 손잡이 · 갤러리 카드), 줄 전체가 버튼인 것(`@group` 머리), 메뉴 항목(메뉴 안쪽 여백 4px이 규칙), 스크롤로 지나가는 사이, 다른 층(팝오버 · 대화상자)과의 겹침.

## 5. JS로 만들기 (`js/ui-kit.js`)

```js
import * as UI from "./ui-kit.js";

UI.button({ label: "저장", variant: "primary", size: "sm", onClick });
UI.iconButton({ icon: "close", label: "닫기", size: "xs", onClick });
UI.segmented({ label: "방식", options: [{ value: "once", label: "한 번" }, { value: "loop", label: "반복" }], value: "once", onChange });
UI.select({ options: [["0", "즉시"], ["1", "1초"]], value: "1", size: "sm", onChange });
UI.numberInput({ value: 0.5, min: 0, max: 1, step: 0.01, size: "sm", onChange });
UI.checkbox({ label: "자동", checked: true, onChange });
UI.field({ label: "이름", control: input, hint: "설명" });
UI.tag("반복 4초", { tone: "accent" });
UI.notice("저장했습니다.", { tone: "success" });
UI.menu({ anchor: button, items: [{ label: "이름 바꾸기…", onSelect }, { separator: true }, { label: "삭제", danger: true, onSelect }] });
// 편집 대화상자 뼈대(머리 · 본문 · 취소/적용): 본문을 채우고 show(적용 버튼)로 연다. Esc · 닫기 · 취소는 모두 onCancel
const frame = UI.editDialog({ label: "uGain 값 편집", title: "값 편집", description: "uGain · float", onCancel: () => close() });
frame.body.append(fields); frame.show(applyButton);
// position:fixed 팝오버 메뉴의 바깥 누르기 · 창 크기 · 분리 창 처리
UI.dismissPopover({ menu, toggle, owner, isOpen, close, place, on });

UI.el("div", "my-feature-row", "글자");                 // 요소 하나 만들기
UI.buttonClass({ variant: "ghost", size: "sm" });       // 클래스 글자만 필요할 때
UI.iconButtonClass("reset", "xs", "my-hook");
```

묻기 · 확인은 `js/studio-dialog.js`가 맡는다(`studio.js`가 `ask` · `confirm`으로 쓴다). 브라우저 기본 `prompt()` · `confirm()`은 쓰지 않는다.

## 6. 새 기능을 붙일 때

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
4. **확인**: `npm run sha`(해시 목록) → `npm test`. 간격은 `tests/spacing-browser-regression.js`에 새 화면 상태를 추가해 재게 한다. 화면은 `docs/design-system.html`과 실제 앱에서 다크 · 라이트 둘 다 본다.

### 하지 말 것

- 색 · 크기 값을 직접 쓰기(`#2a66d9`, `min-height:30px`) → 토큰.
- `.my-feature button { … }`처럼 영역 안의 모든 버튼을 한꺼번에 다시 칠하기 → 버튼마다 변형 클래스.
- 같은 모양을 새 이름으로 다시 정의하기(`.my-segmented`) → `ui-seg`.
- id 선택자로 모양 정하기(`#myButton { background… }`) → 클래스. id는 상태 · 자리 예외에만.

### 예외 구역

- `css/features/editor-codemirror.css`: CodeMirror가 자기 스타일을 스크립트로 넣어서, 찾기 창의 칸 · 버튼은 우선순위를 올린 전용 규칙으로 같은 토큰에 맞춘다.
- 그림에 가까운 조작(타임라인 키 · 반복 손잡이, 램프 손잡이, 방향 패드, 갤러리 카드, 채널 칩)은 기능 파일에 고유 모양을 둔다. 그래도 색 · 크기는 토큰을 쓴다.

## 공통 드롭다운

`js/custom-select.js`의 `mount()`를 문서당 한 번 연결하면 기존 `<select>`와 나중에 추가하는 단일 선택 상자가
같은 템플릿을 쓴다. 앱은 `js/main.js`, 견본은 `docs/design-system.html`에서 연결한다.
복수 선택/목록형(`multiple`, `size > 1`)은 보강하지 않는다.

- 트리거는 `ui-input`과 원래 크기 클래스를 공유한다. 목록은 `ui-popover`의 색·테두리·그림자·층 토큰을 쓴다.
- 선택 항목은 파란 옅은 면과 체크, 탐색 중인 항목은 중성 면과 안쪽 선으로 구분한다.
- 방향키·Home/End로 탐색, Enter/Space로 확정, Escape로 취소, Tab·바깥 클릭으로 닫는다. 글자 입력으로 항목을 찾는다.
- 원래 select의 값·폼 제출·input/change 이벤트를 유지한다. 숨김·비활성·옵션 변경과 프로그램의 value/selectedIndex 대입도 반영한다.
- 목록은 소유 문서/열린 dialog 안에 놓고 화면 경계에 따라 위/아래로 연다. 패널 스크롤·리사이즈·대화상자 닫기에는 목록을 닫는다.

적용 위치: 렌더링 최대 픽셀 수, 프리셋 전환 시간, 파라미터 추가/enum/연결, 버퍼 설정,
텍스처 샘플링, 편집기 들여쓰기, 타임라인 선택, 영상 내보내기. 기능별 CSS에는 폭·배치만 정의한다.

## 행렬 입력 (`css/components/matrix.css`)

`js/matrix-control.js`가 mat2/3/4와 행렬 배열 원소의 공통 편집기를 만든다.
`create({name, size, read, onChange})`는 `node`, `refresh()`, `dispose()`를 돌려준다.

- 화면은 행→열 순서, 데이터 인덱스는 GLSL 그대로 `column * size + row`. 머리글/선택 위치는 1부터, GLSL 좌표 힌트는 0부터 표시한다.
- 패널이 좁아져도 차원은 고정이다. 셀은 실제 폭/글꼴에 맞는 요약만 표시하며 `≈`는 근삿값이다. 입력칸과 title/접근성 이름에는 원래 Number 전체를 넣는다.
- 아래 입력칸은 기존 `ui-number`/`ui-field`를 사용한다. 긴 소수·지수 표기를 단일 줄에서 편집한다. 표시·포커스·셀 이동만으로 원본 값을 다시 저장하지 않는다.
- 방향키는 행렬의 공간 방향으로 이동, Enter/Space/클릭은 선택 셀의 전체 값 입력으로 진입한다. Enter/변경 확정으로 적용, Escape는 미확정 텍스트를 복원한다. 입력칸의 Tab/Shift+Tab은 화면 순서대로 다음/이전 셀로 이동하며 양 끝에서는 다음 조작으로 나간다.
- 확대 편집은 기존 `ui-dialog--md`/머리/본문/바닥/버튼 컴포넌트를 조합한다. 초안은 적용 전까지 렌더러와 분리한다. 취소/닫기/Escape는 초안을 버린다.
- 새 프로젝트/목록 재생성/폐기 시 열린 편집창과 ResizeObserver를 정리한다.

## 파라미터 숫자 편집과 추가 초안

- `ui-select`의 화살표는 일반 입력 칸의 오른쪽 여백(기본 10px, 작은/촘촘한 칸 8px)을 공유한다. native select의 배경 화살표용 26/24px 여백을 중복 적용하지 않는다.
- 파라미터 숫자 칸의 짧은 표시는 표시 전용이다. 포커스하면 기존 Number 전체를 편집하고 변경 없는 focus/blur/change는 모델에 쓰지 않는다. Enter는 확정, Escape는 최신 원래 값을 복원한다. 입력 중인 텍스트는 재생 갱신으로 덮어쓰지 않는다.
- 일반 숫자/벡터는 편집 직전에 live 값을 읽고, 벡터의 다른 성분은 현재 모델에서 유지한다. 작은 step의 입력 폭은 `1e-8` 같은 지수 표기의 소수 자릿수도 계산한다.
- 파라미터 추가 폼은 타입마다 초기값·표시 방식·범위·선택지 이름 초안을 메모리에 보관한다. 타입을 돌아오면 해당 초안을 복원하며, 처음 고른 타입에는 기본값을 쓴다. GLSL 이름은 타입 변경과 관계없이 유지한다.

## 스칼라·벡터 값 편집 (`css/components/value-editor.css`)

`js/value-editor.js`의 `create({name, type, options, read, onChange, onApplied, getContext})`는 열기 버튼과 `refresh()`·`dispose()`를 만든다. float/int/uint/bool 및 vec/ivec/uvec/bvec2/3/4, 배열 원소가 같은 편집기를 쓴다.

- 패널은 빠른 숫자·슬라이더 조작을 유지한다. 범위 없는 벡터는 `ui-input-group--prefix`로 축 라벨과 입력칸을 묶고, bool은 `ui-switch--field`의 켜짐/꺼짐·true/false 텍스트, bvec은 체크 상태가 보이는 `ui-chip--lg`를 쓴다.
- 행 머리의 확대 아이콘(값 편집)으로 공통 대화상자를 연다. 각 성분은 한 줄 전체 폭과 원래 Number 값을 쓰며 긴 값은 입력칸 안에서 가로 이동한다. 취소·닫기·Escape는 모델을 수정하지 않는다. 숫자 칸에서 Escape는 먼저 그 칸의 초안을 복원한다.
- 벡터 일괄 입력은 쉼표·공백·줄바꿈 또는 해당 GLSL 생성자를 받는다. 성분 개수·유한성·타입을 모두 검증한 뒤 초안에 한꺼번에 채우고, 적용에서만 저장한다. 정수는 32비트 범위, uint는 음수·소수 금지, bool은 true/false/1/0이다.
- 변경 없는 적용은 저장하지 않는다. 편집 중 외부에서 갱신된 성분 중 손대지 않은 값은 최신 모델에서 유지한다. 색은 RGBA, 각도는 라디안, 방향은 0 벡터 검증과 정규화, enum은 선택지 의미를 유지한다.
- 목록 재생성·프로젝트 변경·폐기 시 열린 창을 정리한다. 기존 `ui-dialog`의 초점·스크롤·테마·버튼을 공유한다.

## 파라미터 어노테이션 갱신

- 파라미터 설명·그룹·기본값은 렌더러에 적용된 Image → Common → Buffer 소스에서 읽는다. 초기 복원 중 편집기 전역 객체가 준비되기 전에도 같은 소스를 사용하며, 미적용 초안은 패널에 섞지 않는다.
- 컴파일 성공 후 어노테이션 메타데이터가 달라지면 `shader-annotations-changed`로 목록을 갱신한다. `@group`만 추가·변경·삭제한 경우도 반영하고 검색어·그룹 접힘 상태·현재 값은 유지한다. 어노테이션이 같은 일반 코드 편집에서는 입력 DOM을 다시 만들지 않는다.
- 블록 주석 안의 선언은 등록하지 않는다. 유효하지 않은 기본값·범위·배열 크기는 항목별 오류로 처리해 정상 파라미터 등록을 막지 않는다. 처음 등록할 때도 범위 보정을 적용하고, 그라데이션의 기본값 비교·리셋은 렌더러와 같은 색 정규화를 사용한다.

## 파라미터 변경 표시와 A/B 비교

- 변경 상태는 적용된 코드의 타입별 기본값과 비교한다. `ui-tag--accent`의 변경됨·기본값 없음 텍스트를 사용하며 색만으로 구분하지 않는다. 배열·행렬·램프도 비교하고, 작은 HDR 값은 절대 오차로 0과 같다고 취급하지 않는다.
- 변경 꼬리표가 꺼졌을 때도 자리를 유지해 재생·연결 값이 바뀔 때 행 높이나 조작 위치가 움직이지 않게 한다. 비교를 시작하기 전에는 기준 잡기 버튼만 표시해 첫 파라미터를 아래로 밀지 않는다.
- 변경 필터는 `aria-pressed` 버튼과 `ui-count`로 표시한다. 검색·조건 숨김·그룹과 함께 작동하며, 개수는 조건으로 숨겨진 변경도 포함한다. 결과가 없으면 필터를 해제하거나 검색할 수 있도록 안내한다.
- A는 메모리에만 있는 기준, B는 현재 편집 값이다. 비교 선택은 공통 `ui-seg`를 사용한다. A 미리보기 중에는 뷰포트와 비교 카드에 상태·저장 대상을 명시하고, 파라미터 편집과 프리셋 조작은 `inert`로 막는다.
- A/B 전환은 GPU 입력만 바꾸고 자동 저장·프리셋·코드 반영·프로젝트 이력에는 쓰지 않는다. A를 쓰려면 별도 적용 버튼을 사용하며 한 번의 Undo로 되돌린다. 비교 종료는 B를 유지한다.
- 기준 갱신은 B에서만 가능하다. 전체 무작위·조금씩 바꾸기는 기준이 없을 때 변경 직전 값을 기억한다. 연결된 값·시간·버퍼 이력은 제외하며 코드·파라미터 설정·연결·프로젝트 변경과 Undo는 비교를 끝낸다.

## 프리셋 호환성과 적용 내역

- 새 프리셋은 이름·값에 더해 타입, enum 선택지, 램프 종류를 저장한다. 기존 값 전용 프리셋은 현재 타입·성분 수·허용 범위로 검증하며 원래 타입·선택지는 확인할 수 없다고 안내한다. 읽을 때 값 배열과 메타데이터를 복사하며, 이름 변경·보관함·Pack·Undo에서도 정보를 유지한다.
- 적용 전 항목별로 검사한다. 타입·선택지·램프 종류 불일치, 누락, 범위 위반, 잘못된 값, 연결된 항목은 현재 값을 유지한다. 호환되는 값만 전환하며 잠금은 무작위 변경에만 영향을 준다.
- 적용 결과는 공통 `ui-disclosure`로 기본 접힘 상태를 사용한다. 요약에는 적용·건너뜀 개수와 이전 형식을 표시하고, 펼친 목록에는 적용한 값과 건너뛴 이유를 글자로 표시한다. 긴 목록은 높이를 제한해 스크롤하고 좁은 패널에서는 이름과 값을 줄바꿈한다.
- 즉시·부드러운 적용·중단을 한 번의 Undo로 복원한다. 프리셋이 적용한 항목만 복원하고 다른 값 변경은 유지하며, 바뀐 값이 없으면 이력을 만들지 않는다. Undo·코드 적용·프로젝트 변경 시 진행 중인 전환을 중단해 나중에 값을 덮어쓰지 않게 한다. A 기준이 없으면 적용 직전 값을 기억한다.

## 사용법 안내와 둘러보기

- 버튼·탭·패널에는 동작 이름과 현재 상태를 표시한다. 툴팁은 동작·단축키 또는 값의 단위·형식을 짧게 설명한다. 단계별 사용법이나 여러 문장의 기능 소개를 상시 설명·툴팁에 넣지 않는다.
- 학습 안내는 `?` 도움말의 주제별 문서와 `UI 둘러보기`에 모은다. 관련 위치에는 공통 SVG 도움말 버튼이나 짧은 사용법 링크를 둔다. 새 기능은 해당 문서와 작업별 둘러보기도 함께 갱신한다.
- 입력 형식·제약, 현재 상태, 오류·복구 방법, 사용자가 작성한 어노테이션 설명은 조작에 필요하므로 유지한다. 실제 오류를 도움말 링크만으로 대체하지 않는다.
- 둘러보기는 화면의 조작 위치를 강조하고 한 단계에 한 가지 목적을 설명한다. 프로젝트·파라미터·연결·프리셋을 변경하지 않으며, 종료·Escape에서 원래 패널·편집기·스크롤·초점을 복원한다. 다른 모달 작업 중에는 시작하지 않는다.
- 키보드로 이전·다음·종료할 수 있어야 하며 배경 조작과 전역 단축키를 차단한다. 단계 변경을 보조 기술에 알리고, 설명 카드와 조작 버튼은 좁거나 낮은 화면에서도 접근 가능해야 한다.
- 가이드 목차는 공통 `ui-disclosure`로 범주·하위 범주를 접는다. 문서 데이터와 재귀 범주 구조를 분리하며 문서 하나를 여러 위치에 중복 배치하지 않는다. 사용자의 접힘 상태는 보관하고, 검색 결과의 임시 펼침은 이를 덮어쓰지 않는다. 문서로 직접 이동하면 상위 범주를 열어 현재 위치를 표시한다.
- 좁은 화면에서는 목차 버튼으로 목록을 열고 문서를 선택하면 본문으로 돌아간다. Escape는 열린 목차를 먼저 닫으며, 목차 자체가 긴 가로 탭이나 본문을 밀어내는 영역이 되지 않게 한다.
