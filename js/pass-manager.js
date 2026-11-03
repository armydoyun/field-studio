// 화면 외 렌더 패스의 프로그램, 출력 Texture 및 FBO를 관리한다.
// 이전 프레임 참조를 위해 각 패스는 항상 두 장(ping-pong)의 Texture 세트를 교대로 사용한다.
// 한 패스는 최대 4개의 출력(MRT, layout(location=N))을 가질 수 있고, 출력마다 ping-pong Texture가 있다.
import * as Diagnostics from "./gpu-diagnostics.js";

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
  }; export {createPassManager, makeLocations, FORMATS};
