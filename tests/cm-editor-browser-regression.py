from esm_for_browser import load_modules
# python tests/cm-editor-browser-regression.py — CodeMirror 6 편집기 엔진(실험): textarea 창구 · studio 연동 · 주요 편집 기능 (GPU 불필요)
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text();html=html[:html.index('    <!-- ES Modules:')]+'</body></html>'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH') or None,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900});errors=[]
    page.on('pageerror',lambda err:errors.append(str(err)))
    page.set_content(html);page.add_style_tag(content=(root/'style.css').read_text())
    load_modules(page,root,['studio'])
    page.evaluate('''() => {
      const src="#version 300 es\\nprecision highp float;\\nout vec4 fragColor;\\nvoid main() {\\n    fragColor = vec4(1.0);\\n}\\n",state={image:src,passes:[],imageChannels:{}};
      const renderer={getUserUniforms:()=>[],getFragmentSource:()=>state.image,getPassDefinitions:()=>structuredClone(state.passes),getImageChannels:()=>structuredClone(state.imageChannels),
        getPasses:()=>state.passes.map(p=>({name:p.name})),getTextures:()=>[],getStats:()=>({running:false}),setPreviewPass:()=>{},
        validatePassConfiguration:()=>{},validateFragment:s=>{if(s.includes('SYNTAX'))throw new Error('Fragment Shader 컴파일 실패:\\nERROR: 0:5: test diagnostic');return true;},
        setFragment:s=>state.image=s,setPasses:(passes,channels)=>{state.passes=structuredClone(passes);state.imageChannels=structuredClone(channels);},
        setImageChannels:x=>state.imageChannels=structuredClone(x),setPassFragment:(name,s)=>state.passes.find(p=>p.name===name).fragment=s,
        setPassChannels:(name,channels)=>state.passes.find(p=>p.name===name).channels=structuredClone(channels),resetSimulation:()=>{}};
      renderer.applyProject=scene=>{
        for(const [name,source] of [["Image",scene.image],...scene.passes.map(p=>[p.name,p.fragment])]){try{renderer.validateFragment(source);}catch(error){error.passName=name;throw error;}}
        renderer.setPasses(scene.passes,scene.imageChannels);renderer.setFragment(scene.image);return true;};
      window.testRenderer=renderer;
      window.testStudio=TestStudio.mount(renderer,{fragment:src},null,{editorEngine:"codemirror",builtins:[{name:"smoothstep",sig:"T smoothstep(T e0, T e1, T x)",desc:"부드러운 계단"}],lookup:n=>n==="smoothstep"?{sig:"T smoothstep(T e0, T e1, T x)",desc:"부드러운 계단"}:null});
      testStudio.open();document.getElementById('studioLive').checked=false;
    }''')
    n=[0]
    def check(cond,label):
        assert cond,label;n[0]+=1;print('PASS',f'{n[0]:02d}',label,flush=True)
    def js(expr,arg=None):return page.evaluate(expr,arg)
    val=lambda:js("document.getElementById('studioCode').value")
    content=page.locator('.cm-content')
    def caret_to_end():content.click();page.keyboard.press('Control+End')
    def wait(ms=60):page.wait_for_timeout(ms)

    # ---- 장착 · 창구 ----
    check(js("!!document.querySelector('.studio-cm-host .cm-editor') && document.querySelector('.studio-editor-frame').classList.contains('is-codemirror')"),'CodeMirror view is mounted in the editor frame')
    check(js("getComputedStyle(document.querySelector('.studio-code-surface')).display")=='none','classic gutter/highlight/textarea surface is hidden')
    check(val()==js("testStudio.getProject().image") and js("document.querySelector('.cm-content').textContent.includes('fragColor = vec4(1.0);')"),'facade value and CodeMirror document hold the project source')
    classes=js("[...new Set([...document.querySelectorAll('.cm-content [class*=glsl-]')].map(n=>n.className))].sort()")
    check({'glsl-directive','glsl-keyword','glsl-type','glsl-number'}<=set(classes),f'GLSL tokens use the shared .glsl-* colors: {classes}')
    js("document.getElementById('studioCode').setSelectionRange(10,4,'backward')")
    check(js("(t=>[t.selectionStart,t.selectionEnd,t.selectionDirection])(document.getElementById('studioCode'))")==[4,4,'none'],'setSelectionRange clamps an inverted range like a textarea')
    js("document.getElementById('studioCode').setSelectionRange(4,10,'backward')")
    check(js("(t=>[t.selectionStart,t.selectionEnd,t.selectionDirection])(document.getElementById('studioCode'))")==[4,10,'backward'],'backward selection round-trips through the facade')
    js("(t=>{t.setSelectionRange(0,0);t.setRangeText('AB',0,0,'end');})(document.getElementById('studioCode'))")
    check(val().startswith('AB#version') and js("document.getElementById('studioCode').selectionStart")==2,'setRangeText "end" mode inserts and moves the caret')
    js("(t=>{t.setSelectionRange(5,5);t.setRangeText('',0,2,'preserve');})(document.getElementById('studioCode'))")
    check(val().startswith('#version') and js("document.getElementById('studioCode').selectionStart")==3,'setRangeText "preserve" maps the selection after the edit')

    # ---- studio 연동: 입력 → 미적용, 되돌리기, 프로젝트 교체, 진단, 패스 전환 ----
    js("testStudio.apply()");wait()
    caret_to_end();page.keyboard.type('// typed');wait(120)
    check(val().endswith('// typed'),'typing in CodeMirror updates the facade value')
    check(js("!document.getElementById('studioUndo').disabled"),'studio receives the input event (Undo becomes available)')
    page.keyboard.press('Control+z');wait(120)
    check('// typed' not in val(),'Ctrl+Z goes to studio history and restores the document')
    page.keyboard.press('Control+y');wait(120)
    check(val().endswith('// typed'),'Ctrl+Y redoes through studio history')
    js("testStudio.setProject({image:'#version 300 es\\nprecision highp float;\\nout vec4 fragColor;\\nvoid main() {\\n    float v = 1.0;\\n    v = v * 2.0;\\n    fragColor = vec4(v);\\n}\\n',passes:[],imageChannels:{}})");wait()
    check(js("document.querySelector('.cm-content').textContent.includes('float v = 1.0;')"),'setProject replaces the CodeMirror document')
    caret_to_end();page.keyboard.type('SYNTAX');js("testStudio.apply()");wait(150)
    check(js("document.querySelectorAll('.cm-lint-marker').length")>=1,'compile diagnostics appear in the CodeMirror lint gutter')
    page.keyboard.press('Control+z');wait(80)
    js("testStudio.setProject({image:'#version 300 es\\nout vec4 fragColor;\\nvoid main(){ fragColor = vec4(1.0); }\\n',passes:[{name:'A',fragment:'#version 300 es\\nout vec4 fragColor;\\nvoid main(){ fragColor = vec4(0.5); } // buffer A\\n',format:'rgba8',scale:1,channels:{}}],imageChannels:{}})");wait()
    content.click();page.keyboard.press('Alt+PageDown');wait(120)
    check(js("document.querySelector('.studio-pass-tabs .is-active').textContent")=='Buffer A' and 'buffer A' in js("document.querySelector('.cm-content').textContent"),'Alt+PageDown reaches studio and switches the pass shown in CodeMirror')
    page.keyboard.press('Alt+PageUp');wait(120)

    # ---- 편집 기능 ----
    js("testStudio.setProject({image:'#version 300 es\\nprecision highp float;\\nout vec4 fragColor;\\nvoid main() {\\n    float v = 1.0;\\n    v = v * 2.0;\\n    fragColor = vec4(v);\\n}\\n',passes:[],imageChannels:{}})");wait()
    check(js("document.querySelectorAll('.cm-foldGutter span[title]').length")>=1,'brace blocks are foldable')
    js("(t=>{const at=t.value.indexOf('v = 1.0');t.setSelectionRange(at,at);})(document.getElementById('studioCode'))");content.focus()
    for _ in range(3):page.keyboard.press('Control+d')
    check('다중 선택 3개' in page.locator('#studioCursor').inner_text(),'Ctrl+D adds occurrences as real CodeMirror selections')
    page.keyboard.type('w');wait()
    check(len([m for m in val().split() if m.strip(';()*=') == 'w'])>=3,'typing edits every cursor')
    page.keyboard.press('ArrowLeft');wait()
    check('다중 선택 3개' in page.locator('#studioCursor').inner_text(),'arrow keys move all cursors together (multi-cursor kept)')
    page.keyboard.press('Escape');wait()
    check('다중' not in page.locator('#studioCursor').inner_text(),'Escape returns to a single cursor')
    caret_to_end();page.keyboard.type('\nvoid f() {');page.keyboard.press('Enter');page.keyboard.type('x;')
    check(val().rstrip().endswith('void f() {\n    x;\n}'),'Enter between auto-closed braces indents one level')
    js("(t=>{t.setRangeText('\\nif (a) {\\n    y;\\n    ',t.value.length,t.value.length,'end');})(document.getElementById('studioCode'))");content.focus();page.keyboard.press('Control+End');page.keyboard.type('}')
    check(val().endswith('if (a) {\n    y;\n}'),'typing } on an indented line dedents it')
    caret_to_end();page.keyboard.type('\nfloat q = smst');wait(400)
    labels=js("[...document.querySelectorAll('.cm-tooltip-autocomplete li .cm-completionLabel')].map(x=>x.textContent)")
    check(labels and labels[0]=='smoothstep',f'fuzzy completion ranks smoothstep first for "smst": {labels[:3]}')
    page.keyboard.press('Enter');wait()
    check(val().rstrip().endswith('float q = smoothstep'),'Enter accepts the completion')
    page.keyboard.type(';\nfloat t = uTim');wait(400);page.keyboard.press('Enter');wait()
    check('uniform float uTime;' in val() and val().index('uniform float uTime;')>val().index('precision highp float;'),'picking an undeclared app uniform also inserts its declaration after precision')
    page.keyboard.press('Control+f');wait()
    check(page.is_visible('.cm-search'),'Ctrl+F opens the search panel')
    page.keyboard.press('Escape')
    js("document.getElementById('studioPaletteOpen').click()");wait()
    page.keyboard.type('@ma');wait()
    check(page.is_visible('.studio-palette') and 'main' in page.locator('.studio-palette-list button').first.inner_text(),'command palette @ lists functions of the pass')
    page.keyboard.press('Escape')
    js("document.getElementById('studioZoomIn').click()")
    check(js("getComputedStyle(document.querySelector('.cm-editor')).fontSize")=='13px','font size button reconfigures CodeMirror')
    js("document.getElementById('studioZoomOut').click()")
    box=js("""(()=>{const walker=document.createTreeWalker(document.querySelector('.cm-content'),NodeFilter.SHOW_TEXT);let node;
      while((node=walker.nextNode())){const i=node.textContent.indexOf('smoothstep');if(i>=0){const range=document.createRange();range.setStart(node,i+2);range.setEnd(node,i+3);const r=range.getBoundingClientRect();return [r.left+2,r.top+r.height/2];}}})()""")
    page.mouse.move(*box);wait(800)
    check('부드러운 계단' in (js("document.querySelector('.cm-tooltip-hover')?.textContent || ''")),'hovering a builtin shows its description')
    check(errors==[],f'no Chromium page exceptions: {errors}')
    print(f'PASS all {n[0]} CodeMirror engine checks')
    browser.close()
