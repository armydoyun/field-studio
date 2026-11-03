// 사용자 편집 상태만 소유한다. GPU 자원과 연결 규칙은 Renderer/PassManager가 검증한다.
// 외부 코드 에디터나 네트워크 요청은 사용하지 않는다. file:// 배포는 deploy/ 번들을 사용한다.
import * as CodeEditor from "./code-editor.js";
import * as Annotations from "./annotations.js";

  const STORAGE_KEY = "webgl.shader-studio.project.v1", DRAFT_KEY = "webgl.shader-studio.draft.v2", JSON_LIMIT=16*1024*1024, PACK_LIMIT=64*1024*1024; const copy = x => x && typeof x==="object" ? Array.isArray(x) ? x.map(copy) : Object.fromEntries(Object.entries(x).map(([k,v])=>[k,copy(v)])) : x;
    const comparison = `#version 300 es
precision highp float;
// Image: iChannel0 = B (current), iChannel1 = A (current).
// 왼쪽은 A 원본, 오른쪽은 B 처리 결과. 각 화면에 같은 UV를 사용한다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    bool original = uv.x < 0.5;
    uv.x = fract(uv.x * 2.0);
    vec3 color = original ? texture(iChannel1, uv).rgb : texture(iChannel0, uv).rgb;
    fragColor = vec4(color, 1.0);
}`;
    const blank = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    fragColor = vec4(uv, 0.5 + 0.5 * sin(uTime), 1.0);
}`;
    const movingDot = `#version 300 es
precision highp float;
// Buffer A: 외부 입력 없이 움직이는 원을 만든다. B가 A의 current를 읽는다.
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;
void main() {
    vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec2 center = 0.5 * vec2(cos(uTime), sin(uTime * 1.4));
    float dotMask = 1.0 - smoothstep(0.09, 0.11, length(p - center));
    fragColor = vec4(vec3(0.1, 0.65, 1.0) * dotMask, 1.0);
}`;
    const colorFilter = `#version 300 es
precision highp float;
// Buffer B: iChannel0 = A (current). 반드시 A 다음에 실행한다.
// A의 이번 프레임 결과를 읽어 RGB 순서를 바꾼다. 자기 자신은 읽지 않는다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 source = texture(iChannel0, uv).rgb;
    fragColor = vec4(source.brg, 1.0);
}`;
    const feedback = `#version 300 es
