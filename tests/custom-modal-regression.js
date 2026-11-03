// node tests/custom-modal-regression.js — 기본 prompt/confirm 제거 및 단일 커스텀 모달 연결 검사
"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert"),{execFileSync}=require("child_process");
const root=path.join(__dirname,".."),read=file=>fs.readFileSync(path.join(root,file),"utf8");
const html=read("index.html"),css=read("style.css"),studio=read("js/studio.js"),editor=read("js/cm-editor.js")+read("js/cm-glsl-features.js");
let passed=0;const check=(condition,label)=>{assert.ok(condition,label);console.log("PASS",label);passed++;};
for(const id of ["studioPromptDialog","studioDialogForm","studioDialogTitle","studioDialogMessage","studioDialogField","studioDialogInput","studioDialogOK","studioDialogCancel","studioDialogClose"])
  check((html.match(new RegExp(`id="${id}"`,"g"))||[]).length===1,`모달 요소 고유 ID ${id}`);
check(html.includes('<dialog id="studioPromptDialog"')&&html.includes('method="dialog"'),"접근 가능한 네이티브 모달");
check(css.includes(".studio-prompt-dialog::backdrop")&&css.includes('data-danger="true"'),"매트 테마/위험 확인 스타일");
check(!/(?:window\.)?(?:prompt|confirm|alert)\s*\(/.test(studio+editor),"기본 입력/확인 대화상자 미사용");
// 편집기는 studio의 모달 함수 ask를 받아 이름 바꾸기 등에 쓴다(GLSL 도우미까지 전달).
check(studio.includes('Editor.mount($("studioCode"),ask')&&editor.includes("const mount = (textarea, ask")&&editor.includes("Features.create({CM, language, options, ask")&&editor.includes("await ask({title:"),"단일 모달 함수의 편집기 공유");
check(studio.includes("valueInput.disabled=!hasValue")&&studio.includes("valueInput.reportValidity()"),"숫자 입력 제한·숨김 입력 제외");
check(studio.includes('on(dialog,"cancel"')&&studio.includes('on(dialog,"keydown"'),"Esc 취소 및 하위 키 전달 방지");
check(studio.includes('if(!await confirmReplace())')&&studio.includes('proceed(confirmReplace()'),"비동기 확인과 기존 동기 API 호환");
check(studio.includes("const wasLive=!!timer")&&studio.includes("if(wasLive&&dirty"),"모달 표시 중 자동 적용 타이머 정지/복구");
for(const file of ["js/studio.js","js/cm-editor.js","js/cm-glsl-features.js"])execFileSync(process.execPath,["--check",path.join(root,file)]);
console.log(`커스텀 모달 구조 검증 ${passed}개 통과`);
