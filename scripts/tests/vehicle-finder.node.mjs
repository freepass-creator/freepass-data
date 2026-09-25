import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_RESULT_LIMIT,
  createReadController,
  partialSelection,
  searchEntries,
  validateRead,
} from '../../preview/vehicle-finder/core.mjs';
import { fixture } from './vehicle-finder.fixture.mjs';

const read = () => validateRead(fixture());
const ids = result => result.matches.map(item => item.entry.id);

test('empty search browses supported master destinations without requiring year or trim', () => {
  const result = searchEntries(read());
  assert.deepEqual(ids(result), [
    'fixture:make:a',
    'fixture:model:a',
    'fixture:model:b',
    'fixture:trim:c',
    'fixture:trim:d',
  ]);
  assert.equal(result.matches.some(item => item.entry.nodeType === 'OPTION'), false);
});

test('MAKE is supported and manufacturer-only search can reach its descendants', () => {
  const result = ids(searchEntries(read(), '시험제조사'));
  assert.equal(result.includes('fixture:make:a'), true);
  assert.equal(result.includes('fixture:model:a'), true);
  assert.equal(result.includes('fixture:model:b'), true);
});

test('known but non-Finder master types are explicitly excluded instead of crashing the read', () => {
  const snapshot = read();
  assert.equal(snapshot.entries.some(entry => entry.nodeType === 'OPTION'), true);
  assert.equal(searchEntries(snapshot, '테스트 옵션').matches.length, 0);
});

test('unknown node types still fail closed', () => {
  const input = fixture();
  input.entries[0].nodeType = 'SURPRISE';
  input.entries[0].path.at(-1).nodeType = 'SURPRISE';
  assert.throws(() => validateRead(input), /entry/);
});

test('model-only search and partial selection require no year/trim', () => {
  const snapshot = read();
  const result = searchEntries(snapshot, '시험차 A');
  assert.deepEqual(ids(result), ['fixture:model:a']);
  const match = result.matches[0];
  const selected = partialSelection(snapshot, match.entry.id, {
    matchedConfigurationIds: match.matchedConfigurationIds,
  });
  assert.equal(selected.nodeType, 'MODEL');
  assert.equal(selected.configurationConfirmed, false);
  assert.equal(Object.hasOwn(selected, 'modelYear'), false);
  assert.equal(Object.hasOwn(selected, 'trimId'), false);
  assert.deepEqual(selected.path.map(item => item.label), ['시험제조사', '시험차 A']);
});

test('unresolved model can be opened and selected', () => {
  assert.equal(partialSelection(read(), 'fixture:model:b').nodeType, 'MODEL');
});

test('same-name trims are distinguishable by canonical ancestor path', () => {
  const all = searchEntries(read(), '프레스티지');
  assert.deepEqual(ids(all), ['fixture:trim:c', 'fixture:trim:d']);
  assert.deepEqual(all.matches.map(item => item.pathText), [
    '기아 › 쏘렌토 › 2027 › 프레스티지',
    '기아 › 스포티지 › 2027 › 프레스티지',
  ]);
  assert.deepEqual(ids(searchEntries(read(), '쏘렌토 프레스티지')), ['fixture:trim:c']);
  assert.deepEqual(ids(searchEntries(read(), '스포티지 프레스티지')), ['fixture:trim:d']);
});

test('space-insensitive Korean search does not require fabricated aliases', () => {
  const input = fixture();
  input.entries[2].label = '더 뉴 시험차';
  input.entries[2].path.at(-1).label = '더 뉴 시험차';
  const snapshot = validateRead(input);
  assert.deepEqual(ids(searchEntries(snapshot, '더뉴시험차')), ['fixture:model:b']);
});

test('approved entry aliases are accepted case-insensitively', () => {
  assert.deepEqual(ids(searchEntries(read(), 'test-a')), ['fixture:model:a']);
});

test('NFKC normalization preserves matching without rewriting raw query', () => {
  const query = 'ＴＥＳＴ－Ａ';
  const result = searchEntries(read(), query);
  assert.equal(result.query, query);
  assert.equal(result.matches.length, 1);
});

