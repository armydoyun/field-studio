// Shared select presentation. Native controls remain the source of form values/events.
function mount(root = document) {
  const controls = new Map();
  const known = new WeakMap();
  const documents = new Map();
  let disposed = false;
  let opened = null,
    serial = 0;
  const close = (restore = false) => {
    if (!opened) return;
    const { button, menu, cleanup } = opened;
    cleanup();
    menu.remove();
    button.setAttribute("aria-expanded", "false");
    button.removeAttribute("aria-activedescendant");
    button.removeAttribute("aria-controls");
    opened = null;
    if (restore) button.focus();
  };
  const enhance = select => {
    if (disposed) return;
    if (select.multiple || select.size > 1) return;
    if (controls.has(select)) {
      // 원본 select만 다른 부모로 옮겨진 경우(타임라인이 다시 그릴 때 '+ 파라미터' 칸): 보이는 버튼을 따라 옮긴다.
      // 옮기지 않으면 버튼은 떼어진 예전 부모에 남고 원본은 숨겨져 있어 칸이 화면에서 사라진다.
      const { button, sync } = controls.get(select);
      if (select.nextElementSibling !== button) {
        select.after(button);
        sync();
      }
      return;
    }
    if (known.has(select)) {
      const control = known.get(select);
      select.after(control.button);
      controls.set(select, control);
      control.connect();
      control.sync();
      return;
    }
    const original = { tabindex: select.getAttribute("tabindex"), hidden: select.getAttribute("aria-hidden") };
    const handlers = [],
      properties = [];
    let connected = false;
    const on = (target, type, fn) => handlers.push({ target, type, fn });
    const document = select.ownerDocument;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${select.className} ui-input ui-select`;
    button.setAttribute("role", "combobox");
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const text = document.createElement("span");
    button.append(text);
    select.after(button);

    const sync = () => {
      if (disposed || !connected) return;
      const label = select.selectedOptions[0]?.label || "선택";
      if (text.textContent !== label) text.textContent = label;
      button.className = `${select.className.replace("ui-select-source", "")} ui-input ui-select`;
      button.style.cssText = select.style.cssText;
      button.hidden = select.hidden;
      button.disabled = select.matches(":disabled");
      button.title = select.title;
      if (opened?.select === select && (select.hidden || select.disabled)) close();
      const labels = [...(select.labels || [])].map(label => {
        if (!label.id) label.id = `select-label-${++serial}`;
        return label.id;
      });
      const labelledby = select.getAttribute("aria-labelledby") || labels.join(" ");
      if (labelledby && !select.hasAttribute("aria-label")) button.setAttribute("aria-labelledby", labelledby);
      else {
        button.removeAttribute("aria-labelledby");
        button.setAttribute("aria-label", select.getAttribute("aria-label") || select.name || "선택");
      }
      for (const attr of ["aria-describedby", "aria-invalid", "aria-required"])
        if (select.hasAttribute(attr)) button.setAttribute(attr, select.getAttribute(attr));
        else button.removeAttribute(attr);
      button.setAttribute("aria-required", String(select.required));
      if (opened?.select === select)
        opened.items.forEach(item =>
          item.node.setAttribute("aria-selected", String(item.index === select.selectedIndex))
        );
    };
    const open = () => {
      const document = select.ownerDocument;
      sync();
      if (button.disabled || button.hidden) return;
      close();
      const menu = document.createElement("div");
      menu.className = "ui-popover ui-select-menu";
      menu.id = `select-menu-${++serial}`;
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", button.getAttribute("aria-label") || select.labels?.[0]?.textContent || "선택");
      const items = [];
      let active = -1;
      const activate = index => {
        if (!items.length) return;
        active = Math.max(0, Math.min(items.length - 1, index));
        items.forEach((item, i) => item.node.classList.toggle("is-active", i === active));
        button.setAttribute("aria-activedescendant", items[active].node.id);
        items[active].node.scrollIntoView({ block: "nearest" });
      };
      const choose = index => {
        if (!items[index]) return;
        const changed = select.selectedIndex !== items[index].index;
        select.selectedIndex = items[index].index;
        sync();
        close(true);
        if (changed) {
          select.dispatchEvent(new document.defaultView.Event("input", { bubbles: true }));
          select.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
        }
      };
      let group = null;
      [...select.options].forEach((option, index) => {
        if (option.hidden || option.parentElement.hidden) return;
        const parent = option.parentElement;
        if (parent.tagName === "OPTGROUP" && parent !== group) {
          group = parent;
          const heading = document.createElement("div");
          heading.className = "ui-select-group";
          heading.textContent = parent.label;
          menu.append(heading);
        }
        const node = document.createElement("div");
        node.id = `${menu.id}-${index}`;
        node.className = "ui-select-option";
        node.textContent = option.label;
        node.setAttribute("role", "option");
        node.setAttribute("aria-selected", String(option.selected));
        const disabled = option.disabled || (parent.tagName === "OPTGROUP" && parent.disabled);
        node.setAttribute("aria-disabled", String(disabled));
        if (!disabled) {
          const itemIndex = items.length;
          items.push({ node, index, label: option.label });
          node.addEventListener("pointermove", event => {
            if (event.pointerType !== "touch") activate(itemIndex);
          });
          node.addEventListener("click", () => choose(itemIndex));
        }
        menu.append(node);
      });
      // Keep the list within the owning dialog's top layer (and pop-out document).
      (select.closest("dialog[open]") || document.body).append(menu);
      button.setAttribute("aria-controls", menu.id);
      button.setAttribute("aria-expanded", "true");
      const view = document.defaultView;
      const { innerHeight, innerWidth } = view;
      const rect = button.getBoundingClientRect();
      const below = innerHeight - rect.bottom - 8,
        above = rect.top - 8;
      menu.style.width = `${Math.min(Math.max(rect.width, 180), innerWidth - 16)}px`;
      menu.style.maxHeight = `${Math.max(32, Math.min(280, Math.max(below, above)))}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.getBoundingClientRect().width - 8))}px`;
      if (below >= Math.min(280, menu.scrollHeight) || below >= above) menu.style.top = `${rect.bottom + 4}px`;
      else menu.style.bottom = `${innerHeight - rect.top + 4}px`;
      const outside = event => {
        if (!menu.contains(event.target) && !button.contains(event.target)) close();
      };
      const scroll = event => {
        if (!menu.contains(event.target)) close();
      };
      const resize = () => close();
      const cancel = () => close();
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("scroll", scroll, true);
      document.addEventListener("close", cancel, true);
      view.addEventListener("resize", resize);
      view.addEventListener("pagehide", cancel);
      const cleanup = () => {
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("scroll", scroll, true);
        document.removeEventListener("close", cancel, true);
        view.removeEventListener("resize", resize);
        view.removeEventListener("pagehide", cancel);
      };
      opened = {
        select,
        button,
        menu,
        items,
        activate,
        choose,
        cleanup,
        get active() {
          return active;
        },
      };
      activate(
        Math.max(
          0,
          items.findIndex(item => item.index === select.selectedIndex)
        )
      );
    };
    on(button, "click", event => {
      event.preventDefault();
      if (opened?.button === button) close();
      else open();
    });
    let query = "",
      lastTyped = 0;
    on(button, "keydown", event => {
      const key = event.key;
      event.stopPropagation();
      if (event.isComposing) return;
      if (key === "Tab") {
        close();
        return;
      }
      if (key === "Escape") {
        if (opened) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
        return;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)) {
        event.preventDefault();
        event.stopPropagation();
        if (!opened || opened.button !== button) {
          open();
          return;
        }
        if (key === "Enter" || key === " ") opened.choose(opened.active);
        else
          opened.activate(
            key === "Home"
              ? 0
              : key === "End"
                ? opened.items.length - 1
                : opened.active + (key === "ArrowDown" ? 1 : -1)
          );
      } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!opened || opened.button !== button) open();
        query = Date.now() - lastTyped > 700 ? key : query + key;
        lastTyped = Date.now();
        const index = opened.items.findIndex(item =>
          item.label.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())
        );
        if (index >= 0) opened.activate(index);
      }
    });
    on(select, "change", sync);
    on(select, "focus", () => button.focus());
    on(select, "invalid", event => {
      event.preventDefault();
      button.focus();
    });
    for (const property of ["value", "selectedIndex"]) {
      const descriptor = Object.getOwnPropertyDescriptor(document.defaultView.HTMLSelectElement.prototype, property);
      properties.push({
        property,
        original: Object.getOwnPropertyDescriptor(select, property),
        descriptor: {
          configurable: true,
          get() {
            return descriptor.get.call(this);
          },
          set(value) {
            descriptor.set.call(this, value);
            sync();
          },
        },
      });
    }
    const control = {
      button,
      sync,
      connect() {
        if (connected || disposed) return;
        connected = true;
        select.classList.add("ui-select-source");
        select.tabIndex = -1;
        select.setAttribute("aria-hidden", "true");
        for (const { target, type, fn } of handlers) target.addEventListener(type, fn);
        for (const { property, descriptor } of properties) Object.defineProperty(select, property, descriptor);
      },
      disconnect() {
        if (!connected) return;
        connected = false;
        if (opened?.select === select) close();
        for (const { target, type, fn } of handlers) target.removeEventListener(type, fn);
        for (const { property, original } of properties) {
          if (original) Object.defineProperty(select, property, original);
          else delete select[property];
        }
        select.classList.remove("ui-select-source");
        for (const [name, value] of [
          ["tabindex", original.tabindex],
          ["aria-hidden", original.hidden],
        ]) {
          if (value === null) select.removeAttribute(name);
          else select.setAttribute(name, value);
        }
        button.remove();
      },
    };
    control.connect();
    known.set(select, control);
    controls.set(select, control);
    sync();
  };
  const refresh = () => {
    if (disposed) return;
    for (const [select, control] of controls) {
      if (!select.isConnected) {
        if (opened?.select === select) close();
        control.disconnect();
        controls.delete(select);
      } else control.sync();
    }
    for (const doc of documents.keys()) doc.querySelectorAll("select").forEach(enhance);
  };
  const mutations = records => {
    if (disposed) return;
    let removed = false;
    for (const record of records) {
      if (record.target.closest?.(".ui-select, .ui-select-menu")) continue;
      const select = record.target.closest?.("select");
      if (select && controls.has(select)) {
        if (opened?.select === select && record.type !== "characterData") close();
        controls.get(select).sync();
      }
      for (const node of record.addedNodes || []) {
        if (node.nodeType !== 1 || node.matches(".ui-select, .ui-select-menu")) continue;
        if (node.matches("select")) enhance(node);
        node.querySelectorAll("select").forEach(enhance);
      }
      if (record.removedNodes?.length) removed = true;
      if (record.target.tagName === "FIELDSET") refresh();
    }
    if (removed)
      for (const select of controls.keys()) {
        if (select.isConnected && !documents.has(select.ownerDocument)) watch(select.ownerDocument);
      }
    if (removed)
      for (const [select, control] of controls) {
        if (!select.isConnected) {
          if (opened?.select === select) close();
          control.disconnect();
          controls.delete(select);
        }
      }
  };
  const unwatch = doc => {
    const entry = documents.get(doc);
    if (!entry) return;
    entry.observer.disconnect();
    entry.controller.abort();
    documents.delete(doc);
    for (const [select, control] of controls)
      if (select.ownerDocument === doc) {
        control.disconnect();
        controls.delete(select);
      }
  };
  const watch = doc => {
    if (disposed || documents.has(doc)) return;
    const controller = new AbortController(),
      signal = controller.signal;
    const observer = new MutationObserver(mutations);
    documents.set(doc, { controller, observer });
    observer.observe(doc, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "hidden",
        "disabled",
        "label",
        "selected",
        "value",
        "aria-label",
        "aria-labelledby",
        "aria-describedby",
        "aria-invalid",
        "required",
        "class",
        "style",
      ],
    });
    doc.addEventListener(
      "pointerdown",
      event => {
        if (opened && !opened.menu.contains(event.target) && !opened.button.contains(event.target)) close();
      },
      { capture: true, signal }
    );
    doc.addEventListener(
      "scroll",
      event => {
        if (opened && !opened.menu.contains(event.target)) close();
      },
      { capture: true, signal }
    );
    const view = doc.defaultView || window;
    view.addEventListener("resize", () => close(), { signal });
    view.addEventListener(
      "pagehide",
      event => {
        if (!event.persisted) unwatch(doc);
      },
      { signal }
    );
    doc.addEventListener("reset", () => queueMicrotask(refresh), { signal });
    doc.addEventListener(
      "click",
      event => {
        const label = event.target.closest?.("label");
        const control = label && controls.get(label.control);
        if (control && !control.button.contains(event.target)) {
          event.preventDefault();
          control.button.focus();
          control.button.click();
        }
      },
      { signal }
    );
    // Refresh presentation when application code focuses a field.
    doc.addEventListener("focusin", refresh, { capture: true, signal });
    doc.querySelectorAll("select").forEach(enhance);
  };
  watch(root);
  refresh();
  return {
    refresh,
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      for (const doc of [...documents.keys()]) unwatch(doc);
      for (const control of controls.values()) control.disconnect();
      controls.clear();
    },
  };
}

export { mount };
