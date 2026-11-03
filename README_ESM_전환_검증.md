# FIELD Studio — AMD → ES Modules 마이그레이션 결과

- 기준: 원본 `a(1).zip` (2026-10-15) 13개 실행 파일
- 현재 개발용 실행 파일: `index.html`, `style.css`, `js/*.js` 10개 = 12개
- 제거: `js/loader.js`, HTML 내 `require.config()` / `require()` 호출, 모든 JS 파일의 `define()` 래퍼
- 신규: 모듈별 `import`와 `export`, HTML의 `<script type="module" src="./js/main.js"></script>`
- 로딩 관계: `main → renderer/shader/ui/input/settings/studio`; `renderer → pass-manager/texture-input`; `studio → code-editor`
- shader.js는 단일 설정 객체를 `export default`로 내보내며, 나머지 라이브러리 모듈은 named export를 사용함.
- 호환성: GLSL 템플릿 문자열을 포함한 구현 본문을 그대로 보존. UI, GLSL, Texture, Multipass 알고리즘은 변경하지 않음.
- `deploy/`: ESM 소스에서 생성한 3파일 오프라인 배포본. `js/min.js`는 변수명 단축이 없는 단일 번들임.

## 검증 기록

- Node.js의 실제 ESM `import` 실행: 성공 (모듈 9개 및 공개 API 검사).
- Chromium의 실제 ESM 동적 import(Blob 기반): 모듈 로딩 성공, uncaught JS 예외 없음.
- 오프라인 번들을 Chromium DOM에 삽입한 초기화 검사: JS 예외 없음.
- 개발용/배포용 모두 현재 자동화 환경에서 WebGL2 지원이 없어 초기화가 `WebGL 2.0을 사용할 수 없습니다.`로 정상 종료됨. 따라서 GPU 실제 동작을 검증했다고 주장하지 않음.
- Node mock/DOM 구조 회귀 22개 스위트 통과.
- Chromium 기반 편집기 독립 브라우저 회귀 7/8 스위트 통과. 컴파일 오류 줄 번호 테스트 한 건 실패하였으며, 변경 전 원본 `a(1).zip`에서도 동일 테스트가 실패함을 재현함. 이번 ESM 전환에 의한 신규 회귀로 판단할 근거 없음.
- `tests/runtime-integrity.js`: 개발용 12파일 SHA-256, 의존성 순환, HTML ID, 배포 구조 검사 통과.
- 원본 AMD 셰이더 객체와 ESM 셰이더 객체의 필드/GLSL 텍스트 완전 일치 검사 통과.

## 환경 안내

ES Modules 개발용 `index.html`은 로컬 HTTP 서버에서 열어야 합니다. Chrome/Edge `file://`의 ESM import는 CORS로 거부될 수 있습니다. 오프라인 실행은 `deploy/index.html`을 직접 더블클릭하세요. 배포에 Python, Node.js, npm, CDN은 필요하지 않습니다.

현재 개발 소스의 JS를 수정하면 다음 명령으로 오프라인 배포본을 재생성합니다.

```
python tools/build_deploy.py
```

이 순수 Python 생성기는 위에서 사용한 FIELD Studio의 정적 import/export 패턴만 지원합니다. 전체 ECMAScript 번들러나 전문 미니파이어가 아니므로, `min.js`라는 파일명과 달리 변수명을 난독화/최소화하지는 않습니다. 더욱 작은 Zopfli/OCR 인쇄본이 필요하면 별도로 전문 미니파이어를 적용하고 다시 검증하세요.
