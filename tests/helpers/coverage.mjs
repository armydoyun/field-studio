// 브라우저 묶음 코드 커버리지(node tests/run.mjs browser --coverage).
// 테스트마다 Chromium(V8)의 블록 커버리지를 받아 js/ 파일별로 합친다: 어느 테스트에서든 한 번 실행된 글자는 '지나감'.
// 결과는 test-results/coverage/summary.txt(파일별 비율 · 한 번도 안 불린 함수)와 coverage.json에 남긴다.
// 목적은 '어느 기능이 브라우저 테스트로 확인되지 않는가'를 찾는 것이라, 줄 단위가 아니라 글자 · 함수 단위로만 센다.
import fs from "node:fs";
import path from "node:path";

const covered = new Map();   // 파일 → {source, hit:Uint8Array(글자마다 1=실행), functions:Map(이름@위치 → 실행 여부)}

// V8 블록 커버리지: 한 함수의 범위들은 바깥 → 안쪽 순서이고, 안쪽 범위의 횟수가 바깥을 덮는다.
// 그래서 범위를 넓은 것부터 칠하면 마지막에 칠한 값이 그 글자의 실제 횟수가 된다.
export const addCoverage = (entries, base) => {
  for (const entry of entries) {
    if (!entry.url.startsWith(base)) continue;
    const file = decodeURIComponent(new URL(entry.url).pathname).replace(/^\//, "");
    if (!/^js\/.+\.js$/.test(file) || file === "js/codemirror.js") continue;
    const source = entry.source || "";
    const state = covered.get(file) || { source, hit: new Uint8Array(source.length), functions: new Map() };
    const mark = new Uint8Array(source.length);
    const ranges = entry.functions.flatMap(fn => fn.ranges).sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
    for (const range of ranges) mark.fill(range.count > 0 ? 1 : 0, range.startOffset, range.endOffset);
    for (let i = 0; i < mark.length; i++) if (mark[i]) state.hit[i] = 1;
    for (const fn of entry.functions) {
      const [range] = fn.ranges;
      if (!fn.functionName || !range) continue;
      const key = `${fn.functionName}@${range.startOffset}`;
      state.functions.set(key, state.functions.get(key) || range.count > 0);
    }
    covered.set(file, state);
  }
};

const lineOf = (source, offset) => source.slice(0, offset).split("\n").length;

export const writeCoverage = (root, allFiles) => {
  if (!covered.size) return null;
  const directory = path.join(root, "test-results", "coverage");
  fs.mkdirSync(directory, { recursive: true });
  const rows = allFiles.map(file => {
    const state = covered.get(file);
    if (!state) return { file, percent: 0, loaded: false, unused: [] };
    // 공백 · 주석까지 세면 비율이 흐려지지만, 파일끼리 비교하는 데에는 충분하다.
    const hit = state.hit.reduce((sum, value) => sum + value, 0);
    const unused = [...state.functions].filter(([, ran]) => !ran).map(([key]) => {
      const [name, offset] = key.split("@");
      return `${name}:${lineOf(state.source, Number(offset))}`;
    });
    return { file, percent: Math.round((hit / Math.max(1, state.source.length)) * 1000) / 10, loaded: true, unused };
  }).sort((a, b) => a.percent - b.percent);
  const text = [
    "브라우저 묶음 커버리지(글자 단위, 낮은 순)",
    ...rows.map(row => `${String(row.percent).padStart(5)}%  ${row.file}${row.loaded ? "" : "  (불러오지 않음)"}${row.unused.length ? `  · 안 불린 함수 ${row.unused.length}개` : ""}`),
    "",
    "한 번도 안 불린 이름 있는 함수",
    ...rows.filter(row => row.unused.length).flatMap(row => [`${row.file}`, ...row.unused.map(name => `  ${name}`)]),
  ].join("\n");
  fs.writeFileSync(path.join(directory, "summary.txt"), `${text}\n`);
  fs.writeFileSync(path.join(directory, "coverage.json"), JSON.stringify(rows, null, 2));
  return { directory, rows };
};
