// 화면 영역(설정 패널 · 편집기)을 끌어서 정해진 자리(왼쪽·오른쪽·위·아래)에 놓는 공용 손잡이.
// - 손잡이를 누른 채 조금 움직이면 대상 영역 위에 놓을 수 있는 자리가 나타나고, 포인터가 가장 가까운 가장자리가 강조된다.
// - 놓으면 onDrop(side)를 부른다. 지금 자리에 놓거나, 대상 영역 밖에서 놓거나, Esc를 누르면 아무것도 바꾸지 않는다.
// - 키보드: 손잡이에 초점을 두고 방향키를 누르면 그 방향 자리로 바로 옮긴다.
// 자리 고르기(pickSide)는 DOM과 무관한 순수 함수라 node에서 검사한다.

const SIDES = ["left", "right", "top", "bottom"];
const KEY_SIDE = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" };
const LABEL = { left: "왼쪽", right: "오른쪽", top: "위", bottom: "아래" };
const THRESHOLD = 5;

// rect 안의 점(x, y)에서 가장 가까운 가장자리(허용된 자리 중). rect 밖이면 null.
const pickSide = (rect, x, y, sides = SIDES) => {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const left = rect.left ?? rect.x ?? 0,
    top = rect.top ?? rect.y ?? 0;
  const fx = (x - left) / rect.width,
    fy = (y - top) / rect.height;
  if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return null;
  const distance = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  let best = null;
  for (const side of sides) if (side in distance && (best === null || distance[side] < distance[best])) best = side;
  return best;
};

// grip: 손잡이 버튼 · target(): 자리를 고를 영역 · sides: 놓을 수 있는 자리 · current(): 지금 자리
// size(side): 미리보기 상자 크기(영역에 대한 비율 0–1) · enabled(): 지금 옮길 수 있는지(좁은 화면 등)
const create = ({
  grip,
  target,
  sides = SIDES,
  current,
  onDrop,
  size = () => 0.4,
  enabled = () => true,
  name = "",
}) => {
  if (!grip) return { dispose() {}, cancel() {} };
  const doc = grip.ownerDocument || document,
    view = doc.defaultView || window;
  let pointerId = null,
    startX = 0,
    startY = 0,
    dragging = false,
    side = null,
    overlay = null,
    preview = null;
  const controller = new AbortController(),
    signal = controller.signal;
  const listen = (node, type, fn, options = {}) => node?.addEventListener?.(type, fn, { ...options, signal });

  const buildOverlay = () => {
    overlay = doc.createElement("div");
    overlay.className = "dock-overlay";
    overlay.setAttribute("aria-hidden", "true");
    for (const each of sides) {
      const zone = doc.createElement("div");
      zone.className = "dock-zone";
      zone.dataset.side = each;
      zone.dataset.current = String(each === current?.());
      const label = doc.createElement("span");
      label.textContent = each === current?.() ? `${LABEL[each]} · 지금 자리` : LABEL[each];
      zone.append(label);
      overlay.append(zone);
    }
    preview = doc.createElement("div");
    preview.className = "dock-preview";
    overlay.append(preview);
    doc.body.append(overlay);
  };
  const place = () => {
    const rect = target()?.getBoundingClientRect?.();
    if (!overlay || !rect) return;
    Object.assign(overlay.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };
  const highlight = next => {
    side = next;
    if (!overlay) return;
    overlay.dataset.side = side || "";
    for (const zone of overlay.querySelectorAll(".dock-zone"))
      zone.classList.toggle("is-active", zone.dataset.side === side);
    const ratio = Math.max(0.12, Math.min(0.8, Number(size(side)) || 0.4)) * 100;
    preview.hidden = !side;
    if (!side) return;
    const style = { left: "0", top: "0", right: "auto", bottom: "auto", width: "100%", height: "100%" };
    if (side === "left" || side === "right") style.width = `${ratio}%`;
    else style.height = `${ratio}%`;
    if (side === "right") Object.assign(style, { left: "auto", right: "0" });
    if (side === "bottom") Object.assign(style, { top: "auto", bottom: "0" });
    Object.assign(preview.style, style);
  };
  const finish = () => {
    if (pointerId !== null && grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId);
    pointerId = null;
    dragging = false;
    side = null;
    overlay?.remove();
    overlay = preview = null;
    doc.body.classList.remove("dock-dragging");
    grip.classList.remove("is-dragging");
  };
  const cancel = () => finish();
  const drop = () => {
    const chosen = dragging ? side : null;
    finish();
    if (chosen && chosen !== current?.()) onDrop(chosen);
  };

  listen(grip, "pointerdown", event => {
    if (event.button !== 0 || pointerId !== null || !enabled()) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    try {
      grip.setPointerCapture?.(pointerId);
    } catch (_) {
      /* 이미 끝난 포인터면 붙잡지 못해도 이어지는 이벤트로 처리한다. */
    }
    event.preventDefault();
  });
  listen(grip, "pointermove", event => {
    if (event.pointerId !== pointerId) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < THRESHOLD) return;
      dragging = true;
      doc.body.classList.add("dock-dragging");
      grip.classList.add("is-dragging");
      buildOverlay();
      place();
    }
    highlight(pickSide(target()?.getBoundingClientRect?.(), event.clientX, event.clientY, sides));
  });
  listen(grip, "pointerup", event => {
    if (event.pointerId === pointerId) drop();
  });
  listen(grip, "pointercancel", event => {
    if (event.pointerId === pointerId) cancel();
  });
  listen(grip, "lostpointercapture", event => {
    if (event.pointerId === pointerId) cancel();
  });
  // 끌던 중 Esc: 옮기지 않고 그만둔다.
  listen(
    view,
    "keydown",
    event => {
      if (pointerId === null || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    },
    { capture: true }
  );
  listen(view, "blur", cancel);
  listen(grip, "keydown", event => {
    const next = KEY_SIDE[event.key];
    if (!next || !sides.includes(next) || event.ctrlKey || event.metaKey || event.altKey || !enabled()) return;
    event.preventDefault();
    if (next !== current?.()) onDrop(next);
  });
  // 드래그로 옮기지 않은 단순 클릭은 아무것도 하지 않는다(손잡이 사용법은 title로 안내).
  if (name) grip.setAttribute?.("aria-roledescription", `${name} 위치 손잡이`);
  return {
    cancel,
    dispose: () => {
      cancel();
      controller.abort();
    },
  };
};

export { create, pickSide, SIDES, LABEL };
