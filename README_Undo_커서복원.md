# Undo/Redo 커서 위치 복원 수정

기준: Shader Studio 기본 예제 단일화 버전.

## 해결한 문제

이전 코드에서는 Undo 이력을 작성할 때 커서/선택 좌표를 마지막 입력 이벤트 이후에만 읽었습니다. 사용자가 코드를 클릭하거나 방향키로 이동한 뒤 수정하면 과거 체크포인트에 오래된 좌표(주로 소스 끝 또는 처음)가 남아 Undo가 잘못된 위치로 이동했습니다.

- 코드 입력 직전(beforeinput) 현재 커서와 선택 영역을 저장합니다.
- 클릭·선택·키보드 이동·스크롤 시 현재 체크포인트의 좌표를 최신화합니다.
- Tab, 주석 전환, 줄 복제 등 `setRangeText`로 변경하는 명령도 수정 직전 좌표를 저장합니다.
- Undo/Redo는 시작/끝 커서, 선택 방향, 수직·수평 스크롤 위치를 복원하고 편집기에 포커스를 돌려줍니다.
- 소스 코드 이력, 자동 컴파일 실패 복구, 25단계 제한과 700ms 연속 타이핑 묶음 방식은 유지합니다.
- 렌더링 엔진·기본 GLSL·스타일·HTML은 변경하지 않았습니다.

## 수정 파일

- `js/studio.js`: 선택 범위·스크롤 스냅샷과 Undo/Redo 복원
- `js/code-editor.js`: Tab/주석/복제 등 직접 수정 전 콜백
- `tests/undo-cursor-regression.py`: Chromium에서 커서, 선택 방향, 스크롤, 버퍼별 편집 위치 회귀 테스트 추가
- `tests/custom-modal-regression.js`: 동일한 모달 공유 검증을 새로운 선택적 콜백 인자와 호환되도록 보완

## 검증

```sh
python tests/undo-cursor-regression.py
python tests/undo-browser-regression.py
node tests/architecture-regression.js
node tests/custom-modal-regression.js
node tests/default-template-regression.js
node tests/pack-settings-freeze.js
node tests/sampling-regression.js
node tests/texture-regression.js
node tests/ui-matte-regression.js
```

실제 GLSL GPU 렌더링 검증과는 독립적인 편집기 회귀 테스트입니다.
