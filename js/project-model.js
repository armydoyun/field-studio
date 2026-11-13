// 프로젝트(Image + Buffer 패스 + 채널 연결) 데이터 규칙. DOM·GPU에 의존하지 않는 순수 함수만 둔다.
// 프로젝트 모양: {image:GLSL, common?:GLSL, passes:[{name, fragment, format, scale, channels, size?, outputs?, filter?, wrap?, mipmap?}], imageChannels:{0..3: ref}}
// 채널 ref: {texture:id} 또는 {buffer:이름, frame:"current"|"previous", attachment?:출력 번호}
// common: 모든 패스(Image · Buffer) 앞에 붙는 공용 코드(Common 탭). 없으면 Common 탭도 없다.
// 패스 이름 "Image"와 "Common"은 탭 이름이라 Buffer 이름으로 쓸 수 없다.

const MAX_PASSES = 8,
  MAX_SOURCE = 262144;

// JSON으로 옮길 수 있는 값(객체·배열·원시값)의 깊은 복사
const copy = x =>
  x && typeof x === "object"
    ? Array.isArray(x)
      ? x.map(copy)
      : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, copy(v)]))
    : x;
// 깊은 비교(키 순서 무관)
const same = (a, b) =>
  a === b ||
  !!(
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    Array.isArray(a) === Array.isArray(b) &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(k => Object.hasOwn(b, k) && same(a[k], b[k]))
  );

// 저장소·파일·외부 예제에서 온 프로젝트를 검사하고 복사본을 돌려준다. 세부 GPU 제약(채널 순서·해상도 범위)은 Renderer가 다시 검증한다.
const validateProject = candidate => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("프로젝트는 객체여야 합니다.");
  // #version 300 es는 쓰지 않아도 된다(없으면 renderer가 컴파일 직전에 붙인다 — glsl-prepare.js).
  if (typeof candidate.image !== "string" || !candidate.image.trim() || candidate.image.length > MAX_SOURCE)
    throw new Error("Image GLSL 소스가 올바르지 않습니다.");
  if (candidate.common !== undefined && (typeof candidate.common !== "string" || candidate.common.length > MAX_SOURCE))
    throw new Error("Common GLSL 소스가 올바르지 않습니다.");
  if (!Array.isArray(candidate.passes) || candidate.passes.length > MAX_PASSES)
    throw new Error("버퍼는 최대 8개입니다.");
  const names = new Set();
  for (const p of candidate.passes) {
    if (
      !p ||
      typeof p.name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(p.name) ||
      p.name === "Image" ||
      p.name === "Common" ||
      names.has(p.name) ||
      typeof p.fragment !== "string" ||
      !p.fragment.trim() ||
      p.fragment.length > MAX_SOURCE
    )
      throw new Error("Buffer 이름 또는 GLSL 소스를 확인하세요.");
    if (
      !["rgba8", "rgba16f", "rgba32f"].includes(p.format) ||
      !Number.isFinite(p.scale) ||
      p.scale < 0.125 ||
      p.scale > 1 ||
      !p.channels ||
      typeof p.channels !== "object" ||
      Array.isArray(p.channels)
    )
      throw new Error(`${p.name}: Buffer 속성이 올바르지 않습니다.`);
    // 선택 항목(고정 해상도·출력 수·샘플링)은 모양만 확인하고 세부 범위는 Renderer가 검증한다.
    if (
      (p.size !== undefined && !(Array.isArray(p.size) && p.size.length === 2)) ||
      (p.outputs !== undefined && !Number.isInteger(p.outputs)) ||
      (p.filter !== undefined && typeof p.filter !== "string") ||
      (p.wrap !== undefined && typeof p.wrap !== "string") ||
      (p.mipmap !== undefined && typeof p.mipmap !== "boolean")
    )
      throw new Error(`${p.name}: Buffer 선택 속성(size/outputs/filter/wrap/mipmap)이 올바르지 않습니다.`);
    names.add(p.name);
  }
  if (!candidate.imageChannels || typeof candidate.imageChannels !== "object" || Array.isArray(candidate.imageChannels))
    throw new Error("Image 채널 연결이 올바르지 않습니다.");
  return copy(candidate);
};

// 모든 패스의 채널 묶음(버퍼 패스들 + Image)
const channelGroups = project => [...project.passes.map(pass => pass.channels), project.imageChannels];

// name 버퍼를 읽는 다른 패스의 채널 목록: ["B.iChannel0", "Image.iChannel1"]
const references = (project, name) =>
  [...project.passes, { name: "Image", channels: project.imageChannels }]
    .filter(p => p.name !== name)
    .flatMap(p =>
      Object.entries(p.channels)
        .filter(([, ref]) => ref.buffer === name)
        .map(([channel]) => `${p.name}.iChannel${channel}`)
    );

// current(이번 프레임)는 실행 순서상 앞서 실행된 버퍼만 읽을 수 있다. Image는 모든 버퍼 뒤에 그려지므로 무엇이든 읽는다.
const validCurrent = (project, target, buffer) =>
  target === "Image" ||
  project.passes.findIndex(p => p.name === buffer) < project.passes.findIndex(p => p.name === target);

// 순서를 바꾼 뒤 더 이상 앞서지 않는 버퍼를 current로 읽던 채널을 previous로 바꾼다(project를 직접 고친다). 바뀐 연결 목록을 돌려준다.
const normalizeDependencies = project => {
  const changed = [];
  for (const p of project.passes)
    for (const [channel, ref] of Object.entries(p.channels)) {
      if (ref.frame === "current" && !validCurrent(project, p.name, ref.buffer)) {
        changed.push(`${p.name}.iChannel${channel} ← ${ref.buffer}`);
        p.channels[channel] = { ...ref, frame: "previous" };
      }
    }
  return changed;
};

// available(이미지 id Set)에 없는 이미지 연결을 지운다(project를 직접 고친다). 지운 개수를 돌려준다.
const detachMissing = (project, available) => {
  let count = 0;
  for (const channels of channelGroups(project))
    for (const key of Object.keys(channels))
      if (channels[key].texture && !available.has(channels[key].texture)) {
        delete channels[key];
        count++;
      }
  return count;
};

export {
  MAX_PASSES,
  MAX_SOURCE,
  copy,
  same,
  validateProject,
  channelGroups,
  references,
  validCurrent,
  normalizeDependencies,
  detachMissing,
};
