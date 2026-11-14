// Matrix parameter editor. Display order is row/column; values stay GLSL column-major.
import * as UI from "./ui-kit.js";
let serial = 0;
const summary = (value, budget = 7, fits = text => text.length <= budget) => {
  const exact = String(value);
  if (fits(exact)) return exact;
  let last = exact;
  for (let digits = 5; digits >= 1; digits--) {
    const rounded = Number(value.toPrecision(digits));
    for (const form of [String(rounded), rounded.toExponential()]) {
      const short = form.replace("e+", "e");
      const text = `${Number(short) === value ? "" : "≈"}${short}`;
      last = text;
      if (fits(text)) return text;
    }
  }
  return last;
};
const create = ({ name, size, read, onChange, getContext = () => null, expanded = false, selected = 0 }) => {
  const node = UI.el("div", "ui-matrix"),
    tools = UI.el("div", "ui-matrix-tools"),
    grid = UI.el("div", "ui-matrix-grid"),
    columns = UI.el("div", "ui-matrix-columns"),
    rows = UI.el("div", "ui-matrix-rows"),
    cells = UI.el("div", "ui-matrix-values"),
    field = UI.el("div", "ui-field"),
    label = UI.el("label", "ui-label"),
    position = UI.el("span"),
    coordinate = UI.el("span", "ui-label-hint"),
    input = UI.el("input", "ui-number ui-matrix-input"),
    error = UI.el("span", "ui-error"),
    hint = UI.el("p", "ui-hint", "≈는 요약 표시입니다.");
  const buttons = [],
    texts = [];
  const measure = document.createElement("canvas").getContext("2d");
  let current = selected,
    original = "",
    dirty = false,
    dialog = null,
    expandedView = null,
    dialogContext = null;
  node.style.setProperty("--matrix-size", String(size));
  node.dataset.name = name;
  tools.append(UI.tag(`${size} × ${size}`));
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", `${name} ${size}행 ${size}열 행렬`);
  input.type = "text";
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.id = `matrix-input-${++serial}`;
  error.id = `${input.id}-error`;
  error.setAttribute("role", "alert");
  label.htmlFor = input.id;
  coordinate.title = "GLSL [열][행] · 0부터 시작";
  input.setAttribute("aria-describedby", error.id);
  const clearError = () => {
    input.removeAttribute("aria-invalid");
    error.textContent = "";
    error.hidden = true;
  };
  const load = () => {
    const value = read()?.[current];
    original = String(value);
    if (input.value !== original) input.value = original;
    input.title = original;
    dirty = false;
    clearError();
  };
  const refresh = () => {
    if (dialog && getContext() !== dialogContext) {
      close(false);
      return;
    }
    const values = read();
    if (!values || values.length !== size * size) return;
    for (const button of buttons) {
      const index = Number(button.dataset.index),
        text = texts[index];
      const budget = 7;
      let fits;
      if (button.clientWidth && measure?.measureText) {
        const style = getComputedStyle(button);
        measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const available = button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        fits = candidate => measure.measureText(candidate).width <= available;
      }
      text.textContent = summary(values[index], budget, fits);
      button.title = `${name}[${Math.floor(index / size)}][${index % size}] = ${String(values[index])}`;
      button.setAttribute(
        "aria-label",
        `${name} ${(index % size) + 1}행 ${Math.floor(index / size) + 1}열: ${String(values[index])}`
      );
      button.setAttribute("aria-pressed", String(index === current));
      button.tabIndex = index === current ? 0 : -1;
    }
    position.textContent = `${(current % size) + 1}행 · ${Math.floor(current / size) + 1}열`;
    coordinate.textContent = `[${Math.floor(current / size)}][${current % size}]`;
    input.setAttribute("aria-label", `${name} ${position.textContent} 전체 값`);
    if (!dirty) load();
  };
  const save = () => {
    if (!dirty && input.value === original) return true;
    const raw = input.value.trim(),
      value = Number(raw);
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) || !Number.isFinite(value)) {
      input.setAttribute("aria-invalid", "true");
      error.hidden = false;
      error.textContent = "유한한 숫자를 입력하세요. 지수 표기(예: 1.2e-8)도 가능합니다.";
      return false;
    }
    const next = [...read()];
    if (Object.is(next[current], value)) {
      load();
      return true;
    }
    next[current] = value;
    if (onChange(input, next) === false) {
      input.setAttribute("aria-invalid", "true");
      error.hidden = false;
      error.textContent = "값을 적용할 수 없습니다.";
      return false;
    }
    dirty = false;
    clearError();
    refresh();
    return true;
  };
  const choose = (index, edit = false) => {
    if (!save()) {
      input.focus();
      return;
    }
    current = index;
    load();
    refresh();
    if (edit) {
      input.focus();
      input.select?.();
    } else buttons.find(button => Number(button.dataset.index) === index)?.focus();
  };
  for (let column = 0; column < size; column++) columns.append(UI.el("span", "ui-matrix-axis", String(column + 1)));
  for (let row = 0; row < size; row++) {
    rows.append(UI.el("span", "ui-matrix-axis", String(row + 1)));
    for (let column = 0; column < size; column++) {
      const index = column * size + row,
        button = UI.button({ className: "ui-btn ui-matrix-cell", onClick: () => choose(index, true) }),
        text = UI.el("span");
      button.dataset.index = String(index);
      button.dataset.row = String(row);
      button.dataset.column = String(column);
      texts[index] = text;
      button.append(text);
      button.addEventListener("keydown", event => {
        const move = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[event.key];
        if (!move) return;
        event.preventDefault();
        event.stopPropagation();
        const nextRow = Math.max(0, Math.min(size - 1, row + move[0])),
          nextColumn = Math.max(0, Math.min(size - 1, column + move[1]));
        choose(nextColumn * size + nextRow);
      });
      buttons.push(button);
      cells.append(button);
    }
  }
  input.addEventListener("input", () => {
    dirty = true;
    clearError();
  });
  input.addEventListener("change", save);
  input.addEventListener("keydown", event => {
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (!save()) {
        event.preventDefault();
        return;
      }
      const visual = (current % size) * size + Math.floor(current / size),
        next = visual + (event.shiftKey ? -1 : 1);
      if (next >= 0 && next < size * size) {
        event.preventDefault();
        choose((next % size) * size + Math.floor(next / size), true);
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      save();
    }
    if (event.key === "Escape" && (dirty || input.value !== original || input.hasAttribute("aria-invalid"))) {
      event.preventDefault();
      event.stopPropagation();
      load();
    }
  });
  // A matrix cell/input is editing a parameter; single-letter application shortcuts yield.
  node.addEventListener("keydown", event => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
  });
  label.append(position, coordinate);
  field.append(label, input, error);
  grid.append(UI.el("span"), columns, rows, cells);
  node.append(tools, grid, field, hint);
  let expandButton = null;
  const close = (restore = true) => {
    if (!dialog) return;
    const closing = dialog;
    dialog = null;
    expandedView?.dispose();
    expandedView = null;
    closing.close();
    closing.remove();
    refresh();
    if (restore && expandButton?.isConnected) expandButton.focus();
  };
  if (!expanded) {
    expandButton = UI.button({
      label: "확대 편집",
      icon: "expand",
      variant: "ghost",
      size: "sm",
      onClick: () => {
        if (dialog) return;
        if (!save()) {
          input.focus();
          return;
        }
        dialogContext = getContext();
        const initial = [...read()];
        let draft = [...initial];
        dialog = UI.el("dialog", "ui-dialog ui-dialog--md");
        dialog.setAttribute("aria-label", `${name} 행렬 확대 편집`);
        const head = UI.el("header", "ui-dialog-head"),
          heading = UI.el("div", "ui-dialog-text"),
          body = UI.el("div", "ui-dialog-body"),
          foot = UI.el("footer", "ui-dialog-foot");
        heading.append(UI.el("h2", "", "행렬 편집"), UI.el("p", "", `${name} · 셀을 선택해 값을 고치고 적용하세요.`));
        head.append(
          heading,
          UI.iconButton({ icon: "close", label: "행렬 편집 취소", size: "lg", onClick: () => close() })
        );
        expandedView = create({
          name,
          size,
          read: () => draft,
          onChange: (_source, next) => {
            draft = next;
            return true;
          },
          expanded: true,
          selected: current,
        });
        body.append(expandedView.node);
        const apply = UI.button({
          label: "적용",
          variant: "primary",
          size: "lg",
          onClick: () => {
            if (getContext() !== dialogContext) {
              close(false);
              return;
            }
            if (!expandedView.commit()) {
              expandedView.input.focus();
              return;
            }
            if (!draft.every((value, index) => Object.is(value, initial[index])) && onChange(apply, draft) === false)
              return;
            close();
          },
        });
        foot.append(UI.button({ label: "취소", size: "lg", onClick: () => close() }), apply);
        dialog.append(head, body, foot);
        dialog.addEventListener("cancel", event => {
          event.preventDefault();
          close();
        });
        const opened = dialog;
        dialog.addEventListener("close", () => {
          if (dialog === opened) close();
        });
        node.ownerDocument.body.append(dialog);
        dialog.showModal();
        expandedView.refresh();
      },
    });
    tools.append(expandButton);
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(refresh) : null;
  observer?.observe(node);
  refresh();
  return {
    node,
    input,
    refresh,
    commit: save,
    get isOpen() {
      return !!dialog;
    },
    dispose: () => {
      close(false);
      observer?.disconnect();
    },
  };
};
export { create, summary };
