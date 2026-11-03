"""FIELD Studio ESM -> offline one-file classic-script bundle, Python standard library only.

This small builder is intentionally scoped to FIELD Studio's static imports/exports.
Unsupported syntax fails loudly rather than producing an incomplete distribution.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'js'
OUT = ROOT / 'deploy'
MODULES = ['gpu-diagnostics', 'pass-manager', 'texture-input', 'renderer', 'shader', 'glsl-highlight', 'glsl-language', 'codemirror', 'cm-glsl-features', 'cm-editor', 'annotations', 'studio', 'ui', 'input', 'settings', 'profiler', 'gallery', 'snippets', 'course', 'glsl-reference', 'guide', 'main']
# 미리 번들링해 저장소에 넣은 서드파티 모듈(tools/codemirror/build.mjs가 생성). 클래스의 `static define(` 메서드가 있어 AMD 흔적 검사에서만 제외한다.
VENDOR = {'codemirror'}
IMPORT = re.compile(r'^import (\* as ([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)) from "\./([a-z-]+)\.js";\s*$', re.M)
EXPORTS = re.compile(r'export \{([\w\s,]+)\};\s*\Z')


def compile_module(name):
    source = (SRC / (name + '.js')).read_text(encoding='utf-8')
    dependencies = []

    def replace(match):
        kind, namespace, default, target = match.group(1, 2, 3, 4)
        if target not in MODULES: raise ValueError(f'{name}: unknown import {target}')
        dependencies.append((namespace or default, target))
        return ''

    body = IMPORT.sub(replace, source).strip()
    if re.search(r'(?m)^\s*(?:import|export)\b', body) and name == 'main':
        raise ValueError(f'{name}: main must not import/export outside supported static headers')
    if re.search(r'\b(?:import|require)\s*\(', body) or (name not in VENDOR and re.search(r'(?<![.\w$])define\s*\(', body)):
        raise ValueError(f'{name}: unsupported dynamic/module syntax')
    if name == 'main':
        if 'export ' in body: raise ValueError('Main must be an entry-only module')
        tail = ''
    elif name == 'shader':
        if body.count('export default ') != 1: raise ValueError('Shader default export expected')
        body = body.replace('export default ', 'return ', 1)
        tail = ''
    else:
        match = EXPORTS.search(body)
        if not match: raise ValueError(f'{name}: named export expected at end')
        names = [x.strip() for x in match.group(1).split(',')]
        body = body[:match.start()] + 'return {' + ','.join(names) + '};'
        tail = ''
    if re.search(r'(?m)^\s*(?:import|export)\b', body):
        raise ValueError(f'{name}: unsupported import/export syntax remaining')
    local_names = [local for local, _ in dependencies]
    args = ', '.join(local_names)
    params = ', '.join(target.replace('-', '_') for _, target in dependencies)
    if name == 'main':
        return dependencies, f'(({args})=>{{\n{body}\n}})({params});\n'
    identifier = name.replace('-', '_')
    return dependencies, f'const {identifier}=(({args})=>{{\n{body}\n}})({params});\n'


def main():
    built = set()
    parts = ['"use strict";\n(()=>{\n']
    for name in MODULES:
        deps, code = compile_module(name)
        missing = [target for _, target in deps if target not in built]
        if missing: raise ValueError(f'{name}: unordered dependencies {missing}')
        parts.append(code)
        built.add(name)
    parts.append('})();\n')
    destination = OUT / 'js' / 'min.js'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(''.join(parts), encoding='utf-8')
    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    html = html.replace('''    <!-- ES Modules: 개발용 실행은 http://localhost를 사용한다. -->
    <script type="module" src="./js/main.js"></script>''', '''    <!-- Offline portable deployment: classic script supports file:// in Chrome. -->
    <script src="./js/min.js"></script>''')
    if 'type="module"' in html or 'js/min.js' not in html: raise ValueError('HTML entry not converted')
    (OUT/'index.html').write_text(html, encoding='utf-8')
    (OUT/'style.css').write_bytes((ROOT/'style.css').read_bytes())
    print(f'Created deploy/js/min.js: {destination.stat().st_size:,} bytes')

if __name__ == '__main__': main()
