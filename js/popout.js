// 미리보기 분리: 셰이더 캔버스를 별도 창으로 옮긴다.
// - 크롬 116+ 데스크톱: Document Picture-in-Picture(항상 위에 뜨는 작은 창)
// - 그 밖의 브라우저: 일반 팝업(window.open, 보조 모니터로 옮기거나 크기를 자유롭게 바꿀 수 있음)
// 캔버스 요소 자체를 옮기므로 WebGL 컨텍스트·포인터 입력(uMouse·카메라 드래그)·픽셀 검사가 그대로 동작한다.
// 렌더 루프는 메인 창의 requestAnimationFrame을 쓰므로 메인 창을 최소화하면 브라우저가 프레임을 늦출 수 있다.
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
    };
  let target = null,
    marker = null,
    statusTimer = 0;

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
  const syncTheme = () => {
    if (!target) return;
    const theme = doc.documentElement.dataset.theme,
      root = target.document.documentElement;
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
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
    if (marker?.isConnected) marker.replaceWith(canvas);
    else doc.getElementById("renderViewport")?.prepend(canvas);
    marker = null;
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
    target = win;
    syncTheme();
    doc.addEventListener("theme-changed", syncTheme);
    marker = doc.createComment("preview canvas");
    canvas.replaceWith(marker);
    d.body.append(canvas);
    // 분리 창 안에서도 Space로 재생/정지, Esc로 되돌리기.
    d.addEventListener("keydown", event => {
      if (event.code === "Space") {
        event.preventDefault();
        view.shaderStudio?.togglePlayback();
      } else if (event.key === "Escape") restore();
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
  };
};

export { mount };
