// 키프레임 타임라인 도크: 화면 아래(미리보기 밑) 넓은 띠에서 파라미터 연결(links.js) 중 '키프레임'을 다듬는다.
//  위 막대: 재생 · 처음으로 · 재생 위치(초) | 스냅 · 축소 · 확대 · 맞춤 · + 파라미터 | 선택한 키(시간 · 값 · 잇기 · 지우기) | 닫기
//  눈금: 누르거나 끌면 재생 위치 이동 · Ctrl+휠 확대(커서 기준) · Shift+휠(또는 가로 휠) 이동
//  레인(키프레임 연결마다): 이름 · 값 범위 | 값 곡선 + 키 점 + 반복 표시(끌어서 반복 길이, 더블클릭으로 없앰)
//  키: 누르기 = 고르기(Shift: 더하기/빼기) · 빈 곳 끌기 = 상자 선택 · 끌기 = 고른 키 함께 옮기기(Shift: 한 축만, Alt: 스냅 끔)
//      빈 곳 더블클릭 = 그 자리에 키 · 키 더블클릭 = 지우기
//  키보드(도크 안): ←/→ 스냅 한 칸(Shift ×10) · ↑/↓ 값 범위의 1/100(Shift 1/10) · Delete 지우기 · Ctrl+A 모두 고르기
//      Ctrl+C / Ctrl+V(재생 위치에 붙여넣기) · Ctrl+Z / Ctrl+Shift+Z(Ctrl+Y) 되돌리기 · Esc 선택 해제
// 스냅: 격자(0.01 ~ 1초 · 30/60fps 프레임) + 재생선 · 다른 키에 6px 안이면 붙는다.
// 끄는 동안은 렌더러에만 적용하고 놓을 때 settings.setLinks로 저장한다(자동 저장 · Pack · 되돌리기 한 칸).
// 열림 · 높이 · 스냅은 이 브라우저에 기억한다(field.timeline.v1).
import * as Links from "./links.js";
import * as Store from "./storage.js";
import * as UI from "./ui-kit.js";

const KEY = "field.timeline.v1";
const EPS = 5e-4;
const SNAPS = [
  ["0", "끔"],
  ["0.01", "0.01초"],
  ["0.05", "0.05초"],
  ["0.1", "0.1초"],
  ["0.25", "0.25초"],
  ["0.5", "0.5초"],
  ["1", "1초"],
  ["f30", "1/30초"],
  ["f60", "1/60초"],
];
const EASE_LABEL = { smooth: "부드럽게", linear: "직선", step: "계단", in: "천천히 시작", out: "천천히 끝" };
const TICKS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const HEAD = 132; // 레인 이름 칸 너비(px) — CSS --timeline-head로 넘긴다

