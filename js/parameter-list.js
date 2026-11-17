// 파라미터 목록의 행 캐시(ui.js renderUniforms가 쓴다). 행을 남겨 두고 값만 맞추는 규칙을 한곳에 둔다.
//  · 행마다 '구조 열쇠'(타입 · 설정 · 코드 주석 · 연결 · 열린 시트 · 잠금 — keyOf)를 기억한다. 열쇠가 바뀌면 그 행만 새로 만든다.
//  · 열쇠가 같고 값만 바뀌면 행의 갱신 함수(views.play)로 보여 준다. 갱신 함수가 없거나 거절하면 그 행만 다시 만든다.
//    연결(소리 · MIDI · 흔들기 · 키)이 정하는 값은 연결 미터 · 내비게이터가 따로 따라가므로 그대로 둔다.
//  · '행이 보여 주는 값'(entry.value)은 행을 만들 때와, 행에서 사용자가 값을 바꿀 때(shows) 갱신한다. 이 값과 렌더러의 값이
//    다를 때만 행을 다시 맞추므로, 사용자가 바꾼 뒤 다른 길(기본값으로 되돌리기 · 되돌리기 기록 · 프리셋)로 처음 값에
//    돌아와도 행이 옛 조작을 보여 주지 않는다. shows(name, undefined)는 다음에 반드시 다시 맞추게 한다.
//  · 걸러져 아직 만들지 않은 행은 브라우저가 한가할 때 하나씩 미리 만든다(prebuild).
//   create({ build(item, defaults) → { row, group }, keyOf(item, spec), linked(item), views: { play, reset, change },
//            registries: [이름(배열은 이름[i]) → … 등록표], parameterViews, forget(row), source(), defaults(), signal })
//   → { entryFor(item, defaults), prune(names), drop(name), shows(name, value), prebuild() }

const create = ({ build, keyOf, linked, views, registries, parameterViews, forget, source, defaults, signal }) => {
  const cache = new Map(); // 이름 → { row, group, key, item, value, views }
  const ownedBy = (key, name) => key === name || key.startsWith(`${name}[`);
  const drop = name => {
    const entry = cache.get(name);
    if (!entry) return;
    cache.delete(name);
    for (const registry of registries)
      for (const key of [...registry.keys()]) if (ownedBy(key, name)) registry.delete(key);
    for (const view of entry.views) {
      view.dispose();
      const at = parameterViews.indexOf(view);
      if (at >= 0) parameterViews.splice(at, 1);
    }
    forget(entry.row);
    entry.row.remove();
  };
  const make = (item, specs, key) => {
    const before = parameterViews.length,
      { row, group } = build(item, specs);
    const entry = { row, group, key, item, value: JSON.stringify(item.value), views: parameterViews.slice(before) };
    cache.set(item.name, entry);
    return entry;
  };
  // 이 파라미터의 행(남길 수 있으면 값만 맞춘 기존 행, 아니면 새 행)
  const entryFor = (item, specs) => {
    const key = keyOf(item, specs.get(item.name));
    let entry = cache.get(item.name);
    if (entry && entry.key !== key) {
      drop(item.name);
      entry = null;
    }
    if (entry) {
      const value = JSON.stringify(item.value);
      if (value !== entry.value) {
        Object.assign(entry.item, item); // 행의 처리기들이 붙잡은 객체를 새 값으로
        entry.value = value;
        const refresh = views.play.get(item.name);
        if (linked(item)) {
          // 그대로 둔다
        } else if (refresh && refresh(item.value) !== false) {
          views.reset.get(item.name)?.(item.value);
          views.change.get(item.name)?.(item.value);
        } else {
          drop(item.name);
          entry = null;
        }
      }
    }
    return entry ?? make(item, specs, key);
  };
  // 없어진 파라미터의 행을 버린다
  const prune = names => {
    for (const name of [...cache.keys()]) if (!names.has(name)) drop(name);
  };
  const shows = (name, value) => {
    const entry = cache.get(name);
    if (entry) entry.value = value === undefined ? null : JSON.stringify(value);
  };
  // 걸러져 아직 만들지 않은 행(검색 · @if · 변경만 보기)을 한가할 때 미리 — 첫 검색에서 수십 개 행을 한꺼번에 만드느라
  // 늦던 것. 문서에 붙지 않은 채 만든 패드는 붙을 때 다시 그려진다(renderUniforms 끝의 redraw).
  let handle = 0;
  const step = deadline => {
    handle = 0;
    if (signal.aborted) return;
    const specs = defaults();
    for (const item of source()) {
      if (cache.has(item.name)) continue;
      if (deadline.timeRemaining() < 4) return prebuild();
      make(item, specs, keyOf(item, specs.get(item.name)));
    }
  };
  const prebuild = () => {
    if (handle || typeof window.requestIdleCallback !== "function") return;
    handle = window.requestIdleCallback(step, { timeout: 3000 });
  };
  signal.addEventListener("abort", () => handle && window.cancelIdleCallback?.(handle));
  return { entryFor, prune, drop, shows, prebuild };
};

export { create };
