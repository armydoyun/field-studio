// Shader Studio를 연 뒤 브라우저 콘솔에서 실행한다. 미적용 코드가 없을 때만 동작한다.
(() => {
    const studio=window.shaderStudio, $=id=>document.getElementById(id);
    if(!studio) throw new Error("Shader Studio가 초기화되지 않았습니다.");
    if($("studioMessage").classList.contains("is-dirty")) throw new Error("먼저 편집 중인 코드를 적용하거나 저장하세요.");
    const area=$("studioCode"), live=$("studioLive"), previous=area.value, wasLive=live.checked;
    const check=(ok,label)=>{if(!ok)throw new Error(`FAIL: ${label}`);console.log(`PASS: ${label}`);};
    studio.open();live.checked=false;live.dispatchEvent(new Event("change"));
    try {
        area.value="void main() {";area.setSelectionRange(area.value.length,area.value.length);
        area.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
        check(area.value==="void main() {\n    ","Enter 자동 들여쓰기");
        area.value="abc\ndef";area.setSelectionRange(4,4);
        area.dispatchEvent(new KeyboardEvent("keydown",{key:"D",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
        check(area.value==="abc\ndef\ndef","Ctrl+Shift+D 현재 줄 복제");
        area.value="";area.setSelectionRange(0,0);$("studioSampleUV").click();
        check(area.value==="texture(iChannel0, gl_FragCoord.xy / uResolution)","UV 샘플 코드 삽입");
        area.value="";area.setSelectionRange(0,0);$("studioSamplePixel").click();
        check(area.value==="texelFetch(iChannel0, ivec2(gl_FragCoord.xy), 0)","정수 좌표 샘플 코드 삽입");
        check(!!$("studioOpenGLSL") && !!$("studioSaveGLSL") && !!$("studioGLSLFile"),"GLSL 파일 열기·저장 컨트롤");
        console.log("Shader Studio UX 회귀 검사 통과");
    } finally {
        area.value=previous;area.dispatchEvent(new Event("input",{bubbles:true}));
        studio.apply();live.checked=wasLive;live.dispatchEvent(new Event("change"));
    }
})();
