"""Regenerate SOURCE_SHA256_Runtime.txt after intentional runtime source changes. Standard library only.

Covers index.html, style.css and every js/*.js file, matching tests/runtime-integrity.js.
"""
from pathlib import Path
import hashlib

ROOT = Path(__file__).resolve().parents[1]


def main():
    files = sorted(['index.html', 'style.css', *('js/' + p.name for p in (ROOT / 'js').glob('*.js'))])
    lines = [f'{hashlib.sha256((ROOT / name).read_bytes()).hexdigest()}  {name}' for name in files]
    (ROOT / 'SOURCE_SHA256_Runtime.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'Updated SOURCE_SHA256_Runtime.txt: {len(files)} files')


if __name__ == '__main__': main()
