// GLSL ES 3.00 내장 함수·변수 레퍼런스. 순수 데이터 모듈이며 가이드의 "GLSL 내장 함수" 주제가 사용한다.
// 항목: {name, sig, desc, c?, ex?}
//  - sig: 대표 시그니처. T는 float·vec2·vec3·vec4 중 하나(성분별로 적용), I는 int·ivec, U는 uint·uvec, B는 bool·bvec.
//  - c: C 표준 라이브러리로 쓰면 무엇인지(이미 C를 아는 사람을 위한 대응표).
//  - ex: 셰이더에서 자주 쓰는 한 줄 예시.
// WebGL2(GLSL ES 3.00)에 없는 함수(fma, bitfieldExtract, frexp 등)는 넣지 않는다.
  const CATEGORIES = [
    {id:"basic", title:"기본 수학", desc:"성분별(component-wise)로 동작합니다. vec3에 쓰면 x·y·z 각각에 적용돼요.", items:[
      {name:"abs", sig:"T abs(T x) · I abs(I x)", desc:"절댓값.", c:"fabsf / abs", ex:"float d = abs(p.x);   // 좌우 대칭"},
      {name:"sign", sig:"T sign(T x)", desc:"음수 −1, 0이면 0, 양수 1.", c:"(x > 0) − (x < 0)", ex:"float side = sign(p.x);"},
      {name:"floor", sig:"T floor(T x)", desc:"x 이하 최대 정수(실수형으로 반환). 칸 번호를 구할 때.", c:"floorf", ex:"vec2 cell = floor(uv * 8.0);"},
      {name:"ceil", sig:"T ceil(T x)", desc:"x 이상 최소 정수.", c:"ceilf"},
      {name:"trunc", sig:"T trunc(T x)", desc:"0 방향으로 소수부 버림. 음수에서 floor와 다름(trunc(−1.5) = −1).", c:"truncf"},
      {name:"round", sig:"T round(T x)", desc:"가장 가까운 정수. 0.5의 처리 방향은 구현마다 다를 수 있음.", c:"roundf", ex:"p - s * round(p / s)   // 무한 반복"},
      {name:"roundEven", sig:"T roundEven(T x)", desc:"가장 가까운 정수, 0.5는 짝수 쪽으로(은행원 반올림).", c:"nearbyintf (기본 모드)"},
      {name:"fract", sig:"T fract(T x)", desc:"x − floor(x). 항상 0 이상 1 미만 — 반복 무늬·톱니파의 핵심.", c:"x - floorf(x)", ex:"vec2 local = fract(uv * 8.0) - 0.5;"},
      {name:"mod", sig:"T mod(T x, T y) · T mod(T x, float y)", desc:"x − y·floor(x/y). 결과 부호가 y를 따름: mod(−1, 3) = 2. 정수는 % 연산자를 쓰세요.", c:"fmodf와 음수에서 다름", ex:"float a = mod(angle, 6.2831853);"},
      {name:"modf", sig:"T modf(T x, out T i)", desc:"정수부를 i에, 소수부를 반환. 둘 다 x와 같은 부호.", c:"modff"},
      {name:"min", sig:"T min(T x, T y) · T min(T x, float y)", desc:"작은 값. SDF에서는 합집합.", c:"fminf", ex:"float d = min(dCircle, dBox);"},
      {name:"max", sig:"T max(T x, T y) · T max(T x, float y)", desc:"큰 값. SDF에서는 교집합, max(a, −b)는 차집합.", c:"fmaxf"},
      {name:"clamp", sig:"T clamp(T x, T lo, T hi)", desc:"lo~hi 범위로 자르기.", c:"fminf(fmaxf(x, lo), hi)", ex:"float t = clamp(x, 0.0, 1.0);"},
      {name:"mix", sig:"T mix(T a, T b, T t) · T mix(T a, T b, B sel)", desc:"선형 보간 a + (b − a)·t. bool 버전은 성분별 선택(sel이 true면 b).", c:"a + (b - a) * t", ex:"vec3 col = mix(bg, fg, mask);"},
      {name:"step", sig:"T step(T edge, T x)", desc:"x < edge면 0, 아니면 1. 분기 없는 if.", c:"x < edge ? 0 : 1", ex:"float inside = step(d, 0.0);"},
      {name:"smoothstep", sig:"T smoothstep(T e0, T e1, T x)", desc:"e0~e1 사이에서 0→1로 부드럽게(3t² − 2t³). e0 > e1이면 반대 방향. 경계 안티앨리어싱에 사용.", c:"t = clamp((x-e0)/(e1-e0),0,1); t*t*(3-2*t)", ex:"float a = smoothstep(px, -px, d);"},
      {name:"isnan · isinf", sig:"B isnan(T x) · B isinf(T x)", desc:"NaN·무한대 검사. 0 나누기·음수 sqrt를 찾는 디버깅에.", c:"isnan / isinf"}]},
    {id:"trig", title:"삼각 · 각도", desc:"각도는 모두 라디안입니다. 2π ≈ 6.2831853.", items:[
      {name:"radians · degrees", sig:"T radians(T deg) · T degrees(T rad)", desc:"도 ↔ 라디안 변환.", c:"deg * M_PI / 180"},
      {name:"sin · cos · tan", sig:"T sin(T a) · T cos(T a) · T tan(T a)", desc:"삼각함수. sin(uTime)은 −1~1 왕복 — 애니메이션의 기본.", c:"sinf / cosf / tanf", ex:"vec2 orbit = vec2(cos(t), sin(t));"},
      {name:"asin · acos", sig:"T asin(T x) · T acos(T x)", desc:"역사인·역코사인. x가 −1~1 밖이면 결과 정의 안 됨 — clamp하세요.", c:"asinf / acosf", ex:"float ang = acos(clamp(dot(a, b), -1.0, 1.0));"},
      {name:"atan (2인수)", sig:"T atan(T y, T x)", desc:"점 (x, y)의 각도 −π~π. 이름은 atan이지만 C의 atan2와 같음. 극좌표·방사형 무늬에.", c:"atan2f(y, x)", ex:"float a = atan(p.y, p.x);"},
      {name:"atan (1인수)", sig:"T atan(T y_over_x)", desc:"−π/2~π/2 범위 역탄젠트.", c:"atanf"},
      {name:"sinh · cosh · tanh", sig:"T sinh(T x) · T cosh(T x) · T tanh(T x)", desc:"쌍곡선 함수. tanh는 값을 −1~1로 부드럽게 눌러주는 데 유용.", c:"sinhf / coshf / tanhf"},
      {name:"asinh · acosh · atanh", sig:"T asinh(T x) · T acosh(T x) · T atanh(T x)", desc:"역쌍곡선 함수.", c:"asinhf / acoshf / atanhf"}]},
    {id:"exp", title:"지수 · 로그 · 거듭제곱", desc:"음수·0 입력에 주의하세요. 정의되지 않은 값은 GPU마다 결과가 다릅니다.", items:[
      {name:"pow", sig:"T pow(T x, T y)", desc:"x의 y제곱. x < 0이거나 x = 0, y ≤ 0이면 정의되지 않음.", c:"powf", ex:"col = pow(col, vec3(1.0 / 2.2));   // 감마"},
      {name:"exp · log", sig:"T exp(T x) · T log(T x)", desc:"자연 지수·자연 로그. exp(−k·d)는 거리에 따라 부드럽게 사라지는 빛·안개.", c:"expf / logf", ex:"float glow = exp(-8.0 * abs(d));"},
      {name:"exp2 · log2", sig:"T exp2(T x) · T log2(T x)", desc:"2의 거듭제곱·밑이 2인 로그. 옥타브·밉 레벨 계산.", c:"exp2f / log2f"},
      {name:"sqrt", sig:"T sqrt(T x)", desc:"제곱근(x ≥ 0). 거리 비교만 할 때는 dot(v, v)로 sqrt를 생략할 수 있음.", c:"sqrtf"},
      {name:"inversesqrt", sig:"T inversesqrt(T x)", desc:"1 / sqrt(x). 정규화에 쓰이며 보통 빠름.", c:"1.0f / sqrtf(x)"}]},
    {id:"geometry", title:"벡터 · 기하", desc:"벡터를 하나의 값으로 다루는 함수들입니다. 거리·방향·조명 계산의 기초예요.", items:[
      {name:"length", sig:"float length(T v)", desc:"벡터 길이 √(x² + y² + …). 원점까지 거리 = 원의 SDF.", c:"sqrtf(x*x + y*y)", ex:"float d = length(p) - r;"},
      {name:"distance", sig:"float distance(T a, T b)", desc:"두 점 사이 거리 = length(a − b).", c:"hypotf(ax-bx, ay-by)"},
      {name:"dot", sig:"float dot(T a, T b)", desc:"내적. 두 단위 벡터의 dot은 cos(사이각) — 조명 밝기·방향 비교. dot(v, v)는 길이².", c:"a.x*b.x + a.y*b.y + …", ex:"float diffuse = max(dot(n, lightDir), 0.0);"},
      {name:"cross", sig:"vec3 cross(vec3 a, vec3 b)", desc:"외적. a·b 모두에 수직인 벡터(오른손 법칙). 카메라 축 만들기.", c:"직접 구현", ex:"vec3 right = normalize(cross(forward, vec3(0, 1, 0)));"},
      {name:"normalize", sig:"T normalize(T v)", desc:"같은 방향, 길이 1인 벡터. 길이 0 벡터는 정의되지 않음.", c:"v / length(v)", ex:"vec3 rd = normalize(vec3(uv, 1.5));"},
      {name:"reflect", sig:"T reflect(T I, T N)", desc:"입사 방향 I를 법선 N(단위 벡터)에 대해 반사. 거울·하이라이트.", c:"I - 2*dot(N,I)*N", ex:"vec3 r = reflect(rd, n);"},
      {name:"refract", sig:"T refract(T I, T N, float eta)", desc:"굴절 방향. eta = 굴절률 비(공기→유리 ≈ 1/1.5). 전반사면 0 벡터.", c:"직접 구현"},
      {name:"faceforward", sig:"T faceforward(T N, T I, T Nref)", desc:"dot(Nref, I) < 0이면 N, 아니면 −N. 법선이 시점 쪽을 향하게.", c:"직접 구현"}]},
    {id:"matrix", title:"행렬", desc:"GLSL 행렬은 열 우선(column-major)입니다. m[i]는 i번째 열, m * v는 행렬×벡터, v * m은 전치 곱.", items:[
      {name:"생성자", sig:"mat2(a, b, c, d) · mat3(col0, col1, col2) · mat3(1.0)", desc:"인수는 열 순서로 채워짐. mat3(1.0)은 단위 행렬. mat3(m4)는 왼쪽 위 3×3.", c:"배열 [col][row]와 같은 배치", ex:"mat2 rot = mat2(c, s, -s, c);   // 회전"},
      {name:"matrixCompMult", sig:"mat matrixCompMult(mat a, mat b)", desc:"성분별 곱(행렬 곱이 아님). 행렬 곱은 * 연산자.", c:"a[i][j] * b[i][j]"},
      {name:"outerProduct", sig:"matNxM outerProduct(vecM c, vecN r)", desc:"외적 행렬 c·rᵀ.", c:"직접 구현"},
      {name:"transpose", sig:"mat transpose(mat m)", desc:"전치. 회전 행렬의 역행렬은 전치와 같음(싸게 되돌리기).", c:"직접 구현"},
      {name:"determinant", sig:"float determinant(mat m)", desc:"행렬식.", c:"직접 구현"},
      {name:"inverse", sig:"mat inverse(mat m)", desc:"역행렬. 비싸므로 회전이면 transpose를 쓰세요.", c:"직접 구현"}]},
    {id:"compare", title:"벡터 비교 · 논리", desc:"벡터끼리 <, == 등을 쓰면 성분별이 아니라 오류이거나 전체 비교입니다. 성분별 비교는 아래 함수로 bvec를 받으세요.", items:[
      {name:"lessThan · greaterThan", sig:"B lessThan(T a, T b) · B greaterThan(T a, T b)", desc:"성분별 <, > 결과를 bvec로.", ex:"bvec2 inside = lessThan(abs(p), vec2(0.5));"},
      {name:"lessThanEqual · greaterThanEqual", sig:"B lessThanEqual(T a, T b) · B greaterThanEqual(T a, T b)", desc:"성분별 ≤, ≥."},
      {name:"equal · notEqual", sig:"B equal(T a, T b) · B notEqual(T a, T b)", desc:"성분별 ==, !=. (a == b는 모든 성분이 같을 때만 true인 bool 하나)"},
      {name:"any · all · not", sig:"bool any(B v) · bool all(B v) · B not(B v)", desc:"하나라도 true / 모두 true / 성분별 부정.", ex:"if (all(inside)) col = vec3(1.0);"},
      {name:"mix (bool 선택)", sig:"T mix(T a, T b, B sel)", desc:"sel이 true인 성분만 b에서 가져옴 — 분기 없는 성분별 선택.", ex:"vec3 c = mix(a, b, greaterThan(n, vec3(0.0)));"}]},
    {id:"texture", title:"텍스처 읽기", desc:"sampler2D(이미지·버퍼)를 읽는 함수입니다. 좌표 uv는 0~1, texelFetch만 정수 픽셀 좌표를 씁니다.", items:[
      {name:"texture", sig:"vec4 texture(sampler2D s, vec2 uv [, float bias])", desc:"0~1 좌표로 읽기. Filter가 Linear면 주변 텍셀을 보간, 밉맵이 있으면 자동 레벨 선택.", c:"bilinear 보간된 배열 읽기", ex:"vec4 c = texture(iChannel0, gl_FragCoord.xy / uResolution);"},
      {name:"texelFetch", sig:"vec4 texelFetch(sampler2D s, ivec2 p, int lod)", desc:"정수 픽셀 좌표로 정확히 한 칸 읽기(보간·Wrap 없음). 시뮬레이션·데이터 버퍼에. 범위 밖은 정의 안 됨.", c:"arr[y][x]", ex:"vec4 v = texelFetch(iChannel0, ivec2(gl_FragCoord.xy), 0);"},
      {name:"textureLod", sig:"vec4 textureLod(sampler2D s, vec2 uv, float lod)", desc:"밉맵 레벨을 직접 지정해 읽기. lod가 클수록 흐림(Buffer의 Mip 켜기 필요).", ex:"vec4 blur = textureLod(iChannel0, uv, 4.0);"},
      {name:"textureSize", sig:"ivec2 textureSize(sampler2D s, int lod)", desc:"텍스처 크기(픽셀). iChannelResolution 대신 쓸 수 있음.", ex:"vec2 px = 1.0 / vec2(textureSize(iChannel0, 0));"},
      {name:"textureOffset", sig:"vec4 textureOffset(sampler2D s, vec2 uv, ivec2 offset)", desc:"uv에서 정수 텍셀만큼 떨어진 곳 읽기. offset은 상수여야 함(−8~7 정도).", ex:"vec4 r = textureOffset(iChannel0, uv, ivec2(1, 0));"},
      {name:"texelFetchOffset", sig:"vec4 texelFetchOffset(sampler2D s, ivec2 p, int lod, ivec2 offset)", desc:"texelFetch + 상수 오프셋."},
      {name:"textureGrad", sig:"vec4 textureGrad(sampler2D s, vec2 uv, vec2 dPdx, vec2 dPdy)", desc:"화면 미분을 직접 넘겨 밉 레벨을 결정. 좌표가 불연속인 곳(fract 타일)의 경계 줄무늬 제거.", ex:"textureGrad(tex, fract(uv), dFdx(uv), dFdy(uv))"},
      {name:"textureProj", sig:"vec4 textureProj(sampler2D s, vec3 p)", desc:"p.xy / p.z로 나눈 좌표로 읽기(투영 텍스처)."},
      {name:"textureLodOffset · textureProjLod …", sig:"textureLodOffset · textureProjOffset · textureProjLod · textureProjLodOffset · textureGradOffset · textureProjGrad · textureProjGradOffset", desc:"위 기능들의 조합 버전. 이름 그대로 Lod(레벨 지정)·Offset(정수 오프셋)·Proj(투영)·Grad(미분 지정)를 합친 것."}]},
    {id:"derivative", title:"화면 미분", desc:"이웃 픽셀과의 차이. GPU는 픽셀을 2×2 묶음으로 실행하므로 옆 픽셀의 값을 알 수 있습니다. 안티앨리어싱의 핵심 도구예요.", items:[
      {name:"dFdx · dFdy", sig:"T dFdx(T v) · T dFdy(T v)", desc:"v가 화면 가로·세로 한 픽셀마다 얼마나 변하는지. 분기 안(일부 픽셀만 실행)에서 쓰면 정의되지 않음.", ex:"vec3 n = normalize(cross(dFdx(pos), dFdy(pos)));   // 면 법선"},
      {name:"fwidth", sig:"T fwidth(T v)", desc:"abs(dFdx(v)) + abs(dFdy(v)). '이 값에서 픽셀 1개의 크기' — 어떤 스케일에서도 1픽셀 폭으로 부드러운 경계.", ex:"float w = fwidth(d); float a = 1.0 - smoothstep(-w, w, d);"}]},
    {id:"bits", title:"비트 · 정수 · 패킹", desc:"정수 연산과 실수↔비트 변환입니다. 정수에는 +, −, *, /, %, <<, >>, &, |, ^, ~ 연산자를 그대로 쓸 수 있어요(C와 동일).", items:[
      {name:"정수 연산자", sig:"I % I · I << I · I & I · I ^ I · ~I", desc:"C와 같은 정수 연산. 정수 나눗셈은 0 방향 버림. uint 상수는 1u처럼 u 접미사.", c:"C와 동일", ex:"ivec2 p = ivec2(gl_FragCoord.xy) & 3;"},
      {name:"floatBitsToInt · floatBitsToUint", sig:"I floatBitsToInt(T x) · U floatBitsToUint(T x)", desc:"실수의 IEEE 비트 패턴을 정수로 그대로 읽기(형변환 아님). 실수로 고품질 해시를 만들 때.", c:"memcpy(&i, &f, 4)", ex:"uint h = floatBitsToUint(p.x) * 747796405u;"},
      {name:"intBitsToFloat · uintBitsToFloat", sig:"T intBitsToFloat(I x) · T uintBitsToFloat(U x)", desc:"정수 비트 패턴을 실수로 해석.", c:"memcpy(&f, &i, 4)"},
      {name:"packHalf2x16 · unpackHalf2x16", sig:"uint packHalf2x16(vec2 v) · vec2 unpackHalf2x16(uint p)", desc:"vec2를 16비트 실수 두 개로 uint 하나에 압축 / 복원. 버퍼 채널 절약.", c:"half 변환 + 비트 시프트"},
      {name:"packUnorm2x16 · unpackUnorm2x16", sig:"uint packUnorm2x16(vec2 v) · vec2 unpackUnorm2x16(uint p)", desc:"0~1 값 두 개를 16비트 정수로 압축 / 복원."},
      {name:"packSnorm2x16 · unpackSnorm2x16", sig:"uint packSnorm2x16(vec2 v) · vec2 unpackSnorm2x16(uint p)", desc:"−1~1 값 두 개를 16비트 부호 정수로 압축 / 복원."},
      {name:"형변환 생성자", sig:"float(i) · int(f) · uint(i) · bool(x) · vec3(ivec3)", desc:"암묵 변환이 없으므로 생성자로 명시. int(f)는 0 방향 버림.", c:"(float)i, (int)f"}]},
    {id:"builtins", title:"내장 변수 · 문법", desc:"프래그먼트 셰이더에서 쓸 수 있는 내장 변수와 자주 헷갈리는 문법입니다.", items:[
      {name:"gl_FragCoord", sig:"in highp vec4 gl_FragCoord", desc:"이 픽셀의 창 좌표. xy = 픽셀 중심(0.5, 0.5부터), 원점은 왼쪽 아래. z = 깊이(0~1), w = 1/w.", ex:"vec2 uv = gl_FragCoord.xy / uResolution;"},
      {name:"gl_FrontFacing", sig:"in bool gl_FrontFacing", desc:"앞면 여부. 전체 화면 사각형만 그리는 이 앱에서는 항상 true."},
      {name:"gl_FragDepth", sig:"out highp float gl_FragDepth", desc:"깊이 값을 직접 쓰기. 이 앱은 깊이 버퍼를 쓰지 않으므로 효과 없음."},
      {name:"gl_PointCoord", sig:"in mediump vec2 gl_PointCoord", desc:"점 그리기용 좌표. 이 앱에서는 쓰이지 않음."},
      {name:"out 변수", sig:"out vec4 fragColor; · layout(location = N) out vec4 …;", desc:"출력 색. 이름은 자유. 출력이 여럿(MRT)이면 모두 location을 지정해야 함."},
      {name:"precision", sig:"precision highp float;", desc:"float 기본 정밀도. 프래그먼트 셰이더에는 기본값이 없어 반드시 선언. highp ≈ 32비트 IEEE.", c:"float"},
      {name:"매개변수 한정자", sig:"in · out · inout · const", desc:"in = 값 복사(기본), out = 함수가 써서 돌려줌, inout = 둘 다. 포인터 대신 이것으로 여러 값을 반환.", c:"in ≈ 값 전달, out/inout ≈ 포인터", ex:"void polar(vec2 p, out float r, out float a)"},
      {name:"스위즐", sig:"v.xy · v.zyx · v.rgb · v.stpq · v.xxx", desc:"성분을 원하는 순서·개수로 뽑기. xyzw·rgba·stpq는 같은 성분의 다른 이름(섞어 쓰기는 불가). 대입도 가능(v.xz = …).", ex:"p.xz = rot * p.xz;"},
      {name:"배열", sig:"float a[4] = float[4](1.0, 2.0, 3.0, 4.0);", desc:"크기는 상수. 배열 생성자로 초기화. .length()로 길이. 동적 할당·포인터 없음.", c:"float a[4] = {…}"},
      {name:"구조체", sig:"struct Hit { float t; vec3 n; };", desc:"C 구조체와 같음. 생성자 Hit(1.0, vec3(0))로 만들고 함수 반환값으로 쓸 수 있음.", c:"typedef struct"},
      {name:"반복문 제약", sig:"for (int i = 0; i < N; i++)", desc:"재귀 금지. 루프는 가능하면 상수 상한 + break. 너무 긴 루프는 GPU 타임아웃(화면 멈춤)을 일으킬 수 있음."},
      {name:"#define · #if", sig:"#define NAME value · #if … #endif", desc:"C 전처리기와 거의 같음(#include는 없음). 상수·매크로·디버그 스위치에."}]}
  ];
  const ALL = CATEGORIES.flatMap(category => category.items.map(item => ({...item, category:category.id})));
  export {CATEGORIES, ALL};
