// 다른 사람이 공개한 셰이더를 FIELD Studio로 옮긴 갤러리 예제. 갤러리의 "커뮤니티 셰이더" 칸에 나온다.
// 넣는 기준: 원작자가 작품에 MIT·CC0처럼 재배포를 허락하는 라이선스를 직접 밝힌 것만.
// (Shadertoy 기본 라이선스는 CC BY-NC-SA 3.0이고, 원작자가 "재배포 금지"를 붙인 작품도 있다 — 예: Inigo Quilez의 작품 장면들.)
// 셰이더 맨 위의 원작자·라이선스 주석은 지우지 않는다. 라이선스 전문은 docs/THIRD_PARTY_LICENSES.md에 있다.
// credit: { author, work(원래 제목), url, license, licenseUrl } — 갤러리 카드와 가이드에 그대로 보인다.
const p = (name, type, value, options = {}) => ({ name, type, value, options });
const color = { color: true };

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
uniform float uSpeed;
uniform float uBrightness;
uniform float uDarkMatter;
uniform float uSaturation;
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
uniform float uSpeed;
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
uniform float uHeight;      // 산 높이(원본 H)
uniform float uSnow;        // 눈이 쌓이기 시작하는 높이(0~1)
uniform float uExposure;    // 노출(원본 uExp)
uniform float uSeed;        // 지형 고르기
uniform vec3 uSunCol;
uniform vec3 uSky1;         // 지평선 쪽 하늘
uniform vec3 uSky2;         // 천정 쪽 하늘
uniform vec3 uFogC;
out vec4 fragColor;
#define H uHeight
#define uExp uExposure
const vec3 uSunDir = vec3(-0.95, 0.28, 0.20);

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
// 원본: https://www.shadertoy.com/view/tl23Rm · 바꾼 점과 출처는 Buffer A 머리말에 있다.
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
    users: [
      p("uSpeed", "float", 0.01, { min: 0, max: 0.05, step: 0.0005 }),
      p("uBrightness", "float", 0.0015, { min: 0.0002, max: 0.004, step: 0.0001 }),
      p("uDarkMatter", "float", 0.3, { min: 0, max: 1, step: 0.01 }),
      p("uSaturation", "float", 0.85, { min: 0, max: 1, step: 0.01 }),
    ],
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
    users: [p("uSpeed", "float", 1, { min: 0, max: 3, step: 0.01 })],
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
    users: [
      p("uHeight", "float", 16, { min: 4, max: 30, step: 0.1 }),
      p("uSnow", "float", 0.55, { min: 0, max: 1, step: 0.01 }),
      p("uExposure", "float", 1, { min: 0.2, max: 2, step: 0.01 }),
      p("uSeed", "float", 0, { min: 0, max: 100, step: 1 }),
      p("uSunCol", "vec3", [1, 0.92, 0.7], color),
      p("uSky1", "vec3", [0.34, 0.56, 0.9], color),
      p("uSky2", "vec3", [0.06, 0.18, 0.46], color),
      p("uFogC", "vec3", [0.55, 0.66, 0.82], color),
    ],
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
];
export { COMMUNITY };
