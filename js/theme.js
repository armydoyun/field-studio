// 화면 테마: "system"(기본, 운영체제 밝기 설정을 따름) · "light" · "dark".
// 선택은 localStorage에 보관하고 <html data-theme>로 적용한다. 첫 그리기 전 적용은 index.html <head>의 작은 스크립트가 맡는다.
// 색은 전부 css/tokens.css의 토큰이므로 여기서는 속성만 바꾸고, 캔버스로 그리는 모듈은 "theme-changed" 이벤트를 듣는다.
const KEY = "field.theme.v1";
const CHOICES = ["system", "light", "dark"];

const readChoice = () => {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
};
const writeChoice = value => {
  try {
    if (value === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, value);
  } catch {
    /* 저장소를 못 쓰면 이번 방문에만 적용 */
  }
};

const mount = (doc = document) => {
  const root = doc.documentElement,
    view = doc.defaultView;
  const media = typeof view?.matchMedia === "function" ? view.matchMedia("(prefers-color-scheme: light)") : null;
  const toggle = doc.getElementById("themeToggle"),
    options = [...doc.querySelectorAll("[data-theme-choice]")];
  let choice = readChoice();
  const resolved = () => (choice === "system" ? (media?.matches ? "light" : "dark") : choice);

  const apply = () => {
    if (choice === "system") delete root.dataset.theme;
    else root.dataset.theme = choice;
    const theme = resolved();
    // 브라우저 주소줄·작업 표시줄 색도 패널 면 색에 맞춘다.
    const panel = view?.getComputedStyle?.(root).getPropertyValue("--panel").trim();
    if (panel) doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", panel);
    if (toggle) {
      // 버튼에는 "눌렀을 때 바뀔 테마"를 그린다: 다크에서는 해, 라이트에서는 달.
      const next = theme === "dark" ? "라이트" : "다크";
      toggle.classList.toggle("icon-sun", theme === "dark");
      toggle.classList.toggle("icon-moon", theme === "light");
      toggle.setAttribute("aria-label", `${next} 테마로 전환`);
      toggle.title = `${next} 테마로 전환`;
    }
    for (const button of options) {
      const active = button.dataset.themeChoice === choice;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    }
    doc.dispatchEvent(new CustomEvent("theme-changed", { detail: { choice, theme } }));
  };
  const set = value => {
    if (!CHOICES.includes(value)) return;
    choice = value;
    writeChoice(value);
    apply();
  };

  toggle?.addEventListener("click", () => set(resolved() === "dark" ? "light" : "dark"));
  for (const button of options) button.addEventListener("click", () => set(button.dataset.themeChoice));
  media?.addEventListener?.("change", () => {
    if (choice === "system") apply();
  });
  apply();
  return {
    get choice() {
      return choice;
    },
    get theme() {
      return resolved();
    },
    set,
  };
};

export { mount };
