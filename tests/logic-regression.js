require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/logic-regression.js — production modules with deterministic DOM/GPU/async boundaries.
// No real GLSL compiler: driver rendering remains covered by gpu-validation.html.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {mockGL}=require('./architecture-regression');
const root=process.env.SHADER_TEST_ROOT || path.resolve(__dirname,'..');
let passed=0,failed=0;
async function test(name,run){try{await run();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,'—',e.message);}}
function fixture(_realEditor=false,compact=false,initialStorage={}){
  const metrics={stringify:0,locations:0,maxQueries:0,arrays:0,paints:0};
  const gl=mockGL(),nodes=new Map(),storage=new Map(Object.entries(initialStorage)),frames=[],reads=[],outputs=[],errors=[];let pendingBitmap=null,closed=0,textureCreates=0;
  const getLocation=gl.getUniformLocation,getParameter=gl.getParameter;
  gl.getUniformLocation=(...args)=>{metrics.locations++;return getLocation(...args);};
  gl.getParameter=key=>{if(key===gl.MAX_TEXTURE_SIZE)metrics.maxQueries++;return getParameter(key);};
  const createTexture=gl.createTexture;gl.createTexture=()=>{textureCreates++;return createTexture();};
  class Node {
    constructor(){this.children=[];this.listeners=new Map();this.textContent='';this.value='';this.hidden=false;this.checked=false;this.disabled=false;this.dataset={};this.selectionStart=this.selectionEnd=this.scrollTop=this.scrollLeft=0;this.selectionDirection='none';this.firstChild={textContent:''};this.style={setProperty(){}};this.classList={contains:()=>false,toggle(){},add(){},remove(){}};}
    addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn);}
    removeEventListener(){} setAttribute(){} removeAttribute(){} append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;}
    setRangeText(text,start,end,mode){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.selectionStart=mode==='select'?start:start+text.length;this.selectionEnd=start+text.length;}
    remove(){} focus(){document.activeElement=this;} select(){} setSelectionRange(a,b,d='none'){this.selectionStart=a;this.selectionEnd=b;this.selectionDirection=d;}
    setPointerCapture(id){this.pointerCapture=id;} hasPointerCapture(id){return this.pointerCapture===id;} releasePointerCapture(){this.pointerCapture=null;}
    showModal(){this.open=true;} close(){this.open=false;} reportValidity(){return true;} closest(selector){return selector==='.studio-editor-frame'?new Node():null;}
    get options(){return this.children;} click(){return this.dispatchEvent({type:'click'});}
    // 실제 DOM처럼 자손을 찾는다. 테스트가 쓰는 단순 선택자(tag · [data-x] · tag[data-x])만 해석하고 나머지는 찾지 못한 것으로 둔다.
    querySelectorAll(selector){const m=/^([a-z]+)?(?:\[data-([\w-]+)\])?$/i.exec(selector);if(!m||(!m[1]&&!m[2]))return [];const key=m[2]?.replace(/-(\w)/g,(_,c)=>c.toUpperCase()),out=[];
      const walk=node=>{for(const child of node.children||[]){if((!m[1]||child.tagName===m[1].toUpperCase())&&(!key||child.dataset?.[key]!==undefined))out.push(child);walk(child);}};walk(this);return out;}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    dispatchEvent(e){e.currentTarget=this;e.target=this;e.defaultPrevented=false;e.preventDefault=()=>{e.defaultPrevented=true;};e.stopPropagation=()=>{e.propagationStopped=true;};
      const pending=(this.listeners.get(e.type)||[]).map(fn=>fn(e));e.currentTarget=null;return Promise.all(pending);}
  }
  const document=new Node();document.body=new Node();document.hidden=false;
  document.getElementById=id=>{if(!nodes.has(id)){const node=new Node();node.hidden=['studioFindPanel','studioCompletion'].includes(id);nodes.set(id,node);}return nodes.get(id);};document.createElement=tag=>{const node=new Node();node.tagName=String(tag).toUpperCase();if(tag==='canvas')Object.assign(node,{getContext:()=>({putImageData(){}}),toBlob:cb=>cb(new Blob(['png'],{type:'image/png'}))});return node;};
  document.createDocumentFragment=()=>new Node();document.createTextNode=text=>Object.assign(new Node(),{textContent:text});
  const localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  const window={devicePixelRatio:1,localStorage,indexedDB:null,matchMedia:()=>({matches:compact}),addEventListener(){},removeEventListener(){}};
  const modules={},contexts={};let rafSerial=0;const scope={console:{error:e=>errors.push(e),warn(){},log(){}},document,window,localStorage,Element:Node,
    AbortController,Event:class{constructor(type){this.type=type;}},File,Blob,Uint8Array,Uint8ClampedArray,Float32Array:class extends Float32Array{constructor(...args){super(...args);metrics.arrays++;}},Map,Set,Object,Array,Number,Math,Error,TypeError,RangeError,atob,
    JSON:{parse:JSON.parse,stringify:(...args)=>{metrics.stringify++;return JSON.stringify(...args);}},
    Option:class extends Node{constructor(text,value){super();this.textContent=text;this.value=value;}},getComputedStyle:()=>({lineHeight:'20'}),
    ImageData:class{},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
    requestAnimationFrame:f=>{f.rafId=++rafSerial;frames.push(f);return f.rafId;},cancelAnimationFrame:id=>{const at=frames.findIndex(f=>f.rafId===id);if(at>=0)frames.splice(at,1);},
    URL:{createObjectURL:blob=>{outputs.push(blob);return 'blob:test';},revokeObjectURL(){}},
    FileReader:class{readAsDataURL(file){reads.push(()=>{this.result='data:'+file.type+';base64,AA==';this.onload();});}},
    createImageBitmap:async()=>pendingBitmap?await pendingBitmap:{width:2,height:2,close(){closed++;}}
  };
  function load(name){if(modules[name])return modules[name];const context={...scope,define:(deps,fn)=>modules[name]=fn(...deps.map(load))};contexts[name]=context;vm.runInNewContext(fs.readFileSync(path.join(root,'js',name+'.js'),'utf8'),context,{filename:name+'.js'});return modules[name];}
  const canvas=new Node();Object.assign(canvas,{width:100,height:60,clientWidth:100,clientHeight:60,getContext:()=>gl});
  const shader=load('shader'),renderer=load('renderer').createRenderer(canvas,shader);
  const settings=load('settings').mount(renderer);
  // 편집기(CodeMirror)는 실제 DOM이 필요하므로 Node 검사에서는 가짜로 대신한다. #studioCode 노드가 소스를 담는 창구 역할을 그대로 한다.
  // 편집기 자체의 동작은 브라우저 테스트(tests/cm-editor-browser-regression.py)가 검사한다. realEditor 인자는 예전 호출과의 호환을 위해 남겨 둔다.
  let editorAsk=null;modules['cm-editor']={mount:(textarea,ask)=>{editorAsk=ask;return {update(){},goToLine(){},setDiagnostics(){},registerCommands(){},openPalette(){},showFind(){},dispose(){}};}};
  const studio=load('studio').mount(renderer,shader,settings);
  return {ask:(...args)=>editorAsk(...args),gl,renderer,studio,shader,settings,nodes,storage,reads,outputs,errors,frames,load,canvas,document,window,contexts,metrics,
    deferBitmap:()=>{let resolve;pendingBitmap=new Promise(r=>resolve=r);return ()=>resolve({width:2,height:2,close(){closed++;}});},
    resources:()=>({closed,textureCreates}),dispose:()=>{studio.dispose();settings.dispose();renderer.dispose();}};
}
const src='#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){fragColor=vec4(1.0);}';
const scene=(image=src)=>({image,passes:[],imageChannels:{}}),pass=(name='A')=>({name,fragment:src,scale:1,format:'rgba8',channels:{}});
async function main(){
  for(const precision of ['precision mediump float;','precision  highp float;','precision\nlowp float;'])await test('Uniform injection: '+JSON.stringify(precision),()=>{
    const f=fixture();try{f.renderer.defineUniform('uGain','float',1);assert(f.renderer.validateFragment(src.replace('precision highp float;',precision)));}finally{f.dispose();}
  });
  await test('Commented precision is not an insertion point',()=>{
    const f=fixture();try{f.renderer.defineUniform('uGain','float',1);f.renderer.validateFragment(src.replace('precision highp float;','// precision highp float;\nprecision mediump float;'));
      const text=f.gl.compiledSources.at(-1);assert(text.indexOf('uniform float uGain;')>text.indexOf('precision mediump float;'));}finally{f.dispose();}
  });
  await test('Comma-separated uniforms are not duplicated',()=>{
    const f=fixture();try{f.renderer.defineUniform('uGain','float',1);f.renderer.validateFragment(src.replace('out vec4','uniform float uOther, uGain;\nout vec4'));
      assert(!f.gl.compiledSources.at(-1).includes('uniform float uGain;'));}finally{f.dispose();}
  });
  await test('Same-line shader diagnostic maps to source, not generated Uniform',()=>{
    const f=fixture();try{f.renderer.defineUniform('uGain','float',1);let error;try{f.renderer.validateFragment('#version 300 es\nprecision mediump float; void main(){GLSL_ERROR}');}catch(e){error=e;}
      const n=Number(/ERROR: 0:(\d+):/.exec(error.message)?.[1]),info=error.glslInjected;
      assert(info);assert(n>info.after+(info.generated??info.count));assert.equal(n-info.count,2);}finally{f.dispose();}
  });
  await test('Uniform failure retains original program objects without rollback compilation',()=>{
    const f=fixture();try{f.renderer.setPasses([pass()]);const before=f.gl.programs.filter(p=>!f.gl.deleted.includes(p));let links=0;
      f.gl.getProgramParameter=()=>++links<2;assert.throws(()=>f.renderer.defineUniform('uFail','float',1));
      assert(before.every(p=>!f.gl.deleted.includes(p)));assert.equal(f.renderer.getUserUniforms().length,0);assert.equal(links,2);
    }finally{f.dispose();}
  });
  await test('Portable failure retains original image and buffer programs',()=>{
    const f=fixture();try{f.renderer.setPasses([pass()]);const before=f.gl.programs.filter(p=>!f.gl.deleted.includes(p)),image=f.renderer.getFragmentSource();let links=0;
      f.gl.getProgramParameter=()=>++links<2;assert.throws(()=>f.renderer.applyPortable({...scene(),passes:[pass()]},[{name:'uFail',type:'float',value:1}]));
      assert(before.every(p=>!f.gl.deleted.includes(p)));assert.equal(f.renderer.getFragmentSource(),image);assert.equal(f.renderer.getUserUniforms().length,0);assert.equal(links,2);
    }finally{f.dispose();}
  });
  await test('Late Buffer location failure preserves all programs and feedback targets',()=>{
    const f=fixture();try{
      const before={...scene(),passes:[pass('A'),pass('B')]};assert(f.studio.setProject(before));f.renderer.start();f.frames.shift()(100);f.renderer.stop();
      const live=f.gl.programs.filter(p=>!f.gl.deleted.includes(p)), memory=f.renderer.getStats().bufferMemoryBytes, objects=f.resources().textureCreates;
      const location=f.gl.getUniformLocation;f.gl.attachShader=(program,shader)=>{if(shader.source.includes('CHANGED_B'))program.failLocations=true;};
      f.gl.getUniformLocation=(program,name)=>{if(program.failLocations)throw Error('injected Buffer location failure');return location(program,name);};
      const next={...scene(src+'\n// new image'),passes:[{...pass('A'),fragment:src+'\n// CHANGED_A'},{...pass('B'),fragment:src+'\n// CHANGED_B'}]};
      assert.equal(f.studio.setProject(next),false);assert(live.every(p=>!f.gl.deleted.includes(p)));
      assert.equal(f.renderer.getStats().bufferMemoryBytes,memory);assert.equal(f.resources().textureCreates,objects);
      assert.equal(f.renderer.getPassDefinitions()[0].fragment,src);assert.equal(f.renderer.getFragmentSource(),src);
    }finally{f.dispose();}
  });
  await test('Source-only Run compiles each changed program once and preserves feedback',()=>{
    const f=fixture();try{
      assert(f.studio.setProject({...scene(),passes:[pass()]}));f.renderer.start();f.frames.shift()(100);f.renderer.stop();
      const memory=f.renderer.getStats().bufferMemoryBytes, count=f.gl.programs.length;
      assert(f.studio.setProject({...scene(src+'\n// image change'),passes:[{...pass(),fragment:src+'\n// buffer change'}]}));
      assert.equal(f.gl.programs.length-count,2);assert.equal(f.renderer.getStats().bufferMemoryBytes,memory);
    }finally{f.dispose();}
  });
  await test('Channel-only Run avoids compilation; removing final Buffer resets frame',()=>{
    const f=fixture();try{
      assert(f.studio.setProject({...scene(),passes:[pass()]}));f.renderer.start();f.frames.shift()(100);f.renderer.stop();
      const count=f.gl.programs.length;
      assert(f.studio.setProject({...scene(),passes:[pass()],imageChannels:{0:{buffer:'A',frame:'current'}}}));
      assert.equal(f.gl.programs.length,count);assert.equal(f.renderer.getStats().frame,1);
      assert(f.studio.setProject(scene()));assert.equal(f.renderer.getStats().frame,0);
    }finally{f.dispose();}
  });
  await test('Ray starter compiles new scene instead of injecting into old scene',()=>{
    const f=fixture();try{const old=src.replace('out vec4','uniform float uRMMaxSteps;\nout vec4');assert(f.studio.setProject(scene(old)));
      assert.equal(f.studio.exampleRaymarch(),true);assert.equal(f.renderer.getFragmentSource(),f.shader.raymarch);assert.equal(f.renderer.getUserUniforms().length,6);
    }finally{f.dispose();}
  });
  await test('Failed Ray starter preserves project and user Uniform registry',()=>{
    const f=fixture();try{const before=f.studio.getProject();f.gl.getProgramParameter=()=>false;
      assert.equal(f.studio.exampleRaymarch(),false);assert.deepEqual(f.studio.getProject(),before);assert.equal(f.renderer.getUserUniforms().length,0);
    }finally{f.dispose();}
  });
  await test('Export button recovers after async event dispatch',async()=>{
    const f=fixture();try{const button=f.nodes.get('studioExportPack');await button.click();assert.equal(button.disabled,false);assert.equal(f.outputs.length,1);}finally{f.dispose();}
  });
  await test('Pack captures project, selected tab and settings before asynchronous reads',async()=>{
    const f=fixture();try{const added=await f.renderer.addTexture(new File(['x'],'a.png',{type:'image/png'}));
      const before={...scene(),imageChannels:{0:{texture:added.id}}};assert(f.studio.setProject(before));f.renderer.setFpsLimit(30);
      const pending=f.studio.exportPack();assert.equal(f.reads.length,1);assert(f.studio.setProject(scene(src+'\n// later edit')));f.renderer.setFpsLimit(60);
      f.reads.shift()();await pending;const data=JSON.parse(await f.outputs.at(-1).text());
      assert.deepEqual(data.project,before);assert.equal(data.settings.rendering.fpsLimit,30);assert.equal(data.textures[0].id,added.id);
    }finally{f.dispose();}
  });
  await test('Imported selected tab is persisted with the new project',async()=>{
    const f=fixture();try{const pack={version:3,project:{...scene(),passes:[pass()]},selected:'A',textures:[],settings:f.settings.snapshot()};
      assert(await f.studio.importPack(new File([JSON.stringify(pack)],'pack.json')));
      assert.equal(JSON.parse(f.storage.get('webgl.shader-studio.project.v1')).selected,'A');
    }finally{f.dispose();}
  });
  await test('Decode finishing after disposal closes bitmap and creates no GPU texture',async()=>{
    const f=fixture();const release=f.deferBitmap(),pending=f.renderer.addTexture(new File(['x'],'a.png',{type:'image/png'}));const before=f.resources();
    f.dispose();release();await assert.rejects(pending,/폐기/);assert.equal(f.resources().textureCreates,before.textureCreates);assert.equal(f.resources().closed,before.closed+1);
  });
  await test('Concurrent same-ID texture imports cannot overwrite live GPU resources',async()=>{
    const f=fixture(),textures=f.load('texture-input').createTextureInput(f.gl);try{const release=f.deferBitmap(),file=new File(['x'],'a.png',{type:'image/png'});
      const a=textures.add(file,'fixed'),b=textures.add(file,'fixed');release();const results=await Promise.allSettled([a,b]);
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(textures.list().length,1);
    }finally{textures.dispose();f.dispose();}
  });
  await test('Direct registration obeys the same 64-Uniform limit as Pack import',()=>{
    const f=fixture();try{f.renderer.applyPortable(scene(),Array.from({length:64},(_,i)=>({name:'u'+i,type:'float',value:0})));
      assert.throws(()=>f.renderer.defineUniform('uOverflow','float',0),/64/);assert.equal(f.renderer.getUserUniforms().length,64);
    }finally{f.dispose();}
  });
  console.log(`Logic regression: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
}
if(require.main===module)main();
module.exports={fixture,src,scene,pass};
