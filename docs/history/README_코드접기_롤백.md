# GLSL 코드 접기(Folding) 기능 롤백

- **사유:** 접힌 상태에서 문법 강조·입력·선택·커서·스크롤이 일반 편집과 다르게 작동하여 정상적인 직접 편집 경험을 제공하지 못함. 브라우저/GPU 환경 문제로 단정하지 않음.
- **기준:** `shader_studio_UX_glsl_completion_2026-10-14.zip` (UX 06, GLSL 자동 완성).
- **복원:** `js/code-editor.js`, `index.html`, `style.css`를 UX 06과 바이트 단위로 동일하게 복원. Folding 관련 별도 브라우저 검사 및 기존 README 문서는 패키지에서 제외.
- **유지:** GLSL 자동 완성, 함수 탐색, 자동 괄호, 스마트 들여쓰기, 선택 줄 이동, Undo/Redo, GPU 렌더링 및 기존 23개 GPU 검사 코드.
- **UI:** `Fold`, `Fold all`, `Unfold`, 접기 화살표, 접기 전용 별도 화면 모두 제거. 일반 textarea 편집기로 통합.
- **검증:** 전체 Runtime SHA-256, AMD 의존성, JavaScript 구문, Node 및 Chromium 회귀 검사(결과는 아래 ZIP 검증 기록 참조). 사용자 환경에서의 실 GPU 재검사는 포함하지 않음.
- **롤백 전용 정적 테스트:** `node tests/folding-rollback-regression.js`로 접기 UI 완전 제거 및 일반 편집기 핵심 요소가 남아 있는지 검증.
