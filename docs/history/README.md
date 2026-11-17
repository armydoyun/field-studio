# 작업 기록 모음

기능별로 무엇을 왜 바꿨고 어떻게 확인했는지 남긴 기록이다. 지금 구조와 규칙은 저장소 맨 위 `README.md`와
`docs/DESIGN_SYSTEM.md`가 기준이고, 여기 글은 그때의 판단을 찾아볼 때 읽는다(이후에 바뀐 내용이 있을 수 있다).
새 기록은 `README_<주제>_<연-월>.md`로 두고 이 목록에 한 줄 더한다.

## 2026-11 (ES Modules 이후)

| 파일 | 내용 |
|---|---|
| [README_점검_보수_2026-11.md](README_점검_보수_2026-11.md) | 기능 개발을 멈추고 한 점검 · 보수: 커버리지 측정, 찾은 문제와 고친 것 |
| [README_파라미터_목록_행단위_2026-11.md](README_파라미터_목록_행단위_2026-11.md) | 파라미터 목록을 행 단위로 그리기 |
| [README_컴파일_멈춤_줄이기_2026-11.md](README_컴파일_멈춤_줄이기_2026-11.md) | 컴파일 때문에 화면이 멈추던 문제 줄이기 |
| [README_연결_프리셋_타임라인_디자인시스템_2026-11.md](README_연결_프리셋_타임라인_디자인시스템_2026-11.md) | 파라미터 연결 · 프리셋 · 키프레임 타임라인 · 디자인 시스템 |
| [README_ESM_전환_검증.md](README_ESM_전환_검증.md) | AMD → ES Modules 마이그레이션 결과 |
| [README_CodeMirror6_편집기.md](README_CodeMirror6_편집기.md) | GLSL 코드 편집기를 CodeMirror 6으로 |
| [README_UX_v2_재설계.md](README_UX_v2_재설계.md) | UX v2 재설계 (11-01) |
| [README_파라미터_버퍼_업데이트.md](README_파라미터_버퍼_업데이트.md) | 파라미터 UX · 버퍼 시각화 · 고급 버퍼 기능 (11-01) |
| [README_확장기반_정비.md](README_확장기반_정비.md) | 확장 기반 정비 (11-01) |

## 편집기

| 파일 | 내용 |
|---|---|
| [README_함수탐색_검증.md](README_함수탐색_검증.md) | UX 02: 함수 탐색기 |
| [README_자동괄호_검증.md](README_자동괄호_검증.md) | UX 03: 자동 괄호 |
| [README_들여쓰기_검증.md](README_들여쓰기_검증.md) | UX 04: 들여쓰기 |
| [README_줄이동_검증.md](README_줄이동_검증.md) | UX 05: 줄 이동 |
| [README_자동완성_검증.md](README_자동완성_검증.md) | UX 06: 이름 자동 완성 |
| [README_컴파일진단_줄보정.md](README_컴파일진단_줄보정.md) | 오류 줄 번호 보정 |
| [README_코드접기_롤백.md](README_코드접기_롤백.md) | 예전 편집기의 코드 접기 롤백(CodeMirror 6에서 다시 들어옴) |
| [README_Undo_개선.md](README_Undo_개선.md) · [README_Undo_커서복원.md](README_Undo_커서복원.md) | 편집 Undo/Redo와 커서 위치 복원 |
| [README_괄호_스위치_실용예제.md](README_괄호_스위치_실용예제.md) | 괄호 자동 완성 · bool 스위치 · 실용 버퍼 예제 |

## 화면 · UI

| 파일 | 내용 |
|---|---|
| [README_작업공간_UX_개편.md](README_작업공간_UX_개편.md) | 작업공간 UI/UX 개편 |
| [README_UI_정렬_전면정리.md](README_UI_정렬_전면정리.md) | HTML · CSS 간격과 정렬 전면 정리 |
| [README_UI_Matte.md](README_UI_Matte.md) · [README_UI_Refresh.md](README_UI_Refresh.md) | Matte UI 2.0 · UI/UX Refresh |
| [README_Custom_Modal.md](README_Custom_Modal.md) · [README_모달_Enter_간격정리.md](README_모달_Enter_간격정리.md) | 앱 대화상자와 Enter 처리 |
| [README_아이콘_정렬.md](README_아이콘_정렬.md) | 아이콘 정렬 보정 |
| [README_UX_1차_작업상태_연결.md](README_UX_1차_작업상태_연결.md) · [README_UX_2차_채널연결.md](README_UX_2차_채널연결.md) | 작업 상태 · 패스 연결 · 채널 연결 이해 |
| [README_파라미터_UX.md](README_파라미터_UX.md) | 프로젝트 파라미터 통합 |

## 렌더링 · 프로젝트 형식 · 검증

| 파일 | 내용 |
|---|---|
| [README_Portable_Pack.md](README_Portable_Pack.md) · [README_Architecture_Freeze.md](README_Architecture_Freeze.md) | Pack v3 형식 |
| [README_Texture_Sampling.md](README_Texture_Sampling.md) | 텍스처 샘플링 |
| [README_Starter_카메라_소유권.md](README_Starter_카메라_소유권.md) | Starter 프로젝트와 Orbit 카메라 |
| [README_범용쉐이더_전환.md](README_범용쉐이더_전환.md) · [README_기본예제통합.md](README_기본예제통합.md) | 범용 Shader Art 전환 · 시작 셰이더 통합 |
| [README_GPU_검증.md](README_GPU_검증.md) · [README_GPU_브라우저_실행.md](README_GPU_브라우저_실행.md) | 실제 GPU 검사 |
| [README_최종무결성_검증.md](README_최종무결성_검증.md) | 원본 무결성 검증 |

## 2026-10 이전 (AMD 시절)

| 파일 | 내용 |
|---|---|
| [README_2026-10-15_AMD_기록.md](README_2026-10-15_AMD_기록.md) | 원본 AMD 개발 기록 |
| [README_로직수정_2026-10-15.md](README_로직수정_2026-10-15.md) · [README_추가분석_2차_2026-10-15.md](README_추가분석_2차_2026-10-15.md) | Shader Art 로직 수정 · 2차 분석 |
| [README_경량화_변경표.md](README_경량화_변경표.md) · [README_안전경량화.md](README_안전경량화.md) · [README_최종개선.md](README_최종개선.md) | 경량화 기록 |
