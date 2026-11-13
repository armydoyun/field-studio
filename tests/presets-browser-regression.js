// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 파라미터 프리셋(js/presets.js · settings.js · ui.js의 프리셋 막대):
//  · '지금 값 저장'(이름 묻기) → 칩 · 즉시 전환 · 1초 동안 부드럽게 전환(중간값) · 지금 값과 같은 칩은 눌린 상태
//  · ↺ 덮어쓰기 · 이름 바꾸기(두 번 누르기) · ✕ 삭제와 되돌리기
//  · 자동 저장 · 프로젝트 파일(Pack)에 담김 · 다시 열면 복원 · 새 프로젝트는 프리셋 없이 · Undo로 돌아옴
(async () => {
  // 작업을 바꿀 때 뜨는 '저장하지 않은 변경' 확인(세 갈래)에는 '저장하지 않고 계속'으로 답한다.
  const autoAnswer = setInterval(() => { const d = document.getElementById("studioPromptDialog"), alt = document.getElementById("studioDialogAlt"); if (d?.open && !alt.hidden) alt.click(); }, 50);
  const r = window.shaderPlayground, studio = window.shaderStudio, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return; throw new Error(`FAIL: 시간 초과 — ${label}`); };
  const value = name => r.getUserUniforms().find(u => u.name === name)?.value;
  const chips = () => [...$("presetList").querySelectorAll(".preset-chip")];
  const chip = name => chips().find(c => c.querySelector(".preset-apply").textContent === name);
  const answer = async text => {
    await until(() => $("studioPromptDialog").open, "이름 입력 창");
    $("studioDialogInput").value = text;
    $("studioDialogOK").click();
    await until(() => !$("studioPromptDialog").open, "입력 창 닫힘");
  };
  const downloads = [], realClick = HTMLAnchorElement.prototype.click, realUrl = URL.createObjectURL, blobs = new Map();
  URL.createObjectURL = blob => { const url = realUrl.call(URL, blob); blobs.set(url, blob); return url; };
  HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(blobs.get(this.href)); else realClick.call(this); };
  const image = [
    "uniform float uGain;  // @range 0 1 @default 0.2",
    "uniform vec3 uTint;   // @color @default 1 0 0",
    "uniform int uMode;    // @enum 하나 둘 셋 @default 0",
    "void mainImage(out vec4 c, in vec2 p) { c = vec4(uTint * uGain, float(uMode)); }",
  ].join("\n");
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    if (!wasRunning) studio.togglePlayback();
    test(studio.setProject({ image, passes: [], imageChannels: {} }), "어노테이션 파라미터 3개");
    await until(() => r.getUserUniforms().length === 3, "파라미터 등록");
    window.shaderSettings?.setPresets?.([]);
    $("tab-uniforms").click();
    await wait(50);
    test(!$("presetSave").disabled && $("presetList").textContent.includes("저장한 프리셋이 없습니다"), "빈 프리셋 막대");

    // 1) 저장: 낮(기본값) · 밤(바꾼 값)
    $("presetSave").click(); await answer("낮");
    r.setUniform("uGain", 1); r.setUniform("uTint", [0, 0, 1]); r.setUniform("uMode", 2);
    $("presetSave").click(); await answer("밤");
    await wait(50);
    test(chips().map(c => c.querySelector(".preset-apply").textContent).join() === "낮,밤", "칩 두 개");
    test(chip("밤").querySelector(".preset-apply").getAttribute("aria-pressed") === "true", "지금 값과 같은 '밤'이 눌린 상태");

    // 2) 즉시 전환
    $("presetBlend").value = "0";
    chip("낮").querySelector(".preset-apply").click();
    await wait(20);
    test(value("uGain") === 0.2 && JSON.stringify(value("uTint")) === "[1,0,0]" && value("uMode") === 0, `즉시 '낮': ${value("uGain")} ${value("uTint")} ${value("uMode")}`);
    await until(() => chip("낮").querySelector(".preset-apply").getAttribute("aria-pressed") === "true", "'낮' 눌림");

    // 3) 1초 동안 부드럽게: 중간에는 사이 값, @enum은 가운데에서 바뀜, 끝에는 '밤'
    $("presetBlend").value = "1";
    chip("밤").querySelector(".preset-apply").click();
    await wait(450);
    const mid = value("uGain");
    test(mid > 0.25 && mid < 0.95 && value("uTint")[2] > 0 && value("uTint")[2] < 1, `전환 중간: uGain ${mid.toFixed(2)} · uTint ${value("uTint").map(v => v.toFixed(2))}`);
    await until(() => value("uGain") === 1, "전환 끝");
    test(JSON.stringify(value("uTint")) === "[0,0,1]" && value("uMode") === 2, "끝에는 '밤' 그대로");

    // 4) 덮어쓰기 · 이름 바꾸기 · 삭제와 되돌리기
    r.setUniform("uGain", 0.5);
    chip("밤").querySelector(".preset-update").click();
    test(window.shaderSettings.getPresets().find(p => p.name === "밤").values.uGain === 0.5, "↺ 지금 값으로 덮어쓰기");
    chip("밤").querySelector(".preset-apply").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await answer("깊은 밤");
    await wait(30);
    test(!!chip("깊은 밤") && !chip("밤"), "이름 바꾸기");
    chip("낮").querySelector(".preset-remove").click();
    await wait(30);
    test(!chip("낮") && !$("presetUndo").hidden, "삭제 → 되돌리기 버튼");
    $("presetUndo").click();
    await wait(30);
    test(chips().map(c => c.querySelector(".preset-apply").textContent).join() === "낮,깊은 밤", "되돌리면 원래 자리로");

    // 5) 저장: 자동 저장(브라우저) · 프로젝트 파일(Pack)
    window.shaderSettings.save();
    const stored = JSON.parse(localStorage.getItem("webgl.raymarch-template.settings.v1"));
    test(stored.presets.map(p => p.name).join() === "낮,깊은 밤", "브라우저 자동 저장에 프리셋");
    await studio.exportPack();
    const pack = JSON.parse(await downloads.at(-1).text());
    test(pack.settings.presets.length === 2 && pack.settings.presets[1].values.uGain === 0.5, "프로젝트 파일(Pack)에 프리셋");

    // 6) 새 프로젝트는 프리셋 없이 · Undo로 돌아옴 · Pack을 다시 열면 복원
    test(await studio.loadExample({ image: "void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }", passes: [], imageChannels: {} }, []), "새 프로젝트");
    await wait(30);
    test(window.shaderSettings.getPresets().length === 0 && $("presetList").textContent.includes("저장한 프리셋이 없습니다"), "새 프로젝트에는 프리셋이 없다");
    studio.undo();
    await wait(30);
    test(window.shaderSettings.getPresets().map(p => p.name).join() === "낮,깊은 밤", "Undo로 이전 프로젝트의 프리셋까지 돌아온다");
    window.shaderSettings.setPresets([]);
    await studio.importPack(new File([JSON.stringify(pack)], "pack.json", { type: "application/json" }));
    await until(() => window.shaderSettings.getPresets().length === 2, "Pack 열기");
    test(window.shaderSettings.getPresets()[0].name === "낮", "Pack을 열면 프리셋 복원");
  } finally {
    clearInterval(autoAnswer);
    HTMLAnchorElement.prototype.click = realClick;
    URL.createObjectURL = realUrl;
    window.shaderSettings?.setPresets?.([]);
    studio.setProject(before);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("파라미터 프리셋 회귀 테스트 완료");
})();
