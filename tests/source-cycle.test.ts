import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile, utimes } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSourceCycle, applySourceCycle, deepEqual, emptyCycleState,
  type CycleProduct, type CycleCommands, type CycleControl, type CycleEvidence, type CycleConfig } from '../src/application/source-cycle.js';
import { compactRecord } from '../src/domain/source-engine.js';
import { sourceCyclePlugin, sharedSheetCyclePlugin, iancarCyclePlugin, AICA_SCOPES, type CycleCapture, type CycleSourceKind } from '../src/adapters/source-cycle-plugins.js';
import { sharedSheetChannels, sharedSheetHeaders, type SharedSheetCapture, type SheetCell } from '../src/adapters/shared-sheet-source.js';
import type { IancarOneListCapture } from '../src/adapters/iancar-one-api.js';
import { fileCycleControl, sourceRunCycleHeartbeat, STALE_LOCK_MS } from '../src/adapters/source-cycle-control.js';
import { runSourceCycle, sourceCycleCli } from '../src/jobs/source-cycle.js';
import { stableDigest } from '../src/shared/stable-digest.js';
import { validateSourceRecord, sourceSaleAvailable, salePriceMap, type SourceProductRecord } from '../src/domain/source-engine.js';
import { nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
import type { SourceIngestionStore } from '../src/ports/source-store.js';

const time = '2026-10-12T00:00:00.000Z', now = Date.parse(time);
const config: CycleConfig = { sourceId: 'SYNTHETIC', family: 'OTHER', maxDowngradeRatio: 0.5 };
const record = (uid: string, status = '게시'): SourceProductRecord => ({ sourceId: config.sourceId, uid, plate: null,
  vehicleText: '합성 차종', status: { raw: status, saleAvailable: true }, observedAt: time, raw: { price: { a: 1, b: 2 } }, vehicleHold: [],
  terms: [{ months: 12, monthlyRent: { state: 'KNOWN', value: 100 }, deposit: { state: 'ZERO', value: 0 }, mileage: '20000km', raw: {} }] });
const product = (uid: string, listable = true): CycleProduct => ({ record: record(uid), listable, locked_by_contract: false,
  publication_withdrawal: null, publication_withdrawal_prior: null });
const evidence = (records: SourceProductRecord[], complete = true): CycleEvidence => ({ records, complete, observedAt: time, heldCount: 0 });
function memory(initial: CycleProduct[] = []) {
  const data = new Map(initial.map(p => [p.record.uid, structuredClone(p)]));
  const backups = new Map<string, CycleProduct | null>();
  const order: string[] = [];
  const commands: CycleCommands = {
    async list() { return { complete: true, products: structuredClone([...data.values()]) }; },
    async read(_source, uid) { return structuredClone(data.get(uid) ?? null); },
    async backup(key, value) { order.push('backup'); backups.set(key, structuredClone(value)); },
    async readBackup(key) { if (!backups.has(key)) throw Error('BACKUP_MISSING'); return structuredClone(backups.get(key)!); },
    async compareAndApply(digest, after) {
      if (stableDigest(data.get(after.record.uid) ?? null) !== digest) throw Error('CAS_CONFLICT');
      order.push('write'); data.set(after.record.uid, structuredClone(after));
    },
  };
  return { commands, data, backups, order };
}
function control() {
  let state = emptyCycleState(), busy = false;
  const alerts: string[] = [];
  const ctrl: CycleControl = {
    async acquire() { if (busy) return null; busy = true; return async () => { busy = false; }; },
    async load() { return structuredClone(state); }, async save(_id, s) { state = structuredClone(s); },
    heartbeat: vi.fn(async () => {}), async alert(_id, reason) { alerts.push(reason); },
  };
  return { ctrl, alerts };
}
function capture(rows: SourceProductRecord[], scopes = ['inventory']): CycleCapture {
  return { observedAt: time, complete: true, completedScopes: scopes, visibilityComplete: true, heldCount: 0,
    rows: rows.map(r => ({ scope: scopes[0]!, record: r })) };
}
const plugin = (read: () => Promise<CycleCapture>, kind: CycleSourceKind = 'IRON') => sourceCyclePlugin(
  { sourceId: config.sourceId, kind, scopes: kind === 'AICA' ? [...AICA_SCOPES] : ['inventory'], maxDowngradeRatio: 0.5 }, read, () => time);
async function apply(commands: CycleCommands, plan: ReturnType<typeof planSourceCycle>) {
  return applySourceCycle(commands, plan.plan, { apply: true, digest: plan.digest, approval: plan.digest, now });
}

describe('source cycle planning/application', () => {
  it('source 3/catalog 5: two withdrawals, one source-built enrollment, conditions update and idempotent replay', async () => {
    const m = memory(['a', 'b', 'absent1', 'absent2'].map(id => product(id)).concat(product('historical', false)));
    const rows = [record('a'), record('b'), record('new')]; rows[0]!.terms[0]!.monthlyRent = { state: 'KNOWN', value: 200 };
    rows[2]!.vehicleHold = ['VEHICLE_MASTER_REVIEW_REQUIRED'];
    const build = () => planSourceCycle(config, evidence(rows), { products: [...m.data.values()], complete: true }, now);
    const built = build();
    expect(built.plan.entries.map(e => e.kind).sort()).toEqual(['DOWNGRADE', 'DOWNGRADE', 'ENROLL', 'UPDATE']);
    expect((await applySourceCycle(m.commands, built.plan, { now })).writes).toBe(0);
    expect(m.order).toEqual([]);
    expect(await apply(m.commands, built)).toMatchObject({ status: 'APPLIED', writes: 4, verified: 4 });
    expect(m.order.slice(0, 4)).toEqual(['backup', 'backup', 'backup', 'backup']);
    expect(m.data.size).toBe(6);
    expect(m.data.get('new')!.record.vehicleHold).toHaveLength(1);
    expect(m.data.get('absent1')).toMatchObject({ listable: false, publication_withdrawal: { reason: 'SOURCE_ABSENT', deleteAuthorized: false }, publication_withdrawal_prior: { listable: true } });
    expect(m.data.get('absent1')!.record.raw).toEqual(compactRecord(product('absent1').record).raw);   // 쓰기 형태(압축)로 저장
    expect(build().plan.entries).toEqual([]);
    rows.forEach(r => { r.observedAt = new Date(now + 1000).toISOString(); });
    expect(planSourceCycle(config, { ...evidence(rows), observedAt: rows[0]!.observedAt }, { complete: true, products: [...m.data.values()] }, now + 1000).plan.entries).toEqual([]);
  });
  it('absence downgrade of a legacy full-raw document is verified against the compact form the store reads back', async () => {
    const legacy = (uid: string): CycleProduct => { const p = product(uid);
      p.record.raw = { cells: ['수리중', '재렌트', uid, 'x'.repeat(80)], headers: ['a', 'b'], original: { 차량번호: uid, memo: 'y'.repeat(80) }, source: 'sheet' }; return p; };
    const m = memory(['keep', 'gone1', 'gone2'].map(legacy));
    // 실제 저장소 모사: 쓸 때 record 를 압축해 저장하고 되읽기는 압축 형태를 돌려준다.
    const compactStore: CycleCommands = { ...m.commands,
      async compareAndApply(digest, after, key) { await m.commands.compareAndApply(digest, { ...after, record: compactRecord(after.record) }, key); } };
    const rows = [record('keep')];
    rows[0]!.raw = legacy('keep').record.raw;
    const built = planSourceCycle({ ...config, maxDowngradeRatio: 1 }, evidence(rows), { products: [...m.data.values()], complete: true }, now);
    expect(built.plan.entries.filter(e => e.kind === 'DOWNGRADE')).toHaveLength(2);
    expect(await apply(compactStore, built)).toMatchObject({ status: 'APPLIED', writes: 2, verified: 2, uncertain: [] });
    expect(m.data.get('gone1')).toMatchObject({ listable: false, publication_withdrawal: { reason: 'SOURCE_ABSENT' } });
  });
  it('partial read and row identity HOLD never infer absence', () => {
    const snapshot = { products: [product('missing')], complete: true };
    expect(planSourceCycle(config, evidence([], false), snapshot, now).plan.entries).toHaveLength(0);
    expect(planSourceCycle(config, { ...evidence([]), heldCount: 1 }, snapshot, now).plan.entries).toHaveLength(0);
    expect(planSourceCycle(config, evidence([record('x'), record('x')]), snapshot, now).plan.entries).toHaveLength(0);
  });
  it('SPEC3C incomplete transport blocks apply before backup or product writes', async () => {
    const m = memory([]);
    const built = planSourceCycle(config, evidence([record('new')], false), await m.commands.list(config.sourceId), now);
    expect(built.plan.blockers).toContain('SOURCE_INCOMPLETE');
    await expect(apply(m.commands, built)).rejects.toThrow('CYCLE_BLOCKED');
    expect(m.order).toEqual([]);
  });
  it('blocks over-ratio before even backups; exact cap is allowed', async () => {
    const m = memory([product('a'), product('b')]);
    const built = planSourceCycle(config, evidence([]), await m.commands.list(config.sourceId), now);
    expect(built.plan.blockers).toContain('DOWNGRADE_RATIO_EXCEEDED');
    await expect(apply(m.commands, built)).rejects.toThrow('CYCLE_BLOCKED'); expect(m.order).toEqual([]);
    expect(planSourceCycle(config, evidence([record('a')]), await m.commands.list(config.sourceId), now).plan.blockers).toEqual([]);
  });
  it.each(['locked_by_contract', 'status'] as const)('contract lock %s preserves every field including price', async kind => {
    const p = product('a'); if (kind === 'status') p.record.status.raw = '계약중'; else p.locked_by_contract = true;
    const r = record('a'); r.terms[0]!.monthlyRent = { state: 'KNOWN', value: 200 };
    expect(planSourceCycle(config, evidence([r]), { complete: true, products: [p] }, now).plan.entries).toEqual([]);
    expect(planSourceCycle(config, evidence([]), { complete: true, products: [p] }, now).plan.entries).toEqual([]);
  });
  it('reactivates solely from current source, retaining prior withdrawal audit', async () => {
    const p = product('a', false); p.record.status.saleAvailable = false;
    p.publication_withdrawal = { reason: 'SOURCE_ABSENT', source: config.sourceId, observedAt: time, deleteAuthorized: false };
    p.publication_withdrawal_prior = { listable: true, status: record('a').status };
    const m = memory([p]), built = planSourceCycle(config, evidence([record('a')]), await m.commands.list(config.sourceId), now);
    expect(built.plan.entries[0]!.kind).toBe('REEXPOSE'); await apply(m.commands, built);
    expect(m.data.get('a')!.publication_withdrawal).toBeNull();
    expect(m.data.get('a')!.publication_withdrawal_prior).toEqual(p.publication_withdrawal_prior);
  });
  it('readback compares deep maps without key-order sensitivity', async () => {
    const m = memory(), built = planSourceCycle(config, evidence([record('a')]), await m.commands.list(config.sourceId), now);
    // 저장 레코드의 raw 는 압축(digest)이므로 키 순서만 다른 중첩 맵은 타입 있는 칸(금액)으로 확인한다.
    m.commands.read = async (_id, uid) => { const p = structuredClone(m.data.get(uid)!);
      const rent = p.record.terms[0]!.monthlyRent; p.record.terms[0]!.monthlyRent = { value: rent.value, state: rent.state } as typeof rent; return p; };
    expect(deepEqual({ x: [{ b: 2, a: 1 }] }, { x: [{ a: 1, b: 2 }] })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect((await apply(m.commands, built)).verified).toBe(1);
  });
  it('readback outage after commit is uncertain and stops further writes', async () => {
    const m = memory(), built = planSourceCycle(config, evidence([record('a'), record('b')]), await m.commands.list(config.sourceId), now);
    m.commands.read = async () => { throw Error('READ_TIMEOUT'); };
    expect(await apply(m.commands, built)).toMatchObject({ status: 'APPLY_UNCERTAIN', writes: 1, verified: 0 });
    expect(m.data.size).toBe(1);
  });
  it('requires approval, rejects tampered plan and verifies backups before write', async () => {
    const m = memory(), built = planSourceCycle(config, evidence([record('a')]), await m.commands.list(config.sourceId), now);
    await expect(applySourceCycle(m.commands, built.plan, { apply: true, now })).rejects.toThrow('APPROVED_DIGEST');
    const forged = structuredClone(built); forged.plan.entries[0]!.after.record.uid = 'forged'; forged.digest = stableDigest(forged.plan);
    await expect(apply(m.commands, forged)).rejects.toThrow('REPLAN');
    m.commands.readBackup = async () => product('wrong');
    await expect(apply(m.commands, built)).rejects.toThrow('BACKUP_MISMATCH'); expect(m.data.size).toBe(0);
  });
  it('catalog/lock changes after plan reject replay; CAS fences changes after backup', async () => {
    const m = memory([product('a')]), r = record('a'); r.terms[0]!.monthlyRent = { state: 'KNOWN', value: 200 };
    const built = planSourceCycle(config, evidence([r]), await m.commands.list(config.sourceId), now);
    m.data.get('a')!.locked_by_contract = true;
    await expect(apply(m.commands, built)).rejects.toThrow('REPLAN');
    m.data.get('a')!.locked_by_contract = false;
    const backup = m.commands.backup;
    m.commands.backup = async (key, p) => { await backup(key, p); m.data.get('a')!.locked_by_contract = true; };
    expect((await apply(m.commands, built)).status).toBe('APPLY_UNCERTAIN');
    expect(m.data.get('a')!.record.terms[0]!.monthlyRent.value).toBe(100);
  });
  it('rejects stale evidence, incomplete catalog, invalid ratio and expired apply', async () => {
    expect(() => planSourceCycle({ ...config, maxDowngradeRatio: NaN }, evidence([]), { complete: true, products: [] }, now)).toThrow();
    expect(planSourceCycle(config, evidence([]), { complete: false, products: [] }, now).plan.blockers).toContain('CATALOG_INCOMPLETE');
    const m = memory(), built = planSourceCycle(config, evidence([record('a')]), await m.commands.list(config.sourceId), now);
    await expect(applySourceCycle(m.commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now: now + 3600000 })).rejects.toThrow('REPLAN');
  });
  it('observation clocks in RAW do not churn unchanged prices or conditions', () => {
    const p = product('a'), r = record('a');
    p.record.raw.synced_at = time; r.raw.synced_at = new Date(now + 1000).toISOString();
    expect(planSourceCycle(config, evidence([r]), { complete: true, products: [p] }, now).plan.entries).toHaveLength(0);
    r.terms[0]!.raw.contract_conditions = { version: 'changed' };
    expect(planSourceCycle(config, evidence([r]), { complete: true, products: [p] }, now).plan.entries).toHaveLength(1);
  });
  it('condition updates preserve unrelated existing envelope fields', () => {
    const p = { ...product('a'), humanNote: 'synthetic-preserve' }, r = record('a');
    r.terms[0]!.monthlyRent = { state: 'KNOWN', value: 200 };
    const built = planSourceCycle(config, evidence([r]), { complete: true, products: [p] }, now);
    expect(built.plan.entries[0]!.after).toHaveProperty('humanNote', 'synthetic-preserve');
  });
});

describe('source plugins', () => {
  it.each([['IANCAR', 'PREPARING', true], ['IANCAR', 'UNAVAILABLE', false], ['IANCAR', 'RESERVED', false],
    ['AICA', '배차문의', true], ['AICA', '수리중', true], ['IRON', '판매완료', false], ['F05', '출고불가', false], ['F05', '출고협의', true],
    ['SONOGONG', '출고가능', true], ['AUTOPLUS', '출고가능', true]] as const)('%s %s = %s', async (kind, status, expected) => {
    const p = plugin(async () => capture([record('a', status)], kind === 'AICA' ? [...AICA_SCOPES] : ['inventory']), kind);
    const read = await p.read(); expect(read.complete).toBe(true); expect(p.toRecords(read).records[0]!.status.saleAvailable).toBe(expected);
  });
  it('F05 excludes hidden tabs, hidden rows and filters; missing visibility is incomplete/unknown', async () => {
    const raw = capture([record('a'), record('b'), record('c')]);
    raw.rows[0]!.hiddenTab = true; raw.rows[1]!.hiddenByUser = true; raw.rows[2]!.hiddenByFilter = true;
    const p = plugin(async () => raw, 'F05');
    expect(p.toRecords(await p.read()).records.every(r => !r.status.saleAvailable)).toBe(true);
    raw.visibilityComplete = false;
    expect((await p.read()).complete).toBe(false);
    expect(p.toRecords(await p.read()).records.every(r => r.status.saleAvailable === null)).toBe(true);
  });
  it('requires all four AICA segments', async () => {
    const p = plugin(async () => capture([record('a')], [AICA_SCOPES[0]]), 'AICA');
    expect((await p.read()).complete).toBe(false);
  });
  it('F05 reuses actual phase-one UID/term conversion and visibility metadata', async () => {
    const channel = sharedSheetChannels[0]!, headers = [...sharedSheetHeaders, 'UID'];
    const values: Record<string, SheetCell> = { 회사명: channel.companyName, 차량번호: '신차', 차량상태: '출고가능',
      상품구분: '중고렌트', '12개월': 100, 단기보증: '무보증', 장기보증: '무보증', 연주행: '20000km', '차명 원문': '합성', UID: 'synthetic-new' };
    const captured: SharedSheetCapture = { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-only',
      layoutVersion: '2026-10-04-no-account', readTime: time, revision: 'synthetic',
      tabs: [...new Set(sharedSheetChannels.map(c => c.tab))].map(title => {
        const rows = [headers, ...(title === channel.tab ? [headers.map(h => values[h] ?? '')] : [])];
        return { title, readTime: time, complete: true, rowCount: rows.length, values: rows };
      }) };
    const p = sharedSheetCyclePlugin(channel.code, 0.5, async () => ({ capture: captured,
      visibility: { complete: true, tabs: captured.tabs.map(t => ({ title: t.title, hidden: false, coveredRows: t.rowCount, hiddenRows: [] })) } }), () => time);
    const read = await p.read(); expect(read.complete).toBe(true);
    const rows = p.toRecords(read).records; expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uid: 'synthetic-new', plate: null, terms: [{ deposit: { state: 'ZERO', value: 0 } }] });
  });
  it('ONE full-facts maps supplier UID, PREPARING, period rates and ZERO deposit', async () => {
    const c: IancarOneListCapture = { version: 'iancar-one-api/1', capturedAt: time, origin: 'synthetic', syncedAt: time,
      stale: false, total: 1, pages: 1, sourceDigest: 'synthetic', issues: [], readyForRawIngest: true, factScope: 'FULL_FACTS',
      records: [{ vehicleId: 'synthetic-one', fingerprint: 'synthetic', payload: { inventory_status: 'PREPARING', plate_number: 'synthetic',
        detail: { data: { name: '합성' } }, rates: { data: [{ rental_period: 12, monthly_rate: 100, deposit: 0,
          currency: 'KRW', vat_included: true, contracted_mileage: 20000, mileage_period: 'year' }] } } }] };
    const p = iancarCyclePlugin(0.5, async () => c, () => time);
    const read = await p.read(); expect(read.complete).toBe(true);
    expect(p.toRecords(read).records[0]).toMatchObject({ uid: 'synthetic-one', status: { saleAvailable: true },
      terms: [{ months: 12, deposit: { state: 'ZERO', value: 0 }, mileage: '20000km/year' }] });
    c.factScope = 'PHASE_ONE_FACTS'; expect((await p.read()).complete).toBe(false);
  });
  it('ONE rates with three contracted-mileage options per month stay valid and sellable (이안카 검증 보류 96/96 사고)', async () => {
    const options: Array<[number, number]> = [[40000, 648000], [20000, 555000], [30000, 602000]];
    const rates = [12, 24].flatMap(months => options.map(([km, rent]) => ({
      rental_period: months, monthly_rate: rent, deposit: 0, currency: 'KRW', vat_included: true, contracted_mileage: km, mileage_period: 'year' })));
    const c: IancarOneListCapture = { version: 'iancar-one-api/1', capturedAt: time, origin: 'synthetic', syncedAt: time,
      stale: false, total: 1, pages: 1, sourceDigest: 'synthetic', issues: [], readyForRawIngest: true, factScope: 'FULL_FACTS',
      records: [{ vehicleId: 'synthetic-one', fingerprint: 'synthetic', payload: { inventory_status: 'AVAILABLE', plate_number: 'synthetic',
        detail: { data: { name: '합성' } }, rates: { data: rates } } }] };
    const p = iancarCyclePlugin(0.5, async () => c, () => time);
    const record = p.toRecords(await p.read()).records[0]!;
    expect(record.terms).toHaveLength(6);                                  // 원천 기록에는 옵션 전부 남는다
    expect(validateSourceRecord(record)).toEqual([]);
    expect(sourceSaleAvailable(record, 'IANCAR', now)).toBe(true);
    const price = nativeCycleFields({ record, listable: true, locked_by_contract: false, publication_withdrawal: null,
      publication_withdrawal_prior: null }).price as Record<string, unknown>;
    // 개월 키에는 대표 항, 같은 개월의 약정거리 옵션은 소비처가 읽는 «{개월}_연{N}km» 키로 원천 값 그대로
    expect(price).toEqual({
      '12': { rent: 555000, deposit: 0, mileage: '20000km/year' }, '24': { rent: 555000, deposit: 0, mileage: '20000km/year' },
      '12_연20000km': { rent: 555000, deposit: 0 }, '12_연30000km': { rent: 602000, deposit: 0 }, '12_연40000km': { rent: 648000, deposit: 0 },
      '24_연20000km': { rent: 555000, deposit: 0 }, '24_연30000km': { rent: 602000, deposit: 0 }, '24_연40000km': { rent: 648000, deposit: 0 },
    });
  });
  it('monthly-unit options use the 월 key, and single-term suppliers never get option keys', () => {
    const t = (months: number, mileage: string | null, rent: number): SourceProductRecord['terms'][number] => ({ months, mileage, raw: {},
      monthlyRent: { state: 'KNOWN', value: rent }, deposit: { state: 'ZERO', value: 0 } });
    expect(Object.keys(salePriceMap([t(1, '2000km/month', 900), t(1, '3000km/month', 950), t(1, '4000km/month', 1000)])).sort())
      .toEqual(['1', '1_월2000km', '1_월3000km', '1_월4000km']);
    expect(Object.keys(salePriceMap([t(12, '20000km', 100), t(24, '20000km', 90)]))).toEqual(['12', '24']);
  });
  it.each(['429', '403', 'partial'])('read error %s is never complete', async reason => {
    const p = plugin(async () => { throw Error(reason); }); expect((await p.read()).complete).toBe(false);
  });
  it('rejects malformed capture HOLD counts before conversion loops', async () => {
    const raw = capture([]); raw.heldCount = Infinity;
    expect((await plugin(async () => raw).read()).error).toBe('SCHEMA_INVALID');
  });
});

