(async () => {
  const studio = window.shaderStudio, renderer = window.shaderPlayground;
  const $ = id => document.getElementById(id);
  const check = (ok, label) => { if (!ok) throw new Error(label); console.log(`PASS ${label}`); };
  const row = name => document.querySelector(`.uniform-row[data-name="${name}"]`);
  const user = name => renderer.getUserUniforms().find(item => item.name === name);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const timer = setInterval(() => {
    if ($('studioPromptDialog')?.open && !$('studioDialogAlt').hidden) $('studioDialogAlt').click();
  }, 30);
  try {
    const applied = await studio.setProject({
      common: 'uniform bool uOn; // @default true\nuniform int uMode; // @enum A B C @default 2',
      image: 'uniform float uA, uB; // 설명 · @range 0 10 @step 0.1 @default 1\nuniform float uDetail; // @range 0 1 @default 0.5 @if uMode == C && uOn\nvoid mainImage(out vec4 c, in vec2 p){c=vec4(uA/10.0);}',
      passes: [{name:'A',format:'rgba32f',scale:1,filter:'nearest',fragment:'uniform float uA; // @range 0 10 @default 1\nvoid mainImage(out vec4 c, in vec2 p){c=vec4(uA/10.0);}',channels:{}}],
      imageChannels: {},
    });
    check(applied, `프로젝트 적용: ${$("studioError")?.textContent} / ${$("studioMessage")?.textContent}`);
    studio.apply();
    $('tab-uniforms').click();
    await wait(100);
    check(!!row('uDetail'), `복합 조건이 참이면 표시: ${JSON.stringify(renderer.getUserUniforms())} / ${$('studioMessage').textContent}`);
    renderer.setUniform('uA', 3.2);
    // Redraw through the public UI search, without waiting for polling.
    $('uniformSearch').dispatchEvent(new Event('input', {bubbles:true}));
    row('uA').querySelector('.write-default-uniform').click();
    check(studio.getProject().image.includes('@default 3.2'), '개별 현재 값을 Image 기본값에 반영');
    check(studio.getProject().passes[0].fragment.includes('@default 3.2'), '같은 파라미터의 Buffer 기본값도 반영');
    check(studio.getProject().image.includes('uB; // 설명 · @range 0 10 @step 0.1 @default 1'), '공유 선언의 다른 파라미터는 유지');
    check(row('uA').querySelector('.reset-uniform').disabled, '새 기본값이면 리셋 비활성');
    studio.undo();
    check(!studio.getProject().image.includes('@default 3.2') && user('uA').value===3.2, '기본값 반영 Undo는 코드와 현재 값을 복원');
    studio.redo();
    renderer.setUniform('uOn', false);
    renderer.setUniform('uA', 4);
    $('uniformWriteDefaults').click();
    check(studio.getProject().common.includes('@default false'), '일괄 반영은 Common 선언도 갱신');
    check(studio.getProject().image.includes('@default 4'), '바뀐 값을 모두 코드에 반영');
    row('uA').querySelector('.lock-uniform').click();
    check(row('uA').querySelector('.lock-uniform').getAttribute('aria-pressed')==='true', '파라미터 잠금');
    const before = renderer.getUserUniforms();
    const originalRandom = Math.random;
    try {
      Math.random = () => 0.8;
      $('uniformRandomize').click();
    } finally { Math.random = originalRandom; }
    check(user('uA').value===4, '전체 무작위는 잠긴 파라미터를 유지');
    check(user('uB').value===8, '전체 무작위는 나머지를 범위 안에서 변경');
    studio.undo();
    check(JSON.stringify(renderer.getUserUniforms())===JSON.stringify(before), '전체 무작위는 Undo 한 번으로 복원');
    try {
      Math.random = () => 1;
      $('uniformJitter').click();
    } finally { Math.random = originalRandom; }
    check(user('uA').value===4 && Math.abs(user('uB').value-1.1)<1e-9, '조금씩 바꾸기는 잠금 유지·현재 값 주변 변경');
    studio.undo();
    renderer.setUniform('uOn', true);
    $('uniformSearch').dispatchEvent(new Event('input', {bubbles:true}));
    check(!!row('uDetail'), '&& 조건을 만족하면 다시 표시');
    renderer.setUniform('uMode', 1);
    $('uniformSearch').dispatchEvent(new Event('input', {bubbles:true}));
    check(!row('uDetail'), '&& 조건 중 하나가 거짓이면 숨김');
  } finally { clearInterval(timer); }
})();
