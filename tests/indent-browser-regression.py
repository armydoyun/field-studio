from esm_for_browser import load_modules
# python tests/indent-browser-regression.py — Chromium textarea indentation and undo, no GPU.
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
    load_modules(page,root,['studio'])   # studio와 의존 모듈(code-editor, glsl-highlight, annotations)
    page.evaluate('''() => {
      const src="#version 300 es\\nprecision highp float;\\nvoid main(){}",state={image:src,passes:[],imageChannels:{}};
      const renderer={getUserUniforms:()=>[],getFragmentSource:()=>state.image,getPassDefinitions:()=>structuredClone(state.passes),getImageChannels:()=>structuredClone(state.imageChannels),
        getPasses:()=>state.passes.map(p=>({name:p.name})),getTextures:()=>[],getStats:()=>({running:false}),setPreviewPass:()=>{},
        validatePassConfiguration:()=>{},validateFragment:()=>true,setFragment:src=>state.image=src,
        setPasses:(passes,channels)=>{state.passes=structuredClone(passes);state.imageChannels=structuredClone(channels);},
        setImageChannels:x=>state.imageChannels=structuredClone(x),setPassFragment:(name,src)=>state.passes.find(p=>p.name===name).fragment=src,
        setPassChannels:(name,channels)=>state.passes.find(p=>p.name===name).channels=structuredClone(channels),resetSimulation:()=>{}};
      renderer.applyProject=scene=>{
        for(const [name,source] of [["Image",scene.image],...scene.passes.map(p=>[p.name,p.fragment])]) {
          try{renderer.validateFragment(source);}catch(error){error.passName=name;throw error;}
        }
        renderer.validatePassConfiguration(scene.passes,scene.imageChannels);
        renderer.setPasses(scene.passes,scene.imageChannels);renderer.setFragment(scene.image);return true;
      };
      window.testStudio=TestStudio.mount(renderer,{fragment:src});testStudio.open();document.getElementById('studioLive').checked=false;
    }''')
    code=page.locator('#studioCode')
    def check(cond,label):
        assert cond,label;print('PASS',label,flush=True)
    def pos():return page.evaluate('''() => {const e=document.getElementById('studioCode');return [e.selectionStart,e.selectionEnd]}''')
    def place(a,b=None):page.evaluate('''a=>{const e=document.getElementById('studioCode');e.focus();e.setSelectionRange(...a)}''',[a,a if b is None else b])
    def setup(src,at=None,end=None):code.fill(src);place(len(src) if at is None else at,end)
    def verify(expected,label,caret=None):check(code.input_value()==expected and (caret is None or pos()==[caret,caret]),label+f' (got {code.input_value()!r}, {pos()})')
    setup('if(ok) {');code.press('Enter');verify('if(ok) {\n    ','Enter indents after opening block',len('if(ok) {\n    '))
    setup('    if(ok) {');code.press('Enter');verify('    if(ok) {\n        ','Enter retains outer indentation')
    setup('if(ok) {   ');code.press('Enter');verify('if(ok) {\n    ','Enter trims trailing spaces after opening brace')
    setup('    {  }',6);code.press('Enter');verify('    {\n        \n    }','Enter expands brace with spaces before closer',len('    {\n        '))
    setup('{\t}',2);code.press('Enter');verify('{\n    \n}','Enter expands brace with tab before closer')
    setup('    // comment {');code.press('Enter');verify('    // comment {\n    ','line-comment brace does not indent')
    setup('    /* comment {');code.press('Enter');verify('    /* comment {\n    ','block-comment brace does not indent')
    setup('    "text {"',len('    "text {'));code.press('Enter');verify('    "text {\n    "','string brace does not indent')
    setup('    ');code.press('}');verify('}','closing brace removes one indentation level',1)
    setup('        ');code.press('}');verify('    }','closing brace removes only one level',5)
    setup('  ');code.press('}');verify('}','closing brace removes partial indentation')
    setup('\t\t');code.press('}');verify('\t}','closing brace removes one tab')
    setup('    }',4);code.press('}');verify('}', 'existing closer is skipped after dedenting',1)
    setup('    // ');code.press('}');verify('    // }','comment closing brace is literal')
    setup('    float n=1.;');code.press('}');verify('    float n=1.;}','brace inside code does not change earlier indentation')
    setup('a\n\nb',0,4);code.press('Tab');verify('    a\n\n    b','multiline Tab leaves blank row empty')
    check('    \n' not in code.input_value(),'no whitespace-only lines created by selection Tab')
    code.press('Shift+Tab');verify('a\n\nb','multiline Shift+Tab restores original')
    setup('    a\n\n  b',0,11);code.press('Shift+Tab');verify('a\n\nb','multiline dedent removes partial indentation and skips blank')
    setup('a\n\nb',0,4);code.press('Control+BracketRight');verify('    a\n\n    b','Ctrl+] supports block indent')
    code.press('Control+BracketLeft');verify('a\n\nb','Ctrl+[ supports block outdent')
    setup('\n\n',0,2);code.press('Tab');verify('\n\n','Tab on only blank lines does not create whitespace')
    setup('    value',6);code.press('Shift+Tab');verify('value','Shift+Tab on current line removes indent',2)
    setup('if(ok){\n    x=1.;\n}');place(len('if(ok){\n    x=1.;\n}'));code.press('Enter');verify('if(ok){\n    x=1.;\n}\n','Enter after closing brace does not invent indentation')
    setup('    {}',5);code.press('Enter');verify('    {\n        \n    }','existing auto-pair Enter remains correct')
    page.locator('#studioUndo').click();verify('    {}','undo restores before smart Enter',5)
    page.locator('#studioRedo').click();verify('    {\n        \n    }','redo restores after smart Enter',len('    {\n        '))
    setup('    ');code.press('}');verify('}','dedent edit for history',1)
    page.locator('#studioUndo').click();verify('    ','undo restores pre-dedent whitespace',4)
    page.locator('#studioRedo').click();verify('}','redo reapplies dedent',1)
    page.locator('#studioCodeTools > summary').click()
    page.locator('#studioIndent').select_option('2')
    setup('  { }',3);code.press('Enter');verify('  {\n    \n  }','2-space setting controls nested indentation')
    setup('    ');code.press('}');verify('  }','2-space setting controls dedent')
    # 문서 끝에서도 Backspace는 들여쓰기 한 단위를 지운다(이전에는 자동 괄호 짝 검사가 undefined===undefined로 통과해 한 칸만 지웠다).
    setup('a\n    ');code.press('Backspace');verify('a\n  ','Backspace at end of document removes one indent unit',4)
    setup('x');code.press('Backspace');verify('','Backspace at end of document still deletes a plain character',0)
    check(errors==[],f'Chromium page exceptions: {errors}')
    browser.close()
