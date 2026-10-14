import { describe, expect, it } from 'vitest';
import { sonogongApiEnabled, sonogongApiWritePlugin } from '../src/runtime/source-cycle-runtime.js';
import { planSourceCycle } from '../src/application/source-cycle.js';
import type { SonogongApiRead } from '../src/adapters/sonogong-api.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';

const OBSERVED = '2026-10-14T06:00:00.000Z';
const now = Date.parse('2026-10-14T06:05:00.000Z');
const rec = (plate: string, raw = '출고가능'): SourceProductRecord => ({ sourceId: 'RP012', uid: plate, plate, vehicleText: 'x',
  status: { raw, saleAvailable: true }, observedAt: OBSERVED, raw: { source: 'sonogong-partner-api' }, vehicleHold: [],
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'UNKNOWN', value: null }, mileage: null, raw: {} }] });
const read = (records: SourceProductRecord[], over: Partial<SonogongApiRead> = {}): SonogongApiRead => ({ observedAt: OBSERVED, complete: true, tabsRead: ['rent', 'sub', 'pick'],
  records, held: [], duplicatePlates: [], listed: records.length, detailsRead: records.length, notes: [], ...over });

describe('손오공 공식 API 런타임 연결', () => {
  it('is enabled only with the switch AND key AND base; any missing piece keeps RP012 observation-only with zero calls', () => {
    expect(sonogongApiEnabled({})).toBe(false);
    expect(sonogongApiEnabled({ SOURCE_CYCLE_SONOGONG_API: '1' })).toBe(false);
    expect(sonogongApiEnabled({ SOURCE_CYCLE_SONOGONG_API: '1', SONOGONG_API_KEY: 'k' })).toBe(false);
    expect(sonogongApiEnabled({ SOURCE_CYCLE_SONOGONG_API: '1', SONOGONG_API_KEY: 'k', SONOGONG_API_BASE: 'https://sokrc.com/api/partner/v1' })).toBe(true);
    expect(sonogongApiEnabled({ SOURCE_CYCLE_SONOGONG_API: 'true', SONOGONG_API_KEY: 'k', SONOGONG_API_BASE: 'b' })).toBe(false);   // 정확히 '1' 만
    expect(sonogongApiEnabled({ SOURCE_CYCLE_SONOGONG_API: '1', SONOGONG_API_KEY: '  ', SONOGONG_API_BASE: 'b' })).toBe(false);
  });

  it('passes API records to the engine (계약중 stays sellable with a 계약중 mark) and reports incomplete reads as incomplete', async () => {
    const plugin = sonogongApiWritePlugin(0.5, async () => read([rec('12가1001'), rec('12가1002', '계약중')], { notes: ['CROSS_TAB_DUPLICATE:1'] }));
    const out = await plugin.read();
    expect(out.complete).toBe(true);
    expect(plugin.sourceId).toBe('RP012');
    const converted = plugin.toRecords(out);
    expect(converted.records.map(r => [r.plate, r.status.raw, r.status.saleAvailable])).toEqual([['12가1001', '출고가능', true], ['12가1002', '계약중', true]]);
    expect((out.raw as { notes?: string[] }).notes).toEqual(['CROSS_TAB_DUPLICATE:1']);
    const partial = sonogongApiWritePlugin(0.5, async () => read([rec('12가1001')], { complete: false, incompleteReason: 'API_DETAIL_FAILED' }));
    const partialRead = await partial.read();
    expect(partialRead.complete).toBe(false);
  });

  it('writes the Sonogong product type from the tab (rent=중고렌트, sub=오공구독, pick=픽업구독) only for the fixed vocabulary', async () => {
    const { nativeCycleFields } = await import('../src/infra/source-cycle-firestore.js');
    const product = (type: unknown) => ({ record: { ...rec('12가1001'), raw: { source: 'sonogong-partner-api', product_type: type } },
      listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null }) as never;
    expect(nativeCycleFields(product('픽업구독')).product_type).toBe('픽업구독');
    expect(nativeCycleFields(product('오공구독')).product_type).toBe('오공구독');
    expect(nativeCycleFields(product('임의값')).product_type).toBeUndefined();
    expect(nativeCycleFields(product(undefined)).product_type).toBeUndefined();
  });
  it('one-time enroll cap: raises the cap only when set (201+), absolute max 1000, and the confirmed cap otherwise', () => {
    const cfg = { sourceId: 'RP012', family: 'OTHER' as const, maxDowngradeRatio: 0.5 };
    const many = Array.from({ length: 250 }, (_, i) => rec(`12가${String(1000 + i)}`));
    const evidence = { records: many, complete: true, observedAt: OBSERVED, heldCount: 0 };
    const snapshot = { products: [], complete: true };
    expect(planSourceCycle(cfg, evidence, snapshot, now).plan.entries.filter(e => e.kind === 'ENROLL')).toHaveLength(100);          // 확정 상한(노출 0 → 100)
    const once = planSourceCycle({ ...cfg, enrollCapOnce: 300 }, evidence, snapshot, now).plan;
    expect(once.entries.filter(e => e.kind === 'ENROLL')).toHaveLength(250);
    expect(once.config.enrollCapOnce).toBe(300);                                                                                      // replay 가 같은 결과를 내도록 plan.config 에 기록
    expect(planSourceCycle({ ...cfg, enrollCapOnce: 50 }, evidence, snapshot, now).plan.entries.filter(e => e.kind === 'ENROLL')).toHaveLength(100);   // 낮추기는 불가
    const huge = Array.from({ length: 1200 }, (_, i) => rec(`12가${String(1000 + i)}`));
    expect(planSourceCycle({ ...cfg, enrollCapOnce: 5000 }, { ...evidence, records: huge }, snapshot, now).plan.entries.filter(e => e.kind === 'ENROLL')).toHaveLength(1000);
  });
});
