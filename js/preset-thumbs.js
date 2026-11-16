// 프리셋 썸네일: 값 묶음 → 그 값으로 그린 작은 그림. 프리셋 칩에 붙여 이름만 보고 고르던 것을 눈으로 고르게 한다.
// 그림은 프리셋 데이터와 따로 브라우저 저장소에 둔다 — 프리셋 · Pack 형식과 되돌리기 기록은 그대로다
// (프리셋 안에 넣으면 썸네일만 바뀌어도 되돌리기 한 칸이 생겨 Ctrl+Z가 눈에 안 보이는 변화를 먼저 되돌렸다).
// 찍는 때: 저장 · 덮어쓰기(화면이 바로 그 값) · 적용을 마친 뒤(코드를 고친 뒤에도 최근 모습으로). 다른 장면을 따로 그리지 않고
// 렌더러가 그린 직후 프레임(onFrame)을 줄여 찍으므로 화면이 깜빡이지 않는다.
//   create({ renderer }) → { get(values) → data URL | null, remember(values) → Promise<data URL | null>, keyOf(values) }
import * as Store from "./storage.js";

const KEY = "field.preset-thumbs.v1";
const LIMIT = 64; // 저장해 둘 그림 수(오래 쓰지 않은 것부터 지운다). 한 장 약 2~6KB
const WIDTH = 72,
  HEIGHT = 40;

// 값 묶음의 열쇠: 이름순으로 정렬한 값의 짧은 해시(FNV-1a). 이름을 바꿔도 값이 같으면 같은 그림을 쓴다.
const keyOf = values => {
  const text = JSON.stringify(
    Object.keys(values || {})
      .sort()
      .map(name => [name, values[name]])
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(36) + text.length.toString(36);
};
const DATA_URL = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;

const create = ({ renderer, onChange = () => {} } = {}) => {
  const read = () => {
    const saved = Store.readJSON(KEY, []);
    return Array.isArray(saved)
      ? saved.filter(entry => Array.isArray(entry) && typeof entry[0] === "string" && DATA_URL.test(entry[1]))
      : [];
  };
  let entries = read(); // [[열쇠, 그림, 마지막으로 쓴 때]]
  const get = values => entries.find(entry => entry[0] === keyOf(values))?.[1] || null;
  const put = (values, url) => {
    const key = keyOf(values);
    entries = [[key, url, Date.now()], ...entries.filter(entry => entry[0] !== key)].slice(0, LIMIT);
    Store.writeJSON(KEY, entries);
    onChange();
  };
  // 다음에 그려지는 프레임을 작게 찍는다(가운데를 채워 자른다). 멈춰 있으면 한 번 그리게 한다. 1.5초 안에 못 찍으면 null.
  const capture = () =>
    new Promise(resolve => {
      if (typeof renderer?.onFrame !== "function" || typeof document === "undefined") return resolve(null);
      let done = false;
      const finish = url => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        resolve(url);
      };
      const off = renderer.onFrame(canvas => {
        try {
          const out = document.createElement("canvas");
          out.width = WIDTH;
          out.height = HEIGHT;
          const ctx = out.getContext("2d");
          const scale = Math.max(WIDTH / canvas.width, HEIGHT / canvas.height),
            w = WIDTH / scale,
            h = HEIGHT / scale;
          ctx.drawImage(canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h, 0, 0, WIDTH, HEIGHT);
          const url = out.toDataURL("image/webp", 0.75);
          finish(DATA_URL.test(url) ? url : null);
        } catch (_) {
          finish(null);
        }
      });
      const timer = setTimeout(() => finish(null), 1500);
      renderer.redraw?.();
    });
  const remember = async values => {
    const url = await capture();
    if (url) put(values, url);
    return url;
  };
  return { get, remember, keyOf };
};

export { create, keyOf };
