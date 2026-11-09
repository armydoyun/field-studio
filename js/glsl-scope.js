// GLSL 범위(스코프) 분석: 이름 하나가 어느 선언을 가리키는지 찾는다. DOM·편집기와 무관한 순수 함수만 둔다.
// '같은 이름 바꾸기(F2)'가 실제 코드 편집기처럼 그 변수만 바꾸도록 쓰고, '정의로 이동'도 같은 결과를 쓴다.
//
// 다루는 범위
//   · 전역 · { } 블록 · 함수 매개변수(본문까지) · for (int i …)의 초기화(반복 본문까지, 중괄호 없는 본문 포함)
//   · 선언: [한정어] 타입 이름 [배열] [= 식] [, 이름 …]   (타입 = 내장 타입 또는 앞서 선언한 struct)
//   · 함수 정의·선언(같은 이름은 오버로드 묶음으로 본다) · struct 이름 · struct 필드(바꾸지 않음)
// 하지 않는 것(정확히 알 수 없어 이유와 함께 거절하거나 경고한다)
//   · '.' 뒤의 이름(구조체 필드·스위즐)은 앞 식의 타입을 따라가야 하므로 참조로 치지 않는다.
//   · #define 매크로 본문은 글자를 그대로 끼워 넣는 것이라 범위가 없다. 매크로 이름은 파일 전체에서 바꾸고,
//     바꿀 이름이 매크로 본문에 나오면 경고만 한다. #ifdef로 갈라진 코드는 양쪽을 모두 코드로 본다.
//   · 괄호 짝이 맞지 않으면(작성 중인 코드) 분석을 믿을 수 없다고 알린다(ok: false, reason: "braces").

const KEYWORDS = new Set(
  "if else for while do break continue return discard switch case default struct const uniform in out inout layout precision highp mediump lowp true false flat smooth centroid invariant".split(
    " "
  )
);
const TYPES = new Set(
  "void bool int uint float vec2 vec3 vec4 bvec2 bvec3 bvec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 sampler2D isampler2D usampler2D samplerCube sampler3D sampler2DArray isampler3D usampler3D sampler2DShadow samplerCubeShadow sampler2DArrayShadow".split(
    " "
  )
);
const QUALIFIERS = new Set("const uniform in out inout highp mediump lowp flat smooth centroid invariant".split(" "));

// 주석·문자열을 같은 길이 공백으로 지운다(위치 보존). keepDirectives가 false면 전처리문(#…)도 지운다.
const blank = s => s.replace(/[^\n]/g, " ");
const cleanCode = (src, keepDirectives = false) =>
  src.replace(/^[ \t]*#(?:[^\n]*\\\r?\n)*[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\])*"/gm, s =>
    keepDirectives && /^[ \t]*#/.test(s) ? s.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/g, blank) : blank(s)
  );

const TOKEN =
  /[A-Za-z_]\w*|0[xX][0-9a-fA-F]+[uU]?|\d+\.?\d*(?:[eE][+-]?\d+)?[uUfF]?|\.\d+(?:[eE][+-]?\d+)?[fF]?|[^\s\w]/g;
const tokenize = text => [...text.matchAll(TOKEN)].map(m => ({ v: m[0], at: m.index, id: /^[A-Za-z_]/.test(m[0]) }));

