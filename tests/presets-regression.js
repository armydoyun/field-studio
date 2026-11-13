require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/presets-regression.js — 파라미터 프리셋(js/presets.js): 저장 · 검사 · 위젯 종류에 맞는 섞기
// 패널에서의 저장 · 전환 · 프로젝트와 함께 저장되는지는 tests/presets-browser-regression.js가 본다.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","js",file),"utf8"),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const P=load("presets.js");
let passed=0;const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};
const near=(a,b)=>Math.abs(a-b)<1e-9;

test("capture: 지금 값을 복사해 둔다(배열은 새 배열)",()=>{
  const users=[{name:"uGain",type:"float",value:0.5},{name:"uTint",type:"vec3",value:[1,0,0]}];
  const preset=P.capture("밤",users);
  assert.deepEqual({...preset,values:{...preset.values}},{name:"밤",values:{uGain:0.5,uTint:[1,0,0]}});
  users[1].value[0]=9;
  assert.equal(preset.values.uTint[0],1,"원래 배열과 따로");
});
test("validate: 이름(1~60자 · 중복 없음) · 개수(32) · 잘못된 값은 빼고 복사",()=>{
  const ok=P.validate([{name:" 낮 ",values:{uA:1,uB:[1,2],uBad:"x","1x":2,uC:true}}]);
  assert.deepEqual(JSON.parse(JSON.stringify(ok)),[{name:"낮",values:{uA:1,uB:[1,2],uC:true}}]);
  assert.throws(()=>P.validate([{name:"",values:{}}]),/이름/);
  assert.throws(()=>P.validate([{name:"a",values:{}},{name:"a",values:{}}]),/같은 이름/);
  assert.throws(()=>P.validate(Array.from({length:33},(_,i)=>({name:"p"+i,values:{}}))),/최대 32/);
  assert.throws(()=>P.validate([{name:"a",values:[1]}]),/값이 올바르지/);
});
test("섞기: 실수 · 벡터는 선형, int는 반올림, bool · @enum은 가운데에서 바뀜",()=>{
  assert(near(P.blendValue({type:"float"},0,10,0.25),2.5));
  assert.deepEqual(P.blendValue({type:"vec3"},[0,0,0],[1,2,4],0.5),[0.5,1,2]);
  assert.equal(P.blendValue({type:"int"},0,10,0.26),3);
  assert.equal(P.blendValue({type:"bool"},false,true,0.49),false);
  assert.equal(P.blendValue({type:"bool"},false,true,0.5),true);
  assert.equal(P.blendValue({type:"int",options:{enum:["a","b","c"]}},0,2,0.4),0,"enum은 가운데 전에는 그대로");
  assert.equal(P.blendValue({type:"int",options:{enum:["a","b","c"]}},0,2,0.6),2);
  assert.deepEqual(P.blendValue({type:"float"},1,2,0),1);assert.deepEqual(P.blendValue({type:"float"},1,2,1),2);
});
test("섞기: @dir은 길이 1, @angle은 가까운 쪽으로, 램프는 점 수가 같을 때만 섞는다",()=>{
  const d=P.blendValue({type:"vec3",options:{dir:"full"}},[1,0,0],[0,1,0],0.5);
  assert(near(Math.hypot(...d),1)&&near(d[0],d[1]),`방향 ${d}`);
  const a=P.blendValue({type:"float",options:{angle:true}},0.1,2*Math.PI-0.1,0.5);
  assert(near(a,0)||near(a,2*Math.PI),`각도는 0을 지나 짧게: ${a}`);
  assert.deepEqual(P.blendValue({type:"sampler2D",options:{gradient:"smooth"}},[0,0,0,0,1,1,1,1,1,1],[0,1,1,1,1,1,0,0,0,1],0.5),[0,0.5,0.5,0.5,1,1,0.5,0.5,0.5,1]);
  assert.deepEqual(P.blendValue({type:"sampler2D",options:{curve:"smooth"}},[0,0,1,1],[0,1,0.5,0.5,1,0],0.3),[0,0,1,1],"점 수가 다르면 가운데 전에는 그대로");
});
test("blend: 프리셋에 있는 파라미터만, 시작 값이 있는 것만 · ease는 0~1 사이를 부드럽게",()=>{
  const users=[{name:"uA",type:"float"},{name:"uB",type:"float"},{name:"uC",type:"float"}];
  assert.deepEqual(P.blend(users,{uA:0,uB:0},{name:"p",values:{uA:10,uC:5}},0.5),[["uA",5]]);
  assert.equal(P.ease(0),0);assert.equal(P.ease(1),1);assert.equal(P.ease(0.5),0.5);assert(P.ease(0.1)<0.1&&P.ease(0.9)>0.9);
});
console.log(`Presets: ${passed} passed`);
