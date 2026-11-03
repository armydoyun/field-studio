// 개발자 콘솔에서 실행. 실제 GPU/Texture 업로드와 채널 연결 확인 (원래 프로젝트는 복원).
(async () => {
  const renderer=window.shaderPlayground, studio=window.shaderStudio;
  if(!renderer||!studio)throw new Error("Shader Studio 실행 후 검사하세요.");
  const saved=studio.getProject(),wasRunning=renderer.getStats().running;
  const check=(ok,label)=>{if(!ok)throw new Error(`FAIL: ${label}`);console.log(`PASS: ${label}`);};
  const canvas=document.createElement("canvas");canvas.width=canvas.height=8;
  const ctx=canvas.getContext("2d");ctx.fillStyle="#ff0000";ctx.fillRect(0,0,8,8);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
  const source=new File([blob],"test-red.png",{type:"image/png"});let id=null;
  const fragment=`#version 300 es\nprecision highp float;\nuniform vec2 uResolution;\nuniform sampler2D iChannel0;\nout vec4 fragColor;\nvoid main(){fragColor=texture(iChannel0,gl_FragCoord.xy/uResolution);}`;
  try {
    const added=await renderer.addTexture(source);id=added.id;
    check(renderer.getTextures().some(x=>x.id===id&&x.width===8),"Texture 등록 및 디코딩");
    const next={image:fragment,passes:[],imageChannels:{0:{texture:id}}};
    check(studio.setProject(next),"로컬 이미지 Image 채널 연결");
    const screen=await renderer.captureScreenshot();check(screen.type==="image/png","GPU 화면 캡처");
    const bitmap=await createImageBitmap(screen),probe=document.createElement("canvas");
    probe.width=probe.height=1;const out=probe.getContext("2d");out.drawImage(bitmap,0,0,1,1);
    const red=out.getImageData(0,0,1,1).data;bitmap.close();
    check(red[0]>200&&red[1]<60&&red[2]<60,"GPU에서 빨간 Texture 픽셀을 샘플링");
    console.log("Texture 입력 실브라우저 검사 완료");
  } finally {
    if(!studio.setProject(saved))console.warn("기존 프로젝트 복원 실패: 확인 필요");
    if(id)await renderer.removeTexture(id);
    if(!wasRunning&&renderer.getStats().running)renderer.stop();
  }
})().catch(console.error);
