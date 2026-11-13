'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./logic-regression');
let passed=0,failed=0;
async function test(name,fn){const f=fixture();let ui;try{
  const Node=f.canvas.constructor;Node.prototype.querySelector=()=>new Node();Node.prototype.querySelectorAll=()=>[];
  Node.prototype.setAttribute=function(k,v){(this.attrs??={})[k]=v;};Node.prototype.removeAttribute=function(k){delete this.attrs?.[k];};
  f.document.querySelectorAll=()=>[];
  for(const id of ['uniformType','uniformValue','uniformMin','uniformMax','uniformStep','uniformName','uniformSearch'])f.document.getElementById(id);
  ui=f.load('ui').mount(f.renderer,{getCamera:()=>null,resetCamera(){}},f.settings);
  const n=id=>f.nodes.get(id),row=()=>n('uniformList').children[0];
  await fn(f,n,row);passed++;console.log('PASS',name);
}catch(e){failed++;console.error('FAIL',name,e.stack);}finally{ui?.dispose();f.dispose();}}
(async()=>{
await test('Parameter deletion uses the shared SVG mask and retains its accessible name',async(f,n,row)=>{
  f.renderer.defineUniform('uAmount','float',1);await n('uniformSearch').dispatchEvent({type:'input'});
  const remove=row().children[0].children.at(-1);assert.equal(remove.className,'remove-uniform glyph-icon icon-close');assert(!remove.textContent);assert.equal(remove.attrs['aria-label'],'uAmount 삭제');
  await remove.click();assert.equal(f.renderer.getUserUniforms().length,0);
});
await test('Empty parameter list explains how to start',async(f,n,row)=>{assert.match(row().textContent,/파라미터가 없습니다/);assert.equal(n('uniformCount').textContent,'0 / 64');});
await test('Adding a parameter clears stale search and ignores hidden scalar bounds',async(f,n)=>{
  // 벡터는 이제 성분별 슬라이더 범위를 지원하므로 범위 칸이 보인다. 범위 칸이 숨겨지는 행렬 타입에 남은 Min 값은 무시되어야 한다.
  n('uniformMin').value='0';n('uniformType').value='mat2';await n('uniformType').dispatchEvent({type:'change'});
  n('uniformName').value='uTint';n('uniformSearch').value='missing';
  await n('uniformForm').dispatchEvent({type:'submit'});
  assert.equal(n('rangeFields').hidden,true);assert.equal(f.renderer.getUserUniforms()[0].name,'uTint');assert.deepEqual({...f.renderer.getUserUniforms()[0].options},{});assert.equal(n('uniformSearch').value,'');assert.equal(n('uniformEditor').open,false);
});
await test('Reserved built-in rejection retains form data and explains failure',async(f,n)=>{
  n('uniformType').value='float';n('uniformValue').value='1';n('uniformName').value='uTime';await n('uniformForm').dispatchEvent({type:'submit'});
  assert.equal(f.renderer.getUserUniforms().length,0);assert.equal(n('uniformName').value,'uTime');assert.match(n('uiError').textContent,/전용/);
});
await test('Vector changes preserve components changed externally after row render',async(f,n,row)=>{
  f.renderer.defineUniform('uVector','vec3',[1,2,3]);await n('uniformSearch').dispatchEvent({type:'input'});
  f.renderer.setUniform('uVector',[4,5,6]);const x=row().children[1].children[0].children[1];x.value='7';await x.dispatchEvent({type:'change'});
  assert.deepEqual(Array.from(f.renderer.getUserUniforms()[0].value),[7,5,6]);
});
await test('Empty vector component cannot silently become zero',async(f,n,row)=>{
  f.renderer.defineUniform('uVector','vec2',[1,2]);await n('uniformSearch').dispatchEvent({type:'input'});
  const x=row().children[1].children[0].children[1];x.value='';await x.dispatchEvent({type:'change'});
  assert.equal(f.renderer.getUserUniforms()[0].value[0],1);assert.equal(x.value,'1');assert.equal(x.attrs['aria-invalid'],'true');
});
await test('Slider and numeric field stay synchronized and reject invalid integers',async(f,n,row)=>{
  f.renderer.defineUniform('uCount','int',2,{min:0,max:10,step:1});await n('uniformSearch').dispatchEvent({type:'input'});
  const [range,number]=row().children[1].children;range.value='5';await range.dispatchEvent({type:'input'});assert.equal(number.value,'5');
  number.value='1.5';await number.dispatchEvent({type:'change'});assert.equal(number.value,'5');assert.equal(f.renderer.getUserUniforms()[0].value,5);
});
await test('Delete can restore the last parameter including value and slider options',async(f,n,row)=>{
  f.renderer.defineUniform('uGain','float',.7,{min:0,max:1,step:.1});await n('uniformSearch').dispatchEvent({type:'input'});
  await row().children[0].children.at(-1).click();assert.equal(f.renderer.getUserUniforms().length,0);assert.equal(n('undoUniform').hidden,false);
  await n('undoUniform').click();assert.equal(f.renderer.getUserUniforms()[0].value,.7);assert.equal(f.renderer.getUserUniforms()[0].options.step,.1);assert.equal(n('undoUniform').hidden,true);
});
await test('Failed deletion retains parameter and offers no false undo',async(f,n,row)=>{
  f.renderer.defineUniform('uGain','float',.7);await n('uniformSearch').dispatchEvent({type:'input'});f.gl.getProgramParameter=()=>false;
  await row().children[0].children.at(-1).click();assert.equal(f.renderer.getUserUniforms().length,1);assert.notEqual(n('undoUniform').hidden,false);assert(n('uiError').textContent);
});
await test('Project switch clears search and previous-project deletion undo',async(f,n,row)=>{
  f.renderer.defineUniform('uGain','float',.7);await n('uniformSearch').dispatchEvent({type:'input'});await row().children[0].children.at(-1).click();
  n('uniformSearch').value='missing';f.studio.exampleFeedback();await f.document.dispatchEvent({type:'shader-settings-applied'});
  assert.equal(n('uniformSearch').value,'');assert.equal(n('undoUniform').hidden,true);await n('undoUniform').click();assert.equal(f.renderer.getUserUniforms().length,0);
});
await test('Editor Parameters button opens the parameter view and focuses search',async(f,n)=>{
  await n('studioParameters').click();assert.equal(f.document.activeElement,n('uniformSearch'));
});
await test('Deletion undo captures the latest external value rather than stale displayed value',async(f,n,row)=>{
  f.renderer.defineUniform('uGain','float',.1);await n('uniformSearch').dispatchEvent({type:'input'});f.renderer.setUniform('uGain',.9);
  await row().children[0].children.at(-1).click();await n('undoUniform').click();assert.equal(f.renderer.getUserUniforms()[0].value,.9);
});
await test('Malformed comma vectors are rejected without adding a zero component',async(f,n)=>{
  n('uniformType').value='vec3';n('uniformName').value='uVector';n('uniformValue').value='1,2,';
  await n('uniformForm').dispatchEvent({type:'submit'});assert.equal(f.renderer.getUserUniforms().length,0);assert(n('uiError').textContent);
});
await test('Boolean parameter uses an accessible switch with explicit true/false text',async(f,n,row)=>{
  f.renderer.defineUniform('uEnabled','bool',false);await n('uniformSearch').dispatchEvent({type:'input'});
  const label=row().children[1],[input,text]=label.children;assert.equal(label.className,'uniform-switch');assert.equal(input.type,'checkbox');assert.equal(input.attrs.role,'switch');assert.equal(input.checked,false);assert.match(text.textContent,/false/);
  input.checked=true;await input.dispatchEvent({type:'change'});assert.equal(f.renderer.getUserUniforms()[0].value,true);assert.match(text.textContent,/true/);
  f.renderer.setUniform=()=>{throw Error('forced failure');};input.checked=false;await input.dispatchEvent({type:'change'});assert.equal(input.checked,true);assert.match(text.textContent,/true/);
});
await test('Large values keep every integer digit while long fractions are shortened',async(f,n)=>{
  f.renderer.defineUniform('uFar','float',123456.789);f.renderer.defineUniform('uPhase','float',0.5239193476851991);await n('uniformSearch').dispatchEvent({type:'input'});
  const list=n('uniformList').children,[far]=list[0].children[1].children,[phase]=list[1].children[1].children;
  assert.equal(far.value,'123456.789');assert.equal(phase.value,'0.523919');assert.equal(phase.title,'0.5239193476851991');
});
await test('Ranged scalar shows its min and max under the slider',async(f,n,row)=>{
  f.renderer.defineUniform('uGain','float',.5,{min:-2,max:8,step:.25});await n('uniformSearch').dispatchEvent({type:'input'});
  const ends=row().children[2];assert.equal(ends.className,'uniform-range-ends');assert.deepEqual(ends.children.map(x=>x.textContent),['-2','8']);
});
await test('Color HEX field sets RGB and keeps the value on malformed input',async(f,n,row)=>{
  f.renderer.defineUniform('uTint','vec3',[1,.5,.2],{color:true});await n('uniformSearch').dispatchEvent({type:'input'});
  const [picker,hex]=row().children[1].children;assert.equal(hex.value,'#ff8033');
  hex.value='#3366CC';await hex.dispatchEvent({type:'change'});assert.deepEqual(Array.from(f.renderer.getUserUniforms()[0].value).map(v=>+v.toFixed(3)),[.2,.4,.8]);assert.equal(picker.value,'#3366cc');
  hex.value='zz12';await hex.dispatchEvent({type:'change'});assert.equal(hex.attrs['aria-invalid'],'true');assert.deepEqual(Array.from(f.renderer.getUserUniforms()[0].value).map(v=>+v.toFixed(3)),[.2,.4,.8]);
  await hex.dispatchEvent({type:'keydown',key:'Escape'});assert.equal(hex.value,'#3366cc');
});
await test('Dragging the parameter name scrubs by the slider step and respects its bounds',async(f,n,row)=>{
  f.renderer.defineUniform('uCount','int',2,{min:0,max:10,step:1});await n('uniformSearch').dispatchEvent({type:'input'});
  const name=row().children[0].children[0].children[0],[range,number]=row().children[1].children;
  await name.dispatchEvent({type:'pointerdown',button:0,clientX:100,pointerId:1});
  await name.dispatchEvent({type:'pointermove',clientX:112});assert.equal(f.renderer.getUserUniforms()[0].value,5);assert.equal(number.value,'5');assert.equal(range.value,'5');
  await name.dispatchEvent({type:'pointermove',clientX:400});assert.equal(f.renderer.getUserUniforms()[0].value,10);
  await name.dispatchEvent({type:'pointermove',clientX:-400});assert.equal(f.renderer.getUserUniforms()[0].value,0);
});
await test('Buffer viewer shortcut moves to the profile tab',async(f,n)=>{
  await n('openBufferViewer').click(); // 탭 전환 자체는 브라우저 테스트(panel-dedupe-browser-regression.js)가 검사한다.
});
await test('Pipeline example opens the current-frame pipeline',async(f)=>{
  f.studio.examplePipeline();const p=f.studio.getProject();assert.equal(p.passes.length,2);assert.equal(Object.keys(p.passes[0].channels).length,0);assert.equal(p.passes[1].channels[0].frame,'current');
});
console.log(`Parameter UI: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
