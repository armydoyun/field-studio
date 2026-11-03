'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./logic-regression');
let passed=0,failed=0;
async function test(name,fn){const f=fixture(true);try{await fn(f);passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack);}finally{f.dispose();}}
const place=async(f,text,a,b=a)=>{const area=f.nodes.get('studioCode');area.value=text;await area.dispatchEvent({type:'input'});area.setSelectionRange(a,b);return area;};
(async()=>{
for(const [open,close] of [['(',')'],['[',']'],['{','}']]){
 await test(`Insert ${open}${close} before existing ${close} without consuming it`,async f=>{
  const area=await place(f,close,0);await area.dispatchEvent({type:'keydown',key:open});assert.equal(area.value,open+close+close);assert.equal(area.selectionStart,1);
 });
 await test(`Nest ${open}${close} inside existing pair; Backspace preserves outer pair`,async f=>{
  const area=await place(f,open+close,1);await area.dispatchEvent({type:'keydown',key:open});assert.equal(area.value,open+open+close+close);assert.equal(area.selectionStart,2);
  await area.dispatchEvent({type:'keydown',key:'Backspace'});assert.equal(area.value,open+close);assert.equal(area.selectionStart,1);
 });
}
await test('Function call can be nested immediately before closing parenthesis and undone',async f=>{
 const area=await place(f,'sin()',4);await area.dispatchEvent({type:'keydown',key:'('});assert.equal(area.value,'sin(())');assert.equal(area.selectionStart,5);
 await area.dispatchEvent({type:'keydown',key:')'});assert.equal(area.value,'sin(())');assert.equal(area.selectionStart,6);
 assert(f.studio.undo());assert.equal(area.value,'sin()');assert(f.studio.redo());assert.equal(area.value,'sin(())');
});
await test('Selected text is still wrapped before existing closer',async f=>{
 const area=await place(f,'x)',0,1);await area.dispatchEvent({type:'keydown',key:'('});assert.equal(area.value,'(x))');assert.equal(area.selectionStart,1);assert.equal(area.selectionEnd,2);
});
for(const [text,at] of [['// )',3],['/* ) */',3],['"x)"',2]])await test('Comments and strings do not receive auto pairs: '+text,async f=>{
 const area=await place(f,text,at);await area.dispatchEvent({type:'keydown',key:'('});assert.equal(area.value,text); // Native insertion belongs to browser, handler must leave source alone.
});
await test('IME composition does not insert pairs',async f=>{
 const area=await place(f,')',0);await area.dispatchEvent({type:'keydown',key:'(',isComposing:true});assert.equal(area.value,')');
});
await test('Indent width updates native tabs and highlighting together',async f=>{
 const area=f.nodes.get('studioCode'),indent=f.nodes.get('studioIndent');indent.value='2';await indent.dispatchEvent({type:'change'});
 assert.equal(area.style.tabSize,'2');assert.equal(f.nodes.get('studioHighlight').style.tabSize,'2');
 indent.value='4';await indent.dispatchEvent({type:'change'});assert.equal(area.style.tabSize,'4');
});
console.log(`Pair nesting: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