// 소스를 분석한다. 같은 소스면 다시 계산하지 않는다(편집기는 한 동작에서 여러 번 부른다).
let cache = { src: null };
const analyze = src => {
  if (cache.src === src) return cache.result;
  const clean = cleanCode(src),
    tokens = tokenize(clean);
  const scopes = [{ id: 0, parent: -1, depth: 0, fn: null }],
    decls = [],
    refs = [],
    declAt = new Set(),
    structNames = new Set();
  let cur = 0,
    paren = 0,
    balanced = true,
    nextParenIsFunction = null;
  const frames = []; // {kind:"block"|"header", scope, state?:"paren"|"after"|"body", level?, header?}
  const openScope = fn => {
    const parent = scopes[cur];
    scopes.push({ id: scopes.length, parent: cur, depth: parent.depth + 1, fn: fn ?? parent.fn });
    return (cur = scopes.length - 1);
  };
  const closeScope = scope => {
    cur = scopes[scope].parent;
  };
  const isType = v => TYPES.has(v) || structNames.has(v);
  const isName = t => t?.id && !KEYWORDS.has(t.v) && !TYPES.has(t.v);
  const declare = (token, kind, extra = {}) => {
    declAt.add(token.at);
    decls.push({ name: token.v, at: token.at, kind, scope: extra.scope ?? cur, ...extra });
  };
  // 한정어(uniform 등)를 앞으로 거슬러 읽는다. layout(…)도 건너뛴다.
  const qualifiersBefore = i => {
    const found = new Set();
    for (let j = i - 1; j >= 0; j--) {
      const t = tokens[j].v;
      if (QUALIFIERS.has(t)) found.add(t);
      else if (t === ")") {
        let depth = 0,
          k = j;
        for (; k >= 0; k--) {
          if (tokens[k].v === ")") depth++;
          else if (tokens[k].v === "(" && !--depth) break;
        }
        if (tokens[k - 1]?.v !== "layout") break;
        j = k - 1;
      } else break;
    }
    return found;
  };
  // 선언 목록의 쉼표 뒤 이름들: float a = f(x, y), b[2], c;
  const moreDeclarators = (from, kind, extra) => {
    let depth = 0;
    for (let j = from; j < tokens.length; j++) {
      const t = tokens[j].v;
      if (t === "(" || t === "[") depth++;
      else if (t === ")" || t === "]") {
        if (--depth < 0) return;
      } else if (t === ";" || t === "{" || t === "}") return;
      else if (t === "," && !depth && isName(tokens[j + 1]) && !isType(tokens[j + 1].v))
        declare(tokens[j + 1], kind, extra);
    }
  };
  const skipBrackets = j => {
    while (tokens[j]?.v === "[") {
      let depth = 0;
      for (; j < tokens.length; j++) {
        if (tokens[j].v === "[") depth++;
        else if (tokens[j].v === "]" && !--depth) break;
      }
      j++;
    }
    return j;
  };
  // 중괄호 없는 for 본문이 끝나면(;) 또는 본문 블록이 닫히면 머리 범위(for · 함수)를 닫는다.
  const closeFinishedHeaders = () => {
    while (frames.length && frames.at(-1).kind === "header" && frames.at(-1).state === "after") {
      const header = frames.pop();
      closeScope(header.scope);
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i],
      v = token.v,
      top = frames.at(-1);
    if (v === "{") {
      if (top?.kind === "header" && top.state === "after") {
        top.state = "body";
        frames.push({ kind: "block", scope: openScope(), header: top });
      } else frames.push({ kind: "block", scope: openScope() });
    } else if (v === "}") {
      const block = frames.at(-1);
      if (block?.kind !== "block") {
        balanced = false;
        continue;
      }
      frames.pop();
      closeScope(block.scope);
      if (block.header) {
        frames.pop();
        closeScope(block.header.scope);
        closeFinishedHeaders(); // for (…) for (…) { … } 처럼 중괄호 없는 바깥 for의 본문이 이 블록이었다
      }
    } else if (v === "(") {
      paren++;
      if (tokens[i - 1]?.v === "for" || nextParenIsFunction) {
        const fn = nextParenIsFunction;
        nextParenIsFunction = null;
        frames.push({ kind: "header", scope: openScope(fn), state: "paren", level: paren, function: !!fn });
      }
    } else if (v === ")") {
      if (top?.kind === "header" && top.state === "paren" && top.level === paren) top.state = "after";
      paren--;
    } else if (v === ";") {
      if (top?.kind === "header" && top.state === "after" && paren === top.level - 1) closeFinishedHeaders();
    } else if (v === "struct" && isName(tokens[i + 1])) {
      // struct 이름 { 필드 … } [변수 …];
      const name = tokens[i + 1];
      declare(name, "struct");
      structNames.add(name.v);
      let j = i + 2;
      if (tokens[j]?.v === "{") {
        for (j++; j < tokens.length && tokens[j].v !== "}"; j++) {
          const t = tokens[j];
          if (!t.id) continue;
          if (structNames.has(t.v) && t.v !== name.v) refs.push({ name: t.v, at: t.at, scope: cur });
          else if (isName(t) && !isType(t.v) && (isType(tokens[j - 1].v) || tokens[j - 1].v === ","))
            declare(t, "field", { struct: name.v, scope: -1 });
        }
        if (tokens[j]?.v !== "}") balanced = false;
        for (let k = j + 1; k < tokens.length && tokens[k].v !== ";"; k++)
          if (isName(tokens[k]) && (tokens[k - 1].v === "}" || tokens[k - 1].v === ","))
            declare(tokens[k], "var", { type: name.v, uniform: false, global: cur === 0 });
        i = j;
      } else i++;
    } else if (token.id && isType(v) && tokens[i - 1]?.v !== ".") {
      // 타입 다음에 이름이 오면 선언. 타입이 struct면 그 이름은 struct를 가리키는 참조이기도 하다.
      if (structNames.has(v)) refs.push({ name: v, at: token.at, scope: cur });
      const j = skipBrackets(i + 1),
        name = tokens[j];
      if (!isName(name) || isType(name.v)) continue;
      const after = tokens[skipBrackets(j + 1)];
      if (after?.v === "(" && cur === 0) {
        declare(name, "function", { type: v, scope: 0 });
        nextParenIsFunction = name.v;
      } else {
        const inHeader = top?.kind === "header" && top.state === "paren",
          kind = inHeader && top.function ? "param" : "var",
          qualifiers = qualifiersBefore(i),
          extra = { type: v, uniform: qualifiers.has("uniform"), global: cur === 0 };
        declare(name, kind, extra);
        moreDeclarators(j + 1, kind, extra);
      }
      i = j; // 선언한 이름은 참조로 세지 않는다(아래 declAt 검사로도 막힌다)
    } else if (token.id && !KEYWORDS.has(v) && !TYPES.has(v) && !declAt.has(token.at)) {
      refs.push({ name: v, at: token.at, scope: cur, member: tokens[i - 1]?.v === "." });
    }
  }
  if (frames.some(frame => frame.kind === "block") || paren !== 0) balanced = false;
  const result = { src, clean, scopes, decls, refs, balanced };
  cache = { src, result };
  return result;
};

