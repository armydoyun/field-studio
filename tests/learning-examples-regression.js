'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./logic-regression');
const equal=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
let passed=0,failed=0;
function test(name,fn){const f=fixture();try{fn(f);passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack);}finally{f.dispose();}}
for(const kind of ['examplePipeline','exampleFeedback']){
 test(kind+' connects current A → B and both sources to the Image comparison',f=>{
  assert(f.studio[kind]());const p=f.studio.getProject(),[a,b]=p.passes;
  equal([a.name,b.name],['A','B']);equal(a.channels,{});equal(b.channels[0],{buffer:'A',frame:'current'});
  equal(p.imageChannels,{0:{buffer:'B',frame:'current'},1:{buffer:'A',frame:'current'}});
  assert(p.image.includes('original ? texture(iChannel1, uv)'));assert(p.image.includes('iChannel0 = B (current)'));
  assert(a.fragment.includes('Buffer A:'));assert(b.fragment.includes('Buffer B:'));
  assert.equal(f.renderer.getUserUniforms().length,0);assert.equal(f.renderer.getTextures().length,0);
 });
 test(kind+' leaves previous project usable when a Buffer fails compilation',f=>{
  const before=f.studio.getProject();f.renderer.defineUniform('uOld','float',1);let links=0;f.gl.getProgramParameter=()=>++links<3;
  assert.equal(f.studio[kind](),false);equal(f.studio.getProject(),before);assert.equal(f.renderer.getUserUniforms()[0].name,'uOld');
 });
}
test('Pipeline has no previous-frame dependency and performs an explicit color transformation',f=>{
 assert(f.studio.examplePipeline());const b=f.studio.getProject().passes[1];equal(Object.keys(b.channels),['0']);assert(b.fragment.includes('source.brg'));
});
test('Feedback reads its own previous frame, guards first frame, and decays by elapsed time',f=>{
 assert(f.studio.exampleFeedback());const b=f.studio.getProject().passes[1];equal(b.channels[1],{buffer:'B',frame:'previous'});
 assert(b.fragment.includes('uFrame == 0'));assert(b.fragment.includes('texture(iChannel1, uv)'));assert(b.fragment.includes('max(0.8 * uDeltaTime, 1.0 / 255.0)'));assert(b.fragment.includes('max(source, history - fade)'));
});
test('Undo/Redo restores complete pipeline and feedback channel configurations',f=>{
 assert(f.studio.examplePipeline());const p=f.studio.getProject();assert(f.studio.exampleFeedback());const q=f.studio.getProject();assert(f.studio.undo());equal(f.studio.getProject(),p);assert(f.studio.redo());equal(f.studio.getProject(),q);
});
test('Doom Fire code, button, and API are removed',f=>{
 const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),studio=fs.readFileSync(path.join(root,'js/studio.js'),'utf8');
 assert.equal(f.studio.exampleFire,undefined);assert(!/Doom Fire|studioExampleFire/.test(html));assert(!/fireColor|const fire =|exampleFire/.test(studio));
 // 편집기 서랍의 옛 "시작 예제" 묶음은 갤러리와 겹쳐 제거됐다. 같은 예제는 갤러리 카드가 Studio API로 연다.
 assert(!/id="studioStarters"|id="studioExample(Pipeline|Feedback|Raymarch)"/.test(html));
 const gallery=fs.readFileSync(path.join(root,'js/gallery.js'),'utf8');for(const action of ['examplePipeline','exampleFeedback','exampleRaymarch'])assert(gallery.includes(`action:"${action}"`)&&typeof f.studio[action]==='function',action);
 assert(/id="studioReset"[^>]*>새 프로젝트/.test(html.slice(html.indexOf('id="studioFiles"'))),'new-project button lives in the project files group');
});
console.log(`Learning examples: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
