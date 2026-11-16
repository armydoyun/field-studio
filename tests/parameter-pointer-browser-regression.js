// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 파라미터 포인터 조작이 중간에 끊기거나 튀지 않는다(ui.js):
//  · @if 조건을 바꾸는 슬라이더를 끄는 동안 목록을 다시 그리지 않아 끝까지 끌 수 있고, 놓으면 숨은 파라미터가 나타난다
//  · 그라데이션 빈 곳을 눌러 더한 정지점이 선택 · 초점을 유지한다(누른 곳으로 초점이 빠져 목록이 다시 그려지며 첫 정지점으로 돌아가지 않음)
//  · 정지점 · 곡선 점은 누르기만 하면(3px 미만 흔들림) 움직이지 않고, 끌면 누른 지점 기준으로 옮겨진다
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    $ = id => document.getElementById(id);
  const check = (ok, label) => {
    if (!ok) throw new Error(label);
    console.log(`PASS ${label}`);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const row = name => [...$("uniformList").querySelectorAll(".uniform-row")].find(node => node.dataset.name === name);
  const value = name => r.getUserUniforms().find(item => item.name === name)?.value;
  const pointer = (node, type, clientX, clientY = 0) =>
    node.dispatchEvent(
      new PointerEvent(type, {
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        pointerId: 7,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      })
    );
  // 합성 포인터는 실제 포인터 캡처를 갖지 않는다.
  const capture = Element.prototype.setPointerCapture;
  const before = studio.getProject(),
    users = r.getUserUniforms(),
    tab = document.querySelector('#panelTabs [aria-selected="true"]')?.dataset.tab,
    panelHidden = document.body.classList.contains("panel-hidden");
  try {
    Element.prototype.setPointerCapture = () => {};
    check(
      studio.setProject({
        image: [
          "uniform int uCount;      // @min 0 @max 9 @default 0",
          "uniform float uOrbit;    // @range 0 1 @default 0.5 @if uCount > 0",
          "uniform sampler2D uRamp; // @gradient @default 0 #000000 1 #ffffff",
          "uniform sampler2D uBend; // @curve @default 0 0 1 1",
          "void mainImage(out vec4 c, in vec2 p) { c = vec4(texture(uRamp, vec2(0.5)).rgb * float(uCount) * uOrbit + texture(uBend, vec2(0.5)).r, 1.0); }",
        ].join("\n"),
        passes: [],
        imageChannels: {},
      }),
      "포인터 검사 장면"
    );
    if (panelHidden) $("panelToggle").click();
    $("tab-uniforms").click();
    await wait(100);
    check(row("uCount") && !row("uOrbit"), "uCount가 0이면 uOrbit는 숨김");

    // 1) @if를 바꾸는 슬라이더 끌기
    const slider = row("uCount").querySelector('input[type="range"]');
    pointer(slider, "pointerdown", 0);
    for (let v = 0; v <= 9; v++) {
      slider.value = String(v);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(0);
      check(slider.isConnected, `uCount=${v}: 끄는 중에는 슬라이더를 다시 만들지 않음`);
    }
    check(value("uCount") === 9, "조건이 바뀌어도 끝까지 끌림");
    // 끄는 동안 0.5초마다 도는 목록 갱신(updateStats)이 한 번은 끼어들게 한다 — 예전에 가끔만 실패하던 경우를 늘 재현
    await wait(600);
    check(slider.isConnected, "끄는 중 목록 갱신이 끼어들어도 슬라이더는 그대로");
    pointer(slider, "pointerup", 0);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
    await wait(50);
    check(!!row("uOrbit"), "놓으면 조건을 만족한 파라미터가 나타남");
    check(document.activeElement?.closest(".uniform-row")?.dataset.name === "uCount", "다시 그린 뒤 끌던 줄로 초점");

    // 2) 그라데이션 빈 곳을 눌러 정지점 추가
    const track = row("uRamp").querySelector(".uniform-ramp-track"),
      box = track.getBoundingClientRect();
    const down = new PointerEvent("pointerdown", {
      button: 0,
      buttons: 1,
      pointerId: 7,
      clientX: box.left + box.width * 0.5,
      bubbles: true,
      cancelable: true,
    });
    track.dispatchEvent(down);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
    check(down.defaultPrevented, "빈 곳 누르기의 기본 초점 이동을 막음");
    const selected = () => [...row("uRamp").querySelectorAll(".uniform-ramp-stop")].findIndex(node => node.classList.contains("is-active"));
    check(row("uRamp").querySelectorAll(".uniform-ramp-stop").length === 3 && selected() === 1, "가운데 정지점 추가 · 선택");
    check(document.activeElement === row("uRamp").querySelectorAll(".uniform-ramp-stop")[1], "추가한 정지점에 초점");
    await wait(900); // 주기적인 화면 갱신(0.5초)이 지나도
    check(selected() === 1 && document.activeElement?.classList.contains("uniform-ramp-stop"), "잠시 뒤에도 추가한 정지점이 선택 · 초점 유지");

    // 3) 정지점 누르기 · 끌기
    const handle = row("uRamp").querySelectorAll(".uniform-ramp-stop")[1],
      start = handle.getBoundingClientRect(),
      x = start.left + start.width / 2 + 3; // 손잡이 가운데에서 조금 벗어난 곳을 누른다
    const stopT = () => value("uRamp")[5];
    const t0 = stopT();
    pointer(handle, "pointerdown", x);
    pointer(handle, "pointermove", x + 2);
    pointer(handle, "pointerup", x + 2);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
    check(stopT() === t0, "정지점을 누르기만 하면(2px 흔들림) 위치가 그대로");
    pointer(handle, "pointerdown", x);
    pointer(handle, "pointermove", x + box.width * 0.2);
    pointer(handle, "pointerup", x + box.width * 0.2);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
    check(Math.abs(stopT() - (t0 + 0.2)) < 0.01, "끌면 누른 지점 기준으로 끈 만큼만 이동");

    // 4) 곡선 점 누르기 · 끌기
    const pad = row("uBend").querySelector(".uniform-curve-pad"),
      padBox = pad.getBoundingClientRect(),
      inset = 8 * (padBox.width / (pad.clientWidth || padBox.width));
    const at = (px, py) => [
      padBox.left + inset + px * (padBox.width - inset * 2),
      padBox.top + inset + (1 - py) * (padBox.height - inset * 2),
    ];
    const curve = () => value("uBend").slice(2, 4);
    const [cx, cy] = at(1, 1);
    const p0 = curve();
    pointer(pad, "pointerdown", cx - 6, cy + 6); // 점에서 6px 떨어진 곳을 잡는다
    pointer(pad, "pointermove", cx - 5, cy + 6);
    pointer(pad, "pointerup", cx - 5, cy + 6);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
    check(curve().join() === p0.join(), "곡선 점을 누르기만 하면 점이 포인터로 튀지 않음");
    pointer(pad, "pointerdown", cx - 6, cy + 6);
    pointer(pad, "pointermove", cx - 6, cy + 6 + (padBox.height - inset * 2) * 0.25);
    pointer(pad, "pointerup", cx - 6, cy + 6 + (padBox.height - inset * 2) * 0.25);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
    check(Math.abs(curve()[1] - 0.75) < 0.02 && curve()[0] === p0[0], "곡선 점은 누른 지점 기준으로 끈 만큼 이동");
  } finally {
    Element.prototype.setPointerCapture = capture;
    studio.setProject(before);
    r.setUserUniforms(users);
    if (tab) document.querySelector(`#panelTabs [data-tab="${tab}"]`)?.click();
    if (panelHidden !== document.body.classList.contains("panel-hidden")) $("panelToggle").click();
  }
})();
