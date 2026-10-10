import { describe, expect, it } from 'vitest';
import type {
  ActorRef,
  EntityMeta,
  Offer,
  PriceTerm,
  Product,
  TermEconomicAmount,
  VehicleAsset,
} from '../src/domain/catalog.js';
import {
  readContractFeeLink,
  resolveContractFeeLink,
  type ContractFeeLinkData,
  type ContractFeeLinkInput,
} from '../src/application/contract-fee-link.js';
import type { CatalogStore } from '../src/ports/catalog-store.js';

const actor: ActorRef = { id: 'test', kind: 'SERVICE' };

const meta = (revision = 1): EntityMeta => ({
  schemaVersion: 'test',
  revision,
  validationStatus: 'VALID',
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  createdBy: actor,
  updatedBy: actor,
  lineageId: 'lineage-test',
});

const confirmedFee = (amount: number): TermEconomicAmount => ({
  state: amount === 0 ? 'ZERO' : 'KNOWN',
  amount: { amount, currency: 'KRW' },
  sourceRefs: ['fee-rule-test'],
});

const unknownFee = (reasonCode: string): TermEconomicAmount => ({
  state: 'UNKNOWN',
  reasonCode,
  sourceRefs: [],
});

const asset = (id = 'asset-1', plateNumber = 'TEST-FAKE-001'): VehicleAsset => ({
  ...meta(),
  id,
  vehicleModelId: 'model-1',
  status: 'AVAILABLE',
  plateNumber,
});

const product = (id = 'product-1', vehicleAssetId = 'asset-1'): Product => ({
  ...meta(),
  id,
  vehicleModelId: 'model-1',
  vehicleAssetId,
  commercialType: 'USED_RENT',
  status: 'ACTIVE',
  displayName: 'test product',
});

const priceTerm = (
  termKey: string,
  termMonths: number,
  monthlyRent: number,
  deposit: number | null,
  depositState: PriceTerm['depositState'] = deposit === 0 ? 'ZERO' : 'KNOWN',
): PriceTerm => ({
  termKey,
  termMonths,
  monthlyRent: { amount: monthlyRent, currency: 'KRW' },
  deposit: deposit === null ? null : { amount: deposit, currency: 'KRW' },
  depositState,
});

const offer = (override: Partial<Offer> = {}): Offer => {
  const terms = override.priceTerms ?? [
    priceTerm('m24-return', 24, 700000, 0),
    priceTerm('m24-buyout', 24, 720000, 0),
    priceTerm('m36', 36, 650000, 1000000),
  ];
  return {
    ...meta(7),
    id: 'offer-1',
    productId: 'product-1',
    supplierId: 'RP001',
    status: 'ACTIVE',
    priceTerms: terms,
    internalEconomicsTerms: terms.map((term) => ({
      termKey: term.termKey,
      termMonths: term.termMonths,
      monthlyRent: term.monthlyRent,
      depositCalculation: confirmedFee(term.deposit?.amount ?? 0),
      supplierBillingFee: confirmedFee(100000),
      channelPayoutFee: confirmedFee(50000),
    })),
    ...override,
  };
};

const baseInput = (): ContractFeeLinkInput => ({
  plate: 'TEST-FAKE-001',
  supplierId: 'RP001',
  termMonths: 24,
  monthlyRent: 700000,
  deposit: 0,
});

const baseData = (override: Partial<ContractFeeLinkData> = {}): ContractFeeLinkData => ({
  assets: [asset()],
  products: [product()],
  offers: [offer()],
  ...override,
});

