// Precision-safe numeric editing and per-type creation drafts in the real parameter UI.
(async () => {
  const r=window.shaderPlayground, studio=window.shaderStudio, $=id=>document.getElementById(id);
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS: ${label}`);};
  const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const before=studio.getProject(), realSet=r.setUniform, writes=[];
  const get=name=>r.getUserUniforms().find(u=>u.name===name).value;
  const input=label=>document.querySelector(`input[aria-label="${label}"]`);
  const fire=(field,type)=>field.dispatchEvent(new Event(type,{bubbles:true}));
  const key=(field,key)=>field.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));
  const type=t=>{$("uniformType").value=t;fire($("uniformType"),"change");};
  try {
    check(studio.setProject({image:[
      "uniform float uPrecise; // @default 0.123456789012345",
      "uniform vec3 uVector; // @default 0.123456789012345 0.234567890123456 0.345678901234567",
      "uniform float uFine; // @range 0 1 @step 1e-8 @default 0.12345678",
      "uniform float uMotion; // @range 0 1 @step 0.01 @anim 4 @default 0.25",
      "void mainImage(out vec4 c,in vec2 p){c=vec4(0.2);}",
    ].join("\n"),passes:[],imageChannels:{}}),"numeric editing scene loads");
    $("tab-uniforms").click();document.body.classList.remove("panel-hidden");fire($("uniformSearch"),"input");
    await frames();
    r.setUniform=(name,...args)=>{writes.push(name);return realSet(name,...args);};
    const f=input("uPrecise"), exact=get("uPrecise");
    check(f.value!==String(exact)&&f.title===String(exact),"summary display retains exact value metadata");
    f.focus();check(f.value===String(exact),"focus exposes full precision");
    fire(f,"change");f.blur();check(!writes.includes("uPrecise")&&get("uPrecise")===exact,"unchanged focus/change/blur does not write rounded value");
    f.focus();f.value="0.987654321098765";fire(f,"input");key(f,"Escape");
    check(f.value===String(exact)&&get("uPrecise")===exact,"Escape discards numeric draft");
    f.value="-7.123456789012345e-12";fire(f,"input");key(f,"Enter");
    check(get("uPrecise")===-7.123456789012345e-12,"Enter commits precise exponent input");
    f.blur();f.focus();check(f.value===String(get("uPrecise")),"reentering uses exact committed value");f.blur();
    realSet("uPrecise",0.777777777777777);f.focus();f.value="";fire(f,"input");fire(f,"change");
    check(Number(f.value)===0.777777777777777&&get("uPrecise")===0.777777777777777,"invalid scalar input restores latest external value rather than stale row value");key(f,"Escape");f.blur();
    const x=input("uVector X");realSet("uVector",[0.9,0.8,0.7]);x.focus();check(x.value==="0.9","vector focus reads current external value");
    x.value="0.812345678901234";fire(x,"input");fire(x,"change");x.blur();x.focus();
    check(x.value==="0.812345678901234"&&get("uVector")[1]===0.8&&get("uVector")[2]===0.7,"vector edit preserves exact component and current neighbors");
    x.value="0.5";fire(x,"input");realSet("uVector",[0.7,0.6,0.5]);key(x,"Escape");
    check(x.value==="0.7"&&get("uVector")[0]===0.7,"Escape restores latest live value without overwriting it");x.blur();
    const y=input("uVector Y"),handle=x.parentElement.querySelector("label"),capture=handle.setPointerCapture;
    y.focus();y.value="0.24681357913579";fire(y,"input");
    try {
      handle.setPointerCapture=()=>{}; // synthetic pointer does not own a native pointer capture
      handle.dispatchEvent(new PointerEvent("pointerdown",{button:0,buttons:1,pointerId:9,clientX:0,bubbles:true}));
      handle.dispatchEvent(new PointerEvent("pointermove",{button:0,buttons:1,pointerId:9,clientX:16,bubbles:true}));
      handle.dispatchEvent(new PointerEvent("pointerup",{button:0,buttons:0,pointerId:9,clientX:16,bubbles:true}));
      check(get("uVector")[0]===0.74&&get("uVector")[1]===0.24681357913579,"starting a scrub commits another component's draft before reading the model");
    } finally {handle.setPointerCapture=capture;}
    const fine=input("uFine");fine.focus();
    const cs=getComputedStyle(fine),ctx=document.createElement("canvas").getContext("2d");ctx.font=`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    check(fine.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)>=ctx.measureText(fine.value).width-1,"scientific step reserves enough space for decimal digits");fine.blur();
    const play=document.querySelector('.uniform-row[data-name="uMotion"] .play-uniform');play.click();await frames();
    const motion=input("uMotion");motion.focus();fire(motion,"change");
    check(play.getAttribute("aria-pressed")==="true","unchanged numeric focus does not cancel playback");
    motion.value="0.456";fire(motion,"input");await frames();check(motion.value==="0.456","playback updates do not overwrite typing");
    key(motion,"Escape");check(Number(motion.value)===get("uMotion")&&play.getAttribute("aria-pressed")==="true","Escape restores running value without stopping playback");play.click();motion.blur();
    $("uniformEditor").open=true;type("float");$("uniformName").value="uDraft";
    $("uniformValue").value="0.135791357913579";$("uniformMin").value="-1";$("uniformMax").value="4";$("uniformStep").value="1e-8";
    type("vec3");$("uniformValue").value="1, 2, 3";$("uniformDisplay").value="color";fire($("uniformDisplay"),"change");
    type("mat3");const matrixText="1, 2, 3, 4, 5, 6, 7, 8, 9";$("uniformValue").value=matrixText;
    type("float");check($("uniformValue").value==="0.135791357913579"&&$("uniformMin").value==="-1"&&$("uniformMax").value==="4"&&$("uniformStep").value==="1e-8","returning to float restores initial value and range draft");
    type("vec3");check($("uniformValue").value==="1, 2, 3"&&$("uniformDisplay").value==="color"&&$("rangeFields").hidden,"returning to vector restores compatible display draft");
    type("mat3");type("mat3");check($("uniformValue").value===matrixText&&$("uniformName").value==="uDraft","matrix draft and GLSL name survive type changes");
    await frames();const trigger=$("uniformType").nextElementSibling;
    check(getComputedStyle(trigger).paddingRight===getComputedStyle(trigger).paddingLeft&&parseFloat(getComputedStyle(trigger,"::after").marginRight)===0,"creation type chevron uses symmetric input padding without extra margin");
    $("uniformCancel").click();
  } finally {r.setUniform=realSet;studio.setProject(before);}
})();
