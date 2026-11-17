// 명령의 이름·단축키·상태를 서로 다른 실제 메뉴에서 비교한다.
(async () => {
  const $ = id => document.getElementById(id);
  const check = (ok, label) => { if (!ok) throw new Error(label); console.log(`PASS ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async read => { for (let i = 0; i < 150; i++, await wait(20)) if (read()) return; throw new Error("메뉴 대기 시간 초과"); };
  const menu = () => document.querySelector('.ui-menu[role="menu"]');
  const labelOf = node => node.querySelector(':scope > span:not([aria-hidden="true"])')?.textContent;
  const item = text => [...menu().querySelectorAll('[role="menuitem"]')].find(node => labelOf(node) === text);
  const read = node => ({ label: labelOf(node), keys: [...node.querySelectorAll("kbd")].map(key => key.textContent), pressed: node.getAttribute("aria-pressed"), disabled: node.disabled });
  const close = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  const top = async name => { document.querySelector(`#menuBar [data-menu="${name}"]`).click(); await until(menu); };
  const right = target => target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
  const editorWasOpen = !$("studioDock").hidden, timelineWasOpen = !$("timelineDock").hidden;
  const originalTheme = document.documentElement.dataset.theme;
  const disabled = $("fullscreenToggle").disabled;
  try {
    for (const theme of ["dark", "light"]) {
      document.documentElement.dataset.theme = theme;
      const snapshots = {};
      await top("view");
      for (const name of ["설정 패널", "셰이더 편집기", "타임라인", "HUD"]) snapshots[name] = read(item(name));
      check(item($("studioLayout").textContent)?.querySelector("kbd").textContent === "Ctrl+\\", "배치 이름은 실제 다음 동작, 단축키는 별도 표시");
      close();
      right(document.body);
      for (const name of ["설정 패널", "셰이더 편집기", "타임라인"])
        check(JSON.stringify(read(item(name))) === JSON.stringify(snapshots[name]), `${theme}: 보기와 바탕 우클릭의 ${name} 이름·키·상태 일치`);
      item("셰이더 편집기").click();
      await top("view");
      check(item("셰이더 편집기").getAttribute("aria-pressed") === String(!editorWasOpen), "우클릭 실행 뒤 보기 메뉴 체크 갱신");
      item("셰이더 편집기").click();

      right($("screen"));
      check(JSON.stringify(read(item("HUD"))) === JSON.stringify(snapshots.HUD), "HUD 이름·키·체크 상태 일치");
      item("HUD").click();
      await top("view");
      check(item("HUD").getAttribute("aria-pressed") === "false", "HUD를 숨기면 보기 메뉴 체크 해제");
      item("HUD").click();
      await top("view"); item("메뉴 바").click();
      $("moreToggle").click();
      check(labelOf($("menuBarShow")) === "메뉴 바 보이기" && $("menuBarShow").querySelectorAll("kbd").length === 1, "더보기 이름과 단축키 분리");
      check(labelOf($("timelineToggle")) === "타임라인", "더보기와 보기의 타임라인 이름 일치");
      const restore = read($("menuBarShow"));
      $("moreToggle").click();
      for (const target of [document.body, $("screen")]) {
        right(target);
        check(JSON.stringify(read(item("메뉴 바 보이기"))) === JSON.stringify(restore), "우클릭 복구 이름·F10 표시 1개·상태 일치");
        close();
      }
      $("menuBarShow").click();
    }

    // 표시가 고정돼 있던 전체화면 항목도 원본 버튼의 현재 동작·비활성 상태를 따른다.
    $("fullscreenToggle").setAttribute("aria-label", "전체화면 종료");
    $("fullscreenToggle").disabled = true;
    await top("view"); check(item("전체화면 종료").disabled, "보기: 전체화면 현재 동작·비활성 상태"); close();
    right($("screen")); check(item("전체화면 종료").disabled, "우클릭: 전체화면 현재 동작·비활성 상태"); close();
    $("fullscreenToggle").disabled = disabled;
    document.dispatchEvent(new Event("preview-popout-changed"));

    // 편집기에서 재생을 바꾼 직후에도 500ms 통계 갱신을 기다리지 않고 현재 동작을 표시한다.
    const wasPlaying = window.shaderStudio.getPlaybackState();
    $("studioPause").click();
    const nextPlayback = wasPlaying ? "재생" : "일시정지";
    await top("play");
    const playbackAction = read(item(nextPlayback)); close();
    right($("screen"));
    check(JSON.stringify(read(item(nextPlayback))) === JSON.stringify(playbackAction), "편집기 재생 전환 직후 메뉴 바와 우클릭 동작 일치");
    close(); $("studioPause").click();

    // 파일 형식·장식·키 이름을 버튼 본문에서 읽어 명령 이름에 붙이지 않는다.
    const Commands = await import("./js/menu-commands.js"), probe = document.createElement("button");
    probe.innerHTML = '<span aria-hidden="true">장식</span><span>파일 열기</span><kbd>PNG · JPEG</kbd>';
    check(Commands.item(() => probe, "probe").label === "파일 열기", "보조 텍스트를 뺀 이름 추출");
    let clicks = 0; probe.onclick = () => clicks++;
    const stale = Commands.item(() => probe, "probe"); probe.disabled = true; stale.onSelect();
    check(clicks === 0, "메뉴를 만든 뒤 비활성화된 명령도 실행 차단");

    window.shaderStudio.open(); $("studioPaletteOpen").click();
    await until(() => !document.querySelector(".studio-palette").hidden);
    const input = document.querySelector(".studio-palette-input");
    const search = async query => {
      input.value = ">" + query; input.dispatchEvent(new Event("input", { bubbles: true })); await wait(20);
      return [...document.querySelectorAll(".studio-palette-list button")].map(button => ({ label: labelOf(button), key: button.querySelector(".palette-hint").textContent }));
    };
    const saves = await search("저장");
    check(saves.filter(entry => entry.label === "저장").length === 1 && !saves.some(entry => entry.label === "파일 › 저장"), "팔레트의 같은 저장 명령 중복 제거");
    check(saves.find(entry => entry.label === "저장").key === "Ctrl+S", "팔레트 저장 키는 이름과 별도 표시");
    const playback = await search("재생 / 일시정지");
    check(playback.length === 1 && playback[0].key === "Space", "편집기·뷰포트 재생 버튼을 팔레트에서 하나의 명령으로 표시");
    const help = await search("가이드 · 단축키");
    check(help.length === 1 && help[0].key === "?", "동일한 도움말 명령 중복 제거");
    const versions = await search("버전 기록");
    check(versions.length === 1 && versions[0].label === "버전 기록…", "버전 기록 명령의 이름 통일·중복 제거");
    const split = await search("미리보기 분리 + 편집기 확대");
    check(split.length === 1 && split[0].key === "Ctrl+K P · P", "분리·확대 명령과 키 안내 중복 제거");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  } finally {
    close();
    $("fullscreenToggle").disabled = disabled;
    document.dispatchEvent(new Event("preview-popout-changed"));
    if (document.body.classList.contains("menubar-hidden")) $("menuBarShow").click();
    if ($("stage").classList.contains("hud-hidden")) $("hudReveal").click();
    if (!$("studioDock").hidden !== editorWasOpen) $("studioToggle").click();
    if (!$("timelineDock").hidden !== timelineWasOpen) $("timelineToggle").click();
    if (originalTheme) document.documentElement.dataset.theme = originalTheme;
    else delete document.documentElement.dataset.theme;
  }
})();
