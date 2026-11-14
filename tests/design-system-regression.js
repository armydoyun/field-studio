// node tests/design-system-regression.js — 디자인 시스템 계약(정적 검사). 규칙은 docs/DESIGN_SYSTEM.md.
//  · 쓰는 토큰(var(--x))은 모두 정의되어 있다
//  · 마크업 · JS가 쓰는 ui-* 클래스는 모두 css/components/에 정의되어 있다(오타 · 없는 변형 방지)
//  · 컴포넌트 클래스(ui-*)는 css/components/에서만 정의한다 — 기능 CSS는 그것을 다시 칠하지 않는다
//  · 기능 · 배치 CSS는 색 값을 직접 쓰지 않는다(그림인 곳만 예외)
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {cssFiles}=require('../tools/css-files.cjs');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const bare=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/url\("[^"]*"\)/g,'url()');
const files=cssFiles(),sheets=new Map(files.map(file=>[file,bare(read(file))]));
const all=[...sheets.values()].join('\n');
const html=read('index.html'),jsFiles=fs.readdirSync(path.join(root,'js')).filter(name=>name.endsWith('.js')&&name!=='codemirror.js');
const js=jsFiles.map(name=>read('js/'+name)).join('\n');

// 1) 토큰: 쓰는 것은 정의되어 있다. JS · 인라인 style이 넣는 값은 기본값(var(--x,기본))을 달거나 아래 목록에 있다.
const defined=new Set([...all.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)].map(m=>m[1]));
const RUNTIME=new Set(['--icon','--timeline-head','--share','--swatch','--guide-levels']);  // JS가 요소마다 넣는 값 · 아이콘 클래스가 넣는 값
const missing=new Set();
for(const m of all.matchAll(/var\((--[\w-]+)(\s*,)?/g))if(!defined.has(m[1])&&!m[2]&&!RUNTIME.has(m[1]))missing.add(m[1]);
assert.deepEqual([...missing],[],'정의되지 않은 토큰');
console.log(`PASS 토큰 ${defined.size}개: 쓰는 토큰은 모두 정의됨`);

// 2) ui-* 클래스: 쓰는 것은 컴포넌트에 있다
const componentCss=files.filter(file=>file.startsWith('css/components/')).map(file=>sheets.get(file)).join('\n');
const known=new Set([...componentCss.matchAll(/\.(ui-[\w-]+)/g)].map(m=>m[1]));
const used=new Set();
for(const m of html.matchAll(/class="([^"]*)"/g))for(const name of m[1].split(/\s+/))if(name.startsWith('ui-'))used.add(name);
// JS: 따옴표 안의 글자에서 ui-이름을 찾는다. `ui-btn--${variant}`처럼 조립하는 접두사(끝이 -)는 뺀다.
for(const m of js.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g))for(const n of m[2].matchAll(/(?<![\w-])ui-[a-z0-9]+(?:-{1,2}[a-z0-9]+)*(?![\w-]|\$)/g))if(!/^ui-kit$/.test(n[0]))used.add(n[0]);
const unknown=[...used].filter(name=>!known.has(name)).sort();
assert.deepEqual(unknown,[],'css/components/에 없는 ui-* 클래스를 쓰고 있다');
console.log(`PASS ui-* 클래스 ${used.size}개 사용: 모두 컴포넌트에 정의됨(정의 ${known.size}개)`);

// 3) 컴포넌트는 한곳에서만: 기능 · 배치 CSS의 선택자는 ui-* 클래스로 "끝나지" 않는다(다시 칠하지 않는다).
//    자리 예외는 허용한다: 부모 맥락 안에서의 배치(.guide-progress-bar>.ui-meter-fill 같은 조합)는 아래 목록에 적는다.
const PLACEMENT=new Set([
  '.storage-indicator:has(.unavailable) .ui-dot','.ui-section>button+.ui-hint','.uniform-section .ui-section-head','.uniform-top .ui-icon-btn',
  '.uniform-top .ui-icon-btn[aria-pressed="true"]','.uniform-ramp-edit .ui-chip:disabled','#uniformForm .ui-field','#uniformForm .ui-hint','.builtin-reference .ui-link',
  '#stageToolbar .ui-icon-btn','#stageToolbar .ui-icon-btn:is([aria-pressed="true"],[aria-expanded="true"])','.studio-project-list>.ui-hint','.studio-textures>.ui-hint',
  '.studio-pass-actions .ui-link','.preset-chip>.preset-menu>.ui-menu-item','.preset-menu>.ui-menu-item::after','.profile-buffers>.ui-hint',
  '.gallery-head .ui-dialog-eyebrow','.guide-progress-bar>.ui-meter-fill','.ui-section-head',
]);
const repaint=[];
for(const [file,css] of sheets){
  if(file.startsWith('css/components/'))continue;
  for(const m of css.matchAll(/([^{}@]+)\{/g))for(const selector of m[1].split(/,(?![^(]*\))/).map(s=>s.trim()).filter(Boolean)){
    const last=selector.split(/[\s>+~]+/).pop();
    if(/^\.ui-[\w-]+/.test(last)&&!PLACEMENT.has(selector))repaint.push(`${file}: ${selector}`);
  }
}
assert.deepEqual(repaint,[],'기능 CSS가 컴포넌트(ui-*)를 다시 정의한다 — 변형은 css/components/에 추가한다');
console.log('PASS 컴포넌트 클래스는 css/components/에서만 정의');

// 4) 색 값: 토큰 파일과 그림(갤러리 썸네일 · 성능 배지 · 버퍼 채널 색 · 영상 여백 · 채운 위험 버튼의 흰 글자) 밖에서는 #색을 쓰지 않는다
const COLOR_OK=/^\.gallery-thumb|^\.gallery-perf|^\.profile-segment \[data-channel|#videoRenderDialog|^\.ui-btn--danger-solid|^\.ui-dialog\[data-danger|^\.guide-nav$|^:root$/;
const raw=[];
for(const [file,css] of sheets){
  if(file==='css/tokens.css')continue;
  for(const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)){
    const colors=m[2].replace(/color-mix\([^;]*\)/g,x=>x).match(/#[0-9a-fA-F]{3,8}\b/g);
    if(colors&&!COLOR_OK.test(m[1].trim())&&!colors.every(c=>/^#(000|fff)$/i.test(c)))raw.push(`${file}: ${m[1].trim()} ${colors.join(' ')}`);
  }
}
assert.deepEqual(raw,[],'토큰 대신 색 값을 직접 썼다');
console.log('PASS 색은 토큰으로만(그림 예외 제외)');

// 5) 문서: 컴포넌트 파일은 모두 docs/DESIGN_SYSTEM.md와 카탈로그에 나온다
const doc=read('docs/DESIGN_SYSTEM.md'),catalog=read('docs/design-system.html');
for(const file of files.filter(f=>f.startsWith('css/components/'))){
  const name=path.basename(file);
  assert(doc.includes(name),`docs/DESIGN_SYSTEM.md에 ${name} 없음`);
  assert(catalog.includes(`../${file}`),`docs/design-system.html이 ${file}을 링크하지 않음`);
}
console.log('PASS 문서와 카탈로그가 모든 컴포넌트 파일을 다룬다');
