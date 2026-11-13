// 키프레임 타임라인: 파라미터 연결(links.js) 중 '키프레임' 소스를 시간 막대 위에서 보고 고친다.
//  · 눈금 막대를 누르거나 끌면 재생 위치(uTime)를 옮긴다(renderer.setTime). 세로 재생선이 지금 시간을 따라간다.
//  · 키프레임 연결마다 레인 하나: 값 곡선(links.keyValue와 같은 잇기) + 키 점.
//    점 끌기 = 시간 · 값 바꾸기(0.05초 단위, Alt를 누르면 자유롭게) · 빈 곳 더블클릭 = 그 자리에 키 · 점 더블클릭 = 지우기
//    키보드: ←/→ 0.1초(Shift 1초) · ↑/↓ 값(범위의 1/100, Shift 1/10) · Delete 지우기 · Enter 그 시간으로 이동
//  · '+ 파라미터'로 연결 없는 float · int · uint · bool 파라미터에 키프레임 레인을 만든다(지금 시간 · 지금 값으로 키 하나).
// 값 범위(레인의 아래 · 위)는 파라미터 슬라이더 범위, 없으면 키 값들을 감싸는 범위. 끄는 동안은 렌더러에만 적용하고
// 놓을 때 settings.setLinks로 저장한다(자동 저장 · Pack · 연결 편집 칸에 반영).
import * as Links from "./links.js";

const SNAP = 0.05;

