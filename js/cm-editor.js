// CodeMirror 6 기반 편집기 (실험). code-editor.js와 같은 mount API를 제공한다.
// studio.js는 #studioCode textarea를 직접 읽고 쓰므로, 그 textarea를 CodeMirror 문서의 "창구(facade)"로 만든다:
// value·selectionStart/End·setSelectionRange·setRangeText·scrollTop·focus는 CodeMirror 상태를 읽고 쓰며,
// 사용자의 편집·선택·키 입력은 textarea의 input·select·keydown 이벤트로 다시 알린다. 되돌리기는 지금처럼 studio가 맡는다(CodeMirror history 미사용).
import * as CodeMirror from "./codemirror.js";
import * as Highlight from "./glsl-highlight.js";
import * as Language from "./glsl-language.js";
  const mount = (textarea, ask, beforeEdit = () => {}, uniformNames = () => [], options = {}) => {
    const CM = CodeMirror.load();   // CodeMirror는 이 엔진을 실제로 쓸 때 처음 초기화한다(기본 편집기 사용 시 비용 없음)
    const $ = id => document.getElementById(id), ac = new AbortController(), signal = ac.signal;
    const listen = (target, type, fn, opts = {}) => target?.addEventListener(type, fn, {...opts, signal});
    const highlighter = Highlight.create((options.builtins || []).map(item => item.name));
    let view = null;
    const language = Language.create({options, uniformNames, highlighter, source:() => view ? view.state.doc.toString() : textarea.value});
    const {APP_UNIFORMS, symbolsOf, describeSymbol, gatherItems, declaringName, KIND_ORDER, KIND_NAME, cleanOf, fuzzy} = language;
    const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // ---- 표시 설정: 기본 편집기와 같은 저장값(글자 크기·줄바꿈·들여쓰기)을 쓴다 ----
    const STATE_KEY = "webgl.shader-studio.editor.v2"; let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || "{}") || {}; } catch (_) {}
    let fontSize = Number.isInteger(saved.fontSize) ? Math.max(10, Math.min(20, saved.fontSize)) : 12, wrap = !!saved.wrap, tabSize = saved.tabSize === 2 ? 2 : 4;
    const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify({...saved, fontSize, wrap, tabSize})); } catch (_) {} };
    const fontComp = new CM.Compartment(), wrapComp = new CM.Compartment(), tabComp = new CM.Compartment();
    const fontTheme = () => CM.EditorView.theme({"&":{fontSize:`${fontSize}px`}});
    const tabConfig = () => [CM.EditorState.tabSize.of(tabSize), CM.indentUnit.of(" ".repeat(tabSize))];

    // ---- GLSL 문법 강조: glsl-highlight.js와 같은 규칙·색(.glsl-* 클래스) ----
    const CLASSES = ["glsl-keyword","glsl-type","glsl-number","glsl-comment","glsl-string","glsl-directive","glsl-builtin","glsl-function"];
    const tokenTable = Object.fromEntries(CLASSES.map(name => [name, CM.Tag.define()]));
    const glsl = CM.StreamLanguage.define({
      name:"glsl",
      startState:() => ({comment:false, depth:0}),
      copyState:state => ({comment:state.comment, depth:state.depth}),
      token(stream, state) {
        const closeComment = () => { if(stream.skipTo("*/")) { stream.pos += 2; state.comment = false; } else stream.skipToEnd(); return "glsl-comment"; };
        if(state.comment) return closeComment();
        if(stream.eatSpace()) return null;
        if(stream.match("//")) { stream.skipToEnd(); return "glsl-comment"; }
        if(stream.match("/*")) { state.comment = true; return closeComment(); }
        if(stream.peek() === "#") { stream.skipToEnd(); return "glsl-directive"; }
        if(stream.match(/^"(?:\\.|[^"\\])*"?/)) return "glsl-string";
        if(stream.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[uU]?/)) return "glsl-number";
        const word = stream.match(/^[A-Za-z_]\w*/);
        if(word) {
          const name = word[0], kind = highlighter.tokenClass(name);
          if(kind === "glsl-keyword" || kind === "glsl-type") return kind;
          if(name.startsWith("gl_")) return "glsl-builtin";
          return /^\s*\(/.test(stream.string.slice(stream.pos)) ? kind : null;   // 호출(이름 + '(')만 함수 색
        }
        const ch = stream.next(); if(ch === "{") state.depth++; else if(ch === "}") state.depth = Math.max(0, state.depth - 1); return null;
      },
      // 들여쓰기: 열린 '{' 수만큼 한 단계씩. 줄이 '}'로 시작하면 한 단계 덜.
      indent:(state, textAfter, cx) => Math.max(0, state.depth - (/^\s*\}/.test(textAfter) ? 1 : 0)) * cx.unit,
      languageData:{commentTokens:{line:"//", block:{open:"/*", close:"*/"}}, closeBrackets:{brackets:["(", "[", "{", '"']}, indentOnInput:/^\s*\}$/},
      tokenTable
    });
    const glslStyle = CM.HighlightStyle.define(CLASSES.map(name => ({tag:tokenTable[name], class:name})));

    // ---- 코드 접기: 줄 끝의 '{'부터 짝 '}'까지 (주석·문자열 안의 괄호는 무시) ----
    let cleanFor = {doc:null, text:""};
    const cleanDoc = state => { if(cleanFor.doc !== state.doc) cleanFor = {doc:state.doc, text:cleanOf(state.doc.toString())}; return cleanFor.text; };
    const braceFold = CM.foldService.of((state, from, to) => {
      const clean = cleanDoc(state), open = clean.slice(from, to).lastIndexOf("{"); if(open < 0) return null;
      for(let i = from + open + 1, depth = 0; i < clean.length; i++) {
        if(clean[i] === "{") depth++;
        else if(clean[i] === "}") { if(depth) { depth--; continue; } return i > to ? {from:from + open + 1, to:i} : null; }
      }
      return null;
    });

    // ---- 자동 완성: glsl-language.js의 후보(이 패스의 이름·Uniform·내장 함수·타입·템플릿·코드 조각)를 CodeMirror 목록으로 ----
    const COMPLETION_TYPE = {variable:"variable", field:"property", function:"function", uniform:"variable", constant:"constant", builtin:"function", "builtin-var":"variable", type:"type", keyword:"keyword", snippet:"text", library:"namespace"};
    const infoNode = item => {
      const box = document.createElement("div"); box.className = "cm-glsl-info";
      const kind = document.createElement("small"); kind.textContent = KIND_NAME[item.kind] || ""; box.append(kind);
      if(item.sig || item.detail) { const code = document.createElement("code"); Highlight.create().paint(code, item.sig || item.detail); box.append(code); }
      if(item.desc) { const p = document.createElement("p"); p.textContent = item.desc; box.append(p); }
      return box;
    };
    const declarationInsertAt = src => { const clean = cleanOf(src), m = /^[\s\S]*?\bprecision\s+\w+\s+float\s*;[^\n]*\n?/.exec(clean) || /^#version[^\n]*\n?/.exec(src); return m ? m[0].length : 0; };
    // 템플릿 본문($1 · ${1:값} · $0)을 CodeMirror snippet 형식으로 바꾼다.
    const toSnippet = body => body.replace(/\$\{(\d+):([^}]*)\}/g, "${$1:$2}").replace(/\$0/g, "${}").replace(/\$(\d+)/g, "${$1}");
    const applyItem = item => (editorView, completion, from, to) => {
      if(item.kind === "snippet") return CM.snippet(toSnippet(item.body))(editorView, completion, from, to);
      editorView.dispatch({changes:{from, to, insert:item.label}, selection:{anchor:from + item.label.length}, userEvent:"input.complete"});
      if(item.kind === "library" && options.library?.insert?.(item.id)) return;
      const src = editorView.state.doc.toString();
      if(item.declare && !new RegExp(`\\buniform\\s+\\w+\\s+${escapeRe(item.label)}\\b`).test(cleanOf(src))) {
        const at = declarationInsertAt(src); editorView.dispatch({changes:{from:at, insert:item.declare + "\n"}, userEvent:"input.complete"});
        options.notify?.(`${item.label} 선언(${item.declare})을 맨 위에 함께 추가했습니다 · Ctrl+Z로 되돌리기`);
      }
    };
    const completionSource = context => {
      const src = context.state.doc.toString(), at = context.pos, clean = cleanOf(src);
      if(at > 0 && clean[at-1] !== src[at-1]) return null;   // 주석·문자열·전처리문 안
      const word = context.matchBefore(/[A-Za-z_]\w*/), start = word ? word.from : at;
      if(/\d/.test(src[start-1] || "")) return null;
      if(src[start-1] === "." && /(?:^|[^\w])\d+$/.test(src.slice(0, start-1))) return null;   // 1.5 같은 숫자
      const {items, member} = gatherItems(src, at, start);
      if(!context.explicit && !member && (!word || declaringName(src, start))) return null;
      return {from:start, validFor:/^\w*$/, options:items.map(item => ({label:item.label, type:COMPLETION_TYPE[item.kind], detail:item.kind === "snippet" ? "템플릿" : item.detail,
        boost:(8 - KIND_ORDER[item.kind]) * 4, info:item.desc || item.sig || item.body ? () => infoNode(item) : undefined, apply:applyItem(item)}))};
    };

    // ---- 마우스 설명: 이름 위에 머물면 내장 함수·변수·Uniform 설명 ----
    const hover = CM.hoverTooltip((editorView, pos) => {
      const word = editorView.state.wordAt(pos); if(!word) return null;
      const src = editorView.state.doc.toString(); if(cleanOf(src)[pos] !== src[pos]) return null;
      const info = describeSymbol(editorView.state.sliceDoc(word.from, word.to), pos); if(!info) return null;
      return {pos:word.from, end:word.to, above:true, create:() => ({dom:infoNode({kind:"", sig:info.sig, desc:info.desc})})};
    });

    // ---- textarea 창구(facade) ----
    const External = CM.Annotation.define();   // studio가 textarea API로 바꾼 것(=다시 input으로 알리지 않는다)
    const clamp = n => Math.max(0, Math.min(view.state.doc.length, Number(n) || 0));
    const setSelection = (a, b, direction = "none", scroll = false) => {
      a = clamp(a); b = clamp(b); if(b < a) a = b;   // textarea 규칙: 끝이 시작보다 앞이면 시작을 끝으로
      view.dispatch({selection:direction === "backward" ? {anchor:b, head:a} : {anchor:a, head:b}, annotations:External.of(true), scrollIntoView:scroll});
    };
    const facade = (name, descriptor) => Object.defineProperty(textarea, name, {configurable:true, ...descriptor});
    const inputTypeOf = tr => tr.isUserEvent("input.type.compose") ? "insertCompositionText" : tr.isUserEvent("input.type") ? "insertText" : tr.isUserEvent("delete") ? "deleteContentBackward"
      : tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop") ? "insertFromPaste" : "insertReplacementText";

    // ---- 화면 만들기 ----
    const frame = textarea.closest(".studio-editor-frame"), pane = textarea.closest(".studio-code-pane");
    frame?.classList.add("is-codemirror");
    const host = document.createElement("div"); host.className = "studio-cm-host"; frame?.append(host);
    const findPanel = $("studioFindPanel"); if(findPanel) findPanel.hidden = true;
    const position = $("studioCursor"), symbols = $("studioFunctions");
    const updateStatus = state => {
      const main = state.selection.main, line = state.doc.lineAt(main.head), count = state.selection.ranges.length;
      if(position) position.textContent = `Ln ${line.number}, Col ${main.head - line.from + 1}${count > 1 ? ` · 다중 선택 ${count}개` : main.empty ? "" : ` · ${main.to - main.from}자 선택`}`;
    };
    let functionsFor = null;
    const updateFunctions = () => {
      if(!symbols) return; const src = view.state.doc.toString(); if(src === functionsFor) return; functionsFor = src;
      const clean = cleanOf(src), entries = []; let depth = 0, pos = 0, line = 1;
      for(const m of clean.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*\{/g)) {
        for(; pos < m.index; pos++) { const ch = clean[pos]; if(ch === "{") depth++; else if(ch === "}") depth = Math.max(0, depth-1); else if(ch === "\n") line++; }
        if(!depth) entries.push({name:m[2], params:m[3].trim().replace(/\s+/g, " "), line});
      }
      symbols.replaceChildren(new Option(`ƒ 함수 (${entries.length})`, ""), ...entries.map(({name, params, line}) => new Option(`${name}(${params.slice(0,38)}${params.length > 38 ? "…" : ""}) · Ln ${line}`, String(line))));
      symbols.value = ""; symbols.disabled = !entries.length;
    };
    const editorTheme = CM.EditorView.theme({
      "&":{height:"100%", backgroundColor:"var(--sunken)", color:"#d6dbe8"},
      ".cm-scroller":{fontFamily:"var(--mono)", lineHeight:"1.65"},
      ".cm-content":{padding:"12px 0", caretColor:"var(--text)"},
      ".cm-gutters":{backgroundColor:"var(--sunken)", color:"var(--faint)", border:"none", borderRight:"1px solid var(--line)"},
      ".cm-activeLine":{backgroundColor:"#ffffff07"}, ".cm-activeLineGutter":{backgroundColor:"#ffffff07", color:"var(--text-soft)"},
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":{backgroundColor:"color-mix(in srgb, var(--accent) 34%, transparent) !important"},
      ".cm-cursor, .cm-dropCursor":{borderLeftColor:"var(--text)"},
      "&.cm-focused .cm-matchingBracket":{backgroundColor:"color-mix(in srgb, var(--accent) 22%, transparent)", outline:"1px solid color-mix(in srgb, var(--accent) 70%, transparent)"},
      ".cm-selectionMatch":{backgroundColor:"#6fe0e620"},
      ".cm-searchMatch":{backgroundColor:"#f3c46e2e", outline:"1px solid #f3c46e55"}, ".cm-searchMatch.cm-searchMatch-selected":{backgroundColor:"#f3c46e66"},
      ".cm-panels":{backgroundColor:"var(--elevated)", color:"var(--text-soft)"}, ".cm-panels.cm-panels-top":{borderBottom:"1px solid var(--line)"},
      ".cm-tooltip":{backgroundColor:"var(--elevated)", border:"1px solid var(--line-strong)", borderRadius:"8px", color:"var(--text-soft)"},
      ".cm-tooltip-autocomplete > ul > li[aria-selected]":{backgroundColor:"var(--accent-soft)", color:"var(--text)"},
      ".cm-foldPlaceholder":{backgroundColor:"var(--surface)", border:"1px solid var(--line-strong)", color:"var(--muted)"}
    }, {dark:true});

    const notifyTextarea = update => {
      if(update.docChanged && !update.transactions.some(tr => tr.annotation(External))) {
        const tr = update.transactions.find(t => t.docChanged), type = inputTypeOf(tr); let data = null;
        tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => { if(data === null && type === "insertText") data = inserted.toString(); });
        if(type === "insertText" && (data?.length !== 1 || update.state.selection.ranges.length > 1)) data = null;
        textarea.dispatchEvent(typeof InputEvent === "function" ? new InputEvent("input", {bubbles:true, inputType:data === null && type === "insertText" ? "insertReplacementText" : type, data}) : new Event("input", {bubbles:true}));
      }
      if(update.selectionSet && !update.transactions.some(tr => tr.annotation(External))) textarea.dispatchEvent(new Event("select"));
      if(update.docChanged || update.selectionSet) updateStatus(update.state);
      if(update.docChanged) updateFunctions();
    };
    // 키 입력은 먼저 textarea로 알린다(studio의 Ctrl+Z/Y·Alt+PageUp 등). studio가 처리하면 CodeMirror는 건너뛴다.
    const forwardKeys = CM.Prec.highest(CM.EditorView.domEventHandlers({
      keydown(event) {
        const clone = new KeyboardEvent("keydown", {key:event.key, code:event.code, ctrlKey:event.ctrlKey, metaKey:event.metaKey, shiftKey:event.shiftKey, altKey:event.altKey,
          repeat:event.repeat, isComposing:event.isComposing, bubbles:false, cancelable:true});
        textarea.dispatchEvent(clone); if(clone.defaultPrevented) { event.preventDefault(); return true; } return false;
      }
    }));
    // studio의 되돌리기 기록용: 사용자 편집 직전 커서를 알려 준다.
    const beforeUserEdit = CM.EditorState.transactionFilter.of(tr => { if(tr.docChanged && !tr.annotation(External)) beforeEdit(); return tr; });
    let commands = [];
    const editorKeys = [
      {key:"Mod-Space", run:CM.startCompletion},
      {key:"Mod-g", run:() => { openPalette(":"); return true; }},
      {key:"Mod-Shift-o", run:() => { openPalette("@"); return true; }},
      {key:"Mod-Shift-\\", run:CM.cursorMatchingBracket},
      {key:"Alt-z", run:() => { wrap = !wrap; applyPresentation(); return true; }},
      {key:"F1", run:() => { openPalette(); return true; }}, {key:"Mod-Shift-p", run:() => { openPalette(); return true; }}
    ];
    view = new CM.EditorView({
      parent:host,
      state:CM.EditorState.create({doc:textarea.value, extensions:[
        CM.lineNumbers(), CM.highlightActiveLineGutter(), CM.foldGutter(), CM.codeFolding(), braceFold,
        CM.highlightSpecialChars(), CM.drawSelection(), CM.dropCursor(), CM.EditorState.allowMultipleSelections.of(true),
        CM.rectangularSelection(), CM.crosshairCursor(), CM.highlightActiveLine(), CM.highlightSelectionMatches(),
        CM.indentOnInput(), CM.bracketMatching(), CM.closeBrackets(), glsl, CM.syntaxHighlighting(glslStyle),
        CM.autocompletion({override:[completionSource], icons:true, activateOnTyping:true}), hover, CM.lintGutter(),
        CM.search({top:true}), forwardKeys, beforeUserEdit,
        CM.keymap.of([...editorKeys, ...CM.closeBracketsKeymap, ...CM.completionKeymap, ...CM.searchKeymap, ...CM.foldKeymap, ...CM.lintKeymap, ...CM.defaultKeymap, CM.indentWithTab]),
        fontComp.of(fontTheme()), wrapComp.of(wrap ? CM.EditorView.lineWrapping : []), tabComp.of(tabConfig()), editorTheme,
        CM.EditorView.contentAttributes.of({"aria-label":"GLSL 코드 편집기", spellcheck:"false", autocorrect:"off", autocapitalize:"off"}),
        CM.EditorView.updateListener.of(notifyTextarea)
      ]})
    });
    facade("value", {get:() => view.state.doc.toString(), set:value => { value = String(value ?? ""); view.dispatch({changes:{from:0, to:view.state.doc.length, insert:value}, selection:{anchor:value.length}, annotations:External.of(true)}); }});
    facade("selectionStart", {get:() => view.state.selection.main.from, set:value => setSelection(value, Math.max(Number(value) || 0, view.state.selection.main.to))});
    facade("selectionEnd", {get:() => view.state.selection.main.to, set:value => setSelection(Math.min(view.state.selection.main.from, Number(value) || 0), value)});
    facade("selectionDirection", {get:() => { const m = view.state.selection.main; return m.empty ? "none" : m.head < m.anchor ? "backward" : "forward"; }, set:() => {}});
    facade("scrollTop", {get:() => view.scrollDOM.scrollTop, set:value => { view.scrollDOM.scrollTop = value; }});
    facade("scrollLeft", {get:() => view.scrollDOM.scrollLeft, set:value => { view.scrollDOM.scrollLeft = value; }});
    facade("setSelectionRange", {value:(a, b, direction = "none") => setSelection(a, b, direction)});
    facade("select", {value:() => setSelection(0, view.state.doc.length)});
    facade("focus", {value:() => view.focus()});
    facade("blur", {value:() => view.contentDOM.blur()});
    // HTMLTextAreaElement.setRangeText와 같은 규칙(select · start · end · preserve)으로 선택을 옮긴다.
    facade("setRangeText", {value:(text, start, end, mode = "preserve") => {
      const main = view.state.selection.main; text = String(text);
      if(start === undefined) { start = main.from; end = main.to; } start = clamp(start); end = Math.max(start, clamp(end));
      const delta = text.length - (end - start), moved = p => p > end ? p + delta : p > start ? start : p, movedEnd = p => p > end ? p + delta : p > start ? start + text.length : p;
      const sel = mode === "select" ? [start, start + text.length] : mode === "start" ? [start, start] : mode === "end" ? [start + text.length, start + text.length] : [moved(main.from), movedEnd(main.to)];
      view.dispatch({changes:{from:start, to:end, insert:text}, selection:{anchor:sel[0], head:sel[1]}, annotations:External.of(true)});
    }});
    // studio가 기다리는 나머지 사용자 이벤트(클릭·키 놓기·스크롤·포인터)도 textarea로 알린다.
    for(const type of ["click", "keyup", "pointerdown", "beforeinput"]) listen(view.contentDOM, type, () => textarea.dispatchEvent(new Event(type)));
    listen(view.scrollDOM, "scroll", () => textarea.dispatchEvent(new Event("scroll")));

    const applyPresentation = () => {
      view.dispatch({effects:[fontComp.reconfigure(fontTheme()), wrapComp.reconfigure(wrap ? CM.EditorView.lineWrapping : []), tabComp.reconfigure(tabConfig())]});
      $("studioFontSize") && ($("studioFontSize").textContent = `${fontSize}px`); $("studioIndent") && ($("studioIndent").value = String(tabSize));
      $("studioLineWrap")?.setAttribute("aria-pressed", String(wrap)); save();
    };
    const goToLine = (line, column = 1) => {
      const doc = view.state.doc; line = Math.min(doc.lines, Math.max(1, Number(line) || 1));
      const row = doc.line(line), at = row.from + Math.min(row.length, Math.max(0, column - 1));
      view.focus(); view.dispatch({selection:{anchor:at}, effects:CM.EditorView.scrollIntoView(at, {y:"center"}), annotations:External.of(true)}); return line;
    };
    const showFind = (replace = false) => {
      CM.openSearchPanel(view);
      if(replace) setTimeout(() => view.dom.querySelector(".cm-search input[name=replace]")?.focus(), 0);
    };
    const setDiagnostics = list => {
      const doc = view.state.doc, items = (Array.isArray(list) ? list : []).filter(item => Number.isInteger(item?.line) && item.line >= 1 && item.line <= doc.lines && typeof item.message === "string");
      view.dispatch(CM.setDiagnostics(view.state, items.map(item => { const row = doc.line(item.line); return {from:row.from, to:row.to, severity:item.severity === "warning" ? "warning" : "error", message:item.message}; })));
    };

    // ---- 명령 팔레트: 기본 편집기와 같은 모양(.studio-palette) · @ 함수·변수로 이동 · : 줄 번호 ----
    const palette = document.createElement("div"), paletteInput = document.createElement("input"), paletteList = document.createElement("div");
    palette.className = "studio-palette"; palette.hidden = true; palette.setAttribute("role", "dialog"); palette.setAttribute("aria-label", "명령 팔레트");
    paletteInput.className = "studio-palette-input"; paletteInput.placeholder = "명령 검색 · @ 함수·변수로 이동 · : 줄 번호"; paletteInput.setAttribute("aria-label", "명령 검색");
    paletteList.className = "studio-palette-list"; paletteList.setAttribute("role", "listbox"); palette.append(paletteInput, paletteList); pane?.append(palette);
    let paletteItems = [], paletteChoice = 0;
    const builtInCommands = () => [
      {label:"찾기", key:"Ctrl+F", run:() => showFind()}, {label:"찾아 바꾸기", key:"Ctrl+H", run:() => showFind(true)},
      {label:"줄 번호로 이동", key:"Ctrl+G", run:() => openPalette(":")}, {label:"함수·변수로 이동", key:"Ctrl+Shift+O", run:() => openPalette("@")},
      {label:"자동 완성 열기", key:"Ctrl+Space", run:() => CM.startCompletion(view)},
      {label:"줄 주석 전환", key:"Ctrl+/", run:() => CM.toggleComment(view)}, {label:"블록 주석 전환 (/* */)", key:"Shift+Alt+A", run:() => CM.toggleBlockComment(view)},
      {label:"다음 일치 항목 선택 추가", key:"Ctrl+D", run:() => CM.selectNextOccurrence(view)}, {label:"모든 일치 항목 선택", key:"Ctrl+Shift+L", run:() => CM.selectSelectionMatches(view)},
      {label:"줄 삭제", key:"Ctrl+Shift+K", run:() => CM.deleteLine(view)}, {label:"짝 괄호로 이동", key:"Ctrl+Shift+\\", run:() => CM.cursorMatchingBracket(view)},
      {label:"들여쓰기", key:"Ctrl+]", run:() => CM.indentMore(view)}, {label:"내어쓰기", key:"Ctrl+[", run:() => CM.indentLess(view)},
      {label:"긴 줄 자동 줄바꿈 켜기/끄기", key:"Alt+Z", run:() => { wrap = !wrap; applyPresentation(); }},
      {label:"글자 크게", run:() => { fontSize = Math.min(20, fontSize + 1); applyPresentation(); }}, {label:"글자 작게", run:() => { fontSize = Math.max(10, fontSize - 1); applyPresentation(); }},
      {label:"들여쓰기 크기 2 ↔ 4 바꾸기", run:() => { tabSize = tabSize === 4 ? 2 : 4; applyPresentation(); }}];
    const paletteEntries = () => {
      const value = paletteInput.value;
      if(value.startsWith(":")) { const line = Number(value.slice(1)); return [{label:line ? `${line}번째 줄로 이동` : `줄 번호 입력 (1–${view.state.doc.lines})`, run:() => line && goToLine(line)}]; }
      if(value.startsWith("@")) {
        const sym = symbolsOf(view.state.doc.toString()), query = value.slice(1).trim();
        const items = [...sym.functions.map(f => ({label:f.name, hint:`ƒ ${f.ret} (${f.params}) · Ln ${f.line}`, run:() => goToLine(f.line)})),
          ...sym.variables.filter(v => v.uniform || v.output).map(v => ({label:v.name, hint:`${v.uniform ? "uniform" : "out"} ${v.type} · Ln ${v.line}`, run:() => goToLine(v.line)})),
          ...sym.defines.map(d => ({label:d.name, hint:`#define · Ln ${d.line}`, run:() => goToLine(d.line)}))];
        return {items, query};
      }
      return {items:[...commands, ...builtInCommands()].map(c => ({label:c.label, hint:c.key || "", run:c.run})), query:value.trim()};
    };
    const renderPalette = () => {
      const entries = paletteEntries(), items = Array.isArray(entries) ? entries : entries.items, query = Array.isArray(entries) ? "" : entries.query;
      paletteItems = query ? items.map(item => ({item, m:fuzzy(item.label, query)})).filter(x => x.m).sort((a, b) => b.m.score - a.m.score).map(x => x.item) : items;
      paletteChoice = Math.min(paletteChoice, Math.max(0, paletteItems.length - 1));
      paletteList.replaceChildren(...paletteItems.map((item, i) => {
        const button = document.createElement("button"); button.type = "button"; button.dataset.index = i; button.className = i === paletteChoice ? "is-selected" : ""; button.setAttribute("role", "option");
        const label = document.createElement("span"); label.textContent = item.label; const hint = document.createElement("span"); hint.className = "palette-hint"; hint.textContent = item.hint || "";
        button.append(label, hint); return button;
      }));
      if(!paletteItems.length) { const empty = document.createElement("p"); empty.className = "palette-empty"; empty.textContent = "일치하는 항목이 없습니다"; paletteList.append(empty); }
    };
    const openPalette = (prefix = "") => { palette.hidden = false; paletteInput.value = prefix; paletteChoice = 0; renderPalette(); paletteInput.focus(); };
    const closePalette = (refocus = true) => { if(palette.hidden) return; palette.hidden = true; if(refocus) view.focus(); };
    const runPaletteItem = index => { const item = paletteItems[index]; if(!item) return; closePalette(); item.run?.(); };
    listen(paletteInput, "input", () => { paletteChoice = 0; renderPalette(); });
    listen(paletteInput, "keydown", event => {
      if(event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if(paletteItems.length) { paletteChoice = (paletteChoice + (event.key === "ArrowDown" ? 1 : -1) + paletteItems.length) % paletteItems.length; renderPalette(); } }
      else if(event.key === "Enter") { event.preventDefault(); runPaletteItem(paletteChoice); }
      else if(event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePalette(); }
    });
    listen(paletteInput, "blur", () => setTimeout(() => { if(!palette.contains(document.activeElement)) closePalette(false); }, 0));
    listen(paletteList, "pointerdown", event => event.preventDefault());
    listen(paletteList, "click", event => { const item = event.target.closest("button[data-index]"); if(item) runPaletteItem(Number(item.dataset.index)); });
    const registerCommands = list => { commands = [...commands, ...list.filter(c => c && typeof c.run === "function" && c.label)]; };

    // ---- 편집기 도구 버튼 ----
    listen($("studioFind"), "click", () => showFind()); listen($("studioReplace"), "click", () => showFind(true));
    listen($("studioGoto"), "click", () => openPalette(":")); listen($("studioComplete"), "click", () => { view.focus(); CM.startCompletion(view); });
    listen($("studioPaletteOpen"), "click", () => openPalette());
    listen(symbols, "change", () => { if(symbols.value) goToLine(Number(symbols.value)); symbols.value = ""; });
    listen($("studioZoomIn"), "click", () => { fontSize = Math.min(20, fontSize + 1); applyPresentation(); });
    listen($("studioZoomOut"), "click", () => { fontSize = Math.max(10, fontSize - 1); applyPresentation(); });
    listen($("studioLineWrap"), "click", () => { wrap = !wrap; applyPresentation(); });
    listen($("studioIndent"), "change", event => { tabSize = event.target.value === "2" ? 2 : 4; applyPresentation(); });
    listen(document, "keydown", event => {
      const open = (event.key === "F1" || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyP")) && host.offsetParent && !view.hasFocus;
      if(open) { event.preventDefault(); event.stopPropagation(); openPalette(); }
    });
    applyPresentation(); updateStatus(view.state); updateFunctions();

    return {
      update:() => { CM.closeCompletion(view); updateStatus(view.state); updateFunctions(); },
      goToLine, showFind, setDiagnostics, registerCommands, openPalette, view:() => view,
      dispose:() => {
        ac.abort(); view.destroy(); host.remove(); palette.remove(); frame?.classList.remove("is-codemirror");
        for(const name of ["value","selectionStart","selectionEnd","selectionDirection","scrollTop","scrollLeft","setSelectionRange","select","focus","blur","setRangeText"]) delete textarea[name];
      }
    };
  }; export {mount};
