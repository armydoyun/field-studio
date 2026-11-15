const assert=require('node:assert/strict');
(async()=>{
  const A=await import('../js/annotations.js');
  const cases=[
    ['bool token','uniform bool uBad; // @default maybe'],
    ['nonfinite default','uniform float uBad; // @default NaN'],
    ['integer fraction','uniform int uBad; // @default 1.5'],
    ['signed overflow','uniform int uBad; // @default 2147483648'],
    ['unsigned negative','uniform uint uBad; // @default -1'],
    ['unsigned overflow','uniform uint uBad; // @default 4294967296'],
    ['extra components','uniform vec2 uBad; // @default 1 2 3'],
    ['reversed range','uniform float uBad; // @range 2 1'],
    ['zero step','uniform float uBad; // @range 0 1 0'],
    ['step without range','uniform float uBad; // @step 0.1'],
    ['integer fractional range','uniform int uBad; // @range 0 2 0.5'],
    ['bool range','uniform bool uBad; // @range 0 1'],
    ['wrong color type','uniform vec2 uBad; // @color'],
    ['empty array','uniform float uBad[0]; // @default 1'],
    ['huge array','uniform float uBad[4294967295]; // @default 1'],
  ];
  const missing=cases.filter(([,line])=>!A.collect([line])[0]?.error).map(([label])=>label);
  assert.deepEqual(missing,[],'invalid annotations must be rejected individually before renderer registration');
  const code='/*\nuniform float uGhost; // @default 3\n*/\nuniform float uLive; // text /* inside a line comment @default 1\n/* closed */ uniform float uNext; // @default 2';
  assert.deepEqual(A.collect([code]).map(s=>s.name),['uLive','uNext']);
  assert.equal(A.collect(['/* never closed\nuniform float uGhost; // @default 1']).length,0);
  assert.equal(A.collect(['/* never closed','uniform float uReal; // @default 1'])[0].name,'uReal','block state is independent per pass');
  assert.deepEqual(A.clampValue([0,2,-1,0,1,1,1,1,1,1],{gradient:'linear'}),[0,1,0,0,1,1,1,1,1,1],'gradient defaults use renderer color normalization');
  for(const line of ['uniform bool uOk; // @default 1','uniform uint uOk; // @default 4294967295','uniform int uOk; // @default -2147483648','uniform vec2 uOk[2]; // @default 1 2 3 4'])
    assert.equal(A.collect([line])[0].error,null,line);
  console.log(`PASS ${cases.length} invalid annotation cases, block comments, per-pass isolation and valid boundary defaults`);
})().catch(error=>{console.error(error);process.exitCode=1;});
