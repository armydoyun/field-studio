"""실제 새로고침·창 크기 변경·전체화면·분리 창 복귀 후 표시 상태를 검사한다."""
import functools
import os
import re
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


def ready(page):
    page.wait_for_function("!!window.shaderStudio && !!window.shaderPlayground")


def view_command(page, label):
    page.locator('#menuBar [data-menu="view"]').click()
    page.locator('.ui-menu[role="menu"] [role="menuitem"]').filter(has_text=re.compile("^" + label)).click()


try:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True, executable_path=os.environ.get("CHROMIUM_PATH") or None,
            args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
        )
        try:
            for theme in ("dark", "light"):
                context = browser.new_context(viewport={"width": 1440, "height": 900})
                context.add_init_script(f"localStorage.setItem('field.onboarded.v1','1'); localStorage.setItem('field.theme.v1','{theme}');")
                # 일반 팝업 경로를 고정해 반복 분리·복귀를 실제 창에서 확인한다.
                context.add_init_script("Object.defineProperty(window,'documentPictureInPicture',{value:undefined,configurable:true}); delete window.documentPictureInPicture;")
                errors = []
                context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
                page = context.new_page()
                page.goto(f"http://127.0.0.1:{server.server_port}/")
                ready(page)
                expect(page.locator("html")).to_have_attribute("data-theme", theme)

                # 패널 닫기 직후 새로고침해도 상태를 잃지 않는다(자동 저장 타이머를 기다리지 않는다).
                page.locator("#panelToggle").click()
                page.reload()
                ready(page)
                expect(page.locator("#panelToggle")).to_have_attribute("aria-pressed", "false")
                page.keyboard.press("h")
                expect(page.locator("#panelToggle")).to_have_attribute("aria-pressed", "true")

                # 편집기·타임라인·메뉴 바의 서로 다른 저장 경로를 함께 확인한다.
                page.locator("#studioToggle").click()
                view_command(page, "타임라인")
                view_command(page, "메뉴 바")
                page.reload()
                ready(page)
                expect(page.locator("#appBar")).to_be_hidden()
                expect(page.locator("#studioDock")).to_be_visible()
                expect(page.locator("#timelineDock")).to_be_visible()
                page.keyboard.press("F10")
                expect(page.locator("#appBar")).to_be_visible()
                page.reload()
                ready(page)
                expect(page.locator("#appBar")).to_be_visible()

                # 좁은 화면의 서랍은 새로고침 후 닫히고, 다시 열고 닫을 때 inert와 초점도 복구된다.
                page.set_viewport_size({"width": 760, "height": 900})
                page.reload()
                ready(page)
                expect(page.locator("#panelToggle")).to_have_attribute("aria-pressed", "false")
                page.locator("#panelToggle").click()
                assert page.locator("#stage").evaluate("node => node.inert")
                page.locator("#panelClose").click()
                assert not page.locator("#stage").evaluate("node => node.inert")
                expect(page.locator("#panelToggle")).to_be_focused()
                page.set_viewport_size({"width": 1440, "height": 900})
                # 전체화면 전후 HUD와 메뉴 상태를 보존한다.
                page.locator("#studioToggle").click()
                view_command(page, "타임라인")
                page.locator("#fullscreenToggle").click()
                page.wait_for_function("!!document.fullscreenElement")
                expect(page.locator("#fullscreenToggle")).to_have_attribute("aria-label", "전체화면 종료")
                page.keyboard.press("g")
                expect(page.locator("#hudReveal")).to_be_visible()
                page.keyboard.press("Escape")
                page.wait_for_function("!document.getElementById('stage').classList.contains('hud-hidden')")
                page.locator("#fullscreenToggle").click()
                page.wait_for_function("!document.fullscreenElement")
                expect(page.locator("#fullscreenToggle")).to_have_attribute("aria-label", "전체화면")

                # 이동한 툴바를 메뉴 바에서도 찾고, 분리 창에서도 F10으로 복구한다.
                for _ in range(2):
                    page.evaluate("window.originalCanvas = document.getElementById('screen')")
                    with page.expect_popup() as opened:
                        view_command(page, "미리보기를 별도 창으로")
                    popup = opened.value
                    popup.wait_for_selector("#stageHeader")
                    view_command(page, "메뉴 바")
                    popup.locator("#moreToggle").click()
                    expect(popup.locator("#menuBarShow")).to_be_visible()
                    popup.keyboard.press("F10")
                    expect(page.locator("#appBar")).to_be_visible()
                    expect(popup.locator("#menuBarShow")).to_be_hidden()
                    # 분리된 상태에서도 보기 > HUD가 원본 버튼에 연결된다.
                    view_command(page, "HUD")
                    popup.wait_for_function("document.body.classList.contains('hud-hidden')")
                    popup.keyboard.press("Escape")
                    popup.wait_for_function("!document.body.classList.contains('hud-hidden')")
                    popup.close()
                    page.wait_for_function("!shaderPopout.isOpen")
                    assert page.evaluate("document.getElementById('screen') === originalCanvas")
                    expect(page.locator("#captureToggle")).to_have_attribute("aria-expanded", "false")
                    expect(page.locator("#previewPopoutNotice")).to_be_hidden()
                assert not errors, errors
                context.close()
                print(f"PASS {theme}: 새로고침 · 좁은 화면 · 전체화면 · 반복 분리/복귀")
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
