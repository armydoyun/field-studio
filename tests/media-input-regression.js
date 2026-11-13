require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/media-input-regression.js — 미디어 입력 채널(js/media-input.js)의 순수 부분과 채널 값 형식
//  · 오디오 텍스처 512×2: 0행 = 주파수 크기, 1행 = 파형(Shadertoy 배치)
//  · 파일 종류 검사 · 채널 고르기 값("media:<종류>") 왕복
// 실제 카메라 · 마이크 · 파일 재생은 tests/media-browser-regression.js가 본다.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","js",file),"utf8"),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const Media=load("media-input.js"),Picker=load("channel-picker.js");
let passed=0;const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};

test("오디오 텍스처: 앞 512개 주파수가 0행, 앞 512개 파형이 1행",()=>{
  const freq=new Uint8Array(512).map((_,i)=>i%256),wave=new Uint8Array(1024).map((_,i)=>(i*3)%256);
  const out=Media.audioRows(freq,wave);
  assert.equal(out.length,Media.AUDIO_WIDTH*Media.AUDIO_HEIGHT);
  assert.equal(Media.AUDIO_WIDTH,512);assert.equal(Media.AUDIO_HEIGHT,2);
  for(const i of[0,1,255,256,511])assert.equal(out[i],freq[i],`주파수 ${i}`);
  for(const i of[0,1,300,511])assert.equal(out[512+i],wave[i],`파형 ${i}`);
});
test("오디오 텍스처: 짧은 입력은 남는 칸을 무음(주파수 0 · 파형 128)으로 채우고, 주어진 배열에 다시 쓴다",()=>{
  const out=new Uint8Array(1024).fill(7);
  Media.audioRows(new Uint8Array([9,9]),new Uint8Array([200]),out);
  assert.deepEqual([out[0],out[1],out[2],out[511]],[9,9,0,0]);
  assert.deepEqual([out[512],out[513],out[1023]],[200,128,128]);
});
test("파일 검사: 종류에 맞는 audio/* · video/*만, 512MB 이하",()=>{
  assert.equal(Media.fileProblem("audio",{type:"audio/mpeg",size:10}),"");
  assert.equal(Media.fileProblem("video",{type:"video/webm",size:10}),"");
  assert.match(Media.fileProblem("audio",{type:"video/mp4",size:10}),/오디오 파일이 아닙니다/);
  assert.match(Media.fileProblem("video",{type:"",size:10}),/형식을 알 수 없음/);
  assert.match(Media.fileProblem("video",{type:"video/mp4",size:513*1024*1024}),/512MB/);
  assert.match(Media.fileProblem("mic",{type:"audio/wav",size:1}),/파일로 여는 입력이 아닙니다/);
  assert.match(Media.fileProblem("audio",null),/파일이 없습니다/);
});
test("채널 값: media:<종류> ↔ {media:종류}",()=>{
  for(const kind of Media.KINDS){
    assert.equal(Picker.valueOf({media:kind}),`media:${kind}`);
    assert.deepEqual({...Picker.refOf(`media:${kind}`)},{media:kind});
  }
  assert.deepEqual({...Picker.refOf("keyboard")},{keyboard:true},"키보드는 그대로");
});
test("영상 렌더링용 소리 분석: 440Hz는 그 칸만 크고, 무음은 0 · 파형은 128 둘레(AnalyserNode와 같은 배치)",()=>{
  const rate=44100,tone=Float32Array.from({length:rate},(_,i)=>0.5*Math.sin(2*Math.PI*440*i/rate)),smooth=new Float32Array(512);
  let out;
  for(let k=0;k<12;k++)out=Media.analyseAt(tone,20000+k*735,smooth); // 60fps로 12프레임: 시간 평활이 쌓인다
  const bin=Math.round(440/(rate/1024));
  assert(out.frequency[bin]>200,`440Hz 칸 ${out.frequency[bin]}`);
  assert(out.frequency[200]<60,`멀리 떨어진 칸 ${out.frequency[200]}`);
  assert.equal(out.wave.length,1024);
  assert(Math.max(...out.wave)>180&&Math.min(...out.wave)<76,"파형은 진폭 0.5만큼 흔들린다");
  const quiet=Media.analyseAt(new Float32Array(4096),3000,new Float32Array(512));
  assert(quiet.frequency.every(v=>v===0)&&quiet.wave.every(v=>v===128),"무음");
  const early=Media.analyseAt(tone,100,new Float32Array(512));
  assert.equal(early.wave[0],128,"파일 앞(음수 위치)은 무음으로 채운다");
});
console.log(`Media input: ${passed} passed`);
