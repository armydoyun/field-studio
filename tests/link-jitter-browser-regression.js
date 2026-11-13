// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 연결 · 키프레임 화면이 흔들리지 않는지: 흔들기 · 키프레임(반복 · 한 번) 연결을 재생하면서 연결 시트 · 타임라인을 열고
// 1.5초 동안 50ms마다 파라미터 패널 · 타임라인 도크의 모든 요소 위치 · 크기를 잰다.
//  · 움직여도 되는 것(막대 채움 · 재생선 · 곡선 · 슬라이더 손잡이 자리)을 빼면 위치 · 크기가 그대로여야 한다
//  · 매 프레임 바뀌는 숫자 글자는 소수 자릿수가 고정돼야 한다(바뀌면 소수점 자리가 좌우로 튄다)
//  · 연결된 값 때문에 파라미터 목록 전체를 다시 그리지 않는다(요소가 바뀌지 않음)
(async () => {
  const autoAnswer = setInterval(() => { const d = document.getElementById("studioPromptDialog"), alt = document.getElementById("studioDialogAlt"); if (d?.open && !alt.hidden) alt.click(); }, 50);
  const r = window.shaderPlayground, studio = window.shaderStudio, settings = window.shaderSettings, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return; throw new Error(`FAIL: 시간 초과 — ${label}`); };
  const image = [
    "uniform float uGain;  // @range 0 1",
    "uniform float uWave;  // @range -2 2",
    "uniform float uSpeed; // @range 0 100",
    "uniform int uStep;    // @range 0 10",
    "void mainImage(out vec4 c, in vec2 p) { c = vec4(uGain * uSpeed / 100.0, uWave, float(uStep) / 10.0, 1.0); }",
  ].join("\n");
  const describe = el => `${el.closest("[data-name]")?.dataset.name || ""} ${el.tagName.toLowerCase()}.${[...el.classList].join(".")}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}`;
  const moving = el => el.closest("svg") || el.matches(".link-bar-fill, .timeline-playhead, .timeline-overlay, .timeline-edge, .link-range-fill");
  const audit = async label => {
    await wait(300);
    const nodes = [...document.querySelectorAll("#view-uniforms *, #timelineDock *")].filter(el => !moving(el) && el.getClientRects().length);
    const first = new Map(nodes.map(el => [el, el.getBoundingClientRect()])),
      lengths = new Map(),
      moved = new Set();
    for (let i = 0; i < 30; i++) {
      await wait(50);
      for (const el of nodes) {
        if (!el.isConnected) { moved.add(`${describe(el)} (다시 그림)`); continue; }
        const a = first.get(el), b = el.getBoundingClientRect();
        if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) > 0.5) moved.add(describe(el));
        // 오른쪽 정렬 숫자는 소수 자릿수만 같으면 소수점 자리가 그대로다(앞자리 · 부호가 느는 것은 자연스럽다)
        if (!el.children.length && el.type !== "range") {
          const text = String(el.value ?? el.textContent);
          for (const [index, number] of [...text.matchAll(/-?\d+(?:\.(\d+))?/g)].entries()) {
            const seen = lengths.get(el) || new Set();
            seen.add(`${index}:${number[1]?.length ?? 0}`);
            lengths.set(el, seen);
          }
        }
      }
    }
    test(!moved.size, `${label}: 움직인 요소 없음${moved.size ? ` — ${[...moved].slice(0, 5).join(", ")}` : ""}`);
    // 같은 자리(n번째 숫자)의 소수 자릿수가 두 가지 이상이면 흔들린다
    const jumpy = [...lengths]
      .filter(([, set]) => {
        const byIndex = new Map();
        for (const item of set) {
          const [index, digits] = item.split(":");
          byIndex.set(index, (byIndex.get(index) || new Set()).add(digits));
        }
        return [...byIndex.values()].some(digits => digits.size > 1);
      })
      .map(([el]) => describe(el));
    test(!jumpy.length, `${label}: 바뀌는 숫자의 자릿수 고정${jumpy.length ? ` — ${jumpy.slice(0, 5).join(", ")}` : ""}`);
  };
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    test(studio.setProject({ image, passes: [], imageChannels: {} }), "프로젝트");
    await until(() => r.getUserUniforms().length === 4, "파라미터 등록");
    settings.setLinks([
      { name: "uGain", source: "lfo", min: 0, max: 1, smooth: 0, shape: "sine", period: 1.3, phase: 0 },
      { name: "uWave", source: "lfo", min: -2, max: 2, smooth: 0.2, shape: "saw", period: 0.7, phase: 0 },
      { name: "uSpeed", source: "keys", min: 0, max: 1, smooth: 0, keys: [[0, 0.5], [1, 99.9], [2, 3.3]], loop: 2.5, ease: "smooth" },
      { name: "uStep", source: "keys", min: 0, max: 1, smooth: 0, keys: [[0, 0], [3, 10]], loop: 0, ease: "linear" },
    ]);
    $("tab-uniforms").click();
    if (!r.getStats().running) studio.togglePlayback();
    await audit("시트 닫힘");
    document.querySelector('.uniform-row[data-name="uGain"] .link-uniform').click();
    await audit("흔들기 시트");
    document.querySelector('.uniform-row[data-name="uSpeed"] .link-uniform').click();
    await audit("키프레임(반복) 시트");
    $("timelineToggle").click();
    await audit("타임라인 도크");
  } finally {
    clearInterval(autoAnswer);
    if (!$("timelineDock").hidden) $("timelineDock").querySelector(".timeline-close").click();
    settings?.setLinks?.([]);
    studio.setProject(before);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("연결 화면 흔들림 회귀 테스트 완료");
})();
