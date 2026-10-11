import { describe, expect, it } from 'vitest';
import { normalizeLedgerDepositEvidence, planPeriodFeeLedger } from '../src/application/period-fee-ledger-plan.js';
import { pickLedgerRowForContract } from '../src/application/contract-fee-link.js';
import { buildPeriodFeeLedgerJobPlan } from '../src/jobs/plan-period-fee-ledger.js';
import publicProductFeedSchema from '../contracts/public-product-feed-v1.schema.json' with { type: 'json' };
import { FIRESTORE_COLLECTIONS } from '../src/infra/firestore-layout.js';

const observedAt = '2026-10-12T00:00:00.000Z';
const snapshotId = 'period-fee-2026-10-12';
const clock = () => new Date(observedAt);

const product = (overrides: Record<string, unknown> = {}) => ({
  provider_company_code: 'RP013',
  provider_name: 'TEST-FAKE-SUPPLIER',
  vehicle_uid: 'TEST-FAKE-ASSET-001',
  car_number: 'TEST-FAKE-PLATE-0001',
  product_type: '중고렌트',
  fuel_type: '가솔린',
  vehicle_status: '출고불가',
  status: '대기',
  status_kind: 'HOLD',
  listable: false,
  updateTime: '2026-10-11T00:00:00.000Z',
  price: {
    '36': { rent: 800000, deposit: 1000000 },
  },
  ...overrides,
});

const sonokongPickup = (overrides: Record<string, unknown> = {}) => product({
  provider_company_code: 'RP012',
  provider_name: '손오공',
  product_type: '픽업 구독',
  price: {
    '36': { rent: 800000, deposit: 1000000 },
  },
  ...overrides,
});

