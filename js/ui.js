// Renderer의 공개 API만 호출하는 설정 패널. WebGL 리소스를 소유하지 않는다.
  const mount = (renderer, input, settings) => {
    const $ = id => document.getElementById(id); const controller = new AbortController(), signal = controller.signal;
    const element = tag => document.createElement(tag),setText=(id,text)=>{const node=$(id);if(node.textContent!==text)node.textContent=text;};
    const listen = (el, event, callback) => el.addEventListener(event, callback, {signal}); const showError = message => {
      $("uiError").textContent = message || ""; $("toastMessage").textContent = message || "";$("uiToast").hidden=!message; $("uiToast").classList.toggle("is-visible", !!message);
    }; const attempt = callback => { try { callback(); showError(""); } catch(error) { showError(error.message); } };
    listen($("uiDismiss"),"click",()=>showError(""));
    // 터치 기기에서 검색창에 포커스하면 가상 키보드가 패널을 가리므로 파라미터 탭에 포커스한다.
    const touchOnly = window.matchMedia?.("(hover:none) and (pointer:coarse)").matches === true;
    const focusSearch = () => (touchOnly ? $("tab-uniforms") : $("uniformSearch")).focus();
    // 타입 정보(성분 수, f/i/u/b/m 종류)는 Renderer의 표를 따른다. 새 타입이 추가돼도 UI 분기는 바뀌지 않는다.
    const typeTable = new Map((renderer.getUniformTypes?.() || []).map(item => [item.type, item]));
    const typeInfo = type => typeTable.get(type) || {type, components:Number(/^vec([234])$/.exec(type)?.[1]) || 1, kind:type === "bool" ? "b" : type === "int" ? "i" : "f"};
    const parseBool = (raw, type) => {
      if(!["true", "false", "1", "0"].includes(raw.toLowerCase())) throw new Error(`${type}은 true/false 또는 1/0으로 입력하세요.`);
      return raw.toLowerCase() === "true" || raw === "1";
    };
    // 카메라 조작 등으로 생긴 0.5239193476851991 같은 값은 입력 칸에 유효숫자 6자리로만 표시한다.
    const displayNumber = value => typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value) ? String(Number(value.toPrecision(6))) : String(value);
    const validNumber = (kind, value) => Number.isFinite(value) && (kind === "f" || kind === "m" || (Number.isInteger(value) && (kind !== "u" || value >= 0)));
    // 입력 중 숫자가 아닌 값이나 잘못된 차원의 벡터가 넘어가지 않도록 경계에서 검증한다.
    const parseValue = (type, text) => {
      const raw = text.trim(), {components:size, kind} = typeInfo(type); if(!raw) throw new Error("Uniform 값을 입력해야 합니다.");
      if(size > 1) {
        if(/(^,|,$|,\s*,)/.test(raw)) throw new Error("벡터의 각 성분에 숫자를 입력하세요.");
        const parts = raw.split(/[\s,]+/);
        if(kind === "b") { if(parts.length !== size) throw new Error(`${type}에는 true/false 값 ${size}개가 필요합니다.`); return parts.map(part => parseBool(part, type)); }
        const result = parts.map(Number);
        if(result.length !== size || !result.every(value => validNumber(kind, value))) throw new Error(`${type}에는 ${kind === "f" || kind === "m" ? "숫자" : kind === "u" ? "0 이상 정수" : "정수"} ${size}개가 필요합니다.`);
        return result;
      }
      if(kind === "b") return parseBool(raw, type);
      const result = Number(raw);
            if(!validNumber(kind, result)) throw new Error(`${type}에 맞는 숫자를 입력하세요.`);
      return result;
    };
    // 기본 입력값: 행렬은 단위 행렬, 그 외는 0(bool은 true).
    const defaultValue = type => {
      const {components:size, kind} = typeInfo(type), dim = Math.round(Math.sqrt(size));
      if(kind === "m") return Array.from({length:size}, (_, i) => i % (dim + 1) === 0 ? 1 : 0).join(", ");
      if(kind === "b") return size > 1 ? Array(size).fill("false").join(", ") : "true";
      return size > 1 ? Array(size).fill(0).join(", ") : kind === "f" ? "0.5" : "0";
    }; let deletedUniform=null; const clearDeleted = () => {deletedUniform=null;$("undoUniform").hidden=true;$("uniformNotice").textContent="";}; let uniformSnapshot = ""; const renderUniforms = () => {
      const userList = $("uniformList"), items = renderer.getUserUniforms();
      const search = $("uniformSearch").value.trim().toLowerCase(); uniformSnapshot = JSON.stringify(items);
      userList.replaceChildren();
      $("uniformCount").textContent = `${items.length} / 64`;$("uniformCreate").disabled=items.length>=64; for(const item of items) {
                if(search && !`${item.name} ${item.type}`.toLowerCase().includes(search)) continue;
                const row = element("div"); row.className = "uniform-row";
        const top = element("div"); top.className = "uniform-top"; const title = element("div");
        const name = element("span"); name.className = "uniform-name"; name.textContent = item.name;
        const type = element("span"); type.className = "uniform-type"; type.textContent = item.type;
        title.append(name, type);
        const remove = element("button"); remove.className = "remove-uniform glyph-icon icon-close"; remove.type = "button";
        remove.title = `${item.name} 삭제 · GLSL에서 참조 중이면 먼저 코드를 수정하세요`; remove.setAttribute("aria-label",`${item.name} 삭제`);
        remove.addEventListener("click", () => attempt(() => { const current=renderer.getUserUniforms().find(u=>u.name===item.name);if(!current)return renderUniforms();renderer.removeUniform(item.name);deletedUniform=current;$("undoUniform").hidden=false;$("uniformNotice").textContent=`${item.name} 삭제됨`; renderUniforms(); $("undoUniform").focus(); }));
        top.append(title, remove);
        const commit = (field, value) => {
          try {renderer.setUniform(item.name,value);item.value=value;field.removeAttribute("aria-invalid");showError("");return true;}
          catch(error){field.setAttribute("aria-invalid","true");showError(`${item.name}: ${error.message}`);return false;}
        };
        row.append(top); if(item.type === "bool") {
          const label = element("label"); label.className = "uniform-switch";
          const input = element("input"); input.type = "checkbox"; input.checked = item.value; input.setAttribute("role","switch");
          const text = element("span"); text.textContent = item.value ? "true · 켜짐" : "false · 꺼짐";
          input.setAttribute("aria-label",item.name); input.addEventListener("change", () => {if(!commit(input,input.checked))input.checked=item.value;text.textContent=input.checked?"true · 켜짐":"false · 꺼짐";});
          label.append(input, text); row.append(label);
        } else if(item.options?.color) {
          // 색상: RGB는 컬러 피커(0~1 선형 값을 그대로 8bit로 표시), vec4의 A는 별도 슬라이더.
          const wrap = element("div"); wrap.className = "uniform-color";
          const picker = element("input"); picker.type = "color"; picker.setAttribute("aria-label",`${item.name} 색상`);
          const code = element("code"); const hex = values => "#" + values.slice(0,3).map(v => Math.round(Math.max(0,Math.min(1,v))*255).toString(16).padStart(2,"0")).join("");
          const show = values => { picker.value = hex(values); code.textContent = values.map(v => Number(v).toFixed(3)).join(", "); };
          const current = () => [...(renderer.getUserUniforms().find(u=>u.name===item.name)?.value || item.value)];
          picker.addEventListener("input", () => {
            const values = current(), rgb = picker.value.match(/[0-9a-f]{2}/gi).map(h => parseInt(h,16)/255);
            values.splice(0,3,...rgb); if(commit(picker,values)) show(values);
          }); wrap.append(picker, code);
          if(item.type === "vec4") {
            const alpha = element("input"); alpha.type = "range"; alpha.min = "0"; alpha.max = "1"; alpha.step = "0.001"; alpha.value = String(item.value[3]);
            alpha.setAttribute("aria-label",`${item.name} 알파`); alpha.title = "Alpha";
            alpha.addEventListener("input", () => { const values = current(); values[3] = Number(alpha.value); if(commit(alpha,values)) show(values); });
            wrap.append(alpha);
          }
          show(item.value); row.append(wrap);
        } else if(typeInfo(item.type).components > 1) {
          // 벡터는 X/Y/Z/W, 행렬은 column-major 순서의 [열,행] 칸으로 편집한다. bvec 성분은 체크박스.
          // 범위가 지정된 벡터는 성분마다 슬라이더 + 숫자 입력을 둔다.
          const {kind} = typeInfo(item.type), dim = kind === "m" ? Math.round(Math.sqrt(item.value.length)) : 0;
          const opts = item.options || {}, ranged = !dim && kind !== "b" && Number.isFinite(opts.min) && Number.isFinite(opts.max);
          const grid = element("div"); grid.className = dim ? "uniform-vector is-matrix" : ranged ? "uniform-vector is-ranged" : "uniform-vector";
          if(dim) grid.style.setProperty("--uniform-columns", String(dim));
          item.value.forEach((value, index) => {
            const field = element("div");
            const label = element("label"); label.textContent = dim ? `${Math.floor(index / dim)},${index % dim}` : ["X", "Y", "Z", "W"][index];
            const input = element("input"); input.setAttribute("aria-label",`${item.name} ${label.textContent}`);
            if(kind === "b") { input.type = "checkbox"; input.checked = value; }
            else { input.type = "number"; input.step = kind === "f" || kind === "m" ? "any" : "1"; if(kind === "u") input.min = "0"; input.value = displayNumber(value); }
            const update = (source, next) => {
              const values = renderer.getUserUniforms().find(u=>u.name===item.name)?.value;
              if(!values)return renderUniforms();
              item.value=[...values];values[index] = next;
              if(!commit(source,values)) { if(kind === "b") input.checked = item.value[index]; else input.value=displayNumber(item.value[index]); return false; }
              return true;
            };
            let slider = null;
            input.addEventListener("change", () => { if(update(input, kind === "b" ? input.checked : input.value.trim() ? Number(input.value) : NaN) && slider) slider.value = input.value; });
            if(ranged) {
              slider = element("input"); slider.type = "range"; slider.min = String(opts.min); slider.max = String(opts.max); slider.step = String(opts.step);
              slider.value = String(value); slider.setAttribute("aria-label",`${item.name} ${label.textContent} 슬라이더`);
              slider.addEventListener("input", () => { if(update(slider, Number(slider.value))) input.value = slider.value; });
              field.append(label, slider, input);
            } else field.append(label, input);
            grid.append(field);
          }); row.append(grid);
        } else {
          const pair = element("div"); pair.className = "uniform-pair";
          const number = element("input"); number.type = "number"; number.step = typeInfo(item.type).kind === "f" ? "any" : "1"; if(item.type === "uint") number.min = "0"; number.value = displayNumber(item.value);
          number.setAttribute("aria-label",item.name);
          const opts = item.options || {}; let range;
          const changeNumber = () => {
            let value;try {value=parseValue(item.type,number.value);}catch(error){showError(`${item.name}: ${error.message}`);number.setAttribute("aria-invalid","true");number.value=String(item.value);return;}
            if(commit(number,value)){if(range)range.value=String(value);}else number.value=String(item.value);
          };
          number.addEventListener("change",changeNumber);
          if(Number.isFinite(opts.min) && Number.isFinite(opts.max)) {
            range = element("input"); range.type = "range";
            range.min = String(opts.min); range.max = String(opts.max); range.step = String(opts.step);
            range.setAttribute("aria-label",`${item.name} 슬라이더`);range.value = String(item.value);
            range.addEventListener("input", () => {if(commit(range,Number(range.value)))number.value=displayNumber(item.value);});
            pair.append(range);
          }
          pair.append(number); row.append(pair);
        }
        userList.append(row);
      }
      const count=userList.children.length; $("uniformResults").textContent=search ? `${items.length}개 중 ${count}개 표시` : "";
      if(!count) {
        const hint=element("div");hint.className="uniform-empty";
        hint.textContent=search ? "검색 결과가 없습니다. 이름이나 타입을 확인하세요." : "아직 파라미터가 없습니다. 위에서 추가하거나 Starter로 시작하세요.";userList.append(hint);
      }
    }; listen($("undoUniform"),"click",()=>attempt(()=>{
      if(!deletedUniform)return;const {name,type,value,options}=deletedUniform;
      renderer.defineUniform(name,type,value,options);clearDeleted();$("uniformSearch").value="";renderUniforms();focusSearch();
    })); const updateTypeFields = () => {
      const t = $("uniformType").value,bool=t==="bool",{components:size,kind}=typeInfo(t);$("uniformValue").hidden=bool;$("uniformValue").required=!bool;$("uniformBoolValue").hidden=!bool;
      $("uniformValueHelp").textContent=bool?"선택한 상태가 GLSL의 true/false로 전달됩니다.":kind==="m"?`${size}개 숫자를 column-major 순서로 입력하세요. 기본값은 단위 행렬입니다.`:kind==="b"?`${size}개의 true/false를 쉼표로 구분하세요.`:size>1?`${size}개 ${kind==="f"?"숫자":kind==="u"?"0 이상 정수":"정수"}를 쉼표로 구분하세요. 예: ${defaultValue(t)}`:"숫자를 입력하세요. 슬라이더 범위는 선택 사항입니다."; $("rangeFields").hidden = !["f","i","u"].includes(kind);
      $("uniformColorField").hidden = !["vec3","vec4"].includes(t); if($("uniformColorField").hidden) $("uniformColor").checked = false;
      $("uniformValue").value = defaultValue(t);
    }; listen($("uniformType"), "change", updateTypeFields); listen($("uniformSearch"), "input", renderUniforms);
    listen($("uniformEditor"),"toggle",()=>{if($("uniformEditor").open)$("uniformName").focus();});
    listen($("uniformCancel"),"click",()=>{$("uniformEditor").open=false;showError("");$("uniformEditor").querySelector("summary").focus();});
    listen($("uniformForm"), "submit", event => {
      event.preventDefault(); attempt(() => {
        const type = $("uniformType").value; const value = parseValue(type,type==="bool"?$("uniformBoolValue").value:$("uniformValue").value);
        const min = $("uniformMin").value.trim(), max = $("uniformMax").value.trim(), step = $("uniformStep").value.trim();
        const hasBounds = ["f","i","u"].includes(typeInfo(type).kind) && [min, max, step].some(Boolean);
        if(hasBounds && ![min, max, step].every(Boolean)) throw new Error("슬라이더의 Min, Max, Step을 모두 입력하세요.");
        const opts = hasBounds ? {min:Number(min), max:Number(max), step:Number(step)} : {};
        if($("uniformColor").checked && ["vec3","vec4"].includes(type)) opts.color = true;
        renderer.defineUniform($("uniformName").value.trim(), type, value, opts);clearDeleted(); $("uniformSearch").value=""; renderUniforms(); $("uniformName").value = "";
        $("uniformMin").value = $("uniformMax").value = $("uniformStep").value = ""; $("uniformEditor").open = false; $("uniformEditor").querySelector("summary").focus();
      });
    }); listen($("fpsLimit"), "change", event => attempt(() => renderer.setFpsLimit(parseValue("int",event.target.value))));
    for(const button of document.querySelectorAll("[data-fps-preset]")) {
      listen(button, "click", () => attempt(() => {
        const value = Number(button.dataset.fpsPreset); renderer.setFpsLimit(value); $("fpsLimit").value = String(value); syncFpsPresets(value);
      }));
    }
    listen($("resolutionScale"), "input", event => attempt(() => {
      const value = Number(event.target.value);
            renderer.setResolutionScale(value); $("resolutionLabel").textContent = `${Math.round(value * 100)}%`;
    })); listen($("maxPixels"), "change", event => attempt(() => renderer.setMaxPixels(parseValue("int",event.target.value))));
    // Shader Image와 오프스크린 Buffer A/B/C/D를 같은 Preview 메뉴에서 확인한다.
    const syncBuffers = () => {
      const select = $("bufferPreview"), passes = renderer.getPasses(); const keys = ["",...passes.map(p => p.name)];
      const old = [...select.options].map(o => o.value); if(JSON.stringify(old) !== JSON.stringify(keys)) {
        select.replaceChildren(); for(const name of keys) {
          const option = element("option");
                    option.value = name; option.textContent = name ? `Buffer ${name}` : "Image · 최종 렌더링";
          select.append(option);
        }
      }
      const stats=renderer.getStats();select.value = stats.previewPass || ""; const memory=(stats.bufferMemoryBytes/1048576).toFixed(1);
      const timing = name => {const item=stats.gpu?.passes?.find(entry=>entry.label===name);return item?` · ${item.ms.toFixed(2)}ms`:"";};
            $("bufferInfo").textContent = passes.length ? passes.map(p => `${p.name}: ${p.width}×${p.height} · ${p.format}${timing(p.name)}`).join("  |  ")+` · GPU ≈ ${memory} MiB` :
      "등록된 버퍼가 없습니다. 아래 예제로 A/B 패스를 확인할 수 있습니다.";
    }; listen($("bufferPreview"), "change", event => attempt(() => renderer.setPreviewPass(event.target.value || null)));
    listen($("bufferDemo"), "click", () => attempt(() => {
      window.shaderStudio?.examplePipeline(); syncBuffers();
    })); listen($("bufferClear"), "click", () => attempt(() => {
      if(window.shaderStudio) window.shaderStudio.removeAllPasses(); else renderer.setPasses([]);syncBuffers();
    })); const stage = $("stage"),tabScroll=new Map();let activeTab="render"; const setActiveTab = tab => {
      const scroll=$("panel").querySelector(".panel-scroll");tabScroll.set(activeTab,scroll.scrollTop);activeTab=tab;
      for(const button of document.querySelectorAll("#panelTabs [data-tab]")) {
        const active = button.dataset.tab === tab; button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
      }
      for(const view of document.querySelectorAll(".panel-view")) {
        const active = view.dataset.panel === tab; view.classList.toggle("is-active", active); view.hidden = !active;
      }
      scroll.scrollTop=tabScroll.get(tab)||0; if(tab === "uniforms") renderUniforms();
    }; listen($("studioParameters"),"click",()=>{
      if(window.matchMedia("(max-width:820px)").matches)window.shaderStudio?.close();document.body.classList.remove("panel-hidden");syncPanel();setActiveTab("uniforms");focusSearch();
    }); const tabButtons = [...document.querySelectorAll("#panelTabs [data-tab]")];
    for(const button of tabButtons) listen(button, "click", () => setActiveTab(button.dataset.tab)); listen($("panelTabs"), "keydown", event => {
      if(!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const current = tabButtons.indexOf(document.activeElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabButtons.length - 1 :
      (current + (event.key === "ArrowRight" ? 1 : -1) + tabButtons.length) % tabButtons.length;
      setActiveTab(tabButtons[index].dataset.tab); tabButtons[index].focus();
    }); const syncPanel = () => {
      const hidden = document.body.classList.contains("panel-hidden");stage.inert=!hidden&&window.matchMedia("(max-width:820px)").matches;
      $("panelToggle").setAttribute("aria-label", hidden ? "설정 패널 열기" : "설정 패널 숨기기");
      $("panelToggle").setAttribute("aria-pressed", String(!hidden)); $("panelClose").title = hidden ? "패널 열기" : "패널 숨기기";
    }; const togglePanel = () => { document.body.classList.toggle("panel-hidden"); syncPanel(); if(!document.body.classList.contains("panel-hidden"))$("panelTabs").querySelector(`[data-tab="${activeTab}"]`)?.focus();else $("panelToggle").focus(); }; const toggleHud = () => {
      const hidden = stage.classList.toggle("hud-hidden"); $("hudToggle").setAttribute("aria-label", hidden ? "HUD 표시" : "HUD 숨기기");
      $("hudToggle").setAttribute("aria-pressed", String(!hidden));
    }; const syncFpsPresets = fps => {
      for(const button of document.querySelectorAll("[data-fps-preset]")) {
        const active = Number(button.dataset.fpsPreset) === fps; button.classList.toggle("is-selected", active);
        button.setAttribute("aria-pressed", String(active));
      }
    }; const toggleFullscreen = async () => {
      try {
        if(document.fullscreenElement === stage) await document.exitFullscreen();
        else await stage.requestFullscreen(); showError("");
            } catch(error) { showError(`전체화면 전환 실패: ${error.message}`); }
    }; listen($("cameraReset"), "click", () => input.resetCamera()); listen($("panelClose"), "click", togglePanel);
    const helpDialog = $("quickHelp"), toggleHelp = () => helpDialog.open ? helpDialog.close() : helpDialog.showModal();
    for(const id of ["helpToggle","studioHelp"]) listen($(id),"click",toggleHelp);
    listen($("helpClose"),"click",()=>helpDialog.close());listen(helpDialog,"click",event=>{if(event.target===helpDialog)helpDialog.close();});
    listen(helpDialog,"keydown",event=>{if(!["Escape","?"].includes(event.key))event.stopPropagation();});
    listen(document,"shader-panel-changed",syncPanel);listen($("panelBackdrop"),"click",togglePanel);listen(window,"resize",syncPanel);listen($("panelToggle"),"click",togglePanel); listen($("hudToggle"), "click", toggleHud);
    listen($("fullscreenToggle"), "click", toggleFullscreen); listen($("screenshotButton"),"click",async () => {
      const button=$("screenshotButton");button.disabled=true;
      try {const blob=await renderer.captureScreenshot(),url=URL.createObjectURL(blob),a=element("a");
        a.href=url;a.download=`shader-${new Date().toISOString().replace(/[:.]/g,"-")}.png`;document.body.append(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),3000);showError("");
      }catch(error){showError(`PNG 저장 실패: ${error.message}`);}finally{button.disabled=false;}
    }); listen($("previewPause"),"click",()=>attempt(()=>{window.shaderStudio?.togglePlayback();updateStats();}));listen($("previewImage"),"click",()=>attempt(()=>{renderer.setPreviewPass(null);updateStats();}));
    listen($("screen"), "pointerdown", () => stage.classList.add("has-interacted"));
    listen($("screen"), "wheel", () => stage.classList.add("has-interacted")); listen(document, "fullscreenchange", () => {
      const active = document.fullscreenElement === stage; $("fullscreenToggle").setAttribute("aria-label", active ? "전체화면 종료" : "전체화면");
      $("fullscreenToggle").title = active ? "전체화면 종료 (F)" : "전체화면 (F)";
    }); listen(document, "keydown", event => {
      if(event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if(event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
      const key = event.key.toLowerCase(); if(event.code==="Space"&&(document.activeElement===stage||document.activeElement===$("screen"))){event.preventDefault();window.shaderStudio?.togglePlayback();updateStats();} else if(key === "?") {event.preventDefault();toggleHelp();}
      else if(key === "f") { event.preventDefault(); toggleFullscreen(); }
      else if(key === "h") { event.preventDefault(); togglePanel(); }
      else if(key === "g") { event.preventDefault(); toggleHud(); } else if(key === "/") {
        event.preventDefault(); document.body.classList.remove("panel-hidden"); syncPanel();
        setActiveTab("uniforms"); $("uniformSearch").focus();
      }
    }); syncPanel(); const updateStats = () => {
      const s = renderer.getStats();const camera=!!input.getCamera();$("cameraReset").disabled=!camera;$("stageHint").textContent=camera?"드래그 회전 · 휠 확대 · E 편집기":"E 편집기 열기 · / 파라미터 찾기";setText("cameraStatus",camera?"Orbit 카메라 활성 · 드래그와 휠로 조작할 수 있습니다.":"Orbit 카메라 비활성 · 현재 프로젝트는 일반 입력만 사용합니다.");const storage = settings.status(); setText("storageStatus",storage.message);
      $("storageStatus").classList.toggle("unavailable", !storage.available);
      // 외부 JS에서 변경한 설정도 패널에 반영한다. 사용자가 편집 중이면 값은 덮어쓰지 않는다.
      const playing=window.shaderStudio?.getPlaybackState()??s.running;$("previewPause").setAttribute("aria-label",playing?"일시정지":"재생");$("previewPause").setAttribute("aria-pressed",String(!playing));
      setText("renderState",s.running?"재생 중":"일시정지");$("renderState").dataset.running=String(s.running);{const pause=$("studioPause"),label=stage.classList.contains("studio-maximized")?(playing?"복귀 시 재생":"복귀 시 정지"):playing?"일시정지":"재생";pause.setAttribute("aria-label",label);pause.setAttribute("aria-pressed",String(!playing));pause.title=`${label} · 뷰포트에서는 Space`;}
      $("previewImage").disabled=!s.previewPass;$("bufferClear").disabled=!renderer.getPasses().length;
      const active = document.activeElement; if(active !== $("fpsLimit")) $("fpsLimit").value = s.fpsLimit;
      if(active !== $("resolutionScale")) $("resolutionScale").value = s.resolutionScale;
            $("resolutionLabel").textContent = `${Math.round(s.resolutionScale * 100)}%`;
      const pixelSelect = $("maxPixels"); let custom = pixelSelect.querySelector("option[data-custom]");
      if(custom && String(s.maxPixels) !== custom.value) { custom.remove(); custom = null; }
      if(![...pixelSelect.options].some(o => o.value === String(s.maxPixels))) {
        custom = element("option"); custom.dataset.custom = "true"; custom.value = String(s.maxPixels);
                custom.textContent = `사용자 설정 (${s.maxPixels.toLocaleString("ko-KR")}px)`;
        pixelSelect.append(custom);
      }
      if(active !== pixelSelect) pixelSelect.value = String(s.maxPixels);
      if(!$("view-uniforms").hidden && !(active instanceof Element && active.closest("#uniformList")) && uniformSnapshot !== JSON.stringify(renderer.getUserUniforms())) renderUniforms();
            $("statFps").textContent = s.fps.toFixed(1) + (s.fpsLimit ? ` / ${s.fpsLimit}` : "");
            $("statResolution").textContent = `${s.width} × ${s.height}`;
      $("statFrame").textContent = s.frame.toLocaleString("ko-KR");
      // GPU 시간은 EXT_disjoint_timer_query_webgl2가 있을 때만 측정된다. 없으면 CPU 제출 시간만 표시한다.
      const gpu = s.gpu, gpuText = gpu?.available && gpu.enabled ? (gpu.totalMs === null ? "측정 중" : `${gpu.totalMs.toFixed(2)}ms`) : "N/A";
      setText("statGpu", gpuText);
      $("statGpu").parentElement?.setAttribute?.("title", gpu?.available ? `패스별 GPU 시간(이동평균): ${gpu.passes.map(p=>`${p.label} ${p.ms.toFixed(2)}ms`).join(" · ") || "측정 대기"} · CPU 제출 ${(s.cpuMs??0).toFixed(2)}ms`
        : `이 브라우저/GPU는 GPU 타이머(EXT_disjoint_timer_query_webgl2)를 지원하지 않습니다. CPU 제출 ${(s.cpuMs??0).toFixed(2)}ms · 프레임 간격 ${(s.frameMs??0).toFixed(2)}ms`);
            $("stats").title = `${s.fps.toFixed(1)} FPS · ${s.width}×${s.height} · Frame ${s.frame} · GPU ${gpuText} · CPU ${(s.cpuMs??0).toFixed(2)}ms`;
            $("viewportMode").textContent = s.previewPass ? `BUFFER ${s.previewPass}` : "IMAGE";
      $("studioPreviewTarget").textContent=`미리보기 · ${s.previewPass?`Buffer ${s.previewPass}`:"Image"}`;
      syncBuffers(); syncFpsPresets(s.fpsLimit);
    };
    listen(document,"shader-settings-applied",()=>{clearDeleted(); $("uniformSearch").value="";renderUniforms();syncPanel();updateStats();});
    // JS에서 초기 설정이 이미 바뀌어 있더라도 UI 표시와 일치시킨다.
    listen($("resetSettings"), "click", () => attempt(() => {
      settings.reset(); $("uniformSearch").value = ""; renderUniforms(); updateStats(); syncPanel();
    })); updateTypeFields();clearDeleted();renderUniforms(); updateStats(); const timer = setInterval(updateStats, 500);
    return {dispose: () => { clearInterval(timer); controller.abort(); }};
  }; export {mount};
