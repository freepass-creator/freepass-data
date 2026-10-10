import { describe, expect, it } from 'vitest';
import { normalizeLegacyProduct } from '../src/adapters/legacy-normalizer.js';

describe('legacy product normalizer', () => {
  const sourceWaiver = { 원문: { 전체: { 장기보증: '무보증' } } };
  const depositCandidate = (deposit: unknown, extra: Record<string, unknown> = {}) => normalizeLegacyProduct({
    sourceId: 'freepasserp3/firestore/products', sourceRecordId: 'synthetic-deposit',
    observedAt: '2026-10-07T00:00:00Z', fingerprint: 'synthetic',
    data: { model: 'synthetic', provider_company_code: 'RP004', product_type: '중고렌트',
      price: { '12_2만': { rent: 500000, deposit } }, ...extra }
  });
  it.each(['미확인', '', null, undefined, 0, '0', '협의'])('does not infer waiver from %j', deposit => {
    const c = depositCandidate(deposit);
    expect(c.priceTerms[0]).toMatchObject({ depositState: 'UNKNOWN', deposit: null });
    expect(c.issues.some(x => x.startsWith('DEPOSIT_REVIEW_REQUIRED:'))).toBe(true);
  });
  it('accepts evidenced zero while blocking forbidden and conflicting rules', () => {
    expect(depositCandidate(0, { ...sourceWaiver, deposit_note: '무보증' }).priceTerms[0]).toMatchObject({ depositState: 'ZERO', deposit: { amount: 0 } });
    for (const extra of [{ ...sourceWaiver, provider_company_code: 'RP012', deposit_note: '무보증' },
      { ...sourceWaiver, product_type: '픽업구독', deposit_note: '무보증' }, { deposit_note: '월 대여료×2' },
      { ...sourceWaiver, deposit_note: '무보증', deposit_free: false }]) {
      expect(depositCandidate(0, extra).priceTerms[0]!.depositState).toBe('UNKNOWN');
    }
    expect(depositCandidate(null, { deposit_note: '무보증' }).priceTerms[0]!.depositState).toBe('UNKNOWN');
  });
  it('preserves period and mileage scoped positive evidence and detects a conflicting sibling', () => {
    const price = { '12_2만': { rent: 500000, deposit: 1000000 }, '24_3만': { rent: 400000, deposit: 2000000 } };
    expect(depositCandidate(0, { price }).priceTerms.map(t => [t.termMonths, t.mileageLimitKmPerYear, t.deposit?.amount]))
      .toEqual([[12, 20000, 1000000], [24, 30000, 2000000]]);
    expect(depositCandidate(0, { deposit_note: '무보증', price: { ...price, '36': { rent: 300000, deposit: 0 } } })
      .priceTerms.every(t => t.depositState === 'UNKNOWN')).toBe(true);
  });
  it('preserves pickup subscription and mileage-scoped price identity', () => {
    const candidate = normalizeLegacyProduct({
      sourceId: 'freepasserp3/firestore/products',
      sourceRecordId: '123가4567',
      observedAt: '2026-09-20T10:00:00Z',
      fingerprint: 'abc',
      data: {
        product_code: 'P1',
        car_number: '123가4567',
        maker: '제네시스',
        model: 'GV70',
        product_type: '픽업구독',
        price: {
          '24_3만': { rent: '750,000', deposit: '3,000,000' }
        }
      }
    });

    expect(candidate.commercialType).toBe('PICKUP_SUBSCRIPTION');
    expect(candidate.priceTerms[0]?.termKey).toBe('source:24_3만');
    expect(candidate.priceTerms[0]?.termMonths).toBe(24);
    expect(candidate.priceTerms[0]?.mileageLimitKmPerYear).toBe(30000);
    expect(candidate.priceTerms[0]?.depositState).toBe('KNOWN');
  });

  it('does not infer blank deposit as zero', () => {
    const candidate = normalizeLegacyProduct({
      sourceId: 'freepasserp3/firestore/products',
      sourceRecordId: 'x',
      observedAt: '2026-09-20T10:00:00Z',
      fingerprint: 'def',
      data: {
        model: 'Ray',
        product_type: '중고렌트',
        price: { '36': { rent: 590000, deposit: '' } }
      }
    });

    expect(candidate.priceTerms[0]?.depositState).toBe('UNKNOWN');
    expect(candidate.priceTerms[0]?.deposit).toBeNull();
  });

  it('preserves Ogong subscription as its own commercial type', () => {
    const candidate = normalizeLegacyProduct({
      sourceId: 'freepasserp3/firestore/products',
      sourceRecordId: '68로3197',
      observedAt: '2026-09-21T03:00:00Z',
      fingerprint: 'ogong-1',
      data: {
        car_number: '68로3197',
        model: '아이오닉5',
        product_type: '오공구독',
        provider_company_code: 'RP012',
        price: { '36': { rent: 790000, deposit: '' } }
      }
    });

    expect(candidate.commercialType).toBe('OGONG_SUBSCRIPTION');
    expect(candidate.commercialType).not.toBe('USED_SUBSCRIPTION');
  });
});
