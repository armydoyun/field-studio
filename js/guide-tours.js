const overview = [
  {
    target: "#renderViewport",
    title: "뷰포트",
    text: "셰이더 결과가 그려지는 곳입니다. 뷰포트를 클릭하면 키보드 채널을 쓰는 셰이더가 키 입력을 받아요(Esc로 나가기). 3D 예제는 드래그·방향키로 시점을 돌립니다.",
    prepare: "close-editor",
  },
  {
    target: "#stageToolbar",
    title: "툴바",
    text: "재생/일시정지 · 편집기 · 캡처(스크린샷·녹화) · 전체화면, 그리고 ⋯ 더보기(갤러리·가이드·패널·HUD·분리 창·테마)입니다. 필요한 작업은 주제별 둘러보기에서 더 자세히 배울 수 있습니다.",
    prepare: "stage",
  },
  {
    target: "#stats",
    title: "HUD",
    text: "FPS, 실제 렌더 해상도, 시간(uTime), 프레임 수, GPU 시간을 실시간으로 보여줍니다. G 키를 누르면 이 HUD와 위쪽 도구 막대까지 모두 숨겨 셰이더만 볼 수 있어요(다시 G · Esc).",
    prepare: "stage",
  },
  {
    target: "#panelTabs",
    title: "설정 패널",
    text: "렌더링 품질, 파라미터, 성능/디버그, 작업공간 설정이 탭으로 나뉘어 있습니다. H 키로 패널을 열고 닫아요.",
    prepare: "panel:render",
  },
  {
    target: "#view-uniforms",
    title: "파라미터",
    text: "슬라이더·색상·방향·패드로 Uniform 값을 실시간 조절합니다. GLSL 주석에 @range, @color, @dir, @enum 등을 달면 자동으로 여기에 생겨요.",
    prepare: "panel:uniforms",
  },
  {
    target: "#view-profile",
    title: "성능 · 디버그",
    text: "패스별 GPU 시간, 버퍼 썸네일, 픽셀 값, Uniform 진단을 확인합니다. 셰이더가 느리거나 결과가 이상할 때 먼저 보세요.",
    prepare: "panel:profile",
  },
  {
    target: "#studioPassTabs",
    title: "패스 탭",
    text: "Image(화면) · Common(공용 코드) · Buffer 패스를 오갑니다. 옆의 +로 오프스크린 패스를 추가해 여러 단계를 연결하고, + Common으로 모든 패스가 같이 쓰는 함수를 한 곳에 둘 수 있어요.",
    prepare: "open-editor",
  },
  {
    target: ".studio-editor-frame",
    title: "코드 편집기",
    text: "GLSL을 고치면 0.9초 뒤 자동 적용됩니다. 오류가 나면 해당 줄이 빨갛게 표시되고 줄 끝에 이유가 나와요.",
    prepare: "open-editor",
  },
  {
    target: "#studioRun",
    title: "실행 · 되돌리기",
    text: "Alt+Enter로 즉시 실행, Ctrl+S로 프로젝트 저장, Ctrl+Z로 코드·버퍼·파라미터 변경을 되돌립니다.",
    prepare: "open-editor",
  },
  {
    target: "#moreToggle",
    title: "가이드는 언제든",
    text: "⋯ 더보기 메뉴의 가이드나 ? 키로 가이드를 다시 열 수 있어요. 각 패널의 작은 ? 버튼은 해당 주제로 바로 이동합니다.",
    prepare: "close-editor",
  },
];
const step = (target, title, text, prepare) => ({ target, title, text, prepare });
const TOURS = [
  {
    id: "overview",
    title: "전체 화면 소개",
    summary: "처음 사용하는 사람을 위한 화면 구성과 기본 흐름",
    topic: "screen",
    steps: overview,
  },
  {
    id: "parameters",
    title: "파라미터 조절과 코드 반영",
    summary: "위젯·조건 숨김·변경 필터·기본값 반영",
    topic: "params",
    steps: [
      step(
        "#uniformSearch",
        "원하는 파라미터 찾기",
        "이름이나 타입으로 검색합니다. 조건으로 숨긴 항목도 검색하면 확인할 수 있습니다.",
        "panel:uniforms"
      ),
      step(
        "#uniformList",
        "값 조절하기",
        "어노테이션에 맞춰 숫자·색·방향·행렬 편집기가 나타납니다. 아직 항목이 없다면 갤러리의 Annotated Parameters 예제로 시작해 보세요.",
        "panel:uniforms"
      ),
      step(
        "#uniformChangedOnly",
        "바뀐 값만 확인하기",
        "변경됨 표시는 코드 기본값과의 차이입니다. 변경만 보기를 켜면 코드에 옮길 항목을 모아 볼 수 있습니다.",
        "panel:uniforms"
      ),
      step(
        "#uniformWriteDefaults",
        "코드의 기본값 갱신",
        "현재 값을 @default에 반영하면 다음 리셋도 이 값으로 돌아옵니다. 각 항목의 코드 반영 버튼으로 하나만 쓰거나, 일괄 반영 후 Ctrl+Z로 복원할 수 있습니다.",
        "panel:uniforms"
      ),
      step(
        ".parameter-actions",
        "변형 탐색",
        "마음에 드는 항목은 잠그고 전체 무작위나 조금씩 바꾸기를 사용합니다. 잠금·조건 숨김·연결·램프는 일괄 변경에서 제외됩니다.",
        "panel:uniforms"
      ),
      step(
        "#parameterCompare",
        "A/B로 선택하기",
        "A는 기억한 기준, B는 현재 편집 값입니다. A 미리보기는 저장 값을 바꾸지 않습니다. 기준으로 돌아가려면 A를 현재 값으로를 사용합니다.",
        "panel:uniforms"
      ),
    ],
  },
  {
    id: "presets",
    title: "프리셋 저장·비교·복원",
    summary: "값 묶음을 저장하고 호환되는 항목만 적용하기",
    topic: "presets",
    steps: [
      step(
        "#presetBar",
        "지금 값 저장",
        "지금 값 저장으로 값 묶음과 타입 정보를 기억합니다. 이름은 두 번 누르거나 관리 메뉴에서 바꿉니다.",
        "panel:uniforms"
      ),
      step(
        "#presetBar",
        "프리셋 적용",
        "칩을 누르면 호환되는 값만 적용됩니다. 전환 시간을 고르면 부드럽게 바뀌고, 다른 값을 직접 편집하면 전환이 멈춥니다.",
        "panel:uniforms"
      ),
      step(
        "#presetBar",
        "건너뛴 이유 확인",
        "적용 내역을 펼치면 타입·선택지·램프 종류·범위가 바뀐 항목과 연결된 항목을 확인할 수 있습니다. 이전 형식도 읽지만 원래 타입은 확인할 수 없습니다.",
        "panel:uniforms"
      ),
      step(
        "#parameterCompare",
        "비교하고 되돌리기",
        "A 기준이 없으면 적용 직전 값을 기억합니다. A/B로 비교한 뒤 B를 유지하거나 A를 적용하세요. 프리셋 적용은 Ctrl+Z 한 번으로 복원합니다.",
        "panel:uniforms"
      ),
    ],
  },
  {
    id: "editor",
    title: "코드 작성과 입력 채널",
    summary: "Image·Common·Buffer 편집, 실행과 오류 확인",
    topic: "editor",
    steps: [
      step(
        "#studioPassTabs",
        "어느 패스를 편집할까요?",
        "Image는 최종 화면, Common은 공용 코드, Buffer는 중간 계산입니다. 탭을 바꿔 각 소스를 편집합니다.",
        "open-editor"
      ),
      step(
        ".studio-editor-frame",
        "코드 편집",
        "GLSL을 고치면 자동 적용됩니다. F2로 이름을 바꾸거나 코드 조각을 삽입할 수 있으며, 미적용 초안은 마지막 성공 화면과 구분됩니다.",
        "open-editor"
      ),
      step(
        "#studioRun",
        "즉시 실행과 복원",
        "Alt+Enter로 실행합니다. Ctrl+S는 프로젝트 저장, Ctrl+Z는 편집 이력 복원입니다. 실행에 실패하면 마지막 성공 화면을 유지합니다.",
        "open-editor"
      ),
      step(
        "#studioChannels",
        "입력 채널 연결",
        "iChannel0~3에 이미지·미디어·키보드·버퍼를 연결합니다. current는 앞서 계산한 패스, previous는 직전 프레임을 읽습니다.",
        "channels"
      ),
      step(
        ".studio-editor-frame",
        "오류 읽기",
        "컴파일 오류의 줄과 이유를 먼저 확인하세요. 상태 표시와 전체 오류에서 자세히 보고, 성능 탭의 Uniform 진단으로 누락된 값도 확인할 수 있습니다.",
        "open-editor"
      ),
    ],
  },
  {
    id: "connections",
    title: "값에 움직임 연결하기",
    summary: "소리·MIDI·흔들기·키프레임 연결의 차이",
    topic: "connections",
    steps: [
      step(
        "#uniformList",
        "연결 버튼",
        "숫자 파라미터의 연결 버튼에서 입력을 고릅니다. 이 둘러보기는 현재 연결이나 값을 바꾸지 않습니다.",
        "panel:uniforms"
      ),
      step(
        "#uniformList",
        "소스와 값 범위",
        "소리·MIDI는 외부 입력, 흔들기는 시간 함수, 키프레임은 저장한 값입니다. 최소·최대는 소스를 파라미터 값으로 옮기는 범위입니다.",
        "panel:uniforms"
      ),
      step(
        "#uniformList",
        "입력 상태와 부드럽게 따라가기",
        "입력이 없으면 현재 값을 유지합니다. 흔들리는 입력은 부드럽게 따라가기 시간을 늘려 안정시킵니다. 연결된 값은 직접 편집보다 입력이 우선합니다.",
        "panel:uniforms"
      ),
      step(
        "#timelineDock",
        "키프레임으로 편집하기",
        "키프레임 연결은 아래 타임라인에서 다듬습니다. 한 번·반복과 끝과 처음 잇기는 연결 설정에서 고르고, 키의 시간·값·잇기는 타임라인에서 바꿉니다.",
        "timeline"
      ),
    ],
  },
  {
    id: "timeline",
    title: "타임라인과 스냅",
    summary: "키 선택·잇기·시간 및 값 스냅·자석",
    topic: "timeline",
    steps: [
      step(
        ".timeline-bar",
        "재생 위치와 배속",
        "재생 위치는 uTime입니다. 숫자로 이동하거나 아래 눈금을 누르며, 배속은 렌더링 탭과 같은 설정입니다.",
        "timeline"
      ),
      step(
        ".timeline-body",
        "키 선택과 이동",
        "빈 곳을 두 번 누르면 키를 추가합니다. 키를 누르거나 상자로 여러 키를 고르고 함께 이동합니다. Shift는 선택 추가 또는 한 축 이동, Delete는 선택한 키 삭제입니다.",
        "timeline"
      ),
      step(
        ".timeline-group:has(.timeline-magnet)",
        "격자와 자석",
        "시간·값 스냅은 이동 간격입니다. 자석은 재생선·다른 키·범위 끝에 붙이며 별도로 켤 수 있습니다. Alt를 누르고 끌면 둘 다 잠시 해제합니다.",
        "timeline"
      ),
      step(
        ".timeline-inspector",
        "선택한 키의 잇기",
        "시간·값을 직접 입력하고, 선택한 키에서 다음 키로 가는 잇기를 고릅니다. 여러 키의 잇기가 다르면 서로 다름으로 표시합니다.",
        "timeline"
      ),
    ],
  },
  {
    id: "rendering",
    title: "화질과 재생 조절",
    summary: "FPS·배속·한 프레임 진행·해상도",
    topic: "rendering",
    steps: [
      step(
        ".fps-presets",
        "프레임 제한",
        "Auto는 제한 없이 그립니다. FPS를 제한하면 자원을 줄일 수 있으며, 셰이더가 무거울 때 목표 FPS를 보장하는 설정은 아닙니다.",
        "panel:render"
      ),
      step(
        "#timeScaleTitle",
        "배속과 한 프레임 진행",
        "배속은 uTime의 진행 속도입니다. 한 프레임 진행은 재생을 멈추고 시간과 버퍼를 1/60초씩 넘깁니다.",
        "panel:render"
      ),
      step(
        "#resolutionScale",
        "해상도 배율",
        "비율을 낮추면 실제 계산하는 픽셀이 줄어듭니다. 화면이 느릴 때 먼저 조절하고 성능 탭에서 결과를 확인합니다.",
        "panel:render"
      ),
      step(
        "#maxPixels",
        "최대 픽셀 수",
        "화면 비율을 유지하면서 픽셀 수를 제한합니다. 영상 렌더링의 크기·FPS는 별도로 설정합니다.",
        "panel:render"
      ),
    ],
  },
  {
    id: "debugging",
    title: "성능과 버퍼 문제 찾기",
    summary: "GPU 시간·버퍼·픽셀·Uniform 진단",
    topic: "debug",
    steps: [
      step(
        "#profileChart",
        "먼저 무거운 패스 찾기",
        "프레임 기록과 패스별 GPU 시간을 비교합니다. GPU 타이머를 지원하지 않는 브라우저에서는 해당 수치가 제공되지 않습니다.",
        "panel:profile"
      ),
      step(
        "#profileBuffers",
        "버퍼 출력 확인",
        "썸네일을 누르면 해당 출력을 크게 봅니다. 다시 누르거나 Image 보기로 최종 화면에 돌아옵니다.",
        "panel:profile"
      ),
      step(
        ".profile-view-controls",
        "채널·노출·픽셀 값",
        "R/G/B/A를 분리하고 노출로 작은 값이나 HDR을 확인합니다. 선택한 버퍼 위의 포인터 위치에서 실제 픽셀 값을 읽습니다.",
        "panel:profile"
      ),
      step(
        "#profileUniforms",
        "Uniform 진단",
        "선언만 한 미등록 값과 타입 불일치를 확인합니다. 필요한 항목은 파라미터로 등록하고, 선언 타입이 잘못됐으면 코드를 고칩니다.",
        "panel:profile"
      ),
    ],
  },
  {
    id: "files",
    title: "저장과 내보내기",
    summary: "보관함·Pack·HTML·스크린샷·영상",
    topic: "files",
    steps: [
      step(
        "#projectMenu",
        "프로젝트 저장",
        "Ctrl+S로 이 브라우저 보관함에 저장합니다. 자동 복구본은 이름 붙여 보관한 프로젝트나 외부 백업을 대신하지 않습니다.",
        "project"
      ),
      step(
        "#studioExportPack",
        "다른 기기로 옮기기",
        "Pack은 코드·파라미터·프리셋·연결·이미지·설정을 담습니다. 중요한 작업은 파일로 내보내 별도로 보관하세요.",
        "project"
      ),
      step(
        "#studioExportHTML",
        "재생용 HTML",
        "HTML 내보내기는 작품을 재생하는 한 파일입니다. 다시 편집할 작업은 Pack도 함께 보관합니다. 코드만 내보내기는 이미지 원본과 파라미터를 포함하지 않습니다.",
        "project"
      ),
      step(
        "#quickShot",
        "이미지와 영상",
        "카메라는 스크린샷입니다. 캡처 메뉴의 녹화는 실시간 화면을, 영상 렌더링은 정해진 크기·FPS와 시간으로 프레임을 계산해 만듭니다.",
        "stage"
      ),
    ],
  },
  {
    id: "workspace",
    title: "화면 배치와 작업공간",
    summary: "패널·편집기 이동, HUD·테마·배치 초기화",
    topic: "workspace",
    steps: [
      step(
        "#panelGrip",
        "패널 위치와 너비",
        "이동 손잡이를 끌거나 방향키로 패널을 옮깁니다. 경계는 크기 조절, 두 번 클릭은 기본 크기 복원입니다.",
        "panel:input"
      ),
      step(
        "#view-input",
        "테마와 초기화",
        "테마·배치와 렌더링 설정을 여기서 바꿉니다. 화면 배치 초기화와 렌더링 설정 초기화는 코드·파라미터를 지우지 않습니다.",
        "panel:input"
      ),
      step(
        "#studioDock",
        "편집기와 HUD",
        "넓은 화면에서는 편집기를 네 방향에 배치할 수 있습니다. G는 HUD 숨기기, H는 패널, E는 편집기입니다. 좁은 화면은 서랍과 아래 편집기를 사용합니다.",
        "open-editor"
      ),
    ],
  },
];
export { TOURS };
