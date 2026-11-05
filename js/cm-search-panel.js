// 코드 편집기의 찾기 · 바꾸기 창(CodeMirror search의 createPanel).
// 기본 창은 입력 칸·체크박스·버튼이 한 줄로 흘러 구조가 복잡하고, Tab이 찾기 → 다음 → 이전 → 모두 선택 … 순으로 돌았다.
// 이 창은 두 줄로 나눈다:
//   1줄  [▸] [찾기 ............] [Aa][단어][.*]  3/12  [↑][↓][모두 선택]  [×]
//   2줄      [바꿀 내용 ........] [바꾸기][모두 바꾸기]
// 모드가 둘이다(VS Code와 같다): Ctrl+F = 찾기만(1줄), Ctrl+H = 찾아 바꾸기(2줄). 맨 앞 [▸] 버튼으로도 바꾸기 줄을 여닫는다.
// 찾기 모드에서는 바꾸기 줄을 숨기고 바꾸기 단축키도 받지 않는다(보이지 않는 칸의 내용으로 문서가 바뀌지 않게).
// 모드는 창의 data-mode("find" | "replace")에 두고, 편집기(cm-editor.js의 showFind)는 "studio-find-mode" 이벤트로 바꾼다.
// DOM 순서는 찾기 → 바꿀 내용 → 찾기 도구 → 바꾸기 도구 → 닫기 → [▸]라서, 바꾸기 모드에서 찾기 칸 다음 Tab은 바로 바꿀 내용으로 간다.
// 자리는 CSS grid(style.css의 .studio-find)가 잡는다.
const MATCH_LIMIT = 1000; // 일치 개수는 이만큼까지만 센다(긴 문서·짧은 정규식에서 입력이 느려지지 않게).

