from esm_for_browser import mock_module
# python tests/compiler-lines-browser-regression.py — Chromium DOM test with a mock renderer, no GPU required.
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text();html=html[:html.index('    <!-- ES Modules:')]+'</body></html>'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900});errors=[]
    page.on('pageerror',lambda error: errors.append(str(error)))
    page.set_content(html);page.add_style_tag(content=(root/'style.css').read_text())
    page.evaluate('''() => window.define=(deps,factory)=>{if(!deps.length)window.TestEditor=factory();else if(deps[0]==="code-editor")window.TestStudio=factory(window.TestEditor);}''')
    page.add_script_tag(content=mock_module((root/'js/code-editor.js').read_text()));page.add_script_tag(content=mock_module((root/'js/studio.js').read_text()))
    page.evaluate('''() => {
      const good="#version 300 es\\nprecision highp float;\\nout vec4 fragColor;\\nvoid main(){fragColor=vec4(1.);}";
      const state={image:good,passes:[],imageChannels:{}};
      const renderer={getUserUniforms:()=>[],getFragmentSource:()=>state.image,getPassDefinitions:()=>structuredClone(state.passes),getImageChannels:()=>structuredClone(state.imageChannels),
        getPasses:()=>state.passes.map(p=>({name:p.name})),getTextures:()=>[],getStats:()=>({running:false}),setPreviewPass:()=>{},
        validatePassConfiguration:()=>{},validateFragment:src=>{if(!src.includes('SYNTAX'))return true;
          const generated=src.includes('SYNTAX_AUTO'),original=src.includes('SYNTAX_PLAIN')?4:generated?3:6;
          const error=new Error(`Fragment Shader 컴파일 실패:\\nERROR: 0:${original}: test diagnostic`);
          if(!src.includes('SYNTAX_PLAIN'))error.glslInjected={after:2,count:2};throw error;},
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
      window.testStudio=TestStudio.mount(renderer,{fragment:good});testStudio.open();document.getElementById('studioLive').checked=false;
    }''')
    area=page.locator('#studioCode');diag=page.locator('#studioDiagnostics button')
    def check(condition,label):
        assert condition,label
        print('PASS',label,flush=True)
    def run_case(token):
        source=f'#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){{{token};}}'
        area.fill(source);page.locator('#studioRun').click();return source
    src=run_case('SYNTAX_SHIFT')
    check(diag.count()==1 and diag.first.inner_text().startswith('Line 4 ·'),'injected Uniform line maps to original line 4')
    diag.first.click();pos=page.evaluate('document.getElementById("studioCode").selectionStart')
    check(pos==src.index('void main()'),'click jumps to the actual source line')
    run_case('SYNTAX_AUTO')
    check(diag.count()==1 and diag.first.inner_text().startswith('Auto Uniform ·') and diag.first.is_disabled(),'generated Uniform has no invalid jump target')
    src=run_case('SYNTAX_PLAIN')
    check(diag.first.inner_text().startswith('Line 4 ·') and not diag.first.is_disabled(),'without injection original line is unchanged')
    diag.first.click();pos=page.evaluate('document.getElementById("studioCode").selectionStart')
    check(pos==src.index('void main()'),'unshifted diagnostic navigates normally')
    check(errors==[],f'no Chromium page exceptions: {errors}')
    browser.close()
