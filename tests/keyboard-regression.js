require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/keyboard-regression.js — 키보드 입력 채널: 키 상태 규칙, 채널 검증·바인딩, 고르기 팝오버의 키보드 항목.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const root=path.resolve(__dirname,"../js"),modules={};
const load=name=>{
  if(modules[name])return modules[name];
  vm.runInNewContext(fs.readFileSync(path.join(root,name+".js"),"utf8"),{
    define:(deps,factory)=>modules[name]=factory(...deps.map(load)),console:{warn:()=>{}},window:{indexedDB:null},
    indexedDB:null,Uint8Array,Float32Array,Array,Map,Set,Number,Math,Error,TypeError,Promise,Object,JSON,String
  },{filename:name+".js"});return modules[name];
};
let passed=0;
const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};
const K=load("keyboard-input");

test("키 상태: 누름(y=0) · 이번 프레임에 눌림(y=1) · 토글(y=2)",()=>{
  const s=K.createState();
  assert.equal(s.setKey(37,true),true);
  assert.deepEqual([s.read(37,0),s.read(37,1),s.read(37,2)],[1,1,1]);
  s.endFrame();assert.deepEqual([s.read(37,0),s.read(37,1),s.read(37,2)],[1,0,1],"한 프레임 뒤 y=1만 지워짐");
  assert.equal(s.setKey(37,true),false,"자동 반복(같은 키 계속 누름)은 다시 '눌림'을 켜지 않음");assert.equal(s.read(37,1),0);
  s.setKey(37,false);assert.deepEqual([s.read(37,0),s.read(37,2)],[0,1],"떼도 토글은 유지");
  s.setKey(37,true);assert.equal(s.read(37,2),0,"다시 누르면 토글 꺼짐");
});
test("키 상태: 범위 밖 키 코드는 무시하고, 모두 떼기는 토글을 남긴다",()=>{
  const s=K.createState();
  for(const code of [0,256,-1,1.5,NaN,undefined])assert.equal(s.setKey(code,true),false);
  s.setKey(65,true);s.setKey(32,true);s.releaseAll();
  assert.deepEqual([s.read(65,0),s.read(65,1),s.read(65,2),s.read(32,2)],[0,0,1,1]);
  assert.equal(K.WIDTH,256);assert.equal(K.HEIGHT,3);
});
test("키 상태: 바뀐 프레임에만 다시 올린다(dirty)",()=>{
  const s=K.createState();assert.equal(s.takeDirty(),true);assert.equal(s.takeDirty(),false);
  s.setKey(40,true);assert.equal(s.takeDirty(),true);s.endFrame();assert.equal(s.takeDirty(),true,"눌림 행을 지운 프레임");
  s.endFrame();assert.equal(s.takeDirty(),false,"바뀐 것이 없으면 올리지 않음");
});

