(async () => {
  const check = (value, message) => { if (!value) throw new Error(message); console.log(`PASS: ${message}`); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const staticSelects = [...document.querySelectorAll("select")].filter(s => !s.multiple && s.size <= 1);
  check(staticSelects.length >= 14 && staticSelects.every(s => s.nextElementSibling?.matches(".ui-select")), "현재 main의 모든 정적 선택 상자에 공통 템플릿 적용");
  const dialog = document.createElement("dialog");
  dialog.innerHTML = '<label for="dropdown-test">테스트 선택</label><select id="dropdown-test"><optgroup label="그룹"><option value="a">Alpha</option><option disabled>Disabled</option><option value="b">Beta</option></optgroup></select>';
  document.body.append(dialog);
  dialog.showModal();
  await tick();
  const select = dialog.querySelector("select"), button = select.nextElementSibling;
  let changes = 0;
  select.addEventListener("change", () => changes++);
  const key = value => button.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  try {
    check(button.matches('.ui-select[role="combobox"]'), "동적 select에 공통 템플릿 적용");
    const arrowInset = () => {
      const style = getComputedStyle(button), arrow = getComputedStyle(button, "::after");
      check(style.paddingRight === style.paddingLeft && parseFloat(arrow.marginRight) === 0, "화살표에 native 선택 상자의 여백이 중복 적용되지 않음");
    };
    arrowInset();
    check(getComputedStyle(select).display === "none", "브라우저 기본 선택 UI 숨김");
    button.focus(); button.click();
    check(dialog.querySelector('[role="listbox"]'), "모달 내부 최상위 레이어에 목록 표시");
    check(dialog.querySelector('.ui-select-group').textContent === "그룹", "옵션 그룹 표시");
    key("ArrowDown"); key("Enter");
    check(select.value === "b" && changes === 1, "키보드 선택이 비활성 항목을 건너뛰고 change 한 번 발생");
    check(button.textContent === "Beta", "선택한 값 표시");
    select.value = "a";
    check(button.textContent === "Alpha", "프로그램 값 변경 즉시 반영");
    button.click(); key("ArrowDown"); key("Escape");
    check(select.value === "a" && button.getAttribute("aria-expanded") === "false", "Escape는 선택 취소 및 닫기");
    select.hidden = true; await tick(); check(button.hidden, "숨김 상태 동기화");
    select.hidden = false; select.disabled = true; await tick(); check(button.disabled, "비활성 상태 동기화");
    select.disabled = false; await tick();
    select.classList.add("ui-input--sm"); await tick();
    check(button.getBoundingClientRect().height === 28, "공통 sm 높이 토큰 28px 적용"); arrowInset();
    select.classList.replace("ui-input--sm", "ui-input--lg"); await tick();
    check(button.getBoundingClientRect().height === 36, "공통 lg 높이 토큰 36px 적용"); arrowInset();
    select.innerHTML = '<option value="c">Gamma</option><option value="d">Delta</option>'; await tick();
    check(button.textContent === "Gamma", "옵션 교체 반영");
    button.click(); key("d"); key("Enter");
    check(select.value === "d", "글자로 검색 후 확정");
    const form = document.createElement("form");
    dialog.append(form); select.name = "test"; form.append(select, button); await tick();
    check(new FormData(form).get("test") === "d", "기존 폼 제출 값 유지");
    form.reset(); await tick(); check(button.textContent === "Gamma", "폼 초기화 반영");
    button.click(); key("Tab"); check(!dialog.querySelector(".ui-select-menu"), "Tab으로 목록 닫기");
    for (const theme of ["light", "dark"]) {
      const prior = document.documentElement.dataset.theme;
      document.documentElement.dataset.theme = theme;
      button.click();
      const menu = dialog.querySelector(".ui-select-menu");
      const surface = getComputedStyle(document.documentElement).getPropertyValue("--elevated").trim();
      check(menu && getComputedStyle(menu).backgroundColor !== "rgba(0, 0, 0, 0)" && surface, `${theme} 테마 목록 표면 적용`);
      const r = menu.getBoundingClientRect();
      check(r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, "목록이 뷰포트 안에 표시됨");
      key("Escape");
      if (prior) document.documentElement.dataset.theme = prior;
      else delete document.documentElement.dataset.theme;
    }

    const frame = document.createElement("iframe");
    dialog.append(frame);
    frame.contentDocument.body.append(form); await tick();
    button.click();
    check(frame.contentDocument.querySelector(".ui-select-menu"), "다른 문서로 옮긴 필드는 해당 문서에 목록 표시");
    key("Escape");
    select.disabled = true; await tick(); check(button.disabled, "분리 문서에서도 속성 변경 반영");
    select.disabled = false; await tick();
    dialog.append(form); frame.remove(); await tick();
    const place = select.parentElement;
    select.remove(); await tick(); place.append(select); await tick();
    check(select.nextElementSibling === button, "제거 후 재삽입한 필드는 기존 컴포넌트 재사용");
    button.click(); dialog.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    check(button.getAttribute("aria-expanded") === "false", "바깥 클릭으로 닫기");
  } finally { dialog.close(); dialog.remove(); await tick(); }
  check(!document.querySelector('.ui-select-menu'), "제거된 필드의 열린 목록 정리");
})();
