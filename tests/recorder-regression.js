require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/recorder-regression.js — 뷰포트 녹화(recorder.js): 형식 고르기, 시작·중지·저장, 오류와 폐기 처리. MediaRecorder는 가짜로 바꾼다.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
// 실제 시간을 기다리지 않는다. CI 부하·시계 보정에 상관없이 타이머 경계를 정확히 검사한다.
const clock=()=>{
  let now=0,next=0;const tasks=new Map();
  const schedule=(fn,ms,interval=0)=>{const id=++next;tasks.set(id,{fn,at:now+ms,interval});return id;};
  const advance=ms=>{const end=now+ms;for(;;){const entry=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!entry||entry[1].at>end)break;
    const [id,task]=entry;now=Math.max(now,task.at);if(task.interval)task.at+=task.interval;else tasks.delete(id);task.fn();}now=end;};
  return {advance,stall:ms=>{now+=ms;},get pending(){return tasks.size;},performance:{now:()=>now},
    setTimeout:(fn,ms)=>schedule(fn,ms),clearTimeout:id=>tasks.delete(id),setInterval:(fn,ms)=>schedule(fn,ms,ms),clearInterval:id=>tasks.delete(id)};
};
const time=clock();let Recorder;
vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../js/recorder.js"),"utf8"),{
  define:(deps,factory)=>Recorder=factory(),...time,Blob,Math,String,Date,document:{createElement:()=>({})}
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
const frames=(source=canvas())=>{const listeners=new Set();let redraws=0;const draw=c=>{for(const fn of listeners)fn(c);};
  return {onFrame:fn=>(listeners.add(fn),()=>listeners.delete(fn)),redraw:()=>{redraws++;draw(source);},draw,get count(){return listeners.size;},get redraws(){return redraws;}};};
