// Real renderer + parameter UI: geometry, column-major mapping, precision and staged dialog edits.
(async () => {
  const studio = window.shaderStudio, r = window.shaderPlayground, $ = id => document.getElementById(id);
  const check = (ok, label) => { if (!ok) throw new Error(label); console.log(`PASS: ${label}`); };
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const until = async fn => { for (let i = 0; i < 250; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve,20)); } throw new Error("matrix UI timeout"); };
  const before = studio.getProject(), width = $("workspace").style.getPropertyValue("--panel-width"), theme = document.documentElement.dataset.theme;
  const originalSet = r.setUniform;
  let writes = 0;
  const value = name => [...r.getUserUniforms().find(u => u.name === name).value];
  const matrix = name => [...document.querySelectorAll("#uniformList .ui-matrix")].find(n => n.dataset.name === name);
  const cell = (node, index) => node.querySelector(`.ui-matrix-cell[data-index="${index}"]`);
  const edit = (node, text) => { const input = node.querySelector(".ui-matrix-input"); input.value = text; input.dispatchEvent(new Event("input",{bubbles:true})); input.dispatchEvent(new Event("change",{bubbles:true})); return input; };
  try {
    check(studio.setProject({image:[
      "uniform mat2 uM2; // @default 1",
      "uniform mat3 uM3; // @default 1",
      "uniform mat4 uM4; // @default 1",
      "uniform mat3 uArray[2]; // @default 1",
      "void mainImage(out vec4 c,in vec2 p){c=vec4(0.2);}",
    ].join("\n"),passes:[],imageChannels:{}}), "matrix scene loads");
    await until(()=>r.getUserUniforms().length===4);
    const precise = 0.123456789012345;
    r.setUniform("uM3",[precise,2,3,4,5,6,7,8,9]);
    r.setUniform("uM4",Array.from({length:16},(_,i)=>i===0?-1e25:i===1?1e-25:i+precise));
    r.setUniform("uArray",Array.from({length:18},(_,i)=>i+precise));
    $("tab-uniforms").click(); document.body.classList.remove("panel-hidden");
    $("uniformSearch").dispatchEvent(new Event("input",{bubbles:true}));
    await until(()=>document.querySelectorAll("#uniformList .ui-matrix").length===5);
    const m = matrix("uM3"), beforeValues = value("uM3");
    check([...m.querySelectorAll(".ui-matrix-cell")].map(b=>+b.dataset.index).join() === "0,3,6,1,4,7,2,5,8", "visual rows map to GLSL column-major indices");
    for (const chosenTheme of ["light","dark"]) for (const panelWidth of [240,300,560]) {
      document.documentElement.dataset.theme=chosenTheme;
      $("workspace").style.setProperty("--panel-width",`${panelWidth}px`); await frames();
      for (const node of document.querySelectorAll("#uniformList .ui-matrix")) {
        const n=Math.sqrt(node.querySelectorAll(".ui-matrix-cell").length), rects=[...node.querySelectorAll(".ui-matrix-cell")].map(c=>c.getBoundingClientRect());
        check(new Set(rects.map(b=>Math.round(b.x))).size===n && new Set(rects.map(b=>Math.round(b.y))).size===n, `${chosenTheme}/${panelWidth}: ${n}×${n} shape retained`);
        check(node.scrollWidth<=node.clientWidth+1, "long numbers do not expand matrix width");
        for (const control of node.querySelectorAll("button,input")) { const b=control.getBoundingClientRect(),box=node.getBoundingClientRect(); check(b.left>=box.left-1&&b.right<=box.right+1,"controls stay within matrix"); }
      }
    }
    r.setUniform=(...args)=>{writes++;return originalSet(...args);};
    cell(m,0).click(); check(m.querySelector("input").value===String(precise),"full precision appears in editor");
    m.querySelector("input").dispatchEvent(new Event("change",{bubbles:true})); cell(m,3).click();
    check(writes===0&&JSON.stringify(value("uM3"))===JSON.stringify(beforeValues),"focus / unchanged blur / cell switch preserve exact values");
    m.querySelector("input").dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}));
    check(cell(m,6).getAttribute("aria-pressed")==="true","Tab advances to next visual column");
    m.querySelector("input").dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",shiftKey:true,bubbles:true,cancelable:true}));
    check(cell(m,3).getAttribute("aria-pressed")==="true"&&writes===0,"Shift+Tab returns without changing values");
    cell(m,8).click();
    const exitTab=new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}); m.querySelector("input").dispatchEvent(exitTab);
    check(!exitTab.defaultPrevented,"Tab at last cell exits the matrix editor"); cell(m,3).click();
    const next=-7.123456789012345e-12;
    edit(m,String(next));
    check(value("uM3")[3]===next&&value("uM3").every((v,i)=>i===3||v===beforeValues[i]),"precise exponent edit changes only selected column-major entry");
    const count=writes;
    for(const bad of ["", "-", "NaN", "Infinity", "1e999", "1e-"]) {
      const input=edit(m,bad); check(input.getAttribute("aria-invalid")==="true"&&writes===count,"invalid intermediate numbers never reach renderer");
      input.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})); check(input.value===String(next),"Escape restores exact committed value");
    }
    cell(m,0).focus(); cell(m,0).dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}));
    check(document.activeElement===cell(m,3),"Right arrow moves right, not down storage order");
    const a=matrix("uArray[1]"), all=value("uArray"); cell(a,5).click(); edit(a,"0.987654321098765");
    check(value("uArray")[14]===0.987654321098765&&value("uArray").every((v,i)=>i===14||v===all[i]),"matrix array edit preserves other elements");
    const expand=()=>[...m.querySelectorAll("button")].find(b=>b.textContent.includes("확대 편집")).click();
    const modal=()=>document.querySelector('dialog[aria-label="uM3 행렬 확대 편집"]');
    const foot=(d,text)=>[...d.querySelectorAll("footer button")].find(b=>b.textContent===text);
    const saved=value("uM3"); expand(); let d=modal(); check(d?.open,"expanded editor is a native modal with shared dialog classes");
    cell(d,8).click(); edit(d,"0.111111111111111");
    check(JSON.stringify(value("uM3"))===JSON.stringify(saved),"dialog draft remains separate from renderer");
    foot(d,"취소").click(); check(!modal()&&JSON.stringify(value("uM3"))===JSON.stringify(saved),"cancel discards dialog draft");
    expand(); d=modal(); cell(d,8).click(); edit(d,"0.111111111111111"); foot(d,"적용").click();
    check(!modal()&&value("uM3")[8]===0.111111111111111,"apply commits dialog draft at full precision");
    const unchangedWrites=writes;
    expand(); d=modal(); foot(d,"적용").click(); check(writes===unchangedWrites,"applying untouched dialog does not rewrite values");
    expand(); d=modal(); d.dispatchEvent(new Event("cancel",{cancelable:true})); check(!modal(),"Escape/cancel dismisses dialog");
    expand(); await frames(); check(modal()?.open,"stale close events do not dismiss reopened dialog"); studio.setProject(before); await until(()=>!modal());
    check(!document.querySelector("dialog .ui-matrix"),"project replacement cleans up expanded editor");
  } finally {
    r.setUniform=originalSet; studio.setProject(before); $("workspace").style.setProperty("--panel-width",width);
    if(theme)document.documentElement.dataset.theme=theme;else delete document.documentElement.dataset.theme;
  }
})();
