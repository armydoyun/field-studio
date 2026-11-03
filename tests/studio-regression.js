// 브라우저 개발자 콘솔에 전체 코드를 붙여 넣거나, 로컬 JS 파일 내용으로 실행한다.
(async () => {
    const r = window.shaderPlayground, studio = window.shaderStudio;
    if(!r || !studio) throw new Error("Shader Studio가 초기화되지 않았습니다.");
    const initial = studio.getProject();
    const initialPreview = r.getStats().previewPass;
    const ok = (condition,label) => { if(!condition) throw new Error(`FAIL: ${label}`);console.log(`PASS: ${label}`); };
    const source = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform sampler2D iChannel0;
out vec4 fragColor;
void main(){fragColor=vec4(0.3,0.5,0.8,1.0);}`;
    try {
        const before = r.getStats().frame;
        ok(studio.setProject({image:source,passes:[
            {name:"A",fragment:source,scale:0.5,format:"rgba8",channels:{0:{buffer:"A",frame:"previous"}}},
            {name:"B",fragment:source,scale:1,format:"rgba8",channels:{0:{buffer:"A",frame:"current"}}}
        ],imageChannels:{0:{buffer:"B",frame:"current"}}}),"프로젝트 생성 및 컴파일");
        ok(r.getPasses().length===2,"Buffer A/B 생성");
        ok(r.getImageChannels()[0].buffer==="B","Image 채널 연결");
        const frame = r.getStats().frame;
        r.setPassChannels("B",{0:{buffer:"A",frame:"previous"}});
        ok(r.getPassDefinitions()[1].channels[0].frame==="previous","재컴파일 없는 채널 연결 수정");
        ok(r.getStats().frame===frame,"채널 수정 시 프레임 번호 보존");
        let rejected=false;
        try {r.setPassChannels("A",{0:{buffer:"B",frame:"current"}});} catch(error) {rejected=true;}
        ok(rejected,"미래 패스 current 참조 거부");
        ok(r.getPassDefinitions()[0].channels[0].frame==="previous","잘못된 연결 시 기존 설정 유지");
        r.setPassFragment("B",source.replace("0.8","0.7"));
        ok(r.getPassDefinitions()[1].fragment.includes("0.7"),"Buffer GLSL 개별 갱신");
        console.log("Shader Studio 회귀 테스트 완료.");
    } finally {
        if(!studio.setProject(initial)) console.error("원래 Shader Studio 프로젝트 복원 실패");
        try {r.setPreviewPass(initialPreview && r.getPasses().some(p=>p.name===initialPreview) ? initialPreview : null);}catch(error){console.warn(error);}
    }
})();
