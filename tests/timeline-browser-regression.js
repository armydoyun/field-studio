// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 키프레임 타임라인(js/timeline.js · renderer.setTime):
//  · 접힌 상자를 열면 빈 안내 · '+ 파라미터'에 연결할 수 있는 파라미터
//  · 눈금 누르기 = 재생 위치 이동(일시정지 중에도 그 시간의 값으로 다시 그림) · 키보드 →
//  · 레인 추가(지금 시간 · 지금 값의 키) · 빈 곳 더블클릭으로 키 · 점 끌기(0.05초 단위) · 방향키 · Delete · 점 더블클릭
//  · int 레인은 정수 · 레인 지우기 · 길이 바꾸기 · 연결 편집 칸 · 자동 저장과 같은 자료
(async () => {
  const autoAnswer = setInterval(() => { const d = document.getElementById("studioPromptDialog"), alt = document.getElementById("studioDialogAlt"); if (d?.open && !alt.hidden) alt.click(); }, 50);
  const r = window.shaderPlayground, studio = window.shaderStudio, settings = window.shaderSettings, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return; throw new Error(`FAIL: 시간 초과 — ${label}`); };
  const value = name => r.getUserUniforms().find(u => u.name === name)?.value;
  const keysOf = name => settings.getLinks().find(l => l.name === name)?.keys || [];
  const root = $("timeline"), q = s => root.querySelector(s);
  const lane = name => [...root.querySelectorAll(".timeline-lane")].find(node => node.dataset.name === name);
  const area = name => lane(name).querySelector(".timeline-area");
  const plot = name => lane(name).querySelector(".timeline-plot"); // 키 점 · 곡선이 쓰는 칸(값의 위아래 기준)
  const dots = name => [...area(name).querySelectorAll(".timeline-key")];
  // 영역 안의 비율 위치(0~1)로 마우스 이벤트
  const at = (node, fx, fy) => { const b = node.getBoundingClientRect(); return { clientX: b.left + b.width * fx, clientY: b.top + b.height * fy, bubbles: true, pointerId: 1, button: 0 }; };
  const pointer = (node, type, init) => node.dispatchEvent(new PointerEvent(type, init));
  const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
  const image = [
    "uniform float uGain; // @range 0 1 @default 0.2",
    "uniform int uStep;   // @range 0 10",
    "uniform bool uOn;",
    "void mainImage(out vec4 c, in vec2 p) { c = vec4(uGain, float(uStep) / 10.0, uOn ? 1.0 : 0.0, 1.0); }",
  ].join("\n");
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    test(studio.setProject({ image, passes: [], imageChannels: {} }), "프로젝트");
    await until(() => r.getUserUniforms().length === 2, "어노테이션 파라미터 등록");
    r.defineUniform("uOn", "bool", false);
    settings.setLinks([]);
    if (r.getStats().running) studio.togglePlayback(); // 일시정지: 시간은 눈금으로만 움직인다
    $("tab-uniforms").click();
    root.open = true;
    await until(() => q(".timeline-add").options.length === 4, "타임라인 열림(파라미터 목록)");
    test(q(".timeline-empty")?.textContent.includes("키프레임 연결이 없습니다"), "빈 안내");
    const choices = [...q(".timeline-add").options].map(o => o.value).join();
    test(choices === ",uGain,uStep,uOn", `'+ 파라미터'에 float · int · bool: ${choices}`);

    // 1) 눈금 = 재생 위치(자동 길이 5초)
    test(q(".timeline-length").value === "5", "자동 길이 5초");
    pointer(q(".timeline-ruler"), "pointerdown", at(q(".timeline-ruler"), 0.4, 0.5));
    pointer(q(".timeline-ruler"), "pointerup", at(q(".timeline-ruler"), 0.4, 0.5));
    await until(() => near(r.getStats().time, 2, 1e-3), `눈금 40% → 2초 (${r.getStats().time})`);
    await until(() => q(".timeline-clock").textContent === "2.00s", "시계 표시");
    q(".timeline-ruler").focus();
    q(".timeline-ruler").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    test(near(r.getStats().time, 2.1, 1e-6), "→ 0.1초");
    r.setTime(2);

    // 2) 레인 추가: 지금 시간(2초) · 지금 값(0.2)
    const add = q(".timeline-add");
    add.value = "uGain";
    add.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => !!lane("uGain"), "uGain 레인");
    test(JSON.stringify(keysOf("uGain")) === "[[2,0.2]]", `첫 키 ${JSON.stringify(keysOf("uGain"))}`);
    test(document.activeElement === dots("uGain")[0], "새 키에 초점");
    test(lane("uGain") && $("uniformList").querySelector(".uniform-row[data-name='uGain'] .link-badge")?.textContent.includes("키프레임"), "파라미터 줄 배지도 키프레임");

    // 3) 빈 곳 더블클릭: 4초(80%) · 위에서 25%(값 0.75 — 범위 0~1)
    area("uGain").dispatchEvent(new MouseEvent("dblclick", at(plot("uGain"), 0.8, 0.25)));
    await until(() => keysOf("uGain").length === 2, "더블클릭으로 키");
    const added = keysOf("uGain")[1];
    test(near(added[0], 4) && Math.abs(added[1] - 0.75) < 0.03, `4초 · 약 0.75: ${added}`);

    // 4) 일시정지 중 시간을 옮기면 그 시간의 키프레임 값으로 다시 그린다
    r.setTime(4);
    await until(() => Math.abs(value("uGain") - added[1]) < 1e-6, `4초 값 ${value("uGain")}`);
    r.setTime(3);
    await until(() => value("uGain") > 0.3 && value("uGain") < 0.7, `3초는 사이 값 ${value("uGain")}`);

    // 5) 점 끌기: 첫 키를 1초(20%) · 바닥(0)으로, 0.05초 단위
    const first = dots("uGain")[0];
    pointer(first, "pointerdown", at(first, 0.5, 0.5));
    pointer(first, "pointermove", at(plot("uGain"), 0.203, 1));
    pointer(first, "pointerup", at(plot("uGain"), 0.203, 1));
    await until(() => near(keysOf("uGain")[0][0], 1), `끌기 → 1초(0.05초 단위): ${JSON.stringify(keysOf("uGain"))}`);
    test(near(keysOf("uGain")[0][1], 0), "끌기 → 값 0");

    // 6) 키보드: → 0.1초 · ↑ 범위의 1/100 · Delete
    dots("uGain")[0].focus();
    dots("uGain")[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await until(() => near(keysOf("uGain")[0][0], 1.1), "→ 0.1초");
    test(document.activeElement === dots("uGain")[0], "다시 그린 뒤에도 같은 키에 초점");
    dots("uGain")[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await until(() => near(keysOf("uGain")[0][1], 0.01), "↑ 0.01");
    dots("uGain")[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    test(near(r.getStats().time, 1.1), "Enter → 그 키의 시간으로");
    dots("uGain")[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await until(() => keysOf("uGain").length === 1, "Delete로 지우기");
    dots("uGain")[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await until(() => keysOf("uGain").length === 0, "점 더블클릭으로 지우기");

    // 7) int 레인: 값은 정수
    add.value = "uStep";
    add.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => !!lane("uStep"), "uStep 레인");
    area("uStep").dispatchEvent(new MouseEvent("dblclick", at(plot("uStep"), 0.6, 0.33)));
    await until(() => keysOf("uStep").length === 2, "int 레인 키");
    test(keysOf("uStep").every(([, v]) => Number.isInteger(v)), `int 값은 정수 ${JSON.stringify(keysOf("uStep"))}`);

    // 8) 길이 · 레인 지우기 · 저장
    q(".timeline-length").value = "20";
    q(".timeline-length").dispatchEvent(new Event("change", { bubbles: true }));
    await wait(30);
    test([...root.querySelectorAll(".timeline-tick")].map(t => t.textContent).join() === "0,5,10,15,20", "길이 20초 눈금");
    settings.save();
    test(JSON.parse(localStorage.getItem("webgl.raymarch-template.settings.v1")).links.some(l => l.name === "uStep" && l.source === "keys"), "자동 저장에 키프레임");
    lane("uStep").querySelector(".timeline-lane-remove").click();
    await until(() => !lane("uStep") && !settings.getLinks().some(l => l.name === "uStep"), "레인 지우기 = 연결 지우기");
  } finally {
    clearInterval(autoAnswer);
    root.open = false;
    settings?.setLinks?.([]);
    studio.setProject(before);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("키프레임 타임라인 회귀 테스트 완료");
})();
