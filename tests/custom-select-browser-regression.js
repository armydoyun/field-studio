(async () => {
  const check = (value, message) => { if (!value) throw new Error(message); console.log(`PASS: ${message}`); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
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
    check(button.matches('.custom-select[role="combobox"]'), "동적 select에 공통 템플릿 적용");
    check(getComputedStyle(select).display === "none", "브라우저 기본 선택 UI 숨김");
    button.focus(); button.click();
    check(dialog.querySelector('[role="listbox"]'), "모달 내부 최상위 레이어에 목록 표시");
    check(dialog.querySelector('.custom-select-group').textContent === "그룹", "옵션 그룹 표시");
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
    button.click(); dialog.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    check(button.getAttribute("aria-expanded") === "false", "바깥 클릭으로 닫기");
  } finally { dialog.close(); dialog.remove(); await tick(); }
  check(!document.querySelector('.custom-select-menu'), "제거된 필드의 열린 목록 정리");
})();
