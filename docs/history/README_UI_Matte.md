# FIELD Studio — Matte UI 2.0

기준: Shader Studio UI Refresh + 검색 아이콘 정렬 수정 버전.

## 변경 내용
- 녹색·민트 포인트 대신 차분한 **슬레이트 / 블루** 계열로 전체 시각 언어 통일
- 광택, 색 번짐, 글래스 블러를 제거하고 명확한 불투명 면과 1px 경계 사용
- Render 탭의 **A/B 예제** 및 **패스 모두 해제** 버튼에 명시적인 개별 스타일 적용
- Render / Uniforms / Input, GPU 성능, 편집기 패스 탭, 툴바, 검색창, 도움말, Uniform 카드의 타이포그래피·상태 개선
- 390px, 1440px 화면 및 편집기 열림 상태의 레이아웃 확인
- 실질적으로 변경한 실행 소스는 `index.html`, `style.css`뿐. JS / GLSL 15개 모듈은 기존 버전과 바이트 단위로 일치.
- 기존 클래스와 ID 보존: JavaScript 이벤트 연결, Uniform, Export Pack, Ray Marching 동작 계약 유지

## 적용
전체본: `index.html`을 브라우저에서 열기 (`file://` 가능).
패치: 기존 검색 아이콘 수정 완료 버전 위에 `index.html`, `style.css`를 덮어쓰기.
Runtime: 필수 실행 파일 17개만 포함.

## 검증 범위
- JavaScript 15개 모듈 SHA-256 변동 없음, HTML id 목록 불변
- 기존 Architecture 35개 및 Pack settings 9개 회귀 통과
- Texture / Sampling Node 모의 테스트 통과
- 브라우저 스타일 렌더링에서 Render 예제 버튼 2개, 입력 폼, 편집기, 모바일 확인
- 실제 GPU에서 렌더링한 픽셀이나 전체 UI의 실사용 통합 검증은 수행하지 못함. 포함된 `tests/gpu-validation.html`을 실제 브라우저에서 별도 실행 필요.
