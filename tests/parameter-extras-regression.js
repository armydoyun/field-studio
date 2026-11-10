'use strict';
// node tests/parameter-extras-regression.js — 덧붙이는 어노테이션: 설명 · @group · @color hdr · @seed · @anim.
require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const {fixture}=require('./logic-regression');
const root=path.join(__dirname,'..');
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(root,'js',file),'utf8'),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const Annotations=load('annotations.js');
const close=(a,b,eps=1e-6)=>assert(Math.abs(a-b)<=eps,`${a} ≈ ${b}`);
let passed=0,failed=0;
const run=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack);}};
// 코드(어노테이션)를 가진 프로젝트로 패널을 띄운다: 설명·묶음·기본값은 코드에서 읽는다.
const ui=async(name,code,fn)=>run(name,async()=>{const f=fixture();let mounted;try{
  const Node=f.canvas.constructor;Node.prototype.querySelector=()=>null;Node.prototype.querySelectorAll=function(){return [];};
  Node.prototype.setAttribute=function(k,v){(this.attrs??={})[k]=v;};Node.prototype.removeAttribute=function(k){delete this.attrs?.[k];};
  Node.prototype.classList=undefined;
  f.document.querySelectorAll=()=>[];
  for(const id of ['uniformType','uniformValue','uniformMin','uniformMax','uniformStep','uniformName','uniformSearch','uniformDisplay','uniformDisplayField','uniformEnumLabels','rangeFields'])f.document.getElementById(id);
  f.window.shaderStudio={getProject:()=>({image:code,passes:[]}),getPlaybackState:()=>true,togglePlayback(){}};
  for(const spec of Annotations.collect([code]))f.renderer.defineUniform(spec.name,spec.type,spec.value,spec.options);
  mounted=f.load('ui').mount(f.renderer,{getCamera:()=>null,resetCamera(){}},f.settings);
  const n=id=>f.nodes.get(id);await n('uniformSearch').dispatchEvent({type:'input'});
  await fn(f,n,n('uniformList'));
}finally{mounted?.dispose();f.dispose();}});
const parse=line=>Annotations.collect([line])[0];
const value=(f,name)=>{const v=f.renderer.getUserUniforms().find(u=>u.name===name).value;return Array.isArray(v)?[...v]:v;};
const rowOf=(list,name)=>{const rows=[];const walk=node=>{for(const c of node.children||[]){if(c.className==='uniform-row')rows.push(c);else walk(c);}};walk(list);
  return rows.find(r=>r.children[0].children[0].children[0].textContent===name);};
