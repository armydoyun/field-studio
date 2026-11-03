// 실제 WebGL2 지원 브라우저 콘솔에 전체 내용을 붙여 넣고 실행한다.
// 원래 프로젝트를 복원하지만, 테스트 중 피드백 버퍼 누적 값은 초기화될 수 있다.
(async () => {
  const studio = window.shaderStudio, r = window.shaderPlayground;
  if(!studio || !r) throw new Error("Shader Studio 초기화 후 실행해야 합니다.");
  const initial = studio.getProject(), eq = (condition, label) => {
    if(!condition) throw new Error("FAIL: " + label); console.log("PASS: " + label);
  };
  const src = `#version 300 es
precision highp float;
out vec4 fragColor;
void main(){fragColor=vec4(0.5, 0.2, 0.8, 1.0);}`;
  try {
    eq(typeof r.validateFragment === "function" && typeof r.resetSimulation === "function", "새 Renderer API");
    eq(r.validateFragment(src,true) === true, "GLSL 사전 컴파일");
    studio.open(); eq(!document.getElementById("studioDock").hidden, "Studio 열기");
    eq(document.getElementById("studioHighlight") && document.getElementById("studioLines"), "구문 강조 및 줄 번호 요소");
    eq(studio.setProject({image:src,passes:[{name:"A",fragment:src,format:"rgba8",scale:1,channels:{}}],imageChannels:{}}), "테스트 패스 컴파일");
    eq(r.getPasses().length===1, "Buffer 생성");
    const previous = r.getPassDefinitions()[0].fragment;
    let failed=false;
    try {r.validateFragment("#version 300 es\nprecision highp float;\ninvalid shader syntax",true);}
    catch (_) {failed=true;}
    eq(failed && r.getPassDefinitions()[0].fragment===previous,"컴파일 실패 시 기존 GPU 프로그램 보존");
    r.resetSimulation();eq(r.getStats().frame===0,"프레임 및 피드백 초기화");
    console.log("Shader Studio v2 회귀 검사 완료");
  } finally {
    if(!studio.setProject(initial)) console.error("테스트 전 프로젝트 복원 실패");
  }
})();
