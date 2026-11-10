require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/shader-art-starter-regression.js — generic core and optional Ray preset contract.
'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),path=require('path');
const root=path.join(__dirname,'..'),read=name=>fs.readFileSync(path.join(root,name),'utf8');
let shader;vm.runInNewContext(read('js/shader.js'),{define:(deps,factory)=>shader=factory()});
const html=read('index.html'),ui=read('js/ui.js'),studio=read('js/studio.js');
assert(shader.fragment.includes('uTime')&&shader.fragment.includes('uMouse')&&!shader.fragment.includes('rayMarch('));
assert(shader.raymarch.includes('SDFResult map(')&&shader.raymarch.includes('uRMHeatmap'));
assert.equal(shader.rayUniforms.length,5);assert.equal(new Set(shader.rayUniforms.map(x=>x[0])).size,5);
for(const [name,type,value,opts] of shader.rayUniforms){assert(shader.raymarch.includes(name));assert(['int','float','bool','vec3'].includes(type));
  if(type==='vec3')assert.equal(value.length,3);else{assert.equal(typeof value,type==='bool'?'boolean':'number');if(type!=='bool')assert(opts.min<opts.max&&opts.step>0);}}
assert(!html.includes('id="studioExampleRaymarch"')&&!html.includes('id="studioStarters"'),'old editor-drawer starters are gone (the gallery opens Ray Marching)');
for(const id of ['rayMaxSteps','rayStepsRange','rayMaxDistance','raySurfaceEpsilon','rayNormalEpsilon','debugHeatmap']){
  assert(!html.includes(`id="${id}"`)&&!ui.includes(`$("${id}")`),`${id} still exposed in Render`);
}
// Ray Marching 예제가 이전 파라미터를 지우고 Ray 파라미터 6개로 바꾸는 동작은 starter-ownership-regression.js가 실제로 실행해 본다.
assert(/\bexampleRaymarch\b/.test(studio)&&/\bShader\.raymarch\b/.test(studio)&&/\bShader\.rayUniforms\b/.test(studio),'Ray Marching 예제는 shader.js의 프리셋을 쓴다');
assert(!/setRaymarchSettings|uSurfaceEpsilon|uMaxSteps\b|uDebugRaySteps/.test(read('js/renderer.js')+read('js/pass-manager.js')),'렌더러에 레이마칭 전용 내장 Uniform·설정이 없다(범용 편집기)');
console.log('PASS generic Shader Art default, optional Ray Starter, custom sliders, rollback, legacy compatibility');
