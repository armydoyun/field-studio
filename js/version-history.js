// 버전 기록 대화상자(index.html #versionDialog · 프로젝트 메뉴 '버전 기록…' · 명령 팔레트).
// 버전을 남기고 되돌리는 일은 studio.js(keepVersion · restoreVersion · listVersions), 저장은 version-store.js가 한다.
//  · 목록: 언제(방금 · 3분 전 · 어제 14:05) · 왜(실행 · 다른 작업을 열기 전 · 되돌리기 전 · 직접 남김) · 요약(코드 줄 수 · 버퍼 · 파라미터)
//  · 비교: 지금 작업과 탭(Common · Image · 버퍼)마다 줄 단위로(line-diff.js), 바뀐 곳만 앞뒤 2줄과 함께. 파라미터 값 차이도
//  · 이 탭만 되돌리기: 비교에서 탭 하나의 코드만 그 버전으로(편집기에서 고친 것처럼 Ctrl+Z 한 번)
//  · 되돌리기: 그 버전으로 작업 전체를 바꾼다(되돌리기 전 지금 작업도 버전으로 남고, Ctrl+Z 한 번으로 바로 전 작업)
//   mount({ studio }) → { open, dispose }
import * as UI from "./ui-kit.js";
import * as LineDiff from "./line-diff.js";

const MAX_DIFF_LINES = 400; // 비교에 그릴 줄 수 상한(아주 큰 변경도 대화상자가 멈추지 않게)

const relative = (time, now = Date.now()) => {
  const seconds = Math.round((now - time) / 1000),
    date = new Date(time),
    clock = date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  if (seconds < 45) return "방금";
  if (seconds < 3600) return `${Math.round(seconds / 60)}분 전`;
  const today = new Date(now).toDateString() === date.toDateString(),
    yesterday = new Date(now - 86400000).toDateString() === date.toDateString();
  if (today) return `오늘 ${clock}`;
  if (yesterday) return `어제 ${clock}`;
  return `${date.toLocaleDateString("ko-KR", { month: "long", day: "numeric" })} ${clock}`;
};
const tabsOf = project => [
  ...(project?.common ? [["Common", project.common]] : []),
  ["Image", project?.image || ""],
  ...(project?.passes || []).map(pass => [pass.name, pass.fragment || ""]),
];
const lineCount = text => (text ? text.split("\n").length : 0);
const summaryOf = version => {
  const tabs = tabsOf(version.project),
    lines = tabs.reduce((sum, [, code]) => sum + lineCount(code), 0),
    parts = [`코드 ${lines}줄`];
  if (version.project?.passes?.length) parts.push(`버퍼 ${version.project.passes.length}개`);
  if (version.users?.length) parts.push(`파라미터 ${version.users.length}개`);
  if (version.presets?.length) parts.push(`프리셋 ${version.presets.length}개`);
  return parts.join(" · ");
};
const TONE = { 실행: "", "직접 남김": "accent", "되돌리기 전": "warning", "다른 작업을 열기 전": "warning" };

