// 컴파일 직전에 사용자 GLSL을 다듬는다. 편집기의 코드는 그대로 두고, GPU에 보내는 소스만 바꾼다.
//
//  1. 짧은 머리말: 코드에 #version이 없으면 "#version 300 es"와 "precision highp float;"을 붙인다.
//     precision은 첫 "코드" 줄 바로 앞에 넣는다(#extension 같은 전처리 줄은 그보다 앞에 있어야 하므로).
//  2. 가짜 진입점: void main()이 없고 void mainImage(out vec4, in vec2)가 있으면 Shadertoy처럼
//     main()을 만들어 mainImage(색, gl_FragCoord.xy)를 부르고 그 색을 출력한다.
//     출력 변수(out vec4 …;)를 이미 선언했으면 그 변수에 쓰고, 없으면 하나 만든다.
//     여러 출력(MRT): mainImage(out vec4 a, out vec4 b, …, in vec2 fragCoord)처럼 out vec4를 여러 개 받으면
//     매개변수 순서대로 출력 0, 1, …이 된다(layout(location = N) out vec4를 만들어 연결한다).
//     같은 수의 출력을 이미 선언해 두었으면 location 순서대로 그 변수들에 쓴다.
//  3. 사용자 Uniform 선언(파라미터 패널에 등록했지만 코드에 없는 것)을 precision 뒤에 넣는다.
//  4. Shadertoy 이름: 코드가 iTime · iTimeDelta · iFrame · iResolution · iMouse를 선언 없이 쓰면
//     FIELD Uniform(uTime · uDeltaTime · uFrame · uResolution · uMouse)에 #define으로 연결하고,
//     그 FIELD Uniform이 코드에 없으면 선언도 넣는다. 선언 줄과 같은 자리(3번 뒤)에 들어간다.
//     코드가 그 이름을 직접 선언했거나(#define · 변수 · 매개변수) 쓰지 않으면 아무것도 넣지 않는다.
//
// 줄 번호: 넣은 줄 때문에 컴파일 오류의 줄 번호가 어긋나지 않도록 #line으로 사용자 코드의 줄 번호를 되돌린다
// (GLSL ES 3.00: "#line N" 다음 줄이 N번 줄). 그래서 짧은 머리말 경로에서는 오류 줄이 편집기 줄과 바로 같다.
// #version이 있는 코드는 예전과 같이 precision 뒤에 Uniform 선언을 넣고, 그 위치를 injected로 알려 studio가 줄을 되돌린다.

// 주석을 같은 길이의 공백으로 바꾼다(줄 수와 위치는 그대로) — 선언·진입점 검색이 주석 속 글자에 속지 않게.
const blankComments = source => source.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*/g, s => s.replace(/[^\r\n]/g, " "));

