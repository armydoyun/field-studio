// 클립보드 API가 없는 곳(보안 연결이 아닌 http 주소 등)에서 복사 메뉴가 조용히 아무것도 하지 않으면 안 된다.
//  · 파라미터 줄 우클릭 › 이름 복사: 실패 안내(토스트)
//  · 편집기 우클릭 › 복사 · 붙여넣기: 실패 안내(편집기 상태 줄)
(async () => {
  const studio = window.shaderStudio,
    $ = id => document.getElementById(id);
  const test = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const frames = (n = 2) => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const wait = async (ok, n = 40) => { for (let i = 0; i < n && !ok(); i++) await frames(1); return ok(); };
  const menuItem = text => [...(document.querySelector("body > .ui-context-menu")?.querySelectorAll(".ui-menu-item") || [])].find(node => node.textContent.trim().startsWith(text));
  const right = node => {
    const box = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: box.left + 20, clientY: box.top + box.height / 2 }));
  };
  const before = studio.getProject(),
    wasOpen = !$("studioDock").hidden,
    own = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  try {
    test(studio.setProject({ image: "#version 300 es\nprecision highp float;\nuniform float uAmount; // @range 0 1\nout vec4 o;\nvoid main() { o = vec4(uAmount); }\n", passes: [], imageChannels: {} }), "파라미터 하나 있는 장면");
    await frames(4);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    // 파라미터 줄
    const row = [...document.querySelectorAll("#uniformList .uniform-row")].find(node => node.textContent.includes("uAmount"));
    test(!!row, "파라미터 줄");
    $("uiError").textContent = "";
    right(row);
    await frames(1);
    test(!!menuItem("이름 복사"), "줄 메뉴에 '이름 복사'");
    menuItem("이름 복사").click();
    test(await wait(() => /클립보드/.test($("uiError").textContent)), `이름 복사 실패를 알린다(${$("uiError").textContent})`);
    // 편집기
    studio.open();
    await frames(4);
    const content = document.querySelector(".studio-cm-host .cm-content");
    $("studioCode").setSelectionRange(0, 8);
    content.focus();
    await frames(1);
    const message = () => $("studioMessage").textContent;
    right(document.querySelector(".studio-cm-host .cm-line"));
    await frames(1);
    test(!!menuItem("복사"), "편집기 메뉴에 '복사'");
    menuItem("복사").click();
    test(await wait(() => /클립보드/.test(message())), `편집기 복사 실패를 알린다(${message()})`);
    right(document.querySelector(".studio-cm-host .cm-line"));
    await frames(1);
    menuItem("붙여넣기").click();
    test(await wait(() => /Ctrl\+V/.test(message())), `편집기 붙여넣기 실패를 알린다(${message()})`);
  } finally {
    if (own) Object.defineProperty(navigator, "clipboard", own);
    else delete navigator.clipboard;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    $("uiToast").hidden = true;
    studio.setProject(before);
    if (!wasOpen) studio.close();
  }
  console.log("클립보드 없는 환경 검사 통과");
})();
