// Test-only bridge: existing isolated GPU/DOM mocks historically evaluate module factories.
// Converts static ES module imports/exports to a factory for those existing mocks.
// Production code and deploy output never use AMD or this bridge.
const vm = require('node:vm');
const original = vm.runInNewContext;
const importRe = /^import (?:\* as ([\w$]+)|([\w$]+)) from "\.\/([\w-]+)\.js";\s*$/gm;
function forLegacyVm(source) {
  if (!/\bexport (?:default|\{)|^import .* from /m.test(source)) return source;
  const deps=[],names=[];
  source=source.replace(importRe,(_,namespace,def,target)=>{names.push(namespace||def);deps.push(target);return '';});
  let body=source.trim();
  if (/export default /.test(body)) body=body.replace('export default ', 'return ');
  else body=body.replace(/\bexport \{([^{}]+)\};\s*$/,(_,names)=>'return {'+names+'};');
  if (/\bexport\s+(?:default|\{)/.test(body))throw new Error('Unexpected export syntax in ES test bridge');
  return 'define('+JSON.stringify(deps)+',('+names.join(',')+')=>{\n'+body+'\n});';
}
vm.runInNewContext=(source,context,opts)=>original.call(vm,forLegacyVm(source),context,opts);
module.exports={forLegacyVm};
