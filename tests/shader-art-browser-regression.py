from esm_for_browser import mock_module
# python tests/shader-art-browser-regression.py — Chromium DOM validation without GPU or server.
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text().split('    <!-- 외부 라이브러리')[0]+'</body></html>'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900}); errors=[]; count=[0]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content(html);page.add_style_tag(content=(root/'style.css').read_text())
    page.evaluate('''() => window.define=(deps,factory)=>{
      if(!deps.length){const m=factory();if(m.raymarch)window.TestShader=m;else window.TestEditor=m;}
      else if(deps[0]==="code-editor")window.TestStudio=factory(window.TestEditor);
    }''')
    for file in ['shader','code-editor','studio']:page.add_script_tag(content=mock_module((root/'js'/f'{file}.js').read_text()))
    page.evaluate('''() => {
      const Shader=window.TestShader;
      const state={image:Shader.fragment,passes:[],imageChannels:{}}, uniforms=new Map();
      window.testRenderer={
        getFragmentSource:()=>state.image,getPassDefinitions:()=>structuredClone(state.passes),getImageChannels:()=>structuredClone(state.imageChannels),
        getPasses:()=>state.passes.map(p=>({name:p.name})),getTextures:()=>[],getStats:()=>({running:false}),setPreviewPass:()=>{},
        validatePassConfiguration:()=>true,validateFragment:src=>{if(src.includes('INVALID_GLSL'))throw Error('GLSL failure');return true;},
        setFragment:src=>state.image=src,setPasses:(passes,channels)=>{state.passes=structuredClone(passes);state.imageChannels=structuredClone(channels);},
        setImageChannels:x=>state.imageChannels=structuredClone(x),setPassFragment:(name,src)=>state.passes.find(p=>p.name===name).fragment=src,
        setPassChannels:(name,channels)=>state.passes.find(p=>p.name===name).channels=structuredClone(channels),resetSimulation:()=>{},
        getUserUniforms:()=>[...uniforms].map(([name,u])=>({name,...u})),
        getUniforms:()=>[...uniforms].map(([name,u])=>({name,...u})),
        defineUniform:(name,type,value,options)=>{if(name===window.failUniform)throw Error('injected uniform failure');if(uniforms.has(name))throw Error('duplicate');uniforms.set(name,{type,value,options});},
        applyPortable:(scene,items)=>{for(const u of items)if(u.name===window.failUniform)throw Error('injected uniform failure');
          uniforms.clear();for(const {name,...u} of items)uniforms.set(name,u);
          state.image=scene.image;state.passes=structuredClone(scene.passes);state.imageChannels=structuredClone(scene.imageChannels);return true;},
        removeUniform:name=>uniforms.delete(name),setUniform:(name,value)=>{uniforms.get(name).value=value;},
      };
      testRenderer.applyProject=scene=>{
        for(const [name,source] of [["Image",scene.image],...scene.passes.map(p=>[p.name,p.fragment])]) {
          try{testRenderer.validateFragment(source);}catch(error){error.passName=name;throw error;}
        }
        testRenderer.validatePassConfiguration(scene.passes,scene.imageChannels);
        testRenderer.setPasses(scene.passes,scene.imageChannels);testRenderer.setFragment(scene.image);return true;
      };
      window.testStudio=TestStudio.mount(testRenderer,Shader);testStudio.open();document.getElementById('studioLive').checked=false;
    }''')
    def check(condition,label):
        assert condition,label;count[0]+=1;print('PASS',f'{count[0]:02d}',label,flush=True)
    check(page.evaluate('TestShader.fragment.includes("uMouse") && !TestShader.fragment.includes("SDFResult")'),'generic procedural default source')
    check(not page.locator('#rayMaxSteps').count() and not page.locator('#debugHeatmap').count(),'ray-only Render controls removed')
    check(page.locator('#studioExampleRaymarch').count()==1 and page.locator('#studioExampleFeedback').count()==1,'starter buttons retained')
    check(page.evaluate('testStudio.getProject().image===TestShader.fragment'),'Studio begins with generic Image')
    page.locator('#studioStarters > summary').click()
    page.locator('#studioExampleRaymarch').click();page.wait_for_timeout(160)
    check(page.evaluate('testStudio.getProject().image===TestShader.raymarch'),'Ray Starter installs SDF source')
    check(page.evaluate('testStudio.getProject().passes.length===0'),'Ray Starter clears old passes')
    check(page.evaluate('TestShader.rayUniforms.every(([name,type])=>testRenderer.getUserUniforms().some(u=>u.name===name&&u.type===type))'),'all 6 Ray parameters created with correct types')
    check(page.evaluate('testRenderer.getUserUniforms().find(u=>u.name==="uRMMaxSteps").options.max===512'),'Ray parameter slider metadata')
    page.evaluate('testRenderer.setUniform("uRMHeatmap",true)')
    check(page.evaluate('testRenderer.getUserUniforms().find(u=>u.name==="uRMHeatmap").value===true'),'Ray debug parameter editable')
    page.locator('#studioExampleRaymarch').click();page.wait_for_timeout(160)
    check(page.evaluate('testRenderer.getUserUniforms().length===6'),'reapplying Starter does not duplicate Uniforms')
    page.evaluate('testStudio.setProject({image:TestShader.fragment,passes:[],imageChannels:{}})')
    check(page.evaluate('testStudio.getProject().image===TestShader.fragment'),'return to general Shader Art')
    page.evaluate('''() => {for(const u of testRenderer.getUserUniforms())testRenderer.removeUniform(u.name);window.failUniform="uRMNormalEpsilon";}''')
    page.locator('#studioExampleRaymarch').click();page.wait_for_timeout(160)
    check(page.evaluate('testStudio.getProject().image===TestShader.fragment'),'failed preset leaves previous project unchanged')
    check(page.evaluate('testRenderer.getUserUniforms().length===0'),'failed preset removes partially created Uniforms')
    check(not errors,f'no Chromium exceptions: {errors}')
    print(f'PASS {count[0]} starter UI checks',flush=True);browser.close()
