// 줄 단위 비교(Myers 알고리즘 — 바뀐 줄 수에 비례해 빠르다, 순수 함수). 버전 기록(version-history.js)의 '비교'가 쓴다.
//   diff(before, after) → [{ type: "same" | "del" | "add", text }]
//   hunks(ops, context = 2) → 바뀐 곳만 앞뒤 context줄과 묶은 [{ ops, beforeLine, afterLine }] (줄 번호는 1부터)
// 아주 큰 변경(편집 거리가 limit · 메모리 상한을 넘음)은 줄 단위 맞춤을 포기하고 전부 지움 + 전부 넣음으로 돌려준다(멈추지 않게).

const diff = (before, after, { limit = 4000 } = {}) => {
  const a = before.split("\n"),
    b = after.split("\n");
  // 앞뒤 같은 줄은 미리 떼어 낸다
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map(text => ({ type: "same", text })),
    tail = a.slice(endA).map(text => ({ type: "same", text }));
  const x = a.slice(start, endA),
    y = b.slice(start, endB),
    n = x.length,
    m = y.length,
    max = n + m;
  if (!n || !m || max === 0)
    return [...head, ...x.map(text => ({ type: "del", text })), ...y.map(text => ({ type: "add", text })), ...tail];
  const offset = max,
    v = new Int32Array(2 * max + 2),
    trace = [];
  let found = -1;
  // 단계마다 v를 복사해 두므로, 메모리가 약 16MB(정수 4백만 개)를 넘지 않게 단계 수를 줄인다
  const steps = Math.min(max, limit, Math.floor(4e6 / v.length));
  for (let d = 0; d <= steps; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let i =
          k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1,
        j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      v[offset + k] = i;
      if (i >= n && j >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0)
    return [...head, ...x.map(text => ({ type: "del", text })), ...y.map(text => ({ type: "add", text })), ...tail];
  // 되짚어 가며 연산을 모은다
  const ops = [];
  let i = n,
    j = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d],
      k = i - j,
      down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]),
      prevK = down ? k + 1 : k - 1,
      prevI = prev[offset + prevK],
      prevJ = prevI - prevK;
    while (i > prevI && j > prevJ) ops.push({ type: "same", text: x[--i] }) && j--;
    if (down) ops.push({ type: "add", text: y[--j] });
    else ops.push({ type: "del", text: x[--i] });
  }
  while (i > 0 && j > 0) ops.push({ type: "same", text: x[--i] }) && j--;
  return [...head, ...ops.reverse(), ...tail];
};

const hunks = (ops, context = 2) => {
  // 바뀐 줄마다 앞뒤 context줄을 표시하고, 이어진 표시를 한 묶음으로
  const keep = new Uint8Array(ops.length);
  ops.forEach((op, index) => {
    if (op.type === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep[k] = 1;
  });
  const out = [];
  let beforeLine = 1,
    afterLine = 1,
    current = null;
  ops.forEach((op, index) => {
    if (keep[index]) {
      if (!current) {
        current = { ops: [], beforeLine, afterLine };
        out.push(current);
      }
      current.ops.push(op);
    } else current = null;
    if (op.type !== "add") beforeLine++;
    if (op.type !== "del") afterLine++;
  });
  return out;
};

export { diff, hunks };
