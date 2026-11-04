// node tests/custom-modal-regression.js — 기본 prompt/confirm 제거 및 단일 커스텀 모달 연결 검사
"use strict";
const path=require("path"),assert=require("assert"),{execFileSync}=require("child_process");
const {root,read,code,has}=require("./source-check.cjs");
// 대화상자 본체는 js/studio-dialog.js, 자동 적용 타이머 연결은 js/studio.js에 있다.
// 소스 조각은 has()로 찾는다(띄어쓰기·따옴표·줄바꿈이 바뀌어도 맞는다). 대화상자 동작 자체는 modal-enter-regression.js가 본다.
const html=read("index.html"),css=read("style.css"),dialog=code("js/studio-dialog.js"),studio=code("js/studio.js","js/studio-dialog.js"),editor=code("js/cm-editor.js","js/cm-glsl-features.js");
const rawScripts=read("js/studio.js")+read("js/studio-dialog.js")+read("js/cm-editor.js")+read("js/cm-glsl-features.js");
let passed=0;const check=(condition,label)=>{assert.ok(condition,label);console.log("PASS",label);passed++;};
for(const id of ["studioPromptDialog","studioDialogForm","studioDialogTitle","studioDialogMessage","studioDialogField","studioDialogInput","studioDialogOK","studioDialogCancel","studioDialogClose"])
  check((html.match(new RegExp(`\\bid\\s*=\\s*"${id}"`,"g"))||[]).length===1,`모달 요소 고유 ID ${id}`);
check(has(code("index.html"),'<dialog id="studioPromptDialog"','method="dialog"'),"접근 가능한 네이티브 모달");
check(css.includes(".studio-prompt-dialog::backdrop")&&has(code("style.css"),'data-danger="true"'),"매트 테마/위험 확인 스타일");
check(!/(?:window\.)?(?:prompt|confirm|alert)\s*\(/.test(rawScripts),"기본 입력/확인 대화상자 미사용");
// 편집기는 studio의 모달 함수 ask를 받아 이름 바꾸기 등에 쓴다(GLSL 도우미까지 전달).
check(has(studio,'Editor.mount($("studioCode"),ask')&&has(editor,"const mount = (textarea, ask","Features.create({CM, language, options, ask","await ask({title:"),"단일 모달 함수의 편집기 공유");
check(has(dialog,"valueInput.disabled=!hasValue","valueInput.reportValidity()"),"숫자 입력 제한·숨김 입력 제외");
check(has(dialog,'on(dialog,"cancel"','on(dialog,"keydown"'),"Esc 취소 및 하위 키 전달 방지");
check(has(studio,"Dialog.create({$, on,","const ask = dialogs.ask;"),"studio는 공용 대화상자 모듈 하나만 만든다");
check(has(studio,"if(!await confirmReplace())","proceed(confirmReplace()"),"비동기 확인과 기존 동기 API 호환");
check(has(studio,"const wasLive=!!timer","if(wasLive&&dirty"),"모달 표시 중 자동 적용 타이머 정지/복구");
for(const file of ["js/studio.js","js/studio-dialog.js","js/cm-editor.js","js/cm-glsl-features.js"])execFileSync(process.execPath,["--check",path.join(root,file)]);
console.log(`커스텀 모달 구조 검증 ${passed}개 통과`);
