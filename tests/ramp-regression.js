'use strict';
// node tests/ramp-regression.js — 램프 파라미터(uniform sampler2D · @gradient/@curve): 굽기 · 파서 · 렌더러 텍스처 · 패널 편집기 · 추가 폼.
require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const {fixture}=require('./logic-regression');
const root=path.join(__dirname,'..');
const load=file=>{let mod;vm.runInNewContext(fs.readFileSync(path.join(root,'js',file),'utf8'),{define:(deps,factory)=>mod=factory()},{filename:file});return mod;};
const Annotations=load('annotations.js'),Ramp=load('ramp.js');
const close=(a,b,eps=1e-6)=>assert(Math.abs(a-b)<=eps,`${a} ≈ ${b}`);
let passed=0,failed=0;
const run=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack);}};
const ui=async(name,code,fn)=>run(name,async()=>{const f=fixture();let mounted;try{
  const Node=f.canvas.constructor;Node.prototype.querySelector=()=>null;Node.prototype.querySelectorAll=function(){return [];};
  Node.prototype.setAttribute=function(k,v){(this.attrs??={})[k]=v;};Node.prototype.removeAttribute=function(k){delete this.attrs?.[k];};
  Node.prototype.getBoundingClientRect=()=>({left:0,top:0,width:200,height:100});
  f.document.querySelectorAll=()=>[];
  for(const id of ['uniformType','uniformValue','uniformMin','uniformMax','uniformStep','uniformName','uniformSearch','uniformDisplay','uniformDisplayField','uniformEnumLabels','rangeFields','uniformValueHelp','uniformBoolValue'])f.document.getElementById(id);
  f.window.shaderStudio={getProject:()=>({image:code,passes:[]}),getPlaybackState:()=>true,togglePlayback(){}};
  for(const spec of Annotations.collect([code]))f.renderer.defineUniform(spec.name,spec.type,spec.value,spec.options);
  mounted=f.load('ui').mount(f.renderer,{getCamera:()=>null,resetCamera(){}},f.settings);
  const n=id=>f.nodes.get(id);await n('uniformSearch').dispatchEvent({type:'input'});
  await fn(f,n,()=>n('uniformList').children);
}finally{mounted?.dispose();f.dispose();}});
const parse=line=>Annotations.collect([line])[0];
const value=(f,name)=>[...f.renderer.getUserUniforms().find(u=>u.name===name).value];
const key=(node,k,extra={})=>node.dispatchEvent({type:'keydown',key:k,...extra});
(async()=>{
await run('굽기: 그라데이션 linear · smooth · step',()=>{
  const v=[0,1,0,0,1, 1,0,0,1,1];
  const lin=Ramp.sampleRamp({gradient:'linear'},v,5);close(lin[2][0],0.5);close(lin[2][2],0.5);close(lin[1][0],0.75);
  const sm=Ramp.sampleRamp({gradient:'smooth'},v,5);close(sm[1][0],1-(0.25*0.25*(3-0.5)));
  const st=Ramp.sampleRamp({gradient:'step'},[0,0,0,0,1, 0.5,1,1,1,1, 1,1,1,1,1],5);assert.deepEqual([...st.map(c=>c[0])],[0,0,1,1,1]);
  const out=Ramp.bakeRamp({gradient:'linear'},v);assert.equal(out.length,1024);assert.deepEqual([...out.slice(0,4)],[255,0,0,255]);assert.deepEqual([...out.slice(1020)],[0,0,255,255]);
});
await run('굽기: 곡선 linear · 단조 3차(넘치지 않음) · 끝 밖은 끝 값',()=>{
  close(Ramp.sampleRamp({curve:'linear'},[0,0,1,2],3)[1],1);
  const v=[0,0, 0.3,0.9, 0.35,1, 1,1];const s=Ramp.sampleRamp({curve:'smooth'},v,256);
  assert(s.every(y=>y>=-1e-9&&y<=1+1e-9),'단조 구간에서 0~1을 넘지 않는다');
  for(let i=1;i<s.length;i++)assert(s[i]>=s[i-1]-1e-9,'오르막은 계속 오르막');
  const edge=Ramp.sampleRamp({curve:'smooth'},[0.2,0.3,0.8,0.7],11);close(edge[0],0.3);close(edge[10],0.7);
  const out=Ramp.bakeRamp({curve:'linear'},[0,0,1,1]);assert.equal(out.length,256);close(out[255],1);close(out[51],0.2);
});
await run('파서: @gradient · @curve 기본값 · 정렬 · 오류',()=>{
  const g=parse('uniform sampler2D uR; // 불 · @gradient step @default 1 #ffffff 0 #00000080 @group 색');
  assert.equal(g.error,null);assert.equal(g.description,'불');assert.equal(g.group,'색');assert.deepEqual({...g.options},{gradient:'step'});
  assert.deepEqual([...g.value].map(v=>+v.toFixed(3)),[0,0,0,0,0.502,1,1,1,1,1],'위치 순으로 정렬');
  assert.deepEqual([...parse('uniform sampler2D uR; // @gradient').value],[0,0,0,0,1,1,1,1,1,1]);
  assert.deepEqual([...parse('uniform sampler2D uR; // @gradient @default 0 1 0 0 1 1 0 0 1 1').value],[0,1,0,0,1,1,0,0,1,1]);
  const c=parse('uniform sampler2D uC; // @curve linear @range -1 1');assert.deepEqual({...c.options},{curve:'linear',min:-1,max:1,step:0.002});assert.deepEqual([...c.value],[0,-1,1,1]);
  assert.equal(parse('uniform sampler2D iChannel0; // 그냥 설명 @group a'),undefined,'램프 태그가 없는 sampler2D는 무시');
  for(const [line,re] of [['uniform sampler2D u; // @gradient wavy',/모드/],['uniform sampler2D u; // @gradient @default 0 #fff 1 #000000',/#RRGGBB/],
    ['uniform sampler2D u; // @gradient @default 0 #000000',/2~16/],['uniform sampler2D u; // @curve @default 0 0 1',/x y/],['uniform sampler2D u; // @curve @default 0 0 1.5 1',/0~1/],
    ['uniform sampler2D u; // @gradient @range 0 1',/범위/],['uniform sampler2D u; // @gradient @curve',/함께/]])assert.match(parse(line).error,re,line);
  assert(!Annotations.sameOptions({gradient:'linear'},{gradient:'step'}));assert.deepEqual(Annotations.clampValue([0,5,1,9],{curve:'smooth',min:0,max:1}),[0,5,1,9]);
});
await run('렌더러: 굽고 4번 유닛부터 묶고, 바뀐 것만 다시 올리고, 지우면 정리한다',async()=>{
  const f=fixture();try{
    const uploads=[],units=[];const gl=f.gl;
    const tex=gl.texImage2D;gl.texImage2D=(...a)=>{uploads.push(a);return tex(...a);};const u1=gl.uniform1i;gl.uniform1i=(loc,v)=>{if(/^uR|^uC/.test(loc))units.push([loc,v]);return u1(loc,v);};
    gl.R16F='R16F';gl.RED='RED';
    f.renderer.defineUniform('uR','sampler2D',[1,0,0,1,1, 0,1,1,1,1],{gradient:'linear'});
    f.renderer.defineUniform('uC','sampler2D',[0,0,1,1],{curve:'smooth'});
    assert.deepEqual([...f.renderer.getUserUniforms()[0].value],[0,1,1,1,1,1,0,0,1,1],'정지점을 위치 순으로 정렬');
    const draw=async()=>{f.renderer.redraw();for(const fr of f.frames.splice(0))await fr(performance.now());};
    await draw();
    assert.deepEqual(units.slice(-2),[['uR',4],['uC',5]]);
    assert.equal(uploads.length,2);assert.equal(uploads[0][2],gl.RGBA8);assert.equal(uploads[1][2],'R16F');assert.equal(uploads[1][7],gl.FLOAT);
    await draw();assert.equal(uploads.length,2,'값이 그대로면 다시 올리지 않는다');
    f.renderer.setUniform('uC',[0,1,1,0]);await draw();assert.equal(uploads.length,3);assert.equal(uploads[2][2],'R16F');
    const deleted=gl.deleted.length;f.renderer.removeUniform('uR');assert.equal(gl.deleted.length-deleted>=2,true,'텍스처와 이전 프로그램을 지운다');
    assert(gl.deleted.slice(deleted).some(x=>x?.type==='tex'));
    for(const [v,opts,re] of [[[0,0,0,0,1],{gradient:'linear'},/2~16/],[[0,0,1,1],{gradient:'wavy'},/gradient/],[[0,0,1,1],{curve:'smooth',color:true},/gradient/],
      [[0,0,1,1],{},/gradient/],[[0,0,0,0,1,1,1,1,1,1],{gradient:'linear',min:0,max:1,step:0.1},/gradient/],[[0,0,1,1],{curve:'smooth',min:1,max:0,step:0.1},/범위/]])
      assert.throws(()=>f.renderer.defineUniform('uBad','sampler2D',v,opts),re,JSON.stringify(opts));
    for(let i=0;i<7;i++)f.renderer.defineUniform(`uX${i}`,'sampler2D',[0,0,1,1],{curve:'linear'});
    assert.throws(()=>f.renderer.defineUniform('uX9','sampler2D',[0,0,1,1],{curve:'linear'}),/최대 8개/);
  }finally{f.dispose();}
});
await ui('그라데이션 편집기: 손잡이 · 키보드 이동 · 삭제 · 위치·알파 · 뒤집기 · 빈 곳 추가',`uniform sampler2D uR; // @gradient @default 0 #000000 0.5 #ff0000 1 #ffffff`,async(f,n,rows)=>{
  const [bar,track,edit,info]=rows()[0].children[1].children;assert.equal(bar.tagName,'CANVAS');
  assert.equal(track.children.length,3);assert.equal(info.textContent,'선형 · 정지점 3개');
  const [picker,,position,,alpha,remove,reverse]=edit.children;
  assert.equal(picker.value,'#000000');assert.equal(track.children[0].attrs['aria-pressed'],'true');
  const mid=track.children[1];await mid.dispatchEvent({type:'focus'});assert.equal(picker.value,'#ff0000');
  await key(mid,'ArrowRight',{shiftKey:true});close(value(f,'uR')[5],0.6);
  position.value='0.25';await position.dispatchEvent({type:'change'});close(value(f,'uR')[5],0.25);
  alpha.value='0.5';await alpha.dispatchEvent({type:'change'});close(value(f,'uR')[9],0.5);
  picker.value='#00ff00';await picker.dispatchEvent({type:'input'});assert.deepEqual(value(f,'uR').slice(5,10),[0.25,0,1,0,0.5]);
  await reverse.click();assert.deepEqual(value(f,'uR').filter((_,i)=>i%5===0),[0,0.75,1]);assert.deepEqual(value(f,'uR').slice(0,4),[0,1,1,1],'뒤집으면 흰색이 앞으로');
  await key(track.children[1],'Delete');assert.equal(value(f,'uR').length,10);assert.equal(remove.disabled,true,'두 개면 더 지울 수 없다');
  await key(track.children[0],'Delete');assert.equal(value(f,'uR').length,10);
  // 빈 곳을 누르면 그 위치의 지금 색으로 정지점을 더한다(막대 폭 200 중 100 = 0.5)
  await track.dispatchEvent({type:'pointerdown',button:0,clientX:100,target:track});
  const v=value(f,'uR');assert.equal(v.length,15);close(v[5],0.5);close(v[6],0.5,0.01);assert.equal(track.children.length,3);
});
await ui('곡선 편집기: [ ] 선택 · 화살표 이동(이웃 사이) · Delete · X·Y 칸 · 프리셋',`uniform sampler2D uC; // @curve linear @range 0 2 @default 0 0 0.5 1 1 2`,async(f,n,rows)=>{
  const [pad,edit,info]=rows()[0].children[1].children,[,xField,,yField,remove,line,sCurve,flip]=edit.children;
  assert.equal(info.textContent,'직선 잇기 · 점 3개 · 1번 (0, 0)');
  await key(pad,']');assert.equal(xField.value,'0.5');
  await key(pad,'ArrowUp',{shiftKey:true});close(value(f,'uC')[3],1.2);
  await key(pad,'ArrowRight',{shiftKey:true});await key(pad,'ArrowRight',{shiftKey:true});await key(pad,'ArrowRight',{shiftKey:true});
  await key(pad,'ArrowRight',{shiftKey:true});await key(pad,'ArrowRight',{shiftKey:true});await key(pad,'ArrowRight',{shiftKey:true});
  close(value(f,'uC')[2],0.998,1e-9);assert.equal(value(f,'uC')[4],1,'이웃을 넘지 않아 순서가 그대로');
  xField.value='0.3';await xField.dispatchEvent({type:'change'});yField.value='5';await yField.dispatchEvent({type:'change'});assert.deepEqual(value(f,'uC').slice(2,4),[0.3,2],'y는 범위 안으로');
  await key(pad,'Delete');assert.deepEqual(value(f,'uC'),[0,0,1,2]);assert.equal(remove.disabled,true);
  await sCurve.click();assert.deepEqual(value(f,'uC').map(v=>+v.toFixed(3)),[0,0,0.3,0.2,0.7,1.8,1,2]);
  await flip.click();assert.deepEqual(value(f,'uC').map(v=>+v.toFixed(3)),[0,2,0.3,1.8,0.7,0.2,1,0]);
  await line.click();assert.deepEqual(value(f,'uC'),[0,0,1,2]);
});
await ui('추가 폼: sampler2D는 그라데이션·곡선 중 하나로 만든다',``,async(f,n)=>{
  n('uniformType').value='sampler2D';await n('uniformType').dispatchEvent({type:'change'});
  assert.deepEqual(n('uniformDisplay').children.map(o=>o.value),['gradient','curve']);assert.equal(n('uniformDisplay').value,'gradient');assert.equal(n('uniformValue').hidden,true);assert.equal(n('rangeFields').hidden,true);
  n('uniformName').value='uRamp';await n('uniformForm').dispatchEvent({type:'submit'});
  n('uniformType').value='sampler2D';await n('uniformType').dispatchEvent({type:'change'});n('uniformDisplay').value='curve';
  n('uniformName').value='uCurve';await n('uniformForm').dispatchEvent({type:'submit'});
  const [g,c]=f.renderer.getUserUniforms();assert.deepEqual({...g.options},{gradient:'linear'});assert.deepEqual([...g.value],[0,0,0,0,1,1,1,1,1,1]);
  assert.deepEqual({...c.options},{curve:'smooth'});assert.deepEqual([...c.value],[0,0,1,1]);
  n('uniformType').value='float';await n('uniformType').dispatchEvent({type:'change'});assert.equal(n('uniformValue').hidden,false);assert.equal(n('uniformDisplay').children[0].value,'');
});
console.log(`\n${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
