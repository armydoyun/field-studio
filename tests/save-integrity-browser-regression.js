// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 저장 정확성: 외부 검토에서 재현된 문제들이 다시 생기지 않는지 본다.
//   1) 이미지를 읽는 동안(저장 도중) 코드를 고치면: 보관함에는 저장 시작 시점 내용 · 저장 뒤에도 '저장 안 됨'(●)
//   2) 이미지 샘플링(Filter·Wrap)만 바꿔도 '저장 안 됨'
//   3) 실행까지 마친 변경도 다른 작업으로 바꾸기 전에 묻는다(저장하고 계속 · 저장하지 않고 계속 · 취소)
//   4) 다른 탭이 먼저 저장했으면 덮어쓰지 않고 묻는다(revision 비교)
//   5) 같은 이름 모두 바꾸기(F2): 바뀔 곳을 미리 보여 주고 'value . x' 같은 필드는 건드리지 않는다
(async () => {
  const $ = id => document.getElementById(id), renderer = window.shaderPlayground, studio = window.shaderStudio;
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (condition()) return true; return condition(); };
  const P = studio.projects, area = $("studioCode");
  const setCode = text => { area.value = text; area.dispatchEvent(new Event("input", { bubbles: true })); };
  const answer = async value => {
    test(await until(() => $("studioPromptDialog").open), "대화상자 열림");
    if (value !== undefined) $("studioDialogInput").value = value;
    $("studioDialogForm").requestSubmit();
  };
  const marked = () => $("projectMenuToggle").dataset.modified === "true";
  const Store = await import("./js/project-store.js");
  const store = Store.create();
  await P.ready();
  const created = [];
  let textureId = null;
  const realRead = FileReader.prototype.readAsDataURL;
  try {
    // 준비: 이미지를 연결한 장면
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    textureId = (await renderer.addTexture(new File([blob], "integrity.png", { type: "image/png" }))).id;
    const scene = studio.getProject();
    scene.imageChannels = { 0: { texture: textureId } };
    test(studio.setProject(scene), "이미지 채널 연결");
    const base = area.value;

    // 1) 저장 도중 편집
    FileReader.prototype.readAsDataURL = function (file) {
      FileReader.prototype.readAsDataURL = realRead;
      setCode(base + "\n// 저장 도중 고친 줄");
      return realRead.call(this, file);
    };
    const name = `저장 정확성 ${Date.now().toString(36)}`;
    let pending = P.save(false);
    await answer(name);
    test(await pending, "보관함에 저장");
    FileReader.prototype.readAsDataURL = realRead;
    const record = (await store.list()).find(item => item.name === name);
    created.push(record.id);
    const stored = JSON.parse(await store.load(record.id));
    test(!stored.project.image.includes("저장 도중 고친 줄"), "보관함에는 저장을 시작한 순간의 코드가 들어간다");
    test(area.value.includes("저장 도중 고친 줄"), "편집기에는 저장 도중 고친 코드가 남는다");
    test(await until(marked), "저장 도중 고친 내용은 '저장 안 됨'(●)으로 남는다");
    test(document.title.includes("● "), `탭 제목에도 ●: ${document.title}`);
    test(Number.isInteger(record.revision) && record.revision === 1, "보관함 항목에 revision");

    // 2) 이미지 샘플링 변경 감지
    setCode(base);
    test(studio.apply(), "저장한 코드로 되돌려 적용");
    test(await until(() => !marked()), "저장한 상태와 같으면 ● 없음");
    await renderer.setTextureSampling(textureId, { filter: "nearest", wrapS: "repeat" });
    test(await until(marked), "이미지 Filter·Wrap만 바꿔도 '저장 안 됨'");
    await renderer.setTextureSampling(textureId, { filter: "linear", wrapS: "clamp" });
    test(await until(() => !marked()), "샘플링을 되돌리면 ● 사라짐");

    // 3) 실행까지 마친 변경도 교체 전에 묻는다
    setCode(base.replace("void main", "// 실행한 변경\nvoid main"));
    test(studio.apply() && (await until(marked)), "실행한 변경 · 보관함에는 없음");
    pending = studio.exampleFeedback();
    test(await until(() => $("studioPromptDialog").open), "다른 예제를 열기 전에 묻는다");
    test($("studioDialogTitle").textContent === "저장하지 않은 변경" && !$("studioDialogAlt").hidden, "저장하고 계속 · 저장하지 않고 계속 · 취소");
    $("studioDialogCancel").click();
    test((await pending) === false && area.value.includes("// 실행한 변경"), "취소하면 작업이 그대로");

    // 4) 다른 탭이 먼저 저장했으면 묻는다
    await store.save({ id: record.id, name, text: JSON.stringify(stored), passes: 0, images: 1 });
    pending = P.save(false);
    test(await until(() => $("studioPromptDialog").open && $("studioDialogTitle").textContent === "다른 탭에서 먼저 저장됨"), "다른 탭의 저장을 덮어쓰기 전에 묻는다");
    $("studioDialogCancel").click();
    test((await pending) === false, "취소하면 저장하지 않는다");
    test(!JSON.parse(await store.load(record.id)).project.image.includes("// 실행한 변경"), "다른 탭의 내용이 그대로 남는다");
    pending = P.save(false);
    await until(() => $("studioPromptDialog").open);
    $("studioDialogOK").click(); // 사본으로 저장
    test(await pending, "사본으로 저장");
    const copyRecord = (await store.list()).find(item => item.name === `${name} 사본`);
    test(!!copyRecord, "사본 항목이 생긴다");
    created.push(copyRecord.id);
    test(P.current().id === copyRecord.id && !marked(), "지금 작업은 사본과 이어진다");

    // 5) 같은 이름 모두 바꾸기 미리 보기 · 필드 제외
    setCode(`#version 300 es
precision highp float;
uniform vec2 uResolution;
out vec4 fragColor;
struct S { float x; };
void main() {
    S value; value . x = 1.0;
    float x = value.x;
    fragColor = vec4(x, x, 0.0, 1.0);
}`);
    const caret = area.value.indexOf("float x =") + 6;
    area.focus();
    area.setSelectionRange(caret, caret);
    area.dispatchEvent(new Event("select"));
    await wait(50);
    $("studioRename").click();
    test(await until(() => $("studioPromptDialog").open), "F2 대화상자");
    test(/4곳/.test($("studioDialogMessage").textContent) && /함수 범위를 구분하지 않으므로/.test($("studioDialogMessage").textContent), `바뀔 곳 미리 보기: ${$("studioDialogMessage").textContent}`);
    await answer("level");
    test(await until(() => area.value.includes("float level = value.x")), "이름이 바뀐다");
    test(area.value.includes("value . x = 1.0") && area.value.includes("vec4(level, level"), "'value . x'처럼 공백 있는 필드는 바꾸지 않는다");
  } finally {
    FileReader.prototype.readAsDataURL = realRead;
    setInterval(() => { const b = $("studioDialogAlt"); if ($("studioPromptDialog").open && $("studioDialogTitle").textContent === "저장하지 않은 변경") (b.hidden ? $("studioDialogOK") : b).click(); }, 10);
    for (const id of created) await store.remove(id).catch(() => {});
    await P.list();
    studio.setProject({ image: window.shaderPlayground.getFragmentSource(), passes: [], imageChannels: {} });
    if (textureId) await renderer.removeTexture(textureId).catch(() => {});
  }
})();
