// node tests/popout-regression.js — 미리보기 분리 창(js/popout.js)의 DOM 계약을 가짜 문서로 검사한다(GPU·브라우저 불필요).
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "..", "js", "popout.js"), "utf8").replace(/\bexport \{([^{}]+)\};\s*$/, "return {$1};");
const factory = new Function("document", "CustomEvent", "setTimeout", "clearTimeout", source);

class El {
  constructor(tag) { this.tagName = tag; this.parent = null; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.dataset = {}; this.textContent = ""; this.title = "";
    const classes = this.classes = new Set(); this.classList = {toggle:(c, on) => on ? classes.add(c) : classes.delete(c), contains:c => classes.has(c)}; }
  detach() { if(this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  append(...nodes) { for(const node of nodes) { node.detach(); node.parent = this; this.children.push(node); } }
  prepend(node) { node.detach(); node.parent = this; this.children.unshift(node); }
  replaceWith(node) { const parent = this.parent, index = parent.children.indexOf(this); node.detach(); parent.children[index] = node; node.parent = parent; this.parent = null; }
  replaceChildren() { for(const child of this.children) child.parent = null; this.children = []; }
  get isConnected() { let node = this; while(node.parent) node = node.parent; return node.isRoot === true; }
  setAttribute(key, value) { this.attrs[key] = String(value); } removeAttribute(key) { delete this.attrs[key]; }
  querySelector() { return null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); } removeEventListener() {}
  fire(type, extra = {}) { const event = {type, defaultPrevented:false, preventDefault() { this.defaultPrevented = true; }, ...extra}; for(const fn of this.listeners[type] || []) fn(event); return event; }
  click() { return this.fire("click"); } focus() { this.focused = true; } getBoundingClientRect() { return {width:800, height:450}; }
}
const makeDocument = () => {
  const doc = new El("#document"); doc.events = [];
  doc.documentElement = new El("html"); doc.documentElement.isRoot = true; doc.head = new El("head"); doc.body = new El("body"); doc.documentElement.append(doc.head, doc.body);
  doc.createElement = tag => new El(tag); doc.createComment = () => new El("#comment");
  doc.removeEventListener = function(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(x => x !== fn); };
  doc.dispatchEvent = function(event) { this.events.push(event); for(const fn of this.listeners[event.type] || []) fn(event); };
  return doc;
};
const makeWindow = () => { const win = new El("#window"); win.document = makeDocument(); win.closed = false; win.close = function() { this.closed = true; }; win.focus = function() { this.focused = true; }; return win; };
const setup = ({pip = true, popup} = {}) => {
  const doc = makeDocument(), ids = {}, add = (id, tag, parent) => { const el = new El(tag); el.id = id; ids[id] = el; parent.append(el); return el; };
  const stage = add("stage", "main", doc.body), viewport = add("renderViewport", "div", stage);
  const canvas = add("screen", "canvas", viewport), notice = add("previewPopoutNotice", "div", viewport); notice.hidden = true;
  const header = add("stageHeader", "header", viewport), button = add("previewPopout", "button", header), back = add("previewPopoutReturn", "button", notice), status = add("previewNotice", "p", viewport);
  doc.getElementById = id => ids[id] || null;
  doc.styleSheets = [{cssRules:[{cssText:"body { margin: 0; }"}, {cssText:"#screen { width: 100%; }"}]}, {href:"https://fonts.example/a.css", get cssRules() { throw new Error("SecurityError"); }}];
  doc.documentElement.dataset.theme = "dark";
  const win = makeWindow(), view = new El("#main-window"), calls = {toggle:0};
  view.shaderStudio = {togglePlayback() { calls.toggle++; }};
  if(pip) view.documentPictureInPicture = {requestWindow:async options => { calls.options = options; if(pip instanceof Error) throw pip; return win; }};
  view.open = (url, name, features) => { calls.open = {url, name, features}; return popup === undefined ? win : popup; };
  doc.defaultView = view;
  // 안내 문구 자동 숨김 타이머는 검사에 필요 없으므로 가짜로 넘긴다(프로세스가 6초 기다리지 않게).
  const api = factory(doc, class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, () => 0, () => {}).mount({doc});
  return {doc, view, win, canvas, viewport, notice, button, back, status, header, api, calls};
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const check = (ok, name) => { assert(ok, name); console.log("PASS", name); };

(async () => {
  {
    const t = setup(); t.button.click(); await flush();
    check(t.canvas.parent === t.win.document.body, "PiP: 캔버스 요소 자체가 분리 창 본문으로 옮겨진다");
    check(t.header.parent === t.win.document.body && t.viewport.children[2].tagName === "#comment", "상단 도구 원본도 분리 창으로 옮기고 원래 위치에 표식을 남긴다");
    check(t.calls.options.width === 400 && t.calls.options.height === 225, "PiP: 창 크기는 현재 미리보기의 절반 · 같은 비율");
    check(t.viewport.children[0].tagName === "#comment" && t.viewport.children[0].isConnected, "원래 자리에 표식을 남긴다");
    check(t.doc.body.classes.has("preview-popped") && !t.notice.hidden && t.button.attrs["aria-pressed"] === "true", "메인 화면: 분리 상태 표시 · 안내 · 버튼 눌림");
    check(/되돌리기/.test(t.button.attrs["aria-label"]), "버튼 이름이 되돌리기로 바뀐다");
    check(t.doc.events.some(e => e.type === "preview-popout-changed" && e.detail.open === true), "studio에 분리 사실을 알린다(집중 모드 재생 붙잡기 해제용)");
    const head = t.win.document.head.children;
    check(head.some(n => n.tagName === "style" && n.textContent.includes("#screen")) && head.some(n => n.tagName === "link" && n.href === "https://fonts.example/a.css"), "스타일 복사: 읽을 수 있는 규칙은 복사, 외부 시트는 링크");
    check(t.win.document.documentElement.dataset.theme === "dark" && t.win.document.body.className === "preview-popout-window", "분리 창도 같은 테마와 전용 본문 클래스");
    t.doc.documentElement.dataset.theme = "light"; t.doc.dispatchEvent({type:"theme-changed"});
    check(t.win.document.documentElement.dataset.theme === "light", "테마를 바꾸면 분리 창도 따라 바뀐다");
    const space = t.win.document.fire("keydown", {code:"Space", key:" "});
    check(t.calls.toggle === 1 && space.defaultPrevented, "분리 창에서 Space는 재생/정지");
    t.win.document.fire("keydown", {code:"Escape", key:"Escape"});
    check(t.canvas.parent === t.viewport && t.viewport.children[0] === t.canvas, "Esc: 캔버스가 원래 순서(맨 앞) 그대로 돌아온다");
    check(t.header.parent === t.viewport && t.viewport.children[2] === t.header, "상단 도구도 원래 위치와 순서로 돌아온다");
    check(t.win.closed && !t.doc.body.classes.has("preview-popped") && t.notice.hidden && t.button.attrs["aria-pressed"] === "false", "되돌리면 창을 닫고 메인 표시를 원래대로");
    check(t.doc.events.at(-1).detail.open === false, "되돌린 사실도 알린다");
  }
  {
    const t = setup(); await t.api.open(); t.back.click();
    check(t.canvas.parent === t.viewport && t.win.closed, "안내의 '여기로 되돌리기' 버튼");
  }
  {
    const t = setup(); await t.api.open(); t.win.closed = true; t.win.fire("pagehide");
    check(t.canvas.parent === t.viewport && !t.api.isOpen, "사용자가 분리 창을 닫으면(pagehide) 캔버스를 되돌린다");
    check(t.header.parent === t.viewport, "창을 직접 닫아도 상단 도구 원본이 복원된다");
    await t.api.open(); t.view.fire("pagehide");
    check(t.canvas.parent === t.viewport, "메인 페이지를 떠날 때도 되돌린다");
  }
  {
    const t = setup({pip:false}); t.button.click(); await flush();
    check(t.calls.open.name === "field-preview" && /popup/.test(t.calls.open.features) && t.canvas.parent === t.win.document.body, "PiP가 없으면 일반 팝업으로 연다");
  }
  {
    const broken = Object.assign(new Error("Internal error: no window"), {name:"InvalidStateError"});
    const t = setup({pip:broken}); t.button.click(); await flush();
    check(t.calls.options && t.calls.open?.name === "field-preview" && t.canvas.parent === t.win.document.body, "PiP 창을 못 만드는 환경이면 일반 팝업으로 대신한다");
  }
  {
    const denied = Object.assign(new Error("requires user activation"), {name:"NotAllowedError"});
    const t = setup({pip:denied}); t.button.click(); await flush();
    check(!t.calls.open && t.canvas.parent === t.viewport && /실패/.test(t.status.textContent), "클릭 없이 열려고 하면(NotAllowedError) 팝업을 띄우지 않고 알린다");
  }
  {
    const t = setup({pip:false, popup:null}); t.button.click(); await flush();
    check(t.canvas.parent === t.viewport && !t.api.isOpen && !t.status.hidden && /팝업/.test(t.status.textContent), "팝업이 막히면 캔버스는 그대로 두고 이유를 알린다");
  }
  {
    const t = setup(); const first = await t.api.open(), second = await t.api.open();
    check(first === second && t.win.focused, "이미 열려 있으면 새 창 대신 기존 창에 초점");
  }
  console.log("미리보기 분리 검사 통과");
})().catch(error => { console.error("FAIL", error.stack); process.exitCode = 1; });
