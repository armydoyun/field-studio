// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행 — 오디오 파일을 쓰므로 하나씩).
// 파라미터 연결(js/links.js · midi-input.js · renderer.applyLinks · settings · link-sheet.js의 연결 시트):
//  · 연결 버튼 → 시트 · 소스 고르기 → 배지 · 줄은 미터 · 흔들기(LFO)가 렌더 시간에 맞는 값 · 출력 범위 막대 · 뒤집기 · 반응
//  · 키프레임: 사이 값 · 잇기 · 반복 · '타임라인에서 편집'
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
  const field = (name, label) => editor(name).querySelector(`[aria-label="${label}"]`);
  const source = (name, label) => [...editor(name).querySelectorAll('.link-sources [role="radio"]')].find(b => b.textContent === label);
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

    // 1) 흔들기: 연결 시트 → 소스 → 배지 · 줄은 읽기 전용 미터 · 렌더 시간에 맞는 값(사인은 0초에 최소, 반 주기에 최대)
    row("uWave").querySelector(".link-uniform").click();
    await wait(30);
    test(!!editor("uWave") && editor("uWave").querySelector(".link-hint"), "시트가 열리고 안내");
    test(document.activeElement === source("uWave", "끄기"), "시트를 열면 고른 소스(끄기)에 초점");
    source("uWave", "흔들기").click();
    await wait(30);
    test(settings.getLinks()[0]?.source === "lfo" && settings.getLinks()[0].min === -2 && settings.getLinks()[0].max === 2, "기본 범위는 슬라이더 범위(-2~2)");
    test(document.activeElement === source("uWave", "흔들기"), "다시 그린 뒤 고른 소스에 초점");
    test(row("uWave").classList.contains("is-linked") && row("uWave").querySelector(".link-badge").textContent.includes("흔들기"), "배지에 소스");
    test(!!row("uWave").querySelector(".link-meter") && !row("uWave").querySelector(':scope > .uniform-pair input[type="range"], :scope > div > input[type="range"]'), "연결된 줄은 슬라이더 대신 미터");
    test(!!editor("uWave").querySelector(".link-wave path")?.getAttribute("d"), "흔들기 모양 미리보기");
    choose(field("uWave", "주기(초)"), 2);
    await wait(30);
    test(settings.getLinks()[0].period === 2, "주기 바꾸기");
    const wave = await offlineAt([0, 0.5, 1, 2], "uWave");
    test(Math.abs(wave[0] + 2) < 1e-4 && Math.abs(wave[1]) < 1e-4 && Math.abs(wave[2] - 2) < 1e-4 && Math.abs(wave[3] + 2) < 1e-4, `흔들기 0 · 0.5 · 1 · 2초: ${wave.map(v => v.toFixed(3))}`);
    // 출력 범위 막대: 끄는 동안(input)은 렌더러에만, 놓으면(change) 저장 · 뒤집기 · 반응 슬라이더
    const top = field("uWave", "출력 위 끝");
    top.value = "1";
    top.dispatchEvent(new Event("input", { bubbles: true }));
    test(r.getLinks()[0].max === 1, "끄는 동안 렌더러에 바로 적용");
    test(!!editor("uWave") && document.contains(top), "끄는 동안 시트를 다시 그리지 않음(끌기가 끊기지 않게)");
    test(field("uWave", "출력 위 끝 값").value === "1", "끄는 동안 숫자 칸도 따라감");
    top.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(30);
    test(settings.getLinks()[0].max === 1, "놓으면 저장");
    [...editor("uWave").querySelectorAll("button")].find(b => b.textContent.includes("뒤집기")).click();
    await wait(30);
    test(settings.getLinks()[0].min === 1 && settings.getLinks()[0].max === -2, "뒤집기 = 최소 · 최대 맞바꿈");
    test(editor("uWave").querySelector(".link-flip").getAttribute("aria-pressed") === "true", "뒤집기 눌린 상태");
    choose(field("uWave", "부드럽게 따라가는 시간(초)"), 0.25);
    await wait(30);
    test(settings.getLinks()[0].smooth === 0.25, "반응 시간");
    await until(() => /^-?\d/.test(row("uWave").querySelector(".link-meter-value").textContent), "미터에 지금 값");
    await until(() => /^-?\d/.test(editor("uWave").querySelector(".link-result-value").textContent), "시트의 결과 값");

    // 2) 키프레임: 시트에는 키 목록 대신 반복 · 잇기와 '타임라인에서 편집'
    row("uStep").querySelector(".link-uniform").click();
    await wait(30);
    source("uStep", "키프레임").click();
    await wait(30);
    settings.setLinks(settings.getLinks().map(l => (l.name === "uStep" ? { ...l, keys: [[0, 0], [1, 10]] } : l)));
    await wait(30);
    test(!editor("uStep").querySelector(".link-range") && editor("uStep").textContent.includes("키 2개"), "키프레임 시트: 출력 범위 없음 · 키 수");
    [...editor("uStep").querySelectorAll('[role="radio"]')].find(b => b.textContent === "직선").click();
    await wait(30);
    test(settings.getLinks().find(l => l.name === "uStep").ease === "linear", "잇기: 직선");
    const steps = await offlineAt([0, 0.25, 0.5, 2], "uStep");
    test(steps.join() === "0,3,5,10", `키프레임(int 반올림 · 끝 값 유지): ${steps}`);
    // 시간 기준: '한 번'이 기본 · '반복'으로 바꾸면 길이 칸과 지금 바퀴 안내 · 길이 밖 키 경고
    const timeMode = label => [...editor("uStep").querySelectorAll('[aria-label="키프레임 시간 기준"] [role="radio"]')].find(b => b.textContent.startsWith(label));
    test(timeMode("한 번").getAttribute("aria-checked") === "true" && editor("uStep").textContent.includes("마지막 키 값을 유지"), "기본은 '한 번'과 설명");
    timeMode("반복").click();
    await until(() => settings.getLinks().find(l => l.name === "uStep").loop === 2, "반복으로 바꾸면 마지막 키를 담는 길이(2초)");
    await until(() => /바퀴 안 \d+\.\d\d초 · \d+번째 바퀴/.test(editor("uStep").querySelector(".link-loop-status").textContent), "지금 바퀴 안내");
    choose(field("uStep", "반복 길이(초)"), 0.5);
    await until(() => editor("uStep").querySelector(".link-warn")?.textContent.includes("키 1개는 쓰이지 않습니다"), "길이 밖 키 경고");
    choose(field("uStep", "반복 길이(초)"), 1);
    await wait(30);
    const looped = await offlineAt([1.5], "uStep");
    test(looped[0] === 5, `1초 반복: 1.5초 → ${looped[0]}`);
    [...editor("uStep").querySelectorAll("button")].find(b => b.textContent === "타임라인에서 편집").click();
    await until(() => !$("timelineDock").hidden && !!$("timelineDock").querySelector('.timeline-lane[data-name="uStep"] .timeline-key.is-selected'), "타임라인 도크가 열리고 그 레인의 첫 키가 선택됨");
    test(document.activeElement === $("timelineDock").querySelector(".timeline-body"), "도크에 초점(방향키로 바로 옮기기)");
    $("timelineDock").querySelector(".timeline-close").click();

    // 3) MIDI: 학습 → 움직인 CC로 연결 · 값을 범위로 · 상태 줄
    row("uGain").querySelector(".link-uniform").click();
    await wait(30);
    source("uGain", "MIDI").click();
    await wait(30);
    // 입력이 없으면 '연결이 정함'이 아니라 까닭과 '값 그대로'를 보인다 · 연결이 값을 정하는 동안 ↺는 꺼짐
    await until(() => row("uGain").querySelector(".link-meter-note").textContent === "MIDI 신호 없음 · 값 그대로", `입력 없음 표시: ${row("uGain").querySelector(".link-meter-note").textContent}`);
    test(row("uGain").querySelector(".reset-uniform").disabled, "연결된 줄의 ↺(기본값으로)는 꺼짐");
    test([...editor("uGain").querySelectorAll(".link-end-label")].map(n => n.textContent).join() === "노브 처음(0),노브 끝(127)", "값 범위 양 끝 라벨이 소스에 맞음");
    editor("uGain").querySelector(".link-learn").click();
    await until(() => r.midiStatus().state === "on", "MIDI 켜짐");
    await until(() => editor("uGain").querySelector(".link-learn").getAttribute("aria-pressed") === "true", "학습 중 표시");
    send([0xb2, 21, 127]); // 채널 3, CC 21
    await until(() => settings.getLinks().find(l => l.name === "uGain")?.cc === 21, "학습한 CC");
    test(settings.getLinks().find(l => l.name === "uGain").channel === 3, "학습한 채널 3");
    await until(() => Math.abs(value("uGain") - 1) < 1e-4, "CC 127 → 최대 1");
    await until(() => row("uGain").querySelector(".link-meter-note").textContent === "연결이 정함", "신호가 오면 '연결이 정함'");
    send([0xb2, 21, 0]);
    await until(() => Math.abs(value("uGain")) < 1e-4, "CC 0 → 최소 0");
    send([0xb0, 21, 127]); // 다른 채널은 무시
    await wait(100);
    test(Math.abs(value("uGain")) < 1e-4, "다른 채널의 같은 CC는 무시");
    await until(() => /가짜 노브.*마지막: CC 21 · 채널 1 = 1/.test(editor("uGain").querySelector(".link-note").textContent), `상태 줄: ${editor("uGain").querySelector(".link-note").textContent}`);

    // 4) 소리: 중음(440Hz) 대역이 렌더 시간에 맞는다
    settings.setLinks(settings.getLinks().map(l => (l.name === "uGain" ? { name: "uGain", source: "audio", band: "mid", min: 0, max: 1, smooth: 0 } : l)));
    test(await r.startMedia("audio", silenceThenTone()), "앞 무음 · 뒤 440Hz 파일 켜기");
    const level = await offlineAt([0.4, 0.45, 0.5, 1.4, 1.45, 1.5], "uGain", true);
    test(level[2] < 0.02 && level[5] > level[2] + 0.03, `소리 연결: 0.5초 ${level[2].toFixed(3)} · 1.5초 ${level[5].toFixed(3)}`);
    // 시트: 대역 세기 막대가 실시간으로 움직인다(뒤 1초의 440Hz → 중음)
    await until(() => !!editor("uGain")?.querySelector(".link-bands"), "소리 시트");
    test(editor("uGain").querySelector(".link-bar.is-picked")?.closest(".link-band-line").textContent.includes("중음"), "고른 대역 강조");
    await until(() => [...editor("uGain").querySelectorAll(".link-bands .link-bar-fill")].some(f => parseFloat(f.style.width) > 1), "대역 세기 막대가 움직임", 6000);
    test(editor("uGain").querySelector(".link-bands + .link-note").hidden, "오디오가 켜져 있으면 안내 숨김");
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
