'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'style.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,''),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function split(text,char){const result=[];let start=0,depth=0,quote='';for(let i=0;i<text.length;i++){const c=text[i];if(quote){if(c==='\\')i++;else if(c===quote)quote='';continue;}if(c==='"'||c==="'")quote=c;else if(c==='('||c==='[')depth++;else if(c===')'||c===']')depth--;else if(!depth&&c===char){result.push(text.slice(start,i).trim());start=i+1;}}result.push(text.slice(start).trim());return result.filter(Boolean);}
const selectors=new Set(),rules=new Map();let count=0;
function parse(text,context='base'){let at=0;while(at<text.length){while(/\s/.test(text[at]||'')&&at<text.length)at++;if(at>=text.length)break;const open=text.indexOf('{',at);assert(open>=0,'Missing rule body');const head=text.slice(at,open).trim();let end=open+1,depth=1,quote='';for(;end<text.length&&depth;end++){const c=text[end];if(quote){if(c==='\\')end++;else if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='{')depth++;else if(c==='}')depth--;}
 assert.equal(depth,0,'Unclosed '+head);const body=text.slice(open+1,end-1);if(head.startsWith('@'))parse(body,context+'/'+head);else{
 const declarations=new Map();for(const declaration of split(body,';')){const colon=declaration.indexOf(':');assert(colon>0,'Malformed declaration '+declaration);const prop=declaration.slice(0,colon).trim();assert(!declarations.has(prop),'Repeated property '+prop+' in '+head);declarations.set(prop,declaration.slice(colon+1).trim());}
 for(const selector of split(head,',')){const key=context+'|'+selector;const merged=new Map(rules.get(key)||[]);for(const [prop,value] of declarations){assert(!merged.has(prop),'Repeated selector/property '+key+' / '+prop);merged.set(prop,value);}selectors.add(key);rules.set(key,merged);count++;}}
 at=end;}}
parse(css);
const base=s=>{const r=rules.get('base|'+s);assert(r,'Missing '+s);return r;};
assert.equal(base('button').get('align-items'),'center');assert.equal(base('button').get('justify-content'),'center');assert.equal(base('button').get('margin'),'0');
assert.equal(base('input[type="checkbox"]').get('margin'),'0');
assert.equal(base('.fps-control').get('display'),'grid');assert.equal(base('.input-unit').get('place-items'),'center');assert(!base('.input-unit').has('top'),'FPS unit must not have a fixed vertical offset');
assert(!base('.uniform-search-wrap kbd').has('position'),'Shortcut badge must not overlap native search clear control');
assert.equal(base('.studio-dialog-actions').get('grid-template-columns'),'repeat(2,minmax(0,1fr))');
assert.equal(base('.studio-dialog-head h2').get('min-height'),'36px');assert.equal(base('#studioDialogClose').get('height'),'36px');
assert.equal(base('.uniform-type').has('margin-left'),false,'Wrapped labels must use their parent gap');
assert.equal(base('.viewport-footer').get('align-items'),'center');assert(!base('.viewport-info').has('position'));assert(!base('.stage-stats').has('position'));
assert.equal(base('.studio-top').get('grid-template-columns'),'minmax(0,1fr) auto');assert(html.includes('class="studio-window-tools"'));assert(html.includes('class="viewport-footer"'));
assert.equal(base('#studioCode').get('scrollbar-gutter'),'stable');assert.equal(base('#studioHighlight').get('scrollbar-gutter'),'stable');
assert.equal(base('#studioHighlight').get('padding'),'12px');assert.equal(base('.studio-gutter').get('padding').split(' ')[0],'12px');
assert.equal(base('.studio-group-body').get('padding'),'12px 14px 16px');assert.equal(base('.studio-group-body').get('gap'),'12px');
assert([...rules.keys()].some(key=>key.includes('@container preview (max-height:220px)')),'HUD must adapt to actual preview height');
console.log(`PASS CSS ${count} selector scopes parsed: no repeated selector/property pair in the same scope`);
console.log('PASS Centered controls / unit placement / modal grid / toolbar groups / shared HUD / code layer gutters');
console.log('Static CSS contracts, not a rendered pixel measurement.');

for(const m of html.matchAll(/<button\b([^>]*)class="[^"]*glyph-icon[^"]*"([^>]*)>([\s\S]*?)<\/button>/g)){
 assert(/aria-label="[^" ]/.test(m[1]+m[2]),'Icon-only buttons need an accessible name');assert.equal(m[3].trim(),'','Icon-only controls must not depend on font glyph metrics');
}
for(const selector of ['.glyph-icon::before','.studio-group>summary::after','.studio-code-tools>summary::after']){
 assert.equal(base(selector).get('width'),'16px');assert.equal(base(selector).get('height'),'16px');assert.equal(base(selector).get('content'),'""');assert.equal(base(selector).get('mask'),'var(--icon) center/contain no-repeat');
}
assert.equal(base('.studio-find-row button.glyph-icon').get('padding'),'0');assert.equal(base('.studio-texture .icon-close').get('width'),'28px');
assert(base('#previewPause[aria-pressed="true"]').has('--icon'));assert(base('#studioMaximize[aria-pressed="true"]').has('--icon'));
console.log('PASS Font-independent icon boxes / accessible icon buttons / state icons / square delete and navigation controls');

assert.equal(base('.studio-channel-help').get('grid-column'),'1/-1');assert.equal(base('.studio-channel-help').get('margin'),'0');
assert.equal(base('.studio-graph-input').get('grid-template-columns'),'54px minmax(0,1fr)');
assert.equal(base('.studio-texture').get('grid-template-columns'),'minmax(0,1fr) 28px');assert.equal(base('.studio-texture .texture-connect').get('grid-column'),'1/-1');
console.log('PASS Channel help alignment / source and frame columns / full-width image connection action');