describe('contract fee link', () => {
  it('links a contract row to the matching price term and confirmed internal fees', () => {
    const result = resolveContractFeeLink(baseInput(), baseData());

    expect(result).toMatchObject({
      status: 'LINKED',
      assetId: 'asset-1',
      productId: 'product-1',
      offerId: 'offer-1',
      offerRevision: 7,
      priceTerm: {
        termKey: 'm24-return',
        termMonths: 24,
        monthlyRent: 700000,
        deposit: 0,
        depositState: 'ZERO',
      },
    });
    expect(result.fees?.supplierBillingFee.status).toBe('CONFIRMED');
  });

  it('blocks blank plates and never matches plate-less assets to each other', () => {
    for (const plate of ['', '   ', undefined]) {
      expect(resolveContractFeeLink({ ...baseInput(), plate }, baseData({ assets: [asset('asset-1', '')] })))
        .toMatchObject({ status: 'FAILED', failure: 'NO_PLATE' });
    }
    // 번호 없는 자산(신차 미배정)이 있어도 번호로는 연결되지 않는다.
    expect(resolveContractFeeLink(baseInput(), baseData({ assets: [asset('asset-9', '')] })))
      .toMatchObject({ status: 'FAILED', failure: 'NO_ASSET' });
  });

  it('looks up by vehicle UID (assetId) without a plate, e.g. a new car with no plate yet', () => {
    const result = resolveContractFeeLink({ ...baseInput(), plate: undefined, assetId: 'asset-1' }, baseData({ assets: [asset('asset-1', '')] }));
    expect(result.assetId).toBe('asset-1');
    expect(result.failure).not.toBe('NO_PLATE');
    expect(result.failure).not.toBe('NO_ASSET');
  });

  it.each([
    ['NO_ASSET', baseInput(), baseData({ assets: [] })],
    ['MULTI_ASSET', baseInput(), baseData({ assets: [asset('asset-1'), asset('asset-2')] })],
    ['NO_PRODUCT', baseInput(), baseData({ products: [] })],
    ['MULTI_PRODUCT', baseInput(), baseData({ products: [product('product-1'), product('product-2')] })],
    ['NO_OFFER', baseInput(), baseData({ offers: [] })],
    ['MULTI_OFFER', baseInput(), baseData({ offers: [offer({ id: 'offer-1' }), offer({ id: 'offer-2' })] })],
    ['SUPPLIER_MISMATCH', baseInput(), baseData({ offers: [offer({ supplierId: 'RP999' })] })],
    ['NO_TERM', { ...baseInput(), termMonths: 60 }, baseData()],
    ['MULTI_TERM', baseInput(), baseData({ offers: [offer({ priceTerms: [
      priceTerm('m24-a', 24, 700000, 0),
      priceTerm('m24-b', 24, 700000, 0),
    ] })] })],
  ] as const)('returns %s', (failure, input, data) => {
    const result = resolveContractFeeLink(input, data);
    expect(result.status).toBe('FAILED');
    expect(result.failure).toBe(failure);
  });

  it('returns condition mismatch detail and reference fees without confirming the link', () => {
    const result = resolveContractFeeLink({ ...baseInput(), monthlyRent: 1, deposit: 5 }, baseData());

    expect(result.status).toBe('FAILED');
    expect(result.failure).toBe('CONDITION_MISMATCH');
    expect(result.priceTerm?.termKey).toBe('m24-return');
    expect(result.fees?.supplierBillingFee.status).toBe('CONFIRMED');
    expect(result.detail).toMatchObject({ mismatches: expect.arrayContaining(['rent', 'deposit']) });
  });

  it('reports DEPOSIT_UNKNOWN when deposit comparison is requested against an unknown deposit row', () => {
    const result = resolveContractFeeLink(baseInput(), baseData({ offers: [offer({ priceTerms: [
      priceTerm('m24-unknown', 24, 700000, null, 'UNKNOWN'),
    ] })] }));

    expect(result.status).toBe('FAILED');
    expect(result.failure).toBe('CONDITION_MISMATCH');
    expect(result.detail).toMatchObject({ mismatches: ['DEPOSIT_UNKNOWN'] });
  });

  it('uses monthly rent to distinguish same-month return and buyout variants', () => {
    const result = resolveContractFeeLink({ ...baseInput(), monthlyRent: 720000 }, baseData());

    expect(result.status).toBe('LINKED');
    expect(result.priceTerm?.termKey).toBe('m24-buyout');
  });

  it('compares zero deposit explicitly and keeps an omitted deposit out of matching', () => {
    const zeroResult = resolveContractFeeLink(baseInput(), baseData());
    const omittedDepositResult = resolveContractFeeLink({
      plate: 'TEST-FAKE-001',
      supplierId: 'RP001',
      termMonths: 24,
      monthlyRent: 700000,
    }, baseData({ offers: [offer({ priceTerms: [priceTerm('m24-unknown', 24, 700000, null, 'UNKNOWN')] })] }));

    expect(zeroResult.status).toBe('LINKED');
    expect(zeroResult.priceTerm?.deposit).toBe(0);
    expect(omittedDepositResult.status).toBe('LINKED');
  });

  it('does not mutate input data and normalizes whitespace in plate comparison', () => {
    const input = { ...baseInput(), plate: ' TEST-FAKE- 001 ' };
    const before = JSON.stringify(input);

    const result = resolveContractFeeLink(input, baseData());

    expect(result.status).toBe('LINKED');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('returns FEE_UNCONFIRMED with reason codes when either internal fee is unresolved', () => {
    const result = resolveContractFeeLink(baseInput(), baseData({ offers: [offer({
      internalEconomicsTerms: [{
        termKey: 'm24-return',
        termMonths: 24,
        depositCalculation: confirmedFee(0),
        supplierBillingFee: unknownFee('NO_RULE'),
        channelPayoutFee: confirmedFee(0),
      }],
    })] }));

    expect(result.status).toBe('FEE_UNCONFIRMED');
    expect(result.detail).toEqual({ reasonCodes: ['NO_RULE'] });
  });

  it('read adapter only calls the three catalog list methods', async () => {
    const calls: string[] = [];
    const store = {
      listVehicleAssets: async () => { calls.push('assets'); return baseData().assets; },
      listProducts: async () => { calls.push('products'); return baseData().products; },
      listOffers: async () => { calls.push('offers'); return baseData().offers; },
    } as unknown as CatalogStore;

    const result = await readContractFeeLink(store, baseInput());

    expect(result.status).toBe('LINKED');
    expect(calls.sort()).toEqual(['assets', 'offers', 'products']);
  });
});
