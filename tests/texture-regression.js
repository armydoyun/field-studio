require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/texture-regression.js — Texture 입력과 채널 수명 모의 GPU 검사.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const root=path.resolve(__dirname,"../js"),modules={};let closed=0;
const load=name=>{
  if(modules[name])return modules[name];
  vm.runInNewContext(fs.readFileSync(path.join(root,name+".js"),"utf8"),{
    define:(deps,factory)=>modules[name]=factory(...deps.map(load)),console:{warn:()=>{}},window:{indexedDB:null},
    createImageBitmap:async file=>({width:file.width,height:file.height,close:()=>closed++}),
    indexedDB:null,Float32Array,Array,Map,Set,Number,Math,Error,TypeError,Promise
  },{filename:name+".js"});return modules[name];
};
const gl={}; let seq=0,active=0,program=null;const bindings=new Map(),draws=[],sizes=[];
for(const key of ["MAX_TEXTURE_SIZE","TEXTURE_BINDING_2D","TEXTURE_2D","TEXTURE0","TEXTURE1","TEXTURE2","TEXTURE3","RGBA","UNSIGNED_BYTE","TEXTURE_MIN_FILTER","TEXTURE_MAG_FILTER","TEXTURE_WRAP_S","TEXTURE_WRAP_T","LINEAR","CLAMP_TO_EDGE","FRAMEBUFFER","COLOR_ATTACHMENT0","RGBA8","COLOR_BUFFER_BIT","FRAMEBUFFER_COMPLETE","TRIANGLES"])gl[key]=key;
gl.NO_ERROR=0;gl.getError=()=>0;gl.getParameter=key=>key===gl.MAX_TEXTURE_SIZE?4096:bindings.get(active)||null;
gl.createTexture=()=>({id:++seq});gl.deleteTexture=()=>{};
gl.bindTexture=(_,tex)=>bindings.set(active,tex);gl.activeTexture=unit=>active=[gl.TEXTURE0,gl.TEXTURE1,gl.TEXTURE2,gl.TEXTURE3].indexOf(unit);
gl.texImage2D=()=>{};gl.texParameteri=()=>{};
gl.createFramebuffer=()=>({id:++seq});gl.deleteFramebuffer=()=>{};gl.deleteProgram=()=>{};gl.bindFramebuffer=()=>{};gl.framebufferTexture2D=()=>{};
gl.checkFramebufferStatus=()=>gl.FRAMEBUFFER_COMPLETE;gl.viewport=()=>{};gl.clearColor=()=>{};gl.clear=()=>{};
gl.getUniformLocation=(_,key)=>key;gl.useProgram=p=>program=p;gl.uniform1i=()=>{};gl.uniform3f=(name,x,y,z)=>sizes.push([name,x,y,z]);
gl.drawArrays=()=>draws.push({program,texture:bindings.get(0)});
(async()=>{
  const textures=load("texture-input").createTextureInput(gl);
  await assert.rejects(textures.add({type:"image/gif",size:10,name:"bad.gif"}),/PNG/);
  const input={type:"image/png",size:100,name:"test.png",width:16,height:8};
  const added=await textures.add(input);assert.equal(added.id,"tex1");assert.equal(added.saved,false);
  assert.equal(textures.list()[0].name,"test.png");
  const firstTex=textures.get("tex1").tex;
  const PM=load("pass-manager"),manager=PM.createPassManager(gl,source=>({source}),textures);
  const frag="#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){fragColor=vec4(1.);}";
  const passes=[{name:"A",fragment:frag,format:"rgba8",scale:1,channels:{0:{texture:"tex1"}}}];
  manager.setPasses(passes,{0:{texture:"tex1"}});manager.ensureTargets(80,50);manager.drawPasses(80,50,()=>{});
  assert.strictEqual(draws[0].texture,firstTex);assert(sizes.some(x=>x[0]==="iChannelResolution[0]"&&x[1]===16&&x[2]===8));
  manager.bindImage(PM.makeLocations(gl,"image-program"));assert.strictEqual(bindings.get(0),firstTex);manager.unbindImage();
  assert.throws(()=>manager.setImageChannels({1:{texture:"missing"}}),/존재하지 않는 이미지/);
  assert.throws(()=>manager.setPassChannels("A",{0:{buffer:"A",frame:"current"}}),/current/);
  textures.onLost();textures.restore();assert.notStrictEqual(textures.get("tex1").tex,firstTex);
  manager.detachTexture("tex1");assert.equal(Object.keys(manager.getImageChannels()).length,0);
  assert.equal(Object.keys(manager.getSpecs()[0].channels).length,0);
  await textures.remove("tex1");assert.equal(textures.list().length,0);assert.equal(closed,1);
  manager.dispose();textures.dispose();
  // 가상 IndexedDB로 파일 Blob 영속화 및 새로운 Renderer 세션의 자동 복원을 확인한다.
  const records=new Map(),fakeIDB={open:()=>{
    const req={result:{createObjectStore:()=>{},close:()=>{},transaction:()=>{
      const tx={objectStore:()=>({
        put:record=>{const out={};queueMicrotask(()=>{records.set(record.id,record);tx.oncomplete?.();});return out;},
        getAll:()=>{const out={};queueMicrotask(()=>{out.result=[...records.values()];tx.oncomplete?.();});return out;},
        delete:id=>{const out={};queueMicrotask(()=>{records.delete(id);tx.oncomplete?.();});return out;}
      })};return tx;}}};
    queueMicrotask(()=>{req.onupgradeneeded?.();req.onsuccess?.();});return req;
  }};
  let api;vm.runInNewContext(fs.readFileSync(path.join(root,"texture-input.js"),"utf8"),{
    define:(_,factory)=>api=factory(),window:{indexedDB:fakeIDB},indexedDB:fakeIDB,
    createImageBitmap:async file=>({width:file.width,height:file.height,close:()=>{}}),console
  });
  const first=api.createTextureInput(gl);const saved=await first.add(input);
  assert.equal(saved.saved,true);assert.equal(records.size,1);first.dispose();
  const fresh=api.createTextureInput(gl);assert.equal(await fresh.restoreSaved(),true);
  assert.equal(fresh.list().length,1);assert.equal(fresh.list()[0].id,saved.id);
  await fresh.remove(saved.id);assert.equal(records.size,0);fresh.dispose();
  const html=fs.readFileSync(path.resolve(__dirname,"../index.html"),"utf8");
  for(const id of ["studioTextureFile","studioTextureAdd","studioTextureList"]) assert(html.includes(`id="${id}"`));
  console.log("PASS: 이미지 검증 / 등록 / 연결 / 해상도 / 오류 / 복구 / 삭제 / UI ID");
})().catch(error=>{console.error(error);process.exitCode=1;});
