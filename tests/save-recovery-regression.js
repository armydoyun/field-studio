require('./esm-vm-bridge.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {fixture, scene, src, pass} = require('./logic-regression');
const root = process.env.SHADER_TEST_ROOT || path.resolve(__dirname, '..');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const load = (name, scope, deps = {}) => {
  let result;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'js', name + '.js'), 'utf8'), {
    console: {warn() {}}, ...scope, define: (names, factory) => { result = factory(...names.map(name => deps[name])); },
  }, {filename: name + '.js'});
  return result;
};
const storageFixture = () => {
  const local = new Map(), tab = new Map();
  let failTab = false, failLocal = false;
  const storage = map => ({getItem: key => map.get(key) ?? null, removeItem: key => map.delete(key), setItem(key, value) {
    if ((map === tab && failTab) || (map === local && failLocal)) throw new Error('quota');
    map.set(key, String(value));
  }});
  return {local, tab, api: load('storage', {localStorage: storage(local), sessionStorage: storage(tab)}),
    fail: (t, l) => { failTab = t; failLocal = l; }};
};
const controller = (overrides = {}) => {
  let workEpoch = 0;
  const nodes = new Map(), writes = [], errors = [];
  const a = {id: 'a', name: 'A', revision: 1}, b = {id: 'b', name: 'B', revision: 1};
  const store = {list: async () => [a, b], save: async value => { writes.push(value); return {...a, revision: 2}; }, ...overrides.store};
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {dataset: {}, append() {}, replaceChildren() {}, setAttribute() {}});
    return nodes.get(id);
  };
  const api = load('studio-projects', {}, {storage: {
    readTabJSON: () => ({...a}), writeTabJSON() {}, removeTab() {},
  }}).create({$: node, element: () => node(Math.random()), on() {}, ask: async () => true,
    buildPack: async () => ({text: 'old pack', epoch: 0}), openPack: async read => { await read(); return true; },
    setStatus() {}, showError: error => errors.push(error), epoch: () => workEpoch, ...overrides, store});
  return {api, store, writes, errors, switchWork: () => { workEpoch++; api.forget(); }};
};
(async () => {
  const s = storageFixture();
  s.tab.set('draft', 'old'); s.fail(true, false);
  assert(s.api.writeTab('draft', 'latest'), 'partial failure is reported');
  assert.equal(s.api.readTab('draft'), 'latest', 'stale tab value cannot mask latest shared recovery');
  s.fail(false, true);
  assert(s.api.writeTab('draft', 'tab latest'));
  assert.equal(s.api.readTab('draft'), 'tab latest', 'tab backup survives a shared storage failure');
  s.fail(false, false);
  s.local.set('other', 'another tab'); s.api.removeTab('other');
  assert.equal(s.local.get('other'), 'another tab', 'unknown ownership cannot delete another tab recovery');
  assert.equal(s.api.readTab('other'), null, 'discarded recovery cannot reappear from another tab');
  const reloaded = load('storage', {localStorage: {getItem: key => s.local.get(key) ?? null}, sessionStorage: {getItem: key => s.tab.get(key) ?? null}});
  assert.equal(reloaded.readTab('other'), null, 'the empty tab marker also survives a reload');
  s.api.writeTab('mine', 'mine'); s.local.set('mine', 'another tab'); s.api.removeTab('mine');
  assert.equal(s.local.get('mine'), 'another tab');
  s.api.writeTab('owned', 'same'); s.api.removeTab('owned'); assert(!s.local.has('owned'));
  console.log('PASS independent tab/shared storage failures and recovery ownership');

  const f = fixture();
  const applied = 'webgl.shader-studio.project.v1', draft = 'webgl.shader-studio.draft.v2';
  const originalWrite = f.window.localStorage.setItem;
  try {
    f.settings.save();
    const priorSettings = f.settings.snapshot();
    f.renderer.setFpsLimit(30);
    f.window.localStorage.setItem = () => { throw new Error('quota'); };
    assert.equal(f.settings.save(), false); assert.equal(f.settings.status().available, false);
    f.window.localStorage.setItem = originalWrite;
    assert.equal(f.settings.save(), true); assert.equal(f.settings.status().available, true);
    assert.equal(JSON.parse(f.storage.get('webgl.raymarch-template.settings.v1')).rendering.fpsLimit, 30);
    f.settings.applyPack(priorSettings);
    assert(f.studio.setProject(scene()));
    const before = f.storage.get(applied), recovery = JSON.stringify({version: 1, project: scene(src + '\n// recovery'), selected: 'Image'});
    f.load('storage').writeTab(draft, recovery);
    f.window.localStorage.setItem = (key, value) => { if (key === applied) throw new Error('quota'); return originalWrite(key, value); };
    assert(f.studio.setProject(scene(src + '\n// newer')));
    assert.equal(f.storage.get(applied), before);
    assert.equal(f.storage.get(draft), recovery, 'failed applied save retains last recovery');
    assert.equal(f.nodes.get('studioStorageState').dataset.state, 'error');
    f.window.localStorage.setItem = originalWrite;
    assert(f.studio.apply()); assert(!f.storage.has(draft), 'successful retry retires recovery');
    assert(JSON.parse(f.storage.get(applied)).project.image.includes('// newer'));
    console.log('PASS autosave recovery preservation and settings retry after quota failure');
  } finally { f.window.localStorage.setItem = originalWrite; f.dispose(); }

  const recovered = {version: 1, project: {...scene(), passes: [pass()]}, selected: 'A'};
  const reload = fixture(false, false, {[applied]: JSON.stringify(recovered), [draft]: '{broken'});
  try {
    assert.equal(reload.studio.getProject().passes[0].name, 'A');
    assert.equal(JSON.parse(reload.storage.get(applied)).selected, 'A', 'startup persistence keeps the restored pass selection');
    assert.equal(reload.nodes.get('studioDraft').hidden, true, 'corrupt draft is not offered for restoration');
    console.log('PASS restored pass selection survives startup persistence and corrupt drafts are ignored');
  } finally { reload.dispose(); }

  const pack = deferred(), c = controller({buildPack: () => pack.promise});
  await c.api.ready; const saving = c.api.save(); c.switchWork();
  pack.resolve({text: 'A snapshot', epoch: 0});
  assert.equal(await saving, true); assert.equal(c.writes[0].id, 'a'); assert.equal(c.writes[0].expectedRevision, 1);
  assert.equal(c.api.current(), null); assert.equal(c.errors.length, 0);
  console.log('PASS save target remains the original project while a pack is built');

  const name = deferred(), d = controller({ask: () => name.promise});
  await d.api.ready; const saveAs = d.api.save(true); d.switchWork(); name.resolve('copy');
  assert.equal(await saveAs, false); assert.equal(d.writes.length, 0);

  const choice = deferred(), conflictReached = deferred(); let calls = 0;
  const e = controller({ask: () => { conflictReached.resolve(); return choice.promise; }, store: {save: async () => {
    calls++; throw Object.assign(new Error('conflict'), {code: 'conflict'});
  }}});
  await e.api.ready; const conflicting = e.api.save(); await conflictReached.promise;
  e.switchWork(); choice.resolve('alt');
  assert.equal(await conflicting, false); assert.equal(calls, 1);
  console.log('PASS project switches cancel pending naming and conflict decisions');

  const g = controller({store: {loadEntry: async () => ({record: {id: 'a', name: 'A', revision: 3}, text: 'snapshot 3'}),
    get: () => { throw new Error('separate metadata read is unsafe'); }}});
  await g.api.ready; assert.equal(await g.api.open('a'), true); assert.equal(g.api.current().revision, 3);
  console.log('PASS opening adopts the revision belonging to the loaded body');

  const h = controller(); await h.api.ready;
  const oldList = deferred(), newList = deferred(); let reads = 0;
  h.store.list = () => (++reads === 1 ? oldList : newList).promise;
  const oldRequest = h.api.list(), newRequest = h.api.list();
  newList.resolve([{id: 'b', name: 'B', revision: 1}]); await newRequest;
  oldList.resolve([{id: 'a', name: 'stale A', revision: 1}]); await oldRequest;
  let opened = null;
  h.store.loadEntry = async id => { opened = id; return {record: {id, name: 'B', revision: 1}, text: 'B'}; };
  assert(await h.api.open('b')); assert.equal(opened, 'b');
  console.log('PASS late project list results cannot replace newer state');
})().catch(error => { console.error(error); process.exitCode = 1; });
