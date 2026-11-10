require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/example-annotations-regression.js — 앱이 주는 예제의 파라미터는 셰이더 소스의 @어노테이션에 적혀 있어야 한다.
// 그래야 코드를 복사해 다른 프로젝트에 붙여도 슬라이더 범위·기본값·컬러 피커가 따라온다.
// 검사: 갤러리(Shader Art · 커뮤니티 · 기법 배우기) · 입문 과정 · Studio 버퍼 예제 · Ray Marching 예제의 모든 사용자 Uniform이
//  · 어노테이션이 있고 오류 없이 읽히며 @default로 기본값을 정한다
//  · 색으로 쓰는 vec3/vec4는 @color가 있다
//  · 갤러리가 JS 쪽에 따로 값 목록(users)을 두지 않는다(값이 두 곳에 있으면 어긋난다)
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const root=path.join(__dirname,"..");
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(root,"js",file),"utf8"),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const Annotations=load("annotations.js"),Shader=load("shader.js");
// 렌더러가 주는 값과 텍스처: 어노테이션 대상이 아니다.
const BUILTIN=new Set(["uResolution","uTime","uDeltaTime","uFrame","uMouse","uWheel","uDebugRaySteps","uMaxSteps","uMaxDistance","uSurfaceEpsilon","uNormalEpsilon","iChannelResolution"]);
// 이름으로 색인 것을 알아본다. 새 색 Uniform 이름이 여기에 안 걸리면 목록에 더한다.
const COLOR_NAME=/col|color|tint|sky|fog|ink|lead|glow|hot|cool|back|high|low|sun/i;
// 파일 안의 모든 Uniform 선언 줄(템플릿 문자열의 실제 줄과 head("…\n…") 같은 한 줄짜리 문자열 둘 다).
const declarations=(text,where)=>text.split(/\n|\\n/).map(line=>line.replace(/^\s*["`]?/,"")).filter(line=>/^uniform\s/.test(line))
  .map(line=>({where,line:line.replace(/["`].*$/,""),name:(line.match(/^uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)/)||[])[1],type:(line.match(/^uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)/)||[])[1]}))
  .filter(d=>d.name&&!BUILTIN.has(d.name)&&!/^sampler/.test(d.type)&&!/^iChannel/.test(d.name));
const FILES=["gallery.js","community-examples.js","technique-examples.js","course.js","studio-examples.js"];
const found=[...FILES.flatMap(file=>declarations(fs.readFileSync(path.join(root,"js",file),"utf8"),file)),...declarations(Shader.raymarch,"shader.js raymarch")];
let passed=0;const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};
test(`예제 사용자 Uniform을 찾았다 (${found.length}개)`,()=>{
  assert(found.length>=40,"선언을 너무 적게 찾았다 — 검사 정규식을 확인");
  for(const name of ["uTint","uWarp","uSunCol","uHeight","uRMMaxSteps","uRMHeatmap","uCells"])assert(found.some(d=>d.name===name),name);
});
test("모든 예제 Uniform에 어노테이션이 있고 @default로 기본값을 정한다",()=>{
  const missing=found.filter(d=>!/\/\/.*@default\b/.test(d.line)).map(d=>`${d.where}: ${d.line.trim()}`);
  assert.deepEqual(missing,[]);
});
test("어노테이션이 오류 없이 읽히고 선언과 같은 이름·타입이 된다",()=>{
  const problems=[];
  for(const d of found){const [item]=Annotations.collect([d.line]);
    if(!item)problems.push(`${d.where}: 읽히지 않음 — ${d.line.trim()}`);
    else if(item.error)problems.push(`${d.where}: ${item.name} — ${item.error}`);
    else if(item.name!==d.name||item.type!==d.type)problems.push(`${d.where}: ${d.line.trim()}`);}
  assert.deepEqual(problems,[]);
});
test("색으로 쓰는 vec3/vec4에는 @color가 있다",()=>{
  const missing=found.filter(d=>/^vec[34]$/.test(d.type)&&COLOR_NAME.test(d.name)&&!/@(color|dir)\b/.test(d.line)).map(d=>`${d.where}: ${d.line.trim()}`);
  assert.deepEqual(missing,[]);
});
test("@color가 붙은 값은 0~1 안이다",()=>{
  for(const d of found.filter(d=>/@color\b/.test(d.line))){const [item]=Annotations.collect([d.line]);
    assert(item.value.every(v=>v>=0&&v<=1),`${d.where}: ${d.name} = ${item.value}`);}
});
test("갤러리 예제는 JS에 따로 값 목록(users)을 두지 않는다",()=>{
  for(const file of ["gallery.js","community-examples.js","technique-examples.js"])assert(!/^\s*users:/m.test(fs.readFileSync(path.join(root,"js",file),"utf8")),file);
});
test("Ray Marching 예제의 어노테이션은 rayUniforms와 같다",()=>{
  const specs=Annotations.collect([Shader.raymarch]);
  assert.equal(specs.length,Shader.rayUniforms.length);
  for(const [name,type,value,options={}] of Shader.rayUniforms){const spec=specs.find(s=>s.name===name);
    assert(spec,name);assert.equal(spec.type,type);assert.deepEqual(spec.value,value);assert(Annotations.sameOptions(spec.options,options),name);}
});
console.log(`Example annotations: ${passed} passed`);
