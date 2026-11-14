// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 파라미터 프리셋(js/presets.js · settings.js · ui.js의 프리셋 막대):
//  · '지금 값 저장'(이름을 묻지 않고 바로 저장 · 두 번 눌러 이름 바꾸기) → 칩 · 즉시 전환 · 1초 동안 부드럽게 전환(중간값) · 지금 값과 같은 칩은 눌린 상태
//  · ⋯ 메뉴: 덮어쓰기(바뀌는 값을 보여 주고 확인 · 취소 · 되돌리기 · Ctrl+Z) · 이름 바꾸기 · 삭제와 되돌리기
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

    test($("presetBar").classList.contains("is-empty") && getComputedStyle($("presetBlend").closest(".preset-blend")).display === "none", "프리셋이 없으면 한 줄(전환 시간 숨김)");

    // 1) 저장: 이름을 묻지 않고 바로 '프리셋 N'으로 저장 → 칩을 두 번 눌러 이름 바꾸기. 낮(기본값) · 밤(바꾼 값)
    const saveAs = async (auto, text) => {
      $("presetSave").click();
      await until(() => chip(auto), `바로 저장: '${auto}'`);
      test(!$("studioPromptDialog").open, `'${auto}' 저장에 이름 창이 뜨지 않음`);
      chip(auto).querySelector(".preset-apply").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await answer(text);
      await until(() => chip(text), `이름 바꿈: '${text}'`);
    };
    await saveAs("프리셋 1", "낮");
    r.setUniform("uGain", 1); r.setUniform("uTint", [0, 0, 1]); r.setUniform("uMode", 2);
    await saveAs("프리셋 2", "밤");
    await wait(50);
    test(chips().map(c => c.querySelector(".preset-apply").textContent).join() === "낮,밤", "칩 두 개");
    test(chip("밤").querySelector(".preset-apply").getAttribute("aria-pressed") === "true", "지금 값과 같은 '밤'이 눌린 상태");

    // 2) 즉시 전환
    $("presetBlend").value = "0";
    chip("낮").querySelector(".preset-apply").click();
    await wait(20);
    test(value("uGain") === 0.2 && JSON.stringify(value("uTint")) === "[1,0,0]" && value("uMode") === 0, `즉시 '낮': ${value("uGain")} ${value("uTint")} ${value("uMode")}`);
    await until(() => chip("낮").querySelector(".preset-apply").getAttribute("aria-pressed") === "true", "'낮' 눌림");

    // 3) 중간값은 rAF 시각을 직접 제어한다. wait(450)는 CPU/GPU가 바쁘면 이전 프레임의
    // 값을 읽을 수 있다. 시간만 더 기다리면 반대로 전환이 끝나 버리므로 대기 시간을 늘리지 않는다.
    const realFrame = window.requestAnimationFrame, realCancel = window.cancelAnimationFrame;
    const ownNow = Object.getOwnPropertyDescriptor(performance, "now");
    const pending = new Map();
    let frameId = 0, now = 1000;
    const step = ms => {
      now = 1000 + ms;
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(now);
    };
    try {
      Object.defineProperty(performance, "now", { configurable: true, value: () => now });
      window.requestAnimationFrame = callback => { const id = --frameId; pending.set(id, callback); return id; };
      window.cancelAnimationFrame = id => { if (id < 0) pending.delete(id); else realCancel.call(window, id); };
      $("presetBlend").value = "1";
      chip("밤").querySelector(".preset-apply").click();
      test($("presetBar").classList.contains("is-morphing") && pending.size > 0, "1초 전환 시작");
      step(0);
      test(value("uGain") === 0.2 && JSON.stringify(value("uTint")) === "[1,0,0]" && value("uMode") === 0, "시작 프레임은 '낮' 그대로");
      step(250);
      test(Math.abs(value("uGain") - 0.325) < 0.006 && Math.abs(value("uTint")[2] - 0.15625) < 0.001 && value("uMode") === 0, "250ms: ease 보간 · enum은 시작 값");
      step(500);
      test(Math.abs(value("uGain") - 0.6) < 0.001 && JSON.stringify(value("uTint")) === "[0.5,0,0.5]" && value("uMode") === 2, "500ms: 실수·색 중간값 · enum은 목표 값");
      step(1000);
      test(value("uGain") === 1 && JSON.stringify(value("uTint")) === "[0,0,1]" && value("uMode") === 2 && !$("presetBar").classList.contains("is-morphing"), "1000ms: 모든 값 확정 · 전환 UI 종료");
    } finally {
      window.requestAnimationFrame = realFrame;
      window.cancelAnimationFrame = realCancel;
      if (ownNow) Object.defineProperty(performance, "now", ownNow);
      else delete performance.now;
      // 실패 경로에서도 남은 콜백을 실제 스케줄러로 돌려놓는다.
      for (const callback of pending.values()) realFrame.call(window, callback);
    }

    // 실제 브라우저 rAF 경로도 확인한다. 끝값 반올림만 먼저 도착할 수 있으므로 전환 UI 종료까지 기다린다.
    $("presetBlend").value = "0";
    chip("낮").querySelector(".preset-apply").click();
    $("presetBlend").value = "1";
    chip("밤").querySelector(".preset-apply").click();
    await until(() => value("uGain") === 1 && JSON.stringify(value("uTint")) === "[0,0,1]" && value("uMode") === 2 && !$("presetBar").classList.contains("is-morphing"), "실제 rAF로 '밤' 전환 완료");
    test(true, "실제 브라우저 프레임에서도 '밤' 전환 완료");

    // 4) 관리 메뉴(⋯): 덮어쓰기는 바뀌는 값을 보여 주고 묻는다(취소하면 그대로) · 되돌리기 · Ctrl+Z · 이름 바꾸기 · 삭제
    const menu = name => { chip(name).querySelector(".preset-more").click(); return chip(name).querySelector(".preset-menu"); };
    const item = (node, text) => [...node.querySelectorAll(".preset-menu-item")].find(b => b.textContent.startsWith(text));
    test(!chip("밤").querySelector(".preset-update, .preset-remove") && !!chip("밤").querySelector(".preset-more"), "칩에는 이름과 ⋯만(덮어쓰기 · 삭제 버튼이 칩에 없다)");
    let m = menu("밤");
    test(chip("밤").querySelector(".preset-more").getAttribute("aria-expanded") === "true" && document.activeElement === item(m, "이름 바꾸기"), "지금 값과 같으면 덮어쓰기는 꺼져 있고 다음 항목에 초점");
    test(item(m, "지금 값으로 덮어쓰기").disabled, "같은 값이면 덮어쓰기 꺼짐");
    m.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    test(!chip("밤").querySelector(".preset-menu") && document.activeElement === chip("밤").querySelector(".preset-more"), "Esc로 닫고 ⋯에 초점");
    r.setUniform("uGain", 0.5);
    m = menu("밤");
    item(m, "지금 값으로 덮어쓰기").click();
    await until(() => $("studioPromptDialog").open, "덮어쓰기 확인 창");
    test($("studioDialogMessage").textContent.includes("uGain: 1 → 0.5") && document.activeElement === $("studioDialogCancel"), `바뀌는 값을 보여 주고 '취소'에 초점: ${$("studioDialogMessage").textContent}`);
    $("studioDialogCancel").click();
    await until(() => !$("studioPromptDialog").open, "취소");
    test(window.shaderSettings.getPresets().find(p => p.name === "밤").values.uGain === 1, "취소하면 그대로");
    item(menu("밤"), "지금 값으로 덮어쓰기").click();
    await until(() => $("studioPromptDialog").open, "다시 확인 창");
    $("studioDialogOK").click();
    await until(() => window.shaderSettings.getPresets().find(p => p.name === "밤").values.uGain === 0.5, "확인하면 덮어쓰기");
    test(!$("presetUndo").hidden && document.activeElement === $("presetUndo"), "덮어쓴 뒤 되돌리기 버튼에 초점");
    $("presetUndo").click();
    await until(() => window.shaderSettings.getPresets().find(p => p.name === "밤").values.uGain === 1, "되돌리기 버튼으로 이전 값");
    item(menu("밤"), "지금 값으로 덮어쓰기").click();
    await until(() => $("studioPromptDialog").open, "세 번째 확인 창");
    $("studioDialogOK").click();
    await until(() => window.shaderSettings.getPresets().find(p => p.name === "밤").values.uGain === 0.5, "다시 덮어쓰기");
    studio.undo();
    await until(() => window.shaderSettings.getPresets().find(p => p.name === "밤").values.uGain === 1, "Ctrl+Z(편집 이력)로도 되돌림");
    studio.redo();
    await until(() => window.shaderSettings.getPresets().find(p => p.name === "밤").values.uGain === 0.5, "다시 실행");
    chip("밤").querySelector(".preset-apply").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await answer("깊은 밤");
    await wait(30);
    test(!!chip("깊은 밤") && !chip("밤"), "이름 바꾸기(두 번 누르기)");
    item(menu("낮"), "삭제").click();
    await wait(30);
    test(!chip("낮") && !$("presetUndo").hidden, "메뉴에서 삭제 → 되돌리기 버튼");
    $("presetUndo").click();
    await wait(30);
    test(chips().map(c => c.querySelector(".preset-apply").textContent).join() === "낮,깊은 밤", "되돌리면 원래 자리로");
    menu("낮");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    test(!document.querySelector(".preset-menu"), "바깥을 누르면 메뉴가 닫힘");

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
