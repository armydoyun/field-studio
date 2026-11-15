const assert = require('node:assert/strict');
(async () => {
  const A = await import('../js/annotations.js');
  const P = await import('../js/parameter-tools.js');
  assert(!P.equalValue(1e-8,2e-8), 'small HDR edits remain distinct');
  assert(P.equalValue([1,0.1],[1,0.1+Number.EPSILON*0.1]), 'relative floating-point precision');
  assert(!P.equalValue(2147483646,2147483647), 'large integers differing by one remain distinct');
  assert(!P.equalValue([1,2],[1,2,3]), 'array shape is significant');
  assert(!P.equalValue(false,0), 'boolean and number types differ');
  assert(P.changedFromDefault({type:'float',value:1}), 'missing defaults need code reflection');
  assert(!P.changedFromDefault({type:'float',value:1,options:{min:1,max:2}}, {type:'float',value:0}), 'default comparison uses the same range clamping as reset');
  const parse = expression => A.collect([`uniform float uValue; // @if ${expression}`])[0];
  const values = new Map([['uMode', 2], ['uOn', true], ['uOther', false]]);
  const visible = expression => A.visible(parse(expression).when, name => values.get(name));
  assert(visible('uMode == 2 && uOn'));
  assert(!visible('uMode == 1 && uOn'));
  assert(visible('uOther && uOn || uMode == 2'));
  assert(visible('uMode == 2 || uOther && !uOn'));
  assert(!visible('uOther || uMode == 1 && uOn'));
  assert(parse('uOn && uValue > 0').error.includes('자기 자신'));
  for (const expr of ['uOn &&', '|| uOn', 'uOn & uOther', 'uOn ||| uOther', 'uMode === 2', '(uOn)'])
    assert(parse(expr).error, expr);
  const enumSpec = A.collect(['uniform int uMode; // @enum A B C'])[0];
  assert(A.visible(parse('uMode == C && uOn').when, name => values.get(name), new Map([['uMode', enumSpec]])));
  const src = 'uniform highp float uA, uB; // 설명 · @range 0 10 @default 1 @group 빛\r\n' +
    'uniform vec2 uPair[2]; // @default 0\n' +
    'uniform bool uOn;\n/*\nuniform float uA; // @default 1\n*/';
  const users = [{name:'uA',type:'float',value:3.141592653589793},
    {name:'uPair',type:'vec2[2]',value:[1,2,3,4]}, {name:'uOn',type:'bool',value:true}];
  const rewritten = P.writeDefaults(src, users);
  const specs = A.collect([rewritten]);
  assert.equal(specs.find(s=>s.name==='uA').value, Math.PI);
  assert.equal(specs.find(s=>s.name==='uB').value, 1);
  assert.equal(specs.find(s=>s.name==='uA').description, '설명');
  assert.equal(specs.find(s=>s.name==='uA').group, '빛');
  assert.deepEqual(specs.find(s=>s.name==='uPair').value, [1,2,3,4]);
  assert.equal(specs.find(s=>s.name==='uOn').value, true);
  assert(rewritten.includes('/*\nuniform float uA; // @default 1\n*/'));
  assert.equal(P.writeDefaults(rewritten, users), rewritten);
  assert.equal(P.writeDefaults('uniform int uA; // @default 1', users), 'uniform int uA; // @default 1');
  const item = {type:'float', value:5, options:{min:0,max:10,step:0.25}};
  assert.equal(P.varyValue(item, false, ()=>0), 0);
  assert.equal(P.varyValue(item, false, ()=>1), 10);
  assert.equal(P.varyValue(item, true, ()=>0), 4.5);
  assert.equal(P.varyValue(item, true, ()=>1), 5.5);
  assert.equal(P.varyValue({type:'float',value:-20},true,()=>0),-22);
  assert.equal(P.varyValue({type:'bool',value:false},false,()=>1),true);
  assert.equal(P.varyValue({type:'uint',value:0},true,()=>0),0);
  const direction = P.varyValue({type:'vec3',value:[0,1,0],options:{dir:'hemi'}},false,()=>0);
  assert(Math.abs(Math.hypot(...direction)-1)<1e-9 && direction[1]>=0);
  assert.deepEqual(P.varyValue({type:'vec2',value:[0,0],options:{ranges:[[0,1,.1],[-5,5,1]]}},false,()=>1),[1,5]);
  assert.deepEqual(P.varyValue({type:'vec4',value:[2,1,0,0.5],options:{color:true,hdr:10}},false,()=>1),[10,10,10,1]);
  console.log('PASS compound conditions, default source roundtrips and constrained random/jitter values');
})().catch(error => { console.error(error); process.exitCode = 1; });
