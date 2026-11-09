// 앱 공용 입력·확인 대화상자(#studioPromptDialog). window.prompt/confirm 대신 쓰며, 편집기(cm-editor)도 같은 ask를 받는다.
// 한 번에 하나만 연다. 이미 열려 있으면 새 요청은 바로 '취소'로 끝난다.
//   ask({title, message, ok, danger})             → Promise<boolean>        (확인)
//   ask({title, message, ok, alt, danger})        → Promise<true|"alt"|false> (세 갈래: 확인 · 두 번째 선택 · 취소)
//   ask({title, message, value, label, type, min, max, validate}) → Promise<string|null> (값 입력)
//     validate(값) → 문제를 설명하는 문장 또는 ""(통과). 문제가 있으면 닫지 않고 입력 칸 아래에 이유를 보인다.
// hooks.pause(): 열기 직전에 부른다. 돌려준 값을 닫을 때 hooks.resume(값)으로 넘긴다(Studio는 자동 적용 타이머를 멈췄다 되살린다).

const create = ({ $, on, pause = () => null, resume = () => {} }) => {
  const dialog = $("studioPromptDialog"),
    form = $("studioDialogForm"),
    field = $("studioDialogField"),
    valueInput = $("studioDialogInput");
  let pending = null;
  const altButton = $("studioDialogAlt"),
    errorText = $("studioDialogError");
  // 입력 검사 결과를 입력 칸 아래에 보인다(빈 문장이면 지운다).
  const showProblem = problem => {
    if (!errorText) return;
    errorText.textContent = problem;
    errorText.hidden = !problem;
    if (problem) valueInput.setAttribute("aria-invalid", "true");
    else valueInput.removeAttribute("aria-invalid");
  };
  // 한 번 확인을 눌러 문제가 보인 뒤에는 고칠 때마다 다시 검사해 바로 알려 준다.
  on(valueInput, "input", () => {
    if (pending?.validate && pending.checked) showProblem(pending.validate(valueInput.value) || "");
  });
  // accepted: true(확인) · "alt"(두 번째 선택) · false(취소)
  const finish = accepted => {
    if (!pending) return;
    if (accepted === true && pending.hasValue && !valueInput.reportValidity()) return;
    if (accepted === true && pending.validate) {
      const problem = pending.validate(valueInput.value) || "";
      pending.checked = true;
      showProblem(problem);
      if (problem) {
        valueInput.focus();
        valueInput.select();
        return;
      }
    }
    const { resolve, hasValue, paused } = pending;
    showProblem("");
    pending = null;
    dialog.close();
    resume(paused);
    resolve(accepted === "alt" ? "alt" : accepted ? (hasValue ? valueInput.value : true) : hasValue ? null : false);
  };
  if (altButton) on(altButton, "click", () => finish("alt"));
  on(form, "submit", event => {
    event.preventDefault();
    finish(true);
  });
  on($("studioDialogCancel"), "click", () => finish(false));
  on($("studioDialogClose"), "click", () => finish(false));
  on(dialog, "cancel", event => {
    event.preventDefault();
    finish(false);
  });
  on(dialog, "close", () => {
    if (!dialog.open) finish(false);
  });
  // 바깥(backdrop)을 누르면 취소. Enter는 확인이지만 한글 조합 중(isComposing·229)이나 반복·조합키 입력은 무시하고, 키가 뒤 화면으로 새지 않게 막는다.
  on(dialog, "click", event => {
    if (event.target === dialog) finish(false);
  });
  on(dialog, "keydown", event => {
    event.stopPropagation();
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) finish(true);
  });
  const ask = ({
    title,
    message = "",
    value,
    ok = "확인",
    alt = "",
    danger = false,
    label = "값",
    type = "text",
    min,
    max,
    validate = null,
  }) =>
    new Promise(resolve => {
      const hasValue = value !== undefined;
      if (pending) return resolve(hasValue ? null : false);
      $("studioDialogTitle").textContent = title;
      $("studioDialogMessage").textContent = message;
      $("studioDialogOK").firstChild.textContent = ok + " ";
      dialog.dataset.danger = String(danger);
      if (altButton) {
        altButton.hidden = !alt || hasValue;
        altButton.textContent = alt;
      }
      // 확인 대화상자에서는 입력 칸을 숨기고 비활성화해 폼 검증에서 빠지게 한다.
      field.hidden = !hasValue;
      valueInput.disabled = !hasValue;
      if (hasValue) {
        field.firstChild.textContent = label;
        valueInput.type = type;
        valueInput.value = String(value);
        if (min === undefined) valueInput.removeAttribute("min");
        else valueInput.min = String(min);
        if (max === undefined) valueInput.removeAttribute("max");
        else valueInput.max = String(max);
        valueInput.required = typeof validate !== "function"; // 검사 함수가 있으면 빈 값도 그 문장으로 알린다
      }
      const paused = pause();
      pending = { resolve, hasValue, paused, validate: hasValue && typeof validate === "function" ? validate : null };
      showProblem("");
      try {
        // 미리보기 분리 창이 열려 있어도, 요청한 쪽(사용자가 마지막으로 조작한 창)에 띄운다.
        globalThis.shaderPopout?.place?.(dialog);
        dialog.showModal();
        (hasValue ? valueInput : $("studioDialogCancel")).focus();
        if (hasValue) valueInput.select();
      } catch (_) {
        pending = null;
        resume(paused);
        resolve(hasValue ? null : false);
      }
    });
  return { ask, close: () => finish(false) };
};

export { create };
