// WebGL 리소스, 애니메이션 루프, 입력 및 컨텍스트 복구를 한곳에서 소유한다.
// 외부에는 createRenderer()로 만든 작은 제어 API만 노출한다.
import * as PassManager from "./pass-manager.js";
import * as TextureInput from "./texture-input.js";
import * as Diagnostics from "./gpu-diagnostics.js";
import * as Keyboard from "./keyboard-input.js";
import * as Ramp from "./ramp.js";

// 사용자 Uniform 타입 표. n: 성분 수, kind: f(float) i(int) u(uint) b(bool) m(행렬, column-major), fn: 배열 업로드 함수.
// 새 타입은 이 표에 추가하면 검증·GLSL 자동 선언·업로드·UI가 함께 따라간다.
const UNIFORM_TYPES = Object.freeze({
  float: { n: 1, kind: "f" },
  vec2: { n: 2, kind: "f", fn: "uniform2fv" },
  vec3: { n: 3, kind: "f", fn: "uniform3fv" },
  vec4: { n: 4, kind: "f", fn: "uniform4fv" },
  int: { n: 1, kind: "i" },
  ivec2: { n: 2, kind: "i", fn: "uniform2iv" },
  ivec3: { n: 3, kind: "i", fn: "uniform3iv" },
  ivec4: { n: 4, kind: "i", fn: "uniform4iv" },
  uint: { n: 1, kind: "u" },
  uvec2: { n: 2, kind: "u", fn: "uniform2uiv" },
  uvec3: { n: 3, kind: "u", fn: "uniform3uiv" },
  uvec4: { n: 4, kind: "u", fn: "uniform4uiv" },
  bool: { n: 1, kind: "b" },
  bvec2: { n: 2, kind: "b", fn: "uniform2iv" },
  bvec3: { n: 3, kind: "b", fn: "uniform3iv" },
  bvec4: { n: 4, kind: "b", fn: "uniform4iv" },
  mat2: { n: 4, kind: "m", fn: "uniformMatrix2fv" },
  mat3: { n: 9, kind: "m", fn: "uniformMatrix3fv" },
  mat4: { n: 16, kind: "m", fn: "uniformMatrix4fv" },
  // 램프 텍스처: @gradient(색 정지점 [t r g b a]…) · @curve(점 [x y]…)를 256×1 텍스처로 구워 넘긴다. n은 가변(0).
  sampler2D: { n: 0, kind: "t" },
});
// 램프(@gradient · @curve) 동시에 쓸 수 있는 개수. 텍스처 유닛은 iChannel 0~3 다음인 4번부터 쓴다. 굽기는 ramp.js.
const RAMP_MAX_COUNT = 8,
  RAMP_FIRST_UNIT = 4,
  { RAMP_MAX_POINTS, RAMP_SIZE, bakeRamp, sampleRamp } = Ramp;
// 리플렉션을 사용할 수 없는 환경에서의 내장 Uniform 기본 타입(기존 동작).
const DEFAULT_BUILTIN_TYPES = Object.freeze({
  resolution: "vec2",
  time: "float",
  delta: "float",
  frame: "int",
  mouse: "vec2",
  wheel: "float",
});

