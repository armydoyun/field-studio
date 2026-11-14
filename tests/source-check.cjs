// 테스트 도우미: 소스 모양에 흔들리지 않는 문자열 검사.
// 포매터(Prettier)가 바꾸는 것 — 띄어쓰기·줄바꿈, 작은따옴표↔큰따옴표, 화살표 함수 인자 괄호 `(x) =>`, 닫는 괄호 앞 쉼표 —
// 를 소스와 찾는 조각 양쪽에서 똑같이 지운 뒤 비교한다. 그래서 `key:"F12"`로 찾아도 `key: "F12"`가 맞는다.
// 동작으로 검사할 수 있는 것은 동작으로 검사하고, 이 도우미는 "이 연결이 코드에 있다" 수준의 구조 검사에만 쓴다.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');

const squash = text => String(text)
  .replace(/\s+/g, '')
  .replace(/'/g, '"')
  .replace(/\(([\w$]+)\)=>/g, '$1=>')
  .replace(/,(?=[)\]}])/g, '');

// 원본 그대로 읽기. 'css'는 모든 스타일시트를 index.html의 링크 순서대로 이어 붙인 것(tools/css-files.cjs).
const read = file => file === 'css' ? require('../tools/css-files.cjs').readCss(root) : fs.readFileSync(path.join(root, file), 'utf8');
// 비교용으로 눌러 둔 소스. 여러 파일이면 이어 붙인다.
const code = (...files) => files.map(file => squash(read(file))).join('\n');
// 눌러 둔 소스에 조각이 모두 들어 있는지
const has = (source, ...snippets) => snippets.every(snippet => source.includes(squash(snippet)));

module.exports = {root, squash, read, code, has};
