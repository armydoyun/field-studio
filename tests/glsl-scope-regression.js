// node tests/glsl-scope-regression.js — GLSL 범위 분석(js/glsl-scope.js): 이름 바꾸기(F2)·정의로 이동이 그 선언만 다루는지 본다.
'use strict';
const path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
let passed=0;const check=(ok,label)=>{assert(ok,label);passed++;console.log('PASS',label);};

const SRC=`#version 300 es
precision highp float;
uniform float uSpeed; // @range 0 2
uniform vec2 uResolution;
out vec4 fragColor;
struct Ray { vec3 o; vec3 d; };
struct Hit { Ray ray; float t; };
#define TWICE(v) (v * 2.0)
#define GAIN (x * 0.5)
float x = 1.0;
float shade(float x);
float shade(float x) { return x * 0.5; }
float shade(vec2 p) { return p.x; }
void main() {
    float x = 2.0, y = x + 1.0, arr[3];
    Ray r; r.o = vec3(x); Hit h; h.t = r.o.x;
    for (int i = 0, j = 1; i < 3; i++) x += float(i + j);
    for (int i = 0; i < 2; i++) { float k = float(i); x += k; }
    for (int a = 0; a < 2; a++) for (int b = 0; b < 2; b++) { x += float(a * b); }
    {
        float x = 3.0;
        y += x;
    }
    float value = 0.0; value . x;
    fragColor = vec4(shade(x) * uSpeed, shade(vec2(1.0)), TWICE(x), y);
}
void other() { float x = 4.0; float y = x; }`;

