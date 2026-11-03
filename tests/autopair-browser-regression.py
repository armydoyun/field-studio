from esm_for_browser import load_modules
# python tests/autopair-browser-regression.py — Chromium keyboard integration without GPU.
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
    code=page.locator('#studioCode');undo=page.locator('#studioUndo');redo=page.locator('#studioRedo')
    def check(ok,label):
        assert ok,label
        print('PASS',label,flush=True)
    def pos():return page.evaluate('''() => {const e=document.getElementById('studioCode');return [e.selectionStart,e.selectionEnd]}''')
    def place(a,b=None):page.evaluate('''a=>{const e=document.getElementById('studioCode');e.focus();e.setSelectionRange(...a)}''',[a,a if b is None else b])
    def setup(src,at=None,end=None):
        code.fill(src);place(len(src) if at is None else at,end)
    setup('');code.press('(')
    check(code.input_value()=='()' and pos()==[1,1],'opening parenthesis adds matching closer')
    code.press(')');check(code.input_value()=='()' and pos()==[2,2],'closing parenthesis jumps over existing closer')
    for opening,closing in [('(',')'),('[',']'),('{','}')]:
        setup(opening+closing,1);code.press(opening)
        check(code.input_value()==opening+opening+closing+closing and pos()==[2,2],f'nested {opening}{closing} before existing closer')
        code.press('Backspace');check(code.input_value()==opening+closing,f'backspace removes only nested {opening}{closing}')
    setup('sin()',4);code.press('(')
    check(code.input_value()=='sin(())' and pos()==[5,5],'nested function parentheses')
    setup('');code.press('[');check(code.input_value()=='[]' and pos()==[1,1],'square bracket auto pair')
    code.press('Backspace');check(code.input_value()=='' and pos()==[0,0],'backspace deletes empty square pair')
    setup('vec3',0,4);code.press('(')
    check(code.input_value()=='(vec3)' and pos()==[1,5],'selected text is wrapped and selection preserved')
    setup('');code.press('{');check(code.input_value()=='{}' and pos()==[1,1],'curly braces auto pair')
    code.press('Enter');check(code.input_value()=='{\n    \n}' and pos()==[6,6],'Enter expands paired braces with inner indent')
    undo.click();check(code.input_value()=='{}' and pos()==[1,1],'undo paired Enter restores previous source and caret')
    redo.click();check(code.input_value()=='{\n    \n}' and pos()==[6,6],'redo paired Enter restores inner caret')
    setup('    {}',5);code.press('Enter')
    check(code.input_value()=='    {\n        \n    }' and pos()==[14,14],'paired Enter preserves outer indentation')
    setup('');code.press('"');check(code.input_value()=='""' and pos()==[1,1],'double quote creates a pair')
    code.press('x');code.press('"');check(code.input_value()=='"x"' and pos()==[3,3],'quote inside string advances over closing quote')
    setup('');code.press('"');code.press('Backspace');check(code.input_value()=='','backspace deletes empty quote pair')
    setup('// GLSL comment ');code.press('(')
    check(code.input_value()=='// GLSL comment (' and pos()==[17,17],'no pairing in line comment')
    setup('/* multi\ncomment */',len('/* multi\ncomment '));code.press('[')
    check(code.input_value()=='/* multi\ncomment [*/','no pairing in block comment')
    setup('/* unfinished\n');code.press('{');check(code.input_value()=='/* unfinished\n{','no pairing inside unterminated block comment')
    setup('"escaped \\" quote"',len('"escaped \\"'));code.press('(')
    check(code.input_value()=='"escaped \\"( quote"','escaped quote does not prematurely leave string')
    setup('foo)',3);code.press(')');check(code.input_value()=='foo)' and pos()==[4,4],'existing closing parenthesis is not duplicated')
    setup('float a;',7);code.press('[');check(code.input_value()=='float a[];' and pos()==[8,8],'insert in middle maintains cursor')
    undo.click();check(code.input_value()=='float a;','undo paired insertion')
    redo.click();check('[]' in code.input_value(),'redo paired insertion')
    setup('');code.press('a');code.press('b');check(code.input_value()=='ab','ordinary typing unchanged')
    setup('// )',3);code.press(')');check(code.input_value()=='// ))','closer does not skip within comments')
    # Real native keyboard defaults: Enter must not activate focused Cancel/Close.
    for focused in ['studioDialogInput','studioDialogCancel','studioDialogClose','studioDialogOK']:
        setup('first\nsecond\nthird',0)
        page.locator('#studioGoto').click();page.locator('#studioDialogInput').fill('3')
        page.locator('#'+focused).focus();page.keyboard.press('Enter')
        check(not page.locator('#studioPromptDialog').is_visible() and pos()==[13,13],f'Enter confirms line input while {focused} is focused')
    setup('first\nsecond\nthird',0)
    page.locator('#studioGoto').click();page.locator('#studioDialogInput').fill('99');page.keyboard.press('Enter')
    check(page.locator('#studioPromptDialog').is_visible(),'invalid line number keeps modal open')
    page.keyboard.press('Escape');check(not page.locator('#studioPromptDialog').is_visible(),'Escape cancels invalid modal')
    check(errors==[],f'no Chromium page exceptions: {errors}')
    browser.close()
