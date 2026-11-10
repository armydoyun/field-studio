from esm_for_browser import load_modules
# python tests/examples-compile-browser-regression.py — 모든 예제·템플릿·코드 조각이 실제 WebGL2 GLSL 컴파일러를 통과하는지 (GPU 불필요)
#  · 갤러리: 카드를 하나씩 눌러 Studio가 받는 프로젝트(Image + Buffer 패스)를 그대로 모아 컴파일
#  · 입문 과정: 예제·풀이 셰이더와 생명 게임 프로젝트
#  · 코드 조각: plan()으로 모은 의존 조각과 함께, 전역 조각은 빈 main 옆에, main 조각은 main 안에, 패스 교체 조각은 단독으로
#  · 기본 장면·Ray Marching·버퍼 예제(Studio 소유)
#  · 코드 조각 미리보기: 가이드 카드에 붙는 그림 셰이더가 모두 컴파일되고 실제로 그려지는지
# 예전 실수 해시(Hoskins 0.1031 상수, fract(sin)) 가 예제에 남아 있지 않은지도 확인한다.
import os,re
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text();html=html[:html.index('    <!-- ES Modules:')]+'</body></html>'
COMPILE='''src => {
  const gl = (window.__gl ??= document.createElement("canvas").getContext("webgl2")); if(!gl) throw Error("WebGL2 unavailable");
  const s = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(s, src); gl.compileShader(s);
  const ok = gl.getShaderParameter(s, gl.COMPILE_STATUS), log = gl.getShaderInfoLog(s); gl.deleteShader(s); return ok ? "" : log;
}'''
# 코드 조각을 감싸는 공통 머리: 앱이 제공하는 Uniform과 main 조각이 흔히 쓰는 지역 변수(uv·p·col)를 준비한다.
HEAD='''#version 300 es
precision highp float;
precision highp int;
uniform vec2 uResolution;
uniform float uTime;
uniform float uDeltaTime;
uniform int uFrame;
uniform vec4 uMouse;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform vec3 iChannelResolution[4];
'''
# 조각이 '사용자가 만든다'고 약속하는 이름: 쓰는데 정의하지 않은 경우에만 대신 넣는다(레이마칭 장면 함수 등).
CONTRACT={'map':'float map(vec3 p) { return length(p) - 1.0; }\n','mapMat':'vec2 mapMat(vec3 p) { return vec2(length(p) - 1.0, 0.0); }\n','render':'vec3 render(vec2 c) { return vec3(c, 0.0); }\n'}
OLD_HASH=re.compile(r'0\.1031|fract\(\s*sin\s*\(')
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH') or None,
        args=['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    page=browser.new_page(viewport={'width':1280,'height':800});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content(html);load_modules(page,root,['shader','gallery','course','snippets','snippet-preview'])
    n=[0]
    def check(cond,label):
        assert cond,label;n[0]+=1;print('PASS',f'{n[0]:02d}',label,flush=True)
    compile_=lambda src:page.evaluate(COMPILE,src)
    def compile_all(named):
        failures=[f'{name}: {log.strip()[:300]}' for name,src in named if (log:=compile_(src))]
        return failures

    # ---- 갤러리: 카드를 눌러 Studio가 받는 프로젝트를 모은다 ----
    page.evaluate('''() => {
      const M = __testModules, picked = [];
      const record = project => { picked.push(project); return true; };
      const shader = M.shader;
      const studio = {open(){}, loadExample:(project) => record(project),
        exampleRaymarch:() => record({image:shader.raymarch, passes:[], imageChannels:{}, studioOwned:"raymarch"}),
        examplePipeline:() => record({studioOwned:"pipeline"}), exampleFeedback:() => record({studioOwned:"feedback"})};
      window.picked = picked; M.gallery.mount({studio, Shader:shader});
    }''')
    cards=page.evaluate('() => [...document.querySelectorAll("#galleryGrid .gallery-card, #galleryCommunity .gallery-card, #galleryLessons .gallery-card")].map(c => c.dataset.id)')
    for id in cards: page.evaluate('async id => { await document.querySelector(`.gallery-card[data-id="${id}"]`).click(); }',id)
    projects=page.evaluate('() => picked')
    check(len(projects)==len(cards) and len(cards)>=12,f'every gallery card hands a project to Studio ({len(cards)} cards)')
    sources=[]
    for id,proj in zip(cards,projects):
        if proj.get('studioOwned') in ('pipeline','feedback'):continue   # Studio 소유 예제는 아래에서 Studio 소스로 확인
        sources.append((f'gallery {id} · Image',proj['image']))
        sources+= [(f'gallery {id} · Buffer {pass_["name"]}',pass_['fragment']) for pass_ in proj['passes']]
    failures=compile_all(sources)
    check(not failures,f'all {len(sources)} gallery shaders compile: {failures}')
    # Hash Precision 레슨은 비교를 위해 예전 실수 해시를 일부러 담고 있다.
    stale=[name for name,src in sources if OLD_HASH.search(src) and not name.startswith('gallery hashprecision')]
    check(not stale,f'no gallery shader uses the old float hash (except the comparison lesson): {stale}')

    # ---- Studio 소유 예제: 기본 장면 · Ray Marching · 버퍼 예제(studio-examples.js의 문자열) ----
    studio_js=(root/'js/studio-examples.js').read_text()
    shader=page.evaluate('() => ({fragment:__testModules.shader.fragment, raymarch:__testModules.shader.raymarch})')
    owned=[('default scene',shader['fragment']),('ray marching',shader['raymarch'])]
    owned+=[(f'studio-examples.js {name}',src) for name,src in re.findall(r'const (\w+)\s*=\s*`(#version 300 es[\s\S]*?)`;',studio_js)]
    failures=compile_all(owned)
    check(len(owned)>=7 and not failures,f'default scene, Ray Marching and Studio buffer examples compile ({len(owned)}): {failures}')

    # ---- 입문 과정 ----
    course=page.evaluate('''() => { const C = __testModules.course, out = [];
      for(const lesson of C.LESSONS) for(const block of lesson.blocks || []) for(const key of ["code","solution"])
        if(typeof block[key] === "string" && block[key].startsWith("#version")) out.push([`course ${lesson.id} · ${block.title || key}`, block[key]]);
      for(const [name, project] of Object.entries(C.PROJECTS)) { out.push([`course project ${name} · Image`, project.image]); for(const pass of project.passes) out.push([`course project ${name} · Buffer ${pass.name}`, pass.fragment]); }
      return out; }''')
    failures=compile_all(course)
    check(len(course)>=15 and not failures,f'all {len(course)} course shaders compile: {failures}')
    stale=[name for name,src in course if OLD_HASH.search(src)]
    check(not stale,f'no course shader uses the old float hash: {stale}')

    # ---- 코드 조각 ----
    items=page.evaluate('''() => { const S = __testModules.snippets;
      return S.ALL.map(item => { const plan = S.plan(item.id, ""); return {id:item.id, category:item.category, replace:!!item.replace, scope:item.scope || "global",
        globals:plan.globals.filter(g => g !== plan.target || item.scope !== "main").map(g => g.code).join("\\n\\n"), main:plan.mainCode || "", code:item.code}; }); }''')
    snippet_sources=[]
    for item in items:
        if item['replace']:snippet_sources.append((f"snippet {item['id']} (pass template)",item['code']));continue
        code=item['globals']+item['main']
        stubs=''.join(stub for name,stub in CONTRACT.items() if re.search(rf'\b{name}\s*\(',code) and not re.search(rf'\b(?:float|vec2)\s+{name}\s*\(',code))
        # MRT 출력 조각은 자기 출력을 선언하므로 fragColor를 따로 두지 않는다.
        out='' if 'layout(location' in code else 'out vec4 fragColor;\n'
        write='' if out=='' else '    fragColor = vec4(0.0);\n'
        # main 조각은 안쪽 블록에 넣어, 조각이 uv 같은 지역 변수를 다시 선언해도 되게 한다(바깥 것은 흔히 쓰는 입력).
        body='    {\n'+item['main']+'\n    }\n' if item['scope']=='main' else ''
        snippet_sources.append((f"snippet {item['id']}",HEAD+out+stubs+item['globals']+'\nvoid main() {\n    vec2 uv = gl_FragCoord.xy / uResolution, p = uv;\n    vec3 col = vec3(0.0), color = col;\n    vec4 newColor = vec4(0.0);\n'+write+body+'}\n'))
    failures=compile_all(snippet_sources)
    check(len(snippet_sources)==len(items) and not failures,f'all {len(items)} snippets compile with their dependencies: {failures}')
    users=[i['id'] for i in items if i['category'] not in ('hash',) and re.search(r'(?<![\w.])hash(11|21|22|13|33|31|32)\s*\(',i['code'])]
    check(not users,f'no snippet outside the float-hash category calls the old float hashes: {users}')

    # ---- 코드 조각 미리보기 ----
    preview=page.evaluate('''() => { const S = __testModules.snippets, P = __testModules["snippet-preview"], ids = new Set(S.ALL.map(i => i.id));
      const keys = Object.keys(P.PREVIEWS), unknown = keys.filter(id => !ids.has(id)), failures = [];
      for(const id of keys) { const log = (() => { const src = P.source(S.ALL.find(i => i.id === id), S.plan); const gl = window.__gl ??= document.createElement("canvas").getContext("webgl2");
        const sh = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(sh, src); gl.compileShader(sh); const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS), info = gl.getShaderInfoLog(sh); gl.deleteShader(sh); return ok ? "" : info; })();
        if(log) failures.push(`${id}: ${log.slice(0, 200)}`); }
      // 렌더러로 실제로 그려 보고, 한 가지 색으로만 칠해진(=사실상 실패한) 그림이 없는지 본다.
      const pv = P.create({plan:S.plan}), flat = [];
      for(const id of keys) { const c = pv.render(S.ALL.find(i => i.id === id)); if(!c) { flat.push(id + " (no image)"); continue; }
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let min = 255, max = 0; for(let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; if(v < min) min = v; if(v > max) max = v; }
        if(max - min < 24) flat.push(id); }
      pv.dispose(); return {count:keys.length, unknown, failures, flat}; }''')
    check(not preview['unknown'],f"every preview belongs to an existing snippet: {preview['unknown']}")
    check(preview['count']>=140 and not preview['failures'],f"all {preview['count']} snippet previews compile: {preview['failures']}")
    check(not preview['flat'],f"every preview draws a picture, not a flat colour: {preview['flat']}")
    check(errors==[],f'no page exceptions: {errors}')
    print(f'PASS all {n[0]} example compile checks')
    browser.close()
