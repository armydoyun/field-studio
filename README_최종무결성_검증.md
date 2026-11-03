# Shader Studio — 최종 안정성 보강 및 원본 무결성 검증

기준: `raymarch_shader_studio_lightweight_complete.zip` (경량화 통합본)

## 변경 원칙
- 기존 Shader Studio 기능·UI·GLSL·프로젝트 저장 형식 유지.
- 실행 필수 13개 파일 중 **`js/renderer.js`, `js/pass-manager.js`만 수정**.
- 기능을 추가하지 않고 **실패 경로의 GPU 리소스 해제 및 롤백**을 보강.
- 테스트 파일과 검증표는 인쇄용 Runtime에 포함하지 않음.

## 실질 수정
1. **Pack 적용 실패 시 Uniform/프로그램 일관성**: `applyPortable`이 Image 프로그램을 새 사용자 Uniform 구성을 기준으로 다시 만든 뒤 Buffer 단계에서 실패해도, 같은 GLSL 텍스트라는 이유로 복원 컴파일을 건너뛰지 않게 함. 기존 사용자 Uniform과 원래 GPU Image 프로그램을 함께 복구.
2. **Buffer GLSL 교체 및 전체 패스 생성 시 누수 예방**: GPU 프로그램 컴파일 성공 후 Uniform 위치 조회가 실패하더라도 새 프로그램을 정리.
3. **Context 복구 시 누수 예방**: PassManager가 Context 복구 중 Uniform 위치를 읽지 못하면 해당 신규 프로그램을 해제하고 이전에 생성한 신규 프로그램도 정리.
4. **Image GLSL 교체 시 누수 예방**: 프로그램 링크 성공 후 Uniform 위치 조회가 실패하면 기존 Image 상태를 보존하고 새 프로그램을 해제.

## 확인한 테스트
- `node tests/architecture-regression.js` → **41개** (GPU 실패 주입 신규 6개 포함)
- `node tests/custom-modal-regression.js` → **17개**
- `node tests/pack-settings-freeze.js` → **9개**
- `node tests/texture-regression.js`
- `node tests/sampling-regression.js`
- `node tests/default-template-regression.js`
- `node tests/ui-matte-regression.js`
- `node tests/runtime-integrity.js` → **13개 실행 파일 SHA-256 + AMD 10개 의존성/인자 수/순환 + HTML ID 확인**
- `python tests/undo-browser-regression.py`
- `python tests/undo-cursor-regression.py`
- `node --check js/*.js` (파일별 실행)

위 검사들은 이 산출물의 작성 환경에서 통과함. **모의 WebGL 테스트나 브라우저 DOM 테스트는 실제 GPU 드라이버 테스트를 대체하지 않음.** 마지막 필사 전에 본인 PC의 Chrome/Edge에서 `tests/gpu-validation.html`을 열어 지원 가능 항목의 성공을 확인하고, Shader Studio의 기본 장면과 Buffer/이미지/Pack 저장복원을 직접 시험할 것을 권장함.

## 무결성 검증
- `SOURCE_SHA256_Runtime.txt`: 직접 옮겨 적어야 할 13개 실행 파일의 고정 해시.
- `node tests/runtime-integrity.js`: 현재 디렉터리의 13개 파일을 manifest와 SHA-256 대조, AMD 모듈 의존성 및 DOM ID 확인. npm 불필요.
- `SHA256_파일검증.txt`: 전체본에 포함된 소스·테스트·문서의 SHA-256 (검증표 자기 자신은 제외).
- 패치 ZIP에는 원본 경량화본 대비 변경 파일과 새 검증 도구를 수록하며, 전체본에 덮어썼을 때 동일한 결과가 되도록 구성.

**결론**: 코드 복원 무결성 및 주요 실패 경로에 대해 검증을 확장한 기준본. 모든 브라우저, GPU, 파일 저장소 조합에서 오류가 절대 없다는 보증은 아님.