(async()=>{
  const S=await import(pathToFileURL(path.join(root,'js','glsl-scope.js')).href);
  const nth=(text,n=0)=>{let p=-1;for(let k=0;k<=n;k++){p=SRC.indexOf(text,p+1);if(p<0)throw Error('없음 '+text);}return p;};
  const line=at=>SRC.slice(0,at).split('\n').length;
  const plan=(text,n=0,next=null,offset=0)=>S.planRename(SRC,nth(text,n)+offset,next,{macros:['TWICE','GAIN']});
  const lines=p=>p.lines.join(',');
  const L=t=>String(line(nth(t)));

  check(S.analyze(SRC).balanced,'괄호 짝이 맞는 소스');
  // 전역 x: 함수들 안의 지역 x·매개변수 x와 구분된다. 쓰는 곳이 없으므로 선언 한 줄뿐.
  const globalX=plan('float x = 1.0',0,null,6);
  check(globalX.ok&&globalX.label==='전역 변수'&&lines(globalX)===L('float x = 1.0'),`전역 x는 자기 선언만: ${lines(globalX)}`);
  // main의 지역 x: 같은 함수의 쓰임만, 안쪽 블록의 x와 other의 x는 제외
  const mainX=plan('float x = 2.0',0,null,6);
  const inner=line(nth('float x = 3.0')),other=line(nth('void other'));
  check(mainX.label==='main 함수의 지역 변수','main의 지역 변수로 설명');
  check(!mainX.lines.includes(inner+1)&&!mainX.lines.includes(other),'안쪽 블록에서 가린 x와 다른 함수의 x는 바꾸지 않는다');
  check(mainX.spots.length===8,`main의 x 쓰임 전부(선언·y 초기화·vec3·두 for 본문·중괄호 없는 중첩 for·shade·TWICE 인수): ${mainX.spots.length}`);
  // 안쪽 블록의 x
  const innerX=plan('float x = 3.0',0,null,6);
  check(innerX.lines.join()===`${inner},${inner+1}`,'안쪽 블록의 x는 그 블록 안에서만');
  // 매개변수
  const param=plan('return x * 0.5',0,null,7);
  check(param.label==='shade 함수의 매개변수'&&lines(param)===L('float shade(float x) {'),'함수 매개변수는 그 함수 안에서만');
  // 오버로드 묶음 · 원형
  const fn=plan('shade(x) *');
  check(fn.label==='함수 (오버로드 3개 모두)'&&fn.spots.length===5,`함수는 원형·정의·오버로드·호출 모두: ${fn.spots.length}`);
  // for 초기화: 첫 for의 i와 둘째 for의 i는 다른 변수
  const i1=plan('int i = 0, j',0,null,4),i2=plan('int i = 0; i < 2',0,null,4);
  check(i1.lines.join()===L('int i = 0, j')&&i1.spots.length===4,'중괄호 없는 for 본문까지 i (선언·조건·증가·본문)');
  check(i2.spots.length===4&&!i2.spots.some(at=>i1.spots.includes(at)),'둘째 for의 i는 따로');
  check(plan('j = 1').spots.length===2,'for 초기화의 쉼표 선언(j)');
  check(plan('int b = 0',0,null,4).spots.length===4,'중괄호 없는 for 안의 for 변수(선언·조건·증가·본문)');
  check(plan('int a = 0',0,null,4).spots.length===4,'중괄호 없는 바깥 for의 변수가 안쪽 for 본문까지 이어진다');
  // 쉼표 선언 · 배열
  check(plan('y = x + 1.0').label==='main 함수의 지역 변수'&&plan('y = x + 1.0').spots.length===3,'쉼표로 이어진 선언(y): main의 y만');
  check(plan('arr[3]').ok,'배열 선언');
  // 구조체 타입 · 필드
  const ray=plan('Ray r');
  check(ray.label==='구조체 타입'&&ray.spots.length===3,`구조체 이름: 정의·다른 구조체의 필드 타입·변수 선언 ${ray.spots.length}`);
  check(plan('o; vec3 d').reason==='field'&&plan('r.o',0,null,2).reason==='field','구조체 필드·.뒤 이름은 거절');
  check(plan('value . x',0,null,8).reason==='field',"'value . x'처럼 공백 있는 필드도 거절");
  // Uniform · 내장 · 매크로
  const u=plan('uSpeed',1);
  check(u.label==='전역 Uniform'&&u.symbol.uniform&&u.spots.length===2,'Uniform: 선언과 쓰임');
  check(plan('vec4(shade',0).reason==='none'&&plan('float(i)',0,null,0).reason==='none','타입·생성자 위의 커서는 이름 아님');
  check(plan('TWICE(x)').reason==='macro','매크로 이름은 범위 대신 전체 바꾸기로 넘긴다');
  check(S.macroSpots(SRC,'TWICE').length===2,'매크로 이름: #define 줄과 쓰는 곳');
  check(globalX.warnings.some(w=>w.includes('#define')),'매크로 본문에 같은 이름(GAIN의 x)이 있으면 경고');
  // 충돌: 같은 범위 · 가려짐 · 기존 이름을 가림
  check(plan('float x = 2.0',0,'y',6).conflicts.some(c=>c.includes('같은 범위')),'같은 범위의 y와 겹침');
  check(plan('float k',0,'x',6).conflicts.some(c=>c.includes('바꾼 이름을 가리키게')),"for 안의 k를 x로: 지금 x를 쓰는 곳이 k를 가리키게 됨");
  check(plan('float x = 1.0',0,'k',6).conflicts.length===0,'전역 x를 k로: 겹침 없음(for 안의 k는 다른 범위)');
  check(plan('j = 1',0,'i').conflicts.some(c=>c.includes('같은 범위')),'for 초기화에서 이미 있는 i와 겹침');
  // 정의 찾기에 쓰는 symbolAt
  check(S.symbolAt(SRC,nth('y += x')+5).symbol.at===nth('float x = 3.0')+6,'안쪽 블록의 x 참조 → 안쪽 선언');
  // 다른 패스: 이름으로 전역 Uniform 찾기 · 적용
  const other2='#version 300 es\nuniform float uSpeed;\nvoid main(){ float s = uSpeed; { float uSpeed = 1.0; s += uSpeed; } }';
  const g=S.planGlobal(other2,'uSpeed','uRate');
  check(g&&g.spots.length===2,'다른 패스의 같은 Uniform: 전역 선언과 그것을 가리키는 쓰임만');
  check(S.applyRename(other2,g.spots,'uSpeed','uRate')==='#version 300 es\nuniform float uRate;\nvoid main(){ float s = uRate; { float uSpeed = 1.0; s += uSpeed; } }','적용 결과(가린 지역 uSpeed는 그대로)');
  // 작성 중(괄호 짝 안 맞음)
  const open='void main() {\n float a = 1.0;\n a += 1.0;\n';
  check(S.planRename(open,open.indexOf('a +=')).reason==='braces','괄호 짝이 맞지 않으면 범위 분석을 쓰지 않는다');
  console.log(`GLSL scope: ${passed} checks passed`);
})().catch(error=>{console.error(error);process.exit(1);});
