// 사용자 편집 상태만 소유한다. GPU 자원과 연결 규칙은 Renderer/PassManager가 검증한다.
// 외부 코드 에디터나 네트워크 요청은 사용하지 않는다. file:// 배포는 deploy/ 번들을 사용한다.
// 나눠 둔 모듈: 프로젝트 데이터 규칙(project-model) · 예제(studio-examples) · 대화상자(studio-dialog) · 코드 삽입 위치(code-insert) · 저장소(storage)
//   · 화면 배치·리사이저·작업공간 저장(studio-layout) · Pack 파일 형식(studio-pack)
import * as Editor from "./cm-editor.js";
import * as Annotations from "./annotations.js";
import * as Model from "./project-model.js";
import * as Examples from "./studio-examples.js";
import * as Dialog from "./studio-dialog.js";
import * as Insert from "./code-insert.js";
import * as Store from "./storage.js";
import * as Layout from "./studio-layout.js";
import * as Pack from "./studio-pack.js";
import * as ProjectStore from "./project-store.js";
import * as Projects from "./studio-projects.js";
import * as ProjectMenu from "./project-menu.js";
import * as ChannelPicker from "./channel-picker.js";
import * as PreviewDOM from "./preview-dom.js";
import * as Scope from "./glsl-scope.js";

// localStorage 키. 작업 상태(project·draft)만 여기서 다룬다. 화면 배치(height·layout·workspace) 키는 studio-layout.js에 있다.
const STORAGE_KEY = "webgl.shader-studio.project.v1",
  DRAFT_KEY = "webgl.shader-studio.draft.v2",
  JSON_LIMIT = Pack.LIMITS.json,
  PACK_LIMIT = Pack.LIMITS.pack;
