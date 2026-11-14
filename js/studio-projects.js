// 프로젝트 보관함 화면: 브라우저에 저장 · 다른 이름으로 저장 · 목록에서 열기 · 이름 바꾸기 · 삭제.
// 저장 내용은 Pack과 같다(코드·파라미터·설정·이미지 원본). 실제 Pack 만들기·복원은 studio.js가 넘겨 준 함수가 한다.
// "지금 작업 중인 프로젝트"를 기억해 두고, 저장하면 그 항목을 덮어쓴다. 예제·새 프로젝트·파일 열기로 바뀌면 잊는다.
//
// 저장 정확성 규칙
//   · 저장한 상태의 지문은 Pack을 만든 순간의 것(buildPack().fingerprint)을 쓴다. 저장하는 동안 고친 내용은 계속 '저장 안 됨'.
//   · 저장하는 동안 작업이 통째로 바뀌면(epoch가 다르면) 저장은 끝내되 지금 작업을 그 항목과 잇지 않는다.
//   · 보관함 항목의 revision을 기억해 두고 덮어쓸 때 비교한다. 다른 탭이 먼저 저장했으면 사본 저장·덮어쓰기·취소를 묻는다.
//   · 이름 없는 작업도 시작한 순간의 작업 지문(cleanWork)을 기억해 두고, 달라지면 '저장 안 됨'으로 본다.
//   · 다른 탭의 저장·이름 바꾸기·삭제는 BroadcastChannel로 알려 목록과 지금 작업 표시를 맞춘다.
// 지금 작업 정보는 탭마다 따로 기억한다(storage.js의 readTab/writeTab).
import * as Store from "./storage.js";

const CURRENT_KEY = "webgl.shader-studio.current-project.v1",
  CHANNEL = "field-studio-projects",
  REMOVED = "removed"; // 이름 없는 작업의 기준점으로, 어떤 지문과도 같지 않다(보관함에서 지운 프로젝트의 작업 = 저장 안 됨)

const sizeText = size =>
  !Number.isFinite(size) || size <= 0
    ? ""
    : size >= 1048576
      ? `${(size / 1048576).toFixed(1)}MB`
      : `${Math.max(1, Math.round(size / 1024))}KB`;