// 모의 GL: 키보드 텍스처가 채널에 묶이는지 본다
const gl={};let seq=0,active=0;const bindings=new Map(),sizes=[],uploads=[];
for(const k of ["MAX_TEXTURE_SIZE","TEXTURE_2D","TEXTURE0","TEXTURE1","TEXTURE2","TEXTURE3","RGBA","RED","R8","UNSIGNED_BYTE","UNPACK_ALIGNMENT","TEXTURE_MIN_FILTER","TEXTURE_MAG_FILTER","TEXTURE_WRAP_S","TEXTURE_WRAP_T","NEAREST","LINEAR","CLAMP_TO_EDGE","FRAMEBUFFER","COLOR_ATTACHMENT0","FRAMEBUFFER_COMPLETE","TRIANGLES","RGBA8"])gl[k]=k;
gl.NO_ERROR=0;gl.getError=()=>0;gl.getParameter=key=>key===gl.MAX_TEXTURE_SIZE?4096:null;
gl.createTexture=()=>({id:++seq});gl.deleteTexture=()=>{};gl.bindTexture=(target,tex)=>{if(target===gl.TEXTURE_2D)bindings.set(active,tex);};
gl.activeTexture=unit=>active=[gl.TEXTURE0,gl.TEXTURE1,gl.TEXTURE2,gl.TEXTURE3].indexOf(unit);
gl.texImage2D=(...a)=>uploads.push(["image",a[2],a[3],a[4]]);gl.texSubImage2D=(...a)=>uploads.push(["sub",a[4],a[5]]);gl.texParameteri=()=>{};gl.pixelStorei=()=>{};
gl.createFramebuffer=()=>({id:++seq});gl.deleteFramebuffer=()=>{};gl.deleteProgram=()=>{};gl.bindFramebuffer=()=>{};gl.framebufferTexture2D=()=>{};gl.drawBuffers=()=>{};
gl.checkFramebufferStatus=()=>gl.FRAMEBUFFER_COMPLETE;gl.viewport=()=>{};gl.clearColor=()=>{};gl.clear=()=>{};
gl.getUniformLocation=(_,key)=>key;gl.useProgram=()=>{};gl.uniform1i=()=>{};gl.uniform3f=(name,x,y,z)=>sizes.push([name,x,y,z]);gl.uniform1fv=()=>{};
let drawn=[];gl.drawArrays=()=>drawn.push([bindings.get(0),bindings.get(1)]);
const textures={get:()=>null,list:()=>[]};
const frag="#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){fragColor=vec4(1.);}";
test("채널 검증: {keyboard:true}만 허용, 키보드 텍스처를 묶고 크기 256×3을 알린다",()=>{
  const keyboard=K.create(gl),PM=load("pass-manager"),manager=PM.createPassManager(gl,source=>({source}),textures,keyboard);
  manager.setPasses([{name:"A",fragment:frag,format:"rgba8",scale:1,channels:{1:{keyboard:true}}}],{0:{keyboard:true}});
  assert.equal(manager.usesKeyboard(),true);
  manager.ensureTargets(64,64);drawn=[];manager.drawPasses(64,64,()=>{});
  const tex=keyboard.texture();assert.strictEqual(drawn[0][1],tex,"A.iChannel1에 키보드 텍스처");
  assert(sizes.some(x=>x[0]==="iChannelResolution[1]"&&x[1]===256&&x[2]===3));
  assert(uploads.some(u=>u[0]==="image"&&u[1]==="R8"&&u[2]===256&&u[3]===3),"R8 256×3 텍스처");
  keyboard.setKey(32,true);uploads.length=0;keyboard.upload();assert.equal(uploads.length,1,"바뀌면 올림");keyboard.upload();assert.equal(uploads.length,1,"그대로면 안 올림");
  for(const bad of [{keyboard:false},{keyboard:true,frame:"current"},{keyboard:"yes"}])
    assert.throws(()=>manager.setPasses([{name:"A",fragment:frag,format:"rgba8",scale:1,channels:{0:bad}}],{}),Error,JSON.stringify(bad));
  manager.setPasses([{name:"A",fragment:frag,format:"rgba8",scale:1,channels:{}}],{});assert.equal(manager.usesKeyboard(),false);
  const plain=PM.createPassManager(gl,source=>({source}),textures);
  assert.throws(()=>plain.setPasses([],{0:{keyboard:true}}),/키보드/,"키보드가 없는 렌더러는 거부");
});
test("고르기 팝오버 값: keyboard ↔ {keyboard:true}",()=>{
  const P=load("channel-picker");
  assert.equal(P.valueOf({keyboard:true}),"keyboard");assert.deepEqual(P.refOf("keyboard"),{keyboard:true});
  assert.deepEqual(P.refOf(P.valueOf({buffer:"A",frame:"previous",attachment:1})),{buffer:"A",frame:"previous",attachment:1});
});
test("Pack 저장·열기에서 키보드 연결이 그대로 남는다",()=>{
  const Pack=load("studio-pack");
  const project={image:frag,passes:[{name:"A",fragment:frag,format:"rgba8",scale:1,channels:{1:{keyboard:true},0:{buffer:"A",frame:"previous"}}}],imageChannels:{2:{keyboard:true}}};
  const {project:back}=Pack.parse(Pack.encode({project,selected:"Image",textures:[]}));
  assert.deepEqual(back.passes[0].channels[1],{keyboard:true});assert.deepEqual(back.imageChannels[2],{keyboard:true});
  assert.deepEqual(Pack.withoutTextures(back).imageChannels[2],{keyboard:true},"이미지만 빼고 키보드는 남김");
});
console.log(`Keyboard: ${passed} passed`);
