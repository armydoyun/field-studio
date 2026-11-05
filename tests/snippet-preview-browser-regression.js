// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 코드 조각 미리보기 지연 로딩: 범주를 열 때 모든 조각을 한꺼번에 컴파일하지 않고, 화면에 보이는 카드부터 한 프레임에 하나씩 그린다.
// 화면 밖 카드는 스크롤해 보일 때 그리고, 범주를 오가도 이미 그린 그림은 다시 컴파일하지 않고 바로 붙인다.
(async () => {
  const $ = id => document.getElementById(id), help = $("quickHelp");
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (condition()) return true; return condition(); };
  const frames = () => [...document.querySelectorAll("#guideContent .snippet-preview")];
  const ready = () => frames().filter(frame => frame.classList.contains("is-ready")).length;
  const category = id => document.querySelector(`#guideContent .snippet-categories [data-category="${id}"]`);
  const scroller = () => { for (let node = frames()[0]; node; node = node.parentElement) if (node.scrollHeight > node.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node; return null; };
  const wasOpen = help.open;
  try {
    if (!help.open) $("helpToggle").click();
    document.querySelector('#guideNav button[data-topic="snippets"]').click();
    await wait(50);
    category("noise").click();
    const total = frames().length;
    test(total >= 6, `노이즈 범주에 미리보기 카드 ${total}개`);
    test(ready() === 0, "범주를 연 순간에는 아직 그리지 않는다(한꺼번에 컴파일하지 않음)");
    const box = scroller();
    test(!!box, "조각 목록이 스크롤된다");
    box.scrollTop = 0;
    test(await until(() => ready() > 0, 30_000), "보이는 카드부터 그린다");
    await until(() => frames().filter(frame => frame.getBoundingClientRect().top < box.getBoundingClientRect().bottom).every(frame => frame.classList.contains("is-ready") || !frame.isConnected), 30_000);
    await wait(600);
    const lastFrame = frames().at(-1);
    test(lastFrame.getBoundingClientRect().top > box.getBoundingClientRect().bottom + 300 && !lastFrame.classList.contains("is-ready"), "화면 밖 카드는 보이기 전에는 그리지 않는다");
    // 끝까지 스크롤하면 나머지도 그린다.
    for (const frame of frames()) {
      frame.scrollIntoView({ block: "center" });
      await until(() => frame.classList.contains("is-ready") || !frame.isConnected, 30_000);
    }
    test(ready() === frames().length && frames().length === total, `스크롤하면 모두 그린다 (${ready()}/${total})`);
    const pixel = frames()[0].querySelector("canvas").getContext("2d").getImageData(160, 80, 1, 1).data;
    test(pixel[3] > 0, "미리보기 그림이 실제로 그려졌다");
    // 다른 범주를 갔다가 돌아오면 이미 그린 그림을 바로 붙인다.
    category("hash").click();
    await wait(50);
    category("noise").click();
    test(ready() === total, "다시 돌아오면 이미 그린 그림을 바로 붙인다");
  } finally {
    if (help.open && !wasOpen) help.close();
  }
  console.log("코드 조각 미리보기 지연 로딩 회귀 테스트 완료");
})();
