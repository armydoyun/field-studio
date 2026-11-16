// 프리셋 썸네일(preset-thumbs.js · preset-panel.js):
//  · 저장하면 그 화면을 찍어 칩에 작은 그림을 붙인다 — 그림은 실제로 그린 색을 담는다(빨간 장면 → 빨간 그림)
//  · 그림은 프리셋 데이터와 따로 둔다: 프리셋에 thumb 같은 필드가 생기지 않고, 저장 한 번은 되돌리기 한 칸 그대로
//  · 그림이 없던 프리셋(예전에 저장 · 예제)은 한 번 적용하면 생긴다 · 값이 다르면 그림도 다르다
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    settings = window.shaderSettings,
    $ = id => document.getElementById(id);
  const test = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return;
    throw new Error(`FAIL: 시간 초과 — ${label}`);
  };
  const chip = name => [...document.querySelectorAll("#presetList .preset-chip")].find(node => node.querySelector(".preset-apply").textContent === name);
  const thumbOf = name => chip(name)?.querySelector("img.preset-thumb")?.src || null;
  // 그림 가운데 픽셀의 [r, g, b]
  const centerOf = src =>
    new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        resolve([...ctx.getImageData(image.width >> 1, image.height >> 1, 1, 1).data.slice(0, 3)]);
      };
      image.src = src;
    });
  const before = studio.getProject(),
    presets = settings.getPresets(),
    blend = $("presetBlend").value;
  try {
    localStorage.removeItem("field.preset-thumbs.v1");
    test(
      studio.setProject({
        image: "uniform vec3 uTint; // @color @default 1 0 0\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(uTint, 1.0); }",
        passes: [],
        imageChannels: {},
      }),
      "검사 장면(빨강)"
    );
    await until(() => r.getUserUniforms().length === 1, "파라미터 등록");
    $("tab-uniforms").click();
    settings.setPresets([]);
    $("presetBlend").value = "0";
    $("presetSave").click();
    await until(() => thumbOf("프리셋 1"), "저장하면 칩에 그림");
    const red = await centerOf(thumbOf("프리셋 1"));
    test(red[0] > 200 && red[1] < 60 && red[2] < 60, `그림이 실제 화면 색(빨강 ${red})`);
    test(settings.getPresets().every(preset => Object.keys(preset).every(key => ["name", "values", "schema"].includes(key))), "프리셋 데이터에는 그림이 들어가지 않는다");
    studio.undo();
    await wait(50);
    test(settings.getPresets().length === 0, "저장 한 번은 되돌리기 한 칸(썸네일 때문에 칸이 늘지 않는다)");
    studio.redo();
    await wait(50);
    // 파랑으로 바꿔 두 번째 프리셋: 값이 다르면 그림도 다르다
    studio.setParameterValues([{ ...r.getUserUniforms()[0], value: [0, 0, 1] }]);
    $("presetSave").click();
    await until(() => thumbOf("프리셋 2"), "두 번째 프리셋 그림");
    const blue = await centerOf(thumbOf("프리셋 2"));
    test(blue[2] > 200 && blue[0] < 60, `값이 다르면 그림도 다르다(파랑 ${blue})`);
    // 그림이 없던 프리셋: 적용하면 생긴다
    settings.setPresets([...settings.getPresets(), { name: "예전 것", values: { uTint: [0, 1, 0] } }]);
    await wait(30);
    test(!thumbOf("예전 것"), "그림이 없던 프리셋은 이름만");
    chip("예전 것").querySelector(".preset-apply").click();
    await until(() => thumbOf("예전 것"), "적용하면 그림이 생긴다");
    const green = await centerOf(thumbOf("예전 것"));
    test(green[1] > 200 && green[0] < 60, `적용한 화면을 찍는다(초록 ${green})`);
    test(JSON.parse(localStorage.getItem("field.preset-thumbs.v1")).length === 3, "브라우저 저장소에 세 장");
  } finally {
    $("presetBlend").value = blend;
    settings.setPresets(presets);
    studio.setProject(before);
  }
  console.log("프리셋 썸네일 검사 통과");
})();