describe('runner safety and heartbeat', () => {
  it('persists three failures, alerts and stops before a fourth source read', async () => {
    const { ctrl, alerts } = control(), m = memory(), read = vi.fn(async () => { throw Error('429'); }), p = plugin(read);
    for (let i = 0; i < 3; i++) await runSourceCycle(p, m.commands, ctrl, { now: () => now });
    expect((await runSourceCycle(p, m.commands, ctrl)).status).toBe('STOPPED');
    expect(read).toHaveBeenCalledTimes(3); expect(alerts).toHaveLength(3); expect(alerts[2]).toContain('STOPPED');
    expect((await ctrl.load(config.sourceId)).lastCompleteAt).toBeNull(); expect(m.order).toEqual([]);
  });
  it('ratio guard alerts before writes and success resets the failure streak', async () => {
    const { ctrl, alerts } = control(), m = memory([product('a')]);
    await runSourceCycle(plugin(async () => capture([])), m.commands, ctrl, { now: () => now });
    expect(alerts).toContain('DOWNGRADE_RATIO_EXCEEDED'); expect(m.order).toEqual([]);
    const result = await runSourceCycle(plugin(async () => capture([record('a')])), m.commands, ctrl, { now: () => now });
    expect(result.status).toBe('DRY_RUN'); expect((await ctrl.load(config.sourceId)).failures).toBe(0);
    expect(ctrl.heartbeat).toHaveBeenCalledTimes(2);
  });
  it('overlap is skipped and a failure releases the lock', async () => {
    const { ctrl } = control(), m = memory(), release = await ctrl.acquire(config.sourceId), p = plugin(async () => capture([]));
    expect((await runSourceCycle(p, m.commands, ctrl)).status).toBe('LOCKED'); await release!();
    expect((await runSourceCycle(p, m.commands, ctrl, { now: () => now })).status).toBe('DRY_RUN');
  });
  it('heartbeat outage cannot suppress the durable three-failure stop alert', async () => {
    const { ctrl, alerts } = control(), m = memory(), p = plugin(async () => capture([]));
    ctrl.heartbeat = async () => { throw Error('HEARTBEAT_DOWN'); };
    for (let i = 0; i < 3; i++) await runSourceCycle(p, m.commands, ctrl, { now: () => now });
    expect((await ctrl.load(config.sourceId)).stopped).toBe(true);
    expect(alerts).toContain('STOPPED:HEARTBEAT_DOWN');
  });
  it('synced_at skip uses only successful applied state; dry-run never consumes the token', async () => {
    const { ctrl } = control(), m = memory(), read = vi.fn(async () => ({ ...capture([record('a', 'AVAILABLE')]), synced_at: time }));
    const p = sourceCyclePlugin({ sourceId: config.sourceId, kind: 'IANCAR', scopes: ['inventory'], maxDowngradeRatio: 0.5 }, read, () => time, async () => time);
    expect((await runSourceCycle(p, m.commands, ctrl, { onlyWhenSynced: true, now: () => now })).status).toBe('DRY_RUN');
    expect((await ctrl.load(config.sourceId)).lastSyncedAt).toBeNull();
    const state = await ctrl.load(config.sourceId); state.lastSyncedAt = time; await ctrl.save(config.sourceId, state);
    expect((await runSourceCycle(p, m.commands, ctrl, { onlyWhenSynced: true, now: () => now })).status).toBe('UNCHANGED_SYNC');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('only-when-synced skips a sync older than 10 minutes (the detail read cannot finish inside the 15-minute freshness window) without reading', async () => {
    const { ctrl } = control(), m = memory(), read = vi.fn(async () => ({ ...capture([record('a', 'AVAILABLE')]), synced_at: time }));
    const old = new Date(Date.parse(time) - 11 * 60_000).toISOString();
    const p = sourceCyclePlugin({ sourceId: config.sourceId, kind: 'IANCAR', scopes: ['inventory'], maxDowngradeRatio: 0.5 }, read, () => time, async () => old);
    const r = await runSourceCycle(p, m.commands, ctrl, { onlyWhenSynced: true, now: () => Date.parse(time) });
    expect(r.status).toBe('UNCHANGED_SYNC'); expect(r.summary).toContain('10분 초과');
    expect(read).not.toHaveBeenCalled();
    expect((await ctrl.load(config.sourceId))).toMatchObject({ failures: 0, stopped: false, lastSyncedAt: null });   // 토큰을 소비하지 않는다
  });
  it('CLI cannot enable scheduled writes', async () => {
    await expect(sourceCycleCli(['--runtime', 'unused', '--apply'])).rejects.toThrow('SCHEDULED_APPLY_NOT_AUTHORIZED');
  });
  it('runner applies a pinned reviewed plan, then returns zero changes on second cycle', async () => {
    const { ctrl } = control(), m = memory(), p = plugin(async () => capture([record('a')]));
    const dry = await runSourceCycle(p, m.commands, ctrl, { now: () => now });
    if (!('plan' in dry) || !dry.plan || !('planDigest' in dry)) throw Error('NO_PLAN');
    const applied = await runSourceCycle(p, m.commands, ctrl, { apply: true, approvedPlan: dry.plan,
      digest: dry.planDigest, approval: dry.planDigest, now: () => now + 1 });
    expect(applied.status).toBe('APPLIED'); expect(applied.writes).toBe(1);
    const again = await runSourceCycle(p, m.commands, ctrl, { now: () => now + 2 });
    expect('plan' in again && again.plan?.entries).toEqual([]);
  });
  it('heartbeat reuses ingestion lifecycle under partial, ineligible scope', async () => {
    const calls: Record<string, unknown[]> = {};
    const store = Object.fromEntries(['upsertSource', 'beginRun', 'appendRaw', 'completeRun', 'failRun'].map(key => [key,
      async (arg: unknown) => { (calls[key] ??= []).push(arg); }])) as unknown as SourceIngestionStore;
    const heartbeat = sourceRunCycleHeartbeat(store), state = { ...emptyCycleState(), lastAttemptAt: time, lastCompleteAt: time };
    await heartbeat(config.sourceId, state, null);
    expect(calls.completeRun![0]).toMatchObject({ coverage: { mode: 'PARTIAL', completeness: 'INCOMPLETE' }, rawCount: 1 });
    await heartbeat(config.sourceId, { ...state, error: 'READ_FAILED' }, null);
    expect(calls.failRun).toHaveLength(1);
  });
});

const temp: string[] = [];
afterEach(async () => { for (const p of temp.splice(0)) await rm(p, { recursive: true, force: true }); });
describe('local control persistence', () => {
  it('exclusive lock, durable restart stop, JSON alert and owner release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-cycle-test-')); temp.push(dir);
    const c = fileCycleControl(dir, async () => {}), release = await c.acquire(config.sourceId);
    const other = fileCycleControl(dir, async () => {});
    expect(await other.acquire(config.sourceId)).toBeNull();
    await c.save(config.sourceId, { ...emptyCycleState(), failures: 3, stopped: true });
    expect((await other.load(config.sourceId)).stopped).toBe(true);
    await c.alert(config.sourceId, 'STOPPED');
    expect(JSON.parse((await readFile(join(dir, 'alerts.jsonl'), 'utf8')).trim()).reason).toBe('STOPPED');
    await release!(); const release2 = await other.acquire(config.sourceId); expect(release2).not.toBeNull(); await release2!();
    expect((await readdir(dir)).filter(f => f.endsWith('.lock'))).toEqual([]);
  });
  it('offline snapshot CLI performs zero product writes and persists redacted heartbeat', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-cycle-cli-')); temp.push(dir);
    const input = join(dir, 'capture.json'), raw = capture([record('a')]);
    raw.observedAt = new Date().toISOString(); raw.rows[0]!.record.observedAt = raw.observedAt;
    await writeFile(input, JSON.stringify({ sources: [{ definition: { sourceId: config.sourceId, kind: 'IRON', scopes: ['inventory'], maxDowngradeRatio: 0.5 }, capture: raw }],
      products: [], catalogComplete: true }), 'utf8');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await sourceCycleCli(['--snapshot', input, '--state-dir', dir])).toBe(0);
      expect(output.mock.calls[0]![0]).toContain('DRY_RUN');
      expect(await readFile(join(dir, 'offline-heartbeats.jsonl'), 'utf8')).not.toContain('price');
      expect(JSON.parse(await readFile(input, 'utf8')).products).toEqual([]);
    } finally { output.mockRestore(); }
  });
});

