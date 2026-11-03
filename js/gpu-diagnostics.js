// GPU 진단 공용 도구: GL 오류 격리, 활성 Uniform 리플렉션, GPU 패스 시간 측정.
// 리소스를 직접 소유하는 것은 GPU 타이머의 Query 객체뿐이며 onLost/restore/dispose로 수명을 관리한다.
  // getActiveUniform() 타입 상수 → GLSL 타입 이름. 모의 GL에도 동작하도록 숫자 상수를 직접 사용한다.
  const GLSL_TYPES = new Map([
    [0x1406,"float"],[0x8B50,"vec2"],[0x8B51,"vec3"],[0x8B52,"vec4"],
    [0x1404,"int"],[0x8B53,"ivec2"],[0x8B54,"ivec3"],[0x8B55,"ivec4"],
    [0x1405,"uint"],[0x8DC6,"uvec2"],[0x8DC7,"uvec3"],[0x8DC8,"uvec4"],
    [0x8B56,"bool"],[0x8B57,"bvec2"],[0x8B58,"bvec3"],[0x8B59,"bvec4"],
    [0x8B5A,"mat2"],[0x8B5B,"mat3"],[0x8B5C,"mat4"],[0x8B65,"mat2x3"],[0x8B66,"mat2x4"],
    [0x8B67,"mat3x2"],[0x8B68,"mat3x4"],[0x8B69,"mat4x2"],[0x8B6A,"mat4x3"],
    [0x8B5E,"sampler2D"],[0x8B5F,"sampler3D"],[0x8B60,"samplerCube"],[0x8B62,"sampler2DShadow"],
    [0x8DC1,"sampler2DArray"],[0x8DC4,"sampler2DArrayShadow"],[0x8DC5,"samplerCubeShadow"],
    [0x8DCA,"isampler2D"],[0x8DCB,"isampler3D"],[0x8DCC,"isamplerCube"],[0x8DCF,"isampler2DArray"],
    [0x8DD2,"usampler2D"],[0x8DD3,"usampler3D"],[0x8DD4,"usamplerCube"],[0x8DD7,"usampler2DArray"]
  ]);
  // 이전 호출이 남긴 GL 오류 플래그를 비운다. getError()는 동기 호출이므로 매 프레임 사용하지 않는다.
  // 상한을 두어 손실된 컨텍스트나 비정상 드라이버에서도 무한 루프가 생기지 않게 한다.
  const clearErrors = gl => {
    if(typeof gl.getError !== "function") return 0;
    let count = 0; while(count < 32 && gl.getError() !== gl.NO_ERROR) count++;
    return count;
  };
  // 링크된 Program의 활성 Uniform 표. 드라이버가 최적화로 제거한 Uniform은 포함되지 않는다.
  // 리플렉션을 지원하지 않는 환경(모의 GL 등)에서는 null을 돌려 기존 동작을 유지한다.
  const reflectUniforms = (gl, program) => {
    if(!program || typeof gl.getActiveUniform !== "function") return null;
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    if(!Number.isInteger(count) || count < 0) return null;
    const table = new Map();
    for(let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i); if(!info) continue;
      const name = info.name.replace(/\[0\]$/, "");
      // Uniform Block 멤버와 구조체 필드는 개별 Location 업로드 대상이 아니다.
      if(name.includes(".") || name.includes("[")) continue;
      table.set(name, {name, type:GLSL_TYPES.get(info.type) || `0x${info.type.toString(16)}`, size:info.size});
    }
    return table;
  };
  // 디버그 UI·외부 도구용 직렬화. 내부 Location 객체는 노출하지 않는다.
  const describeLocations = locations => !locations ? null : {
    uniforms:locations.active ? [...locations.active.values()].map(item => ({...item})) : null,
    ignored:(locations.mismatches || []).map(item => ({...item}))
  };
  // EXT_disjoint_timer_query_webgl2 기반 패스별 GPU 시간 측정.
  // - Query는 풀에서 재사용하며 결과는 비동기로 수집한다(파이프라인 정지 없음).
  // - 동시에 하나의 TIME_ELAPSED Query만 활성화할 수 있으므로 패스 단위로 begin/end한다.
  // - GPU_DISJOINT가 발생하면 해당 구간 결과를 버린다.
  const createGpuTimer = gl => {
    const MAX_PENDING = 96, STALE_FRAMES = 120;
    let ext = null, enabled = true, lost = false, active = null, serial = 0;
    const free = [], pending = [], results = new Map();
    const acquire = () => {
      const entry = free.pop(); if(entry) return entry;
      const query = gl.createQuery(); return query ? {query, label:""} : null;
    };
    const recycleAll = () => { while(pending.length) free.push(pending.shift()); };
    const init = () => {
      ext = typeof gl.getExtension === "function" ? gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
    };
    const begin = label => {
      if(!ext || !enabled || lost || active) return false;
      const entry = acquire(); if(!entry) return false;
      entry.label = label; gl.beginQuery(ext.TIME_ELAPSED_EXT, entry.query); active = entry; return true;
    };
    // end()는 활성 Query가 없으면 아무것도 하지 않으므로 finally 블록에서 안전하게 호출할 수 있다.
    const end = () => {
      if(!active) return; gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); active = null;
      if(pending.length > MAX_PENDING) free.push(pending.shift());
    };
    const record = (label, ms) => {
      let item = results.get(label);
      if(!item) { item = {label, ms:ms, last:ms, updated:serial}; results.set(label, item); }
      else { item.ms = item.ms * 0.9 + ms * 0.1; item.last = ms; item.updated = serial; }
    };
    // 프레임 끝에서 준비된 결과만 수집한다. 준비되지 않은 Query는 다음 프레임에 다시 확인한다.
    const endFrame = () => {
      if(!ext || lost) return; end(); serial++;
      if(gl.getParameter(ext.GPU_DISJOINT_EXT)) { recycleAll(); return; }
      while(pending.length) {
        const entry = pending[0];
        if(!gl.getQueryParameter(entry.query, gl.QUERY_RESULT_AVAILABLE)) break;
        record(entry.label, gl.getQueryParameter(entry.query, gl.QUERY_RESULT) / 1e6); free.push(pending.shift());
      }
    };
    const getResults = () => {
      const passes = []; let total = 0;
      for(const item of results.values()) if(serial - item.updated <= STALE_FRAMES) {
        passes.push({label:item.label, ms:Math.round(item.ms * 1000) / 1000}); total += item.ms;
      }
      return {available:!!ext && !lost, enabled, totalMs:passes.length ? Math.round(total * 1000) / 1000 : null, passes};
    };
    const setEnabled = value => { if(typeof value !== "boolean") throw new TypeError("GPU 타이머 설정은 boolean이어야 합니다."); enabled = value; if(!value) { end(); results.clear(); } return enabled; };
    const deleteAll = () => {
      if(active) { try { gl.endQuery(ext.TIME_ELAPSED_EXT); } catch (_) {} free.push(active); active = null; }
      recycleAll(); for(const entry of free) gl.deleteQuery(entry.query); free.length = 0;
    };
    // 손실된 컨텍스트의 Query 핸들은 삭제하지 않고 참조만 버린다.
    const onLost = () => { lost = true; active = null; pending.length = free.length = 0; results.clear(); };
    const restore = () => { lost = false; init(); };
    const dispose = () => { if(!lost && ext) deleteAll(); ext = null; active = null; pending.length = free.length = 0; results.clear(); };
    init();
    return {begin, end, endFrame, getResults, setEnabled, onLost, restore, dispose};
  };
  export {GLSL_TYPES, clearErrors, reflectUniforms, describeLocations, createGpuTimer};
