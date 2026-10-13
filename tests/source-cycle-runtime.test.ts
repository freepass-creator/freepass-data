import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields, rawTitleBackfillFields } from '../src/infra/source-cycle-firestore.js';
import { sourceUid, f05NativeCapture, aicaNativeCapture, aicaNativePlugin, ironNativeCapture, plateUidPlugin } from '../src/adapters/source-cycle-native.js';
import { sourceCyclePlugin, AICA_SCOPES } from '../src/adapters/source-cycle-plugins.js';
import { sharedSheetChannels, sharedSheetChannelOf, sharedSheetHeaders, type SharedSheetCapture, type SheetCell } from '../src/adapters/shared-sheet-source.js';
import { planSourceCycle, applySourceCycle } from '../src/application/source-cycle.js';
import { runSourceCycle, runUnattendedSourceCycle } from '../src/jobs/source-cycle.js';
import { fileCycleControl } from '../src/adapters/source-cycle-control.js';
import { createSourceCycleRuntime, runtimeCli } from '../src/runtime/source-cycle-runtime.js';
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
    observationSources: ['OBSERVE'], supplierDefaults: { SYNTHETIC: { provider_name: '합성공급사', policy_code: 'SYNTHETIC_POLICY' } } });
  return { dir, fake, commands };
}
async function prepare(commands: Awaited<ReturnType<typeof setup>>['commands'], records = [product().record]) {
  return planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 },
    { records, observedAt: time, heldCount: 0, complete: true }, await commands.list(source), now);
}
const apply = (commands: Awaited<ReturnType<typeof setup>>['commands'], built: ReturnType<typeof planSourceCycle>) =>
  applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now });