test('extra information narrows one actual configuration', () => {
  const result = searchEntries(read(), '시험차 A HEV 5인승');
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].matchedConfigurationIds, ['fixture:config:hev5']);
});

test('HEV in one sibling and 7 seats in another cannot fabricate a match', () => {
  assert.equal(searchEntries(read(), '시험차 A HEV 7인승').matches.length, 0);
});

test('facet filters also require simultaneous agreement on one configuration', () => {
  assert.equal(searchEntries(read(), '시험차 A', { fuel: 'HEV', seatCount: '7' }).matches.length, 0);
});

test('unknown filtered facts are reported as excluded, not silently treated as known mismatch', () => {
  const result = searchEntries(read(), '시험차 A', { drivetrain: '4WD' });
  assert.equal(result.matches.length, 0);
  assert.equal(result.excludedUnknownFacetCount, 1);
});

test('year without evidence is not filled from clock or observation timestamp', () => {
  const input = fixture();
  input.entries[3].configurations[0].facets.modelYear = null;
  const snapshot = validateRead(input);
  assert.equal(searchEntries(snapshot, '쏘렌토 프레스티지', { modelYear: 2026 }).matches.length, 0);
});

test('numeric tokens do not match partial years', () => {
  assert.equal(searchEntries(read(), '202').matches.length, 0);
});

test('no-result leaves query and filters intact with no implicit relaxation', () => {
  const query = '시험차 A HEV 7인승';
  const filters = { modelYear: '2026' };
  const before = structuredClone(filters);
  const result = searchEntries(read(), query, filters);
  assert.equal(result.query, query);
  assert.deepEqual(filters, before);
  assert.deepEqual(result.filters, before);
});

test('selection preserves matched configuration candidates as evidence context, not confirmed specs', () => {
  const snapshot = read();
  const match = searchEntries(snapshot, '시험차 A HEV 5인승').matches[0];
  const selected = partialSelection(snapshot, match.entry.id, {
    query: '시험차 A HEV 5인승',
    filters: { fuel: 'HEV' },
    matchedConfigurationIds: match.matchedConfigurationIds,
  });
  assert.deepEqual(selected.candidateConfigurationIds, ['fixture:config:hev5']);
  assert.equal(selected.searchContext.filters.fuel, 'HEV');
  assert.equal(selected.configurationConfirmed, false);
  assert.equal(Object.hasOwn(selected, 'fuel'), false);
});

test('selection outside current searchable snapshot is rejected', () => {
  assert.throws(() => partialSelection(read(), 'missing'), /NOT_IN_OBSERVATION/);
  assert.throws(() => partialSelection(read(), 'fixture:option:hidden'), /NOT_IN_OBSERVATION/);
});

test('unsupported filters fail instead of being silently ignored', () => {
  assert.throws(() => searchEntries(read(), '', { surprise: 1 }), /filterKey/);
});

test('duplicate canonical references reject the whole read', () => {
  const input = fixture();
  input.entries.push(structuredClone(input.entries[0]));
  assert.throws(() => validateRead(input), /entryId/);
});

test('path leaf must identify the exact entry', () => {
  const input = fixture();
  input.entries[1].path.at(-1).id = 'other';
  assert.throws(() => validateRead(input), /pathLeaf/);
});

test('missing configuration evidence rejects the read', () => {
  const input = fixture();
  delete input.entries[1].configurations[0].evidenceId;
  assert.throws(() => validateRead(input), /configurationEvidence/);
});

test('unknown scope cannot masquerade as complete coverage', () => {
  const input = fixture();
  input.coverage = 'UNKNOWN';
  assert.throws(() => validateRead(input), /coverage/);
});

test('caller mutation cannot alter the accepted snapshot', () => {
  const input = fixture();
  const snapshot = validateRead(input);
  input.entries[1].label = 'mutated';
  assert.equal(snapshot.entries[1].label, '시험차 A');
});

