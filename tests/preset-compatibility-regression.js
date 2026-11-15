const assert=require('node:assert/strict');
(async()=>{
  const P=await import('../js/presets.js');
  const users=[
    {name:'uGain',type:'float',value:0.2,options:{min:0,max:1,step:0.01}},
    {name:'uTint',type:'vec4',value:[1,1,1,1],options:{color:true}},
    {name:'uMode',type:'int',value:0,options:{enum:['A','B'],min:0,max:1}},
    {name:'uRamp',type:'sampler2D',value:[0,0,1,1],options:{curve:'linear'}},
    {name:'uLinked',type:'float',value:1,options:{}},
  ];
  const previous=[users[0],{name:'uTint',type:'vec3',value:[0.2,0.3,0.4]},
    {...users[2],options:{enum:['B','A']}},
    {name:'uRamp',type:'sampler2D',value:[0,0,0,0,1,1,1,1,1,1],options:{gradient:'linear'}},users[4],
    {name:'uRemoved',type:'float',value:1}];
  const preset=P.validate([P.capture('before',previous)])[0];
  const result=P.plan(users,preset,[{name:'uLinked'}]);
  assert.deepEqual(result.applied.map(x=>x.name),['uGain']);
  assert.equal(result.skipped.length,5);assert.equal(result.legacy,false);
  for(const reason of ['타입 변경','선택지','종류','연결','없는'])assert(result.skipped.some(x=>x.reason.includes(reason)),reason);
  const legacy={name:'old',values:{uGain:0.5,uTint:[0.1,0.2,0.3,1],uLinked:false}};
  assert.equal(P.validate([legacy])[0].schema,undefined);
  const old=P.plan(users,legacy);assert(old.legacy);assert.equal(old.applied.length,2);assert.equal(old.skipped.length,1);
  assert.equal(P.plan(users,{name:'range',values:{uGain:2}}).applied.length,0);
  const shape=P.plan([{name:'uM',type:'mat2',value:[1,0,0,1]}],P.capture('old',[{name:'uM',type:'vec4',value:[1,2,3,4]}]));
  assert.equal(shape.skipped.length,1,'same component count is insufficient when types differ');
  for(const [type,value] of [['bool',1],['uint',-1],['int',2147483648],['uint',4294967296],['vec2',[1]],['bvec2',[true,1]]])
    assert.equal(P.plan([{name:'uX',type,value:0}],{name:'bad',values:{uX:value}}).applied.length,0,type);
  const big=P.capture('big',[{name:'uM',type:'mat4[64]',value:Array(1024).fill(1)}]);
  assert.equal(P.validate([big])[0].values.uM.length,1024,'all supported matrix array components survive saving');
  const captured=P.capture('copy',[users[2]]),copy=P.validate([captured])[0];copy.schema.uMode.enum[0]='changed';assert.equal(captured.schema.uMode.enum[0],'A');
  assert.throws(()=>P.validate([{name:'bad',values:{uX:1},schema:{uX:{type:'samplerCube'}}}]),/타입 정보/);
  const direction={name:'uD',type:'vec3',value:[0,1,0],options:{dir:'hemi'}};
  assert.equal(P.plan([direction],{name:'zero',values:{uD:[0,0,0]}}).applied.length,0);
  assert.deepEqual(P.plan([direction],{name:'dir',values:{uD:[0,-2,0]}}).applied[0].value,[0,1,0]);
  const opposite=P.blendValue({type:'vec2[2]',options:{dir:'full'}},[1,0,0,1],[-1,0,0,-1],0.5);
  assert.deepEqual(opposite,[-1,0,0,-1],'opposite array directions never pass through an invalid zero vector');
  const before=JSON.stringify({users,preset});P.plan(users,preset);assert.equal(JSON.stringify({users,preset}),before,'planning is read-only');
  console.log('PASS preset types, enum/ramp changes, partial application, legacy shape validation, bounds, direction arrays, large matrices and immutable snapshots');
})().catch(error=>{console.error(error);process.exitCode=1;});
