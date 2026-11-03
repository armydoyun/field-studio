# 실제 GPU 검증 및 안정성 수정

이번 패치는 기능 추가보다 **실제 WebGL2 실행 검증 경로**와 **실패 시 자원 보존**에 집중합니다.
GPU 검증 페이지는 원래 렌더링 UI와 독립적으로 동작합니다. 현재 Portable Pack은 v3로 확장되어 전역 설정과 사용자 Uniform도 포함합니다.

## 브라우저에서 GPU 검사 (2026-10-14 보강)

1. 전체 ZIP을 압축 해제하고 Chrome/Edge에서 `tests/gpu-validation.html`을 엽니다 (`file://` 지원).
2. **전체 GPU 테스트 실행**을 누르고 검사하는 동안 브라우저 탭을 화면에 표시해 둡니다.
3. 결과의 `PASS / FAIL / SKIP`을 확인한 뒤 **결과 복사** 버튼으로 환경 정보와 모든 항목을 복사하여 전달합니다.
4. 실패 시 해당 항목의 오류 메시지와 F12 개발자 콘솔 내용도 함께 기록합니다.

24개 실제 GPU 검사 영역:
- 범용 Shader Art 및 Ray Marching Starter 컴파일, Image / Buffer / Preview 렌더링, PNG 캡처 및 상하 방향
- Buffer 간 `current` 전달, `previous` Ping-Pong 피드백, 누적 및 Reset
- 4개 `iChannel` 바인딩과 `iChannelResolution`, `uResolution`/`uFrame`/`uMouse`
- 잘못된 GLSL/채널 연결의 거부, Image/Buffer 실행 상태 롤백
- 사용자 Uniform 6가지 타입의 자동 GLSL 선언 및 실제 GPU 전송
- 자동 Uniform 삽입 후 GLSL 컴파일 오류의 원본 줄 번호 추적
- Portable Pack 사전 검증 및 적용/컴파일 실패 시 상태 보존
- RGBA32F 부동소수점 픽셀 정확성 (`EXT_color_buffer_float` 필요)
- PNG 이미지 GPU 업로드, Clamp/Repeat/Mirror, Nearest/Linear 필터링
- 해상도, Buffer 스케일, maxPixels 제한에 따른 FBO 재할당
- WebGL Context Loss/Restore 후 프로그램·버퍼·텍스처 복구 (`WEBGL_lose_context` 필요)

`PASS`는 실제 GPU 계산 결과가 기대값과 맞았음을, `FAIL`은 불일치/실행 오류를, `SKIP`은 선택적 GPU 확장 또는 안전 격리 미지원으로 생략했음을 뜻합니다. 이 테스트는 별도 Canvas를 사용하므로 앱의 실제 편집 UI 조작까지 보장하지는 않습니다.

**데이터 안전:** 검사 페이지는 테스트가 실행되는 동안 `window.indexedDB`를 메모리 전용 구현으로 일시적으로 대체합니다. 임시 이미지는 GPU 및 테스트용 메모리 저장소에만 보관되며 Studio의 기존 IndexedDB 기록이나 localStorage를 건드리지 않습니다. 이 격리가 불가능하면 이미지 Texture 검사를 SKIP합니다.

## 수정된 런타임 코드

- `js/pass-manager.js`: 화면 크기가 변할 때 모든 버퍼의 새 Framebuffer를 먼저 준비합니다. 뒤쪽 버퍼가 실패하면 신규 리소스를 폐기하고 **이전 버퍼 전체**를 보존합니다. 필요할 때 일시적으로 GPU 메모리를 더 사용할 수 있습니다.
- `js/pass-manager.js`: GPU 픽셀 읽기 후 `gl.getError()`를 검사해 잘못된 읽기를 정상 데이터로 오인하지 않도록 했습니다. Preview 중 드로우 실패 시 Texture 채널 바인딩을 정리합니다.
- `js/renderer.js`: 캡처 대기 중 `stop()` 호출 시 중단된 Screenshot Promise를 거부해 무기한 대기를 방지합니다.

## 자동화 가능 범위와 한계

- `node tests/architecture-regression.js`: 모의 WebGL 상태 전이 및 실패 주입 테스트 (이번 수정의 버퍼 교체 원자성·캡처 취소 포함).
- `node tests/texture-regression.js`: 이미지 입력 관리/삭제/복원 검사.
- `tests/gpu-validation.html`: **실제 GPU/WebGL2에서 직접 실행할 때만** 셰이더 드라이버 컴파일 및 픽셀값 검사.

현재 실행 환경에서는 Chromium의 로컬 파일 및 테스트 서버 접근이 관리자 정책으로 차단되어 실제 GPU 검사를 완료하지 못했습니다. 따라서 실제 GPU 검사를 통과했다고 주장할 수 없습니다. 브라우저에서 GPU 검사 페이지를 실행해 결과를 직접 확인해야 합니다.

**인쇄용 Runtime 소스는 `tests/`와 이 문서를 제외하고 `index.html`, `style.css`, `js/`만 필요합니다.**
