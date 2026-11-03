# Shader Studio — 편집 Undo/Redo 개선

이전에는 성공적으로 적용된 GPU 프로젝트만 되돌릴 수 있어 컴파일 오류를 낸 GLSL 초안을 Undo 버튼으로 복구하지 못했습니다. 이제 **사용자의 편집 이력**과 **현재 성공적으로 실행 중인 GPU 프로그램**은 별개로 취급합니다.

- 에디터에서 코드 변경 즉시 프로젝트 이력을 저장합니다. Run/Auto 컴파일 실패 여부에 영향받지 않습니다.
- Undo는 컴파일 오류가 있는 편집본도 되돌리고, Redo로 오류 편집본을 다시 꺼낼 수 있습니다. 렌더러는 유효한 소스만 적용하므로 실패한 소스는 GPU에 올라가지 않습니다.
- 같은 패스에서 연속된 일반 문자 입력/삭제(700ms 이내)는 한 번의 Undo로 묶습니다. 붙여넣기, 서식 버튼 및 버퍼/채널 변경은 별개 기록입니다.
- Undo/Redo는 Image/Buffer 탭과 선택 위치도 복구하며, 성공적으로 적용된 프로젝트의 버퍼 추가·삭제·이동도 되돌릴 수 있습니다.
- `Ctrl+Z`는 Undo, `Ctrl+Y`와 `Ctrl+Shift+Z`는 Redo입니다. Mac에서는 Ctrl 대신 Cmd를 사용합니다. 편집기 텍스트 영역에 포커스가 있을 때 사용합니다.
- Undo/Redo는 확인창 없이 즉시 작동합니다. 이력은 최대 25단계의 메모리 상태이며 새로고침 후까지 남거나 Pack에 포함되지는 않습니다.

## 확인 방법

* `python tests/undo-browser-regression.py` — Chromium + Python Playwright 필요. 컴파일 실패, Auto 실패, 연속 타이핑, Undo/Redo, Buffer, 신규 분기 등 모의 렌더러 기반 실브라우저 DOM 검사.
* `node tests/architecture-regression.js`, `node tests/pack-settings-freeze.js`, `node tests/custom-modal-regression.js`, `node tests/texture-regression.js`, `node tests/sampling-regression.js` — 기존 엔진/구조 회귀.
* 실제 GPU 드라이버에서의 렌더링 결과 검사는 별도의 `tests/gpu-validation.html`을 실행해야 합니다.
