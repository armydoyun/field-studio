// 설정 패널 자체의 너비를 바꾸며 입력·설명·버튼의 잘림과 겹침을 실제 브라우저에서 검사한다.
(async () => {
  const $ = id => document.getElementById(id), studio = window.shaderStudio, renderer = window.shaderPlayground;
  const area = $("studioCode"), live = $("studioLive"), original = area.value, wasLive = live.checked;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const key = (node, key) => node.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles:true, cancelable:true}));
  const setCode = text => { area.value = text; area.dispatchEvent(new Event("input", {bubbles:true})); };
  const visible = node => node.getBoundingClientRect().width > 0;
  const overlaps = (a,b) => {
    const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
    return Math.min(x.right,y.right)-Math.max(x.left,y.left) > 1 && Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top) > 1;
  };
  const contained = (node, parent) => {
    const r = node.getBoundingClientRect(), p = parent.getBoundingClientRect();
    return r.left >= p.left - 1 && r.right <= p.right + 1;
  };
  const check = label => {
    for (const row of document.querySelectorAll(".uniform-row")) {
      const name = row.querySelector(".uniform-name").textContent;
      const controls = [...row.querySelectorAll("input,button,select,canvas,.uniform-desc,.uniform-name,.uniform-type,.uniform-dir-value,.uniform-color code,.uniform-range-ends span")].filter(visible);
      for (const node of controls) test(contained(node,row), `${label} ${name}: ${node.getAttribute("aria-label") || node.className}가 행 안에 표시됨`);
      const leaves = controls.filter(n => !n.classList.contains("uniform-name") && !n.classList.contains("uniform-type"));
      for (let i=0;i<leaves.length;i++) for (let j=i+1;j<leaves.length;j++)
        test(!overlaps(leaves[i],leaves[j]), `${label} ${name}: ${i}·${j}번 요소가 겹치지 않음`);
      for (const slider of row.querySelectorAll('input[type="range"]'))
        test(slider.getBoundingClientRect().width >= 60, `${label} ${name}: 슬라이더를 조작할 공간 확보`);
      for (const pad of row.querySelectorAll(".uniform-dir-pad")) {
        const r = pad.getBoundingClientRect();
        test(Math.abs(r.width-r.height) < 1 && r.width >= 80, `${label} ${name}: 패드 비율·크기 유지`);
      }
      const desc = row.querySelector(".uniform-desc");
      if (desc) test(desc.getBoundingClientRect().width >= row.clientWidth-26, `${label} ${name}: 설명은 행 전체 너비 사용`);
    }
    const footer = document.querySelector(".panel-footer"), status = $("storageStatus"), version = footer.querySelector(".footer-version");
    test(contained(status,footer) && contained(version,footer) && !overlaps(status,version), `${label}: 저장 상태와 버전 표시가 겹치거나 잘리지 않음`);
    test($("panel").scrollWidth <= $("panel").clientWidth+1, `${label}: 패널 가로 넘침 없음`);
  };
  const handle = $("panelResize");
  const pointer = (type,width) => {
    const box = $("workspace").getBoundingClientRect(), right = document.documentElement.classList.contains("panel-right");
    handle.dispatchEvent(new PointerEvent(type,{pointerId:1,button:0,buttons:type === "pointerup" ? 0 : 1,bubbles:true,cancelable:true,
      clientX:right ? box.right-width-handle.offsetWidth/2 : box.left+width+handle.offsetWidth/2,clientY:box.top+200}));
  };
  studio.open(); live.checked = false; live.dispatchEvent(new Event("change"));
  try {
    setCode(`#version 300 es
precision highp float;
uniform float uSpin; // 위성 돌리기(▶: 한 바퀴씩), 긴 설명도 온전히 표시합니다 · @angle @default 30deg @anim 12
uniform vec2 uCenter; // 화면 중심(xy 패드도 같다) · @pos
uniform vec3 uLight; // 조명 방향 · @dir
uniform vec4 uTint; // 밝기와 투명도 · @color hdr @default 2 1 0.5 1
uniform vec2 uVector; // 위치 벡터 · @default -123.45 234.56
uniform mat4 uTransform; // 변환 행렬 · @default -12.5
uniform int uMode; // 보기 모드 · @enum 최종_결과보기 기본밀도_미리보기 광원_투과율
uniform float uLarge; // 큰 범위 · @range -1000000 1000000 @default 123456 @anim 8
uniform sampler2D uCurve; // 곡선 · @curve
uniform sampler2D uGradient; // 그라데이션 · @gradient
out vec4 fragColor;
void main(){fragColor=vec4(0.2,0.3,0.4,1.0);}`);
    test(studio.apply(), "여러 표시 방식을 가진 장면 적용");
    if (document.body.classList.contains("panel-hidden")) $("panelToggle").click();
    $("tab-uniforms").click(); $("uniformSearch").dispatchEvent(new Event("input"));
    const values = JSON.stringify(renderer.getUserUniforms());
    if (window.innerWidth > 820) {
      for (const side of ["left","right"]) {
        key($("panelGrip"),side === "left" ? "ArrowLeft" : "ArrowRight");
        pointer("pointerdown",300);
        for (const width of [240,280,300,320,360,560]) {
          pointer("pointermove",width); await frames(); check(`${side} ${handle.getAttribute("aria-valuenow")}px`);
        }
        pointer("pointerup",560);
      }
      key(handle,"Home"); await frames();
    } else { await frames(); check("좁은 창의 설정 서랍"); }
    $("uniformEditor").open = true;
    $("uniformType").value = "float"; $("uniformType").dispatchEvent(new Event("change"));
    $("uniformMin").value = "-1000000"; $("uniformMax").value = "1000000"; $("uniformStep").value = "0.001";
    await frames();
    for (const node of $("uniformForm").querySelectorAll("input,select,button")) if (visible(node))
      test(contained(node,$("uniformForm")), `최소 너비의 파라미터 추가 폼: ${node.id}가 잘리지 않음`);
    const input = document.querySelector('.uniform-row input[aria-label="uCenter X"]');
    input.value = "0.25"; input.dispatchEvent(new Event("change",{bubbles:true}));
    test(renderer.getUserUniforms().find(u=>u.name === "uCenter").value[0] === 0.25, "좁은 UI에서도 위치 숫자 입력 동작");
    input.value = "0"; input.dispatchEvent(new Event("change",{bubbles:true}));
    test(JSON.stringify(renderer.getUserUniforms()) === values, "배치 변경은 파라미터 값을 바꾸지 않는다");
    for (const tab of ["render","profile","input"]) {
      $("tab-"+tab).click(); await frames();
      const view = $("view-"+tab);
      // output(노출 배율 등 값 표시)도 본다: 줄이 넘치면 값이 패널 밖으로 잘린다.
      for (const node of view.querySelectorAll("input,select,button,output")) if (visible(node))
        test(contained(node,view), `${tab}: ${node.id || node.className}가 패널 안에 표시됨`);
    }
    // 가장 좁은 패널에서도 테마 버튼 글자는 한 줄(두 줄로 꺾이면 "시스/템"처럼 끊겨 보인다).
    $("tab-input").click(); await frames();
    for (const button of document.querySelectorAll(".theme-choice button"))
      test(button.getBoundingClientRect().height <= 34, `테마 버튼 "${button.textContent}" 글자가 한 줄`);
    // 노출 슬라이더: 값이 바뀌어도 슬라이더 위치·폭이 그대로이고 값이 패널 안에 보인다(끄는 동안 흔들리지 않게).
    $("tab-profile").click(); await frames();
    const exposure = $("profileExposure"), exposureLabel = $("profileExposureLabel");
    const exposureBefore = exposure.value, boxes = [];
    for (const value of ["-8","-7.5","0","0.5","8"]) {
      exposure.value = value; exposure.dispatchEvent(new Event("input",{bubbles:true})); await frames();
      const r = exposure.getBoundingClientRect(); boxes.push(`${Math.round(r.left)}:${Math.round(r.width)}`);
      test(contained(exposureLabel,$("view-profile")) && exposureLabel.scrollWidth <= exposureLabel.clientWidth+1, `노출 값 ${exposureLabel.textContent}이 잘리지 않음`);
    }
    test(new Set(boxes).size === 1 && exposure.getBoundingClientRect().width >= 60, `노출 슬라이더 위치·폭 고정 (${boxes[0]})`);
    exposure.value = exposureBefore; exposure.dispatchEvent(new Event("input",{bubbles:true}));
  } finally {
    pointer("pointerup",300); $("uniformEditor").open = false;
    setCode(original); studio.apply(); live.checked = wasLive; live.dispatchEvent(new Event("change"));
    $("layoutReset").click();
  }
})();
