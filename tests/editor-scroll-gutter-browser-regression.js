// 코드 편집기 가로 스크롤 여백: 긴 줄을 쓸 때 커서 · 마지막 글자가 편집기 오른쪽 끝에 붙지 않는다.
//  · 끝까지 스크롤해도 가장 긴 줄 끝 뒤에 빈 곳이 남는다(--editor-scroll-gutter)
//  · 줄 끝으로 가면(End) 커서가 오른쪽 가장자리에서 여유를 두고 보인다(cursorScrollMargin)
//  · 줄 바꿈 모드에서는 여백을 두지 않는다(가로 스크롤이 없으니 쓸 폭을 줄이지 않는다)
(async () => {
  const studio = window.shaderStudio,
    $ = id => document.getElementById(id);
  const test = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const frames = n => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const before = studio.getProject(),
    wasOpen = !$("studioDock").hidden;
  try {
    const long = `  float veryLongLine = ${Array.from({ length: 40 }, (_, i) => `${i}.0`).join(" + ")};`;
    test(
      studio.setProject({ image: `void mainImage(out vec4 c, in vec2 p) {\n${long}\n  c = vec4(veryLongLine);\n}`, passes: [], imageChannels: {} }),
      "긴 줄이 있는 장면"
    );
    studio.open();
    await frames(4);
    const scroller = document.querySelector(".studio-cm-host .cm-scroller"),
      content = scroller.querySelector(".cm-content");
    test(!!scroller && scroller.scrollWidth > scroller.clientWidth, "긴 줄이라 가로 스크롤이 생긴다");
    // 1) 끝까지 스크롤: 가장 긴 줄의 끝 글자와 보이는 오른쪽 끝 사이에 여백
    scroller.scrollLeft = scroller.scrollWidth;
    await frames(2);
    const lines = [...content.querySelectorAll(".cm-line")],
      longest = lines.reduce((a, b) => (b.textContent.length > a.textContent.length ? b : a)),
      range = document.createRange();
    range.selectNodeContents(longest);
    const textRight = Math.max(...[...range.getClientRects()].map(r => r.right)),
      viewRight = scroller.getBoundingClientRect().right;
    const charWidth = range.getBoundingClientRect().width / longest.textContent.length;
    test(viewRight - textRight >= charWidth * 8, `끝까지 스크롤해도 줄 끝 뒤에 여백(${Math.round(viewRight - textRight)}px ≥ ${Math.round(charWidth * 8)}px)`);
    // 2) 맨 왼쪽에서 그 줄 끝으로 가면 커서가 가장자리에 붙지 않는다
    scroller.scrollLeft = 0;
    await frames(2);
    const area = $("studioCode"),
      lineStart = area.value.indexOf(long);
    area.focus();
    area.setSelectionRange(lineStart, lineStart);
    await frames(2);
    content.focus();
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "End", code: "End", keyCode: 35, bubbles: true, cancelable: true }));
    await frames(4);
    const cursor = document.querySelector(".studio-cm-host .cm-cursor, .studio-cm-host .cm-cursor-primary");
    test(!!cursor, "커서를 그린다");
    const gap = scroller.getBoundingClientRect().right - cursor.getBoundingClientRect().left;
    test(scroller.scrollLeft > 0, "줄 끝으로 가면 가로로 스크롤한다");
    test(gap >= charWidth * 5, `커서와 오른쪽 가장자리 사이 여유(${Math.round(gap)}px ≥ 약 5글자)`);
    // 3) 줄 바꿈 모드: 여백 없음
    const wrapped = document.querySelector(".studio-cm-host .cm-content");
    wrapped.classList.add("cm-lineWrapping");
    test(parseFloat(getComputedStyle(wrapped).paddingRight) === 0, "줄 바꿈 모드에서는 여백을 두지 않는다");
    wrapped.classList.remove("cm-lineWrapping");
  } finally {
    studio.setProject(before);
    if (!wasOpen) studio.close();
  }
  console.log("편집기 가로 스크롤 여백 검사 통과");
})();
