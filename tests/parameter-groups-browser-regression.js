// Cached boot and metadata-only @group updates must not depend on unrelated UI actions.
(async () => {
  const r=window.shaderPlayground,studio=window.shaderStudio,settings=window.shaderSettings,$=id=>document.getElementById(id);
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS: ${label}`);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(fn,label)=>{for(const end=Date.now()+15000;Date.now()<end;await wait(20))if(fn())return;throw new Error(`timeout: ${label}`);};
  const group=(name,doc=document)=>[...doc.querySelectorAll('.uniform-group')].find(g=>g.querySelector('.uniform-group-name').textContent===name);
  const inGroup=(name,uniform,doc=document)=>!!group(name,doc)?.querySelector(`.uniform-row[data-name="${uniform}"]`);
  const before=studio.getProject(),saved=settings.snapshot(),wasRunning=r.getStats().running;
  const image=tag=>`uniform float uCachedGroup; // original description · @range 0 10 @default 2 ${tag}\nvoid mainImage(out vec4 c,in vec2 p){c=vec4(uCachedGroup);}`;
  const wasLive=$('studioLive').checked;
  let frame,settingsEvents=0;const count=()=>settingsEvents++;
  try {
    if(wasRunning)studio.togglePlayback();
    check(studio.setProject({image:image('@group Cached'),passes:[],imageChannels:{}}),'cached group scene loads');
    r.setUniform('uCachedGroup',7);settings.save();
    // A real fresh app reads the same cached project and already matching uniforms.
    // Do not click a tab, search, group, or connection in the child to force a redraw.
    frame=document.createElement('iframe');frame.width='400';frame.height='600';frame.src=location.href;document.body.append(frame);
    await until(()=>frame.contentWindow?.shaderStudio&&frame.contentWindow?.shaderPlayground,'cached app initializes');
    check(inGroup('Cached','uCachedGroup',frame.contentDocument),'cached boot groups matching saved parameters before any interaction');
    check(frame.contentWindow.shaderPlayground.getUserUniforms().find(u=>u.name==='uCachedGroup').value===7,'cached boot preserves saved parameter value');
    frame.remove();frame=null;
    document.addEventListener('shader-settings-applied',count);
    $('tab-uniforms').click();document.body.classList.remove('panel-hidden');
    const apply=code=>studio.setProject({image:code,passes:[],imageChannels:{}});
    const events=settingsEvents;
    check(apply(image('@group Renamed')),'metadata-only rename compiles');
    check(inGroup('Renamed','uCachedGroup')&&!group('Cached'),'group rename appears immediately after successful apply');
    check(settingsEvents===events,'group-only change needs no uniform settings change');
    check(r.getUserUniforms().find(u=>u.name==='uCachedGroup').value===7,'group changes preserve existing value');
    check(apply(image('')),'group removal compiles');check(!document.querySelector('.uniform-group')&&document.querySelector('#uniformList>.uniform-row'),'removing @group ungroups parameter immediately');
    check(apply(image('@group Added')),'group added to existing parameter compiles');check(inGroup('Added','uCachedGroup'),'later @group addition groups existing parameter');
    const head=group('Added').querySelector('button');head.click();check(group('Added').classList.contains('is-collapsed'),'group collapses');
    const sameHead=group('Added').querySelector('button');check(apply(image('@group Added')+'\n// shader-only edit'),'ordinary code edit compiles');check(group('Added').querySelector('button')===sameHead&&group('Added').classList.contains('is-collapsed'),'unchanged annotation metadata preserves group DOM and collapsed state');
    const renamedDescription=image('@group Added').replace('original description','updated description');
    check(apply(renamedDescription),'description-only edit compiles');check(group('Added').classList.contains('is-collapsed')&&group('Added').textContent.includes('updated description'),'metadata refresh preserves collapse state and updates description');
    check(!apply(renamedDescription.replace('@group Added','@group Invalid')+'\nBROKEN_CODE'),'invalid shader is rejected');check(group('Added')&&!group('Invalid'),'failed compilation retains applied groups');
    // Common and buffer annotations use the same source order as parameter registration.
    const multi={image:'void mainImage(out vec4 c,in vec2 p){c=vec4(uSharedGroup);}',common:'uniform float uSharedGroup; // shared description · @range 0 1 @default 0.4 @group Shared',passes:[{name:'A',fragment:'uniform float uBufferGroup; // @range 0 1 @group Buffer\nvoid mainImage(out vec4 c,in vec2 p){c=vec4(uBufferGroup+uSharedGroup);}',format:'rgba8',scale:1,channels:{}}],imageChannels:{}};
    check(studio.setProject(multi),'Common and buffer groups compile');check(inGroup('Shared','uSharedGroup')&&inGroup('Buffer','uBufferGroup'),'Common and buffer parameters show their groups');
    check(group('Shared').textContent.includes('shared description'),'Common descriptions are shown');
    const changed=structuredClone(multi);changed.common=changed.common.replace('@group Shared','@group SharedNew');changed.passes[0].fragment=changed.passes[0].fragment.replace('@group Buffer','@group BufferNew');
    check(studio.setProject(changed),'Common/buffer group-only edit compiles');check(inGroup('SharedNew','uSharedGroup')&&inGroup('BufferNew','uBufferGroup'),'Common/buffer metadata-only edits refresh immediately');
    const none={...changed,common:changed.common.replace(/\/\/.*$/m,''),passes:changed.passes.map(p=>({...p,fragment:p.fragment.replace(/\/\/.*$/m,'')}))};
    check(studio.setProject(none),'last annotations removed');check(!document.querySelector('.uniform-group'),'removing last annotation clears stale groups');
    $('uniformEditor').open=true;$('uniformType').value='float';$('uniformType').dispatchEvent(new Event('change',{bubbles:true}));
    $('uniformName').value='uManualGroup';$('uniformValue').value='0.625';for(const id of ['uniformMin','uniformMax','uniformStep'])$(id).value='';
    $('uniformForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    check(r.getUserUniforms().some(u=>u.name==='uManualGroup'&&u.value===0.625),'manual parameter added through creation form');
    const manual={...none,image:'uniform float uManualGroup; // @group Manual\n'+none.image};
    const beforeManual=settingsEvents;check(studio.setProject(manual),'annotation added after manual creation');
    check(inGroup('Manual','uManualGroup')&&settingsEvents===beforeManual,'manual parameter groups without changing uniform options');
    check(r.getUserUniforms().find(u=>u.name==='uManualGroup').value===0.625,'grouping manual parameter keeps its value');
    studio.open();$('studioLive').checked=false;$('studioLive').dispatchEvent(new Event('change'));
    $('studioCode').value=manual.image.replace('@group Manual','@group DraftOnly');$('studioCode').dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('.uniform-row[data-name="uManualGroup"] .link-uniform').click();
    check(inGroup('Manual','uManualGroup')&&!group('DraftOnly'),'unapplied draft does not change applied groups on unrelated redraw');
    $('uniformSearch').value='uManualGroup';$('uniformSearch').dispatchEvent(new Event('input',{bubbles:true}));
    check(studio.apply(),'edited code applies');check(inGroup('DraftOnly','uManualGroup')&&$('uniformSearch').value==='uManualGroup','code editor group edit refreshes immediately and preserves search');

  } finally {
    document.removeEventListener('shader-settings-applied',count);frame?.remove();$('studioLive').checked=wasLive;$('studioLive').dispatchEvent(new Event('change'));$('uniformSearch').value='';studio.setProject(before);settings.applyPack(saved);if(r.getStats().running!==wasRunning)studio.togglePlayback();
  }
})();
