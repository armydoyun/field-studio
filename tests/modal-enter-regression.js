'use strict';
const assert=require('node:assert/strict'),{fixture,src}=require('./logic-regression');
let passed=0,failed=0;
async function test(name,fn){const f=fixture(true);try{await fn(f,id=>f.document.getElementById(id));passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack);}finally{f.dispose();}}
// Keep the modal's pending promise separately; awaiting a click before Enter would deadlock.
const open=(f,n)=>{n('studioCode').value=src;n('studioCode').setSelectionRange(0,0);const pending=n('studioGoto').click();n('studioDialogInput').value='3';return pending;};
(async()=>{
for(const focused of ['studioDialogInput','studioDialogCancel','studioDialogClose','studioDialogOK'])await test('Enter accepts input even when focus is on '+focused,async(f,n)=>{
 const pending=open(f,n);let clicks=0;n(focused).addEventListener('click',()=>clicks++);n(focused).focus();
 const e={type:'keydown',key:'Enter'};await n('studioPromptDialog').dispatchEvent(e);
 if(!e.defaultPrevented)await f.document.activeElement.click(); // Model the native focused-button default action.
 await pending;assert.equal(e.defaultPrevented,true);assert.equal(e.propagationStopped,true);assert.equal(clicks,0);assert.equal(n('studioPromptDialog').open,false);assert.equal(n('studioCode').selectionStart,src.indexOf('out vec4'));
});
await test('Invalid input cannot accept even if Cancel has focus',async(f,n)=>{
 const pending=open(f,n);let checks=0;n('studioDialogInput').reportValidity=()=>{checks++;return false;};n('studioDialogCancel').focus();
 const e={type:'keydown',key:'Enter'};await n('studioPromptDialog').dispatchEvent(e);assert.equal(e.defaultPrevented,true);assert.equal(checks,1);assert.equal(n('studioPromptDialog').open,true);
 n('studioDialogInput').reportValidity=()=>true;await n('studioPromptDialog').dispatchEvent({type:'keydown',key:'Enter'});await pending;assert.equal(n('studioPromptDialog').open,false);
});
for(const extra of [{isComposing:true},{keyCode:229}])await test('IME confirmation does not submit the modal: '+JSON.stringify(extra),async(f,n)=>{
 const pending=open(f,n),e={type:'keydown',key:'Enter',...extra};await n('studioPromptDialog').dispatchEvent(e);assert.equal(e.defaultPrevented,false);assert.equal(n('studioPromptDialog').open,true);
 await n('studioDialogCancel').click();await pending;assert.equal(n('studioCode').selectionStart,0);
});
for(const extra of [{repeat:true},{ctrlKey:true},{metaKey:true},{altKey:true}])await test('Repeated or modified Enter neither accepts nor activates a focused button: '+JSON.stringify(extra),async(f,n)=>{
 const pending=open(f,n),e={type:'keydown',key:'Enter',...extra};n('studioDialogClose').focus();await n('studioPromptDialog').dispatchEvent(e);
 assert.equal(e.defaultPrevented,true);assert.equal(n('studioPromptDialog').open,true);await n('studioDialogCancel').click();await pending;
});
await test('Space still activates a focused cancel button and Escape still cancels',async(f,n)=>{
 let pending=open(f,n);n('studioDialogCancel').focus();const space={type:'keydown',key:' '};await n('studioPromptDialog').dispatchEvent(space);assert.equal(space.defaultPrevented,false);
 await n('studioDialogCancel').click();await pending;assert.equal(n('studioCode').selectionStart,0);
 pending=open(f,n);const escape={type:'keydown',key:'Escape'};await n('studioPromptDialog').dispatchEvent(escape);assert.equal(escape.defaultPrevented,false);
 await n('studioPromptDialog').dispatchEvent({type:'cancel'});await pending;assert.equal(n('studioCode').selectionStart,0);
});
await test('A confirmation modal accepts Enter while Cancel remains the initial focus',async(f,n)=>{
 f.renderer.defineUniform('uOld','float',1);const pending=n('studioReset').click();assert.equal(f.document.activeElement,n('studioDialogCancel'));
 const e={type:'keydown',key:'Enter'};await n('studioPromptDialog').dispatchEvent(e);await pending;assert.equal(e.defaultPrevented,true);assert.equal(f.renderer.getUserUniforms().length,0);
});
await test('Native submit path remains supported without a keyboard event',async(f,n)=>{
 const pending=open(f,n);await n('studioDialogForm').dispatchEvent({type:'submit'});await pending;assert.equal(n('studioCode').selectionStart,src.indexOf('out vec4'));
});
console.log(`Modal Enter: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
