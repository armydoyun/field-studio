# Starter 프로젝트와 선택적 Orbit 카메라 · 2026-10-15

## 동작 정책

Starter 선택은 새 프로젝트 시작이다. 기존 Custom Uniform을 병합하지 않고 새 Starter의 목록으로 교체한다. 기존 GPU 프로그램과 Uniform을 먼저 지우지는 않으며 새 프로젝트가 컴파일된 후 함께 교체한다. 실패하면 이전 상태를 유지한다.

| Starter | 새 Custom Uniform |
| --- | --- |
| 기본 Shader Art 복원 | 없음 |
| Feedback | 없음 |
| Fire | 없음 |
| Ray Marching | uCameraOrbit(vec3), uRMMaxSteps, uRMMaxDistance, uRMSurfaceEpsilon, uRMNormalEpsilon, uRMHeatmap |

Ray Starter를 다시 선택하면 이전에 조정한 값도 프리셋 기본값으로 초기화한다. Starter 전환은 Undo/Redo로 소스와 Custom 목록/값을 함께 되돌린다. 일반 코드 편집의 Undo는 별도로 조절한 현재 Custom 값을 되돌리지 않는다.

## 카메라의 소유권

uCameraOrbit을 Input.mount에서 Required로 자동 등록하던 코드를 제거했다. 기본 Shader Art는 카메라 Uniform 없이 시작한다. Renderer가 카메라를 필수로 요구하지 않는다.

- Shader.rayUniforms가 Ray 프로젝트의 Custom 목록을 정의한다.
- Shader.orbitHome이 Ray 프리셋의 초기 카메라 위치를 한곳에서 정의한다.
- main은 orbitHome을 Input에 전달한다. 이 과정은 Uniform을 만들거나 셰이더를 재컴파일하지 않는다.
- Input은 Custom에 vec3 uCameraOrbit이 있을 때만 카메라 값을 읽고 변경한다.
- 해당 값이 없거나 다른 타입이면 getCamera는 null, setCamera/resetCamera는 false를 반환한다.
- 카메라 없는 프로젝트에서도 일반 onKey/onDrag 입력 API는 유지된다.
- 키 이동 도중 카메라가 제거되어도 다음 프레임에서 안전하게 멈춘다.
- UI Reset camera 버튼은 사용 가능한 카메라가 없으면 비활성화한다.

Required 등록 API는 다른 확장 기능을 위해 유지하지만 앱 시작 시 uCameraOrbit을 등록하지 않는다. uResolution/uTime/uMouse/iChannel 등 엔진 내장 전달 경로는 그대로 사용한다. 새로운 카메라 매니저나 입력 플러그인 프레임워크는 추가하지 않았다.

## 이전 저장 데이터

기존 localStorage 설정 및 설정을 포함한 v3 Pack의 required.uCameraOrbit을 사용자 vec3 값으로 옮긴다. 기존 Custom uCameraOrbit이 있으면 그 값을 우선하고 중복 등록하지 않는다.

이전 Custom이 이미 64개이면 카메라를 추가로 이관할 슬롯이 없다. 이 경우 값을 임의로 버리거나 기존 저장 설정을 기본값으로 덮어쓰지 않는다. 저장소 원본을 보존하고 복원 중단 메시지를 표시한다. 사용자가 명시적으로 새 Starter를 선택하거나 설정을 초기화하면 새 상태로 저장할 수 있다. 이전 Pack의 이관 실패도 GPU 적용 전에 거부한다.

카메라 값 자체가 없는 구형 JSON/v2 Pack에서 사라진 과거 카메라 값을 추측해서 복원하지는 않는다. 새 프로젝트는 Ray Starter로 시작하거나 Custom vec3 uCameraOrbit을 직접 등록하면 선택적 입력을 사용할 수 있다.

## 파일별 변경 방식

| 파일 | 방식 | 위치 |
| --- | --- | --- |
| js/studio.js | 특정 부분 수정 | replaceProject/startProject, Starter 3개와 기본 복원, historyState/recordEdit/historyMove/apply, Pack Undo 상태 |
| js/input.js | 특정 부분 수정 | mount 인자, Required 등록 제거, readCamera/getCamera/setCamera, 키·드래그·휠 조건 |
| js/shader.js | 특정 부분 수정 | orbitHome, rayUniforms에 카메라 추가, 반환 값 |
| js/main.js | 특정 부분 수정 | Input.mount에 카메라 프리셋 기본 위치 전달 |
| js/settings.js | 특정 부분 수정 | migrateCamera, load/validatePack/applyPack, 이관 실패 원본 보호 및 명시적 저장 |
| js/ui.js | 특정 부분 수정 | updateStats에서 카메라 Reset 활성 여부 |
| index.html | 특정 부분 수정 | Optional orbit camera 안내 문구 |
| tests/starter-ownership-regression.js | 신규 생성 | Starter/Undo/입력/이관 20개 검사 |
| 기존 관련 테스트 | 특정 부분 수정 | 카메라 Custom 소유 및 Ray 6개 목록 계약 반영 |
| 그 외 실행 소스 | 수정 없음 | Renderer/PassManager/TextureInput/CodeEditor/CSS/로더 |

## 검증

- starter-ownership-regression.js: 20개 통과.
- logic-regression.js: 19개, deep-regression.js: 34개, architecture-regression.js: 44개 유지.
- Node 회귀 검사 묶음, 실행 JS 문법·AMD 연결·SHA-256 무결성 검사.
- 브라우저 테스트의 Renderer 모의 API와 GPU 검사 페이지를 새 계약에 맞췄다.
- 실제 브라우저와 GPU에서 실행한 검증 결과는 아니다.

```bash
node tests/starter-ownership-regression.js
node tests/logic-regression.js
node tests/deep-regression.js
node tests/architecture-regression.js
node tests/runtime-integrity.js
```
