'use strict';
// node tests/parameter-widgets-regression.js — 표시 방식 어노테이션 @angle · @pos/@xy · @log · @enum: 파서 · 렌더러 검증 · 파라미터 패널 편집기 · 추가 폼.
require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const {fixture}=require('./logic-regression');
const root=path.join(__dirname,'..');
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(root,'js',file),'utf8'),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const Annotations=load('annotations.js');
const close=(a,b,eps=1e-6)=>assert(Math.abs(a-b)<=eps,`${a} ≈ ${b}`);
let passed=0,failed=0;
const run=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack);}};
const ui=async(name,fn)=>run(name,async()=>{const f=fixture();let mounted;try{
  const Node=f.canvas.constructor;Node.prototype.querySelector=()=>new Node();Node.prototype.querySelectorAll=()=>[];
  Node.prototype.setAttribute=function(k,v){(this.attrs??={})[k]=v;};Node.prototype.removeAttribute=function(k){delete this.attrs?.[k];};
  f.document.querySelectorAll=()=>[];
  for(const id of ['uniformType','uniformValue','uniformMin','uniformMax','uniformStep','uniformName','uniformSearch','uniformDisplay','uniformDisplayField','uniformEnumLabels','rangeFields'])f.document.getElementById(id);
  mounted=f.load('ui').mount(f.renderer,{getCamera:()=>null,resetCamera(){}},f.settings);
  const n=id=>f.nodes.get(id),row=()=>n('uniformList').children[0];
  await fn(f,n,row);
}finally{mounted?.dispose();f.dispose();}});
const parse=line=>Annotations.collect([line])[0];
const value=(f,i=0)=>{const v=f.renderer.getUserUniforms()[i].value;return Array.isArray(v)?[...v]:v;};
const show=async n=>n('uniformSearch').dispatchEvent({type:'input'});
const side=row=>row.children[1].children[1];
const chip=(chips,text)=>chips.children.find(c=>c.textContent===text);
(async()=>{
await run('파서: @angle · @pos/@xy · @log · @enum',()=>{
  const a=parse('uniform float uSpin; // @angle @default 90deg');assert.equal(a.error,null);assert.equal(a.options.angle,true);close(a.value,Math.PI/2);
  assert.equal(parse('uniform float uA; // @angle').value,0);
  const p=parse('uniform vec2 uC; // @pos @range 0 1 @step 0.01 @default 0.25');assert.equal(p.error,null);assert.deepEqual({...p.options},{min:0,max:1,step:0.01,pos:true});assert.deepEqual([...p.value],[0.25,0.25]);
  const x=parse('uniform vec2 uO; // @xy');assert.deepEqual({...x.options},{min:-1,max:1,step:0.002,pos:true});assert.deepEqual([...x.value],[0,0]);
  const l=parse('uniform float uS; // @log @range 0.01 100 @default 1');assert.equal(l.error,null);assert.equal(l.options.log,true);
  assert.equal(parse('uniform float uS; // @log @range 0.01 100').value,0.01);
  const e=parse('uniform int uMode; // 보기 · @enum 결과 밀도, 받은_해빛 @default 2');assert.equal(e.error,null);
  assert.deepEqual([...e.options.enum],['결과','밀도','받은 해빛']);assert.deepEqual([e.options.min,e.options.max,e.options.step],[0,2,1]);assert.equal(e.value,2);
});
await run('파서 오류: 타입·범위·표시 방식 겹침',()=>{
  assert.match(parse('uniform vec2 uA; // @angle').error,/float/);
  assert.match(parse('uniform float uA; // @angle @range 0 1').error,/@range/);
  assert.match(parse('uniform vec3 uP; // @pos').error,/vec2/);
  assert.match(parse('uniform float uL; // @log').error,/0보다 큰/);
  assert.match(parse('uniform float uL; // @log @range 0 10').error,/0보다 큰/);
  assert.match(parse('uniform vec2 uL; // @log @range 1 10').error,/float/);
  assert.match(parse('uniform float uE; // @enum a b').error,/int\/uint/);
  assert.match(parse('uniform int uE; // @enum only').error,/2~32/);
  assert.match(parse('uniform int uE; // @enum a b @range 0 5').error,/@range/);
  assert.match(parse('uniform vec2 uB; // @pos @dir').error,/하나만/);
});
await run('sameOptions는 새 옵션과 선택지 이름까지 비교한다',()=>{
  assert(!Annotations.sameOptions({},{angle:true}));assert(!Annotations.sameOptions({min:0,max:1,step:1},{min:0,max:1,step:1,pos:true}));
  assert(!Annotations.sameOptions({min:0,max:1,step:1,enum:['a','b']},{min:0,max:1,step:1,enum:['a','c']}));
  assert(Annotations.sameOptions({min:0,max:1,step:1,enum:['a','b']},{min:0,max:1,step:1,enum:['a','b']}));
});
await ui('렌더러: 표시 방식 옵션을 검증하고 그대로 돌려준다',async f=>{
  f.renderer.defineUniform('uSpin','float',1,{angle:true});
  f.renderer.defineUniform('uC','vec2',[0,0],{min:-1,max:1,step:0.01,pos:true});
  f.renderer.defineUniform('uS','float',1,{min:0.01,max:100,step:0.1,log:true});
  f.renderer.defineUniform('uM','int',1,{min:0,max:2,step:1,enum:['a','b','c']});
  const [a,p,l,e]=f.renderer.getUserUniforms();
  assert.equal(a.options.angle,true);assert.equal(p.options.pos,true);assert.equal(l.options.log,true);assert.deepEqual([...e.options.enum],['a','b','c']);
  e.options.enum.push('x');assert.equal(f.renderer.getUserUniforms()[3].options.enum.length,3,'선택지 배열은 복사본');
  for(const [type,v,opts,re] of [
    ['float',0,{angle:true,min:0,max:1,step:0.1},/angle/],['vec3',[0,0,0],{angle:true},/angle/],
    ['vec2',[0,0],{pos:true},/pos/],['float',1,{log:true,min:0,max:1,step:0.1},/log/],
    ['int',0,{enum:['a','b']},/enum/],['int',0,{min:0,max:2,step:1,enum:['a','b']},/enum/],['float',0,{min:0,max:1,step:1,enum:['a','b']},/enum/],
    ['float',0,{angle:true,log:true,min:1,max:2,step:0.1},/하나만/],
  ])assert.throws(()=>f.renderer.defineUniform('uBad',type,v,opts),re,JSON.stringify(opts));
});
await ui('@angle 다이얼: 도로 보여 주고 라디안으로 넘기며 바퀴 수를 지킨다',async(f,n,row)=>{
  f.renderer.defineUniform('uSpin','float',Math.PI/6,{angle:true});await show(n);
  const [line,chips,code,turns]=side(row()).children,[,slider,number]=line.children;
  assert.equal(number.value,'30');assert.equal(code.textContent,'0.5236 rad');
  assert.equal(slider.min,'0');assert.equal(slider.max,'360');assert.equal(turns.textContent,'누적 0회전');
  assert.deepEqual(chips.children.map(c=>c.textContent),['0°','90°','180°','270°']);
  await chip(chips,'90°').click();close(value(f),Math.PI/2);
  number.value='720';await number.dispatchEvent({type:'change'});close(value(f),4*Math.PI);assert.equal(slider.value,'0');assert.equal(number.value,'0');
  assert.equal(turns.textContent,'누적 2회전');assert.equal(code.textContent,'0.0000 rad');assert.match(code.title,/12\.566371/);
  slider.value='10';await slider.dispatchEvent({type:'input'});close(value(f),(730*Math.PI)/180,1e-9);
  assert.equal(number.value,'10');assert.equal(turns.textContent,'누적 2회전');
  number.value='20';await number.dispatchEvent({type:'change'});close(value(f),(740*Math.PI)/180,1e-9);
  await row().children[1].children[0].dispatchEvent({type:'keydown',key:'ArrowUp',shiftKey:true});close(value(f),(755*Math.PI)/180,1e-9);
  assert.equal(number.value,'35');
  await chip(chips,'270°').click();close(value(f),(630*Math.PI)/180,1e-9);assert.equal(number.value,'270');assert.equal(turns.textContent,'누적 1회전');
});
await ui('@angle: 양방향 경계와 음수·소수 각도도 표시만 감싼다',async(f,n,row)=>{
  f.renderer.defineUniform('uSpin','float',359*Math.PI/180,{angle:true});await show(n);
  const [line,,code,turns]=side(row()).children,[,slider,number]=line.children,pad=row().children[1].children[0];
  await pad.dispatchEvent({type:'keydown',key:'ArrowUp'});close(value(f),2*Math.PI,1e-9);
  assert.equal(number.value,'0');assert.equal(slider.value,'0');assert.equal(turns.textContent,'누적 1회전');
  await pad.dispatchEvent({type:'keydown',key:'ArrowUp'});close(value(f),361*Math.PI/180,1e-9);assert.equal(number.value,'1');
  slider.value='359';await slider.dispatchEvent({type:'input'});close(value(f),359*Math.PI/180,1e-9);
  slider.value='0';await slider.dispatchEvent({type:'input'});close(value(f),2*Math.PI,1e-9);
  number.value='-10';await number.dispatchEvent({type:'change'});close(value(f),-Math.PI/18,1e-9);
  assert.equal(number.value,'350');assert.equal(slider.value,'350');assert.equal(turns.textContent,'누적 -1회전');assert.match(code.title,/-0\.174533/);
  number.value='0';await number.dispatchEvent({type:'change'});close(value(f),0,1e-9);
  await pad.dispatchEvent({type:'keydown',key:'ArrowRight'});close(value(f),-Math.PI/180,1e-9);assert.equal(number.value,'359');
  await pad.dispatchEvent({type:'keydown',key:'ArrowLeft'});close(value(f),0,1e-9);assert.equal(number.value,'0');assert.equal(turns.textContent,'누적 0회전');
  number.value='719.96';await number.dispatchEvent({type:'change'});close(value(f),719.96*Math.PI/180,1e-9);
  assert.equal(number.value,'0','표시 반올림이 360°이면 0°로');assert.equal(turns.textContent,'누적 2회전');assert.equal(code.textContent,'0.0000 rad');
  number.value='';await number.dispatchEvent({type:'change'});close(value(f),719.96*Math.PI/180,1e-9);assert.equal(number.value,'0');
});
await ui('@pos 패드: X·Y 줄 · 범위 안으로 · 화살표 키 · 가운데 버튼',async(f,n,row)=>{
  f.renderer.defineUniform('uC','vec2',[0.2,0.4],{min:0,max:1,step:0.01,pos:true});await show(n);
  const parts=side(row()).children,[x,y]=parts,chips=parts[2],pad=row().children[1].children[0];
  assert.equal(x.children[2].value,'0.2');assert.equal(y.children[1].max,'1');
  y.children[2].value='5';await y.children[2].dispatchEvent({type:'change'});assert.deepEqual(value(f),[0.2,1],'범위 밖은 끝으로');
  await pad.dispatchEvent({type:'keydown',key:'ArrowLeft',shiftKey:true});assert.deepEqual(value(f),[0.1,1]);
  await pad.dispatchEvent({type:'keydown',key:'ArrowDown'});assert.deepEqual(value(f),[0.1,0.99]);
  await chip(chips,'가운데').click();assert.deepEqual(value(f),[0.5,0.5]);assert(!chip(chips,'원점'));
});
await ui('@log 슬라이더: 위치 0~1을 배율로 바꾼다',async(f,n,row)=>{
  f.renderer.defineUniform('uS','float',1,{min:0.01,max:100,step:0.1,log:true});await show(n);
  const [range,number]=row().children[1].children;
  assert.equal(range.max,'1');close(Number(range.value),0.5);
  range.value='0.75';await range.dispatchEvent({type:'input'});close(value(f),10,1e-9);assert.equal(number.value,'10');
  range.value='0';await range.dispatchEvent({type:'input'});close(value(f),0.01,1e-12);
  number.value='0.1';await number.dispatchEvent({type:'change'});close(Number(range.value),0.25);
});
await ui('@enum: 짧으면 버튼 묶음, 길면 드롭다운',async(f,n,row)=>{
  f.renderer.defineUniform('uM','int',0,{min:0,max:2,step:1,enum:['결과','밀도','투과율']});await show(n);
  const group=row().children[1];assert.deepEqual(group.children.map(b=>b.textContent),['결과','밀도','투과율']);
  assert.equal(group.children[0].attrs['aria-pressed'],'true');
  await group.children[2].click();assert.equal(value(f),2);assert.equal(group.children[2].attrs['aria-pressed'],'true');assert.equal(group.children[0].attrs['aria-pressed'],'false');
  const many=Array.from({length:8},(_,i)=>`Mode${i}`);
  f.renderer.defineUniform('uBlend','uint',3,{min:0,max:7,step:1,enum:many});n('uniformSearch').value='uBlend';await show(n);
  const select=row().children[1].children[0];assert.equal(select.children.length,8);assert.equal(select.value,'3');assert.equal(select.children[3].textContent,'3 · Mode3');
  select.value='6';await select.dispatchEvent({type:'change'});assert.equal(value(f,1),6);
});
await ui('추가 폼: 각도 · 2D 패드 · 로그 · 선택지',async(f,n)=>{
  const add=async(type,name,valueText,display,extra={})=>{
    n('uniformType').value=type;await n('uniformType').dispatchEvent({type:'change'});
    n('uniformDisplay').value=display;await n('uniformDisplay').dispatchEvent({type:'change'});
    for(const [id,v] of Object.entries({uniformMin:'',uniformMax:'',uniformStep:'',...extra}))n(id).value=v;
    n('uniformName').value=name;n('uniformValue').value=valueText;await n('uniformForm').dispatchEvent({type:'submit'});
    return f.renderer.getUserUniforms().find(u=>u.name===name);
  };
  n('uniformType').value='float';await n('uniformType').dispatchEvent({type:'change'});assert.deepEqual(n('uniformDisplay').children.map(o=>o.value),['','angle','log']);
  assert.equal((await add('float','uSpin','1','angle',{uniformMin:'0',uniformMax:'1',uniformStep:'0.1'})).options.angle,true,'각도는 범위를 무시');
  const pos=await add('vec2','uC','0, 0','pos');assert.deepEqual({...pos.options},{min:-1,max:1,step:0.002,pos:true});
  assert.equal(await add('float','uL','1','log'),undefined,'로그는 범위 없이 만들 수 없다');assert.match(n('uiError').textContent,/0보다 큰/);
  assert.equal((await add('float','uL','1','log',{uniformMin:'0.01',uniformMax:'100',uniformStep:'0.01'})).options.log,true);
  n('uniformType').value='int';await n('uniformType').dispatchEvent({type:'change'});n('uniformDisplay').value='enum';await n('uniformDisplay').dispatchEvent({type:'change'});
  assert.equal(n('uniformEnumLabels').hidden,false);assert.equal(n('rangeFields').hidden,true);
  const e=await add('int','uMode','1','enum',{uniformEnumLabels:'결과, 밀도 받은_해빛'});assert.deepEqual([...e.options.enum],['결과','밀도','받은 해빛']);assert.equal(e.options.max,2);
  assert.equal(n('uniformEnumLabels').value,'');assert.equal(n('uniformDisplay').value,'');
});
console.log(`\n${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
