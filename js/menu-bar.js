// 앱 메뉴 바(index.html #menuBar): 파일 · 편집 · 보기 · 재생 · 도움말.
// 항목은 이미 있는 버튼을 누른다(app-menus.js의 우클릭 메뉴와 같은 방식) — 동작 · 꺼짐 · 켜짐 상태 · 단축키가
// 툴바 · 프로젝트 메뉴 · 편집기 버튼과 늘 같다. 메뉴를 열 때마다 그 순간의 버튼 상태로 항목을 만든다.
//  · 누르면 열림 · 하나가 열린 동안 옆 메뉴에 마우스를 올리면 그 메뉴로 · ←→ 옆 메뉴 · ↑↓ 항목 · Esc 닫기(UI.menu)
//  · F10: 메뉴 바로 초점(Alt는 브라우저 메뉴와 부딪혀 쓰지 않는다) · 메뉴 바에서 ←→ 이동 · ↓/Enter 열기
//  · 보기 > 메뉴 바: 끄면 숨기고 툴바의 ⋯ 더보기가 다시 나타난다(⋯ 안의 '메뉴 바 보이기'로 되돌림). 이 브라우저에 기억한다.
//   mount({ signal }) → { open(name), dispose }
import * as UI from "./ui-kit.js";
import * as Store from "./storage.js";

const HIDDEN_KEY = "field.menubar-hidden.v1";

