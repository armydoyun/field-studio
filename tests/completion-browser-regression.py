from esm_for_browser import mock_module
# python tests/completion-browser-regression.py — Ctrl+Space suggestions, keyboard/mouse and editor history.
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text();html=html[:html.index('    <!-- ES Modules:')]+'</body></html>'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900});errors=[];n=[0]
    page.on('pageerror',lambda err:errors.append(str(err)))
    page.set_content(html);page.add_style_tag(content=(root/'style.css').read_text())
    page.evaluate('''() => window.define=(deps,factory)=>{if(deps[0]==="glsl-highlight"){window.TestEditor=factory(window.TestEditor);return;}if(!deps.length)window.TestEditor=factory();else if(deps[0]==="code-editor")window.TestStudio=factory(window.TestEditor);}''')
    page.add_script_tag(content=mock_module((root/'js/glsl-highlight.js').read_text()));page.add_script_tag(content=mock_module((root/'js/code-editor.js').read_text()));page.add_script_tag(content=mock_module((root/'js/studio.js').read_text()))
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
    code=page.locator('#studioCode');panel=page.locator('#studioCompletion')
    def check(ok,label):
        assert ok,label;n[0]+=1;print('PASS',f'{n[0]:02d}',label,flush=True)
    # 항목은 [종류 아이콘 · 이름 · 상세] 구조다. 이름 칸만 비교한다.
    def options():return panel.locator('.completion-label').all_text_contents()
    def selected():return panel.locator('button.is-selected .completion-label').inner_text()
    def select(pos,stop=None):page.evaluate('''([a,b])=>{const t=document.getElementById('studioCode');t.focus();t.setSelectionRange(a,b);}''',[pos,pos if stop is None else stop])
    def setup(src,pos=None):code.fill(src);select(len(src) if pos is None else pos)
    def open_completion():code.press('Control+Space')
    setup('vec');open_completion()
    check(panel.is_visible(),'Ctrl+Space opens completion')
    check('vec2' in options() and 'vec3' in options() and 'vec4' in options(),'GLSL type prefix suggestions')
    check(options()[:3]==['vec2','vec3','vec4'] and len(options())<=60,'prefix matches ranked first, list limited')
    check(panel.locator('button.is-selected').count()==1 and options()[0]==selected(),'first suggestion initially selected')
    code.press('ArrowDown');check(options()[1]==selected(),'ArrowDown changes selection')
    code.press('ArrowUp');check(options()[0]==selected(),'ArrowUp restores selection')
    code.press('Enter');check(code.input_value()=='vec2' and not panel.is_visible(),'Enter inserts suggestion and closes popup')
    page.locator('#studioUndo').click();check(code.input_value()=='vec','Undo restores completion edit')
    page.locator('#studioRedo').click();check(code.input_value()=='vec2','Redo restores completion edit')
    setup('nor');page.locator('#studioComplete').click()
    check(panel.is_visible() and 'normalize' in options(),'toolbar completion button works')
    panel.get_by_text('normalize',exact=True).click();check(code.input_value()=='normalize' and not panel.is_visible(),'mouse completion inserts and closes')
    setup('tex');open_completion();check('texture' in options() and 'texelFetch' in options(),'texture builtin suggestions')
    code.press('Escape');check(code.input_value()=='tex' and not panel.is_visible(),'Escape closes without changing code')
    setup('vec3 pos = vec');open_completion();code.press('Tab');check(code.input_value()=='vec3 pos = vec2','Tab accepts completion, not indentation')
    setup('vec2');open_completion();check(not panel.is_visible(),'exact name does not produce redundant suggestion')
    setup('qqq');open_completion();check(not panel.is_visible(),'unknown prefix leaves no popup')
    setup('vec');select(0,3);open_completion();check(not panel.is_visible(),'text selection suppresses completion')
    setup('// vec');open_completion();check(not panel.is_visible(),'line comment suppresses completion')
    setup('/* vec');open_completion();check(not panel.is_visible(),'block comment suppresses completion')
    setup('"vec');open_completion();check(not panel.is_visible(),'string suppresses completion')
    setup('vec;');select(3);open_completion();code.press('ArrowDown');code.press('ArrowDown');code.press('Enter')
    check(code.input_value()=='vec4;','completion only replaces active token, not punctuation')
    setup('vecXYZ');select(3);open_completion();check('vec2' in options(),'middle-of-identifier offers correct suggestions')
    code.press('Enter');check(code.input_value()=='vec2','completion replaces identifier suffix rather than duplicating')
    setup('float myShade(vec3 p){return p.x;}\nvoid main(){mySh');open_completion()
    check('myShade' in options(),'user-defined function is offered')
    code.press('Enter');check(code.input_value().endswith('myShade'),'user function completion inserts correctly')
    setup('// float fakeThing(){}\nfloat realThing(){return 1.;}\nvoid main(){rea');open_completion()
    check('realThing' in options() and 'fakeThing' not in options(),'functions inside comments not suggested')
    code.press('Escape');setup('uni');open_completion();check('uniform' in options(),'keywords included')
    code.press(';');check(not panel.is_visible() and code.input_value()=='uni;','typing punctuation dismisses popup and remains editable')
    setup('vec');open_completion();code.press('ArrowDown');code.press('ArrowDown');code.press('ArrowDown');check(selected()==options()[0],'ArrowDown wraps')
    setup('vec');open_completion();code.press('ArrowUp');check(selected()==options()[-1],'ArrowUp wraps')
    # 입력하는 동안 저절로 뜨는 제안(VS Code 빠른 제안)과 멤버 완성
    code.press('Escape');setup('');code.press('s');code.press('m');code.press('o')
    check(panel.is_visible() and options()[0]=='smoothstep','suggestions appear while typing, built-in ranked first')
    code.press('Escape');setup('vec2 p;\nvoid main(){p');code.press('.')
    check(panel.is_visible() and options()[:3]==['x','y','xy'],'swizzle members offered after vec2 name')
    code.press('Escape');setup('float t;\nvoid main(){float ');code.press('s')
    check(not panel.is_visible(),'no automatic popup while naming a new variable')
    code.press('Escape');setup('vec');open_completion();code.click();check(not panel.is_visible(),'click in code closes suggestion list')
    setup('vec');open_completion();code.fill('new code');check(not panel.is_visible(),'source update dismisses suggestion list')
    setup('vec');open_completion();page.locator('#studioFind').click();check(not panel.is_visible(),'moving focus to find hides popup')
    page.locator('#studioFindClose').click()
    check(errors==[],f'no JS page errors: {errors}')
    print(f'PASS all {n[0]} browser completion checks',flush=True)
    browser.close()
