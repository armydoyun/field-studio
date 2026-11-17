// 프로젝트 메뉴: 뷰포트 머리줄의 프로젝트 이름 버튼으로 여는 팝오버.
// 편집기를 열지 않아도 보관함 저장·열기, Pack·소스 JSON, 새 프로젝트, 이미지를 다룬다(버튼 동작은 studio.js · studio-projects.js가 단다).
// 바깥을 누르거나 Esc를 누르면 닫힌다. 이름 입력 대화상자(<dialog>) 안을 누르는 것은 바깥으로 치지 않는다.
// 미리보기 영역은 overflow:hidden이라, 그 안에서 absolute로 띄우면 편집기 쪽으로 나가는 부분이 잘린다.
// 그래서 메뉴는 position:fixed로 창 기준에 두고, 열 때·창 크기가 바뀔 때 버튼 바로 아래에 맞춘다(편집기 위로 올라온다).
import * as UI from "./ui-kit.js";

const create = ({ $, on }) => {
  const toggle = $("projectMenuToggle"),
    menu = $("projectMenu");
  menu.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  const isOpen = () => !menu.hidden;
  const owner = () => menu.ownerDocument || document;
  const GAP = 6,
    MARGIN = 12;
  // 메뉴의 원래 자리(머리줄의 버튼 옆). 미리보기 분리 창이 열려 있으면 머리줄은 분리 창에 있는데, 메인 창에서 Ctrl+O를 누르면
  // 메뉴만 메인 창으로 잠시 옮겨 그 창 왼쪽 위에 띄우고, 닫을 때 원래 자리로 되돌린다.
  const home = menu.parentNode;
  const away = () => menu.ownerDocument !== toggle.ownerDocument;
  const place = () => {
    const rect = away() ? null : toggle.getBoundingClientRect?.();
    if (!menu.style || (!rect && !away())) return;
    const view = owner().defaultView || window,
      width = Math.min(340, view.innerWidth - MARGIN * 2),
      left = rect ? Math.max(MARGIN, Math.min(rect.left, view.innerWidth - MARGIN - width)) : MARGIN,
      top = rect ? rect.bottom + GAP : MARGIN;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.max(0, view.innerHeight - top - MARGIN)}px`;
  };
  const firstAction = () => menu.querySelector?.("button:not([disabled]):not([hidden])");
  const open = ({ focus = true } = {}) => {
    const host = globalThis.shaderPopout?.activeDocument?.();
    if (host && host !== menu.ownerDocument && host.body) {
      host.body.append(menu);
      bind();
    }
    menu.hidden = false;
    place();
    toggle.setAttribute("aria-expanded", "true");
    if (focus) firstAction()?.focus?.();
  };
  const close = ({ refocus = false } = {}) => {
    if (menu.hidden) return;
    const wasAway = away();
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (home && menu.parentNode !== home) home.append(menu);
    if (refocus && !wasAway) toggle.focus?.();
  };
  on(toggle, "click", () => (isOpen() ? close() : open()));
  // 이름 입력 대화상자(<dialog>) 안을 누르는 것은 바깥으로 치지 않는다
  const bind = UI.dismissPopover({
    menu,
    toggle,
    owner,
    isOpen,
    close,
    place,
    on,
    ignore: target => !!target?.closest?.("dialog"),
  });
  on(menu, "keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close({ refocus: true });
  });
  // 머리줄: [이름 ▾] | [저장]. 저장 버튼은 늘 같은 자리에 있고 상태만 바뀐다(자리가 생겼다 사라지며 이름이 밀리지 않게).
  //   saved: 보관함의 항목과 이어져 있는지 · modified: 저장한 뒤(이름 없는 작업은 시작한 뒤) 바뀌었는지
  //   · 바뀐 내용이 있으면 저장 아이콘에 점 · 저장한 프로젝트가 그대로면 '저장됨'으로 꺼 둔다
  let saved = false,
    modified = false;
  const syncSave = () => {
    const button = $("projectMenuState");
    if (!button) return;
    button.dataset.modified = String(modified);
    button.disabled = saved && !modified;
    const label = saved && !modified ? "저장됨" : saved ? "변경 내용 저장" : "프로젝트로 저장";
    button.setAttribute("aria-label", label);
    button.title = saved && !modified ? "저장됨 · 바뀐 내용이 없습니다" : `${label} (Ctrl+S)`;
  };
  // 보관함에 없는 작업은 '새 작업'으로 부른다
  const setLabel = (text, isSaved) => {
    $("projectMenuLabel").textContent = isSaved ? text : "새 작업";
    toggle.dataset.saved = String(isSaved);
    saved = !!isSaved;
    syncSave();
  };
  const setModified = next => {
    if (toggle.dataset.modified === String(next)) return;
    toggle.dataset.modified = String(next);
    modified = !!next;
    syncSave();
    toggle.setAttribute("aria-description", next ? "저장 안 된 변경 있음 · Ctrl+S로 저장" : "");
  };
  syncSave();
  return { open, close, isOpen, setLabel, setModified };
};

export { create };
