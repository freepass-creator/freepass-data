import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
import { sourceUid, f05NativeCapture, aicaNativeCapture, aicaNativePlugin, ironNativeCapture, plateUidPlugin } from '../src/adapters/source-cycle-native.js';
import { sourceCyclePlugin, AICA_SCOPES } from '../src/adapters/source-cycle-plugins.js';
import { sharedSheetChannels, sharedSheetHeaders, type SharedSheetCapture, type SheetCell } from '../src/adapters/shared-sheet-source.js';
import { planSourceCycle, applySourceCycle } from '../src/application/source-cycle.js';
import { runSourceCycle } from '../src/jobs/source-cycle.js';
import { fileCycleControl } from '../src/adapters/source-cycle-control.js';
import { createSourceCycleRuntime } from '../src/runtime/source-cycle-runtime.js';
import type { CycleProduct } from '../src/ports/source-cycle.js';
import { stableDigest } from '../src/shared/stable-digest.js';

const time = '2026-10-13T00:00:00.000Z', now = Date.parse(time), source = 'SYNTHETIC';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), 'source-cycle-runtime-')); dirs.push(dir); return dir; };
const product = (uid = 'TEST1001'): CycleProduct => ({ record: { sourceId: source, uid, plate: uid,
  vehicleText: '합성 원문', status: { raw: '게시', saleAvailable: true }, terms: [{ months: 12,
    monthlyRent: { state: 'KNOWN', value: 100 }, deposit: { state: 'ZERO', value: 0 }, mileage: '20000km', raw: {} }],
  raw: { source: 'synthetic', source_tab: 'test', source_row: 2 }, observedAt: time, vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] },
  listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null });
function fakeFirestore(initial: CycleProduct[] = []) {
  const docs = new Map<string, any>(); let version = 0;
  const doc = (uid: string, fields: any) => ({ name: `projects/synthetic-test/databases/(default)/documents/products/${uid}`,
    updateTime: `${time}:${++version}`, fields });
  for (const p of initial) docs.set(p.record.uid, doc(p.record.uid, encodeFields({ ...nativeCycleFields(p), unrelated: { preserve: true } })));
  const calls: Array<{ method: string; url: URL; body: any }> = [];
  let conflict = false, corrupt = false, reverse = false;
  const fetcher = vi.fn(async (input: any, init: any) => {
    const url = new URL(String(input)), uid = decodeURIComponent(url.pathname.split('/').at(-1)!);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, url, body });
    if (init.method === 'GET') {
      let result = uid === 'products' ? { documents: [...docs.values()] } : docs.get(uid);
      if (!result) return new Response('{}', { status: 404 });
      result = structuredClone(result);
      const reorder = (v: any): any => Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).reverse().map(([k, child]) => [k, reorder(child)])) : v;
      return Response.json(reverse ? reorder(result) : result);
    }
    if (init.method !== 'PATCH') throw Error('UNEXPECTED_WRITE');
    const current = docs.get(uid);
    if (conflict || (url.searchParams.get('currentDocument.exists') === 'false' ? !!current :
      current?.updateTime !== url.searchParams.get('currentDocument.updateTime'))) return new Response('{}', { status: 412 });
    const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
    const after = doc(uid, fields); docs.set(uid, after);
    if (corrupt) after.fields.listable = { booleanValue: false };
    return Response.json(after);
  }) as unknown as typeof fetch;
  return { docs, calls, fetcher, setConflict: () => { conflict = true; }, setCorrupt: () => { corrupt = true; }, reverse: () => { reverse = true; } };
}
async function setup(initial: CycleProduct[] = []) {
  const dir = await directory(), fake = fakeFirestore(initial);
  const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
    observationSources: ['OBSERVE'] });
  return { dir, fake, commands };
}
async function prepare(commands: Awaited<ReturnType<typeof setup>>['commands'], records = [product().record]) {
  return planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 },
    { records, observedAt: time, heldCount: 0, complete: true }, await commands.list(source), now);
}
const apply = (commands: Awaited<ReturnType<typeof setup>>['commands'], built: ReturnType<typeof planSourceCycle>) =>
  applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now });

