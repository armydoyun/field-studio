require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/architecture-regression.js — 브라우저 외부에서 실행할 수 있는 WebGL API 계약 회귀 테스트.
// 모의 GPU 테스트이므로 실제 GLSL 드라이버 컴파일을 대신하지는 않는다.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const root = path.join(__dirname,"..");let passed=0;
const check=(ok,label)=>{assert.ok(ok,label);passed++;console.log("PASS",label);};
const modules={};
const load = (name) => {
  if(modules[name])return modules[name];
  const source=fs.readFileSync(path.join(root,"js",name+".js"),"utf8");
  const scope={console,define:(deps,factory)=>{const args=deps.map(load);modules[name]=factory(...args);}};
  vm.runInNewContext(source,scope,{filename:name+".js"});
  return modules[name];
};
const shader=load("shader"), PM=load("pass-manager"), _R=load("renderer");
const src=`#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){fragColor=vec4(1.0);}`;
function mockGL(){
  let seq=0,drawFB=null,readFB=null;const deleted=[];let failFBO=false, failDraw=false;
  const gl={deleted,programs:[],compiledSources:[],NO_ERROR:0,FRAMEBUFFER_COMPLETE:777,RGBA8:11,RGBA32F:12,RGBA:13,FLOAT:14,UNSIGNED_BYTE:15,
    ARRAY_BUFFER:16,FRAMEBUFFER:17,READ_FRAMEBUFFER:18,READ_FRAMEBUFFER_BINDING:19,COLOR_ATTACHMENT0:20,
    TEXTURE_2D:21,TEXTURE0:22,TEXTURE1:23,TEXTURE2:24,TEXTURE3:25,TEXTURE_MIN_FILTER:26,TEXTURE_MAG_FILTER:27,TEXTURE_WRAP_S:28,TEXTURE_WRAP_T:29,
    NEAREST:30,LINEAR:31,CLAMP_TO_EDGE:32,COLOR_BUFFER_BIT:33,MAX_TEXTURE_SIZE:34,TRIANGLES:35,
    VERTEX_SHADER:36,FRAGMENT_SHADER:37,COMPILE_STATUS:38,LINK_STATUS:39,
    drawingBufferWidth:100,drawingBufferHeight:60,
    createTexture:()=>({type:"tex",id:++seq}),createFramebuffer:()=>({type:"fbo",id:++seq}),
    deleteTexture:x=>deleted.push(x),deleteFramebuffer:x=>deleted.push(x),
    createShader:()=>({type:"shader",id:++seq}),shaderSource:(x,source)=>{x.source=source;gl.compiledSources.push(source);},
    compileShader:x=>x.ok=!x.source.includes("GLSL_ERROR"),getShaderParameter:x=>x.ok,
    getShaderInfoLog:shader=>`ERROR: 0:${shader.source.split("\n").findIndex(line=>line.includes("GLSL_ERROR"))+1}: GLSL_ERROR`,deleteShader:()=>{},
    createProgram:()=>{const p={type:"program",id:++seq};gl.programs.push(p);return p;},attachShader:()=>{},linkProgram:()=>{},getProgramParameter:()=>true,
    getProgramInfoLog:()=>"",deleteProgram:x=>deleted.push(x),
    createVertexArray:()=>({type:"vao",id:++seq}),deleteVertexArray:()=>{},bindVertexArray:()=>{},
    getUniformLocation:(_,name)=>name,useProgram:()=>{},
    getExtension:name=>name==="EXT_color_buffer_float"?{}:null,
    getParameter:name=>name===gl.MAX_TEXTURE_SIZE?4096:name===gl.READ_FRAMEBUFFER_BINDING?readFB:null,
    bindFramebuffer:(target,obj)=>{if(target===gl.FRAMEBUFFER){drawFB=obj;readFB=obj;} else readFB=obj;},
    get boundFramebuffer(){return drawFB;},
    bindTexture:()=>{},activeTexture:()=>{},texImage2D:()=>{},texParameteri:()=>{},
    framebufferTexture2D:()=>{},checkFramebufferStatus:()=>failFBO?0:gl.FRAMEBUFFER_COMPLETE,
    viewport:()=>{},clearColor:()=>{},clear:()=>{},
    uniform1i:()=>{},uniform1f:()=>{},uniform2f:()=>{},uniform3f:()=>{},
    uniform2fv:()=>{},uniform3fv:()=>{},uniform4fv:()=>{},
    drawArrays:()=>{if(failDraw)throw new Error("mock draw failure");},
    readPixels:(x,y,w,h,format,type,out)=>out.fill(type===gl.FLOAT?.5:255),getError:()=>gl.NO_ERROR,
    setFBOFailure:v=>{failFBO=v;},setDrawFailure:v=>{failDraw=v;}
  };return gl;
}
async function main(){
  check(shader.fragment.startsWith("#version 300 es")&&shader.raymarch.includes("MAX_STEPS_CAP"),"AMD GLSL 조립");
  const gl=mockGL(),madePrograms=[],manager=PM.createPassManager(gl,fragment=>{const program={fragment};madePrograms.push(program);return program;});
  manager.setPasses([{name:"A",fragment:src,format:"rgba8",scale:.5,channels:{0:{buffer:"A",frame:"previous"}}}],{0:{buffer:"A",frame:"current"}});
  check(manager.validateConfiguration(manager.getSpecs(),manager.getImageChannels()),"패스 사전 검증");
  const before=JSON.stringify(manager.getSpecs());
  assert.throws(()=>manager.validateConfiguration([{name:"A",fragment:src,channels:{0:{buffer:"A",frame:"current"}}}]),/current/);
  check(JSON.stringify(manager.getSpecs())===before,"잘못된 current 연결은 기존 프로그램 보호");
  manager.ensureTargets(100,60);
  check(manager.getPasses()[0].width===50&&manager.getMemoryBytes()===50*30*4*2,"버퍼 해상도와 GPU 메모리 계산");
  const live=manager.getPasses()[0];gl.setFBOFailure(true);
  assert.throws(()=>manager.ensureTargets(120,60),/Framebuffer/);
  check(manager.getPasses()[0].width===live.width&&manager.getPasses()[0].height===live.height,"FBO 재할당 실패 시 이전 텍스처 보존");
  gl.setFBOFailure(false);manager.ensureTargets(100,60);
  gl.setDrawFailure(true);assert.throws(()=>manager.drawPasses(100,60,()=>{}),/draw failure/);
  check(gl.boundFramebuffer===null,"드로우 오류 후 FBO 바인딩 정리");
  gl.setDrawFailure(false);manager.drawPasses(100,60,()=>{});
  check(manager.readPixel("A",0,0).length===4,"픽셀 읽기와 성공 프레임 처리");
  manager.setPasses([{name:"A",fragment:src},{name:"B",fragment:src}]);manager.ensureTargets(100,60);
  const prior=JSON.stringify(manager.getPasses().map(p=>[p.width,p.height]));
  const status=gl.checkFramebufferStatus;let checks=0;
  gl.checkFramebufferStatus=()=>++checks===3?0:gl.FRAMEBUFFER_COMPLETE;
  assert.throws(()=>manager.ensureTargets(120,70),/Framebuffer/);
  check(JSON.stringify(manager.getPasses().map(p=>[p.width,p.height]))===prior,"두 번째 패스 할당 실패 시 모든 기존 FBO 보존");
  gl.checkFramebufferStatus=status;manager.ensureTargets(120,70);
  check(manager.getPasses().every(p=>p.width===120&&p.height===70),"모든 패스 동시 해상도 적용");
  const getError=gl.getError;gl.getError=()=>1282;
  assert.throws(()=>manager.readPixel("A",0,0),/GPU 픽셀 읽기 실패/);
  gl.getError=getError;check(true,"GPU 픽셀 읽기 오류 감지와 예외 처리");
  const getLocation=gl.getUniformLocation;
  gl.getUniformLocation=()=>{throw new Error("forced uniform location failure");};
  assert.throws(()=>manager.setPassFragment("A",src),/forced uniform/);
  check(gl.deleted.includes(madePrograms.at(-1)),"Uniform 위치 조회 실패 시 단일 패스 프로그램 누수 방지");
  assert.throws(()=>manager.setPasses([{name:"A",fragment:src}]),/forced uniform/);
  check(gl.deleted.includes(madePrograms.at(-1)),"Uniform 위치 조회 실패 시 전체 패스 신규 프로그램 누수 방지");
  manager.onLost();assert.throws(()=>manager.restore(),/forced uniform/);
  check(gl.deleted.includes(madePrograms.at(-1)),"Context 복구 중 Uniform 위치 조회 실패 시 프로그램 누수 방지");
  gl.getUniformLocation=getLocation;
  manager.dispose();
  const gl2=mockGL(), raf=[];
  const eventListeners = new Map();
  const canvas={width:100,height:60,clientWidth:100,clientHeight:60,
    getContext:kind=>kind==="webgl2"?gl2:null,
    addEventListener:(k,v)=>eventListeners.set(k,v),removeEventListener:k=>eventListeners.delete(k)};
  const doc={hidden:false,addEventListener:()=>{},removeEventListener:()=>{},
    createElement:tag=>tag==="canvas"?{width:0,height:0,getContext:()=>({putImageData:()=>{}}),toBlob:cb=>cb(new Blob(["test"],{type:"image/png"}))}:null};
  const fakeImageData=class {constructor(data,w,h){this.data=data;this.width=w;this.height=h;}};
  const rendererSource=fs.readFileSync(path.join(root,"js/renderer.js"),"utf8");
  let Renderer;
  const texEvents={lost:0,restore:0,dispose:0};
  const textureModule={createTextureInput:gl=>{
    const store=load("texture-input").createTextureInput(gl);
    return {...store,onLost:()=>{texEvents.lost++;store.onLost();},restore:()=>{texEvents.restore++;store.restore();},
      dispose:()=>{texEvents.dispose++;store.dispose();}};
  }};
  vm.runInNewContext(rendererSource,{define:(deps,fac)=>Renderer=fac(PM,textureModule,load("gpu-diagnostics"),load("keyboard-input"),load("media-input"),load("ramp"),load("glsl-prepare")),document:doc,window:{devicePixelRatio:1},
    console,requestAnimationFrame:cb=>{raf.push(cb);return raf.length;},cancelAnimationFrame:()=>{},ImageData:fakeImageData,
    Uint8Array,Uint8ClampedArray,Float32Array,Blob,Map,Set,Object,Array,Number,Math,Error,TypeError,RangeError},
    {filename:"renderer.js"});
  const r=Renderer.createRenderer(canvas,shader);
  const createGPUProgram=gl2.createProgram, oldGPULocation=gl2.getUniformLocation;let lastGPUProgram;
  gl2.createProgram=()=>lastGPUProgram=createGPUProgram();
  gl2.getUniformLocation=()=>{throw new Error("forced image uniform location failure");};
  const initialImage=r.getFragmentSource();assert.throws(()=>r.setFragment(src),/forced image uniform/);
  check(gl2.deleted.includes(lastGPUProgram) && r.getFragmentSource()===initialImage,
    "Image Uniform 위치 조회 실패 시 신규 GPU 프로그램 해제 및 기존 소스 유지");
  gl2.getUniformLocation=oldGPULocation;gl2.createProgram=createGPUProgram;
  r.setPasses([{name:"A",fragment:src,format:"rgba8",scale:1,channels:{0:{buffer:"A",frame:"previous"}}}],{0:{buffer:"A",frame:"current"}});
  r.defineUniform("uSharedGain","float",.75);
  check(gl2.compiledSources.some(text=>text.includes("uniform float uSharedGain;")&&text.includes("out vec4 fragColor")),"사용자 Uniform 선언이 Buffer GLSL에도 적용됨");
  // 삽입된 Uniform 줄이 GPU 오류 번호를 밀어도 원본 위치로 복원할 수 있어야 한다.
  const invalid=`#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){GLSL_ERROR}`;
  const diagnostic=source=>{try{r.validateFragment(source);}catch(error){return error;}throw new Error("컴파일 오류가 발생하지 않음");};
  const rawLine=error=>Number(/ERROR: 0:(\d+):/.exec(error.message)?.[1]);
  const shifted=diagnostic(invalid), shift=shifted.glslInjected;
  check(shift?.after===2&&shift.count===1&&rawLine(shifted)===5&&rawLine(shifted)-shift.count===4,"자동 Uniform 컴파일 오류 원본 줄 보정");
  const explicit=diagnostic(invalid.replace("out vec4 fragColor;","uniform float uSharedGain;\nout vec4 fragColor;"));
  check(!explicit.glslInjected&&rawLine(explicit)===5,"GLSL에 Uniform 직접 선언 시 번호 보정하지 않음");
  const priorBuffer=r.getPassDefinitions()[0].fragment;let bufferError;
  try{r.setPassFragment("A",invalid);}catch(error){bufferError=error;}
  check(bufferError?.glslInjected?.count===1&&r.getPassDefinitions()[0].fragment===priorBuffer,"Buffer 진단 정보 전달 및 컴파일 롤백");
  r.removeUniform("uSharedGain");
  r.setPassFragment("A",src.replace("out vec4 fragColor;","uniform int uConflict;\nout vec4 fragColor;"));
  assert.throws(()=>r.defineUniform("uConflict","float",.5),/선언/);
  check(!r.getUserUniforms().some(x=>x.name==="uConflict"),"Uniform 선언 타입 충돌 시 등록 롤백");
  const old=r.getPassDefinitions();
  assert.throws(()=>r.setPassFragment("A",src+" GLSL_ERROR"),/컴파일/);
  check(r.getPassDefinitions()[0].fragment===old[0].fragment,"버퍼 GLSL 컴파일 실패 시 기존 소스 유지");
  assert.throws(()=>r.setFragment(src+" GLSL_ERROR"),/컴파일/);
  check(r.getFragmentSource()===shader.fragment,"Image GLSL 컴파일 실패 시 기존 프로그램 유지");
  assert.throws(()=>r.validatePassConfiguration([{name:"A",fragment:src,channels:{0:{buffer:"A",frame:"current"}}}]),/current/);
  check(r.getPassDefinitions()[0].fragment===old[0].fragment,"렌더러 패스 정의 원자적 사전 검증");
  const promise=r.captureScreenshot();check(r.getStats().running,"일시정지 상태에서 캡처 프레임 시작");
  while(raf.length){const fn=raf.shift();fn(100);if(!r.getStats().running)break;}
  const blob=await promise;
  check(blob.type==="image/png"&&!r.getStats().running,"PNG 캡처 후 일시정지 상태 복귀");
  const cancelled=r.captureScreenshot();r.stop();
  await assert.rejects(cancelled,/캡처가 취소/);
  check(!r.getStats().running,"캡처 대기 중 렌더러 정지 시 Promise 거부");
  let prevented=false;eventListeners.get("webglcontextlost")({preventDefault(){prevented=true;}});
  check(prevented&&texEvents.lost===1&&texEvents.dispose===0,"Context Loss에서 CPU 이미지 저장소 유지");
  eventListeners.get("webglcontextrestored")();
  check(texEvents.restore===1,"복구 시 Texture 재생성 실행");
  // Architecture Freeze: Pack 가져오기 전 GLSL/Uniform 전체를 사전 검사한다.
  const packScene={image:src,passes:[{name:"A",fragment:src,format:"rgba8",scale:1,channels:{}}],imageChannels:{}};
  const packUsers=[{name:"uPackGain",type:"float",value:.4,options:{min:0,max:1,step:.1}}];
  const sourceBefore=r.getFragmentSource(),usersBefore=JSON.stringify(r.getUserUniforms());
  check(r.validatePortable(packScene,packUsers),"Pack 사전 검사 성공");
  check(r.getFragmentSource()===sourceBefore&&JSON.stringify(r.getUserUniforms())===usersBefore,"Pack 사전 검사는 실행 상태를 변경하지 않음");
  assert.throws(()=>r.validatePortable(packScene,[...packUsers,...packUsers]),/이름/);
  assert.throws(()=>r.validatePortable(packScene,[{...packUsers[0],value:Infinity}]),/Uniform/);
  check(JSON.stringify(r.getUserUniforms())===usersBefore,"중복 이름과 유효하지 않은 값 사전 거부");
  const badPack={...packScene,passes:[{name:"A",fragment:src+" GLSL_ERROR",channels:{}}]};
  assert.throws(()=>r.applyPortable(badPack,packUsers),/컴파일/);
  check(r.getFragmentSource()===sourceBefore&&JSON.stringify(r.getUserUniforms())===usersBefore,"잘못된 Pack의 GLSL은 이전 상태 유지");
  check(r.applyPortable(packScene,packUsers),"Image/Buffer/Uniform 동시 적용");
  check(r.getFragmentSource()===src&&r.getUserUniforms().length===1&&r.getUserUniforms()[0].name==="uPackGain", "Pack User Uniform 교체");
  const typeScene={...packScene,image:src.replace("out vec4 fragColor;","uniform int uPackGain;\nout vec4 fragColor;")};
  assert.throws(()=>r.validatePortable(typeScene,packUsers),/선언/);
  check(r.getFragmentSource()===src&&r.getUserUniforms()[0].value===.4,"GLSL/Uniform 타입 충돌 시 현재 프로젝트 보존");
  const getLink=gl2.getProgramParameter;let links=0;
  gl2.getProgramParameter=(...args)=>{links++;return links===2?false:getLink(...args);};
  const lastUsers=JSON.stringify(r.getUserUniforms()),beforeImage=r.getFragmentSource(),livePrograms=gl2.programs.filter(p=>!gl2.deleted.includes(p));
  assert.throws(()=>r.applyPortable(packScene,[{name:"uAlternate",type:"float",value:0.8}]),/Program 링크 실패/);
  gl2.getProgramParameter=getLink;
  check(JSON.stringify(r.getUserUniforms())===lastUsers && r.getFragmentSource()===beforeImage,
    "Pack 적용 중 Buffer 실패 시 사용자 Uniform과 Image 소스 롤백");
  check(livePrograms.every(p=>!gl2.deleted.includes(p)) && links===2,
    "실패 시 기존 GPU 프로그램을 삭제하거나 재컴파일하지 않음");
  r.dispose();check(texEvents.dispose===1,"Renderer 폐기 시에만 CPU 이미지 해제");
  // DOM 계약 검사: 코드에서 직접 참조하는 정적 ID가 실제 HTML에 존재해야 한다.
  const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
  for(const key of ["screenshotButton","studioUndo","studioRedo","studioDuplicate","studioRun","openBufferViewer","studioDraft"])check(html.includes(`id="${key}"`),`UI 요소 ${key}`);
  console.log(`검증 완료: ${passed}개 API/구조 회귀 테스트 통과`);
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={mockGL};
