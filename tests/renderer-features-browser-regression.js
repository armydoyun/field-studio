// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 렌더러 기능 묶음: HUD 시간 · 재생 배속 · 한 프레임 진행(. 키) · uWheel · 고해상도 PNG(captureScreenshotAt).
(async () => {
  const $ = id => document.getElementById(id), r = window.shaderPlayground, studio = window.shaderStudio;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const until = async (condition, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (condition()) return true; return condition(); };
  const rejects = async (promise, pattern, label) => {
    try { await promise; } catch (error) { test(pattern.test(error.message), `${label}: ${error.message}`); return; }
    test(false, `${label}: 거절되지 않음`);
  };
  const key = k => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const image = async blob => {
    const bitmap = await createImageBitmap(blob), canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, pixel: (fx, fy) => [...context.getImageData(Math.floor(bitmap.width * fx), Math.floor(bitmap.height * fy), 1, 1).data] };
  };
  const play = () => { if (!studio.getPlaybackState()) studio.togglePlayback(); };
  const pause = () => { if (studio.getPlaybackState()) studio.togglePlayback(); };
  const area = $("studioCode"), live = $("studioLive"), original = area.value, wasLive = live.checked;
  const setScene = source => { area.value = source; area.dispatchEvent(new Event("input", { bubbles: true })); return studio.apply(); };
  try {
    play();
    // ---- 재생 배속 ----
    for (const bad of [0, -1, 9, NaN]) {
      let threw = false;
      try { r.setTimeScale(bad); } catch (error) { threw = error instanceof RangeError; }
      test(threw, `잘못된 배속 ${bad} 거절`);
    }
    test(r.getStats().timeScale === 1 && $("timeScaleLabel").textContent === "1×", "기본 배속 1×");
    document.querySelector('[data-time-scale="0.5"]').click();
    test(r.getStats().timeScale === 0.5 && $("timeScaleLabel").textContent === "0.5×", "0.5× 선택");
    test(document.querySelector('[data-time-scale="0.5"]').getAttribute("aria-pressed") === "true", "선택한 배속 버튼 표시");
    // 배속 비율은 실제로 그린 프레임 사이에서 잰다. 고정된 1초 창으로 재면, CI처럼 다른 무거운 테스트와 CPU를 나눠 쓰는
    // 소프트웨어 렌더링에서 그 창 안에 프레임이 하나도 안 그려져 0으로 나올 수 있다.
    // 프레임마다(그린 직후) 셰이더 시간과 벽시계를 함께 적고, 0.5초 이상·4프레임 이상 쌓이면 비율을 낸다.
    const samples = [];
    const off = r.onFrame(() => samples.push([performance.now(), r.getStats().time]));
    const enough = () => samples.length >= 5 && samples.at(-1)[0] - samples[1][0] >= 500;
    try {
      await until(enough, 30000);
    } finally {
      off();
    }
    test(enough(), `배속 측정에 필요한 프레임이 그려짐 (${samples.length}프레임)`);
    // 첫 표본은 배속을 바꾼 직후라 버리고, 둘째부터 마지막까지의 비율을 본다.
    const [w0, t0] = samples[1], [w1, t1] = samples.at(-1);
    const rate = (t1 - t0) / ((w1 - w0) / 1000);
    test(rate > 0.35 && rate < 0.65, `0.5×에서 시간이 절반 속도로 흐름 (${rate.toFixed(2)} · ${samples.length - 1}프레임)`);
    await wait(600);
    test(/s ×0\.5$/.test($("statTime").textContent), `HUD에 시간과 배속: ${$("statTime").textContent}`);
    document.querySelector('[data-time-scale="1"]').click();
    await wait(600);
    test(/^\d+\.\d{2}s$/.test($("statTime").textContent), `1×에서는 배속을 생략: ${$("statTime").textContent}`);

    // ---- 한 프레임 진행 ----
    $("screen").blur();
    key(".");
    await until(() => !r.getStats().running, 2000);
    await frames(3);
    test(!studio.getPlaybackState(), ". 키: 재생 중이면 먼저 멈춘다");
    const before = r.getStats();
    key(".");
    await frames(3);
    const after = r.getStats();
    test(after.frame === before.frame + 1, `한 프레임만 진행 (${before.frame} → ${after.frame})`);
    test(Math.abs(after.time - before.time - 1 / 60) < 1e-6, `시간은 1/60초 진행 (${(after.time - before.time).toFixed(5)})`);
    test(!after.running, "진행 뒤에도 멈춘 상태");
    document.querySelector('[data-time-scale="2"]').click();
    $("stepFrame").click();
    await frames(3);
    const stepped = r.getStats();
    test(Math.abs(stepped.time - after.time - 1 / 60) < 1e-6 && stepped.frame === after.frame + 1, "버튼으로도 진행 · 배속과 관계없이 1/60초");
    document.querySelector('[data-time-scale="1"]').click();
    await wait(400);
    test(r.getStats().frame === stepped.frame, "멈춘 동안에는 프레임이 늘지 않음");
    play();
    test(r.stepFrame() === false, "재생 중 stepFrame()은 아무것도 하지 않음");
    let threw = false;
    try { r.stepFrame(2); } catch (error) { threw = error instanceof RangeError; }
    test(threw, "1초 넘는 진행은 거절");

    // ---- uWheel ----
    const canvas = $("screen"), rect = canvas.getBoundingClientRect();
    const wheel = (deltaY, extra = {}) => {
      const event = new WheelEvent("wheel", { deltaY, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true, ...extra });
      canvas.dispatchEvent(event);
      return event.defaultPrevented;
    };
    test(!wheel(-100) && r.getStats().wheel === 0, "uWheel을 안 쓰는 셰이더는 휠을 가로채지 않음");
    live.checked = false;
    live.dispatchEvent(new Event("change"));
    test(setScene(`#version 300 es
precision highp float;
uniform float uWheel;
out vec4 fragColor;
void main() { fragColor = vec4(fract(uWheel * 0.1), 0.0, 0.0, 1.0); }
`), "uWheel 장면 적용");
    test(wheel(-100) && r.getStats().wheel === 1, "위로 한 칸(100px) = +1, 기본 동작 막음");
    wheel(-300);
    test(r.getStats().wheel === 4, "누적");
    wheel(3, { deltaMode: 1 });
    test(r.getStats().wheel === 3, "줄 단위 3줄 = 한 칸, 아래로 굴리면 -1");
    test(!wheel(-100, { ctrlKey: true }) && r.getStats().wheel === 3, "Ctrl+휠은 브라우저 확대로 둔다");
    await frames(4);
    pause();
    await frames(2);
    const shot = await image(await r.captureScreenshot());
    const red = shot.pixel(0.5, 0.5)[0];
    test(Math.abs(red - 0.3 * 255) <= 2, `셰이더가 uWheel 값을 받음 (R=${red})`);
    r.resetSimulation();
    test(r.getStats().wheel === 0, "시간 초기화하면 0");

    // ---- 고해상도 PNG ----
    test(setScene(`#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  fragColor = vec4(uv, 0.5 + 0.5 * sin(uTime), 1.0);
}
`), "그라디언트 장면 적용");
    await frames(3);
    pause();
    await frames(2);
    const { width, height } = r.getStats();
    const normal = await image(await r.captureScreenshot());
    const frameBefore = r.getStats().frame, timeBefore = r.getStats().time;
    const big = await image(await r.captureScreenshotAt(width * 2, height * 2));
    test(big.width === width * 2 && big.height === height * 2, `2× 크기 ${big.width}×${big.height}`);
    test(r.getStats().frame === frameBefore && r.getStats().time === timeBefore, "고해상도 캡처는 시간·프레임을 바꾸지 않음");
    for (const [fx, fy] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.2], [0.25, 0.85]]) {
      const a = normal.pixel(fx, fy), b = big.pixel(fx, fy);
      test(a.every((v, i) => Math.abs(v - b[i]) <= 3), `화면 캡처와 같은 그림 (${fx}, ${fy}): ${a} / ${b}`);
    }
    await rejects(r.captureScreenshotAt(0, 10), /정수/, "0 크기 거절");
    await rejects(r.captureScreenshotAt(100.5, 10), /정수/, "소수 크기 거절");
    await rejects(r.captureScreenshotAt(20000, 20000), /크기를 넘습니다/, "GPU 한도 초과 거절");
    // 캡처 메뉴의 4K 버튼: 긴 변 3840px 파일을 내려받는다(다운로드 링크 이름으로 확인).
    const names = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { names.push(this.download); };
    try {
      $("screenshot4k").click();
      await until(() => names.length, 30000);
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
    const [w4, h4] = (/-(\d+)x(\d+)\.png$/.exec(names[0] || "") || []).slice(1).map(Number);
    test(Math.max(w4, h4) === 3840 && Math.abs(w4 / h4 - width / height) < 0.01, `4K 저장: ${names[0]}`);
    // 버퍼 패스가 있으면 지원하지 않는다
    test(await studio.exampleFeedback(), "버퍼 예제 열기");
    await rejects(r.captureScreenshotAt(width * 2, height * 2), /버퍼 패스/, "버퍼 패스 프로젝트는 거절");
    console.log("렌더러 기능 회귀 검사 통과");
  } finally {
    try { r.setTimeScale(1); } catch (_) { /* 정리 실패는 무시 */ }
    area.value = original;
    area.dispatchEvent(new Event("input", { bubbles: true }));
    studio.apply();
    live.checked = wasLive;
    live.dispatchEvent(new Event("change"));
    play();
  }
})();
