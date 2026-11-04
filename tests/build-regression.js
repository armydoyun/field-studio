// node tests/build-regression.js — 한 파일짜리 배포본(tools/build.mjs)을 임시 폴더에 만들어 검사한다.
//  · 정적 검사: 바깥 파일 참조 없음, 인라인 style·script, DOM id 보존, 크기
//  · 실행 검사: 만든 HTML을 file://로 Chromium에서 열어 앱이 오류 없이 뜨는지(playwright가 있을 때)
// esbuild·playwright가 없으면 SKIP하고 끝낸다. CI(환경 변수 CI)에서는 실패로 처리한다.
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
const missing=(name,hint)=>{
  if(process.env.CI){console.error(`FAIL ${name}이(가) 없습니다: ${hint}`);process.exit(1);}
  console.log(`SKIP ${name}이(가) 없어 건너뜁니다(${hint}). CI에서는 실패로 처리합니다.`);
};
const has=name=>{try{require.resolve(name);return true;}catch{return false;}};

(async()=>{
  if(!has('esbuild'))return missing('esbuild','npm install');
  const {build}=await import(pathToFileURL(path.join(root,'tools','build.mjs')).href);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'field-build-')),outFile=path.join(dir,'index.html');
  try{
    const result=await build({outFile});
    assert.deepEqual(result.removed,[],'임시 위치로 빌드할 때는 deploy/를 건드리지 않는다');
    assert.deepEqual(fs.readdirSync(dir),['index.html'],'결과는 파일 하나');
    const html=fs.readFileSync(outFile,'utf8'),source=fs.readFileSync(path.join(root,'index.html'),'utf8');
    const markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
    assert(!/\s(?:src|href)="\.?\//.test(markup),'바깥 파일(./style.css, ./js/…)을 참조하지 않는다');
    assert(!html.includes('type="module"'),'ES Module 스크립트가 남지 않는다');
    assert.equal((html.match(/<style>/g)||[]).length,1,'인라인 스타일 하나');
    assert(/<script>\/\*! FIELD Studio — includes CodeMirror 6, MIT License/.test(html),'인라인 앱 스크립트와 CodeMirror 저작권 고지');
    assert(html.includes('"use strict";'),'앱 스크립트는 strict mode');
    const ids=text=>[...text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
    assert.deepEqual(ids(html),ids(source),'마크업의 DOM id가 개발용 index.html과 같다');
    assert(result.bytes<3*1024*1024,`배포본 크기 ${result.bytes} bytes`);
    console.log(`PASS 단일 파일 배포본 ${(result.bytes/1024).toFixed(0)} KB (JS ${(result.jsBytes/1024).toFixed(0)} KB · CSS ${(result.cssBytes/1024).toFixed(0)} KB)`);

    if(!has('playwright'))return missing('playwright','npm install && npx playwright install chromium');
    const {chromium}=require('playwright');
    const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,
      args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    try{
      const context=await browser.newContext({viewport:{width:1440,height:900}}),errors=[],requests=[];
      // 첫 실행 안내(갤러리 모달)가 E 키를 가로채지 않게 한다.
      await context.addInitScript(()=>{try{localStorage.setItem('field.onboarded.v1','1');}catch(_){/* 저장소가 막혀도 테스트는 계속 */}});
      const page=await context.newPage();
      page.on('pageerror',error=>errors.push(error.message));
      page.on('request',request=>{if(!/^(file|data|blob):/.test(request.url()))requests.push(request.url());});
      await page.goto(pathToFileURL(outFile).href);
      // shaderStudio는 렌더러·UI 초기화가 끝까지 성공해야 생긴다(main.js). 실패하면 #status에 오류가 남는다.
      await page.waitForFunction(()=>window.shaderStudio&&window.shaderPlayground,null,{timeout:30000}).catch(()=>{});
      await page.waitForTimeout(500);
      const state=await page.evaluate(()=>({ready:!!window.shaderStudio,status:document.getElementById('status').textContent,
        width:document.getElementById('screen').width,styled:getComputedStyle(document.body).backgroundColor!=='rgba(0, 0, 0, 0)'}));
      assert(state.ready,`앱 초기화 성공 (#status: ${state.status})`);
      assert.deepEqual(errors,[],'file://에서 페이지 오류 없음');
      assert.deepEqual(requests,[],'네트워크 요청 없음(완전 오프라인)');
      assert(state.width>0,'캔버스 크기가 잡힌다');
      assert(state.styled,'인라인 CSS가 적용된다');
      // 편집기(CodeMirror)도 번들 안에서 뜨는지: E로 연다.
      await page.keyboard.press('e');
      await page.waitForSelector('.studio-cm-host .cm-editor',{timeout:10000});
      assert.deepEqual(errors,[],'편집기를 열어도 오류 없음');
      console.log('PASS file://로 연 배포본이 오류 없이 시작하고 편집기(CodeMirror)가 열린다');
      await context.close();
    }finally{await browser.close();}
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1);});
