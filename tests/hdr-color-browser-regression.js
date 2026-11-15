// Native color inputs emit many input events while dragging. HDR intensity must not compound.
(async () => {
  const r=window.shaderPlayground,studio=window.shaderStudio,$=id=>document.getElementById(id);
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS ${label}`);};
  const close=(a,b)=>Math.abs(a-b)<=1e-10*Math.max(Math.abs(b),1e-8);
  const before=studio.getProject(),users=r.getUserUniforms();
  const row=name=>document.querySelector(`.uniform-row[data-name="${name}"]`);
  const value=name=>r.getUserUniforms().find(u=>u.name===name).value;
  const pick=(node,color)=>{node.value=color;node.dispatchEvent(new Event('input',{bubbles:true}));};
  const timer=setInterval(()=>{if($('studioPromptDialog')?.open)($('studioDialogAlt').hidden?$('studioDialogOK'):$('studioDialogAlt')).click();},25);
  let offline=false;
  try {
    check(studio.setProject({
      image:`uniform vec3 uGlow; // @color hdr 20 @default 4 2 1
uniform vec4 uTint; // @color hdr 4 @default 2 1 0.5 0.375
uniform vec3 uFine; // @color hdr 4 @default 1e-8 5e-9 0
uniform vec3 uPlain; // @color @default 1 0.5 0.25
uniform vec3 uSwatches[2]; // @color hdr 20 @default 4 2 1 1 2 4
void mainImage(out vec4 c,in vec2 p){c=vec4(uGlow+uTint.rgb+uFine+uPlain+uSwatches[0],1.0);}`,
      passes:[{name:'A',fragment:'uniform vec4 uTint;\nvoid mainImage(out vec4 c,in vec2 p){c=uTint;}',format:'rgba32f',scale:1,size:[1,1],filter:'nearest',channels:{}}],imageChannels:{},
    }),'HDR 실습 장면 적용');
    $('tab-uniforms').click();
    for(const [name,intensity] of [['uGlow',4],['uTint',2]]){
      const picker=row(name).querySelector('input[type=color]');picker.focus();
      for(const color of ['#808040','#202010','#010001'])for(let i=0;i<40;i++){
        pick(picker,color);
        if(!close(Math.max(...value(name).slice(0,3)),intensity))throw new Error(`${name}: 연속 입력 중 I가 변경됨`);
      }
      check(Number(row(name).querySelector('.uniform-intensity input[type=number]').value)===intensity,`${name}: 어두운 색을 120번 입력해도 I 유지`);
      if(name==='uTint')check(value(name)[3]===0.375,'RGBA의 알파 유지');
    }
    const hex=row('uTint').querySelector('.uniform-hex');
    for(let i=0;i<30;i++){
      hex.value='#404000';hex.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      hex.dispatchEvent(new Event('change',{bubbles:true}));
    }
    check(JSON.stringify(value('uTint'))==='[2,2,0,0.375]','HEX의 Enter·change 중복 입력에도 I 유지');
    const fine=row('uFine').querySelector('input[type=color]');
    pick(fine,'#010001');
    check(value('uFine')[0]===1e-8&&Number(row('uFine').querySelector('.uniform-intensity input[type=number]').value)===1e-8,'작은 양수 I를 값·표시에서 0으로 반올림하지 않음');
    const number=row('uFine').querySelector('.uniform-intensity input[type=number]');
    number.focus();number.value='2e-8';number.dispatchEvent(new Event('input',{bubbles:true}));number.dispatchEvent(new Event('change',{bubbles:true}));
    check(value('uFine')[0]===2e-8&&value('uFine')[2]===2e-8,'작은 I도 정확하게 직접 편집');
    const swatch=row('uSwatches').querySelector('.uniform-array-item input[type=color]');
    for(let i=0;i<50;i++)pick(swatch,'#404020');
    check(JSON.stringify(value('uSwatches'))==='[4,4,2,1,2,4]','HDR 배열은 선택한 원소의 I만 유지하며 이웃 원소 보존');
    pick(row('uPlain').querySelector('input[type=color]'),'#402010');
    check(JSON.stringify(value('uPlain'))==='[0.25098,0.12549,0.062745]','일반 색상은 고른 밝기를 그대로 적용');
    r.beginOffline({width:16,height:16});offline=true;
    r.renderOfflineFrame({time:0,delta:0,frame:0});
    const pixel=Array.from(r.readPassPixel('A',0,0));
    check(pixel.every((v,i)=>Math.abs(v-[2,2,0,0.375][i])<1e-5),'실제 GPU에도 유지된 HDR RGB·알파 전달');
    r.endOffline();offline=false;
    const tint=row('uTint').querySelector('input[type=color]');
    pick(tint,'#000000');check(value('uTint').slice(0,3).every(v=>v===0),'직접 고른 검정 적용');
    pick(tint,'#010001');check(JSON.stringify(value('uTint'))==='[1,0,1,0.375]','검정에서 색을 다시 선택하면 복구');
  } finally {
    if(offline)r.endOffline();studio.setProject(before);r.setUserUniforms(users);clearInterval(timer);
  }
})();