describe('Codex 상의 2026-10-13: 보증금 UNKNOWN 보존과 하향 사유별 가드', () => {
  type Deposit = SourceProductRecord['terms'][number]['deposit'];
  const withDeposit = (uid: string, deposit: Deposit, rent = 100): SourceProductRecord => {
    const r = record(uid); r.terms[0]!.deposit = deposit; r.terms[0]!.monthlyRent = { state: 'KNOWN', value: rent }; return r;
  };
  const known = (value: number): Deposit => ({ state: 'KNOWN', value });
  const unknown: Deposit = { state: 'UNKNOWN', value: null };
  const stored = (uid: string, deposit: Deposit): CycleProduct => ({ ...product(uid), record: withDeposit(uid, deposit) });
  it('source UNKNOWN deposit keeps the stored KNOWN/ZERO deposit while rent still follows the source', async () => {
    const m = memory([stored('a', known(500)), stored('z', { state: 'ZERO', value: 0 })]);
    const built = planSourceCycle(config, evidence([withDeposit('a', unknown, 120), withDeposit('z', unknown, 100)]),
      await m.commands.list(config.sourceId), now);
    expect(built.plan.warnings).toContain('DEPOSIT_PRESERVED:2');
    expect(built.plan.entries).toHaveLength(1);
    const after = built.plan.entries[0]!.after.record.terms[0]!;
    expect(after.deposit).toEqual(known(500)); expect(after.monthlyRent).toEqual({ state: 'KNOWN', value: 120 });
  });
  it('explicit source ZERO deposit still overwrites, and enrollment is unaffected', async () => {
    const m = memory([stored('a', known(500))]);
    const built = planSourceCycle(config, evidence([withDeposit('a', { state: 'ZERO', value: 0 }), withDeposit('n', unknown)]),
      await m.commands.list(config.sourceId), now);
    expect(built.plan.warnings.some(w => w.startsWith('DEPOSIT_PRESERVED'))).toBe(false);
    const byUid = Object.fromEntries(built.plan.entries.map(e => [e.after.record.uid, e]));
    expect(byUid.a!.after.record.terms[0]!.deposit).toEqual({ state: 'ZERO', value: 0 });
    expect(byUid.n!.kind).toBe('ENROLL'); expect(byUid.n!.after.record.terms[0]!.deposit).toEqual(unknown);
  });
  it('a document with a different id but the same plate is updated in place, never enrolled twice nor withdrawn as absent', () => {
    const legacy = { ...product('iancar_legacy-1'), record: { ...record('iancar_legacy-1'), plate: '12가3456' } };
    const other = { ...product('iancar_legacy-2'), record: { ...record('iancar_legacy-2'), plate: '34나7890' } };
    const fresh = (uid: string, plate: string, rent: number): SourceProductRecord => {
      const r = { ...record(uid), plate }; r.terms[0]!.monthlyRent = { state: 'KNOWN', value: rent }; return r;
    };
    const built = planSourceCycle(config, evidence([fresh('12가3456', '12가3456', 150), fresh('34나7890', '34나7890', 100)]),
      { complete: true, products: [legacy, other] }, now);
    expect(built.plan.entries.map(e => [e.kind, e.after.record.uid])).toEqual([['UPDATE', 'iancar_legacy-1']]);   // 34나7890 은 값 동일 → 변경 0
    expect(built.plan.warnings).toContain('UID_BRIDGED:2');
    expect(built.plan.entries.some(e => e.kind === 'ENROLL' || e.kind === 'DOWNGRADE')).toBe(false);
  });
  it('plate bridging needs exactly one candidate, an assigned plate and no direct id match', () => {
    const mk = (uid: string, plate: string | null): CycleProduct => ({ ...product(uid), record: { ...record(uid), plate } });
    const src = (uid: string, plate: string | null): SourceProductRecord => ({ ...record(uid), plate });
    // 같은 차량번호 문서가 둘이면 어느 쪽인지 알 수 없으므로 잇지 않는다(새로 편입, 기존 둘은 부재로 내려감)
    const ambiguous = planSourceCycle(config, evidence([src('12가3456', '12가3456')]),
      { complete: true, products: [mk('a', '12가3456'), mk('b', '12가3456')] }, now);
    expect(ambiguous.plan.warnings.some(w => w.startsWith('UID_BRIDGED'))).toBe(false);
    expect(ambiguous.plan.entries.filter(e => e.kind === 'ENROLL')).toHaveLength(1);
    // 차량번호 자리표시(신차 등)는 차량을 식별하지 못한다
    const placeholder = planSourceCycle(config, evidence([src('N-1', '신차')]), { complete: true, products: [mk('a', '신차')] }, now);
    expect(placeholder.plan.warnings.some(w => w.startsWith('UID_BRIDGED'))).toBe(false);
    // 다른 원천 행이 이미 문서 ID 로 직접 대응하면 그 문서를 가로채지 않는다
    const direct = planSourceCycle(config, evidence([src('a', '12가3456'), src('12가3456', '12가3456')]),
      { complete: true, products: [mk('a', '12가3456')] }, now);
    expect(direct.plan.warnings.some(w => w.startsWith('UID_BRIDGED'))).toBe(false);
  });
  it('a price-drifted document blocks the run only when the cycle would write over it', () => {
    const p = [stored('a', known(500)), stored('b', known(700))];
    // b 는 이번 회차 원천에 대응 행이 없다(원천 행 없음) → 쓰지 않으므로 회차를 막지 않고, 부재 하향도 하지 않는다
    const untouched = planSourceCycle(config, evidence([p[0]!.record]), { complete: true, products: p, driftHeld: ['b'] }, now);
    expect(untouched.plan.blockers).toEqual([]);
    expect(untouched.plan.entries).toEqual([]);
    expect(untouched.plan.warnings.some(w => w.startsWith('DRIFT_HELD:1'))).toBe(true);
    // 원천 행이 있어 쓰게 되면 막는다(보정 허용이 있어야 통과)
    const clobber = planSourceCycle(config, evidence([p[0]!.record, withDeposit('b', known(900))]),
      { complete: true, products: p, driftHeld: ['b'] }, now);
    expect(clobber.plan.blockers).toContain('CATALOG_SOURCE_RECORD_DRIFT');
  });
  it('an accepted-drift document with unchanged facts is rewritten once so its price digest resyncs', async () => {
    const same = [stored('a', known(500)), stored('b', known(700))];
    const driftBefore = planSourceCycle(config, evidence(same.map(p => p.record)),
      { complete: true, products: same, acceptedDrift: ['a'] }, now);
    expect(driftBefore.plan.entries.map(e => [e.after.record.uid, e.kind])).toEqual([['a', 'UPDATE']]);
    const next = planSourceCycle(config, evidence(same.map(p => p.record)), { complete: true, products: same }, now);
    expect(next.plan.entries).toEqual([]);                                     // 다음 회차(드리프트 없음)는 쓰지 않는다 — 멱등
  });
  it('floor 0 keeps the combined ratio; floor 3 lets a small supplier change status without blocking the run', async () => {
    const products = ['a', 'b', 'c', 'd', 'e', 'f'].map(u => product(u));
    const notSellable = ['a', 'b', 'c'].map(u => ({ ...record(u, '계약중'), status: { raw: '계약중', saleAvailable: false } }));
    const rest = ['d', 'e', 'f'].map(u => record(u));
    const snapshot = { complete: true, products };
    const legacy = planSourceCycle({ ...config, maxDowngradeRatio: 0.2 }, evidence([...notSellable, ...rest]), snapshot, now);
    expect(legacy.plan.blockers).toContain('DOWNGRADE_RATIO_EXCEEDED');
    const floored = planSourceCycle({ ...config, maxDowngradeRatio: 0.2, downgradeFloor: 3 }, evidence([...notSellable, ...rest]), snapshot, now);
    expect(floored.plan.blockers).toEqual([]);
    expect(floored.plan.entries.filter(e => e.kind === 'DOWNGRADE')).toHaveLength(3);
  });
  it('floor still blocks mass absence inference and mass explicit status flips above the floor', () => {
    const products = Array.from({ length: 20 }, (_, i) => product('p' + i));
    const floored = { ...config, maxDowngradeRatio: 0.2, downgradeFloor: 3 };
    const absent = planSourceCycle(floored, evidence(products.slice(0, 10).map(p => p.record)), { complete: true, products }, now);
    expect(absent.plan.blockers).toContain('DOWNGRADE_RATIO_EXCEEDED');
    const flipped = products.map((p, i) => i < 12 ? { ...p.record, status: { raw: '출고불가', saleAvailable: false } } : p.record);
    expect(planSourceCycle(floored, evidence(flipped), { complete: true, products }, now).plan.blockers).toContain('DOWNGRADE_RATIO_EXCEEDED');
    const fewAbsent = planSourceCycle(floored, evidence(products.slice(0, 17).map(p => p.record)), { complete: true, products }, now);
    expect(fewAbsent.plan.blockers).toEqual([]);
  });
});

