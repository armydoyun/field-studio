from esm_for_browser import load_modules, read_css
from pathlib import Path
from playwright.sync_api import sync_playwright
import os

root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text().split('    <!-- ES Modules:')[0]+'</body></html>'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH') or None,args=['--no-sandbox'])
    for width,height in [(1440,900),(390,844),(320,568),(640,360)]:
        page=browser.new_page(viewport={'width':width,'height':height})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content(html);page.add_style_tag(content=read_css(root))
        load_modules(page,root,['guide'])
        page.evaluate('''() => {
          const $=id=>document.getElementById(id);
          window.guide=__testModules.guide.mount({studio:{open(){},close(){}},gallery:null});
          $('helpClose').onclick=()=>$('quickHelp').close();
          guide.open('start');
        }''')
        mobile=width<=760
        nav=page.locator('#guideNav')
        if mobile:
            assert not nav.is_visible(),'mobile contents start closed'
            page.locator('#guideNavToggle').click()
            assert nav.is_visible()
            assert page.locator('#guideNavToggle').get_attribute('aria-expanded')=='true'
        summary=page.locator('[data-category=course]>summary')
        summary.focus();page.keyboard.press('Enter')
        assert page.locator('[data-topic=c1]').is_visible(),'Enter expands lessons'
        page.keyboard.press('Space')
        assert not page.locator('[data-topic=c1]').is_visible(),'Space collapses lessons'
        for theme in ['dark','light']:
            page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
            for category in ['reference','workspace','code','parameters','passes']:
                page.locator(f'[data-category={category}]').evaluate('(node)=>node.open=true')
            page.locator('[data-topic=timeline]').scroll_into_view_if_needed()
            assert page.evaluate('''() => {
                const nav=document.getElementById('guideNav'),r=nav.getBoundingClientRect();
                return nav.scrollWidth<=nav.clientWidth+1&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;
            }'''),f'{width} {theme}: contents fit viewport'
        page.locator('[data-topic=timeline]').click()
        assert page.locator('[data-topic=timeline]').get_attribute('aria-current')=='page'
        if mobile:
            assert not nav.is_visible()
            assert page.locator('#guideContent').evaluate('(n)=>n===document.activeElement')
            page.locator('#guideNavToggle').click()
            page.keyboard.press('Escape')
            assert not nav.is_visible() and page.locator('#quickHelp').is_visible(),'Escape closes contents first'
            assert page.locator('#guideNavToggle').evaluate('(n)=>n===document.activeElement')
            page.locator('#guideSearch').fill('프리셋 호환성')
            assert nav.is_visible() and page.locator('[data-topic=presets]').is_visible(),'search opens matching nested category'
            page.keyboard.press('Enter')
            assert not nav.is_visible() and page.locator('#quickHelp').is_visible()
            page.keyboard.press('Escape')
            assert not page.locator('#quickHelp').is_visible(),'next Escape closes help'
        assert not errors,errors
        print(f'PASS {width}x{height}: keyboard, hierarchy, two themes, contents bounds, mobile navigation',flush=True)
        page.close()
    browser.close()
