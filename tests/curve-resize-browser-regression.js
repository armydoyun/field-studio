// 패널을 조절하는 도중에도 곡선 캔버스의 해상도·점 크기가 실제 표시 크기를 따라가는지 확인한다.
(async () => {
  const $ = id => document.getElementById(id), studio = window.shaderStudio, renderer = window.shaderPlayground;
  const area = $("studioCode"), live = $("studioLive"), original = area.value, wasLive = live.checked;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const setCode = text => { area.value = text; area.dispatchEvent(new Event("input", {bubbles:true})); };
  const key = (node, key) => node.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles:true, cancelable:true}));
  const handle = $("panelResize"), grip = $("panelGrip");
  const pointer = (type, width) => {
    const box = $("workspace").getBoundingClientRect(), right = document.documentElement.classList.contains("panel-right");
    handle.dispatchEvent(new PointerEvent(type, {button:0, buttons:type === "pointerup" ? 0 : 1, pointerId:1,
      clientX:right ? box.right - width - handle.offsetWidth / 2 : box.left + width + handle.offsetWidth / 2,
      clientY:box.top + 200, bubbles:true, cancelable:true}));
  };
  const pads = () => [...document.querySelectorAll("#uniformList .uniform-curve-pad")].filter(p => p.clientWidth > 0);
  const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const check = label => {
    test(pads().length > 0, `${label}: 표시된 곡선`);
    for (const pad of pads()) {
      test(pad.width === Math.round(pad.clientWidth * ratio) && pad.height === Math.round(pad.clientHeight * ratio),
        `${label}: CSS ${pad.clientWidth}×${pad.clientHeight}, 캔버스 ${pad.width}×${pad.height}, DPR ${ratio}`);
      // 차트 배경 바깥으로 튀어나온 첫 점도 다시 그려져야 한다(해상도만 바꾸면 비트맵은 지워진다).
      const ctx = pad.getContext("2d"), inset = Math.round(8 * ratio), offset = Math.round(3 * ratio);
      const pixel = (x,y) => [...ctx.getImageData(x,y,1,1).data];
      test(pixel(inset - offset, pad.height - inset)[3] > 0 && pixel(inset, pad.height - inset + offset)[3] > 0,
        `${label}: 새 해상도에 선택점도 다시 그려짐`);
    }
  };
  studio.open(); live.checked = false; live.dispatchEvent(new Event("change"));
  try {
    setCode(`#version 300 es
precision highp float;
uniform sampler2D uCurve; // @curve @default 0 0 0.5 0.8 1 1
uniform sampler2D uGrouped; // @curve linear @default 0 0 1 1 @group curves
out vec4 fragColor;
void main() { fragColor = vec4(vec3(texture(uCurve, vec2(0.5)).r + texture(uGrouped, vec2(0.5)).r), 1.0); }`);
    test(studio.apply(), "곡선 두 개를 가진 장면 적용");
    if (document.body.classList.contains("panel-hidden")) $("panelToggle").click();
    $("tab-uniforms").click(); $("uniformSearch").dispatchEvent(new Event("input"));
    const values = JSON.stringify(renderer.getUserUniforms());
    await frames(); check("처음 표시");
    for (const side of ["left", "right"]) {
      key(grip, side === "left" ? "ArrowLeft" : "ArrowRight");
      pointer("pointerdown", 300);
      for (const width of [450, 560, 320, 240, 380]) {
        pointer("pointermove", width); await frames();
        test(document.body.classList.contains("panel-resizing"), "버튼을 놓기 전 검사");
        check(`${side} 패널 드래그 ${width}px`);
      }
      pointer("pointerup", 380);
    }
    key(handle, "End"); await frames(); check("키보드로 최대 너비");
    key(handle, "Home"); await frames(); check("키보드로 최소 너비");
    document.querySelector(".uniform-group-head").click(); await frames();
    pointer("pointerdown", 240); pointer("pointermove", 500); await frames(); pointer("pointerup", 500);
    document.querySelector(".uniform-group-head").click(); await frames(); check("접은 그룹 다시 열기");
    $("uniformSearch").value = "uCurve"; $("uniformSearch").dispatchEvent(new Event("input")); await frames();
    key(handle, "Home"); await frames(); check("검색으로 목록을 다시 만든 뒤");
    $("uniformSearch").value = ""; $("uniformSearch").dispatchEvent(new Event("input")); await frames();
    key(handle, "End"); await frames(); check("검색 해제 후 두 곡선");
    test(JSON.stringify(renderer.getUserUniforms()) === values, "크기 조절은 곡선 값·텍스처 설정을 바꾸지 않는다");
  } finally {
    pointer("pointerup", 300); $("uniformSearch").value = "";
    setCode(original); studio.apply(); live.checked = wasLive; live.dispatchEvent(new Event("change"));
    $("layoutReset").click();
  }
})();
