"""실제 창의 반복 종료 후 이벤트/관찰자 해제와 초기화 도중 종료를 검사한다."""
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
url = f"http://127.0.0.1:{server.server_port}/"



try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get("CHROMIUM_PATH") or None,
                                    args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        try:
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            context.add_init_script("""localStorage.setItem('field.onboarded.v1','1');
                Object.defineProperty(window,'documentPictureInPicture',{configurable:true,value:{requestWindow:async()=>{throw new DOMException('Test fallback','NotSupportedError')}}});
                const nativeOpen = window.open;
                const track = target => {
                    const records = [], add = target.addEventListener, remove = target.removeEventListener;
                    const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
                    const forget = record => {
                        const index = records.indexOf(record); if (index >= 0) records.splice(index,1);
                        record.signal?.removeEventListener('abort',record.abort);
                    };
                    target.addEventListener = function(type, fn, options) {
                        if (options?.signal?.aborted) return add.call(this,type,fn,options);
                        if (records.some(r=>r.type===type&&r.fn===fn&&r.capture===capture(options))) return;
                        const record = {type,fn,capture:capture(options),signal:options?.signal};
                        record.wrapped = options?.once ? function(event) {
                            forget(record);
                            if (typeof fn==='function') return fn.call(this,event);
                            return fn.handleEvent(event);
                        } : fn;
                        record.abort = () => forget(record);
                        add.call(this,type,record.wrapped,options);
                        records.push(record);
                        record.signal?.addEventListener('abort',record.abort,{once:true});
                    };
                    target.removeEventListener = function(type, fn, options) {
                        const record = records.find(r=>r.type===type&&r.fn===fn&&r.capture===capture(options));
                        remove.call(this,type,record?.wrapped||fn,options); if(record)forget(record);
                    };
                    return records;
                };
                window.open = function(...args) {
                    const win = nativeOpen.apply(this,args);
                    if(win) window.retiredTrackers = {document:track(win.document),window:track(win)};
                    return win;
                };
                const Original = MutationObserver;
                window.liveObservers = new Set();
                window.MutationObserver = class extends Original {
                    observe(...args) { liveObservers.add(this); return super.observe(...args); }
                    disconnect() { liveObservers.delete(this); return super.disconnect(); }
                };""")
            errors = []
            context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
            page = context.new_page()
            page.goto(url)
            page.wait_for_function("!!window.shaderStudio")
            baseline = page.evaluate("liveObservers.size")
            for _ in range(3):
                page.locator('#menuBar [data-menu="view"]').click()
                with page.expect_popup() as opened:
                    page.locator('.ui-menu [role^="menuitem"]').filter(has_text=re.compile("^미리보기를 별도 창으로")).click()
                popup = opened.value
                popup.wait_for_selector("#stageHeader")
                # 상단 도구와 옮긴 선택 상자가 문서별 구독을 실제로 만든다.
                page.wait_for_function("liveObservers.size > 0")
                assert page.evaluate("retiredTrackers.document.some(record=>record.type==='contextmenu')")
                popup.locator("#captureToggle").click()
                popup.locator("#videoRenderOpen").click()
                expect(popup.locator("#videoRenderDialog")).to_be_visible()
                popup.close()
                page.wait_for_function("!shaderPopout.isOpen")
                page.wait_for_function("liveObservers.size === " + str(baseline))
                # Playwright가 클릭 검사에 주입한 전역 핸들러는 앱 소유 구독이 아니다.
                application_listeners = "records => records.filter(r=>!r.type.startsWith('__playwright_')&&!String(r.fn).includes('_hitTargetInterceptor')).map(r=>({type:r.type,handler:String(r.fn).slice(0,160)}))"
                document_listeners = page.evaluate(f"({application_listeners})(retiredTrackers.document)")
                window_listeners = page.evaluate(f"({application_listeners})(retiredTrackers.window)")
                assert not document_listeners, document_listeners
                assert not window_listeners, window_listeners
                assert page.locator("#screen").count() == 1
                assert page.locator("#stageHeader").count() == 1
                expect(page.locator("#videoRenderDialog")).to_be_hidden()
                page.evaluate("shaderTheme.set(shaderTheme.theme === 'dark' ? 'light' : 'dark')")
            assert not errors, errors
            context.close()
            print("PASS 반복 분리/닫기 후 문서·창 이벤트 0개, 관찰자 수 복원, 원본·모달 복구")

            source = (root / "js" / "renderer.js").read_text(encoding="utf-8")
            marker = "export { createRenderer };"
            assert marker in source
            delayed = source.replace(marker, """
                const delayedRenderer = (...args) => {
                    const renderer = createRenderer(...args), dispose = renderer.dispose;
                    window.rendererDisposeCount = 0;
                    renderer.dispose = () => { window.rendererDisposeCount++; dispose(); };
                    renderer.restoreTextures = () => new Promise(resolve => { window.finishRestore = resolve; });
                    return renderer;
                };
                export { delayedRenderer as createRenderer };
            """)
            context = browser.new_context()
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route("**/js/renderer.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=delayed))
            page.goto(url)
            page.wait_for_function("!!window.finishRestore")
            page.evaluate("dispatchEvent(new Event('beforeunload',{cancelable:true})); dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));")
            assert page.evaluate("rendererDisposeCount") == 0
            page.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false})); dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false})); finishRestore();")
            page.wait_for_timeout(100)
            assert page.evaluate("rendererDisposeCount === 1 && !window.shaderStudio && !window.shaderPlayground")
            assert page.locator(".cm-editor").count() == 0, "종료 뒤 초기화가 다시 진행됨"
            assert not errors, errors
            context.close()
            print("PASS 초기화 대기 중 종료: 렌더러 1회 해제, 늦은 완료 뒤 UI 생성 없음")

            failed = source.replace(marker, "const failedRenderer = () => { throw new Error('Lifecycle startup failure'); }; export { failedRenderer as createRenderer };")
            context = browser.new_context()
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route("**/js/renderer.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=failed))
            page.goto(url)
            expect(page.locator("#status")).to_have_text("Lifecycle startup failure")
            assert page.evaluate("!!shaderTheme && !!shaderWorkspace && !!shaderPopout && !window.shaderStudio")
            page.evaluate("shaderTheme.set('light')")
            expect(page.locator("html")).to_have_attribute("data-theme", "light")
            page.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}))")
            assert page.evaluate("!window.shaderTheme && !window.shaderPopout")
            assert not errors, errors
            context.close()
            print("PASS 렌더러 시작 실패 시 기본 UI 유지, 최종 종료에서 기본 UI 해제")
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
