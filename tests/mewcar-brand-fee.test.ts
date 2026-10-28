import { describe, expect, it } from 'vitest';
import { buildKakaoCatalogReferenceProduct, mewcarBrandClassFromSource, resolveSalesCommission } from '../src/application/kakao-catalog-reference.js';
import { planPayoutFeeSnapshots } from '../src/application/payout-fee-snapshot.js';

// 대표 10-28 «뮤카 테슬라 수수료 150만원 … 프로모션 차종은 150이야» — 차종 구분은 gnafit latestBrandPolicy 와 같은 갈래, 상품 칸에서만 읽는다.
describe('뮤카 선납 GA 정액 차종 구분(대표 10-28)', () => {
  it.each([
    [{ maker: '현대', origin: '국산', model: '아반떼' }, 'DOMESTIC'],
    [{ maker: '쉐보레', origin: '국산', model: '트레일블레이저' }, 'DOMESTIC'],
    [{ maker: '기아', origin: '국산', model: '카니발', sub_model: '카니발 KA4' }, 'DOMESTIC'],
    [{ maker: '제네시스', origin: '국산', model: 'GV80' }, 'PREMIUM'],
    [{ maker: '제네시스', model: 'G80' }, 'PREMIUM'],
    [{ maker: '테슬라', origin: '수입', model: '모델 Y' }, 'PREMIUM'],
    [{ maker: 'Tesla', model: 'Model 3' }, 'PREMIUM'],
    [{ maker: 'BMW', origin: '수입', model: '5시리즈' }, 'PREMIUM'],
    [{ maker: '쉐보레', origin: '수입', model: '콜로라도' }, 'PREMIUM'],
    [{ maker: '기아', origin: '국산', model: '카니발', sub_model: '카니발 하이리무진 KA4', trim_name: '시그니처' }, 'PREMIUM'],
    [{ maker: '기아', origin: '국산', model: '카니발', sub_model: '더 뉴 카니발', trim_name: '하이리무진' }, 'PREMIUM'],
    [{ maker: '기아', origin: '국산', car_name: '카니발 하이리무진 9인승' }, 'PREMIUM'],
    [{ maker: '르노코리아', origin: '수입', model: '마스터' }, 'PREMIUM'],
  ])('%o → %s', (source, expected) => {
    expect(mewcarBrandClassFromSource(source)).toBe(expected);
  });

  it.each([
    [{ maker: '현대', model: '아반떼' }, 'origin 칸 없음'],
    [{ maker: 'BMW', model: 'X5' }, 'origin 칸 없음(수입사여도 추정 안 함)'],
    [{ maker: '', origin: '국산', model: '그랜저' }, 'maker 없음(제네시스일 수 있음)'],
    [{ maker: '현대', origin: '수입', model: '아반떼' }, 'maker 국산 전용인데 origin 수입'],
    [{ maker: '테슬라', origin: '국산', model: '모델 Y' }, '테슬라인데 origin 국산'],
    [{ maker: '제네시스', origin: '수입', model: 'G80' }, '제네시스인데 origin 수입'],
    [{ maker: '기아', origin: '국산', model: '카니발', sub_model: '카니발 KA4', car_name: '카니발 하이리무진' }, '세부모델과 차명이 하이리무진 여부에서 어긋남'],
    [{ maker: 'BMW', origin: '국산', model: '5시리즈' }, '수입 제조사인데 origin 국산'],
    [{ maker: '기아', origin: '국산' }, '차명이 없어 카니발 하이리무진인지 모름'],
    [{ maker: '현대', origin: '해외', model: '아반떼' }, 'origin 값이 국산/수입이 아님'],
    [{ maker: '테슬라', origin: '미확인', model: '모델 3' }, '테슬라인데 origin 이 알 수 없는 값'],
    [{ maker: '기아', origin: '국산', model: '쏘렌토', sub_model: '카니발 하이리무진' }, '모델과 세부모델이 다른 차'],
  ])('%o → 구분 안 함(%s)', (source, _why) => {
    expect(mewcarBrandClassFromSource(source)).toBeUndefined();
  });

  it('원천 투영 경로: 상품 칸으로 구분하고, 증거 입력이 따로 넘긴 구분은 쓰지 않는다', () => {
    const product = (over: Record<string, unknown>) => ({ listable: true, provider_company_code: 'RP035', product_type: '구독',
      car_number: '12가3456', price: { '36': { rent: 700000 } }, ...over });
    const evidence = { '36': { depositPayment: 'PREPAID' as const, extraDeposit: 0 } };
    const payout = (over: Record<string, unknown>, ev: Record<string, unknown> = evidence) =>
      buildKakaoCatalogReferenceProduct('synthetic', product(over), ev as never)!.offers[0]!.priceTerms[0]!.channelPayoutFee;
    expect(payout({ maker: '테슬라', origin: '수입', model: '모델 Y' })).toMatchObject({ state: 'CALCULATED', amount: 1500000, ruleId: 'MEWCAR_GA_PREPAID_PREMIUM_36_PAYOUT' });
    expect(payout({ maker: '현대', origin: '국산', model: '아반떼' })).toMatchObject({ state: 'CALCULATED', amount: 1200000 });
    expect(payout({ maker: '현대', model: '아반떼' })).toMatchObject({ state: 'UNKNOWN', reasonCode: 'MEWCAR_BRAND_CLASS_REQUIRED' });
    expect(payout({ maker: '현대', model: '아반떼' }, { '36': { ...evidence['36'], mewcarBrandClass: 'PREMIUM' } }))
      .toMatchObject({ state: 'UNKNOWN', reasonCode: 'MEWCAR_BRAND_CLASS_REQUIRED' });
  });

  it('지급 계획(쓰기 0) 경로도 같은 구분 — 구분 없는 차는 UNKNOWN, 분납(옛 계약)은 구분 없이 옛 정액', () => {
    const product = (over: Record<string, unknown>) => ({ provider_company_code: 'RP035', product_type: '구독', fuel_type: '전기', listable: true,
      car_number: 'TEST-RP035', price: { '24': { rent: 900000, deposit: 1000000 } }, ...over });
    const run = (over: Record<string, unknown>, depositPayment: 'PREPAID' | 'INSTALLMENT' = 'PREPAID') =>
      planPayoutFeeSnapshots({ snapshotDate: '2026-10-28', products: { mew: product(over) }, policies: {},
        evidence: [{ productId: 'mew', confidence: 'high', depositPayment, extraDeposit: 1000000,
          ...(depositPayment === 'INSTALLMENT' ? { contractDate: '2026-10-01' } : {}) }] }).documents[0]!.terms[0]!;
    expect(run({ maker: '테슬라', origin: '수입' })).toMatchObject({ state: 'KNOWN', amount: 1600000, ruleId: 'MEWCAR_GA_PREPAID_PREMIUM_24_PAYOUT' });
    expect(run({ maker: '기아', origin: '국산', model: '레이' })).toMatchObject({ state: 'KNOWN', amount: 1300000 });
    expect(run({ maker: '기아', model: '레이' })).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: 'MEWCAR_BRAND_CLASS_REQUIRED' });
    expect(run({ maker: '기아', model: '레이' }, 'INSTALLMENT')).toMatchObject({ state: 'KNOWN', amount: 1100000, ruleId: 'MEWCAR_GA_INSTALLMENT_24_PAYOUT' });
  });

  it('분납(10-05 폐지 전 계약)은 옛 값 그대로 — 차종 구분 없음, 추가보증금 상한 40만', () => {
    expect(resolveSalesCommission({ supplierId: 'RP035', productType: '구독', termMonths: 36, monthlyRent: 700000,
      depositPayment: 'INSTALLMENT', extraDeposit: 9000000, contractDate: '2026-09-30' })).toMatchObject({ state: 'CALCULATED', amount: 1400000 });
  });
});
