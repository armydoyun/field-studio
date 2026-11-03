require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/shader-art-starter-regression.js — generic core and optional Ray preset contract.
'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),path=require('path');
const root=path.join(__dirname,'..'),read=name=>fs.readFileSync(path.join(root,name),'utf8');
let shader;vm.runInNewContext(read('js/shader.js'),{define:(deps,factory)=>shader=factory()});
const html=read('index.html'),ui=read('js/ui.js'),studio=read('js/studio.js');
assert(shader.fragment.includes('uTime')&&shader.fragment.includes('uMouse')&&!shader.fragment.includes('rayMarch('));
assert(shader.raymarch.includes('SDFResult map(')&&shader.raymarch.includes('uRMHeatmap'));
assert.equal(shader.rayUniforms.length,6);assert.equal(new Set(shader.rayUniforms.map(x=>x[0])).size,6);
for(const [name,type,value,opts] of shader.rayUniforms){assert(shader.raymarch.includes(name));assert(['int','float','bool','vec3'].includes(type));
  if(type==='vec3')assert.equal(value.length,3);else{assert.equal(typeof value,type==='bool'?'boolean':'number');if(type!=='bool')assert(opts.min<opts.max&&opts.step>0);}}
assert(!html.includes('id="studioExampleRaymarch"')&&!html.includes('id="studioStarters"'),'old editor-drawer starters are gone (the gallery opens Ray Marching)');
for(const id of ['rayMaxSteps','rayStepsRange','rayMaxDistance','raySurfaceEpsilon','rayNormalEpsilon','debugHeatmap']){
  assert(!html.includes(`id="${id}"`)&&!ui.includes(`$("${id}")`),`${id} still exposed in Render`);
}
assert(studio.includes('const exampleRaymarch')&&studio.includes('renderer.applyPortable(next,users)'));
assert(studio.includes('image:Shader.raymarch,passes:[],imageChannels:{}')&&studio.includes('adoptProject(next)'));
assert(read('js/renderer.js').includes('setRaymarchSettings'),'legacy shader API retained');
console.log('PASS generic Shader Art default, optional Ray Starter, custom sliders, rollback, legacy compatibility');