// scope에서 바깥으로 올라가며 name의 선언을 찾는다(at보다 앞에 선언된 것만). 함수는 같은 이름 전체(오버로드 묶음).
const chain = (scopes, scope) => {
  const list = [];
  for (let s = scope; s >= 0; s = scopes[s].parent) list.push(s);
  return list;
};
const resolve = (info, name, at, scope) => {
  for (const s of chain(info.scopes, scope)) {
    const found = info.decls.filter(d => d.scope === s && d.name === name && d.at <= at && d.kind !== "field");
    if (found.length) return found.at(-1);
  }
  // 함수는 정의보다 앞에서 불러도(원형 없이) 같은 패스의 함수로 본다(컴파일러가 따로 알려 준다).
  return info.decls.find(d => d.kind === "function" && d.name === name) || null;
};
// 한 기호(선언 묶음)를 가리키는 선언과 참조 위치들.
const occurrences = (info, symbol) => {
  const group =
    symbol.kind === "function" ? info.decls.filter(d => d.kind === "function" && d.name === symbol.name) : [symbol];
  const spots = new Set(group.map(d => d.at));
  for (const ref of info.refs) {
    if (ref.member || ref.name !== symbol.name) continue;
    const target = resolve(info, ref.name, ref.at, ref.scope);
    if (target && group.includes(target)) spots.add(ref.at);
  }
  return { group, spots: [...spots].sort((a, b) => a - b) };
};

// 커서 위치(pos)의 이름이 가리키는 기호. {symbol} 또는 {reason}
//   reason: "none"(이름 아님) · "field"(구조체 필드·스위즐) · "undeclared"(내장 이름 또는 이 패스에 선언 없음) · "macro" · "braces"
const symbolAt = (src, pos, { macros = [] } = {}) => {
  const info = analyze(src);
  const word = (() => {
    let a = pos,
      b = pos;
    while (a > 0 && /\w/.test(src[a - 1])) a--;
    while (b < src.length && /\w/.test(src[b])) b++;
    const text = src.slice(a, b);
    return /^[A-Za-z_]\w*$/.test(text) ? { text, at: a } : null;
  })();
  if (!word || KEYWORDS.has(word.text) || TYPES.has(word.text)) return { info, reason: "none" };
  if (macros.includes(word.text)) return { info, word, reason: "macro" };
  if (!info.balanced) return { info, word, reason: "braces" };
  const decl = info.decls.find(d => d.at === word.at);
  if (decl) return decl.kind === "field" ? { info, word, reason: "field" } : { info, word, symbol: decl };
  const ref = info.refs.find(r => r.at === word.at);
  if (!ref) return { info, word, reason: "none" };
  if (ref.member) return { info, word, reason: "field" };
  const symbol = resolve(info, ref.name, ref.at, ref.scope);
  return symbol ? { info, word, symbol } : { info, word, reason: "undeclared" };
};

const lineOf = (src, at) => src.slice(0, at).split("\n").length;
// 사람이 읽는 기호 설명: "main 함수의 지역 변수" · "전역 Uniform" · "함수 (오버로드 2개)" …
const describe = (info, symbol, group) => {
  if (symbol.kind === "function") return group.length > 1 ? `함수 (오버로드 ${group.length}개 모두)` : "함수";
  if (symbol.kind === "struct") return "구조체 타입";
  const fn = info.scopes[symbol.scope]?.fn;
  if (symbol.kind === "param") return `${fn} 함수의 매개변수`;
  if (symbol.global) return symbol.uniform ? "전역 Uniform" : "전역 변수";
  return fn ? `${fn} 함수의 지역 변수` : "지역 변수";
};

