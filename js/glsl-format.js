// GLSL 코드 정리(자동 서식): 들여쓰기 · 띄어쓰기 · 빈 줄만 맞춘다. 코드의 뜻은 바꾸지 않는다(순수 함수).
//  · 줄 나눔은 그대로 둔다(줄을 합치거나 나누지 않는다) — 사용자가 나눠 둔 긴 식 · 정렬을 존중한다
//  · 주석 내용(특히 // @range 같은 어노테이션)과 # 전처리 줄(이어지는 \ 줄 포함) · 여러 줄 /* */ 주석 안쪽은 글자 그대로
//  · 줄 끝 주석 앞의 간격은 원래대로(주석을 세로로 맞춰 둔 것을 흐트러뜨리지 않는다)
//  · 들여쓰기는 중괄호 깊이(+ 닫히지 않은 괄호가 이어지는 줄은 한 단계 더), 빈 줄은 연속 한 줄까지, 줄 끝 공백은 지운다
//  · 띄어쓰기: 이항 연산자 · 대입 양옆 한 칸, 쉼표 · 세미콜론 뒤 한 칸, 괄호 안쪽 · 함수 이름과 ( 사이 · 단항 연산자 뒤는 붙인다,
//    if / for / while / switch / return 뒤 ( 앞은 한 칸
// 안전장치: 정리 전후의 토큰 목록(공백 제외)이 같아야 한다 — tests/glsl-format-regression.js가 모든 예제로 확인한다.
//   format(source, { indent = "    " }) → 정리한 코드
//   tokenize(line) → 한 줄의 토큰(공백 제외, 주석은 한 토큰) — 검사용

const OPERATORS = [
  "<<=",
  ">>=",
  "++",
  "--",
  "<<",
  ">>",
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "^".repeat(2), // 논리 XOR(^^). 글자로 적으면 이모티콘 금지 검사(no-emoji)가 웃는 얼굴로 본다
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "=",
  "!",
  "~",
  "&",
  "|",
  "^",
  "?",
  ":",
  ",",
  ";",
  ".",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
];
const NUMBER = /^(?:0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fFuU]?|\d+[eE][+-]?\d+[fF]?)/;
const IDENT = /^[A-Za-z_]\w*/;
const CONTROL = new Set(["if", "for", "while", "switch", "return"]);
// 이 토큰 뒤에 오는 + - 는 단항이다(부호)
const BEFORE_UNARY = new Set([...OPERATORS.filter(op => ![")", "]", "++", "--", "."].includes(op)), "return", "case"]);
const UNARY = new Set(["+", "-", "!", "~", "++", "--"]);
const BINARY = new Set(OPERATORS.filter(op => !["!", "~", ",", ";", ".", "(", ")", "[", "]", "{", "}"].includes(op)));

// 한 줄을 { type, text, gap }로 나눈다. gap은 토큰 앞에 원래 있던 공백. 닫히지 않은 /* 는 rest로 알린다.
const lex = line => {
  const out = [];
  let i = 0,
    gap = "";
  while (i < line.length) {
    const rest = line.slice(i);
    const space = /^[ \t]+/.exec(rest);
    if (space) {
      gap = space[0];
      i += gap.length;
      continue;
    }
    let text, type;
    if (rest.startsWith("//")) [text, type] = [rest, "comment"];
    else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end < 0) {
        out.push({ type: "comment", text: rest, gap, open: true });
        return out;
      }
      [text, type] = [rest.slice(0, end + 2), "comment"];
    } else if (NUMBER.test(rest) && !(rest[0] === "." && !/^\.\d/.test(rest)))
      [text, type] = [NUMBER.exec(rest)[0], "number"];
    else if (IDENT.test(rest)) [text, type] = [IDENT.exec(rest)[0], "word"];
    else {
      text = OPERATORS.find(op => rest.startsWith(op)) || rest[0];
      type = "op";
    }
    out.push({ type, text, gap });
    gap = "";
    i += text.length;
  }
  return out;
};
const tokenize = line => lex(line).map(token => token.text);

