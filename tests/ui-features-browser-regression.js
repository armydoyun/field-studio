// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 작은 UI 기능 묶음: 파라미터 기본값 되돌리기 · 갤러리 검색 · 무거운 예제 해상도 제안 · 브라우저 탭 제목.
(async () => {
  const $ = id => document.getElementById(id), renderer = window.shaderPlayground, studio = window.shaderStudio;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (condition()) return true; return condition(); };
  const area = $("studioCode"), live = $("studioLive");
  const setCode = text => { area.value = text; area.dispatchEvent(new Event("input", { bubbles: true })); };
  const value = name => renderer.getUserUniforms().find(u => u.name === name)?.value;
  const row = name => [...document.querySelectorAll("#uniformList .uniform-row")].find(r => r.querySelector(".uniform-name")?.textContent === name);
  const original = area.value, wasLive = live.checked, realStats = renderer.getStats;
  const scene = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uAmount; // @range 0 2 @default 0.5
uniform vec3 uTint;    // @color @default 1 0.5 0.25
uniform float uFree;   // @range 0 1
out vec4 fragColor;
void main() { fragColor = vec4(uTint * uAmount * (0.5 + uFree), 1.0); }
`;
  studio.open();
  live.checked = false;
  live.dispatchEvent(new Event("change"));
  try {
    // ---- 브라우저 탭 제목 ----
    test(document.title === "저장 안 한 작업 — FIELD Studio", `탭 제목 기본값: ${document.title}`);
    setCode(scene);
    test(document.title === "✎ 저장 안 한 작업 — FIELD Studio", `미적용 변경이면 ✎: ${document.title}`);
    test(studio.apply(), "어노테이션 장면 적용");
    test(document.title === "저장 안 한 작업 — FIELD Studio", "적용하면 ● 사라짐");
    setCode(scene.replace("fragColor = vec4", "fragColor = vec5"));
    studio.apply();
    test(document.title.startsWith("⚠ "), `컴파일 실패면 ⚠: ${document.title}`);
    setCode(scene);
    test(studio.apply() && !/^[●✎⚠]/.test(document.title), "다시 적용하면 표시 없음");

    // ---- 보관함에 저장한 뒤 바뀜(●) ----
    const P = studio.projects, toggle = $("projectMenuToggle");
    const answer = async value => {
      await until(() => $("studioPromptDialog").open, 2000);
      $("studioDialogInput").value = value;
      $("studioDialogForm").requestSubmit();
    };
    const marked = () => document.title.includes("● ") && toggle.dataset.modified === "true";
    await P.ready();
    await wait(1200);
    test(!marked(), "보관함에 없는 작업에는 ●를 붙이지 않는다(전부 저장 안 된 작업)");
    const name = `변경 추적 ${Date.now().toString(36)}`;
    let pending = P.save(false);
    await answer(name);
    test(await pending, "보관함에 저장");
    const savedId = P.current().id;
    try {
      await wait(1200);
      test(document.title === `${name} — FIELD Studio` && !marked(), `저장 직후 표시 없음: ${document.title}`);
      renderer.setUniform("uAmount", 1.25);
      test(await until(marked, 2500), `파라미터를 바꾸면 ● (탭 제목·프로젝트 메뉴): ${document.title}`);
      renderer.setUniform("uAmount", 0.5);
      test(await until(() => !marked(), 2500), "저장한 값으로 되돌리면 ● 사라짐");
      setCode(scene.replace("0.5 + uFree", "0.25 + uFree"));
      test(await until(() => document.title.startsWith("✎ ● "), 2500), `코드를 고치면(미적용) ✎와 ● 함께: ${document.title}`);
      test(studio.apply() && (await until(() => document.title.startsWith("● "), 2500)), "적용해도 저장 전이면 ●");
      pending = P.save(false); // 덮어쓰기는 묻지 않는다
      test(await pending, "덮어쓰기 저장");
      test(await until(() => !marked(), 2500), "저장하면 ● 사라짐");
      renderer.setFpsLimit(30);
      test(await until(marked, 2500), "렌더링 설정(프레임 제한)도 저장 대상이라 ●");
      renderer.setFpsLimit(0);
      document.body.classList.toggle("panel-hidden");
      await wait(1200);
      test(!marked(), "패널 숨김(이 기기의 화면 배치)은 변경으로 치지 않는다");
      document.body.classList.toggle("panel-hidden");
      setCode(scene);
      studio.apply();
      test(await until(marked, 2500), "저장 뒤 코드를 바꿈");
      test(await P.open(savedId), "보관함에서 다시 열기");
      test(await until(() => !marked(), 2500) && area.value.includes("0.25 + uFree"), "다시 열면 저장한 상태 · ● 없음");
      const stored = JSON.parse(localStorage.getItem("webgl.shader-studio.current-project.v1"));
      test(stored?.id === savedId && typeof stored.fingerprint === "string" && stored.fingerprint.length > 4, "저장 상태 지문을 브라우저에 기억(새로고침해도 비교)");
    } finally {
      pending = P.remove(savedId);
      await until(() => $("studioPromptDialog").open, 2000);
      $("studioDialogForm").requestSubmit();
      await pending;
    }

    // ---- 파라미터 기본값 되돌리기 ----
    $("tab-uniforms").click();
    await until(() => row("uAmount"), 2000);
    test(value("uAmount") === 0.5 && row("uAmount"), "@default로 등록");
    const reset = () => row("uAmount").querySelector(".reset-uniform");
    test(reset() && reset().disabled, "기본값이면 되돌리기 버튼 비활성");
    test(/0\.5/.test(reset().title), `버튼 설명에 기본값: ${reset().title}`);
    const slider = row("uAmount").querySelector('input[type="range"]');
    slider.value = "1.7";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    test(Math.abs(value("uAmount") - 1.7) < 1e-6, "슬라이더로 값 변경");
    test(!reset().disabled, "기본값과 다르면 버튼 활성(목록을 다시 그리지 않아도)");
    reset().click();
    test(value("uAmount") === 0.5, "버튼으로 기본값 복원");
    test(/uAmount 기본값으로 되돌림/.test($("uniformNotice").textContent), "되돌림 알림");
    test(reset().disabled, "복원 뒤 버튼 비활성");
    const slider2 = row("uAmount").querySelector('input[type="range"]');
    slider2.value = "0.1";
    slider2.dispatchEvent(new Event("input", { bubbles: true }));
    slider2.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    test(value("uAmount") === 0.5, "슬라이더 더블클릭으로 기본값 복원");
    // 색(vec3): 모든 성분을 되돌린다
    renderer.setUniform("uTint", [0, 0, 0]);
    $("uniformSearch").dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => !row("uTint")?.querySelector(".reset-uniform")?.disabled, 2000);
    row("uTint").querySelector(".reset-uniform").click();
    test(JSON.stringify(value("uTint")) === JSON.stringify([1, 0.5, 0.25]), `vec3 기본값 복원: ${value("uTint")}`);
    // @default가 없어도 어노테이션이 있으면 그 시작값(@range 최솟값 쪽)으로 되돌린다
    test(!!row("uFree")?.querySelector(".reset-uniform"), "@default 없는 어노테이션도 되돌리기 대상");

    // ---- 갤러리 검색 ----
    const dialog = $("gallery"), search = $("gallerySearch");
    const visible = () => [...dialog.querySelectorAll(".gallery-card")].filter(c => !c.hidden);
    const find = text => { search.value = text; search.dispatchEvent(new Event("input", { bubbles: true })); };
    $("galleryToggle").click();
    test(dialog.open, "갤러리 열림");
    // 같은 줄의 카드는 가장 높은 카드에 맞춰 늘어난다. 버튼 기본값(justify-content:center)이면 내용이 가운데로 내려가 썸네일 위에 여백이 생겼다.
    const gaps = [...dialog.querySelectorAll(".gallery-card")].map(card => {
      const box = card.getBoundingClientRect(), thumb = card.querySelector(".gallery-thumb").getBoundingClientRect();
      return Math.round(thumb.top - box.top - parseFloat(getComputedStyle(card).borderTopWidth));
    });
    test(gaps.every(gap => gap === 0), `모든 카드의 썸네일이 카드 맨 위에서 시작 (${gaps.filter(Boolean).length}개 어긋남)`);
    const total = dialog.querySelectorAll(".gallery-card").length;
    test(visible().length === total && $("galleryCount").textContent === "", "검색 전에는 모든 카드");
    find("sdf");
    test(visible().length > 0 && visible().length < total, `낱말 검색: ${visible().length} / ${total}`);
    test(visible().every(c => c.dataset.search.includes("sdf")), "남은 카드는 모두 낱말을 포함");
    test($("galleryCount").textContent === `${visible().length} / ${total}개`, "결과 개수 표시");
    test(dialog.classList.contains("is-searching"), "검색 중에는 안내 문단을 숨김");
    find("OCEAN water");
    test(visible().length === 1 && visible()[0].dataset.id === "ocean", "대소문자 무시 · 여러 낱말은 모두 포함(AND)");
    test([...dialog.querySelectorAll(".gallery-section")].filter(s => !s.hidden).length === 1, "결과 없는 묶음은 제목째 숨김");
    find("afl_ext");
    test(visible().some(c => c.dataset.id === "ocean"), "원작자 이름으로 찾기");
    find("zzqx없는낱말");
    test(visible().length === 0 && !$("galleryEmpty").hidden, "결과 없음 안내");
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    test(search.value === "" && dialog.open && visible().length === total, "Esc는 검색어만 지우고 갤러리는 열어 둠");
    $("galleryClose").focus();
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
    test(document.activeElement === search, "/ 로 검색창 포커스");
    find("metaball");
    let loaded = null;
    const onLoaded = event => { loaded = event.detail; };
    document.addEventListener("gallery-example-loaded", onLoaded);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until(() => loaded, 5000);
    document.removeEventListener("gallery-example-loaded", onLoaded);
    test(!dialog.open && loaded?.id === visible()[0].dataset.id, `Enter로 첫 결과 열기: ${loaded?.id}`);

    // ---- 무거운 예제 해상도 제안 ----
    // 실제 FPS는 환경마다 달라서 getStats의 fps만 낮게 바꿔 본다(설정 패널은 같은 renderer 객체를 쓴다).
    renderer.setResolutionScale(1);
    let fakeFps = 12;
    renderer.getStats = () => ({ ...realStats(), fps: fakeFps, running: true });
    const box = $("perfSuggest"), load = (id = "fake-heavy") =>
      document.dispatchEvent(new CustomEvent("gallery-example-loaded", { detail: { id, title: "Heavy Test", level: "extreme" } }));
    load();
    await wait(1500);
    test(box.hidden, "곧바로 묻지 않는다(FPS가 안정될 때까지 기다림)");
    test(await until(() => !box.hidden, 4000), "낮은 FPS면 제안 표시");
    test(/Heavy Test/.test(box.textContent) && /12 FPS/.test(box.textContent), `제안 문구: ${box.textContent}`);
    test($("perfSuggestApply").textContent === "75%로 낮추기", "100%에서는 75%를 제안");
    $("perfSuggestApply").click();
    test(realStats().resolutionScale === 0.75 && box.hidden, "낮추기 → 해상도 배율 75%");
    load();
    test(await until(() => !box.hidden, 5000) && $("perfSuggestApply").textContent === "50%로 낮추기", "75%에서는 50%를 제안");
    $("perfSuggestDismiss").click();
    test(box.hidden && realStats().resolutionScale === 0.75, "그대로 두기 → 배율 유지");
    load();
    await wait(3600);
    test(box.hidden, "그대로 두기를 고른 예제는 다시 묻지 않는다");
    fakeFps = 55;
    load("fast-one");
    await wait(3600);
    test(box.hidden, "FPS가 충분하면 묻지 않는다");
    fakeFps = 12;
    renderer.setResolutionScale(0.5);
    load("at-floor");
    await wait(3600);
    test(box.hidden, "이미 50% 이하면 묻지 않는다");
    renderer.getStats = realStats;
    renderer.setResolutionScale(1);
    console.log("UI 기능 회귀 검사 통과");
  } finally {
    renderer.getStats = realStats;
    renderer.setResolutionScale(1);
    $("gallery").open && $("gallery").close();
    setCode(original);
    studio.apply();
    live.checked = wasLive;
    live.dispatchEvent(new Event("change"));
  }
})();
