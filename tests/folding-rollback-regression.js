// 코드 접기 롤백: 편집기 원상복귀 및 기존 자동 완성 UI 보존.
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const [js,html,css]=['js/code-editor.js','index.html','style.css'].map(read);
for(const [name,src] of [['code-editor.js',js],['index.html',html],['style.css',css]]) {
  assert(!/studioFold|folding-view|fold-gutter|Fold all|Unfold|\bFold\b/.test(src),`${name}: Folding UI 잔존`);
}
assert(/<textarea\s+id="studioCode"/.test(html),'원본 textarea 없음');
assert(/id="studioHighlight"/.test(html)&&/highlight\.replaceChildren/.test(js),'GLSL 하이라이트 없음');
assert(/id="studioComplete"/.test(html)&&/id="studioCompletion"/.test(html),'자동 완성 UI 손실');
assert(/id="studioFunctions"/.test(html),'함수 탐색기 손실');
assert(!fs.existsSync(path.join(root,'tests/folding-browser-regression.py')),'기존 Folding 테스트가 남아 있음');
console.log('PASS Folding 롤백: 전용 UI 제거 및 textarea/강조/자동 완성/함수 탐색 유지');
