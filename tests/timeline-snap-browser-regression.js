// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 타임라인 스냅(js/timeline.js): 시간 스냅과 따로 값 스냅을 고른다.
//  · 값 스냅 '범위 1/4': 격자선 5줄 · 위아래로 끌면 격자 값에 붙음 · ↑↓는 격자 한 칸
//  · 자석: 같은 레인의 다른 키 값이 격자보다 가까우면 거기에 붙음 · 끄면 격자에만
//  · Alt를 누르고 끌면 스냅 없음 · 절대 간격(0.1) · 설정 기억
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio, settings = window.shaderSettings, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return; throw new Error(`FAIL: 시간 초과 — ${label}`); };
  const dock = $("timelineDock"), q = s => dock.querySelector(s);
  const lane = () => [...dock.querySelectorAll(".timeline-lane")].find(node => node.dataset.name === "uGain");
  const plot = () => lane().querySelector(".timeline-plot");
  const dots = () => [...plot().querySelectorAll(".timeline-key")];
  const keys = () => settings.getLinks().find(l => l.name === "uGain").keys;
  const pointer = (node, type, init) => node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, ...init }));
  const set = (node, v) => { node.value = String(v); node.dispatchEvent(new Event("change", { bubbles: true })); };
  const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
  // 첫 키를 같은 시간에서 세로로만 끈다: 레인 높이의 fy 자리(0 = 맨 위 = 최대값)까지
  const dragFirst = async (fy, extra = {}) => {
    const dot = dots()[0], d = dot.getBoundingClientRect(), p = plot().getBoundingClientRect();
    const x = d.left + d.width / 2, before = JSON.stringify(keys());
    pointer(dot, "pointerdown", { clientX: x, clientY: d.top + d.height / 2 });
    pointer(document, "pointermove", { clientX: x, clientY: p.top + p.height * fy, ...extra });
    pointer(document, "pointerup", { clientX: x, clientY: p.top + p.height * fy, ...extra });
    await until(() => JSON.stringify(keys()) !== before, `끌기 반영(fy ${fy})`);
    return keys()[0][1];
  };
  const reset = async () => {
    settings.setLinks([{ name: "uGain", source: "keys", keys: [[1, 0.2], [3, 0.83]], loop: 0, ease: "linear" }]);
    await until(() => dots().length === 2 && near(keys()[0][1], 0.2), "키 두 개로 되돌림");
  };
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    if (wasRunning) studio.togglePlayback();
    test(studio.setProject({ image: "uniform float uGain; // @range 0 1 @default 0.2\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(uGain); }", passes: [], imageChannels: {} }), "파라미터 프로젝트");
    await until(() => r.getUserUniforms().length === 1, "파라미터 등록");
    settings.setLinks([{ name: "uGain", source: "keys", keys: [[1, 0.2], [3, 0.83]], loop: 0, ease: "linear" }]);
    if (dock.hidden) $("timelineToggle").click();
    await until(() => !dock.hidden && !!lane() && dots().length === 2, "타임라인에 레인과 키");
    r.setTime(0); // 재생선이 키에서 멀리 있게

    // 1) 기본: 값 스냅 끔(격자선 없음) · 자석 켬
    test(q(".timeline-value-snap").value === "0" && !lane().querySelector(".timeline-gridline"), "기본은 값 스냅 끔 · 격자선 없음");
    test(q(".timeline-magnet").getAttribute("aria-pressed") === "true", "자석은 기본으로 켜짐");
    test(q(".timeline-snap").getAttribute("aria-label") === "시간 스냅" && q(".timeline-value-snap").getAttribute("aria-label") === "값 스냅", "시간 스냅 · 값 스냅이 따로");

    // 2) 범위 1/4: 격자선 0 · 0.25 · 0.5 · 0.75 · 1
    set(q(".timeline-value-snap"), "d4");
    await until(() => lane().querySelectorAll(".timeline-gridline").length === 5, "격자선 5줄");
    let v = await dragFirst(0.42);
    test(near(v, 0.5), `0.58 근처로 끌면 0.5에 붙음: ${v}`);

    // 3) 자석: 다른 키 값(0.83)이 격자(0.75)보다 가까우면 그 값에 · 끄면 격자에만
    v = await dragFirst(0.18);
    test(near(v, 0.83), `0.82 근처 + 자석: 다른 키 값 0.83에 붙음: ${v}`);
    // 자석이 붙는 동안 점선(값 = 그 레인의 가로선)이 보이고, 놓으면 사라진다 · 버튼은 글자 없이 아이콘
    {
      await reset();
      const dot = dots()[0], d = dot.getBoundingClientRect(), p = plot().getBoundingClientRect(), x = d.left + d.width / 2;
      pointer(dot, "pointerdown", { clientX: x, clientY: d.top + d.height / 2 });
      pointer(document, "pointermove", { clientX: x, clientY: p.top + p.height * 0.18 });
      const guide = plot().querySelector(".timeline-guide.is-value");
      test(guide && !guide.hidden, "자석이 붙으면 값 점선이 보임");
      test(dots()[1].classList.contains("is-magnet-target"), "값이 붙은 대상 키(3초 · 0.83)를 강조");
      pointer(document, "pointermove", { clientX: x, clientY: p.top + p.height * 0.42 });
      test(guide.hidden, "자석에서 벗어나면 점선이 숨음");
      pointer(document, "pointerup", { clientX: x, clientY: p.top + p.height * 0.42 });
      await until(() => !plot().querySelector(".timeline-guide.is-value"), "놓으면 값 점선이 없어짐");
      test(!dock.querySelector(".is-magnet-target"), "놓으면 대상 강조도 없어짐");
      const m = q(".timeline-magnet");
      test(!m.textContent.trim() && m.classList.contains("icon-magnet") && m.getAttribute("aria-label").startsWith("자석"), "자석 버튼은 아이콘 + aria-label");
    }
    // 세로선: 키가 재생선과 같은 시간에 있으면, 위아래로만 끌어도(좌우 0 · 1px 떨림 모두) 계속 보이고 재생선이 굵어진다
    {
      await reset();
      r.setTime(1);
      await wait(50);
      const dot = dots()[0], d = dot.getBoundingClientRect(), p = plot().getBoundingClientRect(), x = d.left + d.width / 2;
      const vertical = () => dock.querySelector(".timeline-overlay .timeline-guide"), head = () => dock.querySelector(".timeline-playhead");
      pointer(dot, "pointerdown", { clientX: x, clientY: d.top + d.height / 2 });
      pointer(document, "pointermove", { clientX: x, clientY: p.top + p.height * 0.5 });
      test(!vertical().hidden && head().classList.contains("is-caught"), "좌우 0: 재생선에 붙은 세로선 · 재생선 굵게");
      pointer(document, "pointermove", { clientX: x + 1, clientY: p.top + p.height * 0.45 });
      test(!vertical().hidden && head().classList.contains("is-caught"), "좌우 1px 떨림에도 세로선 유지");
      pointer(document, "pointerup", { clientX: x + 1, clientY: p.top + p.height * 0.45 });
      await until(() => vertical().hidden && !head().classList.contains("is-caught"), "놓으면 세로선 · 굵은 재생선 해제");
      test(near(keys()[0][0], 1), `시간은 그대로 1초: ${keys()[0][0]}`);
      r.setTime(0);
    }
    // 값 스냅을 꺼도 자석은 동작한다(예전에는 격자가 없으면 '격자보다 가까운' 자석이 있을 수 없어 붙지 않았다)
    await reset();
    set(q(".timeline-value-snap"), "0");
    v = await dragFirst(0.19);
    test(near(v, 0.83), `값 스냅 끔 + 자석: 다른 키 값 0.83에 붙음: ${v}`);
    set(q(".timeline-value-snap"), "d4");
    await until(() => lane().querySelectorAll(".timeline-gridline").length === 5, "격자선 다시 5줄");
    await reset();
    q(".timeline-magnet").click();
    test(q(".timeline-magnet").getAttribute("aria-pressed") === "false", "자석 끔");
    v = await dragFirst(0.18);
    test(near(v, 0.75), `자석을 끄면 격자 0.75에: ${v}`);

    // 4) Alt: 스냅 없이 자유롭게
    await reset();
    v = await dragFirst(0.18, { altKey: true });
    test(Math.abs(v - 0.82) < 0.04 && !near(v, 0.75) && !near(v, 0.83), `Alt를 누르고 끌면 스냅 없음: ${v}`);

    // 5) ↑↓: 격자 한 칸씩(격자에 맞춘다)
    await reset();
    pointer(dots()[0], "pointerdown", { clientX: dots()[0].getBoundingClientRect().left + 5, clientY: dots()[0].getBoundingClientRect().top + 5 });
    pointer(document, "pointerup", {});
    const key = k => q(".timeline-body").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("ArrowUp");
    await until(() => near(keys()[0][1], 0.5), `↑: 0.2 → 다음 격자 근처(0.5): ${keys()[0][1]}`);
    key("ArrowUp");
    await until(() => near(keys()[0][1], 0.75), "↑ 한 번 더: 0.75");

    // 6) 절대 간격 0.1 · 설정 기억
    set(q(".timeline-value-snap"), "0.1");
    await until(() => lane().querySelectorAll(".timeline-gridline").length === 11, "0.1 간격 격자선 11줄");
    key("ArrowDown");
    await until(() => near(keys()[0][1], 0.7) || near(keys()[0][1], 0.6), `↓: 0.1 격자로: ${keys()[0][1]}`);
    const stored = JSON.parse(localStorage.getItem("field.timeline.v1"));
    test(stored.valueSnap === "0.1" && stored.magnet === false, "값 스냅 · 자석 설정 기억");
    set(q(".timeline-value-snap"), "0");
    await until(() => !lane().querySelector(".timeline-gridline"), "끄면 격자선 없음");
    console.log("타임라인 스냅 검사 통과");
  } finally {
    settings.setLinks([]);
    studio.setProject(before);
    if (wasRunning !== r.getStats().running) studio.togglePlayback();
    if (!dock.hidden) $("timelineToggle").click();
  }
})();
