// 패치 적용 후 개발자 도구 Console에 붙여 넣는다. 테스트 후 카메라 설정을 복구한다.
(async () => {
    const input = window.shaderInput, renderer = window.shaderPlayground;
    const assert = (ok, name) => { if(!ok) throw new Error(`FAIL: ${name}`); console.log(`PASS: ${name}`); };
    assert(!!input && !!renderer, "Input/Renderer 모듈 초기화");
    const old = input.getCamera(), stage = document.getElementById("stage");
    const previousFocus = document.activeElement;
    let off = null;const created=!renderer.getUserUniforms().some(u=>u.name==="uCameraOrbit");
    try {
        assert(["isDown", "onKey", "onDrag", "getCamera", "setCamera", "resetCamera"].every(key => typeof input[key] === "function"), "입력 API 제공");
        if(created)renderer.defineUniform("uCameraOrbit","vec3",[0,.5,5]);
        input.setCamera({yaw:0.3, pitch:0.2, distance:6});
        const camera = input.getCamera();
        assert(Math.abs(camera.yaw - 0.3) < 1e-5 && Math.abs(camera.distance - 6) < 1e-5, "카메라 상태 변경");
        assert(renderer.getUniforms().some(x => x.name === "uCameraOrbit" && x.type === "vec3"), "Orbit Uniform 등록");
        const events = [];
        off = input.onKey(({code, down}) => { if(code === "KeyQ") events.push(down); });
        stage.focus({preventScroll:true});
        document.dispatchEvent(new KeyboardEvent("keydown", {code:"KeyQ", key:"q", bubbles:true}));
        assert(input.isDown("KeyQ"), "키 눌림 상태");
        document.dispatchEvent(new KeyboardEvent("keyup", {code:"KeyQ", key:"q", bubbles:true}));
        assert(!input.isDown("KeyQ") && events.join() === "true,false", "키 해제 및 이벤트 구독");
        input.resetCamera();
        assert(Math.abs(input.getCamera().yaw) < 1e-6, "카메라 초기화");
        console.log("Input API 회귀 테스트 통과 (드래그/휠은 실제로 조작해 확인)");
    } finally {
        off?.();
        if(created)renderer.removeUniform("uCameraOrbit");else if(old)input.setCamera(old);
        if(previousFocus && typeof previousFocus.focus === "function") previousFocus.focus({preventScroll:true});
    }
})().catch(console.error);
