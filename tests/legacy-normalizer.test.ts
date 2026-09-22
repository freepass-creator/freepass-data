import { describe, expect, it } from 'vitest';
import { normalizeLegacyProduct } from '../src/adapters/legacy-normalizer.js';

describe('legacy product normalizer', () => {
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
