# Texture Sampling 패치

이 패치는 GPU Validation 버전에 이미지별 Filtering과 Wrapping 설정을 추가합니다. `index.html`을 열고 Shader Studio의 **LOCAL TEXTURES**에서 등록된 이미지 아래 설정을 변경합니다.

- **Filter**: `Linear`(기본, 부드러운 보간) 또는 `Nearest`(가까운 한 텍셀, 픽셀 아트).
- **Wrap X / Wrap Y**: `Clamp`(기본, 가장자리 유지), `Repeat`(주기적 반복), `Mirror`(교대 반전 반복).
- 새 이미지뿐 아니라 이미 등록한 이미지에도 적용됩니다. 값 변경에는 GLSL 재컴파일이나 이미지 재업로드가 필요하지 않습니다.
- 한 이미지의 설정은 그 이미지를 참조하는 **모든 iChannel**에서 공유됩니다. 패스별 독립 샘플러는 이 버전의 범위 밖입니다.
- 원본 이미지와 설정은 IndexedDB에 함께 저장하며, 기존에 저장된 이미지(설정 필드 없음)는 이전과 동일한 Linear/Clamp 기본값으로 불러옵니다.
- 저장소 접근이 불가능하면 세션 중 GPU 설정은 적용되지만 재시작 후 저장은 보장되지 않습니다.
- Wrap의 차이를 눈으로 확인하려면 UV에 배율을 곱하세요. `texture(iChannel0, uv * 3.0)`은 Repeat에서 3회 타일링됩니다. `texelFetch`에는 Filter/Wrap이 적용되지 않습니다.
- Mipmap/Anisotropic Filtering은 포함하지 않습니다. Min/Mag 모두 Nearest 또는 Linear로 설정합니다.

## JavaScript API

```javascript
const r = window.shaderPlayground;
await r.setTextureSampling("tex1", {filter:"nearest", wrapS:"repeat", wrapT:"mirror"});
console.log(r.getTextures()[0].sampling);
```

## 검증

`node tests/architecture-regression.js`, `node tests/texture-regression.js`, `node tests/sampling-regression.js`를 실행할 수 있습니다. 실제 GPU 검사는 브라우저에서 `tests/gpu-validation.html`을 열고 실행 버튼을 클릭하세요. `Texture Wrap X` 검사는 Clamp/Repeat에 따른 픽셀색 변화를 확인합니다. GPU 드라이버 결과는 사용자 환경에서 확인해야 합니다.
