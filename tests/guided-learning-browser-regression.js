// Learning stays optional, keyboard accessible, and never edits the user's project.
(async()=>{
  const {TOURS}=await import('./js/guide-tours.js');
  const r=window.shaderPlayground,studio=window.shaderStudio,settings=window.shaderSettings,$=id=>document.getElementById(id);
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS ${label}`);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const before=studio.getProject(),users=r.getUserUniforms(),presets=settings.getPresets(),links=settings.getLinks();
  const wasRunning=studio.getPlaybackState();
  const overlay=()=>document.querySelector('.guide-tour');
  const next=()=>document.querySelector('.guide-tour-card .ui-btn--primary');
  const state=()=>JSON.stringify({editor:!$('studioDock').hidden,tab:document.querySelector('#panelTabs [aria-selected=true]')?.dataset.tab,panel:document.body.classList.contains('panel-hidden'),timeline:!$('timelineDock').hidden,inputs:!$('studioInputs').hidden,hud:$('stage').classList.contains('hud-hidden'),project:!$('projectMenu').hidden});
  const openCatalog=()=>{$('helpToggle').click();$('guideTour').click();};
  try {
    if(wasRunning)studio.togglePlayback();
    settings.setLinks([]);
    const declarations=Array.from({length:14},(_,i)=>`uniform float uLearn${i}; // @range 0 1 @default 0.2`).join('\n');
    check(studio.setProject({image:declarations+'\nvoid mainImage(out vec4 c,in vec2 p){c=vec4(uLearn0);}',passes:[],imageChannels:{}}),'학습 검사 장면');
    settings.setPresets([]);$('tab-uniforms').click();
    const model=JSON.stringify({project:studio.getProject(),users:r.getUserUniforms(),presets:settings.getPresets(),links:settings.getLinks()});
    openCatalog();
    check($('guideContent').querySelectorAll('[data-tour]').length===TOURS.length&&TOURS.length===10,'작업별 10개 둘러보기 목록');
    for(const id of ['rendering','presets','connections','timeline','workspace'])check(!!document.querySelector(`#guideNav [data-topic="${id}"]`),`현재 도움말 주제: ${id}`);
    for(const tour of TOURS) {
      $('guideSearch').value='';$('guideSearch').dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#guideNav [data-topic=tours]').click();
      const scroll=$('panel').querySelector('.panel-scroll');scroll.scrollTop=180;
      const savedScroll=scroll.scrollTop,layout=state();
      const entry=$('guideContent').querySelector(`[data-tour="${tour.id}"]`);entry.focus();entry.click();
      check(!overlay().hidden&&$('workspace').inert,`${tour.id}: 학습 중 배경 조작 차단`);
      for(let i=0;i<tour.steps.length;i++) {
        await frames();
        const rect=document.querySelector('.guide-tour-card').getBoundingClientRect();
        check(rect.left>=-1&&rect.right<=innerWidth+1&&rect.top>=-1&&rect.bottom<=innerHeight+1,`${tour.id}/${i+1}: 설명 카드가 화면 안에 있음`);
        check(document.querySelector('.guide-tour-step').textContent.includes(`${i+1} / ${tour.steps.length}`),`${tour.id}/${i+1}: 단계 표시`);
        if(i===0){
          next().dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
          check(document.activeElement.closest('.guide-tour-card'),`${tour.id}: Tab 초점 유지`);
          next().dispatchEvent(new KeyboardEvent('keydown',{key:'e',bubbles:true,cancelable:true}));
        }
        next().click();
      }
      await frames();
      check(overlay().hidden&&!$('workspace').inert&&$('quickHelp').open,`${tour.id}: 완료 후 도움말 복귀`);
      check(state()===layout,`${tour.id}: 패널·편집기·타임라인·입력·HUD 상태 복원`);
      check(scroll.scrollTop===savedScroll,`${tour.id}: 스크롤 복원`);
      check(JSON.stringify({project:studio.getProject(),users:r.getUserUniforms(),presets:settings.getPresets(),links:settings.getLinks()})===model,`${tour.id}: 코드·파라미터·프리셋·연결 불변`);
    }
    document.querySelector('#guideNav [data-topic=tours]').click();
    $('guideContent').querySelector('[data-tour=editor]').click();await frames();
    overlay().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    check(overlay().hidden&&$('quickHelp').open&&!$('workspace').inert,'Esc로 중단해도 복원');
    $('guideSearch').value='프리셋 호환성';$('guideSearch').dispatchEvent(new Event('input',{bubbles:true}));
    check(!!document.querySelector('#guideNav [data-topic=presets]'),'현재 기능을 검색으로 찾기');
    $('quickHelp').close();
    studio.open();$('studioMaximize').click();
    openCatalog();$('guideContent').querySelector('[data-tour=overview]').click();
    for(let i=0;i<10;i++)next().click();
    check($('stage').classList.contains('studio-maximized'),'둘러보기 종료 시 편집기 집중 모드 복원');
    $('quickHelp').close();$('studioMaximize').click();
    $('tab-render').click();document.querySelector('[data-guide=rendering]').click();
    check($('guideContent').querySelector('[data-tour=rendering]'),'탭의 도움말에서 해당 둘러보기 바로 시작');
    $('quickHelp').close();
    $('videoRenderOpen').click();await wait(30);
    document.querySelector('#videoRenderDialog [data-guide=files]').click();
    document.querySelector('#guideNav [data-topic=tours]').click();
    check([...$('guideContent').querySelectorAll('[data-tour]')].every(button=>button.disabled),'다른 작업 창이 열려 있으면 둘러보기로 강제 닫지 않음');
    $('quickHelp').close();$('videoRenderClose').click();
  } finally {
    if(!overlay().hidden)document.querySelector('.guide-tour-skip').click();
    if($('quickHelp').open)$('quickHelp').close();
    if($('videoRenderDialog').open)$('videoRenderClose').click();
    settings.setLinks([]);studio.setProject(before);r.setUserUniforms(users);settings.setPresets(presets);settings.setLinks(links);
    if(studio.getPlaybackState()!==wasRunning)studio.togglePlayback();
    document.dispatchEvent(new Event('shader-settings-applied'));
  }
})();
