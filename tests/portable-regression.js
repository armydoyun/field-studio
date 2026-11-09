// 실브라우저 콘솔 검사. GPU 피드백은 초기화될 수 있으므로 테스트 전에 프로젝트를 저장한다.
// Shader Studio가 초기화된 뒤 이 파일의 내용을 개발자 콘솔에서 실행한다.
(async () => {
  // 작업을 바꿀 때 뜨는 '저장하지 않은 변경' 확인에는 '저장하지 않고 계속'으로 답한다(이 검사는 보관함 저장을 다루지 않는다).
  setInterval(() => { const d = document.getElementById("studioPromptDialog"), b = document.getElementById("studioDialogAlt"); if (d?.open && document.getElementById("studioDialogTitle").textContent === "저장하지 않은 변경") (b.hidden ? document.getElementById("studioDialogOK") : b).click(); }, 10);
    const r = window.shaderPlayground, studio = window.shaderStudio, settings = window.shaderSettings;
    if (!r || !studio) throw new Error("Shader Studio 초기화 후 실행하세요.");
    const assert = (ok, name) => { if (!ok) throw new Error(`FAIL: ${name}`); console.log(`PASS: ${name}`); };
    const before = studio.getProject(), initial = settings.snapshot(), oldIds = new Set(r.getTextures().map(x => x.id));
    let originalURL = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click, output = null;
    try {
        const canvas = document.createElement("canvas");canvas.width=canvas.height=2;
        const image = await new Promise(resolve => canvas.toBlob(resolve,"image/png"));
        const added = await r.addTexture(new File([image],"portable-test.png",{type:"image/png"}));
        await r.setTextureSampling(added.id,{filter:"nearest",wrapS:"repeat",wrapT:"mirror"});
        const testProject = structuredClone(before);
        testProject.imageChannels = {...testProject.imageChannels, 3:{texture:added.id}};
        assert(studio.setProject(testProject), "테스트 이미지 채널 연결");
        r.defineUniform("uPackFreezeTest", "float", .75, {min:0,max:1,step:.05});
        r.setFpsLimit(37);r.setRaymarchSettings({maxSteps:192});
        URL.createObjectURL = blob => {output=blob;return "blob:test";};
        HTMLAnchorElement.prototype.click = function() {};
        try { await studio.exportPack(); } finally {
            URL.createObjectURL=originalURL;HTMLAnchorElement.prototype.click=originalClick;
        }
        const pack = JSON.parse(await output.text());
        assert(pack.version===3 && pack.settings?.user && pack.textures.some(x=>x.id===added.id),"Pack v3 이미지/전역 설정 동시 포함");
        assert(pack.settings.user.some(x=>x.name==="uPackFreezeTest") && pack.settings.rendering.fpsLimit===37 && pack.settings.raymarch.maxSteps===192,"사용자 Uniform/FPS/Ray Marching 설정 저장");
        assert(pack.textures.find(x=>x.id===added.id).sampling.wrapS==="repeat","샘플링 설정 포함");
        r.removeUniform("uPackFreezeTest");r.setFpsLimit(60);r.setRaymarchSettings({maxSteps:64});
        assert(await studio.importPack(new File([JSON.stringify(pack)],"test-pack.json")),"Pack 다시 불러오기");
        assert(r.getUserUniforms().some(x=>x.name==="uPackFreezeTest"&&x.value===.75) && r.getStats().fpsLimit===37 && r.getRaymarchSettings().maxSteps===192,"사용자 Uniform/전역 설정 복원");
        const current=studio.getProject(),newId=current.imageChannels[3].texture;
        assert(newId!==added.id && !!r.getTextureFile(newId),"Texture ID 재매핑");
        assert(r.getTextures().find(x=>x.id===newId).sampling.filter==="nearest","설정 복원");
        const count=r.getTextures().length,broken=structuredClone(pack);
        broken.textures.find(x=>x.id===added.id).data="data:image/png;base64,!!!";
        await assertReject(studio.importPack(new File([JSON.stringify(broken)],"bad-pack.json")),"손상된 Pack 거부");
        assert(r.getTextures().length===count,"실패 후 리소스 상태 보존");
        const badSetting=structuredClone(pack);badSetting.settings.rendering.fpsLimit=-5;
        await assertReject(studio.importPack(new File([JSON.stringify(badSetting)],"bad-setting.json")),"잘못된 FPS 설정 사전 거부");
        assert(r.getStats().fpsLimit===37 && r.getTextures().length===count,"잘못된 Pack은 기존 설정/Texture 유지");
        const legacy=structuredClone(pack);legacy.version=2;delete legacy.settings;
        assert(await studio.importPack(new File([JSON.stringify(legacy)],"legacy-pack.json")),"Pack v2 가져오기 호환");
        assert(r.getStats().fpsLimit===37,"v2 Pack은 기존 전역 설정 보존");
    } finally {
        URL.createObjectURL=originalURL;HTMLAnchorElement.prototype.click=originalClick;
        r.applyPortable(before,initial.user);studio.loadFromRenderer();settings.applyPack(initial);
        for(const item of r.getTextures()) if(!oldIds.has(item.id)) await r.removeTexture(item.id);
    }
    console.log("Portable Pack 검증 완료");
    async function assertReject(promise,name) {
        let failed=false;try {await promise;} catch (_) {failed=true;} assert(failed,name);
    }
})();
