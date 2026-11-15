// Grouped help keeps every document reachable without expanding the full catalog.
(async () => {
  const $ = id => document.getElementById(id), nav = $('guideNav'), help = $('quickHelp');
  const check = (ok, label) => { if (!ok) throw new Error(label); console.log(`PASS ${label}`); };
  const wait = () => new Promise(resolve => setTimeout(resolve, 40));
  const topic = id => nav.querySelector(`[data-topic="${id}"]`);
  const category = id => nav.querySelector(`[data-category="${id}"]`);
  const query = text => { $('guideSearch').value = text; $('guideSearch').dispatchEvent(new Event('input')); };
  const before = window.shaderStudio.getProject();
  const saved = ['field.guide.navigation.v1', 'field.guide.last.v1'].map(key => [key, localStorage.getItem(key)]);
  try {
    $('helpToggle').click(); topic('start').click();
    check(nav.children.length === 4, '상단 두 문서와 입문·레퍼런스 두 범주');
    const ids = [...nav.querySelectorAll('[data-topic]')].map(node => node.dataset.topic);
    check(ids.length === new Set(ids).size && ids.length === 32, '기존 32개 문서가 중복·누락 없이 유지됨');
    check(category('course').querySelectorAll('[data-topic^="c"]').length === 13, '입문 안내와 12단계 유지');
    check(category('reference').querySelectorAll('details').length === 4, '레퍼런스의 네 하위 범주');
    category('course').querySelector('summary').click(); await wait();
    check(category('course').open, '범주 펼치기');
    category('course').querySelector('summary').click(); await wait();
    check(!category('course').open && !topic('c1').checkVisibility(), '범주를 접으면 자식 문서가 숨겨짐');
    check(JSON.parse(localStorage.getItem('field.guide.navigation.v1')).course === false, '접힘 상태 보관');
    category('code').open = false; await wait();
    category('parameters').open = false; await wait();
    const folded = localStorage.getItem('field.guide.navigation.v1');
    query('프리셋 호환성'); await wait();
    check(topic('presets')?.checkVisibility() && category('parameters').open && category('reference').open, '접힌 범주 안 검색 결과와 상위 범주를 자동 펼침');
    check(localStorage.getItem('field.guide.navigation.v1') === folded, '검색의 임시 펼침은 저장된 접힘을 덮어쓰지 않음');
    query(''); await wait();
    check(!category('course').open && !category('code').open, '검색 해제 후 관련 없는 범주의 접힘 유지');
    query('채널과 렌더링 패스');
    check(nav.querySelectorAll('[data-topic]').length === 4, '범주 이름으로 하위 문서 찾기');
    query('존재하지않는가이드문서987');
    check(nav.querySelector('.guide-empty') && !nav.querySelector('details'), '검색 결과가 없으면 빈 범주를 표시하지 않음');
    query(''); topic('start').click();
    category('reference').open = false; await wait();
    help.close(); document.querySelector('[data-guide="rendering"]').click(); await wait();
    check(category('reference').open && category('workspace').open && topic('rendering').getAttribute('aria-current') === 'page', '문맥 도움말은 접힌 상위·하위 범주를 열고 현재 문서 표시');
    topic('c12').click();
    check(category('course').open && topic('c12').getAttribute('aria-current') === 'page', '직접 이동도 입문 과정 범주를 펼침');
    check(JSON.stringify(window.shaderStudio.getProject()) === JSON.stringify(before), '목차 조작·검색이 프로젝트를 변경하지 않음');
  } finally {
    if (help.open) help.close();
    for (const [key, value] of saved) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
  }
})();
