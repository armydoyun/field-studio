from esm_for_browser import load_modules
# python tests/snippet-range-browser-regression.py — 노이즈 조각의 실제 출력 범위가 설명(desc)에 적힌 범위와 맞는지
# 512×512 점(약 4,000칸에 걸친 좌표)을 RGBA32F로 그려 최솟값·최댓값과 0.1%·99.9% 백분위를 잰다.
#   hard = 절대 넘으면 안 되는 범위(설명의 '0~1' 같은 약속), typical = 설명의 '대부분 …' 범위(99.8% 구간이 이 안).
#   설명의 숫자는 0.05 단위로 반올림하므로 typical은 ±0.03까지 허용한다.
# 설명의 숫자를 바꾸면 여기 기대값도 함께 고친다. GPU 없이 SwiftShader로 돈다.
import os,re
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
#   id: (식, hard 범위, typical 범위, 설명에 들어 있어야 할 문구)
EXPECT={
  'noise1D':       ('noise1D(p.x * 3.1 + p.y * 17.0)', (0.0, 1.0),  None,           '0~1'),
  'valueNoise':    ('valueNoise(p)',                   (0.0, 1.0),  None,           '0~1'),
  'tileableNoise': ('tileableNoise(p, vec2(8.0))',     (0.0, 1.0),  None,           None),
  'gradientNoise': ('gradientNoise(p)',                (-1.1, 1.1), (-0.75, 0.75),  '-0.75~0.75'),
  'simplex':       ('simplexNoise(p)',                 (-1.05, 1.05), None,         '-1~1'),
  'fbm':           ('fbm(p)',                          (0.0, 1.0),  (0.15, 0.85),   '0.15~0.85'),
  'fbmGradient':   ('fbmGradient(p)',                  (-0.7, 0.7), (-0.45, 0.45),  '-0.45~0.45'),
  'turbulence':    ('turbulence(p)',                   (0.0, 0.8),  (0.0, 0.5),     '0~0.5'),
  'ridged':        ('ridgedFbm(p)',                    (0.0, 1.0),  (0.25, 0.9),    '0.25~0.9'),
  'domainWarp':    ('domainWarp(p, 1.0)',              (0.0, 1.0),  (0.15, 0.8),    '0.15~0.8'),
  'curlNoise':     ('length(curlNoise(p))',            (0.0, 3.5),  (0.0, 2.5),     '0~2.5'),
  'valueNoise3':   ('valueNoise3(q)',                  (0.0, 1.0),  None,           '0~1'),
  'gradientNoise3':('gradientNoise3(q)',               (-1.0, 1.0), (-0.65, 0.65),  '-0.65~0.65'),
  'simplex3':      ('simplexNoise3(q)',                (-1.1, 1.1), None,           '-1~1'),
  'fbm3':          ('fbm3(q)',                         (0.0, 1.0),  (0.2, 0.8),     '0.2~0.8'),
  'fbm3Simplex':   ('fbm3Simplex(q)',                  (-0.8, 0.8), (-0.6, 0.6),    '-0.6~0.6'),
  'ridged3':       ('ridgedFbm3(q)',                   (0.0, 1.0),  (0.3, 0.9),     '0.3~0.9'),
  'turbulence3':   ('turbulence3(q)',                  (0.0, 0.7),  (0.0, 0.45),    '0~0.45'),
  'domainWarp3':   ('domainWarp3(q, 1.0)',             (0.0, 1.0),  (0.2, 0.8),     '0.2~0.8'),
}
MEASURE='''([code, expr]) => {
  const N = 512, gl = (window.__gl ??= document.createElement("canvas").getContext("webgl2"));
  if(!gl || !gl.getExtension("EXT_color_buffer_float")) throw Error("WebGL2 float render target unavailable");
  const fs = `#version 300 es\\nprecision highp float;\\nprecision highp int;\\nout vec4 o;\\n${code}\\n` +
    `void main() { vec2 p = gl_FragCoord.xy / 8.0 + vec2(13.7, -41.3); vec3 q = vec3(p, 0.37 * gl_FragCoord.x / 8.0 - 11.1 + p.y * 0.61); o = vec4(${expr}, 0.0, 0.0, 1.0); }`;
  const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram(); gl.attachShader(prog, shader(gl.VERTEX_SHADER, "#version 300 es\\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0.0,1.0);}"));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog); gl.useProgram(prog);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, N, N);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, N, N); gl.bindVertexArray(gl.createVertexArray()); gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Float32Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, px);
  const v = new Float32Array(N * N); for(let i = 0; i < N * N; i++) v[i] = px[i * 4]; v.sort();
  gl.deleteFramebuffer(fb); gl.deleteTexture(tex); gl.deleteProgram(prog);
  return {min:v[0], max:v[v.length - 1], lo:v[Math.floor(v.length * 0.001)], hi:v[Math.floor(v.length * 0.999)]};
}'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH') or None,
        args=['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    page=browser.new_page();page.set_content('<!doctype html><body></body>');errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    load_modules(page,root,['snippets'])
    n=[0]
    def check(cond,label):
        assert cond,label;n[0]+=1;print('PASS',f'{n[0]:02d}',label,flush=True)
    for id,(expr,hard,typical,phrase) in EXPECT.items():
        item=page.evaluate('id => { const S = __testModules.snippets, i = S.ALL.find(x => x.id === id); return i && {desc:i.desc, code:S.plan(id, "").globals.map(g => g.code).join("\\n\\n")}; }',id)
        assert item,f'missing snippet {id}'
        r=page.evaluate(MEASURE,[item['code'],expr])
        ok=hard[0]-1e-4<=r['min'] and r['max']<=hard[1]+1e-4 and (typical is None or (typical[0]-0.03<=r['lo'] and r['hi']<=typical[1]+0.03))
        stated=phrase is None or phrase in item['desc']
        check(ok and stated,f"{id}: measured {r['min']:+.3f}..{r['max']:+.3f} (99.8% {r['lo']:+.3f}..{r['hi']:+.3f}) matches '{phrase or hard}' in its description")
    check(errors==[],f'no page exceptions: {errors}')
    print(f'PASS all {n[0]} snippet range checks')
    browser.close()
