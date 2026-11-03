from esm_for_browser import mock_module
# python tests/move-lines-browser-regression.py — Chromium line move, selection and history (mock GPU).
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text();html=html[:html.index('    <!-- ES Modules:')]+'</body></html>'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900});errors=[]
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
    code=page.locator('#studioCode');n=[0]
    def check(cond,label):
        assert cond,label; n[0]+=1;print('PASS',f'{n[0]:02d}',label,flush=True)
    def select(a,b=None,direction='none'):
        page.evaluate('''args=>{const e=document.getElementById('studioCode');e.focus();e.setSelectionRange(...args)}''',[a,a if b is None else b,direction])
    def state():return page.evaluate('''() => {const e=document.getElementById('studioCode');return [e.value,e.selectionStart,e.selectionEnd,e.selectionDirection]}''')
    def setup(src,a=None,b=None,direction='none'):
        code.fill(src);select(len(src) if a is None else a,b,direction)
    def verify(value,a,b,label,direction=None):
        got=state();check(got[:3]==[value,a,b] and (direction is None or got[3]==direction),label+f' (got {got})')
    def up():code.press('Alt+ArrowUp')
    def down():code.press('Alt+ArrowDown')
    setup('abc\ndef\nghi',5);up();verify('def\nabc\nghi',1,1,'move middle line up retains column')
    down();verify('abc\ndef\nghi',5,5,'move moved line back down with caret')
    setup('abc\ndef\nghi',1);down();verify('def\nabc\nghi',5,5,'move first line down retains caret column')
    setup('a\nlongword\nz',3);down();verify('a\nz\nlongword',5,5,'moving differing-length next line')
    setup('longword\na\nz',5);up();verify('longword\na\nz',5,5,'first row cannot move up')
    setup('a\nb\nc',5);down();verify('a\nb\nc',5,5,'last row cannot move down')
    setup('AA\nBB\nCC\nDD',3,8);up();verify('BB\nCC\nAA\nDD',0,5,'selected middle rows move up as group')
    down();verify('AA\nBB\nCC\nDD',3,8,'selected group moves back down')
    setup('AA\nBB\nCC\nDD',3,9);down();verify('AA\nDD\nBB\nCC',6,11,'end exactly at next-line start excludes that line')
    setup('aa\nbb\ncc',1,2);down();verify('bb\naa\ncc',4,5,'partial-column single-line range moves down')
    setup('aa\nbb\ncc\ndd',4,8,'backward');up();verify('bb\ncc\naa\ndd',1,5,'reverse-direction multiline selection retained','backward')
    setup('x\n\ny',2);up();verify('\nx\ny',0,0,'blank line moves up')
    setup('x\n\ny',0);down();verify('\nx\ny',1,1,'nonblank line moves across empty line')
    setup('x\ny\n',2);down();verify('x\n\ny',3,3,'line moves below trailing blank row')
    setup('x\ny\n',4);up();verify('x\n\ny',2,2,'trailing empty row moves upward')
    setup('aa\nbb',0,3);down();verify('bb\naa',3,5,'selection through newline with next row at EOF is clamped')
    setup('one\ntwo\nthree',0,4);down();verify('two\none\nthree',4,8,'selection includes terminating newline, retains whole moved row')
    # history and adjacent editor shortcuts
    setup('zero\none\ntwo',6);up();verify('one\nzero\ntwo',1,1,'move creates project edit')
    page.locator('#studioUndo').click();verify('zero\none\ntwo',6,6,'Undo restores source and caret')
    page.locator('#studioRedo').click();verify('one\nzero\ntwo',1,1,'Redo restores moved source and caret')
    setup('first\nsecond',3);up();check(page.locator('#studioUndo').is_enabled(),'boundary no-op does not disable earlier Undo')
    setup('a\nb\nc',2);down();down();verify('a\nc\nb',4,4,'repeated down ends at lower boundary')
    setup('if(x){}\nvec3 y;',0);code.press('Control+Shift+d');check(code.input_value().startswith('if(x){}\nif(x){}'),'existing line duplication remains available')
    setup('a\nb',0,1);code.press('Tab');check(code.input_value().startswith('    a'),'existing block indent remains functional')
    setup('a\nb',0);code.press('(');check(code.input_value().startswith('()'),'existing auto pair remains functional')
    check(errors==[],f'no page exceptions: {errors}')
    print(f'PASS all {n[0]} line-movement/browser checks',flush=True)
    browser.close()
