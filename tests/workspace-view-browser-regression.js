// 표시 상태·메뉴 접근성·포커스가 버튼/단축키/메뉴에서 같은지 실제 DOM으로 검사한다.
(async () => {
  const $ = id => document.getElementById(id);
  const check = (ok, label) => { if (!ok) throw new Error(label); console.log(`PASS ${label}`); };
  const key = name => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  const visible = node => !!node && !node.hidden && node.getClientRects().length > 0;
  const hiddenPanel = () => document.body.classList.contains("panel-hidden");
  const view = () => document.querySelector('#menuBar [data-menu="view"]');
  const item = label => [...document.querySelectorAll('.ui-menu[role="menu"] [role^="menuitem"]')].find(node => node.textContent.startsWith(label));
  const assertPanel = hidden => {
    check(hiddenPanel() === hidden && $("panelToggle").getAttribute("aria-pressed") === String(!hidden), "패널 표시와 버튼 상태 일치");
    check(JSON.parse(localStorage.getItem("webgl.raymarch-template.settings.v1")).panelHidden === hidden, "패널 변경 즉시 저장");
  };
  try {
    $("panelToggle").click(); assertPanel(true);
    key("h"); assertPanel(false);
    view().click(); item("설정 패널").click(); assertPanel(true);
    document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    item("설정 패널").click(); assertPanel(false);

    // 열린 캡처 메뉴에서 G로 HUD를 숨기면 화면과 aria-expanded를 함께 닫는다.
    $("captureToggle").click(); key("g");
    check($("stage").classList.contains("hud-hidden"), "G로 HUD 숨기기");
    for (const prefix of ["capture", "more"])
      check($(prefix + "Menu").hidden && $(prefix + "Toggle").getAttribute("aria-expanded") === "false", `${prefix} 메뉴 화면·접근성 상태 닫힘`);
    check(document.activeElement === $("hudReveal"), "사라진 툴바 대신 HUD 복구 버튼에 초점");
    key("Escape");
    check(!$("stage").classList.contains("hud-hidden") && visible(document.activeElement), "Esc 복구 뒤 보이는 조작에 초점");

    // 더보기를 연 상태에서 F10으로 복구해도 유령 메뉴가 남지 않는다.
    view().click(); item("메뉴 바").click();
    $("moreToggle").click(); key("F10");
    check(!document.body.classList.contains("menubar-hidden") && $("moreMenu").hidden, "F10 복구 후 더보기 메뉴 닫힘");
    check($("moreToggle").getAttribute("aria-expanded") === "false", "숨겨진 더보기 버튼의 접근성 상태 닫힘");

    // 닫기 버튼을 누르면 숨겨진 타임라인 안에 초점이 남지 않는다.
    if ($("timelineDock").hidden) $("timelineToggle").click();
    const close = $("timelineDock").querySelector('button[aria-label="타임라인 닫기"]');
    check(!!close, "타임라인 닫기 버튼");
    close.focus(); close.click();
    check($("timelineDock").hidden && !$("timelineDock").contains(document.activeElement) && visible(document.activeElement), "타임라인 닫기 후 보이는 조작에 초점");

    // 메뉴 바·HUD가 숨겨진 편집기에서도 닫은 뒤 초점이 사라지지 않는다.
    view().click(); item("메뉴 바").click();
    window.shaderStudio.open();
    $("hudToggle").click();
    $("studioHide").focus(); $("studioHide").click();
    check($("studioDock").hidden && document.activeElement === $("hudReveal"), "HUD가 숨겨져도 편집기 닫기 뒤 복구 조작에 초점");
  } finally {
    if (document.body.classList.contains("menubar-hidden")) $("menuBarShow").click();
    if ($("stage").classList.contains("hud-hidden")) $("hudReveal").click();
    if (hiddenPanel()) $("panelToggle").click();
  }
})();
