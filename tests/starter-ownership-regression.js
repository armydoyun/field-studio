'use strict';
const assert=require('node:assert/strict');
const {fixture,scene}=require('./logic-regression');
const equal=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.message);}}
function input(f){return f.load('input').mount(f.canvas,f.renderer);}
const tick=()=>new Promise(setImmediate);
(async()=>{
  await test('Mounting Input registers no Camera or Required Uniform',()=>{
    const f=fixture(),i=input(f);try{assert.equal(typeof f.renderer.getRequiredUniforms,"undefined");assert.equal(f.renderer.getUserUniforms().length,0);for(const name of ['getCamera','setCamera','resetCamera'])assert.equal(i[name],undefined,`${name} 제거`);}finally{i.dispose();f.dispose();}
  });
  for(const kind of ['exampleFeedback','examplePipeline'])await test(kind+' starts with an empty custom registry',()=>{
    const f=fixture();try{f.renderer.defineUniform('uOld','float',2);assert(f.studio[kind]());assert.equal(f.renderer.getUserUniforms().length,0);assert.equal(typeof f.renderer.getRequiredUniforms,"undefined");}finally{f.dispose();}
  });
  await test('Ray starter replaces all previous uniforms with its own fresh five',()=>{
    const f=fixture();try{f.renderer.defineUniform('uRMMaxSteps','float',.5);f.renderer.defineUniform('uOld','float',1);assert(f.studio.exampleRaymarch());const users=f.renderer.getUserUniforms();assert.equal(users.length,5);assert(!users.some(u=>u.name==='uOld'));assert.equal(users.find(u=>u.name==='uRMMaxSteps').type,'int');assert(!users.some(u=>u.name==='uCameraOrbit'),'카메라는 Uniform이 아니라 Buffer A 상태');assert.equal(typeof f.renderer.getRequiredUniforms,"undefined");}finally{f.dispose();}
  });
  await test('Reapplying Ray starter resets its values to preset defaults',()=>{
    const f=fixture();try{assert(f.studio.exampleRaymarch());f.renderer.setUniform('uRMMaxSteps',256);f.renderer.setUniform('uRMHeatmap',true);assert(f.studio.exampleRaymarch());assert.equal(f.renderer.getUserUniforms().find(u=>u.name==='uRMMaxSteps').value,128);assert.equal(f.renderer.getUserUniforms().find(u=>u.name==='uRMHeatmap').value,false);}finally{f.dispose();}
  });
  await test('Default Shader Art reset also clears custom uniforms',async()=>{
    const f=fixture();try{f.renderer.defineUniform('uOld','float',2);const pending=f.nodes.get('studioReset').click();await tick();await f.nodes.get('studioDialogForm').dispatchEvent({type:'submit'});await pending;assert.equal(f.renderer.getUserUniforms().length,0);assert.equal(f.studio.getProject().image,f.shader.fragment);}finally{f.dispose();}
  });
  await test('Starter compile failure preserves old source and Uniform values',()=>{
    const f=fixture();try{f.renderer.defineUniform('uOld','float',2);const old=f.studio.getProject().image;f.gl.getProgramParameter=()=>false;assert.equal(f.studio.examplePipeline(),false);assert.equal(f.studio.getProject().image,old);assert.equal(f.renderer.getUserUniforms()[0].value,2);}finally{f.dispose();}
  });
  await test('Undo/Redo of a starter switch restores project and Uniform registry together',()=>{
    const f=fixture();try{assert(f.studio.exampleRaymarch());f.renderer.setUniform('uRMMaxSteps',256);assert(f.studio.exampleFeedback());assert.equal(f.renderer.getUserUniforms().length,0);assert(f.studio.undo());assert.equal(f.studio.getProject().image,f.shader.raymarch);assert.equal(f.renderer.getUserUniforms().find(u=>u.name==='uRMMaxSteps').value,256);assert(f.studio.redo());assert.equal(f.renderer.getUserUniforms().length,0);}finally{f.dispose();}
  });
  await test('Undo restores custom Uniforms created before first Starter switch',()=>{
    const f=fixture();try{f.renderer.defineUniform('uOld','vec3',[1,2,3]);assert(f.studio.exampleFeedback());assert(f.studio.undo());equal(f.renderer.getUserUniforms()[0].value,[1,2,3]);}finally{f.dispose();}
  });
  await test('Changing only Starter values is also undoable',()=>{
    const f=fixture();try{assert(f.studio.exampleRaymarch());f.renderer.setUniform('uRMMaxSteps',300);assert(f.studio.exampleRaymarch());assert.equal(f.renderer.getUserUniforms().find(u=>u.name==='uRMMaxSteps').value,128);assert(f.studio.undo());assert.equal(f.renderer.getUserUniforms().find(u=>u.name==='uRMMaxSteps').value,300);}finally{f.dispose();}
  });
  await test('Ordinary code Undo preserves current Custom values',async()=>{
    const f=fixture();try{assert(f.studio.exampleRaymarch());f.renderer.setUniform('uRMMaxSteps',256);const area=f.nodes.get('studioCode');area.value+='\n// code edit';await area.dispatchEvent({type:'input'});assert(f.studio.undo());assert.equal(f.renderer.getUserUniforms().find(u=>u.name==='uRMMaxSteps').value,256);}finally{f.dispose();}
  });
  await test('Ray starter keeps its camera in a keyboard-driven state buffer',()=>{
    const f=fixture();try{assert(f.studio.exampleRaymarch());const p=f.studio.getProject();assert.equal(p.passes.length,1);assert.equal(p.passes[0].name,'A');equal(p.passes[0].channels[1],{keyboard:true});equal(p.passes[0].channels[0],{buffer:'A',frame:'previous'});equal(p.imageChannels[0],{buffer:'A',frame:'current'});assert(!p.image.includes('uCameraOrbit'));}finally{f.dispose();}
  });
  await test('Viewport keys and wheel no longer drive any camera Uniform',async()=>{
    const f=fixture(),i=input(f);try{f.renderer.defineUniform('uCameraOrbit','vec3',[0,.5,5]);f.nodes.get('stage').focus();await f.document.dispatchEvent({type:'keydown',code:'KeyW',key:'w'});await f.document.dispatchEvent({type:'keydown',code:'KeyR',key:'r'});await f.canvas.dispatchEvent({type:'wheel',deltaY:10,deltaMode:0});assert.equal(f.frames.length,0);equal(f.renderer.getUserUniforms()[0].value,[0,.5,5]);}finally{i.dispose();f.dispose();}
  });
  await test('Generic key subscriptions still work without any camera Uniform',async()=>{
    const f=fixture(),i=input(f),events=[];try{const off=i.onKey(({code,down})=>{if(code==='KeyQ')events.push(down);});f.nodes.get('stage').focus();await f.document.dispatchEvent({type:'keydown',code:'KeyQ',key:'q'});await f.document.dispatchEvent({type:'keyup',code:'KeyQ',key:'q'});equal(events,[true,false]);assert.equal(f.renderer.getUserUniforms().length,0);off();}finally{i.dispose();f.dispose();}
  });
  await test('Old saved settings with the removed Required field still load (the field is ignored)',()=>{
    const f=fixture();try{const data=f.settings.snapshot();data.required={uCameraOrbit:[.3,.4,8]};data.user=[{name:'uGain',type:'float',value:.4}];f.storage.set('webgl.raymarch-template.settings.v1',JSON.stringify(data));assert(f.settings.load());assert.equal(f.renderer.getUserUniforms().map(u=>u.name).join(),'uGain');assert(!Object.hasOwn(JSON.parse(f.storage.get('webgl.raymarch-template.settings.v1')),'required'));assert.equal(f.settings.status().available,true);}finally{f.dispose();}
  });
  console.log(`Starter ownership: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
