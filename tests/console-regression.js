// 브라우저에서 개발용 index.html(로컬 HTTP 서버)을 연 뒤 개발자 콘솔에 전체 붙여넣어 실행한다. ES Module을 직접 import하므로 deploy/(file://)에서는 쓰지 않는다.
(async () => {
    const assert = (ok, name) => { if(!ok) throw new Error(`FAIL: ${name}`); console.log(`PASS: ${name}`); };
    const Shader = (await import(new URL("js/shader.js", document.baseURI).href)).default;   // AMD require.async → 표준 ES Module import
    const source = Shader.fragment;
    assert(source.includes("uTime") && !source.includes("SDFResult"),"범용 Shader Art 시작 템플릿");
    assert(source.startsWith("#version 300 es"), "GLSL 버전");
    assert(["SDF 도형", "기본 장면", "Ray Marching", "카메라와 화면 출력"].every(n => Shader.raymarch.includes(`// --- ${n} ---`)), "Ray Starter 분리");
    assert(!/\buOctaves\b|\bfbm\s*\(|rayAABB\s*\(/.test(source), "장면 종속 기능 제거");
    const gl = document.getElementById("screen").getContext("webgl2");
    const shader = gl.createShader(gl.FRAGMENT_SHADER);
    try {
        gl.shaderSource(shader, source); gl.compileShader(shader);
        assert(gl.getShaderParameter(shader, gl.COMPILE_STATUS), gl.getShaderInfoLog(shader) || "Fragment Shader 컴파일");
    } finally { gl.deleteShader(shader); }
    const r = window.shaderPlayground;
    assert(!!r && !!window.shaderInput && !!window.shaderSettings, "앱 초기화");
    assert(typeof r.getRequiredUniforms==="undefined","카메라는 전역 Required가 아님");
    r.defineUniform("uTestGain", "float", 0.4, {min:0, max:1, step:0.1});
    r.setUniform("uTestGain", 0.8);
    assert(r.getUserUniforms().some(u => u.name === "uTestGain" && u.value === 0.8), "사용자 Uniform 관리");
    assert(r.removeUniform("uTestGain"), "사용자 Uniform 삭제");
    const baseRay = r.getRaymarchSettings();
    assert(baseRay.maxSteps >= 1 && baseRay.surfaceEpsilon > 0, "Ray Marching 기본 설정");
    r.setRaymarchSettings({maxSteps:256, maxDistance:180, surfaceEpsilon:0.0005, normalEpsilon:0.002});
    assert(r.getRaymarchSettings().maxSteps === 256 && r.getRaymarchSettings().normalEpsilon === 0.002, "Ray Marching 설정 변경");
    let invalid = false;
    try { r.setRaymarchSettings({maxSteps:2048, surfaceEpsilon:0.005}); } catch(error) {invalid = true;}
    assert(invalid && r.getRaymarchSettings().surfaceEpsilon === 0.0005, "잘못된 설정은 원자적으로 거부");
    assert(!document.getElementById("rayMaxSteps") && !document.getElementById("debugHeatmap"),"Render 패널 전용 옵션 제거");
    assert(!document.getElementById("studioExampleRaymarch") && !document.getElementById("studioStarters") && typeof window.shaderStudio.exampleRaymarch === "function","편집기 서랍의 옛 시작 예제는 제거 · Ray Marching은 갤러리/API로 계속 제공");
    r.setRaymarchSettings(baseRay);
    const stats = r.getStats();
    r.setDebugHeatmap(!stats.debugHeatmap);
    assert(r.getStats().debugHeatmap !== stats.debugHeatmap, "범용 Ray Steps Heatmap");
    r.setDebugHeatmap(stats.debugHeatmap);
    console.log("Shader Art Workspace 회귀 테스트 통과");
})().catch(console.error);
