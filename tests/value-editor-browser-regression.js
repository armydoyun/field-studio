// Scalar/vector controls and staged editing against the real renderer.
(async () => {
  const studio=window.shaderStudio,r=window.shaderPlayground,$=id=>document.getElementById(id);
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS: ${label}`);};
  const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const {parse}=await import('/js/value-editor.js');
  const types=['float','int','uint','bool',...['vec','ivec','uvec','bvec'].flatMap(prefix=>[2,3,4].map(n=>prefix+n))];
  const get=name=>r.getUserUniforms().find(u=>u.name===name).value;
  const before=studio.getProject(),realSet=r.setUniform,writes=[];
  const dialog=()=>document.querySelector('dialog[open][aria-label$=" 값 편집"]');
  const open=name=>{document.querySelector(`.value-edit-open[data-name="${name}"]`).click();return dialog();};
  const action=text=>[...dialog().querySelectorAll('button')].find(b=>b.textContent.trim()===text).click();
  const fields=()=>[...dialog().querySelectorAll('.ui-value-fields input,.ui-value-fields select')];
  const fire=(field,type)=>field.dispatchEvent(new Event(type,{bubbles:true}));
  try {
    for(const [type,text,value] of [['float','1.23456789012345e-12',1.23456789012345e-12],['int','-2147483648',-2147483648],['uint','4294967295',4294967295],['bvec3','bvec3(true, 0, 1)',[true,false,true]],['ivec2','-1\n2147483647',[-1,2147483647]]])
      check(JSON.stringify(parse(type,text))===JSON.stringify(value),`${type} full precision/boundary parser`);
    for(const [type,text] of [['float','NaN'],['float','1e999'],['int','1.5'],['int','2147483648'],['uint','-1'],['uint','4294967296'],['vec3','1,2'],['vec3','1,,2,3'],['vec2','vec3(1,2)'],['bvec2','true,2']]) {
      let failed=false;try{parse(type,text);}catch{failed=true;}check(failed,`${type} rejects ${text}`);
    }
    const image=[...types.map((type,i)=>`uniform ${type} uValue${i}; // @default ${type==='bool'||type.startsWith('bvec')?'false':'0'}`),'uniform vec3 uArray[2]; // @default 0','uniform vec3 uDir; // @dir','uniform int uMode; // @enum one two three','void mainImage(out vec4 c,in vec2 p){c=vec4(0.2);}'].join('\n');
    check(studio.setProject({image,passes:[],imageChannels:{}}),'all scalar/vector types load');
    $('tab-uniforms').click();document.body.classList.remove('panel-hidden');fire($('uniformSearch'),'input');await frames();
    r.setUniform=(name,...args)=>{writes.push(name);return realSet(name,...args);};
    for(const theme of ['dark','light']) for(const width of [240,300,560]) {
      document.documentElement.dataset.theme=theme;$('workspace').style.setProperty('--panel-width',`${width}px`);await frames();
      for(const row of document.querySelectorAll('.uniform-row')) {
        const box=row.getBoundingClientRect();
        for(const control of row.querySelectorAll('input,button')) {
          const b=control.getBoundingClientRect();if(!b.width)continue;
          check(b.left>=box.left-1&&b.right<=box.right+1,`${theme} ${width}px ${control.getAttribute('aria-label')||control.className} stays in row`);
        }
      }
      check($('panel').scrollWidth<=$('panel').clientWidth+1,`${theme} ${width}px no horizontal overflow`);
    }

    for(let i=0;i<types.length;i++) {
      const name=`uValue${i}`,type=types[i],initialValue=get(name),initial=JSON.stringify(initialValue),count=Number(type.slice(-1))||1;
      open(name);check(fields().length===count,`${type} has labelled component fields`);
      check(fields().every(f=>f.labels?.length&&f.getAttribute('aria-label')),`${type} fields have accessible labels`);
      const first=fields()[0];if(first.type==='checkbox'){first.checked=!first.checked;fire(first,'change');}else{first.value='7';fire(first,'input');}
      check(JSON.stringify(get(name))===initial,`${type} drafts stay local`);
      action('취소');check(!dialog()&&JSON.stringify(get(name))===initial,`${type} cancel restores model`);
      const n=writes.length;open(name);action('적용');check(writes.length===n,`${type} unchanged Apply does not write`);
      open(name);const edit=fields()[0],toggle=edit.type==='checkbox';if(toggle){edit.checked=!edit.checked;fire(edit,'change');}else{edit.value='7';fire(edit,'input');}
      action('적용');const actual=get(name);check((Array.isArray(actual)?actual[0]:actual)===(toggle?!(Array.isArray(initialValue)?initialValue[0]:initialValue):7),`${type} changed Apply commits correct component`);
      realSet(name,initialValue);

    }
    fire($('uniformSearch'),'input');await frames();
    check(document.querySelector('[data-name="uValue3"] .uniform-switch').textContent.includes('false'),'bool shows explicit state');
    const x=document.querySelector('input[aria-label="uValue6 X"]');
    check(x.parentElement.classList.contains('ui-input-group--prefix')&&x.labels[0].textContent==='X','inline vec4 uses shared axis prefix');
    open('uValue2');fields()[0].value='-1';action('적용');check(dialog().querySelector('[aria-invalid=true]')&&get('uValue2')===0,'uint invalid input stays in dialog without model change');
    fields()[0].value='4294967295';action('적용');check(get('uValue2')===4294967295,'uint full range commits');
    open('uValue1');fields()[0].value='2.5';action('적용');check(dialog()&&get('uValue1')===0,'fractional int rejected');fields()[0].value='-2147483648';action('적용');check(get('uValue1')===-2147483648,'signed int minimum commits');
    realSet('uValue4',[0.123456789012345,0.2]);open('uValue4');check(fields()[0].value==='0.123456789012345','dialog opens full precision');
    fields()[0].value='9.87654321098765e-12';fire(fields()[0],'input');realSet('uValue4',[0.4,0.8]);action('적용');
    check(get('uValue4')[0]===9.87654321098765e-12&&get('uValue4')[1]===0.8,'Apply preserves external changes to untouched neighbors');
    open('uValue5');dialog().querySelector('details').open=true;
    const area=dialog().querySelector('textarea');area.value='vec3(1,2)';action('입력칸에 채우기');check(fields().every(f=>f.value==='0'),'invalid bulk input fills no components');
    area.value='vec3(1.23456789012345, 2e-8, -3)';fire(area,'input');action('입력칸에 채우기');
    check(fields()[0].value==='1.23456789012345'&&get('uValue5')[0]===0&&!area.hasAttribute('aria-invalid'),'bulk fill is precise, clears error and remains a draft');action('적용');check(get('uValue5')[2]===-3,'bulk draft applies once');
    open('uValue15');fields()[3].checked=true;fire(fields()[3],'change');action('적용');check(get('uValue15')[3]===true,'bvec4 fourth component commits');
    open('uArray[1]');fields()[1].value='123';action('적용');check(get('uArray')[4]===123&&get('uArray')[1]===0,'array editor updates only selected element');
    open('uDir');fields().forEach(f=>f.value='0');action('적용');check(dialog().querySelector('[role=alert]').textContent.includes('0 벡터'),'zero direction is rejected locally');action('취소');
    open('uMode');check(fields()[0].tagName==='SELECT','enum keeps dropdown semantics in dialog');fields()[0].value='2';action('적용');check(get('uMode')===2,'enum applies valid option');
    open('uValue0');const f=fields()[0];f.value='456';fire(f,'input');f.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));check(f.value==='0'&&dialog(),'Escape restores focused draft');action('취소');
    open('uValue0');check(studio.setProject({image:'void mainImage(out vec4 c,in vec2 p){c=vec4(1.0);}',passes:[],imageChannels:{}}),'replacement project loads');await frames();check(!dialog(),'project replacement disposes open editor');
  } finally {r.setUniform=realSet;studio.setProject(before);}
})();
