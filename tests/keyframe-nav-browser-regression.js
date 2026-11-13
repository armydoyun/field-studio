// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 키프레임 정밀 입력(ui.js의 키프레임 줄): 내비게이터 ◀ ◆ ▶ · 재생 위치 숫자 입력 · 자동 키
//  · 재생 위치를 숫자로 2.5초에 → 숫자 칸에 0.42 → 2.5초에 정확히 0.42 키(드래그 없이)
//  · 같은 시간에서 값을 다시 바꾸면 그 키의 값만 바뀐다(키가 늘지 않음) · 슬라이더를 끄는 동안 저장 · 다시 그리기 없음
//  · ◆: 키가 있으면 채워짐, 누르면 지움 / 없으면 지금 값으로 찍음 · ◀ ▶: 이전 · 다음 키로 재생선
//  · int · bool 줄도 자동 키 · 저장된 값은 렌더 시간에 맞음
(async () => {
  const autoAnswer = setInterval(() => { const d = document.getElementById("studioPromptDialog"), alt = document.getElementById("studioDialogAlt"); if (d?.open && !alt.hidden) alt.click(); }, 50);
  const r = window.shaderPlayground, studio = window.shaderStudio, settings = window.shaderSettings, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return; throw new Error(`FAIL: 시간 초과 — ${label}`); };
  const value = name => r.getUserUniforms().find(u => u.name === name)?.value;
  const keysOf = name => JSON.stringify(settings.getLinks().find(l => l.name === name)?.keys || []);
  const row = name => [...$("uniformList").querySelectorAll(".uniform-row")].find(node => node.dataset.name === name);
  const nav = (name, label) => row(name).querySelector(`.key-nav [aria-label="${name} ${label}"]`);
  const timeField = name => row(name).querySelector(".key-nav-time");
  const set = (node, v, type = "change") => { node.value = String(v); node.dispatchEvent(new Event(type, { bubbles: true })); };
  const image = [
    "uniform float uGain; // @range 0 1",
    "uniform int uStep;   // @range 0 10",
    "uniform bool uOn;",
    "void mainImage(out vec4 c, in vec2 p) { c = vec4(uGain, float(uStep) / 10.0, uOn ? 1.0 : 0.0, 1.0); }",
  ].join("\n");
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    test(studio.setProject({ image, passes: [], imageChannels: {} }), "프로젝트");
    await until(() => r.getUserUniforms().length === 2, "파라미터 등록");
    r.defineUniform("uOn", "bool", false);
    if (r.getStats().running) studio.togglePlayback();
    r.setTime(0);
    settings.setLinks([
      { name: "uGain", source: "keys", min: 0, max: 1, smooth: 0, keys: [[0, 0.1], [4, 0.9]], loop: 0, ease: "linear" },
      { name: "uStep", source: "keys", min: 0, max: 1, smooth: 0, keys: [[0, 0]], loop: 0, ease: "linear" },
      { name: "uOn", source: "keys", min: 0, max: 1, smooth: 0, keys: [[0, 0]], loop: 0, ease: "linear" },
    ]);
    $("tab-uniforms").click();
    await until(() => !!row("uGain")?.querySelector(".key-nav"), "키프레임 줄에 내비게이터");
    test(!row("uGain").querySelector(".link-meter") && !!row("uGain").querySelector('input[type="range"]'), "키프레임 줄은 미터 대신 슬라이더");

    // 1) 재생 위치를 숫자로 → 값을 숫자로 → 정확한 키
    set(timeField("uGain"), 2.5);
    await until(() => Math.abs(r.getStats().time - 2.5) < 1e-9, "재생 위치 2.5초");
    await until(() => nav("uGain", "이 시간에 키").getAttribute("aria-pressed") === "false", "2.5초에는 키 없음(◆ 빈 칸)");
    await until(() => Math.abs(value("uGain") - 0.6) < 1e-6, `2.5초의 직선 보간 값 0.6: ${value("uGain")}`);
    const number = row("uGain").querySelector('input[type="number"]:not(.key-nav-time)');
    set(number, 0.42);
    await until(() => keysOf("uGain") === "[[0,0.1],[2.5,0.42],[4,0.9]]", `자동 키 ${keysOf("uGain")}`);
    await until(() => nav("uGain", "이 시간에 키")?.getAttribute("aria-pressed") === "true", "◆ 채워짐");
    set(row("uGain").querySelector('input[type="number"]:not(.key-nav-time)'), 0.3);
    await until(() => keysOf("uGain") === "[[0,0.1],[2.5,0.3],[4,0.9]]", "같은 시간이면 그 키의 값만");

    // 2) 슬라이더 끌기: 끄는 동안 다시 그리지 않고, 놓으면 저장
    r.setTime(1);
    await wait(30);
    const slider = row("uGain").querySelector('input[type="range"]');
    slider.focus();
    slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    set(slider, 0.7, "input");
    await wait(900);
    test(document.contains(slider), "끄는 동안(누르고 있는 동안) 줄을 다시 그리지 않음");
    test(Math.abs(value("uGain") - 0.7) < 1e-6, "끄는 동안 값이 바로 보임");
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => keysOf("uGain") === "[[0,0.1],[1,0.7],[2.5,0.3],[4,0.9]]", `놓으면 저장 ${keysOf("uGain")}`);

    // 3) ◀ ▶ · ◆ 지우기 / 찍기
    nav("uGain", "다음 키로").click();
    await until(() => Math.abs(r.getStats().time - 2.5) < 1e-9, "▶ → 2.5초");
    nav("uGain", "이전 키로").click();
    await until(() => Math.abs(r.getStats().time - 1) < 1e-9, "◀ → 1초");
    await until(() => nav("uGain", "이 시간에 키").getAttribute("aria-pressed") === "true", "1초에 키");
    nav("uGain", "이 시간에 키").focus();
    nav("uGain", "이 시간에 키").click();
    await until(() => keysOf("uGain") === "[[0,0.1],[2.5,0.3],[4,0.9]]", "◆ 누르면 그 키 지움");
    test(document.activeElement === nav("uGain", "이 시간에 키"), "다시 그린 뒤에도 ◆에 초점");
    r.setTime(3);
    await until(() => nav("uGain", "이 시간에 키").getAttribute("aria-pressed") === "false", "3초 빈 칸");
    const at3 = value("uGain");
    nav("uGain", "이 시간에 키").click();
    await until(() => JSON.parse(keysOf("uGain")).some(([t, v]) => t === 3 && Math.abs(v - at3) < 1e-6), "◆ 누르면 지금 값으로 키");
    test(nav("uGain", "다음 키로").disabled === false && (r.setTime(4), true), "다음 키 있음");
    await until(() => nav("uGain", "다음 키로").disabled, "마지막 키에서는 ▶ 꺼짐");

    // 4) int · bool 줄도 자동 키
    r.setTime(2);
    await wait(30);
    set(row("uStep").querySelector('input[type="number"]:not(.key-nav-time)'), 7);
    await until(() => keysOf("uStep") === "[[0,0],[2,7]]", `int 자동 키 ${keysOf("uStep")}`);
    const toggle = row("uOn").querySelector('input[type="checkbox"]');
    toggle.click();
    await until(() => keysOf("uOn") === "[[0,0],[2,1]]", `bool 자동 키 ${keysOf("uOn")}`);

    // 5) 반복이 있으면 키 시간은 바퀴 안의 시간: 4초 반복에서 재생 위치 5.5초 → 1.5초에 키, ▶은 이 바퀴의 다음 키(4 + 2.5)
    settings.setLinks(settings.getLinks().map(l => (l.name === "uGain" ? { ...l, keys: [[0, 0.1], [2.5, 0.3]], loop: 4 } : l)));
    await until(() => !!row("uGain")?.querySelector(".key-nav"), "다시 그림");
    r.setTime(5.5);
    await until(() => row("uGain").querySelector(".key-nav-local").textContent === "바퀴 안 1.50초", "바퀴 안 시간 표시");
    test(row("uGain").querySelector(".key-nav-mode").textContent === "↻ 4초", "시간 기준 표시: 4초마다 반복");
    set(row("uGain").querySelector('input[type="number"]:not(.key-nav-time)'), 0.8);
    await until(() => keysOf("uGain") === "[[0,0.1],[1.5,0.8],[2.5,0.3]]", `반복 안 시간에 키 ${keysOf("uGain")}`);
    nav("uGain", "다음 키로").click();
    await until(() => Math.abs(r.getStats().time - 6.5) < 1e-9, `▶ → 6.5초 (${r.getStats().time})`);
    settings.setLinks(settings.getLinks().map(l => (l.name === "uGain" ? { ...l, keys: [[0, 0.1], [2.5, 0.3]], loop: 0 } : l)));

    // 5) 저장된 키는 렌더 시간에 맞는다
    r.beginOffline({ width: 8, height: 8 });
    try {
      r.renderOfflineFrame({ time: 2.5, delta: 0.05, frame: 50 });
      test(Math.abs(value("uGain") - 0.3) < 1e-6, `영상 렌더 2.5초 = 0.3 (${value("uGain")})`);
    } finally {
      r.endOffline();
    }
  } finally {
    clearInterval(autoAnswer);
    settings?.setLinks?.([]);
    studio.setProject(before);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("키프레임 정밀 입력 회귀 테스트 완료");
})();
