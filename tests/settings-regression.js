// 패치 적용 후 개발자 도구 Console에서 전체 내용을 실행한다. 테스트용 Uniform은 마지막에 삭제한다.
(async () => {
    const r = window.shaderPlayground, storage = window.shaderSettings;
    const assert = (condition, name) => { if(!condition) throw new Error(`FAIL: ${name}`); console.log(`PASS: ${name}`); };
    assert(r && storage, "Renderer / Settings 초기화");
    assert(typeof r.getRequiredUniforms==="undefined", "Required API 제거");
    assert(!Object.hasOwn(storage.snapshot(),"required"),"단일 Uniform 저장 구조");
    const id = "uSettingsRegression";
    try {
        r.defineUniform(id, "vec3", [1, 2, 3]);
        assert(r.getUserUniforms().some(x => x.name === id), "사용자 Uniform 추가");
        r.setUniform(id, [4, 5, 6]);
        assert(r.getUserUniforms().find(x => x.name === id).value[2] === 6, "사용자 Uniform 값 변경");
        if(storage.status().available) {
            storage.save();
            const saved = JSON.parse(localStorage.getItem("webgl.raymarch-template.settings.v1"));
            assert(saved.user.some(x => x.name === id && x.value[0] === 4), "localStorage 저장");
        } else console.warn("이 브라우저에서는 localStorage 저장 검사를 건너뜀:", storage.status().message);
    } finally {
        if(r.getUserUniforms().some(x => x.name === id)) r.removeUniform(id);
        storage.save();
    }
    assert(!r.getUserUniforms().some(x => x.name === id), "테스트 Uniform 정리");
    console.log("설정 분리 및 저장 회귀 테스트 완료");
})().catch(console.error);
