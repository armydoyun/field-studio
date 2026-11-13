// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행 — 오디오 파일을 쓰므로 하나씩).
// 파라미터 연결(js/links.js · midi-input.js · renderer.applyLinks · settings · ui.js의 연결 편집 칸):
//  · 연결 버튼 → 편집 칸 · 소스 고르기 → 배지 · 흔들기(LFO)가 렌더 시간에 맞는 값
//  · 키프레임: '지금 시간에 키' · 사이 값 · 반복 · 키 지우기
//  · MIDI(가짜 Web MIDI): 학습 → CC 연결 · 값 0~1을 최소~최대로
//  · 소리: 앞 무음 · 뒤 440Hz 파일의 중음 대역이 영상 렌더 시간에 맞는다
//  · 자동 저장 · 프로젝트 파일(Pack) · Undo · 이름 바꾸기 · 새 프로젝트는 연결 없이
(async () => {
  const autoAnswer = setInterval(() => { const d = document.getElementById("studioPromptDialog"), alt = document.getElementById("studioDialogAlt"); if (d?.open && !alt.hidden) alt.click(); }, 50);
  const r = window.shaderPlayground, studio = window.shaderStudio, settings = window.shaderSettings, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return; throw new Error(`FAIL: 시간 초과 — ${label}`); };
  const value = name => r.getUserUniforms().find(u => u.name === name)?.value;
  const row = name => [...$("uniformList").querySelectorAll(".uniform-row")].find(node => node.querySelector(".uniform-name")?.textContent === name);
  const editor = name => $("uniformList").querySelector(`.link-editor[data-name="${name}"]`);
  const choose = (node, v) => { node.value = String(v); node.dispatchEvent(new Event("change", { bubbles: true })); };
  const fieldOf = (name, label) => [...editor(name).querySelectorAll(".link-field")].find(f => f.firstChild.textContent === label)?.querySelector("input,select");
  const downloads = [], realClick = HTMLAnchorElement.prototype.click, realUrl = URL.createObjectURL, blobs = new Map();
  URL.createObjectURL = blob => { const url = realUrl.call(URL, blob); blobs.set(url, blob); return url; };
  HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(blobs.get(this.href)); else realClick.call(this); };
  // 앞 1초 무음 + 뒤 1초 440Hz(44.1kHz 모노)
  const silenceThenTone = () => {
    const rate = 44100, n = rate * 2, bytes = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (at, s) => [...s].forEach((ch, i) => bytes.setUint8(at + i, ch.charCodeAt(0)));
    text(0, "RIFF"); bytes.setUint32(4, 36 + n * 2, true); text(8, "WAVEfmt "); bytes.setUint32(16, 16, true);
    bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true); bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 2, true);
    bytes.setUint16(32, 2, true); bytes.setUint16(34, 16, true); text(36, "data"); bytes.setUint32(40, n * 2, true);
    for (let i = rate; i < n; i++) bytes.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 20000), true);
    return new File([bytes.buffer], "half-tone.wav", { type: "audio/wav" });
  };
  // 가짜 Web MIDI: 입력 장치 하나. send([status, cc, value])로 메시지를 보낸다.
  const fakeInput = { name: "가짜 노브", onmidimessage: null };
  const send = data => fakeInput.onmidimessage?.({ data: new Uint8Array(data) });
  const realMidi = navigator.requestMIDIAccess;
  Object.defineProperty(navigator, "requestMIDIAccess", { configurable: true, value: async () => ({ inputs: new Map([["a", fakeInput]]), onstatechange: null }) });
  const image = [
    "uniform float uGain;  // @range 0 1 @default 0.2",
    "uniform float uWave;  // @range -2 2",
    "uniform int uStep;    // @range 0 10",
    "uniform vec3 uTint;   // @color",
    "void mainImage(out vec4 c, in vec2 p) { c = vec4(uTint * uGain + uWave + float(uStep), 1.0); }",
  ].join("\n");
  // 오프라인 프레임 하나를 t초에 그리고 파라미터 값을 읽는다(렌더 시간 기준 · 프레임 간격 0.05초)
  const offlineAt = async (times, name, media = false) => {
    const out = [];
    if (media) await r.prepareOfflineMedia();
    r.beginOffline({ width: 16, height: 16 });
    try {
      for (const t of times) {
        if (media) await r.seekOfflineMedia(t);
        r.renderOfflineFrame({ time: t, delta: 0.05, frame: Math.round(t * 20) });
        out.push(value(name));
      }
    } finally {
      r.endOffline();
      if (media) r.endOfflineMedia();
    }
    return out;
  };
  const before = studio.getProject(), wasRunning = r.getStats().running;
  try {
    if (!wasRunning) studio.togglePlayback();
    test(studio.setProject({ image, passes: [], imageChannels: {} }), "파라미터 4개 프로젝트");
    await until(() => r.getUserUniforms().length === 4, "파라미터 등록");
    settings.setLinks([]);
    $("tab-uniforms").click();
    await wait(50);
    test(!!row("uGain").querySelector(".link-uniform") && !row("uTint").querySelector(".link-uniform"), "float에는 연결 버튼, vec3에는 없음");

    // 1) 흔들기: 편집 칸 → 소스 → 배지 · 렌더 시간에 맞는 값(사인은 0초에 최소, 반 주기에 최대)
    row("uWave").querySelector(".link-uniform").click();
    await wait(30);
    test(!!editor("uWave") && editor("uWave").querySelector(".link-hint"), "편집 칸이 열리고 안내");
    choose(editor("uWave").querySelector("select"), "lfo");
    await wait(30);
    test(settings.getLinks()[0]?.source === "lfo" && settings.getLinks()[0].min === -2 && settings.getLinks()[0].max === 2, "기본 범위는 슬라이더 범위(-2~2)");
    test(row("uWave").classList.contains("is-linked") && row("uWave").querySelector(".link-badge").textContent.includes("흔들기"), "배지에 소스");
    choose(fieldOf("uWave", "주기(초)"), 2);
    await wait(30);
    test(settings.getLinks()[0].period === 2, "주기 바꾸기");
    const wave = await offlineAt([0, 0.5, 1, 2], "uWave");
    test(Math.abs(wave[0] + 2) < 1e-4 && Math.abs(wave[1]) < 1e-4 && Math.abs(wave[2] - 2) < 1e-4 && Math.abs(wave[3] + 2) < 1e-4, `흔들기 0 · 0.5 · 1 · 2초: ${wave.map(v => v.toFixed(3))}`);

    // 2) 키프레임: 지금 시간에 키 · 사이 값 · 반복 · 지우기
    row("uStep").querySelector(".link-uniform").click();
    await wait(30);
    choose(editor("uStep").querySelector("select"), "keys");
    await wait(30);
    settings.setLinks(settings.getLinks().map(l => (l.name === "uStep" ? { ...l, keys: [[0, 0], [1, 10]], ease: "linear" } : l)));
    await wait(30);
    test(editor("uStep").querySelectorAll(".link-key").length === 2, "키 칩 두 개");
    const steps = await offlineAt([0, 0.25, 0.5, 2], "uStep");
    test(steps.join() === "0,3,5,10", `키프레임(int 반올림 · 끝 값 유지): ${steps}`);
    choose(fieldOf("uStep", "반복(초)"), 1);
    await wait(30);
    const looped = await offlineAt([1.5], "uStep");
    test(looped[0] === 5, `1초 반복: 1.5초 → ${looped[0]}`);
    const keyValue = fieldOf("uStep", "키 값");
    keyValue.value = "7";
    [...editor("uStep").querySelectorAll("button")].find(b => b.textContent.startsWith("지금 시간"))?.click();
    await wait(30);
    test(settings.getLinks().find(l => l.name === "uStep").keys.some(([, v]) => v === 7), "'지금 시간에 키'로 키 추가");
    editor("uStep").querySelector(".link-key button").click();
    await wait(30);
    test(settings.getLinks().find(l => l.name === "uStep").keys.length === 2, "키 지우기");

    // 3) MIDI: 학습 → 움직인 CC로 연결 · 값을 범위로
    row("uGain").querySelector(".link-uniform").click();
    await wait(30);
    choose(editor("uGain").querySelector("select"), "midi");
    await wait(30);
    [...editor("uGain").querySelectorAll("button")].find(b => b.textContent === "학습").click();
    await until(() => r.midiStatus().state === "on", "MIDI 켜짐");
    await wait(30);
    send([0xb2, 21, 127]); // 채널 3, CC 21
    await until(() => settings.getLinks().find(l => l.name === "uGain")?.cc === 21, "학습한 CC");
    test(settings.getLinks().find(l => l.name === "uGain").channel === 3, "학습한 채널 3");
    await until(() => Math.abs(value("uGain") - 1) < 1e-4, "CC 127 → 최대 1");
    send([0xb2, 21, 0]);
    await until(() => Math.abs(value("uGain")) < 1e-4, "CC 0 → 최소 0");
    send([0xb0, 21, 127]); // 다른 채널은 무시
    await wait(100);
    test(Math.abs(value("uGain")) < 1e-4, "다른 채널의 같은 CC는 무시");
    test(editor("uGain").querySelector(".link-status").textContent.includes("가짜 노브"), "장치 이름 표시");

    // 4) 소리: 중음(440Hz) 대역이 렌더 시간에 맞는다
    settings.setLinks(settings.getLinks().map(l => (l.name === "uGain" ? { name: "uGain", source: "audio", band: "mid", min: 0, max: 1, smooth: 0 } : l)));
    test(await r.startMedia("audio", silenceThenTone()), "앞 무음 · 뒤 440Hz 파일 켜기");
    const level = await offlineAt([0.4, 0.45, 0.5, 1.4, 1.45, 1.5], "uGain", true);
    test(level[2] < 0.02 && level[5] > level[2] + 0.03, `소리 연결: 0.5초 ${level[2].toFixed(3)} · 1.5초 ${level[5].toFixed(3)}`);
    r.stopMedia?.("audio");

    // 5) 이름 바꾸기 · 자동 저장 · Pack · Undo · 새 프로젝트
    studio.open();
    const area = $("studioCode"), at = area.value.indexOf("uWave");
    test(at >= 0, "편집기에 uWave");
    area.focus();
    area.setSelectionRange(at + 1, at + 1);
    area.dispatchEvent(new Event("select"));
    await wait(30);
    $("studioRename").click();
    await until(() => $("studioPromptDialog").open, "F2 대화상자");
    $("studioDialogInput").value = "uSwing";
    $("studioDialogForm").requestSubmit();
    await until(() => !$("studioPromptDialog").open, "대화상자 닫힘");
    await until(() => settings.getLinks().some(l => l.name === "uSwing"), "연결도 새 이름");
    settings.save();
    const stored = JSON.parse(localStorage.getItem("webgl.raymarch-template.settings.v1"));
    test(stored.links.map(l => l.name).sort().join() === "uGain,uStep,uSwing", "브라우저 자동 저장에 연결");
    await studio.exportPack();
    const pack = JSON.parse(await downloads.at(-1).text());
    test(pack.settings.links.length === 3, "프로젝트 파일(Pack)에 연결");
    test(await studio.loadExample({ image: "void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }", passes: [], imageChannels: {} }, []), "새 프로젝트");
    await wait(30);
    test(settings.getLinks().length === 0, "새 프로젝트에는 연결이 없다");
    studio.undo();
    await wait(30);
    test(settings.getLinks().length === 3, "Undo로 연결까지 돌아온다");
    settings.setLinks([]);
    await studio.importPack(new File([JSON.stringify(pack)], "pack.json", { type: "application/json" }));
    await until(() => settings.getLinks().length === 3, "Pack을 열면 연결 복원");
    test(settings.getLinks().find(l => l.name === "uStep").loop === 1, "Pack의 키프레임 설정 그대로");
  } finally {
    clearInterval(autoAnswer);
    HTMLAnchorElement.prototype.click = realClick;
    URL.createObjectURL = realUrl;
    if (realMidi) Object.defineProperty(navigator, "requestMIDIAccess", { configurable: true, value: realMidi });
    settings?.setLinks?.([]);
    studio.setProject(before);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("파라미터 연결 회귀 테스트 완료");
})();
