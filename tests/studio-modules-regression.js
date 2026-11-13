// node tests/studio-modules-regression.js — studio.js에서 나눈 순수 모듈의 동작 검사(소스 문자열이 아니라 결과를 본다).
//   project-model · code-insert · storage · studio-examples · studio-pack · studio-layout
'use strict';
const path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),load=name=>import(pathToFileURL(path.join(root,'js',name+'.js')).href);
let passed=0;const check=(ok,label)=>{assert(ok,label);passed++;console.log('PASS',label);};
const SRC='#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main() {\n    fragColor = vec4(1.0);\n}\n';
const pass=(name,channels={})=>({name,fragment:SRC,format:'rgba8',scale:1,channels});

(async()=>{
  // ---- project-model ----
  const M=await load('project-model');
  const a={x:[1,{y:2}]},b=M.copy(a);
  check(M.same(a,b)&&b!==a&&b.x[1]!==a.x[1],'copy는 깊은 복사, same은 깊은 비교');
  check(M.same({p:1,q:2},{q:2,p:1})&&!M.same({p:1},{p:1,q:undefined})&&!M.same([1],{0:1}),'same: 키 순서 무관 · 키 수 · 배열/객체 구분');
  const project={image:SRC,passes:[pass('A'),pass('B',{0:{buffer:'A',frame:'current'}})],imageChannels:{0:{buffer:'B',frame:'current'},1:{texture:'img1'}}};
  check(M.same(M.validateProject(project),project)&&M.validateProject(project)!==project,'올바른 프로젝트는 복사본으로 통과');
  // #version은 생략할 수 있다(renderer가 컴파일 직전에 붙인다). 빈 소스 · 문자열이 아닌 소스는 거부한다.
  check(M.same(M.validateProject({...project,image:'out vec4 o;\nvoid main(){ o = vec4(1.0); }'}).image,'out vec4 o;\nvoid main(){ o = vec4(1.0); }'),'머리말 없는 Image 소스도 받는다');
  for(const [label,bad] of [['이미지 소스(빈 문자열)',{...project,image:'  \n'}],['이미지 소스(문자열 아님)',{...project,image:42}],['버퍼 9개',{...project,passes:'ABCDEFGHI'.split('').map(n=>pass(n))}],
    ['이름 중복',{...project,passes:[pass('A'),pass('A')]}],['Image 이름',{...project,passes:[pass('Image')]}],['형식',{...project,passes:[{...pass('A'),format:'rgb8'}]}],
    ['size 모양',{...project,passes:[{...pass('A'),size:[1]}]}],['imageChannels 배열',{...project,imageChannels:[]}]])
    assert.throws(()=>M.validateProject(bad),undefined,label);
  check(true,'잘못된 프로젝트 8가지를 거부');
  check(M.same(M.references(project,'A'),['B.iChannel0'])&&M.same(M.references(project,'B'),['Image.iChannel0']),'references: 버퍼를 읽는 채널 목록');
  check(M.validCurrent(project,'B','A')&&!M.validCurrent(project,'A','B')&&!M.validCurrent(project,'A','A')&&M.validCurrent(project,'Image','B'),'validCurrent: 앞선 버퍼만 current로 읽는다(Image는 모두)');
  const swapped=M.copy(project);swapped.passes.reverse();const changed=M.normalizeDependencies(swapped);
  check(M.same(changed,['B.iChannel0 ← A'])&&swapped.passes[0].channels[0].frame==='previous','normalizeDependencies: 순서가 바뀌면 current → previous');
  const detached=M.copy(project);
  check(M.detachMissing(detached,new Set())===1&&!detached.imageChannels[1]&&detached.imageChannels[0],'detachMissing: 없는 이미지 연결만 지운다');
  check(M.channelGroups(project).length===3,'channelGroups: 버퍼 수 + Image');

  // ---- code-insert ----
  const I=await load('code-insert');
  check(I.headerLength(SRC)===SRC.indexOf('out vec4'),'headerLength: precision 줄 끝까지');
  check(I.headerLength('#version 300 es\nvoid main(){}')==='#version 300 es\n'.length&&I.headerLength('void main(){}')===0,'headerLength: precision 없으면 #version 줄, 둘 다 없으면 0');
  check(I.stripComments('a/*{x}*/b//{\nc')==='a       b   \nc','stripComments: 같은 길이 공백으로 지운다');
  let edit=I.snippetEdit(SRC,0,0,'float k = 1.0;');
  check(edit.from===I.headerLength(SRC)&&edit.to===edit.from&&edit.text==='float k = 1.0;\n\n','snippetEdit: 머리 줄 앞 커서는 머리 줄 다음으로 옮긴다');
  const mid=SRC.indexOf('fragColor =')+3;edit=I.snippetEdit(SRC,mid,mid,'x');
  check(edit.text==='\nx\n','snippetEdit: 줄 중간이면 앞뒤로 줄을 띄운다');
  let out=I.codeEdit(SRC,SRC.indexOf('fragColor ='),{global:'float f(float x) { return x; }'});
  check(out.src.indexOf('float f(')<out.src.indexOf('void main')&&out.src.indexOf('float f(')>SRC.indexOf('precision'),'codeEdit: 함수 안 커서의 global 정의는 그 함수 선언 앞에');
  out=I.codeEdit(SRC,0,{main:'float v = 2.0;'});
  check(/void main\(\) \{\n {4}fragColor = vec4\(1\.0\);\n {4}float v = 2\.0;\n\}/.test(out.src)&&out.caret===out.src.indexOf('float v')+'float v = 2.0;\n'.length,'codeEdit: 함수 밖 커서의 main 코드는 main() 끝에, 커서는 넣은 코드 뒤');
  out=I.codeEdit('#version 300 es\n// void main() {\nvoid main() {\n}\n',0,{main:'a;'});
  check(out.src.endsWith('void main() {\n    a;\n}\n'),'codeEdit: 주석 속 main 선언은 무시한다');

  // ---- storage ----
  const S=await load('storage'),data=new Map();let blocked=false;const warn=console.warn;let warned=0;console.warn=()=>{warned++;};
  // 최신 Node는 자체 localStorage를 둘 수 있으므로 덮어써 가짜 저장소로 바꾼다.
  Object.defineProperty(globalThis,'localStorage',{configurable:true,writable:true,value:{getItem:k=>{if(blocked)throw new Error('blocked');return data.has(k)?data.get(k):null;},setItem:(k,v)=>{if(blocked)throw new Error('quota');data.set(k,String(v));},removeItem:k=>{if(blocked)throw new Error('blocked');data.delete(k);}}});
  try{
    check(S.write('k','v')===null&&S.read('k')==='v'&&S.writeJSON('j',{a:1})===null&&S.readJSON('j').a===1,'storage: 쓰기 성공은 null, 읽기는 값');
    data.set('bad','{broken');check(S.readJSON('bad','fallback')==='fallback'&&S.readJSON('none',7)===7,'storage: 깨졌거나 없는 JSON은 fallback');
    blocked=true;const error=S.write('k','w');
    check(error instanceof Error&&error.message==='quota'&&warned===1,'storage: 쓰기 실패는 오류를 돌려주고 콘솔에 경고한다(조용히 삼키지 않음)');
    check(S.read('k')===null&&S.readJSON('j',0)===0,'storage: 막힌 저장소 읽기는 값 없음');
    S.remove('k');check(true,'storage: 막힌 저장소 지우기는 예외 없이 지나간다');
  }finally{console.warn=warn;delete globalThis.localStorage;}

  // ---- studio-examples ----
  const E=await load('studio-examples'),pipeline=E.pipelineProject(),feedback=E.feedbackProject();
  check(M.same(M.validateProject(pipeline),pipeline)&&M.same(M.validateProject(feedback),feedback),'예제 프로젝트는 프로젝트 규칙을 지킨다');
  check(E.pipelineProject()!==pipeline&&E.pipelineProject().passes!==pipeline.passes,'예제 프로젝트는 부를 때마다 새 객체(공유 상태 없음)');
  check(feedback.passes[1].channels[1].frame==='previous'&&M.validCurrent(feedback,'B','A'),'피드백 예제: B는 자기 자신을 previous로, A를 current로 읽는다');
  check(E.blank.startsWith('#version 300 es'),'새 버퍼의 시작 코드');

  // ---- studio-pack ----
  const P=await load('studio-pack');
  const withImages={...M.copy(project),passes:[pass('A',{0:{texture:'img2'},1:{texture:'img1'}})],imageChannels:{0:{texture:'img1'}}};
  check(M.same(P.textureIds(withImages),['img2','img1']),'textureIds: 연결된 이미지 ID, 중복 없이 나온 순서대로');
  const png='data:image/png;base64,'+Buffer.from([137,80,78,71]).toString('base64');
  const textures=[{id:'img1',name:'a.png',type:'image/png',data:png},{id:'img2',name:'b.png',type:'image/png',data:png,sampling:{filter:'nearest'}}];
  const text=P.encode({project:withImages,selected:'A',textures});
  let parsed=P.parse(text);
  check(parsed.data.version===2&&!('settings' in parsed.data)&&M.same(parsed.project,withImages)&&parsed.data.selected==='A','encode/parse: 설정 없으면 version 2, 프로젝트 그대로');
  check(JSON.parse(P.encode({project:withImages,selected:'Image',textures:[],settings:{user:[]}})).version===3,'encode: 설정이 있으면 version 3');
  for(const [label,bad] of [['버전',{version:9,project:withImages,textures:[]}],['textures 배열 아님',{version:2,project:withImages,textures:{}}],
    ['이미지 37개',{version:2,project:withImages,textures:Array(37).fill(textures[0])}],['프로젝트',{version:2,project:{image:'x'},textures:[]}]])
    assert.throws(()=>P.parse(JSON.stringify(bad)),undefined,label);
  check(true,'parse: 잘못된 Pack 4가지를 거부');
  const {ids,decoded}=P.decodeTextures(textures);
  check(ids.size===2&&decoded[0].file instanceof File&&decoded[0].file.size===4&&decoded[0].file.type==='image/png'&&decoded[1].sampling.filter==='nearest','decodeTextures: base64를 File로 푼다');
  for(const [label,bad] of [['ID 중복',[textures[0],textures[0]]],['ID 모양',[{...textures[0],id:'1x'}]],['형식',[{...textures[0],type:'image/gif',data:png.replace('png','gif')}]],
    ['data 머리',[{...textures[0],data:png.replace('image/png','image/jpeg')}]],['base64 글자',[{...textures[0],data:'data:image/png;base64,@@@@'}]],['이름 길이',[{...textures[0],name:'n'.repeat(129)}]]])
    assert.throws(()=>P.decodeTextures(bad),undefined,label);
  check(true,'decodeTextures: 잘못된 이미지 항목 6가지를 거부');
  P.checkReferences(withImages,ids);
  assert.throws(()=>P.checkReferences(withImages,new Set(['img1'])),/img2/);check(true,'checkReferences: Pack에 없는 이미지를 읽으면 그 ID로 오류');
  const trial=P.withoutTextures(withImages);
  check(!P.textureIds(trial).length&&P.textureIds(withImages).length===2,'withoutTextures: 이미지 연결만 뺀 복사본(원본은 그대로)');
  const remapped=P.remapTextures(M.copy(withImages),new Map([['img1','t9'],['img2','t8']]));
  check(M.same(P.textureIds(remapped),['t8','t9']),'remapTextures: 새로 등록한 ID로 바꾼다');
  const meta=id=>({id,name:id,sampling:{}}),big={size:20*1024*1024};
  check(P.collectTextures(withImages,[meta('img1'),meta('img2')],()=>({size:1})).map(x=>x.id).join()==='img2,img1','collectTextures: 연결된 이미지와 원본 파일');
  assert.throws(()=>P.collectTextures(withImages,[meta('img1')],()=>({size:1})),/img2/);
  assert.throws(()=>P.collectTextures(withImages,[meta('img1'),meta('img2')],()=>big),/32MB/);
  check(true,'collectTextures: 원본이 없거나 합계 32MB를 넘으면 오류');

  // ---- project-store (이름 규칙 · IndexedDB 없는 환경) ----
  const PS=await load('project-store');
  check(PS.cleanName('  내   셰이더\n작업 ')==='내 셰이더 작업','cleanName: 앞뒤 공백 제거, 연속 공백·줄바꿈은 한 칸');
  assert.throws(()=>PS.cleanName('   '),/이름/);assert.throws(()=>PS.cleanName('x'.repeat(PS.NAME_LIMIT+1)),/이하/);
  check(true,'cleanName: 빈 이름과 너무 긴 이름은 거부');
  const hadIDB='indexedDB' in globalThis,oldIDB=globalThis.indexedDB;
  try{Object.defineProperty(globalThis,'indexedDB',{configurable:true,writable:true,value:undefined});
    await assert.rejects(PS.create().list(),/IndexedDB/);check(true,'IndexedDB가 없으면 list()는 안내 오류로 거부(예외로 멈추지 않음)');}
  finally{if(hadIDB)globalThis.indexedDB=oldIDB;else delete globalThis.indexedDB;}

  // ---- studio-layout (창 크기에 따른 기본값) ----
  const L=await load('studio-layout'),hadWindow='window' in globalThis,oldWindow=globalThis.window;
  try{
    const size=(w,h,narrow=false)=>{globalThis.window={innerWidth:w,innerHeight:h,matchMedia:()=>({matches:narrow})};};
    size(1440,900);check(L.fitLayout()==='right','fitLayout: 넓은 창은 옆 배치');
    size(1000,500);check(L.fitLayout()==='right','fitLayout: 가로로 길고 낮은 창(4분할)도 옆 배치');
    size(1000,900);check(L.fitLayout()==='bottom','fitLayout: 그 밖에는 아래 배치');
    size(1440,900,false);check(L.responsiveHeight()===55,'responsiveHeight: 보통 창은 55%');
    size(500,600,true);check(L.responsiveHeight()===75,'responsiveHeight: 좁거나 낮은 창은 75%');
  }finally{if(hadWindow)globalThis.window=oldWindow;else delete globalThis.window;}
  // ---- dock-drag (끌어 놓을 자리 고르기) ----
  const D=await load('dock-drag'),R={left:100,top:50,width:400,height:200};
  check(D.pickSide(R,110,150)==='left'&&D.pickSide(R,495,150)==='right'&&D.pickSide(R,300,55)==='top'&&D.pickSide(R,300,245)==='bottom','pickSide: 가장 가까운 가장자리');
  check(D.pickSide(R,90,150)===null&&D.pickSide(R,300,260)===null&&D.pickSide({left:0,top:0,width:0,height:0},0,0)===null,'pickSide: 영역 밖·빈 영역이면 null(놓아도 바꾸지 않음)');
  check(D.pickSide(R,300,55,['left','right'])==='left'&&D.pickSide(R,320,55,['left','right'])==='right','pickSide: 허용한 자리(패널은 왼쪽·오른쪽) 중에서만 고른다');
  // ---- workspace-layout (설정 패널 너비 한계) ----
  const W=await load('workspace-layout');
  check(W.clampWidth(100,1440)===240&&W.clampWidth(420,1440)===420&&W.clampWidth(900,1440)===560,'패널 너비: 240px–560px');
  check(W.clampWidth(500,900)===405&&W.maxWidth(900)===405,'패널 너비: 창 너비의 45%를 넘지 않는다(미리보기 자리 확보)');
  check(W.clampWidth(500,400)===240,'패널 너비: 아주 좁은 창에서도 최소 240px');
  console.log(`studio modules: ${passed} checks passed`);
})().catch(error=>{console.error(error);process.exit(1);});
