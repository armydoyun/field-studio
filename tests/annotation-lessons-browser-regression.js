// The annotation lesson teaches one concept at a time, with stable references and scoped captions.
(async () => {
  const r=window.shaderPlayground,studio=window.shaderStudio,$=id=>document.getElementById(id);
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS ${label}`);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(fn,label)=>{for(const end=Date.now()+8000;Date.now()<end;await wait(25))if(fn())return;throw new Error(label);};
  const before=studio.getProject(),users=r.getUserUniforms(),scale=r.getStats().resolutionScale;
  const timer=setInterval(()=>{if($('studioPromptDialog')?.open)($('studioDialogAlt').hidden?$('studioDialogOK'):$('studioDialogAlt')).click();},25);
  const row=name=>document.querySelector(`.uniform-row[data-name="${name}"]`);
  const refresh=()=>$('uniformSearch').dispatchEvent(new Event('input',{bubbles:true}));
  const set=(name,value)=>{r.setUniform(name,value);refresh();};
  let offline=false;
  try {
    r.setResolutionScale(0.25);
    document.querySelector('.gallery-card[data-id="annotations"]').click();
    await until(()=>r.getUserUniforms().some(u=>u.name==='uLab'),'새 실험 예제 등록');
    $('tab-uniforms').click();
    check($('annotationLesson').hidden,'기본 행성 보기에는 실험 안내 없음');
    set('uView',4);
    check($('annotationLessonTitle').textContent.includes('배열')&&!$('annotationLesson').hidden,'타입 실험은 설명이 있는 배열부터 시작');
    check(!!row('uPoints')&&!row('uMatrix2')&&!row('uGrid')&&!row('uAutoGradient'),'배열에 필요한 조절기만 표시');
    check(r.getUserUniforms().find(u=>u.name==='uRotation').value===0,'기본 회전은 0도');
    check($('annotationLessonText').textContent.includes('빈 원'),'꺼진 배열 원소의 윤곽과 번호 설명');
    set('uLab',1);
    check(!!row('uGrid')&&!row('uPoints')&&!row('uMatrix4'),'벡터로 전환하면 배열·행렬 항목 숨김');
    set('uPaletteIndex',1);
    check(!!row('uBands')&&!row('uGrid')&&!row('uCodes'),'RGB 채널에 집중하는 하위 보기');
    set('uPaletteIndex',0);
    set('uLab',2);set('uMatrixMode',0);
    check(!!row('uMatrix2')&&!row('uMatrix3')&&!row('uMatrix4'),'한 번에 하나의 행렬만 편집');
    set('uMatrixMode',1);
    check(!!row('uMatrix3')&&!!row('uPad')&&!row('uRotation'),'동차 좌표에 맞는 조절기와 설명');
    set('uMatrixMode',2);
    check(!!row('uMatrix4')&&!!row('uLabTint')&&!row('uMatrix2'),'RGBA 변환에 맞는 조절기');
    set('uLab',3);
    check(!!row('uAutoGradient')&&!!row('uGlow')&&!!row('uLinearCurve')&&!row('uPoints'),'번호가 있는 모든 램프를 함께 편집');
    check($('annotationLessonText').textContent.includes('색 띠 0~4'),'색 띠와 곡선의 번호 설명');

    r.beginOffline({width:400,height:400});offline=true;
    const shot=()=>{const c=r.renderOfflineFrame({time:0,delta:0,frame:0}),copy=document.createElement('canvas');copy.width=c.width;copy.height=c.height;const ctx=copy.getContext('2d');ctx.drawImage(c,0,0);return ctx.getImageData(0,0,c.width,c.height).data;};
    const differs=(a,b)=>a.some((v,i)=>Math.abs(v-b[i])>12);
    const leftSame=(a,b)=>a.every((v,i)=>(Math.floor(i/4)%400)>=200||v===b[i]);
    for(let chapter=0;chapter<4;chapter++){
      r.setUniform('uLab',chapter);const pixels=shot();
      check(new Set(pixels).size>12,`실험 ${chapter}: 실제 그림 출력`);
      const corners=[0,399*4,399*400*4,(400*400-1)*4];
      check(corners.every(at=>pixels[at]===pixels[0]&&pixels[at+1]===pixels[1]&&pixels[at+2]===pixels[2]),`실험 ${chapter}: 그림이 프레임 안에 머물고 거대한 색 영역 없음`);
    }
    r.setUniform('uLab',0);const arrays=shot();
    r.setUniform('uMatrix2',[0.5,0,0,0.5]);
    check(!differs(arrays,shot()),'배열 보기에는 다른 실험의 행렬이 영향을 주지 않음');
    r.setUniform('uEnabled',[false,false,false]);
    check(differs(arrays,shot()),'배열의 켜짐 상태가 실제 점을 변경');
    r.setUniform('uLab',2);r.setUniform('uMatrixMode',0);r.setUniform('uMatrix2',[1,0,0,1]);
    let input=shot();r.setUniform('uMatrix2',[0.6,0.2,0,1]);let output=shot();
    check(differs(input,output)&&leftSame(input,output),'mat2 변경은 오른쪽 결과만 바꾸고 왼쪽 기준은 고정');
    r.setUniform('uMatrixMode',1);input=shot();r.setUniform('uMatrix3',[1,0,1,0,1,0,0,0,1]);output=shot();
    check(differs(input,output)&&leftSame(input,output),'mat3 원근 변환도 기준과 비교 가능');
    r.setUniform('uMatrixMode',2);input=shot();r.setUniform('uMatrix4',[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0.2]);output=shot();
    check(differs(input,output)&&leftSame(input,output),'mat4 알파 변경도 오른쪽 결과만 변경');
    r.endOffline();offline=false;
    set('uView',3);
    check(!$('annotationLesson').hidden&&$('annotationLessonTitle').textContent.includes('램프'),'기존 램프 보기도 설명이 있는 새 그래프 사용');
    set('uView',0);check($('annotationLesson').hidden,'실험을 나가면 안내 숨김');
    set('uView',4);
    check(studio.setProject({image:'void mainImage(out vec4 c,in vec2 p){c=vec4(0.2);}',passes:[],imageChannels:{}}),'다른 프로젝트 적용');
    refresh();check($('annotationLesson').hidden,'같은 이름의 파라미터가 남아도 다른 프로젝트에 안내가 누출되지 않음');
    studio.undo();refresh();
    check(!$('annotationLesson').hidden,'Undo로 예제를 복구하면 안내도 복구');
  } finally {
    if(offline)r.endOffline();studio.setProject(before);r.setUserUniforms(users);r.setResolutionScale(scale);clearInterval(timer);
  }
})();