describe('읽기 실패는 안전한 세부 코드를 남긴다 (이안카 READ_FAILED 원인 불명 사고)', () => {
  const failWith = async (error: Error) => {
    const { ctrl, alerts } = control(), m = memory([]);
    const result = await runSourceCycle(plugin(async () => { throw error; }), m.commands, ctrl, { now: () => now });
    return { result, alerts };
  };
  it.each([
    ['HTTP 상태', Object.assign(new Error('응답 본문 비밀 토큰'), { status: 503 }), 'READ_FAILED_HTTP_503'],
    ['시간 제한', Object.assign(new Error('aborted'), { name: 'TimeoutError' }), 'READ_FAILED_TIMEOUT'],
    ['내부 오류 코드', new Error('IANCAR_ONE_PLATE_MISMATCH'), 'READ_FAILED_IANCAR_ONE_PLATE_MISMATCH'],
    ['분류 불가 문장', new Error('something odd happened'), 'READ_FAILED'],
  ])('%s', async (_name, error, expected) => {
    const { result, alerts } = await failWith(error);
    expect(result.status).toBe('HOLD'); expect(alerts).toEqual([expected]);
    expect(JSON.stringify([result, alerts])).not.toMatch(/비밀|odd happened|aborted/);       // 원문 메시지는 어디에도 남지 않는다
  });
  it('429 and 401/403 keep their existing classification', async () => {
    expect((await failWith(Object.assign(new Error('x'), { status: 429 }))).alerts).toEqual(['RATE_LIMITED']);
    expect((await failWith(new Error('HTTP_403'))).alerts).toEqual(['AUTH_FAILED']);
  });
});