const create=options=>{const f=frames(options.canvas);return Recorder.create({onFrame:f.onFrame,redraw:f.redraw,...options});};
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
  const {FakeRecorder,made}=fake(["video/webm;codecs=vp9"]),c=canvas(),m=mirrorFactory(),f=frames(c),saved=[],changes=[];
  const r=create({canvas:c,onFrame:f.onFrame,redraw:f.redraw,createCanvas:m.create,Recorder:FakeRecorder,onSave:(blob,name)=>saved.push({blob,name}),onChange:x=>changes.push(x.recording)});
  assert.equal(r.start(),true);assert.equal(r.isRecording(),true);assert.equal(r.start(),false,"녹화 중에 다시 시작하지 않음");
  const mirror=m.made[0];
  assert.equal(mirror.fps,0,"프레임은 requestFrame으로만");assert.deepEqual([mirror.width,mirror.height],[640,360],"녹화 크기 = 렌더 해상도");
  assert.equal(f.redraws,1,"시작할 때 지금 화면을 한 번 그림(일시정지 중 대비)");assert.equal(f.count,1);
  f.draw(c);f.draw(c);assert.equal(mirror.draws.filter(x=>x===c).length,3);assert.equal(mirror.track.frames,4,"시작 순간 1장 + 그릴 때마다 한 프레임");
  f.draw({width:320,height:180});assert.deepEqual([mirror.width,mirror.height],[320,180],"해상도가 바뀌면 따라감");
  assert.equal(made[0].options.mimeType,"video/webm;codecs=vp9");assert(made[0].options.videoBitsPerSecond>=8e6);assert.equal(made[0].slice,1000);
  assert.equal(r.stop(),true);assert.equal(r.isRecording(),false);assert.equal(r.stop(),false);
  assert.equal(saved.length,1);assert.match(saved[0].name,/^shader-\d{8}-\d{6}\.webm$/);assert.equal(saved[0].blob.size,5);
  assert(mirror.track.stopped,"캡처 트랙 정리");assert.equal(f.count,0,"프레임 구독 해제");assert.deepEqual([changes[0],changes.at(-1)],[true,false]);
});
test("새로 그리지 않는 동안(일시정지)에도 마지막 화면으로 프레임을 넣는다",()=>{
  const {FakeRecorder}=fake(["video/webm"]),m=mirrorFactory(),f=frames();
  const r=create({canvas:canvas(),onFrame:f.onFrame,redraw:f.redraw,createCanvas:m.create,Recorder:FakeRecorder,onSave(){}});
  r.start();time.advance(1);f.draw(canvas());const mirror=m.made[0],before=mirror.track.frames;
  // 첫 250ms interval은 마지막 프레임보다 249ms 뒤다. 이때 건너뛰면 700ms 안에 1장만 들어가던 회귀.
  time.advance(700);
  assert(mirror.track.frames>=before+2,`멈춘 화면 프레임 ${mirror.track.frames-before}개`);
  assert(mirror.draws.includes(mirror),"같은 그림을 제자리에 다시 그려 브라우저가 프레임을 건너뛰지 않게 함");
  r.stop();const stopped=mirror.track.frames;time.advance(1000);assert.equal(mirror.track.frames,stopped,"중지 뒤 프레임 없음");
});
test("toggle은 시작과 중지를 오간다",()=>{
  const {FakeRecorder}=fake(["video/webm"]),saved=[];
  const r=create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:FakeRecorder,onSave:()=>saved.push(1)});
  r.toggle();assert.equal(r.isRecording(),true);r.toggle();assert.equal(r.isRecording(),false);assert.equal(saved.length,1);
});
test("지원하지 않는 브라우저·시작 실패는 오류로 알리고 녹화 상태가 되지 않는다",()=>{
  const errors=[];
  assert.equal(create({canvas:{},Recorder:fake([]).FakeRecorder,onSave(){},onError:m=>errors.push(m)}).start(),false);
  const m=mirrorFactory(),r=create({canvas:canvas(),createCanvas:m.create,Recorder:fake(["video/webm"],{fail:true}).FakeRecorder,onSave(){},onError:x=>errors.push(x)});
  assert.equal(r.start(),false);assert.equal(r.isRecording(),false);assert(m.made[0].track.stopped,"실패해도 트랙 정리");
  assert.equal(errors.length,2);assert.match(errors[1],/codec busy/);
});
test("빈 녹화는 저장하지 않고 알린다",()=>{
  const errors=[],saved=[],r=create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:fake(["video/webm"],{emptyData:true}).FakeRecorder,onSave:()=>saved.push(1),onError:m=>errors.push(m)});
  r.start();r.stop();assert.equal(saved.length,0);assert.equal(errors.length,1);
});
test("녹화 중 오류·폐기(dispose)는 파일을 내려받지 않는다",()=>{
  const {FakeRecorder,made}=fake(["video/webm"]),saved=[],errors=[];
  const r=create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:FakeRecorder,onSave:()=>saved.push(1),onError:m=>errors.push(m)});
  r.start();made[0].emit("error",{error:new Error("gpu reset")});assert.equal(r.isRecording(),false);assert.match(errors[0],/gpu reset/);
  r.start();r.dispose();assert.equal(r.isRecording(),false);assert.equal(saved.length,0);
});
test("인코더 준비가 늦으면: 시간은 시작 이벤트부터, 준비 중에 누른 중지는 시작 뒤 잠깐 담고 멈춘다",()=>{
  const {FakeRecorder,made}=fake(["video/webm"],{manualStart:true}),m=mirrorFactory(),saved=[],changes=[];
  const r=create({canvas:canvas(),createCanvas:m.create,Recorder:FakeRecorder,onSave:()=>saved.push(1),onChange:x=>changes.push(x)});
  r.start();assert.deepEqual([changes.at(-1).recording,changes.at(-1).ready,changes.at(-1).elapsed],[true,false,0],"준비 중");
  assert.equal(r.stop(),true);assert.equal(made[0].state,"recording","준비 중에는 바로 멈추지 않음");assert.equal(saved.length,0);
  const before=m.made[0].track.frames;made[0].emit("start");
  assert.equal(changes.at(-1).ready,true);assert.equal(m.made[0].track.frames,before+1,"시작 순간 지금 화면을 첫 프레임으로");
  time.advance(450);
  assert.equal(made[0].state,"inactive","시작 뒤 잠깐 담고 멈춤");assert.equal(saved.length,1);
});
test("경과 시간은 실제 시작 뒤 1초가 넘어가는 시점마다 갱신된다",()=>{
  const {FakeRecorder,made}=fake(["video/webm"],{manualStart:true}),changes=[];
  const r=create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:FakeRecorder,onSave(){},onChange:x=>changes.push(x)});
  r.start();time.advance(700);made[0].emit("start");// 늦게 시작해도 시작 순간 기준
  assert.equal(Recorder.formatElapsed(changes.at(-1).elapsed),"0:00");
  time.advance(1150);
  assert.equal(Recorder.formatElapsed(changes.at(-1).elapsed),"0:01",`표시 ${changes.at(-1).elapsed}ms`);
  r.dispose();
});
test("이벤트 루프가 10초 멈추면 경과 시간도 실제 지난 시간으로 건너뛴다",()=>{
  const {FakeRecorder}=fake(["video/webm"]),changes=[];
  const r=create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:FakeRecorder,onSave(){},onChange:x=>changes.push(x)});
  r.start();assert.equal(Recorder.formatElapsed(changes.at(-1).elapsed),"0:00");
  time.stall(10000);time.advance(0);
  assert.equal(Recorder.formatElapsed(changes.at(-1).elapsed),"0:10");assert.equal(changes.at(-1).ready,true);r.dispose();
});
test("준비 중에 폐기(dispose)하면 바로 멈추고 버린다",()=>{
  const {FakeRecorder,made}=fake(["video/webm"],{manualStart:true}),saved=[];
  const r=create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:FakeRecorder,onSave:()=>saved.push(1)});
  r.start();r.dispose();assert.equal(made[0].state,"inactive");assert.equal(saved.length,0);assert.equal(r.isRecording(),false);
});
test("첫 렌더 프레임이 늦으면 인코더·경과 시간도 기다린다",()=>{
  const {FakeRecorder,made}=fake(["video/webm"],{manualStart:true}),m=mirrorFactory(),f=frames(),changes=[];
  const r=create({canvas:canvas(),onFrame:f.onFrame,redraw:()=>{},createCanvas:m.create,Recorder:FakeRecorder,onSave(){},onChange:x=>changes.push(x)});
  r.start();time.advance(2000);
  assert.equal(r.isRecording(),true);assert.equal(made.length,0,"빈 mirror로 인코더를 만들지 않음");assert.equal(m.made[0].track.frames,0);
  assert.equal(changes.at(-1).ready,false);
  f.draw({width:800,height:450});assert.equal(made.length,1);assert.deepEqual([m.made[0].width,m.made[0].height],[800,450],"첫 실제 프레임 크기로 녹화");
  made[0].emit("start");assert.equal(changes.at(-1).ready,true);assert.equal(changes.at(-1).elapsed,0);
  r.dispose();assert.equal(f.count,0);
});
test("첫 프레임을 기다리는 동안 중지·폐기해도 타이머와 구독이 남지 않는다",()=>{
  const {FakeRecorder,made}=fake(["video/webm"]),m=mirrorFactory(),f=frames(),saved=[];
  const r=create({canvas:canvas(),onFrame:f.onFrame,redraw:()=>{},createCanvas:m.create,Recorder:FakeRecorder,onSave:b=>saved.push(b)});
  r.start();assert.equal(r.stop(),true);f.draw(canvas());time.advance(299);assert.equal(saved.length,0);time.advance(1);assert.equal(saved.length,1);
  r.start();assert.equal(r.stop(),true);r.dispose();f.draw(canvas());time.advance(1000);
  assert.equal(made.length,1);assert.equal(saved.length,1);assert.equal(f.count,0);assert.equal(r.isRecording(),false);
  // start 이벤트를 기다리는 동안 stop 요청 뒤 dispose해도 지연 중지 작업을 취소한다.
  const delayed=fake(["video/webm"],{manualStart:true});const pending=create({canvas:canvas(),createCanvas:mirrorFactory().create,Recorder:delayed.FakeRecorder,onSave:b=>saved.push(b)});
  pending.start();pending.stop();pending.dispose();assert.equal(pending.isRecording(),false);assert.equal(saved.length,1);
  assert.equal(time.pending,0,"모든 녹화 타이머 정리");
});
test("렌더러가 첫 프레임을 그릴 수 없으면 준비 상태와 구독을 정리한다",()=>{
  const {FakeRecorder,made}=fake(["video/webm"]),f=frames(),errors=[];
  const r=create({canvas:canvas(),onFrame:f.onFrame,redraw:()=>false,createCanvas:mirrorFactory().create,Recorder:FakeRecorder,onSave(){},onError:m=>errors.push(m)});
  assert.equal(r.start(),false);assert.equal(r.isRecording(),false);assert.equal(f.count,0);assert.equal(made.length,0);assert.equal(errors.length,1);assert.equal(time.pending,0);
});
(async()=>{for(const [name,fn] of queue){await fn();passed++;console.log("PASS",name);}console.log(`Recorder: ${passed} passed`);})().catch(error=>{console.error(error);process.exit(1);}); // 실패한 테스트의 녹화 타이머가 남아도 끝나게
