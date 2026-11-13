// node tests/opaque-context-regression.js — 앱이 만드는 WebGL2 캔버스는 모두 불투명(alpha: false)이다.
// 셰이더가 알파를 1로 두지 않으면(예: tanh로 출력 전체를 정하는 Nox Fire), 알파 캔버스에서는 그림이 비치거나 사라진다.
// 메인 렌더러 · 갤러리 썸네일 · 코드 조각 미리보기 · 내보낸 HTML 재생기가 모두 같은 결과를 보이도록 이 규칙을 지킨다.
"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const dir=path.join(__dirname,"..","js");let passed=0;
const calls=[];
for(const name of fs.readdirSync(dir).filter(f=>f.endsWith(".js")&&f!=="codemirror.js")){
  const source=fs.readFileSync(path.join(dir,name),"utf8");
  for(const m of source.matchAll(/getContext\(\s*["']webgl2["']\s*(?:,\s*(\{[^}]*\}))?\s*\)/g))calls.push({name,options:m[1]||""});
}
assert(calls.length>=4,`WebGL2 컨텍스트를 만드는 곳을 찾지 못했습니다: ${calls.length}`);
for(const {name,options} of calls){
  assert(/\balpha\s*:\s*false\b/.test(options),`${name}: getContext("webgl2", …)에 alpha: false가 없습니다 (${options||"옵션 없음"})`);
  passed++;console.log("PASS",`${name}: 불투명 WebGL2 캔버스`);
}
console.log(`Opaque contexts: ${passed} passed`);
