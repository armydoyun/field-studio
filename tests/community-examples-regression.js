require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/community-examples-regression.js — 갤러리 "커뮤니티 셰이더"(community-examples.js): 다른 사람의 작품이라
// 원작자·출처·라이선스가 빠지면 안 된다. 카드 정보(credit), 셰이더 맨 위 주석, docs/THIRD_PARTY_LICENSES.md가 서로 맞는지 본다.
// (GLSL 컴파일과 예전 실수 해시 금지는 examples-compile-browser-regression.py가 갤러리 전체와 함께 검사한다.)
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const root=path.join(__dirname,"..");
let Community;
vm.runInNewContext(fs.readFileSync(path.join(root,"js/community-examples.js"),"utf8"),{define:(deps,factory)=>Community=factory()},{filename:"community-examples.js"});
const licenses=fs.readFileSync(path.join(root,"docs/THIRD_PARTY_LICENSES.md"),"utf8");
const ALLOWED=new Set(["MIT","CC0","Permission"]); // 재배포를 허락하는 라이선스나 같은 뜻의 원작자 공개 허락(Permission)만 넣는다(문서의 기준과 같다)
let passed=0;const test=(name,fn)=>{fn();passed++;console.log("PASS",name);};
const items=Community.COMMUNITY;
const sources=item=>[item.image||item.project.image,...(item.project?.passes||[]).map(p=>p.fragment)];
test("커뮤니티 예제가 있고 id가 겹치지 않는다",()=>{
  assert(items.length>=12);assert.equal(new Set(items.map(x=>x.id)).size,items.length);
});
for(const item of items){
  test(`${item.title}: 카드에 원작자·원제목·출처·라이선스`,()=>{
    const c=item.credit;assert(c,"credit 없음");
    for(const key of ["author","work","url","license","licenseUrl"])assert(typeof c[key]==="string"&&c[key].trim(),`credit.${key}`);
    assert(ALLOWED.has(c.license),`허락된 라이선스만: ${c.license}`);assert.match(c.url,/^https:\/\//);
  });
  test(`${item.title}: 모든 셰이더 맨 위 주석에 원작자·라이선스·원본 주소`,()=>{
    for(const source of sources(item)){
      const header=source.split("\n").slice(0,8).join("\n");
      assert(header.startsWith("#version 300 es"));
      assert(header.includes(item.credit.author.split(" (")[0]),`원작자: ${item.credit.author}`);
      assert(header.includes(item.credit.license),`라이선스: ${item.credit.license}`);
      assert(header.includes(item.credit.url.replace(/\/$/,"")),`원본 주소: ${item.credit.url}`);
    }
  });
  test(`${item.title}: THIRD_PARTY_LICENSES.md 목록과 전문`,()=>{
    const row=licenses.split("\n").find(line=>line.startsWith(`| ${item.title} |`));
    assert(row,"목록에 없음");assert(row.includes(item.credit.url),"출처가 카드와 다름");assert(row.includes(item.credit.license),"라이선스가 카드와 다름");
    assert(licenses.includes(`## ${item.title} — ${item.credit.license}`),"라이선스 절 없음");
  });
}
for(const item of items){
  test(`${item.title}: 읽는 순서 — 3단계 이상, 가리키는 코드가 셰이더에 실제로 있고, 머리말(첫 uniform 앞)에 번호로 적혀 있다`,()=>{
    const steps=item.reading;assert(Array.isArray(steps)&&steps.length>=3,"reading 3단계 이상");
    const source=item.project?item.project.passes[0].fragment:item.image,lines=source.split("\n");
    const guide=lines.findIndex(line=>line.startsWith("// 읽는 순서 —")),firstUniform=lines.findIndex(line=>line.startsWith("uniform "));
    assert(guide>0&&guide<firstUniform,"읽는 순서가 머리말에");
    const code=lines.slice(firstUniform).join("\n");   // 안내 주석 자신이 아니라 실제 코드에서 찾는다
    steps.forEach((step,i)=>{
      assert(step.text&&step.text.length>10,`${i+1}단계 설명`);
      assert(code.includes(step.at),`${i+1}단계가 가리키는 코드가 없다: ${step.at}`);
      assert.equal(lines[guide+1+i],`//  ${i+1}. ${step.at}  →  ${step.text}`,`${i+1}단계 줄`);
    });
  });
}
test("MIT 작품은 저작권 줄을 셰이더와 문서에 모두 남긴다",()=>{
  for(const item of items.filter(x=>x.credit.license==="MIT")){
    for(const source of sources(item)){
      const line=source.match(/^\/\/ Copyright \(c\) \d{4}(?:-\d{4})? [^.]+\./m);assert(line,`${item.title}: 셰이더에 Copyright 줄 없음`);
      assert(licenses.includes(line[0].slice(3,-1)),`${item.title}: 문서에 같은 Copyright 줄 없음 (${line[0]})`);
    }
  }
  assert(licenses.includes("Permission is hereby granted, free of charge"),"MIT 전문");
});
console.log(`Community examples: ${passed} passed`);