const mount = ({ renderer, settings, root }) => {
  const $ = selector => root?.querySelector?.(selector) ?? null;
  const body = $(".timeline-body"),
    lengthField = $(".timeline-length"),
    addSelect = $(".timeline-add"),
    clock = $(".timeline-clock"),
    count = $(".timeline-count");
  // 칸이 없는 화면(시험용 가짜 DOM · 다른 배치)에서는 아무것도 하지 않는다.
  if (![body, lengthField, addSelect, clock, count].every(node => node?.addEventListener))
    return { render: () => {}, dispose: () => {} };
  const element = (tag, className = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  };
  const svg = tag => document.createElementNS("http://www.w3.org/2000/svg", tag);
  const round = (value, digits = 3) => Number(value.toFixed(digits));
  const controller = new AbortController();
  const on = (node, type, handler, options = {}) =>
    node.addEventListener(type, handler, { ...options, signal: controller.signal });

  let length = 10, // 보이는 길이(초)
    lengthTouched = false, // 사용자가 길이를 직접 정했는가(아니면 키에 맞춰 늘린다)
    dragging = null, // { name, index, keys }
    frame = 0,
    focusAfter = null; // 다시 그린 뒤 초점을 돌려 줄 키 { name, time | index }
  let ruler = null,
    playhead = null;
  const lanes = new Map(); // 이름 → { lane, area, path, low, high }

  const links = () => settings.getLinks?.() || [];
  const keyLinks = () => links().filter(link => link.source === "keys");
  const users = () => renderer.getUserUniforms();
  const now = () => renderer.getStats().time ?? 0;
  const save = (name, change) => {
    settings.setLinks(links().map(link => (link.name === name ? { ...link, ...change } : link)));
    renderer.redraw?.();
  };
  // 끄는 중: 렌더러에만(저장 · 다시 그리기 없음)
  const preview = (name, keys) => {
    renderer.setLinks(links().map(link => (link.name === name ? { ...link, keys } : link)));
    renderer.redraw?.();
  };
  const sortKeys = keys => [...keys].sort((a, b) => a[0] - b[0]);

  // 레인 값 범위: 슬라이더 범위(bool은 0~1), 없으면 키 값을 감싸는 범위(같으면 ±1)
  const rangeOf = (item, keys) => {
    if (item?.type === "bool") return [0, 1];
    const { min, max } = item?.options || {};
    if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
      const values = keys.map(k => k[1]);
      return [Math.min(min, ...values), Math.max(max, ...values)];
    }
    const values = keys.map(k => k[1]);
    let low = Math.min(...values),
      high = Math.max(...values);
    if (!(high > low)) [low, high] = [low - 1, high + 1];
    const pad = (high - low) * 0.1;
    return [low - pad, high + pad];
  };
  const autoLength = () => {
    let end = 5;
    for (const link of keyLinks()) end = Math.max(end, link.loop || 0, ...link.keys.map(k => k[0] * 1.15));
    return Math.min(3600, Math.ceil(end));
  };
  const xOf = t => `${Math.min(100, Math.max(0, (t / length) * 100))}%`;
  const timeAt = (event, area) => {
    const rect = area.getBoundingClientRect();
    return Math.min(length, Math.max(0, ((event.clientX - rect.left) / Math.max(1, rect.width)) * length));
  };
  const valueAt = (event, info) => {
    const rect = info.plot.getBoundingClientRect(),
      unit = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
    return info.low + (info.high - info.low) * unit;
  };
  const fit = (item, value) => {
    if (item?.type === "bool") return value >= 0.5 ? 1 : 0;
    if (item?.type === "int" || item?.type === "uint")
      return Math.max(item.type === "uint" ? 0 : -Infinity, Math.round(value));
    return round(value, 4);
  };
  // 끄는 동안 포인터를 붙잡는다(합성 이벤트처럼 활성 포인터가 아니면 조용히 넘어간다)
  const capture = (node, event) => {
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      // 활성 포인터가 아님
    }
  };
  const snap = (t, free) => round(free ? t : Math.round(t / SNAP) * SNAP, 3);

  // 값 곡선: 레인 너비를 200칸으로 나눠 keyValue를 그린다(반복이면 반복해서).
  const curve = (link, info) => {
    const points = [];
    for (let i = 0; i <= 200; i++) {
      const t = (i / 200) * length,
        v = Links.keyValue(link.keys, t, link.loop, link.ease);
      if (v === null) continue;
      const y = 100 - ((v - info.low) / (info.high - info.low || 1)) * 100;
      points.push(`${i === 0 ? "M" : "L"}${(i / 200) * 1000} ${Math.min(100, Math.max(0, y)).toFixed(2)}`);
    }
    return points.join(" ");
  };
  const placeKey = (dot, [t, v], info) => {
    dot.style.left = xOf(t);
    dot.style.top = `${100 - Math.min(100, Math.max(0, ((v - info.low) / (info.high - info.low || 1)) * 100))}%`;
  };
  const keyLabel = (name, [t, v]) => `${name} 키 ${round(t, 2)}초 · 값 ${round(v, 4)}`;

  const renderRuler = () => {
    ruler = element("div", "timeline-ruler");
    ruler.setAttribute("role", "slider");
    ruler.tabIndex = 0;
    ruler.setAttribute("aria-label", "재생 위치");
    ruler.setAttribute("aria-valuemin", "0");
    ruler.setAttribute("aria-valuemax", String(length));
    const step = length <= 10 ? 1 : length <= 30 ? 5 : length <= 120 ? 10 : length <= 600 ? 60 : 300;
    for (let t = 0; t <= length + 1e-9; t += step) {
      const tick = element("span", "timeline-tick");
      tick.style.left = xOf(t);
      tick.textContent = `${round(t, 2)}`;
      ruler.append(tick);
    }
    const seek = event => renderer.setTime(round(timeAt(event, ruler), 3));
    on(ruler, "pointerdown", event => {
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
    on(ruler, "keydown", event => {
      const step = event.shiftKey ? 1 : 0.1;
      const moves = { ArrowLeft: -step, ArrowRight: step, Home: -Infinity, End: Infinity };
      if (!(event.key in moves)) return;
      event.preventDefault();
      renderer.setTime(round(Math.min(length, Math.max(0, now() + moves[event.key])), 3));
    });
    return ruler;
  };

  const renderLane = (link, item) => {
    const [low, high] = rangeOf(item, link.keys);
    const lane = element("div", "timeline-lane"),
      head = element("div", "timeline-lane-head"),
      name = element("span", "timeline-lane-name"),
      remove = element("button", "timeline-lane-remove glyph-icon icon-close"),
      area = element("div", "timeline-area"),
      plot = element("div", "timeline-plot"), // 곡선과 키 점이 같은 세로 여백을 쓰는 칸
      graph = svg("svg"),
      path = svg("path");
    lane.dataset.name = link.name;
    name.textContent = link.name;
    name.title = `${round(low, 3)} ~ ${round(high, 3)}${link.loop ? ` · ${round(link.loop, 2)}초 반복` : ""}`;
    remove.type = "button";
    remove.setAttribute("aria-label", `${link.name} 키프레임 연결 지우기`);
    remove.title = "이 파라미터의 키프레임 연결 지우기(값은 지금 값으로 남는다)";
    on(remove, "click", () => settings.setLinks(links().filter(l => l.name !== link.name)));
    head.append(name, remove);
    graph.setAttribute("viewBox", "0 0 1000 100");
    graph.setAttribute("preserveAspectRatio", "none");
    graph.setAttribute("aria-hidden", "true");
    graph.classList.add("timeline-curve");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    graph.append(path);
    plot.append(graph);
    area.append(plot);
    if (link.loop > 0 && link.loop < length) {
      const loop = element("span", "timeline-loop");
      loop.style.left = xOf(link.loop);
      loop.title = `${round(link.loop, 2)}초마다 반복`;
      plot.append(loop);
    }
    const info = { lane, area, plot, path, low, high };
    lanes.set(link.name, info);
    path.setAttribute("d", curve(link, info));
    link.keys.forEach((key, index) => {
      const dot = element("button", "timeline-key");
      dot.type = "button";
      dot.dataset.index = String(index);
      dot.setAttribute("aria-label", keyLabel(link.name, key));
      dot.title = `${round(key[0], 2)}초 · ${round(key[1], 4)} — 끌어서 옮기기(Alt: 0.05초 단위 끄기) · 더블클릭 지우기 · 방향키`;
      placeKey(dot, key, info);
      on(dot, "pointerdown", event => {
        event.preventDefault();
        event.stopPropagation();
        dot.focus();
        capture(dot, event);
        dragging = { name: link.name, index, keys: link.keys.map(k => [...k]), moved: false };
        const move = e => {
          const t = snap(timeAt(e, plot), e.altKey),
            v = fit(item, valueAt(e, info));
          dragging.keys[index] = [t, v];
          dragging.moved = true;
          placeKey(dot, [t, v], info);
          dot.setAttribute("aria-label", keyLabel(link.name, [t, v]));
          const keys = sortKeys(dragging.keys);
          path.setAttribute("d", curve({ ...link, keys }, info));
          preview(link.name, keys);
        };
        const up = () => {
          dot.removeEventListener("pointermove", move);
          dot.removeEventListener("pointerup", up);
          dot.removeEventListener("pointercancel", up);
          const done = dragging;
          dragging = null;
          if (done?.moved) save(link.name, { keys: dedupe(done.keys, index) });
        };
        dot.addEventListener("pointermove", move);
        dot.addEventListener("pointerup", up);
        dot.addEventListener("pointercancel", up);
      });
      on(dot, "dblclick", event => {
        event.stopPropagation();
        save(link.name, { keys: link.keys.filter((_, i) => i !== index) });
      });
      on(dot, "keydown", event => {
        const span = info.high - info.low,
          dt = event.shiftKey ? 1 : 0.1,
          dv =
            item?.type === "bool" || item?.type === "int" || item?.type === "uint"
              ? 1
              : span / (event.shiftKey ? 10 : 100);
        let next = null;
        if (event.key === "ArrowLeft") next = [Math.max(0, round(key[0] - dt)), key[1]];
        else if (event.key === "ArrowRight") next = [round(key[0] + dt), key[1]];
        else if (event.key === "ArrowUp") next = [key[0], fit(item, key[1] + dv)];
        else if (event.key === "ArrowDown") next = [key[0], fit(item, key[1] - dv)];
        else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          focusAfter = { name: link.name, index: Math.max(0, index - 1) };
          return save(link.name, { keys: link.keys.filter((_, i) => i !== index) });
        } else if (event.key === "Enter") {
          event.preventDefault();
          return renderer.setTime(key[0]);
        }
        if (!next) return;
        event.preventDefault();
        const keys = link.keys.map(k => [...k]);
        keys[index] = next;
        const sorted = dedupe(keys, index);
        focusAfter = { name: link.name, time: next[0] };
        save(link.name, { keys: sorted });
      });
      plot.append(dot);
    });
    // 빈 곳 더블클릭: 그 시간 · 높이에 키(같은 시간의 키는 바꾼다)
    on(area, "dblclick", event => {
      if (event.target.closest(".timeline-key")) return;
      const t = snap(timeAt(event, plot), event.altKey),
        v = fit(item, valueAt(event, info));
      focusAfter = { name: link.name, time: t };
      save(link.name, { keys: sortKeys([...link.keys.filter(([k]) => Math.abs(k - t) > 1e-3), [t, v]]) });
    });
    lane.append(head, area);
    return lane;
  };
  // 끌어서 다른 키와 같은 시간이 되면 옮긴 키가 이긴다
  const dedupe = (keys, index) => {
    const moved = keys[index];
    return sortKeys(keys.filter((k, i) => i === index || Math.abs(k[0] - moved[0]) > 1e-3));
  };

  const render = () => {
    if (dragging) return;
    const active = document.activeElement;
    const restoreRuler = active === ruler;
    if (!lengthTouched) {
      length = autoLength();
      lengthField.value = String(length);
    }
    const items = new Map(users().map(item => [item.name, item]));
    shape = shapeOf();
    const list = keyLinks().filter(link => items.has(link.name));
    lanes.clear();
    body.replaceChildren();
    count.textContent = list.length ? `${list.length}` : "";
    const track = element("div", "timeline-track");
    track.append(renderRuler());
    if (!list.length) {
      const empty = element("p", "timeline-empty help");
      empty.textContent =
        "키프레임 연결이 없습니다. '+ 파라미터'로 레인을 만들거나, 파라미터 줄의 연결 버튼에서 '키프레임'을 고르세요.";
      track.append(empty);
    }
    for (const link of list) track.append(renderLane(link, items.get(link.name)));
    // 재생선은 레인 이름 칸을 뺀 영역(눈금과 같은 폭) 위에 겹친다
    const overlay = element("div", "timeline-overlay");
    playhead = element("div", "timeline-playhead");
    overlay.setAttribute("aria-hidden", "true");
    overlay.append(playhead);
    track.append(overlay);
    body.append(track);
    // 추가할 수 있는 파라미터: 연결할 수 있는 타입 중 아직 키프레임이 아닌 것
    const linked = new Map(links().map(link => [link.name, link.source]));
    addSelect.replaceChildren();
    const first = element("option");
    first.value = "";
    first.textContent = "+ 파라미터";
    addSelect.append(first);
    for (const item of items.values()) {
      if (!Links.LINKABLE.has(item.type) || linked.get(item.name) === "keys") continue;
      const option = element("option");
      option.value = item.name;
      option.textContent = linked.has(item.name) ? `${item.name} (다른 연결을 바꿈)` : item.name;
      addSelect.append(option);
    }
    addSelect.disabled = addSelect.options.length < 2;
    tick();
    if (restoreRuler) ruler.focus();
    if (focusAfter) {
      const info = lanes.get(focusAfter.name),
        dots = info ? [...info.area.querySelectorAll(".timeline-key")] : [],
        link = list.find(l => l.name === focusAfter.name),
        index =
          focusAfter.time !== undefined && link
            ? link.keys.findIndex(([t]) => Math.abs(t - focusAfter.time) < 1e-3)
            : focusAfter.index;
      (dots[index] || dots.at(-1))?.focus();
      focusAfter = null;
    }
  };

  // 재생선 · 시계: 접혀 있으면 멈춘다
  const tick = () => {
    const t = now();
    if (playhead) {
      playhead.hidden = t > length;
      playhead.style.left = xOf(t);
    }
    if (ruler) ruler.setAttribute("aria-valuenow", String(round(t, 2)));
    clock.textContent = `${t.toFixed(2)}s`;
  };
  // 파라미터가 생기거나 없어지면(코드 적용 · 콘솔) 레인과 '+ 파라미터' 목록을 다시 만든다. 30프레임마다 확인.
  let shape = "",
    frames = 0;
  const shapeOf = () =>
    users()
      .map(item => `${item.name}:${item.type}`)
      .join();
  const loop = () => {
    frame = 0;
    if (!root.open) return;
    if (++frames % 30 === 0 && shapeOf() !== shape) render();
    tick();
    frame = requestAnimationFrame(loop);
  };
  const wake = () => {
    if (root.open && !frame) frame = requestAnimationFrame(loop);
  };

  on(root, "toggle", () => {
    if (root.open) render();
    wake();
  });
  on(lengthField, "change", () => {
    const value = Number(lengthField.value);
    if (!(value >= 1 && value <= 3600)) {
      lengthField.value = String(length);
      return;
    }
    length = value;
    lengthTouched = true;
    render();
  });
  on(addSelect, "change", () => {
    const item = users().find(u => u.name === addSelect.value);
    addSelect.value = "";
    if (!item) return;
    const value = typeof item.value === "boolean" ? (item.value ? 1 : 0) : item.value,
      t = round(now(), 3),
      others = links().filter(link => link.name !== item.name);
    focusAfter = { name: item.name, time: t };
    settings.setLinks([
      ...others,
      { name: item.name, source: "keys", min: 0, max: 1, smooth: 0, keys: [[t, value]], loop: 0, ease: "smooth" },
    ]);
  });
  on(document, "shader-links-changed", () => root.open && render());
  on(document, "shader-settings-applied", () => root.open && render());
  render();
  wake();
  return {
    render,
    dispose: () => {
      controller.abort();
      if (frame) cancelAnimationFrame(frame);
    },
  };
};

export { mount };
