import { describe, expect, it } from 'vitest';
import { mergeSupplements } from '../src/jobs/merge-shared-sheet-supplement.js';

const c = (over: Record<string, unknown> = {}) => ({ supplierCode: 'RP013', plate: '12가3456', at: '2026-10-04T18:17:55+09:00',
  column: '세부모델', before: '더 뉴 셀토스', after: '더 뉴 셀토스 SP2', source: 'ai-ops/시트고치기', ...over });

describe('merge shared-sheet supplement', () => {
  it('turns timestamps into UTC Z and keeps one copy of an identical correction across days', () => {
    const out = mergeSupplements([{ corrections: [c()] }, { corrections: [{ ...c(), source: 'ai-ops/시트고치기' }] }]);
    expect(out.corrections).toHaveLength(1);
    expect(out.corrections[0]!.at).toBe('2026-10-04T09:17:55.000Z');
  });
  it('treats property order as irrelevant', () => {
    const { source, ...rest } = c();
    expect(mergeSupplements([{ corrections: [c()] }, { corrections: [{ source, ...rest }] }]).corrections).toHaveLength(1);
  });
  it('stops on conflicting corrections of the same car, even when the plate differs only by spacing', () => {
    expect(() => mergeSupplements([{ corrections: [c()] }, { corrections: [c({ plate: '12가 3456', after: '셀토스 SP3' })] }]))
      .toThrow('SUPPLEMENT_CONFLICT');
  });
  it('rejects null or non-string timestamps and malformed parts with a fixed code', () => {
    expect(() => mergeSupplements([{ corrections: [c({ at: null })] }])).toThrow('SUPPLEMENT_INVALID');
    expect(() => mergeSupplements([{ corrections: 'x' }])).toThrow('SUPPLEMENT_INVALID');
  });
});
