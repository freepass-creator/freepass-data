import { describe, expect, it } from 'vitest';
import { normalizePrice, priceDigest, priceMatchesRecord } from '../src/infra/source-cycle-firestore.js';
import { stableDigest } from '../src/shared/stable-digest.js';

describe('가격 맵 정규화', () => {
  const withNull = { '12': { rent: 500000, deposit: 0, mileage: null } };
  const missing = { '12': { deposit: 0, rent: 500000 } };
  it('null·undefined·키 누락·키 순서가 같은 digest', () => {
    expect(priceDigest(withNull)).toBe(priceDigest(missing));
    expect(priceDigest({ '12': { rent: 1, mileage: undefined } })).toBe(priceDigest({ '12': { rent: 1 } }));
    expect(priceDigest(undefined)).toBe(stableDigest({}));
  });
  it('실제 값이 다르면 digest 도 다르다', () => {
    expect(priceDigest({ '12': { rent: 1, mileage: '2만' } })).not.toBe(priceDigest({ '12': { rent: 1 } }));
    expect(normalizePrice(withNull)).toEqual({ '12': { deposit: 0, rent: 500000 } });
  });
  it('저장 digest 가 mileage 포함 terms 기준이고 현재 price 가 mileage 만 빠졌으면 통과, 금액 변경은 DRIFT', () => {
    const rec: any = { terms: [{ months: 48, monthlyRent: { value: 790000 }, deposit: { value: 0 }, mileage: '3만km' }] };
    const stored = stableDigest({ '48': { rent: 790000, deposit: 0, mileage: '3만km' } });
    expect(priceMatchesRecord({ '48': { rent: 790000, deposit: 0 } }, stored, rec)).toBe(true);
    expect(priceMatchesRecord({ '48': { rent: 790000, deposit: 0, mileage: null } }, stored, rec)).toBe(true);
    expect(priceMatchesRecord({ '48': { rent: 700000, deposit: 0 } }, stored, rec)).toBe(false);
  });
});
