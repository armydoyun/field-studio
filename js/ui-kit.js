// 디자인 시스템의 JS 쪽 창구: 컴포넌트 클래스 이름과, 그 클래스로 요소를 만드는 작은 함수들.
// 모양은 전부 css/components/*.css가 정한다. 여기서는 "어떤 클래스를 붙이는가"만 한곳에서 관리한다.
// 새 화면을 만들 때는 클래스 글자를 직접 쓰지 말고 이 함수들을 쓴다(쓰는 법: docs/DESIGN_SYSTEM.md).
//
//   UI.button({ label: "저장", variant: "primary", onClick })
//   UI.iconButton({ icon: "close", label: "닫기", size: "xs", onClick })
//   UI.segmented({ label: "방식", options: [{ value: "a", label: "A" }], value: "a", onChange })
//   UI.select({ options: [["1", "하나"]], value: "1", size: "sm", onChange })
//   UI.menu({ anchor: button, items: [{ label: "이름 바꾸기", onSelect }, { separator: true }, { label: "삭제", danger: true, onSelect }] })

// 클래스 이름 잇기: 빈 값은 건너뛴다.
const cx = (...parts) => parts.filter(Boolean).join(" ");

// 요소 만들기: el("p", "ui-hint", "설명")
const el = (tag, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

// ---- 클래스 이름 ----
// 버튼: variant = primary | ghost | tonal | danger | danger-solid | dashed, size = xs | sm | lg (기본 32px는 생략)
const buttonClass = ({ variant = "", size = "", block = false, icon = "", className = "" } = {}) =>
  cx(
    variant && `ui-btn--${variant}`,
    size && `ui-btn--${size}`,
    block && "ui-btn--block",
    icon && `glyph-icon icon-${icon}`,
    className
  );
// 아이콘만 있는 버튼: size = xs(24) | sm(28) | lg(36) (기본 32px는 생략)
const iconButtonClass = (icon, size = "", className = "") =>
  cx("ui-icon-btn", size && `ui-icon-btn--${size}`, icon && `glyph-icon icon-${icon}`, className);
// 꼬리표: tone = accent | success | warning | danger
const tagClass = ({ tone = "", pill = false, dot = false, plain = false, className = "" } = {}) =>
  cx(
    "ui-tag",
    tone && `ui-tag--${tone}`,
    pill && "ui-tag--pill",
    dot && "ui-tag--dot",
    plain && "ui-tag--plain",
    className
  );
const inputClass = (size = "", className = "") => cx(size && `ui-input--${size}`, className);

// ---- 요소 ----
const button = ({
  label = "",
  variant,
  size,
  block,
  icon,
  className,
  title = "",
  ariaLabel = "",
  pressed,
  type = "button",
  onClick,
} = {}) => {
  const node = el("button", buttonClass({ variant, size, block, icon, className }), label);
  node.type = type;
  if (title) node.title = title;
  if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
  if (pressed !== undefined) node.setAttribute("aria-pressed", String(!!pressed));
  if (onClick) node.addEventListener("click", onClick);
  return node;
};

// label은 스크린 리더 이름이자(aria-label) 풍선 도움말(title)이다. title을 따로 주면 풍선만 바뀐다.
const iconButton = ({ icon, label, title = label, size, className, pressed, onClick } = {}) => {
  const node = el("button", iconButtonClass(icon, size, className));
  node.type = "button";
  node.setAttribute("aria-label", label);
  if (title) node.title = title;
  if (pressed !== undefined) node.setAttribute("aria-pressed", String(!!pressed));
  if (onClick) node.addEventListener("click", onClick);
  return node;
};

// 세그먼트(하나 고르기). options: [{ value, label, title }] · 반환: { element, buttons, get(), set(value) }
// onChange는 사용자가 다른 칸을 골랐을 때만 불린다. set()은 화면만 바꾼다.
const segmented = ({ label = "", options = [], value, onChange, size = "", className = "" } = {}) => {
  const element = el("div", cx("ui-seg", size && `ui-seg--${size}`, className));
  element.setAttribute("role", "radiogroup");
  if (label) element.setAttribute("aria-label", label);
  let current = value;
  const buttons = options.map(option => {
    const node = el("button", "", option.label);
    node.type = "button";
    node.dataset.value = String(option.value);
    node.setAttribute("role", "radio");
    if (option.title) node.title = option.title;
    node.addEventListener("click", () => {
      if (option.value === current) return;
      set(option.value);
      onChange?.(option.value);
    });
    return node;
  });
  const set = next => {
    current = next;
    buttons.forEach((node, index) => {
      const on = options[index].value === next;
      node.setAttribute("aria-checked", String(on));
      node.tabIndex = on || (next === undefined && index === 0) ? 0 : -1;
    });
  };
  // 방향키로 옆 칸 고르기(라디오 묶음 관례)
  element.addEventListener("keydown", event => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const at = buttons.indexOf(document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    const next = buttons[(at + step + buttons.length) % buttons.length];
    next.focus();
    next.click();
  });
  set(value);
  element.append(...buttons);
  return { element, buttons, get: () => current, set };
};

// 선택 상자. options: [[value, label], …] 또는 [{ value, label }, …]
const select = ({ options = [], value, onChange, size = "", ariaLabel = "", className = "" } = {}) => {
  const node = el("select", inputClass(size, className));
  for (const option of options) {
    const [optionValue, optionLabel] = Array.isArray(option) ? option : [option.value, option.label];
    node.append(new Option(optionLabel, String(optionValue)));
  }
  if (value !== undefined) node.value = String(value);
  if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
  if (onChange) node.addEventListener("change", () => onChange(node.value));
  return node;
};

// 숫자 칸(고정폭 · 스핀 버튼 없음)
const numberInput = ({ value, min, max, step, size = "", ariaLabel = "", className = "", onChange } = {}) => {
  const node = el("input", cx("ui-number", inputClass(size, className)));
  node.type = "number";
  for (const [key, v] of Object.entries({ min, max, step, value })) if (v !== undefined) node[key] = String(v);
  if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
  if (onChange) node.addEventListener("change", () => onChange(Number(node.value)));
  return node;
};

// 체크박스 + 글자(label). 반환: { element, input }
const checkbox = ({ label = "", checked = false, title = "", className = "", onChange } = {}) => {
  const element = el("label", cx("ui-check", className));
  const input = el("input");
  input.type = "checkbox";
  input.checked = !!checked;
  if (title) element.title = title;
  if (onChange) input.addEventListener("change", () => onChange(input.checked));
  element.append(input, document.createTextNode(` ${label}`));
  return { element, input };
};

// 라벨 + 조작 + 설명 묶음
const field = ({ label = "", hint = "", control, className = "" } = {}) => {
  const element = el("div", cx("ui-field", className));
  if (label) element.append(el("label", "ui-label", label));
  if (control) element.append(control);
  if (hint) element.append(el("p", "ui-hint", hint));
  return element;
};

const tag = (text, options) => el("span", tagClass(options), text);
const hint = (text, className = "") => el("p", cx("ui-hint", className), text);
// 알림 상자: tone = warning | danger | success | accent
const notice = (text, { tone = "", bar = false, className = "" } = {}) =>
  el("p", cx("ui-notice", tone && `ui-notice--${tone}`, bar && "ui-notice--bar", className), text);

// 떠 있는 메뉴. anchor(버튼) 아래에 붙여 열고, 바깥을 누르거나 Esc · 항목 선택으로 닫는다. ↑↓ Home End로 항목을 옮긴다.
// items: [{ id, label, icon, kbd, danger, disabled, pressed, title, onSelect } | { separator: true } | { title: "묶음 제목" }]
// at: { x, y, doc } — anchor 대신 그 화면 좌표(우클릭 위치)에 연다. returnFocus: 닫힐 때 초점을 돌려줄 요소(at과 함께).
// 반환: { element, close() }. 닫히면 anchor(또는 returnFocus)로 초점이 돌아가고 onClose가 불린다.
// focusFirst: false면 첫 항목 대신 메뉴 자체에 초점(포인터로 연 우클릭 메뉴 — 방향키를 누르면 첫 항목부터).
const menu = ({
  anchor,
  at,
  returnFocus,
  focusFirst = true,
  items = [],
  label = "",
  align = "start",
  onClose,
} = {}) => {
  const doc = anchor?.ownerDocument || at?.doc || document;
  const view = doc.defaultView || window;
  const element = el("div", "ui-popover ui-menu");
  element.setAttribute("role", "menu");
  if (label) element.setAttribute("aria-label", label);
  element.style.position = "fixed";
  let open = true;
  const close = ({ focus = true } = {}) => {
    if (!open) return;
    open = false;
    element.remove();
    doc.removeEventListener("pointerdown", onOutside, true);
    doc.removeEventListener("keydown", onKey, true);
    view.removeEventListener("resize", close);
    anchor?.setAttribute("aria-expanded", "false");
    if (focus) (anchor || returnFocus)?.focus?.({ preventScroll: true });
    onClose?.();
  };
  const onOutside = event => {
    if (!element.contains(event.target) && !anchor?.contains(event.target)) close({ focus: false });
  };
  const enabled = () => [...element.querySelectorAll(".ui-menu-item:not(:disabled)")];
  const onKey = event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const list = enabled();
    const at = list.indexOf(doc.activeElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[event.key];
    if (next === undefined || !list.length) return;
    event.preventDefault();
    list[(next + list.length) % list.length].focus();
  };
  for (const item of items) {
    if (item.separator) {
      element.append(el("hr", "ui-menu-sep"));
      continue;
    }
    if (item.title && !item.label) {
      element.append(el("p", "ui-menu-title", item.title));
      continue;
    }
    const node = el(
      "button",
      cx("ui-menu-item", item.icon && `glyph-icon icon-${item.icon}`, item.danger && "is-danger")
    );
    node.type = "button";
    if (item.id) node.id = item.id;
    node.setAttribute("role", "menuitem");
    node.append(el("span", "", item.label));
    if (item.kbd) node.append(el("kbd", "", item.kbd));
    if (item.title) node.title = item.title;
    if (item.pressed !== undefined) node.setAttribute("aria-pressed", String(!!item.pressed));
    node.disabled = !!item.disabled;
    node.addEventListener("click", () => {
      close();
      item.onSelect?.();
    });
    element.append(node);
  }
  doc.body.append(element);
  // 자리: anchor 아래. 창 밖으로 나가면 안쪽으로 당기고, 아래 자리가 모자라면 위로 연다.
  if (anchor) {
    const box = anchor.getBoundingClientRect();
    const size = element.getBoundingClientRect();
    const left = align === "end" ? box.right - size.width : box.left;
    const below = box.bottom + 6;
    const top =
      below + size.height > view.innerHeight - 8 && box.top - 6 - size.height > 8 ? box.top - 6 - size.height : below;
    element.style.left = `${Math.max(8, Math.min(left, view.innerWidth - size.width - 8))}px`;
    element.style.top = `${Math.max(8, top)}px`;
    element.style.maxHeight = `${view.innerHeight - 16}px`;
    anchor.setAttribute("aria-haspopup", "menu");
    anchor.setAttribute("aria-expanded", "true");
  } else if (at) {
    // 포인터 오른쪽 아래로 열고, 창 밖으로 나가면 반대쪽으로 뒤집는다.
    const size = element.getBoundingClientRect();
    const left = at.x + size.width > view.innerWidth - 8 ? at.x - size.width : at.x;
    const top = at.y + size.height > view.innerHeight - 8 ? at.y - size.height : at.y;
    element.style.left = `${Math.max(8, Math.min(left, view.innerWidth - size.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(top, view.innerHeight - size.height - 8))}px`;
    element.style.maxHeight = `${view.innerHeight - 16}px`;
  }
  doc.addEventListener("pointerdown", onOutside, true);
  doc.addEventListener("keydown", onKey, true);
  view.addEventListener("resize", close);
  if (focusFirst) enabled()[0]?.focus();
  else {
    element.tabIndex = -1;
    element.focus({ preventScroll: true });
  }
  return { element, close };
};

// 검색 칸(ui-search)의 지우기 버튼(ui-search-clear): 브라우저 기본 ×는 칸마다 자리 · 모양이 달라 감추고 이 버튼을 쓴다.
// 버튼은 마크업에 두고(글자가 있을 때만 CSS로 보인다), 누르면 칸을 비우고 input 이벤트로 각 기능의 검색을 다시 돌린다.
const bindSearchClear = (doc = document) => {
  const onClick = event => {
    const clear = event.target instanceof Element ? event.target.closest(".ui-search-clear") : null,
      input = clear?.closest(".ui-search")?.querySelector("input");
    if (!input) return;
    event.preventDefault();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };
  doc.addEventListener("click", onClick);
  return () => doc.removeEventListener("click", onClick);
};

// 팝오버 메뉴(position:fixed)의 공통 닫기 동작: 바깥을 누르면 닫기 · 창 크기가 바뀌면 다시 놓기 ·
// 미리보기 분리 창이 열리고 닫히면(문서가 바뀌면) 닫고 그 문서에 다시 연결한다. 이미 연결한 문서는 건너뛴다.
//   dismissPopover({ menu, toggle, owner, isOpen, close, place, on, ignore?(target), bindExtra?(doc) }) → bind()
//   bind: 메뉴를 다른 문서로 옮긴 뒤 부르면 그 문서에도 연결한다.
const dismissPopover = ({
  menu,
  toggle,
  owner,
  isOpen,
  close,
  place,
  on,
  ignore = () => false,
  bindExtra = () => {},
}) => {
  const outside = event => {
    if (!isOpen()) return;
    const target = event.target;
    if (menu.contains?.(target) || toggle.contains?.(target) || ignore(target)) return;
    close();
  };
  const bound = new WeakSet();
  const bind = () => {
    const doc = owner();
    if (bound.has(doc)) return;
    bound.add(doc);
    on(doc, "pointerdown", outside);
    bindExtra(doc);
    on(doc.defaultView || window, "resize", () => {
      if (isOpen()) place();
    });
  };
  bind();
  on(document, "preview-popout-changed", () => {
    close();
    bind();
  });
  return bind;
};

// 편집 대화상자(행렬 · 값 편집)의 뼈대: <dialog class="ui-dialog ui-dialog--md"> · 머리(제목 · 설명 · 닫기) · 본문 · 실행 줄(취소 · 적용).
// Esc(cancel)와 다른 이유로 닫힐 때(close)도 onCancel을 부른다. onCancel(부르는 쪽의 닫기)은 대화상자를 닫고 문서에서 떼어 내야 한다.
//   editDialog({ label, title, description, closeLabel, className, bodyClass, onCancel })
//     → { dialog, body, show(apply, doc) }: show는 실행 줄에 취소 · apply를 놓고 문서에 붙여 모달로 연다
const editDialog = ({
  label,
  title,
  description = "",
  closeLabel = "취소",
  className = "",
  bodyClass = "",
  onCancel,
}) => {
  const dialog = el("dialog", cx("ui-dialog ui-dialog--md", className)),
    head = el("header", "ui-dialog-head"),
    heading = el("div", "ui-dialog-text"),
    body = el("div", cx("ui-dialog-body", bodyClass)),
    foot = el("footer", "ui-dialog-foot");
  dialog.setAttribute("aria-label", label);
  heading.append(el("h2", "", title), ...(description ? [el("p", "", description)] : []));
  head.append(heading, iconButton({ icon: "close", label: closeLabel, size: "lg", onClick: () => onCancel() }));
  dialog.append(head, body, foot);
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    onCancel();
  });
  // close 이벤트는 나중에 온다: 부르는 쪽이 이미 닫고 문서에서 뗀 대화상자면(그사이 새 대화상자가 열렸을 수 있다) 무시한다
  dialog.addEventListener("close", () => {
    if (dialog.isConnected) onCancel();
  });
  const show = (apply, doc = document) => {
    foot.append(button({ label: "취소", size: "lg", onClick: () => onCancel() }), apply);
    doc.body.append(dialog);
    dialog.showModal();
  };
  return { dialog, body, show };
};

export {
  bindSearchClear,
  editDialog,
  dismissPopover,
  cx,
  el,
  buttonClass,
  iconButtonClass,
  tagClass,
  inputClass,
  button,
  iconButton,
  segmented,
  select,
  numberInput,
  checkbox,
  field,
  tag,
  hint,
  notice,
  menu,
};
