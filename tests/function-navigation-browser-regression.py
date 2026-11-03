from esm_for_browser import load_modules
# python tests/function-navigation-browser-regression.py — Chromium DOM, GPU-independent.
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text();html=html[:html.index('    <!-- ES Modules:')]+'</body></html>'
source='''#version 300 es
precision highp float;
// float fakeLine(){return 1.;}
/* float fakeBlock(){return 2.;} { } */
#define BAD float fakeMacro(){return 3.;}
float overloaded(vec2 p){return p.x;}
float overloaded(float p){return p;}
float forward(float p);
struct Structure { float value; };
vec3 longFunc(
  vec3 pos,
  float t
){return pos+vec3(t);}
void main(){
  float x=overloaded(1.);
  if(x>0.){ x+=1.; }
}
#define CONTINUE \\
float fakeContinued(){return 1.;}
'''
other='''#version 300 es
precision highp float;
float onlyBuffer(){return 0.;}
void main(){}
'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH') or None,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900}); errors=[]
    page.on('pageerror',lambda error: errors.append(str(error)))
    page.set_content(html);page.add_style_tag(content=(root/'style.css').read_text())
    load_modules(page,root,['studio'])   # studio와 의존 모듈(code-editor, glsl-highlight, annotations)
    page.evaluate('''() => {
      const src="#version 300 es\\nprecision highp float;\\nvoid main(){}";
      const state={image:src,passes:[],imageChannels:{}};
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
      window.testRenderer=renderer;window.testStudio=TestStudio.mount(renderer,{fragment:src});testStudio.open();document.getElementById('studioLive').checked=false;
    }''')
    def check(condition,label):
        assert condition,label
        print('PASS',label,flush=True)
    options=page.locator('#studioFunctions option');code=page.locator('#studioCode')
    def labels():return options.all_text_contents()
    def at():return page.evaluate('document.getElementById("studioCode").selectionStart')
    def selected_line(n):page.locator('#studioFunctions').select_option(str(n))
    page.evaluate('([image,fragment])=>testStudio.setProject({image,passes:[{name:"A",fragment,format:"rgba8",scale:1,channels:{}}],imageChannels:{}})',[source,other])
    page.wait_for_function('document.querySelectorAll("#studioFunctions option").length===5')
    check(len(labels())==5 and labels()[0]=='ƒ 함수 (4)','four functions + placeholder')
    check(sum('overloaded(' in item for item in labels())==2,'function overloads listed independently')
    check(any('longFunc(' in item and 'Ln 10' in item for item in labels()),'multiline signature uses original line number')
    check(not any('fake' in item or 'forward' in item for item in labels()),'comments, macros and prototypes omitted')
    check(not any('value(' in item for item in labels()),'struct members omitted')
    prior_undo=page.locator("#studioUndo").is_disabled()
    selected_line(7)
    check(at()==source.index('float overloaded(float p)'), 'overload selection jumps to source definition')
    check(page.locator('#studioFunctions').input_value()=='','selection resets for repeat navigation')
    selected_line(7)
    check(at()==source.index('float overloaded(float p)'), 'same function can be selected again')
    selected_line(10)
    check(at()==source.index('vec3 longFunc('), 'multiline function jump uses type line')
    check(page.locator('#studioUndo').is_disabled()==prior_undo, 'navigation does not create an undo checkpoint')
    page.locator('#studioPassTabs button').nth(1).click()
    page.wait_for_function('document.querySelectorAll("#studioFunctions option").length===3')
    check('onlyBuffer(' in labels()[1] and not any('overloaded(' in s for s in labels()),'switching to Buffer updates list')
    selected_line(3)
    check(at()==other.index('float onlyBuffer()'), 'Buffer definition can be visited')
    page.locator('#studioPassTabs button').first.click()
    page.wait_for_function('document.querySelectorAll("#studioFunctions option").length===5')
    check('overloaded(' in labels()[1],'switching back restores Image entries')
    code.fill('#version 300 es\nprecision highp float;\nvoid main(){}')
    page.wait_for_function('document.querySelectorAll("#studioFunctions option").length===2')
    check(labels()[0]=='ƒ 함수 (1)' and 'main(' in labels()[1], 'typing refreshes list')
    page.locator('#studioUndo').click()
    page.wait_for_function('document.querySelectorAll("#studioFunctions option").length===5')
    check('overloaded(' in labels()[1], 'undo updates function list')
    page.locator('#studioRedo').click()
    page.wait_for_function('document.querySelectorAll("#studioFunctions option").length===2')
    check('main(' in labels()[1], 'redo updates function list')
    code.fill('#version 300 es\nprecision highp float;\nfloat f();')
    page.wait_for_function('document.querySelectorAll("#studioFunctions option").length===1')
    check(page.locator('#studioFunctions').is_disabled(), 'empty function list is disabled')
    check(errors==[],f'no Chromium page exceptions: {errors}')
    browser.close()
