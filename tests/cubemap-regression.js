require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/cubemap-regression.js — 이미지 한 장 → 6면 큐브맵 규칙(js/cubemap.js)
//  · 비율로 배치를 알아본다(4:3 · 3:4 십자, 6:1 · 1:6 띠, 2:1 파노라마) · 면 방향은 OpenGL 큐브맵 규칙
//  · 등장방형 파노라마에서 뽑은 면이 그 방향의 색을 가진다
// 실제 samplerCube 샘플링은 tests/cubemap-browser-regression.js가 본다.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","js",file),"utf8"),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const C=load("cubemap.js");
let passed=0;const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};
const close=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<1e-9);

test("배치: 비율로 알아보고 면 위치(+X -X +Y -Y +Z -Z)를 정한다",()=>{
  const cross=C.layoutOf(1024,768);
  assert.equal(cross.kind,"cross");assert.equal(cross.size,256);
  assert.deepEqual(cross.faces.map(f=>[f.x/256,f.y/256]),[[2,1],[0,1],[1,0],[1,2],[1,1],[3,1]]);
  const vertical=C.layoutOf(300,400);
  assert.equal(vertical.kind,"cross-vertical");assert.deepEqual(vertical.faces[5],{x:100,y:300,rotate:180},"세로 십자의 -Z는 180° 돌려 놓였다");
  assert.equal(C.layoutOf(600,100).kind,"strip");assert.equal(C.layoutOf(100,600).kind,"strip-vertical");
  const pano=C.layoutOf(4096,2048);assert.equal(pano.kind,"equirect");assert.equal(pano.size,1024,"면 크기는 너비/4, 최대 1024");
  assert.equal(C.layoutOf(500,500).kind,null);assert.match(C.layoutOf(500,500).reason,/쓸 수 없는 비율/);
});
test("면 방향: 각 면의 가운데는 그 축, 위쪽 줄(t = 0)은 OpenGL 규칙",()=>{
  const axes=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  axes.forEach((axis,face)=>assert(close(C.faceDirection(face,0.5,0.5),axis),`면 ${C.FACES[face]} 가운데`));
  assert(close(C.faceDirection(0,0.5,0),[1,1,0]),"+X 면의 위쪽 = +Y 쪽");
  assert(close(C.faceDirection(4,1,0.5),[1,0,1]),"+Z 면의 오른쪽 = +X 쪽");
  assert(close(C.faceDirection(2,0.5,1),[0,1,1]),"+Y 면의 아래쪽 = +Z 쪽");
});
test("등장방형: -Z가 가운데, +X는 u = 0.75, 위는 v = 0",()=>{
  assert(close(C.equirectUV([0,0,-1]),[0.5,0.5]));
  assert(close(C.equirectUV([1,0,0]),[0.75,0.5]));
  assert(close(C.equirectUV([0,1,0]).slice(1),[0]));
  assert(close(C.equirectUV([0,-2,0]).slice(1),[1]),"길이와 무관");
});
test("등장방형에서 뽑은 면: 8×4 파노라마를 위 · 아래 · 네 방향으로 칠하면 면 가운데가 그 색",()=>{
  const w=8,h=4,px=new Uint8ClampedArray(w*h*4);
  // 열(각 1/8): 방향이 열 경계에 오지 않게 방향마다 두 열 — -X는 u = 0.25(열 1 · 2), -Z는 0.5(3 · 4), +X는 0.75(5 · 6),
  // +Z는 0 · 1(7 · 0). 줄 0 = 위(+Y), 줄 3 = 아래(-Y)
  const Z=[255,0,0],NX=[0,255,255],NZ=[255,255,0],X=[255,0,255];
  const colorOf=(x,y)=>y===0?[0,255,0]:y===3?[0,0,255]:[Z,NX,NX,NZ,NZ,X,X,Z][x];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const c=colorOf(x,y);px.set([...c,255],(y*w+x)*4);}
  const center=face=>{const size=8,f=C.equirectFace(px,w,h,face,size),i=(4*size+4)*4;return [f[i],f[i+1],f[i+2]];};
  const near=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<70);
  assert(near(center(0),[255,0,255]),`+X: ${center(0)}`);
  assert(near(center(1),[0,255,255]),`-X: ${center(1)}`);
  assert(near(center(2),[0,255,0]),`+Y: ${center(2)}`);
  assert(near(center(3),[0,0,255]),`-Y: ${center(3)}`);
  assert(near(center(4),[255,0,0]),`+Z: ${center(4)}`);
  assert(near(center(5),[255,255,0]),`-Z: ${center(5)}`);
});
test("Pack · 프로젝트: 큐브맵 채널이 쓰는 이미지도 이미지 자원으로 센다(담기 · id 바꾸기 · 없는 이미지 정리)",()=>{
  const modules={};
  const loadDeps=name=>{if(modules[name])return modules[name];vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","js",name+".js"),"utf8"),{console,define:(deps,factory)=>{modules[name]=factory(...deps.map(loadDeps));}},{filename:name+".js"});return modules[name];};
  const Pack=loadDeps("studio-pack"),Model=loadDeps("project-model");
  const project={image:"x",passes:[{name:"A",fragment:"y",format:"rgba8",scale:1,channels:{0:{cubemap:"tex1"},1:{texture:"tex2"}}}],imageChannels:{0:{cubemap:"tex3"}}};
  assert.deepEqual(Pack.textureIds(project),["tex1","tex2","tex3"]);
  const moved=Pack.remapTextures(Model.copy(project),new Map([["tex1","tex9"],["tex2","tex8"],["tex3","tex7"]]));
  assert.deepEqual([moved.passes[0].channels[0],moved.imageChannels[0]],[{cubemap:"tex9"},{cubemap:"tex7"}]);
  const trimmed=Model.copy(project);
  assert.equal(Model.detachMissing(trimmed,new Set(["tex2"])),2);
  assert.deepEqual(Object.keys(trimmed.passes[0].channels),["1"]);
});
console.log(`Cubemap: ${passed} passed`);
