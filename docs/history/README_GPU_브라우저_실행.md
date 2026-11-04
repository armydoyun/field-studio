# Shader Studio — 실제 WebGL2 GPU 통합 검사

## 실행 방법

1. ZIP 전체를 압축 해제합니다. `tests/`와 `js/`의 상대 경로를 그대로 유지해야 합니다.
2. Chrome 또는 Edge에서 `tests/gpu-validation.html`을 엽니다. 앱의 `index.html`은 실행하지 않아도 됩니다.
3. **전체 GPU 테스트 실행**을 클릭하고 검사 동안 탭을 화면에 표시해 둡니다.
4. **결과 복사** 버튼으로 검사 결과 전체를 복사해서 대화에 붙여넣어 주세요. `FAIL` 발생 시 해당 브라우저의 F12 콘솔 메시지도 유용합니다.

## 검사 범위

- 기본 Shader Art GLSL과 Ray Marching Starter의 실제 드라이버 컴파일 및 PNG 생성
- Buffer / Image / Preview 출력, 현재 프레임 참조, 이전 프레임 피드백 및 Reset
- 4개 채널·채널 해상도·해상도/프레임/마우스 Uniform·PNG Y축 방향
- 잘못된 GLSL·채널 연결·Pack 복원 검증 시 기존 프로그램과 데이터 보존
- float/int/bool/vec2/vec3/vec4 사용자 Uniform의 자동 선언 및 GPU 업로드
- RGBA32F 픽셀과 실제 PNG 텍스처 업로드·Nearest/Linear 필터·Clamp/Repeat/Mirror 래핑
- 버퍼 해상도 재할당 및 픽셀 제한, Context Loss 후 GPU 프로그램과 텍스처 재생성
- 자동 Uniform 삽입 후 컴파일 오류 줄 번호 보정
- Ray Marching Starter에서 사용자 Uniform 업로드와 Heatmap 전환 실제 픽셀 검사 (24번)

## 검사 결과 해석

- `PASS`: 실제 GPU 경로를 실행하고 명시적인 픽셀값 또는 상태를 확인했습니다.
- `FAIL`: 실제 동작이 예상과 다르거나 시간 초과/컴파일 오류가 발생했습니다. 브라우저·GPU 정보와 함께 결과를 전달해 주세요.
- `SKIP`: 브라우저에 선택적 GPU 확장이 없거나, 사용자 IndexedDB의 안전 격리를 설정할 수 없어 테스트를 생략했습니다.

검사 페이지는 **테스트 전용**으로, 앱 저장소를 수정하지 않습니다. 검사 중 `window.indexedDB`를 테스트 페이지에서만 메모리 전용 구현으로 임시 대체하므로 임시 GPU 텍스처는 메모리에서 생성·폐기되며 사용자 이미지가 저장·덮어쓰기 되지 않습니다. 격리가 실패하면 텍스처 관련 검사는 SKIP됩니다. Context Loss 검사는 브라우저가 `WEBGL_lose_context` 확장을 제공할 때만 실행합니다.

이 GPU 검사에 대응하는 범용 Shader Art 전환 버전에서는 앱의 시작 GLSL과 에디터 UI가 변경되었습니다. 실제 GPU 24번 검사는 사용자 브라우저에서 재확인해야 합니다.

## 2026-10-14 테스트 하네스 수정

- PNG 검사 Canvas2D에 `willReadFrequently`를 지정해 반복 픽셀 판독 경고 제거.
- IndexedDB를 `undefined`로 설정하는 대신 비동기 put/delete/getAll을 지원하는 메모리 모의 저장소 사용. 기존 사용자 DB는 접근하지 않음.
- `WEBGL_lose_context.restoreContext()`는 `webglcontextlost` 이벤트 디스패치가 완전히 끝난 다음 작업에서 호출.
- 복구가 실패해 컨텍스트가 손실된 상태라면 22번 검사를 연쇄 FAIL로 기록하지 않고 SKIP 처리.
- 런타임 `js/` 파일은 변경하지 않음.
