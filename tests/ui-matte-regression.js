// node tests/ui-matte-regression.js — Matte UI 리디자인의 정적 계약만 검사한다.
"use strict";
const fs=require("fs"),assert=require("assert"),path=require("path");
const root=path.join(__dirname,".."),css=fs.readFileSync(path.join(root,"style.css"),"utf8"),html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const check=(ok,name)=>{assert(ok,name);console.log("PASS",name);};
for(const id of ["panelTabs","bufferDemo","bufferClear","studioRun","studioPassTabs","uniformSearch","studioDock","quickHelp"])check(html.includes(`id="${id}"`),id+" 존재");
check(css.includes("#bufferDemo")&&css.includes("#bufferClear")&&css.includes(".buffer-actions button"),"Render 예제/해제 버튼 스타일");
// Matte 2.0의 "블러·번짐 전면 금지"는 이후 리디자인에서 바뀌었다. 지금 계약: 글자 번짐(text-shadow)은 없음,
// 반투명 블러는 셰이더 화면 위 HUD와 dialog 배경에만, radial-gradient는 갤러리·가이드 머리말과 갤러리 썸네일(그림)에만 쓴다.
check(!css.includes("text-shadow"),"글자 번짐 없음");
const rulesWith=word=>[...css.replace(/\/\*[\s\S]*?\*\//g,"").matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m=>m[2].includes(word)).flatMap(m=>m[1].split(",").map(x=>x.trim()));
const blurOK=/^(?:\.stage-label|#stageToolbar|\.viewport-info|\.stage-stats|\.stage-hint)$|::backdrop$/, gradientOK=/^\.gallery-(?:head|thumb)\b|^\.guide-head$/;
check(rulesWith("backdrop-filter").every(x=>blurOK.test(x)),"블러는 뷰포트 HUD·dialog 배경에만: "+rulesWith("backdrop-filter").filter(x=>!blurOK.test(x)));
check(rulesWith("radial-gradient").every(x=>gradientOK.test(x)),"radial-gradient는 갤러리·가이드 머리말에만: "+rulesWith("radial-gradient").filter(x=>!gradientOK.test(x)));
check(css.includes(".studio-top button.is-active")&&css.includes(".panel-tabs button.is-active"),"패스/패널 상태 구분");
check(css.includes("@media (max-width:600px)")||css.includes("@media (max-width: 600px)"),"모바일 접근성 유지");
console.log("UI Matte 정적 검사 통과");
