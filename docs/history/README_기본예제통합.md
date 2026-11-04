# 시작 셰이더 4개 파일 통합

기존 `js/shaders/geometry.js`, `scene.js`, `raymarch.js`, `render.js`를 **`js/shader.js`의 단일 기본 GLSL**로 통합했습니다.
AMD의 네 외부 의존성을 제거하고, 시작용 도형·장면·광선 추적·카메라·출력 코드를 한 파일에 배치했습니다. 기본 Vertex Shader와 엔진에서 요구하는 Header도 같은 파일 안에 있습니다.

- **실행 시**: `js/main.js`는 예전과 동일하게 `shader` AMD 모듈만 불러옵니다.
- **사용자가 편집할 때**: Shader Studio 안에서 원하는 GLSL을 작성하며, 기본 템플릿을 직접 수정할 필요는 없습니다.
- **새 프로젝트 초기화 시**: 동일한 기본 3D 장면으로 복원됩니다.
- **주의**: 다른 셰이더 모듈을 임의로 Import해서 실행하는 구조가 아니므로 기본 예제만 한 파일로 합친 것입니다. GPU 처리, 버퍼, Texture, UI는 변경하지 않았습니다.
- **검증**: `node tests/default-template-regression.js`는 네 섹션의 존재, 독립 AMD 모듈 여부, 기존 GLSL 원본과의 SHA-256 일치를 검사합니다. (섹션 주석 이름만 바꿨습니다.)

`js/shaders/` 폴더는 더 이상 필요 없습니다. **패치 설치 시 기존 폴더를 삭제**해야 파일 수까지 줄어듭니다.
