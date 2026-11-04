# Shader Studio — 최종 미세경량화 및 편집기 개선

기준: `raymarch_shader_studio_compact_complete.zip`.
설치: ZIP을 새 폴더에 해제한 후 `index.html`을 실행합니다. npm·CDN·HTTP 서버가 필요하지 않습니다.

## 개선 사항

- **Context Loss 복구 수정**: GPU 컨텍스트가 손실되어도 로컬 이미지의 CPU 측 `ImageBitmap`을 폐기하지 않습니다. 복구 후 GPU Texture를 다시 생성합니다.
- **편집기 Tab 공백 설정**: 도구 모음의 `Tab 2 / 4`에서 선택합니다. 자동 들여쓰기, Tab 및 Shift+Tab에 같이 적용되고 브라우저에 저장됩니다.
- **Smart Backspace**: 줄 앞에 공백만 있다면 선택한 들여쓰기 단위만큼 지웁니다.
- **Smart Home**: 누르면 첫 문자로, 다시 누르면 실제 줄 맨 앞으로 이동합니다.
- **행 들여쓰기 단축키**: Ctrl+[ 및 Ctrl+] (macOS에서는 Cmd+[ / Cmd+]).
- **패스 탭 탐색**: 탭에 포커스를 둔 상태에서 ←/→, Home, End. 코드 입력 중에는 Alt+PageUp/Alt+PageDown으로 전후 패스 이동(브라우저의 단축키 선점 여부에 따라 제한 가능).
- **중복 다운로드 처리 공통화**: 프로젝트 JSON과 GLSL 파일 저장을 하나의 내부 함수가 수행합니다.
- **코드 정리**: AMD 로더의 과도한 물리적 줄바꿈과 Pass Manager의 미사용 선언을 제거했습니다.

## 실행용 JS 코드량

| 기준 | 변경 전 | 변경 후 | 차이 |
|---|---:|---:|---:|
| 모듈 파일 수 | 15 | 15 | 0 |
| 줄 수(주석·공백 포함) | 1,835 | 1,823 | -12 |
| 소스 바이트(UTF-8) | 139,687 | 141,004 | +1,317 |

새 기능을 넣었으므로 바이트 수는 소폭 늘었습니다. 전체 소스가 순수하게 더 짧아졌다는 의미는 아니며, 줄 수가 감소해 출력 시 세로 공간을 조금 절약한 결과입니다.

## 재구성·인쇄 안내

`index.html`, `style.css`, `js/` 안의 모든 파일만으로 실행할 수 있습니다. `tests/`는 검증용이며 런타임에는 필요하지 않습니다. 
`README.md`와 `README_최종개선.md`를 먼저 읽고, 파일 경로를 그대로 만들어 소스를 작성하세요.
종이에 옮겨 적을 때는 실행 코드만 담은 `raymarch_shader_studio_polish_runtime.zip`을 사용할 수 있습니다. 테스트까지 포함한 원본 보존용으로는 `...polish_complete.zip`을 권장합니다.

## 검증

- `node --check`로 전체 JS 구문 검사
- `node tests/architecture-regression.js`: 24개 항목 통과, Context Loss 복구 경로 검증 포함
- `node tests/texture-regression.js`: 이미지 등록/복원/입력 채널 관리 통과
- 실제 Chromium DOM 환경에서 공백 수 설정, Enter/Tab/Shift+Tab/Backspace, 패스 탭 탐색 검사 통과
- AMD 의존성 및 로더의 비동기 실행 순서 검사 통과
- 실제 GPU 드라이버의 GLSL 컴파일 및 렌더링은 여기서 보장하지 않습니다.

