// Gallery examples exercise the widgets they describe, with real renderer validation and pixels.
(async () => {
  const r = window.shaderPlayground, studio = window.shaderStudio;
  const A = await import('./js/annotations.js');
  const $ = id => document.getElementById(id);
  const check = (ok, label) => { if (!ok) throw new Error(label); console.log(`PASS ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn, label) => { for (const end = Date.now()+8000; Date.now()<end; await wait(25)) if(fn()) return; throw new Error(`시간 초과: ${label}: ${$('studioError')?.textContent}`); };
  const before = studio.getProject(), beforeUsers = r.getUserUniforms(), beforeScale=r.getStats().resolutionScale;
  r.setResolutionScale(0.25);
  const autoAnswer = setInterval(() => { if($('studioPromptDialog')?.open) ($('studioDialogAlt').hidden ? $('studioDialogOK') : $('studioDialogAlt')).click(); }, 25);
  const user = name => r.getUserUniforms().find(item=>item.name===name);
  const row = name => document.querySelector(`.uniform-row[data-name="${name}"]`);
  const refresh = () => $('uniformSearch').dispatchEvent(new Event('input',{bubbles:true}));
  const set = (name,value) => { r.setUniform(name,value); refresh(); };
  const load = async id => {
    let loaded = false;
    const onLoaded = event => { if(event.detail.id===id) loaded=true; };
    document.addEventListener('gallery-example-loaded',onLoaded);
    try { document.querySelector(`.gallery-card[data-id="${id}"]`).click(); await until(()=>loaded,id); }
    finally { document.removeEventListener('gallery-example-loaded',onLoaded); }
    $('tab-uniforms').click(); refresh();
  };
  let offline = false;
  try {
    await load('annotations');
    const users = r.getUserUniforms(), specs=A.collect([studio.getProject().image]);
    check(users.length===specs.length && users.length===58, '안내 예제의 58개 파라미터를 오류 없이 등록');
    check(specs.every(s=>!s.error && s.description), '모든 태그가 설명과 함께 파싱됨');
    check(!!row('uGlow') && !row('uPoints'), '결과 보기에서는 장면 항목만 표시');
    row('uGlowEnabled').querySelector('input[type=checkbox]').click();
    await until(()=>!row('uGlow') && row('uAmbientFill'), '번짐의 복합 조건');
    check(!row('uGlowSize'), '꺼진 기능의 세부 항목 숨김');
    set('uView',3);
    check(!!row('uGlow') && !!row('uToon') && !row('uRadius'), '|| 조건: 번짐을 꺼도 램프 보기에서는 편집 가능');
    set('uView',4);
    check(!!row('uPoints') && !row('uMatrix4') && !row('uRadius'), '타입 실험은 배열부터 시작하고 다른 실험은 숨김');
    check(user('uSizes').type==='float[3]' && user('uPoints').type==='vec2[3]', '두 배열 선언 문법을 렌더러에서 사용');
    check(JSON.stringify(user('uMatrix2').value)==='[1,0,0,1]' && user('uPulse').value===0, '생략한 기본값은 단위 행렬과 범위 내 0');
    check(user('uLabTint').options.hdr===10 && user('uPulse').options.anim===4, 'HDR 최대 밝기·재생 주기의 생략값');
    check(user('uOffset').options.ranges[1][0]===-0.5, '성분별 범위를 위젯에 적용');
    check(row('uPoints').querySelectorAll('.uniform-array-item').length===3, '배열을 원소별 위젯으로 표시');
    set('uLab',2);
    set('uMatrixMode',0);
    set('uMatrix2',[0.7,0,0,0.7]);
    row('uMatrix2').querySelector('.reset-uniform').click();
    check(JSON.stringify(user('uMatrix2').value)==='[1,0,0,1]', '생략한 행렬 기본값으로 리셋');
    set('uLab',0);
    const points=[-0.6,0.1,0,0.4,0.6,0.1];
    set('uPoints',points);
    row('uPoints').querySelector('.write-default-uniform').click();
    check(JSON.stringify(A.collect([studio.getProject().image]).find(s=>s.name==='uPoints').value)===JSON.stringify(points), '실험 배열의 현재 값을 코드에 반영');
    studio.undo();
    // Render synchronously at a fixed time so pixel differences come from controls.
    r.beginOffline({width:384,height:384}); offline=true;
    const shot = () => {
      const canvas=r.renderOfflineFrame({time:0,delta:0,frame:0});
      const copy=document.createElement('canvas'); copy.width=canvas.width; copy.height=canvas.height;
      const context=copy.getContext('2d'); context.drawImage(canvas,0,0);
      return context.getImageData(0,0,copy.width,copy.height).data;
    };
    const pixels=shot();
    check(new Set(pixels.filter((_,i)=>i%4!==3)).size>24, '타입 실험이 단색이 아닌 실제 그림을 출력');
    r.setUniform('uEnabled',[false,false,false]);
    const off=shot();
    check(pixels.some((value,i)=>Math.abs(value-off[i])>15), 'bool 배열이 실제 점의 표시를 변경');
    r.setUniform('uLab',2);
    r.setUniform('uMatrixMode',0);
    const matrixBefore=shot();
    r.setUniform('uMatrix2',[0.5,0,0,0.5]);
    const transformed=shot();
    check(matrixBefore.some((value,i)=>Math.abs(value-transformed[i])>15), '행렬 값이 실제 좌표와 그림을 변경');
    r.setUniform('uMatrixMode',1);
    const perspectiveBefore=shot();
    r.setUniform('uMatrix3',[1,0,0.8,0,1,0,0,0,1]);
    const perspective=shot();
    check(perspectiveBefore.some((value,i)=>Math.abs(value-perspective[i])>15), 'mat3의 마지막 행도 동차 좌표 나눗셈에 사용');
    r.setUniform('uMatrixMode',2);
    const alphaBefore=shot();
    r.setUniform('uMatrix4',[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0.2]);
    const alpha=shot();
    check(alphaBefore.some((value,i)=>Math.abs(value-alpha[i])>15), 'mat4의 알파 행도 출력 합성에 사용');
    r.endOffline(); offline=false;

    await load('kaleido');
    check(!row('uCenter'), '만화경: 커서 모드에서는 수동 중심 숨김');
    set('uMouseCenter',false);
    check(!!row('uCenter') && user('uCenter').options.pos, '만화경: 패널 중심 조작으로 전환');
    await load('lava');
    set('uMouseFollow',false);
    check(!!row('uPosition'), '메타볼: 추가 구체가 켜지고 커서 추적이 꺼지면 위치 표시');
    set('uPointer',false);
    check(!row('uPosition') && !row('uMouseFollow'), '메타볼: 기능을 끄면 복합 조건의 세부 항목 숨김');
    await load('horizon');
    set('uShowSun',false); set('uShowGrid',false);
    check(!row('uSunSize') && !row('uGlow') && !!row('uSky'), '네온 지평선: 켜진 기능의 조절기만 표시');
    await load('pbr');
    check(!row('uRoughness'), 'PBR: 격자 모드에서 수동 거칠기 숨김');
    set('uGrid',false);
    check(!!row('uRoughness') && !!row('uMetallic'), 'PBR: 단일 구에서는 수동 재질 표시');
    set('uView',1);
    check(!row('uMetallic') && !row('uBaseColor') && !!row('uRoughness'), 'PBR: D 보기에는 관련 재질만 표시');
    await load('glass');
    set('uView',3);
    check(!!row('uIOR') && !row('uDensity') && !row('uGlassTint') && !row('uBounces'), '유리: 프레넬 보기에 필요한 항목만 표시');
    set('uView',2);
    check(!!row('uDispersion') && !!row('uDensity') && !!row('uBounces'), '유리: 굴절 보기의 세부 항목 표시');
    await load('materials');
    check(user('uSunAngle').options.angle, '반사 재질: 해의 방위를 각도 다이얼로 조작');
    set('uView',2);
    check(!!row('uSunAngle') && !row('uSunCol'), '반사 재질: 그림자 보기에서는 해 방향만 필요');
    await load('volumetric');
    set('uView',1);
    check(!row('uSunCol') && !row('uLightSteps') && !!row('uDensity'), '구름: 밀도 보기에서는 빛의 세부 항목 숨김');
    await load('fluid');
    check(!!row('uDyeFade'), '유체: Image의 선택지로 Buffer F의 항목 표시');
    set('uView',1);
    check(!row('uDyeFade'), '유체: 속도 보기에서 물감 항목 숨김(패스 간 조건)');
    await studio.exampleRaymarch(); $('tab-uniforms').click(); refresh();   // Studio 기본 Ray Marching 장면(갤러리 카드는 정리됨)
    set('uRMHeatmap',true);
    check(!row('uRMNormalEpsilon') && !!row('uRMSurfaceEpsilon'), 'SDF: 걸음 수 보기에서는 법선 간격 숨김');
  } finally {
    if(offline) r.endOffline();
    studio.setProject(before); r.setUserUniforms(beforeUsers); r.setResolutionScale(beforeScale);
    clearInterval(autoAnswer);
  }
})();