describe('Firestore REST runtime offline', () => {
  it('SPEC3E enrolls independent modes from all supplier documents, including non-listable', async () => {
    const existing = ['A', 'B', 'C'].map(uid => ({ ...product(uid), listable: false }));
    const { commands, fake } = await setup(existing);
    for (const [index, uid] of ['A', 'B', 'C'].entries()) Object.assign(fake.docs.get(uid).fields,
      encodeFields({ provider_name: index < 2 ? 'Mode name' : 'Other name', policy_code: index > 0 ? 'MODE_POLICY' : 'OTHER_POLICY' }));
    const built = await prepare(commands);
    expect(built.plan.entries[0]!.after.supplierFields).toEqual({ provider_name: 'Mode name', policy_code: 'MODE_POLICY' });
    expect(await apply(commands, built)).toMatchObject({ status: 'APPLIED', verified: 1 });
    expect(decodeFields(fake.docs.get('TEST1001').fields)).toMatchObject({ provider_name: 'Mode name', policy_code: 'MODE_POLICY' });
    expect((await prepare(commands)).plan.entries).toEqual([]);
    expect(fake.calls[0]!.url.searchParams.getAll('mask.fieldPaths')).toEqual(expect.arrayContaining(['provider_name', 'policy_code']));
  });
  it('SPEC3E holds an unconfigured supplier without any existing name and makes no writes', async () => {
    const fake = fakeFirestore();
    const commands = firestoreCycleCommands({ directory: await directory(), env: { FIREBASE_PROJECT_ID: 'synthetic-test' },
      token: async () => 'synthetic-token', fetcher: fake.fetcher });
    const built = await prepare(commands);
    expect(built.plan).toMatchObject({ held: 1, entries: [], warnings: ['SUPPLIER_NAME_REQUIRED'] });
    expect(await apply(commands, built)).toMatchObject({ writes: 0 });
    expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('SPEC3E falls back to the existing supplier name configuration without inventing a policy', async () => {
    const { commands } = await setup();
    expect((await commands.list('RP004')).enrollmentSupplier).toEqual({ provider_name: '아이카', policy_code: null });
  });
  it('SPEC3E UPDATE preserves both original supplier fields and omits them from the patch', async () => {
    const { commands, fake } = await setup([product()]);
    Object.assign(fake.docs.get('TEST1001').fields, encodeFields({ provider_name: 'Original name', policy_code: 'ORIGINAL_POLICY' }));
    const next = product(); next.record.terms[0]!.monthlyRent = { state: 'KNOWN', value: 200 };
    const built = await prepare(commands, [next.record]);
    expect(built.plan.entries[0]!.kind).toBe('UPDATE');
    expect(await apply(commands, built)).toMatchObject({ status: 'APPLIED', verified: 1 });
    expect(decodeFields(fake.docs.get('TEST1001').fields)).toMatchObject({ provider_name: 'Original name', policy_code: 'ORIGINAL_POLICY' });
    expect(fake.calls.find(c => c.method === 'PATCH')!.url.searchParams.getAll('updateMask.fieldPaths'))
      .not.toEqual(expect.arrayContaining(['provider_name']));
    expect(fake.calls.find(c => c.method === 'PATCH')!.body.fields).not.toHaveProperty('policy_code');
  });
  it('SPEC3E supplier mode changes invalidate an approved enrollment plan', async () => {
    const { commands, fake } = await setup([ { ...product('A'), listable: false } ]);
    Object.assign(fake.docs.get('A').fields, encodeFields({ provider_name: 'Before', policy_code: 'P' }));
    const built = await prepare(commands);
    Object.assign(fake.docs.get('A').fields, encodeFields({ provider_name: 'After', policy_code: 'P' }));
    await expect(apply(commands, built)).rejects.toThrow('CYCLE_REPLAN_REQUIRED');
    expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
  });
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
    // 목록은 가격 불일치 문서의 uid 만 표시하고, 계획이 그 문서를 쓰게 되면 막는다. 번호판 불일치·쓰기 단계(read)는 계속 DRIFT 로 던진다.
    const snap = await commands.list(source);
    expect(snap.driftHeld).toEqual(['TEST1001']);
    const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 },
      { records: [product().record], observedAt: time, heldCount: 0, complete: true }, snap, now);
    expect(built.plan.blockers).toContain('CATALOG_SOURCE_RECORD_DRIFT');
    await expect(commands.read(source, 'TEST1001')).rejects.toThrow('CATALOG_SOURCE_RECORD_DRIFT');
  });
  it('--accept-drift 는 지정 코드의 가격 보정만 받아들이고 번호판 변경과 다른 코드는 계속 DRIFT', async () => {
    const { fake, dir } = await setup([product()]);
    const mk = (acceptDrift: string[]) => firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' },
      token: async () => 'synthetic-token', fetcher: fake.fetcher, acceptDrift });
    const price = decodeFields(fake.docs.get('TEST1001').fields).price as Record<string, any>;
    const corrected = Object.fromEntries(Object.entries(price).map(([m, v]) => [m, { ...v, deposit: 777000 }]));
    fake.docs.get('TEST1001').fields.price = encodeFields({ price: corrected }).price;
    expect((await mk([]).list(source)).driftHeld).toEqual(['TEST1001']);
    expect((await mk(['OTHER_CODE']).list(source)).driftHeld).toEqual(['TEST1001']);
    const snap = await mk([source]).list(source);
    expect(snap.acceptedDrift).toEqual(['TEST1001']);
    expect(snap.products[0]!.record.terms.every(t => t.deposit.value === 777000)).toBe(true);
    const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 },
      { records: [product().record], observedAt: time, heldCount: 0, complete: true }, snap, now);
    expect(built.plan.warnings.some(w => w.startsWith('DRIFT_ACCEPTED:1:'))).toBe(true);
    fake.docs.get('TEST1001').fields.car_number = encodeFields({ car_number: '다른번호' }).car_number;
    await expect(mk([source]).list(source)).rejects.toThrow('CATALOG_SOURCE_RECORD_DRIFT');
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
  it('a visible row whose company name maps to no supplier is held, so the same vehicle is never read as absent (경진 → 경진렌트)', () => {
    const s = sheet([{ 차량번호: 'TEST1001' }, { 회사명: '표기가 바뀐 회사', 차량번호: 'TEST2002' }]);
    const c = f05NativeCapture(s.source, s.capture, s.visibility);
    expect(c.rows.map(r => r.record.uid)).toEqual(['TEST1001']);
    expect(c.heldReasons).toContain('COMPANY_UNMAPPED'); expect(c.heldCount).toBeGreaterThan(0);
    const p = product('TEST2002'); p.record.sourceId = s.source;
    const built = planSourceCycle({ sourceId: s.source, family: 'SHARED_SHEET', maxDowngradeRatio: 1 },
      { records: c.rows.map(r => r.record), complete: c.complete, observedAt: c.observedAt, heldCount: c.heldCount }, { complete: true, products: [p] }, now);
    expect(built.plan.entries.filter(e => e.kind === 'DOWNGRADE')).toHaveLength(0);
    expect(built.plan.warnings).toContain('ABSENCE_DOWNGRADE_SKIPPED');
  });
  it('the approved alias maps «경진렌트» to RP015 on the 경진 tab only; RP016 and other tabs are unchanged (대표 10-13)', () => {
    expect(sharedSheetChannelOf('경진', '경진렌트')?.code).toBe('RP015');
    expect(sharedSheetChannelOf('경진', ' 경진렌트 ')?.code).toBe('RP015');
    expect(sharedSheetChannelOf('경진', '경진')?.code).toBe('RP015');
    expect(sharedSheetChannelOf('경진', '경진카')?.code).toBe('RP016');
    expect(sharedSheetChannelOf('빌린카', '경진렌트')).toBeUndefined();          // 별칭은 탭 단위로만
    expect(sharedSheetChannelOf('경진', '경진렌트카')).toBeUndefined();           // 비슷한 이름은 추론하지 않는다
    const aliased = sharedSheetChannels.filter(c => (c as { aliases?: string[] }).aliases?.length);
    expect(aliased.map(c => `${c.code}:${c.tab}`)).toEqual(['RP015:경진']);
  });
  it('an aliased row is read as the RP015 vehicle, so it is never held as unmapped nor read as absent', () => {
    const ch = sharedSheetChannels.find(c => c.code === 'RP015')!;
    const headers = [...sharedSheetHeaders, 'UID'];
    const row = headers.map(h => ({ 회사명: '경진렌트', 차량번호: 'TEST3003', 차량상태: '출고가능', 상품구분: '중고렌트', '12개월': 100,
      단기보증: '무보증', 장기보증: '무보증', 연주행: '20000km', '차명 원문': '합성' } as Record<string, SheetCell>)[h] ?? '');
    const capture: SharedSheetCapture = { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-only', layoutVersion: '2026-10-04-no-account',
      readTime: time, revision: 'synthetic', tabs: [...new Set(sharedSheetChannels.map(c => c.tab))].map(title => {
        const values = [headers, ...(title === ch.tab ? [row] : [])];
        return { title, readTime: time, complete: true, rowCount: values.length, values };
      }) };
    const visibility = { sheets: capture.tabs.map(t => ({ properties: { title: t.title, gridProperties: { rowCount: t.rowCount } },
      data: [{ startRow: 0, rowMetadata: t.values.map(() => ({})) }] })) };
    const c = f05NativeCapture('RP015', capture, visibility);
    expect(c.rows.map(r => r.record.uid)).toEqual(['TEST3003']);
    expect(c.heldReasons ?? []).not.toContain('COMPANY_UNMAPPED');
    expect(f05NativeCapture('RP016', capture, visibility).rows).toHaveLength(0);   // 같은 탭의 경진카는 이 행을 가져가지 않는다
  });
  it('hidden rows of an unmapped company do not hold the source', () => {
    const s = sheet([{ 차량번호: 'TEST1001' }, { 회사명: '표기가 바뀐 회사', 차량번호: 'TEST2002' }]);
    s.visibility.sheets.find(t => t.properties.title === s.capture.tabs.find(t => t.rowCount > 1)!.title)!.data[0]!.rowMetadata[2]!.hiddenByUser = true;
    expect(f05NativeCapture(s.source, s.capture, s.visibility).heldReasons ?? []).not.toContain('COMPANY_UNMAPPED');
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
  const aicaHeaders = ['배차상태', '구분', '차량번호', '차급', '차종분류', '트림', '연료', '외장', '내장', 'Km', '월렌트', '장기보증',
    '36개월', '48개월', '60개월', '옵션', '최초등록', '소비자가격', '제조사', '배기량', '연주행', '대인', '대물', '자차', '자손'];
  const aicaRow = (overrides: Record<string, unknown> = {}) => aicaHeaders.map(h => ({
    배차상태: '배차문의', 구분: '재렌트', 차량번호: 'TEST2001', 차급: '합성급', 차종분류: '합성모델', 트림: '합성트림 2WD A/T',
    연료: '합성연료', 외장: '원문 외장', 내장: '원문 내장', Km: '12,345', 월렌트: '999,999', 장기보증: '무보증',
    '36개월': '123,456', '48개월': '', '60개월': 234567, 옵션: '원문 옵션', 최초등록: '2025-01', 소비자가격: '31,234,567',
    제조사: '합성제조사', 배기량: '1,234', 연주행: '3만km', 대인: '원문 대인', 대물: '원문 대물', 자차: '원문 자차', 자손: '원문 자손',
    ...overrides } as Record<string, unknown>)[h]);
  function aicaFixture(rows = [aicaRow(), aicaRow({ 차량번호: 'TEST2002', 장기보증: '1,234,000', 배차상태: '배차중' })]) {
    const tables = AICA_SCOPES.map((title, i) => ({ title, values: title === '월렌트' ?
      [['차종', '1개월']] : [aicaHeaders, ...(i === 0 ? rows : [])] }));
    const meta = { sheets: tables.map(t => ({ properties: { title: t.title, hidden: false, gridProperties: { rowCount: t.values.length } },
      data: [{ startRow: 0, rowMetadata: t.values.map(() => ({ hiddenByUser: false, hiddenByFilter: false })) }] })) };
    return { tables, meta };
  }
  async function aicaRead(f = aicaFixture()) {
    const capture = aicaNativeCapture(f.tables, time, f.meta);
    const plugin = aicaNativePlugin(async () => capture, 1), read = await plugin.read();
    return { capture, plugin, read, ...plugin.toRecords(read) };
  }
  it('SPEC3D monthly numeric offers normalize identity, preserve raw and flag duplicates separately', async () => {
    const f = aicaFixture();
    f.tables[3]!.values = [['차종', '1개월', '비고'], [' Model a ', '345,678', '월렌트 무보증'],
      ['MODEL A', 456789], ['Model B', 500000], ['Unavailable', 'x'], ['Blank', ''], ['Empty', null],
      ['Non numeric', '무보증'], ['Invalid', -1]];
    f.meta.sheets[3]!.properties.gridProperties.rowCount = f.tables[3]!.values.length;
    f.meta.sheets[3]!.data[0]!.rowMetadata = f.tables[3]!.values.map(() => ({ hiddenByUser: false, hiddenByFilter: false }));
    const before = structuredClone(f), out = await aicaRead(f);
    expect(out.read.complete).toBe(true); expect(f).toEqual(before);
    expect(out.held).toEqual([{ row: 0, reasons: ['DUPLICATE_UID_SUSPECT'] }]);
    const monthly = out.records.filter(r => r.raw.product_group === 'MONTHLY_RENT');
    expect(monthly.map(r => r.uid)).toEqual(['RP004:MONTHLY:MODELA', 'RP004:MONTHLY:MODELB']);
    expect(new Set(out.records.map(r => r.uid)).size).toBe(4);
    expect(monthly[0]).toMatchObject({ plate: null, vehicleText: ' Model a ', status: { saleAvailable: true },
      terms: [{ months: 1, monthlyRent: { value: 345678 }, deposit: { state: 'ZERO', value: 0 }, mileage: '월렌트' }] });
    expect(monthly[1]!.terms[0]!.deposit).toEqual({ state: 'UNKNOWN', value: null });
    const { commands, fake } = await setup();
    const evidence = { records: out.records, complete: true, observedAt: time, heldCount: out.held.length };
    const built = planSourceCycle(out.plugin, evidence, await commands.list('RP004'), now);
    expect(built.plan.entries).toHaveLength(4);
    expect(await apply(commands, built)).toMatchObject({ status: 'APPLIED', verified: 4 });
    expect(decodeFields(fake.docs.get('RP004:MONTHLY:MODELB').fields)).toMatchObject({
      product_group: 'MONTHLY_RENT', car_number: null, maker: '', model: '', sub_model: expect.any(String), trim_name: '', vehicle_review_required: true, vehicle_title_source: 'RAW_VEHICLE_TEXT',
      price: { '1': { rent: 500000, deposit: null, mileage: '월렌트' } }, provider_name: '아이카' });
    expect(planSourceCycle(out.plugin, evidence, await commands.list('RP004'), now).plan.entries).toEqual([]);
    const ctrl = fileCycleControl(await directory(), async () => {});
    const result = await runSourceCycle(out.plugin, commands, ctrl, { now: () => now });
    expect(result.status).toBe('DRY_RUN');
    expect(result.summary).toContain('장기 2 · 월렌트 2'); expect(result.summary).toContain('번호미배정 0');
    // Reordering changes row provenance, never the model identity.
    f.tables[3]!.values = [f.tables[3]!.values[0]!, ...f.tables[3]!.values.slice(1).reverse()];
    expect((await aicaRead(f)).records.filter(r => r.raw.product_group === 'MONTHLY_RENT').map(r => r.uid).sort())
      .toEqual(monthly.map(r => r.uid).sort());
  });
  it.each(['', '  ', null, undefined])('SPEC3C creates only the populated 48-month period (blank=%s)', async blank => {
    const out = await aicaRead(aicaFixture([aicaRow({ '36개월': blank, '48개월': '456,789', '60개월': blank })]));
    expect(out.records[0]!.terms.map(t => t.months)).toEqual([48]);
    const built = planSourceCycle(out.plugin, { records: out.records, complete: out.read.complete, observedAt: time, heldCount: 0 },
      { complete: true, products: [] }, now);
    expect(built.plan.held).toBe(0);
    expect(built.plan.entries.map(e => e.kind)).toEqual(['ENROLL']);
    expect(built.plan.entries[0]!.after.listable).toBe(true);
  });
  it('SPEC3C F05 missing tabs and partial row coverage remain incomplete', async () => {
    const s = sheet([{}]);
    const plugin = sourceCyclePlugin({ sourceId: s.source, kind: 'F05',
      scopes: [...new Set(sharedSheetChannels.filter(c => c.code === s.source).map(c => c.tab))], maxDowngradeRatio: 1 },
      async () => f05NativeCapture(s.source, s.capture, s.visibility));
    const tab = s.capture.tabs.find(t => t.rowCount > 1)!;
    Object.assign(tab, { complete: false }); // Deliberately malformed transport fixture.
    expect((await plugin.read()).complete).toBe(false);
    tab.complete = true; tab.rowCount++;
    expect((await plugin.read()).complete).toBe(false);
    s.capture.tabs = s.capture.tabs.filter(t => t !== tab);
    expect((await plugin.read()).complete).toBe(false);
  });
  it.each(['AICA', 'F05'] as const)('SPEC3C %s holds one unidentified row without blocking known-row plans', async kind => {
    let plugin;
    if (kind === 'AICA') {
      plugin = (await aicaRead(aicaFixture([
        aicaRow(), aicaRow({ 차량번호: 'TEST2002' }), aicaRow({ 차량번호: 'TEST2003' }),
        aicaRow({ 차량번호: 'TEST2004', 배차상태: '출고불가' }), aicaRow({ 차량번호: '' }),
      ]))).plugin;
    } else {
      const s = sheet([{}, { 차량번호: 'TEST2002' }, { 차량번호: 'TEST2003' },
        { 차량번호: 'TEST2004', 차량상태: '출고불가' }, { 차량번호: '신차' }]);
      const capture = f05NativeCapture(s.source, s.capture, s.visibility);
      plugin = sourceCyclePlugin({ sourceId: s.source, kind, scopes: capture.completedScopes, maxDowngradeRatio: 1 }, async () => capture);
    }
    const read = await plugin.read(), converted = plugin.toRecords(read);
    expect(read.complete).toBe(true); expect(read.error).toBeNull();
    expect(converted.held).toHaveLength(1);
    const old = converted.records.slice(1).map(record => ({ ...product(record.uid), record: structuredClone(record) }));
    old[0]!.record.vehicleText = 'previous facts';
    old[1]!.listable = false;
    old[2]!.record.status = { raw: '출고가능', saleAvailable: true };
    const absent = structuredClone(old[0]!); absent.record.uid = 'TEST9999'; absent.record.plate = 'TEST9999';
    const snapshot = { complete: true, products: [...old, absent] };
    const noWrite = vi.fn(async (): Promise<never> => { throw Error('UNEXPECTED_WRITE'); });
    const commands = { list: async () => snapshot, read: noWrite, backup: noWrite, readBackup: noWrite, compareAndApply: noWrite };
    const ctrl = fileCycleControl(await directory(), async () => {});
    const result = await runSourceCycle(plugin, commands, ctrl, { now: () => now });
    expect(result.status).toBe('DRY_RUN');
    expect(result.summary).toContain('번호미배정 1');
    expect(result.summary).toContain('ABSENCE_DOWNGRADE_SKIPPED');
    const plan = 'plan' in result ? result.plan! : null;
    expect(plan).toMatchObject({ blockers: [], warnings: ['ABSENCE_DOWNGRADE_SKIPPED'], unassignedPlateCount: 1,
      held: 1, evidence: { complete: true, unassignedPlateCount: 1 } });
    expect(plan!.entries.map(e => e.kind).sort()).toEqual(['DOWNGRADE', 'ENROLL', 'REEXPOSE', 'UPDATE']);
    expect(plan!.entries.filter(e => e.after.publication_withdrawal?.reason === 'SOURCE_ABSENT')).toEqual([]);
    expect(plan!.entries.find(e => e.kind === 'DOWNGRADE')!.after.publication_withdrawal?.reason).toBe('SOURCE_NOT_SELLABLE');
    expect(await ctrl.load(plugin.sourceId)).toMatchObject({ failures: 0, error: null, lastCompleteAt: time, unassignedPlateCount: 1 });
    expect(noWrite).not.toHaveBeenCalled();
  });
  it('Aica SPEC3B maps ZERO/KNOWN, populated periods and unchanged RAW', async () => {
    const f = aicaFixture(), before = structuredClone(f), out = await aicaRead(f);
    expect(out.read.complete).toBe(true); expect(out.held).toEqual([]); expect(out.records).toHaveLength(2);
    expect(out.records[0]).toMatchObject({ uid: 'TEST2001', vehicleText: '합성모델 합성트림 2WD A/T',
      status: { raw: '배차문의', saleAvailable: true }, vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'],
      raw: { sourceCycleDisplayStatus: '출고협의', original: { 제조사: '합성제조사', 최초등록: '2025-01', 소비자가격: '31,234,567',
        배기량: '1,234', 연료: '합성연료', Km: '12,345', 외장: '원문 외장', 내장: '원문 내장' } } });
    expect(out.records[0]!.terms.map(t => t.months)).toEqual([36, 60]);
    expect(out.records[0]!.terms.map(t => t.monthlyRent.value)).toEqual([123456, 234567]);
    expect(out.records[0]!.terms.every(t => t.deposit.state === 'ZERO' && t.deposit.value === 0 && t.mileage === '3만km')).toBe(true);
    expect(out.records[1]!.terms.every(t => t.deposit.state === 'KNOWN' && t.deposit.value === 1234000)).toBe(true);
    expect(out.records[0]!.raw.cells).toEqual(f.tables[0]!.values[1]); expect(f).toEqual(before);
    expect(nativeCycleFields({ ...product(), record: out.records[0]! })).toMatchObject({
      maker: '', model: '', sub_model: out.records[0]!.vehicleText, trim_name: '', vehicle_review_required: true });
    expect(rawTitleBackfillFields({ vehicle_review_required: true, maker: '', model: '', sub_model: '', trim_name: '', car_name: 'G80 (18년식)' }))
      .toEqual({ sub_model: 'G80 (18년식)', vehicle_title_source: 'RAW_VEHICLE_TEXT' });
    expect(rawTitleBackfillFields({ vehicle_review_required: true, maker: '현대', model: '', sub_model: '', trim_name: '', car_name: 'x' })).toBeNull();
    expect(rawTitleBackfillFields({ vehicle_review_required: false, car_name: 'x' })).toBeNull();
  });
  it.each(['', '협의', null, -1, '12,34'])('Aica ambiguous deposit %s remains UNKNOWN', async deposit => {
    const out = await aicaRead(aicaFixture([aicaRow({ 장기보증: deposit })]));
    expect(out.records[0]!.terms.every(t => t.deposit.state === 'UNKNOWN' && t.deposit.value === null)).toBe(true);
  });
  it.each(['배차문의', '수리중', '배차중', '배차가능', '출고불가'])('Aica only explicit stop is unavailable: %s', async status => {
    const out = await aicaRead(aicaFixture([aicaRow({ 배차상태: status })]));
    expect(out.records[0]!.status.saleAvailable).toBe(status !== '출고불가');
    if (status === '수리중') expect(out.records[0]!.raw.sourceCycleDisplayStatus).toBe('상품화중');
  });
  it('Aica preserves legacy monthly observations outside the new typed monthly group', async () => {
    const out = await aicaRead(); expect(out.capture.observationOnlyCount).toBe(0);
    expect(out.plugin.observationCountOfRead!(out.read)).toBe(0);
    const monthly = product('MONTHLY'); monthly.record.sourceId = 'RP004'; monthly.record.raw.source_tab = '월렌트';
    const plan = planSourceCycle(out.plugin, { records: out.records, complete: true, observedAt: time, heldCount: 0 },
      { complete: true, products: [monthly] }, now).plan;
    expect(plan.sourceCount).toBe(2); expect(plan.exposedBefore).toBe(0);
    expect(plan.entries.map(e => e.kind)).toEqual(['ENROLL', 'ENROLL']); expect(out.held).toEqual([]);
  });
  it('Aica same plate yields UPDATE then no change, never absence DOWNGRADE', async () => {
    const out = await aicaRead(), old = out.records.map(record => ({ ...product(record.uid), record: structuredClone(record) }));
    old[0]!.record.terms[0]!.monthlyRent = { state: 'KNOWN', value: 111111 };
    const evidence = { records: out.records, complete: true, observedAt: time, heldCount: 0 };
    const plan = planSourceCycle(out.plugin, evidence, { complete: true, products: old }, now).plan;
    expect(plan.held).toBe(0); expect(plan.blockers).toEqual([]); expect(plan.entries.map(e => e.kind)).toEqual(['UPDATE']);
    old[0] = plan.entries[0]!.after;
    expect(planSourceCycle(out.plugin, evidence, { complete: true, products: old }, now).plan.entries).toEqual([]);
  });
  it('Aica legacy Firestore monthly documents stay outside dry-run; summary separates product groups', async () => {
    const out = await aicaRead(), { commands, fake } = await setup();
    fake.docs.set('MONTHLY', { name: 'projects/synthetic-test/databases/(default)/documents/products/MONTHLY',
      updateTime: time, fields: encodeFields({ provider_company_code: 'RP004', listable: true, status: '가용',
        source: 'aica-sheet', source_tab: '월렌트', product_group: 'MONTHLY' }) });
    const ctrl = fileCycleControl(await directory(), async () => {});
    const result = await runSourceCycle(out.plugin, commands, ctrl, { now: () => now });
    expect(result.status).toBe('DRY_RUN'); expect(result.summary).toContain('하향 0');
    expect(result.summary).toContain('장기 2 · 월렌트 0'); expect(result.summary).toContain('번호미배정 0');
    expect((await ctrl.load('RP004')).observationOnlyCount).toBe(0);
    expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
    expect(fake.calls[0]!.url.searchParams.getAll('mask.fieldPaths')).toContain('source_tab');
    expect(fake.calls[0]!.url.searchParams.getAll('mask.fieldPaths')).toContain('`원문`');
  });
  it.each([0, 1234000])('Aica numeric deposit %s and whitespace-empty period', async deposit => {
    const out = await aicaRead(aicaFixture([aicaRow({ 장기보증: deposit, '48개월': '  ' })]));
    expect(out.records[0]!.terms.map(t => t.months)).toEqual([36, 60]);
    expect(out.records[0]!.terms.every(t => t.deposit.value === deposit && t.deposit.state === (deposit ? 'KNOWN' : 'ZERO'))).toBe(true);
  });
  it('Aica excludes hidden rows and tabs; missing visibility/header is incomplete', async () => {
    const f = aicaFixture([aicaRow(), aicaRow({ 차량번호: 'TEST2002' }), aicaRow({ 차량번호: 'TEST2003' })]);
    f.meta.sheets[0]!.data[0]!.rowMetadata[1]!.hiddenByUser = true;
    f.meta.sheets[0]!.data[0]!.rowMetadata[2]!.hiddenByFilter = true;
    expect((await aicaRead(f)).records.map(r => r.uid)).toEqual(['TEST2003']);
    f.meta.sheets[0]!.properties.hidden = true;
    expect((await aicaRead(f)).records).toEqual([]); expect((await aicaRead(f)).read.complete).toBe(false);
    expect(aicaNativeCapture(f.tables, time).complete).toBe(false);
    const wrong = aicaFixture(); wrong.tables[0]!.values[0] = ['wrong'];
    expect((await aicaRead(wrong)).read.complete).toBe(false);
  });
  it('Aica plate-only UID, duplicate and unassigned holds protect absence', async () => {
    const f = aicaFixture([aicaRow(), aicaRow(), aicaRow({ 차량번호: '' })]);
    f.tables[0]!.values[0]!.push('UID'); f.tables[0]!.values[3]!.push('DO_NOT_USE');
    const out = await aicaRead(f); expect(out.records).toHaveLength(1);
    expect(out.held.flatMap(h => h.reasons)).toEqual(['DUPLICATE_UID_SUSPECT', 'UID_REQUIRED', 'UNASSIGNED_PLATE']);
    const old = product('TEST9999'); old.record.sourceId = 'RP004';
    const plan = planSourceCycle(out.plugin, { records: out.records, complete: true, observedAt: time, heldCount: out.held.length },
      { complete: true, products: [old] }, now).plan;
    expect(plan.entries.some(e => e.kind === 'DOWNGRADE')).toBe(false);
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

describe('unattended hourly cycle (대표 2026-10-13: 1시간 간격 무인 적용)', () => {
  const plugin = (record = product().record) => sourceCyclePlugin({ sourceId: source, kind: 'IRON', scopes: ['inventory'], maxDowngradeRatio: 1 },
    async () => ({ observedAt: time, complete: true, completedScopes: ['inventory'], visibilityComplete: true, heldCount: 0,
      rows: [{ scope: 'inventory', record }] }));
  it('plans then applies in one run, and the next run has nothing to apply', async () => {
    const { commands, fake } = await setup(); const ctrl = fileCycleControl(await directory(), async () => {});
    const first = await runUnattendedSourceCycle(plugin(), commands, ctrl, { now: () => now + 1000 });
    expect(first).toMatchObject({ stage: 'APPLY', status: 'APPLIED', writes: 1, verified: 1 });
    expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
    const second = await runUnattendedSourceCycle(plugin(), commands, ctrl, { now: () => now + 2000 });
    expect(second).toMatchObject({ stage: 'PLAN', status: 'DRY_RUN', writes: 0 });
    expect(second.summary).toContain('변경 0');
    expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });
  it('reads the source exactly once per cycle, so a slow source that changes mid-run cannot abort the apply (이안카 5분 읽기)', async () => {
    const { commands, fake } = await setup(); const ctrl = fileCycleControl(await directory(), async () => {});
    let reads = 0;
    const slow = sourceCyclePlugin({ sourceId: source, kind: 'IRON', scopes: ['inventory'], maxDowngradeRatio: 1 }, async () => {
      reads++;
      const r = product().record; r.terms[0]!.monthlyRent = { state: 'KNOWN', value: 100 * reads };   // 읽을 때마다 값이 달라지는 원천
      return { observedAt: time, complete: true, completedScopes: ['inventory'], visibilityComplete: true, heldCount: 0,
        rows: [{ scope: 'inventory', record: r }] };
    });
    const result = await runUnattendedSourceCycle(slow, commands, ctrl, { now: () => now + 1000 });
    expect(reads).toBe(1);
    expect(result).toMatchObject({ stage: 'APPLY', status: 'APPLIED', writes: 1, verified: 1 });
    expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });
  it('never writes when the plan is blocked', async () => {
    const { commands, fake } = await setup([product('TEST1001'), product('TEST1002'), product('TEST1003')]);
    const strict = sourceCyclePlugin({ sourceId: source, kind: 'IRON', scopes: ['inventory'], maxDowngradeRatio: 0.1 },
      async () => ({ observedAt: time, complete: true, completedScopes: ['inventory'], visibilityComplete: true, heldCount: 0, rows: [] }));
    const result = await runUnattendedSourceCycle(strict, commands, fileCycleControl(await directory(), async () => {}), { now: () => now + 1000 });
    expect(result.stage).toBe('PLAN'); expect(result.status).toBe('HOLD');
    expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('observation-only sources finish at OBSERVED without product writes', async () => {
    const { commands, fake } = await setup();
    const result = await runUnattendedSourceCycle({ ...plugin(), observationOnly: true }, commands, fileCycleControl(await directory(), async () => {}), { now: () => now + 1000 });
    expect(result).toMatchObject({ stage: 'PLAN', status: 'OBSERVED', writes: 0 });
    expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('runtime CLI refuses --unattended without the explicit env opt-in or with manual approval args', async () => {
    const env = { FIREBASE_PROJECT_ID: 'synthetic-test', SOURCE_CYCLE_SOURCES: 'IRON', SOURCE_CYCLE_PRIVATE_DIR: await directory() };
    await expect(runtimeCli(['--unattended'], env)).rejects.toThrow('UNATTENDED_NOT_ENABLED');
    await expect(runtimeCli(['--unattended', '--apply'], { ...env, SOURCE_CYCLE_UNATTENDED: '1' })).rejects.toThrow('UNATTENDED_ARGS_INVALID');
    await expect(runtimeCli(['--unattended', '--plan', 'x.json'], { ...env, SOURCE_CYCLE_UNATTENDED: '1' })).rejects.toThrow('UNATTENDED_ARGS_INVALID');
  });
});
