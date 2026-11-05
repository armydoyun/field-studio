require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/recorder-regression.js — 뷰포트 녹화(recorder.js): 형식 고르기, 시작·중지·저장, 오류와 폐기 처리. MediaRecorder는 가짜로 바꾼다.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
let Recorder;
vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../js/recorder.js"),"utf8"),{
  define:(deps,factory)=>Recorder=factory(),performance:{now:()=>Date.now()},setInterval,clearInterval,Blob,Math,String,Date
},{filename:"recorder.js"});
// 가짜 MediaRecorder: start()로 녹화, stop()하면 받아 둔 조각을 dataavailable로 넘기고 stop을 알린다.
const fake=(supportedTypes,{fail=false,emptyData=false}={})=>{
  const made=[];
  class FakeRecorder{
    static isTypeSupported(type){return supportedTypes.includes(type);}
    constructor(stream,options){if(fail)throw new Error("codec busy");this.stream=stream;this.options=options;this.mimeType=options.mimeType||"";this.state="inactive";this.listeners={};made.push(this);}
    addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
    emit(type,event={}){for(const fn of this.listeners[type]||[])fn(event);}
    start(slice){this.state="recording";this.slice=slice;}
    stop(){this.state="inactive";if(!emptyData)this.emit("dataavailable",{data:new Blob(["frame"],{type:this.mimeType})});this.emit("stop");}
  }
  return {FakeRecorder,made};
};
const canvas=()=>{const tracks=[{stopped:false,stop(){this.stopped=true;}}];return {tracks,fps:null,captureStream(fps){this.fps=fps;return {getTracks:()=>tracks};}};};
let passed=0;const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};

test("WebM VP9를 먼저 고르고, 없으면 MP4로 물러난다",()=>{
  assert.equal(Recorder.pickMimeType(fake(["video/webm;codecs=vp9","video/webm"]).FakeRecorder),"video/webm;codecs=vp9");
  assert.equal(Recorder.pickMimeType(fake(["video/mp4"]).FakeRecorder),"video/mp4");
  assert.equal(Recorder.pickMimeType(fake([]).FakeRecorder),"");
  assert.equal(Recorder.pickMimeType(undefined),"");
});
test("지원 여부: MediaRecorder와 captureStream이 모두 있어야 한다",()=>{
  const {FakeRecorder}=fake(["video/webm"]);
  assert.equal(Recorder.supported(canvas(),FakeRecorder),true);
  assert.equal(Recorder.supported({},FakeRecorder),false);
  assert.equal(Recorder.supported(canvas(),undefined),false);
});
test("경과 시간과 파일 이름 형식",()=>{
  assert.equal(Recorder.formatElapsed(0),"0:00");assert.equal(Recorder.formatElapsed(7900),"0:07");
  assert.equal(Recorder.formatElapsed(62000),"1:02");assert.equal(Recorder.formatElapsed(3723000),"1:02:03");
  const at=new Date(2026,10,5,9,3,7);
  assert.equal(Recorder.fileName("video/webm;codecs=vp9",at),"shader-20261105-090307.webm");
  assert.equal(Recorder.fileName("video/mp4",at),"shader-20261105-090307.mp4");
});
test("시작 → 중지하면 한 번 저장하고 스트림을 닫는다",()=>{
  const {FakeRecorder,made}=fake(["video/webm;codecs=vp9"]),c=canvas(),saved=[],changes=[];
  const r=Recorder.create({canvas:c,Recorder:FakeRecorder,onSave:(blob,name)=>saved.push({blob,name}),onChange:x=>changes.push(x.recording)});
  assert.equal(r.start(),true);assert.equal(r.isRecording(),true);assert.equal(r.start(),false,"녹화 중에 다시 시작하지 않음");
  assert.equal(c.fps,60);assert.equal(made[0].options.mimeType,"video/webm;codecs=vp9");assert(made[0].options.videoBitsPerSecond>=8e6);assert.equal(made[0].slice,1000);
  assert.equal(r.stop(),true);assert.equal(r.isRecording(),false);assert.equal(r.stop(),false);
  assert.equal(saved.length,1);assert.match(saved[0].name,/^shader-\d{8}-\d{6}\.webm$/);assert.equal(saved[0].blob.size,5);
  assert(c.tracks.every(t=>t.stopped),"캡처 트랙 정리");assert.deepEqual([changes[0],changes.at(-1)],[true,false]);
});
test("toggle은 시작과 중지를 오간다",()=>{
  const {FakeRecorder}=fake(["video/webm"]),saved=[];
  const r=Recorder.create({canvas:canvas(),Recorder:FakeRecorder,onSave:()=>saved.push(1)});
  r.toggle();assert.equal(r.isRecording(),true);r.toggle();assert.equal(r.isRecording(),false);assert.equal(saved.length,1);
});
test("지원하지 않는 브라우저·시작 실패는 오류로 알리고 녹화 상태가 되지 않는다",()=>{
  const errors=[];
  assert.equal(Recorder.create({canvas:{},Recorder:fake([]).FakeRecorder,onSave(){},onError:m=>errors.push(m)}).start(),false);
  const c=canvas(),r=Recorder.create({canvas:c,Recorder:fake(["video/webm"],{fail:true}).FakeRecorder,onSave(){},onError:m=>errors.push(m)});
  assert.equal(r.start(),false);assert.equal(r.isRecording(),false);assert(c.tracks.every(t=>t.stopped),"실패해도 트랙 정리");
  assert.equal(errors.length,2);assert.match(errors[1],/codec busy/);
});
test("빈 녹화는 저장하지 않고 알린다",()=>{
  const errors=[],saved=[],r=Recorder.create({canvas:canvas(),Recorder:fake(["video/webm"],{emptyData:true}).FakeRecorder,onSave:()=>saved.push(1),onError:m=>errors.push(m)});
  r.start();r.stop();assert.equal(saved.length,0);assert.equal(errors.length,1);
});
test("녹화 중 오류·폐기(dispose)는 파일을 내려받지 않는다",()=>{
  const {FakeRecorder,made}=fake(["video/webm"]),saved=[],errors=[];
  const r=Recorder.create({canvas:canvas(),Recorder:FakeRecorder,onSave:()=>saved.push(1),onError:m=>errors.push(m)});
  r.start();made[0].emit("error",{error:new Error("gpu reset")});assert.equal(r.isRecording(),false);assert.match(errors[0],/gpu reset/);
  r.start();r.dispose();assert.equal(r.isRecording(),false);assert.equal(saved.length,0);
});
console.log(`Recorder: ${passed} passed`);
