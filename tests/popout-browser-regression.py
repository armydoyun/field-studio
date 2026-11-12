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
            context.add_init_script("try { localStorage.setItem('field.onboarded.v1', '1') } catch (e) {}")  # PiP 창처럼 저장소가 막힌 문서에서도 테스트 자체가 오류를 내지 않게
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

            # 메인 창 편집기에서 띄운 대화상자(F2 같은 이름 바꾸기)와 Ctrl+O 프로젝트 메뉴는 분리 창이 아니라 메인 창에 뜬다.
            page.evaluate("shaderStudio.open()")
            page.wait_for_selector("#studioDock .cm-content")
            page.click("#studioDock .cm-content")
            page.evaluate("""() => { const area = document.getElementById('studioCode'), at = area.value.indexOf('uv') + 1;
                area.setSelectionRange(at, at); }""")
            page.keyboard.press("F2")
            expect(page.locator("#studioPromptDialog")).to_be_visible()
            assert popup.evaluate("!document.getElementById('studioPromptDialog')"), "이름 바꾸기 대화상자가 분리 창에 뜨면 안 된다"
            page.keyboard.press("Escape")
            expect(page.locator("#studioPromptDialog")).to_be_hidden()
            page.keyboard.press("Control+o")
            expect(page.locator("#projectMenu")).to_be_visible()
            assert popup.evaluate("!document.getElementById('projectMenu')"), "메인 창의 Ctrl+O 메뉴는 메인 창에 연다"
            page.keyboard.press("Escape")
            expect(page.locator("#projectMenu")).to_have_count(0)
            assert popup.evaluate("!!document.querySelector('#stageHeader #projectMenu')"), "닫으면 메뉴가 분리 창 머리줄로 돌아간다"
            page.evaluate("shaderStudio.close()")
            # 다시 분리 창에서 저장하면 대화상자는 분리 창에 뜬다.
            popup.click("#projectMenuToggle")
            popup.click("#studioProjectSaveAs")
            expect(popup.locator("#studioPromptDialog")).to_be_visible()
            assert page.evaluate("!document.getElementById('studioPromptDialog')")
            popup.keyboard.press("Escape")
            expect(popup.locator("#studioPromptDialog")).to_be_hidden()
            popup.click("#projectMenuToggle")
            expect(popup.locator("#projectMenu")).to_be_hidden()

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

            # 키보드 채널 셰이더: 분리 창 캔버스에서 누른 키는 셰이더로 가고, 메인 창 편집기로 돌아오면 Esc 없이 바로 입력된다.
            # (분리 창 안의 초점은 캔버스에 남아 있으므로, 메인 창의 키까지 셰이더가 가로채면 안 된다.)
            page.keyboard.press("x")
            page.locator("#gallery").get_by_text("Keyboard Control").first.click()
            page.wait_for_function("!document.querySelector('dialog[open]')")
            page.evaluate("shaderStudio.open()")
            popup = open_preview()
            popup.evaluate("window.__kd = []; addEventListener('keydown', e => setTimeout(() => __kd.push(e.defaultPrevented)), true)")
            popup.click("#screen")
            popup.keyboard.press("d")
            popup.wait_for_function("__kd.length > 0")
            assert popup.evaluate("__kd[0] === true"), "분리 창 캔버스에서 누른 키는 셰이더가 받는다"
            page.bring_to_front()
            page.click(".cm-content")
            page.keyboard.press("Control+End")
            before = page.evaluate("document.getElementById('studioCode').value.length")
            page.keyboard.type("zq")
            after = page.evaluate("document.getElementById('studioCode').value.length")
            assert after == before + 2, f"분리 창 캔버스에 초점이 남아 있어도 메인 편집기 입력은 막히지 않는다 ({before} → {after})"
            popup.close()
            page.wait_for_function("!shaderPopout.isOpen")

            # 미리보기 분리 + 편집기 확대: 편집기 밖에서 P · 편집기 안에서 Ctrl+K P로 켜고 끈다. 분리 창을 닫으면 확대도 끝난다.
            both_on = """shaderPopout.isOpen && document.getElementById('stage').classList.contains('studio-maximized')
                && document.getElementById('studioSplitEdit').getAttribute('aria-pressed') === 'true'"""
            both_off = """!shaderPopout.isOpen && !document.getElementById('stage').classList.contains('studio-maximized')
                && document.getElementById('studioSplitEdit').getAttribute('aria-pressed') === 'false'"""
            page.bring_to_front()
            page.evaluate("document.activeElement.blur()")
            with page.expect_popup():
                page.keyboard.press("p")
            page.wait_for_function(both_on)
            assert page.evaluate("!!document.activeElement.closest('.cm-editor')"), "분리 편집을 켜면 메인 창 편집기에 초점"
            page.click(".cm-content")
            page.keyboard.press("Control+k")
            page.keyboard.press("p")
            page.wait_for_function(both_off)
            with page.expect_popup() as opened:
                page.keyboard.press("Control+k")
                page.keyboard.press("p")
            page.wait_for_function(both_on)
            opened.value.close()
            page.wait_for_function(both_off)
            assert page.evaluate("shaderPlayground.getStats().running"), "분리 창을 닫고 확대가 끝나면 재생 상태는 그대로"
            assert not errors, errors
            print("PASS", "일반 팝업" if fallback else "PiP/지원 브라우저 기본 창", "상단 도구·저장·녹화·복귀", flush=True)
            context.close()
        browser.close()
finally:
    server.shutdown()
    server.server_close()