const { copy, same, validateProject } = Model;
// options.lookup(name): 내장 함수 설명 {sig, desc} 또는 null — 편집기 시그니처 힌트에 쓴다(main.js가 레퍼런스에서 만들어 넘긴다).
const mount = (renderer, Shader, settings = null, options = {}) => {
  const $ = PreviewDOM.createLookup();
  const controller = new AbortController(),
    signal = controller.signal;
  const element = tag => document.createElement(tag);
  const on = (target, type, callback) => target.addEventListener(type, callback, { signal });
  // 프로젝트 메뉴(project-menu.js): 머리줄 버튼의 팝오버. 안의 버튼 동작은 아래에서 단다.
  const projectMenu = ProjectMenu.create({ $, on });
  const original = Shader.fragment;
  const snapshot = () => ({
    image: renderer.getFragmentSource(),
    passes: renderer.getPassDefinitions(),
    imageChannels: renderer.getImageChannels(),
  });
  let textureButtons = [];
  let project = snapshot();
  let selected = "Image",
    timer = null,
    draftTimer = null,
    dirty = false,
    compileFailed = false,
    changeText = "",
    openState = false,
    disposed = false;
  // 공용 입력·확인 대화상자(studio-dialog.js). 열려 있는 동안 자동 적용(0.9초) 타이머를 멈췄다가, 닫을 때 미적용 변경이 남아 있으면 다시 건다.
  const dialogs = Dialog.create({
    $,
    on,
    pause: () => {
      const wasLive = !!timer;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return wasLive;
    },
    resume: wasLive => {
      if (wasLive && dirty && !disposed && $("studioLive").checked) timer = setTimeout(apply, 900);
    },
  });
  const ask = dialogs.ask;
  const proceed = (decision, action) =>
    decision instanceof Promise ? decision.then(ok => ok && action()) : decision && action();
  let expanded = false,
    splitMode = false, // 미리보기 분리 + 편집기 확대(splitEdit)로 들어온 집중 모드
    resumeAfterMaximize = false,
    navigatingHistory = false;
  const undoStack = [],
    redoStack = [],
    views = new Map();
  const syncHistory = () => {
    $("studioUndo").disabled = !undoStack.length;
    $("studioRedo").disabled = !redoStack.length;
  };
  const cursorState = () => {
    const area = $("studioCode");
    return {
      caret: [area.selectionStart, area.selectionEnd, area.selectionDirection],
      scroll: [area.scrollTop, area.scrollLeft],
    };
  };
  const historyState = () => ({
    project: copy(project),
    users: renderer.getUserUniforms(),
    selected,
    ...cursorState(),
  });
  let checkpoint = historyState(),
    editTime = 0,
    editTab = "";
  const recordEdit = (typing = false, usersChanged = false) => {
    if (navigatingHistory) return;
    const current = historyState();
    if (!usersChanged) checkpoint.users = current.users;
    if (same(current.project, checkpoint.project) && same(current.users, checkpoint.users)) return;
    const now = Date.now(),
      group = typing && editTab === selected && now - editTime < 700 && undoStack.length;
    if (!group) {
      undoStack.push(checkpoint);
      if (undoStack.length > 25) undoStack.shift();
    }
    redoStack.length = 0;
    checkpoint = current;
    editTime = typing ? now : 0;
    editTab = selected;
    syncHistory();
  };
  const captureCursor = () => {
    if (!navigatingHistory && selected === checkpoint.selected && same(project, checkpoint.project))
      Object.assign(checkpoint, cursorState());
  };
  // 숫자 끌어 바꾸기(Alt+드래그) 중에는 자동 적용 대기(0.9초) 없이 짧은 간격으로 바로 적용해 화면이 따라오게 한다.
  let scrubTimer = 0;
  const scrubApply = () => {
    if (scrubTimer) return;
    scrubTimer = setTimeout(() => {
      scrubTimer = 0;
      if (!disposed) apply();
    }, 60);
  };
  // 자동 완성에서 코드 조각 함수를 고르면 필요한 함수 정의를 전역 위치에 넣는다(이름 입력과 함께 Undo 한 번).
  const library = options.snippets
    ? {
        items: options.snippets.items,
        insert: id => {
          const item = options.snippets.items.find(entry => entry.id === id),
            plan = options.snippets.plan(id, $("studioCode").value);
          const global = plan.globals.map(entry => entry.code).join("\n\n");
          if (!global) return false;
          return insertCode({
            global,
            note: `코드 조각 '${item?.title || id}' 정의를 위쪽에 추가했습니다${plan.added.length ? ` (+ ${plan.added.join(", ")})` : ""} · Ctrl+Z로 되돌리기`,
          });
        },
      }
    : null;
  // 편집기: CodeMirror 6 (js/cm-editor.js). #studioCode textarea는 소스를 읽고 쓰는 창구다.
  const editor = Editor.mount(
    $("studioCode"),
    ask,
    captureCursor,
    () => renderer.getUserUniforms().map(item => item.name),
    {
      lookup: options.lookup,
      builtins: options.builtins,
      library,
      userUniforms: () => renderer.getUserUniforms().map(item => ({ name: item.name, type: item.type })),
      onScrub: scrubApply,
      renameUniform: request => renameUniform(request),
      notify: text => setStatus(text, "is-dirty"),
    }
  );
  for (const type of ["beforeinput", "select", "click", "keyup", "scroll"]) on($("studioCode"), type, captureCursor);
  const find = name => (name === "Image" ? null : project.passes.find(p => p.name === name));
  const clearChange = () => {
    changeText = "";
    $("studioChangeNotice").hidden = true;
  };
  const showChange = text => {
    changeText = text;
    $("studioChangeText").textContent = text + (dirty ? " · 실행 대기" : "");
    $("studioChangeNotice").hidden = false;
  };
  // 자동 복구본(이 탭의 localStorage·sessionStorage): 새로 고침·탭 닫힘 뒤 이어서 작업하기 위한 것. 이름 있는 '프로젝트 저장'과는 다르다.
  const clock = () => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  };
  const setStorage = (state, text, detail = "") => {
    const node = $("studioStorageState");
    node.dataset.state = state;
    node.textContent = text;
    node.title = `${detail ? detail + " · " : ""}자동 복구본은 이 브라우저 탭의 코드·채널 구성입니다. 파라미터·이미지까지 이름을 붙여 보관하려면 프로젝트 저장(Ctrl+S)을 쓰세요.`;
    node.setAttribute("aria-label", node.title);
  };
  const references = name => Model.references(project, name);
  const activeSource = () => (selected === "Image" ? project.image : find(selected)?.fragment);
  // ---- 프로젝트 스냅샷 규칙 ----
  // 보관함·Pack에 '담기는 것'과 '저장한 뒤 바뀌었는지' 판단이 어긋나지 않도록 둘 다 이 한 규칙에서 만든다.
  //   scene    코드(편집기에서 아직 실행하지 않은 것 포함)·버퍼 구성·채널 연결
  //   state    파라미터·렌더링 설정(settings.snapshot)
  //   textures 연결된 이미지의 이름·크기·샘플링(Filter·Wrap). 이미지 본문은 id가 같으면 같다(이미지 저장소는 바꿔 쓰지 않는다).
  //   selected 보고 있던 탭(Pack에는 담지만 지문에서는 뺀다)
  // 새 속성을 Pack에 넣을 때는 여기에 넣으면 지문에도 함께 들어간다.
  const captureScene = () => {
    const scene = copy(project),
      code = $("studioCode").value;
    if (selected === "Image") scene.image = code;
    else {
      const pass = scene.passes.find(p => p.name === selected);
      if (pass) pass.fragment = code;
    }
    return scene;
  };
  const textureInfo = scene => {
    const assets = renderer.getTextures();
    return Pack.textureIds(scene).map(id => {
      const meta = assets.find(asset => asset.id === id);
      return meta
        ? { id, name: meta.name, width: meta.width, height: meta.height, sampling: { ...meta.sampling } }
        : { id, missing: true };
    });
  };
  const projectSnapshot = () => {
    const scene = captureScene();
    return { scene, selected, state: settings?.snapshot() ?? null, textures: textureInfo(scene) };
  };
  const hashText = text => {
    let hash = 0x811c9dc5; // FNV-1a 32비트
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
  };
  // 저장 지문: 보관함에 담기는 전부. 패널 표시(panelHidden)는 이 기기의 화면 배치라 빼고, 보고 있는 탭도 뺀다.
  // 이미지가 없으면 예전 지문과 같은 값이 나오게 둔다(업데이트 직후 저장한 프로젝트가 모두 '바뀜'으로 보이지 않게).
  const printOf = snap => {
    const state = snap.state ? { ...snap.state } : null;
    if (state) delete state.panelHidden;
    const body = snap.textures.length
      ? { scene: snap.scene, state, textures: snap.textures }
      : { scene: snap.scene, state };
    return hashText(JSON.stringify(body));
  };
  // 작업 지문: 장면·파라미터·이미지만. 렌더링 설정(FPS 제한 등)은 예제를 열어도 그대로 남으므로 '이름 없는 작업이 바뀜' 판단에서 뺀다.
  const workPrintOf = snap =>
    hashText(JSON.stringify({ scene: snap.scene, user: snap.state?.user ?? null, textures: snap.textures }));
  const fingerprint = () => printOf(projectSnapshot());
  const workPrint = () => workPrintOf(projectSnapshot());
  // 작업이 통째로 바뀔 때(예제·새 프로젝트·파일·보관함 열기)마다 1씩 오른다. 저장 도중 작업이 바뀌었는지 확인하는 데 쓴다.
  let workEpoch = 0;
  // 브라우저 탭 제목: 보관함 프로젝트 이름(없으면 "저장 안 한 작업")과 상태 표시.
  //   ● 보관함과 다름 — 저장한 뒤 바뀜, 또는 이름 없는 작업이 시작한 뒤 바뀜(저장하면 사라짐)
  //   ✎ 코드 편집이 아직 실행에 반영되지 않음 · ⚠ 마지막 적용이 컴파일 오류
  let titleName = "저장 안 한 작업",
    titleState = "applied",
    isModified = () => false; // 보관함(studio-projects.js)을 만든 뒤 연결한다
  const syncTitle = () => {
    const modified = isModified(),
      mark = (titleState === "error" ? "⚠ " : titleState === "dirty" ? "✎ " : "") + (modified ? "● " : "");
    const title = `${mark}${titleName} — FIELD Studio`;
    if (document.title !== title) document.title = title;
    projectMenu.setModified(modified);
  };
  const setStatus = (message, style = "") => {
    if ($("studioMessage").textContent !== message) $("studioMessage").textContent = message;
    $("studioMessage").title = message;
    $("studioMessage").className = style;
    const state = dirty && compileFailed ? "error" : dirty ? "dirty" : "applied",
      label = state === "error" ? "컴파일 오류" : dirty ? "실행 대기" : "실행 반영됨";
    if ($("studioState").textContent !== label) $("studioState").textContent = label;
    $("studioState").dataset.state = state;
    titleState = state;
    syncTitle();
    $("studioRun").dataset.pending = String(dirty);
    $("studioGraphState").textContent = dirty ? "편집 중인 구성 · 실행 대기" : "실행에 반영된 구성";
    if (changeText) showChange(changeText);
    $("previewNotice").hidden = !dirty;
    $("previewNotice").textContent =
      state === "error"
        ? "코드를 적용하지 못했습니다. 화면은 마지막 성공 결과입니다."
        : "실행하지 않은 코드 변경이 있습니다. 화면은 마지막 성공 결과입니다.";
  };
  // 편집기 인라인 진단(패스별). 컴파일 성공 시 비우고, 탭 전환 시 해당 패스 항목만 보여준다.
  let diagnostics = [];
  const syncDiagnostics = () => editor.setDiagnostics?.(diagnostics.filter(item => item.pass === selected));
  // keepInline: 타이핑 중에는 인라인 진단을 지우지 않고 편집기가 흐리게(stale) 유지한다. 다음 컴파일 결과가 대체한다.
  const clearError = (keepInline = false) => {
    compileFailed = false;
    $("studioError").hidden = true;
    $("studioErrorToggle").hidden = true;
    $("studioDiagnostics").hidden = true;
    $("studioDiagnostics").replaceChildren();
    if (!keepInline && diagnostics.length) {
      diagnostics = [];
      syncDiagnostics();
    }
  };
  const showError = error => {
    const text = String(error?.message || error),
      panel = $("studioDiagnostics");
    $("studioError").textContent = text;
    $("studioError").hidden = true;
    $("studioErrorToggle").hidden = false;
    panel.replaceChildren();
    const matches = [...text.matchAll(/(?:ERROR|WARNING):\s*\d+:(\d+):\s*([^\r\n]*)/g)];
    diagnostics = [];
    for (const match of matches.slice(0, 15)) {
      const row = element("button"),
        info = error?.glslInjected,
        original = Number(match[1]);
      let line = original;
      const generated = info && original > info.after && original <= info.after + (info.generated ?? info.count);
      if (info && original > info.after + (info.generated ?? info.count)) line -= info.count;
      if (!generated)
        diagnostics.push({
          pass: error?.passName || selected,
          line,
          message: match[2],
          severity: match[0].startsWith("WARNING") ? "warning" : "error",
        });
      row.type = "button";
      row.textContent = `${error?.passName || selected} · ${generated ? "Auto Uniform" : `Line ${line}`} · ${match[2]}`;
      if (generated) {
        row.disabled = true;
        row.title = "자동 생성된 Uniform 선언에서 발생한 오류입니다.";
      } else {
        row.title = "원본 GLSL 줄로 이동";
        row.addEventListener("click", () => {
          open();
          if (error?.passName) select(error.passName);
          editor.goToLine(line);
        });
      }
      panel.append(row);
    }
    panel.hidden = !matches.length;
    syncDiagnostics();
    setStatus(`${error?.passName ? `${error.passName} 컴파일 오류` : "작업 오류"}: ${text.split("\n")[0]}`, "is-error");
  };
  const clearDraft = () => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
    $("studioDraft").hidden = true;
    Store.removeTab(DRAFT_KEY);
  };
  const scheduleDraft = () => {
    if (draftTimer) clearTimeout(draftTimer);
    setStorage("pending", "복구본 기록 대기");
    draftTimer = setTimeout(() => {
      draftTimer = null;
      rememberEditor();
      const error = Store.writeTabJSON(DRAFT_KEY, { version: 1, project, selected });
      if (error) setStorage("error", "복구본 기록 실패 · 새로 고치면 복구되지 않을 수 있음", error.message);
      else setStorage("draft", `복구본 저장됨 · ${clock()} · 실행 전 코드`);
    }, 550);
  };
  const saveLocal = () => {
    const error = Store.writeTabJSON(STORAGE_KEY, { version: 1, project, selected });
    if (error) setStorage("error", "복구본 기록 실패 · 새로 고치면 복구되지 않을 수 있음", error.message);
    else setStorage("saved", `복구본 저장됨 · ${clock()}`);
  };
  // 미리보기(뷰포트에 보이는 패스).
  //  · 탭을 바꾸면 그 패스를 따라간다(처음 쓰는 사람이 "내가 고치는 버퍼"를 바로 보게). 단, 고정(previewPinned)을 켜면 그대로 둔다.
  //  · 코드를 적용할 때(자동 적용 포함)는 미리보기를 바꾸지 않는다 — Buffer A를 고치면서 최종 Image를 보고 있을 수 있다.
  //    지금 보던 버퍼가 사라졌을 때만 Image로 돌아간다.
  //  · 편집기 머리줄의 미리보기 버튼(눈 아이콘 + Image / Buffer A)은 Image ↔ 편집 중인 패스를 오간다.
  const PIN_KEY = "field.previewPinned.v1";
  let previewPinned = Store.read(PIN_KEY) === "1";
  const passExists = name => renderer.getPasses().some(p => p.name === name);
  const preview = (force = false) => {
    if (previewPinned && !force) return keepPreview();
    const name = selected === "Image" ? null : selected;
    if (!name || passExists(name)) renderer.setPreviewPass(name);
    syncPreviewControls();
  };
  const keepPreview = () => {
    const current = renderer.getStats().previewPass;
    if (current && !passExists(current)) renderer.setPreviewPass(null);
    syncPreviewControls();
  };
  const togglePreview = () => {
    const current = renderer.getStats().previewPass;
    if (current) renderer.setPreviewPass(null);
    else if (selected !== "Image" && passExists(selected)) renderer.setPreviewPass(selected);
    syncPreviewControls();
    document.dispatchEvent(new Event("shader-preview-changed"));
  };
  const setPreviewPinned = pinned => {
    previewPinned = !!pinned;
    Store.write(PIN_KEY, previewPinned ? "1" : "0");
    syncPreviewControls();
  };
  // 버튼 상태: 보이는 것이 Image이고 편집 중인 것도 Image면 오갈 곳이 없다.
  const syncPreviewControls = () => {
    const target = $("studioPreviewTarget"),
      pin = $("studioPreviewPin");
    if (!target || !pin) return;
    const current = renderer.getStats().previewPass,
      other = current ? "Image" : selected !== "Image" && passExists(selected) ? `Buffer ${selected}` : null;
    target.textContent = current ? `Buffer ${current}` : "Image";
    target.setAttribute("aria-label", `미리보기: ${target.textContent}`);
    target.disabled = !other;
    target.title = other
      ? `미리보기: 지금 ${target.textContent} · 누르면 ${other}(으)로`
      : "미리보기: Image (편집 중인 패스도 Image)";
    pin.setAttribute("aria-pressed", String(previewPinned));
    pin.title = previewPinned
      ? "미리보기 고정 중: 탭을 바꿔도 미리보기가 그대로입니다 (누르면 해제)"
      : "미리보기 고정: 켜면 탭을 바꿔도 미리보기를 바꾸지 않습니다";
  };
  // 구조 변경은 전체 Pass 교체. 소스·채널만 바뀌면 해당 패스만 갱신하여 이전 Texture를 보존한다.
  const apply = (users = null) => {
    if (disposed) return false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    rememberEditor();
    try {
      validateProject(project);
      const touched =
        users && !same(users, renderer.getUserUniforms())
          ? renderer.applyPortable(project, users)
          : renderer.applyProject(project);
      syncHistory();
      keepPreview(); // 적용할 때는 미리보기를 바꾸지 않는다(위 preview 설명)
      dirty = false;
      clearError();
      clearDraft();
      setStatus(touched ? "적용됨 · GPU 프로그램/채널 동기화 완료" : "변경 사항 없음");
      saveLocal();
      const synced = syncAnnotations();
      if (synced) setStatus(synced);
      return true;
    } catch (error) {
      dirty = true;
      compileFailed = true;
      if (error.passName && error.passName !== selected) select(error.passName);
      showError(error);
      scheduleDraft();
      return false;
    }
  };
  // 컴파일 성공 후 GLSL 주석 어노테이션(@range/@step/@default/@color)을 파라미터에 반영한다.
  // 미등록 Uniform은 새로 등록하고, 등록된 것은 옵션만 갱신한다(값은 새 범위로 보정). 한 번의 재컴파일로 처리한다.
  const syncAnnotations = () => {
    const specs = Annotations.collect([project.image, ...project.passes.map(p => p.fragment)]);
    if (!specs.length) return "";
    const users = renderer.getUserUniforms(),
      next = users.map(u => ({ ...u, options: { ...u.options } })),
      added = [],
      updated = [],
      problems = [];
    for (const spec of specs) {
      if (spec.error) {
        problems.push(`${spec.name}: ${spec.error}`);
        continue;
      }
      const current = next.find(u => u.name === spec.name);
      if (!current) {
        next.push({ name: spec.name, type: spec.type, value: spec.value, options: spec.options });
        added.push(spec.name);
      } else if (current.type === spec.type && !Annotations.sameOptions(current.options, spec.options)) {
        current.options = spec.options;
        current.value = Annotations.clampValue(current.value, spec.options);
        updated.push(spec.name);
      }
    }
    if (added.length || updated.length) {
      try {
        renderer.setUserUniforms(next);
      } catch (error) {
        return `어노테이션 적용 실패: ${error.message}`;
      }
      checkpoint.users = renderer.getUserUniforms();
      document.dispatchEvent(new Event("shader-settings-applied"));
    }
    const parts = [
      added.length && `등록 ${added.join(", ")}`,
      updated.length && `범위 갱신 ${updated.join(", ")}`,
      problems.length && `무시 ${problems.join(" / ")}`,
    ].filter(Boolean);
    return parts.length ? `적용됨 · @어노테이션 ${parts.join(" · ")}` : "";
  };
  const schedule = (typing = false) => {
    clearChange();
    recordEdit(typing);
    dirty = true;
    clearError(true);
    setStatus(
      $("studioLive").checked ? "수정됨 · 자동 적용 대기 (0.9초)" : "수정됨 · 실행(Alt+Enter)으로 적용",
      "is-dirty"
    );
    scheduleDraft();
    if (timer) clearTimeout(timer);
    if ($("studioLive").checked) timer = setTimeout(apply, 900);
  };
  const rememberEditor = () => {
    const p = find(selected);
    if (selected === "Image") project.image = $("studioCode").value;
    else if (p) p.fragment = $("studioCode").value;
  };
  const activeChannels = () => (selected === "Image" ? project.imageChannels : find(selected)?.channels);
  const freeChannel = () => [0, 1, 2, 3].find(index => !activeChannels()?.[index]);
  const syncTextureTargets = () => {
    const slot = freeChannel(),
      target = selected === "Image" ? "Image" : `Buffer ${selected}`;
    for (const button of textureButtons) {
      button.disabled = slot === undefined;
      button.textContent = slot === undefined ? `${target} · 빈 채널 없음` : `${target} · iChannel${slot}에 연결`;
      button.title =
        slot === undefined
          ? "입력 채널 4개가 모두 사용 중입니다. 기존 연결을 해제하세요."
          : `${target}.iChannel${slot}에 연결 · 기존 입력을 덮어쓰지 않습니다.`;
      button.setAttribute("aria-label", `${button.dataset.assetName} · ${button.textContent}`);
    }
  };
  const validCurrent = (target, buffer) => Model.validCurrent(project, target, buffer);
  const inputInfo = (ref, assets) =>
    !ref
      ? { source: "연결 안 함", frame: "입력 없음", help: "사용할 이미지나 버퍼를 선택하세요." }
      : ref.keyboard
        ? {
            source: "키보드",
            frame: "입력",
            help: "키 상태 텍스처(256×3). x = 키 코드, y = 0 누름 · 1 이번 프레임에 눌림 · 2 토글. 뷰포트를 클릭하면 키가 셰이더로 갑니다.",
          }
        : ref.texture
          ? {
              source: assets.find(asset => asset.id === ref.texture)?.name || "사용할 수 없는 이미지",
              frame: "이미지",
              help: "이미지 원본을 읽습니다. Filter와 Wrap은 이미지 설정을 따릅니다.",
            }
          : {
              source: `Buffer ${ref.buffer}${ref.attachment ? `[${ref.attachment}]` : ""}`,
              frame: ref.frame === "current" ? "current · 이번 프레임" : "previous · 지난 프레임",
              help:
                ref.frame === "current"
                  ? "이번 프레임에 앞서 실행된 버퍼의 결과를 읽습니다."
                  : "지난 프레임에 저장된 버퍼 결과를 읽습니다. 자기 자신을 연결하면 피드백을 만들 수 있습니다.",
            };
  // 입력 채널 칩과 고르기 팝오버(channel-picker.js). 바뀐 연결은 여기서 초안에 넣고, 자동이면 바로 적용한다.
  const channelPicker = ChannelPicker.create({
    $,
    on,
    element,
    inputInfo,
    onChange: (i, ref) => {
      const channels = activeChannels();
      if (!channels) return;
      if (ref) channels[i] = ref;
      else delete channels[i];
      schedule();
      renderGraph();
      syncTextureTargets();
      syncInputs();
      if (!$("studioLive").checked) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      apply();
    },
    onLoadImage: i => pickImage(i),
    onDropImage: (i, file) => runFile($("studioTextureAdd"), "이미지 읽는 중…", () => loadImage(file, i)),
  });
  // 입력 채널 줄은 자주 쓰지 않으므로 기본은 접어 둔다: 패스나 프로젝트가 바뀔 때 그 패스에 연결이 있으면 펴고, 없으면 접는다.
  // 그 사이에는 사용자가 정한 대로 두되(연결을 끊어도 갑자기 닫지 않는다), 접힌 동안 새 연결이 생기면 편다.
  // 접혀 있어도 코드 머리줄의 입력 버튼이 연결 수와 "읽는데 비어 있음" 경고를 보여 준다.
  let inputsOpen = false,
    inputsFor = "",
    inputsCount = 0;
  const showInputs = open => {
    inputsOpen = open;
    $("studioInputs").hidden = !open;
    if (!open) channelPicker.close();
    const toggle = $("studioInputsToggle");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "입력 채널 숨기기" : "입력 채널 보이기");
  };
  const syncInputs = () => {
    const channels = activeChannels() || {},
      count = Object.keys(channels).length,
      key = `${workEpoch}:${selected}`;
    if (key !== inputsFor) {
      inputsFor = key;
      showInputs(count > 0);
    } else if (count > inputsCount && !inputsOpen) showInputs(true);
    inputsCount = count;
    const counter = $("studioInputsCount");
    counter.textContent = String(count);
    counter.hidden = !count;
    syncInputsWarning(activeSource() || ""); // 편집기 문서는 renderEditor가 이 다음에 바꾼다
  };
  // 코드가 읽는 iChannel이 비어 있으면 입력 버튼에 경고 점을 찍는다(타이핑 중에는 줄을 펴지 않는다 — 화면이 밀리지 않게).
  const syncInputsWarning = (source = $("studioCode").value) => {
    const channels = activeChannels() || {},
      empty = [...ChannelPicker.usedChannels(source)].filter(i => !channels[i]),
      toggle = $("studioInputsToggle");
    toggle.dataset.warn = String(empty.length > 0);
    toggle.title = `입력 채널(iChannel0–3) ${inputsOpen ? "숨기기" : "보이기"}${inputsCount ? ` · ${inputsCount}개 연결됨` : " · 연결 없음"}${empty.length ? ` · 코드가 읽는 iChannel${empty.join(", ")}이 비어 있음` : ""}`;
  };
  const renderChannels = () => {
    const channels = activeChannels(),
      assets = renderer.getTextures(),
      blocked = project.passes.filter(pass => !validCurrent(selected, pass.name));
    $("studioInputsTitle").textContent = `${selected} · 입력`;
    $("studioChannelRules").textContent =
      selected === "Image"
        ? "Image는 버퍼 실행이 끝난 뒤 그려집니다. 모든 버퍼의 current 또는 previous를 읽을 수 있습니다."
        : `current는 앞서 실행되는 버퍼만 선택할 수 있습니다.${blocked.length ? ` ${blocked.map(pass => pass.name).join(", ")}는 자기 자신 또는 뒤에서 실행되는 버퍼이므로 previous로 연결하세요.` : ""}`;
    channelPicker.render({
      target: selected,
      channels,
      assets,
      passes: project.passes.map(pass => ({ name: pass.name, outputs: pass.outputs || 1 })),
      validCurrent: name => validCurrent(selected, name),
      // 편집기 문서는 renderEditor가 이 다음에 바꾸므로, 선택한 패스의 소스를 직접 읽는다.
      source: activeSource() || "",
    });
    syncTextureTargets();
    syncInputs();
  };
  // 패스 탭에 마우스를 올리면 그 패스가 읽는 입력을 보여 준다(전체 그래프는 성능 탭의 패스 연결).
  const tabTitle = name => {
    const channels = (name === "Image" ? project.imageChannels : find(name)?.channels) || {},
      assets = renderer.getTextures(),
      inputs = Object.entries(channels)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([i, ref]) => `iChannel${i} ← ${inputInfo(ref, assets).source}`);
    return `${name} 패스 편집 (Alt+PageUp/Down · Alt+, / Alt+.)${inputs.length ? `\n${inputs.join("\n")}` : ""}`;
  };
  const renderGraph = () => {
    const holder = $("studioGraph"),
      assets = renderer.getTextures();
    for (const name of ["Image", ...project.passes.map(pass => pass.name)]) {
      const tab = $(`studioTab-${name}`);
      if (tab) tab.title = tabTitle(name);
    }
    holder.replaceChildren();
    for (const entry of [...project.passes, { name: "Image", channels: project.imageChannels }]) {
      const row = element("button"),
        name = element("strong");
      row.type = "button";
      row.classList.toggle("is-current", entry.name === selected);
      row.setAttribute("aria-pressed", String(entry.name === selected));
      row.title = `${entry.name} 패스 편집`;
      name.textContent = entry.name === "Image" ? "Image · Canvas" : `Buffer ${entry.name}`;
      row.append(name);
      const inputs = Object.entries(entry.channels || {}).sort(([a], [b]) => Number(a) - Number(b));
      if (!inputs.length) {
        const empty = element("small");
        empty.textContent = "연결된 채널 없음";
        row.append(empty);
      }
      for (const [i, ref] of inputs) {
        const info = inputInfo(ref, assets),
          line = element("span"),
          channel = element("span"),
          source = element("span"),
          frame = element("small");
        line.className = "studio-graph-input";
        channel.className = "studio-graph-channel";
        channel.textContent = `iChannel${i}`;
        source.className = "studio-graph-source";
        source.textContent = info.source;
        frame.className = "studio-graph-frame";
        frame.textContent = info.frame;
        line.append(channel, source, frame);
        row.append(line);
      }
      row.addEventListener("click", () => {
        if (!openState) open();
        select(entry.name);
      });
      holder.append(row);
    }
  };
  // 새 이미지는 사용 중인 연결을 덮어쓰지 않고 첫 빈 채널에만 연결한다. target: 채널 선택 목록에서 고른 채널(덮어씀)
  const connectTexture = (id, target) => {
    rememberEditor();
    const channels = activeChannels(),
      slot = target ?? freeChannel(),
      previous = channels[slot];
    if (slot === undefined) {
      setStatus("빈 입력 채널이 없습니다. 기존 채널을 해제한 뒤 연결하세요.", "is-error");
      return false;
    }
    channels[slot] = { texture: id };
    renderChannels();
    renderGraph();
    schedule();
    if (apply()) {
      setStatus(`${inputInfo({ texture: id }, renderer.getTextures()).source} → ${selected}.iChannel${slot} 연결됨`);
      return true;
    }
    if (previous) channels[slot] = previous;
    else delete channels[slot];
    renderChannels();
    renderGraph();
    return false;
  };
  // ---- 이미지 자원 ----
  // 쓰는 이미지: 지금 작업 · 되돌리기/다시 실행 기록 · 이 탭의 자동 복구본이 연결한 이미지. 보관함 프로젝트와 내보낸 파일은
  // 이미지 원본을 따로 담고 있으므로(열 때 다시 등록) 여기서 지워도 잃지 않는다.
  const textureUsage = () => {
    const current = new Set(Pack.textureIds(captureScene())),
      kept = new Set();
    const add = scene => {
      try {
        for (const id of Pack.textureIds(scene)) if (!current.has(id)) kept.add(id);
      } catch (_) {
        /* 모양이 깨진 기록은 건너뛴다. */
      }
    };
    for (const entry of [...undoStack, ...redoStack, checkpoint]) add(entry.project);
    for (const key of [STORAGE_KEY, DRAFT_KEY]) {
      const stored = Store.readTabJSON(key)?.project;
      if (stored) add(stored);
    }
    return { current, kept };
  };
  const megabytes = bytes =>
    bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
  // GPU에 올린 RGBA8 텍스처의 어림 크기(밉맵 제외).
  const gpuBytes = asset => asset.width * asset.height * 4;
  const cleanupTextures = async () => {
    const { current, kept } = textureUsage(),
      unused = renderer.getTextures().filter(asset => !current.has(asset.id) && !kept.has(asset.id));
    if (!unused.length) return setStatus("정리할 이미지가 없습니다 · 모두 지금 작업이나 되돌리기 기록에서 씁니다");
    const bytes = unused.reduce((sum, asset) => sum + (renderer.getTextureFile(asset.id)?.size || 0), 0);
    const ok = await ask({
      title: "쓰지 않는 이미지 정리",
      message: `지금 작업·되돌리기 기록·자동 복구본 어디에서도 쓰지 않는 이미지 ${unused.length}개(파일 ${megabytes(bytes)} · GPU 약 ${megabytes(unused.reduce((sum, asset) => sum + gpuBytes(asset), 0))})를 이 브라우저에서 지웁니다. 보관함에 저장한 프로젝트와 내보낸 프로젝트 파일은 이미지 원본을 따로 담고 있어 영향이 없습니다. 지울 이미지: ${unused.map(asset => asset.name).join(", ")}`,
      ok: "정리",
      danger: true,
    });
    if (!ok) return;
    let removed = 0;
    for (const asset of unused)
      try {
        if (await renderer.removeTexture(asset.id)) removed++;
      } catch (error) {
        console.warn("이미지 정리 실패:", asset.id, error);
      }
    renderTextures();
    renderChannels();
    setStatus(`쓰지 않는 이미지 ${removed}개를 정리했습니다`);
  };
  const renderTextures = () => {
    const holder = $("studioTextureList"),
      assets = renderer.getTextures(),
      usage = textureUsage();
    let footer = null; // 전체 용량 요약은 목록 아래에 둔다
    textureButtons = [];
    holder.replaceChildren();
    if (!assets.length) {
      const hint = element("p");
      hint.className = "studio-hint";
      hint.textContent = "등록된 이미지가 없습니다. PNG·JPEG·WebP 파일을 추가하고 입력 채널에 연결하세요.";
      holder.append(hint);
    } else {
      // 전체 용량: 이 브라우저에 보관한 원본 파일과 GPU 메모리 어림값. 쓰지 않는 이미지가 있으면 정리 버튼을 보인다.
      const files = assets.reduce((sum, asset) => sum + (renderer.getTextureFile(asset.id)?.size || 0), 0),
        gpu = assets.reduce((sum, asset) => sum + gpuBytes(asset), 0),
        unused = assets.filter(asset => !usage.current.has(asset.id) && !usage.kept.has(asset.id)).length,
        failed = renderer.failedTextures?.() || [],
        summary = element("div"),
        text = element("span");
      summary.className = "studio-texture-summary";
      text.textContent = `이미지 ${assets.length}개 · 파일 ${megabytes(files)} · GPU 약 ${megabytes(gpu)}${unused ? ` · 쓰지 않음 ${unused}개` : ""}${failed.length ? ` · 복원 실패 ${failed.length}개` : ""}`;
      text.title = "파일: 이 브라우저에 보관한 이미지 원본 합계 · GPU: 화면에 올린 텍스처의 어림 크기";
      summary.append(text);
      if (unused) {
        const clean = element("button");
        clean.type = "button";
        clean.id = "studioTextureCleanup";
        clean.textContent = "쓰지 않는 이미지 정리…";
        clean.addEventListener("click", cleanupTextures);
        summary.append(clean);
      }
      footer = summary;
    }
    for (const asset of assets) {
      const row = element("div"),
        name = element("span"),
        del = element("button");
      row.className = "studio-texture";
      const state = usage.current.has(asset.id) ? "current" : usage.kept.has(asset.id) ? "history" : "unused";
      row.dataset.usage = state;
      const size = renderer.getTextureFile(asset.id)?.size || 0;
      name.textContent = `${asset.name} · ${asset.width}×${asset.height}${size ? ` · ${megabytes(size)}` : ""} · ${{ current: "사용 중", history: "되돌리기 기록에서 씀", unused: "쓰지 않음" }[state]}`;
      del.type = "button";
      del.className = "glyph-icon icon-close";
      del.title = `${asset.name} 삭제`;
      del.setAttribute("aria-label", del.title);
      del.addEventListener("click", async () => {
        if (
          !(await ask({
            title: "이미지 삭제",
            message: `${asset.name} 이미지와 연결을 삭제할까요?`,
            ok: "삭제",
            danger: true,
          }))
        )
          return;
        rememberEditor();
        const before = copy(project);
        for (const pass of project.passes)
          for (const key of Object.keys(pass.channels))
            if (pass.channels[key].texture === asset.id) delete pass.channels[key];
        for (const key of Object.keys(project.imageChannels))
          if (project.imageChannels[key].texture === asset.id) delete project.imageChannels[key];
        if (!apply()) {
          project = before;
          renderEditor();
          return;
        }
        try {
          await renderer.removeTexture(asset.id);
          renderTextures();
          renderChannels();
          renderGraph();
        } catch (error) {
          showError(error);
        }
      });
      const use = element("button");
      use.type = "button";
      use.className = "texture-connect";
      use.dataset.assetName = asset.name;
      textureButtons.push(use);
      use.addEventListener("click", () => connectTexture(asset.id));
      const controls = element("div");
      controls.className = "studio-sampling";
      for (const [key, title, values] of [
        [
          "filter",
          "Filter",
          [
            ["linear", "Linear"],
            ["nearest", "Nearest"],
          ],
        ],
        [
          "wrapS",
          "Wrap X",
          [
            ["clamp", "Clamp"],
            ["repeat", "Repeat"],
            ["mirror", "Mirror"],
          ],
        ],
        [
          "wrapT",
          "Wrap Y",
          [
            ["clamp", "Clamp"],
            ["repeat", "Repeat"],
            ["mirror", "Mirror"],
          ],
        ],
      ]) {
        const label = element("label"),
          select = element("select");
        label.textContent = title;
        for (const [value, text] of values) {
          const option = element("option");
          option.value = value;
          option.textContent = text;
          select.append(option);
        }
        select.value = asset.sampling[key];
        select.title = `${asset.name}: ${title}`;
        select.addEventListener("change", async () => {
          try {
            const result = await renderer.setTextureSampling(asset.id, { [key]: select.value });
            setStatus(result.saved ? "Texture 샘플링 적용·저장됨" : "샘플링 적용됨 · 브라우저 저장소 저장 실패");
          } catch (error) {
            select.value =
              renderer.getTextures().find(item => item.id === asset.id)?.sampling[key] || asset.sampling[key];
            showError(error);
          }
        });
        label.append(select);
        controls.append(label);
      }
      row.append(name, use, del, controls);
      holder.append(row);
    }
    if (footer) holder.append(footer);
    syncTextureTargets();
  };
  const renderTabs = () => {
    const parent = $("studioPassTabs");
    parent.replaceChildren();
    for (const name of ["Image", ...project.passes.map(p => p.name)]) {
      const btn = element("button");
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.id = `studioTab-${name}`;
      btn.setAttribute("aria-controls", "studioCode");
      btn.classList.toggle("is-active", selected === name);
      btn.setAttribute("aria-selected", String(selected === name));
      btn.tabIndex = selected === name ? 0 : -1;
      btn.textContent = name === "Image" ? "Image" : `Buffer ${name}`;
      btn.title = tabTitle(name);
      btn.addEventListener("click", () => select(name));
      parent.append(btn);
    }
    // 탭이 많아 가로로 넘치면 선택한 탭이 보이도록 탭 줄을 민다.
    const active = parent.querySelector?.(".is-active"),
      box = parent.getBoundingClientRect?.(),
      tab = active?.getBoundingClientRect?.();
    if (box && tab && box.width > 0) {
      if (tab.left < box.left) parent.scrollLeft -= box.left - tab.left;
      else if (tab.right > box.right) parent.scrollLeft += tab.right - box.right;
    }
    for (const name of views.keys()) if (name !== "Image" && !find(name)) views.delete(name);
    $("studioCode").setAttribute("aria-labelledby", `studioTab-${selected}`);
    $("studioAdd").disabled = project.passes.length >= 8;
    const p = find(selected),
      idx = project.passes.findIndex(pass => pass.name === selected);
    $("studioPassTools").hidden = !p;
    $("studioRemove").disabled = !p;
    $("studioDuplicate").disabled = !p || project.passes.length >= 8;
    $("studioUp").disabled = !p || idx === 0;
    $("studioDown").disabled = !p || idx === project.passes.length - 1;
    for (const id of [
      "studioFormatField",
      "studioScaleField",
      "studioOutputsField",
      "studioFilterField",
      "studioWrapField",
      "studioMipField",
    ])
      $(id).hidden = !p;
    const refs = p ? references(selected) : [];
    $("studioPassImpact").hidden = !p;
    $("studioPassImpact").textContent = refs.length ? `삭제 시 연결 ${refs.length}개 해제` : "다른 패스의 참조 없음";
    $("studioRemove").title = p
      ? `${selected} 삭제${refs.length ? ` · 함께 해제: ${refs.join(", ")}` : ""} · Undo로 복원`
      : "Image는 삭제할 수 없습니다.";
    if (p) {
      $("studioFormat").value = p.format;
      // 해상도: 화면 비율(scale) 또는 고정 크기(size). 목록에 없는 고정 크기는 임시 선택지로 보여준다.
      const scaleSelect = $("studioScale"),
        sizeValue = p.size ? `size:${p.size[0]}x${p.size[1]}` : String(p.scale);
      scaleSelect.querySelector("option[data-custom]")?.remove();
      if (![...scaleSelect.options].some(o => o.value === sizeValue)) {
        const option = element("option");
        option.dataset.custom = "true";
        option.value = sizeValue;
        option.textContent = p.size ? `${p.size[0]}×${p.size[1]}` : `${Math.round(p.scale * 100)}%`;
        scaleSelect.append(option);
      }
      scaleSelect.value = sizeValue;
      $("studioOutputs").value = String(p.outputs || 1);
      $("studioFilter").value = p.filter || (p.format === "rgba32f" ? "nearest" : "linear");
      $("studioWrap").value = p.wrap || "clamp";
      $("studioMip").checked = !!p.mipmap;
    }
    $("studioCodeTitle").textContent = selected === "Image" ? "Image.frag" : `Buffer ${selected}.frag`;
    // 버퍼 설정은 접힌 한 줄 요약으로 보여준다: "A · RGBA8 · 100% · Linear · Clamp"
    if (p) {
      const size = p.size ? `${p.size[0]}×${p.size[1]}` : `${Math.round(p.scale * 100)}%`,
        filter = p.filter || (p.format === "rgba32f" ? "nearest" : "linear");
      const parts = [
        p.format.toUpperCase(),
        size,
        filter === "nearest" ? "Nearest" : "Linear",
        { clamp: "Clamp", repeat: "Repeat", mirror: "Mirror" }[p.wrap || "clamp"],
      ];
      if ((p.outputs || 1) > 1) parts.push(`출력 ${p.outputs}개`);
      if (p.mipmap) parts.push("밉맵");
      $("studioPassSummary").textContent = `${selected} · ${parts.join(" · ")}`;
    }
  };
  // 편집기에 지금 표시 중인 패스. 같은 패스의 소스가 그대로면 문서를 다시 넣지 않아 커서·스크롤·접힌 블록·검색 상태를 지킨다.
  // 다른 패스로 바뀔 때만 나가는 패스의 화면 상태를 views에 보관하고, 들어오는 패스의 상태(소스가 같을 때)를 되살린다.
  let shown = null;
  const renderEditor = () => {
    renderTabs();
    renderChannels();
    const area = $("studioCode"),
      source = activeSource() || "";
    if (shown !== selected || area.value !== source) {
      if (shown !== null && shown !== selected && (shown === "Image" || find(shown)))
        views.set(shown, { source: area.value, ...cursorState(), folds: editor.getFolds?.() || [] });
      const view = views.get(selected),
        keep = view?.source === source;
      area.value = source;
      const caret = keep ? view.caret : [0, 0, "none"],
        scroll = keep ? view.scroll : [0, 0];
      area.setSelectionRange(caret[0], caret[1], caret[2]);
      if (keep && view.folds?.length) editor.setFolds?.(view.folds);
      area.scrollTop = scroll[0];
      area.scrollLeft = scroll[1];
      shown = selected;
    }
    syncDiagnostics();
    editor.update();
    renderGraph();
  };
  const select = name => {
    if (name !== "Image" && !find(name)) return;
    if (name === selected) return;
    rememberEditor();
    selected = name;
    renderEditor();
    checkpoint.selected = selected;
    preview();
    rememberTab();
  };
  // 고른 패스 탭은 새로 고침 뒤에도 이어지도록 저장된 프로젝트의 selected만 갱신한다(소스는 실행 성공 때만 저장).
  const rememberTab = () => {
    const data = Store.readTabJSON(STORAGE_KEY);
    if (data?.version !== 1 || data.selected === selected) return;
    data.selected = selected;
    Store.writeTabJSON(STORAGE_KEY, data);
  };
  const normalizeDependencies = () => Model.normalizeDependencies(project);
  const add = () => {
    rememberEditor();
    const names = new Set(project.passes.map(p => p.name));
    if (project.passes.length >= 8) return showError("Buffer는 최대 8개까지 추가할 수 있습니다.");
    const name = [..."ABCDEFGH"].find(n => !names.has(n));
    project.passes.push({ name, fragment: Examples.blank, format: "rgba8", scale: 1, channels: {} });
    selected = name;
    renderEditor();
    schedule();
    apply();
  };
  const duplicate = () => {
    const source = find(selected);
    if (!source || project.passes.length >= 8) return;
    rememberEditor();
    const names = new Set(project.passes.map(p => p.name));
    const name = [..."ABCDEFGH"].find(n => !names.has(n));
    if (!name) return showError("사용 가능한 Buffer 이름이 없습니다.");
    const item = copy(source);
    item.name = name;
    for (const ref of Object.values(item.channels))
      if (ref.buffer === source.name && ref.frame === "previous") ref.buffer = name;
    project.passes.splice(project.passes.indexOf(source) + 1, 0, item);
    selected = name;
    renderEditor();
    schedule();
    apply();
  };
  const remove = () => {
    if (selected === "Image") return;
    rememberEditor();
    const name = selected,
      refs = references(name);
    project.passes = project.passes.filter(p => p.name !== name);
    for (const p of project.passes)
      for (const key of Object.keys(p.channels)) if (p.channels[key].buffer === name) delete p.channels[key];
    for (const key of Object.keys(project.imageChannels))
      if (project.imageChannels[key].buffer === name) delete project.imageChannels[key];
    selected = "Image";
    renderEditor();
    schedule();
    apply();
    showChange(
      `${name} 삭제${refs.length ? ` · 해제된 연결 ${refs.length}개: ${refs.join(", ")}` : " · 다른 패스의 연결 변경 없음"}`
    );
  };
  const move = dir => {
    const idx = project.passes.findIndex(p => p.name === selected),
      next = idx + dir;
    if (idx < 0 || next < 0 || next >= project.passes.length) return;
    rememberEditor();
    [project.passes[idx], project.passes[next]] = [project.passes[next], project.passes[idx]];
    const changed = normalizeDependencies();
    renderEditor();
    schedule();
    apply();
    showChange(
      changed.length
        ? `실행 순서 변경 · current → previous: ${changed.join(", ")}`
        : "실행 순서 변경 · 채널의 프레임 참조 변경 없음"
    );
  };
  const setProject = next => {
    if (disposed) return false;
    clearChange();
    const before = project,
      previousSelected = selected;
    try {
      project = validateProject(next);
      selected = "Image";
      renderEditor();
      if (!apply()) {
        project = before;
        selected = previousSelected;
        renderEditor();
        return false;
      }
      recordEdit();
      workEpoch++;
      syncInputs(); // 새 프로젝트: 입력 줄을 연결 여부에 맞춰 다시 접거나 편다
      return true;
    } catch (error) {
      project = before;
      selected = previousSelected;
      renderEditor();
      showError(error);
      return false;
    }
  };
  const historyMove = backwards => {
    const from = backwards ? undoStack : redoStack,
      to = backwards ? redoStack : undoStack;
    if (!from.length) return false;
    clearChange();
    if (timer) clearTimeout(timer);
    timer = null;
    const target = from.pop(),
      current = historyState();
    to.push(current);
    if (to.length > 25) to.shift();
    navigatingHistory = true;
    project = copy(target.project);
    selected = target.selected;
    renderEditor();
    const area = $("studioCode"),
      a = target.caret || [0, 0],
      scroll = target.scroll || [0, 0];
    area.focus({ preventScroll: true });
    area.setSelectionRange(Math.min(a[0], area.value.length), Math.min(a[1], area.value.length), a[2] || "none");
    area.scrollTop = scroll[0];
    area.scrollLeft = scroll[1];
    editor.update();
    const applied = apply(target.users);
    if (applied && !same(current.users, target.users)) document.dispatchEvent(new Event("shader-settings-applied"));
    navigatingHistory = false;
    checkpoint = historyState();
    editTime = 0;
    syncHistory();
    return true;
  };
  // Uniform 이름 바꾸기(편집기 F2가 부른다): 지금 패스(spots), 같은 Uniform을 선언한 다른 패스, 등록된 파라미터 값을
  // 한 번에 바꾸고 Undo 한 번으로 되돌린다. 실행에 실패해도(컴파일 오류) 코드 변경은 남기고 오류를 보인다.
  //   돌려주는 값: {passes: 함께 바꾼 다른 패스 수, parameter: 파라미터 값을 옮겼는지} 또는 null(편집기가 지금 패스만 바꾼다)
  const renameUniform = ({ from, to, spots, head }) => {
    if (disposed) return null;
    rememberEditor();
    const code = $("studioCode").value,
      before = copy(project),
      users = renderer.getUserUniforms(),
      registered = users.some(item => item.name === from);
    if (users.some(item => item.name === to)) {
      setStatus(`'${to}' 파라미터가 이미 있어 Uniform 이름을 바꾸지 않았습니다`, "is-error");
      return { passes: 0, parameter: false, refused: true };
    }
    // Undo가 이름 바꾸기 직전의 파라미터 목록으로 돌아가도록 기록 지점의 파라미터를 지금 것으로 맞춘다
    // (파라미터 패널·어노테이션으로 등록한 값은 코드 편집 기록과 따로 바뀐다).
    checkpoint.users = users;
    let passes = 0;
    const renameIn = source => {
      const plan = Scope.planGlobal(source, from, to);
      if (!plan?.ok || !plan.symbol.uniform) return source;
      passes++;
      return Scope.applyRename(source, plan.spots, from, to);
    };
    const current = Scope.applyRename(code, spots, from, to);
    if (selected === "Image") project.image = current;
    else project.image = renameIn(project.image);
    for (const pass of project.passes) pass.fragment = pass.name === selected ? current : renameIn(pass.fragment);
    const nextUsers = registered ? users.map(item => (item.name === from ? { ...item, name: to } : item)) : null;
    // 커서는 바뀐 글자 수만큼 옮긴다.
    const shift = spots.filter(at => at < head).length * (to.length - from.length);
    renderEditor();
    $("studioCode").setSelectionRange(head + shift, head + shift);
    const applied = apply(nextUsers);
    if (applied && nextUsers) document.dispatchEvent(new Event("shader-settings-applied"));
    if (!applied && same(before, project)) return null;
    recordEdit(false, true);
    return { passes, parameter: registered && applied };
  };
  // 지금 작업을 다른 작업(예제·새 프로젝트·파일·보관함 항목)으로 바꾸기 전에 묻는다.
  //   지킬 것: 보관함과 다른 작업(저장한 뒤 바뀐 프로젝트, 시작한 뒤 바뀐 이름 없는 작업) · 실행하지 않은 코드
  //   저장하고 계속(이름 없는 작업은 이름을 묻는다) · 저장하지 않고 계속 · 취소
  // 돌려주는 값: true(계속) 또는 Promise<boolean>
  const confirmReplace = () => {
    const unsaved = !!projects?.modified(),
      canSave = !!projects?.available();
    if (!unsaved && !dirty) return true;
    const name = projects?.current()?.name,
      parts = [];
    if (unsaved)
      parts.push(name ? `'${name}'에 저장하지 않은 변경이 있습니다.` : "프로젝트로 저장하지 않은 작업입니다.");
    if (dirty)
      parts.push(
        compileFailed ? "컴파일 오류로 실행하지 못한 코드가 있습니다." : "아직 실행하지 않은 코드 수정이 있습니다."
      );
    parts.push("계속하면 지금 작업은 Undo(Ctrl+Z)로만 되돌릴 수 있습니다.");
    if (!unsaved || !canSave)
      return ask({ title: "저장하지 않은 변경", message: parts.join(" "), ok: "계속", danger: true });
    return ask({
      title: "저장하지 않은 변경",
      message: parts.join(" "),
      ok: name ? "저장하고 계속" : "저장하고 계속…",
      alt: "저장하지 않고 계속",
    }).then(choice => (choice === "alt" ? true : choice === true ? projects.saveBeforeLeave() : false));
  };
  // 코드 파일(.frag) 열기처럼 지금 패스의 코드만 바꾸는 일(Undo로 되돌림)은 실행하지 않은 수정만 확인한다.
  const confirmCodeReplace = () =>
    !dirty ||
    ask({
      title: "실행하지 않은 코드",
      message:
        "아직 실행하지 않은 GLSL 수정 내용이 있습니다. 계속하면 지금 패스의 코드를 파일 내용으로 바꿉니다(Ctrl+Z로 되돌리기).",
      ok: "계속",
      danger: true,
    });
  // 프로젝트 보관함 화면(studio-projects.js). 아래쪽 초기화 때 만든다.
  let projects = null;
  // 다른 작업(예제·새 프로젝트·Pack·보관함 항목)으로 통째로 바뀐다. 보관함의 "작업 중" 표시는 잊는다(열기 경로는 성공 후 다시 정한다).
  const adoptProject = (next, tab = "Image") => {
    workEpoch++;
    projects?.forget();
    clearChange();
    views.clear();
    shown = null;
    project = copy(next);
    selected = tab === "Image" || find(tab) ? tab : "Image";
    dirty = false;
    clearError();
    clearDraft();
    renderEditor();
    recordEdit(false, true);
    Object.assign(checkpoint, { selected, ...cursorState() });
    preview(true); // 새 프로젝트: 고정과 상관없이 고른 탭을 보여 준다
    saveLocal();
    revealCode();
  };
  // 프로젝트 메뉴에서 프로젝트를 바꾸면 메뉴를 닫아 새 화면을 보여 준다.
  const revealCode = () => projectMenu.close();
  const replaceProject = (next, users = []) => {
    try {
      rememberEditor();
      checkpoint = historyState();
      renderer.applyPortable(next, users);
      adoptProject(next);
      // 예제 소스의 @어노테이션도 바로 파라미터로 등록한다(apply 경로를 거치지 않으므로 여기서 동기화).
      syncAnnotations();
      const count = renderer.getUserUniforms().length;
      settings?.save();
      document.dispatchEvent(new Event("shader-settings-applied"));
      projects?.markClean();
      setStatus(`새 프로젝트 시작 · 파라미터 ${count}개 · Undo로 이전 작업 복원`);
      return true;
    } catch (error) {
      showError(error);
      return false;
    }
  };
  const startProject = (next, users = []) => proceed(confirmReplace(), () => replaceProject(next, users));
  const exampleRaymarch = () =>
    startProject(
      { image: Shader.raymarch, passes: Shader.raymarchPasses, imageChannels: Shader.raymarchChannels },
      Shader.rayUniforms.map(([name, type, value, options]) => ({ name, type, value, options: options || {} }))
    );
  const examplePipeline = () => startProject(Examples.pipelineProject());
  const exampleFeedback = () => startProject(Examples.feedbackProject());
  const loadFromRenderer = () =>
    proceed(confirmReplace(), () => {
      project = snapshot();
      selected = "Image";
      renderEditor();
      recordEdit();
      clearError();
      dirty = false;
      clearDraft();
      workEpoch++;
      syncInputs();
      setStatus("렌더러의 현재 버퍼 구성을 불러왔습니다.");
      saveLocal();
      return true;
    });
  const open = () => {
    // 설정 패널은 사용자가 직접 열고 닫는다. 편집기를 열거나 예제를 고르거나 코드 조각을 넣어도
    // 패널 표시를 바꾸지 않는다(사용자가 하지 않은 일로 화면 구조가 바뀌지 않게).
    if (openState) {
      $("studioCode").focus({ preventScroll: true });
      return;
    }
    openState = true;
    $("studioDock").hidden = false;
    $("studioResize").hidden = expanded;
    $("studioToggle").setAttribute("aria-label", "셰이더 편집기 닫기");
    $("studioToggle").setAttribute("aria-expanded", "true");
    $("studioCode").focus({ preventScroll: true });
    workspace.saveWorkspace();
  }; // 재생 버튼은 아이콘(정지 중이면 ▶)과 접근 가능한 이름으로 상태를 알린다. 집중 모드에서는 복귀 후 재생 여부를 고른다.
  // 집중 모드는 미리보기가 가려지므로 재생을 붙잡아 둔다(held). 미리보기를 별도 창으로 뺐으면(popout.js) 계속 보이므로 붙잡지 않는다.
  const previewPopped = () => document.body.classList.contains("preview-popped"),
    previewHeld = () => expanded && !previewPopped();
  const syncPauseButton = () => {
    const held = previewHeld(),
      button = $("studioPause"),
      playing = held ? resumeAfterMaximize : renderer.getStats().running;
    const label = held ? (resumeAfterMaximize ? "복귀 시 재생" : "복귀 시 정지") : playing ? "일시정지" : "재생";
    button.setAttribute("aria-pressed", String(!playing));
    button.setAttribute("aria-label", label);
    button.title = `${label} · 뷰포트에서는 Space`;
  };
  const maximize = () => {
    if (!expanded) {
      resumeAfterMaximize = renderer.getStats().running;
      if (resumeAfterMaximize && !previewPopped()) renderer.stop();
    } else if (resumeAfterMaximize && !previewPopped()) renderer.start();
    expanded = !expanded;
    $("stage").classList.toggle("studio-maximized", expanded);
    $("studioResize").hidden = expanded;
    $("studioMaximize").setAttribute("aria-pressed", String(expanded));
    if (!expanded) splitMode = false;
    syncPauseButton();
    syncSplit();
  };
  const syncSplit = () =>
    $("studioSplitEdit")?.setAttribute("aria-pressed", String(splitMode && expanded && previewPopped()));
  // 미리보기 분리 + 편집기 확대(P · 편집기 안에서 Ctrl+K P): 미리보기를 별도 창(popout.js)으로 빼고 편집기를 집중 모드로 키운다.
  // 둘 다 켜져 있으면 원래대로 되돌린다. 분리 창을 닫으면(Esc · 창 닫기) 집중 모드도 함께 끝낸다.
  // 분리 창은 사용자 입력(키·클릭) 안에서 열어야 하므로 popout.open()을 먼저 부른다.
  const splitEdit = async () => {
    const popout = window.shaderPopout;
    if (disposed || !popout) return false;
    if (expanded && previewPopped()) {
      maximize(); // 미리보기가 분리된 채로 끝내므로 재생 상태는 그대로다
      popout.close();
      return false;
    }
    if (!openState) open();
    if (!previewPopped()) {
      try {
        await popout.open();
      } catch (error) {
        setStatus(`미리보기 분리 실패: ${error?.message || error}`, "is-error");
        return false;
      }
    }
    if (disposed || !previewPopped()) return false;
    if (!expanded) maximize();
    splitMode = true;
    syncSplit();
    window.focus();
    $("studioCode").focus({ preventScroll: true });
    setStatus("미리보기를 별도 창으로 분리하고 편집기를 확대했습니다 · 다시 P(Ctrl+K P)로 되돌리기");
    return true;
  };
  const close = () => {
    if (expanded) maximize();
    openState = false;
    $("studioDock").hidden = true;
    $("studioResize").hidden = true;
    $("stage").classList.remove("studio-maximized");
    $("studioToggle").setAttribute("aria-label", "셰이더 편집기 열기");
    $("studioToggle").setAttribute("aria-expanded", "false");
    $("studioToggle").focus();
    workspace.saveWorkspace();
  };
  const toggle = () => (openState ? close() : open());
  const download = (name, text, type, limit = Infinity) => {
    const blob = new Blob([text], { type });
    if (blob.size > limit) throw new Error(`내보내기 파일은 최대 ${limit / 1048576}MiB입니다.`);
    const url = URL.createObjectURL(blob),
      link = element("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    $("studioExportState").textContent = `최근 내보내기 요청 · ${name}`;
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  };
  const exportJSON = () => {
    try {
      rememberEditor();
      download(
        "shader-studio-project.json",
        JSON.stringify({ version: 1, project }, null, 2),
        "application/json",
        JSON_LIMIT
      );
      setStatus("소스 JSON 내보냄 · 파라미터·이미지 원본은 포함되지 않습니다.");
    } catch (error) {
      showError(error);
    }
  };
  // Pack은 연결된 이미지의 원본과 샘플링 설정까지 포함한다. 기존 JSON은 경량 형식으로 유지한다. 파일 형식 규칙은 studio-pack.js.
  const runFile = async (button, message, action) => {
    if (button.disabled) return;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = message;
    button.setAttribute("aria-busy", "true");
    try {
      await action();
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
      button.textContent = label;
      button.removeAttribute("aria-busy");
    }
  };
  // 지금 작업을 Pack 텍스트로 만든다. 파일 내보내기와 프로젝트 보관함이 같이 쓴다. 도중에 Studio가 닫히면 null.
  // 담을 내용과 그 지문은 같은 순간(스냅샷)에서 만든다. 이미지를 읽는 동안 코드를 고쳐도 Pack에는 시작 시점의 내용이 들어가고,
  // 돌려주는 fingerprint도 그 시점 것이라 저장 뒤의 수정은 계속 '저장 안 됨'으로 보인다. epoch: 시작할 때의 작업 번호.
  const buildPack = async () => {
    const snap = projectSnapshot(),
      print = printOf(snap),
      work = workPrintOf(snap),
      epoch = workEpoch,
      textures = [];
    const files = Pack.collectTextures(snap.scene, renderer.getTextures(), id => renderer.getTextureFile(id));
    for (const { id, file } of files) {
      const meta = snap.textures.find(item => item.id === id);
      textures.push({ id, name: meta.name, type: file.type, data: await Pack.readData(file), sampling: meta.sampling });
    }
    if (disposed) return null;
    const text = Pack.encode({ project: snap.scene, selected: snap.selected, textures, settings: snap.state });
    if (text.length > PACK_LIMIT) throw new Error("프로젝트가 너무 큽니다(최대 64MiB). 연결된 이미지를 줄이세요.");
    return { text, passes: snap.scene.passes.length, images: textures.length, fingerprint: print, work, epoch };
  };
  const exportPack = async () => {
    const pack = await buildPack();
    if (!pack) return;
    download("shader-studio-pack.json", pack.text, "application/json", PACK_LIMIT);
    setStatus(`Pack 내보냄 · 코드·파라미터·설정·이미지 ${pack.images}개 포함`);
  };
  let loadSerial = 0;
  const beginLoad = (full = false) => {
    const serial = ++loadSerial,
      draft = copy(project),
      tab = selected,
      gpu = full ? snapshot() : null,
      state = full ? settings?.snapshot() : null;
    return () => {
      if (
        disposed ||
        serial !== loadSerial ||
        tab !== selected ||
        !same(project, draft) ||
        (full && (!same(snapshot(), gpu) || !same(settings?.snapshot(), state)))
      )
        throw new Error("작업이 변경되었거나 종료되어 파일 불러오기를 취소했습니다.");
    };
  };
  const importPack = file =>
    loadPackText(() => {
      if (file.size > PACK_LIMIT) throw new Error("Pack 파일은 최대 64MiB입니다.");
      return file.text();
    });
  // 이미 등록된 이미지와 바이트·형식·샘플링이 모두 같으면 그 ID를 돌려준다(보관함 프로젝트를 여러 번 열어도 이미지가 쌓이지 않게).
  const sameTexture = async asset => {
    const wanted = { filter: "linear", wrapS: "clamp", wrapT: "clamp", ...(asset.sampling || {}) };
    const bytes = new Uint8Array(await asset.file.arrayBuffer());
    for (const meta of renderer.getTextures()) {
      const file = renderer.getTextureFile(meta.id);
      if (!file || file.size !== asset.file.size || file.type !== asset.file.type) continue;
      if (["filter", "wrapS", "wrapT"].some(key => meta.sampling?.[key] !== wanted[key])) continue;
      const other = new Uint8Array(await file.arrayBuffer());
      if (other.every((value, index) => value === bytes[index])) return meta.id;
    }
    return null;
  };
  // loadText(): Pack 텍스트(또는 그 Promise). reuse: 같은 이미지는 새로 등록하지 않고 다시 쓴다.
  const loadPackText = async (loadText, { reuse = false } = {}) => {
    const check = beginLoad(true);
    const text = await loadText();
    check();
    const { data, project: next } = Pack.parse(text);
    const state = data.version === 3 ? settings?.validatePack(data.settings) : null;
    if (data.version === 3 && !state) throw new Error("설정 복원 API를 사용할 수 없습니다.");
    const { ids, decoded } = Pack.decodeTextures(data.textures);
    Pack.checkReferences(next, ids);
    // Pack의 이미지 ID는 등록 전에는 존재하지 않으므로 사전 검사에서만 이미지 참조를 제외한다.
    if (state) renderer.validatePortable(Pack.withoutTextures(next), state.user);
    else {
      renderer.validateFragment(next.image);
      for (const pass of next.passes) renderer.validateFragment(pass.fragment, true);
    }
    if (!(await confirmReplace())) return false;
    check();
    const added = [],
      map = new Map(),
      draftBefore = copy(project),
      wasDirty = dirty;
    let unsaved = 0,
      applied = false,
      previous = snapshot(),
      before = settings?.snapshot(),
      beforeTab = selected;
    try {
      // 같은 이미지를 다시 쓰려면 뒤에서 복원 중인 이미지까지 다 올라와 있어야 한다.
      if (reuse) await renderer.texturesRestored?.();
      check();
      for (const asset of decoded) {
        const existing = reuse ? await sameTexture(asset) : null;
        check();
        if (existing) {
          map.set(asset.id, existing);
          continue;
        }
        const result = await renderer.addTexture(asset.file, asset.sampling || {});
        added.push(result.id);
        check();
        map.set(asset.id, result.id);
        if (!result.saved) unsaved++;
      }
      Pack.remapTextures(next, map);
      if (state) {
        checkpoint = historyState();
        renderer.applyPortable(next, state.user);
        applied = true;
        settings.applyPack(state);
      } else if (!setProject(next)) throw new Error("Pack 셰이더를 적용하지 못했습니다.");
      adoptProject(next, data.selected);
      renderTextures();
      projects?.markClean();
      setStatus(`Pack 복원 완료 · 이미지 ${added.length}개${unsaved ? " · 일부 이미지 로컬 저장 불가" : ""}`);
      return true;
    } catch (error) {
      if (applied) {
        try {
          renderer.applyPortable(previous, before.user);
          settings.applyPack(before);
          project = draftBefore;
          dirty = wasDirty;
          selected = beforeTab;
          renderEditor();
          if (dirty) scheduleDraft();
        } catch (rollback) {
          console.error("Pack 복원 실패 후 롤백 오류:", rollback);
        }
      }
      for (const id of added.reverse())
        try {
          await renderer.removeTexture(id);
        } catch (cleanup) {
          console.warn("Pack 임시 이미지 정리 실패:", cleanup);
        }
      if (!disposed) {
        renderTextures();
        renderChannels();
      }
      throw error;
    }
  };
  // 프로젝트 JSON은 이미지 파일 본문을 담지 않으므로 존재하지 않는 연결은 제거한다.
  const detachMissing = next => Model.detachMissing(next, new Set(renderer.getTextures().map(asset => asset.id)));
  // 성공적으로 컴파일된 프로젝트를 자동 복원하고, 실패한 저장값은 실행하지 않는다.
  const restore = () => {
    try {
      const raw = Store.readTab(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.version !== 1) throw new Error("저장된 프로젝트 버전이 다릅니다.");
      const next = validateProject(data.project),
        before = copy(project);
      const detached = detachMissing(next);
      project = next;
      selected = "Image";
      renderEditor();
      if (!apply()) {
        project = before;
        selected = "Image";
        renderEditor();
        setStatus("저장 프로젝트 실행 실패 · 기본 장면 유지", "is-error");
      } else {
        selected = data.selected === "Image" || find(data.selected) ? data.selected : "Image";
        renderEditor();
        preview(true); // 새 프로젝트: 고정과 상관없이 고른 탭을 보여 준다
        if (detached) setStatus(`${detached}개 이미지 연결이 해제됐습니다. 파일을 다시 불러오세요.`, "is-dirty");
      }
    } catch (error) {
      showError(error);
    }
  };
  const loadDraft = raw => {
    try {
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.version !== 1) return;
      validateProject(data.project);
      if (same(data.project, project)) return;
      $("studioDraft").hidden = false;
      // 초기화 과정에서 apply()가 draft 키를 지웠더라도 선택 전까지 복구 가능해야 한다.
      Store.writeTab(DRAFT_KEY, raw);
      on($("studioDraftRestore"), "click", () => {
        project = copy(data.project);
        selected = data.selected === "Image" || find(data.selected) ? data.selected : "Image";
        renderEditor();
        recordEdit();
        dirty = true;
        $("studioDraft").hidden = true;
        scheduleDraft();
        setStatus("미적용 편집본 복원됨 · 실행(Alt+Enter)으로 컴파일", "is-dirty");
      });
      on($("studioDraftDiscard"), "click", clearDraft);
    } catch (error) {
      console.warn("임시 저장본 검증 실패:", error);
    }
  };
  renderTextures();
  // 앱이 뜬 뒤 이어서 복원되는 이미지(main.js의 restoreTextures)가 올라올 때마다 목록과 채널 표시를 맞춘다.
  on(document, "shader-textures-restored", () => {
    if (disposed) return;
    renderTextures();
    renderChannels();
    renderGraph();
  });
  const savedDraft = Store.readTab(DRAFT_KEY);
  const loadImage = async (file, slot) => {
    const check = beginLoad(),
      result = await renderer.addTexture(file);
    if (disposed) return;
    renderTextures();
    try {
      check();
    } catch (error) {
      setStatus(`${file.name} 추가됨 · 작업 변경으로 자동 채널 연결을 취소했습니다.`);
      return;
    }
    const connected = connectTexture(result.id, slot);
    renderChannels();
    if (connected && !result.saved) setStatus(`${$("studioMessage").textContent} · 로컬 저장 불가`);
    else if (!result.saved) setStatus(`이미지 추가됨 · 로컬 저장 불가: ${result.error}`);
  };
  const loadGLSL = async file => {
    if (!/\.(frag|glsl|fs)$/i.test(file.name) || file.size > 1048576)
      throw new Error("1MiB 이하의 .frag/.glsl/.fs 파일만 지원합니다.");
    const check = beginLoad();
    if (!(await confirmCodeReplace())) return;
    check();
    const code = (await file.text()).replace(/^\uFEFF/, "");
    check();
    if (code.length > 262144 || !code.startsWith("#version 300 es"))
      throw new Error("262144자 이하의 GLSL ES 3.00 소스가 필요합니다.");
    $("studioCode").value = code;
    editor.update();
    rememberEditor();
    schedule();
    open();
    setStatus(`${file.name} 불러옴 · 실행(Alt+Enter)으로 적용`, "is-dirty");
  };
  const saveGLSL = () => download(`${selected}.frag`, $("studioCode").value, "text/plain;charset=utf-8");
  const insertSample = text => {
    const area = $("studioCode");
    area.focus();
    area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  };
  on($("studioOpenGLSL"), "click", () => $("studioGLSLFile").click());
  on($("studioSaveGLSL"), "click", () => {
    try {
      saveGLSL();
      setStatus(`${selected}.frag 내보냄 · 현재 패스 코드만 포함`);
    } catch (error) {
      showError(error);
    }
  });
  on($("studioGLSLFile"), "change", async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await runFile($("studioOpenGLSL"), "GLSL 읽는 중…", () => loadGLSL(file));
  });
  on($("studioSampleUV"), "click", () => insertSample("texture(iChannel0, gl_FragCoord.xy / uResolution)"));
  on($("studioSamplePixel"), "click", () => insertSample("texelFetch(iChannel0, ivec2(gl_FragCoord.xy), 0)"));
  // 로컬 파일만 가로채며, 코드 선택 영역의 일반적인 드래그는 유지한다.
  on($("studioDock"), "dragover", event => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  on($("studioDock"), "drop", async event => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    try {
      if (file.type.startsWith("image/")) await loadImage(file);
      else await loadGLSL(file);
    } catch (error) {
      showError(error);
    }
  });
  // 이미지 파일 고르기. slot을 주면(채널 선택 목록의 "이미지 불러오기…") 그 채널에, 없으면 첫 빈 채널에 연결한다.
  let imageSlot;
  const pickImage = slot => {
    imageSlot = slot;
    $("studioTextureFile").click();
  };
  on($("studioTextureAdd"), "click", () => pickImage());
  on($("studioTextureFile"), "change", async event => {
    const file = event.target.files?.[0],
      slot = imageSlot;
    imageSlot = undefined;
    event.target.value = "";
    if (!file) return;
    await runFile($("studioTextureAdd"), "이미지 읽는 중…", () => loadImage(file, slot));
  });
  on($("studioCode"), "input", event => {
    rememberEditor();
    channelPicker.syncUsage($("studioCode").value);
    syncInputsWarning();
    schedule(
      (event.inputType === "insertText" && event.data?.length === 1) ||
        /^(deleteContent|insertCompositionText|insertReplacementText|insertLineBreak)/.test(event.inputType || "")
    );
  });
  // 이전·다음 패스 단축키: Alt+PageUp/PageDown, 또는 Alt+, / Alt+. (PageUp/PageDown 키가 없는 노트북·
  // 오른쪽 Alt가 한/영 키인 한국어 키보드용). 키 이름 대신 물리 키(code)로도 보아 배열·Mac Option 문자와 상관없게 한다.
  const passStep = event => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return 0;
    if (event.key === "PageDown" || event.code === "PageDown" || event.code === "Period") return 1;
    if (event.key === "PageUp" || event.code === "PageUp" || event.code === "Comma") return -1;
    return 0;
  };
  on($("studioCode"), "keydown", event => {
    if (event.isComposing) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")
    ) {
      event.preventDefault();
      historyMove(event.key.toLowerCase() === "z" && !event.shiftKey);
    } else if (passStep(event)) {
      event.preventDefault();
      const tabs = ["Image", ...project.passes.map(p => p.name)],
        index = tabs.indexOf(selected);
      select(tabs[(index + passStep(event) + tabs.length) % tabs.length]);
      $("studioCode").focus();
    } else if (event.key === "Enter" && !event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey) {
      // 실행: Alt+Enter. Ctrl+Enter는 편집기의 '아래에 줄 삽입'으로 남겨 둔다.
      event.preventDefault();
      rememberEditor();
      apply();
    } else if (
      event.key.toLowerCase() === "s" &&
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      saveShortcut();
    }
  });
  on($("studioRun"), "click", () => {
    rememberEditor();
    apply();
  });
  on($("studioChangeUndo"), "click", () => historyMove(true));
  on($("studioUndo"), "click", () => historyMove(true));
  on($("studioRedo"), "click", () => historyMove(false));
  on($("studioPassTabs"), "keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...$("studioPassTabs").querySelectorAll("button")],
      index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    select(next === 0 ? "Image" : project.passes[next - 1].name);
    $("studioPassTabs").children[next].focus();
  });
  on($("studioAdd"), "click", add);
  on($("studioDuplicate"), "click", duplicate);
  on($("studioRemove"), "click", remove);
  on($("studioUp"), "click", () => move(-1));
  on($("studioDown"), "click", () => move(1));
  // 기본값과 같은 선택 항목은 프로젝트에서 지워 기존 JSON 모양을 유지한다.
  const setPassOption = (key, value, fallback) => {
    const p = find(selected);
    if (!p) return;
    if (value === fallback) delete p[key];
    else p[key] = value;
  };
  on($("studioFormat"), "change", event => {
    const p = find(selected);
    p.format = event.target.value;
    if (p.filter === (p.format === "rgba32f" ? "nearest" : "linear")) delete p.filter;
    schedule();
    apply();
  });
  on($("studioScale"), "change", event => {
    const p = find(selected),
      value = event.target.value,
      size = /^size:(\d+)x(\d+)$/.exec(value);
    if (size) {
      p.size = [Number(size[1]), Number(size[2])];
      p.scale = 1;
    } else {
      delete p.size;
      p.scale = Number(value);
    }
    schedule();
    apply();
  });
  on($("studioOutputs"), "change", event => {
    const p = find(selected),
      outputs = Number(event.target.value);
    setPassOption("outputs", outputs, 1);
    // 줄어든 출력을 읽던 채널 연결은 0번 출력으로 되돌린다.
    const fixed = [];
    for (const entry of [...project.passes, { name: "Image", channels: project.imageChannels }])
      for (const [key, ref] of Object.entries(entry.channels))
        if (ref.buffer === p.name && ref.attachment >= outputs) {
          delete ref.attachment;
          fixed.push(`${entry.name}.iChannel${key}`);
        }
    renderChannels();
    renderGraph();
    schedule();
    apply();
    if (fixed.length) showChange(`출력 수 변경 · 0번 출력으로 되돌린 연결: ${fixed.join(", ")}`);
  });
  on($("studioFilter"), "change", event => {
    const p = find(selected);
    setPassOption("filter", event.target.value, p.format === "rgba32f" ? "nearest" : "linear");
    schedule();
    apply();
  });
  on($("studioWrap"), "change", event => {
    setPassOption("wrap", event.target.value, "clamp");
    schedule();
    apply();
  });
  on($("studioMip"), "change", event => {
    setPassOption("mipmap", event.target.checked, false);
    schedule();
    apply();
  });
  on($("studioLive"), "change", () => {
    if (!$("studioLive").checked && timer) {
      clearTimeout(timer);
      timer = null;
    } else if (dirty) schedule();
  });
  // 새 프로젝트: 잃을 것이 있으면 '저장하지 않은 변경' 확인 하나로 묻고, 없으면 새로 시작할지만 묻는다(확인 창을 두 번 띄우지 않는다).
  on($("studioReset"), "click", () =>
    proceed(
      dirty || projects?.modified()
        ? confirmReplace()
        : ask({
            title: "새 프로젝트",
            message:
              "모든 편집 패스와 Custom Uniform을 지우고 기본 셰이더 아트 장면으로 새로 시작할까요? Undo로 되돌릴 수 있습니다.",
            ok: "새로 시작",
            danger: true,
          }),
      () => replaceProject({ image: original, passes: [], imageChannels: {} })
    )
  );
  on($("studioExport"), "click", exportJSON);
  on($("studioImport"), "click", () => $("studioImportFile").click());
  on($("studioImportFile"), "change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > JSON_LIMIT) throw new Error("JSON 파일은 16MiB 이하여야 합니다.");
      const check = beginLoad(),
        text = await file.text();
      check();
      const data = JSON.parse(text);
      if (data.version !== 1) throw new Error("지원하지 않는 프로젝트 형식입니다.");
      if (await confirmReplace()) {
        await renderer.texturesRestored?.();
        check();
        const next = validateProject(data.project),
          count = detachMissing(next);
        const ok = setProject(next);
        if (ok) {
          projects?.forget();
          projects?.markClean();
          revealCode();
        }
        if (ok && count) setStatus(`${count}개 이미지 연결이 해제됐습니다. 원본 이미지를 다시 가져오세요.`, "is-dirty");
      }
    } catch (error) {
      showError(error);
    } finally {
      event.target.value = "";
    }
  });
  on($("studioExportPack"), "click", event => runFile(event.currentTarget, "Pack 준비 중…", exportPack));
  on($("studioImportPack"), "click", () => $("studioPackFile").click());
  on($("studioPackFile"), "change", async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await runFile($("studioImportPack"), "Pack 읽는 중…", () => importPack(file));
  });
  on($("studioErrorToggle"), "click", () => {
    $("studioError").hidden = !$("studioError").hidden;
  });
  on($("studioToggle"), "click", toggle);
  on($("studioHide"), "click", close);
  on($("studioOpenFromPanel"), "click", open);
  on($("studioMaximize"), "click", maximize);
  on($("studioSplitEdit"), "click", () => {
    $("studioCodeTools").open = false;
    splitEdit();
  });
  on($("studioPause"), "click", () => togglePlayback());
  on($("studioResetFrames"), "click", () => {
    renderer.resetSimulation();
    setStatus("버퍼와 시뮬레이션 시간이 초기화됐습니다.");
  });
  const getPlaybackState = () => (previewHeld() ? resumeAfterMaximize : renderer.getStats().running);
  const togglePlayback = () => {
    if (previewHeld()) resumeAfterMaximize = !resumeAfterMaximize;
    else if (renderer.getStats().running) renderer.stop();
    else renderer.start();
    syncPauseButton();
    return getPlaybackState();
  };
  // 집중 모드 중에 미리보기를 빼거나 되돌리면 붙잡기 상태를 넘겨준다: 빼면 붙잡아 둔 재생을 풀고, 되돌리면 다시 붙잡는다.
  on(document, "preview-popout-changed", event => {
    if (expanded) {
      if (event.detail?.open) {
        if (resumeAfterMaximize) renderer.start();
      } else {
        resumeAfterMaximize = renderer.getStats().running;
        if (resumeAfterMaximize) renderer.stop();
        // 분리 편집 중에 분리 창을 닫으면 집중 모드도 끝낸다(붙잡은 재생 상태는 maximize가 되돌린다).
        if (splitMode) maximize();
      }
    }
    syncPauseButton();
    syncSplit();
  });
  // 편집기 메뉴(⋯): 항목을 고르거나, 바깥을 누르거나, Esc를 누르면 닫는다. 글자 크기·들여쓰기 같은 값 조절은 열어 둔다.
  const menu = $("studioCodeTools");
  on(menu, "click", event => {
    if (event.target?.closest?.(".studio-menu-panel>button")) menu.open = false;
  });
  on(document, "pointerdown", event => {
    if (menu.open && !menu.contains?.(event.target)) menu.open = false;
  });
  // 편집기를 아래에 작게 배치하면 메뉴가 #stage(overflow:hidden) 밖으로 나가 잘린다.
  // 열 때 아래·위 여유 공간을 재서 더 넓은 쪽으로 펼치고, 그 공간에 맞게 높이를 제한한다(넘치면 메뉴 안에서 스크롤).
  const placeMenu = () => {
    const panel = menu.querySelector?.(".studio-menu-panel"),
      summary = menu.querySelector?.("summary");
    if (!menu.open || !panel?.style || !summary?.getBoundingClientRect) return;
    panel.classList.remove("is-up");
    panel.style.maxHeight = "";
    const clip = $("stage")?.getBoundingClientRect?.(),
      view = window.innerHeight || document.documentElement?.clientHeight || 0,
      gap = 6,
      margin = 8;
    const limitTop = Math.max(0, clip?.top ?? 0) + margin,
      limitBottom = Math.min(view, clip?.bottom ?? view) - margin,
      anchor = summary.getBoundingClientRect();
    const below = limitBottom - (anchor.bottom + gap),
      above = anchor.top - gap - limitTop,
      natural = panel.scrollHeight || 0;
    const up = below < natural && above > below;
    panel.classList.toggle("is-up", up);
    panel.style.maxHeight = `${Math.max(120, Math.floor(Math.min(540, up ? above : below)))}px`;
  };
  on(menu, "toggle", placeMenu);
  on(window, "resize", placeMenu);
  on(menu, "keydown", event => {
    if (event.key === "Escape" && menu.open) {
      event.preventDefault();
      event.stopPropagation();
      menu.open = false;
      menu.querySelector?.("summary")?.focus();
    }
  });
  // 저장 단축키. 기본은 Ctrl+S = 프로젝트 저장(이름 없는 작업은 이름을 묻는다), 실행은 Alt+Enter.
  // 예전처럼 Ctrl+S로 실행하고 싶으면 편집기 메뉴(⋯)의 'Ctrl+S로 실행'을 켠다(이 브라우저에 기억).
  const CTRL_S_KEY = "field.ctrlSRuns.v1";
  const ctrlSRuns = () => Store.read(CTRL_S_KEY) === "1";
  const syncCtrlS = () => {
    const runs = ctrlSRuns(),
      toggle = $("studioCtrlSRuns");
    if (toggle) toggle.setAttribute("aria-pressed", String(runs));
    $("studioRun").title = `현재 GLSL/채널 설정을 적용 (${runs ? "Ctrl+S · " : ""}Alt+Enter)`;
    const hint = $("studioRun").querySelector("span");
    if (hint) hint.textContent = runs ? "Ctrl+S" : "Alt+↵";
  };
  const setCtrlSRuns = runs => {
    Store.write(CTRL_S_KEY, runs ? "1" : "0");
    syncCtrlS();
    setStatus(
      runs ? "Ctrl+S = 실행(이전 방식) · 프로젝트 저장은 프로젝트 메뉴" : "Ctrl+S = 프로젝트 저장 · 실행은 Alt+Enter"
    );
  };
  const saveProject = () => {
    const button = $("studioProjectSave");
    if (!button.disabled) button.click();
  };
  const saveShortcut = () => {
    if (ctrlSRuns()) {
      rememberEditor();
      apply();
    } else saveProject();
  };
  if ($("studioCtrlSRuns")) on($("studioCtrlSRuns"), "click", () => setCtrlSRuns(!ctrlSRuns()));
  syncCtrlS();
  // 앱 어디서나 쓰는 단축키. 편집기 안에서 CodeMirror가 먼저 처리한 키(defaultPrevented)는 건드리지 않는다.
  //   Ctrl+S 프로젝트 저장 · Ctrl+Shift+S 다른 이름으로 저장 · Ctrl+O 프로젝트 메뉴 · Ctrl+Shift+P / F1 명령 팔레트(편집기가 닫혀 있으면 연다)
  on(document, "keydown", event => {
    if (event.defaultPrevented || event.isComposing || event.altKey) return;
    if (document.querySelector?.("dialog[open]")) return;
    const mod = event.ctrlKey || event.metaKey,
      key = event.key.toLowerCase();
    if (mod && !event.shiftKey && key === "s") {
      event.preventDefault();
      saveShortcut();
    } else if (mod && event.shiftKey && key === "s") {
      event.preventDefault();
      const target = $("studioProjectSaveAs").hidden ? $("studioProjectSave") : $("studioProjectSaveAs");
      if (!target.disabled) target.click();
    } else if (mod && !event.shiftKey && key === "o") {
      event.preventDefault();
      projectMenu.isOpen() ? projectMenu.close({ refocus: true }) : projectMenu.open();
    } else if ((mod && event.shiftKey && key === "p") || (!mod && !event.shiftKey && event.key === "F1")) {
      event.preventDefault();
      projectMenu.close();
      if (!openState) open();
      editor.openPalette(">");
    }
  });
  on(document, "keydown", event => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) return;
    if (event.key.toLowerCase() === "e") {
      event.preventDefault();
      toggle();
    } else if (event.key.toLowerCase() === "p" && !event.shiftKey) {
      event.preventDefault();
      splitEdit();
    }
  });
  on(document, "fullscreenchange", () => {
    // 전체화면은 렌더링만 보여 주므로 편집기를 닫고, 전체화면을 마치면 열려 있던 편집기(집중 모드 포함)를 되돌린다.
    if (document.fullscreenElement) {
      if (openState) {
        afterFullscreen = { expanded };
        close();
      }
    } else if (afterFullscreen) {
      const state = afterFullscreen;
      afterFullscreen = null;
      if (!openState) {
        open();
        if (state.expanded && !expanded) maximize();
      }
    }
  });
  let afterFullscreen = null;
  // 화면 배치·리사이저·편집기 메뉴(studio-layout.js). 편집기 열림 상태는 전체화면 중이면 전체화면 전 상태를 남긴다.
  const workspace = Layout.create({
    $,
    on,
    editor,
    editorOpen: () => (afterFullscreen ? true : openState),
    onCollapse: () => close(),
  });
  projects = Projects.create({
    onCurrent: current => {
      titleName = current ? current.name : "저장 안 한 작업";
      projectMenu.setLabel(titleName, !!current);
      syncTitle();
    },
    fingerprint,
    workPrint,
    epoch: () => workEpoch,
    $,
    on,
    element,
    ask,
    store: ProjectStore.create(),
    buildPack,
    openPack: loadText => loadPackText(loadText, { reuse: true }),
    setStatus,
    showError,
  });
  isModified = () => projects.modified();
  renderEditor();
  restore();
  // 파라미터·설정·이미지 샘플링은 여러 곳에서 바뀌므로 저장 후 변경 여부(●)는 1초마다 확인한다.
  const titleTimer = setInterval(syncTitle, 1000);
  // 이름 없는 작업의 기준점: 지난번에 기억해 둔 것이 없으면 지금(복원 직후)을 '바뀌지 않은 작업'으로 삼는다.
  projects.markClean({ ifUnknown: true });
  loadDraft(savedDraft);
  undoStack.length = redoStack.length = 0;
  checkpoint = historyState();
  syncHistory();
  workspace.ready();
  if (workspace.reopenEditor) open();
  const removeAllPasses = () =>
    proceed(confirmReplace(), () => setProject({ image: renderer.getFragmentSource(), passes: [], imageChannels: {} }));
  // 갤러리 등 외부 예제: 미적용 변경 확인 → 코드·버퍼·파라미터 일괄 교체(Undo 가능).
  const loadExample = (next, users = []) => startProject(next, users);
  // 가이드 코드 예시 삽입. replace=true면 현재 패스 전체를 교체한다(Undo로 복원 가능).
  // 커서가 #version/precision 줄보다 앞에 있으면 컴파일이 깨지므로 precision 줄 다음으로 옮겨 넣는다(code-insert.js).
  const insertSnippet = (text, replace = false) => {
    if (disposed || typeof text !== "string") return false;
    open();
    const area = $("studioCode");
    area.focus({ preventScroll: true });
    const edit = replace
      ? { from: 0, to: area.value.length, text }
      : Insert.snippetEdit(area.value, area.selectionStart, area.selectionEnd, text);
    area.setRangeText(edit.text, edit.from, edit.to, "end");
    area.dispatchEvent(new Event("input", { bubbles: true }));
    setStatus(
      replace ? "가이드 코드로 교체됨 · Ctrl+Z로 되돌리기" : "가이드 코드 삽입됨 · 필요하면 위치를 조정하세요",
      "is-dirty"
    );
    return true;
  };
  // 코드 조각 라이브러리 삽입: global(함수 정의)은 전역 위치에, main(문장)은 함수 안에 넣는다. 위치 계산 규칙은 code-insert.js의 codeEdit.
  // 한 번의 input 이벤트로 반영하므로 Undo 한 번에 되돌아간다.
  const insertCode = ({ global = "", main = "", replace = "", note = "" } = {}) => {
    if (disposed) return false;
    open();
    const area = $("studioCode");
    area.focus({ preventScroll: true });
    const done = () => {
      if (note) setStatus(note, "is-dirty");
      return true;
    };
    if (replace) {
      area.setRangeText(replace, 0, area.value.length, "end");
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return done();
    }
    const { src, caret } = Insert.codeEdit(area.value, area.selectionStart, { global, main });
    area.value = src;
    area.setSelectionRange(caret, caret);
    area.dispatchEvent(new Event("input", { bubbles: true }));
    return done();
  };
  // 명령 팔레트(Ctrl+Shift+P)에 편집기 바깥 기능도 등록한다. 대부분 기존 버튼을 누르는 것과 같다.
  // bind: 편집기 안에서 이 명령을 실행할 VS Code식 키(CodeMirror 키 이름). key는 팔레트에 보이는 표기.
  const press = (label, id, key, bind) => ({
    label,
    key,
    bind,
    run: () => {
      const button = $(id);
      if (button && !button.disabled) button.click();
    },
  });
  const stepPass = step => {
    const tabs = [...$("studioPassTabs").children],
      at = tabs.findIndex(tab => tab.classList.contains("is-active"));
    tabs[(at + step + tabs.length) % tabs.length]?.click();
  };
  // 편집기가 열려 있으면 포커스가 코드 밖(패스 탭·편집기 도구·뷰포트 등)에 있어도 패스를 옮긴다.
  // 코드 편집기 안의 키는 위의 studioCode 처리가 먼저 받는다(defaultPrevented). 다른 입력 칸에서는 건드리지 않는다.
  on(document, "keydown", event => {
    if (event.defaultPrevented || !openState) return;
    const step = passStep(event);
    if (!step) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    stepPass(step);
  });
  on($("studioPreviewTarget"), "click", togglePreview);
  on($("studioPreviewPin"), "click", () => setPreviewPinned(!previewPinned));
  on($("studioInputsToggle"), "click", () => {
    showInputs(!inputsOpen);
    syncInputsWarning();
    if (inputsOpen) $("studioChannels").querySelector("button")?.focus();
  });
  on($("studioInputsCollapse"), "click", () => {
    showInputs(false);
    syncInputsWarning();
    $("studioInputsToggle").focus();
  });
  // 툴바 "최종 Image 보기"·버퍼 뷰어로 미리보기를 바꿔도 버튼 상태를 맞춘다.
  on(document, "shader-preview-changed", syncPreviewControls);
  syncPreviewControls();
  editor.registerCommands?.([
    press("셰이더 실행 (적용)", "studioRun", "Alt+Enter"),
    { label: "프로젝트 저장", key: "Ctrl+S", run: () => saveProject() },
    {
      label: "Ctrl+S로 실행 (이전 방식) 켜기/끄기",
      run: () => setCtrlSRuns(!ctrlSRuns()),
    },
    press("되돌리기", "studioUndo", "Ctrl+Z"),
    press("다시 실행", "studioRedo", "Ctrl+Y"),
    { label: "자동 적용 켜기/끄기", run: () => $("studioLive").click() },
    { label: "미리보기: Image ↔ 편집 중인 패스", run: togglePreview },
    { label: "미리보기 고정 켜기/끄기", run: () => setPreviewPinned(!previewPinned) },
    press("버퍼 패스 추가", "studioAdd"),
    { label: "다음 패스로", key: "Alt+PageDown · Alt+.", run: () => stepPass(1) },
    { label: "이전 패스로", key: "Alt+PageUp · Alt+,", run: () => stepPass(-1) },
    press("재생 / 일시정지", "studioPause"),
    press("시간·프레임 초기화", "studioResetFrames"),
    press("프로젝트 메뉴 열기", "projectMenuToggle", "Ctrl+O"),
    press("집중 모드 전환", "studioMaximize", "Ctrl+K Z", ["Mod-k z", "Mod-k Z"]),
    {
      label: "미리보기 분리 + 편집기 확대 (전환)",
      key: "Ctrl+K P · 편집기 밖에서는 P",
      bind: ["Mod-k p", "Mod-k P"],
      run: () => splitEdit(),
    },
    press("편집기 배치 바꾸기 (옆 ↔ 위아래)", "studioLayout", "Ctrl+\\", "Mod-\\"),
    press("편집기 닫기", "studioHide", "E"),
    press("코드 조각 모음 열기", "studioSnippets"),
    press("파라미터 패널 열기", "studioParameters"),
    press("도움말 · 단축키", "studioHelp", "?"),
    press(".frag 파일로 저장", "studioSaveGLSL"),
    press(".frag 파일 열기", "studioOpenGLSL"),
    press("다른 이름으로 프로젝트 저장", "studioProjectSaveAs", "Ctrl+Shift+S"),
    press("프로젝트 파일 내보내기 (코드·파라미터·이미지)", "studioExportPack"),
    press("프로젝트 파일 열기", "studioImportPack"),
    press("이미지 파일 불러오기", "studioTextureAdd"),
    press("새 프로젝트 (기본 장면)", "studioReset"),
  ]);
  // Ctrl+P: VS Code의 '파일로 이동' 자리에 패스(Image · Buffer A…) 목록을 둔다.
  editor.setFiles?.(() =>
    [...$("studioPassTabs").children].map((tab, index) => ({
      label: tab.textContent,
      hint: index ? "버퍼 패스" : "최종 출력",
      current: tab.classList.contains("is-active"),
      run: () => tab.click(),
    }))
  );
  return {
    open,
    close,
    toggle,
    splitEdit,
    apply,
    setProject,
    getPlaybackState,
    togglePlayback,
    loadFromRenderer,
    removeAllPasses,
    exampleRaymarch,
    examplePipeline,
    exampleFeedback,
    loadExample,
    insertSnippet,
    insertCode,
    getEditorSource: () => $("studioCode").value,
    undo: () => historyMove(true),
    redo: () => historyMove(false),
    getProject: () => copy(project),
    exportPack,
    importPack,
    // 브라우저 프로젝트 보관함: save(asNew) · list() · open(id) · rename(id) · remove(id) · current()
    projects: {
      save: asNew => projects.save(asNew),
      list: () => projects.list(),
      open: id => projects.open(id),
      rename: id => projects.rename(id),
      remove: id => projects.remove(id),
      current: () => projects.current(),
      ready: () => projects.ready,
    },
    dispose: () => {
      disposed = true;
      clearInterval(titleTimer);
      if (timer) clearTimeout(timer);
      if (draftTimer) clearTimeout(draftTimer);
      if (dirty) {
        rememberEditor();
        Store.writeTabJSON(DRAFT_KEY, { version: 1, project, selected });
      }
      dialogs.close();
      editor.dispose();
      workspace.dispose();
      controller.abort();
    },
  };
};
// 앱 시작 때 먼저 되살릴 이미지: 이 탭의 자동 복구본(실행본·편집본)이 연결한 이미지 id. 나머지 이미지는 뒤에서 이어서 되살린다.
const savedTextureIds = () => {
  const ids = new Set();
  for (const key of [STORAGE_KEY, DRAFT_KEY]) {
    const project = Store.readTabJSON(key)?.project;
    if (!project || typeof project !== "object") continue;
    try {
      for (const id of Pack.textureIds(project)) ids.add(id);
    } catch (_) {
      /* 모양이 깨진 복구본은 Studio가 따로 검사한다. */
    }
  }
  return [...ids];
};
export { mount, savedTextureIds };
