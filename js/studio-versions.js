// 프로젝트 버전 기록의 흐름(studio.js가 부른다): 언제 남길지 · 목록 · 이름 붙이기 · 지우기 · 되돌리기 순서.
// 저장은 version-store.js, 화면은 version-history.js, 작업 전체를 그 버전으로 바꾸는 일은 studio.js(adopt)가 한다.
//  · 실행에 성공할 때(마지막 버전과 다르고 1분이 지났을 때) · 다른 작업을 열기 전 · 버전을 되돌리기 전 · 직접 남길 때 남긴다
//  · 작업 열쇠는 보관함 프로젝트 id(저장 안 한 작업은 "work") — 프로젝트마다 따로 쌓인다
//   create({ store, key(), state(), disposed(), prepare(project) → Promise<boolean>, adopt(version),
//            replaceTab(name, code, version) → boolean, sourceOf(project, tab), setStatus, showError })
//   → { keep(label, { force }), list(), name(id, name), remove(id), restore(id), restoreTab(id, tab) }

// 같은 내용인지 견줄 지문: 코드 · 파라미터 값 · 프리셋 · 연결
const printOf = state =>
  JSON.stringify([
    state.project,
    state.users.map(user => [user.name, user.type, user.value]),
    state.presets,
    state.links,
  ]);
const changed = key => document.dispatchEvent(new CustomEvent("shader-versions-changed", { detail: { key } }));

const create = ({ store, key, state, disposed, prepare, adopt, replaceTab, sourceOf, setStatus, showError }) => {
  let last = { key: null, print: "", time: 0 }; // 이 작업에 마지막으로 남긴 버전(같은 내용 · 1분 간격 판단)
  // force: 1분 간격을 따지지 않는다(그래도 마지막 버전과 같으면 남기지 않는다). 상태는 부른 순간 잡아 둔다.
  const keep = async (label, { force = false } = {}) => {
    if (!store?.available || disposed()) return null;
    const id = key(),
      now = state(),
      print = printOf(now),
      time = Date.now();
    try {
      if (last.key !== id) {
        const [newest] = await store.list(id);
        last = { key: id, print: newest ? printOf(newest) : "", time: newest?.time || 0 };
      }
      if (last.print === print || (!force && time - last.time < 60000)) return null;
      last = { key: id, print, time };
      const saved = await store.add({ key: id, label, ...now });
      changed(id);
      return saved;
    } catch (error) {
      console.warn("버전 기록 저장 실패:", error);
      return null;
    }
  };
  const list = async () => (store?.available ? store.list(key()) : []);
  const find = async id => (await list()).find(item => item.id === id);
  // 이름 붙이기: 이름이 있는 버전은 자동 정리(최근 40개)에서 빠져 계속 남는다. 빈 이름이면 이름을 뗀다.
  const name = async (id, text) => {
    const saved = await store?.update(id, {
      name: String(text ?? "")
        .trim()
        .slice(0, 60),
    });
    changed(key());
    return saved;
  };
  const remove = async id => {
    const done = await store?.remove(id);
    changed(key());
    return !!done;
  };
  // 탭 하나만 되돌리기: 그 탭의 코드만 그 버전의 코드로(파라미터 · 다른 탭은 그대로). 그 탭이 지금 없으면 false.
  const restoreTab = async (id, tab) => {
    const version = await find(id),
      code = version ? sourceOf(version.project, tab) : null;
    if (typeof code !== "string" || disposed()) return false;
    return replaceTab(tab, code, version);
  };
  // 버전으로 되돌리기: 지금 작업을 먼저 버전으로 남기고, 뒤에서 컴파일한 뒤 작업 전체를 그 버전으로 바꾼다.
  // 보관함 프로젝트와의 연결은 그대로 두고(같은 프로젝트의 옛 모습), Ctrl+Z 한 번으로 바로 전 작업으로 돌아간다.
  const restore = async id => {
    const version = await find(id);
    if (!version || disposed()) return false;
    await keep("되돌리기 전", { force: true });
    if (!(await prepare(version.project))) return false;
    try {
      adopt(version);
      last = { key: key(), print: printOf(state()), time: Date.now() };
      setStatus(`${new Date(version.time).toLocaleString("ko-KR")} 버전으로 되돌렸습니다 · Ctrl+Z로 바로 전 작업`);
      return true;
    } catch (error) {
      showError(error);
      return false;
    }
  };
  return { keep, list, name, remove, restore, restoreTab };
};

export { create };
