(async()=>{
  const P=await import('./js/presets.js'),{withFrameClock}=await import('./tests/helpers/frame-clock.mjs');
  const r=window.shaderPlayground,studio=window.shaderStudio,settings=window.shaderSettings,$=id=>document.getElementById(id);
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS ${label}`);};
  const before=studio.getProject(),users=r.getUserUniforms(),presets=settings.getPresets(),links=settings.getLinks();
  const user=name=>r.getUserUniforms().find(item=>item.name===name),value=name=>user(name).value;
  const click=name=>[...document.querySelectorAll('.preset-apply')].find(button=>button.textContent===name).click();
  const image=`uniform float uGain; // @range 0 1 @default 0.2
uniform vec4 uTint; // @color @default 1 1 1 1
uniform int uMode; // @enum A B @default 0
uniform sampler2D uRamp; // @curve linear @default 0 0 1 1
uniform float uLinked; // @range 0 1 @default 0.4
uniform float uNarrow; // @range 0 1 @default 0.2
void mainImage(out vec4 c,in vec2 p){c=vec4(uGain);}`;
  const old=[{name:'uGain',type:'float',value:0.8}, {name:'uTint',type:'vec3',value:[0.1,0.2,0.3]},
    {name:'uMode',type:'int',value:1,options:{enum:['B','A']}},
    {name:'uRamp',type:'sampler2D',value:[0,0,0,0,1,1,1,1,1,1],options:{gradient:'linear'}},
    {name:'uLinked',type:'float',value:0.9},{name:'uNarrow',type:'float',value:5},{name:'uRemoved',type:'float',value:1}];
  try {
    settings.setLinks([]);check(studio.setProject({image,passes:[],imageChannels:{}}),'호환성 장면 적용');
    settings.setPresets([P.capture('old',old),{name:'legacy',values:{uGain:0.6,uTint:[0.2,0.3,0.4,1]}},P.capture('only skipped',[old[1]])]);
    settings.setLinks([{name:'uLinked',source:'keys',keys:[[0,0.4]],loop:0,ease:'linear',smooth:0}]);
    $('tab-uniforms').click();$('presetBlend').value='0';
    const untouched=JSON.stringify(r.getUserUniforms().filter(item=>item.name!=='uGain'));
    click('old');
    check(value('uGain')===0.8,'호환되는 값만 적용');
    check(JSON.stringify(r.getUserUniforms().filter(item=>item.name!=='uGain'))===untouched,'타입·선택지·램프·범위·연결 불일치 항목은 현재 값 유지');
    check($('presetReportSummary').textContent.includes('적용 1개')&&$('presetReportSummary').textContent.includes('건너뜀 6개'),'적용과 건너뜀 개수 표시');
    check(!$('presetReport').hidden&&!$('presetReport').open,'내역은 기본적으로 접어서 표시');
    const notice=$('presetNoticeText'),noticeText=notice.textContent;
    notice.textContent='LongPresetName'.repeat(12);notice.style.fontSize='18px';
    const range=document.createRange();range.selectNodeContents(notice);
    check(range.getBoundingClientRect().right<=$('presetBar').getBoundingClientRect().right-4,'긴 이름과 큰 글꼴에서도 적용 결과가 카드 안에서 줄바꿈');
    notice.textContent=noticeText;notice.style.removeProperty('font-size');
    const summary=$('presetReportSummary'),summaryText=summary.textContent;
    summary.textContent='LongPresetName'.repeat(4);range.selectNodeContents(summary);
    check(range.getBoundingClientRect().right<=$('presetBar').getBoundingClientRect().right-4,'띄어쓰기 없는 긴 프리셋 이름도 내역 제목 안에서 줄바꿈');
    summary.textContent=summaryText;
    for(const word of ['vec3 → vec4','선택지','종류','없는 파라미터','범위','연결'])check($('presetReportList').textContent.includes(word),`건너뛴 이유: ${word}`);
    check(!$('parameterCompare').hidden&&!$('compareA').disabled,'프리셋 적용 직전 값을 기억해 비교 바 표시');
    {const capture=Element.prototype.setPointerCapture;Element.prototype.setPointerCapture=()=>{};
    $('compareA').dispatchEvent(new PointerEvent('pointerdown',{button:0,buttons:1,pointerId:5,bubbles:true,cancelable:true}));
    check(r.isUniformPreviewActive()&&value('uGain')===0.8,'프리셋 전 상태 미리보기는 지금 값 보존');
    $('compareA').dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:5,bubbles:true,cancelable:true}));
    Element.prototype.setPointerCapture=capture;}
    studio.undo();check(value('uGain')===0.2,'즉시 적용은 Undo 한 번으로 복원');
    studio.redo();check(value('uGain')===0.8,'즉시 적용 Redo');
    click('legacy');
    check(value('uGain')===0.6&&JSON.stringify(value('uTint'))==='[0.2,0.3,0.4,1]','이전 형식도 현재 타입·형태 검사 후 적용');
    check(!$('presetReportHint').hidden&&$('presetReportSummary').textContent.includes('이전 형식'),'이전 형식의 타입 정보 한계 안내');
    studio.undo();check(value('uGain')===0.8,'이전 형식 적용도 한 번에 복원');
    click('only skipped');check(value('uGain')===0.8&&$('presetReportSummary').textContent.includes('적용 0개'),'전부 건너뛰어도 값 유지와 결과 표시');
    studio.undo();check(value('uGain')===0.2,'0개 적용은 Undo 기록을 만들지 않음');
    withFrameClock(window,({step})=>{
      $('presetBlend').value='1';click('old');step(0);step(500);
      check(value('uGain')>0.2&&value('uGain')<0.8,'부드러운 부분 적용의 중간값');
      step(1000);check(value('uGain')===0.8,'부드러운 적용 완료');
      studio.undo();check(value('uGain')===0.2,'부드러운 적용도 Undo 한 번');
      studio.redo();check(value('uGain')===0.8,'부드러운 적용 Redo');
      click('legacy');step(1000);step(1500);const middle=value('uGain');
      check(middle>0.6&&middle<0.8,'진행 중 Undo를 검사할 중간값');
      r.setUniform('uNarrow',0.3);
      studio.undo();check(value('uGain')===0.8&&!$('presetBar').classList.contains('is-morphing'),'전환 중 Undo는 먼저 전환을 끝내고 시작값으로 복원');
      check(value('uNarrow')===0.3,'Undo는 프리셋이 적용한 항목만 복원하고 다른 변경은 유지');
      step(2000);check(value('uGain')===0.8,'취소한 전환은 다음 프레임에 값을 덮어쓰지 않음');
      click('legacy');step(2000);step(2250);
      const beforeBatch=value('uGain');
      studio.setParameterValues([{...user('uGain'),value:0.9}]);
      check(value('uGain')===0.9&&!$('presetBar').classList.contains('is-morphing'),'일괄 변경은 진행 중 전환을 먼저 중단');
      studio.undo();check(value('uGain')===beforeBatch,'일괄 변경 Undo는 프리셋 중간값으로 복원');
      studio.undo();check(value('uGain')===0.8,'다음 Undo는 프리셋 적용 전으로 복원');
      click('legacy');step(2250);step(2500);
      check(studio.setProject({image:image+'\n// new source',passes:[],imageChannels:{}}),'전환 중 소스 변경');
      const stopped=value('uGain');step(3000);
      check(value('uGain')===stopped&&!$('presetBar').classList.contains('is-morphing'),'소스를 바꾸면 이전 전환이 새 프로젝트 값을 덮어쓰지 않음');
    });
    settings.save();const saved=JSON.parse(localStorage.getItem('webgl.raymarch-template.settings.v1'));
    check(saved.presets[0].schema.uTint.type==='vec3'&&saved.presets[0].schema.uRamp.ramp==='gradient','자동 저장에 타입·램프 정보 유지');
    const copy=settings.getPresets();copy[0].schema.uMode.enum[0]='changed';copy[0].values.uTint[0]=9;
    check(settings.getPresets()[0].schema.uMode.enum[0]==='B'&&settings.getPresets()[0].values.uTint[0]===0.1,'프리셋 읽기는 내부 값과 메타데이터를 노출하지 않음');
    settings.renameParameter('uGain','uRenamed');
    check(settings.getPresets()[0].schema.uRenamed.type==='float'&&settings.getPresets()[0].values.uRenamed===0.8,'이름 변경 시 값과 타입 정보 함께 이동');
    settings.renameParameter('uRenamed','uGain');
  } finally {
    $('presetFinish').click();settings.setLinks([]);studio.setProject(before);r.setUserUniforms(users);settings.setPresets(presets);settings.setLinks(links);
    document.dispatchEvent(new Event('shader-settings-applied'));
  }
})();
