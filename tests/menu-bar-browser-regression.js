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
  let savedId = null;
  try {
    test([...$("menuBar").querySelectorAll(".ui-menubar-item:not(.menubar-compact)")].map(b => b.textContent).join() === "파일,편집,보기,재생,도움말", "메뉴 다섯 개");
    test(getComputedStyle(document.querySelector(".menubar-compact")).display === "none", "넓은 화면에서는 '메뉴' 하나로 접은 버튼이 숨음");
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
    // 메뉴 바와 겹치는 UI는 숨는다(버튼은 남아 단축키 · 메뉴 바가 누른다) — 메뉴 바를 끄면 다시 보인다
    const shown = id => !!$(id) && getComputedStyle($(id)).display !== "none";
    const overlap = () => ["studioUndo", "studioRedo", "studioResetFrames"].map(shown).concat(shown("moreToggle"), getComputedStyle(document.querySelector(".project-actions")).display !== "none");
    test(overlap().every(v => !v), "메뉴 바가 있으면 되돌리기 · 다시 실행 · 시간 초기화 · ⋯ · 프로젝트 메뉴 파일 작업은 숨김");
    document.body.classList.add("menubar-hidden");
    test(overlap().every(Boolean), "메뉴 바를 끄면 다시 보임");
    document.body.classList.remove("menubar-hidden");
    top("play").click();
    await until(() => openMenu(), "재생");
    test(item("시간 · 프레임 초기화"), "재생 › 시간 · 프레임 초기화");
    key("Escape");
    await until(() => !openMenu(), "재생 닫기");
    // 프로젝트 메뉴의 '파일 메뉴로' 항목: 프로젝트 메뉴를 닫고 메뉴 바의 파일 메뉴를 연다
    $("projectMenuToggle").click();
    await until(() => !$("projectMenu").hidden, "프로젝트 메뉴");
    $("projectFileMenu").click();
    await until(() => top("file").getAttribute("aria-expanded") === "true" && $("projectMenu").hidden, "파일 메뉴로 넘어감");
    key("Escape");
    await until(() => !openMenu(), "파일 닫기");
    // 보기 › 편집기 배치 · 도움말 항목
    top("view").click();
    await until(() => openMenu(), "보기");
    test(item("편집기를 캔버스 오른쪽에") && item("집중 모드") && item("미리보기는 별도 창"), "보기 › 편집기 배치 세 가지");
    key("Escape");
    await until(() => !openMenu(), "보기 닫기");
    top("help").click();
    await until(() => openMenu(), "도움말");
    test(item("둘러보기") && item("기법 배우기") && item("단축키 목록"), "도움말 › 둘러보기 · 기법 배우기 · 단축키 목록");
    item("단축키 목록").click();
    await until(() => $("quickHelp").open && /단축키/.test($("guideContent").textContent), "단축키 목록을 가이드에서 연다");
    $("quickHelp").close();
    // 명령 팔레트: 메뉴 항목이 '메뉴 › 항목'으로, 같은 버튼을 누르는 명령은 하나만
    $("studioToggle").getAttribute("aria-expanded") !== "true" && $("studioToggle").click();
    await wait(50);
    $("studioPaletteOpen").click();
    await until(() => !document.querySelector(".studio-palette").hidden, "팔레트");
    const paletteInput = document.querySelector(".studio-palette-input");
    const search = async query => {
      paletteInput.value = `>${query}`;
      paletteInput.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(30);
      return [...document.querySelectorAll(".studio-palette-list button")].map(b => b.textContent);
    };
    const frames = await search("프레임");
    test(frames.some(text => text.startsWith("재생 › 한 프레임 진행")), `팔레트에 메뉴 바 항목(재생 › 한 프레임 진행): ${frames.join(" | ")}`);
    test(frames.filter(text => /시간.*프레임 초기화/.test(text)).length === 1, "같은 버튼(시간 초기화)을 누르는 명령은 팔레트에 하나만");
    test((await search("둘러보기")).some(text => text.startsWith("도움말 › 둘러보기")), "팔레트에 도움말 › 둘러보기");
    const exports = await search("프로젝트 파일");
    test(!exports.some(text => text.startsWith("파일 › 프로젝트 파일로 내보내기")) && exports.some(text => text.startsWith("프로젝트 파일 내보내기")), `같은 버튼을 누르는 명령은 하나만(${exports.join(" | ")})`);
    paletteInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    // 파일 › 최근 프로젝트: 저장하면 보관함의 최근 항목이 파일 메뉴에(지금 작업에 체크)
    const P = window.shaderStudio.projects, name = `메뉴 바 최근 ${Date.now().toString(36)}`;
    await P.ready();
    const saving = P.save(false);
    await until(() => $("studioPromptDialog").open, "이름 묻기");
    $("studioDialogInput").value = name;
    $("studioDialogForm").requestSubmit();
    test(await saving, "보관함에 저장");
    savedId = P.current()?.id;
    top("file").click();
    await until(() => item(name), "파일 › 최근 프로젝트에 저장한 이름");
    test([...openMenu().querySelectorAll(".ui-menu-title")].some(n => n.textContent === "최근 프로젝트") && item(name).getAttribute("aria-pressed") === "true", "최근 프로젝트 제목 · 지금 작업에 체크");
    key("Escape");
    await until(() => !openMenu(), "파일 닫기");
    // 창보다 긴 메뉴: 놓인 자리부터 창 아래까지만 차지하고 안에서 스크롤한다(창이 낮으면 아래 항목이 잘리던 것)
    {
      const UI = await import("./js/ui-kit.js");
      const tall = UI.menu({ anchor: top("view"), items: Array.from({ length: 80 }, (_, i) => ({ label: `항목 ${i + 1}`, onSelect() {} })) });
      const box = tall.element.getBoundingClientRect();
      test(box.top >= top("view").getBoundingClientRect().bottom && box.bottom <= innerHeight - 8 + 0.5, `긴 메뉴도 창 안에(아래 ${Math.round(box.bottom)} / 창 ${innerHeight})`);
      test(tall.element.scrollHeight > tall.element.clientHeight, "넘치는 항목은 메뉴 안에서 스크롤");
      const last = [...tall.element.querySelectorAll('[role="menuitem"]')].at(-1);
      last.focus();
      const lastBox = last.getBoundingClientRect();
      test(lastBox.bottom <= tall.element.getBoundingClientRect().bottom + 0.5, "마지막 항목으로 가면 스크롤되어 보임");
      tall.close({ focus: false });
    }
    // F10: 메뉴 바로 초점 · →로 옆 이름 · ↓로 열기
    document.body.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", bubbles: true, cancelable: true }));
    test(document.activeElement?.classList.contains("ui-menubar-item"), "F10으로 메뉴 바에 초점");
    const first = document.activeElement;
    key("ArrowRight");
    test(document.activeElement === first.nextElementSibling, "메뉴 바에서 →로 옆 이름");
    key("ArrowDown");
    await until(() => openMenu() && document.activeElement === items().find(node => !node.disabled), "↓로 열고 첫 항목(꺼진 항목은 건너뜀)");
    key("Escape");
    await until(() => !openMenu(), "닫기");
    // 숨긴 상태에서도 복구: HUD가 없어 더보기 버튼을 누를 수 없어도 F10은 동작한다.
    const hideBar = () => { top("view").click(); item("메뉴 바").click(); };
    const restored = () => !document.body.classList.contains("menubar-hidden") && $("appBar").getClientRects().length > 0;
    hideBar();
    test(document.body.classList.contains("menubar-hidden") && document.activeElement === $("moreToggle"), "메뉴 바 숨기기 뒤 더보기 버튼에 초점");
    const hudWasHidden = $("stage").classList.contains("hud-hidden");
    try {
      if (!hudWasHidden) $("hudToggle").click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
      test(!restored(), "Shift+F10은 메뉴 바를 복구하지 않음");
      const event = new KeyboardEvent("keydown", { key: "F10", bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      test(event.defaultPrevented && restored(), "HUD와 메뉴 바를 모두 숨겨도 F10으로 메뉴 바 복구");
      test(document.activeElement?.classList.contains("ui-menubar-item"), "복구 뒤 메뉴 바에 초점");
      test(localStorage.getItem("field.menubar-hidden.v1") === "0" && $("menuBarShow").hidden, "복구 상태 저장 및 보이기 항목 숨김");
      // 마우스만으로도 바탕과 뷰포트에서 복구할 수 있다.
      for (const target of [document.body, $("screen")]) {
        hideBar();
        target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 }));
        const show = [...document.querySelectorAll('.ui-context-menu [role="menuitem"]')].find(node => node.textContent.startsWith("메뉴 바 보이기"));
        test(!!show, `${target.id || "바탕"} 우클릭에 메뉴 바 보이기`);
        show.click();
        test(restored() && document.activeElement?.classList.contains("ui-menubar-item"), "우클릭 메뉴로 복구하고 메뉴 바에 초점");
      }
    } finally {
      if (document.body.classList.contains("menubar-hidden")) $("menuBarShow").click();
      if ($("stage").classList.contains("hud-hidden") !== hudWasHidden) $("hudToggle").click();
    }
  } finally {
    openMenu()?.remove();
    if ($("quickHelp").open) $("quickHelp").close();
    // 만든 프로젝트는 지운다(지우기 확인에 답한다)
    if (savedId) {
      const removing = window.shaderStudio.projects.remove(savedId);
      await until(() => $("studioPromptDialog").open, "지우기 확인").catch(() => {});
      if ($("studioPromptDialog").open) $("studioDialogOK").click();
      await removing;
    }
    if (!editorWasOpen && $("studioToggle").getAttribute("aria-expanded") === "true") $("studioToggle").click();
    $("tab-uniforms").click();
  }
  console.log("메뉴 바 검사 통과");
})();
