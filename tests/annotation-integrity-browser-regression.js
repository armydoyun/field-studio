// Invalid annotations must not block valid siblings or mutate previously valid parameters.
(async()=>{
  const r=window.shaderPlayground,studio=window.shaderStudio,settings=window.shaderSettings;
  const $=id=>document.getElementById(id),check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS ${label}`);};
  const old=studio.getProject(),users=r.getUserUniforms(),links=settings.getLinks();
  const bad=[
    'uniform bool uBadBool; // @default maybe',
    'uniform float uBadNumber; // @default NaN',
    'uniform int uBadInt; // @default 1.5',
    'uniform vec2 uBadVector; // @default 1 2 3',
    'uniform float uBadRange; // @range 2 1',
    'uniform float uBadStep; // @range 0 1 0',
  ].join('\n');
  const image='/*\nuniform float uGhost; // @default 3\n*/\n'+bad+'\nuniform float uGood; // @range 0 1 @default 0.25\nvoid mainImage(out vec4 c,in vec2 p){c=vec4(uGood);}';
  const refresh=()=>$('uniformSearch').dispatchEvent(new Event('input',{bubbles:true}));
  const user=name=>r.getUserUniforms().find(item=>item.name===name);
  try {
    settings.setLinks([]);
    check(studio.setProject({image,passes:[],imageChannels:{}}),'잘못된 어노테이션이 있는 GLSL도 컴파일');
    $('tab-uniforms').click();refresh();
    check(user('uGood')?.value===0.25,'잘못된 이웃 항목과 무관하게 정상 파라미터 등록');
    check(!user('uGhost')&&!r.getUserUniforms().some(item=>item.name.startsWith('uBad')),'블록 주석과 잘못된 항목은 등록하지 않음');
    check($('studioMessage').textContent.includes('무시'),'잘못된 어노테이션을 무시한 이유 안내');
    let fixed=image.replace('@default maybe','@default true').replace('@default NaN','@default 0.5').replace('@default 1.5','@default 2').replace('@default 1 2 3','@default 1 2').replace('@range 2 1','@range 0 2').replace('@range 0 1 0','@range 0 1 0.1');
    check(studio.setProject({image:fixed,passes:[],imageChannels:{}}),'잘못된 태그 수정');refresh();
    check(user('uBadBool')?.value===true&&user('uBadNumber')?.value===0.5&&user('uBadInt')?.value===2,'수정하면 bool·float·int 기본값 적용');
    check(JSON.stringify(user('uBadVector')?.value)==='[1,2]'&&user('uBadStep')?.options.step===0.1,'수정하면 벡터와 범위·간격 적용');
    r.setUniform('uBadNumber',0.8);
    fixed=fixed.replace('@default 0.5','@default NaN');
    check(studio.setProject({image:fixed,passes:[],imageChannels:{}}),'기존 항목의 태그가 잘못돼도 장면 유지');refresh();
    check(user('uBadNumber').value===0.8&&user('uGood').value===0.25,'잘못된 새 태그는 기존 유효 값과 다른 파라미터를 훼손하지 않음');
    fixed=fixed.replace('@range 0 1 @default 0.25','@range 0 0.2 @default 0.1');
    check(studio.setProject({image:fixed,passes:[],imageChannels:{}}),'범위 축소');refresh();
    check(user('uGood').value===0.2,'기존 값은 바뀐 범위 안으로 보정');
    fixed+='\nuniform float uClamped; // @range 0 1 @default 2\nuniform sampler2D uClampedRamp; // @gradient @default 0 2 -1 0 1 1 1 1 1 1';
    check(studio.setProject({image:fixed,passes:[],imageChannels:{}}),'범위 밖 기본값이 있는 선언 추가');refresh();
    check(user('uClamped').value===1,'새 파라미터의 기본값도 범위 안으로 보정');
    const ramp=document.querySelector('.uniform-row[data-name="uClampedRamp"]');
    check(ramp.dataset.changed==='false'&&ramp.querySelector('.reset-uniform').disabled,'정규화한 그라데이션 기본값은 변경으로 잘못 표시하지 않음');
  } finally {
    settings.setLinks([]);studio.setProject(old);r.setUserUniforms(users);settings.setLinks(links);
    document.dispatchEvent(new Event('shader-settings-applied'));
  }
})();
