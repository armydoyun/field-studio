'use strict';
// node tests/direction-annotation-regression.js — @dir 단위 방향 파라미터: 파서 · 렌더러 정규화 · 파라미터 패널 편집기.
require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const {fixture}=require('./logic-regression');
const root=path.join(__dirname,'..');
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(root,'js',file),'utf8'),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const Annotations=load('annotations.js');
const near=(a,b,eps=1e-6)=>{assert.equal(a.length,b.length);a.forEach((v,i)=>assert(Math.abs(v-b[i])<=eps,`${[...a]} ≈ ${b}`));};
const unit=v=>Math.abs(Math.hypot(...v)-1)<1e-6;
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
const value=f=>[...f.renderer.getUserUniforms()[0].value];
// 행 구조: [머리, .uniform-dir[패드, 옆칸[각도 줄…, 축 버튼, 값]]]
const parts=row=>{const dir=row.children[1],side=dir.children[1],k=side.children.length;return {dir,pad:dir.children[0],lines:side.children.slice(0,k-2),chips:side.children[k-2],code:side.children[k-1]};};
const chip=(p,text)=>p.chips.children.find(c=>c.textContent===text);
(async()=>{
await run('@dir는 vec2/vec3 방향을 길이 1로 읽는다',()=>{
  const a=parse('uniform vec3 uSun; // @dir @default 0 3 4');assert.equal(a.error,null);assert.equal(a.options.dir,'full');near(a.value,[0,.6,.8]);
  const b=parse('uniform vec2 uWind; // @dir');assert.equal(b.error,null);near(b.value,[1,0]);
  const c=parse('uniform vec3 uUp; // @dir');near(c.value,[0,1,0]);
  const h=parse('uniform vec3 uN; // @dir hemi @default 0 -1 1');assert.equal(h.options.dir,'hemi');near(h.value,[0,Math.SQRT1_2,Math.SQRT1_2]);
});
await run('@dir 오류: 다른 타입 · 0 벡터 · @color/@range와 함께',()=>{
  assert.match(parse('uniform vec4 uQ; // @dir').error,/vec2\/vec3/);
  assert.match(parse('uniform float uA; // @dir').error,/vec2\/vec3/);
  assert.match(parse('uniform vec3 uZ; // @dir @default 0 0 0').error,/0이 아닌/);
  assert.match(parse('uniform vec3 uC; // @dir @color').error,/하나만/);
  assert.match(parse('uniform vec2 uR; // @dir @range 0 1').error,/함께/);
});
await run('sameOptions·clampValue가 dir를 안다',()=>{
  assert(!Annotations.sameOptions({},{dir:'full'}));assert(!Annotations.sameOptions({dir:'full'},{dir:'hemi'}));assert(Annotations.sameOptions({dir:'hemi'},{dir:'hemi'}));
  near(Annotations.clampValue([3,0,4],{dir:'full'}),[.6,0,.8]);near(Annotations.clampValue([0,-2],{dir:'hemi'}),[0,1]);
  near(Annotations.clampValue([0,0,0],{dir:'full'}),[0,1,0]); // 0 벡터였던 기존 값은 기본 방향으로
});
await ui('렌더러: dir Uniform은 등록·변경 때 늘 단위 벡터가 된다',async f=>{
  f.renderer.defineUniform('uSun','vec3',[0,0,2],{dir:'full'});near(value(f),[0,0,1]);
  f.renderer.setUniform('uSun',[1,1,0]);near(value(f),[Math.SQRT1_2,Math.SQRT1_2,0]);
  assert.throws(()=>f.renderer.setUniform('uSun',[0,0,0]),/0 벡터/);near(value(f),[Math.SQRT1_2,Math.SQRT1_2,0]);
  assert.throws(()=>f.renderer.defineUniform('uBad','vec4',[1,0,0,0],{dir:'full'}),/vec2\/vec3/);
  assert.throws(()=>f.renderer.defineUniform('uBad','vec3',[1,0,0],{dir:'full',color:true}),/함께/);
  assert.throws(()=>f.renderer.defineUniform('uBad','vec3',[1,0,0],{dir:'sideways'}),/vec2\/vec3/);
  f.renderer.defineUniform('uHemi','vec2',[0,-3],{dir:'hemi'});near([...f.renderer.getUserUniforms()[1].value],[0,1]);
});
await ui('vec2 다이얼: 각도 줄 · 키보드 회전 · 축 버튼',async(f,n,row)=>{
  f.renderer.defineUniform('uWind','vec2',[1,0],{dir:'full'});await n('uniformSearch').dispatchEvent({type:'input'});
  const p=parts(row());assert.equal(p.lines.length,1);assert.equal(p.lines[0].children[2].value,'0');assert.equal(p.code.textContent,'1.000 0.000');
  await p.pad.dispatchEvent({type:'keydown',key:'ArrowUp',shiftKey:true});near(value(f),[Math.cos(Math.PI/12),Math.sin(Math.PI/12)]);
  const number=p.lines[0].children[2];number.value='90';await number.dispatchEvent({type:'change'});near(value(f),[0,1]);
  await chip(p,'−X').click();near(value(f),[-1,0]);assert.equal(number.value,'180');
  assert.deepEqual(p.chips.children.map(c=>c.textContent),['+X','−X','+Y','−Y']);
});
await ui('vec3 구 패드: 방위각·고도 · 앞뒤 전환 · hemi는 아래쪽을 막는다',async(f,n,row)=>{
  f.renderer.defineUniform('uSun','vec3',[0,0,1],{dir:'hemi'});await n('uniformSearch').dispatchEvent({type:'input'});
  const p=parts(row());const [az,el]=p.lines;
  assert.equal(el.children[1].min,'0');assert(!chip(p,'−Y'));
  az.children[2].value='90';await az.children[2].dispatchEvent({type:'change'});near(value(f),[1,0,0]);
  el.children[1].value='45';await el.children[1].dispatchEvent({type:'input'});near(value(f),[Math.SQRT1_2,Math.SQRT1_2,0]);
  el.children[2].value='-30';await el.children[2].dispatchEvent({type:'change'});assert(value(f)[1]>=0,'hemi는 고도를 0 아래로 내리지 않는다');
  await chip(p,'+Z').click();near(value(f),[0,0,1]);
  const flip=chip(p,'뒤');await flip.click();near(value(f),[0,0,-1]);assert.equal(flip.attrs['aria-pressed'],'true');
  await p.pad.dispatchEvent({type:'keydown',key:'ArrowDown'});assert(unit(value(f)));assert(value(f)[1]>=0);
  // 극점에서도 방위각이 사라지지 않는다
  await chip(p,'+X').click();el.children[2].value='90';await el.children[2].dispatchEvent({type:'change'});
  el.children[2].value='0';await el.children[2].dispatchEvent({type:'change'});near(value(f),[1,0,0]);
});
await ui('Uniform 추가 폼: 표시 방식 "단위 방향"은 vec2/vec3에만 있고 범위 칸은 무시한다',async(f,n)=>{
  n('uniformType').value='vec3';await n('uniformType').dispatchEvent({type:'change'});
  assert.equal(n('uniformDisplayField').hidden,false);assert.deepEqual(n('uniformDisplay').children.map(o=>o.value),['','color','hdr','dir']);
  n('uniformDisplay').value='dir';await n('uniformDisplay').dispatchEvent({type:'change'});assert.equal(n('rangeFields').hidden,true);
  n('uniformName').value='uLight';n('uniformValue').value='1, 1, 0';n('uniformMin').value='0';
  await n('uniformForm').dispatchEvent({type:'submit'});
  const item=f.renderer.getUserUniforms()[0];assert.equal(item.options.dir,'full');assert.equal(item.options.min,undefined);assert.equal(item.options.color,undefined);near([...item.value],[Math.SQRT1_2,Math.SQRT1_2,0]);
  n('uniformType').value='vec4';await n('uniformType').dispatchEvent({type:'change'});assert.deepEqual(n('uniformDisplay').children.map(o=>o.value),['','color','hdr']);assert.equal(n('uniformDisplay').value,'');
  n('uniformType').value='mat2';await n('uniformType').dispatchEvent({type:'change'});assert.equal(n('uniformDisplayField').hidden,true);
});
console.log(`\n${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