describe('Firestore REST runtime offline', () => {
  it('dry-run makes no PATCH or backup', async () => {
    const { commands, fake, dir } = await setup(); const built = await prepare(commands);
    expect((await applySourceCycle(commands, built.plan, { now })).status).toBe('DRY_RUN');
    expect(fake.calls.every(c => c.method === 'GET')).toBe(true); expect(await readdir(dir)).toEqual([]);
  });
  it('enrolls native fields using exists=false and verifies reversed map keys', async () => {
    const { commands, fake } = await setup(); fake.reverse(); const result = await apply(commands, await prepare(commands));
    expect(result).toMatchObject({ status: 'APPLIED', writes: 1, verified: 1 });
    const patch = fake.calls.find(c => c.method === 'PATCH')!;
    expect(patch.url.searchParams.get('currentDocument.exists')).toBe('false');
    const fields = decodeFields(fake.docs.get('TEST1001').fields);
    expect(fields).toMatchObject({ car_number: 'TEST1001', provider_company_code: source, maker: '', model: '', vehicle_review_required: true,
      price: { '12': { rent: 100, deposit: 0 } }, source_tab: 'test', source_row: 2 });
  });
  it('updates conditions, preserves unrelated raw, then is idempotent', async () => {
    const { commands, fake } = await setup([product()]); const next = product(); next.record.terms[0]!.monthlyRent = { state: 'KNOWN', value: 200 };
    expect((await apply(commands, await prepare(commands, [next.record]))).status).toBe('APPLIED');
    expect(decodeFields(fake.docs.get('TEST1001').fields).unrelated).toEqual({ preserve: true });
    expect((await prepare(commands, [next.record])).plan.entries).toHaveLength(0);
    expect(fake.calls.find(c => c.method === 'PATCH')!.url.searchParams.has('currentDocument.updateTime')).toBe(true);
  });
  it('withdraws with prior, then reexposes', async () => {
    const { commands, fake } = await setup([product()]);
    expect((await apply(commands, await prepare(commands, []))).status).toBe('APPLIED');
    expect(decodeFields(fake.docs.get('TEST1001').fields)).toMatchObject({ listable: false, status: '출고불가', status_kind: '불가',
      publication_withdrawal: { reason: 'SOURCE_ABSENT', deleteAuthorized: false }, publication_withdrawal_prior: { listable: true } });
    const built = await prepare(commands); expect(built.plan.entries[0]!.kind).toBe('REEXPOSE');
    expect((await apply(commands, built)).status).toBe('APPLIED');
  });
  it('backs up complete native documents and verifies immutable readback', async () => {
    const { commands, fake, dir } = await setup([product()]); const before = (await commands.list(source)).products[0]!;
    await commands.backup('key', before); expect(await commands.readBackup('key')).toEqual(before);
    const backup = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]!), 'utf8'));
    expect(backup.document).toEqual(fake.docs.get('TEST1001'));
    await expect(commands.backup('key', null)).rejects.toThrow('BACKUP_IMMUTABLE');
  });
  it('blocks backup tampering', async () => {
    const { commands, dir } = await setup([product()]); const before = (await commands.list(source)).products[0]!;
    await commands.backup('key', before); const file = join(dir, (await readdir(dir))[0]!);
    const b = JSON.parse(await readFile(file, 'utf8')); b.before.listable = false; await writeFile(file, JSON.stringify(b));
    await expect(commands.readBackup('key')).rejects.toThrow('BACKUP_MISMATCH');
  });
  it('stops on conditional-write conflict without retry', async () => {
    const { commands, fake } = await setup(); fake.setConflict();
    expect((await apply(commands, await prepare(commands))).status).toBe('APPLY_UNCERTAIN');
    expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });
  it('stops on changed readback', async () => {
    const { commands, fake } = await setup(); fake.setCorrupt();
    expect((await apply(commands, await prepare(commands))).status).toBe('APPLY_UNCERTAIN');
  });
  it('contract-locked products never enter a plan', async () => {
    const { commands, fake } = await setup([product()]); fake.docs.get('TEST1001').fields.locked_by_contract = { booleanValue: true };
    const built = await prepare(commands, []); expect(built.plan.entries).toHaveLength(0);
    expect((await apply(commands, built)).writes).toBe(0);
  });
  it('a lock arriving after backup blocks PATCH', async () => {
    const { commands, fake } = await setup([product()]); const before = (await commands.list(source)).products[0]!;
    await commands.backup('key', before); fake.docs.get('TEST1001').fields.locked_by_contract = { booleanValue: true };
    await expect(commands.compareAndApply(stableDigest(before), product(), 'key')).rejects.toThrow('CAS_CONFLICT');
    expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
  });
  it('same document ID owned by another supplier cannot enroll', async () => {
    const other = product(); other.record.sourceId = 'OTHER'; const { commands, fake } = await setup([other]);
    expect((await apply(commands, await prepare(commands))).status).toBe('APPLY_UNCERTAIN');
    expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
  });
  it('REST guard rejects observation-only writes', async () => {
    const { commands } = await setup(); const p = product(); p.record.sourceId = 'OBSERVE';
    await expect(commands.compareAndApply(stableDigest(null), p, 'key')).rejects.toThrow('OBSERVATION_ONLY');
  });
  it('rollback restores exact pre-write fields with external approval', async () => {
    const { commands, fake, dir } = await setup([product()]); const original = structuredClone(fake.docs.get('TEST1001').fields);
    await apply(commands, await prepare(commands, []));
    const b = JSON.parse(await readFile(join(dir, (await readdir(dir)).find(f => f.endsWith('.backup.json'))!), 'utf8'));
    await expect(commands.rollback(b.key, 'bad')).rejects.toThrow('ROLLBACK_APPROVAL_REQUIRED');
    expect(await commands.rollback(b.key, await commands.rollbackDigest(b.key))).toEqual({ status: 'ROLLED_BACK' });
    expect(fake.docs.get('TEST1001').fields).toEqual(original);
  });
  it('rollback enrollment withdraws instead of deleting', async () => {
    const { commands, fake, dir } = await setup(); await apply(commands, await prepare(commands));
    const b = JSON.parse(await readFile(join(dir, (await readdir(dir)).find(f => f.endsWith('.backup.json'))!), 'utf8'));
    await commands.rollback(b.key, await commands.rollbackDigest(b.key));
    expect(fake.docs.size).toBe(1); expect(decodeFields(fake.docs.get('TEST1001').fields).listable).toBe(false);
    expect(fake.calls.some(c => c.method === 'DELETE')).toBe(false);
  });
  it('rollback refuses changes after the verified receipt', async () => {
    const { commands, fake, dir } = await setup(); await apply(commands, await prepare(commands));
    const b = JSON.parse(await readFile(join(dir, (await readdir(dir)).find(f => f.endsWith('.backup.json'))!), 'utf8'));
    fake.docs.get('TEST1001').fields.locked_by_contract = { booleanValue: true };
    await expect(commands.rollback(b.key, await commands.rollbackDigest(b.key))).rejects.toThrow('CAS_CONFLICT');
  });
  it('source_cycle_record cannot mask an external price change', async () => {
    const { commands, fake } = await setup([product()]); fake.docs.get('TEST1001').fields.price = encodeFields({ price: {} }).price;
    await expect(commands.list(source)).rejects.toThrow('CATALOG_SOURCE_RECORD_DRIFT');
  });
  it('list uses only required fields, while backup reads full document', async () => {
    const { commands, fake } = await setup([product()]);
    const before = (await commands.list(source)).products[0]!; await commands.backup('projection', before);
    expect(fake.calls[0]!.url.searchParams.getAll('mask.fieldPaths')).toContain('locked_by_contract');
    expect(fake.calls[1]!.url.searchParams.has('mask.fieldPaths')).toBe(false);
  });
  it('a changed version between list and backup aborts before write', async () => {
    const { commands, fake } = await setup([product()]); const before = (await commands.list(source)).products[0]!;
    fake.docs.get('TEST1001').updateTime = 'changed';
    await expect(commands.backup('changed', before)).rejects.toThrow('BACKUP_SNAPSHOT_MISSING');
  });
  it.each([403, 429, 503])('HTTP %s is not an empty complete catalog', async status => {
    const commands = firestoreCycleCommands({ directory: await directory(), env: { FIREBASE_PROJECT_ID: 'synthetic-test' },
      token: async () => 'fake', fetcher: (async () => new Response('{}', { status })) as typeof fetch });
    await expect(commands.list(source)).rejects.toThrow('FIRESTORE_REQUEST_FAILED');
  });
  it('pagination cycle is rejected rather than counting repeated documents', async () => {
    const fetcher = vi.fn(async () => Response.json({ documents: [], nextPageToken: 'repeat' }));
    const commands = firestoreCycleCommands({ directory: await directory(), env: { FIREBASE_PROJECT_ID: 'synthetic-test' },
      token: async () => 'fake', fetcher: fetcher as typeof fetch });
    await expect(commands.list(source)).rejects.toThrow('CATALOG_PAGINATION_LOOP'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('withdrawal preserves legacy price aliases and unknown conditions', async () => {
    const { commands, fake } = await setup();
    const fields = { provider_company_code: source, car_number: 'TEST1001', status: '출고가능', listable: true,
      price: { '12': { rent: 100, deposit: null }, '12_extra': { rent: 200, deposit: 100 } } };
    fake.docs.set('TEST1001', { name: 'projects/synthetic-test/databases/(default)/documents/products/TEST1001', updateTime: time, fields: encodeFields(fields) });
    expect((await apply(commands, await prepare(commands, []))).status).toBe('APPLIED');
    expect(decodeFields(fake.docs.get('TEST1001').fields).price).toEqual(fields.price);
  });
});

function sheet(rows: Array<Record<string, SheetCell>>) {
  const channel = sharedSheetChannels[0]!, headers = [...sharedSheetHeaders, 'UID'];
  const capture: SharedSheetCapture = { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-only', layoutVersion: '2026-10-04-no-account',
    readTime: time, revision: 'synthetic', tabs: [...new Set(sharedSheetChannels.map(c => c.tab))].map(title => {
      const values = [headers, ...(title === channel.tab ? rows.map(row => headers.map(h => ({ 회사명: channel.companyName,
        차량번호: 'TEST1001', 차량상태: '출고가능', 상품구분: '중고렌트', '12개월': 100, 단기보증: '무보증', 장기보증: '무보증',
        연주행: '20000km', '차명 원문': '합성', ...row } as Record<string, SheetCell>)[h] ?? '')) : [])];
      return { title, readTime: time, complete: true, rowCount: values.length, values };
    }) };
  const visibility = { sheets: capture.tabs.map(t => ({ properties: { title: t.title, gridProperties: { rowCount: t.rowCount } },
    data: [{ startRow: 0, rowMetadata: t.values.map(() => ({} as { hiddenByUser?: boolean; hiddenByFilter?: boolean })) }] })) };
  return { capture, visibility, source: channel.code };
}
describe('native mappings and UID', () => {
  it('plate wins, placeholder needs explicit UID, never row fallback', () => {
    expect(sourceUid(' TEST 1001 ', 'sheet')).toBe('TEST1001'); expect(sourceUid('신차', 'new-one')).toBe('new-one'); expect(sourceUid('미정')).toBeNull();
  });
  it('F05 takes first duplicate and separately holds unassigned rows', () => {
    const s = sheet([{}, {}, { 차량번호: '신차' }, { 차량번호: '신차', UID: 'NEW-A' }]);
    const c = f05NativeCapture(s.source, s.capture, s.visibility);
    expect(c.rows.map(r => r.record.uid)).toEqual(['TEST1001', 'NEW-A']);
    expect(c.heldReasons).toContain('UID_REQUIRED'); expect(c.heldReasons).toContain('DUPLICATE_UID_SUSPECT');
    expect(c.rows[0]!.record.terms[0]!.deposit).toEqual({ state: 'ZERO', value: 0 });
    expect(c.rows[0]!.record.raw.source_row).toBe(2);
  });
  it.each(['hiddenByUser', 'hiddenByFilter'] as const)('F05 excludes %s rows', key => {
    const s = sheet([{}, { 차량번호: 'TEST1002' }]);
    s.visibility.sheets.find(t => t.properties.title === s.capture.tabs.find(t => t.rowCount > 1)!.title)!.data[0]!.rowMetadata[1]![key] = true;
    expect(f05NativeCapture(s.source, s.capture, s.visibility).rows.map(r => r.record.uid)).toEqual(['TEST1002']);
  });
  it('missing row metadata makes source incomplete', () => {
    const s = sheet([{}]); expect(f05NativeCapture(s.source, s.capture, {}).complete).toBe(false);
  });
  it('hidden tab is excluded and never proves supplier absence', () => {
    const s = sheet([{}]); const metadata: any = s.visibility;
    metadata.sheets.find((t: any) => t.properties.title === s.capture.tabs.find(t => t.rowCount > 1)!.title).properties.hidden = true;
    const c = f05NativeCapture(s.source, s.capture, metadata); expect(c.rows).toHaveLength(0); expect(c.complete).toBe(false);
  });
  it('unassigned UID HOLD prevents absent-product downgrade', () => {
    const s = sheet([{ 차량번호: '신차' }]), c = f05NativeCapture(s.source, s.capture, s.visibility);
    const p = product(); p.record.sourceId = s.source;
    const built = planSourceCycle({ sourceId: s.source, family: 'SHARED_SHEET', maxDowngradeRatio: 1 },
      { records: c.rows.map(r => r.record), complete: c.complete, observedAt: c.observedAt, heldCount: c.heldCount }, { complete: true, products: [p] }, now);
    expect(built.plan.entries).toHaveLength(0); expect(built.plan.held).toBeGreaterThan(0);
  });
  it('Aica maps A/B/C, separate monthly group, and first duplicate', async () => {
    const tables = AICA_SCOPES.map(title => ({ title, values: [['배차상태', '구분', '차량번호', '차명', '12개월', '보증금', '연주행', 'UID'],
      ['배차문의', '합성', title === '월렌트' ? 'TEST2002' : 'TEST2001', '합성차', 100, '무보증', '20000km', '']] }));
    const p = aicaNativePlugin(async () => aicaNativeCapture(tables, time), 0.2), out = p.toRecords(await p.read());
    expect(out.records).toHaveLength(2); expect(out.held).toHaveLength(2);
    expect(out.records[0]!.raw.sourceCycleDisplayStatus).toBe('출고협의');
    expect(out.records[1]!.raw.product_group).toBe('MONTHLY');
  });
  it('Aica wrong native header is incomplete instead of zero inventory', () => {
    expect(aicaNativeCapture([{ title: AICA_SCOPES[0], values: [['wrong']] }], time).complete).toBe(false);
  });
  it('Iron rejects unproven homepage coverage', () => {
    expect(() => ironNativeCapture('<html/>', time)).toThrow('IRON_LIST_SCHEMA_HOLD');
    expect(() => ironNativeCapture('<script id="__NEXT_DATA__">{"props":{"pageProps":{"vehicles":[],"total":1}}}</script>', time)).toThrow('IRON_LIST_COVERAGE_HOLD');
  });
  it('Iron maps complete published inventory and plate identity', async () => {
    const html = `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { total: 1, hasNextPage: false,
      vehicles: [{ car_number: 'TEST3001', car_name: '합성', published: true, price: { '12': { rent: 100, deposit: 0, mileage: '20000km' } } }] } } })}</script>`;
    const p = plateUidPlugin(sourceCyclePlugin({ sourceId: 'RP006', kind: 'IRON', scopes: ['homepage'], maxDowngradeRatio: 0.2 }, async () => ironNativeCapture(html, time)));
    expect(p.toRecords(await p.read()).records[0]).toMatchObject({ uid: 'TEST3001', status: { saleAvailable: true } });
  });
  it('observation plugin cannot call product commands even with apply=true', async () => {
    const base = sourceCyclePlugin({ sourceId: source, kind: 'SONOGONG', scopes: ['collector'], maxDowngradeRatio: 0.2 }, async () => ({
      observedAt: time, complete: true, completedScopes: ['collector'], visibilityComplete: true, heldCount: 0,
      rows: [{ scope: 'collector', record: product().record }] }));
    const { commands, fake } = await setup(); const ctrl = fileCycleControl(await directory(), async () => {});
    const result = await runSourceCycle({ ...base, observationOnly: true }, commands, ctrl, { apply: true, now: () => now });
    expect(result).toMatchObject({ status: 'OBSERVED', writes: 0 }); expect(fake.calls).toHaveLength(0);
  });
  it('fresh capture clock accepts approved unchanged facts; changed facts require replan', async () => {
    const { commands } = await setup(); const built = await prepare(commands), next = product().record;
    next.observedAt = new Date(now + 1000).toISOString();
    const p = sourceCyclePlugin({ sourceId: source, kind: 'IRON', scopes: ['inventory'], maxDowngradeRatio: 1 }, async () => ({
      observedAt: next.observedAt, complete: true, completedScopes: ['inventory'], visibilityComplete: true, heldCount: 0,
      rows: [{ scope: 'inventory', record: next }] }));
    const result = await runSourceCycle(p, commands, fileCycleControl(await directory(), async () => {}), {
      apply: true, approvedPlan: built.plan, digest: built.digest, approval: built.digest, now: () => now + 1000 });
    expect(result.status).toBe('APPLIED');
    next.vehicleText = 'changed';
    const rejected = await runSourceCycle(p, commands, fileCycleControl(await directory(), async () => {}), {
      apply: true, approvedPlan: built.plan, digest: built.digest, approval: built.digest, now: () => now + 1000 });
    expect(rejected.status).toBe('HOLD');
  });
  it('runtime construction/import does not fetch or authenticate', async () => {
    const fetcher = vi.fn(); const r = createSourceCycleRuntime({ FIREBASE_PROJECT_ID: 'synthetic-test', SOURCE_CYCLE_SOURCES: 'IANCAR,IRON',
      SOURCE_CYCLE_PRIVATE_DIR: await directory() }, fetcher as typeof fetch);
    expect(r.plugins).toHaveLength(2); expect(fetcher).not.toHaveBeenCalled();
  });
});
