import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
import { planSourceCycle, applySourceCycle } from '../src/application/source-cycle.js';
import type { CycleProduct } from '../src/ports/source-cycle.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';

// 손오공 첫 APPLY(2026-10-14) 재현: 원천이 «계약중» 으로 읽은 차를 쓰면 되읽기가 locked_by_contract 를 true 로 계산해 계획과 달랐다.
const time = '2026-10-14T11:00:00.000Z', now = Date.parse('2026-10-14T11:05:00.000Z'), source = 'RP012';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const rec = (plate: string, raw: string, observedAt = time): SourceProductRecord => ({ sourceId: source, uid: plate, plate, vehicleText: '합성 차명',
  status: { raw, saleAvailable: true }, observedAt, vehicleHold: [], raw: { source: 'sonogong-partner-api', product_type: '중고렌트', product_group: 'LONG_TERM' },
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'UNKNOWN', value: null }, mileage: null, raw: { priceType: 'BUYOUT' } }] });

function fakeFirestore(initial: Array<Record<string, unknown>> = []) {
  const docs = new Map<string, any>(); let version = 0;
  const doc = (uid: string, fields: any) => ({ name: `projects/synthetic-test/databases/(default)/documents/products/${uid}`, updateTime: `${time}:${++version}`, fields });
  for (const [i, f] of initial.entries()) docs.set(String(f.car_number ?? `INIT${i}`), doc(String(f.car_number ?? `INIT${i}`), encodeFields(f as never)));
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
    const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
    const after = doc(uid, fields); docs.set(uid, after); return Response.json(after);
  }) as unknown as typeof fetch;
  return { docs, fetcher };
}
async function setup(initial: Array<Record<string, unknown>> = []) {
  const dir = await mkdtemp(join(tmpdir(), 'contracted-readback-')); dirs.push(dir);
  const fake = fakeFirestore(initial);
  const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
    supplierDefaults: { RP012: { provider_name: '합성손오공', policy_code: 'SYNTHETIC_POLICY' } } });
  return { commands, fake };
}
const run = async (commands: Awaited<ReturnType<typeof setup>>['commands'], records: SourceProductRecord[], at = now) => {
  const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records, observedAt: records[0]!.observedAt, heldCount: 0, complete: true },
    await commands.list(source), at);
  const applied = await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now: at });
  return { built, applied };
};

