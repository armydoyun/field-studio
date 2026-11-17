// 실제 이벤트·관찰자·원본 필드와 종료 경로를 반복 연결/해제로 검사한다.
(async () => {
  const check = (ok, label) => { if (!ok) throw new Error(label); console.log(`PASS ${label}`); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 30));
  const frame = document.createElement("iframe");
  frame.srcdoc = '<button id="themeToggle">테마</button><div id="resourceSurface">메뉴 영역</div><select tabindex="3" aria-hidden="false"><option value="a">첫 값</option><option value="b">다음 값</option></select>';
  const ready = new Promise(resolve => frame.onload = resolve);
  document.body.append(frame); await ready;
  const doc = frame.contentDocument, view = frame.contentWindow;
  const Theme = await import("./js/theme.js"), Select = await import("./js/custom-select.js"), Context = await import("./js/context-menu.js");
  const originalChoice = localStorage.getItem("field.theme.v1");
  try {
    // 테마를 다시 연결해도 클릭 하나가 한 번만 실행되고 시스템 테마 구독도 해제된다.
    const media = new EventTarget(); media.matches = false;
    const nativeMatch = view.matchMedia;
    view.matchMedia = () => media;
    let changes = 0; doc.addEventListener("theme-changed", () => changes++);
    for (let i = 0; i < 3; i++) {
      const theme = Theme.mount(doc); theme.set("system"); changes = 0;
      doc.getElementById("themeToggle").click();
      check(changes === 1 && theme.choice === "light", "테마 반복 연결: 클릭 한 번에 한 번만 변경");
      theme.set("system"); theme.dispose(); theme.dispose(); changes = 0;
      media.dispatchEvent(new Event("change")); doc.getElementById("themeToggle").click(); theme.set("dark");
      check(changes === 0 && theme.choice === "system", "테마 해제: 클릭·시스템 변경·API 모두 종료");
    }
    view.matchMedia = nativeMatch;

    // 등록 취소는 열린 메뉴까지 정리하고, 문서 연결도 안전하게 다시 만들 수 있다.
    let builds = 0;
    const target = doc.getElementById("resourceSurface");
    const right = () => { const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }); target.dispatchEvent(event); return event; };
    for (let i = 0; i < 3; i++) {
      const owner = new AbortController();
      Context.register("#resourceSurface", () => { builds++; return [{ label: "테스트 명령", onSelect() {} }]; }, { signal: owner.signal });
      const unmount = Context.mount(doc);
      Context.mount(doc);
      const before = builds;
      check(right().defaultPrevented && builds === before + 1 && Context.isOpen(), "우클릭 반복 연결: 공급자는 한 번만 실행");
      owner.abort();
      check(!Context.isOpen() && !doc.querySelector(".ui-context-menu"), "공급자 취소 시 열린 메뉴 정리");
      unmount(); unmount();
      check(!right().defaultPrevented && builds === before + 1, "문서 연결 해제 후 이벤트 처리 중단");
    }
    const expired = new AbortController(); expired.abort();
    Context.register("#resourceSurface", () => { throw new Error("취소된 공급자 실행"); }, { signal: expired.signal });
    const unmount = Context.mount(doc); right();
    check(builds === 3 && !doc.querySelector(".ui-context-menu")?.textContent.includes("테스트 명령"), "이미 취소된 공급자는 등록하지 않음"); unmount();

    // 최근 프로젝트를 읽는 중 메뉴 바를 해제해도 늦게 끝난 요청이 메뉴를 만들지 않는다.
    const nav = doc.createElement("nav"); nav.id = "menuBar";
    nav.innerHTML = '<button class="ui-menubar-item" data-menu="file">파일</button>';
    doc.body.append(nav);
    const MenuBar = await view.eval("import('/js/menu-bar.js')");
    let finish, reads = 0;
    const projects = new Promise(resolve => finish = resolve);
    const bar = MenuBar.mount({ studio: { projects: { list() { reads++; return projects; } } } });
    const opening = bar.open("file"); bar.dispose(); finish([]); await opening;
    nav.querySelector("button").click(); await bar.open("file");
    check(reads === 1 && !doc.querySelector('.ui-menu[role="menu"]'), "해제된 메뉴 바의 늦은 완료·클릭·API는 메뉴를 다시 만들지 않음");
    nav.remove();

    // 선택 상자의 관찰자는 닫힌 문서를 놓아주며, 원본 속성·프로퍼티도 복원한다.
    const NativeObserver = window.MutationObserver, active = new Set();
    window.MutationObserver = class extends NativeObserver {
      observe(...args) { active.add(this); return super.observe(...args); }
      disconnect() { active.delete(this); return super.disconnect(); }
    };
    let selects;
    const second = doc.createElement("iframe");
    try {
      const loaded = new Promise(resolve => second.onload = resolve); second.srcdoc = "<body></body>"; doc.body.append(second); await loaded;
      const select = doc.querySelector("select"), original = Object.getOwnPropertyDescriptor(select, "value");
      selects = Select.mount(doc); await tick();
      const button = select.nextElementSibling;
      check(active.size === 1 && button.classList.contains("ui-select"), "선택 상자 연결 시 문서 관찰자 하나 생성");
      select.value = "b"; check(button.textContent === "다음 값", "연결 중 값 대입을 표시와 동기화");
      select.remove(); await tick();
      check(select.getAttribute("tabindex") === "3" && select.getAttribute("aria-hidden") === "false" && !select.classList.contains("ui-select-source"), "떼어진 필드의 원본 속성 복원");
      doc.body.append(select); await tick();
      check(select.nextElementSibling === button, "재삽입 시 기존 컴포넌트를 재사용");
      second.contentDocument.body.append(select, button); await tick();
      check(active.size === 2, "다른 문서로 옮긴 필드 관찰");
      second.contentWindow.dispatchEvent(new second.contentWindow.PageTransitionEvent("pagehide", { persisted: false }));
      check(active.size === 1, "닫힌 문서의 관찰자와 필드 이벤트 해제");
      doc.body.append(select); await tick(); button.click();
      check(!!doc.querySelector(".ui-select-menu"), "복귀한 원본 필드의 목록 동작 유지");
      selects.dispose(); selects.dispose(); await tick();
      check(active.size === 0 && !doc.querySelector(".ui-select,.ui-select-menu"), "선택 상자 해제 시 모든 관찰자·목록·버튼 정리");
      check(select.getAttribute("tabindex") === "3" && select.getAttribute("aria-hidden") === "false", "해제 후 원본 접근성 속성 복원");
      check(Object.getOwnPropertyDescriptor(select, "value") === original, "해제 후 value 프로퍼티 복원");
      const later = doc.createElement("select"); later.innerHTML = "<option>새 값</option>"; doc.body.append(later); await tick();
      check(!later.nextElementSibling?.classList.contains("ui-select"), "해제 후 새 필드를 관찰하지 않음");
      selects = Select.mount(doc); await tick();
      check(doc.querySelectorAll(".ui-select").length === 2, "새 인스턴스로 재연결해도 중복 버튼 없음");
    } finally { selects?.dispose(); window.MutationObserver = NativeObserver; second.remove(); }
  } finally {
    frame.remove();
    if (originalChoice === null) localStorage.removeItem("field.theme.v1"); else localStorage.setItem("field.theme.v1", originalChoice);
    Context.close();
  }

  // 첫 방문 안내·포커스·투어 배치처럼 늦게 실행되는 작업도 각 UI의 종료에서 취소한다.
  const markup = (await (await fetch("./index.html")).text()).split("    <!-- ES Modules:")[0] + "</body></html>";
  const delayed = document.createElement("iframe"); delayed.srcdoc = markup;
  const loaded = new Promise(resolve => delayed.onload = resolve); document.body.append(delayed); await loaded;
  const delayedView = delayed.contentWindow, delayedDoc = delayed.contentDocument;
  const onboarding = localStorage.getItem("field.onboarded.v1");
  try {
    const timers = new Set(), frames = new Set();
    const set = delayedView.setTimeout.bind(delayedView), clear = delayedView.clearTimeout.bind(delayedView);
    const request = delayedView.requestAnimationFrame.bind(delayedView), cancel = delayedView.cancelAnimationFrame.bind(delayedView);
    delayedView.setTimeout = (fn, ms) => { const id = set(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
    delayedView.clearTimeout = id => { timers.delete(id); clear(id); };
    delayedView.requestAnimationFrame = fn => { const id = request(time => { frames.delete(id); fn(time); }); frames.add(id); return id; };
    delayedView.cancelAnimationFrame = id => { frames.delete(id); cancel(id); };
    const Gallery = await delayedView.eval("import('/js/gallery.js')");
    localStorage.removeItem("field.onboarded.v1");
    const gallery = Gallery.mount({ studio: { open() {}, close() {} }, Shader: {} });
    check(timers.size === 1, "첫 방문 갤러리 안내 타이머 생성");
    gallery.open(); check(timers.size === 0 && frames.size === 1, "직접 연 갤러리는 환영 타이머를 취소하고 미리보기 프레임 예약");
    gallery.dispose(); gallery.dispose(); gallery.open();
    check(timers.size === 0 && frames.size === 0 && !delayedDoc.getElementById("gallery").open, "갤러리 종료 시 안내 타이머·미리보기 프레임·모달 정리");
    const Guide = await delayedView.eval("import('/js/guide.js')");
    const NativeIntersection = delayedView.IntersectionObserver, observed = new Set();
    let observerCreations = 0;
    delayedView.IntersectionObserver = class extends NativeIntersection {
      constructor(...args) { super(...args); observerCreations++; observed.add(this); }
      disconnect() { observed.delete(this); return super.disconnect(); }
    };
    const guide = Guide.mount({ studio: { open() {}, close() {} }, gallery: null });
    guide.open(); guide.startTour();
    check(timers.size > 0 && frames.size > 0, "가이드 포커스·투어 배치 작업 예약");
    const beforeDispose = observerCreations;
    guide.dispose(); guide.dispose(); guide.open(); guide.startTour();
    check(timers.size === 0 && frames.size === 0 && !delayedDoc.getElementById("quickHelp").open, "가이드 종료 시 타이머·중첩 배치 프레임·모달 정리");
    await tick();
    check(!delayedDoc.querySelector(".guide-tour"), "해제된 가이드는 투어를 다시 시작하지 않음");
    check(observed.size === 0 && observerCreations === beforeDispose, "가이드 종료가 새 미리보기 관찰자를 만들지 않음");
    const Preview = await delayedView.eval("import('/js/snippet-preview.js')");
    const preview = Preview.create({ plan() { throw new Error("종료 뒤 미리보기 생성"); } });
    preview.dispose(); preview.dispose();
    const item = { id: Object.keys(Preview.PREVIEWS)[0] };
    check(!preview.draw(item, delayedDoc.createElement("canvas")) && preview.render(item) === null && await preview.renderAsync(item) === null && observed.size === 0, "종료된 미리보기는 재시작하거나 GPU 자원을 만들지 않음");
  } finally {
    delayed.remove();
    if (onboarding === null) localStorage.removeItem("field.onboarded.v1"); else localStorage.setItem("field.onboarded.v1", onboarding);
  }

  // 취소 가능한 이탈과 BFCache 보관은 앱을 해제하지 않는다. 최종 종료는 한 번만 정리한다.
  const studio = window.shaderStudio, popout = window.shaderPopout, theme = window.shaderTheme;
  window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  check(window.shaderStudio === studio, "beforeunload만으로 앱을 해제하지 않음");
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  check(window.shaderStudio === studio, "뒤로 가기 캐시 보관 시 인스턴스 유지");
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  check(!window.shaderStudio && !window.shaderPlayground && !window.shaderTheme && !window.shaderPopout, "최종 종료 시 공개 참조 해제·반복 종료 안전");
  const prior = theme.choice; theme.set(prior === "dark" ? "light" : "dark");
  check(theme.choice === prior && await popout.open() === null, "종료된 API는 테마 변경이나 창 생성을 하지 않음");
})();
