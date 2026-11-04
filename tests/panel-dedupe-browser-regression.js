// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 같은 기능이 두 곳에 있던 UI를 한 곳으로 모은 뒤의 계약: 지운 요소는 없어야 하고, 남은 길은 제대로 이어져야 한다.
(async () => {
  const $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  for (const id of ["studioInspector", "studioInspect", "studioPixelReadout", "bufferPreview", "bufferInfo", "bufferDemo", "bufferClear"])
    test(!$(id), `중복 UI 제거: #${id}`);
  test(!!$("profilePixel"), "픽셀 값 읽기는 성능 탭 버퍼 뷰어에 남음");

  // 렌더링 탭 → 버퍼 뷰어 열기 → 성능 탭으로 이동
  document.body.classList.remove("panel-hidden");
  $("tab-render").click();
  test(!$("view-render").hidden, "렌더링 탭 표시");
  $("openBufferViewer").click();
  test(!$("view-profile").hidden && $("view-render").hidden, "버퍼 뷰어 열기 → 성능 탭");
  test($("tab-profile").getAttribute("aria-selected") === "true", "성능 탭 선택 표시");

  // 가이드의 정적 HTML은 지웠고, 열면 guide.js가 주제를 그린다.
  const shortcut = document.querySelector('#view-input [data-guide="shortcuts"]');
  test(!!shortcut, "작업공간 탭에 단축키 전체 보기 버튼");
  $("tab-input").click();
  shortcut.click();
  const dialog = $("quickHelp");
  await new Promise(resolve => setTimeout(resolve, 50));
  test(dialog.open, "단축키 전체 보기 → 가이드 열림");
  test(/단축키/.test($("guideContent").querySelector("header")?.textContent || ""), "가이드가 단축키 주제를 표시");
  test($("guideContent").textContent.includes("Ctrl+S"), "가이드 단축키 목록 내용");
  $("helpClose").click();
  $("tab-render").click();
})();
