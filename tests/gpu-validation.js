// 브라우저 실GPU 통합 검사. 앱 소스와 실제 IndexedDB를 수정하지 않는다.
(() => {
  "use strict";
  const $ = id => document.getElementById(id), results = [], list = $("results"), canvas = $("probe");
  const near = (actual, expected, error = 2) => Math.abs(actual - expected) <= error;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const equalPixel = (actual, expected, name, tolerance = 2) => {
    assert(expected.every((value, i) => near(actual[i], value, tolerance)), `${name}: expected ${expected}, actual ${actual}`);
  };
  const header = `#version 300 es\nprecision highp float;\nuniform vec2 uResolution;\nuniform int uFrame;\nuniform vec2 uMouse;\nuniform sampler2D iChannel0;\nuniform sampler2D iChannel1;\nuniform sampler2D iChannel2;\nuniform sampler2D iChannel3;\nuniform vec3 iChannelResolution[4];\nout vec4 fragColor;\n`;
  const frag = code => header + `void main(){${code}}`;
  const red = frag("fragColor=vec4(1.,0.,0.,1.);");
  const green = frag("fragColor=vec4(0.,1.,0.,1.);");
  const blue = frag("fragColor=vec4(0.,0.,1.,1.);");
  const copy = frag("fragColor=texture(iChannel0,gl_FragCoord.xy/uResolution);");
  const pass = (name, fragment, channels = {}, format = "rgba8", scale = 1) => ({name, fragment, format, scale, channels});
  const waitEvent = (target, type, ms = 9000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {target.removeEventListener(type, onEvent); reject(new Error(`${type}: ${ms}ms timeout`));}, ms);
    const onEvent = event => {clearTimeout(timer); resolve(event);}; target.addEventListener(type, onEvent, {once:true});
  });
  const register = (status, name, detail = "") => {
    results.push({status, name, detail}); const item = document.createElement("li");
    item.className = status.toLowerCase(); item.textContent = detail ? `${name} — ${detail}` : name; list.append(item);
    updateReport();
  };
  const updateReport = () => {
    const counts = type => results.filter(x => x.status === type).length;
    const summary = `PASS ${counts("PASS")} / FAIL ${counts("FAIL")} / SKIP ${counts("SKIP")}`;
    $("summary").textContent = summary;
    $("report").value = ["Shader Studio GPU Validation", new Date().toISOString(), $("environment").textContent, summary,
      ...results.map(x => `${x.status.padEnd(4)} | ${x.name}${x.detail ? ` | ${x.detail}` : ""}`)].join("\n");
  };
  const test = async (name, fn) => {
    let timer, timedOut = false;
    try {
      await Promise.race([fn(), new Promise((_, reject) => {timer = setTimeout(() => {timedOut=true;reject(new Error("15s timeout"));}, 15000);})]);
      register("PASS", name);
    } catch (error) {register("FAIL", name, error?.message || String(error)); console.error(`[GPU TEST] ${name}`, error);}
    finally {clearTimeout(timer);}
    if(timedOut) throw new Error(`${name}: 시간 초과로 후속 검사 중단`);
  };
  const skip = (name, why) => register("SKIP", name, why);
  const makePNG = (paint, size = 4) => new Promise((resolve, reject) => {
    const sample = document.createElement("canvas"); sample.width = sample.height = size;
    paint(sample.getContext("2d"), size); sample.toBlob(blob => blob ? resolve(new File([blob], `gpu-check-${Date.now()}.png`, {type:"image/png"})) : reject(new Error("PNG 인코딩 실패")), "image/png");
  });
  const inspectPNG = async blob => {
    assert(blob?.type === "image/png" && blob.size > 0, "PNG 출력이 없습니다");
    const bitmap = await createImageBitmap(blob), tmp = document.createElement("canvas");
    try {
      tmp.width = bitmap.width; tmp.height = bitmap.height; const ctx = tmp.getContext("2d", {willReadFrequently:true});
      ctx.drawImage(bitmap, 0, 0); return {width:tmp.width, height:tmp.height,
        pixel:(x, y) => [...ctx.getImageData(x, y, 1, 1).data]};
    } finally {bitmap.close();}
  };
  // 실제 IndexedDB를 사용하지 않는 최소한의 메모리 저장소 (GPU 테스트 전용).
  // TextureInput의 put/getAll/delete 비동기 경로를 보존하고 사용자 DB는 건드리지 않는다.
  const memoryIndexedDB = () => {
    const records = new Map();
    const db = {createObjectStore:() => {}, close:() => {}, transaction:() => {
      const tx = {oncomplete:null,onerror:null,onabort:null};
      const run = fn => {const request = {result:undefined}; queueMicrotask(() => {
        try {request.result = fn();tx.oncomplete?.();} catch(error) {tx.error=error;tx.onerror?.();}
      });return request;};
      tx.objectStore = () => ({put:item => run(() => (records.set(item.id,item),item.id)),
        delete:id => run(() => records.delete(id)),getAll:() => run(() => [...records.values()])});
      return tx;
    }};
    return {open:() => {const request = {result:db};queueMicrotask(() => {request.onupgradeneeded?.();request.onsuccess?.();});return request;}};
  };
  const main = async () => {
    $("run").disabled = true; $("copy").disabled = true; results.length = 0; list.replaceChildren();
    $("environment").textContent = "초기화 중..."; updateReport();
    let renderer = null, gl = null, isolated = false, originalIndexedDB, contextCycleOK = true;
    try {
      // GPU 텍스처 검사를 위한 메모리 전용 IDB. 실제 브라우저 DB는 읽거나 변경하지 않는다.
      originalIndexedDB = Object.getOwnPropertyDescriptor(window, "indexedDB");
      try {const fakeDB = memoryIndexedDB();Object.defineProperty(window, "indexedDB", {configurable:true, value:fakeDB});isolated = window.indexedDB === fakeDB;}
      catch (_) {isolated = false;}
      if(document.hidden) throw new Error("테스트 탭을 화면에 표시하고 실행해 주세요 (백그라운드 rAF 제한)");
      gl = canvas.getContext("webgl2", {alpha:false, antialias:false, depth:false, stencil:false});
      if(!gl) throw new Error("WebGL2 컨텍스트 생성 실패. 브라우저의 GPU 가속 및 WebGL2를 확인해 주세요.");
      const floatExt = !!gl.getExtension("EXT_color_buffer_float"), loseExt = gl.getExtension("WEBGL_lose_context");
      $("environment").textContent = [
        `User Agent: ${navigator.userAgent}`, `WebGL: ${gl.getParameter(gl.VERSION)}`,
        `GLSL: ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`,
        `Vendor: ${gl.getParameter(gl.VENDOR)}`, `Renderer: ${gl.getParameter(gl.RENDERER)}`,
        `Device Pixel Ratio: ${window.devicePixelRatio || 1}`,
        `EXT_color_buffer_float: ${floatExt}`, `WEBGL_lose_context: ${!!loseExt}`,
        `Texture IndexedDB isolation: ${isolated ? "ON (memory-only mock)" : "UNAVAILABLE (texture tests skipped)"}`
      ].join("\n"); updateReport();
      const [Renderer, {default: Shader}] = await Promise.all([import("../js/renderer.js"), import("../js/shader.js")]);
      renderer = Renderer.createRenderer(canvas, Shader);
      const capture = () => renderer.captureScreenshot();
      const pixel = (name, x, y) => {
        const p = renderer.getPasses().find(p => p.name === name);
        assert(!!p, `Unknown Buffer: ${name}`);
        return renderer.readPassPixel(name, x ?? Math.floor(p.width / 2), y ?? Math.floor(p.height / 2));
      };
      const reset = () => {
        renderer.stop(); renderer.setResolutionScale(1); renderer.setMaxPixels(0); renderer.setFpsLimit(0);
        renderer.setPasses([], {}); renderer.setFragment(red);
      };
      const withTexture = async (file, fn) => {
        const entry = await renderer.addTexture(file);
        try {return await fn(entry.id, entry);} finally {await renderer.removeTexture(entry.id);}
      };
      const cycleContext = async () => {
        try {
          const lost = waitEvent(canvas,"webglcontextlost");loseExt.loseContext();const event = await lost;
          assert(event.defaultPrevented,"webglcontextlost 이벤트가 preventDefault되지 않아 복구할 수 없습니다");
          assert(gl.isContextLost(),"loseContext 후 컨텍스트가 손실되지 않았습니다");
          // 이벤트 디스패치 종료 전 restoreContext() 호출은 INVALID_OPERATION (Khronos 명세).
          await new Promise(resolve => setTimeout(resolve, 50));
          const restored = waitEvent(canvas,"webglcontextrestored");loseExt.restoreContext();await restored;
          assert(!gl.isContextLost(),"복구 이벤트 이후에도 WebGL 컨텍스트가 손실된 상태입니다");
        } catch(error) {contextCycleOK = false;throw error;}
      };
      // 개별 검사마다 깨끗한 프로그램과 패스에서 시작하여 앞선 실패를 전파하지 않는다.
      const check = (name, fn) => test(name, async () => {reset(); await fn();});

      await test("01. 범용 Shader Art: 실제 GLSL 컴파일 + PNG", async () => {
        const png = await inspectPNG(await capture());
        assert(png.width === renderer.getStats().width && png.height === renderer.getStats().height, "PNG 크기가 GPU 해상도와 다름");
        assert(png.pixel(0,0)[3] === 255, "PNG 픽셀 알파 값 오류");
      });
      await check("02. RGBA8 렌더링: Buffer + Image + PNG 색상", async () => {
        renderer.setPasses([pass("A", red)], {0:{buffer:"A",frame:"current"}}); renderer.setFragment(copy);
        const shot=await inspectPNG(await capture());equalPixel(pixel("A"), [255,0,0,255], "Buffer A");
        equalPixel(shot.pixel(shot.width>>1,shot.height>>1),[255,0,0,255],"Image");
      });
      await check("03. 단독 Image Fragment, Screenshot 색상", async () => {
        renderer.setFragment(green); const shot = await inspectPNG(await capture());
        equalPixel(shot.pixel(Math.floor(shot.width/2),Math.floor(shot.height/2)), [0,255,0,255], "Image");
      });
      await check("04. Buffer A→B→Image current 연결", async () => {
        const convert = frag("vec4 a=texelFetch(iChannel0,ivec2(gl_FragCoord.xy),0);fragColor=vec4(0.,a.r,0.,1.);");
        renderer.setPasses([pass("A",red),pass("B",convert,{0:{buffer:"A",frame:"current"}})], {0:{buffer:"B",frame:"current"}});
        renderer.setFragment(copy); const shot = await inspectPNG(await capture());
        equalPixel(pixel("A"),[255,0,0,255],"A"); equalPixel(pixel("B"),[0,255,0,255],"B");
        equalPixel(shot.pixel(shot.width>>1,shot.height>>1),[0,255,0,255],"Image");
      });
      await check("05. Previous: 자기 피드백/프레임 누적/Reset", async () => {
        const inc = frag("float r=texelFetch(iChannel0,ivec2(gl_FragCoord.xy),0).r;fragColor=vec4(min(r+1./255.,1.),0.,0.,1.);");
        renderer.setPasses([pass("A",inc,{0:{buffer:"A",frame:"previous"}})], {0:{buffer:"A",frame:"current"}});
        for(let n=1; n<=4; n++) {await capture(); equalPixel(pixel("A"),[n,0,0,255],`frame ${n}`,0);}
        renderer.resetSimulation(); await capture(); equalPixel(pixel("A"),[1,0,0,255],"after reset",0);
      });
      await check("06. Previous 교차 참조 + current 순서", async () => {
        const inc = frag("float r=texelFetch(iChannel0,ivec2(gl_FragCoord.xy),0).r;fragColor=vec4(r+16./255.,0.,0.,1.);");
        renderer.setPasses([pass("A",inc,{0:{buffer:"B",frame:"previous"}}), pass("B",copy,{0:{buffer:"A",frame:"current"}})]);
        await capture(); equalPixel(pixel("A"),[16,0,0,255],"A frame 1",0);equalPixel(pixel("B"),[16,0,0,255],"B frame 1",0);
        await capture(); equalPixel(pixel("A"),[32,0,0,255],"A frame 2",0);equalPixel(pixel("B"),[32,0,0,255],"B frame 2",0);
      });
      await check("07. iChannel0~3 및 iChannelResolution GPU 전송", async () => {
        const source = frag("vec4 a=texelFetch(iChannel0,ivec2(0),0),b=texelFetch(iChannel3,ivec2(0),0);fragColor=vec4(a.r,b.g,iChannelResolution[0].x/255.,1.);");
        renderer.setPasses([pass("A",red,{},"rgba8",.5),pass("B",green),pass("C",source,{0:{buffer:"A",frame:"current"},3:{buffer:"B",frame:"current"}})]);
        await capture(); const w=renderer.getPasses()[0].width;
        equalPixel(pixel("C"),[255,255,w,255],"channel + size",2);
      });
      await check("08. uResolution + uFrame + Reset", async () => {
        renderer.setFragment(frag("fragColor=vec4(float(uFrame)/255.,uResolution.x/255.,uResolution.y/255.,1.);"));
        const first=await inspectPNG(await capture()), a=first.pixel(0,0);
        equalPixel(a,[0,first.width,first.height,255],"frame 0",2);
        const second=await inspectPNG(await capture());equalPixel(second.pixel(0,0),[1,second.width,second.height,255],"frame 1",2);
        renderer.resetSimulation();const third=await inspectPNG(await capture());
        equalPixel(third.pixel(0,0),[0,third.width,third.height,255],"frame reset",2);
      });
      await check("09. uMouse 픽셀 좌표 및 Pointer Leave", async () => {
        renderer.setFragment(frag("fragColor=vec4(uMouse.x<0.?0.:uMouse.x/uResolution.x,uMouse.y<0.?0.:uMouse.y/uResolution.y,uMouse.x<0.?1.:0.,1.);"));
        let shot=await inspectPNG(await capture());equalPixel(shot.pixel(0,0),[0,0,255,255],"outside");
        const rect=canvas.getBoundingClientRect();
        canvas.dispatchEvent(new MouseEvent("pointermove",{clientX:rect.left+rect.width*.25,clientY:rect.top+rect.height*.75}));
        shot=await inspectPNG(await capture());equalPixel(shot.pixel(0,0),[64,64,0,255],"pointer",3);
        canvas.dispatchEvent(new MouseEvent("pointerleave"));
        shot=await inspectPNG(await capture());equalPixel(shot.pixel(0,0),[0,0,255,255],"leave");
      });
      await check("10. PNG Y축 반전: 화면 상단/하단 구별", async () => {
        renderer.setFragment(frag("fragColor=gl_FragCoord.y>uResolution.y*.5?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);"));
        const shot=await inspectPNG(await capture());
        equalPixel(shot.pixel(shot.width>>1,0),[0,255,0,255],"top");
        equalPixel(shot.pixel(shot.width>>1,shot.height-1),[255,0,0,255],"bottom");
      });
      await check("11. Preview Pass 전환과 Image 원복", async () => {
        renderer.setFragment(blue);renderer.setPasses([pass("A",red)]);
        let shot=await inspectPNG(await capture());equalPixel(shot.pixel(0,0),[0,0,255,255],"image");
        renderer.setPreviewPass("A");shot=await inspectPNG(await capture());equalPixel(shot.pixel(0,0),[255,0,0,255],"preview");
        renderer.setPreviewPass(null);shot=await inspectPNG(await capture());equalPixel(shot.pixel(0,0),[0,0,255,255],"restore image");
      });
      await check("12. GLSL 컴파일 오류: Image/Buffer 롤백", async () => {
        renderer.setPasses([pass("A",red)],{0:{buffer:"A",frame:"current"}});renderer.setFragment(copy);
        await capture();const oldImage=renderer.getFragmentSource(), oldPass=renderer.getPassDefinitions()[0].fragment;
        for(const fail of [() => renderer.setFragment(header+"void main(){ GLSL_ERROR }"),
          () => renderer.setPassFragment("A",header+"void main(){ GLSL_ERROR }")]) {
          let rejected=false;try {fail();} catch (_) {rejected=true;}assert(rejected,"잘못된 GLSL이 컴파일됨");
        }
        assert(renderer.getFragmentSource()===oldImage && renderer.getPassDefinitions()[0].fragment===oldPass,"컴파일 실패 후 소스가 변경됨");
        const shot=await inspectPNG(await capture());equalPixel(pixel("A"),[255,0,0,255],"Buffer rollback");
        equalPixel(shot.pixel(0,0),[255,0,0,255],"Image rollback");
      });
      await check("13. 잘못된 current/존재하지 않는 Texture 거부", async () => {
        renderer.setPasses([pass("A",red),pass("B",green)]);
        const old=JSON.stringify(renderer.getPassDefinitions());
        for(const invalid of [() => renderer.setPassChannels("A",{0:{buffer:"A",frame:"current"}}),
          () => renderer.setPassChannels("A",{0:{buffer:"B",frame:"current"}}),
          () => renderer.setImageChannels({0:{texture:"__gpu_nonexistent__"}})]) {
          let rejected=false;try {invalid();} catch (_) {rejected=true;}assert(rejected,"잘못된 채널 연결이 허용됨");
        }
        assert(JSON.stringify(renderer.getPassDefinitions())===old,"채널 오류가 기존 패스 구성을 손상시킴");
        await capture();equalPixel(pixel("A"),[255,0,0,255],"still red");
      });
      await check("14. Uniform float/int/bool/vec2/vec3/vec4 자동 선언", async () => {
        const uniforms=[ ["uGain","float",.75],["uCount","int",7],["uFlag","bool",true],
          ["uVec2","vec2",[0,.5]],["uVec3","vec3",[.1,.3,.4]],["uVec4","vec4",[.2,.4,.6,.8]] ];
        const names=[];
        try {
          for(const [name,type,value] of uniforms) {renderer.defineUniform(name,type,value);names.push(name);}
          renderer.setPasses([pass("A",frag("fragColor=uFlag?vec4(uGain,float(uCount)/255.,uVec2.y+uVec3.r+uVec4.r,1.):vec4(0.);"))]);
          await capture();equalPixel(pixel("A"),[191,7,204,255],"all types",3);
          renderer.setUniform("uGain",.25);await capture();assert(near(pixel("A")[0],64,2),"setUniform 값 미전송");
        } finally {renderer.setPasses([]);for(const name of names.reverse())renderer.removeUniform(name);}
      });
      await check("15. Pack 검증/적용/실패 롤백 (실제 컴파일)", async () => {
        const src=frag("fragColor=vec4(uPackTest,0.,0.,1.);");
        const scene={image:copy,passes:[pass("A",src)],imageChannels:{0:{buffer:"A",frame:"current"}}};
        const items=[{name:"uPackTest",type:"float",value:.6,options:{}}];
        assert(renderer.validatePortable(scene,items)===true,"유효한 Pack 검증 실패");
        assert(renderer.getUserUniforms().length===0,"검증만으로 Uniform 상태가 바뀜");
        renderer.applyPortable(scene,items);await capture();equalPixel(pixel("A"),[153,0,0,255],"applied pack");
        let rejected=false;try {renderer.validatePortable({...scene,image:header+"void main(){ GLSL_ERROR }"},items);} catch (_) {rejected=true;}
        assert(rejected,"잘못된 Pack Shader가 검증을 통과함");
        await capture();equalPixel(pixel("A"),[153,0,0,255],"pack rollback");
        renderer.setPasses([]);renderer.removeUniform("uPackTest");
      });
      if(floatExt) await check("16. RGBA32F: 음수/1 초과/HDR readPixels", async () => {
        renderer.setPasses([pass("A",frag("fragColor=vec4(-.5,1.25,.375,1.);"),{},"rgba32f")]);
        await capture();equalPixel(pixel("A"),[-.5,1.25,.375,1],"float pixel",1e-5);
      }); else skip("16. RGBA32F: 음수/1 초과/HDR readPixels","EXT_color_buffer_float 미지원");
      if(isolated) {
        await check("17. 실제 PNG Texture GPU 업로드 + Buffer 샘플링", async () => {
          const file=await makePNG((ctx,s) => {ctx.fillStyle="blue";ctx.fillRect(0,0,s,s);});
          await withTexture(file, async id => {
            renderer.setPasses([pass("A",copy,{0:{texture:id}})]);
            await capture();equalPixel(pixel("A"),[0,0,255,255],"texture");
          });
          assert(!Object.keys(renderer.getPassDefinitions()[0].channels).length,"삭제된 Texture 채널이 남음");
        });
        await check("18. Texture wrap: Clamp/Repeat/Mirror", async () => {
          const file=await makePNG((ctx,s) => {ctx.fillStyle="blue";ctx.fillRect(0,0,s,s);ctx.fillStyle="red";ctx.fillRect(0,0,1,s);});
          await withTexture(file, async id => {
            renderer.setPasses([pass("A",frag("fragColor=texture(iChannel0,vec2(1.125,.5));"),{0:{texture:id}})]);
            await renderer.setTextureSampling(id,{filter:"nearest"});await capture();equalPixel(pixel("A"),[0,0,255,255],"clamp");
            await renderer.setTextureSampling(id,{wrapS:"repeat"});await capture();equalPixel(pixel("A"),[255,0,0,255],"repeat");
            await renderer.setTextureSampling(id,{wrapS:"mirror"});await capture();equalPixel(pixel("A"),[0,0,255,255],"mirror");
          });
        });
        await check("19. Texture filter: Nearest/Linear 실픽셀 비교", async () => {
          const file=await makePNG((ctx,s) => {ctx.fillStyle="red";ctx.fillRect(0,0,s/2,s);ctx.fillStyle="blue";ctx.fillRect(s/2,0,s/2,s);});
          await withTexture(file, async id => {
            renderer.setPasses([pass("A",frag("fragColor=texture(iChannel0,vec2(.5,.5));"),{0:{texture:id}})]);
            await renderer.setTextureSampling(id,{filter:"linear"});await capture();equalPixel(pixel("A"),[128,0,128,255],"linear",5);
            renderer.setPassFragment("A",frag("fragColor=texture(iChannel0,vec2(.25,.5));"));
            await renderer.setTextureSampling(id,{filter:"nearest"});await capture();equalPixel(pixel("A"),[255,0,0,255],"nearest");
          });
        });
      } else ["17. PNG Texture GPU 업로드","18. Texture wrap","19. Texture filter"].forEach(name => skip(name,"기존 IndexedDB 안전 격리 불가"));
      await check("20. CSS 크기/scale/maxPixels/FBO 재할당", async () => {
        renderer.setPasses([pass("A",red,{},"rgba8",.5)]);
        await capture();let stats=renderer.getStats(), p=renderer.getPasses()[0];
        assert(p.width===Math.max(1,Math.floor(stats.width*.5)) && p.height===Math.max(1,Math.floor(stats.height*.5)),"1/2 Buffer scale 불일치");
        canvas.style.width="96px";canvas.style.height="72px";
        await capture();stats=renderer.getStats();p=renderer.getPasses()[0];
        assert(p.width===Math.floor(stats.width*.5) && p.height===Math.floor(stats.height*.5),"CSS 크기 변경 미반영");
        equalPixel(pixel("A"),[255,0,0,255],"resized FBO");
        renderer.setMaxPixels(600);await capture();stats=renderer.getStats();
        assert(stats.width*stats.height<=600,"maxPixels 제한 미적용");
        p=renderer.getPasses()[0];assert(p.width===Math.max(1,Math.floor(stats.width*.5)),"maxPixels 이후 Buffer scale 불일치");
        equalPixel(pixel("A"),[255,0,0,255],"maxPixels FBO");
        canvas.style.width="64px";canvas.style.height="48px";
      });
      if(loseExt) await check("21. WebGL Context Loss→복구→Buffer/Preview 재생성", async () => {
        renderer.setPasses([pass("A",red)],{0:{buffer:"A",frame:"current"}});renderer.setFragment(copy);
        await capture();equalPixel(pixel("A"),[255,0,0,255],"before loss");
        await cycleContext();
        const shot=await inspectPNG(await capture());equalPixel(pixel("A"),[255,0,0,255],"restored buffer");
        equalPixel(shot.pixel(0,0),[255,0,0,255],"restored image");
        renderer.setPreviewPass("A");const preview=await inspectPNG(await capture());
        equalPixel(preview.pixel(0,0),[255,0,0,255],"restored preview");
      }); else skip("21. WebGL Context Loss→복구","WEBGL_lose_context 미지원");
      if(loseExt && isolated && contextCycleOK && !gl.isContextLost()) await check("22. Context Loss 이후 Texture 재업로드", async () => {
        const file=await makePNG((ctx,s) => {ctx.fillStyle="blue";ctx.fillRect(0,0,s,s);});
        await withTexture(file, async id => {
          renderer.setPasses([pass("A",copy,{0:{texture:id}})]);await capture();equalPixel(pixel("A"),[0,0,255,255],"before loss");
          await cycleContext();
          await capture();equalPixel(pixel("A"),[0,0,255,255],"restored texture");
        });
      }); else skip("22. Context Loss 이후 Texture 재업로드",!loseExt ? "WEBGL_lose_context 미지원" : !isolated ? "IndexedDB 격리 불가" : "선행 Context 복구 실패로 후속 검사 생략");
      if(!gl.isContextLost()) await check("23. GPU 컴파일 오류: 자동 Uniform 후 원본 줄 번호", async () => {
        renderer.defineUniform("uDiagnosticA","float",.2);renderer.defineUniform("uDiagnosticB","float",.4);
        const bad="#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){fragColor=vec4(UNDEFINED_SYMBOL);}";
        let error;try{renderer.validateFragment(bad);}catch(e){error=e;}
        const line=Number(/ERROR:\s*\d+:(\d+):/.exec(error?.message||"")?.[1]);
        assert(error?.glslInjected?.after===2&&error.glslInjected.count===2, "자동 Uniform 두 줄의 삽입 위치가 확인되지 않음");
        assert(line===6&&line-error.glslInjected.count===4, `GPU 오류 위치: 기대 6→4행, 실제 ${line}`);
      }); else skip("23. GPU 컴파일 오류: 자동 Uniform 후 원본 줄 번호","Context 복구 실패로 후속 검사 생략");
      if(!gl.isContextLost()) await check("24. Ray Marching Starter: GLSL/Uniform/Heatmap", async () => {
        for(const [name,type,value,options] of Shader.rayUniforms) renderer.defineUniform(name,type,value,options);
        renderer.setFragment(Shader.raymarch);const shot=await inspectPNG(await capture()),x=shot.width>>1,y=shot.height>>1;
        const beauty=shot.pixel(x,y);assert(beauty[3]===255,"Ray Starter 출력 불투명도 오류");
        renderer.setUniform("uRMHeatmap",true);const debug=(await inspectPNG(await capture())).pixel(x,y);
        assert(debug[3]===255 && beauty.slice(0,3).some((v,i)=>Math.abs(v-debug[i])>12),"Ray 디버그 Uniform 전환이 GPU 픽셀에 반영되지 않음");
      }); else skip("24. Ray Marching Starter","Context 복구 실패로 후속 검사 생략");
      const frames = (count = 3) => new Promise(resolve => {const step = n => n ? requestAnimationFrame(() => step(n - 1)) : resolve();step(count);});
      const drainErrors = () => {for(let i=0;i<32 && gl.getError()!==gl.NO_ERROR;i++);};
      if(!gl.isContextLost()) await check("25. Uniform ivec/uint/bvec/mat 자동 선언·업로드", async () => {
        const items=[["uI","ivec2",[3,10]],["uU","uint",20],["uB","bvec2",[false,true]],["uM","mat2",[1,0,.5,1]]],names=[];
        try {
          for(const [name,type,value] of items) {renderer.defineUniform(name,type,value);names.push(name);}
          renderer.setPasses([pass("A",frag("fragColor=vec4(float(uI.y)/255.,float(uU)/255.,uB.y?1.:0.,uM[1][0]);"))]);
          await capture();equalPixel(pixel("A"),[10,20,255,128],"extended types",2);
          renderer.setUniform("uB",[false,false]);renderer.setUniform("uM",[1,0,.25,1]);await capture();equalPixel(pixel("A"),[10,20,0,64],"updated values",2);
        } finally {renderer.setPasses([]);for(const name of names.reverse())renderer.removeUniform(name);}
      }); else skip("25. Uniform 확장 타입","Context 복구 실패로 후속 검사 생략");
      if(floatExt && !gl.isContextLost()) await check("26. RGBA16F: HDR/음수 readPixels", async () => {
        renderer.setPasses([pass("A",frag("fragColor=vec4(-.5,1.25,.375,1.);"),{},"rgba16f")]);
        await capture();equalPixel(pixel("A"),[-.5,1.25,.375,1],"half float pixel",1e-3);
        assert(renderer.getStats().bufferMemoryBytes===renderer.getPasses()[0].width*renderer.getPasses()[0].height*8*2,"RGBA16F 메모리 계산 오류");
      }); else skip("26. RGBA16F",!floatExt?"EXT_color_buffer_float 미지원":"Context 복구 실패로 후속 검사 생략");
      if(!gl.isContextLost()) await check("27. 내장 Uniform 타입 불일치: 업로드 생략 + GL 오류 없음", async () => {
        renderer.setFragment("#version 300 es\nprecision highp float;\nuniform vec3 uTime;\nout vec4 fragColor;\nvoid main(){fragColor=vec4(uTime,1.);}");
        const ignored=renderer.getShaderReflection().image.ignored;
        assert(ignored.some(item=>item.name==="uTime"&&item.declared==="vec3"),"타입이 다른 uTime이 무시 목록에 없음");
        drainErrors();renderer.start();await frames(3);renderer.stop();
        assert(gl.getError()===gl.NO_ERROR,"렌더 루프가 GL 오류를 남김");
      }); else skip("27. 내장 Uniform 타입 불일치","Context 복구 실패로 후속 검사 생략");
      if(!gl.isContextLost()) await check("28. uMouse vec4: 누름/클릭 프레임/해제", async () => {
        renderer.setFragment("#version 300 es\nprecision highp float;\nuniform vec4 uMouse;\nout vec4 fragColor;\nvoid main(){fragColor=vec4(uMouse.z>0.?1.:0.,uMouse.w>0.?1.:0.,0.,1.);}");
        const rect=canvas.getBoundingClientRect(),at={clientX:rect.left+rect.width*.5,clientY:rect.top+rect.height*.5,button:0};
        canvas.dispatchEvent(new MouseEvent("pointerdown",at));
        let shot=await inspectPNG(await capture());equalPixel(shot.pixel(0,0),[255,255,0,255],"click frame");
        shot=await inspectPNG(await capture());equalPixel(shot.pixel(0,0),[255,0,0,255],"held");
        canvas.dispatchEvent(new MouseEvent("pointerup",at));canvas.dispatchEvent(new MouseEvent("pointerleave"));
        shot=await inspectPNG(await capture());equalPixel(shot.pixel(0,0),[0,0,0,255],"released");
      }); else skip("28. uMouse vec4","Context 복구 실패로 후속 검사 생략");
      if(!gl.isContextLost() && renderer.getStats().gpu.available) await check("29. GPU 타이머: 패스별 시간 수집", async () => {
        renderer.setPasses([pass("A",red)]);renderer.start();await frames(12);renderer.stop();
        const labels=renderer.getStats().gpu.passes.map(item=>item.label);
        assert(labels.includes("A")&&labels.includes("Image"),`GPU 시간 라벨 누락: ${labels.join(",")||"없음"}`);
      }); else skip("29. GPU 타이머","EXT_disjoint_timer_query_webgl2 미지원 또는 Context 손실");
      const mrt = `#version 300 es\nprecision highp float;\nlayout(location = 0) out vec4 o0;\nlayout(location = 1) out vec4 o1;\nvoid main(){o0=vec4(1.,0.,0.,1.);o1=vec4(0.,0.,1.,1.);}`;
      if(!gl.isContextLost()) await check("30. MRT: 출력 2개 + Image가 출력 1 읽기", async () => {
        renderer.setPasses([{...pass("A",mrt),outputs:2}],{0:{buffer:"A",frame:"current",attachment:1}}); renderer.setFragment(copy);
        const shot=await inspectPNG(await capture());
        equalPixel(renderer.readPassPixel("A",0,0,0),[255,0,0,255],"output 0");equalPixel(renderer.readPassPixel("A",0,0,1),[0,0,255,255],"output 1");
        equalPixel(shot.pixel(shot.width>>1,shot.height>>1),[0,0,255,255],"Image ← A[1]");
        let rejected=false;try{renderer.setImageChannels({0:{buffer:"A",frame:"current",attachment:2}});}catch(_){rejected=true;}
        assert(rejected,"존재하지 않는 출력 번호가 허용됨");
      }); else skip("30. MRT","Context 손실");
      if(!gl.isContextLost()) await check("31. 고정 해상도 Buffer + iChannelResolution", async () => {
        renderer.setPasses([{...pass("A",red),size:[37,21]},pass("B",frag("fragColor=vec4(iChannelResolution[0].x/255.,iChannelResolution[0].y/255.,0.,1.);"),{0:{buffer:"A",frame:"current"}})]);
        await capture(); const a=renderer.getPasses()[0];
        assert(a.width===37&&a.height===21,`고정 크기 불일치: ${a.width}×${a.height}`);equalPixel(pixel("B"),[37,21,0,255],"resolution",1);
      }); else skip("31. 고정 해상도","Context 손실");
      if(!gl.isContextLost()) await check("32. Buffer wrap: clamp ↔ repeat", async () => {
        const halves=frag("fragColor=gl_FragCoord.x<uResolution.x*.5?vec4(1.,0.,0.,1.):vec4(0.,1.,0.,1.);");
        const probe=frag("fragColor=texture(iChannel0,vec2(1.25,.5));");
        renderer.setPasses([{...pass("A",halves),size:[16,16],filter:"nearest"},pass("B",probe,{0:{buffer:"A",frame:"current"}})]);
        await capture();equalPixel(pixel("B"),[0,255,0,255],"clamp → 오른쪽 끝");
        renderer.setPasses([{...pass("A",halves),size:[16,16],filter:"nearest",wrap:"repeat"},pass("B",probe,{0:{buffer:"A",frame:"current"}})]);
        await capture();equalPixel(pixel("B"),[255,0,0,255],"repeat → 0.25");
      }); else skip("32. Buffer wrap","Context 손실");
      if(!gl.isContextLost()) await check("33. Buffer mipmap: 체커보드 → 고레벨 평균 회색", async () => {
        const checker=frag("ivec2 p=ivec2(gl_FragCoord.xy);fragColor=vec4(vec3(float((p.x+p.y)&1)),1.);");
        renderer.setPasses([{...pass("A",checker),size:[64,64],mipmap:true},pass("B",frag("fragColor=textureLod(iChannel0,vec2(.5),6.);"),{0:{buffer:"A",frame:"current"}})]);
        await capture();equalPixel(pixel("B"),[128,128,128,255],"mip level 6",6);
        assert(renderer.getStats().bufferMemoryBytes>=64*64*4*2*4/3,"밉맵 메모리 계산 누락");
      }); else skip("33. Buffer mipmap","Context 손실");
      if(!gl.isContextLost()) await check("34. 버퍼 썸네일 + 채널/노출 미리보기 옵션", async () => {
        renderer.setPasses([pass("A",green)]);await capture();
        try {
          let [shot]=renderer.captureBufferThumbnails(32);assert(shot?.image?.width===32,"썸네일 없음");
          const at=i=>[...shot.image.data.slice(i*4,i*4+4)];equalPixel(at(0),[0,255,0,255],"RGB 썸네일");
          renderer.setPreviewOptions({channel:1});[shot]=renderer.captureBufferThumbnails(32);equalPixel(at(0),[0,0,0,255],"R 채널");
          renderer.setPreviewOptions({channel:2});[shot]=renderer.captureBufferThumbnails(32);equalPixel(at(0),[255,255,255,255],"G 채널");
          renderer.setPreviewOptions({channel:0,exposure:.5});[shot]=renderer.captureBufferThumbnails(32);equalPixel(at(0),[0,128,0,255],"노출 ×0.5",2);
        } finally { renderer.setPreviewOptions({channel:0,exposure:1}); }
      }); else skip("34. 버퍼 썸네일","Context 손실");
    } catch (error) {register("FAIL","GPU 검사 초기화/실행",error?.message || String(error));console.error(error);}
    finally {
      try {renderer?.dispose();} catch(error) {register("FAIL","GPU 정리",error.message);}
      canvas.style.width="64px";canvas.style.height="48px";
      if(isolated) {
        try {if(originalIndexedDB)Object.defineProperty(window,"indexedDB",originalIndexedDB);else delete window.indexedDB;}
        catch(error) {register("FAIL","IndexedDB 격리 원복",error.message);}
      }
      $("run").disabled = false;$("copy").disabled = false;updateReport();
    }
  };
  $("run").addEventListener("click",main);
  $("copy").addEventListener("click",async () => {
    const field=$("report");try {await navigator.clipboard.writeText(field.value);$("copy").textContent="복사 완료";}
    catch (_) {field.focus();field.select();$("copy").textContent="아래 결과를 Ctrl+C로 복사";}
  });
})();
