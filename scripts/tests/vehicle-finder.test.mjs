import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRead, searchEntries, partialSelection, createReadController } from '../../preview/vehicle-finder/core.mjs';
import { fixture } from './vehicle-finder.fixture.mjs';
const read = () => validateRead(fixture());
const ids = result => result.matches.map(item => item.entry.id);

test('empty search permits browsing without any required field', () => assert.equal(searchEntries(read()).matches.length, 3));
test('model-only search and partial selection require no year/trim', () => {
  const snapshot = read(); const result = searchEntries(snapshot, '시험차 A');
  assert.deepEqual(ids(result), ['fixture:model:a']);
  const selected = partialSelection(snapshot, result.matches[0].entry.id);
  assert.equal(selected.nodeType, 'MODEL'); assert.equal(selected.configurationConfirmed, false);
  assert.equal(Object.hasOwn(selected, 'modelYear'), false); assert.equal(Object.hasOwn(selected, 'trimId'), false);
});
test('unresolved model can be opened/selected', () => assert.equal(partialSelection(read(), 'fixture:model:b').nodeType, 'MODEL'));
test('trim-only input does not require manufacturer or model', () => assert.deepEqual(ids(searchEntries(read(), '노블레스')), ['fixture:trim:c']));
test('code and approved entry aliases are accepted case-insensitively', () => assert.deepEqual(ids(searchEntries(read(), 'test-a')), ['fixture:model:a']));
test('NFKC normalization preserves matching without rewriting raw query', () => {
  const query = 'ＴＥＳＴ－Ａ'; const result = searchEntries(read(), query); assert.equal(result.query, query); assert.equal(result.matches.length, 1);
});
test('extra information narrows one actual configuration', () => {
  const result = searchEntries(read(), '시험차 A HEV 5인승'); assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].matchedConfigurationIds, ['fixture:config:hev5']);
});
test('HEV in one sibling and 7 seats in another cannot fabricate a match', () => assert.equal(searchEntries(read(), '시험차 A HEV 7인승').matches.length, 0));
test('facet filters also require simultaneous agreement on one configuration', () => assert.equal(searchEntries(read(), '시험차 A', { fuel: 'HEV', seatCount: '7' }).matches.length, 0));
test('year without evidence is not filled from clock or observation timestamp', () => assert.equal(searchEntries(read(), '노블레스', { modelYear: 2026 }).matches.length, 0));
test('numeric tokens do not match partial years', () => assert.equal(searchEntries(read(), '202').matches.length, 0));
test('no-result leaves query/filters intact, with no implicit relaxation', () => {
  const query = '시험차 A HEV 7인승'; const filters = { modelYear: '2026' }; const before = structuredClone(filters);
  const result = searchEntries(read(), query, filters); assert.equal(result.query, query); assert.deepEqual(filters, before); assert.deepEqual(result.filters, before);
});
test('search context is not promoted into confirmed specifications', () => {
  const selected = partialSelection(read(), 'fixture:model:a', { query: '2024 HEV', filters: { modelYear: 2024 } });
  assert.equal(selected.searchContext.filters.modelYear, '2024'); assert.equal(Object.hasOwn(selected, 'modelYear'), false); assert.equal(selected.configurationConfirmed, false);
});
test('selection outside current snapshot is rejected', () => assert.throws(() => partialSelection(read(), 'missing'), /NOT_IN_OBSERVATION/));
test('unsupported filters fail instead of being silently ignored', () => assert.throws(() => searchEntries(read(), '', { surprise: 1 }), /filterKey/));
test('duplicate canonical references reject the whole read', () => { const input = fixture(); input.entries.push(input.entries[0]); assert.throws(() => validateRead(input), /entryId/); });
test('missing configuration evidence rejects the read', () => { const input = fixture(); delete input.entries[0].configurations[0].evidenceId; assert.throws(() => validateRead(input), /configurationEvidence/); });
test('unknown scope cannot masquerade as complete coverage', () => { const input = fixture(); input.coverage = 'UNKNOWN'; assert.throws(() => validateRead(input), /coverage/); });
test('caller mutation cannot alter the accepted snapshot', () => { const input = fixture(); const snapshot = validateRead(input); input.entries[0].label = 'mutated'; assert.equal(snapshot.entries[0].label, '시험차 A'); });
test('unconnected provider is distinct from zero results', async () => { const c = createReadController(); await c.refresh(); assert.equal(c.getState().status, 'not_connected'); assert.equal(c.getState().snapshot, null); });
test('transport failure never becomes an empty successful read', async () => { const c = createReadController(async () => { throw new Error('offline'); }); await c.refresh(); assert.equal(c.getState().status, 'error'); assert.equal(c.getState().snapshot, null); });
test('valid empty read retains coverage and observation', async () => { const c = createReadController(async () => ({ ...fixture(), entries: [] })); await c.refresh(); assert.equal(c.getState().status, 'ready'); assert.equal(c.getState().snapshot.coverage, 'PARTIAL'); });
test('malformed response is an error, not fallback data', async () => { const c = createReadController(async () => []); await c.refresh(); assert.equal(c.getState().status, 'error'); });
test('out-of-order read cannot overwrite newer response', async () => {
  const resolvers = []; const signals = []; const c = createReadController(({ signal }) => { signals.push(signal); return new Promise(resolve => resolvers.push(resolve)); });
  const first = c.refresh(); const second = c.refresh(); assert.equal(signals[0].aborted, true);
  resolvers[1]({ ...fixture(), observationId: 'new' }); await second;
  resolvers[0]({ ...fixture(), observationId: 'old' }); await first;
  assert.equal(c.getState().snapshot.observationId, 'new');
});
test('stale error cannot overwrite newer success', async () => {
  const jobs = []; const c = createReadController(() => new Promise((resolve, reject) => jobs.push({ resolve, reject })));
  const first = c.refresh(); const second = c.refresh(); jobs[1].resolve(fixture()); await second; jobs[0].reject(new Error('stale')); await first;
  assert.equal(c.getState().status, 'ready');
});
test('dispose prevents late updates', async () => {
  let done; const states = []; const c = createReadController(() => new Promise(resolve => { done = resolve; }), state => states.push(state.status));
  const pending = c.refresh(); c.dispose(); done(fixture()); await pending; assert.deepEqual(states, ['loading']);
});

test('short Latin model token does not match GASOLINE substring', () => assert.deepEqual(ids(searchEntries(read(), '시험차 A')), ['fixture:model:a']));