const button=(row,cls)=>row.children[0].children.find(c=>String(c.className).includes(cls));
const step=async(f,now)=>{const frames=f.frames.splice(0).filter(fr=>fr.name==='playStep');for(const fr of frames)await fr(now);return frames.length;};
(async()=>{
await run('파서: 설명 · 묶음 · hdr · seed · anim',()=>{
  const a=parse('uniform vec3 uGlow; // 발광 색 · @color hdr 20 @default 2 1 0.5 @group 빛과 색');
  assert.equal(a.error,null);assert.equal(a.description,'발광 색');assert.equal(a.group,'빛과 색');assert.equal(a.options.hdr,20);assert.deepEqual([...a.value],[2,1,0.5]);
  assert.equal(parse('uniform vec3 uC; // @color hdr').options.hdr,10);
  assert.equal(parse('uniform vec3 uC; // @color').options.hdr,undefined);
  const s=parse('uniform float uSeed; // 무늬: @seed @range 0 100 @step 1');assert.equal(s.description,'무늬');assert.equal(s.options.seed,true);assert.equal(s.group,'');
  assert.equal(parse('uniform float uW; // @range 0 1 @anim').options.anim,4);
  assert.equal(parse('uniform float uW; // @angle @anim 8').options.anim,8);
  assert.equal(parse('uniform float uW; // @range 0 1 @group 하늘_색').group,'하늘 색');
});
await run('파서 오류: hdr · seed · anim 조건',()=>{
  assert.match(parse('uniform vec3 uC; // @color hdr 0').error,/최대 밝기/);
  assert.match(parse('uniform vec2 uS; // @seed').error,/float\/int\/uint/);
  assert.match(parse('uniform int uS; // @seed @enum a b').error,/@enum/);
  assert.match(parse('uniform float uA; // @anim').error,/@range/);
  assert.match(parse('uniform float uA; // @log @range 1 10 @anim').error,/@range/);
  assert.match(parse('uniform bool uA; // @anim').error,/float\/int\/uint/);
  assert.match(parse('uniform int uA; // @anim').error,/@enum/,'범위 없는 int는 안 된다');
  assert.equal(parse('uniform int uA; // @range 0 9 @anim').error,null);
  assert.equal(parse('uniform uint uA; // @enum a b c @anim 1').error,null);
  assert.equal(parse('uniform int uA; // @enum a b @anim 2').options.anim,2);
  assert.match(parse('uniform float uA; // @range 0 1 @anim 0').error,/0.1~600/);
  assert(!Annotations.sameOptions({min:0,max:1,step:1},{min:0,max:1,step:1,anim:4}));
  assert(!Annotations.sameOptions({color:true},{color:true,hdr:10}));
});
await run('렌더러: hdr · seed · anim 검증',()=>{
  const f=fixture();try{
    f.renderer.defineUniform('uG','vec3',[3,1,0],{color:true,hdr:10});f.renderer.defineUniform('uS','int',3,{seed:true});f.renderer.defineUniform('uA','float',0,{angle:true,anim:5});
    const [g,s,a]=f.renderer.getUserUniforms();assert.equal(g.options.hdr,10);assert.deepEqual([...g.value],[3,1,0]);assert.equal(s.options.seed,true);assert.equal(a.options.anim,5);
    for(const [type,v,opts,re] of [['vec3',[1,1,1],{hdr:10},/hdr/],['vec3',[1,1,1],{color:true,hdr:-1},/hdr/],['vec2',[0,0],{seed:true},/seed/],
      ['float',0,{anim:4},/anim/],['int',0,{anim:4},/anim/],['bool',false,{anim:4},/anim/],['float',0,{min:0,max:1,step:0.1,anim:999},/anim/],['float',1,{min:1,max:10,step:0.1,log:true,anim:4},/anim/]])
      assert.throws(()=>f.renderer.defineUniform('uBad',type,v,opts),re,JSON.stringify(opts));
  }finally{f.dispose();}
});
await ui('설명은 이름 아래에, @group은 접히는 묶음으로',`
uniform float uA; // 바탕 밝기 · @range 0 1 @default 0.5
uniform float uB; // @range 0 1 @group 빛
uniform float uC; // 그림자 · @range 0 1 @group 빛
uniform float uD; // @range 0 1 @group 무늬
`,async(f,n,list)=>{
  assert.equal(list.children[0].className,'uniform-row','묶음 없는 파라미터가 먼저');
  const title=list.children[0].children[0].children[0];assert.equal(title.children[2].className,'uniform-desc');assert.equal(title.children[2].textContent,'바탕 밝기');
  assert.equal(rowOf(list,'uB').children[0].children[0].children.length,2,'설명이 없으면 줄도 없다');
  const [light,pattern]=list.children.slice(1);assert.equal(light.className,'uniform-group');
  const head=light.children[0];assert.equal(head.children[0].textContent,'빛');assert.equal(head.children[1].textContent,'2');assert.equal(head.attrs['aria-expanded'],'true');
  assert.equal(light.children[1].children.length,2);assert.equal(pattern.children[0].children[0].textContent,'무늬');
  await head.click();const folded=n('uniformList').children[1];assert.equal(folded.className,'uniform-group is-collapsed');assert.equal(folded.children[1].hidden,true);
  n('uniformSearch').value='uc';await n('uniformSearch').dispatchEvent({type:'input'});
  const found=n('uniformList').children[0];assert.equal(found.className,'uniform-group','검색 중에는 접힌 묶음도 펼친다');assert.equal(found.children[1].hidden,false);assert.equal(n('uniformResults').textContent,'4개 중 1개 표시');
});
await ui('@color hdr: 밝기 배율 줄이 값 = 색 × 배율로 맞춘다',`uniform vec3 uGlow; // @color hdr 20 @default 2 1 0.5`,async(f,n,list)=>{
  const row=rowOf(list,'uGlow'),[picker,hex,code]=row.children[1].children,[,intensity,number]=row.children[2].children;
  assert.equal(hex.value,'#ff8040');assert.equal(intensity.max,'20');assert.equal(number.value,'2');assert.equal(code.textContent,'2.00 1.00 0.50');
  number.value='6';await number.dispatchEvent({type:'change'});assert.deepEqual(value(f,'uGlow'),[6,3,1.5]);assert.equal(hex.value,'#ff8040');
  picker.value='#00ff00';await picker.dispatchEvent({type:'input'});assert.deepEqual(value(f,'uGlow'),[0,6,0],'고른 색에 배율을 곱한다');
  intensity.value='0';await intensity.dispatchEvent({type:'input'});assert.deepEqual(value(f,'uGlow'),[0,0,0]);
  intensity.value='2';await intensity.dispatchEvent({type:'input'});assert.deepEqual(value(f,'uGlow'),[0,2,0],'0에서 다시 올려도 마지막 색을 기억한다');
});
await ui('@seed: 범위 안에서 step 단위로 고른다',`uniform float uSeed; // @seed @range 10 20 @step 0.5 @default 10
uniform int uPick; // @seed @range 3 5`,async(f,n,_list)=>{
  const real=Math.random;try{
    for(const r of [0,0.37,0.999]){Math.random=()=>r;await button(rowOf(n('uniformList'),'uSeed'),'seed-uniform').click();
      const v=value(f,'uSeed');assert(v>=10&&v<=20&&Number.isInteger(v*2),String(v));}
    Math.random=()=>0.999;await button(rowOf(n('uniformList'),'uPick'),'seed-uniform').click();assert.equal(value(f,'uPick'),5);
    Math.random=()=>0;await button(rowOf(n('uniformList'),'uPick'),'seed-uniform').click();assert.equal(value(f,'uPick'),3);
  }finally{Math.random=real;}
});
await ui('@anim: ▶는 범위를 왕복하고, 직접 바꾸면 멈춘다',`uniform float uWave; // @range 0 2 @anim 4 @default 0
uniform float uSpin; // @angle @anim 8`,async(f,n,list)=>{
  const play=button(rowOf(list,'uWave'),'play-uniform');assert.equal(play.attrs['aria-pressed'],'false');
  await play.click();assert.equal(play.attrs['aria-pressed'],'true');
  await step(f,1000);close(value(f,'uWave'),0);
  await step(f,3000);close(value(f,'uWave'),2,1e-9);   // 반 주기(2초)에 최대
  await step(f,5000);close(value(f,'uWave'),0,1e-9);   // 한 주기에 다시 처음
  const number=rowOf(n('uniformList'),'uWave').children[1].children[1];assert.equal(number.value,'0');
  await button(rowOf(n('uniformList'),'uSpin'),'play-uniform').click();await step(f,0);await step(f,2000);close(value(f,'uSpin'),Math.PI/2);
  await step(f,8000);close(value(f,'uSpin'),2*Math.PI,1e-9);
  // 숫자 칸으로 직접 바꾸면 그 파라미터만 멈춘다
  number.value='1';await number.dispatchEvent({type:'change'});await step(f,9000);assert.equal(value(f,'uWave'),1);assert.equal(play.attrs['aria-pressed'],'false');
  assert(value(f,'uSpin')>2*Math.PI);
  await button(rowOf(n('uniformList'),'uSpin'),'play-uniform').click();assert.equal(await step(f,10000),1);assert.equal(f.frames.filter(fr=>fr.name==='playStep').length,0,'모두 멈추면 프레임을 더 잡지 않는다');
});
await ui('@anim: int는 한 칸씩 왕복, @enum은 선택지를 차례로 돈다',`uniform int uCount; // @range 0 4 @anim 4 @default 0
uniform int uView; // @enum 결과 밀도 법선 @anim 1 @default 1`,async(f,n,list)=>{
  const count=button(rowOf(list,'uCount'),'play-uniform');assert.match(count.title,/한 칸씩 왕복/);
  await count.click();const seen=[];
  for(const t of [0,1000,2000,3000,4000,4500])
    {await step(f,t);seen.push(value(f,'uCount'));}
  assert.deepEqual(seen,[0,2,4,2,0,1],'0 → 4 → 0을 4초에, 일정한 속도로');
  const number=rowOf(n('uniformList'),'uCount').children[1].children[1];assert.equal(number.value,'1');
  await count.click();
  const view=button(rowOf(n('uniformList'),'uView'),'play-uniform');assert.match(view.title,/선택지마다 1초씩/);
  await view.click();const order=[];
  for(const t of [10000,10500,11000,12000,13000])
    {await step(f,t);order.push(value(f,'uView'));}
  assert.deepEqual(order,[1,1,2,0,1],'지금 선택지에서 출발해 1초마다 다음으로, 끝나면 처음으로');
  const buttons=rowOf(n('uniformList'),'uView').children[1].children;
  assert.deepEqual(buttons.map(b=>b.attrs['aria-pressed']),['false','true','false'],'선택지 버튼 강조가 따라간다');
  await buttons[2].click();await step(f,14000);assert.equal(value(f,'uView'),2,'직접 고르면 멈춘다');
});
await ui('추가 폼: HDR 색상',``,async(f,n)=>{
  n('uniformType').value='vec3';await n('uniformType').dispatchEvent({type:'change'});assert.deepEqual(n('uniformDisplay').children.map(o=>o.value),['','color','hdr','dir']);
  n('uniformDisplay').value='hdr';await n('uniformDisplay').dispatchEvent({type:'change'});assert.equal(n('rangeFields').hidden,true);
  n('uniformName').value='uGlow';n('uniformValue').value='2, 1, 0';await n('uniformForm').dispatchEvent({type:'submit'});
  const item=f.renderer.getUserUniforms()[0];assert.equal(item.options.color,true);assert.equal(item.options.hdr,10);assert.deepEqual([...item.value],[2,1,0]);
});
console.log(`\n${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
