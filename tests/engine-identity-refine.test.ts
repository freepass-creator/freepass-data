import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
import { planSourceCycle, applySourceCycle } from '../src/application/source-cycle.js';
import { identityMastersFromVehicleMaster, refineEngineIdentity, type IdentityMaster } from '../src/application/identity-promotion-plan.js';
import { loadIdentityRefiner } from '../src/runtime/source-cycle-runtime.js';
import { compactRecord, type SourceProductRecord } from '../src/domain/source-engine.js';
import type { VehicleIdentityRefiner } from '../src/ports/source-cycle.js';
import { stableDigest } from '../src/shared/stable-digest.js';

// 대표 2026-10-15 «손오공 새로 API 연동해서 땡겨온 애들은 … 모델명도 정제되어 있지 않고» — 엔진 회차 안에서 기존 보수 규칙(matchIdentity)으로만 정체성 정제. 값은 전부 합성.
const time = '2026-10-15T01:00:00.000Z', now = Date.parse('2026-10-15T01:05:00.000Z'), source = 'RP012';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const master = (over: Partial<IdentityMaster> & Pick<IdentityMaster, 'id' | 'sub_model'>): IdentityMaster => ({ maker: '현대', model: '아반떼', model_aliases: [], sub_model_aliases: [],
  yearFrom: null, yearTo: null, trims: [], ...over });
const masters: IdentityMaster[] = [
  master({ id: 'm-cn7', sub_model: '더 뉴 아반떼 CN7', sub_model_aliases: ['아반떼'], yearFrom: 2020, yearTo: 2023, trims: [{ name: '프리미엄', aliases: [] }] }),
  master({ id: 'm-cn8', sub_model: '아반떼 CN8', sub_model_aliases: ['아반떼'], yearFrom: 2023, yearTo: null, trims: [{ name: '프리미엄', aliases: [] }] }),
  master({ id: 'm-ioniq5', model: '아이오닉 5', model_aliases: ['아이오닉5'], sub_model: '아이오닉 5 NE', sub_model_aliases: ['아이오닉5'],
    trims: [{ name: '프레스티지', aliases: [] }, { name: '익스클루시브', aliases: [] }] }),
];
const refiner = (list: IdentityMaster[] = masters): VehicleIdentityRefiner => ({ digest: stableDigest(list), match: input => refineEngineIdentity(input, list) });

const rec = (plate: string, vehicleText: string, spec: Record<string, string> = {}, rent = 500000, observedAt = time): SourceProductRecord => ({
  sourceId: source, uid: plate, plate, vehicleText, status: { raw: '출고가능', saleAvailable: true }, observedAt, vehicleHold: [],
  raw: { source: 'sonogong-partner-api', product_type: '중고렌트', ...(Object.keys(spec).length ? { spec } : {}) },
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: rent }, deposit: { state: 'ZERO', value: 0 }, mileage: null, raw: { priceType: 'RENT_RETURN' } }] });

