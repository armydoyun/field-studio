// 여러 탭(Common · Image · 버퍼)에 걸친 이름 다루기와 편집기 값 표시 — 프로젝트를 받아 결과를 돌려주는 순수 함수.
// 편집기 · 상태 줄 · 되돌리기 기록은 studio.js가 다루고, 여기서는 '어디를 무엇으로'만 계산한다(범위 분석은 glsl-scope.js).
//   projectReferences(…) → 다른 탭에서 쓰인 곳(참조 찾기 Shift+F12)
//   sharedRename(…)      → Common 이름 바꾸기 계획(겹침 · 탭마다 바뀐 소스 · 커서 탭의 자리)
//   uniformRenameIn(…)   → 같은 Uniform을 다른 탭에서 바꾼 소스
//   uniformValues(users) → 편집기 줄 끝 값 표시(이름 → { text, color })
import * as Scope from "./glsl-scope.js";
import * as Color from "./color.js";

const COMMON = "Common";

// 소스가 전역에서 정의한 이름의 선언 · 쓰는 곳(변수 · 함수 · 구조체 · #define)
const globalSpotsOf = (src, name) => {
  const decl = Scope.analyze(src).decls.find(d => d.scope === 0 && d.name === name && d.kind !== "field");
  if (decl) return Scope.referencesAt(src, decl.at).spots || [];
  return Scope.definesGlobal(src, name)
    ? Scope.referencesAt(src, Scope.macroSpots(src, name)[0] ?? 0, { macros: [name] }).spots || []
    : [];
};
const declaresUniform = (src, name) =>
  Scope.analyze(src).decls.some(d => d.scope === 0 && d.name === name && d.uniform);

// 다른 탭에서 쓰인 곳. 여러 탭이 함께 쓰는 이름만:
//   · Common의 전역 이름(함수 · 변수 · 구조체 · #define · Uniform): Common의 선언 · 쓰는 곳과, 각 패스에서 그 이름을
//     스스로 선언하지 않고 쓰는 곳 · 패스의 Uniform: 같은 Uniform을 선언한 다른 패스(파라미터 하나를 나눠 쓴다)
//   code: 지금 탭의 편집 중 소스(project에는 아직 없을 수 있다)
//   → [{ tab, label, items: [{ at, line, text, decl }] }]. 함께 쓰는 이름이 아니면 [].
const projectReferences = ({ project, selected, code, tabs, name, pos, sourceOf, tabLabel }) => {
  const macro = Scope.definesGlobal(code, name) && !Scope.analyze(code).decls.some(d => d.name === name),
    found = Scope.symbolAt(code, pos, { macros: macro ? [name] : [] }),
    symbol = found.symbol,
    global = (symbol && symbol.scope === 0 && symbol.kind !== "field") || macro,
    hasCommon = typeof project.common === "string",
    commonDefines = hasCommon && Scope.definesGlobal(project.common, name),
    shared =
      (selected === COMMON && global) ||
      (selected !== COMMON && !global && found.reason === "undeclared" && commonDefines) ||
      (global && symbol?.uniform);
  if (!shared) return [];
  const uniform = symbol?.uniform || (commonDefines && declaresUniform(project.common, name));
  const groups = [];
  for (const tab of tabs) {
    if (tab === selected) continue;
    const src = sourceOf(project, tab) || "";
    let spots;
    if (Scope.definesGlobal(src, name)) {
      const own = Scope.analyze(src).decls.find(d => d.scope === 0 && d.name === name && d.kind === "var");
      // 이 탭이 스스로 선언한 이름: Common이거나, 같은 Uniform이면 함께 쓰는 것
      spots = tab === COMMON || (uniform && own?.uniform) ? globalSpotsOf(src, name) : [];
    } else spots = (Scope.externalSpots(src, name) || []).map(at => ({ at, decl: false }));
    if (!spots.length) continue;
    const rows = src.split("\n");
    groups.push({
      tab,
      label: tabLabel(tab),
      items: spots.map(spot => {
        const line = Scope.lineOf(src, spot.at);
        return { at: spot.at, line, text: rows[line - 1].trim(), decl: spot.decl };
      }),
    });
  }
  return groups;
};

