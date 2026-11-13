// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 큐브맵 채널(js/cubemap.js · texture-input.js · pass-manager.js · html-export.js):
//  · 4:3 가로 십자 이미지를 큐브맵으로 연결하면 여섯 방향이 각 면의 색을 읽는다(실제 samplerCube)
//  · 코드가 iChannel0을 선언하지 않으면 연결 종류(samplerCube)로 자동 선언 · iChannelResolution = 한 면 크기
//  · 같은 채널을 이미지 ↔ 큐브맵으로 바꾸면 패스를 다시 만들어(sampler 타입) 그대로 동작
//  · 2:1 파노라마 · 비율이 맞지 않으면 거부 · HTML로 내보낸 재생기도 같은 색(Pack은 tests/cubemap-regression.js)
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const COLORS = { "+X": "#ff0000", "-X": "#00ffff", "+Y": "#00ff00", "-Y": "#ff00ff", "+Z": "#0000ff", "-Z": "#ffff00" };
  const RGB = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const png = (width, height, draw, name) => new Promise(resolve => {
    const canvas = Object.assign(document.createElement("canvas"), { width, height });
    draw(canvas.getContext("2d"));
    canvas.toBlob(blob => resolve(new File([blob], name, { type: "image/png" })), "image/png");
  });
  // 가로 십자: 칸 32px. +Y는 (1,0), -X +Z +X -Z는 둘째 줄, -Y는 (1,2)
  const cross = await png(128, 96, ctx => {
    const cell = (name, x, y) => { ctx.fillStyle = COLORS[name]; ctx.fillRect(x * 32, y * 32, 32, 32); };
    cell("+Y", 1, 0); cell("-X", 0, 1); cell("+Z", 1, 1); cell("+X", 2, 1); cell("-Z", 3, 1); cell("-Y", 1, 2);
  }, "cross.png");
  // 2:1 파노라마: 위 절반 초록(+Y 쪽), 아래 절반 자주(-Y 쪽)
  const pano = await png(64, 32, ctx => { ctx.fillStyle = COLORS["+Y"]; ctx.fillRect(0, 0, 64, 16); ctx.fillStyle = COLORS["-Y"]; ctx.fillRect(0, 16, 64, 16); }, "pano.png");
  // Buffer A(4×2): x + 4y 번째 방향의 큐브맵 색. 마지막 칸(3,1)은 iChannelResolution[0].x / 32
  const DIRS = "vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1)";
  const buffer = [
    "void mainImage(out vec4 c, in vec2 p) {",
    `    vec3 dirs[6] = vec3[6](${DIRS});`,
    "    int i = int(p.x) + 4 * int(p.y);",
    "    c = i < 6 ? vec4(texture(iChannel0, dirs[i]).rgb, 1.0) : vec4(iChannelResolution[0].x / 32.0);",
    "}",
  ].join("\n");
  const project = ref => ({
    image: "void mainImage(out vec4 c, in vec2 p) { c = texelFetch(iChannel0, ivec2(p) % ivec2(4, 2), 0); }",
    passes: [{ name: "A", fragment: buffer, format: "rgba32f", scale: 1, size: [4, 2], filter: "nearest", channels: { 0: ref } }],
    imageChannels: { 0: { buffer: "A", frame: "current" } },
  });
  const cell = i => Array.from(r.readPassPixel("A", i % 4, Math.floor(i / 4))).slice(0, 3).map(v => Math.round(v * 100) / 100);
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.02);
  const before = studio.getProject(), wasRunning = r.getStats().running;
  const ids = [];
  let frame = null;
  try {
    if (!wasRunning) studio.togglePlayback();
    const crossId = (await r.addTexture(cross)).id, panoId = (await r.addTexture(pano)).id;
    ids.push(crossId, panoId);

    // 1) 십자 큐브맵: 여섯 방향 · 자동 samplerCube 선언 · 한 면 크기
    test(studio.setProject(project({ cubemap: crossId })), "iChannel0을 선언하지 않은 코드 + 큐브맵 채널");
    await frames(3);
    Object.keys(COLORS).forEach((face, i) => test(same(cell(i), RGB(COLORS[face])), `${face} 방향 = ${face} 면 색: ${cell(i)}`));
    test(cell(7)[0] === 1, `iChannelResolution = 한 면 32px: ${cell(7)}`);

    // 2) 같은 채널을 이미지(sampler2D)로 바꿨다가 다시 큐브맵으로: 다시 만들어 오류 없이
    const asImage = project({ texture: crossId });
    asImage.passes[0].fragment = "void mainImage(out vec4 c, in vec2 p) { c = texture(iChannel0, vec2(0.6, 0.5)); }";
    test(studio.setProject(asImage), "같은 이미지를 2D 채널로");
    await frames(2);
    test(same(cell(0), RGB(COLORS["+X"])), `2D로 읽은 십자 이미지의 (0.6, 0.5) = +X 칸: ${cell(0)}`);
    test(studio.setProject(project({ cubemap: crossId })), "다시 큐브맵으로");
    await frames(2);
    test(same(cell(4), RGB(COLORS["+Z"])), `다시 큐브맵: +Z ${cell(4)}`);

    // 3) 2:1 파노라마: 위(+Y)는 초록, 아래(-Y)는 자주
    test(studio.setProject(project({ cubemap: panoId })), "파노라마 큐브맵");
    await frames(2);
    test(same(cell(2), RGB(COLORS["+Y"])) && same(cell(3), RGB(COLORS["-Y"])), `파노라마 위 · 아래: ${cell(2)} / ${cell(3)}`);

    // 4) 비율이 맞지 않는 이미지는 큐브맵으로 연결하지 않는다
    const square = (await r.addTexture(await png(16, 16, ctx => ctx.fillRect(0, 0, 16, 16), "square.png"))).id;
    ids.push(square);
    test(!studio.setProject(project({ cubemap: square })), "정사각형 이미지는 큐브맵 거부");

    // 5) HTML로 내보내기: 재생기도 같은 면(+X 방향 = 빨강)
    test(studio.setProject(project({ cubemap: crossId })), "내보낼 큐브맵 프로젝트");
    await frames(2);
    const { html, data } = await studio.buildPlayerHTML();
    test(Object.keys(data.cubemaps).length === 1 && data.cubemaps[crossId].length === 6, "HTML에 6면을 담는다");
    frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;left:0;top:0;width:80px;height:40px;border:0;z-index:99999";
    document.body.append(frame);
    await new Promise(resolve => { frame.onload = resolve; frame.srcdoc = html; });
    await frame.contentWindow.fieldPlayer.ready;
    await frame.contentWindow.fieldPlayer.readPixel(0, 0);
    const canvas = frame.contentDocument.getElementById("field");
    // 재생기 화면은 버퍼 4×2를 타일로 깐다: 화면 (x, y) → 버퍼 (x % 4, y % 2). (0, 0) = +X 방향, (0, 1) = +Z 방향
    const px = await frame.contentWindow.fieldPlayer.readPixel(0, 0);
    test(px[0] === 255 && px[1] === 0 && px[2] === 0, `HTML 재생기의 +X 방향: ${px} (${canvas.width}×${canvas.height})`);
    const pz = await frame.contentWindow.fieldPlayer.readPixel(0, 1);
    test(pz[0] === 0 && pz[1] === 0 && pz[2] === 255, `HTML 재생기의 +Z 방향: ${pz}`);
  } finally {
    frame?.remove();
    studio.setProject(before);
    for (const id of ids) await r.removeTexture?.(id);
    if (r.getStats().running !== wasRunning) studio.togglePlayback();
  }
  console.log("큐브맵 채널 회귀 테스트 완료");
})();
