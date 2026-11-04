// GLSL 코드 편집기 (CodeMirror 6). studio.js가 mount()로 붙이고 update · goToLine · setDiagnostics 등을 부른다.
// studio.js는 #studioCode textarea를 직접 읽고 쓰므로, 그 textarea를 CodeMirror 문서의 "창구(facade)"로 만든다:
// value·selectionStart/End·setSelectionRange·setRangeText·scrollTop·focus는 CodeMirror 상태를 읽고 쓰며,
// 사용자의 편집·선택·키 입력은 textarea의 input·select·keydown 이벤트로 다시 알린다. 되돌리기는 지금처럼 studio가 맡는다(CodeMirror history 미사용).
import * as CodeMirror from "./codemirror.js";
import * as Highlight from "./glsl-highlight.js";
import * as Language from "./glsl-language.js";
import * as Features from "./cm-glsl-features.js";
const mount = (textarea, ask, beforeEdit = () => {}, uniformNames = () => [], options = {}) => {
  const CM = CodeMirror.load(); // CodeMirror는 편집기를 처음 붙일 때 초기화한다
  const $ = id => document.getElementById(id),
    ac = new AbortController(),
    signal = ac.signal;
  const listen = (target, type, fn, opts = {}) => target?.addEventListener(type, fn, { ...opts, signal });
  const highlighter = Highlight.create((options.builtins || []).map(item => item.name));
  let view = null;
  const language = Language.create({
    options,
    uniformNames,
    highlighter,
    source: () => (view ? view.state.doc.toString() : textarea.value),
  });
  const { symbolsOf, describeSymbol, gatherItems, declaringName, KIND_ORDER, KIND_NAME, cleanOf, fuzzy, escapeRe } =
    language;
  const notify = text => options.notify?.(text);
  // 시그니처 도움말 · 숫자 조절 · 색 견본 · 정의로 이동 · 이름 바꾸기 · 들여쓰기 안내선 · 줄 끝 오류 표시
  const features = Features.create({ CM, language, options, ask, notify, onScrub: () => options.onScrub?.() });

  // ---- 표시 설정(글자 크기·줄바꿈·들여쓰기). 예전 편집기와 같은 저장값을 이어서 쓴다 ----
  const STATE_KEY = "webgl.shader-studio.editor.v2";
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STATE_KEY) || "{}") || {};
  } catch (_) {}
  let fontSize = Number.isInteger(saved.fontSize) ? Math.max(10, Math.min(20, saved.fontSize)) : 12,
    wrap = !!saved.wrap,
    tabSize = saved.tabSize === 2 ? 2 : 4;
  const save = () => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ ...saved, fontSize, wrap, tabSize }));
    } catch (_) {}
  };
  const fontComp = new CM.Compartment(),
    wrapComp = new CM.Compartment(),
    tabComp = new CM.Compartment();
  const fontTheme = () => CM.EditorView.theme({ "&": { fontSize: `${fontSize}px` } });
  const tabConfig = () => [
    CM.EditorState.tabSize.of(tabSize),
    CM.indentUnit.of(" ".repeat(tabSize)),
    CM.EditorView.editorAttributes.of({ style: `--tab-size:${tabSize}` }),
  ];

  // ---- GLSL 문법 강조: glsl-highlight.js와 같은 규칙·색(.glsl-* 클래스) ----
  const CLASSES = [
    "glsl-keyword",
    "glsl-type",
    "glsl-number",
    "glsl-comment",
    "glsl-string",
    "glsl-directive",
    "glsl-builtin",
    "glsl-function",
  ];
  const tokenTable = Object.fromEntries(CLASSES.map(name => [name, CM.Tag.define()]));
  const glsl = CM.StreamLanguage.define({
    name: "glsl",
    startState: () => ({ comment: false, depth: 0 }),
    copyState: state => ({ comment: state.comment, depth: state.depth }),
    token(stream, state) {
      const closeComment = () => {
        if (stream.skipTo("*/")) {
          stream.pos += 2;
          state.comment = false;
        } else stream.skipToEnd();
        return "glsl-comment";
      };
      if (state.comment) return closeComment();
      if (stream.eatSpace()) return null;
      if (stream.match("//")) {
        stream.skipToEnd();
        return "glsl-comment";
      }
      if (stream.match("/*")) {
        state.comment = true;
        return closeComment();
      }
      if (stream.peek() === "#") {
        stream.skipToEnd();
        return "glsl-directive";
      }
      if (stream.match(/^"(?:\\.|[^"\\])*"?/)) return "glsl-string";
      if (stream.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[uU]?/)) return "glsl-number";
      const word = stream.match(/^[A-Za-z_]\w*/);
      if (word) {
        const name = word[0],
          kind = highlighter.tokenClass(name);
        if (kind === "glsl-keyword" || kind === "glsl-type") return kind;
        if (name.startsWith("gl_")) return "glsl-builtin";
        return /^\s*\(/.test(stream.string.slice(stream.pos)) ? kind : null; // 호출(이름 + '(')만 함수 색
      }
      const ch = stream.next();
      if (ch === "{") state.depth++;
      else if (ch === "}") state.depth = Math.max(0, state.depth - 1);
      return null;
    },
    // 들여쓰기: 열린 '{' 수만큼 한 단계씩. 줄이 '}'로 시작하면 한 단계 덜.
    indent: (state, textAfter, cx) => Math.max(0, state.depth - (/^\s*\}/.test(textAfter) ? 1 : 0)) * cx.unit,
    languageData: {
      commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
      closeBrackets: { brackets: ["(", "[", "{", '"'] },
      indentOnInput: /^\s*\}$/,
    },
    tokenTable,
  });
  const glslStyle = CM.HighlightStyle.define(CLASSES.map(name => ({ tag: tokenTable[name], class: name })));

  // ---- 코드 접기: 줄 끝의 '{'부터 짝 '}'까지 (주석·문자열 안의 괄호는 무시) ----
  let cleanFor = { doc: null, text: "" };
  const cleanDoc = state => {
    if (cleanFor.doc !== state.doc) cleanFor = { doc: state.doc, text: cleanOf(state.doc.toString()) };
    return cleanFor.text;
  };
  const braceFold = CM.foldService.of((state, from, to) => {
    const clean = cleanDoc(state),
      open = clean.slice(from, to).lastIndexOf("{");
    if (open < 0) return null;
    for (let i = from + open + 1, depth = 0; i < clean.length; i++) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") {
        if (depth) {
          depth--;
          continue;
        }
        return i > to ? { from: from + open + 1, to: i } : null;
      }
    }
    return null;
  });

  // ---- 자동 완성: glsl-language.js의 후보(이 패스의 이름·Uniform·내장 함수·타입·템플릿·코드 조각)를 CodeMirror 목록으로 ----
  const COMPLETION_TYPE = {
    variable: "variable",
    field: "property",
    function: "function",
    uniform: "variable",
    constant: "constant",
    builtin: "function",
    "builtin-var": "variable",
    type: "type",
    keyword: "keyword",
    snippet: "text",
    library: "namespace",
  };
  const infoNode = item => {
    const box = document.createElement("div");
    box.className = "cm-glsl-info";
    const kind = document.createElement("small");
    kind.textContent = KIND_NAME[item.kind] || "";
    box.append(kind);
    if (item.sig || item.detail) {
      const code = document.createElement("code");
      Highlight.create().paint(code, item.sig || item.detail);
      box.append(code);
    }
    if (item.desc) {
      const p = document.createElement("p");
      p.textContent = item.desc;
      box.append(p);
    }
    return box;
  };
  const declarationInsertAt = src => {
    const clean = cleanOf(src),
      m = /^[\s\S]*?\bprecision\s+\w+\s+float\s*;[^\n]*\n?/.exec(clean) || /^#version[^\n]*\n?/.exec(src);
    return m ? m[0].length : 0;
  };
  // 템플릿 본문($1 · ${1:값} · $0)을 CodeMirror snippet 형식으로 바꾼다.
  const toSnippet = body =>
    body
      .replace(/\$\{(\d+):([^}]*)\}/g, "${$1:$2}")
      .replace(/\$0/g, "${}")
      .replace(/\$(\d+)/g, "${$1}");
  const applyItem = item => (editorView, completion, from, to) => {
    if (item.kind === "snippet") return CM.snippet(toSnippet(item.body))(editorView, completion, from, to);
    // 커서를 앞 글자 쪽(assoc -1)에 붙인다. 방향 없이 두면 줄 끝 위젯(오류 표시 등) 뒤에 그려져 글자 뒤에 빈칸이 생긴 것처럼 보인다.
    editorView.dispatch({
      changes: { from, to, insert: item.label },
      selection: CM.EditorSelection.create([CM.EditorSelection.cursor(from + item.label.length, -1)]),
      userEvent: "input.complete",
    });
    if (item.kind === "library" && options.library?.insert?.(item.id)) return;
    const src = editorView.state.doc.toString();
    if (item.declare && !new RegExp(`\\buniform\\s+\\w+\\s+${escapeRe(item.label)}\\b`).test(cleanOf(src))) {
      const at = declarationInsertAt(src);
      editorView.dispatch({ changes: { from: at, insert: item.declare + "\n" }, userEvent: "input.complete" });
      options.notify?.(`${item.label} 선언(${item.declare})을 맨 위에 함께 추가했습니다 · Ctrl+Z로 되돌리기`);
    }
  };
  const completionSource = context => {
    const src = context.state.doc.toString(),
      at = context.pos,
      clean = cleanOf(src);
    if (at > 0 && clean[at - 1] !== src[at - 1]) return null; // 주석·문자열·전처리문 안
    const word = context.matchBefore(/[A-Za-z_]\w*/),
      start = word ? word.from : at;
    if (/\d/.test(src[start - 1] || "")) return null;
    if (src[start - 1] === "." && /(?:^|[^\w])\d+$/.test(src.slice(0, start - 1))) return null; // 1.5 같은 숫자
    const { items, member } = gatherItems(src, at, start);
    if (!context.explicit && !member && (!word || declaringName(src, start))) return null;
    return {
      from: start,
      validFor: /^\w*$/,
      options: items.map(item => ({
        label: item.label,
        type: COMPLETION_TYPE[item.kind],
        detail: item.kind === "snippet" ? "템플릿" : item.detail,
        boost: (8 - KIND_ORDER[item.kind]) * 4,
        info: item.desc || item.sig || item.body ? () => infoNode(item) : undefined,
        apply: applyItem(item),
      })),
    };
  };

  // ---- 마우스 설명: 이름 위에 머물면 내장 함수·변수·Uniform 설명 ----
  const hover = CM.hoverTooltip((editorView, pos) => {
    const word = editorView.state.wordAt(pos);
    if (!word) return null;
    const src = editorView.state.doc.toString();
    if (cleanOf(src)[pos] !== src[pos]) return null;
    const info = describeSymbol(editorView.state.sliceDoc(word.from, word.to), pos);
    if (!info) return null;
    return {
      pos: word.from,
      end: word.to,
      above: true,
      create: () => ({ dom: infoNode({ kind: "", sig: info.sig, desc: info.desc }) }),
    };
  });

  // ---- textarea 창구(facade) ----
  const External = CM.Annotation.define(); // studio가 textarea API로 바꾼 것(=다시 input으로 알리지 않는다)
  const clamp = n => Math.max(0, Math.min(view.state.doc.length, Number(n) || 0));
  const setSelection = (a, b, direction = "none", scroll = false) => {
    a = clamp(a);
    b = clamp(b);
    if (b < a) a = b; // textarea 규칙: 끝이 시작보다 앞이면 시작을 끝으로
    view.dispatch({
      selection: direction === "backward" ? { anchor: b, head: a } : { anchor: a, head: b },
      annotations: External.of(true),
      scrollIntoView: scroll,
    });
  };
  const facade = (name, descriptor) => Object.defineProperty(textarea, name, { configurable: true, ...descriptor });
  const inputTypeOf = tr =>
    tr.isUserEvent("input.type.compose")
      ? "insertCompositionText"
      : tr.isUserEvent("input.type")
        ? "insertText"
        : tr.isUserEvent("delete")
          ? "deleteContentBackward"
          : tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop")
            ? "insertFromPaste"
            : "insertReplacementText";

  // ---- 화면 만들기 ----
  const frame = textarea.closest(".studio-editor-frame"),
    pane = textarea.closest(".studio-code-pane");
  frame?.classList.add("is-codemirror");
  const host = document.createElement("div");
  host.className = "studio-cm-host";
  frame?.append(host);
  const position = $("studioCursor"),
    symbols = $("studioFunctions");
  const updateStatus = state => {
    const main = state.selection.main,
      line = state.doc.lineAt(main.head),
      count = state.selection.ranges.length;
    if (position)
      position.textContent = `Ln ${line.number}, Col ${main.head - line.from + 1}${count > 1 ? ` · 다중 선택 ${count}개` : main.empty ? "" : ` · ${main.to - main.from}자 선택`}`;
  };
  // ---- 현재 위치 표시(breadcrumb): 커서가 들어 있는 최상위 함수 이름. 누르면 @ 함수·변수 팔레트 ----
  // 함수 범위(정의 줄 시작 ~ 짝 '}')는 문서가 바뀔 때만 다시 계산하고, 커서가 움직이면 범위만 찾아 이름을 바꾼다.
  let functionsFor = null,
    functionRanges = [];
  const updateFunctions = () => {
    const src = view.state.doc.toString();
    if (src === functionsFor) return;
    functionsFor = src;
    const clean = cleanOf(src),
      ranges = [];
    let depth = 0,
      pos = 0;
    for (const m of clean.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*\{/g)) {
      if (m.index < pos) continue; // 앞 함수 본문 안(중첩 블록)
      for (; pos < m.index; pos++) {
        const ch = clean[pos];
        if (ch === "{") depth++;
        else if (ch === "}") depth = Math.max(0, depth - 1);
      }
      if (depth) continue;
      let end = m.index + m[0].length,
        level = 0;
      for (; end < clean.length; end++) {
        const ch = clean[end];
        if (ch === "{") level++;
        else if (ch === "}") {
          if (!level) break;
          level--;
        }
      }
      ranges.push({ name: m[2], from: m.index, to: end });
      pos = Math.min(clean.length, end + 1);
    }
    functionRanges = ranges;
    updateCrumb(view.state);
  };
  const functionAt = pos => functionRanges.find(range => pos >= range.from && pos <= range.to + 1) || null;
  const crumbName = symbols?.querySelector(".studio-crumb-name"),
    crumbKind = symbols?.querySelector(".studio-crumb-kind");
  const updateCrumb = state => {
    if (!symbols || !crumbName) return;
    const current = functionAt(state.selection.main.head);
    const text = current
      ? `${current.name}()`
      : functionRanges.length
        ? `함수 ${functionRanges.length}개`
        : "함수 없음";
    if (crumbName.textContent !== text) crumbName.textContent = text;
    symbols.classList.toggle("is-inside", !!current);
    if (crumbKind) crumbKind.dataset.kind = current ? "function" : "list";
    symbols.title = current
      ? `지금 ${current.name}() 안 · 눌러서 함수·변수로 이동 (Ctrl+Shift+O)`
      : "함수·변수로 이동 (Ctrl+Shift+O)";
  };
  const editorTheme = CM.EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: "var(--sunken)", color: "var(--code-text)" },
      ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.65" },
      ".cm-content": { padding: "12px 0", caretColor: "var(--text)" },
      ".cm-gutters": {
        backgroundColor: "var(--sunken)",
        color: "var(--faint)",
        border: "none",
        borderRight: "1px solid var(--line)",
      },
      ".cm-activeLine": { backgroundColor: "var(--active-line)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--active-line)", color: "var(--text-soft)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "color-mix(in srgb, var(--accent) 34%, transparent) !important",
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
      "&.cm-focused .cm-matchingBracket": {
        backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
        outline: "1px solid color-mix(in srgb, var(--accent) 70%, transparent)",
      },
      ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--syn-builtin) 16%, transparent)" },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in srgb, var(--warning) 20%, transparent)",
        outline: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in srgb, var(--warning) 40%, transparent)",
      },
      ".cm-panels": { backgroundColor: "var(--elevated)", color: "var(--text-soft)" },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
      ".cm-tooltip": {
        backgroundColor: "var(--elevated)",
        border: "1px solid var(--line-strong)",
        borderRadius: "6px",
        color: "var(--text-soft)",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--accent-soft)",
        color: "var(--text)",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "var(--surface)",
        border: "1px solid var(--line-strong)",
        color: "var(--muted)",
      },
    },
    { dark: true }
  );

  const notifyTextarea = update => {
    if (update.docChanged && !update.transactions.some(tr => tr.annotation(External))) {
      const tr = update.transactions.find(t => t.docChanged),
        type = inputTypeOf(tr);
      let data = null;
      tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        if (data === null && type === "insertText") data = inserted.toString();
      });
      if (type === "insertText" && (data?.length !== 1 || update.state.selection.ranges.length > 1)) data = null;
      textarea.dispatchEvent(
        typeof InputEvent === "function"
          ? new InputEvent("input", {
              bubbles: true,
              inputType: data === null && type === "insertText" ? "insertReplacementText" : type,
              data,
            })
          : new Event("input", { bubbles: true })
      );
    }
    if (update.selectionSet && !update.transactions.some(tr => tr.annotation(External)))
      textarea.dispatchEvent(new Event("select"));
    if (update.docChanged || update.selectionSet) updateStatus(update.state);
    if (update.docChanged) updateFunctions();
    else if (update.selectionSet) updateCrumb(update.state);
  };
  // 키 입력은 먼저 textarea로 알린다(studio의 Ctrl+Z/Y·Alt+PageUp 등). studio가 처리하면 CodeMirror는 건너뛴다.
  const forwardKeys = CM.Prec.highest(
    CM.EditorView.domEventHandlers({
      keydown(event) {
        const clone = new KeyboardEvent("keydown", {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          bubbles: false,
          cancelable: true,
        });
        textarea.dispatchEvent(clone);
        if (clone.defaultPrevented) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    })
  );
  // studio의 되돌리기 기록용: 사용자 편집 직전 커서를 알려 준다.
  // 글자 입력(input.type)은 제외한다: 브라우저가 이미 커서 쪽으로 스크롤한 뒤라, 직전에 받은 beforeinput·select 시점의 위치가 맞다.
  const beforeUserEdit = CM.EditorState.transactionFilter.of(tr => {
    if (tr.docChanged && !tr.annotation(External) && !tr.isUserEvent("input.type")) beforeEdit();
    return tr;
  });
  let commands = [];
  // 자동 완성 목록이 열려 있으면 Tab도 Enter처럼 고른 후보를 넣는다(목록이 없으면 false → 아래 indentWithTab이 들여쓰기).
  // 번들에 acceptCompletion이 따로 없으므로 completionKeymap의 Enter 명령(= acceptCompletion)을 그대로 쓴다.
  const acceptCompletion = CM.completionKeymap.find(binding => binding.key === "Enter")?.run;
  // Tab: VS Code처럼 커서 위치에 다음 탭 위치까지 공백을 넣는다(한 줄 안의 선택은 공백으로 바꾼다).
  // 여러 줄에 걸친 선택이 있을 때만 줄 전체를 들여쓴다. (CodeMirror indentWithTab은 커서만 있어도 줄 전체를 들여썼다)
  const insertSoftTab = editorView => {
    const state = editorView.state,
      size = state.tabSize;
    if (
      state.selection.ranges.some(
        range => !range.empty && state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number
      )
    )
      return CM.indentMore(editorView);
    editorView.dispatch(
      state.changeByRange(range => {
        const line = state.doc.lineAt(range.from);
        let column = 0;
        for (const ch of line.text.slice(0, range.from - line.from))
          column = ch === "\t" ? column + size - (column % size) : column + 1;
        const spaces = " ".repeat(size - (column % size));
        return {
          changes: { from: range.from, to: range.to, insert: spaces },
          range: CM.EditorSelection.cursor(range.from + spaces.length),
        };
      }),
      { scrollIntoView: true, userEvent: "input.indent" }
    );
    return true;
  };
  // ---- VS Code와 같은 동작을 위한 명령(번들에 없는 것은 직접 만든다) ----
  // Ctrl+K Ctrl+C / Ctrl+K Ctrl+U: 줄 주석을 (전환이 아니라) 항상 추가 / 제거한다. 빈 줄은 건드리지 않는다.
  const selectedLines = state => {
    const numbers = new Set();
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      let last = state.doc.lineAt(range.to).number;
      if (last > first && state.doc.line(last).from === range.to) last--; // 다음 줄 맨 앞에서 끝난 선택은 그 줄을 빼고
      for (let n = first; n <= last; n++) numbers.add(n);
    }
    return [...numbers].map(n => state.doc.line(n));
  };
  const lineComment = add => editorView => {
    const lines = selectedLines(editorView.state).filter(line => line.text.trim());
    if (!lines.length) return true;
    const changes = [];
    if (add) {
      const indent = Math.min(...lines.map(line => /^\s*/.exec(line.text)[0].length));
      for (const line of lines) changes.push({ from: line.from + indent, insert: "// " });
    } else
      for (const line of lines) {
        const match = /^(\s*)\/\/ ?/.exec(line.text);
        if (match) changes.push({ from: line.from + match[1].length, to: line.from + match[0].length });
      }
    if (changes.length)
      editorView.dispatch({ changes, scrollIntoView: true, userEvent: add ? "input.comment" : "delete.comment" });
    return true;
  };
  // Ctrl+Shift+Enter: 현재 줄 위에 같은 들여쓰기의 빈 줄을 넣고 그리로 간다(아래는 Ctrl+Enter = CM.insertBlankLine, 셰이더 실행은 Ctrl+S).
  const insertLineAbove = editorView => {
    const state = editorView.state;
    editorView.dispatch(
      state.changeByRange(range => {
        const line = state.doc.lineAt(range.head),
          indent = /^\s*/.exec(line.text)[0];
        return {
          changes: { from: line.from, insert: indent + "\n" },
          range: CM.EditorSelection.cursor(line.from + indent.length),
        };
      }),
      { scrollIntoView: true, userEvent: "input" }
    );
    return true;
  };
  // Shift+Alt+I: 선택한 줄마다 줄 끝에 커서
  const cursorsAtLineEnds = editorView => {
    const lines = selectedLines(editorView.state);
    if (lines.length < 2) return false;
    editorView.dispatch({
      selection: CM.EditorSelection.create(lines.map(line => CM.EditorSelection.cursor(line.to))),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  };
  // Ctrl+Shift+L · Ctrl+F2: 선택이 비어 있으면 커서 아래 단어로 시작해 같은 항목을 모두 선택
  const selectAllOccurrences = editorView => {
    if (editorView.state.selection.main.empty) CM.selectNextOccurrence(editorView);
    return CM.selectSelectionMatches(editorView);
  };
  // Ctrl+↑ / Ctrl+↓: 커서가 숫자 위면 값 조절(cm-glsl-features), 아니면 VS Code처럼 화면만 한 줄 스크롤
  const scrollLines = direction => editorView => {
    editorView.scrollDOM.scrollTop += direction * editorView.defaultLineHeight;
    return true;
  };
  // Ctrl+J: 아래 패널(오류 목록) 열기/닫기
  // 패널은 열어도 초점은 코드에 둔다(그래야 Ctrl+J를 다시 눌러 닫을 수 있다). 목록을 키보드로 고르려면 Ctrl+Shift+M.
  const toggleLintPanel = editorView => {
    if (editorView.dom.querySelector(".cm-panel-lint")) CM.closeLintPanel(editorView);
    else {
      CM.openLintPanel(editorView);
      editorView.focus();
    }
    return true;
  };
  const zoom = step => () => {
    fontSize = Math.max(10, Math.min(20, fontSize + step));
    applyPresentation();
    return true;
  };
  // Shift+Alt+→ / ←: 선택 영역 확장 / 축소. 구문 트리가 없으므로 단어 → 줄 내용 → 괄호 안 → 괄호 포함 → … → 문서 전체 순서로,
  // 지금 선택을 감싸는 후보 가운데 가장 작은 것으로 넓힌다. 축소는 넓히기 전 선택으로 차례로 돌아간다.
  const CLOSE_OF = { "(": ")", "[": "]", "{": "}" };
  const matchClose = (text, open) => {
    const stack = [];
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (CLOSE_OF[c]) stack.push(CLOSE_OF[c]);
      else if (c === ")" || c === "]" || c === "}") {
        if (stack.pop() !== c) return -1;
        if (!stack.length) return i;
      }
    }
    return -1;
  };
  const enclosingPair = (text, from, to) => {
    const stack = [];
    for (let i = from - 1; i >= 0; i--) {
      const c = text[i];
      if (c === ")" || c === "]" || c === "}") stack.push(c);
      else if (CLOSE_OF[c]) {
        if (stack.length) {
          if (stack.pop() !== CLOSE_OF[c]) return null;
        } else {
          const close = matchClose(text, i);
          if (close >= to) return { open: i, close };
        }
      }
    }
    return null;
  };
  const growRange = (state, text, from, to) => {
    const candidates = [],
      line = state.doc.lineAt(from);
    const word = state.wordAt(from);
    if (word) candidates.push(word);
    if (state.doc.lineAt(to).number === line.number) {
      const start = line.from + /^\s*/.exec(line.text)[0].length,
        end = line.from + line.text.replace(/\s+$/, "").length;
      if (end > start) candidates.push({ from: start, to: end });
    }
    const pair = enclosingPair(text, from, to);
    if (pair) candidates.push({ from: pair.open + 1, to: pair.close }, { from: pair.open, to: pair.close + 1 });
    candidates.push({ from: 0, to: state.doc.length });
    return (
      candidates
        .filter(c => c.from <= from && c.to >= to && c.to - c.from > to - from)
        .sort((a, b) => a.to - a.from - (b.to - b.from))[0] || null
    );
  };
  let growHistory = [],
    grownSelection = null;
  const expandSelection = editorView => {
    const state = editorView.state,
      text = state.doc.toString();
    if (!grownSelection || !grownSelection.eq(state.selection)) growHistory = [];
    const next = CM.EditorSelection.create(
      state.selection.ranges.map(range => {
        const grown = growRange(state, text, range.from, range.to);
        return grown ? CM.EditorSelection.range(grown.from, grown.to) : range;
      }),
      state.selection.mainIndex
    );
    if (next.eq(state.selection)) return true;
    growHistory.push(state.selection);
    grownSelection = next;
    editorView.dispatch({ selection: next, scrollIntoView: true, userEvent: "select" });
    return true;
  };
  const shrinkSelection = editorView => {
    if (!grownSelection || !grownSelection.eq(editorView.state.selection) || !growHistory.length) return false;
    grownSelection = growHistory.pop();
    editorView.dispatch({ selection: grownSelection, scrollIntoView: true, userEvent: "select" });
    return true;
  };
  const run = command => () => {
    command();
    return true;
  };
  // 키 이름은 CodeMirror 형식(Mod = Ctrl, Mac은 Cmd). "Mod-k Mod-0"처럼 띄어 쓰면 VS Code식 연속 입력(chord)이다.
  // keyCode가 없는 키 이벤트(합성 이벤트·일부 키보드 배열)는 Shift+글자를 대문자 이름으로만 보내므로 대문자 이름에도 같이 묶는다.
  const both = (key, command) => [
    { key, run: command },
    { key: key.replace(/-([a-z])$/, (_, c) => `-${c.toUpperCase()}`), run: command },
  ];
  const editorKeys = [
    ...(acceptCompletion ? [{ key: "Tab", run: acceptCompletion }] : []),
    // 탐색: 명령(>) · 패스(파일) · 함수·변수(@) · 줄(:)
    ...both(
      "Mod-Shift-p",
      run(() => openPalette(">"))
    ),
    { key: "F1", run: run(() => openPalette(">")) },
    { key: "Mod-p", run: run(() => openPalette("")) },
    ...both(
      "Mod-Shift-o",
      run(() => openPalette("@"))
    ),
    { key: "Mod-g", run: run(() => openPalette(":")) },
    { key: "Mod-h", run: run(() => showFind(true)) },
    // 자동 완성
    { key: "Mod-Space", run: CM.startCompletion },
    { key: "Mod-i", run: CM.startCompletion },
    // 선택
    { key: "Mod-l", run: CM.selectLine },
    ...both("Mod-Shift-l", selectAllOccurrences),
    { key: "Mod-F2", run: selectAllOccurrences },
    { key: "Mod-Alt-ArrowUp", run: CM.addCursorAbove },
    { key: "Mod-Alt-ArrowDown", run: CM.addCursorBelow },
    ...both("Shift-Alt-i", cursorsAtLineEnds),
    { key: "Shift-Alt-ArrowRight", run: expandSelection },
    { key: "Shift-Alt-ArrowLeft", run: shrinkSelection },
    // 편집
    { key: "Mod-Enter", run: CM.insertBlankLine },
    { key: "Mod-Shift-Enter", run: insertLineAbove },
    { key: "Mod-k Mod-c", run: lineComment(true) },
    { key: "Mod-k Mod-u", run: lineComment(false) },
    ...both("Mod-Shift-d", CM.copyLineDown), // 예전 편집기의 줄 복제 키(VS Code는 Shift+Alt+↓)
    { key: "Mod-Shift-\\", run: CM.cursorMatchingBracket },
    // 접기 · 오류 · 보기
    { key: "Mod-k Mod-0", run: CM.foldAll },
    { key: "Mod-k Mod-j", run: CM.unfoldAll },
    { key: "Shift-F8", run: CM.previousDiagnostic },
    { key: "Mod-j", run: toggleLintPanel },
    {
      key: "Alt-z",
      run: run(() => {
        wrap = !wrap;
        applyPresentation();
      }),
    },
    { key: "Mod-=", run: zoom(1) },
    { key: "Mod-+", run: zoom(1) },
    { key: "Mod--", run: zoom(-1) },
    { key: "Mod-ArrowUp", run: scrollLines(-1) },
    { key: "Mod-ArrowDown", run: scrollLines(1) },
  ];
  // studio가 등록하는 편집기 바깥 명령(도구 서랍·집중 모드 등)의 키는 registerCommands 때 이 칸에 다시 묶는다.
  const commandKeys = new CM.Compartment();
  // CodeMirror 내장 UI(검색 창·접기·오류 목록·자동 완성) 문구를 한국어로 (EditorState.phrases)
  const PHRASES = {
    "Find": "찾기",
    "Replace": "바꿀 내용",
    "next": "다음",
    "previous": "이전",
    "all": "모두 선택",
    "match case": "대소문자",
    "by word": "단어 단위",
    "regexp": "정규식",
    "replace": "바꾸기",
    "replace all": "모두 바꾸기",
    "close": "닫기",
    "current match": "현재 일치",
    "on line": "줄",
    "replaced match on line $": "$번째 줄에서 바꿈",
    "replaced $ matches": "$곳을 바꿈",
    "Go to line": "줄 이동",
    "go": "이동",
    "to": "→",
    "Folded lines": "접은 줄",
    "Unfolded lines": "편 줄",
    "Fold line": "접기",
    "Unfold line": "펴기",
    "folded code": "접힌 코드",
    "unfold": "펴기",
    "Diagnostics": "오류 목록",
    "No diagnostics": "오류 없음",
    "Completions": "자동 완성 후보",
    "Control character": "제어 문자",
  };
  view = new CM.EditorView({
    parent: host,
    state: CM.EditorState.create({
      doc: textarea.value,
      extensions: [
        CM.lineNumbers(),
        CM.highlightActiveLineGutter(),
        CM.foldGutter(),
        CM.codeFolding(),
        braceFold,
        CM.highlightSpecialChars(),
        CM.drawSelection(),
        CM.dropCursor(),
        CM.EditorState.allowMultipleSelections.of(true),
        // 사각(열) 선택은 VS Code처럼 Shift+Alt+드래그. Alt+클릭은 커서 추가, 숫자 위 Alt+드래그는 값 조절로 쓴다.
        CM.rectangularSelection({ eventFilter: event => event.altKey && event.shiftKey }),
        CM.highlightActiveLine(),
        CM.highlightSelectionMatches(),
        CM.indentOnInput(),
        CM.bracketMatching(),
        CM.closeBrackets(),
        glsl,
        CM.syntaxHighlighting(glslStyle),
        CM.autocompletion({ override: [completionSource], icons: true, activateOnTyping: true }),
        hover,
        CM.lintGutter(),
        CM.search({ top: true }),
        forwardKeys,
        beforeUserEdit,
        ...features.extensions,
        CM.scrollPastEnd(),
        CM.EditorView.clickAddsSelectionRange.of(event => event.altKey && !event.ctrlKey && !event.metaKey), // Alt+클릭: 커서 추가 (Ctrl+클릭은 정의로 이동)
        commandKeys.of([]),
        CM.keymap.of([
          ...editorKeys,
          ...CM.closeBracketsKeymap,
          ...CM.completionKeymap,
          ...CM.searchKeymap,
          ...CM.foldKeymap,
          ...CM.lintKeymap,
          ...CM.defaultKeymap,
          { key: "Tab", run: insertSoftTab, shift: CM.indentLess },
        ]),
        fontComp.of(fontTheme()),
        wrapComp.of(wrap ? CM.EditorView.lineWrapping : []),
        tabComp.of(tabConfig()),
        editorTheme,
        CM.EditorView.contentAttributes.of({
          "aria-label": "GLSL 코드 편집기",
          spellcheck: "false",
          autocorrect: "off",
          autocapitalize: "off",
        }),
        CM.EditorState.phrases.of(PHRASES),
        CM.placeholder("// GLSL 코드를 입력하세요 · Ctrl+Space 자동 완성 · Ctrl+Shift+P 명령 팔레트"),
        CM.EditorView.updateListener.of(notifyTextarea),
      ],
    }),
  });
  facade("value", {
    get: () => view.state.doc.toString(),
    set: value => {
      value = String(value ?? "");
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: value.length },
        annotations: External.of(true),
      });
    },
  });
  facade("selectionStart", {
    get: () => view.state.selection.main.from,
    set: value => setSelection(value, Math.max(Number(value) || 0, view.state.selection.main.to)),
  });
  facade("selectionEnd", {
    get: () => view.state.selection.main.to,
    set: value => setSelection(Math.min(view.state.selection.main.from, Number(value) || 0), value),
  });
  facade("selectionDirection", {
    get: () => {
      const m = view.state.selection.main;
      return m.empty ? "none" : m.head < m.anchor ? "backward" : "forward";
    },
    set: () => {},
  });
  // 스크롤 위치: CodeMirror는 문서가 바뀐 뒤 다음 측정 단계에서 스크롤을 자체 기준으로 다시 맞추므로, 그 단계에서도 한 번 더 적용한다(되돌리기 후 스크롤 복원).
  const setScroll = (axis, value) => {
    view.scrollDOM[axis] = value;
    view.requestMeasure({
      key: `facade-${axis}`,
      read: () => null,
      write: () => {
        view.scrollDOM[axis] = value;
      },
    });
  };
  facade("scrollTop", { get: () => view.scrollDOM.scrollTop, set: value => setScroll("scrollTop", value) });
  facade("scrollLeft", { get: () => view.scrollDOM.scrollLeft, set: value => setScroll("scrollLeft", value) });
  facade("setSelectionRange", { value: (a, b, direction = "none") => setSelection(a, b, direction) });
  facade("select", { value: () => setSelection(0, view.state.doc.length) });
  // textarea의 focus()처럼 내용 스크롤 위치는 그대로 둔다(CodeMirror의 focus는 화면 밖 커서 쪽으로 스크롤할 수 있다).
  facade("focus", {
    value: () => {
      const top = view.scrollDOM.scrollTop,
        left = view.scrollDOM.scrollLeft;
      view.focus();
      if (view.scrollDOM.scrollTop !== top) setScroll("scrollTop", top);
      if (view.scrollDOM.scrollLeft !== left) setScroll("scrollLeft", left);
    },
  });
  facade("blur", { value: () => view.contentDOM.blur() });
  // HTMLTextAreaElement.setRangeText와 같은 규칙(select · start · end · preserve)으로 선택을 옮긴다.
  facade("setRangeText", {
    value: (text, start, end, mode = "preserve") => {
      const main = view.state.selection.main;
      text = String(text);
      if (start === undefined) {
        start = main.from;
        end = main.to;
      }
      start = clamp(start);
      end = Math.max(start, clamp(end));
      const delta = text.length - (end - start),
        moved = p => (p > end ? p + delta : p > start ? start : p),
        movedEnd = p => (p > end ? p + delta : p > start ? start + text.length : p);
      const sel =
        mode === "select"
          ? [start, start + text.length]
          : mode === "start"
            ? [start, start]
            : mode === "end"
              ? [start + text.length, start + text.length]
              : [moved(main.from), movedEnd(main.to)];
      view.dispatch({
        changes: { from: start, to: end, insert: text },
        selection: { anchor: sel[0], head: sel[1] },
        annotations: External.of(true),
      });
    },
  });
  // studio가 기다리는 나머지 사용자 이벤트(클릭·키 놓기·스크롤·포인터)도 textarea로 알린다.
  for (const type of ["click", "keyup", "pointerdown", "beforeinput"])
    listen(view.contentDOM, type, () => textarea.dispatchEvent(new Event(type)));
  listen(view.scrollDOM, "scroll", () => textarea.dispatchEvent(new Event("scroll")));

  const applyPresentation = () => {
    view.dispatch({
      effects: [
        fontComp.reconfigure(fontTheme()),
        wrapComp.reconfigure(wrap ? CM.EditorView.lineWrapping : []),
        tabComp.reconfigure(tabConfig()),
      ],
    });
    $("studioFontSize") && ($("studioFontSize").textContent = `${fontSize}px`);
    $("studioIndent") && ($("studioIndent").value = String(tabSize));
    $("studioLineWrap")?.setAttribute("aria-pressed", String(wrap));
    save();
  };
  const goToLine = (line, column = 1) => {
    const doc = view.state.doc;
    line = Math.min(doc.lines, Math.max(1, Number(line) || 1));
    const row = doc.line(line),
      at = row.from + Math.min(row.length, Math.max(0, column - 1));
    view.focus();
    view.dispatch({
      selection: { anchor: at },
      effects: CM.EditorView.scrollIntoView(at, { y: "center" }),
      annotations: External.of(true),
    });
    return line;
  };
  const showFind = (replace = false) => {
    CM.openSearchPanel(view);
    if (replace) setTimeout(() => view.dom.querySelector(".cm-search input[name=replace]")?.focus(), 0);
  };
  const setDiagnostics = list => {
    const doc = view.state.doc,
      items = (Array.isArray(list) ? list : []).filter(
        item =>
          Number.isInteger(item?.line) && item.line >= 1 && item.line <= doc.lines && typeof item.message === "string"
      );
    view.dispatch(
      CM.setDiagnostics(
        view.state,
        items.map(item => {
          const row = doc.line(item.line);
          return {
            from: row.from,
            to: row.to,
            severity: item.severity === "warning" ? "warning" : "error",
            message: item.message,
          };
        })
      )
    );
    features.setDiagnostics(view, items);
  };

  // ---- 명령 팔레트: 기본 편집기와 같은 모양(.studio-palette) · @ 함수·변수로 이동 · : 줄 번호 ----
  const palette = document.createElement("div"),
    paletteInput = document.createElement("input"),
    paletteList = document.createElement("div");
  palette.className = "studio-palette";
  palette.hidden = true;
  palette.setAttribute("role", "dialog");
  palette.setAttribute("aria-label", "명령 팔레트");
  paletteInput.className = "studio-palette-input";
  paletteInput.placeholder = "패스 이름 · > 명령 · @ 함수·변수 · : 줄 번호";
  paletteInput.setAttribute("aria-label", "명령 검색");
  paletteList.className = "studio-palette-list";
  paletteList.setAttribute("role", "listbox");
  palette.append(paletteInput, paletteList);
  pane?.append(palette);
  let paletteItems = [],
    paletteChoice = 0;
  const builtInCommands = () => [
    { label: "찾기", key: "Ctrl+F", run: () => showFind() },
    { label: "찾아 바꾸기", key: "Ctrl+H", run: () => showFind(true) },
    { label: "줄 번호로 이동", key: "Ctrl+G", run: () => openPalette(":") },
    { label: "함수·변수로 이동", key: "Ctrl+Shift+O", run: () => openPalette("@") },
    { label: "패스로 이동 (Image · Buffer)", key: "Ctrl+P", run: () => openPalette("") },
    { label: "자동 완성 열기", key: "Ctrl+Space · Ctrl+I", run: () => CM.startCompletion(view) },
    { label: "줄 주석 전환", key: "Ctrl+/", run: () => CM.toggleComment(view) },
    { label: "블록 주석 전환 (/* */)", key: "Shift+Alt+A", run: () => CM.toggleBlockComment(view) },
    { label: "줄 주석 추가", key: "Ctrl+K Ctrl+C", run: () => lineComment(true)(view) },
    { label: "줄 주석 제거", key: "Ctrl+K Ctrl+U", run: () => lineComment(false)(view) },
    { label: "다음 일치 항목 선택 추가", key: "Ctrl+D", run: () => CM.selectNextOccurrence(view) },
    { label: "모든 일치 항목 선택", key: "Ctrl+Shift+L · Ctrl+F2", run: () => selectAllOccurrences(view) },
    { label: "선택 영역 확장 / 축소", key: "Shift+Alt+→ / ←", run: () => expandSelection(view) },
    { label: "선택한 줄마다 줄 끝에 커서", key: "Shift+Alt+I", run: () => cursorsAtLineEnds(view) },
    { label: "아래에 줄 삽입", key: "Ctrl+Enter", run: () => CM.insertBlankLine(view) },
    { label: "위에 줄 삽입", key: "Ctrl+Shift+Enter", run: () => insertLineAbove(view) },
    { label: "줄 삭제", key: "Ctrl+Shift+K", run: () => CM.deleteLine(view) },
    { label: "짝 괄호로 이동", key: "Ctrl+Shift+\\", run: () => CM.cursorMatchingBracket(view) },
    { label: "들여쓰기", key: "Ctrl+]", run: () => CM.indentMore(view) },
    { label: "내어쓰기", key: "Ctrl+[", run: () => CM.indentLess(view) },
    { label: "정의로 이동", key: "F12 · Ctrl+클릭", run: () => features.goToDefinition(view) },
    { label: "이름 바꾸기 (같은 이름 모두)", key: "F2", run: () => features.renameSymbol(view) },
    { label: "색상 선택기 열기 (커서 위치의 vec3/vec4)", run: () => features.openColorPicker(view) },
    {
      label: "커서 위 숫자 올리기 / 내리기 (숫자 밖에서는 한 줄 스크롤)",
      key: "Ctrl+↑ / Ctrl+↓",
      run: () => features.nudge(1, 1)(view) || notify("커서를 숫자 위에 두세요"),
    },
    { label: "커서를 위에 추가", key: "Ctrl+Alt+↑", run: () => CM.addCursorAbove(view) },
    { label: "커서를 아래에 추가", key: "Ctrl+Alt+↓", run: () => CM.addCursorBelow(view) },
    { label: "줄을 위로 이동", key: "Alt+↑", run: () => CM.moveLineUp(view) },
    { label: "줄을 아래로 이동", key: "Alt+↓", run: () => CM.moveLineDown(view) },
    { label: "줄을 위로 복사", key: "Shift+Alt+↑", run: () => CM.copyLineUp(view) },
    { label: "줄을 아래로 복사", key: "Shift+Alt+↓", run: () => CM.copyLineDown(view) },
    { label: "현재 블록 접기", key: "Ctrl+Shift+[", run: () => CM.foldCode(view) },
    { label: "현재 블록 펴기", key: "Ctrl+Shift+]", run: () => CM.unfoldCode(view) },
    { label: "모두 접기", key: "Ctrl+K Ctrl+0", run: () => CM.foldAll(view) },
    { label: "모두 펴기", key: "Ctrl+K Ctrl+J", run: () => CM.unfoldAll(view) },
    { label: "오류 목록 열기", key: "Ctrl+Shift+M", run: () => CM.openLintPanel(view) },
    { label: "아래 패널(오류 목록) 열기/닫기", key: "Ctrl+J", run: () => toggleLintPanel(view) },
    { label: "다음 오류로", key: "F8", run: () => CM.nextDiagnostic(view) },
    { label: "이전 오류로", key: "Shift+F8", run: () => CM.previousDiagnostic(view) },
    { label: "Tab 키로 포커스 이동 켜기/끄기 (접근성)", key: "Ctrl+M", run: () => CM.toggleTabFocusMode(view) },
    {
      label: "긴 줄 자동 줄바꿈 켜기/끄기",
      key: "Alt+Z",
      run: () => {
        wrap = !wrap;
        applyPresentation();
      },
    },
    { label: "글자 크게", key: "Ctrl+=", run: zoom(1) },
    { label: "글자 작게", key: "Ctrl+-", run: zoom(-1) },
    {
      label: "들여쓰기 크기 2 ↔ 4 바꾸기",
      run: () => {
        tabSize = tabSize === 4 ? 2 : 4;
        applyPresentation();
      },
    },
  ];
  const paletteEntries = () => {
    const value = paletteInput.value;
    // VS Code와 같은 접두어: 없음 = 패스(파일)로 이동(Ctrl+P) · > 명령(Ctrl+Shift+P) · @ 함수·변수(Ctrl+Shift+O) · : 줄 번호(Ctrl+G)
    if (value.startsWith(">"))
      return {
        items: [...commands, ...builtInCommands()].map(c => ({ label: c.label, hint: c.key || "", run: c.run })),
        query: value.slice(1).trim(),
      };
    if (value.startsWith(":")) {
      const line = Number(value.slice(1));
      return [
        {
          label: line ? `${line}번째 줄로 이동` : `줄 번호 입력 (1–${view.state.doc.lines})`,
          run: () => line && goToLine(line),
        },
      ];
    }
    if (value.startsWith("@")) {
      // 문서 순서대로, 종류 아이콘(ƒ 함수 · U uniform · O out · # define · S struct)과 함께. 고르는 동안 그 위치를 미리 보여 준다.
      const sym = symbolsOf(view.state.doc.toString()),
        query = value.slice(1).trim();
      const symbol = (kind, name, offset, line, hint) => ({
        label: name,
        kind,
        offset,
        line,
        hint: `${hint} · Ln ${line}`,
        symbol: true,
        run: () => jumpTo(offset, name.length),
      });
      const items = [
        ...sym.functions.map(f => symbol("function", f.name, f.offset, f.line, `${f.ret} (${f.params})`)),
        ...[...sym.structs].map(([name, s]) =>
          symbol("struct", name, s.offset, s.line, `struct · 필드 ${s.fields.length}개`)
        ),
        ...sym.variables
          .filter(v => v.uniform || v.output)
          .map(v =>
            symbol(
              v.uniform ? "uniform" : "output",
              v.name,
              v.offset,
              v.line,
              `${v.uniform ? "uniform" : "out"} ${v.type}`
            )
          ),
        ...sym.defines.map(d =>
          symbol("define", d.name, d.offset, d.line, `#define${d.value ? ` ${d.value.slice(0, 24)}` : ""}`)
        ),
      ].sort((a, b) => a.offset - b.offset);
      return { items, query };
    }
    const files = fileProvider();
    const fileItems = files.map(file => ({
      label: file.label,
      kind: "file",
      hint: file.current ? `${file.hint || ""} · 지금 편집 중`.replace(/^ · /, "") : file.hint || "",
      run: file.run,
    }));
    // 패스 이름이 아닌 글자를 치면 명령도 함께 찾는다(> 없이 바로 명령을 찾던 예전 습관도 그대로 동작).
    const commandItems = value.trim()
      ? [...commands, ...builtInCommands()].map(c => ({ label: c.label, hint: c.key || "", run: c.run }))
      : [];
    return { items: [...fileItems, ...commandItems], query: value.trim() };
  };
  let fileProvider = () => [];
  const renderPalette = () => {
    const entries = paletteEntries(),
      items = Array.isArray(entries) ? entries : entries.items,
      query = Array.isArray(entries) ? "" : entries.query;
    paletteItems = query
      ? items
          .map(item => ({ item, m: fuzzy(item.label, query) }))
          .filter(x => x.m)
          .sort((a, b) => b.m.score - a.m.score)
          .map(x => x.item)
      : items;
    paletteChoice = Math.min(paletteChoice, Math.max(0, paletteItems.length - 1));
    // 종류 아이콘은 CSS(.palette-kind.is-*)가 SVG 마스크로 그린다. 글자는 넣지 않고 종류 이름은 title로 알린다.
    const KIND_LABEL = {
      function: "함수",
      struct: "구조체",
      uniform: "uniform",
      output: "출력",
      define: "#define",
      file: "패스",
    };
    paletteList.replaceChildren(
      ...paletteItems.map((item, i) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.index = i;
        button.className = `${i === paletteChoice ? "is-selected" : ""}${item.kind ? " has-kind" : ""}`.trim();
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(i === paletteChoice));
        if (item.kind) {
          const kind = document.createElement("span");
          kind.className = `palette-kind is-${item.kind}`;
          kind.setAttribute("aria-hidden", "true");
          kind.title = KIND_LABEL[item.kind];
          button.append(kind);
        }
        const label = document.createElement("span");
        label.textContent = item.label;
        const hint = document.createElement("span");
        hint.className = "palette-hint";
        hint.textContent = item.hint || "";
        button.append(label, hint);
        return button;
      })
    );
    if (!paletteItems.length) {
      const empty = document.createElement("p");
      empty.className = "palette-empty";
      empty.textContent = "일치하는 항목이 없습니다";
      paletteList.append(empty);
    }
    paletteList.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
    previewChoice();
  };
  // 이름 위치로 이동: 이름을 선택하고 화면 가운데로.
  const jumpTo = (offset, length = 0) => {
    const at = Math.min(offset, view.state.doc.length);
    view.focus();
    view.dispatch({
      selection: { anchor: at, head: Math.min(at + length, view.state.doc.length) },
      effects: CM.EditorView.scrollIntoView(at, { y: "center" }),
      annotations: External.of(true),
    });
  };
  // @ 목록에서 고르는 동안 편집기 포커스는 그대로 팔레트에 두고 위치만 미리 보여 준다. Esc는 열기 전 커서·스크롤로 되돌린다.
  let paletteOrigin = null;
  const previewChoice = () => {
    const item = paletteItems[paletteChoice];
    if (!paletteOrigin || !item?.symbol) return;
    view.dispatch({
      selection: { anchor: item.offset, head: item.offset + item.label.length },
      effects: CM.EditorView.scrollIntoView(item.offset, { y: "center" }),
      annotations: External.of(true),
    });
  };
  const restoreOrigin = () => {
    if (!paletteOrigin) return;
    const { selection, top, left } = paletteOrigin;
    paletteOrigin = null;
    view.dispatch({ selection, annotations: External.of(true) });
    setScroll("scrollTop", top);
    setScroll("scrollLeft", left);
  };
  const openPalette = (prefix = ">") => {
    palette.hidden = false;
    paletteInput.value = prefix;
    paletteChoice = 0;
    paletteOrigin = { selection: view.state.selection, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
    if (prefix === "@") {
      // 지금 커서가 들어 있는 함수(없으면 커서 바로 앞의 항목)를 먼저 고른다
      const head = view.state.selection.main.head,
        current = functionAt(head),
        list = paletteEntries().items;
      const index = current
        ? list.findIndex(item => item.kind === "function" && item.offset >= current.from && item.offset <= current.to)
        : list.reduce((best, item, i) => (item.offset <= head ? i : best), 0);
      paletteChoice = Math.max(0, index);
    }
    symbols?.setAttribute("aria-expanded", String(prefix === "@"));
    renderPalette();
    paletteInput.focus();
    paletteInput.setSelectionRange(paletteInput.value.length, paletteInput.value.length);
  };
  const closePalette = (refocus = true) => {
    if (palette.hidden) return;
    palette.hidden = true;
    paletteOrigin = null;
    symbols?.setAttribute("aria-expanded", "false");
    if (refocus) view.focus();
  };
  const runPaletteItem = index => {
    const item = paletteItems[index];
    if (!item) return;
    paletteOrigin = null;
    closePalette();
    item.run?.();
  };
  listen(paletteInput, "input", () => {
    // 명령 모드(>)에서 @ 나 : 를 치면 그 모드로 바꾼다(VS Code에서 > 를 지우고 치는 것과 같은 결과).
    const switched = /^>\s*([@:].*)$/.exec(paletteInput.value);
    if (switched) paletteInput.value = switched[1];
    paletteChoice = 0;
    renderPalette();
  });
  listen(paletteInput, "keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (paletteItems.length) {
        paletteChoice =
          (paletteChoice + (event.key === "ArrowDown" ? 1 : -1) + paletteItems.length) % paletteItems.length;
        renderPalette();
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      runPaletteItem(paletteChoice);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      restoreOrigin();
      closePalette();
    }
  });
  listen(paletteInput, "blur", () =>
    setTimeout(() => {
      if (!palette.contains(document.activeElement)) closePalette(false);
    }, 0)
  );
  listen(paletteList, "pointerdown", event => event.preventDefault());
  listen(paletteList, "click", event => {
    const item = event.target.closest("button[data-index]");
    if (item) runPaletteItem(Number(item.dataset.index));
  });
  // 명령에 bind(CodeMirror 키 이름 또는 그 배열)가 있으면 편집기 안에서 그 키로도 실행한다.
  const registerCommands = list => {
    commands = [...commands, ...list.filter(c => c && typeof c.run === "function" && c.label)];
    const bindings = commands.flatMap(c =>
      [].concat(c.bind || []).map(key => ({
        key,
        run: () => {
          c.run();
          return true;
        },
      }))
    );
    view.dispatch({ effects: commandKeys.reconfigure(CM.keymap.of(bindings)) });
  };
  // Ctrl+P 목록(패스 = VS Code의 파일). studio가 [{label, hint, current, run}]을 돌려주는 함수를 넘긴다.
  const setFiles = provider => {
    fileProvider = typeof provider === "function" ? () => provider() || [] : () => [];
  };

  // ---- 편집기 도구 버튼 ----
  listen($("studioFind"), "click", () => showFind());
  listen($("studioReplace"), "click", () => showFind(true));
  listen($("studioGoto"), "click", () => openPalette(":"));
  listen($("studioComplete"), "click", () => {
    view.focus();
    CM.startCompletion(view);
  });
  listen($("studioPaletteOpen"), "click", () => openPalette());
  listen($("studioFoldAll"), "click", () => {
    CM.foldAll(view);
    view.focus();
  });
  listen($("studioUnfoldAll"), "click", () => {
    CM.unfoldAll(view);
    view.focus();
  });
  listen($("studioLintPanel"), "click", () => CM.openLintPanel(view));
  listen($("studioRename"), "click", () => features.renameSymbol(view));
  listen($("studioDefinition"), "click", () => features.goToDefinition(view));
  listen(symbols, "click", () => (palette.hidden ? openPalette("@") : closePalette()));
  listen(symbols, "mousedown", event => {
    if (!palette.hidden) event.preventDefault();
  }); // 열린 팔레트의 blur 닫기와 겹쳐 다시 열리지 않도록
  listen($("studioZoomIn"), "click", () => {
    fontSize = Math.min(20, fontSize + 1);
    applyPresentation();
  });
  listen($("studioZoomOut"), "click", () => {
    fontSize = Math.max(10, fontSize - 1);
    applyPresentation();
  });
  listen($("studioLineWrap"), "click", () => {
    wrap = !wrap;
    applyPresentation();
  });
  listen($("studioIndent"), "change", event => {
    tabSize = event.target.value === "2" ? 2 : 4;
    applyPresentation();
  });
  listen(document, "keydown", event => {
    const open =
      (event.key === "F1" || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyP")) &&
      host.offsetParent &&
      !view.hasFocus;
    if (open) {
      event.preventDefault();
      event.stopPropagation();
      openPalette();
    }
  });
  applyPresentation();
  updateStatus(view.state);
  updateFunctions();

  return {
    update: () => {
      CM.closeCompletion(view);
      updateStatus(view.state);
      updateFunctions();
    },
    goToLine,
    showFind,
    setDiagnostics,
    registerCommands,
    setFiles,
    openPalette,
    view: () => view,
    // 접힌 블록 목록([from, to]). studio가 패스를 바꿀 때 패스별로 보관했다가 돌아오면 다시 접는다.
    getFolds: () => {
      const list = [];
      CM.foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
        list.push([from, to]);
      });
      return list;
    },
    setFolds: list => {
      const length = view.state.doc.length,
        effects = (list || [])
          .filter(([from, to]) => from >= 0 && from < to && to <= length)
          .map(([from, to]) => CM.foldEffect.of({ from, to }));
      if (effects.length) view.dispatch({ effects });
    },
    dispose: () => {
      ac.abort();
      features.dispose();
      view.destroy();
      host.remove();
      palette.remove();
      frame?.classList.remove("is-codemirror");
      for (const name of [
        "value",
        "selectionStart",
        "selectionEnd",
        "selectionDirection",
        "scrollTop",
        "scrollLeft",
        "setSelectionRange",
        "select",
        "focus",
        "blur",
        "setRangeText",
      ])
        delete textarea[name];
    },
  };
};
export { mount };