const mount = ({ renderer, settings, root, studio = () => window.shaderStudio }) => {
  if (!root?.addEventListener || !root.replaceChildren)
    return { render: () => {}, open: () => {}, close: () => {}, bindToggle: () => {}, dispose: () => {} };
  const controller = new AbortController(),
    signal = controller.signal;
  const on = (node, type, handler, options = {}) => node.addEventListener(type, handler, { ...options, signal });
  const element = UI.el;
  const svg = tag => document.createElementNS("http://www.w3.org/2000/svg", tag);
  const round = (value, digits = 3) => Number(Number(value).toFixed(digits));
  const button = (className, label, text = "", title = label) => {
    const node = element("button", className, text);
    node.type = "button";
    node.setAttribute("aria-label", label);
    node.title = title;
    return node;
  };
  const attempt = fn => {
    try {
      return fn();
    } catch (error) {
      console.warn(error);
      return null;
    }
  };
  const capture = (node, event) => {
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      // 합성 이벤트처럼 활성 포인터가 아니면 붙잡지 않는다
    }
  };

  // ---- 저장한 설정 ----
  const saved = Store.readJSON(KEY, {}) || {};
  let height = Number.isFinite(saved.height) ? saved.height : 220,
    snapChoice = SNAPS.some(([v]) => v === saved.snap) ? saved.snap : "0.05";
  const remember = () => Store.writeJSON(KEY, { open: !root.hidden, height, snap: snapChoice });

  // ---- 뼈대 ----
  const resize = element("div", "ui-resizer timeline-resize");
  resize.setAttribute("role", "separator");
  resize.setAttribute("aria-orientation", "horizontal");
  resize.setAttribute("aria-label", "타임라인 높이 조절");
  resize.tabIndex = 0;
  resize.title = "끌어서 높이 조절 · 끝까지 줄여 놓으면 타임라인 숨기기 · ↑↓ · Home/End · 두 번 눌러 기본 높이";
  const bar = element("header", "ui-dense timeline-bar"),
    play = button("ui-btn--sm timeline-play glyph-icon icon-play", "재생"),
    start = button("ui-btn--sm timeline-start glyph-icon icon-reset", "처음으로", "", "재생 위치를 0초로"),
    timeField = element("input", "timeline-time"),
    snapSelect = element("select", "timeline-snap"),
    speedSelect = element("select", "timeline-speed"),
    zoomOut = button("ui-btn--sm timeline-zoom", "축소", "−"),
    zoomIn = button("ui-btn--sm timeline-zoom", "확대", "+"),
    fit = button("ui-btn--sm timeline-fit", "모든 키가 보이게 맞춤", "맞춤"),
    addSelect = element("select", "timeline-add"),
    inspector = element("div", "timeline-inspector"),
    selection = element("span", "timeline-selection"),
    keyTime = element("input", "timeline-key-time"),
    keyValue = element("input", "timeline-key-value"),
    keyEase = element("select", "timeline-key-ease"),
    keyDelete = button("ui-btn--sm timeline-key-delete", "선택한 키 지우기", "지우기", "선택한 키 지우기 (Delete)"),
    close = button("ui-icon-btn ui-icon-btn--sm timeline-close glyph-icon icon-close", "타임라인 닫기");
  timeField.type = "number";
  timeField.min = "0";
  timeField.step = "0.01";
  timeField.setAttribute("aria-label", "재생 위치(초)");
  timeField.title = "재생 위치(uTime) · Enter로 이동";
  for (const [value, text] of SNAPS) {
    const option = element("option", "", text);
    option.value = value;
    if (value.startsWith("f")) option.title = `프레임 단위(${value.slice(1)}fps)`;
    snapSelect.append(option);
  }
  snapSelect.value = snapChoice;
  // 재생 속도: 타임라인을 재생 조작의 한 곳으로 모은다(설정 패널 렌더링 탭의 배속 버튼과 같은 값 · 같은 저장).
  for (const value of ["0.25", "0.5", "1", "2"]) {
    const option = element("option", "", `${value}×`);
    option.value = value;
    speedSelect.append(option);
  }
  speedSelect.setAttribute("aria-label", "재생 속도");
  speedSelect.title = "재생 속도(uTime이 흐르는 빠르기) · 설정 패널 렌더링 탭과 같은 값";
  snapSelect.setAttribute("aria-label", "스냅");
  snapSelect.title = "키를 끌거나 방향키로 옮길 때 맞출 간격 · 재생선 · 다른 키에도 붙는다(Alt를 누르고 끌면 끔)";
  addSelect.setAttribute("aria-label", "키프레임 레인 추가");
  keyTime.type = "number";
  keyTime.min = "0";
  keyTime.step = "0.001";
  keyTime.setAttribute("aria-label", "선택한 키 시간(초)");
  keyValue.type = "number";
  keyValue.step = "any";
  keyValue.setAttribute("aria-label", "선택한 키 값");
  keyEase.setAttribute("aria-label", "선택한 키에서 다음 키까지 잇기");
  for (const [value, text] of [["", "기본"], ...Object.entries(EASE_LABEL)]) {
    const option = element("option", "", text);
    option.value = value;
    keyEase.append(option);
  }
  // 고른 키들의 잇기가 서로 다를 때만 보이는 상태 표시(고를 수는 없다). 다른 항목을 고르면 모두 그 방식이 된다.
  const mixed = element("option", "", "서로 다름");
  mixed.value = "*";
  mixed.disabled = true;
  mixed.hidden = true;
  keyEase.append(mixed);
  const labelled = (text, control, unit = "") => {
    const label = element("label", "timeline-field");
    if (text) label.append(element("span", "timeline-unit", text));
    label.append(control);
    if (unit) label.append(element("span", "timeline-unit", unit));
    return label;
  };
  const group = (...nodes) => {
    const node = element("div", "timeline-group");
    node.append(...nodes);
    return node;
  };
  // 붙은 버튼 쌍(▶ ⟲ · − +)
  const joined = (...nodes) => {
    const node = element("span", "ui-btn-group");
    node.append(...nodes);
    return node;
  };
  inspector.setAttribute("role", "group");
  inspector.setAttribute("aria-label", "선택한 키");
  inspector.append(
    selection,
    labelled("시간", keyTime, "초"),
    labelled("값", keyValue),
    labelled("잇기", keyEase),
    keyDelete
  );
  bar.append(
    group(joined(play, start), labelled("", timeField, "초"), speedSelect),
    group(labelled("스냅", snapSelect), joined(zoomOut, zoomIn), fit),
    inspector,
    close
  );
  const body = element("div", "timeline-body"),
    track = element("div", "timeline-track");
  body.tabIndex = 0;
  body.setAttribute("aria-label", "키프레임 레인 · 방향키로 고른 키 옮기기");
  body.append(track);
  root.replaceChildren(resize, bar, body);
  root.style.setProperty("--timeline-head", `${HEAD}px`);

  // ---- 상태 ----
  let view = { start: 0, end: 10 },
    viewTouched = false,
    selected = [], // [{ name, t }]
    clipboard = [], // [{ name, dt, v, ease }]
    drag = null,
    frame = 0,
    shape = "",
    frames = 0;
  let ruler = null,
    playhead = null,
    edge = null;
  const lanes = new Map(); // 이름 → { area, plot, path, low, high, item, link, dots: [] }

  const links = () => settings.getLinks?.() || [];
  const keyLinks = () => links().filter(link => link.source === "keys");
  const users = () => renderer.getUserUniforms();
  const now = () => renderer.getStats().time ?? 0;
  const linkOf = name => links().find(link => link.name === name);
  const span = () => view.end - view.start;
  const sortKeys = keys => [...keys].sort((a, b) => a[0] - b[0]);
  const local = (link, t) => (link?.loop > 0 ? round(((t % link.loop) + link.loop) % link.loop) : round(t));
  const save = updates => {
    // updates: Map 이름 → 바뀐 연결
    settings.setLinks(links().map(link => updates.get(link.name) || link));
    renderer.redraw?.();
  };
  const preview = updates => {
    renderer.setLinks(links().map(link => updates.get(link.name) || link));
    renderer.redraw?.();
  };
  const isSelected = (name, t) => selected.some(s => s.name === name && Math.abs(s.t - t) < EPS);
  const shapeOf = () =>
    users()
      .map(item => `${item.name}:${item.type}`)
      .join();

  // 레인 값 범위: 슬라이더 범위(bool은 0~1)와 키 값을 감싼다. 범위가 없으면 키 값 ± 여유
  const rangeOf = (item, keys) => {
    const values = keys.map(k => k[1]);
    if (item?.type === "bool") return [0, 1];
    const { min, max } = item?.options || {};
    if (Number.isFinite(min) && Number.isFinite(max) && min < max)
      return [Math.min(min, ...values), Math.max(max, ...values)];
    let low = Math.min(...values),
      high = Math.max(...values);
    if (!(high > low)) [low, high] = [low - 1, high + 1];
    const pad = (high - low) * 0.1;
    return [low - pad, high + pad];
  };
  const fitView = () => {
    let end = 5;
    for (const link of keyLinks()) end = Math.max(end, link.loop || 0, ...link.keys.map(k => k[0] * 1.1 + 0.2));
    view = { start: 0, end: Math.min(3600, Math.ceil(end)) };
  };
  const fitValue = (item, value) => {
    if (item?.type === "bool") return value >= 0.5 ? 1 : 0;
    if (item?.type === "int" || item?.type === "uint")
      return Math.max(item.type === "uint" ? 0 : -2147483648, Math.round(value));
    return round(value, 4);
  };
  const snapStep = () => (snapChoice === "f30" ? 1 / 30 : snapChoice === "f60" ? 1 / 60 : Number(snapChoice) || 0);
  const nudgeStep = () => snapStep() || 0.1;
  // 시간 맞추기: 격자 + 재생선 · 다른 키(6px 안). exclude(name, t)가 참인 키는 대상에서 뺀다.
  const snapTime = (t, width, exclude = () => false) => {
    const step = snapStep(),
      pixel = span() / Math.max(1, width);
    let best = step ? Math.round(t / step) * step : t;
    const magnets = [now()];
    for (const link of keyLinks()) for (const [k] of link.keys) if (!exclude(link.name, k)) magnets.push(k);
    for (const m of magnets) if (Math.abs(m - t) <= pixel * 6 && Math.abs(m - t) < Math.abs(best - t)) best = m;
    return Math.max(0, round(best));
  };
  const xOf = t => `${((t - view.start) / span()) * 100}%`;
  const timeAt = (clientX, node) => {
    const rect = node.getBoundingClientRect();
    return view.start + ((clientX - rect.left) / Math.max(1, rect.width)) * span();
  };
  const valueAt = (clientY, info) => {
    const rect = info.plot.getBoundingClientRect(),
      unit = 1 - Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)));
    return info.low + (info.high - info.low) * unit;
  };
  const yOf = (v, info) => `${100 - Math.min(100, Math.max(0, ((v - info.low) / (info.high - info.low || 1)) * 100))}%`;

  // ---- 그리기 ----
  const curveOf = (link, info) => {
    const steps = 240,
      points = [];
    for (let i = 0; i <= steps; i++) {
      const t = view.start + (i / steps) * span(),
        v = Links.keyValue(link.keys, t, link.loop, link.ease);
      if (v === null) continue;
      const y = 100 - ((v - info.low) / (info.high - info.low || 1)) * 100;
      points.push(`${points.length ? "L" : "M"}${(i / steps) * 1000} ${Math.min(102, Math.max(-2, y)).toFixed(2)}`);
    }
    return points.join(" ");
  };
  const renderRuler = () => {
    ruler = element("div", "timeline-ruler");
    ruler.setAttribute("role", "slider");
    ruler.tabIndex = -1;
    ruler.setAttribute("aria-label", "재생 위치");
    const width = Math.max(200, (track.clientWidth || 800) - HEAD),
      major = TICKS.find(step => (step / span()) * width >= 70) || TICKS.at(-1),
      minor = major / 5;
    for (let i = Math.ceil(view.start / minor); i * minor <= view.end + 1e-9; i++) {
      const t = i * minor,
        isMajor = i % 5 === 0,
        tick = element("span", isMajor ? "timeline-tick is-major" : "timeline-tick");
      tick.style.left = xOf(t);
      if (isMajor) tick.textContent = `${round(t, 2)}`;
      ruler.append(tick);
    }
    const seek = event => attempt(() => renderer.setTime(Math.max(0, round(timeAt(event.clientX, ruler)))));
    on(ruler, "pointerdown", event => {
      event.preventDefault();
      capture(ruler, event);
      seek(event);
      const move = e => seek(e),
        up = () => {
          ruler.removeEventListener("pointermove", move);
          ruler.removeEventListener("pointerup", up);
        };
      ruler.addEventListener("pointermove", move);
      ruler.addEventListener("pointerup", up);
    });
    return ruler;
  };
  const renderLane = (link, item) => {
    const [low, high] = rangeOf(item, link.keys),
      lane = element("div", "timeline-lane"),
      head = element("div", "timeline-lane-head"),
      name = element("span", "timeline-lane-name", link.name),
      range = element("span", "timeline-lane-range", `${round(low, 3)} ~ ${round(high, 3)}`),
      remove = button(
        "ui-icon-btn ui-icon-btn--xs timeline-lane-remove glyph-icon icon-close",
        `${link.name} 키프레임 연결 지우기`
      ),
      area = element("div", "timeline-area"),
      plot = element("div", "timeline-plot"),
      graph = svg("svg"),
      mid = svg("line"),
      path = svg("path");
    lane.dataset.name = link.name;
    remove.title = "이 파라미터의 키프레임 연결 지우기(값은 지금 값으로 남는다)";
    on(remove, "click", () => settings.setLinks(links().filter(l => l.name !== link.name)));
    // 시간 기준: '한 번'(키 시간 = 재생 시간, 마지막 키 뒤로는 그 값 유지) · '↻ N초'(N초 길이로 되풀이)
    const mode = element(
      "span",
      link.loop > 0 ? "ui-tag timeline-lane-mode is-loop" : "ui-tag timeline-lane-mode",
      link.loop > 0 ? `↻ ${round(link.loop, 2)}초마다 반복` : "한 번 · 끝 값 유지"
    );
    mode.title =
      link.loop > 0
        ? `재생 시간을 ${round(link.loop, 2)}초 길이로 잘라 0 ~ ${round(link.loop, 2)}초의 키를 되풀이합니다. 흐린 키는 되풀이되는 모습(고칠 때는 첫 바퀴의 진한 키를)`
        : "키의 시간 = 재생 시간(uTime). 마지막 키 뒤로는 그 값을 유지합니다";
    head.append(name, remove, mode, range);
    graph.setAttribute("viewBox", "0 0 1000 100");
    graph.setAttribute("preserveAspectRatio", "none");
    graph.setAttribute("aria-hidden", "true");
    graph.classList.add("timeline-curve");
    for (const [k, v] of Object.entries({ x1: 0, x2: 1000, y1: 50, y2: 50 })) mid.setAttribute(k, String(v));
    mid.classList.add("timeline-midline");
    mid.setAttribute("vector-effect", "non-scaling-stroke");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    graph.append(mid, path);
    plot.append(graph);
    area.append(plot);
    const info = { lane, area, plot, path, low, high, item, link, dots: [] };
    lanes.set(link.name, info);
    path.setAttribute("d", curveOf(link, info));
    // 반복: 그 뒤는 흐리게, 표시를 끌어 길이를 바꾸고 더블클릭으로 없앤다
    if (link.loop > 0) {
      const shade = element("div", "timeline-loop-shade"),
        marker = button("timeline-loop", `${link.name} 반복 길이 ${round(link.loop, 3)}초`);
      shade.style.left = xOf(link.loop);
      marker.style.left = xOf(link.loop);
      marker.title = `${round(link.loop, 3)}초마다 반복 — 끌어서 길이 바꾸기 · 더블클릭으로 반복 없애기`;
      on(marker, "pointerdown", event => {
        event.preventDefault();
        event.stopPropagation();
        capture(marker, event);
        let loop = link.loop;
        const move = e => {
          loop = Math.max(0.05, snapTime(timeAt(e.clientX, area), area.clientWidth));
          marker.style.left = shade.style.left = xOf(loop);
          preview(new Map([[link.name, { ...link, loop }]]));
        };
        const up = () => {
          marker.removeEventListener("pointermove", move);
          marker.removeEventListener("pointerup", up);
          if (loop !== link.loop) save(new Map([[link.name, { ...link, loop }]]));
        };
        marker.addEventListener("pointermove", move);
        marker.addEventListener("pointerup", up);
      });
      on(marker, "dblclick", event => {
        event.stopPropagation();
        save(new Map([[link.name, { ...link, loop: 0 }]]));
      });
      area.append(shade, marker);
      // 되풀이되는 바퀴: 경계선과 흐린 키(누를 수 없음) — 이 키들이 반복 길이마다 다시 지나간다는 것을 보인다
      for (let cycle = 1; cycle * link.loop < view.end && cycle < 200; cycle++) {
        const offset = cycle * link.loop;
        if (cycle > 1 && offset >= view.start) {
          const edge = element("span", "timeline-cycle");
          edge.style.left = xOf(offset);
          area.append(edge);
        }
        for (const ghostKey of link.keys) {
          const t = ghostKey[0] + offset;
          if (ghostKey[0] >= link.loop || t < view.start || t > view.end) continue;
          const ghost = element("span", "timeline-ghost");
          ghost.style.left = xOf(t);
          ghost.style.top = yOf(ghostKey[1], info);
          ghost.setAttribute("aria-hidden", "true");
          plot.append(ghost);
        }
      }
    }
    link.keys.forEach((key, index) => {
      const dot = element("span", "timeline-key");
      dot.dataset.index = String(index);
      dot.style.left = xOf(key[0]);
      dot.style.top = yOf(key[1], info);
      dot.title = `${round(key[0], 3)}초 · ${round(key[1], 4)}${key[2] ? ` · ${EASE_LABEL[key[2]]}` : ""}`;
      if (key[2] === "step") dot.classList.add("is-step");
      if (isSelected(link.name, key[0])) dot.classList.add("is-selected");
      on(dot, "pointerdown", event => startKeyDrag(event, link.name, index));
      on(dot, "dblclick", event => {
        event.stopPropagation();
        selected = selected.filter(s => !(s.name === link.name && Math.abs(s.t - key[0]) < EPS));
        save(new Map([[link.name, { ...link, keys: link.keys.filter((_, i) => i !== index) }]]));
      });
      plot.append(dot);
      info.dots.push(dot);
    });
    on(area, "pointerdown", event => {
      if (event.target.closest(".timeline-key, .timeline-loop")) return;
      startBox(event);
    });
    on(area, "dblclick", event => {
      if (event.target.closest(".timeline-key, .timeline-loop")) return;
      const raw = timeAt(event.clientX, area),
        t = local(link, event.altKey ? round(raw) : snapTime(raw, area.clientWidth)),
        v = fitValue(item, valueAt(event.clientY, info));
      selected = [{ name: link.name, t }];
      save(
        new Map([
          [link.name, { ...link, keys: sortKeys([...link.keys.filter(([k]) => Math.abs(k - t) > EPS), [t, v]]) }],
        ])
      );
      body.focus({ preventScroll: true });
    });
    lane.append(head, area);
    return lane;
  };

  const render = () => {
    if (drag || root.hidden) return;
    if (!viewTouched) fitView();
    const items = new Map(users().map(item => [item.name, item]));
    const list = keyLinks().filter(link => items.has(link.name));
    shape = shapeOf();
    // 없어진 키는 선택에서 뺀다
    selected = selected.filter(s =>
      list.some(link => link.name === s.name && link.keys.some(([k]) => Math.abs(k - s.t) < EPS))
    );
    lanes.clear();
    track.replaceChildren();
    const rulerRow = element("div", "timeline-ruler-row"),
      corner = element("div", "timeline-corner");
    // 레인 추가는 레인 이름 칸 맨 위(눈금자 왼쪽)에 둔다: 레인이 생기는 자리 바로 위라 찾기 쉽고, 위 막대 폭을 아낀다.
    corner.append(addSelect);
    rulerRow.append(corner, renderRuler());
    track.append(rulerRow);
    if (!list.length)
      track.append(
        element(
          "p",
          "timeline-empty",
          "키프레임 연결이 없습니다. 왼쪽 위 '+ 파라미터'로 레인을 만들거나, 파라미터 줄의 연결 버튼(⛓)에서 '키프레임'을 고르세요."
        )
      );
    for (const link of list) track.append(renderLane(link, items.get(link.name)));
    const overlay = element("div", "timeline-overlay");
    playhead = element("div", "timeline-playhead");
    // 재생선이 보이는 범위 밖이면 가장자리에 시간 표시(누르면 그쪽으로 이동)
    edge = button("timeline-edge", "재생선이 있는 곳으로 보기 이동");
    edge.hidden = true;
    on(edge, "click", () => {
      const t = now(),
        width = span();
      view = { start: round(Math.max(0, t - width * 0.25), 4), end: round(Math.max(0, t - width * 0.25) + width, 4) };
      viewTouched = true;
      render();
    });
    overlay.append(playhead, edge);
    track.append(overlay);
    // + 파라미터: 연결할 수 있는 타입 중 아직 키프레임이 아닌 것
    const linked = new Map(links().map(link => [link.name, link.source]));
    addSelect.replaceChildren();
    const first = element("option", "", "+ 파라미터");
    first.value = "";
    addSelect.append(first);
    for (const item of items.values()) {
      if (!Links.LINKABLE.has(item.type) || linked.get(item.name) === "keys") continue;
      const option = element("option", "", linked.has(item.name) ? `${item.name} (다른 연결을 바꿈)` : item.name);
      option.value = item.name;
      addSelect.append(option);
    }
    addSelect.disabled = addSelect.options.length < 2;
    syncInspector();
    tick();
  };

  // ---- 선택한 키 칸 ----
  const selectedKeys = () =>
    selected
      .map(s => {
        const link = linkOf(s.name),
          index = link?.keys?.findIndex(([k]) => Math.abs(k - s.t) < EPS) ?? -1;
        return index >= 0 ? { link, index, key: link.keys[index], item: lanes.get(s.name)?.item } : null;
      })
      .filter(Boolean);
  const syncInspector = () => {
    const list = selectedKeys(),
      single = list.length === 1 ? list[0] : null;
    inspector.classList.toggle("is-empty", !list.length);
    selection.textContent = list.length
      ? single
        ? `${single.link.name} 키`
        : `키 ${list.length}개`
      : "키를 고르면 시간 · 값 · 잇기를 숫자로 고칩니다";
    selection.title = list.length ? selection.textContent : "";
    for (const node of [keyValue, keyEase, keyDelete]) node.disabled = !list.length;
    keyTime.disabled = !single;
    if (document.activeElement !== keyTime) keyTime.value = single ? String(round(single.key[0], 3)) : "";
    if (document.activeElement !== keyValue) {
      const values = [...new Set(list.map(entry => entry.key[1]))];
      keyValue.value = values.length === 1 ? String(round(values[0], 4)) : "";
      keyValue.placeholder = values.length > 1 ? "여러 값" : "";
    }
    const eases = [...new Set(list.map(entry => entry.key[2] || ""))],
      differs = eases.length > 1;
    mixed.hidden = !differs;
    keyEase.value = !list.length ? "" : differs ? "*" : eases[0];
    // '기본'이 무엇인지 보이게: 고른 키들이 한 레인이면 그 레인의 기본 잇기 이름을 붙인다
    const defaults = [...new Set(list.map(entry => entry.link.ease || "smooth"))];
    keyEase.options[0].textContent = !list.length
      ? "기본"
      : defaults.length === 1
        ? `기본 (${EASE_LABEL[defaults[0]] || "부드럽게"})`
        : "기본 (레인 설정)";
    keyEase.title = differs
      ? `고른 키 ${list.length}개의 잇기가 서로 다릅니다 · 하나를 고르면 모두 그 방식으로 바뀝니다`
      : "이 키에서 다음 키까지 값을 잇는 방식 · '기본'은 연결 시트의 기본 잇기를 따릅니다";
    for (const [name, info] of lanes)
      info.dots.forEach((dot, i) => dot.classList.toggle("is-selected", isSelected(name, info.link.keys[i][0])));
  };
  // 옮긴 키와 같은 시간에 있던 다른 키는 옮긴 키가 이긴다
  const settle = (keys, moved) => {
    const times = [...moved].map(i => keys[i][0]);
    return sortKeys(keys.filter((k, i) => moved.has(i) || !times.some(t => Math.abs(t - k[0]) < EPS)));
  };
  // 고른 키들을 change(entry) → 새 키로 바꿔 저장
  const editSelected = change => {
    const updates = new Map(),
      next = [];
    for (const entry of selectedKeys()) {
      const draft = updates.get(entry.link.name) || {
          link: entry.link,
          keys: entry.link.keys.map(k => [...k]),
          moved: new Set(),
        },
        key = change(entry);
      draft.keys[entry.index] = key;
      draft.moved.add(entry.index);
      updates.set(entry.link.name, draft);
      next.push({ name: entry.link.name, t: key[0] });
    }
    selected = next;
    if (updates.size)
      save(new Map([...updates].map(([name, d]) => [name, { ...d.link, keys: settle(d.keys, d.moved) }])));
  };
  const removeSelected = () => {
    const updates = new Map();
    for (const entry of selectedKeys()) {
      const link = updates.get(entry.link.name) || { ...entry.link };
      link.keys = link.keys.filter(([k]) => Math.abs(k - entry.key[0]) >= EPS);
      updates.set(link.name, link);
    }
    selected = [];
    if (updates.size) save(updates);
  };
  on(keyTime, "change", () => {
    const v = Number(keyTime.value);
    if (keyTime.value.trim() && Number.isFinite(v) && v >= 0)
      editSelected(({ key }) => [round(v), key[1], ...key.slice(2)]);
    else syncInspector();
  });
  on(keyValue, "change", () => {
    const v = Number(keyValue.value);
    if (keyValue.value.trim() && Number.isFinite(v))
      editSelected(({ key, item }) => [key[0], fitValue(item, v), ...key.slice(2)]);
    else syncInspector();
  });
  on(keyEase, "change", () => {
    if (keyEase.value === "*") return;
    editSelected(({ key }) => (keyEase.value ? [key[0], key[1], keyEase.value] : [key[0], key[1]]));
  });
  on(keyDelete, "click", removeSelected);

  // ---- 끌기: 키 · 상자 선택 ----
  const startKeyDrag = (event, name, index) => {
    event.preventDefault();
    event.stopPropagation();
    body.focus({ preventScroll: true });
    const info = lanes.get(name),
      key = info.link.keys[index];
    if (event.shiftKey) {
      if (isSelected(name, key[0])) selected = selected.filter(s => !(s.name === name && Math.abs(s.t - key[0]) < EPS));
      else selected = [...selected, { name, t: key[0] }];
      syncInspector();
      return;
    }
    if (!isSelected(name, key[0])) selected = [{ name, t: key[0] }];
    syncInspector();
    const moving = selectedKeys().map(entry => ({ ...entry, info: lanes.get(entry.link.name) })),
      width = info.area.clientWidth;
    drag = { x: event.clientX, y: event.clientY, moved: false, result: null };
    const move = e => {
      let dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const raw = key[0] + (dx / Math.max(1, width)) * span(),
        grabbed = e.altKey
          ? Math.max(0, round(raw))
          : snapTime(raw, width, (n, k) => moving.some(m => m.link.name === n && Math.abs(m.key[0] - k) < EPS)),
        dt = dx ? grabbed - key[0] : 0;
      const drafts = new Map();
      for (const entry of moving) {
        const lane = entry.info,
          dv = (-dy / Math.max(1, lane.plot.clientHeight)) * (lane.high - lane.low),
          t = Math.max(0, round(entry.key[0] + dt)),
          v = dy ? fitValue(lane.item, entry.key[1] + dv) : entry.key[1],
          draft = drafts.get(entry.link.name) || {
            link: entry.link,
            keys: entry.link.keys.map(k => [...k]),
            moved: new Set(),
          };
        draft.keys[entry.index] = [t, v, ...entry.key.slice(2)];
        draft.moved.add(entry.index);
        drafts.set(entry.link.name, draft);
        lane.dots[entry.index].style.left = xOf(t);
        lane.dots[entry.index].style.top = yOf(v, lane);
      }
      const result = new Map();
      for (const [name, draft] of drafts) {
        const next = { ...draft.link, keys: settle(draft.keys, draft.moved) };
        lanes.get(name).path.setAttribute("d", curveOf(next, lanes.get(name)));
        result.set(name, next);
      }
      drag.result = result;
      drag.next = moving.map(entry => ({ name: entry.link.name, t: drafts.get(entry.link.name).keys[entry.index][0] }));
      preview(result);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      const done = drag;
      drag = null;
      if (done?.moved && done.result) {
        selected = done.next;
        save(done.result);
      } else render();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };
  const startBox = event => {
    if (event.button !== 0) return;
    event.preventDefault();
    body.focus({ preventScroll: true });
    const origin = track.getBoundingClientRect(),
      box = element("div", "timeline-box"),
      from = { x: event.clientX, y: event.clientY },
      additive = event.shiftKey,
      before = additive ? [...selected] : [];
    let moved = false;
    const place = e => {
      const r = {
        l: Math.min(from.x, e.clientX),
        r: Math.max(from.x, e.clientX),
        t: Math.min(from.y, e.clientY),
        b: Math.max(from.y, e.clientY),
      };
      Object.assign(box.style, {
        left: `${r.l - origin.left}px`,
        top: `${r.t - origin.top}px`,
        width: `${r.r - r.l}px`,
        height: `${r.b - r.t}px`,
      });
      const inside = [];
      for (const [name, info] of lanes)
        info.dots.forEach((dot, i) => {
          const d = dot.getBoundingClientRect(),
            cx = d.left + d.width / 2,
            cy = d.top + d.height / 2;
          if (cx >= r.l && cx <= r.r && cy >= r.t && cy <= r.b) inside.push({ name, t: info.link.keys[i][0] });
        });
      selected = [...before, ...inside.filter(s => !before.some(b => b.name === s.name && Math.abs(b.t - s.t) < EPS))];
      syncInspector();
    };
    const move = e => {
      if (!moved && Math.hypot(e.clientX - from.x, e.clientY - from.y) < 3) return;
      if (!moved) track.append(box);
      moved = true;
      place(e);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      box.remove();
      if (!moved && !additive) {
        selected = [];
        syncInspector();
      }
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  // ---- 보기: 확대 · 이동 ----
  const zoom = (factor, anchor = (view.start + view.end) / 2) => {
    const next = Math.min(3600, Math.max(0.05, span() * factor)),
      ratio = (anchor - view.start) / span(),
      s = Math.max(0, anchor - ratio * next);
    view = { start: round(s, 4), end: round(s + next, 4) };
    viewTouched = true;
    render();
  };
  const pan = seconds => {
    const s = Math.max(0, view.start + seconds);
    view = { start: round(s, 4), end: round(s + span(), 4) };
    viewTouched = true;
    render();
  };
  on(
    body,
    "wheel",
    event => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoom(event.deltaY > 0 ? 1.25 : 0.8, timeAt(event.clientX, ruler || body));
      } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        pan(((event.deltaX || event.deltaY) / Math.max(1, body.clientWidth - HEAD)) * span());
      }
    },
    { passive: false }
  );
  const anchor = () => Math.min(view.end, Math.max(view.start, now()));
  on(zoomIn, "click", () => zoom(1 / 1.5, anchor()));
  on(zoomOut, "click", () => zoom(1.5, anchor()));
  on(fit, "click", () => {
    viewTouched = false;
    render();
  });

  // ---- 키보드 ----
  on(root, "keydown", event => {
    const target = event.target;
    if (target.closest?.("input, select, textarea") || target === resize) return;
    const ctrl = event.ctrlKey || event.metaKey,
      key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (ctrl && (key === "z" || key === "y")) {
      event.preventDefault();
      const s = studio();
      if (key === "y" || event.shiftKey) s?.redo?.();
      else s?.undo?.();
      body.focus({ preventScroll: true });
      return;
    }
    if (ctrl && key === "a") {
      event.preventDefault();
      selected = keyLinks().flatMap(link => link.keys.map(([t]) => ({ name: link.name, t })));
      syncInspector();
      return;
    }
    if (ctrl && key === "c") {
      const list = selectedKeys();
      if (!list.length) return;
      event.preventDefault();
      const first = Math.min(...list.map(entry => entry.key[0]));
      clipboard = list.map(entry => ({
        name: entry.link.name,
        dt: entry.key[0] - first,
        v: entry.key[1],
        ease: entry.key[2],
      }));
      return;
    }
    if (ctrl && key === "v") {
      if (!clipboard.length) return;
      event.preventDefault();
      const updates = new Map(),
        next = [];
      for (const entry of clipboard) {
        const link = updates.get(entry.name) || linkOf(entry.name);
        if (link?.source !== "keys") continue;
        const t = local(link, round(now() + entry.dt)),
          pasted = entry.ease ? [t, entry.v, entry.ease] : [t, entry.v];
        updates.set(entry.name, {
          ...link,
          keys: sortKeys([...link.keys.filter(([k]) => Math.abs(k - t) >= EPS), pasted]),
        });
        next.push({ name: entry.name, t });
      }
      selected = next;
      if (updates.size) save(updates);
      return;
    }
    if (key === "Escape") {
      selected = [];
      syncInspector();
      return;
    }
    if (!selected.length) return;
    if (key === "Delete" || key === "Backspace") {
      event.preventDefault();
      removeSelected();
      return;
    }
    const time = { ArrowLeft: -1, ArrowRight: 1 }[key],
      value = { ArrowUp: 1, ArrowDown: -1 }[key];
    if (time) {
      event.preventDefault();
      const dt = time * nudgeStep() * (event.shiftKey ? 10 : 1);
      editSelected(({ key: k }) => [Math.max(0, round(k[0] + dt)), k[1], ...k.slice(2)]);
    } else if (value) {
      event.preventDefault();
      editSelected(({ key: k, item, link }) => {
        const lane = lanes.get(link.name),
          integer = ["int", "uint", "bool"].includes(item?.type),
          dv = integer ? 1 : (lane.high - lane.low) / (event.shiftKey ? 10 : 100);
        return [k[0], fitValue(item, k[1] + value * dv), ...k.slice(2)];
      });
    }
  });

  // ---- 위 막대 ----
  on(play, "click", () => studio()?.togglePlayback?.());
  on(start, "click", () => attempt(() => renderer.setTime(0)));
  on(timeField, "change", () => {
    const v = Number(timeField.value);
    if (timeField.value.trim() && Number.isFinite(v) && v >= 0) attempt(() => renderer.setTime(v));
  });
  on(timeField, "keydown", event => {
    if (event.key === "Enter") timeField.dispatchEvent(new Event("change"));
  });
  on(snapSelect, "change", () => {
    snapChoice = snapSelect.value;
    remember();
  });
  // 배속은 설정 패널의 배속 버튼을 눌러 바꾼다: 저장 · 표시 · 되돌리기가 한 길로 간다(없으면 렌더러에 직접).
  on(speedSelect, "change", () => {
    const value = speedSelect.value,
      preset = document.querySelector(`[data-time-scale="${value}"]`);
    if (preset) preset.click();
    else attempt(() => renderer.setTimeScale?.(Number(value)));
  });
  on(addSelect, "change", () => {
    const item = users().find(u => u.name === addSelect.value);
    addSelect.value = "";
    if (!item) return;
    const value = typeof item.value === "boolean" ? (item.value ? 1 : 0) : item.value,
      t = round(now()),
      others = links().filter(link => link.name !== item.name);
    selected = [{ name: item.name, t }];
    settings.setLinks([
      ...others,
      { name: item.name, source: "keys", min: 0, max: 1, smooth: 0, keys: [[t, value]], loop: 0, ease: "smooth" },
    ]);
    body.focus({ preventScroll: true });
  });
  on(close, "click", () => setOpen(false));

  // ---- 높이 ----
  // 설정 패널 · 편집기의 경계와 같은 규칙: 최소 높이의 절반(COLLAPSE)보다 낮게 끌면 '놓으면 숨김'이 뜨고, 그대로 놓으면
  // 타임라인을 닫는다(다시 끌어올리면 취소). 닫을 때는 끌기 전 높이로 되돌려 두어 다시 열면 원래 높이로 열린다.
  // 두 번 누르면 기본 높이, Home/End는 최소 · 최대.
  const HEIGHT = { min: 140, initial: 220 },
    COLLAPSE = HEIGHT.min / 2;
  const maxHeight = () => Math.max(180, window.innerHeight * 0.7);
  const setHeight = value => {
    height = Math.round(Math.min(Math.max(HEIGHT.min, value), maxHeight()));
    // 좁은 화면에서는 미리보기 높이도 이 값으로 줄이므로 문서 전체에 건다
    document.documentElement.style.setProperty("--timeline-height", `${height}px`);
    resize.setAttribute("aria-valuemin", String(HEIGHT.min));
    resize.setAttribute("aria-valuemax", String(Math.round(maxHeight())));
    resize.setAttribute("aria-valuenow", String(height));
  };
  const commitHeight = () => {
    remember();
    window.dispatchEvent?.(new Event("resize"));
  };
  let collapsing = false;
  const setCollapsing = on => {
    if (collapsing === on) return;
    collapsing = on;
    root.classList.toggle("is-collapsing", on);
    if (on) resize.setAttribute("aria-valuetext", "놓으면 타임라인을 숨깁니다");
    else resize.removeAttribute("aria-valuetext");
  };
  on(resize, "pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    capture(resize, event);
    const from = event.clientY,
      base = height;
    const move = e => {
      const wanted = base + (from - e.clientY);
      setCollapsing(wanted < COLLAPSE);
      setHeight(wanted);
    };
    const end = e => {
      for (const type of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"])
        resize.removeEventListener(type, type === "pointermove" ? move : end);
      if (collapsing) {
        setCollapsing(false);
        setHeight(base); // 숨길 때(또는 끌기가 취소되면) 끌기 전 높이로
        if (e.type === "pointerup") {
          setOpen(false);
          return;
        }
      }
      commitHeight();
    };
    resize.addEventListener("pointermove", move);
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) resize.addEventListener(type, end);
  });
  on(resize, "dblclick", () => {
    setHeight(HEIGHT.initial);
    commitHeight();
  });
  on(resize, "keydown", event => {
    const next =
      event.key === "ArrowUp"
        ? height + 24
        : event.key === "ArrowDown"
          ? height - 24
          : event.key === "Home"
            ? HEIGHT.min
            : event.key === "End"
              ? maxHeight()
              : null;
    if (next === null) return;
    event.preventDefault();
    setHeight(next);
    commitHeight();
  });

  // ---- 재생선 · 시계 ----
  const tick = () => {
    const t = now();
    if (playhead) {
      const before = t < view.start,
        after = t > view.end;
      playhead.hidden = before || after;
      playhead.style.left = xOf(t);
      edge.hidden = !before && !after;
      if (before || after) {
        edge.textContent = before ? `← ${t.toFixed(2)}초` : `${t.toFixed(2)}초 →`;
        edge.classList.toggle("is-before", before);
      }
    }
    if (ruler) ruler.setAttribute("aria-valuenow", String(round(t, 2)));
    // 재생 중에는 자릿수 고정(소수 둘째)으로 글자 폭이 흔들리지 않게, 멈췄을 때는 정확한 값
    if (document.activeElement !== timeField)
      timeField.value = renderer.getStats().running ? t.toFixed(2) : String(round(t, 3));
    const scale = String(renderer.getStats().timeScale ?? 1);
    if (document.activeElement !== speedSelect && speedSelect.value !== scale) {
      if (![...speedSelect.options].some(option => option.value === scale)) {
        const option = element("option", "", `${scale}×`);
        option.value = scale;
        speedSelect.append(option);
        fitSelect(
          speedSelect,
          [...speedSelect.options].map(each => each.textContent)
        );
      }
      speedSelect.value = scale;
    }
    const playing = studio()?.getPlaybackState?.() ?? renderer.getStats().running;
    play.classList.toggle("icon-play", !playing);
    play.classList.toggle("icon-pause", !!playing);
    play.setAttribute("aria-label", playing ? "일시정지" : "재생");
  };
  const loop = () => {
    frame = 0;
    if (root.hidden) return;
    if (++frames % 30 === 0 && !drag && shapeOf() !== shape) render();
    tick();
    frame = requestAnimationFrame(loop);
  };

  // ---- 열고 닫기 ----
  const toggles = new Set();
  // 선택 칸 폭 맞추기: 글자 잘림 방지. 폭을 어림하지 않고, 그 칸이 보일 수 있는 모든 이름을 넣은 같은 모양의 선택 칸을
  // 화면 밖에서 브라우저가 직접 재게 한다(실제 글꼴 · 운영체제의 화살표 폭까지 반영 — 윈도우 맑은 고딕에서도 잘리지 않음).
  // 가장 긴 이름에 맞춘 고정 폭이라, 고른 항목이나 '기본 (…)' 이름이 바뀌어도 막대가 흔들리지 않는다.
  const fitSelect = (select, labels) => {
    if (!select.isConnected || !select.getClientRects().length) return; // 숨어 있으면 열 때 다시 잰다
    const probe = select.cloneNode(false);
    probe.removeAttribute("id");
    probe.style.cssText =
      "position:absolute;left:-9999px;top:0;visibility:hidden;width:auto;min-width:0;max-width:none";
    for (const label of labels) probe.append(new Option(label));
    select.parentNode.append(probe);
    const width = Math.ceil(probe.getBoundingClientRect().width) + 2; // 반올림 · 굵게 그리기 여유
    probe.remove();
    if (width > 2) select.style.width = `${width}px`;
  };
  const easeLabels = () => [
    "기본",
    "기본 (레인 설정)",
    ...Object.values(EASE_LABEL).flatMap(label => [label, `기본 (${label})`]),
    "서로 다름",
  ];
  const fitSelects = () => {
    fitSelect(
      speedSelect,
      [...speedSelect.options].map(option => option.textContent)
    );
    fitSelect(
      snapSelect,
      SNAPS.map(([, text]) => text)
    );
    fitSelect(keyEase, easeLabels());
  };
  // 웹 글꼴이 늦게 들어오면 글자 폭이 바뀌므로 그때 한 번 더 잰다
  document.fonts?.ready?.then(() => !root.hidden && fitSelects());
  const setOpen = (open, { focus = false } = {}) => {
    root.hidden = !open;
    document.body.classList.toggle("timeline-open", open);
    for (const toggle of toggles) toggle.setAttribute("aria-pressed", String(open));
    remember();
    if (open) {
      setHeight(height);
      render();
      fitSelects();
      if (!frame) frame = requestAnimationFrame(loop);
      if (focus) body.focus({ preventScroll: true });
    }
    window.dispatchEvent?.(new Event("resize")); // 미리보기 캔버스 크기를 다시 맞춘다
  };
  // name이 있으면 그 레인의 첫 키를 고른다. focus: false면 초점은 부른 쪽(연결 시트)에 그대로 둔다.
  const open = (name, { focus = true } = {}) => {
    setOpen(true);
    const link = name && linkOf(name);
    if (link?.keys?.length) {
      selected = [{ name, t: link.keys[0][0] }];
      render();
      lanes.get(name)?.area?.closest?.(".timeline-lane")?.scrollIntoView?.({ block: "nearest" });
    }
    if (focus) body.focus({ preventScroll: true });
  };
  const bindToggle = node => {
    if (!node?.addEventListener) return;
    toggles.add(node);
    node.setAttribute("aria-controls", root.id);
    node.setAttribute("aria-pressed", String(!root.hidden));
    on(node, "click", () => setOpen(root.hidden, { focus: root.hidden }));
  };
  const renderRulerOnly = () => {
    const row = track.querySelector(".timeline-ruler-row");
    if (!row || !ruler) return;
    row.replaceChild(renderRuler(), row.lastChild);
    tick();
  };

  on(document, "shader-links-changed", () => render());
  on(document, "shader-settings-applied", () => render());
  on(window, "resize", () => !root.hidden && !drag && renderRulerOnly());
  setOpen(saved.open === true);
  return {
    render,
    open,
    close: () => setOpen(false),
    bindToggle,
    dispose: () => {
      controller.abort();
      if (frame) cancelAnimationFrame(frame);
      document.body.classList.remove("timeline-open");
    },
  };
};

export { mount };
