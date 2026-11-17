// 앱 메뉴 바(index.html #menuBar): 파일 · 편집 · 보기 · 재생 · 도움말.
// 항목은 이미 있는 버튼을 누른다(app-menus.js의 우클릭 메뉴와 같은 방식) — 동작 · 꺼짐 · 켜짐 상태 · 단축키가
// 툴바 · 프로젝트 메뉴 · 편집기 버튼과 늘 같다. 메뉴를 열 때마다 그 순간의 버튼 상태로 항목을 만든다.
//  · 누르면 열림 · 하나가 열린 동안 옆 메뉴에 마우스를 올리면 그 메뉴로 · ←→ 옆 메뉴 · ↑↓ 항목 · Esc 닫기(UI.menu)
//  · F10: 숨긴 메뉴 바를 다시 보이고 초점(Alt는 브라우저 메뉴와 부딪혀 쓰지 않는다) · 메뉴 바에서 ←→ 이동 · ↓/Enter 열기
//  · document에 'menubar-open'(detail: 메뉴 이름) 이벤트를 보내면 그 메뉴를 연다(프로젝트 메뉴의 '파일 메뉴로')
//  · 보기 > 메뉴 바: 끄면 숨기고 툴바의 ⋯ 더보기가 다시 나타난다(⋯ 안의 '메뉴 바 보이기'로 되돌림). 이 브라우저에 기억한다.
//  · 좁은 화면(600px 이하): 메뉴 이름 대신 '메뉴' 버튼 하나(data-menu="all") — 다섯 메뉴를 묶음 제목과 함께 한 목록으로
//  · 파일 메뉴에 최근 프로젝트(보관함의 최근 5개) — 열 때마다 보관함을 다시 읽는다
//  · 명령 팔레트(F1)에 모든 항목을 '파일 › 저장'처럼 등록한다(studio.registerCommands, 같은 버튼을 누르는 명령은 하나만)
//   mount({ studio, guide, signal }) → { open(name), close, dispose }
import * as UI from "./ui-kit.js";
import * as Store from "./storage.js";
import * as PreviewDOM from "./preview-dom.js";
import * as MenuCommands from "./menu-commands.js";

const HIDDEN_KEY = "field.menubar-hidden.v1";

const TITLES = { file: "파일", edit: "편집", view: "보기", play: "재생", help: "도움말" };
const RECENT = 5;