// Common의 전역 이름 바꾸기 계획: Common의 선언 · 쓰는 곳과, 모든 패스에서 그 이름을 Common 것으로 쓰는 곳.
// macro: #define 이름이면 true(범위가 없어 같은 단어를 모두 — 그 이름을 스스로 #define한 패스는 빼고).
//   → { clash: 탭 } | null(Common에 그 이름이 없음) |
//     { sources: Map(탭 → 바뀐 소스), spots: Map(탭 → 바꾼 자리), passes, skipped: [탭], commonSpots }
const sharedRename = ({ project, tabs, from, to, macro = false, sourceOf }) => {
  const clash = tabs.find(name => Scope.definesGlobal(sourceOf(project, name), to));
  if (clash) return { clash };
  const commonSpots = macro
    ? Scope.macroSpots(project.common, from)
    : Scope.planShared(project.common, from, to)?.spots;
  if (!commonSpots?.length) return null;
  const sources = new Map(),
    spotsOf = new Map(),
    skipped = [];
  let passes = 0;
  for (const name of tabs) {
    const src = sourceOf(project, name);
    let spots;
    if (name === COMMON) spots = commonSpots;
    else if (macro) spots = Scope.definesGlobal(src, from) ? [] : Scope.macroSpots(src, from);
    else spots = Scope.definesGlobal(src, from) ? [] : Scope.externalSpots(src, from);
    if (spots === null) skipped.push(name); // 괄호 짝이 안 맞아(작성 중) 범위를 알 수 없음
    if (!spots?.length) continue;
    if (name !== COMMON) passes++;
    spotsOf.set(name, spots);
    sources.set(name, Scope.applyRename(src, spots, from, to));
  }
  return { sources, spots: spotsOf, passes, skipped, commonSpots };
};

// 같은 Uniform을 다른 탭에서 바꾼 소스(바꿀 곳이 없으면 null). commonUniform: Common이 선언한 Uniform이면
// 패스는 선언 없이 쓰므로(glsl-prepare가 Common 앞으로 모은다) 쓰는 곳만 바꾼다.
const uniformRenameIn = (source, from, to, commonUniform) => {
  const plan = Scope.planGlobal(source, from, to);
  const spots = plan?.ok && plan.symbol.uniform ? plan.spots : commonUniform ? Scope.externalSpots(source, from) : null;
  return spots?.length ? Scope.applyRename(source, spots, from, to) : null;
};

// 편집기 줄 끝에 보일 파라미터 현재 값: 이름 → { text, color? }. 그라데이션 · 곡선(sampler2D)은 글자로 줄일 수 없어 뺀다.
const shortNumber = (value, integer) =>
  integer ? String(Math.round(value)) : String(Number(Number(value).toFixed(3))).replace(/^(-?\d+)$/, "$1.0");
const uniformValueText = item => {
  const integer = /^(?:int|uint|[iu]vec\d)$/.test(item.type),
    value = item.value;
  if (item.type === "sampler2D") return null;
  if (item.type === "bool" || item.type.startsWith("bvec"))
    return Array.isArray(value) ? `(${value.map(v => String(!!v)).join(", ")})` : String(!!value);
  if (/^mat/.test(item.type)) return "행렬";
  if (Array.isArray(value) && value.some(Array.isArray)) return `[${value.length}개]`;
  if (Array.isArray(value)) {
    if (!/vec/.test(item.type)) return `[${value.length}개]`;
    return `(${value.map(v => shortNumber(v, integer)).join(", ")})`;
  }
  return typeof value === "number" ? shortNumber(value, integer) : null;
};
const uniformValues = users => {
  const out = new Map();
  for (const item of users) {
    const text = uniformValueText(item);
    if (text === null) continue;
    const color = item.options?.color && Array.isArray(item.value) ? Color.cssRgb(item.value.slice(0, 3)) : "";
    out.set(item.name, { text, color });
  }
  return out;
};

export { projectReferences, sharedRename, uniformRenameIn, uniformValues, uniformValueText };
