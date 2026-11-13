// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 키프레임 타임라인 도크(js/timeline.js · renderer.setTime · links.js 키 단위 잇기 · studio 되돌리기):
//  · 도구 막대 버튼으로 열고 닫기(이 브라우저에 기억) · 빈 안내 · '+ 파라미터'
//  · 눈금 누르기 = 재생 위치 · 재생 위치 숫자 입력
//  · 레인 추가 · 빈 곳 더블클릭으로 키 · 끌기(스냅 0.05초) · 선택한 키 칸(시간 · 값 · 잇기 숫자 입력)
//  · Shift 다중 선택 · 상자 선택 · 방향키로 함께 옮기기 · Delete · Ctrl+C/V(재생 위치에) · Ctrl+Z
//  · 확대 · 맞춤 · 반복 표시(더블클릭으로 없애기) · 레인 지우기
(async () => {
  const autoAnswer = setInterval(() => { const d = document.getElementById("studioPromptDialog"), alt = document.getElementById("studioDialogAlt"); if (d?.open && !alt.hidden) alt.click(); }, 50);
  const r = window.shaderPlayground, studio = window.shaderStudio, settings = window.shaderSettings, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return; throw new Error(`FAIL: 시간 초과 — ${label}`); };
  const value = name => r.getUserUniforms().find(u => u.name === name)?.value;
  const keysOf = name => JSON.stringify(settings.getLinks().find(l => l.name === name)?.keys || []);
  const dock = $("timelineDock"), q = s => dock.querySelector(s), body = () => q(".timeline-body");
  const lane = name => [...dock.querySelectorAll(".timeline-lane")].find(node => node.dataset.name === name);
  const plot = name => lane(name).querySelector(".timeline-plot");
  const dots = name => [...plot(name).querySelectorAll(".timeline-key")];
  const at = (node, fx, fy, extra = {}) => { const b = node.getBoundingClientRect(); return { clientX: b.left + b.width * fx, clientY: b.top + b.height * fy, bubbles: true, pointerId: 1, button: 0, ...extra }; };
  const center = (node, extra = {}) => at(node, 0.5, 0.5, extra);
  const pointer = (node, type, init) => node.dispatchEvent(new PointerEvent(type, init));
  const key = (k, extra = {}) => body().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
  const set = (node, v) => { node.value = String(v); node.dispatchEvent(new Event("change", { bubbles: true })); };
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
    if (r.getStats().running) studio.togglePlayback();
    r.setTime(0);

    // 0) 열고 닫기
    test(dock.hidden && $("timelineToggle").getAttribute("aria-pressed") === "false", "처음에는 닫힘");
    $("timelineToggle").click();
    await until(() => !dock.hidden && q(".timeline-add").options.length === 4, "도구 막대 버튼으로 열림");
    test($("timelineToggle").getAttribute("aria-pressed") === "true" && document.body.classList.contains("timeline-open"), "버튼 눌림 · 열림 표시");
    test(JSON.parse(localStorage.getItem("field.timeline.v1")).open === true, "열림을 기억");
    test(q(".timeline-empty")?.textContent.includes("키프레임 연결이 없습니다"), "빈 안내");
    test(dock.getBoundingClientRect().height > 100 && dock.getBoundingClientRect().top >= $("stage").getBoundingClientRect().bottom - 1, "미리보기 아래 도크");

    // 1) 눈금 · 재생 위치 입력(맞춤 길이 5초)
    const ruler = q(".timeline-ruler");
    pointer(ruler, "pointerdown", at(ruler, 0.4, 0.5));
    pointer(ruler, "pointerup", at(ruler, 0.4, 0.5));
    await until(() => near(r.getStats().time, 2, 2e-3), `눈금 40% → 2초 (${r.getStats().time})`);
    set(q(".timeline-time"), 2);
    await until(() => near(r.getStats().time, 2), "재생 위치 숫자 입력");

    // 2) 레인 추가 · 더블클릭으로 키 · 일시정지 중 시간 이동
    set(q(".timeline-add"), "uGain");
    await until(() => !!lane("uGain"), "uGain 레인");
    test(keysOf("uGain") === "[[2,0.2]]", `첫 키 ${keysOf("uGain")}`);
    test(q(".timeline-selection").textContent === "uGain 키" && q(".timeline-key-time").value === "2", "새 키가 선택되고 칸에 시간");
    plot("uGain").dispatchEvent(new MouseEvent("dblclick", at(plot("uGain"), 0.8, 0.25)));
    await until(() => JSON.parse(keysOf("uGain")).length === 2, "더블클릭으로 키");
    const added = JSON.parse(keysOf("uGain"))[1];
    test(near(added[0], 4) && Math.abs(added[1] - 0.75) < 0.03, `4초 · 약 0.75: ${added}`);
    r.setTime(4);
    await until(() => near(value("uGain"), added[1]), "4초 값");

    // 3) 끌기: 첫 키를 1초 · 바닥으로(0.05초 단위)
    let first = dots("uGain")[0];
    pointer(first, "pointerdown", center(first));
    pointer(document, "pointermove", at(plot("uGain"), 0.203, 1));
    pointer(document, "pointerup", at(plot("uGain"), 0.203, 1));
    await until(() => near(JSON.parse(keysOf("uGain"))[0][0], 1), `끌기 → 1초: ${keysOf("uGain")}`);
    test(Math.abs(JSON.parse(keysOf("uGain"))[0][1]) < 0.01, `끌기 → 값 0 근처: ${keysOf("uGain")}`);

    // 4) 선택한 키 칸: 시간 · 값 · 잇기
    first = dots("uGain")[0];
    pointer(first, "pointerdown", center(first));
    pointer(document, "pointerup", center(first));
    await until(() => q(".timeline-key-time").value === "1", "키를 누르면 칸에 시간");
    set(q(".timeline-key-time"), 1.234);
    await until(() => near(JSON.parse(keysOf("uGain"))[0][0], 1.234), "시간 숫자로 정확히");
    set(q(".timeline-key-value"), 0.5);
    await until(() => near(JSON.parse(keysOf("uGain"))[0][1], 0.5), "값 숫자로 정확히");
    set(q(".timeline-key-ease"), "step");
    await until(() => JSON.parse(keysOf("uGain"))[0][2] === "step", "잇기: 계단");
    r.setTime(3.9);
    await until(() => near(value("uGain"), 0.5), `계단: 다음 키 전까지 0.5 유지 (${value("uGain")})`);
    test(dots("uGain")[0].classList.contains("is-step") && dots("uGain")[0].classList.contains("is-selected"), "계단 키 모양 · 선택 표시");

    // 5) Shift 다중 선택 · 방향키 · 상자 선택 · Delete
    const second = dots("uGain")[1];
    pointer(second, "pointerdown", center(second, { shiftKey: true }));
    await until(() => q(".timeline-selection").textContent === "키 2개", "Shift로 둘 고르기");
    key("ArrowRight");
    await until(() => keysOf("uGain") === JSON.stringify([[1.284, 0.5, "step"], [4.05, added[1]]]), `→ 스냅 한 칸(0.05초) 함께: ${keysOf("uGain")}`);
    key("Escape");
    await until(() => q(".timeline-selection").textContent.startsWith("키를 고르면"), "Esc로 선택 해제");
    const area = lane("uGain").querySelector(".timeline-area");
    // 고르기 전·후에 막대·키 칸·레인의 자리가 같아야 끌어 고르는 도중 화면이 움직이지 않는다.
    const layoutBox = () => [q(".timeline-bar"), q(".timeline-inspector"), area].map(node => { const r = node.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(","); }).join(" | ");
    const emptyBox = layoutBox();
    pointer(area, "pointerdown", at(area, 0.01, 0.02));
    pointer(document, "pointermove", at(area, 0.5, 0.98));
    pointer(document, "pointerup", at(area, 0.5, 0.98));
    await until(() => q(".timeline-selection").textContent === "uGain 키", "상자 선택: 앞쪽 키 하나");
    test(layoutBox() === emptyBox, `키를 골라도 막대·키 칸·레인이 움직이지 않음 (${emptyBox} → ${layoutBox()})`);
    key("Delete");
    await until(() => JSON.parse(keysOf("uGain")).length === 1, "Delete로 지우기");

    // 6) 복사 · 붙여넣기(재생 위치) · 되돌리기
    const only = dots("uGain")[0];
    pointer(only, "pointerdown", center(only));
    pointer(document, "pointerup", center(only));
    key("c", { ctrlKey: true });
    r.setTime(2.5);
    key("v", { ctrlKey: true });
    await until(() => JSON.parse(keysOf("uGain")).some(([t]) => near(t, 2.5)), `Ctrl+V → 2.5초 ${keysOf("uGain")}`);
    const pasted = keysOf("uGain");
    key("z", { ctrlKey: true });
    await until(() => keysOf("uGain") !== pasted && JSON.parse(keysOf("uGain")).length === 1, `Ctrl+Z로 붙여넣기 되돌리기 ${keysOf("uGain")}`);
    key("z", { ctrlKey: true, shiftKey: true });
    await until(() => keysOf("uGain") === pasted, "Ctrl+Shift+Z로 다시");

    // 7) 확대 · 맞춤 · 반복 표시 · 레인 지우기
    const labels = () => [...dock.querySelectorAll(".timeline-tick.is-major")].map(t => t.textContent).join();
    const wide = labels();
    q('[aria-label="확대"]').click();
    q('[aria-label="확대"]').click();
    await until(() => labels() !== wide, "확대하면 눈금이 촘촘해짐");
    q(".timeline-fit").click();
    await until(() => labels() === wide, "맞춤");
    settings.setLinks(settings.getLinks().map(l => (l.name === "uGain" ? { ...l, loop: 4.5 } : l)));
    await until(() => !!lane("uGain").querySelector(".timeline-loop"), "반복 표시");
    lane("uGain").querySelector(".timeline-loop").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await until(() => settings.getLinks().find(l => l.name === "uGain").loop === 0, "반복 표시 더블클릭으로 없애기");
    set(q(".timeline-snap"), "f30");
    test(JSON.parse(localStorage.getItem("field.timeline.v1")).snap === "f30", "스냅 설정 기억");
    set(q(".timeline-add"), "uStep");
    await until(() => !!lane("uStep"), "uStep 레인");
    lane("uStep").querySelector(".timeline-lane-remove").click();
    await until(() => !lane("uStep") && !settings.getLinks().some(l => l.name === "uStep"), "레인 지우기 = 연결 지우기");

    // 8) 닫기
    q(".timeline-close").click();
    test(dock.hidden && JSON.parse(localStorage.getItem("field.timeline.v1")).open === false, "닫기 · 기억");
    document.body.focus();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    await until(() => !dock.hidden, "T로 열기");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    await until(() => dock.hidden, "T로 닫기");
    test($("moreMenu").contains($("timelineToggle")), "타임라인 버튼은 ⋯ 메뉴 안에");
  } finally {
    clearInterval(autoAnswer);
    if (!dock.hidden) q(".timeline-close").click();
    settings?.setLinks?.([]);
    studio.setProject(before);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("키프레임 타임라인 회귀 테스트 완료");
})();
