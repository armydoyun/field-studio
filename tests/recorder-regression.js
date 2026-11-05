require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/recorder-regression.js — 뷰포트 녹화(recorder.js): 형식 고르기, 시작·중지·저장, 오류와 폐기 처리. MediaRecorder는 가짜로 바꾼다.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
let Recorder;
vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../js/recorder.js"),"utf8"),{
  define:(deps,factory)=>Recorder=factory(),performance:{now:()=>Date.now()},setInterval,clearInterval,setTimeout,clearTimeout,Blob,Math,String,Date,document:{createElement:()=>({})}
},{filename:"recorder.js"});
// 가짜 MediaRecorder: start()로 녹화, stop()하면 받아 둔 조각을 dataavailable로 넘기고 stop을 알린다.
// manualStart: true면 start 이벤트를 테스트가 직접 보낸다(실제처럼 인코더 준비가 늦는 경우). 기본은 start() 안에서 바로 보낸다.
const fake=(supportedTypes,{fail=false,emptyData=false,manualStart=false}={})=>{
  const made=[];
  class FakeRecorder{
    static isTypeSupported(type){return supportedTypes.includes(type);}
    constructor(stream,options){if(fail)throw new Error("codec busy");this.stream=stream;this.options=options;this.mimeType=options.mimeType||"";this.state="inactive";this.listeners={};made.push(this);}
    addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
    emit(type,event={}){for(const fn of this.listeners[type]||[])fn(event);}
    start(slice){this.state="recording";this.slice=slice;if(!manualStart)this.emit("start");}
    stop(){this.state="inactive";if(!emptyData)this.emit("dataavailable",{data:new Blob(["frame"],{type:this.mimeType})});this.emit("stop");}
  }
  return {FakeRecorder,made};
};
// 렌더 캔버스(WebGL 자리)와 녹화용 2D 캔버스(mirror). mirror.captureStream(0)의 트랙은 requestFrame() 횟수를 센다.
const canvas=()=>({width:640,height:360});
const mirrorFactory=()=>{
  const made=[];
  const create=()=>{const track={frames:0,stopped:false,readyState:"live",requestFrame(){this.frames++;},stop(){this.stopped=true;this.readyState="ended";}};
    const draws=[];const mirror={width:0,height:0,track,draws,tracks:[track],fps:null,getContext:()=>({drawImage:(src)=>draws.push(src)}),captureStream(fps){this.fps=fps;return {getTracks:()=>[track],getVideoTracks:()=>[track]};}};made.push(mirror);return mirror;};
  return {create,made};
};
// renderer.onFrame · redraw 흉내
const frames=()=>{const listeners=new Set();let redraws=0;return {onFrame:fn=>(listeners.add(fn),()=>listeners.delete(fn)),redraw:()=>redraws++,draw:c=>{for(const fn of listeners)fn(c);},get count(){return listeners.size;},get redraws(){return redraws;}};};
let passed=0;const queue=[];const test=(name,fn)=>queue.push([name,fn]);

