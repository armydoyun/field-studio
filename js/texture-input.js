// 로컬 이미지를 Texture로 보관한다. 파일 본문은 IndexedDB에, GPU 객체는 WebGL에 둔다.
const DB_NAME = "shader-studio-textures-v1",
  STORE = "files";
const openDB = () =>
  new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("IndexedDB 사용 불가"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
const accessDB = async (mode, action) => {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode),
        req = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("이미지 저장 취소"));
    });
  } finally {
    db.close();
  }
};
const createTextureInput = gl => {
  const library = new Map();
  let writes = Promise.resolve();
  const persist = action => {
    const next = writes.then(() => accessDB("readwrite", action));
    writes = next.catch(() => {});
    return next;
  };
  let nextId = 1,
    lost = false,
    disposed = false;
  const defaults = { filter: "linear", wrapS: "clamp", wrapT: "clamp" };
  // 렌더 루프 등 이전 호출이 남긴 GL 오류가 이번 업로드 실패로 오인되지 않도록 검사 직전에 비운다.
  // (독립 모듈로 테스트되므로 gpu-diagnostics.js의 clearErrors와 같은 로직을 지역으로 둔다.)
  const clearErrors = () => {
    let count = 0;
    while (count < 32 && gl.getError() !== gl.NO_ERROR) count++;
  };
  const normalize = value => {
    const next = { ...defaults, ...value };
    if (
      !["linear", "nearest"].includes(next.filter) ||
      !["clamp", "repeat", "mirror"].includes(next.wrapS) ||
      !["clamp", "repeat", "mirror"].includes(next.wrapT)
    )
      throw new Error("Texture 샘플링 설정이 올바르지 않습니다.");
    return next;
  };
  const applyParams = options => {
    const filter = options.filter === "nearest" ? gl.NEAREST : gl.LINEAR;
    const wraps = { clamp: gl.CLAMP_TO_EDGE, repeat: gl.REPEAT, mirror: gl.MIRRORED_REPEAT };
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wraps[options.wrapS]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wraps[options.wrapT]);
  };
  const upload = (bitmap, options) => {
    if (lost) return null;
    if (bitmap.width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || bitmap.height > gl.getParameter(gl.MAX_TEXTURE_SIZE))
      throw new Error("이미지가 GPU 최대 Texture 크기를 초과합니다.");
    const tex = gl.createTexture();
    if (!tex) throw new Error("Texture 생성 실패");
    const old = gl.getParameter(gl.TEXTURE_BINDING_2D);
    clearErrors();
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      applyParams(options);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("이미지 GPU 업로드 실패");
      return tex;
    } catch (error) {
      gl.deleteTexture(tex);
      throw error;
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, old);
    }
  };
  const add = async (file, id, options) => {
    if (disposed) throw new Error("이미 폐기된 Texture 저장소입니다.");
    if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 12 * 1024 * 1024)
      throw new Error("12MB 이하 PNG/JPEG/WebP 파일만 지원합니다.");
    const key = id || `tex${nextId++}`;
    if (library.has(key)) throw new Error(`이미 등록된 이미지: ${key}`);
    const sampling = normalize(options);
    const bitmap = await createImageBitmap(file, { imageOrientation: "flipY" });
    let tex = null;
    try {
      if (disposed) throw new Error("이미 폐기된 Texture 저장소입니다.");
      if (library.has(key)) throw new Error(`이미 등록된 이미지: ${key}`);
      if (bitmap.width * bitmap.height > 4096 * 4096) throw new Error("이미지는 최대 약 1,677만 픽셀까지 지원합니다.");
      tex = upload(bitmap, sampling);
    } catch (error) {
      bitmap.close();
      throw error;
    }
    library.set(key, {
      id: key,
      name: file.name || key,
      width: bitmap.width,
      height: bitmap.height,
      bitmap,
      tex,
      file,
      sampling,
    });
    const number = Number(/^tex(\d+)$/.exec(key)?.[1]);
    if (Number.isSafeInteger(number)) nextId = Math.max(nextId, number + 1);
    if (id) return { id: key, saved: true };
    try {
      await persist(store => store.put({ id: key, name: file.name, blob: file, sampling }));
      return { id: key, saved: true };
    } catch (error) {
      return { id: key, saved: false, error: error.message };
    }
  };
  // 저장해 둔 이미지를 되살린다. priority(id 목록)에 든 것(지금 프로젝트가 쓰는 것)부터 기다려 되살리고,
  // 나머지는 앱이 뜬 뒤 하나씩 이어서 되살린다(시작이 이미지 수에 비례해 느려지지 않게). 나머지까지 끝나면 whenRestored()가 풀린다.
  // onProgress({done, total, failed}): 뒤쪽 복원 진행. failed: 복원하지 못한 이미지 id 목록.
  let restoring = Promise.resolve();
  const failed = [];
  const restoreOne = async record => {
    try {
      await add(record.blob, record.id, record.sampling);
    } catch (error) {
      failed.push(record.id);
      console.warn("Texture 복원 실패:", record.id, error);
    }
  };
  const restoreSaved = async ({ priority = null, onProgress = () => {} } = {}) => {
    let records;
    try {
      records = await accessDB("readonly", store => store.getAll());
    } catch (_) {
      return false;
    }
    const wanted = priority ? new Set(priority) : null,
      first = wanted ? records.filter(record => wanted.has(record.id)) : records,
      rest = wanted ? records.filter(record => !wanted.has(record.id)) : [];
    for (const record of first) await restoreOne(record);
    restoring = (async () => {
      let done = 0;
      for (const record of rest) {
        if (disposed) return;
        // 한 장씩 다음 작업으로 미뤄 화면 그리기·입력을 막지 않는다.
        await new Promise(resolve => setTimeout(resolve, 0));
        await restoreOne(record);
        onProgress({ done: ++done, total: rest.length, failed: [...failed] });
      }
    })();
    return true;
  };
  const whenRestored = () => restoring;
  const failedIds = () => [...failed];
  const remove = async id => {
    const entry = library.get(id);
    if (!entry) return false;
    library.delete(id);
    if (!lost && entry.tex) gl.deleteTexture(entry.tex);
    entry.bitmap.close();
    try {
      await persist(store => store.delete(id));
    } catch (error) {
      console.warn("Texture 저장 삭제 실패:", error);
    }
    return true;
  };
  const get = id => library.get(id) || null;
  const list = () =>
    [...library.values()].map(({ id, name, width, height, sampling }) => ({
      id,
      name,
      width,
      height,
      sampling: { ...sampling },
    }));
  const setSampling = async (id, change) => {
    const entry = get(id);
    if (!entry || lost || !entry.tex) throw new Error("Texture 설정을 변경할 수 없습니다.");
    const next = normalize({ ...entry.sampling, ...change }),
      old = entry.sampling;
    const bound = gl.getParameter(gl.TEXTURE_BINDING_2D);
    clearErrors();
    try {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      applyParams(next);
      if (gl.getError() !== gl.NO_ERROR) {
        applyParams(old);
        throw new Error("Texture 샘플링 적용 실패");
      }
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, bound);
    }
    entry.sampling = next;
    try {
      await persist(store => store.put({ id, name: entry.name, blob: entry.file, sampling: next }));
      return { saved: true };
    } catch (error) {
      return { saved: false, error: error.message };
    }
  };
  const onLost = (release = false) => {
    for (const item of library.values()) {
      if (release && !lost && item.tex) gl.deleteTexture(item.tex);
      item.tex = null;
    }
    lost = true;
  };
  const restore = () => {
    if (disposed) throw new Error("이미 폐기된 Texture 저장소입니다.");
    lost = false;
    const done = [];
    try {
      for (const item of library.values()) {
        item.tex = upload(item.bitmap, item.sampling);
        done.push(item);
      }
    } catch (error) {
      for (const item of done) {
        if (item.tex) gl.deleteTexture(item.tex);
        item.tex = null;
      }
      throw error;
    }
  };
  const dispose = () => {
    disposed = true;
    for (const item of library.values()) {
      if (!lost && item.tex) gl.deleteTexture(item.tex);
      item.bitmap.close();
    }
    library.clear();
  };
  return { add, remove, restoreSaved, whenRestored, failedIds, setSampling, get, list, onLost, restore, dispose };
};
export { createTextureInput };
