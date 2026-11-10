// node tests/collapse-resize-regression.js — 설정 패널·편집기 리사이저를 최소 크기의 절반보다 작게 끌어 놓으면 숨긴다.
//   · 끄는 동안 '놓으면 숨김' 표시(panel-collapsing / studio-collapsing) · 다시 넓히면 취소 · 끌기 취소(pointercancel)는 숨기지 않음
//   · 숨길 때는 끌기 전 크기·저장 상태로 되돌린다(다시 열면 원래 크기)
'use strict';
const path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),load=name=>import(pathToFileURL(path.join(root,'js',name+'.js')).href);
const store=new Map();
globalThis.localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
const classes=()=>{const s=new Set();return {add:x=>s.add(x),remove:x=>s.delete(x),contains:x=>s.has(x),toggle:(x,on)=>{if(on===undefined?!s.has(x):on)s.add(x);else s.delete(x);return s.has(x);}};};
const element=(rect={left:0,right:1000,top:0,bottom:600,width:1000,height:600})=>{const listeners={};return {listeners,attrs:{},classList:classes(),offsetWidth:6,hidden:false,open:false,
  style:{props:{},setProperty(k,v){this.props[k]=v;}},addEventListener(type,fn){(listeners[type]??=[]).push(fn);},removeEventListener(){},
  setAttribute(k,v){this.attrs[k]=String(v);},removeAttribute(k){delete this.attrs[k];},setPointerCapture(){},releasePointerCapture(){},getBoundingClientRect:()=>rect,
  fire(type,extra={}){for(const fn of listeners[type]||[])fn({type,button:0,pointerId:1,preventDefault(){},...extra});},click(){this.fire('click');}};};
let passed=0;const check=(ok,label)=>{assert(ok,label);passed++;console.log('PASS',label);};
(async()=>{
  // ---- 설정 패널(workspace-layout) ----
  const W=await load('workspace-layout');
  const els={workspace:element(),panelResize:element(),panelGrip:element(),layoutReset:element(),panelToggle:element()};
  const body={classList:classes()},doc={getElementById:id=>els[id],documentElement:{classList:classes()},body,dispatchEvent(){},addEventListener(){},removeEventListener(){},
    defaultView:{matchMedia:()=>({matches:false}),innerWidth:1400,addEventListener(){},removeEventListener(){},CustomEvent:class{}}};
  globalThis.document=doc;globalThis.window=doc.defaultView;
  els.panelToggle.addEventListener('click',()=>body.classList.toggle('panel-hidden'));   // ui.js의 패널 버튼 대신
  const layout=W.mount({doc}),handle=els.panelResize;
  check(W.COLLAPSE===W.WIDTH.min/2,`숨김 기준: 최소 너비의 절반(${W.COLLAPSE}px)`);
  const drag=(...xs)=>{handle.fire('pointerdown');for(const x of xs)handle.fire('pointermove',{clientX:x});};
  drag(400,200);check(layout.width===240&&!body.classList.contains('panel-collapsing'),'최소 너비까지는 그냥 줄어든다');
  handle.fire('pointermove',{clientX:100});check(body.classList.contains('panel-collapsing')&&layout.width===240,'절반보다 좁게 끌면 놓으면 숨김 표시(너비는 최소에 머묾)');
  check(handle.attrs['aria-valuetext']==='놓으면 설정 패널을 숨깁니다','화면 읽기 프로그램에도 알린다');
  handle.fire('pointerup');
  check(body.classList.contains('panel-hidden')&&!body.classList.contains('panel-collapsing'),'놓으면 패널을 숨긴다');
  check(layout.width===300&&JSON.parse(store.get(W.KEY)).width===undefined,'숨길 때 끌기 전 너비로 되돌린다(정한 적 없으면 저장하지 않음)');
  body.classList.remove('panel-hidden');
  layout.setWidth(420);drag(100);handle.fire('pointermove',{clientX:300});
  check(!body.classList.contains('panel-collapsing'),'다시 넓게 끌면 숨김 취소');handle.fire('pointerup');
  check(!body.classList.contains('panel-hidden')&&layout.width===297,'취소한 끌기는 숨기지 않고 놓은 너비가 된다');
  layout.setWidth(420);drag(50);handle.fire('pointercancel');
  check(!body.classList.contains('panel-hidden')&&layout.width===420&&JSON.parse(store.get(W.KEY)).width===420,'끌기가 취소되면(pointercancel) 숨기지 않고 끌기 전 너비로');
  layout.dispose();

  // ---- 편집기(studio-layout) ----
  const L=await load('studio-layout');
  store.clear();
  window.innerWidth=1400;window.innerHeight=900;
  const ids={};const $=id=>(ids[id]??=element());const on=(node,type,fn)=>node.addEventListener(type,fn);
  let closed=0;
  const studio=L.create({$,on,editor:{update(){}},editorOpen:()=>true,onCollapse:()=>closed++});
  const resizer=$('studioResize'),stage=$('stage');
  check(studio.side()==='right','넓은 창은 옆 배치(오른쪽)');
  const pull=(...xs)=>{resizer.fire('pointerdown');for(const x of xs)resizer.fire('pointermove',{clientX:x});};
  pull(700,820);check(stage.style.props['--studio-width']==='30%'&&!stage.classList.contains('studio-collapsing'),'최소 너비(30%)까지는 그냥 줄어든다');
  resizer.fire('pointermove',{clientX:900});check(stage.classList.contains('studio-collapsing'),'15%보다 좁게 끌면 놓으면 숨김 표시');
  resizer.fire('pointerup');
  check(closed===1&&!stage.classList.contains('studio-collapsing'),'놓으면 편집기를 닫는다');
  check(stage.style.props['--studio-width']==='46%'&&!store.has(L.LAYOUT_KEY),'닫을 때 끌기 전 너비로 되돌리고, 정한 적 없는 배치는 저장하지 않는다');
  pull(900,600);resizer.fire('pointerup');check(closed===1&&stage.style.props['--studio-width']==='40%','다시 넓히고 놓으면 닫지 않는다');
  studio.setLayout('bottom');
  pull(560);resizer.fire('pointermove',{clientY:560});check(stage.classList.contains('studio-collapsing'),'아래 배치: 높이가 최소(25%)의 절반보다 작으면 숨김 표시');
  resizer.fire('lostpointercapture');check(closed===1&&!stage.classList.contains('studio-collapsing'),'포인터를 놓치면 닫지 않는다');
  console.log(`collapse resize: ${passed} checks passed`);
})().catch(error=>{console.error(error);process.exit(1);});
