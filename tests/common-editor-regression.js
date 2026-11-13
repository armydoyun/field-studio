require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/common-editor-regression.js — 다른 탭의 편집기 도우미가 Common 탭의 이름을 아는지(js/glsl-language.js)
//  · 자동 완성 후보 · 마우스 설명 · 시그니처 도움말 · 타입(스위즐 · 구조체 필드)에 Common의 함수 · 전역 변수 · 구조체 · #define
//  · 함수 안의 지역 변수 · 매개변수는 Common 밖으로 보이지 않는다 · 이 탭에 같은 이름이 있으면 이 탭 것이 먼저
// F12로 Common 탭에 가는 동작은 tests/common-browser-regression.js가 본다.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","js",file),"utf8"),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const Language=load("glsl-language.js"),Highlight=load("glsl-highlight.js");
let passed=0;const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};
const COMMON=["// Common","uniform float uGain;","const vec3 SUN = vec3(0.0, 1.0, 0.0);","struct Light { vec3 dir; float power; };","#define TAU 6.2831853",
  "float wobble(float t, float amount) {","    float local = sin(t);","    return local * amount;","}"].join("\n");
const make=(source,shared=COMMON)=>Language.create({options:{builtins:[],shared:()=>shared},uniformNames:()=>[],highlighter:Highlight.create([]),source:()=>source});
const labels=(lang,src,prefix="")=>lang.gatherItems(src,src.length,src.length-prefix.length).items.filter(i=>i.kind!=="snippet").map(i=>i.label);

test("자동 완성: Common의 함수 · Uniform · 상수 · 구조체 · #define이 후보에 있고, 지역 변수 · 매개변수는 없다",()=>{
  const src="void mainImage(out vec4 c, in vec2 p) {\n    c = vec4(",lang=make(src),items=labels(lang,src);
  for(const name of["wobble","uGain","SUN","Light","TAU"])assert(items.includes(name),`${name} 후보`);
  for(const name of["local","amount"])assert(!items.includes(name),`${name}(Common 함수 안)은 후보가 아님`);
  const fn=lang.gatherItems(src,src.length,src.length).items.find(i=>i.label==="wobble");
  assert.match(fn.desc,/Common 탭의 함수 · 6번째 줄/);
});
test("마우스 설명 · 시그니처: Common의 함수와 변수를 설명한다",()=>{
  const src="void mainImage(out vec4 c, in vec2 p) { c = vec4(wobble(p.x, 1.0)); }",lang=make(src);
  assert.deepEqual({...lang.describeFunction("wobble")},{sig:"float wobble(float t, float amount)",desc:"Common 탭의 함수 · 6번째 줄"});
  assert.equal(lang.describeSymbol("uGain",10).sig,"uniform float uGain");
  assert.match(lang.describeSymbol("SUN",10).desc,/Common 탭 · 3번째 줄/);
  assert.match(lang.describeSymbol("TAU",10).sig,/#define TAU 6.2831853/);
  assert.match(lang.describeSymbol("Light",10).sig,/struct Light \{ vec3 dir; float power; \}/);
});
test("점 뒤 후보: Common의 상수 · 구조체 타입을 따라 스위즐과 필드를 제안한다",()=>{
  let src="void mainImage(out vec4 c, in vec2 p) { c.rgb = SUN.",lang=make(src),r=lang.gatherItems(src,src.length,src.length);
  assert(r.member&&r.items.some(i=>i.label==="xyz"),"vec3 SUN → 스위즐");
  src="Light key;\nvoid mainImage(out vec4 c, in vec2 p) { c.rgb = key.";lang=make(src);r=lang.gatherItems(src,src.length,src.length);
  assert.deepEqual(r.items.map(i=>i.label),["dir","power"],"Common의 struct Light 필드");
});
test("이 탭에 같은 이름이 있으면 이 탭 것이 먼저 · Common 탭 자신(shared 없음)은 예전과 같다",()=>{
  const src="float wobble(float t) { return t; }\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(",lang=make(src);
  assert.match(lang.describeFunction("wobble").desc,/이 패스에 정의된 함수/);
  assert.equal(labels(lang,src).filter(x=>x==="wobble").length,1,"후보는 한 번");
  const alone=make(src,"");
  assert.equal(alone.describeSymbol("SUN",0),null);
  assert(!labels(alone,src).includes("TAU"));
});
console.log(`Common editor: ${passed} passed`);
