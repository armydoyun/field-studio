// 연결 시트 · 연결 미터: 파라미터 연결(links.js)을 고르고 다듬는 화면. ui.js의 파라미터 줄이 쓴다.
// 시트는 "라벨 | 조작" 두 열 격자로 위에서 아래로 읽는다.
//   소스(끄기 · 소리 · MIDI · 흔들기 · 키프레임) → 입력(소스별 설정 + 실시간 미리보기) → 출력(범위 막대 · 뒤집기)
//   → 반응(부드럽게 따라가는 시간) → 결과(지금 값 막대)
// 키프레임의 키 자체는 여기서 고치지 않는다(파라미터 줄의 내비게이터 · 타임라인). 시트에는 반복 · 잇기와 타임라인 열기만.
// 끄는 조작(슬라이더)은 input 동안 미리보기(렌더러에만), change에서 저장한다 — 다시 그려도 끌기가 끊기지 않게.
import * as Links from "./links.js";

const SOURCE_LABEL = { audio: "소리", midi: "MIDI", lfo: "흔들기", keys: "키프레임" };
const BAND_LABEL = { bass: "저음", mid: "중음", treble: "고음", volume: "음량" };
const SHAPE_LABEL = { sine: "사인", triangle: "삼각", saw: "톱니", square: "사각" };
// 값 범위 양 끝: 소스가 가장 약할 때 · 셀 때
const END_LABEL = {
  audio: ["조용할 때", "클 때"],
  midi: ["노브 처음(0)", "노브 끝(127)"],
  lfo: ["가장 낮을 때", "가장 높을 때"],
};

// 범위 폭에 맞춘 자릿수: 0~1 → 3자리, 0~100 → 1자리, 0~10000 → 0자리
const decimalsFor = span => Math.min(4, Math.max(0, 3 - Math.floor(Math.log10(Math.max(1e-6, Math.abs(span))))));
// 숫자 글자: 실시간으로 바뀌는 칸(미터 · 결과)은 자릿수를 고정해(fixed) 글자 폭이 흔들리지 않게 한다.
// 입력 칸 초깃값처럼 한 번 보이는 곳은 끝의 0을 뗀다.
const format = (value, span = 1, fixed = false) => {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (!Number.isFinite(value)) return "—";
  const text = value.toFixed(decimalsFor(span));
  return fixed ? (text === "-0" || /^-0\.0+$/.test(text) ? text.slice(1) : text) : String(Number(text));
};
const seconds = value => `${Number(value.toFixed(2))}초`;

const describe = link =>
  link.source === "audio"
    ? `소리 · ${BAND_LABEL[link.band]}`
    : link.source === "midi"
      ? `MIDI CC ${link.cc}${link.channel ? ` · 채널 ${link.channel}` : ""}`
      : link.source === "lfo"
        ? `흔들기 · ${SHAPE_LABEL[link.shape]} ${seconds(link.period)}`
        : `키프레임 ${link.keys.length}개${link.loop ? ` · ${seconds(link.loop)} 반복` : ""}`;

// 파라미터 슬라이더 범위(없으면 0~1, bool은 0~1)
const rangeOf = item =>
  item.type === "bool"
    ? [0, 1]
    : [
        Number.isFinite(item.options?.min) ? item.options.min : 0,
        Number.isFinite(item.options?.max) ? item.options.max : 1,
      ];

