// 로컬 textarea 기반 GLSL 편집 보조 도구. 별도 라이브러리나 CDN이 필요하지 않다.
import * as Highlight from "./glsl-highlight.js";
  // options.lookup(name) → {sig, desc} | null : 내장 함수 설명(시그니처 힌트). options.onScrub() : 숫자를 끌어 바꾸는 중 즉시 적용 요청.
  const mount = (textarea,ask,beforeEdit=()=>{},uniformNames=()=>[],options={}) => {
    const $ = id => document.getElementById(id), ac = new AbortController(), signal = ac.signal;
    const listen = (target, type, fn) => target?.addEventListener(type, fn, {signal});   // 선택 요소(버튼 등)가 없어도 편집기는 동작한다
    const gutter = $("studioLines"), highlight = $("studioHighlight"), position = $("studioCursor"), findPanel = $("studioFindPanel");
    // 강조: 내장 함수 이름은 레퍼런스(options.builtins)에서 받는다. 호출(이름 + '(')은 내장이면 builtin, 아니면 사용자 함수 색.
    const highlighter = Highlight.create((options.builtins || []).map(item => item.name));
    // 주석·문자열·전처리문을 제외한다. 함수 탐색은 최상위 정의만 열거한다.
    const cleanSource = source => source.replace(/^[ \t]*#(?:[^\n]*\\\r?\n)*[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\])*"/gm,s=>s.replace(/[^\n]/g," "));
    let functionSource=null,functionEntries=[];
    const scanFunctions = source => {
      if(source===functionSource)return functionEntries;
      const clean=cleanSource(source);
      const pattern=/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*\{/g, found=[];let pos=0,depth=0,line=1;
      for(const match of clean.matchAll(pattern)) {
        for(;pos<match.index;pos++) {const ch=clean[pos];if(ch==="{")depth++;else if(ch==="}")depth=Math.max(0,depth-1);else if(ch==="\n")line++;}
        if(depth)continue;
        found.push({name:match[2],params:match[3].trim().replace(/\s+/g," "),line});
      }
      functionSource=source;return functionEntries=found;
    };
    const symbols = $("studioFunctions"), updateFunctions = () => {
      const entries=scanFunctions(textarea.value);symbols.replaceChildren(new Option(`ƒ 함수 (${entries.length})`,""),
        ...entries.map(({name,params,line})=>new Option(`${name}(${params.slice(0,38)}${params.length>38?"…":""}) · Ln ${line}`,String(line))));
      symbols.value="";symbols.disabled=!entries.length;
    };
    let paintRequest = 0,paintedSource=null; const paint = () => {
      paintRequest=0;const src=textarea.value;if(src===paintedSource)return;paintedSource=src;const frag=highlighter.fragment(src);
      frag.append(document.createTextNode("\n ")); highlight.replaceChildren(frag);
      highlight.scrollTop=textarea.scrollTop;highlight.scrollLeft=textarea.scrollLeft;updateFunctions();
      renderDiagnostics();
    }; const schedulePaint = () => {if(!paintRequest)paintRequest=requestAnimationFrame(paint);};
    // 컴파일 진단(Error Lens): 오류 줄 강조 띠와 줄 끝 메시지. 하이라이트 레이어와 같은 좌표계를 쓴다.
    // 편집하면 줄 위치가 달라질 수 있으므로 다음 컴파일 전까지 흐리게(stale) 표시한다.
    const surface = highlight.parentElement || null, layer = surface ? document.createElement("div") : null;
    if(layer) { layer.className = "studio-diagnostic-layer"; layer.setAttribute("aria-hidden","true"); surface.append(layer); }
    let diagnostics = [], measure = null;
    const charWidth = style => {
      measure ??= document.createElement("canvas").getContext("2d");
      if(!measure?.measureText) return fontSize * 0.6;
      measure.font = `${style.fontSize || fontSize+"px"} ${style.fontFamily || "monospace"}`; return measure.measureText("0000000000").width / 10 || fontSize * 0.6;
    };
    const renderDiagnostics = () => {
      if(!layer) return;
      if(!diagnostics.length || wrap) { layer.replaceChildren(); return; }
      const style = getComputedStyle(textarea), lh = parseFloat(style.lineHeight) || fontSize*1.65;
      const top = parseFloat(style.paddingTop) || 12, left = parseFloat(style.paddingLeft) || 12, cw = charWidth(style);
      const rows = textarea.value.split("\n"), byLine = new Map(), nodes = [];
      for(const item of diagnostics) if(item.line >= 1 && item.line <= rows.length) {
        const entry = byLine.get(item.line) || {severity:"warning", messages:[]};
        if(item.severity === "error") entry.severity = "error"; entry.messages.push(item.message); byLine.set(item.line, entry);
      }
      for(const [line, {severity, messages}] of byLine) {
        const y = top + (line-1)*lh - textarea.scrollTop; if(y < -lh || y > textarea.clientHeight + lh) continue;
        const band = document.createElement("div"); band.className = "studio-diagnostic-line"; band.dataset.severity = severity;
        band.style.top = `${y}px`; band.style.height = `${lh}px`;
        const lens = document.createElement("div"); lens.className = "studio-diagnostic-lens"; lens.dataset.severity = severity;
        const text = rows[line-1].replace(/\t/g, " ".repeat(tabSize));
        lens.textContent = messages.length > 1 ? `${messages[0]} (+${messages.length-1})` : messages[0];
        lens.style.top = `${y}px`; lens.style.height = `${lh}px`; lens.style.left = `${left + text.trimEnd().length*cw - textarea.scrollLeft + 28}px`;
        nodes.push(band, lens);
      }
      layer.replaceChildren(...nodes);
    };
    // list: [{line, message, severity:"error"|"warning"}] — 현재 편집 중인 패스의 원본 줄 번호.
    const setDiagnostics = list => {
      diagnostics = Array.isArray(list) ? list.filter(item => Number.isInteger(item?.line) && typeof item.message === "string") : [];
      layer?.classList?.remove("is-stale"); renderDiagnostics();
    };
    const query = $("studioFindQuery"), replacement = $("studioReplaceValue"), result = $("studioFindCount");
    const STATE_KEY = "webgl.shader-studio.editor.v2"; let fontSize = 12, wrap = false, tabSize = 4, matches = [], matchIndex = -1;
    try { const state = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
      if(Number.isInteger(state.fontSize)) fontSize = Math.max(10, Math.min(20, state.fontSize)); wrap = !!state.wrap; tabSize = state.tabSize === 2 ? 2 : 4;
    } catch (_) {}
    const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify({fontSize,wrap,tabSize})); } catch (_) {} };
    const setPresentation = () => {
      textarea.style.tabSize=highlight.style.tabSize=String(tabSize);textarea.style.fontSize = `${fontSize}px`; gutter.style.fontSize = `${fontSize}px`;highlight.style.fontSize=`${fontSize}px`;
      textarea.classList.toggle("editor-wrap", wrap);highlight.classList.toggle("editor-wrap",wrap);
      textarea.wrap=wrap?"soft":"off";textarea.closest(".studio-editor-frame").classList.toggle("is-wrapped",wrap); $("studioLineWrap").setAttribute("aria-pressed", String(wrap));
      $("studioFontSize").textContent = `${fontSize}px`; $("studioIndent").value = String(tabSize); save(); updateLines(); renderDiagnostics();
    }; const lineAt = offset => textarea.value.slice(0,offset).split("\n").length; const updateCursor = () => {
      const p = textarea.selectionStart, line = lineAt(p), start = textarea.value.lastIndexOf("\n",p-1)+1;
      const selected = textarea.selectionEnd - p;
      position.textContent = `Ln ${line}, Col ${p-start+1}${selected ? ` · ${selected}자 선택` : ""}`;
      updateSignature(); scheduleDecorations(); checkSnippetSession();
    };
    // ==== 언어 정보: 키워드·타입·앱 Uniform·내장 변수 ====
    const KEYWORDS = "if else for while do break continue return discard switch case default struct const uniform in out inout layout precision highp mediump lowp true false flat smooth".split(" ");
    const TYPES = "void bool int uint float vec2 vec3 vec4 bvec2 bvec3 bvec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 mat2 mat3 mat4 mat2x3 mat2x4 mat3x2 mat3x4 mat4x2 mat4x3 sampler2D isampler2D usampler2D samplerCube sampler3D".split(" ");
    // 렌더러가 값을 넣어 주는 Uniform: 선언하지 않은 채 자동 완성으로 고르면 선언을 맨 위에 함께 추가한다.
    const APP_UNIFORMS = [["uResolution","vec2","현재 패스의 픽셀 크기 (vec3으로 선언하면 z = 1)"],["uTime","float","재생 시간(초). 일시정지 중에는 멈춥니다"],
      ["uDeltaTime","float","직전 프레임과의 시간 간격(초)"],["uFrame","int","누적 프레임 수. 시간 초기화·구조 변경 시 0"],
      ["uMouse","vec4","포인터 픽셀 좌표(밖이면 -1) · zw = 클릭 위치, z > 0 누르는 중, w > 0 누른 첫 프레임"],
      ...[0,1,2,3].map(i => [`iChannel${i}`,"sampler2D",`입력 채널 ${i} — 편집기 입력 채널에서 연결한 이미지·버퍼`]),
      ["iChannelResolution","vec3","각 입력 채널의 크기 (배열 4개)","uniform vec3 iChannelResolution[4];"]];
    const BUILTIN_VARS = {gl_FragCoord:"vec4", gl_FrontFacing:"bool", gl_PointCoord:"vec2", gl_FragDepth:"float"};
    const isIdent = text => /^[A-Za-z_]\w*$/.test(text);
    const userUniforms = () => options.userUniforms?.() || uniformNames().map(name => ({name, type:""}));
    const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    // 주석·문자열을 같은 길이 공백으로 지운 사본(위치 보존). 같은 소스면 다시 계산하지 않는다.
    let cleanCache = {src:null, clean:""};
    const cleanOf = src => { if(cleanCache.src !== src) cleanCache = {src, clean:cleanSource(src)}; return cleanCache.clean; };
    const lineStartsOf = src => { const starts = [0]; for(let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i+1)) starts.push(i+1); return starts; };
    const lineIndexAt = (starts, offset) => { let lo = 0, hi = starts.length-1; while(lo < hi) { const mid = (lo+hi+1) >> 1; if(starts[mid] <= offset) lo = mid; else hi = mid-1; } return lo; };
    // ==== 심볼 표: 함수·변수(매개변수 포함)·구조체·#define. 소스가 바뀔 때만 다시 만든다 ====
    const DECL = /\b((?:(?:const|uniform|in|out|inout|highp|mediump|lowp|flat|smooth)\s+)*)((?:[biu]?vec[234]|mat[234](?:x[234])?|float|int|uint|bool|[iu]?sampler2D|samplerCube|sampler3D|[A-Z]\w*))\s+([A-Za-z_]\w*)\s*(?=[=;,)\[])/g;
    let symbolCache = {src:null};
    const symbolsOf = src => {
      if(symbolCache.src === src) return symbolCache;
      const clean = cleanOf(src), starts = lineStartsOf(src), line = at => lineIndexAt(starts, at) + 1, functions = [], variables = [], structs = new Map(), defines = [];
      for(const m of clean.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*\{/g)) if(!KEYWORDS.includes(m[1]) && !KEYWORDS.includes(m[2]))
        functions.push({name:m[2], ret:m[1], params:m[3].trim().replace(/\s+/g," "), offset:m.index + m[0].indexOf(m[2], m[1].length), line:line(m.index)});
      for(const m of clean.matchAll(DECL)) if(!KEYWORDS.includes(m[3]) && !TYPES.includes(m[3]))
        variables.push({name:m[3], type:m[2], uniform:/\buniform\b/.test(m[1]), output:/\bout\b/.test(m[1]), offset:m.index + m[0].lastIndexOf(m[3]), line:line(m.index)});
      for(const m of clean.matchAll(/\bstruct\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/g))
        structs.set(m[1], {line:line(m.index), offset:m.index + m[0].indexOf(m[1]), fields:[...m[2].matchAll(/([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;/g)].map(f => ({name:f[2], type:f[1]}))});
      for(const m of src.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]*(.*)$/gm)) defines.push({name:m[1], value:m[2].trim(), offset:m.index + m[0].indexOf(m[1]), line:line(m.index)});
      return symbolCache = {src, functions, variables, structs, defines};
    };
    // 이름의 타입: 가장 가까운 앞쪽 선언 → 내장 변수 → 앱 Uniform
    const typeOf = (name, pos) => {
      const vars = symbolsOf(textarea.value).variables.filter(v => v.name === name); if(!vars.length) return BUILTIN_VARS[name] || APP_UNIFORMS.find(u => u[0] === name)?.[1] || "";
      const before = vars.filter(v => v.offset <= pos); return (before.length ? before[before.length-1] : vars[0]).type;
    };
    const wordAround = (src, pos) => {
      let a = pos, b = pos; while(a > 0 && /\w/.test(src[a-1])) a--; while(b < src.length && /\w/.test(src[b])) b++;
      const word = src.slice(a, b); return isIdent(word) ? {word, start:a, end:b} : null;
    };
    // 설명: 함수(내장·이 패스) / 변수·Uniform·구조체·#define — 시그니처 힌트와 마우스 설명이 함께 쓴다.
    const describeFunction = name => {
      const builtin = options.lookup?.(name); if(builtin) return {sig:builtin.sig, desc:builtin.desc};
      const own = symbolsOf(textarea.value).functions.find(entry => entry.name === name);
      return own ? {sig:`${own.ret} ${name}(${own.params})`, desc:`이 패스에 정의된 함수 · ${own.line}번째 줄`} : null;
    };
    const describeSymbol = (name, pos) => {
      const fn = describeFunction(name); if(fn) return fn;
      const sym = symbolsOf(textarea.value), app = APP_UNIFORMS.find(u => u[0] === name);
      const vars = sym.variables.filter(v => v.name === name), decl = vars.filter(v => v.offset <= pos).pop() || vars[0];
      if(decl) return {sig:`${decl.uniform ? "uniform " : decl.output ? "out " : ""}${decl.type} ${name}`, desc:app ? app[2] : `${decl.uniform ? "Uniform" : decl.output ? "출력" : "변수"} · ${decl.line}번째 줄에서 선언`};
      if(app) return {sig:`uniform ${app[1]} ${name}`, desc:`${app[2]} · 아직 선언되지 않음`};
      const param = userUniforms().find(u => u.name === name); if(param) return {sig:`uniform ${param.type} ${name}`, desc:"파라미터 패널에 등록된 값 · 선언은 자동으로 추가됩니다"};
      const struct = sym.structs.get(name); if(struct) return {sig:`struct ${name} { ${struct.fields.map(f => `${f.type} ${f.name};`).join(" ")} }`, desc:`구조체 · ${struct.line}번째 줄`};
      const define = sym.defines.find(d => d.name === name); if(define) return {sig:`#define ${name} ${define.value}`, desc:`매크로 · ${define.line}번째 줄`};
      return null;
    };
    // ==== 커서 화면 좌표: textarea와 같은 글꼴·여백·줄바꿈을 가진 숨은 복제본으로 잰다(줄바꿈 켜도 정확) ====
    const frame = textarea.closest(".studio-editor-frame");
    const mirror = document.createElement("div"); mirror.className = "studio-caret-mirror"; mirror.setAttribute("aria-hidden","true"); surface?.append(mirror);
    const caretCoords = pos => {
      const style = getComputedStyle(textarea);
      for(const key of ["fontFamily","fontSize","fontWeight","lineHeight","letterSpacing","tabSize","paddingTop","paddingRight","paddingBottom","paddingLeft","whiteSpace","overflowWrap","wordBreak"]) mirror.style[key] = style[key];
      mirror.style.width = `${textarea.clientWidth}px`;
      const marker = document.createElement("span"); marker.textContent = "​"; mirror.replaceChildren(document.createTextNode(textarea.value.slice(0, pos)), marker);
      return {left:marker.offsetLeft - textarea.scrollLeft, top:marker.offsetTop - textarea.scrollTop, height:parseFloat(style.lineHeight) || fontSize*1.65};
    };
    // ==== 시그니처 도움말: 호출 괄호 안이면 지금 쓰는 인수를 굵게, 커서 바로 위에 띄운다 ====
    const signature = $("studioSignature"); let signatureKey = "";
    const calleeAt = (src, pos) => {
      const here = wordAround(src, pos);
      if(here && /^\s*\(/.test(src.slice(here.end)) && describeFunction(here.word)) return {name:here.word, arg:-1};
      // 닫히지 않은 가장 가까운 '(' 앞의 이름 = 지금 인수를 쓰고 있는 함수, 그 사이 깊이 0의 쉼표 수 = 인수 번호
      for(let i = pos-1, depth = 0, stop = Math.max(0,pos-800); i >= stop; i--) {
        const c = src[i]; if(c === ")" || c === "]") depth++;
        else if(c === "(" || c === "[") {
          if(depth === 0) {
            if(c === "[") return null; const name = src.slice(0,i).match(/([A-Za-z_]\w*)\s*$/)?.[1]; if(!name) return null;
            let arg = 0; for(let j = i+1, d = 0; j < pos; j++) { const k = src[j]; if(k === "(" || k === "[") d++; else if(k === ")" || k === "]") d--; else if(k === "," && !d) arg++; }
            return {name, arg};
          } depth--;
        } else if(c === ";" || c === "{" || c === "}") break;
      }
      return here && describeFunction(here.word) ? {name:here.word, arg:-1} : null;
    };
    // 시그니처 문자열에서 name(…)의 매개변수 위치를 찾는다. "[, float bias]" 같은 선택 인수 안의 쉼표는 나누지 않는다.
    const paramsOf = (sig, name) => {
      const at = sig.search(new RegExp(`\\b${escapeRe(name)}\\s*\\(`)); if(at < 0) return null;
      const open = sig.indexOf("(", at), parts = []; let depth = 0, from = open+1, close = sig.length;
      for(let i = open+1; i < sig.length; i++) { const c = sig[i];
        if(c === "(" || c === "[") depth++; else if(c === "]") depth--; else if(c === ")") { if(!depth) { close = i; break; } depth--; }
        else if(c === "," && !depth) { parts.push([from, i]); from = i+1; } }
      if(sig.slice(from, close).trim()) parts.push([from, close]); return {at, open, close, parts};
    };
    const renderSignature = (target, name, info, arg) => {
      const overloads = info.sig.split(" · ").filter(sig => paramsOf(sig, name)), all = overloads.length ? overloads : [info.sig];
      const sig = arg < 0 ? all[0] : all.find(item => (paramsOf(item, name)?.parts.length || 0) > arg) || all[0], shape = paramsOf(sig, name);
      const line = document.createElement("span"), text = (a, b) => line.append(document.createTextNode(sig.slice(a, b)));
      if(shape) {
        text(0, shape.at); const b = document.createElement("b"); b.textContent = sig.slice(shape.at, shape.open); line.append(b); text(shape.open, shape.open+1);
        let cursor = shape.open+1; shape.parts.forEach(([a, z], i) => { while(a < z && sig[a] === " ") a++; text(cursor, a); const part = document.createElement(i === arg ? "em" : "span"); if(i === arg) part.className = "sig-param-active"; part.textContent = sig.slice(a, z); line.append(part); cursor = z; });
        text(cursor, sig.length);
      } else text(0, sig.length);
      const desc = document.createElement("small"); desc.textContent = info.desc + (all.length > 1 ? ` · 다른 형태 ${all.length-1}개` : "");
      target.replaceChildren(line, desc);
    };
    const hideSignature = () => { if(signature && !signature.hidden) { signature.hidden = true; signatureKey = ""; } };
    // 떠 있는 카드를 커서 근처(기본: 줄 위, 공간이 없으면 줄 아래)에 놓는다. 좌표는 편집 프레임 기준.
    const placeNear = (element, coords, preferAbove) => {
      if(!frame || !surface) return; const lh = coords.height, maxLeft = frame.clientWidth - element.offsetWidth - 6;
      const left = Math.max(6, Math.min(surface.offsetLeft + coords.left - 10, maxLeft));
      const above = surface.offsetTop + coords.top - element.offsetHeight - 4, below = surface.offsetTop + coords.top + lh + 4;
      element.style.left = `${left}px`; element.style.top = `${preferAbove && above >= 2 || below + element.offsetHeight > frame.clientHeight ? Math.max(2, above) : below}px`;
    };
    const updateSignature = () => {
      if(!signature) return; const pos = textarea.selectionStart;
      if(document.activeElement !== textarea || textarea.selectionEnd !== pos || codeMode(pos)) return hideSignature();
      // 이름만 친 상태에서는 자동 완성 설명 칸이 같은 정보를 보여 주므로, 괄호 안(인수 입력 중)일 때만 띄운다.
      const call = calleeAt(textarea.value, pos), info = call && call.arg >= 0 ? describeFunction(call.name) : null; if(!info) return hideSignature();
      const key = `${call.name}|${call.arg}|${info.sig}`;
      if(key !== signatureKey) { signatureKey = key; renderSignature(signature, call.name, info, call.arg); }
      signature.hidden = false; placeNear(signature, caretCoords(pos), true);
    };
    // ==== 마우스 설명(hover): 이름 위에 잠시 머물면 시그니처·타입·선언 위치를 보여준다 ====
    const hover = document.createElement("div"); hover.className = "studio-hover"; hover.setAttribute("role","tooltip"); hover.hidden = true; frame?.append(hover);
    let hoverTimer = 0, hoverWord = "";
    const hideHover = () => { clearTimeout(hoverTimer); if(!hover.hidden) { hover.hidden = true; hoverWord = ""; } };
    const showHover = (x, y) => {
      const pos = offsetAtPoint(x, y); if(pos < 0 || !frame) return hideHover();
      const found = wordAround(textarea.value, pos); if(!found || codeMode(found.start)) return hideHover();
      const info = describeSymbol(found.word, found.start); if(!info) return hideHover();
      if(found.word + found.start !== hoverWord) { hoverWord = found.word + found.start; renderSignature(hover, found.word, info, -1); }
      hover.hidden = false; const rect = frame.getBoundingClientRect();
      hover.style.left = `${Math.max(6, Math.min(x - rect.left + 8, frame.clientWidth - hover.offsetWidth - 6))}px`;
      const top = y - rect.top + 18; hover.style.top = `${top + hover.offsetHeight > frame.clientHeight ? Math.max(2, y - rect.top - hover.offsetHeight - 10) : top}px`;
    };
    listen(textarea, "mousemove", event => { if(scrub || event.buttons) return hideHover(); clearTimeout(hoverTimer); const {clientX:x, clientY:y} = event; hoverTimer = setTimeout(() => showHover(x, y), 400); });
    listen(textarea, "mouseleave", hideHover); listen(textarea, "keydown", hideHover);
    // ==== 화면 표시: 현재 줄 · 짝 괄호 · 커서 아래 이름의 다른 사용 위치 (VS Code와 같은 방식) ====
    const decorations = document.createElement("div"); decorations.className = "studio-deco-layer"; decorations.setAttribute("aria-hidden","true"); surface?.insertBefore?.(decorations, textarea);
    const BRACKETS = {"(":")","[":"]","{":"}"}, CLOSERS = {")":"(","]":"[","}":"{"};
    const matchBracket = (src, pos) => {
      const clean = cleanOf(src), at = BRACKETS[clean[pos]] || CLOSERS[clean[pos]] ? pos : BRACKETS[clean[pos-1]] || CLOSERS[clean[pos-1]] ? pos-1 : -1; if(at < 0) return null;
      const c = clean[at], forward = !!BRACKETS[c], pair = forward ? BRACKETS[c] : CLOSERS[c];
      for(let i = at + (forward ? 1 : -1), depth = 0, steps = 0; i >= 0 && i < clean.length && steps < 50000; i += forward ? 1 : -1, steps++) {
        if(clean[i] === c) depth++; else if(clean[i] === pair) { if(!depth) return [at, i]; depth--; }
      }
      return null;
    };
    // 커서 이동·입력이 몰려도 한 번만 그린다. 화면 갱신 주기(rAF)가 멈춘 상태(숨은 창)에서도 밀리지 않도록 타이머를 쓴다.
    let decoRequest = 0; const scheduleDecorations = () => { if(!decoRequest) decoRequest = setTimeout(renderDecorations, 0); };
    const renderDecorations = () => {
      decoRequest = 0; if(!surface || wrap) { decorations.replaceChildren(); return; }
      const style = getComputedStyle(textarea), lh = parseFloat(style.lineHeight) || fontSize*1.65, cw = charWidth(style);
      const top = parseFloat(style.paddingTop) || 12, left = parseFloat(style.paddingLeft) || 12, src = textarea.value, starts = lineStartsOf(src);
      const a = textarea.selectionStart, b = textarea.selectionEnd, focused = document.activeElement === textarea, nodes = [];
      const first = Math.max(0, Math.floor(textarea.scrollTop / lh) - 1), last = Math.min(starts.length-1, first + Math.ceil(textarea.clientHeight / lh) + 2);
      const column = (lineIndex, offset) => { let visual = 0; for(let i = starts[lineIndex]; i < offset; i++) visual += src[i] === "\t" ? tabSize - visual % tabSize : 1; return visual; };
      const box = (offset, length, className) => {
        const index = lineIndexAt(starts, offset); if(index < first || index > last) return;
        const node = document.createElement("div"); node.className = className;
        node.style.cssText = `left:${left + column(index, offset)*cw - textarea.scrollLeft}px;top:${top + index*lh - textarea.scrollTop}px;width:${Math.max(1,length)*cw}px;height:${lh}px`; nodes.push(node);
      };
      if(focused) { const index = lineIndexAt(starts, a); if(index >= first && index <= last) { const band = document.createElement("div"); band.className = "deco-line"; band.style.cssText = `top:${top + index*lh - textarea.scrollTop}px;height:${lh}px`; nodes.push(band); } }
      if(focused && a === b) { const pair = matchBracket(src, a); if(pair) { box(pair[0], 1, "deco-bracket"); box(pair[1], 1, "deco-bracket"); } }
      // 이름 강조: 커서 아래 단어, 또는 한 줄 안의 선택 텍스트와 같은 다른 위치
      const selected = src.slice(a, b), found = a === b ? wordAround(src, a) : (isIdent(selected) ? {word:selected} : null);
      if(focused && found && !KEYWORDS.includes(found.word) && !codeMode(a)) {
        const clean = cleanOf(src), from = starts[first], to = last+1 < starts.length ? starts[last+1] : src.length, hits = [];
        for(const m of clean.slice(from, to).matchAll(new RegExp(`\\b${escapeRe(found.word)}\\b`, "g"))) { hits.push(from + m.index); if(hits.length > 300) break; }
        if(hits.length > 1) for(const at of hits) box(at, found.word.length, "deco-occurrence");
      }
      decorations.replaceChildren(...nodes);
    };
    listen(textarea, "focus", scheduleDecorations); listen(textarea, "blur", scheduleDecorations);
    // ---- 숫자 조절: Ctrl+↑/↓(Shift = 10배) 또는 숫자 위에서 Alt+좌우 드래그 ----
    // 단위는 리터럴의 마지막 자릿수(0.25 → 0.01, 3. → 1, 8 → 1)이고 정수·실수 형식을 그대로 유지한다.
    const numberAt = (src, pos) => {
      const from = src.lastIndexOf("\n",pos-1)+1, stop = src.indexOf("\n",pos), to = stop < 0 ? src.length : stop, row = src.slice(from,to);
      if(/^\s*#/.test(row) || codeMode(pos)) return null;
      for(const match of row.matchAll(/(?:\d+\.\d*|\.\d+|\d+)(?![\w.])/g)) {
        const a = from + match.index, b = a + match[0].length; if(pos < a || pos > b) continue;
        if(/[\w.]/.test(src[a-1] || "")) return null;   // vec3, iChannel0, 1e5 같은 이름·지수 표기는 건드리지 않는다
        const before = src.slice(from, a).replace(/\s+$/, ""), unary = before.endsWith("-") && !/[\w)\].]$/.test(before.slice(0,-1).replace(/\s+$/, ""));
        const start = unary ? from + before.length - 1 : a, text = src.slice(start, b);
        if(unary && /\s/.test(text.slice(1, a - start))) return {start:a, end:b, text:match[0]};   // "- 1"은 연산자로 본다
        return {start, end:b, text};
      }
      return null;
    };
    // 숫자 조절은 타이핑처럼 연속 입력으로 묶이도록(Undo 한 번에 되돌리기) inputType을 붙여 알린다.
    const notifyAdjust = () => textarea.dispatchEvent(typeof InputEvent === "function" ? new InputEvent("input",{bubbles:true,inputType:"insertReplacementText"}) : new Event("input",{bubbles:true}));
    const numberFormat = text => { const dot = text.indexOf("."), decimals = dot < 0 ? 0 : text.length - dot - 1; return {decimals, isFloat:dot >= 0, step:10 ** -decimals}; };
    const formatNumber = (value, {decimals, isFloat}) => {
      if(Object.is(Math.round(value * 10 ** decimals), -0) || Math.abs(value) < 10 ** -(decimals+1)) value = 0;
      return decimals > 0 ? value.toFixed(decimals) : isFloat ? `${Math.round(value)}.` : String(Math.round(value));
    };
    const nudgeNumber = (direction, multiplier) => {
      if(textarea.selectionStart !== textarea.selectionEnd) return false;
      const caret = textarea.selectionStart, found = numberAt(textarea.value, caret); if(!found) return false;
      const format = numberFormat(found.text), next = formatNumber(parseFloat(found.text) + direction * format.step * multiplier, format);
      beforeEdit(); textarea.setRangeText(next, found.start, found.end, "preserve");
      const keep = Math.min(found.start + next.length, Math.max(found.start, caret + next.length - found.text.length)); textarea.setSelectionRange(keep, keep);
      notifyAdjust(); return true;
    };
    // 포인터 좌표 → 소스 위치 (줄바꿈 끄고 있을 때만; 고정폭 글꼴 기준)
    const offsetAtPoint = (x, y) => {
      if(wrap) return -1; const style = getComputedStyle(textarea), rect = textarea.getBoundingClientRect();
      const lh = parseFloat(style.lineHeight) || fontSize*1.65, cw = charWidth(style);
      const line = Math.floor((y - rect.top - (parseFloat(style.paddingTop) || 12) + textarea.scrollTop) / lh);
      const column = Math.floor((x - rect.left - (parseFloat(style.paddingLeft) || 12) + textarea.scrollLeft) / cw);
      const rows = textarea.value.split("\n"); if(line < 0 || line >= rows.length || column < 0) return -1;
      let visual = 0, index = 0; const row = rows[line];
      while(index < row.length && visual + (row[index] === "\t" ? tabSize - visual % tabSize : 1) <= column) { visual += row[index] === "\t" ? tabSize - visual % tabSize : 1; index++; }
      return rows.slice(0, line).reduce((sum, r) => sum + r.length + 1, 0) + index;
    };
    let scrub = null;
    listen(textarea, "pointerdown", event => {
      if(!event.altKey || event.button !== 0) return;
      const pos = offsetAtPoint(event.clientX, event.clientY), found = pos < 0 ? null : numberAt(textarea.value, pos); if(!found) return;
      event.preventDefault(); textarea.focus(); textarea.setSelectionRange(found.start, found.end);
      scrub = {x:event.clientX, base:parseFloat(found.text), start:found.start, end:found.end, text:found.text, format:numberFormat(found.text)};
      try { textarea.setPointerCapture(event.pointerId); } catch (_) {} textarea.classList.add("is-scrubbing"); beforeEdit();
    });
    listen(textarea, "pointermove", event => {
      if(!scrub) return;
      const steps = Math.round((event.clientX - scrub.x) / 4), next = formatNumber(scrub.base + steps * scrub.format.step * (event.shiftKey ? 10 : 1), scrub.format);
      if(next === scrub.text) return;
      textarea.setRangeText(next, scrub.start, scrub.end, "select"); scrub.end = scrub.start + next.length; scrub.text = next;
      notifyAdjust(); options.onScrub?.();
    });
    const endScrub = () => { if(!scrub) return; scrub = null; textarea.classList.remove("is-scrubbing"); options.onScrub?.(); };
    listen(textarea, "pointerup", endScrub); listen(textarea, "pointercancel", endScrub); listen(textarea, "lostpointercapture", endScrub);
    const updateLines = () => {
      const count = textarea.value.split("\n").length;
      if(gutter.dataset.count !== String(count)) { gutter.textContent = Array.from({length:count},(_,i)=>i+1).join("\n"); gutter.dataset.count = count; }
      gutter.scrollTop = textarea.scrollTop; updateCursor();schedulePaint();
    }; const replaceSelection = (text, start = textarea.selectionStart, end = textarea.selectionEnd) => {
      beforeEdit();textarea.setRangeText(text,start,end,"end"); textarea.dispatchEvent(new Event("input",{bubbles:true}));
    }; const revealLine = line => {
      // 대상 줄이 화면 밖이거나 가장자리에 붙어 있을 때만 스크롤한다. 이미 보이는 줄은 위치를 바꾸지 않는다.
      const style = getComputedStyle(textarea), height = parseFloat(style.lineHeight) || fontSize*1.6, top = (parseFloat(style.paddingTop) || 12) + (line-1)*height;
      const margin = height*2, viewBottom = textarea.scrollTop + textarea.clientHeight;
      if(top < textarea.scrollTop + margin) textarea.scrollTop = Math.max(0, top - margin);
      else if(top + height > viewBottom - margin) textarea.scrollTop = top + height + margin - textarea.clientHeight;
    }; const goToLine = (line, column = 1) => {
      const rows = textarea.value.split("\n"); line = Math.min(rows.length,Math.max(1,Number(line)||1));
      const begin = rows.slice(0,line-1).reduce((sum,row)=>sum+row.length+1,0);
      const offset = begin + Math.min(rows[line-1].length,Math.max(0,column-1)); const keep = textarea.scrollTop; textarea.focus(); textarea.setSelectionRange(offset,offset); textarea.scrollTop = keep;
      if(!wrap) revealLine(line); updateLines(); return line;
    }; const findMatches = (src,text,limit=Infinity) => {
      const found=[];if(!text)return found;const pattern=new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"gi");
      for(const match of src.matchAll(pattern)){if(found.length===limit)break;found.push(match.index);}return found;
    }; const updateMatches = () => {
      matches=findMatches(textarea.value,query.value,10000);matchIndex=-1;
      result.textContent=`${matches.length} results`;return matches.length;
    }; const findNext = backwards => {
      if(!matches.length) { updateMatches(); if(!matches.length) return false; }
      const p = textarea.selectionStart, len = query.value.length;
      if(backwards){let index=matches.length-1;while(index>=0&&matches[index]>=p)index--;matchIndex=index<0?matches.length-1:index;}
      else {const index=matches.findIndex(x=>x>=textarea.selectionEnd);matchIndex=index<0?0:index;}
      const start = matches[matchIndex], keep = textarea.scrollTop; textarea.focus();textarea.setSelectionRange(start,start+len); textarea.scrollTop = keep;
      const line = lineAt(start); if(!wrap) revealLine(line); updateCursor();result.textContent=`${matchIndex+1} / ${matches.length}`; return true;
    }; const showFind = (replace = false) => {
      findPanel.hidden = false; $("studioReplaceRow").hidden = !replace;
      const selected = textarea.value.slice(textarea.selectionStart,textarea.selectionEnd);
      if(selected && !selected.includes("\n") && selected.length < 100) query.value = selected; query.focus();query.select();updateMatches();
    }; const closeFind = () => {findPanel.hidden=true;textarea.focus();}; const doReplace = all => {
      if(!query.value)return;if(all) {
        const src=textarea.value,positions=findMatches(src,query.value),chunks=[];if(!positions.length)return;let last=0;
        for(const at of positions){chunks.push(src.slice(last,at),replacement.value);last=at+query.value.length;}
        chunks.push(src.slice(last));replaceSelection(chunks.join(""),0,src.length);
      } else {
        if(textarea.selectionEnd-textarea.selectionStart!==query.value.length || !findMatches(textarea.value.slice(textarea.selectionStart,textarea.selectionEnd),query.value).length) {
          if(!findNext(false)) return;
        }
        replaceSelection(replacement.value);
      }
      updateMatches();
    }; const indent = (reverse, wholeLine = false) => {
      const start=textarea.selectionStart,end=textarea.selectionEnd,src=textarea.value, pad=" ".repeat(tabSize);
      if(start===end && !reverse && !wholeLine) return replaceSelection(pad);
      const a=src.lastIndexOf("\n",start-1)+1,last=end>start&&src[end-1]==="\n"?end-1:end;
      const stop=src.indexOf("\n",last),until=stop<0?src.length:stop,chunk=src.slice(a,until);
      const lines=chunk.split("\n").map(row=>reverse?row.replace(new RegExp(`^( {1,${tabSize}}|\\t)`),""):row.trim()?pad+row:row).join("\n");
      if(lines===chunk)return;beforeEdit();textarea.setRangeText(lines,a,until,"select");
      if(start===end) {const caret=Math.max(a,start+lines.length-chunk.length);textarea.setSelectionRange(caret,caret);}
      textarea.dispatchEvent(new Event("input",{bubbles:true}));
    }; const moveLines = down => {
      const src=textarea.value,a=textarea.selectionStart,b=textarea.selectionEnd,direction=textarea.selectionDirection;
      const from=src.lastIndexOf("\n",a-1)+1,last=b>a&&src[b-1]==="\n"?b-1:b;
      const stop=src.indexOf("\n",last),to=stop<0?src.length:stop;
      let begin,end,text,shift;
      if(down) {
        if(to===src.length)return;
        begin=from;end=src.indexOf("\n",to+1);if(end<0)end=src.length;
        const next=src.slice(to+1,end);text=next+"\n"+src.slice(from,to);shift=next.length+1;
      } else {
        if(from===0)return;
        begin=src.lastIndexOf("\n",from-2)+1;end=to;
        const prev=src.slice(begin,from-1);text=src.slice(from,to)+"\n"+prev;shift=-prev.length-1;
      }
      beforeEdit();textarea.setRangeText(text,begin,end,"start");
      textarea.setSelectionRange(Math.max(0,Math.min(src.length,a+shift)),Math.max(0,Math.min(src.length,b+shift)),direction);
      textarea.dispatchEvent(new Event("input",{bubbles:true}));
    }; const toggleComment = () => {
      const src=textarea.value,a=src.lastIndexOf("\n",textarea.selectionStart-1)+1;
      const last=textarea.selectionEnd>textarea.selectionStart && src[textarea.selectionEnd-1]==="\n" ? textarea.selectionEnd-1 : textarea.selectionEnd;
      const b=src.indexOf("\n",last),end=b<0?src.length:b, lines=src.slice(a,end).split("\n");
      const remove=lines.every(line=>!line.trim()||/^\s*\/\//.test(line));
      const replaced=lines.map(line=>!line.trim()?line:remove?line.replace(/^(\s*)\/\/ ?/,"$1"):line.replace(/^(\s*)/,"$1// ")).join("\n");
      beforeEdit();textarea.setRangeText(replaced,a,end,"select");textarea.dispatchEvent(new Event("input",{bubbles:true}));
    }; const pairs={"(":")","[":"]","{":"}",'"':'"'};
    const codeMode = pos => {
      const src=textarea.value;let mode="";
      for(let i=0;i<pos;i++) {const c=src[i],n=src[i+1];
        if(mode==="line"){if(c==="\n")mode="";continue;}
        if(mode==="block"){if(c==="*"&&n==="/"){mode="";i++;}continue;}
        if(mode==="string"){if(c==="\\"){i++;continue;}if(c==='"'||c==="\n")mode="";continue;}
        if(c==="/"&&i+1<pos&&n==="/"){mode="line";i++;}
        else if(c==="/"&&i+1<pos&&n==="*"){mode="block";i++;}else if(c==='"')mode="string";
      }return mode;
    };
    // ==== 코드 템플릿(스니펫): ${1:기본값}은 Tab으로 차례로 이동하는 자리, $0은 마지막 커서 위치 ====
    const SNIPPETS = [
      {label:"main", detail:"void main() { … }", body:"void main() {\n\t$0\n}"},
      {label:"for", detail:"for (int i = 0; i < N; i++) { … }", body:"for (int i = 0; i < ${1:8}; i++) {\n\t$0\n}"},
      {label:"if", detail:"if (조건) { … }", body:"if (${1:condition}) {\n\t$0\n}"},
      {label:"ifelse", detail:"if (조건) { … } else { … }", body:"if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}"},
      {label:"func", detail:"반환형 이름(매개변수) { … }", body:"${1:float} ${2:name}(${3:vec2 p}) {\n\treturn ${4:0.0};\n}"},
      {label:"struct", detail:"struct 이름 { … };", body:"struct ${1:Name} {\n\t${2:float value};\n};"},
      {label:"uniform-range", detail:"슬라이더 파라미터 · @range", body:"uniform float ${1:uAmount}; // @range ${2:0} ${3:1} @default ${4:0.5}"},
      {label:"uniform-color", detail:"색상 파라미터 · @color", body:"uniform vec3 ${1:uColor}; // @color @default ${2:1.0 0.5 0.2}"},
      {label:"uv-center", detail:"중심 원점 · 종횡비 보정 좌표", body:"vec2 ${1:uv} = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;"},
      {label:"uv01", detail:"0~1 화면 좌표", body:"vec2 ${1:uv} = gl_FragCoord.xy / uResolution;"},
      {label:"tex", detail:"texture(채널, uv)", body:"texture(${1:iChannel0}, ${2:uv})"},
      {label:"texfetch", detail:"texelFetch — 픽셀 정확히 읽기", body:"texelFetch(${1:iChannel0}, ivec2(gl_FragCoord.xy), 0)"},
      {label:"frag", detail:"새 셰이더 전체 골격", body:"#version 300 es\nprecision highp float;\nuniform vec2 uResolution;\nuniform float uTime;\nout vec4 fragColor;\n\nvoid main() {\n\tvec2 uv = gl_FragCoord.xy / uResolution;\n\tfragColor = vec4(${1:uv, 0.5 + 0.5 * sin(uTime)}, 1.0);$0\n}"}];
    const expandSnippet = (body, indent) => {
      const source = body.replace(/\t/g, " ".repeat(tabSize)).replace(/\n/g, "\n" + indent), stops = []; let text = "", final = -1;
      for(let i = 0; i < source.length;) {
        const m = /^\$\{(\d+):([^}]*)\}|^\$(\d+)/.exec(source.slice(i, i + 80));
        if(m) { const n = Number(m[1] ?? m[3]), value = m[2] ?? ""; if(n === 0) final = text.length; else stops.push({n, start:text.length, end:text.length + value.length}); text += value; i += m[0].length; }
        else { text += source[i]; i++; }
      }
      return {text, stops:stops.sort((a, b) => a.n - b.n), final:final < 0 ? text.length : final};
    };
    // 진행 중인 템플릿: 자리 안에서 타이핑하면 뒤쪽 자리 위치를 길이 변화만큼 민다. 범위를 벗어나거나 Esc면 끝.
    let session = null;
    const selectStop = () => { const stop = session.stops[session.index]; textarea.setSelectionRange(stop.start, stop.end); updateCursor(); };
    const insertSnippet = (start, end, body) => {
      const src = textarea.value, indent = src.slice(src.lastIndexOf("\n", start-1)+1, start).match(/^[ \t]*/)[0], {text, stops, final} = expandSnippet(body, indent);
      beforeEdit(); textarea.setRangeText(text, start, end, "end");
      session = stops.length ? {stops:stops.map(s => ({start:start+s.start, end:start+s.end})), index:0, final:start+final, length:textarea.value.length} : null;
      if(session) { const stop = session.stops[0]; textarea.setSelectionRange(stop.start, stop.end); } else textarea.setSelectionRange(start+final, start+final);
      textarea.dispatchEvent(new Event("input",{bubbles:true}));
    };
    const trackSnippetEdit = () => {
      if(!session) return; const delta = textarea.value.length - session.length; session.length = textarea.value.length; if(!delta) return;
      const stop = session.stops[session.index], caret = textarea.selectionStart, oldEnd = stop.end;
      if(caret < stop.start || caret > oldEnd + Math.max(delta, 0)) { session = null; return; }
      stop.end += delta; for(const other of session.stops) if(other !== stop && other.start >= oldEnd) { other.start += delta; other.end += delta; }
      if(session.final >= oldEnd) session.final += delta;
    };
    const nextStop = back => {
      if(!session) return false; session.index += back ? -1 : 1;
      if(session.index < 0) session.index = 0;
      if(session.index >= session.stops.length) { const at = session.final; session = null; textarea.setSelectionRange(at, at); updateCursor(); return true; }
      selectStop(); return true;
    };
    const checkSnippetSession = () => {
      if(!session) return; const a = textarea.selectionStart, first = session.stops[0].start, lastStop = Math.max(session.final, ...session.stops.map(s => s.end));
      if(a < first || a > lastStop) session = null;
    };
    // ==== 자동 완성 ====
    // 순위: 접두어 일치 > 단어 경계(camelCase·_) 일치 > 연속 일치. 첫 글자는 이름의 시작이나 단어 경계와 맞아야 한다.
    const boundaryAt = (s, i) => i === 0 || s[i-1] === "_" || s[i-1] === "-" || (/[A-Z]/.test(s[i]) && /[a-z0-9]/.test(s[i-1])) || (/\d/.test(s[i]) && !/\d/.test(s[i-1]));
    const fuzzy = (label, query) => {
      if(!query) return {score:0, hits:[]};
      const lower = label.toLowerCase(), q = query.toLowerCase(), hits = []; let from = 0, score = 0, prev = -2;
      for(let k = 0; k < q.length; k++) {
        let i = lower.indexOf(q[k], from); if(i < 0) return null;
        if(i !== prev + 1) for(let j = i; j >= 0; j = lower.indexOf(q[k], j+1)) if(boundaryAt(label, j)) { i = j; break; }   // 경계 위치 우선
        score += i === prev + 1 ? 5 : boundaryAt(label, i) ? 3 : 0; if(label[i] === query[k]) score += 1;
        hits.push(i); prev = i; from = i + 1;
      }
      if(!boundaryAt(label, hits[0])) return null;
      if(lower.startsWith(q)) score += 30; if(label.startsWith(query)) score += 5;
      return {score:score - label.length * 0.05, hits};
    };
    const KIND_ORDER = {variable:0, field:0, function:1, uniform:2, constant:2, builtin:3, "builtin-var":3, type:4, keyword:5, snippet:6, library:7};
    const KIND_ICON = {variable:"x", field:"·", function:"ƒ", uniform:"u", constant:"#", builtin:"ƒ", "builtin-var":"g", type:"T", keyword:"k", snippet:"{}", library:"+"};
    const KIND_NAME = {variable:"변수", field:"필드", function:"이 패스의 함수", uniform:"Uniform", constant:"#define", builtin:"내장 함수", "builtin-var":"내장 변수", type:"타입", keyword:"키워드", snippet:"코드 템플릿", library:"코드 조각 모음"};
    // 스위즐: vecN 뒤의 '.'에서 x·y·z·w(rgba) 조합을 제안
    const swizzleItems = type => {
      const m = /^([biu]?)vec([234])$/.exec(type); if(!m) return [];
      const n = Number(m[2]), base = {b:"bool", i:"int", u:"uint", "":"float"}[m[1]], vec = k => k === 1 ? base : `${m[1]}vec${k}`;
      const set = ["x","y","z","w","xy","xz","yz","xyz","xyzw","r","g","b","a","rg","rgb","rgba","yx","zyx"];
      return set.filter(s => [...s].every(c => ("xyzw".indexOf(c) >= 0 ? "xyzw".indexOf(c) : "rgba".indexOf(c)) < n)).map(s => ({label:s, kind:"field", detail:vec(s.length), desc:`${type}의 성분 ${s}`}));
    };
    let shown = [], chosen = 0, wordStart = 0, wordEnd = 0;
    const completion = $("studioCompletion"), list = document.createElement("div"), docPane = document.createElement("div");
    list.className = "completion-list"; docPane.className = "completion-doc"; completion.replaceChildren(list, docPane);
    const hideCompletion = () => { completion.hidden = true; shown = []; };
    const gatherItems = (src, at, start) => {
      // 멤버 완성: 이름 뒤 '.' → 벡터 스위즐 또는 구조체 필드
      if(src[start-1] === ".") {
        const owner = src.slice(0, start-1).match(/([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*$/)?.[1]; if(!owner) return {items:[], member:true};
        const type = typeOf(owner, start), struct = symbolsOf(src).structs.get(type);
        return {member:true, items:struct ? struct.fields.map(f => ({label:f.name, kind:"field", detail:f.type, desc:`${type}의 필드`})) : swizzleItems(type)};
      }
      const sym = symbolsOf(src), items = [], seen = new Set(), add = item => { const key = `${item.kind === "snippet" ? "s" : "n"}:${item.label}`; if(!seen.has(key)) { seen.add(key); items.push(item); } };
      const nearest = new Map(); for(const v of sym.variables) if(v.offset < start || !nearest.has(v.name)) nearest.set(v.name, v);
      for(const v of nearest.values()) if(v.offset !== start) add({label:v.name, kind:v.uniform ? "uniform" : "variable", detail:`${v.uniform ? "uniform " : ""}${v.type}`, desc:APP_UNIFORMS.find(u => u[0] === v.name)?.[2] || `${v.line}번째 줄에서 선언`});
      for(const f of sym.functions) add({label:f.name, kind:"function", detail:`${f.ret} ${f.name}(${f.params})`, desc:`이 패스의 함수 · ${f.line}번째 줄`});
      for(const [name, s] of sym.structs) add({label:name, kind:"type", detail:"struct", desc:s.fields.map(f => `${f.type} ${f.name}`).join(" · ")});
      for(const d of sym.defines) add({label:d.name, kind:"constant", detail:`#define ${d.value}`.trim(), desc:`${d.line}번째 줄`});
      for(const u of userUniforms()) add({label:u.name, kind:"uniform", detail:`uniform ${u.type}`, desc:"파라미터 패널에 등록된 값 · 선언은 자동으로 추가됩니다"});
      for(const [name, type, desc, declare] of APP_UNIFORMS) add({label:name, kind:"uniform", detail:`uniform ${type}`, desc:`${desc} · 고르면 선언도 함께 추가합니다`, declare:declare || `uniform ${type} ${name};`});
      const builtins = options.builtins?.length ? options.builtins : [...highlighter.builtins].map(name => ({name, sig:"", desc:""}));   // 레퍼런스 없이 쓰일 때의 최소 목록
      for(const item of builtins) if(isIdent(item.name)) add({label:item.name, kind:item.name.startsWith("gl_") ? "builtin-var" : "builtin", detail:item.sig.split(" · ")[0], desc:item.desc, sig:item.sig});
      for(const name of TYPES) add({label:name, kind:"type", detail:"타입", desc:/^[biu]?vec|^mat/.test(name) ? "생성자로도 씁니다: " + name + "(…)" : ""});
      for(const name of KEYWORDS) add({label:name, kind:"keyword", detail:"키워드", desc:""});
      for(const s of SNIPPETS) add({label:s.label, kind:"snippet", detail:s.detail, desc:"Tab으로 다음 자리로 이동", body:s.body});
      const defined = new Set(sym.functions.map(f => f.name));
      for(const lib of options.library?.items || []) if(!defined.has(lib.name)) add({label:lib.name, kind:"library", detail:lib.title, desc:`${lib.desc} · 고르면 함수 정의(필요한 함수 포함)를 위쪽에 추가합니다`, id:lib.id});
      return {items, member:false};
    };
    // 선언 자리(타입 다음에 새 이름을 쓰는 중)에서는 저절로 띄우지 않는다.
    const declaringName = (src, start) => /(?:^|[\s(,;{])(?:(?:const|uniform|in|out|inout|highp|mediump|lowp)\s+)*(?:void|float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?|[iu]?sampler2D|struct|[A-Z]\w*)\s+$/.test(src.slice(Math.max(0, start-80), start));
    const showCompletion = (mode = "explicit") => {
      const at = textarea.selectionStart, src = textarea.value;
      if(at !== textarea.selectionEnd || codeMode(at) || /^[ \t]*#/.test(src.slice(src.lastIndexOf("\n", at-1)+1, at))) return hideCompletion();
      const prefix = src.slice(0, at).match(/[A-Za-z_]\w*$/)?.[0] || "", start = at - prefix.length;
      if(/\d/.test(src[start-1] || "")) return hideCompletion();
      if(src[start-1] === "." && /(?:^|[^\w])\d+$/.test(src.slice(0, start-1))) return hideCompletion();   // 1.5 같은 숫자 리터럴
      const {items, member} = gatherItems(src, at, start);
      if(mode === "auto" && !member && (!prefix || declaringName(src, start))) return hideCompletion();
      wordStart = start; wordEnd = at + (src.slice(at).match(/^\w*/)?.[0].length || 0);
      const word = src.slice(wordStart, wordEnd);
      // 멤버(스위즐·필드)는 입력 전에는 자연스러운 순서(x, y, xy …)를 그대로 쓴다.
      let ranked = items.map((item, order) => { const m = fuzzy(item.label, prefix); return m && {...item, ...m, score:m.score - (member && !prefix ? order * 0.01 : 0)}; }).filter(Boolean);
      // 이미 완성된 이름이고 그보다 긴 후보도 없으면 같은 이름의 템플릿만 남긴다(불필요한 목록을 띄우지 않음).
      if(prefix && ranked.some(item => item.label === word && item.kind !== "snippet") && !ranked.some(item => item.label !== word && item.label.startsWith(word)))
        ranked = ranked.filter(item => item.kind === "snippet" && item.label === word);
      // 일치 점수가 같으면 종류(이 파일의 이름 > Uniform > 내장 함수 > 타입 > 키워드 > 템플릿 > 조각 모음)가 순위를 정한다.
      const rank = item => item.score + (8 - KIND_ORDER[item.kind]) * 0.4;
      ranked.sort((a, b) => (rank(b) - rank(a)) || (a.label.length - b.label.length) || a.label.localeCompare(b.label));
      shown = ranked.slice(0, 60); if(!shown.length) return hideCompletion();
      chosen = 0; completion.hidden = false; renderCompletion(); placeCompletion();
    };
    const labelWithHits = (label, hits) => {
      const span = document.createElement("span"); span.className = "completion-label"; let run = null;
      [...label].forEach((ch, i) => { if(hits.includes(i)) { if(!run) { run = document.createElement("b"); span.append(run); } run.textContent += ch; } else { run = null; span.append(document.createTextNode(ch)); } });
      span.normalize?.(); return span;
    };
    const renderDoc = () => {
      const item = shown[chosen]; if(!item || (!item.desc && !item.body && !item.sig)) { docPane.hidden = true; return; }
      const head = document.createElement("div"); head.className = "completion-doc-head";
      const kind = document.createElement("span"); kind.textContent = KIND_NAME[item.kind]; head.append(kind);
      const code = document.createElement("code"); code.textContent = item.kind === "snippet" ? expandSnippet(item.body, "").text : (item.sig || item.detail);
      const desc = document.createElement("p"); desc.textContent = item.desc || "";
      docPane.replaceChildren(head, code, desc); docPane.hidden = false;
    };
    const renderCompletion = () => {
      list.replaceChildren(...shown.map((item, i) => {
        const button = document.createElement("button"); button.type = "button"; button.dataset.index = i; button.className = i === chosen ? "is-selected" : "";
        button.setAttribute("role","option"); button.setAttribute("aria-selected", String(i === chosen)); button.id = `studioCompletionItem${i}`;
        const icon = document.createElement("span"); icon.className = "completion-icon"; icon.dataset.kind = item.kind; icon.textContent = KIND_ICON[item.kind]; icon.title = KIND_NAME[item.kind];
        const detail = document.createElement("span"); detail.className = "completion-detail"; detail.textContent = item.detail || "";
        button.append(icon, labelWithHits(item.label, item.hits), detail); return button;
      }));
      textarea.setAttribute("aria-activedescendant", `studioCompletionItem${chosen}`);
      list.children[chosen]?.scrollIntoView?.({block:"nearest"}); renderDoc();
    };
    const moveChoice = step => { chosen = (chosen + step + shown.length) % shown.length; renderCompletion(); };
    // 목록은 단어 시작 위치 바로 아래(공간이 없으면 위)에, 설명 칸은 옆(좁으면 아래)에 둔다.
    const placeCompletion = () => {
      if(!surface) return; const coords = caretCoords(wordStart), narrow = surface.clientWidth < 620;
      completion.classList.toggle("doc-below", narrow);
      const width = completion.offsetWidth, height = completion.offsetHeight;
      completion.style.left = `${Math.max(4, Math.min(coords.left - 26, surface.clientWidth - width - 4))}px`;
      const below = coords.top + coords.height + 2, above = coords.top - height - 2;
      completion.style.top = `${below + height > surface.clientHeight && above >= 0 ? above : below}px`;
    };
    const declarationInsertAt = src => { const clean = cleanOf(src), m = /^[\s\S]*?\bprecision\s+\w+\s+float\s*;[^\n]*\n?/.exec(clean) || /^#version[^\n]*\n?/.exec(src); return m ? m[0].length : 0; };
    const acceptCompletion = () => {
      const item = shown[chosen]; if(completion.hidden || !item) return; hideCompletion(); textarea.removeAttribute("aria-activedescendant");
      if(item.kind === "snippet") return insertSnippet(wordStart, wordEnd, item.body);
      beforeEdit(); textarea.setRangeText(item.label, wordStart, wordEnd, "end");
      if(item.kind === "library" && options.library?.insert?.(item.id)) return;   // 함수 정의 삽입까지 한 번의 편집으로 반영
      if(item.declare && !new RegExp(`\\buniform\\s+\\w+\\s+${escapeRe(item.label)}\\b`).test(cleanOf(textarea.value))) {
        const at = declarationInsertAt(textarea.value); textarea.setRangeText(item.declare + "\n", at, at, "preserve");
        options.notify?.(`${item.label} 선언(${item.declare})을 맨 위에 함께 추가했습니다 · Ctrl+Z로 되돌리기`);
      }
      textarea.dispatchEvent(new Event("input",{bubbles:true})); updateCursor();
    };
    listen(completion,"pointerdown",event=>event.preventDefault());
    listen(completion,"click",event=>{const item=event.target.closest("button[data-index]");if(item){chosen=Number(item.dataset.index);acceptCompletion();textarea.focus();}});
    listen($("studioComplete"),"click",()=>{textarea.focus();showCompletion("explicit");});
    // ==== 이동·리팩터링: 정의로 이동(F12·Ctrl+클릭), 이름 바꾸기(F2), 줄 단위 편집 ====
    const selectRange = (start, end) => { textarea.focus(); textarea.setSelectionRange(start, end); if(!wrap) revealLine(lineAt(start)); updateLines(); };
    const definitionOf = (name, pos) => {
      const sym = symbolsOf(textarea.value), fn = sym.functions.find(f => f.name === name); if(fn) return fn.offset;
      const struct = sym.structs.get(name); if(struct) return struct.offset;
      const define = sym.defines.find(d => d.name === name); if(define) return define.offset;
      const vars = sym.variables.filter(v => v.name === name); if(!vars.length) return -1;
      return (vars.filter(v => v.offset <= pos).pop() || vars[0]).offset;
    };
    const goToDefinition = (pos = textarea.selectionStart) => {
      const found = wordAround(textarea.value, pos); if(!found) return false;
      const at = definitionOf(found.word, found.start);
      if(at < 0) { options.notify?.(options.lookup?.(found.word) ? `${found.word}은(는) 내장 함수입니다 · 마우스를 올리면 설명을 볼 수 있습니다` : `${found.word}의 정의를 이 패스에서 찾지 못했습니다`); return false; }
      selectRange(at, at + found.word.length); return true;
    };
    const renameSymbol = async () => {
      const found = wordAround(textarea.value, textarea.selectionStart); if(!found || KEYWORDS.includes(found.word) || TYPES.includes(found.word)) { options.notify?.("이름을 바꿀 변수나 함수 위에 커서를 두세요"); return; }
      const next = await ask({title:`'${found.word}' 이름 바꾸기`, message:"이 패스 안의 같은 이름을 모두 바꿉니다(주석·문자열과 '.' 뒤의 필드 이름은 제외).", value:found.word, label:"새 이름", ok:"바꾸기"});
      if(next === null || next === found.word) return;
      if(!isIdent(next) || KEYWORDS.includes(next) || TYPES.includes(next)) { options.notify?.(`'${next}'은(는) 쓸 수 없는 이름입니다`); return; }
      const src = textarea.value, clean = cleanOf(src), spots = [...clean.matchAll(new RegExp(`\\b${escapeRe(found.word)}\\b`, "g"))].map(m => m.index).filter(at => clean[at-1] !== ".");
      if(!spots.length) return; let out = "", last = 0; for(const at of spots) { out += src.slice(last, at) + next; last = at + found.word.length; } out += src.slice(last);
      const caret = textarea.selectionStart + spots.filter(at => at < textarea.selectionStart).length * (next.length - found.word.length);
      replaceSelection(out, 0, src.length); textarea.setSelectionRange(caret, caret); updateCursor();
      options.notify?.(`${found.word} → ${next} · ${spots.length}곳을 바꿨습니다 · Ctrl+Z로 되돌리기`);
    };
    const lineSpan = () => { const src = textarea.value, a = textarea.selectionStart, b = textarea.selectionEnd, last = b > a && src[b-1] === "\n" ? b-1 : b;
      const from = src.lastIndexOf("\n", a-1)+1, stop = src.indexOf("\n", last); return {src, from, to:stop < 0 ? src.length : stop}; };
    const deleteLines = () => {
      const {src, from, to} = lineSpan(), column = textarea.selectionStart - from, start = from > 0 && to === src.length ? from-1 : from, end = to < src.length ? to+1 : to;
      replaceSelection("", start, end); const next = Math.min(textarea.value.length, start + (start < from ? 1 : 0)), lineEnd = textarea.value.indexOf("\n", next);
      const caret = Math.min(next + column, lineEnd < 0 ? textarea.value.length : lineEnd); textarea.setSelectionRange(caret, caret); updateCursor();
    };
    const copyLines = down => {
      const {src, from, to} = lineSpan(), block = src.slice(from, to), a = textarea.selectionStart, b = textarea.selectionEnd;
      beforeEdit(); textarea.setRangeText(block + "\n", from, from, "preserve");
      if(down) textarea.setSelectionRange(a + block.length + 1, b + block.length + 1); else textarea.setSelectionRange(a, b);
      textarea.dispatchEvent(new Event("input",{bubbles:true}));
    };
    const selectLine = () => {
      const src = textarea.value, a = textarea.selectionStart, b = textarea.selectionEnd, from = src.lastIndexOf("\n", a-1)+1;
      const whole = a === from && (b === src.length || src[b-1] === "\n") && b > a, start = whole ? b : from, stop = src.indexOf("\n", start);
      textarea.setSelectionRange(whole ? from : from, stop < 0 ? src.length : stop+1); updateCursor();
    };
    const jumpToBracket = () => { const pair = matchBracket(textarea.value, textarea.selectionStart); if(!pair) return; const target = pair[0] === textarea.selectionStart || pair[0] === textarea.selectionStart-1 ? pair[1] : pair[0]; selectRange(target, target); };
    listen(textarea, "click", event => { if((event.ctrlKey || event.metaKey) && !event.altKey) { event.preventDefault(); goToDefinition(textarea.selectionStart); } });
    // ==== 명령 팔레트 (Ctrl+Shift+P · F1): 모든 명령을 이름으로 검색. '@'로 시작하면 심볼, ':'로 시작하면 줄 번호 ====
    const pane = textarea.closest(".studio-code-pane"), palette = document.createElement("div"), paletteInput = document.createElement("input"), paletteList = document.createElement("div");
    palette.className = "studio-palette"; palette.hidden = true; palette.setAttribute("role","dialog"); palette.setAttribute("aria-label","명령 팔레트");
    paletteInput.className = "studio-palette-input"; paletteInput.placeholder = "명령 검색 · @ 함수·변수로 이동 · : 줄 번호"; paletteInput.setAttribute("aria-label","명령 검색"); paletteInput.autocomplete = "off"; paletteInput.spellcheck = false;
    paletteList.className = "studio-palette-list"; paletteList.setAttribute("role","listbox"); palette.append(paletteInput, paletteList); pane?.append(palette);
    let commands = [], recent = [], paletteItems = [], paletteChoice = 0;
    const registerCommands = items => { commands = [...commands, ...items.filter(item => item && item.label && typeof item.run === "function")]; };
    const paletteEntries = () => {
      const value = paletteInput.value;
      if(value.startsWith(":")) { const line = Number(value.slice(1).trim()), total = lineAt(textarea.value.length);
        return [{label:Number.isInteger(line) && line > 0 ? `${Math.min(line, total)}번째 줄로 이동` : `이동할 줄 번호를 입력하세요 (1~${total})`, query:"", run:() => { if(line > 0) goToLine(Math.min(line, total)); }}]; }
      if(value.startsWith("@")) { const sym = symbolsOf(textarea.value), query = value.slice(1).trim();
        const all = [...sym.functions.map(f => ({label:f.name, hint:`ƒ ${f.ret} (${f.params})`, key:`${f.line}줄`, offset:f.offset})),
          ...[...sym.structs].map(([name, s]) => ({label:name, hint:"struct", key:`${s.line}줄`, offset:s.offset})),
          ...sym.defines.map(d => ({label:d.name, hint:"#define", key:`${d.line}줄`, offset:d.offset})),
          ...sym.variables.filter(v => v.uniform || v.output).map(v => ({label:v.name, hint:`${v.uniform ? "uniform" : "out"} ${v.type}`, key:`${v.line}줄`, offset:v.offset}))]
          .map(item => ({...item, run:() => selectRange(item.offset, item.offset + item.label.length)}));
        return {items:all, query}; }
      const query = value.startsWith(">") ? value.slice(1).trim() : value.trim();
      const ordered = query ? commands : [...recent.map(label => commands.find(c => c.label === label)).filter(Boolean), ...commands.filter(c => !recent.includes(c.label))];
      return {items:ordered, query};
    };
    const renderPalette = () => {
      const entries = paletteEntries(), items = Array.isArray(entries) ? entries : entries.items, query = Array.isArray(entries) ? "" : entries.query;
      paletteItems = (query ? items.map(item => { const m = fuzzy(item.label, query) || (item.hint && fuzzy(item.hint, query) && {score:-50, hits:[]}); return m && {...item, ...m}; }).filter(Boolean).sort((a, b) => b.score - a.score) : items.map(item => ({...item, hits:[]}))).slice(0, 80);
      paletteChoice = Math.min(paletteChoice, Math.max(0, paletteItems.length-1));
      paletteList.replaceChildren(...paletteItems.map((item, i) => {
        const button = document.createElement("button"); button.type = "button"; button.dataset.index = i; button.className = i === paletteChoice ? "is-selected" : ""; button.setAttribute("role","option"); button.setAttribute("aria-selected", String(i === paletteChoice));
        const label = labelWithHits(item.label, item.hits || []); const hint = document.createElement("span"); hint.className = "palette-hint"; hint.textContent = item.hint || (recent.includes(item.label) && !paletteInput.value ? "최근 사용" : "");
        button.append(label, hint); if(item.key) { const kbd = document.createElement("kbd"); kbd.textContent = item.key; button.append(kbd); } return button;
      }));
      if(!paletteItems.length) { const empty = document.createElement("p"); empty.className = "palette-empty"; empty.textContent = "일치하는 항목이 없습니다"; paletteList.append(empty); }
      paletteList.children[paletteChoice]?.scrollIntoView?.({block:"nearest"});
    };
    const openPalette = (prefix = "") => { hideCompletion(); palette.hidden = false; paletteInput.value = prefix; paletteChoice = 0; renderPalette(); paletteInput.focus(); };
    const closePalette = (refocus = true) => { if(palette.hidden) return; palette.hidden = true; if(refocus) textarea.focus(); };
    const runPaletteItem = index => {
      const item = paletteItems[index]; if(!item) return; closePalette(); textarea.focus();
      if(commands.includes(commands.find(c => c.label === item.label))) recent = [item.label, ...recent.filter(label => label !== item.label)].slice(0, 5);
      item.run();
    };
    listen(paletteInput, "input", () => { paletteChoice = 0; renderPalette(); });
    listen(paletteInput, "keydown", event => {
      if(event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if(paletteItems.length) { paletteChoice = (paletteChoice + (event.key === "ArrowDown" ? 1 : -1) + paletteItems.length) % paletteItems.length; renderPalette(); } }
      else if(event.key === "Enter") { event.preventDefault(); runPaletteItem(paletteChoice); }
      else if(event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePalette(); }
    });
    listen(paletteInput, "blur", () => setTimeout(() => { if(!palette.contains(document.activeElement)) closePalette(false); }, 0));
    listen(paletteList, "pointerdown", event => event.preventDefault());
    listen(paletteList, "click", event => { const item = event.target.closest("button[data-index]"); if(item) runPaletteItem(Number(item.dataset.index)); });
    listen($("studioPaletteOpen"), "click", () => openPalette());
    // 편집기가 열려 있으면 포커스가 코드 밖에 있어도 팔레트를 연다.
    listen(document, "keydown", event => {
      const open = (event.key === "F1" || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyP")) && textarea.offsetParent;
      if(open) { event.preventDefault(); event.stopPropagation(); openPalette(); }
    });
    registerCommands([
      {label:"자동 완성 열기", key:"Ctrl+Space", run:() => showCompletion("explicit")},
      {label:"찾기", key:"Ctrl+F", run:() => showFind()}, {label:"찾아 바꾸기", key:"Ctrl+H", run:() => showFind(true)},
      {label:"줄 번호로 이동", key:"Ctrl+G", run:() => openPalette(":")}, {label:"함수·변수로 이동", key:"Ctrl+Shift+O", run:() => openPalette("@")},
      {label:"정의로 이동", key:"F12", run:() => goToDefinition()}, {label:"이름 바꾸기 (같은 이름 모두)", key:"F2", run:renameSymbol},
      {label:"줄 주석 전환", key:"Ctrl+/", run:toggleComment}, {label:"줄 삭제", key:"Ctrl+Shift+K", run:deleteLines},
      {label:"줄을 아래로 복사", key:"Shift+Alt+↓", run:() => copyLines(true)}, {label:"줄을 위로 복사", key:"Shift+Alt+↑", run:() => copyLines(false)},
      {label:"줄을 아래로 이동", key:"Alt+↓", run:() => moveLines(true)}, {label:"줄을 위로 이동", key:"Alt+↑", run:() => moveLines(false)},
      {label:"줄 선택", key:"Ctrl+L", run:selectLine}, {label:"짝 괄호로 이동", key:"Ctrl+Shift+\\", run:jumpToBracket},
      {label:"들여쓰기", key:"Ctrl+]", run:() => indent(false, true)}, {label:"내어쓰기", key:"Ctrl+[", run:() => indent(true, true)},
      {label:"긴 줄 자동 줄바꿈 켜기/끄기", key:"Alt+Z", run:() => { wrap = !wrap; setPresentation(); }},
      {label:"글자 크게", run:() => { fontSize = Math.min(20, fontSize+1); setPresentation(); }}, {label:"글자 작게", run:() => { fontSize = Math.max(10, fontSize-1); setPresentation(); }},
      {label:"들여쓰기 크기 2 ↔ 4 바꾸기", run:() => { tabSize = tabSize === 4 ? 2 : 4; setPresentation(); }}]);
    listen(textarea,'blur',()=>{hideCompletion();hideSignature();hideHover();});listen(textarea,'click',hideCompletion);
    // 입력할 때: 이름 글자나 '.'을 치면 자동 완성을 띄우고, 지우면 목록을 갱신한다(VS Code의 빠른 제안).
    // 편집기가 직접 고친 내용(inputType 없음)·붙여넣기·여러 글자 입력은 목록을 닫는다.
    listen(textarea,'input',event=>{
      trackSnippetEdit();if(diagnostics.length)layer?.classList?.add("is-stale");updateLines();if(!findPanel.hidden)updateMatches();
      const type=event.inputType||"",data=event.data;
      if(type==="insertText"&&data&&data.length===1&&/[\w.]/.test(data))showCompletion("auto");
      else if(type.startsWith("deleteContent")&&!completion.hidden)showCompletion("auto");
      else hideCompletion();
    });
    listen(textarea,"scroll",()=>{gutter.scrollTop=textarea.scrollTop;
      highlight.scrollTop=textarea.scrollTop;highlight.scrollLeft=textarea.scrollLeft;if(diagnostics.length)renderDiagnostics();
      hideHover();scheduleDecorations();if(!completion.hidden)placeCompletion();if(!signature?.hidden)updateSignature();});
    for(const type of ["click","keyup","select"])listen(textarea,type,updateCursor);
    // 후보 목록은 커서가 접힌 채로 완성 중인 단어 안에 있을 때만 유효하다. 범위를 선택했거나(Shift+화살표, 여러 줄 선택) 단어 밖으로 나가면 닫는다.
    const dropStaleCompletion = () => { const a = textarea.selectionStart, b = textarea.selectionEnd; if(!completion.hidden && (a !== b || a < wordStart || a > wordEnd)) hideCompletion(); };
    for(const type of ["keyup","select"])listen(textarea,type,dropStaleCompletion);
    listen(gutter,"click",e=>{const height=parseFloat(getComputedStyle(textarea).lineHeight)||fontSize*1.6;
      goToLine(Math.floor((e.clientY-gutter.getBoundingClientRect().top+gutter.scrollTop)/height)+1);
    }); listen(textarea,"keydown",event=>{
      if(event.isComposing)return;const cmd=event.ctrlKey||event.metaKey, start=textarea.selectionStart,end=textarea.selectionEnd,src=textarea.value;
      // 낡은 후보 목록은 닫고 원래 동작(들여쓰기·줄 이동 등)을 따른다. Shift 조합(선택 확장·내어쓰기)도 목록이 가로채지 않는다.
      dropStaleCompletion();
      if(!completion.hidden && ['ArrowDown','ArrowUp','PageDown','PageUp','Enter','Tab','Escape'].includes(event.key) && !cmd && !event.altKey && !event.shiftKey) {
        event.preventDefault();if(event.key==='Escape')hideCompletion();else if(event.key==='Enter'||event.key==='Tab')acceptCompletion();
        else if(event.key.startsWith('Page')){chosen=event.key==='PageDown'?Math.min(shown.length-1,chosen+8):Math.max(0,chosen-8);renderCompletion();}
        else moveChoice(event.key==='ArrowDown'?1:-1);
      } else if(session && event.key==="Tab" && !cmd && !event.altKey) {
        event.preventDefault();nextStop(event.shiftKey);
      } else if(session && event.key==="Escape") {
        session=null;
      } else if(cmd && !event.altKey && !event.shiftKey && event.code==='Space') {
        event.preventDefault();showCompletion("explicit");
      } else if(event.key==="F12" || (event.key==="F2" && !cmd)) {
        event.preventDefault();if(event.key==="F12")goToDefinition();else renameSymbol();
      } else if(cmd && event.shiftKey && !event.altKey && event.code==="KeyK") {
        event.preventDefault();deleteLines();
      } else if(cmd && event.shiftKey && !event.altKey && event.code==="KeyO") {
        event.preventDefault();openPalette("@");
      } else if(cmd && event.shiftKey && !event.altKey && event.code==="Backslash") {
        event.preventDefault();jumpToBracket();
      } else if(cmd && !event.shiftKey && !event.altKey && event.code==="KeyL") {
        event.preventDefault();selectLine();
      } else if(event.altKey && !cmd && !event.shiftKey && event.code==="KeyZ") {
        event.preventDefault();wrap=!wrap;setPresentation();
      } else if(event.altKey && event.shiftKey && !cmd && ["ArrowUp","ArrowDown"].includes(event.key)) {
        event.preventDefault();copyLines(event.key==="ArrowDown");
      } else if(cmd && !event.altKey && ["ArrowUp","ArrowDown"].includes(event.key) && nudgeNumber(event.key==="ArrowUp"?1:-1, event.shiftKey?10:1)) {
        event.preventDefault();
      } else if(event.altKey && !cmd && !event.shiftKey && ["ArrowUp","ArrowDown"].includes(event.key)) {
        event.preventDefault();moveLines(event.key==="ArrowDown");
      } else if(!cmd && !event.altKey && Object.hasOwn(pairs,event.key)) {
        const key=event.key,mode=codeMode(start),selected=src.slice(start,end);
        if(!mode && !(key==='"'&&src[start]==='"'&&start===end)) {
          event.preventDefault();replaceSelection(key+selected+pairs[key]);textarea.setSelectionRange(start+1,start+1+selected.length);updateCursor();
        } else if(key==='"'&&mode==="string"&&src[start]==='"'&&start===end){event.preventDefault();textarea.setSelectionRange(start+1,start+1);updateCursor();}
      } else if(event.key==="}" && !cmd && !event.altKey && start===end && /^[ \t]+$/.test(src.slice(src.lastIndexOf("\n",start-1)+1,start)) && !codeMode(start)) {
        const prefix=src.slice(src.lastIndexOf("\n",start-1)+1,start),cut=prefix.match(new RegExp(`(?: {1,${tabSize}}|\\t)$`))[0].length,skip=src[start]==="}";
        event.preventDefault();replaceSelection(skip?"":"}",start-cut,start);
        if(skip)textarea.setSelectionRange(start-cut+1,start-cut+1);updateCursor();
      } else if(!cmd && !event.altKey && start===end && ")]}".includes(event.key) && src[start]===event.key && !codeMode(start)) {
        event.preventDefault();textarea.setSelectionRange(start+1,start+1);updateCursor();
      } else if(event.key==="Enter" && !cmd && !event.shiftKey && !event.altKey) {
        const before=src.slice(0,start).split("\n").pop(),base=before.match(/^[ \t]*/)[0],opens=!codeMode(start)&&/{[ \t]*$/.test(before),pad=base+(opens?" ".repeat(tabSize):"");
        const tail=src.slice(start).split("\n")[0],after=tail.match(/^[ \t]*/)[0].length,trim=opens?before.match(/[ \t]*$/)[0].length:0;
        if(start===end && opens && tail.slice(after).startsWith("}")){event.preventDefault();replaceSelection("\n"+pad+"\n"+base,start-trim,start+after);textarea.setSelectionRange(start-trim+1+pad.length,start-trim+1+pad.length);updateCursor();}
        else if(pad){event.preventDefault();replaceSelection("\n"+pad,start-trim,end);}
      } else if(cmd && event.shiftKey && event.key.toLowerCase()==="d") {
        event.preventDefault();const src=textarea.value,p=textarea.selectionStart;
        const start=src.lastIndexOf("\n",p-1)+1,next=src.indexOf("\n",p),end=next<0?src.length:next;
        beforeEdit();textarea.setRangeText("\n"+src.slice(start,end),end,end,"end"); const caret=end+1+p-start;textarea.setSelectionRange(caret,caret);
        textarea.dispatchEvent(new Event("input",{bubbles:true}));
      } else if(event.key==="Backspace" && !cmd && !event.altKey && start===end) {
        const left=src.slice(src.lastIndexOf("\n",end-1)+1,end);
        if(end>0 && end<src.length && Object.hasOwn(pairs,src[end-1]) && pairs[src[end-1]]===src[end] && !codeMode(end-1)){event.preventDefault();replaceSelection("",end-1,end+1);}
        else if(left && /^ +$/.test(left)) {event.preventDefault();replaceSelection("",end-Math.min(left.length,tabSize),end);}
      } else if(event.key==="Home" && !event.shiftKey && !cmd && !event.altKey) {
        const p=textarea.selectionStart, start=textarea.value.lastIndexOf("\n",p-1)+1;
        const indentEnd=start+(textarea.value.slice(start).match(/^[ \t]*/)?.[0].length||0);
        event.preventDefault();textarea.setSelectionRange(p===indentEnd?start:indentEnd,p===indentEnd?start:indentEnd);updateCursor();
      } else if(event.key==="Tab" || (cmd && ["BracketLeft","BracketRight"].includes(event.code))) {
        event.preventDefault();indent(event.key==="Tab"?event.shiftKey:event.code==="BracketLeft",event.key!=="Tab");
      } else if(cmd&&event.key==="/") {event.preventDefault();toggleComment();}
      else if(cmd&&event.key.toLowerCase()==="f") {event.preventDefault();showFind();}
      else if(cmd&&event.key.toLowerCase()==="h") {event.preventDefault();showFind(true);}
      else if(cmd&&event.key.toLowerCase()==="g") {event.preventDefault();$("studioGoto").click();}
      else if(event.key==="F3") {event.preventDefault();findNext(event.shiftKey);}
    });
    listen(query,"input",updateMatches); listen(query,"keydown",event=>{if(event.key==="Enter"){event.preventDefault();findNext(event.shiftKey);}if(event.key==="Escape")closeFind();});
    listen(replacement,"keydown",event=>{if(event.key==="Enter"){event.preventDefault();doReplace(false);}if(event.key==="Escape")closeFind();});
    listen($("studioFindClose"),"click",closeFind);listen($("studioFindNext"),"click",()=>findNext(false));
    listen($("studioFindPrev"),"click",()=>findNext(true));listen($("studioReplaceOne"),"click",()=>doReplace(false));
    listen($("studioReplaceAll"),"click",()=>doReplace(true));
    listen($("studioFind"),"click",()=>showFind());listen($("studioReplace"),"click",()=>showFind(true));
    listen(symbols,"change",()=>{if(symbols.value)goToLine(Number(symbols.value));symbols.value="";});
    listen($("studioGoto"),"click",async()=>{const input=await ask({title:"줄 번호로 이동",message:"이동할 줄을 입력하세요.",value:String(lineAt(textarea.selectionStart)),label:"줄 번호",type:"number",min:1,max:lineAt(textarea.value.length),ok:"이동"});if(input!==null)goToLine(Number(input));});
    listen($("studioZoomIn"),"click",()=>{fontSize=Math.min(20,fontSize+1);setPresentation();});
    listen($("studioZoomOut"),"click",()=>{fontSize=Math.max(10,fontSize-1);setPresentation();});
    listen($("studioLineWrap"),"click",()=>{wrap=!wrap;setPresentation();});
    listen($("studioIndent"),"change",event=>{tabSize=event.target.value==="2"?2:4;setPresentation();});setPresentation();
    return {update:()=>{hideCompletion();session=null;updateLines();renderDiagnostics();},goToLine,showFind,setDiagnostics,registerCommands,openPalette,
      dispose:()=>{hideCompletion();hideHover();ac.abort();if(paintRequest)cancelAnimationFrame(paintRequest);clearTimeout(decoRequest);
        for(const node of [palette,hover,mirror,decorations])node.remove?.();}};
  }; export {mount};