const createSearchPanel = CM => view => {
  const element = (tag, attrs = {}, text = "") => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text) node.textContent = text;
    return node;
  };
  const button = (name, label, title, className = "") => {
    const node = element("button", { type: "button", name, title, "aria-label": title }, label);
    node.className = `studio-find-button ${className}`.trim();
    return node;
  };
  const toggle = (name, label, title) => {
    const node = button(name, label, title, "studio-find-toggle");
    node.setAttribute("aria-pressed", "false");
    return node;
  };
  const field = (name, placeholder) =>
    element("input", {
      type: "text",
      name,
      placeholder,
      "aria-label": placeholder,
      class: "cm-textfield studio-find-field",
      autocomplete: "off",
      spellcheck: "false",
    });

  const search = field("search", "찾기"),
    replace = field("replace", "바꿀 내용"),
    caseToggle = toggle("case", "Aa", "대소문자 구분 (Alt+C)"),
    wordToggle = toggle("word", "단어", "단어 단위 (Alt+W)"),
    regexpToggle = toggle("re", ".*", "정규식 (Alt+R)"),
    count = element("span", { class: "studio-find-count", "aria-live": "polite" }),
    prev = button("prev", "", "이전 일치 (Shift+Enter)", "glyph-icon icon-up"),
    next = button("next", "", "다음 일치 (Enter)", "glyph-icon icon-down"),
    selectAll = button("select", "모두 선택", "일치 항목 모두 선택 (Alt+Enter)"),
    replaceOne = button("replace", "바꾸기", "바꾸기 (찾기 결과 하나 · 바꿀 내용 칸에서 Enter)"),
    replaceEvery = button("replaceAll", "모두 바꾸기", "모두 바꾸기 (Ctrl+Alt+Enter)"),
    close = button("close", "", "닫기 (Esc)", "glyph-icon icon-close studio-find-close"),
    modeToggle = button("mode", "", "바꾸기 줄 열기 (Ctrl+H)", "glyph-icon icon-chevron studio-find-mode");
  search.setAttribute("main-field", "true"); // openSearchPanel이 이 칸에 초점을 준다.

  const findTools = element("div", { class: "studio-find-tools", role: "group", "aria-label": "찾기 도구" });
  findTools.append(caseToggle, wordToggle, regexpToggle, count, prev, next, selectAll);
  const replaceTools = element("div", {
    class: "studio-find-replace-tools",
    role: "group",
    "aria-label": "바꾸기 도구",
  });
  replaceTools.append(replaceOne, replaceEvery);
  const dom = element("div", { class: "cm-search studio-find", role: "search", "aria-label": "찾기" });
  dom.append(search, replace, findTools, replaceTools, close, modeToggle);
  // 모드 바꾸기. focus: 바꾼 뒤 그 모드의 입력 칸(찾기 / 바꿀 내용)에 초점을 주고 내용을 선택한다.
  const setMode = (mode, focus = false) => {
    const replacing = mode === "replace";
    dom.dataset.mode = replacing ? "replace" : "find";
    dom.setAttribute("aria-label", replacing ? "찾기 · 바꾸기" : "찾기");
    modeToggle.setAttribute("aria-expanded", String(replacing));
    const label = replacing ? "바꾸기 줄 닫기 (Ctrl+F)" : "바꾸기 줄 열기 (Ctrl+H)";
    modeToggle.title = label;
    modeToggle.setAttribute("aria-label", label);
    // 숨긴 줄에 초점이 남지 않게 한다.
    if (!replacing && replaceTools.contains(document.activeElement)) focus = true;
    if (!replacing && document.activeElement === replace) focus = true;
    if (focus) {
      const target = replacing ? replace : search;
      target.focus();
      target.select();
    }
  };
  setMode("find");
  dom.addEventListener("studio-find-mode", event => setMode(event.detail, true));

  let query = CM.getSearchQuery(view.state);
  const toggles = [
    [caseToggle, "caseSensitive"],
    [wordToggle, "wholeWord"],
    [regexpToggle, "regexp"],
  ];
  const show = q => {
    query = q;
    if (search.value !== q.search) search.value = q.search;
    if (replace.value !== q.replace) replace.value = q.replace;
    for (const [node, key] of toggles) node.setAttribute("aria-pressed", String(!!q[key]));
  };
  // 일치 개수와 현재 위치("3/12"). 정규식이 틀렸으면 그렇게 알린다.
  const refreshCount = () => {
    search.classList.toggle("is-invalid", !query.valid && !!query.search);
    if (!query.search) {
      count.textContent = "";
      return;
    }
    if (!query.valid) {
      count.textContent = "잘못된 식";
      return;
    }
    const main = view.state.selection.main,
      cursor = query.getCursor(view.state);
    let total = 0,
      current = 0;
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      total++;
      if (step.value.from === main.from && step.value.to === main.to) current = total;
      if (total >= MATCH_LIMIT) break;
    }
    const many = total >= MATCH_LIMIT ? `${MATCH_LIMIT}+` : String(total);
    count.textContent = total ? `${current || "?"}/${many}` : "결과 없음";
    dom.classList.toggle("has-no-match", !total);
  };
  const commit = () => {
    const next = new CM.SearchQuery({
      search: search.value,
      replace: replace.value,
      caseSensitive: caseToggle.getAttribute("aria-pressed") === "true",
      wholeWord: wordToggle.getAttribute("aria-pressed") === "true",
      regexp: regexpToggle.getAttribute("aria-pressed") === "true",
    });
    if (!next.eq(query)) {
      query = next;
      view.dispatch({ effects: CM.setSearchQuery.of(next) });
    }
    refreshCount();
  };
  const run = command => {
    commit();
    command(view);
    refreshCount();
  };
  const flip = node => {
    node.setAttribute("aria-pressed", String(node.getAttribute("aria-pressed") !== "true"));
    commit();
  };
  search.addEventListener("input", commit);
  replace.addEventListener("input", commit);
  for (const [node] of toggles) node.addEventListener("click", () => flip(node));
  prev.addEventListener("click", () => run(CM.findPrevious));
  next.addEventListener("click", () => run(CM.findNext));
  selectAll.addEventListener("click", () => run(CM.selectMatches));
  replaceOne.addEventListener("click", () => run(CM.replaceNext));
  replaceEvery.addEventListener("click", () => run(CM.replaceAll));
  close.addEventListener("click", () => CM.closeSearchPanel(view));
  modeToggle.addEventListener("click", () => setMode(dom.dataset.mode === "replace" ? "find" : "replace", true));
  dom.addEventListener("keydown", event => {
    if (event.isComposing) return;
    const key = event.key,
      mod = event.ctrlKey || event.metaKey,
      replacing = dom.dataset.mode === "replace";
    const handled = (() => {
      if (key === "Escape") return CM.closeSearchPanel(view), true;
      if (key === "Enter" && mod && event.altKey) return replacing && run(CM.replaceAll), true; // 찾기 모드에서는 바꾸지 않는다
      if (key === "Enter" && event.altKey) return run(CM.selectMatches), true;
      if (key === "Enter" && event.target === replace) return replacing && run(CM.replaceNext), true;
      if (key === "Enter" && event.target === search) return run(event.shiftKey ? CM.findPrevious : CM.findNext), true;
      if (key === "F3") return run(event.shiftKey ? CM.findPrevious : CM.findNext), true;
      if (event.altKey && !mod) {
        const target = { c: caseToggle, w: wordToggle, r: regexpToggle }[event.code?.replace(/^Key/, "").toLowerCase()];
        if (target) return flip(target), true;
      }
      // 창 안에서 Ctrl+F는 찾기만, Ctrl+H는 찾아 바꾸기로 모드를 바꾸고 그 칸에 초점을 준다(브라우저 찾기 창이 뜨지 않게).
      if (mod && !event.altKey && !event.shiftKey && (key === "f" || key === "h"))
        return setMode(key === "h" ? "replace" : "find", true), true;
      return false;
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  show(query);
  return {
    dom,
    top: true,
    // 창이 처음 열릴 때 찾기 칸에 초점을 주고 내용을 선택한다(다시 열 때는 openSearchPanel이 main-field에 준다).
    mount() {
      search.select();
      refreshCount();
    },
    update(update) {
      for (const tr of update.transactions)
        for (const effect of tr.effects)
          if (effect.is(CM.setSearchQuery) && !effect.value.eq(query)) show(effect.value);
      if (update.docChanged || update.selectionSet || update.transactions.some(tr => tr.effects.length)) refreshCount();
    },
  };
};

export { createSearchPanel };