const when = time => {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// store: project-store.js의 create() 결과
// buildPack(): Promise<{text, passes, images} | null>
// openPack(loadText): Promise<boolean> — loadText()가 돌려준 Pack 텍스트로 현재 작업을 바꾼다(미적용 변경 확인 포함).
// onCurrent(current, busy): 지금 작업 이름이 바뀔 때마다(프로젝트 메뉴 버튼 표시용)
// fingerprint(): 지금 작업 상태의 지문. 저장·열기 직후 값을 기억해 두고(새로고침해도 유지) 달라지면 modified()가 true.
// workPrint(): 렌더링 설정을 뺀 작업 지문(이름 없는 작업용). epoch(): 작업이 통째로 바뀔 때마다 오르는 번호.
const create = ({
  $,
  on,
  element,
  ask,
  store,
  buildPack,
  openPack,
  setStatus,
  showError,
  onCurrent = () => {},
  fingerprint = () => "",
  workPrint = () => "",
  epoch = () => 0,
}) => {
  const stored = Store.readTabJSON(CURRENT_KEY, null);
  let current = stored,
    cleanWork = typeof stored?.work === "string" && !stored?.id ? stored.work : null,
    items = [],
    busy = false,
    opening = false,
    available = true;
  if (!current || typeof current.id !== "string" || typeof current.name !== "string") current = null;
  else if (!Number.isInteger(current.revision)) current.revision = null; // 예전 버전에서 저장: 비교 없이 덮어쓴다

  const remember = () => {
    if (current)
      Store.writeTabJSON(CURRENT_KEY, {
        id: current.id,
        name: current.name,
        fingerprint: current.fingerprint,
        revision: current.revision,
      });
    else if (cleanWork) Store.writeTabJSON(CURRENT_KEY, { id: null, work: cleanWork });
    else Store.removeTab(CURRENT_KEY);
  };
  // 다른 탭에 보관함 변경을 알린다. BroadcastChannel이 없는 브라우저는 목록을 열 때 다시 읽는 것으로 충분하다.
  const tabId = Math.random().toString(36).slice(2);
  let channel = null;
  try {
    channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
  } catch (_) {
    channel = null;
  }
  const announce = message => {
    try {
      channel?.postMessage({ ...message, tab: tabId });
    } catch (_) {
      /* 알리지 못해도 저장 자체는 끝났다. 다른 탭은 저장할 때 revision으로 충돌을 잡는다. */
    }
  };
  const syncCurrent = () => {
    const label = $("studioProjectCurrent");
    label.textContent = current ? `작업 중: ${current.name}` : "프로젝트로 저장하지 않은 작업";
    label.dataset.saved = String(!!current);
    $("studioProjectSave").textContent = current ? "저장" : "프로젝트 저장…";
    $("studioProjectSave").title = current
      ? `'${current.name}'에 덮어쓰기 (Ctrl+S) · 코드·파라미터·설정·이미지 포함`
      : "이 브라우저의 프로젝트 보관함에 이름을 붙여 저장 (Ctrl+S) · 코드·파라미터·설정·이미지 포함";
    $("studioProjectSaveAs").hidden = !current;
    for (const button of [$("studioProjectSave"), $("studioProjectSaveAs")]) button.disabled = busy || !available;
    onCurrent(current ? { ...current } : null, busy);
  };
  const setCurrent = record => {
    current = record
      ? { id: record.id, name: record.name, fingerprint: record.fingerprint, revision: record.revision ?? null }
      : null;
    remember();
    syncCurrent();
    render().catch(error => console.warn("프로젝트 목록 표시 실패:", error));
  };
  // 버튼을 누른 동안 다른 보관함 작업을 막는다(같은 항목을 두 번 쓰거나 지우지 않게).
  const exclusive = async work => {
    if (busy) return false;
    busy = true;
    syncCurrent();
    try {
      return await work();
    } catch (error) {
      showError(error);
      return false;
    } finally {
      busy = false;
      syncCurrent();
      await render().catch(error => console.warn("프로젝트 목록 표시 실패:", error));
    }
  };

  const row = item => {
    const box = element("div"),
      openButton = element("button"),
      title = element("strong"),
      meta = element("small"),
      renameButton = element("button"),
      deleteButton = element("button");
    const isCurrent = current?.id === item.id;
    box.className = "ui-card studio-project";
    box.dataset.current = String(isCurrent);
    box.setAttribute("role", "listitem");
    openButton.type = "button";
    openButton.className = "studio-project-open";
    title.textContent = item.name;
    meta.textContent = [
      when(item.updated),
      `버퍼 ${item.passes || 0}`,
      `이미지 ${item.images || 0}`,
      sizeText(item.size),
    ]
      .filter(Boolean)
      .join(" · ");
    openButton.append(title, meta);
    openButton.title = isCurrent
      ? `${item.name} · 지금 작업 중 · 다시 열면 저장한 상태로 돌아갑니다`
      : `${item.name} 열기`;
    if (isCurrent) openButton.setAttribute("aria-current", "true");
    on(openButton, "click", () => openItem(item));
    for (const [button, icon, label, action] of [
      [renameButton, "icon-edit", `${item.name} 이름 바꾸기`, () => renameItem(item)],
      [deleteButton, "icon-close", `${item.name} 삭제`, () => deleteItem(item)],
    ]) {
      button.type = "button";
      button.className = `ui-icon-btn ui-icon-btn--sm glyph-icon ${icon}`;
      button.title = label;
      button.setAttribute("aria-label", label);
      on(button, "click", action);
    }
    for (const button of [openButton, renameButton, deleteButton]) button.disabled = busy;
    box.append(openButton, renameButton, deleteButton);
    return box;
  };
  let renderSerial = 0;
  const render = async () => {
    const serial = ++renderSerial,
      holder = $("studioProjectList");
    try {
      items = await store.list();
      available = true;
    } catch (error) {
      items = [];
      available = false;
      // IndexedDB가 아예 없는 환경(일부 사생활 보호 창 등)은 안내 문구로 충분하다.
      if (globalThis.indexedDB) console.warn("프로젝트 보관함을 읽지 못했습니다:", error);
    }
    if (serial !== renderSerial) return;
    // 다른 탭에서 지운 프로젝트는 더 이상 덮어쓸 대상이 아니다. 지금 작업은 이름 없는 작업으로 남고, 저장한 적이 없으므로 '저장 안 됨'이다.
    if (available && current && !items.some(item => item.id === current.id)) {
      current = null;
      cleanWork = REMOVED;
      remember();
    }
    holder.replaceChildren();
    if (!items.length) {
      const hint = element("p");
      hint.className = "ui-hint";
      hint.textContent = available
        ? "저장한 프로젝트가 없습니다. 저장하면 여기에서 언제든 다시 열 수 있습니다."
        : "이 브라우저에서는 프로젝트 보관함을 쓸 수 없습니다. Pack 파일로 저장하세요.";
      holder.append(hint);
    }
    for (const item of items) holder.append(row(item));
    syncCurrent();
  };

  const askName = (title, value) =>
    ask({
      title,
      message: "이 브라우저의 프로젝트 보관함에 코드·파라미터·설정·이미지를 함께 저장합니다.",
      value,
      label: "프로젝트 이름",
      ok: "저장",
    });
  const suggestName = () => {
    const names = new Set(items.map(item => item.name));
    for (let i = items.length + 1; ; i++) if (!names.has(`프로젝트 ${i}`)) return `프로젝트 ${i}`;
  };
  // 보관함에 쓴 뒤 지금 작업과 잇는다. pack.epoch가 지금 작업 번호와 다르면(저장하는 동안 다른 작업을 열었다) 잇지 않는다.
  const adopt = (record, pack) => {
    announce({ type: "saved", id: record.id, name: record.name, revision: record.revision });
    if (pack.epoch !== undefined && pack.epoch !== epoch()) {
      setStatus(`프로젝트 '${record.name}' 저장됨 · 저장하는 동안 다른 작업으로 바뀌어 지금 작업과는 잇지 않았습니다`);
      return true;
    }
    current = {
      id: record.id,
      name: record.name,
      fingerprint: pack.fingerprint ?? fingerprint(),
      revision: record.revision,
    };
    cleanWork = null;
    remember();
    setStatus(
      pack.fingerprint && pack.fingerprint !== fingerprint()
        ? `프로젝트 '${record.name}' 저장됨 · 저장하는 동안 바꾼 내용은 아직 저장되지 않았습니다`
        : `프로젝트 '${record.name}' 저장됨 · 이 브라우저의 보관함`
    );
    return true;
  };
  // 덮어쓰기 충돌(다른 탭이 먼저 저장 · 지움)을 묻는다. 사본으로 저장 · 덮어쓰기 · 취소
  const resolveConflict = async (error, name, pack) => {
    if (error.code === "missing") {
      const ok = await ask({
        title: "보관함에서 사라진 프로젝트",
        message: `'${name}'은(는) 다른 탭(창)에서 지워졌습니다. 지금 작업을 새 항목으로 저장할까요?`,
        ok: "새 항목으로 저장",
      });
      if (!ok) return false;
      return adopt(await store.save({ name, text: pack.text, passes: pack.passes, images: pack.images }), pack);
    }
    const choice = await ask({
      title: "다른 탭에서 먼저 저장됨",
      message: `'${name}'을(를) 다른 탭(창)에서 ${when(error.record?.updated) || "방금"}에 저장했습니다. 덮어쓰면 그 내용이 사라집니다.`,
      ok: "사본으로 저장",
      alt: "덮어쓰기",
    });
    if (choice === "alt")
      return adopt(
        await store.save({ id: current.id, name, text: pack.text, passes: pack.passes, images: pack.images }),
        pack
      );
    if (choice === true)
      return adopt(
        await store.save({ name: `${name} 사본`, text: pack.text, passes: pack.passes, images: pack.images }),
        pack
      );
    return false;
  };
  // asNew: 지금 프로젝트가 있어도 새 항목으로 저장한다.
  const saveNow = async (asNew = false) => {
    const overwrite = current && !asNew;
    const name = overwrite
      ? current.name
      : await askName(
          asNew ? "다른 이름으로 저장" : "프로젝트 저장",
          asNew ? `${current?.name || suggestName()} 사본` : suggestName()
        );
    if (name === null || name === undefined) return false;
    const pack = await buildPack();
    if (!pack) return false;
    try {
      const record = await store.save({
        id: overwrite ? current.id : null,
        name,
        text: pack.text,
        passes: pack.passes,
        images: pack.images,
        expectedRevision: overwrite ? current.revision : null,
      });
      return adopt(record, pack);
    } catch (error) {
      if (overwrite && (error.code === "conflict" || error.code === "missing"))
        return resolveConflict(error, name, pack);
      throw error;
    }
  };
  const save = (asNew = false) => exclusive(() => saveNow(asNew));
  const openItem = item =>
    exclusive(async () => {
      opening = true;
      let ok;
      try {
        // 열기 직전의 최신 요약(revision)을 함께 읽는다. 다른 탭이 그 사이 저장했어도 연 내용과 revision이 맞도록 본문 뒤에 읽는다.
        ok = await openPack(() => store.load(item.id));
      } finally {
        opening = false;
      }
      if (!ok) return false;
      const latest = (await store.get(item.id).catch(() => null)) || item;
      current = { id: item.id, name: latest.name, fingerprint: fingerprint(), revision: latest.revision ?? null };
      cleanWork = null;
      remember();
      setStatus(`프로젝트 '${latest.name}' 열림`);
      return true;
    });
  const renameItem = item =>
    exclusive(async () => {
      const name = await ask({
        title: "이름 바꾸기",
        message: "",
        value: item.name,
        label: "프로젝트 이름",
        ok: "바꾸기",
      });
      if (name === null || name === undefined) return false;
      const record = await store.rename(item.id, name);
      announce({ type: "renamed", id: record.id, name: record.name });
      if (current?.id === item.id) {
        current = { ...current, name: record.name };
        remember();
      }
      setStatus(`이름 바꿈 · ${record.name}`);
      return true;
    });
  const deleteItem = item =>
    exclusive(async () => {
      const ok = await ask({
        title: "프로젝트 삭제",
        message: `보관함에서 '${item.name}'을(를) 지울까요? 되돌릴 수 없습니다. 지금 화면의 작업은 그대로 남습니다.`,
        ok: "삭제",
        danger: true,
      });
      if (!ok) return false;
      await store.remove(item.id);
      announce({ type: "removed", id: item.id });
      if (current?.id === item.id) {
        current = null;
        cleanWork = REMOVED;
        remember();
      }
      setStatus(`프로젝트 '${item.name}' 삭제됨`);
      return true;
    });

  on($("studioProjectSave"), "click", () => save(false));
  on($("studioProjectSaveAs"), "click", () => save(true));
  // 다른 탭의 보관함 변경: 목록을 다시 읽고, 지금 작업 중인 항목이면 알린다(revision은 그대로 두어 저장할 때 충돌을 묻는다).
  if (channel)
    channel.onmessage = event => {
      const message = event.data || {};
      if (message.tab === tabId || typeof message.id !== "string") return;
      if (current?.id === message.id) {
        if (message.type === "renamed" && typeof message.name === "string") {
          current = { ...current, name: message.name };
          remember();
        } else if (message.type === "saved")
          setStatus(`다른 탭(창)에서 '${current.name}'을(를) 저장했습니다 · 이 탭에서 저장하면 덮어쓸지 묻습니다`);
        else if (message.type === "removed")
          setStatus(
            `다른 탭(창)에서 '${current.name}'을(를) 보관함에서 지웠습니다 · 지금 작업은 이 탭에 남아 있습니다`
          );
      }
      render().catch(error => console.warn("프로젝트 목록 표시 실패:", error));
    };
  syncCurrent();
  const ready = render().catch(error => console.warn("프로젝트 목록 표시 실패:", error));

  return {
    save,
    // 예제·새 프로젝트·파일 열기처럼 다른 작업으로 바뀌면 부른다. 다음 저장은 새 항목이 된다.
    forget: () => {
      cleanWork = null;
      if (current) setCurrent(null);
      else remember();
    },
    // 지금 작업을 '바뀌지 않은 상태'로 기억한다(예제·새 프로젝트·파일을 연 직후). 보관함 프로젝트와 이어져 있으면 아무것도 하지 않는다.
    // ifUnknown: 기억해 둔 기준이 없을 때만(앱 시작 때).
    markClean: ({ ifUnknown = false } = {}) => {
      if (current || (ifUnknown && cleanWork)) return;
      cleanWork = workPrint();
      remember();
    },
    current: () => (current ? { ...current } : null),
    available: () => available,
    // 보관함과 다른가: 보관함 프로젝트는 저장·연 뒤 바뀌었는지(지문을 모르면 false), 이름 없는 작업은 시작한 뒤 바뀌었는지.
    modified: () =>
      current
        ? !!current.fingerprint && current.fingerprint !== fingerprint()
        : !!cleanWork && cleanWork !== workPrint(),
    // 다른 작업으로 바꾸기 전 '저장하고 계속': 보관함 항목을 여는 중이면 이미 잡은 작업 안에서 바로 저장한다.
    saveBeforeLeave: () => (opening ? saveNow(false) : save(false)),
    list: async () => {
      await render();
      return items.map(item => ({ ...item }));
    },
    open: id => {
      const item = items.find(entry => entry.id === id);
      return item ? openItem(item) : Promise.resolve(false);
    },
    rename: id => {
      const item = items.find(entry => entry.id === id);
      return item ? renameItem(item) : Promise.resolve(false);
    },
    remove: id => {
      const item = items.find(entry => entry.id === id);
      return item ? deleteItem(item) : Promise.resolve(false);
    },
    ready,
  };
};

export { create, CURRENT_KEY };
