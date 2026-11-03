require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/pack-settings-freeze.js — 저장 설정의 스키마/적용/거부 회귀 검사.
'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
let state={fpsLimit:60,resolutionScale:.75,maxPixels:2073600,debugHeatmap:true},
  march={maxSteps:128,maxDistance:100,surfaceEpsilon:.001,normalEpsilon:.002},
  user=[{name:'uGain',type:'float',value:.5,options:{min:0,max:1,step:.1}}],hidden=false,stored='';
const bounds={fpsLimit:[0,240],resolutionScale:[.25,1],maxPixels:[0,Number.MAX_SAFE_INTEGER],maxSteps:[1,512]};
const r={
  getStats:()=>({...state}),getRaymarchSettings:()=>({...march}),
  getUserUniforms:()=>user.map(x=>({...x})),
  setFpsLimit:v=>assign('fpsLimit',v),setResolutionScale:v=>assign('resolutionScale',v),
  setMaxPixels:v=>assign('maxPixels',v),setDebugHeatmap:v=>{assert.strictEqual(typeof v,'boolean');state.debugHeatmap=v;},
  setRaymarchSettings:v=>{march={...march,...v};},
  validateUniformValue:(type,value)=>{assert(Array.isArray(value)&&value.length===3&&value.every(Number.isFinite));},
  setUserUniforms:items=>{user=items;},
  removeUniform:k=>{user=user.filter(x=>x.name!==k);},defineUniform:(name,type,value,options)=>{user.push({name,type,value,options});}
};
function assign(name,v){assert(v>=bounds[name][0]&&v<=bounds[name][1]);state[name]=v;}
const localStorage={getItem:()=>stored,setItem:(_,text)=>{stored=text;},removeItem:()=>{stored='';}};
const document={dispatchEvent:()=>{},body:{classList:{contains:()=>hidden,toggle:(_,v)=>{hidden=v;},remove:()=>{hidden=false;}}}};
const window={localStorage,addEventListener:()=>{},removeEventListener:()=>{}};
let Settings;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/settings.js'),'utf8'),{
  define:(_,factory)=>Settings=factory(),console,setInterval:()=>1,clearInterval:()=>{},window,document,Event:class {constructor(type){this.type=type;}},Object,Number,Array,Map,Set
});
let passed=0;const ok=(condition,label)=>{assert(condition,label);console.log('PASS',label);passed++;};
const settings=Settings.mount(r);
const backup=settings.snapshot();ok(backup.user[0].name==='uGain' && !Object.hasOwn(backup,'required'),'단일 사용자 Uniform 스냅샷');
const pack=JSON.parse(JSON.stringify(backup));pack.rendering.fpsLimit=30;pack.raymarch.maxSteps=256;pack.panelHidden=true;
ok(settings.validatePack(pack)===pack,'Pack 유효성 검사');settings.applyPack(pack);
ok(state.fpsLimit===30 && march.maxSteps===256 && !hidden,'렌더링/레이마칭 적용 · 패널 표시는 Pack을 열어도 그대로');
ok(JSON.parse(stored).rendering.fpsLimit===30,'Pack 설정 저장 연동');
for(const [key,mutate] of Object.entries({
  invalidFps:x=>x.rendering.fpsLimit=241,
  invalidSteps:x=>x.raymarch.maxSteps=0,
  unknownRayKey:x=>x.raymarch.garbage=1,
  invalidBoolean:x=>x.rendering.debugHeatmap=1
})) {
  const bad=JSON.parse(JSON.stringify(pack));mutate(bad);assert.throws(()=>settings.validatePack(bad));
  ok(state.fpsLimit===30 && march.maxSteps===256,`${key} 적용 전 차단`);
}
settings.dispose();console.log(`Pack 설정 검증: ${passed}개 통과`);
