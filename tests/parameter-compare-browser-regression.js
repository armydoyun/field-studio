// Comparison is a GPU preview, never an edit to persisted B values.
(async () => {
  const r=window.shaderPlayground, studio=window.shaderStudio, settings=window.shaderSettings;
  const $=id=>document.getElementById(id), wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS ${label}`);};
  const before=studio.getProject(), users=r.getUserUniforms(), presets=settings.getPresets(), links=settings.getLinks();
  const row=name=>document.querySelector(`.uniform-row[data-name="${name}"]`);
  const refresh=()=>$('uniformSearch').dispatchEvent(new Event('input',{bubbles:true}));
  const user=name=>r.getUserUniforms().find(item=>item.name===name);
  const set=(name,value)=>{r.setUniform(name,value);refresh();};
  const image=`uniform float uValue; // @range 0 10 @default 2
uniform bool uShow; // @default false
uniform float uHidden; // @range 0 10 @default 1 @if uShow
uniform vec3 uTiny; // @color hdr @default 1e-8 0 0
uniform vec2 uPoints[2]; // @default 0
uniform mat2 uMatrix; // @default 1 0 0 1
uniform sampler2D uRamp; // @gradient @default 0 #000000 1 #ffffff
void mainImage(out vec4 c,in vec2 p){c=vec4(uValue/10.0, texture(uRamp,vec2(0.5)).r,uMatrix[0][0]*0.1,1.0);}`;
  let offline=false;
  try {
    settings.setLinks([]);
    check(studio.setProject({image,passes:[],imageChannels:{}}),'비교 장면 적용');
    r.setUserUniforms(r.getUserUniforms().filter(item=>/^u(Value|Show|Hidden|Tiny|Points|Matrix|Ramp)$/.test(item.name)));
    document.dispatchEvent(new Event('shader-settings-applied'));
    $('tab-uniforms').click();
    check($('uniformChangedCount').textContent==='0','처음에는 코드 기본값과 일치');
    const number=row('uValue').querySelector('input[type="number"]');
    number.value='3';number.dispatchEvent(new Event('change',{bubbles:true}));
    check(row('uValue').dataset.changed==='true'&&$('uniformChangedCount').textContent==='1','직접 편집 직후 변경 표시와 개수 갱신');
    row('uValue').querySelector('.reset-uniform').click();
    check($('uniformChangedCount').textContent==='0','기본값 복원 직후 변경 표시 해제');
    set('uTiny',[2e-8,0,0]);
    check(row('uTiny').dataset.changed==='true'&&getComputedStyle(row('uTiny').querySelector('.uniform-changed')).visibility==='visible','아주 작은 HDR 변경도 표시');
    check(!row('uTiny').querySelector('.reset-uniform').disabled,'작은 HDR 값도 기본값으로 복원 가능');
    set('uHidden',3);set('uPoints',[0,0,0.1,0]);set('uMatrix',[0.5,0,0,1]);
    check($('uniformChangedCount').textContent==='4','배열·행렬·조건 숨김도 변경 개수에 포함');
    $('uniformChangedOnly').click();
    check(!row('uValue')&&!!row('uPoints')&&!row('uHidden'),'변경 필터와 조건 숨김을 함께 적용');
    $('uniformSearch').value='uHidden';refresh();
    check(!!row('uHidden')&&!row('uPoints'),'검색으로 숨긴 변경 항목 확인');
    $('uniformSearch').value='';refresh();$('uniformChangedOnly').click();
    $('uniformWriteDefaults').click();
    check($('uniformChangedCount').textContent==='0','코드 반영 직후 변경 표시 해제');
    studio.undo();
    check($('uniformChangedCount').textContent==='4','Undo로 기본값을 되돌리면 변경 표시 복구');

    $('compareCapture').click();
    set('uValue',8);set('uRamp',[0,1,0,0,1,1,1,0,0,1]);set('uMatrix',[0.9,0,0,1]);
    const editable=JSON.stringify(r.getUserUniforms());
    $('compareA').click();
    check(r.isUniformPreviewActive()&&$('compareA').getAttribute('aria-pressed')==='true','A를 별도 미리보기로 선택');
    let rejected=false;
    try { r.setUniformPreview([{name:'uValue',type:'vec2',value:[0,0]}]); } catch { rejected=true; }
    check(rejected&&r.isUniformPreviewActive(),'잘못된 비교 자료는 기존 미리보기를 손상시키지 않고 거부');
    check(JSON.stringify(r.getUserUniforms())===editable&&user('uValue').value===8,'A 미리보기가 실제 B 값을 변경하지 않음');
    check($('uniformList').inert&&$('presetBar').inert&&$('uniformWriteDefaults').disabled,'A에서는 B 편집과 코드 반영 잠금');
    check(!$('comparePreviewNotice').hidden&&$('compareNotice').textContent.includes('B'),'뷰포트와 패널에 저장 대상 안내');
    settings.save();
    const saved=JSON.parse(localStorage.getItem('webgl.raymarch-template.settings.v1'));
    check(saved.user.find(item=>item.name==='uValue').value===8,'A를 보는 동안 자동 저장도 B 유지');
    check(r.exportScene().uniforms.find(item=>item.name==='uValue').values[0]===8,'HTML 내보내기 모델도 B 유지');
    r.beginOffline({width:16,height:16});offline=true;
    const pixel=()=>{const canvas=r.renderOfflineFrame({time:0,delta:0,frame:0}),copy=document.createElement('canvas');copy.width=copy.height=16;const ctx=copy.getContext('2d');ctx.drawImage(canvas,0,0);return ctx.getImageData(8,8,1,1).data;};
    const a=pixel();$('compareB').click();const b=pixel();$('compareA').click();const aAgain=pixel();
    check(Math.abs(a[0]-51)<2&&Math.abs(b[0]-204)<2,'GPU에서 A와 B 스칼라 값을 구분');
    check(Math.abs(a[1]-128)<3&&b[1]>250,'램프 텍스처도 A/B에 맞춰 전환');
    check(Math.abs(a[2]-13)<2&&Math.abs(b[2]-23)<2,'행렬의 업로드 자료도 A/B에 맞춰 전환');
    check(a.every((v,i)=>v===aAgain[i]),'반복 전환해도 A가 변하지 않음');
    check(JSON.stringify(r.getUserUniforms())===editable,'GPU 전환 후에도 B 값·설정 보존');
    r.endOffline();offline=false;
    $('compareApply').click();
    check(!r.isUniformPreviewActive()&&user('uValue').value===2,'A 적용은 명시적으로 B 값을 변경');
    studio.undo();check(user('uValue').value===8&&!r.isUniformPreviewActive(),'A 적용은 Undo 한 번으로 B 복구');
    studio.redo();check(user('uValue').value===2,'A 적용 Redo');
    // Looking at A and returning to B must not consume history entries.
    studio.setParameterValues([{...user('uValue'),value:7}]);
    $('compareCapture').click();set('uValue',9);$('compareA').click();$('compareB').click();$('compareClear').click();
    check(user('uValue').value===9&&!r.isUniformPreviewActive(),'비교 종료는 B 유지');
    studio.undo();check(user('uValue').value===2,'비교·종료는 Undo 기록을 추가하지 않음');
    const originalRandom=Math.random;
    try {Math.random=()=>0.8;$('uniformRandomize').click();} finally {Math.random=originalRandom;}
    check(!$('compareA').disabled,'전체 무작위 전에 A 자동 기억');
    $('compareA').click();check(r.isUniformPreviewActive(),'자동 기준으로도 비교 가능');
    studio.undo();check(!$('compareA').getAttribute('aria-pressed').includes('true')&&!r.isUniformPreviewActive(),'Undo하면 기준과 A 미리보기 해제');
    $('compareCapture').click();$('compareA').click();
    check(studio.setProject({image:'void mainImage(out vec4 c,in vec2 p){c=vec4(0.1);}',passes:[],imageChannels:{}}),'다른 프로젝트로 변경');
    await wait(650);
    check(!r.isUniformPreviewActive()&&$('compareA').disabled&&!$('uniformList').inert,'프로젝트 변경 시 이전 비교가 누출되지 않음');
    settings.setLinks([{name:'uValue',source:'lfo',min:0,max:1,period:2}]);
    $('compareCapture').click();
    check(!$('compareA').disabled,'연결되지 않은 항목으로 기준 생성');
    $('compareA').click();settings.setLinks([]);
    check(!r.isUniformPreviewActive()&&$('compareA').disabled,'연결 설정 변경 시 비교 해제');
  } finally {
    if(offline)r.endOffline();
    if(r.isUniformPreviewActive())r.setUniformPreview(null);
    if($('uniformChangedOnly').getAttribute('aria-pressed')==='true')$('uniformChangedOnly').click();
    settings.setLinks([]);studio.setProject(before);r.setUserUniforms(users);settings.setPresets(presets);settings.setLinks(links);
    document.dispatchEvent(new Event('shader-settings-applied'));
  }
})();
