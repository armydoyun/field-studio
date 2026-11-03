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
  return {clearErrors,reflectUniforms,describeLocations,createGpuTimer};
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
  }; return {createPassManager,makeLocations};
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
    const makeData = type => {
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
      return writeData({type,value:normalized,data:makeData(type),options:nextOptions});
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
  return {create};
})();
const glsl_language=(()=>{
// GLSL 언어 정보와 분석: 키워드·타입·앱 Uniform·심볼 표·타입 추론·설명·자동 완성 후보. 편집기 화면과 무관한 순수 로직이다.
// 기본 편집기(code-editor.js)와 CodeMirror 편집기(cm-editor.js)가 함께 쓴다.
// ctx: {options:{builtins, lookup, library, userUniforms}, uniformNames:() => [이름], highlighter:glsl-highlight 인스턴스, source:() => 현재 소스}
  const create = ctx => {
    const options = ctx.options || {}, uniformNames = ctx.uniformNames || (() => []), highlighter = ctx.highlighter, source = ctx.source;
    const lineStartsOf = src => { const starts = [0]; for(let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i+1)) starts.push(i+1); return starts; };
    const lineIndexAt = (starts, offset) => { let lo = 0, hi = starts.length-1; while(lo < hi) { const mid = (lo+hi+1) >> 1; if(starts[mid] <= offset) lo = mid; else hi = mid-1; } return lo; };
    // 주석·문자열·전처리문을 제외한다. 함수 탐색은 최상위 정의만 열거한다.
    const cleanSource = source => source.replace(/^[ \t]*#(?:[^\n]*\\\r?\n)*[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\])*"/gm,s=>s.replace(/[^\n]/g," "));

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
    const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const userUniforms = () => options.userUniforms?.() || uniformNames().map(name => ({name, type:""}));

    // 주석·문자열을 같은 길이 공백으로 지운 사본(위치 보존). 같은 소스면 다시 계산하지 않는다.
    let cleanCache = {src:null, clean:""};
    const cleanOf = src => { if(cleanCache.src !== src) cleanCache = {src, clean:cleanSource(src)}; return cleanCache.clean; };

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
      const vars = symbolsOf(source()).variables.filter(v => v.name === name); if(!vars.length) return BUILTIN_VARS[name] || APP_UNIFORMS.find(u => u[0] === name)?.[1] || "";
      const before = vars.filter(v => v.offset <= pos); return (before.length ? before[before.length-1] : vars[0]).type;
    };

    // 설명: 함수(내장·이 패스) / 변수·Uniform·구조체·#define — 시그니처 힌트와 마우스 설명이 함께 쓴다.
    const describeFunction = name => {
      const builtin = options.lookup?.(name); if(builtin) return {sig:builtin.sig, desc:builtin.desc};
      const own = symbolsOf(source()).functions.find(entry => entry.name === name);
      return own ? {sig:`${own.ret} ${name}(${own.params})`, desc:`이 패스에 정의된 함수 · ${own.line}번째 줄`} : null;
    };
    const describeSymbol = (name, pos) => {
      const fn = describeFunction(name); if(fn) return fn;
      const sym = symbolsOf(source()), app = APP_UNIFORMS.find(u => u[0] === name);
      const vars = sym.variables.filter(v => v.name === name), decl = vars.filter(v => v.offset <= pos).pop() || vars[0];
      if(decl) return {sig:`${decl.uniform ? "uniform " : decl.output ? "out " : ""}${decl.type} ${name}`, desc:app ? app[2] : `${decl.uniform ? "Uniform" : decl.output ? "출력" : "변수"} · ${decl.line}번째 줄에서 선언`};
      if(app) return {sig:`uniform ${app[1]} ${name}`, desc:`${app[2]} · 아직 선언되지 않음`};
      const param = userUniforms().find(u => u.name === name); if(param) return {sig:`uniform ${param.type} ${name}`, desc:"파라미터 패널에 등록된 값 · 선언은 자동으로 추가됩니다"};
      const struct = sym.structs.get(name); if(struct) return {sig:`struct ${name} { ${struct.fields.map(f => `${f.type} ${f.name};`).join(" ")} }`, desc:`구조체 · ${struct.line}번째 줄`};
      const define = sym.defines.find(d => d.name === name); if(define) return {sig:`#define ${name} ${define.value}`, desc:`매크로 · ${define.line}번째 줄`};
      return null;
    };

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

    return {KEYWORDS, TYPES, APP_UNIFORMS, BUILTIN_VARS, isIdent, escapeRe, userUniforms, cleanSource, cleanOf, symbolsOf, typeOf, describeFunction, describeSymbol, SNIPPETS, boundaryAt, fuzzy, KIND_ORDER, KIND_ICON, KIND_NAME, swizzleItems, gatherItems, declaringName};
  };
  return {create};
})();
const codemirror=(()=>{
// CodeMirror 6 vendored bundle for FIELD Studio — generated by tools/codemirror/build.mjs. Do not edit by hand.
// @codemirror/state@6.7.6, @codemirror/view@6.43.15, @codemirror/commands@6.11.1, @codemirror/language@6.13.1, @codemirror/search@6.7.2, @codemirror/autocomplete@6.20.4, @codemirror/lint@6.9.7, @lezer/common@1.5.5, @lezer/highlight@1.2.5, style-mod@4.1.4, w3c-keyname@2.2.8, crelt@1.0.7
// Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others. MIT License (see tools/codemirror/LICENSE).
// API: load() → { EditorState, EditorSelection, Compartment, StateEffect, StateField, Annotation, Transaction, Prec, RangeSetBuilder, EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, hoverTooltip, Decoration, ViewPlugin, WidgetType, showTooltip, scrollPastEnd, placeholder, highlightTrailingWhitespace, closeHoverTooltips, defaultKeymap, indentWithTab, toggleComment, toggleBlockComment, indentMore, indentLess, selectLine, deleteLine, cursorMatchingBracket, addCursorAbove, addCursorBelow, copyLineDown, copyLineUp, moveLineDown, moveLineUp, insertBlankLine, selectAll, toggleTabFocusMode, StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput, indentUnit, foldGutter, foldKeymap, foldService, codeFolding, foldAll, unfoldAll, foldCode, unfoldCode, search, searchKeymap, openSearchPanel, closeSearchPanel, highlightSelectionMatches, gotoLine, selectNextOccurrence, selectSelectionMatches, autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion, closeCompletion, snippet, setDiagnostics, lintGutter, lintKeymap, nextDiagnostic, previousDiagnostic, openLintPanel, closeLintPanel, Tag, tags }
let loaded = null;
const load = () => loaded || (loaded = (()=>{var br=Object.defineProperty;var Id=Object.getOwnPropertyDescriptor;var Nd=Object.getOwnPropertyNames;var Fd=Object.prototype.hasOwnProperty;var Hd=(n,e)=>{for(var t in e)br(n,t,{get:e[t],enumerable:!0})},Wd=(n,e,t,i)=>{if(e&&typeof e=="object"||typeof e=="function")for(let s of Nd(e))!Fd.call(n,s)&&s!==t&&br(n,s,{get:()=>e[s],enumerable:!(i=Id(e,s))||i.enumerable});return n};var Vd=n=>Wd(br({},"__esModule",{value:!0}),n);var lb={};Hd(lb,{Annotation:()=>xe,Compartment:()=>ni,Decoration:()=>B,EditorSelection:()=>b,EditorState:()=>U,EditorView:()=>O,HighlightStyle:()=>Si,Prec:()=>Se,RangeSetBuilder:()=>pe,StateEffect:()=>L,StateField:()=>_,StreamLanguage:()=>Es,Tag:()=>Ee,Transaction:()=>ne,ViewPlugin:()=>K,WidgetType:()=>re,addCursorAbove:()=>Ul,addCursorBelow:()=>Gl,autocompletion:()=>vd,bracketMatching:()=>nu,closeBrackets:()=>gd,closeBracketsKeymap:()=>xd,closeCompletion:()=>Ba,closeHoverTooltips:()=>uf,closeLintPanel:()=>dr,closeSearchPanel:()=>nr,codeFolding:()=>Ns,completionKeymap:()=>Ra,copyLineDown:()=>Jl,copyLineUp:()=>Xl,crosshairCursor:()=>af,cursorMatchingBracket:()=>Kl,defaultKeymap:()=>$u,deleteLine:()=>Ql,drawSelection:()=>Qc,dropCursor:()=>tf,foldAll:()=>Bl,foldCode:()=>Dl,foldGutter:()=>Jf,foldKeymap:()=>Yf,foldService:()=>Tl,gotoLine:()=>ha,highlightActiveLine:()=>rf,highlightActiveLineGutter:()=>wf,highlightSelectionMatches:()=>Ju,highlightSpecialChars:()=>nf,highlightTrailingWhitespace:()=>vf,hoverTooltip:()=>ws,indentLess:()=>Ks,indentMore:()=>qs,indentOnInput:()=>$f,indentUnit:()=>Ct,indentWithTab:()=>ju,insertBlankLine:()=>Zl,keymap:()=>wi,lineNumbers:()=>xf,lintGutter:()=>Pd,lintKeymap:()=>Od,moveLineDown:()=>Yl,moveLineUp:()=>_l,nextDiagnostic:()=>Ha,openLintPanel:()=>Fa,openSearchPanel:()=>ir,placeholder:()=>of,previousDiagnostic:()=>Dd,rectangularSelection:()=>lf,scrollPastEnd:()=>sf,search:()=>Qu,searchKeymap:()=>td,selectAll:()=>$l,selectLine:()=>jl,selectNextOccurrence:()=>ca,selectSelectionMatches:()=>ua,setDiagnostics:()=>Ad,showTooltip:()=>bt,snippet:()=>dd,startCompletion:()=>wn,syntaxHighlighting:()=>Zf,tags:()=>T,toggleBlockComment:()=>zl,toggleComment:()=>Wl,toggleTabFocusMode:()=>ta,unfoldAll:()=>Ll,unfoldCode:()=>Ol});var wr=[],ja=[];(()=>{let n="lc,34,7n,7,7b,19,,,,2,,2,,,20,b,1c,l,g,,2t,7,2,6,2,2,,4,z,,u,r,2j,b,1m,9,9,,o,4,,9,,3,,5,17,3,1n,9,16,o,,x,1i,3,,i,,7,a,2,t,3,1k,,,7,2,2,2,3,9,,a,2,q,,2,3,1k,,,5,4,2,2,3,3,,u,2,3,,b,3,1k,,,8,,3,,3,k,2,m,6,,3,1k,,,7,2,2,2,3,7,3,a,2,u,,1n,5,3,3,,4,9,,14,5,1j,,,7,,3,,4,7,2,b,2,t,3,1k,,,7,,3,,4,7,2,b,2,f,,c,4,1j,2,,7,,3,,4,9,,a,2,t,3,1y,,4,6,,,,8,i,2,1p,,,8,c,8,2q,,,a,b,7,21,2,r,,,,,,4,2,1d,k,,2,5,b,,10,9,,2u,b,,6,n,4,4,3,g,4,d,,,3,6,,f,,jj,3,qa,4,s,3,t,2,u,2,1s,w,9,,19,3,,,39,2,y,,3a,c,4,c,63,5,1l,a,,,,,2,o,2,,1c,1a,2,c,k,5,1b,h,12,9,c,3,u,d,1k,e,1c,k,48,3,,l,4,,6,,2,3,5i,1s,ek,,5f,x,2da,3,3x,,2o,w,fe,6,2x,2,n9w,4,,a,w,2,28,2,7k,,3,,4,,n,5,4,,2b,2,1e,i,q,i,d,,12,8,p,d,18,4,1b,e,10,,1v,e,c,,8,2,1a,,1f,,,3,2,2,5,2,,,15,5,5,2,6k,8,,2,fn4,,kh,g,g,g,a6,2,gt,,6a,,45,5,1ae,3,,2,5,4,14,3,4,,4l,2,fx,4,1t,5,8t,2,25,6,1y,b,1d,4,3e,3,1h,f,15,,2,2,a,4,19,b,7,,1p,3,10,e,g,2,18,,c,3,1c,e,8,4,,2,2k,c,6,,2,,4d,c,l,4,1j,2,,7,2,2,2,3,9,,a,2,2,7,3,5,1v,9,,,2,,,4,,5,,,e,2,2a,i,n,,29,k,6j,7,2,9,r,2,2a,h,2y,d,2t,3,2,a,74,f,6t,6,,2,2,4,,,,2,3x,7,2,7,3,,s,a,14,7,,4,8,,9,b,1a,g,5i,8,5j,8,,8,2a,m,,e,3e,6,3,,,2,,7,,,1u,5,,2,,5,9n,4,9,2,,,1c,7,3,5,n,,44l,,6,f,8ug,i,1xc,5,1n,7,t4,,,1j,7,4,29,,b,2,f57,2,3mp,1a,2,n,f2,5,3,6,8,8,2,7,u,4,44,3,1iz,1j,4,1e,8,,e,,m,5,,f,11s,7,,h,2,7,,2,,5,2s,,4g,7,af,,1p,4,e4,4,72,2,6r,,2,,7,2,5,,d6,7,31,7,240,5".split(",").map(e=>e?parseInt(e,36):1);for(let e=0,t=0;e<n.length;e++)(e%2?ja:wr).push(t=t+n[e])})();function zd(n){if(n<768)return!1;for(let e=0,t=wr.length;;){let i=e+t>>1;if(n<wr[i])t=i;else if(n>=ja[i])e=i+1;else return!0;if(e==t)return!1}}function qa(n){return n>=127462&&n<=127487}var Ka=8205;function Ua(n,e,t=!0,i=!0){return(t?Ga:qd)(n,e,i)}function Ga(n,e,t){if(e==n.length)return e;e&&_a(n.charCodeAt(e))&&Ya(n.charCodeAt(e-1))&&e--;let i=xr(n,e);for(e+=$a(i);e<n.length;){let s=xr(n,e);if(i==Ka||s==Ka||t&&zd(s))e+=$a(s),i=s;else if(qa(s)){let r=0,o=e-2;for(;o>=0&&qa(xr(n,o));)r++,o-=2;if(r%2==0)break;e+=2}else break}return e}function qd(n,e,t){for(;e>1;){let i=Ga(n,e-2,t);if(i<e)return i;e--}return 0}function xr(n,e){let t=n.charCodeAt(e);if(!Ya(t)||e+1==n.length)return t;let i=n.charCodeAt(e+1);return _a(i)?(t-55296<<10)+(i-56320)+65536:t}function _a(n){return n>=56320&&n<57344}function Ya(n){return n>=55296&&n<56320}function $a(n){return n<65536?1:2}var N=class n{lineAt(e){if(e<0||e>this.length)throw new RangeError(`Invalid position ${e} in document of length ${this.length}`);return this.lineInner(e,!1,1,0)}line(e){if(e<1||e>this.lines)throw new RangeError(`Invalid line number ${e} in ${this.lines}-line document`);return this.lineInner(e,!0,1,0)}replace(e,t,i){[e,t]=ii(this,e,t);let s=[];return this.decompose(0,e,s,2),i.length&&i.decompose(0,i.length,s,3),this.decompose(t,this.length,s,1),Zt.from(s,this.length-(t-e)+i.length)}append(e){return this.replace(this.length,this.length,e)}slice(e,t=this.length){[e,t]=ii(this,e,t);let i=[];return this.decompose(e,t,i,0),Zt.from(i,t-e)}eq(e){if(e==this)return!0;if(e.length!=this.length||e.lines!=this.lines)return!1;let t=this.scanIdentical(e,1),i=this.length-this.scanIdentical(e,-1),s=new Et(this),r=new Et(e);for(let o=t,l=t;;){if(s.next(o),r.next(o),o=0,s.lineBreak!=r.lineBreak||s.done!=r.done||s.value!=r.value)return!1;if(l+=s.value.length,s.done||l>=i)return!0}}iter(e=1){return new Et(this,e)}iterRange(e,t=this.length){return new Ln(this,e,t)}iterLines(e,t){let i;if(e==null)i=this.iter();else{t==null&&(t=this.lines+1);let s=this.line(e).from;i=this.iterRange(s,Math.max(s,t==this.lines+1?this.length:t<=1?0:this.line(t-1).to))}return new En(i)}toString(){return this.sliceString(0)}toJSON(){let e=[];return this.flatten(e),e}constructor(){}static of(e){if(e.length==0)throw new RangeError("A document must have at least one line");return e.length==1&&!e[0]?n.empty:e.length<=32?new Oe(e):Zt.from(Oe.split(e,[]))}},Oe=class n extends N{constructor(e,t=Kd(e)){super(),this.text=e,this.length=t}get lines(){return this.text.length}get children(){return null}lineInner(e,t,i,s){for(let r=0;;r++){let o=this.text[r],l=s+o.length;if((t?i:l)>=e)return new kr(s,l,i,o);s=l+1,i++}}decompose(e,t,i,s){let r=e<=0&&t>=this.length?this:new n(Xa(this.text,e,t),Math.min(t,this.length)-Math.max(0,e));if(s&1){let o=i.pop(),l=Bn(r.text,o.text.slice(),0,r.length);if(l.length<=32)i.push(new n(l,o.length+r.length));else{let a=l.length>>1;i.push(new n(l.slice(0,a)),new n(l.slice(a)))}}else i.push(r)}replace(e,t,i){if(!(i instanceof n))return super.replace(e,t,i);[e,t]=ii(this,e,t);let s=Bn(this.text,Bn(i.text,Xa(this.text,0,e)),t),r=this.length+i.length-(t-e);return s.length<=32?new n(s,r):Zt.from(n.split(s,[]),r)}sliceString(e,t=this.length,i=`
`){[e,t]=ii(this,e,t);let s="";for(let r=0,o=0;r<=t&&o<this.text.length;o++){let l=this.text[o],a=r+l.length;r>e&&o&&(s+=i),e<a&&t>r&&(s+=l.slice(Math.max(0,e-r),t-r)),r=a+1}return s}flatten(e){for(let t of this.text)e.push(t)}scanIdentical(){return 0}static split(e,t){let i=[],s=-1;for(let r of e)i.push(r),s+=r.length+1,i.length==32&&(t.push(new n(i,s)),i=[],s=-1);return s>-1&&t.push(new n(i,s)),t}},Zt=class n extends N{constructor(e,t){super(),this.children=e,this.length=t,this.lines=0;for(let i of e)this.lines+=i.lines}lineInner(e,t,i,s){for(let r=0;;r++){let o=this.children[r],l=s+o.length,a=i+o.lines-1;if((t?a:l)>=e)return o.lineInner(e,t,i,s);s=l+1,i=a+1}}decompose(e,t,i,s){for(let r=0,o=0;o<=t&&r<this.children.length;r++){let l=this.children[r],a=o+l.length;if(e<=a&&t>=o){let h=s&((o<=e?1:0)|(a>=t?2:0));o>=e&&a<=t&&!h?i.push(l):l.decompose(e-o,t-o,i,h)}o=a+1}}replace(e,t,i){if([e,t]=ii(this,e,t),i.lines<this.lines)for(let s=0,r=0;s<this.children.length;s++){let o=this.children[s],l=r+o.length;if(e>=r&&t<=l){let a=o.replace(e-r,t-r,i),h=this.lines-o.lines+a.lines;if(a.lines<h>>4&&a.lines>h>>6){let c=this.children.slice();return c[s]=a,new n(c,this.length-(t-e)+i.length)}return super.replace(r,l,a)}r=l+1}return super.replace(e,t,i)}sliceString(e,t=this.length,i=`
`){[e,t]=ii(this,e,t);let s="";for(let r=0,o=0;r<this.children.length&&o<=t;r++){let l=this.children[r],a=o+l.length;o>e&&r&&(s+=i),e<a&&t>o&&(s+=l.sliceString(e-o,t-o,i)),o=a+1}return s}flatten(e){for(let t of this.children)t.flatten(e)}scanIdentical(e,t){if(!(e instanceof n))return 0;let i=0,[s,r,o,l]=t>0?[0,0,this.children.length,e.children.length]:[this.children.length-1,e.children.length-1,-1,-1];for(;;s+=t,r+=t){if(s==o||r==l)return i;let a=this.children[s],h=e.children[r];if(a!=h)return i+a.scanIdentical(h,t);i+=a.length+1}}static from(e,t=e.reduce((i,s)=>i+s.length+1,-1)){let i=0;for(let d of e)i+=d.lines;if(i<32){let d=[];for(let p of e)p.flatten(d);return new Oe(d,t)}let s=Math.max(32,i>>5),r=s<<1,o=s>>1,l=[],a=0,h=-1,c=[];function f(d){let p;if(d.lines>r&&d instanceof n)for(let m of d.children)f(m);else d.lines>o&&(a>o||!a)?(u(),l.push(d)):d instanceof Oe&&a&&(p=c[c.length-1])instanceof Oe&&d.lines+p.lines<=32?(a+=d.lines,h+=d.length+1,c[c.length-1]=new Oe(p.text.concat(d.text),p.length+1+d.length)):(a+d.lines>s&&u(),a+=d.lines,h+=d.length+1,c.push(d))}function u(){a!=0&&(l.push(c.length==1?c[0]:n.from(c,h)),h=-1,a=c.length=0)}for(let d of e)f(d);return u(),l.length==1?l[0]:new n(l,t)}};N.empty=new Oe([""],0);function Kd(n){let e=-1;for(let t of n)e+=t.length+1;return e}function Bn(n,e,t=0,i=1e9){for(let s=0,r=0,o=!0;r<n.length&&s<=i;r++){let l=n[r],a=s+l.length;a>=t&&(a>i&&(l=l.slice(0,i-s)),s<t&&(l=l.slice(t-s)),o?(e[e.length-1]+=l,o=!1):e.push(l)),s=a+1}return e}function Xa(n,e,t){return Bn(n,[""],e,t)}var Et=class{constructor(e,t=1){this.dir=t,this.done=!1,this.lineBreak=!1,this.value="",this.nodes=[e],this.offsets=[t>0?1:(e instanceof Oe?e.text.length:e.children.length)<<1]}nextInner(e,t){for(this.done=this.lineBreak=!1;;){let i=this.nodes.length-1,s=this.nodes[i],r=this.offsets[i],o=r>>1,l=s instanceof Oe?s.text.length:s.children.length;if(o==(t>0?l:0)){if(i==0)return this.done=!0,this.value="",this;t>0&&this.offsets[i-1]++,this.nodes.pop(),this.offsets.pop()}else if((r&1)==(t>0?0:1)){if(this.offsets[i]+=t,e==0)return this.lineBreak=!0,this.value=`
`,this;e--}else if(s instanceof Oe){let a=s.text[o+(t<0?-1:0)];if(this.offsets[i]+=t,a.length>Math.max(0,e))return this.value=e==0?a:t>0?a.slice(e):a.slice(0,a.length-e),this;e-=a.length}else{let a=s.children[o+(t<0?-1:0)];e>a.length?(e-=a.length,this.offsets[i]+=t):(t<0&&this.offsets[i]--,this.nodes.push(a),this.offsets.push(t>0?1:(a instanceof Oe?a.text.length:a.children.length)<<1))}}}next(e=0){return e<0&&(this.nextInner(-e,-this.dir),e=this.value.length),this.nextInner(e,this.dir)}},Ln=class{constructor(e,t,i){this.value="",this.done=!1,this.cursor=new Et(e,t>i?-1:1),this.pos=t>i?e.length:0,this.from=Math.min(t,i),this.to=Math.max(t,i)}nextInner(e,t){if(t<0?this.pos<=this.from:this.pos>=this.to)return this.value="",this.done=!0,this;e+=Math.max(0,t<0?this.pos-this.to:this.from-this.pos);let i=t<0?this.pos-this.from:this.to-this.pos;e>i&&(e=i),i-=e;let{value:s}=this.cursor.next(e);return this.pos+=(s.length+e)*t,this.value=s.length<=i?s:t<0?s.slice(s.length-i):s.slice(0,i),this.done=!this.value,this}next(e=0){return e<0?e=Math.max(e,this.from-this.pos):e>0&&(e=Math.min(e,this.to-this.pos)),this.nextInner(e,this.cursor.dir)}get lineBreak(){return this.cursor.lineBreak&&this.value!=""}},En=class{constructor(e){this.inner=e,this.afterBreak=!0,this.value="",this.done=!1}next(e=0){let{done:t,lineBreak:i,value:s}=this.inner.next(e);return t&&this.afterBreak?(this.value="",this.afterBreak=!1):t?(this.done=!0,this.value=""):i?this.afterBreak?this.value="":(this.afterBreak=!0,this.next()):(this.value=s,this.afterBreak=!1),this}get lineBreak(){return!1}};typeof Symbol<"u"&&(N.prototype[Symbol.iterator]=function(){return this.iter()},Et.prototype[Symbol.iterator]=Ln.prototype[Symbol.iterator]=En.prototype[Symbol.iterator]=function(){return this});var kr=class{constructor(e,t,i,s){this.from=e,this.to=t,this.number=i,this.text=s}get length(){return this.to-this.from}};function ii(n,e,t){return e=Math.max(0,Math.min(n.length,e)),[e,Math.max(e,Math.min(n.length,t))]}function ee(n,e,t=!0,i=!0){return Ua(n,e,t,i)}function $d(n){return n>=56320&&n<57344}function jd(n){return n>=55296&&n<56320}function he(n,e){let t=n.charCodeAt(e);if(!jd(t)||e+1==n.length)return t;let i=n.charCodeAt(e+1);return $d(i)?(t-55296<<10)+(i-56320)+65536:t}function Ii(n){return n<=65535?String.fromCharCode(n):(n-=65536,String.fromCharCode((n>>10)+55296,(n&1023)+56320))}function Be(n){return n<65536?1:2}var Sr=/\r\n?|\n/,ie=(function(n){return n[n.Simple=0]="Simple",n[n.TrackDel=1]="TrackDel",n[n.TrackBefore=2]="TrackBefore",n[n.TrackAfter=3]="TrackAfter",n})(ie||(ie={})),ot=class n{constructor(e){this.sections=e}get length(){let e=0;for(let t=0;t<this.sections.length;t+=2)e+=this.sections[t];return e}get newLength(){let e=0;for(let t=0;t<this.sections.length;t+=2){let i=this.sections[t+1];e+=i<0?this.sections[t]:i}return e}get empty(){return this.sections.length==0||this.sections.length==2&&this.sections[1]<0}iterGaps(e){for(let t=0,i=0,s=0;t<this.sections.length;){let r=this.sections[t++],o=this.sections[t++];o<0?(e(i,s,r),s+=r):s+=o,i+=r}}iterChangedRanges(e,t=!1){Cr(this,e,t)}get invertedDesc(){let e=[];for(let t=0;t<this.sections.length;){let i=this.sections[t++],s=this.sections[t++];s<0?e.push(i,s):e.push(s,i)}return new n(e)}composeDesc(e){return this.empty?e:e.empty?this:th(this,e)}mapDesc(e,t=!1){return e.empty?this:Ar(this,e,t)}mapPos(e,t=-1,i=ie.Simple){let s=0,r=0;for(let o=0;o<this.sections.length;){let l=this.sections[o++],a=this.sections[o++],h=s+l;if(a<0){if(h>e)return r+(e-s);r+=l}else{if(i!=ie.Simple&&h>=e&&(i==ie.TrackDel&&s<e&&h>e||i==ie.TrackBefore&&s<e||i==ie.TrackAfter&&h>e))return null;if(h>e||h==e&&t<0&&!l)return e==s||t<0?r:r+a;r+=a}s=h}if(e>s)throw new RangeError(`Position ${e} is out of range for changeset of length ${s}`);return r}touchesRange(e,t=e){for(let i=0,s=0;i<this.sections.length&&s<=t;){let r=this.sections[i++],o=this.sections[i++],l=s+r;if(o>=0&&s<=t&&l>=e)return s<e&&l>t?"cover":!0;s=l}return!1}toString(){let e="";for(let t=0;t<this.sections.length;){let i=this.sections[t++],s=this.sections[t++];e+=(e?" ":"")+i+(s>=0?":"+s:"")}return e}toJSON(){return this.sections}static fromJSON(e){if(!Array.isArray(e)||e.length%2||e.some(t=>typeof t!="number"))throw new RangeError("Invalid JSON representation of ChangeDesc");return new n(e)}static create(e){return new n(e)}},be=class n extends ot{constructor(e,t){super(e),this.inserted=t}apply(e){if(this.length!=e.length)throw new RangeError("Applying change set to a document with the wrong length");return Cr(this,(t,i,s,r,o)=>e=e.replace(s,s+(i-t),o),!1),e}mapDesc(e,t=!1){return Ar(this,e,t,!0)}invert(e){let t=this.sections.slice(),i=[];for(let s=0,r=0;s<t.length;s+=2){let o=t[s],l=t[s+1];if(l>=0){t[s]=l,t[s+1]=o;let a=s>>1;for(;i.length<a;)i.push(N.empty);i.push(o?e.slice(r,r+o):N.empty)}r+=o}return new n(t,i)}compose(e){return this.empty?e:e.empty?this:th(this,e,!0)}map(e,t=!1){return e.empty?this:Ar(this,e,t,!0)}iterChanges(e,t=!1){Cr(this,e,t)}get desc(){return ot.create(this.sections)}filter(e){let t=[],i=[],s=[],r=new Rt(this);e:for(let o=0,l=0;;){let a=o==e.length?1e9:e[o++];for(;l<a||l==a&&r.len==0;){if(r.done)break e;let c=Math.min(r.len,a-l);de(s,c,-1);let f=r.ins==-1?-1:r.off==0?r.ins:0;de(t,c,f),f>0&&dt(i,t,r.text),r.forward(c),l+=c}let h=e[o++];for(;l<h;){if(r.done)break e;let c=Math.min(r.len,h-l);de(t,c,-1),de(s,c,r.ins==-1?-1:r.off==0?r.ins:0),r.forward(c),l+=c}}return{changes:new n(t,i),filtered:ot.create(s)}}toJSON(){let e=[];for(let t=0;t<this.sections.length;t+=2){let i=this.sections[t],s=this.sections[t+1];s<0?e.push(i):s==0?e.push([i]):e.push([i].concat(this.inserted[t>>1].toJSON()))}return e}static of(e,t,i){let s=[],r=[],o=0,l=null;function a(c=!1){if(!c&&!s.length)return;o<t&&de(s,t-o,-1);let f=new n(s,r);l=l?l.compose(f.map(l)):f,s=[],r=[],o=0}function h(c){if(Array.isArray(c))for(let f of c)h(f);else if(c instanceof n){if(c.length!=t)throw new RangeError(`Mismatched change set length (got ${c.length}, expected ${t})`);a(),l=l?l.compose(c.map(l)):c}else{let{from:f,to:u=f,insert:d}=c;if(f>u||f<0||u>t)throw new RangeError(`Invalid change range ${f} to ${u} (in doc of length ${t})`);let p=d?typeof d=="string"?N.of(d.split(i||Sr)):d:N.empty,m=p.length;if(f==u&&m==0)return;f<o&&a(),f>o&&de(s,f-o,-1),de(s,u-f,m),dt(r,s,p),o=u}}return h(e),a(!l),l}static empty(e){return new n(e?[e,-1]:[],[])}static fromJSON(e){if(!Array.isArray(e))throw new RangeError("Invalid JSON representation of ChangeSet");let t=[],i=[];for(let s=0;s<e.length;s++){let r=e[s];if(typeof r=="number")t.push(r,-1);else{if(!Array.isArray(r)||typeof r[0]!="number"||r.some((o,l)=>l&&typeof o!="string"))throw new RangeError("Invalid JSON representation of ChangeSet");if(r.length==1)t.push(r[0],0);else{for(;i.length<s;)i.push(N.empty);i[s]=N.of(r.slice(1)),t.push(r[0],i[s].length)}}}return new n(t,i)}static createSet(e,t){return new n(e,t)}};function de(n,e,t,i=!1){if(e==0&&t<=0)return;let s=n.length-2;s>=0&&t<=0&&t==n[s+1]?n[s]+=e:s>=0&&e==0&&n[s]==0?n[s+1]+=t:i?(n[s]+=e,n[s+1]+=t):n.push(e,t)}function dt(n,e,t){if(t.length==0)return;let i=e.length-2>>1;if(i<n.length)n[n.length-1]=n[n.length-1].append(t);else{for(;n.length<i;)n.push(N.empty);n.push(t)}}function Cr(n,e,t){let i=n.inserted;for(let s=0,r=0,o=0;o<n.sections.length;){let l=n.sections[o++],a=n.sections[o++];if(a<0)s+=l,r+=l;else{let h=s,c=r,f=N.empty;for(;h+=l,c+=a,a&&i&&(f=f.append(i[o-2>>1])),!(t||o==n.sections.length||n.sections[o+1]<0);)l=n.sections[o++],a=n.sections[o++];e(s,h,r,c,f),s=h,r=c}}}function Ar(n,e,t,i=!1){let s=[],r=i?[]:null,o=new Rt(n),l=new Rt(e);for(let a=-1;;){if(o.done&&l.len||l.done&&o.len)throw new Error("Mismatched change set lengths");if(o.ins==-1&&l.ins==-1){let h=Math.min(o.len,l.len);de(s,h,-1),o.forward(h),l.forward(h)}else if(l.ins>=0&&(o.ins<0||a==o.i||o.off==0&&(l.len<o.len||l.len==o.len&&!t))){let h=l.len;for(de(s,l.ins,-1);h;){let c=Math.min(o.len,h);o.ins>=0&&a<o.i&&o.len<=c&&(de(s,0,o.ins),r&&dt(r,s,o.text),a=o.i),o.forward(c),h-=c}l.next()}else if(o.ins>=0){let h=0,c=o.len;for(;c;)if(l.ins==-1){let f=Math.min(c,l.len);h+=f,c-=f,l.forward(f)}else if(l.ins==0&&l.len<c)c-=l.len,l.next();else break;de(s,h,a<o.i?o.ins:0),r&&a<o.i&&dt(r,s,o.text),a=o.i,o.forward(o.len-c)}else{if(o.done&&l.done)return r?be.createSet(s,r):ot.create(s);throw new Error("Mismatched change set lengths")}}}function th(n,e,t=!1){let i=[],s=t?[]:null,r=new Rt(n),o=new Rt(e);for(let l=!1;;){if(r.done&&o.done)return s?be.createSet(i,s):ot.create(i);if(r.ins==0)de(i,r.len,0,l),r.next();else if(o.len==0&&!o.done)de(i,0,o.ins,l),s&&dt(s,i,o.text),o.next();else{if(r.done||o.done)throw new Error("Mismatched change set lengths");{let a=Math.min(r.len2,o.len),h=i.length;if(r.ins==-1){let c=o.ins==-1?-1:o.off?0:o.ins;de(i,a,c,l),s&&c&&dt(s,i,o.text)}else o.ins==-1?(de(i,r.off?0:r.len,a,l),s&&dt(s,i,r.textBit(a))):(de(i,r.off?0:r.len,o.off?0:o.ins,l),s&&!o.off&&dt(s,i,o.text));l=(r.ins>a||o.ins>=0&&o.len>a)&&(l||i.length>h),r.forward2(a),o.forward(a)}}}}var Rt=class{constructor(e){this.set=e,this.i=0,this.next()}next(){let{sections:e}=this.set;this.i<e.length?(this.len=e[this.i++],this.ins=e[this.i++]):(this.len=0,this.ins=-2),this.off=0}get done(){return this.ins==-2}get len2(){return this.ins<0?this.len:this.ins}get text(){let{inserted:e}=this.set,t=this.i-2>>1;return t>=e.length?N.empty:e[t]}textBit(e){let{inserted:t}=this.set,i=this.i-2>>1;return i>=t.length&&!e?N.empty:t[i].slice(this.off,e==null?void 0:this.off+e)}forward(e){e==this.len?this.next():(this.len-=e,this.off+=e)}forward2(e){this.ins==-1?this.forward(e):e==this.ins?this.next():(this.ins-=e,this.off+=e)}},Ot=class n{constructor(e,t,i,s){this.from=e,this.to=t,this.flags=i,this.goalColumn=s}get anchor(){return this.flags&32?this.to:this.from}get head(){return this.flags&32?this.from:this.to}get empty(){return this.from==this.to}get assoc(){return this.flags&8?-1:this.flags&16?1:0}get undirectional(){return(this.flags&64)>0}get bidiLevel(){let e=this.flags&7;return e==7?null:e}map(e,t=-1){let i,s;return this.empty?i=s=e.mapPos(this.from,t):(i=e.mapPos(this.from,1),s=e.mapPos(this.to,-1)),i==this.from&&s==this.to?this:new n(i,s,this.flags,this.goalColumn)}extend(e,t=e,i=0){if(e<=this.anchor&&t>=this.anchor)return b.range(e,t,void 0,void 0,i);let s=Math.abs(e-this.anchor)>Math.abs(t-this.anchor)?e:t;return b.range(this.anchor,s,void 0,void 0,i)}eq(e,t=!1){return this.anchor==e.anchor&&this.head==e.head&&this.goalColumn==e.goalColumn&&(!t||!this.empty||this.assoc==e.assoc)}toJSON(){return{anchor:this.anchor,head:this.head}}static fromJSON(e){if(!e||typeof e.anchor!="number"||typeof e.head!="number")throw new RangeError("Invalid JSON representation for SelectionRange");return b.range(e.anchor,e.head)}static create(e,t,i,s){return new n(e,t,i,s)}},b=class n{constructor(e,t){this.ranges=e,this.mainIndex=t}map(e,t=-1){return e.empty?this:n.create(this.ranges.map(i=>i.map(e,t)),this.mainIndex)}eq(e,t=!1){if(this.ranges.length!=e.ranges.length||this.mainIndex!=e.mainIndex)return!1;for(let i=0;i<this.ranges.length;i++)if(!this.ranges[i].eq(e.ranges[i],t))return!1;return!0}get main(){return this.ranges[this.mainIndex]}asSingle(){return this.ranges.length==1?this:new n([this.main],0)}addRange(e,t=!0){return n.create([e].concat(this.ranges),t?0:this.mainIndex+1)}replaceRange(e,t=this.mainIndex){let i=this.ranges.slice();return i[t]=e,n.create(i,this.mainIndex)}toJSON(){return{ranges:this.ranges.map(e=>e.toJSON()),main:this.mainIndex}}static fromJSON(e){if(!e||!Array.isArray(e.ranges)||typeof e.main!="number"||e.main>=e.ranges.length)throw new RangeError("Invalid JSON representation for EditorSelection");return new n(e.ranges.map(t=>Ot.fromJSON(t)),e.main)}static single(e,t=e){return new n([n.range(e,t)],0)}static create(e,t=0){if(e.length==0)throw new RangeError("A selection needs at least one range");for(let i=0,s=0;s<e.length;s++){let r=e[s];if(r.empty?r.from<=i:r.from<i)return n.normalized(e.slice(),t);i=r.to}return new n(e,t)}static cursor(e,t=0,i,s){return Ot.create(e,e,(t==0?0:t<0?8:16)|(i==null?7:Math.min(6,i)),s)}static range(e,t,i,s,r){let o=s==null?7:Math.min(6,s);return!r&&e!=t&&(r=t<e?1:-1),r&&(o|=r<0?8:16),t<e?Ot.create(t,e,o|32,i):Ot.create(e,t,o,i)}static undirectionalRange(e,t){return Ot.create(e,t,64,void 0)}static normalized(e,t=0){let i=e[t];e.sort((s,r)=>s.from-r.from),t=e.indexOf(i);for(let s=1;s<e.length;s++){let r=e[s],o=e[s-1];if(r.empty?r.from<=o.to:r.from<o.to){let l=o.from,a=Math.max(r.to,o.to);s<=t&&t--,e.splice(--s,2,r.anchor>r.head?n.range(a,l):n.range(l,a))}}return new n(e,t)}};function ih(n,e){for(let t of n.ranges)if(t.to>e)throw new RangeError("Selection points outside of document")}var Ir=0,C=class n{constructor(e,t,i,s,r){this.combine=e,this.compareInput=t,this.compare=i,this.isStatic=s,this.id=Ir++,this.default=e([]),this.extensions=typeof r=="function"?r(this):r}get reader(){return this}static define(e={}){return new n(e.combine||(t=>t),e.compareInput||((t,i)=>t===i),e.compare||(e.combine?(t,i)=>t===i:Nr),!!e.static,e.enables)}of(e){return new ei([],this,0,e)}compute(e,t){if(this.isStatic)throw new Error("Can't compute a static facet");return new ei(e,this,1,t)}computeN(e,t){if(this.isStatic)throw new Error("Can't compute a static facet");return new ei(e,this,2,t)}from(e,t){return t||(t=i=>i),this.compute([e],i=>t(i.field(e)))}};function Nr(n,e){return n==e||n.length==e.length&&n.every((t,i)=>t===e[i])}var ei=class{constructor(e,t,i,s){this.dependencies=e,this.facet=t,this.type=i,this.value=s,this.id=Ir++}dynamicSlot(e){var t;let i=this.value,s=this.facet.compareInput,r=this.id,o=e[r]>>1,l=this.type==2,a=!1,h=!1,c=[];for(let f of this.dependencies)f=="doc"?a=!0:f=="selection"?h=!0:(((t=e[f.id])!==null&&t!==void 0?t:1)&1)==0&&c.push(e[f.id]);return{create(f){return f.values[o]=i(f),1},update(f,u){if(a&&u.docChanged||h&&(u.docChanged||u.selection)||Mr(f,c)){let d=i(f);if(l?!Ja(d,f.values[o],s):!s(d,f.values[o]))return f.values[o]=d,1}return 0},reconfigure:(f,u)=>{let d,p=u.config.address[r];if(p!=null){let m=In(u,p);if(this.dependencies.every(g=>g instanceof C?u.facet(g)===f.facet(g):g instanceof _?u.field(g,!1)==f.field(g,!1):!0)||(l?Ja(d=i(f),m,s):s(d=i(f),m)))return f.values[o]=m,0}else d=i(f);return f.values[o]=d,1}}}get extension(){return this}};function Ja(n,e,t){if(n.length!=e.length)return!1;for(let i=0;i<n.length;i++)if(!t(n[i],e[i]))return!1;return!0}function Mr(n,e){let t=!1;for(let i of e)Li(n,i)&1&&(t=!0);return t}function Ud(n,e,t){let i=t.map(a=>n[a.id]),s=t.map(a=>a.type),r=i.filter(a=>!(a&1)),o=n[e.id]>>1;function l(a){let h=[];for(let c=0;c<i.length;c++){let f=In(a,i[c]);if(s[c]==2)for(let u of f)h.push(u);else h.push(f)}return e.combine(h)}return{create(a){for(let h of i)Li(a,h);return a.values[o]=l(a),1},update(a,h){if(!Mr(a,r))return 0;let c=l(a);return e.compare(c,a.values[o])?0:(a.values[o]=c,1)},reconfigure(a,h){let c=Mr(a,i),f=h.config.facets[e.id],u=h.facet(e);if(f&&!c&&Nr(t,f))return a.values[o]=u,0;let d=l(a);return e.compare(d,u)?(a.values[o]=u,0):(a.values[o]=d,1)}}}var Tn=C.define({static:!0}),_=class n{constructor(e,t,i,s,r){this.id=e,this.createF=t,this.updateF=i,this.compareF=s,this.spec=r,this.provides=void 0}static define(e){let t=new n(Ir++,e.create,e.update,e.compare||((i,s)=>i===s),e);return e.provide&&(t.provides=e.provide(t)),t}create(e){let t=e.facet(Tn).find(i=>i.field==this);return(t?.create||this.createF)(e)}slot(e){let t=e[this.id]>>1;return{create:i=>(i.values[t]=this.create(i),1),update:(i,s)=>{let r=i.values[t],o=this.updateF(r,s);return this.compareF(r,o)?0:(i.values[t]=o,1)},reconfigure:(i,s)=>{let r=i.facet(Tn),o=s.facet(Tn),l;return(l=r.find(a=>a.field==this))&&l!=o.find(a=>a.field==this)?(i.values[t]=l.create(i),1):s.config.address[this.id]!=null?(i.values[t]=s.field(this),0):(i.values[t]=this.create(i),1)}}}init(e){return[this,Tn.of({field:this,create:e})]}get extension(){return this}},Bt={lowest:4,low:3,default:2,high:1,highest:0};function Bi(n){return e=>new Rn(e,n)}var Se={highest:Bi(Bt.highest),high:Bi(Bt.high),default:Bi(Bt.default),low:Bi(Bt.low),lowest:Bi(Bt.lowest)},Rn=class{constructor(e,t){this.inner=e,this.prec=t}get extension(){return this}},ni=class n{of(e){return new Ei(this,e)}reconfigure(e){return n.reconfigure.of({compartment:this,extension:e})}get(e){return e.config.compartments.get(this)}},Ei=class{constructor(e,t){this.compartment=e,this.inner=t}get extension(){return this}},Pn=class n{constructor(e,t,i,s,r,o){for(this.base=e,this.compartments=t,this.dynamicSlots=i,this.address=s,this.staticValues=r,this.facets=o,this.statusTemplate=[];this.statusTemplate.length<i.length;)this.statusTemplate.push(0)}staticFacet(e){let t=this.address[e.id];return t==null?e.default:this.staticValues[t>>1]}static resolve(e,t,i){let s=[],r=Object.create(null),o=new Map;for(let u of Gd(e,t,o))u instanceof _?s.push(u):(r[u.facet.id]||(r[u.facet.id]=[])).push(u);let l=Object.create(null),a=[],h=[];for(let u of s)l[u.id]=h.length<<1,h.push(d=>u.slot(d));let c=i?.config.facets;for(let u in r){let d=r[u],p=d[0].facet,m=c&&c[u]||[];if(d.every(g=>g.type==0))if(l[p.id]=a.length<<1|1,Nr(m,d))a.push(i.facet(p));else{let g=p.combine(d.map(y=>y.value));a.push(i&&p.compare(g,i.facet(p))?i.facet(p):g)}else{for(let g of d)g.type==0?(l[g.id]=a.length<<1|1,a.push(g.value)):(l[g.id]=h.length<<1,h.push(y=>g.dynamicSlot(y)));l[p.id]=h.length<<1,h.push(g=>Ud(g,p,d))}}let f=h.map(u=>u(l));return new n(e,o,f,l,a,r)}};function Gd(n,e,t){let i=[[],[],[],[],[]],s=new Map;function r(o,l){let a=s.get(o);if(a!=null){if(a<=l)return;let h=i[a].indexOf(o);h>-1&&i[a].splice(h,1),o instanceof Ei&&t.delete(o.compartment)}if(s.set(o,l),Array.isArray(o))for(let h of o)r(h,l);else if(o instanceof Ei){if(t.has(o.compartment))throw new RangeError("Duplicate use of compartment in extensions");let h=e.get(o.compartment)||o.inner;t.set(o.compartment,h),r(h,l)}else if(o instanceof Rn)r(o.inner,o.prec);else if(o instanceof _)i[l].push(o),o.provides&&r(o.provides,l);else if(o instanceof ei)i[l].push(o),o.facet.extensions&&r(o.facet.extensions,Bt.default);else{let h=o.extension;if(!h)throw new Error(`Unrecognized extension value in extension set (${o}).`);if(h==o)throw new Error(`Unrecognized extension value in extension set (${o}). This sometimes happens because multiple instances of @codemirror/state are loaded, breaking instanceof checks.`);r(h,l)}}return r(n,Bt.default),i.reduce((o,l)=>o.concat(l))}function Li(n,e){if(e&1)return 2;let t=e>>1,i=n.status[t];if(i==4)throw new Error("Cyclic dependency between fields and/or facets");if(i&2)return i;n.status[t]=4;let s=n.computeSlot(n,n.config.dynamicSlots[t]);return n.status[t]=2|s}function In(n,e){return e&1?n.config.staticValues[e>>1]:n.values[e>>1]}var nh=C.define(),Tr=C.define({combine:n=>n.some(e=>e),static:!0}),sh=C.define({combine:n=>n.length?n[0]:void 0,static:!0}),rh=C.define(),oh=C.define(),lh=C.define(),ah=C.define({combine:n=>n.length?n[0]:!1}),xe=class{constructor(e,t){this.type=e,this.value=t}static define(){return new Dr}},Dr=class{of(e){return new xe(this,e)}},Or=class{constructor(e){this.map=e}of(e){return new L(this,e)}},L=class n{constructor(e,t){this.type=e,this.value=t}map(e){let t=this.type.map(this.value,e);return t===void 0?void 0:t==this.value?this:new n(this.type,t)}is(e){return this.type==e}static define(e={}){return new Or(e.map||(t=>t))}static mapEffects(e,t){if(!e.length)return e;let i=[];for(let s of e){let r=s.map(t);r&&i.push(r)}return i}};L.reconfigure=L.define();L.appendConfig=L.define();var ne=class n{constructor(e,t,i,s,r,o){this.startState=e,this.changes=t,this.selection=i,this.effects=s,this.annotations=r,this.scrollIntoView=o,this._doc=null,this._state=null,i&&ih(i,t.newLength),r.some(l=>l.type==n.time)||(this.annotations=r.concat(n.time.of(Date.now())))}static create(e,t,i,s,r,o){return new n(e,t,i,s,r,o)}get newDoc(){return this._doc||(this._doc=this.changes.apply(this.startState.doc))}get newSelection(){return this.selection||this.startState.selection.map(this.changes)}get state(){return this._state||this.startState.applyTransaction(this),this._state}annotation(e){for(let t of this.annotations)if(t.type==e)return t.value}get docChanged(){return!this.changes.empty}get reconfigured(){return this.startState.config!=this.state.config}isUserEvent(e){let t=this.annotation(n.userEvent);return!!(t&&(t==e||t.length>e.length&&t.slice(0,e.length)==e&&t[e.length]=="."))}};ne.time=xe.define();ne.userEvent=xe.define();ne.addToHistory=xe.define();ne.remote=xe.define();function _d(n,e){let t=[];for(let i=0,s=0;;){let r,o;if(i<n.length&&(s==e.length||e[s]>=n[i]))r=n[i++],o=n[i++];else if(s<e.length)r=e[s++],o=e[s++];else return t;!t.length||t[t.length-1]<r?t.push(r,o):t[t.length-1]<o&&(t[t.length-1]=o)}}function hh(n,e,t){var i;let s,r,o;return t?(s=e.changes,r=be.empty(e.changes.length),o=n.changes.compose(e.changes)):(s=e.changes.map(n.changes),r=n.changes.mapDesc(e.changes,!0),o=n.changes.compose(s)),{changes:o,selection:e.selection?e.selection.map(r):(i=n.selection)===null||i===void 0?void 0:i.map(s),effects:L.mapEffects(n.effects,s).concat(L.mapEffects(e.effects,r)),annotations:n.annotations.length?n.annotations.concat(e.annotations):e.annotations,scrollIntoView:n.scrollIntoView||e.scrollIntoView}}function Br(n,e,t){let i=e.selection,s=ti(e.annotations);return e.userEvent&&(s=s.concat(ne.userEvent.of(e.userEvent))),{changes:e.changes instanceof be?e.changes:be.of(e.changes||[],t,n.facet(sh)),selection:i&&(i instanceof b?i:b.single(i.anchor,i.head)),effects:ti(e.effects),annotations:s,scrollIntoView:!!e.scrollIntoView}}function ch(n,e,t){let i=Br(n,e.length?e[0]:{},n.doc.length);e.length&&e[0].filter===!1&&(t=!1);for(let r=1;r<e.length;r++){e[r].filter===!1&&(t=!1);let o=!!e[r].sequential;i=hh(i,Br(n,e[r],o?i.changes.newLength:n.doc.length),o)}let s=ne.create(n,i.changes,i.selection,i.effects,i.annotations,i.scrollIntoView);return Xd(t?Yd(s):s)}function Yd(n){let e=n.startState,t=!0;for(let s of e.facet(rh)){let r=s(n);if(r===!1){t=!1;break}Array.isArray(r)&&(t=t===!0?r:_d(t,r))}if(t!==!0){let s,r;if(t===!1)r=n.changes.invertedDesc,s=be.empty(e.doc.length);else{let o=n.changes.filter(t);s=o.changes,r=o.filtered.mapDesc(o.changes).invertedDesc}n=ne.create(e,s,n.selection&&n.selection.map(r),L.mapEffects(n.effects,r),n.annotations,n.scrollIntoView)}let i=e.facet(oh);for(let s=i.length-1;s>=0;s--){let r=i[s](n);r instanceof ne?n=r:Array.isArray(r)&&r.length==1&&r[0]instanceof ne?n=r[0]:n=ch(e,ti(r),!1)}return n}function Xd(n){let e=n.startState,t=e.facet(lh),i=n;for(let s=t.length-1;s>=0;s--){let r=t[s](n);r&&Object.keys(r).length&&(i=hh(i,Br(e,r,n.changes.newLength),!0))}return i==n?n:ne.create(e,n.changes,n.selection,i.effects,i.annotations,i.scrollIntoView)}var Jd=[];function ti(n){return n==null?Jd:Array.isArray(n)?n:[n]}var $=(function(n){return n[n.Word=0]="Word",n[n.Space=1]="Space",n[n.Other=2]="Other",n})($||($={})),Qd=/[\u00df\u0587\u0590-\u05f4\u0600-\u06ff\u3040-\u309f\u30a0-\u30ff\u3400-\u4db5\u4e00-\u9fcc\uac00-\ud7af]/,Lr;try{Lr=new RegExp("[\\p{Alphabetic}\\p{Number}_]","u")}catch{}function Zd(n){if(Lr)return Lr.test(n);for(let e=0;e<n.length;e++){let t=n[e];if(/\w/.test(t)||t>"\x80"&&(t.toUpperCase()!=t.toLowerCase()||Qd.test(t)))return!0}return!1}function ep(n){return e=>{if(!/\S/.test(e))return $.Space;if(Zd(e))return $.Word;for(let t=0;t<n.length;t++)if(e.indexOf(n[t])>-1)return $.Word;return $.Other}}var U=class n{constructor(e,t,i,s,r,o){this.config=e,this.doc=t,this.selection=i,this.values=s,this.status=e.statusTemplate.slice(),this.computeSlot=r,o&&(o._state=this);for(let l=0;l<this.config.dynamicSlots.length;l++)Li(this,l<<1);this.computeSlot=null}field(e,t=!0){let i=this.config.address[e.id];if(i==null){if(t)throw new RangeError("Field is not present in this state");return}return Li(this,i),In(this,i)}update(...e){return ch(this,e,!0)}applyTransaction(e){let t=this.config,{base:i,compartments:s}=t;for(let l of e.effects)l.is(ni.reconfigure)?(t&&(s=new Map,t.compartments.forEach((a,h)=>s.set(h,a)),t=null),s.set(l.value.compartment,l.value.extension)):l.is(L.reconfigure)?(t=null,i=l.value):l.is(L.appendConfig)&&(t=null,i=ti(i).concat(l.value));let r;t?r=e.startState.values.slice():(t=Pn.resolve(i,s,this),r=new n(t,this.doc,this.selection,t.dynamicSlots.map(()=>null),(a,h)=>h.reconfigure(a,this),null).values);let o=e.startState.facet(Tr)?e.newSelection:e.newSelection.asSingle();new n(t,e.newDoc,o,r,(l,a)=>a.update(l,e),e)}replaceSelection(e){return typeof e=="string"&&(e=this.toText(e)),this.changeByRange(t=>({changes:{from:t.from,to:t.to,insert:e},range:b.cursor(t.from+e.length,-1)}))}changeByRange(e){let t=this.selection,i=e(t.ranges[0]),s=this.changes(i.changes),r=[i.range],o=ti(i.effects);for(let l=1;l<t.ranges.length;l++){let a=e(t.ranges[l]),h=this.changes(a.changes),c=h.map(s);for(let u=0;u<l;u++)r[u]=r[u].map(c);let f=s.mapDesc(h,!0);r.push(a.range.map(f)),s=s.compose(c),o=L.mapEffects(o,c).concat(L.mapEffects(ti(a.effects),f))}return{changes:s,selection:b.create(r,t.mainIndex),effects:o}}changes(e=[]){return e instanceof be?e:be.of(e,this.doc.length,this.facet(n.lineSeparator))}toText(e){return N.of(e.split(this.facet(n.lineSeparator)||Sr))}sliceDoc(e=0,t=this.doc.length){return this.doc.sliceString(e,t,this.lineBreak)}facet(e){let t=this.config.address[e.id];return t==null?e.default:(Li(this,t),In(this,t))}toJSON(e){let t={doc:this.sliceDoc(),selection:this.selection.toJSON()};if(e)for(let i in e){let s=e[i];s instanceof _&&this.config.address[s.id]!=null&&(t[i]=s.spec.toJSON(this.field(e[i]),this))}return t}static fromJSON(e,t={},i){if(!e||typeof e.doc!="string")throw new RangeError("Invalid JSON representation for EditorState");let s=[];if(i){for(let r in i)if(Object.prototype.hasOwnProperty.call(e,r)){let o=i[r],l=e[r];s.push(o.init(a=>o.spec.fromJSON(l,a)))}}return n.create({doc:e.doc,selection:b.fromJSON(e.selection),extensions:t.extensions?s.concat([t.extensions]):s})}static create(e={}){let t=Pn.resolve(e.extensions||[],new Map),i=e.doc instanceof N?e.doc:N.of((e.doc||"").split(t.staticFacet(n.lineSeparator)||Sr)),s=e.selection?e.selection instanceof b?e.selection:b.single(e.selection.anchor,e.selection.head):b.single(0);return ih(s,i.length),t.staticFacet(Tr)||(s=s.asSingle()),new n(t,i,s,t.dynamicSlots.map(()=>null),(r,o)=>o.create(r),null)}get tabSize(){return this.facet(n.tabSize)}get lineBreak(){return this.facet(n.lineSeparator)||`
`}get readOnly(){return this.facet(ah)}phrase(e,...t){for(let i of this.facet(n.phrases))if(Object.prototype.hasOwnProperty.call(i,e)){e=i[e];break}return t.length&&(e=e.replace(/\$(\$|\d*)/g,(i,s)=>{if(s=="$")return"$";let r=+(s||1);return!r||r>t.length?i:t[r-1]})),e}languageDataAt(e,t,i=-1){let s=[];for(let r of this.facet(nh))for(let o of r(this,t,i))Object.prototype.hasOwnProperty.call(o,e)&&s.push(o[e]);return s}charCategorizer(e){let t=this.languageDataAt("wordChars",e);return ep(t.length?t[0]:"")}wordAt(e){let{text:t,from:i,length:s}=this.doc.lineAt(e),r=this.charCategorizer(e),o=e-i,l=e-i;for(;o>0;){let a=ee(t,o,!1);if(r(t.slice(a,o))!=$.Word)break;o=a}for(;l<s;){let a=ee(t,l);if(r(t.slice(l,a))!=$.Word)break;l=a}return o==l?null:b.range(o+i,l+i)}};U.allowMultipleSelections=Tr;U.tabSize=C.define({combine:n=>n.length?n[0]:4});U.lineSeparator=sh;U.readOnly=ah;U.phrases=C.define({compare(n,e){let t=Object.keys(n),i=Object.keys(e);return t.length==i.length&&t.every(s=>n[s]==e[s])}});U.languageData=nh;U.changeFilter=rh;U.transactionFilter=oh;U.transactionExtender=lh;ni.reconfigure=L.define();function me(n,e,t={}){let i={};for(let s of n)for(let r of Object.keys(s)){let o=s[r],l=i[r];if(l===void 0)i[r]=o;else if(!(l===o||o===void 0))if(Object.hasOwnProperty.call(t,r))i[r]=t[r](l,o);else throw new Error("Config merge conflict for field "+r)}for(let s in e)i[s]===void 0&&(i[s]=e[s]);return i}var Ne=class{eq(e){return this==e}range(e,t=e){return Ri.create(e,t,this)}};Ne.prototype.startSide=Ne.prototype.endSide=0;Ne.prototype.point=!1;Ne.prototype.mapMode=ie.TrackDel;function Fr(n,e){return n==e||n.constructor==e.constructor&&n.eq(e)}var Ri=class n{constructor(e,t,i){this.from=e,this.to=t,this.value=i}static create(e,t,i){return new n(e,t,i)}};function Er(n,e){return n.from-e.from||n.value.startSide-e.value.startSide}var Rr=class n{constructor(e,t,i,s){this.from=e,this.to=t,this.value=i,this.maxPoint=s}get length(){return Qt(this.to)}findIndex(e,t,i,s=0){let r=i?this.to:this.from;for(let o=s,l=r.length;;){if(o==l)return o;let a=o+l>>1,h=r[a]-e||(i?this.value[a].endSide:this.value[a].startSide)-t;if(a==o)return h>=0?o:l;h>=0?l=a:o=a+1}}between(e,t,i,s){for(let r=this.findIndex(t,-1e9,!0),o=this.findIndex(i,1e9,!1,r);r<o;r++)if(s(this.from[r]+e,this.to[r]+e,this.value[r])===!1)return!1}map(e,t,i,s,r){let o=[],l=[],a=[],h=-1,c=-1;e:for(let f=0;f<this.value.length;f++){let u=this.value[f],d=this.from[f]+e,p=this.to[f]+e,m,g;if(d==p){let y=t.mapPos(d,u.startSide,u.mapMode);if(y==null||(m=g=y,u.startSide!=u.endSide&&(g=t.mapPos(d,u.endSide),g<m)))continue}else if(m=t.mapPos(d,u.startSide),g=t.mapPos(p,u.endSide),m>g||m==g&&u.startSide>0&&u.endSide<=0)continue;if(!((g-m||u.endSide-u.startSide)<0))if(h<0&&(h=m),u.point&&(c=Math.max(c,g-m)),(m-i||u.startSide-s)>=0)o.push(u),l.push(m-h),a.push(g-h),i=g,s=u.endSide;else{if(m==g)for(let y=o.length;y>0;y--){if((m-(a[y-1]+h)||u.startSide-o[y-1].endSide)>=0){o.splice(y,0,u),l.splice(y,0,m-h),a.splice(y,0,g-h);continue e}if((m-(l[y-1]+h)||u.endSide-o[y-1].startSide)>0)break}r(m,g,u)}}return{mapped:o.length?new n(l,a,o,c):null,pos:h}}},H=class n{constructor(e,t,i,s){this.chunkPos=e,this.chunk=t,this.nextLayer=i,this.maxPoint=s}static create(e,t,i,s){return new n(e,t,i,s)}get length(){let e=this.chunk.length-1;return e<0?0:Math.max(this.chunkEnd(e),this.nextLayer.length)}get size(){if(this.isEmpty)return 0;let e=this.nextLayer.size;for(let t of this.chunk)e+=t.value.length;return e}chunkEnd(e){return this.chunkPos[e]+this.chunk[e].length}update(e){let{add:t=[],sort:i=!1,filterFrom:s=0,filterTo:r=this.length}=e,o=e.filter;if(t.length==0&&!o)return this;if(i&&(t=t.slice().sort(Er)),this.isEmpty)return t.length?n.of(t):this;let l=new Nn(this,null,-1).goto(0),a=0,h=[],c=new pe;for(;l.value||a<t.length;)if(a<t.length&&(l.from-t[a].from||l.startSide-t[a].value.startSide)>=0){let f=t[a++];c.addInner(f.from,f.to,f.value,!1)||h.push(f)}else l.rangeIndex==1&&l.chunkIndex<this.chunk.length&&(a==t.length||this.chunkEnd(l.chunkIndex)<t[a].from)&&(!o||s>this.chunkEnd(l.chunkIndex)||r<this.chunkPos[l.chunkIndex])&&c.addChunk(this.chunkPos[l.chunkIndex],this.chunk[l.chunkIndex])?l.nextChunk():((!o||s>l.to||r<l.from||o(l.from,l.to,l.value))&&(c.addInner(l.from,l.to,l.value,!1)||h.push(Ri.create(l.from,l.to,l.value))),l.next());return c.finishInner(this.nextLayer.isEmpty&&!h.length?n.empty:this.nextLayer.update({add:h,filter:o,filterFrom:s,filterTo:r}))}map(e){if(e.empty||this.isEmpty)return this;let t=[],i=[],s=-1,r,o=(a,h,c)=>{r||(r=new pe),r.addRange(a,h,c,!1)};for(let a=0;a<this.chunk.length;a++){let h=this.chunkPos[a],c=this.chunk[a],f=e.touchesRange(h,h+c.length);if(f===!1)s=Math.max(s,c.maxPoint),t.push(c),i.push(e.mapPos(h));else if(f===!0){let[u,d]=t.length?[Qt(i)+Qt(t).length,Qt(Qt(t).value).endSide]:[-1,-1],{mapped:p,pos:m}=c.map(h,e,u,d,o);p&&(s=Math.max(s,p.maxPoint),t.push(p),i.push(m))}}let l=this.nextLayer.map(e);return r&&(l=r.finishInner(l)),t.length==0?l:new n(i,t,l||n.empty,s)}between(e,t,i){if(!this.isEmpty){for(let s=0;s<this.chunk.length;s++){let r=this.chunkPos[s],o=this.chunk[s];if(t>=r&&e<=r+o.length&&o.between(r,e-r,t-r,i)===!1)return}this.nextLayer.between(e,t,i)}}iter(e=0){return Pi.from([this]).goto(e)}get isEmpty(){return this.nextLayer==this}static iter(e,t=0){return Pi.from(e).goto(t)}static compare(e,t,i,s,r=-1){let o=e.filter(f=>f.maxPoint>0||!f.isEmpty&&f.maxPoint>=r),l=t.filter(f=>f.maxPoint>0||!f.isEmpty&&f.maxPoint>=r),a=Qa(o,l,i),h=new Lt(o,a,r),c=new Lt(l,a,r);i.iterGaps((f,u,d)=>Za(h,f,c,u,d,s)),i.empty&&i.length==0&&Za(h,0,c,0,0,s)}static eq(e,t,i=0,s){s==null&&(s=999999999);let r=e.filter(c=>!c.isEmpty&&t.indexOf(c)<0),o=t.filter(c=>!c.isEmpty&&e.indexOf(c)<0);if(r.length!=o.length)return!1;if(!r.length)return!0;let l=Qa(r,o),a=new Lt(r,l,0).goto(i),h=new Lt(o,l,0).goto(i);for(;;){if(a.to!=h.to||!Pr(a.active,h.active)||a.point&&(!h.point||!Fr(a.point,h.point)))return!1;if(a.to>s)return!0;a.next(),h.next()}}static spans(e,t,i,s,r=-1){let o=new Lt(e,null,r).goto(t),l=t,a=o.openStart;for(;;){let h=Math.min(o.to,i);if(o.point){let c=o.activeForPoint(o.to),f=o.pointFrom<t?c.length+1:o.point.startSide<0?c.length:Math.min(c.length,a);s.point(l,h,o.point,c,f,o.pointRank),a=Math.min(o.openEnd(h),c.length)}else h>l&&(s.span(l,h,o.active,a),a=o.openEnd(h));if(o.to>i)return a+(o.point&&o.to>i?1:0);l=o.to,o.next()}}static of(e,t=!1){let i=new pe;for(let s of e instanceof Ri?[e]:t?tp(e):e)i.add(s.from,s.to,s.value);return i.finish()}static join(e){if(!e.length)return n.empty;let t=Qt(e);for(let i=e.length-2;i>=0;i--)for(let s=e[i];s!=n.empty;s=s.nextLayer)t=new n(s.chunkPos,s.chunk,t,Math.max(s.maxPoint,t.maxPoint));return t}};H.empty=new H([],[],null,-1);function Qt(n){return n[n.length-1]}function tp(n){if(n.length>1)for(let e=n[0],t=1;t<n.length;t++){let i=n[t];if(Er(e,i)>0)return n.slice().sort(Er);e=i}return n}H.empty.nextLayer=H.empty;var pe=class n{finishChunk(e){this.chunks.push(new Rr(this.from,this.to,this.value,this.maxPoint)),this.chunkPos.push(this.chunkStart),this.chunkStart=-1,this.setMaxPoint=Math.max(this.setMaxPoint,this.maxPoint),this.maxPoint=-1,e&&(this.from=[],this.to=[],this.value=[])}constructor(){this.chunks=[],this.chunkPos=[],this.chunkStart=-1,this.last=null,this.lastFrom=-1e9,this.lastTo=-1e9,this.from=[],this.to=[],this.value=[],this.maxPoint=-1,this.setMaxPoint=-1,this.nextLayer=null}add(e,t,i){this.addRange(e,t,i,!0)}addRange(e,t,i,s){this.addInner(e,t,i,s)||(this.nextLayer||(this.nextLayer=new n)).addRange(e,t,i,s)}addInner(e,t,i,s){let r=e-this.lastTo||i.startSide-this.last.endSide;if(s&&r<=0&&(e-this.lastFrom||i.startSide-this.last.startSide)<0)throw new Error("Ranges must be added sorted by `from` position and `startSide`");return r<0?!1:(this.from.length==250&&this.finishChunk(!0),this.chunkStart<0&&(this.chunkStart=e),this.from.push(e-this.chunkStart),this.to.push(t-this.chunkStart),this.last=i,this.lastFrom=e,this.lastTo=t,this.value.push(i),i.point&&(this.maxPoint=Math.max(this.maxPoint,t-e)),!0)}addChunk(e,t){if((e-this.lastTo||t.value[0].startSide-this.last.endSide)<0)return!1;this.from.length&&this.finishChunk(!0),this.setMaxPoint=Math.max(this.setMaxPoint,t.maxPoint),this.chunks.push(t),this.chunkPos.push(e);let i=t.value.length-1;return this.last=t.value[i],this.lastFrom=t.from[i]+e,this.lastTo=t.to[i]+e,!0}finish(){return this.finishInner(H.empty)}finishInner(e){if(this.from.length&&this.finishChunk(!1),this.chunks.length==0)return e;let t=H.create(this.chunkPos,this.chunks,this.nextLayer?this.nextLayer.finishInner(e):e,this.setMaxPoint);return this.from=null,t}};function Qa(n,e,t){let i=new Map;for(let r of n)for(let o=0;o<r.chunk.length;o++)r.chunk[o].maxPoint<=0&&i.set(r.chunk[o],r.chunkPos[o]);let s=new Set;for(let r of e)for(let o=0;o<r.chunk.length;o++){let l=i.get(r.chunk[o]);l!=null&&(t?t.mapPos(l):l)==r.chunkPos[o]&&!t?.touchesRange(l,l+r.chunk[o].length)&&s.add(r.chunk[o])}return s}var Nn=class{constructor(e,t,i,s=0){this.layer=e,this.skip=t,this.minPoint=i,this.rank=s}get startSide(){return this.value?this.value.startSide:0}get endSide(){return this.value?this.value.endSide:0}goto(e,t=-1e9){return this.chunkIndex=this.rangeIndex=0,this.gotoInner(e,t,!1),this}gotoInner(e,t,i){for(;this.chunkIndex<this.layer.chunk.length;){let s=this.layer.chunk[this.chunkIndex];if(!(this.skip&&this.skip.has(s)||this.layer.chunkEnd(this.chunkIndex)<e||s.maxPoint<this.minPoint))break;this.chunkIndex++,i=!1}if(this.chunkIndex<this.layer.chunk.length){let s=this.layer.chunk[this.chunkIndex].findIndex(e-this.layer.chunkPos[this.chunkIndex],t,!0);(!i||this.rangeIndex<s)&&this.setRangeIndex(s)}this.next()}forward(e,t){(this.to-e||this.endSide-t)<0&&this.gotoInner(e,t,!0)}next(){for(;;)if(this.chunkIndex==this.layer.chunk.length){this.from=this.to=1e9,this.value=null;break}else{let e=this.layer.chunkPos[this.chunkIndex],t=this.layer.chunk[this.chunkIndex],i=e+t.from[this.rangeIndex];if(this.from=i,this.to=e+t.to[this.rangeIndex],this.value=t.value[this.rangeIndex],this.setRangeIndex(this.rangeIndex+1),this.minPoint<0||this.value.point&&this.to-this.from>=this.minPoint)break}}setRangeIndex(e){if(e==this.layer.chunk[this.chunkIndex].value.length){if(this.chunkIndex++,this.skip)for(;this.chunkIndex<this.layer.chunk.length&&this.skip.has(this.layer.chunk[this.chunkIndex]);)this.chunkIndex++;this.rangeIndex=0}else this.rangeIndex=e}nextChunk(){this.chunkIndex++,this.rangeIndex=0,this.next()}compare(e){return this.from-e.from||this.startSide-e.startSide||this.rank-e.rank||this.to-e.to||this.endSide-e.endSide}},Pi=class n{constructor(e){this.heap=e}static from(e,t=null,i=-1){let s=[];for(let r=0;r<e.length;r++)for(let o=e[r];!o.isEmpty;o=o.nextLayer)o.maxPoint>=i&&s.push(new Nn(o,t,i,r));return s.length==1?s[0]:new n(s)}get startSide(){return this.value?this.value.startSide:0}goto(e,t=-1e9){for(let i of this.heap)i.goto(e,t);for(let i=this.heap.length>>1;i>=0;i--)vr(this.heap,i);return this.next(),this}forward(e,t){for(let i of this.heap)i.forward(e,t);for(let i=this.heap.length>>1;i>=0;i--)vr(this.heap,i);(this.to-e||this.value.endSide-t)<0&&this.next()}next(){if(this.heap.length==0)this.from=this.to=1e9,this.value=null,this.rank=-1;else{let e=this.heap[0];this.from=e.from,this.to=e.to,this.value=e.value,this.rank=e.rank,e.value&&e.next(),vr(this.heap,0)}}};function vr(n,e){for(let t=n[e];;){let i=(e<<1)+1;if(i>=n.length)break;let s=n[i];if(i+1<n.length&&s.compare(n[i+1])>=0&&(s=n[i+1],i++),t.compare(s)<0)break;n[i]=t,n[e]=s,e=i}}var Lt=class{constructor(e,t,i){this.minPoint=i,this.active=[],this.activeTo=[],this.activeRank=[],this.minActive=-1,this.point=null,this.pointFrom=0,this.pointRank=0,this.to=-1e9,this.endSide=0,this.openStart=-1,this.cursor=Pi.from(e,t,i)}goto(e,t=-1e9){return this.cursor.goto(e,t),this.active.length=this.activeTo.length=this.activeRank.length=0,this.minActive=-1,this.to=e,this.endSide=t,this.openStart=-1,this.next(),this}forward(e,t){for(;this.minActive>-1&&(this.activeTo[this.minActive]-e||this.active[this.minActive].endSide-t)<0;)this.removeActive(this.minActive);this.cursor.forward(e,t)}removeActive(e){Dn(this.active,e),Dn(this.activeTo,e),Dn(this.activeRank,e),this.minActive=eh(this.active,this.activeTo)}addActive(e){let t=0,{value:i,to:s,rank:r}=this.cursor;for(;t<this.activeRank.length&&(r-this.activeRank[t]||s-this.activeTo[t])>0;)t++;On(this.active,t,i),On(this.activeTo,t,s),On(this.activeRank,t,r),e&&On(e,t,this.cursor.from),this.minActive=eh(this.active,this.activeTo)}next(){let e=this.to,t=this.point;this.point=null;let i=this.openStart<0?[]:null;for(;;){let s=this.minActive;if(s>-1&&(this.activeTo[s]-this.cursor.from||this.active[s].endSide-this.cursor.startSide)<0){if(this.activeTo[s]>e){this.to=this.activeTo[s],this.endSide=this.active[s].endSide;break}this.removeActive(s),i&&Dn(i,s)}else if(this.cursor.value)if(this.cursor.from>e){this.to=this.cursor.from,this.endSide=this.cursor.startSide;break}else{let r=this.cursor.value;if(!r.point)this.addActive(i),this.cursor.next();else if(t&&this.cursor.to==this.to&&this.cursor.from<this.cursor.to)this.cursor.next();else{this.point=r,this.pointFrom=this.cursor.from,this.pointRank=this.cursor.rank,this.to=this.cursor.to,this.endSide=r.endSide,this.cursor.next(),this.forward(this.to,this.endSide);break}}else{this.to=this.endSide=1e9;break}}if(i){this.openStart=0;for(let s=i.length-1;s>=0&&i[s]<e;s--)this.openStart++}}activeForPoint(e){if(!this.active.length)return this.active;let t=[];for(let i=this.active.length-1;i>=0&&!(this.activeRank[i]<this.pointRank);i--)(this.activeTo[i]>e||this.activeTo[i]==e&&this.active[i].endSide>=this.point.endSide)&&t.push(this.active[i]);return t.reverse()}openEnd(e){let t=0;for(let i=this.activeTo.length-1;i>=0&&this.activeTo[i]>e;i--)t++;return t}};function Za(n,e,t,i,s,r){n.goto(e),t.goto(i);let o=i+s,l=i,a=i-e,h=!!r.boundChange;for(let c=!1;;){let f=n.to+a-t.to,u=f||n.endSide-t.endSide,d=u<0?n.to+a:t.to,p=Math.min(d,o);if(n.point||t.point?(n.point&&t.point&&Fr(n.point,t.point)&&Pr(n.activeForPoint(n.to),t.activeForPoint(t.to))||r.comparePoint(l,p,n.point,t.point),c=!1):(c&&(r.boundChange(l),c=!1),p>l&&!Pr(n.active,t.active)&&r.compareRange(l,p,n.active,t.active),h&&p<o&&(f||n.openEnd(d)!=t.openEnd(d))&&(c=!0)),d>o)break;l=d,u<=0&&n.next(),u>=0&&t.next()}}function Pr(n,e){if(n.length!=e.length)return!1;for(let t=0;t<n.length;t++)if(n[t]!=e[t]&&!Fr(n[t],e[t]))return!1;return!0}function Dn(n,e){for(let t=e,i=n.length-1;t<i;t++)n[t]=n[t+1];n.pop()}function On(n,e,t){for(let i=n.length-1;i>=e;i--)n[i+1]=n[i];n[e]=t}function eh(n,e){let t=-1,i=1e9;for(let s=0;s<e.length;s++)(e[s]-i||n[s].endSide-n[t].endSide)<0&&(t=s,i=e[s]);return t}function lt(n,e,t=n.length){let i=0;for(let s=0;s<t&&s<n.length;)n.charCodeAt(s)==9?(i+=e-i%e,s++):(i++,s=ee(n,s));return i}function Fn(n,e,t,i){for(let s=0,r=0;;){if(r>=e)return s;if(s==n.length)break;r+=n.charCodeAt(s)==9?t-r%t:1,s=ee(n,s)}return i===!0?-1:n.length}var fh=typeof Symbol>"u"?"__\u037C":Symbol.for("\u037C"),Hr=typeof Symbol>"u"?"__styleSet"+Math.floor(Math.random()*1e8):Symbol("styleSet"),uh=typeof globalThis<"u"?globalThis:typeof window<"u"?window:{},Fe=class{constructor(e,t){this.rules=[];let{finish:i}=t||{};function s(o){return/^@/.test(o)?[o]:o.split(/,\s*/)}function r(o,l,a,h){let c=[],f=/^@(\w+)\b/.exec(o[0]),u=f&&f[1]=="keyframes";if(f&&l==null)return a.push(o[0]+";");for(let d in l){let p=l[d];if(/&/.test(d))r(d.split(/,\s*/).map(m=>o.map(g=>m.replace(/&/,g))).reduce((m,g)=>m.concat(g)),p,a);else if(p&&typeof p=="object"){if(!f)throw new RangeError("The value of a property ("+d+") should be a primitive value.");r(s(d),p,c,u)}else p!=null&&c.push(d.replace(/_.*/,"").replace(/[A-Z]/g,m=>"-"+m.toLowerCase())+": "+p+";")}(c.length||u)&&a.push((i&&!f&&!h?o.map(i):o).join(", ")+" {"+c.join(" ")+"}")}for(let o in e)r(s(o),e[o],this.rules)}getRules(){return this.rules.join(`
`)}static newName(){let e=uh[fh]||1;return uh[fh]=e+1,"\u037C"+e.toString(36)}static mount(e,t,i){let s=e[Hr],r=i&&i.nonce;s?r&&s.setNonce(r):s=new Wr(e,r),s.mount(Array.isArray(t)?t:[t],e)}},dh=new Map,Wr=class{constructor(e,t){let i=e.ownerDocument||e,s=i.defaultView;if(!e.head&&e.adoptedStyleSheets&&s.CSSStyleSheet){let r=dh.get(i);if(r)return e[Hr]=r;this.sheet=new s.CSSStyleSheet,dh.set(i,this)}else this.styleTag=i.createElement("style"),t&&this.styleTag.setAttribute("nonce",t);this.modules=[],e[Hr]=this}mount(e,t){let i=this.sheet,s=0,r=0,o=!1;for(let l=0;l<e.length;l++){let a=e[l],h=this.modules.indexOf(a);if(h<r&&h>-1&&(this.modules.splice(h,1),o=!0,r--,h=-1),h==-1){if(this.modules.splice(r++,0,a),o=!0,i)for(let c=0;c<a.rules.length;c++)i.insertRule(a.rules[c],s++)}else{for(;r<h;)s+=this.modules[r++].rules.length;s+=a.rules.length,r++}}if(i)t.adoptedStyleSheets.indexOf(this.sheet)<0&&(t.adoptedStyleSheets=[this.sheet,...t.adoptedStyleSheets]);else{if(o){let a="";for(let h=0;h<this.modules.length;h++)a+=this.modules[h].getRules()+`
`;this.styleTag.textContent=a}let l=t.head||t;this.styleTag.parentNode!=l&&l.insertBefore(this.styleTag,l.firstChild)}}setNonce(e){this.styleTag&&this.styleTag.getAttribute("nonce")!=e&&this.styleTag.setAttribute("nonce",e)}};var at={8:"Backspace",9:"Tab",10:"Enter",12:"NumLock",13:"Enter",16:"Shift",17:"Control",18:"Alt",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",44:"PrintScreen",45:"Insert",46:"Delete",59:";",61:"=",91:"Meta",92:"Meta",106:"*",107:"+",108:",",109:"-",110:".",111:"/",144:"NumLock",145:"ScrollLock",160:"Shift",161:"Shift",162:"Control",163:"Control",164:"Alt",165:"Alt",173:"-",186:";",187:"=",188:",",189:"-",190:".",191:"/",192:"`",219:"[",220:"\\",221:"]",222:"'"},si={48:")",49:"!",50:"@",51:"#",52:"$",53:"%",54:"^",55:"&",56:"*",57:"(",59:":",61:"+",173:"_",186:":",187:"+",188:"<",189:"_",190:">",191:"?",192:"~",219:"{",220:"|",221:"}",222:'"'},ip=typeof navigator<"u"&&/Mac/.test(navigator.platform),np=typeof navigator<"u"&&/MSIE \d|Trident\/(?:[7-9]|\d{2,})\..*rv:(\d+)/.exec(navigator.userAgent);for(te=0;te<10;te++)at[48+te]=at[96+te]=String(te);var te;for(te=1;te<=24;te++)at[te+111]="F"+te;var te;for(te=65;te<=90;te++)at[te]=String.fromCharCode(te+32),si[te]=String.fromCharCode(te);var te;for(Hn in at)si.hasOwnProperty(Hn)||(si[Hn]=at[Hn]);var Hn;function ph(n){var e=ip&&n.metaKey&&n.shiftKey&&!n.ctrlKey&&!n.altKey||np&&n.shiftKey&&n.key&&n.key.length==1||n.key=="Unidentified",t=!e&&n.key||(n.shiftKey?si:at)[n.keyCode]||n.key||"Unidentified";return t=="Esc"&&(t="Escape"),t=="Del"&&(t="Delete"),t=="Left"&&(t="ArrowLeft"),t=="Up"&&(t="ArrowUp"),t=="Right"&&(t="ArrowRight"),t=="Down"&&(t="ArrowDown"),t}function W(){var n=arguments[0];typeof n=="string"&&(n=document.createElement(n));var e=1,t=arguments[1];if(t&&typeof t=="object"&&t.nodeType==null&&!Array.isArray(t)){for(var i in t)if(Object.prototype.hasOwnProperty.call(t,i)){var s=t[i];typeof s=="string"?n.setAttribute(i,s):s!=null&&(n[i]=s)}e++}for(;e<arguments.length;e++)mh(n,arguments[e]);return n}function mh(n,e){if(typeof e=="string")n.appendChild(document.createTextNode(e));else if(e!=null)if(e.nodeType!=null)n.appendChild(e);else if(Array.isArray(e))for(var t=0;t<e.length;t++)mh(n,e[t]);else throw new RangeError("Unsupported child node: "+e)}var we=typeof navigator<"u"?navigator:{userAgent:"",vendor:"",platform:""},_r=typeof document<"u"?document:{documentElement:{style:{}}},Yr=/Edge\/(\d+)/.exec(we.userAgent),ec=/MSIE \d/.test(we.userAgent),Xr=/Trident\/(?:[7-9]|\d{2,})\..*rv:(\d+)/.exec(we.userAgent),gs=!!(ec||Xr||Yr),gh=!gs&&/gecko\/(\d+)/i.test(we.userAgent),Vr=!gs&&/Chrome\/(\d+)/.exec(we.userAgent),yh="webkitFontSmoothing"in _r.documentElement.style,Jr=!gs&&/Apple Computer/.test(we.vendor),bh=Jr&&(/Mobile\/\w+/.test(we.userAgent)||we.maxTouchPoints>2),M={mac:bh||/Mac/.test(we.platform),windows:/Win/.test(we.platform),linux:/Linux|X11/.test(we.platform),ie:gs,ie_version:ec?_r.documentMode||6:Xr?+Xr[1]:Yr?+Yr[1]:0,gecko:gh,gecko_version:gh?+(/Firefox\/(\d+)/.exec(we.userAgent)||[0,0])[1]:0,chrome:!!Vr,chrome_version:Vr?+Vr[1]:0,ios:bh,android:/Android\b/.test(we.userAgent),webkit:yh,webkit_version:yh?+(/\bAppleWebKit\/(\d+)/.exec(we.userAgent)||[0,0])[1]:0,safari:Jr,safari_version:Jr?+(/\bVersion\/(\d+(\.\d+)?)/.exec(we.userAgent)||[0,0])[1]:0,tabSize:_r.documentElement.style.tabSize!=null?"tab-size":"-moz-tab-size"};function Go(n,e){for(let t in n)t=="class"&&e.class?e.class+=" "+n.class:t=="style"&&e.style?e.style+=";"+n.style:e[t]=n[t];return e}var Zn=Object.create(null);function _o(n,e,t){if(n==e)return!0;n||(n=Zn),e||(e=Zn);let i=Object.keys(n),s=Object.keys(e);if(i.length-0!=s.length-0)return!1;for(let r of i)if(r!=t&&(s.indexOf(r)==-1||n[r]!==e[r]))return!1;return!0}function sp(n,e){for(let t=n.attributes.length-1;t>=0;t--){let i=n.attributes[t].name;e[i]==null&&n.removeAttribute(i)}for(let t in e){let i=e[t];t=="style"?n.style.cssText=i:n.getAttribute(t)!=i&&n.setAttribute(t,i)}}function xh(n,e,t){let i=!1;if(e)for(let s in e)t&&s in t||(i=!0,s=="style"?n.style.cssText="":n.removeAttribute(s));if(t)for(let s in t)e&&e[s]==t[s]||(i=!0,s=="style"?n.style.cssText=t[s]:n.setAttribute(s,t[s]));return i}function rp(n){let e=Object.create(null);for(let t=0;t<n.attributes.length;t++){let i=n.attributes[t];e[i.name]=i.value}return e}var re=class{eq(e){return!1}updateDOM(e,t,i){return!1}compare(e){return this==e||this.constructor==e.constructor&&this.eq(e)}get estimatedHeight(){return-1}get lineBreaks(){return 0}ignoreEvent(e){return!0}coordsAt(e,t,i){return null}get isHidden(){return!1}get editable(){return!1}destroy(e){}},fe=(function(n){return n[n.Text=0]="Text",n[n.WidgetBefore=1]="WidgetBefore",n[n.WidgetAfter=2]="WidgetAfter",n[n.WidgetRange=3]="WidgetRange",n})(fe||(fe={})),B=class extends Ne{constructor(e,t,i,s){super(),this.startSide=e,this.endSide=t,this.widget=i,this.spec=s}get heightRelevant(){return!1}static mark(e){return new Yi(e)}static widget(e){let t=Math.max(-1e4,Math.min(1e4,e.side||0)),i=!!e.block;return t+=i&&!e.inlineOrder?t>0?3e8:-4e8:t>0?1e8:-1e8,new Ft(e,t,t,i,e.widget||null,!1)}static replace(e){let t=!!e.block,i,s;if(e.isBlockGap)i=-5e8,s=4e8;else{let{start:r,end:o}=tc(e,t);i=(r?t?-3e8:-1:5e8)-1,s=(o?t?2e8:1:-6e8)+1}return new Ft(e,i,s,t,e.widget||null,!0)}static line(e){return new Xi(e)}static set(e,t=!1){return H.of(e,t)}hasHeight(){return this.widget?this.widget.estimatedHeight>-1:!1}};B.none=H.empty;var Yi=class n extends B{constructor(e){let{start:t,end:i}=tc(e);super(t?-1:5e8,i?1:-6e8,null,e),this.tagName=e.tagName||"span",this.attrs=e.class&&e.attributes?Go(e.attributes,{class:e.class}):e.class?{class:e.class}:e.attributes||Zn}eq(e){return this==e||e instanceof n&&this.tagName==e.tagName&&_o(this.attrs,e.attrs)}range(e,t=e){if(e>=t)throw new RangeError("Mark decorations may not be empty");return super.range(e,t)}};Yi.prototype.point=!1;var Xi=class n extends B{constructor(e){super(-2e8,-2e8,null,e)}eq(e){return e instanceof n&&this.spec.class==e.spec.class&&_o(this.spec.attributes,e.spec.attributes)}range(e,t=e){if(t!=e)throw new RangeError("Line decoration ranges must be zero-length");return super.range(e,t)}};Xi.prototype.mapMode=ie.TrackBefore;Xi.prototype.point=!0;var Ft=class n extends B{constructor(e,t,i,s,r,o){super(t,i,r,e),this.block=s,this.isReplace=o,this.mapMode=s?t<=0?ie.TrackBefore:ie.TrackAfter:ie.TrackDel}get type(){return this.startSide!=this.endSide?fe.WidgetRange:this.startSide<=0?fe.WidgetBefore:fe.WidgetAfter}get heightRelevant(){return this.block||!!this.widget&&(this.widget.estimatedHeight>=5||this.widget.lineBreaks>0)}eq(e){return e instanceof n&&op(this.widget,e.widget)&&this.block==e.block&&this.startSide==e.startSide&&this.endSide==e.endSide}range(e,t=e){if(this.isReplace&&(e>t||e==t&&this.startSide>0&&this.endSide<=0))throw new RangeError("Invalid range for replacement decoration");if(!this.isReplace&&t!=e)throw new RangeError("Widget decorations can only have zero-length ranges");return super.range(e,t)}};Ft.prototype.point=!0;function tc(n,e=!1){let{inclusiveStart:t,inclusiveEnd:i}=n;return t==null&&(t=n.inclusive),i==null&&(i=n.inclusive),{start:t??e,end:i??e}}function op(n,e){return n==e||!!(n&&e&&n.compare(e))}function ci(n,e,t,i=0){let s=t.length-1;s>=0&&t[s]+i>=n?t[s]=Math.max(t[s],e):t.push(n,e)}var es=class n extends Ne{constructor(e,t,i){super(),this.tagName=e,this.attributes=t,this.rank=i}eq(e){return e==this||e instanceof n&&this.tagName==e.tagName&&_o(this.attributes,e.attributes)}static create(e){return new n(e.tagName,e.attributes||Zn,e.rank==null?50:Math.max(0,Math.min(e.rank,100)))}static set(e,t=!1){return H.of(e,t)}};es.prototype.startSide=es.prototype.endSide=-1;var se=n=>n.nodeType==1,ui=n=>n.nodeType==3;function Ji(n){let e;return n.nodeType==11?e=n.getSelection?n:n.ownerDocument:e=n,e.getSelection()}function Qr(n,e){return e?n==e||n.contains(e.nodeType!=1?e.parentNode:e):!1}function Wi(n,e){if(!e.anchorNode)return!1;try{return Qr(n,e.anchorNode)}catch{return!1}}function Vi(n){return ui(n)?Zi(n,0,n.nodeValue.length).getClientRects():se(n)?n.getClientRects():[]}function zi(n,e,t,i){return t?wh(n,e,t,i,-1)||wh(n,e,t,i,1):!1}function gt(n){for(var e=0;;e++)if(n=n.previousSibling,!n)return e}function ts(n){return se(n)&&/^(DIV|P|LI|UL|OL|BLOCKQUOTE|DD|DT|H\d|SECTION|PRE)$/.test(n.nodeName)}function wh(n,e,t,i,s){for(;;){if(n==t&&e==i)return!0;if(e==(s<0?0:ft(n))){if(n.nodeName=="DIV")return!1;let r=n.parentNode;if(!r||!se(r))return!1;e=gt(n)+(s<0?0:1),n=r}else if(se(n)){if(n=n.childNodes[e+(s<0?-1:0)],se(n)&&(n.nodeName=="IMG"||n.nodeName=="BR"||n.contentEditable=="false"))return!1;e=s<0?ft(n):0}else return!1}}function ft(n){return ui(n)?n.nodeValue.length:n.childNodes.length}function Qi(n,e){let{left:t,right:i}=n;if(t==i)return n;let s=e?t:i;return{left:s,right:s,top:n.top,bottom:n.bottom}}function lp(n){let e=n.visualViewport;return e?{left:0,right:e.width,top:0,bottom:e.height}:{left:0,right:n.innerWidth,top:0,bottom:n.innerHeight}}function ic(n,e){let t=e.width/n.offsetWidth,i=e.height/n.offsetHeight;return(t>.995&&t<1.005||!isFinite(t)||Math.abs(e.width-n.offsetWidth)<1)&&(t=1),(i>.995&&i<1.005||!isFinite(i)||Math.abs(e.height-n.offsetHeight)<1)&&(i=1),{scaleX:t,scaleY:i}}function ap(n,e,t,i,s,r,o,l){let a=n.ownerDocument,h=a.defaultView||window;for(let c=n,f=!1;c&&!f;)if(se(c)){let u,d=c==a.body,p=1,m=1,g=!0,y=!0;if(d)u=lp(h);else{let D=getComputedStyle(c);if(/^(fixed|sticky)$/.test(D.position)&&(f=!0),(c.scrollHeight<=c.clientHeight||!/auto|scroll/.test(D.overflowY))&&(y=!1),(c.scrollWidth<=c.clientWidth||!/auto|scroll/.test(D.overflowX))&&(g=!1),!g&&!y){c=c.assignedSlot||c.parentNode;continue}let w=c.getBoundingClientRect();({scaleX:p,scaleY:m}=ic(c,w)),u={left:w.left,right:w.left+c.clientWidth*p,top:w.top,bottom:w.top+c.clientHeight*m}}let v=0,x=0;if(y)if(s=="nearest")e.top<u.top+o?(x=e.top-(u.top+o),t>0&&e.bottom>u.bottom+x&&(x=e.bottom-u.bottom+o)):e.bottom>u.bottom-o&&(x=e.bottom-u.bottom+o,t<0&&e.top-x<u.top&&(x=e.top-(u.top+o)));else{let D=e.bottom-e.top,w=u.bottom-u.top;x=(s=="center"&&D<=w?e.top+D/2-w/2:s=="start"||s=="center"&&t<0?e.top-o:e.bottom-w+o)-u.top}if(g&&(i=="nearest"?e.left<u.left+r?(v=e.left-(u.left+r),t>0&&e.right>u.right+v&&(v=e.right-u.right+r)):e.right>u.right-r&&(v=e.right-u.right+r,t<0&&e.left<u.left+v&&(v=e.left-(u.left+r))):v=(i=="center"?e.left+(e.right-e.left)/2-(u.right-u.left)/2:i=="start"==l?e.left-r:e.right-(u.right-u.left)+r)-u.left),v||x)if(d)h.scrollBy(v,x);else{let D=0,w=0;if(x){let k=c.scrollTop;c.scrollTop+=x/m,w=(c.scrollTop-k)*m}if(v){let k=c.scrollLeft;c.scrollLeft+=v/p,D=(c.scrollLeft-k)*p}e={left:e.left-D,top:e.top-w,right:e.right-D,bottom:e.bottom-w},D&&Math.abs(D-v)<1&&(i="nearest"),w&&Math.abs(w-x)<1&&(s="nearest")}if(d)break;(e.top<u.top||e.bottom>u.bottom||e.left<u.left||e.right>u.right)&&(e={left:Math.max(e.left,u.left),right:Math.min(e.right,u.right),top:Math.max(e.top,u.top),bottom:Math.min(e.bottom,u.bottom)}),c=c.assignedSlot||c.parentNode}else if(c.nodeType==11)c=c.host;else break}function nc(n,e=!0){let t=n.ownerDocument,i=null,s=null;for(let r=n.parentNode;r&&!(r==t.body||(!e||i)&&s);)if(se(r))!s&&r.scrollHeight>r.clientHeight&&/scroll|auto/.test(getComputedStyle(r).overflowY)&&(s=r),e&&!i&&r.scrollWidth>r.clientWidth&&/scroll|auto/.test(getComputedStyle(r).overflowX)&&(i=r),r=r.assignedSlot||r.parentNode;else if(r.nodeType==11)r=r.host;else break;return{x:i,y:s}}var Zr=class{constructor(){this.anchorNode=null,this.anchorOffset=0,this.focusNode=null,this.focusOffset=0}eq(e){return this.anchorNode==e.anchorNode&&this.anchorOffset==e.anchorOffset&&this.focusNode==e.focusNode&&this.focusOffset==e.focusOffset}setRange(e){let{anchorNode:t,focusNode:i}=e;this.set(t,Math.min(e.anchorOffset,t?ft(t):0),i,Math.min(e.focusOffset,i?ft(i):0))}set(e,t,i,s){this.anchorNode=e,this.anchorOffset=t,this.focusNode=i,this.focusOffset=s}};function sc(n){let e=[];for(let t=n;t;t=t.nodeType==11?t.host:t.parentNode)se(t)&&e.push({node:t,left:t.scrollLeft,top:t.scrollTop});return e}function rc(n,e=!0){for(let{node:t,left:i,top:s}of n)e&&t.scrollTop!=s&&(t.scrollTop=s),t.scrollLeft!=i&&(t.scrollLeft=i)}var Pt=null;M.safari&&M.safari_version>=26&&(Pt=!1);function oc(n){if(n.setActive)return n.setActive();if(Pt)return n.focus(Pt);let e=sc(n);n.focus(Pt==null?{get preventScroll(){return Pt={preventScroll:!0},!0}}:void 0),Pt||(Pt=!1,rc(e))}var vh;function Zi(n,e,t=e){let i=vh||(vh=document.createRange());return i.setEnd(n,t),i.setStart(n,e),i}function fi(n,e,t,i){let s={key:e,code:e,keyCode:t,which:t,cancelable:!0};i&&({altKey:s.altKey,ctrlKey:s.ctrlKey,shiftKey:s.shiftKey,metaKey:s.metaKey}=i);let r=new KeyboardEvent("keydown",s);r.synthetic=!0,n.dispatchEvent(r);let o=new KeyboardEvent("keyup",s);return o.synthetic=!0,n.dispatchEvent(o),r.defaultPrevented||o.defaultPrevented}function hp(n){for(;n;){if(n&&(n.nodeType==9||n.nodeType==11&&n.host))return n;n=n.assignedSlot||n.parentNode}return null}function cp(n,e){let t=e.focusNode,i=e.focusOffset;if(!t||e.anchorNode!=t||e.anchorOffset!=i)return!1;for(i=Math.min(i,ft(t));;)if(i){if(!se(t))return!1;let s=t.childNodes[i-1];s.contentEditable=="false"?i--:(t=s,i=ft(t))}else{if(t==n)return!0;i=gt(t),t=t.parentNode}}function lc(n){return n instanceof Window?n.pageYOffset>Math.max(0,n.document.documentElement.scrollHeight-n.innerHeight-4):n.scrollTop>Math.max(1,n.scrollHeight-n.clientHeight-4)}function ac(n,e){for(let t=n,i=e;;){if(ui(t)&&i>0)return{node:t,offset:i};if(se(t)&&i>0){if(t.contentEditable=="false")return null;t=t.childNodes[i-1],i=ft(t)}else if(t.parentNode&&!ts(t))i=gt(t),t=t.parentNode;else return null}}function hc(n,e){for(let t=n,i=e;;){if(ui(t)&&i<t.nodeValue.length)return{node:t,offset:i};if(se(t)&&i<t.childNodes.length){if(t.contentEditable=="false")return null;t=t.childNodes[i],i=0}else if(t.parentNode&&!ts(t))i=gt(t)+1,t=t.parentNode;else return null}}var Ze=class n{constructor(e,t,i=!0){this.node=e,this.offset=t,this.precise=i}static before(e,t){return new n(e.parentNode,gt(e),t)}static after(e,t){return new n(e.parentNode,gt(e)+1,t)}},z=(function(n){return n[n.LTR=0]="LTR",n[n.RTL=1]="RTL",n})(z||(z={})),di=z.LTR,Yo=z.RTL;function cc(n){let e=[];for(let t=0;t<n.length;t++)e.push(1<<+n[t]);return e}var fp=cc("88888888888888888888888888888888888666888888787833333333337888888000000000000000000000000008888880000000000000000000000000088888888888888888888888888888888888887866668888088888663380888308888800000000000000000000000800000000000000000000000000000008"),up=cc("4444448826627288999999999992222222222222222222222222222222222222222222222229999999999999999999994444444444644222822222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222999999949999999229989999223333333333"),eo=Object.create(null),Qe=[];for(let n of["()","[]","{}"]){let e=n.charCodeAt(0),t=n.charCodeAt(1);eo[e]=t,eo[t]=-e}function fc(n){return n<=247?fp[n]:1424<=n&&n<=1524?2:1536<=n&&n<=1785?up[n-1536]:1774<=n&&n<=2220?4:8192<=n&&n<=8204?256:64336<=n&&n<=65023?4:1}var dp=/[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac\ufb50-\ufdff]/,Ve=class{get dir(){return this.level%2?Yo:di}constructor(e,t,i){this.from=e,this.to=t,this.level=i}side(e,t){return this.dir==t==e?this.to:this.from}forward(e,t){return e==(this.dir==t)}static find(e,t,i,s){let r=-1;for(let o=0;o<e.length;o++){let l=e[o];if(l.from<=t&&l.to>=t){if(l.level==i)return o;(r<0||(s!=0?s<0?l.from<t:l.to>t:e[r].level>l.level))&&(r=o)}}if(r<0)throw new RangeError("Index out of range");return r}};function uc(n,e){if(n.length!=e.length)return!1;for(let t=0;t<n.length;t++){let i=n[t],s=e[t];if(i.from!=s.from||i.to!=s.to||i.direction!=s.direction||!uc(i.inner,s.inner))return!1}return!0}var G=[];function pp(n,e,t,i,s){for(let r=0;r<=i.length;r++){let o=r?i[r-1].to:e,l=r<i.length?i[r].from:t,a=r?256:s;for(let h=o,c=a,f=a;h<l;h++){let u=fc(n.charCodeAt(h));u==512?u=c:u==8&&f==4&&(u=16),G[h]=u==4?2:u,u&7&&(f=u),c=u}for(let h=o,c=a,f=a;h<l;h++){let u=G[h];if(u==128)h<l-1&&c==G[h+1]&&c&24?u=G[h]=c:G[h]=256;else if(u==64){let d=h+1;for(;d<l&&G[d]==64;)d++;let p=h&&c==8||d<t&&G[d]==8?f==1?1:8:256;for(let m=h;m<d;m++)G[m]=p;h=d-1}else u==8&&f==1&&(G[h]=1);c=u,u&7&&(f=u)}}}function mp(n,e,t,i,s){let r=s==1?2:1;for(let o=0,l=0,a=0;o<=i.length;o++){let h=o?i[o-1].to:e,c=o<i.length?i[o].from:t;for(let f=h,u,d,p;f<c;f++)if(d=eo[u=n.charCodeAt(f)])if(d<0){for(let m=l-3;m>=0;m-=3)if(Qe[m+1]==-d){let g=Qe[m+2],y=g&2?s:g&4?g&1?r:s:0;y&&(G[f]=G[Qe[m]]=y),l=m;break}}else{if(Qe.length==189)break;Qe[l++]=f,Qe[l++]=u,Qe[l++]=a}else if((p=G[f])==2||p==1){let m=p==s;a=m?0:1;for(let g=l-3;g>=0;g-=3){let y=Qe[g+2];if(y&2)break;if(m)Qe[g+2]|=2;else{if(y&4)break;Qe[g+2]|=4}}}}}function gp(n,e,t,i){for(let s=0,r=i;s<=t.length;s++){let o=s?t[s-1].to:n,l=s<t.length?t[s].from:e;for(let a=o;a<l;){let h=G[a];if(h==256){let c=a+1;for(;;)if(c==l){if(s==t.length)break;c=t[s++].to,l=s<t.length?t[s].from:e}else if(G[c]==256)c++;else break;let f=r==1,u=(c<e?G[c]:i)==1,d=f==u?f?1:2:i;for(let p=c,m=s,g=m?t[m-1].to:n;p>a;)p==g&&(p=t[--m].from,g=m?t[m-1].to:n),G[--p]=d;a=c}else r=h,a++}}}function to(n,e,t,i,s,r,o){let l=i%2?2:1;if(i%2==s%2)for(let a=e,h=0;a<t;){let c=!0,f=!1;if(h==r.length||a<r[h].from){let m=G[a];m!=l&&(c=!1,f=m==16)}let u=!c&&l==1?[]:null,d=c?i:i+1,p=a;e:for(;;)if(h<r.length&&p==r[h].from){if(f)break e;let m=r[h];if(!c)for(let g=m.to,y=h+1;;){if(g==t)break e;if(y<r.length&&r[y].from==g)g=r[y++].to;else{if(G[g]==l)break e;break}}if(h++,u)u.push(m);else{m.from>a&&o.push(new Ve(a,m.from,d));let g=m.direction==di!=!(d%2);io(n,g?i+1:i,s,m.inner,m.from,m.to,o),a=m.to}p=m.to}else{if(p==t||(c?G[p]!=l:G[p]==l))break;p++}u?to(n,a,p,i+1,s,u,o):a<p&&o.push(new Ve(a,p,d)),a=p}else for(let a=t,h=r.length;a>e;){let c=!0,f=!1;if(!h||a>r[h-1].to){let m=G[a-1];m!=l&&(c=!1,f=m==16)}let u=!c&&l==1?[]:null,d=c?i:i+1,p=a;e:for(;;)if(h&&p==r[h-1].to){if(f)break e;let m=r[--h];if(!c)for(let g=m.from,y=h;;){if(g==e)break e;if(y&&r[y-1].to==g)g=r[--y].from;else{if(G[g-1]==l)break e;break}}if(u)u.push(m);else{m.to<a&&o.push(new Ve(m.to,a,d));let g=m.direction==di!=!(d%2);io(n,g?i+1:i,s,m.inner,m.from,m.to,o),a=m.from}p=m.from}else{if(p==e||(c?G[p-1]!=l:G[p-1]==l))break;p--}u?to(n,p,a,i+1,s,u,o):p<a&&o.push(new Ve(p,a,d)),a=p}}function io(n,e,t,i,s,r,o){let l=e%2?2:1;pp(n,s,r,i,l),mp(n,s,r,i,l),gp(s,r,i,l),to(n,s,r,e,t,i,o)}function yp(n,e,t){if(!n)return[new Ve(0,0,e==Yo?1:0)];if(e==di&&!t.length&&!dp.test(n))return dc(n.length);if(t.length)for(;n.length>G.length;)G[G.length]=256;let i=[],s=e==di?0:1;return io(n,s,s,t,0,n.length,i),i}function dc(n){return[new Ve(0,n,0)]}var pc="";function bp(n,e,t,i,s){var r;if(!n.length)return null;let o=i.head-n.from,l;if(i.head==n.from&&i.assoc<0){if(!s)return null;o=e[l=0].side(!1,t)}else if(i.head==n.to&&i.assoc>0){if(s)return null;o=e[l=e.length-1].side(!0,t)}else l=Ve.find(e,o,(r=i.bidiLevel)!==null&&r!==void 0?r:-1,i.assoc);let a=e[l],h=a.side(s,t);if(o==h){let u=l+=s?1:-1;if(u<0||u>=e.length)return null;a=e[l=u],o=a.side(!s,t),h=a.side(s,t)}let c=ee(n.text,o,a.forward(s,t));(c<a.from||c>a.to)&&(c=h),pc=n.text.slice(Math.min(o,c),Math.max(o,c));let f=l==(s?e.length-1:0)?null:e[l+(s?1:-1)];if(c==h){if(!f)return s?b.cursor(n.to,1):b.cursor(n.from,-1);if(f.level+(s?0:1)<a.level)return b.cursor(f.side(!s,t)+n.from,f.forward(s,t)?1:-1,f.level)}return b.cursor(c+n.from,a.forward(s,t)?-1:1,a.level)}function xp(n,e,t){for(let i=e;i<t;i++){let s=fc(n.charCodeAt(i));if(s==1)return di;if(s==2||s==4)return Yo}}var mc=C.define(),gc=C.define(),yc=C.define(),bc=C.define(),no=C.define(),xc=C.define(),wc=C.define(),Xo=C.define(),Jo=C.define(),vc=C.define({combine:n=>n.some(e=>e)}),kc=C.define({combine:n=>n.some(e=>e)}),Sc=C.define(),qi=class n{constructor(e,t,i,s,r,o=!1){this.range=e,this.y=t,this.x=i,this.yMargin=s,this.xMargin=r,this.isSnapshot=o}map(e){return e.empty?this:new n(this.range.map(e),this.y,this.x,this.yMargin,this.xMargin,this.isSnapshot)}clip(e){return this.range.to<=e.doc.length?this:new n(b.cursor(e.doc.length),this.y,this.x,this.yMargin,this.xMargin,this.isSnapshot)}},Wn=L.define({map:(n,e)=>n.map(e)}),Cc=L.define();function ce(n,e,t){let i=n.facet(bc);i.length?i[0](e):window.onerror&&window.onerror(String(e),t,void 0,void 0,e)||(t?console.error(t+":",e):console.error(e))}var ht=C.define({combine:n=>n.length?n[0]:!0}),wp=0,oi=C.define({combine(n){return n.filter((e,t)=>{for(let i=0;i<t;i++)if(n[i].plugin==e.plugin)return!1;return!0})}}),K=class n{constructor(e,t,i,s,r){this.id=e,this.create=t,this.domEventHandlers=i,this.domEventObservers=s,this.baseExtensions=r(this),this.extension=this.baseExtensions.concat(oi.of({plugin:this,arg:void 0}))}of(e){return this.baseExtensions.concat(oi.of({plugin:this,arg:e}))}static define(e,t){let{eventHandlers:i,eventObservers:s,provide:r,decorations:o}=t||{};return new n(wp++,e,i,s,l=>{let a=[];return o&&a.push(bs.of(h=>{let c=h.plugin(l);return c?o(c):B.none})),r&&a.push(r(l)),a})}static fromClass(e,t){return n.define((i,s)=>new e(i,s),t)}},Ki=class{constructor(e){this.spec=e,this.mustUpdate=null,this.value=null}get plugin(){return this.spec&&this.spec.plugin}update(e){if(this.value){if(this.mustUpdate){let t=this.mustUpdate;if(this.mustUpdate=null,this.value.update)try{this.value.update(t)}catch(i){if(ce(t.state,i,"CodeMirror plugin crashed"),this.value.destroy)try{this.value.destroy()}catch{}this.deactivate()}}}else if(this.spec)try{this.value=this.spec.plugin.create(e,this.spec.arg)}catch(t){ce(e.state,t,"CodeMirror plugin crashed"),this.deactivate()}return this}destroy(e){var t;if(!((t=this.value)===null||t===void 0)&&t.destroy)try{this.value.destroy()}catch(i){ce(e.state,i,"CodeMirror plugin crashed")}}deactivate(){this.spec=this.value=null}},Ac=C.define(),ys=C.define(),bs=C.define(),Mc=C.define(),Qo=C.define(),en=C.define(),Tc=C.define();function kh(n,e){let t=n.state.facet(Tc);if(!t.length)return t;let i=t.map(r=>r instanceof Function?r(n):r),s=[];return H.spans(i,e.from,e.to,{point(){},span(r,o,l,a){let h=r-e.from,c=o-e.from,f=s;for(let u=l.length-1;u>=0;u--,a--){let d=l[u].spec.bidiIsolate,p;if(a>0&&f.length&&(p=f[f.length-1]).to==h&&p.direction==d)p.to=c,f=p.inner;else{let m={from:h,to:c,direction:d,inner:[]};f.push(m),f=m.inner}}}}),Dc(e.text,s)}function Dc(n,e){for(let t of e){if(t.direction==null){for(let i=t.from,s=0;i<t.to;s++){let r=s<t.inner.length?t.inner[s]:null,o=xp(n,i,r?r.from:t.to);if(o){t.direction=o;break}if(!r)break;i=r.to}t.direction==null&&(t.direction=z.LTR)}Dc(n,t.inner)}return e}var Oc=C.define();function Zo(n){let e=0,t=0,i=0,s=0;for(let r of n.state.facet(Oc)){let o=r(n);o&&(o.left!=null&&(e=Math.max(e,o.left)),o.right!=null&&(t=Math.max(t,o.right)),o.top!=null&&(i=Math.max(i,o.top)),o.bottom!=null&&(s=Math.max(s,o.bottom)))}return{left:e,right:t,top:i,bottom:s}}var Ni=C.define(),je=class n{constructor(e,t,i,s){this.fromA=e,this.toA=t,this.fromB=i,this.toB=s}join(e){return new n(Math.min(this.fromA,e.fromA),Math.max(this.toA,e.toA),Math.min(this.fromB,e.fromB),Math.max(this.toB,e.toB))}addToSet(e){let t=e.length,i=this;for(;t>0;t--){let s=e[t-1];if(!(s.fromA>i.toA)){if(s.toA<i.fromA)break;i=i.join(s),e.splice(t-1,1)}}return e.splice(t,0,i),e}static extendWithRanges(e,t){if(t.length==0)return e;let i=[];for(let s=0,r=0,o=0;;){let l=s<e.length?e[s].fromB:1e9,a=r<t.length?t[r]:1e9,h=Math.min(l,a);if(h==1e9)break;let c=h+o,f=h,u=c;for(;;)if(r<t.length&&t[r]<=f){let d=t[r+1];r+=2,f=Math.max(f,d);for(let p=s;p<e.length&&e[p].fromB<=f;p++)o=e[p].toA-e[p].toB;u=Math.max(u,d+o)}else if(s<e.length&&e[s].fromB<=f){let d=e[s++];f=Math.max(f,d.toB),u=Math.max(u,d.toA),o=d.toA-d.toB}else break;i.push(new n(c,u,h,f))}return i}},is=class n{constructor(e,t,i){this.view=e,this.state=t,this.transactions=i,this.flags=0,this.startState=e.state,this.changes=be.empty(this.startState.doc.length);for(let r of i)this.changes=this.changes.compose(r.changes);let s=[];this.changes.iterChangedRanges((r,o,l,a)=>s.push(new je(r,o,l,a))),this.changedRanges=s}static create(e,t,i){return new n(e,t,i)}get viewportChanged(){return(this.flags&4)>0}get viewportMoved(){return(this.flags&8)>0}get heightChanged(){return(this.flags&2)>0}get geometryChanged(){return this.docChanged||(this.flags&18)>0}get focusChanged(){return(this.flags&1)>0}get docChanged(){return!this.changes.empty}get selectionSet(){return this.transactions.some(e=>e.selection)}get empty(){return this.flags==0&&this.transactions.length==0}},vp=[],J=class{constructor(e,t,i=0){this.dom=e,this.length=t,this.flags=i,this.parent=null,e.cmTile=this}get breakAfter(){return this.flags&1}get children(){return vp}isWidget(){return!1}get isHidden(){return!1}isComposite(){return!1}isLine(){return!1}isText(){return!1}isBlock(){return!1}get domAttrs(){return null}sync(e){if(this.flags|=2,this.flags&4){this.flags&=-5;let t=this.domAttrs;t&&sp(this.dom,t)}}toString(){return this.constructor.name+(this.children.length?`(${this.children})`:"")+(this.breakAfter?"#":"")}destroy(){this.parent=null}setDOM(e){this.dom=e,e.cmTile=this}get posAtStart(){return this.parent?this.parent.posBefore(this):0}get posAtEnd(){return this.posAtStart+this.length}posBefore(e,t=this.posAtStart){let i=t;for(let s of this.children){if(s==e)return i;i+=s.length+s.breakAfter}throw new RangeError("Invalid child in posBefore")}posAfter(e){return this.posBefore(e)+e.length}covers(e){return!0}coordsIn(e,t,i){return null}domPosFor(e,t){let i=gt(this.dom),s=this.length?e>0:t>0;return new Ze(this.parent.dom,i+(s?1:0),e==0||e==this.length)}markDirty(e){this.flags&=-3,e&&(this.flags|=4),this.parent&&this.parent.flags&2&&this.parent.markDirty(!1)}get overrideDOMText(){return null}get root(){for(let e=this;e;e=e.parent)if(e instanceof mi)return e;return null}static get(e){return e.cmTile}},pi=class extends J{constructor(e){super(e,0),this._children=[]}isComposite(){return!0}get children(){return this._children}get lastChild(){return this.children.length?this.children[this.children.length-1]:null}append(e){this.children.push(e),e.parent=this}sync(e){if(this.flags&2)return;super.sync(e);let t=this.dom,i=null,s,r=e?.node==t?e:null,o=0;for(let l of this.children){if(l.sync(e),o+=l.length+l.breakAfter,s=i?i.nextSibling:t.firstChild,r&&s!=l.dom&&(r.written=!0),l.dom.parentNode==t)for(;s&&s!=l.dom;)s=Sh(s);else t.insertBefore(l.dom,s);i=l.dom}for(s=i?i.nextSibling:t.firstChild,r&&s&&(r.written=!0);s;)s=Sh(s);this.length=o}};function Sh(n){let e=n.nextSibling;return n.parentNode.removeChild(n),e}var mi=class extends pi{constructor(e,t){super(t),this.view=e}owns(e){for(;e;e=e.parent)if(e==this)return!0;return!1}isBlock(){return!0}nearest(e){for(;;){if(!e)return null;let t=J.get(e);if(t&&this.owns(t))return t;e=e.parentNode}}blockTiles(e){for(let t=[],i=this,s=0,r=0;;)if(s==i.children.length){if(!t.length)return;i=i.parent,i.breakAfter&&r++,s=t.pop()}else{let o=i.children[s++];if(o instanceof ct)t.push(s),i=o,s=0;else{let l=r+o.length,a=e(o,r);if(a!==void 0)return a;r=l+o.breakAfter}}}resolveBlock(e,t){let i,s=-1,r,o=-1;if(this.blockTiles((l,a)=>{let h=a+l.length;if(e>=a&&e<=h){if(l.isWidget()&&t>=-1&&t<=1){if(l.flags&32)return!0;l.flags&16&&(i=void 0)}(a<e||e==h&&(t<-1?l.length:l.covers(1)))&&(!i||!l.isWidget()&&i.isWidget())&&(i=l,s=e-a),(h>e||e==a&&(t>1?l.length:l.covers(-1)))&&(!r||!l.isWidget()&&r.isWidget())&&(r=l,o=e-a)}}),!i&&!r)throw new Error("No tile at position "+e);return i&&t<0||!r?{tile:i,offset:s}:{tile:r,offset:o}}},ct=class n extends pi{constructor(e,t){super(e),this.wrapper=t}isBlock(){return!0}covers(e){return this.children.length?e<0?this.children[0].covers(-1):this.lastChild.covers(1):!1}get domAttrs(){return this.wrapper.attributes}static of(e,t){let i=new n(t||document.createElement(e.tagName),e);return t||(i.flags|=4),i}},gi=class n extends pi{constructor(e,t){super(e),this.attrs=t}isLine(){return!0}static start(e,t,i){let s=new n(t||document.createElement("div"),e);return(!t||!i)&&(s.flags|=4),s}get domAttrs(){return this.attrs}resolveInline(e,t,i=!1){let s=null,r=-1,o=null,l=-1;function a(c,f){for(let u=0,d=0;u<c.children.length&&d<=f;u++){let p=c.children[u],m=d+p.length;m>=f&&(p.isComposite()?a(p,f-d):(!o||i&&o.isHidden&&(t>0&&!(o.flags&32)||i&&Sp(o,p)))&&(m>f||p.flags&32&&t<=1)?(o=p,l=f-d):(d<f||p.flags&16&&!(i&&p.isHidden)&&t>=-1)&&(s=p,r=f-d)),d=m}}a(this,e);let h=(t<0?s:o)||s||o;return h?{tile:h,offset:h==s?r:l}:null}coordsIn(e,t,i){let s=this.resolveInline(e,t,!0);return s?s.tile.coordsIn(Math.max(0,s.offset),t,i):kp(this)}domIn(e,t){let i=this.resolveInline(e,t);if(i){let{tile:s,offset:r}=i;if(this.dom.contains(s.dom))return s.isText()?new Ze(s.dom,Math.min(s.dom.nodeValue.length,r)):s.domPosFor(r,s.flags&16?1:s.flags&32?-1:t);let o=i.tile.parent,l=!1;for(let a of o.children){if(l)return new Ze(a.dom,0);a==i.tile&&(l=!0)}}return new Ze(this.dom,0)}};function kp(n){let e=n.dom.lastChild;if(!e)return n.dom.getBoundingClientRect();let t=Vi(e);return t[t.length-1]||null}function Sp(n,e){let t=n.coordsIn(0,1),i=e.coordsIn(0,1);return t&&i&&i.top<t.bottom}var Ce=class n extends pi{constructor(e,t){super(e),this.mark=t}get domAttrs(){return this.mark.attrs}static of(e,t){let i=new n(t||document.createElement(e.tagName),e);return t||(i.flags|=4),i}},It=class n extends J{constructor(e,t){super(e,t.length),this.text=t}sync(e){this.flags&2||(super.sync(e),this.dom.nodeValue!=this.text&&(e&&e.node==this.dom&&(e.written=!0),this.dom.nodeValue=this.text))}isText(){return!0}toString(){return JSON.stringify(this.text)}coordsIn(e,t,i){let s=this.dom.nodeValue.length;e>s&&(e=s);let r=e,o=e,l=0;e==0&&t<0||e==s&&t>=0?M.chrome||M.gecko||(e?(r--,l=1):o<s&&(o++,l=-1)):t<0?r--:o<s&&o++;let a=Zi(this.dom,r,o).getClientRects();if(!a.length)return null;let h=a[(l?l<0:t>=0)?0:a.length-1];return M.safari&&!l&&h.width==0&&(h=Array.prototype.find.call(a,c=>c.width)||h),i==null?h:Qi(h,(l?l>0:t<0)==i)}static of(e,t){let i=new n(t||document.createTextNode(e),e);return t||(i.flags|=2),i}},Ht=class n extends J{constructor(e,t,i,s){super(e,t,s),this.widget=i}isWidget(){return!0}get isHidden(){return this.widget.isHidden}covers(e){return this.flags&48?!1:(this.flags&(e<0?64:128))>0}coordsIn(e,t){return this.coordsInWidget(e,t,!1)}coordsInWidget(e,t,i){let s=this.widget.coordsAt(this.dom,e,t);if(s)return s;if(i)return Qi(this.dom.getBoundingClientRect(),this.length?e==0:t<=0);{let r=this.dom.getClientRects(),o=null;if(!r.length)return null;let l=this.flags&16?!0:this.flags&32?!1:e>0;for(let a=l?r.length-1:0;o=r[a],!(e>0?a==0:a==r.length-1||o.top<o.bottom);a+=l?-1:1);return Qi(o,!l)}}get overrideDOMText(){if(!this.length)return N.empty;let{root:e}=this;if(!e)return N.empty;let t=this.posAtStart;return e.view.state.doc.slice(t,t+this.length)}destroy(){super.destroy(),this.widget.destroy(this.dom)}static of(e,t,i,s,r){return r||(r=e.toDOM(t),e.editable||(r.contentEditable="false")),new n(r,i,e,s)}},yi=class extends J{constructor(e){let t=document.createElement("img");t.className="cm-widgetBuffer",t.setAttribute("aria-hidden","true"),super(t,0,e)}get isHidden(){return!0}get overrideDOMText(){return N.empty}coordsIn(e,t,i){let s=this.dom.getBoundingClientRect();return i==null?s:Qi(s,t>0==i)}},so=class{constructor(e){this.index=0,this.beforeBreak=!1,this.parents=[],this.tile=e}advance(e,t,i){let{tile:s,index:r,beforeBreak:o,parents:l}=this;for(;e||t>0;)if(s.isComposite())if(o){if(!e)break;i&&i.break(),e--,o=!1}else if(r==s.children.length){if(!e&&!l.length)break;i&&i.leave(s),o=!!s.breakAfter,{tile:s,index:r}=l.pop(),r++}else{let a=s.children[r],h=a.breakAfter;(t>0?a.length<=e:a.length<e)&&(!i||i.skip(a,0,a.length)!==!1||!a.isComposite)?(o=!!h,r++,e-=a.length):(l.push({tile:s,index:r}),s=a,r=0,i&&a.isComposite()&&i.enter(a))}else{let a=s.length;if(r<a&&e){let h=Math.min(e,a-r);i&&i.skip(s,r,r+h),e-=h,r+=h}if(r==a)o=!!s.breakAfter,{tile:s,index:r}=l.pop(),r++;else if(!e)break}return this.tile=s,this.index=r,this.beforeBreak=o,this}get root(){return this.parents.length?this.parents[0].tile:this.tile}},ro=class{constructor(e,t,i,s){this.from=e,this.to=t,this.wrapper=i,this.rank=s}},oo=class{constructor(e,t,i){this.cache=e,this.root=t,this.blockWrappers=i,this.curLine=null,this.lastBlock=null,this.afterWidget=null,this.pos=0,this.wrappers=[],this.wrapperPos=0}addText(e,t,i,s){var r;this.flushBuffer();let o=this.ensureMarks(t,i),l=o.lastChild;if(l&&l.isText()&&!(l.flags&8)&&l.length+e.length<512){this.cache.reused.set(l,2);let a=o.children[o.children.length-1]=new It(l.dom,l.text+e);a.parent=o}else o.append(s||It.of(e,(r=this.cache.find(It))===null||r===void 0?void 0:r.dom));this.pos+=e.length,this.afterWidget=null}addComposition(e,t){let i=this.curLine;i.dom!=t.line.dom&&(i.setDOM(this.cache.reused.has(t.line)?zr(t.line.dom):t.line.dom),this.cache.reused.set(t.line,2));let s=i;for(let l=t.marks.length-1;l>=0;l--){let a=t.marks[l],h=s.lastChild;if(h instanceof Ce&&h.mark.eq(a.mark))h.dom!=a.dom&&h.setDOM(zr(a.dom)),s=h;else{let{dom:c}=a;this.cache.reused.get(a)&&J.get(a.dom)&&(c=zr(a.dom));let f=Ce.of(a.mark,c);s.append(f),s=f}this.cache.reused.set(a,2)}let r=J.get(e.text);r&&this.cache.reused.set(r,2);let o=new It(e.text,e.text.nodeValue);o.flags|=8,this.pos=e.range.toB,s.append(o)}addInlineWidget(e,t,i){let s=this.afterWidget&&e.flags&48&&(this.afterWidget.flags&48)==(e.flags&48);s||this.flushBuffer();let r=this.ensureMarks(t,i);!s&&!(e.flags&16)&&r.append(this.getBuffer(1)),r.append(e),this.pos+=e.length,this.afterWidget=e}addMark(e,t,i){this.flushBuffer(),this.ensureMarks(t,i).append(e),this.pos+=e.length,this.afterWidget=null}addBlockWidget(e){this.getBlockPos().append(e),this.pos+=e.length,this.lastBlock=e,this.endLine()}continueWidget(e){let t=this.afterWidget||this.lastBlock;t.length+=e,this.pos+=e}addLineStart(e,t){var i;e||(e=Bc);let s=gi.start(e,t||((i=this.cache.find(gi))===null||i===void 0?void 0:i.dom),!!t);this.getBlockPos().append(this.lastBlock=this.curLine=s)}addLine(e){this.getBlockPos().append(e),this.pos+=e.length,this.lastBlock=e,this.endLine()}addBreak(){this.lastBlock.flags|=1,this.endLine(),this.pos++}addLineStartIfNotCovered(e){this.blockPosCovered()||this.addLineStart(e)}ensureLine(e){this.curLine||this.addLineStart(e)}ensureMarks(e,t){var i;let s=this.curLine;for(let r=e.length-1;r>=0;r--){let o=e[r],l;if(t>0&&(l=s.lastChild)&&l instanceof Ce&&l.mark.eq(o))s=l,t--;else{let a=Ce.of(o,(i=this.cache.find(Ce,h=>h.mark.eq(o)))===null||i===void 0?void 0:i.dom);s.append(a),s=a,t=0}}return s}endLine(){if(this.curLine){this.flushBuffer();let e=this.curLine.lastChild;(!e||!Ch(this.curLine,!1)||e.dom.nodeName!="BR"&&e.isWidget()&&!(M.ios&&Ch(this.curLine,!0)))&&this.curLine.append(this.cache.findWidget(qr,0,32)||new Ht(qr.toDOM(),0,qr,32)),this.curLine=this.afterWidget=null}}updateBlockWrappers(){this.wrapperPos>this.pos+1e4&&(this.blockWrappers.goto(this.pos),this.wrappers.length=0);for(let e=this.wrappers.length-1;e>=0;e--)this.wrappers[e].to<this.pos&&this.wrappers.splice(e,1);for(let e=this.blockWrappers;e.value&&e.from<=this.pos;e.next())if(e.to>=this.pos){let t=e.rank*102+e.value.rank,i=new ro(e.from,e.to,e.value,t),s=this.wrappers.length;for(;s>0&&(this.wrappers[s-1].rank-i.rank||this.wrappers[s-1].to-i.to)<0;)s--;this.wrappers.splice(s,0,i)}this.wrapperPos=this.pos}getBlockPos(){var e;this.updateBlockWrappers();let t=this.root;for(let i of this.wrappers){let s=t.lastChild;if(i.from<this.pos&&s instanceof ct&&s.wrapper.eq(i.wrapper))t=s;else{let r=ct.of(i.wrapper,(e=this.cache.find(ct,o=>o.wrapper.eq(i.wrapper)))===null||e===void 0?void 0:e.dom);t.append(r),t=r}}return t}blockPosCovered(){let e=this.lastBlock;return e!=null&&!e.breakAfter&&(!e.isWidget()||(e.flags&160)>0)}getBuffer(e){let t=2|(e<0?16:32),i=this.cache.find(yi,void 0,1);return i&&(i.flags=t),i||new yi(t)}flushBuffer(){this.afterWidget&&!(this.afterWidget.flags&32)&&(this.afterWidget.parent.append(this.getBuffer(-1)),this.afterWidget=null)}},lo=class{constructor(e){this.skipCount=0,this.text="",this.textOff=0,this.cursor=e.iter()}skip(e){this.textOff+e<=this.text.length?this.textOff+=e:(this.skipCount+=e-(this.text.length-this.textOff),this.text="",this.textOff=0)}next(e){if(this.textOff==this.text.length){let{value:s,lineBreak:r,done:o}=this.cursor.next(this.skipCount);if(this.skipCount=0,o)throw new Error("Ran out of text content when drawing inline views");this.text=s;let l=this.textOff=Math.min(e,s.length);return r?null:s.slice(0,l)}let t=Math.min(this.text.length,this.textOff+e),i=this.text.slice(this.textOff,t);return this.textOff=t,i}},ns=[Ht,gi,It,Ce,yi,ct,mi];for(let n=0;n<ns.length;n++)ns[n].bucket=n;var ao=class{constructor(e){this.view=e,this.buckets=ns.map(()=>[]),this.index=ns.map(()=>0),this.reused=new Map}add(e){let t=e.constructor.bucket,i=this.buckets[t];i.length<6?i.push(e):i[this.index[t]=(this.index[t]+1)%6]=e}find(e,t,i=2){let s=e.bucket,r=this.buckets[s],o=this.index[s];for(let l=0;l<r.length;l++){let a=(l+o)%r.length,h=r[a];if((!t||t(h))&&!this.reused.has(h))return r.splice(a,1),a<o&&this.index[s]--,this.reused.set(h,i),h}return null}findWidget(e,t,i){let s=this.buckets[0];if(s.length)for(let r=0,o=0;;r++){if(r==s.length){if(o)return null;o=1,r=0}let l=s[r];if(!this.reused.has(l)&&(o==0?l.widget.compare(e):l.widget.constructor==e.constructor&&e.updateDOM(l.dom,this.view,l.widget)))return s.splice(r,1),r<this.index[0]&&this.index[0]--,l.widget==e&&l.length==t&&(l.flags&497)==i?(this.reused.set(l,1),l):(this.reused.set(l,2),new Ht(l.dom,t,e,l.flags&-498|i))}}reuse(e){return this.reused.set(e,1),e}maybeReuse(e,t=2){if(!this.reused.has(e))return this.reused.set(e,t),e.dom}clear(){for(let e=0;e<this.buckets.length;e++)this.buckets[e].length=this.index[e]=0}},ho=class{constructor(e,t,i,s,r){this.view=e,this.decorations=s,this.disallowBlockEffectsFor=r,this.openWidget=!1,this.openMarks=0,this.cache=new ao(e),this.text=new lo(e.state.doc),this.builder=new oo(this.cache,new mi(e,e.contentDOM),H.iter(i)),this.cache.reused.set(t,2),this.old=new so(t),this.reuseWalker={skip:(o,l,a)=>{if(this.cache.add(o),o.isComposite())return!1},enter:o=>this.cache.add(o),leave:()=>{},break:()=>{}}}run(e,t){let i=t&&this.getCompositionContext(t.text);for(let s=0,r=0,o=0;;){let l=o<e.length?e[o++]:null,a=l?l.fromA:this.old.root.length;if(a>s){let h=a-s;this.preserve(h,!o,!l),s=a,r+=h}if(!l)break;t&&l.fromA<=t.range.fromA&&l.toA>=t.range.toA?(this.forward(l.fromA,t.range.fromA,t.range.fromA<t.range.toA?1:-1),this.emit(r,t.range.fromB),this.builder.flushBuffer(),this.cache.clear(),this.builder.addComposition(t,i),this.text.skip(t.range.toB-t.range.fromB),this.forward(t.range.fromA,l.toA),this.emit(t.range.toB,l.toB)):(this.forward(l.fromA,l.toA),this.emit(r,l.toB)),r=l.toB,s=l.toA}return this.builder.curLine&&this.builder.endLine(),this.builder.root}preserve(e,t,i){let s=Mp(this.old),r=this.openMarks;this.old.advance(e,i?1:-1,{skip:(o,l,a)=>{if(o.isWidget())if(this.openWidget)this.builder.continueWidget(a-l);else{let h=a>0||l<o.length?Ht.of(o.widget,this.view,a-l,o.flags&496,this.cache.maybeReuse(o)):this.cache.reuse(o);h.flags&256?(h.flags&=-2,this.builder.addBlockWidget(h)):(this.builder.ensureLine(null),this.builder.addInlineWidget(h,s,r),r=s.length)}else if(o.isText())this.builder.ensureLine(null),!l&&a==o.length&&!this.cache.reused.has(o)?this.builder.addText(o.text,s,r,this.cache.reuse(o)):(this.cache.add(o),this.builder.addText(o.text.slice(l,a),s,r)),r=s.length;else if(o.isLine())o.flags&=-2,this.cache.reused.set(o,1),this.builder.addLine(o);else if(o instanceof yi)this.cache.add(o);else if(o instanceof Ce)this.builder.ensureLine(null),this.builder.addMark(o,s,r),this.cache.reused.set(o,1),r=s.length;else return!1;this.openWidget=!1},enter:o=>{o.isLine()?this.builder.addLineStart(o.attrs,this.cache.maybeReuse(o)):(this.cache.add(o),o instanceof Ce&&s.unshift(o.mark)),this.openWidget=!1},leave:o=>{o.isLine()?s.length&&(s.length=r=0):o instanceof Ce&&(s.shift(),r=Math.min(r,s.length))},break:()=>{this.builder.addBreak(),this.openWidget=!1}}),this.text.skip(e)}emit(e,t){let i=null,s=this.builder,r=-1,o=H.spans(this.decorations,e,t,{point:(l,a,h,c,f,u)=>{if(h instanceof Ft){if(this.disallowBlockEffectsFor[u]){if(h.block)throw new RangeError("Block decorations may not be specified via plugins");if(a>this.view.state.doc.lineAt(l).to)throw new RangeError("Decorations that replace line breaks may not be specified via plugins")}if(r=c.length,f>c.length)s.continueWidget(a-l);else{let d=h.widget||(h.block?yt.block:yt.inline),p=Cp(h),m=this.cache.findWidget(d,a-l,p)||Ht.of(d,this.view,a-l,p);h.block?(h.startSide>0&&s.addLineStartIfNotCovered(i),s.addBlockWidget(m)):(s.ensureLine(i),s.addInlineWidget(m,c,f))}i=null}else i=Ap(i,h);a>l&&this.text.skip(a-l)},span:(l,a,h,c)=>{for(let f=l;f<a;){let u=this.text.next(Math.min(512,a-f));u==null?(s.addLineStartIfNotCovered(i),s.addBreak(),f++):(s.ensureLine(i),s.addText(u,h,f==l?c:h.length),f+=u.length),i=null}r=h.length}});r>-1&&(this.openWidget=o>r),this.openWidget||s.addLineStartIfNotCovered(i),this.openMarks=o}forward(e,t,i=1){t-e<=10?this.old.advance(t-e,i,this.reuseWalker):(this.old.advance(5,-1,this.reuseWalker),this.old.advance(t-e-10,-1),this.old.advance(5,i,this.reuseWalker))}getCompositionContext(e){let t=[],i=null;for(let s=e.parentNode;;s=s.parentNode){let r=J.get(s);if(s==this.view.contentDOM)break;r instanceof Ce?t.push(r):r?.isLine()?i=r:r instanceof ct||(s.nodeName=="DIV"&&!i?i=new gi(s,Bc):i||t.push(Ce.of(new Yi({tagName:s.nodeName.toLowerCase(),attributes:rp(s)}),s)))}return i?{line:i,marks:t}:null}};function Ch(n,e){let t=i=>{for(let s of i.children)if((e?s.isText():s.length)||t(s))return!0;return!1};return t(n)}function Cp(n){let e=n.isReplace?(n.startSide<0?64:0)|(n.endSide>0?128:0):n.startSide>0?32:16;return n.block&&(e|=256),e}var Bc={class:"cm-line"};function Ap(n,e){let t=e.spec.attributes,i=e.spec.class;return!t&&!i||(n||(n={class:"cm-line"}),t&&Go(t,n),i&&(n.class+=" "+i)),n}function Mp(n){let e=[];for(let t=n.parents.length;t>1;t--){let i=t==n.parents.length?n.tile:n.parents[t].tile;i instanceof Ce&&e.push(i.mark)}return e}function zr(n){let e=J.get(n);return e&&e.setDOM(n.cloneNode()),n}var yt=class extends re{constructor(e){super(),this.tag=e}eq(e){return e.tag==this.tag}toDOM(){return document.createElement(this.tag)}updateDOM(e){return e.nodeName.toLowerCase()==this.tag}get isHidden(){return!0}};yt.inline=new yt("span");yt.block=new yt("div");var qr=new class extends re{toDOM(){return document.createElement("br")}get isHidden(){return!0}get editable(){return!0}},ss=class{constructor(e){this.view=e,this.decorations=[],this.blockWrappers=[],this.dynamicDecorationMap=[!1],this.domChanged=null,this.hasComposition=null,this.editContextFormatting=B.none,this.lastCompositionAfterCursor=!1,this.minWidth=0,this.minWidthFrom=0,this.minWidthTo=0,this.impreciseAnchor=null,this.impreciseHead=null,this.forceSelection=!1,this.lastUpdate=Date.now(),this.updateDeco(),this.tile=new mi(e,e.contentDOM),this.updateInner([new je(0,0,0,e.state.doc.length)],null)}update(e){var t;let i=e.changedRanges;this.minWidth>0&&i.length&&(i.every(({fromA:c,toA:f})=>f<this.minWidthFrom||c>this.minWidthTo)?(this.minWidthFrom=e.changes.mapPos(this.minWidthFrom,1),this.minWidthTo=e.changes.mapPos(this.minWidthTo,1)):this.minWidth=this.minWidthFrom=this.minWidthTo=0),this.updateEditContextFormatting(e);let s=-1;this.view.inputState.composing>=0&&!this.view.observer.editContext&&(!((t=this.domChanged)===null||t===void 0)&&t.newSel?s=this.domChanged.newSel.head:!Pp(e.changes,this.hasComposition)&&!e.selectionSet&&(s=e.state.selection.main.head));let r=s>-1?Dp(this.view,e.changes,s):null;if(this.domChanged=null,this.hasComposition){let{from:c,to:f}=this.hasComposition;i=new je(c,f,e.changes.mapPos(c,-1),e.changes.mapPos(f,1)).addToSet(i.slice())}this.hasComposition=r?{from:r.range.fromB,to:r.range.toB}:null,(M.ie||M.chrome)&&!r&&e&&e.state.doc.lines!=e.startState.doc.lines&&(this.forceSelection=!0);let o=this.decorations,l=this.blockWrappers;this.updateDeco();let a=Lp(o,this.decorations,e.changes);a.length&&(i=je.extendWithRanges(i,a));let h=Ep(l,this.blockWrappers,e.changes);return h.length&&(i=je.extendWithRanges(i,h)),r&&!i.some(c=>c.fromA<=r.range.fromA&&c.toA>=r.range.toA)&&(i=r.range.addToSet(i.slice())),this.tile.flags&2&&i.length==0?!1:(this.updateInner(i,r),e.transactions.length&&(this.lastUpdate=Date.now()),!0)}updateInner(e,t){this.view.viewState.mustMeasureContent=!0;let{observer:i}=this.view;i.ignore(()=>{if(t||e.length){let o=this.tile,l=new ho(this.view,o,this.blockWrappers,this.decorations,this.dynamicDecorationMap);t&&J.get(t.text)&&l.cache.reused.set(J.get(t.text),2),this.tile=l.run(e,t),co(o,l.cache.reused)}this.tile.dom.style.height=this.view.viewState.contentHeight/this.view.scaleY+"px",this.tile.dom.style.flexBasis=this.minWidth?this.minWidth+"px":"";let r=M.chrome||M.ios?{node:i.selectionRange.focusNode,written:!1}:void 0;this.tile.sync(r),r&&(r.written||i.selectionRange.focusNode!=r.node||!this.tile.dom.contains(r.node))&&(this.forceSelection=!0),this.tile.dom.style.height=""});let s=[];if(this.view.viewport.from||this.view.viewport.to<this.view.state.doc.length)for(let r of this.tile.children)r.isWidget()&&r.widget instanceof $i&&s.push(r.dom);i.updateGaps(s)}updateEditContextFormatting(e){this.editContextFormatting=this.editContextFormatting.map(e.changes);for(let t of e.transactions)for(let i of t.effects)i.is(Cc)&&(this.editContextFormatting=i.value)}updateSelection(e=!1,t=!1){(e||!this.view.observer.selectionRange.focusNode)&&this.view.observer.readSelectionRange();let{dom:i}=this.tile,s=this.view.root.activeElement,r=s==i,o=!r&&!(this.view.state.facet(ht)||i.tabIndex>-1)&&Wi(i,this.view.observer.selectionRange)&&!(s&&i.contains(s));if(!(r||t||o))return;let l=this.forceSelection;this.forceSelection=!1;let a=this.view.state.selection.main,h,c;if(a.empty?c=h=this.inlineDOMNearPos(a.anchor,a.assoc||1):(c=this.inlineDOMNearPos(a.head,a.head==a.from?1:-1),h=this.inlineDOMNearPos(a.anchor,a.anchor==a.from?1:-1)),M.gecko&&a.empty&&!this.hasComposition&&Tp(h)){let u=document.createTextNode("");this.view.observer.ignore(()=>h.node.insertBefore(u,h.node.childNodes[h.offset]||null)),h=c=new Ze(u,0),l=!0}let f=this.view.observer.selectionRange;(l||!f.focusNode||(!zi(h.node,h.offset,f.anchorNode,f.anchorOffset)||!zi(c.node,c.offset,f.focusNode,f.focusOffset))&&!this.suppressWidgetCursorChange(f,a))&&(this.view.observer.ignore(()=>{M.android&&M.chrome&&i.contains(f.focusNode)&&Rp(f.focusNode,i)&&(i.blur(),i.focus({preventScroll:!0}));let u=Ji(this.view.root);if(u)if(a.empty){if(M.gecko){let d=Op(h.node,h.offset);if(d&&d!=3){let p=(d==1?ac:hc)(h.node,h.offset);p&&(h=new Ze(p.node,p.offset))}}u.collapse(h.node,h.offset),a.bidiLevel!=null&&u.caretBidiLevel!==void 0&&(u.caretBidiLevel=a.bidiLevel)}else if(u.extend){u.collapse(h.node,h.offset);try{u.extend(c.node,c.offset)}catch{}}else{let d=document.createRange();a.anchor>a.head&&([h,c]=[c,h]),d.setEnd(c.node,c.offset),d.setStart(h.node,h.offset),u.removeAllRanges(),u.addRange(d)}o&&this.view.root.activeElement==i&&(i.blur(),s&&s.focus())}),this.view.observer.setSelectionRange(h,c)),this.impreciseAnchor=h.precise?null:new Ze(f.anchorNode,f.anchorOffset),this.impreciseHead=c.precise?null:new Ze(f.focusNode,f.focusOffset)}suppressWidgetCursorChange(e,t){return this.hasComposition&&t.empty&&zi(e.focusNode,e.focusOffset,e.anchorNode,e.anchorOffset)&&this.posFromDOM(e.focusNode,e.focusOffset)==t.head}enforceCursorAssoc(){if(this.hasComposition)return;let{view:e}=this,t=e.state.selection.main,i=Ji(e.root),{anchorNode:s,anchorOffset:r}=e.observer.selectionRange;if(!i||!t.empty||!t.assoc||!i.modify)return;let o=this.lineAt(t.head,t.assoc);if(!o)return;let l=o.posAtStart;if(t.head==l||t.head==l+o.length)return;let a=this.coordsAt(t.head,-1),h=this.coordsAt(t.head,1);if(!a||!h||a.bottom>h.top)return;let c=this.domAtPos(t.head+t.assoc,t.assoc);i.collapse(c.node,c.offset),i.modify("move",t.assoc<0?"forward":"backward","lineboundary"),e.observer.readSelectionRange();let f=e.observer.selectionRange;e.docView.posFromDOM(f.anchorNode,f.anchorOffset)!=t.from&&i.collapse(s,r)}posFromDOM(e,t){let i=this.tile.nearest(e);if(!i)return this.tile.dom.compareDocumentPosition(e)&2?0:this.view.state.doc.length;let s=i.posAtStart;if(i.isComposite()){let r;if(e==i.dom)r=i.dom.childNodes[t];else{let o=ft(e)==0?0:t==0?-1:1;for(;;){let l=e.parentNode;if(l==i.dom)break;o==0&&l.firstChild!=l.lastChild&&(e==l.firstChild?o=-1:o=1),e=l}o<0?r=e:r=e.nextSibling}if(r==i.dom.firstChild)return s;for(;r&&!J.get(r);)r=r.nextSibling;if(!r)return s+i.length;for(let o=0,l=s;;o++){let a=i.children[o];if(a.dom==r)return l;l+=a.length+a.breakAfter}}else return i.isText()?e==i.dom?s+t:s+(t?i.length:0):s}domAtPos(e,t){let{tile:i,offset:s}=this.tile.resolveBlock(e,t);return i.isWidget()?i.domPosFor(s,t):i.domIn(s,t)}inlineDOMNearPos(e,t){let i,s=-1,r=!1,o,l=-1,a=!1;return this.tile.blockTiles((h,c)=>{if(h.isWidget()){if(h.flags&32&&c>=e)return!0;h.flags&16&&(r=!0)}else{let f=c+h.length;if(c<=e&&(i=h,s=e-c,r=f<e),f>=e&&!o&&(o=h,l=e-c,a=c>e),c>e&&o)return!0}}),!i&&!o?this.domAtPos(e,t):(r&&o?i=null:a&&i&&(o=null),i&&t<0||!o?i.domIn(s,t):o.domIn(l,t))}coordsAt(e,t,i){let{tile:s,offset:r}=this.tile.resolveBlock(e,t);return s.isWidget()?s.widget instanceof $i?null:s.coordsInWidget(r,t,!0):s.coordsIn(r,t,i)}lineAt(e,t){let{tile:i}=this.tile.resolveBlock(e,t);return i.isLine()?i:null}coordsForChar(e){let{tile:t,offset:i}=this.tile.resolveBlock(e,1);if(!t.isLine())return null;function s(r,o){if(r.isComposite())for(let l of r.children){if(l.length>=o){let a=s(l,o);if(a)return a}if(o-=l.length,o<0)break}else if(r.isText()&&o<r.length){let l=ee(r.text,o);if(l==o)return null;let a=Zi(r.dom,o,l).getClientRects();for(let h=0;h<a.length;h++){let c=a[h];if(h==a.length-1||c.top<c.bottom&&c.left<c.right)return c}}return null}return s(t,i)}measureVisibleLineHeights(e){let t=[],{from:i,to:s}=e,r=this.view.contentDOM.clientWidth,o=r>Math.max(this.view.scrollDOM.clientWidth,this.minWidth)+1,l=-1,a=this.view.textDirection==z.LTR,h=0,c=(f,u,d)=>{for(let p=0;p<f.children.length&&!(u>s);p++){let m=f.children[p],g=u+m.length,y=m.dom.getBoundingClientRect(),{height:v}=y;if(d&&!p&&(h+=y.top-d.top),m instanceof ct)g>i&&c(m,u,y);else if(u>=i&&(h>0&&t.push(-h),t.push(v+h),h=0,o)){let x=m.dom.lastChild,D=x?Vi(x):[];if(D.length){let w=D[D.length-1],k=a?w.right-y.left:y.right-w.left;k>l&&(l=k,this.minWidth=r,this.minWidthFrom=u,this.minWidthTo=g)}}d&&p==f.children.length-1&&(h+=d.bottom-y.bottom),u=g+m.breakAfter}};return c(this.tile,0,null),t}textDirectionAt(e){let{tile:t}=this.tile.resolveBlock(e,1);return getComputedStyle(t.dom).direction=="rtl"?z.RTL:z.LTR}measureTextSize(){let e=this.tile.blockTiles(o=>{if(o.isLine()&&o.children.length&&o.length<=20){let l=0,a;for(let h of o.children){if(!h.isText()||/[^ -~]/.test(h.text))return;let c=Vi(h.dom);if(c.length!=1)return;l+=c[0].width,a=c[0].height}if(l)return{lineHeight:o.dom.getBoundingClientRect().height,charWidth:l/o.length,textHeight:a}}});if(e)return e;let t=document.createElement("div"),i,s,r;return t.className="cm-line",t.style.width="99999px",t.style.position="absolute",t.textContent="abc def ghi jkl mno pqr stu",this.view.observer.ignore(()=>{this.tile.dom.appendChild(t);let o=Vi(t.firstChild)[0];i=t.getBoundingClientRect().height,s=o&&o.width?o.width/27:7,r=o&&o.height?o.height:i,t.remove()}),{lineHeight:i,charWidth:s,textHeight:r}}computeBlockGapDeco(){let e=[],t=this.view.viewState;for(let i=0,s=0;;s++){let r=s==t.viewports.length?null:t.viewports[s],o=r?r.from-1:this.view.state.doc.length;if(o>i){let l=(t.lineBlockAt(o).bottom-t.lineBlockAt(i).top)/this.view.scaleY;e.push(B.replace({widget:new $i(l),block:!0,inclusive:!0,isBlockGap:!0}).range(i,o))}if(!r)break;i=r.to+1}return B.set(e)}updateDeco(){let e=1,t=this.view.state.facet(bs).map(r=>(this.dynamicDecorationMap[e++]=typeof r=="function")?r(this.view):r),i=!1,s=this.view.state.facet(Qo).map((r,o)=>{let l=typeof r=="function";return l&&(i=!0),l?r(this.view):r});for(s.length&&(this.dynamicDecorationMap[e++]=i,t.push(H.join(s))),this.decorations=[this.editContextFormatting,...t,this.computeBlockGapDeco(),this.view.viewState.lineGapDeco];e<this.decorations.length;)this.dynamicDecorationMap[e++]=!1;this.blockWrappers=this.view.state.facet(Mc).map(r=>typeof r=="function"?r(this.view):r)}scrollIntoView(e){if(e.isSnapshot){let h=this.view.viewState.lineBlockAt(e.range.head);this.view.scrollDOM.scrollTop=h.top-e.yMargin,this.view.scrollDOM.scrollLeft=e.xMargin;return}for(let h of this.view.state.facet(Sc))try{if(h(this.view,e.range,e))return!0}catch(c){ce(this.view.state,c,"scroll handler")}let{range:t}=e,i=this.coordsAt(t.head,t.assoc||(t.head>t.anchor?-1:1)),s;if(!i)return;!t.empty&&(s=this.coordsAt(t.anchor,t.anchor>t.head?-1:1))&&(i={left:Math.min(i.left,s.left),top:Math.min(i.top,s.top),right:Math.max(i.right,s.right),bottom:Math.max(i.bottom,s.bottom)});let r=Zo(this.view),o={left:i.left-r.left,top:i.top-r.top,right:i.right+r.right,bottom:i.bottom+r.bottom},{offsetWidth:l,offsetHeight:a}=this.view.scrollDOM;if(ap(this.view.scrollDOM,o,t.head<t.anchor?-1:1,e.x,e.y,Math.max(Math.min(e.xMargin,l),-l),Math.max(Math.min(e.yMargin,a),-a),this.view.textDirection==z.LTR),window.visualViewport&&window.innerHeight-window.visualViewport.height>1&&(i.top>window.visualViewport.offsetTop+window.visualViewport.height||i.bottom<window.visualViewport.offsetTop)){let h=this.view.docView.lineAt(t.head,1);if(h){let c=sc(h.dom);h.dom.scrollIntoView({block:"nearest"}),rc(c,!1)}}}lineHasWidget(e){let t=i=>i.isWidget()||i.children.some(t);return t(this.tile.resolveBlock(e,1).tile)}destroy(){co(this.tile)}};function co(n,e){let t=e?.get(n);if(t!=1){t==null&&n.destroy();for(let i of n.children)co(i,e)}}function Tp(n){return se(n.node)&&n.node.firstChild&&(n.offset==0||n.node.childNodes[n.offset-1].contentEditable=="false")&&(n.offset==n.node.childNodes.length||n.node.childNodes[n.offset].contentEditable=="false")}function Lc(n,e){let t=n.observer.selectionRange;if(!t.focusNode)return null;let i=ac(t.focusNode,t.focusOffset),s=hc(t.focusNode,t.focusOffset),r=i||s;if(s&&i&&s.node!=i.node){let l=J.get(s.node);if(!l||l.isText()&&l.text!=s.node.nodeValue)r=s;else if(n.docView.lastCompositionAfterCursor){let a=J.get(i.node);!a||a.isText()&&a.text!=i.node.nodeValue||(r=s)}}if(n.docView.lastCompositionAfterCursor=r!=i,!r)return null;let o=e-r.offset;return{from:o,to:o+r.node.nodeValue.length,node:r.node}}function Dp(n,e,t){let i=Lc(n,t);if(!i)return null;let{node:s,from:r,to:o}=i,l=s.nodeValue;if(/[\n\r]/.test(l)||n.state.doc.sliceString(i.from,i.to)!=l)return null;let a=e.invertedDesc;return{range:new je(a.mapPos(r),a.mapPos(o),r,o),text:s}}function Op(n,e){return se(n)?(e&&n.childNodes[e-1].contentEditable=="false"?1:0)|(e<n.childNodes.length&&n.childNodes[e].contentEditable=="false"?2:0):0}var Bp=class{constructor(){this.changes=[]}compareRange(e,t){ci(e,t,this.changes)}comparePoint(e,t){ci(e,t,this.changes)}boundChange(e){ci(e,e,this.changes)}};function Lp(n,e,t){let i=new Bp;return H.compare(n,e,t,i),i.changes}var fo=class{constructor(){this.changes=[]}compareRange(e,t){ci(e,t,this.changes)}comparePoint(){}boundChange(e){ci(e,e,this.changes)}};function Ep(n,e,t){let i=new fo;return H.compare(n,e,t,i),i.changes}function Rp(n,e){for(let t=n;t&&t!=e;t=t.assignedSlot||t.parentNode)if(se(t)&&t.contentEditable=="false")return!0;return!1}function Pp(n,e){let t=!1;return e&&n.iterChangedRanges((i,s)=>{i<e.to&&s>e.from&&(t=!0)}),t}var $i=class extends re{constructor(e){super(),this.height=e}toDOM(){let e=document.createElement("div");return e.className="cm-gap",this.updateDOM(e),e}eq(e){return e.height==this.height}updateDOM(e){return e.style.height=this.height+"px",!0}get editable(){return!0}get estimatedHeight(){return this.height}ignoreEvent(){return!1}};function Ip(n,e,t=1){let i=n.charCategorizer(e),s=n.doc.lineAt(e),r=e-s.from;if(s.length==0)return b.cursor(e);r==0?t=1:r==s.length&&(t=-1);let o=r,l=r;t<0?o=ee(s.text,r,!1):l=ee(s.text,r);let a=i(s.text.slice(o,l));for(;o>0;){let h=ee(s.text,o,!1);if(i(s.text.slice(h,o))!=a)break;o=h}for(;l<s.length;){let h=ee(s.text,l);if(i(s.text.slice(l,h))!=a)break;l=h}return b.undirectionalRange(o+s.from,l+s.from)}function Np(n,e,t,i,s){let r=Math.round((i-e.left)*n.defaultCharacterWidth);if(n.lineWrapping&&t.height>n.defaultLineHeight*1.5){let l=n.viewState.heightOracle.textHeight,a=Math.floor((s-t.top-(n.defaultLineHeight-l)*.5)/l);r+=a*n.viewState.heightOracle.lineLength}let o=n.state.sliceDoc(t.from,t.to);return t.from+Fn(o,r,n.state.tabSize)}function uo(n,e,t){let i=n.lineBlockAt(e);if(Array.isArray(i.type)){let s;for(let r of i.type){if(r.from>e)break;if(!(r.to<e)){if(r.from<e&&r.to>e)return r;(!s||r.type==fe.Text&&(s.type!=r.type||(t<0?r.from<e:r.to>e)))&&(s=r)}}return s||i}return i}function Fp(n,e,t,i){let s=uo(n,e.head,e.assoc||-1),r=!i||s.type!=fe.Text||!(n.lineWrapping||s.widgetLineBreaks)?null:n.coordsAtPos(e.assoc<0&&e.head>s.from?e.head-1:e.head);if(r){let o=n.dom.getBoundingClientRect(),l=n.textDirectionAt(s.from),a=n.posAndSideAtCoords({x:t==(l==z.LTR)?o.right-1:o.left+1,y:(r.top+r.bottom)/2});if(a)return b.cursor(a.pos,a.assoc)}return b.cursor(t?s.to:s.from,t?1:-1)}function Ah(n,e,t,i){let s=n.state.doc.lineAt(e.head),r=n.bidiSpans(s),o=n.textDirectionAt(s.from);for(let l=e,a=null;;){let h=bp(s,r,o,l,t),c=pc;if(!h){if(s.number==(t?n.state.doc.lines:1))return l;c=`
`,s=n.state.doc.line(s.number+(t?1:-1)),r=n.bidiSpans(s),h=t?b.cursor(s.from,-1):b.cursor(s.to,1)}if(a){if(!a(c))return l}else{if(!i)return h;a=i(c)}l=h}}function Hp(n,e,t){let i=n.state.charCategorizer(e),s=i(t);return r=>{let o=i(r);return s==$.Space&&(s=o),s==o}}function Wp(n,e,t,i){let s=e.head,r=t?1:-1;if(s==(t?n.state.doc.length:0))return b.cursor(s,e.assoc);let o=e.goalColumn,l,a=n.contentDOM.getBoundingClientRect(),h=n.coordsAtPos(s,e.assoc||((e.empty?t:e.head==e.from)?1:-1)),c=n.documentTop;if(h)o==null&&(o=h.left-a.left),l=r<0?h.top:h.bottom;else{let p=n.viewState.lineBlockAt(s);o==null&&(o=Math.min(a.right-a.left,n.defaultCharacterWidth*(s-p.from))),l=(r<0?p.top:p.bottom)+c}let f=a.left+o,u=n.viewState.heightOracle.textHeight>>1,d=i??u;for(let p=0;;p+=u){let m=l+(d+p)*r,g=po(n,{x:f,y:m},!1,r);if(t?m>a.bottom:m<a.top)return b.cursor(g.pos,g.assoc);let y=n.coordsAtPos(g.pos,g.assoc),v=y?(y.top+y.bottom)/2:0;if(!y||(t?v>l:v<l))return b.cursor(g.pos,g.assoc,void 0,o)}}function ji(n,e,t){for(;;){let i=0;for(let s of n)s.between(e-1,e+1,(r,o,l)=>{if(e>r&&e<o){let a=i||t||(e-r<o-e?-1:1);e=a<0?r:o,i=a}});if(!i)return e}}function Ec(n,e){let t=null;for(let i=0;i<e.ranges.length;i++){let s=e.ranges[i],r=null;if(s.empty){let o=ji(n,s.from,0);o!=s.from&&(r=b.cursor(o,-1))}else{let o=ji(n,s.from,-1),l=ji(n,s.to,1);(o!=s.from||l!=s.to)&&(s.undirectional?r=b.undirectionalRange(s.from,s.to):r=b.range(s.from==s.anchor?o:l,s.from==s.head?o:l))}r&&(t||(t=e.ranges.slice()),t[i]=r)}return t?b.create(t,e.mainIndex):e}function Kr(n,e,t){let i=ji(n.state.facet(en).map(s=>s(n)),t.from,e.head>t.from?-1:1);return i==t.from?t:b.cursor(i,i<t.from?1:-1)}var We=class{constructor(e,t){this.pos=e,this.assoc=t}};function po(n,e,t,i){let s=n.contentDOM.getBoundingClientRect(),r=s.top+n.viewState.paddingTop,{x:o,y:l}=e,a=l-r,h;for(;;){if(a<0)return new We(0,1);if(a>n.viewState.docHeight)return new We(n.state.doc.length,-1);if(h=n.elementAtHeight(a),i==null)break;if(h.type==fe.Text){if(i<0?h.to<n.viewport.from:h.from>n.viewport.to)break;let u=n.docView.coordsAt(i<0?h.from:h.to,i>0?-1:1);if(u&&(i<0?u.top<=a+r:u.bottom>=a+r))break}let f=n.viewState.heightOracle.textHeight/2;a=i>0?h.bottom+f:h.top-f}if(n.viewport.from>=h.to||n.viewport.to<=h.from){if(t)return null;if(h.type==fe.Text){let f=Np(n,s,h,o,l);return new We(f,f==h.from?1:-1)}}if(h.type!=fe.Text)return a<(h.top+h.bottom)/2?new We(h.from,1):new We(h.to,-1);let c=n.docView.lineAt(h.from,2);return(!c||c.length!=h.length)&&(c=n.docView.lineAt(h.from,-2)),new mo(n,o,l,n.textDirectionAt(h.from)).scanTile(c,h.from)}var mo=class{constructor(e,t,i,s){this.view=e,this.x=t,this.y=i,this.baseDir=s,this.line=null,this.spans=null}bidiSpansAt(e){return(!this.line||this.line.from>e||this.line.to<e)&&(this.line=this.view.state.doc.lineAt(e),this.spans=this.view.bidiSpans(this.line)),this}baseDirAt(e,t){let{line:i,spans:s}=this.bidiSpansAt(e);return s[Ve.find(s,e-i.from,-1,t)].level==this.baseDir}dirAt(e,t){let{line:i,spans:s}=this.bidiSpansAt(e);return s[Ve.find(s,e-i.from,-1,t)].dir}bidiIn(e,t){let{spans:i,line:s}=this.bidiSpansAt(e);return i.length>1||i.length&&(i[0].level!=this.baseDir||i[0].to+s.from<t)}scan(e,t,i=!1){let s=0,r=e.length-1,o=new Set,l=this.bidiIn(e[0],e[r]),a,h,c=-1,f=1e9,u;e:for(;s<r;){let p=r-s,m=s+r>>1;t:if(o.has(m)){for(let v=1;v<p;v++){let x=m+v;if(x>=r&&(x-=p),!o.has(x)){m=x;break t}}break e}o.add(m);let g=t(m),y=0;if(g)for(let v=0;v<g.length;v++){let x=g[v];if(!(x.width==0&&g.length>1))if(x.bottom<this.y)(!a||a.bottom<x.bottom)&&(a=x),y=1;else if(x.top>this.y)(!h||h.top>x.top)&&(h=x),y=-1;else{let D=x.left>this.x?this.x-x.left:x.right<this.x?this.x-x.right:0,w=Math.abs(D);w<f&&(c=m,f=w,u=x),D&&(y=D<0==(this.baseDir==z.LTR)?-1:1)}}y==-1&&(!l||this.baseDirAt(e[m],1))?r=m:y==1&&(!l||this.baseDirAt(e[m+1],-1))&&(s=m+1)}if(!u){if(!h&&!a)return{i:0,after:!1};let p=a&&(!h||this.y-a.bottom<h.top-this.y)?a:h;return this.y=(p.top+p.bottom)/2,this.scan(e,t,!0)}if(f&&!i){let{top:p,bottom:m}=u;if(a&&a.bottom>(p+p+m)/3)return this.y=a.bottom-1,this.scan(e,t,!0);if(h&&h.top<(p+m+m)/3)return this.y=h.top+1,this.scan(e,t,!0)}let d=(l?this.dirAt(e[c],1):this.baseDir)==z.LTR;return{i:c,after:this.x>(u.left+u.right)/2==d}}scanText(e,t){let i=[];for(let r=0;r<e.length;r=ee(e.text,r))i.push(t+r);i.push(t+e.length);let s=this.scan(i,r=>{let o=i[r]-t,l=i[r+1]-t;return Zi(e.dom,o,l).getClientRects()});return s.after?new We(i[s.i+1],-1):new We(i[s.i],1)}scanTile(e,t){if(!e.length)return new We(t,1);if(e.children.length==1){let l=e.children[0];if(l.isText())return this.scanText(l,t);if(l.isComposite())return this.scanTile(l,t)}let i=[t];for(let l=0,a=t;l<e.children.length;l++)i.push(a+=e.children[l].length);let s=this.scan(i,l=>{let a=e.children[l];return a.flags&48?null:(se(a.dom)?a.dom:Zi(a.dom,0,a.length)).getClientRects()}),r=e.children[s.i],o=i[s.i];return r.isText()?this.scanText(r,o):r.isComposite()?this.scanTile(r,o):s.after?new We(i[s.i+1],-1):new We(o,1)}},ri="\uFFFF",go=class{constructor(e,t){this.points=e,this.view=t,this.text="",this.lineSeparator=t.state.facet(U.lineSeparator)}append(e){this.text+=e}lineBreak(){this.text+=ri}readRange(e,t){if(!e)return this;let i=e.parentNode;for(let s=e;;){this.findPointBefore(i,s);let r=this.text.length;this.readNode(s);let o=J.get(s),l=s.nextSibling;if(l==t){o?.breakAfter&&!l&&i!=this.view.contentDOM&&this.lineBreak();break}let a=J.get(l);(o&&a?o.breakAfter:(o?o.breakAfter:ts(s))||ts(l)&&(s.nodeName!="BR"||o?.isWidget())&&this.text.length>r)&&!zp(l,t)&&this.lineBreak(),s=l}return this.findPointBefore(i,t),this}readTextNode(e){let t=e.nodeValue;for(let i of this.points)i.node==e&&(i.pos=this.text.length+Math.min(i.offset,t.length));for(let i=0,s=this.lineSeparator?null:/\r\n?|\n/g;;){let r=-1,o=1,l;if(this.lineSeparator?(r=t.indexOf(this.lineSeparator,i),o=this.lineSeparator.length):(l=s.exec(t))&&(r=l.index,o=l[0].length),this.append(t.slice(i,r<0?t.length:r)),r<0)break;if(this.lineBreak(),o>1)for(let a of this.points)a.node==e&&a.pos>this.text.length&&(a.pos-=o-1);i=r+o}}readNode(e){let t=J.get(e),i=t&&t.overrideDOMText;if(i!=null){this.findPointInside(e,i.length);for(let s=i.iter();!s.next().done;)s.lineBreak?this.lineBreak():this.append(s.value)}else ui(e)?this.readTextNode(e):e.nodeName=="BR"?e.nextSibling&&this.lineBreak():se(e)&&this.readRange(e.firstChild,null)}findPointBefore(e,t){for(let i of this.points)i.node==e&&e.childNodes[i.offset]==t&&(i.pos=this.text.length)}findPointInside(e,t){for(let i of this.points)(ui(e)?i.node==e:e.contains(i.node))&&(i.pos=this.text.length+(Vp(e,i.node,i.offset)?t:0))}};function Vp(n,e,t){for(;;){if(!e||t<ft(e))return!1;if(e==n)return!0;t=gt(e)+1,e=e.parentNode}}function zp(n,e){let t;for(;!(n==e||!n);n=n.nextSibling){let i=J.get(n);if(!i?.isWidget())return!1;i&&(t||(t=[])).push(i)}if(t)for(let i of t){let s=i.overrideDOMText;if(s?.length)return!1}return!0}var rs=class{constructor(e,t){this.node=e,this.offset=t,this.pos=-1}},yo=class{constructor(e,t,i,s){this.typeOver=s,this.bounds=null,this.text="",this.domChanged=t>-1;let{impreciseHead:r,impreciseAnchor:o}=e.docView,l=e.state.selection;if(e.state.readOnly&&t>-1)this.newSel=null;else if(t>-1&&(this.bounds=Rc(e.docView.tile,t,i,0))){let a=r||o?[]:Kp(e),h=new go(a,e);h.readRange(this.bounds.startDOM,this.bounds.endDOM),this.text=h.text,this.newSel=$p(a,this.bounds.from)}else{let a=e.observer.selectionRange,h=r&&r.node==a.focusNode&&r.offset==a.focusOffset||!Qr(e.contentDOM,a.focusNode)?l.main.head:e.docView.posFromDOM(a.focusNode,a.focusOffset),c=o&&o.node==a.anchorNode&&o.offset==a.anchorOffset||!Qr(e.contentDOM,a.anchorNode)?l.main.anchor:e.docView.posFromDOM(a.anchorNode,a.anchorOffset),f=e.viewport;if((M.ios||M.chrome)&&h!=c&&Math.min(h,c)<=l.main.from&&Math.max(h,c)>=l.main.to&&(f.from>0||f.to<e.state.doc.length)){let u=Math.min(h,c),d=Math.max(h,c),p=f.from-u,m=f.to-d;(p==0||p==1||u==0)&&(m==0||m==-1||d==e.state.doc.length)&&(h=0,c=e.state.doc.length)}if(e.inputState.composing>-1&&l.ranges.length>1)this.newSel=l.replaceRange(b.range(c,h));else if(e.lineWrapping&&c==h&&!(l.main.empty&&l.main.head==h)&&e.inputState.lastTouchTime>Date.now()-100){let u=e.coordsAtPos(h,-1),d=0;u&&(d=e.inputState.lastTouchY<=u.bottom?-1:1),this.newSel=b.create([b.cursor(h,d)])}else this.newSel=b.single(c,h)}}};function Rc(n,e,t,i){if(n.isComposite()){let s=-1,r=-1,o=-1,l=-1;for(let a=0,h=i,c=i;a<n.children.length;a++){let f=n.children[a],u=h+f.length;if(h<e&&u>t)return Rc(f,e,t,h);if(u>=e&&s==-1&&(s=a,r=h),h>t&&f.dom.parentNode==n.dom){o=a,l=c;break}c=u,h=u+f.breakAfter}return{from:r,to:l<0?i+n.length:l,startDOM:(s?n.children[s-1].dom.nextSibling:null)||n.dom.firstChild,endDOM:o<n.children.length&&o>=0?n.children[o].dom:null}}else return n.isText()?{from:i,to:i+n.length,startDOM:n.dom,endDOM:n.dom.nextSibling}:null}function Pc(n,e){let t,{newSel:i}=e,{state:s}=n,r=s.selection.main,o=n.inputState.lastKeyTime>Date.now()-100?n.inputState.lastKeyCode:-1;if(e.bounds){let{from:l,to:a}=e.bounds,h=r.from,c=null;(o===8||M.android&&e.text.length<a-l)&&(h=r.to,c="end");let f=s.doc.sliceString(l,a,ri),u,d;!r.empty&&r.from>=l&&r.to<=a&&(e.typeOver||f!=e.text)&&f.slice(0,r.from-l)==e.text.slice(0,r.from-l)&&f.slice(r.to-l)==e.text.slice(u=e.text.length-(f.length-(r.to-l)))?t={from:r.from,to:r.to,insert:N.of(e.text.slice(r.from-l,u).split(ri))}:(d=Ic(f,e.text,h-l,c))&&(M.chrome&&o==13&&d.toB==d.from+2&&e.text.slice(d.from,d.toB)==ri+ri&&d.toB--,t={from:l+d.from,to:l+d.toA,insert:N.of(e.text.slice(d.from,d.toB).split(ri))})}else i&&(!n.hasFocus&&s.facet(ht)||bo(i,r))&&(i=null);if(!t&&!i)return!1;if((M.mac||M.android)&&t&&t.from==t.to&&t.from==r.head-1&&/^\. ?$/.test(t.insert.toString())&&n.contentDOM.getAttribute("autocorrect")=="off"?(i&&t.insert.length==2&&(i=b.single(i.main.anchor-1,i.main.head-1)),t={from:t.from,to:t.to,insert:N.of([t.insert.toString().replace("."," ")])}):s.doc.lineAt(r.from).to<r.to&&n.docView.lineHasWidget(r.to)&&n.inputState.insertingTextAt>Date.now()-50?t={from:r.from,to:r.to,insert:s.toText(n.inputState.insertingText)}:M.chrome&&t&&t.from==t.to&&t.from==r.head&&t.insert.toString()==`
 `&&n.lineWrapping&&(i&&(i=b.single(i.main.anchor-1,i.main.head-1)),t={from:r.from,to:r.to,insert:N.of([" "])}),t)return el(n,t,i,o);if(i&&!bo(i,r)){let l=!1,a="select";return n.inputState.lastSelectionTime>Date.now()-50&&(n.inputState.lastSelectionOrigin=="select"&&(l=!0),a=n.inputState.lastSelectionOrigin,a=="select.pointer"&&(i=Ec(s.facet(en).map(h=>h(n)),i))),n.dispatch({selection:i,scrollIntoView:l,userEvent:a}),!0}else return!1}function el(n,e,t,i=-1){if(M.ios&&n.inputState.flushIOSKey(e))return!0;let s=n.state.selection.main;if(M.android&&(e.to==s.to&&(e.from==s.from||e.from==s.from-1&&n.state.sliceDoc(e.from,s.from)==" ")&&e.insert.length==1&&e.insert.lines==2&&fi(n.contentDOM,"Enter",13)||(e.from==s.from-1&&e.to==s.to&&e.insert.length==0||i==8&&e.insert.length<e.to-e.from&&e.to>s.head)&&fi(n.contentDOM,"Backspace",8)||e.from==s.from&&e.to==s.to+1&&e.insert.length==0&&fi(n.contentDOM,"Delete",46)))return!0;let r=e.insert.toString();n.inputState.composing>=0&&n.inputState.composing++;let o,l=()=>o||(o=qp(n,e,t));return n.state.facet(xc).some(a=>a(n,e.from,e.to,r,l))||n.dispatch(l()),!0}function qp(n,e,t){let i,s=n.state,r=s.selection.main,o=-1;if(e.from==e.to&&e.from<r.from||e.from>r.to){let a=e.from<r.from?-1:1,h=a<0?r.from:r.to,c=ji(s.facet(en).map(f=>f(n)),h,a);e.from==c&&(o=c)}if(o>-1)i={changes:e,selection:b.cursor(e.from+e.insert.length,-1)};else if(e.from>=r.from&&e.to<=r.to&&e.to-e.from>=(r.to-r.from)/3&&(!t||t.main.empty&&t.main.from==e.from+e.insert.length)&&n.inputState.composing<0){let a=r.from<e.from?s.sliceDoc(r.from,e.from):"",h=r.to>e.to?s.sliceDoc(e.to,r.to):"";i=s.replaceSelection(n.state.toText(a+e.insert.sliceString(0,void 0,n.state.lineBreak)+h))}else{let a=s.changes(e),h=t&&t.main.to<=a.newLength?t.main:void 0;if(s.selection.ranges.length>1&&(n.inputState.composing>=0||n.inputState.compositionPendingChange)&&e.to<=r.to+10&&e.to>=r.to-10){let c=n.state.sliceDoc(e.from,e.to),f,u=t&&Lc(n,t.main.head);if(u){let p=e.insert.length-(e.to-e.from);f={from:u.from,to:u.to-p}}else f=n.state.doc.lineAt(r.head);let d=r.to-e.to;i=s.changeByRange(p=>{if(p.from==r.from&&p.to==r.to)return{changes:a,range:h||p.map(a)};let m=p.to-d,g=m-c.length;if(n.state.sliceDoc(g,m)!=c||m>=f.from&&g<=f.to)return{range:p};let y=s.changes({from:g,to:m,insert:e.insert}),v=p.to-r.to;return{changes:y,range:h?b.range(Math.max(0,h.anchor+v),Math.max(0,h.head+v)):p.map(y)}})}else i={changes:a,selection:h&&s.selection.replaceRange(h)}}let l="input.type";return(n.composing||n.inputState.compositionPendingChange&&n.inputState.compositionEndedAt>Date.now()-50)&&(n.inputState.compositionPendingChange=!1,l+=".compose",n.inputState.compositionFirstChange&&(l+=".start",n.inputState.compositionFirstChange=!1)),s.update(i,{userEvent:l,scrollIntoView:!0})}function Ic(n,e,t,i){let s=Math.min(n.length,e.length),r=0;for(;r<s&&n.charCodeAt(r)==e.charCodeAt(r);)r++;if(r==s&&n.length==e.length)return null;let o=n.length,l=e.length;for(;o>0&&l>0&&n.charCodeAt(o-1)==e.charCodeAt(l-1);)o--,l--;if(i=="end"){let a=Math.max(0,r-Math.min(o,l));t-=o+a-r}if(o<r&&n.length<e.length){let a=t<=r&&t>=o?r-t:0;r-=a,l=r+(l-o),o=r}else if(l<r){let a=t<=r&&t>=l?r-t:0;r-=a,o=r+(o-l),l=r}return{from:r,toA:o,toB:l}}function Kp(n){let e=[];if(n.root.activeElement!=n.contentDOM)return e;let{anchorNode:t,anchorOffset:i,focusNode:s,focusOffset:r}=n.observer.selectionRange;return t&&(e.push(new rs(t,i)),(s!=t||r!=i)&&e.push(new rs(s,r))),e}function $p(n,e){if(n.length==0)return null;let t=n[0].pos,i=n.length==2?n[1].pos:t;return t<0||i<0?null:t==i?b.create([b.cursor(i+e,-1)]):b.single(t+e,i+e)}function bo(n,e){return e.head==n.main.head&&e.anchor==n.main.anchor}var xo=class{setSelectionOrigin(e){this.lastSelectionOrigin=e,this.lastSelectionTime=Date.now()}constructor(e){this.view=e,this.lastKeyCode=0,this.lastKeyTime=0,this.touchActive=!1,this.lastTouchTime=0,this.lastTouchX=0,this.lastTouchY=0,this.lastFocusTime=0,this.lastScrollTop=0,this.lastScrollLeft=0,this.lastWheelEvent=0,this.pendingIOSKey=void 0,this.lastIOSMomentumScroll=0,this.tabFocusMode=-1,this.lastSelectionOrigin=null,this.lastSelectionTime=0,this.lastContextMenu=0,this.scrollHandlers=[],this.handlers=Object.create(null),this.composing=-1,this.compositionFirstChange=null,this.compositionEndedAt=0,this.compositionPendingKey=!1,this.compositionPendingChange=!1,this.insertingText="",this.insertingTextAt=0,this.mouseSelection=null,this.draggedContent=null,this.handleEvent=this.handleEvent.bind(this),this.notifiedFocused=e.hasFocus,M.safari&&e.contentDOM.addEventListener("input",()=>null),M.gecko&&rm(e.contentDOM.ownerDocument)}handleEvent(e){!Qp(this.view,e)||this.ignoreDuringComposition(e)||e.type=="keydown"&&this.keydown(e)||(this.view.updateState!=0?Promise.resolve().then(()=>this.runHandlers(e.type,e)):this.runHandlers(e.type,e))}runHandlers(e,t){let i=this.handlers[e];if(i){for(let s of i.observers)s(this.view,t);for(let s of i.handlers){if(t.defaultPrevented)break;if(s(this.view,t)){t.preventDefault();break}}}}ensureHandlers(e){let t=Up(e),i=this.handlers,s=this.view.contentDOM;for(let r in t)if(r!="scroll"){let o=!t[r].handlers.length,l=i[r];l&&o!=!l.handlers.length&&(s.removeEventListener(r,this.handleEvent),l=null),l||s.addEventListener(r,this.handleEvent,{passive:o})}for(let r in i)r!="scroll"&&!t[r]&&s.removeEventListener(r,this.handleEvent);this.handlers=t}keydown(e){if(this.lastKeyCode=e.keyCode,this.lastKeyTime=Date.now(),e.keyCode==9&&this.tabFocusMode>-1&&(!this.tabFocusMode||Date.now()<=this.tabFocusMode))return!0;if(this.tabFocusMode>0&&e.keyCode!=27&&Fc.indexOf(e.keyCode)<0&&(this.tabFocusMode=-1),M.android&&M.chrome&&!e.synthetic&&(e.keyCode==13||e.keyCode==8))return this.view.observer.delayAndroidKey(e.key,e.keyCode),!0;if(M.ios&&!e.synthetic&&!e.altKey&&!e.metaKey&&(Nc.some(t=>t.keyCode==e.keyCode)&&!e.ctrlKey||Gp.indexOf(e.key)>-1&&e.ctrlKey)){let t={ctrlKey:e.ctrlKey,altKey:e.altKey,metaKey:e.metaKey,shiftKey:e.shiftKey};t.shiftKey&&M.ios&&!/^(off|none)$/.test(this.view.contentDOM.autocapitalize)&&jp(this.view.win)&&(t.shiftKey=!1);let i=this.pendingIOSKey={key:e.key,keyCode:e.keyCode,mods:t};return setTimeout(()=>{this.pendingIOSKey==i&&this.flushIOSKey()},50),!0}return e.keyCode!=229&&this.view.observer.forceFlush(),!1}flushIOSKey(e){let t=this.pendingIOSKey;return!t||this.view.observer.pendingRecords().length||t.key=="Enter"&&e&&e.from<e.to&&/^\S+$/.test(e.insert.toString())?!1:(this.pendingIOSKey=void 0,fi(this.view.contentDOM,t.key,t.keyCode,t.mods))}ignoreDuringComposition(e){return!/^key/.test(e.type)||e.synthetic?!1:this.composing>0?!0:M.safari&&!M.ios&&this.compositionPendingKey&&Date.now()-this.compositionEndedAt<100?(this.compositionPendingKey=!1,!0):!1}startMouseSelection(e){this.mouseSelection&&this.mouseSelection.destroy(),this.mouseSelection=e}update(e){this.view.observer.update(e),this.mouseSelection&&this.mouseSelection.update(e),this.draggedContent&&e.docChanged&&(this.draggedContent=this.draggedContent.map(e.changes)),e.transactions.length&&(this.lastKeyCode=this.lastSelectionTime=0)}destroy(){this.mouseSelection&&this.mouseSelection.destroy()}};function jp(n){return n.visualViewport?n.visualViewport.height*n.visualViewport.scale/n.document.documentElement.clientHeight<.85:!1}function Mh(n,e){return(t,i)=>{try{return e.call(n,i,t)}catch(s){ce(t.state,s)}}}function Up(n){let e=Object.create(null);function t(i){return e[i]||(e[i]={observers:[],handlers:[]})}for(let i of n){let s=i.spec,r=s&&s.plugin.domEventHandlers,o=s&&s.plugin.domEventObservers;if(r)for(let l in r){let a=r[l];a&&t(l).handlers.push(Mh(i.value,a))}if(o)for(let l in o){let a=o[l];a&&t(l).observers.push(Mh(i.value,a))}}for(let i in Ue)t(i).handlers.push(Ue[i]);for(let i in ve)t(i).observers.push(ve[i]);return e}var Nc=[{key:"Backspace",keyCode:8,inputType:"deleteContentBackward"},{key:"Enter",keyCode:13,inputType:"insertParagraph"},{key:"Enter",keyCode:13,inputType:"insertLineBreak"},{key:"Delete",keyCode:46,inputType:"deleteContentForward"}],Gp="dthko",Fc=[16,17,18,20,91,92,224,225],Vn=6;function zn(n){return Math.max(0,n)*.7+8}function _p(n,e){return Math.max(Math.abs(n.clientX-e.clientX),Math.abs(n.clientY-e.clientY))}var wo=class{constructor(e,t,i,s){this.view=e,this.startEvent=t,this.style=i,this.mustSelect=s,this.scrollSpeed={x:0,y:0},this.scrolling=-1,this.lastEvent=t,this.scrollParents=nc(e.contentDOM),this.atoms=e.state.facet(en).map(o=>o(e));let r=e.contentDOM.ownerDocument;r.addEventListener("mousemove",this.move=this.move.bind(this)),r.addEventListener("mouseup",this.up=this.up.bind(this)),this.extend=t.shiftKey,this.multiple=e.state.facet(U.allowMultipleSelections)&&Yp(e,t),this.dragging=Jp(e,t)&&Vc(t)==1?null:!1}start(e){this.dragging===!1&&this.select(e)}move(e){if(e.buttons==0)return this.destroy();if(this.dragging||this.dragging==null&&_p(this.startEvent,e)<10)return;this.select(this.lastEvent=e);let t=0,i=0,s=0,r=0,o=this.view.win.innerWidth,l=this.view.win.innerHeight;this.scrollParents.x&&({left:s,right:o}=this.scrollParents.x.getBoundingClientRect()),this.scrollParents.y&&({top:r,bottom:l}=this.scrollParents.y.getBoundingClientRect());let a=Zo(this.view);e.clientX-a.left<=s+Vn?t=-zn(s-e.clientX):e.clientX+a.right>=o-Vn&&(t=zn(e.clientX-o)),e.clientY-a.top<=r+Vn?i=-zn(r-e.clientY):e.clientY+a.bottom>=l-Vn&&(i=zn(e.clientY-l)),this.setScrollSpeed(t,i)}up(e){this.dragging==null&&this.select(this.lastEvent),this.dragging||e.preventDefault(),this.destroy()}destroy(){this.setScrollSpeed(0,0);let e=this.view.contentDOM.ownerDocument;e.removeEventListener("mousemove",this.move),e.removeEventListener("mouseup",this.up),this.view.inputState.mouseSelection=this.view.inputState.draggedContent=null}setScrollSpeed(e,t){this.scrollSpeed={x:e,y:t},e||t?this.scrolling<0&&(this.scrolling=setInterval(()=>this.scroll(),50)):this.scrolling>-1&&(clearInterval(this.scrolling),this.scrolling=-1)}scroll(){let{x:e,y:t}=this.scrollSpeed;e&&this.scrollParents.x&&(this.scrollParents.x.scrollLeft+=e,e=0),t&&this.scrollParents.y&&(this.scrollParents.y.scrollTop+=t,t=0),(e||t)&&this.view.win.scrollBy(e,t),this.dragging===!1&&this.select(this.lastEvent)}select(e){let{view:t}=this,i=Ec(this.atoms,this.style.get(e,this.extend,this.multiple));(this.mustSelect||!i.eq(t.state.selection,this.dragging===!1))&&this.view.dispatch({selection:i,userEvent:"select.pointer"}),this.mustSelect=!1}update(e){e.transactions.some(t=>t.isUserEvent("input.type"))?this.destroy():this.style.update(e)&&setTimeout(()=>this.select(this.lastEvent),20)}};function Yp(n,e){let t=n.state.facet(mc);return t.length?t[0](e):M.mac?e.metaKey:e.ctrlKey}function Xp(n,e){let t=n.state.facet(gc);return t.length?t[0](e):M.mac?!e.altKey:!e.ctrlKey}function Jp(n,e){let{main:t}=n.state.selection;if(t.empty)return!1;let i=Ji(n.root);if(!i||i.rangeCount==0)return!0;let s=i.getRangeAt(0).getClientRects();for(let r=0;r<s.length;r++){let o=s[r];if(o.left<=e.clientX&&o.right>=e.clientX&&o.top<=e.clientY&&o.bottom>=e.clientY)return!0}return!1}function Qp(n,e){if(!e.bubbles)return!0;if(e.defaultPrevented)return!1;for(let t=e.target,i;t!=n.contentDOM;t=t.parentNode)if(!t||t.nodeType==11||(i=J.get(t))&&i.isWidget()&&!i.isHidden&&i.widget.ignoreEvent(e))return!1;return!0}var Ue=Object.create(null),ve=Object.create(null),Hc=M.ie&&M.ie_version<15||M.ios&&M.webkit_version<604;function Zp(n){let e=n.dom.parentNode;if(!e)return;let t=e.appendChild(document.createElement("textarea"));t.style.cssText="position: fixed; left: -10000px; top: 10px",t.focus(),setTimeout(()=>{n.focus(),t.remove(),Wc(n,t.value)},50)}function xs(n,e,t){for(let i of n.facet(e))t=i(t,n);return t}function Wc(n,e){e=xs(n.state,Xo,e);let{state:t}=n,i,s=1,r=t.toText(e),o=r.lines==t.selection.ranges.length;if(vo!=null&&t.selection.ranges.every(a=>a.empty)&&vo==r.toString()){let a=-1;i=t.changeByRange(h=>{let c=t.doc.lineAt(h.from);if(c.from==a)return{range:h};a=c.from;let f=t.toText((o?r.line(s++).text:e)+t.lineBreak);return{changes:{from:c.from,insert:f},range:b.cursor(h.from+f.length,-1)}})}else o?i=t.changeByRange(a=>{let h=r.line(s++);return{changes:{from:a.from,to:a.to,insert:h.text},range:b.cursor(a.from+h.length,-1)}}):i=t.replaceSelection(r);n.dispatch(i,{userEvent:"input.paste",scrollIntoView:!0})}ve.scroll=n=>{let e=n.inputState;e.lastScrollTop=n.scrollDOM.scrollTop,e.lastScrollLeft=n.scrollDOM.scrollLeft,M.ios&&!e.touchActive&&(e.lastIOSMomentumScroll=Date.now())};ve.wheel=ve.mousewheel=n=>{n.inputState.lastWheelEvent=Date.now()};Ue.keydown=(n,e)=>(n.inputState.setSelectionOrigin("select"),e.keyCode==27&&n.inputState.tabFocusMode!=0&&(n.inputState.tabFocusMode=Date.now()+2e3),!1);ve.touchstart=(n,e)=>{let t=n.inputState,i=e.targetTouches[0];t.touchActive=!0,t.lastTouchTime=Date.now(),i&&(t.lastTouchX=i.clientX,t.lastTouchY=i.clientY),t.setSelectionOrigin("select.pointer")};ve.touchmove=n=>{n.inputState.setSelectionOrigin("select.pointer")};ve.touchend=(n,e)=>{n.inputState.touchActive=!1};Ue.mousedown=(n,e)=>{if(n.observer.flush(),n.inputState.lastTouchTime>Date.now()-2e3)return!1;let t=null;for(let i of n.state.facet(yc))if(t=i(n,e),t)break;if(!t&&e.button==0&&(t=tm(n,e)),t){let i=!n.hasFocus;n.inputState.startMouseSelection(new wo(n,e,t,i)),i&&n.observer.ignore(()=>{oc(n.contentDOM);let r=n.root.activeElement;r&&!r.contains(n.contentDOM)&&r.blur()});let s=n.inputState.mouseSelection;if(s)return s.start(e),s.dragging===!1}else n.inputState.setSelectionOrigin("select.pointer");return!1};function Th(n,e,t,i){if(i==1)return b.cursor(e,t);if(i==2)return Ip(n.state,e,t);{let s=n.docView.lineAt(e,t),r=n.state.doc.lineAt(s?s.posAtEnd:e),o=s?s.posAtStart:r.from,l=s?s.posAtEnd:r.to;return l<n.state.doc.length&&l==r.to&&l++,b.undirectionalRange(o,l)}}var em=M.ie&&M.ie_version<=11,Dh=null,Oh=0,Bh=0;function Vc(n){if(!em)return n.detail;let e=Dh,t=Bh;return Dh=n,Bh=Date.now(),Oh=!e||t>Date.now()-400&&Math.abs(e.clientX-n.clientX)<2&&Math.abs(e.clientY-n.clientY)<2?(Oh+1)%3:1}function tm(n,e){let t=n.posAndSideAtCoords({x:e.clientX,y:e.clientY},!1),i=Vc(e),s=n.state.selection;return{update(r){r.docChanged&&(t.pos=r.changes.mapPos(t.pos),s=s.map(r.changes))},get(r,o,l){let a=n.posAndSideAtCoords({x:r.clientX,y:r.clientY},!1),h,c=Th(n,a.pos,a.assoc,i);if(t.pos!=a.pos&&!o){let f=Th(n,t.pos,t.assoc,i),u=Math.min(f.from,c.from),d=Math.max(f.to,c.to);c=u<c.from?b.range(u,d,c.assoc):b.range(d,u,c.assoc)}return o?s.replaceRange(s.main.extend(c.from,c.to,c.assoc)):l&&i==1&&s.ranges.length>1&&(h=im(s,a.pos))?h:l?s.addRange(c):b.create([c])}}}function im(n,e){for(let t=0;t<n.ranges.length;t++){let{from:i,to:s}=n.ranges[t];if(i<=e&&s>=e)return b.create(n.ranges.slice(0,t).concat(n.ranges.slice(t+1)),n.mainIndex==t?0:n.mainIndex-(n.mainIndex>t?1:0))}return null}Ue.dragstart=(n,e)=>{let{selection:{main:t}}=n.state;if(e.target.draggable){let s=n.docView.tile.nearest(e.target);if(s&&s.isWidget()){let r=s.posAtStart,o=r+s.length;(r>=t.to||o<=t.from)&&(t=b.undirectionalRange(r,o))}}let{inputState:i}=n;return i.mouseSelection&&(i.mouseSelection.dragging=!0),i.draggedContent=t,e.dataTransfer&&(e.dataTransfer.setData("Text",xs(n.state,Jo,n.state.sliceDoc(t.from,t.to))),e.dataTransfer.effectAllowed="copyMove"),!1};Ue.dragend=n=>(n.inputState.draggedContent=null,!1);function Lh(n,e,t,i){if(t=xs(n.state,Xo,t),!t)return;let s=n.posAtCoords({x:e.clientX,y:e.clientY},!1),{draggedContent:r}=n.inputState,o=i&&r&&Xp(n,e)?{from:r.from,to:r.to}:null,l={from:s,insert:t},a=n.state.changes(o?[o,l]:l);n.focus(),n.dispatch({changes:a,selection:{anchor:a.mapPos(s,-1),head:a.mapPos(s,1)},userEvent:o?"move.drop":"input.drop"}),n.inputState.draggedContent=null}Ue.drop=(n,e)=>{if(!e.dataTransfer)return!1;if(n.state.readOnly)return!0;let t=e.dataTransfer.files;if(t&&t.length){let i=Array(t.length),s=0,r=()=>{++s==t.length&&Lh(n,e,i.filter(o=>o!=null).join(n.state.lineBreak),!1)};for(let o=0;o<t.length;o++){let l=new FileReader;l.onerror=r,l.onload=()=>{/[\x00-\x08\x0e-\x1f]{2}/.test(l.result)||(i[o]=l.result),r()},l.readAsText(t[o])}return!0}else{let i=e.dataTransfer.getData("Text");if(i)return Lh(n,e,i,!0),!0}return!1};Ue.paste=(n,e)=>{if(n.state.readOnly)return!0;n.observer.flush();let t=Hc?null:e.clipboardData;return t?(Wc(n,t.getData("text/plain")||t.getData("text/uri-list")),!0):(Zp(n),!1)};function nm(n,e){let t=n.dom.parentNode;if(!t)return;let i=t.appendChild(document.createElement("textarea"));i.style.cssText="position: fixed; left: -10000px; top: 10px",i.value=e,i.focus(),i.selectionEnd=e.length,i.selectionStart=0,setTimeout(()=>{i.remove(),n.focus()},50)}function sm(n){let e=[],t=[],i=!1;for(let s of n.selection.ranges)s.empty||(e.push(n.sliceDoc(s.from,s.to)),t.push(s));if(!e.length){let s=-1;for(let{from:r}of n.selection.ranges){let o=n.doc.lineAt(r);o.number>s&&(e.push(o.text),t.push({from:o.from,to:Math.min(n.doc.length,o.to+1)})),s=o.number}i=!0}return{text:xs(n,Jo,e.join(n.lineBreak)),ranges:t,linewise:i}}var vo=null;Ue.copy=Ue.cut=(n,e)=>{if(!Wi(n.contentDOM,n.observer.selectionRange))return!1;let{text:t,ranges:i,linewise:s}=sm(n.state);if(!t&&!s)return!1;vo=s?t:null,e.type=="cut"&&!n.state.readOnly&&n.dispatch({changes:i,scrollIntoView:!0,userEvent:"delete.cut"});let r=Hc?null:e.clipboardData;return r?(r.clearData(),r.setData("text/plain",t),!0):(nm(n,t),!1)};var zc=xe.define();function qc(n,e){let t=[];for(let i of n.facet(wc)){let s=i(n,e);s&&t.push(s)}return t.length?n.update({effects:t,annotations:zc.of(!0)}):null}function Kc(n){setTimeout(()=>{let e=n.hasFocus;if(e!=n.inputState.notifiedFocused){let t=qc(n.state,e);t?n.dispatch(t):n.update([])}},10)}ve.focus=n=>{n.inputState.lastFocusTime=Date.now(),!n.scrollDOM.scrollTop&&(n.inputState.lastScrollTop||n.inputState.lastScrollLeft)&&(n.scrollDOM.scrollTop=n.inputState.lastScrollTop,n.scrollDOM.scrollLeft=n.inputState.lastScrollLeft),Kc(n)};ve.blur=n=>{n.observer.clearSelectionRange(),Kc(n)};ve.compositionstart=ve.compositionupdate=(n,e)=>{if(!n.observer.editContext&&(n.inputState.compositionFirstChange==null&&(n.inputState.compositionFirstChange=!0),n.inputState.composing<0)){let{main:t}=n.state.selection;!t.empty&&n.lineBlockAt(t.from).from!=n.lineBlockAt(t.to).from&&!n.state.readOnly&&n.dispatch({changes:n.state.selection.ranges.filter(i=>!i.empty).map(i=>({from:i.from,to:i.to})),userEvent:"input"}),n.inputState.composing=0}};ve.compositionend=n=>{n.observer.editContext||(n.inputState.composing=-1,n.inputState.compositionEndedAt=Date.now(),n.inputState.compositionPendingKey=!0,n.inputState.compositionPendingChange=n.observer.pendingRecords().length>0,n.inputState.compositionFirstChange=null,M.chrome&&M.android?n.observer.flushSoon():n.inputState.compositionPendingChange?Promise.resolve().then(()=>n.observer.flush()):setTimeout(()=>{n.inputState.composing<0&&n.docView.hasComposition&&n.update([])},50))};ve.contextmenu=n=>{n.inputState.lastContextMenu=Date.now()};Ue.beforeinput=(n,e)=>{var t,i;if((e.inputType=="insertText"||e.inputType=="insertCompositionText")&&(n.inputState.insertingText=e.data,n.inputState.insertingTextAt=Date.now()),e.inputType=="insertReplacementText"&&n.observer.editContext){let r=(t=e.dataTransfer)===null||t===void 0?void 0:t.getData("text/plain"),o=e.getTargetRanges();if(r&&o.length){let l=o[0],a=n.posAtDOM(l.startContainer,l.startOffset),h=n.posAtDOM(l.endContainer,l.endOffset);return el(n,{from:a,to:h,insert:n.state.toText(r)},null),!0}}let s;if(M.chrome&&M.android&&(s=Nc.find(r=>r.inputType==e.inputType))&&(n.observer.delayAndroidKey(s.key,s.keyCode),s.key=="Backspace"||s.key=="Delete")){let r=((i=window.visualViewport)===null||i===void 0?void 0:i.height)||0;setTimeout(()=>{var o;(((o=window.visualViewport)===null||o===void 0?void 0:o.height)||0)>r+10&&n.hasFocus&&(n.contentDOM.blur(),n.focus())},100)}return M.ios&&e.inputType=="deleteContentForward"&&n.observer.flushSoon(),M.safari&&e.inputType=="insertText"&&n.inputState.composing>=0&&setTimeout(()=>ve.compositionend(n,e),20),!1};var Eh=new Set;function rm(n){Eh.has(n)||(Eh.add(n),n.addEventListener("copy",()=>{}),n.addEventListener("cut",()=>{}))}var Rh=["pre-wrap","normal","pre-line","break-spaces"],bi=!1;function Ph(){bi=!1}var ko=class{constructor(e){this.lineWrapping=e,this.doc=N.empty,this.heightSamples={},this.lineHeight=14,this.charWidth=7,this.textHeight=14,this.lineLength=30}heightForGap(e,t){let i=this.doc.lineAt(t).number-this.doc.lineAt(e).number+1;return this.lineWrapping&&(i+=Math.max(0,Math.ceil((t-e-i*this.lineLength*.5)/this.lineLength))),this.lineHeight*i}heightForLine(e){return this.lineWrapping?(1+Math.max(0,Math.ceil((e-this.lineLength)/Math.max(1,this.lineLength-5))))*this.lineHeight:this.lineHeight}setDoc(e){return this.doc=e,this}mustRefreshForWrapping(e){return Rh.indexOf(e)>-1!=this.lineWrapping}mustRefreshForHeights(e){let t=!1;for(let i=0;i<e.length;i++){let s=e[i];s<0?i++:this.heightSamples[Math.floor(s*10)]||(t=!0,this.heightSamples[Math.floor(s*10)]=!0)}return t}refresh(e,t,i,s,r,o){let l=Rh.indexOf(e)>-1,a=Math.abs(t-this.lineHeight)>.3||this.lineWrapping!=l;if(this.lineWrapping=l,this.lineHeight=t,this.charWidth=i,this.textHeight=s,this.lineLength=r,a){this.heightSamples={};for(let h=0;h<o.length;h++){let c=o[h];c<0?h++:this.heightSamples[Math.floor(c*10)]=!0}}return a}},So=class{constructor(e,t){this.from=e,this.heights=t,this.index=0}get more(){return this.index<this.heights.length}},$e=class n{constructor(e,t,i,s,r){this.from=e,this.length=t,this.top=i,this.height=s,this._content=r}get type(){return typeof this._content=="number"?fe.Text:Array.isArray(this._content)?this._content:this._content.type}get to(){return this.from+this.length}get bottom(){return this.top+this.height}get widget(){return this._content instanceof Ft?this._content.widget:null}get widgetLineBreaks(){return typeof this._content=="number"?this._content:0}join(e){let t=(Array.isArray(this._content)?this._content:[this]).concat(Array.isArray(e._content)?e._content:[e]);return new n(this.from,this.length+e.length,this.top,this.height+e.height,t)}},Y=(function(n){return n[n.ByPos=0]="ByPos",n[n.ByHeight=1]="ByHeight",n[n.ByPosNoHeight=2]="ByPosNoHeight",n})(Y||(Y={})),_n=.001,Le=class n{constructor(e,t,i=2){this.length=e,this.height=t,this.flags=i}get outdated(){return(this.flags&2)>0}set outdated(e){this.flags=(e?2:0)|this.flags&-3}setHeight(e){this.height!=e&&(Math.abs(this.height-e)>_n&&(bi=!0),this.height=e)}replace(e,t,i){return n.of(i)}decomposeLeft(e,t){t.push(this)}decomposeRight(e,t){t.push(this)}applyChanges(e,t,i,s){let r=this,o=i.doc;for(let l=s.length-1;l>=0;l--){let{fromA:a,toA:h,fromB:c,toB:f}=s[l],u=r.lineAt(a,Y.ByPosNoHeight,i.setDoc(t),0,0),d=u.to>=h?u:r.lineAt(h,Y.ByPosNoHeight,i,0,0);for(f+=d.to-h,h=d.to;l>0&&u.from<=s[l-1].toA;)a=s[l-1].fromA,c=s[l-1].fromB,l--,a<u.from&&(u=r.lineAt(a,Y.ByPosNoHeight,i,0,0));c+=u.from-a,a=u.from;let p=Ao.build(i.setDoc(o),e,c,f);r=os(r,r.replace(a,h,p))}return r.updateHeight(i,0)}static empty(){return new He(0,0,0)}static of(e){if(e.length==1)return e[0];let t=0,i=e.length,s=0,r=0;for(;;)if(t==i)if(s>r*2){let l=e[t-1];l.break?e.splice(--t,1,l.left,null,l.right):e.splice(--t,1,l.left,l.right),i+=1+l.break,s-=l.size}else if(r>s*2){let l=e[i];l.break?e.splice(i,1,l.left,null,l.right):e.splice(i,1,l.left,l.right),i+=2+l.break,r-=l.size}else break;else if(s<r){let l=e[t++];l&&(s+=l.size)}else{let l=e[--i];l&&(r+=l.size)}let o=!1;return e[t-1]==null?(o=!0,t--):e[t]==null&&(o=!0,i++),new Co(n.of(e.slice(0,t)),o,n.of(e.slice(i)))}};function os(n,e){return n==e?n:(n.constructor!=e.constructor&&(bi=!0),e)}Le.prototype.size=1;var om=B.replace({}),ls=class extends Le{constructor(e,t,i){super(e,t),this.deco=i,this.spaceAbove=0}mainBlock(e,t){return new $e(t,this.length,e+this.spaceAbove,this.height-this.spaceAbove,this.deco||0)}blockAt(e,t,i,s){return this.spaceAbove&&e<i+this.spaceAbove?new $e(s,0,i,this.spaceAbove,om):this.mainBlock(i,s)}lineAt(e,t,i,s,r){let o=this.mainBlock(s,r);return this.spaceAbove?this.blockAt(0,i,s,r).join(o):o}forEachLine(e,t,i,s,r,o){e<=r+this.length&&t>=r&&o(this.lineAt(0,Y.ByPos,i,s,r))}setMeasuredHeight(e){let t=e.heights[e.index++];t<0?(this.spaceAbove=-t,t=e.heights[e.index++]):this.spaceAbove=0,this.setHeight(t)}updateHeight(e,t=0,i=!1,s){return s&&s.from<=t&&s.more&&this.setMeasuredHeight(s),this.outdated=!1,this}toString(){return`block(${this.length})`}},He=class n extends ls{constructor(e,t,i){super(e,t,null),this.collapsed=0,this.widgetHeight=0,this.breaks=0,this.spaceAbove=i}mainBlock(e,t){return new $e(t,this.length,e+this.spaceAbove,this.height-this.spaceAbove,this.breaks)}replace(e,t,i){let s=i[0];return i.length==1&&(s instanceof n||s instanceof mt&&s.flags&4)&&Math.abs(this.length-s.length)<10?(s instanceof mt?s=new n(s.length,this.height,this.spaceAbove):s.height=this.height,this.outdated||(s.outdated=!1),s):Le.of(i)}updateHeight(e,t=0,i=!1,s){return s&&s.from<=t&&s.more?this.setMeasuredHeight(s):(i||this.outdated)&&(this.spaceAbove=0,this.setHeight(Math.max(this.widgetHeight,e.heightForLine(this.length-this.collapsed))+this.breaks*e.lineHeight)),this.outdated=!1,this}toString(){return`line(${this.length}${this.collapsed?-this.collapsed:""}${this.widgetHeight?":"+this.widgetHeight:""})`}},mt=class n extends Le{constructor(e){super(e,0)}heightMetrics(e,t){let i=e.doc.lineAt(t).number,s=e.doc.lineAt(t+this.length).number,r=s-i+1,o,l=0;if(e.lineWrapping){let a=Math.min(this.height,e.lineHeight*r);o=a/r,this.length>r+1&&(l=(this.height-a)/(this.length-r-1))}else o=this.height/r;return{firstLine:i,lastLine:s,perLine:o,perChar:l}}blockAt(e,t,i,s){let{firstLine:r,lastLine:o,perLine:l,perChar:a}=this.heightMetrics(t,s);if(t.lineWrapping){let h=s+(e<t.lineHeight?0:Math.round(Math.max(0,Math.min(1,(e-i)/this.height))*this.length)),c=t.doc.lineAt(h),f=l+c.length*a,u=Math.max(i,e-f/2);return new $e(c.from,c.length,u,f,0)}else{let h=Math.max(0,Math.min(o-r,Math.floor((e-i)/l))),{from:c,length:f}=t.doc.line(r+h);return new $e(c,f,i+l*h,l,0)}}lineAt(e,t,i,s,r){if(t==Y.ByHeight)return this.blockAt(e,i,s,r);if(t==Y.ByPosNoHeight){let{from:d,to:p}=i.doc.lineAt(e);return new $e(d,p-d,0,0,0)}let{firstLine:o,perLine:l,perChar:a}=this.heightMetrics(i,r),h=i.doc.lineAt(e),c=l+h.length*a,f=h.number-o,u=s+l*f+a*(h.from-r-f);return new $e(h.from,h.length,Math.max(s,Math.min(u,s+this.height-c)),c,0)}forEachLine(e,t,i,s,r,o){e=Math.max(e,r),t=Math.min(t,r+this.length);let{firstLine:l,perLine:a,perChar:h}=this.heightMetrics(i,r);for(let c=e,f=s;c<=t;){let u=i.doc.lineAt(c);if(c==e){let p=u.number-l;f+=a*p+h*(e-r-p)}let d=a+h*u.length;o(new $e(u.from,u.length,f,d,0)),f+=d,c=u.to+1}}replace(e,t,i){let s=this.length-t;if(s>0){let r=i[i.length-1];r instanceof n?i[i.length-1]=new n(r.length+s):i.push(null,new n(s-1))}if(e>0){let r=i[0];r instanceof n?i[0]=new n(e+r.length):i.unshift(new n(e-1),null)}return Le.of(i)}decomposeLeft(e,t){t.push(new n(e-1),null)}decomposeRight(e,t){t.push(null,new n(this.length-e-1))}updateHeight(e,t=0,i=!1,s){let r=t+this.length;if(s&&s.from<=t+this.length&&s.more){let o=[],l=Math.max(t,s.from),a=-1;for(s.from>t&&o.push(new n(s.from-t-1).updateHeight(e,t));l<=r&&s.more;){let c=e.doc.lineAt(l).length;o.length&&o.push(null);let f=s.heights[s.index++],u=0;f<0&&(u=-f,f=s.heights[s.index++]),a==-1?a=f:Math.abs(f-a)>=_n&&(a=-2);let d=new He(c,f,u);d.outdated=!1,o.push(d),l+=c+1}l<=r&&o.push(null,new n(r-l).updateHeight(e,l));let h=Le.of(o);return(a<0||Math.abs(h.height-this.height)>=_n||Math.abs(a-this.heightMetrics(e,t).perLine)>=_n)&&(bi=!0),os(this,h)}else(i||this.outdated)&&(this.setHeight(e.heightForGap(t,t+this.length)),this.outdated=!1);return this}toString(){return`gap(${this.length})`}},Co=class extends Le{constructor(e,t,i){super(e.length+(t?1:0)+i.length,e.height+i.height,(t?1:0)|(e.outdated||i.outdated?2:0)),this.left=e,this.right=i,this.size=e.size+i.size}get break(){return this.flags&1}blockAt(e,t,i,s){let r=i+this.left.height;return e<r?this.left.blockAt(e,t,i,s):this.right.blockAt(e,t,r,s+this.left.length+this.break)}lineAt(e,t,i,s,r){let o=s+this.left.height,l=r+this.left.length+this.break,a=t==Y.ByHeight?e<o:e<l,h=a?this.left.lineAt(e,t,i,s,r):this.right.lineAt(e,t,i,o,l);if(this.break||(a?h.to<l:h.from>l))return h;let c=t==Y.ByPosNoHeight?Y.ByPosNoHeight:Y.ByPos;return a?h.join(this.right.lineAt(l,c,i,o,l)):this.left.lineAt(l,c,i,s,r).join(h)}forEachLine(e,t,i,s,r,o){let l=s+this.left.height,a=r+this.left.length+this.break;if(this.break)e<a&&this.left.forEachLine(e,t,i,s,r,o),t>=a&&this.right.forEachLine(e,t,i,l,a,o);else{let h=this.lineAt(a,Y.ByPos,i,s,r);e<h.from&&this.left.forEachLine(e,Math.min(t,h.from-1),i,s,r,o),h.to>=e&&h.from<=t&&o(h),t>h.to&&this.right.forEachLine(Math.max(e,h.to+1),t,i,l,a,o)}}replace(e,t,i){let s=this.left.length+this.break;if(t<s)return this.balanced(this.left.replace(e,t,i),this.right);if(e>this.left.length)return this.balanced(this.left,this.right.replace(e-s,t-s,i));let r=[];e>0&&this.decomposeLeft(e,r);let o=r.length;for(let l of i)r.push(l);if(e>0&&Ih(r,o-1),t<this.length){let l=r.length;this.decomposeRight(t,r),Ih(r,l)}return Le.of(r)}decomposeLeft(e,t){let i=this.left.length;if(e<=i)return this.left.decomposeLeft(e,t);t.push(this.left),this.break&&(i++,e>=i&&t.push(null)),e>i&&this.right.decomposeLeft(e-i,t)}decomposeRight(e,t){let i=this.left.length,s=i+this.break;if(e>=s)return this.right.decomposeRight(e-s,t);e<i&&this.left.decomposeRight(e,t),this.break&&e<s&&t.push(null),t.push(this.right)}balanced(e,t){return e.size>2*t.size||t.size>2*e.size?Le.of(this.break?[e,null,t]:[e,t]):(this.left=os(this.left,e),this.right=os(this.right,t),this.setHeight(e.height+t.height),this.outdated=e.outdated||t.outdated,this.size=e.size+t.size,this.length=e.length+this.break+t.length,this)}updateHeight(e,t=0,i=!1,s){let{left:r,right:o}=this,l=t+r.length+this.break,a=null;return s&&s.from<=t+r.length&&s.more?a=r=r.updateHeight(e,t,i,s):r.updateHeight(e,t,i),s&&s.from<=l+o.length&&s.more?a=o=o.updateHeight(e,l,i,s):o.updateHeight(e,l,i),a?this.balanced(r,o):(this.height=this.left.height+this.right.height,this.outdated=!1,this)}toString(){return this.left+(this.break?" ":"-")+this.right}};function Ih(n,e){let t,i;n[e]==null&&(t=n[e-1])instanceof mt&&(i=n[e+1])instanceof mt&&n.splice(e-1,3,new mt(t.length+1+i.length))}var lm=5,Ao=class n{constructor(e,t){this.pos=e,this.oracle=t,this.nodes=[],this.lineStart=-1,this.lineEnd=-1,this.covering=null,this.writtenTo=e}get isCovered(){return this.covering&&this.nodes[this.nodes.length-1]==this.covering}span(e,t){if(this.lineStart>-1){let i=Math.min(t,this.lineEnd),s=this.nodes[this.nodes.length-1];s instanceof He?s.length+=i-this.pos:(i>this.pos||!this.isCovered)&&this.nodes.push(new He(i-this.pos,-1,0)),this.writtenTo=i,t>i&&(this.nodes.push(null),this.writtenTo++,this.lineStart=-1)}this.pos=t}point(e,t,i){if(e<t||i.heightRelevant){let s=i.widget?i.widget.estimatedHeight:0,r=i.widget?i.widget.lineBreaks:0;s<0&&(s=this.oracle.lineHeight);let o=t-e;i.block?this.addBlock(new ls(o,s,i)):(o||r||s>=lm)&&this.addLineDeco(s,r,o)}else t>e&&this.span(e,t);this.lineEnd>-1&&this.lineEnd<this.pos&&(this.lineEnd=this.oracle.doc.lineAt(this.pos).to)}enterLine(){if(this.lineStart>-1)return;let{from:e,to:t}=this.oracle.doc.lineAt(this.pos);this.lineStart=e,this.lineEnd=t,this.writtenTo<e&&((this.writtenTo<e-1||this.nodes[this.nodes.length-1]==null)&&this.nodes.push(this.blankContent(this.writtenTo,e-1)),this.nodes.push(null)),this.pos>e&&this.nodes.push(new He(this.pos-e,-1,0)),this.writtenTo=this.pos}blankContent(e,t){let i=new mt(t-e);return this.oracle.doc.lineAt(e).to==t&&(i.flags|=4),i}ensureLine(){this.enterLine();let e=this.nodes.length?this.nodes[this.nodes.length-1]:null;if(e instanceof He)return e;let t=new He(0,-1,0);return this.nodes.push(t),t}addBlock(e){this.enterLine();let t=e.deco;t&&t.startSide>0&&!this.isCovered&&this.ensureLine(),this.nodes.push(e),this.writtenTo=this.pos=this.pos+e.length,t&&t.endSide>0&&(this.covering=e)}addLineDeco(e,t,i){let s=this.ensureLine();s.length+=i,s.collapsed+=i,s.widgetHeight=Math.max(s.widgetHeight,e),s.breaks+=t,this.writtenTo=this.pos=this.pos+i}finish(e){let t=this.nodes.length==0?null:this.nodes[this.nodes.length-1];this.lineStart>-1&&!(t instanceof He)&&!this.isCovered?this.nodes.push(new He(0,-1,0)):(this.writtenTo<this.pos||t==null)&&this.nodes.push(this.blankContent(this.writtenTo,this.pos));let i=e;for(let s of this.nodes)s instanceof He&&s.updateHeight(this.oracle,i),i+=s?s.length:1;return this.nodes}static build(e,t,i,s){let r=new n(i,e);return H.spans(t,i,s,r,0),r.finish(i)}};function am(n,e,t){let i=new Mo;return H.compare(n,e,t,i,0),i.changes}var Mo=class{constructor(){this.changes=[]}compareRange(){}comparePoint(e,t,i,s){(e<t||i&&i.heightRelevant||s&&s.heightRelevant)&&ci(e,t,this.changes,5)}};function hm(n,e){let t=n.getBoundingClientRect(),i=n.ownerDocument,s=i.defaultView||window,r=Math.max(0,t.left),o=Math.min(s.innerWidth,t.right),l=Math.max(0,t.top),a=Math.min(s.innerHeight,t.bottom);for(let h=n.parentNode;h&&h!=i.body;)if(se(h)){let c=window.getComputedStyle(h);if((h.scrollHeight>h.clientHeight||h.scrollWidth>h.clientWidth)&&c.overflow!="visible"){let f=h.getBoundingClientRect();r=Math.max(r,f.left),o=Math.min(o,f.right),l=Math.max(l,f.top),a=Math.min(h==n.parentNode?s.innerHeight:a,f.bottom)}h=c.position=="absolute"||c.position=="fixed"?h.offsetParent:h.parentNode}else if(h.nodeType==11)h=h.host;else break;return{left:r-t.left,right:Math.max(r,o)-t.left,top:l-(t.top+e),bottom:Math.max(l,a)-(t.top+e)}}function cm(n){let e=n.getBoundingClientRect(),t=n.ownerDocument.defaultView||window;return e.left<t.innerWidth&&e.right>0&&e.top<t.innerHeight&&e.bottom>0}function fm(n,e){let t=n.getBoundingClientRect();return{left:0,right:t.right-t.left,top:e,bottom:t.bottom-(t.top+e)}}var Ui=class{constructor(e,t,i,s){this.from=e,this.to=t,this.size=i,this.displaySize=s}static same(e,t){if(e.length!=t.length)return!1;for(let i=0;i<e.length;i++){let s=e[i],r=t[i];if(s.from!=r.from||s.to!=r.to||s.size!=r.size)return!1}return!0}draw(e,t){return B.replace({widget:new To(this.displaySize*(t?e.scaleY:e.scaleX),t)}).range(this.from,this.to)}},To=class extends re{constructor(e,t){super(),this.size=e,this.vertical=t}eq(e){return e.size==this.size&&e.vertical==this.vertical}toDOM(){let e=document.createElement("div");return this.vertical?e.style.height=this.size+"px":(e.style.width=this.size+"px",e.style.height="2px",e.style.display="inline-block"),e}get estimatedHeight(){return this.vertical?this.size:-1}},as=class{constructor(e,t){this.view=e,this.state=t,this.pixelViewport={left:0,right:window.innerWidth,top:0,bottom:0},this.inView=!0,this.paddingTop=0,this.paddingBottom=0,this.contentDOMWidth=0,this.contentDOMHeight=0,this.editorHeight=0,this.editorWidth=0,this.scaleX=1,this.scaleY=1,this.scrollOffset=0,this.scrolledToBottom=!1,this.scrollAnchorPos=0,this.scrollAnchorHeight=-1,this.scaler=Do,this.scrollTarget=null,this.printing=!1,this.mustMeasureContent=!0,this.defaultTextDirection=z.LTR,this.visibleRanges=[],this.mustEnforceCursorAssoc=!1;let i=t.facet(ys).some(s=>typeof s!="function"&&s.class=="cm-lineWrapping");this.heightOracle=new ko(i),this.stateDeco=Nh(t),this.heightMap=Le.empty().applyChanges(this.stateDeco,N.empty,this.heightOracle.setDoc(t.doc),[new je(0,0,0,t.doc.length)]);for(let s=0;s<2&&(this.viewport=this.getViewport(0,null),!!this.updateForViewport());s++);this.updateViewportLines(),this.lineGaps=this.ensureLineGaps([]),this.lineGapDeco=B.set(this.lineGaps.map(s=>s.draw(this,!1))),this.scrollParent=e.scrollDOM,this.computeVisibleRanges()}updateForViewport(){let e=[this.viewport],{main:t}=this.state.selection;for(let i=0;i<=1;i++){let s=i?t.head:t.anchor;if(!e.some(({from:r,to:o})=>s>=r&&s<=o)){let{from:r,to:o}=this.lineBlockAt(s);e.push(new li(r,o))}}return this.viewports=e.sort((i,s)=>i.from-s.from),this.updateScaler()}updateScaler(){let e=this.scaler;return this.scaler=this.heightMap.height<=7e6?Do:Oo.get(this.heightOracle,this.heightMap,this.viewports),e.eq(this.scaler)?0:2}updateViewportLines(){this.viewportLines=[],this.heightMap.forEachLine(this.viewport.from,this.viewport.to,this.heightOracle.setDoc(this.state.doc),0,0,e=>{this.viewportLines.push(Fi(e,this.scaler))})}update(e,t=null){this.state=e.state;let i=this.stateDeco;this.stateDeco=Nh(this.state);let s=e.changedRanges,r=je.extendWithRanges(s,am(i,this.stateDeco,e?e.changes:be.empty(this.state.doc.length))),o=this.heightMap.height,l=this.scrolledToBottom?null:this.scrollAnchorAt(this.scrollOffset);Ph(),this.heightMap=this.heightMap.applyChanges(this.stateDeco,e.startState.doc,this.heightOracle.setDoc(this.state.doc),r),(this.heightMap.height!=o||bi)&&(e.flags|=2),l?(this.scrollAnchorPos=e.changes.mapPos(l.from,-1),this.scrollAnchorHeight=l.top):(this.scrollAnchorPos=-1,this.scrollAnchorHeight=o);let a=r.length?this.mapViewport(this.viewport,e.changes):this.viewport;(t&&(t.range.head<a.from||t.range.head>a.to)||!this.viewportIsAppropriate(a))&&(a=this.getViewport(0,t));let h=a.from!=this.viewport.from||a.to!=this.viewport.to;this.viewport=a,e.flags|=this.updateForViewport(),(h||!e.changes.empty||e.flags&2)&&this.updateViewportLines(),(this.lineGaps.length||this.viewport.to-this.viewport.from>4e3)&&this.updateLineGaps(this.ensureLineGaps(this.mapLineGaps(this.lineGaps,e.changes))),e.flags|=this.computeVisibleRanges(e.changes),t&&(this.scrollTarget=t),!this.mustEnforceCursorAssoc&&(e.selectionSet||e.focusChanged)&&e.view.lineWrapping&&e.state.selection.main.empty&&e.state.selection.main.assoc&&!e.state.facet(kc)&&(this.mustEnforceCursorAssoc=!0)}measure(){let{view:e}=this,t=e.contentDOM,i=window.getComputedStyle(t),s=this.heightOracle,r=i.whiteSpace;this.defaultTextDirection=i.direction=="rtl"?z.RTL:z.LTR;let o=this.heightOracle.mustRefreshForWrapping(r)||this.mustMeasureContent==="refresh",l=t.getBoundingClientRect(),a=o||this.mustMeasureContent||this.contentDOMHeight!=l.height;this.contentDOMHeight=l.height,this.mustMeasureContent=!1;let h=0,c=0;if(l.width&&l.height){let{scaleX:w,scaleY:k}=ic(t,l);(w>.005&&Math.abs(this.scaleX-w)>.005||k>.005&&Math.abs(this.scaleY-k)>.005)&&(this.scaleX=w,this.scaleY=k,h|=16,o=a=!0)}let f=(parseInt(i.paddingTop)||0)*this.scaleY,u=(parseInt(i.paddingBottom)||0)*this.scaleY;(this.paddingTop!=f||this.paddingBottom!=u)&&(this.paddingTop=f,this.paddingBottom=u,h|=18),this.editorWidth!=e.scrollDOM.clientWidth&&(s.lineWrapping&&(a=!0),this.editorWidth=e.scrollDOM.clientWidth,h|=16);let d=nc(this.view.contentDOM,!1).y;d!=this.scrollParent&&(this.scrollParent=d,this.scrollAnchorHeight=-1,this.scrollOffset=0);let p=this.getScrollOffset();this.scrollOffset!=p&&(this.scrollAnchorHeight=-1,this.scrollOffset=p),this.scrolledToBottom=lc(this.scrollParent||e.win);let m=(this.printing?fm:hm)(t,this.paddingTop),g=m.top-this.pixelViewport.top,y=m.bottom-this.pixelViewport.bottom;this.pixelViewport=m;let v=this.pixelViewport.bottom>this.pixelViewport.top&&this.pixelViewport.right>this.pixelViewport.left;if(v!=this.inView&&(this.inView=v,v&&(a=!0)),!this.inView&&!this.scrollTarget&&!cm(e.dom))return 0;let x=l.width;if((this.contentDOMWidth!=x||this.editorHeight!=e.scrollDOM.clientHeight)&&(this.contentDOMWidth=l.width,this.editorHeight=e.scrollDOM.clientHeight,h|=16),a){let w=e.docView.measureVisibleLineHeights(this.viewport);if(s.mustRefreshForHeights(w)&&(o=!0),o||s.lineWrapping&&Math.abs(x-this.contentDOMWidth)>s.charWidth){let{lineHeight:k,charWidth:S,textHeight:R}=e.docView.measureTextSize();o=k>0&&s.refresh(r,k,S,R,Math.max(5,x/S),w),o&&(e.docView.minWidth=0,h|=16)}g>0&&y>0?c=Math.max(g,y):g<0&&y<0&&(c=Math.min(g,y)),Ph();for(let k of this.viewports){let S=k.from==this.viewport.from?w:e.docView.measureVisibleLineHeights(k);this.heightMap=(o?Le.empty().applyChanges(this.stateDeco,N.empty,this.heightOracle,[new je(0,0,0,e.state.doc.length)]):this.heightMap).updateHeight(s,0,o,new So(k.from,S))}bi&&(h|=2)}let D=!this.viewportIsAppropriate(this.viewport,c)||this.scrollTarget&&(this.scrollTarget.range.head<this.viewport.from||this.scrollTarget.range.head>this.viewport.to);return D&&(h&2&&(h|=this.updateScaler()),this.viewport=this.getViewport(c,this.scrollTarget),h|=this.updateForViewport()),(h&2||D)&&this.updateViewportLines(),(this.lineGaps.length||this.viewport.to-this.viewport.from>4e3)&&this.updateLineGaps(this.ensureLineGaps(o?[]:this.lineGaps,e)),h|=this.computeVisibleRanges(),this.mustEnforceCursorAssoc&&(this.mustEnforceCursorAssoc=!1,e.docView.enforceCursorAssoc()),h}get visibleTop(){return this.scaler.fromDOM(this.pixelViewport.top)}get visibleBottom(){return this.scaler.fromDOM(this.pixelViewport.bottom)}getViewport(e,t){let i=.5-Math.max(-.5,Math.min(.5,e/1e3/2)),s=this.heightMap,r=this.heightOracle,{visibleTop:o,visibleBottom:l}=this,a=new li(s.lineAt(o-i*1e3,Y.ByHeight,r,0,0).from,s.lineAt(l+(1-i)*1e3,Y.ByHeight,r,0,0).to);if(t){let{head:h}=t.range;if(h<a.from||h>a.to){let c=Math.min(this.editorHeight,this.pixelViewport.bottom-this.pixelViewport.top),f=s.lineAt(h,Y.ByPos,r,0,0),u;t.y=="center"?u=(f.top+f.bottom)/2-c/2:t.y=="start"||t.y=="nearest"&&h<a.from?u=f.top:u=f.bottom-c,a=new li(s.lineAt(u-1e3/2,Y.ByHeight,r,0,0).from,s.lineAt(u+c+1e3/2,Y.ByHeight,r,0,0).to)}}return a}mapViewport(e,t){let i=t.mapPos(e.from,-1),s=t.mapPos(e.to,1);return new li(this.heightMap.lineAt(i,Y.ByPos,this.heightOracle,0,0).from,this.heightMap.lineAt(s,Y.ByPos,this.heightOracle,0,0).to)}viewportIsAppropriate({from:e,to:t},i=0){if(!this.inView)return!0;let{top:s}=this.heightMap.lineAt(e,Y.ByPos,this.heightOracle,0,0),{bottom:r}=this.heightMap.lineAt(t,Y.ByPos,this.heightOracle,0,0),{visibleTop:o,visibleBottom:l}=this;return(e==0||s<=o-Math.max(10,Math.min(-i,250)))&&(t==this.state.doc.length||r>=l+Math.max(10,Math.min(i,250)))&&s>o-2*1e3&&r<l+2*1e3}mapLineGaps(e,t){if(!e.length||t.empty)return e;let i=[];for(let s of e)t.touchesRange(s.from,s.to)||i.push(new Ui(t.mapPos(s.from),t.mapPos(s.to),s.size,s.displaySize));return i}ensureLineGaps(e,t){let i=this.heightOracle.lineWrapping,s=i?1e4:2e3,r=s>>1,o=s<<1;if(this.defaultTextDirection!=z.LTR&&!i)return[];let l=[],a=(c,f,u,d)=>{if(f-c<r)return;let p=this.state.selection.main,m=[p.from];p.empty||m.push(p.to);for(let y of m)if(y>c&&y<f){a(c,y-10,u,d),a(y+10,f,u,d);return}let g=dm(e,y=>y.from>=u.from&&y.to<=u.to&&Math.abs(y.from-c)<r&&Math.abs(y.to-f)<r&&!m.some(v=>y.from<v&&y.to>v));if(!g){if(f<u.to&&t&&i&&t.visibleRanges.some(x=>x.from<=f&&x.to>=f)){let x=t.moveToLineBoundary(b.cursor(f),!1,!0).head;x>c&&(f=x)}let y=this.gapSize(u,c,f,d),v=i||y<2e6?y:2e6;g=new Ui(c,f,y,v)}l.push(g)},h=c=>{if(c.length<o||c.type!=fe.Text)return;let f=um(c.from,c.to,this.stateDeco);if(f.total<o)return;let u=this.scrollTarget?this.scrollTarget.range.head:null,d,p;if(i){let m=s/this.heightOracle.lineLength*this.heightOracle.lineHeight,g,y;if(u!=null){let v=Kn(f,u),x=((this.visibleBottom-this.visibleTop)/2+m)/c.height;g=v-x,y=v+x}else g=(this.visibleTop-c.top-m)/c.height,y=(this.visibleBottom-c.top+m)/c.height;d=qn(f,g),p=qn(f,y)}else{let m=f.total*this.heightOracle.charWidth,g=s*this.heightOracle.charWidth,y=0;if(m>2e6)for(let k of e)k.from>=c.from&&k.from<c.to&&k.size!=k.displaySize&&k.from*this.heightOracle.charWidth+y<this.pixelViewport.left&&(y=k.size-k.displaySize);let v=this.pixelViewport.left+y,x=this.pixelViewport.right+y,D,w;if(u!=null){let k=Kn(f,u),S=((x-v)/2+g)/m;D=k-S,w=k+S}else D=(v-g)/m,w=(x+g)/m;d=qn(f,D),p=qn(f,w)}d>c.from&&a(c.from,d,c,f),p<c.to&&a(p,c.to,c,f)};for(let c of this.viewportLines)Array.isArray(c.type)?c.type.forEach(h):h(c);return l}gapSize(e,t,i,s){let r=Kn(s,i)-Kn(s,t);return this.heightOracle.lineWrapping?e.height*r:s.total*this.heightOracle.charWidth*r}updateLineGaps(e){Ui.same(e,this.lineGaps)||(this.lineGaps=e,this.lineGapDeco=B.set(e.map(t=>t.draw(this,this.heightOracle.lineWrapping))))}computeVisibleRanges(e){let t=this.stateDeco;this.lineGaps.length&&(t=t.concat(this.lineGapDeco));let i=[];H.spans(t,this.viewport.from,this.viewport.to,{span(r,o){i.push({from:r,to:o})},point(){}},20);let s=0;if(i.length!=this.visibleRanges.length)s=12;else for(let r=0;r<i.length&&!(s&8);r++){let o=this.visibleRanges[r],l=i[r];(o.from!=l.from||o.to!=l.to)&&(s|=4,e&&e.mapPos(o.from,-1)==l.from&&e.mapPos(o.to,1)==l.to||(s|=8))}return this.visibleRanges=i,s}lineBlockAt(e){return e>=this.viewport.from&&e<=this.viewport.to&&this.viewportLines.find(t=>t.from<=e&&t.to>=e)||Fi(this.heightMap.lineAt(e,Y.ByPos,this.heightOracle,0,0),this.scaler)}lineBlockAtHeight(e){return e>=this.viewportLines[0].top&&e<=this.viewportLines[this.viewportLines.length-1].bottom&&this.viewportLines.find(t=>t.top<=e&&t.bottom>=e)||Fi(this.heightMap.lineAt(this.scaler.fromDOM(e),Y.ByHeight,this.heightOracle,0,0),this.scaler)}getScrollOffset(){return this.scrollParent==this.view.scrollDOM?this.scrollParent.scrollTop*this.scaleY:(this.scrollParent?this.scrollParent.getBoundingClientRect().top:0)-this.view.contentDOM.getBoundingClientRect().top}scrollAnchorAt(e){let t=this.lineBlockAtHeight(e+12-this.paddingTop);return t.from>=this.viewport.from||this.viewportLines[0].top-e>200?t:this.viewportLines[0]}elementAtHeight(e){return Fi(this.heightMap.blockAt(this.scaler.fromDOM(e),this.heightOracle,0,0),this.scaler)}get docHeight(){return this.scaler.toDOM(this.heightMap.height)}get contentHeight(){return this.docHeight+this.paddingTop+this.paddingBottom}},li=class{constructor(e,t){this.from=e,this.to=t}};function um(n,e,t){let i=[],s=n,r=0;return H.spans(t,n,e,{span(){},point(o,l){o>s&&(i.push({from:s,to:o}),r+=o-s),s=l}},20),s<e&&(i.push({from:s,to:e}),r+=e-s),{total:r,ranges:i}}function qn({total:n,ranges:e},t){if(t<=0)return e[0].from;if(t>=1)return e[e.length-1].to;let i=Math.floor(n*t);for(let s=0;;s++){let{from:r,to:o}=e[s],l=o-r;if(i<=l)return r+i;i-=l}}function Kn(n,e){let t=0;for(let{from:i,to:s}of n.ranges){if(e<=s){t+=e-i;break}t+=s-i}return t/n.total}function dm(n,e){for(let t of n)if(e(t))return t}var Do={toDOM(n){return n},fromDOM(n){return n},scale:1,eq(n){return n==this}};function Nh(n){let e=n.facet(bs).filter(i=>typeof i!="function"),t=n.facet(Qo).filter(i=>typeof i!="function");return t.length&&e.push(H.join(t)),e}var Oo=class n{constructor(e,t){this.scale=e,this.viewports=t}static get(e,t,i){let s=0,r=0,o=0,l=i.map(({from:h,to:c})=>{let f=t.lineAt(h,Y.ByPos,e,0,0).top,u=t.lineAt(c,Y.ByPos,e,0,0).bottom;return s+=u-f,{from:h,to:c,top:f,bottom:u,domTop:0,domBottom:0}});if(t.height-s<10)return Do;let a=(7e6-s)/(t.height-s);for(let h of l)h.domTop=o+(h.top-r)*a,o=h.domBottom=h.domTop+(h.bottom-h.top),r=h.bottom;return new n(a,l)}toDOM(e){for(let t=0,i=0,s=0;;t++){let r=t<this.viewports.length?this.viewports[t]:null;if(!r||e<r.top)return s+(e-i)*this.scale;if(e<=r.bottom)return r.domTop+(e-r.top);i=r.bottom,s=r.domBottom}}fromDOM(e){for(let t=0,i=0,s=0;;t++){let r=t<this.viewports.length?this.viewports[t]:null;if(!r||e<r.domTop)return i+(e-s)/this.scale;if(e<=r.domBottom)return r.top+(e-r.domTop);i=r.bottom,s=r.domBottom}}eq(e){return e instanceof n?this.scale==e.scale&&this.viewports.length==e.viewports.length&&this.viewports.every((t,i)=>t.from==e.viewports[i].from&&t.to==e.viewports[i].to):!1}};function Fi(n,e){if(e.scale==1)return n;let t=e.toDOM(n.top),i=e.toDOM(n.bottom);return new $e(n.from,n.length,t,i-t,Array.isArray(n._content)?n._content.map(s=>Fi(s,e)):n._content)}var $n=C.define({combine:n=>n.join(" ")}),Bo=C.define({combine:n=>n.indexOf(!0)>-1}),Lo=Fe.newName(),$c=Fe.newName(),jc=Fe.newName(),Uc={"&light":"."+$c,"&dark":"."+jc};function Eo(n,e,t){return new Fe(e,{finish(i){return/&/.test(i)?i.replace(/&\w*/,s=>{if(s=="&")return n;if(!t||!t[s])throw new RangeError(`Unsupported selector: ${s}`);return t[s]}):n+" "+i}})}var pm=Eo("."+Lo,{"&":{position:"relative !important",boxSizing:"border-box","&.cm-focused":{outline:"1px dotted #212121"},display:"flex !important",flexDirection:"column"},".cm-scroller":{display:"flex !important",alignItems:"flex-start !important",fontFamily:"monospace",lineHeight:1.4,height:"100%",overflowX:"auto",position:"relative",zIndex:0,overflowAnchor:"none"},".cm-content":{margin:0,flexGrow:2,flexShrink:0,display:"block",whiteSpace:"pre",wordWrap:"normal",boxSizing:"border-box",minHeight:"100%",padding:"4px 0",outline:"none","&[contenteditable=true]":{WebkitUserModify:"read-write-plaintext-only"}},".cm-lineWrapping":{whiteSpace_fallback:"pre-wrap",whiteSpace:"break-spaces",wordBreak:"break-word",overflowWrap:"anywhere",flexShrink:1},"&light .cm-content":{caretColor:"black"},"&dark .cm-content":{caretColor:"white"},".cm-line":{display:"block",padding:"0 2px 0 6px"},".cm-layer":{userSelect:"none",position:"absolute",left:0,top:0,contain:"size style","& > *":{position:"absolute"}},"&light .cm-selectionBackground":{background:"#d9d9d9"},"&dark .cm-selectionBackground":{background:"#222"},"&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":{background:"#d7d4f0"},"&dark.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":{background:"#233"},".cm-cursorLayer":{pointerEvents:"none"},"&.cm-focused > .cm-scroller > .cm-cursorLayer":{animation:"steps(1) cm-blink 1.2s infinite"},"@keyframes cm-blink":{"0%":{},"50%":{opacity:0},"100%":{}},"@keyframes cm-blink2":{"0%":{},"50%":{opacity:0},"100%":{}},".cm-cursor, .cm-dropCursor":{borderLeft:"1.2px solid black",marginLeft:"-0.6px",pointerEvents:"none"},".cm-cursor":{display:"none"},"&dark .cm-cursor":{borderLeftColor:"#ddd"},".cm-selectionHandle":{backgroundColor:"currentColor",width:"1.5px"},".cm-selectionHandle-start::before, .cm-selectionHandle-end::before":{content:'""',backgroundColor:"inherit",borderRadius:"50%",width:"8px",height:"8px",position:"absolute",left:"-3.25px"},".cm-selectionHandle-start::before":{top:"-8px"},".cm-selectionHandle-end::before":{bottom:"-8px"},".cm-dropCursor":{position:"absolute"},"&.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor":{display:"block"},".cm-iso":{unicodeBidi:"isolate"},".cm-announced":{position:"fixed",top:"-10000px"},"@media print":{".cm-announced":{display:"none"}},"&light .cm-activeLine":{backgroundColor:"#cceeff44"},"&dark .cm-activeLine":{backgroundColor:"#99eeff33"},"&light .cm-specialChar":{color:"red"},"&dark .cm-specialChar":{color:"#f78"},".cm-gutters":{flexShrink:0,display:"flex",height:"100%",boxSizing:"border-box",zIndex:200},".cm-gutters-before":{insetInlineStart:0},".cm-gutters-after":{insetInlineEnd:0},"&light .cm-gutters":{backgroundColor:"#f5f5f5",color:"#6c6c6c",border:"0px solid #ddd","&.cm-gutters-before":{borderRightWidth:"1px"},"&.cm-gutters-after":{borderLeftWidth:"1px"}},"&dark .cm-gutters":{backgroundColor:"#333338",color:"#ccc"},".cm-gutter":{display:"flex !important",flexDirection:"column",flexShrink:0,boxSizing:"border-box",minHeight:"100%",overflow:"hidden"},".cm-gutterElement":{boxSizing:"border-box"},".cm-lineNumbers .cm-gutterElement":{padding:"0 3px 0 5px",minWidth:"20px",textAlign:"right",whiteSpace:"nowrap"},"&light .cm-activeLineGutter":{backgroundColor:"#e2f2ff"},"&dark .cm-activeLineGutter":{backgroundColor:"#222227"},".cm-panels":{boxSizing:"border-box",position:"sticky",left:0,right:0,zIndex:300},"&light .cm-panels":{backgroundColor:"#f5f5f5",color:"black"},".cm-panels-top":{top:"0"},".cm-panels-bottom":{bottom:"0"},"&light .cm-panels-top":{borderBottom:"1px solid #ddd"},"&light .cm-panels-bottom":{borderTop:"1px solid #ddd"},"&dark .cm-panels":{backgroundColor:"#333338",color:"white"},".cm-dialog":{padding:"2px 19px 4px 6px",position:"relative","& label":{fontSize:"80%"}},".cm-dialog-close":{position:"absolute",top:"3px",right:"4px",backgroundColor:"inherit",border:"none",font:"inherit",fontSize:"14px",padding:"0"},".cm-tab":{display:"inline-block",overflow:"hidden",verticalAlign:"bottom"},".cm-widgetBuffer":{verticalAlign:"baseline",height:"1em",width:0,display:"inline"},".cm-placeholder":{color:"#888",display:"inline-block",verticalAlign:"top",userSelect:"none"},".cm-highlightSpace":{background:"radial-gradient(circle at 50% 55%, #aaa 20%, transparent 0) no-repeat",backgroundSize:".4em",backgroundPosition:"calc(min(50%, 0px)) center"},".cm-highlightTab":{backgroundImage:`url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="20"><path stroke="%23888" stroke-width="1" fill="none" d="M1 10H196L190 5M190 15L196 10M197 4L197 16"/></svg>')`,backgroundSize:"auto 100%",backgroundPosition:"right 90%",backgroundRepeat:"no-repeat"},".cm-trailingSpace":{backgroundColor:"#ff332255"},".cm-button":{verticalAlign:"middle",color:"inherit",fontSize:"70%",padding:".2em 1em",borderRadius:"1px"},"&light .cm-button":{backgroundImage:"linear-gradient(#eff1f5, #d9d9df)",border:"1px solid #888","&:active":{backgroundImage:"linear-gradient(#b4b4b4, #d0d3d6)"}},"&dark .cm-button":{backgroundImage:"linear-gradient(#393939, #111)",border:"1px solid #888","&:active":{backgroundImage:"linear-gradient(#111, #333)"}},".cm-textfield":{verticalAlign:"middle",color:"inherit",fontSize:"70%",border:"1px solid silver",padding:".2em .5em"},"&light .cm-textfield":{backgroundColor:"white"},"&dark .cm-textfield":{border:"1px solid #555",backgroundColor:"inherit"}},Uc),mm={childList:!0,characterData:!0,subtree:!0,attributes:!0,characterDataOldValue:!0},$r=M.ie&&M.ie_version<=11,Ro=class{constructor(e){this.view=e,this.active=!1,this.editContext=null,this.selectionRange=new Zr,this.selectionChanged=!1,this.delayedFlush=-1,this.resizeTimeout=-1,this.queue=[],this.delayedAndroidKey=null,this.flushingAndroidKey=-1,this.lastChange=0,this.scrollTargets=[],this.intersection=null,this.resizeScroll=null,this.intersecting=!1,this.gapIntersection=null,this.gaps=[],this.printQuery=null,this.parentCheck=-1,this.dom=e.contentDOM,this.observer=new MutationObserver(t=>{for(let i of t)this.queue.push(i);(M.ie&&M.ie_version<=11||M.ios&&e.composing)&&t.some(i=>i.type=="childList"&&i.removedNodes.length||i.type=="characterData"&&i.oldValue.length>i.target.nodeValue.length)?this.flushSoon():this.flush()}),window.EditContext&&M.android&&e.constructor.EDIT_CONTEXT!==!1&&!(M.chrome&&M.chrome_version<126)&&(this.editContext=new Po(e),e.state.facet(ht)&&(e.contentDOM.editContext=this.editContext.editContext)),$r&&(this.onCharData=t=>{this.queue.push({target:t.target,type:"characterData",oldValue:t.prevValue}),this.flushSoon()}),this.onSelectionChange=this.onSelectionChange.bind(this),this.onResize=this.onResize.bind(this),this.onPrint=this.onPrint.bind(this),this.onScroll=this.onScroll.bind(this),window.matchMedia&&(this.printQuery=window.matchMedia("print")),typeof ResizeObserver=="function"&&(this.resizeScroll=new ResizeObserver(()=>{var t;((t=this.view.docView)===null||t===void 0?void 0:t.lastUpdate)<Date.now()-75&&this.onResize()}),this.resizeScroll.observe(e.scrollDOM)),this.addWindowListeners(this.win=e.win),this.start(),typeof IntersectionObserver=="function"&&(this.intersection=new IntersectionObserver(t=>{this.parentCheck<0&&(this.parentCheck=setTimeout(this.listenForScroll.bind(this),1e3)),t.length>0&&t[t.length-1].intersectionRatio>0!=this.intersecting&&(this.intersecting=!this.intersecting,this.intersecting!=this.view.inView&&this.onScrollChanged(document.createEvent("Event")))},{threshold:[0,.001]}),this.intersection.observe(this.dom),this.gapIntersection=new IntersectionObserver(t=>{t.length>0&&t[t.length-1].intersectionRatio>0&&this.onScrollChanged(document.createEvent("Event"))},{})),this.listenForScroll(),this.readSelectionRange()}onScrollChanged(e){this.view.inputState.runHandlers("scroll",e),this.intersecting&&this.view.measure()}onScroll(e){this.intersecting&&this.flush(this.pendingRecords().length>0),this.editContext&&this.view.requestMeasure(this.editContext.measureReq),this.onScrollChanged(e)}onResize(){this.resizeTimeout<0&&(this.resizeTimeout=setTimeout(()=>{this.resizeTimeout=-1,this.view.requestMeasure()},50))}onPrint(e){(e.type=="change"||!e.type)&&!e.matches||(this.view.viewState.printing=!0,this.view.measure(),setTimeout(()=>{this.view.viewState.printing=!1,this.view.requestMeasure()},500))}updateGaps(e){if(this.gapIntersection&&(e.length!=this.gaps.length||this.gaps.some((t,i)=>t!=e[i]))){this.gapIntersection.disconnect();for(let t of e)this.gapIntersection.observe(t);this.gaps=e}}onSelectionChange(e){let t=this.selectionChanged;if(!this.readSelectionRange()||this.delayedAndroidKey)return;let{view:i}=this,s=this.selectionRange;if(i.state.facet(ht)?i.root.activeElement!=this.dom:!Wi(this.dom,s))return;let r=s.anchorNode&&i.docView.tile.nearest(s.anchorNode);if(r&&r.isWidget()&&r.widget.ignoreEvent(e)){t||(this.selectionChanged=!1);return}(M.ie&&M.ie_version<=11||M.android&&M.chrome)&&!i.state.selection.main.empty&&s.focusNode&&zi(s.focusNode,s.focusOffset,s.anchorNode,s.anchorOffset)?this.flushSoon():this.flush(!1)}readSelectionRange(){let{view:e}=this,t=Ji(e.root);if(!t)return!1;let i=M.safari&&e.root.nodeType==11&&e.root.activeElement==this.dom&&gm(this.view,t)||t;if(!i||this.selectionRange.eq(i))return!1;let s=Wi(this.dom,i);return s&&!this.selectionChanged&&e.inputState.lastFocusTime>Date.now()-200&&e.inputState.lastTouchTime<Date.now()-300&&cp(this.dom,i)?(this.view.inputState.lastFocusTime=0,e.docView.updateSelection(),!1):(this.selectionRange.setRange(i),s&&(this.selectionChanged=!0),!0)}setSelectionRange(e,t){this.selectionRange.set(e.node,e.offset,t.node,t.offset),this.selectionChanged=!1}clearSelectionRange(){this.selectionRange.set(null,0,null,0)}listenForScroll(){this.parentCheck=-1;let e=0,t=null;for(let i=this.dom;i;)if(se(i))!t&&e<this.scrollTargets.length&&this.scrollTargets[e]==i?e++:t||(t=this.scrollTargets.slice(0,e)),t&&t.push(i),i=i.assignedSlot||i.parentNode;else if(i.nodeType==11)i=i.host;else break;if(e<this.scrollTargets.length&&!t&&(t=this.scrollTargets.slice(0,e)),t){for(let i of this.scrollTargets)i.removeEventListener("scroll",this.onScroll);for(let i of this.scrollTargets=t)i.addEventListener("scroll",this.onScroll)}}ignore(e){if(!this.active)return e();try{return this.stop(),e()}finally{this.start(),this.clear()}}start(){this.active||(this.observer.observe(this.dom,mm),$r&&this.dom.addEventListener("DOMCharacterDataModified",this.onCharData),this.active=!0)}stop(){this.active&&(this.active=!1,this.observer.disconnect(),$r&&this.dom.removeEventListener("DOMCharacterDataModified",this.onCharData))}clear(){this.processRecords(),this.queue.length=0,this.selectionChanged=!1}delayAndroidKey(e,t){var i;if(!this.delayedAndroidKey){let s=()=>{let r=this.delayedAndroidKey;r&&(this.clearDelayedAndroidKey(),this.view.inputState.lastKeyCode=r.keyCode,this.view.inputState.lastKeyTime=Date.now(),!this.flush()&&r.force&&fi(this.dom,r.key,r.keyCode))};this.flushingAndroidKey=this.view.win.requestAnimationFrame(s)}(!this.delayedAndroidKey||e=="Enter")&&(this.delayedAndroidKey={key:e,keyCode:t,force:this.lastChange<Date.now()-50||!!(!((i=this.delayedAndroidKey)===null||i===void 0)&&i.force)})}clearDelayedAndroidKey(){this.win.cancelAnimationFrame(this.flushingAndroidKey),this.delayedAndroidKey=null,this.flushingAndroidKey=-1}flushSoon(){this.delayedFlush<0&&(this.delayedFlush=this.view.win.requestAnimationFrame(()=>{this.delayedFlush=-1,this.flush()}))}forceFlush(){this.delayedFlush>=0&&(this.view.win.cancelAnimationFrame(this.delayedFlush),this.delayedFlush=-1),this.flush()}pendingRecords(){for(let e of this.observer.takeRecords())this.queue.push(e);return this.queue}processRecords(){let e=this.pendingRecords();e.length&&(this.queue=[]);let t=-1,i=-1,s=!1;for(let r of e){let o=this.readMutation(r);o&&(o.typeOver&&(s=!0),t==-1?{from:t,to:i}=o:(t=Math.min(o.from,t),i=Math.max(o.to,i)))}return{from:t,to:i,typeOver:s}}readChange(){let{from:e,to:t,typeOver:i}=this.processRecords(),s=this.selectionChanged&&Wi(this.dom,this.selectionRange);if(e<0&&!s)return null;e>-1&&(this.lastChange=Date.now()),this.view.inputState.lastFocusTime=0,this.selectionChanged=!1;let r=new yo(this.view,e,t,i);return this.view.docView.domChanged={newSel:r.newSel?r.newSel.main:null},r}flush(e=!0){if(this.delayedFlush>=0||this.delayedAndroidKey)return!1;e&&this.readSelectionRange();let t=this.selectionChanged,i=this.readChange();if(!i)return this.view.requestMeasure(),!1;let s=this.view.state,r=Pc(this.view,i);return this.view.state==s&&(i.domChanged||t)&&this.view.update([]),r}readMutation(e){let t=this.view.docView.tile.nearest(e.target);if(!t||t.isWidget())return null;if(t.markDirty(e.type=="attributes"),e.type=="childList"){let i=Fh(t,e.previousSibling||e.target.previousSibling,-1),s=Fh(t,e.nextSibling||e.target.nextSibling,1);return{from:i?t.posAfter(i):t.posAtStart,to:s?t.posBefore(s):t.posAtEnd,typeOver:!1}}else return e.type=="characterData"?{from:t.posAtStart,to:t.posAtEnd,typeOver:e.target.nodeValue==e.oldValue}:null}setWindow(e){e!=this.win&&(this.removeWindowListeners(this.win),this.win=e,this.addWindowListeners(this.win))}addWindowListeners(e){e.addEventListener("resize",this.onResize),this.printQuery?this.printQuery.addEventListener?this.printQuery.addEventListener("change",this.onPrint):this.printQuery.addListener(this.onPrint):e.addEventListener("beforeprint",this.onPrint),e.addEventListener("scroll",this.onScroll),e.document.addEventListener("selectionchange",this.onSelectionChange)}removeWindowListeners(e){e.removeEventListener("scroll",this.onScroll),e.removeEventListener("resize",this.onResize),this.printQuery?this.printQuery.removeEventListener?this.printQuery.removeEventListener("change",this.onPrint):this.printQuery.removeListener(this.onPrint):e.removeEventListener("beforeprint",this.onPrint),e.document.removeEventListener("selectionchange",this.onSelectionChange)}update(e){this.editContext&&(this.editContext.update(e),e.startState.facet(ht)!=e.state.facet(ht)&&(e.view.contentDOM.editContext=e.state.facet(ht)?this.editContext.editContext:null))}destroy(){var e,t,i;this.stop(),(e=this.intersection)===null||e===void 0||e.disconnect(),(t=this.gapIntersection)===null||t===void 0||t.disconnect(),(i=this.resizeScroll)===null||i===void 0||i.disconnect();for(let s of this.scrollTargets)s.removeEventListener("scroll",this.onScroll);this.removeWindowListeners(this.win),clearTimeout(this.parentCheck),clearTimeout(this.resizeTimeout),this.win.cancelAnimationFrame(this.delayedFlush),this.win.cancelAnimationFrame(this.flushingAndroidKey),this.editContext&&(this.view.contentDOM.editContext=null,this.editContext.destroy())}};function Fh(n,e,t){for(;e;){let i=J.get(e);if(i&&i.parent==n)return i;let s=e.parentNode;e=s!=n.dom?s:t>0?e.nextSibling:e.previousSibling}return null}function Hh(n,e){let t=e.startContainer,i=e.startOffset,s=e.endContainer,r=e.endOffset,o=n.docView.domAtPos(n.state.selection.main.anchor,1);return zi(o.node,o.offset,s,r)&&([t,i,s,r]=[s,r,t,i]),{anchorNode:t,anchorOffset:i,focusNode:s,focusOffset:r}}function gm(n,e){if(e.getComposedRanges){let s=e.getComposedRanges(n.root)[0];if(s)return Hh(n,s)}let t=null;function i(s){s.preventDefault(),s.stopImmediatePropagation(),t=s.getTargetRanges()[0]}return n.contentDOM.addEventListener("beforeinput",i,!0),n.dom.ownerDocument.execCommand("indent"),n.contentDOM.removeEventListener("beforeinput",i,!0),t?Hh(n,t):null}var Po=class{constructor(e){this.from=0,this.to=0,this.pendingContextChange=null,this.handlers=Object.create(null),this.composing=null,this.resetRange(e.state);let t=this.editContext=new window.EditContext({text:e.state.doc.sliceString(this.from,this.to),selectionStart:this.toContextPos(Math.max(this.from,Math.min(this.to,e.state.selection.main.anchor))),selectionEnd:this.toContextPos(e.state.selection.main.head)});this.handlers.textupdate=i=>{let s=e.state.selection.main,{anchor:r,head:o}=s,l=this.toEditorPos(i.updateRangeStart),a=this.toEditorPos(i.updateRangeEnd);e.inputState.composing>=0&&!this.composing&&(this.composing={contextBase:i.updateRangeStart,editorBase:l,drifted:!1});let h=a-l>i.text.length;l==this.from&&r<this.from?l=r:a==this.to&&r>this.to&&(a=r);let c=Ic(e.state.sliceDoc(l,a),i.text,(h?s.from:s.to)-l,h?"end":null);if(!c){let u=b.single(this.toEditorPos(i.selectionStart),this.toEditorPos(i.selectionEnd));bo(u,s)||e.dispatch({selection:u,userEvent:"select"});return}let f={from:c.from+l,to:c.toA+l,insert:N.of(i.text.slice(c.from,c.toB).split(`
`))};if((M.mac||M.android)&&f.from==o-1&&/^\. ?$/.test(i.text)&&e.contentDOM.getAttribute("autocorrect")=="off"&&(f={from:l,to:a,insert:N.of([i.text.replace("."," ")])}),this.pendingContextChange=f,!e.state.readOnly){let u=this.to-this.from+(f.to-f.from+f.insert.length);el(e,f,b.single(this.toEditorPos(i.selectionStart,u),this.toEditorPos(i.selectionEnd,u)))}this.pendingContextChange&&(this.revertPending(e.state),this.setSelection(e.state)),f.from<f.to&&!f.insert.length&&e.inputState.composing>=0&&!/[\\p{Alphabetic}\\p{Number}_]/.test(t.text.slice(Math.max(0,i.updateRangeStart-1),Math.min(t.text.length,i.updateRangeStart+1)))&&this.handlers.compositionend(i)},this.handlers.characterboundsupdate=i=>{let s=[],r=null;for(let o=this.toEditorPos(i.rangeStart),l=this.toEditorPos(i.rangeEnd);o<l;o++){let a=e.coordsForChar(o);r=a&&new DOMRect(a.left,a.top,a.right-a.left,a.bottom-a.top)||r||new DOMRect,s.push(r)}t.updateCharacterBounds(i.rangeStart,s)},this.handlers.textformatupdate=i=>{let s=[];for(let r of i.getTextFormats()){let o=r.underlineStyle,l=r.underlineThickness;if(!/none/i.test(o)&&!/none/i.test(l)){let a=this.toEditorPos(r.rangeStart),h=this.toEditorPos(r.rangeEnd);if(a<h){let c=`text-decoration: underline ${/^[a-z]/.test(o)?o+" ":o=="Dashed"?"dashed ":o=="Squiggle"?"wavy ":""}${/thin/i.test(l)?1:2}px`;s.push(B.mark({attributes:{style:c}}).range(a,h))}}}e.dispatch({effects:Cc.of(B.set(s))})},this.handlers.compositionstart=()=>{e.inputState.composing<0&&(e.inputState.composing=0,e.inputState.compositionFirstChange=!0)},this.handlers.compositionend=()=>{if(e.inputState.composing=-1,e.inputState.compositionFirstChange=null,this.composing){let{drifted:i}=this.composing;this.composing=null,i&&this.reset(e.state)}};for(let i in this.handlers)t.addEventListener(i,this.handlers[i]);this.measureReq={read:i=>{let s=Ji(i.root);s&&s.rangeCount&&this.editContext.updateSelectionBounds(s.getRangeAt(0).getBoundingClientRect())}}}applyEdits(e){let t=0,i=!1,s=this.pendingContextChange;return e.changes.iterChanges((r,o,l,a,h)=>{if(i)return;let c=h.length-(o-r);if(s&&o>=s.to)if(s.from==r&&s.to==o&&s.insert.eq(h)){s=this.pendingContextChange=null,t+=c,this.to+=c;return}else s=null,this.revertPending(e.state);if(r+=t,o+=t,o<=this.from)this.from+=c,this.to+=c;else if(r<this.to){if(r<this.from||o>this.to||this.to-this.from+h.length>3e4){i=!0;return}this.editContext.updateText(this.toContextPos(r),this.toContextPos(o),h.toString()),this.to+=c}t+=c}),s&&!i&&this.revertPending(e.state),!i}update(e){let t=this.pendingContextChange,i=e.startState.selection.main;this.composing&&(this.composing.drifted||!e.changes.touchesRange(i.from,i.to)&&e.transactions.some(s=>!s.isUserEvent("input.type")&&s.changes.touchesRange(this.from,this.to)))?(this.composing.drifted=!0,this.composing.editorBase=e.changes.mapPos(this.composing.editorBase)):!this.applyEdits(e)||!this.rangeIsValid(e.state)?(this.pendingContextChange=null,this.reset(e.state)):(e.docChanged||e.selectionSet||t)&&this.setSelection(e.state),(e.geometryChanged||e.docChanged||e.selectionSet)&&e.view.requestMeasure(this.measureReq)}resetRange(e){let{head:t}=e.selection.main;this.from=Math.max(0,t-1e4),this.to=Math.min(e.doc.length,t+1e4)}reset(e){this.resetRange(e),this.editContext.updateText(0,this.editContext.text.length,e.doc.sliceString(this.from,this.to)),this.setSelection(e)}revertPending(e){let t=this.pendingContextChange;this.pendingContextChange=null,this.editContext.updateText(this.toContextPos(t.from),this.toContextPos(t.from+t.insert.length),e.doc.sliceString(t.from,t.to))}setSelection(e){let{main:t}=e.selection,i=this.toContextPos(Math.max(this.from,Math.min(this.to,t.anchor))),s=this.toContextPos(t.head);(this.editContext.selectionStart!=i||this.editContext.selectionEnd!=s)&&this.editContext.updateSelection(i,s)}rangeIsValid(e){let{head:t}=e.selection.main;return!(this.from>0&&t-this.from<500||this.to<e.doc.length&&this.to-t<500||this.to-this.from>1e4*3)}toEditorPos(e,t=this.to-this.from){e=Math.min(e,t);let i=this.composing;return i&&i.drifted?i.editorBase+(e-i.contextBase):e+this.from}toContextPos(e){let t=this.composing;return t&&t.drifted?t.contextBase+(e-t.editorBase):e-this.from}destroy(){for(let e in this.handlers)this.editContext.removeEventListener(e,this.handlers[e])}},O=class n{get state(){return this.viewState.state}get viewport(){return this.viewState.viewport}get visibleRanges(){return this.viewState.visibleRanges}get inView(){return this.viewState.inView}get composing(){return!!this.inputState&&this.inputState.composing>0}get compositionStarted(){return!!this.inputState&&this.inputState.composing>=0}get root(){return this._root}get win(){return this.dom.ownerDocument.defaultView||window}constructor(e={}){var t;this.plugins=[],this.pluginMap=new Map,this.editorAttrs={},this.contentAttrs={},this.bidiCache=[],this.destroyed=!1,this.updateState=2,this.measureScheduled=-1,this.measureRequests=[],this.clearAnnouncement=-1,this.contentDOM=document.createElement("div"),this.scrollDOM=document.createElement("div"),this.scrollDOM.tabIndex=-1,this.scrollDOM.className="cm-scroller",this.scrollDOM.appendChild(this.contentDOM),this.announceDOM=document.createElement("div"),this.announceDOM.className="cm-announced",this.announceDOM.setAttribute("aria-live","polite"),this.dom=document.createElement("div"),this.dom.appendChild(this.announceDOM),this.dom.appendChild(this.scrollDOM),e.parent&&e.parent.appendChild(this.dom);let{dispatch:i}=e;this.dispatchTransactions=e.dispatchTransactions||i&&(s=>s.forEach(r=>i(r,this)))||(s=>this.update(s)),this.dispatch=this.dispatch.bind(this),this._root=e.root||hp(e.parent)||document,this.viewState=new as(this,e.state||U.create(e)),e.scrollTo&&e.scrollTo.is(Wn)&&(this.viewState.scrollTarget=e.scrollTo.value.clip(this.viewState.state)),this.plugins=this.state.facet(oi).map(s=>new Ki(s));for(let s of this.plugins)s.update(this);this.observer=new Ro(this),this.inputState=new xo(this),this.inputState.ensureHandlers(this.plugins),this.docView=new ss(this),this.mountStyles(),this.updateAttrs(),this.updateState=0,this.requestMeasure(),!((t=document.fonts)===null||t===void 0)&&t.ready&&document.fonts.ready.then(()=>{this.viewState.mustMeasureContent="refresh",this.requestMeasure()})}dispatch(...e){let t=e.length==1&&e[0]instanceof ne?e:e.length==1&&Array.isArray(e[0])?e[0]:[this.state.update(...e)];this.dispatchTransactions(t,this)}update(e){if(this.updateState!=0)throw new Error("Calls to EditorView.update are not allowed while an update is in progress");let t=!1,i=!1,s,r=this.state;for(let u of e){if(u.startState!=r)throw new RangeError("Trying to update state with a transaction that doesn't start from the previous state.");r=u.state}if(this.destroyed){this.viewState.state=r;return}let o=this.hasFocus,l=0,a=null;e.some(u=>u.annotation(zc))?(this.inputState.notifiedFocused=o,l=1):o!=this.inputState.notifiedFocused&&(this.inputState.notifiedFocused=o,a=qc(r,o),a||(l=1));let h=this.observer.delayedAndroidKey,c=null;if(h?(this.observer.clearDelayedAndroidKey(),c=this.observer.readChange(),(c&&!this.state.doc.eq(r.doc)||!this.state.selection.eq(r.selection))&&(c=null)):this.observer.clear(),r.facet(U.phrases)!=this.state.facet(U.phrases))return this.setState(r);s=is.create(this,r,e),s.flags|=l;let f=this.viewState.scrollTarget;try{this.updateState=2;for(let u of e){if(f&&(f=f.map(u.changes)),u.scrollIntoView){let{main:d}=u.state.selection,{x:p,y:m}=this.state.facet(n.cursorScrollMargin);f=new qi(d.empty?d:b.cursor(d.head,d.head>d.anchor?-1:1),"nearest","nearest",m,p)}for(let d of u.effects)d.is(Wn)&&(f=d.value.clip(this.state))}this.viewState.update(s,f),this.bidiCache=hs.update(this.bidiCache,s.changes),s.empty||(this.updatePlugins(s),this.inputState.update(s)),t=this.docView.update(s),this.state.facet(Ni)!=this.styleModules&&this.mountStyles(),i=this.updateAttrs(),this.showAnnouncements(e),this.docView.updateSelection(t,e.some(u=>u.isUserEvent("select.pointer")))}finally{this.updateState=0}if(s.startState.facet($n)!=s.state.facet($n)&&(this.viewState.mustMeasureContent=!0),(t||i||f||this.viewState.mustEnforceCursorAssoc||this.viewState.mustMeasureContent)&&this.requestMeasure(),t&&this.docViewUpdate(),!s.empty)for(let u of this.state.facet(no))try{u(s)}catch(d){ce(this.state,d,"update listener")}(a||c)&&Promise.resolve().then(()=>{a&&this.state==a.startState&&this.dispatch(a),c&&!Pc(this,c)&&h.force&&fi(this.contentDOM,h.key,h.keyCode)})}setState(e){if(this.updateState!=0)throw new Error("Calls to EditorView.setState are not allowed while an update is in progress");if(this.destroyed){this.viewState.state=e;return}this.updateState=2;let t=this.hasFocus;try{for(let i of this.plugins)i.destroy(this);this.viewState=new as(this,e),this.plugins=e.facet(oi).map(i=>new Ki(i)),this.pluginMap.clear();for(let i of this.plugins)i.update(this);this.docView.destroy(),this.docView=new ss(this),this.inputState.ensureHandlers(this.plugins),this.mountStyles(),this.updateAttrs(),this.bidiCache=[]}finally{this.updateState=0}t&&this.focus(),this.requestMeasure()}updatePlugins(e){let t=e.startState.facet(oi),i=e.state.facet(oi);if(t!=i){let s=[];for(let r of i){let o=t.indexOf(r);if(o<0)s.push(new Ki(r));else{let l=this.plugins[o];l.mustUpdate=e,s.push(l)}}for(let r of this.plugins)r.mustUpdate!=e&&r.destroy(this);this.plugins=s,this.pluginMap.clear()}else for(let s of this.plugins)s.mustUpdate=e;for(let s=0;s<this.plugins.length;s++)this.plugins[s].update(this);t!=i&&this.inputState.ensureHandlers(this.plugins)}docViewUpdate(){for(let e of this.plugins){let t=e.value;if(t&&t.docViewUpdate)try{t.docViewUpdate(this)}catch(i){ce(this.state,i,"doc view update listener")}}}measure(e=!0){if(this.destroyed)return;if(this.measureScheduled>-1&&this.win.cancelAnimationFrame(this.measureScheduled),this.observer.delayedAndroidKey){this.measureScheduled=-1,this.requestMeasure();return}this.measureScheduled=0,e&&this.observer.forceFlush();let t=null,i=this.viewState.scrollParent,s=this.viewState.getScrollOffset(),{scrollAnchorPos:r,scrollAnchorHeight:o,scaleY:l}=this.viewState;Math.abs(s-this.viewState.scrollOffset)>1&&(o=-1),this.viewState.scrollAnchorHeight=-1;try{for(let a=0;;a++){if(o<0){if(lc(i||this.win))r=-1,o=this.viewState.heightMap.height/this.viewState.scaleY;else{let p=this.viewState.scrollAnchorAt(s);r=p.from,o=p.top}l=this.viewState.scaleY}this.updateState=1;let h=this.viewState.measure();if(!h&&!this.measureRequests.length&&this.viewState.scrollTarget==null)break;if(a>5){console.warn(this.measureRequests.length?"Measure loop restarted more than 5 times":"Viewport failed to stabilize");break}let c=[];h&4||([this.measureRequests,c]=[c,this.measureRequests]);let f=c.map(p=>{try{return p.read(this)}catch(m){return ce(this.state,m),Wh}}),u=is.create(this,this.state,[]),d=!1;u.flags|=h,t?t.flags|=h:t=u,this.updateState=2,u.empty||(this.updatePlugins(u),this.inputState.update(u),this.updateAttrs(),d=this.docView.update(u),d&&this.docViewUpdate());for(let p=0;p<c.length;p++)if(f[p]!=Wh)try{let m=c[p];m.write&&m.write(f[p],this)}catch(m){ce(this.state,m)}if(d&&this.docView.updateSelection(!0),!u.viewportChanged&&this.measureRequests.length==0){if(this.viewState.editorHeight)if(this.viewState.scrollTarget){this.docView.scrollIntoView(this.viewState.scrollTarget),this.viewState.scrollTarget=null,o=-1;continue}else{let m=(r<0?this.viewState.heightMap.height:this.viewState.lineBlockAt(r).top)/this.viewState.scaleY-o/l;if((m>1||m<-1)&&!(M.ios&&this.inputState.lastIOSMomentumScroll>Date.now()-100)&&(i==this.scrollDOM||this.hasFocus||Math.max(this.inputState.lastWheelEvent,this.inputState.lastTouchTime)>Date.now()-100)){s=s+m,i?r<0?i.scrollTop=i.scrollHeight:i.scrollTop+=m:this.win.scrollBy(0,m),o=-1;continue}}break}}}finally{this.updateState=0,this.measureScheduled=-1}if(t&&!t.empty)for(let a of this.state.facet(no))a(t)}get themeClasses(){return Lo+" "+(this.state.facet(Bo)?jc:$c)+" "+this.state.facet($n)}updateAttrs(){let e=Vh(this,Ac,{class:"cm-editor"+(this.hasFocus?" cm-focused ":" ")+this.themeClasses}),t={spellcheck:"false",autocorrect:"off",autocapitalize:"off",writingsuggestions:"false",translate:"no",contenteditable:this.state.facet(ht)?"true":"false",class:"cm-content",style:`${M.tabSize}: ${this.state.tabSize}`,role:"textbox","aria-multiline":"true"};this.state.readOnly&&(t["aria-readonly"]="true"),Vh(this,ys,t);let i=this.observer.ignore(()=>{let s=xh(this.contentDOM,this.contentAttrs,t),r=xh(this.dom,this.editorAttrs,e);return s||r});return this.editorAttrs=e,this.contentAttrs=t,i}showAnnouncements(e){let t=!0;for(let i of e)for(let s of i.effects)if(s.is(n.announce)){t&&(this.announceDOM.textContent="",this.win.clearTimeout(this.clearAnnouncement),this.clearAnnouncement=this.win.setTimeout(()=>{this.announceDOM.textContent="\xA0"},200),t=!1);let r=this.announceDOM.appendChild(document.createElement("div"));r.textContent=s.value}}mountStyles(){this.styleModules=this.state.facet(Ni);let e=this.state.facet(n.cspNonce);Fe.mount(this.root,this.styleModules.concat(pm).reverse(),e?{nonce:e}:void 0)}readMeasured(){if(this.updateState==2)throw new Error("Reading the editor layout isn't allowed during an update");this.updateState==0&&this.measureScheduled>-1&&this.measure(!1)}requestMeasure(e){if(this.measureScheduled<0&&(this.measureScheduled=this.win.requestAnimationFrame(()=>this.measure())),e){if(this.measureRequests.indexOf(e)>-1)return;if(e.key!=null){for(let t=0;t<this.measureRequests.length;t++)if(this.measureRequests[t].key===e.key){this.measureRequests[t]=e;return}}this.measureRequests.push(e)}}plugin(e){let t=this.pluginMap.get(e);return(t===void 0||t&&t.plugin!=e)&&this.pluginMap.set(e,t=this.plugins.find(i=>i.plugin==e)||null),t&&t.update(this).value}get documentTop(){return this.contentDOM.getBoundingClientRect().top+this.viewState.paddingTop}get documentPadding(){return{top:this.viewState.paddingTop,bottom:this.viewState.paddingBottom}}get scaleX(){return this.viewState.scaleX}get scaleY(){return this.viewState.scaleY}elementAtHeight(e){return this.readMeasured(),this.viewState.elementAtHeight(e)}lineBlockAtHeight(e){return this.readMeasured(),this.viewState.lineBlockAtHeight(e)}get viewportLineBlocks(){return this.viewState.viewportLines}lineBlockAt(e){return this.viewState.lineBlockAt(e)}get contentHeight(){return this.viewState.contentHeight}moveByChar(e,t,i){return Kr(this,e,Ah(this,e,t,i))}moveByGroup(e,t){return Kr(this,e,Ah(this,e,t,i=>Hp(this,e.head,i)))}visualLineSide(e,t){return t?b.cursor(e.to,1):b.cursor(e.from,-1)}moveToLineBoundary(e,t,i=!0){return Fp(this,e,t,i)}moveVertically(e,t,i){return Kr(this,e,Wp(this,e,t,i))}domAtPos(e,t=1){return this.docView.domAtPos(e,t)}posAtDOM(e,t=0){return this.docView.posFromDOM(e,t)}posAtCoords(e,t=!0){this.readMeasured();let i=po(this,e,t);return i&&i.pos}posAndSideAtCoords(e,t=!0){return this.readMeasured(),po(this,e,t)}coordsAtPos(e,t=1){this.readMeasured();let i=this.state.doc.lineAt(e),s=this.bidiSpans(i),r=s[Ve.find(s,e-i.from,-1,t)];return i.length&&(e==i.from&&t<0||e==i.to&&t>0)&&r.dir!=this.textDirectionAt(i.from)&&(e==i.to?(e=i.from+r.from,t=1):(e=i.from+r.to,t=-1)),this.docView.coordsAt(e,t,r.dir==z.RTL)}coordsForChar(e){return this.readMeasured(),this.docView.coordsForChar(e)}get defaultCharacterWidth(){return this.viewState.heightOracle.charWidth}get defaultLineHeight(){return this.viewState.heightOracle.lineHeight}get textDirection(){return this.viewState.defaultTextDirection}textDirectionAt(e){return!this.state.facet(vc)||e<this.viewport.from||e>this.viewport.to?this.textDirection:(this.readMeasured(),this.docView.textDirectionAt(e))}get lineWrapping(){return this.viewState.heightOracle.lineWrapping}bidiSpans(e){if(e.length>ym)return dc(e.length);let t=this.textDirectionAt(e.from),i;for(let r of this.bidiCache)if(r.from==e.from&&r.dir==t&&(r.fresh||uc(r.isolates,i=kh(this,e))))return r.order;i||(i=kh(this,e));let s=yp(e.text,t,i);return this.bidiCache.push(new hs(e.from,e.to,t,i,!0,s)),s}get hasFocus(){var e;return(this.dom.ownerDocument.hasFocus()||M.safari&&((e=this.inputState)===null||e===void 0?void 0:e.lastContextMenu)>Date.now()-3e4)&&this.root.activeElement==this.contentDOM}focus(){this.observer.ignore(()=>{oc(this.contentDOM),this.docView.updateSelection()})}setRoot(e){this._root!=e&&(this._root=e,this.observer.setWindow((e.nodeType==9?e:e.ownerDocument).defaultView||window),this.mountStyles())}destroy(){this.root.activeElement==this.contentDOM&&this.contentDOM.blur();for(let e of this.plugins)e.destroy(this);this.plugins=[],this.inputState.destroy(),this.docView.destroy(),this.dom.remove(),this.observer.destroy(),this.win.clearTimeout(this.clearAnnouncement),this.measureScheduled>-1&&this.win.cancelAnimationFrame(this.measureScheduled),this.destroyed=!0}static scrollIntoView(e,t={}){var i,s,r,o;return Wn.of(new qi(typeof e=="number"?b.cursor(e):e,(i=t.y)!==null&&i!==void 0?i:"nearest",(s=t.x)!==null&&s!==void 0?s:"nearest",(r=t.yMargin)!==null&&r!==void 0?r:5,(o=t.xMargin)!==null&&o!==void 0?o:5))}scrollSnapshot(){let{scrollTop:e,scrollLeft:t}=this.scrollDOM,i=this.viewState.scrollAnchorAt(e);return Wn.of(new qi(b.cursor(i.from),"start","start",i.top-e,t,!0))}setTabFocusMode(e){e==null?this.inputState.tabFocusMode=this.inputState.tabFocusMode<0?0:-1:typeof e=="boolean"?this.inputState.tabFocusMode=e?0:-1:this.inputState.tabFocusMode!=0&&(this.inputState.tabFocusMode=Date.now()+e)}static domEventHandlers(e){return K.define(()=>({}),{eventHandlers:e})}static domEventObservers(e){return K.define(()=>({}),{eventObservers:e})}static theme(e,t){let i=Fe.newName(),s=[$n.of(i),Ni.of(Eo(`.${i}`,e))];return t&&t.dark&&s.push(Bo.of(!0)),s}static baseTheme(e){return Se.lowest(Ni.of(Eo("."+Lo,e,Uc)))}static findFromDOM(e){var t;let i=e.querySelector(".cm-content"),s=i&&J.get(i)||J.get(e);return((t=s?.root)===null||t===void 0?void 0:t.view)||null}};O.styleModule=Ni;O.inputHandler=xc;O.clipboardInputFilter=Xo;O.clipboardOutputFilter=Jo;O.scrollHandler=Sc;O.focusChangeEffect=wc;O.perLineTextDirection=vc;O.exceptionSink=bc;O.updateListener=no;O.editable=ht;O.mouseSelectionStyle=yc;O.dragMovesSelection=gc;O.clickAddsSelectionRange=mc;O.decorations=bs;O.blockWrappers=Mc;O.outerDecorations=Qo;O.atomicRanges=en;O.bidiIsolatedRanges=Tc;O.cursorScrollMargin=C.define({combine:n=>{let e=5,t=5;for(let i of n)typeof i=="number"?e=t=i:{x:e,y:t}=i;return{x:e,y:t}}});O.scrollMargins=Oc;O.darkTheme=Bo;O.cspNonce=C.define({combine:n=>n.length?n[0]:""});O.contentAttributes=ys;O.editorAttributes=Ac;O.lineWrapping=O.contentAttributes.of({class:"cm-lineWrapping"});O.announce=L.define();var ym=4096,Wh={},hs=class n{constructor(e,t,i,s,r,o){this.from=e,this.to=t,this.dir=i,this.isolates=s,this.fresh=r,this.order=o}static update(e,t){if(t.empty&&!e.some(r=>r.fresh))return e;let i=[],s=e.length?e[e.length-1].dir:z.LTR;for(let r=Math.max(0,e.length-10);r<e.length;r++){let o=e[r];o.dir==s&&!t.touchesRange(o.from,o.to)&&i.push(new n(t.mapPos(o.from,1),t.mapPos(o.to,-1),o.dir,o.isolates,!1,o.order))}return i}};function Vh(n,e,t){for(let i=n.state.facet(e),s=i.length-1;s>=0;s--){let r=i[s],o=typeof r=="function"?r(n):r;o&&Go(o,t)}return t}var bm=M.mac?"mac":M.windows?"win":M.linux?"linux":"key";function xm(n,e){let t=n.split(/-(?!$)/),i=t[t.length-1];i=="Space"&&(i=" ");let s,r,o,l;for(let a=0;a<t.length-1;++a){let h=t[a];if(/^(cmd|meta|m)$/i.test(h))l=!0;else if(/^a(lt)?$/i.test(h))s=!0;else if(/^(c|ctrl|control)$/i.test(h))r=!0;else if(/^s(hift)?$/i.test(h))o=!0;else if(/^mod$/i.test(h))e=="mac"?l=!0:r=!0;else throw new Error("Unrecognized modifier name: "+h)}return s&&(i="Alt-"+i),r&&(i="Ctrl-"+i),l&&(i="Meta-"+i),o&&(i="Shift-"+i),i}function jn(n,e,t){return e.altKey&&(n="Alt-"+n),e.ctrlKey&&(n="Ctrl-"+n),e.metaKey&&(n="Meta-"+n),t!==!1&&e.shiftKey&&(n="Shift-"+n),n}var wm=Se.default(O.domEventHandlers({keydown(n,e){return Yc(Gc(e.state),n,e,"editor")}})),wi=C.define({enables:wm}),zh=new WeakMap;function Gc(n){let e=n.facet(wi),t=zh.get(e);return t||zh.set(e,t=km(e.reduce((i,s)=>i.concat(s),[]))),t}function _c(n,e,t){return Yc(Gc(n.state),e,n,t)}var pt=null,vm=4e3;function km(n,e=bm){let t=Object.create(null),i=Object.create(null),s=(o,l)=>{let a=i[o];if(a==null)i[o]=l;else if(a!=l)throw new Error("Key binding "+o+" is used both as a regular binding and as a multi-stroke prefix")},r=(o,l,a,h,c)=>{var f,u;let d=t[o]||(t[o]=Object.create(null)),p=l.split(/ (?!$)/).map(y=>xm(y,e));for(let y=1;y<p.length;y++){let v=p.slice(0,y).join(" ");s(v,!0),d[v]||(d[v]={preventDefault:!0,stopPropagation:!1,run:[x=>{let D=pt={view:x,prefix:v,scope:o};return setTimeout(()=>{pt==D&&(pt=null)},vm),!0}]})}let m=p.join(" ");s(m,!1);let g=d[m]||(d[m]={preventDefault:!1,stopPropagation:!1,run:((u=(f=d._any)===null||f===void 0?void 0:f.run)===null||u===void 0?void 0:u.slice())||[]});a&&g.run.push(a),h&&(g.preventDefault=!0),c&&(g.stopPropagation=!0)};for(let o of n){let l=o.scope?o.scope.split(" "):["editor"];if(o.any)for(let h of l){let c=t[h]||(t[h]=Object.create(null));c._any||(c._any={preventDefault:!1,stopPropagation:!1,run:[]});let{any:f}=o;for(let u in c)c[u].run.push(d=>f(d,Io))}let a=o[e]||o.key;if(a)for(let h of l)r(h,a,o.run,o.preventDefault,o.stopPropagation),o.shift&&r(h,"Shift-"+a,o.shift,o.preventDefault,o.stopPropagation)}return t}var Io=null;function Yc(n,e,t,i){Io=e;let s=ph(e),r=he(s,0),o=Be(r)==s.length&&s!=" ",l="",a=!1,h=!1,c=!1;pt&&pt.view==t&&pt.scope==i&&(l=pt.prefix+" ",Fc.indexOf(e.keyCode)<0&&(h=!0,pt=null));let f=new Set,u=g=>{if(g){for(let y of g.run)if(!f.has(y)&&(f.add(y),y(t)))return g.stopPropagation&&(c=!0),!0;g.preventDefault&&(g.stopPropagation&&(c=!0),h=!0)}return!1},d=n[i],p,m;return d&&(u(d[l+jn(s,e,!o)])?a=!0:o&&(e.altKey||e.metaKey||e.ctrlKey)&&!(M.windows&&e.ctrlKey&&e.altKey)&&!(M.mac&&e.altKey&&!(e.ctrlKey||e.metaKey))&&(p=at[e.keyCode])&&p!=s?(u(d[l+jn(p,e,!0)])||e.shiftKey&&(m=si[e.keyCode])!=s&&m!=p&&u(d[l+jn(m,e,!1)]))&&(a=!0):o&&e.shiftKey&&u(d[l+jn(s,e,!0)])&&(a=!0),!a&&u(d._any)&&(a=!0)),h&&(a=!0),a&&c&&e.stopPropagation(),Io=null,a}var Nt=class n{constructor(e,t,i,s,r){this.className=e,this.left=t,this.top=i,this.width=s,this.height=r}draw(){let e=document.createElement("div");return e.className=this.className,this.adjust(e),e}update(e,t){return t.className!=this.className?!1:(this.adjust(e),!0)}adjust(e){e.style.left=this.left+"px",e.style.top=this.top+"px",this.width!=null&&(e.style.width=this.width+"px"),e.style.height=this.height+"px"}eq(e){return this.left==e.left&&this.top==e.top&&this.width==e.width&&this.height==e.height&&this.className==e.className}static forRange(e,t,i){if(i.empty){let s=e.coordsAtPos(i.head,i.assoc||1);if(!s)return[];let r=Xc(e);return[new n(t,s.left-r.left,s.top-r.top,null,s.bottom-s.top)]}else return Sm(e,t,i)}};function Xc(n){let e=n.scrollDOM.getBoundingClientRect();return{left:(n.textDirection==z.LTR?e.left:e.right-n.scrollDOM.clientWidth*n.scaleX)-n.scrollDOM.scrollLeft*n.scaleX,top:e.top-n.scrollDOM.scrollTop*n.scaleY}}function qh(n,e,t,i){let s=n.coordsAtPos(e,t*2);if(!s)return i;let r=n.dom.getBoundingClientRect(),o=(s.top+s.bottom)/2,l=n.posAtCoords({x:r.left+1,y:o}),a=n.posAtCoords({x:r.right-1,y:o});return l==null||a==null?i:{from:Math.max(i.from,Math.min(l,a)),to:Math.min(i.to,Math.max(l,a))}}function Sm(n,e,t){if(t.to<=n.viewport.from||t.from>=n.viewport.to)return[];let i=Math.max(t.from,n.viewport.from),s=Math.min(t.to,n.viewport.to),r=n.textDirection==z.LTR,o=n.contentDOM,l=o.getBoundingClientRect(),a=Xc(n),h=o.querySelector(".cm-line"),c=h&&window.getComputedStyle(h),f=l.left+(c?parseInt(c.paddingLeft)+Math.min(0,parseInt(c.textIndent)):0),u=l.right-(c?parseInt(c.paddingRight):0),d=uo(n,i,1),p=uo(n,s,-1),m=d.type==fe.Text?d:null,g=p.type==fe.Text?p:null;if(m&&(n.lineWrapping||d.widgetLineBreaks)&&(m=qh(n,i,1,m)),g&&(n.lineWrapping||p.widgetLineBreaks)&&(g=qh(n,s,-1,g)),m&&g&&m.from==g.from&&m.to==g.to)return v(x(t.from,t.to,m));{let w=m?x(t.from,null,m):D(d,!1),k=g?x(null,t.to,g):D(p,!0),S=[];return(m||d).to<(g||p).from-(m&&g?1:0)||d.widgetLineBreaks>1&&w.bottom+n.defaultLineHeight/2<k.top?S.push(y(f,w.bottom,u,k.top)):w.bottom<k.top&&n.elementAtHeight((w.bottom+k.top)/2).type==fe.Text&&(w.bottom=k.top=(w.bottom+k.top)/2),v(w).concat(S).concat(v(k))}function y(w,k,S,R){return new Nt(e,w-a.left,k-a.top,Math.max(0,S-w),R-k)}function v({top:w,bottom:k,horizontal:S}){let R=[];for(let F=0;F<S.length;F+=2)R.push(y(S[F],w,S[F+1],k));return R}function x(w,k,S){let R=1e9,F=-1e9,j=[];function I(V,X,ue,De,Xe){let ae=n.coordsAtPos(V,V==S.to?-2:2),Ie=n.coordsAtPos(ue,ue==S.from?2:-2);!ae||!Ie||(R=Math.min(ae.top,Ie.top,R),F=Math.max(ae.bottom,Ie.bottom,F),Xe==z.LTR?j.push(r&&X?f:ae.left,r&&De?u:Ie.right):j.push(!r&&De?f:Ie.left,!r&&X?u:ae.right))}let E=w??S.from,q=k??S.to;for(let V of n.visibleRanges)if(V.to>E&&V.from<q)for(let X=Math.max(V.from,E),ue=Math.min(V.to,q);;){let De=n.state.doc.lineAt(X);for(let Xe of n.bidiSpans(De)){let ae=Xe.from+De.from,Ie=Xe.to+De.from;if(ae>=ue)break;Ie>X&&I(Math.max(ae,X),w==null&&ae<=E,Math.min(Ie,ue),k==null&&Ie>=q,Xe.dir)}if(X=De.to+1,X>=ue)break}return j.length==0&&I(E,w==null,q,k==null,n.textDirection),{top:R,bottom:F,horizontal:j}}function D(w,k){let S=l.top+(k?w.top:w.bottom);return{top:S,bottom:S,horizontal:[]}}}function Cm(n,e){return n.constructor==e.constructor&&n.eq(e)}var No=class{constructor(e,t){this.view=e,this.layer=t,this.drawn=[],this.scaleX=1,this.scaleY=1,this.measureReq={read:this.measure.bind(this),write:this.draw.bind(this)},this.dom=e.scrollDOM.appendChild(document.createElement("div")),this.dom.classList.add("cm-layer"),t.above&&this.dom.classList.add("cm-layer-above"),t.class&&this.dom.classList.add(t.class),this.scale(),this.dom.setAttribute("aria-hidden","true"),this.setOrder(e.state),e.requestMeasure(this.measureReq),t.mount&&t.mount(this.dom,e)}update(e){e.startState.facet(Yn)!=e.state.facet(Yn)&&this.setOrder(e.state),(this.layer.update(e,this.dom)||e.geometryChanged)&&(this.scale(),e.view.requestMeasure(this.measureReq))}docViewUpdate(e){this.layer.updateOnDocViewUpdate!==!1&&e.requestMeasure(this.measureReq)}setOrder(e){let t=0,i=e.facet(Yn);for(;t<i.length&&i[t]!=this.layer;)t++;this.dom.style.zIndex=String((this.layer.above?150:-1)-t)}measure(){return this.layer.markers(this.view)}scale(){let{scaleX:e,scaleY:t}=this.view;(e!=this.scaleX||t!=this.scaleY)&&(this.scaleX=e,this.scaleY=t,this.dom.style.transform=`scale(${1/e}, ${1/t})`)}draw(e){if(e.length!=this.drawn.length||e.some((t,i)=>!Cm(t,this.drawn[i]))){let t=this.dom.firstChild,i=0;for(let s of e)s.update&&t&&s.constructor&&this.drawn[i].constructor&&s.update(t,this.drawn[i])?(t=t.nextSibling,i++):this.dom.insertBefore(s.draw(),t);for(;t;){let s=t.nextSibling;t.remove(),t=s}this.drawn=e,M.webkit&&(this.dom.style.display=this.dom.firstChild?"":"none")}}destroy(){this.layer.destroy&&this.layer.destroy(this.dom,this.view),this.dom.remove()}},Yn=C.define();function Jc(n){return[K.define(e=>new No(e,n)),Yn.of(n)]}var Fo=!M.ios,xi=C.define({combine(n){return me(n,{cursorBlinkRate:1200,drawRangeCursor:!0,iosSelectionHandles:!0},{cursorBlinkRate:(e,t)=>Math.min(e,t),drawRangeCursor:(e,t)=>e||t})}});function Qc(n={}){return[xi.of(n),Am,Mm,Dm,kc.of(!0)]}function Zc(n){return n.startState.facet(xi)!=n.state.facet(xi)}var Am=Jc({above:!0,markers(n){let{state:e}=n,t=e.facet(xi),i=[];for(let s of e.selection.ranges){let r=s==e.selection.main;if(s.empty||t.drawRangeCursor&&!(r&&M.ios&&t.iosSelectionHandles)){let o=r?"cm-cursor cm-cursor-primary":"cm-cursor cm-cursor-secondary",l=s.empty?s:b.cursor(s.head,s.assoc);for(let a of Nt.forRange(n,o,l))i.push(a)}}return i},update(n,e){n.transactions.some(i=>i.selection)&&(e.style.animationName=e.style.animationName=="cm-blink"?"cm-blink2":"cm-blink");let t=Zc(n);return t&&Kh(n.state,e),n.docChanged||n.selectionSet||t},mount(n,e){Kh(e.state,n)},class:"cm-cursorLayer"});function Kh(n,e){e.style.animationDuration=n.facet(xi).cursorBlinkRate+"ms"}var Mm=Jc({above:!1,markers(n){let e=[],{main:t,ranges:i}=n.state.selection;for(let s of i)if(!s.empty&&(Fo||s!=t))for(let r of Nt.forRange(n,"cm-selectionBackground",s))e.push(r);if(M.ios&&!t.empty&&n.state.facet(xi).iosSelectionHandles){for(let s of Nt.forRange(n,"cm-selectionHandle cm-selectionHandle-start",b.cursor(t.from,1)))e.push(s);for(let s of Nt.forRange(n,"cm-selectionHandle cm-selectionHandle-end",b.cursor(t.to,1)))e.push(s)}return e},update(n,e){return n.docChanged||n.selectionSet||n.viewportChanged||Zc(n)},class:"cm-selectionLayer"}),Tm=M.gecko&&M.gecko_version==153?"#ffffff01":"transparent",Dm=Se.highest(O.theme({".cm-line":{...Fo?{"& ::selection, &::selection":{backgroundColor:`${Tm} !important`}}:{},caretColor:"transparent !important"},".cm-content":{caretColor:"transparent !important","& :focus":{caretColor:"initial !important",...Fo?{"&::selection, & ::selection":{backgroundColor:"Highlight !important"}}:{}}}})),ef=L.define({map(n,e){return n==null?null:e.mapPos(n)}}),Hi=_.define({create(){return null},update(n,e){return n!=null&&(n=e.changes.mapPos(n)),e.effects.reduce((t,i)=>i.is(ef)?i.value:t,n)}}),Om=K.fromClass(class{constructor(n){this.view=n,this.cursor=null,this.measureReq={read:this.readPos.bind(this),write:this.drawCursor.bind(this)}}update(n){var e;let t=n.state.field(Hi);t==null?this.cursor!=null&&((e=this.cursor)===null||e===void 0||e.remove(),this.cursor=null):(this.cursor||(this.cursor=this.view.scrollDOM.appendChild(document.createElement("div")),this.cursor.className="cm-dropCursor"),(n.startState.field(Hi)!=t||n.docChanged||n.geometryChanged)&&this.view.requestMeasure(this.measureReq))}readPos(){let{view:n}=this,e=n.state.field(Hi),t=e!=null&&n.coordsAtPos(e);if(!t)return null;let i=n.scrollDOM.getBoundingClientRect();return{left:t.left-i.left+n.scrollDOM.scrollLeft*n.scaleX,top:t.top-i.top+n.scrollDOM.scrollTop*n.scaleY,height:t.bottom-t.top}}drawCursor(n){if(this.cursor){let{scaleX:e,scaleY:t}=this.view;n?(this.cursor.style.left=n.left/e+"px",this.cursor.style.top=n.top/t+"px",this.cursor.style.height=n.height/t+"px"):this.cursor.style.left="-100000px"}}destroy(){this.cursor&&this.cursor.remove()}setDropPos(n){this.view.state.field(Hi)!=n&&this.view.dispatch({effects:ef.of(n)})}},{eventObservers:{dragover(n){this.setDropPos(this.view.posAtCoords({x:n.clientX,y:n.clientY}))},dragleave(n){(n.target==this.view.contentDOM||!this.view.contentDOM.contains(n.relatedTarget))&&this.setDropPos(null)},dragend(){this.setDropPos(null)},drop(){this.setDropPos(null)}}});function tf(){return[Hi,Om]}function $h(n,e,t,i,s){e.lastIndex=0;for(let r=n.iterRange(t,i),o=t,l;!r.next().done;o+=r.value.length)if(!r.lineBreak)for(;l=e.exec(r.value);)s(o+l.index,l)}function Bm(n,e){let t=n.visibleRanges;if(t.length==1&&t[0].from==n.viewport.from&&t[0].to==n.viewport.to)return t;let i=[];for(let{from:s,to:r}of t)s=Math.max(n.state.doc.lineAt(s).from,s-e),r=Math.min(n.state.doc.lineAt(r).to,r+e),i.length&&i[i.length-1].to>=s?i[i.length-1].to=r:i.push({from:s,to:r});return i}var cs=class{constructor(e){let{regexp:t,decoration:i,decorate:s,boundary:r,maxLength:o=1e3}=e;if(!t.global)throw new RangeError("The regular expression given to MatchDecorator should have its 'g' flag set");if(this.regexp=t,s)this.addMatch=(l,a,h,c)=>s(c,h,h+l[0].length,l,a);else if(typeof i=="function")this.addMatch=(l,a,h,c)=>{let f=i(l,a,h);f&&c(h,h+l[0].length,f)};else if(i)this.addMatch=(l,a,h,c)=>c(h,h+l[0].length,i);else throw new RangeError("Either 'decorate' or 'decoration' should be provided to MatchDecorator");this.boundary=r,this.maxLength=o}createDeco(e){let t=new pe,i=t.add.bind(t);for(let{from:s,to:r}of Bm(e,this.maxLength))$h(e.state.doc,this.regexp,s,r,(o,l)=>this.addMatch(l,e,o,i));return t.finish()}updateDeco(e,t){let i=1e9,s=-1;return e.docChanged&&e.changes.iterChanges((r,o,l,a)=>{a>=e.view.viewport.from&&l<=e.view.viewport.to&&(i=Math.min(l,i),s=Math.max(a,s))}),e.viewportMoved||s-i>1e3?this.createDeco(e.view):s>-1?this.updateRange(e.view,t.map(e.changes),i,s):t}updateRange(e,t,i,s){for(let r of e.visibleRanges){let o=Math.max(r.from,i),l=Math.min(r.to,s);if(l>=o){let a=e.state.doc.lineAt(o),h=a.to<l?e.state.doc.lineAt(l):a,c=Math.max(r.from,a.from),f=Math.min(r.to,h.to);if(this.boundary){for(;o>a.from;o--)if(this.boundary.test(a.text[o-1-a.from])){c=o;break}for(;l<h.to;l++)if(this.boundary.test(h.text[l-h.from])){f=l;break}}let u=[],d,p=(m,g,y)=>u.push(y.range(m,g));if(a==h)for(this.regexp.lastIndex=c-a.from;(d=this.regexp.exec(a.text))&&d.index<f-a.from;)this.addMatch(d,e,d.index+a.from,p);else $h(e.state.doc,this.regexp,c,f,(m,g)=>this.addMatch(g,e,m,p));t=t.update({filterFrom:c,filterTo:f,filter:(m,g)=>m<c||g>f,add:u})}}return t}},Ho=/x/.unicode!=null?"gu":"g",Lm=new RegExp(`[\0-\b
-\x7F-\x9F\xAD\u061C\u200B\u200E\u200F\u2028\u2029\u202D\u202E\u2066\u2067\u2069\uFEFF\uFFF9-\uFFFC]`,Ho),Em={0:"null",7:"bell",8:"backspace",10:"newline",11:"vertical tab",13:"carriage return",27:"escape",8203:"zero width space",8204:"zero width non-joiner",8205:"zero width joiner",8206:"left-to-right mark",8207:"right-to-left mark",8232:"line separator",8237:"left-to-right override",8238:"right-to-left override",8294:"left-to-right isolate",8295:"right-to-left isolate",8297:"pop directional isolate",8233:"paragraph separator",65279:"zero width no-break space",65532:"object replacement"},jr=null;function Rm(){var n;if(jr==null&&typeof document<"u"&&document.body){let e=document.body.style;jr=((n=e.tabSize)!==null&&n!==void 0?n:e.MozTabSize)!=null}return jr||!1}var Xn=C.define({combine(n){let e=me(n,{render:null,specialChars:Lm,addSpecialChars:null});return(e.replaceTabs=!Rm())&&(e.specialChars=new RegExp("	|"+e.specialChars.source,Ho)),e.addSpecialChars&&(e.specialChars=new RegExp(e.specialChars.source+"|"+e.addSpecialChars.source,Ho)),e}});function nf(n={}){return[Xn.of(n),Pm()]}var jh=null;function Pm(){return jh||(jh=K.fromClass(class{constructor(n){this.view=n,this.decorations=B.none,this.decorationCache=Object.create(null),this.decorator=this.makeDecorator(n.state.facet(Xn)),this.decorations=this.decorator.createDeco(n)}makeDecorator(n){return new cs({regexp:n.specialChars,decoration:(e,t,i)=>{let{doc:s}=t.state,r=he(e[0],0);if(r==9){let o=s.lineAt(i),l=t.state.tabSize,a=lt(o.text,l,i-o.from);return B.replace({widget:new Vo((l-a%l)*this.view.defaultCharacterWidth/this.view.scaleX)})}return this.decorationCache[r]||(this.decorationCache[r]=B.replace({widget:new Wo(n,r)}))},boundary:n.replaceTabs?void 0:/[^]/})}update(n){let e=n.state.facet(Xn);n.startState.facet(Xn)!=e?(this.decorator=this.makeDecorator(e),this.decorations=this.decorator.createDeco(n.view)):this.decorations=this.decorator.updateDeco(n,this.decorations)}},{decorations:n=>n.decorations}))}var Im="\u2022";function Nm(n){return n>=32?Im:n==10?"\u2424":String.fromCharCode(9216+n)}var Wo=class extends re{constructor(e,t){super(),this.options=e,this.code=t}eq(e){return e.code==this.code}toDOM(e){let t=Nm(this.code),i=e.state.phrase("Control character")+" "+(Em[this.code]||"0x"+this.code.toString(16)),s=this.options.render&&this.options.render(this.code,i,t);if(s)return s;let r=document.createElement("span");return r.textContent=t,r.title=i,r.setAttribute("aria-label",i),r.className="cm-specialChar",r}ignoreEvent(){return!1}},Vo=class extends re{constructor(e){super(),this.width=e}eq(e){return e.width==this.width}toDOM(){let e=document.createElement("span");return e.textContent="	",e.className="cm-tab",e.style.width=this.width+"px",e}ignoreEvent(){return!1}},Uh=K.fromClass(class{constructor(){this.height=1e3,this.attrs={style:"padding-bottom: 1000px"}}update(n){let{view:e}=n,t=e.viewState.editorHeight-e.defaultLineHeight-e.documentPadding.top-.5;t>=0&&t!=this.height&&(this.height=t,this.attrs={style:`padding-bottom: ${t}px`})}});function sf(){return[Uh,ys.of(n=>{var e;return((e=n.plugin(Uh))===null||e===void 0?void 0:e.attrs)||null})]}function rf(){return Hm}var Fm=B.line({class:"cm-activeLine"}),Hm=K.fromClass(class{constructor(n){this.decorations=this.getDeco(n)}update(n){(n.docChanged||n.selectionSet)&&(this.decorations=this.getDeco(n.view))}getDeco(n){let e=-1,t=[];for(let i of n.state.selection.ranges){let s=n.lineBlockAt(i.head);s.from>e&&(t.push(Fm.range(s.from)),e=s.from)}return B.set(t)}},{decorations:n=>n.decorations}),zo=class extends re{constructor(e){super(),this.content=e}toDOM(e){let t=document.createElement("span");return t.className="cm-placeholder",t.style.pointerEvents="none",t.appendChild(typeof this.content=="string"?document.createTextNode(this.content):typeof this.content=="function"?this.content(e):this.content.cloneNode(!0)),t.setAttribute("aria-hidden","true"),t}coordsAt(e){let t=e.firstChild?Vi(e.firstChild):[];if(!t.length)return null;let i=window.getComputedStyle(e.parentNode),s=Qi(t[0],i.direction!="rtl"),r=parseInt(i.lineHeight);return s.bottom-s.top>r*1.5?{left:s.left,right:s.right,top:s.top,bottom:s.top+r}:s}ignoreEvent(){return!1}};function of(n){let e=K.fromClass(class{constructor(t){this.view=t,this.placeholder=n?B.set([B.widget({widget:new zo(n),side:1}).range(0)]):B.none}get decorations(){return this.view.state.doc.length?B.none:this.placeholder}},{decorations:t=>t.decorations});return typeof n=="string"?[e,O.contentAttributes.of({"aria-placeholder":n})]:e}var qo=2e3;function Wm(n,e,t){let i=Math.min(e.line,t.line),s=Math.max(e.line,t.line),r=[];if(e.off>qo||t.off>qo||e.col<0||t.col<0){let o=Math.min(e.off,t.off),l=Math.max(e.off,t.off);for(let a=i;a<=s;a++){let h=n.doc.line(a);h.length<=l&&r.push(b.range(h.from+o,h.to+l))}}else{let o=Math.min(e.col,t.col),l=Math.max(e.col,t.col);for(let a=i;a<=s;a++){let h=n.doc.line(a),c=Fn(h.text,o,n.tabSize,!0);if(c<0)r.push(b.cursor(h.to));else{let f=Fn(h.text,l,n.tabSize);r.push(b.range(h.from+c,h.from+f))}}}return r}function Vm(n,e){let t=n.coordsAtPos(n.viewport.from);return t?Math.round(Math.abs((t.left-e)/n.defaultCharacterWidth)):-1}function Gh(n,e){let t=n.posAtCoords({x:e.clientX,y:e.clientY},!1),i=n.state.doc.lineAt(t),s=t-i.from,r=s>qo?-1:s==i.length?Vm(n,e.clientX):lt(i.text,n.state.tabSize,t-i.from);return{line:i.number,col:r,off:s}}function zm(n,e){let t=Gh(n,e),i=n.state.selection;return t?{update(s){if(s.docChanged){let r=s.changes.mapPos(s.startState.doc.line(t.line).from),o=s.state.doc.lineAt(r);t={line:o.number,col:t.col,off:Math.min(t.off,o.length)},i=i.map(s.changes)}},get(s,r,o){let l=Gh(n,s);if(!l)return i;let a=Wm(n.state,t,l);return a.length?o?b.create(a.concat(i.ranges)):b.create(a):i}}:null}function lf(n){let e=n?.eventFilter||(t=>t.altKey&&t.button==0);return O.mouseSelectionStyle.of((t,i)=>e(i)?zm(t,i):null)}var qm={Alt:[18,n=>!!n.altKey],Control:[17,n=>!!n.ctrlKey],Shift:[16,n=>!!n.shiftKey],Meta:[91,n=>!!n.metaKey]},Km={style:"cursor: crosshair"};function af(n={}){let[e,t]=qm[n.key||"Alt"],i=K.fromClass(class{constructor(s){this.view=s,this.isDown=!1}set(s){this.isDown!=s&&(this.isDown=s,this.view.update([]))}},{eventObservers:{keydown(s){this.set(s.keyCode==e||t(s))},keyup(s){(s.keyCode==e||!t(s))&&this.set(!1)},mousemove(s){this.set(t(s))}}});return[i,O.contentAttributes.of(s=>{var r;return!((r=s.plugin(i))===null||r===void 0)&&r.isDown?Km:null})]}var Un="-10000px",fs=class{constructor(e,t,i,s){this.facet=t,this.createTooltipView=i,this.removeTooltipView=s,this.input=e.state.facet(t),this.tooltips=this.input.filter(o=>o);let r=null;this.tooltipViews=this.tooltips.map(o=>r=i(o,r))}update(e,t){var i;let s=e.state.facet(this.facet),r=s.filter(a=>a);if(s===this.input){for(let a of this.tooltipViews)a.update&&a.update(e);return!1}let o=[],l=t?[]:null;for(let a=0;a<r.length;a++){let h=r[a],c=-1;if(h){for(let f=0;f<this.tooltips.length;f++){let u=this.tooltips[f];u&&u.create==h.create&&(c=f)}if(c<0)o[a]=this.createTooltipView(h,a?o[a-1]:null),l&&(l[a]=!!h.above);else{let f=o[a]=this.tooltipViews[c];l&&(l[a]=t[c]),f.update&&f.update(e)}}}for(let a of this.tooltipViews)o.indexOf(a)<0&&(this.removeTooltipView(a),(i=a.destroy)===null||i===void 0||i.call(a));return t&&(l.forEach((a,h)=>t[h]=a),t.length=l.length),this.input=s,this.tooltips=r,this.tooltipViews=o,!0}};function hf(n){let e=n.dom.ownerDocument.documentElement,t=e.clientWidth,i=getComputedStyle(e);if(!/stable/.test(i.scrollbarGutter||""))return{left:0,right:t};let s=e.getBoundingClientRect(),r=n.win.scrollX;return{left:Math.max(0,s.left+r-parseFloat(i.marginLeft)),right:Math.min(t,s.right+r+parseFloat(i.marginRight))}}function $m(n){let{left:e,right:t}=hf(n);return{top:0,left:e,right:t,bottom:n.dom.ownerDocument.documentElement.clientHeight}}var Ur=C.define({combine:n=>{var e,t,i;return{position:M.ios?"absolute":((e=n.find(s=>s.position))===null||e===void 0?void 0:e.position)||"fixed",parent:((t=n.find(s=>s.parent))===null||t===void 0?void 0:t.parent)||null,tooltipSpace:((i=n.find(s=>s.tooltipSpace))===null||i===void 0?void 0:i.tooltipSpace)||$m}}}),_h=new WeakMap,tl=K.fromClass(class{constructor(n){this.view=n,this.above=[],this.inView=!0,this.madeAbsolute=!1,this.lastTransaction=0,this.measureTimeout=-1;let e=n.state.facet(Ur);this.position=e.position,this.parent=e.parent,this.classes=n.themeClasses,this.createContainer(),this.measureReq={read:this.readMeasure.bind(this),write:this.writeMeasure.bind(this),key:this},this.resizeObserver=typeof ResizeObserver=="function"?new ResizeObserver(()=>this.measureSoon()):null,this.manager=new fs(n,bt,(t,i)=>this.createTooltip(t,i),t=>{this.resizeObserver&&this.resizeObserver.unobserve(t.dom),t.dom.remove()}),this.above=this.manager.tooltips.map(t=>!!t.above),this.intersectionObserver=typeof IntersectionObserver=="function"?new IntersectionObserver(t=>{Date.now()>this.lastTransaction-50&&t.length>0&&t[t.length-1].intersectionRatio<1&&this.measureSoon()},{threshold:[1]}):null,this.observeIntersection(),n.win.addEventListener("resize",this.measureSoon=this.measureSoon.bind(this)),this.maybeMeasure()}createContainer(){this.parent?(this.container=document.createElement("div"),this.container.style.position="relative",this.container.className=this.view.themeClasses,this.parent.appendChild(this.container)):this.container=this.view.dom}observeIntersection(){if(this.intersectionObserver){this.intersectionObserver.disconnect();for(let n of this.manager.tooltipViews)this.intersectionObserver.observe(n.dom)}}measureSoon(){this.measureTimeout<0&&(this.measureTimeout=setTimeout(()=>{this.measureTimeout=-1,this.maybeMeasure()},50))}update(n){n.transactions.length&&(this.lastTransaction=Date.now());let e=this.manager.update(n,this.above);e&&this.observeIntersection();let t=e||n.geometryChanged,i=n.state.facet(Ur);if(i.position!=this.position&&!this.madeAbsolute){this.position=i.position;for(let s of this.manager.tooltipViews)s.dom.style.position=this.position;t=!0}if(i.parent!=this.parent){this.parent&&this.container.remove(),this.parent=i.parent,this.createContainer();for(let s of this.manager.tooltipViews)this.container.appendChild(s.dom);t=!0}else this.parent&&this.view.themeClasses!=this.classes&&(this.classes=this.container.className=this.view.themeClasses);t&&this.maybeMeasure()}createTooltip(n,e){let t=n.create(this.view),i=e?e.dom:null;if(t.dom.classList.add("cm-tooltip"),n.arrow&&!t.dom.querySelector(".cm-tooltip > .cm-tooltip-arrow")){let s=document.createElement("div");s.className="cm-tooltip-arrow",t.dom.appendChild(s)}return t.dom.style.position=this.position,t.dom.style.top=Un,t.dom.style.left="0px",this.container.insertBefore(t.dom,i),t.mount&&t.mount(this.view),this.resizeObserver&&this.resizeObserver.observe(t.dom),t}destroy(){var n,e,t;this.view.win.removeEventListener("resize",this.measureSoon);for(let i of this.manager.tooltipViews)i.dom.remove(),(n=i.destroy)===null||n===void 0||n.call(i);this.parent&&this.container.remove(),(e=this.resizeObserver)===null||e===void 0||e.disconnect(),(t=this.intersectionObserver)===null||t===void 0||t.disconnect(),clearTimeout(this.measureTimeout)}readMeasure(){let n=1,e=1,t=!1,i=0;if(this.position=="fixed"&&this.manager.tooltipViews.length){let{dom:o}=this.manager.tooltipViews[0];if(M.safari){let l=o.getBoundingClientRect();t=Math.abs(l.top+1e4)>1||Math.abs(l.left)>1}else t=!!o.offsetParent&&o.offsetParent!=this.container.ownerDocument.body}if(t||this.position=="absolute")if(this.parent){let o=this.parent.getBoundingClientRect();o.width&&o.height&&(n=o.width/this.parent.offsetWidth,e=o.height/this.parent.offsetHeight)}else({scaleX:n,scaleY:e}=this.view.viewState);else i=hf(this.view).left;let s=this.view.scrollDOM.getBoundingClientRect(),r=Zo(this.view);return{visible:{left:s.left+r.left,top:s.top+r.top,right:s.right-r.right,bottom:s.bottom-r.bottom},parent:this.parent?this.container.getBoundingClientRect():this.view.dom.getBoundingClientRect(),pos:this.manager.tooltips.map((o,l)=>{let a=this.manager.tooltipViews[l];return a.getCoords?a.getCoords(o.pos):this.view.coordsAtPos(o.pos)}),size:this.manager.tooltipViews.map(({dom:o})=>o.getBoundingClientRect()),space:this.view.state.facet(Ur).tooltipSpace(this.view),scaleX:n,scaleY:e,makeAbsolute:t,fixedLeft:i}}writeMeasure(n){var e;if(n.makeAbsolute){this.madeAbsolute=!0,this.position="absolute";for(let l of this.manager.tooltipViews)l.dom.style.position="absolute"}let{visible:t,space:i,scaleX:s,scaleY:r}=n,o=[];for(let l=0;l<this.manager.tooltips.length;l++){let a=this.manager.tooltips[l],h=this.manager.tooltipViews[l],{dom:c}=h,f=n.pos[l],u=n.size[l];if(!f||a.clip!==!1&&(f.bottom<=Math.max(t.top,i.top)||f.top>=Math.min(t.bottom,i.bottom)||f.right<Math.max(t.left,i.left)-.1||f.left>Math.min(t.right,i.right)+.1)){c.style.top=Un;continue}let d=a.arrow?h.dom.querySelector(".cm-tooltip-arrow"):null,p=d?7:0,m=u.right-u.left,g=(e=_h.get(h))!==null&&e!==void 0?e:u.bottom-u.top,y=h.offset||Um,v=this.view.textDirection==z.LTR,x=u.width>i.right-i.left?v?i.left:i.right-u.width:v?Math.max(i.left,Math.min(f.left-(d?14:0)+y.x,i.right-m)):Math.min(Math.max(i.left,f.left-m+(d?14:0)-y.x),i.right-m),D=this.above[l];!a.strictSide&&(D?f.top-g-p-y.y<i.top:f.bottom+g+p+y.y>i.bottom)&&D==i.bottom-f.bottom>f.top-i.top&&(D=this.above[l]=!D);let w=(D?f.top-i.top:i.bottom-f.bottom)-p;if(w<g&&h.resize!==!1){if(w<this.view.defaultLineHeight){c.style.top=Un;continue}_h.set(h,g),c.style.height=(g=w)/r+"px"}else c.style.height&&(c.style.height="");let k=D?f.top-g-p-y.y:f.bottom+p+y.y,S=x+m;if(h.overlap!==!0)for(let R of o)R.left<S&&R.right>x&&R.top<k+g&&R.bottom>k&&(k=D?R.top-g-2-p:R.bottom+p+2);if(this.position=="absolute"?(c.style.top=(k-n.parent.top)/r+"px",Yh(c,(x-n.parent.left)/s)):(c.style.top=k/r+"px",Yh(c,(x-n.fixedLeft)/s)),d){let R=f.left+(v?y.x:-y.x)-(x+14-7);d.style.left=R/s+"px"}h.overlap!==!0&&o.push({left:x,top:k,right:S,bottom:k+g}),c.classList.toggle("cm-tooltip-above",D),c.classList.toggle("cm-tooltip-below",!D),h.positioned&&h.positioned(n.space)}}maybeMeasure(){if(this.manager.tooltips.length&&(this.view.inView&&this.view.requestMeasure(this.measureReq),this.inView!=this.view.inView&&(this.inView=this.view.inView,!this.inView)))for(let n of this.manager.tooltipViews)n.dom.style.top=Un}},{eventObservers:{scroll(){this.maybeMeasure()}}});function Yh(n,e){let t=parseInt(n.style.left,10);(isNaN(t)||Math.abs(e-t)>1)&&(n.style.left=e+"px")}var jm=O.baseTheme({".cm-tooltip":{zIndex:500,boxSizing:"border-box"},"&light .cm-tooltip":{border:"1px solid #bbb",backgroundColor:"#f5f5f5"},"&light .cm-tooltip-section:not(:first-child)":{borderTop:"1px solid #bbb"},"&dark .cm-tooltip":{backgroundColor:"#333338",color:"white"},".cm-tooltip-arrow":{height:"7px",width:"14px",position:"absolute",zIndex:-1,overflow:"hidden","&:before, &:after":{content:"''",position:"absolute",width:0,height:0,borderLeft:"7px solid transparent",borderRight:"7px solid transparent"},".cm-tooltip-above &":{bottom:"-7px","&:before":{borderTop:"7px solid #bbb"},"&:after":{borderTop:"7px solid #f5f5f5",bottom:"1px"}},".cm-tooltip-below &":{top:"-7px","&:before":{borderBottom:"7px solid #bbb"},"&:after":{borderBottom:"7px solid #f5f5f5",top:"1px"}}},"&dark .cm-tooltip .cm-tooltip-arrow":{"&:before":{borderTopColor:"#333338",borderBottomColor:"#333338"},"&:after":{borderTopColor:"transparent",borderBottomColor:"transparent"}}}),Um={x:0,y:0},bt=C.define({enables:[tl,jm]}),us=C.define({combine:n=>n.reduce((e,t)=>e.concat(t),[])}),ds=class n{static create(e){return new n(e)}constructor(e){this.view=e,this.mounted=!1,this.dom=document.createElement("div"),this.dom.classList.add("cm-tooltip-hover"),this.manager=new fs(e,us,(t,i)=>this.createHostedView(t,i),t=>t.dom.remove())}createHostedView(e,t){let i=e.create(this.view);return i.dom.classList.add("cm-tooltip-section"),this.dom.insertBefore(i.dom,t?t.dom.nextSibling:this.dom.firstChild),this.mounted&&i.mount&&i.mount(this.view),i}mount(e){for(let t of this.manager.tooltipViews)t.mount&&t.mount(e);this.mounted=!0}positioned(e){for(let t of this.manager.tooltipViews)t.positioned&&t.positioned(e)}update(e){this.manager.update(e)}destroy(){var e;for(let t of this.manager.tooltipViews)(e=t.destroy)===null||e===void 0||e.call(t)}passProp(e){let t;for(let i of this.manager.tooltipViews){let s=i[e];if(s!==void 0){if(t===void 0)t=s;else if(t!==s)return}}return t}get offset(){return this.passProp("offset")}get getCoords(){return this.passProp("getCoords")}get overlap(){return this.passProp("overlap")}get resize(){return this.passProp("resize")}},Gm=bt.compute([us],n=>{let e=n.facet(us);return e.length===0?null:{pos:Math.min(...e.map(t=>t.pos)),end:Math.max(...e.map(t=>{var i;return(i=t.end)!==null&&i!==void 0?i:t.pos})),create:ds.create,above:e[0].above,arrow:e.some(t=>t.arrow)}}),cf=C.define(),Ko=class{constructor(e,t,i,s,r,o){this.view=e,this.source=t,this.field=i,this.locked=s,this.setHover=r,this.hoverTime=o,this.hoverTimeout=-1,this.restartTimeout=-1,this.pending=null,this.lastMove={x:0,y:0,target:e.dom,time:0},this.checkHover=this.checkHover.bind(this),e.dom.addEventListener("mouseleave",this.mouseleave=this.mouseleave.bind(this)),e.dom.addEventListener("mousemove",this.mousemove=this.mousemove.bind(this))}update(e){this.pending&&(this.pending=null,clearTimeout(this.restartTimeout),this.restartTimeout=setTimeout(()=>this.startHover(),20))}get active(){return this.view.state.field(this.field)}checkHover(){if(this.hoverTimeout=-1,this.active.length)return;let e=Date.now()-this.lastMove.time;e<this.hoverTime?this.hoverTimeout=setTimeout(this.checkHover,this.hoverTime-e):this.startHover()}startHover(){clearTimeout(this.restartTimeout);let{view:e,lastMove:t}=this,i=e.docView.tile.nearest(t.target);if(!i)return;let s,r=1;if(i.isWidget())s=i.posAtStart;else{if(s=e.posAtCoords(t),s==null)return;let o=e.coordsAtPos(s);if(!o||t.y<o.top||t.y>o.bottom||t.x<o.left-e.defaultCharacterWidth||t.x>o.right+e.defaultCharacterWidth)return;let l=e.bidiSpans(e.state.doc.lineAt(s)).find(h=>h.from<=s&&h.to>=s),a=l&&l.dir==z.RTL?-1:1;r=t.x<o.left?-a:a}this.activateHover(e,s,r)}activateHover(e,t,i,s){let r=this.source(e,t,i),o=l=>{if(l&&!(Array.isArray(l)&&!l.length)){let a=Array.isArray(l)?l:[l];s&&this.locked.set(a,s),e.dispatch({effects:this.setHover.of(a)})}};if(r&&"then"in r){let l=this.pending={pos:t};r.then(a=>{this.pending==l&&(this.pending=null,o(a))},a=>ce(e.state,a,"hover tooltip"))}else o(r)}get tooltip(){let e=this.view.plugin(tl),t=e?e.manager.tooltips.findIndex(i=>i.create==ds.create):-1;return t>-1?e.manager.tooltipViews[t]:null}mousemove(e){var t,i;this.lastMove={x:e.clientX,y:e.clientY,target:e.target,time:Date.now()},this.hoverTimeout<0&&(this.hoverTimeout=setTimeout(this.checkHover,this.hoverTime));let{active:s,tooltip:r}=this;if(s.length&&!this.locked.has(s)&&r&&!_m(r.dom,e)||this.pending){let{pos:o}=s[0]||this.pending,l=(i=(t=s[0])===null||t===void 0?void 0:t.end)!==null&&i!==void 0?i:o;(o==l?this.view.posAtCoords(this.lastMove)!=o:!Ym(this.view,o,l,e.clientX,e.clientY))&&(this.view.dispatch({effects:this.setHover.of([])}),this.pending=null)}}mouseleave(e){clearTimeout(this.hoverTimeout),this.hoverTimeout=-1;let{active:t}=this;if(t.length&&!this.locked.has(t)){let{tooltip:i}=this;i&&i.dom.contains(e.relatedTarget)?this.watchTooltipLeave(i.dom):this.view.dispatch({effects:this.setHover.of([])})}}watchTooltipLeave(e){let t=i=>{e.removeEventListener("mouseleave",t);let{active:s}=this;s.length&&!this.locked.has(s)&&!this.view.dom.contains(i.relatedTarget)&&this.view.dispatch({effects:this.setHover.of([])})};e.addEventListener("mouseleave",t)}destroy(){clearTimeout(this.hoverTimeout),clearTimeout(this.restartTimeout),this.view.dom.removeEventListener("mouseleave",this.mouseleave),this.view.dom.removeEventListener("mousemove",this.mousemove)}},Gn=4;function _m(n,e){let{left:t,right:i,top:s,bottom:r}=n.getBoundingClientRect(),o;if(o=n.querySelector(".cm-tooltip-arrow")){let l=o.getBoundingClientRect();s=Math.min(l.top,s),r=Math.max(l.bottom,r)}return e.clientX>=t-Gn&&e.clientX<=i+Gn&&e.clientY>=s-Gn&&e.clientY<=r+Gn}function Ym(n,e,t,i,s,r){let o=n.scrollDOM.getBoundingClientRect(),l=n.documentTop+n.documentPadding.top+n.contentHeight;if(o.left>i||o.right<i||o.top>s||Math.min(o.bottom,l)<s)return!1;let a=n.posAtCoords({x:i,y:s},!1);return a>=e&&a<=t}function ws(n,e={}){let t=L.define(),i=new WeakMap,s=_.define({create(){return[]},update(o,l){let a=i.get(o);if(o.length&&(e.hideOnChange&&(l.docChanged||l.selection)?o=[]:a&&a(l)?o=[]:e.hideOn&&(o=o.filter(h=>!e.hideOn(l,h)))),l.docChanged&&o.length){let h=[];for(let c of o){let f=l.changes.mapPos(c.pos,-1,ie.TrackDel);if(f!=null){let u=Object.assign(Object.create(null),c);u.pos=f,u.end!=null&&(u.end=l.changes.mapPos(u.end)),h.push(u)}}o=h}for(let h of l.effects)h.is(t)&&(o=h.value,a=void 0),(h.is(ff)&&!h.value||h.value==s)&&(o=[]);return o.length&&a&&i.set(o,a),o},provide:o=>us.from(o)}),r=K.define(o=>new Ko(o,n,s,i,t,e.hoverTime||300));return{active:s,extension:[s,r,cf.of(r),Gm]}}function il(n,e,t,i={}){var s;let r=n.state.facet(cf).map(o=>n.plugin(o)).filter(o=>!!o);if(i.tooltip&&i.tooltip.active){let o=r.find(l=>l.field==i.tooltip.active);o&&(r=[o])}for(let o of r)o.activateHover(n,e,t,(s=i.until)!==null&&s!==void 0?s:(()=>!1))}function nl(n,e){let t=n.plugin(tl);if(!t)return null;let i=t.manager.tooltips.indexOf(e);return i<0?null:t.manager.tooltipViews[i]}var ff=L.define(),uf=ff.of(null);var Xh=C.define({combine(n){let e,t;for(let i of n)e=e||i.topContainer,t=t||i.bottomContainer;return{topContainer:e,bottomContainer:t}}});function vi(n,e){let t=n.plugin(df),i=t?t.specs.indexOf(e):-1;return i>-1?t.panels[i]:null}var df=K.fromClass(class{constructor(n){this.input=n.state.facet(Wt),this.specs=this.input.filter(t=>t),this.panels=this.specs.map(t=>t(n));let e=n.state.facet(Xh);this.top=new ai(n,!0,e.topContainer),this.bottom=new ai(n,!1,e.bottomContainer),this.top.sync(this.panels.filter(t=>t.top)),this.bottom.sync(this.panels.filter(t=>!t.top));for(let t of this.panels)t.dom.classList.add("cm-panel"),t.mount&&t.mount()}update(n){let e=n.state.facet(Xh);this.top.container!=e.topContainer&&(this.top.sync([]),this.top=new ai(n.view,!0,e.topContainer)),this.bottom.container!=e.bottomContainer&&(this.bottom.sync([]),this.bottom=new ai(n.view,!1,e.bottomContainer)),this.top.syncClasses(),this.bottom.syncClasses();let t=n.state.facet(Wt);if(t!=this.input){let i=t.filter(a=>a),s=[],r=[],o=[],l=[];for(let a of i){let h=this.specs.indexOf(a),c;h<0?(c=a(n.view),l.push(c)):(c=this.panels[h],c.update&&c.update(n)),s.push(c),(c.top?r:o).push(c)}this.specs=i,this.panels=s,this.top.sync(r),this.bottom.sync(o);for(let a of l)a.dom.classList.add("cm-panel"),a.mount&&a.mount()}else for(let i of this.panels)i.update&&i.update(n)}destroy(){this.top.sync([]),this.bottom.sync([])}},{provide:n=>O.scrollMargins.of(e=>{let t=e.plugin(n);return t&&{top:t.top.scrollMargin(),bottom:t.bottom.scrollMargin()}})}),ai=class{constructor(e,t,i){this.view=e,this.top=t,this.container=i,this.dom=void 0,this.classes="",this.panels=[],this.syncClasses()}sync(e){for(let t of this.panels)t.destroy&&e.indexOf(t)<0&&t.destroy();this.panels=e,this.syncDOM()}syncDOM(){if(this.panels.length==0){this.dom&&(this.dom.remove(),this.dom=void 0);return}if(!this.dom){this.dom=document.createElement("div"),this.dom.className=this.top?"cm-panels cm-panels-top":"cm-panels cm-panels-bottom";let t=this.container||this.view.dom;t.insertBefore(this.dom,this.top?t.firstChild:null)}let e=this.dom.firstChild;for(let t of this.panels)if(t.dom.parentNode==this.dom){for(;e!=t.dom;)e=Jh(e);e=e.nextSibling}else this.dom.insertBefore(t.dom,e);for(;e;)e=Jh(e)}scrollMargin(){return!this.dom||this.container?0:Math.max(0,this.top?this.dom.getBoundingClientRect().bottom-Math.max(0,this.view.scrollDOM.getBoundingClientRect().top):Math.min(innerHeight,this.view.scrollDOM.getBoundingClientRect().bottom)-this.dom.getBoundingClientRect().top)}syncClasses(){if(!(!this.container||this.classes==this.view.themeClasses)){for(let e of this.classes.split(" "))e&&this.container.classList.remove(e);for(let e of(this.classes=this.view.themeClasses).split(" "))e&&this.container.classList.add(e)}}};function Jh(n){let e=n.nextSibling;return n.remove(),e}var Wt=C.define({enables:df});function pf(n,e){let t,i=new Promise(o=>t=o),s=o=>Xm(o,e,t);n.state.field(Jn,!1)?n.dispatch({effects:gf.of(s)}):n.dispatch({effects:L.appendConfig.of(Jn.init(()=>[s]))});let r=yf.of(s);return{close:r,result:i.then(o=>((n.win.queueMicrotask||(a=>n.win.setTimeout(a,10)))(()=>{n.state.field(Jn).indexOf(s)>-1&&n.dispatch({effects:r})}),o))}}function mf(n,e){let t=n.state.field(Jn,!1)||[];for(let i of t){let s=vi(n,i);if(s&&s.dom.classList.contains(e))return s}return null}var Jn=_.define({create(){return[]},update(n,e){for(let t of e.effects)t.is(gf)?n=[t.value].concat(n):t.is(yf)&&(n=n.filter(i=>i!=t.value));return n},provide:n=>Wt.computeN([n],e=>e.field(n))}),gf=L.define(),yf=L.define();function Xm(n,e,t){let i=e.content?e.content(n,()=>l(null)):null;if(!i){if(i=W("form"),e.input){let a=W("input",e.input);/^(text|password|number|email|tel|url)$/.test(a.type)&&a.classList.add("cm-textfield"),a.name||(a.name="input"),i.appendChild(W("label",(e.label||"")+": ",a))}else i.appendChild(document.createTextNode(e.label||""));i.appendChild(document.createTextNode(" ")),i.appendChild(W("button",{class:"cm-button",type:"submit"},e.submitLabel||"OK"))}let s=i.nodeName=="FORM"?[i]:i.querySelectorAll("form");for(let a=0;a<s.length;a++){let h=s[a];h.addEventListener("keydown",c=>{c.keyCode==27?(c.preventDefault(),l(null)):c.keyCode==13&&(c.preventDefault(),l(h))}),h.addEventListener("submit",c=>{c.preventDefault(),l(h)})}let r=W("div",i,W("button",{onclick:()=>l(null),"aria-label":n.state.phrase("close"),class:"cm-dialog-close",type:"button"},["\xD7"]));e.class&&(r.className=e.class),r.classList.add("cm-dialog");let o=typeof e.focus=="string"?i.querySelector(e.focus):e.focus?i.querySelector("input")||i.querySelector("button"):null;function l(a){r.contains(r.ownerDocument.activeElement)&&n.focus(),t(a)}return{dom:r,top:e.top,mount:()=>{o&&("select"in o?o.select():"focus"in o&&o.focus())},destroy:()=>t(null)}}var Ae=class extends Ne{compare(e){return this==e||this.constructor==e.constructor&&this.eq(e)}eq(e){return!1}destroy(e){}};Ae.prototype.elementClass="";Ae.prototype.toDOM=void 0;Ae.prototype.mapMode=ie.TrackBefore;Ae.prototype.startSide=Ae.prototype.endSide=-1;Ae.prototype.point=!0;var Qn=C.define(),Jm=C.define(),Qm={class:"",renderEmptyElements:!1,elementStyle:"",markers:()=>H.empty,lineMarker:()=>null,widgetMarker:()=>null,lineMarkerChange:null,initialSpacer:null,updateSpacer:null,domEventHandlers:{},side:"before"},Gi=C.define();function vs(n){return[bf(),Gi.of({...Qm,...n})]}var $o=C.define({combine:n=>n.some(e=>e)});function bf(n){let e=[Zm];return n&&n.fixed===!1&&e.push($o.of(!0)),e}var Zm=K.fromClass(class{constructor(n){this.view=n,this.domAfter=null,this.prevViewport=n.viewport,this.dom=document.createElement("div"),this.dom.className="cm-gutters cm-gutters-before",this.dom.setAttribute("aria-hidden","true"),this.dom.style.minHeight=this.view.contentHeight/this.view.scaleY+"px",this.gutters=n.state.facet(Gi).map(e=>new ps(n,e)),this.fixed=!n.state.facet($o);for(let e of this.gutters)e.config.side=="after"?this.getDOMAfter().appendChild(e.dom):this.dom.appendChild(e.dom);this.fixed&&(this.dom.style.position="sticky"),this.syncGutters(!1),n.scrollDOM.insertBefore(this.dom,n.contentDOM)}getDOMAfter(){return this.domAfter||(this.domAfter=document.createElement("div"),this.domAfter.className="cm-gutters cm-gutters-after",this.domAfter.setAttribute("aria-hidden","true"),this.domAfter.style.minHeight=this.view.contentHeight/this.view.scaleY+"px",this.domAfter.style.position=this.fixed?"sticky":"",this.view.scrollDOM.appendChild(this.domAfter)),this.domAfter}update(n){if(this.updateGutters(n)){let e=this.prevViewport,t=n.view.viewport,i=Math.min(e.to,t.to)-Math.max(e.from,t.from);this.syncGutters(i<(t.to-t.from)*.8)}if(n.geometryChanged){let e=this.view.contentHeight/this.view.scaleY+"px";this.dom.style.minHeight=e,this.domAfter&&(this.domAfter.style.minHeight=e)}this.view.state.facet($o)!=!this.fixed&&(this.fixed=!this.fixed,this.dom.style.position=this.fixed?"sticky":"",this.domAfter&&(this.domAfter.style.position=this.fixed?"sticky":"")),this.prevViewport=n.view.viewport}syncGutters(n){let e=this.dom.nextSibling;n&&(this.dom.remove(),this.domAfter&&this.domAfter.remove());let t=H.iter(this.view.state.facet(Qn),this.view.viewport.from),i=[],s=this.gutters.map(r=>new Uo(r,this.view.viewport,-this.view.documentPadding.top));for(let r of this.view.viewportLineBlocks)if(i.length&&(i=[]),Array.isArray(r.type)){let o=!0;for(let l of r.type)if(l.type==fe.Text&&o){jo(t,i,l.from);for(let a of s)a.line(this.view,l,i);o=!1}else if(l.widget)for(let a of s)a.widget(this.view,l)}else if(r.type==fe.Text){jo(t,i,r.from);for(let o of s)o.line(this.view,r,i)}else if(r.widget)for(let o of s)o.widget(this.view,r);for(let r of s)r.finish();n&&(this.view.scrollDOM.insertBefore(this.dom,e),this.domAfter&&this.view.scrollDOM.appendChild(this.domAfter))}updateGutters(n){let e=n.startState.facet(Gi),t=n.state.facet(Gi),i=n.docChanged||n.heightChanged||n.viewportChanged||!H.eq(n.startState.facet(Qn),n.state.facet(Qn),n.view.viewport.from,n.view.viewport.to);if(e==t)for(let s of this.gutters)s.update(n)&&(i=!0);else{i=!0;let s=[];for(let r of t){let o=e.indexOf(r);o<0?s.push(new ps(this.view,r)):(this.gutters[o].update(n),s.push(this.gutters[o]))}for(let r of this.gutters)r.dom.remove(),s.indexOf(r)<0&&r.destroy();for(let r of s)r.config.side=="after"?this.getDOMAfter().appendChild(r.dom):this.dom.appendChild(r.dom);this.gutters=s}return i}destroy(){for(let n of this.gutters)n.destroy();this.dom.remove(),this.domAfter&&this.domAfter.remove()}},{provide:n=>O.scrollMargins.of(e=>{let t=e.plugin(n);if(!t||t.gutters.length==0||!t.fixed)return null;let i=t.dom.offsetWidth*e.scaleX,s=t.domAfter?t.domAfter.offsetWidth*e.scaleX:0;return e.textDirection==z.LTR?{left:i,right:s}:{right:i,left:s}})});function Qh(n){return Array.isArray(n)?n:[n]}function jo(n,e,t){for(;n.value&&n.from<=t;)n.from==t&&e.push(n.value),n.next()}var Uo=class{constructor(e,t,i){this.gutter=e,this.height=i,this.i=0,this.cursor=H.iter(e.markers,t.from)}addElement(e,t,i){let{gutter:s}=this,r=(t.top-this.height)/e.scaleY,o=t.height/e.scaleY;if(this.i==s.elements.length){let l=new ms(e,o,r,i);s.elements.push(l),s.dom.appendChild(l.dom)}else s.elements[this.i].update(e,o,r,i);this.height=t.bottom,this.i++}line(e,t,i){let s=[];jo(this.cursor,s,t.from),i.length&&(s=s.concat(i));let r=this.gutter.config.lineMarker(e,t,s);r&&s.unshift(r);let o=this.gutter;s.length==0&&!o.config.renderEmptyElements||this.addElement(e,t,s)}widget(e,t){let i=this.gutter.config.widgetMarker(e,t.widget,t),s=i?[i]:null;for(let r of e.state.facet(Jm)){let o=r(e,t.widget,t);o&&(s||(s=[])).push(o)}s&&this.addElement(e,t,s)}finish(){let e=this.gutter;for(;e.elements.length>this.i;){let t=e.elements.pop();e.dom.removeChild(t.dom),t.destroy()}}},ps=class{constructor(e,t){this.view=e,this.config=t,this.elements=[],this.spacer=null,this.dom=document.createElement("div"),this.dom.className="cm-gutter"+(this.config.class?" "+this.config.class:"");for(let i in t.domEventHandlers)this.dom.addEventListener(i,s=>{let r=s.target,o;if(r!=this.dom&&this.dom.contains(r)){for(;r.parentNode!=this.dom;)r=r.parentNode;let a=r.getBoundingClientRect();o=(a.top+a.bottom)/2}else o=s.clientY;let l=e.lineBlockAtHeight(o-e.documentTop);t.domEventHandlers[i](e,l,s)&&s.preventDefault()});this.markers=Qh(t.markers(e)),t.initialSpacer&&(this.spacer=new ms(e,0,0,[t.initialSpacer(e)]),this.dom.appendChild(this.spacer.dom),this.spacer.dom.style.cssText+="visibility: hidden; pointer-events: none")}update(e){let t=this.markers;if(this.markers=Qh(this.config.markers(e.view)),this.spacer&&this.config.updateSpacer){let s=this.config.updateSpacer(this.spacer.markers[0],e);s!=this.spacer.markers[0]&&this.spacer.update(e.view,0,0,[s])}let i=e.view.viewport;return!H.eq(this.markers,t,i.from,i.to)||(this.config.lineMarkerChange?this.config.lineMarkerChange(e):!1)}destroy(){for(let e of this.elements)e.destroy()}},ms=class{constructor(e,t,i,s){this.height=-1,this.above=0,this.markers=[],this.dom=document.createElement("div"),this.dom.className="cm-gutterElement",this.update(e,t,i,s)}update(e,t,i,s){this.height!=t&&(this.height=t,this.dom.style.height=t+"px"),this.above!=i&&(this.dom.style.marginTop=(this.above=i)?i+"px":""),eg(this.markers,s)||this.setMarkers(e,s)}setMarkers(e,t){let i="cm-gutterElement",s=this.dom.firstChild;for(let r=0,o=0;;){let l=o,a=r<t.length?t[r++]:null,h=!1;if(a){let c=a.elementClass;c&&(i+=" "+c);for(let f=o;f<this.markers.length;f++)if(this.markers[f].compare(a)){l=f,h=!0;break}}else l=this.markers.length;for(;o<l;){let c=this.markers[o++];if(c.toDOM){c.destroy(s);let f=s.nextSibling;s.remove(),s=f}}if(!a)break;a.toDOM&&(h?s=s.nextSibling:this.dom.insertBefore(a.toDOM(e),s)),h&&o++}this.dom.className=i,this.markers=t}destroy(){this.setMarkers(null,[])}};function eg(n,e){if(n.length!=e.length)return!1;for(let t=0;t<n.length;t++)if(!n[t].compare(e[t]))return!1;return!0}var tg=C.define(),ig=C.define(),hi=C.define({combine(n){return me(n,{formatNumber:String,domEventHandlers:{}},{domEventHandlers(e,t){let i=Object.assign({},e);for(let s in t){let r=i[s],o=t[s];i[s]=r?(l,a,h)=>r(l,a,h)||o(l,a,h):o}return i}})}}),_i=class extends Ae{constructor(e){super(),this.number=e}eq(e){return this.number==e.number}toDOM(){return document.createTextNode(this.number)}};function Gr(n,e){return n.state.facet(hi).formatNumber(e,n.state)}var ng=Gi.compute([hi],n=>({class:"cm-lineNumbers",renderEmptyElements:!1,markers(e){return e.state.facet(tg)},lineMarker(e,t,i){return i.some(s=>s.toDOM)?null:new _i(Gr(e,e.state.doc.lineAt(t.from).number))},widgetMarker:(e,t,i)=>{for(let s of e.state.facet(ig)){let r=s(e,t,i);if(r)return r}return null},lineMarkerChange:e=>e.startState.facet(hi)!=e.state.facet(hi),initialSpacer(e){return new _i(Gr(e,Zh(e.state.doc.lines)))},updateSpacer(e,t){let i=Gr(t.view,Zh(t.view.state.doc.lines));return i==e.number?e:new _i(i)},domEventHandlers:n.facet(hi).domEventHandlers,side:"before"}));function xf(n={}){return[hi.of(n),bf(),ng]}function Zh(n){let e=9;for(;e<n;)e=e*10+9;return e}var sg=new class extends Ae{constructor(){super(...arguments),this.elementClass="cm-activeLineGutter"}},rg=Qn.compute(["selection"],n=>{let e=[],t=-1;for(let i of n.selection.ranges){let s=n.doc.lineAt(i.head).from;s>t&&(t=s,e.push(sg.range(s)))}return H.of(e)});function wf(){return rg}function og(n){return K.define(e=>({decorations:n.createDeco(e),update(t){this.decorations=n.updateDeco(t,this.decorations)}}),{decorations:e=>e.decorations})}var lg=og(new cs({regexp:/\s+$/g,decoration:B.mark({class:"cm-trailingSpace"})}));function vf(){return lg}var ag=0,tn=class{constructor(e,t){this.from=e,this.to=t}},P=class{constructor(e={}){this.id=ag++,this.perNode=!!e.perNode,this.deserialize=e.deserialize||(()=>{throw new Error("This node type doesn't define a deserialize function")}),this.combine=e.combine||null}add(e){if(this.perNode)throw new RangeError("Can't add per-node props to node types");return typeof e!="function"&&(e=ke.match(e)),t=>{let i=e(t);return i===void 0?null:[this,i]}}};P.closedBy=new P({deserialize:n=>n.split(" ")});P.openedBy=new P({deserialize:n=>n.split(" ")});P.group=new P({deserialize:n=>n.split(" ")});P.isolate=new P({deserialize:n=>{if(n&&n!="rtl"&&n!="ltr"&&n!="auto")throw new RangeError("Invalid value for isolate: "+n);return n||"auto"}});P.contextHash=new P({perNode:!0});P.lookAhead=new P({perNode:!0});P.mounted=new P({perNode:!0});var Vt=class{constructor(e,t,i,s=!1){this.tree=e,this.overlay=t,this.parser=i,this.bracketed=s}static get(e){return e&&e.props&&e.props[P.mounted.id]}},hg=Object.create(null),ke=class n{constructor(e,t,i,s=0){this.name=e,this.props=t,this.id=i,this.flags=s}static define(e){let t=e.props&&e.props.length?Object.create(null):hg,i=(e.top?1:0)|(e.skipped?2:0)|(e.error?4:0)|(e.name==null?8:0),s=new n(e.name||"",t,e.id,i);if(e.props){for(let r of e.props)if(Array.isArray(r)||(r=r(s)),r){if(r[0].perNode)throw new RangeError("Can't store a per-node prop on a node type");t[r[0].id]=r[1]}}return s}prop(e){return this.props[e.id]}get isTop(){return(this.flags&1)>0}get isSkipped(){return(this.flags&2)>0}get isError(){return(this.flags&4)>0}get isAnonymous(){return(this.flags&8)>0}is(e){if(typeof e=="string"){if(this.name==e)return!0;let t=this.prop(P.group);return t?t.indexOf(e)>-1:!1}return this.id==e}static match(e){let t=Object.create(null);for(let i in e)for(let s of i.split(" "))t[s]=e[i];return i=>{for(let s=i.prop(P.group),r=-1;r<(s?s.length:0);r++){let o=t[r<0?i.name:s[r]];if(o)return o}}}};ke.none=new ke("",Object.create(null),0,8);var Cs=class n{constructor(e){this.types=e;for(let t=0;t<e.length;t++)if(e[t].id!=t)throw new RangeError("Node type ids should correspond to array positions when creating a node set")}extend(...e){let t=[];for(let i of this.types){let s=null;for(let r of e){let o=r(i);if(o){s||(s=Object.assign({},i.props));let l=o[1],a=o[0];a.combine&&a.id in s&&(l=a.combine(s[a.id],l)),s[a.id]=l}}t.push(s?new ke(i.name,s,i.id,i.flags):i)}return new n(t)}},ks=new WeakMap,kf=new WeakMap,Z;(function(n){n[n.ExcludeBuffers=1]="ExcludeBuffers",n[n.IncludeAnonymous=2]="IncludeAnonymous",n[n.IgnoreMounts=4]="IgnoreMounts",n[n.IgnoreOverlays=8]="IgnoreOverlays",n[n.EnterBracketed=16]="EnterBracketed"})(Z||(Z={}));var Q=class n{constructor(e,t,i,s,r){if(this.type=e,this.children=t,this.positions=i,this.length=s,this.props=null,r&&r.length){this.props=Object.create(null);for(let[o,l]of r)this.props[typeof o=="number"?o:o.id]=l}}toString(){let e=Vt.get(this);if(e&&!e.overlay)return e.tree.toString();let t="";for(let i of this.children){let s=i.toString();s&&(t&&(t+=","),t+=s)}return this.type.name?(/\W/.test(this.type.name)&&!this.type.isError?JSON.stringify(this.type.name):this.type.name)+(t.length?"("+t+")":""):t}cursor(e=0){return new rn(this.topNode,e)}cursorAt(e,t=0,i=0){let s=ks.get(this)||this.topNode,r=new rn(s);return r.moveTo(e,t),ks.set(this,r._tree),r}get topNode(){return new et(this,0,0,null)}resolve(e,t=0){let i=nn(ks.get(this)||this.topNode,e,t,!1);return ks.set(this,i),i}resolveInner(e,t=0){let i=nn(kf.get(this)||this.topNode,e,t,!0);return kf.set(this,i),i}resolveStack(e,t=0){return cg(this,e,t)}iterate(e){let{enter:t,leave:i,from:s=0,to:r=this.length}=e,o=e.mode||0,l=(o&Z.IncludeAnonymous)>0;for(let a=this.cursor(o|Z.IncludeAnonymous);;){let h=!1;if(a.from<=r&&a.to>=s&&(!l&&a.type.isAnonymous||t(a)!==!1)){if(a.firstChild())continue;h=!0}for(;h&&i&&(l||!a.type.isAnonymous)&&i(a),!a.nextSibling();){if(!a.parent())return;h=!0}}}prop(e){return e.perNode?this.props?this.props[e.id]:void 0:this.type.prop(e)}get propValues(){let e=[];if(this.props)for(let t in this.props)e.push([+t,this.props[t]]);return e}balance(e={}){return this.children.length<=8?this:cl(ke.none,this.children,this.positions,0,this.children.length,0,this.length,(t,i,s)=>new n(this.type,t,i,s,this.propValues),e.makeTree||((t,i,s)=>new n(ke.none,t,i,s)))}static build(e){return fg(e)}};Q.empty=new Q(ke.none,[],[],0);var sl=class n{constructor(e,t){this.buffer=e,this.index=t}get id(){return this.buffer[this.index-4]}get start(){return this.buffer[this.index-3]}get end(){return this.buffer[this.index-2]}get size(){return this.buffer[this.index-1]}get pos(){return this.index}next(){this.index-=4}fork(){return new n(this.buffer,this.index)}},xt=class n{constructor(e,t,i){this.buffer=e,this.length=t,this.set=i}get type(){return ke.none}toString(){let e=[];for(let t=0;t<this.buffer.length;)e.push(this.childString(t)),t=this.buffer[t+3];return e.join(",")}childString(e){let t=this.buffer[e],i=this.buffer[e+3],s=this.set.types[t],r=s.name;if(/\W/.test(r)&&!s.isError&&(r=JSON.stringify(r)),e+=4,i==e)return r;let o=[];for(;e<i;)o.push(this.childString(e)),e=this.buffer[e+3];return r+"("+o.join(",")+")"}findChild(e,t,i,s,r){let{buffer:o}=this,l=-1;for(let a=e;a!=t&&!(Af(r,s,o[a+1],o[a+2])&&(l=a,i>0));a=o[a+3]);return l}slice(e,t,i){let s=this.buffer,r=new Uint16Array(t-e),o=0;for(let l=e,a=0;l<t;){r[a++]=s[l++],r[a++]=s[l++]-i;let h=r[a++]=s[l++]-i;r[a++]=s[l++]-e,o=Math.max(o,h)}return new n(r,o,this.set)}};function Af(n,e,t,i){switch(n){case-2:return t<e;case-1:return i>=e&&t<e;case 0:return t<e&&i>e;case 1:return t<=e&&i>e;case 2:return i>e;case 4:return!0}}function nn(n,e,t,i){for(var s;n.from==n.to||(t<1?n.from>=e:n.from>e)||(t>-1?n.to<=e:n.to<e);){let o=!i&&n instanceof et&&n.index<0?null:n.parent;if(!o)return n;n=o}let r=i?0:Z.IgnoreOverlays;if(i)for(let o=n,l=o.parent;l;o=l,l=o.parent)o instanceof et&&o.index<0&&((s=l.enter(e,t,r))===null||s===void 0?void 0:s.from)!=o.from&&(n=l);for(;;){let o=n.enter(e,t,r);if(!o)return n;n=o}}var As=class{cursor(e=0){return new rn(this,e)}getChild(e,t=null,i=null){let s=Sf(this,e,t,i);return s.length?s[0]:null}getChildren(e,t=null,i=null){return Sf(this,e,t,i)}resolve(e,t=0){return nn(this,e,t,!1)}resolveInner(e,t=0){return nn(this,e,t,!0)}matchContext(e){return rl(this.parent,e)}enterUnfinishedNodesBefore(e){let t=this.childBefore(e),i=this;for(;t;){let s=t.lastChild;if(!s||s.to!=t.to)break;s.type.isError&&s.from==s.to?(i=t,t=s.prevSibling):t=s}return i}get node(){return this}get next(){return this.parent}},et=class n extends As{constructor(e,t,i,s){super(),this._tree=e,this.from=t,this.index=i,this._parent=s}get type(){return this._tree.type}get name(){return this._tree.type.name}get to(){return this.from+this._tree.length}nextChild(e,t,i,s,r=0){for(let o=this;;){for(let{children:l,positions:a}=o._tree,h=t>0?l.length:-1;e!=h;e+=t){let c=l[e],f=a[e]+o.from,u;if(!(!(r&Z.EnterBracketed&&c instanceof Q&&(u=Vt.get(c))&&!u.overlay&&u.bracketed&&i>=f&&i<=f+c.length)&&!Af(s,i,f,f+c.length))){if(c instanceof xt){if(r&Z.ExcludeBuffers)continue;let d=c.findChild(0,c.buffer.length,t,i-f,s);if(d>-1)return new sn(new ol(o,c,e,f),null,d)}else if(r&Z.IncludeAnonymous||!c.type.isAnonymous||hl(c)){let d;if(!(r&Z.IgnoreMounts)&&(d=Vt.get(c))&&!d.overlay)return new n(d.tree,f,e,o);let p=new n(c,f,e,o);return r&Z.IncludeAnonymous||!p.type.isAnonymous?p:p.nextChild(t<0?c.children.length-1:0,t,i,s,r)}}}if(r&Z.IncludeAnonymous||!o.type.isAnonymous||(o.index>=0?e=o.index+t:e=t<0?-1:o._parent._tree.children.length,o=o._parent,!o))return null}}get firstChild(){return this.nextChild(0,1,0,4)}get lastChild(){return this.nextChild(this._tree.children.length-1,-1,0,4)}childAfter(e){return this.nextChild(0,1,e,2)}childBefore(e){return this.nextChild(this._tree.children.length-1,-1,e,-2)}prop(e){return this._tree.prop(e)}enter(e,t,i=0){let s;if(!(i&Z.IgnoreOverlays)&&(s=Vt.get(this._tree))&&s.overlay){let r=e-this.from,o=i&Z.EnterBracketed&&s.bracketed;for(let{from:l,to:a}of s.overlay)if((t>0||o?l<=r:l<r)&&(t<0||o?a>=r:a>r))return new n(s.tree,s.overlay[0].from+this.from,-1,this)}return this.nextChild(0,1,e,t,i)}nextSignificantParent(){let e=this;for(;e.type.isAnonymous&&e._parent;)e=e._parent;return e}get parent(){return this._parent?this._parent.nextSignificantParent():null}get nextSibling(){return this._parent&&this.index>=0?this._parent.nextChild(this.index+1,1,0,4):null}get prevSibling(){return this._parent&&this.index>=0?this._parent.nextChild(this.index-1,-1,0,4):null}get tree(){return this._tree}toTree(){return this._tree}toString(){return this._tree.toString()}};function Sf(n,e,t,i){let s=n.cursor(),r=[];if(!s.firstChild())return r;if(t!=null){for(let o=!1;!o;)if(o=s.type.is(t),!s.nextSibling())return r}for(;;){if(i!=null&&s.type.is(i))return r;if(s.type.is(e)&&r.push(s.node),!s.nextSibling())return i==null?r:[]}}function rl(n,e,t=e.length-1){for(let i=n;t>=0;i=i.parent){if(!i)return!1;if(!i.type.isAnonymous){if(e[t]&&e[t]!=i.name)return!1;t--}}return!0}var ol=class{constructor(e,t,i,s){this.parent=e,this.buffer=t,this.index=i,this.start=s}},sn=class n extends As{get name(){return this.type.name}get from(){return this.context.start+this.context.buffer.buffer[this.index+1]}get to(){return this.context.start+this.context.buffer.buffer[this.index+2]}constructor(e,t,i){super(),this.context=e,this._parent=t,this.index=i,this.type=e.buffer.set.types[e.buffer.buffer[i]]}child(e,t,i){let{buffer:s}=this.context,r=s.findChild(this.index+4,s.buffer[this.index+3],e,t-this.context.start,i);return r<0?null:new n(this.context,this,r)}get firstChild(){return this.child(1,0,4)}get lastChild(){return this.child(-1,0,4)}childAfter(e){return this.child(1,e,2)}childBefore(e){return this.child(-1,e,-2)}prop(e){return this.type.prop(e)}enter(e,t,i=0){if(i&Z.ExcludeBuffers)return null;let{buffer:s}=this.context,r=s.findChild(this.index+4,s.buffer[this.index+3],t>0?1:-1,e-this.context.start,t);return r<0?null:new n(this.context,this,r)}get parent(){return this._parent||this.context.parent.nextSignificantParent()}externalSibling(e){return this._parent?null:this.context.parent.nextChild(this.context.index+e,e,0,4)}get nextSibling(){let{buffer:e}=this.context,t=e.buffer[this.index+3];return t<(this._parent?e.buffer[this._parent.index+3]:e.buffer.length)?new n(this.context,this._parent,t):this.externalSibling(1)}get prevSibling(){let{buffer:e}=this.context,t=this._parent?this._parent.index+4:0;return this.index==t?this.externalSibling(-1):new n(this.context,this._parent,e.findChild(t,this.index,-1,0,4))}get tree(){return null}toTree(){let e=[],t=[],{buffer:i}=this.context,s=this.index+4,r=i.buffer[this.index+3];if(r>s){let o=i.buffer[this.index+1];e.push(i.slice(s,r,o)),t.push(0)}return new Q(this.type,e,t,this.to-this.from)}toString(){return this.context.buffer.childString(this.index)}};function Mf(n){if(!n.length)return null;let e=0,t=n[0];for(let r=1;r<n.length;r++){let o=n[r];(o.from>t.from||o.to<t.to)&&(t=o,e=r)}let i=t instanceof et&&t.index<0?null:t.parent,s=n.slice();return i?s[e]=i:s.splice(e,1),new ll(s,t)}var ll=class{constructor(e,t){this.heads=e,this.node=t}get next(){return Mf(this.heads)}};function cg(n,e,t){let i=n.resolveInner(e,t),s=null;for(let r=i instanceof et?i:i.context.parent;r;r=r.parent)if(r.index<0){let o=r.parent;(s||(s=[i])).push(o.resolve(e,t)),r=o}else{let o=Vt.get(r.tree);if(o&&o.overlay&&o.overlay[0].from<=e&&o.overlay[o.overlay.length-1].to>=e){let l=new et(o.tree,o.overlay[0].from+r.from,-1,r);(s||(s=[i])).push(nn(l,e,t,!1))}}return s?Mf(s):i}var rn=class{get name(){return this.type.name}constructor(e,t=0){if(this.buffer=null,this.stack=[],this.index=0,this.bufferNode=null,this.mode=t&~Z.EnterBracketed,e instanceof et)this.yieldNode(e);else{this._tree=e.context.parent,this.buffer=e.context;for(let i=e._parent;i;i=i._parent)this.stack.unshift(i.index);this.bufferNode=e,this.yieldBuf(e.index)}}yieldNode(e){return e?(this._tree=e,this.type=e.type,this.from=e.from,this.to=e.to,!0):!1}yieldBuf(e,t){this.index=e;let{start:i,buffer:s}=this.buffer;return this.type=t||s.set.types[s.buffer[e]],this.from=i+s.buffer[e+1],this.to=i+s.buffer[e+2],!0}yield(e){return e?e instanceof et?(this.buffer=null,this.yieldNode(e)):(this.buffer=e.context,this.yieldBuf(e.index,e.type)):!1}toString(){return this.buffer?this.buffer.buffer.childString(this.index):this._tree.toString()}enterChild(e,t,i){if(!this.buffer)return this.yield(this._tree.nextChild(e<0?this._tree._tree.children.length-1:0,e,t,i,this.mode));let{buffer:s}=this.buffer,r=s.findChild(this.index+4,s.buffer[this.index+3],e,t-this.buffer.start,i);return r<0?!1:(this.stack.push(this.index),this.yieldBuf(r))}firstChild(){return this.enterChild(1,0,4)}lastChild(){return this.enterChild(-1,0,4)}childAfter(e){return this.enterChild(1,e,2)}childBefore(e){return this.enterChild(-1,e,-2)}enter(e,t,i=this.mode){return this.buffer?i&Z.ExcludeBuffers?!1:this.enterChild(1,e,t):this.yield(this._tree.enter(e,t,i))}parent(){if(!this.buffer)return this.yieldNode(this.mode&Z.IncludeAnonymous?this._tree._parent:this._tree.parent);if(this.stack.length)return this.yieldBuf(this.stack.pop());let e=this.mode&Z.IncludeAnonymous?this.buffer.parent:this.buffer.parent.nextSignificantParent();return this.buffer=null,this.yieldNode(e)}sibling(e){if(!this.buffer)return this._tree._parent?this.yield(this._tree.index<0?null:this._tree._parent.nextChild(this._tree.index+e,e,0,4,this.mode)):!1;let{buffer:t}=this.buffer,i=this.stack.length-1;if(e<0){let s=i<0?0:this.stack[i]+4;if(this.index!=s)return this.yieldBuf(t.findChild(s,this.index,-1,0,4))}else{let s=t.buffer[this.index+3];if(s<(i<0?t.buffer.length:t.buffer[this.stack[i]+3]))return this.yieldBuf(s)}return i<0?this.yield(this.buffer.parent.nextChild(this.buffer.index+e,e,0,4,this.mode)):!1}nextSibling(){return this.sibling(1)}prevSibling(){return this.sibling(-1)}atLastNode(e){let t,i,{buffer:s}=this;if(s){if(e>0){if(this.index<s.buffer.buffer.length)return!1}else for(let r=0;r<this.index;r++)if(s.buffer.buffer[r+3]<this.index)return!1;({index:t,parent:i}=s)}else({index:t,_parent:i}=this._tree);for(;i;{index:t,_parent:i}=i)if(t>-1)for(let r=t+e,o=e<0?-1:i._tree.children.length;r!=o;r+=e){let l=i._tree.children[r];if(this.mode&Z.IncludeAnonymous||l instanceof xt||!l.type.isAnonymous||hl(l))return!1}return!0}move(e,t){if(t&&this.enterChild(e,0,4))return!0;for(;;){if(this.sibling(e))return!0;if(this.atLastNode(e)||!this.parent())return!1}}next(e=!0){return this.move(1,e)}prev(e=!0){return this.move(-1,e)}moveTo(e,t=0){for(;(this.from==this.to||(t<1?this.from>=e:this.from>e)||(t>-1?this.to<=e:this.to<e))&&this.parent(););for(;this.enterChild(1,e,t););return this}get node(){if(!this.buffer)return this._tree;let e=this.bufferNode,t=null,i=0;if(e&&e.context==this.buffer)e:for(let s=this.index,r=this.stack.length;r>=0;){for(let o=e;o;o=o._parent)if(o.index==s){if(s==this.index)return o;t=o,i=r+1;break e}s=this.stack[--r]}for(let s=i;s<this.stack.length;s++)t=new sn(this.buffer,t,this.stack[s]);return this.bufferNode=new sn(this.buffer,t,this.index)}get tree(){return this.buffer?null:this._tree._tree}iterate(e,t){for(let i=0;;){let s=!1;if(this.type.isAnonymous||e(this)!==!1){if(this.firstChild()){i++;continue}this.type.isAnonymous||(s=!0)}for(;;){if(s&&t&&t(this),s=this.type.isAnonymous,!i)return;if(this.nextSibling())break;this.parent(),i--,s=!0}}}matchContext(e){if(!this.buffer)return rl(this.node.parent,e);let{buffer:t}=this.buffer,{types:i}=t.set;for(let s=e.length-1,r=this.stack.length-1;s>=0;r--){if(r<0)return rl(this._tree,e,s);let o=i[t.buffer[this.stack[r]]];if(!o.isAnonymous){if(e[s]&&e[s]!=o.name)return!1;s--}}return!0}};function hl(n){return n.children.some(e=>e instanceof xt||!e.type.isAnonymous||hl(e))}function fg(n){var e;let{buffer:t,nodeSet:i,maxBufferLength:s=1024,reused:r=[],minRepeatType:o=i.types.length}=n,l=Array.isArray(t)?new sl(t,t.length):t,a=i.types,h=0,c=0;function f(w,k,S,R,F,j){let{id:I,start:E,end:q,size:V}=l,X=c,ue=h;if(V<0)if(l.next(),V==-1){let st=r[I];S.push(st),R.push(E-w);return}else if(V==-3){h=I;return}else if(V==-4){c=I;return}else throw new RangeError(`Unrecognized record size: ${V}`);let De=a[I],Xe,ae,Ie=E-w;if(q-E<=s&&(ae=g(l.pos-k,F))){let st=new Uint16Array(ae.size-ae.skip),ye=l.pos-ae.size,Ke=st.length;for(;l.pos>ye;)Ke=y(ae.start,st,Ke);Xe=new xt(st,q-ae.start,i),Ie=ae.start-w}else{let st=l.pos-V;l.next();let ye=[],Ke=[],Je=I>=o?I:-1,rt=0,Jt=q,Oi=X;for(;l.pos>st;)Je>=0&&l.id==Je&&l.size>=0?(l.end<=Jt-s&&(p(ye,Ke,E,rt,l.end,Jt,Je,Oi,ue),rt=ye.length,Jt=l.end,Oi=c),l.next()):j>2500?u(E,st,ye,Ke):(Je>=0&&l.size==-1&&r[l.id].type==i.types[Je]&&(rt<ye.length&&p(ye,Ke,E,rt,l.end,Jt,Je,Oi,ue),rt=ye.length+1,Jt=l.start,Oi=c),f(E,st,ye,Ke,Je,j+1));if(Je>=0&&rt>0&&rt<ye.length&&p(ye,Ke,E,rt,E,Jt,Je,Oi,ue),ye.reverse(),Ke.reverse(),Je>-1&&rt>0){let za=d(De,ue);Xe=cl(De,ye,Ke,0,ye.length,0,q-E,za,za)}else Xe=m(De,ye,Ke,q-E,X-q,ue)}S.push(Xe),R.push(Ie)}function u(w,k,S,R){let F=[],j=0,I=-1;for(;l.pos>k;){let{id:E,start:q,end:V,size:X}=l;if(X>4)l.next();else{if(I>-1&&q<I)break;I<0&&(I=V-s),F.push(E,q,V),j++,l.next()}}if(j){let E=new Uint16Array(j*4),q=F[F.length-2];for(let V=F.length-3,X=0;V>=0;V-=3)E[X++]=F[V],E[X++]=F[V+1]-q,E[X++]=F[V+2]-q,E[X++]=X;S.push(new xt(E,F[2]-q,i)),R.push(q-w)}}function d(w,k){return(S,R,F)=>{let j=0,I=S.length-1,E,q;if(I>=0&&(E=S[I])instanceof Q){if(!I&&E.type==w&&E.length==F)return E;(q=E.prop(P.lookAhead))&&(j=R[I]+E.length+q-F)}return m(w,S,R,F,j,k)}}function p(w,k,S,R,F,j,I,E,q){let V=[],X=[];for(;w.length>R;)V.push(w.pop()),X.push(k.pop()+S-F);w.push(m(i.types[I],V,X,j-F,E-j,q)),k.push(F-S)}function m(w,k,S,R,F,j,I){if(j){let E=[P.contextHash,j];I=I?[E].concat(I):[E]}if(F>25){let E=[P.lookAhead,F];I=I?[E].concat(I):[E]}return new Q(w,k,S,R,I)}function g(w,k){let S=l.fork(),R=0,F=0,j=0,I=S.end-s,E={size:0,start:0,skip:0};e:for(let q=S.pos-w;S.pos>q;){let V=S.size;if(S.id==k&&V>=0){E.size=R,E.start=F,E.skip=j,j+=4,R+=4,S.next();continue}let X=S.pos-V;if(V<0||X<q||S.start<I)break;let ue=S.id>=o?4:0,De=S.start;for(S.next();S.pos>X;){if(S.size<0)if(S.size==-3||S.size==-4)ue+=4;else break e;else S.id>=o&&(ue+=4);S.next()}F=De,R+=V,j+=ue}return(k<0||R==w)&&(E.size=R,E.start=F,E.skip=j),E.size>4?E:void 0}function y(w,k,S){let{id:R,start:F,end:j,size:I}=l;if(l.next(),I>=0&&R<o){let E=S;if(I>4){let q=l.pos-(I-4);for(;l.pos>q;)S=y(w,k,S)}k[--S]=E,k[--S]=j-w,k[--S]=F-w,k[--S]=R}else I==-3?h=R:I==-4&&(c=R);return S}let v=[],x=[];for(;l.pos>0;)f(n.start||0,n.bufferStart||0,v,x,-1,0);let D=(e=n.length)!==null&&e!==void 0?e:v.length?x[0]+v[0].length:0;return new Q(a[n.topID],v.reverse(),x.reverse(),D)}var Cf=new WeakMap;function Ss(n,e){if(!n.isAnonymous||e instanceof xt||e.type!=n)return 1;let t=Cf.get(e);if(t==null){t=1;for(let i of e.children){if(i.type!=n||!(i instanceof Q)){t=1;break}t+=Ss(n,i)}Cf.set(e,t)}return t}function cl(n,e,t,i,s,r,o,l,a){let h=0;for(let p=i;p<s;p++)h+=Ss(n,e[p]);let c=Math.ceil(h*1.5/8),f=[],u=[];function d(p,m,g,y,v){for(let x=g;x<y;){let D=x,w=m[x],k=Ss(n,p[x]);for(x++;x<y;x++){let S=Ss(n,p[x]);if(k+S>=c)break;k+=S}if(x==D+1){if(k>c){let S=p[D];d(S.children,S.positions,0,S.children.length,m[D]+v);continue}f.push(p[D])}else{let S=m[x-1]+p[x-1].length-w;f.push(cl(n,p,m,D,x,w,S,null,a))}u.push(w+v-r)}}return d(e,t,i,s,0),(l||a)(f,u,o)}var zt=class n{constructor(e,t,i,s,r=!1,o=!1){this.from=e,this.to=t,this.tree=i,this.offset=s,this.open=(r?1:0)|(o?2:0)}get openStart(){return(this.open&1)>0}get openEnd(){return(this.open&2)>0}static addTree(e,t=[],i=!1){let s=[new n(0,e.length,e,0,!1,i)];for(let r of t)r.to>e.length&&s.push(r);return s}static applyChanges(e,t,i=128){if(!t.length)return e;let s=[],r=1,o=e.length?e[0]:null;for(let l=0,a=0,h=0;;l++){let c=l<t.length?t[l]:null,f=c?c.fromA:1e9;if(f-a>=i)for(;o&&o.from<f;){let u=o;if(a>=u.from||f<=u.to||h){let d=Math.max(u.from,a)-h,p=Math.min(u.to,f)-h;u=d>=p?null:new n(d,p,u.tree,u.offset+h,l>0,!!c)}if(u&&s.push(u),o.to>f)break;o=r<e.length?e[r++]:null}if(!c)break;a=c.toA,h=c.toA-c.toB}return s}},on=class{startParse(e,t,i){return typeof e=="string"&&(e=new al(e)),i=i?i.length?i.map(s=>new tn(s.from,s.to)):[new tn(0,0)]:[new tn(0,e.length)],this.createParse(e,t||[],i)}parse(e,t,i){let s=this.startParse(e,t,i);for(;;){let r=s.advance();if(r)return r}}},al=class{constructor(e){this.string=e}get length(){return this.string.length}chunk(e){return this.string.slice(e)}get lineChunks(){return!1}read(e,t){return this.string.slice(e,t)}};var Eb=new P({perNode:!0});var ug=0,Ee=class n{constructor(e,t,i,s){this.name=e,this.set=t,this.base=i,this.modified=s,this.id=ug++}toString(){let{name:e}=this;for(let t of this.modified)t.name&&(e=`${t.name}(${e})`);return e}static define(e,t){let i=typeof e=="string"?e:"?";if(e instanceof n&&(t=e),t?.base)throw new Error("Can not derive from a modified tag");let s=new n(i,[],null,[]);if(s.set.push(s),t)for(let r of t.set)s.set.push(r);return s}static defineModifier(e){let t=new Os(e);return i=>i.modified.indexOf(t)>-1?i:Os.get(i.base||i,i.modified.concat(t).sort((s,r)=>s.id-r.id))}},dg=0,Os=class n{constructor(e){this.name=e,this.instances=[],this.id=dg++}static get(e,t){if(!t.length)return e;let i=t[0].instances.find(l=>l.base==e&&pg(t,l.modified));if(i)return i;let s=[],r=new Ee(e.name,s,e,t);for(let l of t)l.instances.push(r);let o=mg(t);for(let l of e.set)if(!l.modified.length)for(let a of o)s.push(n.get(l,a));return r}};function pg(n,e){return n.length==e.length&&n.every((t,i)=>t==e[i])}function mg(n){let e=[[]];for(let t=0;t<n.length;t++)for(let i=0,s=e.length;i<s;i++)e.push(e[i].concat(n[t]));return e.sort((t,i)=>i.length-t.length)}function Of(n){let e=Object.create(null);for(let t in n){let i=n[t];Array.isArray(i)||(i=[i]);for(let s of t.split(" "))if(s){let r=[],o=2,l=s;for(let f=0;;){if(l=="..."&&f>0&&f+3==s.length){o=1;break}let u=/^"(?:[^"\\]|\\.)*?"|[^\/!]+/.exec(l);if(!u)throw new RangeError("Invalid path: "+s);if(r.push(u[0]=="*"?"":u[0][0]=='"'?JSON.parse(u[0]):u[0]),f+=u[0].length,f==s.length)break;let d=s[f++];if(f==s.length&&d=="!"){o=0;break}if(d!="/")throw new RangeError("Invalid path: "+s);l=s.slice(f)}let a=r.length-1,h=r[a];if(!h)throw new RangeError("Invalid path: "+s);let c=new Kt(i,o,a>0?r.slice(0,a):null);e[h]=c.sort(e[h])}}return Bf.add(e)}var Bf=new P({combine(n,e){let t,i,s;for(;n||e;){if(!n||e&&n.depth<=e.depth?(s=e,e=e.next):(s=n,n=n.next),t&&t.mode==s.mode&&!s.context&&!t.context)continue;let r=new Kt(s.tags,s.mode,s.context);t?t.next=r:i=r,t=r}return i}}),Kt=class{constructor(e,t,i,s){this.tags=e,this.mode=t,this.context=i,this.next=s}get opaque(){return this.mode==0}get inherit(){return this.mode==1}sort(e){return!e||e.depth<this.depth?(this.next=e,this):(e.next=this.sort(e.next),e)}get depth(){return this.context?this.context.length:0}};Kt.empty=new Kt([],2,null);function pl(n,e){let t=Object.create(null);for(let r of n)if(!Array.isArray(r.tag))t[r.tag.id]=r.class;else for(let o of r.tag)t[o.id]=r.class;let{scope:i,all:s=null}=e||{};return{style:r=>{let o=s;for(let l of r)for(let a of l.set){let h=t[a.id];if(h){o=o?o+" "+h:h;break}}return o},scope:i}}function gg(n,e){let t=null;for(let i of n){let s=i.style(e);s&&(t=t?t+" "+s:s)}return t}function Lf(n,e,t,i=0,s=n.length){let r=new ul(i,Array.isArray(e)?e:[e],t);r.highlightRange(n.cursor(),i,s,"",r.highlighters),r.flush(s)}var ul=class{constructor(e,t,i){this.at=e,this.highlighters=t,this.span=i,this.class=""}startSpan(e,t){t!=this.class&&(this.flush(e),e>this.at&&(this.at=e),this.class=t)}flush(e){e>this.at&&this.class&&this.span(this.at,e,this.class)}highlightRange(e,t,i,s,r){let{type:o,from:l,to:a}=e;if(l>=i||a<=t)return;o.isTop&&(r=this.highlighters.filter(d=>!d.scope||d.scope(o)));let h=s,c=yg(e)||Kt.empty,f=gg(r,c.tags);if(f&&(h&&(h+=" "),h+=f,c.mode==1&&(s+=(s?" ":"")+f)),this.startSpan(Math.max(t,l),h),c.opaque)return;let u=e.tree&&e.tree.prop(P.mounted);if(u&&u.overlay){let d=e.node.enter(u.overlay[0].from+l,1),p=this.highlighters.filter(g=>!g.scope||g.scope(u.tree.type)),m=e.firstChild();for(let g=0,y=l;;g++){let v=g<u.overlay.length?u.overlay[g]:null,x=v?v.from+l:a,D=Math.max(t,y),w=Math.min(i,x);if(D<w&&m)for(;e.from<w&&(this.highlightRange(e,D,w,s,r),this.startSpan(Math.min(w,e.to),h),!(e.to>=x||!e.nextSibling())););if(!v||x>i)break;y=v.to+l,y>t&&(this.highlightRange(d.cursor(),Math.max(t,v.from+l),Math.min(i,y),"",p),this.startSpan(Math.min(i,y),h))}m&&e.parent()}else if(e.firstChild()){u&&(s="");do if(!(e.to<=t)){if(e.from>=i)break;this.highlightRange(e,t,i,s,r),this.startSpan(Math.min(i,e.to),h)}while(e.nextSibling());e.parent()}}};function yg(n){let e=n.type.prop(Bf);for(;e&&e.context&&!n.matchContext(e.context);)e=e.next;return e||null}var A=Ee.define,Ms=A(),wt=A(),Tf=A(wt),Df=A(wt),vt=A(),Ts=A(vt),fl=A(vt),nt=A(),qt=A(nt),tt=A(),it=A(),dl=A(),ln=A(dl),Ds=A(),T={comment:Ms,lineComment:A(Ms),blockComment:A(Ms),docComment:A(Ms),name:wt,variableName:A(wt),typeName:Tf,tagName:A(Tf),propertyName:Df,attributeName:A(Df),className:A(wt),labelName:A(wt),namespace:A(wt),macroName:A(wt),literal:vt,string:Ts,docString:A(Ts),character:A(Ts),attributeValue:A(Ts),number:fl,integer:A(fl),float:A(fl),bool:A(vt),regexp:A(vt),escape:A(vt),color:A(vt),url:A(vt),keyword:tt,self:A(tt),null:A(tt),atom:A(tt),unit:A(tt),modifier:A(tt),operatorKeyword:A(tt),controlKeyword:A(tt),definitionKeyword:A(tt),moduleKeyword:A(tt),operator:it,derefOperator:A(it),arithmeticOperator:A(it),logicOperator:A(it),bitwiseOperator:A(it),compareOperator:A(it),updateOperator:A(it),definitionOperator:A(it),typeOperator:A(it),controlOperator:A(it),punctuation:dl,separator:A(dl),bracket:ln,angleBracket:A(ln),squareBracket:A(ln),paren:A(ln),brace:A(ln),content:nt,heading:qt,heading1:A(qt),heading2:A(qt),heading3:A(qt),heading4:A(qt),heading5:A(qt),heading6:A(qt),contentSeparator:A(nt),list:A(nt),quote:A(nt),emphasis:A(nt),strong:A(nt),link:A(nt),monospace:A(nt),strikethrough:A(nt),inserted:A(),deleted:A(),changed:A(),invalid:A(),meta:Ds,documentMeta:A(Ds),annotation:A(Ds),processingInstruction:A(Ds),definition:Ee.defineModifier("definition"),constant:Ee.defineModifier("constant"),function:Ee.defineModifier("function"),standard:Ee.defineModifier("standard"),local:Ee.defineModifier("local"),special:Ee.defineModifier("special")};for(let n in T){let e=T[n];e instanceof Ee&&(e.name=n)}var Ib=pl([{tag:T.link,class:"tok-link"},{tag:T.heading,class:"tok-heading"},{tag:T.emphasis,class:"tok-emphasis"},{tag:T.strong,class:"tok-strong"},{tag:T.keyword,class:"tok-keyword"},{tag:T.atom,class:"tok-atom"},{tag:T.bool,class:"tok-bool"},{tag:T.url,class:"tok-url"},{tag:T.labelName,class:"tok-labelName"},{tag:T.inserted,class:"tok-inserted"},{tag:T.deleted,class:"tok-deleted"},{tag:T.literal,class:"tok-literal"},{tag:T.string,class:"tok-string"},{tag:T.number,class:"tok-number"},{tag:[T.regexp,T.escape,T.special(T.string)],class:"tok-string2"},{tag:T.variableName,class:"tok-variableName"},{tag:T.local(T.variableName),class:"tok-variableName tok-local"},{tag:T.definition(T.variableName),class:"tok-variableName tok-definition"},{tag:T.special(T.variableName),class:"tok-variableName2"},{tag:T.definition(T.propertyName),class:"tok-propertyName tok-definition"},{tag:T.typeName,class:"tok-typeName"},{tag:T.namespace,class:"tok-namespace"},{tag:T.className,class:"tok-className"},{tag:T.macroName,class:"tok-macroName"},{tag:T.propertyName,class:"tok-propertyName"},{tag:T.operator,class:"tok-operator"},{tag:T.comment,class:"tok-comment"},{tag:T.meta,class:"tok-meta"},{tag:T.invalid,class:"tok-invalid"},{tag:T.punctuation,class:"tok-punctuation"}]);function Ef(n,e,t,i=0,s=0){e==null&&(e=n.search(/[^\s\u00a0]/),e==-1&&(e=n.length));let r=s;for(let o=i;o<e;o++)n.charCodeAt(o)==9?r+=t-r%t:r++;return r}var an=class{constructor(e,t,i,s){this.string=e,this.tabSize=t,this.indentUnit=i,this.overrideIndent=s,this.pos=0,this.start=0,this.lastColumnPos=0,this.lastColumnValue=0}eol(){return this.pos>=this.string.length}sol(){return this.pos==0}peek(){return this.string.charAt(this.pos)||void 0}next(){if(this.pos<this.string.length)return this.string.charAt(this.pos++)}eat(e){let t=this.string.charAt(this.pos),i;if(typeof e=="string"?i=t==e:i=t&&(e instanceof RegExp?e.test(t):e(t)),i)return++this.pos,t}eatWhile(e){let t=this.pos;for(;this.eat(e););return this.pos>t}eatSpace(){let e=this.pos;for(;/[\s\u00a0]/.test(this.string.charAt(this.pos));)++this.pos;return this.pos>e}skipToEnd(){this.pos=this.string.length}skipTo(e){let t=this.string.indexOf(e,this.pos);if(t>-1)return this.pos=t,!0}backUp(e){this.pos-=e}column(){return this.lastColumnPos<this.start&&(this.lastColumnValue=Ef(this.string,this.start,this.tabSize,this.lastColumnPos,this.lastColumnValue),this.lastColumnPos=this.start),this.lastColumnValue}indentation(){var e;return(e=this.overrideIndent)!==null&&e!==void 0?e:Ef(this.string,null,this.tabSize)}match(e,t,i){if(typeof e=="string"){let s=o=>i?o.toLowerCase():o,r=this.string.substr(this.pos,e.length);return s(r)==s(e)?(t!==!1&&(this.pos+=e.length),!0):null}else{let s=this.string.slice(this.pos).match(e);return s&&s.index>0?null:(s&&t!==!1&&(this.pos+=s[0].length),s)}}current(){return this.string.slice(this.start,this.pos)}};var ml,ki=new P;function bg(n){return C.define({combine:n?e=>e.concat(n):void 0})}var xg=new P,Re=class{constructor(e,t,i=[],s=""){this.data=e,this.name=s,U.prototype.hasOwnProperty("tree")||Object.defineProperty(U.prototype,"tree",{get(){return oe(this)}}),this.parser=t,this.extension=[kt.of(this),U.languageData.of((r,o,l)=>{let a=Rf(r,o,l),h=a.type.prop(ki);if(!h)return[];let c=r.facet(h),f=a.type.prop(xg);if(f){let u=a.resolve(o-a.from,l);for(let d of f)if(d.test(u,r)){let p=r.facet(d.facet);return d.type=="replace"?p:p.concat(c)}}return c})].concat(i)}isActiveAt(e,t,i=-1){return Rf(e,t,i).type.prop(ki)==this.data}findRegions(e){let t=e.facet(kt);if(t?.data==this.data)return[{from:0,to:e.doc.length}];if(!t||!t.allowsNesting)return[];let i=[],s=(r,o)=>{if(r.prop(ki)==this.data){i.push({from:o,to:o+r.length});return}let l=r.prop(P.mounted);if(l){if(l.tree.prop(ki)==this.data){if(l.overlay)for(let a of l.overlay)i.push({from:a.from+o,to:a.to+o});else i.push({from:o,to:o+r.length});return}else if(l.overlay){let a=i.length;if(s(l.tree,l.overlay[0].from+o),i.length>a)return}}for(let a=0;a<r.children.length;a++){let h=r.children[a];h instanceof Q&&s(h,r.positions[a]+o)}};return s(oe(e),0),i}get allowsNesting(){return!0}};Re.setState=L.define();function Rf(n,e,t){let i=n.facet(kt),s=oe(n).topNode;if(!i||i.allowsNesting)for(let r=s;r;r=r.enter(e,t,Z.ExcludeBuffers|Z.EnterBracketed))r.type.isTop&&(s=r);return s}function oe(n){let e=n.field(Re.state,!1);return e?e.tree:Q.empty}var xl=class{constructor(e){this.doc=e,this.cursorPos=0,this.string="",this.cursor=e.iter()}get length(){return this.doc.length}syncTo(e){return this.string=this.cursor.next(e-this.cursorPos).value,this.cursorPos=e+this.string.length,this.cursorPos-this.string.length}chunk(e){return this.syncTo(e),this.string}get lineChunks(){return!0}read(e,t){let i=this.cursorPos-this.string.length;return e<i||t>=this.cursorPos?this.doc.sliceString(e,t):this.string.slice(e-i,t-i)}},hn=null,fn=class n{constructor(e,t,i=[],s,r,o,l,a){this.parser=e,this.state=t,this.fragments=i,this.tree=s,this.treeLen=r,this.viewport=o,this.skipped=l,this.scheduleOn=a,this.parse=null,this.tempSkipped=[]}static create(e,t,i){return new n(e,t,[],Q.empty,0,i,[],null)}startParse(){return this.parser.startParse(new xl(this.state.doc),this.fragments)}work(e,t){return t!=null&&t>=this.state.doc.length&&(t=void 0),this.tree!=Q.empty&&this.isDone(t??this.state.doc.length)?(this.takeTree(),!0):this.withContext(()=>{var i;if(typeof e=="number"){let s=Date.now()+e;e=()=>Date.now()>s}for(this.parse||(this.parse=this.startParse()),t!=null&&(this.parse.stoppedAt==null||this.parse.stoppedAt>t)&&t<this.state.doc.length&&this.parse.stopAt(t);;){let s=this.parse.advance();if(s)if(this.fragments=this.withoutTempSkipped(zt.addTree(s,this.fragments,this.parse.stoppedAt!=null)),this.treeLen=(i=this.parse.stoppedAt)!==null&&i!==void 0?i:this.state.doc.length,this.tree=s,this.parse=null,this.treeLen<(t??this.state.doc.length))this.parse=this.startParse();else return!0;if(e())return!1}})}takeTree(){let e,t;this.parse&&(e=this.parse.parsedPos)>=this.treeLen&&((this.parse.stoppedAt==null||this.parse.stoppedAt>e)&&this.parse.stopAt(e),this.withContext(()=>{for(;!(t=this.parse.advance()););}),this.treeLen=e,this.tree=t,this.fragments=this.withoutTempSkipped(zt.addTree(this.tree,this.fragments,!0)),this.parse=null)}withContext(e){let t=hn;hn=this;try{return e()}finally{hn=t}}withoutTempSkipped(e){for(let t;t=this.tempSkipped.pop();)e=Pf(e,t.from,t.to);return e}changes(e,t){let{fragments:i,tree:s,treeLen:r,viewport:o,skipped:l}=this;if(this.takeTree(),!e.empty){let a=[];if(e.iterChangedRanges((h,c,f,u)=>a.push({fromA:h,toA:c,fromB:f,toB:u})),i=zt.applyChanges(i,a),s=Q.empty,r=0,o={from:e.mapPos(o.from,-1),to:e.mapPos(o.to,1)},this.skipped.length){l=[];for(let h of this.skipped){let c=e.mapPos(h.from,1),f=e.mapPos(h.to,-1);c<f&&l.push({from:c,to:f})}}}return new n(this.parser,t,i,s,r,o,l,this.scheduleOn)}updateViewport(e){if(this.viewport.from==e.from&&this.viewport.to==e.to)return!1;this.viewport=e;let t=this.skipped.length;for(let i=0;i<this.skipped.length;i++){let{from:s,to:r}=this.skipped[i];s<e.to&&r>e.from&&(this.fragments=Pf(this.fragments,s,r),this.skipped.splice(i--,1))}return this.skipped.length>=t?!1:(this.reset(),!0)}reset(){this.parse&&(this.takeTree(),this.parse=null)}skipUntilInView(e,t){this.skipped.push({from:e,to:t})}static getSkippingParser(e){return new class extends on{createParse(t,i,s){let r=s[0].from,o=s[s.length-1].to;return{parsedPos:r,advance(){let a=hn;if(a){for(let h of s)a.tempSkipped.push(h);e&&(a.scheduleOn=a.scheduleOn?Promise.all([a.scheduleOn,e]):e)}return this.parsedPos=o,new Q(ke.none,[],[],o-r)},stoppedAt:null,stopAt(){}}}}}isDone(e){e=Math.min(e,this.state.doc.length);let t=this.fragments;return this.treeLen>=e&&t.length&&t[0].from==0&&t[0].to>=e}static get(){return hn}};function Pf(n,e,t){return zt.applyChanges(n,[{fromA:e,toA:t,fromB:e,toB:t}])}var un=class n{constructor(e){this.context=e,this.tree=e.tree}apply(e){if(!e.docChanged&&this.tree==this.context.tree)return this;let t=this.context.changes(e.changes,e.state),i=this.context.treeLen==e.startState.doc.length?void 0:Math.max(e.changes.mapPos(this.context.treeLen),t.viewport.to);return t.work(20,i)||t.takeTree(),new n(t)}static init(e){let t=Math.min(3e3,e.doc.length),i=fn.create(e.facet(kt).parser,e,{from:0,to:t});return i.work(20,t)||i.takeTree(),new n(i)}};Re.state=_.define({create:un.init,update(n,e){for(let t of e.effects)if(t.is(Re.setState))return t.value;return e.startState.facet(kt)!=e.state.facet(kt)?un.init(e.state):n.apply(e)}});var zf=n=>{let e=setTimeout(()=>n(),500);return()=>clearTimeout(e)};typeof requestIdleCallback<"u"&&(zf=n=>{let e=-1,t=setTimeout(()=>{e=requestIdleCallback(n,{timeout:400})},100);return()=>e<0?clearTimeout(t):cancelIdleCallback(e)});var gl=typeof navigator<"u"&&(!((ml=navigator.scheduling)===null||ml===void 0)&&ml.isInputPending)?()=>navigator.scheduling.isInputPending():null,wg=K.fromClass(class{constructor(e){this.view=e,this.working=null,this.workScheduled=0,this.chunkEnd=-1,this.chunkBudget=-1,this.work=this.work.bind(this),this.scheduleWork()}update(e){let t=this.view.state.field(Re.state).context;(t.updateViewport(e.view.viewport)||this.view.viewport.to>t.treeLen)&&this.scheduleWork(),(e.docChanged||e.selectionSet)&&(this.view.hasFocus&&(this.chunkBudget+=50),this.scheduleWork()),this.checkAsyncSchedule(t)}scheduleWork(){if(this.working)return;let{state:e}=this.view,t=e.field(Re.state);(t.tree!=t.context.tree||!t.context.isDone(e.doc.length))&&(this.working=zf(this.work))}work(e){this.working=null;let t=Date.now();if(this.chunkEnd<t&&(this.chunkEnd<0||this.view.hasFocus)&&(this.chunkEnd=t+3e4,this.chunkBudget=3e3),this.chunkBudget<=0)return;let{state:i,viewport:{to:s}}=this.view,r=i.field(Re.state);if(r.tree==r.context.tree&&r.context.isDone(s+1e5))return;let o=Date.now()+Math.min(this.chunkBudget,100,e&&!gl?Math.max(25,e.timeRemaining()-5):1e9),l=r.context.treeLen<s&&i.doc.length>s+1e3,a=r.context.work(()=>gl&&gl()||Date.now()>o,s+(l?0:1e5));this.chunkBudget-=Date.now()-t,(a||this.chunkBudget<=0)&&(r.context.takeTree(),this.view.dispatch({effects:Re.setState.of(new un(r.context))})),this.chunkBudget>0&&!(a&&!l)&&this.scheduleWork(),this.checkAsyncSchedule(r.context)}checkAsyncSchedule(e){e.scheduleOn&&(this.workScheduled++,e.scheduleOn.then(()=>this.scheduleWork()).catch(t=>ce(this.view.state,t)).then(()=>this.workScheduled--),e.scheduleOn=null)}destroy(){this.working&&this.working()}isWorking(){return!!(this.working||this.workScheduled>0)}},{eventHandlers:{focus(){this.scheduleWork()}}}),kt=C.define({combine(n){return n.length?n[0]:null},enables:n=>[Re.state,wg,O.contentAttributes.compute([n],e=>{let t=e.facet(n);return t&&t.name?{"data-language":t.name}:{}})]});var vg=C.define(),Ct=C.define({combine:n=>{if(!n.length)return"  ";let e=n[0];if(!e||/\S/.test(e)||Array.from(e).some(t=>t!=e[0]))throw new Error("Invalid indent unit: "+JSON.stringify(n[0]));return e}});function St(n){let e=n.facet(Ct);return e.charCodeAt(0)==9?n.tabSize*e.length:e.length}function Ci(n,e){let t="",i=n.tabSize,s=n.facet(Ct)[0];if(s=="	"){for(;e>=i;)t+="	",e-=i;s=" "}for(let r=0;r<e;r++)t+=s;return t}function Ps(n,e){n instanceof U&&(n=new $t(n));for(let i of n.state.facet(vg)){let s=i(n,e);if(s!==void 0)return s}let t=oe(n.state);return t.length>=e?kg(n,t,e):null}var $t=class{constructor(e,t={}){this.state=e,this.options=t,this.unit=St(e)}lineAt(e,t=1){let i=this.state.doc.lineAt(e),{simulateBreak:s,simulateDoubleBreak:r}=this.options;return s!=null&&s>=i.from&&s<=i.to?r&&s==e?{text:"",from:e}:(t<0?s<e:s<=e)?{text:i.text.slice(s-i.from),from:s}:{text:i.text.slice(0,s-i.from),from:i.from}:i}textAfterPos(e,t=1){if(this.options.simulateDoubleBreak&&e==this.options.simulateBreak)return"";let{text:i,from:s}=this.lineAt(e,t);return i.slice(e-s,Math.min(i.length,e+100-s))}column(e,t=1){let{text:i,from:s}=this.lineAt(e,t),r=this.countColumn(i,e-s),o=this.options.overrideIndentation?this.options.overrideIndentation(s):-1;return o>-1&&(r+=o-this.countColumn(i,i.search(/\S|$/))),r}countColumn(e,t=e.length){return lt(e,this.state.tabSize,t)}lineIndent(e,t=1){let{text:i,from:s}=this.lineAt(e,t),r=this.options.overrideIndentation;if(r){let o=r(s);if(o>-1)return o}return this.countColumn(i,i.search(/\S|$/))}get simulatedBreak(){return this.options.simulateBreak||null}},qf=new P;function kg(n,e,t){let i=e.resolveStack(t),s=e.resolveInner(t,-1).resolve(t,0).enterUnfinishedNodesBefore(t);if(s!=i.node){let r=[];for(let o=s;o&&!(o.from<i.node.from||o.to>i.node.to||o.from==i.node.from&&o.type==i.node.type);o=o.parent)r.push(o);for(let o=r.length-1;o>=0;o--)i={node:r[o],next:i}}return Kf(i,n,t)}function Kf(n,e,t){for(let i=n;i;i=i.next){let s=Cg(i.node);if(s)return s(wl.create(e,t,i))}return 0}function Sg(n){return n.pos==n.options.simulateBreak&&n.options.simulateDoubleBreak}function Cg(n){let e=n.type.prop(qf);if(e)return e;let t=n.firstChild,i;if(t&&(i=t.type.prop(P.closedBy))){let s=n.lastChild,r=s&&i.indexOf(s.name)>-1;return o=>Dg(o,!0,1,void 0,r&&!Sg(o)?s.from:void 0)}return n.parent==null?Ag:null}function Ag(){return 0}var wl=class n extends $t{constructor(e,t,i){super(e.state,e.options),this.base=e,this.pos=t,this.context=i}get node(){return this.context.node}static create(e,t,i){return new n(e,t,i)}get textAfter(){return this.textAfterPos(this.pos)}get baseIndent(){return this.baseIndentFor(this.node)}baseIndentFor(e){let t=this.state.doc.lineAt(e.from);for(;;){let i=e.resolve(t.from);for(;i.parent&&i.parent.from==i.from;)i=i.parent;if(Mg(i,e))break;t=this.state.doc.lineAt(i.from)}return this.lineIndent(t.from)}continue(){return Kf(this.context.next,this.base,this.pos)}};function Mg(n,e){for(let t=e;t;t=t.parent)if(n==t)return!0;return!1}function Tg(n){let e=n.node,t=e.childAfter(e.from),i=e.lastChild;if(!t)return null;let s=n.options.simulateBreak,r=n.state.doc.lineAt(t.from),o=s==null||s<=r.from?r.to:Math.min(r.to,s);for(let l=t.to;;){let a=e.childAfter(l);if(!a||a==i)return null;if(!a.type.isSkipped){if(a.from>=o)return null;let h=/^ */.exec(r.text.slice(t.to-r.from))[0].length;return{from:t.from,to:t.to+h}}l=a.to}}function Dg(n,e,t,i,s){let r=n.textAfter,o=r.match(/^\s*/)[0].length,l=i&&r.slice(o,o+i.length)==i||s==n.pos+o,a=e?Tg(n):null;return a?l?n.column(a.from):n.column(a.to):n.baseIndent+(l?0:n.unit*t)}var Og=200;function $f(){return U.transactionFilter.of(n=>{if(!n.docChanged||!n.isUserEvent("input.type")&&!n.isUserEvent("input.complete"))return n;let e=n.startState.languageDataAt("indentOnInput",n.startState.selection.main.head);if(!e.length)return n;let t=n.newDoc,{head:i}=n.newSelection.main,s=t.lineAt(i);if(i>s.from+Og)return n;let r=t.sliceString(s.from,i);if(!e.some(h=>h.test(r)))return n;let{state:o}=n,l=-1,a=[];for(let{head:h}of o.selection.ranges){let c=o.doc.lineAt(h);if(c.from==l)continue;l=c.from;let f=Ps(o,c.from);if(f==null)continue;let u=/^\s*/.exec(c.text)[0],d=Ci(o,f);u!=d&&a.push({from:c.from,to:c.from+u.length,insert:d})}return a.length?[n,{changes:a,sequential:!0}]:n})}var Tl=C.define(),Bg=new P;function Lg(n,e,t){let i=oe(n);if(i.length<t)return null;let s=i.resolveStack(t,1),r=null;for(let o=s;o;o=o.next){let l=o.node;if(l.to<=t||l.from>t)continue;if(r&&l.from<e)break;let a=l.type.prop(Bg);if(a&&(l.to<i.length-50||i.length==n.doc.length||!Eg(l))){let h=a(l,n);h&&h.from<=t&&h.from>=e&&h.to>t&&(r=h)}}return r}function Eg(n){let e=n.lastChild;return e&&e.to==n.to&&e.type.isError}function Bs(n,e,t){for(let i of n.facet(Tl)){let s=i(n,e,t);if(s)return s}return Lg(n,e,t)}function jf(n,e){let t=e.mapPos(n.from,1),i=e.mapPos(n.to,-1);return t>=i?void 0:{from:t,to:i}}var Is=L.define({map:jf}),pn=L.define({map:jf});function Uf(n){let e=[];for(let{head:t}of n.state.selection.ranges)e.some(i=>i.from<=t&&i.to>=t)||e.push(n.lineBlockAt(t));return e}var jt=_.define({create(){return B.none},update(n,e){e.isUserEvent("delete")&&e.changes.iterChangedRanges((i,s)=>n=If(n,i,s)),n=n.map(e.changes);let t=[];for(let i of e.effects)i.is(Is)&&!Rg(n,i.value.from,i.value.to)?t.push(i.value):i.is(pn)&&(n=n.update({filter:(s,r)=>i.value.from!=s||i.value.to!=r,filterFrom:i.value.from,filterTo:i.value.to}));if(t.length){let{preparePlaceholder:i}=e.state.facet(El),s=t.map(r=>(i?B.replace({widget:new vl(i(e.state,r))}):Nf).range(r.from,r.to));n=n.update({add:s})}return e.selection&&(n=If(n,e.selection.main.head)),n},provide:n=>O.decorations.from(n),toJSON(n,e){let t=[];return n.between(0,e.doc.length,(i,s)=>{t.push(i,s)}),t},fromJSON(n){if(!Array.isArray(n)||n.length%2)throw new RangeError("Invalid JSON for fold state");let e=[];for(let t=0;t<n.length;){let i=n[t++],s=n[t++];if(typeof i!="number"||typeof s!="number")throw new RangeError("Invalid JSON for fold state");e.push(Nf.range(i,s))}return B.set(e,!0)}});function If(n,e,t=e){let i=!1;return n.between(e,t,(s,r)=>{s<t&&r>e&&(i=!0)}),i?n.update({filterFrom:e,filterTo:t,filter:(s,r)=>s>=t||r<=e}):n}function Ls(n,e,t){var i;let s=null;return(i=n.field(jt,!1))===null||i===void 0||i.between(e,t,(r,o)=>{(!s||s.from>r)&&(s={from:r,to:o})}),s}function Rg(n,e,t){let i=!1;return n.between(e,e,(s,r)=>{s==e&&r==t&&(i=!0)}),i}function Gf(n,e){return n.field(jt,!1)?e:e.concat(L.appendConfig.of(Ns()))}var Dl=n=>{for(let e of Uf(n)){let t=Bs(n.state,e.from,e.to);if(t)return n.dispatch({effects:Gf(n.state,[Is.of(t),_f(n,t)])}),!0}return!1},Ol=n=>{if(!n.state.field(jt,!1))return!1;let e=[];for(let t of Uf(n)){let i=Ls(n.state,t.from,t.to);i&&e.push(pn.of(i),_f(n,i,!1))}return e.length&&n.dispatch({effects:e}),e.length>0};function _f(n,e,t=!0){let i=n.state.doc.lineAt(e.from).number,s=n.state.doc.lineAt(e.to).number;return O.announce.of(`${n.state.phrase(t?"Folded lines":"Unfolded lines")} ${i} ${n.state.phrase("to")} ${s}.`)}var Bl=n=>{let{state:e}=n,t=[];for(let i=0;i<e.doc.length;){let s=n.lineBlockAt(i),r=Bs(e,s.from,s.to);r&&t.push(Is.of(r)),i=(r?n.lineBlockAt(r.to):s).to+1}return t.length&&n.dispatch({effects:Gf(n.state,t)}),!!t.length},Ll=n=>{let e=n.state.field(jt,!1);if(!e||!e.size)return!1;let t=[];return e.between(0,n.state.doc.length,(i,s)=>{t.push(pn.of({from:i,to:s}))}),n.dispatch({effects:t}),!0};var Yf=[{key:"Ctrl-Shift-[",mac:"Cmd-Alt-[",run:Dl},{key:"Ctrl-Shift-]",mac:"Cmd-Alt-]",run:Ol},{key:"Ctrl-Alt-[",run:Bl},{key:"Ctrl-Alt-]",run:Ll}],Pg={placeholderDOM:null,preparePlaceholder:null,placeholderText:"\u2026"},El=C.define({combine(n){return me(n,Pg)}});function Ns(n){let e=[jt,Ng];return n&&e.push(El.of(n)),e}function Xf(n,e){let{state:t}=n,i=t.facet(El),s=o=>{let l=n.lineBlockAt(n.posAtDOM(o.target)),a=Ls(n.state,l.from,l.to);a&&n.dispatch({effects:pn.of(a)}),o.preventDefault()};if(i.placeholderDOM)return i.placeholderDOM(n,s,e);let r=document.createElement("span");return r.textContent=i.placeholderText,r.setAttribute("aria-label",t.phrase("folded code")),r.title=t.phrase("unfold"),r.className="cm-foldPlaceholder",r.onclick=s,r}var Nf=B.replace({widget:new class extends re{toDOM(n){return Xf(n,null)}}}),vl=class extends re{constructor(e){super(),this.value=e}eq(e){return this.value==e.value}toDOM(e){return Xf(e,this.value)}},Ig={openText:"\u2304",closedText:"\u203A",markerDOM:null,domEventHandlers:{},foldingChanged:()=>!1},cn=class extends Ae{constructor(e,t){super(),this.config=e,this.open=t}eq(e){return this.config==e.config&&this.open==e.open}toDOM(e){if(this.config.markerDOM)return this.config.markerDOM(this.open);let t=document.createElement("span");return t.textContent=this.open?this.config.openText:this.config.closedText,t.title=e.state.phrase(this.open?"Fold line":"Unfold line"),t}};function Jf(n={}){let e={...Ig,...n},t=new cn(e,!0),i=new cn(e,!1),s=K.fromClass(class{constructor(o){this.from=o.viewport.from,this.markers=this.buildMarkers(o)}update(o){(o.docChanged||o.viewportChanged||o.startState.facet(kt)!=o.state.facet(kt)||o.startState.field(jt,!1)!=o.state.field(jt,!1)||oe(o.startState)!=oe(o.state)||e.foldingChanged(o))&&(this.markers=this.buildMarkers(o.view))}buildMarkers(o){let l=new pe;for(let a of o.viewportLineBlocks){let h=Ls(o.state,a.from,a.to)?i:Bs(o.state,a.from,a.to)?t:null;h&&l.add(a.from,a.from,h)}return l.finish()}}),{domEventHandlers:r}=e;return[s,vs({class:"cm-foldGutter",markers(o){var l;return((l=o.plugin(s))===null||l===void 0?void 0:l.markers)||H.empty},initialSpacer(){return new cn(e,!1)},domEventHandlers:{...r,click:(o,l,a)=>{if(r.click&&r.click(o,l,a))return!0;let h=Ls(o.state,l.from,l.to);if(h)return o.dispatch({effects:pn.of(h)}),!0;let c=Bs(o.state,l.from,l.to);return c?(o.dispatch({effects:Is.of(c)}),!0):!1}}}),Ns()]}var Ng=O.baseTheme({".cm-foldPlaceholder":{backgroundColor:"#eee",border:"1px solid #ddd",color:"#888",borderRadius:".2em",margin:"0 1px",padding:"0 1px",cursor:"pointer"},".cm-foldGutter span":{padding:"0 1px",cursor:"pointer"}}),Si=class n{constructor(e,t){this.specs=e;let i;function s(l){let a=Fe.newName();return(i||(i=Object.create(null)))["."+a]=l,a}let r=typeof t.all=="string"?t.all:t.all?s(t.all):void 0,o=t.scope;this.scope=o instanceof Re?l=>l.prop(ki)==o.data:o?l=>l==o:void 0,this.style=pl(e.map(l=>({tag:l.tag,class:l.class||s(Object.assign({},l,{tag:null}))})),{all:r}).style,this.module=i?new Fe(i):null,this.themeType=t.themeType}static define(e,t){return new n(e,t||{})}},kl=C.define(),Qf=C.define({combine(n){return n.length?[n[0]]:null}});function yl(n){let e=n.facet(kl);return e.length?e:n.facet(Qf)}function Zf(n,e){let t=[Fg],i;return n instanceof Si&&(n.module&&t.push(O.styleModule.of(n.module)),i=n.themeType),e?.fallback?t.push(Qf.of(n)):i?t.push(kl.computeN([O.darkTheme],s=>s.facet(O.darkTheme)==(i=="dark")?[n]:[])):t.push(kl.of(n)),t}var Sl=class{constructor(e){this.markCache=Object.create(null),this.tree=oe(e.state),this.decorations=this.buildDeco(e,yl(e.state)),this.decoratedTo=e.viewport.to}update(e){let t=oe(e.state),i=yl(e.state),s=i!=yl(e.startState),{viewport:r}=e.view,o=e.changes.mapPos(this.decoratedTo,1);t.length<r.to&&!s&&t.type==this.tree.type&&o>=r.to?(this.decorations=this.decorations.map(e.changes),this.decoratedTo=o):(t!=this.tree||e.viewportChanged||s)&&(this.tree=t,this.decorations=this.buildDeco(e.view,i),this.decoratedTo=r.to)}buildDeco(e,t){if(!t||!this.tree.length)return B.none;let i=new pe;for(let{from:s,to:r}of e.visibleRanges)Lf(this.tree,t,(o,l,a)=>{i.add(o,l,this.markCache[a]||(this.markCache[a]=B.mark({class:a})))},s,r);return i.finish()}},Fg=Se.high(K.fromClass(Sl,{decorations:n=>n.decorations})),jb=Si.define([{tag:T.meta,color:"#404740"},{tag:T.link,textDecoration:"underline"},{tag:T.heading,textDecoration:"underline",fontWeight:"bold"},{tag:T.emphasis,fontStyle:"italic"},{tag:T.strong,fontWeight:"bold"},{tag:T.strikethrough,textDecoration:"line-through"},{tag:T.keyword,color:"#708"},{tag:[T.atom,T.bool,T.url,T.contentSeparator,T.labelName],color:"#219"},{tag:[T.literal,T.inserted],color:"#164"},{tag:[T.string,T.deleted],color:"#a11"},{tag:[T.regexp,T.escape,T.special(T.string)],color:"#e40"},{tag:T.definition(T.variableName),color:"#00f"},{tag:T.local(T.variableName),color:"#30a"},{tag:[T.typeName,T.namespace],color:"#085"},{tag:T.className,color:"#167"},{tag:[T.special(T.variableName),T.macroName],color:"#256"},{tag:T.definition(T.propertyName),color:"#00c"},{tag:T.comment,color:"#940"},{tag:T.invalid,color:"#f00"}]),Hg=O.baseTheme({"&.cm-focused .cm-matchingBracket":{backgroundColor:"#328c8252"},"&.cm-focused .cm-nonmatchingBracket":{backgroundColor:"#bb555544"}}),eu=1e4,tu="()[]{}",iu=C.define({combine(n){return me(n,{afterCursor:!0,brackets:tu,maxScanDistance:eu,renderMatch:zg})}}),Wg=B.mark({class:"cm-matchingBracket"}),Vg=B.mark({class:"cm-nonmatchingBracket"});function zg(n){let e=[],t=n.matched?Wg:Vg;return e.push(t.range(n.start.from,n.start.to)),n.end&&e.push(t.range(n.end.from,n.end.to)),e}function Ff(n){let e=[],t=n.facet(iu);for(let i of n.selection.ranges){if(!i.empty)continue;let s=Ge(n,i.head,-1,t)||i.head>0&&Ge(n,i.head-1,1,t)||t.afterCursor&&(Ge(n,i.head,1,t)||i.head<n.doc.length&&Ge(n,i.head+1,-1,t));s&&(e=e.concat(t.renderMatch(s,n)))}return B.set(e,!0)}var qg=K.fromClass(class{constructor(n){this.paused=!1,this.decorations=Ff(n.state)}update(n){(n.docChanged||n.selectionSet||this.paused)&&(n.view.composing?(this.decorations=this.decorations.map(n.changes),this.paused=!0):(this.decorations=Ff(n.state),this.paused=!1))}},{decorations:n=>n.decorations}),Kg=[qg,Hg];function nu(n={}){return[iu.of(n),Kg]}var $g=new P;function Cl(n,e,t){let i=n.prop(e<0?P.openedBy:P.closedBy);if(i)return i;if(n.name.length==1){let s=t.indexOf(n.name);if(s>-1&&s%2==(e<0?1:0))return[t[s+e]]}return null}function Al(n){let e=n.type.prop($g);return e?e(n.node):n}function Ge(n,e,t,i={}){let s=i.maxScanDistance||eu,r=i.brackets||tu,o=oe(n),l=o.resolveInner(e,t);for(let a=l;a;a=a.parent){let h=Cl(a.type,t,r);if(h&&a.from<a.to){let c=Al(a);if(c&&(t>0?e>=c.from&&e<c.to:e>c.from&&e<=c.to))return jg(n,e,t,a,c,h,r)}}return Ug(n,e,t,o,l.type,s,r)}function jg(n,e,t,i,s,r,o){let l=i.parent,a={from:s.from,to:s.to},h=0,c=l?.cursor();if(c&&(t<0?c.childBefore(i.from):c.childAfter(i.to)))do if(t<0?c.to<=i.from:c.from>=i.to){if(h==0&&r.indexOf(c.type.name)>-1&&c.from<c.to){let f=Al(c);return{start:a,end:f?{from:f.from,to:f.to}:void 0,matched:!0}}else if(Cl(c.type,t,o))h++;else if(Cl(c.type,-t,o)){if(h==0){let f=Al(c);return{start:a,end:f&&f.from<f.to?{from:f.from,to:f.to}:void 0,matched:!1}}h--}}while(t<0?c.prevSibling():c.nextSibling());return{start:a,matched:!1}}function Ug(n,e,t,i,s,r,o){if(t<0?!e:e==n.doc.length)return null;let l=t<0?n.sliceDoc(e-1,e):n.sliceDoc(e,e+1),a=o.indexOf(l);if(a<0||a%2==0!=t>0)return null;let h={from:t<0?e-1:e,to:t>0?e+1:e},c=n.doc.iterRange(e,t>0?n.doc.length:0),f=0;for(let u=0;!c.next().done&&u<=r;){let d=c.value;t<0&&(u+=d.length);let p=e+u*t;for(let m=t>0?0:d.length-1,g=t>0?d.length:-1;m!=g;m+=t){let y=o.indexOf(d[m]);if(!(y<0||i.resolveInner(p+m,1).type!=s))if(y%2==0==t>0)f++;else{if(f==1)return{start:h,end:{from:p+m,to:p+m+1},matched:y>>1==a>>1};f--}}t>0&&(u+=d.length)}return c.done?{start:h,matched:!1}:null}function Gg(n){return{name:n.name||"",token:n.token,blankLine:n.blankLine||(()=>{}),startState:n.startState||(()=>!0),copyState:n.copyState||_g,indent:n.indent||(()=>null),languageData:n.languageData||{},tokenTable:n.tokenTable||Pl,mergeTokens:n.mergeTokens!==!1}}function _g(n){if(typeof n!="object")return n;let e={};for(let t in n){let i=n[t];e[t]=i instanceof Array?i.slice():i}return e}var Hf=new WeakMap,Es=class n extends Re{constructor(e){let t=bg(e.languageData),i=Gg(e),s,r=new class extends on{createParse(o,l,a){return new Ml(s,o,l,a)}};super(t,r,[],e.name),this.topNode=Qg(t,this),s=this,this.streamParser=i,this.stateAfter=new P({perNode:!0}),this.tokenTable=e.tokenTable?new Rs(i.tokenTable):Jg}static define(e){return new n(e)}getIndent(e){let t,{overrideIndentation:i}=e.options;i&&(t=Hf.get(e.state),t!=null&&t<e.pos-1e4&&(t=void 0));let s=Rl(this,e.node.tree,e.node.from,e.node.from,t??e.pos),r,o;if(s?(o=s.state,r=s.pos+1):(o=this.streamParser.startState(e.unit),r=e.node.from),e.pos-r>1e4)return null;for(;r<e.pos;){let a=e.state.doc.lineAt(r),h=Math.min(e.pos,a.to);if(a.length){let c=i?i(a.from):-1,f=new an(a.text,e.state.tabSize,e.unit,c<0?void 0:c);for(;f.pos<h-a.from;)ru(this.streamParser.token,f,o)}else this.streamParser.blankLine(o,e.unit);if(h==e.pos)break;r=a.to+1}let l=e.lineAt(e.pos);return i&&t==null&&Hf.set(e.state,l.from),this.streamParser.indent(o,/^\s*(.*)/.exec(l.text)[1],e)}get allowsNesting(){return!1}};function Rl(n,e,t,i,s){let r=t>=i&&t+e.length<=s&&e.prop(n.stateAfter);if(r)return{state:n.streamParser.copyState(r),pos:t+e.length};for(let o=e.children.length-1;o>=0;o--){let l=e.children[o],a=t+e.positions[o],h=l instanceof Q&&a<s&&Rl(n,l,a,i,s);if(h)return h}return null}function su(n,e,t,i,s){if(s&&t<=0&&i>=e.length)return e;!s&&t==0&&e.type==n.topNode&&(s=!0);for(let r=e.children.length-1;r>=0;r--){let o=e.positions[r],l=e.children[r],a;if(o<i&&l instanceof Q){if(!(a=su(n,l,t-o,i-o,s)))break;return s?new Q(e.type,e.children.slice(0,r).concat(a),e.positions.slice(0,r+1),o+a.length):a}}return null}function Yg(n,e,t,i,s){for(let r of e){let o=r.from+(r.openStart?25:0),l=r.to-(r.openEnd?25:0),a=o<=t&&l>t&&Rl(n,r.tree,0-r.offset,t,l),h;if(a&&a.pos<=i&&(h=su(n,r.tree,t+r.offset,a.pos+r.offset,!1)))return{state:a.state,tree:h}}return{state:n.streamParser.startState(s?St(s):4),tree:Q.empty}}var Ml=class{constructor(e,t,i,s){this.lang=e,this.input=t,this.fragments=i,this.ranges=s,this.stoppedAt=null,this.chunks=[],this.chunkPos=[],this.chunk=[],this.chunkReused=void 0,this.rangeIndex=0,this.to=s[s.length-1].to;let r=fn.get(),o=s[0].from,{state:l,tree:a}=Yg(e,i,o,this.to,r?.state);this.state=l,this.parsedPos=this.chunkStart=o+a.length;for(let h=0;h<a.children.length;h++)this.chunks.push(a.children[h]),this.chunkPos.push(a.positions[h]);r&&this.parsedPos<r.viewport.from-1e5&&s.some(h=>h.from<=r.viewport.from&&h.to>=r.viewport.from)&&(this.state=this.lang.streamParser.startState(St(r.state)),r.skipUntilInView(this.parsedPos,r.viewport.from),this.parsedPos=r.viewport.from),this.moveRangeIndex()}advance(){let e=fn.get(),t=this.stoppedAt==null?this.to:Math.min(this.to,this.stoppedAt),i=Math.min(t,this.chunkStart+512);for(e&&(i=Math.min(i,e.viewport.to));this.parsedPos<i;)this.parseLine(e);return this.chunkStart<this.parsedPos&&this.finishChunk(),this.parsedPos>=t?this.finish():e&&this.parsedPos>=e.viewport.to?(e.skipUntilInView(this.parsedPos,t),this.finish()):null}stopAt(e){this.stoppedAt=e}lineAfter(e){let t=this.input.chunk(e);if(this.input.lineChunks)t==`
`&&(t="");else{let i=t.indexOf(`
`);i>-1&&(t=t.slice(0,i))}return e+t.length<=this.to?t:t.slice(0,this.to-e)}nextLine(){let e=this.parsedPos,t=this.lineAfter(e),i=e+t.length;for(let s=this.rangeIndex;;){let r=this.ranges[s].to;if(r>=i||(t=t.slice(0,r-(i-t.length)),s++,s==this.ranges.length))break;let o=this.ranges[s].from,l=this.lineAfter(o);t+=l,i=o+l.length}return{line:t,end:i}}skipGapsTo(e,t,i){for(;;){let s=this.ranges[this.rangeIndex].to,r=e+t;if(i>0?s>r:s>=r)break;let o=this.ranges[++this.rangeIndex].from;t+=o-s}return t}moveRangeIndex(){for(;this.ranges[this.rangeIndex].to<this.parsedPos;)this.rangeIndex++}emitToken(e,t,i,s){let r=4;if(this.ranges.length>1){s=this.skipGapsTo(t,s,1),t+=s;let l=this.chunk.length;s=this.skipGapsTo(i,s,-1),i+=s,r+=this.chunk.length-l}let o=this.chunk.length-4;return this.lang.streamParser.mergeTokens&&r==4&&o>=0&&this.chunk[o]==e&&this.chunk[o+2]==t?this.chunk[o+2]=i:this.chunk.push(e,t,i,r),s}parseLine(e){let{line:t,end:i}=this.nextLine(),s=0,{streamParser:r}=this.lang,o=new an(t,e?e.state.tabSize:4,e?St(e.state):2);if(o.eol())r.blankLine(this.state,o.indentUnit);else for(;!o.eol();){let l=ru(r.token,o,this.state);if(l&&(s=this.emitToken(this.lang.tokenTable.resolve(l),this.parsedPos+o.start,this.parsedPos+o.pos,s)),o.start>1e4)break}this.parsedPos=i,this.moveRangeIndex(),this.parsedPos<this.to&&this.parsedPos++}finishChunk(){let e=Q.build({buffer:this.chunk,start:this.chunkStart,length:this.parsedPos-this.chunkStart,nodeSet:Xg,topID:0,maxBufferLength:512,reused:this.chunkReused});e=new Q(e.type,e.children,e.positions,e.length,[[this.lang.stateAfter,this.lang.streamParser.copyState(this.state)]]),this.chunks.push(e),this.chunkPos.push(this.chunkStart-this.ranges[0].from),this.chunk=[],this.chunkReused=void 0,this.chunkStart=this.parsedPos}finish(){return new Q(this.lang.topNode,this.chunks,this.chunkPos,this.parsedPos-this.ranges[0].from).balance()}};function ru(n,e,t){e.start=e.pos;for(let i=0;i<10;i++){let s=n(e,t);if(e.pos>e.start)return s}throw new Error("Stream parser failed to advance stream.")}var Pl=Object.create(null),dn=[ke.none],Xg=new Cs(dn),Wf=[],Vf=Object.create(null),ou=Object.create(null);for(let[n,e]of[["variable","variableName"],["variable-2","variableName.special"],["string-2","string.special"],["def","variableName.definition"],["tag","tagName"],["attribute","attributeName"],["type","typeName"],["builtin","variableName.standard"],["qualifier","modifier"],["error","invalid"],["header","heading"],["property","propertyName"]])ou[n]=lu(Pl,e);var Rs=class{constructor(e){this.extra=e,this.table=Object.assign(Object.create(null),ou)}resolve(e){return e?this.table[e]||(this.table[e]=lu(this.extra,e)):0}},Jg=new Rs(Pl);function bl(n,e){Wf.indexOf(n)>-1||(Wf.push(n),console.warn(e))}function lu(n,e){let t=[];for(let l of e.split(" ")){let a=[];for(let h of l.split(".")){let c=n[h]||T[h];c?typeof c=="function"?a.length?a=a.map(c):bl(h,`Modifier ${h} used at start of tag`):a.length?bl(h,`Tag ${h} used as modifier`):a=Array.isArray(c)?c:[c]:bl(h,`Unknown highlighting tag ${h}`)}for(let h of a)t.push(h)}if(!t.length)return 0;let i=e.replace(/ /g,"_"),s=i+" "+t.map(l=>l.id),r=Vf[s];if(r)return r.id;let o=Vf[s]=ke.define({id:dn.length,name:i,props:[Of({[i]:t})]});return dn.push(o),o.id}function Qg(n,e){let t=ke.define({id:dn.length,name:"Document",props:[ki.add(()=>n),qf.add(()=>i=>e.getIndent(i))],top:!0});return dn.push(t),t}var Ub={rtl:B.mark({class:"cm-iso",inclusive:!0,attributes:{dir:"rtl"},bidiIsolate:z.RTL}),ltr:B.mark({class:"cm-iso",inclusive:!0,attributes:{dir:"ltr"},bidiIsolate:z.LTR}),auto:B.mark({class:"cm-iso",inclusive:!0,attributes:{dir:"auto"},bidiIsolate:null})};var Wl=n=>{let{state:e}=n,t=e.doc.lineAt(e.selection.main.from),i=ql(n.state,t.from);return i.line?Zg(n):i.block?e0(n):!1};function Vl(n,e){return({state:t,dispatch:i})=>{if(t.readOnly)return!1;let s=n(e,t);return s?(i(t.update(s)),!0):!1}}var Zg=Vl(n0,0);var zl=Vl(yu,0);var e0=Vl((n,e)=>yu(n,e,i0(e)),0);function ql(n,e){let t=n.languageDataAt("commentTokens",e,1);return t.length?t[0]:{}}var mn=50;function t0(n,{open:e,close:t},i,s){let r=n.sliceDoc(i-mn,i),o=n.sliceDoc(s,s+mn),l=/\s*$/.exec(r)[0].length,a=/^\s*/.exec(o)[0].length,h=r.length-l;if(r.slice(h-e.length,h)==e&&o.slice(a,a+t.length)==t)return{open:{pos:i-l,margin:l&&1},close:{pos:s+a,margin:a&&1}};let c,f;s-i<=2*mn?c=f=n.sliceDoc(i,s):(c=n.sliceDoc(i,i+mn),f=n.sliceDoc(s-mn,s));let u=/^\s*/.exec(c)[0].length,d=/\s*$/.exec(f)[0].length,p=f.length-d-t.length;return c.slice(u,u+e.length)==e&&f.slice(p,p+t.length)==t?{open:{pos:i+u+e.length,margin:/\s/.test(c.charAt(u+e.length))?1:0},close:{pos:s-d-t.length,margin:/\s/.test(f.charAt(p-1))?1:0}}:null}function i0(n){let e=[];for(let t of n.selection.ranges){let i=n.doc.lineAt(t.from),s=t.to<=i.to?i:n.doc.lineAt(t.to);s.from>i.from&&s.from==t.to&&(s=t.to==i.to+1?i:n.doc.lineAt(t.to-1));let r=e.length-1;r>=0&&e[r].to>i.from?e[r].to=s.to:e.push({from:i.from+/^\s*/.exec(i.text)[0].length,to:s.to})}return e}function yu(n,e,t=e.selection.ranges){let i=t.map(r=>ql(e,r.from).block);if(!i.every(r=>r))return null;let s=t.map((r,o)=>t0(e,i[o],r.from,r.to));if(n!=2&&!s.every(r=>r))return{changes:e.changes(t.map((r,o)=>s[o]?[]:[{from:r.from,insert:i[o].open+" "},{from:r.to,insert:" "+i[o].close}]))};if(n!=1&&s.some(r=>r)){let r=[];for(let o=0,l;o<s.length;o++)if(l=s[o]){let a=i[o],{open:h,close:c}=l;r.push({from:h.pos-a.open.length,to:h.pos+h.margin},{from:c.pos-c.margin,to:c.pos+a.close.length})}return{changes:r}}return null}function n0(n,e,t=e.selection.ranges){let i=[],s=-1;e:for(let{from:r,to:o}of t){let l=i.length,a=1e9,h;for(let c=r;c<=o;){let f=e.doc.lineAt(c);if(h==null&&(h=ql(e,f.from).line,!h))continue e;if(f.from>s&&(r==o||o>f.from)){s=f.from;let u=/^\s*/.exec(f.text)[0].length,d=u==f.length,p=f.text.slice(u,u+h.length)==h?u:-1;u<f.text.length&&u<a&&(a=u),i.push({line:f,comment:p,token:h,indent:u,empty:d,single:!1})}c=f.to+1}if(a<1e9)for(let c=l;c<i.length;c++)i[c].indent<i[c].line.text.length&&(i[c].indent=a);i.length==l+1&&(i[l].single=!0)}if(n!=2&&i.some(r=>r.comment<0&&(!r.empty||r.single))){let r=[];for(let{line:l,token:a,indent:h,empty:c,single:f}of i)(f||!c)&&r.push({from:l.from+h,insert:a+" "});let o=e.changes(r);return{changes:o,selection:e.selection.map(o,1)}}else if(n!=1&&i.some(r=>r.comment>=0)){let r=[];for(let{line:o,comment:l,token:a}of i)if(l>=0){let h=o.from+l,c=h+a.length;o.text[c-o.from]==" "&&c++,r.push({from:h,to:c})}return{changes:r}}return null}var au=xe.define();var s0=C.define();var Ut=class n{constructor(e,t,i,s,r){this.changes=e,this.effects=t,this.mapped=i,this.startSelection=s,this.selectionsAfter=r}setSelAfter(e){return new n(this.changes,this.effects,this.mapped,this.startSelection,e)}toJSON(){var e,t,i;return{changes:(e=this.changes)===null||e===void 0?void 0:e.toJSON(),mapped:(t=this.mapped)===null||t===void 0?void 0:t.toJSON(),startSelection:(i=this.startSelection)===null||i===void 0?void 0:i.toJSON(),selectionsAfter:this.selectionsAfter.map(s=>s.toJSON())}}static fromJSON(e){return new n(e.changes&&be.fromJSON(e.changes),[],e.mapped&&ot.fromJSON(e.mapped),e.startSelection&&b.fromJSON(e.startSelection),e.selectionsAfter.map(b.fromJSON))}static fromTransaction(e,t){let i=ze;for(let s of e.startState.facet(s0)){let r=s(e);r.length&&(i=i.concat(r))}return!i.length&&e.changes.empty?null:new n(e.changes.invert(e.startState.doc),i,void 0,t||e.startState.selection,ze)}static selection(e){return new n(void 0,ze,void 0,void 0,e)}};function Nl(n,e,t,i){let s=e+1>t+20?e-t-1:0,r=n.slice(s,e);return r.push(i),r}function r0(n,e){let t=[],i=!1;return n.iterChangedRanges((s,r)=>t.push(s,r)),e.iterChangedRanges((s,r,o,l)=>{for(let a=0;a<t.length;){let h=t[a++],c=t[a++];l>=h&&o<=c&&(i=!0)}}),i}function o0(n,e){return n.ranges.length==e.ranges.length&&n.ranges.filter((t,i)=>t.empty!=e.ranges[i].empty).length===0}function bu(n,e){return n.length?e.length?n.concat(e):n:e}var ze=[],l0=200;function a0(n,e){if(n.length){let t=n[n.length-1],i=t.selectionsAfter.slice(Math.max(0,t.selectionsAfter.length-l0));return i.length&&i[i.length-1].eq(e)?n:(i.push(e),Nl(n,n.length-1,1e9,t.setSelAfter(i)))}else return[Ut.selection([e])]}function h0(n){let e=n[n.length-1],t=n.slice();return t[n.length-1]=e.setSelAfter(e.selectionsAfter.slice(0,e.selectionsAfter.length-1)),t}function Il(n,e){if(!n.length)return n;let t=n.length,i=ze;for(;t;){let s=c0(n[t-1],e,i);if(s.changes&&!s.changes.empty||s.effects.length){let r=n.slice(0,t);return r[t-1]=s,r}else e=s.mapped,t--,i=s.selectionsAfter}return i.length?[Ut.selection(i)]:ze}function c0(n,e,t){let i=bu(n.selectionsAfter.length?n.selectionsAfter.map(l=>l.map(e)):ze,t);if(!n.changes)return Ut.selection(i);let s=n.changes.map(e),r=e.mapDesc(n.changes,!0),o=n.mapped?n.mapped.composeDesc(r):r;return new Ut(s,L.mapEffects(n.effects,e),o,n.startSelection.map(r),i)}var f0=/^(input\.type|delete)($|\.)/,Hs=class n{constructor(e,t,i=0,s=void 0){this.done=e,this.undone=t,this.prevTime=i,this.prevUserEvent=s}isolate(){return this.prevTime?new n(this.done,this.undone):this}addChanges(e,t,i,s,r){let o=this.done,l=o[o.length-1];return l&&l.changes&&!l.changes.empty&&e.changes&&(!i||f0.test(i))&&(!l.selectionsAfter.length&&t-this.prevTime<s.newGroupDelay&&s.joinToEvent(r,r0(l.changes,e.changes))||i=="input.type.compose")?o=Nl(o,o.length-1,s.minDepth,new Ut(e.changes.compose(l.changes),bu(L.mapEffects(e.effects,l.changes),l.effects),l.mapped,l.startSelection,ze)):o=Nl(o,o.length,s.minDepth,e),new n(o,ze,t,i)}addSelection(e,t,i,s){let r=this.done.length?this.done[this.done.length-1].selectionsAfter:ze;return r.length>0&&t-this.prevTime<s&&i==this.prevUserEvent&&i&&/^select($|\.)/.test(i)&&o0(r[r.length-1],e)?this:new n(a0(this.done,e),this.undone,t,i)}addMapping(e){return new n(Il(this.done,e),Il(this.undone,e),this.prevTime,this.prevUserEvent)}pop(e,t,i){let s=e==0?this.done:this.undone;if(s.length==0)return null;let r=s[s.length-1],o=r.selectionsAfter[0]||(r.startSelection?r.startSelection.map(r.changes.invertedDesc,1):t.selection);if(i&&r.selectionsAfter.length)return t.update({selection:r.selectionsAfter[r.selectionsAfter.length-1],annotations:au.of({side:e,rest:h0(s),selection:o}),userEvent:e==0?"select.undo":"select.redo",scrollIntoView:!0});if(r.changes){let l=s.length==1?ze:s.slice(0,s.length-1);return r.mapped&&(l=Il(l,r.mapped)),t.update({changes:r.changes,selection:r.startSelection,effects:r.effects,annotations:au.of({side:e,rest:l,selection:o}),filter:!1,userEvent:e==0?"undo":"redo",scrollIntoView:!0})}else return null}};Hs.empty=new Hs(ze,ze);function Ai(n,e){return b.create(n.ranges.map(e),n.mainIndex)}function _e(n,e){return n.update({selection:e,scrollIntoView:!0,userEvent:"select"})}function Ye({state:n,dispatch:e},t){let i=Ai(n.selection,t);return i.eq(n.selection,!0)?!1:(e(_e(n,i)),!0)}function Ws(n,e){return b.cursor(e?n.to:n.from)}function xu(n,e){return Ye(n,t=>t.empty?n.moveByChar(t,e):Ws(t,e))}function ge(n){return n.textDirectionAt(n.state.selection.main.head)==z.LTR}var wu=n=>xu(n,!ge(n)),vu=n=>xu(n,ge(n));function ku(n,e){return Ye(n,t=>t.empty?n.moveByGroup(t,e):Ws(t,e))}var u0=n=>ku(n,!ge(n)),d0=n=>ku(n,ge(n));var n1=typeof Intl<"u"&&Intl.Segmenter?new Intl.Segmenter(void 0,{granularity:"word"}):null;function p0(n,e,t){if(e.type.prop(t))return!0;let i=e.to-e.from;return i&&(i>2||/[^\s,.;:]/.test(n.sliceDoc(e.from,e.to)))||e.firstChild}function Vs(n,e,t){let i=oe(n).resolveInner(e.head),s=t?P.closedBy:P.openedBy;for(let a=e.head;;){let h=t?i.childAfter(a):i.childBefore(a);if(!h)break;p0(n,h,s)?i=h:a=t?h.to:h.from}let r=i.type.prop(s),o,l;return r&&(o=t?Ge(n,i.from,1):Ge(n,i.to,-1))&&o.matched?l=t?o.end.to:o.end.from:l=t?i.to:i.from,b.cursor(l,t?-1:1)}var m0=n=>Ye(n,e=>Vs(n.state,e,!ge(n))),g0=n=>Ye(n,e=>Vs(n.state,e,ge(n)));function Su(n,e){return Ye(n,t=>{if(!t.empty)return Ws(t,e);let i=n.moveVertically(t,e);return i.head!=t.head?i:n.moveToLineBoundary(t,e)})}var Cu=n=>Su(n,!1),Au=n=>Su(n,!0);function Mu(n){let e=n.scrollDOM.clientHeight<n.scrollDOM.scrollHeight-2,t=0,i=0,s;if(e){for(let r of n.state.facet(O.scrollMargins)){let o=r(n);o?.top&&(t=Math.max(o?.top,t)),o?.bottom&&(i=Math.max(o?.bottom,i))}s=n.scrollDOM.clientHeight-t-i}else s=(n.dom.ownerDocument.defaultView||window).innerHeight;return{marginTop:t,marginBottom:i,selfScroll:e,height:Math.max(n.defaultLineHeight,s-5)}}function Tu(n,e){let t=Mu(n),{state:i}=n,s=Ai(i.selection,o=>o.empty?n.moveVertically(o,e,t.height):Ws(o,e));if(s.eq(i.selection))return!1;let r;if(t.selfScroll){let o=n.coordsAtPos(i.selection.main.head),l=n.scrollDOM.getBoundingClientRect(),a=l.top+t.marginTop,h=l.bottom-t.marginBottom;o&&o.top>a&&o.bottom<h&&(r=O.scrollIntoView(s.main.head,{y:"start",yMargin:o.top-a}))}return n.dispatch(_e(i,s),{effects:r}),!0}var hu=n=>Tu(n,!1),Fl=n=>Tu(n,!0);function At(n,e,t){let i=n.lineBlockAt(e.head),s=n.moveToLineBoundary(e,t);if(s.head==e.head&&s.head!=(t?i.to:i.from)&&(s=n.moveToLineBoundary(e,t,!1)),!t&&s.head==i.from&&i.length){let r=/^\s*/.exec(n.state.sliceDoc(i.from,Math.min(i.from+100,i.to)))[0].length;r&&e.head!=i.from+r&&(s=b.cursor(i.from+r))}return s}var y0=n=>Ye(n,e=>At(n,e,!0)),b0=n=>Ye(n,e=>At(n,e,!1)),x0=n=>Ye(n,e=>At(n,e,!ge(n))),w0=n=>Ye(n,e=>At(n,e,ge(n))),v0=n=>Ye(n,e=>n.moveToLineBoundary(e,!1,!1)),k0=n=>Ye(n,e=>n.moveToLineBoundary(e,!0,!1));function S0(n,e,t){let i=!1,s=Ai(n.selection,r=>{let o=Ge(n,r.head,-1)||Ge(n,r.head,1)||r.head>0&&Ge(n,r.head-1,1)||r.head<n.doc.length&&Ge(n,r.head+1,-1);if(!o||!o.end)return r;i=!0;let l=o.start.from==r.head?o.end.to:o.end.from;return t?b.range(r.anchor,l):b.cursor(l)});return i?(e(_e(n,s)),!0):!1}var Kl=({state:n,dispatch:e})=>S0(n,e,!1);function qe(n,e,t){let i=Ai(n.state.selection,s=>{s.undirectional&&s.head>=s.anchor!=e&&(s=b.range(s.head,s.anchor));let r=t(s);return b.range(s.anchor,r.head,r.goalColumn,r.bidiLevel||void 0,r.assoc)});return i.eq(n.state.selection)?!1:(n.dispatch(_e(n.state,i)),!0)}function Du(n,e){return qe(n,e,t=>n.moveByChar(t,e))}var Ou=n=>Du(n,!ge(n)),Bu=n=>Du(n,ge(n));function Lu(n,e){return qe(n,e,t=>n.moveByGroup(t,e))}var C0=n=>Lu(n,!ge(n)),A0=n=>Lu(n,ge(n));var M0=n=>{let e=!ge(n);return qe(n,e,t=>Vs(n.state,t,e))},T0=n=>{let e=ge(n);return qe(n,e,t=>Vs(n.state,t,e))};function Eu(n,e){return qe(n,e,t=>n.moveVertically(t,e))}var Ru=n=>Eu(n,!1),Pu=n=>Eu(n,!0);function Iu(n,e){return qe(n,e,t=>n.moveVertically(t,e,Mu(n).height))}var cu=n=>Iu(n,!1),fu=n=>Iu(n,!0),D0=n=>qe(n,!0,e=>At(n,e,!0)),O0=n=>qe(n,!1,e=>At(n,e,!1)),B0=n=>{let e=!ge(n);return qe(n,e,t=>At(n,t,e))},L0=n=>{let e=ge(n);return qe(n,e,t=>At(n,t,e))},E0=n=>qe(n,!1,e=>b.cursor(n.lineBlockAt(e.head).from)),R0=n=>qe(n,!0,e=>b.cursor(n.lineBlockAt(e.head).to)),uu=({state:n,dispatch:e})=>(e(_e(n,{anchor:0})),!0),du=({state:n,dispatch:e})=>(e(_e(n,{anchor:n.doc.length})),!0),pu=({state:n,dispatch:e})=>(e(_e(n,{anchor:n.selection.main.anchor,head:0})),!0),mu=({state:n,dispatch:e})=>(e(_e(n,{anchor:n.selection.main.anchor,head:n.doc.length})),!0),$l=({state:n,dispatch:e})=>(e(n.update({selection:{anchor:0,head:n.doc.length},userEvent:"select"})),!0),jl=({state:n,dispatch:e})=>{let t=zs(n).map(({from:i,to:s})=>b.undirectionalRange(i,Math.min(s+1,n.doc.length)));return e(n.update({selection:b.create(t),userEvent:"select"})),!0},P0=({state:n,dispatch:e})=>{let t=Ai(n.selection,i=>{let s=oe(n),r=s.resolveStack(i.from,1);if(i.empty){let o=s.resolveStack(i.from,-1);o.node.from>=r.node.from&&o.node.to<=r.node.to&&(r=o)}for(let o=r;o;o=o.next){let{node:l}=o;if((l.from<i.from&&l.to>=i.to||l.to>i.to&&l.from<=i.from)&&o.next)return b.undirectionalRange(l.from,l.to)}return i});return t.eq(n.selection)?!1:(e(_e(n,t)),!0)};function Nu(n,e){let{state:t}=n,i=t.selection,s=t.selection.ranges.slice();for(let r of t.selection.ranges){let o=t.doc.lineAt(r.head);if(e?o.to<n.state.doc.length:o.from>0)for(let l=r;;){let a=n.moveVertically(l,e);if(a.head<o.from||a.head>o.to){s.some(h=>h.head==a.head)||s.push(a);break}else{if(a.head==l.head)break;l=a}}}return s.length==i.ranges.length?!1:(n.dispatch(_e(t,b.create(s,s.length-1))),!0)}var Ul=n=>Nu(n,!1),Gl=n=>Nu(n,!0),I0=({state:n,dispatch:e})=>{let t=n.selection,i=null;return t.ranges.length>1?i=b.create([t.main]):t.main.empty||(i=b.create([b.cursor(t.main.head)])),i?(e(_e(n,i)),!0):!1};function gn(n,e){if(n.state.readOnly)return!1;let t="delete.selection",{state:i}=n,s=i.changeByRange(r=>{let{from:o,to:l}=r;if(o==l){let a=e(r);a<o?(t="delete.backward",a=Fs(n,a,!1)):a>o&&(t="delete.forward",a=Fs(n,a,!0)),o=Math.min(o,a),l=Math.max(l,a)}else o=Fs(n,o,!1),l=Fs(n,l,!0);return o==l?{range:r}:{changes:{from:o,to:l},range:b.cursor(o,o<r.head?-1:1)}});return s.changes.empty?!1:(n.dispatch(i.update(s,{scrollIntoView:!0,userEvent:t,effects:t=="delete.selection"?O.announce.of(i.phrase("Selection deleted")):void 0})),!0)}function Fs(n,e,t){if(n instanceof O)for(let i of n.state.facet(O.atomicRanges).map(s=>s(n)))i.between(e,e,(s,r)=>{s<e&&r>e&&(e=t?r:s)});return e}var Fu=(n,e,t)=>gn(n,i=>{let s=i.from,{state:r}=n,o=r.doc.lineAt(s),l,a;if(t&&!e&&s>o.from&&s<o.from+200&&!/[^ \t]/.test(l=o.text.slice(0,s-o.from))){if(l[l.length-1]=="	")return s-1;let h=lt(l,r.tabSize),c=h%St(r)||St(r);for(let f=0;f<c&&l[l.length-1-f]==" ";f++)s--;a=s}else a=ee(o.text,s-o.from,e,e)+o.from,a==s&&o.number!=(e?r.doc.lines:1)?a+=e?1:-1:!e&&/[\ufe00-\ufe0f]/.test(o.text.slice(a-o.from,s-o.from))&&(a=ee(o.text,a-o.from,!1,!1)+o.from);return a}),Hl=n=>Fu(n,!1,!0);var Hu=n=>Fu(n,!0,!1),Wu=(n,e)=>gn(n,t=>{let i=t.head,{state:s}=n,r=s.doc.lineAt(i),o=s.charCategorizer(i);for(let l=null;;){if(i==(e?r.to:r.from)){i==t.head&&r.number!=(e?s.doc.lines:1)&&(i+=e?1:-1);break}let a=ee(r.text,i-r.from,e)+r.from,h=r.text.slice(Math.min(i,a)-r.from,Math.max(i,a)-r.from),c=o(h);if(l!=null&&c!=l)break;(h!=" "||i!=t.head)&&(l=c),i=a}return i}),Vu=n=>Wu(n,!1),N0=n=>Wu(n,!0);var F0=n=>gn(n,e=>{let t=n.lineBlockAt(e.head).to;return e.head<t?t:Math.min(n.state.doc.length,e.head+1)});var H0=n=>gn(n,e=>{let t=n.moveToLineBoundary(e,!1).head;return e.head>t?t:Math.max(0,e.head-1)}),W0=n=>gn(n,e=>{let t=n.moveToLineBoundary(e,!0).head;return e.head<t?t:Math.min(n.state.doc.length,e.head+1)});var V0=({state:n,dispatch:e})=>{if(n.readOnly)return!1;let t=n.changeByRange(i=>({changes:{from:i.from,to:i.to,insert:N.of(["",""])},range:b.cursor(i.from)}));return e(n.update(t,{scrollIntoView:!0,userEvent:"input"})),!0},z0=({state:n,dispatch:e})=>{if(n.readOnly)return!1;let t=n.changeByRange(i=>{if(!i.empty||i.from==0||i.from==n.doc.length)return{range:i};let s=i.from,r=n.doc.lineAt(s),o=s==r.from?s-1:ee(r.text,s-r.from,!1)+r.from,l=s==r.to?s+1:ee(r.text,s-r.from,!0)+r.from;return{changes:{from:o,to:l,insert:n.doc.slice(s,l).append(n.doc.slice(o,s))},range:b.cursor(l)}});return t.changes.empty?!1:(e(n.update(t,{scrollIntoView:!0,userEvent:"move.character"})),!0)};function zs(n){let e=[],t=-1;for(let i of n.selection.ranges){let s=n.doc.lineAt(i.from),r=n.doc.lineAt(i.to);if(!i.empty&&i.to==r.from&&(r=n.doc.lineAt(i.to-1)),t>=s.number){let o=e[e.length-1];o.to=r.to,o.ranges.push(i)}else e.push({from:s.from,to:r.to,ranges:[i]});t=r.number+1}return e}function zu(n,e,t){if(n.readOnly)return!1;let i=[],s=[];for(let r of zs(n)){if(t?r.to==n.doc.length:r.from==0)continue;let o=n.doc.lineAt(t?r.to+1:r.from-1),l=o.length+1;if(t){i.push({from:r.to,to:o.to},{from:r.from,insert:o.text+n.lineBreak});for(let a of r.ranges)s.push(b.range(Math.min(n.doc.length,a.anchor+l),Math.min(n.doc.length,a.head+l)))}else{i.push({from:o.from,to:r.from},{from:r.to,insert:n.lineBreak+o.text});for(let a of r.ranges)s.push(b.range(a.anchor-l,a.head-l))}}return i.length?(e(n.update({changes:i,scrollIntoView:!0,selection:b.create(s,n.selection.mainIndex),userEvent:"move.line"})),!0):!1}var _l=({state:n,dispatch:e})=>zu(n,e,!1),Yl=({state:n,dispatch:e})=>zu(n,e,!0);function qu(n,e,t){if(n.readOnly)return!1;let i=[];for(let r of zs(n))t?i.push({from:r.from,insert:n.doc.slice(r.from,r.to)+n.lineBreak}):i.push({from:r.to,insert:n.lineBreak+n.doc.slice(r.from,r.to)});let s=n.changes(i);return e(n.update({changes:s,selection:n.selection.map(s,t?1:-1),scrollIntoView:!0,userEvent:"input.copyline"})),!0}var Xl=({state:n,dispatch:e})=>qu(n,e,!1),Jl=({state:n,dispatch:e})=>qu(n,e,!0),Ql=n=>{if(n.state.readOnly)return!1;let{state:e}=n,t=e.changes(zs(e).map(({from:s,to:r})=>(s>0?s--:r<e.doc.length&&r++,{from:s,to:r}))),i=Ai(e.selection,s=>{let r;if(n.lineWrapping){let o=n.lineBlockAt(s.head),l=n.coordsAtPos(s.head,s.assoc||1);l&&(r=o.bottom+n.documentTop-l.bottom+n.defaultLineHeight/2)}return n.moveVertically(s,!0,r)}).map(t);return n.dispatch({changes:t,selection:i,scrollIntoView:!0,userEvent:"delete.line"}),!0};function q0(n,e){if(/\(\)|\[\]|\{\}/.test(n.sliceDoc(e-1,e+1)))return{from:e,to:e};let t=oe(n).resolveInner(e),i=t.childBefore(e),s=t.childAfter(e),r;return i&&s&&i.to<=e&&s.from>=e&&(r=i.type.prop(P.closedBy))&&r.indexOf(s.name)>-1&&n.doc.lineAt(i.to).from==n.doc.lineAt(s.from).from&&!/\S/.test(n.sliceDoc(i.to,s.from))?{from:i.to,to:s.from}:null}var gu=Ku(!1),Zl=Ku(!0);function Ku(n){return({state:e,dispatch:t})=>{if(e.readOnly)return!1;let i=e.changeByRange(s=>{let{from:r,to:o}=s,l=e.doc.lineAt(r),a=!n&&r==o&&q0(e,r);n&&(r=o=(o<=l.to?l:e.doc.lineAt(o)).to);let h=new $t(e,{simulateBreak:r,simulateDoubleBreak:!!a}),c=Ps(h,r);for(c==null&&(c=lt(/^\s*/.exec(e.doc.lineAt(r).text)[0],e.tabSize));o<l.to&&/\s/.test(l.text[o-l.from]);)o++;a?{from:r,to:o}=a:r>l.from&&r<l.from+100&&!/\S/.test(l.text.slice(0,r))&&(r=l.from);let f=["",Ci(e,c)];return a&&f.push(Ci(e,h.lineIndent(l.from,-1))),{changes:{from:r,to:o,insert:N.of(f)},range:b.cursor(r+1+f[1].length)}});return t(e.update(i,{scrollIntoView:!0,userEvent:"input"})),!0}}function ea(n,e){let t=-1;return n.changeByRange(i=>{let s=[];for(let o=i.from;o<=i.to;){let l=n.doc.lineAt(o);l.number>t&&(i.empty||i.to>l.from)&&(e(l,s,i),t=l.number),o=l.to+1}let r=n.changes(s);return{changes:s,range:b.range(r.mapPos(i.anchor,1),r.mapPos(i.head,1))}})}var K0=({state:n,dispatch:e})=>{if(n.readOnly)return!1;let t=Object.create(null),i=new $t(n,{overrideIndentation:r=>{let o=t[r];return o??-1}}),s=ea(n,(r,o,l)=>{let a=Ps(i,r.from);if(a==null)return;/\S/.test(r.text)||(a=0);let h=/^\s*/.exec(r.text)[0],c=Ci(n,a);(h!=c||l.from<r.from+h.length)&&(t[r.from]=a,o.push({from:r.from,to:r.from+h.length,insert:c}))});return s.changes.empty||e(n.update(s,{userEvent:"indent"})),!0},qs=({state:n,dispatch:e})=>n.readOnly?!1:(e(n.update(ea(n,(t,i)=>{i.push({from:t.from,insert:n.facet(Ct)})}),{userEvent:"input.indent"})),!0),Ks=({state:n,dispatch:e})=>n.readOnly?!1:(e(n.update(ea(n,(t,i)=>{let s=/^\s*/.exec(t.text)[0];if(!s)return;let r=lt(s,n.tabSize),o=0,l=Ci(n,Math.max(0,r-St(n)));for(;o<s.length&&o<l.length&&s.charCodeAt(o)==l.charCodeAt(o);)o++;i.push({from:t.from+o,to:t.from+s.length,insert:l.slice(o)})}),{userEvent:"delete.dedent"})),!0),ta=n=>(n.setTabFocusMode(),!0);var $0=[{key:"Ctrl-b",run:wu,shift:Ou,preventDefault:!0},{key:"Ctrl-f",run:vu,shift:Bu},{key:"Ctrl-p",run:Cu,shift:Ru},{key:"Ctrl-n",run:Au,shift:Pu},{key:"Ctrl-a",run:v0,shift:E0},{key:"Ctrl-e",run:k0,shift:R0},{key:"Ctrl-d",run:Hu},{key:"Ctrl-h",run:Hl},{key:"Ctrl-k",run:F0},{key:"Ctrl-Alt-h",run:Vu},{key:"Ctrl-o",run:V0},{key:"Ctrl-t",run:z0},{key:"Ctrl-v",run:Fl}],j0=[{key:"ArrowLeft",run:wu,shift:Ou,preventDefault:!0},{key:"Mod-ArrowLeft",mac:"Alt-ArrowLeft",run:u0,shift:C0,preventDefault:!0},{mac:"Cmd-ArrowLeft",run:x0,shift:B0,preventDefault:!0},{key:"ArrowRight",run:vu,shift:Bu,preventDefault:!0},{key:"Mod-ArrowRight",mac:"Alt-ArrowRight",run:d0,shift:A0,preventDefault:!0},{mac:"Cmd-ArrowRight",run:w0,shift:L0,preventDefault:!0},{key:"ArrowUp",run:Cu,shift:Ru,preventDefault:!0},{mac:"Cmd-ArrowUp",run:uu,shift:pu},{mac:"Ctrl-ArrowUp",run:hu,shift:cu},{key:"ArrowDown",run:Au,shift:Pu,preventDefault:!0},{mac:"Cmd-ArrowDown",run:du,shift:mu},{mac:"Ctrl-ArrowDown",run:Fl,shift:fu},{key:"PageUp",run:hu,shift:cu},{key:"PageDown",run:Fl,shift:fu},{key:"Home",run:b0,shift:O0,preventDefault:!0},{key:"Mod-Home",run:uu,shift:pu},{key:"End",run:y0,shift:D0,preventDefault:!0},{key:"Mod-End",run:du,shift:mu},{key:"Enter",run:gu,shift:gu},{key:"Mod-a",run:$l},{key:"Backspace",run:Hl,shift:Hl,preventDefault:!0},{key:"Delete",run:Hu,preventDefault:!0},{key:"Mod-Backspace",mac:"Alt-Backspace",run:Vu,preventDefault:!0},{key:"Mod-Delete",mac:"Alt-Delete",run:N0,preventDefault:!0},{mac:"Mod-Backspace",run:H0,preventDefault:!0},{mac:"Mod-Delete",run:W0,preventDefault:!0}].concat($0.map(n=>({mac:n.key,run:n.run,shift:n.shift}))),$u=[{key:"Alt-ArrowLeft",mac:"Ctrl-ArrowLeft",run:m0,shift:M0},{key:"Alt-ArrowRight",mac:"Ctrl-ArrowRight",run:g0,shift:T0},{key:"Alt-ArrowUp",run:_l},{key:"Shift-Alt-ArrowUp",run:Xl},{key:"Alt-ArrowDown",run:Yl},{key:"Shift-Alt-ArrowDown",run:Jl},{key:"Mod-Alt-ArrowUp",run:Ul},{key:"Mod-Alt-ArrowDown",run:Gl},{key:"Escape",run:I0},{key:"Mod-Enter",run:Zl},{key:"Alt-l",mac:"Ctrl-l",run:jl},{key:"Mod-i",run:P0,preventDefault:!0},{key:"Mod-[",run:Ks},{key:"Mod-]",run:qs},{key:"Mod-Alt-\\",run:K0},{key:"Shift-Mod-k",run:Ql},{key:"Shift-Mod-\\",run:Kl},{key:"Mod-/",run:Wl},{key:"Alt-A",mac:"Ctrl-A",run:zl},{key:"Ctrl-m",mac:"Shift-Alt-m",run:ta}].concat(j0),ju={key:"Tab",run:qs,shift:Ks};var Uu=typeof String.prototype.normalize=="function"?n=>n.normalize("NFKD"):n=>n,Tt=class{constructor(e,t,i=0,s=e.length,r,o){this.test=o,this.value={from:0,to:0,precise:!1},this.done=!1,this.matches=[],this.buffer="",this.bufferPos=0,this.iter=e.iterRange(i,s),this.bufferStart=i,this.normalize=r?l=>r(Uu(l)):Uu,this.query=this.normalize(t)}peek(){if(this.bufferPos==this.buffer.length){if(this.bufferStart+=this.buffer.length,this.iter.next(),this.iter.done)return-1;this.bufferPos=0,this.buffer=this.iter.value}return he(this.buffer,this.bufferPos)}next(){for(;this.matches.length;)this.matches.pop();return this.nextOverlapping()}nextOverlapping(){for(;;){let e=this.peek();if(e<0)return this.done=!0,this;let t=Ii(e),i=this.bufferStart+this.bufferPos;this.bufferPos+=Be(e);let s=this.normalize(t);if(s.length)for(let r=0,o=i,l=!0;;r++){let a=s.charCodeAt(r),h=this.match(a,o,l,this.bufferPos+this.bufferStart,r==s.length-1);if(h)return this.value=h,this;if(r==s.length-1)break;l&&r<t.length&&t.charCodeAt(r)==a?o++:l=!1}}}match(e,t,i,s,r){let o=null;for(let l=0;l<this.matches.length;){let a=this.matches[l],h=!1;this.query.charCodeAt(a.index)==e&&(a.index==this.query.length-1?o={from:a.from,to:s,precise:r&&a.precise}:(a.index++,h=!0)),h?l++:this.matches.splice(l,1)}return this.query.charCodeAt(0)==e&&(this.query.length==1?o={from:t,to:s,precise:i&&r}:this.matches.push({from:t,index:1,precise:i})),o&&this.test&&!this.test(o.from,o.to,this.buffer,this.bufferStart)&&(o=null),o}};typeof Symbol<"u"&&(Tt.prototype[Symbol.iterator]=function(){return this});var Yu={from:-1,to:-1,match:/.*/.exec(""),precise:!0},aa="gm"+(/x/.unicode==null?"":"u"),Us=class{constructor(e,t,i,s=0,r=e.length){if(this.text=e,this.to=r,this.curLine="",this.done=!1,this.value=Yu,/\\[sWDnr]|\n|\r|\[\^/.test(t))return new _s(e,t,i,s,r);this.re=new RegExp(t,aa+(i?.ignoreCase?"i":"")),this.test=i?.test,this.iter=e.iter();let o=e.lineAt(s);this.curLineStart=o.from,this.matchPos=Ys(e,s),this.getLine(this.curLineStart)}getLine(e){this.iter.next(e),this.iter.lineBreak?this.curLine="":(this.curLine=this.iter.value,this.curLineStart+this.curLine.length>this.to&&(this.curLine=this.curLine.slice(0,this.to-this.curLineStart)),this.iter.next())}nextLine(){this.curLineStart=this.curLineStart+this.curLine.length+1,this.curLineStart>this.to?this.curLine="":this.getLine(0)}next(){for(let e=this.matchPos-this.curLineStart;;){this.re.lastIndex=e;let t=this.matchPos<=this.to&&this.re.exec(this.curLine);if(t){let i=this.curLineStart+t.index,s=i+t[0].length;if(this.matchPos=Ys(this.text,s+(i==s?1:0)),i==this.curLineStart+this.curLine.length&&this.nextLine(),(i<s||i>this.value.to)&&(!this.test||this.test(i,s,t)))return this.value={from:i,to:s,precise:!0,match:t},this;e=this.matchPos-this.curLineStart}else if(this.curLineStart+this.curLine.length<this.to)this.nextLine(),e=0;else return this.done=!0,this}}},ia=new WeakMap,Gs=class n{constructor(e,t){this.from=e,this.text=t}get to(){return this.from+this.text.length}static get(e,t,i){let s=ia.get(e);if(!s||s.from>=i||s.to<=t){let l=new n(t,e.sliceString(t,i));return ia.set(e,l),l}if(s.from==t&&s.to==i)return s;let{text:r,from:o}=s;return o>t&&(r=e.sliceString(t,o)+r,o=t),s.to<i&&(r+=e.sliceString(s.to,i)),ia.set(e,new n(o,r)),new n(t,r.slice(t-o,i-o))}},_s=class{constructor(e,t,i,s,r){this.text=e,this.to=r,this.done=!1,this.value=Yu,this.matchPos=Ys(e,s),this.re=new RegExp(t,aa+(i?.ignoreCase?"i":"")),this.test=i?.test,this.flat=Gs.get(e,s,this.chunkEnd(s+5e3))}chunkEnd(e){return e>=this.to?this.to:this.text.lineAt(e).to}next(){for(;;){let e=this.re.lastIndex=this.matchPos-this.flat.from,t=this.re.exec(this.flat.text);if(t&&!t[0]&&t.index==e&&(this.re.lastIndex=e+1,t=this.re.exec(this.flat.text)),t){let i=this.flat.from+t.index,s=i+t[0].length;if((this.flat.to>=this.to||t.index+t[0].length<=this.flat.text.length-10)&&(!this.test||this.test(i,s,t)))return this.value={from:i,to:s,precise:!0,match:t},this.matchPos=Ys(this.text,s+(i==s?1:0)),this}if(this.flat.to==this.to)return this.done=!0,this;this.flat=Gs.get(this.text,this.flat.from,this.chunkEnd(this.flat.from+this.flat.text.length*2))}}};typeof Symbol<"u"&&(Us.prototype[Symbol.iterator]=_s.prototype[Symbol.iterator]=function(){return this});function U0(n){try{return new RegExp(n,aa),!0}catch{return!1}}function Ys(n,e){if(e>=n.length)return e;let t=n.lineAt(e),i;for(;e<t.to&&(i=t.text.charCodeAt(e-t.from))>=56320&&i<57344;)e++;return e}var ha=n=>{let e=mf(n,"cm-goto-line");if(e){let o=e.dom.querySelector("input[type=text]");return o&&o.select(),!0}let{state:t}=n,i=String(t.doc.lineAt(n.state.selection.main.head).number),{close:s,result:r}=pf(n,{class:"cm-goto-line",label:t.phrase("Go to line"),input:{type:"text",name:"line",value:i},focus:!0,submitLabel:t.phrase("go")});return r.then(o=>{let l=o&&/^([+-])?(\d+)?(:\d+)?(%)?$/.exec(o.elements.line.value);if(!l){n.dispatch({effects:s});return}let a=t.doc.lineAt(t.selection.main.head),[,h,c,f,u]=l,d=f?+f.slice(1):0,p=c?+c:a.number;if(c&&u){let y=p/100;h&&(y=y*(h=="-"?-1:1)+a.number/t.doc.lines),p=Math.round(t.doc.lines*y)}else c&&h&&(p=p*(h=="-"?-1:1)+a.number);let m=t.doc.line(Math.max(1,Math.min(t.doc.lines,p))),g=b.cursor(m.from+Math.max(0,Math.min(d,m.length)));n.dispatch({effects:[s,O.scrollIntoView(g.from,{y:"center"})],selection:g})}),!0},G0={highlightWordAroundCursor:!1,minSelectionLength:1,maxMatches:100,wholeWords:!1},Xu=C.define({combine(n){return me(n,G0,{highlightWordAroundCursor:(e,t)=>e||t,minSelectionLength:Math.min,maxMatches:Math.min})}});function Ju(n){let e=[Q0,J0];return n&&e.push(Xu.of(n)),e}var _0=B.mark({class:"cm-selectionMatch"}),Y0=B.mark({class:"cm-selectionMatch cm-selectionMatch-main"});function Gu(n,e,t,i){return(t==0||n(e.sliceDoc(t-1,t))!=$.Word)&&(i==e.doc.length||n(e.sliceDoc(i,i+1))!=$.Word)}function X0(n,e,t,i){return n(e.sliceDoc(t,t+1))==$.Word&&n(e.sliceDoc(i-1,i))==$.Word}var J0=K.fromClass(class{constructor(n){this.decorations=this.getDeco(n)}update(n){(n.selectionSet||n.docChanged||n.viewportChanged)&&(this.decorations=this.getDeco(n.view))}getDeco(n){let e=n.state.facet(Xu),{state:t}=n,i=t.selection;if(i.ranges.length>1)return B.none;let s=i.main,r,o=null;if(s.empty){if(!e.highlightWordAroundCursor)return B.none;let a=t.wordAt(s.head);if(!a)return B.none;o=t.charCategorizer(s.head),r=t.sliceDoc(a.from,a.to)}else{let a=s.to-s.from;if(a<e.minSelectionLength||a>200)return B.none;if(e.wholeWords){if(r=t.sliceDoc(s.from,s.to),o=t.charCategorizer(s.head),!(Gu(o,t,s.from,s.to)&&X0(o,t,s.from,s.to)))return B.none}else if(r=t.sliceDoc(s.from,s.to),!r)return B.none}let l=[];for(let a of n.visibleRanges){let h=new Tt(t.doc,r,a.from,a.to);for(;!h.next().done;){let{from:c,to:f}=h.value;if((!o||Gu(o,t,c,f))&&(s.empty&&c<=s.from&&f>=s.to?l.push(Y0.range(c,f)):(c>=s.to||f<=s.from)&&l.push(_0.range(c,f)),l.length>e.maxMatches))return B.none}}return B.set(l)}},{decorations:n=>n.decorations}),Q0=O.baseTheme({".cm-selectionMatch":{backgroundColor:"#99ff7780"},".cm-searchMatch .cm-selectionMatch":{backgroundColor:"transparent"}}),Z0=({state:n,dispatch:e})=>{let{selection:t}=n,i=b.create(t.ranges.map(s=>n.wordAt(s.head)||b.cursor(s.head)),t.mainIndex);return i.eq(t)?!1:(e(n.update({selection:i})),!0)};function ey(n,e){let{main:t,ranges:i}=n.selection,s=n.wordAt(t.head),r=s&&s.from==t.from&&s.to==t.to;for(let o=!1,l=new Tt(n.doc,e,i[i.length-1].to);;)if(l.next(),l.done){if(o)return null;l=new Tt(n.doc,e,0,Math.max(0,i[i.length-1].from-1)),o=!0}else{if(o&&i.some(a=>a.from==l.value.from))continue;if(r){let a=n.wordAt(l.value.from);if(!a||a.from!=l.value.from||a.to!=l.value.to)continue}return l.value}}var ca=({state:n,dispatch:e})=>{let{ranges:t}=n.selection;if(t.some(r=>r.from===r.to))return Z0({state:n,dispatch:e});let i=n.sliceDoc(t[0].from,t[0].to);if(n.selection.ranges.some(r=>n.sliceDoc(r.from,r.to)!=i))return!1;let s=ey(n,i);return s?(e(n.update({selection:n.selection.addRange(b.range(s.from,s.to),!1),effects:O.scrollIntoView(s.to)})),!0):!1},Gt=C.define({combine(n){return me(n,{top:!1,caseSensitive:!1,literal:!1,regexp:!1,wholeWord:!1,createPanel:e=>new oa(e),scrollToMatch:e=>O.scrollIntoView(e)})}});function Qu(n){return n?[Gt.of(n),la]:la}var Xs=class{constructor(e){this.search=e.search,this.caseSensitive=!!e.caseSensitive,this.literal=!!e.literal,this.regexp=!!e.regexp,this.replace=e.replace||"",this.valid=!!this.search&&(!this.regexp||U0(this.search)),this.unquoted=this.unquote(this.search),this.wholeWord=!!e.wholeWord,this.test=e.test}unquote(e){return this.literal?e:e.replace(/\\([nrt\\])/g,(t,i)=>i=="n"?`
`:i=="r"?"\r":i=="t"?"	":"\\")}eq(e){return this.search==e.search&&this.replace==e.replace&&this.caseSensitive==e.caseSensitive&&this.regexp==e.regexp&&this.wholeWord==e.wholeWord&&this.test==e.test}create(){return this.regexp?new sa(this):new na(this)}getCursor(e,t=0,i){let s=e.doc?e:U.create({doc:e});return i==null&&(i=s.doc.length),this.regexp?Ti(this,s,t,i):Mi(this,s,t,i)}},Js=class{constructor(e){this.spec=e}};function ty(n,e,t){return(i,s,r,o)=>{if(t&&!t(i,s,r,o))return!1;let l=i>=o&&s<=o+r.length?r.slice(i-o,s-o):e.doc.sliceString(i,s);return n(l,e,i,s)}}function Mi(n,e,t,i){let s;return n.wholeWord&&(s=iy(e.doc,e.charCategorizer(e.selection.main.head))),n.test&&(s=ty(n.test,e,s)),new Tt(e.doc,n.unquoted,t,i,n.caseSensitive?void 0:r=>r.toLowerCase(),s)}function iy(n,e){return(t,i,s,r)=>((r>t||r+s.length<i)&&(r=Math.max(0,t-2),s=n.sliceString(r,Math.min(n.length,i+2))),(e(Qs(s,t-r))!=$.Word||e(Zs(s,t-r))!=$.Word)&&(e(Zs(s,i-r))!=$.Word||e(Qs(s,i-r))!=$.Word))}var na=class extends Js{constructor(e){super(e)}nextMatch(e,t,i){let s=Mi(this.spec,e,i,e.doc.length).nextOverlapping();if(s.done){let r=Math.min(e.doc.length,t+this.spec.unquoted.length);s=Mi(this.spec,e,0,r).nextOverlapping()}return s.done||s.value.from==t&&s.value.to==i?null:s.value}prevMatchInRange(e,t,i){for(let s=i;;){let r=Math.max(t,s-1e4-this.spec.unquoted.length),o=Mi(this.spec,e,r,s),l=null;for(;!o.nextOverlapping().done;)l=o.value;if(l)return l;if(r==t)return null;s-=1e4}}prevMatch(e,t,i){let s=this.prevMatchInRange(e,0,t);return s||(s=this.prevMatchInRange(e,Math.max(0,i-this.spec.unquoted.length),e.doc.length)),s&&(s.from!=t||s.to!=i)?s:null}getReplacement(e){return this.spec.unquote(this.spec.replace)}matchAll(e,t){let i=Mi(this.spec,e,0,e.doc.length),s=[];for(;!i.next().done;){if(s.length>=t)return null;s.push(i.value)}return s}highlight(e,t,i,s){let r=Mi(this.spec,e,Math.max(0,t-this.spec.unquoted.length),Math.min(i+this.spec.unquoted.length,e.doc.length));for(;!r.next().done;)s(r.value.from,r.value.to)}};function ny(n,e,t){return(i,s,r)=>(!t||t(i,s,r))&&n(r[0],e,i,s)}function Ti(n,e,t,i){let s;return n.wholeWord&&(s=sy(e.charCategorizer(e.selection.main.head))),n.test&&(s=ny(n.test,e,s)),new Us(e.doc,n.search,{ignoreCase:!n.caseSensitive,test:s},t,i)}function Qs(n,e){return n.slice(ee(n,e,!1),e)}function Zs(n,e){return n.slice(e,ee(n,e))}function sy(n){return(e,t,i)=>!i[0].length||(n(Qs(i.input,i.index))!=$.Word||n(Zs(i.input,i.index))!=$.Word)&&(n(Zs(i.input,i.index+i[0].length))!=$.Word||n(Qs(i.input,i.index+i[0].length))!=$.Word)}var sa=class extends Js{nextMatch(e,t,i){let s=Ti(this.spec,e,i,e.doc.length).next();return s.done&&(s=Ti(this.spec,e,0,t).next()),s.done?null:s.value}prevMatchInRange(e,t,i){for(let s=1;;s++){let r=Math.max(t,i-s*1e4),o=Ti(this.spec,e,r,i),l=null;for(;!o.next().done;)l=o.value;if(l&&(r==t||l.from>r+10))return l;if(r==t)return null}}prevMatch(e,t,i){return this.prevMatchInRange(e,0,t)||this.prevMatchInRange(e,i,e.doc.length)}getReplacement(e){return this.spec.unquote(this.spec.replace).replace(/\$([$&]|\d+)/g,(t,i)=>{if(i=="&")return e.match[0];if(i=="$")return"$";for(let s=i.length;s>0;s--){let r=+i.slice(0,s);if(r>0&&r<e.match.length)return e.match[r]+i.slice(s)}return t})}matchAll(e,t){let i=Ti(this.spec,e,0,e.doc.length),s=[];for(;!i.next().done;){if(s.length>=t)return null;s.push(i.value)}return s}highlight(e,t,i,s){let r=Ti(this.spec,e,Math.max(0,t-250),Math.min(i+250,e.doc.length));for(;!r.next().done;)s(r.value.from,r.value.to)}},bn=L.define(),fa=L.define(),Mt=_.define({create(n){return new yn(ra(n).create(),null)},update(n,e){for(let t of e.effects)t.is(bn)?n=new yn(t.value.create(),n.panel):t.is(fa)&&(n=new yn(n.query,t.value?da:null));return n},provide:n=>Wt.from(n,e=>e.panel)});var yn=class{constructor(e,t){this.query=e,this.panel=t}},ry=B.mark({class:"cm-searchMatch"}),oy=B.mark({class:"cm-searchMatch cm-searchMatch-selected"}),ly=K.fromClass(class{constructor(n){this.view=n,this.decorations=this.highlight(n.state.field(Mt))}update(n){let e=n.state.field(Mt);(e!=n.startState.field(Mt)||n.docChanged||n.selectionSet||n.viewportChanged)&&(this.decorations=this.highlight(e))}highlight({query:n,panel:e}){if(!e||!n.spec.valid)return B.none;let{view:t}=this,i=new pe;for(let s=0,r=t.visibleRanges,o=r.length;s<o;s++){let{from:l,to:a}=r[s];for(;s<o-1&&a>r[s+1].from-500;)a=r[++s].to;n.highlight(t.state,l,a,(h,c)=>{let f=t.state.selection.ranges.some(u=>u.from==h&&u.to==c);i.add(h,c,f?oy:ry)})}return i.finish()}},{decorations:n=>n.decorations});function xn(n){return e=>{let t=e.state.field(Mt,!1);return t&&t.query.spec.valid?n(e,t):ir(e)}}var er=xn((n,{query:e})=>{let{to:t}=n.state.selection.main,i=e.nextMatch(n.state,t,t);if(!i)return!1;let s=b.single(i.from,i.to),r=n.state.facet(Gt);return n.dispatch({selection:s,effects:[pa(n,i),r.scrollToMatch(s.main,n)],userEvent:"select.search"}),ed(n),!0}),tr=xn((n,{query:e})=>{let{state:t}=n,{from:i}=t.selection.main,s=e.prevMatch(t,i,i);if(!s)return!1;let r=b.single(s.from,s.to),o=n.state.facet(Gt);return n.dispatch({selection:r,effects:[pa(n,s),o.scrollToMatch(r.main,n)],userEvent:"select.search"}),ed(n),!0}),ay=xn((n,{query:e})=>{let t=e.matchAll(n.state,1e3);return!t||!t.length?!1:(n.dispatch({selection:b.create(t.map(i=>b.range(i.from,i.to))),userEvent:"select.search.matches"}),!0)}),ua=({state:n,dispatch:e})=>{let t=n.selection;if(t.ranges.length>1||t.main.empty)return!1;let{from:i,to:s}=t.main,r=[],o=0;for(let l=new Tt(n.doc,n.sliceDoc(i,s));!l.next().done;){if(r.length>1e3)return!1;l.value.from==i&&(o=r.length),r.push(b.range(l.value.from,l.value.to))}return e(n.update({selection:b.create(r,o),userEvent:"select.search.matches"})),!0},_u=xn((n,{query:e})=>{let{state:t}=n,{from:i,to:s}=t.selection.main;if(t.readOnly)return!1;let r=e.nextMatch(t,i,i);if(!r)return!1;let o=r,l=[],a,h,c=[];o.precise?o.from==i&&o.to==s&&(h=t.toText(e.getReplacement(o)),l.push({from:o.from,to:o.to,insert:h}),o=e.nextMatch(t,o.from,o.to),c.push(O.announce.of(t.phrase("replaced match on line $",t.doc.lineAt(i).number)+"."))):o=e.nextMatch(t,o.from,o.to);let f=n.state.changes(l);return o&&(a=b.single(o.from,o.to).map(f),c.push(pa(n,o)),c.push(t.facet(Gt).scrollToMatch(a.main,n))),n.dispatch({changes:f,selection:a,effects:c,userEvent:"input.replace"}),!0}),hy=xn((n,{query:e})=>{if(n.state.readOnly)return!1;let t=[];for(let s of e.matchAll(n.state,1e9)){let{from:r,to:o,precise:l}=s;l&&t.push({from:r,to:o,insert:e.getReplacement(s)})}if(!t.length)return!1;let i=n.state.phrase("replaced $ matches",t.length)+".";return n.dispatch({changes:t,effects:O.announce.of(i),userEvent:"input.replace.all"}),!0});function da(n){return n.state.facet(Gt).createPanel(n)}function ra(n,e){var t,i,s,r,o;let l=n.selection.main,a=l.empty||l.to>l.from+100?"":n.sliceDoc(l.from,l.to);if(e&&!a)return e;let h=n.facet(Gt);return new Xs({search:((t=e?.literal)!==null&&t!==void 0?t:h.literal)?a:a.replace(/\n/g,"\\n"),caseSensitive:(i=e?.caseSensitive)!==null&&i!==void 0?i:h.caseSensitive,literal:(s=e?.literal)!==null&&s!==void 0?s:h.literal,regexp:(r=e?.regexp)!==null&&r!==void 0?r:h.regexp,wholeWord:(o=e?.wholeWord)!==null&&o!==void 0?o:h.wholeWord})}function Zu(n){let e=vi(n,da);return e&&e.dom.querySelector("[main-field]")}function ed(n){let e=Zu(n);e&&e==n.root.activeElement&&e.select()}var ir=n=>{let e=n.state.field(Mt,!1);if(e&&e.panel){let t=Zu(n);if(t&&t!=n.root.activeElement){let i=ra(n.state,e.query.spec);i.valid&&n.dispatch({effects:bn.of(i)}),t.focus(),t.select()}}else n.dispatch({effects:[fa.of(!0),e?bn.of(ra(n.state,e.query.spec)):L.appendConfig.of(la)]});return!0},nr=n=>{let e=n.state.field(Mt,!1);if(!e||!e.panel)return!1;let t=vi(n,da);return t&&t.dom.contains(n.root.activeElement)&&n.focus(),n.dispatch({effects:fa.of(!1)}),!0},td=[{key:"Mod-f",run:ir,scope:"editor search-panel"},{key:"F3",run:er,shift:tr,scope:"editor search-panel",preventDefault:!0},{key:"Mod-g",run:er,shift:tr,scope:"editor search-panel",preventDefault:!0},{key:"Escape",run:nr,scope:"editor search-panel"},{key:"Mod-Shift-l",run:ua},{key:"Mod-Alt-g",run:ha},{key:"Mod-d",run:ca,preventDefault:!0}],oa=class{constructor(e){this.view=e;let t=this.query=e.state.field(Mt).query.spec;this.commit=this.commit.bind(this),this.searchField=W("input",{value:t.search,placeholder:Pe(e,"Find"),"aria-label":Pe(e,"Find"),class:"cm-textfield",name:"search",form:"","main-field":"true",onchange:this.commit,onkeyup:this.commit}),this.replaceField=W("input",{value:t.replace,placeholder:Pe(e,"Replace"),"aria-label":Pe(e,"Replace"),class:"cm-textfield",name:"replace",form:"",onchange:this.commit,onkeyup:this.commit}),this.caseField=W("input",{type:"checkbox",name:"case",form:"",checked:t.caseSensitive,onchange:this.commit}),this.reField=W("input",{type:"checkbox",name:"re",form:"",checked:t.regexp,onchange:this.commit}),this.wordField=W("input",{type:"checkbox",name:"word",form:"",checked:t.wholeWord,onchange:this.commit});function i(s,r,o){return W("button",{class:"cm-button",name:s,onclick:r,type:"button"},o)}this.dom=W("div",{onkeydown:s=>this.keydown(s),class:"cm-search"},[this.searchField,i("next",()=>er(e),[Pe(e,"next")]),i("prev",()=>tr(e),[Pe(e,"previous")]),i("select",()=>ay(e),[Pe(e,"all")]),W("label",null,[this.caseField,Pe(e,"match case")]),W("label",null,[this.reField,Pe(e,"regexp")]),W("label",null,[this.wordField,Pe(e,"by word")]),...e.state.readOnly?[]:[W("br"),this.replaceField,i("replace",()=>_u(e),[Pe(e,"replace")]),i("replaceAll",()=>hy(e),[Pe(e,"replace all")])],W("button",{name:"close",onclick:()=>nr(e),"aria-label":Pe(e,"close"),type:"button"},["\xD7"])])}commit(){let e=new Xs({search:this.searchField.value,caseSensitive:this.caseField.checked,regexp:this.reField.checked,wholeWord:this.wordField.checked,replace:this.replaceField.value});e.eq(this.query)||(this.query=e,this.view.dispatch({effects:bn.of(e)}))}keydown(e){_c(this.view,e,"search-panel")?e.preventDefault():e.keyCode==13&&e.target==this.searchField?(e.preventDefault(),(e.shiftKey?tr:er)(this.view)):e.keyCode==13&&e.target==this.replaceField&&(e.preventDefault(),_u(this.view))}update(e){for(let t of e.transactions)for(let i of t.effects)i.is(bn)&&!i.value.eq(this.query)&&this.setQuery(i.value)}setQuery(e){this.query=e,this.searchField.value=e.search,this.replaceField.value=e.replace,this.caseField.checked=e.caseSensitive,this.reField.checked=e.regexp,this.wordField.checked=e.wholeWord}mount(){this.searchField.select()}get pos(){return 80}get top(){return this.view.state.facet(Gt).top}};function Pe(n,e){return n.state.phrase(e)}var $s=30,js=/[\s\.,:;?!]/;function pa(n,{from:e,to:t}){let i=n.state.doc.lineAt(e),s=n.state.doc.lineAt(t).to,r=Math.max(i.from,e-$s),o=Math.min(s,t+$s),l=n.state.sliceDoc(r,o);if(r!=i.from){for(let a=0;a<$s;a++)if(!js.test(l[a+1])&&js.test(l[a])){l=l.slice(a);break}}if(o!=s){for(let a=l.length-1;a>l.length-$s;a--)if(!js.test(l[a-1])&&js.test(l[a])){l=l.slice(0,a);break}}return O.announce.of(`${n.state.phrase("current match")}. ${l} ${n.state.phrase("on line")} ${i.number}.`)}var cy=O.baseTheme({".cm-panel.cm-search":{padding:"2px 6px 4px",position:"relative","& [name=close]":{position:"absolute",top:"0",right:"4px",backgroundColor:"inherit",border:"none",font:"inherit",padding:0,margin:0},"& input, & button, & label":{margin:".2em .6em .2em 0"},"& input[type=checkbox]":{marginRight:".2em"},"& label":{fontSize:"80%",whiteSpace:"pre"}},"&light .cm-searchMatch":{backgroundColor:"#ffff0054"},"&dark .cm-searchMatch":{backgroundColor:"#00ffff8a"},"&light .cm-searchMatch-selected":{backgroundColor:"#ff6a0054"},"&dark .cm-searchMatch-selected":{backgroundColor:"#ff00ff8a"}}),la=[Mt,Se.low(ly),cy];var rr=class{constructor(e,t,i,s){this.state=e,this.pos=t,this.explicit=i,this.view=s,this.abortListeners=[],this.abortOnDocChange=!1}tokenBefore(e){let t=oe(this.state).resolveInner(this.pos,-1);for(;t&&e.indexOf(t.name)<0;)t=t.parent;return t?{from:t.from,to:this.pos,text:this.state.sliceDoc(t.from,this.pos),type:t.type}:null}matchBefore(e){let t=this.state.doc.lineAt(this.pos),i=Math.max(t.from,this.pos-250),s=t.text.slice(i-t.from,this.pos-t.from),r=s.search(cd(e,!1));return r<0?null:{from:i+r,to:this.pos,text:s.slice(r)}}get aborted(){return this.abortListeners==null}addEventListener(e,t,i){e=="abort"&&this.abortListeners&&(this.abortListeners.push(t),i&&i.onDocChange&&(this.abortOnDocChange=!0))}};function id(n){let e=Object.keys(n).join(""),t=/\w/.test(e);return t&&(e=e.replace(/\w/g,"")),`[${t?"\\w":""}${e.replace(/[^\w\s]/g,"\\$&")}]`}function fy(n){let e=Object.create(null),t=Object.create(null);for(let{label:s}of n){e[s[0]]=!0;for(let r=1;r<s.length;r++)t[s[r]]=!0}let i=id(e)+id(t)+"*$";return[new RegExp("^"+i),new RegExp(i)]}function uy(n){let e=n.map(s=>typeof s=="string"?{label:s}:s),[t,i]=e.every(s=>/^\w+$/.test(s.label))?[/\w*$/,/\w+$/]:fy(e);return s=>{let r=s.matchBefore(i);return r||s.explicit?{from:r?r.from:s.pos,options:e,validFor:t}:null}}var or=class{constructor(e,t,i,s){this.completion=e,this.source=t,this.match=i,this.score=s}};function Yt(n){return n.selection.main.from}function cd(n,e){var t;let{source:i}=n,s=e&&i[0]!="^",r=i[i.length-1]!="$";return!s&&!r?n:new RegExp(`${s?"^":""}(?:${i})${r?"$":""}`,(t=n.flags)!==null&&t!==void 0?t:n.ignoreCase?"i":"")}var Ma=xe.define();function dy(n,e,t,i){let{main:s}=n.selection,r=t-s.from,o=i-s.from;return{...n.changeByRange(l=>{if(l!=s&&t!=i&&n.sliceDoc(l.from+r,l.from+o)!=n.sliceDoc(t,i))return{range:l};let a=n.toText(e);return{changes:{from:l.from+r,to:i==s.from?l.to:l.from+o,insert:a},range:b.cursor(l.from+r+a.length)}}),scrollIntoView:!0,userEvent:"input.complete"}}var nd=new WeakMap;function py(n){if(!Array.isArray(n))return n;let e=nd.get(n);return e||nd.set(n,e=uy(n)),e}var lr=L.define(),vn=L.define(),ya=class{constructor(e){this.pattern=e,this.chars=[],this.folded=[],this.any=[],this.precise=[],this.byWord=[],this.score=0,this.matched=[];for(let t=0;t<e.length;){let i=he(e,t),s=Be(i);this.chars.push(i);let r=e.slice(t,t+s),o=r.toUpperCase();this.folded.push(he(o==r?r.toLowerCase():o,0)),t+=s}this.astral=e.length!=this.chars.length}ret(e,t){return this.score=e,this.matched=t,this}match(e){if(this.pattern.length==0)return this.ret(-100,[]);if(e.length<this.pattern.length)return null;let{chars:t,folded:i,any:s,precise:r,byWord:o}=this;if(t.length==1){let v=he(e,0),x=Be(v),D=x==e.length?0:-100;if(v!=t[0])if(v==i[0])D+=-200;else return null;return this.ret(D,[0,x])}let l=e.indexOf(this.pattern);if(l==0)return this.ret(e.length==this.pattern.length?0:-100,[0,this.pattern.length]);let a=t.length,h=0;if(l<0){for(let v=0,x=Math.min(e.length,200);v<x&&h<a;){let D=he(e,v);(D==t[h]||D==i[h])&&(s[h++]=v),v+=Be(D)}if(h<a)return null}let c=0,f=0,u=!1,d=0,p=-1,m=-1,g=/[a-z]/.test(e),y=!0;for(let v=0,x=Math.min(e.length,200),D=0;v<x&&f<a;){let w=he(e,v);l<0&&(c<a&&w==t[c]&&(r[c++]=v),d<a&&(w==t[d]||w==i[d]?(d==0&&(p=v),m=v+1,d++):d=0));let k,S=w<255?w>=48&&w<=57||w>=97&&w<=122?2:w>=65&&w<=90?1:0:(k=Ii(w))!=k.toLowerCase()?1:k!=k.toUpperCase()?2:0;(!v||S==1&&g||D==0&&S!=0)&&(t[f]==w||i[f]==w&&(u=!0)?o[f++]=v:o.length&&(y=!1)),D=S,v+=Be(w)}return f==a&&o[0]==0&&y?this.result(-100+(u?-200:0),o,e):d==a&&p==0?this.ret(-200-e.length+(m==e.length?0:-100),[0,m]):l>-1?this.ret(-700-e.length,[l,l+this.pattern.length]):d==a?this.ret(-900-e.length,[p,m]):f==a?this.result(-100+(u?-200:0)+-700+(y?0:-1100),o,e):t.length==2?null:this.result((s[0]?-700:0)+-200+-1100,s,e)}result(e,t,i){let s=[],r=0;for(let o of t){let l=o+(this.astral?Be(he(i,o)):1);r&&s[r-1]==o?s[r-1]=l:(s[r++]=o,s[r++]=l)}return this.ret(e-i.length,s)}},ba=class{constructor(e){this.pattern=e,this.matched=[],this.score=0,this.folded=e.toLowerCase()}match(e){if(e.length<this.pattern.length)return null;let t=e.slice(0,this.pattern.length),i=t==this.pattern?0:t.toLowerCase()==this.folded?-200:null;return i==null?null:(this.matched=[0,t.length],this.score=i+(e.length==this.pattern.length?0:-100),this)}},le=C.define({combine(n){return me(n,{activateOnTyping:!0,activateOnCompletion:()=>!1,activateOnTypingDelay:100,selectOnOpen:!0,override:null,closeOnBlur:!0,maxRenderedOptions:100,defaultKeymap:!0,tooltipClass:()=>"",optionClass:()=>"",aboveCursor:!1,icons:!0,addToOptions:[],positionInfo:my,filterStrict:!1,compareCompletions:(e,t)=>(e.sortText||e.label).localeCompare(t.sortText||t.label),interactionDelay:75,updateSyncTime:100},{defaultKeymap:(e,t)=>e&&t,closeOnBlur:(e,t)=>e&&t,icons:(e,t)=>e&&t,tooltipClass:(e,t)=>i=>sd(e(i),t(i)),optionClass:(e,t)=>i=>sd(e(i),t(i)),addToOptions:(e,t)=>e.concat(t),filterStrict:(e,t)=>e||t})}});function sd(n,e){return n?e?n+" "+e:n:e}function my(n,e,t,i,s,r){let o=n.textDirection==z.RTL,l=o,a=!1,h="top",c,f,u=e.left-s.left,d=s.right-e.right,p=i.right-i.left,m=i.bottom-i.top;if(l&&u<Math.min(p,d)?l=!1:!l&&d<Math.min(p,u)&&(l=!0),p<=(l?u:d))c=Math.max(s.top,Math.min(t.top,s.bottom-m))-e.top,f=Math.min(400,l?u:d);else{a=!0,f=Math.min(400,(o?e.right:s.right-e.left)-30);let v=s.bottom-e.bottom;v>=m||v>e.top?c=t.bottom-e.top:(h="bottom",c=e.bottom-t.top)}let g=(e.bottom-e.top)/r.offsetHeight,y=(e.right-e.left)/r.offsetWidth;return{style:`${h}: ${c/g}px; max-width: ${f/y}px`,class:"cm-completionInfo-"+(a?o?"left-narrow":"right-narrow":l?"left":"right")}}var Ta=L.define();function gy(n){let e=n.addToOptions.slice();return n.icons&&e.push({render(t){let i=document.createElement("div");return i.classList.add("cm-completionIcon"),t.type&&i.classList.add(...t.type.split(/\s+/g).map(s=>"cm-completionIcon-"+s)),i.setAttribute("aria-hidden","true"),i},position:20}),e.push({render(t,i,s,r){let o=document.createElement("span");o.className="cm-completionLabel";let l=t.displayLabel||t.label,a=0;for(let h=0;h<r.length;){let c=r[h++],f=r[h++];c>a&&o.appendChild(document.createTextNode(l.slice(a,c)));let u=o.appendChild(document.createElement("span"));u.appendChild(document.createTextNode(l.slice(c,f))),u.className="cm-completionMatchedText",a=f}return a<l.length&&o.appendChild(document.createTextNode(l.slice(a))),o},position:50},{render(t){if(!t.detail)return null;let i=document.createElement("span");return i.className="cm-completionDetail",i.textContent=t.detail,i},position:80}),e.sort((t,i)=>t.position-i.position).map(t=>t.render)}function ma(n,e,t){if(n<=t)return{from:0,to:n};if(e<0&&(e=0),e<=n>>1){let s=Math.floor(e/t);return{from:s*t,to:(s+1)*t}}let i=Math.ceil((n-e)/t);return{from:n-i*t,to:n-(i-1)*t}}var xa=class{constructor(e,t,i){this.view=e,this.stateField=t,this.applyCompletion=i,this.info=null,this.infoDestroy=null,this.placeInfoReq={read:()=>this.measureInfo(),write:a=>this.placeInfo(a),key:this},this.space=null,this.currentClass="";let s=e.state.field(t),{options:r,selected:o}=s.open,l=e.state.facet(le);this.optionContent=gy(l),this.optionClass=l.optionClass,this.tooltipClass=l.tooltipClass,this.range=ma(r.length,o,l.maxRenderedOptions),this.dom=document.createElement("div"),this.dom.className="cm-tooltip-autocomplete",this.updateTooltipClass(e.state),this.dom.addEventListener("mousedown",a=>{let{options:h}=e.state.field(t).open;for(let c=a.target,f;c&&c!=this.dom;c=c.parentNode)if(c.nodeName=="LI"&&(f=/-(\d+)$/.exec(c.id))&&+f[1]<h.length){this.applyCompletion(e,h[+f[1]]),a.preventDefault();return}if(a.target==this.list){let c=this.list.classList.contains("cm-completionListIncompleteTop")&&a.clientY<this.list.firstChild.getBoundingClientRect().top?this.range.from-1:this.list.classList.contains("cm-completionListIncompleteBottom")&&a.clientY>this.list.lastChild.getBoundingClientRect().bottom?this.range.to:null;c!=null&&(e.dispatch({effects:Ta.of(c)}),a.preventDefault())}}),this.dom.addEventListener("focusout",a=>{let h=e.state.field(this.stateField,!1);h&&h.tooltip&&e.state.facet(le).closeOnBlur&&a.relatedTarget!=e.contentDOM&&e.dispatch({effects:vn.of(null)})}),this.showOptions(r,s.id)}mount(){this.updateSel()}showOptions(e,t){this.list&&this.list.remove(),this.list=this.dom.appendChild(this.createListBox(e,t,this.range)),this.list.addEventListener("scroll",()=>{this.info&&this.view.requestMeasure(this.placeInfoReq)})}update(e){var t;let i=e.state.field(this.stateField),s=e.startState.field(this.stateField);if(this.updateTooltipClass(e.state),i!=s){let{options:r,selected:o,disabled:l}=i.open;(!s.open||s.open.options!=r)&&(this.range=ma(r.length,o,e.state.facet(le).maxRenderedOptions),this.showOptions(r,i.id)),this.updateSel(),l!=((t=s.open)===null||t===void 0?void 0:t.disabled)&&this.dom.classList.toggle("cm-tooltip-autocomplete-disabled",!!l)}}updateTooltipClass(e){let t=this.tooltipClass(e);if(t!=this.currentClass){for(let i of this.currentClass.split(" "))i&&this.dom.classList.remove(i);for(let i of t.split(" "))i&&this.dom.classList.add(i);this.currentClass=t}}positioned(e){this.space=e,this.info&&this.view.requestMeasure(this.placeInfoReq)}updateSel(){let e=this.view.state.field(this.stateField),t=e.open;(t.selected>-1&&t.selected<this.range.from||t.selected>=this.range.to)&&(this.range=ma(t.options.length,t.selected,this.view.state.facet(le).maxRenderedOptions),this.showOptions(t.options,e.id));let i=this.updateSelectedOption(t.selected);if(i){this.destroyInfo();let{completion:s}=t.options[t.selected],{info:r}=s;if(!r)return;let o=typeof r=="string"?document.createTextNode(r):r(s);if(!o)return;"then"in o?o.then(l=>{l&&this.view.state.field(this.stateField,!1)==e&&this.addInfoPane(l,s)}).catch(l=>ce(this.view.state,l,"completion info")):(this.addInfoPane(o,s),i.setAttribute("aria-describedby",this.info.id))}}addInfoPane(e,t){this.destroyInfo();let i=this.info=document.createElement("div");if(i.className="cm-tooltip cm-completionInfo",i.id="cm-completionInfo-"+Math.floor(Math.random()*65535).toString(16),e.nodeType!=null)i.appendChild(e),this.infoDestroy=null;else{let{dom:s,destroy:r}=e;i.appendChild(s),this.infoDestroy=r||null}this.dom.appendChild(i),this.view.requestMeasure(this.placeInfoReq)}updateSelectedOption(e){let t=null;for(let i=this.list.firstChild,s=this.range.from;i;i=i.nextSibling,s++)i.nodeName!="LI"||!i.id?s--:s==e?i.hasAttribute("aria-selected")||(i.setAttribute("aria-selected","true"),t=i):i.hasAttribute("aria-selected")&&(i.removeAttribute("aria-selected"),i.removeAttribute("aria-describedby"));return t&&by(this.list,t),t}measureInfo(){let e=this.dom.querySelector("[aria-selected]");if(!e||!this.info)return null;let t=this.dom.getBoundingClientRect(),i=this.info.getBoundingClientRect(),s=e.getBoundingClientRect(),r=this.space;if(!r){let o=this.dom.ownerDocument.documentElement;r={left:0,top:0,right:o.clientWidth,bottom:o.clientHeight}}return s.top>Math.min(r.bottom,t.bottom)-10||s.bottom<Math.max(r.top,t.top)+10?null:this.view.state.facet(le).positionInfo(this.view,t,s,i,r,this.dom)}placeInfo(e){this.info&&(e?(e.style&&(this.info.style.cssText=e.style),this.info.className="cm-tooltip cm-completionInfo "+(e.class||"")):this.info.style.cssText="top: -1e6px")}createListBox(e,t,i){let s=document.createElement("ul");s.id=t,s.setAttribute("role","listbox"),s.setAttribute("aria-expanded","true"),s.setAttribute("aria-label",this.view.state.phrase("Completions")),s.addEventListener("mousedown",o=>{o.target==s&&o.preventDefault()});let r=null;for(let o=i.from;o<i.to;o++){let{completion:l,match:a}=e[o],{section:h}=l;if(h){let u=typeof h=="string"?h:h.name;if(u!=r&&(o>i.from||i.from==0))if(r=u,typeof h!="string"&&h.header)s.appendChild(h.header(h));else{let d=s.appendChild(document.createElement("completion-section"));d.textContent=u}}let c=s.appendChild(document.createElement("li"));c.id=t+"-"+o,c.setAttribute("role","option");let f=this.optionClass(l);f&&(c.className=f);for(let u of this.optionContent){let d=u(l,this.view.state,this.view,a);d&&c.appendChild(d)}}return i.from&&s.classList.add("cm-completionListIncompleteTop"),i.to<e.length&&s.classList.add("cm-completionListIncompleteBottom"),s}destroyInfo(){this.info&&(this.infoDestroy&&this.infoDestroy(),this.info.remove(),this.info=null)}destroy(){this.destroyInfo()}};function yy(n,e){return t=>new xa(t,n,e)}function by(n,e){let t=n.getBoundingClientRect(),i=e.getBoundingClientRect(),s=t.height/n.offsetHeight;i.top<t.top?n.scrollTop-=(t.top-i.top)/s:i.bottom>t.bottom&&(n.scrollTop+=(i.bottom-t.bottom)/s)}function rd(n){return(n.boost||0)*100+(n.apply?10:0)+(n.info?5:0)+(n.type?1:0)}function xy(n,e){let t=[],i=null,s=null,r=c=>{t.push(c);let{section:f}=c.completion;if(f){i||(i=[]);let u=typeof f=="string"?f:f.name;i.some(d=>d.name==u)||i.push(typeof f=="string"?{name:u}:f)}},o=e.facet(le);for(let c of n)if(c.hasResult()){let f=c.result.getMatch;if(c.result.filter===!1)for(let u of c.result.options)r(new or(u,c.source,f?f(u):[],1e9-t.length));else{let u=e.sliceDoc(c.from,c.to),d,p=o.filterStrict?new ba(u):new ya(u);for(let m of c.result.options)if(d=p.match(m.label)){let g=m.displayLabel?f?f(m,d.matched):[]:d.matched,y=d.score+(m.boost||0);if(r(new or(m,c.source,g,y)),typeof m.section=="object"&&m.section.rank==="dynamic"){let{name:v}=m.section;s||(s=Object.create(null)),s[v]=Math.max(y,s[v]||-1e9)}}}}if(i){let c=Object.create(null),f=0,u=(d,p)=>(d.rank==="dynamic"&&p.rank==="dynamic"?s[p.name]-s[d.name]:0)||(typeof d.rank=="number"?d.rank:1e9)-(typeof p.rank=="number"?p.rank:1e9)||(d.name<p.name?-1:1);for(let d of i.sort(u))f-=1e5,c[d.name]=f;for(let d of t){let{section:p}=d.completion;p&&(d.score+=c[typeof p=="string"?p:p.name])}}let l=[],a=null,h=o.compareCompletions;for(let c of t.sort((f,u)=>u.score-f.score||h(f.completion,u.completion))){let f=c.completion;!a||a.label!=f.label||a.detail!=f.detail||a.type!=null&&f.type!=null&&a.type!=f.type||a.apply!=f.apply||a.boost!=f.boost?l.push(c):rd(c.completion)>rd(a)&&(l[l.length-1]=c),a=c.completion}return l}var wa=class n{constructor(e,t,i,s,r,o){this.options=e,this.attrs=t,this.tooltip=i,this.timestamp=s,this.selected=r,this.disabled=o}setSelected(e,t){return e==this.selected||e>=this.options.length?this:new n(this.options,od(t,e),this.tooltip,this.timestamp,e,this.disabled)}static build(e,t,i,s,r,o){if(s&&!o&&e.some(h=>h.isPending))return s.setDisabled();let l=xy(e,t);if(!l.length)return s&&e.some(h=>h.isPending)?s.setDisabled():null;let a=t.facet(le).selectOnOpen?0:-1;if(s&&s.selected!=a&&s.selected!=-1){let h=s.options[s.selected].completion;for(let c=0;c<l.length;c++)if(l[c].completion==h){a=c;break}}return new n(l,od(i,a),{pos:e.reduce((h,c)=>c.hasResult()?Math.min(h,c.from):h,1e8),create:Ay,above:r.aboveCursor},s?s.timestamp:Date.now(),a,!1)}map(e){return new n(this.options,this.attrs,{...this.tooltip,pos:e.mapPos(this.tooltip.pos)},this.timestamp,this.selected,this.disabled)}setDisabled(){return new n(this.options,this.attrs,this.tooltip,this.timestamp,this.selected,!0)}},va=class n{constructor(e,t,i){this.active=e,this.id=t,this.open=i}static start(){return new n(Sy,"cm-ac-"+Math.floor(Math.random()*2e6).toString(36),null)}update(e){let{state:t}=e,i=t.facet(le),r=(i.override||t.languageDataAt("autocomplete",Yt(t)).map(py)).map(a=>(this.active.find(c=>c.source==a)||new ut(a,this.active.some(c=>c.state!=0)?1:0)).update(e,i));r.length==this.active.length&&r.every((a,h)=>a==this.active[h])&&(r=this.active);let o=this.open,l=e.effects.some(a=>a.is(Da));o&&e.docChanged&&(o=o.map(e.changes)),e.selection||r.some(a=>a.hasResult()&&e.changes.touchesRange(a.from,a.to))||!wy(r,this.active)||l?o=wa.build(r,t,this.id,o,i,l):o&&o.disabled&&!r.some(a=>a.isPending)&&(o=null),!o&&r.every(a=>!a.isPending)&&r.some(a=>a.hasResult())&&(r=r.map(a=>a.hasResult()?new ut(a.source,0):a));for(let a of e.effects)a.is(Ta)&&(o=o&&o.setSelected(a.value,this.id));return r==this.active&&o==this.open?this:new n(r,this.id,o)}get tooltip(){return this.open?this.open.tooltip:null}get attrs(){return this.open?this.open.attrs:this.active.length?vy:ky}};function wy(n,e){if(n==e)return!0;for(let t=0,i=0;;){for(;t<n.length&&!n[t].hasResult();)t++;for(;i<e.length&&!e[i].hasResult();)i++;let s=t==n.length,r=i==e.length;if(s||r)return s==r;if(n[t++].result!=e[i++].result)return!1}}var vy={"aria-autocomplete":"list"},ky={};function od(n,e){let t={"aria-autocomplete":"list","aria-haspopup":"listbox","aria-controls":n};return e>-1&&(t["aria-activedescendant"]=n+"-"+e),t}var Sy=[];function fd(n,e){if(n.isUserEvent("input.complete")){let i=n.annotation(Ma);if(i&&e.activateOnCompletion(i))return 12}let t=n.isUserEvent("input.type");return t&&e.activateOnTyping?5:t?1:n.isUserEvent("delete.backward")?2:n.selection?8:n.docChanged?16:0}var ut=class n{constructor(e,t,i=!1){this.source=e,this.state=t,this.explicit=i}hasResult(){return!1}get isPending(){return this.state==1}update(e,t){let i=fd(e,t),s=this;(i&8||i&16&&this.touches(e))&&(s=new n(s.source,0)),i&4&&s.state==0&&(s=new n(this.source,1)),s=s.updateFor(e,i);for(let r of e.effects)if(r.is(lr))s=new n(s.source,1,r.value);else if(r.is(vn))s=new n(s.source,0);else if(r.is(Da))for(let o of r.value)o.source==s.source&&(s=o);return s}updateFor(e,t){return this.map(e.changes)}map(e){return this}touches(e){return e.changes.touchesRange(Yt(e.state))}},ar=class n extends ut{constructor(e,t,i,s,r,o){super(e,3,t),this.limit=i,this.result=s,this.from=r,this.to=o}hasResult(){return!0}updateFor(e,t){var i;if(!(t&3))return this.map(e.changes);let s=this.result;s.map&&!e.changes.empty&&(s=s.map(s,e.changes));let r=e.changes.mapPos(this.from),o=e.changes.mapPos(this.to,1),l=Yt(e.state);if(l>o||!s||t&2&&(Yt(e.startState)==this.from||l<this.limit))return new ut(this.source,t&4?1:0);let a=e.changes.mapPos(this.limit);return Cy(s.validFor,e.state,r,o)?new n(this.source,this.explicit,a,s,r,o):s.update&&(s=s.update(s,r,o,new rr(e.state,l,!1)))?new n(this.source,this.explicit,a,s,s.from,(i=s.to)!==null&&i!==void 0?i:Yt(e.state)):new ut(this.source,1,this.explicit)}map(e){if(e.empty)return this;let t=this.result.map?this.result.map(this.result,e):this.result;return t?new n(this.source,this.explicit,e.mapPos(this.limit),t,e.mapPos(this.from),e.mapPos(this.to,1)):new ut(this.source,0)}touches(e){return e.changes.touchesRange(this.from,this.to)}};function Cy(n,e,t,i){if(!n)return!1;let s=e.sliceDoc(t,i);return typeof n=="function"?n(s,t,i,e):cd(n,!0).test(s)}var Da=L.define({map(n,e){return n.map(t=>t.map(e))}}),Me=_.define({create(){return va.start()},update(n,e){return n.update(e)},provide:n=>[bt.from(n,e=>e.tooltip),O.contentAttributes.from(n,e=>e.attrs)]});function Oa(n,e){let t=e.completion.apply||e.completion.label,i=n.state.field(Me).active.find(s=>s.source==e.source);return i instanceof ar?(typeof t=="string"?n.dispatch({...dy(n.state,t,i.from,i.to),annotations:Ma.of(e.completion)}):t(n,e.completion,i.from,i.to),!0):!1}var Ay=yy(Me,Oa);function sr(n,e="option"){return t=>{let i=t.state.field(Me,!1);if(!i||!i.open||i.open.disabled||Date.now()-i.open.timestamp<t.state.facet(le).interactionDelay)return!1;let s=1,r;e=="page"&&(r=nl(t,i.open.tooltip))&&(s=Math.max(2,Math.floor(r.dom.offsetHeight/r.dom.querySelector("li").offsetHeight)-1));let{length:o}=i.open.options,l=i.open.selected>-1?i.open.selected+s*(n?1:-1):n?0:o-1;return l<0?l=e=="page"?0:o-1:l>=o&&(l=e=="page"?o-1:0),t.dispatch({effects:Ta.of(l)}),!0}}var My=n=>{let e=n.state.field(Me,!1);return n.state.readOnly||!e||!e.open||e.open.selected<0||e.open.disabled||Date.now()-e.open.timestamp<n.state.facet(le).interactionDelay?!1:Oa(n,e.open.options[e.open.selected])},wn=n=>n.state.field(Me,!1)?(n.dispatch({effects:lr.of(!0)}),!0):!1,Ba=n=>{let e=n.state.field(Me,!1);return!e||!e.active.some(t=>t.state!=0)?!1:(n.dispatch({effects:vn.of(null)}),!0)},ka=class{constructor(e,t){this.active=e,this.context=t,this.time=Date.now(),this.updates=[],this.done=void 0}},Ty=50,Dy=1e3,Oy=K.fromClass(class{constructor(n){this.view=n,this.debounceUpdate=-1,this.running=[],this.debounceAccept=-1,this.pendingStart=!1,this.composing=0;for(let e of n.state.field(Me).active)e.isPending&&this.startQuery(e)}update(n){let e=n.state.field(Me),t=n.state.facet(le);if(!n.selectionSet&&!n.docChanged&&n.startState.field(Me)==e)return;let i=n.transactions.some(r=>{let o=fd(r,t);return o&8||(r.selection||r.docChanged)&&!(o&3)});for(let r=0;r<this.running.length;r++){let o=this.running[r];if(i||o.context.abortOnDocChange&&n.docChanged||o.updates.length+n.transactions.length>Ty&&Date.now()-o.time>Dy){for(let l of o.context.abortListeners)try{l()}catch(a){ce(this.view.state,a)}o.context.abortListeners=null,this.running.splice(r--,1)}else o.updates.push(...n.transactions)}this.debounceUpdate>-1&&clearTimeout(this.debounceUpdate),n.transactions.some(r=>r.effects.some(o=>o.is(lr)))&&(this.pendingStart=!0);let s=this.pendingStart?50:t.activateOnTypingDelay;if(this.debounceUpdate=e.active.some(r=>r.isPending&&!this.running.some(o=>o.active.source==r.source))?setTimeout(()=>this.startUpdate(),s):-1,this.composing!=0)for(let r of n.transactions)r.isUserEvent("input.type")?this.composing=2:this.composing==2&&r.selection&&(this.composing=3)}startUpdate(){this.debounceUpdate=-1,this.pendingStart=!1;let{state:n}=this.view,e=n.field(Me);for(let t of e.active)t.isPending&&!this.running.some(i=>i.active.source==t.source)&&this.startQuery(t);this.running.length&&e.open&&e.open.disabled&&(this.debounceAccept=setTimeout(()=>this.accept(),this.view.state.facet(le).updateSyncTime))}startQuery(n){let{state:e}=this.view,t=Yt(e),i=new rr(e,t,n.explicit,this.view),s=new ka(n,i);this.running.push(s),Promise.resolve(n.source(i)).then(r=>{s.context.aborted||(s.done=r||null,this.scheduleAccept())},r=>{this.view.dispatch({effects:vn.of(null)}),ce(this.view.state,r)})}scheduleAccept(){this.running.every(n=>n.done!==void 0)?this.accept():this.debounceAccept<0&&(this.debounceAccept=setTimeout(()=>this.accept(),this.view.state.facet(le).updateSyncTime))}accept(){var n;this.debounceAccept>-1&&clearTimeout(this.debounceAccept),this.debounceAccept=-1;let e=[],t=this.view.state.facet(le),i=this.view.state.field(Me);for(let s=0;s<this.running.length;s++){let r=this.running[s];if(r.done===void 0)continue;if(this.running.splice(s--,1),r.done){let l=Yt(r.updates.length?r.updates[0].startState:this.view.state),a=Math.min(l,r.done.from+(r.active.explicit?0:1)),h=new ar(r.active.source,r.active.explicit,a,r.done,r.done.from,(n=r.done.to)!==null&&n!==void 0?n:l);for(let c of r.updates)h=h.update(c,t);if(h.hasResult()){e.push(h);continue}}let o=i.active.find(l=>l.source==r.active.source);if(o&&o.isPending)if(r.done==null){let l=new ut(r.active.source,0);for(let a of r.updates)l=l.update(a,t);l.isPending||e.push(l)}else this.startQuery(o)}(e.length||i.open&&i.open.disabled)&&this.view.dispatch({effects:Da.of(e)})}},{eventHandlers:{blur(n){let e=this.view.state.field(Me,!1);if(e&&e.tooltip&&this.view.state.facet(le).closeOnBlur){let t=e.open&&nl(this.view,e.open.tooltip);(!t||!t.dom.contains(n.relatedTarget))&&setTimeout(()=>this.view.dispatch({effects:vn.of(null)}),10)}},compositionstart(){this.composing=1},compositionend(){this.composing==3&&setTimeout(()=>this.view.dispatch({effects:lr.of(!1)}),20),this.composing=0}}}),By=typeof navigator=="object"&&/Win/.test(navigator.platform),Ly=Se.highest(O.domEventHandlers({keydown(n,e){let t=e.state.field(Me,!1);if(!t||!t.open||t.open.disabled||t.open.selected<0||!n.key||n.key.length>1||n.ctrlKey&&!(By&&n.altKey)||n.metaKey)return!1;let i=t.open.options[t.open.selected],s=t.active.find(o=>o.source==i.source),r=i.completion.commitCharacters||s.result.commitCharacters;return r&&r.indexOf(n.key)>-1&&Oa(e,i),!1}})),ud=O.baseTheme({".cm-tooltip.cm-tooltip-autocomplete":{"& > ul":{fontFamily:"monospace",whiteSpace:"nowrap",overflow:"hidden auto",maxWidth_fallback:"700px",maxWidth:"min(700px, 95vw)",minWidth:"250px",maxHeight:"10em",height:"100%",listStyle:"none",margin:0,padding:0,"& > li, & > completion-section":{padding:"1px 3px",lineHeight:1.2},"& > li":{overflowX:"hidden",textOverflow:"ellipsis",cursor:"pointer"},"& > completion-section":{display:"list-item",borderBottom:"1px solid silver",paddingLeft:"0.5em",opacity:.7}}},"&light .cm-tooltip-autocomplete ul li[aria-selected]":{background:"#17c",color:"white"},"&light .cm-tooltip-autocomplete-disabled ul li[aria-selected]":{background:"#777"},"&dark .cm-tooltip-autocomplete ul li[aria-selected]":{background:"#347",color:"white"},"&dark .cm-tooltip-autocomplete-disabled ul li[aria-selected]":{background:"#444"},".cm-completionListIncompleteTop:before, .cm-completionListIncompleteBottom:after":{content:'"\xB7\xB7\xB7"',opacity:.5,display:"block",textAlign:"center",cursor:"pointer"},".cm-tooltip.cm-completionInfo":{position:"absolute",padding:"3px 9px",width:"max-content",maxWidth:"400px",boxSizing:"border-box",whiteSpace:"pre-line"},".cm-completionInfo.cm-completionInfo-left":{right:"100%"},".cm-completionInfo.cm-completionInfo-right":{left:"100%"},".cm-completionInfo.cm-completionInfo-left-narrow":{right:"30px"},".cm-completionInfo.cm-completionInfo-right-narrow":{left:"30px"},"&light .cm-snippetField":{backgroundColor:"#00000022"},"&dark .cm-snippetField":{backgroundColor:"#ffffff22"},".cm-snippetFieldPosition":{verticalAlign:"text-top",width:0,height:"1.15em",display:"inline-block",margin:"0 -0.7px -.7em",borderLeft:"1.4px dotted #888"},".cm-completionMatchedText":{textDecoration:"underline"},".cm-completionDetail":{marginLeft:"0.5em",fontStyle:"italic"},".cm-completionIcon":{fontSize:"90%",width:".8em",display:"inline-block",textAlign:"center",paddingRight:".6em",opacity:"0.6",boxSizing:"content-box"},".cm-completionIcon-function, .cm-completionIcon-method":{"&:after":{content:"'\u0192'"}},".cm-completionIcon-class":{"&:after":{content:"'\u25CB'"}},".cm-completionIcon-interface":{"&:after":{content:"'\u25CC'"}},".cm-completionIcon-variable":{"&:after":{content:"'\u{1D465}'"}},".cm-completionIcon-constant":{"&:after":{content:"'\u{1D436}'"}},".cm-completionIcon-type":{"&:after":{content:"'\u{1D461}'"}},".cm-completionIcon-enum":{"&:after":{content:"'\u222A'"}},".cm-completionIcon-property":{"&:after":{content:"'\u25A1'"}},".cm-completionIcon-keyword":{"&:after":{content:"'\u{1F511}\uFE0E'"}},".cm-completionIcon-namespace":{"&:after":{content:"'\u25A2'"}},".cm-completionIcon-text":{"&:after":{content:"'abc'",fontSize:"50%",verticalAlign:"middle"}}}),Sa=class{constructor(e,t,i,s){this.field=e,this.line=t,this.from=i,this.to=s}},Ca=class n{constructor(e,t,i){this.field=e,this.from=t,this.to=i}map(e){let t=e.mapPos(this.from,-1,ie.TrackDel),i=e.mapPos(this.to,1,ie.TrackDel);return t==null||i==null?null:new n(this.field,t,i)}},Aa=class n{constructor(e,t){this.lines=e,this.fieldPositions=t}instantiate(e,t){let i=[],s=[t],r=e.doc.lineAt(t),o=/^\s*/.exec(r.text)[0];for(let a of this.lines){if(i.length){let h=o,c=/^\t*/.exec(a)[0].length;for(let f=0;f<c;f++)h+=e.facet(Ct);s.push(t+h.length-c),a=h+a.slice(c)}i.push(a),t+=a.length+1}let l=this.fieldPositions.map(a=>new Ca(a.field,s[a.line]+a.from,s[a.line]+a.to));return{text:i,ranges:l}}static parse(e){let t=[],i=[],s=[],r;for(let o of e.split(/\r\n?|\n/)){for(;r=/[#$]\{(?:(\d+)(?::([^{}]*))?|((?:\\[{}]|[^{}])*))\}/.exec(o);){let l=r[1]?+r[1]:null,a=r[2]||r[3]||"",h=-1;l===0&&(l=1e9);let c=a.replace(/\\[{}]/g,f=>f[1]);for(let f=0;f<t.length;f++)(l!=null?t[f].seq==l:c&&t[f].name==c)&&(h=f);if(h<0){let f=0;for(;f<t.length&&(l==null||t[f].seq!=null&&t[f].seq<l);)f++;t.splice(f,0,{seq:l,name:c}),h=f;for(let u of s)u.field>=h&&u.field++}for(let f of s)if(f.line==i.length&&f.from>r.index){let u=r[2]?3+(r[1]||"").length:2;f.from-=u,f.to-=u}s.push(new Sa(h,i.length,r.index,r.index+c.length)),o=o.slice(0,r.index)+a+o.slice(r.index+r[0].length)}o=o.replace(/\\([{}])/g,(l,a,h)=>{for(let c of s)c.line==i.length&&c.from>h&&(c.from--,c.to--);return a}),i.push(o)}return new n(i,s)}},Ey=B.widget({widget:new class extends re{toDOM(){let n=document.createElement("span");return n.className="cm-snippetFieldPosition",n}ignoreEvent(){return!1}}}),Ry=B.mark({class:"cm-snippetField"}),Di=class n{constructor(e,t){this.ranges=e,this.active=t,this.deco=B.set(e.map(i=>(i.from==i.to?Ey:Ry).range(i.from,i.to)),!0)}map(e){let t=[];for(let i of this.ranges){let s=i.map(e);if(!s)return null;t.push(s)}return new n(t,this.active)}selectionInsideField(e){return e.ranges.every(t=>this.ranges.some(i=>i.field==this.active&&i.from<=t.from&&i.to>=t.to))}},Cn=L.define({map(n,e){return n&&n.map(e)}}),Py=L.define(),kn=_.define({create(){return null},update(n,e){for(let t of e.effects){if(t.is(Cn))return t.value;if(t.is(Py)&&n)return new Di(n.ranges,t.value)}return n&&e.docChanged&&(n=n.map(e.changes)),n&&e.selection&&!n.selectionInsideField(e.selection)&&(n=null),n},provide:n=>O.decorations.from(n,e=>e?e.deco:B.none)});function La(n,e){return b.create(n.filter(t=>t.field==e).map(t=>b.range(t.from,t.to)))}function dd(n){let e=Aa.parse(n);return(t,i,s,r)=>{let{text:o,ranges:l}=e.instantiate(t.state,s),{main:a}=t.state.selection,h={changes:{from:s,to:r==a.from?a.to:r,insert:N.of(o)},scrollIntoView:!0,annotations:i?[Ma.of(i),ne.userEvent.of("input.complete")]:void 0};if(l.length&&(h.selection=La(l,0)),l.some(c=>c.field>0)){let c=new Di(l,0),f=h.effects=[Cn.of(c)];t.state.field(kn,!1)===void 0&&f.push(L.appendConfig.of([kn,Wy,Vy,ud]))}t.dispatch(t.state.update(h))}}function pd(n){return({state:e,dispatch:t})=>{let i=e.field(kn,!1);if(!i||n<0&&i.active==0)return!1;let s=i.active+n,r=n>0&&!i.ranges.some(o=>o.field==s+n);return t(e.update({selection:La(i.ranges,s),effects:Cn.of(r?null:new Di(i.ranges,s)),scrollIntoView:!0})),!0}}var Iy=({state:n,dispatch:e})=>n.field(kn,!1)?(e(n.update({effects:Cn.of(null)})),!0):!1,Ny=pd(1),Fy=pd(-1);var Hy=[{key:"Tab",run:Ny,shift:Fy},{key:"Escape",run:Iy}],ld=C.define({combine(n){return n.length?n[0]:Hy}}),Wy=Se.highest(wi.compute([ld],n=>n.facet(ld)));var Vy=O.domEventHandlers({mousedown(n,e){let t=e.state.field(kn,!1),i;if(!t||(i=e.posAtCoords({x:n.clientX,y:n.clientY}))==null)return!1;let s=t.ranges.find(r=>r.from<=i&&r.to>=i);return!s||s.field==t.active?!1:(e.dispatch({selection:La(t.ranges,s.field),effects:Cn.of(t.ranges.some(r=>r.field>s.field)?new Di(t.ranges,s.field):null),scrollIntoView:!0}),!0)}});var Sn={brackets:["(","[","{","'",'"'],before:")]}:;>",stringPrefixes:[]},_t=L.define({map(n,e){let t=e.mapPos(n,-1,ie.TrackAfter);return t??void 0}}),Ea=new class extends Ne{};Ea.startSide=1;Ea.endSide=-1;var md=_.define({create(){return H.empty},update(n,e){if(n=n.map(e.changes),e.selection){let t=e.state.doc.lineAt(e.selection.main.head);n=n.update({filter:i=>i>=t.from&&i<=t.to})}for(let t of e.effects)t.is(_t)&&(n=n.update({add:[Ea.range(t.value,t.value+1)]}));return n}});function gd(){return[qy,md]}var ga="()[]{}<>\xAB\xBB\xBB\xAB\uFF3B\uFF3D\uFF5B\uFF5D";function yd(n){for(let e=0;e<ga.length;e+=2)if(ga.charCodeAt(e)==n)return ga.charAt(e+1);return Ii(n<128?n:n+1)}function bd(n,e){return n.languageDataAt("closeBrackets",e)[0]||Sn}var zy=typeof navigator=="object"&&/Android\b/.test(navigator.userAgent),qy=O.inputHandler.of((n,e,t,i)=>{if((zy?n.composing:n.compositionStarted)||n.state.readOnly)return!1;let s=n.state.selection.main;if(i.length>2||i.length==2&&Be(he(i,0))==1||e!=s.from||t!=s.to)return!1;let r=$y(n.state,i);return r?(n.dispatch(r),!0):!1}),Ky=({state:n,dispatch:e})=>{if(n.readOnly)return!1;let i=bd(n,n.selection.main.head).brackets||Sn.brackets,s=null,r=n.changeByRange(o=>{if(o.empty){let l=jy(n.doc,o.head);for(let a of i)if(a==l&&hr(n.doc,o.head)==yd(he(a,0)))return{changes:{from:o.head-a.length,to:o.head+a.length},range:b.cursor(o.head-a.length)}}return{range:s=o}});return s||e(n.update(r,{scrollIntoView:!0,userEvent:"delete.backward"})),!s},xd=[{key:"Backspace",run:Ky}];function $y(n,e){let t=bd(n,n.selection.main.head),i=t.brackets||Sn.brackets;for(let s of i){let r=yd(he(s,0));if(e==s)return r==s?_y(n,s,i.indexOf(s+s+s)>-1,t):Uy(n,s,r,t.before||Sn.before);if(e==r&&wd(n,n.selection.main.from))return Gy(n,s,r)}return null}function wd(n,e){let t=!1;return n.field(md).between(0,n.doc.length,i=>{i==e&&(t=!0)}),t}function hr(n,e){let t=n.sliceString(e,e+2);return t.slice(0,Be(he(t,0)))}function jy(n,e){let t=n.sliceString(e-2,e);return Be(he(t,0))==t.length?t:t.slice(1)}function Uy(n,e,t,i){let s=null,r=n.changeByRange(o=>{if(!o.empty)return{changes:[{insert:e,from:o.from},{insert:t,from:o.to}],effects:_t.of(o.to+e.length),range:b.range(o.anchor+e.length,o.head+e.length)};let l=hr(n.doc,o.head);return!l||/\s/.test(l)||i.indexOf(l)>-1?{changes:{insert:e+t,from:o.head},effects:_t.of(o.head+e.length),range:b.cursor(o.head+e.length)}:{range:s=o}});return s?null:n.update(r,{scrollIntoView:!0,userEvent:"input.type"})}function Gy(n,e,t){let i=null,s=n.changeByRange(r=>r.empty&&hr(n.doc,r.head)==t?{changes:{from:r.head,to:r.head+t.length,insert:t},range:b.cursor(r.head+t.length)}:i={range:r});return i?null:n.update(s,{scrollIntoView:!0,userEvent:"input.type"})}function _y(n,e,t,i){let s=i.stringPrefixes||Sn.stringPrefixes,r=null,o=n.changeByRange(l=>{if(!l.empty)return{changes:[{insert:e,from:l.from},{insert:e,from:l.to}],effects:_t.of(l.to+e.length),range:b.range(l.anchor+e.length,l.head+e.length)};let a=l.head,h=hr(n.doc,a),c;if(h==e){if(ad(n,a))return{changes:{insert:e+e,from:a},effects:_t.of(a+e.length),range:b.cursor(a+e.length)};if(wd(n,a)){let u=t&&n.sliceDoc(a,a+e.length*3)==e+e+e?e+e+e:e;return{changes:{from:a,to:a+u.length,insert:u},range:b.cursor(a+u.length)}}}else{if(t&&n.sliceDoc(a-2*e.length,a)==e+e&&(c=hd(n,a-2*e.length,s))>-1&&ad(n,c))return{changes:{insert:e+e+e+e,from:a},effects:_t.of(a+e.length),range:b.cursor(a+e.length)};if(n.charCategorizer(a)(h)!=$.Word&&hd(n,a,s)>-1&&!Yy(n,a,e,s))return{changes:{insert:e+e,from:a},effects:_t.of(a+e.length),range:b.cursor(a+e.length)}}return{range:r=l}});return r?null:n.update(o,{scrollIntoView:!0,userEvent:"input.type"})}function ad(n,e){let t=oe(n).resolveInner(e+1);return t.parent&&t.from==e}function Yy(n,e,t,i){let s=oe(n).resolveInner(e,-1),r=i.reduce((o,l)=>Math.max(o,l.length),0);for(let o=0;o<5;o++){let l=n.sliceDoc(s.from,Math.min(s.to,s.from+t.length+r)),a=l.indexOf(t);if(!a||a>-1&&i.indexOf(l.slice(0,a))>-1){let c=s.firstChild;for(;c&&c.from==s.from&&c.to-c.from>t.length+a;){if(n.sliceDoc(c.to-t.length,c.to)==t)return!1;c=c.firstChild}return!0}let h=s.to==e&&s.parent;if(!h)break;s=h}return!1}function hd(n,e,t){let i=n.charCategorizer(e);if(i(n.sliceDoc(e-1,e))!=$.Word)return e;for(let s of t){let r=e-s.length;if(n.sliceDoc(r,e)==s&&i(n.sliceDoc(r-1,r))!=$.Word)return r}return-1}function vd(n={}){return[Ly,Me,le.of(n),Oy,Xy,ud]}var Ra=[{key:"Ctrl-Space",run:wn},{mac:"Alt-`",run:wn},{mac:"Alt-i",run:wn},{key:"Escape",run:Ba},{key:"ArrowDown",run:sr(!0)},{key:"ArrowUp",run:sr(!1)},{key:"PageDown",run:sr(!0,"page")},{key:"PageUp",run:sr(!1,"page")},{key:"Enter",run:My}],Xy=Se.highest(wi.computeN([le],n=>n.facet(le).defaultKeymap?[Ra]:[]));var ur=class{constructor(e,t,i){this.from=e,this.to=t,this.diagnostic=i}},Xt=class n{constructor(e,t,i){this.diagnostics=e,this.panel=t,this.selected=i}static init(e,t,i){let s=i.facet(An).markerFilter;s&&(e=s(e,i));let r=e.slice().sort((d,p)=>d.from-p.from||d.to-p.to),o=new pe,l=[],a=0,h=i.doc.iter(),c=0,f=i.doc.length;for(let d=0;;){let p=d==r.length?null:r[d];if(!p&&!l.length)break;let m,g;if(l.length)m=a,g=l.reduce((x,D)=>Math.min(x,D.to),p&&p.from>m?p.from:1e8);else{if(m=p.from,m>f)break;g=p.to,l.push(p),d++}for(;d<r.length;){let x=r[d];if(x.from==m&&(x.to>x.from||x.to==m))l.push(x),d++,g=Math.min(x.to,g);else{g=Math.min(x.from,g);break}}g=Math.min(g,f);let y=!1;if(l.some(x=>x.from==m&&(x.to==g||g==f))&&(y=m==g,!y&&g-m<10)){let x=m-(c+h.value.length);x>0&&(h.next(x),c=m);for(let D=m;;){if(D>=g){y=!0;break}if(!h.lineBreak&&c+h.value.length>D)break;D=c+h.value.length,c+=h.value.length,h.next()}}let v=Ed(l);if(y)o.add(m,m,B.widget({widget:new Pa(v),diagnostics:l.slice()}));else{let x=l.reduce((D,w)=>w.markClass?D+" "+w.markClass:D,"");o.add(m,g,B.mark({class:"cm-lintRange cm-lintRange-"+v+x,diagnostics:l.slice(),inclusiveEnd:l.some(D=>D.to>g)}))}if(a=g,a==f)break;for(let x=0;x<l.length;x++)l[x].to<=a&&l.splice(x--,1)}let u=o.finish();return new n(u,t,Dt(u))}};function Dt(n,e=null,t=0){let i=null;return n.between(t,1e9,(s,r,{spec:o})=>{if(!(e&&o.diagnostics.indexOf(e)<0))if(!i)i=new ur(s,r,e||o.diagnostics[0]);else{if(o.diagnostics.indexOf(i.diagnostic)<0)return!1;i=new ur(i.from,r,i.diagnostic)}}),i}function Sd(n,e){let t=e.pos,i=e.end||t,s=n.state.facet(An).hideOn(n,t,i);if(s!=null)return s;let r=n.startState.doc.lineAt(e.pos);return!!(n.effects.some(o=>o.is(gr))||n.changes.touchesRange(r.from,Math.max(r.to,i)))}function Cd(n,e){return n.field(Te,!1)?e:e.concat(L.appendConfig.of(ob))}function Ad(n,e){return{effects:Cd(n,[gr.of(e)])}}var gr=L.define(),Na=L.define(),Md=L.define(),Te=_.define({create(){return new Xt(B.none,null,null)},update(n,e){if(e.docChanged&&n.diagnostics.size){let t=n.diagnostics.map(e.changes),i=null,s=n.panel;if(n.selected){let r=e.changes.mapPos(n.selected.from,1);i=Dt(t,n.selected.diagnostic,r)||Dt(t,null,r)}!t.size&&s&&e.state.facet(An).autoPanel&&(s=null),n=new Xt(t,s,i)}for(let t of e.effects)if(t.is(gr)){let i=e.state.facet(An).autoPanel?t.value.length?Mn.open:null:n.panel;n=Xt.init(t.value,i,e.state)}else t.is(Na)?n=new Xt(n.diagnostics,t.value?Mn.open:null,n.selected):t.is(Md)&&(n=new Xt(n.diagnostics,n.panel,t.value));return n},provide:n=>[Wt.from(n,e=>e.panel),O.decorations.from(n,e=>e.diagnostics)]});var Jy=B.mark({class:"cm-lintRange cm-lintRange-active"});function Qy(n,e,t){let{diagnostics:i}=n.state.field(Te),s,r=-1,o=-1;i.between(e-(t<0?1:0),e+(t>0?1:0),(a,h,{spec:c})=>{if(e>=a&&e<=h&&(a==h||(e>a||t>0)&&(e<h||t<0)))return s=c.diagnostics,r=a,o=h,!1});let l=n.state.facet(An).tooltipFilter;return s&&l&&(s=l(s,n.state)),s?{pos:r,end:o,above:!0,create(){return{dom:Td(n,s)}}}:null}function Td(n,e){return W("ul",{class:"cm-tooltip-lint"},e.map(t=>Ld(n,t,!1)))}var Fa=n=>{let e=n.state.field(Te,!1);(!e||!e.panel)&&n.dispatch({effects:Cd(n.state,[Na.of(!0)])});let t=vi(n,Mn.open);return t&&t.dom.querySelector(".cm-panel-lint ul").focus(),!0},dr=n=>{let e=n.state.field(Te,!1);return!e||!e.panel?!1:(n.dispatch({effects:Na.of(!1)}),!0)},Ha=n=>{let e=n.state.field(Te,!1);if(!e)return!1;let t=n.state.selection.main,i=Dt(e.diagnostics,null,t.to+1);return!i&&(i=Dt(e.diagnostics,null,0),!i||i.from==t.from&&i.to==t.to)?!1:(n.dispatch({selection:{anchor:i.from,head:i.to},scrollIntoView:!0}),il(n,i.from,1,{tooltip:Va,until:s=>s.docChanged||s.newSelection.main.head<i.from||s.newSelection.main.head>i.to}),!0)},Dd=n=>{var e;let{state:t}=n,i=t.field(Te,!1);if(!i)return!1;let s=t.selection.main,r,o,l,a;if(i.diagnostics.between(0,t.doc.length,(f,u)=>{u<s.to&&(r==null||r<f)&&(r=f,o=u),(l==null||f>l)&&(l=f,a=u)}),l==null||r==null&&l==s.from)return!1;let h=r??l,c=(e=o??a)!==null&&e!==void 0?e:h;return n.dispatch({selection:{anchor:h,head:c},scrollIntoView:!0}),il(n,h,1,{tooltip:Va,until:f=>f.docChanged||f.newSelection.main.head<h||f.newSelection.main.head>c}),!0},Od=[{key:"Mod-Shift-m",run:Fa,preventDefault:!0},{key:"F8",run:Ha}];var An=C.define({combine(n){return{sources:n.map(e=>e.source).filter(e=>e!=null),...me(n.map(e=>e.config),{delay:750,markerFilter:null,tooltipFilter:null,needsRefresh:null,hideOn:()=>null},{delay:Math.max,markerFilter:kd,tooltipFilter:kd,needsRefresh:(e,t)=>e?t?i=>e(i)||t(i):e:t,hideOn:(e,t)=>e?t?(i,s,r)=>e(i,s,r)||t(i,s,r):e:t,autoPanel:(e,t)=>e||t})}}});function kd(n,e){return n?e?(t,i)=>e(n(t,i),i):n:e}function Bd(n){let e=[];if(n)e:for(let{name:t}of n){for(let i=0;i<t.length;i++){let s=t[i];if(/[a-zA-Z]/.test(s)&&!e.some(r=>r.toLowerCase()==s.toLowerCase())){e.push(s);continue e}}e.push("")}return e}function Ld(n,e,t){var i;let s=t?Bd(e.actions):[];return W("li",{class:"cm-diagnostic cm-diagnostic-"+e.severity},W("span",{class:"cm-diagnosticText"},e.renderMessage?e.renderMessage(n):e.message),(i=e.actions)===null||i===void 0?void 0:i.map((r,o)=>{let l=!1,a=d=>{if(d.preventDefault(),l)return;l=!0;let p=Dt(n.state.field(Te).diagnostics,e);p&&r.apply(n,p.from,p.to)},{name:h}=r,c=s[o]?h.indexOf(s[o]):-1,f=c<0?h:[h.slice(0,c),W("u",h.slice(c,c+1)),h.slice(c+1)],u=r.markClass?" "+r.markClass:"";return W("button",{type:"button",class:"cm-diagnosticAction"+u,onclick:a,onmousedown:a,"aria-label":` Action: ${h}${c<0?"":` (access key "${s[o]})"`}.`},f)}),e.source&&W("div",{class:"cm-diagnosticSource"},e.source))}var Pa=class extends re{constructor(e){super(),this.sev=e}eq(e){return e.sev==this.sev}toDOM(){return W("span",{class:"cm-lintPoint cm-lintPoint-"+this.sev})}},pr=class{constructor(e,t){this.diagnostic=t,this.id="item_"+Math.floor(Math.random()*4294967295).toString(16),this.dom=Ld(e,t,!0),this.dom.id=this.id,this.dom.setAttribute("role","option")}},Mn=class n{constructor(e){this.view=e,this.items=[];let t=s=>{if(!(s.ctrlKey||s.altKey||s.metaKey)){if(s.keyCode==27)dr(this.view),this.view.focus();else if(s.keyCode==38||s.keyCode==33)this.moveSelection((this.selectedIndex-1+this.items.length)%this.items.length);else if(s.keyCode==40||s.keyCode==34)this.moveSelection((this.selectedIndex+1)%this.items.length);else if(s.keyCode==36)this.moveSelection(0);else if(s.keyCode==35)this.moveSelection(this.items.length-1);else if(s.keyCode==13)this.view.focus();else if(s.keyCode>=65&&s.keyCode<=90&&this.selectedIndex>=0){let{diagnostic:r}=this.items[this.selectedIndex],o=Bd(r.actions);for(let l=0;l<o.length;l++)if(o[l].toUpperCase().charCodeAt(0)==s.keyCode){let a=Dt(this.view.state.field(Te).diagnostics,r);a&&r.actions[l].apply(e,a.from,a.to)}}else return;s.preventDefault()}},i=s=>{for(let r=0;r<this.items.length;r++)this.items[r].dom.contains(s.target)&&this.moveSelection(r)};this.list=W("ul",{tabIndex:0,role:"listbox","aria-label":this.view.state.phrase("Diagnostics"),onkeydown:t,onclick:i}),this.dom=W("div",{class:"cm-panel-lint"},this.list,W("button",{type:"button",name:"close","aria-label":this.view.state.phrase("close"),onclick:()=>dr(this.view)},"\xD7")),this.update()}get selectedIndex(){let e=this.view.state.field(Te).selected;if(!e)return-1;for(let t=0;t<this.items.length;t++)if(this.items[t].diagnostic==e.diagnostic)return t;return-1}update(){let{diagnostics:e,selected:t}=this.view.state.field(Te),i=0,s=!1,r=null,o=new Set;for(e.between(0,this.view.state.doc.length,(l,a,{spec:h})=>{for(let c of h.diagnostics){if(o.has(c))continue;o.add(c);let f=-1,u;for(let d=i;d<this.items.length;d++)if(this.items[d].diagnostic==c){f=d;break}f<0?(u=new pr(this.view,c),this.items.splice(i,0,u),s=!0):(u=this.items[f],f>i&&(this.items.splice(i,f-i),s=!0)),t&&u.diagnostic==t.diagnostic?u.dom.hasAttribute("aria-selected")||(u.dom.setAttribute("aria-selected","true"),r=u):u.dom.hasAttribute("aria-selected")&&u.dom.removeAttribute("aria-selected"),i++}});i<this.items.length&&!(this.items.length==1&&this.items[0].diagnostic.from<0);)s=!0,this.items.pop();this.items.length==0&&(this.items.push(new pr(this.view,{from:-1,to:-1,severity:"info",message:this.view.state.phrase("No diagnostics")})),s=!0),r?(this.list.setAttribute("aria-activedescendant",r.id),this.view.requestMeasure({key:this,read:()=>({sel:r.dom.getBoundingClientRect(),panel:this.list.getBoundingClientRect()}),write:({sel:l,panel:a})=>{let h=a.height/this.list.offsetHeight;l.top<a.top?this.list.scrollTop-=(a.top-l.top)/h:l.bottom>a.bottom&&(this.list.scrollTop+=(l.bottom-a.bottom)/h)}})):this.selectedIndex<0&&this.list.removeAttribute("aria-activedescendant"),s&&this.sync()}sync(){let e=this.list.firstChild;function t(){let i=e;e=i.nextSibling,i.remove()}for(let i of this.items)if(i.dom.parentNode==this.list){for(;e!=i.dom;)t();e=i.dom.nextSibling}else this.list.insertBefore(i.dom,e);for(;e;)t()}moveSelection(e){if(this.selectedIndex<0)return;let t=this.view.state.field(Te),i=Dt(t.diagnostics,this.items[e].diagnostic);i&&this.view.dispatch({selection:{anchor:i.from,head:i.to},scrollIntoView:!0,effects:Md.of(i)})}static open(e){return new n(e)}};function fr(n,e='viewBox="0 0 40 40"'){return`url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" ${e}>${encodeURIComponent(n)}</svg>')`}function cr(n){return fr(`<path d="m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0" stroke="${n}" fill="none" stroke-width=".7"/>`,'width="6" height="3"')}var Zy=O.baseTheme({".cm-diagnostic":{padding:"3px 6px 3px 8px",marginLeft:"-1px",display:"block",whiteSpace:"pre-wrap"},".cm-diagnostic-error":{borderLeft:"5px solid #d11"},".cm-diagnostic-warning":{borderLeft:"5px solid orange"},".cm-diagnostic-info":{borderLeft:"5px solid #999"},".cm-diagnostic-hint":{borderLeft:"5px solid #66d"},".cm-diagnosticAction":{font:"inherit",border:"none",padding:"2px 4px",backgroundColor:"#444",color:"white",borderRadius:"3px",marginLeft:"8px",cursor:"pointer"},".cm-diagnosticSource":{fontSize:"70%",opacity:.7},".cm-lintRange":{backgroundPosition:"left bottom",backgroundRepeat:"repeat-x",paddingBottom:"0.7px"},".cm-lintRange-error":{backgroundImage:cr("#f11")},".cm-lintRange-warning":{backgroundImage:cr("orange")},".cm-lintRange-info":{backgroundImage:cr("#999")},".cm-lintRange-hint":{backgroundImage:cr("#66d")},".cm-lintRange-active":{backgroundColor:"#ffdd9980"},".cm-tooltip-lint":{padding:0,margin:0},".cm-lintPoint":{position:"relative","&:after":{content:'""',position:"absolute",bottom:0,left:"-2px",borderLeft:"3px solid transparent",borderRight:"3px solid transparent",borderBottom:"4px solid #d11"}},".cm-lintPoint-warning":{"&:after":{borderBottomColor:"orange"}},".cm-lintPoint-info":{"&:after":{borderBottomColor:"#999"}},".cm-lintPoint-hint":{"&:after":{borderBottomColor:"#66d"}},".cm-panel.cm-panel-lint":{position:"relative","& ul":{maxHeight:"100px",overflowY:"auto","& [aria-selected]":{backgroundColor:"#ddd","& u":{textDecoration:"underline"}},"&:focus [aria-selected]":{background_fallback:"#bdf",backgroundColor:"Highlight",color_fallback:"white",color:"HighlightText"},"& u":{textDecoration:"none"},padding:0,margin:0},"& [name=close]":{position:"absolute",top:"0",right:"2px",background:"inherit",border:"none",font:"inherit",padding:0,margin:0}},"&dark .cm-lintRange-active":{backgroundColor:"#86714a80"},"&dark .cm-panel.cm-panel-lint ul":{"& [aria-selected]":{backgroundColor:"#2e343e"}}});function eb(n){return n=="error"?4:n=="warning"?3:n=="info"?2:1}function Ed(n){let e="hint",t=1;for(let i of n){let s=eb(i.severity);s>t&&(t=s,e=i.severity)}return e}var mr=class extends Ae{constructor(e){super(),this.diagnostics=e,this.severity=Ed(e)}toDOM(e){let t=document.createElement("div");t.className="cm-lint-marker cm-lint-marker-"+this.severity;let i=this.diagnostics,s=e.state.facet(yr).tooltipFilter;return s&&(i=s(i,e.state)),i.length&&(t.onmouseover=()=>ib(e,t,i)),t}};function tb(n,e){let t=i=>{let s=e.getBoundingClientRect();if(!(i.clientX>s.left-10&&i.clientX<s.right+10&&i.clientY>s.top-10&&i.clientY<s.bottom+10)){for(let r=i.target;r;r=r.parentNode)if(r.nodeType==1&&r.classList.contains("cm-tooltip-lint"))return;window.removeEventListener("mousemove",t),n.state.field(Rd)&&n.dispatch({effects:Wa.of(null)})}};window.addEventListener("mousemove",t)}function ib(n,e,t){function i(){let o=n.elementAtHeight(e.getBoundingClientRect().top+5-n.documentTop);n.coordsAtPos(o.from)&&n.dispatch({effects:Wa.of({pos:o.from,above:!1,clip:!1,create(){return{dom:Td(n,t),getCoords:()=>e.getBoundingClientRect()}}})}),e.onmouseout=e.onmousemove=null,tb(n,e)}let{hoverTime:s}=n.state.facet(yr),r=setTimeout(i,s);e.onmouseout=()=>{clearTimeout(r),e.onmouseout=e.onmousemove=null},e.onmousemove=()=>{clearTimeout(r),r=setTimeout(i,s)}}function nb(n,e){let t=Object.create(null);for(let s of e){let r=n.lineAt(s.from);(t[r.from]||(t[r.from]=[])).push(s)}let i=[];for(let s in t)i.push(new mr(t[s]).range(+s));return H.of(i,!0)}var sb=vs({class:"cm-gutter-lint",markers:n=>n.state.field(Ia),widgetMarker:(n,e,t)=>{let i=[];return n.state.field(Ia).between(t.from,t.to,(s,r,o)=>{s>t.from&&s<t.to&&i.push(...o.diagnostics)}),i.length?new mr(i):null}}),Ia=_.define({create(){return H.empty},update(n,e){n=n.map(e.changes);let t=e.state.facet(yr).markerFilter;for(let i of e.effects)if(i.is(gr)){let s=i.value;t&&(s=t(s||[],e.state)),n=nb(e.state.doc,s.slice(0))}return n}}),Wa=L.define(),Rd=_.define({create(){return null},update(n,e){return n&&e.docChanged&&(n=Sd(e,n)?null:{...n,pos:e.changes.mapPos(n.pos)}),e.effects.reduce((t,i)=>i.is(Wa)?i.value:t,n)},provide:n=>bt.from(n)}),rb=O.baseTheme({".cm-gutter-lint":{width:"1.4em","& .cm-gutterElement":{padding:".2em"}},".cm-lint-marker":{width:"1em",height:"1em"},".cm-lint-marker-info":{content:fr('<path fill="#aaf" stroke="#77e" stroke-width="6" stroke-linejoin="round" d="M5 5L35 5L35 35L5 35Z"/>')},".cm-lint-marker-warning":{content:fr('<path fill="#fe8" stroke="#fd7" stroke-width="6" stroke-linejoin="round" d="M20 6L37 35L3 35Z"/>')},".cm-lint-marker-error":{content:fr('<circle cx="20" cy="20" r="15" fill="#f87" stroke="#f43" stroke-width="6"/>')}}),Va=ws(Qy,{hideOn:Sd}),ob=[Te,O.decorations.compute([Te],n=>{let{selected:e,panel:t}=n.field(Te);return!e||!t||e.from==e.to?B.none:B.set([Jy.range(e.from,e.to)])}),Va,Zy],yr=C.define({combine(n){return me(n,{hoverTime:300,markerFilter:null,tooltipFilter:null})}});function Pd(n={}){return[yr.of(n),Ia,sb,rb,Rd]}return Vd(lb);})());
return {load};
})();
const cm_glsl_features=(()=>{
// CodeMirror용 GLSL 편집 도우미. cm-editor.js가 확장(extension)으로 붙인다.
//  · 시그니처 도움말: 호출 괄호 안이면 지금 쓰는 인수를 강조해 커서 위에 띄운다(showTooltip).
//  · 숫자 조절: Ctrl+↑/↓(Shift = 10배), 숫자 위에서 Alt+좌우 드래그.
//  · 색 견본: vec3/vec4(0~1 숫자) 앞에 색 견본을 끼워 넣고, 누르면 색상 선택기로 값을 바꾼다(VS Code식 인라인 위젯).
//  · 정의로 이동(F12 · Ctrl+클릭), 이름 바꾸기(F2).
//  · 들여쓰기 안내선, 컴파일 오류 메시지를 줄 끝에 표시(Error Lens).
// 소스 분석은 glsl-language.js가 맡고, 여기서는 화면·키 동작만 다룬다.
  const create = ({CM, language, options = {}, ask, notify = () => {}, onScrub = () => {}}) => {
    const {cleanOf, symbolsOf, KEYWORDS, TYPES, isIdent, escapeRe} = language;
    const docText = state => state.doc.toString();
    const inCode = (src, pos) => cleanOf(src)[pos] === src[pos] || /\s/.test(src[pos] || "");   // 주석·문자열·전처리문 밖
    const wordAround = (src, pos) => {
      let a = pos, b = pos; while(a > 0 && /\w/.test(src[a-1])) a--; while(b < src.length && /\w/.test(src[b])) b++;
      const word = src.slice(a, b); return isIdent(word) ? {word, start:a, end:b} : null;
    };
    // 이름 → {sig, desc}: 내장 함수(레퍼런스) 또는 이 패스의 함수
    const describeFunction = (src, name) => {
      const builtin = options.lookup?.(name); if(builtin) return {sig:builtin.sig, desc:builtin.desc};
      const own = symbolsOf(src).functions.find(entry => entry.name === name);
      return own ? {sig:`${own.ret} ${name}(${own.params})`, desc:`이 패스에 정의된 함수 · ${own.line}번째 줄`} : null;
    };

    // ==== 시그니처 도움말 ====
    // 닫히지 않은 가장 가까운 '(' 앞의 이름 = 인수를 쓰는 중인 함수, 그 사이 깊이 0의 쉼표 수 = 인수 번호
    const callAt = (src, pos) => {
      const clean = cleanOf(src);
      for(let i = pos-1, depth = 0, stop = Math.max(0, pos-800); i >= stop; i--) {
        const c = clean[i]; if(c === ")" || c === "]") depth++;
        else if(c === "(" || c === "[") {
          if(depth) { depth--; continue; } if(c === "[") return null;
          const name = clean.slice(0, i).match(/([A-Za-z_]\w*)\s*$/)?.[1]; if(!name || KEYWORDS.includes(name)) return null;
          let arg = 0; for(let j = i+1, d = 0; j < pos; j++) { const k = clean[j]; if(k === "(" || k === "[") d++; else if(k === ")" || k === "]") d--; else if(k === "," && !d) arg++; }
          return {name, arg, open:i};
        } else if(c === ";" || c === "{" || c === "}") return null;
      }
      return null;
    };
    // 시그니처 문자열에서 name(…)의 매개변수 위치. "[, float bias]" 같은 선택 인수 안의 쉼표는 나누지 않는다.
    const paramsOf = (sig, name) => {
      const at = sig.search(new RegExp(`\\b${escapeRe(name)}\\s*\\(`)); if(at < 0) return null;
      const open = sig.indexOf("(", at), parts = []; let depth = 0, from = open+1, close = sig.length;
      for(let i = open+1; i < sig.length; i++) { const c = sig[i];
        if(c === "(" || c === "[") depth++; else if(c === "]") depth--; else if(c === ")") { if(!depth) { close = i; break; } depth--; }
        else if(c === "," && !depth) { parts.push([from, i]); from = i+1; } }
      if(sig.slice(from, close).trim()) parts.push([from, close]); return {at, open, close, parts};
    };
    const signatureDom = (name, info, arg) => {
      const overloads = info.sig.split(" · ").filter(sig => paramsOf(sig, name)), all = overloads.length ? overloads : [info.sig];
      const sig = all.find(item => (paramsOf(item, name)?.parts.length || 0) > arg) || all[0], shape = paramsOf(sig, name);
      const box = document.createElement("div"), line = document.createElement("div"); box.className = "cm-glsl-signature"; line.className = "cm-glsl-signature-line";
      const text = (a, b) => line.append(document.createTextNode(sig.slice(a, b)));
      if(shape) {
        text(0, shape.at); const b = document.createElement("b"); b.textContent = sig.slice(shape.at, shape.open); line.append(b); text(shape.open, shape.open+1);
        let cursor = shape.open+1;
        shape.parts.forEach(([a, z], i) => { while(a < z && sig[a] === " ") a++; text(cursor, a); const part = document.createElement(i === arg ? "em" : "span"); part.textContent = sig.slice(a, z); line.append(part); cursor = z; });
        text(cursor, sig.length);
      } else text(0, sig.length);
      const desc = document.createElement("small"); desc.textContent = info.desc + (all.length > 1 ? ` · 다른 형태 ${all.length-1}개` : "");
      box.append(line, desc); return box;
    };
    const signatureTooltip = state => {
      const main = state.selection.main; if(!main.empty || state.selection.ranges.length > 1) return null;
      const src = docText(state), call = callAt(src, main.head); if(!call) return null;
      const info = describeFunction(src, call.name); if(!info) return null;
      return {pos:main.head, above:true, strictSide:false, arrow:false, create:() => ({dom:signatureDom(call.name, info, call.arg)})};
    };
    // 편집기에 포커스가 있을 때만 띄운다(다른 곳을 누르면 사라진다).
    const focusChanged = CM.StateEffect.define();
    const signatureField = CM.StateField.define({
      create:() => ({focused:false, tip:null}),
      update(value, tr) {
        let focused = value.focused; for(const effect of tr.effects) if(effect.is(focusChanged)) focused = effect.value;
        if(focused === value.focused && !tr.docChanged && !tr.selection) return value;
        return {focused, tip:focused ? signatureTooltip(tr.state) : null};
      },
      provide:field => CM.showTooltip.from(field, value => value.tip)
    });
    const trackFocus = CM.EditorView.focusChangeEffect.of((state, focusing) => focusChanged.of(focusing));

    // ==== 숫자 조절 ====
    const numberAt = (src, pos) => {
      const from = src.lastIndexOf("\n", pos-1) + 1, stop = src.indexOf("\n", pos), to = stop < 0 ? src.length : stop, row = src.slice(from, to);
      if(/^\s*#/.test(row) || !inCode(src, Math.max(from, pos - 1))) return null;
      for(const match of row.matchAll(/(?:\d+\.\d*|\.\d+|\d+)(?![\w.])/g)) {
        const a = from + match.index, b = a + match[0].length; if(pos < a || pos > b) continue;
        if(/[\w.]/.test(src[a-1] || "")) return null;   // vec3 · iChannel0 · 1e5 같은 이름·지수 표기는 건드리지 않는다
        const before = src.slice(from, a).replace(/\s+$/, ""), unary = before.endsWith("-") && !/[\w)\].]$/.test(before.slice(0,-1).replace(/\s+$/, ""));
        const start = unary ? from + before.length - 1 : a, text = src.slice(start, b);
        if(unary && /\s/.test(text.slice(1, a - start))) return {start:a, end:b, text:match[0]};   // "- 1"은 연산자
        return {start, end:b, text};
      }
      return null;
    };
    const numberFormat = text => { const dot = text.indexOf("."), decimals = dot < 0 ? 0 : text.length - dot - 1; return {decimals, isFloat:dot >= 0, step:10 ** -decimals}; };
    const formatNumber = (value, {decimals, isFloat}) => {
      if(Object.is(Math.round(value * 10 ** decimals), -0) || Math.abs(value) < 10 ** -(decimals+1)) value = 0;
      return decimals > 0 ? value.toFixed(decimals) : isFloat ? `${Math.round(value)}.` : String(Math.round(value));
    };
    const nudge = (direction, multiplier) => view => {
      const main = view.state.selection.main; if(!main.empty) return false;
      const found = numberAt(docText(view.state), main.head); if(!found) return false;
      const format = numberFormat(found.text), next = formatNumber(parseFloat(found.text) + direction * format.step * multiplier, format);
      const caret = Math.min(found.start + next.length, Math.max(found.start, main.head + next.length - found.text.length));
      view.dispatch({changes:{from:found.start, to:found.end, insert:next}, selection:{anchor:caret}, userEvent:"input.adjust"}); return true;
    };
    let scrub = null;
    const scrubMove = event => {
      if(!scrub) return; const {view} = scrub;
      const steps = Math.round((event.clientX - scrub.x) / 4), next = formatNumber(scrub.base + steps * scrub.format.step * (event.shiftKey ? 10 : 1), scrub.format);
      if(next === scrub.text) return;
      view.dispatch({changes:{from:scrub.start, to:scrub.end, insert:next}, selection:{anchor:scrub.start, head:scrub.start + next.length}, userEvent:"input.adjust"});
      scrub.end = scrub.start + next.length; scrub.text = next; onScrub();
    };
    const scrubEnd = () => { if(!scrub) return; scrub.view.dom.classList.remove("is-scrubbing"); scrub = null; window.removeEventListener("pointermove", scrubMove); window.removeEventListener("pointerup", scrubEnd); onScrub(); };

    // ==== 정의로 이동 · 이름 바꾸기 ====
    const definitionOf = (src, name, pos) => {
      const sym = symbolsOf(src), fn = sym.functions.find(f => f.name === name); if(fn) return fn.offset;
      const struct = sym.structs.get(name); if(struct) return struct.offset;
      const define = sym.defines.find(d => d.name === name); if(define) return define.offset;
      const vars = sym.variables.filter(v => v.name === name); if(!vars.length) return -1;
      return (vars.filter(v => v.offset <= pos).pop() || vars[0]).offset;
    };
    const goToDefinition = (view, pos = view.state.selection.main.head) => {
      const src = docText(view.state), found = wordAround(src, pos); if(!found) return false;
      const at = definitionOf(src, found.word, found.start);
      if(at < 0) { notify(options.lookup?.(found.word) ? `${found.word}은(는) 내장 함수입니다 · 마우스를 올리면 설명을 볼 수 있습니다` : `${found.word}의 정의를 이 패스에서 찾지 못했습니다`); return true; }
      view.dispatch({selection:{anchor:at, head:at + found.word.length}, effects:CM.EditorView.scrollIntoView(at, {y:"center"})}); view.focus(); return true;
    };
    const renameSymbol = async view => {
      const src = docText(view.state), found = wordAround(src, view.state.selection.main.head);
      if(!found || KEYWORDS.includes(found.word) || TYPES.includes(found.word) || !inCode(src, found.start)) { notify("이름을 바꿀 변수나 함수 위에 커서를 두세요"); return true; }
      const next = await ask({title:`'${found.word}' 이름 바꾸기`, message:"이 패스 안의 같은 이름을 모두 바꿉니다(주석·문자열과 '.' 뒤의 필드 이름은 제외).", value:found.word, label:"새 이름", ok:"바꾸기"});
      if(next === null || next === undefined || next === found.word) return true;
      if(!isIdent(next) || KEYWORDS.includes(next) || TYPES.includes(next)) { notify(`'${next}'은(는) 쓸 수 없는 이름입니다`); return true; }
      const now = docText(view.state), clean = cleanOf(now), spots = [...clean.matchAll(new RegExp(`\\b${escapeRe(found.word)}\\b`, "g"))].map(m => m.index).filter(at => clean[at-1] !== ".");
      if(!spots.length) return true;
      view.dispatch({changes:spots.map(at => ({from:at, to:at + found.word.length, insert:next})), userEvent:"input.rename"}); view.focus();
      notify(`${found.word} → ${next} · ${spots.length}곳을 바꿨습니다 · Ctrl+Z로 되돌리기`); return true;
    };

    // ==== 색 견본: 인라인 위젯 + 색상 선택기 ====
    const COLOR_RE = /\bvec([34])\s*\(([^()\n]*)\)/g, NUMBER_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
    const findColors = (src, from, to) => {
      const clean = cleanOf(src), found = [];
      for(const m of clean.slice(from, to).matchAll(COLOR_RE)) {
        const size = Number(m[1]), open = from + m.index + m[0].indexOf("(") + 1, args = []; let at = open;
        for(const part of m[2].split(",")) { const lead = part.length - part.trimStart().length, text = part.trim(); args.push({start:at + lead, end:at + lead + text.length, text}); at += part.length + 1; }
        if(args.length !== size || !args.every(arg => NUMBER_RE.test(arg.text))) continue;
        const values = args.map(arg => parseFloat(arg.text)); if(!values.every(v => v >= 0 && v <= 1)) continue;
        found.push({start:from + m.index, end:from + m.index + m[0].length, args, values});
      }
      return found;
    };
    const toHex = values => "#" + values.slice(0, 3).map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    const cssColor = values => `rgb(${values.slice(0, 3).map(v => Math.round(v * 255)).join(" ")}${values.length > 3 ? ` / ${values[3]}` : ""})`;
    const formatChannel = v => { const r = Math.round(v * 1000) / 1000; return Number.isInteger(r) ? r.toFixed(1) : String(r); };
    const picker = document.createElement("input"); picker.type = "color"; picker.className = "cm-glsl-color-input"; picker.tabIndex = -1; picker.setAttribute("aria-hidden", "true");
    let pickTarget = null;   // {view, start}
    picker.addEventListener("input", () => {
      if(!pickTarget) return; const {view, start} = pickTarget, src = docText(view.state), line = view.state.doc.lineAt(start);
      const color = findColors(src, line.from, line.to).find(c => c.start === start); if(!color) return;
      const rgb = [1, 3, 5].map(i => parseInt(picker.value.slice(i, i + 2), 16) / 255);
      view.dispatch({changes:color.args.slice(0, 3).map((arg, i) => ({from:arg.start, to:arg.end, insert:formatChannel(rgb[i])})), userEvent:"input.adjust"});
    });
    const openPicker = (view, start) => {
      const src = docText(view.state), line = view.state.doc.lineAt(start), color = findColors(src, line.from, line.to).find(c => c.start === start); if(!color) return false;
      if(!picker.isConnected) view.dom.append(picker);
      pickTarget = {view, start}; picker.value = toHex(color.values); try { picker.showPicker ? picker.showPicker() : picker.click(); } catch (_) { picker.click(); } return true;
    };
    class ColorSwatch extends CM.WidgetType {
      constructor(values, start) { super(); this.values = values; this.start = start; }
      eq(other) { return other.start === this.start && other.values.join() === this.values.join(); }
      toDOM(view) {
        const swatch = document.createElement("button"); swatch.type = "button"; swatch.className = "cm-glsl-swatch"; swatch.style.setProperty("--swatch", cssColor(this.values));
        swatch.title = "색상 선택기로 바꾸기 · 결과는 0~1 값으로 들어갑니다"; swatch.setAttribute("aria-label", `색 ${toHex(this.values)} · 색상 선택기 열기`);
        swatch.addEventListener("mousedown", event => event.preventDefault());
        swatch.addEventListener("click", () => openPicker(view, this.start)); return swatch;
      }
      ignoreEvent() { return true; }
    }
    const colorDecorations = view => {
      const builder = new CM.RangeSetBuilder(), src = docText(view.state);
      for(const {from, to} of view.visibleRanges) for(const color of findColors(src, from, to)) builder.add(color.start, color.start, CM.Decoration.widget({widget:new ColorSwatch(color.values, color.start), side:-1}));
      return builder.finish();
    };
    const colorPlugin = CM.ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = colorDecorations(view); }
      update(update) { if(update.docChanged || update.viewportChanged) this.decorations = colorDecorations(update.view); }
    }, {decorations:plugin => plugin.decorations});
    const colorAtCursor = view => { const pos = view.state.selection.main.head, line = view.state.doc.lineAt(pos); return findColors(docText(view.state), line.from, line.to).find(c => pos >= c.start && pos <= c.end) || null; };
    const openColorPicker = view => { const color = colorAtCursor(view); if(!color) { notify("커서를 vec3(…)/vec4(…) 색 값 안에 두세요"); return false; } return openPicker(view, color.start); };

    // ==== 들여쓰기 안내선: 줄마다 단계 수를 CSS 변수로 넘기고 배경 무늬로 그린다 ====
    const guideDecorations = view => {
      const state = view.state, unit = state.tabSize, builder = new CM.RangeSetBuilder(), doc = state.doc;
      const indentOf = number => { const text = doc.line(number).text; if(!text.trim()) return -1; let col = 0; for(const ch of text) { if(ch === " ") col++; else if(ch === "\t") col += unit - col % unit; else break; } return col; };
      for(const {from, to} of view.visibleRanges) {
        for(let pos = from; pos <= to;) {
          const line = doc.lineAt(pos); let depth = indentOf(line.number);
          if(depth < 0) { let up = -1, down = -1;
            for(let n = line.number - 1, k = 0; n >= 1 && k < 400 && up < 0; n--, k++) up = indentOf(n);
            for(let n = line.number + 1, k = 0; n <= doc.lines && k < 400 && down < 0; n++, k++) down = indentOf(n);
            depth = Math.max(0, Math.min(up < 0 ? 0 : up, down < 0 ? 0 : down)); }
          const levels = Math.floor(depth / unit);
          if(levels > 0) builder.add(line.from, line.from, CM.Decoration.line({attributes:{class:"cm-indent-guides", style:`--guide-levels:${levels}`}}));
          pos = line.to + 1;
        }
      }
      return builder.finish();
    };
    const guidePlugin = CM.ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = guideDecorations(view); }
      update(update) { if(update.docChanged || update.viewportChanged || update.startState.tabSize !== update.state.tabSize) this.decorations = guideDecorations(update.view); }
    }, {decorations:plugin => plugin.decorations});

    // ==== 줄 끝 오류 메시지(Error Lens) ====
    const setLens = CM.StateEffect.define();
    class LensWidget extends CM.WidgetType {
      constructor(message, severity, count, stale) { super(); Object.assign(this, {message, severity, count, stale}); }
      eq(other) { return other.message === this.message && other.severity === this.severity && other.count === this.count && other.stale === this.stale; }
      toDOM() { const span = document.createElement("span"); span.className = `cm-error-lens is-${this.severity}${this.stale ? " is-stale" : ""}`; span.textContent = this.count > 1 ? `${this.message} (+${this.count - 1})` : this.message; return span; }
      ignoreEvent() { return false; }
    }
    const lensDecorations = (doc, list, stale) => {
      const byLine = new Map();
      for(const item of list) if(item.line >= 1 && item.line <= doc.lines) {
        const entry = byLine.get(item.line) || {severity:"warning", messages:[]}; if(item.severity !== "warning") entry.severity = "error"; entry.messages.push(item.message); byLine.set(item.line, entry);
      }
      const ranges = [...byLine].sort((a, b) => a[0] - b[0]).map(([line, {severity, messages}]) => CM.Decoration.widget({widget:new LensWidget(messages[0], severity, messages.length, stale), side:1}).range(doc.line(line).to));
      return CM.Decoration.set(ranges);
    };
    // 편집하면 줄 위치가 바뀔 수 있으므로 다음 컴파일 전까지 흐리게(stale) 표시한다.
    const lensField = CM.StateField.define({
      create:() => ({list:[], stale:false, deco:CM.Decoration.none}),
      update(value, tr) {
        for(const effect of tr.effects) if(effect.is(setLens)) return {list:effect.value, stale:false, deco:lensDecorations(tr.state.doc, effect.value, false)};
        if(!tr.docChanged) return value;
        const deco = value.stale ? value.deco.map(tr.changes) : lensDecorations(tr.startState.doc, value.list, true).map(tr.changes);
        return {...value, stale:true, deco};
      },
      provide:field => CM.EditorView.decorations.from(field, value => value.deco)
    });

    // ==== 키 · 마우스 ====
    const keys = [
      {key:"Mod-ArrowUp", run:nudge(1, 1)}, {key:"Mod-ArrowDown", run:nudge(-1, 1)}, {key:"Shift-Mod-ArrowUp", run:nudge(1, 10)}, {key:"Shift-Mod-ArrowDown", run:nudge(-1, 10)},
      {key:"F12", run:view => goToDefinition(view)}, {key:"F2", run:view => { renameSymbol(view); return true; }}
    ];
    const mouse = CM.Prec.highest(CM.EditorView.domEventHandlers({
      mousedown(event, view) {
        if(event.button !== 0) return false;
        if((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {   // Ctrl+클릭: 정의로 이동
          const pos = view.posAtCoords({x:event.clientX, y:event.clientY}); if(pos == null) return false;
          event.preventDefault(); view.dispatch({selection:{anchor:pos}}); goToDefinition(view, pos); return true;
        }
        if(event.altKey && !event.ctrlKey && !event.metaKey) {   // 숫자 위 Alt+드래그: 값 조절(숫자가 아니면 사각 선택)
          const pos = view.posAtCoords({x:event.clientX, y:event.clientY}), found = pos == null ? null : numberAt(docText(view.state), pos); if(!found) return false;
          event.preventDefault(); view.focus(); view.dispatch({selection:{anchor:found.start, head:found.end}});
          scrub = {view, x:event.clientX, base:parseFloat(found.text), start:found.start, end:found.end, text:found.text, format:numberFormat(found.text)};
          view.dom.classList.add("is-scrubbing"); window.addEventListener("pointermove", scrubMove); window.addEventListener("pointerup", scrubEnd); return true;
        }
        return false;
      }
    }));
    return {
      extensions:[signatureField, trackFocus, colorPlugin, guidePlugin, lensField, mouse, CM.keymap.of(keys)],
      setDiagnostics:(view, list) => view.dispatch({effects:setLens.of(list)}),
      goToDefinition, renameSymbol, openColorPicker, nudge,
      dispose:() => { scrubEnd(); picker.remove(); }
    };
  }; return {create};
})();
const cm_editor=((CodeMirror, Highlight, Language, Features)=>{
// GLSL 코드 편집기 (CodeMirror 6). studio.js가 mount()로 붙이고 update · goToLine · setDiagnostics 등을 부른다.
// studio.js는 #studioCode textarea를 직접 읽고 쓰므로, 그 textarea를 CodeMirror 문서의 "창구(facade)"로 만든다:
// value·selectionStart/End·setSelectionRange·setRangeText·scrollTop·focus는 CodeMirror 상태를 읽고 쓰며,
// 사용자의 편집·선택·키 입력은 textarea의 input·select·keydown 이벤트로 다시 알린다. 되돌리기는 지금처럼 studio가 맡는다(CodeMirror history 미사용).




  const mount = (textarea, ask, beforeEdit = () => {}, uniformNames = () => [], options = {}) => {
    const CM = CodeMirror.load();   // CodeMirror는 편집기를 처음 붙일 때 초기화한다
    const $ = id => document.getElementById(id), ac = new AbortController(), signal = ac.signal;
    const listen = (target, type, fn, opts = {}) => target?.addEventListener(type, fn, {...opts, signal});
    const highlighter = Highlight.create((options.builtins || []).map(item => item.name));
    let view = null;
    const language = Language.create({options, uniformNames, highlighter, source:() => view ? view.state.doc.toString() : textarea.value});
    const {symbolsOf, describeSymbol, gatherItems, declaringName, KIND_ORDER, KIND_NAME, cleanOf, fuzzy, escapeRe} = language;
    const notify = text => options.notify?.(text);
    // 시그니처 도움말 · 숫자 조절 · 색 견본 · 정의로 이동 · 이름 바꾸기 · 들여쓰기 안내선 · 줄 끝 오류 표시
    const features = Features.create({CM, language, options, ask, notify, onScrub:() => options.onScrub?.()});

    // ---- 표시 설정(글자 크기·줄바꿈·들여쓰기). 예전 편집기와 같은 저장값을 이어서 쓴다 ----
    const STATE_KEY = "webgl.shader-studio.editor.v2"; let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || "{}") || {}; } catch (_) {}
    let fontSize = Number.isInteger(saved.fontSize) ? Math.max(10, Math.min(20, saved.fontSize)) : 12, wrap = !!saved.wrap, tabSize = saved.tabSize === 2 ? 2 : 4;
    const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify({...saved, fontSize, wrap, tabSize})); } catch (_) {} };
    const fontComp = new CM.Compartment(), wrapComp = new CM.Compartment(), tabComp = new CM.Compartment();
    const fontTheme = () => CM.EditorView.theme({"&":{fontSize:`${fontSize}px`}});
    const tabConfig = () => [CM.EditorState.tabSize.of(tabSize), CM.indentUnit.of(" ".repeat(tabSize)), CM.EditorView.editorAttributes.of({style:`--tab-size:${tabSize}`})];

    // ---- GLSL 문법 강조: glsl-highlight.js와 같은 규칙·색(.glsl-* 클래스) ----
    const CLASSES = ["glsl-keyword","glsl-type","glsl-number","glsl-comment","glsl-string","glsl-directive","glsl-builtin","glsl-function"];
    const tokenTable = Object.fromEntries(CLASSES.map(name => [name, CM.Tag.define()]));
    const glsl = CM.StreamLanguage.define({
      name:"glsl",
      startState:() => ({comment:false, depth:0}),
      copyState:state => ({comment:state.comment, depth:state.depth}),
      token(stream, state) {
        const closeComment = () => { if(stream.skipTo("*/")) { stream.pos += 2; state.comment = false; } else stream.skipToEnd(); return "glsl-comment"; };
        if(state.comment) return closeComment();
        if(stream.eatSpace()) return null;
        if(stream.match("//")) { stream.skipToEnd(); return "glsl-comment"; }
        if(stream.match("/*")) { state.comment = true; return closeComment(); }
        if(stream.peek() === "#") { stream.skipToEnd(); return "glsl-directive"; }
        if(stream.match(/^"(?:\\.|[^"\\])*"?/)) return "glsl-string";
        if(stream.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[uU]?/)) return "glsl-number";
        const word = stream.match(/^[A-Za-z_]\w*/);
        if(word) {
          const name = word[0], kind = highlighter.tokenClass(name);
          if(kind === "glsl-keyword" || kind === "glsl-type") return kind;
          if(name.startsWith("gl_")) return "glsl-builtin";
          return /^\s*\(/.test(stream.string.slice(stream.pos)) ? kind : null;   // 호출(이름 + '(')만 함수 색
        }
        const ch = stream.next(); if(ch === "{") state.depth++; else if(ch === "}") state.depth = Math.max(0, state.depth - 1); return null;
      },
      // 들여쓰기: 열린 '{' 수만큼 한 단계씩. 줄이 '}'로 시작하면 한 단계 덜.
      indent:(state, textAfter, cx) => Math.max(0, state.depth - (/^\s*\}/.test(textAfter) ? 1 : 0)) * cx.unit,
      languageData:{commentTokens:{line:"//", block:{open:"/*", close:"*/"}}, closeBrackets:{brackets:["(", "[", "{", '"']}, indentOnInput:/^\s*\}$/},
      tokenTable
    });
    const glslStyle = CM.HighlightStyle.define(CLASSES.map(name => ({tag:tokenTable[name], class:name})));

    // ---- 코드 접기: 줄 끝의 '{'부터 짝 '}'까지 (주석·문자열 안의 괄호는 무시) ----
    let cleanFor = {doc:null, text:""};
    const cleanDoc = state => { if(cleanFor.doc !== state.doc) cleanFor = {doc:state.doc, text:cleanOf(state.doc.toString())}; return cleanFor.text; };
    const braceFold = CM.foldService.of((state, from, to) => {
      const clean = cleanDoc(state), open = clean.slice(from, to).lastIndexOf("{"); if(open < 0) return null;
      for(let i = from + open + 1, depth = 0; i < clean.length; i++) {
        if(clean[i] === "{") depth++;
        else if(clean[i] === "}") { if(depth) { depth--; continue; } return i > to ? {from:from + open + 1, to:i} : null; }
      }
      return null;
    });

    // ---- 자동 완성: glsl-language.js의 후보(이 패스의 이름·Uniform·내장 함수·타입·템플릿·코드 조각)를 CodeMirror 목록으로 ----
    const COMPLETION_TYPE = {variable:"variable", field:"property", function:"function", uniform:"variable", constant:"constant", builtin:"function", "builtin-var":"variable", type:"type", keyword:"keyword", snippet:"text", library:"namespace"};
    const infoNode = item => {
      const box = document.createElement("div"); box.className = "cm-glsl-info";
      const kind = document.createElement("small"); kind.textContent = KIND_NAME[item.kind] || ""; box.append(kind);
      if(item.sig || item.detail) { const code = document.createElement("code"); Highlight.create().paint(code, item.sig || item.detail); box.append(code); }
      if(item.desc) { const p = document.createElement("p"); p.textContent = item.desc; box.append(p); }
      return box;
    };
    const declarationInsertAt = src => { const clean = cleanOf(src), m = /^[\s\S]*?\bprecision\s+\w+\s+float\s*;[^\n]*\n?/.exec(clean) || /^#version[^\n]*\n?/.exec(src); return m ? m[0].length : 0; };
    // 템플릿 본문($1 · ${1:값} · $0)을 CodeMirror snippet 형식으로 바꾼다.
    const toSnippet = body => body.replace(/\$\{(\d+):([^}]*)\}/g, "${$1:$2}").replace(/\$0/g, "${}").replace(/\$(\d+)/g, "${$1}");
    const applyItem = item => (editorView, completion, from, to) => {
      if(item.kind === "snippet") return CM.snippet(toSnippet(item.body))(editorView, completion, from, to);
      editorView.dispatch({changes:{from, to, insert:item.label}, selection:{anchor:from + item.label.length}, userEvent:"input.complete"});
      if(item.kind === "library" && options.library?.insert?.(item.id)) return;
      const src = editorView.state.doc.toString();
      if(item.declare && !new RegExp(`\\buniform\\s+\\w+\\s+${escapeRe(item.label)}\\b`).test(cleanOf(src))) {
        const at = declarationInsertAt(src); editorView.dispatch({changes:{from:at, insert:item.declare + "\n"}, userEvent:"input.complete"});
        options.notify?.(`${item.label} 선언(${item.declare})을 맨 위에 함께 추가했습니다 · Ctrl+Z로 되돌리기`);
      }
    };
    const completionSource = context => {
      const src = context.state.doc.toString(), at = context.pos, clean = cleanOf(src);
      if(at > 0 && clean[at-1] !== src[at-1]) return null;   // 주석·문자열·전처리문 안
      const word = context.matchBefore(/[A-Za-z_]\w*/), start = word ? word.from : at;
      if(/\d/.test(src[start-1] || "")) return null;
      if(src[start-1] === "." && /(?:^|[^\w])\d+$/.test(src.slice(0, start-1))) return null;   // 1.5 같은 숫자
      const {items, member} = gatherItems(src, at, start);
      if(!context.explicit && !member && (!word || declaringName(src, start))) return null;
      return {from:start, validFor:/^\w*$/, options:items.map(item => ({label:item.label, type:COMPLETION_TYPE[item.kind], detail:item.kind === "snippet" ? "템플릿" : item.detail,
        boost:(8 - KIND_ORDER[item.kind]) * 4, info:item.desc || item.sig || item.body ? () => infoNode(item) : undefined, apply:applyItem(item)}))};
    };

    // ---- 마우스 설명: 이름 위에 머물면 내장 함수·변수·Uniform 설명 ----
    const hover = CM.hoverTooltip((editorView, pos) => {
      const word = editorView.state.wordAt(pos); if(!word) return null;
      const src = editorView.state.doc.toString(); if(cleanOf(src)[pos] !== src[pos]) return null;
      const info = describeSymbol(editorView.state.sliceDoc(word.from, word.to), pos); if(!info) return null;
      return {pos:word.from, end:word.to, above:true, create:() => ({dom:infoNode({kind:"", sig:info.sig, desc:info.desc})})};
    });

    // ---- textarea 창구(facade) ----
    const External = CM.Annotation.define();   // studio가 textarea API로 바꾼 것(=다시 input으로 알리지 않는다)
    const clamp = n => Math.max(0, Math.min(view.state.doc.length, Number(n) || 0));
    const setSelection = (a, b, direction = "none", scroll = false) => {
      a = clamp(a); b = clamp(b); if(b < a) a = b;   // textarea 규칙: 끝이 시작보다 앞이면 시작을 끝으로
      view.dispatch({selection:direction === "backward" ? {anchor:b, head:a} : {anchor:a, head:b}, annotations:External.of(true), scrollIntoView:scroll});
    };
    const facade = (name, descriptor) => Object.defineProperty(textarea, name, {configurable:true, ...descriptor});
    const inputTypeOf = tr => tr.isUserEvent("input.type.compose") ? "insertCompositionText" : tr.isUserEvent("input.type") ? "insertText" : tr.isUserEvent("delete") ? "deleteContentBackward"
      : tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop") ? "insertFromPaste" : "insertReplacementText";

    // ---- 화면 만들기 ----
    const frame = textarea.closest(".studio-editor-frame"), pane = textarea.closest(".studio-code-pane");
    frame?.classList.add("is-codemirror");
    const host = document.createElement("div"); host.className = "studio-cm-host"; frame?.append(host);
    const position = $("studioCursor"), symbols = $("studioFunctions");
    const updateStatus = state => {
      const main = state.selection.main, line = state.doc.lineAt(main.head), count = state.selection.ranges.length;
      if(position) position.textContent = `Ln ${line.number}, Col ${main.head - line.from + 1}${count > 1 ? ` · 다중 선택 ${count}개` : main.empty ? "" : ` · ${main.to - main.from}자 선택`}`;
    };
    let functionsFor = null;
    const updateFunctions = () => {
      if(!symbols) return; const src = view.state.doc.toString(); if(src === functionsFor) return; functionsFor = src;
      const clean = cleanOf(src), entries = []; let depth = 0, pos = 0, line = 1;
      for(const m of clean.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*\{/g)) {
        for(; pos < m.index; pos++) { const ch = clean[pos]; if(ch === "{") depth++; else if(ch === "}") depth = Math.max(0, depth-1); else if(ch === "\n") line++; }
        if(!depth) entries.push({name:m[2], params:m[3].trim().replace(/\s+/g, " "), line});
      }
      symbols.replaceChildren(new Option(`ƒ 함수 (${entries.length})`, ""), ...entries.map(({name, params, line}) => new Option(`${name}(${params.slice(0,38)}${params.length > 38 ? "…" : ""}) · Ln ${line}`, String(line))));
      symbols.value = ""; symbols.disabled = !entries.length;
    };
    const editorTheme = CM.EditorView.theme({
      "&":{height:"100%", backgroundColor:"var(--sunken)", color:"#d6dbe8"},
      ".cm-scroller":{fontFamily:"var(--mono)", lineHeight:"1.65"},
      ".cm-content":{padding:"12px 0", caretColor:"var(--text)"},
      ".cm-gutters":{backgroundColor:"var(--sunken)", color:"var(--faint)", border:"none", borderRight:"1px solid var(--line)"},
      ".cm-activeLine":{backgroundColor:"#ffffff07"}, ".cm-activeLineGutter":{backgroundColor:"#ffffff07", color:"var(--text-soft)"},
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":{backgroundColor:"color-mix(in srgb, var(--accent) 34%, transparent) !important"},
      ".cm-cursor, .cm-dropCursor":{borderLeftColor:"var(--text)"},
      "&.cm-focused .cm-matchingBracket":{backgroundColor:"color-mix(in srgb, var(--accent) 22%, transparent)", outline:"1px solid color-mix(in srgb, var(--accent) 70%, transparent)"},
      ".cm-selectionMatch":{backgroundColor:"#6fe0e620"},
      ".cm-searchMatch":{backgroundColor:"#f3c46e2e", outline:"1px solid #f3c46e55"}, ".cm-searchMatch.cm-searchMatch-selected":{backgroundColor:"#f3c46e66"},
      ".cm-panels":{backgroundColor:"var(--elevated)", color:"var(--text-soft)"}, ".cm-panels.cm-panels-top":{borderBottom:"1px solid var(--line)"},
      ".cm-tooltip":{backgroundColor:"var(--elevated)", border:"1px solid var(--line-strong)", borderRadius:"8px", color:"var(--text-soft)"},
      ".cm-tooltip-autocomplete > ul > li[aria-selected]":{backgroundColor:"var(--accent-soft)", color:"var(--text)"},
      ".cm-foldPlaceholder":{backgroundColor:"var(--surface)", border:"1px solid var(--line-strong)", color:"var(--muted)"}
    }, {dark:true});

    const notifyTextarea = update => {
      if(update.docChanged && !update.transactions.some(tr => tr.annotation(External))) {
        const tr = update.transactions.find(t => t.docChanged), type = inputTypeOf(tr); let data = null;
        tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => { if(data === null && type === "insertText") data = inserted.toString(); });
        if(type === "insertText" && (data?.length !== 1 || update.state.selection.ranges.length > 1)) data = null;
        textarea.dispatchEvent(typeof InputEvent === "function" ? new InputEvent("input", {bubbles:true, inputType:data === null && type === "insertText" ? "insertReplacementText" : type, data}) : new Event("input", {bubbles:true}));
      }
      if(update.selectionSet && !update.transactions.some(tr => tr.annotation(External))) textarea.dispatchEvent(new Event("select"));
      if(update.docChanged || update.selectionSet) updateStatus(update.state);
      if(update.docChanged) updateFunctions();
    };
    // 키 입력은 먼저 textarea로 알린다(studio의 Ctrl+Z/Y·Alt+PageUp 등). studio가 처리하면 CodeMirror는 건너뛴다.
    const forwardKeys = CM.Prec.highest(CM.EditorView.domEventHandlers({
      keydown(event) {
        const clone = new KeyboardEvent("keydown", {key:event.key, code:event.code, ctrlKey:event.ctrlKey, metaKey:event.metaKey, shiftKey:event.shiftKey, altKey:event.altKey,
          repeat:event.repeat, isComposing:event.isComposing, bubbles:false, cancelable:true});
        textarea.dispatchEvent(clone); if(clone.defaultPrevented) { event.preventDefault(); return true; } return false;
      }
    }));
    // studio의 되돌리기 기록용: 사용자 편집 직전 커서를 알려 준다.
    // 글자 입력(input.type)은 제외한다: 브라우저가 이미 커서 쪽으로 스크롤한 뒤라, 직전에 받은 beforeinput·select 시점의 위치가 맞다.
    const beforeUserEdit = CM.EditorState.transactionFilter.of(tr => { if(tr.docChanged && !tr.annotation(External) && !tr.isUserEvent("input.type")) beforeEdit(); return tr; });
    let commands = [];
    const editorKeys = [
      {key:"Mod-Space", run:CM.startCompletion},
      {key:"Mod-g", run:() => { openPalette(":"); return true; }},
      {key:"Mod-Shift-o", run:() => { openPalette("@"); return true; }},
      {key:"Mod-Shift-\\", run:CM.cursorMatchingBracket},
      {key:"Alt-z", run:() => { wrap = !wrap; applyPresentation(); return true; }},
      {key:"Mod-Alt-ArrowUp", run:CM.addCursorAbove}, {key:"Mod-Alt-ArrowDown", run:CM.addCursorBelow},
      // 예전 편집기와 같은 키: 줄 선택 · 줄 복제 · 찾아 바꾸기
      {key:"Mod-l", run:CM.selectLine}, {key:"Mod-Shift-d", run:CM.copyLineDown}, {key:"Mod-h", run:() => { showFind(true); return true; }},
      // keyCode가 없는 키 이벤트(합성 이벤트·일부 키보드 배열)는 Shift+글자를 대문자 이름으로만 보낸다. 같은 동작을 대문자 이름에도 묶는다.
      {key:"Mod-Shift-D", run:CM.copyLineDown}, {key:"Mod-Shift-O", run:() => { openPalette("@"); return true; }}, {key:"Mod-Shift-P", run:() => { openPalette(); return true; }},
      {key:"F1", run:() => { openPalette(); return true; }}, {key:"Mod-Shift-p", run:() => { openPalette(); return true; }}
    ];
    // CodeMirror 내장 UI(검색 창·접기·오류 목록·자동 완성) 문구를 한국어로 (EditorState.phrases)
    const PHRASES = {"Find":"찾기", "Replace":"바꿀 내용", "next":"다음", "previous":"이전", "all":"모두 선택", "match case":"대소문자", "by word":"단어 단위", "regexp":"정규식",
      "replace":"바꾸기", "replace all":"모두 바꾸기", "close":"닫기", "current match":"현재 일치", "on line":"줄", "replaced match on line $":"$번째 줄에서 바꿈", "replaced $ matches":"$곳을 바꿈",
      "Go to line":"줄 이동", "go":"이동", "to":"→", "Folded lines":"접은 줄", "Unfolded lines":"편 줄", "Fold line":"접기", "Unfold line":"펴기", "folded code":"접힌 코드", "unfold":"펴기",
      "Diagnostics":"오류 목록", "No diagnostics":"오류 없음", "Completions":"자동 완성 후보", "Control character":"제어 문자"};
    view = new CM.EditorView({
      parent:host,
      state:CM.EditorState.create({doc:textarea.value, extensions:[
        CM.lineNumbers(), CM.highlightActiveLineGutter(), CM.foldGutter(), CM.codeFolding(), braceFold,
        CM.highlightSpecialChars(), CM.drawSelection(), CM.dropCursor(), CM.EditorState.allowMultipleSelections.of(true),
        CM.rectangularSelection(), CM.crosshairCursor(), CM.highlightActiveLine(), CM.highlightSelectionMatches(),
        CM.indentOnInput(), CM.bracketMatching(), CM.closeBrackets(), glsl, CM.syntaxHighlighting(glslStyle),
        CM.autocompletion({override:[completionSource], icons:true, activateOnTyping:true}), hover, CM.lintGutter(),
        CM.search({top:true}), forwardKeys, beforeUserEdit, ...features.extensions, CM.scrollPastEnd(),
        CM.EditorView.clickAddsSelectionRange.of(event => event.altKey && !event.ctrlKey && !event.metaKey),   // Alt+클릭: 커서 추가 (Ctrl+클릭은 정의로 이동)
        CM.keymap.of([...editorKeys, ...CM.closeBracketsKeymap, ...CM.completionKeymap, ...CM.searchKeymap, ...CM.foldKeymap, ...CM.lintKeymap, ...CM.defaultKeymap, CM.indentWithTab]),
        fontComp.of(fontTheme()), wrapComp.of(wrap ? CM.EditorView.lineWrapping : []), tabComp.of(tabConfig()), editorTheme,
        CM.EditorView.contentAttributes.of({"aria-label":"GLSL 코드 편집기", spellcheck:"false", autocorrect:"off", autocapitalize:"off"}),
        CM.EditorState.phrases.of(PHRASES), CM.placeholder("// GLSL 코드를 입력하세요 · Ctrl+Space 자동 완성 · Ctrl+Shift+P 명령 팔레트"),
        CM.EditorView.updateListener.of(notifyTextarea)
      ]})
    });
    facade("value", {get:() => view.state.doc.toString(), set:value => { value = String(value ?? ""); view.dispatch({changes:{from:0, to:view.state.doc.length, insert:value}, selection:{anchor:value.length}, annotations:External.of(true)}); }});
    facade("selectionStart", {get:() => view.state.selection.main.from, set:value => setSelection(value, Math.max(Number(value) || 0, view.state.selection.main.to))});
    facade("selectionEnd", {get:() => view.state.selection.main.to, set:value => setSelection(Math.min(view.state.selection.main.from, Number(value) || 0), value)});
    facade("selectionDirection", {get:() => { const m = view.state.selection.main; return m.empty ? "none" : m.head < m.anchor ? "backward" : "forward"; }, set:() => {}});
    // 스크롤 위치: CodeMirror는 문서가 바뀐 뒤 다음 측정 단계에서 스크롤을 자체 기준으로 다시 맞추므로, 그 단계에서도 한 번 더 적용한다(되돌리기 후 스크롤 복원).
    const setScroll = (axis, value) => { view.scrollDOM[axis] = value; view.requestMeasure({key:`facade-${axis}`, read:() => null, write:() => { view.scrollDOM[axis] = value; }}); };
    facade("scrollTop", {get:() => view.scrollDOM.scrollTop, set:value => setScroll("scrollTop", value)});
    facade("scrollLeft", {get:() => view.scrollDOM.scrollLeft, set:value => setScroll("scrollLeft", value)});
    facade("setSelectionRange", {value:(a, b, direction = "none") => setSelection(a, b, direction)});
    facade("select", {value:() => setSelection(0, view.state.doc.length)});
    // textarea의 focus()처럼 내용 스크롤 위치는 그대로 둔다(CodeMirror의 focus는 화면 밖 커서 쪽으로 스크롤할 수 있다).
    facade("focus", {value:() => { const top = view.scrollDOM.scrollTop, left = view.scrollDOM.scrollLeft; view.focus(); if(view.scrollDOM.scrollTop !== top) setScroll("scrollTop", top); if(view.scrollDOM.scrollLeft !== left) setScroll("scrollLeft", left); }});
    facade("blur", {value:() => view.contentDOM.blur()});
    // HTMLTextAreaElement.setRangeText와 같은 규칙(select · start · end · preserve)으로 선택을 옮긴다.
    facade("setRangeText", {value:(text, start, end, mode = "preserve") => {
      const main = view.state.selection.main; text = String(text);
      if(start === undefined) { start = main.from; end = main.to; } start = clamp(start); end = Math.max(start, clamp(end));
      const delta = text.length - (end - start), moved = p => p > end ? p + delta : p > start ? start : p, movedEnd = p => p > end ? p + delta : p > start ? start + text.length : p;
      const sel = mode === "select" ? [start, start + text.length] : mode === "start" ? [start, start] : mode === "end" ? [start + text.length, start + text.length] : [moved(main.from), movedEnd(main.to)];
      view.dispatch({changes:{from:start, to:end, insert:text}, selection:{anchor:sel[0], head:sel[1]}, annotations:External.of(true)});
    }});
    // studio가 기다리는 나머지 사용자 이벤트(클릭·키 놓기·스크롤·포인터)도 textarea로 알린다.
    for(const type of ["click", "keyup", "pointerdown", "beforeinput"]) listen(view.contentDOM, type, () => textarea.dispatchEvent(new Event(type)));
    listen(view.scrollDOM, "scroll", () => textarea.dispatchEvent(new Event("scroll")));

    const applyPresentation = () => {
      view.dispatch({effects:[fontComp.reconfigure(fontTheme()), wrapComp.reconfigure(wrap ? CM.EditorView.lineWrapping : []), tabComp.reconfigure(tabConfig())]});
      $("studioFontSize") && ($("studioFontSize").textContent = `${fontSize}px`); $("studioIndent") && ($("studioIndent").value = String(tabSize));
      $("studioLineWrap")?.setAttribute("aria-pressed", String(wrap)); save();
    };
    const goToLine = (line, column = 1) => {
      const doc = view.state.doc; line = Math.min(doc.lines, Math.max(1, Number(line) || 1));
      const row = doc.line(line), at = row.from + Math.min(row.length, Math.max(0, column - 1));
      view.focus(); view.dispatch({selection:{anchor:at}, effects:CM.EditorView.scrollIntoView(at, {y:"center"}), annotations:External.of(true)}); return line;
    };
    const showFind = (replace = false) => {
      CM.openSearchPanel(view);
      if(replace) setTimeout(() => view.dom.querySelector(".cm-search input[name=replace]")?.focus(), 0);
    };
    const setDiagnostics = list => {
      const doc = view.state.doc, items = (Array.isArray(list) ? list : []).filter(item => Number.isInteger(item?.line) && item.line >= 1 && item.line <= doc.lines && typeof item.message === "string");
      view.dispatch(CM.setDiagnostics(view.state, items.map(item => { const row = doc.line(item.line); return {from:row.from, to:row.to, severity:item.severity === "warning" ? "warning" : "error", message:item.message}; })));
      features.setDiagnostics(view, items);
    };

    // ---- 명령 팔레트: 기본 편집기와 같은 모양(.studio-palette) · @ 함수·변수로 이동 · : 줄 번호 ----
    const palette = document.createElement("div"), paletteInput = document.createElement("input"), paletteList = document.createElement("div");
    palette.className = "studio-palette"; palette.hidden = true; palette.setAttribute("role", "dialog"); palette.setAttribute("aria-label", "명령 팔레트");
    paletteInput.className = "studio-palette-input"; paletteInput.placeholder = "명령 검색 · @ 함수·변수로 이동 · : 줄 번호"; paletteInput.setAttribute("aria-label", "명령 검색");
    paletteList.className = "studio-palette-list"; paletteList.setAttribute("role", "listbox"); palette.append(paletteInput, paletteList); pane?.append(palette);
    let paletteItems = [], paletteChoice = 0;
    const builtInCommands = () => [
      {label:"찾기", key:"Ctrl+F", run:() => showFind()}, {label:"찾아 바꾸기", key:"Ctrl+H", run:() => showFind(true)},
      {label:"줄 번호로 이동", key:"Ctrl+G", run:() => openPalette(":")}, {label:"함수·변수로 이동", key:"Ctrl+Shift+O", run:() => openPalette("@")},
      {label:"자동 완성 열기", key:"Ctrl+Space", run:() => CM.startCompletion(view)},
      {label:"줄 주석 전환", key:"Ctrl+/", run:() => CM.toggleComment(view)}, {label:"블록 주석 전환 (/* */)", key:"Shift+Alt+A", run:() => CM.toggleBlockComment(view)},
      {label:"다음 일치 항목 선택 추가", key:"Ctrl+D", run:() => CM.selectNextOccurrence(view)}, {label:"모든 일치 항목 선택", key:"Ctrl+Shift+L", run:() => CM.selectSelectionMatches(view)},
      {label:"줄 삭제", key:"Ctrl+Shift+K", run:() => CM.deleteLine(view)}, {label:"짝 괄호로 이동", key:"Ctrl+Shift+\\", run:() => CM.cursorMatchingBracket(view)},
      {label:"들여쓰기", key:"Ctrl+]", run:() => CM.indentMore(view)}, {label:"내어쓰기", key:"Ctrl+[", run:() => CM.indentLess(view)},
      {label:"정의로 이동", key:"F12 · Ctrl+클릭", run:() => features.goToDefinition(view)}, {label:"이름 바꾸기 (같은 이름 모두)", key:"F2", run:() => features.renameSymbol(view)},
      {label:"색상 선택기 열기 (커서 위치의 vec3/vec4)", run:() => features.openColorPicker(view)},
      {label:"커서 위 숫자 올리기 / 내리기", key:"Ctrl+↑ / Ctrl+↓", run:() => features.nudge(1, 1)(view) || notify("커서를 숫자 위에 두세요")},
      {label:"커서를 위에 추가", key:"Ctrl+Alt+↑", run:() => CM.addCursorAbove(view)}, {label:"커서를 아래에 추가", key:"Ctrl+Alt+↓", run:() => CM.addCursorBelow(view)},
      {label:"줄을 위로 이동", key:"Alt+↑", run:() => CM.moveLineUp(view)}, {label:"줄을 아래로 이동", key:"Alt+↓", run:() => CM.moveLineDown(view)},
      {label:"줄을 위로 복사", key:"Shift+Alt+↑", run:() => CM.copyLineUp(view)}, {label:"줄을 아래로 복사", key:"Shift+Alt+↓", run:() => CM.copyLineDown(view)},
      {label:"현재 블록 접기", key:"Ctrl+Shift+[", run:() => CM.foldCode(view)}, {label:"현재 블록 펴기", key:"Ctrl+Shift+]", run:() => CM.unfoldCode(view)},
      {label:"모두 접기", key:"Ctrl+Alt+[", run:() => CM.foldAll(view)}, {label:"모두 펴기", key:"Ctrl+Alt+]", run:() => CM.unfoldAll(view)},
      {label:"오류 목록 열기", key:"Ctrl+Shift+M", run:() => CM.openLintPanel(view)}, {label:"다음 오류로", key:"F8", run:() => CM.nextDiagnostic(view)}, {label:"이전 오류로", key:"Shift+F8", run:() => CM.previousDiagnostic(view)},
      {label:"Tab 키로 포커스 이동 켜기/끄기 (접근성)", key:"Ctrl+M", run:() => CM.toggleTabFocusMode(view)},
      {label:"긴 줄 자동 줄바꿈 켜기/끄기", key:"Alt+Z", run:() => { wrap = !wrap; applyPresentation(); }},
      {label:"글자 크게", run:() => { fontSize = Math.min(20, fontSize + 1); applyPresentation(); }}, {label:"글자 작게", run:() => { fontSize = Math.max(10, fontSize - 1); applyPresentation(); }},
      {label:"들여쓰기 크기 2 ↔ 4 바꾸기", run:() => { tabSize = tabSize === 4 ? 2 : 4; applyPresentation(); }}];
    const paletteEntries = () => {
      const value = paletteInput.value;
      if(value.startsWith(":")) { const line = Number(value.slice(1)); return [{label:line ? `${line}번째 줄로 이동` : `줄 번호 입력 (1–${view.state.doc.lines})`, run:() => line && goToLine(line)}]; }
      if(value.startsWith("@")) {
        const sym = symbolsOf(view.state.doc.toString()), query = value.slice(1).trim();
        const items = [...sym.functions.map(f => ({label:f.name, hint:`ƒ ${f.ret} (${f.params}) · Ln ${f.line}`, run:() => goToLine(f.line)})),
          ...sym.variables.filter(v => v.uniform || v.output).map(v => ({label:v.name, hint:`${v.uniform ? "uniform" : "out"} ${v.type} · Ln ${v.line}`, run:() => goToLine(v.line)})),
          ...sym.defines.map(d => ({label:d.name, hint:`#define · Ln ${d.line}`, run:() => goToLine(d.line)}))];
        return {items, query};
      }
      return {items:[...commands, ...builtInCommands()].map(c => ({label:c.label, hint:c.key || "", run:c.run})), query:value.trim()};
    };
    const renderPalette = () => {
      const entries = paletteEntries(), items = Array.isArray(entries) ? entries : entries.items, query = Array.isArray(entries) ? "" : entries.query;
      paletteItems = query ? items.map(item => ({item, m:fuzzy(item.label, query)})).filter(x => x.m).sort((a, b) => b.m.score - a.m.score).map(x => x.item) : items;
      paletteChoice = Math.min(paletteChoice, Math.max(0, paletteItems.length - 1));
      paletteList.replaceChildren(...paletteItems.map((item, i) => {
        const button = document.createElement("button"); button.type = "button"; button.dataset.index = i; button.className = i === paletteChoice ? "is-selected" : ""; button.setAttribute("role", "option");
        const label = document.createElement("span"); label.textContent = item.label; const hint = document.createElement("span"); hint.className = "palette-hint"; hint.textContent = item.hint || "";
        button.append(label, hint); return button;
      }));
      if(!paletteItems.length) { const empty = document.createElement("p"); empty.className = "palette-empty"; empty.textContent = "일치하는 항목이 없습니다"; paletteList.append(empty); }
    };
    const openPalette = (prefix = "") => { palette.hidden = false; paletteInput.value = prefix; paletteChoice = 0; renderPalette(); paletteInput.focus(); };
    const closePalette = (refocus = true) => { if(palette.hidden) return; palette.hidden = true; if(refocus) view.focus(); };
    const runPaletteItem = index => { const item = paletteItems[index]; if(!item) return; closePalette(); item.run?.(); };
    listen(paletteInput, "input", () => { paletteChoice = 0; renderPalette(); });
    listen(paletteInput, "keydown", event => {
      if(event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if(paletteItems.length) { paletteChoice = (paletteChoice + (event.key === "ArrowDown" ? 1 : -1) + paletteItems.length) % paletteItems.length; renderPalette(); } }
      else if(event.key === "Enter") { event.preventDefault(); runPaletteItem(paletteChoice); }
      else if(event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePalette(); }
    });
    listen(paletteInput, "blur", () => setTimeout(() => { if(!palette.contains(document.activeElement)) closePalette(false); }, 0));
    listen(paletteList, "pointerdown", event => event.preventDefault());
    listen(paletteList, "click", event => { const item = event.target.closest("button[data-index]"); if(item) runPaletteItem(Number(item.dataset.index)); });
    const registerCommands = list => { commands = [...commands, ...list.filter(c => c && typeof c.run === "function" && c.label)]; };

    // ---- 편집기 도구 버튼 ----
    listen($("studioFind"), "click", () => showFind()); listen($("studioReplace"), "click", () => showFind(true));
    listen($("studioGoto"), "click", () => openPalette(":")); listen($("studioComplete"), "click", () => { view.focus(); CM.startCompletion(view); });
    listen($("studioPaletteOpen"), "click", () => openPalette());
    listen($("studioFoldAll"), "click", () => { CM.foldAll(view); view.focus(); }); listen($("studioUnfoldAll"), "click", () => { CM.unfoldAll(view); view.focus(); });
    listen($("studioLintPanel"), "click", () => CM.openLintPanel(view)); listen($("studioRename"), "click", () => features.renameSymbol(view));
    listen($("studioDefinition"), "click", () => features.goToDefinition(view));
    listen(symbols, "change", () => { if(symbols.value) goToLine(Number(symbols.value)); symbols.value = ""; });
    listen($("studioZoomIn"), "click", () => { fontSize = Math.min(20, fontSize + 1); applyPresentation(); });
    listen($("studioZoomOut"), "click", () => { fontSize = Math.max(10, fontSize - 1); applyPresentation(); });
    listen($("studioLineWrap"), "click", () => { wrap = !wrap; applyPresentation(); });
    listen($("studioIndent"), "change", event => { tabSize = event.target.value === "2" ? 2 : 4; applyPresentation(); });
    listen(document, "keydown", event => {
      const open = (event.key === "F1" || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyP")) && host.offsetParent && !view.hasFocus;
      if(open) { event.preventDefault(); event.stopPropagation(); openPalette(); }
    });
    applyPresentation(); updateStatus(view.state); updateFunctions();

    return {
      update:() => { CM.closeCompletion(view); updateStatus(view.state); updateFunctions(); },
      goToLine, showFind, setDiagnostics, registerCommands, openPalette, view:() => view,
      dispose:() => {
        ac.abort(); features.dispose(); view.destroy(); host.remove(); palette.remove(); frame?.classList.remove("is-codemirror");
        for(const name of ["value","selectionStart","selectionEnd","selectionDirection","scrollTop","scrollLeft","setSelectionRange","select","focus","blur","setRangeText"]) delete textarea[name];
      }
    };
  }; return {mount};
})(codemirror, glsl_highlight, glsl_language, cm_glsl_features);
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
  return {collect,clampValue,sameOptions};
})();
const studio=((Editor, Annotations)=>{
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
    // 편집기: CodeMirror 6 (js/cm-editor.js). #studioCode textarea는 소스를 읽고 쓰는 창구다.
    const editor = Editor.mount($("studioCode"),ask,captureCursor,()=>renderer.getUserUniforms().map(item=>item.name),{lookup:options.lookup,builtins:options.builtins,library,
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
})(cm_editor, annotations);
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
        "**화면 표시** — 현재 줄, 커서 옆 괄호의 짝, 선택한 이름과 같은 다른 위치가 은은하게 강조됩니다. 들여쓰기는 세로 **안내선**으로 보입니다.",
        "**색 견본** — `vec3(1.0, 0.5, 0.0)`·`vec4(…)`처럼 0~1 숫자로만 된 색 앞에 작은 색 견본이 붙습니다. 누르면 **색상 선택기**로 값을 바꿉니다(`Ctrl+Z`로 되돌리기). 값은 변환 없이 0~1로 들어갑니다.",
        "**여러 커서** — `Ctrl+D`는 커서 아래 단어를 고르고 다시 누를 때마다 다음 같은 이름을 더합니다(`Ctrl+Shift+L`은 모두). `Alt+클릭`으로 커서를 추가하고, `Ctrl+Alt+↑/↓`로 위·아래 줄에 커서를 놓고, `Alt+드래그`로 사각형 영역을 고릅니다. 화살표·입력이 모든 커서에 함께 적용되고 `Esc`로 하나로 돌아갑니다.",
        "**코드 접기** — 줄 번호 옆 화살표나 `Ctrl+Shift+[` / `Ctrl+Shift+]`로 `{ }` 블록을 접고 폅니다. `Ctrl+Alt+[` / `Ctrl+Alt+]`는 모두 접기·펴기.",
        "**찾기 · 바꾸기** — `Ctrl+F`(바꾸기 `Ctrl+H`). 검색 창에서 대소문자·정규식·단어 단위를 고를 수 있고, 정규식으로 바꿀 때 `$1`·`$&`를 씁니다.",
        "**오류** — 컴파일 오류가 난 줄에 표시가 붙고 줄 끝에 이유가 나옵니다. `F8`·`Shift+F8`로 오류 사이를 오가고, `Ctrl+Shift+M`으로 목록을 엽니다.",
        "**주석** — `Ctrl+/` 줄 주석, `Shift+Alt+A` 블록 주석(`/* */`).",
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
        ["주석 전환 / 블록 주석","Ctrl+/ / Shift+Alt+A"],["다음 일치 항목 선택 추가 / 모든 일치 선택","Ctrl+D / Ctrl+Shift+L"],["커서 추가 (클릭 · 위아래 줄) / 사각 선택","Alt+클릭 · Ctrl+Alt+↑↓ / Alt+드래그"],
        ["블록 접기 / 펴기 · 모두","Ctrl+Shift+[ / ] · Ctrl+Alt+[ / ]"],["다음 · 이전 오류 / 오류 목록","F8 · Shift+F8 / Ctrl+Shift+M"],["줄 복제","Ctrl+Shift+D"],["줄 위/아래 이동","Alt+↑ / Alt+↓"],["들여쓰기 / 내어쓰기","Tab / Shift+Tab"],["이전·다음 패스","Alt+PageUp / Alt+PageDown"],
        ["커서 위 숫자 올리기 / 내리기 (Shift = 10배)","Ctrl+↑ / Ctrl+↓"],["숫자 끌어서 조절","Alt + 좌우 드래그"],
        ["명령 팔레트","Ctrl+Shift+P / F1"],["함수·Uniform으로 이동","Ctrl+Shift+O"],["정의로 이동","F12 / Ctrl+클릭"],["이름 바꾸기","F2"],
        ["줄 삭제","Ctrl+Shift+K"],["줄 위/아래로 복사","Shift+Alt+↑ / Shift+Alt+↓"],["줄 선택 (반복하면 다음 줄까지)","Ctrl+L"],["짝 괄호로 이동","Ctrl+Shift+\\"],
        ["긴 줄 자동 줄바꿈","Alt+Z"],["템플릿 다음 / 이전 자리","Tab / Shift+Tab"],["Tab 키로 포커스 이동 켜기/끄기 (접근성)","Ctrl+M"]]}]},
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
    // "복사" 버튼: 누를 때 text()의 결과를 클립보드에 넣는다.
    const copyButton = text => {
      const copy = element("button", "", "복사"); copy.type = "button";
      copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(text()); flash(copy, "복사됨"); } catch (_) { flash(copy, "복사 실패"); } });
      return copy;
    };
    // 범주 탭 버튼: 누르면 select(id)로 범주를 바꾼다.
    const categoryChip = (chips, id, label, count, select) => {
      const button = element("button"); button.type = "button"; button.dataset.category = id; button.setAttribute("role", "tab");
      button.append(document.createTextNode(label), element("span", "", String(count)));
      button.addEventListener("click", () => select(id)); chips.append(button);
    };
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
      const copy = copyButton(() => { const plan = Snippets.plan(item.id, ""); return [...plan.globals.map(entry => entry.code), plan.mainCode].filter(Boolean).join("\n\n"); });
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
      const chip = (id, label, count) => categoryChip(chips, id, label, count, next => { snippetCategory = next; fill(); });
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
        const ex = element("div", "ref-ex"); ex.append(codeBlock(item.ex), copyButton(() => item.ex)); row.append(ex);
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
      const chip = (id, label, count) => categoryChip(chips, id, label, count, next => { referenceCategory = next; fill(); });
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
      bar.append(copyButton(() => block.code));
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
  }; return {mount};
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
