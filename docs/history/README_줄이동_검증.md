# Shader Studio — UX 05: GLSL 줄 이동

## 기능

- `Alt+↑`: 현재 커서가 있는 줄 또는 선택한 여러 줄을 바로 위로 이동
- `Alt+↓`: 현재 커서가 있는 줄 또는 선택한 여러 줄을 바로 아래로 이동
- 원래 코드의 내용, 줄바꿈, 들여쓰기를 보존하며 커서 위치와 선택 범위(역방향 선택 포함)를 따라 옮김
- 선택 영역이 다음 줄의 첫 칸에서 끝나는 경우 그 다음 줄은 이동하지 않음
- 첫 줄에서 위로 이동, 마지막 줄에서 아래로 이동은 아무 작업도 수행하지 않으며 Undo 기록도 생성하지 않음
- 빈 줄, 파일 끝 개행, 줄 길이가 서로 다른 경우, 한 줄/여러 줄 선택 모두 처리
- 이동은 기존 `studio.js` Undo/Redo 및 자동 적용 흐름을 그대로 재사용

## 변경 범위

- `js/code-editor.js`: `moveLines` 함수 및 `Alt+ArrowUp/Down` 키 처리 추가
- `index.html`: 기존 도움말에 단축키 한 쌍 추가
- 기존 렌더러·GPU·멀티패스·자동 괄호·스마트 들여쓰기 구현은 변경하지 않음
- 새 AMD 모듈·외부 의존성·CSS 추가 없음

## 검증

```sh
python tests/move-lines-browser-regression.py
python tests/autopair-browser-regression.py
python tests/indent-browser-regression.py
python tests/function-navigation-browser-regression.py
python tests/undo-browser-regression.py
python tests/undo-cursor-regression.py
python tests/compiler-lines-browser-regression.py
node tests/architecture-regression.js
node tests/runtime-integrity.js
```

실행 환경: Chromium + Playwright (브라우저 테스트), Node.js (구조 테스트). 실 GPU를 사용하지 않는 편집기 통합 테스트입니다. 이전 UX 04 기준본의 GPU 23/23 통과 결과를 승계하지만 이번 변경 후 실제 GPU 검사는 별도로 재실행하지 않았습니다.

## 직접 확인

`index.html` → `E` → GLSL 편집기에서 커서를 임의 줄에 두고 `Alt+↑/↓` 실행. 여러 줄 선택 후 이동, `Ctrl+Z`/`Ctrl+Y` 복원, `Alt+PageUp/Down` 패스 전환도 확인합니다.