const element = (tag, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const svgNode = tag => document.createElementNS("http://www.w3.org/2000/svg", tag);

// 막대 하나: 0~1 채움. 값 글자는 옆에.
const bar = (label = "") => {
  const wrap = element("div", "link-bar"),
    fill = element("span", "link-bar-fill");
  wrap.setAttribute("role", "meter");
  wrap.setAttribute("aria-valuemin", "0");
  wrap.setAttribute("aria-valuemax", "1");
  if (label) wrap.setAttribute("aria-label", label);
  wrap.append(fill);
  return {
    node: wrap,
    set: (unit, text = "") => {
      const u = Math.min(1, Math.max(0, Number.isFinite(unit) ? unit : 0));
      fill.style.width = `${u * 100}%`;
      wrap.setAttribute("aria-valuenow", String(Number(u.toFixed(3))));
      if (text) wrap.setAttribute("aria-valuetext", text);
    },
  };
};

// 파라미터 줄의 읽기 전용 미터(연결이 값을 정하는 동안 슬라이더 대신)
// 입력이 없을 때(소리가 꺼짐 · MIDI 신호 없음)의 까닭 — 이때 값은 마지막 값 그대로다
const IDLE_REASON = {
  audio: "켜진 오디오 없음",
  midi: "MIDI 신호 없음",
  lfo: "",
  keys: "",
};
// active(): 이 연결이 지금 값을 정하고 있는가(renderer.linkActive)
const meter = (item, link, active = () => true) => {
  const [low, high] = rangeOf(item),
    span = high - low,
    node = element("div", "link-meter"),
    gauge = bar(`${item.name} 값(연결이 정함)`),
    value = element("output", "link-meter-value"),
    note = element("span", "link-meter-note", "연결이 정함");
  node.title = `${describe(link)} — 값은 연결이 프레임마다 정합니다. 연결 버튼(⛓)에서 바꾸거나 끄세요.`;
  node.append(gauge.node, value, note);
  let idle = null;
  const update = current => {
    const v = typeof current === "boolean" ? (current ? 1 : 0) : current;
    gauge.set((v - low) / (span || 1), format(current, span));
    value.textContent = format(current, span, true);
    const now = !active();
    if (now !== idle) {
      // 글자는 상태가 바뀔 때만 고친다
      idle = now;
      node.classList.toggle("is-idle", now);
      note.textContent = now ? `${IDLE_REASON[link.source] || "입력 없음"} · 값 그대로` : "연결이 정함";
    }
  };
  update(item.value);
  return { node, update };
};

// 끄기 · 소리 · MIDI … 같은 한 줄 선택(라디오 그룹). onPick(value)
const segmented = (label, options, current, onPick, className = "") => {
  const group = element("div", `link-segmented ${className}`.trim());
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  const buttons = options.map(([value, text]) => {
    const button = element("button", "", text);
    button.type = "button";
    button.dataset.value = value;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(value === current));
    button.tabIndex = value === current ? 0 : -1;
    button.addEventListener("click", () => value !== current && onPick(value));
    button.addEventListener("keydown", event => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const index = (buttons.indexOf(button) + step + buttons.length) % buttons.length;
      buttons[index].focus();
      buttons[index].click();
    });
    return button;
  });
  if (!buttons.some(b => b.tabIndex === 0)) buttons[0].tabIndex = 0;
  group.append(...buttons);
  return group;
};

const numberField = (label, value, onCommit, { min, max, step = "any", unit = "" } = {}) => {
  const wrap = element("label", "link-number"),
    input = element("input");
  input.type = "number";
  input.step = String(step);
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.value = String(value);
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (input.value.trim() && Number.isFinite(v)) onCommit(v);
    else input.value = String(value);
  });
  wrap.append(input);
  if (unit) wrap.append(element("span", "link-unit", unit));
  return wrap;
};

