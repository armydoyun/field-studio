require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/gallery-perf-regression.js — 갤러리 성능 배지 계산(gallery-perf.js): 단계 경계, 패스 픽셀 수, 1080p 어림값,
// 소프트웨어 렌더러 판별, 측정기(가짜 GL·가짜 시계)가 처음 두 번을 버리고 작은 값을 쓰는지.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
let Perf;
vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../js/gallery-perf.js"),"utf8"),{define:(deps,factory)=>Perf=factory(),Math,Number,Object,Array,Uint8Array,Infinity,performance:{now:()=>0}},{filename:"gallery-perf.js"});
let passed=0;const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};
test("단계 경계: 4 · 12 · 33ms",()=>{
  assert.deepEqual([0,3.99,4,11.9,12,32.9,33,500].map(ms=>Perf.levelOf(ms).id),["light","light","medium","medium","heavy","heavy","extreme","extreme"]);
});
test("패스 픽셀 수: Image = 1080p 전체, scale은 제곱, 고정 크기는 그대로",()=>{
  assert.equal(Perf.passPixels({}),1920*1080);assert.equal(Perf.passPixels({scale:0.5}),1920*1080/4);assert.equal(Perf.passPixels({size:[512,512],scale:0.25}),512*512);
});
test("1080p 어림값: 고정 비용을 빼고 픽셀 비율로 늘려 패스를 더한다",()=>{
  const ms=Perf.estimateFrameMs([{ms:1.1,measured:1000,pixels:4000},{ms:0.05,measured:1000,pixels:1000},{ms:0.6,measured:1000,pixels:500}],0.1);
  assert(Math.abs(ms-(4+0+0.25))<1e-9,ms);
});
test("배지 설명: 단계 이름과 1080p 시간·fps",()=>{
  const d=Perf.describe(8);assert.equal(d.level,"medium");assert.equal(d.label,"보통");assert.match(d.title,/1920×1080 한 프레임 약 8\.0ms/);assert.match(d.title,/약 125fps/);
  assert.match(Perf.describe(0).title,/약 0\.1ms/);assert.match(Perf.describe(250).title,/약 250ms .*약 4fps/);
});
test("소프트웨어 렌더러 판별",()=>{
  for(const name of ["Google SwiftShader","ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)","llvmpipe (LLVM 15.0.7, 256 bits)","Microsoft Basic Render Driver"])assert(Perf.isSoftware(name),name);
  for(const name of ["ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)","Apple M2","",undefined])assert(!Perf.isSoftware(name),String(name));
});
// 가짜 GL: drawArrays 한 번에 시계를 cost()만큼 보낸다. readPixels가 동기화 지점.
const fakeGl=cost=>{
  let clock=0,draws=0,bound=null;const calls=[];
  const gl={TEXTURE_2D:1,RGBA8:2,RGBA:3,UNSIGNED_BYTE:4,FRAMEBUFFER:5,COLOR_ATTACHMENT0:6,TRIANGLES:7,TEXTURE0:100,
    createTexture:()=>({}),createFramebuffer:()=>({fbo:true}),bindTexture(){},texImage2D(){},framebufferTexture2D(){},activeTexture(){},viewport(...a){calls.push(["viewport",...a]);},
    bindFramebuffer:(_,fb)=>{bound=fb;},drawArrays(){draws++;clock+=cost(draws);},readPixels(){calls.push(["sync"]);},deleteFramebuffer(){},deleteTexture(){}};
  return {gl,now:()=>clock,get draws(){return draws;},get bound(){return bound;},calls};
};
test("측정기: 처음 두 번(준비 비용)을 버리고, 예산 안에서 여러 번 그린 평균의 작은 쪽을 쓴다",()=>{
  // 첫 두 번은 50ms(셰이더 준비), 그다음은 1ms. 중간에 한 번 끼어든 일(9번째 그리기 +20ms)은 버려야 한다.
  const f=fakeGl(n=>n<=2?50:n===9?21:1);
  const meter=Perf.createMeter(f.gl,{width:200,height:100,now:f.now,budgetMs:8});
  let prepared=0;const ms=meter.time(size=>{prepared++;assert.deepEqual(size,{width:200,height:100});});
  assert.equal(prepared,1);assert.equal(ms,1,`평균 ${ms}`);assert.equal(meter.pixels,20000);
  assert.equal(f.bound,null,"끝나면 기본 프레임버퍼로");assert(f.calls.some(c=>c[0]==="viewport"&&c[3]===200&&c[4]===100));
});
test("측정기: 무거운 셰이더는 한 번만 더 그려 오래 멈추지 않는다",()=>{
  const f=fakeGl(()=>40);const meter=Perf.createMeter(f.gl,{now:f.now,budgetMs:8});
  assert.equal(meter.time(()=>{}),40);assert.equal(f.draws,5,"준비 2 + 한 번 + 두 번 재기(각 1번)");
});
test("측정기: 가벼운 셰이더도 그리기 횟수 상한(64)을 넘지 않는다",()=>{
  const f=fakeGl(()=>0.001);const meter=Perf.createMeter(f.gl,{now:f.now,budgetMs:8});
  meter.time(()=>{});assert(f.draws<=3+64*2,`${f.draws}번`);
});
console.log(`Gallery perf: ${passed} passed`);
