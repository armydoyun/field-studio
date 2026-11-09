// localStorage 창구. 저장소가 막힌 브라우저(사생활 보호 창, 용량 초과, file:// 정책)에서도 앱이 멈추지 않게 하되,
// 실패를 조용히 삼키지 않는다: write()는 실패한 오류를 돌려주고 콘솔에 경고를 남긴다. 읽기 실패는 '저장된 값 없음'과 같게 다룬다.

const read = key => {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
};
// JSON 값을 읽는다. 없거나 깨졌으면 fallback.
const readJSON = (key, fallback = null) => {
  const raw = read(key);
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
};
// 성공하면 null, 실패하면 오류 객체를 돌려준다.
const write = (key, value) => {
  try {
    localStorage.setItem(key, value);
    return null;
  } catch (error) {
    console.warn(`브라우저 저장 실패 (${key}):`, error);
    return error;
  }
};
const writeJSON = (key, value) => write(key, JSON.stringify(value));
const remove = key => {
  try {
    localStorage.removeItem(key);
  } catch (_) {
    /* 지울 수 없으면 다음 읽기도 실패하므로 그대로 둔다. */
  }
};

// 탭(창)마다 따로 기억하는 값: sessionStorage는 탭마다 따로이고 새로 고침해도 남는다. 같은 값을 localStorage에도 써 두어
// 새 탭·브라우저 재시작 때는 마지막으로 쓴 탭의 값으로 시작한다. 여러 탭이 서로의 작업 복구본·작업 중 프로젝트를 덮어쓰지 않게 한다.
const session = () => {
  try {
    return globalThis.sessionStorage || null;
  } catch (_) {
    return null;
  }
};
const readTab = key => {
  try {
    const value = session()?.getItem(key);
    if (value !== null && value !== undefined) return value;
  } catch (_) {
    /* 탭 저장소를 못 읽으면 공용 값을 쓴다. */
  }
  return read(key);
};
const readTabJSON = (key, fallback = null) => {
  const raw = readTab(key);
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
};
// 공용(localStorage) 쓰기의 결과를 돌려준다. 탭 저장소 실패는 공용 값이 대신하므로 무시한다.
const writeTab = (key, value) => {
  try {
    session()?.setItem(key, value);
  } catch (_) {
    /* 공용 값이 대신한다. */
  }
  return write(key, value);
};
const writeTabJSON = (key, value) => writeTab(key, JSON.stringify(value));
// 공용 값은 이 탭이 마지막으로 쓴 것일 때만 지운다(다른 탭의 복구본을 지우지 않게).
const removeTab = key => {
  let mine = null;
  try {
    const store = session();
    mine = store ? store.getItem(key) : null;
    store?.removeItem(key);
  } catch (_) {
    mine = null;
  }
  const shared = read(key);
  if (shared !== null && (mine === null || shared === mine)) remove(key);
};

export { read, readJSON, write, writeJSON, remove, readTab, readTabJSON, writeTab, writeTabJSON, removeTab };
