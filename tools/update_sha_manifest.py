"""Regenerate SOURCE_SHA256_Runtime.txt after intentional runtime source changes. Standard library only.

Covers index.html, style.css and every js/*.js file, matching tests/runtime-integrity.js.
Line endings are normalized to LF before hashing, so Windows (CRLF) and Linux checkouts agree.

    python tools/update_sha_manifest.py           # 목록을 다시 쓴다 (npm run sha)
    python tools/update_sha_manifest.py --check   # 쓰지 않고 비교만 한다. 다르면 종료 코드 1 (npm run sha:check, CI)
"""
from pathlib import Path
import hashlib
import sys

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'SOURCE_SHA256_Runtime.txt'


def digest(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def build():
    files = sorted(['index.html', 'style.css', *('js/' + p.name for p in (ROOT / 'js').glob('*.js'))])
    return files, '\n'.join(f'{digest(ROOT / name)}  {name}' for name in files) + '\n'


def check(expected):
    current = MANIFEST.read_text(encoding='utf-8').replace('\r\n', '\n') if MANIFEST.exists() else ''
    if current == expected:
        print('SOURCE_SHA256_Runtime.txt: 최신 상태')
        return 0
    old = dict(reversed(line.split('  ', 1)) for line in current.splitlines() if '  ' in line)
    new = dict(reversed(line.split('  ', 1)) for line in expected.splitlines())
    changed = sorted(name for name in new.keys() | old.keys() if old.get(name) != new.get(name))
    print('SOURCE_SHA256_Runtime.txt가 소스와 맞지 않습니다. `npm run sha`(python tools/update_sha_manifest.py)로 갱신해 커밋하세요.')
    for name in changed:
        state = '추가' if name not in old else '삭제' if name not in new else '변경'
        print(f'  {state}: {name}')
    return 1


def main():
    files, text = build()
    if '--check' in sys.argv[1:]:
        return check(text)
    MANIFEST.write_text(text, encoding='utf-8', newline='\n')
    print(f'Updated SOURCE_SHA256_Runtime.txt: {len(files)} files')
    return 0


if __name__ == '__main__':
    sys.exit(main())
