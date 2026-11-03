# Shader Studio — Portable Pack v3 / Architecture Freeze

## 무엇이 바뀌었나

- Pack v3은 GLSL·패스 정의·입력 이미지 외에 사용자 Uniform 목록(타입/값/슬라이더 범위)과 필수 Uniform 값, FPS, 해상도, 히트맵, Ray Marching 설정, 패널 표시 상태를 함께 저장한다.
- 기존 Pack v2는 계속 가져올 수 있으며, v2에는 없는 사용자 Uniform 및 전역 설정은 현재 상태를 유지한다. `Export JSON / Import JSON`의 경량 형식은 그대로 둔다.
- 가져오기 전 설정 스키마와 GPU 프로그램을 사전 검사한다. 임시 검사에서는 사용자 Uniform을 실제 등록하지 않으며, 실패하면 기존 프로그램을 유지한다.
- 이미지 ID가 다른 브라우저에서 달라도 매핑해서 복원한다. 이미지 복원이 중간 실패하면 새로 추가한 이미지를 삭제한다.
- 설정 UI는 불러온 값에 따라 갱신된다. 새 실행 모듈은 추가하지 않았다.

## 검증 방법

프로젝트 최상위 폴더에서 Node.js를 실행할 수 있다면:

```sh
node tests/architecture-regression.js
node tests/pack-settings-freeze.js
```

실제 Chrome/Edge/Firefox에서는 Shader Studio를 실행한 후 `tests/portable-regression.js`의 내용을 개발자 콘솔에서 실행한다. 해당 테스트는 이미지, 전역 설정, 사용자 Uniform을 일시적으로 바꾸며 마지막에 원래 상태로 복구한다. 저장소 접근 제한이나 사용자 확인 창에 따라 수동 확인이 필요할 수 있다.

브라우저 DOM과 모의 WebGL을 연결한 자동 검사에서 Pack v3 생성/복원, 이미지 ID 재매핑, 설정 복원, 비정상 Pack 거부, v2 호환을 확인했다. 실제 GPU 드라이버는 사용하지 않은 검사다.

GPU 드라이버 수준의 렌더링은 `tests/gpu-validation.html`에서 별도로 검증한다. 모의 WebGL과 JS 구문 검사만으로 모든 GPU/브라우저 동작이 검증되었다고 볼 수는 없다.

## 종이에 옮길 파일

필사용 Runtime ZIP에는 실행에 필수적인 17개 파일만 포함했다. 모든 회귀 테스트와 문서는 인쇄본에서 제외해도 실행에는 영향이 없다. 파일 이름은 최대한 기존 그대로 유지했고 프로덕션 실행 모듈 추가는 없다.

## 알려진 제한

- Pack은 채널에 연결된 이미지의 원본만 포함하며, 연결하지 않은 이미지 보관함 전체는 옮기지 않는다.
- 기존의 `localStorage`·IndexedDB가 차단된 브라우저에서는 새로고침 후 영구 보존이 제한된다.
- Pack에는 미적용 GLSL 초안, 편집기 Undo 히스토리, HUD 표시 상태 등이 포함되지 않는다.
- `file://` 접근 허용 범위와 WebGL2 지원은 브라우저 정책·GPU에 따라 다르다.