describe('period fee ledger planner', () => {
  it('plans every priced product regardless of status and excludes unpriced products', () => {
    const plan = planPeriodFeeLedger({
      products: {
        priced: product(),
        unpriced: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', price: {} }),
      },
      policies: {},
      referenceInputs: {},
    }, { clock });

    expect(plan.summary.totalProducts).toBe(2);
    expect(plan.summary.productsWithPriceRows).toBe(1);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      valueBasis: 'CURRENT_AT_SNAPSHOT',
      valueAsOf: '2026-10-12',
      vehicleUid: 'TEST-FAKE-ASSET-001',
      applyState: 'READY',
      holdReasonCode: null,
      termMonths: 36,
      monthlyRent: { amount: 800000, state: 'KNOWN' },
    });
    expect(JSON.stringify(plan.rows[0])).not.toContain('출고불가');
  });

  it('preserves UNKNOWN commission reasons and does not fill missing fees with zero', () => {
    const plan = planPeriodFeeLedger({
      products: { unknown: product({ provider_company_code: 'XX-9999' }) },
      policies: {},
      referenceInputs: {},
    }, { clock });

    expect(plan.rows[0]!.supplierBillingFee).toMatchObject({ state: 'UNKNOWN', amount: null });
    expect(plan.rows[0]!.channelPayoutFee).toMatchObject({ state: 'UNKNOWN', amount: null });
    expect(Object.keys(plan.summary.reasonCounts).length).toBeGreaterThan(0);
  });

  it('uses confirmed supplier raw vehicle value evidence for Sonokong pickup fees', () => {
    const plan = planPeriodFeeLedger({
      products: { confirmed: sonokongPickup({ '원문': { '차량가격': '31,240,000' }, consumer_price: 31000000 }) },
      policies: {},
      referenceInputs: {},
    }, { clock });

    expect(plan.rows[0]).toMatchObject({
      vehicleValueEvidence: {
        grade: 'CONFIRMED',
        source: 'SUPPLIER_RAW',
        amount: 31240000,
        differenceAmount: 240000,
      },
      supplierBillingFee: { state: 'CALCULATED', amount: { amount: 1249600, currency: 'KRW' } },
      channelPayoutFee: { state: 'CALCULATED', amount: { amount: 937200, currency: 'KRW' } },
    });
    expect(plan.summary.approxCount).toEqual({ supplierBillingFee: 0, channelPayoutFee: 0 });
  });

  it('marks consumer_price and exact new_car_trim matches as approximate fee calculations', () => {
    const consumer = planPeriodFeeLedger({
      products: { approx: sonokongPickup({ consumer_price: 30000000 }) },
      policies: {},
      referenceInputs: {},
    }, { clock });
    expect(consumer.rows[0]).toMatchObject({
      vehicleValueEvidence: { grade: 'APPROX', source: 'CONSUMER_PRICE', amount: 30000000 },
      supplierBillingFee: { state: 'CALCULATED_APPROX', amount: { amount: 1200000, currency: 'KRW' } },
      channelPayoutFee: { state: 'CALCULATED_APPROX', amount: { amount: 900000, currency: 'KRW' } },
    });
    expect(consumer.summary.approxCount).toEqual({ supplierBillingFee: 1, channelPayoutFee: 1 });
    expect(consumer.summary.feeStates.supplierBillingFee).toMatchObject({ CALCULATED: 0, CALCULATED_APPROX: 1 });

    const trim = planPeriodFeeLedger({
      products: { trimMatch: sonokongPickup({ trimKey: 'trim-1' }) },
      policies: {},
      newCarTrim: { t1: { trimKey: 'trim-1', consumer_price: 29000000 } },
      referenceInputs: {},
    }, { clock });
    expect(trim.rows[0]).toMatchObject({
      vehicleValueEvidence: { grade: 'APPROX', source: 'NEW_CAR_TRIM', amount: 29000000 },
      supplierBillingFee: { state: 'CALCULATED_APPROX', amount: { amount: 1160000, currency: 'KRW' } },
    });
  });

  it('keeps Sonokong vehicle value UNKNOWN for missing, zero, invalid, negative, and ambiguous trim evidence', () => {
    const cases = {
      missing: sonokongPickup(),
      zeroRaw: sonokongPickup({ '원문': { '차량가격': '0' }, consumer_price: 0 }),
      decimalRaw: sonokongPickup({ '원문': { '차량가격': '3000.5' } }),
      negativeConsumer: sonokongPickup({ consumer_price: -30000000 }),
      ambiguousTrim: sonokongPickup({ trimKey: 'trim-ambiguous' }),
    };
    const plan = planPeriodFeeLedger({
      products: cases,
      policies: {},
      newCarTrim: [{ trimKey: 'trim-ambiguous', consumer_price: 30000000 }, { trimKey: 'trim-ambiguous', consumer_price: 31000000 }],
      referenceInputs: {},
    }, { clock });

    expect(plan.rows).toHaveLength(5);
    expect(plan.rows.every(row => row.vehicleValueEvidence === null)).toBe(true);
    expect(plan.rows.every(row => row.supplierBillingFee.state === 'UNKNOWN' && row.supplierBillingFee.amount === null)).toBe(true);
    expect(plan.rows.every(row => row.channelPayoutFee.reasonCode === 'VEHICLE_VALUE_REQUIRED')).toBe(true);
    expect(plan.summary.reasonCounts.VEHICLE_VALUE_REQUIRED).toBe(10);
  });

  it('does not change other suppliers by passing vehicle value evidence', () => {
    const withoutEvidence = planPeriodFeeLedger({
      products: { other: product({ provider_company_code: 'RP013', consumer_price: 30000000 }) },
      policies: {},
      newCarTrim: { t1: { trimKey: 'trim-1', consumer_price: 29000000 } },
      referenceInputs: {},
    }, { clock });

    expect(withoutEvidence.rows[0]).toMatchObject({
      vehicleValueEvidence: null,
      supplierBillingFee: { state: 'CALCULATED', amount: { amount: 1080000, currency: 'KRW' } },
      channelPayoutFee: { state: 'CALCULATED', amount: { amount: 864000, currency: 'KRW' } },
    });
    expect(withoutEvidence.summary.approxCount).toEqual({ supplierBillingFee: 0, channelPayoutFee: 0 });
  });

  it('carries SOURCE_AMOUNT deposit evidence for positive source deposits', () => {
    const plan = planPeriodFeeLedger({
      products: { sourceAmount: product({ price: { '36': { rent: 800000, deposit: 1000000 } } }) },
      policies: {},
      referenceInputs: {},
    }, { clock });

    expect(plan.rows[0]!.deposit).toMatchObject({
      state: 'KNOWN',
      amount: { amount: 1000000, currency: 'KRW' },
      depositEvidence: {
        kind: 'SOURCE_AMOUNT',
        ruleCode: 'SOURCE_AMOUNT',
        sourcePriceKey: '36',
        calculationBasis: '원천 금액',
      },
    });
    expect(plan.summary.depositEvidenceKinds.SOURCE_AMOUNT).toBe(1);
  });

  it('carries SUPPLIER_RULE_NOTE deposit evidence for compatible rule-note deposits', () => {
    const plan = planPeriodFeeLedger({
      products: { ruleNote: product({
        provider_company_code: 'RP023',
        product_type: '오플구독',
        deposit_note: '국산: 월 대여료×2',
        price: { '36': { rent: 800000, deposit: 0 } },
      }) },
      policies: {},
      referenceInputs: {},
    }, { clock });

    expect(plan.rows[0]!.deposit).toMatchObject({
      state: 'KNOWN',
      amount: { amount: 1600000, currency: 'KRW' },
      depositEvidence: {
        kind: 'SUPPLIER_RULE_NOTE',
        ruleCode: 'RENT_X_2',
        noteField: 'deposit_note',
        noteText: '국산: 월 대여료×2',
        sourcePriceKey: '36',
        calculationBasis: '월 대여료×2',
      },
    });
    expect(plan.summary.depositEvidenceKinds.SUPPLIER_RULE_NOTE).toBe(1);
  });

  it('downgrades virtual KNOWN deposits without policy evidence to UNKNOWN', () => {
    const result = normalizeLedgerDepositEvidence({
      state: 'KNOWN',
      amount: { amount: 1230000, currency: 'KRW' },
      term: { depositEvidence: { sourceAmount: 0, reasonCode: null } },
      rawProduct: {},
      sourcePriceKey: '36',
    });

    expect(result).toMatchObject({
      state: 'UNKNOWN',
      reasonCode: 'DEPOSIT_POLICY_EVIDENCE_REQUIRED',
      evidence: { kind: 'UNKNOWN', sourcePriceKey: '36' },
    });
  });

  it('carries VERIFIED_ZERO_TEXT evidence for text-proven zero deposits', () => {
    const plan = planPeriodFeeLedger({
      products: { zeroText: product({
        deposit_note: '무보증',
        price: { '36': { rent: 800000, deposit: 0 } },
      }) },
      policies: {},
      referenceInputs: {},
    }, { clock });

    expect(plan.rows[0]!.deposit).toMatchObject({
      state: 'ZERO',
      amount: { amount: 0, currency: 'KRW' },
      depositEvidence: {
        kind: 'VERIFIED_ZERO_TEXT',
        ruleCode: 'ZERO_DEPOSIT',
        noteField: 'deposit_note',
        noteText: '무보증',
        sourcePriceKey: '36',
      },
    });
    expect(plan.summary.depositEvidenceKinds.VERIFIED_ZERO_TEXT).toBe(1);
  });

  it('marks rows without UID as plan-only HOLD_NO_UID', () => {
    const plan = planPeriodFeeLedger({
      products: { noUid: product({ vehicle_uid: undefined, assetId: undefined }) },
      policies: {},
      referenceInputs: {},
    }, { clock });

    expect(plan.summary.uid.missing).toBe(1);
    expect(plan.rows[0]).toMatchObject({ applyState: 'HOLD', holdReasonCode: 'HOLD_NO_UID', vehicleUid: null });
  });

  it('creates no history for the first snapshot and detects status, rent, and deposit changes later', () => {
    const first = planPeriodFeeLedger({
      products: { p1: product() },
      policies: {},
      referenceInputs: {},
    }, { clock });
    expect(first.history).toHaveLength(0);
    expect(first.baselines.productStates['TEST-FAKE-ASSET-001']).toMatchObject({ vehicle_status: '출고불가' });

    const second = planPeriodFeeLedger({
      products: { p1: product({ vehicle_status: '출고가능', price: { '36': { rent: 850000, deposit: 2000000 } } }) },
      policies: {},
      referenceInputs: {},
      previousSnapshot: {
        rows: first.rows,
        productStates: first.baselines.productStates,
      },
    }, { clock });

    expect(second.history.map(row => row.kind).sort()).toEqual(['DEPOSIT', 'RENT', 'STATUS']);
    expect(second.history.some(row => row.fieldPath === 'vehicle_status' && row.before === '출고불가' && row.after === '출고가능')).toBe(true);
  });

  it('is deterministic and does not mutate inputs', () => {
    const products = { p1: product() };
    const before = structuredClone(products);
    const one = planPeriodFeeLedger({ products, policies: {}, referenceInputs: {} }, { clock });
    const two = planPeriodFeeLedger({ products, policies: {}, referenceInputs: {} }, { clock });

    expect(one.planDigest).toBe(two.planDigest);
    expect(products).toEqual(before);
  });

  it('keeps settlement rows and internal ledger collections out of public contracts', () => {
    const publicBody = JSON.stringify(publicProductFeedSchema);
    expect(publicBody).not.toMatch(/period_fee_ledger|period_fee_snapshot_runs|product_change_history/);
    expect(publicBody).not.toMatch(/supplierBillingFee|channelPayoutFee|expectedGrossMargin|priceSourceRefs/);
    expect(FIRESTORE_COLLECTIONS.periodFees).toEqual({
      ledger: 'period_fee_ledger',
      snapshotRuns: 'period_fee_snapshot_runs',
      productChangeHistory: 'product_change_history',
    });
  });

  it('keeps public report and stdout-shaped summary free of plate values', () => {
    const plan = planPeriodFeeLedger({ products: { p1: product() }, policies: {}, referenceInputs: {} }, { clock });
    const stdoutShape = {
      status: 'PLANNED',
      writes: 0,
      snapshotId: plan.snapshotId,
      rows: plan.summary.rows,
      publicReportDigest: 'digest-only',
    };
    expect(JSON.stringify([plan.summary.publicReport, stdoutShape])).not.toContain('TEST-FAKE-PLATE-0001');
    expect(plan.summary.settlementRowsAccessCount).toBe(0);
  });

  it('job planning ignores backdated environment timestamps and uses runtime read time', () => {
    process.env.PERIOD_FEE_LEDGER_OBSERVED_AT = '2020-01-01T00:00:00.000Z';
    process.env.PERIOD_FEE_LEDGER_SNAPSHOT_ID = 'period-fee-2020-01-01';

    const plan = buildPeriodFeeLedgerJobPlan({
      products: { p1: product() },
      policies: {},
      referenceInputs: {},
      previousSnapshot: null,
      observedAt,
    });

    expect(plan.observedAt).toBe(observedAt);
    expect(plan.snapshotId).toBe(snapshotId);
    expect(plan.rows[0]).toMatchObject({ computedAt: observedAt, valueAsOf: '2026-10-12' });
    delete process.env.PERIOD_FEE_LEDGER_OBSERVED_AT;
    delete process.env.PERIOD_FEE_LEDGER_SNAPSHOT_ID;
  });

  it('holds a backdated contract match when no pre-contract snapshot exists', () => {
    const plan = buildPeriodFeeLedgerJobPlan({
      products: { p1: product() },
      policies: {},
      referenceInputs: {},
      previousSnapshot: null,
      observedAt,
    });

    const result = pickLedgerRowForContract({
      rows: plan.rows,
      contractDate: '2020-01-01',
      termMonths: 36,
      monthlyRent: 800000,
      deposit: 1000000,
    });

    expect(result).toMatchObject({ status: 'HOLD', reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE', detail: { candidateCount: 0 } });
  });
});
