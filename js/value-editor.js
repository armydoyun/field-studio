// Shared scalar/vector precision dialog. Drafts never reach the renderer before Apply.
import * as UI from "./ui-kit.js";
let serial = 0;
const describe = type => {
  const vector = /^(b|i|u)?vec([234])$/.exec(type);
  const kind = vector ? vector[1] || "f" : { float: "f", int: "i", uint: "u", bool: "b" }[type];
  if (!kind) throw new Error(`지원하지 않는 값 타입: ${type}`);
  return { kind, count: vector ? Number(vector[2]) : 1 };
};
const parse = (type, raw) => {
  const { kind, count } = describe(type);
  let text = raw.trim();
  const constructor = /^(\w+)\s*\(([\s\S]*)\)$/.exec(text);
  if (constructor) {
    if (constructor[1] !== type) throw new Error(`${type} 형식으로 입력하세요.`);
    text = constructor[2].trim();
  }
  if (!text || /(^,|,$|,\s*,)/.test(text)) throw new Error(`값 ${count}개를 빠짐없이 입력하세요.`);
  const parts = text.split(/[\s,]+/);
  if (parts.length !== count) throw new Error(`${type}에는 값 ${count}개가 필요합니다.`);
  const values = parts.map(part => {
    if (kind === "b") {
      if (!/^(true|false|0|1)$/i.test(part)) throw new Error("true/false 또는 1/0을 입력하세요.");
      return /^(true|1)$/i.test(part);
    }
    const value = Number(part);
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(part) || !Number.isFinite(value))
      throw new Error("유한한 숫자를 입력하세요. 소수와 지수 표기를 사용할 수 있습니다.");
    if (kind === "i" && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647))
      throw new Error("-2147483648 ~ 2147483647 범위의 정수를 입력하세요.");
    if (kind === "u" && (!Number.isInteger(value) || value < 0 || value > 4294967295))
      throw new Error("0 ~ 4294967295 범위의 정수를 입력하세요.");
    return value;
  });
  return count === 1 ? values[0] : values;
};
const arrayOf = value => (Array.isArray(value) ? [...value] : [value]);
const create = ({
  name,
  type,
  options = {},
  read,
  onChange,
  onApplied = () => {},
  getContext = () => null,
  compact = true,
}) => {
  const info = describe(type);
  let dialog = null,
    context = null;
  const button = compact
    ? UI.iconButton({
        icon: "expand",
        label: `${name} 값 편집`,
        size: "xs",
        className: "value-edit-open",
        onClick: open,
      })
    : UI.button({
        icon: "expand",
        label: "값 편집",
        variant: "ghost",
        size: "sm",
        className: "value-edit-open",
        onClick: open,
      });
  button.dataset.name = name;
  const close = (restore = true) => {
    if (!dialog) return;
    const old = dialog;
    dialog = null;
    old.close();
    old.remove();
    if (restore && button.isConnected) button.focus();
  };
  const refresh = () => {
    if (dialog && (getContext() !== context || read() === undefined)) close(false);
  };
  function open() {
    if (dialog) return;
    const live = read();
    if (live === undefined) return;
    const initial = arrayOf(live),
      fields = [];
    if (initial.length !== info.count) return;
    context = getContext();
    dialog = UI.el("dialog", "ui-dialog ui-dialog--md ui-dialog--column");
    dialog.setAttribute("aria-label", `${name} 값 편집`);
    const opened = dialog,
      head = UI.el("header", "ui-dialog-head"),
      heading = UI.el("div", "ui-dialog-text"),
      body = UI.el("div", "ui-dialog-body ui-value-editor"),
      form = UI.el("div", "ui-value-fields"),
      error = UI.el("p", "ui-error"),
      foot = UI.el("footer", "ui-dialog-foot");
    error.id = `value-editor-error-${++serial}`;
    error.setAttribute("role", "alert");
    error.hidden = true;
    const clear = () => {
      error.textContent = "";
      error.hidden = true;
      opened.querySelectorAll("[aria-invalid]").forEach(field => field.removeAttribute("aria-invalid"));
    };
    const fail = (message, field) => {
      error.hidden = false;
      error.textContent = message;
      if (field) {
        field.setAttribute("aria-invalid", "true");
        field.focus();
      }
    };
    const hint =
      info.kind === "b"
        ? "켜짐은 true, 꺼짐은 false입니다. 적용 전까지 원래 값은 유지됩니다."
        : info.kind === "u"
          ? "0 ~ 4294967295 범위의 정수 · 소수와 음수는 사용할 수 없습니다."
          : info.kind === "i"
            ? "-2147483648 ~ 2147483647 범위의 정수 · 소수는 사용할 수 없습니다."
            : options.angle
              ? "각도 원본은 라디안입니다. 패널 다이얼은 각도로 표시합니다."
              : options.dir
                ? "방향 성분을 편집합니다. 적용 시 길이 1로 정규화합니다."
                : "소수·지수 표기로 전체 값을 편집합니다. 적용 전까지 원래 값은 유지됩니다.";
    heading.append(UI.el("h2", "", "값 편집"), UI.el("p", "", `${name} · ${type}`));
    head.append(heading, UI.iconButton({ icon: "close", label: "값 편집 취소", size: "lg", onClick: () => close() }));
    body.append(UI.notice(hint));
    for (let index = 0; index < info.count; index++) {
      const axis =
        info.count === 1
          ? options.angle
            ? "각도 (rad)"
            : "값"
          : (options.color ? ["R", "G", "B", "A"] : ["X", "Y", "Z", "W"])[index];
      const group = UI.el("div", "ui-field"),
        label = UI.el("label", "ui-label", axis);
      let input;
      if (info.kind === "b") {
        const toggle = UI.el("label", "ui-switch ui-switch--field"),
          text = UI.el("span");
        input = UI.el("input");
        input.type = "checkbox";
        input.checked = initial[index];
        input.setAttribute("role", "switch");
        const paint = () => {
          text.textContent = input.checked ? "켜짐 · true" : "꺼짐 · false";
        };
        input.addEventListener("change", () => {
          clear();
          paint();
        });
        paint();
        toggle.append(input, text);
        group.append(label, toggle);
      } else if (options.enum) {
        input = UI.select({
          options: options.enum.map((text, i) => [String(i), text]),
          value: String(initial[index]),
          size: "lg",
        });
        group.append(label, input);
      } else {
        input = UI.el("input", "ui-number ui-input--lg");
        input.type = "text";
        input.inputMode = info.kind === "u" ? "numeric" : info.kind === "f" ? "decimal" : "text";
        input.value = String(initial[index]);
        input.autocomplete = "off";
        input.spellcheck = false;
        input.addEventListener("input", clear);
        input.addEventListener("keydown", event => {
          if (event.key === "Escape" && input.value !== String(initial[index])) {
            event.preventDefault();
            event.stopPropagation();
            input.value = String(initial[index]);
            clear();
          }
        });
        group.append(label, input);
      }
      input.id = `value-editor-field-${++serial}`;
      label.htmlFor = input.id;
      input.setAttribute("aria-label", `${name} ${axis}`);
      input.setAttribute("aria-describedby", error.id);
      fields.push(input);
      form.append(group);
    }
    body.append(form);
    if (info.count > 1) {
      const bulk = UI.el("details", "ui-disclosure"),
        summary = UI.el("summary", "", "벡터 한 번에 입력"),
        area = UI.el("textarea", "ui-input ui-number ui-value-paste"),
        actions = UI.el("div", "ui-value-actions");
      area.rows = 3;
      area.setAttribute("aria-label", `${name} 일괄 입력`);
      area.placeholder = `${type}(${initial.join(", ")})`;
      area.spellcheck = false;
      area.setAttribute("aria-describedby", error.id);
      area.addEventListener("input", clear);
      actions.append(
        UI.button({
          label: "입력칸에 채우기",
          size: "sm",
          onClick: () => {
            try {
              const values = arrayOf(parse(type, area.value));
              values.forEach((value, index) => {
                const field = fields[index];
                if (info.kind === "b") {
                  field.checked = value;
                  field.dispatchEvent(new Event("change", { bubbles: true }));
                } else field.value = String(value);
              });
              clear();
            } catch (e) {
              fail(e.message, area);
            }
          },
        })
      );
      bulk.append(
        summary,
        area,
        UI.hint(`${info.count}개 값을 쉼표·공백·줄바꿈으로 구분하세요. 입력칸에 채워도 아직 적용되지 않습니다.`),
        actions
      );
      body.append(bulk);
    }
    body.append(error);
    const apply = UI.button({
      label: "적용",
      variant: "primary",
      size: "lg",
      onClick: () => {
        if (getContext() !== context || read() === undefined) {
          close(false);
          return;
        }
        clear();
        const draft = [];
        for (let index = 0; index < fields.length; index++) {
          try {
            const field = fields[index];
            draft.push(
              info.kind === "b"
                ? field.checked
                : parse(info.kind === "f" ? "float" : info.kind === "u" ? "uint" : "int", field.value)
            );
          } catch (e) {
            fail(e.message, fields[index]);
            return;
          }
        }
        const current = arrayOf(read()),
          next = [...current];
        if (current.length !== info.count) {
          close(false);
          return;
        }
        draft.forEach((value, index) => {
          if (!Object.is(value, initial[index])) next[index] = value;
        });
        if (options.dir && Math.hypot(...next) <= 1e-9) {
          fail("방향은 0 벡터일 수 없습니다.", fields[0]);
          return;
        }
        if (options.enum && (next[0] < 0 || next[0] >= options.enum.length)) {
          fail("선택지 안의 값을 고르세요.", fields[0]);
          return;
        }
        if (!next.every((value, index) => Object.is(value, current[index]))) {
          if (onChange(apply, info.count === 1 ? next[0] : next) === false) {
            fail("값을 적용하지 못했습니다. 원래 값은 유지됩니다.");
            return;
          }
        }
        close();
        onApplied();
      },
    });
    foot.append(UI.button({ label: "취소", size: "lg", onClick: () => close() }), apply);
    dialog.append(head, body, foot);
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("close", () => {
      if (dialog === opened) close();
    });
    button.ownerDocument.body.append(dialog);
    dialog.showModal();
  }
  return {
    button,
    open,
    refresh,
    get isOpen() {
      return !!dialog;
    },
    dispose: () => close(false),
  };
};
export { create, describe, parse };
