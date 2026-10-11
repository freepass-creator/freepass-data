import { describe, expect, it } from 'vitest';
import type { EntityMeta, Offer, Product, TermEconomicAmount, VehicleAsset, VehicleModel } from '../src/domain/catalog.js';
import { buildTrustScorecard, type TrustScorecardInput } from '../src/application/trust-scorecard.js';

const readAt = '2026-10-10T00:00:00.000Z';
const meta = (id: string): EntityMeta => ({
  schemaVersion: 'test',
  revision: 1,
  validationStatus: 'VALID',
  createdAt: readAt,
  updatedAt: readAt,
  createdBy: { id: 'TEST', kind: 'SERVICE' },
  updatedBy: { id: 'TEST', kind: 'SERVICE' },
  lineageId: `lin-${id}`,
});
const money = (amount: number) => ({ amount, currency: 'KRW' as const });
const fee = (state: TermEconomicAmount['state'], amount = 0): TermEconomicAmount => ({
  state,
  amount: state === 'UNKNOWN' ? null : money(amount),
  sourceRefs: state === 'UNKNOWN' ? [] : ['TEST-FAKE-SOURCE'],
  reasonCode: state === 'UNKNOWN' ? 'TEST_UNKNOWN' : null,
});
const model = (id: string): VehicleModel => ({ ...meta(id), id, maker: '현대', model: '아반떼', displayName: '아반떼', subModel: 'CN7', trim: '프리미엄', fuel: '가솔린' });
const asset = (id: string): VehicleAsset => ({ ...meta(id), id, vehicleModelId: 'm1', status: 'AVAILABLE', plateNumber: `TEST-FAKE-${id}` });
const product = (id: string, assetId: string): Product => ({ ...meta(id), id, vehicleModelId: 'm1', vehicleAssetId: assetId, commercialType: 'USED_RENT', status: 'ACTIVE', displayName: id });
const offer = (id: string, productId: string, confirmed = true): Offer => ({
  ...meta(id),
  id,
  productId,
  supplierId: 'RP999',
  status: 'ACTIVE',
  priceTerms: [{ termKey: '36', termMonths: 36, monthlyRent: money(500000), deposit: money(1000000), depositState: 'KNOWN' }],
  internalEconomicsTerms: confirmed ? [{
    termKey: '36',
    termMonths: 36,
    supplierBillingFee: fee('KNOWN', 100000),
    channelPayoutFee: fee('ZERO', 0),
    depositCalculation: fee('KNOWN', 1000000),
  }] : [{
    termKey: '36',
    termMonths: 36,
    supplierBillingFee: fee('UNKNOWN'),
    channelPayoutFee: fee('ZERO', 0),
    depositCalculation: fee('KNOWN', 1000000),
  }],
});

function input(): TrustScorecardInput {
  return {
    readAt,
    legacyProducts: {
      'TEST-FAKE-PASS': {
        _key: 'TEST-FAKE-PASS', listable: true, maker: '현대', model: '아반떼', sub_model: 'CN7', trim_name: '프리미엄', fuel_type: '가솔린', engine_cc: '1598',
        vehicle_status: '즉시출고', status_kind: '가용', photo_link: 'https://example.test/photo.jpg',
        price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } },
      },
      'TEST-FAKE-DEPOSIT': {
        _key: 'TEST-FAKE-DEPOSIT', listable: true, maker: '현대', model: '아반떼', sub_model: 'CN7', trim_name: '프리미엄', fuel_type: '가솔린', engine_cc: '1598',
        vehicle_status: '즉시출고', status_kind: '가용', image_urls: ['https://example.test/2.jpg'],
        price: { '36': { rent: 500000, deposit: null, depositState: 'UNKNOWN' } },
      },
      'TEST-FAKE-NAME': {
        _key: 'TEST-FAKE-NAME', listable: true, maker: '현대', model: '아반떼', sub_model: 'BAD', trim_name: '프리미엄', fuel_type: '가솔린', engine_cc: '1598',
        vehicle_status: '즉시출고', status_kind: '가용', photo_link: 'https://example.test/3.jpg',
        price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } },
      },
      'TEST-FAKE-OLD': {
        _key: 'TEST-FAKE-OLD', listable: false, maker: '현대', model: '아반떼', sub_model: 'CN7',
        price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } },
      },
    },
    legacyVehicleMasterRows: [{ id: 'TEST-FAKE-MASTER', maker: '현대', model: '아반떼', subModel: 'CN7' }],
    vehicleReferenceRows: [{ maker: '현대', model: '아반떼', subModel: 'CN7' }],
    canonical: {
      vehicleModels: [model('m1')],
      vehicleAssets: [asset('a1'), asset('a2'), asset('a3')],
      products: [product('TEST-FAKE-PASS', 'a1'), product('TEST-FAKE-DEPOSIT', 'a2'), product('TEST-FAKE-NAME', 'a3')],
      offers: [offer('o1', 'TEST-FAKE-PASS'), offer('o2', 'TEST-FAKE-DEPOSIT'), offer('o3', 'TEST-FAKE-NAME', false)],
    },
    sourceFreshness: [
      { sourceId: 'TEST-FAKE-FRESH', expectedFreshnessSeconds: 60, observedAt: '2026-10-09T23:59:00.000Z' },
      { sourceId: 'TEST-FAKE-STALE', expectedFreshnessSeconds: 60, observedAt: '2026-10-09T23:57:00.000Z' },
    ],
  };
}

