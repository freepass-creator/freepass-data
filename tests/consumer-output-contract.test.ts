import { describe, expect, it } from 'vitest';
import {
  F86_OUTPUT_CONTRACT,
  SONOKONG_DEPOSIT_RULE_TEXT,
  classifySonokongRecord,
  hasSonokongDepositRuleViolation,
  validateF86FeeColumns
} from '../src/domain/consumer-output-contract.js';

describe('consumer output contracts', () => {
  it('separates Sonogong products from TCar pickup subscription', () => {
    const rent = classifySonokongRecord({ bucket: 'SON_NO_KONG', plateNumber: '123하4567' });
    const subscription = classifySonokongRecord({ bucket: 'SON_NO_KONG', plateNumber: '123가4567' });
    const pickup = classifySonokongRecord({ bucket: 'TCAR_EXTERNAL', plateNumber: '123나4567' });

    expect([rent, subscription, pickup].map((item) => item.supplierGroup)).toEqual([
      'SONOKONG', 'SONOKONG', 'SONOKONG'
    ]);
    expect([rent, subscription, pickup].map((item) => item.outputGroup)).toEqual([
      'SONOGONG_PRODUCTS', 'SONOGONG_PRODUCTS', 'PICKUP_SUBSCRIPTION'
    ]);
    expect(rent.status === 'CLASSIFIED' && rent.commercialType).toBe('USED_RENT');
    expect(subscription.status === 'CLASSIFIED' && subscription.commercialType).toBe('OGONG_SUBSCRIPTION');
    expect(pickup.status === 'CLASSIFIED' && pickup.commercialType).toBe('PICKUP_SUBSCRIPTION');
  });

  it('holds an unknown bucket or a missing plate instead of guessing', () => {
    expect(classifySonokongRecord({ bucket: 'UNKNOWN', plateNumber: '123하4567' })).toMatchObject({
      status: 'HOLD', outputGroup: 'HOLD', reason: 'UNKNOWN_SONOKONG_BUCKET'
    });
    expect(classifySonokongRecord({ bucket: 'SON_NO_KONG' })).toMatchObject({
      status: 'HOLD', outputGroup: 'HOLD', reason: 'MISSING_PLATE_FOR_RENT_DECISION'
    });
  });

  it('locks F86 to the retro supplier view and long-term fee columns', () => {
    expect(F86_OUTPUT_CONTRACT).toMatchObject({
      owner: 'freepass-data',
      presentation: 'RETRO',
      groupBy: 'SUPPLIER',
      minimumLongTermMonths: 24
    });
    expect(validateF86FeeColumns(F86_OUTPUT_CONTRACT.commonFeeColumns)).toEqual({
      status: 'PASS', violations: []
    });
    expect(validateF86FeeColumns(F86_OUTPUT_CONTRACT.supplierFeeColumns.RP012)).toEqual({
      status: 'PASS', violations: []
    });
    expect(validateF86FeeColumns(F86_OUTPUT_CONTRACT.supplierFeeColumns.RP023)).toEqual({
      status: 'PASS', violations: []
    });
  });

  it('owns the Sonokong deposit rule and blocks stale numeric deposits', () => {
    expect(SONOKONG_DEPOSIT_RULE_TEXT).toBe('월 대여료 × 약정연수 (최대 3개월)');
    expect(hasSonokongDepositRuleViolation({
      depositNote: SONOKONG_DEPOSIT_RULE_TEXT,
      productType: '오공구독',
      price: { '24': { deposit: 1 } }
    })).toBe(true);
    expect(hasSonokongDepositRuleViolation({
      depositNote: SONOKONG_DEPOSIT_RULE_TEXT,
      productType: '오공구독',
      price: { '24': { deposit: 0 } }
    })).toBe(false);
    expect(hasSonokongDepositRuleViolation({
      depositNote: SONOKONG_DEPOSIT_RULE_TEXT,
      productType: '중고렌트',
      price: { '24': { deposit: 1000000 } }
    })).toBe(false);
    expect(hasSonokongDepositRuleViolation({
      depositNote: '무보증',
      productType: '오공구독',
      price: { '24': { deposit: 1000000 } }
    })).toBe(false);
  });

  it('blocks short-term exceptions from F86, including supplier-specific columns', () => {
    expect(validateF86FeeColumns([
      '1개월', '6개월', '12개월', '12개월 반납형', '18개월 2만km', '24개월'
    ])).toEqual({
      status: 'HOLD',
      violations: [
        { column: '1개월', reason: 'F86_LONG_TERM_ONLY' },
        { column: '6개월', reason: 'F86_LONG_TERM_ONLY' },
        { column: '12개월', reason: 'F86_LONG_TERM_ONLY' },
        { column: '12개월 반납형', reason: 'F86_LONG_TERM_ONLY' },
        { column: '18개월 2만km', reason: 'F86_LONG_TERM_ONLY' }
      ]
    });
  });
});