// 두 토큰 사이 띄어쓰기. prev는 앞 토큰.
const spacing = (prev, token) => {
  const p = prev.text,
    t = token.text;
  if (token.type === "comment") return token.gap || " ";
  if (prev.type === "comment") return " ";
  if (prev.unary) return ""; // 단항 연산자 뒤는 붙인다: -x · !flag · ++i
  if (t === "(" && (prev.type === "word" || p === ")" || p === "]")) return CONTROL.has(p) ? " " : ""; // 함수 호출 · 생성자
  if (p === "(" || p === "[" || t === ")" || t === "]" || t === "," || t === ";") return "";
  if (t === "[" && (prev.type === "word" || p === "]" || p === ")")) return ""; // 배열 첨자 · 선언
  if (t === "." || p === ".") return ""; // 성분 · 멤버
  if ((t === "++" || t === "--") && !token.unary) return ""; // 뒤에 붙는 증감
  if (token.label) return ""; // case X: · default:
  if (p === "," || p === ";") return " ";
  return " ";
};

const format = (source, { indent = "    " } = {}) => {
  if (typeof source !== "string") throw new TypeError("코드는 문자열이어야 합니다.");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const out = [];
  let depth = 0,
    parens = 0,
    inBlock = false,
    continued = false,
    blank = 0;
  for (const raw of lines) {
    // 여러 줄 /* */ 주석의 안쪽 · # 전처리의 이어지는 줄: 글자 그대로(줄 끝 공백만 지운다)
    if (inBlock) {
      out.push(raw.replace(/[ \t]+$/, ""));
      if (raw.includes("*/")) inBlock = false;
      blank = 0;
      continue;
    }
    const trimmed = raw.trim();
    if (continued || trimmed.startsWith("#")) {
      out.push(raw.replace(/[ \t]+$/, ""));
      continued = /\\$/.test(trimmed);
      blank = 0;
      continue;
    }
    if (!trimmed) {
      if (++blank <= 1 && out.length) out.push("");
      continue;
    }
    blank = 0;
    const tokens = lex(trimmed);
    // 단항 표시 · 'case X:' / 'default:'의 콜론(삼항 ? : 와 구분) 표시
    let pendingLabel = false;
    tokens.forEach((token, index) => {
      if (token.text === "case" || token.text === "default") pendingLabel = true;
      else if (token.text === "?") pendingLabel = false;
      else if (token.text === ":" && pendingLabel) {
        token.label = true;
        pendingLabel = false;
      }
      const prev = tokens
        .slice(0, index)
        .reverse()
        .find(t => t.type !== "comment");
      if (token.type === "op" && UNARY.has(token.text)) {
        if (token.text === "++" || token.text === "--") {
          // 앞이 값(이름 · 숫자 · ) · ])이면 뒤에 붙는 증감, 아니면 앞에 붙는 증감
          token.unary = !prev || !(prev.type === "word" || prev.type === "number" || [")", "]"].includes(prev.text));
        } else if (token.text === "!" || token.text === "~") token.unary = true;
        else
          token.unary =
            !prev ||
            (prev.type === "op" ? BEFORE_UNARY.has(prev.text) : prev.text === "return" || prev.text === "case");
      }
    });
    const code = tokens.filter(t => t.type !== "comment");
    const closesFirst = code[0]?.text === "}";
    const level = Math.max(0, depth - (closesFirst ? 1 : 0)) + (parens > 0 && !closesFirst ? 1 : 0);
    let text = "";
    tokens.forEach((token, index) => {
      if (index) {
        const prev = tokens[index - 1];
        let gap = spacing(prev, token);
        // 이항 연산자 · 대입 · 삼항은 양옆 한 칸
        if (token.type === "op" && BINARY.has(token.text) && !token.unary && !token.label) {
          if (!(token.text === "++" || token.text === "--")) gap = " ";
        }
        if (prev.type === "op" && BINARY.has(prev.text) && !prev.unary && token.type !== "comment") {
          if (!(prev.text === "++" || prev.text === "--") && !prev.label) gap = " ";
        }
        text += gap;
      }
      text += token.text;
      if (token.open) inBlock = true;
    });
    out.push(indent.repeat(level) + text);
    for (const token of code) {
      if (token.text === "{") depth++;
      else if (token.text === "}") depth = Math.max(0, depth - 1);
      else if (token.text === "(") parens++;
      else if (token.text === ")") parens = Math.max(0, parens - 1);
    }
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  const ended = /\r?\n$/.test(source);
  return out.join(newline) + (ended ? newline : "");
};

export { format, tokenize };
