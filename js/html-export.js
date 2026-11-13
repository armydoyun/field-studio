// 작품 하나를 HTML 한 파일로 내보내기(재생 전용). 서버 · 인터넷 없이 파일을 더블클릭해 전체 화면으로 재생한다.
// 담는 것: renderer.exportScene()이 준 컴파일 직전 GLSL(머리말 · Shadertoy 이름 · Common · 파라미터 선언 ·
// mainImage 진입점까지 붙은 것) · 버퍼 구성 · 채널 연결 · 파라미터 값(램프는 구운 자료) · 연결된 이미지(data URL).
// 재생기(player)는 이 모듈 안의 보통 함수로 쓰고 Function.prototype.toString으로 HTML에 넣는다.
// 그래서 player는 바깥 이름을 하나도 쓰지 않아야 한다(전부 매개변수 data와 브라우저 전역만).
// 버퍼 규칙은 pass-manager.js와 같다: 패스는 순서대로 그리고, current는 앞선 패스의 이번 프레임,
// previous는 지난 프레임을 읽으며, Image는 모든 패스 뒤에 그린다. 마우스 · 휠 · 키보드는 renderer.js와 같은 값을 넣는다.
// 미디어 입력(마이크 · 웹캠 · 파일)은 담지 않는다 — 그 채널은 빈 텍스처로 읽힌다.

