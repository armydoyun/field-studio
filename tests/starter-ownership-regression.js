'use strict';
const assert=require('node:assert/strict');
const {fixture,scene}=require('./logic-regression');
const equal=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.message);}}
function input(f){return f.load('input').mount(f.canvas,f.renderer,f.shader.orbitHome);}
const tick=()=>new Promise(setImmediate);
(async()=>{
  await test('Mounting Input registers no Camera or Required Uniform',()=>{
    const f=fixture(),i=input(f);try{assert.equal(typeof f.renderer.getRequiredUniforms,"undefined");assert.equal(f.renderer.getUserUniforms().length,0);assert.equal(i.getCamera(),null);assert.equal(i.resetCamera(),false);}finally{i.dispose();f.dispose();}
  });
  for(const kind of ['exampleFeedback','examplePipeline'])await test(kind+' starts with an empty custom registry',()=>{
    const f=fixture();try{f.renderer.defineUniform('uOld','float',2);assert(f.studio[kind]());assert.equal(f.renderer.getUserUniforms().length,0);assert.equal(typeof f.renderer.getRequiredUniforms,"undefined");}finally{f.dispose();}
  });
  await test('Ray starter replaces all previous uniforms with its own fresh six',()=>{
    const f=fixture();try{f.renderer.defineUniform('uRMMaxSteps','float',.5);f.renderer.defineUniform('uOld','float',1);assert(f.studio.exampleRaymarch());const users=f.renderer.getUserUniforms();assert.equal(users.length,6);assert(!users.some(u=>u.name==='uOld'));assert.equal(users.find(u=>u.name==='uRMMaxSteps').type,'int');assert.equal(users.find(u=>u.name==='uCameraOrbit').type,'vec3');assert.equal(typeof f.renderer.getRequiredUniforms,"undefined");}finally{f.dispose();}
  });
  await test('Reapplying Ray starter resets its values to preset defaults',()=>{
    const f=fixture();try{assert(f.studio.exampleRaymarch());f.renderer.setUniform('uRMMaxSteps',256);f.renderer.setUniform('uCameraOrbit',[1,1,12]);assert(f.studio.exampleRaymarch());assert.equal(f.renderer.getUserUniforms().find(u=>u.name==='uRMMaxSteps').value,128);equal(f.renderer.getUserUniforms().find(u=>u.name==='uCameraOrbit').value,f.shader.orbitHome);}finally{f.dispose();}
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
  await test('Optional camera supports updates and stops when project no longer owns it',async()=>{
    const f=fixture(),i=input(f);try{assert(f.studio.exampleRaymarch());assert(i.setCamera({yaw:.3,distance:7}));assert.equal(i.getCamera().yaw,.3);assert(i.resetCamera());assert.equal(i.getCamera().yaw,0);assert(f.studio.exampleFeedback());assert.equal(i.getCamera(),null);assert.equal(i.setCamera({yaw:1}),false);await f.canvas.dispatchEvent({type:'wheel',deltaY:10,deltaMode:0});assert.equal(f.renderer.getUserUniforms().length,0);}finally{i.dispose();f.dispose();}
  });
  await test('Camera with a different user type is left untouched by Input',async()=>{
    const f=fixture(),i=input(f);try{f.renderer.defineUniform('uCameraOrbit','float',2);assert.equal(i.getCamera(),null);assert.equal(i.resetCamera(),false);await f.canvas.dispatchEvent({type:'wheel',deltaY:10,deltaMode:0});assert.equal(f.renderer.getUserUniforms()[0].value,2);}finally{i.dispose();f.dispose();}
  });
  await test('Removing camera during a queued keyboard frame ends camera motion safely',async()=>{
    const f=fixture(),i=input(f);try{assert(f.studio.exampleRaymarch());f.nodes.get('stage').focus();await f.document.dispatchEvent({type:'keydown',code:'KeyW',key:'w'});assert(f.frames.length);assert(f.studio.exampleFeedback());f.frames.shift()(100);assert.equal(f.frames.length,0);assert.equal(f.renderer.getUserUniforms().length,0);}finally{i.dispose();f.dispose();}
  });
  await test('Generic key subscriptions still work without any camera Uniform',async()=>{
    const f=fixture(),i=input(f),events=[];try{const off=i.onKey(({code,down})=>{if(code==='KeyQ')events.push(down);});f.nodes.get('stage').focus();await f.document.dispatchEvent({type:'keydown',code:'KeyQ',key:'q'});await f.document.dispatchEvent({type:'keyup',code:'KeyQ',key:'q'});equal(events,[true,false]);assert.equal(f.renderer.getUserUniforms().length,0);off();}finally{i.dispose();f.dispose();}
  });
  await test('Legacy saved Required camera migrates to Custom with its value',()=>{
    const f=fixture();try{const data=f.settings.snapshot();data.required={};data.required.uCameraOrbit=[.3,.4,8];f.storage.set('webgl.raymarch-template.settings.v1',JSON.stringify(data));assert(f.settings.load());assert.equal(typeof f.renderer.getRequiredUniforms,"undefined");equal(f.renderer.getUserUniforms()[0].value,[.3,.4,8]);assert(!Object.hasOwn(JSON.parse(f.storage.get('webgl.raymarch-template.settings.v1')),'required'));}finally{f.dispose();}
  });
  await test('Legacy Pack camera migrates before atomic shader/Uniform application',async()=>{
    const f=fixture();try{const data={version:3,project:scene(f.shader.raymarch),selected:'Image',textures:[],settings:f.settings.snapshot()};data.settings.required={};data.settings.required.uCameraOrbit=[.2,.3,9];data.settings.user=f.shader.rayUniforms.filter(([name])=>name!=='uCameraOrbit').map(([name,type,value,options])=>({name,type,value,options:options||{}}));assert(await f.studio.importPack(new File([JSON.stringify(data)],'legacy.json')));equal(f.renderer.getUserUniforms().find(u=>u.name==='uCameraOrbit').value,[.2,.3,9]);assert.equal(typeof f.renderer.getRequiredUniforms,"undefined");}finally{f.dispose();}
  });
  await test('Existing Custom camera takes precedence over a legacy Required copy',()=>{
    const f=fixture();try{const data=f.settings.snapshot();data.required={};data.required.uCameraOrbit=[0,0,8];data.user=[{name:'uCameraOrbit',type:'vec3',value:[1,.5,6]}];const next=f.settings.validatePack(data);assert.equal(next.user.length,1);equal(next.user[0].value,[1,.5,6]);}finally{f.dispose();}
  });
  await test('Legacy migration at the Custom limit preserves original settings instead of dropping data',()=>{
    const f=fixture();try{const data=f.settings.snapshot();data.required={};data.required.uCameraOrbit=[0,0,8];data.user=Array.from({length:64},(_,n)=>({name:'u'+n,type:'float',value:0}));const raw=JSON.stringify(data);f.storage.set('webgl.raymarch-template.settings.v1',raw);assert.equal(f.settings.load(),false);f.settings.save();assert.equal(f.storage.get('webgl.raymarch-template.settings.v1'),raw);}finally{f.dispose();}
  });
  await test('Explicit new Starter can replace settings after a blocked legacy migration',()=>{
    const f=fixture();try{const data=f.settings.snapshot();data.required={};data.required.uCameraOrbit=[0,0,8];data.user=Array.from({length:64},(_,n)=>({name:'u'+n,type:'float',value:0}));f.storage.set('webgl.raymarch-template.settings.v1',JSON.stringify(data));assert.equal(f.settings.load(),false);assert(f.studio.exampleFeedback());const saved=JSON.parse(f.storage.get('webgl.raymarch-template.settings.v1'));assert.equal(saved.user.length,0);assert.equal(f.settings.status().available,true);}finally{f.dispose();}
  });
  console.log(`Starter ownership: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
