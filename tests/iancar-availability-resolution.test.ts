import { describe, expect, it } from 'vitest';
import { resolveIancarAvailability } from '../src/domain/iancar-availability-resolution.js';

const seen = (erp: boolean, sheet: boolean, explicitState?: string) => ({
  erp: { observed: erp, sourceRevision: 'erp:r1', observedAt: '2026-09-22T06:00:00Z', coverageComplete: true,
    freshnessVerified: true, ...(explicitState ? { explicitState } : {}) },
  sheet: { observed: sheet, sourceRevision: 'sheet:r1', observedAt: '2026-09-22T06:01:00Z', coverageComplete: true,
    freshnessVerified: true }, previouslyRegistered: true
});

describe('Iancar availability resolution', () => {
  it('uses ERP presence as available and gives it precedence over the Sheet', () => {
    expect(resolveIancarAvailability(seen(true, false))).toMatchObject({ state: '출고가능', canonicalStatus: 'AVAILABLE' });
    expect(resolveIancarAvailability(seen(true, true))).toMatchObject({ state: '출고가능', reasons: ['ERP_PRECEDENCE_OVER_SHEET'] });
  });
  it('holds a Sheet-only vehicle as 출고협의', () => {
    expect(resolveIancarAvailability(seen(false, true))).toMatchObject({ state: '출고협의', canonicalStatus: 'HOLD', reviewRequired: true });
  });
  it.each([['예약중', '예약중', 'RESERVED'], ['계약중', '예약중', 'RESERVED'], ['판매완료', '판매완료', 'SOLD'],
    ['출고불가', '출고불가', 'UNAVAILABLE']] as const)('preserves explicit ERP state %s', (raw, state, canonicalStatus) => {
    expect(resolveIancarAvailability(seen(true, true, raw))).toMatchObject({ state, canonicalStatus, reviewRequired: false });
  });
  it('holds an unknown explicit ERP state instead of guessing available', () => {
    expect(resolveIancarAvailability(seen(true, true, '검토중'))).toMatchObject({ state: '미관측', canonicalStatus: 'HOLD' });
  });
  it('preserves registered history when both current sources do not observe it', () => {
    expect(resolveIancarAvailability(seen(false, false))).toMatchObject({ state: '미관측', sourceDecision: 'HISTORY_ONLY', deleteAuthorized: false });
  });
  it('does not create a candidate with no observation or history', () => {
    const input = seen(false, false); input.previouslyRegistered = false;
    expect(resolveIancarAvailability(input)).toMatchObject({ canonicalStatus: 'NO_CANDIDATE', sourceDecision: 'NONE' });
  });
  it('requires source revision and observation time evidence', () => {
    const input = seen(true, false); input.erp.sourceRevision = '';
    expect(() => resolveIancarAvailability(input)).toThrow('INVALID_IANCAR_AVAILABILITY_INPUT');
  });
  it('holds stale or partial ERP evidence instead of claiming availability', () => {
    const input = seen(true, true); input.erp.freshnessVerified = false;
    expect(resolveIancarAvailability(input)).toMatchObject({ canonicalStatus: 'HOLD', reasons: ['ERP_OBSERVATION_NOT_CURRENT_AND_COMPLETE'] });
  });
  it('does not infer ERP absence from an incomplete collection', () => {
    const input = seen(false, true); input.erp.coverageComplete = false;
    expect(resolveIancarAvailability(input)).toMatchObject({ state: '미관측', canonicalStatus: 'HOLD' });
  });
  it('does not classify history-only when Sheet absence is stale', () => {
    const input = seen(false, false); input.sheet.freshnessVerified = false;
    expect(resolveIancarAvailability(input)).toMatchObject({ canonicalStatus: 'HOLD', sourceDecision: 'NONE' });
  });
  it('rejects an ERP state without an ERP observation', () => {
    expect(() => resolveIancarAvailability(seen(false, true, '출고불가'))).toThrow('ERP_STATE_WITHOUT_OBSERVATION');
  });
});
