# UX v2 재설계 (2026-11-01)

에디터 경험 → 디버깅·성능 → 비주얼 → 예제·온보딩 순서로 개선했다. 기존 DOM id·Renderer API는 유지하므로 Studio/UI 로직은 그대로 동작한다.
새 실행 모듈: `js/profiler.js`, `js/gallery.js` (배포 번들 목록에 추가됨).

## 에디터

- **인라인 컴파일 진단 (Error Lens)**: 오류 줄에 붉은 띠 + 줄 끝에 컴파일러 메시지. 경고는 노란색. 타이핑 중에는 흐리게(stale) 유지하고 다음 컴파일 결과로 교체한다. 패스 탭을 바꾸면 그 패스의 진단만 보인다. (`code-editor.js` `setDiagnostics`)
- **분할 배치**: 넓은 화면(≥1200px 첫 실행)은 편집기를 캔버스 **오른쪽**에 나란히 둔다. 툴바의 분할 아이콘으로 아래/오른쪽 전환, 리사이저로 너비 30~75% 조절(←→ 키 지원), 설정은 브라우저에 저장. 오른쪽 배치에서 `도구` 패널은 코드 위에 열리는 서랍이며 코드를 누르면 닫힌다. 820px 이하에서는 자동으로 아래 배치.
- **휴대폰**: 보조 행을 숨기고 도구 줄을 가로 스크롤 한 줄로 접어 코드 영역 최소 높이를 확보.

## 성능 · 디버그 탭 (설정 패널 `성능`)

- KPI: FPS / 프레임 간격 / GPU / CPU 제출 / 버퍼 VRAM.
- 프레임 타임라인 그래프(최근 18초, 60·30fps 기준선). 패널이 보일 때만 샘플링·그리기.
- 패스별 GPU 시간 막대(이동평균, 8ms 초과 시 경고색).
- **Uniform 진단**: 프로그램별 활성 Uniform을 내장 / 파라미터 / **미등록**으로 분류. 미등록 Uniform(GLSL에 선언만 되어 값이 0)은 **등록** 버튼 한 번으로 파라미터가 된다. 타입 불일치로 무시된 내장 Uniform도 표시.
- GPU 정보: 렌더러 이름, 한계값, 주요 확장 지원 여부.
- 새 Renderer API: `getCapabilities()`, `getShaderReflection()`의 각 Uniform에 `source` 필드.

## 비주얼

- 토큰 재정의(`:root`): 잉크 배경 + 단일 바이올렛 액센트, 성공/경고/위험 색, radius·shadow·sans/mono 폰트 토큰.
- 파일 끝 *Design layer v2*에서 모든 주요 컴포넌트를 토큰 기반으로 재스킨: 유리질 HUD, 활성 패스 탭 밑줄, 상태 배지, 다이얼로그 블러 배경, GLSL 구문 색 테마.

## 예제 갤러리 · 온보딩

- 뷰포트 툴바 격자 아이콘 또는 `X`. 첫 방문 시 환영 화면(3단계 안내)과 함께 자동으로 열린다.
- **Shader Art** 5종(직접 작성): Aurora Flow(도메인 워핑), Kaleido Bloom(극좌표 만화경), Metaball Lava(smooth-min), Neon Horizon(원근 격자), Truchet Weave(타일링). 각각 조절 가능한 파라미터 포함.
- **기법 배우기** 3종: 기존 Ray Marching / Buffer Pipeline / Feedback.
- 썸네일은 임시 WebGL2 컨텍스트로 한 번만 그리고 `loseContext()`로 즉시 해제한다.
- 예제 적용은 `studio.loadExample()` → 미적용 변경 확인·Undo 그대로.

## 검증

- Live Server + 실제 GPU: `tests/gpu-validation.html` **PASS 29 / 29**.
- 브라우저에서 확인: 8개 예제 전부 컴파일 오류 없이 로드, 인라인 진단 표시, 미등록 Uniform 감지, 데스크톱 분할·모바일 레이아웃(가로 넘침 없음).
- 배포본(`deploy/`): 셸 없이 갱신했다. 브라우저에서 `tools/build_deploy.py`의 변환 규칙을 그대로 재현(변경 없는 모듈 3개로 바이트 일치 확인)해 기대 산출물을 만들고, `deploy/js/min.js`·`deploy/index.html`·`deploy/style.css`가 그 결과와 **바이트 단위로 동일**함을 확인했다. 배포본도 Live Server에서 오류 없이 실행된다.
- `SOURCE_SHA256_Runtime.txt`: 브라우저 `crypto.subtle`로 15개 실행 파일의 SHA-256을 계산해 갱신(index.html은 Live Server 주입 스크립트를 제거한 원본 기준).
- 미실행: Node 회귀 테스트. 레이아웃·마크업이 바뀌어 일부 UI 기하 회귀 테스트는 기대값 갱신이 필요할 수 있다. Python이 있는 환경에서는 `python tools/build_deploy.py`를 다시 실행해도 같은 결과가 나와야 한다.
