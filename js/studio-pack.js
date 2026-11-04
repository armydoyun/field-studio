// Pack 파일 형식(소스 + 연결된 이미지 원본 + 설정). 렌더러·화면과 무관한 부분만 둔다.
// 불러오기 순서(사전 검사 → 확인 → 이미지 등록 → 적용 → 실패 시 되돌리기)는 studio.js가 맡는다.
import * as Model from "./project-model.js";

const MiB = 1024 * 1024;
const LIMITS = {json:16 * MiB, pack:64 * MiB, images:32 * MiB, image:12 * MiB, base64:16 * MiB + 8, count:36};
const TYPES = ["image/png", "image/jpeg", "image/webp"];

// 프로젝트가 연결한 이미지 ID 목록(중복 없음, 처음 나온 순서).
const textureIds = project => {
  const ids = new Set();
  for(const channels of Model.channelGroups(project)) for(const ref of Object.values(channels)) if(ref.texture) ids.add(ref.texture);
  return [...ids];
};

// 이미지 파일 → data: URL
const readData = file => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("이미지를 읽을 수 없습니다.")); reader.readAsDataURL(file);
});

// 내보낼 이미지 묶음을 고른다. 원본이 없거나 합계가 32MB를 넘으면 오류.
// assets: renderer.getTextures(), fileOf(id): renderer.getTextureFile(id)
const collectTextures = (project, assets, fileOf) => {
  let bytes = 0;
  return textureIds(project).map(id => {
    const meta = assets.find(item => item.id === id), file = fileOf(id);
    if(!meta || !file) throw new Error(`원본 이미지가 없습니다: ${id}`);
    bytes += file.size; if(bytes > LIMITS.images) throw new Error("연결된 이미지 합계는 최대 32MB입니다.");
    return {id, meta, file};
  });
};

// settings가 있으면 version 3(파라미터·설정 포함), 없으면 version 2.
const encode = ({project, selected, textures, settings = null}) =>
  JSON.stringify({version:settings ? 3 : 2, project, selected, textures, ...(settings ? {settings} : {})});

// Pack 텍스트를 읽어 형식을 검사한다. 이미지는 아직 풀지 않는다.
const parse = text => {
  const data = JSON.parse(text), project = Model.validateProject(data.project);
  if(![2, 3].includes(data.version) || !Array.isArray(data.textures) || data.textures.length > LIMITS.count) throw new Error("지원하지 않는 Pack 형식입니다.");
  return {data, project};
};

// Pack의 이미지 항목을 File로 푼다. 이름·형식·base64·크기 제한을 모두 검사한다.
const decodeTextures = textures => {
  const ids = new Set(), decoded = []; let total = 0;
  for(const asset of textures) {
    if(!asset || typeof asset.id !== "string" || !/^[A-Za-z][\w-]{0,31}$/.test(asset.id) || ids.has(asset.id)
      || typeof asset.name !== "string" || asset.name.length > 128 || !TYPES.includes(asset.type)
      || typeof asset.data !== "string" || !asset.data.startsWith(`data:${asset.type};base64,`)) throw new Error("Pack 이미지 정보가 올바르지 않습니다.");
    ids.add(asset.id); const body = asset.data.slice(asset.data.indexOf(",") + 1);
    if(body.length > LIMITS.base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) throw new Error("Pack 이미지 데이터가 올바르지 않습니다.");
    const binary = atob(body); total += binary.length;
    if(binary.length > LIMITS.image || total > LIMITS.images) throw new Error("Pack 이미지 크기 제한을 초과했습니다.");
    const bytes = new Uint8Array(binary.length); for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    decoded.push({id:asset.id, file:new File([bytes], asset.name, {type:asset.type}), sampling:asset.sampling});
  }
  return {ids, decoded};
};

// 프로젝트가 읽는 이미지가 모두 Pack에 들어 있는지 확인한다.
const checkReferences = (project, ids) => {
  for(const id of textureIds(project)) if(!ids.has(id)) throw new Error(`Pack에 연결된 이미지가 없습니다: ${id}`);
};

// 이미지 연결을 뺀 복사본. Pack의 이미지 ID는 등록 전에는 없으므로 사전 컴파일 검사에 쓴다.
const withoutTextures = project => {
  const trial = Model.copy(project);
  for(const channels of Model.channelGroups(trial)) for(const key of Object.keys(channels)) if(channels[key].texture) delete channels[key];
  return trial;
};

// Pack의 이미지 ID를 새로 등록한 ID로 바꾼다(제자리 수정).
const remapTextures = (project, map) => {
  for(const channels of Model.channelGroups(project)) for(const ref of Object.values(channels)) if(ref.texture) ref.texture = map.get(ref.texture);
  return project;
};

export {LIMITS, textureIds, readData, collectTextures, encode, parse, decodeTextures, checkReferences, withoutTextures, remapTextures};
