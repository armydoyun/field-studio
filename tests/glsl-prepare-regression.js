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
// 나중 줄이 같은 번호를 다시 쓰면(#line) 나중 것이 그 번호다. 끝에 붙인 진입점 줄(mainImage 줄 번호를 일부러 다시 씀)과 그 뒤는 뺀다.
const compilerLines=src=>{const map=new Map();let n=1;for(const line of src.split("\n")){const m=/^#line (\d+)$/.exec(line);if(m){n=Number(m[1]);continue;}if(/void main\(\) \{ vec4 color/.test(line))break;map.set(n,line);n++;}return map;};

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
test("Shadertoy 이름: 선언 없이 쓴 iTime·iResolution·iMouse·iFrame·iTimeDelta를 FIELD Uniform에 연결한다",()=>{
  const user="void mainImage(out vec4 c, in vec2 p) {\n    c = vec4(p / iResolution.xy, 0.5 + 0.5 * sin(iTime + iTimeDelta), 1.0) + iMouse * 0.0 + float(iFrame) * 0.0;\n}";
  const out=prepareFragment(user).source;
  for(const line of["uniform float uTime;","#define iTime uTime","uniform float uDeltaTime;","#define iTimeDelta uDeltaTime","uniform int uFrame;","#define iFrame uFrame","uniform vec2 uResolution;","#define iResolution vec3(uResolution.xy, 1.0)","uniform vec4 uMouse;","#define iMouse uMouse"])
    assert(out.includes("\n"+line+"\n"),line+"\n"+out);
  assert(out.indexOf("precision highp float;")<out.indexOf("#define iTime"),"precision 뒤에 넣는다");
  const lines=compilerLines(out);user.split("\n").forEach((line,i)=>assert.equal(lines.get(i+1),line,`사용자 ${i+1}번 줄`));
});
test("Shadertoy 이름: 이미 선언한 FIELD Uniform은 다시 선언하지 않고 그 타입에 맞춰 연결한다",()=>{
  const out=prepareFragment("uniform vec3 uResolution;\nuniform float uFrame;\nuniform vec2 uMouse;\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(iResolution.xy, float(iFrame), iMouse.x); }").source;
  assert(!/uniform vec2 uResolution;|uniform int uFrame;|uniform vec4 uMouse;/.test(out),out);
  assert(out.includes("#define iFrame int(uFrame)")&&out.includes("#define iMouse vec4(uMouse, 0.0, 0.0)")&&out.includes("#define iResolution vec3(uResolution.xy, 1.0)"),out);
});
test("Shadertoy 이름: 쓰지 않거나 직접 정의한 이름은 건드리지 않는다(주석 속 글자에도 속지 않는다)",()=>{
  const plain="out vec4 o;\nvoid main(){ o = vec4(1.0); } // iTime";
  assert(!prepareFragment(plain).source.includes("#define"),"쓰지 않으면 없음");
  const own="uniform float uTime;\n#define iTime uTime\nfloat iFrame = 3.0;\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(iTime, iFrame, 0.0, 1.0); }";
  const out=prepareFragment(own).source;
  assert.equal(out.split("#define iTime").length,2,"#define iTime은 사용자 것 하나");
  assert(!out.includes("#define iFrame")&&!out.includes("uniform int uFrame"),out);
});
test("Shadertoy 이름: #version이 있는 코드는 precision 뒤에 넣고 injected 줄 정보에 센다",()=>{
  const user="#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){ o = vec4(iTime); }";
  const out=prepareFragment(user);
  assert.equal(out.source,"#version 300 es\nprecision highp float;\nuniform float uTime;\n#define iTime uTime\nout vec4 o;\nvoid main(){ o = vec4(iTime); }");
  assert.deepEqual(out.injected,{after:2,count:2,generated:2});
});
// "#line N S"까지 따라 (소스번호, 줄) → 내용. 진입점 줄과 그 뒤는 뺀다.
// Common이 있으면 패스의 uniform 선언은 Common 앞으로 끌어올리고 원래 자리는 같은 길이 공백이 된다.
const blankUniform=line=>line.replace(/uniform\s[^;]*;/g,m=>" ".repeat(m.length));
const sourceLines=src=>{const map=new Map();let n=1,s=0;for(const line of src.split("\n")){const m=/^#line (\d+)(?: (\d+))?$/.exec(line);if(m){n=Number(m[1]);if(m[2]!==undefined)s=Number(m[2]);continue;}if(/void main\(\) \{ vec4 color/.test(line))break;map.set(`${s}:${n}`,line);n++;}return map;};
test("Common: 머리말 뒤 · 패스 코드 앞에 넣고, Common 줄은 소스 1번 · 패스 줄은 소스 0번 번호를 그대로 쓴다",()=>{
  const common="// 공용\nfloat hash(float x) { return fract(sin(x) * 43758.5); }\n#define TAU 6.2831853";
  const user="// 패스\nuniform float uTime;\nvoid mainImage(out vec4 c, in vec2 p) {\n    c = vec4(hash(iTime) * TAU);\n}";
  const out=prepareFragment(user,["uniform float uGain;"],{common}).source;
  assert(out.indexOf("precision highp float;")<out.indexOf("uniform float uGain;")&&out.indexOf("uniform float uGain;")<out.indexOf("float hash"),"precision → 선언 → Common");
  assert(out.indexOf("#define iTime uTime")<out.indexOf("float hash"),"Shadertoy 연결도 Common 앞");
  assert.equal(out.split("uniform float uTime;").length,2,"패스가 선언한 uTime은 한 번만(끌어올린 것)");
  assert(/\n#line 2 0\nuniform float uTime;\n#line 1 1\n\/\/ 공용/.test(out),"패스의 uniform은 원래 줄 번호로 Common 바로 앞에");
  const lines=sourceLines(out);
  common.split("\n").forEach((line,i)=>assert.equal(lines.get(`1:${i+1}`),line,`Common ${i+1}번 줄`));
  user.split("\n").forEach((line,i)=>assert.equal(lines.get(`0:${i+1}`),blankUniform(line),`패스 ${i+1}번 줄`));
  assert(/\n#line 3\nout vec4 field_FragColor_; void main\(\)/.test(out),"진입점은 패스의 mainImage 줄(소스 0번)");
});
test("Common: Shadertoy 이름을 Common에서만 써도 연결하고, Common의 #define은 존중한다",()=>{
  let out=prepareFragment("void mainImage(out vec4 c, in vec2 p) { c = vec4(t()); }",[],{common:"float t() { return iTime; }"}).source;
  assert(out.includes("#define iTime uTime")&&out.includes("uniform float uTime;"),out);
  out=prepareFragment("void mainImage(out vec4 c, in vec2 p) { c = vec4(iTime); }",[],{common:"uniform float uSpeed;\n#define iTime (uTime * uSpeed)\nuniform float uTime;"}).source;
  assert(!out.includes("#define iTime uTime")&&!/uniform float uTime;[\s\S]*uniform float uTime;/.test(out),out);
});
test("Common: 비었거나 공백뿐이면 아무것도 넣지 않는다",()=>{
  const user="out vec4 o;\nvoid main(){ o = vec4(1.0); }";
  assert.equal(prepareFragment(user,[],{common:"  \n"}).source,prepareFragment(user).source);
});
test("Common: #version이 있는 코드는 precision 뒤에 넣고, 패스 줄은 예전처럼 count만큼 밀린 번호(studio가 되돌림)",()=>{
  for(const precision of["precision highp float;","precision highp float; // 같은 줄에 주석"]){
    const user=`#version 300 es\n${precision}\nuniform float uTime;\nout vec4 o;\nvoid main(){ o = vec4(f()); }`;
    const out=prepareFragment(user,["uniform float uGain;"],{common:"float f() { return 1.0; }"});
    const lines=sourceLines(out.source),{after,count}=out.injected;
    assert.equal(lines.get("1:1"),"float f() { return 1.0; }");
    user.split("\n").forEach((line,i)=>{const n=i+1;if(n>after)assert.equal(lines.get(`0:${n+count}`),blankUniform(line),`패스 ${n}번 줄 → 컴파일러 ${n+count}`);});
    assert(out.source.includes(`\n#line ${3+count} 0\nuniform float uTime;\n#line 1 1\n`),"끌어올린 uniform도 같은 규칙의 번호(원래 줄 + count)");
  }
  const noDecl=prepareFragment("#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){ o = vec4(f()); }",[],{common:"float f() { return 1.0; }"});
  assert.deepEqual(noDecl.injected,{after:2,count:0,generated:0});
  assert.equal(sourceLines(noDecl.source).get("0:3"),"out vec4 o;");
});
test("Common의 Uniform: 패스 uniform을 Common 앞으로 끌어올려 Common이 uTime · 파라미터 · iChannel을 쓴다",()=>{
  const common="float pulse() { return sin(uTime * uSpeed); }\nvec4 pick(vec2 uv) { return texture(iChannel0, uv); }";
  const user="uniform float uTime;\nuniform float uSpeed; // @range 0 4\nuniform sampler2D iChannel0;\nvoid mainImage(out vec4 c, in vec2 p) { c = pick(p) * pulse(); }";
  const out=prepareFragment(user,[],{common}).source;
  for(const decl of["uniform float uTime;","uniform float uSpeed;","uniform sampler2D iChannel0;"]){
    assert.equal(out.split(decl).length,2,`${decl} 한 번`);
    assert(out.indexOf(decl)<out.indexOf("float pulse()"),`${decl}는 Common 앞`);
  }
  assert(out.includes("\n#line 2 0\nuniform float uSpeed;\n"),"끌어올린 줄은 원래 줄 번호");
  const lines=sourceLines(out);
  assert.equal(lines.get("0:2"),"                      // @range 0 4","원래 자리는 공백 · 뒤의 주석은 그대로");
});
test("Common의 Uniform: Common이 쓰는 앱 Uniform을 패스가 선언하지 않았으면 넣는다(이미 있거나 Common이 선언했으면 넣지 않는다)",()=>{
  const common="vec2 center() { return 0.5 * uResolution; }\nfloat t() { return uTime; }\nvec3 size0() { return iChannelResolution[0]; }";
  let out=prepareFragment("void mainImage(out vec4 c, in vec2 p) { c = vec4(center(), t(), size0().x); }",[],{common}).source;
  for(const decl of["uniform vec2 uResolution;","uniform float uTime;","uniform vec3 iChannelResolution[4];"])
    assert(out.includes(decl)&&out.indexOf(decl)<out.indexOf("vec2 center()"),`${decl}를 Common 앞에 넣는다`);
  out=prepareFragment("uniform vec3 uResolution;\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(center(), t(), 0.0); }",[],{common:"uniform float uTime;\n"+common}).source;
  assert(!out.includes("uniform vec2 uResolution;")&&out.split("uniform float uTime;").length===2,"패스(vec3) · Common이 선언한 것은 그대로");
  assert(!prepareFragment("void mainImage(out vec4 c, in vec2 p) { c = vec4(uTime); }",[],{common:"float k() { return 1.0; }"}).source.includes("uniform float uTime;"),"Common이 쓰지 않는 앱 Uniform은 넣지 않는다(패스의 미선언은 예전처럼 오류)");
});
test("Common의 Uniform: Common이 같은 이름을 선언했으면 패스 쪽은 지우기만, 구조체 · 상수 크기 배열은 그대로 둔다",()=>{
  const user="struct Light { vec3 dir; };\nconst int N = 3;\nuniform Light uLight;\nuniform vec3 uPoints[N];\nuniform float uGain;\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(uGain); }";
  const out=prepareFragment(user,[],{common:"uniform float uGain;\nfloat g() { return uGain; }"}).source;
  assert.equal(out.split("uniform float uGain;").length,2,"uGain은 Common의 선언 하나만");
  assert(out.includes("\nuniform Light uLight;\nuniform vec3 uPoints[N];\n"),"구조체 타입 · 상수 크기 배열은 제자리");
});
console.log(`GLSL prepare: ${passed} passed`);