// 재생기. data = buildPlayerData의 결과. 디버그 · 테스트용으로 window.fieldPlayer를 둔다.
const player = data => {
  const canvas = document.getElementById("field"),
    note = document.getElementById("note");
  const fail = text => {
    note.textContent = text;
    note.hidden = false;
  };
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) return fail("이 브라우저는 WebGL2를 지원하지 않습니다.");
  if (data.passes.some(pass => pass.format !== "rgba8") && !gl.getExtension("EXT_color_buffer_float"))
    return fail("이 GPU는 부동소수점 버퍼(EXT_color_buffer_float)를 지원하지 않아 재생할 수 없습니다.");
  gl.getExtension("OES_texture_float_linear");

  // ---- 프로그램 ----
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) || "컴파일 실패");
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, data.vertex);
  const TYPES = {
    [gl.FLOAT]: "float",
    [gl.FLOAT_VEC2]: "vec2",
    [gl.FLOAT_VEC3]: "vec3",
    [gl.FLOAT_VEC4]: "vec4",
    [gl.INT]: "int",
    [gl.UNSIGNED_INT]: "uint",
  };
  const link = source => {
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, source));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "링크 실패");
    const types = new Map();
    for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
      const info = gl.getActiveUniform(program, i);
      types.set(info.name.replace(/\[0\]$/, ""), TYPES[info.type] || "");
    }
    const at = name => gl.getUniformLocation(program, name);
    return {
      program,
      types,
      resolution: at("uResolution"),
      time: at("uTime"),
      delta: at("uDeltaTime"),
      frame: at("uFrame"),
      mouse: at("uMouse"),
      wheel: at("uWheel"),
      date: at("uDate"),
      frameRate: at("uFrameRate"),
      shadertoyMouse: at("iMouse"),
      channelTime: at("uChannelTime"),
      samplers: [0, 1, 2, 3].map(i => at(`iChannel${i}`)),
      samplerSizes: [0, 1, 2, 3].map(i => at(`iChannelResolution[${i}]`)),
      custom: data.uniforms.map(item => at(item.name)),
    };
  };
  let image, passes;
  try {
    image = { ...link(data.image.source), channels: data.image.channels };
    // 패스: 구성(channels = 채널 연결) + 프로그램과 위치(samplers · samplerSizes)
    passes = data.passes.map(spec => ({
      ...spec,
      ...link(spec.source),
      fbos: [],
      attachments: [],
      width: 0,
      height: 0,
      readIndex: 0,
    }));
  } catch (error) {
    return fail(`셰이더를 컴파일하지 못했습니다:\n${error.message}`);
  }

  // ---- 텍스처: 이미지 · 램프 · 키보드 ----
  const WRAP = { clamp: gl.CLAMP_TO_EDGE, repeat: gl.REPEAT, mirror: gl.MIRRORED_REPEAT };
  const sampler = (filter, wrapS, wrapT, mipmap = false) => {
    const linear = filter !== "nearest";
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      mipmap ? (linear ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST) : linear ? gl.LINEAR : gl.NEAREST
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, WRAP[wrapS] ?? gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, WRAP[wrapT] ?? gl.CLAMP_TO_EDGE);
  };
  const images = new Map(); // id → {texture, width, height}
  const loadImages = Promise.all(
    Object.entries(data.textures).map(async ([id, item]) => {
      const blob = await (await fetch(item.url)).blob();
      const bitmap = await createImageBitmap(blob, { imageOrientation: "flipY" });
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      sampler(item.sampling.filter, item.sampling.wrapS, item.sampling.wrapT);
      images.set(id, { texture, width: bitmap.width, height: bitmap.height });
      bitmap.close();
    })
  );
  // 큐브맵: 앱이 만든 6면(+X -X +Y -Y +Z -Z)을 그대로 올리고 밉맵을 만든다.
  const cubes = new Map(); // id → {texture, size}
  const loadCubes = Promise.all(
    Object.entries(data.cubemaps || {}).map(async ([id, faces]) => {
      const bitmaps = await Promise.all(faces.map(async url => createImageBitmap(await (await fetch(url)).blob())));
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
      bitmaps.forEach((bitmap, i) => {
        gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        bitmap.close();
      });
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
      cubes.set(id, { texture, size: bitmaps[0].width });
    })
  );
  const ramps = data.uniforms.map(item => {
    if (!item.ramp) return null;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (item.ramp.gradient)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(item.ramp.data));
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 256, 1, 0, gl.RED, gl.FLOAT, new Float32Array(item.ramp.data));
    sampler(item.ramp.nearest ? "nearest" : "linear", "clamp", "clamp");
    return texture;
  });
  // 키보드 256×3(쉐이더토이 호환): y = 0 누름 · 1 이번 프레임에 눌림 · 2 토글
  const keys = new Uint8Array(256 * 3);
  let keysDirty = true;
  const keyboard = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, keyboard);
  sampler("nearest", "clamp", "clamp");
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 3, 0, gl.RED, gl.UNSIGNED_BYTE, keys);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  const setKey = (code, down) => {
    if (!(code > 0 && code < 256) || (keys[code] === 255) === down) return;
    keys[code] = down ? 255 : 0;
    if (down) {
      keys[256 + code] = 255;
      keys[512 + code] = keys[512 + code] ? 0 : 255;
    }
    keysDirty = true;
  };

  // ---- 버퍼(핑퐁 두 장 · 출력 여러 개) ----
  const FORMAT = {
    rgba8: [gl.RGBA8, gl.UNSIGNED_BYTE],
    rgba16f: [gl.RGBA16F, gl.HALF_FLOAT],
    rgba32f: [gl.RGBA32F, gl.FLOAT],
  };
  const generateMips = (pass, side) => {
    for (const set of pass.attachments) {
      gl.bindTexture(gl.TEXTURE_2D, set[side]);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  };
  const allocate = (pass, width, height) => {
    for (const fbo of pass.fbos) gl.deleteFramebuffer(fbo);
    for (const set of pass.attachments) set.forEach(texture => gl.deleteTexture(texture));
    const [internal, type] = FORMAT[pass.format] || FORMAT.rgba8;
    pass.fbos = [];
    pass.attachments = Array.from({ length: pass.outputs }, () => []);
    for (let side = 0; side < 2; side++) {
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      for (let i = 0; i < pass.outputs; i++) {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, type, null);
        sampler(pass.filter, pass.wrap, pass.wrap, pass.mipmap);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, texture, 0);
        pass.attachments[i].push(texture);
      }
      if (pass.outputs > 1) gl.drawBuffers(Array.from({ length: pass.outputs }, (_, i) => gl.COLOR_ATTACHMENT0 + i));
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      pass.fbos.push(fbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (pass.mipmap) {
      generateMips(pass, 0);
      generateMips(pass, 1);
    }
    pass.width = width;
    pass.height = height;
  };
  // 화면 크기가 바뀌어 버퍼를 새로 만들면 true(누적 프레임을 0으로 돌린다 — 앱과 같다)
  const ensureTargets = (width, height) => {
    let changed = false;
    for (const pass of passes) {
      const w = pass.size ? pass.size[0] : Math.max(1, Math.floor(width * pass.scale)),
        h = pass.size ? pass.size[1] : Math.max(1, Math.floor(height * pass.scale));
      if (w !== pass.width || h !== pass.height) {
        allocate(pass, w, h);
        changed = true;
      }
    }
    return changed;
  };

  // ---- 입력: 마우스 · 휠 · 키보드(renderer.js와 같은 값) ----
  const mouse = [-1, -1],
    click = [0, 0],
    drag = [0, 0]; // iMouse의 xy: 누르고 있는 동안의 위치(Shadertoy와 같음)
  let mouseDown = false,
    clickPending = false,
    wheel = 0;
  const pointer = event => {
    const rect = canvas.getBoundingClientRect();
    mouse[0] = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    mouse[1] = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height));
    if (mouseDown) [drag[0], drag[1]] = mouse;
  };
  canvas.addEventListener("pointermove", pointer);
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    canvas.setPointerCapture?.(event.pointerId);
    pointer(event);
    [drag[0], drag[1]] = mouse;
    click[0] = mouse[0];
    click[1] = mouse[1];
    mouseDown = clickPending = true;
    canvas.focus();
  });
  canvas.addEventListener("pointerup", () => (mouseDown = false));
  canvas.addEventListener("pointerleave", () => {
    if (!mouseDown) mouse[0] = mouse[1] = -1;
  });
  const usesWheel = [image, ...passes].some(target => target.wheel !== null);
  canvas.addEventListener(
    "wheel",
    event => {
      if (event.ctrlKey || !usesWheel) return;
      event.preventDefault();
      wheel -= event.deltaY / (event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 1 : 100);
    },
    { passive: false }
  );
  addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "f" && !data.keyboard) return; // 키보드를 읽지 않는 작품: F = 전체 화면
    setKey(event.keyCode, true);
  });
  addEventListener("keyup", event => setKey(event.keyCode, false));
  addEventListener("blur", () => {
    for (let code = 0; code < 256; code++) keys[code] = keys[256 + code] = 0;
    keysDirty = true;
  });
  const fullscreen = () =>
    document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  canvas.addEventListener("dblclick", fullscreen);
  addEventListener("keydown", event => {
    if (event.key === "f" && !data.keyboard && !event.ctrlKey && !event.metaKey && !event.altKey) fullscreen();
  });

  // ---- 그리기 ----
  let frameRate = 60,
    time = 0,
    delta = 0,
    frame = 0,
    last = null;
  const upload = (target, width, height) => {
    const { types } = target;
    if (target.resolution && types.get("uResolution") === "vec3") gl.uniform3f(target.resolution, width, height, 1);
    else if (target.resolution && types.get("uResolution") === "vec2") gl.uniform2f(target.resolution, width, height);
    if (target.time && types.get("uTime") === "float") gl.uniform1f(target.time, time);
    if (target.delta && types.get("uDeltaTime") === "float") gl.uniform1f(target.delta, delta);
    const frameType = types.get("uFrame");
    if (target.frame && frameType === "int") gl.uniform1i(target.frame, frame);
    else if (target.frame && frameType === "float") gl.uniform1f(target.frame, frame);
    else if (target.frame && frameType === "uint") gl.uniform1ui(target.frame, frame);
    if (target.mouse) {
      const x = mouse[0] < 0 ? -1 : mouse[0] * width,
        y = mouse[1] < 0 ? -1 : mouse[1] * height;
      if (types.get("uMouse") === "vec4") {
        const cx = click[0] * width,
          cy = click[1] * height;
        gl.uniform4f(target.mouse, x, y, mouseDown ? cx : -cx, clickPending ? cy : -cy);
      } else if (types.get("uMouse") === "vec2") gl.uniform2f(target.mouse, x, y);
    }
    if (target.wheel && types.get("uWheel") === "float") gl.uniform1f(target.wheel, wheel);
    if (target.date && types.get("uDate") === "vec4") {
      const now = new Date(),
        midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      gl.uniform4f(target.date, now.getFullYear(), now.getMonth(), now.getDate(), (now.getTime() - midnight) / 1000);
    }
    if (target.frameRate && types.get("uFrameRate") === "float") gl.uniform1f(target.frameRate, frameRate);
    if (target.shadertoyMouse && types.get("iMouse") === "vec4") {
      const cx = click[0] * width,
        cy = click[1] * height;
      gl.uniform4f(
        target.shadertoyMouse,
        drag[0] * width,
        drag[1] * height,
        mouseDown ? cx : -cx,
        clickPending ? cy : -cy
      );
    }
    if (target.channelTime) gl.uniform1fv(target.channelTime, [time, time, time, time]); // 미디어는 담지 않는다
    data.uniforms.forEach((item, i) => {
      const location = target.custom[i];
      if (location === null) return;
      if (item.ramp) {
        gl.activeTexture(gl.TEXTURE0 + item.ramp.unit);
        gl.bindTexture(gl.TEXTURE_2D, ramps[i]);
        gl.uniform1i(location, item.ramp.unit);
        gl.activeTexture(gl.TEXTURE0);
      } else if (item.kind === "m") gl[item.fn](location, false, item.values);
      else if (item.fn) gl[item.fn](location, item.values);
      else if (item.kind === "f") gl.uniform1f(location, item.values[0]);
      else if (item.kind === "u") gl.uniform1ui(location, item.values[0]);
      else gl.uniform1i(location, item.values[0]);
    });
  };
  // 채널 읽기: Buffer는 그리는 도중(이번 프레임 결과는 1 - readIndex), Image는 모든 패스와 교대가 끝난 뒤(readIndex).
  const bindChannels = (target, forImage) => {
    for (let i = 0; i < 4; i++) {
      const ref = target.channels?.[i];
      let texture = null,
        cube = null,
        width = 0,
        height = 0;
      if (ref?.cubemap && cubes.has(ref.cubemap))
        [cube, width, height] = [
          cubes.get(ref.cubemap).texture,
          cubes.get(ref.cubemap).size,
          cubes.get(ref.cubemap).size,
        ];
      else if (ref?.keyboard) [texture, width, height] = [keyboard, 256, 3];
      else if (ref?.texture && images.has(ref.texture)) ({ texture, width, height } = images.get(ref.texture));
      else if (ref?.buffer) {
        const pass = passes.find(p => p.name === ref.buffer),
          current = 1 - pass.readIndex,
          side = ref.frame === "previous" ? (forImage ? current : pass.readIndex) : forImage ? pass.readIndex : current;
        texture = pass.attachments[ref.attachment || 0]?.[side] ?? null;
        [width, height] = [pass.width, pass.height];
      }
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
      if (target.samplers[i] !== null) gl.uniform1i(target.samplers[i], i);
      if (target.samplerSizes[i] !== null) gl.uniform3f(target.samplerSizes[i], width, height, width ? 1 : 0);
    }
    gl.activeTexture(gl.TEXTURE0);
  };
  const release = () => {
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    }
    gl.activeTexture(gl.TEXTURE0);
  };
  const reads = []; // fieldPlayer.readPixel 요청: 그린 직후 같은 프레임에서 읽는다
  const vao = gl.createVertexArray();
  const draw = now => {
    requestAnimationFrame(draw);
    const elapsed = last === null ? 0 : Math.max(0, (now - last) * 0.001);
    last = now;
    delta = elapsed * data.timeScale;
    time += delta;
    if (elapsed > 0) frameRate = frameRate * 0.9 + (1 / elapsed) * 0.1;
    const dpr = Math.min(devicePixelRatio || 1, 2) * data.resolutionScale,
      width = Math.max(1, Math.round(canvas.clientWidth * dpr)),
      height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) [canvas.width, canvas.height] = [width, height];
    if (ensureTargets(width, height)) frame = 0;
    if (keysDirty) {
      gl.bindTexture(gl.TEXTURE_2D, keyboard);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 3, gl.RED, gl.UNSIGNED_BYTE, keys);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      keysDirty = false;
    }
    gl.bindVertexArray(vao);
    for (const pass of passes) {
      release();
      gl.bindFramebuffer(gl.FRAMEBUFFER, pass.fbos[1 - pass.readIndex]);
      gl.viewport(0, 0, pass.width, pass.height);
      gl.useProgram(pass.program);
      upload(pass, pass.width, pass.height);
      bindChannels(pass, false);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (pass.mipmap) {
        release();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        generateMips(pass, 1 - pass.readIndex);
      }
    }
    for (const pass of passes) pass.readIndex = 1 - pass.readIndex;
    release();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(image.program);
    upload(image, width, height);
    bindChannels(image, true);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    release();
    for (const { x, y, resolve } of reads.splice(0)) {
      const pixel = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      resolve([...pixel]);
    }
    clickPending = false;
    if (keys.subarray(256, 512).some(Boolean)) {
      keys.fill(0, 256, 512);
      keysDirty = true;
    }
    frame++;
  };
  window.fieldPlayer = {
    // 다음 프레임을 그린 직후 화면 픽셀(아래 왼쪽이 0, 0)을 [r, g, b, a] 0~255로 돌려준다.
    readPixel: (x, y) => new Promise(resolve => reads.push({ x, y, resolve })),
    get frame() {
      return frame;
    },
    ready: null,
  };
  window.fieldPlayer.ready = Promise.all([loadImages, loadCubes]).then(
    () => requestAnimationFrame(draw),
    error => fail(`이미지를 읽지 못했습니다: ${error.message}`)
  );
};

