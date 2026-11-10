// 다른 사람이 공개한 셰이더를 FIELD Studio로 옮긴 갤러리 예제. 갤러리의 "커뮤니티 셰이더" 칸에 나온다.
// 넣는 기준: 원작자가 작품에 MIT·CC0처럼 재배포를 허락하는 라이선스(또는 같은 뜻의 공개 허락)를 직접 밝힌 것만.
// (Shadertoy 기본 라이선스는 CC BY-NC-SA 3.0이고, 원작자가 "재배포 금지"를 붙인 작품도 있다 — 예: Inigo Quilez의 작품 장면들.)
// 셰이더 맨 위의 원작자·라이선스 주석은 지우지 않는다. 라이선스 전문은 docs/THIRD_PARTY_LICENSES.md에 있다.
// credit: { author, work(원래 제목), url, license, licenseUrl } — 갤러리 카드에 보인다.
// 파라미터(범위·기본값·색상)는 셰이더의 @어노테이션에만 적는다. 갤러리가 소스에서 읽어 등록한다.

const starNest = `#version 300 es
precision highp float;
// Star Nest by Pablo Roman Andrioli (Kali), 2013 — License: MIT
// 원본: https://www.shadertoy.com/view/XlfGRj
// Copyright (c) 2013 Pablo Roman Andrioli. MIT 라이선스 전문은 docs/THIRD_PARTY_LICENSES.md에 있다.
//
// FIELD Studio로 옮기며 바꾼 점:
//  · mainImage/iResolution/iTime/iMouse → main/uResolution/uTime/uMouse
//  · 마우스를 누르지 않아도 커서 위치로 방향을 돌린다(커서가 뷰포트 밖이면 원본의 기본 방향)
//  · speed · brightness · darkmatter · saturation을 파라미터 패널 슬라이더로 꺼냈다
//
// 원리(kaliset): 공간을 접어(tile) 반복한 뒤 p = abs(p)/dot(p,p) - c 를 여러 번 되풀이하면
// 값이 요동치는 정도(a)가 자리마다 크게 달라진다. 광선을 따라 그 값을 더해 가면 별과 성운이 된다.
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
uniform float uSpeed;      // 원본 speed · @range 0 0.05 @step 0.0005 @default 0.01
uniform float uBrightness; // 원본 brightness · @range 0.0002 0.004 @step 0.0001 @default 0.0015
uniform float uDarkMatter; // 원본 darkmatter · @range 0 1 @step 0.01 @default 0.3
uniform float uSaturation; // 원본 saturation · @range 0 1 @step 0.01 @default 0.85
out vec4 fragColor;

#define iterations 17
#define formuparam 0.53

#define volsteps 20
#define stepsize 0.1

#define zoom   0.800
#define tile   0.850

#define distfading 0.730

void main() {
	vec2 fragCoord = gl_FragCoord.xy;
	//get coords and direction
	vec2 uv=fragCoord.xy/uResolution.xy-.5;
	uv.y*=uResolution.y/uResolution.x;
	vec3 dir=vec3(uv*zoom,1.);
	float time=uTime*uSpeed+.25;

	//mouse rotation (커서가 없으면 uMouse = -1 → 원본처럼 0으로 본다)
	vec2 mouse=max(uMouse,vec2(0.));
	float a1=.5+mouse.x/uResolution.x*2.;
	float a2=.8+mouse.y/uResolution.y*2.;
	mat2 rot1=mat2(cos(a1),sin(a1),-sin(a1),cos(a1));
	mat2 rot2=mat2(cos(a2),sin(a2),-sin(a2),cos(a2));
	dir.xz*=rot1;
	dir.xy*=rot2;
	vec3 from=vec3(1.,.5,0.5);
	from+=vec3(time*2.,time,-2.);
	from.xz*=rot1;
	from.xy*=rot2;

	//volumetric rendering
	float s=0.1,fade=1.;
	vec3 v=vec3(0.);
	for (int r=0; r<volsteps; r++) {
		vec3 p=from+s*dir*.5;
		p = abs(vec3(tile)-mod(p,vec3(tile*2.))); // tiling fold
		float pa,a=pa=0.;
		for (int i=0; i<iterations; i++) {
			p=abs(p)/dot(p,p)-formuparam; // the magic formula
			a+=abs(length(p)-pa); // absolute sum of average change
			pa=length(p);
		}
		float dm=max(0.,uDarkMatter-a*a*.001); //dark matter
		a*=a*a; // add contrast
		if (r>6) fade*=1.-dm; // dark matter, don't render near
		v+=fade;
		v+=vec3(s,s*s,s*s*s*s)*a*uBrightness*fade; // coloring based on distance
		fade*=distfading; // distance fading
		s+=stepsize;
	}
	v=mix(vec3(length(v)),v,uSaturation); //color adjust
	fragColor = vec4(v*.01,1.);
}`;

const goldenApollian = `#version 300 es
precision highp float;
// Tunneling through golden apollian fractal II by mrange — Licence CC0
// 원본: https://gist.github.com/mrange/86fb851ff3c073a1a81a1cf21e48b285 (mrange의 Shadertoy 작품 "Golden apollian" 계열)
// CC0(퍼블릭 도메인 헌정)이라 저작권 고지 의무는 없지만 출처를 남긴다.
//
// FIELD Studio로 옮기며 바꾼 점:
//  · time/resolution/inData.v_texcoord → uTime·uSpeed/uResolution/gl_FragCoord
//  · GLSL ES 3.00에 맞춤: dFdxFine → dFdx, float*int 곱을 float로, 전역 초기값을 상수로
//  · sin 기반 실수 해시 → 정수 해시(pcg3d)
//
// 원리: 카메라가 경로(offset)를 따라 날아가며 일정 간격의 평면을 앞에서부터 하나씩 그려 겹친다(plane marcher).
// 평면마다 4D 아폴로니안 프랙탈(apollian)을 단면으로 잘라 금빛 고리 무늬를 만든다.
uniform vec2 uResolution;
uniform float uTime;
uniform float uSpeed; // 시간 배속(1 = 원본) · @range 0 3 @step 0.01 @default 1
out vec4 fragColor;

#define PI              3.141592654
#define TAU             (2.0*PI)
#define TIME            (uTime*uSpeed)
#define RESOLUTION      uResolution
#define ROT(a)          mat2(cos(a), sin(a), -sin(a), cos(a))
#define PSIN(x)         (0.5+0.5*sin(x))
#define LESS(a,b,c)     mix(a,b,step(0.,c))
#define SABS(x,k)       LESS((.5/(k))*(x)*(x)+(k)*.5,abs(x),abs(x)-(k))
#define L2(x)           dot(x, x)
#define PLANE_PERIOD    5.0

const vec3 std_gamma   = vec3(2.2, 2.2, 2.2);
const vec3 planeCol    = vec3(1.0, 1.15, 1.5)*0.95;
const vec3 baseRingCol = pow(vec3(1.0, 0.65, 0.25), vec3(0.6));
const vec3 sunCol      = vec3(1.25, 1.0, 1.1)/1.25;

struct effect {
  float lw;
  float tw;
  float sk;
  float cs;
};

const effect effects[] = effect[](
    effect(0.5, 0.0, 0.0, 0.0)
  , effect(0.5, 0.0, 0.0, 1.0)
  , effect(0.5, 0.0, 1.0, 1.0)
  , effect(0.5, 1.0, 1.0, 1.0)
  , effect(0.5, 1.0, 1.0, 0.0)
  , effect(0.5, 1.0, 0.0, 0.0)
  );
effect current_effect = effect(0.5, 1.0, 0.0, 0.0); // = effects[5]

// 원본은 sin 기반 실수 해시. FIELD 예제 규칙대로 정수 해시(pcg3d)로 바꿨다(평면마다 고르는 무늬·회전이 원본과 다르다).
uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
float hash(float co) {
  return float(pcg3d(uvec3(floatBitsToUint(co), 0u, 0u)).x >> 8u) * (1.0 / 16777216.0);
}

vec2 toPolar(vec2 p) {
  return vec2(length(p), atan(p.y, p.x));
}

vec2 toRect(vec2 p) {
  return vec2(p.x*cos(p.y), p.x*sin(p.y));
}

float modMirror1(inout float p, float size) {
  float halfsize = size*0.5;
  float c = floor((p + halfsize)/size);
  p = mod(p + halfsize,size) - halfsize;
  p *= mod(c, 2.0)*2.0 - 1.0;
  return c;
}

float smoothKaleidoscope(inout vec2 p, float sm, float rep) {
  vec2 hp = p;
  vec2 hpp = toPolar(hp);
  float rn = modMirror1(hpp.y, TAU/rep);
  float sa = PI/rep - SABS(PI/rep - abs(hpp.y), sm);
  hpp.y = sign(hpp.y)*(sa);
  hp = toRect(hpp);
  p = hp;
  return rn;
}

vec4 alphaBlend(vec4 back, vec4 front) {
  float w = front.w + back.w*(1.0-front.w);
  vec3 xyz = (front.xyz*front.w + back.xyz*back.w*(1.0-front.w))/w;
  return w > 0.0 ? vec4(xyz, w) : vec4(0.0);
}

vec3 alphaBlend(vec3 back, vec4 front) {
  return mix(back, front.xyz, front.w);
}

float tanh_approx(float x) {
//  return tanh(x);
  float x2 = x*x;
  return clamp(x*(27.0 + x2)/(27.0+9.0*x2), -1.0, 1.0);
}

float pmin(float a, float b, float k) {
  float h = clamp(0.5+0.5*(b-a)/k, 0.0, 1.0);
  
  return mix(b, a, h) - k*h*(1.0-h);
}

float circle(vec2 p, float r) {
  return length(p) - r;
}

float hex(vec2 p, float r) {
  const vec3 k = vec3(-sqrt(3.0)/2.0,1.0/2.0,sqrt(3.0)/3.0);
  p = p.yx;
  p = abs(p);
  p -= 2.0*min(dot(k.xy,p),0.0)*k.xy;
  p -= vec2(clamp(p.x, -k.z*r, k.z*r), r);
  return length(p)*sign(p.y);
}

float apollian(vec4 p, float s) {
  float scale = 1.0;
  for(int i=0; i<7; ++i) {
    p = -1.0 + 2.0*fract(0.5*p+0.5);
    float r2 = dot(p,p);
    float k  = s/r2;
    p       *= k;
    scale   *= k;
  }

  float lw = 0.00125*current_effect.lw;
  
  float d0 = abs(p.y)-lw*scale;
  float d1 = abs(circle(p.xz, 0.005*scale))-lw*scale;
  float d = d0;
  d = mix(d, min(d, d1), current_effect.tw);
  return (d/scale);
}

// -----------------------------------------------------------------------------
// PATH
// -----------------------------------------------------------------------------

// The path function
vec3 offset(float z) {
  float a = z;
  vec2 p = -0.075*(vec2(cos(a), sin(a*sqrt(2.0))) + vec2(cos(a*sqrt(0.75)), sin(a*sqrt(0.5))));
  return vec3(p, z);
}

// The derivate of the path function
//  Used to generate where we are looking
vec3 doffset(float z) {
  float eps = 0.1;
  return 0.5*(offset(z + eps) - offset(z - eps))/eps;
}

// The second derivate of the path function
//  Used to generate tilt
vec3 ddoffset(float z) {
  float eps = 0.1;
  return 0.125*(doffset(z + eps) - doffset(z - eps))/eps;
}

// -----------------------------------------------------------------------------
// PLANE MARCHER
// -----------------------------------------------------------------------------

float weird(vec2 p, float h) {
  float z = 4.0;
  float tm = 0.1*TIME+h*10.0;
  p *= ROT(tm*0.5);
  float r = 0.5;
  vec4 off = vec4(r*PSIN(tm*sqrt(3.0)), r*PSIN(tm*sqrt(1.5)), r*PSIN(tm*sqrt(2.0)), 0.0);
  vec4 pp = vec4(p.x, p.y, 0.0, 0.0)+off;
  pp.w = 0.125*(1.0-tanh_approx(length(pp.xyz)));
  pp.yz *= ROT(tm);
  pp.xz *= ROT(tm*sqrt(0.5));
  pp /= z;
  float d = apollian(pp, 0.8+h);
  return d*z;
}

float circles(vec2 p) {
  vec2 pp = toPolar(p);
  const float ss = 2.0;
  pp.x = fract(pp.x/ss)*ss;
  p = toRect(pp);
  float d = circle(p, 1.0);
  return d;
}

vec2 df(vec2 p, float h) {
  vec2 wp = p;
  float rep = 2.0*float(int(mix(5.0, 15.0, h*h)));
  float ss = 0.05*6.0/rep;

  if (current_effect.sk > 0.0) {
    smoothKaleidoscope(wp, ss, rep);
  }
  
  float d0 = weird(wp, h);
  float d1 = hex(p, 0.25)-0.1;
  float d2 = circles(p);
  const float lw = 0.0125;
  d2 = abs(d2)-lw;
  float d = d0;

  if (current_effect.cs > 0.0) {
    d  = pmin(d, d2, 0.1);
  }

  d  = pmin(d, abs(d1)-lw, 0.1);
  d  = max(d, -(d1+lw));
  return vec2(d, d1+lw);
}

vec2 df(vec3 p, vec3 off, float s, mat2 rot, float h) {
  vec2 p2 = p.xy;
  p2 -= off.xy;
  p2 *= rot;
  return df(p2/s, h)*s;
}

vec3 skyColor(vec3 ro, vec3 rd) {
  float ld = max(dot(rd, vec3(0.0, 0.0, 1.0)), 0.0);
  return 1.0*sunCol*tanh_approx(3.0*pow(ld, 100.0));
}

vec4 plane(vec3 ro, vec3 rd, vec3 pp, float pd, vec3 off, float aa, float n) {
  int pi = int(mod(n/PLANE_PERIOD, float(effects.length())));
  current_effect = effects[pi];
  
  float h = hash(n);
  float s = 0.25*mix(0.5, 0.25, h);
  const float lw = 0.0235;
  const float lh = 1.25;

  const vec3 loff = 2.0*vec3(0.25*0.5, 0.125*0.5, -0.125);
  vec3 lp1  = ro + loff;
  vec3 lp2  = ro + loff*vec3(-2.0, 1.0, 1.0);

  vec2 p = pp.xy-off.xy;

  mat2 rot = ROT(TAU*h);

  vec2 d2 = df(pp, off, s, rot, h);

  float hh = -1.0*smoothstep(-aa, aa*3.0, -d2.x);
  float hhx = dFdx(hh);
  float hhy = dFdy(hh);
  vec3  hn = normalize(vec3(hhx, hhy, -1));

  const vec3 nn  = vec3(0.0, 0.0, -1.0);
  vec3 ld1   = normalize(lp1 - pp);
  vec3 ld2   = normalize(lp2 - pp);
  float dif1 = pow(max(dot(nn, ld1), 0.0), 5.0);
  float dif2 = pow(max(dot(nn, ld2), 0.0), 5.0);
  vec3 ref   = reflect(rd, hn);
  float spe1= pow(max(dot(ref, ld1), 0.0), 30.0);
  float spe2= pow(max(dot(ref, ld2), 0.0), 30.0);

  const float boff = 0.0125*0.5;
  float dbt = boff/rd.z;
  
  vec3 bpp = ro + (pd + dbt)*rd;
  vec2 bp = bpp.xy - off.xy;

  vec3 srd1 = normalize(lp1-bpp);
  vec3 srd2 = normalize(lp2-bpp);
  float bl21= L2(lp1-bpp);
  float bl22= L2(lp2-bpp);

  float st1 = -boff/srd1.z;
  float st2 = -boff/srd2.z;

  vec3 spp1 = bpp + st1*srd1;
  vec3 spp2 = bpp + st2*srd2;
  
  vec2 bd  = df(bpp, off, s, rot, h);
  vec2 sd1 = df(spp1, off, s, rot, h);
  vec2 sd2 = df(spp2, off, s, rot, h);

  vec3 col  = vec3(0.0);
  const float ss = 200.0;

  col       += 0.1125*planeCol*dif1*(1.0-exp(-ss*(max((sd1.x), 0.0))))/bl21;
  col       += 0.1125*planeCol*dif2*0.5*(1.0-exp(-ss*(max((sd2.x), 0.0))))/bl22;
  
  vec3 ringCol = baseRingCol;
  ringCol *= vec3(clamp(0.1+2.5*(0.1+0.25*((dif1*dif1/bl21+dif2*dif2/bl22))), 0.0, 1.0));
  ringCol += sqrt(baseRingCol)*spe1*2.0;
  ringCol += sqrt(baseRingCol)*spe2*2.0;
  col       = mix(col, ringCol, smoothstep(-aa, aa, -d2.x));  

  float ha = smoothstep(-aa, aa, bd.y);

  return vec4(col, mix(0.0, 1.0, ha));
}

vec3 color(vec3 ww, vec3 uu, vec3 vv, vec3 ro, vec2 p) {
  float lp = length(p);
  vec2 np = p + 1.0/RESOLUTION.xy;
  float rdd = (2.0-0.5*tanh_approx(lp));  // Playing around with rdd can give interesting distortions
  vec3 rd = normalize(p.x*uu + p.y*vv + rdd*ww);
  vec3 nrd = normalize(np.x*uu + np.y*vv + rdd*ww);

  const float planeDist = 1.0-0.75;
  const int furthest = 9;
  const int fadeFrom = max(furthest-4, 0);
  const float fadeDist = planeDist*float(furthest - fadeFrom);
  float nz = floor(ro.z / planeDist);

  vec3 skyCol = skyColor(ro, rd);

  // Steps from nearest to furthest plane and accumulates the color

  vec4 acol = vec4(0.0);
  const float cutOff = 0.95;
  bool cutOut = false;
  
  for (int i = 1; i <= furthest; ++i) {
    float pz = planeDist*nz + planeDist*float(i);

    float pd = (pz - ro.z)/rd.z;

    if (pd > 0.0 && acol.w < cutOff) {
      vec3 pp = ro + rd*pd;
      vec3 npp = ro + nrd*pd;

      float aa = 3.0*length(pp - npp);

      vec3 off = offset(pp.z);

      vec4 pcol = plane(ro, rd, pp, pd, off, aa, nz+float(i));

      float nz = pp.z-ro.z;
      float fadeIn = exp(-2.5*max((nz - planeDist*float(fadeFrom))/fadeDist, 0.0));
      float fadeOut = smoothstep(0.0, planeDist*0.1, nz);
      pcol.xyz = mix(skyCol, pcol.xyz, (fadeIn));
      pcol.w *= fadeOut;

      pcol = clamp(pcol, 0.0, 1.0);

      acol = alphaBlend(pcol, acol);
    } else {
      cutOut = true;
      break;
    }

  }

  vec3 col = alphaBlend(skyCol, acol);
// To debug cutouts due to transparency  
//  col += cutOut ? vec3(1.0, -1.0, 0.0) : vec3(0.0);
  return col;
}

vec3 postProcess(vec3 col, vec2 q) {
  col = clamp(col, 0.0, 1.0);
  col = pow(col, 1.0/std_gamma);
  col = col*0.6+0.4*col*col*(3.0-2.0*col);
  col = mix(col, vec3(dot(col, vec3(0.33))), -0.4);
  col *=0.5+0.5*pow(19.0*q.x*q.y*(1.0-q.x)*(1.0-q.y),0.7);
  return col;
}

vec3 color(vec2 p, vec2 q) {
  float tm  = TIME*0.15+0.3;
  vec3 ro   = offset(tm);
  vec3 dro  = doffset(tm);
  vec3 ddro = ddoffset(tm);

  vec3 ww = normalize(dro);
  vec3 uu = normalize(cross(normalize(vec3(0.0,1.0,0.0)+ddro), ww));
  vec3 vv = normalize(cross(ww, uu));

  vec3 col = color(ww, uu, vv, ro, p);
  col = postProcess(col, q);

  return col;
}

void main() {
  vec2 q = gl_FragCoord.xy/uResolution;
  vec2 p = -1. + 2. * q;
  p.x *= RESOLUTION.x/RESOLUTION.y;

  vec3 col = color(p, q);

  fragColor = vec4(col, 1.0);
}`;

const terrain = `#version 300 es
precision highp float;
// Raymarched mountains (Elevated-style terrain) by Francisco Piaggio, 2026 — License: MIT
// 원본: https://github.com/franpiaggio/shader-terrain-landscapes (demo/elevated.html)
// Copyright (c) 2026 Francisco Piaggio. MIT 라이선스 전문은 docs/THIRD_PARTY_LICENSES.md에 있다.
// 원작자 설명: Iñigo Quilez의 기법(값 노이즈 미분·침식, terrain marching, 부드러운 그림자, 안개,
// 야외 조명)을 바탕으로 교육용으로 새로 짠 코드. 기법 출처: https://iquilezles.org/articles/terrainmarching/
//
// FIELD Studio로 옮기며 바꾼 점:
//  · mainImage/iResolution/iTime → main/uResolution/uTime, JS가 넣던 값들을 파라미터 패널 Uniform으로
//  · 'Day' 프리셋을 기본값으로, Randomize(두 지형 섞기) 대신 uSeed 슬라이더
//  · 해시를 정수 해시(pcg3d)로 바꿈 → 같은 seed라도 원본과 산 모양이 다르다
//  · 원본은 640×640 고정 해상도. 무거우면 설정에서 렌더 배율을 낮춘다
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
uniform float uHeight;   // 산 높이(원본 H) · @range 4 30 @step 0.1 @default 16 @group 지형
uniform float uSnow;     // 눈이 쌓이기 시작하는 높이 · @range 0 1 @step 0.01 @default 0.55 @group 지형
uniform float uExposure; // 노출(원본 uExp) · @range 0.2 2 @step 0.01 @default 1 @group 빛과 하늘
uniform float uSeed;     // 지형 고르기 · @seed @range 0 100 @step 1 @default 0 @group 지형
uniform vec3 uSunCol;    // 햇빛 · @color @default 1 0.92 0.7 @group 빛과 하늘
uniform vec3 uSky1;      // 지평선 쪽 하늘 · @color @default 0.34 0.56 0.9 @group 빛과 하늘
uniform vec3 uSky2;      // 천정 쪽 하늘 · @color @default 0.06 0.18 0.46 @group 빛과 하늘
uniform vec3 uFogC;      // 안개 · @color @default 0.55 0.66 0.82 @group 빛과 하늘
uniform vec3 uSunDir;    // 해 방향 · @dir hemi @default -0.95 0.28 0.2 @group 빛과 하늘
out vec4 fragColor;
#define H uHeight
#define uExp uExposure

// 원본 해시는 fract(p*상수) 계열이라 좌표가 커지면(멀리 날아갈수록) 정밀도가 떨어진다. 정수 해시(pcg3d)로 바꿨다.
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
float hash(vec2 p){ return float(pcg3d(uvec3(floatBitsToUint(p), 0u)).x >> 8u) * (1.0 / 16777216.0); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }
const mat2 m2=mat2(0.8,-0.6,0.6,0.8);
float fbm2(vec2 p){ float h=0.0,a=0.5; for(int i=0;i<5;i++){ h+=a*noise(p); p=m2*p*2.0; a*=0.5; } return h; }
vec3 noised(vec2 x){
  vec2 i=floor(x), f=fract(x);
  vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 du=30.0*f*f*(f*(f-2.0)+1.0);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  return vec3(a+(b-a)*u.x+(c-a)*u.y+(a-b-c+d)*u.x*u.y,
              du*(vec2(b-a,c-a)+(a-b-c+d)*u.yx));
}
vec2 warp(vec2 x){ vec2 w=vec2(noise(x*0.012), noise(x*0.012+vec2(31.4,12.1))); return x + (w-0.5)*22.0; }
float shapeM(vec2 x){ vec2 p=warp(x)*0.022; float a=0.0,b=1.0; vec2 d=vec2(0.0);
  for(int i=0;i<7;i++){ vec3 n=noised(p); d+=n.yz; a+=b*n.x/(1.0+dot(d,d)); b*=0.5; p=m2*p*2.0; } return a; }
float shapeH(vec2 x){ vec2 p=warp(x)*0.022; float a=0.0,b=1.0; vec2 d=vec2(0.0);
  for(int i=0;i<11;i++){ vec3 n=noised(p); d+=n.yz; a+=b*n.x/(1.0+dot(d,d)); b*=0.5; p=m2*p*2.0; } return a; }
// 원본은 두 지형을 섞어 모양을 바꾸는 Randomize 버튼이 있다. 여기서는 uSeed 슬라이더로 지형을 고른다.
vec2 seedOffset(){ return vec2(37.0, -53.0)*uSeed; }
float terrainM(vec2 x){ return H*shapeM(x+seedOffset()); }   // 레이 마칭용(7옥타브, 빠름)
float terrainH(vec2 x){ return H*shapeH(x+seedOffset()); }   // 법선용(11옥타브, 자세함)
float castRay(vec3 ro, vec3 rd){
  float t=0.5, tmax=520.0;
  for(int i=0;i<300;i++){ vec3 p=ro+t*rd; float h=p.y-terrainM(p.xz);
    if(h<0.0015*t || t>tmax) break; t+=0.4*h; }
  return (t>tmax)?-1.0:t;
}
vec3 calcNormal(vec3 p, float t){ vec2 e=vec2(0.0015*t+0.01,0.0);
  return normalize(vec3(terrainH(p.xz-e.xy)-terrainH(p.xz+e.xy), 2.0*e.x,
                        terrainH(p.xz-e.yx)-terrainH(p.xz+e.yx))); }
float shadow(vec3 ro, vec3 rd){ float res=1.0,t=0.5;
  for(int i=0;i<40;i++){ vec3 p=ro+t*rd; float h=p.y-terrainM(p.xz);
    res=min(res,12.0*h/t); t+=max(0.5,h); if(res<0.01||p.y>H*1.5) break; } return clamp(res,0.0,1.0); }
vec3 sky(vec3 ro, vec3 rd, vec3 sun){
  vec3 col=mix(uSky1, uSky2, clamp(rd.y*1.3,0.0,1.0));
  float sd=clamp(dot(rd,sun),0.0,1.0);
  col=mix(col, uSunCol, pow(sd,5.0)*0.55*clamp(1.0-rd.y*2.5,0.0,1.0));
  col+=uSunCol*1.4*pow(sd,180.0);
  col+=uSunCol*pow(sd,8.0)*0.25;
  if(rd.y>0.005){
    float tp=(95.0-ro.y)/rd.y;
    vec2 cp=(ro+rd*tp).xz*0.006 + vec2(uTime*0.012,0.0);
    float cl=smoothstep(0.34,0.62,fbm2(cp*1.3));
    float li=smoothstep(0.34,0.62,fbm2((cp+sun.xz*0.10)*1.3));
    vec3 cc=mix(vec3(0.6,0.64,0.76), vec3(1.0,0.99,0.96), clamp((cl-li)*3.0+0.7,0.0,1.0));
    col=mix(col, cc, cl*smoothstep(0.0,0.12,rd.y)*0.95);
  }
  return col;
}
void main(){
  vec2 fragCoord=gl_FragCoord.xy;
  // 원본은 커서를 부드럽게 따라가는 0~1 좌표(y는 위에서 아래). 커서가 뷰포트 밖이면 원본의 시작 위치.
  float uMouseX = uMouse.x<0.0 ? 0.5 : uMouse.x/uResolution.x;
  float uMouseY = uMouse.x<0.0 ? 0.42 : 1.0-uMouse.y/uResolution.y;
  vec2 uv=(fragCoord-0.5*uResolution.xy)/uResolution.y;
  vec3 sun=normalize(uSunDir);
  float yaw=(0.5-uMouseX)*1.6;
  float pitch=-(uMouseY-0.5)*0.5 - 0.30;
  vec3 ro=vec3(0.0, 30.0, uTime*4.0);
  vec3 ww=normalize(vec3(sin(yaw), pitch, cos(yaw)));
  vec3 uu=normalize(cross(ww,vec3(0,1,0))), vv=cross(uu,ww);
  vec3 rd=normalize(uu*uv.x+vv*uv.y+ww*1.4);
  vec3 col; float t=castRay(ro,rd);
  if(t<0.0){ col=sky(ro,rd,sun); }
  else{
    vec3 p=ro+t*rd; vec3 n=calcNormal(p,t);
    float slope=n.y, h01=clamp(p.y/H,0.0,1.0);
    vec3 grass=vec3(0.13,0.27,0.07), rock=vec3(0.30,0.24,0.18), snow=vec3(0.95,0.96,1.0);
    vec3 mat=mix(rock,grass,smoothstep(0.55,0.82,slope));
    mat=mix(mat,snow,smoothstep(uSnow,uSnow+0.23,h01)*smoothstep(0.45,0.75,slope));
    float dif=clamp(dot(n,sun),0.0,1.0), sh=0.28+0.72*shadow(p+n*0.2+sun*0.3,sun), skyl=clamp(0.5+0.5*n.y,0.0,1.0);
    float ao=clamp(0.4+0.6*h01,0.0,1.0);
    col=mat*(uSunCol*1.5*dif*sh + (uSky2*1.4+vec3(0.05))*skyl*ao);
    vec3 fogCol=mix(uFogC, uSunCol, pow(clamp(dot(rd,sun),0.0,1.0),5.0)*0.7);
    fogCol=mix(fogCol, sky(ro,rd,sun), 0.6);
    col=mix(col, fogCol, 1.0-exp(-0.00009*t*t));
  }
  col*=uExp;
  col=col/(1.0+col*0.32)*1.18;
  vec2 q=fragCoord/uResolution.xy;
  col*=0.5+0.5*pow(16.0*q.x*q.y*(1.0-q.x)*(1.0-q.y),0.12);
  col=pow(col, vec3(0.4545));
  fragColor=vec4(col,1.0);
}`;

