require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/sampling-regression.js — 샘플러 상태, 저장, 복구, 실패 롤백.
"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const root=path.resolve(__dirname,"..");let api,serial=0,bound=null,errorCode=0,live=0;
const uploads=[],params=[],deleted=[],records=new Map();
const gl={};
for(const key of ["MAX_TEXTURE_SIZE","TEXTURE_BINDING_2D","TEXTURE_2D","RGBA","UNSIGNED_BYTE","TEXTURE_MIN_FILTER","TEXTURE_MAG_FILTER","TEXTURE_WRAP_S","TEXTURE_WRAP_T","LINEAR","NEAREST","CLAMP_TO_EDGE","REPEAT","MIRRORED_REPEAT"]) gl[key]=key;
gl.NO_ERROR=0;gl.getError=()=>{const out=errorCode;errorCode=0;return out;};
gl.getParameter=key=>key===gl.MAX_TEXTURE_SIZE?4096:bound;
gl.createTexture=()=>({id:++serial});gl.deleteTexture=tex=>deleted.push(tex);
gl.bindTexture=(_,tex)=>{bound=tex;};gl.texImage2D=()=>uploads.push(bound);
gl.texParameteri=(_,key,value)=>params.push({tex:bound,key,value});
const fakeIDB={open:()=>{
  const req={result:{createObjectStore:()=>{},close:()=>{},transaction:()=>{
    const tx={objectStore:()=>({
      put:record=>{const result={};queueMicrotask(()=>{records.set(record.id,record);tx.oncomplete?.();});return result;},
      getAll:()=>{const result={};queueMicrotask(()=>{result.result=[...records.values()];tx.oncomplete?.();});return result;},
      delete:id=>{const result={};queueMicrotask(()=>{records.delete(id);tx.oncomplete?.();});return result;}
    })};return tx;
  }}};
  queueMicrotask(()=>{req.onupgradeneeded?.();req.onsuccess?.();});return req;
}};
vm.runInNewContext(fs.readFileSync(path.join(root,"js/texture-input.js"),"utf8"),{
  define:(_,factory)=>api=factory(),window:{indexedDB:fakeIDB},indexedDB:fakeIDB,
  createImageBitmap:async file=>({width:file.width,height:file.height,close:()=>{}}),console
});
const file={type:"image/png",name:"tile.png",size:30,width:3,height:5};
(async()=>{
  const store=api.createTextureInput(gl);
  const {id,saved}=await store.add(file);assert.equal(saved,true);
  assert.equal(store.list()[0].sampling.filter,"linear");
  assert.equal(store.list()[0].sampling.wrapT,"clamp");
  assert.equal(params.at(-1).value,gl.CLAMP_TO_EDGE);
  const tex=store.get(id).tex,created=serial,uploadCount=uploads.length;
  const result=await store.setSampling(id,{filter:"nearest",wrapS:"repeat",wrapT:"mirror"});
  assert.equal(result.saved,true);assert.equal(serial,created);assert.equal(uploads.length,uploadCount);
  assert.equal(store.get(id).tex,tex);assert.equal(bound,null);
  assert.equal(params.findLast(p=>p.key===gl.TEXTURE_MAG_FILTER).value,gl.NEAREST);
  assert.equal(params.findLast(p=>p.key===gl.TEXTURE_WRAP_S).value,gl.REPEAT);
  assert.equal(params.findLast(p=>p.key===gl.TEXTURE_WRAP_T).value,gl.MIRRORED_REPEAT);
  assert.equal(records.get(id).sampling.wrapS,"repeat");
  await assert.rejects(store.setSampling(id,{wrapS:"invalid"}),/올바르지/);
  assert.equal(store.get(id).sampling.wrapS,"repeat");
  // 이전 호출이 남긴 오류는 무시하고, 샘플러 적용 중 발생한 오류만 실패로 판단해야 한다.
  errorCode=1282; assert.equal((await store.setSampling(id,{filter:"nearest"})).saved,true);
  const texParameteri=gl.texParameteri;gl.texParameteri=(...args)=>{errorCode=1280;texParameteri(...args);};
  await assert.rejects(store.setSampling(id,{filter:"linear"}),/적용 실패/);gl.texParameteri=texParameteri;errorCode=0;
  assert.equal(store.get(id).sampling.filter,"nearest");
  store.onLost(); store.restore();assert.notEqual(store.get(id).tex,tex);
  assert.equal(params.findLast(p=>p.key===gl.TEXTURE_WRAP_T).value,gl.MIRRORED_REPEAT);
  store.dispose();
  const restored=api.createTextureInput(gl);
  assert.equal(await restored.restoreSaved(),true);
  assert.equal(restored.list()[0].sampling.wrapS,"repeat");
  assert.equal(restored.list()[0].sampling.filter,"nearest");
  // 과거 DB 레코드는 샘플링 필드가 없으므로 기본값으로 복구되어야 한다.
  records.set("tex90",{id:"tex90",blob:file,name:file.name});
  restored.dispose();const legacy=api.createTextureInput(gl);
  assert.equal(await legacy.restoreSaved(),true);
  assert.equal(legacy.get("tex90").sampling.wrapS,"clamp");
  assert.equal(legacy.get("tex90").sampling.filter,"linear");
  const html=fs.readFileSync(path.join(root,"js/studio.js"),"utf8");
  assert(html.includes("studio-sampling") && html.includes("renderer.setTextureSampling"));
  const renderer=fs.readFileSync(path.join(root,"js/renderer.js"),"utf8");
  assert(renderer.includes("setTextureSampling, getPasses:"));
  legacy.dispose();console.log("PASS sampling: default / GPU sampler / no reupload / validation / rollback / restore / legacy / UI");
})().catch(e=>{console.error(e);process.exitCode=1;});
