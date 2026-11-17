// Actual IndexedDB transactions: loaded metadata must describe the returned body, including concurrent saves.
(async () => {
  const {create} = await import('./js/project-store.js');
  const store = create({dbName: `snapshot-regression-${Date.now()}`});
  const check = (value, label) => { if (!value) throw new Error(label); console.log('PASS', label); };
  try {
    const first = await store.save({name: 'atomic', text: '1'});
    check(await store.load(first.id) === '1', 'legacy load still returns pack text');
    const pending = [];
    for (let revision = 2; revision <= 12; revision++) {
      pending.push(store.save({id: first.id, name: 'atomic', text: String(revision)}));
      pending.push(store.loadEntry(first.id).then(({record, text}) => {
        check(record.revision === Number(text), `body and revision match: ${record.revision}/${text}`);
      }));
    }
    await Promise.all(pending);
    const last = await store.loadEntry(first.id);
    check(last.record.revision === 12 && last.text === '12', 'all queued writes completed');
    let conflict = null;
    try { await store.save({id: first.id, name: 'atomic', text: 'stale', expectedRevision: 1}); }
    catch (error) { conflict = error; }
    check(conflict?.code === 'conflict', 'old revision cannot overwrite a newer body');
    await store.remove(first.id);
    let missing = null;
    try { await store.loadEntry(first.id); } catch (error) { missing = error; }
    check(missing?.code === 'missing', 'deleted snapshots fail before opening');
  } finally { await store.destroy(); }
})();
