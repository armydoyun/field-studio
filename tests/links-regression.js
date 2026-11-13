require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/links-regression.js — 파라미터 연결(js/links.js): 검사 · 소리 대역 · 흔들기 · 키프레임 · 따라가기 · 타입 맞추기
// 렌더러가 프레임마다 적용하는지 · 패널 · 영상 렌더링에서 맞는지는 tests/links-browser-regression.js가 본다.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","js",file),"utf8"),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const L=load("links.js");
let passed=0;const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};
const near=(a,b,e=1e-9)=>Math.abs(a-b)<e;

test("validate: 소스별 기본값 · 범위 자르기 · 키프레임 정렬 · 파라미터 하나에 연결 하나",()=>{
  const [a,m,l,k]=L.validate([{name:"uA",source:"audio"},{name:"uM",source:"midi",cc:300,channel:-2},{name:"uL",source:"lfo",period:0,phase:3},{name:"uK",source:"keys",keys:[[2,5],[1,3],[0,"x"]],loop:-1}]);
  assert.deepEqual({...a},{name:"uA",source:"audio",min:0,max:1,smooth:0,band:"bass"});
  assert.equal(m.cc,127);assert.equal(m.channel,0);
  assert.equal(l.period,0.05);assert.equal(l.phase,1);assert.equal(l.shape,"sine");
  assert.deepEqual(k.keys.map(x=>[...x]),[[1,3],[2,5]]);assert.equal(k.loop,0);assert.equal(k.ease,"smooth");
  assert.throws(()=>L.validate([{name:"uA",source:"audio"},{name:"uA",source:"lfo"}]),/연결 하나/);
  assert.throws(()=>L.validate([{name:"uA",source:"camera"}]),/알 수 없는/);
});
test("소리: 대역 평균은 그 주파수 칸만 · 파형 크기 · 네 값",()=>{
  const rows=new Uint8Array(1024).fill(0);rows.fill(128,512);
  const bin=Math.round(100/(48000/1024));rows[bin]=255; // 100Hz
  const levels=L.audioLevels(rows,48000);
  assert(levels.bass>0.1&&levels.mid===0&&levels.treble===0,`저음만: ${JSON.stringify(levels)}`);
  assert.equal(levels.volume,0,"무음 파형");
  for(let i=0;i<512;i++)rows[512+i]=i%2?255:1;
  assert(L.audioLevels(rows).volume>0.95,"가장 큰 파형은 1 가까이");
});
test("흔들기: 사인은 0에서 시작해 반 주기에 1 · 삼각 · 톱니 · 사각 · 위상",()=>{
  assert(near(L.lfo("sine",4,0,0),0)&&near(L.lfo("sine",4,0,2),1)&&near(L.lfo("sine",4,0,4),0,1e-9));
  assert(near(L.lfo("triangle",2,0,0.5),0.5)&&near(L.lfo("triangle",2,0,1),1));
  assert(near(L.lfo("saw",2,0,1.5),0.75));
  assert.equal(L.lfo("square",2,0,0.2),1);assert.equal(L.lfo("square",2,0,1.2),0);
  assert(near(L.lfo("saw",2,0.5,0),0.5),"위상 반 주기");
  assert(near(L.lfo("saw",2,0,-0.5),0.75),"음수 시간도 0~1");
});
test("키프레임: 앞은 첫 값 · 사이는 부드럽게(또는 직선) · 뒤는 끝 값 · 반복",()=>{
  const keys=[[1,0],[3,10]];
  assert.equal(L.keyValue(keys,0),0);assert.equal(L.keyValue(keys,5),10);
  assert.equal(L.keyValue(keys,2),5,"가운데는 같다");
  assert(near(L.keyValue(keys,1.5,0,"linear"),2.5)&&L.keyValue(keys,1.5)<2.5,"smooth는 천천히 시작");
  assert.equal(L.keyValue(keys,6,4),5,"loop 4초: 6초 = 2초");
  assert.equal(L.keyValue([],1),null);
});
test("target: 0~1 소스는 min~max로 옮기고 키프레임은 그대로 · 입력이 없으면 null",()=>{
  const time=2;
  assert(near(L.target({source:"lfo",shape:"sine",period:4,phase:0,min:10,max:20},{time}),20));
  assert.equal(L.target({source:"audio",band:"bass",min:0,max:1},{time,audio:null}),null);
  assert.equal(L.target({source:"audio",band:"mid",min:2,max:4},{time,audio:{mid:0.5}}),3);
  assert.equal(L.target({source:"midi",cc:7,channel:0,min:0,max:100},{time,midi:(ch,cc)=>cc===7?0.25:null}),25);
  assert.equal(L.target({source:"midi",cc:8,channel:0,min:0,max:100},{time,midi:()=>null}),null);
  assert.equal(L.target({source:"keys",keys:[[0,7]],loop:0,ease:"smooth",min:0,max:1},{time}),7);
});
test("follow · toParameter: 시간 상수로 다가가기 · int 반올림 · uint ≥ 0 · bool 0.5",()=>{
  assert.equal(L.follow(null,5,1,0.1),5);assert.equal(L.follow(0,5,0,0.1),5);
  assert(near(L.follow(0,1,1,1),1-Math.exp(-1)));
  assert.equal(L.toParameter("int",2.6),3);assert.equal(L.toParameter("uint",-3),0);
  assert.equal(L.toParameter("bool",0.5),true);assert.equal(L.toParameter("bool",0.49),false);assert.equal(L.toParameter("float",0.3),0.3);
  assert(L.LINKABLE.has("float")&&!L.LINKABLE.has("vec3"));
});
console.log(`Links: ${passed} passed`);