describe('죽은 프로세스의 잠금 인계 (강제 종료로 RP030 이 «중복 회차 생략» 으로만 지나간 사고)', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
  const lockFor = async (owner: unknown, ageMs: number) => {
    const dir = await mkdtemp(join(tmpdir(), 'lock-')); dirs.push(dir);
    const path = join(dir, `${stableDigest('SRC')}.lock`);
    await writeFile(path, typeof owner === 'string' ? owner : JSON.stringify(owner));
    const when = new Date(Date.now() - ageMs); await utimes(path, when, when);
    return { dir, path, ctrl: fileCycleControl(dir, async () => {}) };
  };
  const deadPid = () => { const r = spawnSync(process.execPath, ['-e', '']); return r.pid!; };   // 방금 끝난 프로세스의 pid
  it('takes over an old lock whose owner process is gone, keeping the evidence file', async () => {
    const pid = deadPid(), { dir, path, ctrl } = await lockFor({ token: 'dead', pid }, STALE_LOCK_MS + 60_000);
    const release = await ctrl.acquire('SRC');
    expect(release).not.toBeNull();
    expect((await readdir(dir)).some(n => n.includes(`.lock.dead-pid-${pid}-`))).toBe(true);
    await release!(); expect((await readdir(dir)).includes(path.split(/[\\/]/).at(-1)!)).toBe(false);
  });
  it('never takes over a recent lock, a live owner, or an unreadable lock', async () => {
    expect(await (await lockFor({ token: 'x', pid: deadPid() }, 60_000)).ctrl.acquire('SRC')).toBeNull();                       // 최근
    expect(await (await lockFor({ token: 'x', pid: process.pid }, STALE_LOCK_MS * 3)).ctrl.acquire('SRC')).toBeNull();          // 살아 있음
    expect(await (await lockFor('not json', STALE_LOCK_MS * 3)).ctrl.acquire('SRC')).toBeNull();                               // 판단 불가
    expect(await (await lockFor({ token: 'x' }, STALE_LOCK_MS * 3)).ctrl.acquire('SRC')).toBeNull();                           // pid 없음
  });
});
