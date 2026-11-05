// 뷰포트 툴바의 드롭다운 메뉴(캡처 ▾ · ⋯ 더보기). 버튼을 누르면 버튼 아래에 열린다.
// 툴바에는 자주 쓰는 버튼만 두고, 나머지 버튼은 id를 그대로 둔 채 메뉴 항목으로 옮겼다(동작은 ui.js · theme.js 등이 그대로 단다).
// 미리보기 영역은 overflow:hidden이라 메뉴는 position:fixed로 창 기준에 두고, 열 때·창 크기가 바뀔 때 버튼 아래에 맞춘다.
// 항목을 누르면 닫힌다. 바깥을 누르거나 Esc를 누르면 닫히고, ↑↓·Home·End로 항목 사이를 옮긴다.
const create = ({ toggle, menu, signal }) => {
  const on = (target, type, fn, options = {}) => target?.addEventListener(type, fn, { ...options, signal });
  const GAP = 6,
    MARGIN = 8;
  menu.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  const isOpen = () => !menu.hidden;
  const items = () =>
    [...menu.querySelectorAll("button")].filter(item => !item.disabled && !item.hidden && item.offsetParent !== null);
  const place = () => {
    const rect = toggle.getBoundingClientRect(),
      width = menu.offsetWidth,
      left = Math.max(MARGIN, Math.min(rect.right - width, window.innerWidth - MARGIN - width)),
      top = rect.bottom + GAP;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.maxHeight = `${Math.max(120, window.innerHeight - top - MARGIN)}px`;
  };
  const open = ({ focus = true } = {}) => {
    menu.hidden = false;
    place();
    toggle.setAttribute("aria-expanded", "true");
    if (focus) items()[0]?.focus();
  };
  const close = ({ refocus = false } = {}) => {
    if (menu.hidden) return;
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (refocus) toggle.focus();
  };
  on(toggle, "click", () => (isOpen() ? close() : open()));
  // 항목의 동작이 먼저 실행되도록(포커스를 옮기는 동작 등) 닫기는 버블 단계에서 한다.
  on(menu, "click", event => {
    if (event.target instanceof Element && event.target.closest("button")) close();
  });
  on(document, "pointerdown", event => {
    if (!isOpen()) return;
    const target = event.target;
    if (menu.contains(target) || toggle.contains(target)) return;
    close();
  });
  on(window, "resize", () => {
    if (isOpen()) place();
  });
  on(menu, "keydown", event => {
    const list = items(),
      index = list.indexOf(document.activeElement);
    let next = null;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close({ refocus: true });
      return;
    }
    if (event.key === "ArrowDown") next = list[(index + 1) % list.length];
    else if (event.key === "ArrowUp") next = list[(index - 1 + list.length) % list.length];
    else if (event.key === "Home") next = list[0];
    else if (event.key === "End") next = list[list.length - 1];
    else if (event.key === "Tab") close();
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });
  return { open, close, isOpen, toggle };
};

export { create };
