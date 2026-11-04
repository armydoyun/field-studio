require('./esm-vm-bridge.cjs'); // Test-only ESM mock adapter.
// node tests/default-template-regression.js — 범용 시작 GLSL과 Ray Marching 프리셋 분리 검사.
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const root=path.join(__dirname,".."),source=fs.readFileSync(path.join(root,"js/shader.js"),"utf8");
let sourceDeps,shader;vm.runInNewContext(source,{define:(deps,fac)=>{sourceDeps=deps;shader=fac();}});
assert.deepStrictEqual(Array.from(sourceDeps),[],"기본 셰이더는 다른 AMD 모듈을 읽지 않음");
assert.strictEqual(shader.vertex.startsWith("#version 300 es"),true);
assert.strictEqual(shader.fragment.startsWith("#version 300 es"),true);
assert(shader.fragment.includes("uTime") && shader.fragment.includes("uMouse") && !shader.fragment.includes("SDFResult"),"기본 셰이더는 범용 Shader Art");
const sectionNames=["SDF 도형","기본 장면","Ray Marching","카메라와 화면 출력"];
for(const name of sectionNames)assert.strictEqual(shader.raymarch.split(`// --- ${name} ---`).length,2,`Ray 프리셋 섹션 누락: ${name}`);
for(const term of ["sdSphere(","sdBox(","SDFResult map(","getAlbedo(","rayMarch(","calcNormal(","cameraBasis(","shade("])
  assert(shader.raymarch.includes(term),`Ray GLSL 누락: ${term}`);
for(const [name,type] of shader.rayUniforms)assert(shader.raymarch.includes(name) && ["int","float","bool"].includes(type),`프리셋 Uniform ${name}`);
assert(shader.rayUniforms.length===5,"Ray 프리셋 Uniform 5개");
assert(!shader.raymarch.includes("uCameraOrbit") && !("orbitHome" in shader),"Orbit 카메라 Uniform 제거");
assert(shader.raymarchPasses.length===1 && shader.raymarchPasses[0].channels[1].keyboard===true && shader.raymarchChannels[0].buffer==="A","카메라는 키보드 채널을 읽는 Buffer A가 저장");
assert(!fs.existsSync(path.join(root,"js/shaders")),"기존 예제 파일 제거 확인");
console.log("PASS 범용 시작 셰이더 + Ray Marching Starter GLSL 분리");
