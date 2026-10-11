import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import contractFeeLinksSchema from '../contracts/contract-fee-links-v1.schema.json' with { type: 'json' };
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
  pickLedgerRowForContract,
  readContractFeeLink,
  resolveContractFeeLink,
  type ContractFeeLinkData,
  type ContractFeeLinkInput,
} from '../src/application/contract-fee-link.js';
import type { PeriodFeeLedgerRow } from '../src/application/period-fee-ledger-plan.js';
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

const ledgerRow = (override: Partial<PeriodFeeLedgerRow> = {}): PeriodFeeLedgerRow => ({
  schemaVersion: 'period-fee-ledger/v1',
  snapshotId: 'period-fee-2026-10-09',
  snapshotDateKst: '2026-10-09',
  computedAt: '2026-10-09T00:00:00.000Z',
  valueBasis: 'CURRENT_AT_SNAPSHOT',
  valueAsOf: '2026-10-09',
  engineRevision: 'test',
  sourceDigest: 'digest',
  documentKey: 'doc',
  applyState: 'READY',
  holdReasonCode: null,
  vehicleUid: 'asset-1',
  assetId: 'asset-1',
  plateLookupKey: null,
  plateLast4ForReport: null,
  supplierId: 'RP001',
  productId: 'product-1',
  offerId: 'offer-1',
  offerRevision: 1,
  productUpdateTime: '2026-10-09T00:00:00.000Z',
  termKey: 'm24',
  termMonths: 24,
  monthlyRent: { amount: 700000, currency: 'KRW', state: 'KNOWN', reasonCode: null },
  deposit: { state: 'ZERO', amount: { amount: 0, currency: 'KRW' }, reasonCode: null, sourceRefs: [],
    depositEvidence: { kind: 'VERIFIED_ZERO_TEXT', ruleCode: 'ZERO_DEPOSIT', noteField: 'deposit_note',
      noteText: '무보증', sourcePriceKey: 'm24', calculationBasis: '무보증 문구 근거', policyCode: null } },
  supplierBillingFee: { state: 'CALCULATED', amount: { amount: 100000, currency: 'KRW' }, vatTreatment: 'EXCLUDED', vatAmount: 10000, totalAmount: 110000, reasonCode: null, ruleId: 'rule', policyId: 'policy', sourceRefs: [] },
  channelPayoutFee: { state: 'CALCULATED', amount: { amount: 50000, currency: 'KRW' }, vatTreatment: 'EXCLUDED', vatAmount: 5000, totalAmount: 55000, reasonCode: null, ruleId: 'rule', policyId: 'policy', sourceRefs: [] },
  ruleIds: ['rule'],
  policyIds: ['policy'],
  priceSourceRefs: [],
  inputRefs: { productPath: 'products/p1', offerPath: 'products/p1/offers/o1', priceTermRef: 'products/p1/price/m24', internalEconomicsRef: null },
  ...override,
});

