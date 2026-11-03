// 브라우저 개발자 콘솔에 붙여 넣어 실행한다. 기본 설정은 검사 후 복원한다.
(() => {
    const r = window.shaderPlayground;
    const assert = (value, description) => {
        if(!value) throw new Error(`FAIL: ${description}`);
        console.log(`PASS: ${description}`);
    };
    assert(!!r && typeof r.getStats === "function", "렌더러 초기화");
    const $ = id => document.getElementById(id);
    const prevPanel = document.body.classList.contains("panel-hidden");
    const prevHud = $("stage").classList.contains("hud-hidden");
    const prevFps = r.getStats().fpsLimit;
    const prevTab = [...document.querySelectorAll("[data-tab]")].find(x => x.getAttribute("aria-selected") === "true")?.dataset.tab || "render";
    try {
        assert(!!$("tab-render") && !!$("tab-uniforms") && !!$("tab-input"), "세 개의 설정 탭");
        $("tab-uniforms").click();
        assert(!$("view-uniforms").hidden && $("view-render").hidden, "Uniform 탭 전환");
        assert(!$("requiredUniformList"), "Required UI 제거");
        assert($("uniformSearch") && $("uniformEditor") && $("uniformForm"), "검색 및 Uniform 등록 UI");
        $("tab-render").click();
        $("stage").classList.remove("hud-hidden");
        $("hudToggle").click();
        assert($("stage").classList.contains("hud-hidden"), "HUD 숨김");
        $("hudToggle").click();
        assert(!$("stage").classList.contains("hud-hidden"), "HUD 복구");
        $("panelToggle").click();
        assert(document.body.classList.contains("panel-hidden") !== prevPanel, "패널 표시 토글");
        $("panelToggle").click();
        $("panel").querySelector("#panelTabs").querySelector('[data-tab="render"]').click();
        $("panel").querySelector('[data-fps-preset="30"]').click();
        assert(r.getStats().fpsLimit === 30, "FPS 프리셋");
        assert(!!$("statFps") && !!$("statResolution") && !!$("statFrame"), "뷰포트 통계 HUD");
        console.log("Shader Studio UI 회귀 검사 통과");
    } finally {
        r.setFpsLimit(prevFps);
        document.body.classList.toggle("panel-hidden", prevPanel);
        $("stage").classList.toggle("hud-hidden", prevHud);
        $("tab-" + prevTab).click();
        $("hudToggle").setAttribute("aria-pressed", String(!prevHud));
        $("hudToggle").setAttribute("aria-label", prevHud ? "HUD 표시" : "HUD 숨기기");
        $("panelToggle").setAttribute("aria-pressed", String(!prevPanel));
        $("panelToggle").setAttribute("aria-label", prevPanel ? "설정 패널 열기" : "설정 패널 숨기기");
    }
})();
