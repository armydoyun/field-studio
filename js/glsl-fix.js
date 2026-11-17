// 컴파일 오류 빠른 수정: 자주 나는 GLSL 오류의 메시지(브라우저 WebGL · ANGLE 문구)와 코드 줄을 보고 고친 줄을 제안한다(순수 함수).
// 편집기(cm-editor.js)가 오류 표시의 '고치기' 버튼 · 오류 목록 · Ctrl+.로 보여 준다. 확실한 것만 제안한다 — 모르면 제안하지 않는다.
//  · float 계산에 정수 리터럴: uA * 2 → uA * 2.0 ('wrong operand types' · 'cannot convert from const int' · 내장 함수 인자)
//  · 정수 변수를 실수 자리에: float x = i → float(i) · 0.5 * i → 0.5 * float(i) · mod(i, 2.0) → mod(float(i), 2.0)
//    (이름이 int로 선언됐는지 범위 분석(glsl-scope.js)으로 확인한다) · 반대로 int n = f → int(f)
//  · 빠진 세미콜론: 다음 줄에서 'syntax error'가 나면 앞 코드 줄 끝에 ;
//  · 오타 이름: 'undeclared identifier' · 없는 함수 → 비슷한 이름(편집 거리 2 이하 · 대소문자만 다름)
//  · 벡터 크기: vec4 자리에 vec3 → vec4(…, 1.0) · vec3 자리에 vec4 → (…).xyz
//  · 옛 GLSL(ES 1.0) · Shadertoy 코드 옮기기 — 문서 전체를 고친다: texture2D · textureCube(…Lod · Proj) → texture(Lod · Proj),
//    gl_FragColor → out vec4 fragColor 선언 + 이름 바꾸기, iGlobalTime → iTime, varying → in
//   quickFixes({ message, lines, index, names }) → [{ label, line, from, text, transform }]
//     message: 'ERROR: 0:N:' 뒤의 문구, lines: 문서의 줄들, index: 오류 줄(0부터), names: 쓸 수 있는 이름들(코드 · 앱 Uniform · 내장)
//     line: 고칠 줄(0부터, 문서 전체 수정이면 -1), from · text: 고치기 전 · 뒤(줄 또는 문서 전체)
//     transform(문서 글) → 고친 글: 여러 수정을 겹쳐 적용할 때(모두 고치기) 쓴다. 줄 수정은 그 줄이 from 그대로일 때만 바꾼다.
//   applyAll(text, fixes) → { text, applied } — 줄마다 첫 수정 · 문서 전체 수정을 차례로 겹쳐 적용(같은 수정은 한 번)

import * as Scope from "./glsl-scope.js";

