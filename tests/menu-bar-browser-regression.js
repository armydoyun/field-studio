// 창 맨 위 메뉴 바(js/menu-bar.js · ui-menubar):
//  · 파일 · 편집 · 보기 · 재생 · 도움말. 누르면 펼침 메뉴(ui-menu) · ←→로 옆 메뉴 · 열린 동안 옆 이름에 올리면 그 메뉴로 · Esc로 닫기
//  · 항목은 기존 버튼을 누른다 — 켜짐 표시(설정 패널 · 타임라인 · 지금 탭)와 숨은 동작(이름 없는 작업의 '다른 이름으로 저장')이 버튼과 같다
//  · 편집 명령은 편집기를 먼저 연다 · F10으로 메뉴 바에 초점 · 작업 공간은 메뉴 바 아래 남은 높이를 쓴다
(async () => {
  const $ = id => document.getElementById(id);
  const test = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return;
    throw new Error(`FAIL: 시간 초과 — ${label}`);
  };
  const top = name => document.querySelector(`#menuBar [data-menu="${name}"]`);
  const openMenu = () => document.querySelector('.ui-menu[role="menu"]');
  const items = () => [...(openMenu()?.querySelectorAll('[role="menuitem"]') || [])];
  const item = text => items().find(node => node.textContent.startsWith(text));
  const key = (name, target = document.activeElement) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  const editorWasOpen = $("studioToggle").getAttribute("aria-expanded") === "true";
  try {
    test([...$("menuBar").querySelectorAll(".ui-menubar-item")].map(b => b.textContent).join() === "파일,편집,보기,재생,도움말", "메뉴 다섯 개");
    test(document.querySelector(".app-brand") && !document.querySelector("#panel .brand-lockup"), "브랜드는 앱 막대로(패널 머리에는 없음)");
    const bar = $("appBar").getBoundingClientRect(), ws = $("workspace").getBoundingClientRect();
    test(Math.abs(ws.top - bar.bottom) < 1 && Math.abs(ws.bottom - innerHeight) < 1, `작업 공간은 메뉴 바 아래 남은 높이(${bar.height}px 막대)`);
    // 열기 · 첫 항목 초점 · 이름 없는 작업에는 '다른 이름으로 저장'이 없다(버튼이 숨겨져 있음)
    top("file").click();
    await until(() => openMenu(), "파일 메뉴");
    test(top("file").getAttribute("aria-expanded") === "true" && document.activeElement === items()[0], "열면 첫 항목에 초점");
    test(item("저장") && !item("다른 이름으로 저장"), "이름 없는 작업: 저장만(다른 이름으로 저장 없음)");
    // ←→로 옆 메뉴
    key("ArrowRight");
    await until(() => top("edit").getAttribute("aria-expanded") === "true", "→로 편집 메뉴");
    test(top("file").getAttribute("aria-expanded") === "false" && document.querySelectorAll('.ui-menu[role="menu"]').length === 1, "한 번에 하나만 열림");
    key("ArrowLeft");
    await until(() => top("file").getAttribute("aria-expanded") === "true", "←로 다시 파일");
    // 열린 동안 옆 이름에 올리면 그 메뉴로
    top("view").dispatchEvent(new PointerEvent("pointerenter"));
    await until(() => top("view").getAttribute("aria-expanded") === "true", "올리기만 해도 보기 메뉴로");
    test(item("설정 패널")?.getAttribute("aria-pressed") === "true", "보기 > 설정 패널: 켜짐 표시");
    test(item("파라미터")?.getAttribute("aria-pressed") === "true" && item("렌더링")?.getAttribute("aria-pressed") === "false", "지금 패널 탭에 체크");
    // 항목은 기존 버튼을 누른다: 렌더링 탭 · 타임라인
    item("렌더링").click();
    await until(() => $("tab-render").getAttribute("aria-selected") === "true", "렌더링 탭으로");
    test(!openMenu(), "항목을 누르면 메뉴가 닫힘");
    top("view").click();
    await until(() => openMenu(), "보기 다시");
    const timelineBefore = item("타임라인").getAttribute("aria-pressed");
    item("타임라인").click();
    await until(() => !$("timelineDock").hidden === (timelineBefore !== "true"), "타임라인 켜고 끄기");
    top("view").click();
    await until(() => openMenu(), "보기 다시");
    test(item("타임라인").getAttribute("aria-pressed") !== timelineBefore, "다시 열면 타임라인 표시가 바뀜");
    item("타임라인").click();
    $("tab-uniforms").click();
    // Esc로 닫고 메뉴 이름에 초점
    top("help").click();
    await until(() => openMenu(), "도움말");
    test(item("가이드") && item("예제 갤러리"), "도움말: 가이드 · 예제 갤러리");
    key("Escape");
    await until(() => !openMenu(), "Esc로 닫힘");
    test(document.activeElement === top("help"), "Esc 뒤 초점은 메뉴 이름");
    // 편집 명령은 편집기를 먼저 연다
    if (editorWasOpen) $("studioToggle").click();
    await wait(50);
    top("edit").click();
    await until(() => openMenu(), "편집");
    item("찾기").click();
    await until(() => $("studioToggle").getAttribute("aria-expanded") === "true", "찾기를 고르면 편집기가 열림");
    // F10: 메뉴 바로 초점 · →로 옆 이름 · ↓로 열기
    document.body.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", bubbles: true, cancelable: true }));
    test(document.activeElement?.classList.contains("ui-menubar-item"), "F10으로 메뉴 바에 초점");
    const first = document.activeElement;
    key("ArrowRight");
    test(document.activeElement === first.nextElementSibling, "메뉴 바에서 →로 옆 이름");
    key("ArrowDown");
    await until(() => openMenu() && document.activeElement === items()[0], "↓로 열고 첫 항목");
    key("Escape");
    await until(() => !openMenu(), "닫기");
  } finally {
    openMenu()?.remove();
    if (!editorWasOpen && $("studioToggle").getAttribute("aria-expanded") === "true") $("studioToggle").click();
    $("tab-uniforms").click();
  }
  console.log("메뉴 바 검사 통과");
})();
