// 반복되는 앱 명령의 이름·단축키·체크 상태. 메뉴의 배치와 아이콘은 각 메뉴가 정한다.
const isOn = node => node.getAttribute("aria-pressed") === "true" || node.getAttribute("aria-expanded") === "true";
const ALIASES = { studioPause: "previewPause", studioHelp: "helpToggle", quickShot: "screenshotButton" };
const commandId = id => ALIASES[id] || id;
const DEFINITIONS = {
  studioProjectSave: { label: "저장", kbd: "Ctrl+S" },
  studioProjectSaveAs: { label: "다른 이름으로 저장…", kbd: "Ctrl+Shift+S" },
  projectMenuToggle: { label: "프로젝트 열기…", kbd: "Ctrl+O" },
  studioUndo: { label: "되돌리기", kbd: "Ctrl+Z" },
  studioRedo: { label: "다시 실행", kbd: "Ctrl+Y" },
  studioReset: { label: "새 프로젝트 (기본 장면)" },
  studioImportPack: { label: "프로젝트 파일 열기…" },
  studioExportPack: { label: "프로젝트 파일로 내보내기" },
  studioExportHTML: { label: "HTML로 내보내기 (재생 전용)" },
  studioTextureAdd: { label: "이미지 파일 불러오기…" },
  versionOpen: { label: "버전 기록…" },
  panelToggle: { label: "설정 패널", kbd: "H", pressed: isOn },
  studioToggle: { label: "셰이더 편집기", kbd: "E", pressed: isOn },
  timelineToggle: { label: "타임라인", kbd: "T", pressed: isOn },
  hudToggle: { label: "HUD", kbd: "G", pressed: isOn },
  menuBarShow: { label: "메뉴 바 보이기", kbd: "F10" },
  helpToggle: { label: "가이드 · 단축키", kbd: "?" },
  galleryToggle: { label: "예제 갤러리", kbd: "X" },
  previewPause: { command: "재생 / 일시정지", kbd: "Space" },
  stepFrame: { label: "한 프레임 진행", kbd: "." },
  studioResetFrames: { label: "시간 · 프레임 초기화" },
  screenshotButton: { label: "스크린샷 저장" },
  videoRenderOpen: { label: "영상 렌더링…" },
  fullscreenToggle: { command: "전체화면 전환", kbd: "F" },
  previewPopout: { command: "미리보기 분리 창 전환", pressed: isOn },
  themeToggle: { command: "테마 바꾸기 (라이트 · 다크)" },
  recordButton: { command: "녹화 시작 / 중지" },
  studioLayout: { command: "편집기 배치 바꾸기 (옆 ~ 위아래)", kbd: "Ctrl+\\" },
  studioMaximize: { label: "집중 모드 (코드 크게)", command: "집중 모드 전환", kbd: "Ctrl+K Z", pressed: isOn },
  studioSplitEdit: {
    label: "미리보기는 별도 창 · 편집기는 화면 가득",
    command: "미리보기 분리 + 편집기 확대 (전환)",
    kbd: "Ctrl+K P · P",
    pressed: isOn,
  },
};

const buttonLabel = node => {
  const accessible = node.getAttribute("aria-label");
  if (accessible) return accessible;
  // 이름에 단축키·파일 형식·장식 문자가 섞이지 않게 본문만 읽는다.
  const copy = node.cloneNode?.(true);
  copy?.querySelectorAll("kbd,svg,[aria-hidden=true]").forEach(child => child.remove());
  return (copy || node).textContent.trim().replace(/\s+/g, " ");
};
const presentation = (id, node) => {
  const definition = DEFINITIONS[commandId(id)] || {};
  const label = definition.label || buttonLabel(node);
  return {
    label,
    command: definition.command || definition.label,
    kbd: definition.kbd,
    pressed: definition.pressed?.(node),
  };
};
// 팔레트 이름은 상태에 따라 바뀌는 버튼 본문 대신 고정된 명령 이름을 쓴다.
const command = (id, label, key) => {
  const definition = DEFINITIONS[commandId(id)] || {};
  return { id: commandId(id), label: definition.command || definition.label || label, key: definition.kbd || key };
};
const item = (lookup, id, options = {}) => {
  const node = lookup(id),
    { keepHidden = false, collecting = false, before, ...overrides } = options;
  if (!node || (node.hidden && !keepHidden && !collecting)) return null;
  const state = { ...presentation(id, node), ...overrides };
  if (typeof state.pressed === "function") state.pressed = state.pressed(node);
  return {
    ...state,
    button: commandId(id),
    title: state.title || node.title,
    disabled: !!node.disabled,
    onSelect: () => {
      const current = lookup(id);
      if (!current || current.disabled || (current.hidden && !keepHidden)) return;
      before?.();
      current.click();
    },
  };
};

const syncMenu = menu => {
  for (const node of menu.querySelectorAll("button[id]")) {
    if (!DEFINITIONS[commandId(node.id)]) continue;
    const state = presentation(node.id, node);
    const label = node.querySelector(':scope > span:not([aria-hidden="true"])');
    if (label) label.textContent = state.label;
    if (state.kbd) {
      let key = node.querySelector("kbd");
      if (!key) {
        key = node.ownerDocument.createElement("kbd");
        node.append(key);
      }
      key.textContent = state.kbd;
    }
  }
};

export { command, item, syncMenu };
