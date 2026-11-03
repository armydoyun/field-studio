# python tests/undo-cursor-regression.py (Playwright/Chromium, GPU-independent mock renderer)
from esm_for_browser import load_modules
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text(); html=html[:html.index('    <!-- ES Modules:')]+'</body></html>'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH') or None,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900}); errors=[]
    page.on('pageerror',lambda err: errors.append(str(err)))
    page.set_content(html);page.add_style_tag(content=(root/'style.css').read_text())
    load_modules(page,root,['studio'])   # studio와 의존 모듈(code-editor, glsl-highlight, annotations)
    page.evaluate('''() => {
      const frag="#version 300 es\\nprecision highp float;\\nout vec4 fragColor;\\nvoid main(){fragColor=vec4(1.);}";
      let state={image:frag,passes:[],imageChannels:{}};
      const renderer={getUserUniforms:()=>[],getFragmentSource:()=>state.image,getPassDefinitions:()=>structuredClone(state.passes),getImageChannels:()=>structuredClone(state.imageChannels),
        getPasses:()=>state.passes.map(p=>({name:p.name})),getTextures:()=>[],getStats:()=>({running:false}),setPreviewPass:()=>{},
        validatePassConfiguration:()=>{},validateFragment:src=>{if(src.includes('BROKEN'))throw Error('GLSL compilation BROKEN');return true;},
        setFragment:src=>state.image=src,setPasses:(passes,channels)=>{state.passes=structuredClone(passes);state.imageChannels=structuredClone(channels);},
        setImageChannels:x=>state.imageChannels=structuredClone(x),setPassFragment:(name,src)=>state.passes.find(p=>p.name===name).fragment=src,
        setPassChannels:(name,channels)=>state.passes.find(p=>p.name===name).channels=structuredClone(channels),resetSimulation:()=>{}};
      renderer.applyProject=scene=>{
        for(const [name,source] of [["Image",scene.image],...scene.passes.map(p=>[p.name,p.fragment])]) {
          try{renderer.validateFragment(source);}catch(error){error.passName=name;throw error;}
        }
        renderer.validatePassConfiguration(scene.passes,scene.imageChannels);
        renderer.setPasses(scene.passes,scene.imageChannels);renderer.setFragment(scene.image);return true;
      };
      window.testRenderer=renderer;window.testStudio=TestStudio.mount(renderer,{fragment:frag});testStudio.open();
      document.getElementById('studioLive').checked=false;
    }''')
    js=lambda code,*args: page.evaluate(code,*args)
    def check(condition,label):
        assert condition,label
        print('PASS',label,flush=True)
    original=js('testRenderer.getFragmentSource()')
    area=page.locator('#studioCode')
    def selection(): return js('''() => {const el=document.getElementById('studioCode');return [el.selectionStart,el.selectionEnd,el.selectionDirection]}''')
    def place(start,end=None,direction='none'):
        js("""(args) => {const el=document.getElementById('studioCode');el.focus();el.setSelectionRange(...args);}""",[start,start if end is None else end,direction])
    # A middle-of-document native typing mutation, including failed GLSL compilation.
    point=original.index('fragColor=')+2
    place(point)
    area.press('x')
    check(selection()[:2]==[point+1,point+1],'typed caret advances one character')
    area.press('y')
    check(selection()[:2]==[point+2,point+2],'typed caret advances again')
    page.locator('#studioRun').click()
    page.locator('#studioUndo').click()
    check(area.input_value()==original,'undo restores original code from middle')
    check(selection()[:2]==[point,point],f'undo restores middle caret, got {selection()} expected {point}')
    page.locator('#studioRedo').click()
    check(selection()[:2]==[point+2,point+2],'redo restores post-edit caret')
    # Text selection is also part of the history, including backwards selections.
    page.locator('#studioUndo').click()
    start=original.index('vec4(1.)');end=start+len('vec4(1.)')
    place(start,end,'backward')
    area.press('A')
    page.locator('#studioUndo').click()
    check(area.input_value()==original,'undo selected-text overwrite')
    check(selection()==[start,end,'backward'],f'undo restores original text selection {selection()}')
    page.locator('#studioRedo').click()
    check(selection()[:2]==[start+1,start+1],'redo restores cursor after overwritten text')
    # Custom Tab indentation is dispatched programmatically, without a beforeinput event.
    page.locator('#studioUndo').click()
    place(point)
    area.press('Tab')
    page.locator('#studioUndo').click()
    check(selection()[:2]==[point,point],'undo of custom Tab command restores caret')
    page.locator('#studioRedo').click()
    check(selection()[:2]==[point+4,point+4],'redo of Tab command restores caret')
    # Even a long document restores scroll position as well as the caret.
    long_code=original+'\n'+'\n'.join('// test line '+str(i) for i in range(170))
    js("""(src) => testStudio.setProject({image:src,passes:[],imageChannels:{}})""", long_code)
    page.wait_for_timeout(100)
    place(len(long_code)-70)
    js("""() => {const el=document.getElementById('studioCode');el.scrollTop=300;el.dispatchEvent(new Event('scroll'));}""")
    before_scroll=js("document.getElementById('studioCode').scrollTop")
    area.press('x')
    page.locator('#studioUndo').click()
    check(selection()[:2]==[len(long_code)-70]*2,'undo restores caret in long source')
    check(js("document.getElementById('studioCode').scrollTop")==before_scroll, 'undo restores previous vertical scroll position')
    # Editing a different Buffer must keep its own caret during Undo/Redo.
    buffer_project={'image':original,'passes':[{'name':'A','fragment':original,'format':'rgba8','scale':1,'channels':{}}],'imageChannels':{}}
    js('(project) => testStudio.setProject(project)',buffer_project)
    page.locator('#studioPassTabs button').nth(1).click()
    point=original.index('fragColor=')+4
    place(point)
    area.press('x')
    page.locator('#studioUndo').click()
    check(js("document.querySelector('#studioPassTabs .is-active').textContent").strip()=='Buffer A','undo stays in edited Buffer A')
    check(selection()[:2]==[point,point],'undo restores caret in Buffer A')
    page.locator('#studioRedo').click()
    check(selection()[:2]==[point+1,point+1],'redo restores caret in Buffer A')
    check(errors==[],f'no console exceptions {errors}')
    print('PASS cursor and selection undo regression tests',flush=True)
    browser.close()
