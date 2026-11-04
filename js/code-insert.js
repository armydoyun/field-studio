// GLSL 소스에 코드를 넣을 위치를 계산한다. 문자열만 다루는 순수 함수(편집기·DOM 없음)이고, Studio가 결과를 편집기에 한 번에 넣는다.

// #version · precision 머리 줄 끝 위치. precision이 없으면 #version 줄 끝, 둘 다 없으면 0.
const headerLength = src =>
  (/^[\s\S]*?\bprecision\s+\w+\s+float\s*;[^\n]*\n?/.exec(src)?.[0] ?? (/^#version[^\n]*\n?/.exec(src)?.[0] || ""))
    .length;
// 주석을 같은 길이의 공백으로 지운 사본(괄호 깊이를 셀 때 주석 속 { }를 무시한다)
const stripComments = text => text.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, " "));

// 가이드 코드 예시 삽입: 선택 [start, end]를 text로 바꾼다. 커서가 머리 줄보다 앞이면 컴파일이 깨지므로 머리 줄 다음으로 옮기고,
// 앞뒤 줄과 붙지 않게 줄바꿈을 더한다. → {from, to, text}
const snippetEdit = (src, start, end, text) => {
  const header = headerLength(src);
  if (start < header) start = end = header;
  const lineStart = start === 0 || src[start - 1] === "\n";
  return {
    from: start,
    to: end,
    text:
      (lineStart ? "" : "\n") +
      text +
      (src[start] === "\n" || start === src.length ? "" : "\n") +
      (lineStart ? "\n" : ""),
  };
};

// 코드 조각 라이브러리 삽입: global(함수 정의)은 전역 위치에, main(문장)은 함수 안 커서 위치에 넣는다. → {src, caret}
//  - 커서가 함수 본문 안이면 global은 그 함수 선언 바로 앞에 넣는다(함수 안 함수 정의 방지).
//  - 커서가 함수 밖이면 main 코드는 main() 본문의 끝(닫는 괄호 앞)에 넣는다.
const codeEdit = (source, caretAt, { global = "", main = "" } = {}) => {
  let src = source,
    caret = caretAt;
  const headerEnd = () => headerLength(stripComments(src));
  // limit 앞까지의 괄호 깊이와, 지금 문장(선언)이 시작한 위치
  const scan = limit => {
    const clean = stripComments(src),
      header = headerEnd();
    let depth = 0,
      declStart = header;
    for (let i = header; i < limit; i++) {
      const c = clean[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth = Math.max(0, depth - 1);
        if (!depth) declStart = i + 1;
      } else if (c === ";" && !depth) declStart = i + 1;
    }
    return { depth, declStart, header };
  };
  const lineStart = at => src.lastIndexOf("\n", at - 1) + 1;
  const insertAt = (at, text) => {
    src = src.slice(0, at) + text + src.slice(at);
    if (at <= caret) caret += text.length;
  };
  caret = Math.max(caret, headerEnd());
  if (global) {
    const { depth, declStart, header } = scan(caret),
      text = global.replace(/\s+$/, "") + "\n\n";
    let at;
    if (depth > 0) {
      at = declStart;
      while (at < src.length && /\s/.test(src[at])) at++;
      at = lineStart(at);
    } // 감싼 함수 선언 바로 앞
    else if (!src.slice(lineStart(caret), caret).trim())
      at = Math.max(header, lineStart(caret)); // 빈 줄 시작
    else {
      const next = src.indexOf("\n", caret);
      at = next < 0 ? src.length : next + 1;
      if (next < 0) {
        src += "\n";
        at = src.length;
      }
    } // 현재 줄 다음
    insertAt(at, text);
  }
  if (main) {
    const { depth } = scan(caret),
      indent = "    ",
      body =
        main
          .replace(/\s+$/, "")
          .split("\n")
          .map(line => (line ? indent + line : line))
          .join("\n") + "\n";
    if (depth > 0) {
      // 줄 맨 앞이면 그 줄 위에, 줄 중간이면 다음 줄에 넣는다(문장을 쪼개지 않음).
      const start = lineStart(caret),
        next = src.indexOf("\n", caret),
        at = !src.slice(start, caret).trim() ? start : next < 0 ? src.length : next + 1;
      if (at === src.length && !src.endsWith("\n")) src += "\n";
      insertAt(at, body);
      caret = at + body.length;
    } else {
      // 함수 밖이면 main() 본문의 끝(닫는 괄호 앞)에 넣는다. 앞에서 선언한 uv 같은 변수를 쓸 수 있다.
      const clean = stripComments(src),
        m = /\bvoid\s+main\s*\(\s*\)\s*\{/.exec(clean);
      let at = src.length;
      if (m) {
        let d = 0;
        for (let i = m.index + m[0].length - 1; i < clean.length; i++) {
          if (clean[i] === "{") d++;
          else if (clean[i] === "}" && --d === 0) {
            at = lineStart(i);
            break;
          }
        }
      }
      insertAt(at, body);
      caret = at + body.length;
    }
  }
  return { src, caret };
};

export { headerLength, stripComments, snippetEdit, codeEdit };