test('result delivery is bounded even when the read contains many destinations', () => {
  const input = fixture();
  input.entries = Array.from({ length: SEARCH_RESULT_LIMIT + 25 }, (_, index) => ({
    id: `fixture:model:bulk:${index}`,
    nodeType: 'MODEL',
    label: `벌크차량 ${index}`,
    aliases: [],
    path: [
      { id: 'fixture:make:bulk', nodeType: 'MAKE', label: '벌크제조사' },
      { id: `fixture:model:bulk:${index}`, nodeType: 'MODEL', label: `벌크차량 ${index}` },
    ],
    configurations: [],
  }));
  const result = searchEntries(validateRead(input), '');
  assert.equal(result.matches.length, SEARCH_RESULT_LIMIT);
  assert.equal(result.totalMatches, SEARCH_RESULT_LIMIT + 25);
  assert.equal(result.hasMore, true);
});

test('unconnected provider is distinct from zero results', async () => {
  const c = createReadController();
  await c.refresh();
  assert.equal(c.getState().status, 'not_connected');
  assert.equal(c.getState().snapshot, null);
});

test('transport failure before first success never becomes an empty successful read', async () => {
  const c = createReadController(async () => { throw new Error('offline'); });
  await c.refresh();
  assert.equal(c.getState().status, 'error');
  assert.equal(c.getState().snapshot, null);
});

test('refresh retains the last-known-good snapshot while a newer read is in flight', async () => {
  let resolveSecond;
  let call = 0;
  const c = createReadController(() => {
    call++;
    if (call === 1) return Promise.resolve(fixture());
    return new Promise(resolve => { resolveSecond = resolve; });
  });
  await c.refresh();
  const previous = c.getState().snapshot;
  const pending = c.refresh();
  assert.equal(c.getState().status, 'refreshing');
  assert.equal(c.getState().snapshot, previous);
  resolveSecond({ ...fixture(), observationId: 'new-observation' });
  await pending;
  assert.equal(c.getState().status, 'ready');
  assert.equal(c.getState().snapshot.observationId, 'new-observation');
});

test('failed refresh keeps last-known-good snapshot and reports error separately', async () => {
  let call = 0;
  const c = createReadController(async () => {
    call++;
    if (call === 1) return fixture();
    throw new Error('refresh-failed');
  });
  await c.refresh();
  const previous = c.getState().snapshot;
  await c.refresh();
  assert.equal(c.getState().status, 'error');
  assert.equal(c.getState().snapshot, previous);
  assert.equal(c.getState().error, 'refresh-failed');
});

test('valid empty read retains coverage and observation', async () => {
  const c = createReadController(async () => ({ ...fixture(), entries: [] }));
  await c.refresh();
  assert.equal(c.getState().status, 'ready');
  assert.equal(c.getState().snapshot.coverage, 'PARTIAL');
});

test('malformed response is an error, not fallback data', async () => {
  const c = createReadController(async () => []);
  await c.refresh();
  assert.equal(c.getState().status, 'error');
});

test('out-of-order read cannot overwrite newer response', async () => {
  const resolvers = [];
  const signals = [];
  const c = createReadController(({ signal }) => {
    signals.push(signal);
    return new Promise(resolve => resolvers.push(resolve));
  });
  const first = c.refresh();
  const second = c.refresh();
  assert.equal(signals[0].aborted, true);
  resolvers[1]({ ...fixture(), observationId: 'new' });
  await second;
  resolvers[0]({ ...fixture(), observationId: 'old' });
  await first;
  assert.equal(c.getState().snapshot.observationId, 'new');
});

test('stale error cannot overwrite newer success', async () => {
  const jobs = [];
  const c = createReadController(() =>
    new Promise((resolve, reject) => jobs.push({ resolve, reject }))
  );
  const first = c.refresh();
  const second = c.refresh();
  jobs[1].resolve(fixture());
  await second;
  jobs[0].reject(new Error('stale'));
  await first;
  assert.equal(c.getState().status, 'ready');
});

test('dispose prevents late updates', async () => {
  let done;
  const states = [];
  const c = createReadController(
    () => new Promise(resolve => { done = resolve; }),
    state => states.push(state.status),
  );
  const pending = c.refresh();
  c.dispose();
  done(fixture());
  await pending;
  assert.deepEqual(states, ['loading']);
});
