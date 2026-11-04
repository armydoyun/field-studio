// CodeMirror용 GLSL 편집 도우미. cm-editor.js가 확장(extension)으로 붙인다.
//  · 시그니처 도움말: 호출 괄호 안이면 지금 쓰는 인수를 강조해 커서 위에 띄운다(showTooltip).
//  · 숫자 조절: Ctrl+↑/↓(Shift = 10배), 숫자 위에서 Alt+좌우 드래그.
//  · 색 견본: vec3/vec4(0~1 숫자) 앞에 색 견본을 끼워 넣고, 누르면 색상 선택기로 값을 바꾼다(VS Code식 인라인 위젯).
//  · 정의로 이동(F12 · Ctrl+클릭), 이름 바꾸기(F2).
//  · 들여쓰기 안내선, 컴파일 오류 메시지를 줄 끝에 표시(Error Lens).
// 소스 분석은 glsl-language.js가 맡고, 여기서는 화면·키 동작만 다룬다.
  const create = ({CM, language, options = {}, ask, notify = () => {}, onScrub = () => {}}) => {
    const {cleanOf, symbolsOf, KEYWORDS, TYPES, isIdent, escapeRe} = language;
    const docText = state => state.doc.toString();
    const inCode = (src, pos) => cleanOf(src)[pos] === src[pos] || /\s/.test(src[pos] || "");   // 주석·문자열·전처리문 밖
    const wordAround = (src, pos) => {
      let a = pos, b = pos; while(a > 0 && /\w/.test(src[a-1])) a--; while(b < src.length && /\w/.test(src[b])) b++;
      const word = src.slice(a, b); return isIdent(word) ? {word, start:a, end:b} : null;
    };
    // 이름 → {sig, desc}: 내장 함수(레퍼런스) 또는 이 패스의 함수
    const describeFunction = (src, name) => {
      const builtin = options.lookup?.(name); if(builtin) return {sig:builtin.sig, desc:builtin.desc};
      const own = symbolsOf(src).functions.find(entry => entry.name === name);
      return own ? {sig:`${own.ret} ${name}(${own.params})`, desc:`이 패스에 정의된 함수 · ${own.line}번째 줄`} : null;
    };

    // ==== 시그니처 도움말 ====
    // 닫히지 않은 가장 가까운 '(' 앞의 이름 = 인수를 쓰는 중인 함수, 그 사이 깊이 0의 쉼표 수 = 인수 번호
    const callAt = (src, pos) => {
      const clean = cleanOf(src);
      for(let i = pos-1, depth = 0, stop = Math.max(0, pos-800); i >= stop; i--) {
        const c = clean[i]; if(c === ")" || c === "]") depth++;
        else if(c === "(" || c === "[") {
          if(depth) { depth--; continue; } if(c === "[") return null;
          const name = clean.slice(0, i).match(/([A-Za-z_]\w*)\s*$/)?.[1]; if(!name || KEYWORDS.includes(name)) return null;
          let arg = 0; for(let j = i+1, d = 0; j < pos; j++) { const k = clean[j]; if(k === "(" || k === "[") d++; else if(k === ")" || k === "]") d--; else if(k === "," && !d) arg++; }
          return {name, arg, open:i};
        } else if(c === ";" || c === "{" || c === "}") return null;
      }
      return null;
    };
    // 시그니처 문자열에서 name(…)의 매개변수 위치. "[, float bias]" 같은 선택 인수 안의 쉼표는 나누지 않는다.
    const paramsOf = (sig, name) => {
      const at = sig.search(new RegExp(`\\b${escapeRe(name)}\\s*\\(`)); if(at < 0) return null;
      const open = sig.indexOf("(", at), parts = []; let depth = 0, from = open+1, close = sig.length;
      for(let i = open+1; i < sig.length; i++) { const c = sig[i];
        if(c === "(" || c === "[") depth++; else if(c === "]") depth--; else if(c === ")") { if(!depth) { close = i; break; } depth--; }
        else if(c === "," && !depth) { parts.push([from, i]); from = i+1; } }
      if(sig.slice(from, close).trim()) parts.push([from, close]); return {at, open, close, parts};
    };
    const signatureDom = (name, info, arg) => {
      const overloads = info.sig.split(" · ").filter(sig => paramsOf(sig, name)), all = overloads.length ? overloads : [info.sig];
      const sig = all.find(item => (paramsOf(item, name)?.parts.length || 0) > arg) || all[0], shape = paramsOf(sig, name);
      const box = document.createElement("div"), line = document.createElement("div"); box.className = "cm-glsl-signature"; line.className = "cm-glsl-signature-line";
      const text = (a, b) => line.append(document.createTextNode(sig.slice(a, b)));
      if(shape) {
        text(0, shape.at); const b = document.createElement("b"); b.textContent = sig.slice(shape.at, shape.open); line.append(b); text(shape.open, shape.open+1);
        let cursor = shape.open+1;
        shape.parts.forEach(([a, z], i) => { while(a < z && sig[a] === " ") a++; text(cursor, a); const part = document.createElement(i === arg ? "em" : "span"); part.textContent = sig.slice(a, z); line.append(part); cursor = z; });
        text(cursor, sig.length);
      } else text(0, sig.length);
      const desc = document.createElement("small"); desc.textContent = info.desc + (all.length > 1 ? ` · 다른 형태 ${all.length-1}개` : "");
      box.append(line, desc); return box;
    };
    const signatureTooltip = state => {
      const main = state.selection.main; if(!main.empty || state.selection.ranges.length > 1) return null;
      const src = docText(state), call = callAt(src, main.head); if(!call) return null;
      const info = describeFunction(src, call.name); if(!info) return null;
      return {pos:main.head, above:true, strictSide:false, arrow:false, create:() => ({dom:signatureDom(call.name, info, call.arg)})};
    };
    // 편집기에 포커스가 있을 때만 띄운다(다른 곳을 누르면 사라진다).
    const focusChanged = CM.StateEffect.define();
    const signatureField = CM.StateField.define({
      create:() => ({focused:false, tip:null}),
      update(value, tr) {
        let focused = value.focused; for(const effect of tr.effects) if(effect.is(focusChanged)) focused = effect.value;
        if(focused === value.focused && !tr.docChanged && !tr.selection) return value;
        return {focused, tip:focused ? signatureTooltip(tr.state) : null};
      },
      provide:field => CM.showTooltip.from(field, value => value.tip)
    });
    const trackFocus = CM.EditorView.focusChangeEffect.of((state, focusing) => focusChanged.of(focusing));

    // ==== 숫자 조절 ====
    const numberAt = (src, pos) => {
      const from = src.lastIndexOf("\n", pos-1) + 1, stop = src.indexOf("\n", pos), to = stop < 0 ? src.length : stop, row = src.slice(from, to);
      if(/^\s*#/.test(row) || !inCode(src, Math.max(from, pos - 1))) return null;
      for(const match of row.matchAll(/(?:\d+\.\d*|\.\d+|\d+)(?![\w.])/g)) {
        const a = from + match.index, b = a + match[0].length; if(pos < a || pos > b) continue;
        if(/[\w.]/.test(src[a-1] || "")) return null;   // vec3 · iChannel0 · 1e5 같은 이름·지수 표기는 건드리지 않는다
        const before = src.slice(from, a).replace(/\s+$/, ""), unary = before.endsWith("-") && !/[\w)\].]$/.test(before.slice(0,-1).replace(/\s+$/, ""));
        const start = unary ? from + before.length - 1 : a, text = src.slice(start, b);
        if(unary && /\s/.test(text.slice(1, a - start))) return {start:a, end:b, text:match[0]};   // "- 1"은 연산자
        return {start, end:b, text};
      }
      return null;
    };
    const numberFormat = text => { const dot = text.indexOf("."), decimals = dot < 0 ? 0 : text.length - dot - 1; return {decimals, isFloat:dot >= 0, step:10 ** -decimals}; };
    const formatNumber = (value, {decimals, isFloat}) => {
      if(Object.is(Math.round(value * 10 ** decimals), -0) || Math.abs(value) < 10 ** -(decimals+1)) value = 0;
      return decimals > 0 ? value.toFixed(decimals) : isFloat ? `${Math.round(value)}.` : String(Math.round(value));
    };
    const nudge = (direction, multiplier) => view => {
      const main = view.state.selection.main; if(!main.empty) return false;
      const found = numberAt(docText(view.state), main.head); if(!found) return false;
      const format = numberFormat(found.text), next = formatNumber(parseFloat(found.text) + direction * format.step * multiplier, format);
      const caret = Math.min(found.start + next.length, Math.max(found.start, main.head + next.length - found.text.length));
      view.dispatch({changes:{from:found.start, to:found.end, insert:next}, selection:{anchor:caret}, userEvent:"input.adjust"}); return true;
    };
    let scrub = null;
    const scrubMove = event => {
      if(!scrub) return; const {view} = scrub;
      const steps = Math.round((event.clientX - scrub.x) / 4), next = formatNumber(scrub.base + steps * scrub.format.step * (event.shiftKey ? 10 : 1), scrub.format);
      if(next === scrub.text) return;
      view.dispatch({changes:{from:scrub.start, to:scrub.end, insert:next}, selection:{anchor:scrub.start, head:scrub.start + next.length}, userEvent:"input.adjust"});
      scrub.end = scrub.start + next.length; scrub.text = next; onScrub();
    };
    const scrubEnd = () => { if(!scrub) return; scrub.view.dom.classList.remove("is-scrubbing"); scrub = null; window.removeEventListener("pointermove", scrubMove); window.removeEventListener("pointerup", scrubEnd); onScrub(); };

    // ==== 정의로 이동 · 이름 바꾸기 ====
    const definitionOf = (src, name, pos) => {
      const sym = symbolsOf(src), fn = sym.functions.find(f => f.name === name); if(fn) return fn.offset;
      const struct = sym.structs.get(name); if(struct) return struct.offset;
      const define = sym.defines.find(d => d.name === name); if(define) return define.offset;
      const vars = sym.variables.filter(v => v.name === name); if(!vars.length) return -1;
      return (vars.filter(v => v.offset <= pos).pop() || vars[0]).offset;
    };
    const goToDefinition = (view, pos = view.state.selection.main.head) => {
      const src = docText(view.state), found = wordAround(src, pos); if(!found) return false;
      const at = definitionOf(src, found.word, found.start);
      if(at < 0) { notify(options.lookup?.(found.word) ? `${found.word}은(는) 내장 함수입니다 · 마우스를 올리면 설명을 볼 수 있습니다` : `${found.word}의 정의를 이 패스에서 찾지 못했습니다`); return true; }
      view.dispatch({selection:{anchor:at, head:at + found.word.length}, effects:CM.EditorView.scrollIntoView(at, {y:"center"})}); view.focus(); return true;
    };
    const renameSymbol = async view => {
      const src = docText(view.state), found = wordAround(src, view.state.selection.main.head);
      if(!found || KEYWORDS.includes(found.word) || TYPES.includes(found.word) || !inCode(src, found.start)) { notify("이름을 바꿀 변수나 함수 위에 커서를 두세요"); return true; }
      const next = await ask({title:`'${found.word}' 이름 바꾸기`, message:"이 패스 안의 같은 이름을 모두 바꿉니다(주석·문자열과 '.' 뒤의 필드 이름은 제외).", value:found.word, label:"새 이름", ok:"바꾸기"});
      if(next === null || next === undefined || next === found.word) return true;
      if(!isIdent(next) || KEYWORDS.includes(next) || TYPES.includes(next)) { notify(`'${next}'은(는) 쓸 수 없는 이름입니다`); return true; }
      const now = docText(view.state), clean = cleanOf(now), spots = [...clean.matchAll(new RegExp(`\\b${escapeRe(found.word)}\\b`, "g"))].map(m => m.index).filter(at => clean[at-1] !== ".");
      if(!spots.length) return true;
      view.dispatch({changes:spots.map(at => ({from:at, to:at + found.word.length, insert:next})), userEvent:"input.rename"}); view.focus();
      notify(`${found.word} → ${next} · ${spots.length}곳을 바꿨습니다 · Ctrl+Z로 되돌리기`); return true;
    };

    // ==== 색 견본: 인라인 위젯 + 색상 선택기 ====
    const COLOR_RE = /\bvec([34])\s*\(([^()\n]*)\)/g, NUMBER_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
    const findColors = (src, from, to) => {
      const clean = cleanOf(src), found = [];
      for(const m of clean.slice(from, to).matchAll(COLOR_RE)) {
        const size = Number(m[1]), open = from + m.index + m[0].indexOf("(") + 1, args = []; let at = open;
        for(const part of m[2].split(",")) { const lead = part.length - part.trimStart().length, text = part.trim(); args.push({start:at + lead, end:at + lead + text.length, text}); at += part.length + 1; }
        if(args.length !== size || !args.every(arg => NUMBER_RE.test(arg.text))) continue;
        const values = args.map(arg => parseFloat(arg.text)); if(!values.every(v => v >= 0 && v <= 1)) continue;
        found.push({start:from + m.index, end:from + m.index + m[0].length, args, values});
      }
      return found;
    };
    const toHex = values => "#" + values.slice(0, 3).map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    const cssColor = values => `rgb(${values.slice(0, 3).map(v => Math.round(v * 255)).join(" ")}${values.length > 3 ? ` / ${values[3]}` : ""})`;
    const formatChannel = v => { const r = Math.round(v * 1000) / 1000; return Number.isInteger(r) ? r.toFixed(1) : String(r); };
    const picker = document.createElement("input"); picker.type = "color"; picker.className = "cm-glsl-color-input"; picker.tabIndex = -1; picker.setAttribute("aria-hidden", "true");
    let pickTarget = null;   // {view, start}
    picker.addEventListener("input", () => {
      if(!pickTarget) return; const {view, start} = pickTarget, src = docText(view.state), line = view.state.doc.lineAt(start);
      const color = findColors(src, line.from, line.to).find(c => c.start === start); if(!color) return;
      const rgb = [1, 3, 5].map(i => parseInt(picker.value.slice(i, i + 2), 16) / 255);
      view.dispatch({changes:color.args.slice(0, 3).map((arg, i) => ({from:arg.start, to:arg.end, insert:formatChannel(rgb[i])})), userEvent:"input.adjust"});
    });
    const openPicker = (view, start) => {
      const src = docText(view.state), line = view.state.doc.lineAt(start), color = findColors(src, line.from, line.to).find(c => c.start === start); if(!color) return false;
      if(!picker.isConnected) view.dom.append(picker);
      pickTarget = {view, start}; picker.value = toHex(color.values); try { picker.showPicker ? picker.showPicker() : picker.click(); } catch (_) { picker.click(); } return true;
    };
    class ColorSwatch extends CM.WidgetType {
      constructor(values, start) { super(); this.values = values; this.start = start; }
      eq(other) { return other.start === this.start && other.values.join() === this.values.join(); }
      toDOM(view) {
        const swatch = document.createElement("button"); swatch.type = "button"; swatch.className = "cm-glsl-swatch"; swatch.style.setProperty("--swatch", cssColor(this.values));
        swatch.title = "색상 선택기로 바꾸기 · 결과는 0~1 값으로 들어갑니다"; swatch.setAttribute("aria-label", `색 ${toHex(this.values)} · 색상 선택기 열기`);
        swatch.addEventListener("mousedown", event => event.preventDefault());
        swatch.addEventListener("click", () => openPicker(view, this.start)); return swatch;
      }
      ignoreEvent() { return true; }
    }
    const colorDecorations = view => {
      const builder = new CM.RangeSetBuilder(), src = docText(view.state);
      for(const {from, to} of view.visibleRanges) for(const color of findColors(src, from, to)) builder.add(color.start, color.start, CM.Decoration.widget({widget:new ColorSwatch(color.values, color.start), side:-1}));
      return builder.finish();
    };
    const colorPlugin = CM.ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = colorDecorations(view); }
      update(update) { if(update.docChanged || update.viewportChanged) this.decorations = colorDecorations(update.view); }
    }, {decorations:plugin => plugin.decorations});
    const colorAtCursor = view => { const pos = view.state.selection.main.head, line = view.state.doc.lineAt(pos); return findColors(docText(view.state), line.from, line.to).find(c => pos >= c.start && pos <= c.end) || null; };
    const openColorPicker = view => { const color = colorAtCursor(view); if(!color) { notify("커서를 vec3(…)/vec4(…) 색 값 안에 두세요"); return false; } return openPicker(view, color.start); };

    // ==== 들여쓰기 안내선: 줄마다 단계 수를 CSS 변수로 넘기고 배경 무늬로 그린다 ====
    const guideDecorations = view => {
      const state = view.state, unit = state.tabSize, builder = new CM.RangeSetBuilder(), doc = state.doc;
      const indentOf = number => { const text = doc.line(number).text; if(!text.trim()) return -1; let col = 0; for(const ch of text) { if(ch === " ") col++; else if(ch === "\t") col += unit - col % unit; else break; } return col; };
      for(const {from, to} of view.visibleRanges) {
        for(let pos = from; pos <= to;) {
          const line = doc.lineAt(pos); let depth = indentOf(line.number);
          if(depth < 0) { let up = -1, down = -1;
            for(let n = line.number - 1, k = 0; n >= 1 && k < 400 && up < 0; n--, k++) up = indentOf(n);
            for(let n = line.number + 1, k = 0; n <= doc.lines && k < 400 && down < 0; n++, k++) down = indentOf(n);
            depth = Math.max(0, Math.min(up < 0 ? 0 : up, down < 0 ? 0 : down)); }
          const levels = Math.floor(depth / unit);
          if(levels > 0) builder.add(line.from, line.from, CM.Decoration.line({attributes:{class:"cm-indent-guides", style:`--guide-levels:${levels}`}}));
          pos = line.to + 1;
        }
      }
      return builder.finish();
    };
    const guidePlugin = CM.ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = guideDecorations(view); }
      update(update) { if(update.docChanged || update.viewportChanged || update.startState.tabSize !== update.state.tabSize) this.decorations = guideDecorations(update.view); }
    }, {decorations:plugin => plugin.decorations});

    // ==== 줄 끝 오류 메시지(Error Lens) ====
    const setLens = CM.StateEffect.define();
    class LensWidget extends CM.WidgetType {
      constructor(message, severity, count, stale) { super(); Object.assign(this, {message, severity, count, stale}); }
      eq(other) { return other.message === this.message && other.severity === this.severity && other.count === this.count && other.stale === this.stale; }
      // 바깥 span은 여백을 margin이 아닌 padding으로 둔다: 커서가 줄 끝 위젯 쪽에 붙으면(→ 키로 돌아오기·줄 비우기) 위젯 왼쪽 끝에 그려지는데,
      // margin이면 그 끝이 글자에서 떨어져 글자 뒤에 빈칸·들여쓰기가 생긴 것처럼 보인다. 색 상자는 안쪽 span이 그린다.
      toDOM() {
        const span = document.createElement("span"), text = document.createElement("span"); span.className = `cm-error-lens is-${this.severity}${this.stale ? " is-stale" : ""}`;
        text.className = "cm-error-lens-text"; text.textContent = this.count > 1 ? `${this.message} (+${this.count - 1})` : this.message; span.append(text); return span;
      }
      ignoreEvent() { return false; }
    }
    const lensDecorations = (doc, list, stale) => {
      const byLine = new Map();
      for(const item of list) if(item.line >= 1 && item.line <= doc.lines) {
        const entry = byLine.get(item.line) || {severity:"warning", messages:[]}; if(item.severity !== "warning") entry.severity = "error"; entry.messages.push(item.message); byLine.set(item.line, entry);
      }
      const ranges = [...byLine].sort((a, b) => a[0] - b[0]).map(([line, {severity, messages}]) => CM.Decoration.widget({widget:new LensWidget(messages[0], severity, messages.length, stale), side:1}).range(doc.line(line).to));
      return CM.Decoration.set(ranges);
    };
    // 편집하면 줄 위치가 바뀔 수 있으므로 다음 컴파일 전까지 흐리게(stale) 표시한다.
    const lensField = CM.StateField.define({
      create:() => ({list:[], stale:false, deco:CM.Decoration.none}),
      update(value, tr) {
        for(const effect of tr.effects) if(effect.is(setLens)) return {list:effect.value, stale:false, deco:lensDecorations(tr.state.doc, effect.value, false)};
        if(!tr.docChanged) return value;
        const deco = value.stale ? value.deco.map(tr.changes) : lensDecorations(tr.startState.doc, value.list, true).map(tr.changes);
        return {...value, stale:true, deco};
      },
      provide:field => CM.EditorView.decorations.from(field, value => value.deco)
    });

    // ==== 키 · 마우스 ====
    const keys = [
      {key:"Mod-ArrowUp", run:nudge(1, 1)}, {key:"Mod-ArrowDown", run:nudge(-1, 1)}, {key:"Shift-Mod-ArrowUp", run:nudge(1, 10)}, {key:"Shift-Mod-ArrowDown", run:nudge(-1, 10)},
      {key:"F12", run:view => goToDefinition(view)}, {key:"F2", run:view => { renameSymbol(view); return true; }}
    ];
    const mouse = CM.Prec.highest(CM.EditorView.domEventHandlers({
      mousedown(event, view) {
        if(event.button !== 0) return false;
        if((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {   // Ctrl+클릭: 정의로 이동
          const pos = view.posAtCoords({x:event.clientX, y:event.clientY}); if(pos == null) return false;
          event.preventDefault(); view.dispatch({selection:{anchor:pos}}); goToDefinition(view, pos); return true;
        }
        if(event.altKey && !event.ctrlKey && !event.metaKey) {   // 숫자 위 Alt+드래그: 값 조절(숫자가 아니면 사각 선택)
          const pos = view.posAtCoords({x:event.clientX, y:event.clientY}), found = pos == null ? null : numberAt(docText(view.state), pos); if(!found) return false;
          event.preventDefault(); view.focus(); view.dispatch({selection:{anchor:found.start, head:found.end}});
          scrub = {view, x:event.clientX, base:parseFloat(found.text), start:found.start, end:found.end, text:found.text, format:numberFormat(found.text)};
          view.dom.classList.add("is-scrubbing"); window.addEventListener("pointermove", scrubMove); window.addEventListener("pointerup", scrubEnd); return true;
        }
        return false;
      }
    }));
    return {
      extensions:[signatureField, trackFocus, colorPlugin, guidePlugin, lensField, mouse, CM.keymap.of(keys)],
      setDiagnostics:(view, list) => view.dispatch({effects:setLens.of(list)}),
      goToDefinition, renameSymbol, openColorPicker, nudge,
      dispose:() => { scrubEnd(); picker.remove(); }
    };
  }; export {create};
