"""Bridge old isolated browser-mock tests to the new ES module source shape.
Only used to keep the established no-server DOM tests. Not shipped at runtime.
"""
import re
IMPORT=re.compile(r'^import (?:\* as (\w+)|(\w+)) from "\./([\w-]+)\.js";\s*$', re.M)
EXPORT=re.compile(r'\bexport \{([^{}]+)\};\s*\Z')

def mock_module(source):
    imports=[]
    def dep(match):
        imports.append((match.group(1) or match.group(2),match.group(3)))
        return ''
    body=IMPORT.sub(dep, source).strip()
    if 'export default ' in body: body=body.replace('export default ', 'return ', 1)
    else: body=EXPORT.sub(lambda match:'return {'+match.group(1)+'};', body)
    assert not re.search(r'\bexport\s+(?:default|\{)',body)
    deps=','.join('"'+x[1]+'"' for x in imports)
    args=','.join(x[0] for x in imports)
    return 'define(['+deps+'],('+args+')=>{\n'+body+'\n});'

# 모듈을 이름으로 등록하는 공용 로더. 테스트마다 손으로 쓰던 define() 분기를 대신한다.
# import 줄을 읽어 의존 모듈을 먼저 넣으므로, 앱에 모듈이 추가돼도 테스트 하네스를 고칠 필요가 없다.
SHIM = '''() => { window.define = (name, deps, factory) => {
  const m = window.__testModules ??= {}; m[name] = factory(...deps.map(dep => m[dep]));
  const alias = {"code-editor":"TestEditor", "studio":"TestStudio", "shader":"TestShader"}[name]; if(alias) window[alias] = m[name];
}; }'''

def named_module(source, name):
    return mock_module(source).replace('define([', f'define({name!r},[', 1)

def load_modules(page, root, names):
    """root/js의 모듈 names와 그 의존 모듈을 의존 순서대로 페이지에 넣는다. TestEditor·TestStudio·TestShader 별칭도 만든다."""
    page.evaluate(SHIM); loaded = []
    def visit(name):
        if name in loaded: return
        source = (root / 'js' / f'{name}.js').read_text()
        for match in IMPORT.finditer(source): visit(match.group(3))
        page.add_script_tag(content=named_module(source, name)); loaded.append(name)
    for name in names: visit(name)
    return loaded

class EditorModel:
    """#studioCode 창구 + CodeMirror 화면을 예전 textarea 로케이터처럼 다룬다(fill · input_value · press · focus).
    fill은 사용자가 내용을 통째로 바꾼 것처럼 값을 넣고 input 이벤트를 보낸다. 키 입력은 실제 CodeMirror 화면으로 간다."""
    def __init__(self, page): self.page = page
    def fill(self, text):
        self.page.evaluate("""text => { const t = document.getElementById('studioCode'); t.value = text;
          t.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text})); }""", text)   # Playwright fill과 같은 이벤트(타이핑 묶음 아님)
    def input_value(self): return self.page.evaluate("document.getElementById('studioCode').value")
    def focus(self): self.page.evaluate("document.getElementById('studioCode').focus()")
    def press(self, key): self.focus(); self.page.keyboard.press(key)
    def type(self, text): self.focus(); self.page.keyboard.type(text)