// renderer.exportScene()과 이미지(id → {url: data URL, sampling}) · 큐브맵(id → 6면 PNG data URL)으로 재생기 자료를 만든다.
const buildPlayerData = (scene, textures, cubemaps = {}) => {
  const refs = [scene.image.channels, ...scene.passes.map(pass => pass.channels)].flatMap(channels =>
    Object.values(channels || {})
  );
  return {
    ...scene,
    textures,
    cubemaps,
    keyboard: refs.some(ref => ref?.keyboard),
    media: [...new Set(refs.map(ref => ref?.media).filter(Boolean))],
  };
};

const escapeHTML = text =>
  String(text).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
// <script> 안에 넣을 JSON: 닫는 script 태그나 HTML 주석 시작으로 읽히지 않게 < 를 유니코드 이스케이프(u003c)로 바꾼다(JSON 문자열 안에서는 같은 글자다).
// U+2028 · U+2029(줄 구분 문자)도 이스케이프해 둔다.
const scriptJSON = value =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

// 재생 전용 HTML 한 파일. title: 문서 제목(작품 이름).
// 이 글자들은 배포본(앱 전체를 HTML 한 파일에 넣은 것) 안의 JS 문자열이기도 하다. 그래서 <style>에 id를 붙여
// 배포본의 진짜 인라인 스타일과 글자로 구별되게 한다(tests/build-regression.js가 <style>을 하나만 센다).
const buildPlayerHTML = (data, title = "FIELD Shader") => {
  const hint = [
    "더블클릭 · F: 전체 화면",
    data.keyboard ? "클릭 후 키보드 입력" : "",
    data.media.length ? "미디어 입력(마이크 · 카메라 · 파일)은 이 파일에서 재생되지 않습니다" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="FIELD Studio">
<title>${escapeHTML(title)}</title>
<style id="player-style">
html,body{margin:0;height:100%;background:#000;overflow:hidden}
canvas{display:block;width:100vw;height:100vh;outline:none;touch-action:none}
#note{position:fixed;inset:auto 16px 16px;margin:0;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,.72);color:#eee;font:13px/1.5 system-ui,sans-serif;white-space:pre-wrap}
#hint{position:fixed;right:12px;bottom:10px;margin:0;color:rgba(255,255,255,.55);font:11px/1.4 system-ui,sans-serif;transition:opacity 1s 3s;pointer-events:none}
body:hover #hint{opacity:1}#hint{opacity:0}
</style>
</head>
<body>
<canvas id="field" tabindex="0" aria-label="${escapeHTML(title)}"></canvas>
<p id="note" role="alert" hidden></p>
<p id="hint">${escapeHTML(hint)}</p>
<script>
"use strict";
(${player.toString()})(${scriptJSON(data)});
</script>
</body>
</html>
`;
};

export { buildPlayerData, buildPlayerHTML, player };
