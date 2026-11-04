// 브라우저 안의 프로젝트 보관함(IndexedDB). 프로젝트 하나 = Pack 텍스트 하나(코드·파라미터·설정·이미지 원본).
// 목록을 빨리 보이도록 요약(meta)과 본문(pack)을 다른 저장소에 둔다. 둘은 한 트랜잭션으로 함께 쓰고 지운다.
//   meta: {id, name, created, updated, size, passes, images}
//   pack: {id, text}

const DB_NAME = "shader-studio-projects-v1",
  META = "meta",
  PACKS = "packs",
  NAME_LIMIT = 80;

// 이름 정리: 앞뒤 공백을 지우고 줄바꿈을 한 칸으로 바꾼다. 빈 이름은 오류.
const cleanName = name => {
  const text = String(name ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) throw new Error("프로젝트 이름을 입력하세요.");
  if (text.length > NAME_LIMIT) throw new Error(`프로젝트 이름은 ${NAME_LIMIT}자 이하여야 합니다.`);
  return text;
};

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// dbName은 테스트가 실제 보관함을 건드리지 않도록 바꿔 쓸 수 있게 열어 둔다.
const create = ({ dbName = DB_NAME, now = () => Date.now() } = {}) => {
  const open = () =>
    new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error("이 브라우저에서는 프로젝트 보관함(IndexedDB)을 쓸 수 없습니다."));
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
        if (!db.objectStoreNames.contains(PACKS)) db.createObjectStore(PACKS, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("프로젝트 보관함을 열 수 없습니다."));
      request.onblocked = () => reject(new Error("다른 탭이 프로젝트 보관함을 쓰고 있습니다. 다른 탭을 닫고 다시 시도하세요."));
    });
  // stores의 저장소를 mode로 열고 work(저장소들)를 실행한다. 트랜잭션이 끝나야 결과를 돌려준다.
  const run = async (mode, work) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction([META, PACKS], mode);
        let result;
        try {
          result = work({ meta: tx.objectStore(META), packs: tx.objectStore(PACKS) });
        } catch (error) {
          tx.abort();
          reject(error);
          return;
        }
        tx.oncomplete = () => resolve(typeof result === "function" ? result() : result);
        tx.onerror = () => reject(tx.error || new Error("프로젝트 보관함 작업 실패"));
        tx.onabort = () => reject(tx.error || new Error("프로젝트 보관함 작업이 취소됐습니다."));
      });
    } finally {
      db.close();
    }
  };
  const requestValue = request => () => request.result;

  // 최근에 저장한 것이 위로 온다.
  const list = () =>
    run("readonly", ({ meta }) => {
      const request = meta.getAll();
      return () => [...(request.result || [])].sort((a, b) => b.updated - a.updated);
    });
  const get = id => run("readonly", ({ meta }) => requestValue(meta.get(id)));

  // id가 있으면 덮어쓰고(만든 시각은 유지), 없으면 새로 만든다. 저장한 요약을 돌려준다.
  const save = async ({ id = null, name, text, passes = 0, images = 0 }) => {
    const title = cleanName(name);
    if (typeof text !== "string" || !text) throw new Error("저장할 프로젝트 내용이 없습니다.");
    const previous = id ? await get(id) : null;
    const time = now(),
      record = {
        id: previous ? previous.id : newId(),
        name: title,
        created: previous ? previous.created : time,
        updated: time,
        size: text.length,
        passes,
        images,
      };
    await run("readwrite", ({ meta, packs }) => {
      meta.put(record);
      packs.put({ id: record.id, text });
    });
    return record;
  };
  const load = async id => {
    const entry = await run("readonly", ({ packs }) => requestValue(packs.get(id)));
    if (!entry) throw new Error("보관함에서 프로젝트를 찾을 수 없습니다. 다른 탭에서 지웠을 수 있습니다.");
    return entry.text;
  };
  const rename = async (id, name) => {
    const title = cleanName(name),
      record = await get(id);
    if (!record) throw new Error("보관함에서 프로젝트를 찾을 수 없습니다.");
    const next = { ...record, name: title };
    await run("readwrite", ({ meta }) => {
      meta.put(next);
    });
    return next;
  };
  const remove = id =>
    run("readwrite", ({ meta, packs }) => {
      meta.delete(id);
      packs.delete(id);
    });
  // 테스트 정리용: 이 보관함(DB) 전체를 지운다.
  const destroy = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });

  return { list, get, save, load, rename, remove, destroy };
};

export { create, cleanName, DB_NAME, NAME_LIMIT };