const helpers = {
  withCompatibilityDepositEvidence: (product: Record<string, unknown>) => ({ ...product }),
  isPublicIancarPhotoProduct: () => false,
};

describe('buildTrustScorecard', () => {
  it('computes metrics, all-core ratio, and one-item bottlenecks from fake data', () => {
    const { report, publicSummary } = buildTrustScorecard(input(), helpers);
    expect(report.metrics.map((m) => [m.id, m.numerator, m.denominator])).toEqual([
      ['vehicle-name-spec-confirmed', 2, 3],
      ['deposit-confirmed', 2, 3],
      ['period-rent-fee-confirmed', 2, 3],
      ['photo-present', 3, 3],
      ['source-freshness', 1, 2],
      ['status-consistency', 3, 3],
    ]);
    expect(report.summary.numerator).toBe(1);
    expect(report.summary.denominator).toBe(3);
    expect(report.bottlenecks).toEqual([
      { item: 'vehicleName', count: 0 },
      { item: 'deposit', count: 1 },
      { item: 'economics', count: 0 },
      { item: 'photo', count: 0 },
    ]);
    expect(publicSummary).not.toHaveProperty('vehiclePasses');
    expect(publicSummary.summary).not.toHaveProperty('numerator');
    expect(publicSummary.metrics[0]).not.toHaveProperty('denominator');
    expect(JSON.stringify(publicSummary)).not.toMatch(/TEST-FAKE-PASS|TEST-FAKE-DEPOSIT|TEST-FAKE-NAME/);
  });

  it('is deterministic and does not mutate input', () => {
    const original = input();
    const before = JSON.stringify(original);
    const a = buildTrustScorecard(original, helpers).report;
    const b = buildTrustScorecard(original, helpers).report;
    expect(a.digest).toBe(b.digest);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('keeps vehicle identifiers out of report rows by hashing only', () => {
    const { report } = buildTrustScorecard(input(), helpers);
    const printed = JSON.stringify(report);
    expect(printed).not.toMatch(/TEST-FAKE-PASS|TEST-FAKE-DEPOSIT|TEST-FAKE-NAME/);
    expect(report.vehiclePasses.every((row) => /^[a-f0-9]{16}$/.test(row.hash))).toBe(true);
  });

  it('does not confirm fees from inactive or expired historical offers when the current offer is unconfirmed', () => {
    const fixture = input();
    fixture.legacyProducts = {
      'TEST-FAKE-PASS': fixture.legacyProducts['TEST-FAKE-PASS']!,
    };
    fixture.canonical.products = [product('TEST-FAKE-PASS', 'a1')];
    fixture.canonical.offers = [
      { ...offer('old-inactive', 'TEST-FAKE-PASS', true), status: 'EXPIRED', validUntil: '2026-10-09T23:59:59.000Z' },
      offer('current-unconfirmed', 'TEST-FAKE-PASS', false),
    ];

    const economics = buildTrustScorecard(fixture, helpers).report.metrics.find((m) => m.id === 'period-rent-fee-confirmed')!;
    expect(economics.numerator).toBe(0);
    expect(economics.denominator).toBe(1);
  });

  it('does not confirm current offer fees when the current product price row monthly rent differs', () => {
    const fixture = input();
    fixture.legacyProducts = {
      'TEST-FAKE-PASS': {
        ...fixture.legacyProducts['TEST-FAKE-PASS']!,
        price: { '36': { rent: 510000, deposit: 1000000, depositState: 'KNOWN' } },
      },
    };
    fixture.canonical.products = [product('TEST-FAKE-PASS', 'a1')];
    fixture.canonical.offers = [offer('current-confirmed', 'TEST-FAKE-PASS', true)];

    const economics = buildTrustScorecard(fixture, helpers).report.metrics.find((m) => m.id === 'period-rent-fee-confirmed')!;
    expect(economics.numerator).toBe(0);
    expect(economics.denominator).toBe(1);
  });

  it('confirms fees only from one active effective offer matching the current product price row', () => {
    const fixture = input();
    fixture.legacyProducts = {
      'TEST-FAKE-PASS': fixture.legacyProducts['TEST-FAKE-PASS']!,
    };
    fixture.canonical.products = [product('TEST-FAKE-PASS', 'a1')];
    fixture.canonical.offers = [{
      ...offer('current-confirmed', 'TEST-FAKE-PASS', true),
      validFrom: '2026-10-09T00:00:00.000Z',
      validUntil: '2026-10-11T00:00:00.000Z',
    }];

    const economics = buildTrustScorecard(fixture, helpers).report.metrics.find((m) => m.id === 'period-rent-fee-confirmed')!;
    expect(economics.numerator).toBe(1);
    expect(economics.denominator).toBe(1);
  });
});