// 시트. options:
//   item: 파라미터 { name, type, value, options } · link: 지금 연결(없으면 null)
//   renderer: midiStatus · startMidi · learnMidi · cancelMidiLearn · linkMonitor · getStats
//   save(next | null): 저장 · preview(next): 렌더러에만 미리 적용 · openTimeline(name)
// 돌려줌: { node, update(value) } — update는 매 프레임(시트가 보이는 동안) 실시간 표시를 고친다.
const sheet = ({ item, link, renderer, save, preview, openTimeline }) => {
  const [low, high] = rangeOf(item),
    span = high - low,
    node = element("div", "link-editor"),
    grid = element("div", "link-grid"),
    live = []; // 매 프레임 부를 함수
  node.dataset.name = item.name;
  node.setAttribute("role", "group");
  node.setAttribute("aria-label", `${item.name} 연결`);
  const base = link || { source: "", min: low, max: high, smooth: 0 };
  const change = patch => save({ ...base, ...patch });
  const row = (label, ...controls) => {
    const head = element("span", "link-label", label),
      body = element("div", "link-control");
    body.append(...controls);
    grid.append(head, body);
    return body;
  };

  node.append(
    segmented(
      "연결 소스",
      [["", "끄기"], ...Links.SOURCES.map(source => [source, SOURCE_LABEL[source]])],
      link?.source || "",
      source => {
        if (!source) return save(null);
        const fresh = { source, min: low, max: high, smooth: source === "audio" ? 0.1 : 0 };
        if (source === "keys")
          fresh.keys = [[Number((renderer.getStats().time ?? 0).toFixed(3)), Number(item.value) || 0]];
        save(fresh);
      },
      "link-sources"
    )
  );
  if (!link) {
    node.append(
      element(
        "p",
        "link-hint",
        "소스를 고르면 그 소스가 이 값을 프레임마다 정합니다. 소리 대역 · MIDI 노브 · 주기적인 흔들기 · 시간에 따른 키프레임. 영상 렌더링에서도 렌더 시간에 맞습니다."
      )
    );
    return { node, update: () => {} };
  }

  // ---- 입력 ----
  if (link.source === "audio") {
    const levels = Object.keys(BAND_LABEL).map(band => {
      const gauge = bar(`${BAND_LABEL[band]} 세기`);
      gauge.node.classList.toggle("is-picked", band === link.band);
      return [band, gauge];
    });
    const meters = element("div", "link-bands"),
      empty = element(
        "p",
        "link-note",
        "켜진 오디오가 없습니다. 채널에서 오디오 파일이나 마이크를 켜면 세기가 보입니다."
      );
    for (const [band, gauge] of levels) {
      const line = element("div", "link-band-line");
      line.append(element("span", "link-band-name", BAND_LABEL[band]), gauge.node);
      meters.append(line);
    }
    row(
      "입력",
      segmented("소리 대역", Object.entries(BAND_LABEL), link.band, band => change({ band })),
      meters,
      empty
    );
    live.push(() => {
      const audio = renderer.linkMonitor?.().audio;
      empty.hidden = !!audio;
      for (const [band, gauge] of levels) gauge.set(audio ? audio[band] : 0);
    });
  }
  if (link.source === "midi") {
    const learn = element("button", "link-learn", "학습 — 누르고 노브를 움직이기");
    learn.type = "button";
    learn.title = "누른 뒤 컨트롤러의 노브 · 슬라이더를 움직이면 그 CC로 연결합니다";
    const status = element("p", "link-note");
    learn.addEventListener("click", async () => {
      if (learn.getAttribute("aria-pressed") === "true") {
        renderer.cancelMidiLearn?.();
        learn.setAttribute("aria-pressed", "false");
        learn.textContent = "학습 — 누르고 노브를 움직이기";
        return;
      }
      if (!(await renderer.startMidi())) return;
      learn.setAttribute("aria-pressed", "true");
      learn.textContent = "노브를 움직이세요… (다시 누르면 취소)";
      renderer.learnMidi(({ channel, cc }) => change({ channel, cc }));
    });
    const channel = element("select");
    channel.setAttribute("aria-label", "MIDI 채널");
    for (const [value, text] of [
      ["0", "모든 채널"],
      ...Array.from({ length: 16 }, (_, i) => [String(i + 1), `채널 ${i + 1}`]),
    ]) {
      const option = element("option", "", text);
      option.value = value;
      channel.append(option);
    }
    channel.value = String(link.channel);
    channel.addEventListener("change", () => change({ channel: Number(channel.value) }));
    const pick = element("div", "link-inline");
    pick.append(
      numberField("CC 번호", link.cc, cc => change({ cc }), { min: 0, max: 127, step: 1 }),
      channel
    );
    const cc = element("span", "link-unit", "CC");
    pick.prepend(cc);
    row("입력", learn, pick, status);
    live.push(() => {
      const midi = renderer.midiStatus?.() || { state: "off", devices: [] };
      status.textContent =
        midi.state === "on"
          ? `${midi.devices.length ? midi.devices.join(", ") : "장치 없음"}${
              midi.last
                ? ` · 마지막: CC ${midi.last.cc} · 채널 ${midi.last.channel} = ${format(midi.last.value, 1, true)}`
                : ""
            }`
          : midi.state === "error"
            ? midi.error
            : "MIDI가 꺼져 있어 값이 그대로입니다. 학습을 누르면 켭니다(브라우저 권한 필요).";
    });
  }
  if (link.source === "lfo") {
    const wave = svgNode("svg"),
      path = svgNode("path"),
      dot = svgNode("circle");
    wave.setAttribute("viewBox", "0 0 200 40");
    wave.setAttribute("preserveAspectRatio", "none");
    wave.setAttribute("aria-hidden", "true");
    wave.classList.add("link-wave");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    dot.setAttribute("r", "3");
    wave.append(path, dot);
    // 두 주기를 그린다. 점은 지금 시간의 위치(첫 주기 안).
    const points = [];
    for (let i = 0; i <= 100; i++) {
      const u = Links.lfo(link.shape, 1, link.phase, (i / 100) * 2);
      points.push(`${i ? "L" : "M"}${i * 2} ${(36 - u * 32).toFixed(2)}`);
    }
    path.setAttribute("d", points.join(" "));
    // 주기 · 시작 위치: 라벨을 칸 위에 둔 두 칸 격자(좁은 패널에서도 줄이 꺾이지 않게)
    const timing = element("div", "link-pair"),
      cell = (label, field) => {
        const wrap = element("div", "link-end");
        wrap.append(element("span", "link-end-label", label), field);
        return wrap;
      };
    timing.append(
      cell(
        "주기(한 번 오가는 시간)",
        numberField("주기(초)", link.period, period => change({ period }), { min: 0.05, max: 3600, unit: "초" })
      ),
      cell(
        "시작 위치(0~1)",
        numberField("시작 위치(0~1, 한 주기 중 어디서 시작할지)", link.phase, phase => change({ phase }), {
          min: 0,
          max: 1,
          step: 0.05,
        })
      )
    );
    row(
      "입력",
      segmented("흔들기 모양", Object.entries(SHAPE_LABEL), link.shape, shape => change({ shape })),
      timing,
      wave
    );
    live.push(() => {
      const t = renderer.getStats().time ?? 0,
        x = (((t / link.period) % 1) + 1) % 1,
        u = Links.lfo(link.shape, link.period, link.phase, t);
      dot.setAttribute("cx", String(x * 100));
      dot.setAttribute("cy", String(36 - u * 32));
    });
  }
  if (link.source === "keys") {
    // 시간 기준: '한 번'(키 시간 = 재생 시간 uTime, 마지막 키 뒤로는 그 값 유지) · '반복'(uTime을 N초 길이로 잘라 되풀이)
    const looping = link.loop > 0,
      last = link.keys.length ? link.keys.at(-1)[0] : 0,
      mode = segmented(
        "키프레임 시간 기준",
        [
          ["once", "재생 시간 그대로(한 번)"],
          ["loop", "일정 길이로 반복"],
        ],
        looping ? "loop" : "once",
        next => change({ loop: next === "loop" ? Math.max(1, Math.ceil(last + 0.001)) : 0 })
      ),
      explain = element(
        "p",
        "link-note",
        looping
          ? `재생 시간(uTime)을 ${seconds(link.loop)} 길이로 잘라, 0 ~ ${seconds(link.loop)} 사이의 키를 끝없이 되풀이합니다. 키의 시간은 '바퀴 안의 시간'입니다.`
          : "키의 시간 = 재생 시간(uTime). 0초부터 키를 차례로 한 번 지나가고, 마지막 키 뒤로는 그 값을 유지합니다. 처음부터 다시 보려면 시간 초기화(⟲)."
      );
    row("시간 기준", mode, explain);
    if (looping) {
      const length = element("div", "link-inline"),
        status = element("p", "link-note link-loop-status"),
        outside = link.keys.filter(([t]) => t >= link.loop - 1e-9).length;
      length.append(
        numberField("반복 길이(초)", link.loop, loop => loop > 0 && change({ loop }), {
          min: 0.05,
          max: 3600,
          unit: "초",
        })
      );
      const warn = element(
        "p",
        "link-note link-warn",
        outside ? `반복 길이(${seconds(link.loop)}) 밖의 키 ${outside}개는 쓰이지 않습니다.` : ""
      );
      warn.hidden = !outside;
      row("반복 길이", length, status, warn);
      live.push(() => {
        const t = renderer.getStats().time ?? 0,
          cycle = Math.floor(t / link.loop);
        status.textContent = `지금 uTime ${t.toFixed(2)}초 → 바퀴 안 ${(t - cycle * link.loop).toFixed(2)}초 · ${cycle + 1}번째 바퀴`;
      });
    }
    const open = element("button", "link-open-timeline", "타임라인에서 편집");
    open.type = "button";
    open.addEventListener("click", () => openTimeline(item.name));
    row(
      "키",
      element("p", "link-note", `키 ${link.keys.length}개 — 시간 · 값은 파라미터 줄의 ◆ · 타임라인에서 고칩니다.`),
      open
    );
    row(
      "기본 잇기",
      segmented(
        "키 사이 기본 잇기(키마다 따로 정한 것은 그대로)",
        [
          ["smooth", "부드럽게"],
          ["linear", "직선"],
        ],
        link.ease,
        ease => change({ ease })
      ),
      element("p", "link-note", "키마다 다르게(계단 · 천천히 시작 등) 하려면 타임라인에서 키를 골라 '잇기'를 바꿉니다.")
    );
  }

  // ---- 출력: 범위 막대(손잡이 둘) · 뒤집기. 키프레임은 값을 그대로 쓰므로 없다. ----
  if (link.source !== "keys") {
    const lo = Math.min(low, link.min, link.max),
      hi = Math.max(high, link.min, link.max),
      step = item.type === "int" || item.type === "uint" ? 1 : (hi - lo) / 1000 || 0.001,
      track = element("div", "link-range"),
      fill = element("span", "link-range-fill"),
      ends = element("div", "link-range-ends"),
      inverted = link.min > link.max;
    let from = inverted ? link.max : link.min,
      to = inverted ? link.min : link.max;
    const slider = (label, value) => {
      const input = element("input");
      input.type = "range";
      input.min = String(lo);
      input.max = String(hi);
      input.step = String(step);
      input.value = String(value);
      input.setAttribute("aria-label", label);
      return input;
    };
    const a = slider("출력 아래 끝", from),
      b = slider("출력 위 끝", to),
      fromField = numberField("출력 아래 끝 값", format(from, span), v => commit(v, to)),
      toField = numberField("출력 위 끝 값", format(to, span), v => commit(from, v));
    const paint = () => {
      fill.style.left = `${((Math.min(from, to) - lo) / (hi - lo || 1)) * 100}%`;
      fill.style.right = `${100 - ((Math.max(from, to) - lo) / (hi - lo || 1)) * 100}%`;
    };
    const next = (f, t) => (inverted ? { min: t, max: f } : { min: f, max: t });
    const commit = (f, t) => change(next(Math.min(f, t), Math.max(f, t)));
    for (const [input, which] of [
      [a, "from"],
      [b, "to"],
    ]) {
      input.addEventListener("input", () => {
        const v = Number(input.value);
        if (which === "from") from = Math.min(v, to);
        else to = Math.max(v, from);
        input.value = String(which === "from" ? from : to);
        fromField.querySelector("input").value = format(from, span);
        toField.querySelector("input").value = format(to, span);
        paint();
        preview({ ...base, ...next(from, to) });
      });
      input.addEventListener("change", () => commit(from, to));
    }
    paint();
    track.append(fill, a, b);
    const flip = element("button", "link-flip", "⇅ 뒤집기");
    flip.type = "button";
    flip.setAttribute("aria-pressed", String(inverted));
    flip.title = "소스가 클수록 값이 작아지게(최소 · 최대를 맞바꿈)";
    flip.addEventListener("click", () => change({ min: link.max, max: link.min }));
    // 양 끝 칸 위에 '소스가 어떨 때의 값'인지 적는다(소스마다 말이 다르다)
    const [weak, strong] = END_LABEL[link.source] || ["약할 때", "셀 때"],
      end = (label, field) => {
        const wrap = element("div", "link-end");
        wrap.append(element("span", "link-end-label", label), field);
        return wrap;
      };
    ends.append(end(inverted ? strong : weak, fromField), flip, end(inverted ? weak : strong, toField));
    row("값 범위", track, ends);
  }

  // ---- 부드럽게 따라가기: 목표 값을 따라가는 시간(0 = 바로). 키프레임은 키를 늦게 따라가게 할 뿐이라 0이면 숨긴다 ----
  if (link.source !== "keys" || link.smooth > 0) {
    const smooth = element("input"),
      field = numberField("부드럽게 따라가는 시간(초)", link.smooth, value => change({ smooth: value }), {
        min: 0,
        max: 10,
        step: 0.01,
        unit: "초",
      }),
      line = element("div", "link-inline link-smooth");
    smooth.type = "range";
    smooth.min = "0";
    smooth.max = "2";
    smooth.step = "0.01";
    smooth.value = String(Math.min(2, link.smooth));
    smooth.setAttribute("aria-label", "부드럽게 따라가기: 0이면 바로");
    smooth.addEventListener("input", () => {
      field.querySelector("input").value = smooth.value;
      preview({ ...base, smooth: Number(smooth.value) });
    });
    smooth.addEventListener("change", () => change({ smooth: Number(smooth.value) }));
    line.append(smooth, field);
    row(
      "부드럽게 따라가기",
      line,
      element(
        "p",
        "link-note",
        link.source === "keys"
          ? "키프레임 값을 이 시간만큼 늦게 따라갑니다. 보통은 0초."
          : "0초 = 바로 바뀜. 값이 너무 튀면 0.1 ~ 0.3초."
      )
    );
  }

  // ---- 결과 ----
  const result = bar(`${item.name} 지금 값`),
    resultValue = element("output", "link-result-value");
  const resultLine = element("div", "link-inline link-result");
  resultLine.append(result.node, resultValue);
  row("결과", resultLine);
  let idle = null;
  node.append(grid);
  const update = current => {
    for (const draw of live) draw();
    const v = typeof current === "boolean" ? (current ? 1 : 0) : current;
    result.set((v - low) / (span || 1));
    resultValue.textContent = format(current, span, true);
    const now = renderer.linkActive ? !renderer.linkActive(item.name) : false;
    if (now !== idle) {
      // 입력이 없으면(까닭은 입력 칸 · 파라미터 줄이 말한다) 결과 막대를 흐리게
      idle = now;
      resultLine.classList.toggle("is-idle", now);
      resultLine.title = now ? "입력이 없어 값이 그대로입니다" : "";
    }
  };
  update(item.value);
  return { node, update };
};

export { sheet, meter, describe, format, rangeOf, SOURCE_LABEL };
