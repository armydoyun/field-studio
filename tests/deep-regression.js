'use strict';
// node tests/deep-regression.js — async ordering, renderer lifecycle and editor hot paths.
const assert=require('node:assert/strict');
const {fixture,src,scene,pass}=require('./logic-regression');
let passed=0,failed=0;
const tick=()=>new Promise(setImmediate),png=()=>new File(['x'],'test.png',{type:'image/png'});
async function test(name,fn){try{await fn();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,'—',error.message);}}
const input=async(f,text)=>{const area=f.nodes.get('studioCode');area.value=text;await area.dispatchEvent({type:'input',inputType:'insertText',data:'x'});};
const pack=f=>({version:3,project:scene(src+'\n// imported'),selected:'Image',textures:[],settings:f.settings.snapshot()});
function delayedFile(data){let resolve;const promise=new Promise(r=>resolve=r);return {file:{size:1,text:()=>promise},release:()=>resolve(JSON.stringify(data))};}
function fakeDB(){
  const records=new Map(),opens=[];
  const indexedDB={open(){const req={result:{createObjectStore(){},close(){},transaction(){const tx={objectStore:()=>Object.fromEntries(['put','delete','getAll'].map(op=>[op,arg=>{const out={};queueMicrotask(()=>{if(op==='put')records.set(arg.id,arg);else if(op==='delete')records.delete(arg);else out.result=[...records.values()];tx.oncomplete?.();});return out;}]))};return tx;}}};opens.push(req);return req;}};
  return {records,opens,indexedDB,release(index=0){const [req]=opens.splice(index,1);assert(req,'pending DB open');req.onsuccess();}};
}
(async()=>{
  await test('Import cannot overwrite edits made while file.text is pending',async()=>{
    const f=fixture();try{const file=delayedFile(pack(f)),pending=f.studio.importPack(file.file);await input(f,src+'\n// my new edit');pending.catch(()=>{});file.release();await tick();if(f.nodes.get('studioPromptDialog').open)await f.nodes.get('studioDialogForm').dispatchEvent({type:'submit'});await assert.rejects(pending,/변경|취소/);assert(f.studio.getProject().image.includes('my new edit'));}finally{f.dispose();}
  });
  await test('Newer import supersedes older pending file read',async()=>{
    const f=fixture();try{const old=delayedFile(pack(f)),pending=f.studio.importPack(old.file);const current=pack(f);current.project=scene(src+'\n// latest');assert(await f.studio.importPack(new File([JSON.stringify(current)],'latest.json')));
      old.release();await assert.rejects(pending,/변경|취소/);assert(f.studio.getProject().image.includes('latest'));}finally{f.dispose();}
  });
  await test('Disposal prevents a pending import from modifying project/UI',async()=>{
    const f=fixture(),file=delayedFile(pack(f)),pending=f.studio.importPack(file.file),before=f.studio.getProject();f.dispose();file.release();await assert.rejects(pending);assert.deepEqual(f.studio.getProject(),before);
  });
  await test('Pack import preserves settings changed during pending read',async()=>{
    const f=fixture();try{const file=delayedFile(pack(f)),pending=f.studio.importPack(file.file);f.renderer.setFpsLimit(37);file.release();await assert.rejects(pending);assert.equal(f.renderer.getStats().fpsLimit,37);}finally{f.dispose();}
  });
  await test('Editing during image decode cancels Pack and removes temporary assets',async()=>{
    const f=fixture();try{const data=pack(f);data.textures=[{id:'imageA',name:'a.png',type:'image/png',data:'data:image/png;base64,AA==',sampling:{filter:'nearest'}}];data.project.imageChannels={0:{texture:'imageA'}};
      const release=f.deferBitmap(),pending=f.studio.importPack(new File([JSON.stringify(data)],'pack.json'));pending.catch(()=>{});await tick();await input(f,src+'\n// preserve this edit');release();await assert.rejects(pending);assert.equal(f.renderer.getTextures().length,0);assert(f.studio.getProject().image.endsWith('preserve this edit'));
    }finally{f.dispose();}
  });
  await test('Context loss during Pack decode still permits temporary CPU asset cleanup',async()=>{
    const f=fixture();try{const data=pack(f);data.textures=[{id:'imageA',name:'a.png',type:'image/png',data:'data:image/png;base64,AA=='}];
      const release=f.deferBitmap(),pending=f.studio.importPack(new File([JSON.stringify(data)],'pack.json'));pending.catch(()=>{});await tick();await f.canvas.dispatchEvent({type:'webglcontextlost'});release();await assert.rejects(pending);assert.equal(f.renderer.getTextures().length,0);
    }finally{f.dispose();}
  });
  await test('Image finishing after tab switch stays in library without connecting to wrong pass',async()=>{
    const f=fixture();try{assert(f.studio.setProject({...scene(),passes:[pass()]}));const release=f.deferBitmap(),field=f.nodes.get('studioTextureFile');field.files=[png()];const pending=field.dispatchEvent({type:'change'});await tick();await f.nodes.get('studioPassTabs').children[1].click();release();await pending;
      assert.equal(f.renderer.getTextures().length,1);assert.equal(Object.keys(f.studio.getProject().passes[0].channels).length,0);assert(f.nodes.get('studioMessage').textContent.includes('취소'));
    }finally{f.dispose();}
  });
  await test('GLSL load cannot overwrite a different tab after asynchronous read',async()=>{
    const f=fixture();try{assert(f.studio.setProject({...scene(),passes:[pass()]}));let release;const file={name:'slow.frag',size:1,text:()=>new Promise(r=>release=r)};
      const field=f.nodes.get('studioGLSLFile');field.files=[file];const pending=field.dispatchEvent({type:'change'});await tick();await f.nodes.get('studioPassTabs').children[1].click();release(src+'\n// from file');await pending;
      assert.equal(f.studio.getProject().passes[0].fragment,src);assert(f.nodes.get('studioMessage').textContent.includes('취소'));}finally{f.dispose();}
  });
  await test('Exported JSON near the maximum multi-pass source size can be imported again',async()=>{
    const f=fixture();try{const large=src+'\n//'+('a'.repeat(262144-src.length-3));const project={image:large,passes:Array.from({length:8},(_,i)=>({...pass('B'+i),fragment:large})),imageChannels:{}};assert(f.studio.setProject(project));await f.nodes.get('studioExport').click();const file=new File([f.outputs.at(-1)],'project.json');assert(file.size>2*1048576);
      assert(f.studio.setProject(scene()));const field=f.nodes.get('studioImportFile');field.files=[file];await field.dispatchEvent({type:'change'});assert.equal(f.studio.getProject().passes.length,8);
    }finally{f.dispose();}
  });
  await test('GLSL with Unicode comments obeys character length rather than ASCII byte assumptions',async()=>{
    const f=fixture();try{const code=src+'\n//'+('한'.repeat(100000)),file=new File([code],'unicode.frag');assert(file.size>262144);const field=f.nodes.get('studioGLSLFile');field.files=[file];await field.dispatchEvent({type:'change'});assert.equal(f.studio.getProject().image,code);}finally{f.dispose();}
  });
  await test('Pack payload above old 48MiB limit remains within the new matching transfer budget',async()=>{
    const f=fixture();try{const content=JSON.stringify(pack(f)),file={size:49*1048576,text:async()=>content};assert(await f.studio.importPack(file));assert(f.studio.getProject().image.endsWith('imported'));}finally{f.dispose();}
  });
  await test('Pack image decode preserves every binary byte in preallocated storage',async()=>{
    const f=fixture();try{const data=pack(f);data.textures=[{id:'imageA',name:'a.png',type:'image/png',data:'data:image/png;base64,AP+A'}];data.project.imageChannels={0:{texture:'imageA'}};assert(await f.studio.importPack(new File([JSON.stringify(data)],'pack.json')));const id=f.studio.getProject().imageChannels[0].texture;assert.deepEqual([...new Uint8Array(await f.renderer.getTextureFile(id).arrayBuffer())],[0,255,128]);}finally{f.dispose();}
  });
  await test('Interrupted paused capture remains paused after visibility returns',async()=>{
    const f=fixture();try{const pending=f.renderer.captureScreenshot();f.document.hidden=true;await f.document.dispatchEvent({type:'visibilitychange'});await assert.rejects(pending);
      f.document.hidden=false;await f.document.dispatchEvent({type:'visibilitychange'});assert.equal(f.renderer.getStats().running,false);assert.equal(f.frames.length,0);}finally{f.dispose();}
  });
  await test('Explicit Play during temporary capture keeps renderer running',async()=>{
    const f=fixture();try{const pending=f.renderer.captureScreenshot();f.renderer.start();f.frames.shift()(0);await pending;assert.equal(f.renderer.getStats().running,true);}finally{f.dispose();}
  });
  await test('60 FPS cap maintains cadence on a simulated 144 Hz display',()=>{
    const f=fixture();try{f.renderer.setFpsLimit(60);f.renderer.start();for(let i=0;i<1440;i++)f.frames.shift()(i*1000/144);const count=f.renderer.getStats().frame;
      assert(count>=599&&count<=601,`expected ~600 frames in 10s, got ${count}`);}finally{f.dispose();}
  });
  await test('Failed context restore releases partial Image resources',async()=>{
    const f=fixture();try{f.renderer.setPasses([pass()]);await f.canvas.dispatchEvent({type:'webglcontextlost'});const before=f.gl.programs.length;let links=0;f.gl.getProgramParameter=()=>++links!==2;
      await f.canvas.dispatchEvent({type:'webglcontextrestored'});assert(f.gl.programs.slice(before).every(p=>f.gl.deleted.includes(p)));}finally{f.dispose();}
  });
  await test('Play can retry restoration after a transient restore failure',async()=>{
    const f=fixture();try{await f.canvas.dispatchEvent({type:'webglcontextlost'});f.gl.getProgramParameter=()=>false;await f.canvas.dispatchEvent({type:'webglcontextrestored'});
      f.gl.getProgramParameter=()=>true;f.renderer.start();assert(f.frames.length>0);f.frames.shift()(0);assert.equal(f.renderer.getStats().frame,1);}finally{f.dispose();}
  });
  await test('Texture save/delete ordering cannot resurrect a deleted record',async()=>{
    const f=fixture(),db=fakeDB();f.window.indexedDB=db.indexedDB;f.contexts['texture-input'].indexedDB=db.indexedDB;
    try{const pending=f.renderer.addTexture(png());await tick();const id=f.renderer.getTextures()[0].id,removed=f.renderer.removeTexture(id);await tick();
      if(db.opens.length>1){db.release(1);await tick();db.release();}else{db.release();await tick();db.release();}
      await Promise.all([pending,removed]);assert.equal(db.records.size,0);}finally{f.dispose();}
  });
  await test('Failed DB write does not block later queued delete',async()=>{
    const f=fixture(),db=fakeDB();f.window.indexedDB=db.indexedDB;f.contexts['texture-input'].indexedDB=db.indexedDB;
    try{const pending=f.renderer.addTexture(png());await tick();const id=f.renderer.getTextures()[0].id;const removed=f.renderer.removeTexture(id);await tick();
      const [req]=db.opens.splice(0,1);req.error=Error('storage failure');req.onerror();await tick();db.release();const result=await pending;assert.equal(result.saved,false);await removed;assert.equal(db.records.size,0);
    }finally{f.dispose();}
  });
  await test('Cursor and scroll events perform no project JSON serialization',async()=>{
    const f=fixture();try{const before=f.metrics.stringify;for(let i=0;i<100;i++)await f.nodes.get('studioCode').dispatchEvent({type:'scroll'});assert.equal(f.metrics.stringify-before,0);}finally{f.dispose();}
  });
  await test('Undo snapshots preserve drafts without serializing source strings',async()=>{
    const f=fixture();try{const original=f.studio.getProject().image,before=f.metrics.stringify;await input(f,src+'\n// first');const first=f.studio.getProject();await input(f,src+'\n// second');assert(first.image.endsWith('first'));assert.equal(f.metrics.stringify-before,0);assert(f.studio.undo());assert.equal(f.studio.getProject().image,original);assert(f.studio.redo());assert(f.studio.getProject().image.endsWith('second'));}finally{f.dispose();}
  });
  await test('No repeated GPU limit/location queries or channel arrays after warmup',()=>{
    const f=fixture();try{f.renderer.setPasses([pass()]);f.renderer.setPreviewPass('A');f.renderer.start();f.frames.shift()(0);const before={...f.metrics};
      for(let i=1;i<=30;i++)f.frames.shift()(i*17);assert.equal(f.metrics.locations-before.locations,0);assert.equal(f.metrics.maxQueries-before.maxQueries,0);assert.equal(f.metrics.arrays-before.arrays,0);}finally{f.dispose();}
  });
  await test('Image globals/channels reuse the same Uniform location table',()=>{
    const f=fixture();try{const before=f.metrics.locations;f.renderer.start();f.frames.shift()(0);assert.equal(f.metrics.locations-before,0);}finally{f.dispose();}
  });
  await test('Settings restore loads 64 user Uniforms with one program rebuild',()=>{
    const f=fixture();try{const settings=f.settings.snapshot();settings.user=Array.from({length:64},(_,i)=>({name:'uSaved'+i,type:'float',value:0,options:{}}));f.storage.set('webgl.raymarch-template.settings.v1',JSON.stringify(settings));
      const before=f.gl.programs.length;f.settings.load();assert.equal(f.renderer.getUserUniforms().length,64);assert.equal(f.gl.programs.length-before,1);}finally{f.dispose();}
  });
  await test('Malformed saved Uniform does not prevent valid saved Uniforms loading',()=>{
    const f=fixture();try{const state=f.settings.snapshot();state.user=[{name:'uBad',type:'float',value:'wrong'},{name:'uValid',type:'float',value:1}];f.storage.set('webgl.raymarch-template.settings.v1',JSON.stringify(state));assert(f.settings.load());assert.equal(f.renderer.getUserUniforms().length,1);assert.equal(f.renderer.getUserUniforms()[0].name,'uValid');}finally{f.dispose();}
  });
  await test('Preferences reset preserves project Uniforms without recompiling shaders',()=>{
    const f=fixture();try{f.renderer.defineUniform('uGain','float',.7);f.renderer.setFpsLimit(30);f.gl.getProgramParameter=()=>false;
      f.settings.reset();assert.equal(f.renderer.getUserUniforms()[0].value,.7);assert.equal(f.renderer.getStats().fpsLimit,0);
      assert.equal(JSON.parse(f.storage.get('webgl.raymarch-template.settings.v1')).user[0].name,'uGain');}finally{f.dispose();}
  });
  await test('Required API removed and built-in names remain protected',()=>{
    const f=fixture();try{assert.equal(f.renderer.defineRequiredUniform,undefined);assert.equal(f.renderer.getRequiredUniforms,undefined);
      assert.throws(()=>f.renderer.defineUniform('uTime','float',0));assert(!Object.hasOwn(f.settings.snapshot(),'required'));}finally{f.dispose();}
  });
  await test('Search uses source indices even when case folding changes string length',async()=>{
    const f=fixture(true);try{const area=f.nodes.get('studioCode');area.value='// İ foo';await area.dispatchEvent({type:'input'});await f.nodes.get('studioFind').click();f.nodes.get('studioFindQuery').value='foo';await f.nodes.get('studioFindQuery').dispatchEvent({type:'input'});area.setSelectionRange(0,0);await f.nodes.get('studioFindNext').click();
      assert.equal(area.value.slice(area.selectionStart,area.selectionEnd),'foo');}finally{f.dispose();}
  });
  await test('Replace All uses literal matches and preserves original Unicode offsets',async()=>{
    const f=fixture(true);try{const area=f.nodes.get('studioCode');area.value='İ foo foo.*';await area.dispatchEvent({type:'input'});f.nodes.get('studioFindQuery').value='foo';f.nodes.get('studioReplaceValue').value='$&';await f.nodes.get('studioReplaceAll').click();assert.equal(area.value,'İ $& $&.*');}finally{f.dispose();}
  });
  await test('Search and replacement treat regular-expression syntax as literal text',async()=>{
    const f=fixture(true);try{const area=f.nodes.get('studioCode');area.value='[x]+.* [x]+.*';await area.dispatchEvent({type:'input'});f.nodes.get('studioFindQuery').value='[x]+.*';f.nodes.get('studioReplaceValue').value='$1';await f.nodes.get('studioReplaceAll').click();assert.equal(area.value,'$1 $1');}finally{f.dispose();}
  });
  await test('Source change invalidates highlight/function caches',async()=>{
    const f=fixture(true);try{while(f.frames.length)f.frames.shift()(0);const funcs=f.nodes.get('studioFunctions');const area=f.nodes.get('studioCode');area.value=src+'\nfloat added(){return 1.0;}';await area.dispatchEvent({type:'input'});while(f.frames.length)f.frames.shift()(0);assert(funcs.children.some(option=>option.textContent.includes('added(')));}finally{f.dispose();}
  });
  await test('Unchanged source does not rebuild syntax highlight or function list',async()=>{
    const f=fixture(true);try{while(f.frames.length)f.frames.shift()(0);const highlight=f.nodes.get('studioHighlight'),functions=f.nodes.get('studioFunctions');let updates=0;
      for(const node of [highlight,functions]){const fn=node.replaceChildren.bind(node);node.replaceChildren=(...args)=>{updates++;fn(...args);};}
      await f.nodes.get('studioZoomIn').click();while(f.frames.length)f.frames.shift()(0);assert.equal(updates,0);}finally{f.dispose();}
  });
  await test('IME composition does not trigger Studio Undo',async()=>{
    const f=fixture();try{await input(f,src+'\n// keep');await f.nodes.get('studioCode').dispatchEvent({type:'keydown',key:'z',ctrlKey:true,isComposing:true});assert(f.studio.getProject().image.endsWith('keep'));}finally{f.dispose();}
  });
  await test('IME composition does not trigger editor Tab indentation',async()=>{
    const f=fixture(true);try{const area=f.nodes.get('studioCode'),before=area.value;await area.dispatchEvent({type:'keydown',key:'Tab',isComposing:true});assert.equal(area.value,before);}finally{f.dispose();}
  });
  console.log(`Deep regression: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
