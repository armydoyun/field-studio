// 프로젝트 버전 기록(version-store.js · studio.js keepVersion/restoreVersion · version-history.js 대화상자):
//  · 실행에 성공하면 버전을 남긴다(1분 안에 다시 실행하면 남기지 않는다) · 직접 남기기 · 같은 내용이면 남기지 않는다
//  · 목록(때 · 까닭 · 요약) · 비교(지금 작업과 줄 단위) · '이 버전으로'(코드 · 파라미터 · 프리셋을 그 버전으로, 그 전 작업도 남김,
//    Ctrl+Z로 돌아옴) · 이 탭만 되돌리기 · 다른 예제를 열기 전에 남긴다 · 이름 붙이기 · 지우기
(async () => {
  const r = window.shaderPlayground,
    studio = window.shaderStudio,
    settings = window.shaderSettings,
    $ = id => document.getElementById(id);
  const test = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(25)) if (await check()) return;
    throw new Error(`FAIL: 시간 초과 — ${label}`);
  };
  const before = studio.getProject(),
    presets = settings.getPresets();
  const codeA = "uniform float uGain; // @range 0 1 @default 0.25\nvoid mainImage(out vec4 c, in vec2 p) {\n  c = vec4(uGain);\n}",
    codeB = "uniform float uGain; // @range 0 1 @default 0.25\nvoid mainImage(out vec4 c, in vec2 p) {\n  vec2 uv = p / iResolution.xy;\n  c = vec4(uv * uGain, 0.0, 1.0);\n}";
  const items = () => [...$("versionList").querySelectorAll(".version-item")];
  try {
    settings.setPresets([]);
    test(studio.setProject({ image: codeA, passes: [], imageChannels: {} }), "버전 A");
    await until(async () => (await studio.listVersions()).length === 1, "실행하면 버전을 남긴다");
    test((await studio.listVersions())[0].label === "실행", "까닭: 실행");
    // 1분 안에 다시 실행: 남기지 않는다 → 직접 남기기
    test(studio.setProject({ image: codeB, passes: [], imageChannels: {} }), "버전 B");
    await wait(150);
    test((await studio.listVersions()).length === 1, "1분 안의 실행은 다시 남기지 않는다");
    r.setUniform("uGain", 0.8);
    settings.setPresets([{ name: "밝게", values: { uGain: 0.9 } }]);
    test((await studio.keepVersion())?.label === "직접 남김", "직접 남기기");
    test((await studio.keepVersion()) === null, "같은 내용이면 남기지 않는다");
    // 대화상자: 프로젝트 메뉴 '버전 기록…'
    $("projectMenuToggle").click();
    await wait(30);
    $("versionOpen").click();
    await until(() => $("versionDialog").open && items().length === 2, "대화상자 목록 2개");
    test(items()[0].textContent.includes("직접 남김") && items()[0].textContent.includes("가장 최근"), "최신이 위 · 까닭 표시");
    test(/코드 \d+줄/.test(items()[1].textContent) && items()[0].textContent.includes("프리셋 1개"), "요약(코드 줄 수 · 프리셋)");
    // 비교: 옛 버전(A)과 지금(B)
    items()[1].querySelector(".version-compare-button").click();
    await wait(30);
    const diff = $("versionDiff");
    test(!$("versionCompare").hidden && diff.querySelector(".version-diff-line.is-add")?.textContent.includes("vec2 uv = p / iResolution.xy;"), "비교: 지금에만 있는 줄(+)");
    test(diff.querySelector(".version-diff-line.is-del")?.textContent.includes("c = vec4(uGain);"), "비교: 그 버전에만 있는 줄(−)");
    test(diff.textContent.includes("파라미터 값 1개 다름"), "비교: 파라미터 값 차이");
    // 이 버전으로(A): 코드 · 파라미터 · 프리셋이 A로, 그 전 작업(B)도 버전으로 남는다
    [...items()[1].querySelectorAll("button")].find(button => button.textContent === "이 버전으로").click();
    await until(() => studio.getProject().image === codeA, "A로 되돌림");
    await wait(50);
    test(!$("versionDialog").open, "되돌리면 대화상자를 닫는다");
    test(r.getUserUniforms()[0].value === 0.25 && settings.getPresets().length === 0, "파라미터 · 프리셋도 그 버전으로");
    test(/버전으로 되돌렸습니다/.test($("studioMessage").textContent), "상태 줄 안내");
    const list = await studio.listVersions();
    test(list.length === 2 || list[0].label === "되돌리기 전", `되돌리기 전 작업은 이미 같은 버전이 있으면 그대로(${list.map(v => v.label)})`);
    // Ctrl+Z 한 번으로 B
    studio.undo();
    await until(() => studio.getProject().image === codeB, "Ctrl+Z로 바로 전 작업");
    test(r.getUserUniforms()[0].value === 0.8 && settings.getPresets().length === 1, "되돌리기로 파라미터 · 프리셋도 돌아옴");
    // 이 탭만 되돌리기: 비교에서 Image 탭 코드만 A로 — 파라미터 값은 그대로 · Ctrl+Z 한 번으로 돌아온다
    $("versionOpen").click();
    await until(() => $("versionDialog").open && items().length > 1, "대화상자 다시 열기");
    const versionsNow = await studio.listVersions(),
      indexA = versionsNow.findIndex(v => v.project.image === codeA);
    items()[indexA].querySelector(".version-compare-button").click();
    await until(() => $("versionDiff").querySelector(".version-tab-restore"), "탭 제목 옆 '이 탭만 되돌리기'");
    test(!$("versionDiff").textContent.includes("파라미터 값") || !$("versionDiff").querySelectorAll(".version-diff-head")[1]?.querySelector(".version-tab-restore"), "파라미터 제목에는 탭 되돌리기가 없다");
    $("versionDiff").querySelector(".version-tab-restore").click();
    await until(() => studio.getProject().image === codeA && !$("versionDialog").open, "Image 탭만 A로 · 대화상자 닫힘");
    test(r.getUserUniforms()[0].value === 0.8 && settings.getPresets().length === 1, "파라미터 · 프리셋은 그대로");
    test(/Image 탭을 .* 버전으로 바꿨습니다/.test($("studioMessage").textContent), "상태 줄 안내(탭)");
    studio.undo();
    await until(() => studio.getEditorSource() === codeB, "Ctrl+Z로 탭 되돌리기 취소");
    await until(() => studio.getProject().image === codeB, "다시 B로 실행");
    // 다른 예제를 열기 전에 지금 작업을 남긴다
    r.setUniform("uGain", 0.5);
    const count = (await studio.listVersions()).length;
    const opening = studio.loadExample({ image: "void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }", passes: [], imageChannels: {} }, []);
    // 저장하지 않은 작업이라 바꾸기 전에 묻는다 — '저장하지 않고 계속'
    await until(() => $("studioPromptDialog").open, "바꾸기 확인");
    ($("studioDialogAlt").hidden ? $("studioDialogOK") : $("studioDialogAlt")).click();
    test(await opening, "다른 예제 열기");
    await until(async () => (await studio.listVersions()).some(v => v.label === "다른 작업을 열기 전") && (await studio.listVersions()).length > count, "열기 전에 남김");
    // 이름 붙이기(보관): 화면에서 이름을 붙이면 목록에 이름 · '보관' 표시가 나오고, 자동 정리(최근 40개)에서 빠진다
    test(studio.setProject({ image: codeA, passes: [], imageChannels: {} }), "다시 버전 A 장면");
    $("versionOpen").click();
    await until(() => $("versionDialog").open && items().length > 0, "다시 대화상자");
    const oldest = items()[items().length - 1];
    [...oldest.querySelectorAll("button")].find(button => /이름 붙이기/.test(button.textContent)).click();
    await until(() => $("studioPromptDialog").open, "이름 묻기");
    $("studioDialogInput").value = "처음 모습";
    $("studioDialogOK").click();
    await until(() => items().some(item => item.textContent.includes("처음 모습") && item.textContent.includes("보관")), "이름 · 보관 표시");
    const named = (await studio.listVersions()).find(v => v.name === "처음 모습");
    test(!!named, "이름이 저장된다");
    // 바로 전 버전과의 줄 변화 · 이름 붙인 것만 보기
    test(items().some(item => /바로 전 버전보다 \+\d+ −\d+줄/.test(item.textContent)), "목록에 바로 전 버전과의 줄 변화");
    [...document.querySelectorAll(".version-filter button")].find(button => button.textContent === "이름 붙인 것").click();
    await until(() => items().length === 1 && items()[0].textContent.includes("처음 모습"), "이름 붙인 것만 보기");
    document.querySelector(".version-filter button").click();
    await until(() => items().length > 1, "전체 보기로 돌아옴");
    // 버전을 41개 더 쌓아도(내용이 모두 다르게) 이름 붙인 버전은 남고, 이름 없는 버전은 40개까지
    for (let i = 0; i < 41; i++) {
      r.setUniform("uGain", (i + 1) / 100);
      await studio.keepVersion("직접 남김");
    }
    const after = await studio.listVersions();
    test(after.some(v => v.id === named.id), "이름 붙인 버전은 자동 정리에서 빠진다");
    test(after.filter(v => !v.name).length === 40, `이름 없는 버전은 최근 40개(${after.filter(v => !v.name).length})`);
    // 지우기: 확인 뒤 사라진다
    await until(() => items().length === after.length, "목록 갱신");
    const target = items().find(item => item.textContent.includes("처음 모습"));
    target.querySelector(".version-remove").click();
    await until(() => $("studioPromptDialog").open, "지우기 확인");
    $("studioDialogOK").click();
    await until(async () => !(await studio.listVersions()).some(v => v.id === named.id), "지운 버전은 사라진다");
    await until(() => !items().some(item => item.textContent.includes("처음 모습")), "목록에서도 사라진다");
  } finally {
    if ($("versionDialog").open) $("versionDialog").close();
    settings.setPresets(presets);
    studio.setProject(before);
  }
  console.log("버전 기록 검사 통과");
})();
