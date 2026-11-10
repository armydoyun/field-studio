require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/pack-settings-freeze.js — 저장 설정의 스키마/적용/거부 회귀 검사.
'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
let state={fpsLimit:60,resolutionScale:.75,maxPixels:2073600,timeScale:.5},
  user=[{name:'uGain',type:'float',value:.5,options:{min:0,max:1,step:.1}}],hidden=false,stored='';
const bounds={fpsLimit:[0,240],resolutionScale:[.25,1],maxPixels:[0,Number.MAX_SAFE_INTEGER],timeScale:[.05,8]};
const r={
  getStats:()=>({...state}),
  getUserUniforms:()=>user.map(x=>({...x})),
  setFpsLimit:v=>assign('fpsLimit',v),setResolutionScale:v=>assign('resolutionScale',v),
  setMaxPixels:v=>assign('maxPixels',v),setTimeScale:v=>assign('timeScale',v),
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
ok(backup.rendering.timeScale===.5,'재생 배속도 스냅샷에 담긴다');
ok(!Object.hasOwn(backup,'raymarch') && !Object.hasOwn(backup.rendering,'debugHeatmap'),'레이마칭 전용 설정은 더 이상 저장하지 않는다');
const pack=JSON.parse(JSON.stringify(backup));pack.rendering.fpsLimit=30;pack.rendering.timeScale=2;pack.panelHidden=true;
ok(settings.validatePack(pack)===pack,'Pack 유효성 검사');settings.applyPack(pack);
ok(state.fpsLimit===30 && state.timeScale===2 && !hidden,'렌더링·재생 배속 적용 · 패널 표시는 Pack을 열어도 그대로');
ok(JSON.parse(stored).rendering.fpsLimit===30,'Pack 설정 저장 연동');
for(const [key,mutate] of Object.entries({
  invalidFps:x=>x.rendering.fpsLimit=241,
  invalidTimeScale:x=>x.rendering.timeScale=9,
  textTimeScale:x=>x.rendering.timeScale='2'
})) {
  const bad=JSON.parse(JSON.stringify(pack));mutate(bad);assert.throws(()=>settings.validatePack(bad));
  ok(state.fpsLimit===30,`${key} 적용 전 차단`);
}
const old=JSON.parse(JSON.stringify(pack));old.raymarch={maxSteps:256,maxDistance:100,surfaceEpsilon:.001,normalEpsilon:.002};old.rendering.debugHeatmap=true;old.rendering.fpsLimit=45;
settings.applyPack(old);ok(state.fpsLimit===45,'레이마칭 설정이 든 예전 Pack도 그대로 열린다(그 항목은 무시)');
const legacy=JSON.parse(JSON.stringify(pack));delete legacy.rendering.timeScale;settings.applyPack(legacy);
ok(state.timeScale===1,'재생 배속이 없는 예전 Pack은 1×');
settings.reset();ok(state.timeScale===1,'설정 초기화하면 1×');
const saved=JSON.parse(stored);saved.rendering.timeScale=.25;stored=JSON.stringify(saved);ok(settings.load() && state.timeScale===.25,'저장된 재생 배속을 불러온다(새로고침 뒤에도 유지)');
saved.rendering.timeScale=99;stored=JSON.stringify(saved);settings.load();ok(state.timeScale===.25,'잘못 저장된 배속은 건너뛴다');
settings.dispose();console.log(`Pack 설정 검증: ${passed}개 통과`);