const mount = ({ studio, guide, signal: parentSignal } = {}) => {
  const $ = PreviewDOM.createLookup(),
    bar = $("menuBar");
  if (!bar || parentSignal?.aborted) return { open() {}, dispose() {} };
  const controller = new AbortController(),
    signal = controller.signal;
  parentSignal?.addEventListener("abort", () => controller.abort(), { once: true, signal });
  const on = (target, type, fn, options = {}) => target?.addEventListener(type, fn, { ...options, signal });
  const buttons = [...bar.querySelectorAll(".ui-menubar-item")];

  // 기존 버튼을 누르는 항목. 버튼이 없거나 숨겨져 있으면(지금 쓸 수 없는 동작) 빼고, 꺼져 있으면 흐리게.
  //   command: 팔레트에 쓸 바뀌지 않는 이름(켜고 끄는 버튼은 메뉴에서는 지금 상태 이름 — '일시정지' — 을 쓴다)
  let collecting = false; // 팔레트 목록을 모을 때는 지금 숨은 버튼도 넣는다(누를 때 다시 본다)
  const press = (id, options = {}) => MenuCommands.item($, id, { ...options, collecting });
  // 편집 명령은 편집기 안에서 일한다: 닫혀 있으면 먼저 연다
  const openEditor = () => {
    if ($("studioToggle")?.getAttribute("aria-expanded") !== "true") $("studioToggle")?.click();
  };
  // 패널 탭은 패널이 숨겨져 있으면 먼저 보인다
  const showPanel = () => {
    if (document.body.classList.contains("panel-hidden")) $("panelToggle")?.click();
  };
  const separator = { separator: true };
  const title = text => ({ title: text });
  const tab = (id, label) =>
    press(id, {
      label,
      pressed: node =>
        node.getAttribute("aria-selected") === "true" && !document.body.classList.contains("panel-hidden"),
      before: showPanel,
    });

  const MENUS = {
    file: () => [
      press("studioReset"),
      press("projectMenuToggle"),
      ...recentItems(),
      separator,
      press("studioProjectSave", { keepHidden: true }),
      press("studioProjectSaveAs"),
      separator,
      press("studioImportPack", { keepHidden: true }),
      press("studioExportPack", { keepHidden: true }),
      press("studioExportHTML", { keepHidden: true }),
      separator,
      title("코드만(JSON)"),
      press("studioExport", { label: "코드만 내보내기", keepHidden: true }),
      press("studioImport", { label: "코드 JSON 열기…", keepHidden: true }),
      separator,
      press("studioTextureAdd", { keepHidden: true }),
      press("versionOpen", { keepHidden: true }),
    ],
    edit: () => [
      press("studioUndo", { keepHidden: true }),
      press("studioRedo", { keepHidden: true }),
      separator,
      press("studioFind", { label: "찾기", kbd: "Ctrl+F", before: openEditor, keepHidden: true }),
      press("studioReplace", { label: "찾아 바꾸기", kbd: "Ctrl+H", before: openEditor, keepHidden: true }),
      press("studioTidy", { label: "코드 정리", kbd: "Shift+Alt+F", before: openEditor, keepHidden: true }),
      separator,
      press("studioPaletteOpen", { label: "명령 팔레트…", kbd: "F1", before: openEditor, keepHidden: true }),
    ],
    view: () => [
      press("panelToggle"),
      press("studioToggle"),
      press("timelineToggle", { keepHidden: true }),
      press("hudToggle", { keepHidden: true }),
      separator,
      title("설정 패널"),
      tab("tab-uniforms", "파라미터"),
      tab("tab-render", "렌더링"),
      tab("tab-profile", "성능"),
      tab("tab-input", "작업공간"),
      separator,
      title("편집기 배치"),
      press("studioLayout", { before: openEditor, keepHidden: true }),
      press("studioMaximize", { before: openEditor, keepHidden: true }),
      press("studioSplitEdit", {
        before: openEditor,
        keepHidden: true,
      }),
      separator,
      press("fullscreenToggle"),
      press("previewPopout", { keepHidden: true }),
      press("themeToggle", { keepHidden: true }),
      separator,
      { label: "메뉴 바", kbd: "F10", pressed: true, onSelect: () => setHidden(true, { focus: true }) },
    ],
    play: () => [
      press("previewPause"),
      press("stepFrame", { keepHidden: true }),
      press("studioResetFrames", { keepHidden: true }),
      separator,
      press("screenshotButton", { keepHidden: true }),
      press("screenshot2x", { label: "2배 해상도로 저장", keepHidden: true }),
      press("screenshot4k", { label: "4K로 저장", keepHidden: true }),
      separator,
      press("recordButton", { keepHidden: true }),
      press("videoRenderOpen", { keepHidden: true }),
    ],
    help: () => [
      press("helpToggle", { keepHidden: true }),
      guide && { label: "단축키 목록", onSelect: () => guide.open("shortcuts") },
      press("guideTour", { label: "둘러보기 (화면 안내 투어)", keepHidden: true }),
      separator,
      press("galleryToggle", { keepHidden: true }),
      $("galleryLessons") && {
        label: "기법 배우기 (레슨)",
        // 갤러리를 열고 레슨 묶음으로 내린다
        onSelect: () => {
          if (!$("gallery")?.open) $("galleryToggle")?.click();
          requestAnimationFrame(() => $("galleryLessons")?.scrollIntoView?.({ block: "start" }));
        },
      },
    ],
  };
  // 좁은 화면의 '메뉴' 하나: 다섯 메뉴를 묶음 제목과 함께
  MENUS.all = () =>
    Object.keys(TITLES).flatMap((name, index) => [
      ...(index ? [separator] : []),
      title(TITLES[name]),
      ...MENUS[name]().filter(item => !(item?.title && !item.label)), // 메뉴 안의 작은 제목은 빼고 메뉴 이름을 제목으로
    ]);

  // 최근 프로젝트: 보관함 목록(최근 저장 순)을 메뉴를 열기 전에 읽어 둔다. 지금 작업 중인 프로젝트에는 체크.
  let recent = [];
  const loadRecent = async () => {
    try {
      const [items, current] = await Promise.all([
        studio?.projects?.list?.() ?? [],
        Promise.resolve(studio?.projects?.current?.()),
      ]);
      recent = items.slice(0, RECENT).map(item => ({ ...item, current: current?.id === item.id }));
    } catch (_) {
      recent = [];
    }
  };
  const recentItems = () =>
    recent.length
      ? [
          separator,
          title("최근 프로젝트"),
          ...recent.map(item => ({
            label: item.name,
            title: `${item.name} 열기`,
            pressed: item.current || undefined,
            onSelect: () => studio.projects.open(item.id),
          })),
        ]
      : [];

  let current = null, // { name, menu }
    ticket = 0; // 늦게 끝난 '최근 프로젝트' 읽기가 그 사이 연 다른 메뉴를 덮지 않게
  const close = ({ focus = false } = {}) => {
    const open = current;
    current = null;
    open?.menu.close({ focus });
  };
  const open = async (name, { focusFirst = true } = {}) => {
    const anchor = buttons.find(button => button.dataset.menu === name);
    if (!anchor || !MENUS[name]) return;
    if (current?.name === name) return;
    const mine = ++ticket;
    if (name === "file" || name === "all") await loadRecent();
    if (mine !== ticket) return;
    close();
    const items = MENUS[name]()
      .filter(Boolean)
      // 앞뒤 · 겹친 구분선과 바로 뒤에 항목이 없는 제목은 뺀다(빠진 항목 때문에 생긴 빈 묶음)
      .filter((item, index, list) => {
        if (!item.separator && !(item.title && !item.label)) return true;
        const next = list[index + 1];
        if (!next || next.separator) return false;
        return !(item.separator && index === 0);
      });
    const menu = UI.menu({
      anchor,
      items,
      label: anchor.textContent.trim(),
      focusFirst,
      onClose: () => {
        if (current?.menu === menu) current = null;
      },
      onSideKey: step => {
        const visible = buttons.filter(button => button.offsetParent !== null),
          at = visible.indexOf(anchor);
        if (visible.length > 1) open(visible[(at + step + visible.length) % visible.length].dataset.menu);
      },
    });
    current = { name, menu };
  };
  for (const button of buttons) {
    on(button, "click", () =>
      current?.name === button.dataset.menu ? close({ focus: true }) : open(button.dataset.menu)
    );
    // 하나가 열린 동안에는 옆 메뉴에 올리기만 해도 그 메뉴로(데스크톱 메뉴 바 관례)
    on(button, "pointerenter", () => {
      if (current && current.name !== button.dataset.menu) open(button.dataset.menu, { focusFirst: false });
    });
    on(button, "keydown", event => {
      const visible = buttons.filter(item => item.offsetParent !== null),
        at = visible.indexOf(button),
        step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (step) {
        event.preventDefault();
        visible[(at + step + visible.length) % visible.length].focus();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        open(button.dataset.menu);
      } else if (event.key === "Escape") button.blur();
    });
  }
  // 메뉴 바 안에서는 한 버튼만 Tab으로 들어온다(나머지는 ←→)
  buttons.forEach((button, index) => (button.tabIndex = index ? -1 : 0));
  on(bar, "focusin", event => {
    if (!buttons.includes(event.target)) return;
    for (const button of buttons) button.tabIndex = button === event.target ? 0 : -1;
  });
  const focusBar = event => {
    if (event.key !== "F10" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (document.body.classList.contains("menubar-hidden")) setHidden(false);
    close();
    if (event.currentTarget !== document) window.focus();
    const visible = buttons.filter(button => button.offsetParent !== null);
    (visible.find(button => button.tabIndex === 0) || visible[0])?.focus();
  };
  on(document, "keydown", focusBar);
  on(document, "preview-popout-window", event => on(event.detail.document, "keydown", focusBar));

  // 보이기 · 숨기기(이 브라우저에 기억). 숨기면 툴바의 ⋯ 더보기가 대신 나타난다(CSS).
  const setHidden = (hidden, { focus = false } = {}) => {
    close();
    document.body.classList.toggle("menubar-hidden", hidden);
    Store.write(HIDDEN_KEY, hidden ? "1" : "0");
    const show = $("menuBarShow");
    if (show) show.hidden = !hidden;
    document.dispatchEvent(new Event("menubar-visibility-changed"));
    window.dispatchEvent(new Event("resize")); // 뷰포트 크기가 바뀌었다
    if (focus) {
      if (hidden) $("moreToggle")?.focus();
      else {
        const visible = buttons.filter(button => button.offsetParent !== null);
        (visible.find(button => button.tabIndex === 0) || visible[0])?.focus();
      }
    }
  };
  setHidden(Store.read(HIDDEN_KEY) === "1");
  on($("menuBarShow"), "click", () => setHidden(false, { focus: true }));
  // 다른 화면이 메뉴를 열어 달라고 할 때(프로젝트 메뉴의 '파일 메뉴로' 항목): detail = 메뉴 이름
  on(document, "menubar-open", event => {
    if (document.body.classList.contains("menubar-hidden")) return;
    open(event.detail);
  });

  // 명령 팔레트: 모든 항목을 '메뉴 › 항목'으로. 누를 때 버튼 상태를 다시 보고, 같은 버튼을 누르는 기존 명령이 있으면
  // 팔레트가 하나만 둔다(registerCommands가 id로 거른다). 탭 · 최근 프로젝트 · 메뉴 바 켜고 끄기는 넣지 않는다.
  collecting = true;
  const commands = Object.keys(TITLES).flatMap(name =>
    MENUS[name]()
      .filter(item => item && !item.separator && item.label && item.onSelect && !/^tab-/.test(item.button || ""))
      .filter(item => item.label !== "메뉴 바")
      .map(item => ({
        id: item.button,
        label: `${TITLES[name]} › ${item.command || item.label}`,
        key: item.kbd || "",
        run: () => {
          const node = item.button ? $(item.button) : null;
          if (node && (node.disabled || node.hidden)) return;
          item.onSelect();
        },
      }))
  );
  collecting = false;
  studio?.registerCommands?.(commands);

  signal.addEventListener("abort", () => close(), { once: true });
  return { open, close, commands: () => commands, dispose: () => controller.abort() };
};

export { mount };
