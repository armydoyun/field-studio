// node tests/runtime-integrity.js — ESM graph, SHA-256 manifest, offline build invariants.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),jsdir=path.join(root,'js');
const files=['index.html','style.css',...fs.readdirSync(jsdir).filter(x=>x.endsWith('.js')).map(x=>'js/'+x)].sort();
// 모듈 수는 늘어날 수 있으므로 고정하지 않는다. 대신 배포 번들러(tools/build_deploy.py)의 MODULES 목록과 js/ 모듈이 정확히 일치해야 한다(누락된 모듈이 번들에서 빠지지 않도록).
const bundled=/^MODULES = \[([^\]]*)\]/m.exec(fs.readFileSync(path.join(root,'tools/build_deploy.py'),'utf8'));assert(bundled,'build_deploy.py MODULES missing');
assert.deepEqual([...bundled[1].matchAll(/'([\w-]+)'/g)].map(x=>x[1]).sort(),files.filter(x=>x.startsWith('js/')).map(x=>path.basename(x,'.js')).sort(),'build_deploy.py MODULES must list every js/*.js module');
assert(!fs.existsSync(path.join(jsdir,'loader.js')),'AMD loader must be absent');
const manifest=fs.readFileSync(path.join(root,'SOURCE_SHA256_Runtime.txt'),'utf8').trim().split(/\r?\n/);
const hashes=new Map();for(const line of manifest){const m=/^([a-f0-9]{64})  (.+)$/.exec(line);assert(m,'SHA256 format');assert(!hashes.has(m[2]),'duplicate manifest entry');hashes.set(m[2],m[1]);}
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
const ids=new Set([...html.matchAll(/\bid\s*=\s*"([^\"]+)"/g)].map(x=>x[1]));
for(const name of names){const source=fs.readFileSync(path.join(jsdir,name+'.js'),'utf8');for(const m of source.matchAll(/\$\("([A-Za-z][\w-]*)"\)|document\.getElementById\("([A-Za-z][\w-]*)"\)/g)) assert(ids.has(m[1]||m[2]),`#${m[1]||m[2]} absent in ${name}`);}
const deploy=path.join(root,'deploy');
assert(fs.existsSync(path.join(deploy,'js/min.js')),'Offline bundle missing');
assert(fs.readFileSync(path.join(deploy,'index.html'),'utf8').includes('<script src="./js/min.js"></script>'),'offline entry missing');
// AMD define()/require() 호출만 찾는다. 번들에 든 CodeMirror의 `Facet.define(` 호출과 `static define(` 메서드 정의는 제외한다.
assert(!/(?<![.\w$])(?<!static\s)(?:define|require)\s*\(/.test(fs.readFileSync(path.join(deploy,'js/min.js'),'utf8')),'bundle contains loader');
console.log(`PASS ${files.length} runtime files SHA-256, ${names.size} ES Modules, import cycle, ${ids.size} DOM IDs and offline bundle`);
