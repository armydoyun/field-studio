// 브라우저 개발자 콘솔에서 실행: 도움말과 툴팁을 확인하고 프로젝트 상태는 변경하지 않는다.
(() => {
  const $ = id => document.getElementById(id), check = (ok,name) => {if(!ok)throw Error(`FAIL: ${name}`);console.log(`PASS: ${name}`);};
  const help = $('quickHelp'); check(!!help && !!$('helpToggle') && !!$('studioHelp'), '도움말 진입점');
  // 가이드는 한 번에 한 주제만 그린다. 각 내용이 들어 있는 주제를 열어 확인하고, 검색으로도 찾을 수 있는지 본다.
  const showTopic = id => document.querySelector(`#guideNav button[data-topic="${id}"]`)?.click();
  for(const [topic, keys] of [['shortcuts', ['Ctrl+S','Ctrl+Shift+Enter','Ctrl+Shift+D','Alt+PageUp','키 코드']], ['uniforms', ['iChannel0']]]) {
    if(!help.open) $('helpToggle').click(); showTopic(topic);
    for(const key of keys) check($('guideContent').textContent.includes(key), `가이드 ${topic}: ${key}`);
  }
  // 키 코드 확인 칸: 누른 키의 번호를 보여 주고, 앱 단축키(?, E 등)로 넘기지 않는다.
  showTopic('shortcuts'); const pad = document.querySelector('#guideContent .guide-keycode-pad');
  check(!!pad, '가이드 단축키: 키 코드 확인 칸'); pad.focus();
  const press = init => { const e = new KeyboardEvent('keydown', {bubbles:true, cancelable:true, ...init}); pad.dispatchEvent(e); return e; };
  const q = press({key:'q', code:'KeyQ', keyCode:81});
  check(q.defaultPrevented && pad.textContent.includes('81') && $('guideContent').textContent.includes('const int KEY_Q = 81;'), '키 코드 확인: Q = 81');
  press({key:'?', code:'Slash', keyCode:191, shiftKey:true}); check(help.open && pad.textContent.includes('191'), '키 코드 확인 중 ? 키로 가이드가 닫히지 않음');
  press({key:'ArrowLeft', code:'ArrowLeft', keyCode:37}); check($('guideContent').textContent.includes('const int KEY_LEFT = 37;'), '키 코드 확인: ← = 37');
  showTopic('inputs'); check(!!document.querySelector('#guideContent .guide-keycode-pad'), '가이드 입력 채널: 키 코드 확인 칸');
  const search = $('guideSearch'); search.value = 'Ctrl+Shift+D'; search.dispatchEvent(new Event('input'));
  check(!!document.querySelector('#guideNav button[data-topic="shortcuts"]'), '가이드 검색: Ctrl+Shift+D → 단축키'); search.value = ''; search.dispatchEvent(new Event('input'));
  check($('guideNav').querySelectorAll('button').length > 10, '가이드 목록 채워짐'); help.close();
  for(const id of ['studioRun','studioAdd','studioSamplePixel','studioExport','studioFoldAll'])
    check(!!$(id).title, `버튼 설명: ${id}`);
  if(help.open) help.close(); $('helpToggle').click(); check(help.open,'상단 버튼으로 열기'); $('helpClose').click();check(!help.open,'닫기');
  $('studioHelp').click();check(help.open,'편집기에서 열기'); help.close();
  const editor = $('studioCode'), dock = $('studioDock'); const wasHidden=dock.hidden; dock.hidden=false;editor.focus();
  editor.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true,cancelable:true}));
  check(!help.open,'코드 입력 중 단축키 가로채지 않기');dock.hidden=wasHidden;
  console.log('빠른 사용법 및 단축키 도움말 회귀 테스트 완료');
})();
