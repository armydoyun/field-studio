// Check real SVG masks, accessible state changes, editor completions and both themes.
(async () => {
  const studio=window.shaderStudio,r=window.shaderPlayground,settings=window.shaderSettings;
  const $=id=>document.getElementById(id);
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS ${label}`);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(fn,label)=>{for(const end=Date.now()+6000;Date.now()<end;await wait(25))if(fn())return;throw new Error(`시간 초과: ${label}`);};
  const before=studio.getProject(),users=r.getUserUniforms(),links=settings.getLinks(),theme=document.documentElement.getAttribute('data-theme'),wasRunning=r.getStats().running,wasLive=$('studioLive').checked;
  const mask=node=>getComputedStyle(node,'::before').maskImage;
  const hasSvg=node=>node&&mask(node).includes('data:image/svg+xml');
  const timer=setInterval(()=>{if($('studioPromptDialog')?.open)($('studioDialogAlt').hidden?$('studioDialogOK'):$('studioDialogAlt')).click();},25);
  const row=()=>document.querySelector('.uniform-row[data-name="uAmount"]');
  try {
    check(studio.setProject({image:'uniform float uAmount; // @range 0 1 @default 0.5 @seed @anim 4\nvoid mainImage(out vec4 c,in vec2 p){c=vec4(uAmount);}',passes:[],imageChannels:{}}),'아이콘 실습 장면 적용');
    $('tab-uniforms').click();
    if(r.getStats().running)studio.togglePlayback();
    r.setTime(0);
    const lock=row().querySelector('.lock-uniform');
    check(lock.textContent===''&&hasSvg(lock)&&lock.classList.contains('icon-unlock'),'잠금 해제 상태는 SVG와 접근 가능한 이름으로 표시');
    check(lock.getAttribute('aria-label').includes('잠금'),'잠금 버튼의 접근 가능한 이름');
    lock.click();
    check(lock.classList.contains('icon-lock')&&lock.getAttribute('aria-pressed')==='true','잠금 상태를 SVG로 전환');
    lock.click();
    check(lock.classList.contains('icon-unlock')&&lock.getAttribute('aria-pressed')==='false','해제 상태를 SVG로 복원');
    check(hasSvg($('uniformRandomize'))&&$('uniformRandomize').textContent.trim()==='전체 무작위','전체 무작위는 SVG 주사위와 글자 조합');
    check(hasSvg(row().querySelector('.write-default-uniform'))&&row().querySelector('.write-default-uniform').textContent==='','코드 반영은 SVG 아이콘');
    for(const value of ['dark','light']){
      document.documentElement.setAttribute('data-theme',value);
      const icon=row().querySelector('.lock-uniform');
      check(hasSvg(icon)&&getComputedStyle(icon,'::before').backgroundColor===getComputedStyle(icon).color,`${value}: SVG 마스크는 부모의 색을 따름`);
    }
    settings.setLinks([{name:'uAmount',source:'keys',min:0,max:1,smooth:0,keys:[[0,0.2],[1,0.8]],loop:2,ease:'linear'}]);
    await until(()=>row()?.querySelector('.key-nav'),'키 내비게이터');
    for(const button of row().querySelectorAll('.key-nav-button'))check(hasSvg(button)&&button.textContent===''&&button.getAttribute('aria-label'),'키프레임 조작은 SVG와 접근 가능한 이름');
    check(row().querySelector('.key-nav-key').classList.contains('icon-keyframe-filled'),'현재 시간에 키가 있으면 채운 SVG 마름모');
    check(hasSvg(row().querySelector('.key-nav-mode'))&&row().querySelector('.key-nav-mode').textContent==='2초','반복 배지의 SVG');
    settings.setLinks([]);
    const actionSource = [
      'uniform vec2 uWind; // @dir @default 1 0',
      'uniform vec3 uSun; // @dir @default 0 0 1',
      'uniform float uAngle; // @angle @default 0',
      'uniform vec2 uPoint; // @pos @range -2 4 @default 0 0',
      'uniform sampler2D uGradient; // @gradient @default 0 #000000 0.5 #ff0000 1 #ffffff',
      'uniform sampler2D uCurve; // @curve linear @default 0 0 0.5 0.2 1 1',
      'uniform mat3 uMatrix; // @default 1 0 0 0 1 0 0 0 1',
      'void mainImage(out vec4 c,in vec2 p){c=vec4(uSun*0.5+0.5,1.0);}',
    ].join('\n');
    check(studio.setProject({image:actionSource,passes:[],imageChannels:{}}),'방향·각도·위치·램프·행렬 아이콘 장면');
    const actionRow=name=>document.querySelector(`.uniform-row[data-name="${name}"]`);
    const userValue=name=>r.getUserUniforms().find(item=>item.name===name).value;
    for(const theme of ['dark','light']) {
      document.documentElement.setAttribute('data-theme',theme);
      for(const name of ['uWind','uSun','uAngle','uPoint','uGradient','uCurve']) {
        const buttons=[...actionRow(name).querySelectorAll('.uniform-dir-chip')];
        check(buttons.length>0&&buttons.every(node=>hasSvg(node)&&node.textContent===''&&node.title&&node.getAttribute('aria-label')),`${theme}: ${name} 조작은 SVG·짧은 툴팁·접근성 이름`);
        check(buttons.every(node=>node.getBoundingClientRect().width===28&&node.getBoundingClientRect().height===28),`${theme}: ${name} 아이콘 버튼은 공통 28px 크기`);
      }
    }
    actionRow('uWind').querySelector('[data-preset="−X"]').click();
    check(userValue('uWind')[0]===-1,'SVG 축 버튼도 방향 설정 유지');
    const hemisphere=actionRow('uSun').querySelector('.uniform-dir-flip');hemisphere.click();
    check(hemisphere.getAttribute('aria-pressed')==='true'&&userValue('uSun')[2]===-1,'앞뒤 아이콘의 눌림 상태와 Z 반전');
    actionRow('uPoint').querySelector('.icon-center').click();
    check(userValue('uPoint').join()==='1,1','중앙 아이콘은 범위의 중간');
    actionRow('uPoint').querySelector('.icon-origin').click();
    check(userValue('uPoint').join()==='0,0','원점 아이콘은 중앙과 별도로 좌표 0');
    actionRow('uCurve').querySelector('.icon-curve-smooth').click();
    check(userValue('uCurve').length===8,'S자 아이콘으로 네 점 곡선');
    actionRow('uCurve').querySelector('.icon-swap').click();
    check(userValue('uCurve')[1]===1,'곡선 뒤집기는 상하 반전');
    actionRow('uCurve').querySelector('.icon-curve-linear').click();
    check(userValue('uCurve').join()==='0,0,1,1'&&actionRow('uCurve').querySelector('.uniform-ramp-edit .icon-trash').disabled,'직선 아이콘 적용과 최소 점 삭제 방지');
    actionRow('uGradient').querySelector('.icon-flip-horizontal').click();
    check(userValue('uGradient').slice(1,4).join()==='1,1,1','그라데이션 뒤집기는 좌우 반전');
    actionRow('uGradient').querySelector('.uniform-ramp-edit .icon-trash').click();
    check(userValue('uGradient').length===10&&actionRow('uGradient').querySelector('.uniform-ramp-edit .icon-trash').disabled,'SVG 삭제는 정지점만 지우고 최소 개수 유지');
    const expand=actionRow('uMatrix').querySelector('[aria-label="uMatrix 행렬 확대 편집"]');
    check(hasSvg(expand)&&expand.textContent==='','행렬 확대도 SVG 조작');expand.click();
    const matrixDialog=document.querySelector('dialog[open][aria-label="uMatrix 행렬 확대 편집"]');
    check(matrixDialog,'확대 아이콘은 기존 행렬 대화상자를 엶');matrixDialog.querySelector('[aria-label="행렬 편집 취소"]').click();
    check(studio.setProject({image:'void mainImage(out vec4 c,in vec2 p){c=vec4(0.0);}',passes:[],imageChannels:{0:{keyboard:true},1:{media:'audio'},2:{media:'webcam'},3:{media:'video'}}}),'채널 아이콘 장면 적용');
    studio.open();
    const badges=[...$('studioChannels').querySelectorAll('.chip-badge')];
    check(badges.length===4&&badges.every(node=>hasSvg(node)&&!node.textContent),'키보드·오디오·카메라·영상 채널 배지는 SVG');
    const area=$('studioCode');
    $('studioLive').checked=false;
    area.value='uniform fl';area.dispatchEvent(new Event('input',{bubbles:true}));
    area.setSelectionRange(area.value.length,area.value.length);area.focus();
    const CM=(await import('./js/codemirror.js')).load(),view=CM.EditorView.findFromDOM(document.querySelector('.cm-content'));
    check(!!view&&CM.startCompletion(view),'자동 완성 열기');
    await until(()=>document.querySelector('.cm-glsl-completion-icon'),'자동 완성 SVG');
    check(!document.querySelector('.cm-completionIcon')&&[...document.querySelectorAll('.cm-glsl-completion-icon')].every(hasSvg),'외부 라이브러리 문자 아이콘 대신 SVG 자동 완성');
    const bad=/\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|\u20E3/u;
    check(!bad.test(document.body.textContent)&&!bad.test(document.title),'실제 화면과 탭 제목에 이모지 없음');
    check(document.title.includes('[실행 대기]'),'탭 제목은 상태를 글자로 표시');
  } finally {
    settings.setLinks(links);studio.setProject(before);r.setUserUniforms(users);
    if(theme===null)document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',theme);
    if(r.getStats().running!==wasRunning)studio.togglePlayback();
    $('studioLive').checked=wasLive;
    clearInterval(timer);
  }
})();
