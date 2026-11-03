// 실제 WebGL2 브라우저 콘솔에 붙여넣어 실행. 프로젝트 소스는 검사 후 복원한다.
// 실행 전 중요한 미적용 편집본과 버퍼 누적 데이터는 별도로 저장할 것.
(async () => {
    const r=window.shaderPlayground,studio=window.shaderStudio;
    if(!r||!studio)throw new Error("Shader Studio 실행 후 테스트하세요.");
    const before=studio.getProject(),wasRunning=r.getStats().running;
    const test=(condition,label)=>{if(!condition)throw new Error(`FAIL: ${label}`);console.log(`PASS: ${label}`);};
    const fragment=`#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){fragColor=vec4(.2,.5,.7,1.);}`;
    const one={image:fragment,passes:[{name:"A",fragment,format:"rgba8",scale:.5,channels:{0:{buffer:"A",frame:"previous"}}}],imageChannels:{0:{buffer:"A",frame:"current"}}};
    try {
        test(typeof r.captureScreenshot==="function","PNG API 노출");
        test(r.validatePassConfiguration(one.passes,one.imageChannels)===true,"유효한 패스 구조");
        test(studio.setProject(one),"GPU 프로그램 실제 컴파일");
        test(r.getPasses().length===1,"패스 생성");
        const keep=JSON.stringify(r.getPassDefinitions());
        const wrong=[{...one.passes[0],channels:{0:{buffer:"A",frame:"current"}}}];
        let rejected=false;try{r.validatePassConfiguration(wrong,{});}catch(_){rejected=true;}
        test(rejected&&JSON.stringify(r.getPassDefinitions())===keep,"잘못된 피드백 연결 원자적 거부");
        test(studio.undo(),"Undo 이전 프로젝트로 복귀");
        test(studio.redo()&&r.getPasses().length===1,"Redo 적용 상태 복구");
        const screenshot=await r.captureScreenshot();
        const bytes=new Uint8Array(await screenshot.slice(0,8).arrayBuffer());
        test(screenshot.type==="image/png"&&bytes.join(",")==="137,80,78,71,13,10,26,10","실제 GPU 출력 PNG 캡처");
        test(r.getStats().bufferMemoryBytes>=0,"GPU 버퍼 추정 메모리 조회");
        console.log("Shader Studio v3 브라우저 검증 통과");
    } finally {
        if(!studio.setProject(before)) console.error("테스트 이전 프로젝트 복원 실패: 수동 확인 필요");
        if(!wasRunning&&r.getStats().running)r.stop();
    }
})().catch(console.error);