const OUT_NAME = "field_FragColor_";
const hasMain = code => /\bvoid\s+main\s*\(\s*(?:void\s*)?\)/.test(code);
const mainImageAt = code => /\bvoid\s+mainImage\s*\(/.exec(code);
// 전역 출력 선언(layout(location = N) out vec4 이름;)들을 location 순서로. 함수 매개변수(out vec4 c, …)는 ; 로 끝나지 않으므로 걸리지 않는다.
const globalOuts = code =>
  [
    ...code.matchAll(
      /(?:^|[;{}\n])\s*(?:layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*)?out\s+(?:(?:lowp|mediump|highp)\s+)?vec4\s+([A-Za-z_]\w*)\s*;/g
    ),
  ]
    .map(m => ({ location: Number(m[1] ?? 0), name: m[2] }))
    .sort((a, b) => a.location - b.location);
// mainImage의 출력 매개변수(out vec4 …) 수. 매개변수 목록에는 괄호가 없으므로 첫 ')'까지가 목록이다.
const outputCount = (code, at) => {
  const open = code.indexOf("(", at),
    close = code.indexOf(")", open);
  const params = code.slice(open + 1, close < 0 ? undefined : close).split(",");
  return Math.max(1, params.filter(p => /^\s*out\s+(?:(?:lowp|mediump|highp)\s+)?vec4\b/.test(p)).length);
};
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// mainImage를 부르는 main(). lineNumber = 오류가 나면 가리킬 줄(mainImage 정의 줄, 컴파일러 기준).
// 한 줄에 모두 적어, 진입점에서 난 오류(예: mainImage 모양이 다름)가 모두 mainImage 정의 줄을 가리키게 한다.
const entryPoint = (code, lineNumber, at) => {
  const count = outputCount(code, at),
    declared = globalOuts(code);
  if (count === 1) {
    const target = declared[0]?.name;
    const declare = target ? "" : `out vec4 ${OUT_NAME}; `;
    const output = target || OUT_NAME;
    return `\n#line ${lineNumber}\n${declare}void main() { vec4 color = vec4(0.0, 0.0, 0.0, 1.0); mainImage(color, gl_FragCoord.xy); ${output} = color; }\n`;
  }
  // 여러 출력: 이미 같은 수를 선언했으면 그 변수들(location 순), 아니면 출력 N마다 하나씩 만든다.
  const reuse = declared.length === count;
  const names = Array.from({ length: count }, (_, i) => (reuse ? declared[i].name : `field_FragColor${i}_`));
  const declare = reuse ? "" : names.map((name, i) => `layout(location = ${i}) out vec4 ${name}; `).join("");
  const colors = names.map((_, i) => `color${i}`);
  return (
    `\n#line ${lineNumber}\n${declare}void main() { vec4 ${colors.map(c => `${c} = vec4(0.0, 0.0, 0.0, 1.0)`).join(", ")}; ` +
    `mainImage(${colors.join(", ")}, gl_FragCoord.xy); ${names.map((name, i) => `${name} = ${colors[i]};`).join(" ")} }\n`
  );
};

// 코드에서 uniform으로 선언한 이름의 타입(없으면 null). uniform vec2 a, b; 처럼 한 줄에 여럿 선언해도 찾는다.
const uniformType = (code, name) => {
  for (const m of code.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+([^;{}]+);/g))
    if (m[2].split(",").some(part => part.trim().match(/^[A-Za-z_]\w*/)?.[0] === name)) return m[1];
  return null;
};
// Shadertoy 이름 → FIELD Uniform. link(선언된 FIELD 타입) = #define 본문, declare = FIELD Uniform이 없을 때 넣을 선언.
// iResolution은 Shadertoy에서 vec3이다. uResolution을 vec2·vec3 어느 쪽으로 선언해도 .xy로 맞춘다.
const SHADERTOY = [
  { name: "iTime", field: "uTime", declare: "float", link: () => "uTime" },
  { name: "iTimeDelta", field: "uDeltaTime", declare: "float", link: () => "uDeltaTime" },
  { name: "iFrame", field: "uFrame", declare: "int", link: type => (type === "int" ? "uFrame" : "int(uFrame)") },
  { name: "iResolution", field: "uResolution", declare: "vec2", link: () => "vec3(uResolution.xy, 1.0)" },
  {
    name: "iMouse",
    field: "uMouse",
    declare: "vec4",
    link: type => (type === "vec2" ? "vec4(uMouse, 0.0, 0.0)" : "uMouse"),
  },
];
// 코드가 이 이름을 직접 정의했는가: #define, 또는 타입 바로 뒤에 온 이름(전역·지역 변수, 함수 매개변수, uniform).
const definesName = (code, name) =>
  new RegExp(`#\\s*define\\s+${name}\\b`).test(code) ||
  new RegExp(`\\b(?:float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?)\\s+${name}\\b`).test(code);
// 넣을 줄: FIELD Uniform 선언(없을 때만)과 #define.
const shadertoyLines = code => {
  const lines = [];
  for (const { name, field, declare, link } of SHADERTOY) {
    if (!new RegExp(`\\b${name}\\b`).test(code) || definesName(code, name)) continue;
    const type = uniformType(code, field);
    if (!type) lines.push(`uniform ${declare} ${field};`);
    lines.push(`#define ${name} ${link(type || declare)}`);
  }
  return lines;
};

