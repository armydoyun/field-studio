# Shader Studio 소스 경량화 기록

기준: `raymarch_shader_studio_v4_1_ux_complete.zip` (v4.1)

| 항목 | 변경 전 | 변경 후 | 변화 |
|---|---:|---:|---:|
| 실행용 JS 파일 | 16개 | 15개 | -1개 |
| 실행용 JS 물리적 줄 수 | 2,364 | 1,835 | -529 (22.4% 감소) |
| 실행용 JS UTF-8 크기 | 151,053B | 139,687B | -11,366B (7.5% 감소) |

## 변경 원칙

1. 실행문을 바꾸지 않는 범위에서 의미 없는 장문 주석, 긴 세로 배치, 반복 선언을 줄였습니다. JSX/GLSL 템플릿 문자열 내부는 건드리지 않았습니다.
2. `studio.js`에서 반복되는 Renderer 상태 스냅샷 생성을 `snapshot()`으로 통합했습니다.
3. `pass-manager.js`에서 채널 검증에 사용하는 패스 인덱스 Map 생성을 `passOrder()`로 모았습니다.
4. `renderer.js` Uniform Location의 `null`/`undefined` 검사를 통일했습니다.
5. 중복된 `buffer-demo.js`를 제거하고 UI의 피드백 예제 버튼을 Shader Studio의 단일 구현으로 연결했습니다. 이전 `require(["buffer-demo"])` 직접 호출은 더 이상 지원하지 않으며, 대신 `window.shaderStudio.exampleFeedback()`을 사용합니다.
6. 오래된 버전별 README 문서를 통합해 현재 사용법은 `README.md` 하나에서 찾게 했습니다. 회귀 테스트는 유지했습니다.

## 변형 범위와 안전성

- **동작을 유지한 파일**: GLSL, HTML, CSS 파일의 원문은 이전과 동일합니다.
- **기계적 압축만 한 모듈**: JavaScript AST(주석/위치/원문표기 제외)를 원본과 비교해 동일함을 확인했습니다.
- **실제 API를 정리한 모듈**: `studio.js`, `renderer.js`, `pass-manager.js`, `ui.js`는 Node/브라우저 모의 테스트로 확인했습니다.
- **확인한 테스트**: 아키텍처 모의 GPU 21개 항목, Texture 테스트, 브라우저 DOM 편집/파일 드롭/자동 채널, UI 피드백 버튼.
- **검증하지 못한 항목**: 실제 GPU 드라이버의 GLSL 컴파일과 픽셀 결과, 모든 브라우저의 파일 접근/저장 호환성.

## 삭제된 과거 버전 문서

- `README_Texture_Input.md`
- `README_UX_개선.md`
- `README_경량화.md`
- `README_멀티패스_버퍼패치.md`
- `README_셰이더스튜디오.md`
- `README_셰이더스튜디오_v2.md`
- `README_통합완성본.md`

원본과 새 파일의 체크섬은 `SHA256_파일검증.txt`에서 확인할 수 있습니다.
