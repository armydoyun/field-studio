// node tests/editor-structure-regression.js — 편집기 구조 계약(정적 검사): CodeMirror 단일 편집기, 예전 textarea 편집기 잔재 없음, 주요 기능 연결.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const html=read('index.html'),css=read('style.css'),studio=read('js/studio.js'),editor=read('js/cm-editor.js'),features=read('js/cm-glsl-features.js'),vendor=read('js/codemirror.js');
let passed=0;const check=(ok,label)=>{assert(ok,label);passed++;console.log('PASS',label);};
check(!fs.existsSync(path.join(root,'js/code-editor.js')),'예전 textarea 편집기(code-editor.js) 제거');
check(/import \* as Editor from "\.\/cm-editor\.js";/.test(studio)&&!/code-editor|editorEngine|studioEngine/.test(studio),'studio는 CodeMirror 편집기만 붙인다');
for(const id of ['studioHighlight','studioLines','studioCompletion','studioSignature','studioFindPanel','studioFindQuery','studioEngine'])check(!html.includes(`id="${id}"`),`예전 편집기 요소 없음: #${id}`);
check(/<textarea id="studioCode" class="studio-code-model" hidden/.test(html),'#studioCode는 숨은 소스 창구(textarea)');
check(/class="studio-editor-frame"/.test(html)&&/frame\?\.append\(host\)/.test(editor),'CodeMirror 화면은 편집 프레임 안에 만든다');
check(/^export \{ load \};\s*$/m.test(vendor)&&/CodeMirror\.load\(\)/.test(editor),'vendor CodeMirror는 load() 때 초기화');
for(const [name,re] of [['코드 접기',/CM\.foldGutter\(\)/],['여러 커서',/allowMultipleSelections\.of\(true\)/],['사각 선택',/CM\.rectangularSelection\(\{eventFilter:event => event\.altKey && event\.shiftKey\}\)/],['검색',/CM\.search\(/],
  ['자동 완성',/CM\.autocompletion\(/],['오류 표시',/CM\.lintGutter\(\)/],['마우스 설명',/CM\.hoverTooltip\(/],['한국어 문구',/CM\.EditorState\.phrases\.of\(PHRASES\)/],['GLSL 도우미',/\.\.\.features\.extensions/]])
  check(re.test(editor),`편집기 기능 연결: ${name}`);
for(const [name,re] of [['시그니처 도움말',/CM\.showTooltip\.from/],['색 견본 위젯',/class ColorSwatch extends CM\.WidgetType/],['들여쓰기 안내선',/cm-indent-guides/],['줄 끝 오류',/class LensWidget/],
  ['정의로 이동',/key:"F12"/],['이름 바꾸기',/key:"F2"/],['숫자 조절',/key:"Mod-ArrowUp"/]])
  check(re.test(features),`GLSL 도우미: ${name}`);
for(const id of ['studioFunctions','studioFind','studioGoto','studioComplete','studioPaletteOpen','studioFoldAll','studioUnfoldAll','studioLintPanel','studioRename','studioDefinition','studioZoomIn','studioLineWrap','studioIndent'])
  check(html.includes(`id="${id}"`)&&editor.includes(`$("${id}")`),`도구 버튼 연결: #${id}`);
check(/\.cm-glsl-swatch/.test(css)&&/\.cm-error-lens/.test(css)&&/\.cm-indent-guides/.test(css)&&/\.studio-cm-host/.test(css),'CodeMirror 화면 스타일');
check(!/#studioHighlight|\.studio-gutter|\.studio-completion|\.studio-find-panel|\.deco-/.test(css),'예전 편집기 스타일 제거');
// VS Code 기본 단축키와 같은 키(편집기 안). 연속 입력(chord)은 "Mod-k Mod-0"처럼 띄어 쓴다.
for(const [name,key] of [['패스로 이동(Ctrl+P)','Mod-p'],['모두 접기(Ctrl+K Ctrl+0)','Mod-k Mod-0'],['모두 펴기(Ctrl+K Ctrl+J)','Mod-k Mod-j'],['줄 주석 추가(Ctrl+K Ctrl+C)','Mod-k Mod-c'],
  ['줄 주석 제거(Ctrl+K Ctrl+U)','Mod-k Mod-u'],['이전 오류(Shift+F8)','Shift-F8'],['아래 패널(Ctrl+J)','Mod-j'],['아래에 줄 삽입(Ctrl+Enter)','Mod-Enter'],['위에 줄 삽입(Ctrl+Shift+Enter)','Mod-Shift-Enter'],
  ['선택 확장(Shift+Alt+→)','Shift-Alt-ArrowRight'],['선택 축소(Shift+Alt+←)','Shift-Alt-ArrowLeft'],['모든 일치 선택(Ctrl+F2)','Mod-F2'],['자동 완성(Ctrl+I)','Mod-i'],['글자 크게(Ctrl+=)','Mod-='],['글자 작게(Ctrl+-)','Mod--']])
  check(editor.includes(`key:"${key}"`),`VS Code 단축키: ${name}`);
check(/both\("Mod-Shift-p"/.test(editor)&&/both\("Mod-Shift-l", selectAllOccurrences\)/.test(editor)&&/both\("Shift-Alt-i"/.test(editor),'VS Code 단축키: 명령 팔레트 · 모든 일치 선택 · 줄 끝 커서');
check(/"Mod-b"/.test(studio)&&/"Mod-\\\\"/.test(studio)&&/"Mod-k z"/.test(studio),'VS Code 단축키: 사이드바(Ctrl+B) · 배치(Ctrl+\\) · Zen(Ctrl+K Z)');
check(!/key==="Enter"/.test(studio),'Ctrl+Enter · Ctrl+Shift+Enter는 실행이 아니라 아래/위에 줄 삽입(실행은 Ctrl+S)');
console.log(`Editor structure: ${passed} checks passed`);