const INT = /(?<![\w.])(\d+)(?![\w.])/g; // 소수점 · 지수 · 접미사 없는 정수 리터럴
const toFloat = text => text.replace(INT, "$1.0");
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 이 줄에서 정수(int · uint)로 선언된 이름이 쓰인 곳(줄 안 위치). 배열 원소 · 필드 · 함수 이름 · [ ] 안(첨자)은 뺀다.
const intNamesIn = (lines, index, code) => {
  const doc = lines.join("\n"),
    start = lines.slice(0, index).reduce((sum, row) => sum + row.length + 1, 0),
    info = Scope.analyze(doc);
  if (!info.balanced) return [];
  return info.refs
    .filter(ref => ref.at >= start && ref.at < start + code.length && !ref.member)
    .map(ref => ({ ref, decl: Scope.resolve(info, ref.name, ref.at, ref.scope) }))
    .filter(({ decl }) => decl && decl.kind !== "function" && /^u?int$/.test(decl.type || ""))
    .map(({ ref }) => ({ at: ref.at - start, name: ref.name }))
    .filter(({ at, name }) => {
      const before = code.slice(0, at),
        after = code.slice(at + name.length);
      return (
        !/^\s*[[(.]/.test(after) &&
        (before.match(/\[/g) || []).length === (before.match(/\]/g) || []).length &&
        !/(?:float|int)\s*\(\s*$/.test(before)
      );
    });
};
// 위치들의 이름을 wrap(이름)으로 감싼다(뒤에서부터 바꿔 위치가 밀리지 않게)
const wrapAt = (code, spots, wrap) =>
  [...spots]
    .sort((a, b) => b.at - a.at)
    .reduce((out, { at, name }) => out.slice(0, at) + wrap(name) + out.slice(at + name.length), code);
// 줄을 코드와 줄 끝 주석으로 나눈다(// 뒤는 건드리지 않는다)
const splitComment = line => {
  const at = line.indexOf("//");
  return at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at)];
};
// 문서의 줄마다 코드 부분(// 주석 앞)에만 fn을 적용한다
const mapCode = (doc, fn) =>
  doc
    .split("\n")
    .map(row => {
      if (/^\s*#/.test(row)) return row;
      const [code, comment] = splitComment(row);
      return fn(code) + comment;
    })
    .join("\n");
// 옛 GLSL(ES 1.0) · 예전 Shadertoy 이름 → 지금 이름
const LEGACY = {
  texture2DLodEXT: "textureLod",
  texture2DLod: "textureLod",
  textureCubeLod: "textureLod",
  texture2DProj: "textureProj",
  texture2D: "texture",
  textureCube: "texture",
  iGlobalTime: "iTime",
};
// 대괄호 안(배열 첨자 · 크기)은 정수여야 하므로 바꾸지 않는다
const outsideBrackets = (code, change) => {
  let depth = 0,
    out = "",
    chunk = "";
  for (const char of code) {
    if (char === "[") {
      if (!depth) out += change(chunk);
      else out += chunk;
      chunk = "";
      depth++;
      out += char;
    } else if (char === "]") {
      out += chunk + char;
      chunk = "";
      depth = Math.max(0, depth - 1);
    } else chunk += char;
  }
  return out + (depth ? chunk : change(chunk));
};
// 편집 거리(바꾸기 · 넣기 · 빼기 · 이웃 맞바꾸기)
const distance = (a, b) => {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  return rows[a.length][b.length];
};
const similar = (name, names) =>
  [...new Set(names)]
    .filter(candidate => candidate !== name && /^[A-Za-z_]\w*$/.test(candidate))
    .map(candidate => ({
      candidate,
      score: candidate.toLowerCase() === name.toLowerCase() ? 0 : distance(name, candidate),
    }))
    .filter(
      ({ candidate, score }) => score <= (name.length <= 4 ? 1 : 2) && Math.abs(candidate.length - name.length) <= 2
    )
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map(({ candidate }) => candidate);
const replaceName = (line, from, to) => {
  const [code, comment] = splitComment(line);
  return code.replace(new RegExp(`(?<![\\w.])${escapeRe(from)}(?!\\w)`, "g"), to) + comment;
};
// '= 식;' 꼴 줄의 오른쪽 식
const ASSIGN = /^(\s*(?:[\w.[\]]+\s+)?[\w.[\]]+\s*(?:[+\-*/]?=)\s*)(.+?)(\s*;\s*)$/;
const VECTOR = /(\d)-component vector of float/;

const quickFixes = ({ message = "", lines = [], index = 0, names = [] } = {}) => {
  const line = lines[index];
  if (typeof line !== "string") return [];
  const fixes = [];
  const add = (label, text, at = index) => {
    if (text === lines[at] || fixes.some(fix => fix.text === text && fix.line === at)) return;
    const from = lines[at];
    fixes.push({
      label,
      line: at,
      from,
      text,
      transform: doc => {
        const rows = doc.split("\n");
        if (rows[at] !== from) return doc;
        rows[at] = text;
        return rows.join("\n");
      },
    });
  };
  // 문서 전체 수정(옛 코드 옮기기): 주석 밖만 바꾼다
  const whole = (label, transform) => {
    const doc = lines.join("\n"),
      text = transform(doc);
    if (text !== doc && !fixes.some(fix => fix.line === -1 && fix.label === label))
      fixes.push({ label, line: -1, from: doc, text, transform });
  };
  const legacy = name => {
    const to = LEGACY[name];
    if (!to) return false;
    const rename = (code, from, into) => code.replace(new RegExp(`(?<![\\w.])${escapeRe(from)}(?!\\w)`, "g"), into);
    // 텍스처 함수는 옛 코드에 여러 개가 섞여 있으므로 계열 전체를 한 번에 옮긴다(texture2D · textureCube · …Lod · Proj)
    if (/^texture/.test(name))
      whole(`옛 텍스처 함수를 지금 이름으로: ${name} → ${to} 등 (문서 전체)`, doc =>
        mapCode(doc, code =>
          Object.entries(LEGACY)
            .filter(([from]) => /^texture/.test(from))
            .reduce((out, [from, into]) => rename(out, from, into), code)
        )
      );
    else
      whole(`옛 이름을 지금 이름으로: ${name} → ${to} (문서 전체)`, doc =>
        mapCode(doc, code => rename(code, name, to))
      );
    return true;
  };
  const [code, comment] = splitComment(line);

  // 1) float 계산에 정수 리터럴(연산자 양옆)
  const operand =
    /'([^']+)' : wrong operand types .*left-hand operand of type '([^']*)' and a right operand of type '([^']*)'/.exec(
      message
    );
  if (operand) {
    const [, op, left, right] = operand,
      isInt = type => /\bu?int\b/.test(type),
      isFloat = type => /float|vec|mat/.test(type) && !/[iub]vec/.test(type);
    if ((isInt(left) && isFloat(right)) || (isInt(right) && isFloat(left))) {
      const near = new RegExp(
        `(?<![\\w.])(\\d+)(?![\\w.])(?=\\s*${escapeRe(op)})|(?<=${escapeRe(op)}\\s*)(?<![\\w.])(\\d+)(?![\\w.])`,
        "g"
      );
      const fixed = outsideBrackets(code, chunk => chunk.replace(near, (number, a, b) => `${a ?? b}.0`));
      if (fixed !== code)
        add(
          `정수를 실수로: ${(code.match(near) || []).map(n => `${n.trim()} → ${n.trim()}.0`).join(", ")}`,
          fixed + comment
        );
      // 정수 변수가 연산자 바로 옆에 있으면 float(…)로 감싼다
      else {
        const spots = intNamesIn(lines, index, code).filter(({ at, name }) => {
          const before = code.slice(0, at).trimEnd(),
            after = code.slice(at + name.length).trimStart();
          return before.endsWith(op) || after.startsWith(op);
        });
        if (spots.length)
          add(
            `정수 변수를 실수로: ${spots.map(spot => `float(${spot.name})`).join(", ")}`,
            wrapAt(code, spots, name => `float(${name})`) + comment
          );
      }
    }
  }
  // 2) 실수 자리에 정수: float x = 1; · x = 2;
  if (/cannot convert from 'const u?int' to '[^']*(?:float|vec)/.test(message)) {
    const assign = ASSIGN.exec(code);
    if (assign) {
      const rhs = outsideBrackets(assign[2], toFloat);
      if (rhs !== assign[2])
        add(`정수를 실수로: ${assign[2].trim()} → ${rhs.trim()}`, assign[1] + rhs + assign[3] + comment);
    }
  }
  // 2-1) 실수 자리에 정수 변수(float x = i;) · 정수 자리에 실수(int n = f;): 오른쪽 식을 변환으로 감싼다
  const typed =
    /cannot convert from '(?:(?:lowp|mediump|highp) )?(u?int|float)' to '(?:(?:lowp|mediump|highp) )?(u?int|float)'/.exec(
      message
    );
  if (typed && typed[1] !== typed[2] && !/'const /.test(message)) {
    const assign = ASSIGN.exec(code);
    if (assign) {
      const expr = assign[2].trim(),
        into = typed[2],
        wrapped = `${into}(${expr})`;
      add(
        into === "float" ? `정수를 실수로 변환: ${wrapped}` : `실수를 정수로 변환(소수점 아래 버림): ${wrapped}`,
        assign[1] + wrapped + assign[3] + comment
      );
    }
  }
  // 3) 함수: 있는 함수면 정수 인자를 실수로(pow(x, 2) → pow(x, 2.0)), 없는 이름이면 비슷한 이름
  const call = /'([A-Za-z_]\w*)' : no matching overloaded function found/.exec(message);
  if (call && !legacy(call[1])) {
    const name = call[1];
    if (names.includes(name)) {
      const start = code.search(new RegExp(`(?<![\\w.])${escapeRe(name)}\\s*\\(`));
      if (start >= 0) {
        let depth = 0,
          end = code.indexOf("(", start);
        for (let i = end; i < code.length; i++) {
          if (code[i] === "(") depth++;
          else if (code[i] === ")" && !--depth) {
            end = i;
            break;
          }
        }
        const open = code.indexOf("(", start),
          args = code.slice(open + 1, end),
          fixed = outsideBrackets(args, toFloat);
        if (fixed !== args)
          add(`${name}의 정수 인자를 실수로`, code.slice(0, open + 1) + fixed + code.slice(end) + comment);
        else {
          // 정수 변수 인자: mod(i, 2.0) → mod(float(i), 2.0)
          const spots = intNamesIn(lines, index, code).filter(({ at }) => at > open && at < end);
          if (spots.length)
            add(
              `${name}의 정수 변수 인자를 실수로: ${spots.map(spot => `float(${spot.name})`).join(", ")}`,
              wrapAt(code, spots, name => `float(${name})`) + comment
            );
        }
      }
    } else
      for (const candidate of similar(name, names))
        add(`${candidate}(으)로 바꾸기`, replaceName(line, name, candidate));
  }
  // 4) 선언하지 않은 이름: 비슷한 이름
  const undeclared = /'([A-Za-z_]\w*)' : undeclared identifier/.exec(message);
  if (undeclared?.[1] === "gl_FragColor")
    whole("gl_FragColor → out vec4 fragColor (GLSL ES 3.0 출력 선언 · 문서 전체)", doc => {
      const renamed = mapCode(doc, code => code.replace(/(?<![\w.])gl_FragColor(?!\w)/g, "fragColor"));
      if (/\bout\s+(?:(?:lowp|mediump|highp)\s+)?vec4\s+fragColor\b/.test(renamed)) return renamed;
      const rows = renamed.split("\n"),
        at = rows.findIndex(row => /^\s*precision\s+\w+\s+float\s*;/.test(row)),
        version = rows.findIndex(row => /^\s*#\s*version\b/.test(row));
      rows.splice(at >= 0 ? at + 1 : version >= 0 ? version + 1 : 0, 0, "out vec4 fragColor;");
      return rows.join("\n");
    });
  else if (undeclared && legacy(undeclared[1])) {
    // 옛 이름(iGlobalTime 등)
  } else if (undeclared)
    for (const candidate of similar(undeclared[1], names))
      add(`${candidate}(으)로 바꾸기`, replaceName(line, undeclared[1], candidate));
  // 5) 벡터 크기: vec4 자리에 vec3(색 출력에 흔하다) · vec3 자리에 vec4
  const convert = /cannot convert from '([^']*)' to '([^']*)'/.exec(message);
  if (convert) {
    const fromSize = Number(VECTOR.exec(convert[1])?.[1] || (/\bfloat\b/.test(convert[1]) ? 1 : 0)),
      toSize = Number(VECTOR.exec(convert[2])?.[1] || 0),
      assign = ASSIGN.exec(code);
    if (assign && fromSize && toSize && fromSize !== toSize) {
      const expr = assign[2].trim(),
        simple = /^[\w.]+(?:\([^()]*\))?$/.test(expr) && !/^\d/.test(expr);
      let fixed;
      if (fromSize > toSize) fixed = `${simple ? expr : `(${expr})`}.${"xyzw".slice(0, toSize)}`;
      else if (fromSize === 1) fixed = `vec${toSize}(${expr})`;
      else
        fixed = `vec${toSize}(${expr}, ${[...Array(toSize - fromSize)].map((_, i) => (fromSize + i === 3 ? "1.0" : "0.0")).join(", ")})`;
      add(
        fromSize > toSize ? `앞 ${toSize}성분만 쓰기: .${"xyzw".slice(0, toSize)}` : `vec${toSize}로 늘리기`,
        assign[1] + fixed + assign[3] + comment
      );
    }
  }
  // 6) 빠진 세미콜론: 이 줄에서 문법 오류 → 앞 코드 줄이 문장 끝(; { } , 등) 없이 끝났으면 ;를 붙인다
  if (/: syntax error/.test(message)) {
    let at = index - 1;
    while (at >= 0 && !splitComment(lines[at])[0].trim()) at--;
    if (at >= 0) {
      const [prevCode, prevComment] = splitComment(lines[at]),
        trimmed = prevCode.trimEnd();
      const open = (prevCode.match(/\(/g) || []).length - (prevCode.match(/\)/g) || []).length;
      if (
        trimmed &&
        !/[;{}(,:]$/.test(trimmed) &&
        !/^\s*#/.test(trimmed) &&
        !/[=+\-*/<>&|?]$/.test(trimmed) &&
        open <= 0 &&
        !/^\s*(?:else|do)\b\s*$/.test(trimmed) &&
        !/^\s*[{)]/.test(code)
      )
        add("앞 줄 끝에 ; 넣기", trimmed + ";" + prevCode.slice(trimmed.length) + prevComment, at);
    }
  }
  // 7) 옛 한정자: varying → in (조각 셰이더의 입력)
  if (/'varying' : Illegal use of reserved word/.test(message))
    whole("varying → in (GLSL ES 3.0 · 문서 전체)", doc =>
      mapCode(doc, code => code.replace(/(?<![\w.])varying(?!\w)/g, "in"))
    );
  return fixes;
};

// 여러 오류의 수정을 겹쳐 적용한다: 줄마다 첫 수정 하나 · 문서 전체 수정은 이름(label)마다 하나.
const applyAll = (text, fixes) => {
  const seen = new Set(),
    lineDone = new Set();
  let out = text,
    applied = 0;
  // 줄 수정을 먼저(줄 번호가 원래 글 기준이라), 문서 전체 수정은 그 뒤에
  for (const fix of [...fixes.filter(f => f.line >= 0), ...fixes.filter(f => f.line < 0)]) {
    const key = fix.line >= 0 ? `line:${fix.line}` : `whole:${fix.label}`;
    if (seen.has(key) || (fix.line >= 0 && lineDone.has(fix.line))) continue;
    seen.add(key);
    const next = fix.transform(out);
    if (next === out) continue;
    out = next;
    applied++;
    if (fix.line >= 0) lineDone.add(fix.line);
  }
  return { text: out, applied };
};

export { quickFixes, applyAll, distance };
