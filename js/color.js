// 색 변환(순수 함수). 셰이더 색은 0~1 실수 [r, g, b(, a)], 화면 · 색상 선택기는 #rrggbb · rgb()를 쓴다.
//   toHex([r, g, b]) → "#rrggbb"(0~1 밖은 잘라 낸다) · fromHex("#rrggbb") → [r, g, b](0~1)
//   cssRgb([r, g, b, a?]) → "rgb(R G B / a)"(알파가 있으면 붙인다)
const channel = v => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
const toHex = values =>
  "#" +
  values
    .slice(0, 3)
    .map(v => channel(v).toString(16).padStart(2, "0"))
    .join("");
const fromHex = hex => (String(hex).match(/[0-9a-f]{2}/gi) || []).slice(0, 3).map(h => parseInt(h, 16) / 255);
const cssRgb = values =>
  `rgb(${values.slice(0, 3).map(channel).join(" ")}${values.length > 3 ? ` / ${values[3]}` : ""})`;

export { toHex, fromHex, cssRgb };
