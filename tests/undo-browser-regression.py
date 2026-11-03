from esm_for_browser import mock_module
# python tests/undo-browser-regression.py (Playwright/Chromium, GPU-independent mock renderer)
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text(); html=html[:html.index('    <!-- ES Modules:')]+'</body></html>'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900}); errors=[]
    page.on('pageerror',lambda err: errors.append(str(err)))
    page.set_content(html);page.add_style_tag(content=(root/'style.css').read_text())
    page.evaluate('''() => window.define=(deps,factory)=>{if(!deps.length)window.TestEditor=factory();else if(deps[0]==="code-editor")window.TestStudio=factory(window.TestEditor);}''')
    page.add_script_tag(content=mock_module((root/'js/code-editor.js').read_text()))
    page.add_script_tag(content=mock_module((root/'js/studio.js').read_text()))
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
    js=lambda code: page.evaluate(code)
    def check(condition,label):
        assert condition,label
        print('PASS',label,flush=True)
    original=js('testRenderer.getFragmentSource()')
    check(js('document.getElementById("studioUndo").disabled'), 'start with empty history')
    bad=original.replace('vec4(1.)','vec4(BROKEN)')
    page.locator('#studioCode').fill(bad)
    check(not js('document.getElementById("studioUndo").disabled'),'undo enabled before compilation')
    page.locator('#studioRun').click()
    check(js('testRenderer.getFragmentSource()')==original,'compile error preserves applied GLSL')
    check('오류' in page.locator('#studioMessage').inner_text(),'compile error shown')
    page.locator('#studioUndo').click()
    check(page.locator('#studioCode').input_value()==original,'undo restores source after failed compilation')
    check(js('testRenderer.getFragmentSource()')==original,'undo keeps GPU correct')
    check(js('document.getElementById("studioPromptDialog").open')==False,'undo does not ask for confirmation')
    page.locator('#studioRedo').click()
    check(page.locator('#studioCode').input_value()==bad,'redo restores invalid draft')
    check(js('testRenderer.getFragmentSource()')==original,'invalid redo leaves GPU running last good shader')
    page.locator('#studioCode').focus();page.locator('#studioCode').press('Control+z')
    check(page.locator('#studioCode').input_value()==original,'Ctrl+Z from editor invokes project undo')
    page.locator('#studioCode').press('Control+Shift+z')
    check(page.locator('#studioCode').input_value()==bad,'Ctrl+Shift+Z invokes redo')
    page.locator('#studioCode').press('Control+y')
    check(page.locator('#studioCode').input_value()==bad,'Ctrl+Y invokes redo')
    page.locator('#studioCode').press('Control+z')
    # coalescing rapid typing into one Undo operation
    base=page.locator('#studioCode').input_value()
    js('''() => {const el=document.getElementById('studioCode');for(let i=0;i<4;i++){el.value=el.value+'x';el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'x'}));}}''')
    check(page.locator('#studioCode').input_value().endswith('xxxx'),'four sequential input events')
    page.locator('#studioUndo').click()
    check(page.locator('#studioCode').input_value()==base,'rapid typing grouped into one undo')
    page.locator('#studioRedo').click()
    check(page.locator('#studioCode').input_value().endswith('xxxx'),'grouped typing redo')
    page.locator('#studioCode').fill(original)
    page.locator('#studioRun').click()
    check(js('testRenderer.getFragmentSource()')==original,'valid source reapplied')
    other=original.replace('vec4(1.)','vec4(0.3)')
    page.locator('#studioCode').fill(other);page.locator('#studioRun').click()
    check(js('testRenderer.getFragmentSource()')==other,'successfully compiled change')
    page.locator('#studioUndo').click()
    check(js('testRenderer.getFragmentSource()')==original,'undo successful compilation')
    page.locator('#studioRedo').click()
    check(js('testRenderer.getFragmentSource()')==other,'redo successful compilation')
    page.locator('#studioUndo').click()
    branch=original.replace('vec4(1.)','vec4(0.9)')
    page.locator('#studioCode').fill(branch)
    check(js('document.getElementById("studioRedo").disabled'),'new edit invalidates redo branch')
    page.locator('#studioRun').click()
    check(js('testRenderer.getFragmentSource()')==branch,'new edit can compile after undo')
    # No-#version drafts must remain recoverable even if project validation rejects them.
    page.locator('#studioCode').fill('invalid without a version');page.locator('#studioRun').click()
    page.locator('#studioUndo').click()
    check(page.locator('#studioCode').input_value()==branch,'undo draft failing project validation')
    # Test auto compilation failure and recovery with debounced timer.
    page.locator('#studioLive').check()
    page.locator('#studioCode').fill(bad)
    page.wait_for_timeout(1050)
    check('오류' in page.locator('#studioMessage').inner_text(),'Auto compile error surfaced')
    page.locator('#studioUndo').click()
    check(page.locator('#studioCode').input_value()==branch and js('testRenderer.getFragmentSource()')==branch,'Auto compile failure can undo')
    page.locator('#studioLive').uncheck()
    # Structural changes and cross-pass restores
    js('''() => {window.passSource=testRenderer.getFragmentSource();window.testStudio.setProject({image:passSource,passes:[{name:'A',fragment:passSource,format:'rgba8',scale:1,channels:{}}],imageChannels:{}})}''')
    check(page.locator('#studioPassTabs button').count()==2,'setProject creates Buffer A')
    page.locator('#studioPassTabs button').nth(1).click()
    badB=original.replace('vec4(1.)','vec4(BROKEN)')
    page.locator('#studioCode').fill(badB);page.locator('#studioRun').click()
    page.locator('#studioUndo').click()
    check(page.locator('#studioCode').input_value()==branch,'buffer invalid undo')
    page.locator('#studioRedo').click()
    check(page.locator('#studioCode').input_value()==badB,'buffer invalid redo')
    page.locator('#studioUndo').click()
    page.locator('#studioUndo').click()
    check(page.locator('#studioPassTabs button').count()==1,'undo structural project change')
    check(errors==[], f'no browser runtime errors: {errors}')
    print('PASS all undo/redo browser integration tests',flush=True)
    browser.close()
