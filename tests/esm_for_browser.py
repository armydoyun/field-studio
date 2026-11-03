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
