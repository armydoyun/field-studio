// node tests/ui-matte-regression.js — 단순(Matte) UI의 정적 계약만 검사한다.
"use strict";
const fs=require("fs"),assert=require("assert"),path=require("path");
const root=path.join(__dirname,".."),css=require("../tools/css-files.cjs").readCss(),html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const check=(ok,name)=>{assert(ok,name);console.log("PASS",name);};
for(const id of ["panelTabs","openBufferViewer","studioRun","studioPassTabs","uniformSearch","studioDock","quickHelp","themeToggle"])check(html.includes(`id="${id}"`),id+" 존재");
check(css.includes("#openBufferViewer")&&css.includes(".buffer-actions button"),"Render 버퍼 뷰어 버튼 스타일");
// 디자인 v3 계약: 장식용 그라데이션·발광 그림자·블러 없음. 계층은 선과 면의 명도 차이로만 나눈다.
check(!css.includes("text-shadow"),"글자 번짐 없음");
const bare=css.replace(/\/\*[\s\S]*?\*\//g,"");
const rulesWith=word=>[...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m=>m[2].includes(word)).flatMap(m=>m[1].split(",").map(x=>x.trim()));
const declsOf=prop=>[...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(m=>[...m[2].matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`,"g"))].map(d=>[m[1].trim(),d[1].trim()]));
check(rulesWith("backdrop-filter").length===0,"블러 없음: "+rulesWith("backdrop-filter"));
// 그라데이션은 그림(갤러리 썸네일)과 기능용(들여쓰기 안내선·가로 스크롤 흐림·투명 체크무늬)에만 쓴다.
const gradientOK=/^\.gallery-thumb\b|\.cm-indent-guides$|^\.guide-nav$|^\.profile-buffer canvas$/;
check(rulesWith("gradient(").every(x=>gradientOK.test(x)),"그라데이션은 썸네일·기능용에만: "+rulesWith("gradient(").filter(x=>!gradientOK.test(x)));
check(!/conic-gradient\(from/.test(bare)&&!html.includes("gradient"),"로고·HTML에 그라데이션 없음");
// 그림자는 떠 있는 층(메뉴·대화상자·팔레트·서랍)의 공통 --shadow 하나와 둘러보기 가림막에만 쓴다.
const shadowOK=([sel,value])=>value==="var(--shadow)"||value==="none"||/^\.guide-tour-/.test(sel);
check(declsOf("box-shadow").every(shadowOK),"그림자는 --shadow 또는 가림막만: "+declsOf("box-shadow").filter(d=>!shadowOK(d)).map(d=>d.join(" → ")));
check(!/@keyframes live-pulse/.test(bare),"깜빡이는 발광 표시 없음");
// 아이콘: 글자 기호로 그린 아이콘 대신 SVG 마스크를 쓴다.
check(!/(?<!<kbd)>\s*[▶↺↻✓ƒ?↗]\s*(?:<|[가-힣])/.test(html),"HTML 버튼·표시에 글자 기호 아이콘 없음(<kbd> 키 이름은 제외)");
check(!/content:\s*"[✓●▶ƒ]/.test(bare),"CSS content에 글자 기호 아이콘 없음");
// 테마: 다크(기본)·라이트 토큰이 모두 있고, 시스템 설정과 사용자 선택을 모두 따른다.
const tokens=block=>new Set([...block.matchAll(/--([\w-]+)\s*:/g)].map(m=>m[1]));
const darkBlock=bare.match(/:root,:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1]||"",lightBlock=bare.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1]||"";
const missing=[...tokens(darkBlock)].filter(t=>!tokens(lightBlock).has(t));
check(darkBlock&&lightBlock&&missing.length===0,"라이트 테마가 다크 테마의 모든 색 토큰을 정의: "+missing);
check(/@media \(prefers-color-scheme:light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)/.test(bare),"선택이 없으면 시스템 밝기 설정을 따름");
check(/field\.theme\.v1/.test(html)&&fs.existsSync(path.join(root,"js","theme.js")),"저장된 테마를 첫 그리기 전에 적용");
check(css.includes(".studio-top button.is-active")&&css.includes(".panel-tabs button.is-active"),"패스/패널 상태 구분");
check(css.includes("@media (max-width:600px)")||css.includes("@media (max-width: 600px)"),"모바일 접근성 유지");
console.log("UI Matte 정적 검사 통과");
