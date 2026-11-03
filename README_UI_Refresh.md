# Shader Studio — UI/UX Refresh

기준 버전: Architecture Freeze. 런타임 JavaScript/GLSL 15개 파일은 **바이트 단위 변경 없음**. 수정된 실행 파일은 `index.html`과 `style.css` 두 개뿐입니다.

## 개선 내용

- 기존 Ray Marching / Buffer / Input / Uniform 메뉴는 유지하고 그래파이트·민트 색상의 통일된 인터페이스로 재설계
- 화면 상단의 Live Preview, 미니멀 아이콘 툴바, 실행 통계 HUD를 보기 쉽게 구분
- Shader Studio의 활성 패스·실행 버튼·코드 편집영역·입력 채널을 명확히 구분
- 데스크톱·태블릿·모바일 반응형 레이아웃 보정; 모바일에서 숨겨져 있던 Texture/Project/예제 제어를 복원
- 호버·포커스·활성·비활성 피드백 강화, 시스템 기본 폰트 유지
- 새로운 외부 패키지·CDN·글꼴·이미지·실행용 JavaScript 없이 동작

## 실행

전체본 압축 해제 후 `index.html`을 열면 됩니다. 다른 버전의 `style.css`가 브라우저에 남는 경우 새로고침하세요.

## 패치 적용

Architecture Freeze 버전의 같은 경로에 패치 ZIP을 풀어 덮어쓰세요. `js/`는 변경하지 않으며, 새 디자인 안내서와 갱신한 체크섬 파일이 포함됩니다.

## 검증 범위

- 기존 렌더링 엔진, AMD 모듈, GLSL/JavaScript 내용은 원본과 SHA-256으로 대조
- 엔진 구조 회귀 35개, Pack 설정 검증 9개, Texture/Sampling 모의 검사 통과
- CSS 파싱 및 HTML ID 중복 검사 통과
- 헤드리스 Chromium의 정적 레이아웃 확인: 1600, 1024, 768, 390px에서 수평 화면 넘침 없음, 소형 화면에서도 Texture/Project 버튼 접근 가능
- Chromium이 현재 실행 환경의 `file://`/localhost 접속을 차단하여 실제 GPU 통합 렌더링은 미검증. 정적 화면 미리보기는 데모 배경을 사용하므로 실제 GLSL 출력은 아닙니다.

기존 기능 단축키와 사용자 설정, 저장 파일 형식은 그대로입니다.
