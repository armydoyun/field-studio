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
// 이전 프레임 참조를 위해 각 패스는 항상 두 장의 Texture를 교대로 사용한다.

  // 렌더러가 매 프레임 값을 넣는 내장 Uniform과 허용 GLSL 타입. 첫 타입이 리플렉션 불가 시 기본값이다.
  // 허용 밖의 타입으로 선언되면 업로드를 생략해 매 프레임 INVALID_OPERATION이 쌓이지 않게 한다.
  const BUILTINS = {resolution:["uResolution",["vec2","vec3"]],time:["uTime",["float"]],delta:["uDeltaTime",["float"]],
    frame:["uFrame",["int","float","uint"]],mouse:["uMouse",["vec2","vec4"]],debug:["uDebugRaySteps",["bool","int"]],
    maxSteps:["uMaxSteps",["int","float"]],maxDistance:["uMaxDistance",["float"]],surfaceEpsilon:["uSurfaceEpsilon",["float"]],
    normalEpsilon:["uNormalEpsilon",["float"]]};
  // 출력 형식별 GPU 저장 방식. float 계열은 EXT_color_buffer_float가 있어야 FBO로 렌더링할 수 있다.
  const FORMATS = {rgba8:{bytes:4,float:false}, rgba16f:{bytes:8,float:true}, rgba32f:{bytes:16,float:true}};
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
    let passes = [], imageChannels = {}, preview = null, previewProgram = null, previewLocations = null, maxTextureSize = null;
    const units = [gl.TEXTURE0, gl.TEXTURE1, gl.TEXTURE2, gl.TEXTURE3]; const passOrder = () => new Map(passes.map((entry,i) => [entry.name,i]));
    const validName = name => typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
    const deleteTargets = pass => {
      for(const fbo of pass.fbos || []) gl.deleteFramebuffer(fbo); for(const tex of pass.textures || []) gl.deleteTexture(tex);
      pass.fbos = []; pass.textures = []; pass.width = pass.height = 0;
    }; const deletePass = pass => { deleteTargets(pass); if(pass.program) gl.deleteProgram(pass.program); pass.program = null; };
    const removeGPU = () => { for(const pass of passes) deletePass(pass); if(previewProgram) gl.deleteProgram(previewProgram); previewProgram = null; };
    const validateChannels = (channels, source, order, isImage = false) => {
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
        result[key] = {buffer:ref.buffer,frame:ref.frame};
      }
      return result;
    }; const validateDefinition = (specs, image = {}) => {
      if(!Array.isArray(specs) || specs.length > 8) throw new TypeError("passes는 최대 8개까지의 배열이어야 합니다."); const order = new Map();
      specs.forEach((s,i) => { if(!s || !validName(s.name) || s.name === "Image" || order.has(s.name)) throw new Error("패스 이름이 유효하지 않거나 중복됩니다."); order.set(s.name,i); });
      const normalized = specs.map(s => {
                if(typeof s.fragment !== "string" || !s.fragment.startsWith("#version 300 es") || s.fragment.length > 262144) throw new Error(`${s.name}: 전체 GLSL ES 3.00 Fragment 문자열이 필요합니다.`);
        const scale = s.scale === undefined ? 1 : s.scale, format = s.format || "rgba8";
                if(!Number.isFinite(scale) || scale < 0.125 || scale > 1 || !Object.hasOwn(FORMATS, format)) throw new Error(`${s.name}: scale 또는 format이 잘못됐습니다.`);
        return {name:s.name, fragment:s.fragment, scale, format, channels:validateChannels(s.channels || {},s.name,order)};
      }); const nextImage = validateChannels(image, "Image", order, true);
      if(normalized.some(s => FORMATS[s.format].float) && !gl.getExtension("EXT_color_buffer_float"))
      throw new Error("RGBA16F/RGBA32F 렌더링은 EXT_color_buffer_float 확장이 필요합니다.");
      return {normalized,nextImage};
    }; const validateConfiguration = (specs, image = {}) => { validateDefinition(specs,image); return true; };
    const compilePass = (source,name) => {
      let program;try {program=createProgram(source);return {program,locations:makeLocations(gl,program)};}
      catch(error) {if(program)gl.deleteProgram(program);error.passName=name;throw error;}
    };
    const setPasses = (specs, image = {}) => {
      const {normalized,nextImage} = validateDefinition(specs,image); const next = []; try {
        for(const s of normalized) {
          next.push({...s,...compilePass(s.fragment,s.name),textures:[],fbos:[],width:0,height:0,readIndex:0});
        }
      } catch(error) { for(const p of next) deletePass(p); throw error; }
      const old = passes; passes = next; imageChannels = nextImage; preview = null; for(const p of old) deletePass(p);
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
    // 구조가 같으면 변경 프로그램만 준비한다. 전부 성공한 뒤 소스/채널을 함께 교체한다.
    const updatePasses = (specs,image={}) => {
      const {normalized,nextImage}=validateDefinition(specs,image);
      if(normalized.length!==passes.length || normalized.some((p,i)=>["name","scale","format"].some(key=>p[key]!==passes[i][key]))) {setPasses(specs,image);return {changed:true,structural:true};}
      const next=[];let changed=JSON.stringify(imageChannels)!==JSON.stringify(nextImage);
      try {for(let i=0;i<passes.length;i++) {
        const pass=passes[i], spec=normalized[i];
        if(pass.fragment!==spec.fragment)next.push({pass,...compilePass(spec.fragment,spec.name)});
        if(JSON.stringify(pass.channels)!==JSON.stringify(spec.channels))changed=true;
      }} catch(error) {for(const item of next)gl.deleteProgram(item.program);throw error;}
      for(const {pass,program,locations} of next) {gl.deleteProgram(pass.program);pass.program=program;pass.locations=locations;}
      passes.forEach((pass,i)=>Object.assign(pass,normalized[i]));imageChannels=nextImage;return {changed:changed||next.length>0,structural:false};
    };
    // 셰이더 교체 및 채널 재연결은 기존 FBO/Texture를 유지한다.
    const setPassFragment = (name, source) => {
      const pass = passes.find(p => p.name === name);
            if(!pass) throw new Error(`존재하지 않는 Buffer: ${name}`);
      if(typeof source !== "string" || !source.startsWith("#version 300 es")) throw new Error("GLSL ES 3.00 Fragment 소스가 필요합니다.");
      const {program,locations}=compilePass(source,name);
      const previous = pass.program;
      pass.program = program; pass.locations = locations; pass.fragment = source; if(previous) gl.deleteProgram(previous);
    }; const setPassChannels = (name, channels) => {
      const index = passes.findIndex(p => p.name === name);
            if(index < 0) throw new Error(`존재하지 않는 Buffer: ${name}`);
      const order = passOrder(); passes[index].channels = validateChannels(channels,name,order);
    };
    const getSpecs = () => passes.map(p => ({name:p.name,fragment:p.fragment,format:p.format,scale:p.scale,channels:JSON.parse(JSON.stringify(p.channels))}));
    const setImageChannels = channels => {
      const order = passOrder(); imageChannels = validateChannels(channels, "Image", order, true);
    }; const setPreview = name => {
            if(name !== null && !passes.some(p => p.name === name)) throw new Error(`존재하지 않는 Buffer: ${name}`);
      preview = name;
    };
    // 모든 패스의 신규 FBO가 준비된 후 교체한다. 중간 실패 시 기존 패스 전체를 유지.
    const createTargets = (pass, width, height) => {
      const temp = {name:pass.name, textures:[], fbos:[], width, height};
      // 이전 프레임의 오류 플래그를 비워야 아래 검사가 이번 할당의 실패(OUT_OF_MEMORY 등)만 판단한다.
      Diagnostics.clearErrors(gl);
      try {
        for(let i=0;i<2;i++) {
          const texture = gl.createTexture(); if(!texture) throw new Error(`${pass.name}: Texture 생성 실패`);
          temp.textures.push(texture); gl.bindTexture(gl.TEXTURE_2D,texture);
          // RGBA16F는 WebGL2에서 선형 필터링이 기본 지원되지만 RGBA32F는 OES_texture_float_linear가 필요하다.
          const internal = {rgba8:gl.RGBA8, rgba16f:gl.RGBA16F, rgba32f:gl.RGBA32F}[pass.format] ?? gl.RGBA8;
          const type = {rgba8:gl.UNSIGNED_BYTE, rgba16f:gl.HALF_FLOAT, rgba32f:gl.FLOAT}[pass.format] ?? gl.UNSIGNED_BYTE;
          const filter = pass.format === "rgba32f" ? gl.NEAREST : gl.LINEAR;
          gl.texImage2D(gl.TEXTURE_2D,0,internal,width,height,0,gl.RGBA,type,null);
          if(typeof gl.getError === "function") {
            const error = gl.getError(); if(error !== gl.NO_ERROR) throw new Error(`${pass.name}: GPU Texture 할당 실패 (${error}) · Scale을 낮추거나 Buffer 수를 줄이세요.`);
          }
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
          const fbo = gl.createFramebuffer(); if(!fbo) throw new Error(`${pass.name}: Framebuffer 생성 실패`);
          temp.fbos.push(fbo); gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
          if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw new Error(`${pass.name}: Framebuffer 불완전`);
          gl.viewport(0,0,width,height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
        }
        return temp;
      } catch(error) { deleteTargets(temp); throw error; }
      finally { gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindTexture(gl.TEXTURE_2D,null); }
    }; const ensureTargets = (width,height) => {
      if(!passes.length)return false;const pending = [], max = maxTextureSize??(maxTextureSize=gl.getParameter(gl.MAX_TEXTURE_SIZE));
      try {for(const pass of passes) {
        const w = Math.max(1,Math.floor(width*pass.scale)), h = Math.max(1,Math.floor(height*pass.scale));
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
          texture=pass.textures[index];width=pass.width;height=pass.height;
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
        }
      // 모든 패스가 성공한 경우에만 previous/current 역할을 교환한다.
        for(const pass of passes) pass.readIndex = 1-pass.readIndex;
      } finally { timer?.end(); releaseChannels(); gl.bindFramebuffer(gl.FRAMEBUFFER,null); }
    }; const bindImage = locations => bindChannels(imageChannels,locations,true);
    const unbindImage = () => releaseChannels();
        const previewFragment = `#version 300 es\nprecision highp float;\nuniform sampler2D uPreview;\nuniform vec2 uResolution;\nout vec4 fragColor;\nvoid main(){fragColor=vec4(texture(uPreview,gl_FragCoord.xy/uResolution).rgb,1.0);}`;
    const drawPreview = (width,height) => {
      if(!preview) return false; const pass = passes.find(p => p.name === preview); if(!pass || !pass.textures.length) return false;
      if(!previewProgram) {
        const next=createProgram(previewFragment);
        try {previewLocations={texture:gl.getUniformLocation(next,"uPreview"),resolution:gl.getUniformLocation(next,"uResolution")};}
        catch(error){gl.deleteProgram(next);throw error;}previewProgram=next;
      }
      releaseChannels(); gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,width,height); gl.useProgram(previewProgram);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,pass.textures[pass.readIndex]);
      gl.uniform1i(previewLocations.texture,0);
      try {gl.uniform2f(previewLocations.resolution,width,height); gl.drawArrays(gl.TRIANGLES,0,3);}
      finally {releaseChannels();} return true;
    }; const readPixel = (name,x,y) => {
      const pass = passes.find(p=>p.name===name);
            if(!pass || !pass.textures.length) throw new Error(`Buffer ${name}이 아직 렌더링되지 않았습니다.`);
      if(!Number.isInteger(x) || !Number.isInteger(y) || x<0 || x>=pass.width || y<0 || y>=pass.height) throw new RangeError("픽셀 좌표가 범위를 벗어났습니다.");
      const float = FORMATS[pass.format].float, pixel = float ? new Float32Array(4) : new Uint8Array(4);
      const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING); Diagnostics.clearErrors(gl);
      try { gl.bindFramebuffer(gl.READ_FRAMEBUFFER,pass.fbos[pass.readIndex]); gl.readPixels(x,y,1,1,gl.RGBA,float?gl.FLOAT:gl.UNSIGNED_BYTE,pixel);
        const error = gl.getError(); if(error !== gl.NO_ERROR) throw new Error(`GPU 픽셀 읽기 실패: ${error}`);
      } finally { gl.bindFramebuffer(gl.READ_FRAMEBUFFER,previous); }
      return [...pixel]; // 좌하단 원점. CPU 읽기는 GPU 동기화 비용이 발생할 수 있다.
    };
    // 모든 ping-pong 텍스처를 지우되 GPU 프로그램과 버퍼 연결은 보존한다.
    const resetTargets = () => {
      releaseChannels(); gl.clearColor(0,0,0,0); for(const pass of passes) {
        for(const fbo of pass.fbos) { gl.bindFramebuffer(gl.FRAMEBUFFER,fbo); gl.viewport(0,0,pass.width,pass.height); gl.clear(gl.COLOR_BUFFER_BIT); }
        pass.readIndex = 0;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    };
    const getPasses = () => passes.map(p => ({name:p.name,format:p.format,scale:p.scale,width:p.width,height:p.height,channels:JSON.parse(JSON.stringify(p.channels))}));
    const detachTexture = id => {
      for(const pass of passes) for(const key of Object.keys(pass.channels))
      if(pass.channels[key].texture === id) delete pass.channels[key];
      for(const key of Object.keys(imageChannels)) if(imageChannels[key].texture === id) delete imageChannels[key];
    }; const getImageChannels = () => JSON.parse(JSON.stringify(imageChannels)); const getPreview = () => preview;
    const getMemoryBytes = () => passes.reduce((sum,p) => sum + p.width*p.height*FORMATS[p.format].bytes*2,0);
    // 패스별 활성 Uniform과 무시된 내장 Uniform(타입 불일치) 목록. 디버그 패널용.
    const getReflection = () => passes.map(p => ({name:p.name, ...(Diagnostics.describeLocations(p.locations) || {uniforms:null, ignored:[]})}));
    const onLost = (release=false) => {
      if(release)removeGPU(); // 복구 실패 시 새 컨텍스트의 부분 생성 자원을 정리한다.
      // Context Lost에서는 더 이상 유효하지 않은 WebGL 객체를 삭제하지 않는다.
      for(const p of passes) { p.program = null; p.locations = null; p.textures = []; p.fbos = []; p.width=p.height=0; p.readIndex=0; }
      previewProgram = previewLocations = maxTextureSize = null;
    }; const restore = () => {
      const compiled = [];
      try {for(const p of passes)compiled.push({p,...compilePass(p.fragment,p.name)});}
      catch(error) { for(const c of compiled) gl.deleteProgram(c.program); throw error; }
      for(const c of compiled) { c.p.program = c.program; c.p.locations = c.locations; }
    }; const dispose = () => { removeGPU(); passes = []; imageChannels = {}; preview = previewLocations = maxTextureSize = null; };
    return {setPasses,updatePasses,validateConfiguration,refreshPrograms,setPassFragment,setPassChannels,getSpecs,setImageChannels,setPreview,ensureTargets,drawPasses,bindImage,unbindImage,drawPreview,readPixel,resetTargets,getPasses,getImageChannels,getPreview,getMemoryBytes,getReflection,detachTexture,onLost,restore,dispose};
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
      const normalized=normalizeUniform(type,value), {min,max,step}=options, integer=type==="int"||type==="uint";
      if([min,max,step].some(x=>x!==undefined) && (!["float","int","uint"].includes(type) || ![min,max,step].every(Number.isFinite) || !(min<max && step>0) || (integer && ![min,max,step].every(Number.isInteger)) || (type==="uint" && min<0)))
        throw new Error("Uniform 슬라이더 범위가 올바르지 않습니다.");
      return writeData({type,value:normalized,data:makeData(type,normalized),options:min===undefined?{}:{min,max,step}});
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
    }; const setPreviewPass = name => {
      if(disposed || lost) throw new Error("현재 미리보기를 변경할 수 없습니다."); passManager.setPreview(name);
    }; const readPassPixel = (name,x,y) => {
      if(disposed || lost) throw new Error("현재 픽셀을 읽을 수 없습니다."); return passManager.readPixel(name,x,y);
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
      previewPass:passManager.getPreview(), bufferMemoryBytes:passManager.getMemoryBytes(),
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
      setPasses, setPassFragment, setPassChannels, setImageChannels, setPreviewPass, readPassPixel,
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
    ["uRMMaxSteps","int",128,{min:1,max:512,step:1}], ["uRMMaxDistance","float",100,{min:0.01,max:10000,step:1}],
    ["uRMSurfaceEpsilon","float",0.001,{min:0.000001,max:0.1,step:0.000001}],
    ["uRMNormalEpsilon","float",0.001,{min:0.000001,max:0.1,step:0.000001}], ["uRMHeatmap","bool",false]
  ];
  return {vertex, fragment, raymarch:raymarch.replace(/uMaxSteps/g,"uRMMaxSteps").replace(/uMaxDistance/g,"uRMMaxDistance")
    .replace(/uSurfaceEpsilon/g,"uRMSurfaceEpsilon").replace(/uNormalEpsilon/g,"uRMNormalEpsilon")
    .replace(/uDebugRaySteps/g,"uRMHeatmap"), orbitHome, rayUniforms, passes:[], imageChannels:{}};
})();
const code_editor=(()=>{
// 로컬 textarea 기반 GLSL 편집 보조 도구. 별도 라이브러리나 CDN이 필요하지 않다.
  const mount = (textarea,ask,beforeEdit=()=>{},uniformNames=()=>[]) => {
    const $ = id => document.getElementById(id), ac = new AbortController(), signal = ac.signal;
    const listen = (target, type, fn) => target.addEventListener(type, fn, {signal});
    const gutter = $("studioLines"), highlight = $("studioHighlight"), position = $("studioCursor"), findPanel = $("studioFindPanel");
    const TOKENS = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*|"(?:\\.|[^"\\])*"|\b(?:uniform|out|in|inout|const|precision|highp|mediump|lowp|if|else|for|while|break|continue|return|discard|struct|layout|switch|case|default|true|false)\b|\b(?:void|float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234]|sampler2D|samplerCube|isampler2D|usampler2D)\b|\b(?:texture|textureSize|texelFetch|normalize|length|distance|dot|cross|mix|clamp|smoothstep|step|pow|exp|log|sin|cos|tan|atan|abs|min|max|floor|ceil|fract|mod|sqrt|reflect|refract|radians|degrees)\b|\b\d+(?:\.\d*)?(?:[eE][+-]?\d+)?\b|\.\d+(?:[eE][+-]?\d+)?/g;
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
      const entries=scanFunctions(textarea.value);symbols.replaceChildren(new Option(`ƒ Functions (${entries.length})`,""),
        ...entries.map(({name,params,line})=>new Option(`${name}(${params.slice(0,38)}${params.length>38?"…":""}) · Ln ${line}`,String(line))));
      symbols.value="";symbols.disabled=!entries.length;
    };
    let paintRequest = 0,paintedSource=null; const paint = () => {
      paintRequest=0;const src=textarea.value;if(src===paintedSource)return;paintedSource=src;const frag=document.createDocumentFragment();let offset=0;
      TOKENS.lastIndex=0;for(const match of src.matchAll(TOKENS)) {
        if(match.index>offset)frag.append(document.createTextNode(src.slice(offset,match.index)));
        const token=match[0],span=document.createElement("span");span.textContent=token;
        span.className=token.startsWith("//")||token.startsWith("/*")?"glsl-comment":token.startsWith("#")?"glsl-directive":
        token.startsWith('"')?"glsl-string":/^(?:uniform|out|in|inout|const|precision|highp|mediump|lowp|if|else|for|while|break|continue|return|discard|struct|layout|switch|case|default|true|false)$/.test(token)?"glsl-keyword":
        /^(?:void|float|int|uint|bool|[biu]?vec[234]|mat[234]|[iu]?sampler2D|samplerCube)$/.test(token)?"glsl-type":
        /^[.\d]/.test(token)?"glsl-number":"glsl-builtin";
        frag.append(span);offset=match.index+token.length;
      }
      if(offset<src.length)frag.append(document.createTextNode(src.slice(offset)));
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
      textarea.wrap=wrap?"soft":"off";textarea.closest(".studio-editor-frame").classList.toggle("is-wrapped",wrap); $("studioWrap").setAttribute("aria-pressed", String(wrap));
      $("studioFontSize").textContent = `${fontSize}px`; $("studioIndent").value = String(tabSize); save(); updateLines(); renderDiagnostics();
    }; const lineAt = offset => textarea.value.slice(0,offset).split("\n").length; const updateCursor = () => {
      const p = textarea.selectionStart, line = lineAt(p), start = textarea.value.lastIndexOf("\n",p-1)+1;
      const selected = textarea.selectionEnd - p;
      position.textContent = `Ln ${line}, Col ${p-start+1}${selected ? ` · ${selected} selected` : ""}`;
    }; const updateLines = () => {
      const count = textarea.value.split("\n").length;
      if(gutter.dataset.count !== String(count)) { gutter.textContent = Array.from({length:count},(_,i)=>i+1).join("\n"); gutter.dataset.count = count; }
      gutter.scrollTop = textarea.scrollTop; updateCursor();schedulePaint();
    }; const replaceSelection = (text, start = textarea.selectionStart, end = textarea.selectionEnd) => {
      beforeEdit();textarea.setRangeText(text,start,end,"end"); textarea.dispatchEvent(new Event("input",{bubbles:true}));
    }; const goToLine = (line, column = 1) => {
      const rows = textarea.value.split("\n"); line = Math.min(rows.length,Math.max(1,Number(line)||1));
      const begin = rows.slice(0,line-1).reduce((sum,row)=>sum+row.length+1,0);
      const offset = begin + Math.min(rows[line-1].length,Math.max(0,column-1)); textarea.focus(); textarea.setSelectionRange(offset,offset);
      const height = parseFloat(getComputedStyle(textarea).lineHeight) || fontSize*1.6;
      textarea.scrollTop = Math.max(0,(line-4)*height); updateLines(); return line;
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
      const start = matches[matchIndex]; textarea.focus();textarea.setSelectionRange(start,start+len);
      const line = lineAt(start), height=parseFloat(getComputedStyle(textarea).lineHeight)||fontSize*1.6;
      textarea.scrollTop = Math.max(0,(line-4)*height);updateCursor();result.textContent=`${matchIndex+1} / ${matches.length}`; return true;
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
    }; const completion=$('studioCompletion'), builtin=`abs acos asin atan ceil clamp cos cross degrees distance dot exp exp2 floor fract inversesqrt length log log2 max min mix mod normalize pow radians reflect refract sign sin smoothstep sqrt step tan texture texelFetch textureSize transpose determinant inverse mat2 mat3 mat4 vec2 vec3 vec4 ivec2 ivec3 ivec4 float int uint bool void if else for while return break continue discard uniform const in out inout struct layout sampler2D iChannel0 iChannel1 iChannel2 iChannel3 iChannelResolution uTime uDeltaTime uFrame uResolution uMouse`.split(' ');
    let candidates=[],chosen=0,wordStart=0,wordEnd=0;
    const hideCompletion=()=>{completion.hidden=true;candidates=[];};
    const renderCompletion=()=>{completion.replaceChildren(...candidates.map((name,i)=>{const item=document.createElement('button');item.type='button';item.textContent=name;item.dataset.index=i;item.className=i===chosen?'is-selected':'';item.setAttribute('role','option');item.setAttribute('aria-selected',String(i===chosen));return item;}));};
    const showCompletion=()=>{
      const at=textarea.selectionStart,src=textarea.value;if(at!==textarea.selectionEnd||codeMode(at))return hideCompletion();
      const prefix=src.slice(0,at).match(/[A-Za-z_]\w*$/)?.[0]||'';wordStart=at-prefix.length;wordEnd=at+(src.slice(at).match(/^\w*/)?.[0].length||0);
      const words=[...new Set([...builtin,...uniformNames(),...(cleanSource(src).match(/\b[A-Za-z_]\w*\b/g)||[])])];
      candidates=words.filter(name=>name.startsWith(prefix)&&name!==src.slice(wordStart,wordEnd)).sort().slice(0,8);
      if(!candidates.length)return hideCompletion();chosen=0;completion.hidden=false;renderCompletion();
    }; const acceptCompletion=()=>{if(completion.hidden||!candidates[chosen])return;const name=candidates[chosen];hideCompletion();replaceSelection(name,wordStart,wordEnd);updateCursor();};
    listen(completion,'pointerdown',event=>event.preventDefault());
    listen(completion,'click',event=>{const item=event.target.closest('button[data-index]');if(item){chosen=Number(item.dataset.index);acceptCompletion();textarea.focus();}});
    listen($('studioComplete'),'click',()=>{textarea.focus();showCompletion();});
    listen(textarea,'blur',hideCompletion);listen(textarea,'click',hideCompletion);
    listen(textarea,'input',()=>{hideCompletion();if(diagnostics.length)layer?.classList?.add("is-stale");updateLines();if(!findPanel.hidden)updateMatches();});
    listen(textarea,"scroll",()=>{gutter.scrollTop=textarea.scrollTop;
      highlight.scrollTop=textarea.scrollTop;highlight.scrollLeft=textarea.scrollLeft;if(diagnostics.length)renderDiagnostics();});
    for(const type of ["click","keyup","select"])listen(textarea,type,updateCursor);
    listen(gutter,"click",e=>{const height=parseFloat(getComputedStyle(textarea).lineHeight)||fontSize*1.6;
      goToLine(Math.floor((e.clientY-gutter.getBoundingClientRect().top+gutter.scrollTop)/height)+1);
    }); listen(textarea,"keydown",event=>{
      if(event.isComposing)return;const cmd=event.ctrlKey||event.metaKey, start=textarea.selectionStart,end=textarea.selectionEnd,src=textarea.value;
      if(!completion.hidden && ['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)) {
        event.preventDefault();if(event.key==='Escape')hideCompletion();else if(event.key==='Enter'||event.key==='Tab')acceptCompletion();
        else {chosen=(chosen+(event.key==='ArrowDown'?1:-1)+candidates.length)%candidates.length;renderCompletion();}
      } else if(cmd && !event.altKey && !event.shiftKey && event.code==='Space') {
        event.preventDefault();showCompletion();
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
    listen($("studioWrap"),"click",()=>{wrap=!wrap;setPresentation();});
    listen($("studioIndent"),"change",event=>{tabSize=event.target.value==="2"?2:4;setPresentation();});setPresentation();
    return {update:()=>{hideCompletion();updateLines();renderDiagnostics();},goToLine,showFind,setDiagnostics,dispose:()=>{hideCompletion();ac.abort();if(paintRequest)cancelAnimationFrame(paintRequest);}};
  }; return {mount};
})();
const studio=((CodeEditor)=>{
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
  const mount = (renderer, Shader, settings = null) => {
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
    const editor = CodeEditor.mount($("studioCode"),ask,captureCursor,()=>renderer.getUserUniforms().map(item=>item.name));
    for(const type of ["beforeinput","select","click","keyup","scroll"])on($("studioCode"),type,captureCursor);
    try { dockHeight = Math.max(25,Math.min(85,Number(localStorage.getItem("webgl.shader-studio.height.v2"))||defaultHeight)); } catch (_) {}
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
        return true;
      } catch(error) {
        dirty = true;compileFailed=true; if(error.passName && error.passName!==selected) select(error.passName);showError(error); scheduleDraft();return false;
      }
    }; const schedule = (typing = false) => {
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
      {source:`Buffer ${ref.buffer}`,frame:ref.frame==="current"?"current · 이번 프레임":"previous · 지난 프레임",help:ref.frame==="current"?"이번 프레임에 앞서 실행된 버퍼의 결과를 읽습니다.":"지난 프레임에 저장된 버퍼 결과를 읽습니다. 자기 자신을 연결하면 피드백을 만들 수 있습니다."};
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
        for(const pass of project.passes){const allowed=validCurrent(selected,pass.name);addOption(`${pass.name}:current`,`${pass.name} · current${allowed?" · 이번 프레임":pass.name===selected?" · 자기 참조 불가":" · 실행 순서상 불가"}`,!allowed);addOption(`${pass.name}:previous`,`${pass.name} · previous · 지난 프레임`);}
        const current=channels?.[i];select.value=current?(current.texture?`tex:${current.texture}`:`${current.buffer}:${current.frame}`):"";
        const describe=()=>{const info=inputInfo(channels?.[i],assets);hint.textContent=`${info.source} · ${info.frame} — ${info.help}`;};describe();
        select.addEventListener("change",()=>{
          if(!select.value)delete channels[i];else if(select.value.startsWith("tex:"))channels[i]={texture:select.value.slice(4)};else{const [buffer,frame]=select.value.split(":");channels[i]={buffer,frame};}
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
      $("studioDown").disabled = !p || idx === project.passes.length-1; $("studioFormatField").hidden = $("studioScaleField").hidden = !p;
      const refs=p?references(selected):[];$("studioPassImpact").hidden=!p;$("studioPassImpact").textContent=refs.length?`삭제 시 연결 ${refs.length}개 해제`:"다른 패스의 참조 없음";
      $("studioRemove").title=p?`${selected} 삭제${refs.length?` · 함께 해제: ${refs.join(", ")}`:""} · Undo로 복원`:"Image는 삭제할 수 없습니다.";
      $("studioInspect").disabled=!p;if(!p)$("studioInspect").checked=false;
      if(p) { $("studioFormat").value = p.format; $("studioScale").value = String(p.scale); }
            $("studioCodeTitle").textContent = selected === "Image" ? "편집 · Image.frag" : `편집 · Buffer ${selected}.frag`;
    };
    const renderEditor = () => { renderTabs(); renderChannels(); const area=$("studioCode"),source=activeSource()||"",view=views.get(selected);area.value=source;
      const caret=view?.source===source?view.caret:[0,0,"none"],scroll=view?.source===source?view.scroll:[0,0];area.setSelectionRange(caret[0],caret[1],caret[2]);area.scrollTop=scroll[0];area.scrollLeft=scroll[1];syncDiagnostics();editor.update();renderGraph(); };
    const select = name => {
      if(name !== "Image" && !find(name)) return; if(name === selected) return; rememberEditor();views.set(selected,{source:activeSource(),...cursorState()}); selected = name; renderEditor(); checkpoint.selected=selected;preview();
    }; const normalizeDependencies = () => {
      const changed=[];for(const p of project.passes) for(const [channel,ref] of Object.entries(p.channels)) {
        if(ref.frame === "current" && !validCurrent(p.name,ref.buffer)){changed.push(`${p.name}.iChannel${channel} ← ${ref.buffer}`);p.channels[channel] = {buffer:ref.buffer,frame:"previous"};}
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
        settings?.save(true);document.dispatchEvent(new Event("shader-settings-applied"));setStatus(`새 프로젝트 시작 · 파라미터 ${users.length}개 · Undo로 이전 작업 복원`);return true;
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
    }; const maximize = () => {
      if(!expanded) {
        resumeAfterMaximize=renderer.getStats().running; if(resumeAfterMaximize) renderer.stop();
      } else if(resumeAfterMaximize) renderer.start(); expanded=!expanded;$("stage").classList.toggle("studio-maximized",expanded);
      $("studioResize").hidden=expanded;$("studioMaximize").setAttribute("aria-pressed",String(expanded));
      $("studioPause").textContent=expanded?(resumeAfterMaximize?"복귀 시 재생":"복귀 시 정지"):
      (renderer.getStats().running?"Ⅱ Pause":"▶ Play");
    }; const close = () => {if(expanded)maximize();openState=false;$("studioDock").hidden=true;
      $("studioResize").hidden=true;$("stage").classList.remove("studio-maximized"); $("studioToggle").setAttribute("aria-label","셰이더 편집기 열기");$("studioToggle").setAttribute("aria-expanded","false");$("studioToggle").focus();};
    const setDockHeight = value => {dockHeight=Math.max(25,Math.min(85,value));$("studioDock").style.setProperty("--studio-height",`${dockHeight}%`);
      if(layout==="bottom")$("studioResize").setAttribute("aria-valuenow",String(Math.round(dockHeight)));
      try{localStorage.setItem("webgl.shader-studio.height.v2",String(dockHeight));}catch (_){} };
    // 편집기 배치: right(캔버스 옆 분할) 또는 bottom(캔버스 아래). 넓은 화면은 right가 기본이다.
    const LAYOUT_KEY="webgl.shader-studio.layout.v1";let layout=window.innerWidth>=1200?"right":"bottom",dockWidth=46;
    try{const saved=JSON.parse(localStorage.getItem(LAYOUT_KEY)||"{}");if(["right","bottom"].includes(saved.layout))layout=saved.layout;if(Number.isFinite(saved.width))dockWidth=Math.max(30,Math.min(75,saved.width));}catch(_){}
    const saveLayout=()=>{try{localStorage.setItem(LAYOUT_KEY,JSON.stringify({layout,width:dockWidth}));}catch(_){}};
    const setDockWidth = value => {dockWidth=Math.max(30,Math.min(75,value));$("stage").style.setProperty("--studio-width",`${dockWidth}%`);
      if(layout==="right")$("studioResize").setAttribute("aria-valuenow",String(Math.round(dockWidth)));saveLayout();};
    const applyLayout = () => {
      const right=layout==="right";$("stage").classList.toggle("studio-layout-right",right);
      const handle=$("studioResize");handle.setAttribute("aria-orientation",right?"vertical":"horizontal");
      handle.setAttribute("aria-valuemin",right?"30":"25");handle.setAttribute("aria-valuemax",right?"75":"85");
      handle.setAttribute("aria-valuenow",String(Math.round(right?dockWidth:dockHeight)));
      handle.title=right?"드래그 또는 ←→로 너비 조절 · 두 번 클릭해 기본 너비 복원":"드래그 또는 ↑↓로 높이 조절 · Home/End · 두 번 클릭해 기본 높이 복원";
      $("studioLayout").setAttribute("aria-pressed",String(right));$("studioLayout").title=right?"편집기를 캔버스 아래로 배치":"편집기를 캔버스 오른쪽에 나란히 배치";
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
    }); on($("studioCode"),"input",event=>{ rememberEditor();schedule((event.inputType==="insertText" && event.data?.length===1) || /^(deleteContent|insertCompositionText)/.test(event.inputType||"")); }); on($("studioCode"),"keydown",event=>{
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
    on($("studioFormat"),"change",event=>{find(selected).format=event.target.value;schedule();apply();});
    on($("studioScale"),"change",event=>{find(selected).scale=Number(event.target.value);schedule();apply();});
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
      $("studioPause").textContent=expanded?(resumeAfterMaximize?"복귀 시 재생":"복귀 시 정지"):getPlaybackState()?"Ⅱ Pause":"▶ Play";return getPlaybackState();};
    on($("studioToolsToggle"),"click",()=>{const hidden=$("studioTools").hidden=!$("studioTools").hidden;$("studioToolsToggle").setAttribute("aria-expanded",String(!hidden));saveWorkspace();});
    const resizer=$("studioResize");let sizing=false;
    on(resizer,"pointerdown",e=>{if(e.button!==0)return;sizing=true;resizer.setPointerCapture(e.pointerId);e.preventDefault();});
    on(resizer,"pointermove",e=>{if(!sizing)return;const rect=$("stage").getBoundingClientRect();
      if(splitRight()){if(rect.width>0)setDockWidth((rect.right-e.clientX)/rect.width*100);}
      else if(rect.height>0)setDockHeight((rect.bottom-e.clientY)/rect.height*100);});
    on(resizer,"pointerup",()=>{sizing=false;});on(resizer,"pointercancel",()=>{sizing=false;});on(resizer,"lostpointercapture",()=>{sizing=false;});on(resizer,"dblclick",()=>splitRight()?setDockWidth(46):setDockHeight(defaultHeight));
    on(resizer,"keydown",e=>{
      if(splitRight()){if(["ArrowLeft","ArrowRight","Home","End"].includes(e.key)){e.preventDefault();setDockWidth(e.key==="Home"?30:e.key==="End"?75:dockWidth+(e.key==="ArrowLeft"?3:-3));}return;}
      if(["ArrowUp","ArrowDown","Home","End"].includes(e.key)) {e.preventDefault();setDockHeight(e.key==="Home"?25:e.key==="End"?85:dockHeight+(e.key==="ArrowUp"?3:-3));}});
    on($("studioLayout"),"click",toggleLayout);
    // 분할 배치에서 도구 서랍은 코드 위에 겹치므로, 코드를 누르면 닫아 편집 영역을 돌려준다.
    on($("studioCode"),"pointerdown",()=>{if(splitRight()&&!$("studioTools").hidden){$("studioTools").hidden=true;$("studioToolsToggle").setAttribute("aria-expanded","false");}});
    on(document,"keydown",event=>{
      if(event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.isComposing) return;
      if(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) return;
      if(event.key.toLowerCase()==="e") {event.preventDefault();toggle();}
    }); on(document,"fullscreenchange",()=>{if(document.fullscreenElement)close();});
    const workspaceKey="webgl.shader-studio.workspace.v1",groups=["studioInputs","studioFiles","studioStarters","studioImages","studioDependencies","studioInspector","studioCodeTools"];
    const saveWorkspace=()=>{try{localStorage.setItem(workspaceKey,JSON.stringify({toolsHidden:$("studioTools").hidden,open:Object.fromEntries(groups.map(id=>[id,$(id).open]))}));}catch(_){}};
    setDockHeight(dockHeight);setDockWidth(dockWidth);applyLayout();$("studioTools").hidden=window.matchMedia("(max-width:600px)").matches||layout==="right";
    try{const state=JSON.parse(localStorage.getItem(workspaceKey)||"{}");if(typeof state?.toolsHidden==="boolean")$("studioTools").hidden=state.toolsHidden;for(const id of groups)if(typeof state?.open?.[id]==="boolean")$(id).open=state.open[id];}catch(_){}
    for(const id of groups)on($(id),"toggle",saveWorkspace);$("studioToolsToggle").setAttribute("aria-expanded",String(!$("studioTools").hidden));renderEditor();restore();loadDraft(savedDraft);undoStack.length=redoStack.length=0;checkpoint=historyState();syncHistory();
    const removeAllPasses = () => proceed(confirmReplace(),()=>setProject({image:renderer.getFragmentSource(),passes:[],imageChannels:{}}));
    // 갤러리 등 외부 예제: 미적용 변경 확인 → 코드·버퍼·파라미터 일괄 교체(Undo 가능).
    const loadExample = (next,users=[]) => startProject(next,users);
    return {open,close,toggle,apply,setProject,getPlaybackState,togglePlayback,loadFromRenderer,removeAllPasses,exampleRaymarch,examplePipeline,exampleFeedback,loadExample,
      undo:()=>historyMove(true),redo:()=>historyMove(false),getProject:()=>copy(project),exportPack,importPack,dispose:()=>{
        disposed=true;if(timer)clearTimeout(timer);if(draftTimer)clearTimeout(draftTimer);
        if(dirty){try{rememberEditor();localStorage.setItem(DRAFT_KEY,JSON.stringify({version:1,project,selected}));}catch(_){}}
        if(pending)finish(false);editor.dispose();controller.abort();}};
  }; return {mount};
})(code_editor);
const ui=(()=>{
// Renderer의 공개 API만 호출하는 설정 패널. WebGL 리소스를 소유하지 않는다.
  const mount = (renderer, input, settings) => {
    const $ = id => document.getElementById(id); const controller = new AbortController(), signal = controller.signal;
    const element = tag => document.createElement(tag),setText=(id,text)=>{const node=$(id);if(node.textContent!==text)node.textContent=text;};
    const listen = (el, event, callback) => el.addEventListener(event, callback, {signal}); const showError = message => {
      $("uiError").textContent = message || ""; $("toastMessage").textContent = message || "";$("uiToast").hidden=!message; $("uiToast").classList.toggle("is-visible", !!message);
    }; const attempt = callback => { try { callback(); showError(""); } catch(error) { showError(error.message); } };
    listen($("uiDismiss"),"click",()=>showError(""));
    // 타입 정보(성분 수, f/i/u/b/m 종류)는 Renderer의 표를 따른다. 새 타입이 추가돼도 UI 분기는 바뀌지 않는다.
    const typeTable = new Map((renderer.getUniformTypes?.() || []).map(item => [item.type, item]));
    const typeInfo = type => typeTable.get(type) || {type, components:Number(/^vec([234])$/.exec(type)?.[1]) || 1, kind:type === "bool" ? "b" : type === "int" ? "i" : "f"};
    const parseBool = (raw, type) => {
      if(!["true", "false", "1", "0"].includes(raw.toLowerCase())) throw new Error(`${type}은 true/false 또는 1/0으로 입력하세요.`);
      return raw.toLowerCase() === "true" || raw === "1";
    };
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
        } else if(typeInfo(item.type).components > 1) {
          // 벡터는 X/Y/Z/W, 행렬은 column-major 순서의 [열,행] 칸으로 편집한다. bvec 성분은 체크박스.
          const {kind} = typeInfo(item.type), dim = kind === "m" ? Math.round(Math.sqrt(item.value.length)) : 0;
          const grid = element("div"); grid.className = dim ? "uniform-vector is-matrix" : "uniform-vector";
          if(dim) grid.style.setProperty("--uniform-columns", String(dim));
          item.value.forEach((value, index) => {
            const field = element("div");
            const label = element("label"); label.textContent = dim ? `${Math.floor(index / dim)},${index % dim}` : ["X", "Y", "Z", "W"][index];
            const input = element("input"); input.setAttribute("aria-label",`${item.name} ${label.textContent}`);
            if(kind === "b") { input.type = "checkbox"; input.checked = value; }
            else { input.type = "number"; input.step = kind === "f" || kind === "m" ? "any" : "1"; if(kind === "u") input.min = "0"; input.value = String(value); }
            input.addEventListener("change", () => {
              const values = renderer.getUserUniforms().find(u=>u.name===item.name)?.value;
              if(!values)return renderUniforms();
              item.value=[...values];values[index] = kind === "b" ? input.checked : input.value.trim() ? Number(input.value) : NaN;
              if(!commit(input,values)) { if(kind === "b") input.checked = item.value[index]; else input.value=String(item.value[index]); }
            }); field.append(label, input); grid.append(field);
          }); row.append(grid);
        } else {
          const pair = element("div"); pair.className = "uniform-pair";
          const number = element("input"); number.type = "number"; number.step = typeInfo(item.type).kind === "f" ? "any" : "1"; if(item.type === "uint") number.min = "0"; number.value = String(item.value);
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
            range.addEventListener("input", () => {if(commit(range,Number(range.value)))number.value=String(item.value);});
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
      renderer.defineUniform(name,type,value,options);clearDeleted();$("uniformSearch").value="";renderUniforms();$("uniformSearch").focus();
    })); const updateTypeFields = () => {
      const t = $("uniformType").value,bool=t==="bool",{components:size,kind}=typeInfo(t);$("uniformValue").hidden=bool;$("uniformValue").required=!bool;$("uniformBoolValue").hidden=!bool;
      $("uniformValueHelp").textContent=bool?"선택한 상태가 GLSL의 true/false로 전달됩니다.":kind==="m"?`${size}개 숫자를 column-major 순서로 입력하세요. 기본값은 단위 행렬입니다.`:kind==="b"?`${size}개의 true/false를 쉼표로 구분하세요.`:size>1?`${size}개 ${kind==="f"?"숫자":kind==="u"?"0 이상 정수":"정수"}를 쉼표로 구분하세요. 예: ${defaultValue(t)}`:"숫자를 입력하세요. 슬라이더 범위는 선택 사항입니다."; $("rangeFields").hidden = !["float", "int", "uint"].includes(t);
      $("uniformValue").value = defaultValue(t);
    }; listen($("uniformType"), "change", updateTypeFields); listen($("uniformSearch"), "input", renderUniforms);
    listen($("uniformEditor"),"toggle",()=>{if($("uniformEditor").open)$("uniformName").focus();});
    listen($("uniformCancel"),"click",()=>{$("uniformEditor").open=false;showError("");$("uniformEditor").querySelector("summary").focus();});
    listen($("uniformForm"), "submit", event => {
      event.preventDefault(); attempt(() => {
        const type = $("uniformType").value; const value = parseValue(type,type==="bool"?$("uniformBoolValue").value:$("uniformValue").value);
        const min = $("uniformMin").value.trim(), max = $("uniformMax").value.trim(), step = $("uniformStep").value.trim();
        const hasBounds = ["float","int","uint"].includes(type) && [min, max, step].some(Boolean);
        if(hasBounds && ![min, max, step].every(Boolean)) throw new Error("슬라이더의 Min, Max, Step을 모두 입력하세요.");
        const opts = hasBounds ? {min:Number(min), max:Number(max), step:Number(step)} : {};
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
      if(window.matchMedia("(max-width:820px)").matches)window.shaderStudio?.close();document.body.classList.remove("panel-hidden");syncPanel();setActiveTab("uniforms");$("uniformSearch").focus();
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
    const helpDialog = $("quickHelp"), toggleHelp = () => helpDialog.open ? helpDialog.close() : helpDialog.showModal();
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
      setText("renderState",s.running?"재생 중":"일시정지");$("renderState").dataset.running=String(s.running);$("studioPause").textContent=stage.classList.contains("studio-maximized")?(playing?"복귀 시 재생":"복귀 시 정지"):playing?"Ⅱ Pause":"▶ Play";
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
      document.body.classList.toggle("panel-hidden", data.panelHidden === true);
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
      $("profileGpuTiming").disabled = !stats.gpu?.available; $("profileGpuTiming").checked = !!stats.gpu?.enabled;
    };
    $("profileGpuTiming").addEventListener("change", event => { try { renderer.setGpuTiming(event.target.checked); } catch(error) { event.target.checked = !event.target.checked; } }, {signal});
    $("profileReset").addEventListener("click", () => { for(const data of Object.values(series)) data.fill(0); head = count = 0; drawChart(); }, {signal});
    // 탭을 연 직후 바로 최신 상태를 보여준다.
    for(const button of document.querySelectorAll('#panelTabs [data-tab="profile"]')) button.addEventListener("click", () => { lastSignature = ""; setTimeout(tick, 0); }, {signal});
    const timer = setInterval(tick, SAMPLE_MS);
    return {refresh:() => { lastSignature = ""; tick(); }, dispose:() => { disposed = true; clearInterval(timer); controller.abort(); }};
  }; return {mount};
})();
const gallery=(()=>{
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
  // 기존 Studio 예제(멀티 패스·3D)는 Studio가 소유한 정의를 그대로 호출한다.
  const LESSONS = [
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
      dialog.close(); finishOnboarding();
      const ok = await (item.action ? studio[item.action]() : studio.loadExample({image:item.image, passes:[], imageChannels:{}}, item.users));
      if(ok) studio.open();
    };
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
          else if(type === "vec2") gl.uniform2fv(loc, value); else if(type === "vec3") gl.uniform3fv(loc, value); else if(type === "vec4") gl.uniform4fv(loc, value);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3); gl.deleteProgram(program); return true;
      };
      const copy = id => { for(const target of dialog.querySelectorAll(`canvas[data-thumb="${id}"]`)) target.getContext("2d")?.drawImage(surface, 0, 0); };
      for(const item of ART) if(render(item.image, item.users)) copy(item.id);
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
    return {open, close, dispose:() => controller.abort()};
  }; return {mount};
})();
((Renderer, Shader, UI, Input, Settings, Studio, Profiler, Gallery)=>{
// 앱 조립 진입점. 범용 기본 GLSL과 Ray Marching 프리셋은 shader.js, GPU 렌더링은 renderer.js가 담당한다.








  const canvas = document.getElementById("screen"), status = document.getElementById("status");
  let renderer = null, ui = null, input = null, settings = null, studio = null, profiler = null, gallery = null; const initialize = async () => {
    try {
      renderer = Renderer.createRenderer(canvas, Shader, message => {
        status.textContent = message; if(message) console.warn(message);
      });
      input = Input.mount(canvas,renderer,Shader.orbitHome); // 카메라 Uniform은 Starter가 등록할 때만 사용한다.
      settings = Settings.mount(renderer); settings.load(); // 저장 설정의 사용자 Uniform 복원
      await renderer.restoreTextures(); // 프로젝트 채널 연결을 복원하기 전에 이미지 파일을 복구한다.
      ui = UI.mount(renderer, input, settings); studio = Studio.mount(renderer, Shader, settings); profiler = Profiler.mount(renderer); gallery = Gallery.mount({studio, Shader}); renderer.start(); status.textContent = "";
      // HTML 패널 없이도 사용자 설정과 키 이벤트를 직접 제어할 수 있다.
      window.shaderPlayground = renderer; window.shaderInput = input; window.shaderSettings = settings;
      window.shaderStudio = studio; window.addEventListener("beforeunload", () => {
        gallery?.dispose(); profiler?.dispose(); studio?.dispose(); settings?.dispose(); ui?.dispose(); input?.dispose(); renderer?.dispose();
        delete window.shaderPlayground; delete window.shaderInput; delete window.shaderSettings; delete window.shaderStudio;
      }, {once:true});
    } catch(error) {
      gallery?.dispose(); profiler?.dispose(); studio?.dispose(); settings?.dispose(); ui?.dispose(); input?.dispose(); renderer?.dispose();
      console.error(error); status.textContent = error.message;
    }};initialize();
})(renderer, shader, ui, input, settings, studio, profiler, gallery);
})();
