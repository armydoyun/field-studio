// Playback updates the parameter value, never the connection's loop-duration setting.
(async () => {
  const r=window.shaderPlayground,studio=window.shaderStudio,settings=window.shaderSettings,$=id=>document.getElementById(id);
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS: ${label}`);};
  const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const before=studio.getProject(),running=r.getStats().running;
  const row=()=>document.querySelector('.uniform-row[data-name="uLoopValue"]');
  const duration=()=>row().querySelector('input[aria-label="반복 길이(초)"]');
  const link=()=>settings.getLinks().find(l=>l.name==='uLoopValue');
  const set=(field,value)=>{field.value=value;field.dispatchEvent(new Event('change',{bubbles:true}));};
  try {
    check(studio.setProject({image:'uniform float uLoopValue; // @range -10 10\nvoid mainImage(out vec4 c,in vec2 p){c=vec4(uLoopValue);}',passes:[],imageChannels:{}}),'loop-input scene loads');
    if(r.getStats().running)studio.togglePlayback();r.setTime(0);
    settings.setLinks([{name:'uLoopValue',source:'keys',keys:[[0,-4],[1,8],[2,-2]],loop:3,ease:'linear',min:-10,max:10,smooth:0}]);
    $('tab-uniforms').click();document.body.classList.remove('panel-hidden');row().querySelector('.link-uniform').click();await frames();
    check(duration().value==='3','opening loop sheet retains configured three seconds');
    for(const time of [0.25,1.5,2.5,3.5]) {
      r.setTime(time);await frames();
      check(duration().value==='3'&&link().loop===3,`parameter animation at ${time}s leaves duration unchanged`);
      const current=r.getUserUniforms().find(u=>u.name==='uLoopValue').value;
      check(Math.abs(Number(row().querySelector('.uniform-pair input[type=number]').value)-current)<0.01,'actual parameter field follows keyframe value');
    }
    const input=duration();input.focus();input.value='6.25';input.dispatchEvent(new Event('input',{bubbles:true}));r.setTime(1);await frames();
    check(input.value==='6.25'&&link().loop===3,'focused duration draft survives animation without saving');
    set(input,'6.25');await frames();check(link().loop===6.25&&duration().value==='6.25','duration edits commit and remain visible');
    const once=()=>[...row().querySelectorAll('[role=radio]')].find(b=>b.textContent==='한 번');
    once().click();await frames();check(link().loop===0&&!duration(),'once hides duration and removes looping');
    [...row().querySelectorAll('[role=radio]')].find(b=>b.textContent==='반복').click();await frames();
    check(Number(duration().value)===link().loop&&link().loop>0,'switching back to loop restores a stable configured duration');
  } finally {studio.setProject(before);if(r.getStats().running!==running)studio.togglePlayback();}
})();
