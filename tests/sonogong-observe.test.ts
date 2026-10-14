import { describe, expect, it } from 'vitest';
import { readSonogongVehicles, summarizeSonogong } from '../src/adapters/sonogong-observe.js';
import type { SonogongBucketObservation } from '../src/adapters/supplier-source-capture.js';

const detail = (priced: boolean) => ({ estimates: [{ creditType: 'LOW', estimateType: 'SUBSCRIBE_RETURN', monthly36: priced ? 500000 : null }] });
const rec = (id: string, plate: string, carSource: string, priced: boolean, extra: Record<string, unknown> = {}, missing = false) =>
  ({ list: { id, carNumber: plate, carSource, ...extra }, detail: missing ? null : detail(priced) });
const obs = (bucket: SonogongBucketObservation['bucket'], records: SonogongBucketObservation['records']): SonogongBucketObservation =>
  ({ bucket, observedAt: '2026-10-14T00:00:00.000Z', revision: 'r', declaredTotal: records.length, complete: true, records });

describe('손오공 원천↔문서 차이표(관측 전용)', () => {
  const observations = [
    obs('LOW_TCAR', [rec('1', '12가1001', 'TCAR_EXTERNAL', true, { status: '출고가능' }), rec('2', '12가1002', 'TCAR_EXTERNAL', false, { status: '계약중' })]),
    obs('LOW_SONOKONG', [rec('3', '12하1003', 'SON_NO_KONG', true, { status: '출고가능' }), rec('4', '신차', 'SON_NO_KONG', true), rec('5', '12가1005', 'SON_NO_KONG', true, {}, true)]),
  ];
  it('reads plate identity, commercial type, price presence and status value distribution (no free text)', () => {
    const v = readSonogongVehicles(observations);
    expect(v.map(x => [x.id, x.plate, x.commercialType, x.priced, x.detailMissing])).toEqual([
      ['1', '12가1001', 'PICKUP_SUBSCRIPTION', true, false], ['2', '12가1002', 'PICKUP_SUBSCRIPTION', false, false],
      ['3', '12하1003', 'USED_RENT', true, false], ['4', null, expect.any(String), true, false], ['5', '12가1005', expect.any(String), false, true]]);
    expect(v[0]!.statusValues).toEqual({ status: '출고가능' });
  });
  it('summarizes NEW / MISSING / both by plate with last 4 digits only', () => {
    const docs = [{ plate: '12가1001', listable: true, status: '출고가능' }, { plate: '12가1002', listable: true, status: '계약중' },
      { plate: '99다9999', listable: true, status: '출고가능' }, { plate: '34나3434', listable: false, status: '출고불가' }];
    const s = summarizeSonogong(observations, docs);
    expect(s).toMatchObject({ sourceVehicles: 5, sourceWithPlate: 4, sourceWithoutPlate: 1, detailMissing: 1, docs: 4, docsExposed: 3,
      both: 2, newCount: 2, missingCount: 2, newPriced: 1, sourcePriced: 3, sourceUnpriced: 2 });
    expect(s.newLast4).toEqual(['1003', '1005']);
    expect(s.missingLast4).toEqual(['3434', '9999']);
    expect(s.statusFieldValues.status).toEqual({ 출고가능: 2, 계약중: 1 });
    expect(JSON.stringify(s)).not.toContain('12가1001');          // 번호 전체는 나가지 않는다
  });
});
