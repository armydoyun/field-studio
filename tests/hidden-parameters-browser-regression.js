// Hidden parameters remain discoverable without filling a narrow parameter panel with names.
(async () => {
  const $=id=>document.getElementById(id),studio=window.shaderStudio,r=window.shaderPlayground;
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS ${label}`);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(fn,label)=>{for(const end=Date.now()+7000;Date.now()<end;await wait(25))if(fn())return;throw new Error(label);};
  const before=studio.getProject(),users=r.getUserUniforms();
  const autoAnswer=setInterval(()=>{if($('studioPromptDialog')?.open)($('studioDialogAlt').hidden?$('studioDialogOK'):$('studioDialogAlt')).click();},25);
  const row=name=>document.querySelector(`.uniform-row[data-name="${name}"]`);
  const search=value=>{$('uniformSearch').value=value;$('uniformSearch').dispatchEvent(new Event('input',{bubbles:true}));};
  try {
    document.querySelector('.gallery-card[data-id="annotations"]').click();
    await until(()=>r.getUserUniforms().some(u=>u.name==='uAmbientFill'),'어노테이션 예제');
    $('tab-uniforms').click();
    $('panelResize').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));
    const details=$('uniformHidden'),summary=details.querySelector('summary'),list=$('uniformHiddenList');
    check(list.children.length>=30,'사진과 같은 다수의 숨겨진 항목');
    check(!details.hidden&&!details.open,'숨긴 항목 목록은 기본적으로 접혀 있음');
    check(details.getBoundingClientRect().height<=36,'좁은 패널에서도 기본 안내는 한 줄');
    check(!$('uniformResults').textContent,'이름을 나열하는 안내 문단 제거');
    check(getComputedStyle(summary,'::before').maskImage.includes('data:image/svg+xml'),'공통 SVG 펼침 아이콘');
    summary.click();
    check(details.open,'요약을 누르면 목록 펼침');
    check(list.getBoundingClientRect().height<=145&&list.scrollHeight>list.clientHeight,'펼친 이름 목록은 높이를 제한하고 내부 스크롤');
    check(list.scrollWidth<=list.clientWidth+1,'좁은 패널에서 가로 넘침 없음');
    const first=list.firstElementChild;
    search('');
    check(details.open&&list.firstElementChild===first,'일반 갱신은 펼침 상태와 조작 DOM을 유지');
    const name=first.textContent,wasGlow=r.getUserUniforms().find(u=>u.name==='uGlowEnabled').value;
    first.click();
    check($('uniformSearch').value===name&&!!row(name),'이름을 누르면 숨겨진 파라미터를 검색해서 표시');
    check(details.hidden&&!details.open,'검색 중에는 숨김 안내를 접고 감춤');
    check(document.activeElement===$('uniformSearch'),'검색 입력에 초점을 유지');
    check(r.getUserUniforms().find(u=>u.name==='uGlowEnabled').value===wasGlow,'목록 탐색은 셰이더 조건 값을 바꾸지 않음');
    search('');
    check(!details.hidden&&!details.open&&!row(name),'검색을 지우면 원래 조건과 접힌 요약으로 복귀');
    check($('uniformHiddenCount').textContent===`${list.children.length}개`,'개수는 현재 숨긴 항목과 일치');
    search('missing_uniform_name');
    check(details.hidden&&$('uniformResults').textContent.includes('0개 표시'),'검색 결과 없음 안내 유지');
  } finally {
    search('');studio.setProject(before);r.setUserUniforms(users);clearInterval(autoAnswer);
  }
})();
