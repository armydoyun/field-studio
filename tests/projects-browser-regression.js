// 브라우저 개발자 콘솔에서 실행: 프로젝트 보관함(IndexedDB) — 저장 · 덮어쓰기 · 다른 이름 · 열기 · 이름 바꾸기 · 삭제.
// 이 테스트가 만든 프로젝트와 이미지는 끝에 지운다. 기존 보관함 항목은 건드리지 않는다.
(async () => {
  const $ = id => document.getElementById(id), studio = window.shaderStudio, P = studio.projects;
  const check = (ok, name) => { if(!ok) throw Error(`FAIL: ${name}`); console.log(`PASS: ${name}`); };
  const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
  // 대화상자가 열릴 때까지 기다렸다가 값을 넣고 확인한다(value가 없으면 확인만).
  const answer = async value => {
    for(let i = 0; i < 50 && !$('studioPromptDialog').open; i++) await tick(20);
    check($('studioPromptDialog').open, `대화상자 열림: ${$('studioDialogTitle').textContent}`);
    if(value !== undefined) $('studioDialogInput').value = value;
    $('studioDialogForm').requestSubmit();
  };
  const created = new Set(), tag = `회귀테스트 ${Date.now().toString(36)}`;
  const names = async () => (await P.list()).filter(item => item.name.startsWith(tag)).map(item => item.name);
  const find = async name => (await P.list()).find(item => item.name === name);
  const textures = () => document.querySelectorAll('#studioTextureList .studio-texture').length;
  const before = {current:P.current(), textures:textures(), project:studio.getProject()};
  await P.ready();
  try {
    // 1) 처음 저장은 이름을 묻는다. 저장 뒤에는 '작업 중'으로 표시되고 버튼이 '저장'으로 바뀐다.
    let pending = P.save(false); await answer(`${tag} A`); check(await pending, '첫 저장');
    const a = await find(`${tag} A`); created.add(a.id);
    check(P.current()?.id === a.id && $('studioProjectCurrent').textContent.includes(`${tag} A`), '저장한 항목이 작업 중 프로젝트');
    check($('studioProjectSave').textContent === '저장' && !$('studioProjectSaveAs').hidden, '저장 버튼은 덮어쓰기, 다른 이름으로 저장이 보인다');
    check(!!document.querySelector(`#studioProjectList [data-current="true"]`), '목록에서 작업 중 항목 표시');

    // 2) 고친 뒤 저장은 묻지 않고 같은 항목을 덮어쓴다.
    const base = studio.getProject();
    check(studio.setProject({...base, image:base.image.replace('void main', '// saved edit\nvoid main')}), '코드 수정 적용');
    check(await P.save(false), '덮어쓰기 저장');
    check((await names()).length === 1 && (await find(`${tag} A`)).updated >= a.updated, '덮어쓰기는 항목을 늘리지 않는다');

    // 3) 예제로 바꾸면 작업 중 표시를 잊는다. 이때 저장하면 새 항목이 된다.
    check(studio.examplePipeline(), '버퍼 예제 열기');
    check(P.current() === null, '다른 작업으로 바뀌면 작업 중 표시 해제');
    pending = P.save(false); await answer(`${tag} B`); check(await pending, '새 항목 저장');
    const b = await find(`${tag} B`); created.add(b.id);
    check(b.passes === 2 && b.images === 0, '요약: 버퍼 2 · 이미지 0');

    // 4) 열기는 저장한 코드·버퍼 구성을 되살린다.
    check(await P.open(a.id), 'A 열기');
    check(studio.getProject().image.includes('// saved edit') && studio.getProject().passes.length === 0 && P.current()?.id === a.id, '열면 저장한 상태 + 작업 중 표시');

    // 5) 이미지가 든 프로젝트: 저장하고 두 번 열어도 같은 이미지가 쌓이지 않는다.
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2; const g = canvas.getContext('2d'); g.fillStyle = '#3366ff'; g.fillRect(0, 0, 2, 2);
    const scene = {...studio.getProject(), imageChannels:{0:{texture:'probe'}}};
    check(await studio.importPack(new File([JSON.stringify({version:2, project:scene, selected:'Image', textures:[{id:'probe', name:'probe.png', type:'image/png', data:canvas.toDataURL('image/png')}]})], 'probe.json')), '이미지 Pack 가져오기');
    const withImage = textures();
    pending = P.save(true); await answer(`${tag} C`); check(await pending, '이미지 프로젝트 저장');
    const c = await find(`${tag} C`); created.add(c.id);
    check(c.images === 1, '요약: 이미지 1');
    check(await P.open(c.id) && await P.open(c.id), '이미지 프로젝트 두 번 열기');
    check(textures() === withImage && !!studio.getProject().imageChannels[0]?.texture, '같은 이미지는 다시 쓰고 연결은 유지');

    // 6) 다른 이름으로 저장은 사본 이름을 제안한다. 이름 바꾸기는 공백을 정리한다.
    pending = P.save(true); for(let i = 0; i < 50 && !$('studioPromptDialog').open; i++) await tick(20);
    check($('studioDialogInput').value === `${tag} C 사본`, '다른 이름으로 저장: 사본 이름 제안'); await answer(`${tag} D`); await pending;
    const d = await find(`${tag} D`); created.add(d.id);
    pending = P.rename(d.id); await answer(`  ${tag}   E  `); check(await pending, '이름 바꾸기');
    check(!!(await find(`${tag} E`)) && P.current()?.name === `${tag} E`, '바뀐 이름이 목록과 작업 중 표시에 반영');

    // 7) 미적용 변경이 있으면 열기 전에 묻는다. 취소하면 편집이 남는다.
    const area = $('studioCode'); area.value += '\n// unsaved'; area.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:'x'}));
    pending = P.open(a.id); for(let i = 0; i < 50 && !$('studioPromptDialog').open; i++) await tick(20);
    check($('studioDialogTitle').textContent === '미적용 변경사항', '미적용 변경 확인'); $('studioDialogCancel').click();
    check(await pending === false && studio.getEditorSource().includes('// unsaved'), '취소하면 편집 유지');

    // 8) 삭제는 위험 확인을 거치고, 작업 중 항목을 지우면 표시도 사라진다.
    pending = P.remove(d.id); for(let i = 0; i < 50 && !$('studioPromptDialog').open; i++) await tick(20);
    check($('studioPromptDialog').dataset.danger === 'true', '삭제는 위험 확인'); await answer(); check(await pending, '삭제');
    created.delete(d.id);
    check(!(await find(`${tag} E`)) && P.current() === null, '삭제 후 목록·작업 중 표시에서 빠짐');
  } finally {
    // 정리: 만든 프로젝트를 지우고, 처음 장면으로 돌린 뒤 테스트 이미지를 지운다.
    if($('studioPromptDialog').open) $('studioDialogCancel').click();
    for(const id of created) { const pending = P.remove(id); await answer().catch(() => {}); await pending; }
    studio.setProject(before.project);
    for(const button of [...document.querySelectorAll('#studioTextureList button')].filter(b => /probe\.png 삭제/.test(b.title))) { button.click(); await answer().catch(() => {}); await tick(300); }
  }
  check((await names()).length === 0, '정리: 테스트 프로젝트 모두 삭제');
  console.log('프로젝트 보관함 회귀 테스트 완료');
})();
