// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 세로 정렬을 화면에서 잰다.
//  · 구역 제목 옆 가이드(?) 아이콘은 제목 글자와 세로 중심이 맞는다
//  · 가운데 정렬 가로 줄(flex · align-items:center) 안의 요소는 위·아래 여백이 달라 처지거나 뜨지 않는다
//  · 파라미터 탭의 내장 Uniform 안내는 목록 대신 가이드로 가는 버튼이다
(async () => {
  const $ = id => document.getElementById(id);
  const check = (ok, label) => {
    if (!ok) throw new Error(label);
    console.log(`PASS ${label}`);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const mid = rect => rect.top + rect.height / 2;
  const textRect = node => {
    const texts = [...node.childNodes].filter(child => child.nodeType === 3 && child.textContent.trim());
    if (!texts.length) return null;
    const range = document.createRange();
    range.setStartBefore(texts[0]);
    range.setEndAfter(texts[texts.length - 1]);
    const rects = [...range.getClientRects()].filter(rect => rect.height);
    return rects.length === 1 ? rects[0] : null;
  };
  const visible = node => node.getClientRects().length && !node.closest("[hidden],dialog:not([open])");
  const editorWasOpen = !$("studioDock").hidden,
    tabBefore = document.querySelector('#panelTabs [aria-selected="true"]')?.dataset.tab,
    panelHidden = document.body.classList.contains("panel-hidden");
  try {
    if (panelHidden) $("panelToggle").click();
    const bad = [];
    for (const tab of ["render", "uniforms", "profile", "input"]) {
      document.querySelector(`#panelTabs [data-tab="${tab}"]`).click();
      await wait(80);
      for (const hint of document.querySelectorAll(".ui-section-head h2 > .guide-hint")) {
        if (!visible(hint)) continue;
        const text = textRect(hint.parentElement),
          d = mid(hint.getBoundingClientRect()) - mid(text);
        if (Math.abs(d) > 1.5) bad.push(`${tab} "${hint.parentElement.textContent.trim()}" ? ${d.toFixed(1)}px`);
      }
      for (const row of document.querySelectorAll("#panel *")) {
        if (!visible(row)) continue;
        const style = getComputedStyle(row);
        if (!style.display.includes("flex") || style.flexDirection !== "row" || style.alignItems !== "center") continue;
        for (const child of row.children) {
          if (!visible(child)) continue;
          const cs = getComputedStyle(child),
            d = (parseFloat(cs.marginTop) - parseFloat(cs.marginBottom)) / 2;
          if (Math.abs(d) > 1.5 && cs.alignSelf === "auto" && cs.position !== "absolute")
            bad.push(`${tab} ${row.className} > ${child.className} 여백 차이 ${d.toFixed(1)}px`);
        }
      }
    }
    check(!bad.length, `구역 제목 ? 아이콘 · 가로 줄 요소 세로 정렬${bad.length ? `: ${bad.join(" / ")}` : ""}`);
    document.querySelector('#panelTabs [data-tab="uniforms"]').click();
    const builtin = document.querySelector("#view-uniforms .builtin-reference");
    check(!builtin.querySelector("dl,details"), "파라미터 탭에 내장 Uniform 목록을 두지 않음");
    builtin.querySelector('[data-guide="uniforms"]').click();
    await wait(30);
    check(
      $("quickHelp").open && $("guideContent").textContent.includes("uResolution"),
      "내장 Uniform 알아보기 버튼이 가이드의 내장 Uniform 주제를 엶"
    );
    $("quickHelp").close();
  } finally {
    if ($("quickHelp").open) $("quickHelp").close();
    if (tabBefore) document.querySelector(`#panelTabs [data-tab="${tabBefore}"]`)?.click();
    if (panelHidden !== document.body.classList.contains("panel-hidden")) $("panelToggle").click();
    if (editorWasOpen && $("studioDock").hidden) window.shaderStudio.open();
  }
})();
