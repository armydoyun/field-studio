// The project's owned UI and copy must never use emoji or text faces as icons.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const walk=folder=>fs.readdirSync(path.join(root,folder),{withFileTypes:true}).flatMap(entry=>
  entry.isDirectory()?walk(`${folder}/${entry.name}`):[`${folder}/${entry.name}`]);
const files=['AGENTS.md','README.md','index.html',...walk('docs').filter(f=>/\.(?:md|html|svg)$/.test(f)),
  ...walk('js').filter(f=>f.endsWith('.js')&&f!=='js/codemirror.js'),...walk('css').filter(f=>f.endsWith('.css'))];
const decode=text=>text
  .replace(/\\u\{([\da-f]+)\}|\\u([\da-f]{4})|\\x([\da-f]{2})/gi,(_,full,unit,byte)=>String.fromCodePoint(parseInt(full||unit||byte,16)))
  .replace(/&#(?:x([\da-f]+)|(\d+));?/gi,(_,hex,decimal)=>String.fromCodePoint(parseInt(hex||decimal,hex?16:10)));
const pictogram=/\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|\u20E3/gu;
const face=/(?:^|[\s"'`])(?::[-^]?[)(DPp]|;[-^]?[)(]|[xX]D|T[_-]T|\^[_-]?\^)(?=$|[\s"'`])/gm;
const problems=[];
for(const file of files){
  const source=decode(fs.readFileSync(path.join(root,file),'utf8'));
  for(const match of source.matchAll(pictogram))problems.push(`${file}: U+${match[0].codePointAt(0).toString(16).toUpperCase()}`);
  if(face.test(source))problems.push(`${file}: text face used as an icon`);
  face.lastIndex=0;
}
assert.deepEqual(problems,[],'Use shared SVG icons or clear text instead of emoji/emoticons');
// Guard encoded variants as well, without embedding the forbidden characters in this test.
for(const encoded of ['\\u{1f512}','\\ud83d\\udd12','&#x1f512;','&#128274;'])
  assert(pictogram.test(decode(encoded)),`Encoded pictogram was missed: ${encoded}`),pictogram.lastIndex=0;
assert(!pictogram.test('GLSL <= >= ± 45° Enter 1e-3'),'Mathematical notation and key names remain text');
assert(face.test('notice '+String.fromCharCode(58,41)+' end'),'Text faces inside comments/copy must be detected');
face.lastIndex=0;
// The generated vendor bundle includes Unicode segmentation tables and unused default icons.
// Its font-glyph renderer is disabled; the owned completion renderer uses shared SVG masks.
const editor=fs.readFileSync(path.join(root,'js/cm-editor.js'),'utf8');
assert(/icons:\s*false/.test(editor)&&editor.includes('cm-glsl-completion-icon glyph-icon icon-'), 'Completion UI must disable vendor font icons and render SVG masks');
const icons=fs.readFileSync(path.join(root,'css/icons.css'),'utf8');
for(const icon of ['lock','unlock','dice','down','previous-key','next-key','keyframe','keyframe-filled','loop','swap','keyboard','audio','mic','video','camera']){
  const rule=new RegExp(`\\.icon-${icon} \\{ --icon:url\\("data:image/svg\\+xml,([^"\\n]+)"\\); \\}`).exec(icons);
  assert(rule,`Missing shared SVG mask: ${icon}`);
  const svg=decodeURIComponent(rule[1]);
  assert(svg.startsWith('<svg ')&&svg.endsWith('</svg>')&&svg.includes("viewBox='0 0 24 24'"),`${icon}: malformed SVG icon`);
  assert(!/<text\b/i.test(svg),`${icon}: SVG must draw a shape, not a font glyph`);
}
assert(fs.readFileSync(path.join(root,'docs/DESIGN_SYSTEM.md'),'utf8').includes('절대로 사용하지 않는다'),'Design-system policy must be explicit');
console.log(`PASS ${files.length} UI/copy/style/documentation files contain no emoji/emoticons; shared SVG masks cover converted controls`);
