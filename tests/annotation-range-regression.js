require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/annotation-range-regression.js — 어노테이션 표현 범위(js/annotations.js): 한 줄 여러 선언 · 성분별 @range · 배열 · @if
// 렌더러 배열 Uniform · 패널 동작은 tests/annotation-range-browser-regression.js가 본다.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","js",file),"utf8"),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const A=load("annotations.js");
let passed=0;const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};
const one=line=>A.collect([line]);

test("한 줄 여러 선언: 같은 어노테이션을 이름마다",()=>{
  const [a,b]=one("uniform float uA , uB; // 설명 · @range 0 2 @default 1");
  assert.equal(a.name,"uA");assert.equal(b.name,"uB");assert.equal(b.value,1);assert.equal(b.options.max,2);assert.equal(b.description,"설명");
});
test("성분별 @range: 2N개 숫자 · 기본값은 성분 범위 안 · clampValue 성분마다",()=>{
  const [v]=one("uniform vec3 uBox; // @range 0 1 -5 5 0 100");
  assert.equal(v.error,null);assert.deepEqual([...v.options.ranges].map(r=>[...r]),[[0,1,0.001],[-5,5,0.01],[0,100,0.1]]);
  assert.deepEqual([...v.value],[0,0,0]);assert.equal(v.options.min,-5);assert.equal(v.options.max,100);
  assert.deepEqual([...A.clampValue([2,-9,50],v.options)],[1,-5,50]);
  assert.match(one("uniform vec3 c; // @color @range 0 1 0 1 0 1")[0].error,/일반 벡터/);
  assert.match(one("uniform ivec2 g; // @range 0 1.5 0 2")[0].error,/정수/);
  assert.match(one("uniform vec2 g; // @range 1 0 0 2")[0].error,/min < max/);
  assert.equal(one("uniform vec3 s; // @range 0 1 0.1")[0].options.ranges,undefined); // 3개는 min max step
  assert(!A.sameOptions(v.options,{...v.options,ranges:[[0,1,1],[0,1,1],[0,1,1]]}));
});
test("배열: 두 문법 · 원소 하나 분량 / 전체 분량 @default · 원소마다 @dir · 거절",()=>{
  const [w]=one("uniform float uW[4]; // @range 0 1 @default 0.5");
  assert.equal(w.type,"float[4]");assert.deepEqual([...w.value],[0.5,0.5,0.5,0.5]);
  const [c]=one("uniform vec3 uCols[2]; // @color @default 1 0 0 0 0 1");
  assert.equal(c.type,"vec3[2]");assert.deepEqual([...c.value],[1,0,0,0,0,1]);assert.equal(c.options.color,true);
  const [x,y]=one("uniform float[3] uX, uY[2]; // @range 0 1");
  assert.equal(x.type,"float[3]");assert.equal(y.type,"float[2]");
  const [d]=one("uniform vec2 uD[2]; // @dir @default 0 2 3 0");assert.deepEqual([...d.value],[0,1,1,0]);
  assert.deepEqual([...A.clampValue([0,3,4,0],d.options,"vec2[2]")],[0,1,1,0]);
  const [e]=one("uniform int uE[2]; // @enum 가 나 @default 0 1");assert.deepEqual([...e.value],[0,1]);assert.equal(e.error,null);
  assert.match(one("uniform float uS[2]; // @seed")[0].error,/@seed/);
  assert.match(one("uniform float uS[2]; // @range 0 1 @anim")[0].error,/@anim/);
  assert.match(one("uniform float uS[1]; // @range 0 1")[0].error,/2~64/);
  assert.match(one("uniform vec2 uS[2]; // @range 0 1 0 1")[0].error,/성분별/);
  assert.match(one("uniform sampler2D uR[2]; // @gradient")[0].error,/램프/);
});
test("@if: 형식 · 판단(이름 · ! · 비교 · @enum 이름 · bool) · 없는 대상은 보임",()=>{
  const specs=new Map(A.collect([
    "uniform int uMode; // @enum 하나 둘_셋",
    "uniform float uA; // @range 0 1 @if uMode == 둘_셋",
    "uniform float uB; // @range 0 1 @if !uOn",
    "uniform float uC; // @range 0 1 @if uLevel>=0.5",
    "uniform float uD; // @range 0 1 @if uGhost == 1",
  ]).map(s=>[s.name,s]));
  const values={uMode:1,uOn:true,uLevel:0.5};const v=name=>values[name];
  assert.equal(A.visible(specs.get("uA").when,v,specs),true);
  assert.equal(A.visible(specs.get("uB").when,v,specs),false);
  assert.equal(A.visible(specs.get("uC").when,v,specs),true);
  assert.equal(A.visible(specs.get("uD").when,v,specs),true);
  values.uMode=0;values.uOn=false;values.uLevel=0.2;
  assert.equal(A.visible(specs.get("uA").when,v,specs),false);
  assert.equal(A.visible(specs.get("uB").when,v,specs),true);
  assert.equal(A.visible(specs.get("uC").when,v,specs),false);
  assert.equal(A.visible(null,v,specs),true);
  assert.match(one("uniform float uX; // @if uX")[0].error,/자기 자신/);
  assert.match(one("uniform float uX; // @if == 2")[0].error,/@if는/);
});
console.log(`${passed} passed`);
