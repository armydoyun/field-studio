// 패치 적용 후 개발자 도구 Console에 붙여 넣는다. 입력 모듈은 카메라를 소유하지 않고 키·드래그 구독만 제공한다.
(async () => {
    const input = window.shaderInput, renderer = window.shaderPlayground;
    const assert = (ok, name) => { if(!ok) throw new Error(`FAIL: ${name}`); console.log(`PASS: ${name}`); };
    assert(!!input && !!renderer, "Input/Renderer 모듈 초기화");
    const stage = document.getElementById("stage");
    const previousFocus = document.activeElement;
    let off = null;
    try {
        assert(["isDown", "onKey", "onDrag"].every(key => typeof input[key] === "function"), "입력 API 제공");
        assert(["getCamera", "setCamera", "resetCamera"].every(key => !(key in input)), "Orbit 카메라 API 제거");
        const events = [];
        off = input.onKey(({code, down}) => { if(code === "KeyQ") events.push(down); });
        stage.focus({preventScroll:true});
        document.dispatchEvent(new KeyboardEvent("keydown", {code:"KeyQ", key:"q", bubbles:true}));
        assert(input.isDown("KeyQ"), "키 눌림 상태");
        document.dispatchEvent(new KeyboardEvent("keyup", {code:"KeyQ", key:"q", bubbles:true}));
        assert(!input.isDown("KeyQ") && events.join() === "true,false", "키 해제 및 이벤트 구독");
        // W·R 같은 키는 더 이상 앱이 가져가지 않는다(키보드 채널을 쓰는 셰이더가 쓸 수 있다).
        const w = new KeyboardEvent("keydown", {code:"KeyW", key:"w", bubbles:true, cancelable:true});
        document.dispatchEvent(w);
        document.dispatchEvent(new KeyboardEvent("keyup", {code:"KeyW", key:"w", bubbles:true}));
        assert(!w.defaultPrevented, "W 키를 카메라가 점유하지 않음");
        assert(!document.getElementById("cameraReset") && !document.getElementById("cameraStatus"), "Orbit 카메라 설정 UI 제거");
        console.log("Input API 회귀 테스트 통과");
    } finally {
        off?.();
        if(previousFocus && typeof previousFocus.focus === "function") previousFocus.focus({preventScroll:true});
    }
})();
