# 확장 기반 정비 (2026-11-01)

버퍼·유동 Uniform·성능 모니터링·디버깅 도구를 계속 붙여 나갈 때 문제가 될 구조적 약점을 먼저 정리했다.
외부 라이브러리는 여전히 없고, 새 실행 모듈은 `js/gpu-diagnostics.js` 하나다.

## 고친 문제

| 문제 | 영향 | 수정 |
| --- | --- | --- |
| **오래된 GL 오류 플래그 오인** — `gl.getError()`는 이전 호출이 남긴 오류도 돌려준다. 이미지 업로드·샘플러 변경·스크린샷·픽셀 읽기가 직전 검사 없이 이 값을 읽었다. | 셰이더가 `uniform float uFrame;`처럼 내장 Uniform을 다른 타입으로 선언하면 매 프레임 `INVALID_OPERATION`이 쌓이고, 이후 **정상 이미지 추가가 "GPU 업로드 실패"로 거부**되는 등 엉뚱한 기능이 깨졌다. | 검사 직전에 오류 플래그를 비우도록 `clearErrors()` 적용 (texture-input, pass-manager, renderer). |
| **내장 Uniform 타입 고정 업로드** — `uResolution`은 무조건 `uniform2f`, `uFrame`은 `uniform1i` 등. | 위 오류의 근원. `vec3 uResolution`, `float uFrame`, `vec4 uMouse` 같은 흔한 선언을 쓸 수 없었다. | 링크 후 `getActiveUniform()` 리플렉션으로 선언 타입을 확인해 맞는 함수로 전송. 허용 밖 타입은 업로드를 생략하고 상태줄에 경고. |
| **사용자 Uniform 타입 하드코딩** (float/int/bool/vec2~4, `switch`·`startsWith("vec")` 분기가 renderer·UI에 흩어짐) | 타입 하나 추가할 때마다 여러 파일을 고쳐야 했다. | `renderer.js`의 `UNIFORM_TYPES` 표 하나로 검증·자동 선언·업로드·UI를 구동. `uint`, `ivec2~4`, `uvec2~4`, `bvec2~4`, `mat2/3/4` 추가. |
| **벡터 Uniform을 JS 배열로 매 프레임 전송** | 드라이버 바인딩이 매번 배열을 변환한다. | 등록·변경 시 Typed Array로 한 번 기록하고 매 프레임 그대로 업로드(할당 0). |
| **GPU 메모리 부족 미감지** — Buffer Texture 할당 후 오류 확인 없음. | 고해상도 RGBA32F 여러 장에서 조용히 검은 화면. | `texImage2D` 직후 오류 확인 → 기존 FBO를 보존한 채 명확한 오류 메시지. |
| **Buffer 형식이 RGBA8/RGBA32F뿐** | 시뮬레이션용 HDR 버퍼가 항상 16B/px + 선형 필터 불가. | `rgba16f`(8B/px, 선형 필터) 추가. |
| **성능 지표가 rAF FPS뿐** | 셰이더가 실제로 GPU에서 얼마나 걸리는지 알 수 없었다. | `EXT_disjoint_timer_query_webgl2`로 **패스별 GPU 시간**(Query 풀 재사용, 비동기 수집, DISJOINT 폐기) + CPU 제출 시간·프레임 간격. HUD `GPU` 칸과 Buffer 정보에 표시. 확장이 없으면 `N/A`. |
| **마우스 버튼 상태 없음** | 클릭 기반 인터랙티브 아트 불가. | `uniform vec4 uMouse` 선언 시 `zw` = 클릭 위치, `z>0` 누르는 중, `w>0` 누른 직후 첫 프레임. `vec2` 선언은 기존 그대로. |

GPU 타이머 Query는 컨텍스트 손실 시 참조만 버리고(삭제 금지), 복구 시 확장을 다시 요청하며, `dispose()`에서 모두 삭제한다.

## 새 Renderer API

```js
shaderPlayground.getUniformTypes();      // [{type:"mat3", components:9, kind:"m"}, ...]
shaderPlayground.getShaderReflection();  // {image:{uniforms:[{name,type,size}], ignored:[...]}, passes:[...]}
shaderPlayground.setGpuTiming(false);    // GPU 타이머 끄기/켜기
shaderPlayground.getStats().gpu;         // {available, enabled, totalMs, passes:[{label, ms}]}
shaderPlayground.getStats().cpuMs;       // 프레임당 GL 명령 제출 시간(JS)
```

`getShaderReflection()`은 드라이버가 최적화로 제거한 Uniform을 포함하지 않는다. 이후 "선언됐지만 등록 안 된 Uniform 자동 감지" UI는 이 값을 그대로 쓰면 된다.

## 반영 후 해야 할 일 (이 작업 환경에서는 실행 불가)

이번 작업 환경에서는 셸 실행이 막혀 Node 테스트, 배포 번들 생성, 실제 GPU 검사를 돌리지 못했다. 개발 컴퓨터에서 아래 순서로 확인한다.

```shell
python tools/build_deploy.py          # deploy/js/min.js 재생성 (gpu-diagnostics 포함)
python tools/update_sha_manifest.py   # SOURCE_SHA256_Runtime.txt 갱신 (새 도구)
node tests/runtime-integrity.js
node tests/architecture-regression.js
node tests/sampling-regression.js
node tests/logic-regression.js
node tests/deep-regression.js
```

이어서 `python -m http.server 8000 --bind 127.0.0.1` 후 `http://127.0.0.1:8000/tests/gpu-validation.html`에서 실제 GPU 검사를 실행한다. 25~29번이 이번 변경 검사다(확장 타입 Uniform, RGBA16F, 타입 불일치 시 GL 오류 없음, `uMouse` vec4, GPU 타이머).

## 테스트 쪽 변경

- `tests/architecture-regression.js`: Renderer 팩토리에 세 번째 의존성(`gpu-diagnostics`) 전달.
- `tests/sampling-regression.js`: "이전 오류는 무시, 적용 중 오류만 실패"를 검사하도록 오류 주입 시점을 `texParameteri` 안으로 옮김.
- `tests/runtime-integrity.js`: 실행 파일 수 12 → 13.