describe('엔진이 쓴 «계약중» 문서의 되읽기·후속 갱신', () => {
  it('enrolls a source-contracted car and reads it back identically (no APPLY_UNCERTAIN)', async () => {
    const { commands, fake } = await setup();
    const { applied } = await run(commands, [rec('12가1001', '계약중'), rec('12가1002', '출고가능')]);
    expect(applied).toMatchObject({ status: 'APPLIED', verified: 2 });
    expect(decodeFields(fake.docs.get('12가1001').fields)).toMatchObject({ status: '계약중', listable: true });
  });

  it('keeps managing that document: when the source returns to 출고가능 the engine updates it instead of holding CONTRACT_LOCKED', async () => {
    const { commands, fake } = await setup();
    await run(commands, [rec('12가1001', '계약중')]);
    const later = '2026-10-14T12:00:00.000Z';
    const second = await run(commands, [rec('12가1001', '출고가능', later)], Date.parse('2026-10-14T12:05:00.000Z'));
    expect(second.built.plan.entries.map(e => e.kind)).toEqual(['UPDATE']);
    expect(second.applied).toMatchObject({ status: 'APPLIED', verified: 1 });
    expect(decodeFields(fake.docs.get('12가1001').fields)).toMatchObject({ status: '출고가능', listable: true });
  });

  it('re-exposes a previously withdrawn document whose source status is now 계약중 and verifies the readback', async () => {
    const before: CycleProduct = { record: rec('12가2000', '출고가능', '2026-10-14T00:00:00.000Z'), listable: false, locked_by_contract: false,
      publication_withdrawal: { reason: 'REPLACED_BY_API', deleteAuthorized: false } as never, publication_withdrawal_prior: null };
    const { commands } = await setup([{ ...nativeCycleFields(before), provider_name: '합성손오공', policy_code: 'SYNTHETIC_POLICY' }]);
    const { built, applied } = await run(commands, [rec('12가2000', '계약중')]);
    expect(built.plan.entries.map(e => e.kind)).toEqual(['REEXPOSE']);
    expect(applied).toMatchObject({ status: 'APPLIED', verified: 1 });
  });

  it('still protects a document that ERP marked 계약중 (status contracted but the source record is not 계약중)', async () => {
    const erp: CycleProduct = { record: rec('12가3000', '출고가능', '2026-10-14T00:00:00.000Z'), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null };
    const { commands } = await setup([{ ...nativeCycleFields(erp), status: '계약중', status_kind: '선점', vehicle_status: '계약중', provider_name: '합성손오공' }]);
    const { built } = await (async () => ({ built: planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 },
      { records: [rec('12가3000', '출고가능', time)], observedAt: time, heldCount: 0, complete: true }, await commands.list(source), now) }))();
    expect(built.plan.entries).toEqual([]);
  });

  describe('Codex P1: lock values and writer evidence', () => {
    const planFor = async (commands: Awaited<ReturnType<typeof setup>>['commands'], plate: string, raw: string) =>
      planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 },
        { records: [rec(plate, raw, '2026-10-14T12:00:00.000Z')], observedAt: '2026-10-14T12:00:00.000Z', heldCount: 0, complete: true },
        await commands.list(source), Date.parse('2026-10-14T12:05:00.000Z'));
    const engineContracted = async () => {
      const s = await setup();
      await run(s.commands, [rec('12가5000', '계약중')]);
      return s;
    };
    it('the engine-written 계약중 document carries the writer mark', async () => {
      const { fake } = await engineContracted();
      expect(decodeFields(fake.docs.get('12가5000').fields).source_cycle_write).toMatchObject({ by: 'source-engine', status: '계약중' });
    });
    it("protects a string lock like 'LEDGER' even on an engine-written 계약중 document", async () => {
      const { commands, fake } = await engineContracted();
      Object.assign(fake.docs.get('12가5000').fields, encodeFields({ locked_by_contract: 'LEDGER' }));
      expect((await planFor(commands, '12가5000', '출고가능')).plan.entries).toEqual([]);
    });
    it('protects an unknown lock value conservatively, and a plain status document with LEDGER', async () => {
      const { commands, fake } = await engineContracted();
      Object.assign(fake.docs.get('12가5000').fields, encodeFields({ locked_by_contract: { by: 'erp' } }));
      expect((await planFor(commands, '12가5000', '출고가능')).plan.entries).toEqual([]);
      const erp: CycleProduct = { record: rec('12가5001', '출고가능', '2026-10-14T00:00:00.000Z'), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null };
      const s2 = await setup([{ ...nativeCycleFields(erp), status: '계약중', status_kind: '선점', vehicle_status: '계약중', locked_by_contract: 'LEDGER', provider_name: '합성손오공' }]);
      expect((await planFor(s2.commands, '12가5001', '출고가능')).plan.entries).toEqual([]);
    });
    it('keeps protecting a 계약중 document without the writer mark (including pre-fix writes), and one whose status_kind ERP changed', async () => {
      const { commands, fake } = await engineContracted();
      const fields = fake.docs.get('12가5000').fields; delete fields.source_cycle_write;   // 표식 없는 기존 문서(수정 전 쓰기)
      expect((await planFor(commands, '12가5000', '출고가능')).plan.entries).toEqual([]);
      const s2 = await engineContracted();
      Object.assign(s2.fake.docs.get('12가5000').fields, encodeFields({ status_kind: '계약중' }));   // ERP 가 별도 계약 잠금
      expect((await planFor(s2.commands, '12가5000', '출고가능')).plan.entries).toEqual([]);
    });
    it('updates a marked engine-written 계약중 document when the source returns to 출고가능', async () => {
      const { commands } = await engineContracted();
      expect((await planFor(commands, '12가5000', '출고가능')).plan.entries.map(e => e.kind)).toEqual(['UPDATE']);
    });
  });

  it('reports the failing stage and top-level fields (codes only) when a readback does differ', async () => {
    let written: CycleProduct | null = null;
    const commands = {
      list: async () => ({ products: [], complete: true, enrollmentSupplier: { provider_name: 'x', policy_code: null } }),
      backup: async () => undefined, readBackup: async () => null,
      compareAndApply: async (_digest: string, after: CycleProduct) => { written = after; },
      read: async () => ({ ...structuredClone(written!), locked_by_contract: true }),   // 되읽기가 한 필드만 다르게 계산
    } as never;
    const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 },
      { records: [rec('12가4000', '출고가능')], observedAt: time, heldCount: 0, complete: true }, { products: [], complete: true, enrollmentSupplier: { provider_name: 'x', policy_code: null } } as never, now);
    const applied = await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now });
    expect(applied.status).toBe('APPLY_UNCERTAIN');
    expect((applied as { uncertainDetail?: string }).uncertainDetail).toBe('READBACK_MISMATCH:ENROLL:locked_by_contract');
  });
});
