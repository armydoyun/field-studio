// GLSL 언어 정보와 분석: 키워드·타입·앱 Uniform·심볼 표·타입 추론·설명·자동 완성 후보. 편집기 화면과 무관한 순수 로직이다.
// 기본 편집기(code-editor.js)와 CodeMirror 편집기(cm-editor.js)가 함께 쓴다.
// ctx: {options:{builtins, lookup, library, userUniforms}, uniformNames:() => [이름], highlighter:glsl-highlight 인스턴스, source:() => 현재 소스}
const create = ctx => {
  const options = ctx.options || {},
    uniformNames = ctx.uniformNames || (() => []),
    highlighter = ctx.highlighter,
    source = ctx.source;
  const lineStartsOf = src => {
    const starts = [0];
    for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1)) starts.push(i + 1);
    return starts;
  };
  const lineIndexAt = (starts, offset) => {
    let lo = 0,
      hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // 주석·문자열·전처리문을 제외한다. 함수 탐색은 최상위 정의만 열거한다.
  const cleanSource = source =>
    source.replace(/^[ \t]*#(?:[^\n]*\\\r?\n)*[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\])*"/gm, s =>
      s.replace(/[^\n]/g, " ")
    );

  // ==== 언어 정보: 키워드·타입·앱 Uniform·내장 변수 ====
  const KEYWORDS =
    "if else for while do break continue return discard switch case default struct const uniform in out inout layout precision highp mediump lowp true false flat smooth".split(
      " "
    );
  const TYPES =
    "void bool int uint float vec2 vec3 vec4 bvec2 bvec3 bvec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 mat2 mat3 mat4 mat2x3 mat2x4 mat3x2 mat3x4 mat4x2 mat4x3 sampler2D isampler2D usampler2D samplerCube sampler3D".split(
      " "
    );
  // 렌더러가 값을 넣어 주는 Uniform: 선언하지 않은 채 자동 완성으로 고르면 선언을 맨 위에 함께 추가한다.
  const APP_UNIFORMS = [
    ["uResolution", "vec2", "현재 패스의 픽셀 크기 (vec3으로 선언하면 z = 1)"],
    ["uTime", "float", "재생 시간(초). 일시정지 중에는 멈춥니다"],
    ["uDeltaTime", "float", "직전 프레임과의 시간 간격(초)"],
    ["uFrame", "int", "누적 프레임 수. 시간 초기화·구조 변경 시 0"],
    ["uMouse", "vec4", "포인터 픽셀 좌표(밖이면 -1) · zw = 클릭 위치, z > 0 누르는 중, w > 0 누른 첫 프레임"],
    ["uWheel", "float", "뷰포트에서 굴린 마우스 휠 누적 칸 수(위로 +1). 시간 초기화 시 0"],
    ["uDate", "vec4", "벽시계: (연, 월 0~11, 일, 자정부터 지난 초). 영상 렌더링 중에는 시작 시각 + 렌더 시간"],
    ["uFrameRate", "float", "실제 초당 프레임 수(배속과 무관). 영상 렌더링 중에는 영상의 프레임 수"],
    [
      "uChannelTime",
      "float",
      "채널마다 재생 시간(배열 4개): 미디어는 재생 위치, 나머지는 uTime",
      "uniform float uChannelTime[4];",
    ],
    ...[0, 1, 2, 3].map(i => [
      `iChannel${i}`,
      "sampler2D",
      `입력 채널 ${i} — 편집기 입력 채널에서 연결한 버퍼 · 이미지 · 키보드 · 미디어`,
    ]),
    ["iChannelResolution", "vec3", "각 입력 채널의 크기 (배열 4개)", "uniform vec3 iChannelResolution[4];"],
  ];
  // Shadertoy 이름: 선언하지 않고 쓰면 실행할 때 위 Uniform에 #define으로 연결된다(glsl-prepare.js). 자동 완성은 선언을 넣지 않는다.
  const SHADERTOY_UNIFORMS = [
    ["iTime", "float", "Shadertoy 이름 — uTime(재생 시간, 초)과 같음 · 선언 없이 씁니다"],
    ["iTimeDelta", "float", "Shadertoy 이름 — uDeltaTime(프레임 간격, 초)과 같음 · 선언 없이 씁니다"],
    ["iFrame", "int", "Shadertoy 이름 — uFrame(누적 프레임 수)과 같음 · 선언 없이 씁니다"],
    ["iResolution", "vec3", "Shadertoy 이름 — (uResolution.xy, 1.0) · 선언 없이 씁니다"],
    [
      "iMouse",
      "vec4",
      "Shadertoy와 같은 마우스: xy = 누르고 있는 동안의 위치(놓으면 마지막 위치) · zw = 클릭 위치(z > 0 누르는 중, w > 0 누른 첫 프레임) · 선언 없이 씁니다",
    ],
    ["iDate", "vec4", "Shadertoy 이름 — uDate(연, 월 0~11, 일, 자정부터 지난 초)와 같음 · 선언 없이 씁니다"],
    ["iFrameRate", "float", "Shadertoy 이름 — uFrameRate(초당 프레임 수)와 같음 · 선언 없이 씁니다"],
    ["iChannelTime", "float", "Shadertoy 이름 — uChannelTime[4](채널마다 재생 시간)과 같음 · 선언 없이 씁니다"],
    ["iSampleRate", "float", "Shadertoy 이름 — 사운드 샘플레이트 44100.0 · 선언 없이 씁니다"],
  ];
  const BUILTIN_VARS = { gl_FragCoord: "vec4", gl_FrontFacing: "bool", gl_PointCoord: "vec2", gl_FragDepth: "float" };
  const isIdent = text => /^[A-Za-z_]\w*$/.test(text);
  const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const userUniforms = () => options.userUniforms?.() || uniformNames().map(name => ({ name, type: "" }));

  // 소스별 결과를 두 개까지 기억한다: 지금 탭의 소스와 Common(options.shared)을 번갈아 읽어도 다시 계산하지 않게.
  const memo2 = fn => {
    let a = null,
      b = null;
    return src => {
      if (a?.src === src) return a.value;
      if (b?.src === src) [a, b] = [b, a];
      else [a, b] = [{ src, value: fn(src) }, a];
      return a.value;
    };
  };
  // 주석·문자열을 같은 길이 공백으로 지운 사본(위치 보존). 같은 소스면 다시 계산하지 않는다.
  const cleanOf = memo2(cleanSource);

  // ==== 심볼 표: 함수·변수(매개변수 포함)·구조체·#define. 소스가 바뀔 때만 다시 만든다 ====
  const DECL =
    /\b((?:(?:const|uniform|in|out|inout|highp|mediump|lowp|flat|smooth)\s+)*)((?:[biu]?vec[234]|mat[234](?:x[234])?|float|int|uint|bool|[iu]?sampler2D|samplerCube|sampler3D|[A-Z]\w*))\s+([A-Za-z_]\w*)\s*(?=[=;,)[])/g;
  const symbolsOf = memo2(src => {
    const clean = cleanOf(src),
      starts = lineStartsOf(src),
      line = at => lineIndexAt(starts, at) + 1,
      functions = [],
      variables = [],
      structs = new Map(),
      defines = [];
    for (const m of clean.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*\{/g))
      if (!KEYWORDS.includes(m[1]) && !KEYWORDS.includes(m[2]))
        functions.push({
          name: m[2],
          ret: m[1],
          params: m[3].trim().replace(/\s+/g, " "),
          offset: m.index + m[0].indexOf(m[2], m[1].length),
          line: line(m.index),
        });
    for (const m of clean.matchAll(DECL))
      if (!KEYWORDS.includes(m[3]) && !TYPES.includes(m[3]))
        variables.push({
          name: m[3],
          type: m[2],
          uniform: /\buniform\b/.test(m[1]),
          output: /\bout\b/.test(m[1]),
          offset: m.index + m[0].lastIndexOf(m[3]),
          line: line(m.index),
        });
    for (const m of clean.matchAll(/\bstruct\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/g))
      structs.set(m[1], {
        line: line(m.index),
        offset: m.index + m[0].indexOf(m[1]),
        fields: [...m[2].matchAll(/([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;/g)].map(f => ({
          name: f[2],
          type: f[1],
        })),
      });
    for (const m of src.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]*(.*)$/gm))
      defines.push({ name: m[1], value: m[2].trim(), offset: m.index + m[0].indexOf(m[1]), line: line(m.index) });
    return { src, functions, variables, structs, defines };
  });
  // Common 탭(options.shared() = 지금 탭이 아닌 Common의 소스): 다른 탭의 자동 완성 · 설명 · 시그니처가 그 함수 ·
  // 전역 변수(Uniform · 상수) · 구조체 · #define을 안다. 함수 안의 지역 변수 · 매개변수는 빼고 전역만 둔다.
  const sharedOf = memo2(src => {
    const sym = symbolsOf(src),
      clean = cleanOf(src),
      depth = new Int32Array(clean.length + 1);
    for (let i = 0, d = 0; i < clean.length; i++) {
      if (clean[i] === "{") d++;
      else if (clean[i] === "}") d = Math.max(0, d - 1);
      depth[i + 1] = d;
    }
    // 매개변수는 괄호 안이라 깊이 0이어도 함수 머리줄에 있다: 함수 머리줄 범위를 뺀다.
    const heads = sym.functions.map(f => [f.offset, clean.indexOf("{", f.offset)]);
    return {
      ...sym,
      variables: sym.variables.filter(
        v => depth[v.offset] === 0 && !heads.some(([a, b]) => v.offset > a && v.offset < b)
      ),
    };
  });
  const shared = () => {
    const src = options.shared?.() || "";
    return src.trim() ? sharedOf(src) : null;
  };
  // 이름의 타입: 가장 가까운 앞쪽 선언 → 내장 변수 → 앱 Uniform
  const typeOf = (name, pos) => {
    const vars = symbolsOf(source()).variables.filter(v => v.name === name);
    if (!vars.length)
      return (
        shared()?.variables.find(v => v.name === name)?.type ||
        BUILTIN_VARS[name] ||
        APP_UNIFORMS.find(u => u[0] === name)?.[1] ||
        SHADERTOY_UNIFORMS.find(u => u[0] === name)?.[1] ||
        ""
      );
    const before = vars.filter(v => v.offset <= pos);
    return (before.length ? before[before.length - 1] : vars[0]).type;
  };

  // 설명: 함수(내장·이 패스) / 변수·Uniform·구조체·#define — 시그니처 힌트와 마우스 설명이 함께 쓴다.
  // 이름 → {sig, desc}: 내장 함수(레퍼런스) 또는 이 패스의 함수. src를 주면 그 소스에서 찾는다(시그니처 도움말).
  const describeFunction = (name, src = source()) => {
    const builtin = options.lookup?.(name);
    if (builtin) return { sig: builtin.sig, desc: builtin.desc };
    const own = symbolsOf(src).functions.find(entry => entry.name === name);
    if (own) return { sig: `${own.ret} ${name}(${own.params})`, desc: `이 패스에 정의된 함수 · ${own.line}번째 줄` };
    const common = shared()?.functions.find(entry => entry.name === name);
    return common
      ? { sig: `${common.ret} ${name}(${common.params})`, desc: `Common 탭의 함수 · ${common.line}번째 줄` }
      : null;
  };
  const describeSymbol = (name, pos) => {
    const fn = describeFunction(name);
    if (fn) return fn;
    const sym = symbolsOf(source()),
      app = APP_UNIFORMS.find(u => u[0] === name);
    const vars = sym.variables.filter(v => v.name === name),
      decl = vars.filter(v => v.offset <= pos).pop() || vars[0];
    if (decl)
      return {
        sig: `${decl.uniform ? "uniform " : decl.output ? "out " : ""}${decl.type} ${name}`,
        desc: app
          ? app[2]
          : `${decl.uniform ? "Uniform" : decl.output ? "출력" : "변수"} · ${decl.line}번째 줄에서 선언`,
      };
    const common = shared();
    const commonVar = common?.variables.find(v => v.name === name);
    if (commonVar)
      return {
        sig: `${commonVar.uniform ? "uniform " : ""}${commonVar.type} ${name}`,
        desc: `${app ? `${app[2]} · ` : ""}Common 탭 · ${commonVar.line}번째 줄에서 선언`,
      };
    if (common?.structs.has(name)) {
      const struct = common.structs.get(name);
      return {
        sig: `struct ${name} { ${struct.fields.map(f => `${f.type} ${f.name};`).join(" ")} }`,
        desc: `구조체 · Common 탭 ${struct.line}번째 줄`,
      };
    }
    const commonDefine = common?.defines.find(d => d.name === name);
    if (commonDefine && !sym.defines.some(d => d.name === name))
      return { sig: `#define ${name} ${commonDefine.value}`, desc: `매크로 · Common 탭 ${commonDefine.line}번째 줄` };
    if (app) return { sig: `uniform ${app[1]} ${name}`, desc: `${app[2]} · 아직 선언되지 않음` };
    const toy = SHADERTOY_UNIFORMS.find(u => u[0] === name);
    if (toy && !sym.defines.some(d => d.name === name)) return { sig: `${toy[1]} ${name}`, desc: toy[2] };
    const param = userUniforms().find(u => u.name === name);
    if (param)
      return { sig: `uniform ${param.type} ${name}`, desc: "파라미터 패널에 등록된 값 · 선언은 자동으로 추가됩니다" };
    const struct = sym.structs.get(name);
    if (struct)
      return {
        sig: `struct ${name} { ${struct.fields.map(f => `${f.type} ${f.name};`).join(" ")} }`,
        desc: `구조체 · ${struct.line}번째 줄`,
      };
    const define = sym.defines.find(d => d.name === name);
    if (define) return { sig: `#define ${name} ${define.value}`, desc: `매크로 · ${define.line}번째 줄` };
    return null;
  };

  const SNIPPETS = [
    { label: "main", detail: "void main() { … }", body: "void main() {\n\t$0\n}" },
    { label: "for", detail: "for (int i = 0; i < N; i++) { … }", body: "for (int i = 0; i < ${1:8}; i++) {\n\t$0\n}" },
    { label: "if", detail: "if (조건) { … }", body: "if (${1:condition}) {\n\t$0\n}" },
    { label: "ifelse", detail: "if (조건) { … } else { … }", body: "if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}" },
    {
      label: "func",
      detail: "반환형 이름(매개변수) { … }",
      body: "${1:float} ${2:name}(${3:vec2 p}) {\n\treturn ${4:0.0};\n}",
    },
    { label: "struct", detail: "struct 이름 { … };", body: "struct ${1:Name} {\n\t${2:float value};\n};" },
    {
      label: "uniform-range",
      detail: "슬라이더 파라미터 · @range",
      body: "uniform float ${1:uAmount}; // @range ${2:0} ${3:1} @default ${4:0.5}",
    },
    {
      label: "uniform-color",
      detail: "색상 파라미터 · @color",
      body: "uniform vec3 ${1:uColor}; // @color @default ${2:1.0 0.5 0.2}",
    },
    {
      label: "uniform-dir",
      detail: "방향(단위 벡터) 파라미터 · @dir",
      body: "uniform vec3 ${1:uLightDir}; // @dir @default ${2:0.4 0.8 0.45}",
    },
    {
      label: "uniform-angle",
      detail: "각도 파라미터(라디안) · @angle",
      body: "uniform float ${1:uAngle}; // @angle @default ${2:45deg}",
    },
    {
      label: "uniform-pos",
      detail: "2D 위치 패드 · @pos",
      body: "uniform vec2 ${1:uCenter}; // @pos @range ${2:0} ${3:1} @default ${4:0.5}",
    },
    {
      label: "uniform-log",
      detail: "로그 눈금 슬라이더 · @log",
      body: "uniform float ${1:uScale}; // @log @range ${2:0.01} ${3:100} @default ${4:1}",
    },
    {
      label: "uniform-enum",
      detail: "선택지 파라미터 · @enum",
      body: "uniform int ${1:uMode}; // @enum ${2:결과 밀도 법선} @default ${3:0}",
    },
    {
      label: "uniform-hdr",
      detail: "HDR 색(색 + 밝기 배율) · @color hdr",
      body: "uniform vec3 ${1:uGlow}; // ${2:발광} · @color hdr ${3:10} @default ${4:2 1 0.4}",
    },
    {
      label: "uniform-seed",
      detail: "무작위 버튼 파라미터 · @seed",
      body: "uniform float ${1:uSeed}; // ${2:무늬 고르기} · @seed @range 0 100 @step 1 @default ${3:0}",
    },
    {
      label: "uniform-anim",
      detail: "재생 버튼 파라미터 · @anim",
      body: "uniform float ${1:uAmount}; // @range ${2:0} ${3:1} @anim ${4:4} @default ${5:0.5}",
    },
    {
      label: "uniform-gradient",
      detail: "그라데이션 램프 · @gradient (texture(이름, vec2(t, 0.5)))",
      body: "uniform sampler2D ${1:uRamp}; // @gradient ${2:smooth} @default ${3:0 #000000 0.5 #ff6a00 1 #ffffff}",
    },
    {
      label: "uniform-curve",
      detail: "곡선 램프 · @curve (texture(이름, vec2(x, 0.5)).r)",
      body: "uniform sampler2D ${1:uCurve}; // @curve @default ${2:0 0 0.5 0.8 1 1}",
    },
    {
      label: "uv-center",
      detail: "중심 원점 · 종횡비 보정 좌표",
      body: "vec2 ${1:uv} = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;",
    },
    { label: "uv01", detail: "0~1 화면 좌표", body: "vec2 ${1:uv} = gl_FragCoord.xy / uResolution;" },
    { label: "tex", detail: "texture(채널, uv)", body: "texture(${1:iChannel0}, ${2:uv})" },
    {
      label: "texfetch",
      detail: "texelFetch — 픽셀 정확히 읽기",
      body: "texelFetch(${1:iChannel0}, ivec2(gl_FragCoord.xy), 0)",
    },
    {
      label: "frag",
      detail: "새 셰이더 전체 골격",
      body: "#version 300 es\nprecision highp float;\nuniform vec2 uResolution;\nuniform float uTime;\n\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord) {\n\tvec2 uv = fragCoord / uResolution;\n\tfragColor = vec4(${1:uv, 0.5 + 0.5 * sin(uTime)}, 1.0);$0\n}",
    },
  ];

  // ==== 자동 완성 ====
  // 순위: 접두어 일치 > 단어 경계(camelCase·_) 일치 > 연속 일치. 첫 글자는 이름의 시작이나 단어 경계와 맞아야 한다.
  const boundaryAt = (s, i) =>
    i === 0 ||
    s[i - 1] === "_" ||
    s[i - 1] === "-" ||
    (/[A-Z]/.test(s[i]) && /[a-z0-9]/.test(s[i - 1])) ||
    (/\d/.test(s[i]) && !/\d/.test(s[i - 1]));
  const fuzzy = (label, query) => {
    if (!query) return { score: 0, hits: [] };
    const lower = label.toLowerCase(),
      q = query.toLowerCase(),
      hits = [];
    let from = 0,
      score = 0,
      prev = -2;
    for (let k = 0; k < q.length; k++) {
      let i = lower.indexOf(q[k], from);
      if (i < 0) return null;
      if (i !== prev + 1)
        for (let j = i; j >= 0; j = lower.indexOf(q[k], j + 1))
          if (boundaryAt(label, j)) {
            i = j;
            break;
          } // 경계 위치 우선
      score += i === prev + 1 ? 5 : boundaryAt(label, i) ? 3 : 0;
      if (label[i] === query[k]) score += 1;
      hits.push(i);
      prev = i;
      from = i + 1;
    }
    if (!boundaryAt(label, hits[0])) return null;
    if (lower.startsWith(q)) score += 30;
    if (label.startsWith(query)) score += 5;
    return { score: score - label.length * 0.05, hits };
  };
  const KIND_ORDER = {
    variable: 0,
    field: 0,
    function: 1,
    uniform: 2,
    constant: 2,
    builtin: 3,
    "builtin-var": 3,
    type: 4,
    keyword: 5,
    snippet: 6,
    library: 7,
  };
  const KIND_NAME = {
    variable: "변수",
    field: "필드",
    function: "이 패스의 함수",
    uniform: "Uniform",
    constant: "#define",
    builtin: "내장 함수",
    "builtin-var": "내장 변수",
    type: "타입",
    keyword: "키워드",
    snippet: "코드 템플릿",
    library: "코드 조각 모음",
  };
  // 스위즐: vecN 뒤의 '.'에서 x·y·z·w(rgba) 조합을 제안
  const swizzleItems = type => {
    const m = /^([biu]?)vec([234])$/.exec(type);
    if (!m) return [];
    const n = Number(m[2]),
      base = { b: "bool", i: "int", u: "uint", "": "float" }[m[1]],
      vec = k => (k === 1 ? base : `${m[1]}vec${k}`);
    const set = [
      "x",
      "y",
      "z",
      "w",
      "xy",
      "xz",
      "yz",
      "xyz",
      "xyzw",
      "r",
      "g",
      "b",
      "a",
      "rg",
      "rgb",
      "rgba",
      "yx",
      "zyx",
    ];
    return set
      .filter(s => [...s].every(c => ("xyzw".indexOf(c) >= 0 ? "xyzw".indexOf(c) : "rgba".indexOf(c)) < n))
      .map(s => ({ label: s, kind: "field", detail: vec(s.length), desc: `${type}의 성분 ${s}` }));
  };

  const gatherItems = (src, at, start) => {
    // 멤버 완성: 이름 뒤 '.' → 벡터 스위즐 또는 구조체 필드
    if (src[start - 1] === ".") {
      const owner = src.slice(0, start - 1).match(/([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*$/)?.[1];
      if (!owner) return { items: [], member: true };
      const type = typeOf(owner, start),
        struct = symbolsOf(src).structs.get(type) || shared()?.structs.get(type);
      return {
        member: true,
        items: struct
          ? struct.fields.map(f => ({ label: f.name, kind: "field", detail: f.type, desc: `${type}의 필드` }))
          : swizzleItems(type),
      };
    }
    const sym = symbolsOf(src),
      items = [],
      seen = new Set(),
      add = item => {
        const key = `${item.kind === "snippet" ? "s" : "n"}:${item.label}`;
        if (!seen.has(key)) {
          seen.add(key);
          items.push(item);
        }
      };
    const nearest = new Map();
    for (const v of sym.variables) if (v.offset < start || !nearest.has(v.name)) nearest.set(v.name, v);
    for (const v of nearest.values())
      if (v.offset !== start)
        add({
          label: v.name,
          kind: v.uniform ? "uniform" : "variable",
          detail: `${v.uniform ? "uniform " : ""}${v.type}`,
          desc: APP_UNIFORMS.find(u => u[0] === v.name)?.[2] || `${v.line}번째 줄에서 선언`,
        });
    for (const f of sym.functions)
      add({
        label: f.name,
        kind: "function",
        detail: `${f.ret} ${f.name}(${f.params})`,
        desc: `이 패스의 함수 · ${f.line}번째 줄`,
      });
    for (const [name, s] of sym.structs)
      add({ label: name, kind: "type", detail: "struct", desc: s.fields.map(f => `${f.type} ${f.name}`).join(" · ") });
    for (const d of sym.defines)
      add({ label: d.name, kind: "constant", detail: `#define ${d.value}`.trim(), desc: `${d.line}번째 줄` });
    // Common 탭의 이름(이 탭에 같은 이름이 있으면 이 탭 것이 먼저 — add가 같은 이름을 한 번만 넣는다)
    const common = shared();
    if (common) {
      for (const f of common.functions)
        add({
          label: f.name,
          kind: "function",
          detail: `${f.ret} ${f.name}(${f.params})`,
          desc: `Common 탭의 함수 · ${f.line}번째 줄`,
        });
      for (const v of common.variables)
        add({
          label: v.name,
          kind: v.uniform ? "uniform" : "variable",
          detail: `${v.uniform ? "uniform " : ""}${v.type}`,
          desc: `Common 탭 · ${v.line}번째 줄에서 선언`,
        });
      for (const [name, st] of common.structs)
        add({
          label: name,
          kind: "type",
          detail: "struct",
          desc: `Common 탭 · ${st.fields.map(f => `${f.type} ${f.name}`).join(" · ")}`,
        });
      for (const d of common.defines)
        add({
          label: d.name,
          kind: "constant",
          detail: `#define ${d.value}`.trim(),
          desc: `Common 탭 · ${d.line}번째 줄`,
        });
    }
    for (const u of userUniforms())
      add({
        label: u.name,
        kind: "uniform",
        detail: `uniform ${u.type}`,
        desc: "파라미터 패널에 등록된 값 · 선언은 자동으로 추가됩니다",
      });
    for (const [name, type, desc, declare] of APP_UNIFORMS)
      add({
        label: name,
        kind: "uniform",
        detail: `uniform ${type}`,
        desc: `${desc} · 고르면 선언도 함께 추가합니다`,
        declare: declare || `uniform ${type} ${name};`,
      });
    for (const [name, type, desc] of SHADERTOY_UNIFORMS) add({ label: name, kind: "uniform", detail: type, desc });
    const builtins = options.builtins?.length
      ? options.builtins
      : [...highlighter.builtins].map(name => ({ name, sig: "", desc: "" })); // 레퍼런스 없이 쓰일 때의 최소 목록
    for (const item of builtins)
      if (isIdent(item.name))
        add({
          label: item.name,
          kind: item.name.startsWith("gl_") ? "builtin-var" : "builtin",
          detail: item.sig.split(" · ")[0],
          desc: item.desc,
          sig: item.sig,
        });
    for (const name of TYPES)
      add({
        label: name,
        kind: "type",
        detail: "타입",
        desc: /^[biu]?vec|^mat/.test(name) ? "생성자로도 씁니다: " + name + "(…)" : "",
      });
    for (const name of KEYWORDS) add({ label: name, kind: "keyword", detail: "키워드", desc: "" });
    for (const s of SNIPPETS)
      add({ label: s.label, kind: "snippet", detail: s.detail, desc: "Tab으로 다음 자리로 이동", body: s.body });
    const defined = new Set(sym.functions.map(f => f.name));
    for (const lib of options.library?.items || [])
      if (!defined.has(lib.name))
        add({
          label: lib.name,
          kind: "library",
          detail: lib.title,
          desc: `${lib.desc} · 고르면 함수 정의(필요한 함수 포함)를 위쪽에 추가합니다`,
          id: lib.id,
        });
    return { items, member: false };
  };
  // 선언 자리(타입 다음에 새 이름을 쓰는 중)에서는 저절로 띄우지 않는다.
  const declaringName = (src, start) =>
    /(?:^|[\s(,;{])(?:(?:const|uniform|in|out|inout|highp|mediump|lowp)\s+)*(?:void|float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?|[iu]?sampler2D|struct|[A-Z]\w*)\s+$/.test(
      src.slice(Math.max(0, start - 80), start)
    );

  return {
    KEYWORDS,
    TYPES,
    APP_UNIFORMS,
    SHADERTOY_UNIFORMS,
    BUILTIN_VARS,
    isIdent,
    escapeRe,
    cleanOf,
    symbolsOf,
    shared,
    describeFunction,
    describeSymbol,
    fuzzy,
    KIND_ORDER,
    KIND_NAME,
    gatherItems,
    declaringName,
  };
};
export { create };