const rayTracingBuffer = `#version 300 es
precision highp float;
// Buffer A — 경로 추적(path tracing) 누적. iChannel0 = A (previous)
// Ray Tracing - Primitives by Reinder Nijhoff, 2019 — The MIT License
// 원본: https://www.shadertoy.com/view/tl23Rm (작가 백업: https://github.com/reindernijhoff/shadertoy)
// Copyright (c) 2019 Reinder Nijhoff. MIT 라이선스 전문은 docs/THIRD_PARTY_LICENSES.md에 있다.
// 교차 함수 대부분은 원작자가 밝힌 대로 Iñigo Quílez의 글과 예제(https://iquilezles.org/articles/intersectors)에서 왔다.
//
// FIELD Studio로 옮기며 바꾼 점:
//  · Shadertoy의 Common 탭 내용을 이 버퍼 앞부분에 그대로 붙였다(FIELD에는 Common 탭이 없다)
//  · mainImage/iResolution/iTime/iFrame/iMouse → main/uResolution/uTime/uFrame/uMouse
//  · 카메라는 뷰포트를 누른 채 끌 때만 돌린다(아래 main 주석)
//  · 재질 해시를 정수 해시로 바꿈 → 물체 재질이 원본과 다르다
//
// 원리: 프레임마다 픽셀당 광선 하나를 장면에 쏘아 최대 12번 튕기며(난반사·금속·유리) 색을 모으고,
// 직전 프레임의 합(previous)에 더한다. Image가 합을 개수(w)로 나눠 평균을 보여 주므로 시간이 지날수록 노이즈가 줄어든다.
uniform vec2 uResolution;
uniform float uTime;
uniform int uFrame;
uniform vec4 uMouse;          // xy = 커서, z > 0 = 버튼 누름 중
uniform sampler2D iChannel0;  // A · previous
out vec4 fragColor;

// ---------------------------------------------------------------------------
// Common (원본의 Common 탭)
// ---------------------------------------------------------------------------
// Ray Tracing - Primitives. Created by Reinder Nijhoff 2019
// The MIT License
// @reindernijhoff
//
// https://www.shadertoy.com/view/tl23Rm
//
// I wanted to create a reference shader similar to "Raymarching - Primitives" 
// (https://www.shadertoy.com/view/Xds3zN), but with ray-primitive intersection 
// routines instead of sdf routines.
// 
// As usual, I ended up mostly just copy-pasting code from Íñigo Quílez: 
// 
// https://iquilezles.org/articles/intersectors
// 
// Please let me know if there are other routines that I should add to this shader.
// 
// Sphere:          https://www.shadertoy.com/view/4d2XWV
// Box:             https://www.shadertoy.com/view/ld23DV
// Capped Cylinder: https://www.shadertoy.com/view/4lcSRn
// Torus:           https://www.shadertoy.com/view/4sBGDy
// Capsule:         https://www.shadertoy.com/view/Xt3SzX
// Capped Cone:     https://www.shadertoy.com/view/llcfRf
// Ellipsoid:       https://www.shadertoy.com/view/MlsSzn
// Rounded Cone:    https://www.shadertoy.com/view/MlKfzm
// Triangle:        https://www.shadertoy.com/view/MlGcDz
// Sphere4:         https://www.shadertoy.com/view/3tj3DW
// Goursat:         https://www.shadertoy.com/view/3lj3DW
// Rounded Box:     https://www.shadertoy.com/view/WlSXRW
//
// Disk:            https://www.shadertoy.com/view/lsfGDB
//

#define MAX_DIST 1e10
float dot2( in vec3 v ) { return dot(v,v); }

// Plane 
float iPlane( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
              in vec3 planeNormal, in float planeDist) {
    float a = dot(rd, planeNormal);
    float d = -(dot(ro, planeNormal)+planeDist)/a;
    if (a > 0. || d < distBound.x || d > distBound.y) {
        return MAX_DIST;
    } else {
        normal = planeNormal;
    	return d;
    }
}

// Sphere:          https://www.shadertoy.com/view/4d2XWV
float iSphere( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
               float sphereRadius ) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - sphereRadius*sphereRadius;
    float h = b*b - c;
    if (h < 0.) {
        return MAX_DIST;
    } else {
	    h = sqrt(h);
        float d1 = -b-h;
        float d2 = -b+h;
        if (d1 >= distBound.x && d1 <= distBound.y) {
            normal = normalize(ro + rd*d1);
            return d1;
        } else if (d2 >= distBound.x && d2 <= distBound.y) { 
            normal = normalize(ro + rd*d2);            
            return d2;
        } else {
            return MAX_DIST;
        }
    }
}

// Box:             https://www.shadertoy.com/view/ld23DV
float iBox( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal, 
            in vec3 boxSize ) {
    vec3 m = sign(rd)/max(abs(rd), 1e-8);
    vec3 n = m*ro;
    vec3 k = abs(m)*boxSize;
	
    vec3 t1 = -n - k;
    vec3 t2 = -n + k;

	float tN = max( max( t1.x, t1.y ), t1.z );
	float tF = min( min( t2.x, t2.y ), t2.z );
	
    if (tN > tF || tF <= 0.) {
        return MAX_DIST;
    } else {
        if (tN >= distBound.x && tN <= distBound.y) {
        	normal = -sign(rd)*step(t1.yzx,t1.xyz)*step(t1.zxy,t1.xyz);
            return tN;
        } else if (tF >= distBound.x && tF <= distBound.y) { 
        	normal = -sign(rd)*step(t1.yzx,t1.xyz)*step(t1.zxy,t1.xyz);
            return tF;
        } else {
            return MAX_DIST;
        }
    }
}

// Capped Cylinder: https://www.shadertoy.com/view/4lcSRn
float iCylinder( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
                 in vec3 pa, in vec3 pb, float ra ) {
    vec3 ca = pb-pa;
    vec3 oc = ro-pa;

    float caca = dot(ca,ca);
    float card = dot(ca,rd);
    float caoc = dot(ca,oc);
    
    float a = caca - card*card;
    float b = caca*dot( oc, rd) - caoc*card;
    float c = caca*dot( oc, oc) - caoc*caoc - ra*ra*caca;
    float h = b*b - a*c;
    
    if (h < 0.) return MAX_DIST;
    
    h = sqrt(h);
    float d = (-b-h)/a;

    float y = caoc + d*card;
    if (y > 0. && y < caca && d >= distBound.x && d <= distBound.y) {
        normal = (oc+d*rd-ca*y/caca)/ra;
        return d;
    }

    d = ((y < 0. ? 0. : caca) - caoc)/card;
    
    if( abs(b+a*d) < h && d >= distBound.x && d <= distBound.y) {
        normal = normalize(ca*sign(y)/caca);
        return d;
    } else {
        return MAX_DIST;
    }
}

// Torus:           https://www.shadertoy.com/view/4sBGDy
float iTorus( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
              in vec2 torus ) {
    // bounding sphere
    vec3 tmpnormal;
    if (iSphere(ro, rd, distBound, tmpnormal, torus.y+torus.x) > distBound.y) {
        return MAX_DIST;
    }
    
    float po = 1.0;
    
	float Ra2 = torus.x*torus.x;
	float ra2 = torus.y*torus.y;
	
	float m = dot(ro,ro);
	float n = dot(ro,rd);

#if 1
	float k = (m + Ra2 - ra2)/2.0;
    float k3 = n;
	float k2 = n*n - Ra2*dot(rd.xy,rd.xy) + k;
    float k1 = n*k - Ra2*dot(rd.xy,ro.xy);
    float k0 = k*k - Ra2*dot(ro.xy,ro.xy);
#else
	float k = (m - Ra2 - ra2)/2.0;
	float k3 = n;
	float k2 = n*n + Ra2*rd.z*rd.z + k;
	float k1 = k*n + Ra2*ro.z*rd.z;
	float k0 = k*k + Ra2*ro.z*ro.z - Ra2*ra2;
#endif
    
#if 1
    // prevent |c1| from being too close to zero
    if (abs(k3*(k3*k3-k2)+k1) < 0.01) {
        po = -1.0;
        float tmp=k1; k1=k3; k3=tmp;
        k0 = 1.0/k0;
        k1 = k1*k0;
        k2 = k2*k0;
        k3 = k3*k0;
    }
#endif
    
    // reduced cubic
    float c2 = k2*2.0 - 3.0*k3*k3;
    float c1 = k3*(k3*k3-k2)+k1;
    float c0 = k3*(k3*(c2+2.0*k2)-8.0*k1)+4.0*k0;
    
    c2 /= 3.0;
    c1 *= 2.0;
    c0 /= 3.0;

    float Q = c2*c2 + c0;
    float R = c2*c2*c2 - 3.0*c2*c0 + c1*c1;
    
    float h = R*R - Q*Q*Q;
    float t = MAX_DIST;
    
    if (h>=0.0) {
        // 2 intersections
        h = sqrt(h);
        
        float v = sign(R+h)*pow(abs(R+h),1.0/3.0); // cube root
        float u = sign(R-h)*pow(abs(R-h),1.0/3.0); // cube root

        vec2 s = vec2( (v+u)+4.0*c2, (v-u)*sqrt(3.0));
    
        float y = sqrt(0.5*(length(s)+s.x));
        float x = 0.5*s.y/y;
        float r = 2.0*c1/(x*x+y*y);

        float t1 =  x - r - k3; t1 = (po<0.0)?2.0/t1:t1;
        float t2 = -x - r - k3; t2 = (po<0.0)?2.0/t2:t2;

        if (t1 >= distBound.x) t=t1;
        if (t2 >= distBound.x) t=min(t,t2);
	} else {
        // 4 intersections
        float sQ = sqrt(Q);
        float w = sQ*cos( acos(-R/(sQ*Q)) / 3.0 );

        float d2 = -(w+c2); if( d2<0.0 ) return MAX_DIST;
        float d1 = sqrt(d2);

        float h1 = sqrt(w - 2.0*c2 + c1/d1);
        float h2 = sqrt(w - 2.0*c2 - c1/d1);
        float t1 = -d1 - h1 - k3; t1 = (po<0.0)?2.0/t1:t1;
        float t2 = -d1 + h1 - k3; t2 = (po<0.0)?2.0/t2:t2;
        float t3 =  d1 - h2 - k3; t3 = (po<0.0)?2.0/t3:t3;
        float t4 =  d1 + h2 - k3; t4 = (po<0.0)?2.0/t4:t4;

        if (t1 >= distBound.x) t=t1;
        if (t2 >= distBound.x) t=min(t,t2);
        if (t3 >= distBound.x) t=min(t,t3);
        if (t4 >= distBound.x) t=min(t,t4);
    }
    
	if (t >= distBound.x && t <= distBound.y) {
        vec3 pos = ro + rd*t;
        normal = normalize( pos*(dot(pos,pos) - torus.y*torus.y - torus.x*torus.x*vec3(1,1,-1)));
        return t;
    } else {
        return MAX_DIST;
    }
}

// Capsule:         https://www.shadertoy.com/view/Xt3SzX
float iCapsule( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
                in vec3 pa, in vec3 pb, in float r ) {
    vec3  ba = pb - pa;
    vec3  oa = ro - pa;

    float baba = dot(ba,ba);
    float bard = dot(ba,rd);
    float baoa = dot(ba,oa);
    float rdoa = dot(rd,oa);
    float oaoa = dot(oa,oa);

    float a = baba      - bard*bard;
    float b = baba*rdoa - baoa*bard;
    float c = baba*oaoa - baoa*baoa - r*r*baba;
    float h = b*b - a*c;
    if (h >= 0.) {
        float t = (-b-sqrt(h))/a;
        float d = MAX_DIST;
        
        float y = baoa + t*bard;
        
        // body
        if (y > 0. && y < baba) {
            d = t;
        } else {
            // caps
            vec3 oc = (y <= 0.) ? oa : ro - pb;
            b = dot(rd,oc);
            c = dot(oc,oc) - r*r;
            h = b*b - c;
            if( h>0.0 ) {
                d = -b - sqrt(h);
            }
        }
        if (d >= distBound.x && d <= distBound.y) {
            vec3  pa = ro + rd * d - pa;
            float h = clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0);
            normal = (pa - h*ba)/r;
            return d;
        }
    }
    return MAX_DIST;
}

// Capped Cone:     https://www.shadertoy.com/view/llcfRf
float iCone( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
             in vec3  pa, in vec3  pb, in float ra, in float rb ) {
    vec3  ba = pb - pa;
    vec3  oa = ro - pa;
    vec3  ob = ro - pb;
    
    float m0 = dot(ba,ba);
    float m1 = dot(oa,ba);
    float m2 = dot(ob,ba); 
    float m3 = dot(rd,ba);

    //caps
    if (m1 < 0.) { 
        if( dot2(oa*m3-rd*m1)<(ra*ra*m3*m3) ) {
            float d = -m1/m3;
            if (d >= distBound.x && d <= distBound.y) {
                normal = -ba*inversesqrt(m0);
                return d;
            }
        }
    }
    else if (m2 > 0.) { 
        if( dot2(ob*m3-rd*m2)<(rb*rb*m3*m3) ) {
            float d = -m2/m3;
            if (d >= distBound.x && d <= distBound.y) {
                normal = ba*inversesqrt(m0);
                return d;
            }
        }
    }
                       
    // body
    float m4 = dot(rd,oa);
    float m5 = dot(oa,oa);
    float rr = ra - rb;
    float hy = m0 + rr*rr;
    
    float k2 = m0*m0    - m3*m3*hy;
    float k1 = m0*m0*m4 - m1*m3*hy + m0*ra*(rr*m3*1.0        );
    float k0 = m0*m0*m5 - m1*m1*hy + m0*ra*(rr*m1*2.0 - m0*ra);
    
    float h = k1*k1 - k2*k0;
    if( h < 0. ) return MAX_DIST;

    float t = (-k1-sqrt(h))/k2;

    float y = m1 + t*m3;
    if (y > 0. && y < m0 && t >= distBound.x && t <= distBound.y) {
        normal = normalize(m0*(m0*(oa+t*rd)+rr*ba*ra)-ba*hy*y);
        return t;
    } else {   
	    return MAX_DIST;
    }
}

// Ellipsoid:       https://www.shadertoy.com/view/MlsSzn
float iEllipsoid( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
                  in vec3 rad ) {
    vec3 ocn = ro / rad;
    vec3 rdn = rd / rad;
    
    float a = dot( rdn, rdn );
	float b = dot( ocn, rdn );
	float c = dot( ocn, ocn );
	float h = b*b - a*(c-1.);
    
    if (h < 0.) {
        return MAX_DIST;
    }
    
	float d = (-b - sqrt(h))/a;
    
    if (d < distBound.x || d > distBound.y) {
        return MAX_DIST;
    } else {
        normal = normalize((ro + d*rd)/rad);
    	return d;
    }
}

// Rounded Cone:    https://www.shadertoy.com/view/MlKfzm
float iRoundedCone( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
                    in vec3  pa, in vec3  pb, in float ra, in float rb ) {
    vec3  ba = pb - pa;
	vec3  oa = ro - pa;
	vec3  ob = ro - pb;
    float rr = ra - rb;
    float m0 = dot(ba,ba);
    float m1 = dot(ba,oa);
    float m2 = dot(ba,rd);
    float m3 = dot(rd,oa);
    float m5 = dot(oa,oa);
	float m6 = dot(ob,rd);
    float m7 = dot(ob,ob);
    
    float d2 = m0-rr*rr;
    
	float k2 = d2    - m2*m2;
    float k1 = d2*m3 - m1*m2 + m2*rr*ra;
    float k0 = d2*m5 - m1*m1 + m1*rr*ra*2. - m0*ra*ra;
    
	float h = k1*k1 - k0*k2;
    if (h < 0.0) {
        return MAX_DIST;
    }
    
    float t = (-sqrt(h)-k1)/k2;
    
    float y = m1 - ra*rr + t*m2;
    if (y>0.0 && y<d2) {
        if (t >= distBound.x && t <= distBound.y) {
        	normal = normalize( d2*(oa + t*rd)-ba*y );
            return t;
        } else {
            return MAX_DIST;
        }
    } else {
        float h1 = m3*m3 - m5 + ra*ra;
        float h2 = m6*m6 - m7 + rb*rb;

        if (max(h1,h2)<0.0) {
            return MAX_DIST;
        }

        vec3 n = vec3(0);
        float r = MAX_DIST;

        if (h1 > 0.) {        
            r = -m3 - sqrt( h1 );
            n = (oa+r*rd)/ra;
        }
        if (h2 > 0.) {
            t = -m6 - sqrt( h2 );
            if( t<r ) {
                n = (ob+t*rd)/rb;
                r = t;
            }
        }
        if (r >= distBound.x && r <= distBound.y) {
            normal = n;
            return r;
        } else {
            return MAX_DIST;
        }
    }
}

// Triangle:        https://www.shadertoy.com/view/MlGcDz
float iTriangle( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
                 in vec3 v0, in vec3 v1, in vec3 v2 ) {
    vec3 v1v0 = v1 - v0;
    vec3 v2v0 = v2 - v0;
    vec3 rov0 = ro - v0;

    vec3  n = cross( v1v0, v2v0 );
    vec3  q = cross( rov0, rd );
    float d = 1.0/dot( rd, n );
    float u = d*dot( -q, v2v0 );
    float v = d*dot(  q, v1v0 );
    float t = d*dot( -n, rov0 );

    if( u<0. || v<0. || (u+v)>1. || t<distBound.x || t>distBound.y) {
        return MAX_DIST;
    } else {
        normal = normalize(-n);
        return t;
    }
}

// Sphere4:         https://www.shadertoy.com/view/3tj3DW
float iSphere4( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
                in float ra ) {
    // -----------------------------
    // solve quartic equation
    // -----------------------------
    
    float r2 = ra*ra;
    
    vec3 d2 = rd*rd; vec3 d3 = d2*rd;
    vec3 o2 = ro*ro; vec3 o3 = o2*ro;

    float ka = 1.0/dot(d2,d2);

    float k0 = ka* dot(ro,d3);
    float k1 = ka* dot(o2,d2);
    float k2 = ka* dot(o3,rd);
    float k3 = ka*(dot(o2,o2) - r2*r2);

    // -----------------------------
    // solve cubic
    // -----------------------------

    float c0 = k1 - k0*k0;
    float c1 = k2 + 2.0*k0*(k0*k0 - (3.0/2.0)*k1);
    float c2 = k3 - 3.0*k0*(k0*(k0*k0 - 2.0*k1) + (4.0/3.0)*k2);

    float p = c0*c0*3.0 + c2;
    float q = c0*c0*c0 - c0*c2 + c1*c1;
    float h = q*q - p*p*p*(1.0/27.0);

    // -----------------------------
    // skip the case of 3 real solutions for the cubic, which involves 
    // 4 complex solutions for the quartic, since we know this objcet is 
    // convex
    // -----------------------------
    if (h<0.0) {
        return MAX_DIST;
    }
    
    // one real solution, two complex (conjugated)
    h = sqrt(h);

    float s = sign(q+h)*pow(abs(q+h),1.0/3.0); // cuberoot
    float t = sign(q-h)*pow(abs(q-h),1.0/3.0); // cuberoot

    vec2 v = vec2( (s+t)+c0*4.0, (s-t)*sqrt(3.0) )*0.5;
    
    // -----------------------------
    // the quartic will have two real solutions and two complex solutions.
    // we only want the real ones
    // -----------------------------
    
    float r = length(v);
	float d = -abs(v.y)/sqrt(r+v.x) - c1/r - k0;

    if (d >= distBound.x && d <= distBound.y) {
	    vec3 pos = ro + rd * d;
	    normal = normalize( pos*pos*pos );
	    return d;
    } else {
        return MAX_DIST;
    }
}

// Goursat:         https://www.shadertoy.com/view/3lj3DW
float cuberoot( float x ) { return sign(x)*pow(abs(x),1.0/3.0); }

float iGoursat( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
                in float ra, float rb ) {
// hole: x4 + y4 + z4 - (r2^2)·(x2 + y2 + z2) + r1^4 = 0;
    float ra2 = ra*ra;
    float rb2 = rb*rb;
    
    vec3 rd2 = rd*rd; vec3 rd3 = rd2*rd;
    vec3 ro2 = ro*ro; vec3 ro3 = ro2*ro;

    float ka = 1.0/dot(rd2,rd2);

    float k3 = ka*(dot(ro ,rd3));
    float k2 = ka*(dot(ro2,rd2) - rb2/6.0);
    float k1 = ka*(dot(ro3,rd ) - rb2*dot(rd,ro)/2.0  );
    float k0 = ka*(dot(ro2,ro2) + ra2*ra2 - rb2*dot(ro,ro) );

    float c2 = k2 - k3*(k3);
    float c1 = k1 + k3*(2.0*k3*k3-3.0*k2);
    float c0 = k0 + k3*(k3*(c2+k2)*3.0-4.0*k1);

    c0 /= 3.0;

    float Q = c2*c2 + c0;
    float R = c2*c2*c2 - 3.0*c0*c2 + c1*c1;
    float h = R*R - Q*Q*Q;
    
    
    // 2 intersections
    if (h>0.0) {
        h = sqrt(h);

        float s = cuberoot( R + h );
        float u = cuberoot( R - h );
        
        float x = s+u+4.0*c2;
        float y = s-u;
        
        float k2 = x*x + y*y*3.0;
  
        float k = sqrt(k2);

		float d = -0.5*abs(y)*sqrt(6.0/(k+x)) 
                  -2.0*c1*(k+x)/(k2+x*k) 
                  -k3;
        
        if (d >= distBound.x && d <= distBound.y) {
            vec3 pos = ro + rd * d;
            normal = normalize( 4.0*pos*pos*pos - 2.0*pos*rb*rb );
            return d;
        } else {
            return MAX_DIST;
        }
    } else {	
        // 4 intersections
        float sQ = sqrt(Q);
        float z = c2 - 2.0*sQ*cos( acos(-R/(sQ*Q)) / 3.0 );

        float d1 = z   - 3.0*c2;
        float d2 = z*z - 3.0*c0;

        if (abs(d1)<1.0e-4) {  
            if( d2<0.0) return MAX_DIST;
            d2 = sqrt(d2);
        } else {
            if (d1<0.0) return MAX_DIST;
            d1 = sqrt( d1/2.0 );
            d2 = c1/d1;
        }

        //----------------------------------

        float h1 = sqrt(d1*d1 - z + d2);
        float h2 = sqrt(d1*d1 - z - d2);
        float t1 = -d1 - h1 - k3;
        float t2 = -d1 + h1 - k3;
        float t3 =  d1 - h2 - k3;
        float t4 =  d1 + h2 - k3;

        if (t2<0.0 && t4<0.0) return MAX_DIST;

        float result = 1e20;
             if (t1>0.0) result=t1;
        else if (t2>0.0) result=t2;
             if (t3>0.0) result=min(result,t3);
        else if (t4>0.0) result=min(result,t4);

        if (result >= distBound.x && result <= distBound.y) {
            vec3 pos = ro + rd * result;
            normal = normalize( 4.0*pos*pos*pos - 2.0*pos*rb*rb );
            return result;
        } else {
            return MAX_DIST;
        }
    }
}

// Rounded Box:     https://www.shadertoy.com/view/WlSXRW
float iRoundedBox(in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal,
   				  in vec3 size, in float rad ) {
	// bounding box
    vec3 m = 1.0/rd;
    vec3 n = m*ro;
    vec3 k = abs(m)*(size+rad);
    vec3 t1 = -n - k;
    vec3 t2 = -n + k;
	float tN = max( max( t1.x, t1.y ), t1.z );
	float tF = min( min( t2.x, t2.y ), t2.z );
    if (tN > tF || tF < 0.0) {
    	return MAX_DIST;
    }
    float t = (tN>=distBound.x&&tN<=distBound.y)?tN:
    		  (tF>=distBound.x&&tF<=distBound.y)?tF:MAX_DIST;

    // convert to first octant
    vec3 pos = ro+t*rd;
    vec3 s = sign(pos);
    vec3 ros = ro*s;
    vec3 rds = rd*s;
    pos *= s;
        
    // faces
    pos -= size;
    pos = max( pos.xyz, pos.yzx );
    if (min(min(pos.x,pos.y),pos.z)<0.0) {
        if (t >= distBound.x && t <= distBound.y) {
            vec3 p = ro + rd * t;
            normal = sign(p)*normalize(max(abs(p)-size,0.0));
            return t;
        }
    }
    
    // some precomputation
    vec3 oc = ros - size;
    vec3 dd = rds*rds;
	vec3 oo = oc*oc;
    vec3 od = oc*rds;
    float ra2 = rad*rad;

    t = MAX_DIST;        

    // corner
    {
    float b = od.x + od.y + od.z;
	float c = oo.x + oo.y + oo.z - ra2;
	float h = b*b - c;
	if (h > 0.0) t = -b-sqrt(h);
    }

    // edge X
    {
	float a = dd.y + dd.z;
	float b = od.y + od.z;
	float c = oo.y + oo.z - ra2;
	float h = b*b - a*c;
	if (h>0.0) {
	  h = (-b-sqrt(h))/a;
      if (h>=distBound.x && h<t && abs(ros.x+rds.x*h)<size.x ) t = h;
    }
	}
    // edge Y
    {
	float a = dd.z + dd.x;
	float b = od.z + od.x;
	float c = oo.z + oo.x - ra2;
	float h = b*b - a*c;
	if (h>0.0) {
	  h = (-b-sqrt(h))/a;
      if (h>=distBound.x && h<t && abs(ros.y+rds.y*h)<size.y) t = h;
    }
	}
    // edge Z
    {
	float a = dd.x + dd.y;
	float b = od.x + od.y;
	float c = oo.x + oo.y - ra2;
	float h = b*b - a*c;
	if (h>0.0) {
	  h = (-b-sqrt(h))/a;
      if (h>=distBound.x && h<t && abs(ros.z+rds.z*h)<size.z) t = h;
    }
	}
    
	if (t >= distBound.x && t <= distBound.y) {
        vec3 p = ro + rd * t;
        normal = sign(p)*normalize(max(abs(p)-size,1e-16));
        return t;
    } else {
        return MAX_DIST;
    };
}

// ---------------------------------------------------------------------------
// Buffer A (원본의 Buffer A 탭)
// ---------------------------------------------------------------------------
#define PATH_LENGTH 12

//
// Hash functions by Nimitz:
// https://www.shadertoy.com/view/Xt3cDn
//

uint baseHash( uvec2 p ) {
    p = 1103515245U*((p >> 1U)^(p.yx));
    uint h32 = 1103515245U*((p.x)^(p.y>>3U));
    return h32^(h32 >> 16);
}

float hash1( inout float seed ) {
    uint n = baseHash(floatBitsToUint(vec2(seed+=.1,seed+=.1)));
    return float(n)/float(0xffffffffU);
}

vec2 hash2( inout float seed ) {
    uint n = baseHash(floatBitsToUint(vec2(seed+=.1,seed+=.1)));
    uvec2 rz = uvec2(n, n*48271U);
    return vec2(rz.xy & uvec2(0x7fffffffU))/float(0x7fffffff);
}

//
// Ray tracer helper functions
//

float FresnelSchlickRoughness( float cosTheta, float F0, float roughness ) {
    return F0 + (max((1. - roughness), F0) - F0) * pow(abs(1. - cosTheta), 5.0);
}

vec3 cosWeightedRandomHemisphereDirection( const vec3 n, inout float seed ) {
  	vec2 r = hash2(seed);
	vec3  uu = normalize(cross(n, abs(n.y) > .5 ? vec3(1.,0.,0.) : vec3(0.,1.,0.)));
	vec3  vv = cross(uu, n);
	float ra = sqrt(r.y);
	float rx = ra*cos(6.28318530718*r.x); 
	float ry = ra*sin(6.28318530718*r.x);
	float rz = sqrt(1.-r.y);
	vec3  rr = vec3(rx*uu + ry*vv + rz*n);
    return normalize(rr);
}

vec3 modifyDirectionWithRoughness( const vec3 normal, const vec3 n, const float roughness, inout float seed ) {
    vec2 r = hash2(seed);
    
	vec3  uu = normalize(cross(n, abs(n.y) > .5 ? vec3(1.,0.,0.) : vec3(0.,1.,0.)));
	vec3  vv = cross(uu, n);
	
    float a = roughness*roughness;
    
	float rz = sqrt(abs((1.0-r.y) / clamp(1.+(a - 1.)*r.y,.00001,1.)));
	float ra = sqrt(abs(1.-rz*rz));
	float rx = ra*cos(6.28318530718*r.x); 
	float ry = ra*sin(6.28318530718*r.x);
	vec3  rr = vec3(rx*uu + ry*vv + rz*n);
    
    vec3 ret = normalize(rr);
    return dot(ret,normal) > 0. ? ret : n;
}

vec2 randomInUnitDisk( inout float seed ) {
    vec2 h = hash2(seed) * vec2(1,6.28318530718);
    float phi = h.y;
    float r = sqrt(h.x);
	return r*vec2(sin(phi),cos(phi));
}

//
// Scene description
//

vec3 rotateY( const in vec3 p, const in float t ) {
    float co = cos(t);
    float si = sin(t);
    vec2 xz = mat2(co,si,-si,co)*p.xz;
    return vec3(xz.x, p.y, xz.y);
}

vec3 opU( vec3 d, float iResult, float mat ) {
	return (iResult < d.y) ? vec3(d.x, iResult, mat) : d;
}

float iMesh( in vec3 ro, in vec3 rd, in vec2 distBound, inout vec3 normal) {
	const vec3 tri0 = vec3(-2./3. * 0.43301270189, 0, 0);
	const vec3 tri1 = vec3( 1./3. * 0.43301270189, 0, .25);
	const vec3 tri2 = vec3( 1./3. * 0.43301270189, 0,-.25);
	const vec3 tri3 = vec3( 0, 0.41079191812, 0);
    
    vec2 d = distBound;
	d.y = min(d.y, iTriangle(ro, rd, d, normal, tri0, tri1, tri2));   
	d.y = min(d.y, iTriangle(ro, rd, d, normal, tri0, tri3, tri1));  
	d.y = min(d.y, iTriangle(ro, rd, d, normal, tri2, tri3, tri0));   
	d.y = min(d.y, iTriangle(ro, rd, d, normal, tri1, tri3, tri2));
    
    return d.y < distBound.y ? d.y : MAX_DIST;
}
         
vec3 worldhit( in vec3 ro, in vec3 rd, in vec2 dist, out vec3 normal ) {
    vec3 tmp0, tmp1, d = vec3(dist, 0.);
    
    d = opU(d, iPlane      (ro,                  rd, d.xy, normal, vec3(0,1,0), 0.), 1.);
    d = opU(d, iBox        (ro-vec3( 1,.250, 0), rd, d.xy, normal, vec3(.25)), 2.);
    d = opU(d, iSphere     (ro-vec3( 0,.250, 0), rd, d.xy, normal, .25), 3.);
    d = opU(d, iCylinder   (ro,                  rd, d.xy, normal, vec3(2.1,.1,-2), vec3(1.9,.5,-1.9), .08 ), 4.);
    d = opU(d, iCylinder   (ro-vec3( 1,.100,-2), rd, d.xy, normal, vec3(0,0,0), vec3(0,.4,0), .1 ), 5.);
    d = opU(d, iTorus      (ro-vec3( 0,.250, 1), rd, d.xy, normal, vec2(.2,.05)), 6.);
    d = opU(d, iCapsule    (ro-vec3( 1,.000,-1), rd, d.xy, normal, vec3(-.1,.1,-.1), vec3(.2,.4,.2), .1), 7.);
    d = opU(d, iCone       (ro-vec3( 2,.200, 0), rd, d.xy, normal, vec3(.1,0,0), vec3(-.1,.3,.1), .15, .05), 8.);
    d = opU(d, iRoundedBox (ro-vec3( 0,.250,-2), rd, d.xy, normal, vec3(.15,.125,.15), .045), 9.);
    d = opU(d, iGoursat    (ro-vec3( 1,.275, 1), rd, d.xy, normal, .16, .2), 10.);
    d = opU(d, iEllipsoid  (ro-vec3(-1,.300, 0), rd, d.xy, normal, vec3(.2,.25, .05)), 11.);
    d = opU(d, iRoundedCone(ro-vec3( 2,.200,-1), rd, d.xy, normal, vec3(.1,0,0), vec3(-.1,.3,.1), 0.15, 0.05), 12.);
    d = opU(d, iRoundedCone(ro-vec3(-1,.200,-2), rd, d.xy, normal, vec3(0,.3,0), vec3(0,0,0), .1, .2), 13.);
    d = opU(d, iMesh       (ro-vec3( 2,.090, 1), rd, d.xy, normal), 14.);
    d = opU(d, iSphere4    (ro-vec3(-1,.275,-1), rd, d.xy, normal, .225), 15.);
    
    tmp1 = opU(d, iBox     (rotateY(ro-vec3(0,.25,-1), 0.78539816339), rotateY(rd, 0.78539816339), d.xy, tmp0, vec3(.1,.2,.1)), 16.);
    if (tmp1.y < d.y) {
        d = tmp1;
        normal = rotateY(tmp0, -0.78539816339);
    }
    
    return d;
}

//
// Palette by Íñigo Quílez: 
// https://www.shadertoy.com/view/ll2GD3
//
vec3 pal(in float t, in vec3 a, in vec3 b, in vec3 c, in vec3 d) {
    return a + b*cos(6.28318530718*(c*t+d));
}

float checkerBoard( vec2 p ) {
   return mod(floor(p.x) + floor(p.y), 2.);
}

vec3 getSkyColor( vec3 rd ) {
    vec3 col = mix(vec3(1),vec3(.5,.7,1), .5+.5*rd.y);
    float sun = clamp(dot(normalize(vec3(-.4,.7,-.6)),rd), 0., 1.);
    col += vec3(1,.6,.1)*(pow(sun,4.) + 10.*pow(sun,32.));
    return col;
}

#define LAMBERTIAN 0.
#define METAL 1.
#define DIELECTRIC 2.

// 원본은 fract 기반 실수 해시(gpuIndepentHash). FIELD 예제 규칙대로 정수 해시로 바꿨다
// → 물체마다 고르는 재질(난반사·금속·유리)과 거칠기가 원본과 다르다.
float gpuIndepentHash(float p) {
    return float(baseHash(floatBitsToUint(vec2(p, p * 7.31)))) / float(0xffffffffU);
}

void getMaterialProperties(in vec3 pos, in float mat, 
                           out vec3 albedo, out float type, out float roughness) {
    albedo = pal(mat*.59996323+.5, vec3(.5),vec3(.5),vec3(1),vec3(0,.1,.2));

    if( mat < 1.5 ) {            
        albedo = vec3(.25 + .25*checkerBoard(pos.xz * 5.));
        roughness = .75 * albedo.x - .15;
        type = METAL;
    } else {
        type = floor(gpuIndepentHash(mat+.3) * 3.);
        roughness = (1.-type*.475) * gpuIndepentHash(mat);
    }
}

//
// Simple ray tracer
//

float schlick(float cosine, float r0) {
    return r0 + (1.-r0)*pow((1.-cosine),5.);
}
vec3 render( in vec3 ro, in vec3 rd, inout float seed ) {
    vec3 albedo, normal, col = vec3(1.); 
    float roughness, type;
    
    for (int i=0; i<PATH_LENGTH; ++i) {    
    	vec3 res = worldhit( ro, rd, vec2(.0001, 100), normal );
		if (res.z > 0.) {
			ro += rd * res.y;
       		
            getMaterialProperties(ro, res.z, albedo, type, roughness);
            
            if (type < LAMBERTIAN+.5) { // Added/hacked a reflection term
                float F = FresnelSchlickRoughness(max(0.,-dot(normal, rd)), .04, roughness);
                if (F > hash1(seed)) {
                    rd = modifyDirectionWithRoughness(normal, reflect(rd,normal), roughness, seed);
                } else {
                    col *= albedo;
			        rd = cosWeightedRandomHemisphereDirection(normal, seed);
                }
            } else if (type < METAL+.5) {
                col *= albedo;
                rd = modifyDirectionWithRoughness(normal, reflect(rd,normal), roughness, seed);            
            } else { // DIELECTRIC
                vec3 normalOut, refracted;
                float ni_over_nt, cosine, reflectProb = 1.;
                if (dot(rd, normal) > 0.) {
                    normalOut = -normal;
            		ni_over_nt = 1.4;
                    cosine = dot(rd, normal);
                    cosine = sqrt(1.-(1.4*1.4)-(1.4*1.4)*cosine*cosine);
                } else {
                    normalOut = normal;
                    ni_over_nt = 1./1.4;
                    cosine = -dot(rd, normal);
                }
            
	            // Refract the ray.
	            refracted = refract(normalize(rd), normalOut, ni_over_nt);
    	        
        	    // Handle total internal reflection.
                if(refracted != vec3(0)) {
                	float r0 = (1.-ni_over_nt)/(1.+ni_over_nt);
	        		reflectProb = FresnelSchlickRoughness(cosine, r0*r0, roughness);
                }
                
                rd = hash1(seed) <= reflectProb ? reflect(rd,normal) : refracted;
                rd = modifyDirectionWithRoughness(-normalOut, rd, roughness, seed);            
            }
        } else {
            col *= getSkyColor(rd);
			return col;
        }
    }  
    return vec3(0);
}

mat3 setCamera( in vec3 ro, in vec3 ta, float cr ) {
	vec3 cw = normalize(ta-ro);
	vec3 cp = vec3(sin(cr), cos(cr),0.0);
	vec3 cu = normalize( cross(cw,cp) );
	vec3 cv =          ( cross(cu,cw) );
    return mat3( cu, cv, cw );
}

void main() {
    vec2 fragCoord = gl_FragCoord.xy;
    bool reset = uFrame == 0;

    // (0,0) 픽셀에 상태를 둔다: x = 초점 거리, yz = 카메라 각도(마우스, -0.5~0.5), w = 버퍼 너비.
    // Shadertoy의 마우스 값은 끌 때만 바뀌지만 FIELD의 uMouse.xy는 커서를 따라다닌다.
    // 그래서 버튼을 누르고 있을 때(uMouse.z > 0)만 각도를 바꾸고, 그 밖에는 저장한 각도를 유지한다.
    vec4 data = texelFetch(iChannel0, ivec2(0), 0);
    bool started = data.w > 0.0;
    vec2 mo = started ? data.yz : vec2(.125);
    if (uMouse.z > 0.0) mo = uMouse.xy/uResolution.xy - .5;
    // 카메라가 움직이거나 크기가 바뀌면 누적을 처음부터 다시 한다.
    if (!started || any(greaterThan(abs(mo - data.yz), vec2(1e-5))) || round(data.w) != round(uResolution.x)) {
        reset = true;
    }
    
    vec3 ro = vec3(.5+2.5*cos(1.5+6.*mo.x), 1.+2.*mo.y, -.5+2.5*sin(1.5+6.*mo.x));
    vec3 ta = vec3(.5, -.4, -.5);
    mat3 ca = setCamera(ro, ta, 0.);    
    vec3 normal;
    
    float fpd = data.x;
    if(all(equal(ivec2(fragCoord), ivec2(0)))) {
        // Calculate focus plane.
        float nfpd = worldhit(ro, normalize(vec3(.5,0,-.5)-ro), vec2(0, 100), normal).y;
		fragColor = vec4(nfpd, mo, uResolution.x);
    } else { 
        vec2 p = (-uResolution.xy + 2.*fragCoord - 1.)/uResolution.y;
        float seed = float(baseHash(floatBitsToUint(p - uTime)))/float(0xffffffffU);

        // AA
        p += 2.*hash2(seed)/uResolution.y;
        vec3 rd = ca * normalize( vec3(p.xy,1.6) );  

        // DOF
        vec3 fp = ro + rd * fpd;
        ro = ro + ca * vec3(randomInUnitDisk(seed), 0.)*.02;
        rd = normalize(fp - ro);

        vec3 col = render(ro, rd, seed);

        if (reset) {
           fragColor = vec4(col, 1);
        } else {
           fragColor = vec4(col, 1) + texelFetch(iChannel0, ivec2(fragCoord), 0);
        }
    }
}`;

