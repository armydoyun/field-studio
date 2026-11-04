// GLSL 문법 강조 공용 모듈. 편집기(code-editor.js)와 가이드(guide.js)의 코드 예시가 같은 규칙·색(.glsl-* 클래스)을 쓴다.
// DOM 노드(텍스트 + span)만 만들며 HTML 문자열은 해석하지 않는다.
const KEYWORDS =
  "uniform|out|in|inout|const|precision|highp|mediump|lowp|if|else|for|while|do|break|continue|return|discard|struct|layout|switch|case|default|true|false|flat|smooth";
const TYPES = "void|float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?|[iu]?sampler2D|samplerCube|sampler3D";
const TOKENS = new RegExp(
  String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*|"(?:\\.|[^"\\])*"|\b(?:${KEYWORDS})\b|\b(?:${TYPES})\b|\bgl_\w+\b|\b[A-Za-z_]\w*(?=\s*\()|\b\d+(?:\.\d*)?(?:[eE][+-]?\d+)?[uU]?\b|\.\d+(?:[eE][+-]?\d+)?`,
  "g"
);
const KEYWORD = new RegExp(`^(?:${KEYWORDS})$`),
  TYPE = new RegExp(`^(?:${TYPES})$`);
// 레퍼런스에 없어도 자주 쓰는 내장 함수는 항상 내장 색으로 칠한다.
const DEFAULT_BUILTINS =
  "texture textureSize texelFetch textureLod normalize length distance dot cross mix clamp smoothstep step pow exp log sin cos tan atan abs min max floor ceil fract mod sqrt reflect refract radians degrees".split(
    " "
  );
// builtinNames: 내장 함수 이름 목록(호출 이름 + '('이 여기에 있으면 builtin, 없으면 사용자 함수 색).
const create = (builtinNames = []) => {
  const builtins = new Set([...builtinNames].filter(name => /^[A-Za-z_]\w*$/.test(name)));
  for (const name of DEFAULT_BUILTINS) builtins.add(name);
  const tokenClass = token =>
    token.startsWith("//") || token.startsWith("/*")
      ? "glsl-comment"
      : token.startsWith("#")
        ? "glsl-directive"
        : token.startsWith('"')
          ? "glsl-string"
          : KEYWORD.test(token)
            ? "glsl-keyword"
            : TYPE.test(token)
              ? "glsl-type"
              : /^[.\d]/.test(token)
                ? "glsl-number"
                : token.startsWith("gl_") || builtins.has(token)
                  ? "glsl-builtin"
                  : "glsl-function";
  // source를 강조한 DocumentFragment를 돌려준다.
  const fragment = source => {
    const src = String(source),
      frag = document.createDocumentFragment();
    let offset = 0;
    for (const match of src.matchAll(TOKENS)) {
      if (match.index > offset) frag.append(document.createTextNode(src.slice(offset, match.index)));
      const token = match[0],
        span = document.createElement("span");
      span.textContent = token;
      span.className = tokenClass(token);
      frag.append(span);
      offset = match.index + token.length;
    }
    if (offset < src.length) frag.append(document.createTextNode(src.slice(offset)));
    return frag;
  };
  // node의 내용을 강조된 source로 바꾼다. 텍스트 내용(textContent)은 source와 같게 유지된다.
  const paint = (node, source = node.textContent) => {
    node.replaceChildren(fragment(source));
    node.classList?.add("glsl-code");
    return node;
  };
  return { tokenClass, fragment, paint, builtins };
};
export { create };
