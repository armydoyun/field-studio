// 프로젝트 버전 기록 저장소(IndexedDB). 되돌리기(25칸 · 새로 고침하면 사라짐)보다 긴 안전망: 실행에 성공할 때(1분에 한 번까지) ·
// 다른 프로젝트를 열기 전 · 버전을 되돌리기 전 · 직접 남길 때 작업 전체(코드 · 파라미터 · 프리셋 · 연결)를 남긴다.
// 프로젝트 보관함(project-store.js)과 다른 DB라 보관함 형식을 건드리지 않는다.
//   버전 = { id, key(보관함 프로젝트 id 또는 "work"), time, label, project, users, presets, links, selected }
//   create({ dbName, now }) → { add(entry), list(key) → 최신 순, update(id, patch), remove(id), available }
//   한 작업(key)마다 최근 KEEP개, 전체 TOTAL개까지 둔다(오래된 것부터 지운다). 이름(name)을 붙인 버전은 세지도 지우지도 않는다
//   — 남겨 두고 싶은 버전은 이름을 붙이면 된다. IndexedDB가 없으면 아무것도 하지 않는다.

const DB_NAME = "field-versions-v1",
  STORE = "versions",
  KEEP = 40,
  TOTAL = 400;

const create = ({ dbName = DB_NAME, now = () => Date.now() } = {}) => {
  const available = !!globalThis.indexedDB;
  let opening = null;
  const open = () =>
    (opening ??= new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("key", "key");
        store.createIndex("time", "time");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = null;
        reject(request.error || new Error("버전 기록을 열지 못했습니다."));
      };
    }));
  const run = async (mode, work) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode),
        store = tx.objectStore(STORE);
      let result;
      Promise.resolve(work(store, value => (result = value))).catch(reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("버전 기록 저장소 오류"));
    });
  };
  const all = request =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  const list = async key => {
    if (!available) return [];
    const items = await run("readonly", (store, done) => all(store.index("key").getAll(key)).then(done));
    return items.sort((a, b) => b.time - a.time);
  };
  const add = async entry => {
    if (!available) return null;
    const item = {
      ...entry,
      id: `v${now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      time: now(),
      key: String(entry.key || "work"),
    };
    await run("readwrite", async store => {
      store.put(item);
      // 이 작업의 오래된 버전 정리
      const mine = (await all(store.index("key").getAll(item.key)))
        .filter(entry => !entry.name)
        .sort((a, b) => b.time - a.time);
      for (const old of mine.slice(KEEP)) store.delete(old.id);
      const everything = await all(store.index("time").getAllKeys());
      if (everything.length > TOTAL) {
        const oldest = await all(store.index("time").getAll(null, everything.length - TOTAL));
        for (const old of oldest) if (!old.name) store.delete(old.id);
      }
    });
    return item;
  };
  const update = async (id, patch) => {
    if (!available) return null;
    let next = null;
    await run("readwrite", async store => {
      const [current] = await all(store.getAll(id));
      if (!current) return;
      next = { ...current, ...patch, id: current.id, key: current.key, time: current.time };
      if (!next.name) delete next.name;
      store.put(next);
    });
    return next;
  };
  const remove = async id => {
    if (!available) return false;
    await run("readwrite", store => store.delete(id));
    return true;
  };
  return { add, list, update, remove, available };
};

export { create, KEEP };
