// 앱 바탕 · 뷰포트의 우클릭 메뉴(context-menu.js에 등록). 항목은 툴바 · 더보기 메뉴의 버튼을 그대로 누른다 —
// 동작 · 꺼짐 상태 · 단축키가 버튼과 늘 같게. 버튼이 다음 동작을 aria-label로 알려 주면(예: '설정 패널 숨기기') 그 글자를 쓴다.
// 파라미터 줄 · 타임라인 · 편집기 · 패스 탭 · 프리셋처럼 자기 상태를 아는 영역은 그 모듈이 따로 등록한다.
import * as ContextMenu from "./context-menu.js";

const mount = ({ studio = () => window.shaderStudio, signal } = {}) => {
  // 미리보기 분리 창(popout.js)도 같은 우클릭 메뉴를 쓴다.
  document.addEventListener("preview-popout-window", event => ContextMenu.mount(event.detail?.document), { signal });
  // 분리 창으로 옮긴 미리보기의 버튼은 그 창 문서에 있으므로, 누른 자리의 문서부터 찾는다.
  const find = (doc, id) => doc.getElementById(id) || document.getElementById(id);
  const press = (doc, id, { label, icon, kbd, pressed, title, danger } = {}) => {
    const node = find(doc, id);
    // 버튼 자체가 숨겨져 있으면(지금 쓸 수 없는 동작) 항목을 빼고, 꺼져 있으면 흐리게 둔다.
    // 더보기 · 캡처 · 프로젝트 메뉴 안의 버튼은 메뉴가 닫혀 있어도 누를 수 있다.
    if (!node || node.hidden) return null;
    return {
      label: label || node.getAttribute("aria-label") || node.textContent.trim(),
      icon,
      kbd,
      title,
      danger,
      pressed,
      disabled: node.disabled,
      onSelect: () => node.click(),
    };
  };
  const on = id => document.getElementById(id)?.getAttribute("aria-pressed") === "true";

  // 뷰포트: 재생 · 캡처 · 보기
  ContextMenu.register(
    "#renderViewport,#screen",
    node => {
      const doc = node.ownerDocument,
        running = studio()?.getPlaybackState?.() !== false,
        recording = !find(doc, "recordStop")?.hidden;
      return {
        label: "미리보기",
        items: [
          press(doc, "previewPause", {
            label: running ? "일시정지" : "재생",
            icon: running ? "pause" : "play",
            kbd: "Space",
          }),
          press(doc, "stepFrame", { label: "한 프레임 진행", kbd: "." }),
          press(doc, "studioResetFrames", { label: "처음부터(시간 0)", icon: "reset" }),
          { separator: true },
          press(doc, "quickShot", { label: "스크린샷 저장", icon: "camera" }),
          recording
            ? press(doc, "recordStop", { label: "녹화 중지", icon: "video", danger: true })
            : press(doc, "recordButton", { label: "녹화 시작", icon: "video" }),
          press(doc, "videoRenderOpen", { label: "영상 렌더링…" }),
          { separator: true },
          press(doc, "fullscreenToggle", { icon: "expand", kbd: "F" }),
          press(doc, "hudToggle", { kbd: "G" }),
          press(doc, "previewPopout", { icon: "popout" }),
        ],
      };
    },
    { signal }
  );

  // 편집기 패스 탭: 누른 탭을 고른 뒤 패스 도구(복제 · 순서 · 삭제)와 추가
  ContextMenu.register(
    "#studioPassTabs [role=tab]",
    tab => {
      if (tab.getAttribute("aria-selected") !== "true") tab.click();
      const doc = document;
      return {
        label: `${tab.textContent.trim()} 패스`,
        items: [
          { title: tab.textContent.trim() },
          press(doc, "studioDuplicate", { label: "복제", icon: "copy" }),
          press(doc, "studioUp", { label: "실행 순서 앞으로", icon: "up" }),
          press(doc, "studioDown", { label: "실행 순서 뒤로", icon: "down" }),
          press(doc, "studioRemove", { label: "삭제", icon: "trash", danger: true }),
          { separator: true },
          press(doc, "studioAdd", { label: "새 버퍼 패스 추가", icon: "plus" }),
          press(doc, "studioAddCommon", { label: "Common 추가", icon: "plus" }),
        ],
      };
    },
    { signal }
  );

  // 바탕(다른 메뉴가 없는 곳): 프로젝트 · 창 열기 · 화면 배치
  ContextMenu.register(
    "body",
    (node, event) => {
      // 대화상자(갤러리 · 가이드 …) 안의 빈 곳은 바탕 메뉴를 띄우지 않는다(브라우저 기본 메뉴).
      if (event.target.closest?.("dialog")) return null;
      const doc = document;
      return {
        label: "FIELD Studio",
        items: [
          press(doc, "studioProjectSave", { label: "프로젝트 저장…", kbd: "Ctrl+S" }),
          press(doc, "projectMenuToggle", { label: "프로젝트 열기 · 파일", icon: "edit", kbd: "Ctrl+O" }),
          { separator: true },
          press(doc, "galleryToggle", { label: "예제 갤러리", kbd: "X" }),
          press(doc, "helpToggle", { label: "가이드 · 단축키", icon: "help", kbd: "?" }),
          { separator: true },
          press(doc, "panelToggle", { label: "설정 패널", kbd: "H", pressed: on("panelToggle") }),
          press(doc, "studioToggle", {
            label: "코드 편집기",
            icon: "code",
            kbd: "E",
            pressed: document.getElementById("studioToggle")?.getAttribute("aria-expanded") === "true",
          }),
          press(doc, "timelineToggle", {
            label: "타임라인",
            icon: "timeline",
            kbd: "T",
            pressed: on("timelineToggle"),
          }),
          { separator: true },
          press(doc, "themeToggle"),
        ],
      };
    },
    { signal }
  );
};

export { mount };
