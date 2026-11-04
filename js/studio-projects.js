// 프로젝트 보관함 화면: 브라우저에 저장 · 다른 이름으로 저장 · 목록에서 열기 · 이름 바꾸기 · 삭제.
// 저장 내용은 Pack과 같다(코드·파라미터·설정·이미지 원본). 실제 Pack 만들기·복원은 studio.js가 넘겨 준 함수가 한다.
// "지금 작업 중인 프로젝트"를 기억해 두고, 저장하면 그 항목을 덮어쓴다. 예제·새 프로젝트·파일 열기로 바뀌면 잊는다.
import * as Store from "./storage.js";

const CURRENT_KEY = "webgl.shader-studio.current-project.v1";

const when = time => {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// store: project-store.js의 create() 결과
// buildPack(): Promise<{text, passes, images} | null>
// openPack(loadText): Promise<boolean> — loadText()가 돌려준 Pack 텍스트로 현재 작업을 바꾼다(미적용 변경 확인 포함).
const create = ({ $, on, element, ask, store, buildPack, openPack, setStatus, showError }) => {
  let current = Store.readJSON(CURRENT_KEY, null),
    items = [],
    busy = false,
    available = true;
  if (!current || typeof current.id !== "string" || typeof current.name !== "string") current = null;

  const remember = () => {
    if (current) Store.writeJSON(CURRENT_KEY, { id: current.id, name: current.name });
    else Store.remove(CURRENT_KEY);
  };
  const syncCurrent = () => {
    const label = $("studioProjectCurrent");
    label.textContent = current ? `작업 중: ${current.name}` : "보관함에 저장하지 않은 작업";
    label.dataset.saved = String(!!current);
    $("studioProjectSave").textContent = current ? "저장" : "브라우저에 저장";
    $("studioProjectSave").title = current
      ? `'${current.name}'에 덮어쓰기 · 코드·파라미터·설정·이미지 포함`
      : "이 브라우저의 프로젝트 보관함에 새로 저장 · 코드·파라미터·설정·이미지 포함";
    $("studioProjectSaveAs").hidden = !current;
    for (const button of [$("studioProjectSave"), $("studioProjectSaveAs")]) button.disabled = busy || !available;
  };
  const setCurrent = record => {
    current = record ? { id: record.id, name: record.name } : null;
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
    box.className = "studio-project";
    box.dataset.current = String(isCurrent);
    box.setAttribute("role", "listitem");
    openButton.type = "button";
    openButton.className = "studio-project-open";
    title.textContent = item.name;
    meta.textContent = [when(item.updated), `버퍼 ${item.passes || 0}`, `이미지 ${item.images || 0}`]
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
      button.className = `glyph-icon ${icon}`;
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
    // 다른 탭에서 지운 프로젝트는 더 이상 덮어쓸 대상이 아니다.
    if (available && current && !items.some(item => item.id === current.id)) {
      current = null;
      remember();
    }
    holder.replaceChildren();
    if (!items.length) {
      const hint = element("p");
      hint.className = "studio-hint";
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
  // asNew: 지금 프로젝트가 있어도 새 항목으로 저장한다.
  const save = (asNew = false) =>
    exclusive(async () => {
      const overwrite = current && !asNew;
      const name = overwrite
        ? current.name
        : await askName(
            asNew ? "다른 이름으로 저장" : "브라우저에 저장",
            asNew ? `${current?.name || suggestName()} 사본` : suggestName()
          );
      if (name === null || name === undefined) return false;
      const pack = await buildPack();
      if (!pack) return false;
      const record = await store.save({
        id: overwrite ? current.id : null,
        name,
        text: pack.text,
        passes: pack.passes,
        images: pack.images,
      });
      current = { id: record.id, name: record.name };
      remember();
      setStatus(`프로젝트 '${record.name}' 저장됨 · 이 브라우저의 보관함`);
      return true;
    });
  const openItem = item =>
    exclusive(async () => {
      const ok = await openPack(() => store.load(item.id));
      if (!ok) return false;
      current = { id: item.id, name: item.name };
      remember();
      setStatus(`프로젝트 '${item.name}' 열림`);
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
      if (current?.id === item.id) {
        current = { id: record.id, name: record.name };
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
      if (current?.id === item.id) {
        current = null;
        remember();
      }
      setStatus(`프로젝트 '${item.name}' 삭제됨`);
      return true;
    });

  on($("studioProjectSave"), "click", () => save(false));
  on($("studioProjectSaveAs"), "click", () => save(true));
  syncCurrent();
  const ready = render().catch(error => console.warn("프로젝트 목록 표시 실패:", error));

  return {
    save,
    // 예제·새 프로젝트·파일 열기처럼 다른 작업으로 바뀌면 부른다. 다음 저장은 새 항목이 된다.
    forget: () => {
      if (current) setCurrent(null);
    },
    current: () => (current ? { ...current } : null),
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
