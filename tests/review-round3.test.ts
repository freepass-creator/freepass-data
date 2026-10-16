import { describe, expect, it } from 'vitest';
import { readSonogongVehicles } from '../src/adapters/sonogong-observe.js';
import { mapAutoplusDetail } from '../src/adapters/autoplus-homepage.js';
import { reconcileSource } from '../src/application/source-reconciliation.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';
import type { CycleProduct } from '../src/ports/source-cycle.js';

describe('독립 검토 3차(2026-10-14) 재현 시험', () => {
  it('status values come from an explicit enumeration only — a customer name stays out of the report', () => {
    const v = readSonogongVehicles([{ bucket: 'LOW_TCAR', observedAt: 't', revision: 'r', declaredTotal: 1, complete: true,
      records: [{ list: { id: '1', carNumber: '12가1001', carSource: 'TCAR_EXTERNAL', status: '출고가능', customerStatus: '홍길동', stateMemo: 'ab' }, detail: null }] }] as never);
    expect(v[0]!.statusValues).toEqual({ status: '출고가능', customerStatus: '기타', stateMemo: '기타' });
  });

  it('a boolean or out-of-range price is UNKNOWN, never a KNOWN 1 that could re-expose a document', () => {
    const detail = (price: unknown) => ({ productId: 'C12345678901', carNumber: '12가3456', bmname: 'a', boname: 'b', gradename: 'c',
      rentPriceObjs: JSON.stringify([{ rentMonth: 36, rentPrice2: price, rentPrice3: 450000 }]) });
    const terms = (price: unknown) => ('record' in mapAutoplusDetail(detail(price), 't') ? (mapAutoplusDetail(detail(price), 't') as { record: SourceProductRecord }).record.terms : []);
    expect(terms(true).map(t => t.mileage)).toEqual(['30000km/year']);   // rentPrice2 는 버려지고 3만km 항만 남는다
    expect(terms(1).map(t => t.mileage)).toEqual(['30000km/year']);
    expect(terms('500000').map(t => t.mileage)).toEqual(['20000km/year', '30000km/year']);
  });

  const rec = (plate: string, uid: string): SourceProductRecord => ({ sourceId: 'RP012', uid, plate, vehicleText: 'x',
    status: { raw: '출고가능', saleAvailable: true }, terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'ZERO', value: 0 }, mileage: null, raw: {} }],
    observedAt: '2026-10-14T00:00:00.000Z', raw: {}, vehicleHold: [] });
  const doc = (r: SourceProductRecord, listable: boolean): CycleProduct => ({ record: r, listable, locked_by_contract: false,
    publication_withdrawal: null, publication_withdrawal_prior: null } as CycleProduct);

  it('two documents for the same plate give the same result in either order, and the duplicate is reported', () => {
    const a = doc(rec('12가1001', 'A'), true), b = doc(rec('12가1001', 'B'), false);
    const forward = reconcileSource([rec('12가1001', 'A')], [a, b]), backward = reconcileSource([rec('12가1001', 'A')], [b, a]);
    expect(forward).toEqual(backward);
    expect(forward).toMatchObject({ erpSellable: 1, same: 1, duplicateDocCount: 1, matched: false });
  });
});
