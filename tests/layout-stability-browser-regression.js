// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 문구 · 숫자가 바뀌어도 줄 수가 바뀌지 않아 아래 UI가 밀리지 않는다(좁은 240px · 기본 300px 패널):
//  · 비교 바 문구(아직 같음 · N개 다름 · 이전 값 보는 중) · 프리셋 알림 문구 · 연결 시트의 '지금 uTime … 바퀴'(재생 중 매 프레임)
//  · 입력 채널 칩 글자(꺼짐 → 켜는 중 → 장치 이름)
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    settings = window.shaderSettings,
    $ = id => document.getElementById(id);
  const check = (ok, label) => {
    if (!ok) throw new Error(label);
    console.log(`PASS ${label}`);
  };
  const frames = (n = 2) => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const height = node => Math.round(node.getBoundingClientRect().height * 10) / 10;
  // node의 글자를 바꿔 가며 box 높이를 잰다 → 모두 같아야 한다
  const steady = async (node, box, texts) => {
    const original = node.textContent,
      heights = [];
    for (const text of texts) {
      node.textContent = text;
      await frames(1);
      heights.push(height(box));
    }
    node.textContent = original;
    return heights;
  };
  const same = list => list.every(value => value === list[0]);
  const before = studio.getProject(),
    users = r.getUserUniforms(),
    links = settings.getLinks(),
    presets = settings.getPresets(),
    editorOpen = !$("studioDock").hidden,
    panelHidden = document.body.classList.contains("panel-hidden"),
    width = $("workspace").style.getPropertyValue("--panel-width");
  try {
    check(
      studio.setProject({
        image:
          "uniform float uA; // @range 0 1 @default 0.2\nuniform float uB; // @range 0 1 @default 0.5\nuniform sampler2D iChannel0;\nuniform sampler2D iChannel1;\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(uA, uB, 0.0, 1.0) + texture(iChannel0, p) + texture(iChannel1, p); }",
        passes: [],
        imageChannels: { 0: { media: "mic" }, 1: { media: "webcam" }, 2: { keyboard: true } },
      }),
      "밀림 검사 장면"
    );
    if (panelHidden) $("panelToggle").click();
    $("tab-uniforms").click();
    await frames(3);
    $("uniformMore").click();
    $("compareCapture").click();
    $("presetSave").click();
    $("presetNotice").hidden = false;
    for (const panel of [240, 300]) {
      $("workspace").style.setProperty("--panel-width", `${panel}px`);
      await frames(3);
      const compare = await steady($("compareNotice"), $("parameterCompare"), [
        "아직 같음",
        "1개 다름",
        "64개 다름",
        "이전 값 보는 중",
        "아주 긴 문구가 들어와도 비교 바는 한 줄을 넘지 않습니다",
      ]);
      check(same(compare), `${panel}px: 비교 바 문구가 바뀌어도 높이 그대로 (${compare.join("/")})`);
      const preset = await steady($("presetNoticeText"), $("presetBar"), [
        "'프리셋 1'(으)로 전환 중",
        "'프리셋 1' 저장 · 이름은 칩을 두 번 눌러 바꿉니다",
        "'프리셋 1' · 64개 적용 · 0개 건너뜀",
      ]);
      check(same(preset), `${panel}px: 프리셋 알림 문구가 바뀌어도 높이 그대로 (${preset.join("/")})`);
    }
    $("compareClear").click();

    // 연결 시트: 재생 중 바뀌는 두 줄은 줄마다 한 줄로 고정
    settings.setLinks([{ name: "uA", source: "keys", min: 0, max: 1, smooth: 0, keys: [[0, 0], [0.5, 1]], loop: 1, ease: "smooth" }]);
    await frames(3);
    const row = () => document.querySelector('.uniform-row[data-name="uA"]');
    row().querySelector(".link-uniform").click();
    await frames(3);
    const status = row().querySelector(".link-loop-status");
    check(status?.children.length === 2, "연결 시트 바퀴 문구는 두 줄(uTime · 바퀴 안)");
    const lines = await steady(status.children[1], status, ["→ 바퀴 안 0.50초 · 1번째 바퀴", "→ 바퀴 안 0.50초 · 123456번째 바퀴 아주 길게 늘어난 문구"]);
    check(same(lines), `재생 중 숫자가 길어져도 연결 시트 높이 그대로 (${lines.join("/")})`);
    row().querySelector(".link-uniform").click();
    settings.setLinks([]);

    // 입력 채널 칩: 글자가 길어져도 칩 줄의 줄 수 그대로
    $("workspace").style.setProperty("--panel-width", "240px");
    studio.open();
    if ($("studioInputs").hidden) $("studioInputsToggle").click();
    await frames(3);
    const tags = [...$("studioInputs").querySelectorAll(".chip-tag")],
      bar = $("studioInputs"),
      chips = [];
    for (const text of ["꺼짐", "켜는 중", "MacBook Pro 마이크 (Built-in) 아주 긴 장치 이름"]) {
      tags[0].textContent = tags[1].textContent = text;
      await frames(1);
      chips.push(height(bar));
    }
    check(same(chips), `입력 칩 글자가 길어져도 칩 줄 높이 그대로 (${chips.join("/")})`);
    check(tags.slice(2).every(tag => tag.scrollWidth <= tag.clientWidth + 1), "짧은 상태 글자(키보드 · 비어 있음)는 잘리지 않음");
  } finally {
    if (width) $("workspace").style.setProperty("--panel-width", width);
    else $("workspace").style.removeProperty("--panel-width");
    if (!$("parameterCompare").hidden) $("compareClear").click();
    settings.setLinks(links);
    settings.setPresets(presets);
    studio.setProject(before);
    r.setUserUniforms(users);
    if (editorOpen !== !$("studioDock").hidden) editorOpen ? studio.open() : studio.close();
    if (panelHidden !== document.body.classList.contains("panel-hidden")) $("panelToggle").click();
  }
})();
