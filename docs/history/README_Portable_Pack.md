# Portable Pack v3 — 작업 상태까지 이동

Shader Studio의 **PROJECT FILE** 영역에 두 종류의 저장 방식을 제공한다.

- **Export JSON / Import JSON**: 이전과 동일한 가벼운 프로젝트 파일(버퍼, 채널, GLSL). 이미지 원본은 포함하지 않는다.
- **Export Pack / Import Pack**: 버퍼/GLSL/채널 연결 + 실제로 연결된 이미지 원본(PNG/JPEG/WebP) + Filter/Wrap + 앱 설정·사용자 Uniform을 하나의 `.json` 파일에 넣는다.

## 사용 순서

1. 현재 패스 편집 내용을 확인한 뒤 **Export Pack**을 누른다.
2. 저장된 `shader-studio-pack.json`을 다른 컴퓨터로 옮긴다.
3. 새 브라우저에서 Shader Studio를 연 뒤 **Import Pack**을 누른다.
4. 파일을 선택하면 이미지가 등록되고, 새 이미지 ID로 채널이 연결되며 프로젝트가 적용된다.

이미지가 **연결된 채널에 실제 사용 중인 경우에만** Pack에 포함된다. 아직 연결하지 않은 개인 이미지 보관함 전체를 이 파일로 백업하는 기능은 아니다. 그 이미지는 별도로 보관해야 한다.

## 파일 내용과 한계

- 형식 버전: `version: 3` (기존 version 2 Pack 가져오기도 지원); 이전 `version: 1` JSON 프로젝트와 혼용하지 않는다.
- 이미지당 최대 12MB, 이미지 총 원본 용량 최대 32MB, 가져오기 파일 최대 48MB.
- JSON은 Base64 때문에 파일 크기가 원본 이미지 파일 합계보다 커진다.
- 이미지의 기존 ID가 다른 브라우저에서 이미 사용 중이어도, 새 ID를 부여하고 채널 참조를 자동으로 변경한다.
- 잘못된 이미지 데이터, 누락된 채널 이미지, Uniform 타입/범위 충돌, GLSL 사전 컴파일 오류는 가져오기를 거부한다. 중간 이미지 등록에 실패하면 새로 추가했던 이미지들을 되돌린다.
- IndexedDB가 차단되어 있으면 가져온 이미지는 현재 탭에서만 살아 있을 수 있으며, 화면에 저장 불가 안내가 표시된다.
- **사용자 Uniform 목록·값·슬라이더 범위, 필수 Uniform 값(카메라), FPS·해상도·Ray Marching 설정, 히트맵·패널 표시 상태도 Pack에 포함한다.** 이전 version 2 Pack은 해당 설정을 변경하지 않고 복원한다. 단독 `Export JSON`은 계속 소스·채널만 포함한다.
- `file://`에서도 파일 선택과 JSON 읽기를 사용할 수 있으나 다운로드·IndexedDB 영속성은 브라우저 정책에 따라 달라질 수 있다.

## 수정 위치

- `index.html`: Pack 저장/불러오기 버튼 2개와 숨겨진 파일 입력창.
- `js/studio.js`: Base64 내보내기, 입력 검증, 텍스처 ID 재매핑, 실패 정리.
- `js/renderer.js`: Pack의 Uniform과 GLSL을 함께 사전 컴파일한 뒤 안전하게 적용한다.
- `js/settings.js`: 설정값 검증·적용·스냅샷을 담당한다.
- `js/ui.js`, `js/main.js`: 설정 적용 후 패널 상태 동기화, Studio 설정 API 전달.

새 실행 모듈은 추가하지 않았고, Ray Marching·Pass Manager·GLSL 원본은 수정하지 않았다.

**복구 범위:** FPS·해상도·히트맵·Ray Marching·필수/사용자 Uniform·패널 접힘 상태를 포함한다. 별도 편집기 임시 Draft·Undo 기록·HUD/탭 위치·브라우저 자체 저장소 전체는 포함하지 않는다. 데이터 파일만 이동하므로 새 환경에서 GPU 기능 지원 여부는 별도로 확인해야 한다.
