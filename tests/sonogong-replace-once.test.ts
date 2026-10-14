import { describe, expect, it } from 'vitest';
import { planSourceCycle } from '../src/application/source-cycle.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';
import type { CycleProduct } from '../src/ports/source-cycle.js';

const OBSERVED = '2026-10-14T06:00:00.000Z';
const now = Date.parse('2026-10-14T06:05:00.000Z');
const rec = (plate: string, raw = '출고가능'): SourceProductRecord => ({ sourceId: 'RP012', uid: plate, plate, vehicleText: 'x',
  status: { raw, saleAvailable: true }, observedAt: OBSERVED, raw: { source: 'sonogong-partner-api' }, vehicleHold: [],
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'UNKNOWN', value: null }, mileage: null, raw: {} }] });
const doc = (plate: string, over: Partial<CycleProduct> = {}): CycleProduct => ({ record: { ...rec(plate), observedAt: '2026-10-14T00:00:00.000Z' },
  listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null, ...over });
const cfg = { sourceId: 'RP012', family: 'OTHER' as const, maxDowngradeRatio: 0.2 };
const evidence = (records: SourceProductRecord[], complete = true) => ({ records, complete, observedAt: OBSERVED, heldCount: 0 });

describe('손오공 API 교체 철회(REPLACED_BY_API)', () => {
  const existing = Array.from({ length: 10 }, (_, i) => doc(`12가${1000 + i}`));
  it('withdraws exposed documents that the API does not have, outside the downgrade-ratio guard, never deleting', () => {
    // API 에는 2대만 있고 기존 노출 10대 중 8대가 없다 → 비율 20% 가드였다면 막혔을 규모
    const api = [rec('12가1000'), rec('12가1001')];
    const guarded = planSourceCycle(cfg, evidence(api), { products: existing, complete: true }, now).plan;
    expect(guarded.blockers).toContain('DOWNGRADE_RATIO_EXCEEDED');                         // 평소 부재 하향은 가드에 걸린다
    const replace = planSourceCycle({ ...cfg, absenceReason: 'REPLACED_BY_API' }, evidence(api), { products: existing, complete: true }, now).plan;
    expect(replace.blockers).toEqual([]);
    const withdrawn = replace.entries.filter(e => e.kind === 'DOWNGRADE');
    expect(withdrawn).toHaveLength(8);
    expect(withdrawn.every(e => e.after.listable === false && e.after.publication_withdrawal?.reason === 'REPLACED_BY_API' &&
      e.after.publication_withdrawal.deleteAuthorized === false)).toBe(true);
    expect(replace.config.absenceReason).toBe('REPLACED_BY_API');                          // replay 가 같은 결과를 내도록 plan.config 에 기록
  });

  it('keeps contract-locked documents untouched', () => {
    const locked = doc('12가2000', { locked_by_contract: true });
    const plan = planSourceCycle({ ...cfg, absenceReason: 'REPLACED_BY_API' }, evidence([rec('12가1000')]), { products: [...existing.slice(0, 2), locked], complete: true }, now).plan;
    expect(plan.entries.map(e => e.after.record.plate)).not.toContain('12가2000');
  });

  it('does nothing when the read is incomplete (read failure / shrunk): the existing documents stay exposed', () => {
    const plan = planSourceCycle({ ...cfg, absenceReason: 'REPLACED_BY_API' }, evidence([rec('12가1000')], false), { products: existing, complete: true }, now).plan;
    expect(plan.entries.filter(e => e.kind === 'DOWNGRADE')).toHaveLength(0);
    expect(plan.blockers).toContain('SOURCE_INCOMPLETE');
  });

  it('does not withdraw twice: already non-exposed documents are skipped on a re-run', () => {
    const first = planSourceCycle({ ...cfg, absenceReason: 'REPLACED_BY_API' }, evidence([rec('12가1000')]), { products: existing, complete: true }, now).plan;
    const after = existing.map(p => first.entries.find(e => e.after.record.uid === p.record.uid)?.after ?? p);
    const second = planSourceCycle({ ...cfg, absenceReason: 'REPLACED_BY_API' }, evidence([rec('12가1000')]), { products: after, complete: true }, now).plan;
    expect(second.entries.filter(e => e.kind === 'DOWNGRADE')).toHaveLength(0);
  });
});
