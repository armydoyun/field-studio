from esm_for_browser import load_modules, read_css
# python tests/tour-state-browser-regression.py — UI 둘러보기(투어)가 끝나면 시작 전 화면(편집기 · 설정 패널 · 패널 탭)으로 돌아오는지 (GPU 불필요)
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text();html=html[:html.index('    <!-- ES Modules:')]+'</body></html>'
# 투어가 쓰는 화면 조작만 흉내 낸다: 편집기 열기/닫기(studio), 패널 토글·탭(ui.js가 하는 일).
FAKE='''() => {
  const $=id=>document.getElementById(id);
  window.studioCalls=[];
  window.fakeStudio={open:()=>{studioCalls.push("open");$("studioDock").hidden=false;},close:()=>{studioCalls.push("close");$("studioDock").hidden=true;}};
  $("panelToggle").addEventListener("click",()=>document.body.classList.toggle("panel-hidden"));
  for(const b of document.querySelectorAll("#panelTabs [data-tab]"))b.addEventListener("click",()=>{for(const x of document.querySelectorAll("#panelTabs [data-tab]"))x.setAttribute("aria-selected",String(x===b));});
  window.guide=__testModules.guide.mount({studio:fakeStudio,gallery:null});
}'''
STATE='''() => ({editor:!document.getElementById("studioDock").hidden,panelHidden:document.body.classList.contains("panel-hidden"),
  tab:document.querySelector('#panelTabs [aria-selected="true"]')?.dataset.tab,touring:!document.querySelector(".guide-tour").hidden})'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH') or None,args=['--no-sandbox'])
    n=[0]
    def check(cond,label):
        assert cond,label;n[0]+=1;print('PASS',f'{n[0]:02d}',label,flush=True)
    def scenario(width,height,setup):
        page=browser.new_page(viewport={'width':width,'height':height});errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content(html);page.add_style_tag(content=read_css(root))
        load_modules(page,root,['guide']);page.evaluate(FAKE);page.evaluate(setup)
        return page,errors
    def run_to_end(page):
        page.evaluate('() => guide.startTour()')
        for _ in range(30):
            if not page.evaluate(STATE)['touring']:break
            page.evaluate('() => document.querySelector(".guide-tour-card .primary").click()');page.wait_for_timeout(20)

    # 넓은 화면: 편집기 열림 · 패널 표시 · 렌더링 탭
    page,errors=scenario(1440,900,'''() => {document.getElementById("studioDock").hidden=false;document.body.classList.remove("panel-hidden");document.querySelector('#panelTabs [data-tab="render"]').click();}''')
    before=page.evaluate(STATE);run_to_end(page);after=page.evaluate(STATE)
    check('close' in page.evaluate('studioCalls'),'the tour itself closes the editor for its viewport steps')
    check(after==before,f'finishing the tour restores editor, panel and tab: {before} -> {after}')
    page.evaluate('() => guide.startTour()');page.wait_for_timeout(20)
    page.evaluate('() => {for(let i=0;i<6;i++)document.querySelector(".guide-tour-card .primary").click();}');page.wait_for_timeout(20)
    page.keyboard.press('Escape');page.wait_for_timeout(20)
    check(page.evaluate(STATE)==before,'leaving mid-tour with Esc restores the same screen')
    check(errors==[],f'no page exceptions: {errors}');page.close()

    # 좁은 화면: 편집기 닫힘 · 패널(겹치는 서랍) 닫힘
    page,errors=scenario(390,844,'''() => {document.getElementById("studioDock").hidden=true;document.body.classList.add("panel-hidden");document.querySelector('#panelTabs [data-tab="uniforms"]').click();}''')
    before=page.evaluate(STATE);run_to_end(page);after=page.evaluate(STATE)
    check('open' in page.evaluate('studioCalls'),'the tour opens the editor for its editor steps')
    check(after==before,f'on a phone the editor and drawer panel return to closed: {before} -> {after}')
    check(errors==[],f'no page exceptions: {errors}');page.close()
    print(f'PASS all {n[0]} tour state checks')
    browser.close()
