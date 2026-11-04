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

export { read, readJSON, write, writeJSON, remove };
