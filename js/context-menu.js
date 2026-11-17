// 우클릭 메뉴(앱 전체 공용). 기능 모듈이 영역(선택자)마다 메뉴 항목을 등록하고, 우클릭하면 눌린 요소에서
// 바깥쪽으로 올라가며 처음 맞는 영역의 메뉴를 포인터 자리에 연다(UI.menu). 항목 모양은 UI.menu와 같다.
//   register(selector, build, { signal }) — build(node, event) → items | null(이 영역 메뉴 없음 → 바깥 영역으로)
// 브라우저 기본 메뉴를 남기는 곳: 글을 입력하는 칸 · 선택한 글자 위(복사) · 등록된 메뉴가 없는 대화상자 안 ·
// Shift를 누른 우클릭(언제든 기본 메뉴로 빠져나갈 길).
import * as UI from "./ui-kit.js";

const providers = [];
const mounted = new WeakSet();
let current = null;

const register = (selector, build, { signal } = {}) => {
  const entry = { selector, build };
  providers.push(entry);
  const remove = () => {
    const at = providers.indexOf(entry);
    if (at >= 0) providers.splice(at, 1);
  };
  signal?.addEventListener("abort", remove, { once: true });
  return remove;
};

const TEXT_INPUT =
  'textarea,[contenteditable]:not(.cm-content),input:not([type="range"],[type="checkbox"],[type="radio"],[type="color"],[type="button"],[type="submit"],[type="file"])';

// 선택한 글자 위를 눌렀으면 복사할 수 있게 기본 메뉴를 둔다(편집기 안은 편집기 메뉴가 처리).
const onSelection = (doc, node) => {
  const selection = doc.getSelection?.();
  if (!selection || selection.isCollapsed || !String(selection).trim()) return false;
  for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode?.(node)) return true;
  return false;
};

// 조건부 항목(null · false)을 빼고, 맨 앞 · 맨 뒤 · 겹친 구분선을 정리한다.
const tidy = items => {
  const list = [];
  for (const item of items.filter(Boolean)) {
    if (item.separator && (!list.length || list.at(-1).separator)) continue;
    list.push(item);
  }
  while (list.at(-1)?.separator) list.pop();
  return list;
};

const close = () => {
  current?.close({ focus: false });
  current = null;
};

const open = (event, items, label, node) => {
  close();
  const doc = node.ownerDocument;
  let x = event.clientX,
    y = event.clientY;
  const byKeyboard = !x && !y;
  // 키보드(메뉴 키 · Shift+F10)로 연 메뉴는 좌표가 없으므로 초점 요소 아래에 연다.
  if (byKeyboard) {
    const box = (
      doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : node
    ).getBoundingClientRect();
    x = box.left + 8;
    y = box.bottom - 4;
  }
  const focusBack = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
  current = UI.menu({
    at: { x, y, doc },
    returnFocus: focusBack,
    focusFirst: byKeyboard,
    label: label || "메뉴",
    items,
    onClose: () => (current = null),
  });
  current.element.classList.add("ui-context-menu");
  return current;
};

const handle = event => {
  if (event.defaultPrevented || event.shiftKey) return;
  // 분리 창의 body와 메인 창에서 옮긴 canvas는 서로 다른 Element 생성자를 쓴다.
  const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
  if (!target) return;
  // 메뉴 위를 다시 우클릭해도 기본 메뉴를 띄우지 않는다.
  if (target.closest(".ui-menu")) {
    event.preventDefault();
    return;
  }
  if (target.closest(TEXT_INPUT)) return;
  const doc = target.ownerDocument;
  if (!target.closest(".cm-editor") && onSelection(doc, target)) return;
  for (let node = target; node && node.nodeType === 1; node = node.parentElement) {
    for (const provider of providers) {
      if (!node.matches(provider.selector)) continue;
      const result = provider.build(node, event);
      const items = tidy((Array.isArray(result) ? result : result?.items) || []);
      if (!items?.length) continue;
      event.preventDefault();
      open(event, items, result?.label, node);
      return;
    }
  }
};

// 문서마다 한 번(분리 창으로 옮긴 미리보기도 같은 메뉴를 쓴다).
const mount = (doc = document) => {
  if (!doc || mounted.has(doc)) return;
  mounted.add(doc);
  doc.addEventListener("contextmenu", handle);
};

const isOpen = () => !!current;

export { register, mount, close, isOpen };
