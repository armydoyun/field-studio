// 분리 창으로 옮기는 원본 UI도 같은 id로 찾는다. 문서가 바뀌어도 이벤트·상태 갱신은 원본 요소를 쓴다.
const createLookup = (doc = document) => {
  const roots = ["screen", "stageHeader", "studioPromptDialog", "videoRenderDialog"]
    .map(id => doc.getElementById(id))
    .filter(Boolean);
  return id => {
    const local = doc.getElementById(id);
    if (local) return local;
    for (const root of roots) {
      if (root.id === id) return root;
      const node = root.querySelector?.(`[id="${id}"]`);
      if (node) return node;
    }
    return null;
  };
};

// 문서가 달라지거나 HUD·도크를 숨겨도 보이는 조작에 초점을 돌린다.
const focusVisible = nodes => {
  const node = nodes.find(
    node =>
      node && !node.hidden && !node.closest?.("[inert]") && (!node.getClientRects || node.getClientRects().length > 0)
  );
  node?.focus({ preventScroll: true });
  return node;
};

export { createLookup, focusVisible };
