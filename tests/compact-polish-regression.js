// 브라우저 콘솔에서 실행. 미적용 편집본이 없는 상태에서만 시작한다. 키 입력은 CodeMirror 화면(.cm-content)으로 보낸다.
(() => {
  const $=id=>document.getElementById(id), studio=window.shaderStudio, area=$("studioCode");
  if(!studio || !area) throw new Error("Shader Studio가 초기화되지 않았습니다.");
  if($("studioMessage").classList.contains("is-dirty")) throw new Error("미적용 편집본을 먼저 적용해 주세요.");
  const savedCode=area.value, savedIndent=$("studioIndent").value, live=$("studioLive"), wasLive=live.checked;
  const check=(ok,name)=>{if(!ok)throw new Error(`FAIL: ${name}`);console.log(`PASS: ${name}`);};
  const key=(name,extra={})=>document.querySelector(".cm-content").dispatchEvent(new KeyboardEvent("keydown",{key:name,bubbles:true,cancelable:true,...extra}));
  studio.open();live.checked=false;live.dispatchEvent(new Event("change"));
  try {
    $("studioIndent").value="2";$("studioIndent").dispatchEvent(new Event("change"));
    area.value="void main() {";area.setSelectionRange(13,13);key("Enter");
    check(area.value==="void main() {\n  ","2칸 자동 들여쓰기");key("Tab");
    check(area.value==="void main() {\n    ","Tab 2칸 삽입");key("Backspace");
    check(area.value==="void main() {\n  ","Backspace 단위 삭제");
    area.value="a\nb";area.setSelectionRange(0,3);key("Tab");check(area.value==="  a\n  b","다중 행 들여쓰기");
    key("Tab",{shiftKey:true});check(area.value==="a\nb","다중 행 내어쓰기");
    area.value="x";area.setSelectionRange(1,1);key("]",{code:"BracketRight",ctrlKey:true});
    check(area.value==="  x","Ctrl+] 행 들여쓰기");key("[",{code:"BracketLeft",ctrlKey:true});
    check(area.value==="x","Ctrl+[ 행 내어쓰기");
    check($("studioPassTabs").getAttribute("role")==="tablist","패스 탭 키보드 내비게이션 제공");
    console.log("Shader Studio 최종 경량화 편집 테스트 통과");
  } finally {
    area.value=savedCode;area.dispatchEvent(new Event("input",{bubbles:true}));
    studio.apply();$("studioIndent").value=savedIndent;$("studioIndent").dispatchEvent(new Event("change"));
    live.checked=wasLive;live.dispatchEvent(new Event("change"));
  }
})();
