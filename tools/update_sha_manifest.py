"""Regenerate SOURCE_SHA256_Runtime.txt after intentional runtime source changes. Standard library only.

Covers index.html, style.css and every js/*.js file, matching tests/runtime-integrity.js.
Line endings are normalized to LF before hashing, so Windows (CRLF) and Linux checkouts agree.
"""
from pathlib import Path
import hashlib

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def main():
    files = sorted(['index.html', 'style.css', *('js/' + p.name for p in (ROOT / 'js').glob('*.js'))])
    lines = [f'{digest(ROOT / name)}  {name}' for name in files]
    (ROOT / 'SOURCE_SHA256_Runtime.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'Updated SOURCE_SHA256_Runtime.txt: {len(files)} files')


if __name__ == '__main__': main()
