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
