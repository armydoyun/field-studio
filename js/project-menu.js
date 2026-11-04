// 프로젝트 메뉴: 뷰포트 머리줄의 프로젝트 이름 버튼으로 여는 팝오버.
// 편집기를 열지 않아도 보관함 저장·열기, Pack·소스 JSON, 새 프로젝트, 이미지를 다룬다(버튼 동작은 studio.js · studio-projects.js가 단다).
// 바깥을 누르거나 Esc를 누르면 닫힌다. 이름 입력 대화상자(<dialog>) 안을 누르는 것은 바깥으로 치지 않는다.
const create = ({ $, on }) => {
  const toggle = $("projectMenuToggle"),
    menu = $("projectMenu");
  menu.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  const isOpen = () => !menu.hidden;
  const firstAction = () => menu.querySelector?.("button:not([disabled]):not([hidden])");
  const open = ({ focus = true } = {}) => {
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    if (focus) firstAction()?.focus?.();
  };
  const close = ({ refocus = false } = {}) => {
    if (menu.hidden) return;
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (refocus) toggle.focus?.();
  };
  on(toggle, "click", () => (isOpen() ? close() : open()));
  on(document, "pointerdown", event => {
    if (!isOpen()) return;
    const target = event.target;
    if (menu.contains?.(target) || toggle.contains?.(target) || target?.closest?.("dialog")) return;
    close();
  });
  on(menu, "keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close({ refocus: true });
  });
  // 머리줄 버튼에 지금 작업 이름을 보여 준다. saved: 보관함의 항목과 이어져 있는지
  const setLabel = (text, saved) => {
    $("projectMenuLabel").textContent = text;
    toggle.dataset.saved = String(saved);
  };
  return { open, close, isOpen, setLabel };
};

export { create };