// Common 코드 묶음: GLSL의 "#line 줄 소스번호"로 Common 줄을 소스 1번의 1번 줄부터 세게 한다.
// 그래서 Common에서 난 오류는 "ERROR: 1:줄:"로 나오고(패스 코드는 소스 0번), studio가 Common 탭의 그 줄로 보낸다.
// resume = 묶음 다음 줄이 컴파일러에서 가질 줄 번호(소스 0번).
const COMMON_SOURCE = 1;
const commonBlock = (common, resume) => ["#line 1 " + COMMON_SOURCE, ...common.split("\n"), `#line ${resume} 0`];

// source: 편집기 코드, declarations: 넣어야 할 Uniform 선언 줄 목록.
// options.common: 모든 패스가 같이 쓰는 코드(Common 탭). precision · Uniform 선언 뒤, 패스 코드 앞에 들어간다.
// 돌려주는 값: { source, injected?, header, entry } — injected는 #version이 있는 코드에 줄을 넣었을 때만.
const prepareFragment = (source, declarations = [], { common = "" } = {}) => {
  if (typeof source !== "string") throw new TypeError("Fragment Shader는 문자열이어야 합니다.");
  if (typeof common !== "string") throw new TypeError("Common 코드는 문자열이어야 합니다.");
  const code = blankComments(source),
    hasCommon = !!common.trim();
  // Shadertoy 이름은 Common에서 쓰거나 정의해도 알아본다.
  declarations = [...declarations, ...shadertoyLines(hasCommon ? blankComments(common) + "\n" + code : code)];
  const needsEntry = !hasMain(code) && !!mainImageAt(code);
  const versioned = /^\s*#\s*version\b/.test(code);

  if (!versioned) {
    // 짧은 머리말: 첫 코드 줄(빈 줄 · 주석 · # 전처리 줄이 아닌 줄) 앞에 precision과 Uniform 선언을 넣는다.
    const lines = source.split("\n"),
      codeLines = code.split("\n");
    let first = codeLines.findIndex(line => line.trim() && !line.trim().startsWith("#"));
    if (first < 0) first = lines.length;
    const header = ["precision highp float;", ...declarations];
    const parts = [
      "#version 300 es",
      "#line 1",
      ...lines.slice(0, first),
      ...header,
      ...(hasCommon ? commonBlock(common, first + 1) : [`#line ${first + 1}`]),
      ...lines.slice(first),
    ];
    let out = parts.join("\n");
    if (needsEntry) out += entryPoint(code, lineOf(code, mainImageAt(code).index), mainImageAt(code).index);
    return { source: out, header: true, entry: needsEntry };
  }

  let out = source,
    injected = null;
  if (declarations.length || hasCommon) {
    const marker = /\bprecision\s+(?:lowp|mediump|highp)\s+float\s*;/.exec(code);
    if (!source.startsWith("#version 300 es") || !marker)
      throw new Error("사용자 Uniform이나 Common 코드를 넣으려면 GLSL ES 3.00과 float precision 선언이 필요합니다.");
    const end = marker.index + marker[0].length,
      tail = source.slice(end),
      extra = /^[^\r\n]*\S/.test(tail.split(/\r?\n/)[0]) ? "\n" : "",
      after = source.slice(0, end).split("\n").length,
      count = declarations.length + extra.length;
    // Common 묶음은 #line으로 줄 번호를 되돌리므로 넣은 줄 수(count)에 들어가지 않는다.
    // 묶음 뒤 첫 줄(precision 줄의 나머지 또는 그다음 줄)은 선언만 넣었을 때와 같은 번호(after + 선언 수 + 1)로 맞춰,
    // studio의 줄 되돌리기(count 빼기)가 그대로 맞는다.
    const block = hasCommon ? [...declarations, ...commonBlock(common, after + declarations.length + 1)] : declarations;
    out = source.slice(0, end) + "\n" + block.join("\n") + extra + tail;
    injected = { after, count, generated: declarations.length };
  }
  if (needsEntry) {
    // 컴파일러 기준 줄 번호: 선언을 넣은 위치보다 아래면 넣은 줄 수만큼 밀려 있다(studio가 다시 빼서 보여 준다).
    let line = lineOf(code, mainImageAt(code).index);
    if (injected && line > injected.after) line += injected.count;
    out += entryPoint(code, line, mainImageAt(code).index);
  }
  return { source: out, ...(injected ? { injected } : {}), header: false, entry: needsEntry };
};

export { prepareFragment, blankComments, COMMON_SOURCE };
