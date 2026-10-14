import { describe, expect, it } from 'vitest';
import { planIdentityPromotion } from '../src/application/identity-promotion-plan.js';
import type { VehicleMasterRecord } from '../src/domain/vehicle-identity-resolution.js';
import { validateVehicleNameRepairPlan } from '../src/infra/vehicle-name-reference-repair-firestore.js';

const record = (masterId: string, maker: string, model: string, sub: string, subAliases: string[] = []): VehicleMasterRecord => ({
  masterId, trimId: `${masterId}-t1`, names: [maker, model, sub, '기본'], aliases: [[maker], [model], [sub, ...subAliases], ['기본']],
});
const records = [
  record('m-cn7', '현대', '아반떼', '더 뉴 아반떼 CN7', ['아반떼 CN7']),
  record('m-cn8', '현대', '아반떼', '아반떼 CN8'),
  record('m-gn7', '현대', '그랜저', '그랜저 GN7'),
  record('m-gn7h', '현대', '그랜저', '그랜저 하이브리드 GN7'),
  record('m-k5', '기아', 'K5', '더 뉴 K5 DL3'),
];
const engineDoc = (rawName: string, extra: Record<string, unknown> = {}) => ({
  maker: '', model: '', sub_model: rawName, trim_name: '', vehicle_review_required: true, 원문: { 차명: rawName }, ...extra,
});
const plan = (products: Array<{ id: string; data: Record<string, unknown> }>) =>
  planIdentityPromotion({ products, records, snapshotDigest: 'a'.repeat(64) });

describe('identity promotion plan (read-only, unique master only)', () => {
  it('plans only when the raw name contains one master sub-model name or alias verbatim', () => {
    const report = plan([{ id: '12가3456', data: engineDoc('아반떼 CN7 1.6 인스퍼레이션') }]);
    expect(report.counts).toMatchObject({ eligible: 1, planned: 1, held: 0 });
    const item = report.plans[0]!.productIdentityRepairs[0]!;
    expect(item.from).toEqual({ maker: '', model: '', sub_model: '아반떼 CN7 1.6 인스퍼레이션' });
    expect(item.to).toEqual({ maker: '현대', model: '아반떼', sub_model: '더 뉴 아반떼 CN7' });
    expect(() => validateVehicleNameRepairPlan(report.plans[0]!)).not.toThrow();
  });

  it('never guesses a generation or sub-model from a partial name', () => {
    const report = plan([{ id: 'p1', data: engineDoc('아반떼 신형 1.6') }, { id: 'p2', data: engineDoc('그랜저 GN7 하이브리드 캘리그래피') }]);
    expect(report.counts.planned).toBe(0);
    expect(report.holds).toEqual([
      expect.objectContaining({ id: 'p1', reason: 'NO_MASTER_MATCH' }),
      expect.objectContaining({ id: 'p2', reason: 'HYBRID_SOURCE_CONFLICT' }),
    ]);
  });

  it('holds two matching masters and a foreign maker in the raw name', () => {
    const report = plan([
      { id: 'p1', data: engineDoc('아반떼 CN7 / 아반떼 CN8 혼재') },
      { id: 'p2', data: engineDoc('기아 아반떼 CN7') },
    ]);
    expect(report.holds.map(h => [h.id, h.reason])).toEqual([['p1', 'MULTIPLE_MASTER_MATCH'], ['p2', 'MAKER_CONFLICT']]);
  });

  it('ignores products already named by the master and keeps hold reasons counted', () => {
    const report = plan([
      { id: 'named', data: { maker: '현대', model: '아반떼', sub_model: '더 뉴 아반떼 CN7', vehicle_review_required: true } },
      { id: 'noflag', data: { maker: '', model: '', sub_model: '아반떼 CN7' } },
      { id: 'blank', data: engineDoc('') },
    ]);
    expect(report.counts).toMatchObject({ scanned: 3, eligible: 1, planned: 0, byReason: { RAW_NAME_MISSING: 1 } });
  });

  it('splits plans at the apply limit and is deterministic', () => {
    const products = Array.from({ length: 205 }, (_, i) => ({ id: `p${String(i).padStart(3, '0')}`, data: engineDoc('더 뉴 K5 DL3 2.0') }));
    const a = plan(products), b = plan([...products].reverse());
    expect(a.plans.map(p => p.productIdentityRepairs.length)).toEqual([200, 5]);
    expect(a).toEqual(b);
    for (const p of a.plans) expect(() => validateVehicleNameRepairPlan(p)).not.toThrow();
  });
});
