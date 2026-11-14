// 실제 앱 개발자 콘솔에 붙여 넣어 실행(npm test가 browser 묶음에서 자동 실행).
// 간격 규칙(docs/DESIGN_SYSTEM.md '간격 규칙')을 화면에서 잰다 — 사소한 붙음을 사람이 눈으로 찾지 않아도 되게.
//  · 조작(버튼 · 칸 · 세그먼트)과 선 사이는 4px 이상, 구역을 나누는 선(패널 구역 · 머리 · 바닥 · 대화상자 머리/바닥)과는 8px 이상
//  · 조작은 잘리는 가장자리(overflow)에 3px 안으로 붙지 않는다(초점 링이 잘린다)
//  · 글자는 그것을 두른 테두리에 4px 안으로 붙지 않는다
// 설정 패널 네 탭 · 연결 시트 · 타임라인 · 추가 폼 · 프로젝트 메뉴 · 편집기(버퍼 설정 · 입력 채널) · 대화상자(입력 · 영상 렌더링 · 갤러리 · 가이드)에서 잰다.
(async () => {
  const studio = window.shaderStudio, r = window.shaderPlayground, $ = id => document.getElementById(id);
  const test = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return; throw new Error(`FAIL: 시간 초과 — ${label}`); };
  const spacingAudit = () => {
    const visible = el => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false; for (let p = el; p; p = p.parentElement) { if (p.hidden) return false; if (p.tagName === "DIALOG" && !p.open) return false; if (p.tagName === "DETAILS" && !p.open && !el.closest("summary")) return false; } return true; };
    const GROUP = ".ui-seg,.ui-tabs,.ui-btn-group,.preset-chip,.ui-input-group,.ui-search";
    // 그림에 가까운 조작 · 줄 전체가 버튼인 것 · 자기 테두리 안에서 자리를 잡는 것은 검사하지 않는다
    const SKIP = ".cm-editor,.ui-menu,.studio-palette,.timeline-body,.guide-nav,.gallery-grid,.gallery-start,.studio-graph,.profile-buffers,.guide-tour,.uniform-ramp-track,.uniform-group-head,.dock-grip,.panel-backdrop,.ui-resizer";
    const SECTION = ".ui-section,.panel-header,.panel-footer,.panel-scroll,.ui-dialog-head--bar,.ui-dialog-foot,.gallery-foot";
    const name = el => { let s = el.tagName.toLowerCase(); if (el.id) s += "#" + el.id; const c = [...el.classList].filter(x => !/^(glyph-icon|icon-|is-)/.test(x)).slice(0, 3).join("."); if (c) s += "." + c; return s; };
    const layer = el => el.closest("dialog[open],.ui-popover") || document.body;
    const modal = [...document.querySelectorAll("dialog[open]")].find(d => d.matches(":modal"));
    const scroller = el => { for (let p = el.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if ((/auto|scroll/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) || (/auto|scroll/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1)) return p; } return null; };
    const controls = new Set();
    for (const el of document.querySelectorAll("button,input:not([type=hidden]):not([type=file]),select,summary.ui-btn,.ui-seg,.ui-tabs,.ui-btn-group,.preset-chip,.ui-input-group,.ui-search")) {
      if (!visible(el) || el.closest(SKIP) || (modal && !modal.contains(el))) continue;
      const target = el.matches(GROUP) ? el : el.closest(GROUP) || el;
      if (target.parentElement?.closest(GROUP)) continue;
      const r = target.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(target.contains(hit) || hit.contains(target))) continue; // 다른 것에 가려 있다
      controls.add(target);
    }
    const lines = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!visible(el) || (modal && !modal.contains(el))) continue;
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      const solid = side => parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== "none" && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(cs[`border${side}Color`]);
      if (solid("Top")) lines.push({ el, h: true, at: r.top, a: r.left, b: r.right });
      if (solid("Bottom")) lines.push({ el, h: true, at: r.bottom, a: r.left, b: r.right });
      if (solid("Left")) lines.push({ el, h: false, at: r.left, a: r.top, b: r.bottom });
      if (solid("Right")) lines.push({ el, h: false, at: r.right, a: r.top, b: r.bottom });
      if (/hidden|auto|scroll|clip/.test(cs.overflowY) && el.scrollHeight <= el.clientHeight + 1) { lines.push({ el, h: true, at: r.top, a: r.left, b: r.right, clip: true }); lines.push({ el, h: true, at: r.bottom, a: r.left, b: r.right, clip: true }); }
      if (/hidden|auto|scroll|clip/.test(cs.overflowX) && el.scrollWidth <= el.clientWidth + 1) { lines.push({ el, h: false, at: r.left, a: r.top, b: r.bottom, clip: true }); lines.push({ el, h: false, at: r.right, a: r.top, b: r.bottom, clip: true }); }
    }
    const out = new Map();
    for (const c of controls) {
      const r = c.getBoundingClientRect(), box = scroller(c);
      for (const line of lines) {
        if (line.el === c || c.contains(line.el)) continue;
        if (line.clip && !line.el.contains(c)) continue;
        if (layer(line.el) !== layer(c)) continue;                         // 다른 층(팝오버 · 대화상자)과는 겹칠 수 있다
        if (box && !box.contains(line.el)) continue;                         // 스크롤로 지나가는 사이
        const other = scroller(line.el); if (other && !other.contains(c)) continue;
        const [lo, hi, e1, e2] = line.h ? [r.left, r.right, r.top, r.bottom] : [r.top, r.bottom, r.left, r.right];
        if (Math.min(hi, line.b) - Math.max(lo, line.a) < 4) continue;
        if (line.at > e1 + 1 && line.at < e2 - 1) continue;
        const d = Math.min(Math.abs(e1 - line.at), Math.abs(e2 - line.at));
        const min = line.clip ? 3 : line.el.matches(SECTION) && line.h ? 8 : 4;
        if (d >= min - 0.01) continue;
        if (!line.clip) { // 선이 실제로 보이는가(조상이 잘라 낸 요소의 선은 뺀다)
          const mid = (Math.max(lo, line.a) + Math.min(hi, line.b)) / 2, inset = line.at === (line.h ? line.el.getBoundingClientRect().top : line.el.getBoundingClientRect().left) ? 0.5 : -0.5;
          const seen = line.h ? document.elementFromPoint(mid, line.at + inset) : document.elementFromPoint(line.at + inset, mid);
          if (!seen || !(line.el.contains(seen) || seen.contains(line.el))) continue;
        }
        const key = `${name(c)} ↔ ${name(line.el)} ${line.clip ? "잘림" : "선"}${line.h ? "(가로)" : "(세로)"} · 최소 ${min}px`;
        if (!out.has(key) || out.get(key) > d) out.set(key, Math.round(d * 10) / 10);
      }
    }
    return [...out].map(([k, d]) => `${d}px  ${k}`).sort();
  };

  // 글자가 선에 붙었는지: 글자를 직접 담은 요소(조작 · 꼬리표 안은 제외)와 그 조상의 테두리 사이가 4px 미만이면 보고한다.
  const textAudit = () => {
    const out = new Map();
    const name = el => { let s = el.tagName.toLowerCase(); if (el.id) s += "#" + el.id; const c = [...el.classList].slice(0, 2).join("."); if (c) s += "." + c; return s; };
    const modal = [...document.querySelectorAll("dialog[open]")].find(d => d.matches(":modal"));
    const walker = document.createTreeWalker(modal || document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue.trim()) continue;
      const el = node.parentElement;
      if (!el || el.closest("button,select,option,input,kbd,.ui-tag,.ui-chip,.ui-count,.cm-editor,code,pre,summary,.timeline-body,.gallery-grid,.guide-nav,.ui-unit,script,style,[hidden],.guide-keycode-status,th,td,.gallery-perf,.chip-badge")) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const r = range.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
      const cs0 = getComputedStyle(el); if (cs0.visibility === "hidden") continue;
      const hit = document.elementFromPoint(r.left + Math.min(4, r.width / 2), r.top + r.height / 2); if (!hit || !(el.contains(hit) || hit.contains(el))) continue;
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p), b = p.getBoundingClientRect();
        const side = (n, d) => { if (parseFloat(cs[`border${n}Width`]) > 0 && cs[`border${n}Style`] !== "none" && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(cs[`border${n}Color`]) && d >= -1 && d < 4) { const k = `${name(el)} "${node.nodeValue.trim().slice(0, 14)}" ↔ ${name(p)} ${n}`; if (!out.has(k)) out.set(k, Math.round(d * 10) / 10); } };
        side("Top", r.top - b.top); side("Bottom", b.bottom - r.bottom); side("Left", r.left - b.left); side("Right", b.right - r.right);
        if (/auto|scroll|hidden/.test(cs.overflowY + cs.overflowX)) break;
      }
    }
    return [...out].map(([k, d]) => `${d}px  ${k}`).sort();
  };
  const audit = async label => {
    await wait(120);
    const found = [...spacingAudit(), ...textAudit().map(line => `글자 ${line}`)];
    test(found.length === 0, `${label}: 붙은 곳 없음${found.length ? "\n    " + found.join("\n    ") : ""}`);
  };
  const image = [
    "uniform float uGain;      // 밝기 · @range 0 2 @default 0.8",
    "uniform vec2 uOffset;     // 위치 · @range -1 1",
    "uniform vec3 uTint;       // 색조 · @color @default 0.3 0.6 1.0",
    "uniform vec3 uLight;      // 조명 방향 · @dir",
    "uniform int uMode;        // 보기 · @enum 결과 밀도 투과율",
    "uniform float uSeed;      // @seed",
    "uniform sampler2D uRamp;  // 그라데이션 · @gradient",
    "uniform float uFog;       // 안개 · @range 0 1 @group 분위기",
    "uniform mat3 uMatrix;     // 변환 · @default 1",
    "void mainImage(out vec4 c, in vec2 p) {",
    "  vec3 col = texture(uRamp, p / iResolution.xy).rgb * uTint * uGain + uFog + uSeed * 0.0;",
    "  c = vec4(col + vec3(uOffset, 0.0) + normalize(uLight + 0.001) * 0.05 + float(uMode) * 0.02, 1.0);",
    "}",
  ].join("\n");
  test(studio.setProject({ image, passes: [], imageChannels: {} }), "파라미터가 있는 프로젝트");
  await until(() => r.getUserUniforms().length === 9, "파라미터 등록");
  if (document.body.classList.contains("panel-hidden")) $("panelToggle").click();

  // ---- 설정 패널 ----
  $("tab-uniforms").click();
  await audit("파라미터 탭");
  document.querySelector(".ui-matrix .ui-matrix-tools button").click();
  await audit("행렬 확대 편집");
  document.querySelector('dialog[aria-label="uMatrix 행렬 확대 편집"] .ui-icon-btn').click();
  document.querySelector(".link-uniform").click();
  await audit("연결 시트(끄기)");
  [...document.querySelectorAll('.link-sources [role="radio"]')].find(b => b.textContent.includes("흔들기")).click();
  await audit("연결 시트(흔들기)");
  [...document.querySelectorAll('.link-sources [role="radio"]')].find(b => b.textContent.includes("키프레임")).click();
  await wait(100);
  if ($("timelineDock").hidden) $("timelineToggle").click();
  await until(() => !$("timelineDock").hidden, "타임라인 열림");
  await audit("연결 시트(키프레임) + 타임라인");
  $("uniformEditor").open = true;
  await audit("파라미터 추가 폼");
  $("uniformEditor").open = false;
  for (const [tab, label] of [["tab-render", "렌더링 탭"], ["tab-profile", "성능 탭"], ["tab-input", "작업공간 탭"]]) {
    $(tab).click();
    await wait(tab === "tab-profile" ? 500 : 0);
    await audit(label);
  }
  $("timelineToggle").click();

  // ---- 뷰포트 · 편집기 ----
  $("projectMenuToggle").click();
  await audit("프로젝트 메뉴");
  $("projectMenuToggle").click();
  studio.open();
  await until(() => !$("studioDock").hidden, "편집기 열림");
  await audit("편집기");
  $("studioAdd").click();
  await until(() => !$("studioPassTools").hidden && document.querySelectorAll("#studioPassTabs button").length >= 2, "버퍼 추가");
  $("studioPassTools").open = true;
  if ($("studioInputs").hidden) $("studioInputsToggle").click();
  await audit("편집기: 버퍼 설정 + 입력 채널");
  $("studioPassTools").open = false;

  // ---- 대화상자 ----
  $("studioProjectSave").click();
  await until(() => $("studioPromptDialog").open, "입력 대화상자");
  await audit("입력 대화상자");
  $("studioDialogCancel").click();
  $("videoRenderOpen").click();
  await until(() => $("videoRenderDialog").open, "영상 렌더링 대화상자");
  await audit("영상 렌더링 대화상자");
  $("videoRenderCancel").click();
  $("galleryToggle").click();
  await until(() => $("gallery").open, "갤러리");
  await wait(400);
  await audit("갤러리");
  $("gallery").close();
  $("helpToggle").click();
  await until(() => $("quickHelp").open && $("guideNav").children.length > 3, "가이드");
  await audit("가이드");
  [...$("guideNav").querySelectorAll("button")].find(b => b.textContent.includes("코드 조각")).click();
  await wait(300);
  await audit("가이드: 코드 조각");
  $("quickHelp").close();
  console.log("간격 검사 통과");
})();
