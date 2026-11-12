// 미리보기 분리: 셰이더 캔버스를 별도 창으로 옮긴다.
// - 크롬 116+ 데스크톱: Document Picture-in-Picture(항상 위에 뜨는 작은 창)
// - 그 밖의 브라우저: 일반 팝업(window.open, 보조 모니터로 옮기거나 크기를 자유롭게 바꿀 수 있음)
// 캔버스 요소 자체를 옮기므로 WebGL 컨텍스트·포인터 입력(uMouse·카메라 드래그)·픽셀 검사가 그대로 동작한다.
// 렌더 루프는 메인 창의 requestAnimationFrame을 쓰므로 메인 창을 최소화하면 브라우저가 프레임을 늦출 수 있다.
import * as Keys from "./keys.js";

const POPUP_NAME = "field-preview";

const mount = ({ doc = document } = {}) => {
  const view = doc.defaultView,
    $ = id => doc.getElementById(id);
  const canvas = $("screen"),
    button = $("previewPopout"),
    notice = $("previewPopoutNotice"),
    back = $("previewPopoutReturn"),
    status = $("previewNotice");
  if (!canvas || !button)
    return {
      open: async () => null,
      close() {},
      toggle() {},
      get isOpen() {
        return false;
      },
      activeDocument: () => doc,
      place: () => doc,
    };
  // 마지막으로 사용자가 조작한(누르거나 키를 친) 창의 문서. 대화상자·프로젝트 메뉴는 이 창에 띄운다
  // (분리 창의 프로젝트 메뉴에서 저장하면 분리 창에, 메인 창 편집기에서 F2를 누르면 메인 창에).
  let lastInput = doc;
  const noteInput = d => () => {
    lastInput = d;
  };
  for (const type of ["pointerdown", "keydown", "focusin"]) doc.addEventListener(type, noteInput(doc), true);
  let target = null,
    marker = null,
    moved = [],
    statusTimer = 0,
    hudObserver = null;
  // HUD(왼쪽 아래 미리보기 정보 · 오른쪽 아래 FPS·해상도·시간·프레임·GPU)도 분리 창에 보인다.
  // 원래 HUD는 설정 패널(ui.js)이 id로 찾아 갱신하므로 메인 문서에 그대로 두고, 분리 창에는 사본을 두어
  // 바뀔 때마다(MutationObserver) 내용을 옮겨 적는다. HUD 숨기기(G)도 따라간다. 메인 창의 HUD는 CSS로 숨긴다.
  const footer = $("viewportFooter"),
    stage = $("stage"),
    header = $("stageHeader"),
    prompt = $("studioPromptDialog"),
    videoDialog = $("videoRenderDialog");
  // 상단 도구와 대화상자는 원본을 옮긴다. 녹화·프로젝트 메뉴의 이벤트와 갱신을 그대로 유지한다.
  const moveControls = d => {
    moved = [header, prompt, videoDialog].filter(Boolean).map(node => {
      const placeholder = doc.createComment(`preview ${node.id}`);
      node.replaceWith(placeholder);
      d.body.append(node);
      return { node, placeholder };
    });
  };
  const mirrorHud = (copy, d) => () => {
    copy.className = footer.className;
    copy.innerHTML = footer.innerHTML;
    for (const node of copy.querySelectorAll("[id]")) node.removeAttribute("id");
    d.body.classList.toggle("hud-hidden", !!stage?.classList.contains("hud-hidden"));
  };
  const attachHud = (win, d) => {
    if (!footer || !win.MutationObserver) return;
    const copy = d.createElement("div");
    copy.dataset.mirror = "hud";
    d.body.append(copy);
    const mirror = mirrorHud(copy, d);
    mirror();
    hudObserver = new win.MutationObserver(mirror);
    hudObserver.observe(footer, { subtree: true, childList: true, characterData: true, attributes: true });
    if (stage) hudObserver.observe(stage, { attributes: true, attributeFilter: ["class"] });
  };

  const tell = message => {
    if (!status) return;
    clearTimeout(statusTimer);
    status.textContent = message;
    status.hidden = !message;
    if (message)
      statusTimer = setTimeout(() => {
        status.hidden = true;
        status.textContent = "";
      }, 6000);
  };
  // 새 창은 빈 문서이므로 이 페이지의 스타일을 그대로 복사한다. 읽을 수 없는 외부 시트는 링크로 건다.
  const copyStyles = win => {
    for (const sheet of doc.styleSheets) {
      try {
        const style = win.document.createElement("style");
        style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join("\n");
        win.document.head.append(style);
      } catch {
        if (sheet.href) {
          const link = win.document.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          win.document.head.append(link);
        }
      }
    }
  };
  // 분리 창에는 메인 창이 '실제로 쓰는' 테마를 그대로 박는다. '시스템 설정 따르기'일 때 메인 창은 data-theme 없이
  // prefers-color-scheme를 따르는데, 분리 창(특히 Picture-in-Picture 창)은 그 미디어 쿼리를 다르게 볼 수 있어
  // 메인은 라이트인데 분리 창만 다크로 뜨는 일이 있었다. 테마를 바꾸면(theme-changed) 다시 맞춘다.
  const resolvedTheme = () =>
    view.shaderTheme?.theme ||
    doc.documentElement.dataset.theme ||
    (view.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const syncTheme = () => {
    if (!target) return;
    const theme = resolvedTheme(),
      root = target.document.documentElement;
    root.dataset.theme = theme;
    if (root.style) root.style.colorScheme = theme;
  };
  const sync = () => {
    const open = !!target;
    doc.body.classList.toggle("preview-popped", open);
    if (notice) notice.hidden = !open;
    button.setAttribute("aria-pressed", String(open));
    const label = open ? "미리보기를 원래 자리로 되돌리기" : "미리보기를 별도 창으로 분리";
    button.setAttribute("aria-label", label);
    button.title = label;
    doc.dispatchEvent(new CustomEvent("preview-popout-changed", { detail: { open } }));
  };
  // 창을 닫으면(직접 닫기 · 되돌리기 · 메인 페이지 이동) 캔버스를 원래 자리에 다시 꽂는다.
  const restore = () => {
    if (!target) return;
    const win = target;
    target = null;
    lastInput = doc;
    if (marker?.isConnected) marker.replaceWith(canvas);
    else doc.getElementById("renderViewport")?.prepend(canvas);
    marker = null;
    for (const { node, placeholder } of moved) {
      // 닫히는 창의 모달은 취소해서 입력 요청을 기다리는 Promise도 끝낸다. 메인 창에 띄운 모달(place)은 그대로 둔다.
      if (node.open && node.tagName === "DIALOG" && node.ownerDocument === win.document) {
        // pagehide에서 예약된 close 이벤트는 닫힌 창에 남을 수 있어, 취소를 동기적으로 알린다.
        node.dispatchEvent(new view.Event("cancel", { cancelable: true }));
        if (node.open) node.close();
      }
      // 메인 창에 띄워 둔 채 열려 있는 모달은 옮기지 않는다(옮기면 모달 상태가 풀린다). 표식만 지운다.
      if (node.open && node.ownerDocument === doc && node.tagName === "DIALOG") placeholder.remove?.();
      else placeholder.replaceWith(node);
    }
    moved = [];
    hudObserver?.disconnect();
    hudObserver = null;
    doc.removeEventListener("theme-changed", syncTheme);
    if (!win.closed) win.close();
    sync();
    canvas.focus?.({ preventScroll: true });
  };
  const open = async () => {
    if (target) {
      target.focus();
      return target;
    }
    const rect = canvas.getBoundingClientRect(),
      aspect = rect.width && rect.height ? rect.height / rect.width : 9 / 16;
    const width = Math.round(Math.min(Math.max(rect.width * 0.5, 320), 960)),
      height = Math.round(Math.min(Math.max(width * aspect, 180), 720));
    const popup = () => view.open("", POPUP_NAME, `popup,width=${width},height=${height}`);
    let win = null;
    if ("documentPictureInPicture" in view) {
      // PiP를 지원한다고 알려도 실행 환경(내장 브라우저·정책 등)에 따라 창을 못 만들 수 있다. 클릭이 없어서 거절된 경우만 그대로 알리고, 나머지는 일반 팝업으로 대신한다.
      try {
        win = await view.documentPictureInPicture.requestWindow({ width, height });
      } catch (error) {
        if (error?.name === "NotAllowedError") throw error;
        win = popup();
      }
    } else win = popup();
    if (!win) throw new Error("팝업이 차단되었습니다. 주소창에서 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.");
    const d = win.document;
    d.head.replaceChildren();
    d.body.replaceChildren();
    const meta = d.createElement("meta");
    meta.setAttribute("charset", "utf-8");
    d.head.append(meta);
    d.title = "FIELD 미리보기";
    d.documentElement.lang = "ko";
    copyStyles(win);
    d.body.className = "preview-popout-window";
    for (const type of ["pointerdown", "keydown", "focusin"]) d.addEventListener(type, noteInput(d), true);
    target = win;
    syncTheme();
    doc.addEventListener("theme-changed", syncTheme);
    marker = doc.createComment("preview canvas");
    canvas.replaceWith(marker);
    d.body.append(canvas);
    moveControls(d);
    attachHud(win, d);
    // 분리 창 안에서도 Space로 재생/정지, G로 HUD 보이기/숨기기, Esc로 되돌리기.
    d.addEventListener("keydown", event => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.target?.closest?.("input, textarea, select, [contenteditable], dialog[open]")) return;
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          const key = Keys.latinKey(event);
          if (key === "s" && event.shiftKey) {
            event.preventDefault();
            header?.querySelector("#studioProjectSave:not(:disabled)")?.click();
          } else if (key === "o") {
            event.preventDefault();
            header?.querySelector("#projectMenuToggle")?.click();
          }
        }
        return;
      }
      if (event.code === "Space") {
        if (event.target?.closest?.("button")) return;
        event.preventDefault();
        view.shaderStudio?.togglePlayback();
      } else if (Keys.latinKey(event) === "p" && !event.shiftKey) {
        // 미리보기 분리 + 편집기 확대를 끝낸다(메인 창과 같은 키).
        event.preventDefault();
        view.shaderStudio?.splitEdit?.();
      } else if (Keys.latinKey(event) === "g" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        header?.querySelector("#hudToggle")?.click();
      } else if (event.key === "Escape" && d.body.classList.contains("hud-hidden")) {
        // HUD를 숨긴 동안의 Esc는 HUD만 되돌린다(창은 그대로).
        event.preventDefault();
        header?.querySelector("#hudReveal")?.click();
      } else if (event.key === "Escape") {
        // 저장 뒤 초점이 본문으로 돌아와도, 먼저 열린 메뉴만 닫는다.
        for (const [menuId, toggleId] of [
          ["projectMenu", "projectMenuToggle"],
          ["captureMenu", "captureToggle"],
          ["moreMenu", "moreToggle"],
        ]) {
          if (header?.querySelector(`#${menuId}:not([hidden])`)) {
            event.preventDefault();
            header.querySelector(`#${toggleId}`).click();
            return;
          }
        }
        restore();
      }
    });
    // 편집기·설정·갤러리·가이드는 메인 창에 열리므로 해당 도구를 누르면 그 창을 보여 준다.
    d.addEventListener("click", event => {
      if (
        ["studioToggle", "panelToggle", "galleryToggle", "helpToggle"].includes(event.target?.closest?.("button")?.id)
      )
        view.focus();
    });
    win.addEventListener("pagehide", restore, { once: true });
    sync();
    return win;
  };
  const toggle = () =>
    target
      ? restore()
      : open().catch(error => {
          tell(`미리보기 분리 실패: ${error.message}`);
        });
  button.addEventListener("click", toggle);
  back?.addEventListener("click", restore);
  view.addEventListener("pagehide", restore);
  return {
    open,
    close: restore,
    toggle,
    get isOpen() {
      return !!target;
    },
    // 대화상자·메뉴를 띄울 문서: 분리 창이 열려 있고 사용자가 마지막으로 그 창을 조작했으면 분리 창, 아니면 메인 창.
    activeDocument: () => (target && !target.closed && lastInput === target.document ? target.document : doc),
    // node(<dialog> 등)를 지금 사용자가 보고 있는 창으로 옮긴다. 원래 자리는 분리 창을 닫을 때 popout이 되돌린다.
    place: node => {
      const host = target && !target.closed && lastInput === target.document ? target.document : doc;
      if (node && node.ownerDocument !== host) host.body.append(node);
      return host;
    },
  };
};

export { mount };