// 이름 바꾸기 계획. 바꿀 위치·설명·경고를 돌려주고 소스는 바꾸지 않는다.
//   {ok:true, symbol, kind, label, spots:[위치], lines:[줄], conflicts:[문장], warnings:[문장]}
//   {ok:false, reason, word}
const planRename = (src, pos, next, { macros = [] } = {}) => {
  const found = symbolAt(src, pos, { macros });
  if (!found.symbol) return { ok: false, reason: found.reason, word: found.word?.text };
  const { info, symbol } = found,
    { group, spots } = occurrences(info, symbol);
  const result = {
    ok: true,
    symbol,
    word: symbol.name,
    kind: symbol.kind,
    label: describe(info, symbol, group),
    spots,
    lines: [...new Set(spots.map(at => lineOf(src, at)))],
    conflicts: [],
    warnings: [],
  };
  if (next && next !== symbol.name) {
    const where = at => `${lineOf(src, at)}번째 줄`;
    // ① 같은 범위에 이미 있는 이름
    for (const d of group) {
      const clash = info.decls.find(
        other => other.scope === d.scope && other.name === next && other.kind !== "field" && !group.includes(other)
      );
      if (clash) result.conflicts.push(`같은 범위에 이미 '${next}'이(가) 있습니다(${where(clash.at)}).`);
    }
    // ② 바뀐 이름이 안쪽의 다른 '${next}' 선언에 가려진다
    const depth = d => info.scopes[d.scope]?.depth ?? 0,
      home = Math.max(...group.map(depth));
    const hidden = info.refs.filter(r => {
      if (r.member || !spots.includes(r.at)) return false;
      const other = resolve(info, next, r.at, r.scope);
      return other && !group.includes(other) && other.kind !== "function" && depth(other) > home;
    });
    if (hidden.length)
      result.conflicts.push(
        `바꾼 뒤 ${hidden.length}곳(${hidden.map(r => where(r.at)).join(", ")})이 안쪽의 다른 '${next}'을(를) 가리키게 됩니다.`
      );
    // ③ 기존 '${next}' 참조가 바뀐 선언을 가리키게 된다
    const captured = info.refs.filter(r => {
      if (r.member || r.name !== next) return false;
      const now = resolve(info, next, r.at, r.scope),
        scopesOfR = chain(info.scopes, r.scope);
      return group.some(
        d =>
          d.kind !== "function" &&
          scopesOfR.includes(d.scope) &&
          d.at <= r.at &&
          (!now || (now.kind !== "function" && depth(d) > depth(now)))
      );
    });
    if (captured.length)
      result.conflicts.push(
        `지금 '${next}'을(를) 쓰는 ${captured.length}곳(${captured.map(r => where(r.at)).join(", ")})이 바꾼 이름을 가리키게 됩니다.`
      );
  }
  // 매크로 본문에 나오는 같은 이름은 범위를 알 수 없어 바꾸지 않는다.
  const word = new RegExp(`\\b${symbol.name}\\b`, "g"),
    inMacros = cleanCode(src, true)
      .split("\n")
      .filter(line => /^[ \t]*#\s*define\b/.test(line))
      .flatMap(line => [...line.replace(/^[ \t]*#\s*define\s+\w+/, "").matchAll(word)]);
  if (inMacros.length)
    result.warnings.push(
      `#define 매크로 안의 '${symbol.name}' ${inMacros.length}곳은 범위를 알 수 없어 바꾸지 않습니다.`
    );
  return result;
};

// 이름(name)의 전역 선언을 찾아 그 기호의 계획을 만든다(다른 패스의 같은 Uniform을 바꿀 때).
const planGlobal = (src, name, next) => {
  const info = analyze(src),
    decl = info.decls.find(d => d.scope === 0 && d.name === name && d.kind === "var");
  return decl ? planRename(src, decl.at, next) : null;
};

// 계획대로 바꾼 소스.
const applyRename = (src, spots, from, to) => {
  let out = src;
  for (const at of [...spots].sort((a, b) => b - a)) out = out.slice(0, at) + to + out.slice(at + from.length);
  return out;
};

// 매크로 이름 바꾸기: 주석·문자열 밖의 같은 단어 전부(#define 줄 포함, '.' 뒤 제외).
const macroSpots = (src, name) => {
  const text = cleanCode(src, true);
  return [...text.matchAll(new RegExp(`\\b${name}\\b`, "g"))]
    .map(m => m.index)
    .filter(at => !/\.\s*$/.test(text.slice(Math.max(0, at - 64), at)));
};

export {
  KEYWORDS,
  TYPES,
  cleanCode,
  analyze,
  resolve,
  symbolAt,
  planRename,
  planGlobal,
  applyRename,
  macroSpots,
  lineOf,
};
