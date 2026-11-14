// node tests/runtime-integrity.js — ESM graph, SHA-256 manifest, offline build invariants.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),jsdir=path.join(root,'js');
const {cssOnDisk,cssFiles}=require('../tools/css-files.cjs');
assert.deepEqual([...cssFiles()].sort(),cssOnDisk(),'css/ 아래 모든 파일은 index.html에 링크되어 있어야 한다');
const files=['index.html',...cssOnDisk(),...fs.readdirSync(jsdir).filter(x=>x.endsWith('.js')).map(x=>'js/'+x)].sort();
// 배포본은 esbuild가 main.js의 import를 따라 묶으므로(tools/build.mjs) 모듈 목록을 따로 관리하지 않는다. 배포본 검사는 tests/build-regression.js.
assert(!fs.existsSync(path.join(jsdir,'loader.js')),'AMD loader must be absent');
const manifest=fs.readFileSync(path.join(root,'SOURCE_SHA256_Runtime.txt'),'utf8').trim().split(/\r?\n/);
const hashes=new Map();for(const line of manifest){const m=/^([a-f0-9]{64}) {2}(.+)$/.exec(line);assert(m,'SHA256 format');assert(!hashes.has(m[2]),'duplicate manifest entry');hashes.set(m[2],m[1]);}
assert.deepEqual([...hashes.keys()].sort(),files,'Runtime SHA manifest mismatch');
// 줄바꿈은 LF로 맞춰 해시한다. Windows 체크아웃(core.autocrlf)은 CRLF로 풀리므로 원본 바이트로 비교하면 내용이 같아도 실패한다. tools/update_sha_manifest.py와 같은 규칙.
const normalizedSha=file=>crypto.createHash('sha256').update(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n'),'utf8').digest('hex');
for(const name of files)assert.equal(normalizedSha(path.join(root,name)),hashes.get(name),`${name} (python tools/update_sha_manifest.py로 갱신)`);
const names=new Set(files.filter(x=>x.startsWith('js/')).map(x=>path.basename(x,'.js'))),graph=new Map();
for(const name of names){const source=fs.readFileSync(path.join(jsdir,name+'.js'),'utf8');
  // AMD define() 호출만 찾는다(Facet.define( 같은 메서드 호출은 제외). codemirror.js는 tools/codemirror/build.mjs가 만든 서드파티 번들이다(`static define(` 메서드가 있다).
  assert((name==='codemirror'||!/(?<![.\w$])define\s*\(/.test(source))&&!/\brequire\.config\s*\(/.test(source),`${name}: AMD runtime remaining`);
  const deps=[...source.matchAll(/^import (?:\* as \w+|\w+) from "\.\/([\w-]+)\.js";/gm)].map(x=>x[1]);
  assert(!/^import\s(?!\*\s+as\s+\w+\s+from|\w+\s+from)/m.test(source),`${name}: unresolved import syntax`);
  assert(deps.every(x=>names.has(x)),`${name}: missing ESM dependency`);
  if(name!=='main')assert(/\bexport (?:\{|default)/.test(source),`${name}: export missing`);
  graph.set(name,deps);
}
const done=new Set(),stack=new Set();function visit(name){assert(!stack.has(name),`ESM circular dependency: ${name}`);if(done.has(name))return;stack.add(name);for(const x of graph.get(name))visit(x);stack.delete(name);done.add(name);}for(const name of names)visit(name);
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
assert(html.includes('<script type="module" src="./js/main.js"></script>'),'ESM HTML entry missing');
assert(!html.includes('loader.js'),'Legacy loader reference');
const ids=new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map(x=>x[1]));
// html-export.js의 재생기는 앱이 아니라 내보낸 HTML에서 돈다: 그 파일이 만드는 요소(field · note)는 index.html에 없다.
const OWN_DOCUMENT={'html-export':new Set(['field','note'])};
for(const name of names){const source=fs.readFileSync(path.join(jsdir,name+'.js'),'utf8');for(const m of source.matchAll(/\$\("([A-Za-z][\w-]*)"\)|document\.getElementById\("([A-Za-z][\w-]*)"\)/g)) assert(ids.has(m[1]||m[2])||OWN_DOCUMENT[name]?.has(m[1]||m[2]),`#${m[1]||m[2]} absent in ${name}`);}
console.log(`PASS ${files.length} runtime files SHA-256, ${names.size} ES Modules, import cycle, ${ids.size} DOM IDs`);
