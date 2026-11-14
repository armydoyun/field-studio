// 개발용 index.html에 압축된 CSS·JS를 직접 넣어 한 파일짜리 배포본을 만든다.
// 노드 의존성이 없는 순수 함수라 tools/build.mjs와 브라우저 검사가 같은 코드를 쓴다.

// 개발용 index.html은 css/ 아래 파일을 <link> 여러 개로 건다. 배포본은 첫 링크 자리에 <style> 하나를 넣고 나머지 링크를 지운다.
export const CSS_LINK = /[ \t]*<link rel="stylesheet" href="\.\/(css\/[\w./-]+\.css)">\r?\n?/g;
export const cssHrefs = html => [...html.matchAll(CSS_LINK)].map(m => m[1]);
export const JS_TAG = '<script type="module" src="./js/main.js"></script>';
export const DEV_COMMENT = "<!-- ES Modules: 개발용 실행은 http://localhost를 사용한다. -->";
export const BUILD_COMMENT =
  "<!-- 오프라인 단일 파일 배포본: npm run build(tools/build.mjs)가 만든다. 직접 고치지 않는다. -->";

// 정확히 한 번 나오는 문자열만 바꾼다. String.replace의 $& 같은 치환 패턴은 해석하지 않는다(번들 코드에 $가 많다).
export const replaceOnce = (text, search, replacement, label) => {
  const at = text.indexOf(search);
  if (at < 0 || text.indexOf(search, at + 1) >= 0)
    throw new Error(`index.html에서 ${label}을(를) 정확히 한 번 찾지 못했습니다: ${search}`);
  return text.slice(0, at) + replacement + text.slice(at + search.length);
};

// <script> 안의 "</script"는 태그를 일찍 끝낸다. 문자열·정규식·주석 어디서든 "<\/script"와 같은 뜻이므로 바꿔 넣는다.
// "<!--"는 이어지는 <script>와 함께 HTML 파서 상태를 바꿀 수 있으므로 아예 거부한다.
export const scriptSafe = js => {
  const code = js.replace(/<\/(script)/gi, "<\\/$1");
  if (/<!--/.test(code)) throw new Error("번들 JS에 '<!--'가 있어 HTML에 안전하게 넣을 수 없습니다.");
  return code;
};

export const styleSafe = css => {
  if (/<\/style/i.test(css)) throw new Error("CSS에 '</style'이 있어 HTML에 넣을 수 없습니다.");
  return css;
};

// html: 개발용 index.html, css: 링크 순서대로 이어 붙여 압축한 CSS, js: 압축된 IIFE 번들
export const inlineHtml = ({ html, css, js }) => {
  if (!cssHrefs(html).length) throw new Error("index.html에서 스타일시트 링크(./css/….css)를 찾지 못했습니다.");
  let first = true;
  // 치환 함수를 쓰므로 CSS 안의 $& 같은 글자는 해석되지 않는다.
  let out = html.replace(CSS_LINK, () => {
    if (!first) return "";
    first = false;
    return `    <style>${styleSafe(css.trim())}</style>\n`;
  });
  out = replaceOnce(out, DEV_COMMENT, BUILD_COMMENT, "개발용 스크립트 주석");
  out = replaceOnce(out, JS_TAG, `<script>${scriptSafe(js.trim())}</script>`, "ES Module 진입 스크립트");
  // 바깥 파일을 하나라도 참조하면 한 파일로 옮겼을 때 깨진다. 인라인 코드 속 HTML 문자열은 빼고 마크업만 본다.
  const markup = out
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const external = /\s(?:src|href)="(?!data:|#|https?:)[^"]+"/.exec(markup);
  if (external) throw new Error(`배포본이 아직 바깥 파일을 참조합니다:${external[0]}`);
  if (/<script\b[^>]*\b(?:type="module"|src=)/i.test(out.replace(/<script>[\s\S]*?<\/script>/g, "")))
    throw new Error("배포본에 바깥 파일·ES Module 스크립트가 남아 있습니다(file://에서 막힘).");
  return out;
};
