// 개발자 콘솔에 붙여 넣어 실행하는 다중 버퍼 회귀 테스트. 기존 장면 설정은 검사 후 복원한다.
(async () => {
    const r = window.shaderPlayground;
    if(!r) throw new Error("먼저 Ray Marching 페이지를 열어 주세요.");
    const assert = (condition, name) => { if(!condition) throw new Error(`FAIL: ${name}`); console.log(`PASS: ${name}`); };
    if(r.getPasses().length) throw new Error("기존 Buffer 패스가 활성화되어 있습니다. 새 탭에서 기본 템플릿을 연 뒤 실행하세요.");
    const studio = window.shaderStudio;
    if(!studio) throw new Error("Shader Studio가 초기화되지 않았습니다.");
    const oldProject = studio.getProject();
    try {
        if(!studio.exampleFeedback()) throw new Error("피드백 예제 실행 실패");
        r.setPreviewPass("B");
        assert(r.getPasses().length === 2, "A/B 패스 등록");
        assert(r.getStats().previewPass === "B", "B 미리보기 설정");
        assert(r.getImageChannels()[0].buffer === "B", "Image 채널 연결");
        assert(r.getPasses()[1].channels[0].frame === "current", "현재 프레임 의존성");
        assert(r.getPasses()[1].channels[1].frame === "previous", "이전 프레임 피드백");
        assert(r.getPasses()[0].format === "rgba8", "픽셀 포맷");
        assert(r.getPasses()[0].scale === 1, "해상도 배율");
        const pause = () => new Promise(resolve => setTimeout(resolve,150));
        await pause(); await pause();
        const p = r.getPasses()[0];
        assert(p.width > 0 && p.height > 0, "GPU Texture 해상도 할당");
        const rgba = r.readPassPixel("A",0,0);
        assert(rgba.length === 4 && rgba.every(v => Number.isInteger(v) && v>=0 && v<=255), "실제 픽셀 읽기");
        const unchanged = JSON.stringify(r.getPasses());
        try { r.setPasses([{name:"A",fragment:"#version 300 es",channels:{0:{buffer:"A",frame:"current"}}}]); throw Error("검증 실패"); }
        catch(e) { assert(/current/.test(e.message), "자기 현재 프레임 피드백 금지"); }
        assert(JSON.stringify(r.getPasses()) === unchanged, "잘못된 패스 등록 시 기존 GPU 상태 유지");
        r.setPreviewPass(null);
        assert(r.getStats().previewPass === null, "최종 Image 화면 복원");
        console.log("모든 Multi-pass 회귀 테스트 통과");
    } finally {
        studio.setProject(oldProject); // 실행 전 프로젝트 복원
    }
})();