const contractFeeLinksAjv = new Ajv2020({ strict: false });
const addFormats = (addFormatsModule as unknown as { default?: FormatsPlugin }).default ?? addFormatsModule as unknown as FormatsPlugin;
addFormats(contractFeeLinksAjv);
contractFeeLinksAjv.addSchema(contractFeeLinksSchema);
const validateContractFeeLinksResponse = contractFeeLinksAjv.getSchema('https://freepass.teamjpk.com/contracts/contract-fee-links-v1.schema.json#/$defs/response')!;

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

  it('adds ledgerFee for an approximate ledger row without exposing vehicle value amounts', () => {
    const result = resolveContractFeeLink(
      { ...baseInput(), contractDate: '2026-10-10' },
      { ...baseData(), ledgerRows: [ledgerRow({
        valueAsOf: '2026-10-09',
        supplierBillingFee: { state: 'CALCULATED_APPROX', amount: { amount: 90000, currency: 'KRW' }, vatTreatment: 'EXCLUDED', vatAmount: 9000, totalAmount: 99000, reasonCode: 'VEHICLE_VALUE_APPROX', ruleId: 'rule', policyId: 'policy', sourceRefs: [] },
        vehicleValueEvidence: { grade: 'APPROX', source: 'CONSUMER_PRICE', amount: 12345678, differenceAmount: 1000 },
      })] },
    );

    expect(result.ledgerFee).toMatchObject({
      status: 'CONFIRMED',
      snapshotId: 'period-fee-2026-10-09',
      valueAsOf: '2026-10-09',
      supplierBillingFee: { state: 'CALCULATED_APPROX', amount: { amount: 90000, currency: 'KRW' }, reasonCode: 'VEHICLE_VALUE_APPROX' },
      vehicleValueEvidence: { grade: 'APPROX', source: 'CONSUMER_PRICE' },
    });
    expect(result.ledgerFee?.vehicleValueEvidence).not.toHaveProperty('amount');
    expect(result.ledgerFee?.vehicleValueEvidence).not.toHaveProperty('differenceAmount');
    expect(validateContractFeeLinksResponse({ contract: 'contract-fee-links/v1', results: [{ key: 'row', ...result }] })).toBe(true);
  });

  it('adds confirmed ledgerFee for a confirmed ledger row', () => {
    const result = resolveContractFeeLink(
      { ...baseInput(), contractDate: '2026-10-10' },
      { ...baseData(), ledgerRows: [ledgerRow({ vehicleValueEvidence: { grade: 'CONFIRMED', source: 'SUPPLIER_RAW', amount: 20000000 } })] },
    );

    expect(result.ledgerFee).toMatchObject({
      status: 'CONFIRMED',
      supplierBillingFee: { state: 'CALCULATED', amount: { amount: 100000, currency: 'KRW' }, reasonCode: null },
      channelPayoutFee: { state: 'CALCULATED', amount: { amount: 50000, currency: 'KRW' }, reasonCode: null },
      vehicleValueEvidence: { grade: 'CONFIRMED', source: 'SUPPLIER_RAW' },
    });
  });

  it('adds HOLD ledgerFee for a held ledger row without promoting unknown values', () => {
    const result = resolveContractFeeLink(
      { ...baseInput(), contractDate: '2026-10-10' },
      { ...baseData(), ledgerRows: [ledgerRow({
        applyState: 'HOLD',
        holdReasonCode: 'MISSING_VEHICLE_VALUE',
        supplierBillingFee: { state: 'UNKNOWN', amount: null, vatTreatment: null, vatAmount: null, totalAmount: null, reasonCode: 'MISSING_VEHICLE_VALUE', ruleId: null, policyId: null, sourceRefs: [] },
        channelPayoutFee: { state: 'UNKNOWN', amount: null, vatTreatment: null, vatAmount: null, totalAmount: null, reasonCode: 'MISSING_VEHICLE_VALUE', ruleId: null, policyId: null, sourceRefs: [] },
      })] },
    );

    expect(result.ledgerFee).toMatchObject({
      status: 'HOLD',
      reasonCode: 'MISSING_VEHICLE_VALUE',
      supplierBillingFee: { state: 'UNKNOWN', amount: null, reasonCode: 'MISSING_VEHICLE_VALUE' },
      channelPayoutFee: { state: 'UNKNOWN', amount: null, reasonCode: 'MISSING_VEHICLE_VALUE' },
    });
  });

  it('never picks a ledger row of another vehicle or supplier even when rent and deposit match', () => {
    const input = { ...baseInput(), contractDate: '2026-10-10' };
    for (const other of [{ assetId: 'asset-2', vehicleUid: 'asset-2' }, { supplierId: 'RP002' }]) {
      const result = resolveContractFeeLink(input, { ...baseData(), ledgerRows: [ledgerRow(other)] });
      expect(result.ledgerFee).toMatchObject({ status: 'HOLD', reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE' });
    }
    const mixed = resolveContractFeeLink(input, { ...baseData(), ledgerRows: [ledgerRow({ assetId: 'asset-2', vehicleUid: 'asset-2', snapshotId: 'period-fee-2026-10-09b' }), ledgerRow()] });
    expect(mixed.ledgerFee?.status).toBe('CONFIRMED');
    expect(mixed.ledgerFee?.snapshotId).toBe('period-fee-2026-10-09');
  });

  it('omits ledgerFee when ledger rows are absent or contractDate is absent', () => {
    expect(resolveContractFeeLink({ ...baseInput(), contractDate: '2026-10-10' }, baseData()).ledgerFee).toBeUndefined();
    expect(resolveContractFeeLink(baseInput(), { ...baseData(), ledgerRows: [ledgerRow()] }).ledgerFee).toBeUndefined();
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

  it('holds contract ledger selection when only post-contract current snapshots exist', () => {
    const result = pickLedgerRowForContract({
      rows: [ledgerRow({ valueAsOf: '2026-10-11', snapshotId: 'period-fee-2026-10-11' })],
      contractDate: '2026-10-10',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result).toMatchObject({ status: 'HOLD', reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE' });
  });

  it('confirms the latest pre-contract snapshot when rent and deposit match', () => {
    const older = ledgerRow({ valueAsOf: '2026-10-08', snapshotId: 'period-fee-2026-10-08', monthlyRent: { amount: 680000, currency: 'KRW', state: 'KNOWN', reasonCode: null } });
    const latest = ledgerRow({ valueAsOf: '2026-10-10', snapshotId: 'period-fee-2026-10-10' });

    const result = pickLedgerRowForContract({
      rows: [older, latest, ledgerRow({ valueAsOf: '2026-10-11', snapshotId: 'period-fee-2026-10-11' })],
      contractDate: '2026-10-11',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.status === 'CONFIRMED' ? result.row.snapshotId : '').toBe('period-fee-2026-10-10');
  });

  it('holds same-day snapshot values when the contract has only a date', () => {
    const result = pickLedgerRowForContract({
      rows: [ledgerRow({ valueAsOf: '2026-10-10', snapshotId: 'period-fee-2026-10-10' })],
      contractDate: '2026-10-10',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result).toMatchObject({ status: 'HOLD', reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE' });
  });

  it('uses contractAt when the contract timestamp is available', () => {
    const before = ledgerRow({
      valueAsOf: '2026-10-10T01:00:00.000Z',
      computedAt: '2026-10-10T01:00:00.000Z',
      snapshotId: 'period-fee-2026-10-10-before',
    });
    const after = ledgerRow({
      valueAsOf: '2026-10-10T03:00:00.000Z',
      computedAt: '2026-10-10T03:00:00.000Z',
      snapshotId: 'period-fee-2026-10-10-after',
    });

    const result = pickLedgerRowForContract({
      rows: [after, before],
      contractDate: '2026-10-10',
      contractAt: '2026-10-10T02:00:00.000Z',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.status === 'CONFIRMED' ? result.row.snapshotId : '').toBe('period-fee-2026-10-10-before');
  });

  it('holds mixed-offset ledger observations after the exact contract instant', () => {
    const result = pickLedgerRowForContract({
      rows: [ledgerRow({
        valueAsOf: '2026-10-10T03:00:00Z',
        computedAt: '2026-10-10T03:00:00Z',
        snapshotId: 'period-fee-2026-10-10-after',
      })],
      contractDate: '2026-10-10',
      contractAt: '2026-10-10T10:00:00+09:00',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result).toMatchObject({ status: 'HOLD', reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE' });
  });

  it.each([
    '2026-10-10T08:00:00+09:00',
    '2026-10-10T15:00:00+09:00',
    '2026-10-10T23:59:59+09:00',
  ])('holds same KST calendar-day observation %s when contract has only a date', (valueAsOf) => {
    const result = pickLedgerRowForContract({
      rows: [ledgerRow({ valueAsOf, computedAt: valueAsOf, snapshotId: 'period-fee-2026-10-10-same-day' })],
      contractDate: '2026-10-10',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result).toMatchObject({ status: 'HOLD', reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE' });
  });

  it('confirms the previous KST calendar-day observation when contract has only a date', () => {
    const result = pickLedgerRowForContract({
      rows: [ledgerRow({
        valueAsOf: '2026-10-09T23:59:00+09:00',
        computedAt: '2026-10-09T23:59:00+09:00',
        snapshotId: 'period-fee-2026-10-09-before-date',
      })],
      contractDate: '2026-10-10',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.status === 'CONFIRMED' ? result.row.snapshotId : '').toBe('period-fee-2026-10-09-before-date');
  });

  it('confirms date-only previous-day observations when contract has only a date', () => {
    const result = pickLedgerRowForContract({
      rows: [ledgerRow({ valueAsOf: '2026-10-09', snapshotId: 'period-fee-2026-10-09-date-only' })],
      contractDate: '2026-10-10',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.status === 'CONFIRMED' ? result.row.snapshotId : '').toBe('period-fee-2026-10-09-date-only');
  });

  it('holds ledger observations at exactly the contract instant', () => {
    const result = pickLedgerRowForContract({
      rows: [ledgerRow({
        valueAsOf: '2026-10-10T01:00:00Z',
        computedAt: '2026-10-10T01:00:00Z',
        snapshotId: 'period-fee-2026-10-10-same',
      })],
      contractDate: '2026-10-10',
      contractAt: '2026-10-10T10:00:00+09:00',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result).toMatchObject({ status: 'HOLD', reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE' });
  });

  it('confirms mixed-offset ledger observations strictly before the contract instant', () => {
    const result = pickLedgerRowForContract({
      rows: [ledgerRow({
        valueAsOf: '2026-10-10T00:59:59Z',
        computedAt: '2026-10-10T00:59:59Z',
        snapshotId: 'period-fee-2026-10-10-before-offset',
      })],
      contractDate: '2026-10-10',
      contractAt: '2026-10-10T10:00:00+09:00',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.status === 'CONFIRMED' ? result.row.snapshotId : '').toBe('period-fee-2026-10-10-before-offset');
  });

  it('sorts mixed Z and +09:00 observation times by parsed milliseconds and picks the actual latest', () => {
    const olderByInstant = ledgerRow({
      valueAsOf: '2026-10-10T09:30:00+09:00',
      computedAt: '2026-10-10T09:30:00+09:00',
      snapshotId: 'period-fee-2026-10-10-older-kst',
    });
    const latestByInstant = ledgerRow({
      valueAsOf: '2026-10-10T00:45:00Z',
      computedAt: '2026-10-10T00:45:00Z',
      snapshotId: 'period-fee-2026-10-10-latest-z',
    });

    const result = pickLedgerRowForContract({
      rows: [olderByInstant, latestByInstant],
      contractDate: '2026-10-10',
      contractAt: '2026-10-10T10:00:00+09:00',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.status === 'CONFIRMED' ? result.row.snapshotId : '').toBe('period-fee-2026-10-10-latest-z');
  });

  it('holds contract ledger selection when the contract timestamp is invalid', () => {
    const result = pickLedgerRowForContract({
      rows: [ledgerRow({
        valueAsOf: '2026-10-10T00:59:59Z',
        computedAt: '2026-10-10T00:59:59Z',
      })],
      contractDate: '2026-10-10',
      contractAt: 'TEST-FAKE-invalid-time',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result).toMatchObject({ status: 'HOLD', reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE' });
  });

  it('holds contract ledger selection when the ledger observation timestamp is invalid', () => {
    const result = pickLedgerRowForContract({
      rows: [ledgerRow({
        valueAsOf: 'TEST-FAKE-invalid-time',
        computedAt: 'TEST-FAKE-invalid-time',
      })],
      contractDate: '2026-10-10',
      contractAt: '2026-10-10T10:00:00+09:00',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result).toMatchObject({ status: 'HOLD', reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE' });
  });

  it('holds contract ledger selection when the latest pre-contract snapshot value differs', () => {
    const result = pickLedgerRowForContract({
      rows: [ledgerRow({ valueAsOf: '2026-10-09', monthlyRent: { amount: 710000, currency: 'KRW', state: 'KNOWN', reasonCode: null } })],
      contractDate: '2026-10-10',
      termMonths: 24,
      monthlyRent: 700000,
      deposit: 0,
    });

    expect(result).toMatchObject({
      status: 'HOLD',
      reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE',
      detail: { mismatch: ['rent'] },
    });
  });
});
