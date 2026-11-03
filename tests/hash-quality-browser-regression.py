from esm_for_browser import load_modules
# python tests/hash-quality-browser-regression.py — 해시 코드 조각을 WebGL2에서 실제로 컴파일하고 분포를 잰다.
# 512×512 셀(정수 좌표 + 오프셋 0 ~ 1천만)마다 해시 값을 8비트로 받아 다음을 확인한다:
#   · 히스토그램 카이제곱(256칸, 자유도 255 → 기대 255 ± 23) — 편향
#   · 이웃 셀 상관(가로·세로·대각선, 거리 1·2·4·8·16) — 줄무늬·격자 패턴
#   · 2D 파워 스펙트럼의 최대 봉우리 / 평균 — 멀리 떨어진 주기 무늬(백색 잡음이면 약 12~16)
#   · 벡터 출력의 성분 간 상관 — 두 값이 서로 독립인지
# GPU가 없어도 Chromium의 SwiftShader(소프트웨어 WebGL2)로 돈다.
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
OFFSETS=[0,1e5,1e6,1e7]
CHI_MAX,CORR_MAX,PEAK_MAX=360,0.02,30   # 카이제곱: 기대값 + 약 4.6σ · 상관: 무작위 표본 오차(약 0.002)의 10배
# 조각 id → 셀 좌표 c(vec2, 정수값)와 1D 번호 i1(float)로 값 두 개(x, y)를 만드는 식. 스칼라는 두 성분에 같은 값.
CASES={
  'uhash11':'vec2(uhash11(i1))',
  'uhash21':'vec2(uhash21(c))',
  'uhash22':'uhash22(c)',
  'uhash13':'vec2(uhash13(vec3(c, 7.0)))',
  'uhash33':'uhash33(vec3(c, 7.0)).xz',
  'lowbias32':'vec2(float(lowbias32(uint(i1)) >> 8u) / 16777216.0)',
  'pcg3d':'vec2(pcg3d(uvec3(ivec2(c), 7)).yz >> 8u) / 16777216.0',
  'pcg4d':'vec2(pcg4d(uvec4(ivec2(c), 3, 9)).xw >> 8u) / 16777216.0',
  'xxhash32':'vec2(float(xxhash32(uvec3(ivec2(c), 5)) >> 8u) / 16777216.0)',
  'pcg':'vec2(randPCG(uvec2(ivec2(c)), 0u))',
}
MEASURE='''([globals,expr,offsets]) => {
  const N=512,canvas=document.createElement('canvas');canvas.width=canvas.height=N;
  const gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true});if(!gl)throw Error('WebGL2 unavailable');
  const fs=`#version 300 es\\nprecision highp float;\\nprecision highp int;\\nuniform vec2 uOff;\\nout vec4 fragColor;\\n${globals}\\n`+
    `void main() {\\n    vec2 l = floor(gl_FragCoord.xy), c = l + uOff;\\n    float i1 = uOff.x + l.x + l.y * 512.0;\\n    vec2 v = ${expr};\\n`+
    `    fragColor = vec4(min(floor(v * 256.0), 255.0) / 255.0, 0.0, 1.0);\\n}`;
  const shader=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error('compile: '+gl.getShaderInfoLog(s));return s;};
  const prog=gl.createProgram();gl.attachShader(prog,shader(gl.VERTEX_SHADER,'#version 300 es\\nin vec2 a;void main(){gl_Position=vec4(a,0,1);}'));
  gl.attachShader(prog,shader(gl.FRAGMENT_SHADER,fs));gl.linkProgram(prog);if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw Error('link: '+gl.getProgramInfoLog(prog));
  gl.useProgram(prog);gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  const stats=values=>{const mean=values.reduce((a,b)=>a+b,0)/values.length,variance=values.reduce((a,b)=>a+(b-mean)**2,0)/values.length;return {mean,variance};};
  return offsets.map(off=>{
    gl.uniform2f(gl.getUniformLocation(prog,'uOff'),off,off);gl.drawArrays(gl.TRIANGLES,0,3);
    const px=new Uint8Array(N*N*4);gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px);
    const x=new Float64Array(N*N),y=new Float64Array(N*N);for(let i=0;i<N*N;i++){x[i]=px[i*4];y[i]=px[i*4+1];}
    const hist=new Float64Array(256);for(const v of x)hist[v]++;const e=N*N/256;let chi=0;for(const k of hist)chi+=(k-e)**2/e;
    const sx=stats(x),sy=stats(y);let corr=0;
    for(const [dx,dy] of [[1,0],[0,1],[1,1],[2,0],[0,2],[4,0],[8,0],[16,0],[0,16]]){let s=0,n=0;
      for(let r=0;r+dy<N;r++)for(let q=0;q+dx<N;q++){s+=(x[r*N+q]-sx.mean)*(x[(r+dy)*N+q+dx]-sx.mean);n++;}corr=Math.max(corr,Math.abs(s/n/sx.variance));}
    // 2D FFT(행 → 열, 기수 2)로 파워 스펙트럼의 최대값 / 평균을 구한다. 주기 무늬가 있으면 특정 주파수가 튄다.
    const re=Float64Array.from(x,v=>v-sx.mean),im=new Float64Array(N*N);
    const fft=(off,stride)=>{for(let i=1,j=0;i<N;i++){let b=N>>1;for(;j&b;b>>=1)j^=b;j^=b;if(i<j){const a=off+i*stride,c=off+j*stride;[re[a],re[c]]=[re[c],re[a]];[im[a],im[c]]=[im[c],im[a]];}}
      for(let len=2;len<=N;len<<=1){const ang=-2*Math.PI/len,wr=Math.cos(ang),wi=Math.sin(ang);
        for(let i=0;i<N;i+=len){let cr=1,ci=0;for(let k=0;k<len/2;k++){const a=off+(i+k)*stride,b=off+(i+k+len/2)*stride;
          const tr=re[b]*cr-im[b]*ci,ti=re[b]*ci+im[b]*cr;re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;const nr=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=nr;}}}};
    for(let r=0;r<N;r++)fft(r*N,1);for(let q=0;q<N;q++)fft(q,N);
    let peak=0,total=0;for(let i=1;i<N*N;i++){const pw=re[i]**2+im[i]**2;total+=pw;if(pw>peak)peak=pw;}
    let xy=0;for(let i=0;i<N*N;i++)xy+=(x[i]-sx.mean)*(y[i]-sy.mean);xy=Math.abs(xy/(N*N)/Math.sqrt(sx.variance*sy.variance));
    return {off,mean:sx.mean/255,chi,corr,xy,peak:peak/(total/(N*N-1))};
  });
}'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH') or None,
        args=['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    page=browser.new_page();page.set_content('<!doctype html><body></body>');errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    load_modules(page,root,['snippets'])
    n=[0]
    def check(cond,label):
        assert cond,label;n[0]+=1;print('PASS',f'{n[0]:02d}',label,flush=True)
    # 코드 조각이 삽입될 때와 같은 코드(의존 조각 포함)를 plan()으로 모은다.
    globals_of=lambda id:page.evaluate('id => __testModules.snippets.plan(id, "").globals.map(item => item.code).join("\\n\\n")',id)
    ids=page.evaluate('() => __testModules.snippets.CATEGORIES.filter(c => c.id === "hash" || c.id === "hashInt").flatMap(c => c.items.map(i => i.id))')
    check(set(CASES) <= set(ids),'every measured hash is in the hash categories')
    # 해시 두 범주의 모든 전역 조각은 의존 조각과 함께 단독으로 컴파일된다.
    for id in ids:
        code=globals_of(id)
        if not code.strip():continue
        page.evaluate(MEASURE,[code,'vec2(0.0)',[0]])
    check(True,f'all {len(ids)} hash snippets compile with their dependencies in WebGL2')
    page.evaluate(MEASURE,[globals_of('noise1D'),'vec2(noise1D(i1 * 0.37))',[0]])
    check(True,'noise1D compiles on top of uhash11')
    # uintToUnit: 가장 큰 uint도 1.0 미만(나눗셈 float(x) / 4294967295.0은 반올림으로 정확히 1.0이 된다).
    edge=page.evaluate(MEASURE,[globals_of('uintToUnit'),'vec2(uintToUnit(0xFFFFFFFFu) < 1.0 ? 0.0 : 1.0, float(0xFFFFFFFFu) / 4294967295.0 >= 1.0 ? 0.0 : 1.0)',[0]])[0]
    check(edge['mean']==0,'uintToUnit never reaches 1.0 (the old division does)')
    for id,expr in CASES.items():
        results=page.evaluate(MEASURE,[globals_of(id),expr,OFFSETS])
        worst=max(results,key=lambda r:r['chi'])
        ok=all(r['chi']<CHI_MAX and r['corr']<CORR_MAX and r['peak']<PEAK_MAX and abs(r['mean']-0.5)<0.01 and (r['xy']<CORR_MAX or r['xy']>0.999) for r in results)
        detail=' · '.join(f"{r['off']:g}: χ²{r['chi']:.0f} r{r['corr']:.3f} peak{r['peak']:.0f}" for r in results)
        check(ok,f'{id} is uniform and pattern-free up to 10,000,000 ({detail})')
    # 같은 기준이 기존 실수 해시의 큰 좌표 문제를 실제로 잡아내는지(검사 자체의 민감도) 확인한다.
    old=page.evaluate(MEASURE,[globals_of('hash21'),'vec2(hash21(c))',[1e6,1e7]])
    check(all(r['chi']>CHI_MAX and r['peak']>PEAK_MAX for r in old),f"the same thresholds flag float hash21 at large coordinates ({' · '.join(f"{r['off']:g}: χ²{r['chi']:.0f} peak{r['peak']:.0f}" for r in old)})")
    check(errors==[],f'no page exceptions: {errors}')
    print(f'PASS all {n[0]} hash quality checks')
    browser.close()
