require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/glsl-prepare-regression.js — 컴파일 직전 GLSL 다듬기(js/glsl-prepare.js)
//  · #version이 없으면 "#version 300 es" + "precision highp float;"을 붙이고 #line으로 사용자 줄 번호를 지킨다
//  · main()이 없고 mainImage(out vec4, in vec2)가 있으면 가짜 진입점 main()을 붙인다
//  · #version이 있는 코드는 예전 동작(precision 뒤에 Uniform 선언 · injected 줄 정보) 그대로
// 실제 GLSL 컴파일 · 오류 줄 번호는 tests/glsl-prepare-browser-regression.js가 본다.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","js",file),"utf8"),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const {prepareFragment}=load("glsl-prepare.js");
let passed=0;const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};
// "#line N" 지시문을 따라 컴파일러가 매길 줄 번호 → 그 줄의 내용 (GLSL ES 3.00: #line N 다음 줄이 N번)
// 나중 줄이 같은 번호를 다시 쓰면(#line) 나중 것이 그 번호다. 끝에 붙인 진입점 줄(mainImage 줄 번호를 일부러 다시 씀)은 뺀다.
const compilerLines=src=>{const map=new Map();let n=1;for(const line of src.split("\n")){const m=/^#line (\d+)$/.exec(line);if(m){n=Number(m[1]);continue;}if(!/void main\(\) \{ vec4 color/.test(line))map.set(n,line);n++;}return map;};

test("#version이 없으면 머리말을 붙이고 사용자 줄 번호를 그대로 둔다",()=>{
  const user="uniform vec2 uResolution;\nout vec4 fragColor;\nvoid main() {\n    fragColor = vec4(gl_FragCoord.xy / uResolution, 0.0, 1.0);\n}";
  const out=prepareFragment(user);
  assert(out.source.startsWith("#version 300 es\n"),"첫 줄은 #version");
  assert(/\nprecision highp float;\n/.test(out.source),"precision");
  assert.equal(out.header,true);assert.equal(out.entry,false);assert.equal(out.injected,undefined);
  const lines=compilerLines(out.source),userLines=user.split("\n");
  userLines.forEach((line,i)=>assert.equal(lines.get(i+1),line,`사용자 ${i+1}번 줄`));
});
test("precision은 #extension · #define 같은 앞쪽 전처리 줄 뒤, 첫 코드 줄 앞에 넣는다",()=>{
  const user="// 주석\n#extension GL_EXT_example : enable\n#define SCALE 2.0\n\nout vec4 o;\nvoid main(){ o = vec4(SCALE); }";
  const out=prepareFragment(user).source;
  assert(out.indexOf("#extension")<out.indexOf("precision highp float;"),"전처리 줄이 먼저");
  assert(out.indexOf("precision highp float;")<out.indexOf("out vec4 o;"),"precision이 첫 선언보다 먼저");
  const lines=compilerLines(out);
  user.split("\n").forEach((line,i)=>assert.equal(lines.get(i+1),line,`사용자 ${i+1}번 줄`));
});
test("등록한 Uniform 선언도 머리말에 넣는다(사용자 줄 번호는 그대로)",()=>{
  const user="out vec4 o;\nvoid main(){ o = vec4(uGain); }";
  const out=prepareFragment(user,["uniform float uGain;"]);
  assert(/precision highp float;\nuniform float uGain;\n#line 1\n/.test(out.source),out.source);
  assert.equal(out.injected,undefined,"#line이 줄 번호를 맞추므로 따로 되돌릴 정보가 없다");
});
test("main이 없고 mainImage가 있으면 가짜 진입점을 붙인다",()=>{
  const user="uniform vec2 uResolution;\n\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord) {\n    fragColor = vec4(fragCoord / uResolution, 0.0, 1.0);\n}";
  const out=prepareFragment(user);
  assert.equal(out.entry,true);
  assert(/\nout vec4 field_FragColor_; void main\(\) \{ vec4 color = vec4\(0\.0, 0\.0, 0\.0, 1\.0\); mainImage\(color, gl_FragCoord\.xy\); field_FragColor_ = color; \}\n$/.test(out.source),out.source);
  // 진입점은 mainImage 정의 줄(3번)을 가리키는 한 줄
  const lines=compilerLines(out.source);
  assert(lines.get(3).startsWith("void mainImage"),"사용자 3번 줄은 그대로");
  assert(/#line 3\nout vec4 field_FragColor_;/.test(out.source),"진입점 오류는 mainImage 줄을 가리킨다");
});
test("전역 out vec4를 이미 선언했으면 그 변수에 쓴다(출력이 둘이 되지 않게)",()=>{
  const out=prepareFragment("out vec4 fragColor;\nvoid mainImage(out vec4 c, in vec2 p){ c = vec4(1.0); }").source;
  assert(!out.includes("field_FragColor_"),"새 출력 변수를 만들지 않는다");
  assert(/mainImage\(color, gl_FragCoord\.xy\); fragColor = color; \}/.test(out));
});
test("main()이 있으면 mainImage가 있어도 진입점을 붙이지 않는다 · 주석 속 글자에 속지 않는다",()=>{
  assert.equal(prepareFragment("out vec4 o;\nvoid mainImage(out vec4 c, in vec2 p){ c = vec4(1.0); }\nvoid main(){ mainImage(o, gl_FragCoord.xy); }").entry,false);
  assert.equal(prepareFragment("out vec4 o;\n// void mainImage(out vec4 c, in vec2 p)\nvoid main(){ o = vec4(1.0); }").entry,false);
  assert.equal(prepareFragment("out vec4 o;\n/* void main() */\nvoid mainImage(out vec4 c, in vec2 p){ c = vec4(1.0); }").entry,true);
});
test("#version이 있는 코드는 예전과 같다(precision 뒤 선언 · injected), mainImage 진입점은 밀린 줄을 반영",()=>{
  const user="#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){ o = vec4(uGain); }";
  const out=prepareFragment(user,["uniform float uGain;"]);
  assert.equal(out.source,"#version 300 es\nprecision highp float;\nuniform float uGain;\nout vec4 o;\nvoid main(){ o = vec4(uGain); }");
  assert.deepEqual(JSON.parse(JSON.stringify(out.injected)),{after:2,count:1,generated:1});
  assert.equal(prepareFragment("#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){ o = vec4(1.0); }").source,"#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){ o = vec4(1.0); }","선언이 없으면 그대로");
  // 선언 1줄이 들어가 mainImage(사용자 3번 줄)는 컴파일러 기준 4번 줄 → studio가 1을 빼 3번 줄로 보여 준다
  const entry=prepareFragment("#version 300 es\nprecision highp float;\nvoid mainImage(out vec4 c, in vec2 p){ c = vec4(uGain); }",["uniform float uGain;"]).source;
  assert(/\n#line 4\nout vec4 field_FragColor_;/.test(entry),entry);
  assert.throws(()=>prepareFragment("#version 300 es\nout vec4 o;\nvoid main(){}",["uniform float uGain;"]),/precision/);
});
test("주석이 맨 위에 있어도 #version을 알아본다",()=>{
  const user="// 설명\n#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){ o = vec4(1.0); }";
  assert.equal(prepareFragment(user).source,user);
});
test("여러 출력(MRT): out vec4 매개변수 순서대로 layout(location = N) 출력을 만들어 연결한다",()=>{
  const out=prepareFragment("void mainImage(out vec4 color, out vec4 data, in vec2 fragCoord) { color = vec4(1.0); data = vec4(fragCoord, 0.0, 1.0); }").source;
  assert(/layout\(location = 0\) out vec4 field_FragColor0_; layout\(location = 1\) out vec4 field_FragColor1_; void main\(\) \{ vec4 color0 = vec4\(0\.0, 0\.0, 0\.0, 1\.0\), color1 = vec4\(0\.0, 0\.0, 0\.0, 1\.0\); mainImage\(color0, color1, gl_FragCoord\.xy\); field_FragColor0_ = color0; field_FragColor1_ = color1; \}/.test(out),out);
  assert(!/out vec4 field_FragColor_;/.test(out),"출력 하나짜리 선언은 만들지 않는다");
});
test("여러 출력을 이미 같은 수만큼 선언했으면 location 순서대로 그 변수에 쓴다",()=>{
  const out=prepareFragment("layout(location = 1) out vec4 second;\nlayout(location = 0) out vec4 first;\nvoid mainImage(out vec4 a, out vec4 b, in vec2 p) { a = vec4(1.0); b = vec4(0.5); }").source;
  assert(!out.includes("field_FragColor"),"새 출력을 만들지 않는다");
  assert(/first = color0; second = color1;/.test(out),out);
});
test("출력이 하나면 예전과 같다(전역 out이 layout으로 선언돼 있어도 그 변수에 쓴다)",()=>{
  const out=prepareFragment("layout(location = 0) out vec4 result;\nvoid mainImage(out highp vec4 c, in vec2 p) { c = vec4(1.0); }").source;
  assert(/mainImage\(color, gl_FragCoord\.xy\); result = color; \}/.test(out),out);
});
console.log(`GLSL prepare: ${passed} passed`);