precision highp float;
// Buffer B: iChannel0 = A (current), iChannel1 = B (previous).
// A의 새 원을 현재 프레임에서 읽고, B의 직전 프레임에 남은 잔상과 합친다.
// B를 current로 자기 참조하면 안 된다. previous는 별도 Texture를 읽는다.
uniform vec2 uResolution;
uniform float uDeltaTime;
uniform int uFrame;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 source = texture(iChannel0, uv).rgb;
    // 첫 프레임에는 이전 누적 결과를 사용하지 않는다. Reset으로 다시 시작한다.
    vec3 history = uFrame == 0 ? vec3(0.0) : texture(iChannel1, uv).rgb;
    // 초 단위로 밝기를 줄이되, RGBA8에서 반올림되어 잔상이 고착되지 않게 최소 1단계 감쇠한다.
    float fade = max(0.8 * uDeltaTime, 1.0 / 255.0);
    fragColor = vec4(max(source, history - fade), 1.0);
}`;
  // options.lookup(name): 내장 함수 설명 {sig, desc} 또는 null — 편집기 시그니처 힌트에 쓴다(main.js가 레퍼런스에서 만들어 넘긴다).
  const mount = (renderer, Shader, settings = null, options = {}) => {
    const $ = id => document.getElementById(id); const controller = new AbortController(), signal = controller.signal;
    const element = tag => document.createElement(tag);
    const on = (target, type, callback) => target.addEventListener(type, callback, {signal}); const original = Shader.fragment;
    const snapshot = () => ({image:renderer.getFragmentSource(),passes:renderer.getPassDefinitions(),imageChannels:renderer.getImageChannels()});
    let textureButtons=[];let project = snapshot(); let selected = "Image", timer = null, draftTimer = null, dirty = false, compileFailed = false, changeText = "", openState = false, disposed = false;
    // One native dialog serves input and confirmation requests; no window.prompt/confirm is used.
    const dialog=$("studioPromptDialog"), form=$("studioDialogForm"), field=$("studioDialogField"), valueInput=$("studioDialogInput"); let pending=null;
    const finish = accepted => {
      if(!pending)return; if(accepted&&pending.hasValue&&!valueInput.reportValidity())return;
      const {resolve,hasValue,wasLive}=pending;pending=null;dialog.close();
      if(wasLive&&dirty&&!disposed&&$("studioLive").checked)timer=setTimeout(apply,900);
      resolve(accepted?(hasValue?valueInput.value:true):(hasValue?null:false));
    };
    on(form,"submit",event=>{event.preventDefault();finish(true);});
    on($("studioDialogCancel"),"click",()=>finish(false));on($("studioDialogClose"),"click",()=>finish(false));
    on(dialog,"cancel",event=>{event.preventDefault();finish(false);});on(dialog,"close",()=>{if(!dialog.open)finish(false);});
    on(dialog,"click",event=>{if(event.target===dialog)finish(false);});on(dialog,"keydown",event=>{event.stopPropagation();if(event.key!=="Enter"||event.isComposing||event.keyCode===229)return;
      event.preventDefault();if(!event.repeat&&!event.ctrlKey&&!event.metaKey&&!event.altKey)finish(true);});
    const ask = ({title,message="",value,ok="확인",danger=false,label="값",type="text",min,max}) => new Promise(resolve=>{
      const hasValue=value!==undefined;if(pending)return resolve(hasValue?null:false);
      $("studioDialogTitle").textContent=title;$("studioDialogMessage").textContent=message;
      $("studioDialogOK").firstChild.textContent=ok+" ";dialog.dataset.danger=String(danger);
      field.hidden=!hasValue;valueInput.disabled=!hasValue;if(hasValue) {field.firstChild.textContent=label;valueInput.type=type;valueInput.value=String(value);
        if(min===undefined)valueInput.removeAttribute("min");else valueInput.min=String(min);
        if(max===undefined)valueInput.removeAttribute("max");else valueInput.max=String(max);
        valueInput.required=true;
      } const wasLive=!!timer;if(timer){clearTimeout(timer);timer=null;}pending={resolve,hasValue,wasLive};
      try{dialog.showModal();(hasValue?valueInput:$("studioDialogCancel")).focus();if(hasValue)valueInput.select();}
      catch(error){pending=null;if(wasLive&&dirty&&!disposed)timer=setTimeout(apply,900);resolve(hasValue?null:false);}
    });
    const proceed = (decision,action) => decision instanceof Promise?decision.then(ok=>ok&&action()):decision&&action();
    const defaultHeight=window.matchMedia("(max-width:600px), (max-height:650px)").matches?75:55;let expanded = false, resumeAfterMaximize = false, dockHeight = defaultHeight, navigatingHistory = false; const undoStack = [], redoStack = [], views = new Map();
    const syncHistory = () => { $("studioUndo").disabled = !undoStack.length; $("studioRedo").disabled = !redoStack.length; };
    const cursorState = () => {const area=$("studioCode");return {caret:[area.selectionStart,area.selectionEnd,area.selectionDirection],scroll:[area.scrollTop,area.scrollLeft]};};
    const historyState = () => ({project:copy(project),users:renderer.getUserUniforms(),selected,...cursorState()});
    let checkpoint = historyState(), editTime = 0, editTab = "";
    const recordEdit = (typing = false, usersChanged = false) => {
      if(navigatingHistory)return;const current=historyState();if(!usersChanged)checkpoint.users=current.users;if(same(current.project,checkpoint.project)&&same(current.users,checkpoint.users))return;
      const now=Date.now(),group=typing && editTab===selected && now-editTime<700 && undoStack.length;
      if(!group){undoStack.push(checkpoint);if(undoStack.length>25)undoStack.shift();}
      redoStack.length=0;checkpoint=current;editTime=typing?now:0;editTab=selected;syncHistory();
    };
    const captureCursor = () => {if(!navigatingHistory && selected===checkpoint.selected && same(project,checkpoint.project)) Object.assign(checkpoint,cursorState());};
    // 숫자 끌어 바꾸기(Alt+드래그) 중에는 자동 적용 대기(0.9초) 없이 짧은 간격으로 바로 적용해 화면이 따라오게 한다.
    let scrubTimer = 0;
    const scrubApply = () => { if(scrubTimer) return; scrubTimer = setTimeout(() => { scrubTimer = 0; if(!disposed) apply(); }, 60); };
    // 자동 완성에서 코드 조각 함수를 고르면 필요한 함수 정의를 전역 위치에 넣는다(이름 입력과 함께 Undo 한 번).
    const library = options.snippets ? {items:options.snippets.items, insert:id => {
      const item = options.snippets.items.find(entry => entry.id === id), plan = options.snippets.plan(id, $("studioCode").value);
      const global = plan.globals.map(entry => entry.code).join("\n\n"); if(!global) return false;
      return insertCode({global, note:`코드 조각 '${item?.title || id}' 정의를 위쪽에 추가했습니다${plan.added.length ? ` (+ ${plan.added.join(", ")})` : ""} · Ctrl+Z로 되돌리기`});
    }} : null;
    const editor = CodeEditor.mount($("studioCode"),ask,captureCursor,()=>renderer.getUserUniforms().map(item=>item.name),{lookup:options.lookup,builtins:options.builtins,library,
      userUniforms:()=>renderer.getUserUniforms().map(item=>({name:item.name,type:item.type})),onScrub:scrubApply,notify:text=>setStatus(text,"is-dirty")});
    for(const type of ["beforeinput","select","click","keyup","scroll"])on($("studioCode"),type,captureCursor);
    // 사용자가 직접 정한 높이·배치만 저장한다. 정하기 전에는 창 크기(반·4분할 창 포함)에 맞는 기본값을 따른다.
    let heightChosen = false, layoutChosen = false;
    try { const storedHeight = Number(localStorage.getItem("webgl.shader-studio.height.v2")); heightChosen = storedHeight > 0; dockHeight = Math.max(25,Math.min(85,storedHeight||defaultHeight)); } catch (_) {}
    $("studioDock").style.setProperty("--studio-height",`${dockHeight}%`);
    const find = name => name === "Image" ? null : project.passes.find(p => p.name === name);
    const clearChange = () => {changeText="";$("studioChangeNotice").hidden=true;};
    const showChange = text => {changeText=text;$("studioChangeText").textContent=text+(dirty?" · 미적용 변경":"");$("studioChangeNotice").hidden=false;};
    const setStorage = (state,text,detail="") => {const node=$("studioStorageState");node.dataset.state=state;node.textContent=text;node.title=`${detail?detail+" · ":""}브라우저 보관은 소스·채널 구성만 포함합니다. 전체 작업은 Pack으로 내보내세요.`;};
    const references = name => [...project.passes,{name:"Image",channels:project.imageChannels}].filter(p=>p.name!==name).flatMap(p=>Object.entries(p.channels).filter(([,ref])=>ref.buffer===name).map(([channel])=>`${p.name}.iChannel${channel}`));
    const activeSource = () => selected === "Image" ? project.image : find(selected)?.fragment; const setStatus = (message, style = "") => {
      if($("studioMessage").textContent!==message)$("studioMessage").textContent=message;$("studioMessage").title=message; $("studioMessage").className = style;
      const state=dirty&&compileFailed?"error":dirty?"dirty":"applied",label=state==="error"?"오류 확인":dirty?"미적용 변경":"실행 반영됨";
      if($("studioState").textContent!==label)$("studioState").textContent=label;$("studioState").dataset.state=state;$("studioRun").dataset.pending=String(dirty);
      $("studioGraphState").textContent=dirty?"편집 중인 구성 · 실행 반영 대기":"실행에 반영된 구성";if(changeText)showChange(changeText);$("previewNotice").hidden=!dirty;$("previewNotice").textContent=state==="error"?"코드를 적용하지 못했습니다. 화면은 마지막 성공 결과입니다.":"미적용 변경이 있습니다. 화면은 마지막 성공 결과입니다.";
    };
    // 편집기 인라인 진단(패스별). 컴파일 성공 시 비우고, 탭 전환 시 해당 패스 항목만 보여준다.
    let diagnostics = []; const syncDiagnostics = () => editor.setDiagnostics?.(diagnostics.filter(item=>item.pass===selected));
    // keepInline: 타이핑 중에는 인라인 진단을 지우지 않고 편집기가 흐리게(stale) 유지한다. 다음 컴파일 결과가 대체한다.
    const clearError = (keepInline = false) => {compileFailed=false; $("studioError").hidden = true; $("studioErrorToggle").hidden = true; $("studioDiagnostics").hidden = true; $("studioDiagnostics").replaceChildren(); if(!keepInline && diagnostics.length){diagnostics=[];syncDiagnostics();} };
    const showError = error => {
      const text = String(error?.message || error), panel = $("studioDiagnostics");
      $("studioError").textContent = text; $("studioError").hidden = true; $("studioErrorToggle").hidden = false;
      panel.replaceChildren(); const matches=[...text.matchAll(/(?:ERROR|WARNING):\s*\d+:(\d+):\s*([^\r\n]*)/g)];diagnostics=[];
      for(const match of matches.slice(0,15)) {
        const row=element("button"), info=error?.glslInjected, original=Number(match[1]);let line=original;
        const generated=info && original>info.after && original<=info.after+(info.generated??info.count);
        if(info && original>info.after+(info.generated??info.count))line-=info.count;
        if(!generated)diagnostics.push({pass:error?.passName || selected,line,message:match[2],severity:match[0].startsWith("WARNING")?"warning":"error"});
        row.type="button";row.textContent=`${error?.passName || selected} · ${generated?"Auto Uniform":`Line ${line}`} · ${match[2]}`;
        if(generated){row.disabled=true;row.title="자동 생성된 Uniform 선언에서 발생한 오류입니다.";}
        else {row.title="원본 GLSL 줄로 이동";row.addEventListener("click",()=>{open();if(error?.passName)select(error.passName);editor.goToLine(line);});}
        panel.append(row);
      }
      panel.hidden = !matches.length; syncDiagnostics();
      setStatus(`${error?.passName?`${error.passName} 컴파일 오류`:"작업 오류"}: ${text.split("\n")[0]}`, "is-error");
    }; const clearDraft = () => {if(draftTimer)clearTimeout(draftTimer);draftTimer=null;$("studioDraft").hidden=true;
      try {localStorage.removeItem(DRAFT_KEY);}catch (_){} };
    const scheduleDraft = () => {if(draftTimer)clearTimeout(draftTimer);
      setStorage("pending","소스 · 편집본 보관 대기");draftTimer=setTimeout(()=>{draftTimer=null;rememberEditor();try {localStorage.setItem(DRAFT_KEY,JSON.stringify({version:1,project,selected}));setStorage("draft","소스 · 미적용 편집본 보관됨");}
        catch(error){setStorage("error","소스 · 브라우저 보관 실패",error.message);}},550);
    }; const saveLocal = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({version:1,project,selected}));setStorage("saved","소스 · 브라우저 보관됨"); }
      catch(error) {setStorage("error","소스 · 브라우저 보관 실패",error.message);}
    }; const preview = () => {
      const name = selected === "Image" ? null : selected;
      if(renderer.getPasses().some(p => p.name === name) || !name) renderer.setPreviewPass(name);
    }; const validateProject = candidate => {
      if(!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("프로젝트는 객체여야 합니다.");
      if(typeof candidate.image !== "string" || candidate.image.length > 262144 || !candidate.image.startsWith("#version 300 es")) throw new Error("Image GLSL 소스가 올바르지 않습니다.");
      if(!Array.isArray(candidate.passes) || candidate.passes.length > 8) throw new Error("버퍼는 최대 8개입니다.");
      const names = new Set(); for(const p of candidate.passes) {
        if(!p || typeof p.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(p.name) || p.name === "Image" || names.has(p.name) || typeof p.fragment !== "string" || !p.fragment.startsWith("#version 300 es") || p.fragment.length > 262144) throw new Error("Buffer 이름 또는 GLSL 소스를 확인하세요.");
                if(!["rgba8","rgba16f","rgba32f"].includes(p.format) || !Number.isFinite(p.scale) || p.scale < 0.125 || p.scale > 1 || !p.channels || typeof p.channels !== "object" || Array.isArray(p.channels)) throw new Error(`${p.name}: Buffer 속성이 올바르지 않습니다.`);
        // 선택 항목(고정 해상도·출력 수·샘플링)은 모양만 확인하고 세부 범위는 Renderer가 검증한다.
        if((p.size!==undefined && !(Array.isArray(p.size) && p.size.length===2)) || (p.outputs!==undefined && !Number.isInteger(p.outputs))
          || (p.filter!==undefined && typeof p.filter!=="string") || (p.wrap!==undefined && typeof p.wrap!=="string") || (p.mipmap!==undefined && typeof p.mipmap!=="boolean"))
          throw new Error(`${p.name}: Buffer 선택 속성(size/outputs/filter/wrap/mipmap)이 올바르지 않습니다.`);
        names.add(p.name);
      }
      if(!candidate.imageChannels || typeof candidate.imageChannels !== "object" || Array.isArray(candidate.imageChannels)) throw new Error("Image 채널 연결이 올바르지 않습니다.");
      return copy(candidate);
    }; const same = (a,b) => a===b || !!(a && b && typeof a==="object" && typeof b==="object" && Array.isArray(a)===Array.isArray(b) && Object.keys(a).length===Object.keys(b).length && Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k])));
    // 구조 변경은 전체 Pass 교체. 소스·채널만 바뀌면 해당 패스만 갱신하여 이전 Texture를 보존한다.
    const apply = (users = null) => {
      if(disposed) return false; if(timer) { clearTimeout(timer); timer = null; }
      rememberEditor();try {
        validateProject(project);const touched=users && !same(users,renderer.getUserUniforms()) ? renderer.applyPortable(project,users) : renderer.applyProject(project);
        syncHistory(); preview(); dirty = false; clearError(); clearDraft(); setStatus(touched ? "적용됨 · GPU 프로그램/채널 동기화 완료" : "변경 사항 없음"); saveLocal();
        const synced=syncAnnotations(); if(synced)setStatus(synced);
        return true;
      } catch(error) {
        dirty = true;compileFailed=true; if(error.passName && error.passName!==selected) select(error.passName);showError(error); scheduleDraft();return false;
      }
    };
    // 컴파일 성공 후 GLSL 주석 어노테이션(@range/@step/@default/@color)을 파라미터에 반영한다.
    // 미등록 Uniform은 새로 등록하고, 등록된 것은 옵션만 갱신한다(값은 새 범위로 보정). 한 번의 재컴파일로 처리한다.
    const syncAnnotations = () => {
      const specs=Annotations.collect([project.image,...project.passes.map(p=>p.fragment)]);if(!specs.length)return "";
      const users=renderer.getUserUniforms(),next=users.map(u=>({...u,options:{...u.options}})),added=[],updated=[],problems=[];
      for(const spec of specs) {
        if(spec.error){problems.push(`${spec.name}: ${spec.error}`);continue;}
        const current=next.find(u=>u.name===spec.name);
        if(!current){next.push({name:spec.name,type:spec.type,value:spec.value,options:spec.options});added.push(spec.name);}
        else if(current.type===spec.type && !Annotations.sameOptions(current.options,spec.options)){current.options=spec.options;current.value=Annotations.clampValue(current.value,spec.options);updated.push(spec.name);}
      }
      if(added.length||updated.length) {
        try{renderer.setUserUniforms(next);}catch(error){return `어노테이션 적용 실패: ${error.message}`;}
        checkpoint.users=renderer.getUserUniforms();document.dispatchEvent(new Event("shader-settings-applied"));
      }
      const parts=[added.length&&`등록 ${added.join(", ")}`,updated.length&&`범위 갱신 ${updated.join(", ")}`,problems.length&&`무시 ${problems.join(" / ")}`].filter(Boolean);
      return parts.length?`적용됨 · @어노테이션 ${parts.join(" · ")}`:"";
    };
    const schedule = (typing = false) => {
      clearChange();recordEdit(typing);dirty = true;clearError(true); setStatus($("studioLive").checked?"수정됨 · 자동 적용 대기 (0.9초)":"수정됨 · Run으로 적용", "is-dirty"); scheduleDraft(); if(timer) clearTimeout(timer);
      if($("studioLive").checked) timer = setTimeout(apply,900);
    }; const rememberEditor = () => {
      const p = find(selected); if(selected === "Image") project.image = $("studioCode").value;
      else if(p) p.fragment = $("studioCode").value;
    };
    const activeChannels = () => selected==="Image"?project.imageChannels:find(selected)?.channels;
    const freeChannel = () => [0,1,2,3].find(index=>!activeChannels()?.[index]);
    const syncTextureTargets = () => {const slot=freeChannel(),target=selected==="Image"?"Image":`Buffer ${selected}`;for(const button of textureButtons){button.disabled=slot===undefined;button.textContent=slot===undefined?`${target} · 빈 채널 없음`:`${target} · iChannel${slot}에 연결`;button.title=slot===undefined?"입력 채널 4개가 모두 사용 중입니다. 기존 연결을 해제하세요.":`${target}.iChannel${slot}에 연결 · 기존 입력을 덮어쓰지 않습니다.`;button.setAttribute("aria-label",`${button.dataset.assetName} · ${button.textContent}`);}};
    const validCurrent = (target,buffer) => target === "Image" || project.passes.findIndex(p=>p.name===buffer) < project.passes.findIndex(p=>p.name===target);
    const inputInfo = (ref,assets) => !ref?{source:"연결 안 함",frame:"입력 없음",help:"사용할 이미지나 버퍼를 선택하세요."}:ref.texture?
      {source:assets.find(asset=>asset.id===ref.texture)?.name||"사용할 수 없는 이미지",frame:"이미지",help:"이미지 원본을 읽습니다. Filter와 Wrap은 이미지 설정을 따릅니다."}:
      {source:`Buffer ${ref.buffer}${ref.attachment?`[${ref.attachment}]`:""}`,frame:ref.frame==="current"?"current · 이번 프레임":"previous · 지난 프레임",help:ref.frame==="current"?"이번 프레임에 앞서 실행된 버퍼의 결과를 읽습니다.":"지난 프레임에 저장된 버퍼 결과를 읽습니다. 자기 자신을 연결하면 피드백을 만들 수 있습니다."};
    const renderChannels = () => {
      const holder=$("studioChannels"),channels=activeChannels(),assets=renderer.getTextures(),blocked=project.passes.filter(pass=>!validCurrent(selected,pass.name));
      $("studioInputsTitle").textContent=`${selected} · 입력 채널`;
      $("studioChannelRules").textContent=selected==="Image"?"Image는 버퍼 실행이 끝난 뒤 그려집니다. 모든 버퍼의 current 또는 previous를 읽을 수 있습니다.":`current는 앞서 실행되는 버퍼만 선택할 수 있습니다.${blocked.length?` ${blocked.map(pass=>pass.name).join(", ")}는 자기 자신 또는 뒤에서 실행되는 버퍼이므로 previous로 연결하세요.`:""}`;
      holder.replaceChildren();for(let i=0;i<4;i++) {
        const row=element("div"),label=element("label"),select=element("select"),hint=element("p");row.className="studio-channel";
        label.textContent=`iChannel${i}`;label.htmlFor=select.id=`studioChannel${i}`;hint.id=`studioChannelHelp${i}`;hint.className="studio-channel-help";
        select.title=`iChannel${i}의 입력 이미지/버퍼 선택`;select.setAttribute("aria-describedby",`${hint.id} studioChannelRules`);
        const addOption=(value,text,disabled=false)=>{const opt=element("option");opt.value=value;opt.textContent=text;opt.disabled=disabled;select.append(opt);};
        addOption("","연결 안 함");for(const asset of assets)addOption(`tex:${asset.id}`,`이미지 · ${asset.name} (${asset.width}×${asset.height})`);
        // 출력이 여럿(MRT)인 버퍼는 출력마다 선택지를 둔다. 값 형식: 이름:frame[:출력번호]
        for(const pass of project.passes){const allowed=validCurrent(selected,pass.name),outputs=pass.outputs||1;
          for(let att=0;att<outputs;att++){const suffix=att?`:${att}`:"",shown=outputs>1?`${pass.name}[${att}]`:pass.name;
            addOption(`${pass.name}:current${suffix}`,`${shown} · current${allowed?" · 이번 프레임":pass.name===selected?" · 자기 참조 불가":" · 실행 순서상 불가"}`,!allowed);addOption(`${pass.name}:previous${suffix}`,`${shown} · previous · 지난 프레임`);}}
        const current=channels?.[i];select.value=current?(current.texture?`tex:${current.texture}`:`${current.buffer}:${current.frame}${current.attachment?`:${current.attachment}`:""}`):"";
        const describe=()=>{const info=inputInfo(channels?.[i],assets);hint.textContent=`${info.source} · ${info.frame} — ${info.help}`;};describe();
        select.addEventListener("change",()=>{
          if(!select.value)delete channels[i];else if(select.value.startsWith("tex:"))channels[i]={texture:select.value.slice(4)};else{const [buffer,frame,att]=select.value.split(":");channels[i]=att?{buffer,frame,attachment:Number(att)}:{buffer,frame};}
          describe();schedule();renderGraph();syncTextureTargets();if(!$("studioLive").checked)return;
          if(timer){clearTimeout(timer);timer=null;}apply();
        });row.append(label,select,hint);holder.append(row);
      }syncTextureTargets();
    }; const renderGraph = () => {
      const holder=$("studioGraph"),assets=renderer.getTextures();holder.replaceChildren();
      for(const entry of [...project.passes,{name:"Image",channels:project.imageChannels}]){
        const row=element("button"),name=element("strong");row.type="button";row.classList.toggle("is-current",entry.name===selected);row.setAttribute("aria-pressed",String(entry.name===selected));row.title=`${entry.name} 패스 편집`;
        name.textContent=entry.name==="Image"?"Image · Canvas":`Buffer ${entry.name}`;row.append(name);
        const inputs=Object.entries(entry.channels||{}).sort(([a],[b])=>Number(a)-Number(b));if(!inputs.length){const empty=element("small");empty.textContent="연결된 채널 없음";row.append(empty);}
        for(const [i,ref] of inputs){const info=inputInfo(ref,assets),line=element("span"),channel=element("span"),source=element("span"),frame=element("small");line.className="studio-graph-input";channel.className="studio-graph-channel";channel.textContent=`iChannel${i}`;source.className="studio-graph-source";source.textContent=info.source;frame.className="studio-graph-frame";frame.textContent=info.frame;line.append(channel,source,frame);row.append(line);}
        row.addEventListener("click",()=>select(entry.name));holder.append(row);
      }
    };
    // 새 이미지는 사용 중인 연결을 덮어쓰지 않고 첫 빈 채널에만 연결한다.
    const connectTexture = id => {
      rememberEditor();const channels=activeChannels(),slot=freeChannel();
      if(slot===undefined) {setStatus("빈 입력 채널이 없습니다. 기존 채널을 해제한 뒤 연결하세요.","is-error");return false;}
      channels[slot]={texture:id};renderChannels();renderGraph();schedule(); if(apply()){setStatus(`${inputInfo({texture:id},renderer.getTextures()).source} → ${selected}.iChannel${slot} 연결됨`);return true;}
      delete channels[slot];renderChannels();renderGraph();return false;
    }; const renderTextures = () => {
      const holder = $("studioTextureList"),assets=renderer.getTextures();textureButtons=[];holder.replaceChildren();if(!assets.length){const hint=element("p");hint.className="studio-hint";hint.textContent="등록된 이미지가 없습니다. PNG·JPEG·WebP 파일을 추가하고 입력 채널에 연결하세요.";holder.append(hint);}for(const asset of assets) {
        const row=element("div"),name=element("span"),del=element("button");
        row.className="studio-texture";name.textContent=`${asset.name} · ${asset.width}×${asset.height}`;
        del.type="button";del.className="glyph-icon icon-close";del.title=`${asset.name} 삭제`;del.setAttribute("aria-label",del.title);
        del.addEventListener("click",async()=>{
          if(!await ask({title:"이미지 삭제",message:`${asset.name} 이미지와 연결을 삭제할까요?`,ok:"삭제",danger:true}))return;
          rememberEditor();const before=copy(project); for(const pass of project.passes) for(const key of Object.keys(pass.channels))
          if(pass.channels[key].texture===asset.id)delete pass.channels[key];
          for(const key of Object.keys(project.imageChannels))
          if(project.imageChannels[key].texture===asset.id)delete project.imageChannels[key];
          if(!apply()){project=before;renderEditor();return;}
          try {await renderer.removeTexture(asset.id);renderTextures();renderChannels();renderGraph();} catch(error){showError(error);}
        }); const use=element("button");use.type="button";use.className="texture-connect";use.dataset.assetName=asset.name;textureButtons.push(use);
        use.addEventListener("click",()=>connectTexture(asset.id));
        const controls=element("div");controls.className="studio-sampling";
        for(const [key,title,values] of [
          ["filter","Filter",[["linear","Linear"],["nearest","Nearest"]]],
          ["wrapS","Wrap X",[["clamp","Clamp"],["repeat","Repeat"],["mirror","Mirror"]]],
          ["wrapT","Wrap Y",[["clamp","Clamp"],["repeat","Repeat"],["mirror","Mirror"]]]
        ]) {
          const label=element("label"),select=element("select");label.textContent=title;
          for(const [value,text] of values) {const option=element("option");option.value=value;option.textContent=text;select.append(option);}
          select.value=asset.sampling[key];select.title=`${asset.name}: ${title}`;
          select.addEventListener("change",async()=>{
            try {const result=await renderer.setTextureSampling(asset.id,{[key]:select.value});
              setStatus(result.saved ? "Texture 샘플링 적용·저장됨" : "샘플링 적용됨 · 브라우저 저장소 저장 실패");}
            catch(error) {select.value=renderer.getTextures().find(item=>item.id===asset.id)?.sampling[key] || asset.sampling[key];showError(error);}
          });label.append(select);controls.append(label);
        }
        row.append(name,use,del,controls);holder.append(row);
      }syncTextureTargets();
    }; const renderTabs = () => {
      const parent = $("studioPassTabs"); parent.replaceChildren(); for(const name of ["Image",...project.passes.map(p=>p.name)]) {
        const btn = element("button"); btn.type="button"; btn.setAttribute("role","tab");btn.id=`studioTab-${name}`;btn.setAttribute("aria-controls","studioCode");
        btn.classList.toggle("is-active",selected===name); btn.setAttribute("aria-selected",String(selected===name)); btn.tabIndex=selected===name?0:-1;
                btn.textContent = name === "Image" ? "Image" : `Buffer ${name}`; btn.title = `${name} 패스 편집 (Alt+PageUp/Down)`;
        btn.addEventListener("click",() => select(name));parent.append(btn);
      }
      for(const name of views.keys())if(name!=="Image"&&!find(name))views.delete(name);
      $("studioCode").setAttribute("aria-labelledby",`studioTab-${selected}`);$("studioAdd").disabled=project.passes.length>=8;
      const p = find(selected), idx = project.passes.findIndex(pass=>pass.name===selected);
      $("studioPassTools").hidden=!p;$("studioRemove").disabled = !p;$("studioDuplicate").disabled = !p || project.passes.length >= 8; $("studioUp").disabled = !p || idx === 0;
      $("studioDown").disabled = !p || idx === project.passes.length-1; for(const id of ["studioFormatField","studioScaleField","studioOutputsField","studioFilterField","studioWrapField","studioMipField"])$(id).hidden = !p;
      const refs=p?references(selected):[];$("studioPassImpact").hidden=!p;$("studioPassImpact").textContent=refs.length?`삭제 시 연결 ${refs.length}개 해제`:"다른 패스의 참조 없음";
      $("studioRemove").title=p?`${selected} 삭제${refs.length?` · 함께 해제: ${refs.join(", ")}`:""} · Undo로 복원`:"Image는 삭제할 수 없습니다.";
      $("studioInspect").disabled=!p;if(!p)$("studioInspect").checked=false;
      if(p) {
        $("studioFormat").value = p.format;
        // 해상도: 화면 비율(scale) 또는 고정 크기(size). 목록에 없는 고정 크기는 임시 선택지로 보여준다.
        const scaleSelect=$("studioScale"),sizeValue=p.size?`size:${p.size[0]}x${p.size[1]}`:String(p.scale);
        scaleSelect.querySelector("option[data-custom]")?.remove();
        if(![...scaleSelect.options].some(o=>o.value===sizeValue)){const option=element("option");option.dataset.custom="true";option.value=sizeValue;option.textContent=p.size?`${p.size[0]}×${p.size[1]}`:`${Math.round(p.scale*100)}%`;scaleSelect.append(option);}
        scaleSelect.value=sizeValue;$("studioOutputs").value=String(p.outputs||1);
        $("studioFilter").value=p.filter||(p.format==="rgba32f"?"nearest":"linear");$("studioWrap").value=p.wrap||"clamp";$("studioMip").checked=!!p.mipmap;
      }
      $("studioCodeTitle").textContent = selected === "Image" ? "Image.frag" : `Buffer ${selected}.frag`;
      // 버퍼 설정은 접힌 한 줄 요약으로 보여준다: "A · RGBA8 · 100% · Linear · Clamp"
      if(p) {
        const size = p.size ? `${p.size[0]}×${p.size[1]}` : `${Math.round(p.scale*100)}%`, filter = p.filter || (p.format === "rgba32f" ? "nearest" : "linear");
        const parts = [p.format.toUpperCase(), size, filter === "nearest" ? "Nearest" : "Linear", {clamp:"Clamp",repeat:"Repeat",mirror:"Mirror"}[p.wrap || "clamp"]];
        if((p.outputs || 1) > 1) parts.push(`출력 ${p.outputs}개`); if(p.mipmap) parts.push("밉맵");
        $("studioPassSummary").textContent = `${selected} · ${parts.join(" · ")}`;
      }
    };
    const renderEditor = () => { renderTabs(); renderChannels(); const area=$("studioCode"),source=activeSource()||"",view=views.get(selected);area.value=source;
      const caret=view?.source===source?view.caret:[0,0,"none"],scroll=view?.source===source?view.scroll:[0,0];area.setSelectionRange(caret[0],caret[1],caret[2]);area.scrollTop=scroll[0];area.scrollLeft=scroll[1];syncDiagnostics();editor.update();renderGraph(); };
    const select = name => {
      if(name !== "Image" && !find(name)) return; if(name === selected) return; rememberEditor();views.set(selected,{source:activeSource(),...cursorState()}); selected = name; renderEditor(); checkpoint.selected=selected;preview();
    }; const normalizeDependencies = () => {
      const changed=[];for(const p of project.passes) for(const [channel,ref] of Object.entries(p.channels)) {
        if(ref.frame === "current" && !validCurrent(p.name,ref.buffer)){changed.push(`${p.name}.iChannel${channel} ← ${ref.buffer}`);p.channels[channel] = {...ref,frame:"previous"};}
      }return changed;
    }; const add = () => {
      rememberEditor(); const names = new Set(project.passes.map(p=>p.name));
      if(project.passes.length >= 8) return showError("Buffer는 최대 8개까지 추가할 수 있습니다."); const name = [..."ABCDEFGH"].find(n=>!names.has(n));
      project.passes.push({name,fragment:blank,format:"rgba8",scale:1,channels:{}}); selected = name;renderEditor();schedule();apply();
    }; const duplicate = () => {
      const source=find(selected); if(!source || project.passes.length>=8)return;
      rememberEditor();const names=new Set(project.passes.map(p=>p.name));
      const name=[..."ABCDEFGH"].find(n=>!names.has(n)); if(!name)return showError("사용 가능한 Buffer 이름이 없습니다.");
      const item=copy(source);item.name=name;
      for(const ref of Object.values(item.channels)) if(ref.buffer===source.name&&ref.frame==="previous")ref.buffer=name;
      project.passes.splice(project.passes.indexOf(source)+1,0,item); selected=name;renderEditor();schedule();apply();
    }; const remove = () => {
      if(selected === "Image") return;rememberEditor();const name = selected,refs=references(name); project.passes = project.passes.filter(p=>p.name!==name);
      for(const p of project.passes) for(const key of Object.keys(p.channels)) if(p.channels[key].buffer===name) delete p.channels[key];
      for(const key of Object.keys(project.imageChannels)) if(project.imageChannels[key].buffer===name) delete project.imageChannels[key];
      selected = "Image";renderEditor();schedule();apply();showChange(`${name} 삭제${refs.length?` · 해제된 연결 ${refs.length}개: ${refs.join(", ")}`:" · 다른 패스의 연결 변경 없음"}`);
    }; const move = dir => {
      const idx = project.passes.findIndex(p=>p.name===selected), next=idx+dir; if(idx<0||next<0||next>=project.passes.length) return;
      rememberEditor();[project.passes[idx],project.passes[next]]=[project.passes[next],project.passes[idx]];
      const changed=normalizeDependencies();renderEditor();schedule();apply();showChange(changed.length?`실행 순서 변경 · current → previous: ${changed.join(", ")}`:"실행 순서 변경 · 채널의 프레임 참조 변경 없음");
    }; const setProject = next => {
      if(disposed)return false;clearChange();const before = project, previousSelected = selected; try {
        project = validateProject(next); selected="Image";renderEditor();
        if(!apply()) { project=before; selected=previousSelected; renderEditor(); return false; }
        recordEdit();return true;
      } catch(error) { project=before; selected=previousSelected;renderEditor();showError(error); return false; }
    }; const historyMove = backwards => {
      const from=backwards?undoStack:redoStack,to=backwards?redoStack:undoStack;if(!from.length)return false;clearChange();
      if(timer)clearTimeout(timer);timer=null;const target=from.pop(),current=historyState();to.push(current);if(to.length>25)to.shift();
      navigatingHistory=true;project=copy(target.project);selected=target.selected;renderEditor();
      const area=$("studioCode"),a=target.caret||[0,0],scroll=target.scroll||[0,0];area.focus({preventScroll:true});
      area.setSelectionRange(Math.min(a[0],area.value.length),Math.min(a[1],area.value.length),a[2]||"none");
      area.scrollTop=scroll[0];area.scrollLeft=scroll[1];editor.update();
      const applied=apply(target.users);if(applied&&!same(current.users,target.users))document.dispatchEvent(new Event("shader-settings-applied"));navigatingHistory=false;checkpoint=historyState();editTime=0;syncHistory();return true;
    }; const confirmReplace = () => !dirty || ask({title:"미적용 변경사항",message:"아직 실행하지 않은 GLSL 수정 내용이 있습니다. 계속하면 변경사항을 잃을 수 있어요.",ok:"계속",danger:true});
    const adoptProject = (next,tab="Image") => {
      clearChange();views.clear();project=copy(next);selected=tab==="Image"||find(tab)?tab:"Image";dirty=false;clearError();clearDraft();
      renderEditor();recordEdit(false,true);Object.assign(checkpoint,{selected,...cursorState()});preview();saveLocal();
    };
    const replaceProject = (next,users=[]) => {
      try {rememberEditor();checkpoint=historyState();renderer.applyPortable(next,users);adoptProject(next);
        // 예제 소스의 @어노테이션도 바로 파라미터로 등록한다(apply 경로를 거치지 않으므로 여기서 동기화).
        syncAnnotations();const count=renderer.getUserUniforms().length;
        settings?.save(true);document.dispatchEvent(new Event("shader-settings-applied"));setStatus(`새 프로젝트 시작 · 파라미터 ${count}개 · Undo로 이전 작업 복원`);return true;
      } catch(error){showError(error);return false;}
    };
    const startProject = (next,users=[]) => proceed(confirmReplace(),()=>replaceProject(next,users));
    const exampleRaymarch = () => startProject({image:Shader.raymarch,passes:[],imageChannels:{}},
      Shader.rayUniforms.map(([name,type,value,options])=>({name,type,value,options:options||{}})));
    const examplePipeline = () => startProject({image:comparison,passes:[
      {name:"A",fragment:movingDot,format:"rgba8",scale:1,channels:{}},
      {name:"B",fragment:colorFilter,format:"rgba8",scale:1,channels:{0:{buffer:"A",frame:"current"}}}
    ],imageChannels:{0:{buffer:"B",frame:"current"},1:{buffer:"A",frame:"current"}}});
    const exampleFeedback = () => startProject({image:comparison,passes:[
      {name:"A",fragment:movingDot,format:"rgba8",scale:1,channels:{}},
      {name:"B",fragment:feedback,format:"rgba8",scale:1,channels:{0:{buffer:"A",frame:"current"},1:{buffer:"B",frame:"previous"}}}
    ],imageChannels:{0:{buffer:"B",frame:"current"},1:{buffer:"A",frame:"current"}}}); const loadFromRenderer = () => proceed(confirmReplace(),()=>{
      project = snapshot();selected = "Image";renderEditor();recordEdit();clearError();dirty=false;clearDraft();
      setStatus("렌더러의 현재 버퍼 구성을 불러왔습니다.");saveLocal();return true;
    }); const open = () => {
      openState = true; $("studioDock").hidden = false; $("studioResize").hidden = expanded;
      $("studioToggle").setAttribute("aria-label","셰이더 편집기 닫기");$("studioToggle").setAttribute("aria-expanded","true");
      if(window.matchMedia("(max-width:820px)").matches) {document.body.classList.add("panel-hidden");document.dispatchEvent(new Event("shader-panel-changed"));}$("studioCode").focus({preventScroll:true});
    }; // 재생 버튼은 아이콘(정지 중이면 ▶)과 접근 가능한 이름으로 상태를 알린다. 집중 모드에서는 복귀 후 재생 여부를 고른다.
    const syncPauseButton = () => {
      const button=$("studioPause"), playing=expanded?resumeAfterMaximize:renderer.getStats().running;
      const label=expanded?(resumeAfterMaximize?"복귀 시 재생":"복귀 시 정지"):playing?"일시정지":"재생";
      button.setAttribute("aria-pressed",String(!playing));button.setAttribute("aria-label",label);button.title=`${label} · 뷰포트에서는 Space`;
    }; const maximize = () => {
      if(!expanded) {
        resumeAfterMaximize=renderer.getStats().running; if(resumeAfterMaximize) renderer.stop();
      } else if(resumeAfterMaximize) renderer.start(); expanded=!expanded;$("stage").classList.toggle("studio-maximized",expanded);
      $("studioResize").hidden=expanded;$("studioMaximize").setAttribute("aria-pressed",String(expanded));
      syncPauseButton();
    }; const close = () => {if(expanded)maximize();openState=false;$("studioDock").hidden=true;
      $("studioResize").hidden=true;$("stage").classList.remove("studio-maximized"); $("studioToggle").setAttribute("aria-label","셰이더 편집기 열기");$("studioToggle").setAttribute("aria-expanded","false");$("studioToggle").focus();};
    const responsiveHeight = () => window.matchMedia("(max-width:600px), (max-height:650px)").matches?75:55;
    const setDockHeight = (value, persist = true) => {dockHeight=Math.max(25,Math.min(85,value));$("studioDock").style.setProperty("--studio-height",`${dockHeight}%`);
      if(layout==="bottom")$("studioResize").setAttribute("aria-valuenow",String(Math.round(dockHeight)));
      if(persist){heightChosen=true;try{localStorage.setItem("webgl.shader-studio.height.v2",String(dockHeight));}catch (_){}} };
    // 두 번 클릭 복원: 저장한 높이를 지우고 다시 창 크기 기본값을 따른다.
    const resetDockHeight = () => {heightChosen=false;try{localStorage.removeItem("webgl.shader-studio.height.v2");}catch (_){}setDockHeight(responsiveHeight(),false);};
    // 편집기 배치: right(캔버스 옆 분할) 또는 bottom(캔버스 아래). 넓은 화면은 right가 기본이다.
    // 넓은 화면, 또는 4분할 창처럼 가로로 길고 낮은 창은 아래 배치가 미리보기와 코드를 모두 납작하게 만드므로 옆 배치가 기본이다.
    const fitLayout = () => {const w=window.innerWidth||0,h=window.innerHeight||0;return w>=1200||(w>=900&&h>0&&w>=h*1.6)?"right":"bottom";};
    const LAYOUT_KEY="webgl.shader-studio.layout.v1";let layout=fitLayout(),dockWidth=46;
    try{const saved=JSON.parse(localStorage.getItem(LAYOUT_KEY)||"{}");if(["right","bottom"].includes(saved.layout)){layout=saved.layout;layoutChosen=true;}if(Number.isFinite(saved.width))dockWidth=Math.max(30,Math.min(75,saved.width));}catch(_){}
    const saveLayout=()=>{layoutChosen=true;try{localStorage.setItem(LAYOUT_KEY,JSON.stringify({layout,width:dockWidth}));}catch(_){}};
    const setDockWidth = (value, persist = true) => {dockWidth=Math.max(30,Math.min(75,value));$("stage").style.setProperty("--studio-width",`${dockWidth}%`);
      if(layout==="right")$("studioResize").setAttribute("aria-valuenow",String(Math.round(dockWidth)));if(persist)saveLayout();};
    const applyLayout = () => {
      const right=layout==="right";$("stage").classList.toggle("studio-layout-right",right);
      const handle=$("studioResize");handle.setAttribute("aria-orientation",right?"vertical":"horizontal");
      handle.setAttribute("aria-valuemin",right?"30":"25");handle.setAttribute("aria-valuemax",right?"75":"85");
      handle.setAttribute("aria-valuenow",String(Math.round(right?dockWidth:dockHeight)));
      handle.title=right?"드래그 또는 ←→로 너비 조절 · 두 번 클릭해 기본 너비 복원":"드래그 또는 ↑↓로 높이 조절 · Home/End · 두 번 클릭해 기본 높이 복원";
      $("studioLayout").setAttribute("aria-pressed",String(right));$("studioLayout").title=right?"편집기를 캔버스 아래로 배치":"편집기를 캔버스 오른쪽에 나란히 배치";
      $("studioLayout").textContent=right?"편집기를 아래에 배치":"편집기를 오른쪽에 배치";
      editor.update();
    };
    const toggleLayout = () => {layout=layout==="right"?"bottom":"right";saveLayout();applyLayout();};
    // 좁은 화면(≤820px)에서는 CSS가 아래 배치로 되돌리므로 리사이저도 세로 방향으로 동작한다.
    const splitRight = () => layout==="right" && !window.matchMedia("(max-width:820px)").matches;
    const toggle = () => openState ? close() : open(); const inspectPixel = event => {
      if(!$("studioInspect").checked) return; const output=$("studioPixelReadout");
      if(selected==="Image") {output.textContent="먼저 Buffer A/B 패스를 선택하세요. Image는 기본 Canvas 출력입니다.";return;}
      const pass=renderer.getPasses().find(p=>p.name===selected), canvas=$("screen");
      if(!pass?.width || !pass?.height) {output.textContent="이 버퍼는 아직 렌더링되지 않았습니다.";return;}
      const rect=canvas.getBoundingClientRect();
      const x=Math.max(0,Math.min(pass.width-1,Math.floor((event.clientX-rect.left)/rect.width*pass.width)));
      const y=Math.max(0,Math.min(pass.height-1,Math.floor((rect.bottom-event.clientY)/rect.height*pass.height)));
      try {const values=renderer.readPassPixel(selected,x,y);
        output.textContent=`${selected} (${x}, ${y}) · ${pass.format.toUpperCase()}\nRGBA: ${values.map(n=>Number(n).toPrecision(5)).join(", ")}`;
      }catch(error){output.textContent=error.message;}
    }; const download = (name,text,type,limit=Infinity) => {
      const blob=new Blob([text],{type});if(blob.size>limit)throw new Error(`내보내기 파일은 최대 ${limit/1048576}MiB입니다.`);
      const url=URL.createObjectURL(blob),link=element("a");
      link.href=url;link.download=name;document.body.append(link);link.click();link.remove();$("studioExportState").textContent=`최근 내보내기 요청 · ${name}`;
      setTimeout(()=>URL.revokeObjectURL(url),3000);
    }; const exportJSON = () => {
      try {rememberEditor();download("shader-studio-project.json",JSON.stringify({version:1,project},null,2),"application/json",JSON_LIMIT);
        setStatus("소스 JSON 내보냄 · 파라미터·이미지 원본은 포함되지 않습니다.");}catch(error){showError(error);}
    };
    // Pack은 연결된 이미지의 원본과 샘플링 설정까지 포함한다. 기존 JSON은 경량 형식으로 유지한다.
    const runFile = async (button,message,action) => {if(button.disabled)return;const label=button.textContent;button.disabled=true;button.textContent=message;button.setAttribute("aria-busy","true");
      try {await action();}catch(error){showError(error);}finally{button.disabled=false;button.textContent=label;button.removeAttribute("aria-busy");}};
    const readData = file => new Promise((resolve,reject)=>{
      const reader=new FileReader();reader.onload=()=>resolve(reader.result);
      reader.onerror=()=>reject(reader.error || new Error("이미지를 읽을 수 없습니다."));reader.readAsDataURL(file);
    });
    const getChannels = config => [...config.passes.map(pass=>pass.channels),config.imageChannels];
    const exportPack = async () => {
      rememberEditor();const scene=copy(project), tab=selected, state=settings?.snapshot(), ids=new Set();
      for(const channels of getChannels(scene))for(const ref of Object.values(channels))if(ref.texture)ids.add(ref.texture);
      const assets=renderer.getTextures(), textures=[];let bytes=0;
      const files=[...ids].map(id=>{
        const meta=assets.find(item=>item.id===id),file=renderer.getTextureFile(id);
        if(!meta || !file)throw new Error(`원본 이미지가 없습니다: ${id}`);
        bytes+=file.size;if(bytes>32*1024*1024)throw new Error("연결된 이미지 합계는 최대 32MB입니다.");
        return {id,meta,file};
      });
      for(const {id,meta,file} of files)textures.push({id,name:meta.name,type:file.type,data:await readData(file),sampling:meta.sampling});
      if(disposed)return;
      download("shader-studio-pack.json",JSON.stringify({version:state?3:2,project:scene,selected:tab,textures,...(state?{settings:state}:{})}),"application/json",PACK_LIMIT);
      setStatus(`Pack 내보냄 · 코드·파라미터·설정·이미지 ${textures.length}개 포함`);
    };
    let loadSerial=0;
    const beginLoad = (full=false) => {
      const serial=++loadSerial, draft=copy(project), tab=selected, gpu=full?snapshot():null, state=full?settings?.snapshot():null;
      return () => {if(disposed || serial!==loadSerial || tab!==selected || !same(project,draft) || (full && (!same(snapshot(),gpu) || !same(settings?.snapshot(),state))))
        throw new Error("작업이 변경되었거나 종료되어 파일 불러오기를 취소했습니다.");};
    };
    const importPack = async file => {
      const check=beginLoad(true);
      if(file.size>PACK_LIMIT)throw new Error("Pack 파일은 최대 64MiB입니다.");
      const text=await file.text();check();const data=JSON.parse(text),next=validateProject(data.project);
      if(![2,3].includes(data.version) || !Array.isArray(data.textures) || data.textures.length>36)throw new Error("지원하지 않는 Pack 형식입니다.");
      const state=data.version===3 ? settings?.validatePack(data.settings) : null;
      if(data.version===3 && !state)throw new Error("설정 복원 API를 사용할 수 없습니다.");
      const ids=new Set(),decoded=[];let total=0;
      for(const asset of data.textures) {
        if(!asset || typeof asset.id!=="string" || !/^[A-Za-z][\w-]{0,31}$/.test(asset.id) || ids.has(asset.id)
          || typeof asset.name!=="string" || asset.name.length>128 || !["image/png","image/jpeg","image/webp"].includes(asset.type)
          || typeof asset.data!=="string" || !asset.data.startsWith(`data:${asset.type};base64,`))throw new Error("Pack 이미지 정보가 올바르지 않습니다.");
        ids.add(asset.id);const body=asset.data.slice(asset.data.indexOf(",")+1);
        if(body.length>16*1024*1024+8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body))throw new Error("Pack 이미지 데이터가 올바르지 않습니다.");
        const binary=atob(body);total+=binary.length;
        if(binary.length>12*1024*1024 || total>32*1024*1024)throw new Error("Pack 이미지 크기 제한을 초과했습니다.");
        const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
        const source=new File([bytes],asset.name,{type:asset.type});
        decoded.push({id:asset.id,file:source,sampling:asset.sampling});
      }
      for(const channels of getChannels(next))for(const ref of Object.values(channels))
        if(ref.texture && !ids.has(ref.texture))throw new Error(`Pack에 연결된 이미지가 없습니다: ${ref.texture}`);
      if(state) { // Pack의 이미지 ID는 등록 전에는 존재하지 않으므로 사전 검사에서만 이미지 참조를 제외한다.
        const trial=copy(next);for(const channels of getChannels(trial))for(const key of Object.keys(channels))
          if(channels[key].texture)delete channels[key];
        renderer.validatePortable(trial,state.user);
      } else {renderer.validateFragment(next.image);for(const pass of next.passes)renderer.validateFragment(pass.fragment,true);}
      if(!await confirmReplace())return false;check();
      const added=[],map=new Map(),draftBefore=copy(project),wasDirty=dirty;let unsaved=0,applied=false,previous=snapshot(),before=settings?.snapshot(),beforeTab=selected;
      try {
        for(const asset of decoded) {
          const result=await renderer.addTexture(asset.file,asset.sampling || {});added.push(result.id);check();map.set(asset.id,result.id);
          if(!result.saved)unsaved++;
        }
        for(const channels of getChannels(next))for(const ref of Object.values(channels))
          if(ref.texture)ref.texture=map.get(ref.texture);
        if(state) {
          checkpoint=historyState();renderer.applyPortable(next,state.user);applied=true;settings.applyPack(state);
        } else if(!setProject(next))throw new Error("Pack 셰이더를 적용하지 못했습니다.");
        adoptProject(next,data.selected);renderTextures();
        setStatus(`Pack 복원 완료 · 이미지 ${added.length}개${unsaved?" · 일부 이미지 로컬 저장 불가":""}`);
        return true;
      } catch(error) {
        if(applied) {
          try {renderer.applyPortable(previous,before.user);settings.applyPack(before);project=draftBefore;dirty=wasDirty;selected=beforeTab;renderEditor();if(dirty)scheduleDraft();}
          catch(rollback) {console.error("Pack 복원 실패 후 롤백 오류:",rollback);}
        }
        for(const id of added.reverse())try {await renderer.removeTexture(id);}catch(cleanup){console.warn("Pack 임시 이미지 정리 실패:",cleanup);}
        if(!disposed){renderTextures();renderChannels();}throw error;
      }
    };
    // 프로젝트 JSON은 이미지 파일 본문을 담지 않으므로 존재하지 않는 연결은 제거한다.
    const detachMissing = next => {
      const available=new Set(renderer.getTextures().map(asset=>asset.id));let count=0;
      for(const channels of [...next.passes.map(p=>p.channels),next.imageChannels])
      for(const key of Object.keys(channels)) if(channels[key].texture && !available.has(channels[key].texture)){delete channels[key];count++;}
      return count;
    };
    // 성공적으로 컴파일된 프로젝트를 자동 복원하고, 실패한 저장값은 실행하지 않는다.
    const restore = () => {
      try {
        const raw=localStorage.getItem(STORAGE_KEY);if(!raw) return; const data=JSON.parse(raw);
        if(data.version!==1) throw new Error("저장된 프로젝트 버전이 다릅니다.");
        const next=validateProject(data.project), before=copy(project); const detached=detachMissing(next);
        project=next;selected="Image";renderEditor();
        if(!apply()) { project=before;selected="Image";renderEditor();setStatus("저장 프로젝트 실행 실패 · 기본 장면 유지","is-error"); }
        else { selected=data.selected==="Image"||find(data.selected)?data.selected:"Image";renderEditor();preview();
          if(detached) setStatus(`${detached}개 이미지 연결이 해제됐습니다. 파일을 다시 불러오세요.`,"is-dirty"); }
      } catch(error) { showError(error); }
    }; const loadDraft = raw => {try {
        if(!raw)return;const data=JSON.parse(raw);if(data.version!==1)return;
        validateProject(data.project);if(same(data.project,project))return; $("studioDraft").hidden=false;
      // 초기화 과정에서 apply()가 draft 키를 지웠더라도 선택 전까지 복구 가능해야 한다.
        try{localStorage.setItem(DRAFT_KEY,raw);}catch(_){}
        on($("studioDraftRestore"),"click",()=>{project=copy(data.project);
          selected=data.selected==="Image"||find(data.selected)?data.selected:"Image";
          renderEditor();recordEdit();dirty=true;$("studioDraft").hidden=true;scheduleDraft(); setStatus("미적용 편집본 복원됨 · Run으로 컴파일", "is-dirty");});
        on($("studioDraftDiscard"),"click",clearDraft);
      }catch(error){console.warn("임시 저장본 검증 실패:",error);}}; renderTextures();
    const savedDraft = (()=>{try{return localStorage.getItem(DRAFT_KEY);}catch(_){return null;}})(); const loadImage = async file => {
      const check=beginLoad(),result=await renderer.addTexture(file);if(disposed)return;renderTextures();
      try {check();}catch(error){setStatus(`${file.name} 추가됨 · 작업 변경으로 자동 채널 연결을 취소했습니다.`);return;}
      const connected=connectTexture(result.id);renderChannels();
      if(connected&&!result.saved)setStatus(`${$("studioMessage").textContent} · 로컬 저장 불가`);
      else if(!result.saved) setStatus(`이미지 추가됨 · 로컬 저장 불가: ${result.error}`);
    }; const loadGLSL = async file => {
      if(!/\.(frag|glsl|fs)$/i.test(file.name) || file.size>1048576) throw new Error("1MiB 이하의 .frag/.glsl/.fs 파일만 지원합니다.");
      const check=beginLoad();if(!await confirmReplace()) return;check();const code=(await file.text()).replace(/^\uFEFF/,"");check();
      if(code.length>262144 || !code.startsWith("#version 300 es")) throw new Error("262144자 이하의 GLSL ES 3.00 소스가 필요합니다.");
      $("studioCode").value=code;editor.update();rememberEditor();schedule();open();
      setStatus(`${file.name} 불러옴 · Run으로 적용`,"is-dirty");
    }; const saveGLSL = () => download(`${selected}.frag`,$("studioCode").value,"text/plain;charset=utf-8"); const insertSample = text => {
      const area=$("studioCode");area.focus();area.setRangeText(text,area.selectionStart,area.selectionEnd,"end");
      area.dispatchEvent(new Event("input",{bubbles:true}));
    }; on($("studioOpenGLSL"),"click",()=>$("studioGLSLFile").click()); on($("studioSaveGLSL"),"click",()=>{try{saveGLSL();setStatus(`${selected}.frag 내보냄 · 현재 패스 코드만 포함`);}catch(error){showError(error);}});
    on($("studioGLSLFile"),"change",async event=>{
      const file=event.target.files?.[0];event.target.value=""; if(file)await runFile($("studioOpenGLSL"),"GLSL 읽는 중…",()=>loadGLSL(file));
    }); on($("studioSampleUV"),"click",()=>insertSample("texture(iChannel0, gl_FragCoord.xy / uResolution)"));
    on($("studioSamplePixel"),"click",()=>insertSample("texelFetch(iChannel0, ivec2(gl_FragCoord.xy), 0)"));
    // 로컬 파일만 가로채며, 코드 선택 영역의 일반적인 드래그는 유지한다.
    on($("studioDock"),"dragover",event=>{if(event.dataTransfer?.types.includes("Files"))event.preventDefault();});
    on($("studioDock"),"drop",async event=>{
      if(!event.dataTransfer?.files.length)return;event.preventDefault(); const file=event.dataTransfer.files[0];
      try {if(file.type.startsWith("image/"))await loadImage(file);else await loadGLSL(file);} catch(error){showError(error);}
    }); on($("studioTextureAdd"),"click",()=>$("studioTextureFile").click()); on($("studioTextureFile"),"change",async event=>{
      const file=event.target.files?.[0];event.target.value="";if(!file)return;
      await runFile($("studioTextureAdd"),"이미지 읽는 중…",()=>loadImage(file));
    }); on($("studioCode"),"input",event=>{ rememberEditor();schedule((event.inputType==="insertText" && event.data?.length===1) || /^(deleteContent|insertCompositionText|insertReplacementText)/.test(event.inputType||"")); }); on($("studioCode"),"keydown",event=>{
      if(event.isComposing)return;
      if((event.ctrlKey||event.metaKey) && !event.altKey && (event.key.toLowerCase()==="z" || event.key.toLowerCase()==="y")) {
        event.preventDefault();historyMove(event.key.toLowerCase()==="z"&&!event.shiftKey);
      } else if(event.altKey && ["PageUp","PageDown"].includes(event.key)) {
        event.preventDefault();const tabs=["Image",...project.passes.map(p=>p.name)],index=tabs.indexOf(selected);
        select(tabs[(index+(event.key==="PageDown"?1:-1)+tabs.length)%tabs.length]);$("studioCode").focus();
      } else if((event.key==="Enter" || event.key.toLowerCase()==="s")&&(event.ctrlKey||event.metaKey)) {
        event.preventDefault();rememberEditor();apply();
      }
    }); on($("studioRun"),"click",()=>{rememberEditor();apply();});
    on($("studioChangeUndo"),"click",()=>historyMove(true));on($("studioUndo"),"click",()=>historyMove(true));on($("studioRedo"),"click",()=>historyMove(false));
    on($("studioPassTabs"),"keydown",event=>{
      if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      const tabs=[...$("studioPassTabs").querySelectorAll("button")],index=tabs.indexOf(document.activeElement);
      if(index<0)return;event.preventDefault();
      const next=event.key==="Home"?0:event.key==="End"?tabs.length-1:
        (index+(event.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;
      select(next===0?"Image":project.passes[next-1].name);$("studioPassTabs").children[next].focus();
    }); on($("studioAdd"),"click",add);on($("studioDuplicate"),"click",duplicate);on($("studioRemove"),"click",remove);
    on($("studioUp"),"click",()=>move(-1));on($("studioDown"),"click",()=>move(1));
    // 기본값과 같은 선택 항목은 프로젝트에서 지워 기존 JSON 모양을 유지한다.
    const setPassOption=(key,value,fallback)=>{const p=find(selected);if(!p)return;if(value===fallback)delete p[key];else p[key]=value;};
    on($("studioFormat"),"change",event=>{const p=find(selected);p.format=event.target.value;if(p.filter===(p.format==="rgba32f"?"nearest":"linear"))delete p.filter;schedule();apply();});
    on($("studioScale"),"change",event=>{const p=find(selected),value=event.target.value,size=/^size:(\d+)x(\d+)$/.exec(value);
      if(size){p.size=[Number(size[1]),Number(size[2])];p.scale=1;}else{delete p.size;p.scale=Number(value);}schedule();apply();});
    on($("studioOutputs"),"change",event=>{const p=find(selected),outputs=Number(event.target.value);setPassOption("outputs",outputs,1);
      // 줄어든 출력을 읽던 채널 연결은 0번 출력으로 되돌린다.
      const fixed=[];for(const entry of [...project.passes,{name:"Image",channels:project.imageChannels}])for(const [key,ref] of Object.entries(entry.channels))
        if(ref.buffer===p.name&&ref.attachment>=outputs){delete ref.attachment;fixed.push(`${entry.name}.iChannel${key}`);}
      renderChannels();renderGraph();schedule();apply();if(fixed.length)showChange(`출력 수 변경 · 0번 출력으로 되돌린 연결: ${fixed.join(", ")}`);});
    on($("studioFilter"),"change",event=>{const p=find(selected);setPassOption("filter",event.target.value,p.format==="rgba32f"?"nearest":"linear");schedule();apply();});
    on($("studioWrap"),"change",event=>{setPassOption("wrap",event.target.value,"clamp");schedule();apply();});
    on($("studioMip"),"change",event=>{setPassOption("mipmap",event.target.checked,false);schedule();apply();});
    on($("studioLive"),"change",()=>{if(!$("studioLive").checked && timer) {clearTimeout(timer);timer=null;} else if(dirty) schedule();});
    on($("studioExampleRaymarch"),"click",exampleRaymarch);on($("studioExampleFeedback"),"click",exampleFeedback);on($("studioExamplePipeline"),"click",examplePipeline);
    on($("studioReset"),"click",()=>proceed(confirmReplace(),()=>ask({title:"장면 초기화",message:"모든 편집 패스와 Custom Uniform을 초기화하고 기본 셰이더 아트 화면으로 돌아갈까요?",ok:"초기화",danger:true}).then(ok=>ok&&replaceProject({image:original,passes:[],imageChannels:{}}))));
    on($("studioExport"),"click",exportJSON); on($("studioImport"),"click",()=>$("studioImportFile").click());
    on($("studioImportFile"),"change",async event=>{
      const file=event.target.files?.[0];if(!file)return;
      try {if(file.size>JSON_LIMIT)throw new Error("JSON 파일은 16MiB 이하여야 합니다.");
        const check=beginLoad(),text=await file.text();check();const data=JSON.parse(text);if(data.version!==1)throw new Error("지원하지 않는 프로젝트 형식입니다.");
        if(await confirmReplace()) {check();const next=validateProject(data.project),count=detachMissing(next);
          if(setProject(next)&&count)setStatus(`${count}개 이미지 연결이 해제됐습니다. 원본 이미지를 다시 가져오세요.`,"is-dirty");} }
      catch(error) { showError(error); }finally {event.target.value="";}
    }); on($("studioExportPack"),"click",event=>runFile(event.currentTarget,"Pack 준비 중…",exportPack));on($("studioImportPack"),"click",()=>$("studioPackFile").click());
    on($("studioPackFile"),"change",async event=>{
      const file=event.target.files?.[0];event.target.value="";if(!file)return;
      await runFile($("studioImportPack"),"Pack 읽는 중…",()=>importPack(file));
    }); on($("studioErrorToggle"),"click",()=>{$("studioError").hidden=!$("studioError").hidden;});
    on($("studioToggle"),"click",toggle);on($("studioHide"),"click",close); on($("studioOpenFromPanel"),"click",open);
    on($("studioMaximize"),"click",maximize); on($("screen"),"click",inspectPixel); on($("studioPause"),"click",()=>togglePlayback()); on($("studioResetFrames"),"click",()=>{renderer.resetSimulation();setStatus("버퍼와 시뮬레이션 시간이 초기화됐습니다.");});
    const getPlaybackState = () => expanded?resumeAfterMaximize:renderer.getStats().running;
    const togglePlayback = () => {if(expanded)resumeAfterMaximize=!resumeAfterMaximize;else if(renderer.getStats().running)renderer.stop();else renderer.start();
      syncPauseButton();return getPlaybackState();};
    on($("studioToolsToggle"),"click",()=>{const hidden=$("studioTools").hidden=!$("studioTools").hidden;$("studioToolsToggle").setAttribute("aria-expanded",String(!hidden));saveWorkspace();});
    const resizer=$("studioResize");let sizing=false;
    on(resizer,"pointerdown",e=>{if(e.button!==0)return;sizing=true;resizer.setPointerCapture(e.pointerId);e.preventDefault();});
    on(resizer,"pointermove",e=>{if(!sizing)return;const rect=$("stage").getBoundingClientRect();
      if(splitRight()){if(rect.width>0)setDockWidth((rect.right-e.clientX)/rect.width*100);}
      else if(rect.height>0)setDockHeight((rect.bottom-e.clientY)/rect.height*100);});
    on(resizer,"pointerup",()=>{sizing=false;});on(resizer,"pointercancel",()=>{sizing=false;});on(resizer,"lostpointercapture",()=>{sizing=false;});on(resizer,"dblclick",()=>splitRight()?setDockWidth(46):resetDockHeight());
    on(resizer,"keydown",e=>{
      if(splitRight()){if(["ArrowLeft","ArrowRight","Home","End"].includes(e.key)){e.preventDefault();setDockWidth(e.key==="Home"?30:e.key==="End"?75:dockWidth+(e.key==="ArrowLeft"?3:-3));}return;}
      if(["ArrowUp","ArrowDown","Home","End"].includes(e.key)) {e.preventDefault();setDockHeight(e.key==="Home"?25:e.key==="End"?85:dockHeight+(e.key==="ArrowUp"?3:-3));}});
    on($("studioLayout"),"click",toggleLayout);
    // 편집기 메뉴(⋯): 항목을 고르거나, 바깥을 누르거나, Esc를 누르면 닫는다. 글자 크기·들여쓰기 같은 값 조절은 열어 둔다.
    const menu=$("studioCodeTools");
    on(menu,"click",event=>{if(event.target?.closest?.(".studio-menu-panel>button"))menu.open=false;});
    on(document,"pointerdown",event=>{if(menu.open&&!menu.contains?.(event.target))menu.open=false;});
    // 편집기를 아래에 작게 배치하면 메뉴가 #stage(overflow:hidden) 밖으로 나가 잘린다.
    // 열 때 아래·위 여유 공간을 재서 더 넓은 쪽으로 펼치고, 그 공간에 맞게 높이를 제한한다(넘치면 메뉴 안에서 스크롤).
    const placeMenu=()=>{
      const panel=menu.querySelector?.(".studio-menu-panel"),summary=menu.querySelector?.("summary");if(!menu.open||!panel?.style||!summary?.getBoundingClientRect)return;
      panel.classList.remove("is-up");panel.style.maxHeight="";
      const clip=$("stage")?.getBoundingClientRect?.(),view=window.innerHeight||document.documentElement?.clientHeight||0,gap=6,margin=8;
      const limitTop=Math.max(0,clip?.top??0)+margin,limitBottom=Math.min(view,clip?.bottom??view)-margin,anchor=summary.getBoundingClientRect();
      const below=limitBottom-(anchor.bottom+gap),above=(anchor.top-gap)-limitTop,natural=panel.scrollHeight||0;
      const up=below<natural&&above>below;panel.classList.toggle("is-up",up);
      panel.style.maxHeight=`${Math.max(120,Math.floor(Math.min(540,up?above:below)))}px`;
    };
    on(menu,"toggle",placeMenu);on(window,"resize",placeMenu);
    on(menu,"keydown",event=>{if(event.key==="Escape"&&menu.open){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector?.("summary")?.focus();}});
    // 분할 배치에서 도구 서랍은 코드 위에 겹치므로, 코드를 누르면 닫아 편집 영역을 돌려준다.
    const closeToolsDrawer=()=>{if(!$("studioTools").hidden){$("studioTools").hidden=true;$("studioToolsToggle").setAttribute("aria-expanded","false");}};
    on($("studioCode"),"pointerdown",()=>{if(splitRight())closeToolsDrawer();});
    on(document,"keydown",event=>{
      if(event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.isComposing) return;
      if(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) return;
      if(event.key.toLowerCase()==="e") {event.preventDefault();toggle();}
    }); on(document,"fullscreenchange",()=>{if(document.fullscreenElement)close();});
    const workspaceKey="webgl.shader-studio.workspace.v1",groups=["studioInputs","studioFiles","studioStarters","studioImages","studioDependencies","studioInspector","studioCodeTools"];
    const saveWorkspace=()=>{try{localStorage.setItem(workspaceKey,JSON.stringify({toolsHidden:$("studioTools").hidden,open:Object.fromEntries(groups.map(id=>[id,$(id).open]))}));}catch(_){}};
    setDockHeight(dockHeight,false);setDockWidth(dockWidth,false);applyLayout();
    // 창 크기를 바꾸면(화면 분할 등) 사용자가 정하지 않은 높이·배치는 새 크기의 기본값으로 다시 맞춘다.
    on(window,"resize",()=>{
      if(!heightChosen&&dockHeight!==responsiveHeight())setDockHeight(responsiveHeight(),false);
      const fit=fitLayout();if(!layoutChosen&&layout!==fit){layout=fit;applyLayout();if(splitRight())closeToolsDrawer();}
    });$("studioTools").hidden=window.matchMedia("(max-width:600px)").matches||layout==="right";
    try{const state=JSON.parse(localStorage.getItem(workspaceKey)||"{}");if(typeof state?.toolsHidden==="boolean")$("studioTools").hidden=state.toolsHidden;for(const id of groups)if(typeof state?.open?.[id]==="boolean")$(id).open=state.open[id];}catch(_){}
    // 옆 배치에서 도구는 코드를 덮는 서랍이므로, 아래 배치에서 저장된 "도구 표시" 상태와 관계없이 닫힌 채로 시작한다.
    if(splitRight())$("studioTools").hidden=true;
    for(const id of groups)on($(id),"toggle",saveWorkspace);$("studioToolsToggle").setAttribute("aria-expanded",String(!$("studioTools").hidden));renderEditor();restore();loadDraft(savedDraft);undoStack.length=redoStack.length=0;checkpoint=historyState();syncHistory();
    const removeAllPasses = () => proceed(confirmReplace(),()=>setProject({image:renderer.getFragmentSource(),passes:[],imageChannels:{}}));
    // 갤러리 등 외부 예제: 미적용 변경 확인 → 코드·버퍼·파라미터 일괄 교체(Undo 가능).
    const loadExample = (next,users=[]) => startProject(next,users);
    // 가이드 코드 예시 삽입. replace=true면 현재 패스 전체를 교체한다(Undo로 복원 가능).
    // 커서가 #version/precision 줄보다 앞에 있으면 컴파일이 깨지므로 precision 줄 다음으로 옮겨 넣는다.
    const insertSnippet = (text,replace=false) => {
      if(disposed||typeof text!=="string")return false; open();const area=$("studioCode");area.focus({preventScroll:true});
      if(replace)area.setSelectionRange(0,area.value.length);
      else {
        const header=/^[\s\S]*?\bprecision\s+\w+\s+float\s*;[^\n]*\n?/.exec(area.value)?.[0]??(/^#version[^\n]*\n?/.exec(area.value)?.[0]||"");
        if(area.selectionStart<header.length)area.setSelectionRange(header.length,header.length);
        const at=area.selectionStart,lineStart=at===0||area.value[at-1]==="\n";
        text=(lineStart?"":"\n")+text+(area.value[at]==="\n"||at===area.value.length?"":"\n")+(lineStart?"\n":"");
      }
      area.setRangeText(text,area.selectionStart,area.selectionEnd,"end");area.dispatchEvent(new Event("input",{bubbles:true}));
      setStatus(replace?"가이드 코드로 교체됨 · Ctrl+Z로 되돌리기":"가이드 코드 삽입됨 · 필요하면 위치를 조정하세요","is-dirty");return true;
    };
    // 코드 조각 라이브러리 삽입: global(함수 정의)은 전역 위치에, main(문장)은 함수 안 커서 위치에 넣는다.
    //  - 커서가 함수 본문 안이면 global은 그 함수 선언 바로 앞에 넣는다(함수 안 함수 정의 방지).
    //  - 커서가 함수 밖이면 main 코드는 main() 본문 첫 줄에 넣는다.
    // 한 번의 input 이벤트로 반영하므로 Undo 한 번에 되돌아간다.
    const insertCode = ({global="",main="",replace="",note=""}={}) => {
      if(disposed)return false;open();const area=$("studioCode");area.focus({preventScroll:true});
      const done=()=>{if(note)setStatus(note,"is-dirty");return true;};
      if(replace){area.setRangeText(replace,0,area.value.length,"end");area.dispatchEvent(new Event("input",{bubbles:true}));return done();}
      let src=area.value,caret=area.selectionStart;
      // 주석을 같은 길이의 공백으로 지운 사본으로 괄호 깊이를 센다. 삽입할 때마다 다시 계산한다.
      const strip=text=>text.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/g,m=>m.replace(/[^\n]/g," "));
      const headerEnd=()=>{const clean=strip(src);return (/^[\s\S]*?\bprecision\s+\w+\s+float\s*;[^\n]*\n?/.exec(clean)?.[0]??(/^#version[^\n]*\n?/.exec(clean)?.[0]||"")).length;};
      const scan=limit=>{const clean=strip(src),header=headerEnd();let depth=0,declStart=header;
        for(let i=header;i<limit;i++){const c=clean[i];if(c==="{")depth++;else if(c==="}"){depth=Math.max(0,depth-1);if(!depth)declStart=i+1;}else if(c===";"&&!depth)declStart=i+1;}
        return {depth,declStart,header};};
      const lineStart=at=>src.lastIndexOf("\n",at-1)+1;
      const insertAt=(at,text)=>{src=src.slice(0,at)+text+src.slice(at);if(at<=caret)caret+=text.length;};
      caret=Math.max(caret,headerEnd());
      if(global){
        const {depth,declStart,header}=scan(caret),text=global.replace(/\s+$/,"")+"\n\n";let at;
        if(depth>0){at=declStart;while(at<src.length&&/\s/.test(src[at]))at++;at=lineStart(at);}   // 감싼 함수 선언 바로 앞
        else if(!src.slice(lineStart(caret),caret).trim())at=Math.max(header,lineStart(caret));      // 빈 줄 시작
        else {const next=src.indexOf("\n",caret);at=next<0?src.length:next+1;if(next<0){src+="\n";at=src.length;}} // 현재 줄 다음
        insertAt(at,text);
      }
      if(main){
        const {depth}=scan(caret),indent="    ",body=main.replace(/\s+$/,"").split("\n").map(line=>line?indent+line:line).join("\n")+"\n";
        if(depth>0){
          // 줄 맨 앞이면 그 줄 위에, 줄 중간이면 다음 줄에 넣는다(문장을 쪼개지 않음).
          const start=lineStart(caret),next=src.indexOf("\n",caret),at=!src.slice(start,caret).trim()?start:next<0?src.length:next+1;
          if(at===src.length&&!src.endsWith("\n"))src+="\n";insertAt(at,body);caret=at+body.length;
        }
        else {
          // 함수 밖이면 main() 본문의 끝(닫는 괄호 앞)에 넣는다. 앞에서 선언한 uv 같은 변수를 쓸 수 있다.
          const clean=strip(src),m=/\bvoid\s+main\s*\(\s*\)\s*\{/.exec(clean);let at=src.length;
          if(m){let d=0;for(let i=m.index+m[0].length-1;i<clean.length;i++){if(clean[i]==="{")d++;else if(clean[i]==="}"&&--d===0){at=lineStart(i);break;}}}
          insertAt(at,body);caret=at+body.length;
        }
      }
      area.value=src;area.setSelectionRange(caret,caret);area.dispatchEvent(new Event("input",{bubbles:true}));return done();
    };
    // 명령 팔레트(Ctrl+Shift+P)에 편집기 바깥 기능도 등록한다. 대부분 기존 버튼을 누르는 것과 같다.
    const press = (label, id, key) => ({label, key, run:() => { const button=$(id); if(button && !button.disabled) button.click(); }});
    const stepPass = step => { const tabs=[...$("studioPassTabs").children], at=tabs.findIndex(tab=>tab.classList.contains("is-active")); tabs[(at+step+tabs.length)%tabs.length]?.click(); };
    editor.registerCommands?.([
      press("셰이더 실행 (적용)","studioRun","Ctrl+Enter"), press("되돌리기","studioUndo","Ctrl+Z"), press("다시 실행","studioRedo","Ctrl+Y"),
      {label:"자동 적용 켜기/끄기", run:() => $("studioLive").click()},
      press("버퍼 패스 추가","studioAdd"), {label:"다음 패스로", key:"Alt+PageDown", run:() => stepPass(1)}, {label:"이전 패스로", key:"Alt+PageUp", run:() => stepPass(-1)},
      press("재생 / 일시정지","studioPause"), press("시간·프레임 초기화","studioResetFrames"), press("도구 서랍 열기/닫기","studioToolsToggle"),
      press("집중 모드 전환","studioMaximize"), press("편집기 배치 바꾸기 (오른쪽 ↔ 아래)","studioLayout"), press("편집기 닫기","studioHide","E"),
      press("코드 조각 모음 열기","studioSnippets"), press("파라미터 패널 열기","studioParameters"), press("도움말 · 단축키","studioHelp","?"),
      press(".frag 파일로 저장","studioSaveGLSL"), press(".frag 파일 열기","studioOpenGLSL"), press("전체 프로젝트 저장 (Pack)","studioExportPack"), press("Pack 열기","studioImportPack"),
      press("이미지 파일 불러오기","studioTextureAdd"), press("기본 Shader Art로 새로 시작","studioReset")]);
    return {open,close,toggle,apply,setProject,getPlaybackState,togglePlayback,loadFromRenderer,removeAllPasses,exampleRaymarch,examplePipeline,exampleFeedback,loadExample,insertSnippet,insertCode,getEditorSource:()=>$("studioCode").value,
      undo:()=>historyMove(true),redo:()=>historyMove(false),getProject:()=>copy(project),exportPack,importPack,dispose:()=>{
        disposed=true;if(timer)clearTimeout(timer);if(draftTimer)clearTimeout(draftTimer);
        if(dirty){try{rememberEditor();localStorage.setItem(DRAFT_KEY,JSON.stringify({version:1,project,selected}));}catch(_){}}
        if(pending)finish(false);editor.dispose();controller.abort();}};
  }; export {mount};
