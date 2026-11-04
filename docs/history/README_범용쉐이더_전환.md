# 범용 Shader Art 전환 검증 (2026-10-14)

## 변경
- 시작 화면: Ray Marching 대신 uTime/uMouse 기반 범용 절차적 Fragment Shader.
- Render 패널: Ray Marching 반복 횟수/거리/epsilon과 Heatmap 컨트롤 제거. FPS/해상도/멀티패스는 유지.
- Studio > STARTER PROJECTS: **Ray Marching · SDF**. SDF GLSL, 5개 사용자 Uniform(반복 횟수, 최대거리, 두 epsilon, 단계 Heatmap) 준비. 값은 Uniforms > Custom에서 수정.
- 기존 Ray Marching 전역 Uniform·설정 API와 저장 포맷은 기존 프로젝트/Pack 호환성을 위해 내부에 유지. 이전 소스·Pack을 강제로 변환하거나 삭제하지 않음.
- Orbit 카메라 uCameraOrbit는 3D Shader Art에서도 사용 가능하므로 Optional input으로 유지.
- 나머지 Feedback / Fire / 프로젝트 내보내기 및 기본 편집 기능 유지.

## 직접 테스트
1. 기존 프로젝트를 백업하고 새 폴더에서 index.html 열기. 저장된 이전 프로젝트가 없는 브라우저에서는 색상 파형 아트가 기본으로 표시됨.
2. Render 탭에 Ray 전용 영역이 없고 FPS/해상도/Buffer만 있는지 확인.
3. E > STARTER PROJECTS > Ray Marching · SDF 클릭. 카메라 시작 시점 복구 및 장면 적용 후 Uniforms > Custom에 uRMMaxSteps, uRMMaxDistance, uRMSurfaceEpsilon, uRMNormalEpsilon, uRMHeatmap 확인.
4. uRMHeatmap을 켰을 때 단계 컬러 디버그 출력 확인. uRMMaxSteps 값을 조절해 장면 변화 확인.
5. Restore shader art를 눌러 범용 GLSL 복귀. 이전 프로젝트 Import/Pack이 계속 로딩되는지 확인.

## 자동 검사
- `node tests/default-template-regression.js`
- `node tests/architecture-regression.js`
- `node tests/shader-art-starter-regression.js`
- `python tests/shader-art-browser-regression.py` (Playwright 사용, 개발용 검사만 외부 라이브러리 허용)
- 기존 GPU 검사는 `tests/gpu-validation.html`에서 별도로 수행.
