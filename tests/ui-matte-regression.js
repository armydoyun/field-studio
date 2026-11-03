// node tests/ui-matte-regression.js — Matte UI 리디자인의 정적 계약만 검사한다.
"use strict";
const fs=require("fs"),assert=require("assert"),path=require("path");
const root=path.join(__dirname,".."),css=fs.readFileSync(path.join(root,"style.css"),"utf8"),html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const check=(ok,name)=>{assert(ok,name);console.log("PASS",name);};
for(const id of ["panelTabs","bufferDemo","bufferClear","studioRun","studioPassTabs","uniformSearch","studioDock","quickHelp"])check(html.includes(`id="${id}"`),id+" 존재");
check(css.includes("#bufferDemo")&&css.includes("#bufferClear")&&css.includes(".buffer-actions button"),"Render 예제/해제 버튼 스타일");
check(!css.includes("backdrop-filter")&&!css.includes("text-shadow")&&!css.includes("radial-gradient"),"번짐/글래스 블러 제거");
check(css.includes(".studio-top button.is-active")&&css.includes(".panel-tabs button.is-active"),"패스/패널 상태 구분");
check(css.includes("@media (max-width:600px)")||css.includes("@media (max-width: 600px)"),"모바일 접근성 유지");
console.log("UI Matte 정적 검사 통과");
