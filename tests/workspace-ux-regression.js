'use strict';
const assert=require('node:assert/strict'),{fixture,src,pass}=require('./logic-regression');
let passed=0,failed=0;
const classes=()=>{const set=new Set();return {add(...names){names.forEach(x=>set.add(x));},remove(...names){names.forEach(x=>set.delete(x));},contains:x=>set.has(x),toggle(x,on=!set.has(x)){if(on)set.add(x);else set.delete(x);return on;}};};
async function test(name,fn,compact=false,initialStorage={}){const f=fixture(false,compact,initialStorage);let ui;try{
 const N=f.canvas.constructor,n=id=>f.document.getElementById(id),scroll=new N();
 N.prototype.setAttribute=function(k,v){(this.attrs??={})[k]=String(v);};N.prototype.removeAttribute=function(k){delete this.attrs?.[k];};
 const tabs=['uniforms','render','input'].map(tab=>Object.assign(new N(),{dataset:{tab}})),views=tabs.map(t=>Object.assign(n('view-'+t.dataset.tab),{dataset:{panel:t.dataset.tab},hidden:t.dataset.tab!=='uniforms'}));
 N.prototype.querySelector=function(s){if(s==='option[data-custom]')return this.children.find(x=>x.dataset.custom)||null;if(s==='.panel-scroll')return scroll;if(s==='summary')return this.summary??=new N();if(s.startsWith('[data-tab='))return tabs.find(t=>s.includes(t.dataset.tab));return null;};N.prototype.querySelectorAll=()=>[];
 f.document.querySelectorAll=s=>s==='#panelTabs [data-tab]'?tabs:s==='.panel-view'?views:[];
 f.document.body.classList=classes();n('stage').classList=classes();n('studioDock').hidden=true;
 n('uniformType').value='float';n('uniformBoolValue').value='false';f.window.shaderStudio=f.studio;
 const module=f.load('ui');let tick;f.contexts.ui.setInterval=fn=>{tick=fn;return 1;};ui=module.mount(f.renderer,{getCamera:()=>null,resetCamera(){}},f.settings);
 await fn(f,n,{tabs,views,scroll,tick});passed++;console.log('PASS',name);
}catch(e){failed++;console.error('FAIL',name,e.stack);}finally{ui?.dispose();f.dispose();}}
const edit=async(f,text)=>{const area=f.nodes.get('studioCode');area.value=text;await area.dispatchEvent({type:'input'});return area;};
const select=async(f,name)=>f.nodes.get('studioPassTabs').children.find(x=>x.textContent===(name==='Image'?'Image':'Buffer '+name)).click();
(async()=>{
await test('Editing shows pending state and last-successful-preview notice; Run clears both',async(f,n)=>{
 await edit(f,src+'\n// edit');assert.equal(n('studioState').dataset.state,'dirty');assert.equal(n('previewNotice').hidden,false);assert.equal(n('studioRun').dataset.pending,'true');
 assert(f.studio.apply());assert.equal(n('studioState').dataset.state,'applied');assert.equal(n('previewNotice').hidden,true);assert.equal(n('studioRun').dataset.pending,'false');
});
await test('Compile failure preserves active output and identifies the draft as erroneous',async(f,n)=>{
 const old=f.renderer.getFragmentSource();await edit(f,src+'\n// bad');f.gl.getProgramParameter=()=>false;
 assert.equal(f.studio.apply(),false);assert.equal(f.renderer.getFragmentSource(),old);assert.equal(n('studioState').dataset.state,'error');assert.match(n('previewNotice').textContent,/마지막 성공/);
});
await test('A fresh edit clears stale diagnostics instead of keeping old line links',async(f,n)=>{
 await edit(f,src+'\n// bad');f.gl.getProgramParameter=()=>false;f.studio.apply();assert.equal(n('studioErrorToggle').hidden,false);
 await edit(f,src+'\n// corrected');assert.equal(n('studioErrorToggle').hidden,true);assert.equal(n('studioDiagnostics').children.length,0);assert.equal(n('studioState').dataset.state,'dirty');
});
await test('Each pass restores its own selection and scroll after switching tabs',async(f,n)=>{
 f.studio.setProject({image:src,passes:[pass()],imageChannels:{}});const area=n('studioCode');area.setSelectionRange(7,12);area.scrollTop=88;area.scrollLeft=16;
 await select(f,'A');area.setSelectionRange(3,5);area.scrollTop=21;area.scrollLeft=8;
 await select(f,'Image');assert.equal(area.selectionStart,7);assert.equal(area.selectionEnd,12);assert.equal(area.scrollTop,88);assert.equal(area.scrollLeft,16);
 await select(f,'A');assert.equal(area.selectionStart,3);assert.equal(area.selectionEnd,5);assert.equal(area.scrollTop,21);assert.equal(area.scrollLeft,8);
});
await test('Replacing a pass source invalidates its old cursor bookmark',async(f,n)=>{
 f.studio.setProject({image:src,passes:[pass()],imageChannels:{}});await select(f,'A');n('studioCode').setSelectionRange(15,15);await select(f,'Image');
 f.studio.setProject({image:src,passes:[{...pass(),fragment:src+'\n// new'}],imageChannels:{}});await select(f,'A');assert.equal(n('studioCode').selectionStart,0);
});
await test('Image hides inapplicable Buffer actions and disables pixel inspection',async(f,n)=>{
 f.studio.setProject({image:src,passes:[pass()],imageChannels:{}});assert.equal(n('studioPassTools').hidden,true);
 await select(f,'A');assert.equal(n('studioPassTools').hidden,false);assert.equal(n('studioInputsTitle').textContent,'A · 입력');
});
await test('Buffer count cap disables Add and pass tabs identify their controlled editor',async(f,n)=>{
 f.studio.setProject({image:src,passes:[...'ABCDEFGH'].map(pass),imageChannels:{}});assert.equal(n('studioAdd').disabled,true);
 assert.equal(n('studioPassTabs').children[0].attrs['aria-controls'],'studioCode');assert.equal(n('studioCode').attrs['aria-labelledby'],'studioTab-Image');
});
await test('Viewport playback button and editor command share playback state',async(f,n)=>{
 await n('previewPause').click();assert.equal(f.renderer.getStats().running,true);assert.equal(n('renderState').textContent,'재생 중');
 await n('studioPause').click();assert.equal(f.renderer.getStats().running,false);await n('previewPause').click();assert.equal(f.renderer.getStats().running,true);
});
await test('Paused focus mode does not resume after user changes the intended playback state',async(f,n)=>{
 f.renderer.start();await n('studioMaximize').click();assert.equal(f.renderer.getStats().running,false);assert.equal(f.studio.getPlaybackState(),true);
 await n('previewPause').click();assert.equal(f.studio.getPlaybackState(),false);await n('studioMaximize').click();assert.equal(f.renderer.getStats().running,false);
});
await test('Final Image button exits Buffer preview without changing the editing pass',async(f,n)=>{
 f.studio.setProject({image:src,passes:[pass()],imageChannels:{}});await select(f,'A');assert.equal(f.renderer.getStats().previewPass,'A');await n('previewImage').click();assert.equal(f.renderer.getStats().previewPass,null);assert.equal(n('studioCodeTitle').textContent,'Buffer A.frag');assert.equal(n('previewImage').disabled,true);assert.equal(n('studioPreviewTarget').textContent,'Image');
});
await test('Editing a buffer while viewing the final Image keeps the Image preview after apply',async(f,n)=>{
 f.studio.setProject({image:src,passes:[pass()],imageChannels:{}});await select(f,'A');assert.equal(f.renderer.getStats().previewPass,'A','탭을 바꾸면 그 패스를 따라간다');
 await n('previewImage').click();assert.equal(f.renderer.getStats().previewPass,null);
 await edit(f,src+'\n// buffer edit');await n('studioRun').click();
 assert.equal(f.renderer.getStats().previewPass,null,'적용해도 미리보기가 다시 Buffer A로 바뀌지 않는다');assert.equal(n('studioCodeTitle').textContent,'Buffer A.frag');
});
await test('The preview label toggles between the final Image and the pass being edited',async(f,n)=>{
 f.studio.setProject({image:src,passes:[pass()],imageChannels:{}});
 assert.equal(n('studioPreviewTarget').disabled,true,'Image를 고치며 Image를 보고 있으면 오갈 곳이 없다');
 await select(f,'A');assert.equal(n('studioPreviewTarget').textContent,'Buffer A');assert.equal(n('studioPreviewTarget').disabled,false);
 await n('studioPreviewTarget').click();assert.equal(f.renderer.getStats().previewPass,null);assert.equal(n('studioPreviewTarget').textContent,'Image');
 await n('studioPreviewTarget').click();assert.equal(f.renderer.getStats().previewPass,'A');assert.equal(n('studioPreviewTarget').textContent,'Buffer A');
});
await test('Pinning the preview keeps it when switching tabs and is remembered',async(f,n)=>{
 f.studio.setProject({image:src,passes:[pass(),{...pass(),name:'B'}],imageChannels:{}});await select(f,'A');
 await n('studioPreviewTarget').click();assert.equal(f.renderer.getStats().previewPass,null);
 await n('studioPreviewPin').click();assert.equal(n('studioPreviewPin').attrs['aria-pressed'],'true');assert.equal(f.storage.get('field.previewPinned.v1'),'1');
 await select(f,'B');assert.equal(f.renderer.getStats().previewPass,null,'고정하면 탭을 바꿔도 Image 그대로');
 await n('studioPreviewTarget').click();assert.equal(f.renderer.getStats().previewPass,'B','버튼으로는 지금 편집 중인 B로 바꿀 수 있다');
 await select(f,'Image');assert.equal(f.renderer.getStats().previewPass,'B','고정 중에는 Image 탭으로 가도 B 그대로');
 await n('studioPreviewPin').click();assert.equal(n('studioPreviewPin').attrs['aria-pressed'],'false');assert.equal(f.storage.get('field.previewPinned.v1'),'0');
 await select(f,'A');assert.equal(f.renderer.getStats().previewPass,'A','고정을 풀면 다시 탭을 따라간다');
});
await test('A pinned preview survives reloads but a new project still starts from its selected tab',async(f,n)=>{
 f.studio.setProject({image:src,passes:[pass()],imageChannels:{}});await select(f,'A');assert.equal(f.renderer.getStats().previewPass,null,'저장된 고정 상태로 시작해 탭을 따라가지 않는다');
 await n('studioPreviewTarget').click();assert.equal(f.renderer.getStats().previewPass,'A');
 f.studio.setProject({image:src,passes:[],imageChannels:{}});assert.equal(f.renderer.getStats().previewPass,null,'보던 버퍼가 없는 새 프로젝트는 Image로');
},false,{'field.previewPinned.v1':'1'});
await test('Project menu opens from the viewport without the editor and closes with Escape',async(f,n)=>{
 assert.equal(n('studioDock').hidden,true);assert.equal(n('projectMenu').hidden,true);
 await n('projectMenuToggle').click();assert.equal(n('projectMenu').hidden,false);assert.equal(n('projectMenuToggle').attrs['aria-expanded'],'true');
 await n('projectMenu').dispatchEvent({type:'keydown',key:'Escape'});assert.equal(n('projectMenu').hidden,true);assert.equal(n('projectMenuToggle').attrs['aria-expanded'],'false');
 await f.document.dispatchEvent({type:'keydown',key:'o',ctrlKey:true});assert.equal(n('projectMenu').hidden,false,'Ctrl+O opens the project menu');
 await f.document.dispatchEvent({type:'keydown',key:'o',ctrlKey:true});assert.equal(n('projectMenu').hidden,true,'Ctrl+O again closes it');
 assert.equal(n('studioDock').hidden,true,'the editor stays closed');
});
await test('Ctrl+Shift+S saves to the project store from anywhere',async(f,n)=>{
 let clicks=0;n('studioProjectSave').click=()=>{clicks++;};
 await f.document.dispatchEvent({type:'keydown',key:'S',ctrlKey:true,shiftKey:true});assert.equal(clicks,1);
 assert.equal(n('studioDock').hidden,true,'saving does not open the editor');
});
await test('Resizer supports limits and a default-height reset',async(f,n)=>{
 const heights=[];n('studioDock').style.setProperty=(_,value)=>heights.push(value);
 await n('studioResize').dispatchEvent({type:'keydown',key:'Home'});assert.equal(heights.at(-1),'25%');await n('studioResize').dispatchEvent({type:'keydown',key:'End'});assert.equal(heights.at(-1),'85%');await n('studioResize').dispatchEvent({type:'dblclick'});assert.equal(heights.at(-1),'55%');
});
await test('Lost pointer capture stops resizing and zero-height geometry is ignored',async(f,n)=>{
 let writes=0;n('studioDock').style.setProperty=()=>writes++;n('stage').getBoundingClientRect=()=>({bottom:100,height:0});
 await n('studioResize').dispatchEvent({type:'pointerdown',button:0,pointerId:1});await n('studioResize').dispatchEvent({type:'pointermove',clientY:50});assert.equal(writes,0);
 n('stage').getBoundingClientRect=()=>({bottom:100,height:100});await n('studioResize').dispatchEvent({type:'lostpointercapture'});await n('studioResize').dispatchEvent({type:'pointermove',clientY:50});assert.equal(writes,0);
});
await test('Parameter navigation keeps the editor open on desktop',async(f,n)=>{
 f.studio.open();await n('studioParameters').click();assert.equal(n('studioDock').hidden,false);assert.equal(f.document.activeElement,n('uniformSearch'));
});
await test('Panel tabs remember independent scroll positions',async(f,n,{tabs,scroll})=>{
 scroll.scrollTop=90;await tabs[1].click();assert.equal(scroll.scrollTop,0);scroll.scrollTop=150;await tabs[0].click();assert.equal(scroll.scrollTop,90);await tabs[1].click();assert.equal(scroll.scrollTop,150);
});
await test('Bool creation uses true/false selection and excludes the hidden text field',async(f,n)=>{
 n('uniformType').value='bool';await n('uniformType').dispatchEvent({type:'change'});assert.equal(n('uniformValue').hidden,true);assert.equal(n('uniformValue').required,false);assert.equal(n('uniformBoolValue').hidden,false);
 n('uniformName').value='uSwitch';n('uniformBoolValue').value='true';await n('uniformForm').dispatchEvent({type:'submit'});assert.equal(f.renderer.getUserUniforms()[0].value,true);
});
await test('Cancel preserves a creation draft and returns focus to its disclosure',async(f,n)=>{
 n('uniformEditor').open=true;n('uniformName').value='uDraft';await n('uniformCancel').click();assert.equal(n('uniformEditor').open,false);assert.equal(n('uniformName').value,'uDraft');assert.equal(f.document.activeElement,n('uniformEditor').querySelector('summary'));
});
await test('Empty FPS input is rejected rather than silently changing limit to zero',async(f,n)=>{
 f.renderer.setFpsLimit(60);n('fpsLimit').value='';await n('fpsLimit').dispatchEvent({type:'change'});assert.equal(f.renderer.getStats().fpsLimit,60);assert.match(n('uiError').textContent,/입력/);
 await n('uiDismiss').click();assert.equal(n('uiError').textContent,'');assert.equal(n('uiToast').hidden,true);
});
await test('Mobile drawer blocks the stage; opening the editor leaves the user-opened drawer alone',async(f,n)=>{
 assert.equal(n('stage').inert,true);f.studio.open();assert.equal(n('studioDock').hidden,false);
 assert.equal(f.document.body.classList.contains('panel-hidden'),false,'editor opening must not close the drawer');assert.equal(n('stage').inert,true);
 await n('panelBackdrop').click();assert.equal(n('stage').inert,false);assert.equal(n('studioDock').hidden,false,'closing the drawer reveals the editor');
 await n('panelToggle').click();assert.equal(n('stage').inert,true);await n('panelBackdrop').click();assert.equal(n('stage').inert,false);
},true);
await test('Compact layout resets the editor height to 75%',async(f,n)=>{
 let height;n('studioDock').style.setProperty=(_,v)=>height=v;await n('studioResize').dispatchEvent({type:'dblclick'});assert.equal(height,'75%');
},true);
await test('Viewport Space shortcut toggles playback and preserves normal editor typing',async(f,n)=>{
 n('stage').focus();await f.document.dispatchEvent({type:'keydown',code:'Space',key:' '});assert.equal(f.renderer.getStats().running,true);
 n('studioCode').focus();await f.document.dispatchEvent({type:'keydown',code:'Space',key:' '});assert.equal(f.renderer.getStats().running,true);
});
await test('Editor menu disclosure is saved with the workspace',async(f,n)=>{
 n('studioCodeTools').open=true;await n('studioCodeTools').dispatchEvent({type:'toggle'});const value=JSON.parse(f.storage.get('webgl.shader-studio.workspace.v1'));assert.equal(value.open.studioCodeTools,true);assert.equal('toolsHidden' in value,false);
});
await test('Saved workspace preferences restore only typed booleans',async(f,n)=>{
 assert.equal(n('studioCodeTools').open,false);
},false,{'webgl.shader-studio.workspace.v1':JSON.stringify({toolsHidden:true,open:{studioImages:true,studioCodeTools:false,studioInputs:'bad'}})});
await test('Malformed workspace preferences do not prevent editing',async(f)=>{
 assert(f.studio.apply());
},false,{'webgl.shader-studio.workspace.v1':'{broken'});
await test('Pack export exposes busy state and restores its label even after failure',async(f,n)=>{
 const label=n('studioExportPack').textContent;const promise=n('studioExportPack').click();assert.equal(n('studioExportPack').disabled,true);assert.equal(n('studioExportPack').attrs['aria-busy'],'true');await promise;assert.equal(n('studioExportPack').disabled,false);assert.equal(n('studioExportPack').textContent,label);assert.equal(n('studioExportPack').attrs['aria-busy'],undefined);
 const list=f.renderer.getTextures;f.renderer.getTextures=()=>[...list(),{id:'missing',name:'gone.png',width:1,height:1}];f.studio.setProject({image:f.studio.getProject().image,passes:[],imageChannels:{}});await n('studioChannels').children[0].children[1].click();const all=x=>[x,...(x.children||[]).flatMap(all)];await all(n('studioInputs')).find(x=>x.dataset?.value==='tex:missing').click();f.renderer.getTextures=list;await n('studioExportPack').click();assert.equal(n('studioExportPack').disabled,false);assert.equal(n('studioExportPack').textContent,label);assert.match(n('studioMessage').textContent,/원본 이미지/);
});
// ---- 화면 전환 상태 유지 ----
await test('Adding then removing a pass returns to the Image cursor and scroll',async(f,n)=>{
 const area=n('studioCode');area.setSelectionRange(9,14);area.scrollTop=64;
 await n('studioAdd').click();assert.equal(f.studio.getProject().passes.length,1);assert.equal(area.selectionStart,0);
 await n('studioRemove').click();assert.equal(f.studio.getProject().passes.length,0);
 assert.equal(area.selectionStart,9);assert.equal(area.selectionEnd,14);assert.equal(area.scrollTop,64);
});
await test('Re-rendering the shown pass with unchanged source keeps the cursor',async(f,n)=>{
 const area=n('studioCode');let writes=0,current=area.value;
 area.setSelectionRange(5,8);area.scrollTop=30;
 Object.defineProperty(area,'value',{configurable:true,get:()=>current,set:v=>{writes++;current=v;}});
 f.studio.setProject({image:f.studio.getProject().image,passes:[],imageChannels:{}});
 assert.equal(writes,0,'same source must not be written back into the editor');assert.equal(area.selectionStart,5);assert.equal(area.scrollTop,30);
});
await test('Compact parameters button opens the panel over the editor without closing it',async(f,n)=>{
 f.studio.open();assert.equal(n('studioDock').hidden,false);
 await n('studioParameters').click();assert.equal(n('studioDock').hidden,false,'editor stays open under the panel');
 assert.equal(f.document.body.classList.contains('panel-hidden'),false);assert.equal(n('stage').inert,true);
 await n('panelBackdrop').click();assert.equal(n('stage').inert,false);assert.equal(n('studioDock').hidden,false,'closing the panel returns to the editor');
},true);
await test('Editor open state is saved and reopened on the next start',async(f)=>{
 f.studio.open();assert.equal(JSON.parse(f.storage.get('webgl.shader-studio.workspace.v1')).editor,true);
 f.studio.close();assert.equal(JSON.parse(f.storage.get('webgl.shader-studio.workspace.v1')).editor,false);
});
await test('Saved open editor is restored at start',async()=>{
 // 모의 DOM의 hidden 기본값은 false라 열림 여부는 open()이 하는 일(코드 창 포커스·hidden=false 지정)로 확인한다.
 const g=fixture(false,false,{'webgl.shader-studio.workspace.v1':JSON.stringify({editor:true})});try{assert.equal(g.document.activeElement,g.nodes.get('studioCode'));assert.equal(g.nodes.get('studioDock').hidden,false);}finally{g.dispose();}
 const h=fixture(false,false,{'webgl.shader-studio.workspace.v1':JSON.stringify({editor:false})});try{assert.notEqual(h.document.activeElement,h.nodes.get('studioCode'));}finally{h.dispose();}
});
await test('Fullscreen hides the editor and restores it (with focus mode) afterwards',async(f,n)=>{
 f.studio.open();await n('studioMaximize').click();assert.equal(n('stage').classList.contains('studio-maximized'),true);
 f.document.fullscreenElement=n('stage');await f.document.dispatchEvent({type:'fullscreenchange'});assert.equal(n('studioDock').hidden,true);
 assert.equal(JSON.parse(f.storage.get('webgl.shader-studio.workspace.v1')).editor,true,'a reload during fullscreen still reopens the editor');
 f.document.fullscreenElement=null;await f.document.dispatchEvent({type:'fullscreenchange'});
 assert.equal(n('studioDock').hidden,false);assert.equal(n('stage').classList.contains('studio-maximized'),true);
 f.studio.close();f.document.fullscreenElement=n('stage');await f.document.dispatchEvent({type:'fullscreenchange'});
 f.document.fullscreenElement=null;await f.document.dispatchEvent({type:'fullscreenchange'});assert.equal(n('studioDock').hidden,true,'a closed editor stays closed');
});
await test('Starting a project from the project menu closes the menu to show the new scene',async(f,n)=>{
 f.studio.open();await n('projectMenuToggle').click();assert.equal(n('projectMenu').hidden,false);
 assert(await f.studio.examplePipeline()!==false);assert.equal(f.studio.getProject().passes.length,2);assert.equal(n('projectMenu').hidden,true);
},false,{'webgl.shader-studio.layout.v1':JSON.stringify({layout:'right'})});
console.log(`Workspace UX: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