test("WebM VP9를 먼저 고르고, 없으면 MP4로 물러난다",()=>{
  assert.equal(Recorder.pickMimeType(fake(["video/webm;codecs=vp9","video/webm"]).FakeRecorder),"video/webm;codecs=vp9");
  assert.equal(Recorder.pickMimeType(fake(["video/mp4"]).FakeRecorder),"video/mp4");
  assert.equal(Recorder.pickMimeType(fake([]).FakeRecorder),"");
  assert.equal(Recorder.pickMimeType(undefined),"");
});
test("지원 여부: MediaRecorder와 captureStream이 모두 있어야 한다",()=>{
  const {FakeRecorder}=fake(["video/webm"]);
  assert.equal(Recorder.supported({captureStream(){}},FakeRecorder),true);
  assert.equal(Recorder.supported({},FakeRecorder),false);
  assert.equal(Recorder.supported({captureStream(){}},undefined),false);
});
test("경과 시간과 파일 이름 형식",()=>{
  assert.equal(Recorder.formatElapsed(0),"0:00");assert.equal(Recorder.formatElapsed(7900),"0:07");
  assert.equal(Recorder.formatElapsed(62000),"1:02");assert.equal(Recorder.formatElapsed(3723000),"1:02:03");
  const at=new Date(2026,10,5,9,3,7);
  assert.equal(Recorder.fileName("video/webm;codecs=vp9",at),"shader-20261105-090307.webm");
  assert.equal(Recorder.fileName("video/mp4",at),"shader-20261105-090307.mp4");
});
test("시작 → 그린 프레임을 2D 캔버스로 옮겨 녹화 → 중지하면 한 번 저장하고 정리한다",()=>{
  const {FakeRecorder,made}=fake(["video/webm;codecs=vp9"]),c=canvas(),m=mirrorFactory(),f=frames(),saved=[],changes=[];
  const r=Recorder.create({canvas:c,onFrame:f.onFrame,redraw:f.redraw,createCanvas:m.create,Recorder:FakeRecorder,onSave:(blob,name)=>saved.push({blob,name}),onChange:x=>changes.push(x.recording)});
  assert.equal(r.start(),true);assert.equal(r.isRecording(),true);assert.equal(r.start(),false,"녹화 중에 다시 시작하지 않음");
  const mirror=m.made[0];
  assert.equal(mirror.fps,0,"프레임은 requestFrame으로만");assert.deepEqual([mirror.width,mirror.height],[640,360],"녹화 크기 = 렌더 해상도");
  assert.equal(f.redraws,1,"시작할 때 지금 화면을 한 번 그림(일시정지 중 대비)");assert.equal(f.count,1);
  f.draw(c);f.draw(c);assert.equal(mirror.draws.filter(x=>x===c).length,2);assert.equal(mirror.track.frames,3,"시작 순간 1장 + 그릴 때마다 한 프레임");
  f.draw({width:320,height:180});assert.deepEqual([mirror.width,mirror.height],[320,180],"해상도가 바뀌면 따라감");
  assert.equal(made[0].options.mimeType,"video/webm;codecs=vp9");assert(made[0].options.videoBitsPerSecond>=8e6);assert.equal(made[0].slice,1000);
  assert.equal(r.stop(),true);assert.equal(r.isRecording(),false);assert.equal(r.stop(),false);
  assert.equal(saved.length,1);assert.match(saved[0].name,/^shader-\d{8}-\d{6}\.webm$/);assert.equal(saved[0].blob.size,5);
  assert(mirror.track.stopped,"캡처 트랙 정리");assert.equal(f.count,0,"프레임 구독 해제");assert.deepEqual([changes[0],changes.at(-1)],[true,false]);
});
test("새로 그리지 않는 동안(일시정지)에도 마지막 화면으로 프레임을 넣는다",async()=>{
  const {FakeRecorder}=fake(["video/webm"]),m=mirrorFactory(),f=frames();
  const r=Recorder.create({canvas:canvas(),onFrame:f.onFrame,redraw:f.redraw,createCanvas:m.create,Recorder:FakeRecorder,onSave(){}});
  r.start();f.draw(canvas());const mirror=m.made[0],before=mirror.track.frames;
  await new Promise(resolve=>setTimeout(resolve,700));
  assert(mirror.track.frames>=before+2,`멈춘 화면 프레임 ${mirror.track.frames-before}개`);
  assert(mirror.draws.includes(mirror),"같은 그림을 제자리에 다시 그려 브라우저가 프레임을 건너뛰지 않게 함");
  r.stop();
});
test("toggle은 시작과 중지를 오간다",()=>{
  const {FakeRecorder}=fake(["video/webm"]),saved=[];
  const r=Recorder.create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:FakeRecorder,onSave:()=>saved.push(1)});
  r.toggle();assert.equal(r.isRecording(),true);r.toggle();assert.equal(r.isRecording(),false);assert.equal(saved.length,1);
});
test("지원하지 않는 브라우저·시작 실패는 오류로 알리고 녹화 상태가 되지 않는다",()=>{
  const errors=[];
  assert.equal(Recorder.create({canvas:{},Recorder:fake([]).FakeRecorder,onSave(){},onError:m=>errors.push(m)}).start(),false);
  const m=mirrorFactory(),r=Recorder.create({canvas:canvas(),createCanvas:m.create,Recorder:fake(["video/webm"],{fail:true}).FakeRecorder,onSave(){},onError:x=>errors.push(x)});
  assert.equal(r.start(),false);assert.equal(r.isRecording(),false);assert(m.made[0].track.stopped,"실패해도 트랙 정리");
  assert.equal(errors.length,2);assert.match(errors[1],/codec busy/);
});
test("빈 녹화는 저장하지 않고 알린다",()=>{
  const errors=[],saved=[],r=Recorder.create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:fake(["video/webm"],{emptyData:true}).FakeRecorder,onSave:()=>saved.push(1),onError:m=>errors.push(m)});
  r.start();r.stop();assert.equal(saved.length,0);assert.equal(errors.length,1);
});
test("녹화 중 오류·폐기(dispose)는 파일을 내려받지 않는다",()=>{
  const {FakeRecorder,made}=fake(["video/webm"]),saved=[],errors=[];
  const r=Recorder.create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:FakeRecorder,onSave:()=>saved.push(1),onError:m=>errors.push(m)});
  r.start();made[0].emit("error",{error:new Error("gpu reset")});assert.equal(r.isRecording(),false);assert.match(errors[0],/gpu reset/);
  r.start();r.dispose();assert.equal(r.isRecording(),false);assert.equal(saved.length,0);
});
test("인코더 준비가 늦으면: 시간은 시작 이벤트부터, 준비 중에 누른 중지는 시작 뒤 잠깐 담고 멈춘다",async()=>{
  const {FakeRecorder,made}=fake(["video/webm"],{manualStart:true}),m=mirrorFactory(),saved=[],changes=[];
  const r=Recorder.create({canvas:canvas(),createCanvas:m.create,Recorder:FakeRecorder,onSave:()=>saved.push(1),onChange:x=>changes.push(x)});
  r.start();assert.deepEqual([changes.at(-1).recording,changes.at(-1).ready,changes.at(-1).elapsed],[true,false,0],"준비 중");
  assert.equal(r.stop(),true);assert.equal(made[0].state,"recording","준비 중에는 바로 멈추지 않음");assert.equal(saved.length,0);
  const before=m.made[0].track.frames;made[0].emit("start");
  assert.equal(changes.at(-1).ready,true);assert.equal(m.made[0].track.frames,before+1,"시작 순간 지금 화면을 첫 프레임으로");
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.equal(made[0].state,"inactive","시작 뒤 잠깐 담고 멈춤");assert.equal(saved.length,1);
});
test("경과 시간은 실제 시작 뒤 1초가 넘어가는 시점마다 갱신된다",async()=>{
  const {FakeRecorder,made}=fake(["video/webm"],{manualStart:true}),changes=[];
  const r=Recorder.create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:FakeRecorder,onSave(){},onChange:x=>changes.push(x)});
  r.start();await new Promise(resolve=>setTimeout(resolve,700));made[0].emit("start");// 늦게 시작해도 시작 순간 기준
  assert.equal(Recorder.formatElapsed(changes.at(-1).elapsed),"0:00");
  await new Promise(resolve=>setTimeout(resolve,1150));
  assert.equal(Recorder.formatElapsed(changes.at(-1).elapsed),"0:01",`표시 ${changes.at(-1).elapsed}ms`);
  r.dispose();
});
test("준비 중에 폐기(dispose)하면 바로 멈추고 버린다",()=>{
  const {FakeRecorder,made}=fake(["video/webm"],{manualStart:true}),saved=[];
  const r=Recorder.create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:FakeRecorder,onSave:()=>saved.push(1)});
  r.start();r.dispose();assert.equal(made[0].state,"inactive");assert.equal(saved.length,0);assert.equal(r.isRecording(),false);
});
(async()=>{for(const [name,fn] of queue){await fn();passed++;console.log("PASS",name);}console.log(`Recorder: ${passed} passed`);})().catch(error=>{console.error(error);process.exit(1);}); // 실패한 테스트의 녹화 타이머가 남아도 끝나게
