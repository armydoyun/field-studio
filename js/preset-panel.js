// 파라미터 프리셋 막대(설정 패널 · 파라미터 탭): 값 묶음 저장 · 적용(즉시 / 부드럽게) · 호환성 결과 · ⋯ 메뉴.
// 값 규칙(섞기 · 호환성 검사 · 저장 형식)은 presets.js, 저장은 settings.getPresets/setPresets.
// ui.js의 파라미터 목록과 상태를 함께 쓰므로 ctx로 받는다. comparison · viewingA · autoCompare는 ui.js가 바꾸는
// 값이라 ctx의 getter로 읽고, 목록을 다시 그리지 않아도 되는 때는 ctx.syncSnapshot()으로 알린다.
//   create(ctx) → { presetNotice, clearPresetReport, closePresetMenu, stopMorph, renderPresets }
import * as ContextMenu from "./context-menu.js";
import * as Presets from "./presets.js";
import * as ParameterTools from "./parameter-tools.js";

const create = ctx => {
  const {
    $,
    element,
    listen,
    signal,
    attempt,
    setText,
    renderer,
    settings,
    sameValue,
    changeSyncs,
    playViews,
    resetSyncs,
    comparisonKey,
    captureComparison,
    playing,
    syncPlayButtons,
    renderUniforms,
    displayNumber,
  } = ctx;
  // ---- 파라미터 프리셋(presets.js · settings.getPresets/setPresets) ----
  // 칩을 누르면 그 값 묶음으로 바꾼다(전환 시간만큼 부드럽게). 지금 값이 프리셋과 같으면 그 칩이 눌린 상태로 보인다.
  // 고치는 일(지금 값으로 덮어쓰기 · 이름 바꾸기 · 삭제)은 칩 옆 ⋯ 메뉴 안에만 둔다 — 칩을 누르려다 잘못 누르지 않게.
  // 덮어쓰기는 무엇이 바뀌는지 보여 주고 한 번 더 묻는다. 덮어쓰기 · 삭제는 안내 줄의 되돌리기 · Ctrl+Z로 되돌린다.
  let morph = 0,
    presetRestore = null, // 되돌리기: 바로 전 프리셋 목록
    presetMenu = null; // 열린 ⋯ 메뉴 { node, button }
  // undo: 되돌릴 때 다시 쓸 프리셋 목록(없으면 되돌리기 버튼을 숨긴다)
  const presetNotice = (text, undo = null) => {
    $("presetNoticeText").textContent = text;
    $("presetNoticeText").title = text; // 좁으면 한 줄에서 말줄임(presets.css) — 전체 문구는 툴팁
    presetRestore = undo;
    $("presetUndo").hidden = !undo;
  };
  const clearPresetReport = () => {
    $("presetReport").hidden = true;
    $("presetReport").open = false;
  };
  const showPresetReport = (preset, result, from, interrupted = false) => {
    const report = $("presetReport");
    report.hidden = false;
    report.open = false;
    setText(
      "presetReportSummary",
      `${preset.name} · ${interrupted ? "전환 중단 · " : ""}적용 ${result.applied.length}개 · 건너뜀 ${result.skipped.length}개${result.legacy ? " · 이전 형식" : ""}`
    );
    $("presetReportHint").hidden = !result.legacy;
    const current = new Map(renderer.getUserUniforms().map(item => [item.name, item.value]));
    $("presetReportList").replaceChildren(
      ...[
        ...result.skipped.map(item => `건너뜀 · ${item.name}: ${item.reason}`),
        ...result.applied.map(
          item =>
            `적용 · ${item.name}: ${formatPresetValue(from[item.name], true)} → ${formatPresetValue(current.get(item.name), true)}`
        ),
      ].map(text => {
        const row = element("li");
        row.textContent = text;
        return row;
      })
    );
  };
  const closePresetMenu = (focusButton = false) => {
    if (!presetMenu) return;
    const { node, button } = presetMenu;
    presetMenu = null;
    node.remove();
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  };
  listen(document, "pointerdown", event => {
    if (presetMenu && !presetMenu.node.contains(event.target) && event.target !== presetMenu.button) closePresetMenu();
  });
  // 덮어쓰면 바뀌는 파라미터: [이름, 프리셋 값, 지금 값]
  const presetChanges = (preset, users) =>
    users
      .filter(
        item =>
          !Object.hasOwn(preset.values, item.name) ||
          !sameValue(item.value, preset.values[item.name]) ||
          JSON.stringify(preset.schema?.[item.name]) !== JSON.stringify(Presets.capture("", [item]).schema[item.name])
      )
      .map(item => [item.name, preset.values[item.name], item.value]);
  const formatPresetValue = (value, detailed = false) =>
    value === undefined
      ? "(없음)"
      : Array.isArray(value)
        ? value.length > 4 && !detailed
          ? `[${value.length}개]`
          : `(${value.map(v => (typeof v === "number" ? displayNumber(v) : String(v))).join(", ")})`
        : typeof value === "number"
          ? displayNumber(value)
          : String(value);
  const overwritePreset = async index => {
    stopMorph();
    const presets = settings.getPresets(),
      preset = presets[index],
      users = renderer.getUserUniforms(),
      changes = presetChanges(preset, users);
    if (!preset || !changes.length) return;
    const ask = window.shaderStudio?.ask,
      lines = changes.slice(0, 6).map(
        ([name, from, to]) =>
          `${name}: ${formatPresetValue(from)} → ${formatPresetValue(to)}${
            JSON.stringify(preset.schema?.[name]) !==
            JSON.stringify(
              Presets.capture(
                "",
                users.filter(item => item.name === name)
              ).schema[name]
            )
              ? " · 타입·선택지 정보 갱신"
              : ""
          }`
      ),
      more = changes.length > 6 ? `\n… 외 ${changes.length - 6}개` : "";
    const ok = ask
      ? await ask({
          title: `'${preset.name}' 덮어쓰기`,
          message: `이 프리셋을 지금 파라미터 값으로 바꿉니다. 바뀌는 값 ${changes.length}개:\n${lines.join("\n")}${more}\n\n덮어쓴 뒤에도 '되돌리기'나 Ctrl+Z로 되돌릴 수 있습니다.`,
          ok: "덮어쓰기",
          danger: true,
        })
      : true;
    if (!ok) return;
    attempt(() => {
      settings.setPresets(
        settings.getPresets().map((item, i) => (i === index ? Presets.capture(item.name, users) : item))
      );
      presetNotice(`'${preset.name}'을 지금 값으로 덮어썼습니다(값 ${changes.length}개)`, presets);
      $("presetUndo").focus();
    });
  };
  const renamePreset = async index => {
    stopMorph();
    const presets = settings.getPresets(),
      preset = presets[index],
      others = presets.filter((_, i) => i !== index).map(item => item.name);
    const name = await askName("프리셋 이름 바꾸기", preset.name, others);
    if (!name || name === preset.name) return;
    attempt(() => {
      settings.setPresets(settings.getPresets().map((item, i) => (i === index ? { ...item, name } : item)));
      presetNotice(`'${preset.name}' → '${name}'`, presets);
    });
  };
  const removePreset = index => {
    stopMorph();
    const presets = settings.getPresets(),
      preset = presets[index];
    attempt(() => {
      settings.setPresets(presets.filter((_, i) => i !== index));
      presetNotice(`'${preset.name}' 삭제됨`, presets);
      $("presetUndo").focus();
    });
  };
  // ⋯ 메뉴: 덮어쓰기(지금 값과 같으면 꺼짐) · 이름 바꾸기 · 삭제. ↑↓로 옮기고 Esc로 닫는다.
  const openPresetMenu = (button, index) => {
    if (presetMenu?.button === button) return closePresetMenu(true);
    closePresetMenu();
    const preset = settings.getPresets()[index],
      same = !presetChanges(preset, renderer.getUserUniforms()).length,
      node = element("div");
    node.className = "ui-popover ui-menu preset-menu";
    node.setAttribute("role", "menu");
    node.setAttribute("aria-label", `'${preset.name}' 프리셋 관리`);
    const items = [
      [
        "지금 값으로 덮어쓰기…",
        () => overwritePreset(index),
        same,
        same ? "지금 값과 같습니다" : "바뀌는 값을 확인한 뒤 덮어씁니다",
      ],
      ["이름 바꾸기…", () => renamePreset(index), false, "이름을 두 번 눌러도 바꿀 수 있습니다"],
      ["삭제", () => removePreset(index), false, "삭제한 뒤 되돌릴 수 있습니다"],
    ].map(([text, run, disabled, title]) => {
      const item = element("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.className = text === "삭제" ? "ui-menu-item preset-menu-item is-danger" : "ui-menu-item preset-menu-item";
      item.textContent = text;
      item.title = title;
      item.disabled = disabled;
      item.addEventListener("click", () => {
        closePresetMenu();
        run();
      });
      return item;
    });
    node.append(...items);
    node.addEventListener("keydown", event => {
      const enabled = items.filter(item => !item.disabled),
        at = enabled.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePresetMenu(true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        enabled[(at + step + enabled.length) % enabled.length]?.focus();
      } else if (event.key === "Tab") closePresetMenu();
    });
    button.after(node);
    // 칩 왼쪽 끝에 맞춰 펼치고, 프리셋 막대 오른쪽을 넘으면 오른쪽 끝에 맞춘다
    const bounds = $("presetBar").getBoundingClientRect();
    if (node.getBoundingClientRect().right > bounds.right) node.classList.add("is-end");
    button.setAttribute("aria-expanded", "true");
    presetMenu = { node, button };
    items.find(item => !item.disabled)?.focus();
  };
  // 전환 중 표시: 목표 칩에 진행 막대(--morph 0~1) · 알림 줄에 '전환 중'과 '바로 끝내기'.
  // 직접 값을 만지면 전환은 그 자리에서 멈추고(만진 값이 이긴다) 멈췄다고 알린다.
  let morphState = null; // { name, finish(): 끝 값으로 바로 }
  const morphChip = name =>
    [...($("presetList")?.querySelectorAll?.(".preset-chip") || [])].find(
      chip => chip.querySelector(".preset-apply")?.textContent === name
    );
  const paintMorph = t => {
    const chip = morphState && morphChip(morphState.name);
    for (const node of $("presetList")?.querySelectorAll?.(".preset-chip.is-morphing") || [])
      if (node !== chip) node.classList.remove("is-morphing");
    if (!chip) return;
    chip.classList.add("is-morphing");
    chip.style.setProperty("--morph", String(t));
  };
  const endMorphUi = () => {
    morphState = null;
    paintMorph(0);
    $("presetBar")?.classList?.remove("is-morphing");
    if ($("presetFinish")) $("presetFinish").hidden = true;
  };
  // byUser: 사용자가 값을 직접 바꿔 멈춘 경우(알림을 남긴다)
  const stopMorph = (byUser = false) => {
    if (morph) cancelAnimationFrame(morph);
    const wasMorphing = !!morph && morphState;
    morph = 0;
    if (wasMorphing) {
      const recorded = morphState.commit?.();
      morphState.report?.(true);
      presetNotice(
        `'${morphState.name}' 전환을 멈췄습니다${byUser ? " · 지금 값 유지" : ""}${recorded ? " · Ctrl+Z로 적용 전 복원" : ""}`
      );
    }
    if (morphState) endMorphUi();
  };
  signal.addEventListener("abort", () => stopMorph());
  const askName = async (title, value, others) => {
    const ask = window.shaderStudio?.ask;
    if (!ask) return value;
    const name = await ask({
      title,
      message: "파라미터 값 전체를 이 이름으로 저장합니다. 같은 프로젝트에 저장되고 프로젝트 파일에도 담깁니다.",
      value,
      label: "프리셋 이름",
      validate: text => {
        const trimmed = text.trim();
        if (!trimmed) return "이름을 적으세요.";
        if (trimmed.length > Presets.MAX_NAME) return `${Presets.MAX_NAME}자 이하로 적으세요.`;
        return others.includes(trimmed) ? "같은 이름의 프리셋이 있습니다." : "";
      },
    });
    return name === null || name === undefined ? null : name.trim();
  };
  const matchesPreset = (preset, users) => {
    const result = Presets.plan(users, preset, settings.getLinks?.() || []);
    return (
      result.applied.length > 0 &&
      !result.skipped.length &&
      result.applied.every(item =>
        ParameterTools.equalValue(item.value, users.find(user => user.name === item.name)?.value)
      )
    );
  };
  const applyPreset = preset => {
    if (ctx.viewingA) return;
    stopMorph();
    const users = renderer.getUserUniforms(),
      from = Object.fromEntries(users.map(item => [item.name, item.value])),
      result = Presets.plan(users, preset, settings.getLinks?.() || []),
      names = result.applied.map(item => item.name),
      target = { values: Object.fromEntries(result.applied.map(item => [item.name, item.value])) },
      summary = `'${preset.name}' · ${names.length}개 적용 · ${result.skipped.length}개 건너뜀${result.legacy ? " · 이전 형식" : ""}`;
    clearPresetReport();
    if (!names.length || result.applied.every(item => ParameterTools.equalValue(item.value, from[item.name]))) {
      presetNotice(summary);
      showPresetReport(preset, result, from);
      return;
    }
    if (
      ctx.autoCompare &&
      !ctx.comparison &&
      result.applied.some(item => !ParameterTools.equalValue(item.value, from[item.name]))
    )
      captureComparison();
    const commit = window.shaderStudio?.beginParameterChange?.(names) || (() => {}),
      key = comparisonKey();
    // 프리셋이 바꾸는 파라미터의 자동 재생(@anim)은 멈춘다(재생이 값을 덮어쓰지 않게).
    let stopped = false;
    for (const item of users) if (names.includes(item.name) && playing.delete(item.name)) stopped = true;
    if (stopped) syncPlayButtons();
    // 전환 도중의 값은 파라미터의 간격(step) 자릿수로 맞춘다: 숫자 칸 폭(간격 자릿수 기준)을 넘지 않아 잘리지 않고,
    // 슬라이더로 고를 수 있는 값만 지난다. 끝(t = 1)에는 프리셋 값 그대로.
    const places = new Map(
      users.map(item => {
        const step = String(item.options?.step ?? "");
        return [item.name, step.includes(".") ? Math.min(6, step.split(".")[1].length) : 3];
      })
    );
    const tidy = (name, value, t) => {
      if (t >= 1) return value;
      const round = v => (typeof v === "number" ? Number(v.toFixed(places.get(name) ?? 3)) : v);
      return Array.isArray(value) ? value.map(round) : round(value);
    };
    // 전환 중 값은 @anim 재생처럼 행이 등록한 갱신 함수로 바로 보여 준다. 바뀐 파라미터가 모두 그런 함수를 가졌으면
    // 목록 전체를 다시 그리지 않는다(0.5초마다 목록을 새로 만들어 깜빡이고 눌러 둔 곳을 잃던 것). 하나라도 없으면
    // (색 · 벡터 등) 이전처럼 updateStats가 목록을 다시 그려 값을 맞춘다.
    const write = t => {
      let live = true;
      for (const [name, value] of Presets.blend(result.applied, from, target, Presets.ease(t)))
        try {
          const next = tidy(name, value, t);
          renderer.setUniform(name, next);
          const view = playViews.get(name);
          if (view) view(next);
          else live = false;
          resetSyncs.get(name)?.(next);
          changeSyncs.get(name)?.(next);
        } catch (error) {
          console.warn(`프리셋 값 무시 (${name}):`, error.message);
        }
      if (live) ctx.syncSnapshot();
    };
    const finish = () => {
      commit();
      morph = 0;
      endMorphUi();
      presetNotice(summary);
      settings.save();
      renderUniforms();
      showPresetReport(preset, result, from);
    };
    const seconds = Number($("presetBlend").value) || 0;
    if (!seconds) {
      presetNotice(summary);
      write(1);
      return finish();
    }
    presetNotice(`'${preset.name}'(으)로 바꾸는 중 · ${seconds}초`);
    $("presetNoticeText").title = "값을 직접 만지면 전환이 그 자리에서 멈춥니다";
    morphState = {
      name: preset.name,
      commit,
      report: interrupted => showPresetReport(preset, result, from, interrupted),
      finish: () => {
        if (morph) cancelAnimationFrame(morph);
        write(1);
        finish();
      },
    };
    $("presetBar")?.classList?.add("is-morphing");
    if ($("presetFinish")) $("presetFinish").hidden = false;
    paintMorph(0);
    const start = performance.now();
    const tick = now => {
      if (key !== comparisonKey()) {
        stopMorph(true);
        renderUniforms();
        return;
      }
      const t = Math.min(1, (now - start) / (seconds * 1000));
      write(t);
      paintMorph(t);
      if (t < 1) morph = requestAnimationFrame(tick);
      else finish();
    };
    morph = requestAnimationFrame(tick);
  };
  // force: 프리셋 목록 자체가 바뀌었을 때. 값만 바뀌어 다시 그릴 때(@anim · 외부 변경)는 ⋯ 메뉴가 열려 있으면 그대로 둔다.
  const renderPresets = (force = false) => {
    if (presetMenu && !force) return;
    const list = $("presetList"),
      presets = settings.getPresets?.() || [],
      users = renderer.getUserUniforms();
    closePresetMenu();
    list.replaceChildren();
    $("presetSave").disabled = !users.length || presets.length >= Presets.MAX_PRESETS;
    $("presetSave").title = !users.length
      ? "저장할 파라미터가 없습니다"
      : presets.length >= Presets.MAX_PRESETS
        ? `프리셋은 최대 ${Presets.MAX_PRESETS}개입니다`
        : "지금 파라미터 값 전체를 이름 붙여 저장";
    // 파라미터가 없으면 프리셋 막대를 통째로 숨기고, 프리셋이 없으면 '프리셋 · 지금 값 저장' 한 줄로 줄인다(전환 시간은 고를 칩이 있을 때만).
    const bar = $("presetBar");
    if (bar) {
      bar.hidden = !users.length && !presets.length;
      bar.classList?.toggle("is-empty", !presets.length);
    }
    if (!presets.length) {
      const empty = element("span");
      empty.className = "preset-empty";
      empty.textContent = "저장한 프리셋이 없습니다";
      list.append(empty);
      return;
    }
    presets.forEach((preset, index) => {
      const chip = element("div"),
        apply = element("button"),
        more = element("button");
      chip.className = "preset-chip";
      chip.setAttribute("role", "listitem");
      apply.type = more.type = "button";
      apply.className = "preset-apply";
      apply.textContent = preset.name;
      apply.setAttribute("aria-pressed", String(matchesPreset(preset, users)));
      const compatible = Presets.plan(users, preset, settings.getLinks?.() || []);
      apply.title = `적용 가능 ${compatible.applied.length}개 · 건너뜀 ${compatible.skipped.length}개`;
      apply.addEventListener("click", () => applyPreset(preset));
      apply.addEventListener("dblclick", () => renamePreset(index));
      more.className = "preset-more glyph-icon icon-more";
      more.title = `'${preset.name}' 관리: 덮어쓰기 · 이름 바꾸기 · 삭제`;
      more.setAttribute("aria-label", more.title);
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.addEventListener("click", () => openPresetMenu(more, index));
      chip.append(apply, more);
      list.append(chip);
    });
  };
  // 프리셋 칩 우클릭: 적용 + 칩의 ⋯ 메뉴와 같은 관리 항목
  ContextMenu.register(
    "#presetList .preset-chip",
    chip => {
      const index = [...$("presetList").querySelectorAll(".preset-chip")].indexOf(chip),
        preset = settings.getPresets()[index];
      if (!preset || ctx.viewingA) return null;
      const same = !presetChanges(preset, renderer.getUserUniforms()).length;
      return {
        label: `'${preset.name}' 프리셋`,
        items: [
          { title: preset.name },
          { label: "적용", icon: "play", onSelect: () => applyPreset(preset) },
          { separator: true },
          {
            label: "지금 값으로 덮어쓰기…",
            disabled: same,
            title: same ? "지금 값과 같습니다" : "바뀌는 값을 확인한 뒤 덮어씁니다",
            onSelect: () => overwritePreset(index),
          },
          { label: "이름 바꾸기…", icon: "edit", onSelect: () => renamePreset(index) },
          { label: "삭제", icon: "trash", danger: true, onSelect: () => removePreset(index) },
        ],
      };
    },
    { signal }
  );
  listen($("presetSave"), "click", async () => {
    stopMorph();
    const presets = settings.getPresets(),
      names = presets.map(item => item.name);
    let n = presets.length + 1;
    while (names.includes(`프리셋 ${n}`)) n++;
    // 이름을 묻지 않고 바로 저장한다(한 번에 끝). 이름은 칩을 두 번 누르거나 ⋯에서 바꾼다.
    const name = `프리셋 ${n}`;
    attempt(() => {
      settings.setPresets([...presets, Presets.capture(name, renderer.getUserUniforms())]);
      presetNotice(`'${name}' 저장 · 이름은 칩을 두 번 눌러 바꿉니다`, presets);
    });
  });
  if ($("presetFinish")) listen($("presetFinish"), "click", () => morphState?.finish());
  listen($("presetUndo"), "click", () => {
    if (!presetRestore) return;
    const previous = presetRestore;
    attempt(() => {
      settings.setPresets(previous);
      presetNotice("프리셋을 바로 전으로 되돌렸습니다");
    });
  });
  // 프리셋 알림 · 적용 내역의 생명주기: 프리셋 목록이 바뀌면(예제 · 프로젝트 교체 · Undo · 저장 · 이름 · 삭제) 지난 알림을 지운다.
  // 저장 · 이름 바꾸기 · 삭제 · 되돌리기는 setPresets 다음에 자기 알림을 다시 쓰므로 그 알림은 남는다.
  listen(document, "shader-presets-changed", () => {
    stopMorph();
    clearPresetReport();
    presetNotice("");
    renderPresets(true);
  });
  listen(document, "shader-before-history", () => stopMorph());
  listen(document, "shader-before-parameter-change", () => stopMorph());
  listen(document, "shader-before-apply", () => {
    stopMorph();
    clearPresetReport();
  });
  return { presetNotice, clearPresetReport, closePresetMenu, stopMorph, renderPresets };
};

export { create };
