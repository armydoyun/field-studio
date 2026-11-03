"use strict";
(()=>{
const gpu_diagnostics=(()=>{
// GPU 진단 공용 도구: GL 오류 격리, 활성 Uniform 리플렉션, GPU 패스 시간 측정.
// 리소스를 직접 소유하는 것은 GPU 타이머의 Query 객체뿐이며 onLost/restore/dispose로 수명을 관리한다.
  // getActiveUniform() 타입 상수 → GLSL 타입 이름. 모의 GL에도 동작하도록 숫자 상수를 직접 사용한다.
  const GLSL_TYPES = new Map([
    [0x1406,"float"],[0x8B50,"vec2"],[0x8B51,"vec3"],[0x8B52,"vec4"],
    [0x1404,"int"],[0x8B53,"ivec2"],[0x8B54,"ivec3"],[0x8B55,"ivec4"],
    [0x1405,"uint"],[0x8DC6,"uvec2"],[0x8DC7,"uvec3"],[0x8DC8,"uvec4"],
    [0x8B56,"bool"],[0x8B57,"bvec2"],[0x8B58,"bvec3"],[0x8B59,"bvec4"],
    [0x8B5A,"mat2"],[0x8B5B,"mat3"],[0x8B5C,"mat4"],[0x8B65,"mat2x3"],[0x8B66,"mat2x4"],
    [0x8B67,"mat3x2"],[0x8B68,"mat3x4"],[0x8B69,"mat4x2"],[0x8B6A,"mat4x3"],
    [0x8B5E,"sampler2D"],[0x8B5F,"sampler3D"],[0x8B60,"samplerCube"],[0x8B62,"sampler2DShadow"],
    [0x8DC1,"sampler2DArray"],[0x8DC4,"sampler2DArrayShadow"],[0x8DC5,"samplerCubeShadow"],
    [0x8DCA,"isampler2D"],[0x8DCB,"isampler3D"],[0x8DCC,"isamplerCube"],[0x8DCF,"isampler2DArray"],
    [0x8DD2,"usampler2D"],[0x8DD3,"usampler3D"],[0x8DD4,"usamplerCube"],[0x8DD7,"usampler2DArray"]
  ]);
  // 이전 호출이 남긴 GL 오류 플래그를 비운다. getError()는 동기 호출이므로 매 프레임 사용하지 않는다.
  // 상한을 두어 손실된 컨텍스트나 비정상 드라이버에서도 무한 루프가 생기지 않게 한다.
  const clearErrors = gl => {
    if(typeof gl.getError !== "function") return 0;
    let count = 0; while(count < 32 && gl.getError() !== gl.NO_ERROR) count++;
    return count;
  };
  // 링크된 Program의 활성 Uniform 표. 드라이버가 최적화로 제거한 Uniform은 포함되지 않는다.
  // 리플렉션을 지원하지 않는 환경(모의 GL 등)에서는 null을 돌려 기존 동작을 유지한다.
  const reflectUniforms = (gl, program) => {
    if(!program || typeof gl.getActiveUniform !== "function") return null;
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    if(!Number.isInteger(count) || count < 0) return null;
    const table = new Map();
    for(let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i); if(!info) continue;
      const name = info.name.replace(/\[0\]$/, "");
      // Uniform Block 멤버와 구조체 필드는 개별 Location 업로드 대상이 아니다.
      if(name.includes(".") || name.includes("[")) continue;
      table.set(name, {name, type:GLSL_TYPES.get(info.type) || `0x${info.type.toString(16)}`, size:info.size});
    }
    return table;
  };
  // 디버그 UI·외부 도구용 직렬화. 내부 Location 객체는 노출하지 않는다.
  const describeLocations = locations => !locations ? null : {
    uniforms:locations.active ? [...locations.active.values()].map(item => ({...item})) : null,
    ignored:(locations.mismatches || []).map(item => ({...item}))
  };
  // EXT_disjoint_timer_query_webgl2 기반 패스별 GPU 시간 측정.
  // - Query는 풀에서 재사용하며 결과는 비동기로 수집한다(파이프라인 정지 없음).
  // - 동시에 하나의 TIME_ELAPSED Query만 활성화할 수 있으므로 패스 단위로 begin/end한다.
  // - GPU_DISJOINT가 발생하면 해당 구간 결과를 버린다.
  const createGpuTimer = gl => {
    const MAX_PENDING = 96, STALE_FRAMES = 120;
    let ext = null, enabled = true, lost = false, active = null, serial = 0;
    const free = [], pending = [], results = new Map();
    const acquire = () => {
      const entry = free.pop(); if(entry) return entry;
      const query = gl.createQuery(); return query ? {query, label:""} : null;
    };
    const recycleAll = () => { while(pending.length) free.push(pending.shift()); };
    const init = () => {
      ext = typeof gl.getExtension === "function" ? gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
    };
    const begin = label => {
      if(!ext || !enabled || lost || active) return false;
      const entry = acquire(); if(!entry) return false;
      entry.label = label; gl.beginQuery(ext.TIME_ELAPSED_EXT, entry.query); active = entry; return true;
    };
    // end()는 활성 Query가 없으면 아무것도 하지 않으므로 finally 블록에서 안전하게 호출할 수 있다.
    const end = () => {
      if(!active) return; gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); active = null;
      if(pending.length > MAX_PENDING) free.push(pending.shift());
    };
    const record = (label, ms) => {
      let item = results.get(label);
      if(!item) { item = {label, ms:ms, last:ms, updated:serial}; results.set(label, item); }
      else { item.ms = item.ms * 0.9 + ms * 0.1; item.last = ms; item.updated = serial; }
    };
    // 프레임 끝에서 준비된 결과만 수집한다. 준비되지 않은 Query는 다음 프레임에 다시 확인한다.
    const endFrame = () => {
      if(!ext || lost) return; end(); serial++;
      if(gl.getParameter(ext.GPU_DISJOINT_EXT)) { recycleAll(); return; }
      while(pending.length) {
        const entry = pending[0];
        if(!gl.getQueryParameter(entry.query, gl.QUERY_RESULT_AVAILABLE)) break;
        record(entry.label, gl.getQueryParameter(entry.query, gl.QUERY_RESULT) / 1e6); free.push(pending.shift());
      }
    };
    const getResults = () => {
      const passes = []; let total = 0;
      for(const item of results.values()) if(serial - item.updated <= STALE_FRAMES) {
        passes.push({label:item.label, ms:Math.round(item.ms * 1000) / 1000}); total += item.ms;
      }
      return {available:!!ext && !lost, enabled, totalMs:passes.length ? Math.round(total * 1000) / 1000 : null, passes};
    };
    const setEnabled = value => { if(typeof value !== "boolean") throw new TypeError("GPU 타이머 설정은 boolean이어야 합니다."); enabled = value; if(!value) { end(); results.clear(); } return enabled; };
    const deleteAll = () => {
      if(active) { try { gl.endQuery(ext.TIME_ELAPSED_EXT); } catch (_) {} free.push(active); active = null; }
      recycleAll(); for(const entry of free) gl.deleteQuery(entry.query); free.length = 0;
    };
    // 손실된 컨텍스트의 Query 핸들은 삭제하지 않고 참조만 버린다.
    const onLost = () => { lost = true; active = null; pending.length = free.length = 0; results.clear(); };
    const restore = () => { lost = false; init(); };
    const dispose = () => { if(!lost && ext) deleteAll(); ext = null; active = null; pending.length = free.length = 0; results.clear(); };
    init();
    return {begin, end, endFrame, getResults, setEnabled, onLost, restore, dispose};
  };
  return {GLSL_TYPES,clearErrors,reflectUniforms,describeLocations,createGpuTimer};
})();
const pass_manager=((Diagnostics)=>{
// 화면 외 렌더 패스의 프로그램, 출력 Texture 및 FBO를 관리한다.
// 이전 프레임 참조를 위해 각 패스는 항상 두 장(ping-pong)의 Texture 세트를 교대로 사용한다.
// 한 패스는 최대 4개의 출력(MRT, layout(location=N))을 가질 수 있고, 출력마다 ping-pong Texture가 있다.

  // 렌더러가 매 프레임 값을 넣는 내장 Uniform과 허용 GLSL 타입. 첫 타입이 리플렉션 불가 시 기본값이다.
  // 허용 밖의 타입으로 선언되면 업로드를 생략해 매 프레임 INVALID_OPERATION이 쌓이지 않게 한다.
  const BUILTINS = {resolution:["uResolution",["vec2","vec3"]],time:["uTime",["float"]],delta:["uDeltaTime",["float"]],
    frame:["uFrame",["int","float","uint"]],mouse:["uMouse",["vec2","vec4"]],debug:["uDebugRaySteps",["bool","int"]],
    maxSteps:["uMaxSteps",["int","float"]],maxDistance:["uMaxDistance",["float"]],surfaceEpsilon:["uSurfaceEpsilon",["float"]],
    normalEpsilon:["uNormalEpsilon",["float"]]};
  // 출력 형식별 GPU 저장 방식. float 계열은 EXT_color_buffer_float가 있어야 FBO로 렌더링할 수 있다.
  const FORMATS = {rgba8:{bytes:4,float:false}, rgba16f:{bytes:8,float:true}, rgba32f:{bytes:16,float:true}};
  const FILTERS = ["linear","nearest"], WRAPS = ["clamp","repeat","mirror"], MAX_OUTPUTS = 4, MAX_FIXED_SIZE = 8192;
  // 형식별 기본 필터. RGBA32F의 선형 필터는 OES_texture_float_linear가 필요하므로 기본은 nearest다.
  const defaultFilter = format => format === "rgba32f" ? "nearest" : "linear";
  // Image와 Buffer가 공유하는 Uniform 위치 조회. 프로그램 교체 시 다시 호출한다.
  const makeLocations = (gl, program) => {
    const active = Diagnostics.reflectUniforms(gl, program), types = {}, mismatches = [];
    const result = {program, active, types, mismatches, custom:new Map()};
    for(const [key, [name, allowed]] of Object.entries(BUILTINS)) {
      const info = active?.get(name);
      if(info && !allowed.includes(info.type)) {
        mismatches.push({name, declared:info.type, expected:allowed.join(" | ")}); result[key] = null; types[key] = null; continue;
      }
      result[key] = gl.getUniformLocation(program,name); types[key] = info ? info.type : allowed[0];
    }
    result.channels = [0,1,2,3].map(i => gl.getUniformLocation(program,`iChannel${i}`));
    result.channelResolution = [0,1,2,3].map(i => gl.getUniformLocation(program,`iChannelResolution[${i}]`));
    return result;
  }; const createPassManager = (gl, createProgram, textureStore) => {
    let passes = [], imageChannels = {}, preview = null, previewAttachment = 0, previewProgram = null, previewLocations = null, maxTextureSize = null;
    // 미리보기·썸네일 표시 옵션: channel 0=RGB 1=R 2=G 3=B 4=A, exposure는 RGB 배율(HDR 버퍼 확인용).
    const previewOptions = {channel:0, exposure:1};
    let thumbTexture = null, thumbFbo = null, thumbWidth = 0, thumbHeight = 0;
    const units = [gl.TEXTURE0, gl.TEXTURE1, gl.TEXTURE2, gl.TEXTURE3]; const passOrder = () => new Map(passes.map((entry,i) => [entry.name,i]));
    const validName = name => typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
    const deleteTargets = pass => {
      for(const fbo of pass.fbos || []) gl.deleteFramebuffer(fbo);
      for(const set of pass.attachments || [pass.textures || []]) for(const tex of set) gl.deleteTexture(tex);
      pass.fbos = []; pass.textures = []; pass.attachments = []; pass.width = pass.height = 0;
    }; const deletePass = pass => { deleteTargets(pass); if(pass.program) gl.deleteProgram(pass.program); pass.program = null; };
    const deleteThumb = () => { if(thumbFbo) gl.deleteFramebuffer(thumbFbo); if(thumbTexture) gl.deleteTexture(thumbTexture); thumbFbo = thumbTexture = null; thumbWidth = thumbHeight = 0; };
    const removeGPU = () => { for(const pass of passes) deletePass(pass); if(previewProgram) gl.deleteProgram(previewProgram); previewProgram = null; deleteThumb(); };
    // outputsOf(name): 참조 대상 Buffer의 출력 수. attachment 번호 검증에 사용한다.
    const validateChannels = (channels, source, order, isImage = false, outputsOf = () => 1) => {
      if(!channels || typeof channels !== "object" || Array.isArray(channels)) throw new TypeError("channels는 객체여야 합니다.");
      const result = {}; for(const [key, ref] of Object.entries(channels)) {
        if(!/^[0-3]$/.test(key) || !ref || typeof ref !== "object") throw new Error(`잘못된 채널: ${key}`);
        if(typeof ref.texture === "string" && Object.keys(ref).length === 1) {
          if(!textureStore.get(ref.texture)) throw new Error(`존재하지 않는 이미지: ${ref.texture}`);
          result[key] = {texture:ref.texture}; continue;
        }
        if(!validName(ref.buffer) || !["current","previous"].includes(ref.frame))
          throw new Error(`잘못된 채널 ${key}: Buffer 이름과 frame을 확인하세요.`);
        if(!order.has(ref.buffer)) throw new Error(`존재하지 않는 Buffer: ${ref.buffer}`);
        if(!isImage && ref.frame === "current" && order.get(ref.buffer) >= order.get(source))
          throw new Error(`${source}의 current 입력은 앞서 실행한 버퍼만 참조할 수 있습니다.`);
        const attachment = ref.attachment ?? 0;
        if(!Number.isInteger(attachment) || attachment < 0 || attachment >= outputsOf(ref.buffer))
          throw new Error(`잘못된 채널 ${key}: ${ref.buffer}에는 출력 ${attachment}이(가) 없습니다.`);
        result[key] = attachment ? {buffer:ref.buffer,frame:ref.frame,attachment} : {buffer:ref.buffer,frame:ref.frame};
      }
      return result;
    };
    // 패스 정의 정규화. 기본값(size=null, outputs=1, filter=형식 기본, wrap=clamp, mipmap=false)은 기존 정의와 같다.
    const normalizeSpec = s => {
      if(typeof s.fragment !== "string" || !s.fragment.startsWith("#version 300 es") || s.fragment.length > 262144) throw new Error(`${s.name}: 전체 GLSL ES 3.00 Fragment 문자열이 필요합니다.`);
      const scale = s.scale === undefined ? 1 : s.scale, format = s.format || "rgba8";
      if(!Number.isFinite(scale) || scale < 0.125 || scale > 1 || !Object.hasOwn(FORMATS, format)) throw new Error(`${s.name}: scale 또는 format이 잘못됐습니다.`);
      const size = s.size ?? null, outputs = s.outputs ?? 1, filter = s.filter ?? defaultFilter(format), wrap = s.wrap ?? "clamp", mipmap = s.mipmap ?? false;
      if(size !== null && (!Array.isArray(size) || size.length !== 2 || !size.every(v => Number.isInteger(v) && v >= 1 && v <= MAX_FIXED_SIZE)))
        throw new Error(`${s.name}: size는 [너비, 높이] 정수(1~${MAX_FIXED_SIZE})여야 합니다.`);
      if(!Number.isInteger(outputs) || outputs < 1 || outputs > MAX_OUTPUTS) throw new Error(`${s.name}: outputs는 1~${MAX_OUTPUTS} 정수여야 합니다.`);
      if(!FILTERS.includes(filter) || !WRAPS.includes(wrap) || typeof mipmap !== "boolean") throw new Error(`${s.name}: filter/wrap/mipmap 설정이 올바르지 않습니다.`);
      return {name:s.name, fragment:s.fragment, scale, format, size:size && [...size], outputs, filter, wrap, mipmap};
    };
    const validateDefinition = (specs, image = {}) => {
      if(!Array.isArray(specs) || specs.length > 8) throw new TypeError("passes는 최대 8개까지의 배열이어야 합니다."); const order = new Map();
      specs.forEach((s,i) => { if(!s || !validName(s.name) || s.name === "Image" || order.has(s.name)) throw new Error("패스 이름이 유효하지 않거나 중복됩니다."); order.set(s.name,i); });
      const shapes = specs.map(normalizeSpec), outputsOf = name => shapes[order.get(name)]?.outputs ?? 1;
      const normalized = shapes.map((shape,i) => ({...shape, channels:validateChannels(specs[i].channels || {},shape.name,order,false,outputsOf)}));
      const nextImage = validateChannels(image, "Image", order, true, outputsOf);
      if(normalized.some(s => FORMATS[s.format].float) && !gl.getExtension("EXT_color_buffer_float"))
        throw new Error("RGBA16F/RGBA32F 렌더링은 EXT_color_buffer_float 확장이 필요합니다.");
      // RGBA32F를 선형 필터·밉맵으로 샘플링하려면 float 선형 필터 확장이 필요하다(getExtension 호출로 활성화).
      if(normalized.some(s => s.format === "rgba32f" && (s.filter === "linear" || s.mipmap)) && !gl.getExtension("OES_texture_float_linear"))
        throw new Error("RGBA32F의 linear 필터/밉맵은 OES_texture_float_linear 확장이 필요합니다. nearest 필터나 RGBA16F를 사용하세요.");
      return {normalized,nextImage};
    }; const validateConfiguration = (specs, image = {}) => { validateDefinition(specs,image); return true; };
    const compilePass = (source,name) => {
      let program;try {program=createProgram(source);return {program,locations:makeLocations(gl,program)};}
      catch(error) {if(program)gl.deleteProgram(program);error.passName=name;throw error;}
    };
    const setPasses = (specs, image = {}) => {
      const {normalized,nextImage} = validateDefinition(specs,image); const next = []; try {
        for(const s of normalized) {
          next.push({...s,...compilePass(s.fragment,s.name),textures:[],attachments:[],fbos:[],width:0,height:0,readIndex:0});
        }
      } catch(error) { for(const p of next) deletePass(p); throw error; }
      const old = passes; passes = next; imageChannels = nextImage; preview = null; previewAttachment = 0; for(const p of old) deletePass(p);
    };
    // Uniform 선언 변경 시 모든 패스의 프로그램만 다시 빌드한다. Texture와 누적 결과는 보존.
    const refreshPrograms = () => {
      const next=[];
      try {for(const pass of passes)next.push({pass,...compilePass(pass.fragment,pass.name)});}
      catch(error) {next.forEach(item=>gl.deleteProgram(item.program));throw error;}
      for(const item of next) {const old=item.pass.program;item.pass.program=item.program;item.pass.locations=item.locations;
        if(old)gl.deleteProgram(old);
      }
    };
    // 저장소 형태가 바뀌는 설정은 구조 변경(새 Texture), filter/wrap은 기존 Texture에 샘플러만 다시 적용한다.
    const STRUCTURAL = ["name","scale","format","outputs","mipmap"];
    const sameShape = (a, b) => STRUCTURAL.every(key => a[key] === b[key]) && JSON.stringify(a.size) === JSON.stringify(b.size);
    // 구조가 같으면 변경 프로그램만 준비한다. 전부 성공한 뒤 소스/채널을 함께 교체한다.
    const updatePasses = (specs,image={}) => {
      const {normalized,nextImage}=validateDefinition(specs,image);
      if(normalized.length!==passes.length || normalized.some((p,i)=>!sameShape(p,passes[i]))) {setPasses(specs,image);return {changed:true,structural:true};}
      const next=[];let changed=JSON.stringify(imageChannels)!==JSON.stringify(nextImage);
      try {for(let i=0;i<passes.length;i++) {
        const pass=passes[i], spec=normalized[i];
        if(pass.fragment!==spec.fragment)next.push({pass,...compilePass(spec.fragment,spec.name)});
        if(JSON.stringify(pass.channels)!==JSON.stringify(spec.channels))changed=true;
      }} catch(error) {for(const item of next)gl.deleteProgram(item.program);throw error;}
      for(const {pass,program,locations} of next) {gl.deleteProgram(pass.program);pass.program=program;pass.locations=locations;}
      passes.forEach((pass,i)=>{
        const resample = pass.filter!==normalized[i].filter || pass.wrap!==normalized[i].wrap;
        Object.assign(pass,normalized[i]); if(resample){applyPassSampling(pass);changed=true;}
      });
      imageChannels=nextImage;return {changed:changed||next.length>0,structural:false};
    };
    // 셰이더 교체 및 채널 재연결은 기존 FBO/Texture를 유지한다.
    const setPassFragment = (name, source) => {
      const pass = passes.find(p => p.name === name);
            if(!pass) throw new Error(`존재하지 않는 Buffer: ${name}`);
      if(typeof source !== "string" || !source.startsWith("#version 300 es")) throw new Error("GLSL ES 3.00 Fragment 소스가 필요합니다.");
      const {program,locations}=compilePass(source,name);
      const previous = pass.program;
      pass.program = program; pass.locations = locations; pass.fragment = source; if(previous) gl.deleteProgram(previous);
    };
    const outputsOfLive = name => passes.find(p => p.name === name)?.outputs ?? 1;
    const setPassChannels = (name, channels) => {
      const index = passes.findIndex(p => p.name === name);
            if(index < 0) throw new Error(`존재하지 않는 Buffer: ${name}`);
      const order = passOrder(); passes[index].channels = validateChannels(channels,name,order,false,outputsOfLive);
    };
    // 기본값과 같은 선택 항목은 생략해 기존 프로젝트 JSON과 동일한 모양을 유지한다.
    const getSpecs = () => passes.map(p => {
      const spec = {name:p.name,fragment:p.fragment,format:p.format,scale:p.scale,channels:JSON.parse(JSON.stringify(p.channels))};
      if(p.size) spec.size = [...p.size]; if(p.outputs !== 1) spec.outputs = p.outputs; if(p.filter !== defaultFilter(p.format)) spec.filter = p.filter;
      if(p.wrap !== "clamp") spec.wrap = p.wrap; if(p.mipmap) spec.mipmap = true; return spec;
    });
    const setImageChannels = channels => {
      const order = passOrder(); imageChannels = validateChannels(channels, "Image", order, true, outputsOfLive);
    }; const setPreview = (name, attachment = 0) => {
            if(name !== null && !passes.some(p => p.name === name)) throw new Error(`존재하지 않는 Buffer: ${name}`);
      if(name !== null && (!Number.isInteger(attachment) || attachment < 0 || attachment >= outputsOfLive(name))) throw new Error(`${name}에는 출력 ${attachment}이(가) 없습니다.`);
      preview = name; previewAttachment = name === null ? 0 : attachment;
    }; const setPreviewOptions = (changes = {}) => {
      if(changes.channel !== undefined) { if(![0,1,2,3,4].includes(changes.channel)) throw new RangeError("channel은 0(RGB)~4(A)여야 합니다."); previewOptions.channel = changes.channel; }
      if(changes.exposure !== undefined) { if(!Number.isFinite(changes.exposure) || changes.exposure <= 0 || changes.exposure > 1024) throw new RangeError("exposure는 0보다 크고 1024 이하여야 합니다."); previewOptions.exposure = changes.exposure; }
      return {...previewOptions};
    };
    // 현재 바인딩된 TEXTURE_2D에 패스의 샘플러 상태를 적용한다.
    const applySampling = pass => {
      const linear = pass.filter === "linear", wrap = {clamp:gl.CLAMP_TO_EDGE, repeat:gl.REPEAT, mirror:gl.MIRRORED_REPEAT}[pass.wrap] ?? gl.CLAMP_TO_EDGE;
      const min = pass.mipmap ? (linear ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST) : (linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,min); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,linear?gl.LINEAR:gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,wrap); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,wrap);
    };
    const applyPassSampling = pass => {
      for(const set of pass.attachments || []) for(const tex of set) { gl.bindTexture(gl.TEXTURE_2D,tex); applySampling(pass); }
      gl.bindTexture(gl.TEXTURE_2D,null);
    };
    // 밉맵을 쓰는 패스는 렌더링 직후 해당 면의 모든 출력에 대해 하위 레벨을 다시 만든다.
    const generateMips = (pass, side) => {
      gl.activeTexture(gl.TEXTURE0);
      for(const set of pass.attachments) { gl.bindTexture(gl.TEXTURE_2D,set[side]); gl.generateMipmap(gl.TEXTURE_2D); }
      gl.bindTexture(gl.TEXTURE_2D,null);
    };
    // 모든 패스의 신규 FBO가 준비된 후 교체한다. 중간 실패 시 기존 패스 전체를 유지.
    const createTargets = (pass, width, height) => {
      const temp = {name:pass.name, attachments:Array.from({length:pass.outputs}, () => []), fbos:[], width, height};
      temp.textures = temp.attachments[0];
      // 이전 프레임의 오류 플래그를 비워야 아래 검사가 이번 할당의 실패(OUT_OF_MEMORY 등)만 판단한다.
      Diagnostics.clearErrors(gl);
      try {
        const internal = {rgba8:gl.RGBA8, rgba16f:gl.RGBA16F, rgba32f:gl.RGBA32F}[pass.format] ?? gl.RGBA8;
        const type = {rgba8:gl.UNSIGNED_BYTE, rgba16f:gl.HALF_FLOAT, rgba32f:gl.FLOAT}[pass.format] ?? gl.UNSIGNED_BYTE;
        for(let side=0;side<2;side++) {
          const fbo = gl.createFramebuffer(); if(!fbo) throw new Error(`${pass.name}: Framebuffer 생성 실패`);
          temp.fbos.push(fbo);
          for(let attachment=0;attachment<pass.outputs;attachment++) {
            const texture = gl.createTexture(); if(!texture) throw new Error(`${pass.name}: Texture 생성 실패`);
            temp.attachments[attachment].push(texture); gl.bindTexture(gl.TEXTURE_2D,texture);
            gl.texImage2D(gl.TEXTURE_2D,0,internal,width,height,0,gl.RGBA,type,null);
            if(typeof gl.getError === "function") {
              const error = gl.getError(); if(error !== gl.NO_ERROR) throw new Error(`${pass.name}: GPU Texture 할당 실패 (${error}) · Scale을 낮추거나 Buffer 수를 줄이세요.`);
            }
            applySampling(pass);
            gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0+attachment,gl.TEXTURE_2D,texture,0);
          }
          // drawBuffers 상태는 FBO에 저장되므로 생성 시 한 번만 설정한다(출력 1개면 기본값 그대로).
          if(pass.outputs > 1) gl.drawBuffers(Array.from({length:pass.outputs}, (_, i) => gl.COLOR_ATTACHMENT0 + i));
          if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw new Error(`${pass.name}: Framebuffer 불완전`);
          gl.viewport(0,0,width,height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
        }
        if(pass.mipmap) { gl.bindFramebuffer(gl.FRAMEBUFFER,null); generateMips(temp,0); generateMips(temp,1); }
        return temp;
      } catch(error) { deleteTargets(temp); throw error; }
      finally { gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindTexture(gl.TEXTURE_2D,null); }
    }; const targetSize = (pass,width,height) => pass.size ? pass.size : [Math.max(1,Math.floor(width*pass.scale)), Math.max(1,Math.floor(height*pass.scale))];
    const ensureTargets = (width,height) => {
      if(!passes.length)return false;const pending = [], max = maxTextureSize??(maxTextureSize=gl.getParameter(gl.MAX_TEXTURE_SIZE));
      try {for(const pass of passes) {
        const [w,h] = targetSize(pass,width,height);
        if(w > max || h > max) throw new Error(`${pass.name}: GPU 최대 Texture 크기 초과`);
        if(w !== pass.width || h !== pass.height || pass.textures.length !== 2)
          pending.push({pass, target:createTargets(pass,w,h)});
      }} catch(error) { for(const {target} of pending) deleteTargets(target); throw error; }
      for(const {pass,target} of pending) {deleteTargets(pass);Object.assign(pass,target);}
      return pending.length > 0;
    };
    const releaseChannels = () => { for(let i=0;i<4;i++) { gl.activeTexture(units[i]); gl.bindTexture(gl.TEXTURE_2D,null); } gl.activeTexture(gl.TEXTURE0); };
    const bindChannels = (channels, locations, forImage = false) => {
      for(let i=0;i<4;i++) {
        const ref=channels[i];gl.activeTexture(units[i]);let texture=null,width=0,height=0;
        if(ref?.texture) {const asset=textureStore.get(ref.texture);if(asset){texture=asset.tex;width=asset.width;height=asset.height;}}
        else if(ref) {
          const pass=passes.find(p=>p.name===ref.buffer),currentIndex=1-pass.readIndex;
          const index=ref.frame==="previous"?(forImage?currentIndex:pass.readIndex):(forImage?pass.readIndex:currentIndex);
          texture=pass.attachments[ref.attachment||0]?.[index]??null;width=pass.width;height=pass.height;
        }
        gl.bindTexture(gl.TEXTURE_2D,texture);if(locations.channels[i]!==null)gl.uniform1i(locations.channels[i],i);
        if(locations.channelResolution[i]!==null)gl.uniform3f(locations.channelResolution[i],width,height,width?1:0);
      }
      gl.activeTexture(gl.TEXTURE0);
    }; // timer(선택): GPU 시간 측정기. 패스 이름으로 begin/end하며 예외 시에도 Query를 닫는다.
    const drawPasses = (width,height,uploadGlobals,timer = null) => {
      if(!passes.length) return;
      try { for(const pass of passes) {
          releaseChannels(); gl.bindFramebuffer(gl.FRAMEBUFFER,pass.fbos[1-pass.readIndex]);
          gl.viewport(0,0,pass.width,pass.height); gl.useProgram(pass.program);
          uploadGlobals(pass.locations,pass.width,pass.height); bindChannels(pass.channels,pass.locations);
          timer?.begin(pass.name); gl.drawArrays(gl.TRIANGLES,0,3); timer?.end();
          if(pass.mipmap) { releaseChannels(); gl.bindFramebuffer(gl.FRAMEBUFFER,null); generateMips(pass,1-pass.readIndex); }
        }
      // 모든 패스가 성공한 경우에만 previous/current 역할을 교환한다.
        for(const pass of passes) pass.readIndex = 1-pass.readIndex;
      } finally { timer?.end(); releaseChannels(); gl.bindFramebuffer(gl.FRAMEBUFFER,null); }
    }; const bindImage = locations => bindChannels(imageChannels,locations,true);
    const unbindImage = () => releaseChannels();
    // 미리보기 셰이더: 채널 분리(R/G/B/A 단색)와 노출 배율. HDR·음수 값은 화면에서 0~1로 잘린다.
    const previewFragment = `#version 300 es
precision highp float;
uniform sampler2D uPreview;
uniform vec2 uResolution;
uniform int uChannel;
uniform float uExposure;
out vec4 fragColor;
void main(){
  vec4 c = texture(uPreview, gl_FragCoord.xy / uResolution);
  vec3 rgb = c.rgb * uExposure;
  vec3 o = uChannel == 1 ? vec3(rgb.r) : uChannel == 2 ? vec3(rgb.g) : uChannel == 3 ? vec3(rgb.b) : uChannel == 4 ? vec3(c.a) : rgb;
  fragColor = vec4(o, 1.0);
}`;
    const ensurePreviewProgram = () => {
      if(previewProgram) return;
      const next=createProgram(previewFragment);
      try {previewLocations={texture:gl.getUniformLocation(next,"uPreview"),resolution:gl.getUniformLocation(next,"uResolution"),
        channel:gl.getUniformLocation(next,"uChannel"),exposure:gl.getUniformLocation(next,"uExposure")};}
      catch(error){gl.deleteProgram(next);throw error;}previewProgram=next;
    };
    // 텍스처 하나를 현재 FBO/뷰포트 전체에 미리보기 셰이더로 그린다.
    const drawTexture = (texture, width, height) => {
      ensurePreviewProgram(); gl.useProgram(previewProgram);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,texture); gl.uniform1i(previewLocations.texture,0);
      if(previewLocations.channel !== null) gl.uniform1i(previewLocations.channel,previewOptions.channel);
      if(previewLocations.exposure !== null) gl.uniform1f(previewLocations.exposure,previewOptions.exposure);
      try {gl.uniform2f(previewLocations.resolution,width,height); gl.drawArrays(gl.TRIANGLES,0,3);}
      finally {releaseChannels();}
    };
    const drawPreview = (width,height) => {
      if(!preview) return false; const pass = passes.find(p => p.name === preview); if(!pass || !pass.textures.length) return false;
      releaseChannels(); gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,width,height);
      drawTexture(pass.attachments[previewAttachment]?.[pass.readIndex] ?? pass.textures[pass.readIndex], width, height); return true;
    };
    // 디버그 썸네일: 모든 패스 출력을 작은 RGBA8 FBO에 축소해 그리고 읽어온다. 호출 빈도는 UI가 제한한다(초당 몇 회).
    // 반환 pixels는 좌하단 원점(행이 아래→위)이다.
    const captureThumbnails = (maxWidth = 160) => {
      const result = []; if(!passes.length) return result;
      for(const pass of passes) {
        if(!pass.textures.length) continue;
        const width = Math.max(1, Math.min(maxWidth, pass.width)), height = Math.max(1, Math.round(width * pass.height / pass.width));
        if(width !== thumbWidth || height !== thumbHeight) {
          deleteThumb(); thumbTexture = gl.createTexture(); thumbFbo = gl.createFramebuffer(); if(!thumbTexture || !thumbFbo) { deleteThumb(); return result; }
          gl.bindTexture(gl.TEXTURE_2D,thumbTexture); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
          gl.bindTexture(gl.TEXTURE_2D,null); gl.bindFramebuffer(gl.FRAMEBUFFER,thumbFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,thumbTexture,0); thumbWidth = width; thumbHeight = height;
        }
        for(let attachment=0;attachment<pass.outputs;attachment++) {
          gl.bindFramebuffer(gl.FRAMEBUFFER,thumbFbo); gl.viewport(0,0,width,height);
          drawTexture(pass.attachments[attachment][pass.readIndex], width, height);
          const pixels = new Uint8Array(width*height*4); gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
          result.push({name:pass.name, attachment, width, height, sourceWidth:pass.width, sourceHeight:pass.height, format:pass.format, pixels});
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,null); return result;
    };
    const readPixel = (name,x,y,attachment=0) => {
      const pass = passes.find(p=>p.name===name);
            if(!pass || !pass.textures.length) throw new Error(`Buffer ${name}이 아직 렌더링되지 않았습니다.`);
      if(!Number.isInteger(x) || !Number.isInteger(y) || x<0 || x>=pass.width || y<0 || y>=pass.height) throw new RangeError("픽셀 좌표가 범위를 벗어났습니다.");
      if(!Number.isInteger(attachment) || attachment<0 || attachment>=pass.outputs) throw new RangeError(`${name}에는 출력 ${attachment}이(가) 없습니다.`);
      const float = FORMATS[pass.format].float, pixel = float ? new Float32Array(4) : new Uint8Array(4);
      const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING); Diagnostics.clearErrors(gl);
      try { gl.bindFramebuffer(gl.READ_FRAMEBUFFER,pass.fbos[pass.readIndex]); if(attachment) gl.readBuffer(gl.COLOR_ATTACHMENT0+attachment);
        gl.readPixels(x,y,1,1,gl.RGBA,float?gl.FLOAT:gl.UNSIGNED_BYTE,pixel);
        const error = gl.getError(); if(error !== gl.NO_ERROR) throw new Error(`GPU 픽셀 읽기 실패: ${error}`);
      } finally { if(attachment) gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.bindFramebuffer(gl.READ_FRAMEBUFFER,previous); }
      return [...pixel]; // 좌하단 원점. CPU 읽기는 GPU 동기화 비용이 발생할 수 있다.
    };
    // 모든 ping-pong 텍스처를 지우되 GPU 프로그램과 버퍼 연결은 보존한다.
    const resetTargets = () => {
      releaseChannels(); gl.clearColor(0,0,0,0); for(const pass of passes) {
        for(const fbo of pass.fbos) { gl.bindFramebuffer(gl.FRAMEBUFFER,fbo); gl.viewport(0,0,pass.width,pass.height); gl.clear(gl.COLOR_BUFFER_BIT); }
        if(pass.mipmap && pass.textures.length) { gl.bindFramebuffer(gl.FRAMEBUFFER,null); generateMips(pass,0); generateMips(pass,1); }
        pass.readIndex = 0;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    };
    const getPasses = () => passes.map(p => ({name:p.name,format:p.format,scale:p.scale,size:p.size&&[...p.size],outputs:p.outputs,filter:p.filter,wrap:p.wrap,mipmap:p.mipmap,
      width:p.width,height:p.height,channels:JSON.parse(JSON.stringify(p.channels))}));
    const detachTexture = id => {
      for(const pass of passes) for(const key of Object.keys(pass.channels))
      if(pass.channels[key].texture === id) delete pass.channels[key];
      for(const key of Object.keys(imageChannels)) if(imageChannels[key].texture === id) delete imageChannels[key];
    }; const getImageChannels = () => JSON.parse(JSON.stringify(imageChannels)); const getPreview = () => preview;
    // 밉맵 체인은 기본 레벨의 약 1/3을 추가로 사용한다.
    const getMemoryBytes = () => Math.round(passes.reduce((sum,p) => sum + p.width*p.height*FORMATS[p.format].bytes*2*p.outputs*(p.mipmap?4/3:1),0));
    // 패스별 활성 Uniform과 무시된 내장 Uniform(타입 불일치) 목록. 디버그 패널용.
    const getReflection = () => passes.map(p => ({name:p.name, ...(Diagnostics.describeLocations(p.locations) || {uniforms:null, ignored:[]})}));
    const onLost = (release=false) => {
      if(release)removeGPU(); // 복구 실패 시 새 컨텍스트의 부분 생성 자원을 정리한다.
      // Context Lost에서는 더 이상 유효하지 않은 WebGL 객체를 삭제하지 않는다.
      for(const p of passes) { p.program = null; p.locations = null; p.textures = []; p.attachments = []; p.fbos = []; p.width=p.height=0; p.readIndex=0; }
      previewProgram = previewLocations = maxTextureSize = null; thumbFbo = thumbTexture = null; thumbWidth = thumbHeight = 0;
    }; const restore = () => {
      const compiled = [];
      try {for(const p of passes)compiled.push({p,...compilePass(p.fragment,p.name)});}
      catch(error) { for(const c of compiled) gl.deleteProgram(c.program); throw error; }
      for(const c of compiled) { c.p.program = c.program; c.p.locations = c.locations; }
    }; const dispose = () => { removeGPU(); passes = []; imageChannels = {}; preview = previewLocations = maxTextureSize = null; };
    return {setPasses,updatePasses,validateConfiguration,refreshPrograms,setPassFragment,setPassChannels,getSpecs,setImageChannels,setPreview,setPreviewOptions,
      getPreviewOptions:() => ({...previewOptions}),getPreviewAttachment:() => previewAttachment,ensureTargets,drawPasses,bindImage,unbindImage,drawPreview,
      captureThumbnails,readPixel,resetTargets,getPasses,getImageChannels,getPreview,getMemoryBytes,getReflection,detachTexture,onLost,restore,dispose};
  }; return {createPassManager,makeLocations,FORMATS};
})(gpu_diagnostics);
const texture_input=(()=>{
// 로컬 이미지를 Texture로 보관한다. 파일 본문은 IndexedDB에, GPU 객체는 WebGL에 둔다.
  const DB_NAME = "shader-studio-textures-v1", STORE = "files"; const openDB = () => new Promise((resolve,reject) => {
    if(!window.indexedDB) return reject(new Error("IndexedDB 사용 불가")); const req = indexedDB.open(DB_NAME,1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE,{keyPath:"id"});
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  }); const accessDB = async (mode,action) => {
    const db = await openDB();
    try {return await new Promise((resolve,reject) => {
        const tx = db.transaction(STORE,mode), req = action(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("이미지 저장 취소"));
      });} finally {db.close();}
  }; const createTextureInput = gl => {
    const library = new Map(); let writes=Promise.resolve();
    const persist = action => {const next=writes.then(()=>accessDB("readwrite",action));writes=next.catch(()=>{});return next;};
    let nextId = 1, lost = false, disposed = false;
    const defaults = {filter:"linear",wrapS:"clamp",wrapT:"clamp"};
    // 렌더 루프 등 이전 호출이 남긴 GL 오류가 이번 업로드 실패로 오인되지 않도록 검사 직전에 비운다.
    // (독립 모듈로 테스트되므로 gpu-diagnostics.js의 clearErrors와 같은 로직을 지역으로 둔다.)
    const clearErrors = () => {let count=0;while(count<32 && gl.getError()!==gl.NO_ERROR)count++;};
    const normalize = value => {
      const next = {...defaults,...value};
      if(!["linear","nearest"].includes(next.filter) || !["clamp","repeat","mirror"].includes(next.wrapS) || !["clamp","repeat","mirror"].includes(next.wrapT)) throw new Error("Texture 샘플링 설정이 올바르지 않습니다.");
      return next;
    }; const applyParams = options => {
      const filter = options.filter === "nearest" ? gl.NEAREST : gl.LINEAR;
      const wraps = {clamp:gl.CLAMP_TO_EDGE,repeat:gl.REPEAT,mirror:gl.MIRRORED_REPEAT};
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,wraps[options.wrapS]);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,wraps[options.wrapT]);
    }; const upload = (bitmap, options) => {
      if(lost) return null; if(bitmap.width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || bitmap.height > gl.getParameter(gl.MAX_TEXTURE_SIZE))
      throw new Error("이미지가 GPU 최대 Texture 크기를 초과합니다.");
      const tex = gl.createTexture(); if(!tex) throw new Error("Texture 생성 실패"); const old = gl.getParameter(gl.TEXTURE_BINDING_2D);
      clearErrors(); try {
        gl.bindTexture(gl.TEXTURE_2D,tex); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,bitmap);
        applyParams(options);
        if(gl.getError() !== gl.NO_ERROR) throw new Error("이미지 GPU 업로드 실패"); return tex;
      } catch(error) {gl.deleteTexture(tex);throw error;} finally {gl.bindTexture(gl.TEXTURE_2D,old);}
    }; const add = async (file, id, options) => {
      if(disposed) throw new Error("이미 폐기된 Texture 저장소입니다.");
      if(!file || !["image/png","image/jpeg","image/webp"].includes(file.type) || file.size > 12*1024*1024)
      throw new Error("12MB 이하 PNG/JPEG/WebP 파일만 지원합니다.");
      const key = id || `tex${nextId++}`; if(library.has(key)) throw new Error(`이미 등록된 이미지: ${key}`);
      const sampling = normalize(options); const bitmap = await createImageBitmap(file,{imageOrientation:"flipY"}); let tex = null;
      try {
        if(disposed) throw new Error("이미 폐기된 Texture 저장소입니다.");
        if(library.has(key)) throw new Error(`이미 등록된 이미지: ${key}`);
        if(bitmap.width*bitmap.height > 4096*4096) throw new Error("이미지는 최대 약 1,677만 픽셀까지 지원합니다."); tex = upload(bitmap,sampling);
      } catch(error) {bitmap.close();throw error;}
      library.set(key,{id:key,name:file.name || key,width:bitmap.width,height:bitmap.height,bitmap,tex,file,sampling});
      const number = Number(/^tex(\d+)$/.exec(key)?.[1]); if(Number.isSafeInteger(number)) nextId = Math.max(nextId,number+1);
      if(id) return {id:key,saved:true};
      try {await persist(store => store.put({id:key,name:file.name,blob:file,sampling}));return {id:key,saved:true};}
      catch(error) {return {id:key,saved:false,error:error.message};}
    }; const restoreSaved = async () => {
      let records; try {records = await accessDB("readonly",store => store.getAll());} catch(_) {return false;}
      for(const record of records) try {await add(record.blob,record.id,record.sampling);} catch(error) {console.warn("Texture 복원 실패:",record.id,error);}
      return true;
    }; const remove = async id => {
      const entry = library.get(id); if(!entry) return false;
      library.delete(id); if(!lost && entry.tex) gl.deleteTexture(entry.tex);entry.bitmap.close();
      try {await persist(store=>store.delete(id));}catch(error){console.warn("Texture 저장 삭제 실패:",error);}
      return true;
    }; const get = id => library.get(id) || null;
    const list = () => [...library.values()].map(({id,name,width,height,sampling})=>({id,name,width,height,sampling:{...sampling}}));
    const setSampling = async (id, change) => {
      const entry = get(id); if(!entry || lost || !entry.tex) throw new Error("Texture 설정을 변경할 수 없습니다.");
      const next = normalize({...entry.sampling,...change}), old = entry.sampling;
      const bound = gl.getParameter(gl.TEXTURE_BINDING_2D); clearErrors();
      try { gl.bindTexture(gl.TEXTURE_2D,entry.tex); applyParams(next);
        if(gl.getError() !== gl.NO_ERROR) {applyParams(old);throw new Error("Texture 샘플링 적용 실패");}
      } finally {gl.bindTexture(gl.TEXTURE_2D,bound);}
      entry.sampling = next;
      try {await persist(store=>store.put({id,name:entry.name,blob:entry.file,sampling:next}));return {saved:true};}
      catch(error) {return {saved:false,error:error.message};}
    };
    const onLost = (release=false) => {for(const item of library.values()){if(release && !lost && item.tex)gl.deleteTexture(item.tex);item.tex=null;}lost=true;}; const restore = () => {
      if(disposed) throw new Error("이미 폐기된 Texture 저장소입니다.");
      lost=false; const done=[];
      try {for(const item of library.values()){item.tex=upload(item.bitmap,item.sampling);done.push(item);}}
      catch(error){for(const item of done){if(item.tex)gl.deleteTexture(item.tex);item.tex=null;}throw error;}
    };
    const dispose = () => {disposed=true;for(const item of library.values()){if(!lost&&item.tex)gl.deleteTexture(item.tex);item.bitmap.close();}library.clear();};
    return {add,remove,restoreSaved,setSampling,get,list,onLost,restore,dispose};
  }; return {createTextureInput};
})();
const renderer=((PassManager, TextureInput, Diagnostics)=>{
// WebGL 리소스, 애니메이션 루프, 입력 및 컨텍스트 복구를 한곳에서 소유한다.
// 외부에는 createRenderer()로 만든 작은 제어 API만 노출한다.



  // 사용자 Uniform 타입 표. n: 성분 수, kind: f(float) i(int) u(uint) b(bool) m(행렬, column-major), fn: 배열 업로드 함수.
  // 새 타입은 이 표에 추가하면 검증·GLSL 자동 선언·업로드·UI가 함께 따라간다.
  const UNIFORM_TYPES = Object.freeze({
    float:{n:1,kind:"f"}, vec2:{n:2,kind:"f",fn:"uniform2fv"}, vec3:{n:3,kind:"f",fn:"uniform3fv"}, vec4:{n:4,kind:"f",fn:"uniform4fv"},
    int:{n:1,kind:"i"}, ivec2:{n:2,kind:"i",fn:"uniform2iv"}, ivec3:{n:3,kind:"i",fn:"uniform3iv"}, ivec4:{n:4,kind:"i",fn:"uniform4iv"},
    uint:{n:1,kind:"u"}, uvec2:{n:2,kind:"u",fn:"uniform2uiv"}, uvec3:{n:3,kind:"u",fn:"uniform3uiv"}, uvec4:{n:4,kind:"u",fn:"uniform4uiv"},
    bool:{n:1,kind:"b"}, bvec2:{n:2,kind:"b",fn:"uniform2iv"}, bvec3:{n:3,kind:"b",fn:"uniform3iv"}, bvec4:{n:4,kind:"b",fn:"uniform4iv"},
    mat2:{n:4,kind:"m",fn:"uniformMatrix2fv"}, mat3:{n:9,kind:"m",fn:"uniformMatrix3fv"}, mat4:{n:16,kind:"m",fn:"uniformMatrix4fv"}
  });
  // 리플렉션을 사용할 수 없는 환경에서의 내장 Uniform 기본 타입(기존 동작).
  const DEFAULT_BUILTIN_TYPES = Object.freeze({resolution:"vec2",time:"float",delta:"float",frame:"int",mouse:"vec2",debug:"bool",
    maxSteps:"int",maxDistance:"float",surfaceEpsilon:"float",normalEpsilon:"float"});

  const createRenderer = (canvas, sources, onStatus = () => {}) => {
    // 깊이/스텐실/멀티샘플 버퍼 없이 전체 화면 Fragment Shader 하나로 그린다.
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false,
    }); if (!gl) throw new Error("WebGL 2.0을 사용할 수 없습니다.");
    // program/vao/uniforms는 컨텍스트 복구 시 재생성하는 GPU 종속 리소스다.
    const vertexSource = sources.vertex; let fragmentSource = sources.fragment; let program = null, vao = null, uniforms = null;
    // frame: 예약된 requestAnimationFrame ID / frameCount: 실제 그린 프레임 수.
    // time은 화면이 그려지는 동안의 누적 시간(초)이며 일시 정지 중에는 흐르지 않는다.
    let frame = 0, frameCount = 0, lastTime = null, time = 0, lastDelta = 0;
    // FPS는 약 1초 구간의 화면 갱신 횟수다. 정확한 GPU 셰이더 실행 시간은 아니다.
    let resolutionScale = 1, fps = 0, fpsFrames = 0, fpsStart = null; let running = false, lost = false, disposed = false;
    let captureQueue = [], capturePaused = false;
    // 0은 FPS/픽셀 수 제한 없음. 시간 제한은 rAF를 유지하며 실제 드로우만 생략한다.
    let fpsLimit = 0, maxPixels = 0, nextFrameAt = 0, debugHeatmap = false;
    // CPU 쪽에서 소유하는 Ray Marching 설정. GPU에는 매 프레임 Uniform으로 전달한다.
    const raymarchDefaults = Object.freeze({maxSteps:128, maxDistance:100, surfaceEpsilon:0.001, normalEpsilon:0.001});
    let raymarchSettings = {...raymarchDefaults}; const userUniforms = new Map();
    // 마우스는 0~1 상대 좌표로 보관하고 Uniform 전송 시 버퍼 픽셀 좌표로 환산한다.
    // uMouse를 vec4로 선언하면 zw에 클릭 위치를 전달한다: z>0 버튼 누름 중, w>0 누른 직후 첫 프레임.
    const mouse = [-1, -1], click = [0, 0]; let mouseDown = false, clickPending = false;
    // 성능 지표: cpuMs는 프레임당 GL 명령 제출 시간(JS), frameMs는 rAF 간격, GPU 시간은 gpuTimer가 측정한다.
    const clock = typeof performance === "object" && typeof performance.now === "function" ? () => performance.now() : () => Date.now();
    let cpuMs = 0, frameMs = 0; const gpuTimer = Diagnostics.createGpuTimer(gl);
    const createShader = (type, source) => {
      const shader = gl.createShader(type); if (!shader) throw new Error("Shader 생성 실패"); gl.shaderSource(shader, source);
      gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader), typeName = type === gl.VERTEX_SHADER ? "Vertex" : "Fragment";
        const numbered = source.split("\n").map((line,i) => `${String(i+1).padStart(3)} | ${line}`).join("\n");
        gl.deleteShader(shader); throw new Error(`${typeName} Shader 컴파일 실패:\n${error || "로그 없음"}\n\n${numbered}`);
      }
      return shader;
    };
    // Vertex/Fragment를 연결한 GPU 프로그램을 새로 만든다.
    const createProgram = (fragment) => {
      let vs = null, fs = null, result = null;
      try {
        vs = createShader(gl.VERTEX_SHADER, vertexSource); fs = createShader(gl.FRAGMENT_SHADER, fragment);
        result = gl.createProgram(); if (!result) throw new Error("Program 생성 실패"); gl.attachShader(result, vs);
        gl.attachShader(result, fs); gl.linkProgram(result);
        if(!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result) || "Program 링크 실패");
        return result;
      } catch (error) {
        if (result) gl.deleteProgram(result); throw error;
      } finally {
        if (vs) gl.deleteShader(vs); if (fs) gl.deleteShader(fs);
      }
    }; const textureInput = TextureInput.createTextureInput(gl);
    const passManager = PassManager.createPassManager(gl, source => compileFragment(source), textureInput);
    // 다음 프레임 예약을 취소한다. lastTime을 지워 재시작 첫 delta를 0으로 만든다.
    const cancelFrame = () => {
      if (frame) cancelAnimationFrame(frame); frame = 0; lastTime = fpsStart = null; fps = fpsFrames = 0; nextFrameAt = 0;
    };
    // CSS 표시 크기와 GPU의 실제 Drawing Buffer 크기를 분리한다.
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2) * resolutionScale; let width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      let height = Math.max(1, Math.round(canvas.clientHeight * dpr)); if(maxPixels && width * height > maxPixels) {
        const factor = Math.sqrt(maxPixels / (width * height)); width = Math.max(1, Math.floor(width * factor));
        height = Math.max(1, Math.floor(height * factor));
      }
      if(canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height;
      }
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }; const uniformSpec = type => Object.hasOwn(UNIFORM_TYPES, type) ? UNIFORM_TYPES[type] : null;
    const normalizeUniform = (type, value) => {
      const spec = uniformSpec(type), valid = v => !spec ? false : spec.kind === "b" ? typeof v === "boolean" :
        typeof v === "number" && Number.isFinite(v) && (spec.kind === "i" ? Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 :
        spec.kind === "u" ? Number.isInteger(v) && v >= 0 && v <= 4294967295 : true);
      if(spec?.n === 1 && valid(value)) return value;
      if(spec?.n > 1 && (Array.isArray(value) || ArrayBuffer.isView(value))) {
        const array = Array.from(value); if(array.length === spec.n && array.every(valid)) return array;
      }
      throw new TypeError(`Uniform 타입(${type})에 맞지 않는 값입니다.`);
    };
    // 벡터/행렬은 등록·변경 시점에 Typed Array로 한 번 변환해 두어 매 프레임 할당 없이 업로드한다.
    const makeData = (type, value) => {
      const spec = UNIFORM_TYPES[type]; if(spec.n === 1) return null;
      return spec.kind === "u" ? new Uint32Array(spec.n) : spec.kind === "i" || spec.kind === "b" ? new Int32Array(spec.n) : new Float32Array(spec.n);
    }; const writeData = item => {
      if(!item.data) return item; const bool = UNIFORM_TYPES[item.type].kind === "b";
      for(let i = 0; i < item.data.length; i++) item.data[i] = bool ? (item.value[i] ? 1 : 0) : item.value[i];
      return item;
    }; const uploadCustomUniforms = (target) => {
      if(!target.custom) target.custom = new Map(); for(const [name, item] of userUniforms) {
        if(!target.custom.has(name)) target.custom.set(name, gl.getUniformLocation(target.program,name));
        const location = target.custom.get(name); if(location === null || location === undefined) continue;
        const spec = UNIFORM_TYPES[item.type], v = item.value;
        if(spec.n === 1) {
          if(spec.kind === "f") gl.uniform1f(location, v); else if(spec.kind === "u") gl.uniform1ui(location, v);
          else gl.uniform1i(location, spec.kind === "b" ? (v ? 1 : 0) : v);
        } else if(spec.kind === "m") gl[spec.fn](location, false, item.data);
        else gl[spec.fn](location, item.data);
      }
    };
    // Image와 Buffer 패스가 공유하는 시간/입력/엔진 설정 업로드.
    // Fragment Shader에서 미사용한 Uniform은 Location이 null이므로 건너뛴다.
    // 선언 타입(리플렉션)에 맞는 함수로 전송하며, 허용되지 않는 타입은 makeLocations에서 이미 제외됐다.
    const uploadGlobals = (target, width, height) => {
      const types = target.types || DEFAULT_BUILTIN_TYPES;
      if(target.resolution != null) {
        if(types.resolution === "vec3") gl.uniform3f(target.resolution,width,height,1); else gl.uniform2f(target.resolution,width,height);
      }
      if(target.time != null) gl.uniform1f(target.time,time); if(target.delta != null) gl.uniform1f(target.delta,lastDelta);
      if(target.frame != null) {
        if(types.frame === "float") gl.uniform1f(target.frame,frameCount); else if(types.frame === "uint") gl.uniform1ui(target.frame,frameCount);
        else gl.uniform1i(target.frame,frameCount);
      }
      if(target.mouse != null) {
        const x = mouse[0]<0?-1:mouse[0]*width, y = mouse[1]<0?-1:mouse[1]*height;
        if(types.mouse === "vec4") {
          const cx = click[0]*width, cy = click[1]*height; gl.uniform4f(target.mouse,x,y,mouseDown?cx:-cx,clickPending?cy:-cy);
        } else gl.uniform2f(target.mouse,x,y);
      }
      if(target.debug != null) gl.uniform1i(target.debug,debugHeatmap?1:0);
      if(target.maxSteps != null) {
        if(types.maxSteps === "float") gl.uniform1f(target.maxSteps,raymarchSettings.maxSteps); else gl.uniform1i(target.maxSteps,raymarchSettings.maxSteps);
      }
      if(target.maxDistance != null) gl.uniform1f(target.maxDistance,raymarchSettings.maxDistance);
      if(target.surfaceEpsilon != null) gl.uniform1f(target.surfaceEpsilon,raymarchSettings.surfaceEpsilon);
      if(target.normalEpsilon != null) gl.uniform1f(target.normalEpsilon,raymarchSettings.normalEpsilon); uploadCustomUniforms(target);
    }; const buildFragment = source => {
      if(typeof source !== "string") throw new TypeError("Fragment Shader는 문자열이어야 합니다.");
      const declarations=[], code=source.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*/g,s=>s.replace(/[^\r\n]/g," "));
      const uniforms=[...code.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+([^;{}]+);/g)];
      for(const [name,item] of userUniforms) {
        const match=uniforms.find(m=>m[2].split(",").some(part=>part.trim().match(/^[A-Za-z_]\w*/)?.[0]===name));
        if(match) {
          const part=match[2].split(",").find(part=>part.trim().match(/^[A-Za-z_]\w*/)?.[0]===name);
          if(match[1]!==item.type || part.includes("[")) throw new Error(`${name}: GLSL 선언(${match[1]})과 등록 타입(${item.type})이 다릅니다.`);
        } else declarations.push(`uniform ${item.type} ${name};`);
      }
      if(!declarations.length) return {source};
      const marker=/\bprecision\s+(?:lowp|mediump|highp)\s+float\s*;/.exec(code);
      if(!source.startsWith("#version 300 es") || !marker) throw new Error("사용자 Uniform을 추가하려면 GLSL ES 3.00과 float precision 선언이 필요합니다.");
      const end=marker.index+marker[0].length, tail=source.slice(end), extra=/^[^\r\n]*\S/.test(tail.split(/\r?\n/)[0])?"\n":"";
      return {source:source.slice(0,end)+"\n"+declarations.join("\n")+extra+tail,
        injected:{after:source.slice(0,end).split("\n").length,count:declarations.length+extra.length,generated:declarations.length}};
    };
    // 삽입 위치와 진단 보정은 같은 결과를 사용한다. 한 줄 GLSL도 원본 줄을 보존한다.
    const compileFragment = source => {
      const compiled=buildFragment(source);
      try {return createProgram(compiled.source);}catch(error) {
        if(compiled.injected && error.message?.startsWith("Fragment Shader 컴파일 실패:")) error.glslInjected=compiled.injected;
        throw error;
      }
    };
    // requestAnimationFrame 시간값(now)은 밀리초. 셰이더에는 초 단위로 전달한다.
    // 표시하지 않는 탭/손실된 컨텍스트에서는 GPU 호출을 하지 않는다.
    const render = (now) => {
      frame = 0; if (!running || lost || disposed || document.hidden || !program)
      return;
      if(fpsLimit > 0 && nextFrameAt && now + 0.5 < nextFrameAt) {
        scheduleFrame(); return;
      }
      if(fpsLimit > 0) {
        const interval = 1000 / fpsLimit; nextFrameAt = nextFrameAt ? nextFrameAt+Math.max(1,Math.floor((now-nextFrameAt)/interval)+1)*interval : now+interval;
      }
      resize(); const delta = lastTime === null ? 0 : Math.max(0, (now - lastTime) * 0.001); lastTime = now; time += delta;
      const cpuStart = clock(); try {
        if(passManager.ensureTargets(gl.drawingBufferWidth,gl.drawingBufferHeight)) frameCount = 0; lastDelta = delta; gl.bindVertexArray(vao);
        passManager.drawPasses(gl.drawingBufferWidth,gl.drawingBufferHeight,uploadGlobals,gpuTimer);
        gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
        gpuTimer.begin(passManager.getPreview() ? "Preview" : "Image");
        try {
          if(!passManager.drawPreview(gl.drawingBufferWidth,gl.drawingBufferHeight)) {
            gl.useProgram(program); uploadGlobals(uniforms,gl.drawingBufferWidth,gl.drawingBufferHeight);
            passManager.bindImage(uniforms); gl.drawArrays(gl.TRIANGLES,0,3); passManager.unbindImage();
          }
        } finally { gpuTimer.end(); }
        gpuTimer.endFrame(); clickPending = false;
        const cpu = clock() - cpuStart; cpuMs = cpuMs ? cpuMs * 0.9 + cpu * 0.1 : cpu;
        if(delta > 0) frameMs = frameMs ? frameMs * 0.9 + delta * 100 : delta * 1000;
      } catch(error) {
        const pending = captureQueue.splice(0); pending.forEach(({reject}) => reject(error)); capturePaused = false;
        console.error(error); onStatus(`Buffer 렌더링 실패: ${error.message}`);
        stop(); return;
      }
      if(captureQueue.length) {
        const pending = captureQueue.splice(0);
        try {
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, pixels = new Uint8Array(w*h*4);
          Diagnostics.clearErrors(gl); gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
          const error = gl.getError(); if(error !== gl.NO_ERROR) throw new Error(`Screenshot readPixels 오류: ${error}`);
          const flipped = new Uint8ClampedArray(pixels.length), stride = w*4;
          for(let y=0;y<h;y++) flipped.set(pixels.subarray(y*stride,(y+1)*stride),(h-1-y)*stride);
          const output = document.createElement("canvas"); output.width=w; output.height=h;
          const context = output.getContext("2d"); if(!context) throw new Error("2D Canvas를 사용할 수 없습니다.");
          context.putImageData(new ImageData(flipped,w,h),0,0);
          output.toBlob(blob => pending.forEach(({resolve,reject}) => blob ? resolve(blob) : reject(new Error("PNG 생성 실패"))),"image/png");
        } catch(error) { pending.forEach(({reject}) => reject(error)); }
      }
      frameCount++;
      // 지나간 약 1초 동안의 실제 렌더링 프레임 수로 FPS를 추정한다.
      if (fpsStart === null) fpsStart = now;
      fpsFrames++; if (now - fpsStart >= 1000) {
        fps = (fpsFrames * 1000) / (now - fpsStart); fpsFrames = 0; fpsStart = now;
      }
      if(capturePaused) { capturePaused = false; stop(); } else scheduleFrame();
    }; const scheduleFrame = () => {
      if (
      running && !lost && !disposed && !document.hidden && program && !frame
      )
      frame = requestAnimationFrame(render);
    }; const replacePrograms = (source, updatePasses = () => {}) => {
      if (disposed) throw new Error("이미 폐기된 Renderer입니다."); if (lost) throw new Error("WebGL 컨텍스트 복구 대기 중입니다.");
      if (typeof source !== "string") throw new TypeError("Fragment Shader는 문자열이어야 합니다.");
      const next = compileFragment(source); let nextUniforms;
      try {nextUniforms=PassManager.makeLocations(gl,next);}catch(error){gl.deleteProgram(next);throw error;}
      if (!vao) {
        vao = gl.createVertexArray(); if (!vao) {
          gl.deleteProgram(next); throw new Error("VAO 생성 실패");
        }
      }
      try {updatePasses();} catch(error) {gl.deleteProgram(next);throw error;}
      const previous = program; program = next;
      uniforms = nextUniforms; fragmentSource = source; if (previous) gl.deleteProgram(previous);
      // 셰이더가 바뀌면 누적 프레임을 리셋한다. 시간(time)은 이어서 진행한다.
      if(passManager.getPasses().length === 0) frameCount = 0;
      lastTime = fpsStart = null; fps = fpsFrames = 0; onStatus(mismatchMessage()); scheduleFrame(); return true;
    }; const setFragment = source => replacePrograms(source);
    // 내장 Uniform을 지원하지 않는 타입으로 선언한 경우(예: uniform vec3 uTime) 값 전달을 생략하고 알린다.
    const mismatchMessage = () => {
      const items = (uniforms?.mismatches || []).map(m => `Image.${m.name}(${m.declared})`);
      for(const pass of passManager.getReflection()) for(const m of pass.ignored) items.push(`${pass.name}.${m.name}(${m.declared})`);
      return items.length ? `내장 Uniform 타입 불일치로 값 전달 생략: ${items.join(", ")} · getShaderReflection()에서 허용 타입 확인` : "";
    }; const reportMismatches = () => { const message = mismatchMessage(); if(message) onStatus(message); };
    const validateFragment = source => {
      if(disposed || lost) throw new Error("셰이더를 검사할 수 없는 상태입니다.");
      const candidate = compileFragment(source); gl.deleteProgram(candidate); return true;
    }; const captureScreenshot = () => new Promise((resolve,reject) => {
      if(disposed || lost || document.hidden || !program) return reject(new Error("현재 화면을 캡처할 수 없습니다."));
      captureQueue.push({resolve,reject}); if(!running) {capturePaused=true;running=true;}
      nextFrameAt = 0; scheduleFrame();
    }); const resetSimulation = () => {
      if(disposed || lost) throw new Error("시뮬레이션을 초기화할 수 없습니다.");
      passManager.resetTargets(); frameCount = 0; time = lastDelta = 0; lastTime = null; nextFrameAt = 0; scheduleFrame();
    };
    // 시작은 비동기 프레임 예약이다. 여러 번 호출해도 중복 렌더링 루프를 만들지 않는다.
    const start = () => {
      if (disposed) throw new Error("이미 폐기된 Renderer입니다.");if(lost && !gl.isContextLost?.())onContextRestored();
      capturePaused=false;running = true; scheduleFrame();
    };
    // stop()은 컨텍스트를 폐기하지 않는다. start()를 다시 호출할 수 있다.
    const stop = () => {
      running = false; cancelFrame();
      captureQueue.splice(0).forEach(({reject}) => reject(new Error("렌더링 중단으로 캡처가 취소되었습니다.")));
      capturePaused = false;
    }; const onPointerMove = (event) => {
      const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return; mouse[0] = Math.max(
      0, Math.min(1, (event.clientX - rect.left) / rect.width),
      ); mouse[1] = Math.max(
      0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height),
      );
    }; const onPointerDown = event => {
      if(event.button !== 0) return; onPointerMove(event); if(mouse[0] < 0) return;
      click[0] = mouse[0]; click[1] = mouse[1]; mouseDown = clickPending = true;
    }; const onPointerUp = () => { mouseDown = false; };
    const onPointerLeave = () => {
      // 드래그 중(포인터 캡처)에는 캔버스 밖으로 나가도 위치를 유지한다.
      if(mouseDown) return; mouse[0] = mouse[1] = -1;
    }; const onVisibilityChange = () => {
      if (document.hidden) {cancelFrame();if(capturePaused)running=false; captureQueue.splice(0).forEach(({reject}) => reject(new Error("탭이 숨겨져 캡처를 취소했습니다.")));capturePaused=false;}
      else scheduleFrame();
    };
    // 브라우저/GPU가 자원을 잃은 상황. preventDefault()로 복구 허용을 요청한다.
    // 이전 GPU 핸들은 더 이상 유효하지 않으므로 참조만 버리고 복구 이벤트를 기다린다.
    const onContextLost = (event) => {
      event.preventDefault(); if (disposed) return;if(capturePaused)running=false; lost = true; cancelFrame();
      captureQueue.splice(0).forEach(({reject}) => reject(new Error("WebGL 컨텍스트가 손실되었습니다."))); capturePaused = false;
      program = vao = uniforms = null; passManager.onLost(); textureInput.onLost(); gpuTimer.onLost(); capabilities = null; onStatus("WebGL 컨텍스트 손실: 복구 대기 중");
    };
    // 복구된 같은 WebGL 컨텍스트에 Program과 VAO를 새로 만들고 Uniform도 재조회한다.
    // 확장 객체(타이머 등)는 컨텍스트 손실 후 무효이므로 다시 요청한다.
    const onContextRestored = () => {
      if (disposed) return; lost = false; try {
        gpuTimer.restore(); textureInput.restore(); setFragment(fragmentSource); passManager.restore(); reportMismatches();
      } catch (error) {
        if(program)gl.deleteProgram(program);if(vao)gl.deleteVertexArray(vao);program=vao=uniforms=null;
        passManager.onLost(true);textureInput.onLost(true);lost=true;cancelFrame();console.error(error);
        onStatus(`WebGL 복구 실패: ${error.message} · Play로 재시도할 수 있습니다.`);
      }
    }; const dispose = () => {
      if (disposed) return; stop(); disposed = true; captureQueue.splice(0).forEach(({reject}) => reject(new Error("Renderer가 종료되었습니다.")));
      canvas.removeEventListener("pointermove", onPointerMove); canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointerdown", onPointerDown); canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp); gpuTimer.dispose();
      canvas.removeEventListener("webglcontextlost", onContextLost); canvas.removeEventListener(
      "webglcontextrestored", onContextRestored,
      ); document.removeEventListener(
      "visibilitychange", onVisibilityChange,
      ); if (!lost) {
        passManager.dispose(); textureInput.dispose(); if (program) gl.deleteProgram(program); if (vao) gl.deleteVertexArray(vao);
      }
      if(lost) textureInput.dispose(); program = vao = uniforms = null;
    }; canvas.addEventListener("pointermove", onPointerMove); canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("pointerdown", onPointerDown); canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("webglcontextlost", onContextLost); canvas.addEventListener("webglcontextrestored", onContextRestored);
    document.addEventListener("visibilitychange", onVisibilityChange);
    try {
      setFragment(fragmentSource); passManager.setPasses(sources.passes || [],sources.imageChannels || {});
    } catch (error) {
      dispose(); throw error;
    }
    const setResolutionScale = (value) => {
      if (disposed) throw new Error("이미 폐기된 Renderer입니다."); if (!Number.isFinite(value) || value < 0.25 || value > 1)
      throw new RangeError(
      "resolutionScale은 0.25부터 1 사이여야 합니다.",
      );
      resolutionScale = value; return resolutionScale;
    }; const setFpsLimit = value => {
      if(disposed) throw new Error("이미 폐기된 Renderer입니다.");
      if(!Number.isInteger(value) || value < 0 || value > 240) throw new RangeError("FPS 제한은 0~240 정수(0=무제한)여야 합니다.");
      fpsLimit = value; nextFrameAt = 0; return fpsLimit;
    }; const setMaxPixels = value => {
      if(disposed) throw new Error("이미 폐기된 Renderer입니다.");
      if(!Number.isSafeInteger(value) || value < 0) throw new RangeError("최대 픽셀 수는 0 이상의 정수여야 합니다."); maxPixels = value; return maxPixels;
    }; const setDebugHeatmap = value => {
      if(disposed) throw new Error("이미 폐기된 Renderer입니다."); if(typeof value !== "boolean") throw new TypeError("히트맵 값은 boolean이어야 합니다.");
      if(debugHeatmap !== value) { debugHeatmap = value; frameCount = 0; }
      return debugHeatmap;
    }; const setRaymarchSettings = changes => {
      if(disposed) throw new Error("이미 폐기된 Renderer입니다.");
      if(!changes || typeof changes !== "object" || Array.isArray(changes)) throw new TypeError("설정은 객체여야 합니다.");
      const limits = {maxSteps:[1, 512], maxDistance:[0.01, 10000], surfaceEpsilon:[0.000001, 0.1], normalEpsilon:[0.000001, 0.1]};
      for(const [key, value] of Object.entries(changes)) {
                if(!Object.prototype.hasOwnProperty.call(limits, key)) throw new Error(`알 수 없는 Ray Marching 설정: ${key}`);
        const [min, max] = limits[key];
        if(typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (key === "maxSteps" && !Number.isInteger(value)))
                    throw new RangeError(`${key}은 ${min}~${max} 범위${key === "maxSteps" ? "의 정수" : "의 숫자"}여야 합니다.`);
      }
      if(Object.keys(changes).some(key => raymarchSettings[key] !== changes[key])) frameCount = 0;
      raymarchSettings = {...raymarchSettings, ...changes}; return getRaymarchSettings();
    }; const getRaymarchSettings = () => ({...raymarchSettings});
    const reservedUniforms = new Set(["uResolution", "uTime", "uDeltaTime", "uFrame", "uMouse", "uDebugRaySteps", "uMaxSteps", "uMaxDistance", "uSurfaceEpsilon", "uNormalEpsilon", "iChannel0", "iChannel1", "iChannel2", "iChannel3", "iChannelResolution"]);
    const normalizeEntry = (name,type,value,options={}) => {
      if(typeof name!=="string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith("gl_") || name.includes("__") || reservedUniforms.has(name))
        throw new Error("Uniform 이름이 올바르지 않거나 렌더러 전용 이름입니다.");
      if(!options || typeof options!=="object" || Array.isArray(options)) throw new Error("Uniform 슬라이더 설정이 올바르지 않습니다.");
      // 범위(min/max/step)는 float·int·uint 스칼라와 벡터(성분마다 같은 범위)에, color는 vec3/vec4에만 허용한다.
      const normalized=normalizeUniform(type,value), {min,max,step,color}=options, spec=UNIFORM_TYPES[type];
      const ranged=spec.kind==="f"||spec.kind==="i"||spec.kind==="u", integer=spec.kind==="i"||spec.kind==="u";
      if([min,max,step].some(x=>x!==undefined) && (!ranged || ![min,max,step].every(Number.isFinite) || !(min<max && step>0) || (integer && ![min,max,step].every(Number.isInteger)) || (spec.kind==="u" && min<0)))
        throw new Error("Uniform 슬라이더 범위가 올바르지 않습니다.");
      if(color!==undefined && (color!==true || !["vec3","vec4"].includes(type))) throw new Error("color 표시는 vec3/vec4에만 사용할 수 있습니다.");
      const nextOptions=min===undefined?{}:{min,max,step}; if(color)nextOptions.color=true;
      return writeData({type,value:normalized,data:makeData(type,normalized),options:nextOptions});
    };
    const defineUniform = (name, type, value, options = {}) => {
      if(disposed || lost) throw new Error("현재 Uniform을 등록할 수 없습니다.");
      if(userUniforms.has(name)) throw new Error(`${name}은 이미 등록됐습니다.`);
      if(userUniforms.size>=64) throw new Error("사용자 Uniform은 최대 64개입니다.");
      userUniforms.set(name,normalizeEntry(name,type,value,options));
      try { replacePrograms(fragmentSource,passManager.refreshPrograms); }
      catch(error) { userUniforms.delete(name); throw error; }
      return true;
    };
    const setUniform = (name, value) => {
      if(disposed) throw new Error("이미 폐기된 Renderer입니다."); const item = userUniforms.get(name);
            if(!item) throw new Error(`등록되지 않은 Uniform: ${name}`);
      item.value = normalizeUniform(item.type, value); writeData(item); return true;
    }; const removeUniform = name => {
      if(disposed || lost) throw new Error("현재 Uniform을 제거할 수 없습니다.");
      const item = userUniforms.get(name); if(!item) return false; userUniforms.delete(name);
      try { replacePrograms(fragmentSource,passManager.refreshPrograms); }
      catch(error) { userUniforms.set(name, item); throw error; }
      return true;
    }; const getUserUniforms = () => [...userUniforms].map(([name, item]) => ({
      name, type:item.type, value:Array.isArray(item.value) ? [...item.value] : item.value, options:{...item.options}
    })); const getUniforms = getUserUniforms;
    // Pack 복원: 사용자 Uniform을 새 GLSL과 함께 사전 컴파일하고, 통과한 경우에만 교체한다.
    const prepareUsers = items => {
      if(!Array.isArray(items) || items.length > 64) throw new Error("사용자 Uniform은 최대 64개입니다.");
      const next = new Map(); for(const item of items) {
        if(!item || next.has(item.name)) throw new Error("Pack 사용자 Uniform 이름이 올바르지 않습니다.");
        next.set(item.name,normalizeEntry(item.name,item.type,item.value,item.options===undefined?{}:item.options));
      } return next;
    }; const swapUsers = next => {userUniforms.clear();for(const [name,item] of next)userUniforms.set(name,item);};
    const setUserUniforms = items => {
      if(disposed || lost)throw new Error("현재 Uniform을 교체할 수 없습니다.");
      const next=prepareUsers(items),old=new Map(userUniforms);
      try {swapUsers(next);replacePrograms(fragmentSource,passManager.refreshPrograms);return true;}
      catch(error){swapUsers(old);throw error;}
    };
    const validatePortable = (scene,items) => {
      if(disposed || lost) throw new Error("Pack을 적용할 수 없는 Renderer 상태입니다.");
      const next = prepareUsers(items), old = new Map(userUniforms);
      passManager.validateConfiguration(scene.passes,scene.imageChannels);
      try {swapUsers(next);for(const source of [scene.image,...scene.passes.map(p=>p.fragment)]) {
        const candidate=compileFragment(source);gl.deleteProgram(candidate);
      }} finally {swapUsers(old);} return true;
    }; const applyPortable = (scene,items) => {
      if(disposed || lost) throw new Error("Pack을 적용할 수 없는 Renderer 상태입니다.");
      const next=prepareUsers(items), old=new Map(userUniforms);
      try {swapUsers(next);replacePrograms(scene.image,()=>passManager.setPasses(scene.passes,scene.imageChannels));frameCount=0;return true;}
      catch(error) {swapUsers(old);throw error;}
    };
    const applyProject = scene => {
      if(disposed || lost) throw new Error("현재 프로젝트를 적용할 수 없습니다.");
      const imageChanged=scene.image!==fragmentSource;let result;
      const update=()=>{result=passManager.updatePasses(scene.passes,scene.imageChannels);};
      try {if(imageChanged)replacePrograms(scene.image,update);else update();}
      catch(error) {if(imageChanged)error.passName??="Image";throw error;}
      if(result.structural)frameCount=0;if(!imageChanged)reportMismatches();return imageChanged||result.changed;
    };
    const validatePassConfiguration = (passes, imageChannels = {}) => passManager.validateConfiguration(passes,imageChannels);
    const setPasses = (passes, imageChannels = {}) => {
      if(disposed || lost) throw new Error("현재 Buffer를 구성할 수 없습니다."); passManager.setPasses(passes,imageChannels); frameCount = 0; reportMismatches();
    }; const setPassFragment = (name, source) => {
      if(disposed || lost) throw new Error("현재 Buffer 소스를 변경할 수 없습니다."); passManager.setPassFragment(name,source); reportMismatches();
    }; const setPassChannels = (name, channels) => {
      if(disposed || lost) throw new Error("현재 Buffer 채널을 변경할 수 없습니다."); passManager.setPassChannels(name,channels);
    }; const setImageChannels = channels => {
      if(disposed || lost) throw new Error("현재 Image 채널을 변경할 수 없습니다."); passManager.setImageChannels(channels);
    }; const setPreviewPass = (name, attachment = 0) => {
      if(disposed || lost) throw new Error("현재 미리보기를 변경할 수 없습니다."); passManager.setPreview(name, attachment); scheduleFrame();
    }; const setPreviewOptions = options => {
      if(disposed) throw new Error("이미 폐기된 Renderer입니다."); const result = passManager.setPreviewOptions(options); scheduleFrame(); return result;
    }; const readPassPixel = (name,x,y,attachment=0) => {
      if(disposed || lost) throw new Error("현재 픽셀을 읽을 수 없습니다."); return passManager.readPixel(name,x,y,attachment);
    };
    // 버퍼 디버그 썸네일. 각 패스 출력의 최신 결과를 축소해 ImageData로 돌려준다(위쪽이 화면 위).
    // GPU→CPU 동기 읽기이므로 UI는 보이는 동안 초당 몇 번만 호출한다.
    const captureBufferThumbnails = (maxWidth = 160) => {
      if(disposed || lost || !vao) return [];
      gl.bindVertexArray(vao); const shots = passManager.captureThumbnails(maxWidth);
      gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
      return shots.map(({pixels, width, height, ...meta}) => {
        const flipped = new Uint8ClampedArray(pixels.length), stride = width*4;
        for(let y=0;y<height;y++) flipped.set(pixels.subarray(y*stride,(y+1)*stride),(height-1-y)*stride);
        return {...meta, width, height, image:new ImageData(flipped,width,height)};
      });
    }; const addTexture = (file,sampling) => {if(disposed || lost) throw new Error("Texture를 추가할 수 없습니다.");return textureInput.add(file,undefined,sampling);};
    const removeTexture = async id => {
      if(disposed) throw new Error("Texture를 삭제할 수 없습니다."); passManager.detachTexture(id);return textureInput.remove(id);
    }; const restoreTextures = () => textureInput.restoreSaved(); const getTextures = () => textureInput.list();
    const setTextureSampling = (id,options) => {
      if(disposed || lost) throw new Error("현재 Texture 설정을 바꿀 수 없습니다.");
      return textureInput.setSampling(id,options);
    }; const getStats = () => ({
      fps: Math.round(fps * 10) / 10, frame:frameCount, width:gl.drawingBufferWidth, height:gl.drawingBufferHeight,
      resolutionScale, fpsLimit, maxPixels, debugHeatmap, running:running && !lost && !document.hidden,
      previewPass:passManager.getPreview(), previewAttachment:passManager.getPreviewAttachment(), previewOptions:passManager.getPreviewOptions(),
      bufferMemoryBytes:passManager.getMemoryBytes(),
      cpuMs:Math.round(cpuMs * 100) / 100, frameMs:Math.round(frameMs * 100) / 100, gpu:gpuTimer.getResults()
    });
    // 디버그 도구용: 지원 Uniform 타입, 프로그램별 활성 Uniform/무시된 내장 Uniform, GPU 타이머 On/Off.
    const getUniformTypes = () => Object.entries(UNIFORM_TYPES).map(([type, spec]) => ({type, components:spec.n, kind:spec.kind}));
    // 각 활성 Uniform에 출처를 붙인다: builtin(렌더러 제공) · user(등록된 파라미터) · unregistered(선언만 됨, 값 0).
    const classify = report => {
      if(!report?.uniforms) return report;
      for(const item of report.uniforms) item.source = reservedUniforms.has(item.name) ? "builtin" : userUniforms.has(item.name) ? "user" : "unregistered";
      return report;
    };
    const getShaderReflection = () => ({image:classify(Diagnostics.describeLocations(uniforms)), passes:passManager.getReflection().map(classify)});
    // GPU/브라우저 기능 요약. 컨텍스트 손실 후에는 다시 조회한다.
    let capabilities = null; const getCapabilities = () => {
      if(lost || disposed) return null; if(capabilities) return {...capabilities, extensions:{...capabilities.extensions}};
      const info = gl.getExtension("WEBGL_debug_renderer_info"), names = ["EXT_color_buffer_float","EXT_color_buffer_half_float","OES_texture_float_linear",
        "EXT_disjoint_timer_query_webgl2","KHR_parallel_shader_compile","WEBGL_lose_context","EXT_texture_filter_anisotropic"];
      const supported = new Set(gl.getSupportedExtensions?.() || []);
      capabilities = {vendor:info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer:info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        version:gl.getParameter(gl.VERSION), glsl:gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE), maxRenderbufferSize:gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
        maxTextureUnits:gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), maxDrawBuffers:gl.getParameter(gl.MAX_DRAW_BUFFERS),
        maxFragmentUniformVectors:gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
        extensions:Object.fromEntries(names.map(name => [name, supported.has(name)]))};
      return getCapabilities();
    };
    const setGpuTiming = value => { if(disposed) throw new Error("이미 폐기된 Renderer입니다."); return gpuTimer.setEnabled(value); };
    return {start, stop, resetSimulation, captureScreenshot, validateFragment, validatePassConfiguration, setFragment, setResolutionScale, setMaxPixels, setFpsLimit,
      setDebugHeatmap, setRaymarchSettings, getRaymarchSettings, defineUniform, setUniform, removeUniform,
      getUserUniforms, getUniforms, getUniformTypes, getShaderReflection, getCapabilities, setGpuTiming, getStats, validatePortable, applyPortable, applyProject, setUserUniforms, validateUniformValue:normalizeUniform,
      setPasses, setPassFragment, setPassChannels, setImageChannels, setPreviewPass, setPreviewOptions, readPassPixel, captureBufferThumbnails,
      addTexture, removeTexture, restoreTextures, getTextures, getTextureFile:id=>textureInput.get(id)?.file || null, setTextureSampling, getPasses:passManager.getPasses, getPassDefinitions:passManager.getSpecs,
      getFragmentSource:() => fragmentSource, getImageChannels:passManager.getImageChannels, dispose};
  }; return {createRenderer};
})(pass_manager, texture_input, gpu_diagnostics);
const shader=(()=>{
// Shader Studio의 시작 화면에 사용할 기본 예제. 모든 GLSL을 한 곳에서 관리한다.
  const vertex = `#version 300 es

void main() {
    // VBO 없이 세 정점으로 화면 전체를 덮는 Fullscreen Triangle.
    vec2 position = vec2(
        gl_VertexID == 1 ? 3.0 : -1.0,
        gl_VertexID == 2 ? 3.0 : -1.0
    );
    gl_Position = vec4(position, 0.0, 1.0);
}`;
  const raymarch = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uDeltaTime;
uniform int uFrame;
uniform vec2 uMouse;
uniform bool uDebugRaySteps;
// Buffer/Image 패스에서 동일하게 사용하는 입력 채널(최대 4개).
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform vec3 iChannelResolution[4];

out vec4 fragColor;

// 고정 반복 상한: WebGL2 루프 최적화를 위한 안전 장치. 실제 반복 수는 uMaxSteps로 제한한다.
const int MAX_STEPS_CAP = 512;
uniform int uMaxSteps;
uniform float uMaxDistance;
uniform float uSurfaceEpsilon;
uniform float uNormalEpsilon;

// 재질 ID와 거리를 분리해 두면 장면이 커져도 raymarch 코드는 바꾸지 않아도 된다.
struct SDFResult {
    float dist;
    float id;
};

// --- SDF 도형 ---

// p는 도형 중심 기준의 로컬 좌표다.
float sdSphere(vec3 p, float radius) {
    return length(p) - radius;
}

// b: 직육면체의 반쪽 크기(half extents).
float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}


// --- 기본 장면 ---

SDFResult map(vec3 p) {
    // 구는 중심 (0,0,0), 반지름 1. 바닥은 y = -1 평면.
    float sphere = sdSphere(p, 1.0);
    float ground = p.y + 1.0;
    if(sphere < ground) return SDFResult(sphere, 2.0);
    return SDFResult(ground, 1.0);
}

vec3 getAlbedo(float id) {
    if(id == 2.0) return vec3(0.25, 0.57, 0.90);
    return vec3(0.43, 0.46, 0.51);
}


// --- Ray Marching ---

// rd는 정규화된 광선 방향. (t, id)를 반환하며 미스 시 (-1,-1).
vec2 rayMarch(vec3 ro, vec3 rd, out int steps, out bool limitReached) {
    float t = 0.0;
    steps = 0;
    limitReached = false;

    for(int i = 0; i < MAX_STEPS_CAP; i++) {
        if(i >= uMaxSteps) break;
        SDFResult result = map(ro + rd * t);
        steps = i + 1;
        if(result.dist < uSurfaceEpsilon) return vec2(t, result.id);
        t += result.dist;
        if(t > uMaxDistance) return vec2(-1.0);
    }

    limitReached = true;
    return vec2(-1.0);
}

// 정사면체 방향 4회 샘플링으로 표면 기울기(법선)를 근사한다.
vec3 calcNormal(vec3 p) {
    float h = uNormalEpsilon;
    const vec2 k = vec2(1.0, -1.0);
    return normalize(
        k.xyy * map(p + k.xyy * h).dist +
        k.yyx * map(p + k.yyx * h).dist +
        k.yxy * map(p + k.yxy * h).dist +
        k.xxx * map(p + k.xxx * h).dist
    );
}


// --- 카메라와 화면 출력 ---

// 이 프리셋이 소유하는 선택적 Orbit 카메라 입력.
uniform vec3 uCameraOrbit;

mat3 cameraBasis(vec3 ro, vec3 target) {
    vec3 forward = normalize(target - ro);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, forward);
    return mat3(right, up, forward);
}

vec3 shade(vec3 p, vec3 rd, float id) {
    vec3 normal = calcNormal(p);
    vec3 lightDir = normalize(vec3(-0.6, 1.0, 0.8));
    float diffuse = max(dot(normal, lightDir), 0.0);
    vec3 halfDir = normalize(lightDir - rd);
    float specular = pow(max(dot(normal, halfDir), 0.0), 48.0);
    return getAlbedo(id) * (0.18 + 0.82 * diffuse) + vec3(0.18) * specular;
}

void main() {
    // 화면 중심을 (0,0), 세로 방향 크기를 2로 맞춰 종횡비 왜곡을 피한다.
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec3 target = vec3(0.0, -0.2, 0.0);
    float yaw = uCameraOrbit.x, pitch = uCameraOrbit.y, distance = uCameraOrbit.z;
    vec3 ro = target + distance * vec3(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
    vec3 rd = normalize(cameraBasis(ro, target) * vec3(uv, 1.8));

    int steps;
    bool limitReached;
    vec2 hit = rayMarch(ro, rd, steps, limitReached);

    // 관찰용 디버그 모드. 장면에 특화되지 않으며 실제 GPU 시간은 의미하지 않는다.
    if(uDebugRaySteps) {
        float cost = sqrt(float(steps) / float(uMaxSteps));
        vec3 heat = mix(vec3(0.05, 0.20, 0.65), vec3(1.0, 0.25, 0.05), cost);
        if(limitReached) heat = vec3(1.0, 0.0, 1.0);
        fragColor = vec4(heat, 1.0);
        return;
    }

    vec3 color = vec3(0.04, 0.06, 0.09);
    if(hit.x >= 0.0) color = shade(ro + rd * hit.x, rd, hit.y);
    color = color / (color + vec3(1.0));
    color = pow(color, vec3(1.0 / 2.2));
    fragColor = vec4(color, 1.0);
}
`;
  const fragment = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
out vec4 fragColor;
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    vec2 mouse = uMouse.x < 0.0 ? vec2(0.0) : (uMouse - 0.5 * uResolution) / uResolution.y;
    float wave = sin(8.0 * length(uv - mouse) - uTime * 2.0);
    vec3 color = 0.5 + 0.5 * cos(uTime * 0.3 + wave + vec3(0.0, 2.1, 4.2));
    fragColor = vec4(color, 1.0);
}`;
  const orbitHome=[0,Math.atan2(2.6,4.5),Math.hypot(4.5,2.6)];
  const rayUniforms = [
    ["uCameraOrbit","vec3",orbitHome],
    ["uRMMaxSteps","int",128,{min:1,max:512,step:1}], ["uRMMaxDistance","float",100,{min:1,max:1000,step:1}],
    // 슬라이더는 실제로 쓰는 구간만 다룬다. 기본값이 트랙의 1% 근처에 붙으면 조절할 수 없다.
    ["uRMSurfaceEpsilon","float",0.001,{min:0.00001,max:0.01,step:0.00001}],
    ["uRMNormalEpsilon","float",0.001,{min:0.00001,max:0.01,step:0.00001}], ["uRMHeatmap","bool",false]
  ];
  return {vertex, fragment, raymarch:raymarch.replace(/uMaxSteps/g,"uRMMaxSteps").replace(/uMaxDistance/g,"uRMMaxDistance")
    .replace(/uSurfaceEpsilon/g,"uRMSurfaceEpsilon").replace(/uNormalEpsilon/g,"uRMNormalEpsilon")
    .replace(/uDebugRaySteps/g,"uRMHeatmap"), orbitHome, rayUniforms, passes:[], imageChannels:{}};
})();
const glsl_highlight=(()=>{
// GLSL 문법 강조 공용 모듈. 편집기(code-editor.js)와 가이드(guide.js)의 코드 예시가 같은 규칙·색(.glsl-* 클래스)을 쓴다.
// DOM 노드(텍스트 + span)만 만들며 HTML 문자열은 해석하지 않는다.
  const KEYWORDS = "uniform|out|in|inout|const|precision|highp|mediump|lowp|if|else|for|while|do|break|continue|return|discard|struct|layout|switch|case|default|true|false|flat|smooth";
  const TYPES = "void|float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?|[iu]?sampler2D|samplerCube|sampler3D";
  const TOKENS = new RegExp(String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*|"(?:\\.|[^"\\])*"|\b(?:${KEYWORDS})\b|\b(?:${TYPES})\b|\bgl_\w+\b|\b[A-Za-z_]\w*(?=\s*\()|\b\d+(?:\.\d*)?(?:[eE][+-]?\d+)?[uU]?\b|\.\d+(?:[eE][+-]?\d+)?`, "g");
  const KEYWORD = new RegExp(`^(?:${KEYWORDS})$`), TYPE = new RegExp(`^(?:${TYPES})$`);
  // 레퍼런스에 없어도 자주 쓰는 내장 함수는 항상 내장 색으로 칠한다.
  const DEFAULT_BUILTINS = "texture textureSize texelFetch textureLod normalize length distance dot cross mix clamp smoothstep step pow exp log sin cos tan atan abs min max floor ceil fract mod sqrt reflect refract radians degrees".split(" ");
  // builtinNames: 내장 함수 이름 목록(호출 이름 + '('이 여기에 있으면 builtin, 없으면 사용자 함수 색).
  const create = (builtinNames = []) => {
    const builtins = new Set([...builtinNames].filter(name => /^[A-Za-z_]\w*$/.test(name))); for(const name of DEFAULT_BUILTINS) builtins.add(name);
    const tokenClass = token => token.startsWith("//")||token.startsWith("/*")?"glsl-comment":token.startsWith("#")?"glsl-directive":token.startsWith('"')?"glsl-string":
      KEYWORD.test(token)?"glsl-keyword":TYPE.test(token)?"glsl-type":/^[.\d]/.test(token)?"glsl-number":token.startsWith("gl_")||builtins.has(token)?"glsl-builtin":"glsl-function";
    // source를 강조한 DocumentFragment를 돌려준다.
    const fragment = source => {
      const src = String(source), frag = document.createDocumentFragment(); let offset = 0;
      for(const match of src.matchAll(TOKENS)) {
        if(match.index > offset) frag.append(document.createTextNode(src.slice(offset, match.index)));
        const token = match[0], span = document.createElement("span"); span.textContent = token; span.className = tokenClass(token);
        frag.append(span); offset = match.index + token.length;
      }
      if(offset < src.length) frag.append(document.createTextNode(src.slice(offset)));
      return frag;
    };
    // node의 내용을 강조된 source로 바꾼다. 텍스트 내용(textContent)은 source와 같게 유지된다.
    const paint = (node, source = node.textContent) => { node.replaceChildren(fragment(source)); node.classList?.add("glsl-code"); return node; };
    return {tokenClass, fragment, paint, builtins};
  };
  return {create,TOKENS};
})();
const code_editor=((Highlight)=>{
// 로컬 textarea 기반 GLSL 편집 보조 도구. 별도 라이브러리나 CDN이 필요하지 않다.

  // options.lookup(name) → {sig, desc} | null : 내장 함수 설명(시그니처 힌트). options.onScrub() : 숫자를 끌어 바꾸는 중 즉시 적용 요청.
  const mount = (textarea,ask,beforeEdit=()=>{},uniformNames=()=>[],options={}) => {
    const $ = id => document.getElementById(id), ac = new AbortController(), signal = ac.signal;
    const listen = (target, type, fn) => target?.addEventListener(type, fn, {signal});   // 선택 요소(버튼 등)가 없어도 편집기는 동작한다
    const gutter = $("studioLines"), highlight = $("studioHighlight"), position = $("studioCursor"), findPanel = $("studioFindPanel");
    // 강조: 내장 함수 이름은 레퍼런스(options.builtins)에서 받는다. 호출(이름 + '(')은 내장이면 builtin, 아니면 사용자 함수 색.
    const highlighter = Highlight.create((options.builtins || []).map(item => item.name));
    // 주석·문자열·전처리문을 제외한다. 함수 탐색은 최상위 정의만 열거한다.
    const cleanSource = source => source.replace(/^[ \t]*#(?:[^\n]*\\\r?\n)*[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\])*"/gm,s=>s.replace(/[^\n]/g," "));
    let functionSource=null,functionEntries=[];
    const scanFunctions = source => {
      if(source===functionSource)return functionEntries;
      const clean=cleanSource(source);
      const pattern=/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*\{/g, found=[];let pos=0,depth=0,line=1;
      for(const match of clean.matchAll(pattern)) {
        for(;pos<match.index;pos++) {const ch=clean[pos];if(ch==="{")depth++;else if(ch==="}")depth=Math.max(0,depth-1);else if(ch==="\n")line++;}
        if(depth)continue;
        found.push({name:match[2],params:match[3].trim().replace(/\s+/g," "),line});
      }
      functionSource=source;return functionEntries=found;
    };
    const symbols = $("studioFunctions"), updateFunctions = () => {
      const entries=scanFunctions(textarea.value);symbols.replaceChildren(new Option(`ƒ 함수 (${entries.length})`,""),
        ...entries.map(({name,params,line})=>new Option(`${name}(${params.slice(0,38)}${params.length>38?"…":""}) · Ln ${line}`,String(line))));
      symbols.value="";symbols.disabled=!entries.length;
    };
    let paintRequest = 0,paintedSource=null; const paint = () => {
      paintRequest=0;const src=textarea.value;if(src===paintedSource)return;paintedSource=src;const frag=highlighter.fragment(src);
      frag.append(document.createTextNode("\n ")); highlight.replaceChildren(frag);
      highlight.scrollTop=textarea.scrollTop;highlight.scrollLeft=textarea.scrollLeft;updateFunctions();
      renderDiagnostics();
    }; const schedulePaint = () => {if(!paintRequest)paintRequest=requestAnimationFrame(paint);};
    // 컴파일 진단(Error Lens): 오류 줄 강조 띠와 줄 끝 메시지. 하이라이트 레이어와 같은 좌표계를 쓴다.
    // 편집하면 줄 위치가 달라질 수 있으므로 다음 컴파일 전까지 흐리게(stale) 표시한다.
    const surface = highlight.parentElement || null, layer = surface ? document.createElement("div") : null;
    if(layer) { layer.className = "studio-diagnostic-layer"; layer.setAttribute("aria-hidden","true"); surface.append(layer); }
    let diagnostics = [], measure = null;
    const charWidth = style => {
      measure ??= document.createElement("canvas").getContext("2d");
      if(!measure?.measureText) return fontSize * 0.6;
      measure.font = `${style.fontSize || fontSize+"px"} ${style.fontFamily || "monospace"}`; return measure.measureText("0000000000").width / 10 || fontSize * 0.6;
    };
    const renderDiagnostics = () => {
      if(!layer) return;
      if(!diagnostics.length || wrap) { layer.replaceChildren(); return; }
      const style = getComputedStyle(textarea), lh = parseFloat(style.lineHeight) || fontSize*1.65;
      const top = parseFloat(style.paddingTop) || 12, left = parseFloat(style.paddingLeft) || 12, cw = charWidth(style);
      const rows = textarea.value.split("\n"), byLine = new Map(), nodes = [];
      for(const item of diagnostics) if(item.line >= 1 && item.line <= rows.length) {
        const entry = byLine.get(item.line) || {severity:"warning", messages:[]};
        if(item.severity === "error") entry.severity = "error"; entry.messages.push(item.message); byLine.set(item.line, entry);
      }
      for(const [line, {severity, messages}] of byLine) {
        const y = top + (line-1)*lh - textarea.scrollTop; if(y < -lh || y > textarea.clientHeight + lh) continue;
        const band = document.createElement("div"); band.className = "studio-diagnostic-line"; band.dataset.severity = severity;
        band.style.top = `${y}px`; band.style.height = `${lh}px`;
        const lens = document.createElement("div"); lens.className = "studio-diagnostic-lens"; lens.dataset.severity = severity;
        const text = rows[line-1].replace(/\t/g, " ".repeat(tabSize));
        lens.textContent = messages.length > 1 ? `${messages[0]} (+${messages.length-1})` : messages[0];
        lens.style.top = `${y}px`; lens.style.height = `${lh}px`; lens.style.left = `${left + text.trimEnd().length*cw - textarea.scrollLeft + 28}px`;
        nodes.push(band, lens);
      }
      layer.replaceChildren(...nodes);
    };
    // list: [{line, message, severity:"error"|"warning"}] — 현재 편집 중인 패스의 원본 줄 번호.
    const setDiagnostics = list => {
      diagnostics = Array.isArray(list) ? list.filter(item => Number.isInteger(item?.line) && typeof item.message === "string") : [];
      layer?.classList?.remove("is-stale"); renderDiagnostics();
    };
    const query = $("studioFindQuery"), replacement = $("studioReplaceValue"), result = $("studioFindCount");
    const STATE_KEY = "webgl.shader-studio.editor.v2"; let fontSize = 12, wrap = false, tabSize = 4, matches = [], matchIndex = -1;
    try { const state = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
      if(Number.isInteger(state.fontSize)) fontSize = Math.max(10, Math.min(20, state.fontSize)); wrap = !!state.wrap; tabSize = state.tabSize === 2 ? 2 : 4;
    } catch (_) {}
    const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify({fontSize,wrap,tabSize})); } catch (_) {} };
    const setPresentation = () => {
      textarea.style.tabSize=highlight.style.tabSize=String(tabSize);textarea.style.fontSize = `${fontSize}px`; gutter.style.fontSize = `${fontSize}px`;highlight.style.fontSize=`${fontSize}px`;
      textarea.classList.toggle("editor-wrap", wrap);highlight.classList.toggle("editor-wrap",wrap);
      textarea.wrap=wrap?"soft":"off";textarea.closest(".studio-editor-frame").classList.toggle("is-wrapped",wrap); $("studioLineWrap").setAttribute("aria-pressed", String(wrap));
      $("studioFontSize").textContent = `${fontSize}px`; $("studioIndent").value = String(tabSize); save(); updateLines(); renderDiagnostics();
    }; const lineAt = offset => textarea.value.slice(0,offset).split("\n").length; const updateCursor = () => {
      const p = textarea.selectionStart, line = lineAt(p), start = textarea.value.lastIndexOf("\n",p-1)+1;
      const selected = textarea.selectionEnd - p;
      position.textContent = `Ln ${line}, Col ${p-start+1}${selected ? ` · ${selected}자 선택` : ""}`;
      updateSignature(); scheduleDecorations(); checkSnippetSession();
    };
    // ==== 언어 정보: 키워드·타입·앱 Uniform·내장 변수 ====
    const KEYWORDS = "if else for while do break continue return discard switch case default struct const uniform in out inout layout precision highp mediump lowp true false flat smooth".split(" ");
    const TYPES = "void bool int uint float vec2 vec3 vec4 bvec2 bvec3 bvec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 mat2 mat3 mat4 mat2x3 mat2x4 mat3x2 mat3x4 mat4x2 mat4x3 sampler2D isampler2D usampler2D samplerCube sampler3D".split(" ");
    // 렌더러가 값을 넣어 주는 Uniform: 선언하지 않은 채 자동 완성으로 고르면 선언을 맨 위에 함께 추가한다.
    const APP_UNIFORMS = [["uResolution","vec2","현재 패스의 픽셀 크기 (vec3으로 선언하면 z = 1)"],["uTime","float","재생 시간(초). 일시정지 중에는 멈춥니다"],
      ["uDeltaTime","float","직전 프레임과의 시간 간격(초)"],["uFrame","int","누적 프레임 수. 시간 초기화·구조 변경 시 0"],
      ["uMouse","vec4","포인터 픽셀 좌표(밖이면 -1) · zw = 클릭 위치, z > 0 누르는 중, w > 0 누른 첫 프레임"],
      ...[0,1,2,3].map(i => [`iChannel${i}`,"sampler2D",`입력 채널 ${i} — 편집기 입력 채널에서 연결한 이미지·버퍼`]),
      ["iChannelResolution","vec3","각 입력 채널의 크기 (배열 4개)","uniform vec3 iChannelResolution[4];"]];
    const BUILTIN_VARS = {gl_FragCoord:"vec4", gl_FrontFacing:"bool", gl_PointCoord:"vec2", gl_FragDepth:"float"};
    const isIdent = text => /^[A-Za-z_]\w*$/.test(text);
    const userUniforms = () => options.userUniforms?.() || uniformNames().map(name => ({name, type:""}));
    const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    // 주석·문자열을 같은 길이 공백으로 지운 사본(위치 보존). 같은 소스면 다시 계산하지 않는다.
    let cleanCache = {src:null, clean:""};
    const cleanOf = src => { if(cleanCache.src !== src) cleanCache = {src, clean:cleanSource(src)}; return cleanCache.clean; };
    const lineStartsOf = src => { const starts = [0]; for(let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i+1)) starts.push(i+1); return starts; };
    const lineIndexAt = (starts, offset) => { let lo = 0, hi = starts.length-1; while(lo < hi) { const mid = (lo+hi+1) >> 1; if(starts[mid] <= offset) lo = mid; else hi = mid-1; } return lo; };
    // ==== 심볼 표: 함수·변수(매개변수 포함)·구조체·#define. 소스가 바뀔 때만 다시 만든다 ====
    const DECL = /\b((?:(?:const|uniform|in|out|inout|highp|mediump|lowp|flat|smooth)\s+)*)((?:[biu]?vec[234]|mat[234](?:x[234])?|float|int|uint|bool|[iu]?sampler2D|samplerCube|sampler3D|[A-Z]\w*))\s+([A-Za-z_]\w*)\s*(?=[=;,)\[])/g;
    let symbolCache = {src:null};
    const symbolsOf = src => {
      if(symbolCache.src === src) return symbolCache;
      const clean = cleanOf(src), starts = lineStartsOf(src), line = at => lineIndexAt(starts, at) + 1, functions = [], variables = [], structs = new Map(), defines = [];
      for(const m of clean.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*\{/g)) if(!KEYWORDS.includes(m[1]) && !KEYWORDS.includes(m[2]))
        functions.push({name:m[2], ret:m[1], params:m[3].trim().replace(/\s+/g," "), offset:m.index + m[0].indexOf(m[2], m[1].length), line:line(m.index)});
      for(const m of clean.matchAll(DECL)) if(!KEYWORDS.includes(m[3]) && !TYPES.includes(m[3]))
        variables.push({name:m[3], type:m[2], uniform:/\buniform\b/.test(m[1]), output:/\bout\b/.test(m[1]), offset:m.index + m[0].lastIndexOf(m[3]), line:line(m.index)});
      for(const m of clean.matchAll(/\bstruct\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/g))
        structs.set(m[1], {line:line(m.index), offset:m.index + m[0].indexOf(m[1]), fields:[...m[2].matchAll(/([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;/g)].map(f => ({name:f[2], type:f[1]}))});
      for(const m of src.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]*(.*)$/gm)) defines.push({name:m[1], value:m[2].trim(), offset:m.index + m[0].indexOf(m[1]), line:line(m.index)});
      return symbolCache = {src, functions, variables, structs, defines};
    };
    // 이름의 타입: 가장 가까운 앞쪽 선언 → 내장 변수 → 앱 Uniform
    const typeOf = (name, pos) => {
      const vars = symbolsOf(textarea.value).variables.filter(v => v.name === name); if(!vars.length) return BUILTIN_VARS[name] || APP_UNIFORMS.find(u => u[0] === name)?.[1] || "";
      const before = vars.filter(v => v.offset <= pos); return (before.length ? before[before.length-1] : vars[0]).type;
    };
    const wordAround = (src, pos) => {
      let a = pos, b = pos; while(a > 0 && /\w/.test(src[a-1])) a--; while(b < src.length && /\w/.test(src[b])) b++;
      const word = src.slice(a, b); return isIdent(word) ? {word, start:a, end:b} : null;
    };
    // 설명: 함수(내장·이 패스) / 변수·Uniform·구조체·#define — 시그니처 힌트와 마우스 설명이 함께 쓴다.
    const describeFunction = name => {
      const builtin = options.lookup?.(name); if(builtin) return {sig:builtin.sig, desc:builtin.desc};
      const own = symbolsOf(textarea.value).functions.find(entry => entry.name === name);
      return own ? {sig:`${own.ret} ${name}(${own.params})`, desc:`이 패스에 정의된 함수 · ${own.line}번째 줄`} : null;
    };
    const describeSymbol = (name, pos) => {
      const fn = describeFunction(name); if(fn) return fn;
      const sym = symbolsOf(textarea.value), app = APP_UNIFORMS.find(u => u[0] === name);
      const vars = sym.variables.filter(v => v.name === name), decl = vars.filter(v => v.offset <= pos).pop() || vars[0];
      if(decl) return {sig:`${decl.uniform ? "uniform " : decl.output ? "out " : ""}${decl.type} ${name}`, desc:app ? app[2] : `${decl.uniform ? "Uniform" : decl.output ? "출력" : "변수"} · ${decl.line}번째 줄에서 선언`};
      if(app) return {sig:`uniform ${app[1]} ${name}`, desc:`${app[2]} · 아직 선언되지 않음`};
      const param = userUniforms().find(u => u.name === name); if(param) return {sig:`uniform ${param.type} ${name}`, desc:"파라미터 패널에 등록된 값 · 선언은 자동으로 추가됩니다"};
      const struct = sym.structs.get(name); if(struct) return {sig:`struct ${name} { ${struct.fields.map(f => `${f.type} ${f.name};`).join(" ")} }`, desc:`구조체 · ${struct.line}번째 줄`};
      const define = sym.defines.find(d => d.name === name); if(define) return {sig:`#define ${name} ${define.value}`, desc:`매크로 · ${define.line}번째 줄`};
      return null;
    };
    // ==== 커서 화면 좌표: textarea와 같은 글꼴·여백·줄바꿈을 가진 숨은 복제본으로 잰다(줄바꿈 켜도 정확) ====
    const frame = textarea.closest(".studio-editor-frame");
    const mirror = document.createElement("div"); mirror.className = "studio-caret-mirror"; mirror.setAttribute("aria-hidden","true"); surface?.append(mirror);
    const caretCoords = pos => {
      const style = getComputedStyle(textarea);
      for(const key of ["fontFamily","fontSize","fontWeight","lineHeight","letterSpacing","tabSize","paddingTop","paddingRight","paddingBottom","paddingLeft","whiteSpace","overflowWrap","wordBreak"]) mirror.style[key] = style[key];
      mirror.style.width = `${textarea.clientWidth}px`;
      const marker = document.createElement("span"); marker.textContent = "​"; mirror.replaceChildren(document.createTextNode(textarea.value.slice(0, pos)), marker);
      return {left:marker.offsetLeft - textarea.scrollLeft, top:marker.offsetTop - textarea.scrollTop, height:parseFloat(style.lineHeight) || fontSize*1.65};
    };
    // ==== 시그니처 도움말: 호출 괄호 안이면 지금 쓰는 인수를 굵게, 커서 바로 위에 띄운다 ====
    const signature = $("studioSignature"); let signatureKey = "";
    const calleeAt = (src, pos) => {
      const here = wordAround(src, pos);
      if(here && /^\s*\(/.test(src.slice(here.end)) && describeFunction(here.word)) return {name:here.word, arg:-1};
      // 닫히지 않은 가장 가까운 '(' 앞의 이름 = 지금 인수를 쓰고 있는 함수, 그 사이 깊이 0의 쉼표 수 = 인수 번호
      for(let i = pos-1, depth = 0, stop = Math.max(0,pos-800); i >= stop; i--) {
        const c = src[i]; if(c === ")" || c === "]") depth++;
        else if(c === "(" || c === "[") {
          if(depth === 0) {
            if(c === "[") return null; const name = src.slice(0,i).match(/([A-Za-z_]\w*)\s*$/)?.[1]; if(!name) return null;
            let arg = 0; for(let j = i+1, d = 0; j < pos; j++) { const k = src[j]; if(k === "(" || k === "[") d++; else if(k === ")" || k === "]") d--; else if(k === "," && !d) arg++; }
            return {name, arg};
          } depth--;
        } else if(c === ";" || c === "{" || c === "}") break;
      }
      return here && describeFunction(here.word) ? {name:here.word, arg:-1} : null;
    };
    // 시그니처 문자열에서 name(…)의 매개변수 위치를 찾는다. "[, float bias]" 같은 선택 인수 안의 쉼표는 나누지 않는다.
    const paramsOf = (sig, name) => {
      const at = sig.search(new RegExp(`\\b${escapeRe(name)}\\s*\\(`)); if(at < 0) return null;
      const open = sig.indexOf("(", at), parts = []; let depth = 0, from = open+1, close = sig.length;
      for(let i = open+1; i < sig.length; i++) { const c = sig[i];
        if(c === "(" || c === "[") depth++; else if(c === "]") depth--; else if(c === ")") { if(!depth) { close = i; break; } depth--; }
        else if(c === "," && !depth) { parts.push([from, i]); from = i+1; } }
      if(sig.slice(from, close).trim()) parts.push([from, close]); return {at, open, close, parts};
    };
    const renderSignature = (target, name, info, arg) => {
      const overloads = info.sig.split(" · ").filter(sig => paramsOf(sig, name)), all = overloads.length ? overloads : [info.sig];
      const sig = arg < 0 ? all[0] : all.find(item => (paramsOf(item, name)?.parts.length || 0) > arg) || all[0], shape = paramsOf(sig, name);
      const line = document.createElement("span"), text = (a, b) => line.append(document.createTextNode(sig.slice(a, b)));
      if(shape) {
        text(0, shape.at); const b = document.createElement("b"); b.textContent = sig.slice(shape.at, shape.open); line.append(b); text(shape.open, shape.open+1);
        let cursor = shape.open+1; shape.parts.forEach(([a, z], i) => { while(a < z && sig[a] === " ") a++; text(cursor, a); const part = document.createElement(i === arg ? "em" : "span"); if(i === arg) part.className = "sig-param-active"; part.textContent = sig.slice(a, z); line.append(part); cursor = z; });
        text(cursor, sig.length);
      } else text(0, sig.length);
      const desc = document.createElement("small"); desc.textContent = info.desc + (all.length > 1 ? ` · 다른 형태 ${all.length-1}개` : "");
      target.replaceChildren(line, desc);
    };
    const hideSignature = () => { if(signature && !signature.hidden) { signature.hidden = true; signatureKey = ""; } };
    // 떠 있는 카드를 커서 근처(기본: 줄 위, 공간이 없으면 줄 아래)에 놓는다. 좌표는 편집 프레임 기준.
    const placeNear = (element, coords, preferAbove) => {
      if(!frame || !surface) return; const lh = coords.height, maxLeft = frame.clientWidth - element.offsetWidth - 6;
      const left = Math.max(6, Math.min(surface.offsetLeft + coords.left - 10, maxLeft));
      const above = surface.offsetTop + coords.top - element.offsetHeight - 4, below = surface.offsetTop + coords.top + lh + 4;
      element.style.left = `${left}px`; element.style.top = `${preferAbove && above >= 2 || below + element.offsetHeight > frame.clientHeight ? Math.max(2, above) : below}px`;
    };
    const updateSignature = () => {
      if(!signature) return; const pos = textarea.selectionStart;
      if(document.activeElement !== textarea || textarea.selectionEnd !== pos || codeMode(pos)) return hideSignature();
      // 이름만 친 상태에서는 자동 완성 설명 칸이 같은 정보를 보여 주므로, 괄호 안(인수 입력 중)일 때만 띄운다.
      const call = calleeAt(textarea.value, pos), info = call && call.arg >= 0 ? describeFunction(call.name) : null; if(!info) return hideSignature();
      const key = `${call.name}|${call.arg}|${info.sig}`;
      if(key !== signatureKey) { signatureKey = key; renderSignature(signature, call.name, info, call.arg); }
      signature.hidden = false; placeNear(signature, caretCoords(pos), true);
    };
    // ==== 마우스 설명(hover): 이름 위에 잠시 머물면 시그니처·타입·선언 위치를 보여준다 ====
    const hover = document.createElement("div"); hover.className = "studio-hover"; hover.setAttribute("role","tooltip"); hover.hidden = true; frame?.append(hover);
    let hoverTimer = 0, hoverWord = "";
    const hideHover = () => { clearTimeout(hoverTimer); if(!hover.hidden) { hover.hidden = true; hoverWord = ""; } };
    const showHover = (x, y) => {
      const pos = offsetAtPoint(x, y); if(pos < 0 || !frame) return hideHover();
      const found = wordAround(textarea.value, pos); if(!found || codeMode(found.start)) return hideHover();
      const info = describeSymbol(found.word, found.start); if(!info) return hideHover();
      if(found.word + found.start !== hoverWord) { hoverWord = found.word + found.start; renderSignature(hover, found.word, info, -1); }
      hover.hidden = false; const rect = frame.getBoundingClientRect();
      hover.style.left = `${Math.max(6, Math.min(x - rect.left + 8, frame.clientWidth - hover.offsetWidth - 6))}px`;
      const top = y - rect.top + 18; hover.style.top = `${top + hover.offsetHeight > frame.clientHeight ? Math.max(2, y - rect.top - hover.offsetHeight - 10) : top}px`;
    };
    listen(textarea, "mousemove", event => { if(scrub || event.buttons) return hideHover(); clearTimeout(hoverTimer); const {clientX:x, clientY:y} = event; hoverTimer = setTimeout(() => showHover(x, y), 400); });
    listen(textarea, "mouseleave", hideHover); listen(textarea, "keydown", hideHover);
    // ==== 화면 표시: 현재 줄 · 짝 괄호 · 커서 아래 이름의 다른 사용 위치 (VS Code와 같은 방식) ====
    const decorations = document.createElement("div"); decorations.className = "studio-deco-layer"; decorations.setAttribute("aria-hidden","true"); surface?.insertBefore?.(decorations, textarea);
    const BRACKETS = {"(":")","[":"]","{":"}"}, CLOSERS = {")":"(","]":"[","}":"{"};
    const matchBracket = (src, pos) => {
      const clean = cleanOf(src), at = BRACKETS[clean[pos]] || CLOSERS[clean[pos]] ? pos : BRACKETS[clean[pos-1]] || CLOSERS[clean[pos-1]] ? pos-1 : -1; if(at < 0) return null;
      const c = clean[at], forward = !!BRACKETS[c], pair = forward ? BRACKETS[c] : CLOSERS[c];
      for(let i = at + (forward ? 1 : -1), depth = 0, steps = 0; i >= 0 && i < clean.length && steps < 50000; i += forward ? 1 : -1, steps++) {
        if(clean[i] === c) depth++; else if(clean[i] === pair) { if(!depth) return [at, i]; depth--; }
      }
      return null;
    };
    // 커서 이동·입력이 몰려도 한 번만 그린다. 화면 갱신 주기(rAF)가 멈춘 상태(숨은 창)에서도 밀리지 않도록 타이머를 쓴다.
    let decoRequest = 0; const scheduleDecorations = () => { if(!decoRequest) decoRequest = setTimeout(renderDecorations, 0); };
    const renderDecorations = () => {
      decoRequest = 0; if(!surface || wrap) { decorations.replaceChildren(); return; }
      const style = getComputedStyle(textarea), lh = parseFloat(style.lineHeight) || fontSize*1.65, cw = charWidth(style);
      const top = parseFloat(style.paddingTop) || 12, left = parseFloat(style.paddingLeft) || 12, src = textarea.value, starts = lineStartsOf(src);
      const a = textarea.selectionStart, b = textarea.selectionEnd, focused = document.activeElement === textarea, nodes = [];
      const first = Math.max(0, Math.floor(textarea.scrollTop / lh) - 1), last = Math.min(starts.length-1, first + Math.ceil(textarea.clientHeight / lh) + 2);
      const column = (lineIndex, offset) => { let visual = 0; for(let i = starts[lineIndex]; i < offset; i++) visual += src[i] === "\t" ? tabSize - visual % tabSize : 1; return visual; };
      const box = (offset, length, className) => {
        const index = lineIndexAt(starts, offset); if(index < first || index > last) return;
        const node = document.createElement("div"); node.className = className;
        node.style.cssText = `left:${left + column(index, offset)*cw - textarea.scrollLeft}px;top:${top + index*lh - textarea.scrollTop}px;width:${Math.max(1,length)*cw}px;height:${lh}px`; nodes.push(node);
      };
      if(focused) { const index = lineIndexAt(starts, a); if(index >= first && index <= last) { const band = document.createElement("div"); band.className = "deco-line"; band.style.cssText = `top:${top + index*lh - textarea.scrollTop}px;height:${lh}px`; nodes.push(band); } }
      if(focused && a === b) { const pair = matchBracket(src, a); if(pair) { box(pair[0], 1, "deco-bracket"); box(pair[1], 1, "deco-bracket"); } }
      // 이름 강조: 커서 아래 단어, 또는 한 줄 안의 선택 텍스트와 같은 다른 위치
      const selected = src.slice(a, b), found = a === b ? wordAround(src, a) : (isIdent(selected) ? {word:selected} : null);
      if(focused && found && !KEYWORDS.includes(found.word) && !codeMode(a)) {
        const clean = cleanOf(src), from = starts[first], to = last+1 < starts.length ? starts[last+1] : src.length, hits = [];
        for(const m of clean.slice(from, to).matchAll(new RegExp(`\\b${escapeRe(found.word)}\\b`, "g"))) { hits.push(from + m.index); if(hits.length > 300) break; }
        if(hits.length > 1) for(const at of hits) box(at, found.word.length, "deco-occurrence");
      }
      decorations.replaceChildren(...nodes);
    };
    listen(textarea, "focus", scheduleDecorations); listen(textarea, "blur", scheduleDecorations);
    // ---- 숫자 조절: Ctrl+↑/↓(Shift = 10배) 또는 숫자 위에서 Alt+좌우 드래그 ----
    // 단위는 리터럴의 마지막 자릿수(0.25 → 0.01, 3. → 1, 8 → 1)이고 정수·실수 형식을 그대로 유지한다.
    const numberAt = (src, pos) => {
      const from = src.lastIndexOf("\n",pos-1)+1, stop = src.indexOf("\n",pos), to = stop < 0 ? src.length : stop, row = src.slice(from,to);
      if(/^\s*#/.test(row) || codeMode(pos)) return null;
      for(const match of row.matchAll(/(?:\d+\.\d*|\.\d+|\d+)(?![\w.])/g)) {
        const a = from + match.index, b = a + match[0].length; if(pos < a || pos > b) continue;
        if(/[\w.]/.test(src[a-1] || "")) return null;   // vec3, iChannel0, 1e5 같은 이름·지수 표기는 건드리지 않는다
        const before = src.slice(from, a).replace(/\s+$/, ""), unary = before.endsWith("-") && !/[\w)\].]$/.test(before.slice(0,-1).replace(/\s+$/, ""));
        const start = unary ? from + before.length - 1 : a, text = src.slice(start, b);
        if(unary && /\s/.test(text.slice(1, a - start))) return {start:a, end:b, text:match[0]};   // "- 1"은 연산자로 본다
        return {start, end:b, text};
      }
      return null;
    };
    // 숫자 조절은 타이핑처럼 연속 입력으로 묶이도록(Undo 한 번에 되돌리기) inputType을 붙여 알린다.
    const notifyAdjust = () => textarea.dispatchEvent(typeof InputEvent === "function" ? new InputEvent("input",{bubbles:true,inputType:"insertReplacementText"}) : new Event("input",{bubbles:true}));
    const numberFormat = text => { const dot = text.indexOf("."), decimals = dot < 0 ? 0 : text.length - dot - 1; return {decimals, isFloat:dot >= 0, step:10 ** -decimals}; };
    const formatNumber = (value, {decimals, isFloat}) => {
      if(Object.is(Math.round(value * 10 ** decimals), -0) || Math.abs(value) < 10 ** -(decimals+1)) value = 0;
      return decimals > 0 ? value.toFixed(decimals) : isFloat ? `${Math.round(value)}.` : String(Math.round(value));
    };
    const nudgeNumber = (direction, multiplier) => {
      if(textarea.selectionStart !== textarea.selectionEnd) return false;
      const caret = textarea.selectionStart, found = numberAt(textarea.value, caret); if(!found) return false;
      const format = numberFormat(found.text), next = formatNumber(parseFloat(found.text) + direction * format.step * multiplier, format);
      beforeEdit(); textarea.setRangeText(next, found.start, found.end, "preserve");
      const keep = Math.min(found.start + next.length, Math.max(found.start, caret + next.length - found.text.length)); textarea.setSelectionRange(keep, keep);
      notifyAdjust(); return true;
    };
    // 포인터 좌표 → 소스 위치 (줄바꿈 끄고 있을 때만; 고정폭 글꼴 기준)
    const offsetAtPoint = (x, y) => {
      if(wrap) return -1; const style = getComputedStyle(textarea), rect = textarea.getBoundingClientRect();
      const lh = parseFloat(style.lineHeight) || fontSize*1.65, cw = charWidth(style);
      const line = Math.floor((y - rect.top - (parseFloat(style.paddingTop) || 12) + textarea.scrollTop) / lh);
      const column = Math.floor((x - rect.left - (parseFloat(style.paddingLeft) || 12) + textarea.scrollLeft) / cw);
      const rows = textarea.value.split("\n"); if(line < 0 || line >= rows.length || column < 0) return -1;
      let visual = 0, index = 0; const row = rows[line];
      while(index < row.length && visual + (row[index] === "\t" ? tabSize - visual % tabSize : 1) <= column) { visual += row[index] === "\t" ? tabSize - visual % tabSize : 1; index++; }
      return rows.slice(0, line).reduce((sum, r) => sum + r.length + 1, 0) + index;
    };
    let scrub = null;
    listen(textarea, "pointerdown", event => {
      if(!event.altKey || event.button !== 0) return;
      const pos = offsetAtPoint(event.clientX, event.clientY), found = pos < 0 ? null : numberAt(textarea.value, pos); if(!found) return;
      event.preventDefault(); textarea.focus(); textarea.setSelectionRange(found.start, found.end);
      scrub = {x:event.clientX, base:parseFloat(found.text), start:found.start, end:found.end, text:found.text, format:numberFormat(found.text)};
      try { textarea.setPointerCapture(event.pointerId); } catch (_) {} textarea.classList.add("is-scrubbing"); beforeEdit();
    });
    listen(textarea, "pointermove", event => {
      if(!scrub) return;
      const steps = Math.round((event.clientX - scrub.x) / 4), next = formatNumber(scrub.base + steps * scrub.format.step * (event.shiftKey ? 10 : 1), scrub.format);
      if(next === scrub.text) return;
      textarea.setRangeText(next, scrub.start, scrub.end, "select"); scrub.end = scrub.start + next.length; scrub.text = next;
      notifyAdjust(); options.onScrub?.();
    });
    const endScrub = () => { if(!scrub) return; scrub = null; textarea.classList.remove("is-scrubbing"); options.onScrub?.(); };
    listen(textarea, "pointerup", endScrub); listen(textarea, "pointercancel", endScrub); listen(textarea, "lostpointercapture", endScrub);
    const updateLines = () => {
      const count = textarea.value.split("\n").length;
      if(gutter.dataset.count !== String(count)) { gutter.textContent = Array.from({length:count},(_,i)=>i+1).join("\n"); gutter.dataset.count = count; }
      gutter.scrollTop = textarea.scrollTop; updateCursor();schedulePaint();
    }; const replaceSelection = (text, start = textarea.selectionStart, end = textarea.selectionEnd) => {
      beforeEdit();textarea.setRangeText(text,start,end,"end"); textarea.dispatchEvent(new Event("input",{bubbles:true}));
    }; const revealLine = line => {
      // 대상 줄이 화면 밖이거나 가장자리에 붙어 있을 때만 스크롤한다. 이미 보이는 줄은 위치를 바꾸지 않는다.
      const style = getComputedStyle(textarea), height = parseFloat(style.lineHeight) || fontSize*1.6, top = (parseFloat(style.paddingTop) || 12) + (line-1)*height;
      const margin = height*2, viewBottom = textarea.scrollTop + textarea.clientHeight;
      if(top < textarea.scrollTop + margin) textarea.scrollTop = Math.max(0, top - margin);
      else if(top + height > viewBottom - margin) textarea.scrollTop = top + height + margin - textarea.clientHeight;
    }; const goToLine = (line, column = 1) => {
      const rows = textarea.value.split("\n"); line = Math.min(rows.length,Math.max(1,Number(line)||1));
      const begin = rows.slice(0,line-1).reduce((sum,row)=>sum+row.length+1,0);
      const offset = begin + Math.min(rows[line-1].length,Math.max(0,column-1)); const keep = textarea.scrollTop; textarea.focus(); textarea.setSelectionRange(offset,offset); textarea.scrollTop = keep;
      if(!wrap) revealLine(line); updateLines(); return line;
    }; const findMatches = (src,text,limit=Infinity) => {
      const found=[];if(!text)return found;const pattern=new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"gi");
      for(const match of src.matchAll(pattern)){if(found.length===limit)break;found.push(match.index);}return found;
    }; const updateMatches = () => {
      matches=findMatches(textarea.value,query.value,10000);matchIndex=-1;
      result.textContent=`${matches.length} results`;return matches.length;
    }; const findNext = backwards => {
      if(!matches.length) { updateMatches(); if(!matches.length) return false; }
      const p = textarea.selectionStart, len = query.value.length;
      if(backwards){let index=matches.length-1;while(index>=0&&matches[index]>=p)index--;matchIndex=index<0?matches.length-1:index;}
      else {const index=matches.findIndex(x=>x>=textarea.selectionEnd);matchIndex=index<0?0:index;}
      const start = matches[matchIndex], keep = textarea.scrollTop; textarea.focus();textarea.setSelectionRange(start,start+len); textarea.scrollTop = keep;
      const line = lineAt(start); if(!wrap) revealLine(line); updateCursor();result.textContent=`${matchIndex+1} / ${matches.length}`; return true;
    }; const showFind = (replace = false) => {
      findPanel.hidden = false; $("studioReplaceRow").hidden = !replace;
      const selected = textarea.value.slice(textarea.selectionStart,textarea.selectionEnd);
      if(selected && !selected.includes("\n") && selected.length < 100) query.value = selected; query.focus();query.select();updateMatches();
    }; const closeFind = () => {findPanel.hidden=true;textarea.focus();}; const doReplace = all => {
      if(!query.value)return;if(all) {
        const src=textarea.value,positions=findMatches(src,query.value),chunks=[];if(!positions.length)return;let last=0;
        for(const at of positions){chunks.push(src.slice(last,at),replacement.value);last=at+query.value.length;}
        chunks.push(src.slice(last));replaceSelection(chunks.join(""),0,src.length);
      } else {
        if(textarea.selectionEnd-textarea.selectionStart!==query.value.length || !findMatches(textarea.value.slice(textarea.selectionStart,textarea.selectionEnd),query.value).length) {
          if(!findNext(false)) return;
        }
        replaceSelection(replacement.value);
      }
      updateMatches();
    }; const indent = (reverse, wholeLine = false) => {
      const start=textarea.selectionStart,end=textarea.selectionEnd,src=textarea.value, pad=" ".repeat(tabSize);
      if(start===end && !reverse && !wholeLine) return replaceSelection(pad);
      const a=src.lastIndexOf("\n",start-1)+1,last=end>start&&src[end-1]==="\n"?end-1:end;
      const stop=src.indexOf("\n",last),until=stop<0?src.length:stop,chunk=src.slice(a,until);
      const lines=chunk.split("\n").map(row=>reverse?row.replace(new RegExp(`^( {1,${tabSize}}|\\t)`),""):row.trim()?pad+row:row).join("\n");
      if(lines===chunk)return;beforeEdit();textarea.setRangeText(lines,a,until,"select");
      if(start===end) {const caret=Math.max(a,start+lines.length-chunk.length);textarea.setSelectionRange(caret,caret);}
      textarea.dispatchEvent(new Event("input",{bubbles:true}));
    }; const moveLines = down => {
      const src=textarea.value,a=textarea.selectionStart,b=textarea.selectionEnd,direction=textarea.selectionDirection;
      const from=src.lastIndexOf("\n",a-1)+1,last=b>a&&src[b-1]==="\n"?b-1:b;
      const stop=src.indexOf("\n",last),to=stop<0?src.length:stop;
      let begin,end,text,shift;
      if(down) {
        if(to===src.length)return;
        begin=from;end=src.indexOf("\n",to+1);if(end<0)end=src.length;
        const next=src.slice(to+1,end);text=next+"\n"+src.slice(from,to);shift=next.length+1;
      } else {
        if(from===0)return;
        begin=src.lastIndexOf("\n",from-2)+1;end=to;
        const prev=src.slice(begin,from-1);text=src.slice(from,to)+"\n"+prev;shift=-prev.length-1;
      }
      beforeEdit();textarea.setRangeText(text,begin,end,"start");
      textarea.setSelectionRange(Math.max(0,Math.min(src.length,a+shift)),Math.max(0,Math.min(src.length,b+shift)),direction);
      textarea.dispatchEvent(new Event("input",{bubbles:true}));
    }; const toggleComment = () => {
      const src=textarea.value,a=src.lastIndexOf("\n",textarea.selectionStart-1)+1;
      const last=textarea.selectionEnd>textarea.selectionStart && src[textarea.selectionEnd-1]==="\n" ? textarea.selectionEnd-1 : textarea.selectionEnd;
      const b=src.indexOf("\n",last),end=b<0?src.length:b, lines=src.slice(a,end).split("\n");
      const remove=lines.every(line=>!line.trim()||/^\s*\/\//.test(line));
      const replaced=lines.map(line=>!line.trim()?line:remove?line.replace(/^(\s*)\/\/ ?/,"$1"):line.replace(/^(\s*)/,"$1// ")).join("\n");
      beforeEdit();textarea.setRangeText(replaced,a,end,"select");textarea.dispatchEvent(new Event("input",{bubbles:true}));
    }; const pairs={"(":")","[":"]","{":"}",'"':'"'};
    const codeMode = pos => {
      const src=textarea.value;let mode="";
      for(let i=0;i<pos;i++) {const c=src[i],n=src[i+1];
        if(mode==="line"){if(c==="\n")mode="";continue;}
        if(mode==="block"){if(c==="*"&&n==="/"){mode="";i++;}continue;}
        if(mode==="string"){if(c==="\\"){i++;continue;}if(c==='"'||c==="\n")mode="";continue;}
        if(c==="/"&&i+1<pos&&n==="/"){mode="line";i++;}
        else if(c==="/"&&i+1<pos&&n==="*"){mode="block";i++;}else if(c==='"')mode="string";
      }return mode;
    };
    // ==== 코드 템플릿(스니펫): ${1:기본값}은 Tab으로 차례로 이동하는 자리, $0은 마지막 커서 위치 ====
    const SNIPPETS = [
      {label:"main", detail:"void main() { … }", body:"void main() {\n\t$0\n}"},
      {label:"for", detail:"for (int i = 0; i < N; i++) { … }", body:"for (int i = 0; i < ${1:8}; i++) {\n\t$0\n}"},
      {label:"if", detail:"if (조건) { … }", body:"if (${1:condition}) {\n\t$0\n}"},
      {label:"ifelse", detail:"if (조건) { … } else { … }", body:"if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}"},
      {label:"func", detail:"반환형 이름(매개변수) { … }", body:"${1:float} ${2:name}(${3:vec2 p}) {\n\treturn ${4:0.0};\n}"},
      {label:"struct", detail:"struct 이름 { … };", body:"struct ${1:Name} {\n\t${2:float value};\n};"},
      {label:"uniform-range", detail:"슬라이더 파라미터 · @range", body:"uniform float ${1:uAmount}; // @range ${2:0} ${3:1} @default ${4:0.5}"},
      {label:"uniform-color", detail:"색상 파라미터 · @color", body:"uniform vec3 ${1:uColor}; // @color @default ${2:1.0 0.5 0.2}"},
      {label:"uv-center", detail:"중심 원점 · 종횡비 보정 좌표", body:"vec2 ${1:uv} = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;"},
      {label:"uv01", detail:"0~1 화면 좌표", body:"vec2 ${1:uv} = gl_FragCoord.xy / uResolution;"},
      {label:"tex", detail:"texture(채널, uv)", body:"texture(${1:iChannel0}, ${2:uv})"},
      {label:"texfetch", detail:"texelFetch — 픽셀 정확히 읽기", body:"texelFetch(${1:iChannel0}, ivec2(gl_FragCoord.xy), 0)"},
      {label:"frag", detail:"새 셰이더 전체 골격", body:"#version 300 es\nprecision highp float;\nuniform vec2 uResolution;\nuniform float uTime;\nout vec4 fragColor;\n\nvoid main() {\n\tvec2 uv = gl_FragCoord.xy / uResolution;\n\tfragColor = vec4(${1:uv, 0.5 + 0.5 * sin(uTime)}, 1.0);$0\n}"}];
    const expandSnippet = (body, indent) => {
      const source = body.replace(/\t/g, " ".repeat(tabSize)).replace(/\n/g, "\n" + indent), stops = []; let text = "", final = -1;
      for(let i = 0; i < source.length;) {
        const m = /^\$\{(\d+):([^}]*)\}|^\$(\d+)/.exec(source.slice(i, i + 80));
        if(m) { const n = Number(m[1] ?? m[3]), value = m[2] ?? ""; if(n === 0) final = text.length; else stops.push({n, start:text.length, end:text.length + value.length}); text += value; i += m[0].length; }
        else { text += source[i]; i++; }
      }
      return {text, stops:stops.sort((a, b) => a.n - b.n), final:final < 0 ? text.length : final};
    };
    // 진행 중인 템플릿: 자리 안에서 타이핑하면 뒤쪽 자리 위치를 길이 변화만큼 민다. 범위를 벗어나거나 Esc면 끝.
    let session = null;
    const selectStop = () => { const stop = session.stops[session.index]; textarea.setSelectionRange(stop.start, stop.end); updateCursor(); };
    const insertSnippet = (start, end, body) => {
      const src = textarea.value, indent = src.slice(src.lastIndexOf("\n", start-1)+1, start).match(/^[ \t]*/)[0], {text, stops, final} = expandSnippet(body, indent);
      beforeEdit(); textarea.setRangeText(text, start, end, "end");
      session = stops.length ? {stops:stops.map(s => ({start:start+s.start, end:start+s.end})), index:0, final:start+final, length:textarea.value.length} : null;
      if(session) { const stop = session.stops[0]; textarea.setSelectionRange(stop.start, stop.end); } else textarea.setSelectionRange(start+final, start+final);
      textarea.dispatchEvent(new Event("input",{bubbles:true}));
    };
    const trackSnippetEdit = () => {
      if(!session) return; const delta = textarea.value.length - session.length; session.length = textarea.value.length; if(!delta) return;
      const stop = session.stops[session.index], caret = textarea.selectionStart, oldEnd = stop.end;
      if(caret < stop.start || caret > oldEnd + Math.max(delta, 0)) { session = null; return; }
      stop.end += delta; for(const other of session.stops) if(other !== stop && other.start >= oldEnd) { other.start += delta; other.end += delta; }
      if(session.final >= oldEnd) session.final += delta;
    };
    const nextStop = back => {
      if(!session) return false; session.index += back ? -1 : 1;
      if(session.index < 0) session.index = 0;
      if(session.index >= session.stops.length) { const at = session.final; session = null; textarea.setSelectionRange(at, at); updateCursor(); return true; }
      selectStop(); return true;
    };
    const checkSnippetSession = () => {
      if(!session) return; const a = textarea.selectionStart, first = session.stops[0].start, lastStop = Math.max(session.final, ...session.stops.map(s => s.end));
      if(a < first || a > lastStop) session = null;
    };
    // ==== 자동 완성 ====
    // 순위: 접두어 일치 > 단어 경계(camelCase·_) 일치 > 연속 일치. 첫 글자는 이름의 시작이나 단어 경계와 맞아야 한다.
    const boundaryAt = (s, i) => i === 0 || s[i-1] === "_" || s[i-1] === "-" || (/[A-Z]/.test(s[i]) && /[a-z0-9]/.test(s[i-1])) || (/\d/.test(s[i]) && !/\d/.test(s[i-1]));
    const fuzzy = (label, query) => {
      if(!query) return {score:0, hits:[]};
      const lower = label.toLowerCase(), q = query.toLowerCase(), hits = []; let from = 0, score = 0, prev = -2;
      for(let k = 0; k < q.length; k++) {
        let i = lower.indexOf(q[k], from); if(i < 0) return null;
        if(i !== prev + 1) for(let j = i; j >= 0; j = lower.indexOf(q[k], j+1)) if(boundaryAt(label, j)) { i = j; break; }   // 경계 위치 우선
        score += i === prev + 1 ? 5 : boundaryAt(label, i) ? 3 : 0; if(label[i] === query[k]) score += 1;
        hits.push(i); prev = i; from = i + 1;
      }
      if(!boundaryAt(label, hits[0])) return null;
      if(lower.startsWith(q)) score += 30; if(label.startsWith(query)) score += 5;
      return {score:score - label.length * 0.05, hits};
    };
    const KIND_ORDER = {variable:0, field:0, function:1, uniform:2, constant:2, builtin:3, "builtin-var":3, type:4, keyword:5, snippet:6, library:7};
    const KIND_ICON = {variable:"x", field:"·", function:"ƒ", uniform:"u", constant:"#", builtin:"ƒ", "builtin-var":"g", type:"T", keyword:"k", snippet:"{}", library:"+"};
    const KIND_NAME = {variable:"변수", field:"필드", function:"이 패스의 함수", uniform:"Uniform", constant:"#define", builtin:"내장 함수", "builtin-var":"내장 변수", type:"타입", keyword:"키워드", snippet:"코드 템플릿", library:"코드 조각 모음"};
    // 스위즐: vecN 뒤의 '.'에서 x·y·z·w(rgba) 조합을 제안
    const swizzleItems = type => {
      const m = /^([biu]?)vec([234])$/.exec(type); if(!m) return [];
      const n = Number(m[2]), base = {b:"bool", i:"int", u:"uint", "":"float"}[m[1]], vec = k => k === 1 ? base : `${m[1]}vec${k}`;
      const set = ["x","y","z","w","xy","xz","yz","xyz","xyzw","r","g","b","a","rg","rgb","rgba","yx","zyx"];
      return set.filter(s => [...s].every(c => ("xyzw".indexOf(c) >= 0 ? "xyzw".indexOf(c) : "rgba".indexOf(c)) < n)).map(s => ({label:s, kind:"field", detail:vec(s.length), desc:`${type}의 성분 ${s}`}));
    };
    let shown = [], chosen = 0, wordStart = 0, wordEnd = 0;
    const completion = $("studioCompletion"), list = document.createElement("div"), docPane = document.createElement("div");
    list.className = "completion-list"; docPane.className = "completion-doc"; completion.replaceChildren(list, docPane);
    const hideCompletion = () => { completion.hidden = true; shown = []; };
    const gatherItems = (src, at, start) => {
      // 멤버 완성: 이름 뒤 '.' → 벡터 스위즐 또는 구조체 필드
      if(src[start-1] === ".") {
        const owner = src.slice(0, start-1).match(/([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*$/)?.[1]; if(!owner) return {items:[], member:true};
        const type = typeOf(owner, start), struct = symbolsOf(src).structs.get(type);
        return {member:true, items:struct ? struct.fields.map(f => ({label:f.name, kind:"field", detail:f.type, desc:`${type}의 필드`})) : swizzleItems(type)};
      }
      const sym = symbolsOf(src), items = [], seen = new Set(), add = item => { const key = `${item.kind === "snippet" ? "s" : "n"}:${item.label}`; if(!seen.has(key)) { seen.add(key); items.push(item); } };
      const nearest = new Map(); for(const v of sym.variables) if(v.offset < start || !nearest.has(v.name)) nearest.set(v.name, v);
      for(const v of nearest.values()) if(v.offset !== start) add({label:v.name, kind:v.uniform ? "uniform" : "variable", detail:`${v.uniform ? "uniform " : ""}${v.type}`, desc:APP_UNIFORMS.find(u => u[0] === v.name)?.[2] || `${v.line}번째 줄에서 선언`});
      for(const f of sym.functions) add({label:f.name, kind:"function", detail:`${f.ret} ${f.name}(${f.params})`, desc:`이 패스의 함수 · ${f.line}번째 줄`});
      for(const [name, s] of sym.structs) add({label:name, kind:"type", detail:"struct", desc:s.fields.map(f => `${f.type} ${f.name}`).join(" · ")});
      for(const d of sym.defines) add({label:d.name, kind:"constant", detail:`#define ${d.value}`.trim(), desc:`${d.line}번째 줄`});
      for(const u of userUniforms()) add({label:u.name, kind:"uniform", detail:`uniform ${u.type}`, desc:"파라미터 패널에 등록된 값 · 선언은 자동으로 추가됩니다"});
      for(const [name, type, desc, declare] of APP_UNIFORMS) add({label:name, kind:"uniform", detail:`uniform ${type}`, desc:`${desc} · 고르면 선언도 함께 추가합니다`, declare:declare || `uniform ${type} ${name};`});
      const builtins = options.builtins?.length ? options.builtins : [...highlighter.builtins].map(name => ({name, sig:"", desc:""}));   // 레퍼런스 없이 쓰일 때의 최소 목록
      for(const item of builtins) if(isIdent(item.name)) add({label:item.name, kind:item.name.startsWith("gl_") ? "builtin-var" : "builtin", detail:item.sig.split(" · ")[0], desc:item.desc, sig:item.sig});
      for(const name of TYPES) add({label:name, kind:"type", detail:"타입", desc:/^[biu]?vec|^mat/.test(name) ? "생성자로도 씁니다: " + name + "(…)" : ""});
      for(const name of KEYWORDS) add({label:name, kind:"keyword", detail:"키워드", desc:""});
      for(const s of SNIPPETS) add({label:s.label, kind:"snippet", detail:s.detail, desc:"Tab으로 다음 자리로 이동", body:s.body});
      const defined = new Set(sym.functions.map(f => f.name));
      for(const lib of options.library?.items || []) if(!defined.has(lib.name)) add({label:lib.name, kind:"library", detail:lib.title, desc:`${lib.desc} · 고르면 함수 정의(필요한 함수 포함)를 위쪽에 추가합니다`, id:lib.id});
      return {items, member:false};
    };
    // 선언 자리(타입 다음에 새 이름을 쓰는 중)에서는 저절로 띄우지 않는다.
    const declaringName = (src, start) => /(?:^|[\s(,;{])(?:(?:const|uniform|in|out|inout|highp|mediump|lowp)\s+)*(?:void|float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?|[iu]?sampler2D|struct|[A-Z]\w*)\s+$/.test(src.slice(Math.max(0, start-80), start));
    const showCompletion = (mode = "explicit") => {
      const at = textarea.selectionStart, src = textarea.value;
      if(at !== textarea.selectionEnd || codeMode(at) || /^[ \t]*#/.test(src.slice(src.lastIndexOf("\n", at-1)+1, at))) return hideCompletion();
      const prefix = src.slice(0, at).match(/[A-Za-z_]\w*$/)?.[0] || "", start = at - prefix.length;
      if(/\d/.test(src[start-1] || "")) return hideCompletion();
      if(src[start-1] === "." && /(?:^|[^\w])\d+$/.test(src.slice(0, start-1))) return hideCompletion();   // 1.5 같은 숫자 리터럴
      const {items, member} = gatherItems(src, at, start);
      if(mode === "auto" && !member && (!prefix || declaringName(src, start))) return hideCompletion();
      wordStart = start; wordEnd = at + (src.slice(at).match(/^\w*/)?.[0].length || 0);
      const word = src.slice(wordStart, wordEnd);
      // 멤버(스위즐·필드)는 입력 전에는 자연스러운 순서(x, y, xy …)를 그대로 쓴다.
      let ranked = items.map((item, order) => { const m = fuzzy(item.label, prefix); return m && {...item, ...m, score:m.score - (member && !prefix ? order * 0.01 : 0)}; }).filter(Boolean);
      // 이미 완성된 이름이고 그보다 긴 후보도 없으면 같은 이름의 템플릿만 남긴다(불필요한 목록을 띄우지 않음).
      if(prefix && ranked.some(item => item.label === word && item.kind !== "snippet") && !ranked.some(item => item.label !== word && item.label.startsWith(word)))
        ranked = ranked.filter(item => item.kind === "snippet" && item.label === word);
      // 일치 점수가 같으면 종류(이 파일의 이름 > Uniform > 내장 함수 > 타입 > 키워드 > 템플릿 > 조각 모음)가 순위를 정한다.
      const rank = item => item.score + (8 - KIND_ORDER[item.kind]) * 0.4;
      ranked.sort((a, b) => (rank(b) - rank(a)) || (a.label.length - b.label.length) || a.label.localeCompare(b.label));
      shown = ranked.slice(0, 60); if(!shown.length) return hideCompletion();
      chosen = 0; completion.hidden = false; renderCompletion(); placeCompletion();
    };
    const labelWithHits = (label, hits) => {
      const span = document.createElement("span"); span.className = "completion-label"; let run = null;
      [...label].forEach((ch, i) => { if(hits.includes(i)) { if(!run) { run = document.createElement("b"); span.append(run); } run.textContent += ch; } else { run = null; span.append(document.createTextNode(ch)); } });
      span.normalize?.(); return span;
    };
    const renderDoc = () => {
      const item = shown[chosen]; if(!item || (!item.desc && !item.body && !item.sig)) { docPane.hidden = true; return; }
      const head = document.createElement("div"); head.className = "completion-doc-head";
      const kind = document.createElement("span"); kind.textContent = KIND_NAME[item.kind]; head.append(kind);
      const code = document.createElement("code"); code.textContent = item.kind === "snippet" ? expandSnippet(item.body, "").text : (item.sig || item.detail);
      const desc = document.createElement("p"); desc.textContent = item.desc || "";
      docPane.replaceChildren(head, code, desc); docPane.hidden = false;
    };
    const renderCompletion = () => {
      list.replaceChildren(...shown.map((item, i) => {
        const button = document.createElement("button"); button.type = "button"; button.dataset.index = i; button.className = i === chosen ? "is-selected" : "";
        button.setAttribute("role","option"); button.setAttribute("aria-selected", String(i === chosen)); button.id = `studioCompletionItem${i}`;
        const icon = document.createElement("span"); icon.className = "completion-icon"; icon.dataset.kind = item.kind; icon.textContent = KIND_ICON[item.kind]; icon.title = KIND_NAME[item.kind];
        const detail = document.createElement("span"); detail.className = "completion-detail"; detail.textContent = item.detail || "";
        button.append(icon, labelWithHits(item.label, item.hits), detail); return button;
      }));
      textarea.setAttribute("aria-activedescendant", `studioCompletionItem${chosen}`);
      list.children[chosen]?.scrollIntoView?.({block:"nearest"}); renderDoc();
    };
    const moveChoice = step => { chosen = (chosen + step + shown.length) % shown.length; renderCompletion(); };
    // 목록은 단어 시작 위치 바로 아래(공간이 없으면 위)에, 설명 칸은 옆(좁으면 아래)에 둔다.
    const placeCompletion = () => {
      if(!surface) return; const coords = caretCoords(wordStart), narrow = surface.clientWidth < 620;
      completion.classList.toggle("doc-below", narrow);
      const width = completion.offsetWidth, height = completion.offsetHeight;
      completion.style.left = `${Math.max(4, Math.min(coords.left - 26, surface.clientWidth - width - 4))}px`;
      const below = coords.top + coords.height + 2, above = coords.top - height - 2;
      completion.style.top = `${below + height > surface.clientHeight && above >= 0 ? above : below}px`;
    };
    const declarationInsertAt = src => { const clean = cleanOf(src), m = /^[\s\S]*?\bprecision\s+\w+\s+float\s*;[^\n]*\n?/.exec(clean) || /^#version[^\n]*\n?/.exec(src); return m ? m[0].length : 0; };
    const acceptCompletion = () => {
      const item = shown[chosen]; if(completion.hidden || !item) return; hideCompletion(); textarea.removeAttribute("aria-activedescendant");
      if(item.kind === "snippet") return insertSnippet(wordStart, wordEnd, item.body);
      beforeEdit(); textarea.setRangeText(item.label, wordStart, wordEnd, "end");
      if(item.kind === "library" && options.library?.insert?.(item.id)) return;   // 함수 정의 삽입까지 한 번의 편집으로 반영
      if(item.declare && !new RegExp(`\\buniform\\s+\\w+\\s+${escapeRe(item.label)}\\b`).test(cleanOf(textarea.value))) {
        const at = declarationInsertAt(textarea.value); textarea.setRangeText(item.declare + "\n", at, at, "preserve");
        options.notify?.(`${item.label} 선언(${item.declare})을 맨 위에 함께 추가했습니다 · Ctrl+Z로 되돌리기`);
      }
      textarea.dispatchEvent(new Event("input",{bubbles:true})); updateCursor();
    };
    listen(completion,"pointerdown",event=>event.preventDefault());
    listen(completion,"click",event=>{const item=event.target.closest("button[data-index]");if(item){chosen=Number(item.dataset.index);acceptCompletion();textarea.focus();}});
    listen($("studioComplete"),"click",()=>{textarea.focus();showCompletion("explicit");});
    // ==== 이동·리팩터링: 정의로 이동(F12·Ctrl+클릭), 이름 바꾸기(F2), 줄 단위 편집 ====
    const selectRange = (start, end) => { textarea.focus(); textarea.setSelectionRange(start, end); if(!wrap) revealLine(lineAt(start)); updateLines(); };
    const definitionOf = (name, pos) => {
      const sym = symbolsOf(textarea.value), fn = sym.functions.find(f => f.name === name); if(fn) return fn.offset;
      const struct = sym.structs.get(name); if(struct) return struct.offset;
      const define = sym.defines.find(d => d.name === name); if(define) return define.offset;
      const vars = sym.variables.filter(v => v.name === name); if(!vars.length) return -1;
      return (vars.filter(v => v.offset <= pos).pop() || vars[0]).offset;
    };
    const goToDefinition = (pos = textarea.selectionStart) => {
      const found = wordAround(textarea.value, pos); if(!found) return false;
      const at = definitionOf(found.word, found.start);
      if(at < 0) { options.notify?.(options.lookup?.(found.word) ? `${found.word}은(는) 내장 함수입니다 · 마우스를 올리면 설명을 볼 수 있습니다` : `${found.word}의 정의를 이 패스에서 찾지 못했습니다`); return false; }
      selectRange(at, at + found.word.length); return true;
    };
    const renameSymbol = async () => {
      const found = wordAround(textarea.value, textarea.selectionStart); if(!found || KEYWORDS.includes(found.word) || TYPES.includes(found.word)) { options.notify?.("이름을 바꿀 변수나 함수 위에 커서를 두세요"); return; }
      const next = await ask({title:`'${found.word}' 이름 바꾸기`, message:"이 패스 안의 같은 이름을 모두 바꿉니다(주석·문자열과 '.' 뒤의 필드 이름은 제외).", value:found.word, label:"새 이름", ok:"바꾸기"});
      if(next === null || next === found.word) return;
      if(!isIdent(next) || KEYWORDS.includes(next) || TYPES.includes(next)) { options.notify?.(`'${next}'은(는) 쓸 수 없는 이름입니다`); return; }
      const src = textarea.value, clean = cleanOf(src), spots = [...clean.matchAll(new RegExp(`\\b${escapeRe(found.word)}\\b`, "g"))].map(m => m.index).filter(at => clean[at-1] !== ".");
      if(!spots.length) return; let out = "", last = 0; for(const at of spots) { out += src.slice(last, at) + next; last = at + found.word.length; } out += src.slice(last);
      const caret = textarea.selectionStart + spots.filter(at => at < textarea.selectionStart).length * (next.length - found.word.length);
      replaceSelection(out, 0, src.length); textarea.setSelectionRange(caret, caret); updateCursor();
      options.notify?.(`${found.word} → ${next} · ${spots.length}곳을 바꿨습니다 · Ctrl+Z로 되돌리기`);
    };
    const lineSpan = () => { const src = textarea.value, a = textarea.selectionStart, b = textarea.selectionEnd, last = b > a && src[b-1] === "\n" ? b-1 : b;
      const from = src.lastIndexOf("\n", a-1)+1, stop = src.indexOf("\n", last); return {src, from, to:stop < 0 ? src.length : stop}; };
    const deleteLines = () => {
      const {src, from, to} = lineSpan(), column = textarea.selectionStart - from, start = from > 0 && to === src.length ? from-1 : from, end = to < src.length ? to+1 : to;
      replaceSelection("", start, end); const next = Math.min(textarea.value.length, start + (start < from ? 1 : 0)), lineEnd = textarea.value.indexOf("\n", next);
      const caret = Math.min(next + column, lineEnd < 0 ? textarea.value.length : lineEnd); textarea.setSelectionRange(caret, caret); updateCursor();
    };
    const copyLines = down => {
      const {src, from, to} = lineSpan(), block = src.slice(from, to), a = textarea.selectionStart, b = textarea.selectionEnd;
      beforeEdit(); textarea.setRangeText(block + "\n", from, from, "preserve");
      if(down) textarea.setSelectionRange(a + block.length + 1, b + block.length + 1); else textarea.setSelectionRange(a, b);
      textarea.dispatchEvent(new Event("input",{bubbles:true}));
    };
    const selectLine = () => {
      const src = textarea.value, a = textarea.selectionStart, b = textarea.selectionEnd, from = src.lastIndexOf("\n", a-1)+1;
      const whole = a === from && (b === src.length || src[b-1] === "\n") && b > a, start = whole ? b : from, stop = src.indexOf("\n", start);
      textarea.setSelectionRange(whole ? from : from, stop < 0 ? src.length : stop+1); updateCursor();
    };
    const jumpToBracket = () => { const pair = matchBracket(textarea.value, textarea.selectionStart); if(!pair) return; const target = pair[0] === textarea.selectionStart || pair[0] === textarea.selectionStart-1 ? pair[1] : pair[0]; selectRange(target, target); };
    listen(textarea, "click", event => { if((event.ctrlKey || event.metaKey) && !event.altKey) { event.preventDefault(); goToDefinition(textarea.selectionStart); } });
    // ==== 명령 팔레트 (Ctrl+Shift+P · F1): 모든 명령을 이름으로 검색. '@'로 시작하면 심볼, ':'로 시작하면 줄 번호 ====
    const pane = textarea.closest(".studio-code-pane"), palette = document.createElement("div"), paletteInput = document.createElement("input"), paletteList = document.createElement("div");
    palette.className = "studio-palette"; palette.hidden = true; palette.setAttribute("role","dialog"); palette.setAttribute("aria-label","명령 팔레트");
    paletteInput.className = "studio-palette-input"; paletteInput.placeholder = "명령 검색 · @ 함수·변수로 이동 · : 줄 번호"; paletteInput.setAttribute("aria-label","명령 검색"); paletteInput.autocomplete = "off"; paletteInput.spellcheck = false;
    paletteList.className = "studio-palette-list"; paletteList.setAttribute("role","listbox"); palette.append(paletteInput, paletteList); pane?.append(palette);
    let commands = [], recent = [], paletteItems = [], paletteChoice = 0;
    const registerCommands = items => { commands = [...commands, ...items.filter(item => item && item.label && typeof item.run === "function")]; };
    const paletteEntries = () => {
      const value = paletteInput.value;
      if(value.startsWith(":")) { const line = Number(value.slice(1).trim()), total = lineAt(textarea.value.length);
        return [{label:Number.isInteger(line) && line > 0 ? `${Math.min(line, total)}번째 줄로 이동` : `이동할 줄 번호를 입력하세요 (1~${total})`, query:"", run:() => { if(line > 0) goToLine(Math.min(line, total)); }}]; }
      if(value.startsWith("@")) { const sym = symbolsOf(textarea.value), query = value.slice(1).trim();
        const all = [...sym.functions.map(f => ({label:f.name, hint:`ƒ ${f.ret} (${f.params})`, key:`${f.line}줄`, offset:f.offset})),
          ...[...sym.structs].map(([name, s]) => ({label:name, hint:"struct", key:`${s.line}줄`, offset:s.offset})),
          ...sym.defines.map(d => ({label:d.name, hint:"#define", key:`${d.line}줄`, offset:d.offset})),
          ...sym.variables.filter(v => v.uniform || v.output).map(v => ({label:v.name, hint:`${v.uniform ? "uniform" : "out"} ${v.type}`, key:`${v.line}줄`, offset:v.offset}))]
          .map(item => ({...item, run:() => selectRange(item.offset, item.offset + item.label.length)}));
        return {items:all, query}; }
      const query = value.startsWith(">") ? value.slice(1).trim() : value.trim();
      const ordered = query ? commands : [...recent.map(label => commands.find(c => c.label === label)).filter(Boolean), ...commands.filter(c => !recent.includes(c.label))];
      return {items:ordered, query};
    };
    const renderPalette = () => {
      const entries = paletteEntries(), items = Array.isArray(entries) ? entries : entries.items, query = Array.isArray(entries) ? "" : entries.query;
      paletteItems = (query ? items.map(item => { const m = fuzzy(item.label, query) || (item.hint && fuzzy(item.hint, query) && {score:-50, hits:[]}); return m && {...item, ...m}; }).filter(Boolean).sort((a, b) => b.score - a.score) : items.map(item => ({...item, hits:[]}))).slice(0, 80);
      paletteChoice = Math.min(paletteChoice, Math.max(0, paletteItems.length-1));
      paletteList.replaceChildren(...paletteItems.map((item, i) => {
        const button = document.createElement("button"); button.type = "button"; button.dataset.index = i; button.className = i === paletteChoice ? "is-selected" : ""; button.setAttribute("role","option"); button.setAttribute("aria-selected", String(i === paletteChoice));
        const label = labelWithHits(item.label, item.hits || []); const hint = document.createElement("span"); hint.className = "palette-hint"; hint.textContent = item.hint || (recent.includes(item.label) && !paletteInput.value ? "최근 사용" : "");
        button.append(label, hint); if(item.key) { const kbd = document.createElement("kbd"); kbd.textContent = item.key; button.append(kbd); } return button;
      }));
      if(!paletteItems.length) { const empty = document.createElement("p"); empty.className = "palette-empty"; empty.textContent = "일치하는 항목이 없습니다"; paletteList.append(empty); }
      paletteList.children[paletteChoice]?.scrollIntoView?.({block:"nearest"});
    };
    const openPalette = (prefix = "") => { hideCompletion(); palette.hidden = false; paletteInput.value = prefix; paletteChoice = 0; renderPalette(); paletteInput.focus(); };
    const closePalette = (refocus = true) => { if(palette.hidden) return; palette.hidden = true; if(refocus) textarea.focus(); };
    const runPaletteItem = index => {
      const item = paletteItems[index]; if(!item) return; closePalette(); textarea.focus();
      if(commands.includes(commands.find(c => c.label === item.label))) recent = [item.label, ...recent.filter(label => label !== item.label)].slice(0, 5);
      item.run();
    };
    listen(paletteInput, "input", () => { paletteChoice = 0; renderPalette(); });
    listen(paletteInput, "keydown", event => {
      if(event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if(paletteItems.length) { paletteChoice = (paletteChoice + (event.key === "ArrowDown" ? 1 : -1) + paletteItems.length) % paletteItems.length; renderPalette(); } }
      else if(event.key === "Enter") { event.preventDefault(); runPaletteItem(paletteChoice); }
      else if(event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePalette(); }
    });
    listen(paletteInput, "blur", () => setTimeout(() => { if(!palette.contains(document.activeElement)) closePalette(false); }, 0));
    listen(paletteList, "pointerdown", event => event.preventDefault());
    listen(paletteList, "click", event => { const item = event.target.closest("button[data-index]"); if(item) runPaletteItem(Number(item.dataset.index)); });
    listen($("studioPaletteOpen"), "click", () => openPalette());
    // 편집기가 열려 있으면 포커스가 코드 밖에 있어도 팔레트를 연다.
    listen(document, "keydown", event => {
      const open = (event.key === "F1" || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyP")) && textarea.offsetParent;
      if(open) { event.preventDefault(); event.stopPropagation(); openPalette(); }
    });
    registerCommands([
      {label:"자동 완성 열기", key:"Ctrl+Space", run:() => showCompletion("explicit")},
      {label:"찾기", key:"Ctrl+F", run:() => showFind()}, {label:"찾아 바꾸기", key:"Ctrl+H", run:() => showFind(true)},
      {label:"줄 번호로 이동", key:"Ctrl+G", run:() => openPalette(":")}, {label:"함수·변수로 이동", key:"Ctrl+Shift+O", run:() => openPalette("@")},
      {label:"정의로 이동", key:"F12", run:() => goToDefinition()}, {label:"이름 바꾸기 (같은 이름 모두)", key:"F2", run:renameSymbol},
      {label:"줄 주석 전환", key:"Ctrl+/", run:toggleComment}, {label:"줄 삭제", key:"Ctrl+Shift+K", run:deleteLines},
      {label:"줄을 아래로 복사", key:"Shift+Alt+↓", run:() => copyLines(true)}, {label:"줄을 위로 복사", key:"Shift+Alt+↑", run:() => copyLines(false)},
      {label:"줄을 아래로 이동", key:"Alt+↓", run:() => moveLines(true)}, {label:"줄을 위로 이동", key:"Alt+↑", run:() => moveLines(false)},
      {label:"줄 선택", key:"Ctrl+L", run:selectLine}, {label:"짝 괄호로 이동", key:"Ctrl+Shift+\\", run:jumpToBracket},
      {label:"들여쓰기", key:"Ctrl+]", run:() => indent(false, true)}, {label:"내어쓰기", key:"Ctrl+[", run:() => indent(true, true)},
      {label:"긴 줄 자동 줄바꿈 켜기/끄기", key:"Alt+Z", run:() => { wrap = !wrap; setPresentation(); }},
      {label:"글자 크게", run:() => { fontSize = Math.min(20, fontSize+1); setPresentation(); }}, {label:"글자 작게", run:() => { fontSize = Math.max(10, fontSize-1); setPresentation(); }},
      {label:"들여쓰기 크기 2 ↔ 4 바꾸기", run:() => { tabSize = tabSize === 4 ? 2 : 4; setPresentation(); }}]);
    listen(textarea,'blur',()=>{hideCompletion();hideSignature();hideHover();});listen(textarea,'click',hideCompletion);
    // 입력할 때: 이름 글자나 '.'을 치면 자동 완성을 띄우고, 지우면 목록을 갱신한다(VS Code의 빠른 제안).
    // 편집기가 직접 고친 내용(inputType 없음)·붙여넣기·여러 글자 입력은 목록을 닫는다.
    listen(textarea,'input',event=>{
      trackSnippetEdit();if(diagnostics.length)layer?.classList?.add("is-stale");updateLines();if(!findPanel.hidden)updateMatches();
      const type=event.inputType||"",data=event.data;
      if(type==="insertText"&&data&&data.length===1&&/[\w.]/.test(data))showCompletion("auto");
      else if(type.startsWith("deleteContent")&&!completion.hidden)showCompletion("auto");
      else hideCompletion();
    });
    listen(textarea,"scroll",()=>{gutter.scrollTop=textarea.scrollTop;
      highlight.scrollTop=textarea.scrollTop;highlight.scrollLeft=textarea.scrollLeft;if(diagnostics.length)renderDiagnostics();
      hideHover();scheduleDecorations();if(!completion.hidden)placeCompletion();if(!signature?.hidden)updateSignature();});
    for(const type of ["click","keyup","select"])listen(textarea,type,updateCursor);
    listen(gutter,"click",e=>{const height=parseFloat(getComputedStyle(textarea).lineHeight)||fontSize*1.6;
      goToLine(Math.floor((e.clientY-gutter.getBoundingClientRect().top+gutter.scrollTop)/height)+1);
    }); listen(textarea,"keydown",event=>{
      if(event.isComposing)return;const cmd=event.ctrlKey||event.metaKey, start=textarea.selectionStart,end=textarea.selectionEnd,src=textarea.value;
      if(!completion.hidden && ['ArrowDown','ArrowUp','PageDown','PageUp','Enter','Tab','Escape'].includes(event.key) && !cmd && !event.altKey) {
        event.preventDefault();if(event.key==='Escape')hideCompletion();else if(event.key==='Enter'||event.key==='Tab')acceptCompletion();
        else if(event.key.startsWith('Page')){chosen=event.key==='PageDown'?Math.min(shown.length-1,chosen+8):Math.max(0,chosen-8);renderCompletion();}
        else moveChoice(event.key==='ArrowDown'?1:-1);
      } else if(session && event.key==="Tab" && !cmd && !event.altKey) {
        event.preventDefault();nextStop(event.shiftKey);
      } else if(session && event.key==="Escape") {
        session=null;
      } else if(cmd && !event.altKey && !event.shiftKey && event.code==='Space') {
        event.preventDefault();showCompletion("explicit");
      } else if(event.key==="F12" || (event.key==="F2" && !cmd)) {
        event.preventDefault();if(event.key==="F12")goToDefinition();else renameSymbol();
      } else if(cmd && event.shiftKey && !event.altKey && event.code==="KeyK") {
        event.preventDefault();deleteLines();
      } else if(cmd && event.shiftKey && !event.altKey && event.code==="KeyO") {
        event.preventDefault();openPalette("@");
      } else if(cmd && event.shiftKey && !event.altKey && event.code==="Backslash") {
        event.preventDefault();jumpToBracket();
      } else if(cmd && !event.shiftKey && !event.altKey && event.code==="KeyL") {
        event.preventDefault();selectLine();
      } else if(event.altKey && !cmd && !event.shiftKey && event.code==="KeyZ") {
        event.preventDefault();wrap=!wrap;setPresentation();
      } else if(event.altKey && event.shiftKey && !cmd && ["ArrowUp","ArrowDown"].includes(event.key)) {
        event.preventDefault();copyLines(event.key==="ArrowDown");
      } else if(cmd && !event.altKey && ["ArrowUp","ArrowDown"].includes(event.key) && nudgeNumber(event.key==="ArrowUp"?1:-1, event.shiftKey?10:1)) {
        event.preventDefault();
      } else if(event.altKey && !cmd && !event.shiftKey && ["ArrowUp","ArrowDown"].includes(event.key)) {
        event.preventDefault();moveLines(event.key==="ArrowDown");
      } else if(!cmd && !event.altKey && Object.hasOwn(pairs,event.key)) {
        const key=event.key,mode=codeMode(start),selected=src.slice(start,end);
        if(!mode && !(key==='"'&&src[start]==='"'&&start===end)) {
          event.preventDefault();replaceSelection(key+selected+pairs[key]);textarea.setSelectionRange(start+1,start+1+selected.length);updateCursor();
        } else if(key==='"'&&mode==="string"&&src[start]==='"'&&start===end){event.preventDefault();textarea.setSelectionRange(start+1,start+1);updateCursor();}
      } else if(event.key==="}" && !cmd && !event.altKey && start===end && /^[ \t]+$/.test(src.slice(src.lastIndexOf("\n",start-1)+1,start)) && !codeMode(start)) {
        const prefix=src.slice(src.lastIndexOf("\n",start-1)+1,start),cut=prefix.match(new RegExp(`(?: {1,${tabSize}}|\\t)$`))[0].length,skip=src[start]==="}";
        event.preventDefault();replaceSelection(skip?"":"}",start-cut,start);
        if(skip)textarea.setSelectionRange(start-cut+1,start-cut+1);updateCursor();
      } else if(!cmd && !event.altKey && start===end && ")]}".includes(event.key) && src[start]===event.key && !codeMode(start)) {
        event.preventDefault();textarea.setSelectionRange(start+1,start+1);updateCursor();
      } else if(event.key==="Enter" && !cmd && !event.shiftKey && !event.altKey) {
        const before=src.slice(0,start).split("\n").pop(),base=before.match(/^[ \t]*/)[0],opens=!codeMode(start)&&/{[ \t]*$/.test(before),pad=base+(opens?" ".repeat(tabSize):"");
        const tail=src.slice(start).split("\n")[0],after=tail.match(/^[ \t]*/)[0].length,trim=opens?before.match(/[ \t]*$/)[0].length:0;
        if(start===end && opens && tail.slice(after).startsWith("}")){event.preventDefault();replaceSelection("\n"+pad+"\n"+base,start-trim,start+after);textarea.setSelectionRange(start-trim+1+pad.length,start-trim+1+pad.length);updateCursor();}
        else if(pad){event.preventDefault();replaceSelection("\n"+pad,start-trim,end);}
      } else if(cmd && event.shiftKey && event.key.toLowerCase()==="d") {
        event.preventDefault();const src=textarea.value,p=textarea.selectionStart;
        const start=src.lastIndexOf("\n",p-1)+1,next=src.indexOf("\n",p),end=next<0?src.length:next;
        beforeEdit();textarea.setRangeText("\n"+src.slice(start,end),end,end,"end"); const caret=end+1+p-start;textarea.setSelectionRange(caret,caret);
        textarea.dispatchEvent(new Event("input",{bubbles:true}));
      } else if(event.key==="Backspace" && !cmd && !event.altKey && start===end) {
        const left=src.slice(src.lastIndexOf("\n",end-1)+1,end);
        if(end>0 && pairs[src[end-1]]===src[end] && !codeMode(end-1)){event.preventDefault();replaceSelection("",end-1,end+1);}
        else if(left && /^ +$/.test(left)) {event.preventDefault();replaceSelection("",end-Math.min(left.length,tabSize),end);}
      } else if(event.key==="Home" && !event.shiftKey && !cmd && !event.altKey) {
        const p=textarea.selectionStart, start=textarea.value.lastIndexOf("\n",p-1)+1;
        const indentEnd=start+(textarea.value.slice(start).match(/^[ \t]*/)?.[0].length||0);
        event.preventDefault();textarea.setSelectionRange(p===indentEnd?start:indentEnd,p===indentEnd?start:indentEnd);updateCursor();
      } else if(event.key==="Tab" || (cmd && ["BracketLeft","BracketRight"].includes(event.code))) {
        event.preventDefault();indent(event.key==="Tab"?event.shiftKey:event.code==="BracketLeft",event.key!=="Tab");
      } else if(cmd&&event.key==="/") {event.preventDefault();toggleComment();}
      else if(cmd&&event.key.toLowerCase()==="f") {event.preventDefault();showFind();}
      else if(cmd&&event.key.toLowerCase()==="h") {event.preventDefault();showFind(true);}
      else if(cmd&&event.key.toLowerCase()==="g") {event.preventDefault();$("studioGoto").click();}
      else if(event.key==="F3") {event.preventDefault();findNext(event.shiftKey);}
    });
    listen(query,"input",updateMatches); listen(query,"keydown",event=>{if(event.key==="Enter"){event.preventDefault();findNext(event.shiftKey);}if(event.key==="Escape")closeFind();});
    listen(replacement,"keydown",event=>{if(event.key==="Enter"){event.preventDefault();doReplace(false);}if(event.key==="Escape")closeFind();});
    listen($("studioFindClose"),"click",closeFind);listen($("studioFindNext"),"click",()=>findNext(false));
    listen($("studioFindPrev"),"click",()=>findNext(true));listen($("studioReplaceOne"),"click",()=>doReplace(false));
    listen($("studioReplaceAll"),"click",()=>doReplace(true));
    listen($("studioFind"),"click",()=>showFind());listen($("studioReplace"),"click",()=>showFind(true));
    listen(symbols,"change",()=>{if(symbols.value)goToLine(Number(symbols.value));symbols.value="";});
    listen($("studioGoto"),"click",async()=>{const input=await ask({title:"줄 번호로 이동",message:"이동할 줄을 입력하세요.",value:String(lineAt(textarea.selectionStart)),label:"줄 번호",type:"number",min:1,max:lineAt(textarea.value.length),ok:"이동"});if(input!==null)goToLine(Number(input));});
    listen($("studioZoomIn"),"click",()=>{fontSize=Math.min(20,fontSize+1);setPresentation();});
    listen($("studioZoomOut"),"click",()=>{fontSize=Math.max(10,fontSize-1);setPresentation();});
    listen($("studioLineWrap"),"click",()=>{wrap=!wrap;setPresentation();});
    listen($("studioIndent"),"change",event=>{tabSize=event.target.value==="2"?2:4;setPresentation();});setPresentation();
    return {update:()=>{hideCompletion();session=null;updateLines();renderDiagnostics();},goToLine,showFind,setDiagnostics,registerCommands,openPalette,
      dispose:()=>{hideCompletion();hideHover();ac.abort();if(paintRequest)cancelAnimationFrame(paintRequest);clearTimeout(decoRequest);
        for(const node of [palette,hover,mirror,decorations])node.remove?.();}};
  }; return {mount};
})(glsl_highlight);
const annotations=(()=>{
// GLSL 주석 어노테이션 → 파라미터 정의. DOM·GPU에 의존하지 않는 순수 파서다.
// 형식: uniform <type> <name>; // @range <min> <max> [step] @min <v> @max <v> @step <v> @default <v...> @color
// 같은 줄의 단일 선언만 인식한다. 값 검증(타입·범위)은 Renderer.normalizeEntry가 최종 판단한다.
  const DECLARATION = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;\s*\/\/(.*)$/;
  const SIZES = {float:1,int:1,uint:1,bool:1,vec2:2,vec3:3,vec4:4,ivec2:2,ivec3:3,ivec4:4,uvec2:2,uvec3:3,uvec4:4,bvec2:2,bvec3:3,bvec4:4,mat2:4,mat3:9,mat4:16};
  const kindOf = type => type.startsWith("b") ? "b" : type.startsWith("mat") ? "m" : /^(int|ivec)/.test(type) ? "i" : /^(uint|uvec)/.test(type) ? "u" : "f";
  const parseLine = line => {
    const match = DECLARATION.exec(line); if(!match || !match[3].includes("@")) return null;
    const [, type, name, comment] = match; if(!Object.hasOwn(SIZES, type)) return null;
    const tags = {}; let error = null;
    for(const part of comment.split("@").slice(1)) {
      const [key, ...args] = part.trim().split(/[\s,]+/).filter(Boolean); if(!key) continue;
      tags[key.toLowerCase()] = args;
    }
    const n = SIZES[type], kind = kindOf(type), num = value => Number(value), options = {};
    if(tags.range) { [options.min, options.max] = tags.range.map(num); if(tags.range[2] !== undefined) options.step = num(tags.range[2]); }
    if(tags.min) options.min = num(tags.min[0]); if(tags.max) options.max = num(tags.max[0]); if(tags.step) options.step = num(tags.step[0]);
    if(options.min !== undefined || options.max !== undefined) {
      if(!Number.isFinite(options.min) || !Number.isFinite(options.max)) error = "@range에는 min과 max 숫자가 모두 필요합니다.";
      options.step ??= kind === "f" ? Number(((options.max - options.min) / 1000).toPrecision(2)) || 0.001 : 1;
    }
    if(tags.color !== undefined) options.color = true;
    let value;
    if(tags.default) {
      const raw = tags.default.slice(0, n);
      value = kind === "b" ? raw.map(v => v === "true" || v === "1") : raw.map(num);
      if(raw.length === 1 && n > 1) value = Array(n).fill(value[0]); // @default 0.5 → 모든 성분
      if(value.length !== n) error = `@default에는 값 ${n}개가 필요합니다.`;
    } else if(kind === "m") { const dim = Math.round(Math.sqrt(n)); value = Array.from({length:n}, (_, i) => i % (dim + 1) === 0 ? 1 : 0); }
    else if(kind === "b") value = Array(n).fill(false);
    else if(options.color) value = Array(n).fill(1);
    else value = Array(n).fill(options.min !== undefined ? Math.min(Math.max(0, options.min), options.max) : 0);
    return {name, type, value:n === 1 ? value[0] : value, options, error};
  };
  // 여러 패스의 소스를 받아 이름별 첫 정의만 남긴다(Image가 앞에 오도록 호출한다).
  const collect = sources => {
    const found = new Map();
    for(const source of sources) if(typeof source === "string") for(const line of source.split("\n")) {
      const item = parseLine(line); if(item && !found.has(item.name)) found.set(item.name, item);
    }
    return [...found.values()];
  };
  // 범위가 바뀌었을 때 기존 값을 새 범위 안으로 끌어들인다.
  const clampValue = (value, options) => {
    if(!Number.isFinite(options.min) || !Number.isFinite(options.max)) return value;
    const clamp = v => typeof v === "number" ? Math.min(options.max, Math.max(options.min, v)) : v;
    return Array.isArray(value) ? value.map(clamp) : clamp(value);
  };
  const sameOptions = (a = {}, b = {}) => ["min","max","step","color"].every(key => a[key] === b[key]);
  return {parseLine,collect,clampValue,sameOptions};
})();
const studio=((CodeEditor, Annotations)=>{
// 사용자 편집 상태만 소유한다. GPU 자원과 연결 규칙은 Renderer/PassManager가 검증한다.
// 외부 코드 에디터나 네트워크 요청은 사용하지 않는다. file:// 배포는 deploy/ 번들을 사용한다.


  const STORAGE_KEY = "webgl.shader-studio.project.v1", DRAFT_KEY = "webgl.shader-studio.draft.v2", JSON_LIMIT=16*1024*1024, PACK_LIMIT=64*1024*1024; const copy = x => x && typeof x==="object" ? Array.isArray(x) ? x.map(copy) : Object.fromEntries(Object.entries(x).map(([k,v])=>[k,copy(v)])) : x;
    const comparison = `#version 300 es
precision highp float;
// Image: iChannel0 = B (current), iChannel1 = A (current).
// 왼쪽은 A 원본, 오른쪽은 B 처리 결과. 각 화면에 같은 UV를 사용한다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    bool original = uv.x < 0.5;
    uv.x = fract(uv.x * 2.0);
    vec3 color = original ? texture(iChannel1, uv).rgb : texture(iChannel0, uv).rgb;
    fragColor = vec4(color, 1.0);
}`;
    const blank = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    fragColor = vec4(uv, 0.5 + 0.5 * sin(uTime), 1.0);
}`;
    const movingDot = `#version 300 es
precision highp float;
// Buffer A: 외부 입력 없이 움직이는 원을 만든다. B가 A의 current를 읽는다.
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;
void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec2 center = 0.5 * vec2(cos(uTime), sin(uTime * 1.4));
    float dotMask = 1.0 - smoothstep(0.09, 0.11, length(p - center));
    fragColor = vec4(vec3(0.1, 0.65, 1.0) * dotMask, 1.0);
}`;
    const colorFilter = `#version 300 es
precision highp float;
// Buffer B: iChannel0 = A (current). 반드시 A 다음에 실행한다.
// A의 이번 프레임 결과를 읽어 RGB 순서를 바꾼다. 자기 자신은 읽지 않는다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 source = texture(iChannel0, uv).rgb;
    fragColor = vec4(source.brg, 1.0);
}`;
    const feedback = `#version 300 es
precision highp float;
// Buffer B: iChannel0 = A (current), iChannel1 = B (previous).
// A의 새 원을 현재 프레임에서 읽고, B의 직전 프레임에 남은 잔상과 합친다.
// B를 current로 자기 참조하면 안 된다. previous는 별도 Texture를 읽는다.
uniform vec2 uResolution;
uniform float uDeltaTime;
uniform int uFrame;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 source = texture(iChannel0, uv).rgb;
    // 첫 프레임에는 이전 누적 결과를 사용하지 않는다. Reset으로 다시 시작한다.
    vec3 history = uFrame == 0 ? vec3(0.0) : texture(iChannel1, uv).rgb;
    // 초 단위로 밝기를 줄이되, RGBA8에서 반올림되어 잔상이 고착되지 않게 최소 1단계 감쇠한다.
    float fade = max(0.8 * uDeltaTime, 1.0 / 255.0);
    fragColor = vec4(max(source, history - fade), 1.0);
}`;
  // options.lookup(name): 내장 함수 설명 {sig, desc} 또는 null — 편집기 시그니처 힌트에 쓴다(main.js가 레퍼런스에서 만들어 넘긴다).
  const mount = (renderer, Shader, settings = null, options = {}) => {
    const $ = id => document.getElementById(id); const controller = new AbortController(), signal = controller.signal;
    const element = tag => document.createElement(tag);
    const on = (target, type, callback) => target.addEventListener(type, callback, {signal}); const original = Shader.fragment;
    const snapshot = () => ({image:renderer.getFragmentSource(),passes:renderer.getPassDefinitions(),imageChannels:renderer.getImageChannels()});
    let textureButtons=[];let project = snapshot(); let selected = "Image", timer = null, draftTimer = null, dirty = false, compileFailed = false, changeText = "", openState = false, disposed = false;
    // One native dialog serves input and confirmation requests; no window.prompt/confirm is used.
    const dialog=$("studioPromptDialog"), form=$("studioDialogForm"), field=$("studioDialogField"), valueInput=$("studioDialogInput"); let pending=null;
    const finish = accepted => {
      if(!pending)return; if(accepted&&pending.hasValue&&!valueInput.reportValidity())return;
      const {resolve,hasValue,wasLive}=pending;pending=null;dialog.close();
      if(wasLive&&dirty&&!disposed&&$("studioLive").checked)timer=setTimeout(apply,900);
      resolve(accepted?(hasValue?valueInput.value:true):(hasValue?null:false));
    };
    on(form,"submit",event=>{event.preventDefault();finish(true);});
    on($("studioDialogCancel"),"click",()=>finish(false));on($("studioDialogClose"),"click",()=>finish(false));
    on(dialog,"cancel",event=>{event.preventDefault();finish(false);});on(dialog,"close",()=>{if(!dialog.open)finish(false);});
    on(dialog,"click",event=>{if(event.target===dialog)finish(false);});on(dialog,"keydown",event=>{event.stopPropagation();if(event.key!=="Enter"||event.isComposing||event.keyCode===229)return;
      event.preventDefault();if(!event.repeat&&!event.ctrlKey&&!event.metaKey&&!event.altKey)finish(true);});
    const ask = ({title,message="",value,ok="확인",danger=false,label="값",type="text",min,max}) => new Promise(resolve=>{
      const hasValue=value!==undefined;if(pending)return resolve(hasValue?null:false);
      $("studioDialogTitle").textContent=title;$("studioDialogMessage").textContent=message;
      $("studioDialogOK").firstChild.textContent=ok+" ";dialog.dataset.danger=String(danger);
      field.hidden=!hasValue;valueInput.disabled=!hasValue;if(hasValue) {field.firstChild.textContent=label;valueInput.type=type;valueInput.value=String(value);
        if(min===undefined)valueInput.removeAttribute("min");else valueInput.min=String(min);
        if(max===undefined)valueInput.removeAttribute("max");else valueInput.max=String(max);
        valueInput.required=true;
      } const wasLive=!!timer;if(timer){clearTimeout(timer);timer=null;}pending={resolve,hasValue,wasLive};
      try{dialog.showModal();(hasValue?valueInput:$("studioDialogCancel")).focus();if(hasValue)valueInput.select();}
      catch(error){pending=null;if(wasLive&&dirty&&!disposed)timer=setTimeout(apply,900);resolve(hasValue?null:false);}
    });
    const proceed = (decision,action) => decision instanceof Promise?decision.then(ok=>ok&&action()):decision&&action();
    const defaultHeight=window.matchMedia("(max-width:600px), (max-height:650px)").matches?75:55;let expanded = false, resumeAfterMaximize = false, dockHeight = defaultHeight, navigatingHistory = false; const undoStack = [], redoStack = [], views = new Map();
    const syncHistory = () => { $("studioUndo").disabled = !undoStack.length; $("studioRedo").disabled = !redoStack.length; };
    const cursorState = () => {const area=$("studioCode");return {caret:[area.selectionStart,area.selectionEnd,area.selectionDirection],scroll:[area.scrollTop,area.scrollLeft]};};
    const historyState = () => ({project:copy(project),users:renderer.getUserUniforms(),selected,...cursorState()});
    let checkpoint = historyState(), editTime = 0, editTab = "";
    const recordEdit = (typing = false, usersChanged = false) => {
      if(navigatingHistory)return;const current=historyState();if(!usersChanged)checkpoint.users=current.users;if(same(current.project,checkpoint.project)&&same(current.users,checkpoint.users))return;
      const now=Date.now(),group=typing && editTab===selected && now-editTime<700 && undoStack.length;
      if(!group){undoStack.push(checkpoint);if(undoStack.length>25)undoStack.shift();}
      redoStack.length=0;checkpoint=current;editTime=typing?now:0;editTab=selected;syncHistory();
    };
    const captureCursor = () => {if(!navigatingHistory && selected===checkpoint.selected && same(project,checkpoint.project)) Object.assign(checkpoint,cursorState());};
    // 숫자 끌어 바꾸기(Alt+드래그) 중에는 자동 적용 대기(0.9초) 없이 짧은 간격으로 바로 적용해 화면이 따라오게 한다.
    let scrubTimer = 0;
    const scrubApply = () => { if(scrubTimer) return; scrubTimer = setTimeout(() => { scrubTimer = 0; if(!disposed) apply(); }, 60); };
    // 자동 완성에서 코드 조각 함수를 고르면 필요한 함수 정의를 전역 위치에 넣는다(이름 입력과 함께 Undo 한 번).
    const library = options.snippets ? {items:options.snippets.items, insert:id => {
      const item = options.snippets.items.find(entry => entry.id === id), plan = options.snippets.plan(id, $("studioCode").value);
      const global = plan.globals.map(entry => entry.code).join("\n\n"); if(!global) return false;
      return insertCode({global, note:`코드 조각 '${item?.title || id}' 정의를 위쪽에 추가했습니다${plan.added.length ? ` (+ ${plan.added.join(", ")})` : ""} · Ctrl+Z로 되돌리기`});
    }} : null;
    const editor = CodeEditor.mount($("studioCode"),ask,captureCursor,()=>renderer.getUserUniforms().map(item=>item.name),{lookup:options.lookup,builtins:options.builtins,library,
      userUniforms:()=>renderer.getUserUniforms().map(item=>({name:item.name,type:item.type})),onScrub:scrubApply,notify:text=>setStatus(text,"is-dirty")});
    for(const type of ["beforeinput","select","click","keyup","scroll"])on($("studioCode"),type,captureCursor);
    // 사용자가 직접 정한 높이·배치만 저장한다. 정하기 전에는 창 크기(반·4분할 창 포함)에 맞는 기본값을 따른다.
    let heightChosen = false, layoutChosen = false;
    try { const storedHeight = Number(localStorage.getItem("webgl.shader-studio.height.v2")); heightChosen = storedHeight > 0; dockHeight = Math.max(25,Math.min(85,storedHeight||defaultHeight)); } catch (_) {}
    $("studioDock").style.setProperty("--studio-height",`${dockHeight}%`);
    const find = name => name === "Image" ? null : project.passes.find(p => p.name === name);
    const clearChange = () => {changeText="";$("studioChangeNotice").hidden=true;};
    const showChange = text => {changeText=text;$("studioChangeText").textContent=text+(dirty?" · 미적용 변경":"");$("studioChangeNotice").hidden=false;};
    const setStorage = (state,text,detail="") => {const node=$("studioStorageState");node.dataset.state=state;node.textContent=text;node.title=`${detail?detail+" · ":""}브라우저 보관은 소스·채널 구성만 포함합니다. 전체 작업은 Pack으로 내보내세요.`;};
    const references = name => [...project.passes,{name:"Image",channels:project.imageChannels}].filter(p=>p.name!==name).flatMap(p=>Object.entries(p.channels).filter(([,ref])=>ref.buffer===name).map(([channel])=>`${p.name}.iChannel${channel}`));
    const activeSource = () => selected === "Image" ? project.image : find(selected)?.fragment; const setStatus = (message, style = "") => {
      if($("studioMessage").textContent!==message)$("studioMessage").textContent=message;$("studioMessage").title=message; $("studioMessage").className = style;
      const state=dirty&&compileFailed?"error":dirty?"dirty":"applied",label=state==="error"?"오류 확인":dirty?"미적용 변경":"실행 반영됨";
      if($("studioState").textContent!==label)$("studioState").textContent=label;$("studioState").dataset.state=state;$("studioRun").dataset.pending=String(dirty);
      $("studioGraphState").textContent=dirty?"편집 중인 구성 · 실행 반영 대기":"실행에 반영된 구성";if(changeText)showChange(changeText);$("previewNotice").hidden=!dirty;$("previewNotice").textContent=state==="error"?"코드를 적용하지 못했습니다. 화면은 마지막 성공 결과입니다.":"미적용 변경이 있습니다. 화면은 마지막 성공 결과입니다.";
    };
    // 편집기 인라인 진단(패스별). 컴파일 성공 시 비우고, 탭 전환 시 해당 패스 항목만 보여준다.
    let diagnostics = []; const syncDiagnostics = () => editor.setDiagnostics?.(diagnostics.filter(item=>item.pass===selected));
    // keepInline: 타이핑 중에는 인라인 진단을 지우지 않고 편집기가 흐리게(stale) 유지한다. 다음 컴파일 결과가 대체한다.
    const clearError = (keepInline = false) => {compileFailed=false; $("studioError").hidden = true; $("studioErrorToggle").hidden = true; $("studioDiagnostics").hidden = true; $("studioDiagnostics").replaceChildren(); if(!keepInline && diagnostics.length){diagnostics=[];syncDiagnostics();} };
    const showError = error => {
      const text = String(error?.message || error), panel = $("studioDiagnostics");
      $("studioError").textContent = text; $("studioError").hidden = true; $("studioErrorToggle").hidden = false;
      panel.replaceChildren(); const matches=[...text.matchAll(/(?:ERROR|WARNING):\s*\d+:(\d+):\s*([^\r\n]*)/g)];diagnostics=[];
      for(const match of matches.slice(0,15)) {
        const row=element("button"), info=error?.glslInjected, original=Number(match[1]);let line=original;
        const generated=info && original>info.after && original<=info.after+(info.generated??info.count);
        if(info && original>info.after+(info.generated??info.count))line-=info.count;
        if(!generated)diagnostics.push({pass:error?.passName || selected,line,message:match[2],severity:match[0].startsWith("WARNING")?"warning":"error"});
        row.type="button";row.textContent=`${error?.passName || selected} · ${generated?"Auto Uniform":`Line ${line}`} · ${match[2]}`;
        if(generated){row.disabled=true;row.title="자동 생성된 Uniform 선언에서 발생한 오류입니다.";}
        else {row.title="원본 GLSL 줄로 이동";row.addEventListener("click",()=>{open();if(error?.passName)select(error.passName);editor.goToLine(line);});}
        panel.append(row);
      }
      panel.hidden = !matches.length; syncDiagnostics();
      setStatus(`${error?.passName?`${error.passName} 컴파일 오류`:"작업 오류"}: ${text.split("\n")[0]}`, "is-error");
    }; const clearDraft = () => {if(draftTimer)clearTimeout(draftTimer);draftTimer=null;$("studioDraft").hidden=true;
      try {localStorage.removeItem(DRAFT_KEY);}catch (_){} };
    const scheduleDraft = () => {if(draftTimer)clearTimeout(draftTimer);
      setStorage("pending","소스 · 편집본 보관 대기");draftTimer=setTimeout(()=>{draftTimer=null;rememberEditor();try {localStorage.setItem(DRAFT_KEY,JSON.stringify({version:1,project,selected}));setStorage("draft","소스 · 미적용 편집본 보관됨");}
        catch(error){setStorage("error","소스 · 브라우저 보관 실패",error.message);}},550);
    }; const saveLocal = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({version:1,project,selected}));setStorage("saved","소스 · 브라우저 보관됨"); }
      catch(error) {setStorage("error","소스 · 브라우저 보관 실패",error.message);}
    }; const preview = () => {
      const name = selected === "Image" ? null : selected;
      if(renderer.getPasses().some(p => p.name === name) || !name) renderer.setPreviewPass(name);
    }; const validateProject = candidate => {
      if(!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("프로젝트는 객체여야 합니다.");
      if(typeof candidate.image !== "string" || candidate.image.length > 262144 || !candidate.image.startsWith("#version 300 es")) throw new Error("Image GLSL 소스가 올바르지 않습니다.");
      if(!Array.isArray(candidate.passes) || candidate.passes.length > 8) throw new Error("버퍼는 최대 8개입니다.");
      const names = new Set(); for(const p of candidate.passes) {
        if(!p || typeof p.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(p.name) || p.name === "Image" || names.has(p.name) || typeof p.fragment !== "string" || !p.fragment.startsWith("#version 300 es") || p.fragment.length > 262144) throw new Error("Buffer 이름 또는 GLSL 소스를 확인하세요.");
                if(!["rgba8","rgba16f","rgba32f"].includes(p.format) || !Number.isFinite(p.scale) || p.scale < 0.125 || p.scale > 1 || !p.channels || typeof p.channels !== "object" || Array.isArray(p.channels)) throw new Error(`${p.name}: Buffer 속성이 올바르지 않습니다.`);
        // 선택 항목(고정 해상도·출력 수·샘플링)은 모양만 확인하고 세부 범위는 Renderer가 검증한다.
        if((p.size!==undefined && !(Array.isArray(p.size) && p.size.length===2)) || (p.outputs!==undefined && !Number.isInteger(p.outputs))
          || (p.filter!==undefined && typeof p.filter!=="string") || (p.wrap!==undefined && typeof p.wrap!=="string") || (p.mipmap!==undefined && typeof p.mipmap!=="boolean"))
          throw new Error(`${p.name}: Buffer 선택 속성(size/outputs/filter/wrap/mipmap)이 올바르지 않습니다.`);
        names.add(p.name);
      }
      if(!candidate.imageChannels || typeof candidate.imageChannels !== "object" || Array.isArray(candidate.imageChannels)) throw new Error("Image 채널 연결이 올바르지 않습니다.");
      return copy(candidate);
    }; const same = (a,b) => a===b || !!(a && b && typeof a==="object" && typeof b==="object" && Array.isArray(a)===Array.isArray(b) && Object.keys(a).length===Object.keys(b).length && Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k])));
    // 구조 변경은 전체 Pass 교체. 소스·채널만 바뀌면 해당 패스만 갱신하여 이전 Texture를 보존한다.
    const apply = (users = null) => {
      if(disposed) return false; if(timer) { clearTimeout(timer); timer = null; }
      rememberEditor();try {
        validateProject(project);const touched=users && !same(users,renderer.getUserUniforms()) ? renderer.applyPortable(project,users) : renderer.applyProject(project);
        syncHistory(); preview(); dirty = false; clearError(); clearDraft(); setStatus(touched ? "적용됨 · GPU 프로그램/채널 동기화 완료" : "변경 사항 없음"); saveLocal();
        const synced=syncAnnotations(); if(synced)setStatus(synced);
        return true;
      } catch(error) {
        dirty = true;compileFailed=true; if(error.passName && error.passName!==selected) select(error.passName);showError(error); scheduleDraft();return false;
      }
    };
    // 컴파일 성공 후 GLSL 주석 어노테이션(@range/@step/@default/@color)을 파라미터에 반영한다.
    // 미등록 Uniform은 새로 등록하고, 등록된 것은 옵션만 갱신한다(값은 새 범위로 보정). 한 번의 재컴파일로 처리한다.
    const syncAnnotations = () => {
      const specs=Annotations.collect([project.image,...project.passes.map(p=>p.fragment)]);if(!specs.length)return "";
      const users=renderer.getUserUniforms(),next=users.map(u=>({...u,options:{...u.options}})),added=[],updated=[],problems=[];
      for(const spec of specs) {
        if(spec.error){problems.push(`${spec.name}: ${spec.error}`);continue;}
        const current=next.find(u=>u.name===spec.name);
        if(!current){next.push({name:spec.name,type:spec.type,value:spec.value,options:spec.options});added.push(spec.name);}
        else if(current.type===spec.type && !Annotations.sameOptions(current.options,spec.options)){current.options=spec.options;current.value=Annotations.clampValue(current.value,spec.options);updated.push(spec.name);}
      }
      if(added.length||updated.length) {
        try{renderer.setUserUniforms(next);}catch(error){return `어노테이션 적용 실패: ${error.message}`;}
        checkpoint.users=renderer.getUserUniforms();document.dispatchEvent(new Event("shader-settings-applied"));
      }
      const parts=[added.length&&`등록 ${added.join(", ")}`,updated.length&&`범위 갱신 ${updated.join(", ")}`,problems.length&&`무시 ${problems.join(" / ")}`].filter(Boolean);
      return parts.length?`적용됨 · @어노테이션 ${parts.join(" · ")}`:"";
    };
    const schedule = (typing = false) => {
      clearChange();recordEdit(typing);dirty = true;clearError(true); setStatus($("studioLive").checked?"수정됨 · 자동 적용 대기 (0.9초)":"수정됨 · Run으로 적용", "is-dirty"); scheduleDraft(); if(timer) clearTimeout(timer);
      if($("studioLive").checked) timer = setTimeout(apply,900);
    }; const rememberEditor = () => {
      const p = find(selected); if(selected === "Image") project.image = $("studioCode").value;
      else if(p) p.fragment = $("studioCode").value;
    };
    const activeChannels = () => selected==="Image"?project.imageChannels:find(selected)?.channels;
    const freeChannel = () => [0,1,2,3].find(index=>!activeChannels()?.[index]);
    const syncTextureTargets = () => {const slot=freeChannel(),target=selected==="Image"?"Image":`Buffer ${selected}`;for(const button of textureButtons){button.disabled=slot===undefined;button.textContent=slot===undefined?`${target} · 빈 채널 없음`:`${target} · iChannel${slot}에 연결`;button.title=slot===undefined?"입력 채널 4개가 모두 사용 중입니다. 기존 연결을 해제하세요.":`${target}.iChannel${slot}에 연결 · 기존 입력을 덮어쓰지 않습니다.`;button.setAttribute("aria-label",`${button.dataset.assetName} · ${button.textContent}`);}};
    const validCurrent = (target,buffer) => target === "Image" || project.passes.findIndex(p=>p.name===buffer) < project.passes.findIndex(p=>p.name===target);
    const inputInfo = (ref,assets) => !ref?{source:"연결 안 함",frame:"입력 없음",help:"사용할 이미지나 버퍼를 선택하세요."}:ref.texture?
      {source:assets.find(asset=>asset.id===ref.texture)?.name||"사용할 수 없는 이미지",frame:"이미지",help:"이미지 원본을 읽습니다. Filter와 Wrap은 이미지 설정을 따릅니다."}:
      {source:`Buffer ${ref.buffer}${ref.attachment?`[${ref.attachment}]`:""}`,frame:ref.frame==="current"?"current · 이번 프레임":"previous · 지난 프레임",help:ref.frame==="current"?"이번 프레임에 앞서 실행된 버퍼의 결과를 읽습니다.":"지난 프레임에 저장된 버퍼 결과를 읽습니다. 자기 자신을 연결하면 피드백을 만들 수 있습니다."};
    const renderChannels = () => {
      const holder=$("studioChannels"),channels=activeChannels(),assets=renderer.getTextures(),blocked=project.passes.filter(pass=>!validCurrent(selected,pass.name));
      $("studioInputsTitle").textContent=`${selected} · 입력 채널`;
      $("studioChannelRules").textContent=selected==="Image"?"Image는 버퍼 실행이 끝난 뒤 그려집니다. 모든 버퍼의 current 또는 previous를 읽을 수 있습니다.":`current는 앞서 실행되는 버퍼만 선택할 수 있습니다.${blocked.length?` ${blocked.map(pass=>pass.name).join(", ")}는 자기 자신 또는 뒤에서 실행되는 버퍼이므로 previous로 연결하세요.`:""}`;
      holder.replaceChildren();for(let i=0;i<4;i++) {
        const row=element("div"),label=element("label"),select=element("select"),hint=element("p");row.className="studio-channel";
        label.textContent=`iChannel${i}`;label.htmlFor=select.id=`studioChannel${i}`;hint.id=`studioChannelHelp${i}`;hint.className="studio-channel-help";
        select.title=`iChannel${i}의 입력 이미지/버퍼 선택`;select.setAttribute("aria-describedby",`${hint.id} studioChannelRules`);
        const addOption=(value,text,disabled=false)=>{const opt=element("option");opt.value=value;opt.textContent=text;opt.disabled=disabled;select.append(opt);};
        addOption("","연결 안 함");for(const asset of assets)addOption(`tex:${asset.id}`,`이미지 · ${asset.name} (${asset.width}×${asset.height})`);
        // 출력이 여럿(MRT)인 버퍼는 출력마다 선택지를 둔다. 값 형식: 이름:frame[:출력번호]
        for(const pass of project.passes){const allowed=validCurrent(selected,pass.name),outputs=pass.outputs||1;
          for(let att=0;att<outputs;att++){const suffix=att?`:${att}`:"",shown=outputs>1?`${pass.name}[${att}]`:pass.name;
            addOption(`${pass.name}:current${suffix}`,`${shown} · current${allowed?" · 이번 프레임":pass.name===selected?" · 자기 참조 불가":" · 실행 순서상 불가"}`,!allowed);addOption(`${pass.name}:previous${suffix}`,`${shown} · previous · 지난 프레임`);}}
        const current=channels?.[i];select.value=current?(current.texture?`tex:${current.texture}`:`${current.buffer}:${current.frame}${current.attachment?`:${current.attachment}`:""}`):"";
        const describe=()=>{const info=inputInfo(channels?.[i],assets);hint.textContent=`${info.source} · ${info.frame} — ${info.help}`;};describe();
        select.addEventListener("change",()=>{
          if(!select.value)delete channels[i];else if(select.value.startsWith("tex:"))channels[i]={texture:select.value.slice(4)};else{const [buffer,frame,att]=select.value.split(":");channels[i]=att?{buffer,frame,attachment:Number(att)}:{buffer,frame};}
          describe();schedule();renderGraph();syncTextureTargets();if(!$("studioLive").checked)return;
          if(timer){clearTimeout(timer);timer=null;}apply();
        });row.append(label,select,hint);holder.append(row);
      }syncTextureTargets();
    }; const renderGraph = () => {
      const holder=$("studioGraph"),assets=renderer.getTextures();holder.replaceChildren();
      for(const entry of [...project.passes,{name:"Image",channels:project.imageChannels}]){
        const row=element("button"),name=element("strong");row.type="button";row.classList.toggle("is-current",entry.name===selected);row.setAttribute("aria-pressed",String(entry.name===selected));row.title=`${entry.name} 패스 편집`;
        name.textContent=entry.name==="Image"?"Image · Canvas":`Buffer ${entry.name}`;row.append(name);
        const inputs=Object.entries(entry.channels||{}).sort(([a],[b])=>Number(a)-Number(b));if(!inputs.length){const empty=element("small");empty.textContent="연결된 채널 없음";row.append(empty);}
        for(const [i,ref] of inputs){const info=inputInfo(ref,assets),line=element("span"),channel=element("span"),source=element("span"),frame=element("small");line.className="studio-graph-input";channel.className="studio-graph-channel";channel.textContent=`iChannel${i}`;source.className="studio-graph-source";source.textContent=info.source;frame.className="studio-graph-frame";frame.textContent=info.frame;line.append(channel,source,frame);row.append(line);}
        row.addEventListener("click",()=>select(entry.name));holder.append(row);
      }
    };
    // 새 이미지는 사용 중인 연결을 덮어쓰지 않고 첫 빈 채널에만 연결한다.
    const connectTexture = id => {
      rememberEditor();const channels=activeChannels(),slot=freeChannel();
      if(slot===undefined) {setStatus("빈 입력 채널이 없습니다. 기존 채널을 해제한 뒤 연결하세요.","is-error");return false;}
      channels[slot]={texture:id};renderChannels();renderGraph();schedule(); if(apply()){setStatus(`${inputInfo({texture:id},renderer.getTextures()).source} → ${selected}.iChannel${slot} 연결됨`);return true;}
      delete channels[slot];renderChannels();renderGraph();return false;
    }; const renderTextures = () => {
      const holder = $("studioTextureList"),assets=renderer.getTextures();textureButtons=[];holder.replaceChildren();if(!assets.length){const hint=element("p");hint.className="studio-hint";hint.textContent="등록된 이미지가 없습니다. PNG·JPEG·WebP 파일을 추가하고 입력 채널에 연결하세요.";holder.append(hint);}for(const asset of assets) {
        const row=element("div"),name=element("span"),del=element("button");
        row.className="studio-texture";name.textContent=`${asset.name} · ${asset.width}×${asset.height}`;
        del.type="button";del.className="glyph-icon icon-close";del.title=`${asset.name} 삭제`;del.setAttribute("aria-label",del.title);
        del.addEventListener("click",async()=>{
          if(!await ask({title:"이미지 삭제",message:`${asset.name} 이미지와 연결을 삭제할까요?`,ok:"삭제",danger:true}))return;
          rememberEditor();const before=copy(project); for(const pass of project.passes) for(const key of Object.keys(pass.channels))
          if(pass.channels[key].texture===asset.id)delete pass.channels[key];
          for(const key of Object.keys(project.imageChannels))
          if(project.imageChannels[key].texture===asset.id)delete project.imageChannels[key];
          if(!apply()){project=before;renderEditor();return;}
          try {await renderer.removeTexture(asset.id);renderTextures();renderChannels();renderGraph();} catch(error){showError(error);}
        }); const use=element("button");use.type="button";use.className="texture-connect";use.dataset.assetName=asset.name;textureButtons.push(use);
        use.addEventListener("click",()=>connectTexture(asset.id));
        const controls=element("div");controls.className="studio-sampling";
        for(const [key,title,values] of [
          ["filter","Filter",[["linear","Linear"],["nearest","Nearest"]]],
          ["wrapS","Wrap X",[["clamp","Clamp"],["repeat","Repeat"],["mirror","Mirror"]]],
          ["wrapT","Wrap Y",[["clamp","Clamp"],["repeat","Repeat"],["mirror","Mirror"]]]
        ]) {
          const label=element("label"),select=element("select");label.textContent=title;
          for(const [value,text] of values) {const option=element("option");option.value=value;option.textContent=text;select.append(option);}
          select.value=asset.sampling[key];select.title=`${asset.name}: ${title}`;
          select.addEventListener("change",async()=>{
            try {const result=await renderer.setTextureSampling(asset.id,{[key]:select.value});
              setStatus(result.saved ? "Texture 샘플링 적용·저장됨" : "샘플링 적용됨 · 브라우저 저장소 저장 실패");}
            catch(error) {select.value=renderer.getTextures().find(item=>item.id===asset.id)?.sampling[key] || asset.sampling[key];showError(error);}
          });label.append(select);controls.append(label);
        }
        row.append(name,use,del,controls);holder.append(row);
      }syncTextureTargets();
    }; const renderTabs = () => {
      const parent = $("studioPassTabs"); parent.replaceChildren(); for(const name of ["Image",...project.passes.map(p=>p.name)]) {
        const btn = element("button"); btn.type="button"; btn.setAttribute("role","tab");btn.id=`studioTab-${name}`;btn.setAttribute("aria-controls","studioCode");
        btn.classList.toggle("is-active",selected===name); btn.setAttribute("aria-selected",String(selected===name)); btn.tabIndex=selected===name?0:-1;
                btn.textContent = name === "Image" ? "Image" : `Buffer ${name}`; btn.title = `${name} 패스 편집 (Alt+PageUp/Down)`;
        btn.addEventListener("click",() => select(name));parent.append(btn);
      }
      for(const name of views.keys())if(name!=="Image"&&!find(name))views.delete(name);
      $("studioCode").setAttribute("aria-labelledby",`studioTab-${selected}`);$("studioAdd").disabled=project.passes.length>=8;
      const p = find(selected), idx = project.passes.findIndex(pass=>pass.name===selected);
      $("studioPassTools").hidden=!p;$("studioRemove").disabled = !p;$("studioDuplicate").disabled = !p || project.passes.length >= 8; $("studioUp").disabled = !p || idx === 0;
      $("studioDown").disabled = !p || idx === project.passes.length-1; for(const id of ["studioFormatField","studioScaleField","studioOutputsField","studioFilterField","studioWrapField","studioMipField"])$(id).hidden = !p;
      const refs=p?references(selected):[];$("studioPassImpact").hidden=!p;$("studioPassImpact").textContent=refs.length?`삭제 시 연결 ${refs.length}개 해제`:"다른 패스의 참조 없음";
      $("studioRemove").title=p?`${selected} 삭제${refs.length?` · 함께 해제: ${refs.join(", ")}`:""} · Undo로 복원`:"Image는 삭제할 수 없습니다.";
      $("studioInspect").disabled=!p;if(!p)$("studioInspect").checked=false;
      if(p) {
        $("studioFormat").value = p.format;
        // 해상도: 화면 비율(scale) 또는 고정 크기(size). 목록에 없는 고정 크기는 임시 선택지로 보여준다.
        const scaleSelect=$("studioScale"),sizeValue=p.size?`size:${p.size[0]}x${p.size[1]}`:String(p.scale);
        scaleSelect.querySelector("option[data-custom]")?.remove();
        if(![...scaleSelect.options].some(o=>o.value===sizeValue)){const option=element("option");option.dataset.custom="true";option.value=sizeValue;option.textContent=p.size?`${p.size[0]}×${p.size[1]}`:`${Math.round(p.scale*100)}%`;scaleSelect.append(option);}
        scaleSelect.value=sizeValue;$("studioOutputs").value=String(p.outputs||1);
        $("studioFilter").value=p.filter||(p.format==="rgba32f"?"nearest":"linear");$("studioWrap").value=p.wrap||"clamp";$("studioMip").checked=!!p.mipmap;
      }
      $("studioCodeTitle").textContent = selected === "Image" ? "Image.frag" : `Buffer ${selected}.frag`;
      // 버퍼 설정은 접힌 한 줄 요약으로 보여준다: "A · RGBA8 · 100% · Linear · Clamp"
      if(p) {
        const size = p.size ? `${p.size[0]}×${p.size[1]}` : `${Math.round(p.scale*100)}%`, filter = p.filter || (p.format === "rgba32f" ? "nearest" : "linear");
        const parts = [p.format.toUpperCase(), size, filter === "nearest" ? "Nearest" : "Linear", {clamp:"Clamp",repeat:"Repeat",mirror:"Mirror"}[p.wrap || "clamp"]];
        if((p.outputs || 1) > 1) parts.push(`출력 ${p.outputs}개`); if(p.mipmap) parts.push("밉맵");
        $("studioPassSummary").textContent = `${selected} · ${parts.join(" · ")}`;
      }
    };
    const renderEditor = () => { renderTabs(); renderChannels(); const area=$("studioCode"),source=activeSource()||"",view=views.get(selected);area.value=source;
      const caret=view?.source===source?view.caret:[0,0,"none"],scroll=view?.source===source?view.scroll:[0,0];area.setSelectionRange(caret[0],caret[1],caret[2]);area.scrollTop=scroll[0];area.scrollLeft=scroll[1];syncDiagnostics();editor.update();renderGraph(); };
    const select = name => {
      if(name !== "Image" && !find(name)) return; if(name === selected) return; rememberEditor();views.set(selected,{source:activeSource(),...cursorState()}); selected = name; renderEditor(); checkpoint.selected=selected;preview();
    }; const normalizeDependencies = () => {
      const changed=[];for(const p of project.passes) for(const [channel,ref] of Object.entries(p.channels)) {
        if(ref.frame === "current" && !validCurrent(p.name,ref.buffer)){changed.push(`${p.name}.iChannel${channel} ← ${ref.buffer}`);p.channels[channel] = {...ref,frame:"previous"};}
      }return changed;
    }; const add = () => {
      rememberEditor(); const names = new Set(project.passes.map(p=>p.name));
      if(project.passes.length >= 8) return showError("Buffer는 최대 8개까지 추가할 수 있습니다."); const name = [..."ABCDEFGH"].find(n=>!names.has(n));
      project.passes.push({name,fragment:blank,format:"rgba8",scale:1,channels:{}}); selected = name;renderEditor();schedule();apply();
    }; const duplicate = () => {
      const source=find(selected); if(!source || project.passes.length>=8)return;
      rememberEditor();const names=new Set(project.passes.map(p=>p.name));
      const name=[..."ABCDEFGH"].find(n=>!names.has(n)); if(!name)return showError("사용 가능한 Buffer 이름이 없습니다.");
      const item=copy(source);item.name=name;
      for(const ref of Object.values(item.channels)) if(ref.buffer===source.name&&ref.frame==="previous")ref.buffer=name;
      project.passes.splice(project.passes.indexOf(source)+1,0,item); selected=name;renderEditor();schedule();apply();
    }; const remove = () => {
      if(selected === "Image") return;rememberEditor();const name = selected,refs=references(name); project.passes = project.passes.filter(p=>p.name!==name);
      for(const p of project.passes) for(const key of Object.keys(p.channels)) if(p.channels[key].buffer===name) delete p.channels[key];
      for(const key of Object.keys(project.imageChannels)) if(project.imageChannels[key].buffer===name) delete project.imageChannels[key];
      selected = "Image";renderEditor();schedule();apply();showChange(`${name} 삭제${refs.length?` · 해제된 연결 ${refs.length}개: ${refs.join(", ")}`:" · 다른 패스의 연결 변경 없음"}`);
    }; const move = dir => {
      const idx = project.passes.findIndex(p=>p.name===selected), next=idx+dir; if(idx<0||next<0||next>=project.passes.length) return;
      rememberEditor();[project.passes[idx],project.passes[next]]=[project.passes[next],project.passes[idx]];
      const changed=normalizeDependencies();renderEditor();schedule();apply();showChange(changed.length?`실행 순서 변경 · current → previous: ${changed.join(", ")}`:"실행 순서 변경 · 채널의 프레임 참조 변경 없음");
    }; const setProject = next => {
      if(disposed)return false;clearChange();const before = project, previousSelected = selected; try {
        project = validateProject(next); selected="Image";renderEditor();
        if(!apply()) { project=before; selected=previousSelected; renderEditor(); return false; }
        recordEdit();return true;
      } catch(error) { project=before; selected=previousSelected;renderEditor();showError(error); return false; }
    }; const historyMove = backwards => {
      const from=backwards?undoStack:redoStack,to=backwards?redoStack:undoStack;if(!from.length)return false;clearChange();
      if(timer)clearTimeout(timer);timer=null;const target=from.pop(),current=historyState();to.push(current);if(to.length>25)to.shift();
      navigatingHistory=true;project=copy(target.project);selected=target.selected;renderEditor();
      const area=$("studioCode"),a=target.caret||[0,0],scroll=target.scroll||[0,0];area.focus({preventScroll:true});
      area.setSelectionRange(Math.min(a[0],area.value.length),Math.min(a[1],area.value.length),a[2]||"none");
      area.scrollTop=scroll[0];area.scrollLeft=scroll[1];editor.update();
      const applied=apply(target.users);if(applied&&!same(current.users,target.users))document.dispatchEvent(new Event("shader-settings-applied"));navigatingHistory=false;checkpoint=historyState();editTime=0;syncHistory();return true;
    }; const confirmReplace = () => !dirty || ask({title:"미적용 변경사항",message:"아직 실행하지 않은 GLSL 수정 내용이 있습니다. 계속하면 변경사항을 잃을 수 있어요.",ok:"계속",danger:true});
    const adoptProject = (next,tab="Image") => {
      clearChange();views.clear();project=copy(next);selected=tab==="Image"||find(tab)?tab:"Image";dirty=false;clearError();clearDraft();
      renderEditor();recordEdit(false,true);Object.assign(checkpoint,{selected,...cursorState()});preview();saveLocal();
    };
    const replaceProject = (next,users=[]) => {
      try {rememberEditor();checkpoint=historyState();renderer.applyPortable(next,users);adoptProject(next);
        // 예제 소스의 @어노테이션도 바로 파라미터로 등록한다(apply 경로를 거치지 않으므로 여기서 동기화).
        syncAnnotations();const count=renderer.getUserUniforms().length;
        settings?.save(true);document.dispatchEvent(new Event("shader-settings-applied"));setStatus(`새 프로젝트 시작 · 파라미터 ${count}개 · Undo로 이전 작업 복원`);return true;
      } catch(error){showError(error);return false;}
    };
    const startProject = (next,users=[]) => proceed(confirmReplace(),()=>replaceProject(next,users));
    const exampleRaymarch = () => startProject({image:Shader.raymarch,passes:[],imageChannels:{}},
      Shader.rayUniforms.map(([name,type,value,options])=>({name,type,value,options:options||{}})));
    const examplePipeline = () => startProject({image:comparison,passes:[
      {name:"A",fragment:movingDot,format:"rgba8",scale:1,channels:{}},
      {name:"B",fragment:colorFilter,format:"rgba8",scale:1,channels:{0:{buffer:"A",frame:"current"}}}
    ],imageChannels:{0:{buffer:"B",frame:"current"},1:{buffer:"A",frame:"current"}}});
    const exampleFeedback = () => startProject({image:comparison,passes:[
      {name:"A",fragment:movingDot,format:"rgba8",scale:1,channels:{}},
      {name:"B",fragment:feedback,format:"rgba8",scale:1,channels:{0:{buffer:"A",frame:"current"},1:{buffer:"B",frame:"previous"}}}
    ],imageChannels:{0:{buffer:"B",frame:"current"},1:{buffer:"A",frame:"current"}}}); const loadFromRenderer = () => proceed(confirmReplace(),()=>{
      project = snapshot();selected = "Image";renderEditor();recordEdit();clearError();dirty=false;clearDraft();
      setStatus("렌더러의 현재 버퍼 구성을 불러왔습니다.");saveLocal();return true;
    }); const open = () => {
      openState = true; $("studioDock").hidden = false; $("studioResize").hidden = expanded;
      $("studioToggle").setAttribute("aria-label","셰이더 편집기 닫기");$("studioToggle").setAttribute("aria-expanded","true");
      if(window.matchMedia("(max-width:820px)").matches) {document.body.classList.add("panel-hidden");document.dispatchEvent(new Event("shader-panel-changed"));}$("studioCode").focus({preventScroll:true});
    }; // 재생 버튼은 아이콘(정지 중이면 ▶)과 접근 가능한 이름으로 상태를 알린다. 집중 모드에서는 복귀 후 재생 여부를 고른다.
    const syncPauseButton = () => {
      const button=$("studioPause"), playing=expanded?resumeAfterMaximize:renderer.getStats().running;
      const label=expanded?(resumeAfterMaximize?"복귀 시 재생":"복귀 시 정지"):playing?"일시정지":"재생";
      button.setAttribute("aria-pressed",String(!playing));button.setAttribute("aria-label",label);button.title=`${label} · 뷰포트에서는 Space`;
    }; const maximize = () => {
      if(!expanded) {
        resumeAfterMaximize=renderer.getStats().running; if(resumeAfterMaximize) renderer.stop();
      } else if(resumeAfterMaximize) renderer.start(); expanded=!expanded;$("stage").classList.toggle("studio-maximized",expanded);
      $("studioResize").hidden=expanded;$("studioMaximize").setAttribute("aria-pressed",String(expanded));
      syncPauseButton();
    }; const close = () => {if(expanded)maximize();openState=false;$("studioDock").hidden=true;
      $("studioResize").hidden=true;$("stage").classList.remove("studio-maximized"); $("studioToggle").setAttribute("aria-label","셰이더 편집기 열기");$("studioToggle").setAttribute("aria-expanded","false");$("studioToggle").focus();};
    const responsiveHeight = () => window.matchMedia("(max-width:600px), (max-height:650px)").matches?75:55;
    const setDockHeight = (value, persist = true) => {dockHeight=Math.max(25,Math.min(85,value));$("studioDock").style.setProperty("--studio-height",`${dockHeight}%`);
      if(layout==="bottom")$("studioResize").setAttribute("aria-valuenow",String(Math.round(dockHeight)));
      if(persist){heightChosen=true;try{localStorage.setItem("webgl.shader-studio.height.v2",String(dockHeight));}catch (_){}} };
    // 두 번 클릭 복원: 저장한 높이를 지우고 다시 창 크기 기본값을 따른다.
    const resetDockHeight = () => {heightChosen=false;try{localStorage.removeItem("webgl.shader-studio.height.v2");}catch (_){}setDockHeight(responsiveHeight(),false);};
    // 편집기 배치: right(캔버스 옆 분할) 또는 bottom(캔버스 아래). 넓은 화면은 right가 기본이다.
    // 넓은 화면, 또는 4분할 창처럼 가로로 길고 낮은 창은 아래 배치가 미리보기와 코드를 모두 납작하게 만드므로 옆 배치가 기본이다.
    const fitLayout = () => {const w=window.innerWidth||0,h=window.innerHeight||0;return w>=1200||(w>=900&&h>0&&w>=h*1.6)?"right":"bottom";};
    const LAYOUT_KEY="webgl.shader-studio.layout.v1";let layout=fitLayout(),dockWidth=46;
    try{const saved=JSON.parse(localStorage.getItem(LAYOUT_KEY)||"{}");if(["right","bottom"].includes(saved.layout)){layout=saved.layout;layoutChosen=true;}if(Number.isFinite(saved.width))dockWidth=Math.max(30,Math.min(75,saved.width));}catch(_){}
    const saveLayout=()=>{layoutChosen=true;try{localStorage.setItem(LAYOUT_KEY,JSON.stringify({layout,width:dockWidth}));}catch(_){}};
    const setDockWidth = (value, persist = true) => {dockWidth=Math.max(30,Math.min(75,value));$("stage").style.setProperty("--studio-width",`${dockWidth}%`);
      if(layout==="right")$("studioResize").setAttribute("aria-valuenow",String(Math.round(dockWidth)));if(persist)saveLayout();};
    const applyLayout = () => {
      const right=layout==="right";$("stage").classList.toggle("studio-layout-right",right);
      const handle=$("studioResize");handle.setAttribute("aria-orientation",right?"vertical":"horizontal");
      handle.setAttribute("aria-valuemin",right?"30":"25");handle.setAttribute("aria-valuemax",right?"75":"85");
      handle.setAttribute("aria-valuenow",String(Math.round(right?dockWidth:dockHeight)));
      handle.title=right?"드래그 또는 ←→로 너비 조절 · 두 번 클릭해 기본 너비 복원":"드래그 또는 ↑↓로 높이 조절 · Home/End · 두 번 클릭해 기본 높이 복원";
      $("studioLayout").setAttribute("aria-pressed",String(right));$("studioLayout").title=right?"편집기를 캔버스 아래로 배치":"편집기를 캔버스 오른쪽에 나란히 배치";
      $("studioLayout").textContent=right?"편집기를 아래에 배치":"편집기를 오른쪽에 배치";
      editor.update();
    };
    const toggleLayout = () => {layout=layout==="right"?"bottom":"right";saveLayout();applyLayout();};
    // 좁은 화면(≤820px)에서는 CSS가 아래 배치로 되돌리므로 리사이저도 세로 방향으로 동작한다.
    const splitRight = () => layout==="right" && !window.matchMedia("(max-width:820px)").matches;
    const toggle = () => openState ? close() : open(); const inspectPixel = event => {
      if(!$("studioInspect").checked) return; const output=$("studioPixelReadout");
      if(selected==="Image") {output.textContent="먼저 Buffer A/B 패스를 선택하세요. Image는 기본 Canvas 출력입니다.";return;}
      const pass=renderer.getPasses().find(p=>p.name===selected), canvas=$("screen");
      if(!pass?.width || !pass?.height) {output.textContent="이 버퍼는 아직 렌더링되지 않았습니다.";return;}
      const rect=canvas.getBoundingClientRect();
      const x=Math.max(0,Math.min(pass.width-1,Math.floor((event.clientX-rect.left)/rect.width*pass.width)));
      const y=Math.max(0,Math.min(pass.height-1,Math.floor((rect.bottom-event.clientY)/rect.height*pass.height)));
      try {const values=renderer.readPassPixel(selected,x,y);
        output.textContent=`${selected} (${x}, ${y}) · ${pass.format.toUpperCase()}\nRGBA: ${values.map(n=>Number(n).toPrecision(5)).join(", ")}`;
      }catch(error){output.textContent=error.message;}
    }; const download = (name,text,type,limit=Infinity) => {
      const blob=new Blob([text],{type});if(blob.size>limit)throw new Error(`내보내기 파일은 최대 ${limit/1048576}MiB입니다.`);
      const url=URL.createObjectURL(blob),link=element("a");
      link.href=url;link.download=name;document.body.append(link);link.click();link.remove();$("studioExportState").textContent=`최근 내보내기 요청 · ${name}`;
      setTimeout(()=>URL.revokeObjectURL(url),3000);
    }; const exportJSON = () => {
      try {rememberEditor();download("shader-studio-project.json",JSON.stringify({version:1,project},null,2),"application/json",JSON_LIMIT);
        setStatus("소스 JSON 내보냄 · 파라미터·이미지 원본은 포함되지 않습니다.");}catch(error){showError(error);}
    };
    // Pack은 연결된 이미지의 원본과 샘플링 설정까지 포함한다. 기존 JSON은 경량 형식으로 유지한다.
    const runFile = async (button,message,action) => {if(button.disabled)return;const label=button.textContent;button.disabled=true;button.textContent=message;button.setAttribute("aria-busy","true");
      try {await action();}catch(error){showError(error);}finally{button.disabled=false;button.textContent=label;button.removeAttribute("aria-busy");}};
    const readData = file => new Promise((resolve,reject)=>{
      const reader=new FileReader();reader.onload=()=>resolve(reader.result);
      reader.onerror=()=>reject(reader.error || new Error("이미지를 읽을 수 없습니다."));reader.readAsDataURL(file);
    });
    const getChannels = config => [...config.passes.map(pass=>pass.channels),config.imageChannels];
    const exportPack = async () => {
      rememberEditor();const scene=copy(project), tab=selected, state=settings?.snapshot(), ids=new Set();
      for(const channels of getChannels(scene))for(const ref of Object.values(channels))if(ref.texture)ids.add(ref.texture);
      const assets=renderer.getTextures(), textures=[];let bytes=0;
      const files=[...ids].map(id=>{
        const meta=assets.find(item=>item.id===id),file=renderer.getTextureFile(id);
        if(!meta || !file)throw new Error(`원본 이미지가 없습니다: ${id}`);
        bytes+=file.size;if(bytes>32*1024*1024)throw new Error("연결된 이미지 합계는 최대 32MB입니다.");
        return {id,meta,file};
      });
      for(const {id,meta,file} of files)textures.push({id,name:meta.name,type:file.type,data:await readData(file),sampling:meta.sampling});
      if(disposed)return;
      download("shader-studio-pack.json",JSON.stringify({version:state?3:2,project:scene,selected:tab,textures,...(state?{settings:state}:{})}),"application/json",PACK_LIMIT);
      setStatus(`Pack 내보냄 · 코드·파라미터·설정·이미지 ${textures.length}개 포함`);
    };
    let loadSerial=0;
    const beginLoad = (full=false) => {
      const serial=++loadSerial, draft=copy(project), tab=selected, gpu=full?snapshot():null, state=full?settings?.snapshot():null;
      return () => {if(disposed || serial!==loadSerial || tab!==selected || !same(project,draft) || (full && (!same(snapshot(),gpu) || !same(settings?.snapshot(),state))))
        throw new Error("작업이 변경되었거나 종료되어 파일 불러오기를 취소했습니다.");};
    };
    const importPack = async file => {
      const check=beginLoad(true);
      if(file.size>PACK_LIMIT)throw new Error("Pack 파일은 최대 64MiB입니다.");
      const text=await file.text();check();const data=JSON.parse(text),next=validateProject(data.project);
      if(![2,3].includes(data.version) || !Array.isArray(data.textures) || data.textures.length>36)throw new Error("지원하지 않는 Pack 형식입니다.");
      const state=data.version===3 ? settings?.validatePack(data.settings) : null;
      if(data.version===3 && !state)throw new Error("설정 복원 API를 사용할 수 없습니다.");
      const ids=new Set(),decoded=[];let total=0;
      for(const asset of data.textures) {
        if(!asset || typeof asset.id!=="string" || !/^[A-Za-z][\w-]{0,31}$/.test(asset.id) || ids.has(asset.id)
          || typeof asset.name!=="string" || asset.name.length>128 || !["image/png","image/jpeg","image/webp"].includes(asset.type)
          || typeof asset.data!=="string" || !asset.data.startsWith(`data:${asset.type};base64,`))throw new Error("Pack 이미지 정보가 올바르지 않습니다.");
        ids.add(asset.id);const body=asset.data.slice(asset.data.indexOf(",")+1);
        if(body.length>16*1024*1024+8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body))throw new Error("Pack 이미지 데이터가 올바르지 않습니다.");
        const binary=atob(body);total+=binary.length;
        if(binary.length>12*1024*1024 || total>32*1024*1024)throw new Error("Pack 이미지 크기 제한을 초과했습니다.");
        const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
        const source=new File([bytes],asset.name,{type:asset.type});
        decoded.push({id:asset.id,file:source,sampling:asset.sampling});
      }
      for(const channels of getChannels(next))for(const ref of Object.values(channels))
        if(ref.texture && !ids.has(ref.texture))throw new Error(`Pack에 연결된 이미지가 없습니다: ${ref.texture}`);
      if(state) { // Pack의 이미지 ID는 등록 전에는 존재하지 않으므로 사전 검사에서만 이미지 참조를 제외한다.
        const trial=copy(next);for(const channels of getChannels(trial))for(const key of Object.keys(channels))
          if(channels[key].texture)delete channels[key];
        renderer.validatePortable(trial,state.user);
      } else {renderer.validateFragment(next.image);for(const pass of next.passes)renderer.validateFragment(pass.fragment,true);}
      if(!await confirmReplace())return false;check();
      const added=[],map=new Map(),draftBefore=copy(project),wasDirty=dirty;let unsaved=0,applied=false,previous=snapshot(),before=settings?.snapshot(),beforeTab=selected;
      try {
        for(const asset of decoded) {
          const result=await renderer.addTexture(asset.file,asset.sampling || {});added.push(result.id);check();map.set(asset.id,result.id);
          if(!result.saved)unsaved++;
        }
        for(const channels of getChannels(next))for(const ref of Object.values(channels))
          if(ref.texture)ref.texture=map.get(ref.texture);
        if(state) {
          checkpoint=historyState();renderer.applyPortable(next,state.user);applied=true;settings.applyPack(state);
        } else if(!setProject(next))throw new Error("Pack 셰이더를 적용하지 못했습니다.");
        adoptProject(next,data.selected);renderTextures();
        setStatus(`Pack 복원 완료 · 이미지 ${added.length}개${unsaved?" · 일부 이미지 로컬 저장 불가":""}`);
        return true;
      } catch(error) {
        if(applied) {
          try {renderer.applyPortable(previous,before.user);settings.applyPack(before);project=draftBefore;dirty=wasDirty;selected=beforeTab;renderEditor();if(dirty)scheduleDraft();}
          catch(rollback) {console.error("Pack 복원 실패 후 롤백 오류:",rollback);}
        }
        for(const id of added.reverse())try {await renderer.removeTexture(id);}catch(cleanup){console.warn("Pack 임시 이미지 정리 실패:",cleanup);}
        if(!disposed){renderTextures();renderChannels();}throw error;
      }
    };
    // 프로젝트 JSON은 이미지 파일 본문을 담지 않으므로 존재하지 않는 연결은 제거한다.
    const detachMissing = next => {
      const available=new Set(renderer.getTextures().map(asset=>asset.id));let count=0;
      for(const channels of [...next.passes.map(p=>p.channels),next.imageChannels])
      for(const key of Object.keys(channels)) if(channels[key].texture && !available.has(channels[key].texture)){delete channels[key];count++;}
      return count;
    };
    // 성공적으로 컴파일된 프로젝트를 자동 복원하고, 실패한 저장값은 실행하지 않는다.
    const restore = () => {
      try {
        const raw=localStorage.getItem(STORAGE_KEY);if(!raw) return; const data=JSON.parse(raw);
        if(data.version!==1) throw new Error("저장된 프로젝트 버전이 다릅니다.");
        const next=validateProject(data.project), before=copy(project); const detached=detachMissing(next);
        project=next;selected="Image";renderEditor();
        if(!apply()) { project=before;selected="Image";renderEditor();setStatus("저장 프로젝트 실행 실패 · 기본 장면 유지","is-error"); }
        else { selected=data.selected==="Image"||find(data.selected)?data.selected:"Image";renderEditor();preview();
          if(detached) setStatus(`${detached}개 이미지 연결이 해제됐습니다. 파일을 다시 불러오세요.`,"is-dirty"); }
      } catch(error) { showError(error); }
    }; const loadDraft = raw => {try {
        if(!raw)return;const data=JSON.parse(raw);if(data.version!==1)return;
        validateProject(data.project);if(same(data.project,project))return; $("studioDraft").hidden=false;
      // 초기화 과정에서 apply()가 draft 키를 지웠더라도 선택 전까지 복구 가능해야 한다.
        try{localStorage.setItem(DRAFT_KEY,raw);}catch(_){}
        on($("studioDraftRestore"),"click",()=>{project=copy(data.project);
          selected=data.selected==="Image"||find(data.selected)?data.selected:"Image";
          renderEditor();recordEdit();dirty=true;$("studioDraft").hidden=true;scheduleDraft(); setStatus("미적용 편집본 복원됨 · Run으로 컴파일", "is-dirty");});
        on($("studioDraftDiscard"),"click",clearDraft);
      }catch(error){console.warn("임시 저장본 검증 실패:",error);}}; renderTextures();
    const savedDraft = (()=>{try{return localStorage.getItem(DRAFT_KEY);}catch(_){return null;}})(); const loadImage = async file => {
      const check=beginLoad(),result=await renderer.addTexture(file);if(disposed)return;renderTextures();
      try {check();}catch(error){setStatus(`${file.name} 추가됨 · 작업 변경으로 자동 채널 연결을 취소했습니다.`);return;}
      const connected=connectTexture(result.id);renderChannels();
      if(connected&&!result.saved)setStatus(`${$("studioMessage").textContent} · 로컬 저장 불가`);
      else if(!result.saved) setStatus(`이미지 추가됨 · 로컬 저장 불가: ${result.error}`);
    }; const loadGLSL = async file => {
      if(!/\.(frag|glsl|fs)$/i.test(file.name) || file.size>1048576) throw new Error("1MiB 이하의 .frag/.glsl/.fs 파일만 지원합니다.");
      const check=beginLoad();if(!await confirmReplace()) return;check();const code=(await file.text()).replace(/^\uFEFF/,"");check();
      if(code.length>262144 || !code.startsWith("#version 300 es")) throw new Error("262144자 이하의 GLSL ES 3.00 소스가 필요합니다.");
      $("studioCode").value=code;editor.update();rememberEditor();schedule();open();
      setStatus(`${file.name} 불러옴 · Run으로 적용`,"is-dirty");
    }; const saveGLSL = () => download(`${selected}.frag`,$("studioCode").value,"text/plain;charset=utf-8"); const insertSample = text => {
      const area=$("studioCode");area.focus();area.setRangeText(text,area.selectionStart,area.selectionEnd,"end");
      area.dispatchEvent(new Event("input",{bubbles:true}));
    }; on($("studioOpenGLSL"),"click",()=>$("studioGLSLFile").click()); on($("studioSaveGLSL"),"click",()=>{try{saveGLSL();setStatus(`${selected}.frag 내보냄 · 현재 패스 코드만 포함`);}catch(error){showError(error);}});
    on($("studioGLSLFile"),"change",async event=>{
      const file=event.target.files?.[0];event.target.value=""; if(file)await runFile($("studioOpenGLSL"),"GLSL 읽는 중…",()=>loadGLSL(file));
    }); on($("studioSampleUV"),"click",()=>insertSample("texture(iChannel0, gl_FragCoord.xy / uResolution)"));
    on($("studioSamplePixel"),"click",()=>insertSample("texelFetch(iChannel0, ivec2(gl_FragCoord.xy), 0)"));
    // 로컬 파일만 가로채며, 코드 선택 영역의 일반적인 드래그는 유지한다.
    on($("studioDock"),"dragover",event=>{if(event.dataTransfer?.types.includes("Files"))event.preventDefault();});
    on($("studioDock"),"drop",async event=>{
      if(!event.dataTransfer?.files.length)return;event.preventDefault(); const file=event.dataTransfer.files[0];
      try {if(file.type.startsWith("image/"))await loadImage(file);else await loadGLSL(file);} catch(error){showError(error);}
    }); on($("studioTextureAdd"),"click",()=>$("studioTextureFile").click()); on($("studioTextureFile"),"change",async event=>{
      const file=event.target.files?.[0];event.target.value="";if(!file)return;
      await runFile($("studioTextureAdd"),"이미지 읽는 중…",()=>loadImage(file));
    }); on($("studioCode"),"input",event=>{ rememberEditor();schedule((event.inputType==="insertText" && event.data?.length===1) || /^(deleteContent|insertCompositionText|insertReplacementText)/.test(event.inputType||"")); }); on($("studioCode"),"keydown",event=>{
      if(event.isComposing)return;
      if((event.ctrlKey||event.metaKey) && !event.altKey && (event.key.toLowerCase()==="z" || event.key.toLowerCase()==="y")) {
        event.preventDefault();historyMove(event.key.toLowerCase()==="z"&&!event.shiftKey);
      } else if(event.altKey && ["PageUp","PageDown"].includes(event.key)) {
        event.preventDefault();const tabs=["Image",...project.passes.map(p=>p.name)],index=tabs.indexOf(selected);
        select(tabs[(index+(event.key==="PageDown"?1:-1)+tabs.length)%tabs.length]);$("studioCode").focus();
      } else if((event.key==="Enter" || event.key.toLowerCase()==="s")&&(event.ctrlKey||event.metaKey)) {
        event.preventDefault();rememberEditor();apply();
      }
    }); on($("studioRun"),"click",()=>{rememberEditor();apply();});
    on($("studioChangeUndo"),"click",()=>historyMove(true));on($("studioUndo"),"click",()=>historyMove(true));on($("studioRedo"),"click",()=>historyMove(false));
    on($("studioPassTabs"),"keydown",event=>{
      if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      const tabs=[...$("studioPassTabs").querySelectorAll("button")],index=tabs.indexOf(document.activeElement);
      if(index<0)return;event.preventDefault();
      const next=event.key==="Home"?0:event.key==="End"?tabs.length-1:
        (index+(event.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;
      select(next===0?"Image":project.passes[next-1].name);$("studioPassTabs").children[next].focus();
    }); on($("studioAdd"),"click",add);on($("studioDuplicate"),"click",duplicate);on($("studioRemove"),"click",remove);
    on($("studioUp"),"click",()=>move(-1));on($("studioDown"),"click",()=>move(1));
    // 기본값과 같은 선택 항목은 프로젝트에서 지워 기존 JSON 모양을 유지한다.
    const setPassOption=(key,value,fallback)=>{const p=find(selected);if(!p)return;if(value===fallback)delete p[key];else p[key]=value;};
    on($("studioFormat"),"change",event=>{const p=find(selected);p.format=event.target.value;if(p.filter===(p.format==="rgba32f"?"nearest":"linear"))delete p.filter;schedule();apply();});
    on($("studioScale"),"change",event=>{const p=find(selected),value=event.target.value,size=/^size:(\d+)x(\d+)$/.exec(value);
      if(size){p.size=[Number(size[1]),Number(size[2])];p.scale=1;}else{delete p.size;p.scale=Number(value);}schedule();apply();});
    on($("studioOutputs"),"change",event=>{const p=find(selected),outputs=Number(event.target.value);setPassOption("outputs",outputs,1);
      // 줄어든 출력을 읽던 채널 연결은 0번 출력으로 되돌린다.
      const fixed=[];for(const entry of [...project.passes,{name:"Image",channels:project.imageChannels}])for(const [key,ref] of Object.entries(entry.channels))
        if(ref.buffer===p.name&&ref.attachment>=outputs){delete ref.attachment;fixed.push(`${entry.name}.iChannel${key}`);}
      renderChannels();renderGraph();schedule();apply();if(fixed.length)showChange(`출력 수 변경 · 0번 출력으로 되돌린 연결: ${fixed.join(", ")}`);});
    on($("studioFilter"),"change",event=>{const p=find(selected);setPassOption("filter",event.target.value,p.format==="rgba32f"?"nearest":"linear");schedule();apply();});
    on($("studioWrap"),"change",event=>{setPassOption("wrap",event.target.value,"clamp");schedule();apply();});
    on($("studioMip"),"change",event=>{setPassOption("mipmap",event.target.checked,false);schedule();apply();});
    on($("studioLive"),"change",()=>{if(!$("studioLive").checked && timer) {clearTimeout(timer);timer=null;} else if(dirty) schedule();});
    on($("studioExampleRaymarch"),"click",exampleRaymarch);on($("studioExampleFeedback"),"click",exampleFeedback);on($("studioExamplePipeline"),"click",examplePipeline);
    on($("studioReset"),"click",()=>proceed(confirmReplace(),()=>ask({title:"장면 초기화",message:"모든 편집 패스와 Custom Uniform을 초기화하고 기본 셰이더 아트 화면으로 돌아갈까요?",ok:"초기화",danger:true}).then(ok=>ok&&replaceProject({image:original,passes:[],imageChannels:{}}))));
    on($("studioExport"),"click",exportJSON); on($("studioImport"),"click",()=>$("studioImportFile").click());
    on($("studioImportFile"),"change",async event=>{
      const file=event.target.files?.[0];if(!file)return;
      try {if(file.size>JSON_LIMIT)throw new Error("JSON 파일은 16MiB 이하여야 합니다.");
        const check=beginLoad(),text=await file.text();check();const data=JSON.parse(text);if(data.version!==1)throw new Error("지원하지 않는 프로젝트 형식입니다.");
        if(await confirmReplace()) {check();const next=validateProject(data.project),count=detachMissing(next);
          if(setProject(next)&&count)setStatus(`${count}개 이미지 연결이 해제됐습니다. 원본 이미지를 다시 가져오세요.`,"is-dirty");} }
      catch(error) { showError(error); }finally {event.target.value="";}
    }); on($("studioExportPack"),"click",event=>runFile(event.currentTarget,"Pack 준비 중…",exportPack));on($("studioImportPack"),"click",()=>$("studioPackFile").click());
    on($("studioPackFile"),"change",async event=>{
      const file=event.target.files?.[0];event.target.value="";if(!file)return;
      await runFile($("studioImportPack"),"Pack 읽는 중…",()=>importPack(file));
    }); on($("studioErrorToggle"),"click",()=>{$("studioError").hidden=!$("studioError").hidden;});
    on($("studioToggle"),"click",toggle);on($("studioHide"),"click",close); on($("studioOpenFromPanel"),"click",open);
    on($("studioMaximize"),"click",maximize); on($("screen"),"click",inspectPixel); on($("studioPause"),"click",()=>togglePlayback()); on($("studioResetFrames"),"click",()=>{renderer.resetSimulation();setStatus("버퍼와 시뮬레이션 시간이 초기화됐습니다.");});
    const getPlaybackState = () => expanded?resumeAfterMaximize:renderer.getStats().running;
    const togglePlayback = () => {if(expanded)resumeAfterMaximize=!resumeAfterMaximize;else if(renderer.getStats().running)renderer.stop();else renderer.start();
      syncPauseButton();return getPlaybackState();};
    on($("studioToolsToggle"),"click",()=>{const hidden=$("studioTools").hidden=!$("studioTools").hidden;$("studioToolsToggle").setAttribute("aria-expanded",String(!hidden));saveWorkspace();});
    const resizer=$("studioResize");let sizing=false;
    on(resizer,"pointerdown",e=>{if(e.button!==0)return;sizing=true;resizer.setPointerCapture(e.pointerId);e.preventDefault();});
    on(resizer,"pointermove",e=>{if(!sizing)return;const rect=$("stage").getBoundingClientRect();
      if(splitRight()){if(rect.width>0)setDockWidth((rect.right-e.clientX)/rect.width*100);}
      else if(rect.height>0)setDockHeight((rect.bottom-e.clientY)/rect.height*100);});
    on(resizer,"pointerup",()=>{sizing=false;});on(resizer,"pointercancel",()=>{sizing=false;});on(resizer,"lostpointercapture",()=>{sizing=false;});on(resizer,"dblclick",()=>splitRight()?setDockWidth(46):resetDockHeight());
    on(resizer,"keydown",e=>{
      if(splitRight()){if(["ArrowLeft","ArrowRight","Home","End"].includes(e.key)){e.preventDefault();setDockWidth(e.key==="Home"?30:e.key==="End"?75:dockWidth+(e.key==="ArrowLeft"?3:-3));}return;}
      if(["ArrowUp","ArrowDown","Home","End"].includes(e.key)) {e.preventDefault();setDockHeight(e.key==="Home"?25:e.key==="End"?85:dockHeight+(e.key==="ArrowUp"?3:-3));}});
    on($("studioLayout"),"click",toggleLayout);
    // 편집기 메뉴(⋯): 항목을 고르거나, 바깥을 누르거나, Esc를 누르면 닫는다. 글자 크기·들여쓰기 같은 값 조절은 열어 둔다.
    const menu=$("studioCodeTools");
    on(menu,"click",event=>{if(event.target?.closest?.(".studio-menu-panel>button"))menu.open=false;});
    on(document,"pointerdown",event=>{if(menu.open&&!menu.contains?.(event.target))menu.open=false;});
    // 편집기를 아래에 작게 배치하면 메뉴가 #stage(overflow:hidden) 밖으로 나가 잘린다.
    // 열 때 아래·위 여유 공간을 재서 더 넓은 쪽으로 펼치고, 그 공간에 맞게 높이를 제한한다(넘치면 메뉴 안에서 스크롤).
    const placeMenu=()=>{
      const panel=menu.querySelector?.(".studio-menu-panel"),summary=menu.querySelector?.("summary");if(!menu.open||!panel?.style||!summary?.getBoundingClientRect)return;
      panel.classList.remove("is-up");panel.style.maxHeight="";
      const clip=$("stage")?.getBoundingClientRect?.(),view=window.innerHeight||document.documentElement?.clientHeight||0,gap=6,margin=8;
      const limitTop=Math.max(0,clip?.top??0)+margin,limitBottom=Math.min(view,clip?.bottom??view)-margin,anchor=summary.getBoundingClientRect();
      const below=limitBottom-(anchor.bottom+gap),above=(anchor.top-gap)-limitTop,natural=panel.scrollHeight||0;
      const up=below<natural&&above>below;panel.classList.toggle("is-up",up);
      panel.style.maxHeight=`${Math.max(120,Math.floor(Math.min(540,up?above:below)))}px`;
    };
    on(menu,"toggle",placeMenu);on(window,"resize",placeMenu);
    on(menu,"keydown",event=>{if(event.key==="Escape"&&menu.open){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector?.("summary")?.focus();}});
    // 분할 배치에서 도구 서랍은 코드 위에 겹치므로, 코드를 누르면 닫아 편집 영역을 돌려준다.
    const closeToolsDrawer=()=>{if(!$("studioTools").hidden){$("studioTools").hidden=true;$("studioToolsToggle").setAttribute("aria-expanded","false");}};
    on($("studioCode"),"pointerdown",()=>{if(splitRight())closeToolsDrawer();});
    on(document,"keydown",event=>{
      if(event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.isComposing) return;
      if(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) return;
      if(event.key.toLowerCase()==="e") {event.preventDefault();toggle();}
    }); on(document,"fullscreenchange",()=>{if(document.fullscreenElement)close();});
    const workspaceKey="webgl.shader-studio.workspace.v1",groups=["studioInputs","studioFiles","studioStarters","studioImages","studioDependencies","studioInspector","studioCodeTools"];
    const saveWorkspace=()=>{try{localStorage.setItem(workspaceKey,JSON.stringify({toolsHidden:$("studioTools").hidden,open:Object.fromEntries(groups.map(id=>[id,$(id).open]))}));}catch(_){}};
    setDockHeight(dockHeight,false);setDockWidth(dockWidth,false);applyLayout();
    // 창 크기를 바꾸면(화면 분할 등) 사용자가 정하지 않은 높이·배치는 새 크기의 기본값으로 다시 맞춘다.
    on(window,"resize",()=>{
      if(!heightChosen&&dockHeight!==responsiveHeight())setDockHeight(responsiveHeight(),false);
      const fit=fitLayout();if(!layoutChosen&&layout!==fit){layout=fit;applyLayout();if(splitRight())closeToolsDrawer();}
    });$("studioTools").hidden=window.matchMedia("(max-width:600px)").matches||layout==="right";
    try{const state=JSON.parse(localStorage.getItem(workspaceKey)||"{}");if(typeof state?.toolsHidden==="boolean")$("studioTools").hidden=state.toolsHidden;for(const id of groups)if(typeof state?.open?.[id]==="boolean")$(id).open=state.open[id];}catch(_){}
    // 옆 배치에서 도구는 코드를 덮는 서랍이므로, 아래 배치에서 저장된 "도구 표시" 상태와 관계없이 닫힌 채로 시작한다.
    if(splitRight())$("studioTools").hidden=true;
    for(const id of groups)on($(id),"toggle",saveWorkspace);$("studioToolsToggle").setAttribute("aria-expanded",String(!$("studioTools").hidden));renderEditor();restore();loadDraft(savedDraft);undoStack.length=redoStack.length=0;checkpoint=historyState();syncHistory();
    const removeAllPasses = () => proceed(confirmReplace(),()=>setProject({image:renderer.getFragmentSource(),passes:[],imageChannels:{}}));
    // 갤러리 등 외부 예제: 미적용 변경 확인 → 코드·버퍼·파라미터 일괄 교체(Undo 가능).
    const loadExample = (next,users=[]) => startProject(next,users);
    // 가이드 코드 예시 삽입. replace=true면 현재 패스 전체를 교체한다(Undo로 복원 가능).
    // 커서가 #version/precision 줄보다 앞에 있으면 컴파일이 깨지므로 precision 줄 다음으로 옮겨 넣는다.
    const insertSnippet = (text,replace=false) => {
      if(disposed||typeof text!=="string")return false; open();const area=$("studioCode");area.focus({preventScroll:true});
      if(replace)area.setSelectionRange(0,area.value.length);
      else {
        const header=/^[\s\S]*?\bprecision\s+\w+\s+float\s*;[^\n]*\n?/.exec(area.value)?.[0]??(/^#version[^\n]*\n?/.exec(area.value)?.[0]||"");
        if(area.selectionStart<header.length)area.setSelectionRange(header.length,header.length);
        const at=area.selectionStart,lineStart=at===0||area.value[at-1]==="\n";
        text=(lineStart?"":"\n")+text+(area.value[at]==="\n"||at===area.value.length?"":"\n")+(lineStart?"\n":"");
      }
      area.setRangeText(text,area.selectionStart,area.selectionEnd,"end");area.dispatchEvent(new Event("input",{bubbles:true}));
      setStatus(replace?"가이드 코드로 교체됨 · Ctrl+Z로 되돌리기":"가이드 코드 삽입됨 · 필요하면 위치를 조정하세요","is-dirty");return true;
    };
    // 코드 조각 라이브러리 삽입: global(함수 정의)은 전역 위치에, main(문장)은 함수 안 커서 위치에 넣는다.
    //  - 커서가 함수 본문 안이면 global은 그 함수 선언 바로 앞에 넣는다(함수 안 함수 정의 방지).
    //  - 커서가 함수 밖이면 main 코드는 main() 본문 첫 줄에 넣는다.
    // 한 번의 input 이벤트로 반영하므로 Undo 한 번에 되돌아간다.
    const insertCode = ({global="",main="",replace="",note=""}={}) => {
      if(disposed)return false;open();const area=$("studioCode");area.focus({preventScroll:true});
      const done=()=>{if(note)setStatus(note,"is-dirty");return true;};
      if(replace){area.setRangeText(replace,0,area.value.length,"end");area.dispatchEvent(new Event("input",{bubbles:true}));return done();}
      let src=area.value,caret=area.selectionStart;
      // 주석을 같은 길이의 공백으로 지운 사본으로 괄호 깊이를 센다. 삽입할 때마다 다시 계산한다.
      const strip=text=>text.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/g,m=>m.replace(/[^\n]/g," "));
      const headerEnd=()=>{const clean=strip(src);return (/^[\s\S]*?\bprecision\s+\w+\s+float\s*;[^\n]*\n?/.exec(clean)?.[0]??(/^#version[^\n]*\n?/.exec(clean)?.[0]||"")).length;};
      const scan=limit=>{const clean=strip(src),header=headerEnd();let depth=0,declStart=header;
        for(let i=header;i<limit;i++){const c=clean[i];if(c==="{")depth++;else if(c==="}"){depth=Math.max(0,depth-1);if(!depth)declStart=i+1;}else if(c===";"&&!depth)declStart=i+1;}
        return {depth,declStart,header};};
      const lineStart=at=>src.lastIndexOf("\n",at-1)+1;
      const insertAt=(at,text)=>{src=src.slice(0,at)+text+src.slice(at);if(at<=caret)caret+=text.length;};
      caret=Math.max(caret,headerEnd());
      if(global){
        const {depth,declStart,header}=scan(caret),text=global.replace(/\s+$/,"")+"\n\n";let at;
        if(depth>0){at=declStart;while(at<src.length&&/\s/.test(src[at]))at++;at=lineStart(at);}   // 감싼 함수 선언 바로 앞
        else if(!src.slice(lineStart(caret),caret).trim())at=Math.max(header,lineStart(caret));      // 빈 줄 시작
        else {const next=src.indexOf("\n",caret);at=next<0?src.length:next+1;if(next<0){src+="\n";at=src.length;}} // 현재 줄 다음
        insertAt(at,text);
      }
      if(main){
        const {depth}=scan(caret),indent="    ",body=main.replace(/\s+$/,"").split("\n").map(line=>line?indent+line:line).join("\n")+"\n";
        if(depth>0){
          // 줄 맨 앞이면 그 줄 위에, 줄 중간이면 다음 줄에 넣는다(문장을 쪼개지 않음).
          const start=lineStart(caret),next=src.indexOf("\n",caret),at=!src.slice(start,caret).trim()?start:next<0?src.length:next+1;
          if(at===src.length&&!src.endsWith("\n"))src+="\n";insertAt(at,body);caret=at+body.length;
        }
        else {
          // 함수 밖이면 main() 본문의 끝(닫는 괄호 앞)에 넣는다. 앞에서 선언한 uv 같은 변수를 쓸 수 있다.
          const clean=strip(src),m=/\bvoid\s+main\s*\(\s*\)\s*\{/.exec(clean);let at=src.length;
          if(m){let d=0;for(let i=m.index+m[0].length-1;i<clean.length;i++){if(clean[i]==="{")d++;else if(clean[i]==="}"&&--d===0){at=lineStart(i);break;}}}
          insertAt(at,body);caret=at+body.length;
        }
      }
      area.value=src;area.setSelectionRange(caret,caret);area.dispatchEvent(new Event("input",{bubbles:true}));return done();
    };
    // 명령 팔레트(Ctrl+Shift+P)에 편집기 바깥 기능도 등록한다. 대부분 기존 버튼을 누르는 것과 같다.
    const press = (label, id, key) => ({label, key, run:() => { const button=$(id); if(button && !button.disabled) button.click(); }});
    const stepPass = step => { const tabs=[...$("studioPassTabs").children], at=tabs.findIndex(tab=>tab.classList.contains("is-active")); tabs[(at+step+tabs.length)%tabs.length]?.click(); };
    editor.registerCommands?.([
      press("셰이더 실행 (적용)","studioRun","Ctrl+Enter"), press("되돌리기","studioUndo","Ctrl+Z"), press("다시 실행","studioRedo","Ctrl+Y"),
      {label:"자동 적용 켜기/끄기", run:() => $("studioLive").click()},
      press("버퍼 패스 추가","studioAdd"), {label:"다음 패스로", key:"Alt+PageDown", run:() => stepPass(1)}, {label:"이전 패스로", key:"Alt+PageUp", run:() => stepPass(-1)},
      press("재생 / 일시정지","studioPause"), press("시간·프레임 초기화","studioResetFrames"), press("도구 서랍 열기/닫기","studioToolsToggle"),
      press("집중 모드 전환","studioMaximize"), press("편집기 배치 바꾸기 (오른쪽 ↔ 아래)","studioLayout"), press("편집기 닫기","studioHide","E"),
      press("코드 조각 모음 열기","studioSnippets"), press("파라미터 패널 열기","studioParameters"), press("도움말 · 단축키","studioHelp","?"),
      press(".frag 파일로 저장","studioSaveGLSL"), press(".frag 파일 열기","studioOpenGLSL"), press("전체 프로젝트 저장 (Pack)","studioExportPack"), press("Pack 열기","studioImportPack"),
      press("이미지 파일 불러오기","studioTextureAdd"), press("기본 Shader Art로 새로 시작","studioReset")]);
    return {open,close,toggle,apply,setProject,getPlaybackState,togglePlayback,loadFromRenderer,removeAllPasses,exampleRaymarch,examplePipeline,exampleFeedback,loadExample,insertSnippet,insertCode,getEditorSource:()=>$("studioCode").value,
      undo:()=>historyMove(true),redo:()=>historyMove(false),getProject:()=>copy(project),exportPack,importPack,dispose:()=>{
        disposed=true;if(timer)clearTimeout(timer);if(draftTimer)clearTimeout(draftTimer);
        if(dirty){try{rememberEditor();localStorage.setItem(DRAFT_KEY,JSON.stringify({version:1,project,selected}));}catch(_){}}
        if(pending)finish(false);editor.dispose();controller.abort();}};
  }; return {mount};
})(code_editor, annotations);
const ui=(()=>{
// Renderer의 공개 API만 호출하는 설정 패널. WebGL 리소스를 소유하지 않는다.
  const mount = (renderer, input, settings) => {
    const $ = id => document.getElementById(id); const controller = new AbortController(), signal = controller.signal;
    const element = tag => document.createElement(tag),setText=(id,text)=>{const node=$(id);if(node.textContent!==text)node.textContent=text;};
    const listen = (el, event, callback) => el.addEventListener(event, callback, {signal}); const showError = message => {
      $("uiError").textContent = message || ""; $("toastMessage").textContent = message || "";$("uiToast").hidden=!message; $("uiToast").classList.toggle("is-visible", !!message);
    }; const attempt = callback => { try { callback(); showError(""); } catch(error) { showError(error.message); } };
    listen($("uiDismiss"),"click",()=>showError(""));
    // 터치 기기에서 검색창에 포커스하면 가상 키보드가 패널을 가리므로 파라미터 탭에 포커스한다.
    const touchOnly = window.matchMedia?.("(hover:none) and (pointer:coarse)").matches === true;
    const focusSearch = () => (touchOnly ? $("tab-uniforms") : $("uniformSearch")).focus();
    // 타입 정보(성분 수, f/i/u/b/m 종류)는 Renderer의 표를 따른다. 새 타입이 추가돼도 UI 분기는 바뀌지 않는다.
    const typeTable = new Map((renderer.getUniformTypes?.() || []).map(item => [item.type, item]));
    const typeInfo = type => typeTable.get(type) || {type, components:Number(/^vec([234])$/.exec(type)?.[1]) || 1, kind:type === "bool" ? "b" : type === "int" ? "i" : "f"};
    const parseBool = (raw, type) => {
      if(!["true", "false", "1", "0"].includes(raw.toLowerCase())) throw new Error(`${type}은 true/false 또는 1/0으로 입력하세요.`);
      return raw.toLowerCase() === "true" || raw === "1";
    };
    // 카메라 조작 등으로 생긴 0.5239193476851991 같은 값은 입력 칸에 유효숫자 6자리로만 표시한다.
    const displayNumber = value => typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value) ? String(Number(value.toPrecision(6))) : String(value);
    const validNumber = (kind, value) => Number.isFinite(value) && (kind === "f" || kind === "m" || (Number.isInteger(value) && (kind !== "u" || value >= 0)));
    // 입력 중 숫자가 아닌 값이나 잘못된 차원의 벡터가 넘어가지 않도록 경계에서 검증한다.
    const parseValue = (type, text) => {
      const raw = text.trim(), {components:size, kind} = typeInfo(type); if(!raw) throw new Error("Uniform 값을 입력해야 합니다.");
      if(size > 1) {
        if(/(^,|,$|,\s*,)/.test(raw)) throw new Error("벡터의 각 성분에 숫자를 입력하세요.");
        const parts = raw.split(/[\s,]+/);
        if(kind === "b") { if(parts.length !== size) throw new Error(`${type}에는 true/false 값 ${size}개가 필요합니다.`); return parts.map(part => parseBool(part, type)); }
        const result = parts.map(Number);
        if(result.length !== size || !result.every(value => validNumber(kind, value))) throw new Error(`${type}에는 ${kind === "f" || kind === "m" ? "숫자" : kind === "u" ? "0 이상 정수" : "정수"} ${size}개가 필요합니다.`);
        return result;
      }
      if(kind === "b") return parseBool(raw, type);
      const result = Number(raw);
            if(!validNumber(kind, result)) throw new Error(`${type}에 맞는 숫자를 입력하세요.`);
      return result;
    };
    // 기본 입력값: 행렬은 단위 행렬, 그 외는 0(bool은 true).
    const defaultValue = type => {
      const {components:size, kind} = typeInfo(type), dim = Math.round(Math.sqrt(size));
      if(kind === "m") return Array.from({length:size}, (_, i) => i % (dim + 1) === 0 ? 1 : 0).join(", ");
      if(kind === "b") return size > 1 ? Array(size).fill("false").join(", ") : "true";
      return size > 1 ? Array(size).fill(0).join(", ") : kind === "f" ? "0.5" : "0";
    }; let deletedUniform=null; const clearDeleted = () => {deletedUniform=null;$("undoUniform").hidden=true;$("uniformNotice").textContent="";}; let uniformSnapshot = ""; const renderUniforms = () => {
      const userList = $("uniformList"), items = renderer.getUserUniforms();
      const search = $("uniformSearch").value.trim().toLowerCase(); uniformSnapshot = JSON.stringify(items);
      userList.replaceChildren();
      $("uniformCount").textContent = `${items.length} / 64`;$("uniformCreate").disabled=items.length>=64; for(const item of items) {
                if(search && !`${item.name} ${item.type}`.toLowerCase().includes(search)) continue;
                const row = element("div"); row.className = "uniform-row";
        const top = element("div"); top.className = "uniform-top"; const title = element("div");
        const name = element("span"); name.className = "uniform-name"; name.textContent = item.name;
        const type = element("span"); type.className = "uniform-type"; type.textContent = item.type;
        title.append(name, type);
        const remove = element("button"); remove.className = "remove-uniform glyph-icon icon-close"; remove.type = "button";
        remove.title = `${item.name} 삭제 · GLSL에서 참조 중이면 먼저 코드를 수정하세요`; remove.setAttribute("aria-label",`${item.name} 삭제`);
        remove.addEventListener("click", () => attempt(() => { const current=renderer.getUserUniforms().find(u=>u.name===item.name);if(!current)return renderUniforms();renderer.removeUniform(item.name);deletedUniform=current;$("undoUniform").hidden=false;$("uniformNotice").textContent=`${item.name} 삭제됨`; renderUniforms(); $("undoUniform").focus(); }));
        top.append(title, remove);
        const commit = (field, value) => {
          try {renderer.setUniform(item.name,value);item.value=value;field.removeAttribute("aria-invalid");showError("");return true;}
          catch(error){field.setAttribute("aria-invalid","true");showError(`${item.name}: ${error.message}`);return false;}
        };
        row.append(top); if(item.type === "bool") {
          const label = element("label"); label.className = "uniform-switch";
          const input = element("input"); input.type = "checkbox"; input.checked = item.value; input.setAttribute("role","switch");
          const text = element("span"); text.textContent = item.value ? "true · 켜짐" : "false · 꺼짐";
          input.setAttribute("aria-label",item.name); input.addEventListener("change", () => {if(!commit(input,input.checked))input.checked=item.value;text.textContent=input.checked?"true · 켜짐":"false · 꺼짐";});
          label.append(input, text); row.append(label);
        } else if(item.options?.color) {
          // 색상: RGB는 컬러 피커(0~1 선형 값을 그대로 8bit로 표시), vec4의 A는 별도 슬라이더.
          const wrap = element("div"); wrap.className = "uniform-color";
          const picker = element("input"); picker.type = "color"; picker.setAttribute("aria-label",`${item.name} 색상`);
          const code = element("code"); const hex = values => "#" + values.slice(0,3).map(v => Math.round(Math.max(0,Math.min(1,v))*255).toString(16).padStart(2,"0")).join("");
          const show = values => { picker.value = hex(values); code.textContent = values.map(v => Number(v).toFixed(3)).join(", "); };
          const current = () => [...(renderer.getUserUniforms().find(u=>u.name===item.name)?.value || item.value)];
          picker.addEventListener("input", () => {
            const values = current(), rgb = picker.value.match(/[0-9a-f]{2}/gi).map(h => parseInt(h,16)/255);
            values.splice(0,3,...rgb); if(commit(picker,values)) show(values);
          }); wrap.append(picker, code);
          if(item.type === "vec4") {
            const alpha = element("input"); alpha.type = "range"; alpha.min = "0"; alpha.max = "1"; alpha.step = "0.001"; alpha.value = String(item.value[3]);
            alpha.setAttribute("aria-label",`${item.name} 알파`); alpha.title = "Alpha";
            alpha.addEventListener("input", () => { const values = current(); values[3] = Number(alpha.value); if(commit(alpha,values)) show(values); });
            wrap.append(alpha);
          }
          show(item.value); row.append(wrap);
        } else if(typeInfo(item.type).components > 1) {
          // 벡터는 X/Y/Z/W, 행렬은 column-major 순서의 [열,행] 칸으로 편집한다. bvec 성분은 체크박스.
          // 범위가 지정된 벡터는 성분마다 슬라이더 + 숫자 입력을 둔다.
          const {kind} = typeInfo(item.type), dim = kind === "m" ? Math.round(Math.sqrt(item.value.length)) : 0;
          const opts = item.options || {}, ranged = !dim && kind !== "b" && Number.isFinite(opts.min) && Number.isFinite(opts.max);
          const grid = element("div"); grid.className = dim ? "uniform-vector is-matrix" : ranged ? "uniform-vector is-ranged" : "uniform-vector";
          if(dim) grid.style.setProperty("--uniform-columns", String(dim));
          item.value.forEach((value, index) => {
            const field = element("div");
            const label = element("label"); label.textContent = dim ? `${Math.floor(index / dim)},${index % dim}` : ["X", "Y", "Z", "W"][index];
            const input = element("input"); input.setAttribute("aria-label",`${item.name} ${label.textContent}`);
            if(kind === "b") { input.type = "checkbox"; input.checked = value; }
            else { input.type = "number"; input.step = kind === "f" || kind === "m" ? "any" : "1"; if(kind === "u") input.min = "0"; input.value = displayNumber(value); }
            const update = (source, next) => {
              const values = renderer.getUserUniforms().find(u=>u.name===item.name)?.value;
              if(!values)return renderUniforms();
              item.value=[...values];values[index] = next;
              if(!commit(source,values)) { if(kind === "b") input.checked = item.value[index]; else input.value=displayNumber(item.value[index]); return false; }
              return true;
            };
            let slider = null;
            input.addEventListener("change", () => { if(update(input, kind === "b" ? input.checked : input.value.trim() ? Number(input.value) : NaN) && slider) slider.value = input.value; });
            if(ranged) {
              slider = element("input"); slider.type = "range"; slider.min = String(opts.min); slider.max = String(opts.max); slider.step = String(opts.step);
              slider.value = String(value); slider.setAttribute("aria-label",`${item.name} ${label.textContent} 슬라이더`);
              slider.addEventListener("input", () => { if(update(slider, Number(slider.value))) input.value = slider.value; });
              field.append(label, slider, input);
            } else field.append(label, input);
            grid.append(field);
          }); row.append(grid);
        } else {
          const pair = element("div"); pair.className = "uniform-pair";
          const number = element("input"); number.type = "number"; number.step = typeInfo(item.type).kind === "f" ? "any" : "1"; if(item.type === "uint") number.min = "0"; number.value = displayNumber(item.value);
          number.setAttribute("aria-label",item.name);
          const opts = item.options || {}; let range;
          const changeNumber = () => {
            let value;try {value=parseValue(item.type,number.value);}catch(error){showError(`${item.name}: ${error.message}`);number.setAttribute("aria-invalid","true");number.value=String(item.value);return;}
            if(commit(number,value)){if(range)range.value=String(value);}else number.value=String(item.value);
          };
          number.addEventListener("change",changeNumber);
          if(Number.isFinite(opts.min) && Number.isFinite(opts.max)) {
            range = element("input"); range.type = "range";
            range.min = String(opts.min); range.max = String(opts.max); range.step = String(opts.step);
            range.setAttribute("aria-label",`${item.name} 슬라이더`);range.value = String(item.value);
            range.addEventListener("input", () => {if(commit(range,Number(range.value)))number.value=displayNumber(item.value);});
            pair.append(range);
          }
          pair.append(number); row.append(pair);
        }
        userList.append(row);
      }
      const count=userList.children.length; $("uniformResults").textContent=search ? `${items.length}개 중 ${count}개 표시` : "";
      if(!count) {
        const hint=element("div");hint.className="uniform-empty";
        hint.textContent=search ? "검색 결과가 없습니다. 이름이나 타입을 확인하세요." : "아직 파라미터가 없습니다. 위에서 추가하거나 Starter로 시작하세요.";userList.append(hint);
      }
    }; listen($("undoUniform"),"click",()=>attempt(()=>{
      if(!deletedUniform)return;const {name,type,value,options}=deletedUniform;
      renderer.defineUniform(name,type,value,options);clearDeleted();$("uniformSearch").value="";renderUniforms();focusSearch();
    })); const updateTypeFields = () => {
      const t = $("uniformType").value,bool=t==="bool",{components:size,kind}=typeInfo(t);$("uniformValue").hidden=bool;$("uniformValue").required=!bool;$("uniformBoolValue").hidden=!bool;
      $("uniformValueHelp").textContent=bool?"선택한 상태가 GLSL의 true/false로 전달됩니다.":kind==="m"?`${size}개 숫자를 column-major 순서로 입력하세요. 기본값은 단위 행렬입니다.`:kind==="b"?`${size}개의 true/false를 쉼표로 구분하세요.`:size>1?`${size}개 ${kind==="f"?"숫자":kind==="u"?"0 이상 정수":"정수"}를 쉼표로 구분하세요. 예: ${defaultValue(t)}`:"숫자를 입력하세요. 슬라이더 범위는 선택 사항입니다."; $("rangeFields").hidden = !["f","i","u"].includes(kind);
      $("uniformColorField").hidden = !["vec3","vec4"].includes(t); if($("uniformColorField").hidden) $("uniformColor").checked = false;
      $("uniformValue").value = defaultValue(t);
    }; listen($("uniformType"), "change", updateTypeFields); listen($("uniformSearch"), "input", renderUniforms);
    listen($("uniformEditor"),"toggle",()=>{if($("uniformEditor").open)$("uniformName").focus();});
    listen($("uniformCancel"),"click",()=>{$("uniformEditor").open=false;showError("");$("uniformEditor").querySelector("summary").focus();});
    listen($("uniformForm"), "submit", event => {
      event.preventDefault(); attempt(() => {
        const type = $("uniformType").value; const value = parseValue(type,type==="bool"?$("uniformBoolValue").value:$("uniformValue").value);
        const min = $("uniformMin").value.trim(), max = $("uniformMax").value.trim(), step = $("uniformStep").value.trim();
        const hasBounds = ["f","i","u"].includes(typeInfo(type).kind) && [min, max, step].some(Boolean);
        if(hasBounds && ![min, max, step].every(Boolean)) throw new Error("슬라이더의 Min, Max, Step을 모두 입력하세요.");
        const opts = hasBounds ? {min:Number(min), max:Number(max), step:Number(step)} : {};
        if($("uniformColor").checked && ["vec3","vec4"].includes(type)) opts.color = true;
        renderer.defineUniform($("uniformName").value.trim(), type, value, opts);clearDeleted(); $("uniformSearch").value=""; renderUniforms(); $("uniformName").value = "";
        $("uniformMin").value = $("uniformMax").value = $("uniformStep").value = ""; $("uniformEditor").open = false; $("uniformEditor").querySelector("summary").focus();
      });
    }); listen($("fpsLimit"), "change", event => attempt(() => renderer.setFpsLimit(parseValue("int",event.target.value))));
    for(const button of document.querySelectorAll("[data-fps-preset]")) {
      listen(button, "click", () => attempt(() => {
        const value = Number(button.dataset.fpsPreset); renderer.setFpsLimit(value); $("fpsLimit").value = String(value); syncFpsPresets(value);
      }));
    }
    listen($("resolutionScale"), "input", event => attempt(() => {
      const value = Number(event.target.value);
            renderer.setResolutionScale(value); $("resolutionLabel").textContent = `${Math.round(value * 100)}%`;
    })); listen($("maxPixels"), "change", event => attempt(() => renderer.setMaxPixels(parseValue("int",event.target.value))));
    // Shader Image와 오프스크린 Buffer A/B/C/D를 같은 Preview 메뉴에서 확인한다.
    const syncBuffers = () => {
      const select = $("bufferPreview"), passes = renderer.getPasses(); const keys = ["",...passes.map(p => p.name)];
      const old = [...select.options].map(o => o.value); if(JSON.stringify(old) !== JSON.stringify(keys)) {
        select.replaceChildren(); for(const name of keys) {
          const option = element("option");
                    option.value = name; option.textContent = name ? `Buffer ${name}` : "Image · 최종 렌더링";
          select.append(option);
        }
      }
      const stats=renderer.getStats();select.value = stats.previewPass || ""; const memory=(stats.bufferMemoryBytes/1048576).toFixed(1);
      const timing = name => {const item=stats.gpu?.passes?.find(entry=>entry.label===name);return item?` · ${item.ms.toFixed(2)}ms`:"";};
            $("bufferInfo").textContent = passes.length ? passes.map(p => `${p.name}: ${p.width}×${p.height} · ${p.format}${timing(p.name)}`).join("  |  ")+` · GPU ≈ ${memory} MiB` :
      "등록된 버퍼가 없습니다. 아래 예제로 A/B 패스를 확인할 수 있습니다.";
    }; listen($("bufferPreview"), "change", event => attempt(() => renderer.setPreviewPass(event.target.value || null)));
    listen($("bufferDemo"), "click", () => attempt(() => {
      window.shaderStudio?.examplePipeline(); syncBuffers();
    })); listen($("bufferClear"), "click", () => attempt(() => {
      if(window.shaderStudio) window.shaderStudio.removeAllPasses(); else renderer.setPasses([]);syncBuffers();
    })); const stage = $("stage"),tabScroll=new Map();let activeTab="render"; const setActiveTab = tab => {
      const scroll=$("panel").querySelector(".panel-scroll");tabScroll.set(activeTab,scroll.scrollTop);activeTab=tab;
      for(const button of document.querySelectorAll("#panelTabs [data-tab]")) {
        const active = button.dataset.tab === tab; button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
      }
      for(const view of document.querySelectorAll(".panel-view")) {
        const active = view.dataset.panel === tab; view.classList.toggle("is-active", active); view.hidden = !active;
      }
      scroll.scrollTop=tabScroll.get(tab)||0; if(tab === "uniforms") renderUniforms();
    }; listen($("studioParameters"),"click",()=>{
      if(window.matchMedia("(max-width:820px)").matches)window.shaderStudio?.close();document.body.classList.remove("panel-hidden");syncPanel();setActiveTab("uniforms");focusSearch();
    }); const tabButtons = [...document.querySelectorAll("#panelTabs [data-tab]")];
    for(const button of tabButtons) listen(button, "click", () => setActiveTab(button.dataset.tab)); listen($("panelTabs"), "keydown", event => {
      if(!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const current = tabButtons.indexOf(document.activeElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabButtons.length - 1 :
      (current + (event.key === "ArrowRight" ? 1 : -1) + tabButtons.length) % tabButtons.length;
      setActiveTab(tabButtons[index].dataset.tab); tabButtons[index].focus();
    }); const syncPanel = () => {
      const hidden = document.body.classList.contains("panel-hidden");stage.inert=!hidden&&window.matchMedia("(max-width:820px)").matches;
      $("panelToggle").setAttribute("aria-label", hidden ? "설정 패널 열기" : "설정 패널 숨기기");
      $("panelToggle").setAttribute("aria-pressed", String(!hidden)); $("panelClose").title = hidden ? "패널 열기" : "패널 숨기기";
    }; const togglePanel = () => { document.body.classList.toggle("panel-hidden"); syncPanel(); if(!document.body.classList.contains("panel-hidden"))$("panelTabs").querySelector(`[data-tab="${activeTab}"]`)?.focus();else $("panelToggle").focus(); }; const toggleHud = () => {
      const hidden = stage.classList.toggle("hud-hidden"); $("hudToggle").setAttribute("aria-label", hidden ? "HUD 표시" : "HUD 숨기기");
      $("hudToggle").setAttribute("aria-pressed", String(!hidden));
    }; const syncFpsPresets = fps => {
      for(const button of document.querySelectorAll("[data-fps-preset]")) {
        const active = Number(button.dataset.fpsPreset) === fps; button.classList.toggle("is-selected", active);
        button.setAttribute("aria-pressed", String(active));
      }
    }; const toggleFullscreen = async () => {
      try {
        if(document.fullscreenElement === stage) await document.exitFullscreen();
        else await stage.requestFullscreen(); showError("");
            } catch(error) { showError(`전체화면 전환 실패: ${error.message}`); }
    }; listen($("cameraReset"), "click", () => input.resetCamera()); listen($("panelClose"), "click", togglePanel);
    // 가이드(guide.js)가 있으면 그쪽에서 목록을 채운 뒤 연다. <dialog>의 toggle 이벤트는 구형 브라우저에서 발생하지 않으므로 그것에 기대지 않는다.
    const helpDialog = $("quickHelp"), toggleHelp = () => { if(helpDialog.open) return helpDialog.close(); const request = new CustomEvent("guide-open-request", {cancelable:true}); if(document.dispatchEvent(request) && !helpDialog.open) helpDialog.showModal(); };
    for(const id of ["helpToggle","studioHelp"]) listen($(id),"click",toggleHelp);
    listen($("helpClose"),"click",()=>helpDialog.close());listen(helpDialog,"click",event=>{if(event.target===helpDialog)helpDialog.close();});
    listen(helpDialog,"keydown",event=>{if(!["Escape","?"].includes(event.key))event.stopPropagation();});
    listen(document,"shader-panel-changed",syncPanel);listen($("panelBackdrop"),"click",togglePanel);listen(window,"resize",syncPanel);listen($("panelToggle"),"click",togglePanel); listen($("hudToggle"), "click", toggleHud);
    listen($("fullscreenToggle"), "click", toggleFullscreen); listen($("screenshotButton"),"click",async () => {
      const button=$("screenshotButton");button.disabled=true;
      try {const blob=await renderer.captureScreenshot(),url=URL.createObjectURL(blob),a=element("a");
        a.href=url;a.download=`shader-${new Date().toISOString().replace(/[:.]/g,"-")}.png`;document.body.append(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),3000);showError("");
      }catch(error){showError(`PNG 저장 실패: ${error.message}`);}finally{button.disabled=false;}
    }); listen($("previewPause"),"click",()=>attempt(()=>{window.shaderStudio?.togglePlayback();updateStats();}));listen($("previewImage"),"click",()=>attempt(()=>{renderer.setPreviewPass(null);updateStats();}));
    listen($("screen"), "pointerdown", () => stage.classList.add("has-interacted"));
    listen($("screen"), "wheel", () => stage.classList.add("has-interacted")); listen(document, "fullscreenchange", () => {
      const active = document.fullscreenElement === stage; $("fullscreenToggle").setAttribute("aria-label", active ? "전체화면 종료" : "전체화면");
      $("fullscreenToggle").title = active ? "전체화면 종료 (F)" : "전체화면 (F)";
    }); listen(document, "keydown", event => {
      if(event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if(event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
      const key = event.key.toLowerCase(); if(event.code==="Space"&&(document.activeElement===stage||document.activeElement===$("screen"))){event.preventDefault();window.shaderStudio?.togglePlayback();updateStats();} else if(key === "?") {event.preventDefault();toggleHelp();}
      else if(key === "f") { event.preventDefault(); toggleFullscreen(); }
      else if(key === "h") { event.preventDefault(); togglePanel(); }
      else if(key === "g") { event.preventDefault(); toggleHud(); } else if(key === "/") {
        event.preventDefault(); document.body.classList.remove("panel-hidden"); syncPanel();
        setActiveTab("uniforms"); $("uniformSearch").focus();
      }
    }); syncPanel(); const updateStats = () => {
      const s = renderer.getStats();const camera=!!input.getCamera();$("cameraReset").disabled=!camera;$("stageHint").textContent=camera?"드래그 회전 · 휠 확대 · E 편집기":"E 편집기 열기 · / 파라미터 찾기";setText("cameraStatus",camera?"Orbit 카메라 활성 · 드래그와 휠로 조작할 수 있습니다.":"Orbit 카메라 비활성 · 현재 프로젝트는 일반 입력만 사용합니다.");const storage = settings.status(); setText("storageStatus",storage.message);
      $("storageStatus").classList.toggle("unavailable", !storage.available);
      // 외부 JS에서 변경한 설정도 패널에 반영한다. 사용자가 편집 중이면 값은 덮어쓰지 않는다.
      const playing=window.shaderStudio?.getPlaybackState()??s.running;$("previewPause").setAttribute("aria-label",playing?"일시정지":"재생");$("previewPause").setAttribute("aria-pressed",String(!playing));
      setText("renderState",s.running?"재생 중":"일시정지");$("renderState").dataset.running=String(s.running);{const pause=$("studioPause"),label=stage.classList.contains("studio-maximized")?(playing?"복귀 시 재생":"복귀 시 정지"):playing?"일시정지":"재생";pause.setAttribute("aria-label",label);pause.setAttribute("aria-pressed",String(!playing));pause.title=`${label} · 뷰포트에서는 Space`;}
      $("previewImage").disabled=!s.previewPass;$("bufferClear").disabled=!renderer.getPasses().length;
      const active = document.activeElement; if(active !== $("fpsLimit")) $("fpsLimit").value = s.fpsLimit;
      if(active !== $("resolutionScale")) $("resolutionScale").value = s.resolutionScale;
            $("resolutionLabel").textContent = `${Math.round(s.resolutionScale * 100)}%`;
      const pixelSelect = $("maxPixels"); let custom = pixelSelect.querySelector("option[data-custom]");
      if(custom && String(s.maxPixels) !== custom.value) { custom.remove(); custom = null; }
      if(![...pixelSelect.options].some(o => o.value === String(s.maxPixels))) {
        custom = element("option"); custom.dataset.custom = "true"; custom.value = String(s.maxPixels);
                custom.textContent = `사용자 설정 (${s.maxPixels.toLocaleString("ko-KR")}px)`;
        pixelSelect.append(custom);
      }
      if(active !== pixelSelect) pixelSelect.value = String(s.maxPixels);
      if(!$("view-uniforms").hidden && !(active instanceof Element && active.closest("#uniformList")) && uniformSnapshot !== JSON.stringify(renderer.getUserUniforms())) renderUniforms();
            $("statFps").textContent = s.fps.toFixed(1) + (s.fpsLimit ? ` / ${s.fpsLimit}` : "");
            $("statResolution").textContent = `${s.width} × ${s.height}`;
      $("statFrame").textContent = s.frame.toLocaleString("ko-KR");
      // GPU 시간은 EXT_disjoint_timer_query_webgl2가 있을 때만 측정된다. 없으면 CPU 제출 시간만 표시한다.
      const gpu = s.gpu, gpuText = gpu?.available && gpu.enabled ? (gpu.totalMs === null ? "측정 중" : `${gpu.totalMs.toFixed(2)}ms`) : "N/A";
      setText("statGpu", gpuText);
      $("statGpu").parentElement?.setAttribute?.("title", gpu?.available ? `패스별 GPU 시간(이동평균): ${gpu.passes.map(p=>`${p.label} ${p.ms.toFixed(2)}ms`).join(" · ") || "측정 대기"} · CPU 제출 ${(s.cpuMs??0).toFixed(2)}ms`
        : `이 브라우저/GPU는 GPU 타이머(EXT_disjoint_timer_query_webgl2)를 지원하지 않습니다. CPU 제출 ${(s.cpuMs??0).toFixed(2)}ms · 프레임 간격 ${(s.frameMs??0).toFixed(2)}ms`);
            $("stats").title = `${s.fps.toFixed(1)} FPS · ${s.width}×${s.height} · Frame ${s.frame} · GPU ${gpuText} · CPU ${(s.cpuMs??0).toFixed(2)}ms`;
            $("viewportMode").textContent = s.previewPass ? `BUFFER ${s.previewPass}` : "IMAGE";
      $("studioPreviewTarget").textContent=`미리보기 · ${s.previewPass?`Buffer ${s.previewPass}`:"Image"}`;
      syncBuffers(); syncFpsPresets(s.fpsLimit);
    };
    listen(document,"shader-settings-applied",()=>{clearDeleted(); $("uniformSearch").value="";renderUniforms();syncPanel();updateStats();});
    // JS에서 초기 설정이 이미 바뀌어 있더라도 UI 표시와 일치시킨다.
    listen($("resetSettings"), "click", () => attempt(() => {
      settings.reset(); $("uniformSearch").value = ""; renderUniforms(); updateStats(); syncPanel();
    })); updateTypeFields();clearDeleted();renderUniforms(); updateStats(); const timer = setInterval(updateStats, 500);
    return {dispose: () => { clearInterval(timer); controller.abort(); }};
  }; return {mount};
})();
const input=(()=>{
// 입력은 Renderer와 분리한다. 이 모듈은 포인터/키 상태를 수집하고 카메라 Uniform만 갱신한다.
// 키 입력은 캔버스를 클릭해 Stage에 초점을 준 상태에서만 카메라 조작에 사용한다.
  const mount = (canvas, renderer, home = [0,0,5]) => {
    const stage = document.getElementById("stage"); if(!stage) throw new Error("#stage 요소가 없습니다.");
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v)); const initial = {yaw:home[0],pitch:home[1],distance:home[2]};
    const camera = {...initial}, keys = new Set(), keyListeners = new Set(), dragListeners = new Set();
    const controller = new AbortController(), signal = controller.signal;
    const listen = (target, type, callback, options = {}) => target.addEventListener(type, callback, {...options, signal});
    const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
    let pointerId = null, lastX = 0, lastY = 0, frame = 0, lastTime = null, disposed = false; stage.tabIndex = 0;
    canvas.style.touchAction = "none"; // 터치 드래그가 브라우저 스크롤로 해석되지 않도록 한다.
    // UI나 외부 JS에서 uCameraOrbit를 수정한 경우, 다음 조작 전에 카메라 상태로 읽어온다.
    const readCamera = () => {
      const item=renderer.getUserUniforms().find(item=>item.name==="uCameraOrbit"),value=item?.value;
      if(item?.type!=="vec3" || !Array.isArray(value) || value.length!==3 || !value.every(Number.isFinite))return false;
      [camera.yaw, camera.pitch, camera.distance] = value; camera.pitch = clamp(camera.pitch, -1.4, 1.4);
      camera.distance = clamp(camera.distance, 1.5, 30);return true;
    }; const syncCamera = () => renderer.setUniform("uCameraOrbit",[camera.yaw,camera.pitch,camera.distance]);
    const getCamera = () => readCamera()?{...camera}:null; const setCamera = values => {
      if(disposed) throw new Error("폐기된 Input입니다.");if(!readCamera())return false;const next = {...camera, ...values};
      if(![next.yaw, next.pitch, next.distance].every(Number.isFinite)) throw new TypeError("카메라 값은 유효한 숫자여야 합니다.");
      camera.yaw = next.yaw; camera.pitch = clamp(next.pitch, -1.4, 1.4); camera.distance = clamp(next.distance, 1.5, 30);syncCamera();return true;
    }; const resetCamera = () => setCamera(initial); const isDown = code => keys.has(code);
    const onKey = callback => { keyListeners.add(callback); return () => keyListeners.delete(callback); };
    const onDrag = callback => { dragListeners.add(callback); return () => dragListeners.delete(callback); }; const stopKeyboard = () => {
      keys.clear(); if(frame) cancelAnimationFrame(frame); frame = 0; lastTime = null;
    }; const keyboardFrame = now => {
      frame = 0; if(disposed || document.hidden || ![...movementKeys].some(code => keys.has(code))) { lastTime = null; return; }
      if(!readCamera()){stopKeyboard();return;}
      const delta = lastTime === null ? 0 : Math.min((now - lastTime) / 1000, 0.05); lastTime = now;
      const speed = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 3 : 1) * delta;
      const horizontal = Number(keys.has("KeyA") || keys.has("ArrowLeft")) - Number(keys.has("KeyD") || keys.has("ArrowRight"));
      const vertical = Number(keys.has("ArrowUp")) - Number(keys.has("ArrowDown"));
      const zoom = Number(keys.has("KeyS")) - Number(keys.has("KeyW")); if(horizontal || vertical || zoom) {
        camera.yaw += horizontal * 1.4 * speed; camera.pitch = clamp(camera.pitch + vertical * 1.2 * speed, -1.4, 1.4);
        camera.distance = clamp(camera.distance * Math.exp(zoom * 1.4 * speed), 1.5, 30); syncCamera();
      }
      frame = requestAnimationFrame(keyboardFrame);
    }; const startKeyboard = () => {
      if(!frame && [...movementKeys].some(code => keys.has(code))) frame = requestAnimationFrame(keyboardFrame);
    }; const isTyping = target => target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]");
    const isStageActive = () => document.activeElement === stage || document.activeElement === canvas; const onKeyDown = event => {
      if(disposed || document.hidden || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || isTyping(event.target) || !isStageActive()) return;
      if(!keys.has(event.code)) {
        keys.add(event.code); for(const callback of keyListeners) callback({code:event.code, down:true, event});
        if(event.code === "KeyR" && readCamera()) { event.preventDefault(); resetCamera(); }
        if(movementKeys.has(event.code) && readCamera())startKeyboard();
      }
      if(movementKeys.has(event.code) && readCamera())event.preventDefault();
    }; const onKeyUp = event => {
      if(!keys.delete(event.code)) return; for(const callback of keyListeners) callback({code:event.code, down:false, event});
      if(movementKeys.has(event.code) && readCamera())event.preventDefault();
    }; const stopDrag = () => {
      if(pointerId === null) return; const id = pointerId; pointerId = null; canvas.classList.remove("is-dragging");
      if(canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    }; const onPointerDown = event => {
      if(disposed || event.button !== 0 || pointerId !== null) return; stage.focus({preventScroll:true});
      readCamera(); pointerId = event.pointerId; lastX = event.clientX; lastY = event.clientY;
      canvas.setPointerCapture(pointerId); canvas.classList.add("is-dragging"); event.preventDefault();
    }; const onPointerMove = event => {
      if(event.pointerId !== pointerId) return;
      const dx = event.clientX - lastX, dy = event.clientY - lastY; lastX = event.clientX; lastY = event.clientY; if(!dx && !dy) return;
      if(readCamera()){camera.yaw-=dx*0.005;camera.pitch=clamp(camera.pitch-dy*0.005,-1.4,1.4);syncCamera();}
      for(const callback of dragListeners) callback({dx, dy, yaw:camera.yaw, pitch:camera.pitch, event});
    }; const onWheel = event => {
      if(disposed || !readCamera())return;event.preventDefault();stage.focus({preventScroll:true});
      const amount = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
      camera.distance = clamp(camera.distance * Math.exp(clamp(amount, -1000, 1000) * 0.001), 1.5, 30); syncCamera();
    }; const onPointerEnd = event => { if(event.pointerId === pointerId) stopDrag(); };
    const onVisibilityChange = () => { if(document.hidden) { stopKeyboard(); stopDrag(); } };
    const onFocusOut = event => { if(event.relatedTarget !== stage && event.relatedTarget !== canvas) stopKeyboard(); };
    listen(canvas, "pointerdown", onPointerDown); listen(canvas, "pointermove", onPointerMove);
    listen(canvas, "pointerup", onPointerEnd); listen(canvas, "pointercancel", onPointerEnd);
    listen(canvas, "lostpointercapture", onPointerEnd); listen(canvas, "wheel", onWheel, {passive:false});
    listen(document, "keydown", onKeyDown); listen(document, "keyup", onKeyUp); listen(window, "blur", () => { stopKeyboard(); stopDrag(); });
    listen(document, "visibilitychange", onVisibilityChange); listen(stage, "focusout", onFocusOut); const dispose = () => {
      if(disposed) return; disposed = true; stopKeyboard(); stopDrag(); controller.abort(); keyListeners.clear(); dragListeners.clear();
      canvas.classList.remove("is-dragging"); canvas.style.touchAction = "";
    }; return {isDown, onKey, onDrag, getCamera, setCamera, resetCamera, dispose};
  }; return {mount};
})();
const settings=(()=>{
// localStorage 저장은 렌더러와 분리한다. WebGL 상태 대신 복원 가능한 설정만 직렬화한다.
// 브라우저 저장소가 제한될 수 있으므로 실패해도 렌더링을 중단하지 않는다.
  const KEY = "webgl.raymarch-template.settings.v1"; const mount = renderer => {
    const defaults = {
      fpsLimit:0, resolutionScale:1, maxPixels:0, debugHeatmap:false, raymarch:renderer.getRaymarchSettings()
    }; let available = true, migrationBlocked=false, errorMessage = "", savedText = null, disposed = false; const readState = () => {
      const stats = renderer.getStats(); return {
        version:1, rendering:{fpsLimit:stats.fpsLimit, resolutionScale:stats.resolutionScale, maxPixels:stats.maxPixels,
          debugHeatmap:stats.debugHeatmap},
        raymarch:renderer.getRaymarchSettings(),
        user:renderer.getUserUniforms().map(({name, type, value, options}) => ({name, type, value, options})),
        panelHidden:document.body.classList.contains("panel-hidden")
      };
    };
        const failStorage = error => { available = false; errorMessage = `브라우저 저장소 사용 불가: ${error.message}`; };
    const migrateCamera = data => {
      if(!data?.required || !Object.hasOwn(data.required,"uCameraOrbit") || !Array.isArray(data.user))return data;
      let user=data.user;
      if(!user.some(u=>u?.name==="uCameraOrbit")) {
        renderer.validateUniformValue("vec3",data.required.uCameraOrbit);
        if(user.length>=64)throw new Error("이전 카메라를 Custom으로 옮기려면 Uniform 슬롯이 하나 필요합니다.");
        user=[...user,{name:"uCameraOrbit",type:"vec3",value:data.required.uCameraOrbit,options:{}}];
      }
      return {...data,user,required:Object.fromEntries(Object.entries(data.required).filter(([name])=>name!=="uCameraOrbit"))};
    };
    const status = () => ({available:available&&!migrationBlocked,message:available&&!migrationBlocked?"렌더링·파라미터 설정 자동 저장":errorMessage}); const save = (force=false) => {
      if(force===true&&migrationBlocked){migrationBlocked=false;errorMessage="";}if(disposed || !available || migrationBlocked) return false; const text = JSON.stringify(readState()); if(text === savedText) return true;
      try { window.localStorage.setItem(KEY, text); savedText = text; return true; } catch(error) { failStorage(error); return false; }
    }; const load = () => {
      let raw; try { raw = window.localStorage.getItem(KEY); } catch(error) { failStorage(error); return false; }
      if(!raw) { savedText = JSON.stringify(readState()); return false; }
      let data; try { data = JSON.parse(raw); } catch(error) { errorMessage = "기존 설정 형식이 올바르지 않아 기본값으로 시작함"; return false; }
      if(!data || data.version !== 1) { errorMessage = "지원하지 않는 저장 형식이므로 기본값으로 시작함"; return false; }
      try {data=migrateCamera(data);}catch(error){migrationBlocked=true;errorMessage=`설정 복원 중단: ${error.message} · 원본 설정 보존`;return false;}
      // 저장값은 외부 입력이다. 항목마다 검증해서 잘못된 값은 건너뛴다.
      const rendering = data.rendering || {}; for(const [key, setter] of [["fpsLimit", "setFpsLimit"], ["resolutionScale", "setResolutionScale"],
      ["maxPixels", "setMaxPixels"], ["debugHeatmap", "setDebugHeatmap"]]) {
        if(Object.prototype.hasOwnProperty.call(rendering, key)) {
                    try { renderer[setter](rendering[key]); } catch(error) { console.warn(`저장된 ${key} 무시:`, error.message); }
        }
      }
      // 구버전 저장 데이터에는 raymarch가 없어도 기본값을 사용한다.
      if(data.raymarch && typeof data.raymarch === "object") for(const key of ["maxSteps", "maxDistance", "surfaceEpsilon", "normalEpsilon"]) {
        if(Object.prototype.hasOwnProperty.call(data.raymarch, key)) {
          try { renderer.setRaymarchSettings({[key]:data.raymarch[key]}); }
                    catch(error) { console.warn(`저장된 ${key} 무시:`, error.message); }
        }
      }
      if(Array.isArray(data.user) && (data.user.length || renderer.getUserUniforms().length)) {
        const users=data.user.slice(0,64);
        try {renderer.setUserUniforms(users);}catch(error) {
          for(const item of users) {if(!item || typeof item!=="object")continue;
            try {renderer.defineUniform(item.name,item.type,item.value,item.options||{});}
            catch(error){console.warn(`저장된 사용자 Uniform 무시 (${item.name}):`,error.message);}
          }
        }
      }
      // 좁은 화면에서 패널은 뷰포트를 덮는 서랍이므로, 저장 상태와 관계없이 닫힌 채로 시작한다.
      const overlayPanel = globalThis.matchMedia?.("(max-width:820px)").matches === true;
      document.body.classList.toggle("panel-hidden", data.panelHidden === true || overlayPanel);
      savedText = null; // 유효하지 않은 항목을 제외한 안전한 스냅샷으로 갱신한다.
      save(); return true;
    }; // Pack에 포함되는 설정은 저장소 포맷을 그대로 사용하되, 적용 전에 전체 검증한다.
    const validatePack = data => {
      if(!data || data.version!==1 || !data.rendering || !data.raymarch || !Array.isArray(data.user) || typeof data.panelHidden!=="boolean")
        throw new Error("Pack 설정 형식이 올바르지 않습니다.");
      data=migrateCamera(data);
      const limits={fpsLimit:[0,240,1],resolutionScale:[.25,1],maxPixels:[0,Number.MAX_SAFE_INTEGER,1],
        maxSteps:[1,512,1],maxDistance:[.01,10000],surfaceEpsilon:[.000001,.1],normalEpsilon:[.000001,.1]};
      for(const [name,range] of Object.entries(limits)) {
        const value=(["fpsLimit","resolutionScale","maxPixels"].includes(name)?data.rendering:data.raymarch)[name];
        if(typeof value!=="number" || !Number.isFinite(value) || value<range[0] || value>range[1] || (range[2] && !Number.isInteger(value)))
          throw new Error(`Pack 설정 범위 오류: ${name}`);
      }
      if(Object.keys(data.raymarch).some(key=>!["maxSteps","maxDistance","surfaceEpsilon","normalEpsilon"].includes(key)))
        throw new Error("Pack Ray Marching 설정 키 오류");
      if(typeof data.rendering.debugHeatmap!=="boolean")throw new Error("Pack 히트맵 설정 오류");
      return data;
    }; const applyPack = data => {
      data=validatePack(data);const s=data.rendering;
      renderer.setFpsLimit(s.fpsLimit);renderer.setResolutionScale(s.resolutionScale);
      renderer.setMaxPixels(s.maxPixels);renderer.setDebugHeatmap(s.debugHeatmap);
      renderer.setRaymarchSettings(data.raymarch);
      document.body.classList.toggle("panel-hidden",data.panelHidden);document.dispatchEvent(new Event("shader-settings-applied"));save();
    }; const reset = () => {
      if(available&&!migrationBlocked)errorMessage="";
      renderer.setFpsLimit(defaults.fpsLimit); renderer.setResolutionScale(defaults.resolutionScale);
      renderer.setMaxPixels(defaults.maxPixels); renderer.setDebugHeatmap(defaults.debugHeatmap);
      renderer.setRaymarchSettings(defaults.raymarch);
      document.body.classList.remove("panel-hidden");savedText=null;save();
    };
    // 외부 JS에서 renderer.setUniform()을 호출한 경우도 별도 구독 없이 저장한다.
    // 매 프레임 저장하지 않고 700ms마다 바뀐 스냅샷만 기록한다.
    const timer = setInterval(save, 700); const onPageHide = () => save(); window.addEventListener("pagehide", onPageHide);
    const dispose = () => {
      if(disposed) return; save(); disposed = true; clearInterval(timer); window.removeEventListener("pagehide", onPageHide);
    }; return {load, save, reset, status, dispose, snapshot:readState, validatePack, applyPack};
  }; return {mount};
})();
const profiler=(()=>{
// 성능·디버그 패널. Renderer 공개 API만 읽으며 GPU 리소스를 소유하지 않는다.
// 패널이 화면에 보일 때만 샘플링·그리기를 하여 셰이더 성능 측정 자체를 방해하지 않는다.
  const HISTORY = 180, SAMPLE_MS = 100;
  const mount = renderer => {
    const $ = id => document.getElementById(id), controller = new AbortController(), signal = controller.signal;
    const element = (tag, className = "", text = "") => { const node = document.createElement(tag); if(className) node.className = className; if(text) node.textContent = text; return node; };
    const series = {frame:new Float32Array(HISTORY), gpu:new Float32Array(HISTORY), cpu:new Float32Array(HISTORY)};
    let head = 0, count = 0, ticks = 0, lastSignature = "", infoRendered = false, disposed = false;
    const visible = () => !$("view-profile").hidden && !document.body.classList.contains("panel-hidden") && !document.hidden;
    const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "—";
    const sample = stats => {
      if(!stats.running) return; // 일시정지 중에는 타임라인을 멈춘다.
      series.frame[head] = stats.frameMs; series.gpu[head] = stats.gpu?.totalMs ?? NaN; series.cpu[head] = stats.cpuMs;
      head = (head + 1) % HISTORY; count = Math.min(count + 1, HISTORY);
    };
    // 프레임 타임라인: 16.7ms(60 FPS)·33.3ms(30 FPS) 기준선과 Frame/GPU/CPU 세 계열.
    const drawChart = () => {
      const canvas = $("profileChart"), dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr)), height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if(canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext("2d"); if(!ctx) return;
      const css = getComputedStyle(document.documentElement), color = name => css.getPropertyValue(name).trim();
      ctx.clearRect(0, 0, width, height);
      let peak = 20; for(let i = 0; i < count; i++) for(const key of ["frame","gpu","cpu"]) { const v = series[key][(head - 1 - i + HISTORY) % HISTORY]; if(Number.isFinite(v)) peak = Math.max(peak, v); }
      // 탭 복귀 직후 같은 일시적 스파이크가 축을 망치지 않도록 상한은 100ms로 자른다.
      const max = Math.min(Math.max(peak * 1.15, 20), 100), y = ms => height - (ms / max) * (height - 6 * dpr) - 2 * dpr, step = width / (HISTORY - 1);
      ctx.font = `${10 * dpr}px ${color("--mono") || "monospace"}`; ctx.textBaseline = "bottom";
      for(const [ms, label] of [[16.67, "60fps"], [33.33, "30fps"]]) if(ms < max) {
        ctx.strokeStyle = color("--line-strong"); ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.lineWidth = dpr;
        ctx.beginPath(); ctx.moveTo(0, y(ms)); ctx.lineTo(width, y(ms)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = color("--faint"); ctx.fillText(label, 4 * dpr, y(ms) - 2 * dpr);
      }
      const plot = (data, stroke, fill) => {
        ctx.beginPath(); let started = false, firstX = 0, lastX = 0;
        for(let i = 0; i < count; i++) {
          const v = data[(head - count + i + HISTORY) % HISTORY]; if(!Number.isFinite(v)) continue;
          const x = width - (count - 1 - i) * step; if(!started) { ctx.moveTo(x, y(v)); firstX = x; started = true; } else ctx.lineTo(x, y(v)); lastX = x;
        }
        if(!started) return; ctx.strokeStyle = stroke; ctx.lineWidth = 1.5 * dpr; ctx.lineJoin = "round"; ctx.stroke();
        if(fill) { ctx.lineTo(lastX, height); ctx.lineTo(firstX, height); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
      };
      plot(series.frame, "#ffffff59"); plot(series.cpu, "#6fe0e6"); plot(series.gpu, color("--accent"), "#8f86ff26");
      ctx.fillStyle = color("--faint"); ctx.textAlign = "right"; ctx.textBaseline = "top"; ctx.fillText(`${Math.round(max)}ms`, width - 4 * dpr, 2 * dpr); ctx.textAlign = "left";
    };
    const renderKpis = stats => {
      const items = [["FPS", fmt(stats.fps, 1), ""], ["FRAME", fmt(stats.frameMs), "ms"], ["GPU", stats.gpu?.available ? fmt(stats.gpu.totalMs ?? NaN) : "N/A", stats.gpu?.available ? "ms" : ""],
        ["CPU", fmt(stats.cpuMs), "ms"], ["VRAM", fmt(stats.bufferMemoryBytes / 1048576, 1), "MiB"]];
      const holder = $("profileKpis"); if(holder.children.length !== items.length) holder.replaceChildren(...items.map(() => { const tile = element("div","profile-kpi"); tile.append(element("span"), element("strong")); return tile; }));
      items.forEach(([label, value, unit], i) => { const tile = holder.children[i]; tile.children[0].textContent = label; tile.children[1].textContent = value; tile.children[1].dataset.unit = unit; tile.dataset.kind = label.toLowerCase(); });
    };
    // 패스별 GPU 시간 막대. 실행 순서(Buffer → Image)를 유지하고 총합 대비 비율을 표시한다.
    const renderPasses = stats => {
      const holder = $("profilePasses"), gpu = stats.gpu;
      if(!gpu?.available) { holder.replaceChildren(element("p","help","이 브라우저/GPU는 EXT_disjoint_timer_query_webgl2를 제공하지 않아 패스별 GPU 시간을 측정할 수 없습니다. 위 FRAME·CPU 지표로 비교하세요.")); return; }
      if(!gpu.enabled) { holder.replaceChildren(element("p","help","GPU 타이머가 꺼져 있습니다.")); return; }
      const order = [...renderer.getPasses().map(p => p.name), "Image", "Preview"], rows = [...gpu.passes].sort((a,b) => order.indexOf(a.label) - order.indexOf(b.label));
      if(!rows.length) { holder.replaceChildren(element("p","help","측정 대기 중… 재생 중일 때 수집됩니다.")); return; }
      const total = rows.reduce((sum, row) => sum + row.ms, 0) || 1;
      holder.replaceChildren(...rows.map(row => {
        const line = element("div","profile-pass"), bar = element("span","profile-bar"), share = row.ms / total;
        bar.style.setProperty("--share", `${Math.max(2, share * 100)}%`); bar.dataset.heavy = String(row.ms > 8);
        line.append(element("span","profile-pass-name", row.label === "Image" || row.label === "Preview" ? row.label : `Buffer ${row.label}`), bar,
          element("span","profile-pass-ms", `${fmt(row.ms)}ms · ${Math.round(share * 100)}%`));
        return line;
      }));
    };
    // 기본값(0/단위행렬/false)으로 선언된 미등록 Uniform을 파라미터로 승격한다.
    const types = new Map((renderer.getUniformTypes?.() || []).map(item => [item.type, item]));
    const initialValue = type => {
      const spec = types.get(type); if(!spec) return null; const n = spec.components;
      if(spec.kind === "m") { const dim = Math.round(Math.sqrt(n)); return Array.from({length:n}, (_, i) => i % (dim + 1) === 0 ? 1 : 0); }
      if(spec.kind === "b") return n === 1 ? false : Array(n).fill(false);
      return n === 1 ? 0 : Array(n).fill(0);
    };
    const promote = (name, type) => {
      const status = $("profileUniformStatus");
      try { renderer.defineUniform(name, type, initialValue(type), {}); document.dispatchEvent(new Event("shader-settings-applied")); status.textContent = `${name} (${type})를 파라미터로 등록했습니다. 파라미터 탭에서 값을 조절하세요.`; status.dataset.state = "ok"; }
      catch(error) { status.textContent = `${name}: ${error.message}`; status.dataset.state = "error"; }
      lastSignature = ""; renderUniforms();
    };
    const renderUniforms = () => {
      const reflection = renderer.getShaderReflection?.(); if(!reflection) return;
      const programs = [["Image", reflection.image], ...reflection.passes.map(p => [`Buffer ${p.name}`, p])];
      const signature = JSON.stringify(programs); if(signature === lastSignature) return; lastSignature = signature;
      const holder = $("profileUniforms"), groups = []; let total = 0;
      for(const [label, report] of programs) {
        if(!report) continue; const group = element("div","profile-program"), head = element("div","profile-program-head");
        head.append(element("strong","",label), element("span","", report.uniforms ? `${report.uniforms.length} active` : "리플렉션 불가")); group.append(head);
        for(const item of report.ignored || []) {
          const row = element("div","profile-uniform"); row.dataset.source = "ignored";
          row.append(element("code","",item.name), element("span","profile-uniform-type",item.declared), element("span","profile-uniform-note",`무시됨 · 허용: ${item.expected}`)); group.append(row);
        }
        for(const item of report.uniforms || []) {
          total++; const row = element("div","profile-uniform"); row.dataset.source = item.source || "builtin";
          const note = item.source === "user" ? "파라미터" : item.source === "unregistered" ? "미등록 · 값 0" : "내장";
          row.append(element("code","",item.size > 1 ? `${item.name}[${item.size}]` : item.name), element("span","profile-uniform-type",item.type), element("span","profile-uniform-note",note));
          if(item.source === "unregistered" && item.size === 1 && types.has(item.type)) {
            const button = element("button","profile-promote","등록"); button.type = "button"; button.title = `${item.name}을 파라미터 패널에서 조절할 수 있게 등록`;
            button.addEventListener("click", () => promote(item.name, item.type)); row.append(button);
          }
          group.append(row);
        }
        groups.push(group);
      }
      $("profileUniformCount").textContent = String(total); holder.replaceChildren(...groups);
    };
    // 버퍼 뷰어: 출력별 썸네일 캔버스는 키(이름:출력)로 재사용해 매번 DOM을 다시 만들지 않는다.
    const thumbs = new Map();
    const renderBuffers = stats => {
      const holder = $("profileBuffers"), shots = renderer.captureBufferThumbnails?.(152) || [], seen = new Set();
      if(!shots.length) { thumbs.clear(); holder.replaceChildren(element("p","help","버퍼 패스가 없거나 아직 렌더링되지 않았습니다. 편집기의 + Buffer로 추가하세요.")); return; }
      if(holder.querySelector("p")) holder.replaceChildren();
      for(const shot of shots) {
        const key = `${shot.name}:${shot.attachment}`; seen.add(key); let entry = thumbs.get(key);
        if(!entry) {
          const button = element("button","profile-buffer"), canvas = element("canvas"), caption = element("span","profile-buffer-caption");
          button.type = "button"; button.append(canvas, caption); holder.append(button);
          button.addEventListener("click", () => {
            const current = renderer.getStats(); const active = current.previewPass === shot.name && current.previewAttachment === shot.attachment;
            try { renderer.setPreviewPass(active ? null : shot.name, active ? 0 : shot.attachment); } catch(error) { $("profilePixel").textContent = error.message; }
            lastBufferRender = 0;
          });
          entry = {button, canvas, caption}; thumbs.set(key, entry);
        }
        if(entry.canvas.width !== shot.width || entry.canvas.height !== shot.height) { entry.canvas.width = shot.width; entry.canvas.height = shot.height; }
        entry.canvas.getContext("2d")?.putImageData(shot.image, 0, 0);
        const outputs = renderer.getPasses().find(p => p.name === shot.name)?.outputs || 1;
        entry.caption.textContent = `${shot.name}${outputs > 1 ? `[${shot.attachment}]` : ""} · ${shot.sourceWidth}×${shot.sourceHeight} · ${shot.format}`;
        const active = stats.previewPass === shot.name && stats.previewAttachment === shot.attachment;
        entry.button.classList.toggle("is-active", active); entry.button.setAttribute("aria-pressed", String(active));
        entry.button.title = active ? "Image 보기로 돌아가기" : `${shot.name} 출력 ${shot.attachment}을 뷰포트에 표시`;
      }
      for(const [key, entry] of thumbs) if(!seen.has(key)) { entry.button.remove(); thumbs.delete(key); }
    };
    let lastBufferRender = 0;
    // 미리보기 중인 버퍼의 실제 값(float 버퍼는 HDR·음수 포함)을 포인터 위치에서 읽는다. 80ms마다 한 번으로 제한.
    let lastPixelRead = 0;
    const readHover = event => {
      if(!visible() || event.timeStamp - lastPixelRead < 80) return; lastPixelRead = event.timeStamp;
      const stats = renderer.getStats(), name = stats.previewPass, output = $("profilePixel");
      if(!name) { output.textContent = "버퍼를 선택하면 포인터 위치의 실제 값을 읽습니다. (현재 Image 표시 중)"; return; }
      const pass = renderer.getPasses().find(p => p.name === name); if(!pass?.width) return;
      const rect = $("screen").getBoundingClientRect(); if(!rect.width || !rect.height) return;
      const x = Math.max(0, Math.min(pass.width - 1, Math.floor((event.clientX - rect.left) / rect.width * pass.width)));
      const y = Math.max(0, Math.min(pass.height - 1, Math.floor((rect.bottom - event.clientY) / rect.height * pass.height)));
      try { const values = renderer.readPassPixel(name, x, y, stats.previewAttachment);
        output.textContent = `${name}${pass.outputs > 1 ? `[${stats.previewAttachment}]` : ""} (${x}, ${y}) · ${pass.format.toUpperCase()}\n${["R","G","B","A"].map((c,i) => `${c} ${Number(values[i]).toPrecision(5)}`).join("   ")}`;
      } catch(error) { output.textContent = error.message; }
    };
    const renderInfo = () => {
      const caps = renderer.getCapabilities?.(); if(!caps) return; infoRendered = true;
      const rows = [["GPU", caps.renderer], ["Vendor", caps.vendor], ["WebGL", caps.version], ["GLSL", caps.glsl],
        ["Max texture", `${caps.maxTextureSize}px`], ["Texture units", String(caps.maxTextureUnits)], ["Draw buffers", String(caps.maxDrawBuffers)],
        ["Frag uniforms", `${caps.maxFragmentUniformVectors} vec4`]];
      const list = $("profileGpu"), nodes = [];
      for(const [key, value] of rows) nodes.push(element("dt","",key), element("dd","",String(value)));
      const exts = element("dd","profile-extensions");
      for(const [name, ok] of Object.entries(caps.extensions)) { const chip = element("span","profile-ext",name.replace(/^(EXT|OES|KHR|WEBGL)_/,"")); chip.dataset.ok = String(ok); chip.title = `${name}: ${ok ? "지원" : "미지원"}`; exts.append(chip); }
      nodes.push(element("dt","","Extensions"), exts); list.replaceChildren(...nodes);
    };
    const tick = () => {
      if(disposed) return; const stats = renderer.getStats(); sample(stats);
      if(!visible()) return; ticks++; drawChart(); renderKpis(stats);
      if(ticks % 5 === 1) { renderPasses(stats); renderUniforms(); if(!infoRendered) renderInfo(); }
      // 썸네일은 GPU→CPU 읽기라 약 0.3초 간격, 클릭 직후에는 즉시 갱신한다.
      if(performance.now() - lastBufferRender > 300) { lastBufferRender = performance.now(); renderBuffers(stats); }
      $("profileGpuTiming").disabled = !stats.gpu?.available; $("profileGpuTiming").checked = !!stats.gpu?.enabled;
    };
    $("profileGpuTiming").addEventListener("change", event => { try { renderer.setGpuTiming(event.target.checked); } catch(error) { event.target.checked = !event.target.checked; } }, {signal});
    for(const button of $("profileChannel").querySelectorAll("button")) button.addEventListener("click", () => {
      renderer.setPreviewOptions({channel:Number(button.dataset.channel)});
      for(const other of $("profileChannel").querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === button));
      lastBufferRender = 0;
    }, {signal});
    $("profileExposure").addEventListener("input", event => {
      const exposure = 2 ** Number(event.target.value); renderer.setPreviewOptions({exposure});
      // 반 단계(√2 배수)는 무리수이므로 유효 숫자 3자리로 줄여 표시한다. 정확한 값은 툴팁으로 제공.
      const short = value => value >= 10 ? String(Math.round(value)) : String(Number(value.toPrecision(3)));
      $("profileExposureLabel").textContent = exposure >= 1 ? `×${short(exposure)}` : `×1/${short(1 / exposure)}`;
      $("profileExposureLabel").title = `${Number(event.target.value) >= 0 ? "+" : ""}${event.target.value} EV · ×${exposure}`; lastBufferRender = 0;
    }, {signal});
    $("screen").addEventListener("pointermove", readHover, {signal});
    $("profileReset").addEventListener("click", () => { for(const data of Object.values(series)) data.fill(0); head = count = 0; drawChart(); }, {signal});
    // 탭을 연 직후 바로 최신 상태를 보여준다.
    for(const button of document.querySelectorAll('#panelTabs [data-tab="profile"]')) button.addEventListener("click", () => { lastSignature = ""; setTimeout(tick, 0); }, {signal});
    const timer = setInterval(tick, SAMPLE_MS);
    return {refresh:() => { lastSignature = ""; tick(); }, dispose:() => { disposed = true; clearInterval(timer); controller.abort(); }};
  }; return {mount};
})();
const gallery=((Annotations)=>{
// 예제 갤러리와 첫 실행 안내. 썸네일은 별도의 작은 WebGL2 컨텍스트에서 한 번만 그리고 즉시 해제한다.
// 예제 적용은 Studio API(loadExample/example*)만 사용하므로 Undo·미적용 변경 확인이 그대로 동작한다.

  const ONBOARD_KEY = "field.onboarded.v1";
  const head = params => `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
${params}out vec4 fragColor;
`;
  const aurora = head("uniform float uSpeed;\nuniform float uWarp;\nuniform vec3 uTint;\n") + `
// Domain warping: fbm으로 좌표를 두 번 비틀어 오로라 같은 흐름을 만든다.
// sin 기반 해시는 좌표가 커지면 정밀도가 무너져 격자 모양 이음매가 생기므로 sin 없는 해시를 쓴다.
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return v;
}
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    float t = uTime * uSpeed;
    vec2 q = vec2(fbm(uv * 2.0 + t * 0.1), fbm(uv * 2.0 + vec2(5.2, 1.3) - t * 0.08));
    vec2 r = vec2(fbm(uv * 2.0 + uWarp * q + vec2(1.7, 9.2) + t * 0.15), fbm(uv * 2.0 + uWarp * q + vec2(8.3, 2.8)));
    float f = fbm(uv * 2.0 + uWarp * r);
    vec3 col = mix(vec3(0.02, 0.03, 0.08), uTint, smoothstep(0.2, 0.9, f));
    col = mix(col, vec3(0.95, 0.4, 0.8), smoothstep(0.6, 1.2, length(q) * f));
    col += 0.25 * vec3(0.4, 0.9, 1.0) * pow(r.y, 4.0);
    fragColor = vec4(pow(col, vec3(0.9)), 1.0);
}`;
  const kaleido = head("uniform float uSegments;\nuniform float uZoom;\n") + `
// 극좌표를 uSegments 조각으로 접어 만든 만화경. 마우스를 움직이면 중심이 따라간다.
vec3 palette(float t) { return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    if (uMouse.x >= 0.0) uv -= 0.25 * (uMouse - 0.5 * uResolution) / uResolution.y;
    float a = atan(uv.y, uv.x), r = length(uv);
    float seg = 6.28318 / max(uSegments, 1.0);
    a = abs(mod(a, seg) - 0.5 * seg);
    vec2 p = r * vec2(cos(a), sin(a)) * uZoom;
    vec3 col = vec3(0.0);
    for (float i = 0.0; i < 4.0; i++) {
        p = fract(p * 1.5 + 0.1 * uTime) - 0.5;
        float d = length(p) * exp(-r);
        d = abs(sin(d * 8.0 + uTime) / 8.0);
        col += palette(r + i * 0.4 + uTime * 0.2) * pow(0.012 / d, 1.2);
    }
    fragColor = vec4(col * smoothstep(1.4, 0.2, r), 1.0);
}`;
  const lava = head("uniform float uSoftness;\nuniform vec3 uHot;\nuniform vec3 uCool;\n") + `
// 2D 메타볼: 원 거리장을 smooth-min으로 합쳐 서로 녹아 붙는 덩어리를 만든다.
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    float d = 1e3;
    for (int i = 0; i < 7; i++) {
        float fi = float(i);
        vec2 c = 0.55 * vec2(sin(uTime * (0.31 + 0.07 * fi) + fi * 1.7), cos(uTime * (0.23 + 0.05 * fi) + fi * 2.3));
        d = smin(d, length(uv - c) - (0.12 + 0.04 * sin(fi + uTime)), uSoftness);
    }
    if (uMouse.x >= 0.0) d = smin(d, length(uv - (uMouse - 0.5 * uResolution) / uResolution.y) - 0.1, uSoftness);
    float edge = smoothstep(0.01, -0.01, d);
    float glow = exp(-12.0 * max(d, 0.0));
    vec3 col = mix(vec3(0.03, 0.02, 0.05), uCool, glow * 0.6);
    col = mix(col, mix(uHot, vec3(1.0, 0.95, 0.8), smoothstep(0.0, -0.15, d)), edge);
    fragColor = vec4(col, 1.0);
}`;
  const horizon = head("uniform float uGridSpeed;\nuniform vec3 uGlow;\n") + `
// 원근 격자와 줄무늬 태양: 화면 아래 절반을 바닥 평면으로 투영한다.
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    vec3 sky = mix(vec3(0.05, 0.02, 0.12), vec3(0.6, 0.1, 0.45), smoothstep(-0.1, 0.5, -uv.y + 0.3));
    vec3 col = sky;
    vec2 sp = uv - vec2(0.0, 0.12);
    float sun = smoothstep(0.30, 0.29, length(sp));
    float stripes = step(0.0, sin(sp.y * 60.0 - uTime * 2.0)) + step(0.05, sp.y);
    col = mix(col, mix(vec3(1.0, 0.25, 0.5), vec3(1.0, 0.85, 0.3), smoothstep(-0.3, 0.3, sp.y)), sun * min(stripes, 1.0));
    if (uv.y < -0.05) {
        float z = 0.35 / (-uv.y - 0.03);
        vec2 g = vec2(uv.x * z, z + uTime * uGridSpeed);
        vec2 w = fwidth(g);
        vec2 d = 0.5 - abs(fract(g) - 0.5); // 가장 가까운 격자선까지의 거리
        vec2 line = 1.0 - smoothstep(vec2(0.0), w * 1.5, d);
        float grid = max(line.x, line.y) * exp(-0.06 * z);
        col = mix(vec3(0.02, 0.0, 0.05), uGlow, grid) + uGlow * 0.15 * exp(-8.0 * (-uv.y - 0.05));
    }
    col += uGlow * 0.4 * exp(-60.0 * abs(uv.y + 0.05));
    fragColor = vec4(col, 1.0);
}`;
  const truchet = head("uniform float uScale;\nuniform vec3 uInk;\n") + `
// Truchet 타일: 셀마다 무작위로 회전한 사분원 두 개가 끊김 없는 미로를 만든다.
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y * uScale + vec2(uTime * 0.25, 0.0);
    vec2 id = floor(uv), f = fract(uv) - 0.5;
    if (hash(id) > 0.5) f.x = -f.x;
    vec2 c = f - sign(f.x + f.y + 1e-4) * 0.5;
    float d = abs(length(c) - 0.5);
    float w = 0.09 + 0.04 * sin(uTime + hash(id) * 6.28);
    float px = uScale / uResolution.y;
    float line = smoothstep(w + px, w - px, d);
    float shade = 0.5 + 0.5 * sin(atan(c.y, c.x) * 2.0 + uTime * 3.0);
    vec3 col = mix(vec3(0.95, 0.93, 0.88), uInk * (0.6 + 0.4 * shade), line);
    fragColor = vec4(col * (1.0 - 0.25 * length((gl_FragCoord.xy / uResolution) - 0.5)), 1.0);
}`;
  const p = (name, type, value, options = {}) => ({name, type, value, options});
  const ART = [
    {id:"aurora", title:"Aurora Flow", tag:"Noise · Domain warp", description:"fbm으로 좌표를 두 번 비트는 도메인 워핑. 흐르는 오로라.", image:aurora,
      users:[p("uSpeed","float",0.6,{min:0,max:3,step:0.01}), p("uWarp","float",4,{min:0,max:10,step:0.1}), p("uTint","vec3",[0.2,0.75,0.9])]},
    {id:"kaleido", title:"Kaleido Bloom", tag:"Polar · Pattern", description:"극좌표 접기로 만든 만화경. 마우스로 중심을 옮겨 보세요.", image:kaleido,
      users:[p("uSegments","float",8,{min:1,max:24,step:1}), p("uZoom","float",1.2,{min:0.2,max:4,step:0.01})]},
    {id:"lava", title:"Metaball Lava", tag:"SDF · 2D", description:"smooth-min으로 녹아 붙는 메타볼. 커서도 덩어리가 됩니다.", image:lava,
      users:[p("uSoftness","float",0.18,{min:0.01,max:0.6,step:0.01}), p("uHot","vec3",[1,0.35,0.1]), p("uCool","vec3",[0.5,0.1,0.6])]},
    {id:"horizon", title:"Neon Horizon", tag:"Projection · Grid", description:"화면 하단을 바닥 평면으로 투영한 원근 격자와 줄무늬 태양.", image:horizon,
      users:[p("uGridSpeed","float",1.5,{min:0,max:6,step:0.01}), p("uGlow","vec3",[0.2,0.9,1])]},
    {id:"truchet", title:"Truchet Weave", tag:"Tiling · Hash", description:"셀마다 무작위로 뒤집힌 사분원이 끝없는 미로를 엮습니다.", image:truchet,
      users:[p("uScale","float",6,{min:2,max:20,step:0.1}), p("uInk","vec3",[0.15,0.2,0.55])]}
  ];
  // ---- 기법 배우기: 기능 하나씩을 보여주는 작은 프로젝트. 주석이 곧 설명서다. ----
  const annotated = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
// 아래 주석의 @태그가 파라미터 패널의 슬라이더·색상 선택기를 자동으로 만든다.
uniform float uRadius;   // @range 0.05 0.6 @step 0.005 @default 0.28
uniform float uSoftness; // @range 0.001 0.2 @step 0.001 @default 0.02
uniform int   uCount;    // @min 1 @max 12 @default 6
uniform vec2  uCenter;   // @range -1 1 @default 0
uniform vec3  uColor;    // @color @default 1.0 0.45 0.2
uniform vec3  uBack;     // @color @default 0.05 0.04 0.09
out vec4 fragColor;
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y - uCenter * 0.5;
    float d = 1e3;
    for (int i = 0; i < 12; i++) {
        if (i >= uCount) break;
        float a = 6.28318 * float(i) / float(uCount) + uTime * 0.4;
        d = min(d, length(uv - 0.45 * vec2(cos(a), sin(a))) - uRadius * 0.4);
    }
    d = min(d, length(uv) - uRadius);
    float shape = 1.0 - smoothstep(-uSoftness, uSoftness, d);
    fragColor = vec4(mix(uBack, uColor, shape), 1.0);
}`;
  const mrtSource = `#version 300 es
precision highp float;
// Buffer A · Out = 2 (MRT). 한 번의 실행으로 두 출력에 서로 다른 데이터를 쓴다.
uniform vec2 uResolution;
uniform float uTime;
layout(location = 0) out vec4 outColor;  // 출력 0: 보이는 색
layout(location = 1) out vec4 outField;  // 출력 1: 거리장 데이터(채널 선택에서 A[1])
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    float d = 1e3;
    for (int i = 0; i < 5; i++) {
        float t = uTime * 0.6 + float(i) * 1.26;
        d = min(d, length(uv - 0.5 * vec2(cos(t), sin(t * 1.3))) - 0.12);
    }
    outColor = vec4(0.5 + 0.5 * cos(6.28 * (uv.x + uTime * 0.1) + vec3(0, 2, 4)), 1.0) * step(d, 0.0);
    outField = vec4(d, d, d, 1.0);
}`;
  const mrtImage = `#version 300 es
precision highp float;
// Image: iChannel0 = A[0] (색), iChannel1 = A[1] (거리장). 왼쪽은 색, 오른쪽은 거리장을 등고선으로 표시.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    if (uv.x < 0.5) { fragColor = texture(iChannel0, uv); return; }
    float d = texture(iChannel1, uv).r;
    vec3 col = d < 0.0 ? vec3(1.0, 0.55, 0.2) : vec3(0.25, 0.55, 1.0);
    col *= 0.6 + 0.4 * cos(120.0 * d);                  // 등고선
    col = mix(col, vec3(1.0), 1.0 - smoothstep(0.0, 0.006, abs(d)));
    fragColor = vec4(col, 1.0);
}`;
  const mipSource = `#version 300 es
precision highp float;
// Buffer A · Mip 켜짐. 선명한 패턴을 그리면 매 프레임 밉맵(축소 사본)이 자동 생성된다.
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    vec2 g = fract(uv * 6.0 + uTime * 0.2) - 0.5;
    float ring = abs(fract(length(uv) * 8.0 - uTime * 0.5) - 0.5);
    vec3 col = 0.5 + 0.5 * cos(6.28 * length(uv) + vec3(0, 2, 4) + uTime);
    fragColor = vec4(col * step(0.25, ring) * step(abs(g.x) + abs(g.y), 0.45), 1.0);
}`;
  const mipImage = `#version 300 es
precision highp float;
// Image: textureLod로 밉 레벨을 골라 읽는다. 위아래로 갈수록 높은 레벨 = 더 흐림 (틸트 시프트).
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform float uBlur;  // @range 0 8 @step 0.1 @default 5
uniform float uFocus; // @range 0 1 @step 0.01 @default 0.5
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float lod = uBlur * smoothstep(0.05, 0.45, abs(uv.y - uFocus));
    fragColor = textureLod(iChannel0, uv, lod);
}`;
  const reactionSource = `#version 300 es
precision highp float;
// Buffer A · 512×512 고정 · RGBA16F · Wrap Repeat · iChannel0 = A previous (자기 자신의 지난 프레임)
// Gray-Scott 반응-확산: r = 물질 U, g = 물질 V. 매 프레임 한 단계씩 시뮬레이션한다.
uniform vec2 uResolution;
uniform int uFrame;
uniform vec4 uMouse;          // 누르고 있는 동안 커서 주변에 V를 심는다
uniform sampler2D iChannel0;
uniform float uFeed;          // @range 0.01 0.09 @step 0.0005 @default 0.037
uniform float uKill;          // @range 0.04 0.07 @step 0.0005 @default 0.06
out vec4 fragColor;
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
    vec2 px = 1.0 / uResolution, uv = gl_FragCoord.xy * px;
    if (uFrame == 0) {   // 초기 상태: U=1, 무작위 점과 중앙 사각형에만 V
        float seed = step(0.997, hash(floor(gl_FragCoord.xy / 6.0))) + step(abs(uv.x - 0.5), 0.04) * step(abs(uv.y - 0.5), 0.04);
        fragColor = vec4(1.0, min(seed, 1.0), 0.0, 1.0);
        return;
    }
    vec2 c = texture(iChannel0, uv).rg;
    // 9점 라플라시안 (가중치 합 = 1)
    vec2 lap = -c
        + 0.2  * (texture(iChannel0, uv + vec2(px.x, 0)).rg + texture(iChannel0, uv - vec2(px.x, 0)).rg
                + texture(iChannel0, uv + vec2(0, px.y)).rg + texture(iChannel0, uv - vec2(0, px.y)).rg)
        + 0.05 * (texture(iChannel0, uv + px).rg + texture(iChannel0, uv - px).rg
                + texture(iChannel0, uv + vec2(px.x, -px.y)).rg + texture(iChannel0, uv + vec2(-px.x, px.y)).rg);
    float u = c.r, v = c.g, uvv = u * v * v;
    u += 1.0 * lap.r - uvv + uFeed * (1.0 - u);
    v += 0.5 * lap.g + uvv - (uKill + uFeed) * v;
    if (uMouse.z > 0.0 && length(gl_FragCoord.xy - uMouse.xy) < 10.0) v = 1.0;
    fragColor = vec4(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0), 0.0, 1.0);
}`;
  const reactionImage = `#version 300 es
precision highp float;
// Image: iChannel0 = A current. 시뮬레이션 값(V)을 색으로 바꿔 보여준다. 화면을 누르고 끌어 보세요.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform vec3 uLow;   // @color @default 0.03 0.02 0.08
uniform vec3 uHigh;  // @color @default 0.35 0.95 1.0
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float v = texture(iChannel0, uv).g;
    vec3 col = mix(uLow, uHigh, smoothstep(0.12, 0.4, v));
    col += vec3(1.0, 0.4, 0.8) * smoothstep(0.4, 0.6, v) * 0.5;
    fragColor = vec4(col, 1.0);
}`;
  // 기존 Studio 예제(멀티 패스·3D)는 Studio가 소유한 정의를 그대로 호출한다. project가 있는 항목은 갤러리가 직접 정의한다.
  // users 없이 열면 소스의 @어노테이션이 파라미터를 자동 등록한다(어노테이션 기능 자체를 보여주기 위함).
  const LESSONS = [
    {id:"annotations", title:"Annotated Parameters", tag:"@range · @color", description:"GLSL 주석만으로 슬라이더·색상 파라미터를 만드는 법.", image:annotated, thumb:"annotations",
      project:{image:annotated, passes:[], imageChannels:{}}},
    {id:"reaction", title:"Reaction–Diffusion", tag:"Fixed size · RGBA16F · Repeat", description:"고정 해상도 피드백 시뮬레이션. 화면을 눌러 끌면 패턴을 심습니다.", thumb:"reaction",
      project:{image:reactionImage, passes:[{name:"A", fragment:reactionSource, format:"rgba16f", scale:1, size:[512,512], wrap:"repeat", channels:{0:{buffer:"A", frame:"previous"}}}], imageChannels:{0:{buffer:"A", frame:"current"}}}},
    {id:"mrt", title:"MRT Outputs", tag:"Out = 2 · A[1]", description:"한 패스에서 색과 거리장을 동시에 쓰고 Image에서 따로 읽기.", thumb:"mrt",
      project:{image:mrtImage, passes:[{name:"A", fragment:mrtSource, format:"rgba16f", scale:1, outputs:2, channels:{}}], imageChannels:{0:{buffer:"A", frame:"current"}, 1:{buffer:"A", frame:"current", attachment:1}}}},
    {id:"mipblur", title:"Mipmap Blur", tag:"Mip · textureLod", description:"밉맵 레벨을 골라 읽는 저비용 블러(틸트 시프트).", thumb:"mipblur",
      project:{image:mipImage, passes:[{name:"A", fragment:mipSource, format:"rgba8", scale:1, mipmap:true, channels:{}}], imageChannels:{0:{buffer:"A", frame:"current"}}}},
    {id:"raymarch", title:"Ray Marching SDF", tag:"3D · Camera", description:"SDF 장면, Orbit 카메라, 스텝 히트맵 디버그.", action:"exampleRaymarch", thumb:"raymarch"},
    {id:"pipeline", title:"Buffer Pipeline", tag:"Multi-pass", description:"A → B 후처리 → Image. 버퍼 연결의 기본.", action:"examplePipeline", thumb:"pipeline"},
    {id:"feedback", title:"Feedback Trails", tag:"Multi-pass · previous", description:"이전 프레임을 읽어 잔상을 누적하는 피드백 루프.", action:"exampleFeedback", thumb:"feedback"}
  ];
  const mount = ({studio, Shader}) => {
    const $ = id => document.getElementById(id), controller = new AbortController(), signal = controller.signal;
    const dialog = $("gallery"), grid = $("galleryGrid"), lessons = $("galleryLessons");
    let thumbsDrawn = false;
    const element = (tag, className = "", text = "") => { const node = document.createElement(tag); if(className) node.className = className; if(text) node.textContent = text; return node; };
    const card = (item, onPick) => {
      const button = element("button","gallery-card"); button.type = "button"; button.dataset.id = item.id;
      const art = element("canvas","gallery-thumb"); art.width = 320; art.height = 200; art.dataset.thumb = item.thumb || item.id; art.setAttribute("aria-hidden","true");
      const meta = element("span","gallery-meta"); meta.append(element("span","gallery-tag",item.tag), element("strong","",item.title), element("span","gallery-desc",item.description));
      button.append(art, meta); button.addEventListener("click", () => onPick(item)); return button;
    };
    const finishOnboarding = () => { try { localStorage.setItem(ONBOARD_KEY, "1"); } catch (_) {} };
    const pick = async item => {
      if(dialog.open) dialog.close(); finishOnboarding();
      const project = item.project || {image:item.image, passes:[], imageChannels:{}};
      const ok = await (item.action ? studio[item.action]() : studio.loadExample(project, item.users || []));
      if(ok) studio.open();
      return ok;
    };
    // 가이드의 "예제 열기" 버튼용: id로 예제를 바로 연다.
    const loadLesson = id => { const item = [...ART, ...LESSONS].find(entry => entry.id === id); return item ? pick(item) : false; };
    grid.replaceChildren(...ART.map(item => card(item, pick)));
    lessons.replaceChildren(...LESSONS.map(item => card(item, pick)));
    // 썸네일 전용 임시 컨텍스트: 각 예제를 t=2.5초로 한 프레임 그린 뒤 카드 캔버스로 복사하고 컨텍스트를 해제한다.
    const drawThumbs = () => {
      if(thumbsDrawn) return; thumbsDrawn = true;
      const surface = document.createElement("canvas"); surface.width = 320; surface.height = 200;
      const gl = surface.getContext("webgl2", {preserveDrawingBuffer:true, antialias:false}); if(!gl) return;
      const compile = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn("썸네일 컴파일 실패", gl.getShaderInfoLog(s)); gl.deleteShader(s); return null; } return s; };
      const vs = compile(gl.VERTEX_SHADER, Shader.vertex), vao = gl.createVertexArray(); gl.bindVertexArray(vao); gl.viewport(0, 0, 320, 200);
      const render = (fragment, users) => {
        const fs = compile(gl.FRAGMENT_SHADER, fragment); if(!vs || !fs) return false;
        const program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program); gl.deleteShader(fs);
        if(!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return false; }
        gl.useProgram(program); const at = name => gl.getUniformLocation(program, name);
        gl.uniform2f(at("uResolution"), 320, 200); gl.uniform1f(at("uTime"), 2.5); gl.uniform2f(at("uMouse"), -1, -1);
        for(const {name, type, value} of users) {
          const loc = at(name); if(!loc) continue;
          if(type === "float") gl.uniform1f(loc, value); else if(type === "int" || type === "bool") gl.uniform1i(loc, Number(value));
          else if(type === "uint") gl.uniform1ui(loc, value);
          else if(type === "vec2") gl.uniform2fv(loc, value); else if(type === "vec3") gl.uniform3fv(loc, value); else if(type === "vec4") gl.uniform4fv(loc, value);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3); gl.deleteProgram(program); return true;
      };
      const copy = id => { for(const target of dialog.querySelectorAll(`canvas[data-thumb="${id}"]`)) target.getContext("2d")?.drawImage(surface, 0, 0); };
      for(const item of ART) if(render(item.image, item.users)) copy(item.id);
      // 단일 패스 레슨은 어노테이션 기본값으로 썸네일을 그린다(파라미터를 소스에서 읽음).
      for(const item of LESSONS) if(item.image) render(item.image, Annotations.collect([item.image])) && copy(item.thumb || item.id);
      const ray = Shader.rayUniforms.map(([name, type, value]) => ({name, type, value}));
      if(render(Shader.raymarch, ray)) copy("raymarch");
      if(vs) gl.deleteShader(vs); gl.deleteVertexArray(vao); gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    const open = (welcome = false) => {
      dialog.dataset.welcome = String(welcome); if(!dialog.open) dialog.showModal();
      requestAnimationFrame(drawThumbs); $("galleryClose").focus();
    };
    const close = () => { finishOnboarding(); dialog.close(); };
    $("galleryToggle").addEventListener("click", () => open(false), {signal});
    $("galleryClose").addEventListener("click", close, {signal}); $("galleryBlank").addEventListener("click", close, {signal});
    dialog.addEventListener("close", finishOnboarding, {signal});
    dialog.addEventListener("click", event => { if(event.target === dialog) close(); }, {signal});
    document.addEventListener("keydown", event => {
      if(event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) return;
      if(event.key.toLowerCase() === "x" && !document.querySelector("dialog[open]")) { event.preventDefault(); open(false); }
    }, {signal});
    // 처음 방문한 사용자에게만 환영 화면과 함께 갤러리를 연다.
    let first = false; try { first = !localStorage.getItem(ONBOARD_KEY); } catch (_) {}
    if(first) setTimeout(() => open(true), 400);
    return {open, close, loadLesson, dispose:() => controller.abort()};
  }; return {mount};
})(annotations);
const snippets=(()=>{
// GLSL 코드 조각 라이브러리. 순수 데이터 모듈(DOM·GPU 비의존)이며 가이드의 "코드 조각" 탭이 사용한다.
// 항목: {id, title, desc, code, requires?:[id…], scope?:"global"|"main"}
//  - scope "global"(기본): 함수·상수 정의 → 편집기가 main() 바깥(전역)에 넣는다.
//  - scope "main": main() 안에 쓰는 문장 → 커서 위치에 넣는다.
//  - requires: 먼저 필요한 다른 조각. 삽입 시 코드에 아직 없는 것만 함께 넣는다.
// 공식 출처: 해시는 Dave Hoskins "Hash without Sine"(MIT), 심플렉스 노이즈는 Ashima Arts/Stefan Gustavson(MIT),
// SDF·스무스 연산은 Inigo Quilez가 공개한 표준 공식을 따른다.
  const CATEGORIES = [
    {id:"hash", title:"해시 · 난수", desc:"좌표를 넣으면 0~1 의사난수를 돌려주는 함수. 노이즈·패턴·랜덤 배치의 기초입니다.", items:[
      {id:"hash11", title:"hash11", desc:"float → float 난수", code:`float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}`},
      {id:"hash21", title:"hash21", desc:"vec2 → float 난수 (셀·픽셀마다 하나의 값)", code:`float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}`},
      {id:"hash22", title:"hash22", desc:"vec2 → vec2 난수 (셀 안의 무작위 위치·방향)", code:`vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}`},
      {id:"hash13", title:"hash13", desc:"vec3 → float 난수 (3D 셀)", code:`float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}`},
      {id:"hash33", title:"hash33", desc:"vec3 → vec3 난수 (3D 무작위 벡터)", code:`vec3 hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
}`},
      {id:"hash31", title:"hash31", desc:"float → vec3 난수 (번호 하나로 색·위치 3개)", code:`vec3 hash31(float p) {
    vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}`},
      {id:"hash32", title:"hash32", desc:"vec2 → vec3 난수 (칸마다 무작위 색)", code:`vec3 hash32(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}`},
      {id:"pcg", title:"PCG 정수 해시", desc:"uint 기반 고품질 난수. 큰 좌표·누적 시뮬레이션에서도 패턴이 생기지 않음", code:`uint pcgHash(uint v) {
    uint state = v * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}
// 픽셀 좌표 + 시드 → 0~1 난수
float randPCG(uvec2 p, uint seed) {
    return float(pcgHash(p.x + pcgHash(p.y + pcgHash(seed)))) / 4294967295.0;
}`},
      {id:"frameRandom", title:"프레임마다 바뀌는 난수", desc:"픽셀·프레임별로 다른 값 (노이즈 디더·누적 렌더링). uFrame 필요", scope:"main", requires:["pcg"], code:`float rnd = randPCG(uvec2(gl_FragCoord.xy), uint(uFrame));`}]},
    {id:"noise", title:"노이즈 2D", desc:"부드럽게 변하는 무작위 값. 구름·지형·흐름·질감에 씁니다. 3D 버전은 '노이즈 3D' 범주에 있습니다.", items:[
      {id:"noise1D", title:"noise1D", desc:"1D 부드러운 노이즈, 0~1. 카메라 흔들림·깜빡임·값의 자연스러운 흔들림", requires:["hash11"], code:`float noise1D(float x) {
    float i = floor(x), f = fract(x);
    return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}`},
      {id:"valueNoise", title:"valueNoise (2D)", desc:"격자 값 보간 노이즈, 0~1", requires:["hash21"], code:`float valueNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
               mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}`},
      {id:"tileableNoise", title:"tileableNoise (반복 이음매 없음)", desc:"period 칸마다 정확히 반복되는 값 노이즈. 타일 텍스처·루프 애니메이션", requires:["hash21"], code:`float tileableNoise(vec2 p, vec2 period) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 i0 = mod(i, period), i1 = mod(i + 1.0, period);   // 격자 번호를 감싸면 가장자리가 이어진다
    return mix(mix(hash21(i0), hash21(vec2(i1.x, i0.y)), u.x),
               mix(hash21(vec2(i0.x, i1.y)), hash21(i1), u.x), u.y);
}`},
      {id:"gradientNoise", title:"gradientNoise (2D)", desc:"퍼린 계열 그래디언트 노이즈, 대략 -1~1. 값 노이즈보다 덜 각짐", requires:["hash22"], code:`float gradientNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic
    float n00 = dot(hash22(i) * 2.0 - 1.0, f);
    float n10 = dot(hash22(i + vec2(1, 0)) * 2.0 - 1.0, f - vec2(1, 0));
    float n01 = dot(hash22(i + vec2(0, 1)) * 2.0 - 1.0, f - vec2(0, 1));
    float n11 = dot(hash22(i + vec2(1, 1)) * 2.0 - 1.0, f - vec2(1, 1));
    return 1.4142 * mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}`},
      {id:"simplex", title:"simplexNoise (2D)", desc:"심플렉스 노이즈, 약 -1~1. 방향성 결이 적고 빠름", code:`vec3 permute289(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float simplexNoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute289(permute289(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 a0 = x - floor(x + 0.5);
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g = vec3(a0.x * x0.x + h.x * x0.y, a0.yz * x12.xz + h.yz * x12.yw);
    return 130.0 * dot(m, g);
}`},
      {id:"fbm", title:"fbm", desc:"여러 옥타브를 겹친 프랙털 노이즈, 0~1. 구름·지형", requires:["valueNoise"], code:`float fbm(vec2 p) {
    float value = 0.0, amplitude = 0.5;
    const mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);   // 옥타브마다 회전해 격자 결을 숨긴다
    for (int i = 0; i < 6; i++) {
        value += amplitude * valueNoise(p);
        p = rot * p * 2.02 + 17.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"fbmGradient", title:"fbmGradient", desc:"그래디언트 노이즈 fbm, 대략 -1~1. 값 노이즈 fbm보다 매끄럽고 덜 각짐", requires:["gradientNoise"], code:`float fbmGradient(vec2 p) {
    float value = 0.0, amplitude = 0.5;
    const mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 6; i++) {
        value += amplitude * gradientNoise(p);
        p = rot * p * 2.02 + 17.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"turbulence", title:"turbulence", desc:"|노이즈|를 겹친 난류, 0~1. 불꽃·연기·대리석 결", requires:["gradientNoise"], code:`float turbulence(vec2 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 6; i++) {
        value += amplitude * abs(gradientNoise(p));
        p = p * 2.03 + 7.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"curlNoise", title:"curlNoise (2D)", desc:"발산 없는 흐름 벡터장. 입자·잉크가 소용돌이치며 흐르게 (모이거나 흩어지지 않음)", requires:["gradientNoise"], code:`vec2 curlNoise(vec2 p) {
    const float e = 0.01;
    float dx = gradientNoise(p + vec2(e, 0.0)) - gradientNoise(p - vec2(e, 0.0));
    float dy = gradientNoise(p + vec2(0.0, e)) - gradientNoise(p - vec2(0.0, e));
    return vec2(dy, -dx) / (2.0 * e);   // 스칼라장의 기울기를 90° 돌린 것
}`},
      {id:"ridged", title:"ridgedFbm", desc:"능선형 프랙털. 산맥·번개·균열 느낌", requires:["gradientNoise"], code:`float ridgedFbm(vec2 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
        float n = 1.0 - abs(gradientNoise(p));
        value += amplitude * n * n;
        p = p * 2.03 + 11.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"domainWarp", title:"domainWarp", desc:"fbm으로 좌표를 비틀어 유체·대리석 같은 흐름 만들기", requires:["fbm"], code:`float domainWarp(vec2 p, float t) {
    vec2 q = vec2(fbm(p + vec2(0.0, t * 0.1)), fbm(p + vec2(5.2, 1.3)));
    vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + t * 0.15), fbm(p + 4.0 * q + vec2(8.3, 2.8)));
    return fbm(p + 4.0 * r);
}`},
      {id:"voronoi", title:"voronoi", desc:"셀 노이즈. x=가까운 점 거리, y=경계까지 여유(F2-F1), z=셀 고유값", requires:["hash22","hash21"], code:`vec3 voronoi(vec2 p) {
    vec2 n = floor(p), f = fract(p), id = vec2(0);
    float d1 = 8.0, d2 = 8.0;
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(i, j);
        vec2 r = g + hash22(n + g) - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = n + g; }
        else if (d < d2) { d2 = d; }
    }
    return vec3(sqrt(d1), sqrt(d2) - sqrt(d1), hash21(id));
}`}]},
    {id:"noise3d", title:"노이즈 3D", desc:"3차원 노이즈와 프랙털. 레이마칭 표면·구름 같은 부피 표현에 쓰고, 2D 화면에서는 z에 시간을 넣어 '형태가 변하며 흐르는' 노이즈로 씁니다.", items:[
      {id:"valueNoise3", title:"valueNoise3 (3D)", desc:"3D 값 노이즈, 0~1. 가장 싸고 단순", requires:["hash13"], code:`float valueNoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float a = mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x);
    float b = mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x);
    float c = mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x);
    float d = mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x);
    return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}`},
      {id:"gradientNoise3", title:"gradientNoise3 (3D 퍼린)", desc:"3D 그래디언트(퍼린) 노이즈, 대략 -1~1. 값 노이즈보다 결이 고름", requires:["hash33"], code:`float gradientNoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic
    // 격자 꼭짓점 8개의 무작위 기울기와 꼭짓점→점 벡터의 내적을 삼선형 보간
    #define GRAD(o) dot(hash33(i + o) * 2.0 - 1.0, f - o)
    float n000 = GRAD(vec3(0, 0, 0)), n100 = GRAD(vec3(1, 0, 0));
    float n010 = GRAD(vec3(0, 1, 0)), n110 = GRAD(vec3(1, 1, 0));
    float n001 = GRAD(vec3(0, 0, 1)), n101 = GRAD(vec3(1, 0, 1));
    float n011 = GRAD(vec3(0, 1, 1)), n111 = GRAD(vec3(1, 1, 1));
    #undef GRAD
    return 1.1547 * mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
                        mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}`},
      {id:"simplex3", title:"simplexNoise3 (3D 심플렉스)", desc:"3D 심플렉스 노이즈, 약 -1~1. 고품질·방향 결이 거의 없음 (Ashima/Gustavson, MIT)", code:`vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289v4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute4(vec4 x) { return mod289v4(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt4(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float simplexNoise3(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz), l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy), i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx, x2 = x0 - i2 + C.yyy, x3 = x0 - D.yyy;
    i = mod289v3(i);
    vec4 p = permute4(permute4(permute4(i.z + vec4(0.0, i1.z, i2.z, 1.0))
                             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                             + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    vec3 ns = 0.142857142857 * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z), y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy, y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy), b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0, s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy, a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x), p1 = vec3(a0.zw, h.y), p2 = vec3(a1.xy, h.z), p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt4(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}`},
      {id:"fbm3", title:"fbm3 (3D fbm)", desc:"3D 프랙털 노이즈, 0~1. 구름 밀도·암석 표면·흐르는 연기", requires:["valueNoise3"], code:`float fbm3(vec3 p) {
    float value = 0.0, amplitude = 0.5;
    const mat3 rot = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);   // 옥타브마다 회전
    for (int i = 0; i < 5; i++) {
        value += amplitude * valueNoise3(p);
        p = rot * p * 2.02;
        amplitude *= 0.5;
    }
    return value / 0.96875;   // 5옥타브 진폭 합으로 나눠 0~1로
}`},
      {id:"fbm3Simplex", title:"fbm3Simplex", desc:"심플렉스 기반 3D fbm, 대략 -1~1. 더 매끄럽지만 조금 무거움", requires:["simplex3"], code:`float fbm3Simplex(vec3 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
        value += amplitude * simplexNoise3(p);
        p = p * 2.03 + vec3(11.0, 7.0, 3.0);
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"ridged3", title:"ridgedFbm3", desc:"3D 능선 프랙털, 0~1. 산 표면·용암 균열", requires:["gradientNoise3"], code:`float ridgedFbm3(vec3 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
        float n = 1.0 - abs(gradientNoise3(p));
        value += amplitude * n * n;
        p = p * 2.03 + 5.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"turbulence3", title:"turbulence3", desc:"3D 난류, 0~1. 불꽃·연기를 시간축으로 흘리기 좋음", requires:["gradientNoise3"], code:`float turbulence3(vec3 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
        value += amplitude * abs(gradientNoise3(p));
        p = p * 2.03 + 3.0;
        amplitude *= 0.5;
    }
    return value;
}`},
      {id:"voronoi3", title:"voronoi3 (3D 셀)", desc:"3D 셀 노이즈. x = 가까운 점 거리(F1), y = F2 − F1(경계), z = 셀 고유값", requires:["hash33","hash13"], code:`vec3 voronoi3(vec3 p) {
    vec3 n = floor(p), f = fract(p), id = vec3(0);
    float d1 = 8.0, d2 = 8.0;
    for (int k = -1; k <= 1; k++)
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
        vec3 g = vec3(i, j, k);
        vec3 r = g + hash33(n + g) - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = n + g; }
        else if (d < d2) { d2 = d; }
    }
    return vec3(sqrt(d1), sqrt(d2) - sqrt(d1), hash13(id));
}`},
      {id:"domainWarp3", title:"domainWarp3", desc:"3D fbm으로 좌표를 비튼 흐름 (t = 시간). 2D 화면에선 p = vec3(uv, 0)", requires:["fbm3"], code:`float domainWarp3(vec3 p, float t) {
    vec3 q = vec3(fbm3(p + vec3(0.0, 0.0, t)), fbm3(p + vec3(5.2, 1.3, 2.8)), fbm3(p + vec3(1.7, 9.2, t * 0.5)));
    return fbm3(p + 3.0 * q);
}`},
      {id:"flowNoise", title:"시간으로 흐르는 노이즈", desc:"2D 화면에서 3D fbm의 z축을 시간으로 — 미끄러지지 않고 형태 자체가 변함", requires:["fbm3"], scope:"main", code:`float n = fbm3(vec3(uv * 3.0, uTime * 0.25));`},
      {id:"volumeClouds", title:"부피 구름 (3D fbm 레이마칭)", desc:"fbm3 밀도장을 광선으로 누적하는 완성 장면 (현재 패스를 교체). 무거우면 렌더링 탭의 해상도 배율을 낮추세요", replace:true, code:`#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;

float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}
float valueNoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float a = mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x);
    float b = mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x);
    float c = mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x);
    float d = mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x);
    return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}
float fbm3(vec3 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i = 0; i < 3; i++) { value += amplitude * valueNoise3(p); p = p * 2.03 + 1.7; amplitude *= 0.5; }
    return value / 0.875;   // 옥타브를 늘리면 디테일↑ 비용↑ (나눗수 = 진폭 합)
}
// 구름층: 높이 1.0~2.2. shape는 층의 아래·위를 부드럽게 깎는 높이 프로파일.
const float CLOUD_BOTTOM = 1.0, CLOUD_TOP = 2.2;
float heightShape(float y) {
    float h = (y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM);
    return smoothstep(0.0, 0.25, h) * smoothstep(1.0, 0.5, h);
}
vec3 wind() { return vec3(uTime * 0.08, 0.0, 0.0); }
float density(vec3 p) {        // 구름 모양: 3D fbm 3옥타브
    return clamp((fbm3(p * 0.45 + wind()) * heightShape(p.y) - 0.3) * 3.0, 0.0, 1.0);
}
float densityCoarse(vec3 p) {  // 그늘 계산용: 1옥타브만 (비용 절감)
    return clamp((valueNoise3(p * 0.45 + wind()) * heightShape(p.y) - 0.3) * 3.0, 0.0, 1.0);
}
void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec3 ro = vec3(0.0, 0.0, uTime * 0.6);                 // 구름 아래를 앞으로 나는 카메라
    vec3 rd = normalize(vec3(uv.x, uv.y + 0.45, 1.6));
    vec3 sun = normalize(vec3(0.5, 0.35, 0.8));
    float sunAmount = max(dot(rd, sun), 0.0);
    vec3 sky = mix(vec3(0.75, 0.82, 0.92), vec3(0.25, 0.45, 0.8), clamp(rd.y * 1.6, 0.0, 1.0));
    sky += vec3(1.0, 0.75, 0.45) * (0.25 * pow(sunAmount, 8.0) + pow(sunAmount, 256.0));

    vec3 col = sky;
    if (rd.y > 0.01) {
        // 광선이 구름층에 들어가고 나오는 거리를 공식으로 구해, 층 안에서만 24걸음 마칭한다.
        float t0 = (CLOUD_BOTTOM - ro.y) / rd.y;
        float t1 = min((CLOUD_TOP - ro.y) / rd.y, t0 + 18.0);
        float dt = (t1 - t0) / 24.0;
        float t = t0 + dt * hash13(vec3(gl_FragCoord.xy, uTime));   // 시작점을 흔들어 띠 무늬 제거
        vec3 acc = vec3(0.0);
        float transmittance = 1.0;
        for (int i = 0; i < 24; i++) {
            vec3 p = ro + rd * t;
            float d = density(p);
            if (d > 0.0) {
                float lit = exp(-2.0 * densityCoarse(p + sun * 0.5));        // 해 쪽이 짙으면 그늘
                vec3 c = mix(vec3(0.42, 0.47, 0.58), vec3(1.0, 0.97, 0.92), lit);
                float a = 1.0 - exp(-d * dt * 2.5);                          // 베르-람베르트 흡수
                acc += transmittance * a * c;                                // 앞에서 뒤로 누적
                transmittance *= 1.0 - a;
                if (transmittance < 0.03) break;
            }
            t += dt;
        }
        col = mix(sky, acc + transmittance * sky, exp(-0.04 * t0));       // 먼 구름은 하늘에 녹아들게
    } else {
        col = mix(vec3(0.3, 0.35, 0.4), sky, exp(rd.y * 30.0));            // 지평선 아래
    }
    fragColor = vec4(col, 1.0);
}`}]},
    {id:"patterns", title:"패턴 · 질감", desc:"타일·줄무늬·별·등고선처럼 화면을 채우는 무늬입니다. 대부분 0~1 마스크를 돌려주므로 mix로 색을 입힙니다.", items:[
      {id:"checkerAA", title:"checker (AA)", desc:"경계가 깨지지 않는 체커보드 마스크, 0~1 (p = 칸 단위 좌표)", code:`float checkerAA(vec2 p) {
    vec2 w = fwidth(p) + 1e-4;
    vec2 i = 2.0 * (abs(fract((p - 0.5 * w) * 0.5) - 0.5) - abs(fract((p + 0.5 * w) * 0.5) - 0.5)) / w;
    return 0.5 - 0.5 * i.x * i.y;
}`},
      {id:"stripesAA", title:"stripes (AA)", desc:"1 간격 줄무늬 마스크 (width = 줄 두께 0~1). x에 각도·거리를 넣으면 사선·동심원", code:`float stripesAA(float x, float width) {
    float d = abs(fract(x) - 0.5) - 0.5 * (1.0 - width);
    float w = fwidth(x);
    return smoothstep(-w, w, d);
}`},
      {id:"contour", title:"등고선", desc:"스칼라 값 v에 spacing 간격의 등고선 마스크 (지형·거리장·노이즈 시각화)", code:`float contourLines(float v, float spacing, float thickness) {
    float x = v / spacing;
    float d = abs(fract(x - 0.5) - 0.5) / max(fwidth(x), 1e-5);
    return 1.0 - smoothstep(thickness - 0.5, thickness + 0.5, d);
}`},
      {id:"dotsGrid", title:"점 격자 (하프톤 점)", desc:"칸마다 원 하나, size(0~1)로 점 크기 조절", code:`float dotsGrid(vec2 p, float size) {
    vec2 f = fract(p) - 0.5;
    float d = length(f) - 0.5 * size;
    float w = fwidth(d);
    return 1.0 - smoothstep(-w, w, d);
}`},
      {id:"truchet", title:"truchet", desc:"칸마다 무작위로 뒤집힌 사분원 → 끊김 없는 곡선 미로. 반환 = 곡선까지 거리", requires:["hash21"], code:`float truchet(vec2 p) {
    vec2 id = floor(p), f = fract(p) - 0.5;
    if (hash21(id) > 0.5) f.x = -f.x;
    vec2 c = f - sign(f.x + f.y + 1e-6) * 0.5;   // 가까운 두 모서리 중 하나를 원의 중심으로
    return abs(length(c) - 0.5);
}`},
      {id:"brick", title:"벽돌 타일", desc:"한 줄씩 반 칸 어긋난 벽돌. xy = 벽돌 안 좌표, zw = 벽돌 id", code:`vec4 brickTile(vec2 p, vec2 size) {
    p /= size;
    p.x += 0.5 * mod(floor(p.y), 2.0);   // 홀수 줄을 반 칸 밀기
    return vec4(fract(p) - 0.5, floor(p));
}`},
      {id:"starLayer", title:"반짝이는 별 한 겹", desc:"밀도를 바꿔 여러 겹 더하면 깊이감 있는 별밭 (p = 화면 좌표 × 밀도)", requires:["hash22","hash21"], code:`float starLayer(vec2 p, float time) {
    vec2 id = floor(p), f = fract(p) - 0.5;
    vec2 pos = (hash22(id) - 0.5) * 0.8;           // 칸 안 무작위 위치
    float r = hash21(id + 7.0);                    // 밝기·깜빡임 속도
    float d = length(f - pos);
    float twinkle = 0.6 + 0.4 * sin(time * (2.0 + 4.0 * r) + r * 6.2831);
    float core = smoothstep(0.05 * (0.5 + r), 0.0, d);
    return step(0.7, r) * twinkle * (core + 0.004 / max(d * d, 0.002));
}`},
      {id:"starfield", title:"별밭 (3겹)", desc:"starLayer를 크기별로 겹친 배경", requires:["starLayer"], scope:"main", code:`float stars = starLayer(uv * 8.0, uTime) + 0.6 * starLayer(uv * 16.0 + 3.1, uTime) + 0.35 * starLayer(uv * 32.0 + 7.7, uTime);`},
      {id:"waveLines", title:"물결 선", desc:"사인으로 휘어진 가로 줄들 (등산 지도·사운드웨이브 느낌)", code:`float waveLines(vec2 p, float count, float time) {
    float y = p.y * count + 0.3 * sin(p.x * 4.0 + time) + 0.15 * sin(p.x * 9.0 - time * 1.3);
    float d = abs(fract(y) - 0.5);
    float w = fwidth(y);
    return 1.0 - smoothstep(0.04 - w, 0.04 + w, d);
}`}]},
    {id:"fractal", title:"프랙털", desc:"같은 규칙을 반복해 끝없는 디테일을 만드는 수학 도형입니다. 반복 횟수가 곧 비용이므로 상한을 조절하세요.", items:[
      {id:"mandelbrot", title:"mandelbrot", desc:"c = 복소평면 좌표. 반환 0~1 (매끄러운 탈출 비율, 1 = 집합 안)", code:`float mandelbrot(vec2 c) {
    vec2 z = vec2(0.0);
    for (int i = 0; i < 256; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;   // z = z² + c
        float m = dot(z, z);
        if (m > 256.0) return (float(i) - log2(log2(m)) + 4.0) / 256.0;
    }
    return 1.0;
}
// 사용 예: float m = mandelbrot(uv * 1.2 + vec2(-0.6, 0.0));`},
      {id:"julia", title:"julia", desc:"z = 픽셀 좌표, c = 고정 상수(시간으로 움직이면 형태가 변함). 반환 0~1", code:`float julia(vec2 z, vec2 c) {
    for (int i = 0; i < 200; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        float m = dot(z, z);
        if (m > 256.0) return (float(i) - log2(log2(m)) + 4.0) / 200.0;
    }
    return 1.0;
}
// 사용 예: julia(uv * 1.3, 0.7885 * vec2(cos(uTime * 0.3), sin(uTime * 0.3)))`},
      {id:"sdMenger", title:"sdMenger (멩거 스펀지)", desc:"3D 프랙털 SDF — 상자에서 십자 구멍을 재귀적으로 뺀 스펀지 (크기 1)", code:`float sdMenger(vec3 p) {
    vec3 q = abs(p) - 1.0;
    float d = length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
    float s = 1.0;
    for (int m = 0; m < 4; m++) {
        vec3 a = mod(p * s, 2.0) - 1.0;
        s *= 3.0;
        vec3 r = abs(1.0 - 3.0 * abs(a));
        float da = max(r.x, r.y), db = max(r.y, r.z), dc = max(r.z, r.x);
        d = max(d, (min(da, min(db, dc)) - 1.0) / s);
    }
    return d;
}`},
      {id:"sdMandelbulb", title:"sdMandelbulb", desc:"3D 만델브롯(만델벌브) 거리 추정. power 8이 고전 형태", code:`float sdMandelbulb(vec3 p, float power) {
    vec3 z = p;
    float dr = 1.0, r = length(z);
    for (int i = 0; i < 8; i++) {
        r = length(z);
        if (r > 2.0 || r < 1e-6) break;
        float theta = acos(clamp(z.z / r, -1.0, 1.0)) * power;
        float phi = atan(z.y, z.x) * power;
        dr = pow(r, power - 1.0) * power * dr + 1.0;
        z = pow(r, power) * vec3(sin(theta) * cos(phi), sin(phi) * sin(theta), cos(theta)) + p;
    }
    return 0.5 * log(max(r, 1e-6)) * r / dr;
}`},
      {id:"kifs", title:"KIFS 접기", desc:"접기+회전+축소를 반복하는 만화경식 3D 프랙털 (rot3 축 회전 필요). 결과 p에 아무 SDF나 적용", requires:["rot3"], code:`vec3 kifsFold(vec3 p, float time, out float scale) {
    scale = 1.0;
    mat3 r = rotateAxis(vec3(1.0, 0.7, 0.3), 0.6 + 0.2 * sin(time));
    for (int i = 0; i < 6; i++) {
        p = abs(p);                                    // 접기
        if (p.x < p.y) p.xy = p.yx;
        if (p.x < p.z) p.xz = p.zx;
        p = r * p * 1.6 - vec3(1.0, 0.4, 0.2);          // 회전·확대·이동
        scale *= 1.6;
    }
    return p;
}
// 사용 예: float s; vec3 q = kifsFold(p, uTime, s); float d = sdBox(q, vec3(0.6)) / s;`}]},
    {id:"sdf2d", title:"2D SDF", desc:"점에서 도형 경계까지의 부호 있는 거리(안쪽 음수). 안티에일리어싱·외곽선·합성이 쉬워집니다.", items:[
      {id:"sdCircle", title:"sdCircle", desc:"원", code:`float sdCircle(vec2 p, float r) { return length(p) - r; }`},
      {id:"sdBox2", title:"sdBox2D", desc:"사각형 (b = 반쪽 크기)", code:`float sdBox2D(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}`},
      {id:"sdRoundBox2", title:"sdRoundBox2D", desc:"둥근 사각형 (r = 모서리 반지름)", requires:["sdBox2"], code:`float sdRoundBox2D(vec2 p, vec2 b, float r) { return sdBox2D(p, b - r) - r; }`},
      {id:"sdSegment", title:"sdSegment", desc:"선분 a–b (두께는 결과에서 빼기)", code:`float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}`},
      {id:"sdTriangle", title:"sdEquilateralTriangle", desc:"정삼각형 (r = 크기)", code:`float sdEquilateralTriangle(vec2 p, float r) {
    const float k = 1.7320508;
    p.x = abs(p.x) - r;
    p.y = p.y + r / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0 * r, 0.0);
    return -length(p) * sign(p.y);
}`},
      {id:"sdHexagon", title:"sdHexagon", desc:"정육각형", code:`float sdHexagon(vec2 p, float r) {
    const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
}`},
      {id:"sdStar5", title:"sdStar5", desc:"별 (r = 크기, rf = 안쪽 비율 0~1)", code:`float sdStar5(vec2 p, float r, float rf) {
    const vec2 k1 = vec2(0.809016994375, -0.587785252292);
    const vec2 k2 = vec2(-0.809016994375, -0.587785252292);
    p.x = abs(p.x);
    p -= 2.0 * max(dot(k1, p), 0.0) * k1;
    p -= 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= r;
    vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0, 1);
    float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}`},
      {id:"sdRing", title:"sdRing", desc:"고리 (r = 반지름, w = 두께의 절반)", code:`float sdRing(vec2 p, float r, float w) { return abs(length(p) - r) - w; }`},
      {id:"sdEllipse", title:"sdEllipseApprox", desc:"타원 (r = 가로·세로 반지름). 빠른 근사 — 외곽선·채우기에 충분", code:`float sdEllipseApprox(vec2 p, vec2 r) {
    float k0 = length(p / r), k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / k1;
}`},
      {id:"sdHeart", title:"sdHeart", desc:"하트 (크기 약 1, 아래 끝이 원점). 사용: sdHeart((p - 위치) / s) * s", code:`float sdHeart(vec2 p) {
    p.x = abs(p.x);
    if (p.y + p.x > 1.0) return length(p - vec2(0.25, 0.75)) - 0.35355339;
    vec2 a = p - vec2(0.0, 1.0), b = p - 0.5 * max(p.x + p.y, 0.0);
    return sqrt(min(dot(a, a), dot(b, b))) * sign(p.x - p.y);
}`},
      {id:"sdRhombus", title:"sdRhombus", desc:"마름모 (b = 가로·세로 반 대각선)", code:`float sdRhombus(vec2 p, vec2 b) {
    p = abs(p);
    vec2 q = b - 2.0 * p;
    float h = clamp((q.x * b.x - q.y * b.y) / dot(b, b), -1.0, 1.0);
    float d = length(p - 0.5 * b * vec2(1.0 - h, 1.0 + h));
    return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}`},
      {id:"sdPie", title:"sdPie", desc:"부채꼴 (aperture = 위쪽 기준 반각 라디안, r = 반지름)", code:`float sdPie(vec2 p, float aperture, float r) {
    vec2 c = vec2(sin(aperture), cos(aperture));
    p.x = abs(p.x);
    float l = length(p) - r;
    float m = length(p - c * clamp(dot(p, c), 0.0, r));
    return max(l, m * sign(c.y * p.x - c.x * p.y));
}`},
      {id:"sdArc", title:"sdArc", desc:"호 — 진행 바·게이지 (aperture = 반각, ra = 반지름, rb = 두께의 절반)", code:`float sdArc(vec2 p, float aperture, float ra, float rb) {
    vec2 sc = vec2(sin(aperture), cos(aperture));
    p.x = abs(p.x);
    return ((sc.y * p.x > sc.x * p.y) ? length(p - sc * ra) : abs(length(p) - ra)) - rb;
}`},
      {id:"sdCross", title:"sdCross", desc:"십자 (b.x = 팔 길이, b.y = 팔 두께의 절반, r = 둥글기)", code:`float sdCross(vec2 p, vec2 b, float r) {
    p = abs(p);
    p = (p.y > p.x) ? p.yx : p.xy;
    vec2 q = p - b;
    float k = max(q.y, q.x);
    vec2 w = (k > 0.0) ? q : vec2(b.y - p.x, -k);
    return sign(k) * length(max(w, 0.0)) + r;
}`},
      {id:"sdfFill", title:"fill · stroke (AA)", desc:"SDF를 픽셀 크기에 맞춰 부드럽게 칠하기·외곽선 그리기", code:`float fillSDF(float d) {
    float w = fwidth(d);
    return 1.0 - smoothstep(-w, w, d);
}
float strokeSDF(float d, float width) {
    float w = fwidth(d);
    return 1.0 - smoothstep(width - w, width + w, abs(d));
}`},
      {id:"sdfDebug", title:"거리장 시각화", desc:"SDF 값을 등고선으로 보기 (안쪽 주황, 바깥 파랑)", code:`vec3 debugSDF(float d) {
    vec3 col = d > 0.0 ? vec3(0.65, 0.85, 1.0) : vec3(0.9, 0.6, 0.3);
    col *= 1.0 - exp(-6.0 * abs(d));
    col *= 0.8 + 0.2 * cos(150.0 * d);
    return mix(col, vec3(1.0), 1.0 - smoothstep(0.0, 0.01, abs(d)));
}`}]},
    {id:"sdf3d", title:"3D SDF", desc:"레이마칭용 3D 도형 거리 함수. 도형의 중심이 원점이므로 p를 옮기거나 회전해 배치합니다.", items:[
      {id:"sdSphere", title:"sdSphere", desc:"구", code:`float sdSphere(vec3 p, float r) { return length(p) - r; }`},
      {id:"sdBox3", title:"sdBox", desc:"상자 (b = 반쪽 크기)", code:`float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}`},
      {id:"sdRoundBox3", title:"sdRoundBox", desc:"둥근 상자", requires:["sdBox3"], code:`float sdRoundBox(vec3 p, vec3 b, float r) { return sdBox(p, b - r) - r; }`},
      {id:"sdTorus", title:"sdTorus", desc:"도넛 (t.x = 큰 반지름, t.y = 굵기)", code:`float sdTorus(vec3 p, vec2 t) {
    vec2 q = vec2(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
}`},
      {id:"sdCapsule", title:"sdCapsule", desc:"캡슐 (a–b 선분 + 반지름)", code:`float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
    vec3 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
}`},
      {id:"sdCylinder", title:"sdCylinder", desc:"세로 원기둥 (h = 높이의 절반)", code:`float sdCylinder(vec3 p, float h, float r) {
    vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}`},
      {id:"sdPlane", title:"sdPlane", desc:"평면 (n = 정규화된 법선, h = 원점에서의 거리)", code:`float sdPlane(vec3 p, vec3 n, float h) { return dot(p, n) + h; }`},
      {id:"sdOctahedron", title:"sdOctahedron", desc:"정팔면체 (근사, 빠름)", code:`float sdOctahedron(vec3 p, float s) {
    p = abs(p);
    return (p.x + p.y + p.z - s) * 0.57735027;
}`},
      {id:"sdEllipsoid", title:"sdEllipsoid", desc:"타원체 (r = 축별 반지름, 근사)", code:`float sdEllipsoid(vec3 p, vec3 r) {
    float k0 = length(p / r), k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / k1;
}`},
      {id:"sdCappedCone", title:"sdCappedCone", desc:"잘린 원뿔 (h = 높이의 절반, r1 = 아래 반지름, r2 = 위 반지름)", code:`float sdCappedCone(vec3 p, float h, float r1, float r2) {
    vec2 q = vec2(length(p.xz), p.y);
    vec2 k1 = vec2(r2, h), k2 = vec2(r2 - r1, 2.0 * h);
    vec2 ca = vec2(q.x - min(q.x, (q.y < 0.0) ? r1 : r2), abs(q.y) - h);
    vec2 cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
    float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
    return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}`},
      {id:"sdHexPrism", title:"sdHexPrism", desc:"육각기둥 (h.x = 반지름, h.y = 길이의 절반, z축 방향)", code:`float sdHexPrism(vec3 p, vec2 h) {
    const vec3 k = vec3(-0.8660254, 0.5, 0.57735);
    p = abs(p);
    p.xy -= 2.0 * min(dot(k.xy, p.xy), 0.0) * k.xy;
    vec2 d = vec2(length(p.xy - vec2(clamp(p.x, -k.z * h.x, k.z * h.x), h.x)) * sign(p.y - h.x), p.z - h.y);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}`},
      {id:"sdBoxFrame", title:"sdBoxFrame", desc:"상자 뼈대(모서리만) (b = 반쪽 크기, e = 테두리 두께)", code:`float sdBoxFrame(vec3 p, vec3 b, float e) {
    p = abs(p) - b;
    vec3 q = abs(p + e) - e;
    return min(min(
        length(max(vec3(p.x, q.y, q.z), 0.0)) + min(max(p.x, max(q.y, q.z)), 0.0),
        length(max(vec3(q.x, p.y, q.z), 0.0)) + min(max(q.x, max(p.y, q.z)), 0.0)),
        length(max(vec3(q.x, q.y, p.z), 0.0)) + min(max(q.x, max(q.y, p.z)), 0.0));
}`},
      {id:"sdLink", title:"sdLink", desc:"사슬 고리 (le = 직선부 길이의 절반, r1 = 고리 반지름, r2 = 굵기)", code:`float sdLink(vec3 p, float le, float r1, float r2) {
    vec3 q = vec3(p.x, max(abs(p.y) - le, 0.0), p.z);
    return length(vec2(length(q.xy) - r1, q.z)) - r2;
}`},
      {id:"sdPyramid", title:"sdPyramid", desc:"사각뿔 (밑면 1×1, h = 높이, 밑면이 y = 0)", code:`float sdPyramid(vec3 p, float h) {
    float m2 = h * h + 0.25;
    p.xz = abs(p.xz);
    p.xz = (p.z > p.x) ? p.zx : p.xz;
    p.xz -= 0.5;
    vec3 q = vec3(p.z, h * p.y - 0.5 * p.x, h * p.x + 0.5 * p.y);
    float s = max(-q.x, 0.0);
    float t = clamp((q.y - 0.5 * p.z) / (m2 + 0.25), 0.0, 1.0);
    float a = m2 * (q.x + s) * (q.x + s) + q.y * q.y;
    float b = m2 * (q.x + 0.5 * t) * (q.x + 0.5 * t) + (q.y - m2 * t) * (q.y - m2 * t);
    float d2 = min(q.y, -q.x * m2 - q.y * 0.5) > 0.0 ? 0.0 : min(a, b);
    return sqrt((d2 + q.z * q.z) / m2) * sign(max(q.z, -p.y));
}`}]},
    {id:"ops", title:"도형 합성 · 반복", desc:"SDF끼리 더하고 빼고 부드럽게 녹이거나, 공간을 접어 무한히 반복합니다.", items:[
      {id:"opBool", title:"합집합 · 교집합 · 차집합", desc:"기본 불리언 연산", code:`float opUnion(float a, float b)        { return min(a, b); }
float opIntersection(float a, float b) { return max(a, b); }
float opSubtraction(float a, float b)  { return max(a, -b); }   // a에서 b를 뺀다`},
      {id:"smin", title:"smin (부드러운 합집합)", desc:"두 도형이 녹아 붙는 메타볼 효과 (k = 녹는 범위)", code:`float smin(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
}`},
      {id:"smax", title:"smax · 부드러운 차집합", desc:"모서리를 둥글게 깎는 교집합·차집합", requires:["smin"], code:`float smax(float a, float b, float k) { return -smin(-a, -b, k); }
float smoothSubtraction(float a, float b, float k) { return smax(a, -b, k); }`},
      {id:"opRound", title:"opRound · opOnion", desc:"모서리 둥글게 / 속이 빈 껍질 만들기", code:`float opRound(float d, float r)     { return d - r; }
float opOnion(float d, float thickness) { return abs(d) - thickness; }`},
      {id:"opRepeat2", title:"opRepeat (2D)", desc:"공간을 s 간격으로 무한 반복", code:`vec2 opRepeat(vec2 p, vec2 s) { return p - s * round(p / s); }`},
      {id:"opRepeat3", title:"opRepeat3 (3D)", desc:"3D 공간 무한 반복", code:`vec3 opRepeat3(vec3 p, vec3 s) { return p - s * round(p / s); }`},
      {id:"opRepeatLimited", title:"opRepeatLimited", desc:"개수 제한 반복 (l = 각 축 최대 칸 수)", code:`vec3 opRepeatLimited(vec3 p, float s, vec3 l) { return p - s * clamp(round(p / s), -l, l); }`},
      {id:"opPolar", title:"opPolarRepeat", desc:"원형 반복 (n 등분 만화경)", code:`vec2 opPolarRepeat(vec2 p, float n) {
    float sector = 6.2831853 / n;
    float a = mod(atan(p.y, p.x) + sector * 0.5, sector) - sector * 0.5;
    return length(p) * vec2(cos(a), sin(a));
}`},
      {id:"opMirror", title:"대칭 · 꼬기 · 휘기", desc:"x축 대칭, 높이에 따라 비틀기, 휘게 하기", requires:["rot2"], code:`vec3 opMirrorX(vec3 p) { p.x = abs(p.x); return p; }
vec3 opTwist(vec3 p, float k) { p.xz = rot2(k * p.y) * p.xz; return p; }
vec3 opBend(vec3 p, float k)  { p.xy = rot2(k * p.x) * p.xy; return p; }`},
      {id:"sminBlend", title:"sminBlend (재질 섞기)", desc:"부드러운 합집합 + 섞임 비율. x = 거리, y = 0(a)~1(b) — 두 도형의 색을 경계에서 섞을 때", code:`vec2 sminBlend(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    float m = h * h * 0.5;
    float s = m * k * 0.5;
    return (a < b) ? vec2(a - s, m) : vec2(b - s, 1.0 - m);
}
// 사용: vec2 r = sminBlend(dA, dB, 0.3); vec3 col = mix(colorA, colorB, r.y);`},
      {id:"opExtrude", title:"opExtrude (2D → 3D)", desc:"2D SDF를 z방향 두께 h만큼 밀어낸 입체. d2d = 2D SDF(p.xy)의 값", code:`float opExtrude(vec3 p, float d2d, float h) {
    vec2 w = vec2(d2d, abs(p.z) - h);
    return min(max(w.x, w.y), 0.0) + length(max(w, 0.0));
}
// 사용: float d = opExtrude(p, sdStar5(p.xy, 0.5, 0.4), 0.1);`},
      {id:"opRevolution", title:"opRevolution (회전체)", desc:"2D 단면을 y축으로 돌려 입체로. 반환 좌표를 2D SDF에 넣기 (o = 축에서 떨어진 거리)", code:`vec2 opRevolution(vec3 p, float o) { return vec2(length(p.xz) - o, p.y); }
// 사용: float d = sdBox2D(opRevolution(p, 0.6), vec2(0.1, 0.3));   // 상자 단면 → 둥근 고리`},
      {id:"opElongate", title:"opElongate", desc:"도형의 가운데를 h만큼 늘리기 (구 → 캡슐, 원환 → 트랙)", code:`vec3 opElongate(vec3 p, vec3 h) { return p - clamp(p, -h, h); }`},
      {id:"opDisplace", title:"opDisplace (표면 요철)", desc:"거리에 작은 파동을 더해 울퉁불퉁하게. amount가 크면 레이마칭 보폭을 줄이세요", code:`float opDisplace(vec3 p, float d, float freq, float amount) {
    return d + amount * sin(freq * p.x) * sin(freq * p.y) * sin(freq * p.z);
}`}]},
    {id:"space", title:"좌표 · 변환", desc:"화면 좌표를 다루기 좋은 공간으로 바꾸는 코드입니다.", items:[
      {id:"uvCenter", title:"중심 좌표 (종횡비 보정)", desc:"화면 중앙이 (0,0), 세로 범위 -1~1", scope:"main", code:`vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;`},
      {id:"uv01", title:"0~1 좌표", desc:"왼쪽 아래 (0,0), 오른쪽 위 (1,1)", scope:"main", code:`vec2 uv = gl_FragCoord.xy / uResolution;`},
      {id:"rot2", title:"rot2 (2D 회전)", desc:"각도(라디안)만큼 회전하는 행렬. 사용: p = rot2(a) * p", code:`mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }`},
      {id:"rot3", title:"축 회전 (3D)", desc:"임의 축 axis를 중심으로 회전하는 행렬", code:`mat3 rotateAxis(vec3 axis, float angle) {
    axis = normalize(axis);
    float s = sin(angle), c = cos(angle), oc = 1.0 - c;
    return mat3(oc * axis.x * axis.x + c,          oc * axis.x * axis.y + axis.z * s, oc * axis.z * axis.x - axis.y * s,
                oc * axis.x * axis.y - axis.z * s, oc * axis.y * axis.y + c,          oc * axis.y * axis.z + axis.x * s,
                oc * axis.z * axis.x + axis.y * s, oc * axis.y * axis.z - axis.x * s, oc * axis.z * axis.z + c);
}`},
      {id:"polar", title:"극좌표 변환", desc:"(반지름, 각도 0~1)로 바꾸기 — 방사형 패턴", scope:"main", code:`vec2 polar = vec2(length(uv), atan(uv.y, uv.x) / 6.2831853 + 0.5);`},
      {id:"tile", title:"타일 나누기 + 셀 번호", desc:"n칸 격자로 나누고 각 칸의 정수 id·내부 좌표 얻기", scope:"main", code:`vec2 grid = uv * 8.0;
vec2 cellId = floor(grid);          // 칸 번호 (hash21(cellId)로 칸마다 다른 값)
vec2 cellUv = fract(grid) - 0.5;    // 칸 안의 -0.5~0.5 좌표`},
      {id:"pixelate", title:"픽셀화", desc:"좌표를 큰 픽셀 단위로 끊기 (레트로·모자이크)", scope:"main", code:`float pixelSize = 8.0;
vec2 pixelUv = (floor(gl_FragCoord.xy / pixelSize) + 0.5) * pixelSize / uResolution;`},
      {id:"mouseUv", title:"마우스 좌표 (중심 기준)", desc:"uMouse를 uv와 같은 공간으로 (밖이면 0)", scope:"main", code:`vec2 mouse = uMouse.x < 0.0 ? vec2(0.0) : (2.0 * uMouse.xy - uResolution) / uResolution.y;`},
      {id:"hexGrid", title:"육각 격자", desc:"벌집 타일. xy = 칸 중심 기준 좌표, zw = 칸 id (hash21(id)로 칸마다 다른 값)", code:`vec4 hexGrid(vec2 p) {
    const vec2 s = vec2(1.0, 1.7320508);
    vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
    vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
    return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hc.xy) : vec4(h.zw, hc.zw + 0.5);
}`},
      {id:"rotXYZ", title:"rotX · rotY · rotZ", desc:"축별 3D 회전 행렬. 사용: p = rotY(uTime) * p", code:`mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }`},
      {id:"orbitCamera", title:"마우스 궤도 카메라", desc:"마우스 x = 방위각, y = 높이로 원점을 도는 카메라 위치 (uMouse 필요, 밖이면 자동 회전)", scope:"main", code:`vec2 m = uMouse.x < 0.0 ? vec2(0.5 + 0.05 * uTime, 0.35) : uMouse.xy / uResolution;
float yaw = m.x * 6.2831853, pitch = mix(-0.2, 1.3, m.y), dist = 4.0;
vec3 ro = dist * vec3(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw));
vec3 ta = vec3(0.0);`},
      {id:"kaleido", title:"만화경 접기", desc:"각도를 n조각으로 접고 반사 — 모든 조각이 거울처럼 이어짐", code:`vec2 kaleidoscope(vec2 p, float n) {
    float sector = 3.14159265 / n;
    float a = atan(p.y, p.x);
    a = abs(mod(a + sector, 2.0 * sector) - sector);   // 접고 뒤집기
    return length(p) * vec2(cos(a), sin(a));
}`}]},
    {id:"color", title:"색 · 팔레트", desc:"색 공간 변환과 아름다운 색 조합을 만드는 함수입니다.", items:[
      {id:"cosPalette", title:"코사인 팔레트", desc:"a + b·cos(2π(c·t + d)) — 숫자 4개로 무한한 그라디언트", code:`vec3 cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
    return a + b * cos(6.2831853 * (c * t + d));
}
// 예: cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67))`},
      {id:"hsv2rgb", title:"hsv2rgb", desc:"색상·채도·명도(모두 0~1) → RGB", code:`vec3 hsv2rgb(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return c.z * mix(vec3(1.0), rgb, c.y);
}`},
      {id:"rgb2hsv", title:"rgb2hsv", desc:"RGB → 색상·채도·명도", code:`vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y), e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}`},
      {id:"srgb", title:"sRGB ↔ 선형", desc:"조명 계산은 선형 공간에서, 출력 직전 sRGB로", code:`vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 linearToSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }`},
      {id:"luminance", title:"luminance", desc:"밝기(흑백 변환·밝기 기준 효과)", code:`float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`},
      {id:"saturation", title:"채도 조절", desc:"amount 0 = 흑백, 1 = 원본, 1 초과 = 강조", requires:["luminance"], code:`vec3 adjustSaturation(vec3 c, float amount) { return mix(vec3(luminance(c)), c, amount); }`},
      {id:"oklab", title:"OKLab · 지각 균일 섞기", desc:"사람 눈에 고르게 보이는 색 공간. mixOklab은 RGB mix보다 중간색이 탁해지지 않음 (선형 RGB 입력)", code:`vec3 linearToOklab(vec3 c) {
    float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
    float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
    float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
    vec3 lms = pow(max(vec3(l, m, s), 0.0), vec3(1.0 / 3.0));
    return vec3(0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,
                1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,
                0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z);
}
vec3 oklabToLinear(vec3 c) {
    float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
    float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
    float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
    l = l * l * l; m = m * m * m; s = s * s * s;
    return vec3( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 mixOklab(vec3 a, vec3 b, float t) { return oklabToLinear(mix(linearToOklab(a), linearToOklab(b), t)); }`},
      {id:"blackbody", title:"흑체 색 (온도 → 색)", desc:"켈빈 온도(1000~12000)를 색으로. 불꽃·용암·별·전구 빛", code:`vec3 blackbody(float kelvin) {
    float t = kelvin / 100.0;
    float r = t <= 66.0 ? 1.0 : clamp(1.29293618606 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
    float g = t <= 66.0 ? clamp(0.39008157876 * log(t) - 0.63184144378, 0.0, 1.0)
                        : clamp(1.12989086089 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
    float b = t >= 66.0 ? 1.0 : t <= 19.0 ? 0.0 : clamp(0.54320678911 * log(t - 10.0) - 1.19625408914, 0.0, 1.0);
    return vec3(r, g, b);
}`},
      {id:"turbo", title:"Turbo 색상맵", desc:"0~1 값을 구분하기 쉬운 무지개 색으로 (히트맵·디버그·데이터 시각화)", code:`vec3 turboColormap(float x) {
    const vec4 kr4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    const vec4 kg4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    const vec4 kb4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    const vec2 kr2 = vec2(-152.94239396, 59.28637943);
    const vec2 kg2 = vec2(4.27729857, 2.82956604);
    const vec2 kb2 = vec2(-89.90310912, 27.34824973);
    x = clamp(x, 0.0, 1.0);
    vec4 v4 = vec4(1.0, x, x * x, x * x * x);
    vec2 v2 = v4.zw * v4.z;
    return vec3(dot(v4, kr4) + dot(v2, kr2), dot(v4, kg4) + dot(v2, kg2), dot(v4, kb4) + dot(v2, kb2));
}`},
      {id:"palettePresets", title:"팔레트 프리셋 모음", desc:"cosPalette에 넣는 검증된 조합 6가지 (t = 0~1)", requires:["cosPalette"], code:`vec3 paletteRainbow(float t) { return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67)); }
vec3 paletteSunset(float t)  { return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 0.5), vec3(0.8, 0.9, 0.3)); }
vec3 paletteOcean(float t)   { return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0, 0.7, 0.4), vec3(0.0, 0.15, 0.2)); }
vec3 paletteFire(float t)    { return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 1.0), vec3(0.0, 0.1, 0.2)); }
vec3 paletteNeon(float t)    { return cosPalette(t, vec3(0.5), vec3(0.5), vec3(2.0, 1.0, 0.0), vec3(0.5, 0.2, 0.25)); }
vec3 paletteEarth(float t)   { return cosPalette(t, vec3(0.8, 0.5, 0.4), vec3(0.2, 0.4, 0.2), vec3(2.0, 1.0, 1.0), vec3(0.0, 0.25, 0.25)); }`}]},
    {id:"raymarch", title:"레이마칭", desc:"3D SDF 장면을 화면에 그리는 기본 골격입니다. map(p)는 직접 작성합니다.", items:[
      {id:"camera", title:"setCamera (lookAt)", desc:"카메라 위치 ro가 목표 ta를 바라보는 회전 행렬", code:`mat3 setCamera(vec3 ro, vec3 ta, float roll) {
    vec3 forward = normalize(ta - ro);
    vec3 right = normalize(cross(forward, vec3(sin(roll), cos(roll), 0.0)));
    vec3 up = cross(right, forward);
    return mat3(right, up, forward);
}
// 사용: vec3 rd = setCamera(ro, ta, 0.0) * normalize(vec3(uv, 1.8));`},
      {id:"march", title:"rayMarch 루프", desc:"광선을 따라 전진하며 표면 거리 찾기 (map 필요). 실패 시 -1", code:`float rayMarch(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) {
        float d = map(ro + rd * t);
        if (d < 0.001 * t) return t;   // 멀수록 허용 오차를 키운다
        t += d;
        if (t > 100.0) break;
    }
    return -1.0;
}`},
      {id:"normal", title:"calcNormal", desc:"정사면체 4번 샘플로 표면 법선 근사 (map 필요)", code:`vec3 calcNormal(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.0005;
    return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) +
                     k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}`},
      {id:"intersect", title:"해석적 교차 (구·평면·상자)", desc:"마칭 없이 공식으로 바로 맞히기 — 빠르고 정확. 실패 시 음수(구·평면) 또는 near > far(상자)", code:`float iSphere(vec3 ro, vec3 rd, vec3 center, float radius) {
    vec3 oc = ro - center;
    float b = dot(oc, rd), c = dot(oc, oc) - radius * radius, h = b * b - c;
    if (h < 0.0) return -1.0;
    h = sqrt(h);
    return (-b - h >= 0.0) ? -b - h : -b + h;   // 구 안에서 쏘면 먼 쪽
}
float iPlane(vec3 ro, vec3 rd, vec3 n, float h) { return -(dot(ro, n) + h) / dot(rd, n); }
vec2 iBox(vec3 ro, vec3 rd, vec3 halfSize) {   // 원점 중심 상자: (near, far)
    vec3 m = 1.0 / rd, n = m * ro, k = abs(m) * halfSize;
    vec3 t1 = -n - k, t2 = -n + k;
    return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}`},
      {id:"marchMaterial", title:"재질 번호 마칭", desc:"map이 vec2(거리, 재질 id)를 돌려줄 때 — 맞힌 지점의 재질별로 색 고르기 (mapMat 필요)", code:`vec2 rayMarchMaterial(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) {
        vec2 h = mapMat(ro + rd * t);   // h.x = 거리, h.y = 재질
        if (h.x < 0.001 * t) return vec2(t, h.y);
        t += h.x;
        if (t > 100.0) break;
    }
    return vec2(-1.0, 0.0);
}
// 합치기: vec2 opU(vec2 a, vec2 b) { return a.x < b.x ? a : b; }`},
      {id:"triplanar", title:"triplanar 텍스처", desc:"UV 없는 3D 표면에 이미지 입히기 — 법선 방향 세 평면에서 읽어 섞음", code:`vec3 triplanar(sampler2D tex, vec3 p, vec3 n, float scale) {
    vec3 w = pow(abs(n), vec3(4.0));
    w /= w.x + w.y + w.z;
    return texture(tex, p.yz * scale).rgb * w.x
         + texture(tex, p.xz * scale).rgb * w.y
         + texture(tex, p.xy * scale).rgb * w.z;
}`},
      {id:"rmTemplate", title:"레이마칭 전체 골격", desc:"카메라·마칭·법선·조명이 들어간 완성 장면 (현재 패스를 교체)", replace:true, code:`#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;

float sdSphere(vec3 p, float r) { return length(p) - r; }
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }

// 장면: 여기만 바꾸면 된다.
float map(vec3 p) {
    float ground = p.y + 1.0;
    float ball = sdSphere(p - vec3(0.0, 0.2 * sin(uTime), 0.0), 0.8);
    float orbit = sdSphere(p - vec3(1.2 * cos(uTime), 0.0, 1.2 * sin(uTime)), 0.35);
    return min(ground, smin(ball, orbit, 0.4));
}
vec3 calcNormal(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.0005;
    return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) +
                     k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}
float rayMarch(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 128; i++) {
        float d = map(ro + rd * t);
        if (d < 0.001 * t) return t;
        t += d;
        if (t > 50.0) break;
    }
    return -1.0;
}
void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec3 ro = vec3(0.0, 0.8, 4.0), ta = vec3(0.0);
    vec3 forward = normalize(ta - ro), right = normalize(cross(forward, vec3(0, 1, 0))), up = cross(right, forward);
    vec3 rd = normalize(uv.x * right + uv.y * up + 1.8 * forward);
    vec3 col = vec3(0.05, 0.06, 0.09) + 0.1 * rd.y;
    float t = rayMarch(ro, rd);
    if (t > 0.0) {
        vec3 p = ro + rd * t, n = calcNormal(p), light = normalize(vec3(0.6, 1.0, 0.4));
        float diffuse = max(dot(n, light), 0.0);
        col = vec3(0.85, 0.75, 0.6) * (0.15 + 0.85 * diffuse) + 0.2 * pow(max(dot(reflect(rd, n), light), 0.0), 32.0);
        col = mix(col, vec3(0.05, 0.06, 0.09), 1.0 - exp(-0.02 * t * t));   // 거리 안개
    }
    fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`}]},
    {id:"lighting", title:"조명 · 셰이딩", desc:"레이마칭 장면의 그림자·차폐·반사 표현입니다. 대부분 map(p)가 필요합니다.", items:[
      {id:"softShadow", title:"softShadow", desc:"부드러운 그림자 (k가 클수록 선명). map 필요", code:`float softShadow(vec3 ro, vec3 rd, float tmin, float tmax, float k) {
    float result = 1.0, t = tmin;
    for (int i = 0; i < 64; i++) {
        float h = map(ro + rd * t);
        result = min(result, k * h / t);
        t += clamp(h, 0.01, 0.2);
        if (result < 0.001 || t > tmax) break;
    }
    return clamp(result, 0.0, 1.0);
}`},
      {id:"ao", title:"ambientOcclusion", desc:"주변 차폐 — 구석을 어둡게 (map 필요)", code:`float ambientOcclusion(vec3 p, vec3 n) {
    float occlusion = 0.0, scale = 1.0;
    for (int i = 1; i <= 5; i++) {
        float h = 0.02 + 0.12 * float(i);
        occlusion += (h - map(p + n * h)) * scale;
        scale *= 0.75;
    }
    return clamp(1.0 - 2.5 * occlusion, 0.0, 1.0);
}`},
      {id:"fresnel", title:"fresnelSchlick", desc:"비스듬히 볼수록 반사가 강해지는 효과", code:`float fresnelSchlick(float cosTheta, float f0) {
    return f0 + (1.0 - f0) * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}`},
      {id:"blinnPhong", title:"blinnPhong", desc:"확산 + 하이라이트 기본 조명 (n, 광원 방향 l, 시선 방향 v)", code:`vec3 blinnPhong(vec3 n, vec3 l, vec3 v, vec3 albedo, float shininess) {
    float diffuse = max(dot(n, l), 0.0);
    float specular = pow(max(dot(n, normalize(l + v)), 0.0), shininess);
    return albedo * diffuse + vec3(specular) * step(0.0, diffuse);
}`},
      {id:"ggx", title:"GGX 스펙큘러 (PBR)", desc:"거칠기 기반 물리 하이라이트 (roughness 0.05~1, f0 = 0.04 비금속)", code:`float ggxSpecular(vec3 n, vec3 v, vec3 l, float roughness, float f0) {
    vec3 h = normalize(v + l);
    float nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 1e-4), nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
    float a2 = roughness * roughness * roughness * roughness;
    float dn = nh * nh * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * dn * dn);                       // 미세면 분포
    float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    float G = nl / (nl * (1.0 - k) + k) * nv / (nv * (1.0 - k) + k);   // 가림
    float F = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);              // 프레넬
    return D * G * F / (4.0 * nv + 1e-4);                        // nl은 G 안에 포함
}`},
      {id:"hemiAmbient", title:"반구 앰비언트", desc:"위는 하늘색, 아래는 땅색으로 받는 간접광 — 평평한 회색 그림자 대신", code:`vec3 hemiAmbient(vec3 n, vec3 skyCol, vec3 groundCol) { return mix(groundCol, skyCol, 0.5 + 0.5 * n.y); }`},
      {id:"fog", title:"거리 안개 + 해 산란", desc:"멀수록 안개색으로, 해를 향한 방향은 따뜻하게 (t = 거리, rd = 광선)", code:`vec3 applyFog(vec3 col, float t, vec3 rd, vec3 sunDir, float density) {
    float amount = 1.0 - exp(-t * density);
    float sun = max(dot(rd, sunDir), 0.0);
    vec3 fogCol = mix(vec3(0.5, 0.6, 0.7), vec3(1.0, 0.9, 0.7), pow(sun, 8.0));
    return mix(col, fogCol, amount);
}`},
      {id:"rim", title:"림 라이트", desc:"윤곽에 빛 테두리 (n = 법선, v = 시점 방향)", code:`float rimLight(vec3 n, vec3 v, float power) { return pow(1.0 - max(dot(n, v), 0.0), power); }`},
      {id:"sky", title:"간단한 하늘", desc:"광선 방향 rd로 하늘 그라디언트 + 태양", code:`vec3 skyColor(vec3 rd, vec3 sunDir) {
    vec3 col = mix(vec3(0.75, 0.85, 1.0), vec3(0.25, 0.45, 0.85), clamp(rd.y, 0.0, 1.0));
    col += vec3(1.0, 0.8, 0.5) * pow(max(dot(rd, sunDir), 0.0), 256.0);
    return col;
}`}]},
    {id:"motion", title:"애니메이션 · 이징", desc:"시간에 따른 움직임을 자연스럽게 만드는 함수입니다.", items:[
      {id:"remap", title:"remap · linearstep", desc:"값의 범위 바꾸기, 직선형 0~1 보간", code:`float remap(float v, float inMin, float inMax, float outMin, float outMax) {
    return outMin + (v - inMin) * (outMax - outMin) / (inMax - inMin);
}
float linearstep(float a, float b, float x) { return clamp((x - a) / (b - a), 0.0, 1.0); }`},
      {id:"easing", title:"이징 함수", desc:"t(0~1)를 가속·감속 곡선으로", code:`float easeInOutCubic(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) * 0.5; }
float easeOutBack(float t)    { const float c = 1.70158; return 1.0 + (c + 1.0) * pow(t - 1.0, 3.0) + c * pow(t - 1.0, 2.0); }
float easeOutElastic(float t) { return t <= 0.0 ? 0.0 : t >= 1.0 ? 1.0 : pow(2.0, -10.0 * t) * sin((t * 10.0 - 0.75) * 2.0943951) + 1.0; }`},
      {id:"pingpong", title:"pingPong · loop", desc:"0→1→0 왕복, 주기 반복", code:`float pingPong(float t) { return 1.0 - abs(fract(t * 0.5) * 2.0 - 1.0); }
float loopTime(float t, float period) { return mod(t, period) / period; }`},
      {id:"pulse", title:"pulse · impulse", desc:"특정 구간만 켜지는 펄스, 한 번 튀었다 줄어드는 임펄스", code:`float pulse(float center, float width, float x) { return 1.0 - smoothstep(0.0, width, abs(x - center)); }
float impulse(float k, float x) { float h = k * x; return h * exp(1.0 - h); }`},
      {id:"shake", title:"흔들림 (노이즈 기반)", desc:"부드럽게 떨리는 2D 오프셋 — 카메라 흔들림·손떨림 (strength = 세기)", requires:["noise1D"], code:`vec2 shake(float time, float speed, float strength) {
    return strength * (vec2(noise1D(time * speed), noise1D(time * speed + 31.7)) * 2.0 - 1.0);
}`},
      {id:"bounce", title:"공 튀기기", desc:"바닥에 튕기며 점점 낮아지는 높이 0~1 (period = 첫 튕김 주기)", code:`float bounce(float t, float period) {
    float x = fract(t / period);
    return 4.0 * x * (1.0 - x) * exp(-0.4 * floor(t / period));
}`},
      {id:"stepped", title:"끊어진 시간 (스톱모션)", desc:"fps 단위로 끊긴 시간 — 손그림 애니메이션 느낌", code:`float steppedTime(float t, float fps) { return floor(t * fps) / fps; }`},
      {id:"spring", title:"감쇠 진동", desc:"t초 후 흔들리다 멈추는 값 (출렁이는 등장)", code:`float dampedSpring(float t, float frequency, float damping) {
    return 1.0 - exp(-damping * t) * cos(frequency * t);
}`}]},
    {id:"post", title:"후처리 · 출력", desc:"최종 색을 다듬는 코드입니다. 대부분 Image 패스의 마지막에 씁니다.", items:[
      {id:"aces", title:"ACES 톤매핑", desc:"HDR 색을 영화 같은 대비로 0~1에 압축 (근사)", code:`vec3 acesTonemap(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}`},
      {id:"reinhard", title:"Reinhard + 감마", desc:"가장 단순한 톤매핑과 감마 보정", scope:"main", code:`color = color / (color + 1.0);
color = pow(color, vec3(1.0 / 2.2));`},
      {id:"vignette", title:"비네트", desc:"가장자리를 어둡게 (uv는 0~1)", code:`float vignette(vec2 uv, float strength) {
    uv *= 1.0 - uv.yx;
    return pow(uv.x * uv.y * 16.0, strength);
}`},
      {id:"grain", title:"필름 그레인", desc:"프레임마다 바뀌는 미세 노이즈 (밴딩 완화)", requires:["hash21"], code:`vec3 filmGrain(vec3 color, vec2 fragCoord, float time, float amount) {
    float n = hash21(fragCoord + fract(time) * 1000.0) - 0.5;
    return color + n * amount;
}`},
      {id:"dither", title:"디더링", desc:"8bit 출력의 계단(밴딩) 제거", requires:["hash21"], scope:"main", code:`fragColor.rgb += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;`},
      {id:"chromatic", title:"색수차", desc:"iChannel0을 R/G/B로 조금씩 어긋나게 읽기", code:`vec3 chromaticAberration(sampler2D tex, vec2 uv, float amount) {
    vec2 dir = uv - 0.5;
    return vec3(texture(tex, uv + dir * amount).r,
                texture(tex, uv).g,
                texture(tex, uv - dir * amount).b);
}`},
      {id:"posterize", title:"포스터화", desc:"색 단계를 levels개로 줄이기 (툰·레트로)", code:`vec3 posterize(vec3 c, float levels) { return floor(c * levels + 0.5) / levels; }`},
      {id:"liftGammaGain", title:"색보정 (Lift·Gamma·Gain)", desc:"어두운 곳·중간톤·밝은 곳을 따로 물들이기 (기본값 lift 0, gamma 1, gain 1)", code:`vec3 liftGammaGain(vec3 c, vec3 lift, vec3 gamma, vec3 gain) {
    c = c * gain + lift * (1.0 - c);
    return pow(max(c, 0.0), 1.0 / gamma);
}`},
      {id:"bayer", title:"Bayer 순서 디더", desc:"4×4 행렬 임계값 (0~1). 계단식 레트로 디더: step(bayer4(fragCoord), 밝기)", code:`float bayer4(vec2 fragCoord) {
    ivec2 p = ivec2(fragCoord) & 3;
    const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
    return (m[p.y * 4 + p.x] + 0.5) / 16.0;
}`},
      {id:"halftone", title:"하프톤 점", desc:"밝기 value(0~1)를 회전된 점 크기로 — 인쇄물 느낌 (cellSize = 점 간격 픽셀)", code:`float halftone(vec2 fragCoord, float value, float cellSize, float angle) {
    float c = cos(angle), s = sin(angle);
    vec2 f = fract(mat2(c, s, -s, c) * fragCoord / cellSize) - 0.5;
    float r = sqrt(clamp(value, 0.0, 1.0)) * 0.7071;
    float w = 1.0 / cellSize;
    return 1.0 - smoothstep(r - w, r + w, length(f));
}`},
      {id:"barrel", title:"렌즈 왜곡 (배럴)", desc:"uv(0~1)를 볼록하게 휘기 (k > 0 볼록, k < 0 오목) — 색수차와 함께 쓰면 CRT", code:`vec2 barrelDistort(vec2 uv, float k) {
    vec2 c = uv - 0.5;
    return 0.5 + c * (1.0 + k * dot(c, c));
}`},
      {id:"sharpen", title:"샤픈", desc:"주변 4픽셀과의 차이를 더해 윤곽 강조 (px = 1.0 / 해상도)", code:`vec4 sharpen(sampler2D tex, vec2 uv, vec2 px, float amount) {
    vec4 c = texture(tex, uv);
    vec4 n = texture(tex, uv + vec2(px.x, 0)) + texture(tex, uv - vec2(px.x, 0))
           + texture(tex, uv + vec2(0, px.y)) + texture(tex, uv - vec2(0, px.y));
    return c + amount * (4.0 * c - n);
}`},
      {id:"scanline", title:"CRT 스캔라인", desc:"브라운관 느낌의 가로줄 (fragCoord.y 기준)", code:`vec3 scanlines(vec3 color, float y, float strength) {
    return color * (1.0 - strength + strength * 0.5 * (1.0 + sin(y * 3.14159)));
}`}]},
    {id:"buffers", title:"버퍼 · 텍스처", desc:"다른 패스·이전 프레임·이미지를 읽는 패턴입니다.", items:[
      {id:"readPrev", title:"이전 프레임 누적", desc:"자기 자신(previous)을 iChannel0에 연결한 피드백 패스", scope:"main", code:`vec2 uv = gl_FragCoord.xy / uResolution;
vec4 history = uFrame == 0 ? vec4(0.0) : texture(iChannel0, uv);
fragColor = mix(history, newColor, 0.1);   // newColor를 천천히 누적`},
      {id:"texelNeighbors", title:"이웃 픽셀 읽기", desc:"상하좌우 텍셀을 정확히 읽기 (시뮬레이션·엣지 검출)", scope:"main", code:`ivec2 ip = ivec2(gl_FragCoord.xy);
vec4 center = texelFetch(iChannel0, ip, 0);
vec4 left   = texelFetch(iChannel0, ip + ivec2(-1, 0), 0);
vec4 right  = texelFetch(iChannel0, ip + ivec2( 1, 0), 0);
vec4 down   = texelFetch(iChannel0, ip + ivec2(0, -1), 0);
vec4 up     = texelFetch(iChannel0, ip + ivec2(0,  1), 0);`},
      {id:"laplacian", title:"라플라시안", desc:"확산·파동 시뮬레이션의 핵심 (9점, 가중치 합 1)", code:`vec4 laplacian(sampler2D tex, vec2 uv, vec2 px) {
    vec4 c = texture(tex, uv);
    vec4 sides = texture(tex, uv + vec2(px.x, 0)) + texture(tex, uv - vec2(px.x, 0))
               + texture(tex, uv + vec2(0, px.y)) + texture(tex, uv - vec2(0, px.y));
    vec4 corners = texture(tex, uv + px) + texture(tex, uv - px)
                 + texture(tex, uv + vec2(px.x, -px.y)) + texture(tex, uv + vec2(-px.x, px.y));
    return 0.2 * sides + 0.05 * corners - c;
}`},
      {id:"blur9", title:"3×3 박스 블러", desc:"주변 9픽셀 평균 (px = 1.0 / 해상도)", code:`vec4 blur9(sampler2D tex, vec2 uv, vec2 px) {
    vec4 sum = vec4(0.0);
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) sum += texture(tex, uv + vec2(x, y) * px);
    return sum / 9.0;
}`},
      {id:"sobel", title:"소벨 엣지", desc:"밝기 경계 강도 (윤곽선 효과)", requires:["luminance"], code:`float sobelEdge(sampler2D tex, vec2 uv, vec2 px) {
    float tl = luminance(texture(tex, uv + px * vec2(-1,  1)).rgb), t = luminance(texture(tex, uv + px * vec2(0,  1)).rgb), tr = luminance(texture(tex, uv + px * vec2(1,  1)).rgb);
    float l  = luminance(texture(tex, uv + px * vec2(-1,  0)).rgb),                                                        r  = luminance(texture(tex, uv + px * vec2(1,  0)).rgb);
    float bl = luminance(texture(tex, uv + px * vec2(-1, -1)).rgb), b = luminance(texture(tex, uv + px * vec2(0, -1)).rgb), br = luminance(texture(tex, uv + px * vec2(1, -1)).rgb);
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy = -bl - 2.0 * b - br + tl + 2.0 * t + tr;
    return length(vec2(gx, gy));
}`},
      {id:"gaussian", title:"가우시안 블러 (분리형)", desc:"한 방향 9탭 블러 — 가로 패스 + 세로 패스 두 번으로 큰 블러 (dir = (1/w, 0) 또는 (0, 1/h))", code:`vec4 gaussianBlur(sampler2D tex, vec2 uv, vec2 dir) {
    vec4 sum = texture(tex, uv) * 0.2270270270;
    sum += (texture(tex, uv + dir * 1.3846153846) + texture(tex, uv - dir * 1.3846153846)) * 0.3162162162;
    sum += (texture(tex, uv + dir * 3.2307692308) + texture(tex, uv - dir * 3.2307692308)) * 0.0702702703;
    return sum;
}`},
      {id:"advect", title:"이류 (값을 흐름 따라 옮기기)", desc:"속도장 vel(픽셀/프레임)을 거슬러 읽어 값을 실어 나름 (semi-Lagrangian) — 연기·잉크·유체", code:`vec4 advect(sampler2D field, vec2 fragCoord, vec2 vel, vec2 resolution) {
    return texture(field, (fragCoord - vel) / resolution);
}`},
      {id:"waveStep", title:"파동 방정식 한 단계", desc:"물결 시뮬레이션 Buffer (iChannel0 = 자기 자신 previous, RGBA16F 권장). r = 현재 높이, g = 직전 높이. 마우스로 물방울", scope:"main", code:`ivec2 ip = ivec2(gl_FragCoord.xy);
vec4 c = texelFetch(iChannel0, ip, 0);
float sum = texelFetch(iChannel0, ip + ivec2(1, 0), 0).r + texelFetch(iChannel0, ip - ivec2(1, 0), 0).r
          + texelFetch(iChannel0, ip + ivec2(0, 1), 0).r + texelFetch(iChannel0, ip - ivec2(0, 1), 0).r;
float next = (0.5 * sum - c.g) * 0.995;          // 2c − 이전 + ½·라플라시안 = ½·이웃합 − 이전, 감쇠 포함
if (uMouse.z > 0.0 && distance(gl_FragCoord.xy, uMouse.xy) < 6.0) next = 1.0;
fragColor = vec4(next, c.r, 0.0, 1.0);`},
      {id:"mouseBrush", title:"마우스 브러시", desc:"누르는 동안 포인터 주변이 1, 가장자리가 부드러운 마스크 (uMouse는 vec4로 선언)", scope:"main", code:`float brush = uMouse.z > 0.0 ? 1.0 - smoothstep(4.0, 12.0, distance(gl_FragCoord.xy, uMouse.xy)) : 0.0;`},
      {id:"mrtOut", title:"MRT 출력 선언", desc:"Buffer의 Out을 2 이상으로 했을 때. 기존 `out vec4 fragColor;` 줄은 지우세요(출력이 여럿이면 모두 location이 필요)", code:`layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outData;`},
      {id:"initGuard", title:"첫 프레임 초기화", desc:"시뮬레이션 시작 상태를 한 번만 쓰기 (Reset 시 다시 실행)", scope:"main", code:`if (uFrame == 0) {
    fragColor = vec4(0.0);   // 초기 상태
    return;
}`}]}
  ];
  const ALL = CATEGORIES.flatMap(category => category.items.map(item => ({...item, category:category.id})));
  const byId = new Map(ALL.map(item => [item.id, item]));
  // 조각이 정의하는 전역 함수 이름 목록 (중복 정의 방지·의존성 판단에 사용).
  const definedNames = code => [...code.matchAll(/^\s*(?:(?:highp|mediump|lowp)\s+)?(?:float|int|uint|bool|void|[biu]?vec[234]|mat[234](?:x[234])?)\s+([A-Za-z_]\w*)\s*\(/gm)].map(match => match[1]);
  // 삽입 계획: 필요한 조각을 의존 순서대로 모으되, 이미 소스에 정의된 함수는 건너뛴다.
  const plan = (id, source = "") => {
    const has = name => new RegExp(`(?:^|[^\\w.])(?:[biu]?vec[234]|mat[234]|float|int|uint|bool|void)\\s+${name}\\s*\\(`).test(source);
    const order = [], seen = new Set();
    const visit = key => {
      if(seen.has(key)) return; seen.add(key); const item = byId.get(key); if(!item) return;
      for(const dep of item.requires || []) visit(dep);
      order.push(item);
    };
    visit(id);
    const target = byId.get(id), skipped = [], included = [];
    for(const item of order) {
      const names = definedNames(item.code);
      if(names.length && names.every(has)) { if(item !== target) skipped.push(item.title); continue; }
      included.push(item);
    }
    const globals = included.filter(item => item !== target || (target.scope || "global") === "global");
    return {target, globals, mainCode:(target.scope === "main") ? target.code : null,
      alreadyDefined:!!(definedNames(target.code).length && definedNames(target.code).every(has)), skipped,
      added:included.filter(item => item !== target).map(item => item.title)};
  };
  return {CATEGORIES,ALL,plan,definedNames};
})();
const course=(()=>{
// 입문 과정: C와 GLSL 문법은 알지만 셰이더는 처음인 사람이 자기 프로젝트를 만들 때까지 따라가는 단계별 수업.
// 가이드(guide.js)가 이 데이터를 렌더링한다. 문단 안에서는 `코드`와 **강조**만 서식으로 해석한다.
// 블록 형식(guide.js의 기본 블록 외 추가분):
//   {heading}                         소제목
//   {compare:{c, glsl, cTitle?, glslTitle?}}   C 코드와 GLSL 코드를 나란히 비교
//   {code, title, start:true}         "이 코드로 시작" — 단일 패스 프로젝트로 불러온다(Undo 가능)
//   {try:[…]}                         직접 해보기 과제 목록
//   {solution, title?}                접힌 정답 코드(펼쳐서 보고 바로 불러올 수 있음)
//   {project:<PROJECTS 키>, label}    멀티 패스 프로젝트 불러오기 버튼
//   {progress:true}                   과정 진행률 표시

  const HEAD = `#version 300 es
precision highp float;
uniform vec2 uResolution;   // 화면 크기(픽셀)
uniform float uTime;        // 경과 시간(초)
out vec4 fragColor;         // 이 픽셀의 최종 색`;

  const SD = `float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}`;

  const HASH = `// 같은 입력 → 항상 같은 출력. 상태가 없는 '난수'.
float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}`;

  // ---------------------------------------------------------------- 1. 픽셀 하나의 관점
  const L1 = `${HEAD}

void main() {
    // gl_FragCoord.xy: 이 호출이 맡은 픽셀의 중심 좌표 (0.5, 0.5) ~ (W-0.5, H-0.5)
    // 원점은 '왼쪽 아래'입니다. C 이미지 배열(왼쪽 위)과 반대예요.
    vec2 uv = gl_FragCoord.xy / uResolution;   // 0~1로 정규화

    // 빨강 = x, 초록 = y. 화면 전체가 '좌표의 그래프'가 됩니다.
    fragColor = vec4(uv.x, uv.y, 0.0, 1.0);
}`;
  const L1_SOL = `${HEAD}

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;

    // 과제 3: 세로 줄무늬 10개 — floor로 '몇 번째 칸인지'(정수 인덱스)를 구하고
    // mod로 짝수/홀수를 가립니다. C의 (x / w) % 2 와 같은 생각입니다.
    float stripe = mod(floor(uv.x * 10.0), 2.0);

    // 과제 2: 왼쪽 절반만 빨갛게 — if 대신 step(가장자리, 값)을 써도 됩니다.
    float right = step(0.5, uv.x);

    vec3 color = vec3(stripe);
    color *= mix(vec3(1.0, 0.3, 0.3), vec3(1.0), right);
    fragColor = vec4(color, 1.0);
}`;

  // ---------------------------------------------------------------- 3. 좌표계
  const L3 = `${HEAD}
uniform vec2 uMouse;        // 포인터 픽셀 좌표(화면 밖이면 -1)

void main() {
    // 중심이 (0,0), 세로가 -1~1, 가로는 화면 비율만큼 넓어지는 좌표.
    // 거의 모든 셰이더가 이 한 줄로 시작합니다.
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    float px = 2.0 / uResolution.y;          // 이 좌표계에서 '픽셀 1개'의 크기
    float d = length(p) - 0.5;               // 원까지의 거리: 안쪽 < 0 < 바깥쪽

    // 경계를 픽셀 1개 폭으로 부드럽게 → 계단 현상(앨리어싱) 없음
    float inside = smoothstep(px, -px, d);

    vec3 bg = vec3(0.08, 0.09, 0.12);
    vec3 col = mix(bg, vec3(1.0, 0.6, 0.25), inside);
    fragColor = vec4(col, 1.0);
}`;
  const L3_SOL = `${HEAD}
uniform vec2 uMouse;

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec2 m = (2.0 * uMouse - uResolution) / uResolution.y;  // 마우스도 같은 좌표계로
    float px = 2.0 / uResolution.y;

    // 과제 1: 마우스를 따라다니는 원 — 점을 옮기는 대신 '좌표를 빼서' 원점을 옮깁니다.
    float dMouse = length(p - m) - 0.2;
    // 과제 2: 고리 — 거리의 절댓값에서 두께를 빼면 경계선만 남습니다.
    float dRing = abs(length(p) - 0.6) - 0.03;

    vec3 col = vec3(0.08, 0.09, 0.12);
    col = mix(col, vec3(0.3, 0.7, 1.0), smoothstep(px, -px, dRing));
    col = mix(col, vec3(1.0, 0.6, 0.25), smoothstep(px, -px, dMouse));
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 4. SDF
  const L4 = `${HEAD}

${SD}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    // 도형을 '움직이는' 대신 질의 좌표를 반대로 옮깁니다: sd(p - 위치)
    float circle = sdCircle(p - vec2(-0.35, 0.0), 0.4);
    float box    = sdBox(p - vec2(0.35, 0.0), vec2(0.3, 0.25));

    float d = min(circle, box);              // 합집합 = 더 가까운 쪽

    // 디버그 시각화: 바깥 주황 / 안쪽 파랑, 등고선은 거리 0.05마다
    vec3 col = d > 0.0 ? vec3(0.95, 0.6, 0.3) : vec3(0.4, 0.7, 1.0);
    col *= 1.0 - exp(-5.0 * abs(d));
    col *= 0.8 + 0.2 * cos(125.0 * d);
    col = mix(col, vec3(1.0), 1.0 - smoothstep(0.0, 0.012, abs(d)));  // 경계선 d = 0
    fragColor = vec4(col, 1.0);
}`;
  const L4_SOL = `${HEAD}

${SD}
// 매끄러운 합집합: k 거리 안에서 두 도형이 녹아 붙습니다.
float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    float px = 2.0 / uResolution.y;

    float circle = sdCircle(p - vec2(-0.3 + 0.2 * sin(uTime), 0.0), 0.35);
    float box    = sdBox(p - vec2(0.3, 0.0), vec2(0.3, 0.25));
    float hole   = sdCircle(p - vec2(0.3, 0.0), 0.12);

    float d = smin(circle, box, 0.15);   // 과제 2: 매끄러운 합집합
    d = max(d, -hole);                   // 과제 1: 차집합 = max(A, -B)

    vec3 col = vec3(0.08, 0.09, 0.12);
    col = mix(col, vec3(0.4, 0.7, 1.0), smoothstep(px, -px, d));
    col = mix(col, vec3(1.0), smoothstep(px, -px, abs(d) - 0.004));  // 과제 3: 외곽선
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 5. 시간
  const ROT = `// 2D 회전 행렬. GLSL 행렬은 '열 우선(column-major)'으로 채워집니다.
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }`;
  const L5 = `${HEAD}

${SD}
${ROT}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    float px = 2.0 / uResolution.y;
    float t = uTime;

    // 애니메이션 = 시간의 '닫힌 식'. 지난 프레임의 위치를 기억하지 않습니다.
    vec2 center = 0.5 * vec2(cos(t), sin(t));           // 원 궤도
    vec2 q = rot(-t * 2.0) * (p - center);              // 질의 좌표를 반대로 회전 = 도형이 회전
    float pulse = 0.12 + 0.04 * sin(t * 6.0);           // 숨쉬는 크기

    float d = sdBox(q, vec2(pulse));

    vec3 col = vec3(0.08, 0.09, 0.12) + 0.05 * p.y;
    col = mix(col, vec3(1.0, 0.75, 0.3), smoothstep(px, -px, d));
    fragColor = vec4(col, 1.0);
}`;
  const L5_SOL = `${HEAD}

${SD}
${ROT}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    float px = 2.0 / uResolution.y;

    // 과제 2: 6개를 원 위에 — 각 도형까지의 거리 중 최솟값(합집합)을 루프로 구합니다.
    // 루프 상한은 상수로 두세요. 모든 픽셀이 6번씩 돕니다(비용 = 픽셀 수 × 6).
    float d = 1e9;
    for (int i = 0; i < 6; i++) {
        float a = uTime + float(i) * 6.2831853 / 6.0;   // int → float는 명시적으로
        vec2 q = p - 0.55 * vec2(cos(a), sin(a));
        d = min(d, sdBox(rot(uTime * 2.0 + float(i)) * q, vec2(0.09)));
    }
    // 과제 3: 이징 — fract로 0→1 반복, smoothstep으로 가감속
    float k = smoothstep(0.0, 1.0, fract(uTime * 0.5));
    d = min(d, sdCircle(p, 0.1 + 0.1 * k));

    vec3 col = vec3(0.08, 0.09, 0.12);
    col = mix(col, vec3(1.0, 0.75, 0.3), smoothstep(px, -px, d));
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 6. 반복 · 해시
  const L6 = `${HEAD}

${HASH}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    float cells = 8.0;
    vec2 g  = p * cells;
    vec2 id = floor(g);              // 몇 번째 칸인가  (C: i / N)
    vec2 f  = fract(g) - 0.5;        // 칸 안의 위치 -0.5~0.5 (C: i % N)
    float px = 2.0 * cells / uResolution.y;   // 칸 좌표에서 픽셀 1개

    float r = hash21(id);            // 칸마다 다르지만 매 프레임 같은 값
    float radius = 0.15 + 0.25 * r * (0.6 + 0.4 * sin(uTime * 2.0 + r * 6.28));
    float d = length(f) - radius;

    vec3 tint = 0.5 + 0.5 * cos(6.2831 * (r + vec3(0.0, 0.33, 0.67)));
    vec3 col = vec3(0.06, 0.07, 0.1);
    col = mix(col, tint, smoothstep(px, -px, d));
    fragColor = vec4(col, 1.0);
}`;
  const L6_SOL = `${HEAD}

${HASH}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    float cells = 8.0;
    vec2 g = p * cells, id = floor(g), f = fract(g) - 0.5;
    float px = 2.0 * cells / uResolution.y;
    float r = hash21(id);

    // 과제 1: 체커보드 — 인덱스 합의 짝/홀
    float checker = mod(id.x + id.y, 2.0);
    vec3 col = mix(vec3(0.06, 0.07, 0.1), vec3(0.1, 0.11, 0.15), checker);

    // 과제 2: 칸마다 다른 회전 / 과제 3: 절반의 칸은 비우기
    if (r > 0.5) {
        float d = sdBox(rot(uTime * (r - 0.5) * 8.0) * f, vec2(0.25));
        col = mix(col, vec3(1.0, 0.7, 0.3), smoothstep(px, -px, d));
    }
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 7. 색
  const PALETTE = `// 코사인 팔레트: t 하나(0~1)로 부드러운 색 띠를 만듭니다. a,b,c,d를 바꿔 분위기를 고르세요.
vec3 palette(float t) {
    vec3 a = vec3(0.5), b = vec3(0.5), c = vec3(1.0), d = vec3(0.0, 0.33, 0.67);
    return a + b * cos(6.2831853 * (c * t + d));
}`;
  const L7 = `${HEAD}

${PALETTE}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    // 레이어 1: 배경 그라디언트
    vec3 col = mix(vec3(0.02, 0.02, 0.05), vec3(0.08, 0.05, 0.15), p.y * 0.5 + 0.5);

    // 레이어 2: 빛나는 고리 — 거리에 반비례하는 밝기를 '더하기'(가산 합성)
    float d = abs(length(p) - 0.55);
    vec3 glow = palette(atan(p.y, p.x) / 6.2831853 + uTime * 0.1);
    col += glow * 0.012 / max(d, 0.002);

    // 레이어 3: 가운데 원판 — 위에 '덮어 그리기'(mix = 알파 합성)
    float disc = smoothstep(0.32, 0.3, length(p));
    col = mix(col, palette(uTime * 0.2) * 0.9, disc);

    // 마무리: 가장자리를 어둡게(비네트), 1을 넘은 값은 부드럽게 눌러주기(톤 매핑)
    col *= 1.0 - 0.35 * dot(p * 0.6, p * 0.6);
    col = 1.0 - exp(-col * 1.4);
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 8. 노이즈
  const NOISE = `${HASH}

// 값 노이즈: 정수 격자점마다 해시 값을 두고 사이를 부드럽게 보간합니다.
// 2D 배열을 bilinear로 읽는 것과 같은 구조예요(배열 대신 해시 함수).
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);          // smoothstep 보간 가중치
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// fbm: 주파수를 2배, 진폭을 1/2로 줄이며 노이즈를 겹칩니다(옥타브).
float fbm(vec2 p) {
    float sum = 0.0, amp = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);        // 옥타브마다 회전+확대 → 격자 무늬 숨김
    for (int i = 0; i < 5; i++) {
        sum += amp * noise(p);
        p = m * p;
        amp *= 0.5;
    }
    return sum;
}`;
  const L8 = `${HEAD}

${NOISE}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    float n = fbm(p * 2.5 + vec2(uTime * 0.15, 0.0));

    vec3 sky   = vec3(0.12, 0.28, 0.55);
    vec3 cloud = vec3(0.95, 0.96, 1.0);
    vec3 col = mix(sky, cloud, smoothstep(0.35, 0.75, n));
    fragColor = vec4(col, 1.0);
}`;
  const L8_SOL = `${HEAD}

${NOISE}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y * 2.0;
    float t = uTime * 0.1;

    // 과제 3: 도메인 워핑 — 노이즈 값으로 좌표 자체를 비틉니다.
    vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
    float n = fbm(p + 2.0 * q);

    // 과제 2: 능선 노이즈 — 0.5 근처를 날카로운 선으로
    float ridge = 1.0 - abs(n * 2.0 - 1.0);

    vec3 col = mix(vec3(0.05, 0.02, 0.1), vec3(0.9, 0.4, 0.2), n);
    col += vec3(1.0, 0.8, 0.5) * pow(ridge, 8.0);
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 9. 파라미터
  const L9 = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;

// 주석의 @태그가 파라미터 탭에 슬라이더·색상 선택기를 만듭니다.
uniform float uCells;  // @range 2 24 @step 1 @default 8
uniform float uSpeed;  // @range 0 4 @default 1
uniform float uFill;   // @range 0 1 @default 0.6
uniform vec3  uTint;   // @color @default 1.0 0.6 0.25
uniform vec3  uBack;   // @color @default 0.06 0.07 0.1
out vec4 fragColor;

${HASH}

void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec2 g = p * uCells, id = floor(g), f = fract(g) - 0.5;
    float px = 2.0 * uCells / uResolution.y;

    float r = hash21(id);
    float radius = 0.45 * uFill * (0.7 + 0.3 * sin(uTime * uSpeed * 2.0 + r * 6.28));
    float d = length(f) - radius;

    vec3 col = mix(uBack, uTint * (0.6 + 0.4 * r), smoothstep(px, -px, d));
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 10. 버퍼: 생명 게임
  const LIFE_A = `#version 300 es
precision highp float;
// Buffer A: 생명 게임의 '현재 세대'를 저장하는 2D 배열.
// iChannel0 = A · previous (직전 프레임의 자기 자신) → 더블 버퍼링
uniform vec2 uResolution;      // 이 버퍼의 크기(셀 수)
uniform int uFrame;            // 0이면 초기화
uniform vec4 uMouse;           // xy = 포인터(이 버퍼 좌표), z > 0 = 누르는 중
uniform sampler2D iChannel0;
out vec4 fragColor;            // r = 살아 있음(0/1), g = 나이

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// 배열 읽기: texelFetch는 정수 인덱스로 정확히 한 칸을 읽습니다(보간 없음).
// 가장자리는 % 로 감싸 토러스(위아래·좌우가 이어진 판)로 만듭니다.
int alive(ivec2 c) {
    ivec2 size = ivec2(uResolution);
    c = (c + size) % size;
    return texelFetch(iChannel0, c, 0).r > 0.5 ? 1 : 0;
}

void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);

    if (uFrame == 0) {                               // 첫 프레임: 무작위로 30% 채우기
        fragColor = vec4(step(0.7, hash12(gl_FragCoord.xy)), 0.0, 0.0, 1.0);
        return;
    }

    int n = 0;                                       // 이웃 8칸 세기
    for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++)
            if (x != 0 || y != 0) n += alive(c + ivec2(x, y));

    int self = alive(c);
    int next = (n == 3 || (self == 1 && n == 2)) ? 1 : 0;   // B3/S23 규칙

    if (uMouse.z > 0.0 && distance(gl_FragCoord.xy, uMouse.xy) < 4.0) next = 1;  // 그려서 살리기

    float age = texelFetch(iChannel0, c, 0).g;
    fragColor = vec4(float(next), next == 1 ? min(age + 0.01, 1.0) : 0.0, 0.0, 1.0);
}`;
  const LIFE_IMAGE = `#version 300 es
precision highp float;
// Image: Buffer A의 내용을 화면에 그립니다. 시뮬레이션 로직은 없습니다(표시 전용).
uniform vec2 uResolution;
uniform sampler2D iChannel0;   // A · current (이번 프레임에 계산된 세대)
out vec4 fragColor;

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec4 cell = texture(iChannel0, uv);          // A는 Filter = Nearest라 칸이 또렷합니다

    vec3 dead  = vec3(0.04, 0.05, 0.08);
    vec3 young = vec3(1.0, 0.85, 0.4);
    vec3 old   = vec3(0.3, 0.6, 1.0);
    vec3 col = cell.r > 0.5 ? mix(young, old, cell.g) : dead;
    fragColor = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- 12. 나만의 프로젝트 템플릿
  const TEMPLATE = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
uniform float uSpeed;   // @range 0 3 @default 1
uniform vec3  uColorA;  // @color @default 0.06 0.07 0.12
uniform vec3  uColorB;  // @color @default 1.0 0.55 0.3
out vec4 fragColor;

// ── 1. 도구 상자: 쓰지 않는 함수는 지워도 됩니다 ───────────────
${HASH}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

// ── 2. 장면: 좌표 p와 시간 t를 받아 '거리 하나'를 돌려줍니다 ──────
float scene(vec2 p, float t) {
    // TODO: 도형을 만들고 min / max / smin으로 합치세요.
    float body = sdCircle(p, 0.35 + 0.03 * sin(t * 3.0));
    float arm  = sdBox(rot(t) * p, vec2(0.65, 0.05));
    return smin(body, arm, 0.1);
}

void main() {
    // ── 3. 좌표 ────────────────────────────────────────────
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    float px = 2.0 / uResolution.y;
    float t = uTime * uSpeed;

    // ── 4. 형태 ────────────────────────────────────────────
    float d = scene(p, t);

    // ── 5. 색: 배경 → 채우기 → 외곽 빛 순서로 레이어를 쌓습니다 ─────
    vec3 col = mix(uColorA, uColorA * 1.8, p.y * 0.5 + 0.5);
    col = mix(col, uColorB, smoothstep(px, -px, d));
    col += uColorB * 0.004 / max(abs(d), 0.004);
    fragColor = vec4(col, 1.0);
}`;

  // 멀티 패스 프로젝트: studio.loadExample에 그대로 넘긴다.
  const PROJECTS = {
    life:{image:LIFE_IMAGE, passes:[{name:"A", fragment:LIFE_A, format:"rgba8", scale:0.25, filter:"nearest", wrap:"repeat", channels:{0:{buffer:"A", frame:"previous"}}}],
      imageChannels:{0:{buffer:"A", frame:"current"}}}
  };

  const LESSONS = [
    {id:"course", course:true, title:"입문 과정 안내", summary:"C 개발자를 위한 셰이더 입문 · 12단계", blocks:[
      {p:"이 과정은 **C와 GLSL 문법은 알지만 셰이더는 처음**인 분을 위해 만들었습니다. 컴퓨터 구조와 자료구조 감각을 그대로 활용해서, 마지막 단계에서 **나만의 프로젝트**를 만드는 것이 목표입니다."},
      {progress:true},
      {heading:"가장 먼저 바꿔야 할 생각 하나"},
      {p:"CPU 코드는 \"이미지를 만드는 프로그램\"을 씁니다. 프래그먼트 셰이더는 \"**픽셀 하나의 색을 계산하는 순수 함수**\"를 씁니다. 루프, 스레드 분배, 메모리 쓰기는 GPU가 대신합니다."},
      {table:{head:["이미 아는 것","셰이더에서는"], rows:[
        ["이중 for 루프로 픽셀 채우기","루프 **본문**만 작성(`main`). GPU가 모든 픽셀에 동시에 실행"],
        ["SIMD · 스레드 병렬","수천 개 호출이 묶음(warp)으로 같은 명령을 실행. 분기가 갈리면 양쪽 모두 실행 비용"],
        ["전역 변수 (읽기 전용)","`uniform` — CPU가 프레임마다 넣는 상수(시간·해상도·마우스)"],
        ["출력 배열 `out[y][x] = …`","`fragColor` 하나. **자기 픽셀에만** 쓸 수 있음(gather O, scatter X)"],
        ["2D 배열 읽기","텍스처 — `texelFetch`(정수 인덱스) 또는 `texture`(0~1 좌표 + 하드웨어 보간)"],
        ["static 변수 · 프레임 간 상태","없음. 상태는 **버퍼(텍스처)에 써서** 다음 프레임에 읽음 = 더블 버퍼링"],
        ["printf 디버깅","값을 **색으로** 출력해서 눈으로 확인"]]}},
      {heading:"과정 구성"},
      {steps:[
        "**기초 감각** — 1 픽셀 하나의 관점 · 2 C와 다른 점 · 3 좌표계 만들기",
        "**그리기** — 4 도형은 거리 함수 · 5 시간과 움직임 · 6 반복·타일·해시 · 7 색과 합성",
        "**표현력** — 8 노이즈 · 9 파라미터로 다듬기",
        "**상태와 실전** — 10 버퍼와 상태(생명 게임) · 11 디버깅·성능 감각 · 12 나만의 프로젝트"]},
      {heading:"각 단계 사용법"},
      {list:["**이 코드로 시작**을 누르면 현재 작업이 그 단계의 예제로 바뀝니다. 걱정 마세요 — 편집기에서 `Ctrl+Z`로 언제든 되돌릴 수 있습니다.",
        "가이드는 닫혀도 위치를 기억합니다. `?` 키(또는 툴바의 ? 버튼)로 같은 단계로 돌아오세요.",
        "**직접 해보기** 과제를 먼저 시도하고, 막히면 **정답 보기**를 펼치세요.",
        "끝난 단계는 **완료로 표시**하면 목록에 ✓가 붙습니다."]},
      {actions:[{label:"1단계 시작하기 →", run:"topic:c1"}]}]},

    {id:"c1", course:true, step:1, title:"픽셀 하나의 관점", summary:"루프 본문만 쓰는 프로그래밍", blocks:[
      {p:"C로 그라디언트 이미지를 만든다면 이중 루프를 돌며 배열에 씁니다. 셰이더는 **그 루프의 본문만** 작성합니다. GPU가 화면의 모든 픽셀에 대해 `main()`을 병렬로 호출하고, 각 호출은 `gl_FragCoord`로 \"내가 몇 번째 픽셀인지\"를 압니다."},
      {compare:{cTitle:"C · CPU가 루프를 돈다", c:`for (int y = 0; y < H; y++)
  for (int x = 0; x < W; x++)
    img[y][x] = shade(x, y);`,
        glslTitle:"GLSL · 본문만 쓴다", glsl:`void main() {
  vec2 xy = gl_FragCoord.xy;  // 이번 픽셀
  fragColor = shade(xy);      // img[y][x] = …
}`}},
      {list:["`main()`은 **입력 → 색**인 순수 함수입니다. 다른 픽셀의 결과를 읽을 수도, 다른 픽셀에 쓸 수도 없습니다.",
        "그래서 **실행 순서가 없습니다.** 어떤 픽셀이 먼저 계산되든 결과가 같아야 하고, 그 덕분에 수천 개를 동시에 돌릴 수 있습니다.",
        "`gl_FragCoord.xy`는 픽셀 **중심**(x+0.5, y+0.5)이고 원점은 **왼쪽 아래**입니다.",
        "색은 0~1 실수입니다. `vec4(r, g, b, a)` — 255가 아니라 1.0이 최대입니다."]},
      {code:L1, title:"1단계 예제 · 좌표를 색으로", start:true},
      {p:"화면 왼쪽 아래가 검정(0,0), 오른쪽이 빨강(x=1), 위쪽이 초록(y=1)입니다. 즉 지금 화면은 **좌표 그 자체의 그래프**예요. 셰이더 디버깅의 기본이 이것입니다."},
      {try:["빨강만 남기고 가로 방향 그라디언트로 바꿔 보세요.",
        "화면 왼쪽 절반만 빨갛게 칠해 보세요. `if`로 해도 되고 `step(0.5, uv.x)`를 써도 됩니다.",
        "흑백 세로 줄무늬 10개를 만들어 보세요. 힌트: `floor`로 칸 번호, `mod`로 짝/홀."]},
      {solution:L1_SOL}]},

    {id:"c2", course:true, step:2, title:"C와 다른 점", summary:"포인터·재귀·형변환 없이 쓰는 법", blocks:[
      {p:"GLSL은 C처럼 생겼지만 GPU에 맞춘 제약이 있습니다. 컴파일 오류의 대부분이 여기서 나오니 한 번 훑어 두세요."},
      {table:{head:["C 습관","GLSL에서는"], rows:[
        ["`float x = 1;`","**암묵 형변환 없음** → `1.0`, `float(i)`, `int(f)`처럼 명시"],
        ["포인터 · `malloc`","없음. 값 전달 + `out`/`inout` 매개변수로 결과 돌려받기"],
        ["재귀 함수","금지. 반복문(스택 없이)으로 바꾸기"],
        ["가변 길이 배열","배열 크기는 컴파일 타임 상수. 큰 데이터는 텍스처로"],
        ["`a % b` (실수)","`%`는 정수 전용. 실수는 `mod(a, b)` — 음수에서 C의 `fmod`와 결과가 다름(`mod(-1.0, 3.0)` = 2.0)"],
        ["구조체로 xyz 묶기","`vec2/3/4` + 스위즐: `v.xy`, `v.zyx`, `v.rgb`, `vec3(v.xy, 1.0)`"],
        ["`a * b` (벡터)","**성분별 곱**. 내적은 `dot`, 외적은 `cross`, 행렬곱은 `m * v`"],
        ["행렬 초기화 순서","열 우선(column-major): `mat2(a, b, c, d)`는 열 (a,b), (c,d)"],
        ["`printf`","없음. 값을 색으로 출력해 확인(11단계)"],
        ["`while (!done)`","루프 상한은 상수로 두고 `break`로 빠져나오기. 무한 루프는 GPU 타임아웃"]]}},
      {compare:{cTitle:"C · 포인터로 두 값 반환", c:`void polar(float x, float y,
           float *r, float *a) {
  *r = sqrtf(x*x + y*y);
  *a = atan2f(y, x);
}`,
        glslTitle:"GLSL · out 매개변수", glsl:`void polar(vec2 p,
           out float r, out float a) {
  r = length(p);
  a = atan(p.y, p.x);  // atan2 아님
}`}},
      {heading:"분기와 성능"},
      {p:"GPU는 수십 개 픽셀을 한 묶음으로 **같은 명령을 동시에** 실행합니다. 묶음 안에서 `if`가 갈리면 양쪽 경로를 모두 실행하고 결과만 고릅니다(분기 발산). 그래서 셰이더 코드는 `if` 대신 수학 함수를 즐겨 씁니다."},
      {table:{head:["함수","의미 · C로 쓰면"], rows:[
        ["step(e, x)","`x < e ? 0.0 : 1.0`"],
        ["smoothstep(a, b, x)","a~b 사이에서 0→1로 부드럽게(경계 흐리기·안티앨리어싱)"],
        ["mix(a, b, t)","`a + (b - a) * t` — 선형 보간, t가 0/1이면 선택(select)"],
        ["clamp(x, lo, hi)","`min(max(x, lo), hi)`"],
        ["fract(x) · floor(x)","소수부 · 정수부 — 반복 무늬의 핵심(6단계)"]]}},
      {note:"작은 `if`는 컴파일러가 알아서 select로 바꾸므로 너무 걱정하지 마세요. 비용이 커지는 건 **양쪽 경로가 모두 무거운** 경우입니다."},
      {p:"전체 내장 함수 목록은 **GLSL 내장 함수** 레퍼런스에 범주별로 정리되어 있고, 함수마다 C 대응과 예시 한 줄이 있습니다."},
      {actions:[{label:"GLSL 내장 함수 레퍼런스", run:"topic:builtins"}, {label:"다음: 3단계 좌표계 만들기 →", run:"topic:c3"}]}]},

    {id:"c3", course:true, step:3, title:"좌표계 만들기", summary:"중심 원점 · 화면 비율 · 안티앨리어싱", blocks:[
      {p:"0~1 좌표는 화면이 가로로 길면 원이 타원이 됩니다. 그래서 거의 모든 셰이더가 **중심이 (0,0)이고 세로가 -1~1**인 좌표로 시작합니다. 가로 범위는 화면 비율에 따라 늘어납니다."},
      {code:`vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;`, title:"이 한 줄을 외워 두세요", insert:"cursor"},
      {p:"원은 \"중심까지 거리가 r 이하인 점의 집합\"입니다. `length(p) - r`은 바깥에서 양수, 안에서 음수, 경계에서 0이 됩니다. 이 **부호 있는 거리**가 다음 단계의 핵심입니다."},
      {list:["`d < 0.0 ? 1.0 : 0.0`로 칠하면 경계가 계단처럼 깨집니다(앨리어싱).",
        "`smoothstep(px, -px, d)`는 경계 주변 **픽셀 1개 폭**만 부드럽게 섞어 매끈하게 만듭니다. `px`는 이 좌표계에서 픽셀 하나의 크기인 `2.0 / uResolution.y`입니다."]},
      {code:L3, title:"3단계 예제 · 중심 좌표와 원", start:true},
      {try:["원이 **마우스를 따라다니게** 해 보세요. `uMouse`도 픽셀 좌표이니 같은 공식으로 바꾼 뒤 `length(p - m)`.",
        "속이 빈 **고리**를 그려 보세요. 힌트: `abs(length(p) - 0.6) - 두께`.",
        "창 크기를 바꿔도 원이 찌그러지지 않는지 확인해 보세요."]},
      {solution:L3_SOL}]},

    {id:"c4", course:true, step:4, title:"도형은 거리 함수", summary:"SDF · 합집합/교집합/차집합", blocks:[
      {p:"셰이더에서 도형은 **좌표 → 경계까지의 부호 있는 거리**를 돌려주는 함수(SDF, Signed Distance Function)입니다. 도형을 \"그리는\" 대신 \"이 점이 도형에서 얼마나 떨어져 있는가\"를 묻습니다."},
      {table:{head:["연산","거리 함수로","집합으로"], rows:[
        ["합치기","`min(a, b)`","A ∪ B"],
        ["겹친 부분","`max(a, b)`","A ∩ B"],
        ["빼기","`max(a, -b)`","A − B"],
        ["녹여 붙이기","`smin(a, b, k)`","경계가 매끄러운 합집합"],
        ["외곽선","`abs(d) - w`","두께 w의 테두리"],
        ["둥글게","`d - r`","모서리를 r만큼 둥글게"]]}},
      {p:"도형을 옮기거나 돌릴 때는 **도형이 아니라 질의 좌표를 반대로 변환**합니다. `sdCircle(p - c, r)`은 c로 옮긴 원입니다. 행렬로 생각하면 도형에 M을 적용하는 대신 점에 M⁻¹을 적용하는 것과 같습니다."},
      {code:L4, title:"4단계 예제 · 거리장 시각화", start:true},
      {p:"예제는 거리 값을 **등고선**으로 보여줍니다. 흰 선이 d = 0(경계), 주황이 바깥, 파랑이 안쪽입니다. 도형을 만들다 결과가 이상하면 이렇게 거리장을 직접 보는 것이 가장 빠른 디버깅입니다."},
      {try:["상자에서 작은 원을 **빼서** 구멍을 뚫어 보세요.",
        "`min` 대신 `smin`(정답 코드 참고)으로 원과 상자를 녹여 붙이고, 원을 `sin(uTime)`으로 좌우로 움직여 보세요.",
        "흰 **외곽선만** 남겨 보세요."]},
      {solution:L4_SOL},
      {note:"원·상자 말고도 선분, 삼각형, 별, 하트 등 많은 2D SDF가 알려져 있습니다. **코드 조각 모음**의 SDF 범주에서 바로 삽입할 수 있습니다."},
      {actions:[{label:"코드 조각 모음 열기", run:"topic:snippets"}]}]},

    {id:"c5", course:true, step:5, title:"시간과 움직임", summary:"uTime · 회전 행렬 · 이징", blocks:[
      {p:"게임 루프라면 `pos += vel * dt`처럼 매 프레임 상태를 갱신합니다. 셰이더에는 프레임 사이에 남는 변수가 없으므로, 움직임을 **시간의 닫힌 식** `pos = f(t)`으로 씁니다. 몇 초로 건너뛰어도 같은 화면이 나오는 결정적인 애니메이션입니다."},
      {compare:{cTitle:"C · 상태를 적분", c:`// 매 프레임
angle += speed * dt;
x = cx + r * cosf(angle);`,
        glslTitle:"GLSL · 시간의 함수", glsl:`// 상태 없음
float angle = speed * uTime;
float x = cx + r * cos(angle);`}},
      {table:{head:["재료","효과"], rows:[
        ["sin(t), cos(t)","-1~1 왕복. `0.5 + 0.5 * sin(t)`로 0~1"],
        ["fract(t)","0→1을 반복하는 톱니. 루프 애니메이션"],
        ["smoothstep(0, 1, fract(t))","가속-감속(이징)이 들어간 반복"],
        ["rot(a) * p","좌표를 회전 → 도형이 반대로 회전"]]}},
      {code:L5, title:"5단계 예제 · 궤도를 도는 상자", start:true},
      {try:["회전 속도와 궤도 반지름을 바꿔 보세요.",
        "`for` 루프로 상자 **6개**를 원 위에 배치하세요. 각 도형 거리의 `min`을 누적하면 됩니다.",
        "`fract`와 `smoothstep`으로 1초마다 커졌다 줄어드는 원을 더해 보세요."]},
      {solution:L5_SOL},
      {note:"루프는 **모든 픽셀이** 돕니다. 1920×1080 화면에서 6회 루프는 프레임당 약 1,200만 번 계산입니다. GPU에겐 가볍지만, 루프 안에 루프를 넣을 때는 이 곱셈을 떠올리세요."}]},

    {id:"c6", course:true, step:6, title:"반복 · 타일 · 해시", summary:"fract로 무한 반복 · 칸마다 다른 난수", blocks:[
      {p:"좌표에 N을 곱하고 `fract`를 취하면 화면이 N×N 칸으로 쪼개지고, 모든 칸이 같은 지역 좌표를 받습니다. 도형 하나를 그리는 코드로 **무한히 많은** 도형을 그리는 기법입니다(도메인 반복)."},
      {compare:{cTitle:"C · 정수 인덱스", c:`int cell  = i / N;   // 몇 번째 칸
int local = i % N;   // 칸 안 위치`,
        glslTitle:"GLSL · 실수 좌표", glsl:`vec2 id = floor(p * N);       // 칸 번호
vec2 f  = fract(p * N) - 0.5; // -0.5~0.5`}},
      {p:"칸마다 다르게 하려면 난수가 필요합니다. 하지만 `rand()`는 **숨은 상태**(시드)를 바꾸는 함수라 수천 개가 동시에 호출하는 셰이더에서는 쓸 수 없습니다. 대신 **해시 함수** — 같은 입력에 항상 같은 값을 주는 순수 함수 — 에 칸 번호를 넣습니다. 해시 테이블의 해시와 같은 개념이에요."},
      {code:L6, title:"6단계 예제 · 칸마다 다른 원", start:true},
      {try:["칸 번호로 **체커보드** 배경을 깔아 보세요: `mod(id.x + id.y, 2.0)`.",
        "칸마다 다른 속도로 **회전하는 상자**로 바꿔 보세요.",
        "해시 값이 0.5보다 작은 칸은 **비워** 보세요."]},
      {solution:L6_SOL},
      {note:"이웃 칸의 도형이 경계를 넘어오면 잘려 보입니다. 도형을 칸 안(반지름 0.5 미만)에 두거나, 주변 3×3 칸을 루프로 함께 검사하면 해결됩니다."}]},

    {id:"c7", course:true, step:7, title:"색과 합성", summary:"팔레트 · 레이어 · 빛 번짐", blocks:[
      {p:"색은 0~1 실수 벡터라서 일반 산술이 그대로 됩니다. 장면은 **뒤에서 앞으로 레이어를 쌓는**(화가 알고리즘) 방식으로 칠합니다."},
      {table:{head:["합성","코드","느낌"], rows:[
        ["덮기(알파)","`col = mix(col, layer, alpha)`","불투명한 물체"],
        ["더하기","`col += light`","빛·발광·불꽃"],
        ["곱하기","`col *= shade`","그림자·비네트"],
        ["빛 번짐","`col += c * k / abs(d)`","네온·글로우"],
        ["톤 매핑","`col = 1.0 - exp(-col)`","1을 넘은 값을 부드럽게 압축"]]}},
      {code:PALETTE, title:"코사인 팔레트 (어디서나 쓰는 한 줄 색 생성기)", insert:"cursor"},
      {code:L7, title:"7단계 예제 · 네온 고리", start:true},
      {try:["팔레트의 `d` 값을 `vec3(0.8, 0.9, 0.3)`처럼 바꿔 다른 분위기를 찾아보세요.",
        "고리를 하나 더 겹치되 **다른 반지름·다른 팔레트 위상**으로 더해 보세요.",
        "마지막 톤 매핑 줄을 지웠다 다시 넣어 차이를 비교해 보세요(밝은 곳이 하얗게 날아갑니다)."]}]},

    {id:"c8", course:true, step:8, title:"노이즈", summary:"자연스러운 무작위 · fbm · 도메인 워핑", blocks:[
      {p:"해시는 칸마다 값이 튀어서 자연물처럼 보이지 않습니다. **값 노이즈**는 정수 격자점에만 해시 값을 두고 그 사이를 부드럽게 보간합니다. 2D 배열을 bilinear로 읽는 것과 같은 구조인데, 배열 대신 해시 함수를 씁니다. 메모리가 0바이트인 무한한 격자죠."},
      {list:["**fbm**(fractional Brownian motion): 주파수 2배·진폭 1/2로 노이즈를 몇 겹(옥타브) 쌓습니다. 큰 덩어리 위에 작은 디테일이 얹힌 구름·지형이 됩니다.",
        "**도메인 워핑**: 노이즈 값으로 좌표를 비튼 다음 다시 노이즈를 읽습니다. 연기·마블·오로라 같은 흐름이 생깁니다.",
        "옥타브 수만큼 비용이 늘어납니다. 5옥타브 × 워핑 3회 = 픽셀마다 노이즈 15번."]},
      {code:L8, title:"8단계 예제 · 흐르는 구름", start:true},
      {try:["fbm 루프 횟수를 1, 3, 8로 바꿔 디테일 변화를 보세요.",
        "**능선 노이즈** `1.0 - abs(n * 2.0 - 1.0)`로 산맥·번개 같은 선을 만들어 보세요.",
        "**도메인 워핑** `fbm(p + 2.0 * vec2(fbm(p), fbm(p + 5.2)))`을 시도해 보세요."]},
      {solution:L8_SOL},
      {actions:[{label:"갤러리의 Aurora Flow(도메인 워핑) 열기", run:"example:aurora"}]}]},

    {id:"c9", course:true, step:9, title:"파라미터로 다듬기", summary:"@range · @color 어노테이션", blocks:[
      {p:"숫자를 바꿀 때마다 코드를 고치는 대신, 조절할 값을 **uniform으로 빼고 주석에 범위를 적으면** 파라미터 탭에 슬라이더가 생깁니다. 프로그램의 설정 구조체나 명령줄 옵션을 노출하는 것과 같아요."},
      {code:`uniform float uSpeed;  // @range 0 4 @default 1
uniform vec3  uTint;   // @color @default 1.0 0.6 0.25`, title:"선언 + 주석 = 슬라이더", insert:"cursor"},
      {list:["컴파일에 성공하면 자동으로 등록됩니다. 값을 바꾸면 **다시 컴파일하지 않고** 즉시 반영됩니다.",
        "`@color`는 vec3/vec4를 색상 선택기로 보여줍니다.",
        "등록된 값은 브라우저에 저장되고 **전체 프로젝트 저장(Pack)**에도 포함됩니다."]},
      {code:L9, title:"9단계 예제 · 6단계 무늬를 파라미터로", start:true},
      {actions:[{label:"파라미터 탭 열기", run:"panel:uniforms"}]},
      {try:["파라미터 탭에서 슬라이더를 움직여 보세요. 코드가 다시 실행되지 않고도 바뀝니다.",
        "`uRound`(0~0.5) 같은 파라미터를 직접 추가해 원과 상자 사이를 오가게 해 보세요.",
        "마음에 드는 값 조합을 찾으면 `@default`에 적어 두세요. 다른 컴퓨터에서도 같은 출발점이 됩니다."]}]},

    {id:"c10", course:true, step:10, title:"버퍼와 상태", summary:"더블 버퍼링 · 생명 게임", blocks:[
      {p:"지금까지의 셰이더는 순수 함수라서 **기억이 없습니다.** 시뮬레이션처럼 이전 상태가 필요하면 상태를 **텍스처(버퍼)에 저장**하고 다음 프레임에 그 텍스처를 읽습니다."},
      {compare:{cTitle:"C · 배열 두 개를 교대로", c:`static Cell a[H][W], b[H][W];
Cell (*cur)[W] = a, (*nxt)[W] = b;
for (;;) {               // 매 프레임
  step(cur, nxt);        // cur 읽고 nxt 쓰기
  swap(&cur, &nxt);      // 포인터 교환
}`,
        glslTitle:"FIELD Studio · Buffer A", glsl:`// 입력 채널: iChannel0 = A · previous
// → 직전 프레임에 A가 쓴 결과를 읽음
// 출력 fragColor → 이번 프레임의 A
// 교환(swap)은 렌더러가 자동으로 합니다.
vec4 old = texelFetch(iChannel0,
                      ivec2(gl_FragCoord.xy), 0);`}},
      {table:{head:["개념","FIELD Studio에서"], rows:[
        ["상태 배열","**Buffer** (A~H). 편집기 패스 탭 옆의 `+`로 추가"],
        ["이전 세대 읽기","입력 채널을 자기 자신의 **previous**로 연결"],
        ["다른 단계 결과 읽기","앞에서 실행된 버퍼의 **current**"],
        ["배열 인덱스로 읽기","`texelFetch(채널, ivec2(x, y), 0)` — 정수 좌표, 보간 없음"],
        ["초기화","`uFrame == 0`일 때 초기값 쓰기 (Reset 버튼으로 0으로)"],
        ["배열 크기","버퍼 설정의 크기(화면 비율 또는 고정 해상도), 정밀도는 형식(RGBA8 / 16F / 32F)"]]}},
      {p:"아래 프로젝트는 **콘웨이의 생명 게임**입니다. Buffer A가 셀 배열(화면의 1/4 해상도, Filter = Nearest, Wrap = Repeat)이고 Image는 그 배열을 색으로 보여주기만 합니다. 화면을 누른 채 끌면 셀을 살릴 수 있습니다."},
      {project:"life", label:"생명 게임 프로젝트 불러오기"},
      {list:["편집기 위쪽 패스 탭에서 **A**와 **Image**를 오가며 코드를 비교해 보세요.",
        "**↻ Reset**을 누르면 `uFrame`이 0이 되어 새 무작위 판으로 시작합니다.",
        "**성능 → 버퍼 뷰어**에서 A의 원본 값(r = 생존, g = 나이)을 직접 볼 수 있습니다."]},
      {try:["규칙을 **HighLife(B36/S23)**로 바꿔 보세요: 태어나는 조건에 `n == 6`을 추가.",
        "초기 밀도 `step(0.7, …)`를 0.5, 0.9로 바꿔 보세요.",
        "Buffer A의 **Size**를 12.5%로 낮추면 셀이 커지고, 100%로 올리면 아주 미세해집니다."]},
      {note:"버퍼 하나의 픽셀은 RGBA 4개 값을 담는 **구조체 배열**로 생각하세요. 4개로 부족하면 버퍼 설정의 출력 수(MRT)를 늘리거나 버퍼를 더 만듭니다."},
      {actions:[{label:"버퍼 · 멀티패스 레퍼런스", run:"topic:buffers"}, {label:"반응-확산 시뮬레이션 예제", run:"example:reaction"}]}]},

    {id:"c11", course:true, step:11, title:"디버깅 · 성능 감각", summary:"색으로 printf · 비용 모델", blocks:[
      {heading:"printf 대신 색으로 출력하기"},
      {list:["값 하나를 보고 싶으면 `fragColor = vec4(vec3(값), 1.0); return;`을 원하는 줄에 넣으세요. 그 아래 코드는 무시됩니다.",
        "0~1을 벗어난 값은 잘려 보입니다. 아래 함수로 음수는 빨강, 1 초과는 초록으로 표시하세요.",
        "**성능 → 버퍼 뷰어**에서 버퍼를 고르고 뷰포트에 포인터를 올리면 그 픽셀의 **실제 숫자**를 읽을 수 있습니다(디버거의 watch에 해당).",
        "컴파일 오류는 해당 줄에 빨간 띠로 표시됩니다. 오류가 있어도 화면은 마지막 성공 결과를 유지합니다."]},
      {code:`// 음수는 빨강, 0~1은 회색조, 1 초과는 초록
vec3 debugValue(float v) { return v < 0.0 ? vec3(-v, 0, 0) : v > 1.0 ? vec3(0, v - 1.0, 0) : vec3(v); }`, title:"값 시각화 함수", insert:"cursor"},
      {heading:"비용 모델"},
      {p:"셰이더 비용은 거의 **픽셀 수 × 픽셀당 연산**입니다. 1920×1080은 프레임당 약 200만 번 호출이고, 60fps라면 초당 1억 2천만 번입니다."},
      {table:{head:["무거워지는 원인","대처"], rows:[
        ["루프 안의 루프, 많은 옥타브","반복 횟수 줄이기, 조기 `break`"],
        ["텍스처 읽기 많음(블러 등)","작은 버퍼(Size 50%·25%)에서 처리 후 확대, 밉맵(`textureLod`)"],
        ["화면 전체 고해상도","렌더링 탭의 **해상도 배율**·**최대 픽셀 수**"],
        ["양쪽 다 무거운 분기","공통 부분을 분기 밖으로"]]}},
      {p:"**성능** 탭의 프레임 타임라인과 패스별 GPU 시간으로 어느 패스가 무거운지 확인하세요. 16.7ms를 넘으면 60fps를 못 냅니다."},
      {actions:[{label:"성능 탭 열기", run:"panel:profile"}, {label:"디버깅 레퍼런스", run:"topic:debug"}]}]},

    {id:"c12", course:true, step:12, title:"나만의 프로젝트", summary:"템플릿 · 작업 순서 · 아이디어", blocks:[
      {p:"이제 재료는 모두 갖췄습니다. 아래 템플릿은 지금까지 배운 함수와 **좌표 → 형태 → 색** 구조, 파라미터 3개가 들어 있는 출발점입니다. `scene()` 함수만 고쳐도 작품이 됩니다."},
      {code:TEMPLATE, title:"프로젝트 템플릿", start:true},
      {heading:"작업 순서"},
      {steps:["**한 문장으로 정하기** — \"녹아 붙는 용암 덩어리\", \"째깍거리는 시계\"처럼 결과를 먼저 말로.",
        "**형태부터** — 색은 흑백으로 두고 `scene()`의 거리 함수만 만듭니다. 막히면 4단계의 등고선 시각화를 붙이세요.",
        "**움직임** — `t`의 함수로 위치·회전·크기를 바꿉니다.",
        "**색과 빛** — 팔레트, 레이어, 글로우, 톤 매핑 순서로.",
        "**조절값 빼기** — 자꾸 고치는 숫자는 `@range` 파라미터로.",
        "**보관** — 편집기 도구의 **전체 프로젝트 저장(Pack)**으로 파일을 남기고, 툴바 카메라 아이콘으로 스크린샷."]},
      {heading:"아이디어와 필요한 단계"},
      {table:{head:["프로젝트","핵심 기법","단계"], rows:[
        ["아날로그 시계","상자 SDF + 회전 + 시간","4 · 5"],
        ["용암 램프","smin으로 녹는 원 + 노이즈 배경","4 · 5 · 8"],
        ["별이 흐르는 밤","타일 반복 + 해시 + 글로우","6 · 7"],
        ["만화경","극좌표 `atan`·`length` + 각도 접기","3 · 6"],
        ["물결 시뮬레이션","버퍼 2장 + 파동 방정식(RGBA16F)","10"],
        ["나만의 세포 자동자","생명 게임 규칙 바꾸기","10"]]}},
      {list:["**코드 조각 모음**에 SDF·노이즈·색 함수가 범주별로 정리되어 있습니다. 필요한 함수가 의존 함수와 함께 삽입됩니다.",
        "**예제 갤러리**의 작품 코드를 열어 이 과정에서 배운 기법이 어디에 쓰였는지 찾아보세요."]},
      {actions:[{label:"코드 조각 모음", run:"topic:snippets"}, {label:"예제 갤러리", run:"gallery"}, {label:"과정 안내로 돌아가기", run:"topic:course"}]}]}
  ];

  return {LESSONS,PROJECTS};
})();
const glsl_reference=(()=>{
// GLSL ES 3.00 내장 함수·변수 레퍼런스. 순수 데이터 모듈이며 가이드의 "GLSL 내장 함수" 주제가 사용한다.
// 항목: {name, sig, desc, c?, ex?}
//  - sig: 대표 시그니처. T는 float·vec2·vec3·vec4 중 하나(성분별로 적용), I는 int·ivec, U는 uint·uvec, B는 bool·bvec.
//  - c: C 표준 라이브러리로 쓰면 무엇인지(이미 C를 아는 사람을 위한 대응표).
//  - ex: 셰이더에서 자주 쓰는 짧은 예시(한두 줄, 여러 줄이면 \n). 모든 항목에 하나씩 둔다.
// WebGL2(GLSL ES 3.00)에 없는 함수(fma, bitfieldExtract, frexp 등)는 넣지 않는다.
  const CATEGORIES = [
    {id:"basic", title:"기본 수학", desc:"성분별(component-wise)로 동작합니다. vec3에 쓰면 x·y·z 각각에 적용돼요.", items:[
      {name:"abs", sig:"T abs(T x) · I abs(I x)", desc:"절댓값.", c:"fabsf / abs", ex:"float d = abs(p.x);   // 좌우 대칭"},
      {name:"sign", sig:"T sign(T x)", desc:"음수 −1, 0이면 0, 양수 1.", c:"(x > 0) − (x < 0)", ex:"float side = sign(p.x);"},
      {name:"floor", sig:"T floor(T x)", desc:"x 이하 최대 정수(실수형으로 반환). 칸 번호를 구할 때.", c:"floorf", ex:"vec2 cell = floor(uv * 8.0);"},
      {name:"ceil", sig:"T ceil(T x)", desc:"x 이상 최소 정수.", c:"ceilf", ex:"float rows = ceil(count / 8.0);   // 8개씩 담을 때 필요한 줄 수"},
      {name:"trunc", sig:"T trunc(T x)", desc:"0 방향으로 소수부 버림. 음수에서 floor와 다름(trunc(−1.5) = −1).", c:"truncf", ex:"float a = trunc(-1.5);   // -1.0 (floor(-1.5)는 -2.0)"},
      {name:"round", sig:"T round(T x)", desc:"가장 가까운 정수. 0.5의 처리 방향은 구현마다 다를 수 있음.", c:"roundf", ex:"p - s * round(p / s)   // 무한 반복"},
      {name:"roundEven", sig:"T roundEven(T x)", desc:"가장 가까운 정수, 0.5는 짝수 쪽으로(은행원 반올림).", c:"nearbyintf (기본 모드)", ex:"float r = roundEven(2.5);   // 2.0 · roundEven(3.5) = 4.0"},
      {name:"fract", sig:"T fract(T x)", desc:"x − floor(x). 항상 0 이상 1 미만 — 반복 무늬·톱니파의 핵심.", c:"x - floorf(x)", ex:"vec2 local = fract(uv * 8.0) - 0.5;"},
      {name:"mod", sig:"T mod(T x, T y) · T mod(T x, float y)", desc:"x − y·floor(x/y). 결과 부호가 y를 따름: mod(−1, 3) = 2. 정수는 % 연산자를 쓰세요.", c:"fmodf와 음수에서 다름", ex:"float a = mod(angle, 6.2831853);"},
      {name:"modf", sig:"T modf(T x, out T i)", desc:"정수부를 i에, 소수부를 반환. 둘 다 x와 같은 부호.", c:"modff", ex:"float whole;\nfloat part = modf(uTime, whole);   // whole = 정수 초, part = 0~1"},
      {name:"min", sig:"T min(T x, T y) · T min(T x, float y)", desc:"작은 값. SDF에서는 합집합.", c:"fminf", ex:"float d = min(dCircle, dBox);"},
      {name:"max", sig:"T max(T x, T y) · T max(T x, float y)", desc:"큰 값. SDF에서는 교집합, max(a, −b)는 차집합.", c:"fmaxf", ex:"float d = max(dBox, -dSphere);   // 상자에서 구를 파냄(차집합)"},
      {name:"clamp", sig:"T clamp(T x, T lo, T hi)", desc:"lo~hi 범위로 자르기.", c:"fminf(fmaxf(x, lo), hi)", ex:"float t = clamp(x, 0.0, 1.0);"},
      {name:"mix", sig:"T mix(T a, T b, T t) · T mix(T a, T b, B sel)", desc:"선형 보간 a + (b − a)·t. bool 버전은 성분별 선택(sel이 true면 b).", c:"a + (b - a) * t", ex:"vec3 col = mix(bg, fg, mask);"},
      {name:"step", sig:"T step(T edge, T x)", desc:"x < edge면 0, 아니면 1. 분기 없는 if.", c:"x < edge ? 0 : 1", ex:"float inside = step(d, 0.0);"},
      {name:"smoothstep", sig:"T smoothstep(T e0, T e1, T x)", desc:"e0~e1 사이에서 0→1로 부드럽게(3t² − 2t³). e0 > e1이면 반대 방향. 경계 안티앨리어싱에 사용.", c:"t = clamp((x-e0)/(e1-e0),0,1); t*t*(3-2*t)", ex:"float a = smoothstep(px, -px, d);"},
      {name:"isnan · isinf", sig:"B isnan(T x) · B isinf(T x)", desc:"NaN·무한대 검사. 0 나누기·음수 sqrt를 찾는 디버깅에.", c:"isnan / isinf", ex:"if (isnan(v.x) || isinf(v.x)) fragColor = vec4(1, 0, 1, 1);   // 문제 픽셀을 자홍색으로"}]},
    {id:"trig", title:"삼각 · 각도", desc:"각도는 모두 라디안입니다. 2π ≈ 6.2831853.", items:[
      {name:"radians · degrees", sig:"T radians(T deg) · T degrees(T rad)", desc:"도 ↔ 라디안 변환.", c:"deg * M_PI / 180", ex:"float a = radians(45.0);   // 0.785…\nfloat deg = degrees(atan(p.y, p.x));"},
      {name:"sin · cos · tan", sig:"T sin(T a) · T cos(T a) · T tan(T a)", desc:"삼각함수. sin(uTime)은 −1~1 왕복 — 애니메이션의 기본.", c:"sinf / cosf / tanf", ex:"vec2 orbit = vec2(cos(t), sin(t));"},
      {name:"asin · acos", sig:"T asin(T x) · T acos(T x)", desc:"역사인·역코사인. x가 −1~1 밖이면 결과 정의 안 됨 — clamp하세요.", c:"asinf / acosf", ex:"float ang = acos(clamp(dot(a, b), -1.0, 1.0));"},
      {name:"atan (2인수)", sig:"T atan(T y, T x)", desc:"점 (x, y)의 각도 −π~π. 이름은 atan이지만 C의 atan2와 같음. 극좌표·방사형 무늬에.", c:"atan2f(y, x)", ex:"float a = atan(p.y, p.x);"},
      {name:"atan (1인수)", sig:"T atan(T y_over_x)", desc:"−π/2~π/2 범위 역탄젠트.", c:"atanf", ex:"float slope = atan(dy / dx);   // 방향(사분면) 구분 없는 기울기 각"},
      {name:"sinh · cosh · tanh", sig:"T sinh(T x) · T cosh(T x) · T tanh(T x)", desc:"쌍곡선 함수. tanh는 값을 −1~1로 부드럽게 눌러주는 데 유용.", c:"sinhf / coshf / tanhf", ex:"float soft = tanh(x * 2.0);   // 큰 값을 -1~1로 부드럽게 제한"},
      {name:"asinh · acosh · atanh", sig:"T asinh(T x) · T acosh(T x) · T atanh(T x)", desc:"역쌍곡선 함수.", c:"asinhf / acoshf / atanhf", ex:"float x = atanh(clamp(v, -0.999, 0.999));   // tanh의 역함수"}]},
    {id:"exp", title:"지수 · 로그 · 거듭제곱", desc:"음수·0 입력에 주의하세요. 정의되지 않은 값은 GPU마다 결과가 다릅니다.", items:[
      {name:"pow", sig:"T pow(T x, T y)", desc:"x의 y제곱. x < 0이거나 x = 0, y ≤ 0이면 정의되지 않음.", c:"powf", ex:"col = pow(col, vec3(1.0 / 2.2));   // 감마"},
      {name:"exp · log", sig:"T exp(T x) · T log(T x)", desc:"자연 지수·자연 로그. exp(−k·d)는 거리에 따라 부드럽게 사라지는 빛·안개.", c:"expf / logf", ex:"float glow = exp(-8.0 * abs(d));"},
      {name:"exp2 · log2", sig:"T exp2(T x) · T log2(T x)", desc:"2의 거듭제곱·밑이 2인 로그. 옥타브·밉 레벨 계산.", c:"exp2f / log2f", ex:"float freq = exp2(float(i));   // 옥타브: 1, 2, 4, 8…\nfloat lastMip = log2(float(max(size.x, size.y)));"},
      {name:"sqrt", sig:"T sqrt(T x)", desc:"제곱근(x ≥ 0). 거리 비교만 할 때는 dot(v, v)로 sqrt를 생략할 수 있음.", c:"sqrtf", ex:"float r = sqrt(dot(p, p));   // length(p)와 같음"},
      {name:"inversesqrt", sig:"T inversesqrt(T x)", desc:"1 / sqrt(x). 정규화에 쓰이며 보통 빠름.", c:"1.0f / sqrtf(x)", ex:"vec3 n = v * inversesqrt(dot(v, v));   // normalize(v)와 같음"}]},
    {id:"geometry", title:"벡터 · 기하", desc:"벡터를 하나의 값으로 다루는 함수들입니다. 거리·방향·조명 계산의 기초예요.", items:[
      {name:"length", sig:"float length(T v)", desc:"벡터 길이 √(x² + y² + …). 원점까지 거리 = 원의 SDF.", c:"sqrtf(x*x + y*y)", ex:"float d = length(p) - r;"},
      {name:"distance", sig:"float distance(T a, T b)", desc:"두 점 사이 거리 = length(a − b).", c:"hypotf(ax-bx, ay-by)", ex:"float d = distance(uv, vec2(0.5));   // 화면 중심까지 거리"},
      {name:"dot", sig:"float dot(T a, T b)", desc:"내적. 두 단위 벡터의 dot은 cos(사이각) — 조명 밝기·방향 비교. dot(v, v)는 길이².", c:"a.x*b.x + a.y*b.y + …", ex:"float diffuse = max(dot(n, lightDir), 0.0);"},
      {name:"cross", sig:"vec3 cross(vec3 a, vec3 b)", desc:"외적. a·b 모두에 수직인 벡터(오른손 법칙). 카메라 축 만들기.", c:"직접 구현", ex:"vec3 right = normalize(cross(forward, vec3(0, 1, 0)));"},
      {name:"normalize", sig:"T normalize(T v)", desc:"같은 방향, 길이 1인 벡터. 길이 0 벡터는 정의되지 않음.", c:"v / length(v)", ex:"vec3 rd = normalize(vec3(uv, 1.5));"},
      {name:"reflect", sig:"T reflect(T I, T N)", desc:"입사 방향 I를 법선 N(단위 벡터)에 대해 반사. 거울·하이라이트.", c:"I - 2*dot(N,I)*N", ex:"vec3 r = reflect(rd, n);"},
      {name:"refract", sig:"T refract(T I, T N, float eta)", desc:"굴절 방향. eta = 굴절률 비(공기→유리 ≈ 1/1.5). 전반사면 0 벡터.", c:"직접 구현", ex:"vec3 t = refract(rd, n, 1.0 / 1.5);   // 공기 → 유리로 꺾이는 방향"},
      {name:"faceforward", sig:"T faceforward(T N, T I, T Nref)", desc:"dot(Nref, I) < 0이면 N, 아니면 −N. 법선이 시점 쪽을 향하게.", c:"직접 구현", ex:"vec3 nf = faceforward(n, rd, n);   // 법선을 시점 쪽으로 뒤집기"}]},
    {id:"matrix", title:"행렬", desc:"GLSL 행렬은 열 우선(column-major)입니다. m[i]는 i번째 열, m * v는 행렬×벡터, v * m은 전치 곱.", items:[
      {name:"생성자", sig:"mat2(a, b, c, d) · mat3(col0, col1, col2) · mat3(1.0)", desc:"인수는 열 순서로 채워짐. mat3(1.0)은 단위 행렬. mat3(m4)는 왼쪽 위 3×3.", c:"배열 [col][row]와 같은 배치", ex:"mat2 rot = mat2(c, s, -s, c);   // 회전"},
      {name:"matrixCompMult", sig:"mat matrixCompMult(mat a, mat b)", desc:"성분별 곱(행렬 곱이 아님). 행렬 곱은 * 연산자.", c:"a[i][j] * b[i][j]", ex:"mat2 m = matrixCompMult(a, b);   // m[i][j] = a[i][j] * b[i][j]"},
      {name:"outerProduct", sig:"matNxM outerProduct(vecM c, vecN r)", desc:"외적 행렬 c·rᵀ.", c:"직접 구현", ex:"mat3 proj = outerProduct(n, n);   // n 방향 성분만 남기는 투영 행렬"},
      {name:"transpose", sig:"mat transpose(mat m)", desc:"전치. 회전 행렬의 역행렬은 전치와 같음(싸게 되돌리기).", c:"직접 구현", ex:"mat3 invRot = transpose(rot);   // 회전 행렬의 역행렬"},
      {name:"determinant", sig:"float determinant(mat m)", desc:"행렬식.", c:"직접 구현", ex:"float area = determinant(mat2(e1, e2));   // 두 변이 만드는 평행사변형 넓이(부호 포함)"},
      {name:"inverse", sig:"mat inverse(mat m)", desc:"역행렬. 비싸므로 회전이면 transpose를 쓰세요.", c:"직접 구현", ex:"mat3 inv = inverse(m);   // 회전만 있다면 transpose(m)이 더 쌈"}]},
    {id:"compare", title:"벡터 비교 · 논리", desc:"벡터끼리 <, == 등을 쓰면 성분별이 아니라 오류이거나 전체 비교입니다. 성분별 비교는 아래 함수로 bvec를 받으세요.", items:[
      {name:"lessThan · greaterThan", sig:"B lessThan(T a, T b) · B greaterThan(T a, T b)", desc:"성분별 <, > 결과를 bvec로.", ex:"bvec2 inside = lessThan(abs(p), vec2(0.5));"},
      {name:"lessThanEqual · greaterThanEqual", sig:"B lessThanEqual(T a, T b) · B greaterThanEqual(T a, T b)", desc:"성분별 ≤, ≥.", ex:"bvec2 inside = lessThanEqual(abs(p), vec2(0.5));\nif (all(inside)) col = vec3(1.0);   // 상자 안"},
      {name:"equal · notEqual", sig:"B equal(T a, T b) · B notEqual(T a, T b)", desc:"성분별 ==, !=. (a == b는 모든 성분이 같을 때만 true인 bool 하나)", ex:"if (all(equal(cell, ivec2(3, 4)))) col = vec3(1, 0, 0);   // 특정 칸만 강조"},
      {name:"any · all · not", sig:"bool any(B v) · bool all(B v) · B not(B v)", desc:"하나라도 true / 모두 true / 성분별 부정.", ex:"if (all(inside)) col = vec3(1.0);"},
      {name:"mix (bool 선택)", sig:"T mix(T a, T b, B sel)", desc:"sel이 true인 성분만 b에서 가져옴 — 분기 없는 성분별 선택.", ex:"vec3 c = mix(a, b, greaterThan(n, vec3(0.0)));"}]},
    {id:"texture", title:"텍스처 읽기", desc:"sampler2D(이미지·버퍼)를 읽는 함수입니다. 좌표 uv는 0~1, texelFetch만 정수 픽셀 좌표를 씁니다.", items:[
      {name:"texture", sig:"vec4 texture(sampler2D s, vec2 uv [, float bias])", desc:"0~1 좌표로 읽기. Filter가 Linear면 주변 텍셀을 보간, 밉맵이 있으면 자동 레벨 선택.", c:"bilinear 보간된 배열 읽기", ex:"vec4 c = texture(iChannel0, gl_FragCoord.xy / uResolution);"},
      {name:"texelFetch", sig:"vec4 texelFetch(sampler2D s, ivec2 p, int lod)", desc:"정수 픽셀 좌표로 정확히 한 칸 읽기(보간·Wrap 없음). 시뮬레이션·데이터 버퍼에. 범위 밖은 정의 안 됨.", c:"arr[y][x]", ex:"vec4 v = texelFetch(iChannel0, ivec2(gl_FragCoord.xy), 0);"},
      {name:"textureLod", sig:"vec4 textureLod(sampler2D s, vec2 uv, float lod)", desc:"밉맵 레벨을 직접 지정해 읽기. lod가 클수록 흐림(Buffer의 Mip 켜기 필요).", ex:"vec4 blur = textureLod(iChannel0, uv, 4.0);"},
      {name:"textureSize", sig:"ivec2 textureSize(sampler2D s, int lod)", desc:"텍스처 크기(픽셀). iChannelResolution 대신 쓸 수 있음.", ex:"vec2 px = 1.0 / vec2(textureSize(iChannel0, 0));"},
      {name:"textureOffset", sig:"vec4 textureOffset(sampler2D s, vec2 uv, ivec2 offset)", desc:"uv에서 정수 텍셀만큼 떨어진 곳 읽기. offset은 상수여야 함(−8~7 정도).", ex:"vec4 r = textureOffset(iChannel0, uv, ivec2(1, 0));"},
      {name:"texelFetchOffset", sig:"vec4 texelFetchOffset(sampler2D s, ivec2 p, int lod, ivec2 offset)", desc:"texelFetch + 상수 오프셋.", ex:"vec4 right = texelFetchOffset(iChannel0, ivec2(gl_FragCoord.xy), 0, ivec2(1, 0));   // 오른쪽 이웃 픽셀"},
      {name:"textureGrad", sig:"vec4 textureGrad(sampler2D s, vec2 uv, vec2 dPdx, vec2 dPdy)", desc:"화면 미분을 직접 넘겨 밉 레벨을 결정. 좌표가 불연속인 곳(fract 타일)의 경계 줄무늬 제거.", ex:"textureGrad(tex, fract(uv), dFdx(uv), dFdy(uv))"},
      {name:"textureProj", sig:"vec4 textureProj(sampler2D s, vec3 p)", desc:"p.xy / p.z로 나눈 좌표로 읽기(투영 텍스처).", ex:"vec4 c = textureProj(iChannel0, vec3(q.xy, q.z));   // texture(iChannel0, q.xy / q.z)와 같음"},
      {name:"textureLodOffset · textureProjLod …", sig:"textureLodOffset · textureProjOffset · textureProjLod · textureProjLodOffset · textureGradOffset · textureProjGrad · textureProjGradOffset", desc:"위 기능들의 조합 버전. 이름 그대로 Lod(레벨 지정)·Offset(정수 오프셋)·Proj(투영)·Grad(미분 지정)를 합친 것.", ex:"vec4 left = textureLodOffset(iChannel0, uv, 0.0, ivec2(-1, 0));   // 0번 밉 레벨의 왼쪽 이웃"}]},
    {id:"derivative", title:"화면 미분", desc:"이웃 픽셀과의 차이. GPU는 픽셀을 2×2 묶음으로 실행하므로 옆 픽셀의 값을 알 수 있습니다. 안티앨리어싱의 핵심 도구예요.", items:[
      {name:"dFdx · dFdy", sig:"T dFdx(T v) · T dFdy(T v)", desc:"v가 화면 가로·세로 한 픽셀마다 얼마나 변하는지. 분기 안(일부 픽셀만 실행)에서 쓰면 정의되지 않음.", ex:"vec3 n = normalize(cross(dFdx(pos), dFdy(pos)));   // 면 법선"},
      {name:"fwidth", sig:"T fwidth(T v)", desc:"abs(dFdx(v)) + abs(dFdy(v)). '이 값에서 픽셀 1개의 크기' — 어떤 스케일에서도 1픽셀 폭으로 부드러운 경계.", ex:"float w = fwidth(d); float a = 1.0 - smoothstep(-w, w, d);"}]},
    {id:"bits", title:"비트 · 정수 · 패킹", desc:"정수 연산과 실수↔비트 변환입니다. 정수에는 +, −, *, /, %, <<, >>, &, |, ^, ~ 연산자를 그대로 쓸 수 있어요(C와 동일).", items:[
      {name:"정수 연산자", sig:"I % I · I << I · I & I · I ^ I · ~I", desc:"C와 같은 정수 연산. 정수 나눗셈은 0 방향 버림. uint 상수는 1u처럼 u 접미사.", c:"C와 동일", ex:"ivec2 p = ivec2(gl_FragCoord.xy) & 3;"},
      {name:"floatBitsToInt · floatBitsToUint", sig:"I floatBitsToInt(T x) · U floatBitsToUint(T x)", desc:"실수의 IEEE 비트 패턴을 정수로 그대로 읽기(형변환 아님). 실수로 고품질 해시를 만들 때.", c:"memcpy(&i, &f, 4)", ex:"uint h = floatBitsToUint(p.x) * 747796405u;"},
      {name:"intBitsToFloat · uintBitsToFloat", sig:"T intBitsToFloat(I x) · T uintBitsToFloat(U x)", desc:"정수 비트 패턴을 실수로 해석.", c:"memcpy(&f, &i, 4)", ex:"float one = uintBitsToFloat(0x3f800000u);   // 1.0\nuint bits = floatBitsToUint(one);"},
      {name:"packHalf2x16 · unpackHalf2x16", sig:"uint packHalf2x16(vec2 v) · vec2 unpackHalf2x16(uint p)", desc:"vec2를 16비트 실수 두 개로 uint 하나에 압축 / 복원. 버퍼 채널 절약.", c:"half 변환 + 비트 시프트", ex:"uint packed = packHalf2x16(velocity);\nvec2 back = unpackHalf2x16(packed);"},
      {name:"packUnorm2x16 · unpackUnorm2x16", sig:"uint packUnorm2x16(vec2 v) · vec2 unpackUnorm2x16(uint p)", desc:"0~1 값 두 개를 16비트 정수로 압축 / 복원.", ex:"uint packed = packUnorm2x16(uv);   // 0~1 좌표 두 개를 uint 하나에\nvec2 uv2 = unpackUnorm2x16(packed);"},
      {name:"packSnorm2x16 · unpackSnorm2x16", sig:"uint packSnorm2x16(vec2 v) · vec2 unpackSnorm2x16(uint p)", desc:"−1~1 값 두 개를 16비트 부호 정수로 압축 / 복원.", ex:"uint packed = packSnorm2x16(n.xy);   // -1~1 법선 xy 압축\nvec2 nxy = unpackSnorm2x16(packed);"},
      {name:"형변환 생성자", sig:"float(i) · int(f) · uint(i) · bool(x) · vec3(ivec3)", desc:"암묵 변환이 없으므로 생성자로 명시. int(f)는 0 방향 버림.", c:"(float)i, (int)f", ex:"int column = int(uv.x * 8.0);   // 0 방향 버림\nfloat t = float(uFrame) * 0.5;"}]},
    {id:"builtins", title:"내장 변수 · 문법", desc:"프래그먼트 셰이더에서 쓸 수 있는 내장 변수와 자주 헷갈리는 문법입니다.", items:[
      {name:"gl_FragCoord", sig:"in highp vec4 gl_FragCoord", desc:"이 픽셀의 창 좌표. xy = 픽셀 중심(0.5, 0.5부터), 원점은 왼쪽 아래. z = 깊이(0~1), w = 1/w.", ex:"vec2 uv = gl_FragCoord.xy / uResolution;"},
      {name:"gl_FrontFacing", sig:"in bool gl_FrontFacing", desc:"앞면 여부. 전체 화면 사각형만 그리는 이 앱에서는 항상 true.", ex:"vec3 nf = gl_FrontFacing ? n : -n;   // 이 앱에서는 항상 앞면"},
      {name:"gl_FragDepth", sig:"out highp float gl_FragDepth", desc:"깊이 값을 직접 쓰기. 이 앱은 깊이 버퍼를 쓰지 않으므로 효과 없음.", ex:"gl_FragDepth = 0.5;   // 이 앱에서는 결과에 영향 없음"},
      {name:"gl_PointCoord", sig:"in mediump vec2 gl_PointCoord", desc:"점 그리기용 좌표. 이 앱에서는 쓰이지 않음.", ex:"float d = length(gl_PointCoord - 0.5);   // 점 스프라이트용(이 앱에서는 사용 안 함)"},
      {name:"out 변수", sig:"out vec4 fragColor; · layout(location = N) out vec4 …;", desc:"출력 색. 이름은 자유. 출력이 여럿(MRT)이면 모두 location을 지정해야 함.", ex:"layout(location = 0) out vec4 fragColor;\nvoid main() { fragColor = vec4(1.0); }"},
      {name:"precision", sig:"precision highp float;", desc:"float 기본 정밀도. 프래그먼트 셰이더에는 기본값이 없어 반드시 선언. highp ≈ 32비트 IEEE.", c:"float", ex:"#version 300 es\nprecision highp float;"},
      {name:"매개변수 한정자", sig:"in · out · inout · const", desc:"in = 값 복사(기본), out = 함수가 써서 돌려줌, inout = 둘 다. 포인터 대신 이것으로 여러 값을 반환.", c:"in ≈ 값 전달, out/inout ≈ 포인터", ex:"void polar(vec2 p, out float r, out float a)"},
      {name:"스위즐", sig:"v.xy · v.zyx · v.rgb · v.stpq · v.xxx", desc:"성분을 원하는 순서·개수로 뽑기. xyzw·rgba·stpq는 같은 성분의 다른 이름(섞어 쓰기는 불가). 대입도 가능(v.xz = …).", ex:"p.xz = rot * p.xz;"},
      {name:"배열", sig:"float a[4] = float[4](1.0, 2.0, 3.0, 4.0);", desc:"크기는 상수. 배열 생성자로 초기화. .length()로 길이. 동적 할당·포인터 없음.", c:"float a[4] = {…}", ex:"float w[3] = float[3](0.25, 0.5, 0.25);\nfor (int i = 0; i < w.length(); i++) sum += w[i] * v[i];"},
      {name:"구조체", sig:"struct Hit { float t; vec3 n; };", desc:"C 구조체와 같음. 생성자 Hit(1.0, vec3(0))로 만들고 함수 반환값으로 쓸 수 있음.", c:"typedef struct", ex:"struct Hit { float t; vec3 n; };\nHit h = Hit(1e9, vec3(0.0));"},
      {name:"반복문 제약", sig:"for (int i = 0; i < N; i++)", desc:"재귀 금지. 루프는 가능하면 상수 상한 + break. 너무 긴 루프는 GPU 타임아웃(화면 멈춤)을 일으킬 수 있음.", ex:"for (int i = 0; i < 64; i++) {   // 상수 상한\n    float d = map(p);\n    if (d < 0.001) break;\n    p += rd * d;\n}"},
      {name:"#define · #if", sig:"#define NAME value · #if … #endif", desc:"C 전처리기와 거의 같음(#include는 없음). 상수·매크로·디버그 스위치에.", ex:"#define STEPS 64\n#define DEBUG 0\n#if DEBUG\n    fragColor = vec4(n * 0.5 + 0.5, 1.0);\n#endif"}]}
  ];
  const ALL = CATEGORIES.flatMap(category => category.items.map(item => ({...item, category:category.id})));
  return {CATEGORIES,ALL};
})();
const guide=((Snippets, Course, Reference, Highlight)=>{
// 앱 내장 가이드: 주제별 설명·검색·코드 예시(편집기 삽입)·UI 둘러보기 투어·문맥 도움말(?) 버튼.
// 내용은 아래 TOPICS 데이터로만 정의한다. 문단 안의 `코드`와 **강조**만 서식으로 해석하고 HTML은 해석하지 않는다.
// 코드 조각 라이브러리의 내용은 snippets.js가 소유하고, 여기서는 범주 탭·검색·삽입 UI만 담당한다.
// 입문 과정(단계별 수업·예제 프로젝트)의 내용은 course.js가 소유하고, 여기서는 진행률·이전/다음·완료 표시를 담당한다.




  // 블록 형식: {p}, {list:[…]}, {steps:[…]}, {table:{head, rows}}, {code, title, insert?:true}, {keys:[[설명, 키]…]},
  //            {note}, {actions:[{label, run:"tour"|"gallery"|"topic:<id>"|"example:<id>"}]}
  const TOPICS = [
    {id:"start", title:"시작하기", summary:"처음 3분 안에 셰이더를 고쳐 보기", blocks:[
      {p:"FIELD Studio는 브라우저에서 GLSL 프래그먼트 셰이더를 작성하고 결과를 바로 보는 오프라인 셰이더 작업실입니다. 서버나 인터넷이 필요 없습니다."},
      {steps:[
        "**예제 고르기** — 뷰포트 툴바의 격자 아이콘(또는 `X`)으로 갤러리를 열고 마음에 드는 예제를 선택합니다.",
        "**코드 고치기** — `E`로 편집기를 열고 숫자 하나를 바꿔 보세요. 0.9초 뒤 자동으로 적용됩니다(`Ctrl+Enter`는 즉시 실행).",
        "**값 조절하기** — 설정 패널의 **파라미터** 탭에서 슬라이더·색상으로 Uniform 값을 실시간으로 바꿉니다.",
        "**확인하기** — **성능** 탭에서 GPU 시간과 버퍼 내용을 들여다봅니다."]},
      {p:"**가장 작은 셰이더** — 아래 코드는 화면 좌표를 색으로 바꿉니다. **이 코드로 시작**을 누른 뒤 `0.5`나 `sin` 안의 값을 바꿔 보세요."},
      {code:`#version 300 es
precision highp float;
uniform vec2 uResolution;   // 화면 픽셀 크기
uniform float uTime;        // 재생 시간(초)
out vec4 fragColor;

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;        // 0~1 화면 좌표
    vec3 col = vec3(uv, 0.5 + 0.5 * sin(uTime));    // x → 빨강, y → 초록, 시간 → 파랑
    fragColor = vec4(col, 1.0);
}`, title:"첫 셰이더 · 좌표를 색으로", start:true},
      {actions:[{label:"UI 둘러보기 시작", run:"tour"}, {label:"예제 갤러리 열기", run:"gallery"}, {label:"첫 셰이더 구조 보기", run:"topic:editor"}]},
      {note:"**셰이더가 처음인가요?** C와 GLSL 문법을 안다면 **입문 과정**(12단계)을 따라가 보세요. 픽셀 하나의 관점부터 버퍼로 만드는 시뮬레이션까지, 단계마다 바로 실행되는 예제와 과제가 있습니다."},
      {actions:[{label:"입문 과정 시작 →", run:"topic:course"}]},
      {note:"실수해도 괜찮습니다. 편집기의 `Ctrl+Z`는 코드뿐 아니라 버퍼 구성·파라미터 변경까지 되돌립니다."}]},
    {id:"screen", title:"화면 구성", summary:"뷰포트 · 툴바 · 설정 패널 · 편집기", blocks:[
      {table:{head:["영역","역할"], rows:[
        ["뷰포트","셰이더 결과. 3D 예제에서는 드래그로 회전, 휠로 확대합니다."],
        ["툴바(오른쪽 위)","재생/일시정지 · 가이드 · 갤러리 · 편집기 · 스크린샷 · HUD · 패널 · 전체화면"],
        ["HUD(오른쪽 아래)","FPS · 렌더 해상도 · 프레임 수 · GPU 시간(지원 시)"],
        ["설정 패널(왼쪽)","렌더링 품질 · 파라미터 · 성능/디버그 · 작업공간 탭"],
        ["편집기","패스 탭(Image/Buffer) · 입력 채널 · GLSL 코드 · 오류 표시"]]}},
      {p:"넓은 화면에서는 편집기가 캔버스 오른쪽에 나란히 열립니다. 편집기 위쪽의 분할 아이콘으로 아래/오른쪽 배치를 바꿀 수 있고, 경계선을 끌어 크기를 조절합니다."},
      {actions:[{label:"UI 둘러보기로 직접 확인", run:"tour"}]}]},
    {id:"editor", title:"셰이더 작성 기본", summary:"GLSL ES 3.00 구조 · 실행 · 오류 읽기", blocks:[
      {p:"모든 패스는 `#version 300 es`로 시작하는 프래그먼트 셰이더입니다. 화면의 각 픽셀마다 `main()`이 실행되고 `out vec4`에 색을 씁니다."},
      {code:`#version 300 es
precision highp float;
uniform vec2 uResolution;   // 현재 패스의 픽셀 크기
uniform float uTime;        // 재생 시간(초)
out vec4 fragColor;

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;   // 0~1 좌표
    vec3 color = 0.5 + 0.5 * cos(uTime + uv.xyx + vec3(0, 2, 4));
    fragColor = vec4(color, 1.0);
}`, title:"가장 작은 셰이더", insert:"replace"},
      {list:["**자동**이 켜져 있으면 입력을 멈춘 뒤 0.9초에 자동 적용, 꺼져 있으면 **▶ 실행**(`Ctrl+Enter`/`Ctrl+S`)으로 적용합니다.",
        "컴파일 오류는 해당 줄이 **빨간 띠**로 표시되고 줄 끝에 메시지가 나옵니다. 아래 목록을 누르면 그 줄로 이동합니다.",
        "오류가 있어도 화면은 마지막으로 성공한 결과를 유지합니다.",
        "`Ctrl+Space` 자동 완성, `Ctrl+F` 검색, `Ctrl+/` 주석, `Alt+↑↓` 줄 이동을 지원합니다."]},
      {heading:"편집기 화면"},
      {table:{head:["위치","내용"], rows:[
        ["맨 위 줄","패스 탭과 **+**(버퍼 추가) · 되돌리기/다시 실행 · **자동** · **▶ 실행** · 재생/정지 · 시간 초기화 · 도구 서랍 · 집중 모드 · 닫기"],
        ["버퍼 설정","Buffer 탭을 고르면 나타나는 한 줄 요약. 누르면 형식·크기·출력 수·필터·가장자리·밉맵과 순서·복제·삭제가 펼쳐집니다."],
        ["코드 머리줄","파일 이름과 실행 상태 · 함수 목록 · 검색 · 줄 이동 · 자동 완성 · 코드 조각 · **⋯ 메뉴**(찾아 바꾸기, 텍스처 코드 삽입, .frag 파일, 글자 크기·들여쓰기·줄바꿈, 배치, 도움말)"],
        ["맨 아래 줄","최근 메시지 · 브라우저 보관 상태 · 커서 위치"]]}},
      {heading:"자동 완성"},
      {list:["이름을 치기 시작하면 **커서 바로 아래**에 후보가 뜹니다(`Ctrl+Space`로 직접 열 수도 있음). `↑↓`·`PageUp/Down`으로 고르고 `Enter`·`Tab`으로 넣습니다.",
        "글자를 건너뛰어도 찾습니다: `smst` → `smoothstep`, `fbmS` → `fbm3Simplex`. 이 파일의 변수·함수가 먼저, 그다음 Uniform·내장 함수 순으로 정렬됩니다.",
        "오른쪽(좁으면 아래) 설명 칸에 시그니처와 설명이 나옵니다. 아이콘: `x` 변수 · `ƒ` 함수 · `u` Uniform · `T` 타입 · `k` 키워드 · `{}` 템플릿 · `+` 코드 조각 모음.",
        "`uv.` · `col.`처럼 **점을 찍으면** 그 변수 타입에 맞는 성분(`x y xy rgb …`)이나 구조체 필드를 제안합니다.",
        "**템플릿**: `for` · `if` · `ifelse` · `func` · `main` · `struct` · `uniform-range` · `uniform-color` · `uv-center` · `frag` … 넣은 뒤 `Tab`으로 다음 자리로 이동하고, `Esc`로 끝냅니다.",
        "`uTime`·`uMouse`·`iChannel0`처럼 **선언하지 않은 앱 Uniform**을 고르면 선언 줄을 맨 위에 함께 넣습니다.",
        "`fbm3`·`sdHexagon`처럼 **코드 조각 모음의 함수 이름**(`+` 아이콘)을 고르면 함수 정의(필요한 보조 함수 포함)가 위쪽에 자동으로 추가됩니다. `Ctrl+Z` 한 번이면 정의만 되돌아갑니다.",
        "새 변수 이름을 짓는 자리(`float ` 다음 등)에서는 목록이 저절로 뜨지 않습니다."]},
      {heading:"코드 다루기 도우미"},
      {list:["**시그니처 도움말** — `mix(`처럼 호출 괄호 안에 있으면 커서 위에 매개변수가 뜨고, 지금 쓰는 인수가 **굵게 밑줄**로 표시됩니다. 내장 함수와 이 패스의 함수 모두 지원합니다.",
        "**마우스 설명** — 이름 위에 마우스를 잠시 올리면 내장 함수 설명, 변수 타입과 선언 줄, Uniform 설명이 뜹니다.",
        "**화면 표시** — 현재 줄, 커서 옆 괄호의 짝, 커서 아래 이름의 다른 사용 위치가 은은하게 강조됩니다.",
        "**정의로 이동** — `F12` 또는 `Ctrl+클릭`. **이름 바꾸기** — `F2`(이 패스의 같은 이름을 모두, 주석·문자열·`.필드`는 제외).",
        "**명령 팔레트** — `Ctrl+Shift+P`(또는 `F1`, ⋯ 메뉴)로 모든 명령을 이름으로 찾아 실행합니다. `@`로 시작하면 함수·Uniform으로, `:`로 시작하면 줄 번호로 이동합니다.",
        "**숫자 조절** — 숫자 위에 커서를 두고 `Ctrl+↑`/`Ctrl+↓`로 마지막 자릿수 단위만큼 올리고 내립니다(`Shift`를 함께 누르면 10배). `0.25`는 0.01씩, `3.`은 1씩 바뀝니다.",
        "**끌어서 조절** — `Alt`를 누른 채 숫자를 좌우로 끌면 값이 바뀌며 화면이 바로 따라옵니다. 한 번 끈 것은 `Ctrl+Z` 한 번으로 되돌아갑니다."]}]},
    {id:"builtins", title:"GLSL 내장 함수", summary:"수학 · 벡터 · 텍스처 · 미분 · 문법 레퍼런스", blocks:[
      {p:"GLSL ES 3.00(WebGL2)에서 쓸 수 있는 내장 함수와 변수입니다. 범주를 고르거나 위 검색창에 이름·설명으로 찾으세요(예: `mix`, `보간`, `atan2`). **C 대응** 줄은 C 표준 라이브러리로 쓰면 무엇인지 보여줍니다."},
      {note:"시그니처의 **T**는 `float`·`vec2`·`vec3`·`vec4` 중 하나로, 벡터에 쓰면 성분마다 따로 계산합니다. **I**는 int 계열, **U**는 uint 계열, **B**는 bool 계열입니다."},
      {reference:true}]},
    {id:"uniforms", title:"내장 Uniform", summary:"렌더러가 자동으로 넣어주는 값", blocks:[
      {p:"아래 이름을 GLSL에 선언하기만 하면 렌더러가 매 프레임 값을 넣습니다. 별도 등록이 필요 없습니다. 허용 타입이 아니면 값 전달을 건너뛰고 상태줄에 알려줍니다."},
      {table:{head:["이름","타입","내용"], rows:[
        ["uResolution","vec2 | vec3","현재 패스의 픽셀 크기 (vec3이면 z=1)"],
        ["uTime / uDeltaTime","float","재생 시간 / 직전 프레임 간격(초). 일시정지 중에는 멈춤"],
        ["uFrame","int | float | uint","누적 프레임 수. Reset·구조 변경 시 0"],
        ["uMouse","vec2 | vec4","포인터 픽셀 좌표(밖이면 -1). vec4면 zw=클릭 위치, z>0 누르는 중, w>0 누른 첫 프레임"],
        ["iChannel0~3","sampler2D","편집기에서 연결한 이미지·버퍼"],
        ["iChannelResolution[4]","vec3","각 채널 입력의 크기"]]}},
      {code:`uniform vec4 uMouse;
// ...
bool held   = uMouse.z > 0.0;          // 버튼을 누르고 있는 동안
bool tapped = uMouse.w > 0.0;          // 누른 직후 첫 프레임만
vec2 click  = abs(uMouse.zw);          // 마지막 클릭 위치(픽셀)`, title:"마우스 클릭 읽기", insert:"cursor"}]},
    {id:"params", title:"파라미터 · 어노테이션", summary:"슬라이더·색상으로 값 조절", blocks:[
      {p:"파라미터는 직접 등록하는 Uniform입니다. **파라미터** 탭의 **+ 파라미터 추가**로 만들거나, 아래처럼 **GLSL 주석에 어노테이션**을 달면 컴파일 성공 시 자동으로 등록됩니다."},
      {code:`uniform float uSpeed;  // @range 0 4 @step 0.01 @default 1.5
uniform vec3  uTint;   // @color @default 0.9 0.3 0.6
uniform vec2  uOffset; // @range -1 1 @default 0
uniform int   uCount;  // @min 1 @max 32 @default 8`, title:"어노테이션 예시", insert:"cursor"},
      {table:{head:["태그","의미"], rows:[
        ["@range min max [step]","슬라이더 범위(벡터는 성분마다 같은 범위)"],
        ["@min · @max · @step","범위를 따로 지정"],
        ["@default v…","처음 등록할 때의 값. 값 하나면 모든 성분에 적용"],
        ["@color","vec3/vec4를 색상 선택기로 표시(값 0~1)"]]}},
      {list:["이미 등록된 파라미터는 **값을 유지**하고 범위·표시 방식만 갱신합니다(범위를 벗어난 값은 안으로 보정).",
        "지원 타입: float · int · uint · bool · vec2~4 · ivec · uvec · bvec · mat2~4 (최대 64개).",
        "**성능** 탭의 Uniform 진단에서 선언만 하고 등록하지 않은(값이 항상 0인) Uniform을 찾아 **등록** 버튼으로 바로 파라미터로 만들 수 있습니다."]},
      {actions:[{label:"어노테이션 예제 열기", run:"example:annotations"}]}]},
    {id:"buffers", title:"버퍼 · 멀티패스", summary:"여러 패스를 연결하고 이전 프레임 읽기", blocks:[
      {p:"편집기 패스 탭 옆의 **+**로 오프스크린 패스(A~H)를 추가합니다. 각 패스는 위에서 아래 순서로 실행되고, 마지막에 **Image**가 화면에 그려집니다."},
      {table:{head:["연결","의미"], rows:[
        ["current","이번 프레임에 **앞서 실행된** 버퍼의 결과. 자기 자신·뒤 패스는 선택 불가"],
        ["previous","직전 프레임에 저장된 결과. 자기 자신을 연결하면 **피드백(누적)**"]]}},
      {code:`uniform sampler2D iChannel0;   // 자기 자신(previous)을 연결
uniform int uFrame;
// ...
vec4 history = uFrame == 0 ? vec4(0.0) : texture(iChannel0, gl_FragCoord.xy / uResolution);
fragColor = max(newColor, history * 0.97);   // 잔상 누적`, title:"피드백 읽기", insert:"cursor"},
      {p:"Buffer 탭을 선택하면 코드 위에 **버퍼 설정** 요약 줄(예: `A · RGBA8 · 100% · Linear · Clamp`)이 나타나고, 누르면 아래 설정이 펼쳐집니다."},
      {table:{head:["설정","설명"], rows:[
        ["형식","RGBA8(일반) · RGBA16F/32F(HDR·음수·시뮬레이션)"],
        ["크기","화면 비율(100%~12.5%) 또는 고정 해상도(64²~1024²)"],
        ["출력 수","출력 수(MRT) 1~4 — 아래 MRT 주제 참고"],
        ["필터 · 가장자리","다른 패스가 읽을 때의 필터, 0~1 밖 좌표 처리(clamp/repeat/mirror)"],
        ["밉맵","매 프레임 밉맵 생성 → `textureLod`로 흐림·평균 (메모리 +33%)"]]}},
      {actions:[{label:"반응-확산 시뮬레이션 열기", run:"example:reaction"}, {label:"밉맵 블러 예제 열기", run:"example:mipblur"}, {label:"MRT 주제 보기", run:"topic:mrt"}]}]},
    {id:"mrt", title:"MRT · 다중 출력", summary:"한 패스에서 여러 텍스처에 쓰기", blocks:[
      {p:"버퍼 설정의 **출력 수**를 2 이상으로 하면 한 번의 실행으로 여러 출력에 씁니다. 위치·속도처럼 묶인 데이터를 저장할 때 유용합니다."},
      {code:`layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outData;`, title:"출력 선언 (출력 수 = 2)", insert:"cursor"},
      {list:["다른 패스의 입력 채널에서 `A[1] · current`처럼 **출력 번호**를 골라 읽습니다.",
        "출력 수를 줄이면 사라진 출력을 읽던 연결은 자동으로 0번 출력으로 되돌아갑니다.",
        "**성능 → 버퍼 뷰어**에는 출력마다 썸네일이 따로 표시됩니다."]},
      {actions:[{label:"MRT 예제 열기", run:"example:mrt"}]}]},
    {id:"inputs", title:"이미지 입력", summary:"PNG·JPEG·WebP를 채널에 연결", blocks:[
      {list:["편집기 도구의 **이미지** 그룹에서 파일을 불러오면 현재 패스의 빈 채널에 자동 연결됩니다(편집기에 끌어다 놓기도 가능).",
        "이미지마다 Filter(Linear/Nearest)와 Wrap(Clamp/Repeat/Mirror)을 설정합니다.",
        "이미지는 브라우저(IndexedDB)에 보관되어 새로고침 후에도 복원됩니다. 다른 컴퓨터로 옮길 때는 **전체 프로젝트 저장(Pack)**을 사용하세요."]},
      {code:`vec4 tex   = texture(iChannel0, gl_FragCoord.xy / uResolution);           // 화면에 맞춰 늘림
vec4 texel = texelFetch(iChannel0, ivec2(gl_FragCoord.xy), 0);              // 픽셀 정확히`, title:"텍스처 읽기 두 가지", insert:"cursor"}]},
    {id:"debug", title:"디버깅 · 성능", summary:"GPU 시간 · 버퍼 뷰어 · 픽셀 값", blocks:[
      {list:["**프레임 타임라인** — 최근 18초의 GPU/CPU/프레임 시간 그래프. 60fps(16.7ms) 기준선을 넘으면 끊김이 생깁니다.",
        "**패스별 GPU 시간** — 어느 패스가 무거운지 막대로 비교(8ms 초과는 경고색). 브라우저가 GPU 타이머를 지원할 때만 표시됩니다.",
        "**버퍼 뷰어** — 모든 버퍼 출력의 실시간 썸네일. 누르면 뷰포트에 표시, 다시 누르면 Image로 복귀.",
        "**채널·노출** — R/G/B/A를 따로 보거나 노출을 올려 아주 작은 값·HDR 값을 확인합니다.",
        "**픽셀 값** — 버퍼를 표시한 상태에서 뷰포트에 포인터를 올리면 그 위치의 실제 값(음수·1 초과 포함)을 읽습니다.",
        "**Uniform 진단** — 셰이더가 실제로 쓰는 Uniform과 미등록·타입 불일치 항목을 보여줍니다."]},
      {code:`// 값 범위를 눈으로 확인하는 디버그 출력: 음수는 빨강, 1 초과는 초록
vec3 debugValue(float v) { return v < 0.0 ? vec3(-v, 0, 0) : v > 1.0 ? vec3(0, v - 1.0, 0) : vec3(v); }`, title:"값 시각화 함수", insert:"cursor"},
      {actions:[{label:"성능 탭 열기", run:"panel:profile"}]}]},
    {id:"snippets", title:"코드 조각 모음", summary:"해시·노이즈·SDF 등 범주별 함수 라이브러리", blocks:[
      {p:"범주를 고르고 **삽입**을 누르면 현재 편집 중인 패스에 들어갑니다. 함수는 자동으로 `main()` 바깥(전역)에, 문장 조각은 함수 안 커서 위치에 들어가며, 필요한 함수(예: `fbm` → `valueNoise` → `hash21`)도 **코드에 없을 때만** 함께 넣습니다."},
      {library:true}]},
    {id:"shortcuts", title:"단축키", summary:"키보드로 빠르게", blocks:[
      {keys:[["가이드 열기/닫기","?"],["셰이더 편집기","E"],["예제 갤러리","X"],["재생/일시정지 (뷰포트 선택 시)","Space"],["전체화면","F"],["설정 패널","H"],["HUD 표시","G"],["파라미터 검색","/"],
        ["3D 카메라 회전 / 확대","드래그 / 휠"],["카메라 이동 · 가속","WASD·방향키 / Shift"],["카메라 초기화","R"]]},
      {p:"**편집기 안에서** (Mac은 Ctrl 대신 Cmd)"},
      {keys:[["코드 적용","Ctrl+Enter / Ctrl+S"],["되돌리기 / 다시 실행","Ctrl+Z / Ctrl+Y"],["자동 완성","Ctrl+Space"],["검색 / 치환 / 줄 이동","Ctrl+F / Ctrl+H / Ctrl+G"],
        ["주석 전환","Ctrl+/"],["줄 복제","Ctrl+Shift+D"],["줄 위/아래 이동","Alt+↑ / Alt+↓"],["들여쓰기 / 내어쓰기","Tab / Shift+Tab"],["이전·다음 패스","Alt+PageUp / Alt+PageDown"],
        ["커서 위 숫자 올리기 / 내리기 (Shift = 10배)","Ctrl+↑ / Ctrl+↓"],["숫자 끌어서 조절","Alt + 좌우 드래그"],
        ["명령 팔레트","Ctrl+Shift+P / F1"],["함수·Uniform으로 이동","Ctrl+Shift+O"],["정의로 이동","F12 / Ctrl+클릭"],["이름 바꾸기","F2"],
        ["줄 삭제","Ctrl+Shift+K"],["줄 위/아래로 복사","Shift+Alt+↑ / Shift+Alt+↓"],["줄 선택 (반복하면 다음 줄까지)","Ctrl+L"],["짝 괄호로 이동","Ctrl+Shift+\\"],
        ["긴 줄 자동 줄바꿈","Alt+Z"],["템플릿 다음 / 이전 자리","Tab / Shift+Tab"]]}]},
    {id:"files", title:"저장 · 내보내기", summary:"작업을 보관하고 옮기기", blocks:[
      {table:{head:["방법","포함 내용"], rows:[
        ["브라우저 자동 저장","코드·버퍼 구성(미적용 편집본 포함), 렌더 설정, 파라미터. 새로고침해도 유지"],
        ["전체 프로젝트 저장(Pack)","코드·버퍼·파라미터·연결된 이미지·렌더 설정 — 다른 컴퓨터로 옮길 때"],
        ["소스 JSON","코드와 버퍼 연결 구성만(이미지·파라미터 제외)"],
        [".frag 파일로 저장","현재 패스의 코드만 .frag 파일로 (편집기 ⋯ 메뉴)"],
        ["스크린샷","툴바의 카메라 아이콘 → 현재 화면 PNG"]]}},
      {note:"이 파일들은 편집기 도구 서랍(맨 위 줄의 서랍 아이콘)의 **프로젝트 파일** 그룹에 있습니다. 같은 브라우저라도 저장소를 지우면 자동 저장본이 사라지니 중요한 작업은 Pack으로 보관하세요."}]}
  ];
  // UI 둘러보기: target은 CSS 선택자, prepare는 대상이 보이도록 패널·편집기를 연다.
  const TOUR = [
    {target:"#renderViewport", title:"뷰포트", text:"셰이더 결과가 그려지는 곳입니다. 3D 예제에서는 드래그로 회전, 휠로 확대할 수 있어요.", prepare:"close-editor"},
    {target:"#stageToolbar", title:"툴바", text:"재생/일시정지 · 가이드 · 예제 갤러리 · 편집기 · 스크린샷 · HUD · 패널 · 전체화면 버튼입니다. 버튼 위에 포인터를 올리면 설명이 나와요.", prepare:"stage"},
    {target:"#stats", title:"HUD", text:"FPS, 실제 렌더 해상도, 프레임 수, GPU 시간을 실시간으로 보여줍니다. G 키로 숨길 수 있어요.", prepare:"stage"},
    {target:"#panelTabs", title:"설정 패널", text:"렌더링 품질, 파라미터, 성능/디버그, 작업공간 설정이 탭으로 나뉘어 있습니다. H 키로 패널을 열고 닫아요.", prepare:"panel:render"},
    {target:"#view-uniforms", title:"파라미터", text:"슬라이더·색상으로 Uniform 값을 실시간 조절합니다. GLSL 주석에 @range, @color를 달면 자동으로 여기에 생겨요.", prepare:"panel:uniforms"},
    {target:"#view-profile", title:"성능 · 디버그", text:"패스별 GPU 시간, 버퍼 썸네일, 픽셀 값, Uniform 진단을 확인합니다. 셰이더가 느리거나 결과가 이상할 때 먼저 보세요.", prepare:"panel:profile"},
    {target:"#studioPassTabs", title:"패스 탭", text:"Image(화면)와 Buffer 패스를 오갑니다. 옆의 +로 오프스크린 패스를 추가해 여러 단계를 연결할 수 있어요.", prepare:"open-editor"},
    {target:".studio-editor-frame", title:"코드 편집기", text:"GLSL을 고치면 0.9초 뒤 자동 적용됩니다. 오류가 나면 해당 줄이 빨갛게 표시되고 줄 끝에 이유가 나와요.", prepare:"open-editor"},
    {target:"#studioRun", title:"실행 · 되돌리기", text:"Ctrl+Enter로 즉시 실행, Ctrl+Z로 코드·버퍼·파라미터 변경을 되돌립니다.", prepare:"open-editor"},
    {target:"#helpToggle", title:"가이드는 언제든", text:"이 버튼이나 ? 키로 가이드를 다시 열 수 있어요. 각 패널의 작은 ? 버튼은 해당 주제로 바로 이동합니다.", prepare:"close-editor"}
  ];
  const mount = ({studio, gallery}) => {
    const $ = id => document.getElementById(id), controller = new AbortController(), signal = controller.signal;
    const dialog = $("quickHelp"), nav = $("guideNav"), content = $("guideContent"), search = $("guideSearch");
    const element = (tag, className = "", text = "") => { const node = document.createElement(tag); if(className) node.className = className; if(text) node.textContent = text; return node; };
    const listen = (target, type, fn, options = {}) => target?.addEventListener(type, fn, {...options, signal});
    let current = "start";
    // 가이드의 GLSL 예시도 편집기와 같은 규칙으로 강조한다. 내장 함수 이름은 레퍼런스에서 가져온다("sin · cos" → sin, cos).
    const highlighter = Highlight.create(Reference.ALL.flatMap(item => item.name.split("·").map(name => name.replace(/\(.*\)/, "").trim())));
    const codeBlock = source => highlighter.paint(element("pre"), source);
    // 탐색 목록: 시작하기 → 입문 과정 → 기능 레퍼런스. group이 바뀌는 곳에 목록 제목을 넣는다.
    const ALL = [{...TOPICS[0], group:""}, ...Course.LESSONS.map(lesson => ({...lesson, group:"입문 과정 · C 개발자용"})), ...TOPICS.slice(1).map(topic => ({...topic, group:"기능 레퍼런스"}))];
    const LESSON_IDS = Course.LESSONS.filter(lesson => lesson.step).map(lesson => lesson.id), COURSE_ORDER = Course.LESSONS.map(lesson => lesson.id);
    const navTitle = topic => topic.step ? `${topic.step}. ${topic.title}` : topic.title;
    // 과정 진행(완료한 단계)과 마지막으로 본 주제는 이 브라우저에 보관한다. 저장소가 막혀 있어도 가이드는 동작한다.
    const PROGRESS_KEY = "field.guide.course.v1", LAST_KEY = "field.guide.last.v1";
    const done = (() => { try { const saved = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "[]"); return new Set(Array.isArray(saved) ? saved.filter(id => LESSON_IDS.includes(id)) : []); } catch (_) { return new Set(); } })();
    const saveDone = () => { try { localStorage.setItem(PROGRESS_KEY, JSON.stringify([...done])); } catch (_) {} };
    try { const last = localStorage.getItem(LAST_KEY); if(ALL.some(topic => topic.id === last)) current = last; } catch (_) {}
    // `code`와 **강조**만 해석한다. 나머지는 모두 텍스트 노드.
    const rich = (tag, text, className = "") => {
      const node = element(tag, className);
      for(const part of String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
        if(!part) continue;
        if(part.startsWith("`")) node.append(element("code", "", part.slice(1, -1)));
        else if(part.startsWith("**")) node.append(element("b", "", part.slice(2, -2)));
        else node.append(document.createTextNode(part));
      }
      return node;
    };
    const flash = (button, text) => { const before = button.textContent; button.textContent = text; button.disabled = true; setTimeout(() => { button.textContent = before; button.disabled = false; }, 1400); };
    const runAction = action => {
      if(action === "tour") { dialog.close(); startTour(); }
      else if(action === "gallery") { dialog.close(); gallery?.open(false); }
      else if(action.startsWith("topic:")) show(action.slice(6));
      else if(action.startsWith("panel:")) { dialog.close(); openPanel(action.slice(6)); }
      else if(action.startsWith("example:")) { dialog.close(); gallery?.loadLesson?.(action.slice(8)); }
      else if(action.startsWith("course:")) { const project = Course.PROJECTS[action.slice(7)]; if(project) loadProject(project); }
    };
    // 과정 예제 불러오기: 현재 프로젝트를 교체한다(미적용 편집이 있으면 확인, Ctrl+Z로 복원 가능).
    // 가이드는 닫고, 다시 열면(? 키) 같은 단계로 돌아온다.
    const loadProject = async project => {
      dialog.close();
      const ok = await studio.loadExample(project, []);
      if(ok) studio.open();
      return ok;
    };
    // ---- 코드 조각 라이브러리 (범주 탭 + 검색 필터 + 의존성 포함 삽입) ----
    let snippetCategory = Snippets.CATEGORIES[0].id;
    const titleOf = id => Snippets.ALL.find(item => item.id === id)?.title || id;
    const insertItem = (item, button) => {
      if(item.replace) { if(studio.insertCode({replace:item.code, note:`${item.title}로 현재 패스를 교체했습니다 · Ctrl+Z로 되돌리기`})) dialog.close(); return; }
      const plan = Snippets.plan(item.id, studio.getEditorSource?.() || "");
      if(plan.alreadyDefined && !plan.mainCode) { flash(button, "이미 있음"); return; }
      const extra = plan.added.length ? ` (+ ${plan.added.join(", ")} 함께)` : "", reused = plan.skipped.length ? ` · 기존 ${plan.skipped.join(", ")} 사용` : "";
      if(studio.insertCode({global:plan.globals.map(entry => entry.code).join("\n\n"), main:plan.mainCode || "", note:`코드 조각 삽입: ${item.title}${extra}${reused} · Ctrl+Z로 되돌리기`})) dialog.close();
    };
    const snippetCard = item => {
      const figure = element("figure", "guide-code snippet-card"), bar = element("figcaption"), head = element("span", "snippet-head");
      head.append(element("strong", "", item.title), element("small", "", item.desc));
      const tags = element("span", "snippet-tags");
      tags.append(element("em", item.replace ? "is-replace" : item.scope === "main" ? "is-main" : "is-global", item.replace ? "패스 교체" : item.scope === "main" ? "main() 안" : "전역 함수"));
      if(item.requires?.length) tags.append(element("em", "is-dep", `+ ${item.requires.map(titleOf).join(", ")}`));
      const copy = element("button", "", "복사"); copy.type = "button";
      copy.addEventListener("click", async () => {
        const plan = Snippets.plan(item.id, "");
        const text = [...plan.globals.map(entry => entry.code), plan.mainCode].filter(Boolean).join("\n\n");
        try { await navigator.clipboard.writeText(text); flash(copy, "복사됨"); } catch (_) { flash(copy, "복사 실패"); }
      });
      const insert = element("button", "guide-insert", item.replace ? "패스 교체" : "삽입"); insert.type = "button";
      insert.title = item.replace ? "현재 편집 중인 패스 전체를 이 코드로 바꿉니다" : "필요한 함수와 함께 편집기에 넣습니다";
      insert.addEventListener("click", () => insertItem(item, insert));
      bar.append(head, tags, copy, insert); figure.append(bar, codeBlock(item.code)); return figure;
    };
    const renderLibrary = () => {
      const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const matches = item => words.every(word => `${item.title} ${item.desc} ${item.code}`.toLowerCase().includes(word));
      const wrap = element("div", "snippet-library"), chips = element("div", "snippet-categories"), intro = element("p", "snippet-intro"), list = element("div", "snippet-list");
      chips.setAttribute("role", "tablist"); chips.setAttribute("aria-label", "코드 조각 범주");
      const fill = () => {
        const category = Snippets.CATEGORIES.find(entry => entry.id === snippetCategory);
        const items = words.length && snippetCategory === "all" ? Snippets.ALL.filter(matches) : (category?.items || []).filter(item => !words.length || matches(item));
        intro.textContent = snippetCategory === "all" ? `검색 결과 ${items.length}개` : category?.desc || "";
        list.replaceChildren(...items.map(snippetCard));
        if(!items.length) list.append(element("p", "guide-empty", "이 범주에는 검색어와 맞는 조각이 없습니다."));
        for(const chip of chips.children) { const active = chip.dataset.category === snippetCategory; chip.classList.toggle("is-active", active); chip.setAttribute("aria-selected", String(active)); }
      };
      const chip = (id, label, count) => {
        const button = element("button"); button.type = "button"; button.dataset.category = id; button.setAttribute("role", "tab");
        button.append(document.createTextNode(label), element("span", "", String(count)));
        button.addEventListener("click", () => { snippetCategory = id; fill(); }); chips.append(button);
      };
      if(words.length) chip("all", "전체 검색", Snippets.ALL.filter(matches).length);
      for(const category of Snippets.CATEGORIES) {
        const count = words.length ? category.items.filter(matches).length : category.items.length;
        if(!words.length || count) chip(category.id, category.title, count);
      }
      if(words.length && snippetCategory !== "all") snippetCategory = "all";
      if(!words.length && snippetCategory === "all") snippetCategory = Snippets.CATEGORIES[0].id;
      fill(); wrap.append(chips, intro, list); return wrap;
    };
    // ---- GLSL 내장 함수 레퍼런스 (범주 탭 + 검색 필터) ----
    let referenceCategory = Reference.CATEGORIES[0].id;
    const referenceItem = item => {
      const row = element("article", "ref-item"), head = element("header", "ref-head");
      head.append(element("strong", "ref-name", item.name), highlighter.paint(element("code", "ref-sig"), item.sig)); row.append(head, rich("p", item.desc, "ref-desc"));
      if(item.c) { const c = element("p", "ref-c"); c.append(element("span", "", "C 대응"), element("code", "", item.c)); row.append(c); }
      if(item.ex) {
        const ex = element("div", "ref-ex"), copy = element("button", "", "복사"); copy.type = "button";
        copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(item.ex); flash(copy, "복사됨"); } catch (_) { flash(copy, "복사 실패"); } });
        ex.append(codeBlock(item.ex), copy); row.append(ex);
      }
      return row;
    };
    const renderReference = () => {
      const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const matches = item => words.every(word => `${item.name} ${item.sig} ${item.desc} ${item.c || ""} ${item.ex || ""}`.toLowerCase().includes(word));
      const wrap = element("div", "snippet-library ref-library"), chips = element("div", "snippet-categories"), intro = element("p", "snippet-intro"), list = element("div", "ref-list");
      chips.setAttribute("role", "tablist"); chips.setAttribute("aria-label", "내장 함수 범주");
      if(words.length) referenceCategory = "all"; else if(referenceCategory === "all") referenceCategory = Reference.CATEGORIES[0].id;
      const fill = () => {
        const category = Reference.CATEGORIES.find(entry => entry.id === referenceCategory);
        const items = referenceCategory === "all" ? Reference.ALL.filter(matches) : (category?.items || []);
        intro.textContent = referenceCategory === "all" ? `검색 결과 ${items.length}개` : category?.desc || "";
        list.replaceChildren(...items.map(referenceItem));
        if(!items.length) list.append(element("p", "guide-empty", "검색어와 맞는 내장 함수가 없습니다."));
        for(const chip of chips.children) { const active = chip.dataset.category === referenceCategory; chip.classList.toggle("is-active", active); chip.setAttribute("aria-selected", String(active)); }
      };
      const chip = (id, label, count) => {
        const button = element("button"); button.type = "button"; button.dataset.category = id; button.setAttribute("role", "tab");
        button.append(document.createTextNode(label), element("span", "", String(count)));
        button.addEventListener("click", () => { referenceCategory = id; fill(); }); chips.append(button);
      };
      if(words.length) chip("all", "검색 결과", Reference.ALL.filter(matches).length);
      else for(const category of Reference.CATEGORIES) chip(category.id, category.title, category.items.length);
      fill(); wrap.append(chips, intro, list); return wrap;
    };
    const renderBlock = block => {
      if(block.library) return renderLibrary();
      if(block.reference) return renderReference();
      if(block.p) return rich("p", block.p);
      if(block.note) return rich("p", block.note, "guide-note");
      if(block.list || block.steps) { const list = element(block.steps ? "ol" : "ul", block.steps ? "guide-steps" : "guide-list"); for(const item of block.list || block.steps) list.append(rich("li", item)); return list; }
      if(block.table) {
        const table = element("table", "guide-table"), head = element("tr");
        for(const cell of block.table.head) head.append(element("th", "", cell));
        table.append(head); for(const row of block.table.rows) { const tr = element("tr"); row.forEach((cell, i) => tr.append(i === 0 ? element("td", "guide-key", cell) : rich("td", cell))); table.append(tr); }
        const wrap = element("div", "guide-table-wrap"); wrap.append(table); return wrap;
      }
      if(block.keys) { const list = element("div", "guide-keys"); for(const [label, key] of block.keys) list.append(element("span", "", label), element("kbd", "", key)); return list; }
      if(block.actions) { const row = element("div", "guide-actions"); for(const action of block.actions) { const button = element("button", "", action.label); button.type = "button"; button.addEventListener("click", () => runAction(action.run)); row.append(button); } return row; }
      if(block.code) return codeFigure(block);
      // ---- 입문 과정 블록 ----
      if(block.heading) return rich("h4", block.heading, "guide-subhead");
      if(block.progress) return progressBlock();
      if(block.try) {
        const box = element("section", "guide-try"), list = element("ol");
        box.append(element("strong", "", "직접 해보기")); for(const item of block.try) list.append(rich("li", item)); box.append(list); return box;
      }
      if(block.compare) {
        const grid = element("div", "guide-compare");
        grid.append(codeFigure({code:block.compare.c, title:block.compare.cTitle || "C"}), codeFigure({code:block.compare.glsl, title:block.compare.glslTitle || "GLSL"})); return grid;
      }
      if(block.solution) {
        const box = element("details", "guide-solution");
        box.append(element("summary", "", block.title || "정답 보기 · 예시 풀이"), codeFigure({code:block.solution, title:"예시 풀이", start:true})); return box;
      }
      if(block.project) {
        const row = element("div", "guide-actions guide-project"), button = element("button", "primary", block.label || "프로젝트 불러오기");
        button.type = "button"; button.addEventListener("click", () => runAction(`course:${block.project}`)); row.append(button); return row;
      }
      return element("div");
    };
    // 코드 블록: 복사 + (선택) 커서 위치 삽입 · 현재 패스 교체 · 이 코드로 새 프로젝트 시작.
    const codeFigure = block => {
      const figure = element("figure", "guide-code"), bar = element("figcaption"), pre = codeBlock(block.code);
      bar.append(element("span", "", block.title || "GLSL"));
      const copy = element("button", "", "복사"); copy.type = "button";
      copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(block.code); flash(copy, "복사됨"); } catch (_) { flash(copy, "복사 실패"); } });
      bar.append(copy);
      if(block.insert) {
        const insert = element("button", "guide-insert", block.insert === "replace" ? "현재 패스를 이 코드로 교체" : "편집기에 삽입"); insert.type = "button";
        insert.addEventListener("click", async () => {
          const ok = await studio.insertSnippet(block.code, block.insert === "replace");
          if(ok) { dialog.close(); } else flash(insert, "삽입 취소됨");
        });
        bar.append(insert);
      }
      if(block.start) {
        const start = element("button", "guide-insert", "이 코드로 시작"); start.type = "button";
        start.title = "현재 프로젝트를 이 코드 하나(단일 패스)로 바꿉니다 · 편집기에서 Ctrl+Z로 되돌릴 수 있습니다";
        start.addEventListener("click", () => loadProject({image:block.code, passes:[], imageChannels:{}}));
        bar.append(start);
      }
      figure.append(bar, pre); return figure;
    };
    const progressBlock = () => {
      const count = LESSON_IDS.filter(id => done.has(id)).length, total = LESSON_IDS.length, wrap = element("div", "guide-progress");
      const bar = element("div", "guide-progress-bar"), fill = element("span"); fill.style.width = `${Math.round(count / total * 100)}%`; bar.append(fill);
      bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-label", "입문 과정 진행률");
      bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", String(total)); bar.setAttribute("aria-valuenow", String(count));
      wrap.append(element("span", "guide-progress-label", count === total ? `모든 단계를 마쳤습니다 · ${total} / ${total}` : `진행 ${count} / ${total}`), bar);
      const next = ALL.find(topic => topic.id === LESSON_IDS.find(id => !done.has(id)));
      if(next && count) { const resume = element("button", "primary", `이어서: ${navTitle(next)} →`); resume.type = "button"; resume.addEventListener("click", () => show(next.id)); wrap.append(resume); }
      return wrap;
    };
    // 단계 하단: 이전 / 완료 표시 / 다음
    const lessonFoot = topic => {
      const at = COURSE_ORDER.indexOf(topic.id), foot = element("nav", "guide-lesson-foot"); foot.setAttribute("aria-label", "입문 과정 이동");
      const go = (id, label, className = "") => { const button = element("button", className, label); button.type = "button"; button.addEventListener("click", () => show(id)); return button; };
      const titleOfTopic = id => navTitle(ALL.find(item => item.id === id));
      foot.append(at > 0 ? go(COURSE_ORDER[at - 1], `← ${titleOfTopic(COURSE_ORDER[at - 1])}`, "guide-lesson-prev") : element("span"));
      if(topic.step) {
        const finished = done.has(topic.id), mark = element("button", finished ? "guide-lesson-mark is-done" : "guide-lesson-mark", finished ? "✓ 완료함" : "완료로 표시");
        mark.type = "button"; mark.setAttribute("aria-pressed", String(finished));
        mark.addEventListener("click", () => { if(done.has(topic.id)) done.delete(topic.id); else done.add(topic.id); saveDone(); markNav(); const fresh = lessonFoot(topic); foot.replaceWith(fresh); fresh.querySelector(".guide-lesson-mark")?.focus(); });
        foot.append(mark);
      }
      if(at < COURSE_ORDER.length - 1) foot.append(go(COURSE_ORDER[at + 1], `${titleOfTopic(COURSE_ORDER[at + 1])} →`, "primary guide-lesson-next"));
      return foot;
    };
    const markNav = () => { for(const button of nav.querySelectorAll("button")) button.classList.toggle("is-done", done.has(button.dataset.topic)); };
    const show = id => {
      const topic = ALL.find(item => item.id === id) || ALL[0]; current = topic.id;
      try { localStorage.setItem(LAST_KEY, topic.id); } catch (_) {}
      const header = element("header", "guide-topic-head");
      if(topic.step) header.append(element("span", "section-index", `입문 과정 · STEP ${String(topic.step).padStart(2, "0")} / ${LESSON_IDS.length}`));
      header.append(element("h3", "", topic.title), element("p", "", topic.summary));
      content.replaceChildren(header, ...topic.blocks.map(renderBlock), ...(topic.course ? [lessonFoot(topic)] : [])); content.scrollTop = 0;
      for(const button of nav.querySelectorAll("button")) {
        const active = button.dataset.topic === topic.id; button.classList.toggle("is-active", active); button.setAttribute("aria-current", active ? "page" : "false");
        if(active && dialog.open) button.scrollIntoView?.({block:"nearest", inline:"nearest"});
      }
    };
    // 검색: 제목·요약·본문 텍스트에서 모든 단어를 포함하는 주제만 남긴다.
    const topicText = topic => [topic.title, topic.summary, ...topic.blocks.flatMap(b => [b.p, b.note, b.code, b.title, b.heading, b.solution, b.compare?.c, b.compare?.glsl,
      ...(b.list || b.steps || b.try || []), ...(b.table ? b.table.rows.flat() : []), ...(b.keys ? b.keys.flat() : []),
      ...(b.library ? Snippets.ALL.flatMap(item => [item.title, item.desc, item.code]) : []),
      ...(b.reference ? Reference.ALL.flatMap(item => [item.name, item.sig, item.desc, item.c, item.ex]) : [])])].filter(Boolean).join(" ").toLowerCase();
    const index = new Map(ALL.map(topic => [topic.id, topicText(topic)]));
    const renderNav = () => {
      const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const visible = ALL.filter(topic => words.every(word => index.get(topic.id).includes(word)));
      const items = []; let group = "";
      for(const topic of visible) {
        // 검색 중에는 결과만 촘촘하게 보이도록 묶음 제목을 생략한다.
        if(!words.length && topic.group && topic.group !== group) items.push(element("p", "guide-nav-group", topic.group));
        group = topic.group;
        const button = element("button", done.has(topic.id) ? "is-done" : ""); button.type = "button"; button.dataset.topic = topic.id; button.title = `${topic.title} — ${topic.summary}`;
        button.append(element("strong", "", navTitle(topic)), element("span", "", topic.summary));
        button.addEventListener("click", () => show(topic.id)); items.push(button);
      }
      nav.replaceChildren(...items);
      if(!visible.length) nav.append(element("p", "guide-empty", "검색 결과가 없습니다."));
      else if(!visible.some(topic => topic.id === current)) show(visible[0].id); else show(current);
    };
    // 터치 기기에서는 검색창에 자동 포커스하면 가상 키보드가 본문을 가리므로 본문에 포커스한다.
    const touchOnly = window.matchMedia?.("(hover:none) and (pointer:coarse)").matches === true; if(touchOnly) content.autofocus = true;
    const open = (id = current) => { search.value = ""; renderNav(); show(id); if(!dialog.open) dialog.showModal(); if(!touchOnly) setTimeout(() => search.focus(), 0); };
    listen(search, "input", renderNav);
    listen(search, "keydown", event => { if(event.key === "Enter") { event.preventDefault(); nav.querySelector("button")?.click(); content.focus(); } });
    listen($("guideTour"), "click", () => { dialog.close(); startTour(); });
    // ui.js가 dialog를 직접 여는 경우(? 키·툴바)에도 내용이 채워져 있도록 열릴 때마다 동기화한다.
    // ? 키·툴바 버튼(ui.js)은 이 요청 이벤트로 가이드를 연다. 처리했음을 preventDefault로 알린다.
    listen(document, "guide-open-request", event => { event.preventDefault(); open(); });
    // dialog를 다른 경로로 직접 연 경우의 보조 동기화. toggle 이벤트는 최신 브라우저에서만 발생한다(Chrome 132+ 등).
    listen(dialog, "toggle", () => { if(dialog.open && !nav.children.length) { renderNav(); show(current); } });
    // 목록은 처음부터 채워 둔다. toggle 이벤트가 없는 브라우저에서도 dialog를 열면 바로 목록이 보인다.
    renderNav();
    // 문맥 도움말: data-guide="주제" 요소를 누르면 그 주제를 연다.
    listen(document, "click", event => {
      const trigger = event.target instanceof Element ? event.target.closest("[data-guide]") : null; if(!trigger) return;
      event.preventDefault(); event.stopPropagation(); open(trigger.dataset.guide);
    }, {capture:true});
    // ---- UI 둘러보기 ----
    const openPanel = tab => {
      if(document.body.classList.contains("panel-hidden")) $("panelToggle").click();
      document.querySelector(`#panelTabs [data-tab="${tab}"]`)?.click();
    };
    // 좁은 화면에서는 패널이 뷰포트를 덮으므로, 화면 요소를 설명하는 단계에서는 패널을 닫는다.
    const closeOverlayPanel = () => {
      if(window.matchMedia?.("(max-width:820px)").matches && !document.body.classList.contains("panel-hidden")) $("panelToggle").click();
    };
    const prepareStep = action => {
      if(!action) return;
      if(action.startsWith("panel:")) openPanel(action.slice(6));
      else if(action === "open-editor") studio.open();
      else if(action === "stage") closeOverlayPanel();
      else if(action === "close-editor") { if(!$("studioDock").hidden) studio.close(); closeOverlayPanel(); }
    };
    const overlay = element("div", "guide-tour"); overlay.hidden = true; overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-labelledby", "guideTourTitle");
    const spot = element("div", "guide-tour-spot"), card = element("div", "guide-tour-card");
    const stepLabel = element("span", "guide-tour-step"), title = element("h3"), text = element("p"), tools = element("div", "guide-tour-tools");
    title.id = "guideTourTitle";
    const prev = element("button", "", "이전"), next = element("button", "primary", "다음"), skip = element("button", "guide-tour-skip", "닫기");
    for(const button of [prev, next, skip]) button.type = "button";
    tools.append(skip, prev, next); card.append(stepLabel, title, text, tools); overlay.append(spot, card); document.body.append(overlay);
    let step = 0, tourActive = false;
    const place = () => {
      if(!tourActive) return;
      const item = TOUR[step], target = document.querySelector(item.target), rect = target?.getBoundingClientRect();
      const visible = rect && rect.width > 0 && rect.height > 0, pad = 6, vw = window.innerWidth, vh = window.innerHeight;
      // 화면보다 긴 패널은 보이는 부분만 강조한다.
      if(visible) { const top = Math.max(rect.top - pad, 4), bottom = Math.min(rect.bottom + pad, vh - 4);
        Object.assign(spot.style, {left:`${rect.left - pad}px`, top:`${top}px`, width:`${rect.width + pad*2}px`, height:`${Math.max(0, bottom - top)}px`}); spot.hidden = false; }
      else spot.hidden = true;
      // 카드: 대상 아래 → 위 → 오른쪽 → 화면 중앙 순으로 들어갈 자리를 찾는다.
      const cw = Math.min(340, vw - 24), ch = card.offsetHeight || 180; let left = (vw - cw) / 2, top = (vh - ch) / 2;
      if(visible) {
        left = Math.min(Math.max(12, rect.left), vw - cw - 12);
        if(rect.bottom + 14 + ch < vh) top = rect.bottom + 14;
        else if(rect.top - 14 - ch > 0) top = rect.top - 14 - ch;
        else if(rect.right + 14 + cw < vw) { left = rect.right + 14; top = Math.min(Math.max(12, rect.top), vh - ch - 12); }
        else if(rect.left - 14 - cw > 0) { left = rect.left - 14 - cw; top = Math.min(Math.max(12, rect.top), vh - ch - 12); }
        // 들어갈 자리가 없을 만큼 큰 대상은 제목·상단 내용이 보이도록 카드를 화면 아래쪽에 붙인다.
        else { left = (vw - cw) / 2; top = Math.max(12, vh - ch - 12); }
      }
      Object.assign(card.style, {left:`${left}px`, top:`${top}px`, width:`${cw}px`});
    };
    const showStep = index => {
      step = Math.max(0, Math.min(TOUR.length - 1, index)); const item = TOUR[step];
      prepareStep(item.prepare);
      stepLabel.textContent = `${step + 1} / ${TOUR.length}`; title.textContent = item.title; text.textContent = item.text;
      prev.disabled = step === 0; next.textContent = step === TOUR.length - 1 ? "완료" : "다음";
      document.querySelector(item.target)?.scrollIntoView?.({block:"nearest", inline:"nearest"});
      // 패널·편집기가 열리며 레이아웃이 바뀌므로 다음 프레임에 위치를 계산한다.
      requestAnimationFrame(() => requestAnimationFrame(place)); next.focus();
    };
    const endTour = () => { tourActive = false; overlay.hidden = true; $("helpToggle")?.focus(); };
    const startTour = () => { if(dialog.open) dialog.close(); tourActive = true; overlay.hidden = false; showStep(0); };
    listen(prev, "click", () => showStep(step - 1));
    listen(next, "click", () => step === TOUR.length - 1 ? endTour() : showStep(step + 1));
    listen(skip, "click", endTour);
    listen(overlay, "keydown", event => {
      event.stopPropagation(); // 투어 중에는 E/H/F 같은 전역 단축키가 화면을 바꾸지 않게 한다.
      if(event.key === "Escape") { event.preventDefault(); endTour(); }
      else if(event.key === "ArrowRight") { event.preventDefault(); next.click(); }
      else if(event.key === "ArrowLeft") { event.preventDefault(); if(step) showStep(step - 1); }
    });
    listen(window, "resize", place);
    listen($("galleryTour"), "click", () => { $("gallery")?.close(); startTour(); });
    return {open, show, startTour, dispose:() => { controller.abort(); overlay.remove(); }};
  }; return {mount,TOPICS};
})(snippets, course, glsl_reference, glsl_highlight);
((Renderer, Shader, UI, Input, Settings, Studio, Profiler, Gallery, Guide, Reference, Snippets)=>{
// 앱 조립 진입점. 범용 기본 GLSL과 Ray Marching 프리셋은 shader.js, GPU 렌더링은 renderer.js가 담당한다.











  // 편집기 시그니처 힌트용 사전: "sin · cos · tan", "atan (2인수)"처럼 묶인 항목을 함수 이름별로 펼치고 같은 이름은 합친다.
  const builtinDocs = new Map();
  for(const item of Reference.ALL) for(const raw of item.name.split("·")) {
    const name = raw.replace(/\(.*\)/, "").trim(); if(!/^[A-Za-z_]\w*$/.test(name)) continue;
    const entry = builtinDocs.get(name);
    if(entry) { if(!entry.sig.includes(item.sig)) entry.sig += ` · ${item.sig}`; } else builtinDocs.set(name, {sig:item.sig, desc:item.desc});
  }
  const lookup = name => builtinDocs.get(name) || null;
  const builtins = [...builtinDocs].map(([name, doc]) => ({name, ...doc}));
  // 자동 완성에서 고를 수 있는 코드 조각 함수: 전역 함수 조각마다 마지막에 정의되는 함수(대표 함수) 이름으로 제안한다.
  const libraryItems = Snippets.ALL.filter(item => !item.replace && (item.scope || "global") === "global").map(item => {
    const names = Snippets.definedNames(item.code); return names.length ? {id:item.id, name:names[names.length-1], title:item.title, desc:item.desc} : null;
  }).filter(Boolean);

  const canvas = document.getElementById("screen"), status = document.getElementById("status");
  let renderer = null, ui = null, input = null, settings = null, studio = null, profiler = null, gallery = null, guide = null; const initialize = async () => {
    try {
      renderer = Renderer.createRenderer(canvas, Shader, message => {
        status.textContent = message; if(message) console.warn(message);
      });
      input = Input.mount(canvas,renderer,Shader.orbitHome); // 카메라 Uniform은 Starter가 등록할 때만 사용한다.
      settings = Settings.mount(renderer); settings.load(); // 저장 설정의 사용자 Uniform 복원
      await renderer.restoreTextures(); // 프로젝트 채널 연결을 복원하기 전에 이미지 파일을 복구한다.
      ui = UI.mount(renderer, input, settings); studio = Studio.mount(renderer, Shader, settings, {lookup, builtins, snippets:{items:libraryItems, plan:Snippets.plan}}); profiler = Profiler.mount(renderer); gallery = Gallery.mount({studio, Shader}); guide = Guide.mount({studio, gallery}); renderer.start(); status.textContent = "";
      // HTML 패널 없이도 사용자 설정과 키 이벤트를 직접 제어할 수 있다.
      window.shaderPlayground = renderer; window.shaderInput = input; window.shaderSettings = settings;
      window.shaderStudio = studio; window.addEventListener("beforeunload", () => {
        guide?.dispose(); gallery?.dispose(); profiler?.dispose(); studio?.dispose(); settings?.dispose(); ui?.dispose(); input?.dispose(); renderer?.dispose();
        delete window.shaderPlayground; delete window.shaderInput; delete window.shaderSettings; delete window.shaderStudio;
      }, {once:true});
    } catch(error) {
      guide?.dispose(); gallery?.dispose(); profiler?.dispose(); studio?.dispose(); settings?.dispose(); ui?.dispose(); input?.dispose(); renderer?.dispose();
      console.error(error); status.textContent = error.message;
    }};initialize();
})(renderer, shader, ui, input, settings, studio, profiler, gallery, guide, glsl_reference, snippets);
})();
