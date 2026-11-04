# 괄호 자동 완성 · bool 스위치 · 실용 버퍼 예제

2026-10-15. 변경 파일: `js/code-editor.js`, `js/ui.js`, `js/studio.js`, `index.html`, `style.css`.

## 1. 닫는 괄호 앞에서 여는 괄호 입력

원인은 `code-editor.js`의 자동 완성 분기였습니다. 커서 바로 뒤에 같은 닫는 괄호가 있으면 쌍 삽입을 중단했습니다. 이 예외 조건 한 줄을 제거했습니다.

- `sin(|)`에서 `(` → `sin((|))` (`|`는 커서).
- `[]`, `{}`도 동일합니다. 뒤에 있던 닫는 괄호는 보존합니다.
- 닫는 괄호 입력 시 건너뛰기, 빈 쌍 Backspace 삭제, 선택 감싸기, Undo/Redo는 유지합니다.
- 주석·문자열 안과 IME 조합 중에는 쌍을 자동 삽입하지 않습니다.

## 2. bool 파라미터

기존 체크박스의 브라우저 기본 사각 표시를 스위치로 바꿨습니다. 기존 `--accent`, `--surface`, `--line-strong`, `--muted` 등의 색상 변수를 사용합니다.

- 켜짐/꺼짐은 손잡이 위치와 `true · 켜짐` / `false · 꺼짐` 텍스트로 함께 표시합니다.
- 네이티브 checkbox와 label을 유지하고 `role="switch"`를 지정하여 클릭·라벨 클릭·Tab·Space 동작을 그대로 사용합니다.
- 값 적용 실패 시 스위치와 텍스트를 마지막 적용 상태로 복구합니다.
- 동작 줄이기 환경에서는 스위치 전환 애니메이션을 끕니다.

추가 폼의 bool 초기 값 입력은 기존 true/false 입력 방식이며, 생성 후 파라미터 목록에서 스위치로 조절합니다.

## 3. 예제 개편

Doom Fire GLSL, 버튼, `exampleFire()` API를 제거했습니다. 두 학습 예제는 같은 움직이는 원 A와 같은 Image 비교 코드를 공유합니다. Ray Marching 예제는 선택형으로 유지합니다.

| 예제 | A | B 입력 | B 처리 | Image 입력 |
| --- | --- | --- | --- | --- |
| 01 · 버퍼 연결과 후처리 | 움직이는 원 생성, 입력 없음 | iChannel0 = A current | RGB 순서 변경 | iChannel0 = B current, iChannel1 = A current |
| 02 · 이전 프레임 잔상 | 동일한 원 생성 | iChannel0 = A current, iChannel1 = B previous | 새 원과 감쇠한 이전 잔상의 최댓값 | 동일 |

Image 왼쪽은 A 원본, 오른쪽은 B 결과입니다. 비교를 위해 각 반쪽에 전체 UV를 대응하므로 반쪽 화면의 가로 비율은 압축됩니다.

각 GLSL의 첫 주석에 패스 역할과 채널 연결을 적었습니다. 코드를 읽고 다음을 확인할 수 있습니다.

- current는 이번 프레임에서 먼저 실행된 패스의 결과입니다. 순서는 A → B → Image입니다.
- 자기 피드백은 previous로 연결해야 합니다. B current를 B 자신에게 연결할 수 없습니다.
- B는 첫 프레임 `uFrame == 0`에서 누적 결과를 사용하지 않습니다. Reset은 시간/프레임과 누적 버퍼를 초기화합니다.
- 잔상 감쇠에 `uDeltaTime`을 사용합니다. 두 예제는 기본 RGBA8만 사용하므로 float 렌더링 확장을 요구하지 않습니다. 매 프레임 최소 1/255만큼 감쇠하여 RGBA8 반올림으로 잔상이 영구히 남는 것을 방지합니다. 이 양자화 때문에 프레임 제한에 따라 정확한 잔상 지속 시간은 달라집니다. 고정밀 누적이 필요할 때만 B 포맷을 RGBA32F로 변경하세요(확장 지원 필요).

Render 탭의 예제 버튼도 01의 버퍼 연결 예제로 연결했습니다. Starter 전환의 파라미터 교체, 실패 시 기존 작업 유지, Undo/Redo는 그대로 동작합니다.

## 검증

- `node tests/pair-nesting-regression.js`: 실제 편집기 모듈을 모의 DOM에서 구동, 12개 검사.
- `node tests/parameter-ui-regression.js`: 14개 검사. bool 스위치의 역할/상태/변경/오류 복구, Render 예제 버튼 연결 검사 포함.
- `node tests/learning-examples-regression.js`: 8개 검사. 채널 구성, 주석, 첫 프레임과 감쇠, 실패 복구, Undo/Redo, Fire 제거.
- 기존 Node 검사와 무결성 검사를 포함한 16개 스위트 통과. JavaScript 구문 및 ZIP/소스 해시 검사 통과.
- `tests/autopair-browser-regression.py`에 실제 키보드 중첩 입력 검사도 추가했습니다. 브라우저 실행 파일이 없어 이번 환경에서는 실행하지 않았습니다.
- 실제 브라우저 화면/키보드 기본 동작과 GPU GLSL 컴파일·픽셀 결과는 이번에 미검증입니다. 브라우저에서 두 Starter를 열고 A/B/Image 탭 및 Preview, Pause/Reset을 확인할 수 있습니다.

새 실행 모듈과 외부 라이브러리는 없습니다. 기존 실행 파일 13개 대비 총 9줄, UTF-8 1,674바이트 증가했습니다. 테스트 코드는 실행 소스 크기에 포함하지 않았습니다.
