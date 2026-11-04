// 성능·디버그 패널. Renderer 공개 API만 읽으며 GPU 리소스를 소유하지 않는다.
// 패널이 화면에 보일 때만 샘플링·그리기를 하여 셰이더 성능 측정 자체를 방해하지 않는다.
  const HISTORY = 180, SAMPLE_MS = 100;
  const mount = renderer => {
    const $ = id => document.getElementById(id), controller = new AbortController(), signal = controller.signal;
    const element = (tag, className = "", text = "") => { const node = document.createElement(tag); if(className) node.className = className; if(text) node.textContent = text; return node; };
    const series = {frame:new Float32Array(HISTORY), gpu:new Float32Array(HISTORY), cpu:new Float32Array(HISTORY)};
    let head = 0, count = 0, ticks = 0, lastSignature = "", infoRendered = false, disposed = false;
    const visible = () => !$("view-profile").hidden && !document.body.classList.contains("panel-hidden") && !document.hidden;
    const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "—";
    const sample = stats => {
      if(!stats.running) return; // 일시정지 중에는 타임라인을 멈춘다.
      series.frame[head] = stats.frameMs; series.gpu[head] = stats.gpu?.totalMs ?? NaN; series.cpu[head] = stats.cpuMs;
      head = (head + 1) % HISTORY; count = Math.min(count + 1, HISTORY);
    };
    // 프레임 타임라인: 16.7ms(60 FPS)·33.3ms(30 FPS) 기준선과 Frame/GPU/CPU 세 계열.
    const drawChart = () => {
      const canvas = $("profileChart"), dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr)), height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if(canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext("2d"); if(!ctx) return;
      const css = getComputedStyle(document.documentElement), color = name => css.getPropertyValue(name).trim();
      ctx.clearRect(0, 0, width, height);
      let peak = 20; for(let i = 0; i < count; i++) for(const key of ["frame","gpu","cpu"]) { const v = series[key][(head - 1 - i + HISTORY) % HISTORY]; if(Number.isFinite(v)) peak = Math.max(peak, v); }
      // 탭 복귀 직후 같은 일시적 스파이크가 축을 망치지 않도록 상한은 100ms로 자른다.
      const max = Math.min(Math.max(peak * 1.15, 20), 100), y = ms => height - (ms / max) * (height - 6 * dpr) - 2 * dpr, step = width / (HISTORY - 1);
      ctx.font = `${10 * dpr}px ${color("--mono") || "monospace"}`; ctx.textBaseline = "bottom";
      for(const [ms, label] of [[16.67, "60fps"], [33.33, "30fps"]]) if(ms < max) {
        ctx.strokeStyle = color("--line-strong"); ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.lineWidth = dpr;
        ctx.beginPath(); ctx.moveTo(0, y(ms)); ctx.lineTo(width, y(ms)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = color("--faint"); ctx.fillText(label, 4 * dpr, y(ms) - 2 * dpr);
      }
      const plot = (data, stroke, fill) => {
        ctx.beginPath(); let started = false, firstX = 0, lastX = 0;
        for(let i = 0; i < count; i++) {
          const v = data[(head - count + i + HISTORY) % HISTORY]; if(!Number.isFinite(v)) continue;
          const x = width - (count - 1 - i) * step; if(!started) { ctx.moveTo(x, y(v)); firstX = x; started = true; } else ctx.lineTo(x, y(v)); lastX = x;
        }
        if(!started) return; ctx.strokeStyle = stroke; ctx.lineWidth = 1.5 * dpr; ctx.lineJoin = "round"; ctx.stroke();
        if(fill) { ctx.lineTo(lastX, height); ctx.lineTo(firstX, height); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
      };
      plot(series.frame, color("--faint")); plot(series.cpu, color("--syn-builtin")); plot(series.gpu, color("--accent"), color("--accent-soft"));
      ctx.fillStyle = color("--faint"); ctx.textAlign = "right"; ctx.textBaseline = "top"; ctx.fillText(`${Math.round(max)}ms`, width - 4 * dpr, 2 * dpr); ctx.textAlign = "left";
    };
    const renderKpis = stats => {
      const items = [["FPS", fmt(stats.fps, 1), ""], ["FRAME", fmt(stats.frameMs), "ms"], ["GPU", stats.gpu?.available ? fmt(stats.gpu.totalMs ?? NaN) : "N/A", stats.gpu?.available ? "ms" : ""],
        ["CPU", fmt(stats.cpuMs), "ms"], ["VRAM", fmt(stats.bufferMemoryBytes / 1048576, 1), "MiB"]];
      const holder = $("profileKpis"); if(holder.children.length !== items.length) holder.replaceChildren(...items.map(() => { const tile = element("div","profile-kpi"); tile.append(element("span"), element("strong")); return tile; }));
      items.forEach(([label, value, unit], i) => { const tile = holder.children[i]; tile.children[0].textContent = label; tile.children[1].textContent = value; tile.children[1].dataset.unit = unit; tile.dataset.kind = label.toLowerCase(); });
    };
    // 패스별 GPU 시간 막대. 실행 순서(Buffer → Image)를 유지하고 총합 대비 비율을 표시한다.
    const renderPasses = stats => {
      const holder = $("profilePasses"), gpu = stats.gpu;
      if(!gpu?.available) { holder.replaceChildren(element("p","help","이 브라우저/GPU는 EXT_disjoint_timer_query_webgl2를 제공하지 않아 패스별 GPU 시간을 측정할 수 없습니다. 위 FRAME·CPU 지표로 비교하세요.")); return; }
      if(!gpu.enabled) { holder.replaceChildren(element("p","help","GPU 타이머가 꺼져 있습니다.")); return; }
      const order = [...renderer.getPasses().map(p => p.name), "Image", "Preview"], rows = [...gpu.passes].sort((a,b) => order.indexOf(a.label) - order.indexOf(b.label));
      if(!rows.length) { holder.replaceChildren(element("p","help","측정 대기 중… 재생 중일 때 수집됩니다.")); return; }
      const total = rows.reduce((sum, row) => sum + row.ms, 0) || 1;
      holder.replaceChildren(...rows.map(row => {
        const line = element("div","profile-pass"), bar = element("span","profile-bar"), share = row.ms / total;
        bar.style.setProperty("--share", `${Math.max(2, share * 100)}%`); bar.dataset.heavy = String(row.ms > 8);
        line.append(element("span","profile-pass-name", row.label === "Image" || row.label === "Preview" ? row.label : `Buffer ${row.label}`), bar,
          element("span","profile-pass-ms", `${fmt(row.ms)}ms · ${Math.round(share * 100)}%`));
        return line;
      }));
    };
    // 기본값(0/단위행렬/false)으로 선언된 미등록 Uniform을 파라미터로 승격한다.
    const types = new Map((renderer.getUniformTypes?.() || []).map(item => [item.type, item]));
    const initialValue = type => {
      const spec = types.get(type); if(!spec) return null; const n = spec.components;
      if(spec.kind === "m") { const dim = Math.round(Math.sqrt(n)); return Array.from({length:n}, (_, i) => i % (dim + 1) === 0 ? 1 : 0); }
      if(spec.kind === "b") return n === 1 ? false : Array(n).fill(false);
      return n === 1 ? 0 : Array(n).fill(0);
    };
    const promote = (name, type) => {
      const status = $("profileUniformStatus");
      try { renderer.defineUniform(name, type, initialValue(type), {}); document.dispatchEvent(new Event("shader-settings-applied")); status.textContent = `${name} (${type})를 파라미터로 등록했습니다. 파라미터 탭에서 값을 조절하세요.`; status.dataset.state = "ok"; }
      catch(error) { status.textContent = `${name}: ${error.message}`; status.dataset.state = "error"; }
      lastSignature = ""; renderUniforms();
    };
    const renderUniforms = () => {
      const reflection = renderer.getShaderReflection?.(); if(!reflection) return;
      const programs = [["Image", reflection.image], ...reflection.passes.map(p => [`Buffer ${p.name}`, p])];
      const signature = JSON.stringify(programs); if(signature === lastSignature) return; lastSignature = signature;
      const holder = $("profileUniforms"), groups = []; let total = 0;
      for(const [label, report] of programs) {
        if(!report) continue; const group = element("div","profile-program"), head = element("div","profile-program-head");
        head.append(element("strong","",label), element("span","", report.uniforms ? `${report.uniforms.length} active` : "리플렉션 불가")); group.append(head);
        for(const item of report.ignored || []) {
          const row = element("div","profile-uniform"); row.dataset.source = "ignored";
          row.append(element("code","",item.name), element("span","profile-uniform-type",item.declared), element("span","profile-uniform-note",`무시됨 · 허용: ${item.expected}`)); group.append(row);
        }
        for(const item of report.uniforms || []) {
          total++; const row = element("div","profile-uniform"); row.dataset.source = item.source || "builtin";
          const note = item.source === "user" ? "파라미터" : item.source === "unregistered" ? "미등록 · 값 0" : "내장";
          row.append(element("code","",item.size > 1 ? `${item.name}[${item.size}]` : item.name), element("span","profile-uniform-type",item.type), element("span","profile-uniform-note",note));
          if(item.source === "unregistered" && item.size === 1 && types.has(item.type)) {
            const button = element("button","profile-promote","등록"); button.type = "button"; button.title = `${item.name}을 파라미터 패널에서 조절할 수 있게 등록`;
            button.addEventListener("click", () => promote(item.name, item.type)); row.append(button);
          }
          group.append(row);
        }
        groups.push(group);
      }
      $("profileUniformCount").textContent = String(total); holder.replaceChildren(...groups);
    };
    // 버퍼 뷰어: 출력별 썸네일 캔버스는 키(이름:출력)로 재사용해 매번 DOM을 다시 만들지 않는다.
    const thumbs = new Map();
    const renderBuffers = stats => {
      const holder = $("profileBuffers"), shots = renderer.captureBufferThumbnails?.(152) || [], seen = new Set();
      if(!shots.length) { thumbs.clear(); holder.replaceChildren(element("p","help","버퍼 패스가 없거나 아직 렌더링되지 않았습니다. 편집기의 + Buffer로 추가하세요.")); return; }
      if(holder.querySelector("p")) holder.replaceChildren();
      for(const shot of shots) {
        const key = `${shot.name}:${shot.attachment}`; seen.add(key); let entry = thumbs.get(key);
        if(!entry) {
          const button = element("button","profile-buffer"), canvas = element("canvas"), caption = element("span","profile-buffer-caption");
          button.type = "button"; button.append(canvas, caption); holder.append(button);
          button.addEventListener("click", () => {
            const current = renderer.getStats(); const active = current.previewPass === shot.name && current.previewAttachment === shot.attachment;
            try { renderer.setPreviewPass(active ? null : shot.name, active ? 0 : shot.attachment); } catch(error) { $("profilePixel").textContent = error.message; }
            lastBufferRender = 0;
          });
          entry = {button, canvas, caption}; thumbs.set(key, entry);
        }
        if(entry.canvas.width !== shot.width || entry.canvas.height !== shot.height) { entry.canvas.width = shot.width; entry.canvas.height = shot.height; }
        entry.canvas.getContext("2d")?.putImageData(shot.image, 0, 0);
        const outputs = renderer.getPasses().find(p => p.name === shot.name)?.outputs || 1;
        entry.caption.textContent = `${shot.name}${outputs > 1 ? `[${shot.attachment}]` : ""} · ${shot.sourceWidth}×${shot.sourceHeight} · ${shot.format}`;
        const active = stats.previewPass === shot.name && stats.previewAttachment === shot.attachment;
        entry.button.classList.toggle("is-active", active); entry.button.setAttribute("aria-pressed", String(active));
        entry.button.title = active ? "Image 보기로 돌아가기" : `${shot.name} 출력 ${shot.attachment}을 뷰포트에 표시`;
      }
      for(const [key, entry] of thumbs) if(!seen.has(key)) { entry.button.remove(); thumbs.delete(key); }
    };
    let lastBufferRender = 0;
    // 미리보기 중인 버퍼의 실제 값(float 버퍼는 HDR·음수 포함)을 포인터 위치에서 읽는다. 80ms마다 한 번으로 제한.
    let lastPixelRead = 0;
    const readHover = event => {
      if(!visible() || event.timeStamp - lastPixelRead < 80) return; lastPixelRead = event.timeStamp;
      const stats = renderer.getStats(), name = stats.previewPass, output = $("profilePixel");
      if(!name) { output.textContent = "버퍼를 선택하면 포인터 위치의 실제 값을 읽습니다. (현재 Image 표시 중)"; return; }
      const pass = renderer.getPasses().find(p => p.name === name); if(!pass?.width) return;
      const rect = $("screen").getBoundingClientRect(); if(!rect.width || !rect.height) return;
      const x = Math.max(0, Math.min(pass.width - 1, Math.floor((event.clientX - rect.left) / rect.width * pass.width)));
      const y = Math.max(0, Math.min(pass.height - 1, Math.floor((rect.bottom - event.clientY) / rect.height * pass.height)));
      try { const values = renderer.readPassPixel(name, x, y, stats.previewAttachment);
        output.textContent = `${name}${pass.outputs > 1 ? `[${stats.previewAttachment}]` : ""} (${x}, ${y}) · ${pass.format.toUpperCase()}\n${["R","G","B","A"].map((c,i) => `${c} ${Number(values[i]).toPrecision(5)}`).join("   ")}`;
      } catch(error) { output.textContent = error.message; }
    };
    const renderInfo = () => {
      const caps = renderer.getCapabilities?.(); if(!caps) return; infoRendered = true;
      const rows = [["GPU", caps.renderer], ["Vendor", caps.vendor], ["WebGL", caps.version], ["GLSL", caps.glsl],
        ["Max texture", `${caps.maxTextureSize}px`], ["Texture units", String(caps.maxTextureUnits)], ["Draw buffers", String(caps.maxDrawBuffers)],
        ["Frag uniforms", `${caps.maxFragmentUniformVectors} vec4`]];
      const list = $("profileGpu"), nodes = [];
      for(const [key, value] of rows) nodes.push(element("dt","",key), element("dd","",String(value)));
      const exts = element("dd","profile-extensions");
      for(const [name, ok] of Object.entries(caps.extensions)) { const chip = element("span","profile-ext",name.replace(/^(EXT|OES|KHR|WEBGL)_/,"")); chip.dataset.ok = String(ok); chip.title = `${name}: ${ok ? "지원" : "미지원"}`; exts.append(chip); }
      nodes.push(element("dt","","Extensions"), exts); list.replaceChildren(...nodes);
    };
    const tick = () => {
      if(disposed) return; const stats = renderer.getStats(); sample(stats);
      if(!visible()) return; ticks++; drawChart(); renderKpis(stats);
      if(ticks % 5 === 1) { renderPasses(stats); renderUniforms(); if(!infoRendered) renderInfo(); }
      // 썸네일은 GPU→CPU 읽기라 약 0.3초 간격, 클릭 직후에는 즉시 갱신한다.
      if(performance.now() - lastBufferRender > 300) { lastBufferRender = performance.now(); renderBuffers(stats); }
      $("profileGpuTiming").disabled = !stats.gpu?.available; $("profileGpuTiming").checked = !!stats.gpu?.enabled;
    };
    $("profileGpuTiming").addEventListener("change", event => { try { renderer.setGpuTiming(event.target.checked); } catch(error) { event.target.checked = !event.target.checked; } }, {signal});
    for(const button of $("profileChannel").querySelectorAll("button")) button.addEventListener("click", () => {
      renderer.setPreviewOptions({channel:Number(button.dataset.channel)});
      for(const other of $("profileChannel").querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === button));
      lastBufferRender = 0;
    }, {signal});
    $("profileExposure").addEventListener("input", event => {
      const exposure = 2 ** Number(event.target.value); renderer.setPreviewOptions({exposure});
      // 반 단계(√2 배수)는 무리수이므로 유효 숫자 3자리로 줄여 표시한다. 정확한 값은 툴팁으로 제공.
      const short = value => value >= 10 ? String(Math.round(value)) : String(Number(value.toPrecision(3)));
      $("profileExposureLabel").textContent = exposure >= 1 ? `×${short(exposure)}` : `×1/${short(1 / exposure)}`;
      $("profileExposureLabel").title = `${Number(event.target.value) >= 0 ? "+" : ""}${event.target.value} EV · ×${exposure}`; lastBufferRender = 0;
    }, {signal});
    $("screen").addEventListener("pointermove", readHover, {signal});
    $("profileReset").addEventListener("click", () => { for(const data of Object.values(series)) data.fill(0); head = count = 0; drawChart(); }, {signal});
    // 탭을 연 직후 바로 최신 상태를 보여준다.
    for(const button of document.querySelectorAll('#panelTabs [data-tab="profile"]')) button.addEventListener("click", () => { lastSignature = ""; setTimeout(tick, 0); }, {signal});
    const timer = setInterval(tick, SAMPLE_MS);
    return {refresh:() => { lastSignature = ""; tick(); }, dispose:() => { disposed = true; clearInterval(timer); controller.abort(); }};
  }; export {mount};