const createRenderer = (canvas, sources, onStatus = () => {}) => {
  // 깊이/스텐실/멀티샘플 버퍼 없이 전체 화면 Fragment Shader 하나로 그린다.
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error("WebGL 2.0을 사용할 수 없습니다.");
  // program/vao/uniforms는 컨텍스트 복구 시 재생성하는 GPU 종속 리소스다.
  const vertexSource = sources.vertex;
  let fragmentSource = sources.fragment;
  let program = null,
    vao = null,
    uniforms = null;
  // frame: 예약된 requestAnimationFrame ID / frameCount: 실제 그린 프레임 수.
  // time은 화면이 그려지는 동안의 누적 시간(초)이며 일시 정지 중에는 흐르지 않는다.
  let frame = 0,
    frameCount = 0,
    lastTime = null,
    time = 0,
    lastDelta = 0;
  // timeScale: 재생 배속(uTime·uTimeDelta에 곱한다). stepDelta: 일시정지 중 한 프레임 진행할 때 쓸 시간(초).
  let timeScale = 1,
    stepDelta = 0;
  // 오프라인(영상) 렌더링 중이면 { width, height, saved, resume }. 이 동안에는 실시간 루프·입력·구성 변경을 막고,
  // renderOfflineFrame()이 정한 시간·크기로만 그린다.
  let offline = null,
    offlineLost = null; // 영상 렌더링 중에 컨텍스트를 잃었을 때 endOffline()이 되돌릴 상태
  const assertOnline = () => {
    if (offline) throw new Error("영상 렌더링 중에는 바꿀 수 없습니다.");
  };
  // FPS는 약 1초 구간의 화면 갱신 횟수다. 정확한 GPU 셰이더 실행 시간은 아니다.
  let resolutionScale = 1,
    fps = 0,
    fpsFrames = 0,
    fpsStart = null;
  let running = false,
    lost = false,
    disposed = false;
  let captureQueue = [],
    capturePaused = false;
  const frameListeners = new Set();
  // 0은 FPS/픽셀 수 제한 없음. 시간 제한은 rAF를 유지하며 실제 드로우만 생략한다.
  let fpsLimit = 0,
    maxPixels = 0,
    nextFrameAt = 0;
  const userUniforms = new Map();
  // 마우스는 0~1 상대 좌표로 보관하고 Uniform 전송 시 버퍼 픽셀 좌표로 환산한다.
  // uMouse를 vec4로 선언하면 zw에 클릭 위치를 전달한다: z>0 버튼 누름 중, w>0 누른 직후 첫 프레임.
  const mouse = [-1, -1],
    click = [0, 0];
  let mouseDown = false,
    clickPending = false;
  // uWheel: 뷰포트에서 굴린 휠의 누적 칸 수(위로 굴리면 +1). 시간 초기화 때 0으로 돌아간다.
  let wheel = 0;
  // 성능 지표: cpuMs는 프레임당 GL 명령 제출 시간(JS), frameMs는 rAF 간격, GPU 시간은 gpuTimer가 측정한다.
  const clock =
    typeof performance === "object" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now();
  let cpuMs = 0,
    frameMs = 0;
  const gpuTimer = Diagnostics.createGpuTimer(gl);
  const createShader = (type, source) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Shader 생성 실패");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader),
        typeName = type === gl.VERTEX_SHADER ? "Vertex" : "Fragment";
      const numbered = source
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(3)} | ${line}`)
        .join("\n");
      gl.deleteShader(shader);
      throw new Error(`${typeName} Shader 컴파일 실패:\n${error || "로그 없음"}\n\n${numbered}`);
    }
    return shader;
  };
  // Vertex/Fragment를 연결한 GPU 프로그램을 새로 만든다.
  const createProgram = fragment => {
    let vs = null,
      fs = null,
      result = null;
    try {
      vs = createShader(gl.VERTEX_SHADER, vertexSource);
      fs = createShader(gl.FRAGMENT_SHADER, fragment);
      result = gl.createProgram();
      if (!result) throw new Error("Program 생성 실패");
      gl.attachShader(result, vs);
      gl.attachShader(result, fs);
      gl.linkProgram(result);
      if (!gl.getProgramParameter(result, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(result) || "Program 링크 실패");
      return result;
    } catch (error) {
      if (result) gl.deleteProgram(result);
      throw error;
    } finally {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
    }
  };
  const textureInput = TextureInput.createTextureInput(gl);
  // 키보드 입력 텍스처(쉐이더토이 호환 256×3). 키를 넘길지는 input.js가 정하고 setKey로 알려 준다.
  const keyboard = Keyboard.create(gl);
  const passManager = PassManager.createPassManager(gl, source => compileFragment(source), textureInput, keyboard);
  // 다음 프레임 예약을 취소한다. lastTime을 지워 재시작 첫 delta를 0으로 만든다.
  const cancelFrame = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = fpsStart = null;
    fps = fpsFrames = 0;
    nextFrameAt = 0;
  };
  // CSS 표시 크기와 GPU의 실제 Drawing Buffer 크기를 분리한다.
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * resolutionScale;
    let width = offline ? offline.width : Math.max(1, Math.round(canvas.clientWidth * dpr));
    let height = offline ? offline.height : Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (!offline && maxPixels && width * height > maxPixels) {
      const factor = Math.sqrt(maxPixels / (width * height));
      width = Math.max(1, Math.floor(width * factor));
      height = Math.max(1, Math.floor(height * factor));
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  };
  const uniformSpec = type => (Object.hasOwn(UNIFORM_TYPES, type) ? UNIFORM_TYPES[type] : null);
  const normalizeUniform = (type, value) => {
    const spec = uniformSpec(type),
      valid = v =>
        !spec
          ? false
          : spec.kind === "b"
            ? typeof v === "boolean"
            : typeof v === "number" &&
              Number.isFinite(v) &&
              (spec.kind === "i"
                ? Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
                : spec.kind === "u"
                  ? Number.isInteger(v) && v >= 0 && v <= 4294967295
                  : true);
    if (spec?.kind === "t" && (Array.isArray(value) || ArrayBuffer.isView(value))) {
      const array = Array.from(value);
      if (
        array.length >= 4 &&
        array.length <= RAMP_MAX_POINTS * 5 &&
        array.every(v => typeof v === "number" && Number.isFinite(v))
      )
        return array;
    }
    if (spec?.n === 1 && valid(value)) return value;
    if (spec?.n > 1 && (Array.isArray(value) || ArrayBuffer.isView(value))) {
      const array = Array.from(value);
      if (array.length === spec.n && array.every(valid)) return array;
    }
    throw new TypeError(`Uniform 타입(${type})에 맞지 않는 값입니다.`);
  };
  // dir 옵션 Uniform의 값: 길이 1. hemi면 Y를 +쪽으로 뒤집는다(annotations.normalizeDirection과 같은 규칙).
  const unitDirection = (value, mode) => {
    const v = [...value];
    if (mode === "hemi") v[1] = Math.abs(v[1]);
    const length = Math.hypot(...v);
    if (!(length > 1e-9)) throw new Error("방향 벡터는 0 벡터일 수 없습니다.");
    return v.map(x => x / length);
  };
  // 램프 값 정리: 정지점 단위로 묶어 위치(0~1) 순으로 정렬한다. gradient 색은 0~1, curve y는 그대로(범위는 편집기 표시용).
  const normalizeRamp = (value, options) => {
    const stride = options.gradient ? 5 : 2;
    if (value.length % stride || value.length / stride < 2 || value.length / stride > RAMP_MAX_POINTS)
      throw new Error(
        options.gradient
          ? `그라데이션은 정지점 [위치 r g b a] 2~${RAMP_MAX_POINTS}개여야 합니다.`
          : `곡선은 점 [x y] 2~${RAMP_MAX_POINTS}개여야 합니다.`
      );
    const points = [];
    for (let i = 0; i < value.length; i += stride) {
      const point = value.slice(i, i + stride);
      point[0] = Math.min(1, Math.max(0, point[0]));
      if (options.gradient) for (let k = 1; k < 5; k++) point[k] = Math.min(1, Math.max(0, point[k]));
      points.push(point);
    }
    points.sort((a, b) => a[0] - b[0]);
    return points.flat();
  };
  // 벡터/행렬은 등록·변경 시점에 Typed Array로 한 번 변환해 두어 매 프레임 할당 없이 업로드한다.
  // 램프는 256×1 텍스처 자료(gradient RGBA8 · curve R16F용 Float32)를 미리 구워 둔다.
  const makeData = (type, options = {}) => {
    const spec = UNIFORM_TYPES[type];
    if (spec.kind === "t") return options.gradient ? new Uint8Array(RAMP_SIZE * 4) : new Float32Array(RAMP_SIZE);
    if (spec.n === 1) return null;
    return spec.kind === "u"
      ? new Uint32Array(spec.n)
      : spec.kind === "i" || spec.kind === "b"
        ? new Int32Array(spec.n)
        : new Float32Array(spec.n);
  };
  let rampSerial = 0;
  const writeData = item => {
    if (!item.data) return item;
    if (UNIFORM_TYPES[item.type].kind === "t") {
      bakeRamp(item.options, item.value, item.data);
      item.serial = ++rampSerial;
      return item;
    }
    const bool = UNIFORM_TYPES[item.type].kind === "b";
    for (let i = 0; i < item.data.length; i++) item.data[i] = bool ? (item.value[i] ? 1 : 0) : item.value[i];
    return item;
  };
  // 램프 텍스처 캐시(이름별). 값이 바뀐 것(serial)만 다시 올린다. 등록이 바뀌면 pruneRamps가, 컨텍스트 손실 때는 참조만 버린다.
  const rampTextures = new Map();
  const bindRamp = (name, item, unit) => {
    const kind = item.options.gradient ? `gradient-${item.options.gradient}` : "curve";
    let entry = rampTextures.get(name);
    if (entry && entry.kind !== kind) {
      gl.deleteTexture(entry.texture);
      entry = null;
    }
    if (!entry) {
      entry = { texture: gl.createTexture(), serial: -1, kind };
      rampTextures.set(name, entry);
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    if (entry.serial !== item.serial) {
      if (item.options.gradient)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, RAMP_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, item.data);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, RAMP_SIZE, 1, 0, gl.RED, gl.FLOAT, item.data);
      const filter = item.options.gradient === "step" ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      entry.serial = item.serial;
    }
    gl.activeTexture(gl.TEXTURE0);
  };
  const pruneRamps = () => {
    for (const [name, entry] of rampTextures)
      if (UNIFORM_TYPES[userUniforms.get(name)?.type]?.kind !== "t") {
        if (!lost) gl.deleteTexture(entry.texture);
        rampTextures.delete(name);
      }
  };
  const uploadCustomUniforms = target => {
    if (!target.custom) target.custom = new Map();
    let rampUnit = RAMP_FIRST_UNIT;
    for (const [name, item] of userUniforms) {
      if (!target.custom.has(name)) target.custom.set(name, gl.getUniformLocation(target.program, name));
      const location = target.custom.get(name);
      const spec = UNIFORM_TYPES[item.type],
        v = item.value;
      // 램프는 쓰지 않는 패스에서도 유닛 번호를 차지해 패스마다 같은 유닛을 쓴다.
      if (spec.kind === "t") {
        const unit = rampUnit++;
        if (location !== null && location !== undefined) {
          bindRamp(name, item, unit);
          gl.uniform1i(location, unit);
        }
        continue;
      }
      if (location === null || location === undefined) continue;
      if (spec.n === 1) {
        if (spec.kind === "f") gl.uniform1f(location, v);
        else if (spec.kind === "u") gl.uniform1ui(location, v);
        else gl.uniform1i(location, spec.kind === "b" ? (v ? 1 : 0) : v);
      } else if (spec.kind === "m") gl[spec.fn](location, false, item.data);
      else gl[spec.fn](location, item.data);
    }
  };
  // Image와 Buffer 패스가 공유하는 시간/입력/엔진 설정 업로드.
  // Fragment Shader에서 미사용한 Uniform은 Location이 null이므로 건너뛴다.
  // 선언 타입(리플렉션)에 맞는 함수로 전송하며, 허용되지 않는 타입은 makeLocations에서 이미 제외됐다.
  const uploadGlobals = (target, width, height) => {
    const types = target.types || DEFAULT_BUILTIN_TYPES;
    if (target.resolution != null) {
      if (types.resolution === "vec3") gl.uniform3f(target.resolution, width, height, 1);
      else gl.uniform2f(target.resolution, width, height);
    }
    if (target.time != null) gl.uniform1f(target.time, time);
    if (target.delta != null) gl.uniform1f(target.delta, lastDelta);
    if (target.frame != null) {
      if (types.frame === "float") gl.uniform1f(target.frame, frameCount);
      else if (types.frame === "uint") gl.uniform1ui(target.frame, frameCount);
      else gl.uniform1i(target.frame, frameCount);
    }
    if (target.mouse != null) {
      const x = mouse[0] < 0 ? -1 : mouse[0] * width,
        y = mouse[1] < 0 ? -1 : mouse[1] * height;
      if (types.mouse === "vec4") {
        const cx = click[0] * width,
          cy = click[1] * height;
        gl.uniform4f(target.mouse, x, y, mouseDown ? cx : -cx, clickPending ? cy : -cy);
      } else gl.uniform2f(target.mouse, x, y);
    }
    if (target.wheel != null) gl.uniform1f(target.wheel, wheel);
    uploadCustomUniforms(target);
  };
  const buildFragment = source => {
    if (typeof source !== "string") throw new TypeError("Fragment Shader는 문자열이어야 합니다.");
    const declarations = [],
      code = source.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*/g, s => s.replace(/[^\r\n]/g, " "));
    const uniforms = [...code.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+([^;{}]+);/g)];
    for (const [name, item] of userUniforms) {
      const match = uniforms.find(m => m[2].split(",").some(part => part.trim().match(/^[A-Za-z_]\w*/)?.[0] === name));
      if (match) {
        const part = match[2].split(",").find(part => part.trim().match(/^[A-Za-z_]\w*/)?.[0] === name);
        if (match[1] !== item.type || part.includes("["))
          throw new Error(`${name}: GLSL 선언(${match[1]})과 등록 타입(${item.type})이 다릅니다.`);
      } else declarations.push(`uniform ${item.type} ${name};`);
    }
    if (!declarations.length) return { source };
    const marker = /\bprecision\s+(?:lowp|mediump|highp)\s+float\s*;/.exec(code);
    if (!source.startsWith("#version 300 es") || !marker)
      throw new Error("사용자 Uniform을 추가하려면 GLSL ES 3.00과 float precision 선언이 필요합니다.");
    const end = marker.index + marker[0].length,
      tail = source.slice(end),
      extra = /^[^\r\n]*\S/.test(tail.split(/\r?\n/)[0]) ? "\n" : "";
    return {
      source: source.slice(0, end) + "\n" + declarations.join("\n") + extra + tail,
      injected: {
        after: source.slice(0, end).split("\n").length,
        count: declarations.length + extra.length,
        generated: declarations.length,
      },
    };
  };
  // 삽입 위치와 진단 보정은 같은 결과를 사용한다. 한 줄 GLSL도 원본 줄을 보존한다.
  const compileFragment = source => {
    const compiled = buildFragment(source);
    try {
      return createProgram(compiled.source);
    } catch (error) {
      if (compiled.injected && error.message?.startsWith("Fragment Shader 컴파일 실패:"))
        error.glslInjected = compiled.injected;
      throw error;
    }
  };
  // requestAnimationFrame 시간값(now)은 밀리초. 셰이더에는 초 단위로 전달한다.
  // 표시하지 않는 탭/손실된 컨텍스트에서는 GPU 호출을 하지 않는다.
  const render = now => {
    frame = 0;
    if (offline || !running || lost || disposed || document.hidden || !program) return;
    if (fpsLimit > 0 && nextFrameAt && now + 0.5 < nextFrameAt) {
      scheduleFrame();
      return;
    }
    if (fpsLimit > 0) {
      const interval = 1000 / fpsLimit;
      nextFrameAt = nextFrameAt
        ? nextFrameAt + Math.max(1, Math.floor((now - nextFrameAt) / interval) + 1) * interval
        : now + interval;
    }
    resize();
    const elapsed = lastTime === null ? 0 : Math.max(0, (now - lastTime) * 0.001),
      delta = stepDelta || elapsed * timeScale;
    stepDelta = 0;
    lastTime = now;
    time += delta;
    const cpuStart = clock();
    try {
      if (passManager.ensureTargets(gl.drawingBufferWidth, gl.drawingBufferHeight)) frameCount = 0;
      lastDelta = delta;
      keyboard.upload();
      gl.bindVertexArray(vao);
      passManager.drawPasses(gl.drawingBufferWidth, gl.drawingBufferHeight, uploadGlobals, gpuTimer);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gpuTimer.begin(passManager.getPreview() ? "Preview" : "Image");
      try {
        if (!passManager.drawPreview(gl.drawingBufferWidth, gl.drawingBufferHeight)) {
          gl.useProgram(program);
          uploadGlobals(uniforms, gl.drawingBufferWidth, gl.drawingBufferHeight);
          passManager.bindImage(uniforms);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          passManager.unbindImage();
        }
      } finally {
        gpuTimer.end();
      }
      gpuTimer.endFrame();
      clickPending = false;
      keyboard.endFrame();
      const cpu = clock() - cpuStart;
      cpuMs = cpuMs ? cpuMs * 0.9 + cpu * 0.1 : cpu;
      if (elapsed > 0) frameMs = frameMs ? frameMs * 0.9 + elapsed * 100 : elapsed * 1000;
    } catch (error) {
      const pending = captureQueue.splice(0);
      pending.forEach(({ reject }) => reject(error));
      capturePaused = false;
      console.error(error);
      onStatus(`Buffer 렌더링 실패: ${error.message}`);
      stop();
      return;
    }
    // 녹화(recorder.js) 등: 그린 직후라 드로잉 버퍼가 아직 남아 있을 때 캔버스를 복사하게 한다.
    for (const listener of frameListeners)
      try {
        listener(canvas);
      } catch (error) {
        console.warn(error);
      }
    if (captureQueue.length) {
      const pending = captureQueue.splice(0);
      try {
        const w = gl.drawingBufferWidth,
          h = gl.drawingBufferHeight,
          pixels = new Uint8Array(w * h * 4);
        Diagnostics.clearErrors(gl);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error(`Screenshot readPixels 오류: ${error}`);
        const flipped = new Uint8ClampedArray(pixels.length),
          stride = w * 4;
        for (let y = 0; y < h; y++) flipped.set(pixels.subarray(y * stride, (y + 1) * stride), (h - 1 - y) * stride);
        const output = document.createElement("canvas");
        output.width = w;
        output.height = h;
        const context = output.getContext("2d");
        if (!context) throw new Error("2D Canvas를 사용할 수 없습니다.");
        context.putImageData(new ImageData(flipped, w, h), 0, 0);
        output.toBlob(
          blob => pending.forEach(({ resolve, reject }) => (blob ? resolve(blob) : reject(new Error("PNG 생성 실패")))),
          "image/png"
        );
      } catch (error) {
        pending.forEach(({ reject }) => reject(error));
      }
    }
    frameCount++;
    // 지나간 약 1초 동안의 실제 렌더링 프레임 수로 FPS를 추정한다.
    if (fpsStart === null) fpsStart = now;
    fpsFrames++;
    if (now - fpsStart >= 1000) {
      fps = (fpsFrames * 1000) / (now - fpsStart);
      fpsFrames = 0;
      fpsStart = now;
    }
    if (capturePaused) {
      capturePaused = false;
      stop();
    } else scheduleFrame();
  };
  const scheduleFrame = () => {
    if (offline) return;
    if (running && !lost && !disposed && !document.hidden && program && !frame) frame = requestAnimationFrame(render);
  };
  const replacePrograms = (source, updatePasses = () => {}) => {
    if (disposed) throw new Error("이미 폐기된 Renderer입니다.");
    assertOnline();
    if (lost) throw new Error("WebGL 컨텍스트 복구 대기 중입니다.");
    if (typeof source !== "string") throw new TypeError("Fragment Shader는 문자열이어야 합니다.");
    const next = compileFragment(source);
    let nextUniforms;
    try {
      nextUniforms = PassManager.makeLocations(gl, next);
    } catch (error) {
      gl.deleteProgram(next);
      throw error;
    }
    if (!vao) {
      vao = gl.createVertexArray();
      if (!vao) {
        gl.deleteProgram(next);
        throw new Error("VAO 생성 실패");
      }
    }
    try {
      updatePasses();
    } catch (error) {
      gl.deleteProgram(next);
      throw error;
    }
    const previous = program;
    program = next;
    uniforms = nextUniforms;
    fragmentSource = source;
    if (previous) gl.deleteProgram(previous);
    pruneRamps();
    // 셰이더가 바뀌면 누적 프레임을 리셋한다. 시간(time)은 이어서 진행한다.
    if (passManager.getPasses().length === 0) frameCount = 0;
    lastTime = fpsStart = null;
    fps = fpsFrames = 0;
    onStatus(mismatchMessage());
    scheduleFrame();
    return true;
  };
  const setFragment = source => replacePrograms(source);
  // 내장 Uniform을 지원하지 않는 타입으로 선언한 경우(예: uniform vec3 uTime) 값 전달을 생략하고 알린다.
  const mismatchMessage = () => {
    const items = (uniforms?.mismatches || []).map(m => `Image.${m.name}(${m.declared})`);
    for (const pass of passManager.getReflection())
      for (const m of pass.ignored) items.push(`${pass.name}.${m.name}(${m.declared})`);
    return items.length
      ? `내장 Uniform 타입 불일치로 값 전달 생략: ${items.join(", ")} · getShaderReflection()에서 허용 타입 확인`
      : "";
  };
  const reportMismatches = () => {
    const message = mismatchMessage();
    if (message) onStatus(message);
  };
  const validateFragment = source => {
    if (disposed || lost) throw new Error("셰이더를 검사할 수 없는 상태입니다.");
    const candidate = compileFragment(source);
    gl.deleteProgram(candidate);
    return true;
  };
  const captureScreenshot = () =>
    new Promise((resolve, reject) => {
      if (disposed || lost || document.hidden || !program) return reject(new Error("현재 화면을 캡처할 수 없습니다."));
      if (offline) return reject(new Error("영상 렌더링 중에는 캡처할 수 없습니다."));
      captureQueue.push({ resolve, reject });
      if (!running) {
        capturePaused = true;
        running = true;
      }
      nextFrameAt = 0;
      scheduleFrame();
    });
  // 화면보다 큰 PNG: Image 패스만 width×height 크기의 화면 밖 Texture에 지금 시간 그대로 한 번 더 그려 읽는다.
  // 시간·프레임 수는 바뀌지 않는다. 버퍼 패스가 있으면 버퍼가 화면 크기라(texelFetch 좌표가 어긋남) 지원하지 않는다.
  const MAX_CAPTURE_PIXELS = 7680 * 4320;
  const captureScreenshotAt = (width, height) =>
    new Promise((resolve, reject) => {
      if (disposed || lost || !program || !vao) throw new Error("지금은 캡처할 수 없습니다.");
      assertOnline();
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
        throw new RangeError("캡처 크기는 1 이상의 정수여야 합니다.");
      if (passManager.getReflection().length)
        throw new Error("버퍼 패스가 있는 프로젝트는 화면 크기로만 저장할 수 있습니다.");
      const limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
      if (width > limit || height > limit || width * height > MAX_CAPTURE_PIXELS)
        throw new RangeError(`이 GPU에서 저장할 수 있는 크기를 넘습니다 (최대 ${limit}px · 33MP).`);
      const texture = gl.createTexture(),
        fbo = gl.createFramebuffer();
      let pixels;
      try {
        Diagnostics.clearErrors(gl);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw new Error("캡처용 Framebuffer를 만들지 못했습니다(GPU 메모리 부족일 수 있음).");
        gl.viewport(0, 0, width, height);
        gl.bindVertexArray(vao);
        gl.useProgram(program);
        uploadGlobals(uniforms, width, height);
        passManager.bindImage(uniforms);
        try {
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        } finally {
          passManager.unbindImage();
        }
        pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error(`고해상도 캡처 GL 오류: ${error}`);
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
      }
      const output = document.createElement("canvas");
      output.width = width;
      output.height = height;
      const context = output.getContext("2d");
      if (!context) throw new Error("2D Canvas를 사용할 수 없습니다.");
      const image = context.createImageData(width, height),
        stride = width * 4;
      for (let y = 0; y < height; y++)
        image.data.set(pixels.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
      context.putImageData(image, 0, 0);
      output.toBlob(blob => (blob ? resolve(blob) : reject(new Error("PNG 생성 실패"))), "image/png");
    });
  // 프레임을 그린 직후마다 listener(canvas)를 부른다. 해제 함수를 돌려준다.
  const onFrame = listener => {
    frameListeners.add(listener);
    return () => frameListeners.delete(listener);
  };
  // 일시정지 중이어도 지금 화면을 한 번 그린다(스크린샷과 같은 방식). 재생 중이면 다음 프레임을 기다리면 된다.
  const redraw = () => {
    if (offline || disposed || lost || document.hidden || !program) return false;
    if (!running) {
      capturePaused = true;
      running = true;
    }
    scheduleFrame();
    return true;
  };
  // ---- 오프라인(영상) 렌더링 ----
  // beginOffline({ width, height }): 실시간 루프를 멈추고 드로잉 버퍼를 그 크기로 고정한다. 버퍼 패스는 새 타깃에서 처음부터 계산한다(화면의 버퍼는 보관).
  // renderOfflineFrame({ time, delta, frame }): 그 시간·프레임 번호로 한 프레임을 그리고 캔버스를 돌려준다.
  //   preserveDrawingBuffer가 false라 그림은 이 호출과 같은 작업(task) 안에서만 읽을 수 있다 — 바로 복사할 것.
  // endOffline(): 크기·시간·프레임 수·버퍼 내용을 렌더링 전으로 되돌리고, 렌더링 전(또는 그동안 누른) 재생 상태로 돌아간다.
  const offlineLimit = () => Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
  // tilePixels(선택): 타일 하나의 픽셀 수를 고정한다(검사·진단용). 없으면 잰 GPU 시간으로 정한다.
  const beginOffline = ({ width, height, tilePixels = 0 }) => {
    if (disposed || lost || !program || !vao) throw new Error("지금은 영상을 렌더링할 수 없습니다.");
    if (offline) throw new Error("이미 영상을 렌더링하고 있습니다.");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2)
      throw new RangeError("영상 크기는 2 이상의 정수여야 합니다.");
    const limit = offlineLimit();
    if (width > limit || height > limit)
      throw new RangeError(`이 GPU에서 렌더링할 수 있는 크기를 넘습니다 (최대 ${limit}px).`);
    const resume = running && !capturePaused;
    stop();
    offline = {
      width,
      height,
      resume,
      tilePixels: Math.max(0, Math.floor(tilePixels) || 0),
      saved: { time, frameCount, lastDelta },
    };
    tileCost.clear();
    tileStats = { tiles: 0, frames: 0 };
    resize();
    passManager.stashTargets();
    frameCount = 0;
    return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
  };
  const renderOfflineFrame = ({ time: at, delta, frame: index }) => {
    if (!offline) throw offlineLost ? lostError() : new Error("beginOffline()을 먼저 호출하세요.");
    if (lost || disposed) throw new Error("WebGL 컨텍스트를 잃어 영상 렌더링을 멈췄습니다.");
    if (![at, delta].every(Number.isFinite) || !Number.isInteger(index) || index < 0)
      throw new RangeError("프레임 시간·번호가 올바르지 않습니다.");
    resize();
    const w = gl.drawingBufferWidth,
      h = gl.drawingBufferHeight;
    passManager.ensureTargets(w, h);
    time = at;
    lastDelta = delta;
    frameCount = index;
    keyboard.upload();
    gl.bindVertexArray(vao);
    passManager.drawPasses(w, h, uploadGlobals);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(program);
    uploadGlobals(uniforms, w, h);
    passManager.bindImage(uniforms);
    try {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } finally {
      passManager.unbindImage();
    }
    clickPending = false;
    keyboard.endFrame();
    frameCount = index + 1;
    return canvas;
  };
  // ---- 타일 렌더링(영상 렌더링용) ----
  // 무거운 셰이더를 큰 크기로 한 번에 그리면 한 번의 GPU 작업이 몇 초씩 걸려, 브라우저·OS가 GPU를 초기화한다
  // (WebGL 컨텍스트 손실 · Windows TDR 등). 그래서 패스마다 화면을 타일로 나눠 그리고, 타일마다 GPU가 끝날 때까지 기다린다.
  // 타일 크기는 잰 시간으로 정한다: 픽셀당 GPU 시간을 패스별로 기억하고, 타일 하나가 TILE_TARGET_MS 안에 끝나게 한다.
  // 가벼운 셰이더는 곧 한 장(타일 1개)으로 그리므로 느려지지 않는다. Image는 화면 밖 Texture에 타일로 그린 뒤
  // 마지막에 캔버스로 한 번에 옮긴다(타일 사이에 화면이 합성되어 캔버스가 비워져도 결과가 남게).
  const TILE_TARGET_MS = 100, // GPU 응답 제한(Windows TDR 약 2초)보다 훨씬 짧게
    FIRST_TILE = 128 * 128, // 처음 재는 타일(어떤 셰이더도 이 정도는 금방 끝난다)
    MIN_TILE = 64 * 64,
    REMEASURE = 15;
  const tileCost = new Map(); // 패스 이름 → 픽셀당 ms (늘어나면 바로, 줄어들면 천천히 따라간다)
  let offlineTarget = null,
    tileStats = { tiles: 0, frames: 0 };
  const tilesFor = (key, w, h) => {
    const cost = tileCost.get(key),
      budget = offline?.tilePixels || (cost ? Math.max(MIN_TILE, TILE_TARGET_MS / cost) : FIRST_TILE);
    if (budget >= w * h) return [[0, 0, w, h]];
    // 한 줄 전체를 담을 수 있으면 가로 띠, 아니면 정사각에 가까운 타일
    const tw = budget >= w * 16 ? w : Math.max(Math.min(64, w), Math.min(w, Math.floor(Math.sqrt(budget)))),
      th = Math.max(1, Math.min(h, Math.floor(budget / tw)));
    const rects = [];
    for (let y = 0; y < h; y += th)
      for (let x = 0; x < w; x += tw) rects.push([x, y, Math.min(tw, w - x), Math.min(th, h - y)]);
    return rects;
  };
  // 잰 시간에는 타이머 지연 같은 고정 비용이 섞여 작은 타일일수록 픽셀당 비용이 부풀려진다(안전한 쪽으로 틀림).
  // 목표의 1/4 안에 끝난 타일이면 다음에는 최소 4배 큰 타일을 허락해 빨리 제 크기를 찾게 한다.
  const learn = (key, pixels, ms) => {
    const n = Math.max(1, pixels);
    let cost = ms / n;
    if (ms < TILE_TARGET_MS / 4) cost = Math.min(cost, TILE_TARGET_MS / (4 * n));
    const prev = tileCost.get(key);
    tileCost.set(key, prev === undefined || cost > prev ? cost : Math.min(prev, prev * 0.5 + cost * 0.5));
  };
  const contextLost = () => lost || !!gl.isContextLost?.();
  const lostError = () =>
    Object.assign(
      new Error(
        "WebGL 컨텍스트를 잃었습니다. GPU가 한 번에 맡은 일이 너무 오래 걸렸거나 GPU 메모리가 부족했을 수 있습니다. 크기를 줄여 다시 시도하세요."
      ),
      { name: "ContextLostError" }
    );
  // 지금까지 보낸 GL 명령을 GPU가 끝낼 때까지 기다린다(메인 스레드는 막지 않는다). 컨텍스트를 잃으면 false.
  const waitGPU = () =>
    new Promise(resolve => {
      if (contextLost()) return resolve(false);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      if (!sync) return resolve(!contextLost());
      const poll = () => {
        const status = contextLost() ? gl.WAIT_FAILED : gl.clientWaitSync(sync, 0, 0);
        if (status === gl.TIMEOUT_EXPIRED) return void setTimeout(poll, 1);
        if (!contextLost()) gl.deleteSync(sync);
        resolve(status !== gl.WAIT_FAILED);
      };
      poll();
    });
  let copyProgram = null;
  const copyToCanvas = (texture, w, h) => {
    if (!copyProgram) {
      const vs = createShader(
          gl.VERTEX_SHADER,
          "#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}"
        ),
        fs = createShader(
          gl.FRAGMENT_SHADER,
          "#version 300 es\nprecision highp float;uniform sampler2D uCopy;out vec4 o;void main(){o=texelFetch(uCopy,ivec2(gl_FragCoord.xy),0);}"
        );
      copyProgram = gl.createProgram();
      gl.attachShader(copyProgram, vs);
      gl.attachShader(copyProgram, fs);
      gl.linkProgram(copyProgram);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(copyProgram, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(copyProgram);
        gl.deleteProgram(copyProgram);
        copyProgram = null;
        throw new Error(`복사 셰이더 링크 실패: ${log}`);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(copyProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(copyProgram, "uCopy"), 0);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };
  const deleteOfflineTarget = () => {
    if (offlineTarget && !contextLost()) {
      gl.deleteFramebuffer(offlineTarget.fbo);
      gl.deleteTexture(offlineTarget.texture);
    }
    offlineTarget = null;
  };
  const ensureOfflineTarget = (w, h) => {
    if (offlineTarget && offlineTarget.width === w && offlineTarget.height === h) return offlineTarget;
    deleteOfflineTarget();
    const texture = gl.createTexture(),
      fbo = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // 기본 축소 필터는 밉맵이 있어야 해서(없으면 "불완전"이라 읽으면 0) NEAREST로 둔다.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    offlineTarget = { texture, fbo, width: w, height: h };
    if (!complete) {
      deleteOfflineTarget();
      throw new Error("영상 렌더링용 Framebuffer를 만들지 못했습니다(GPU 메모리 부족일 수 있음).");
    }
    return offlineTarget;
  };
  // renderOfflineFrame과 같은 프레임을 타일로 나눠 그린다. 다 그리면 캔버스로 옮기고, 같은 작업 안에서 capture(canvas)를 부른다
  // (preserveDrawingBuffer가 false라 캔버스는 그 자리에서만 읽을 수 있다). 컨텍스트를 잃으면 ContextLostError.
  const renderOfflineFrameTiled = async ({ time: at, delta, frame: index }, capture = () => {}) => {
    if (!offline) throw offlineLost ? lostError() : new Error("beginOffline()을 먼저 호출하세요.");
    if (contextLost() || disposed) throw lostError();
    if (![at, delta].every(Number.isFinite) || !Number.isInteger(index) || index < 0)
      throw new RangeError("프레임 시간·번호가 올바르지 않습니다.");
    const session = offline;
    resize();
    const w = gl.drawingBufferWidth,
      h = gl.drawingBufferHeight;
    passManager.ensureTargets(w, h);
    const target = ensureOfflineTarget(w, h);
    time = at;
    lastDelta = delta;
    frameCount = index;
    keyboard.upload();
    gl.bindVertexArray(vao);
    const measure = tileStats.frames < 3 || tileStats.frames % REMEASURE === 0 || !!offline.tilePixels;
    // 잴 프레임은 앞에서 기다리지 않고 쌓아 둔 GPU 작업을 먼저 비운다(그 시간이 첫 타일의 비용으로 잡히지 않게).
    if (measure && !(await waitGPU())) throw lostError();
    if (offline !== session) throw lostError();
    // 타일마다: 그리기 → GPU가 끝날 때까지 기다림 → 걸린 시간으로 그 패스의 타일 크기를 고침
    let started = clock();
    // 한 장 전체가 TILE_TARGET_MS 안에 끝난다고 이미 잰 패스는 매 프레임 기다리지 않는다. 그러면 GPU가 그리는 동안
    // 앞 프레임을 인코딩하는 식으로 겹쳐 돌아 가벼운 셰이더가 느려지지 않는다. 셰이더가 시간에 따라 무거워질 수 있으니
    // REMEASURE 프레임마다 다시 잰다.
    const afterTile = async (key, [, , tw, th], whole) => {
      const cost = tileCost.get(key);
      if (!measure && whole && cost !== undefined && cost * tw * th < TILE_TARGET_MS) {
        tileStats.tiles++;
        return;
      }
      const ok = await waitGPU();
      if (!ok || contextLost() || offline !== session) throw lostError();
      learn(key, tw * th, clock() - started);
      tileStats.tiles++;
      gl.bindVertexArray(vao);
      started = clock();
    };
    await passManager.drawPassesTiled(
      uploadGlobals,
      pass => tilesFor(pass.name, pass.width, pass.height),
      (pass, rect) => afterTile(pass.name, rect, rect[2] * rect[3] === pass.width * pass.height)
    );
    for (const rect of tilesFor("Image", w, h)) {
      const [x, y, tw, th] = rect;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(program);
      uploadGlobals(uniforms, w, h);
      passManager.bindImage(uniforms);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x, y, tw, th);
      try {
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } finally {
        gl.disable(gl.SCISSOR_TEST);
        passManager.unbindImage();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      await afterTile("Image", rect, tw * th === w * h);
    }
    // 화면 밖 Texture → 캔버스(한 번의 짧은 복사) → 같은 작업 안에서 바로 읽기.
    // blitFramebuffer로 옮기면 브라우저가 캔버스를 "새로 그림"으로 치지 않을 때가 있어(drawImage가 이전 화면을 읽음)
    // 그리기 호출(drawArrays)로 옮긴다.
    copyToCanvas(target.texture, w, h);
    clickPending = false;
    keyboard.endFrame();
    frameCount = index + 1;
    tileStats.frames++;
    capture(canvas);
    return canvas;
  };
  // 지금까지 그린 타일 수와 패스별 픽셀당 GPU 시간(진행 표시·테스트용)
  const getOfflineTiling = () => ({ ...tileStats, costs: Object.fromEntries(tileCost) });
  const endOffline = () => {
    // 렌더링 중에 컨텍스트를 잃었으면(onContextLost가 이미 오프라인을 끝냈다) 시간·재생 상태만 되돌린다.
    if (!offline && offlineLost) {
      const { saved, resume } = offlineLost;
      offlineLost = null;
      time = saved.time;
      lastDelta = saved.lastDelta;
      lastTime = null;
      frameCount = 0;
      if (resume && !disposed) start();
      return true;
    }
    if (!offline) return false;
    deleteOfflineTarget();
    const { saved, resume } = offline;
    offline = null;
    time = saved.time;
    lastDelta = saved.lastDelta;
    lastTime = null;
    nextFrameAt = 0;
    // 렌더링 전의 버퍼(시뮬레이션 상태)·프레임 수를 그대로 되돌린다. 컨텍스트를 잃었으면 보관본은 버린다(복구 때 새로 만든다).
    if (!disposed && !lost) resize(); // 다음 프레임을 기다리지 않고 캔버스를 화면 크기로 되돌린다
    passManager.restoreTargets({ discard: disposed || lost });
    frameCount = saved.frameCount;
    if (disposed) return true;
    if (resume) start();
    else present();
    return true;
  };
  // 멈춘 화면을 다시 보이기: 버퍼 패스는 돌리지 않고(시뮬레이션이 한 단계 나아가지 않게) Image(또는 버퍼 미리보기)만 지금 상태로 그린다.
  const present = () => {
    if (disposed || lost || document.hidden || !program || !vao) return false;
    resize();
    const w = gl.drawingBufferWidth,
      h = gl.drawingBufferHeight;
    gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    if (!passManager.drawPreview(w, h)) {
      gl.useProgram(program);
      uploadGlobals(uniforms, w, h);
      passManager.bindImage(uniforms);
      try {
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } finally {
        passManager.unbindImage();
      }
    }
    return true;
  };
  const isOffline = () => !!offline;
  // 일시정지 중에 한 프레임만 진행한다(시간·프레임 수·피드백 버퍼가 함께 나아간다). 재생 중이면 아무것도 하지 않는다.
  // 진행 시간은 배속과 관계없이 seconds(기본 1/60초)다.
  const stepFrame = (seconds = 1 / 60) => {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 1)
      throw new RangeError("stepFrame 시간은 0초 초과 1초 이하여야 합니다.");
    if (running || disposed || lost || document.hidden || !program) return false;
    stepDelta = seconds;
    return redraw();
  };
  const setTimeScale = value => {
    if (!Number.isFinite(value) || value < 0.05 || value > 8)
      throw new RangeError("재생 배속은 0.05부터 8 사이여야 합니다.");
    timeScale = value;
    return timeScale;
  };
  const resetSimulation = () => {
    if (disposed || lost) throw new Error("시뮬레이션을 초기화할 수 없습니다.");
    assertOnline();
    passManager.resetTargets();
    frameCount = 0;
    time = lastDelta = wheel = 0;
    lastTime = null;
    nextFrameAt = 0;
    scheduleFrame();
  };
  // 시작은 비동기 프레임 예약이다. 여러 번 호출해도 중복 렌더링 루프를 만들지 않는다.
  const start = () => {
    if (disposed) throw new Error("이미 폐기된 Renderer입니다.");
    // 영상 렌더링 중에 누른 재생은 끝난 뒤에 이어 간다.
    if (offline) {
      offline.resume = true;
      return;
    }
    if (lost && !gl.isContextLost?.()) onContextRestored();
    capturePaused = false;
    running = true;
    scheduleFrame();
  };
  // stop()은 컨텍스트를 폐기하지 않는다. start()를 다시 호출할 수 있다.
  const stop = () => {
    if (offline) offline.resume = false;
    running = false;
    cancelFrame();
    captureQueue.splice(0).forEach(({ reject }) => reject(new Error("렌더링 중단으로 캡처가 취소되었습니다.")));
    capturePaused = false;
  };
  // 영상 렌더링 중에는 마우스·휠 값을 고정한다(같은 설정이면 같은 영상이 나오게).
  const onPointerMove = event => {
    if (offline) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    mouse[0] = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    mouse[1] = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height));
  };
  const onPointerDown = event => {
    if (offline || event.button !== 0) return;
    onPointerMove(event);
    if (mouse[0] < 0) return;
    click[0] = mouse[0];
    click[1] = mouse[1];
    mouseDown = clickPending = true;
  };
  const onPointerUp = () => {
    if (offline) return;
    mouseDown = false;
  };
  // 셰이더가 uWheel을 쓸 때만 휠을 가로챈다(아니면 페이지 스크롤 등 기본 동작을 그대로 둔다). Ctrl+휠은 브라우저 확대.
  const usesWheel = () => !!program && (uniforms?.wheel != null || passManager.usesBuiltin("wheel"));
  const onWheel = event => {
    if (offline || event.ctrlKey || !usesWheel()) return;
    event.preventDefault();
    // 한 칸(마우스 휠 한 번)을 1로 맞춘다: 픽셀 단위는 100px, 줄 단위는 3줄을 한 칸으로 본다.
    const unit = event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 1 : 100;
    wheel -= event.deltaY / unit; // uMouse처럼 일시정지 중에는 다시 그리지 않는다(재생하거나 한 프레임 진행하면 반영)
  };
  const onPointerLeave = () => {
    // 드래그 중(포인터 캡처)에는 캔버스 밖으로 나가도 위치를 유지한다.
    if (offline || mouseDown) return;
    mouse[0] = mouse[1] = -1;
  };
  const onVisibilityChange = () => {
    if (document.hidden) {
      cancelFrame();
      if (capturePaused) running = false;
      captureQueue.splice(0).forEach(({ reject }) => reject(new Error("탭이 숨겨져 캡처를 취소했습니다.")));
      capturePaused = false;
    } else scheduleFrame();
  };
  // 브라우저/GPU가 자원을 잃은 상황. preventDefault()로 복구 허용을 요청한다.
  // 이전 GPU 핸들은 더 이상 유효하지 않으므로 참조만 버리고 복구 이벤트를 기다린다.
  const onContextLost = event => {
    event.preventDefault();
    if (disposed) return;
    if (capturePaused) running = false;
    lost = true;
    // 영상 렌더링 중이었으면 오프라인 모드를 바로 끝낸다(크기 고정·구성 변경 금지를 풀어야 복구가 셰이더를 다시 만들 수 있다).
    // 보관한 버퍼는 이미 무효라 버리고, 시간·재생 상태는 렌더링 쪽이 endOffline()을 부를 때 되돌린다.
    if (offline) {
      offlineLost = offline;
      offline = null;
      offlineTarget = null;
      passManager.restoreTargets({ discard: true });
    }
    copyProgram = null; // 잃은 컨텍스트의 객체라 다시 만든다
    cancelFrame();
    captureQueue.splice(0).forEach(({ reject }) => reject(new Error("WebGL 컨텍스트가 손실되었습니다.")));
    capturePaused = false;
    program = vao = uniforms = null;
    passManager.onLost();
    textureInput.onLost();
    gpuTimer.onLost();
    rampTextures.clear(); // 잃은 컨텍스트의 텍스처: 참조만 버리고, 다음 그리기에서 다시 굽는다
    capabilities = null;
    onStatus("WebGL 컨텍스트 손실: 복구 대기 중");
  };
  // 복구된 같은 WebGL 컨텍스트에 Program과 VAO를 새로 만들고 Uniform도 재조회한다.
  // 확장 객체(타이머 등)는 컨텍스트 손실 후 무효이므로 다시 요청한다.
  const onContextRestored = () => {
    if (disposed) return;
    lost = false;
    try {
      gpuTimer.restore();
      textureInput.restore();
      keyboard.restore();
      setFragment(fragmentSource);
      passManager.restore();
      reportMismatches();
    } catch (error) {
      if (program) gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
      program = vao = uniforms = null;
      passManager.onLost(true);
      textureInput.onLost(true);
      lost = true;
      cancelFrame();
      console.error(error);
      onStatus(`WebGL 복구 실패: ${error.message} · Play로 재시도할 수 있습니다.`);
    }
  };
  const dispose = () => {
    if (disposed) return;
    stop();
    disposed = true;
    captureQueue.splice(0).forEach(({ reject }) => reject(new Error("Renderer가 종료되었습니다.")));
    frameListeners.clear();
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    gpuTimer.dispose();
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (!lost) {
      passManager.dispose();
      textureInput.dispose();
      keyboard.dispose();
      if (program) gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
      for (const entry of rampTextures.values()) gl.deleteTexture(entry.texture);
    }
    rampTextures.clear();
    if (lost) textureInput.dispose();
    program = vao = uniforms = null;
  };
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  document.addEventListener("visibilitychange", onVisibilityChange);
  try {
    setFragment(fragmentSource);
    passManager.setPasses(sources.passes || [], sources.imageChannels || {});
  } catch (error) {
    dispose();
    throw error;
  }
  const setResolutionScale = value => {
    if (disposed) throw new Error("이미 폐기된 Renderer입니다.");
    if (!Number.isFinite(value) || value < 0.25 || value > 1)
      throw new RangeError("resolutionScale은 0.25부터 1 사이여야 합니다.");
    resolutionScale = value;
    return resolutionScale;
  };
  const setFpsLimit = value => {
    if (disposed) throw new Error("이미 폐기된 Renderer입니다.");
    if (!Number.isInteger(value) || value < 0 || value > 240)
      throw new RangeError("FPS 제한은 0~240 정수(0=무제한)여야 합니다.");
    fpsLimit = value;
    nextFrameAt = 0;
    return fpsLimit;
  };
  const setMaxPixels = value => {
    if (disposed) throw new Error("이미 폐기된 Renderer입니다.");
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("최대 픽셀 수는 0 이상의 정수여야 합니다.");
    maxPixels = value;
    return maxPixels;
  };
  const reservedUniforms = new Set([
    "uResolution",
    "uTime",
    "uDeltaTime",
    "uFrame",
    "uMouse",
    "uWheel",
    "iChannel0",
    "iChannel1",
    "iChannel2",
    "iChannel3",
    "iChannelResolution",
  ]);
  const normalizeEntry = (name, type, value, options = {}) => {
    if (
      typeof name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      name.startsWith("gl_") ||
      name.includes("__") ||
      reservedUniforms.has(name)
    )
      throw new Error("Uniform 이름이 올바르지 않거나 렌더러 전용 이름입니다.");
    if (!options || typeof options !== "object" || Array.isArray(options))
      throw new Error("Uniform 슬라이더 설정이 올바르지 않습니다.");
    // 범위(min/max/step)는 float·int·uint 스칼라와 벡터(성분마다 같은 범위)에, color는 vec3/vec4에만 허용한다.
    const normalized = normalizeUniform(type, value),
      { min, max, step, color, dir, angle, pos, log, hdr, seed, anim } = options,
      labels = options.enum,
      spec = UNIFORM_TYPES[type];
    // sampler2D는 램프 전용: gradient(linear|smooth|step) 또는 curve(smooth|linear, 편집기 y 범위 min·max)만 받는다.
    if (spec.kind === "t") {
      const { gradient, curve } = options,
        extra = Object.keys(options).filter(key => !["gradient", "curve", "min", "max", "step"].includes(key));
      if (
        (gradient === undefined) === (curve === undefined) ||
        extra.length ||
        (gradient !== undefined && (!["linear", "smooth", "step"].includes(gradient) || min !== undefined)) ||
        (curve !== undefined && !["smooth", "linear"].includes(curve))
      )
        throw new Error(
          "sampler2D 파라미터는 gradient(linear·smooth·step) 또는 curve(smooth·linear) 하나로만 쓸 수 있습니다."
        );
      if (
        curve !== undefined &&
        min !== undefined &&
        !([min, max, step].every(Number.isFinite) && min < max && step > 0)
      )
        throw new Error("곡선 범위(min·max·step)가 올바르지 않습니다.");
      const nextOptions = gradient ? { gradient } : min === undefined ? { curve } : { min, max, step, curve };
      return writeData({
        type,
        value: normalizeRamp(normalized, nextOptions),
        data: makeData(type, nextOptions),
        options: nextOptions,
      });
    }
    const ranged = spec.kind === "f" || spec.kind === "i" || spec.kind === "u",
      integer = spec.kind === "i" || spec.kind === "u";
    if (
      [min, max, step].some(x => x !== undefined) &&
      (!ranged ||
        ![min, max, step].every(Number.isFinite) ||
        !(min < max && step > 0) ||
        (integer && ![min, max, step].every(Number.isInteger)) ||
        (spec.kind === "u" && min < 0))
    )
      throw new Error("Uniform 슬라이더 범위가 올바르지 않습니다.");
    if (color !== undefined && (color !== true || !["vec3", "vec4"].includes(type)))
      throw new Error("color 표시는 vec3/vec4에만 사용할 수 있습니다.");
    // dir("full"|"hemi")는 vec2/vec3 단위 방향에만. 값은 늘 길이 1로 저장한다.
    let direction = normalized;
    if (dir !== undefined) {
      if (!["full", "hemi"].includes(dir) || !["vec2", "vec3"].includes(type))
        throw new Error("방향(dir) 표시는 vec2/vec3에만 사용할 수 있습니다.");
      if (color || min !== undefined) throw new Error("방향(dir) 표시는 색상·슬라이더 범위와 함께 쓸 수 없습니다.");
      direction = unitDirection(normalized, dir);
    }
    // 표시 방식: angle(float 라디안 다이얼) · pos(vec2 2D 패드) · log(양수 범위 float 로그 슬라이더) · enum(int/uint 선택지 이름).
    // color·dir와 함께 표시 방식은 하나만 고를 수 있다.
    const widgets = [color, dir, angle, pos, log, labels].filter(x => x !== undefined).length;
    if (widgets > 1) throw new Error("표시 방식(color·dir·angle·pos·log·enum)은 하나만 고를 수 있습니다.");
    if (angle !== undefined && (angle !== true || type !== "float" || min !== undefined))
      throw new Error("각도(angle) 표시는 범위 없는 float에만 사용할 수 있습니다.");
    if (pos !== undefined && (pos !== true || type !== "vec2" || min === undefined))
      throw new Error("2D 패드(pos) 표시는 범위가 있는 vec2에만 사용할 수 있습니다.");
    if (log !== undefined && (log !== true || type !== "float" || !(min > 0)))
      throw new Error("로그 슬라이더(log)는 0보다 큰 범위의 float에만 사용할 수 있습니다.");
    if (
      labels !== undefined &&
      (!Array.isArray(labels) ||
        labels.length < 2 ||
        labels.length > 32 ||
        !labels.every(label => typeof label === "string" && label.length > 0 && label.length <= 40) ||
        !["int", "uint"].includes(type) ||
        min !== 0 ||
        max !== labels.length - 1 ||
        step !== 1)
    )
      throw new Error("선택지(enum)는 int/uint에 이름 2~32개, 범위 0~(개수-1)로만 사용할 수 있습니다.");
    // 덧붙이는 옵션: hdr(color의 최대 밝기) · seed(무작위 버튼) · anim(재생 주기, 초).
    if (hdr !== undefined && (!color || typeof hdr !== "number" || !(hdr > 0 && hdr <= 1000)))
      throw new Error("HDR 색(hdr)은 color와 함께, 최대 밝기 0~1000으로만 사용할 수 있습니다.");
    if (seed !== undefined && (seed !== true || !["float", "int", "uint"].includes(type) || labels || angle))
      throw new Error("무작위 버튼(seed)은 float/int/uint에만, enum·angle 없이 사용할 수 있습니다.");
    if (
      anim !== undefined &&
      (typeof anim !== "number" ||
        !(anim >= 0.1 && anim <= 600) ||
        !["float", "int", "uint"].includes(type) ||
        !(angle || (min !== undefined && !log)))
    )
      throw new Error(
        "재생(anim)은 범위가 있는 float/int/uint(enum 포함)나 angle에만, 주기 0.1~600초로 사용할 수 있습니다."
      );
    const nextOptions = min === undefined ? {} : { min, max, step };
    if (color) nextOptions.color = true;
    if (hdr) nextOptions.hdr = hdr;
    if (seed) nextOptions.seed = true;
    if (anim) nextOptions.anim = anim;
    if (dir) nextOptions.dir = dir;
    if (angle) nextOptions.angle = true;
    if (pos) nextOptions.pos = true;
    if (log) nextOptions.log = true;
    if (labels) nextOptions.enum = [...labels];
    return writeData({ type, value: direction, data: makeData(type), options: nextOptions });
  };
  const defineUniform = (name, type, value, options = {}) => {
    if (disposed || lost) throw new Error("현재 Uniform을 등록할 수 없습니다.");
    if (userUniforms.has(name)) throw new Error(`${name}은 이미 등록됐습니다.`);
    if (userUniforms.size >= 64) throw new Error("사용자 Uniform은 최대 64개입니다.");
    const entry = normalizeEntry(name, type, value, options);
    if (entry.type === "sampler2D") checkRampCount([...userUniforms.values(), entry]);
    userUniforms.set(name, entry);
    try {
      replacePrograms(fragmentSource, passManager.refreshPrograms);
    } catch (error) {
      userUniforms.delete(name);
      throw error;
    }
    return true;
  };
  const setUniform = (name, value) => {
    if (disposed) throw new Error("이미 폐기된 Renderer입니다.");
    const item = userUniforms.get(name);
    if (!item) throw new Error(`등록되지 않은 Uniform: ${name}`);
    const normalized = normalizeUniform(item.type, value);
    item.value = item.options?.dir
      ? unitDirection(normalized, item.options.dir)
      : item.type === "sampler2D"
        ? normalizeRamp(normalized, item.options)
        : normalized;
    writeData(item);
    return true;
  };
  const removeUniform = name => {
    if (disposed || lost) throw new Error("현재 Uniform을 제거할 수 없습니다.");
    const item = userUniforms.get(name);
    if (!item) return false;
    userUniforms.delete(name);
    try {
      replacePrograms(fragmentSource, passManager.refreshPrograms);
    } catch (error) {
      userUniforms.set(name, item);
      throw error;
    }
    return true;
  };
  const getUserUniforms = () =>
    [...userUniforms].map(([name, item]) => ({
      name,
      type: item.type,
      value: Array.isArray(item.value) ? [...item.value] : item.value,
      options: item.options.enum ? { ...item.options, enum: [...item.options.enum] } : { ...item.options },
    }));
  const getUniforms = getUserUniforms;
  // Pack 복원: 사용자 Uniform을 새 GLSL과 함께 사전 컴파일하고, 통과한 경우에만 교체한다.
  const checkRampCount = items => {
    if (items.filter(item => item.type === "sampler2D").length > RAMP_MAX_COUNT)
      throw new Error(`그라데이션·곡선 파라미터는 최대 ${RAMP_MAX_COUNT}개입니다.`);
  };
  const prepareUsers = items => {
    if (!Array.isArray(items) || items.length > 64) throw new Error("사용자 Uniform은 최대 64개입니다.");
    const next = new Map();
    for (const item of items) {
      if (!item || next.has(item.name)) throw new Error("Pack 사용자 Uniform 이름이 올바르지 않습니다.");
      next.set(
        item.name,
        normalizeEntry(item.name, item.type, item.value, item.options === undefined ? {} : item.options)
      );
    }
    checkRampCount([...next.values()]);
    return next;
  };
  const swapUsers = next => {
    userUniforms.clear();
    for (const [name, item] of next) userUniforms.set(name, item);
  };
  const setUserUniforms = items => {
    if (disposed || lost) throw new Error("현재 Uniform을 교체할 수 없습니다.");
    const next = prepareUsers(items),
      old = new Map(userUniforms);
    try {
      swapUsers(next);
      replacePrograms(fragmentSource, passManager.refreshPrograms);
      return true;
    } catch (error) {
      swapUsers(old);
      throw error;
    }
  };
  const validatePortable = (scene, items) => {
    if (disposed || lost) throw new Error("Pack을 적용할 수 없는 Renderer 상태입니다.");
    const next = prepareUsers(items),
      old = new Map(userUniforms);
    passManager.validateConfiguration(scene.passes, scene.imageChannels);
    try {
      swapUsers(next);
      for (const source of [scene.image, ...scene.passes.map(p => p.fragment)]) {
        const candidate = compileFragment(source);
        gl.deleteProgram(candidate);
      }
    } finally {
      swapUsers(old);
    }
    return true;
  };
  const applyPortable = (scene, items) => {
    if (disposed || lost) throw new Error("Pack을 적용할 수 없는 Renderer 상태입니다.");
    const next = prepareUsers(items),
      old = new Map(userUniforms);
    try {
      swapUsers(next);
      replacePrograms(scene.image, () => passManager.setPasses(scene.passes, scene.imageChannels));
      frameCount = 0;
      return true;
    } catch (error) {
      swapUsers(old);
      throw error;
    }
  };
  const applyProject = scene => {
    if (disposed || lost) throw new Error("현재 프로젝트를 적용할 수 없습니다.");
    assertOnline();
    const imageChanged = scene.image !== fragmentSource;
    let result;
    const update = () => {
      result = passManager.updatePasses(scene.passes, scene.imageChannels);
    };
    try {
      if (imageChanged) replacePrograms(scene.image, update);
      else update();
    } catch (error) {
      if (imageChanged) error.passName ??= "Image";
      throw error;
    }
    if (result.structural) frameCount = 0;
    if (!imageChanged) reportMismatches();
    return imageChanged || result.changed;
  };
  const validatePassConfiguration = (passes, imageChannels = {}) =>
    passManager.validateConfiguration(passes, imageChannels);
  const setPasses = (passes, imageChannels = {}) => {
    if (disposed || lost) throw new Error("현재 Buffer를 구성할 수 없습니다.");
    assertOnline();
    passManager.setPasses(passes, imageChannels);
    frameCount = 0;
    reportMismatches();
  };
  const setPassFragment = (name, source) => {
    if (disposed || lost) throw new Error("현재 Buffer 소스를 변경할 수 없습니다.");
    assertOnline();
    passManager.setPassFragment(name, source);
    reportMismatches();
  };
  const setPassChannels = (name, channels) => {
    if (disposed || lost) throw new Error("현재 Buffer 채널을 변경할 수 없습니다.");
    passManager.setPassChannels(name, channels);
  };
  const setImageChannels = channels => {
    if (disposed || lost) throw new Error("현재 Image 채널을 변경할 수 없습니다.");
    passManager.setImageChannels(channels);
  };
  const setPreviewPass = (name, attachment = 0) => {
    if (disposed || lost) throw new Error("현재 미리보기를 변경할 수 없습니다.");
    passManager.setPreview(name, attachment);
    scheduleFrame();
  };
  const setPreviewOptions = options => {
    if (disposed) throw new Error("이미 폐기된 Renderer입니다.");
    const result = passManager.setPreviewOptions(options);
    scheduleFrame();
    return result;
  };
  // 키보드 입력: keyCode는 JavaScript 키 코드(1~255). 바뀌었으면 true.
  const setKey = (keyCode, down) => !disposed && !offline && keyboard.setKey(keyCode, !!down);
  const releaseKeys = () => keyboard.releaseAll();
  const usesKeyboard = () => !disposed && passManager.usesKeyboard();
  const readKey = (keyCode, row = 0) => keyboard.read(keyCode, row);
  const readPassPixel = (name, x, y, attachment = 0) => {
    if (disposed || lost) throw new Error("현재 픽셀을 읽을 수 없습니다.");
    return passManager.readPixel(name, x, y, attachment);
  };
  // 버퍼 디버그 썸네일. 각 패스 출력의 최신 결과를 축소해 ImageData로 돌려준다(위쪽이 화면 위).
  // GPU→CPU 동기 읽기이므로 UI는 보이는 동안 초당 몇 번만 호출한다.
  const captureBufferThumbnails = (maxWidth = 160) => {
    if (disposed || lost || !vao) return [];
    gl.bindVertexArray(vao);
    const shots = passManager.captureThumbnails(maxWidth);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    return shots.map(({ pixels, width, height, ...meta }) => {
      const flipped = new Uint8ClampedArray(pixels.length),
        stride = width * 4;
      for (let y = 0; y < height; y++)
        flipped.set(pixels.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
      return { ...meta, width, height, image: new ImageData(flipped, width, height) };
    });
  };
  const addTexture = (file, sampling) => {
    if (disposed || lost) throw new Error("Texture를 추가할 수 없습니다.");
    return textureInput.add(file, undefined, sampling);
  };
  const removeTexture = async id => {
    if (disposed) throw new Error("Texture를 삭제할 수 없습니다.");
    passManager.detachTexture(id);
    return textureInput.remove(id);
  };
  // options.priority: 먼저 되살릴 이미지 id(지금 프로젝트가 쓰는 것). 나머지는 뒤에서 이어지고 texturesRestored()로 기다린다.
  const restoreTextures = options => textureInput.restoreSaved(options);
  const getTextures = () => textureInput.list();
  const setTextureSampling = (id, options) => {
    if (disposed || lost) throw new Error("현재 Texture 설정을 바꿀 수 없습니다.");
    return textureInput.setSampling(id, options);
  };
  const getStats = () => ({
    fps: Math.round(fps * 10) / 10,
    frame: frameCount,
    wheel,
    time,
    timeScale,
    width: gl.drawingBufferWidth,
    height: gl.drawingBufferHeight,
    resolutionScale,
    fpsLimit,
    maxPixels,
    running: running && !lost && !document.hidden,
    offline: !!offline,
    previewPass: passManager.getPreview(),
    previewAttachment: passManager.getPreviewAttachment(),
    previewOptions: passManager.getPreviewOptions(),
    bufferMemoryBytes: passManager.getMemoryBytes(),
    cpuMs: Math.round(cpuMs * 100) / 100,
    frameMs: Math.round(frameMs * 100) / 100,
    gpu: gpuTimer.getResults(),
  });
  // 디버그 도구용: 지원 Uniform 타입, 프로그램별 활성 Uniform/무시된 내장 Uniform, GPU 타이머 On/Off.
  const getUniformTypes = () =>
    Object.entries(UNIFORM_TYPES).map(([type, spec]) => ({ type, components: spec.n, kind: spec.kind }));
  // 각 활성 Uniform에 출처를 붙인다: builtin(렌더러 제공) · user(등록된 파라미터) · unregistered(선언만 됨, 값 0).
  const classify = report => {
    if (!report?.uniforms) return report;
    for (const item of report.uniforms)
      item.source = reservedUniforms.has(item.name) ? "builtin" : userUniforms.has(item.name) ? "user" : "unregistered";
    return report;
  };
  const getShaderReflection = () => ({
    image: classify(Diagnostics.describeLocations(uniforms)),
    passes: passManager.getReflection().map(classify),
  });
  // GPU/브라우저 기능 요약. 컨텍스트 손실 후에는 다시 조회한다.
  let capabilities = null;
  const getCapabilities = () => {
    if (lost || disposed) return null;
    if (capabilities) return { ...capabilities, extensions: { ...capabilities.extensions } };
    const info = gl.getExtension("WEBGL_debug_renderer_info"),
      names = [
        "EXT_color_buffer_float",
        "EXT_color_buffer_half_float",
        "OES_texture_float_linear",
        "EXT_disjoint_timer_query_webgl2",
        "KHR_parallel_shader_compile",
        "WEBGL_lose_context",
        "EXT_texture_filter_anisotropic",
      ];
    const supported = new Set(gl.getSupportedExtensions?.() || []);
    capabilities = {
      vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
      maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
      extensions: Object.fromEntries(names.map(name => [name, supported.has(name)])),
    };
    return getCapabilities();
  };
  const setGpuTiming = value => {
    if (disposed) throw new Error("이미 폐기된 Renderer입니다.");
    return gpuTimer.setEnabled(value);
  };
  return {
    start,
    stop,
    resetSimulation,
    stepFrame,
    setTimeScale,
    beginOffline,
    renderOfflineFrame,
    renderOfflineFrameTiled,
    getOfflineTiling,
    endOffline,
    isOffline,
    captureScreenshot,
    captureScreenshotAt,
    onFrame,
    redraw,
    validateFragment,
    validatePassConfiguration,
    setFragment,
    setResolutionScale,
    setMaxPixels,
    setFpsLimit,
    defineUniform,
    setUniform,
    removeUniform,
    getUserUniforms,
    getUniforms,
    getUniformTypes,
    getShaderReflection,
    getCapabilities,
    setGpuTiming,
    getStats,
    validatePortable,
    applyPortable,
    applyProject,
    setUserUniforms,
    validateUniformValue: normalizeUniform,
    sampleRamp,
    setPasses,
    setPassFragment,
    setPassChannels,
    setImageChannels,
    setPreviewPass,
    setPreviewOptions,
    readPassPixel,
    setKey,
    releaseKeys,
    usesKeyboard,
    readKey,
    captureBufferThumbnails,
    addTexture,
    removeTexture,
    restoreTextures,
    texturesRestored: () => textureInput.whenRestored(),
    failedTextures: () => textureInput.failedIds(),
    getTextures,
    getTextureFile: id => textureInput.get(id)?.file || null,
    setTextureSampling,
    getPasses: passManager.getPasses,
    getPassDefinitions: passManager.getSpecs,
    getFragmentSource: () => fragmentSource,
    getImageChannels: passManager.getImageChannels,
    dispose,
  };
};
export { createRenderer };
