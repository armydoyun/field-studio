# 파라미터 UX · 버퍼 시각화 · 고급 버퍼 기능 (2026-11-01)

새 실행 모듈: `js/annotations.js`(GLSL 주석 파서, DOM·GPU 비의존).

## 1. 파라미터 UX

- **컬러 피커**: vec3/vec4 파라미터에 `color` 옵션을 켜면 색상 선택기로 편집한다(값 0~1을 그대로 8bit로 표시, 감마 변환 없음). vec4는 알파 슬라이더가 추가된다. 파라미터 추가 폼의 “색상 선택기로 표시”로도 켤 수 있다.
- **벡터 슬라이더**: 범위(min/max/step)를 float·int·uint **벡터**에도 지정할 수 있다. 성분마다 슬라이더 + 숫자 입력.
- **GLSL 주석 어노테이션**: 선언과 같은 줄의 주석으로 파라미터를 정의한다. 컴파일이 성공하면 자동 반영된다.

```glsl
uniform float uSpeed;  // @range 0 4 @step 0.01 @default 1.5
uniform vec3  uTint;   // @color @default 0.9 0.3 0.6
uniform vec2  uOffset; // @range -1 1 @default 0
uniform int   uCount;  // @min 1 @max 32 @default 8
```

  - 미등록 Uniform은 새로 등록(@default 또는 범위 안의 0, color는 1), 이미 등록된 것은 **옵션만 갱신**하고 값은 새 범위로 보정한다.
  - 여러 개를 한 번의 재컴파일로 처리하며, 결과는 상태줄에 “@어노테이션 등록/범위 갱신”으로 표시된다. Undo 기록에 포함된다.
  - 태그: `@range min max [step]`, `@min`, `@max`, `@step`, `@default v…`(값 하나면 모든 성분), `@color`.

## 2. 버퍼 시각화 · 디버깅 (성능 탭 → 버퍼 뷰어)

- 모든 패스 **출력별 실시간 썸네일**(약 0.3초 간격, 탭이 보일 때만). 누르면 뷰포트에 그 출력을 표시하고, 다시 누르면 Image로 돌아간다.
- **채널 분리**(RGB / R / G / B / A)와 **노출**(×1/256 ~ ×256)로 HDR·작은 값·알파를 확인. 미리보기와 썸네일에 함께 적용된다.
- **포인터 위치의 실제 값**: 미리보기 중인 버퍼 위에 포인터를 올리면 float 버퍼의 음수·HDR 값까지 그대로 읽는다(80ms 간격).
- Renderer API: `captureBufferThumbnails(maxWidth)`, `setPreviewPass(name, attachment)`, `setPreviewOptions({channel, exposure})`, `readPassPixel(name, x, y, attachment)`.

## 3. 고급 WebGL2 버퍼 기능 (편집기에서 Buffer 탭 선택 시 도구 줄)

| 항목 | 설명 |
| --- | --- |
| **Size** | 화면 비율(100%~12.5%) 또는 **고정 해상도**(64²~1024², JSON에서는 `size:[w,h]` 최대 8192). 시뮬레이션 상태 저장에 적합. |
| **Out (MRT)** | 패스당 출력 1~4개. GLSL에서 `layout(location = N) out vec4 …;`로 쓴다. 다른 패스는 채널 선택에서 `A[1] · current`처럼 출력 번호를 고른다(`{buffer, frame, attachment}`). 출력 수를 줄이면 사라진 출력을 읽던 연결은 0번으로 되돌린다. |
| **Filter** | linear / nearest. RGBA32F의 linear는 `OES_texture_float_linear`가 필요(없으면 명확한 오류). |
| **Wrap** | clamp / repeat / mirror — 타일링·토러스 시뮬레이션용. |
| **Mip** | 렌더링할 때마다 밉맵 생성. `textureLod`·저비용 블러에 사용(메모리 +33%). |

- 기본값(비율 100%, 출력 1, 형식별 필터, clamp, 밉맵 없음)은 기존과 동일하며, 프로젝트 JSON에는 기본값과 다른 항목만 저장된다. 이전 프로젝트는 그대로 열린다.
- filter/wrap 변경은 기존 텍스처에 샘플러만 다시 적용하므로 피드백 누적 결과가 유지된다. size/outputs/mipmap/format 변경은 텍스처를 새로 만든다.
- 버퍼 메모리 표시는 출력 수와 밉맵을 포함해 계산한다.

## 검증

- Live Server(개발 ESM 버전)에서 확인: 어노테이션 자동 등록·범위 갱신, 컬러 피커·벡터 슬라이더, 256² 고정 + 출력 2개 + repeat + mipmap 패스(출력별 픽셀 값·메모리 계산·썸네일 2개·출력 1 미리보기)가 정상 동작.
- `tests/gpu-validation.html`에 30~34번 추가: MRT, 고정 해상도/iChannelResolution, wrap clamp↔repeat, 밉맵 평균, 썸네일 + 채널/노출 옵션.
