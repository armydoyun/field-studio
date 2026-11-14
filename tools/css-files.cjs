// 스타일시트 목록의 단일 출처: index.html의 <link rel="stylesheet" href="./css/…"> 순서.
// 빌드(tools/build.mjs) · 해시 목록 · 테스트가 모두 이 함수로 같은 순서의 CSS를 읽는다. Node 표준 모듈만 쓴다.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const LINK = /<link rel="stylesheet" href="\.\/(css\/[\w./-]+\.css)">/g;

// index.html에 적힌 순서 그대로의 상대 경로 목록(css/tokens.css …)
const cssFiles = (html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")) =>
  [...html.matchAll(LINK)].map(m => m[1]);
// 모든 스타일시트를 순서대로 이어 붙인 글자(브라우저가 적용하는 것과 같은 순서)
const readCss = (root = ROOT) =>
  cssFiles(fs.readFileSync(path.join(root, "index.html"), "utf8"))
    .map(name => fs.readFileSync(path.join(root, name), "utf8"))
    .join("\n");
// css/ 아래 실제 파일 전부(링크하지 않은 파일을 찾는 검사용)
const cssOnDisk = (root = ROOT) => {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".css")) out.push(rel);
    }
  };
  walk("css");
  return out.sort();
};

module.exports = { cssFiles, readCss, cssOnDisk };
