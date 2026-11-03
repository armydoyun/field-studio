from esm_for_browser import load_modules
# python tests/editor-power-browser-regression.py — 들여쓰기 안내선 · 블록 주석 · 찾기 옵션 · Ctrl+D 다중 선택 · 색상 미리보기 (GPU 불필요)
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
      renderer.applyProject=scene=>{renderer.setPasses(scene.passes,scene.imageChannels);renderer.setFragment(scene.image);return true;};
      window.testStudio=TestStudio.mount(renderer,{fragment:src});testStudio.open();document.getElementById('studioLive').checked=false;
    }''')
    code=page.locator('#studioCode');n=[0]
    def check(cond,label):
        assert cond,label;n[0]+=1;print('PASS',f'{n[0]:02d}',label,flush=True)
    def js(expr,arg=None):return page.evaluate(expr,arg)
    def pos():return js("() => {const e=document.getElementById('studioCode');return [e.selectionStart,e.selectionEnd]}")
    def place(a,b=None):
        js("a=>{const e=document.getElementById('studioCode');e.focus();e.setSelectionRange(...a);e.dispatchEvent(new Event('select'))}",[a,a if b is None else b]);page.wait_for_timeout(30)
    def setup(src,a=None,b=None):code.fill(src);place(len(src) if a is None else a,b)
    def status():return page.locator('#studioCursor').inner_text()
    def deco(selector):page.wait_for_timeout(40);return js(f"document.querySelectorAll('{selector}').length")   # 장식은 다음 틱에 그려진다

    # ---- 들여쓰기 안내선 ----
    setup('void main() {\n    if(x) {\n        y;\n\n    }\n}',33)
    guides=js("() => [...document.querySelectorAll('.deco-indent')].map(g=>[g.className,Math.round(parseFloat(g.style.height))])")
    check(len(guides)==2,f'indent guides drawn per level, merged vertically: {guides}')
    check(any('is-active' in c for c,_ in guides),'guide of the caret block is highlighted')
    heights=sorted(h for _,h in guides)
    check(heights[1]>heights[0],'blank line inherits the shallower neighbouring indent (outer guide spans more lines)')

    # ---- 블록 주석 ----
    setup('float a = 1.0;',6,9);code.press('Shift+Alt+A');check(code.input_value()=='float /* a = */ 1.0;' and pos()==[6,15],'Shift+Alt+A wraps the selection')
    code.press('Shift+Alt+A');check(code.input_value()=='float a = 1.0;','Shift+Alt+A again unwraps')
    setup('x',1);code.press('Shift+Alt+A');check(code.input_value()=='x/*  */' and pos()==[4,4],'empty selection inserts /*  */ with the caret inside')
    setup('a  b ',1,5);code.press('Shift+Alt+A');check(code.input_value()=='a  /* b */ ','surrounding whitespace stays outside the comment')

    # ---- 찾기 옵션 ----
    setup('Foo foo food FOO\nfoo_bar foo2',0);code.press('Control+f');q=page.locator('#studioFindQuery');q.fill('foo')
    count=lambda:page.locator('#studioFindCount').inner_text()
    check(count()=='6 results','default search is case-insensitive substring')
    check(deco('.deco-find')==6,'all visible matches are highlighted while find is open')
    page.click('#studioFindCase');check(count()=='4 results','Aa: case-sensitive')
    page.click('#studioFindWord');check(count()=='1 results','Aa + ab: whole word')
    page.click('#studioFindCase');check(count()=='3 results','ab: whole word, any case')
    page.click('#studioFindWord');page.click('#studioFindRegex');q.fill('foo(\\d)');check(count()=='1 results','.*: regular expression')
    q.fill('fo(');check(count()=='정규식 오류' and q.get_attribute('aria-invalid')=='true','invalid regex is reported, not thrown')
    q.fill('foo(\\d)');page.click('#studioReplaceToggle');check(page.is_visible('#studioReplaceRow'),'replace row opens from the find row')
    page.fill('#studioReplaceValue','bar$1$1');page.click('#studioReplaceAll');check(code.input_value()=='Foo foo food FOO\nfoo_bar bar22','regex replace expands $1')
    page.click('#studioFindRegex');page.click('#studioFindCase');q.fill('Foo');page.fill('#studioReplaceValue','$&');page.click('#studioReplaceOne');page.click('#studioReplaceOne')
    check(code.input_value().startswith('$& foo'),'literal mode keeps $& as text; Replace selects first, then replaces')
    q.press('Alt+w');check(page.get_attribute('#studioFindWord','aria-pressed')=='true','Alt+W toggles whole word from the find box')
    q.press('Alt+w');page.click('#studioFindCase');page.click('#studioFindClose')
    check(deco('.deco-find')==0,'match highlights disappear when find closes')

    # ---- Ctrl+D 다중 선택 ----
    SRC='float v = 1.0;\nv = v * 2.0;\nfloat vv = v + value;'
    setup(SRC,7);code.press('Control+d');check(pos()==[6,7],'first Ctrl+D selects the word under the caret')
    for _ in range(3):code.press('Control+d')
    check('다중 선택 4개' in status(),'Ctrl+D adds each whole-word occurrence (vv/value excluded)')
    check(deco('.deco-multi')==3,'secondary selections are drawn')
    code.press('x');code.press('y');check(code.input_value()=='float xy = 1.0;\nxy = xy * 2.0;\nfloat vv = xy + value;','typing edits every selection')
    code.press('Backspace');check(code.input_value()=='float x = 1.0;\nx = x * 2.0;\nfloat vv = x + value;','Backspace edits every caret')
    code.press('Control+z');check(code.input_value()==SRC and '다중' not in status(),'Undo restores the source and ends multi-selection')
    setup(SRC,7);code.press('Control+Shift+l');check('다중 선택 4개' in status(),'Ctrl+Shift+L selects all occurrences')
    code.press('Escape');check('다중' not in status(),'Escape ends multi-selection')
    setup('ab xab ab',0,2);code.press('Control+d');code.press('Control+d');code.press('Q');check(code.input_value()=='Q xQ Q','with a selection, Ctrl+D matches the exact text (inside words too)')
    setup('a a a',0);code.press('Control+d');code.press('Control+d');code.press('ArrowRight');code.press('Z');check(code.input_value()=='a aZ a','arrow keys end multi-selection')
    setup('k k',0);code.press('Control+d');code.press('Control+d')
    js("() => {const t=document.getElementById('studioCode'),dt=new DataTransfer();dt.setData('text/plain','ONE\\nTWO');t.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}")
    check(code.input_value()=='ONE TWO','pasting as many lines as selections distributes one line each')
    setup('n n',0);code.press('Control+d');code.press('Control+d')
    js("""() => {const t=document.getElementById('studioCode');t.dispatchEvent(new CompositionEvent('compositionstart',{data:''}));t.setRangeText('한',t.selectionStart,t.selectionEnd,'end');
      t.dispatchEvent(new InputEvent('input',{inputType:'insertCompositionText',data:'한',bubbles:true}));t.dispatchEvent(new CompositionEvent('compositionend',{data:'한'}));}""")
    check(code.input_value()=='한 한','IME composition is copied to every selection')
    setup('m m',0);code.press('Control+d');code.press('Control+d');code.fill('reset')
    check(code.input_value()=='reset' and '다중' not in status(),'input after an outside selection change ends multi-selection instead of multiplying it')

    # ---- 색상 미리보기·선택기 ----
    setup('vec3 a = vec3(1.0, 0.5, 0.0);\nvec4 b = vec4(0.2,0.4,0.8,1.0);\nvec3 n = vec3(0.0, 2.0, 0.0); // vec3(0.1,0.2,0.3)\nvec3 c = vec3(x, 0.5, 0.5);',0)
    swatches=js("[...document.querySelectorAll('.deco-color')].map(n=>n.style.getPropertyValue('--swatch'))")
    check(swatches==['rgb(255 128 0)','rgb(51 102 204 / 1)'],f'only 0..1 numeric vec3/vec4 literals outside comments get a swatch: {swatches}')
    check(js("document.querySelector('.studio-color-chip').hidden"),'picker button hidden while the caret is outside a color')
    place(16);check(not js("document.querySelector('.studio-color-chip').hidden"),'picker button appears when the caret is inside a color literal')
    chip=js("document.querySelector('.studio-color-chip').getBoundingClientRect().toJSON()");lit=js("document.querySelector('.deco-color').getBoundingClientRect().toJSON()")
    check(chip['left']>=lit['right'],'picker button sits after the line text, not over code')
    js("""() => {const input=document.querySelector('.studio-color-input');input.showPicker=()=>{};document.querySelector('.studio-color-chip').click();input.value='#336699';input.dispatchEvent(new Event('input'));}""")
    check(code.input_value().split('\n')[0]=='vec3 a = vec3(0.2, 0.4, 0.6);','picked color is written as 0..1 values')
    js("""() => {const input=document.querySelector('.studio-color-input');input.value='#ff0000';input.dispatchEvent(new Event('input'));}""")
    check(code.input_value().split('\n')[0]=='vec3 a = vec3(1.0, 0.0, 0.0);','picking again updates the same literal')
    code.press('Control+z');check(code.input_value().split('\n')[0]=='vec3 a = vec3(1.0, 0.5, 0.0);','Undo restores the original color')

    # ---- 더블클릭 선택: 단어 뒤 공백 제외 (Windows Chrome·Edge의 기본 동작을 흉내 낸다) ----
    def dblclick_with(a,b):
        js("a=>{const e=document.getElementById('studioCode');e.focus();e.setSelectionRange(a[0],a[1]);e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));}",[a,b]);return pos()
    setup('float value = 1.0;',0)
    check(dblclick_with(6,12)==[6,11],'double-click drops the trailing space Windows adds to the word')
    check(dblclick_with(6,11)==[6,11],'double-click without extra space is unchanged')
    check(dblclick_with(5,6)==[5,6],'double-click on whitespace only keeps the selection')
    page.mouse.dblclick(*[v for v in js("() => {const r=document.getElementById('studioCode').getBoundingClientRect();return [r.left+12+7.2*8+3, r.top+12+8]}")])
    check(code.input_value()[slice(*pos())].strip()==code.input_value()[slice(*pos())],'a real double-click never ends with whitespace')
    # 두 번째 클릭의 mousedown에서 바로 단어만 고른다(공백이 잠깐 선택됐다가 바뀌는 깜빡임 없음).
    def second_mousedown(p):
        return js("p=>{const e=document.getElementById('studioCode');e.focus();e.setSelectionRange(p,p);const ev=new MouseEvent('mousedown',{bubbles:true,cancelable:true,detail:2,button:0});e.dispatchEvent(ev);return [ev.defaultPrevented,e.selectionStart,e.selectionEnd];}",p)
    setup('float value = 1.0;',0)
    check(second_mousedown(8)==[True,6,11],'second mousedown selects the word before the browser paints its own selection')
    check(second_mousedown(11)==[True,6,11],'caret just after the word still selects that word')
    check(second_mousedown(12)[0]==False,'double-click on spaces/punctuation is left to the browser')
    check(errors==[],f'no Chromium page exceptions: {errors}')
    print(f'PASS all {n[0]} editor power-feature checks')
    browser.close()