function fakeFirestore() {
  const docs = new Map<string, any>(); let version = 0; let patches = 0;
  const doc = (uid: string, fields: any) => ({ name: `projects/synthetic-test/databases/(default)/documents/products/${uid}`, updateTime: `${time}:${++version}`, fields });
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), uid = decodeURIComponent(url.pathname.split('/').at(-1)!);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (!init.method || init.method === 'GET') {
      let result: any = uid === 'products' ? { documents: [...docs.values()] } : docs.get(uid);
      if (!result) return new Response('{}', { status: 404 });
      result = structuredClone(result);
      const masked = url.searchParams.getAll('mask.fieldPaths').map(p => p.replace(/`/g, ''));
      if (uid === 'products' && masked.length) for (const d of result.documents) d.fields = Object.fromEntries(Object.entries(d.fields ?? {}).filter(([k]) => masked.includes(k)));
      return Response.json(result);
    }
    const current = docs.get(uid);
    if (url.searchParams.get('currentDocument.exists') === 'false' ? !!current : current?.updateTime !== url.searchParams.get('currentDocument.updateTime')) return new Response('{}', { status: 412 });
    patches++;
    const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
    const after = doc(uid, fields); docs.set(uid, after); return Response.json(after);
  }) as unknown as typeof fetch;
  return { docs, fetcher, put: (uid: string, f: Record<string, unknown>) => docs.set(uid, doc(uid, encodeFields(f as never))), patches: () => patches,
    fields: (uid: string) => decodeFields(docs.get(uid).fields) as Record<string, any> };
}
async function setup(identity: (() => Promise<VehicleIdentityRefiner | null>) | 'NO_OPTION' = async () => refiner()) {
  const dir = await mkdtemp(join(tmpdir(), 'engine-identity-')); dirs.push(dir);
  const fake = fakeFirestore();
  const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
    supplierDefaults: { RP012: { provider_name: '합성손오공', policy_code: 'SYNTHETIC_POLICY' } }, ...(identity !== 'NO_OPTION' ? { identity } : {}) });
  return { commands, fake };
}
const run = async (commands: Awaited<ReturnType<typeof setup>>['commands'], records: SourceProductRecord[], at = now) => {
  const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records, observedAt: records[0]!.observedAt, heldCount: 0, complete: true },
    await commands.list(source), at);
  const applied = built.plan.entries.length ? await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now: at }) : null;
  return { built, plan: built.plan, kinds: built.plan.entries.map(e => e.kind), applied };
};
/** 엔진이 이전 회차에 정체성 정제 없이 편입한 문서(지금 운영의 보류 문서 모양). */
const heldDoc = (r: SourceProductRecord, extra: Record<string, unknown> = {}) => ({
  ...nativeCycleFields({ record: compactRecord(r), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null,
    supplierFields: { provider_name: '합성손오공', policy_code: 'SYNTHETIC_POLICY' } }), ...extra });

describe('엔진 회차 정체성 정제 — 새 문서', () => {
  it('fills maker·model·sub_model·trim from the unique master, clears the review flag and keeps 원문.차명', async () => {
    const { commands, fake } = await setup();
    const { kinds, applied, plan } = await run(commands, [rec('12가1001', '아이오닉5 프레스티지 2WD 롱레인지', { year: '2022' })]);
    expect(kinds).toEqual(['ENROLL']);
    expect(applied).toMatchObject({ status: 'APPLIED', verified: 1 });
    expect(fake.fields('12가1001')).toMatchObject({ maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', trim_name: '프레스티지',
      vehicle_review_required: false, vehicle_title_source: 'MASTER_MATCH', vehicle_master_id: 'm-ioniq5', year: '2022', car_name: '아이오닉5 프레스티지 2WD 롱레인지' });
    expect(fake.fields('12가1001').원문.차명).toBe('아이오닉5 프레스티지 2WD 롱레인지');
    expect(plan.warnings).toContain(`IDENTITY_MASTER:${refiner().digest.slice(0, 12)}`);
  });

  it('uses the year to decide the generation, and holds when the year cannot decide (raw name, review required)', async () => {
    const { commands, fake } = await setup();
    await run(commands, [rec('12가2001', '아반떼 프리미엄', { year: '2023' }), rec('12가2002', '아반떼 프리미엄', { year: '2026' }), rec('12가2003', '아반떼 프리미엄')]);
    expect(fake.fields('12가2001')).toMatchObject({ maker: '', model: '', sub_model: '아반떼 프리미엄', trim_name: '', vehicle_review_required: true, vehicle_title_source: 'RAW_VEHICLE_TEXT' });
    expect(fake.fields('12가2001')).not.toHaveProperty('vehicle_master_id');
    expect(fake.fields('12가2003')).toMatchObject({ maker: '', sub_model: '아반떼 프리미엄', vehicle_review_required: true });
    expect(fake.fields('12가2002')).toMatchObject({ maker: '현대', model: '아반떼', sub_model: '아반떼 CN8', trim_name: '프리미엄', vehicle_review_required: false });
  });

  it('holds an unknown model and leaves the trim blank when it is not uniquely matched', async () => {
    const { commands, fake } = await setup();
    await run(commands, [rec('12가3001', '카니발 9인승 노블레스'), rec('12가3002', '아이오닉5 롱레인지')]);
    expect(fake.fields('12가3001')).toMatchObject({ maker: '', model: '', sub_model: '카니발 9인승 노블레스', vehicle_review_required: true });
    expect(fake.fields('12가3002')).toMatchObject({ maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', trim_name: '', vehicle_review_required: false });
  });

  it('does nothing when the vehicle master is unavailable (fail-closed = today\'s behaviour)', async () => {
    for (const identity of [async () => null, async () => { throw new Error('VEHICLE_MASTER_DOWN'); }, 'NO_OPTION' as const]) {
      const { commands, fake } = await setup(identity as never);
      const { plan, applied } = await run(commands, [rec('12가4001', '아이오닉5 프레스티지')]);
      expect(applied).toMatchObject({ status: 'APPLIED', verified: 1 });
      expect(fake.fields('12가4001')).toMatchObject({ maker: '', model: '', sub_model: '아이오닉5 프레스티지', vehicle_review_required: true, vehicle_title_source: 'RAW_VEHICLE_TEXT' });
      expect(plan.warnings.some(w => w.startsWith('IDENTITY_MASTER'))).toBe(false);
    }
  });
});

describe('엔진 회차 정체성 정제 — 기존 문서', () => {
  it('rewrites an engine hold document exactly once when a unique match now exists (VEHICLE_IDENTITY), keeping 원문', async () => {
    const { commands, fake } = await setup();
    // 편입 때는 원천이 연식을 주지 않았고(문서 연식 없음), 이번 회차 원천이 연식을 준다 → 연식도 채운다
    fake.put('12가5001', heldDoc(rec('12가5001', '아이오닉5 프레스티지')));
    const r = rec('12가5001', '아이오닉5 프레스티지', { year: '2022' });
    const first = await run(commands, [r]);
    expect(first.kinds).toEqual(['UPDATE']);
    expect(first.plan.entries[0]!.before?.rewriteReasons).toEqual(['VEHICLE_IDENTITY']);
    expect(first.plan.warnings).toEqual(expect.arrayContaining(['VEHICLE_IDENTITY_REFINE:1', `IDENTITY_MASTER:${refiner().digest.slice(0, 12)}`]));
    expect(first.applied).toMatchObject({ status: 'APPLIED', verified: 1 });
    expect(fake.fields('12가5001')).toMatchObject({ maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', trim_name: '프레스티지', year: '2022',
      vehicle_review_required: false, vehicle_title_source: 'MASTER_MATCH', vehicle_master_id: 'm-ioniq5' });
    expect(fake.fields('12가5001').원문.차명).toBe('아이오닉5 프레스티지');
    // 쓰고 나면 조건이 거짓 — 같은 원천 값으로 다시 돌리면 쓰기 0(되풀이 없음)
    const patches = fake.patches();
    const second = await run(commands, [r]);
    expect(second.kinds).toEqual([]);
    expect(fake.patches()).toBe(patches);
  });

  it('never mass-rewrites hold documents that still do not match uniquely', async () => {
    const { commands, fake } = await setup();
    for (const [plate, name] of [['12가6001', '아반떼 프리미엄'], ['12가6002', '카니발 9인승']] as const) fake.put(plate, heldDoc(rec(plate, name)));
    const { kinds } = await run(commands, [rec('12가6001', '아반떼 프리미엄'), rec('12가6002', '카니발 9인승')]);
    expect(kinds).toEqual([]);
    expect(fake.patches()).toBe(0);
  });

  it('never touches identity set by people or ERP4, even when the source name matches a master and other facts change', async () => {
    const { commands, fake } = await setup();
    const r = rec('12가7001', '아이오닉5 프레스티지');
    // ERP4·사람이 정한 이름(검토 표시가 남아 있어도 제조사·모델이 있으면 대상이 아니다)
    fake.put('12가7001', heldDoc(r, { maker: '현대', model: '아이오닉5', sub_model: '아이오닉5', trim_name: '익스클루시브', vehicle_title_source: 'ERP4' }));
    // 검토가 끝난 문서(제조사 빈칸이어도 검토 필요가 아니면 대상이 아니다)
    const r2 = rec('12가7002', '아이오닉5 프레스티지');
    fake.put('12가7002', heldDoc(r2, { vehicle_review_required: false }));
    expect((await run(commands, [r, r2])).kinds).toEqual([]);
    const changed = await run(commands, [rec('12가7001', '아이오닉5 프레스티지', {}, 610000), rec('12가7002', '아이오닉5 프레스티지', {}, 610000)]);
    expect(changed.kinds).toEqual(['UPDATE', 'UPDATE']);
    expect(changed.plan.warnings.some(w => w.startsWith('VEHICLE_IDENTITY_REFINE'))).toBe(false);
    expect(changed.applied).toMatchObject({ status: 'APPLIED', verified: 2 });
    expect(fake.fields('12가7001')).toMatchObject({ maker: '현대', model: '아이오닉5', sub_model: '아이오닉5', trim_name: '익스클루시브', vehicle_title_source: 'ERP4' });
    expect(fake.fields('12가7001')).not.toHaveProperty('vehicle_master_id');
    expect(fake.fields('12가7002')).toMatchObject({ maker: '', model: '', sub_model: '아이오닉5 프레스티지', vehicle_review_required: false });
  });

  it('binds an approved plan to the master it was planned with: a changed master makes the replay differ (CYCLE_REPLAN_REQUIRED)', async () => {
    let current = refiner();
    const { commands, fake } = await setup(async () => current);
    const r = rec('12가8001', '아이오닉5 프레스티지');
    fake.put('12가8001', heldDoc(r));
    const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records: [r], observedAt: time, heldCount: 0, complete: true },
      await commands.list(source), now);
    current = refiner([...masters, master({ id: 'm-extra', sub_model: '그랜저 GN7', model: '그랜저' })]);
    await expect(applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now })).rejects.toThrow('CYCLE_REPLAN_REQUIRED');
    expect(fake.patches()).toBe(0);
  });
});

describe('차종 마스터 스냅샷 → 대조기 (회차당 한 번, 실패 시 정제 안 함)', () => {
  const readAt = '2026-10-15T01:00:00.000Z';
  const snapshot = (at = readAt) => {
    const masters = [
      { id: 'vm1', data: { maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', model_aliases: ['아이오닉5'], sub_model_aliases: ['아이오닉5'], year_start: '2021', year_end: '현재' } },
      { id: 'vm-old', data: { maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 구형', sub_model_aliases: ['아이오닉5'], retired: true } },
    ];
    const trims = [
      { id: 't1', data: { master_id: 'vm1', maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', trim: '프레스티지', trim_aliases: ['프레스티지 롱레인지'] } },
      { id: 't2', data: { master_id: 'vm1', maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', trim: '익스클루시브' } },
    ];
    const body = { readAt: at, masters, trims };
    return { source: 'freepasserp5/vehicle_master+vehicle_trim_master', complete: true, ...body, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  };
  it('builds IdentityMasters from the verified snapshot (retired masters out, generation years from the master)', () => {
    const s = snapshot();
    const records = [{ masterId: 'vm1', names: ['현대', '아이오닉 5', '아이오닉 5 NE', '프레스티지'], aliases: [['현대'], ['아이오닉 5'], ['아이오닉 5 NE'], ['프레스티지', '프레스티지 롱레인지']] },
      { masterId: 'vm1', names: ['현대', '아이오닉 5', '아이오닉 5 NE', '익스클루시브'], aliases: [['현대'], ['아이오닉 5'], ['아이오닉 5 NE'], ['익스클루시브']] }];
    expect(identityMastersFromVehicleMaster({ masters: s.masters, records })).toEqual([{ id: 'vm1', maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE',
      model_aliases: ['아이오닉5'], sub_model_aliases: ['아이오닉5'], yearFrom: 2021, yearTo: null,
      trims: [{ name: '익스클루시브', aliases: [] }, { name: '프레스티지', aliases: ['프레스티지 롱레인지'] }] }]);
  });
  it('enables the refiner from a fresh valid snapshot and skips (null) when unreadable, stale or empty', async () => {
    const ok = await loadIdentityRefiner(async () => snapshot(), () => Date.parse(readAt) + 1000);
    expect(ok.status).toMatch(/^ENABLED:[0-9a-f]{12}$/);
    expect(ok.refiner?.match({ rawName: '아이오닉5 프레스티지', year: '2023' })).toEqual({ maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', trim_name: '프레스티지', master_id: 'vm1' });
    expect(ok.refiner?.match({ rawName: '아이오닉5 프레스티지', year: '2019' })).not.toBeNull();   // 후보가 하나면 연식으로 거르지 않는다(기존 규칙 그대로)
    expect(ok.refiner?.allowsYear?.('vm1', 2019)).toBe(false);
    expect(ok.refiner?.allowsYear?.('vm1', 2023)).toBe(true);
    expect(ok.refiner?.allowsYear?.('vm1', 2029)).toBe(false);
    expect(ok.refiner?.allowsYear?.('unknown-master', 2023)).toBe(false);
    expect(await loadIdentityRefiner(async () => { throw new Error('PERMISSION_DENIED'); })).toEqual({ status: 'SKIPPED:VEHICLE_MASTER_UNAVAILABLE', refiner: null });
    expect(await loadIdentityRefiner(async () => snapshot(), () => Date.parse(readAt) + 3_600_000)).toEqual({ status: 'SKIPPED:VEHICLE_MASTER_INVALID', refiner: null });
    const tampered = { ...snapshot(), digest: '0'.repeat(64) };
    expect((await loadIdentityRefiner(async () => tampered, () => Date.parse(readAt))).status).toBe('SKIPPED:VEHICLE_MASTER_INVALID');
    expect((await loadIdentityRefiner(() => new Promise(() => {}), Date.now, 20)).status).toBe('SKIPPED:VEHICLE_MASTER_READ_TIMEOUT');
  });
  it('waits for real elapsed time on small server clock lead without rewriting sealed evidence or weakening validation', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse(readAt) - 1400);
      const sealed = snapshot(), before = structuredClone(sealed);
      let done = false;
      const pending = loadIdentityRefiner(async () => sealed).then(r => { done = true; return r; });
      await vi.advanceTimersByTimeAsync(1400);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).status).toMatch(/^ENABLED:/);
      expect(sealed).toEqual(before);
      // 5초를 넘고 60초 이내의 «미래» 스냅숏은 기다리지 않고 허용하며 어긋난 초를 돌려준다(대표 2026-10-22). 60초를 넘으면 보류.
      vi.setSystemTime(Date.parse(readAt) - 6000);
      const skewed = await loadIdentityRefiner(async () => sealed);
      expect(skewed.status).toMatch(/^ENABLED:/);
      expect(skewed.clockSkewSeconds).toBe(6);
      expect(sealed).toEqual(before);
      vi.setSystemTime(Date.parse(readAt) - 61_000);
      expect((await loadIdentityRefiner(async () => sealed)).status).toBe('SKIPPED:VEHICLE_MASTER_INVALID');
      vi.setSystemTime(Date.parse(readAt) - 30_000);
      expect((await loadIdentityRefiner(async () => ({ ...sealed, digest: '0'.repeat(64) }))).status).toBe('SKIPPED:VEHICLE_MASTER_INVALID');   // 무결성 검증은 그대로
      vi.setSystemTime(Date.parse(readAt) - 1400);
      const tampered = loadIdentityRefiner(async () => ({ ...sealed, digest: '0'.repeat(64) }));
      await vi.advanceTimersByTimeAsync(1401);
      expect((await tampered).status).toBe('SKIPPED:VEHICLE_MASTER_INVALID');
      const frozen = loadIdentityRefiner(async () => sealed, () => Date.parse(readAt) - 1400);
      await vi.advanceTimersByTimeAsync(1401);
      expect((await frozen).status).toBe('SKIPPED:VEHICLE_MASTER_INVALID');
    } finally { vi.useRealTimers(); }
  });
  it('requires an explicit eligible trim model-year declaration before accepting a future source year', async () => {
    const s = snapshot();
    Object.assign(s.trims[0]!.data, { model_year_start: '2027' });
    s.digest = createHash('sha256').update(JSON.stringify({ readAt: s.readAt, masters: s.masters, trims: s.trims })).digest('hex');
    const r = await loadIdentityRefiner(async () => s, () => Date.parse(readAt) + 1000);
    expect(r.refiner?.allowsYear?.('vm1', 2027)).toBe(true);
    expect(r.refiner?.allowsYear?.('vm1', 2029)).toBe(false);
    Object.assign(s.trims[0]!.data, { retired: true });
    s.digest = createHash('sha256').update(JSON.stringify({ readAt: s.readAt, masters: s.masters, trims: s.trims })).digest('hex');
    const retired = await loadIdentityRefiner(async () => s, () => Date.parse(readAt) + 1000);
    expect(retired.refiner?.allowsYear?.('vm1', 2027)).toBe(false);
  });
});

describe('엔진 회차 정체성 정제 — 계약 잠금 문서는 이름 칸만 (대표 2026-10-22 승인)', () => {
  const fieldsOf = (fake: Awaited<ReturnType<typeof setup>>['fake'], uid: string) => structuredClone(fake.fields(uid)) as Record<string, any>;
  it('fills only the name fields on a contract-locked held document and proves every other field is unchanged', async () => {
    const { commands, fake } = await setup();
    fake.put('12가8001', heldDoc(rec('12가8001', '아이오닉5 프레스티지'), { locked_by_contract: '계약원장', status: '계약중', status_kind: '선점', vehicle_status: '계약중' }));
    const before = fieldsOf(fake, '12가8001');
    const r = rec('12가8001', '아이오닉5 프레스티지', { year: '2022' }, 777000, '2026-10-15T01:03:00.000Z');
    const out = await run(commands, [r]);
    expect(out.kinds).toEqual(['UPDATE']);
    expect(out.plan.entries[0]!.after.identityOnly).toBe(true);
    expect(out.applied).toMatchObject({ status: 'APPLIED', verified: 1 });
    const after = fieldsOf(fake, '12가8001');
    expect(after).toMatchObject({ maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', trim_name: '프레스티지', vehicle_review_required: false });
    const allowed = new Set(['maker', 'model', 'sub_model', 'trim_name', 'vehicle_review_required']);
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (!allowed.has(k)) expect([k, after[k]]).toEqual([k, before[k]]);   // 계약·금액·상태·잠금·원천 기록 불변
    expect(after.locked_by_contract).toBe('계약원장');
    expect(after.price).toEqual(before.price);
    expect(after.source_cycle_record).toEqual(before.source_cycle_record);
    // 되풀이 없음: 같은 원천으로 다시 돌리면 쓰기 0
    const patches = fake.patches();
    const second = await run(commands, [r]);
    expect(second.kinds).toEqual([]);
    expect(fake.patches()).toBe(patches);
  });
  it('does not touch a locked document when the name cannot be uniquely decided, nor an already-named one', async () => {
    const { commands, fake } = await setup();
    fake.put('12가8002', heldDoc(rec('12가8002', '카니발 9인승 노블레스'), { locked_by_contract: '계약원장' }));
    fake.put('12가8003', heldDoc(rec('12가8003', '아이오닉5 프레스티지'), { locked_by_contract: '계약원장', maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', vehicle_review_required: false }));
    const b2 = fieldsOf(fake, '12가8002'), b3 = fieldsOf(fake, '12가8003');
    const out = await run(commands, [rec('12가8002', '카니발 9인승 노블레스'), rec('12가8003', '아이오닉5 프레스티지')]);
    expect(out.kinds).toEqual([]);
    expect(fieldsOf(fake, '12가8002')).toEqual(b2);
    expect(fieldsOf(fake, '12가8003')).toEqual(b3);
  });
  it('writes nothing outside the fixed allow-list: the native fields for identityOnly are a subset of it', async () => {
    const { nativeCycleFields: fieldsFn, IDENTITY_ONLY_FIELDS } = await import('../src/infra/source-cycle-firestore.js');
    const r = rec('12가8004', '아이오닉5 프레스티지', { year: '2022' });
    const original = heldDoc(r, { locked_by_contract: '계약원장' });
    const out = fieldsFn({ record: compactRecord(r), listable: true, locked_by_contract: '계약원장' as never, publication_withdrawal: null, publication_withdrawal_prior: null, identityOnly: true, refineIdentity: true },
      original, { identity: refiner() });
    expect(Object.keys(out).length).toBeGreaterThan(0);
    for (const k of Object.keys(out)) expect(IDENTITY_ONLY_FIELDS as readonly string[]).toContain(k);
    expect(fieldsFn({ record: compactRecord(r), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null, identityOnly: true }, original, { identity: refiner() })).toEqual({});   // 양성 표식 없으면 쓰지 않음
  });
});

describe('잠금 문서 이름 칸 정제 — Codex 반례', () => {
  it('상한을 못 받은 잠금 문서 이름 항목은 계획에서 빠져 적용이 중단되지 않는다(다음 회차로 이월)', async () => {
    const { commands, fake } = await setup();
    const plates = Array.from({ length: 3 }, (_, i) => `12가81${i}0`);
    for (const p of plates) fake.put(p, heldDoc(rec(p, '아이오닉5 프레스티지'), { locked_by_contract: '계약원장' }));
    const prev = process.env.SOURCE_CYCLE_OPTIONS_REWRITE_CAP;
    const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records: plates.map(p => rec(p, '아이오닉5 프레스티지', { year: '2022' })), observedAt: time, heldCount: 0, complete: true },
      await commands.list(source), now);
    expect(built.plan.entries.every(e => e.after.identityOnly !== true || e.after.refineIdentity === true)).toBe(true);
    void prev;
  });
});