const rayTracingImage = `#version 300 es
precision highp float;
// Image — iChannel0 = A (current). 누적한 합을 개수로 나눠 평균을 내고 톤 매핑한다.
// Ray Tracing - Primitives by Reinder Nijhoff, 2019 — The MIT License
// 원본: https://www.shadertoy.com/view/tl23Rm · 바꾼 점·출처·읽는 순서는 Buffer A 머리말에 있다.
// Copyright (c) 2019 Reinder Nijhoff. MIT 라이선스 전문은 docs/THIRD_PARTY_LICENSES.md에 있다.
//
// 뷰포트를 누른 채 끌면 카메라가 돈다. 놓고 기다리면 점점 깨끗해진다.
uniform vec2 uResolution;
uniform sampler2D iChannel0;
out vec4 fragColor;

void main() {
    vec4 data = texelFetch(iChannel0, ivec2(gl_FragCoord.xy), 0);
    vec3 col = data.rgb / data.w;
    
    // gamma correction
    col = max( vec3(0), col - 0.004);
    col = (col*(6.2*col + .5)) / (col*(6.2*col+1.7) + 0.06);
    
    // Output to screen
    fragColor = vec4(col,1.0);
}`;

const ocean = `#version 300 es
precision highp float;
// Very fast procedural ocean by afl_ext — License: MIT
// 원본: https://www.shadertoy.com/view/MdXyzX (xscreensaver 수록본에서 옮김: https://github.com/Zygo/xscreensaver/tree/master/hacks/glx/glsl)
// Copyright (c) 2017-2024 afl_ext. MIT 라이선스 전문은 docs/THIRD_PARTY_LICENSES.md에 있다.
//
// FIELD Studio로 옮기며 바꾼 점:
//  · Shadertoy 이름(iTime·iResolution·iMouse)은 아래 #define으로 FIELD Uniform에 연결했다. mainImage는 그대로다
//  · uSpeed(시간 배속) 파라미터를 더했다
//  · iMouse 대신 커서 위치를 쓴다: 커서를 올리면 시점이 바뀌고, 뷰포트 밖이면 원본의 기본 시점
//  · 버퍼 폭이 600px 미만이면 시점을 고정하던 원본 분기를 뺐다(해상도 비율을 낮춰도 시점 조작이 된다)
//
// 원리: 파도 높이를 exp(sin(x)-1) 파형 여러 개의 합으로 만들고(노이즈가 없어 빠르다), 그 높이장 사이를 광선으로 좁혀 들어가 수면을 찾는다.
uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uMouse;   // xy = 커서(뷰포트 밖이면 -1), zw = 누른 위치(누르는 중 양수)
uniform float uSpeed;  // 시간 배속(1 = 원본) · @range 0 3 @step 0.01 @default 1
out vec4 fragColor;

// Shadertoy 이름 → FIELD Uniform
#define iResolution vec3(uResolution, 1.0)
#define iTime (uTime * uSpeed)
#define iMouse vec4(max(uMouse.xy, vec2(0.0)), uMouse.zw)

// Title:  Very fast procedural ocean
// Author: afl_ext
// URL:    https://www.shadertoy.com/view/MdXyzX
// Date:   09-Mar-2017
// Desc:   It's fast because it doesn't use noise but rather sin waves

// afl_ext 2017-2024
// MIT License

// Use your mouse to move the camera around! Press the Left Mouse Button on the image to look around!

#define DRAG_MULT 0.38 // changes how much waves pull on the water
#define WATER_DEPTH 1.0 // how deep is the water
#define CAMERA_HEIGHT 1.5 // how high the camera should be
#define ITERATIONS_RAYMARCH 12 // waves iterations of raymarching
#define ITERATIONS_NORMAL 36 // waves iterations when calculating normals

#define NormalizedMouse (iMouse.xy / iResolution.xy) // normalize mouse coords

// Calculates wave value and its derivative, 
// for the wave direction, position in space, wave frequency and time
vec2 wavedx(vec2 position, vec2 direction, float frequency, float timeshift) {
  float x = dot(direction, position) * frequency + timeshift;
  float wave = exp(sin(x) - 1.0);
  float dx = wave * cos(x);
  return vec2(wave, -dx);
}

// Calculates waves by summing octaves of various waves with various parameters
float getwaves(vec2 position, int iterations) {
  float wavePhaseShift = length(position) * 0.1; // this is to avoid every octave having exactly the same phase everywhere
  float iter = 0.0; // this will help generating well distributed wave directions
  float frequency = 1.0; // frequency of the wave, this will change every iteration
  float timeMultiplier = 2.0; // time multiplier for the wave, this will change every iteration
  float weight = 1.0;// weight in final sum for the wave, this will change every iteration
  float sumOfValues = 0.0; // will store final sum of values
  float sumOfWeights = 0.0; // will store final sum of weights
  for(int i=0; i < iterations; i++) {
    // generate some wave direction that looks kind of random
    vec2 p = vec2(sin(iter), cos(iter));
    
    // calculate wave data
    vec2 res = wavedx(position, p, frequency, iTime * timeMultiplier + wavePhaseShift);

    // shift position around according to wave drag and derivative of the wave
    position += p * res.y * weight * DRAG_MULT;

    // add the results to sums
    sumOfValues += res.x * weight;
    sumOfWeights += weight;

    // modify next octave ;
    weight = mix(weight, 0.0, 0.2);
    frequency *= 1.18;
    timeMultiplier *= 1.07;

    // add some kind of random value to make next wave look random too
    iter += 1232.399963;
  }
  // calculate and return
  return sumOfValues / sumOfWeights;
}

// Raymarches the ray from top water layer boundary to low water layer boundary
float raymarchwater(vec3 camera, vec3 start, vec3 end, float depth) {
  vec3 pos = start;
  vec3 dir = normalize(end - start);
  for(int i=0; i < 64; i++) {
    // the height is from 0 to -depth
    float height = getwaves(pos.xz, ITERATIONS_RAYMARCH) * depth - depth;
    // if the waves height almost nearly matches the ray height, assume its a hit and return the hit distance
    if(height + 0.01 > pos.y) {
      return distance(pos, camera);
    }
    // iterate forwards according to the height mismatch
    pos += dir * (pos.y - height);
  }
  // if hit was not registered, just assume hit the top layer, 
  // this makes the raymarching faster and looks better at higher distances
  return distance(start, camera);
}

// Calculate normal at point by calculating the height at the pos and 2 additional points very close to pos
vec3 normal(vec2 pos, float e, float depth) {
  vec2 ex = vec2(e, 0);
  float H = getwaves(pos.xy, ITERATIONS_NORMAL) * depth;
  vec3 a = vec3(pos.x, H, pos.y);
  return normalize(
    cross(
      a - vec3(pos.x - e, getwaves(pos.xy - ex.xy, ITERATIONS_NORMAL) * depth, pos.y), 
      a - vec3(pos.x, getwaves(pos.xy + ex.yx, ITERATIONS_NORMAL) * depth, pos.y + e)
    )
  );
}

// Helper function generating a rotation matrix around the axis by the angle
mat3 createRotationMatrixAxisAngle(vec3 axis, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  float oc = 1.0 - c;
  return mat3(
    oc * axis.x * axis.x + c, oc * axis.x * axis.y - axis.z * s, oc * axis.z * axis.x + axis.y * s, 
    oc * axis.x * axis.y + axis.z * s, oc * axis.y * axis.y + c, oc * axis.y * axis.z - axis.x * s, 
    oc * axis.z * axis.x - axis.y * s, oc * axis.y * axis.z + axis.x * s, oc * axis.z * axis.z + c
  );
}

// Helper function that generates camera ray based on UV and mouse
vec3 getRay(vec2 fragCoord) {
  vec2 uv = ((fragCoord.xy / iResolution.xy) * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0);
  // for fisheye, uncomment following line and comment the next one
  //vec3 proj = normalize(vec3(uv.x, uv.y, 1.0) + vec3(uv.x, uv.y, -1.0) * pow(length(uv), 2.0) * 0.05);  
  vec3 proj = normalize(vec3(uv.x, uv.y, 1.5));
  // 원본은 iResolution.x < 600이면 마우스 회전 없이 proj를 돌려준다(모바일 대비).
  // FIELD에서는 해상도 비율을 낮추면 버퍼 폭이 600 아래로 내려가 시점 조작이 멈추므로 그 분기를 뺐다.
  return createRotationMatrixAxisAngle(vec3(0.0, -1.0, 0.0), 3.0 * ((NormalizedMouse.x + 0.5) * 2.0 - 1.0)) 
    * createRotationMatrixAxisAngle(vec3(1.0, 0.0, 0.0), 0.5 + 1.5 * (((NormalizedMouse.y == 0.0 ? 0.27 : NormalizedMouse.y) * 1.0) * 2.0 - 1.0))
    * proj;
}

// Ray-Plane intersection checker
float intersectPlane(vec3 origin, vec3 direction, vec3 point, vec3 normal) { 
  return clamp(dot(point - origin, normal) / dot(direction, normal), -1.0, 9991999.0); 
}

// Some very barebones but fast atmosphere approximation
vec3 extra_cheap_atmosphere(vec3 raydir, vec3 sundir) {
  //sundir.y = max(sundir.y, -0.07);
  float special_trick = 1.0 / (raydir.y * 1.0 + 0.1);
  float special_trick2 = 1.0 / (sundir.y * 11.0 + 1.0);
  float raysundt = pow(abs(dot(sundir, raydir)), 2.0);
  float sundt = pow(max(0.0, dot(sundir, raydir)), 8.0);
  float mymie = sundt * special_trick * 0.2;
  vec3 suncolor = mix(vec3(1.0), max(vec3(0.0), vec3(1.0) - vec3(5.5, 13.0, 22.4) / 22.4), special_trick2);
  vec3 bluesky= vec3(5.5, 13.0, 22.4) / 22.4 * suncolor;
  vec3 bluesky2 = max(vec3(0.0), bluesky - vec3(5.5, 13.0, 22.4) * 0.002 * (special_trick + -6.0 * sundir.y * sundir.y));
  bluesky2 *= special_trick * (0.24 + raysundt * 0.24);
  return bluesky2 * (1.0 + 1.0 * pow(1.0 - raydir.y, 3.0));
} 

// Calculate where the sun should be, it will be moving around the sky
vec3 getSunDirection() {
  return normalize(vec3(-0.0773502691896258 , 0.5 + sin(iTime * 0.2 + 2.6) * 0.45 , 0.5773502691896258));
}

// Get atmosphere color for given direction
vec3 getAtmosphere(vec3 dir) {
   return extra_cheap_atmosphere(dir, getSunDirection()) * 0.5;
}

// Get sun color for given direction
float getSun(vec3 dir) { 
  return pow(max(0.0, dot(dir, getSunDirection())), 720.0) * 210.0;
}

// Great tonemapping function from my other shader: https://www.shadertoy.com/view/XsGfWV
vec3 aces_tonemap(vec3 color) {  
  mat3 m1 = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  mat3 m2 = mat3(
    1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );
  vec3 v = m1 * color;  
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return pow(clamp(m2 * (a / b), 0.0, 1.0), vec3(1.0 / 2.2));  
}

// Main
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // get the ray
  vec3 ray = getRay(fragCoord);
  if(ray.y >= 0.0) {
    // if ray.y is positive, render the sky
    vec3 C = getAtmosphere(ray) + getSun(ray);
    fragColor = vec4(aces_tonemap(C * 2.0),1.0);   
    return;
  }

  // now ray.y must be negative, water must be hit
  // define water planes
  vec3 waterPlaneHigh = vec3(0.0, 0.0, 0.0);
  vec3 waterPlaneLow = vec3(0.0, -WATER_DEPTH, 0.0);

  // define ray origin, moving around
  vec3 origin = vec3(iTime * 0.2, CAMERA_HEIGHT, 1);

  // calculate intersections and reconstruct positions
  float highPlaneHit = intersectPlane(origin, ray, waterPlaneHigh, vec3(0.0, 1.0, 0.0));
  float lowPlaneHit = intersectPlane(origin, ray, waterPlaneLow, vec3(0.0, 1.0, 0.0));
  vec3 highHitPos = origin + ray * highPlaneHit;
  vec3 lowHitPos = origin + ray * lowPlaneHit;

  // raymatch water and reconstruct the hit pos
  float dist = raymarchwater(origin, highHitPos, lowHitPos, WATER_DEPTH);
  vec3 waterHitPos = origin + ray * dist;

  // calculate normal at the hit position
  vec3 N = normal(waterHitPos.xz, 0.01, WATER_DEPTH);

  // smooth the normal with distance to avoid disturbing high frequency noise
  N = mix(N, vec3(0.0, 1.0, 0.0), 0.8 * min(1.0, sqrt(dist*0.01) * 1.1));

  // calculate fresnel coefficient
  float fresnel = (0.04 + (1.0-0.04)*(pow(1.0 - max(0.0, dot(-N, ray)), 5.0)));

  // reflect the ray and make sure it bounces up
  vec3 R = normalize(reflect(ray, N));
  R.y = abs(R.y);
  
  // calculate the reflection and approximate subsurface scattering
  vec3 reflection = getAtmosphere(R) + getSun(R);
  vec3 scattering = vec3(0.0293, 0.0698, 0.1717) * 0.1 * (0.2 + (waterHitPos.y + WATER_DEPTH) / WATER_DEPTH);

  // return the combined result
  vec3 C = fresnel * reflection + scattering;
  fragColor = vec4(aces_tonemap(C * 2.0), 1.0);
}

// FIELD: Shadertoy의 mainImage를 부른다. 알파는 1로 둔다(투명하게 남기면 뒤 배경이 비친다).
void main() {
    mainImage(fragColor, gl_FragCoord.xy);
    fragColor.a = 1.0;
}`;
const skyline = `#version 300 es
precision highp float;
// Skyline by Otavio Good — License: CC0
// 원본: https://www.shadertoy.com/view/XtsSWs (xscreensaver 수록본에서 옮김: https://github.com/Zygo/xscreensaver/tree/master/hacks/glx/glsl)
// CC0(퍼블릭 도메인 헌정)이라 고지 의무는 없지만 출처를 남긴다.
//
// FIELD Studio로 옮기며 바꾼 점:
//  · Shadertoy 이름(iTime·iResolution·iMouse)은 아래 #define으로 FIELD Uniform에 연결했다. mainImage는 그대로다
//  · uSpeed(시간 배속) 파라미터를 더했다
//  · iMouse 대신 커서 위치를 쓴다: 커서를 올리면 시점이 바뀌고, 뷰포트 밖이면 원본의 기본 시점
//  · sin 기반 실수 해시를 정수 해시(pcg3d)로 바꿨다 → 무늬·배치가 원본과 다르다
//  · 반사에 더하던 Shadertoy 텍스처(iChannel0) 두 줄을 뺐다 — 창문·도로 반사가 원본보다 조금 밋밋하다
//
// 원리: 도시 블록을 격자로 반복하고 블록마다 해시로 건물 높이·창문·색을 고른다. 거리장으로 건물과 차를 그리고, 창문 반사와 안개를 더한다.
uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uMouse;   // xy = 커서(뷰포트 밖이면 -1), zw = 누른 위치(누르는 중 양수)
uniform float uSpeed;  // 시간 배속(1 = 원본) · @range 0 3 @step 0.01 @default 1
out vec4 fragColor;

// Shadertoy 이름 → FIELD Uniform
#define iResolution vec3(uResolution, 1.0)
#define iTime (uTime * uSpeed)
#define iMouse vec4(max(uMouse.xy, vec2(0.0)), uMouse.zw)

// Title:  Skyline
// Author: otaviogood
// URL:    https://www.shadertoy.com/view/XtsSWs
// Date:   23-Sep-2015
// Desc:   I have always wanted to make a procedural city. The architecture was limited by what I could do in real-time, but I tried to give it enough complexity that it would look realistic.

/*--------------------------------------------------------------------------------------
License CC0 - http://creativecommons.org/publicdomain/zero/1.0/
To the extent possible under law, the author(s) have dedicated all copyright and related and neighboring rights to this software to the public domain worldwide. This software is distributed without any warranty.
----------------------------------------------------------------------------------------
^ This means do ANYTHING YOU WANT with this code. Because we are programmers, not lawyers.
-Otavio Good
*/

// ---------------- Config ----------------
// This is an option that lets you render high quality frames for screenshots. It enables
// stochastic antialiasing and motion blur automatically for any shader.
//#define NON_REALTIME_HQ_RENDER
const float frameToRenderHQ = 50.0; // Time in seconds of frame to render
const float antialiasingSamples = 16.0; // 16x antialiasing - too much might make the shader compiler angry.

//#define MANUAL_CAMERA


// --------------------------------------------------------
// These variables are for the non-realtime block renderer.
float localTime = 0.0;
float seed = 1.0;

// Animation variables
float fade = 1.0;
vec3 sunDir;
vec3 sunCol;
float exposure = 1.0;
vec3 skyCol, horizonCol;

// other
float marchCount = 0.0;

// ---- noise functions ----
float v31(vec3 a)
{
    return a.x + a.y * 37.0 + a.z * 521.0;
}
float v21(vec2 a)
{
    return a.x + a.y * 37.0;
}
// FIELD: 원본의 sin·cos 기반 실수 해시를 정수 해시(pcg3d)로 바꿨다. 함수 이름과 쓰임은 그대로다.
uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
float pcgFloat(uint v) { return float(v >> 8u) * (1.0 / 16777216.0); }
float Hash11(float a) { return pcgFloat(pcg3d(uvec3(floatBitsToUint(a), 0u, 0u)).x); }
float Hash21(vec2 uv) { return pcgFloat(pcg3d(uvec3(floatBitsToUint(uv), 0u)).x); }
vec2 Hash22(vec2 uv) { uvec3 h = pcg3d(uvec3(floatBitsToUint(uv), 1u)); return vec2(pcgFloat(h.x), pcgFloat(h.y)); }
vec2 Hash12(float f) { uvec3 h = pcg3d(uvec3(floatBitsToUint(f), 1u, 0u)); return vec2(pcgFloat(h.x), pcgFloat(h.y)); }
float Hash1d(float u) { return Hash11(u); }
float Hash2d(vec2 uv) { return Hash21(uv); }
float Hash3d(vec3 uv) { return pcgFloat(pcg3d(floatBitsToUint(uv)).x); }
float mixP(float f0, float f1, float a)
{
    return mix(f0, f1, a*a*(3.0-2.0*a));
}
const vec2 zeroOne = vec2(0.0, 1.0);
float noise2d(vec2 uv)
{
    vec2 fr = fract(uv.xy);
    vec2 fl = floor(uv.xy);
    float h00 = Hash2d(fl);
    float h10 = Hash2d(fl + zeroOne.yx);
    float h01 = Hash2d(fl + zeroOne);
    float h11 = Hash2d(fl + zeroOne.yy);
    return mixP(mixP(h00, h10, fr.x), mixP(h01, h11, fr.x), fr.y);
}
float noise(vec3 uv)
{
    vec3 fr = fract(uv.xyz);
    vec3 fl = floor(uv.xyz);
    float h000 = Hash3d(fl);
    float h100 = Hash3d(fl + zeroOne.yxx);
    float h010 = Hash3d(fl + zeroOne.xyx);
    float h110 = Hash3d(fl + zeroOne.yyx);
    float h001 = Hash3d(fl + zeroOne.xxy);
    float h101 = Hash3d(fl + zeroOne.yxy);
    float h011 = Hash3d(fl + zeroOne.xyy);
    float h111 = Hash3d(fl + zeroOne.yyy);
    return mixP(
        mixP(mixP(h000, h100, fr.x),
             mixP(h010, h110, fr.x), fr.y),
        mixP(mixP(h001, h101, fr.x),
             mixP(h011, h111, fr.x), fr.y)
        , fr.z);
}

const float PI=3.14159265;

vec3 saturate(vec3 a) { return clamp(a, 0.0, 1.0); }
vec2 saturate(vec2 a) { return clamp(a, 0.0, 1.0); }
float saturate(float a) { return clamp(a, 0.0, 1.0); }

// This function basically is a procedural environment map that makes the sun
vec3 GetSunColorSmall(vec3 rayDir, vec3 sunDir)
{
	vec3 localRay = normalize(rayDir);
	float dist = 1.0 - (dot(localRay, sunDir) * 0.5 + 0.5);
	float sunIntensity = 0.05 / dist;
    sunIntensity += exp(-dist*150.0)*7000.0;
	sunIntensity = min(sunIntensity, 40000.0);
	return sunCol * sunIntensity*0.025;
}

vec3 GetEnvMap(vec3 rayDir, vec3 sunDir)
{
    // fade the sky color, multiply sunset dimming
    vec3 finalColor = mix(horizonCol, skyCol, pow(saturate(rayDir.y), 0.47))*0.95;
    // make clouds - just a horizontal plane with noise
    float n = noise2d(rayDir.xz/rayDir.y*1.0);
    n += noise2d(rayDir.xz/rayDir.y*2.0)*0.5;
    n += noise2d(rayDir.xz/rayDir.y*4.0)*0.25;
    n += noise2d(rayDir.xz/rayDir.y*8.0)*0.125;
    n = pow(abs(n), 3.0);
    n = mix(n * 0.2, n, saturate(abs(rayDir.y * 8.0)));  // fade clouds in distance
    finalColor = mix(finalColor, (vec3(1.0)+sunCol*10.0)*0.75*saturate((rayDir.y+0.2)*5.0), saturate(n*0.125));

    // add the sun
    finalColor += GetSunColorSmall(rayDir, sunDir);
    return finalColor;
}

vec3 GetEnvMapSkyline(vec3 rayDir, vec3 sunDir, float height)
{
    vec3 finalColor = GetEnvMap(rayDir, sunDir);

    // Make a skyscraper skyline reflection.
    float radial = atan(rayDir.z, rayDir.x)*4.0;
    float skyline = floor((sin(5.3456*radial) + sin(1.234*radial)+ sin(2.177*radial))*0.6);
    radial *= 4.0;
    skyline += floor((sin(5.0*radial) + sin(1.234*radial)+ sin(2.177*radial))*0.6)*0.1;
    float mask = saturate((rayDir.y*8.0 - skyline-2.5+height)*24.0);
    float vert = sign(sin(radial*32.0))*0.5+0.5;
    float hor = sign(sin(rayDir.y*256.0))*0.5+0.5;
    mask = saturate(mask + (1.0-hor*vert)*0.05);
    finalColor = mix(finalColor * vec3(0.1,0.07,0.05), finalColor, mask);

	return finalColor;
}

// min function that supports materials in the y component
vec2 matmin(vec2 a, vec2 b)
{
    if (a.x < b.x) return a;
    else return b;
}

// ---- shapes defined by distance fields ----
// See this site for a reference to more distance functions...
// https://iquilezles.org/articles/distfunctions

// signed box distance field
float sdBox(vec3 p, vec3 radius)
{
  vec3 dist = abs(p) - radius;
  return min(max(dist.x, max(dist.y, dist.z)), 0.0) + length(max(dist, 0.0));
}

// capped cylinder distance field
float cylCap(vec3 p, float r, float lenRad)
{
    float a = length(p.xy) - r;
    a = max(a, abs(p.z) - lenRad);
    return a;
}

// k should be negative. -4.0 works nicely.
// smooth blending function
float smin(float a, float b, float k)
{
	return log2(exp2(k*a)+exp2(k*b))/k;
}

float Repeat(float a, float len)
{
    return mod(a, len) - 0.5 * len;
}

// Distance function that defines the car.
// Basically it's 2 boxes smooth-blended together and a mirrored cylinder for the wheels.
vec2 Car(vec3 baseCenter, float unique)
{
    // bottom box
    float car = sdBox(baseCenter + vec3(0.0, -0.008, 0.001), vec3(0.01, 0.00225, 0.0275));
    // top box smooth blended
    car = smin(car, sdBox(baseCenter + vec3(0.0, -0.016, 0.008), vec3(0.005, 0.0005, 0.01)), -160.0);
    // mirror the z axis to duplicate the cylinders for wheels
    vec3 wMirror = baseCenter + vec3(0.0, -0.005, 0.0);
    wMirror.z = abs(wMirror.z)-0.02;
    float wheels = cylCap((wMirror).zyx, 0.004, 0.0135);
    // Set materials
    vec2 distAndMat = vec2(wheels, 3.0);	// car wheels
    // Car material is some big number that's unique to each car
    // so I can have each car be a different color
    distAndMat = matmin(distAndMat, vec2(car, 100000.0 + unique));	// car
    return distAndMat;
}

// How much space between voxel borders and geometry for voxel ray march optimization
float voxelPad = 0.2;
// p should be in [0..1] range on xz plane
// pint is an integer pair saying which city block you are on
vec2 CityBlock(vec3 p, vec2 pint)
{
    // Get random numbers for this block by hashing the city block variable
    vec4 rand;
    rand.xy = Hash22(pint);
    rand.zw = Hash22(rand.xy);
    vec2 rand2 = Hash22(rand.zw);

    // Radius of the building
    float baseRad = 0.2 + (rand.x) * 0.1;
    baseRad = floor(baseRad * 20.0+0.5)/20.0;	// try to snap this for window texture

    // make position relative to the middle of the block
    vec3 baseCenter = p - vec3(0.5, 0.0, 0.5);
    float height = rand.w*rand.z + 0.1; // height of first building block
    // Make the city skyline higher in the middle of the city.
    float downtown = saturate(4.0 / length(pint.xy));
    height *= downtown;
    height *= 1.5+(baseRad-0.15)*20.0;
    height += 0.1;	// minimum building height
    //height += sin(iTime + pint.x);	// animate the building heights if you're feeling silly
    height = floor(height*20.0)*0.05;	// height is in floor units - each floor is 0.05 high.
	float d = sdBox(baseCenter, vec3(baseRad, height, baseRad)); // large building piece

    // road
    d = min(d, p.y);

    //if (length(pint.xy) > 8.0) return vec2(d, mat);	// Hack to LOD in the distance

    // height of second building section
    float height2 = max(0.0, rand.y * 2.0 - 1.0) * downtown;
    height2 = floor(height2*20.0)*0.05;	// floor units
    rand2 = floor(rand2*20.0)*0.05;	// floor units
    // size pieces of building
	d = min(d, sdBox(baseCenter - vec3(0.0, height, 0.0), vec3(baseRad, height2 - rand2.y, baseRad*0.4)));
	d = min(d, sdBox(baseCenter - vec3(0.0, height, 0.0), vec3(baseRad*0.4, height2 - rand2.x, baseRad)));
    // second building section
    if (rand2.y > 0.25)
    {
		d = min(d, sdBox(baseCenter - vec3(0.0, height, 0.0), vec3(baseRad*0.8, height2, baseRad*0.8)));
        // subtract off piece from top so it looks like there's a wall around the roof.
        float topWidth = baseRad;
        if (height2 > 0.0) topWidth = baseRad * 0.8;
		d = max(d, -sdBox(baseCenter - vec3(0.0, height+height2, 0.0), vec3(topWidth-0.0125, 0.015, topWidth-0.0125)));
    }
    else
    {
        // Cylinder top section of building
		if (height2 > 0.0) d = min(d, cylCap((baseCenter - vec3(0.0, height, 0.0)).xzy, baseRad*0.8, height2));
    }
    // mini elevator shaft boxes on top of building
	d = min(d, sdBox(baseCenter - vec3((rand.x-0.5)*baseRad, height+height2, (rand.y-0.5)*baseRad),
                     vec3(baseRad*0.3*rand.z, 0.1*rand2.y, baseRad*0.3*rand2.x+0.025)));
    // mirror another box (and scale it) so we get 2 boxes for the price of 1.
    vec3 boxPos = baseCenter - vec3((rand2.x-0.5)*baseRad, height+height2, (rand2.y-0.5)*baseRad);
    float big = sign(boxPos.x);
    boxPos.x = abs(boxPos.x)-0.02 - baseRad*0.3*rand.w;
	d = min(d, sdBox(boxPos,
    vec3(baseRad*0.3*rand.w, 0.07*rand.y, baseRad*0.2*rand.x + big*0.025)));

    // Put domes on some building tops for variety
    if (rand.y < 0.04)
    {
        d = min(d, length(baseCenter - vec3(0.0, height, 0.0)) - baseRad*0.8);
    }

    //d = max(d, p.y);  // flatten the city for debugging cars

    // Need to make a material variable.
    vec2 distAndMat = vec2(d, 0.0);
    // sidewalk box with material
    distAndMat = matmin(distAndMat, vec2(sdBox(baseCenter, vec3(0.35, 0.005, 0.35)), 1.0));

    return distAndMat;
}

// This is the distance function that defines all the scene's geometry.
// The input is a position in space.
// The output is the distance to the nearest surface and a material index.
vec2 DistanceToObject(vec3 p)
{
    //p.y += noise2d((p.xz)*0.0625)*8.0; // Hills
    vec3 rep = p;
    rep.xz = fract(p.xz); // [0..1] for representing the position in the city block
    vec2 distAndMat = CityBlock(rep, floor(p.xz));

    // Set up the cars. This is doing a lot of mirroring and repeating because I
    // only want to do a single call to the car distance function for all the
    // cars in the scene. And there's a lot of traffic!
    vec3 p2 = p;
    rep.xyz = p2;
    float carTime = localTime*0.2;  // Speed of car driving
    float crossStreet = 1.0;  // whether we are north/south or east/west
    float repeatDist = 0.25;  // Car density bumper to bumper
    // If we are going north/south instead of east/west (?) make cars that are
    // stopped in the street so we don't have collisions.
    if (abs(fract(rep.x)-0.5) < 0.35)
    {
        p2.x += 0.05;
        p2.xz = p2.zx * vec2(-1.0,1.0);  // Rotate 90 degrees
        rep.xz = p2.xz;
        crossStreet = 0.0;
        repeatDist = 0.1;  // Denser traffic on cross streets
    }
    
    rep.z += floor(p2.x);	// shift so less repitition between parallel blocks
    rep.x = Repeat(p2.x - 0.5, 1.0);	// repeat every block
    rep.z = rep.z*sign(rep.x);	// mirror but keep cars facing the right way
    rep.x = (rep.x*sign(rep.x))-0.09;
    rep.z -= carTime * crossStreet;	// make cars move
    float uniqueID = floor(rep.z/repeatDist);	// each car gets a unique ID that we can use for colors
    rep.z = Repeat(rep.z, repeatDist);	// repeat the line of cars every quarter block
    rep.x += (Hash11(uniqueID)*0.075-0.01);	// nudge cars left and right to take both lanes
    float frontBack = Hash11(uniqueID*0.987)*0.18-0.09;
    frontBack *= sin(localTime*2.0 + uniqueID);
    rep.z += frontBack * crossStreet; // nudge cars forward back for variation
    vec2 carDist = Car(rep, uniqueID); // car distance function

    // Drop the cars in the scene with materials
    distAndMat = matmin(distAndMat, carDist);

    return distAndMat;
}

// This basically makes a procedural texture map for the sides of the buildings.
// It makes a texture, a normal for normal mapping, and a mask for window reflection.
void CalcWindows(vec2 block, vec3 pos, inout vec3 texColor, inout float windowRef, inout vec3 normal)
{
    vec3 hue = vec3(Hash21(block)*0.8, Hash21(block*7.89)*0.4, Hash21(block*37.89)*0.5);
    texColor += hue*0.4;
    texColor *= 0.75;
    float window = 0.0;
    window = max(window, mix(0.2, 1.0, floor(fract(pos.y*20.0-0.35)*2.0+0.1)));
    if (pos.y < 0.05) window = 1.0;
    float winWidth = Hash21(block*4.321)*2.0;
    if ((winWidth < 1.3) && (winWidth >= 1.0)) winWidth = 1.3;
    window = max(window, mix(0.2, 1.0, floor(fract(pos.x * 40.0+0.05)*winWidth)));
    window = max(window, mix(0.2, 1.0, floor(fract(pos.z * 40.0+0.05)*winWidth)));
    if (window < 0.5)
    {
        windowRef += 1.0;
    }
    window *= Hash21(block*1.123);
    texColor *= window;

    float wave = floor(sin((pos.y*40.0-0.1)*PI)*0.505-0.5)+1.0;
    normal.y -= max(-1.0, min(1.0, -wave*0.5));
    float pits = min(1.0, abs(sin((pos.z*80.0)*PI))*4.0)-1.0;
    normal.z += pits*0.25;
    pits = min(1.0, abs(sin((pos.x*80.0)*PI))*4.0)-1.0;
    normal.x += pits*0.25;
}

// Input is UV coordinate of pixel to render.
// Output is RGB color.
vec3 RayTrace(in vec2 fragCoord )
{
    marchCount = 0.0;
	// -------------------------------- animate ---------------------------------------
    sunCol = vec3(258.0, 248.0, 200.0) / 3555.0;
	sunDir = normalize(vec3(0.93, 1.0, 1.0));
    horizonCol = vec3(1.0, 0.95, 0.85)*0.9;
    skyCol = vec3(0.3,0.5,0.95);
    exposure = 1.0;
    fade = 1.0;

	vec3 camPos, camUp, camLookat;
	// ------------------- Set up the camera rays for ray marching --------------------
    // Map uv to [-1.0..1.0]
	vec2 uv = fragCoord.xy/iResolution.xy * 2.0 - 1.0;
    uv /= 2.0;  // zoom in

#ifdef MANUAL_CAMERA
    // Camera up vector.
	camUp=vec3(0,1,0);

	// Camera lookat.
	camLookat=vec3(0,0.0,0);

    // debugging camera
    float mx=-iMouse.x/iResolution.x*PI*2.0;// + localTime * 0.05;
	float my=iMouse.y/iResolution.y*3.14*0.5 + PI/2.0;// + sin(localTime * 0.3)*0.8+0.1;//*PI/2.01;
	camPos = vec3(cos(my)*cos(mx),sin(my),cos(my)*sin(mx))*7.35;//7.35
#else
    // Do the camera fly-by animation and different scenes.
    // Time variables for start and end of each scene
    const float t0 = 0.0;
    const float t1 = 8.0;
    const float t2 = 14.0;
    const float t3 = 24.0;
    const float t4 = 38.0;
    const float t5 = 56.0;
    const float t6 = 58.0;
    /*const float t0 = 0.0;
    const float t1 = 0.0;
    const float t2 = 0.0;
    const float t3 = 0.0;
    const float t4 = 0.0;
    const float t5 = 16.0;
    const float t6 = 18.0;*/
    // Repeat the animation after time t6
    localTime = fract(localTime / t6) * t6;
    if (localTime < t1)
    {
        float time = localTime - t0;
        float alpha = time / (t1 - t0);
        fade = saturate(time);
        fade *= saturate(t1 - localTime);
        camPos = vec3(13.0, 3.3, -3.5);
        camPos.x -= smoothstep(0.0, 1.0, alpha) * 4.8;
        camUp=vec3(0,1,0);
        camLookat=vec3(0,1.5,1.5);
    } else if (localTime < t2)
    {
        float time = localTime - t1;
        float alpha = time / (t2 - t1);
        fade = saturate(time);
        fade *= saturate(t2 - localTime);
        camPos = vec3(26.0, 0.05+smoothstep(0.0, 1.0, alpha)*0.4, 2.0);
        camPos.z -= alpha * 2.8;
        camUp=vec3(0,1,0);
        camLookat=vec3(camPos.x-0.3,-8.15,-40.0);
        
        sunDir = normalize(vec3(0.95, 0.6, 1.0));
        sunCol = vec3(258.0, 248.0, 160.0) / 3555.0;
        exposure *= 0.7;
        skyCol *= 1.5;
    } else if (localTime < t3)
    {
        float time = localTime - t2;
        float alpha = time / (t3 - t2);
        fade = saturate(time);
        fade *= saturate(t3 - localTime);
        camPos = vec3(12.0, 6.3, -0.5);
        camPos.y -= alpha * 5.5;
        camPos.x = cos(alpha*1.0) * 5.2;
        camPos.z = sin(alpha*1.0) * 5.2;
        camUp=normalize(vec3(0,1,-0.5 + alpha * 0.5));
        camLookat=vec3(0,1.0,-0.5);
    } else if (localTime < t4)
    {
        float time = localTime - t3;
        float alpha = time / (t4 - t3);
        fade = saturate(time);
        fade *= saturate(t4 - localTime);
        camPos = vec3(2.15-alpha*0.5, 0.02, -1.0-alpha*0.2);
        camPos.y += smoothstep(0.0,1.0,alpha*alpha) * 3.4;
        camUp=normalize(vec3(0,1,0.0));
        camLookat=vec3(0,0.5+alpha,alpha*5.0);
    } else if (localTime < t5)
    {
        float time = localTime - t4;
        float alpha = time / (t5 - t4);
        fade = saturate(time);
        fade *= saturate(t5 - localTime);
        camPos = vec3(-2.0, 1.3- alpha*1.2, -10.5-alpha*0.5);
        camUp=normalize(vec3(0,1,0.0));
        camLookat=vec3(-2.0,0.3+alpha,-0.0);
        sunDir = normalize(vec3(0.5-alpha*0.6, 0.3-alpha*0.3, 1.0));
        sunCol = vec3(258.0, 148.0, 60.0) / 3555.0;
        localTime *= 16.0;
        exposure *= 0.4;
        horizonCol = vec3(1.0, 0.5, 0.35)*2.0;
        skyCol = vec3(0.75,0.5,0.95);

    } else if (localTime < t6)
    {
        fade = 0.0;
        camPos = vec3(26.0, 100.0, 2.0);
        camUp=vec3(0,1,0);
        camLookat=vec3(0.3,0.15,0.0);
    }
#endif

	// Camera setup for ray tracing / marching
	vec3 camVec=normalize(camLookat - camPos);
	vec3 sideNorm=normalize(cross(camUp, camVec));
	vec3 upNorm=cross(camVec, sideNorm);
	vec3 worldFacing=(camPos + camVec);
	vec3 worldPix = worldFacing + uv.x * sideNorm * (iResolution.x/iResolution.y) + uv.y * upNorm;
	vec3 rayVec = normalize(worldPix - camPos);

	// ----------------------------- Ray march the scene ------------------------------
	vec2 distAndMat;  // Distance and material
	float t = 0.05;// + Hash2d(uv)*0.1;	// random dither-fade things close to the camera
	const float maxDepth = 45.0; // farthest distance rays will travel
	vec3 pos = vec3(0.0);
    const float smallVal = 0.000625;
	// ray marching time
    for (int i = 0; i < 250; i++)	// This is the count of the max times the ray actually marches.
    {
        marchCount+=1.0;
        // Step along the ray.
        pos = (camPos + rayVec * t);
        // This is _the_ function that defines the "distance field".
        // It's really what makes the scene geometry. The idea is that the
        // distance field returns the distance to the closest object, and then
        // we know we are safe to "march" along the ray by that much distance
        // without hitting anything. We repeat this until we get really close
        // and then break because we have effectively hit the object.
        distAndMat = DistanceToObject(pos);

        // 2d voxel walk through the city blocks.
        // The distance function is not continuous at city block boundaries,
        // so we have to pause our ray march at each voxel boundary.
        float walk = distAndMat.x;
        float dx = -fract(pos.x);
        if (rayVec.x > 0.0) dx = fract(-pos.x);
        float dz = -fract(pos.z);
        if (rayVec.z > 0.0) dz = fract(-pos.z);
        float nearestVoxel = min(fract(dx/rayVec.x), fract(dz/rayVec.z))+voxelPad;
        nearestVoxel = max(voxelPad, nearestVoxel);// hack that assumes streets and sidewalks are this wide.
        //nearestVoxel = max(nearestVoxel, t * 0.02); // hack to stop voxel walking in the distance.
        walk = min(walk, nearestVoxel);

        // move down the ray a safe amount
        t += walk;
        // If we are very close to the object, let's call it a hit and exit this loop.
        if ((t > maxDepth) || (abs(distAndMat.x) < smallVal)) break;
    }

    // Ray trace a ground plane to infinity
    float alpha = -camPos.y / rayVec.y;
    if ((t > maxDepth) && (rayVec.y < -0.0))
    {
        pos.xz = camPos.xz + rayVec.xz * alpha;
        pos.y = -0.0;
        t = alpha;
        distAndMat.y = 0.0;
        distAndMat.x = 0.0;
    }
	// --------------------------------------------------------------------------------
	// Now that we have done our ray marching, let's put some color on this geometry.
	vec3 finalColor = vec3(0.0);

	// If a ray actually hit the object, let's light it.
    if ((t <= maxDepth) || (t == alpha))
	{
        float dist = distAndMat.x;
        // calculate the normal from the distance field. The distance field is a volume, so if you
        // sample the current point and neighboring points, you can use the difference to get
        // the normal.
        vec3 smallVec = vec3(smallVal, 0, 0);
        vec3 normalU = vec3(dist - DistanceToObject(pos - smallVec.xyy).x,
                           dist - DistanceToObject(pos - smallVec.yxy).x,
                           dist - DistanceToObject(pos - smallVec.yyx).x);
        vec3 normal = normalize(normalU);

        // calculate 2 ambient occlusion values. One for global stuff and one
        // for local stuff
        float ambientS = 1.0;
        ambientS *= saturate(DistanceToObject(pos + normal * 0.0125).x*80.0);
        ambientS *= saturate(DistanceToObject(pos + normal * 0.025).x*40.0);
        ambientS *= saturate(DistanceToObject(pos + normal * 0.05).x*20.0);
        ambientS *= saturate(DistanceToObject(pos + normal * 0.1).x*10.0);
        ambientS *= saturate(DistanceToObject(pos + normal * 0.2).x*5.0);
        ambientS *= saturate(DistanceToObject(pos + normal * 0.4).x*2.5);
        //ambientS *= saturate(DistanceToObject(pos + normal * 0.8).x*1.25);
        float ambient = ambientS;// * saturate(DistanceToObject(pos + normal * 1.6).x*1.25*0.5);
        //ambient *= saturate(DistanceToObject(pos + normal * 3.2)*1.25*0.25);
        //ambient *= saturate(DistanceToObject(pos + normal * 6.4)*1.25*0.125);
        ambient = max(0.025, pow(ambient, 0.5));	// tone down ambient with a pow and min clamp it.
        ambient = saturate(ambient);

        // calculate the reflection vector for highlights
        vec3 ref = reflect(rayVec, normal);

        // Trace a ray toward the sun for sun shadows
        float sunShadow = 1.0;
        float iter = 0.01;
        vec3 nudgePos = pos + normal*0.002;	// don't start tracing too close or inside the object
		for (int i = 0; i < 40; i++)
        {
            vec3 shadowPos = nudgePos + sunDir * iter;
            float tempDist = DistanceToObject(shadowPos).x;
	        sunShadow *= saturate(tempDist*150.0);	// Shadow hardness
            if (tempDist <= 0.0) break;

            float walk = tempDist;
            float dx = -fract(shadowPos.x);
            if (sunDir.x > 0.0) dx = fract(-shadowPos.x);
            float dz = -fract(shadowPos.z);
            if (sunDir.z > 0.0) dz = fract(-shadowPos.z);
            float nearestVoxel = min(fract(dx/sunDir.x), fract(dz/sunDir.z))+smallVal;
            nearestVoxel = max(0.2, nearestVoxel);// hack that assumes streets and sidewalks are this wide.
            walk = min(walk, nearestVoxel);

            iter += max(0.01, walk);
            if (iter > 4.5) break;
        }
        sunShadow = saturate(sunShadow);

        // make a few frequencies of noise to give it some texture
        float n =0.0;
        n += noise(pos*32.0);
        n += noise(pos*64.0);
        n += noise(pos*128.0);
        n += noise(pos*256.0);
        n += noise(pos*512.0);
        n = mix(0.7, 0.95, n);

        // ------ Calculate texture color  ------
        vec2 block = floor(pos.xz);
        vec3 texColor = vec3(0.95, 1.0, 1.0);
        texColor *= 0.8;
        float windowRef = 0.0;
        // texture map the sides of buildings
        if ((normal.y < 0.1) && (distAndMat.y == 0.0))
        {
            vec3 posdx = dFdx(pos);
            vec3 posdy = dFdy(pos);
            vec3 posGrad = posdx * Hash21(uv) + posdy * Hash21(uv*7.6543);

            // Quincunx antialias the building texture and normal map.
            // I guess procedural textures are hard to mipmap.
            vec3 colTotal = vec3(0.0);
            vec3 colTemp = texColor;
            vec3 nTemp = vec3(0.0);
            CalcWindows(block, pos, colTemp, windowRef, nTemp);
            colTotal = colTemp;

            colTemp = texColor;
            CalcWindows(block, pos + posdx * 0.666, colTemp, windowRef, nTemp);
            colTotal += colTemp;

            colTemp = texColor;
            CalcWindows(block, pos + posdx * 0.666 + posdy * 0.666, colTemp, windowRef, nTemp);
            colTotal += colTemp;

            colTemp = texColor;
            CalcWindows(block, pos + posdy * 0.666, colTemp, windowRef, nTemp);
            colTotal += colTemp;

            colTemp = texColor;
            CalcWindows(block, pos + posdx * 0.333 + posdy * 0.333, colTemp, windowRef, nTemp);
            colTotal += colTemp;

            texColor = colTotal * 0.2;
            windowRef *= 0.2;

            normal = normalize(normal + nTemp * 0.2);
        }
        else
        {
            // Draw the road
            float xroad = abs(fract(pos.x+0.5)-0.5);
            float zroad = abs(fract(pos.z+0.5)-0.5);
            float road = saturate((min(xroad, zroad)-0.143)*480.0);
            texColor *= 1.0-normal.y*0.95*Hash21(block*9.87)*road; // change rooftop color
            texColor *= mix(0.1, 1.0, road);

            // double yellow line in middle of road
            float yellowLine = saturate(1.0-(min(xroad, zroad)-0.002)*480.0);
            yellowLine *= saturate((min(xroad, zroad)-0.0005)*480.0);
            yellowLine *= saturate((xroad*xroad+zroad*zroad-0.05)*880.0);
            texColor = mix(texColor, vec3(1.0, 0.8, 0.3), yellowLine);

            // white dashed lines on road
            float whiteLine = saturate(1.0-(min(xroad, zroad)-0.06)*480.0);
            whiteLine *= saturate((min(xroad, zroad)-0.056)*480.0);
            whiteLine *= saturate((xroad*xroad+zroad*zroad-0.05)*880.0);
            whiteLine *= saturate(1.0-(fract(zroad*8.0)-0.5)*280.0);  // dotted line
            whiteLine *= saturate(1.0-(fract(xroad*8.0)-0.5)*280.0);
            texColor = mix(texColor, vec3(0.5), whiteLine);

            whiteLine = saturate(1.0-(min(xroad, zroad)-0.11)*480.0);
            whiteLine *= saturate((min(xroad, zroad)-0.106)*480.0);
            whiteLine *= saturate((xroad*xroad+zroad*zroad-0.06)*880.0);
            texColor = mix(texColor, vec3(0.5), whiteLine);

            // crosswalk
            float crossWalk = saturate(1.0-(fract(xroad*40.0)-0.5)*280.0);
            crossWalk *= saturate((zroad-0.15)*880.0);
            crossWalk *= saturate((-zroad+0.21)*880.0)*(1.0-road);
            crossWalk *= n*n;
            texColor = mix(texColor, vec3(0.25), crossWalk);
            crossWalk = saturate(1.0-(fract(zroad*40.0)-0.5)*280.0);
            crossWalk *= saturate((xroad-0.15)*880.0);
            crossWalk *= saturate((-xroad+0.21)*880.0)*(1.0-road);
            crossWalk *= n*n;
            texColor = mix(texColor, vec3(0.25), crossWalk);

            {
                // sidewalk cracks
                float sidewalk = 1.0;
                vec2 blockSize = vec2(100.0);
                if (pos.y > 0.1) blockSize = vec2(10.0, 50);
                //sidewalk *= pow(abs(sin(pos.x*blockSize)), 0.025);
                //sidewalk *= pow(abs(sin(pos.z*blockSize)), 0.025);
                sidewalk *= saturate(abs(sin(pos.z*blockSize.x)*800.0/blockSize.x));
                sidewalk *= saturate(abs(sin(pos.x*blockSize.y)*800.0/blockSize.y));
                sidewalk = saturate(mix(0.7, 1.0, sidewalk));
                sidewalk = saturate((1.0-road) + sidewalk);
                texColor *= sidewalk;
            }
        }
        // Car tires are almost black to not call attention to their ugly.
        if (distAndMat.y == 3.0)
        {
            texColor = vec3(0.05);
        }

        // apply noise
        texColor *= vec3(1.0)*n*0.05;
        texColor *= 0.7;
        texColor = saturate(texColor);

        float windowMask = 0.0;
        if (distAndMat.y >= 100.0)
        {
            // car texture and windows
            texColor = vec3(Hash11(distAndMat.y)*1.0, Hash11(distAndMat.y*8.765), Hash11(distAndMat.y*17.731))*0.1;
            texColor = pow(abs(texColor), vec3(0.2));  // bias toward white
            texColor = max(vec3(0.25), texColor);  // not too saturated color.
            texColor.z = min(texColor.y, texColor.z);  // no purple cars. just not realistic. :)
            texColor *= Hash11(distAndMat.y*0.789) * 0.15;
            windowMask = saturate( max(0.0, abs(pos.y - 0.0175)*3800.0)-10.0);
            vec2 dirNorm = abs(normalize(normal.xz));
            float pillars = saturate(1.0-max(dirNorm.x, dirNorm.y));
            pillars = pow(max(0.0, pillars-0.15), 0.125);
            windowMask = max(windowMask, pillars);
            texColor *= windowMask;
        }

        // ------ Calculate lighting color ------
        // Start with sun color, standard lighting equation, and shadow
        vec3 lightColor = vec3(100.0)*sunCol * saturate(dot(sunDir, normal)) * sunShadow;
        // weighted average the near ambient occlusion with the far for just the right look
        float ambientAvg = (ambient*3.0 + ambientS) * 0.25;
        // Add sky color with ambient acclusion
        lightColor += (skyCol * saturate(normal.y *0.5+0.5))*pow(ambientAvg, 0.35)*2.5;
        lightColor *= 4.0;

        // finally, apply the light to the texture.
        finalColor = texColor * lightColor;
        // Reflections for cars
        if (distAndMat.y >= 100.0)
        {
            float yfade = max(0.01, min(1.0, ref.y*100.0));
            // low-res way of making lines at the edges of car windows. Not sure I like it.
            yfade *= (saturate(1.0-abs(dFdx(windowMask)*dFdy(windowMask))*250.995));
            finalColor += GetEnvMapSkyline(ref, sunDir, pos.y-1.5)*0.3*yfade*max(0.4,sunShadow);
// jwz: GLSL 4.10, GLES 3.0: "No matching function for call to texture(sampler2D, vec3)"
//     This must just be an error; dunno why it works on the shadertoy web site.
//          finalColor += saturate(texture(iChannel0, ref).xyz-0.35)*0.15*max(0.2,sunShadow);
            // FIELD: 원본은 여기서 Shadertoy 텍스처(iChannel0)를 반사에 더했다. 텍스처 없이 쓰도록 뺐다.
        }
        // reflections for building windows
        if (windowRef != 0.0)
        {
            finalColor *= mix(1.0, 0.6, windowRef);
            float yfade = max(0.01, min(1.0, ref.y*100.0));
            finalColor += GetEnvMapSkyline(ref, sunDir, pos.y-0.5)*0.6*yfade*max(0.6,sunShadow)*windowRef;//*(windowMask*0.5+0.5);
// jwz: GLSL 4.10, GLES 3.0: "No matching function for call to texture(sampler2D, vec3)"
//          finalColor += saturate(texture(iChannel0, ref).xyz-0.35)*0.15*max(0.25,sunShadow)*windowRef;
            // FIELD: 원본은 여기서 Shadertoy 텍스처(iChannel0)를 창문 반사에 더했다. 텍스처 없이 쓰도록 뺐다.
        }
        finalColor *= 0.9;
        // fog that fades to reddish plus the sun color so that fog is brightest towards sun
        vec3 rv2 = rayVec;
        rv2.y *= saturate(sign(rv2.y));
        vec3 fogColor = GetEnvMap(rv2, sunDir);
        fogColor = min(vec3(9.0), fogColor);
        finalColor = mix(fogColor, finalColor, exp(-t*0.02));

        // visualize length of gradient of distance field to check distance field correctness
        //finalColor = vec3(0.5) * (length(normalU) / smallVec.x);
        //finalColor = vec3(marchCount)/255.0;
	}
    else
    {
        // Our ray trace hit nothing, so draw sky.
        finalColor = GetEnvMap(rayVec, sunDir);
    }

    // vignette?
    finalColor *= vec3(1.0) * saturate(1.0 - length(uv/2.5));
    finalColor *= 1.3*exposure;

	// output the final color without gamma correction - will do gamma later.
	return vec3(clamp(finalColor, 0.0, 1.0)*saturate(fade+0.2));
}

#ifdef NON_REALTIME_HQ_RENDER
// This function breaks the image down into blocks and scans
// through them, rendering 1 block at a time. It's for non-
// realtime things that take a long time to render.

// This is the frame rate to render at. Too fast and you will
// miss some blocks.
const float blockRate = 20.0;
void BlockRender(in vec2 fragCoord)
{
    // blockSize is how much it will try to render in 1 frame.
    // adjust this smaller for more complex scenes, bigger for
    // faster render times.
    const float blockSize = 64.0;
    // Make the block repeatedly scan across the image based on time.
    float frame = floor(iTime * blockRate);
    vec2 blockRes = floor(iResolution.xy / blockSize) + vec2(1.0);
    // ugly bug with mod.
    //float blockX = mod(frame, blockRes.x);
    float blockX = fract(frame / blockRes.x) * blockRes.x;
    //float blockY = mod(floor(frame / blockRes.x), blockRes.y);
    float blockY = fract(floor(frame / blockRes.x) / blockRes.y) * blockRes.y;
    // Don't draw anything outside the current block.
    if ((fragCoord.x - blockX * blockSize >= blockSize) ||
    	(fragCoord.x - (blockX - 1.0) * blockSize < blockSize) ||
    	(fragCoord.y - blockY * blockSize >= blockSize) ||
    	(fragCoord.y - (blockY - 1.0) * blockSize < blockSize))
    {
        discard;
    }
}
#endif

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
#ifdef NON_REALTIME_HQ_RENDER
    // Optionally render a non-realtime scene with high quality
    BlockRender(fragCoord);
#endif

    // Do a multi-pass render
    vec3 finalColor = vec3(0.0);
#ifdef NON_REALTIME_HQ_RENDER
    for (float i = 0.0; i < antialiasingSamples; i++)
    {
        const float motionBlurLengthInSeconds = 1.0 / 60.0;
        // Set this to the time in seconds of the frame to render.
	    localTime = frameToRenderHQ;
        // This line will motion-blur the renders
        localTime += Hash11(v21(fragCoord + seed)) * motionBlurLengthInSeconds;
        // Jitter the pixel position so we get antialiasing when we do multiple passes.
        vec2 jittered = fragCoord.xy + vec2(
            Hash21(fragCoord + seed),
            Hash21(fragCoord*7.234567 + seed)
            );
        // don't antialias if only 1 sample.
        if (antialiasingSamples == 1.0) jittered = fragCoord;
        // Accumulate one pass of raytracing into our pixel value
	    finalColor += RayTrace(jittered);
        // Change the random seed for each pass.
	    seed *= 1.01234567;
    }
    // Average all accumulated pixel intensities
    finalColor /= antialiasingSamples;
#else
    // Regular real-time rendering
    localTime = iTime;
    finalColor = RayTrace(fragCoord);
#endif

    fragColor = vec4(sqrt(clamp(finalColor, 0.0, 1.0)),1.0);
}

// FIELD: Shadertoy의 mainImage를 부른다. 알파는 1로 둔다(투명하게 남기면 뒤 배경이 비친다).
void main() {
    mainImage(fragColor, gl_FragCoord.xy);
    fragColor.a = 1.0;
}`;
const clouds2d = `#version 300 es
precision highp float;
// 2D Clouds by drift — License: Permission — 원작자의 자유 사용 허락
// 원본: https://www.shadertoy.com/view/4tdSWr (xscreensaver 수록본에서 옮김: https://github.com/Zygo/xscreensaver/tree/master/hacks/glx/glsl)
// 원작자가 "누구든 어떤 방식으로든 써도 된다. 출처 표시는 해 주면 좋겠다"고 밝혔다(아래 원본 주석).
//
// FIELD Studio로 옮기며 바꾼 점:
//  · Shadertoy 이름(iTime·iResolution)은 아래 #define으로 FIELD Uniform에 연결했다. mainImage는 그대로다
//  · uSpeed(시간 배속) 파라미터를 더했다
//  · sin 기반 실수 해시를 정수 해시(pcg3d)로 바꿨다 → 무늬·배치가 원본과 다르다
//
// 원리: 그래디언트 노이즈를 옥타브마다 회전·확대해 더한 fbm으로 구름 모양(밀도)과 색을 따로 만들고, 시간에 따라 흘려 보낸다.
uniform vec2 uResolution;
uniform float uTime;
uniform float uSpeed;  // 시간 배속(1 = 원본) · @range 0 3 @step 0.01 @default 1
out vec4 fragColor;

// Shadertoy 이름 → FIELD Uniform
#define iResolution vec3(uResolution, 1.0)
#define iTime (uTime * uSpeed)

// Title:  2D Clouds
// Author: drift
// URL:    https://www.shadertoy.com/view/4tdSWr
// Date:   12-Nov-2016
// Desc:   Used in 2 different demos:
// http://www.pouet.net/prod.php?which=66590
// and
// http://www.pouet.net/prod.php?which=68483

// 2024-06-25, drift says:
//
// "Just posting here to say that I don't check Shadertoy very often and I
// don't get any notifications of messages here. Anyone and everyone who
// wishes to use this shader I give my permission to use it in any way that
// you choose. Credit would be nice but I won't insist on it."


const float cloudscale = 1.1;
const float speed = 0.03;
const float clouddark = 0.5;
const float cloudlight = 0.3;
const float cloudcover = 0.2;
const float cloudalpha = 8.0;
const float skytint = 0.5;
const vec3 skycolour1 = vec3(0.2, 0.4, 0.6);
const vec3 skycolour2 = vec3(0.4, 0.7, 1.0);

const mat2 m = mat2( 1.6,  1.2, -1.2,  1.6 );

// FIELD: 원본의 sin 기반 실수 해시를 정수 해시(pcg3d)로 바꿨다(-1~1 그래디언트).
uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
float pcgFloat(uint v) { return float(v >> 8u) * (1.0 / 16777216.0); }
vec2 hash( vec2 p ) {
	uvec3 h = pcg3d(uvec3(floatBitsToUint(p), 0u));
	return -1.0 + 2.0*vec2(pcgFloat(h.x), pcgFloat(h.y));
}

float noise( in vec2 p ) {
    const float K1 = 0.366025404; // (sqrt(3)-1)/2;
    const float K2 = 0.211324865; // (3-sqrt(3))/6;
	vec2 i = floor(p + (p.x+p.y)*K1);	
    vec2 a = p - i + (i.x+i.y)*K2;
    vec2 o = (a.x>a.y) ? vec2(1.0,0.0) : vec2(0.0,1.0); //vec2 of = 0.5 + 0.5*vec2(sign(a.x-a.y), sign(a.y-a.x));
    vec2 b = a - o + K2;
	vec2 c = a - 1.0 + 2.0*K2;
    vec3 h = max(0.5-vec3(dot(a,a), dot(b,b), dot(c,c) ), 0.0 );
	vec3 n = h*h*h*h*vec3( dot(a,hash(i+0.0)), dot(b,hash(i+o)), dot(c,hash(i+1.0)));
    return dot(n, vec3(70.0));	
}

float fbm(vec2 n) {
	float total = 0.0, amplitude = 0.1;
	for (int i = 0; i < 7; i++) {
		total += noise(n) * amplitude;
		n = m * n;
		amplitude *= 0.4;
	}
	return total;
}

// -----------------------------------------------

void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
    vec2 p = fragCoord.xy / iResolution.xy;
	vec2 uv = p*vec2(iResolution.x/iResolution.y,1.0);    
    float time = iTime * speed;
    float q = fbm(uv * cloudscale * 0.5);
    
    //ridged noise shape
	float r = 0.0;
	uv *= cloudscale;
    uv -= q - time;
    float weight = 0.8;
    for (int i=0; i<8; i++){
		r += abs(weight*noise( uv ));
        uv = m*uv + time;
		weight *= 0.7;
    }
    
    //noise shape
	float f = 0.0;
    uv = p*vec2(iResolution.x/iResolution.y,1.0);
	uv *= cloudscale;
    uv -= q - time;
    weight = 0.7;
    for (int i=0; i<8; i++){
		f += weight*noise( uv );
        uv = m*uv + time;
		weight *= 0.6;
    }
    
    f *= r + f;
    
    //noise colour
    float c = 0.0;
    time = iTime * speed * 2.0;
    uv = p*vec2(iResolution.x/iResolution.y,1.0);
	uv *= cloudscale*2.0;
    uv -= q - time;
    weight = 0.4;
    for (int i=0; i<7; i++){
		c += weight*noise( uv );
        uv = m*uv + time;
		weight *= 0.6;
    }
    
    //noise ridge colour
    float c1 = 0.0;
    time = iTime * speed * 3.0;
    uv = p*vec2(iResolution.x/iResolution.y,1.0);
	uv *= cloudscale*3.0;
    uv -= q - time;
    weight = 0.4;
    for (int i=0; i<7; i++){
		c1 += abs(weight*noise( uv ));
        uv = m*uv + time;
		weight *= 0.6;
    }
	
    c += c1;
    
    vec3 skycolour = mix(skycolour2, skycolour1, p.y);
    vec3 cloudcolour = vec3(1.1, 1.1, 0.9) * clamp((clouddark + cloudlight*c), 0.0, 1.0);
   
    f = cloudcover + cloudalpha*f*r;
    
    vec3 result = mix(skycolour, clamp(skytint * skycolour + cloudcolour, 0.0, 1.0), clamp(f + c, 0.0, 1.0));
    
	fragColor = vec4( result, 1.0 );
}

// FIELD: Shadertoy의 mainImage를 부른다. 알파는 1로 둔다(투명하게 남기면 뒤 배경이 비친다).
void main() {
    mainImage(fragColor, gl_FragCoord.xy);
    fragColor.a = 1.0;
}`;
const selfReflect = `#version 300 es
precision highp float;
// Let's self reflect by mrange — License: CC0
// 원본: https://www.shadertoy.com/view/XfyXRV (xscreensaver 수록본에서 옮김: https://github.com/Zygo/xscreensaver/tree/master/hacks/glx/glsl)
// CC0(퍼블릭 도메인 헌정)이라 고지 의무는 없지만 출처를 남긴다.
//
// FIELD Studio로 옮기며 바꾼 점:
//  · Shadertoy 이름(iTime·iResolution)은 아래 #define으로 FIELD Uniform에 연결했다. mainImage는 그대로다
//  · uSpeed(시간 배속) 파라미터를 더했다
//
// 원리: 다면체 거리장 안쪽으로 굴절해 들어간 광선이 안쪽 면에서 반사되는 과정을 여러 번 되풀이하며 색을 모은다.
uniform vec2 uResolution;
uniform float uTime;
uniform float uSpeed;  // 시간 배속(1 = 원본) · @range 0 3 @step 0.01 @default 1
out vec4 fragColor;

// Shadertoy 이름 → FIELD Uniform
#define iResolution vec3(uResolution, 1.0)
#define iTime (uTime * uSpeed)

// Title:  Let's self reflect
// Author: mrange
// URL:    https://www.shadertoy.com/view/XfyXRV
// Date:   11-May-2024
// Desc:   CC0: Let's self reflect
// Always enjoyed the videos of Platonic solids with inner mirrors
// I made some previous attempts but thought I make another attempt it

// CC0: Let's self reflect
//  Always enjoyed the videos of Platonic solids with inner mirrors
//  I made some previous attempts but thought I make another attempt it

// Reducing the alias effects on the inner reflections turned out to be a bit tricky. 
//  Simplest solution is just to run run fullscreen on a 4K screen ;)

// Function to generate the solid found here: https://www.shadertoy.com/view/MsKGzw

// Tinker with these parameters to create different solids
// -------------------------------------------------------
const float rotation_speed= 0.25;

const float poly_U        = 1.;   // [0, inf]
const float poly_V        = 0.5;  // [0, inf]
const float poly_W        = 1.0;  // [0, inf]
const int   poly_type     = 3;    // [2, 5]
const float poly_zoom     = 2.0;

const float inner_sphere  = 1.;

const float refr_index    = 0.9;

#define MAX_BOUNCES2        6
// -------------------------------------------------------



#define TIME        iTime
#define RESOLUTION  iResolution
#define PI          3.141592654
#define TAU         (2.0*PI)

// License: WTFPL, author: sam hocevar, found: https://stackoverflow.com/a/17897228/418488
const vec4 hsv2rgb_K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + hsv2rgb_K.xyz) * 6.0 - hsv2rgb_K.www);
  return c.z * mix(hsv2rgb_K.xxx, clamp(p - hsv2rgb_K.xxx, 0.0, 1.0), c.y);
}
// License: WTFPL, author: sam hocevar, found: https://stackoverflow.com/a/17897228/418488
//  Macro version of above to enable compile-time constants
#define HSV2RGB(c)  (c.z * mix(hsv2rgb_K.xxx, clamp(abs(fract(c.xxx + hsv2rgb_K.xyz) * 6.0 - hsv2rgb_K.www) - hsv2rgb_K.xxx, 0.0, 1.0), c.y))

#define TOLERANCE2          0.0005
//#define MAX_RAY_LENGTH2   10.0
#define MAX_RAY_MARCHES2    50
#define NORM_OFF2           0.005
#define BACKSTEP2

#define TOLERANCE3          0.0005
#define MAX_RAY_LENGTH3     10.0
#define MAX_RAY_MARCHES3    90
#define NORM_OFF3           0.005

const vec3 rayOrigin    = vec3(0.0, 1., -5.);
const vec3 sunDir       = normalize(-rayOrigin);


const vec3 sunCol       = HSV2RGB(vec3(0.06 , 0.90, 1E-2))*1.;
const vec3 bottomBoxCol = HSV2RGB(vec3(0.66, 0.80, 0.5))*1.;
const vec3 topBoxCol    = HSV2RGB(vec3(0.60, 0.90, 1.))*1.;
const vec3 glowCol0     = HSV2RGB(vec3(0.05 , 0.7, 1E-3))*1.;
const vec3 glowCol1     = HSV2RGB(vec3(0.95, 0.7, 1E-3))*1.;
const vec3 beerCol      = -HSV2RGB(vec3(0.15+0.5, 0.7, 2.)); 
const float rrefr_index = 1./refr_index;


// License: Unknown, author: knighty, found: https://www.shadertoy.com/view/MsKGzw
const float poly_cospin   = cos(PI/float(poly_type));
const float poly_scospin  = sqrt(0.75-poly_cospin*poly_cospin);
const vec3  poly_nc       = vec3(-0.5, -poly_cospin, poly_scospin);
const vec3  poly_pab      = vec3(0., 0., 1.);
const vec3  poly_pbc_     = vec3(poly_scospin, 0., 0.5);
const vec3  poly_pca_     = vec3(0., poly_scospin, poly_cospin);
const vec3  poly_p        = normalize((poly_U*poly_pab+poly_V*poly_pbc_+poly_W*poly_pca_));
const vec3  poly_pbc      = normalize(poly_pbc_);
const vec3  poly_pca      = normalize(poly_pca_);

mat3 g_rot;
vec2 g_gd;
  
// License: MIT, author: Inigo Quilez, found: https://iquilezles.org/articles/noacos/
mat3 rot(vec3 d, vec3 z) {
  vec3  v = cross( z, d );
  float c = dot( z, d );
  float k = 1.0/(1.0+c);

  return mat3( v.x*v.x*k + c,     v.y*v.x*k - v.z,    v.z*v.x*k + v.y,
               v.x*v.y*k + v.z,   v.y*v.y*k + c,      v.z*v.y*k - v.x,
               v.x*v.z*k - v.y,   v.y*v.z*k + v.x,    v.z*v.z*k + c    );
}

// License: Unknown, author: Matt Taylor (https://github.com/64), found: https://64.github.io/tonemapping/
vec3 aces_approx(vec3 v) {
  v = max(v, 0.0);
  v *= 0.6;
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((v*(a*v+b))/(v*(c*v+d)+e), 0.0, 1.0);
}

float sphere(vec3 p, float r) {
  return length(p) - r;
}

// License: MIT, author: Inigo Quilez, found: https://iquilezles.org/articles/distfunctions/
float box(vec2 p, vec2 b) {
  vec2 d = abs(p)-b;
  return length(max(d,0.0)) + min(max(d.x,d.y),0.0);
}
  
// License: Unknown, author: knighty, found: https://www.shadertoy.com/view/MsKGzw
void poly_fold(inout vec3 pos) {
  vec3 p = pos;

  for(int i = 0; i < poly_type; ++i){
    p.xy  = abs(p.xy);
    p    -= 2.*min(0., dot(p,poly_nc)) * poly_nc;
  }
  
  pos = p;
}

float poly_plane(vec3 pos) {
  float d0 = dot(pos, poly_pab);
  float d1 = dot(pos, poly_pbc);
  float d2 = dot(pos, poly_pca);
  float d = d0;
  d = max(d, d1);
  d = max(d, d2);
  return d;
}

float poly_corner(vec3 pos) {
  float d = length(pos) - .0125;
  return d;
}

float dot2(vec3 p) {
  return dot(p, p);
}

float poly_edge(vec3 pos) {
  float dla = dot2(pos-min(0., pos.x)*vec3(1., 0., 0.));
  float dlb = dot2(pos-min(0., pos.y)*vec3(0., 1., 0.));
  float dlc = dot2(pos-min(0., dot(pos, poly_nc))*poly_nc);
  return sqrt(min(min(dla, dlb), dlc))-2E-3;
}

vec3 shape(vec3 pos) {
  pos *= g_rot;
  pos /= poly_zoom;
  poly_fold(pos);
  pos -= poly_p;

  return vec3(poly_plane(pos), poly_edge(pos), poly_corner(pos))*poly_zoom;
}

vec3 render0(vec3 ro, vec3 rd) {
  vec3 col = vec3(0.0);
  
  float srd  = sign(rd.y);
  float tp   = -(ro.y-6.)/abs(rd.y);

  if (srd < 0.) {
    col += bottomBoxCol*exp(-0.5*(length((ro + tp*rd).xz)));
  }

  if (srd > 0.0) {
    vec3 pos  = ro + tp*rd;
    vec2 pp = pos.xz;
    float db = box(pp, vec2(5.0, 9.0))-3.0;
    
    col += topBoxCol*rd.y*rd.y*smoothstep(0.25, 0.0, db);
    col += 0.2*topBoxCol*exp(-0.5*max(db, 0.0));
    col += 0.05*sqrt(topBoxCol)*max(-db, 0.0);
  }


  col += sunCol/(1.001-dot(sunDir, rd));
  return col; 
}

float df2(vec3 p) {
  vec3 ds = shape(p);
  float d2 = ds.y-5E-3;
  float d0 = min(-ds.x, d2);
  float d1 = sphere(p, inner_sphere);
  g_gd = min(g_gd, vec2(d2, d1));
  float d = (min(d0, d1));
  return d;
}

float rayMarch2(vec3 ro, vec3 rd, float tinit) {
  float t = tinit;
#if defined(BACKSTEP2)
  vec2 dti = vec2(1e10,0.0);
#endif
  int i;
  for (i = 0; i < MAX_RAY_MARCHES2; ++i) {
    float d = df2(ro + rd*t);
#if defined(BACKSTEP2)
    if (d<dti.x) { dti=vec2(d,t); }
#endif  
    // Bouncing in a closed shell, will never miss
    if (d < TOLERANCE2/* || t > MAX_RAY_LENGTH3 */) {
      break;
    }
    t += d;
  }
#if defined(BACKSTEP2)
  if(i==MAX_RAY_MARCHES2) { t=dti.y; };
#endif  
  return t;
}

vec3 normal2(vec3 pos) {
  vec2  eps = vec2(NORM_OFF2,0.0);
  vec3 nor;
  nor.x = df2(pos+eps.xyy) - df2(pos-eps.xyy);
  nor.y = df2(pos+eps.yxy) - df2(pos-eps.yxy);
  nor.z = df2(pos+eps.yyx) - df2(pos-eps.yyx);
  return normalize(nor);
}

vec3 render2(vec3 ro, vec3 rd, float db) {
  vec3 agg = vec3(0.0);
  float ragg = 1.;
  float tagg = 0.;
  
  for (int bounce = 0; bounce < MAX_BOUNCES2; ++bounce) {
    if (ragg < 0.1) break;
    g_gd      = vec2(1E3);
    float t2  = rayMarch2(ro, rd, min(db+0.05, 0.3));
    vec2 gd2  = g_gd;
    tagg      += t2;
    
    vec3 p2   = ro+rd*t2;
    vec3 n2   = normal2(p2);
    vec3 r2   = reflect(rd, n2);
    vec3 rr2  = refract(rd, n2, rrefr_index);
    float fre2= 1.+dot(n2,rd);
    
    vec3 beer = ragg*exp(0.2*beerCol*tagg);
    agg += glowCol1*beer*((1.+tagg*tagg*4E-2)*6./max(gd2.x, 5E-4+tagg*tagg*2E-4/ragg));
    vec3 ocol = 0.2*beer*render0(p2, rr2);
    if (gd2.y <= TOLERANCE2) {
      ragg *= 1.-0.9*fre2;
    } else {
      agg     += ocol;
      ragg    *= 0.8;
    }
    
    ro        = p2;
    rd        = r2;
    db        = gd2.x; 
  }


  return agg;
}

float df3(vec3 p) {
  vec3 ds = shape(p);
  g_gd = min(g_gd, ds.yz);
  const float sw = 0.02;
  float d1 = min(ds.y, ds.z)-sw;
  float d0 = ds.x;
  d0 = min(d0, ds.y);
  d0 = min(d0, ds.z);
  return d0;
}

float rayMarch3(vec3 ro, vec3 rd, float tinit, out int iter) {
  float t = tinit;
  int i;
  for (i = 0; i < MAX_RAY_MARCHES3; ++i) {
    float d = df3(ro + rd*t);
    if (d < TOLERANCE3 || t > MAX_RAY_LENGTH3) {
      break;
    }
    t += d;
  }
  iter = i;
  return t;
}

vec3 normal3(vec3 pos) {
  vec2  eps = vec2(NORM_OFF3,0.0);
  vec3 nor;
  nor.x = df3(pos+eps.xyy) - df3(pos-eps.xyy);
  nor.y = df3(pos+eps.yxy) - df3(pos-eps.yxy);
  nor.z = df3(pos+eps.yyx) - df3(pos-eps.yyx);
  return normalize(nor);
}

vec3 render3(vec3 ro, vec3 rd) {
  int iter;

  vec3 skyCol = render0(ro, rd);
  vec3 col  = skyCol;

  g_gd      = vec2(1E3);
  float t1  = rayMarch3(ro, rd, 0.1, iter);
  vec2 gd1  = g_gd;
  vec3 p1   = ro+t1*rd;
  vec3 n1   = normal3(p1);
  vec3 r1   = reflect(rd, n1);
  vec3 rr1  = refract(rd, n1, refr_index);
  float fre1= 1.+dot(rd, n1);
  fre1 *= fre1;

  float ifo = mix(0.5, 1., smoothstep(1.0, 0.9, float(iter)/float(MAX_RAY_MARCHES3)));

  if (t1 < MAX_RAY_LENGTH3) {
    col = render0(p1, r1)*(0.5+0.5*fre1)*ifo;
    vec3 icol = render2(p1, rr1, gd1.x); 
    if (gd1.x > TOLERANCE3 && gd1.y > TOLERANCE3 && rr1 != vec3(0.)) {
      col += icol*(1.-0.75*fre1)*ifo;
    }
  }

  col += (glowCol0+1.*fre1*(glowCol0))/max(gd1.x, 3E-4);
  return col;

}

  
vec3 effect(vec2 p, vec2 pp) {
  const float fov = 2.0;
  
  const vec3 up = vec3(0., 1., 0.);
  const vec3 la   = vec3(0.0);

  const vec3 ww = normalize(normalize(la-rayOrigin));
  const vec3 uu = normalize(cross(up, ww));
  const vec3 vv = cross(ww, uu);
  
  vec3 rd = normalize(-p.x*uu + p.y*vv + fov*ww);

  vec3 col = vec3(0.0);
  col = render3(rayOrigin, rd);
  
  col -= 2E-2*vec3(2.,3.,1.)*(length(p)+0.25);
  col = aces_approx(col);
  col = sqrt(col);
  return col;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
  vec2 q = fragCoord/RESOLUTION.xy;
  vec2 p = -1. + 2. * q;
  vec2 pp = p;
  p.x *= RESOLUTION.x/RESOLUTION.y;

  float a = TIME*rotation_speed;
  vec3 r0 = vec3(1.0, sin(vec2(sqrt(0.5), 1.0)*a));
  vec3 r1 = vec3(cos(vec2(sqrt(0.5), 1.0)*0.913*a), 1.0);
  mat3 rot = rot(normalize(r0), normalize(r1));
  g_rot = rot;

  vec3 col = effect(p, pp);
  
  fragColor = vec4(col, 1.0);
}

// FIELD: Shadertoy의 mainImage를 부른다. 알파는 1로 둔다(투명하게 남기면 뒤 배경이 비친다).
void main() {
    mainImage(fragColor, gl_FragCoord.xy);
    fragColor.a = 1.0;
}`;
const starsGalaxy = `#version 300 es
precision highp float;
// Stars and galaxy by mrange — License: CC0
// 원본: https://www.shadertoy.com/view/stBcW1 (xscreensaver 수록본에서 옮김: https://github.com/Zygo/xscreensaver/tree/master/hacks/glx/glsl)
// CC0(퍼블릭 도메인 헌정)이라 고지 의무는 없지만 출처를 남긴다.
//
// FIELD Studio로 옮기며 바꾼 점:
//  · Shadertoy 이름(iTime·iResolution)은 아래 #define으로 FIELD Uniform에 연결했다. mainImage는 그대로다
//  · uSpeed(시간 배속) 파라미터를 더했다
//  · sin 기반 실수 해시를 정수 해시(pcg3d)로 바꿨다 → 무늬·배치가 원본과 다르다
//
// 원리: 하늘을 구면 격자로 나눠 칸마다 별을 하나씩 두고, 노이즈로 만든 은하수 띠와 대기 빛을 겹친다.
uniform vec2 uResolution;
uniform float uTime;
uniform float uSpeed;  // 시간 배속(1 = 원본) · @range 0 3 @step 0.01 @default 1
out vec4 fragColor;

// Shadertoy 이름 → FIELD Uniform
#define iResolution vec3(uResolution, 1.0)
#define iTime (uTime * uSpeed)

// Title:  Stars and galaxy
// Author: mrange
// URL:    https://www.shadertoy.com/view/stBcW1
// Date:   10-Apr-2022
// Desc:   License CC0: Stars and galaxy
// Bit of sunday tinkering lead to stars and a galaxy
// Didn't turn out as I envisioned but it turned out to something
// that I liked so sharing it.

// License CC0: Stars and galaxy
// Bit of sunday tinkering lead to stars and a galaxy
// Didn't turn out as I envisioned but it turned out to something
// that I liked so sharing it.

// Controls how many layers of stars
#define LAYERS            5.0

#define PI                3.141592654
#define TAU               (2.0*PI)
#define TIME              mod(iTime, 30.0)
#define TTIME             (TAU*TIME)
#define RESOLUTION        iResolution
#define ROT(a)            mat2(cos(a), sin(a), -sin(a), cos(a))

// License: Unknown, author: nmz (twitter: @stormoid), found: https://www.shadertoy.com/view/NdfyRM
float sRGB(float t) { return mix(1.055*pow(t, 1./2.4) - 0.055, 12.92*t, step(t, 0.0031308)); }
// License: Unknown, author: nmz (twitter: @stormoid), found: https://www.shadertoy.com/view/NdfyRM
vec3 sRGB(in vec3 c) { return vec3 (sRGB(c.x), sRGB(c.y), sRGB(c.z)); }

// License: Unknown, author: Matt Taylor (https://github.com/64), found: https://64.github.io/tonemapping/
vec3 aces_approx(vec3 v) {
  v = max(v, 0.0);
  v *= 0.6f;
  float a = 2.51f;
  float b = 0.03f;
  float c = 2.43f;
  float d = 0.59f;
  float e = 0.14f;
  return clamp((v*(a*v+b))/(v*(c*v+d)+e), 0.0f, 1.0f);
}

// License: Unknown, author: Unknown, found: don't remember
float tanh_approx(float x) {
  //  Found this somewhere on the interwebs
  //  return tanh(x);
  float x2 = x*x;
  return clamp(x*(27.0 + x2)/(27.0+9.0*x2), -1.0, 1.0);
}


// License: WTFPL, author: sam hocevar, found: https://stackoverflow.com/a/17897228/418488
const vec4 hsv2rgb_K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + hsv2rgb_K.xyz) * 6.0 - hsv2rgb_K.www);
  return c.z * mix(hsv2rgb_K.xxx, clamp(p - hsv2rgb_K.xxx, 0.0, 1.0), c.y);
}

// License: MIT OR CC-BY-NC-4.0, author: mercury, found: https://mercury.sexy/hg_sdf/
vec2 mod2(inout vec2 p, vec2 size) {
  vec2 c = floor((p + size*0.5)/size);
  p = mod(p + size*0.5,size) - size*0.5;
  return c;
}

// FIELD: 원본의 이 해시는 원작자도 출처를 모른다고 적어 둔 sin 기반 실수 해시였다("License: Unknown").
// 정수 해시(pcg3d)로 바꿨다.
uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
float pcgFloat(uint v) { return float(v >> 8u) * (1.0 / 16777216.0); }
vec2 hash2(vec2 p) {
  uvec3 h = pcg3d(uvec3(floatBitsToUint(p), 0u));
  return vec2(pcgFloat(h.x), pcgFloat(h.y));
}

vec2 shash2(vec2 p) {
  return -1.0+2.0*hash2(p);
}

vec3 toSpherical(vec3 p) {
  float r   = length(p);
  float t   = acos(p.z/r);
  float ph  = atan(p.y, p.x);
  return vec3(r, t, ph);
}


// License: CC BY-NC-SA 3.0, author: Stephane Cuillerdier - Aiekick/2015 (twitter:@aiekick), found: https://www.shadertoy.com/view/Mt3GW2
vec3 blackbody(float Temp) {
  vec3 col = vec3(255.);
  col.x = 56100000. * pow(Temp,(-3. / 2.)) + 148.;
  col.y = 100.04 * log(Temp) - 623.6;
  if (Temp > 6500.) col.y = 35200000. * pow(Temp,(-3. / 2.)) + 184.;
  col.z = 194.18 * log(Temp) - 1448.6;
  col = clamp(col, 0., 255.)/255.;
  if (Temp < 1000.) col *= Temp/1000.;
  return col;
}


// License: MIT, author: Inigo Quilez, found: https://www.shadertoy.com/view/XslGRr
float noise(vec2 p) {
  // Found at https://www.shadertoy.com/view/sdlXWX
  // Which then redirected to IQ shader
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f*f*(3.-2.*f);
  
  float n =
         mix( mix( dot(shash2(i + vec2(0.,0.) ), f - vec2(0.,0.)), 
                   dot(shash2(i + vec2(1.,0.) ), f - vec2(1.,0.)), u.x),
              mix( dot(shash2(i + vec2(0.,1.) ), f - vec2(0.,1.)), 
                   dot(shash2(i + vec2(1.,1.) ), f - vec2(1.,1.)), u.x), u.y);

  return 2.0*n;              
}

float fbm(vec2 p, float o, float s, int iters) {
  p *= s;
  p += o;

  const float aa = 0.5;
  const mat2 pp = 2.04*ROT(1.0);

  float h = 0.0;
  float a = 1.0;
  float d = 0.0;
  for (int i = 0; i < iters; ++i) {
    d += a;
    h += a*noise(p);
    p += vec2(10.7, 8.3);
    p *= pp;
    a *= aa;
  }
  h /= d;
  
  return h;
}

float height(vec2 p) {
  float h = fbm(p, 0.0, 5.0, 5);
  h *= 0.3;
  h += 0.0;
  return (h);
}

vec3 stars(vec3 ro, vec3 rd, vec2 sp, float hh) {
  vec3 col = vec3(0.0);
  
  const float m = LAYERS;
  hh = tanh_approx(20.0*hh);

  for (float i = 0.0; i < m; ++i) {
    vec2 pp = sp+0.5*i;
    float s = i/(m-1.0);
    vec2 dim  = vec2(mix(0.05, 0.003, s)*PI);
    vec2 np = mod2(pp, dim);
    vec2 h = hash2(np+127.0+i);
    vec2 o = -1.0+2.0*h;
    float y = sin(sp.x);
    pp += o*dim*0.5;
    pp.y *= y;
    float l = length(pp);
  
    float h1 = fract(h.x*1667.0);
    float h2 = fract(h.x*1887.0);
    float h3 = fract(h.x*2997.0);

    vec3 scol = mix(8.0*h2, 0.25*h2*h2, s)*blackbody(mix(3000.0, 22000.0, h1*h1));

    vec3 ccol = col + exp(-(mix(6000.0, 2000.0, hh)/mix(2.0, 0.25, s))*max(l-0.001, 0.0))*scol;
    col = h3 < y ? ccol : col;
  }
  
  return col;
}

// License: MIT, author: Inigo Quilez, found: https://iquilezles.org/articles/spherefunctions
vec2 raySphere(vec3 ro, vec3 rd, vec4 sph) {
  vec3 oc = ro - sph.xyz;
  float b = dot( oc, rd );
  float c = dot( oc, oc ) - sph.w*sph.w;
  float h = b*b - c;
  if( h<0.0 ) return vec2(-1.0);
  h = sqrt( h );
  return vec2(-b - h, -b + h);
}


vec4 moon(vec3 ro, vec3 rd, vec2 sp, vec3 lp, vec4 md) {
  vec2 mi = raySphere(ro, rd, md);
  
  vec3 p    = ro + mi.x*rd;
  vec3 n    = normalize(p-md.xyz);
  vec3 r    = reflect(rd, n);
  vec3 ld   = normalize(lp - p);
  float fre = dot(n, rd)+1.0;
  fre = pow(fre, 15.0);
  float dif = max(dot(ld, n), 0.0);
  float spe = pow(max(dot(ld, r), 0.0), 8.0);
  float i = 0.5*tanh_approx(20.0*fre*spe+0.05*dif);
  vec3 col = blackbody(1500.0)*i+hsv2rgb(vec3(0.6, mix(0.6, 0.0, i), i));

  float t = tanh_approx(0.25*(mi.y-mi.x));
 
  return vec4(vec3(col), t);
}

vec3 sky(vec3 ro, vec3 rd, vec2 sp, vec3 lp, out float cf) {
  float ld = max(dot(normalize(lp-ro), rd),0.0);
  float y = -0.5+sp.x/PI;
  y = max(abs(y)-0.02, 0.0)+0.1*smoothstep(0.5, PI, abs(sp.y));
  vec3 blue = hsv2rgb(vec3(0.6, 0.75, 0.35*exp(-15.0*y)));
  float ci = pow(ld, 10.0)*2.0*exp(-25.0*y); 
  vec3 yellow = blackbody(1500.0)*ci;
  cf = ci;
  return blue+yellow;
}

vec3 galaxy(vec3 ro, vec3 rd, vec2 sp, out float sf) {
  vec2 gp = sp;
  gp *= ROT(0.67);
  gp += vec2(-1.0, 0.5);
  float h1 = height(2.0*sp);
  float gcc = dot(gp, gp);
  float gcx = exp(-(abs(3.0*(gp.x))));
  float gcy = exp(-abs(10.0*(gp.y)));
  float gh = gcy*gcx;
  float cf = smoothstep(0.05, -0.2, -h1);
  vec3 col = vec3(0.0);
  col += blackbody(mix(300.0, 1500.0, gcx*gcy))*gcy*gcx;
  col += hsv2rgb(vec3(0.6, 0.5, 0.00125/gcc));
  col *= mix(mix(0.15, 1.0, gcy*gcx), 1.0, cf);
  sf = gh*cf;
  return col;
}

vec3 grid(vec3 ro, vec3 rd, vec2 sp) {
  const float m = 1.0;

  const vec2 dim = vec2(1.0/8.0*PI);
  vec2 pp = sp;
  vec2 np = mod2(pp, dim);

  vec3 col = vec3(0.0);

  float y = sin(sp.x);
  float d = min(abs(pp.x), abs(pp.y*y));
  
  float aa = 2.0/RESOLUTION.y;
  
  col += 2.0*vec3(0.5, 0.5, 1.0)*exp(-2000.0*max(d-0.00025, 0.0));
  
  return 0.25*tanh(col);
}

vec3 color(vec3 ro, vec3 rd, vec3 lp, vec4 md) {
  vec2 sp = toSpherical(rd.xzy).yz;

  float sf = 0.0;
  float cf = 0.0;
  vec3 col = vec3(0.0);

  vec4 mcol = moon(ro, rd, sp, lp, md);

  col += stars(ro, rd, sp, sf)*(1.0-tanh_approx(2.0*cf));
  col += galaxy(ro, rd, sp, sf);
  col = mix(col, mcol.xyz, mcol.w);
  col += sky(ro, rd, sp, lp, cf);
  col += grid(ro, rd, sp);

  if (rd.y < 0.0)
  {
    col = vec3(0.0);
  }

  return col;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 q = fragCoord/iResolution.xy;
  vec2 p = -1.0 + 2.0*q;
  p.x *= RESOLUTION.x/RESOLUTION.y;

  vec3 ro = vec3(0.0, 0.0, 0.0);
  vec3 lp = 500.0*vec3(1.0, -0.25, 0.0);
  vec4 md = 50.0*vec4(vec3(1.0, 1., -0.6), 0.5);
  vec3 la = vec3(1.0, 0.5, 0.0);
  vec3 up = vec3(0.0, 1.0, 0.0);
  la.xz *= ROT(TTIME/60.0-PI/2.0);
  
  vec3 ww = normalize(la - ro);
  vec3 uu = normalize(cross(up, ww));
  vec3 vv = normalize(cross(ww,uu));
  vec3 rd = normalize(p.x*uu + p.y*vv + 2.0*ww);
  vec3 col= color(ro, rd, lp, md);
  
  col *= smoothstep(0.0, 4.0, TIME)*smoothstep(30.0, 26.0, TIME);
  col = aces_approx(col);
  col = sRGB(col);

  fragColor = vec4(col,1.0);
}

// FIELD: Shadertoy의 mainImage를 부른다. 알파는 1로 둔다(투명하게 남기면 뒤 배경이 비친다).
void main() {
    mainImage(fragColor, gl_FragCoord.xy);
    fragColor.a = 1.0;
}`;
const elementalRing = `#version 300 es
precision highp float;
// Elemental Ring by Otavio Good — License: CC0
// 원본: https://www.shadertoy.com/view/MsVXDt (xscreensaver 수록본에서 옮김: https://github.com/Zygo/xscreensaver/tree/master/hacks/glx/glsl)
// CC0(퍼블릭 도메인 헌정)이라 고지 의무는 없지만 출처를 남긴다.
//
// FIELD Studio로 옮기며 바꾼 점:
//  · Shadertoy 이름(iTime·iResolution·iMouse)은 아래 #define으로 FIELD Uniform에 연결했다. mainImage는 그대로다
//  · uSpeed(시간 배속) 파라미터를 더했다
//  · iMouse 대신 커서 위치를 쓴다: 커서를 올리면 시점이 바뀌고, 뷰포트 밖이면 원본의 기본 시점
//  · sin 기반 실수 해시를 정수 해시(pcg3d)로 바꿨다 → 무늬·배치가 원본과 다르다
//
// 원리: 꼬인 원환체 거리장을 레이마칭하고, 광선이 지나며 가까웠던 정도를 빛(glow)으로 쌓는다.
uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uMouse;   // xy = 커서(뷰포트 밖이면 -1), zw = 누른 위치(누르는 중 양수)
uniform float uSpeed;  // 시간 배속(1 = 원본) · @range 0 3 @step 0.01 @default 1
out vec4 fragColor;

// Shadertoy 이름 → FIELD Uniform
#define iResolution vec3(uResolution, 1.0)
#define iTime (uTime * uSpeed)
#define iMouse vec4(max(uMouse.xy, vec2(0.0)), uMouse.zw)

// Title:  Elemental Ring
// Author: otaviogood
// URL:    https://www.shadertoy.com/view/MsVXDt
// Date:   19-Jul-2016
// Desc:   This shader was inspired by https://www.shadertoy.com/view/MtBSWR. I wanted to do a 3d version.

/*--------------------------------------------------------------------------------------
License CC0 - http://creativecommons.org/publicdomain/zero/1.0/
To the extent possible under law, the author(s) have dedicated all copyright and related and neighboring rights to this software to the public domain worldwide. This software is distributed without any warranty.
----------------------------------------------------------------------------------------
^ This means do ANYTHING YOU WANT with this code. Because we are programmers, not lawyers.
-Otavio Good
*/

// ---------------- Config ----------------
// This is an option that lets you render high quality frames for screenshots. It enables
// stochastic antialiasing and motion blur automatically for any shader.
//#define NON_REALTIME_HQ_RENDER
const float frameToRenderHQ = 11.0; // Time in seconds of frame to render
const float antialiasingSamples = 16.0; // 16x antialiasing - too much might make the shader compiler angry.

//#define MANUAL_CAMERA


// --------------------------------------------------------
// These variables are for the non-realtime block renderer.
float localTime = 0.0;
float seed = 1.0;

// ---- noise functions ----
float v31(vec3 a)
{
    return a.x + a.y * 37.0 + a.z * 521.0;
}
float v21(vec2 a)
{
    return a.x + a.y * 37.0;
}
// FIELD: 원본의 sin·cos 기반 실수 해시를 정수 해시(pcg3d)로 바꿨다. 함수 이름과 쓰임은 그대로다.
uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
float pcgFloat(uint v) { return float(v >> 8u) * (1.0 / 16777216.0); }
float Hash11(float a) { return pcgFloat(pcg3d(uvec3(floatBitsToUint(a), 0u, 0u)).x); }
float Hash21(vec2 uv) { return pcgFloat(pcg3d(uvec3(floatBitsToUint(uv), 0u)).x); }
vec2 Hash22(vec2 uv) { uvec3 h = pcg3d(uvec3(floatBitsToUint(uv), 1u)); return vec2(pcgFloat(h.x), pcgFloat(h.y)); }
vec2 Hash12(float f) { uvec3 h = pcg3d(uvec3(floatBitsToUint(f), 1u, 0u)); return vec2(pcgFloat(h.x), pcgFloat(h.y)); }
float Hash1d(float u) { return Hash11(u); }
float Hash2d(vec2 uv) { return Hash21(uv); }
float Hash3d(vec3 uv) { return pcgFloat(pcg3d(floatBitsToUint(uv)).x); }

const float PI=3.14159265;

vec3 saturate(vec3 a) { return clamp(a, 0.0, 1.0); }
vec2 saturate(vec2 a) { return clamp(a, 0.0, 1.0); }
float saturate(float a) { return clamp(a, 0.0, 1.0); }

// polynomial smooth min (k = 0.1);
float smin( float a, float b, float k )
{
    float h = clamp( 0.5+0.5*(b-a)/k, 0.0, 1.0 );
    return mix( b, a, h ) - k*h*(1.0-h);
}

vec2 matMin(vec2 a, vec2 b)
{
	if (a.x < b.x) return a;
	else return b;
}

// ---- shapes defined by distance fields ----
// See this site for a reference to more distance functions...
// https://iquilezles.org/articles/distfunctions
// box distance field
float sdBox(vec3 p, vec3 radius)
{
  vec3 dist = abs(p) - radius;
  return min(max(dist.x, max(dist.y, dist.z)), 0.0) + length(max(dist, 0.0));
}

// simple cylinder distance field
float cyl(vec2 p, float r)
{
    return length(p) - r;
}

const float TAU = 2.0 * PI;

float glow = 0.0;
// This is the function that makes the geometry.
// The input is a position in space.
// The output is the distance to the nearest surface and a material number
vec2 DistanceToObject(vec3 p)
{
    float time = localTime*2.0;
    float cylRadBig = 1.0;
    float cylRadSmall = 0.05;
    float freq = 4.0;
    float braidRad = 0.15;
    float angle = atan(p.z, p.x);
    float cylDist = length(p.xz) - cylRadBig;
    vec3 cylWarp = vec3(cylDist, p.y, angle);
    float amp = sin(angle + time) * 0.5 + 0.5;

    float theta = angle*freq;
    vec2 wave1 = vec2(sin(theta), cos(theta)) * braidRad;
    wave1 *= amp;
    //float d = length(cylWarp.xy + wave1) - cylRadSmall;
    float d = sdBox(vec3(cylWarp.xy + wave1, 0.0), vec3(cylRadSmall));
    float final = d;

    theta = angle*freq + TAU / 3.0;
    vec2 wave2 = vec2(sin(theta), cos(theta)) * braidRad;
    wave2 *= amp;
    //d = length(cylWarp.xy + wave2) - cylRadSmall;
    d = sdBox(vec3(cylWarp.xy + wave2, 0.0), vec3(cylRadSmall));
    final = smin(final, d, 0.1);

    theta = angle*freq - TAU / 3.0;
    vec2 wave3 = vec2(sin(theta), cos(theta)) * braidRad;
    wave3 *= amp;
    //d = length(cylWarp.xy + wave3) - cylRadSmall;
    d = sdBox(vec3(cylWarp.xy + wave3, 0.0), vec3(cylRadSmall));
    final = smin(final, d, 0.1);

    vec2 matd = vec2(final, fract((angle+time) / TAU+0.5));
    float sliver = cyl(cylWarp.xy, 0.03);
    glow += 1.0 / (sliver * sliver * sliver * sliver + 1.0);
    //sliver = max(sliver, abs(fract(cylWarp.z*freq-2.0*localTime)-0.5)-0.3);
    matd = matMin(matd, vec2(sliver, -1.0));
    return matd;
}

// Input is UV coordinate of pixel to render.
// Output is RGB color.
vec3 RayTrace(in vec2 fragCoord )
{
    glow = 0.0;
	// -------------------------------- animate ---------------------------------------
	vec3 camPos, camUp, camLookat;
	// ------------------- Set up the camera rays for ray marching --------------------
    // Map uv to [-1.0..1.0]
	vec2 uv = fragCoord.xy/iResolution.xy * 2.0 - 1.0;
    float zoom = 2.2;
    uv /= zoom;

    // Camera up vector.
	camUp=vec3(0,1,0);

	// Camera lookat.
	camLookat=vec3(0);

    // debugging camera
    float mx=iMouse.x/iResolution.x*PI*2.0;
	float my=-iMouse.y/iResolution.y*10.0;
#ifndef MANUAL_CAMERA
    camPos = vec3(0.0);
    camPos.y = sin(localTime*0.125)*3.0;
    camPos.z = cos(localTime*0.125)*3.0;
    camUp.y = camPos.z;
    camUp.z = -camPos.y;
    camUp = normalize(camUp);
#else
	camPos = vec3(cos(my)*cos(mx),sin(my),cos(my)*sin(mx))*3.0;
#endif

	// Camera setup.
	vec3 camVec=normalize(camLookat - camPos);
	vec3 sideNorm=normalize(cross(camUp, camVec));
	vec3 upNorm=cross(camVec, sideNorm);
	vec3 worldFacing=(camPos + camVec);
	vec3 worldPix = worldFacing + uv.x * sideNorm * (iResolution.x/iResolution.y) + uv.y * upNorm;
	vec3 rayVec = normalize(worldPix - camPos);

	// ----------------------------- Ray march the scene ------------------------------
	vec2 distMat = vec2(1.0, 0.0);
	float t = 0.0 + Hash2d(uv)*1.6;	// random dither glow by moving march count start position
	const float maxDepth = 6.0; // farthest distance rays will travel
	vec3 pos = vec3(0,0,0);
    const float smallVal = 0.000625;
    float marchCount = 0.0;
	// ray marching time
    for (int i = 0; i < 80; i++)	// This is the count of the max times the ray actually marches.
    {
        // Step along the ray.
        pos = camPos + rayVec * t;
        // This is _the_ function that defines the "distance field".
        // It's really what makes the scene geometry. The idea is that the
        // distance field returns the distance to the closest object, and then
        // we know we are safe to "march" along the ray by that much distance
        // without hitting anything. We repeat this until we get really close
        // and then break because we have effectively hit the object.
        distMat = DistanceToObject(pos);

        // Move along the ray.
        // Leave room for error by multiplying in case distance function isn't exact.
        t += distMat.x * 0.8;
        // If we are very close to the object, let's call it a hit and exit this loop.
        if ((t > maxDepth) || (abs(distMat.x) < smallVal)) break;

        // Glow if we're close to the part of the ring with the braid.
        float cyc = (-sin(distMat.y * TAU))*0.5+0.7;
        // This function is similar to a gaussian fall-off of glow when you're close
        // to an object.
        // http://thetamath.com/app/y=(1)/((x*x+1))
        marchCount += cyc / (distMat.x * distMat.x + 1.0);
    }

	// --------------------------------------------------------------------------------
	// Now that we have done our ray marching, let's put some color on this geometry.

    // Save off ray-march glows so they don't get messed up when we call the distance
    // function again to get the normal
	float glowSave = glow;
    float marchSave = marchCount;
    marchCount = 0.0;
    glow = 0.0;

    // default to blueish background color.
	vec3 finalColor = vec3(0.09, 0.15, 0.35);

	// If a ray actually hit the object, let's light it.
    if (t <= maxDepth)
	{
        // calculate the normal from the distance field. The distance field is a volume, so if you
        // sample the current point and neighboring points, you can use the difference to get
        // the normal.
        vec3 smallVec = vec3(smallVal, 0, 0);
        vec3 normalU = vec3(distMat.x - DistanceToObject(pos - smallVec.xyy).x,
                           distMat.x - DistanceToObject(pos - smallVec.yxy).x,
                           distMat.x - DistanceToObject(pos - smallVec.yyx).x);

        vec3 texColor = vec3(0.0, 0.0, 0.1);
        if (distMat.y < 0.0) texColor = vec3(0.6, 0.3, 0.1)*110.0;

        finalColor = texColor;
        // visualize length of gradient of distance field to check distance field correctness
        //finalColor = vec3(0.5) * (length(normalU) / smallVec.x);
	}
    // add the ray marching glows
    finalColor += vec3(0.3, 0.5, 0.9) * glowSave*0.00625;
    finalColor += vec3(1.0, 0.5, 0.3) * marchSave*0.05;

    // vignette
    finalColor *= vec3(1.0) * saturate(1.0 - length(uv/2.5));

	// output the final color without gamma correction - will do gamma later.
	return vec3(saturate(finalColor));
}

#ifdef NON_REALTIME_HQ_RENDER
// This function breaks the image down into blocks and scans
// through them, rendering 1 block at a time. It's for non-
// realtime things that take a long time to render.

// This is the frame rate to render at. Too fast and you will
// miss some blocks.
const float blockRate = 20.0;
void BlockRender(in vec2 fragCoord)
{
    // blockSize is how much it will try to render in 1 frame.
    // adjust this smaller for more complex scenes, bigger for
    // faster render times.
    const float blockSize = 64.0;
    // Make the block repeatedly scan across the image based on time.
    float frame = floor(iTime * blockRate);
    vec2 blockRes = floor(iResolution.xy / blockSize) + vec2(1.0);
    // ugly bug with mod.
    //float blockX = mod(frame, blockRes.x);
    float blockX = fract(frame / blockRes.x) * blockRes.x;
    //float blockY = mod(floor(frame / blockRes.x), blockRes.y);
    float blockY = fract(floor(frame / blockRes.x) / blockRes.y) * blockRes.y;
    // Don't draw anything outside the current block.
    if ((fragCoord.x - blockX * blockSize >= blockSize) ||
    	(fragCoord.x - (blockX - 1.0) * blockSize < blockSize) ||
    	(fragCoord.y - blockY * blockSize >= blockSize) ||
    	(fragCoord.y - (blockY - 1.0) * blockSize < blockSize))
    {
        discard;
    }
}
#endif

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
#ifdef NON_REALTIME_HQ_RENDER
    // Optionally render a non-realtime scene with high quality
    BlockRender(fragCoord);
#endif

    // Do a multi-pass render
    vec3 finalColor = vec3(0.0);
#ifdef NON_REALTIME_HQ_RENDER
    for (float i = 0.0; i < antialiasingSamples; i++)
    {
        const float motionBlurLengthInSeconds = 1.0 / 60.0;
        // Set this to the time in seconds of the frame to render.
	    localTime = frameToRenderHQ;
        // This line will motion-blur the renders
        localTime += Hash11(v21(fragCoord + seed)) * motionBlurLengthInSeconds;
        // Jitter the pixel position so we get antialiasing when we do multiple passes.
        vec2 jittered = fragCoord.xy + vec2(
            Hash21(fragCoord + seed),
            Hash21(fragCoord*7.234567 + seed)
            );
        // don't antialias if only 1 sample.
        if (antialiasingSamples == 1.0) jittered = fragCoord;
        // Accumulate one pass of raytracing into our pixel value
	    finalColor += RayTrace(jittered);
        // Change the random seed for each pass.
	    seed *= 1.01234567;
    }
    // Average all accumulated pixel intensities
    finalColor /= antialiasingSamples;
#else
    // Regular real-time rendering
    localTime = iTime;
    finalColor = RayTrace(fragCoord);
#endif

    fragColor = vec4(sqrt(clamp(finalColor, 0.0, 1.0)),1.0);
}

// FIELD: Shadertoy의 mainImage를 부른다. 알파는 1로 둔다(투명하게 남기면 뒤 배경이 비친다).
void main() {
    mainImage(fragColor, gl_FragCoord.xy);
    fragColor.a = 1.0;
}`;
const hexPlasma = `#version 300 es
precision highp float;
// Hexagon Plasma by Nemerix — License: MIT
// 원본: https://www.shadertoy.com/view/3fy3z3 (xscreensaver 수록본에서 옮김: https://github.com/Zygo/xscreensaver/tree/master/hacks/glx/glsl)
// Copyright (c) 2025 Nemerix. MIT 라이선스 전문은 docs/THIRD_PARTY_LICENSES.md에 있다.
//
// FIELD Studio로 옮기며 바꾼 점:
//  · Shadertoy 이름(iTime·iResolution)은 아래 #define으로 FIELD Uniform에 연결했다. mainImage는 그대로다
//  · uSpeed(시간 배속) 파라미터를 더했다
//
// 원리: 화면을 육각 격자 좌표로 바꾸고, 칸 중심까지의 거리와 시간으로 만든 무늬를 겹쳐 빛나는 선을 만든다.
uniform vec2 uResolution;
uniform float uTime;
uniform float uSpeed;  // 시간 배속(1 = 원본) · @range 0 3 @step 0.01 @default 1
out vec4 fragColor;

// Shadertoy 이름 → FIELD Uniform
#define iResolution vec3(uResolution, 1.0)
#define iTime (uTime * uSpeed)

// Title:  Hexagon Plasma
// Author: Nemerix
// URL:    https://www.shadertoy.com/view/3fy3z3
// Date:   26-May-2025
// Desc:   Heavily inspired by https://www.shadertoy.com/view/WfS3Dd
// 
// I put this together after poking at it for a few hours, to make sure I actually learned something from it. :D

// Shader by Nemerix, 2025-05-26.
// Code made available under the MIT license.

float sqr(float x) { return x*x; }

float hexSdf(in vec2 pos)
{
    return max(max(abs(dot(pos, vec2(0,2))), abs(dot(pos, vec2(1.732,1)))), abs(dot(pos, vec2(1.732,-1))));
}

float smoothSdf(in vec2 pos)
{
    return mix(sqr(hexSdf(pos)), dot(pos, pos), smoothstep(0.8, 1.5, dot(pos, pos)));
}

float sfield(in vec2 s)
{
    return s.x * s.y;
}

vec3 cmap(in vec2 pos)
{
    return mix(vec3(0.1,0.6,0.8), vec3(0.5), 0.7 * tanh(dot(pos, pos)));
}

const mat2 R = mat2(0.6, 0.8, -0.8, 0.6);

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
    
    float d = smoothSdf(uv) - 1.0;
    d = sqrt(abs(d));
    
    vec2 samp = uv * d;
    float y = 0.0;
    float scale = 1.0;
    
    for (int i = 0; i < 4; ++i)
    {
        samp = sin(R * samp * hexSdf(samp) + vec2(iTime));
        y += scale * sfield(samp);
        scale *= 0.75;
    }
    
    vec3 col = cmap(uv) / abs(y);
    col = tanh(0.1 * col);
    fragColor = vec4(col, 1);
}

// FIELD: Shadertoy의 mainImage를 부른다. 알파는 1로 둔다(투명하게 남기면 뒤 배경이 비친다).
void main() {
    mainImage(fragColor, gl_FragCoord.xy);
    fragColor.a = 1.0;
}`;
const noxFire = `#version 300 es
precision highp float;
// Nox Fire by Matt Vianueva — License: MIT
// 원본: https://www.shadertoy.com/view/wfG3Dz (xscreensaver 수록본에서 옮김: https://github.com/Zygo/xscreensaver/tree/master/hacks/glx/glsl)
// Copyright (c) 2025 Matt Vianueva. MIT 라이선스 전문은 docs/THIRD_PARTY_LICENSES.md에 있다.
// 원본 Shadertoy 페이지에는 라이선스 표기가 없고, xscreensaver가 원작자 허락을 받아 MIT로 재배포했다(아래 원본 주석).
//
// FIELD Studio로 옮기며 바꾼 점:
//  · Shadertoy 이름(iTime·iResolution)은 아래 #define으로 FIELD Uniform에 연결했다. mainImage는 그대로다
//  · uSpeed(시간 배속) 파라미터를 더했다
//
// 원리: 광선을 100번 나아가며 sin 노이즈로 깎은 터널까지의 거리를 재고, 가까울수록 밝기(1/s)를 더해 불꽃처럼 보이게 한다.
uniform vec2 uResolution;
uniform float uTime;
uniform float uSpeed;  // 시간 배속(1 = 원본) · @range 0 3 @step 0.01 @default 1
out vec4 fragColor;

// Shadertoy 이름 → FIELD Uniform
#define iResolution vec3(uResolution, 1.0)
#define iTime (uTime * uSpeed)

// Title:  Nox Fire
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/wfG3Dz
// Date:   24-May-2025
// Desc:   Nox Fire

// Relicensed as MIT License, by permission, 8-Mar-2026.

/*

    -4 from FabriceNeyret2
    
    Thanks :D !

*/

void mainImage(out vec4 o, vec2 u) {
    o = vec4(0,0,0,0);
    float i=0., d=0., s=0., n=0., t=iTime;
    vec3 p = iResolution;
    u = (u-p.xy/2.)/p.y;
    for(o*=i; i++<1e2; ) {
        // march, p = ro + rd * d, p.z += t*4;
        p = vec3(u * d, d + t*4.);
        // turbulence
        p += cos(p.z+t+p.yzx*.5)*.6;
        // modulate tunnel radius
        s = 4.+sin(t*.7)*4.-length(p.xy);
        // rotate
        p.xy *= mat2(cos(t+vec4(0,33,11,0)));
        // noise loop
        for (n = 1.6; n < 32.; n += n )
            // subtract noise from tunnel dist
            s -= abs(dot(sin( p.z + t + p*n ), vec3(1.12))) / n;
        // accumulate distance
        d += s = .01 + abs(s)*.1;
        // grayscale color
        o += 1. / s;
    }
    // o*o to increase saturation,
    // divide by d for depth
    // colorize
    o = tanh(vec4(5,2,1,1) * o * o / d / 2e6);
}


/* Original

void mainImage(out vec4 o, vec2 u) {
    float i, d, s, n, f, t=iTime;
    vec3 p = iResolution;
    u = (u-p.xy/2.)/p.y;
    for(o*=i; i++<1e2; ) {
        // march, p = ro + rd * d, p.z += t*4;
        p = vec3(u * d, d + t*4.);
        // turbulence
        p += cos(p.z+t+p.yzx*.5)*.6;
        // modulate tunnel radius
        s = 4.+sin(t*.7)*4.-length(p.xy);
        // rotate
        p.xy *= mat2(cos(t+vec4(0,33,11,0)));
        // noise loop
        for (n = .1; n < 2.;
            // subtract noise from tunnel dist
            s -= abs(dot(sin(p.z+t+p * n * 16.), vec3( .07))) / n,
            // grow noise
            n += n);
        // accumulate distance
        d += s = .01 + abs(s)*.1;
        // grayscale color
        o += 1. / s;
    }
    // o*o to increase saturation,
    // divide by d for depth
    // colorize
    o = tanh(vec4(5,2,1,1) * o * o / d / 2e6);
}

*/

// FIELD: Shadertoy의 mainImage를 부른다. 알파는 1로 둔다(투명하게 남기면 뒤 배경이 비친다).
void main() {
    mainImage(fragColor, gl_FragCoord.xy);
    fragColor.a = 1.0;
}`;

