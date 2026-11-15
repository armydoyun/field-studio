// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
//  · 검색 칸(ui-search)의 지우기는 공용 아이콘 버튼으로 칸 오른쪽 끝에 있고, 브라우저 기본 ×는 숨긴다
//  · 타임라인 막대의 [?][×]는 오른쪽 위에 고정되어 같은 줄 버튼과 세로 중심이 맞고, 좁으면 키 칸이 막대 오른쪽 끝까지 찬다
//  · 타임라인 레인 머리에서 키프레임 시간 기준(한 번 · 반복 · 처음으로 잇기)을 바꿀 수 있다
//  · 연결이 적용된 파라미터도 연결 설정을 열면 연결 버튼에 열린 면이 보인다
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    settings = window.shaderSettings,
    $ = id => document.getElementById(id);
  const check = (ok, label) => {
    if (!ok) throw new Error(label);
    console.log(`PASS ${label}`);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const mid = node => {
    const box = node.getBoundingClientRect();
    return box.top + box.height / 2;
  };
  const row = name => [...$("uniformList").querySelectorAll(".uniform-row")].find(node => node.dataset.name === name);
  const before = studio.getProject(),
    users = r.getUserUniforms(),
    links = settings.getLinks(),
    timelineOpen = !$("timelineDock").hidden,
    panelHidden = document.body.classList.contains("panel-hidden"),
    tab = document.querySelector('#panelTabs [aria-selected="true"]')?.dataset.tab;
  try {
    studio.setProject({
      image:
        "uniform float uRadius; // @range 0.1 0.4 @default 0.2\nuniform float uMatrixMode; // @range 0 1\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(uRadius + uMatrixMode); }",
      passes: [],
      imageChannels: {},
    });
    settings.setLinks([
      { name: "uRadius", source: "keys", min: 0, max: 1, smooth: 0, keys: [[0.1, 0.1], [0.5, 0.3], [0.85, 0.4]], loop: 0, ease: "smooth" },
    ]);
    if (panelHidden) $("panelToggle").click();
    $("tab-uniforms").click();
    await frames();

    // 1) 검색 지우기
    for (const id of ["uniformSearch", "gallerySearch", "guideSearch"])
      check($(id).closest(".ui-search").querySelector(".ui-search-clear.glyph-icon.icon-close"), `${id}: 공용 지우기 버튼`);
    const search = $("uniformSearch"),
      clear = search.closest(".ui-search").querySelector(".ui-search-clear");
    check(!clear.getClientRects().length, "비어 있으면 지우기 버튼을 감춤");
    search.value = "uMatrixMode";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await frames();
    const rules = [...document.styleSheets].flatMap(sheet => {
      try {
        return [...sheet.cssRules];
      } catch {
        return [];
      }
    });
    check(
      rules.some(rule => rule.selectorText?.includes("::-webkit-search-cancel-button") && rule.style.display === "none"),
      "브라우저 기본 ×를 감춤"
    );
    const clearBox = clear.getBoundingClientRect(),
      searchBox = search.getBoundingClientRect();
    check(
      clear.getClientRects().length && searchBox.right - clearBox.right <= 8 && Math.abs(mid(clear) - mid(search)) <= 1,
      "글자가 있으면 지우기 버튼이 칸 오른쪽 끝 · 세로 가운데"
    );
    check(!row("uRadius"), "검색이 목록을 거름");
    clear.click();
    await frames();
    check(search.value === "" && document.activeElement === search && row("uRadius"), "지우기: 칸을 비우고 검색을 다시 돌린 뒤 칸에 초점");

    // 4) 연결된 파라미터의 연결 버튼 열린 면
    const linkButton = () => row("uRadius").querySelector(".link-uniform");
    check(linkButton().getAttribute("aria-pressed") === "true", "연결 적용 표시");
    check(getComputedStyle(linkButton()).backgroundColor === "rgba(0, 0, 0, 0)", "닫혀 있으면 연결 버튼에 면이 없음");
    linkButton().click();
    await frames();
    check(
      linkButton().getAttribute("aria-expanded") === "true" && getComputedStyle(linkButton()).backgroundColor !== "rgba(0, 0, 0, 0)",
      "연결이 적용돼 있어도 설정을 열면 연결 버튼에 열린 면"
    );
    linkButton().click();
    await frames();

    // 2) 타임라인 막대 배치
    if ($("timelineDock").hidden) $("timelineToggle").click();
    await frames();
    const bar = document.querySelector(".timeline-bar"),
      help = bar.querySelector(".timeline-help"),
      close = bar.querySelector(".timeline-close"),
      play = bar.querySelector(".timeline-play"),
      inspector = bar.querySelector(".timeline-inspector");
    const layout = label => {
      check(
        getComputedStyle(help).position === "absolute" && help.getBoundingClientRect().right <= close.getBoundingClientRect().left,
        `${label}: 도움말은 닫기 왼쪽에 고정`
      );
      check(Math.abs(mid(help) - mid(play)) <= 1 && Math.abs(mid(close) - mid(play)) <= 1, `${label}: [?][×]가 첫 줄 버튼과 세로 중심이 맞음`);
    };
    const dock = $("timelineDock"),
      width = dock.style.width;
    dock.style.width = "1200px";
    await frames();
    layout("넓은 타임라인");
    dock.style.width = "640px";
    await frames();
    layout("좁은 타임라인");
    check(
      Math.abs(bar.getBoundingClientRect().right - 10 - inspector.getBoundingClientRect().right) <= 1.5 &&
        inspector.getBoundingClientRect().top >= close.getBoundingClientRect().bottom,
      "좁으면 키 칸이 [?][×] 아래에서 막대 오른쪽 끝까지 참"
    );
    dock.style.width = width;
    await frames();

    // 3) 레인 머리에서 시간 기준 바꾸기
    const mode = () => [...document.querySelectorAll(".timeline-lane")].find(node => node.dataset.name === "uRadius").querySelector(".timeline-lane-mode");
    const choose = async index => {
      mode().click();
      const items = [...document.querySelectorAll("body > .ui-popover.ui-menu .ui-menu-item")];
      check(items.length === 3, "시간 기준 메뉴: 한 번 · 반복 · 처음으로 잇기");
      items[index].click();
      await frames();
      return settings.getLinks().find(link => link.name === "uRadius");
    };
    check(mode().tagName === "BUTTON" && mode().textContent.includes("한 번"), "레인 머리의 시간 기준은 누를 수 있는 버튼");
    let link = await choose(2);
    check(link.loop === 1 && link.wrap === true && mode().textContent.includes("이어 반복"), "반복 · 처음으로 잇기로 바꿈(기본 반복 길이 1초)");
    check(document.activeElement === mode(), "바꾼 뒤 시간 기준 버튼에 초점");
    link = await choose(1);
    check(link.loop === 1 && !link.wrap, "반복 · 끝 값 유지로 바꿈(반복 길이 유지)");
    link = await choose(0);
    check(link.loop === 0 && mode().textContent.includes("한 번"), "한 번으로 되돌림");
  } finally {
    document.querySelector("body > .ui-popover.ui-menu")?.remove();
    $("uniformSearch").value = "";
    $("uniformSearch").dispatchEvent(new Event("input", { bubbles: true }));
    settings.setLinks(links);
    studio.setProject(before);
    r.setUserUniforms(users);
    if (timelineOpen === $("timelineDock").hidden) $("timelineToggle").click();
    if (tab) document.querySelector(`#panelTabs [data-tab="${tab}"]`)?.click();
    if (panelHidden !== document.body.classList.contains("panel-hidden")) $("panelToggle").click();
    await wait(0);
  }
})();
