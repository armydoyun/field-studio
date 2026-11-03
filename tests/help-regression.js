// 브라우저 개발자 콘솔에서 실행: 도움말과 툴팁을 확인하고 프로젝트 상태는 변경하지 않는다.
(() => {
  const $ = id => document.getElementById(id), check = (ok,name) => {if(!ok)throw Error(`FAIL: ${name}`);console.log(`PASS: ${name}`);};
  const help = $('quickHelp'); check(!!help && !!$('helpToggle') && !!$('studioHelp'), '도움말 진입점');
  for(const key of ['Ctrl+Enter','Ctrl+Shift+D','Alt+PageUp','iChannel0','WASD'])
    check(help.textContent.includes(key), `빠른 사용법: ${key}`);
  for(const id of ['studioRun','studioAdd','studioSamplePixel','studioExport','studioFindNext'])
    check(!!$(id).title, `버튼 설명: ${id}`);
  if(help.open) help.close(); $('helpToggle').click(); check(help.open,'상단 버튼으로 열기'); $('helpClose').click();check(!help.open,'닫기');
  $('studioHelp').click();check(help.open,'편집기에서 열기'); help.close();
  const editor = $('studioCode'), dock = $('studioDock'); const wasHidden=dock.hidden; dock.hidden=false;editor.focus();
  editor.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true,cancelable:true}));
  check(!help.open,'코드 입력 중 단축키 가로채지 않기');dock.hidden=wasHidden;
  console.log('빠른 사용법 및 단축키 도움말 회귀 테스트 완료');
})();
