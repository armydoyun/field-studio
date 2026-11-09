"""실제 PiP/일반 팝업에서 상단 도구·저장·녹화·메뉴와 원본 복귀를 검사한다."""
import functools
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import expect, sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


root = Path(__file__).resolve().parent.parent
server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(root)))
Thread(target=server.serve_forever, daemon=True).start()

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path=os.environ.get("CHROMIUM_PATH") or None,
            args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
        )
        for fallback in (False, True):
            context = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
            context.add_init_script("localStorage.setItem('field.onboarded.v1', '1')")
            if fallback:
                context.add_init_script("""Object.defineProperty(window, 'documentPictureInPicture', {
                    configurable: true, value: {requestWindow: async () => {
                        throw new DOMException('Test popup fallback', 'NotSupportedError');
                    }}
                })""")
            errors = []

            def watch(page):
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)

            context.on("page", watch)
            page = context.new_page()
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            page.wait_for_function("!!window.shaderStudio")
            page.evaluate("""() => {
                window.originalPreview = Object.fromEntries(
                    ['screen', 'stageHeader', 'studioPromptDialog', 'videoRenderDialog'].map(id => [id, document.getElementById(id)]));
            }""")

            def open_preview():
                page.click("#moreToggle")
                with page.expect_popup() as opened:
                    page.click("#previewPopout")
                result = opened.value
                result.wait_for_selector("#stageHeader")
                return result

            popup = open_preview()
            assert page.evaluate("!document.getElementById('stageHeader') && shaderPopout.isOpen")
            assert popup.evaluate("document.getElementById('stageHeader') === opener.originalPreview.stageHeader")
            expect(popup.locator("#renderState")).to_have_text("재생 중")
            popup.click("#previewPause")
            expect(popup.locator("#renderState")).to_have_text("일시정지")
            popup.click("#previewPause")
            expect(popup.locator("#renderState")).to_have_text("재생 중")

            # 메뉴는 분리 창 크기로 배치되고, 그 문서의 바깥 클릭·키보드로 닫힌다.
            popup.set_viewport_size({"width": 360, "height": 500})
            # 좁은 분리 창: 재생 상태 라벨은 숨기고(재생 버튼 아이콘이 상태를 보인다) 프로젝트 버튼·도구 막대가 겹치지 않는다.
            expect(popup.locator("#renderState")).to_be_hidden()
            assert popup.evaluate("""() => {
                const a = document.getElementById('projectMenuToggle').getBoundingClientRect(),
                  b = document.getElementById('stageToolbar').getBoundingClientRect();
                return a.right <= b.left + 1 && b.right <= innerWidth && a.left >= 0;
            }"""), "좁은 분리 창에서 프로젝트 버튼과 도구 막대가 겹치지 않는다"
            popup.click("#captureToggle")
            expect(popup.locator("#captureMenu")).to_be_visible()
            assert popup.evaluate("""() => {
                const r = document.getElementById('captureMenu').getBoundingClientRect();
                return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
            }""")
            popup.keyboard.press("ArrowDown")
            assert popup.evaluate("document.activeElement.id === 'screenshot2x'")
            popup.keyboard.press("Escape")
            expect(popup.locator("#captureMenu")).to_be_hidden()
            assert not popup.is_closed()
            popup.click("#captureToggle")
            popup.locator("#screen").click(position={"x": 10, "y": 300})
            expect(popup.locator("#captureMenu")).to_be_hidden()

            popup.keyboard.press("g")
            expect(popup.locator('[data-mirror="hud"]')).to_be_hidden()
            popup.keyboard.press("g")
            expect(popup.locator('[data-mirror="hud"]')).to_be_visible()

            popup.click("#projectMenuToggle")
            expect(popup.locator("#projectMenu")).to_be_visible()
            popup.click("#studioProjectSave")
            expect(popup.locator("#studioPromptDialog")).to_be_visible()
            name = "일반 창 저장" if fallback else "PiP 창 저장"
            popup.fill("#studioDialogInput", name)
            popup.locator("#studioDialogInput").press("End")
            popup.locator("#studioDialogInput").type(" g")
            # 이름의 공백·g가 재생이나 HUD 단축키로 새지 않는다.
            expect(popup.locator("#renderState")).to_have_text("재생 중")
            expect(popup.locator('[data-mirror="hud"]')).to_be_visible()
            popup.locator("#studioDialogInput").press("Enter")
            expect(popup.locator("#projectMenuLabel")).to_have_text(name + " g")
            assert page.evaluate("shaderStudio.projects.current().name") == name + " g"
            popup.keyboard.press("Escape")
            expect(popup.locator("#projectMenu")).to_be_hidden()
            assert not popup.is_closed()

            # 영상 설정도 같은 창에 열린다. Esc는 대화상자만 닫는다.
            popup.click("#captureToggle")
            popup.click("#videoRenderOpen")
            expect(popup.locator("#videoRenderDialog")).to_be_visible()
            popup.keyboard.press("Escape")
            expect(popup.locator("#videoRenderDialog")).to_be_hidden()
            assert not popup.is_closed()

            # PiP에서는 창 안에서 중지, 일반 팝업에서는 녹화 중 복귀한 뒤 메인에서 중지한다.
            popup.click("#captureToggle")
            popup.click("#recordButton")
            expect(popup.locator("#recordStop")).to_be_visible()
            popup.wait_for_function("/^\\d+:\\d{2}$/.test(document.getElementById('recordTime').textContent)")
            if fallback:
                popup.close()
                page.wait_for_function("!shaderPopout.isOpen")
                expect(page.locator("#recordStop")).to_be_visible()
                stop_page = page
            else:
                stop_page = popup
            with page.expect_download() as saved:
                stop_page.click("#recordStop")
            download = saved.value
            assert download.suggested_filename.endswith((".webm", ".mp4"))
            assert Path(download.path()).stat().st_size > 0
            expect(stop_page.locator("#recordStop")).to_be_hidden()
            if not fallback:
                popup.close()

            page.wait_for_function("!shaderPopout.isOpen")
            assert page.evaluate("""Object.entries(originalPreview).every(([id, node]) => document.getElementById(id) === node)""")
            expect(page.locator("#previewPopoutNotice")).to_be_hidden()
            popup = open_preview()
            popup.click("#projectMenuToggle")
            popup.click("#studioProjectSaveAs")
            expect(popup.locator("#studioPromptDialog")).to_be_visible()
            popup.close()
            page.wait_for_function("!shaderPopout.isOpen && !document.getElementById('studioProjectSave').disabled")
            expect(page.locator("#studioPromptDialog")).to_be_hidden()
            assert not errors, errors
            print("PASS", "일반 팝업" if fallback else "PiP/지원 브라우저 기본 창", "상단 도구·저장·녹화·복귀", flush=True)
            context.close()
        browser.close()
finally:
    server.shutdown()
    server.server_close()
