// localStorage 저장은 렌더러와 분리한다. WebGL 상태 대신 복원 가능한 설정만 직렬화한다.
// 브라우저 저장소가 제한될 수 있으므로 실패해도 렌더링을 중단하지 않는다.
  const KEY = "webgl.raymarch-template.settings.v1"; const mount = renderer => {
    const defaults = {
      fpsLimit:0, resolutionScale:1, maxPixels:0, debugHeatmap:false, raymarch:renderer.getRaymarchSettings()
    }; let available = true, migrationBlocked=false, errorMessage = "", savedText = null, disposed = false; const readState = () => {
      const stats = renderer.getStats(); return {
        version:1, rendering:{fpsLimit:stats.fpsLimit, resolutionScale:stats.resolutionScale, maxPixels:stats.maxPixels,
          debugHeatmap:stats.debugHeatmap},
        raymarch:renderer.getRaymarchSettings(),
        user:renderer.getUserUniforms().map(({name, type, value, options}) => ({name, type, value, options})),
        panelHidden:document.body.classList.contains("panel-hidden")
      };
    };
        const failStorage = error => { available = false; errorMessage = `브라우저 저장소 사용 불가: ${error.message}`; };
    const migrateCamera = data => {
      if(!data?.required || !Object.hasOwn(data.required,"uCameraOrbit") || !Array.isArray(data.user))return data;
      let user=data.user;
      if(!user.some(u=>u?.name==="uCameraOrbit")) {
        renderer.validateUniformValue("vec3",data.required.uCameraOrbit);
        if(user.length>=64)throw new Error("이전 카메라를 Custom으로 옮기려면 Uniform 슬롯이 하나 필요합니다.");
        user=[...user,{name:"uCameraOrbit",type:"vec3",value:data.required.uCameraOrbit,options:{}}];
      }
      return {...data,user,required:Object.fromEntries(Object.entries(data.required).filter(([name])=>name!=="uCameraOrbit"))};
    };
    const status = () => ({available:available&&!migrationBlocked,message:available&&!migrationBlocked?"렌더링·파라미터 설정 자동 저장":errorMessage}); const save = (force=false) => {
      if(force===true&&migrationBlocked){migrationBlocked=false;errorMessage="";}if(disposed || !available || migrationBlocked) return false; const text = JSON.stringify(readState()); if(text === savedText) return true;
      try { window.localStorage.setItem(KEY, text); savedText = text; return true; } catch(error) { failStorage(error); return false; }
    }; const load = () => {
      let raw; try { raw = window.localStorage.getItem(KEY); } catch(error) { failStorage(error); return false; }
      if(!raw) { savedText = JSON.stringify(readState()); return false; }
      let data; try { data = JSON.parse(raw); } catch(error) { errorMessage = "기존 설정 형식이 올바르지 않아 기본값으로 시작함"; return false; }
      if(!data || data.version !== 1) { errorMessage = "지원하지 않는 저장 형식이므로 기본값으로 시작함"; return false; }
      try {data=migrateCamera(data);}catch(error){migrationBlocked=true;errorMessage=`설정 복원 중단: ${error.message} · 원본 설정 보존`;return false;}
      // 저장값은 외부 입력이다. 항목마다 검증해서 잘못된 값은 건너뛴다.
      const rendering = data.rendering || {}; for(const [key, setter] of [["fpsLimit", "setFpsLimit"], ["resolutionScale", "setResolutionScale"],
      ["maxPixels", "setMaxPixels"], ["debugHeatmap", "setDebugHeatmap"]]) {
        if(Object.prototype.hasOwnProperty.call(rendering, key)) {
                    try { renderer[setter](rendering[key]); } catch(error) { console.warn(`저장된 ${key} 무시:`, error.message); }
        }
      }
      // 구버전 저장 데이터에는 raymarch가 없어도 기본값을 사용한다.
      if(data.raymarch && typeof data.raymarch === "object") for(const key of ["maxSteps", "maxDistance", "surfaceEpsilon", "normalEpsilon"]) {
        if(Object.prototype.hasOwnProperty.call(data.raymarch, key)) {
          try { renderer.setRaymarchSettings({[key]:data.raymarch[key]}); }
                    catch(error) { console.warn(`저장된 ${key} 무시:`, error.message); }
        }
      }
      if(Array.isArray(data.user) && (data.user.length || renderer.getUserUniforms().length)) {
        const users=data.user.slice(0,64);
        try {renderer.setUserUniforms(users);}catch(error) {
          for(const item of users) {if(!item || typeof item!=="object")continue;
            try {renderer.defineUniform(item.name,item.type,item.value,item.options||{});}
            catch(error){console.warn(`저장된 사용자 Uniform 무시 (${item.name}):`,error.message);}
          }
        }
      }
      // 좁은 화면에서 패널은 뷰포트를 덮는 서랍이므로, 저장 상태와 관계없이 닫힌 채로 시작한다.
      const overlayPanel = globalThis.matchMedia?.("(max-width:820px)").matches === true;
      document.body.classList.toggle("panel-hidden", data.panelHidden === true || overlayPanel);
      savedText = null; // 유효하지 않은 항목을 제외한 안전한 스냅샷으로 갱신한다.
      save(); return true;
    }; // Pack에 포함되는 설정은 저장소 포맷을 그대로 사용하되, 적용 전에 전체 검증한다.
    const validatePack = data => {
      if(!data || data.version!==1 || !data.rendering || !data.raymarch || !Array.isArray(data.user) || typeof data.panelHidden!=="boolean")
        throw new Error("Pack 설정 형식이 올바르지 않습니다.");
      data=migrateCamera(data);
      const limits={fpsLimit:[0,240,1],resolutionScale:[.25,1],maxPixels:[0,Number.MAX_SAFE_INTEGER,1],
        maxSteps:[1,512,1],maxDistance:[.01,10000],surfaceEpsilon:[.000001,.1],normalEpsilon:[.000001,.1]};
      for(const [name,range] of Object.entries(limits)) {
        const value=(["fpsLimit","resolutionScale","maxPixels"].includes(name)?data.rendering:data.raymarch)[name];
        if(typeof value!=="number" || !Number.isFinite(value) || value<range[0] || value>range[1] || (range[2] && !Number.isInteger(value)))
          throw new Error(`Pack 설정 범위 오류: ${name}`);
      }
      if(Object.keys(data.raymarch).some(key=>!["maxSteps","maxDistance","surfaceEpsilon","normalEpsilon"].includes(key)))
        throw new Error("Pack Ray Marching 설정 키 오류");
      if(typeof data.rendering.debugHeatmap!=="boolean")throw new Error("Pack 히트맵 설정 오류");
      return data;
    }; const applyPack = data => {
      data=validatePack(data);const s=data.rendering;
      renderer.setFpsLimit(s.fpsLimit);renderer.setResolutionScale(s.resolutionScale);
      renderer.setMaxPixels(s.maxPixels);renderer.setDebugHeatmap(s.debugHeatmap);
      renderer.setRaymarchSettings(data.raymarch);
      // panelHidden은 Pack 형식 호환을 위해 검증·저장만 한다. 패널 표시는 이 기기의 화면 배치이므로 프로젝트를 열어도 바꾸지 않는다.
      document.dispatchEvent(new Event("shader-settings-applied"));save();
    }; const reset = () => {
      if(available&&!migrationBlocked)errorMessage="";
      renderer.setFpsLimit(defaults.fpsLimit); renderer.setResolutionScale(defaults.resolutionScale);
      renderer.setMaxPixels(defaults.maxPixels); renderer.setDebugHeatmap(defaults.debugHeatmap);
      renderer.setRaymarchSettings(defaults.raymarch);
      document.body.classList.remove("panel-hidden");savedText=null;save();
    };
    // 외부 JS에서 renderer.setUniform()을 호출한 경우도 별도 구독 없이 저장한다.
    // 매 프레임 저장하지 않고 700ms마다 바뀐 스냅샷만 기록한다.
    const timer = setInterval(save, 700); const onPageHide = () => save(); window.addEventListener("pagehide", onPageHide);
    const dispose = () => {
      if(disposed) return; save(); disposed = true; clearInterval(timer); window.removeEventListener("pagehide", onPageHide);
    }; return {load, save, reset, status, dispose, snapshot:readState, validatePack, applyPack};
  }; export {mount};
