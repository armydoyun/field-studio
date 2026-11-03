'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),css=fs.readFileSync(path.join(root,'style.css'),'utf8');
const stack=[],ids=new Map(),voids=new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
for(const m of html.replace(/<!--[\s\S]*?-->/g,'').matchAll(/<(\/?)([A-Za-z][\w-]*)\b([^>]*)>/g)){
 const [,close,name,attrs]=m;if(close){assert.equal(stack.pop(),name,'HTML tag nesting: '+name);continue;}
 const id=/\bid="([^"]+)"/.exec(attrs)?.[1];if(id){assert(!ids.has(id),'Duplicate #'+id);ids.set(id,[...stack]);}
 if(!voids.has(name)&&!/\/\s*$/.test(attrs))stack.push(name);
}
assert.equal(stack.length,0,'Unclosed HTML tags');
for(const id of ['studioChannels','studioExportPack','studioImportPack','studioExamplePipeline','studioExampleFeedback','studioTextureList','studioPixelReadout'])assert(ids.get(id)?.includes('details'),'Disclosed control missing: '+id);
// 찾아 바꾸기는 ⋯ 메뉴(편집)로 옮겨졌다. 툴바의 검색 버튼·Ctrl+H·명령 팔레트로 계속 열 수 있다.
for(const id of ['studioFind','studioGoto','studioFunctions','studioComplete'])assert(!ids.get(id)?.includes('details'),'Primary navigation hidden: '+id);
for(const id of ['studioReplace','studioOpenGLSL','studioSaveGLSL','studioSampleUV','studioIndent','studioZoomIn'])assert(ids.get(id)?.includes('details'),'Secondary tool missing: '+id);
assert(!html.includes('viewport-vignette'),'Artwork must not have a decorative overlay');
assert(!css.includes('.studio-code-label span:last-child'),'Legacy rule could hide state badge or override its color');
assert(!/\.studio-dock\s*\{\s*flex-basis:\d+%/.test(css),'Fixed responsive height overrides user resize');
assert(css.includes('studio-patchbay[hidden]')&&css.includes('grid-template-rows:minmax(0,1fr)'),'Hidden tools must not reserve a grid track');
assert(css.includes('pointer-events:auto')&&html.includes('id="uiDismiss"'),'Error dismissal must be reachable');
assert(css.includes('12px/1.65')&&!css.includes('12px/1.58'),'Gutter and code must use the same line height');
assert(/\.studio-group-body\s*\{[^}]*display:grid;[^}]*gap:12px;[^}]*padding:12px 14px 16px;/.test(css),'Every disclosed body must start with 12px top spacing');
assert(css.includes('.studio-group-body>* { min-width:0;margin:0; }'),'Body children must not add conflicting default margins');
assert(!/\.studio-group-body[^{}]*button\s*\{[^}]*margin-(?:top|bottom):[1-9]/.test(css),'Buttons must use the container gap without double margins');
let braces=0,quote='',comment=false;
for(let i=0;i<css.length;i++){const c=css[i],next=css[i+1];if(comment){if(c==='*'&&next==='/'){comment=false;i++;}continue;}if(quote){if(c==='\\')i++;else if(c===quote)quote='';continue;}if(c==='/'&&next==='*'){comment=true;i++;}else if(c==='"'||c==="'")quote=c;else if(c==='{')braces++;else if(c==='}'){assert(braces>0,'CSS unmatched }');braces--;}}
assert.equal(braces,0);assert.equal(quote,'');assert.equal(comment,false);
console.log(`PASS HTML nesting / ${ids.size} unique IDs / disclosure ownership / responsive-height contract / CSS balance`);
console.log('Layout contracts only: this test does not render a browser screenshot.');