const mount = ({ signal } = {}) => {
  const $ = id => document.getElementById(id),
    bar = $("menuBar");
  if (!bar) return { open() {}, dispose() {} };
  const on = (target, type, fn, options = {}) => target?.addEventListener(type, fn, { ...options, signal });
  const buttons = [...bar.querySelectorAll(".ui-menubar-item")];

  // 기존 버튼을 누르는 항목. 버튼이 없거나 숨겨져 있으면(지금 쓸 수 없는 동작) 빼고, 꺼져 있으면 흐리게.
  const press = (id, { label, kbd, pressed, before, keepHidden = false } = {}) => {
    const node = $(id);
    if (!node || (node.hidden && !keepHidden)) return null;
    return {
      label: label || node.getAttribute("aria-label") || node.textContent.trim(),
      kbd,
      pressed: pressed === undefined ? undefined : pressed(node),
      disabled: !!node.disabled,
      onSelect: () => {
        before?.();
        node.click();
      },
    };
  };
  const isOn = node => node.getAttribute("aria-pressed") === "true" || node.getAttribute("aria-expanded") === "true";
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
      press("studioReset", { label: "새 프로젝트 (기본 장면)" }),
      press("projectMenuToggle", { label: "프로젝트 열기…", kbd: "Ctrl+O" }),
      separator,
      press("studioProjectSave", { label: "저장", kbd: "Ctrl+S", keepHidden: true }),
      press("studioProjectSaveAs", { label: "다른 이름으로 저장…", kbd: "Ctrl+Shift+S" }),
      separator,
      press("studioImportPack", { label: "프로젝트 파일 열기…", keepHidden: true }),
      press("studioExportPack", { label: "프로젝트 파일로 내보내기", keepHidden: true }),
      press("studioExportHTML", { label: "HTML로 내보내기 (재생 전용)", keepHidden: true }),
      separator,
      title("코드만(JSON)"),
      press("studioExport", { label: "코드만 내보내기", keepHidden: true }),
      press("studioImport", { label: "코드 JSON 열기…", keepHidden: true }),
      separator,
      press("studioTextureAdd", { label: "이미지 파일 불러오기…", keepHidden: true }),
      press("versionOpen", { label: "버전 기록…", keepHidden: true }),
    ],
    edit: () => [
      press("studioUndo", { label: "되돌리기 (코드 · 버퍼)", kbd: "Ctrl+Z", keepHidden: true }),
      press("studioRedo", { label: "다시 실행", kbd: "Ctrl+Y", keepHidden: true }),
      separator,
      press("studioFind", { label: "찾기", kbd: "Ctrl+F", before: openEditor, keepHidden: true }),
      press("studioReplace", { label: "찾아 바꾸기", kbd: "Ctrl+H", before: openEditor, keepHidden: true }),
      press("studioTidy", { label: "코드 정리", kbd: "Shift+Alt+F", before: openEditor, keepHidden: true }),
      separator,
      press("studioPaletteOpen", { label: "명령 팔레트…", kbd: "F1", before: openEditor, keepHidden: true }),
    ],
    view: () => [
      press("panelToggle", {
        label: "설정 패널",
        kbd: "H",
        pressed: node => node.getAttribute("aria-pressed") === "true",
      }),
      press("studioToggle", { label: "셰이더 편집기", kbd: "E", pressed: isOn }),
      press("timelineToggle", { label: "타임라인", kbd: "T", pressed: isOn, keepHidden: true }),
      press("hudToggle", {
        label: "HUD (뷰포트 위 정보)",
        kbd: "G",
        pressed: () => !$("stage")?.classList.contains("hud-hidden"),
        keepHidden: true,
      }),
      separator,
      title("설정 패널"),
      tab("tab-uniforms", "파라미터"),
      tab("tab-render", "렌더링"),
      tab("tab-profile", "성능"),
      tab("tab-input", "작업공간"),
      separator,
      press("fullscreenToggle", { label: "전체화면", kbd: "F" }),
      press("previewPopout", { label: "미리보기를 별도 창으로", keepHidden: true }),
      press("themeToggle", { keepHidden: true }),
      separator,
      { label: "메뉴 바", pressed: true, onSelect: () => setHidden(true) },
    ],
    play: () => [
      press("previewPause", { kbd: "Space" }),
      press("stepFrame", { label: "한 프레임 진행", kbd: ".", keepHidden: true }),
      separator,
      press("screenshotButton", { label: "스크린샷 저장 (PNG)", keepHidden: true }),
      press("screenshot2x", { label: "2배 해상도로 저장", keepHidden: true }),
      press("screenshot4k", { label: "4K로 저장", keepHidden: true }),
      separator,
      press("recordButton", { keepHidden: true }),
      press("videoRenderOpen", { label: "영상 렌더링…", keepHidden: true }),
    ],
    help: () => [
      press("helpToggle", { label: "가이드 · 단축키", kbd: "?", keepHidden: true }),
      press("galleryToggle", { label: "예제 갤러리", kbd: "X", keepHidden: true }),
    ],
  };

  let current = null; // { name, menu }
  const close = ({ focus = false } = {}) => {
    const open = current;
    current = null;
    open?.menu.close({ focus });
  };
  const open = (name, { focusFirst = true } = {}) => {
    const anchor = buttons.find(button => button.dataset.menu === name);
    if (!anchor || !MENUS[name]) return;
    if (current?.name === name) return;
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
        const at = buttons.indexOf(anchor);
        open(buttons[(at + step + buttons.length) % buttons.length].dataset.menu);
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
      const at = buttons.indexOf(button),
        step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (step) {
        event.preventDefault();
        buttons[(at + step + buttons.length) % buttons.length].focus();
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
  on(document, "keydown", event => {
    if (event.key !== "F10" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (document.body.classList.contains("menubar-hidden")) return;
    event.preventDefault();
    close();
    (buttons.find(button => button.tabIndex === 0) || buttons[0])?.focus();
  });

  // 보이기 · 숨기기(이 브라우저에 기억). 숨기면 툴바의 ⋯ 더보기가 대신 나타난다(CSS).
  const setHidden = hidden => {
    close();
    document.body.classList.toggle("menubar-hidden", hidden);
    Store.write(HIDDEN_KEY, hidden ? "1" : "0");
    const show = $("menuBarShow");
    if (show) show.hidden = !hidden;
    window.dispatchEvent(new Event("resize")); // 뷰포트 크기가 바뀌었다
  };
  setHidden(Store.read(HIDDEN_KEY) === "1");
  on($("menuBarShow"), "click", () => setHidden(false));

  return { open, close, dispose: () => close() };
};

export { mount };