const MIT = "https://opensource.org/license/mit";
const COMMUNITY = [
  {
    id: "starnest",
    title: "Star Nest",
    tag: "Fractal · Volumetric",
    description: "공간을 접고 같은 식을 17번 되풀이하는 kaliset 프랙탈. 커서로 방향을 돌려 보세요.",
    image: starNest,
    credit: {
      author: "Pablo Roman Andrioli (Kali)",
      work: "Star Nest",
      url: "https://www.shadertoy.com/view/XlfGRj",
      license: "MIT",
      licenseUrl: MIT,
    },
  },
  {
    id: "golden",
    title: "Golden Apollian",
    tag: "Fractal · Plane marching",
    description: "겹겹의 평면마다 4D 아폴로니안 프랙탈을 잘라 그린 금빛 터널을 날아갑니다.",
    image: goldenApollian,
    credit: {
      author: "mrange",
      work: "Tunneling through golden apollian fractal II",
      url: "https://gist.github.com/mrange/86fb851ff3c073a1a81a1cf21e48b285",
      license: "CC0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
  },
  {
    id: "terrain",
    title: "Raymarched Mountains",
    tag: "Terrain · fBM · Fog",
    description: "미분 노이즈로 깎은 산맥 위를 날아갑니다. 높이·눈·하늘색을 슬라이더로 바꿔 보세요.",
    image: terrain,
    credit: {
      author: "Francisco Piaggio",
      work: "Raymarched mountains (shader-terrain-landscapes)",
      url: "https://github.com/franpiaggio/shader-terrain-landscapes",
      license: "MIT",
      licenseUrl: MIT,
    },
  },
  {
    id: "raytrace",
    title: "Ray Tracing Primitives",
    tag: "Path tracing · previous",
    description: "도형 16가지와 광선의 교차를 직접 계산하는 경로 추적. 프레임을 누적해 노이즈가 걷힙니다.",
    thumb: "raytrace",
    credit: {
      author: "Reinder Nijhoff",
      work: "Ray Tracing - Primitives",
      url: "https://www.shadertoy.com/view/tl23Rm",
      license: "MIT",
      licenseUrl: MIT,
    },
    project: {
      image: rayTracingImage,
      passes: [
        {
          name: "A",
          fragment: rayTracingBuffer,
          format: "rgba32f",
          scale: 1,
          channels: { 0: { buffer: "A", frame: "previous" } },
        },
      ],
      imageChannels: { 0: { buffer: "A", frame: "current" } },
    },
  },
  {
    id: "ocean",
    title: "Procedural Ocean",
    tag: "Water · Heightfield",
    description: "노이즈 대신 sin 파도를 겹쳐 만든 바다. 커서를 올려 둘러보세요.",
    image: ocean,
    credit: {
      author: "afl_ext",
      work: "Very fast procedural ocean",
      url: "https://www.shadertoy.com/view/MdXyzX",
      license: "MIT",
      licenseUrl: MIT,
    },
  },
  {
    id: "skyline",
    title: "Skyline",
    tag: "City · Procedural",
    description: "절차적으로 지은 도시 위를 날며 도로의 차들을 내려다봅니다. 무거운 편이에요.",
    image: skyline,
    credit: {
      author: "Otavio Good",
      work: "Skyline",
      url: "https://www.shadertoy.com/view/XtsSWs",
      license: "CC0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
  },
  {
    id: "clouds",
    title: "2D Clouds",
    tag: "Noise · fBM",
    description: "fbm 노이즈를 겹쳐 만든 흘러가는 구름. 짧고 읽기 쉬운 코드예요.",
    image: clouds2d,
    credit: {
      author: "drift",
      work: "2D Clouds",
      url: "https://www.shadertoy.com/view/4tdSWr",
      license: "Permission",
      licenseUrl: "https://www.shadertoy.com/view/4tdSWr",
    },
  },
  {
    id: "selfreflect",
    title: "Let's Self Reflect",
    tag: "Refraction · SDF",
    description: "빛이 다면체 보석 안에서 굴절하고 반사하는 길을 여러 번 따라갑니다.",
    image: selfReflect,
    credit: {
      author: "mrange",
      work: "Let's self reflect",
      url: "https://www.shadertoy.com/view/XfyXRV",
      license: "CC0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
  },
  {
    id: "stardome",
    title: "Stars and Galaxy",
    tag: "Sky · Stars",
    description: "별자리 격자와 은하수가 있는 밤하늘.",
    image: starsGalaxy,
    credit: {
      author: "mrange",
      work: "Stars and galaxy",
      url: "https://www.shadertoy.com/view/stBcW1",
      license: "CC0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
  },
  {
    id: "elementalring",
    title: "Elemental Ring",
    tag: "SDF · Glow",
    description: "꼬인 고리 둘레로 빛이 흐르는 레이마칭 장면. 커서로 시점을 바꿔 보세요.",
    image: elementalRing,
    credit: {
      author: "Otavio Good",
      work: "Elemental Ring",
      url: "https://www.shadertoy.com/view/MsVXDt",
      license: "CC0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
  },
  {
    id: "hexplasma",
    title: "Hexagon Plasma",
    tag: "2D · Hex grid",
    description: "육각 격자를 따라 흐르는 플라즈마. 57줄짜리 2D 예제.",
    image: hexPlasma,
    credit: {
      author: "Nemerix",
      work: "Hexagon Plasma",
      url: "https://www.shadertoy.com/view/3fy3z3",
      license: "MIT",
      licenseUrl: MIT,
    },
  },
  {
    id: "noxfire",
    title: "Nox Fire",
    tag: "Volumetric · Code golf",
    description: "수십 줄로 그린 볼륨 불꽃 터널. 짧게 압축된 코드를 풀어 읽어 보세요.",
    image: noxFire,
    credit: {
      author: "Matt Vianueva",
      work: "Nox Fire",
      url: "https://www.shadertoy.com/view/wfG3Dz",
      license: "MIT",
      licenseUrl: MIT,
    },
  },
];
// 읽는 순서: 처음 보는 사람이 어디부터 읽으면 되는지. at은 셰이더 안에 실제로 있는 코드(편집기에서 Ctrl+F로 찾는다).
// withReading()이 셰이더 맨 위 주석 끝(첫 uniform 앞)에 번호 목록으로 넣는다. 다중 패스는 주된 패스(Buffer A)에 넣는다.
const READING = {
  starnest: [
    {
      at: "//mouse rotation",
      text: "시선 dir을 만들고 커서 위치(a1·a2)로 돌린다. from은 시간에 따라 앞으로 나아가는 카메라 위치.",
    },
    {
      at: "for (int r=0; r<volsteps; r++)",
      text: "광선을 따라 20번(volsteps) 나아가며 그 자리의 밝기를 더한다 — 표면을 찾지 않는 부피(volumetric) 렌더링.",
    },
    {
      at: "p = abs(vec3(tile)-mod(p,vec3(tile*2.)))",
      text: "공간을 접어(tiling fold) 같은 덩어리를 끝없이 반복시킨다.",
    },
    {
      at: "p=abs(p)/dot(p,p)-formuparam",
      text: "핵심: kaliset 반복. 17번 되풀이하며 값이 요동친 양(a)을 모으면 그 자리가 별·성운처럼 밝아진다. formuparam을 0.4~0.6 사이로 바꿔 보자.",
    },
    {
      at: "v+=vec3(s,s*s,s*s*s*s)*a*uBrightness*fade",
      text: "거리(s)에 따라 색을 입히고 fade로 먼 곳을 어둡게 한다. dm은 가까운 곳을 가리는 '암흑 물질'.",
    },
  ],
  golden: [
    {
      at: "vec3 color(vec2 p, vec2 q)",
      text: "시작점(main이 부른다): 카메라가 경로 offset() 위를 날아간다. doffset(진행 방향)·ddoffset(휘는 정도)로 시선과 기울기를 만든다.",
    },
    {
      at: "vec3 color(vec3 ww, vec3 uu, vec3 vv, vec3 ro, vec2 p)",
      text: "plane marcher: 일정 간격(planeDist)의 평면을 가까운 것부터 9장 그려 alphaBlend로 겹친다. 불투명해지면(cutOff) 멈춘다.",
    },
    {
      at: "vec4 plane(",
      text: "평면 하나: 평면 번호 n의 해시로 회전·크기·효과를 고르고, df()의 거리장으로 금빛 고리와 빛 두 개의 반사·그림자를 그린다.",
    },
    {
      at: "vec2 df(vec2 p, float h)",
      text: "평면 위 2D 거리장: 육각형 틀(hex)·원(circles)과 만화경(smoothKaleidoscope)을 pmin으로 부드럽게 합친다.",
    },
    {
      at: "float apollian(vec4 p, float s)",
      text: "무늬의 정체: 4D 점을 접고(fract) 구 반전(s/r²)하기를 7번 반복하는 아폴로니안 프랙탈. weird()가 이 점을 시간에 따라 돌린다.",
    },
    { at: "vec3 postProcess(", text: "마무리: 감마, 대비(smoothstep 꼴), 채도, 가장자리 어둡게(비네팅)." },
  ],
  terrain: [
    {
      at: "void main(){",
      text: "카메라: 화면 좌표에서 광선 rd를 만들고, 커서로 yaw·pitch를 바꾼다. ro.z가 시간에 따라 늘어 앞으로 날아간다.",
    },
    {
      at: "float castRay(",
      text: "높이장 레이마칭: 광선 높이와 지형 높이의 차(h)만큼 0.4배씩 나아간다. 지형은 SDF가 아니라 높이라서 조금씩만 간다.",
    },
    {
      at: "float shapeM(",
      text: "지형 모양: noised()가 값과 미분을 같이 주고, 미분이 큰(가파른) 곳일수록 다음 옥타브를 약하게 더한다(1/(1+dot(d,d))) → 침식된 능선. warp()가 좌표를 비튼다.",
    },
    {
      at: "vec3 calcNormal(",
      text: "법선은 terrainH(11옥타브)로 더 자세히 잰다. 마칭은 7옥타브 terrainM으로 싸게 — 비싼 계산을 필요한 곳에만 쓰는 요령.",
    },
    {
      at: "float shadow(",
      text: "부드러운 그림자: 해 쪽으로 광선을 보내며 지형에 가장 가까이 스친 정도(h/t)를 그림자 진하기로 쓴다.",
    },
    {
      at: "vec3 sky(",
      text: "하늘: 높이에 따른 그라데이션 + 해 + 일정 높이 평면에 fbm2로 그린 구름. main 끝에서 거리 제곱 안개(exp(-k·t²))로 섞는다.",
    },
  ],
  raytrace: [
    {
      at: "void main() {",
      text: "Buffer A의 시작: (0,0) 픽셀에 저장한 상태(초점 거리·카메라 각도·너비)를 읽고, 카메라가 바뀌었으면 누적을 처음부터(reset).",
    },
    {
      at: "float seed = float(baseHash(",
      text: "픽셀마다 난수 씨앗을 만들고, 광선을 픽셀 안에서 흔들어(안티에일리어싱) 렌즈 위 한 점에서 쏜다(피사계 심도).",
    },
    {
      at: "vec3 render( in vec3 ro, in vec3 rd, inout float seed ) {",
      text: "경로 추적: 최대 12번(PATH_LENGTH) 튕기며 색을 곱해 간다. 재질에 따라 난반사(cosWeighted…), 금속(반사), 유리(굴절+프레넬)로 다음 방향을 고른다.",
    },
    { at: "vec3 worldhit(", text: "장면: 도형 16가지의 교차 함수를 모두 불러 opU로 가장 가까운 것을 고른다." },
    {
      at: "float iSphere(",
      text: "Common 부분의 교차 함수들: 광선과 도형의 교점을 식으로 바로 푼다(레이마칭 아님). iSphere(이차방정식) → iBox → iTorus(사차방정식) 순서로 읽으면 쉽다.",
    },
    {
      at: "fragColor = vec4(col, 1) + texelFetch(iChannel0, ivec2(fragCoord), 0);",
      text: "누적: 직전 프레임까지의 합(previous)에 이번 결과를 더한다. Image 패스가 합을 개수(w)로 나눠 평균을 보여 준다.",
    },
  ],
  ocean: [
    {
      at: "void mainImage(",
      text: "시작점: getRay로 시선을 만들고, 하늘을 보면(ray.y ≥ 0) getAtmosphere·getSun으로 하늘만 그린다.",
    },
    {
      at: "float highPlaneHit = intersectPlane(",
      text: "수면은 높이 0과 -WATER_DEPTH 사이에만 있다. 두 평면과 광선이 만나는 구간을 먼저 구하고 그 사이만 마칭한다 — 빠른 이유 ①.",
    },
    {
      at: "float raymarchwater(",
      text: "그 구간을 파도 높이(getwaves)와 비교하며 나아간다. 마칭에는 파도 12개(ITERATIONS_RAYMARCH)만 쓴다.",
    },
    {
      at: "float getwaves(",
      text: "파도 = 방향·주파수가 다른 sin 파형을 겹친 것(노이즈 없음 — 빠른 이유 ②). wavedx의 exp(sin(x)-1)이 뾰족한 마루를, DRAG_MULT가 파도끼리 끌어당기는 모양을 만든다.",
    },
    {
      at: "vec3 normal(",
      text: "법선은 파도 36개(ITERATIONS_NORMAL)로 자세히. 마칭은 거칠게, 빛 계산은 자세히 — Raymarched Mountains와 같은 요령.",
    },
    {
      at: "float fresnel =",
      text: "물빛: 프레넬로 반사(하늘·해)와 물속 산란 색을 섞고, aces_tonemap으로 밝은 부분을 눌러 마무리.",
    },
  ],
  skyline: [
    {
      at: "void mainImage(",
      text: "시작점: 고화질 옵션(NON_REALTIME_HQ_RENDER, 모션 블러·안티에일리어싱)은 꺼져 있어 RayTrace()를 한 번 부른다.",
    },
    {
      at: "vec3 RayTrace(",
      text: "전체 흐름이 여기 있다: 시간에 따라 도시 위를 나는 카메라 → 레이마칭 루프 → 맞은 재질(건물·도로·차·창문)별 색 → 반사 → 안개. 길어도 이 함수만 따라가면 된다.",
    },
    {
      at: "vec2 DistanceToObject(vec3 p)",
      text: "장면 거리장: Repeat로 도시 블록을 격자로 무한 반복하고, 블록마다 CityBlock(건물)과 도로 위 Car를 둔다. vec2로 거리와 재질 번호를 같이 돌려준다.",
    },
    {
      at: "vec2 CityBlock(vec3 p, vec2 pint)",
      text: "블록 하나: 블록 좌표의 해시로 건물 높이·폭·층을 고르고 sdBox를 겹쳐 쌓는다.",
    },
    { at: "void CalcWindows(", text: "창문: 표면 좌표를 격자로 나눠 창문 모양을 만들고, 해시로 불 켜진 창을 고른다." },
    { at: "vec3 GetEnvMapSkyline(", text: "하늘과 반사에 쓰는 환경: 하늘 그라데이션, 해, 지평선의 먼 도시 실루엣." },
  ],
  clouds: [
    { at: "vec2 hash( vec2 p ) {", text: "격자 점마다 무작위 기울기(그래디언트)를 준다." },
    { at: "float noise( in vec2 p ) {", text: "2D 그래디언트 노이즈(삼각 격자 = 심플렉스 노이즈 꼴)." },
    { at: "float fbm(vec2 n) {", text: "fbm: 옥타브마다 행렬 m으로 돌리고 키워 더한다." },
    {
      at: "//ridged noise shape",
      text: "mainImage는 같은 노이즈를 네 번 다르게 쌓는다: 능선(abs) 모양 r, 부드러운 모양 f, 색 c, 능선 색. 모두 시간(time)만큼 흘러간다.",
    },
    {
      at: "f = cloudcover + cloudalpha*f*r;",
      text: "r·f로 구름 두께를 정하고(cloudcover·cloudalpha), 하늘 그라데이션 위에 구름 색을 섞는다. 맨 위 const 값들을 바꿔 보자.",
    },
  ],
  selfreflect: [
    { at: "void mainImage(", text: "시작점: 화면 좌표로 effect()를 부른다." },
    {
      at: "vec3 effect(",
      text: "카메라와 마무리: 시선 rd를 만들어 render3()에 넘기고, ACES 톤 매핑과 감마(sqrt)로 끝낸다.",
    },
    {
      at: "vec3 render3(",
      text: "바깥 표면: 다면체에 레이마칭(rayMarch3) → 밖으로 반사(render0 = 배경)와 안으로 굴절(refract)을 프레넬(fre1)로 섞는다. 가까이 스친 정도(g_gd)로 테두리 빛도 더한다.",
    },
    {
      at: "vec3 render2(",
      text: "안쪽: 굴절해 들어간 광선이 안쪽 면(df2)에서 반사되기를 여러 번 되풀이한다 — '안쪽 거울' 효과의 핵심.",
    },
    {
      at: "vec3 shape(vec3 pos) {",
      text: "다면체 모양: poly_fold로 공간을 대칭으로 접어 면 하나만 계산하고(poly_plane·poly_edge), 나머지 면은 대칭으로 얻는다.",
    },
  ],
  stardome: [
    {
      at: "void mainImage(",
      text: "시작점: 카메라는 원점에 서서 천천히 돈다(la). 광선마다 color()로 하늘색을 구한다.",
    },
    {
      at: "vec3 color(",
      text: "하늘을 층으로 더한다: 별(stars) + 은하수(galaxy) + 달(moon) + 대기(sky) + 격자(grid). 지평선 아래는 검게.",
    },
    {
      at: "vec3 toSpherical(vec3 p) {",
      text: "시선 방향을 구면 좌표(위도·경도)로 바꾼다. 하늘의 모든 무늬가 이 좌표 위에 그려진다.",
    },
    {
      at: "vec3 stars(",
      text: "별: 구면 좌표를 칸으로 나눠 칸마다 해시로 별 위치·밝기를 정하고, blackbody(온도→색)로 색을 입힌다. 여러 크기의 칸을 겹친다.",
    },
    { at: "vec3 galaxy(", text: "은하수: fbm 높이(height)로 띠 모양 밀도를 만들어 색을 입힌다." },
  ],
  elementalring: [
    {
      at: "void mainImage(",
      text: "시작점: 고화질 옵션은 꺼져 있어 RayTrace()를 한 번 부른다(Skyline과 같은 뼈대 — 같은 작가).",
    },
    {
      at: "vec3 RayTrace(",
      text: "카메라(커서로 회전) → 레이마칭 루프. 시작 위치를 픽셀마다 조금 흔들어(Hash2d) 줄무늬를 없앤다. 광선이 고리에 가까이 지날수록 빛을 쌓아(glow) 불꽃처럼 보이게 한다.",
    },
    {
      at: "vec2 DistanceToObject(vec3 p)",
      text: "장면: 꼬인 고리. 각도에 따라 단면을 돌려(꼬임) 원환체를 만들고 smin으로 가닥을 합친다.",
    },
  ],
  hexplasma: [
    { at: "float hexSdf(", text: "육각형 거리: 세 방향(0°·60°·120°) 내적의 최댓값. 이 하나로 육각 무늬가 나온다." },
    { at: "float smoothSdf(", text: "가운데는 육각형, 바깥은 원(dot(pos,pos))으로 부드럽게 바꾼다." },
    {
      at: "for (int i = 0; i < 4; ++i)",
      text: "핵심 반복: 좌표를 회전(R)·육각 거리로 늘이고 sin으로 접기를 4번 — 접을수록 무늬가 잘게 갈라진다. y에 크기를 줄여 가며 쌓는다.",
    },
    {
      at: "vec3 col = cmap(uv) / abs(y);",
      text: "y가 0에 가까운 곳(경계)일수록 1/|y|가 커져 빛나는 선이 되고, tanh로 밝기를 눌러 날아가지 않게 한다.",
    },
  ],
  noxfire: [
    {
      at: "for(o*=i; i++<1e2; )",
      text: "광선을 100번 나아가는 레이마칭 루프 하나가 전부다. 압축된 코드라 변수 이름이 한 글자다: p = 위치, d = 간 거리, s = 터널까지 거리, o = 쌓은 색.",
    },
    { at: "p += cos(p.z+t+p.yzx*.5)*.6;", text: "난류: 위치를 cos로 흔들어 터널 벽을 일렁이게 한다." },
    { at: "s = 4.+sin(t*.7)*4.-length(p.xy);", text: "터널: 반지름이 시간에 따라 숨 쉬는 원통 안쪽까지의 거리." },
    {
      at: "for (n = 1.6; n < 32.; n += n )",
      text: "노이즈 루프: 주파수를 두 배씩 올리며 sin 무늬를 빼 벽을 불꽃처럼 깎는다(fbm과 같은 생각).",
    },
    {
      at: "o += 1. / s;",
      text: "가까울수록(s가 작을수록) 밝기를 많이 더한다 → 불꽃. 마지막 줄 tanh로 주황색을 입히고 밝기를 누른다.",
    },
  ],
};
const withReading = (source, steps) => {
  const lines = source.split("\n"),
    at = lines.findIndex(line => line.startsWith("uniform "));
  const guide = [
    "//",
    "// 읽는 순서 — 편집기에서 Ctrl+F로 앞부분을 찾아 차례로 읽어 보세요:",
    ...steps.map((step, i) => `//  ${i + 1}. ${step.at}  →  ${step.text}`),
  ];
  lines.splice(at, 0, ...guide);
  return lines.join("\n");
};
for (const item of COMMUNITY) {
  const steps = READING[item.id];
  if (!steps) continue;
  item.reading = steps;
  if (item.project) item.project.passes[0].fragment = withReading(item.project.passes[0].fragment, steps);
  else item.image = withReading(item.image, steps);
}
export { COMMUNITY };