const mount = ({ studio, renderer } = {}) => {
  const $ = id => document.getElementById(id),
    dialog = $("versionDialog");
  if (!dialog) return { open() {}, dispose() {} };
  const controller = new AbortController(),
    listen = (target, type, callback) => target?.addEventListener(type, callback, { signal: controller.signal });
  let comparing = null;
  const setSummary = text => ($("versionSummary").textContent = text);
  // 한 탭의 비교를 줄 요소로
  const diffLines = (before, after, budget, heading) => {
    const groups = LineDiff.hunks(LineDiff.diff(before, after));
    if (!groups.length) return { nodes: [], used: 0 };
    const nodes = [heading];
    let used = 0;
    for (const group of groups) {
      let beforeLine = group.beforeLine,
        afterLine = group.afterLine;
      const block = UI.el("div", "version-diff-hunk");
      for (const op of group.ops) {
        if (used >= budget) break;
        const row = UI.el("div", `version-diff-line is-${op.type}`),
          number = UI.el("span", "version-diff-no", op.type === "add" ? String(afterLine) : String(beforeLine)),
          mark = UI.el("span", "version-diff-mark", op.type === "add" ? "+" : op.type === "del" ? "−" : ""),
          text = UI.el("span", "version-diff-text", op.text || " ");
        row.append(number, mark, text);
        block.append(row);
        used++;
        if (op.type !== "add") beforeLine++;
        if (op.type !== "del") afterLine++;
      }
      nodes.push(block);
    }
    return { nodes, used };
  };
  // 탭 제목 줄: 두 쪽에 다 있는 탭이면 '이 탭만 되돌리기'(그 탭 코드만 그 버전으로 · 파라미터와 다른 탭은 그대로)
  const tabHeading = (version, name, title, both) => {
    const row = UI.el("div", "version-diff-head");
    row.append(UI.el("p", "version-diff-tab", title));
    if (both)
      row.append(
        UI.button({
          label: "이 탭만 되돌리기",
          size: "sm",
          variant: "ghost",
          className: "version-tab-restore",
          title: `${name} 탭의 코드만 이 버전으로 바꿉니다 · 파라미터와 다른 탭은 그대로 · Ctrl+Z로 되돌리기`,
          onClick: async () => {
            if (await studio.restoreTab?.(version.id, name)) dialog.close();
          },
        })
      );
    return row;
  };
  const compare = version => {
    comparing = comparing === version.id ? null : version.id;
    for (const button of $("versionList").querySelectorAll(".version-compare-button"))
      button.setAttribute("aria-pressed", String(button.dataset.id === comparing));
    const section = $("versionCompare"),
      out = $("versionDiff");
    section.hidden = !comparing;
    if (!comparing) return out.replaceChildren();
    const now = studio.getProject(),
      before = new Map(tabsOf(version.project)),
      after = new Map(tabsOf(now)),
      names = [...new Set([...before.keys(), ...after.keys()])];
    const nodes = [];
    let budget = MAX_DIFF_LINES,
      changedTabs = 0;
    for (const name of names) {
      const title = before.has(name) ? name : `${name} (그 버전에는 없음)`;
      const { nodes: tab, used } = diffLines(
        before.get(name) || "",
        after.get(name) || "",
        budget,
        tabHeading(version, name, title, before.has(name) && after.has(name))
      );
      if (tab.length) changedTabs++;
      nodes.push(...tab);
      budget -= used;
    }
    // 파라미터 값 차이(이름 · 그 버전 → 지금)
    const current = new Map((renderer?.getUserUniforms?.() || []).map(item => [item.name, item])),
      old = new Map((version.users || []).map(item => [item.name, item])),
      paramChanges = [...new Set([...old.keys(), ...current.keys()])].filter(
        name => JSON.stringify(old.get(name)?.value) !== JSON.stringify(current.get(name)?.value)
      );
    if (paramChanges.length) {
      nodes.push(tabHeading(version, "", `파라미터 값 ${paramChanges.length}개 다름`, false));
      nodes.push(
        UI.el(
          "p",
          "ui-hint version-diff-params",
          paramChanges.slice(0, 12).join(", ") + (paramChanges.length > 12 ? " …" : "")
        )
      );
    }
    $("versionCompareTitle").textContent = nodes.length
      ? `${relative(version.time)} 버전 → 지금 작업 (−: 그 버전에만 · +: 지금에만)`
      : `${relative(version.time)} 버전은 지금 작업과 같습니다`;
    if (budget <= 0) nodes.push(UI.hint("바뀐 곳이 많아 앞부분만 보여 줍니다.", "version-diff-more"));
    out.replaceChildren(...nodes);
    section.scrollIntoView?.({ block: "nearest" });
    return changedTabs;
  };
  const render = async () => {
    const versions = await studio.listVersions(),
      list = $("versionList");
    if (comparing && !versions.some(item => item.id === comparing)) comparing = null;
    setSummary(
      versions.length
        ? `이 작업의 버전 ${versions.length}개 · 실행에 성공할 때(1분에 한 번까지) · 다른 작업을 열기 전 · 되돌리기 전에 남깁니다. 이 브라우저에만 보관합니다.`
        : "아직 남긴 버전이 없습니다. 실행에 성공하면 자동으로 남고, 아래 '지금 버전 남기기'로 직접 남길 수도 있습니다."
    );
    list.replaceChildren(
      ...versions.map((version, index) => {
        const item = UI.el("div", "version-item"),
          info = UI.el("div", "version-info"),
          when = UI.el("span", "version-when", relative(version.time)),
          label = UI.tag(version.label || "실행", { tone: TONE[version.label] || "" }),
          detail = UI.el("span", "version-detail", summaryOf(version)),
          actions = UI.el("div", "version-actions");
        item.setAttribute("role", "listitem");
        when.title = new Date(version.time).toLocaleString("ko-KR");
        // 이름을 붙인 버전: 이름을 앞에 · '보관' 표시(자동 정리에서 빠진다)
        if (version.name) info.append(UI.el("strong", "version-name", version.name));
        info.append(when, label, detail);
        if (version.name) info.append(UI.tag("보관", { tone: "accent", pill: true }));
        if (index === 0) info.append(UI.tag("가장 최근", { plain: true }));
        const compareButton = UI.button({
          label: "비교",
          size: "sm",
          className: "version-compare-button",
          title: "지금 작업과 줄 단위로 비교",
          onClick: () => compare(version),
        });
        compareButton.dataset.id = version.id;
        compareButton.setAttribute("aria-pressed", String(comparing === version.id));
        const restore = UI.button({
          label: "이 버전으로",
          size: "sm",
          title: "작업 전체를 이 버전으로 바꿉니다 · 지금 작업도 버전으로 남고 Ctrl+Z로 돌아옵니다",
          onClick: async () => {
            restore.disabled = true;
            const ok = await studio.restoreVersion(version.id);
            restore.disabled = false;
            if (ok) dialog.close();
          },
        });
        const ask = window.shaderStudio?.ask;
        const rename = UI.button({
          label: version.name ? "이름 고치기…" : "이름 붙이기…",
          size: "sm",
          variant: "ghost",
          title: "이름을 붙이면 자동 정리(최근 40개)에서 빠져 계속 남습니다 · 비우면 이름을 뗍니다",
          onClick: async () => {
            const name = ask
              ? await ask({
                  title: "버전 이름",
                  message: "이름을 붙인 버전은 자동으로 지워지지 않고 계속 남습니다. 비워 두면 이름을 뗍니다.",
                  value: version.name || "",
                  label: "이름",
                  validate: text => (text.trim().length > 60 ? "60자 이하로 적으세요." : ""),
                })
              : null;
            if (name === null || name === undefined) return;
            await studio.nameVersion(version.id, name);
          },
        });
        const remove = UI.iconButton({
          icon: "trash",
          label: "이 버전 지우기",
          size: "sm",
          className: "ui-icon-btn--danger version-remove",
          onClick: async () => {
            const ok = ask
              ? await ask({
                  title: "버전 지우기",
                  message: `${relative(version.time)}${version.name ? ` '${version.name}'` : ""} 버전을 지웁니다. 되돌릴 수 없습니다.`,
                  ok: "지우기",
                  danger: true,
                })
              : true;
            if (ok) await studio.removeVersion(version.id);
          },
        });
        actions.append(compareButton, restore, rename, remove);
        item.append(info, actions);
        return item;
      })
    );
    if (!versions.length) list.append(UI.el("p", "ui-empty version-empty", "남긴 버전이 없습니다"));
    const still = comparing && versions.find(item => item.id === comparing);
    comparing = null;
    if (still) compare(still);
  };
  const open = () => {
    comparing = null;
    $("versionCompare").hidden = true;
    $("versionDiff").replaceChildren();
    if (!dialog.open) dialog.showModal();
    render();
  };
  listen($("versionOpen"), "click", () => {
    $("projectMenuToggle")?.getAttribute("aria-expanded") === "true" && $("projectMenuToggle").click();
    open();
  });
  listen($("versionClose"), "click", () => dialog.close());
  listen($("versionDone"), "click", () => dialog.close());
  listen($("versionKeep"), "click", async () => {
    const saved = await studio.keepVersion("직접 남김");
    await render();
    setSummary(saved ? "지금 작업을 버전으로 남겼습니다." : "마지막 버전과 같아 새로 남기지 않았습니다.");
  });
  listen(document, "shader-versions-changed", () => dialog.open && render());
  return {
    open,
    dispose: () => controller.abort(),
  };
};

export { mount, relative };
