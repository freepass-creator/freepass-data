import { expect, test } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import schema from '../contracts/admin-catalog-view-v1.schema.json' with { type: 'json' };

const addFormats = (
  typeof addFormatsModule === 'function'
    ? addFormatsModule
    : (addFormatsModule as unknown as { default: FormatsPlugin }).default
) as FormatsPlugin;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const sample = {
  schema: 'freepass-data.admin-catalog/v1',
  meta: {
    consumerId: 'freepass-admin-catalog',
    projectionId: 'admin-catalog',
    authority: 'CANONICAL_ACTIVE',
    schemaVersion: '1.0.0',
    releaseId: 'rel-admin-1',
    manifestId: 'manifest_rel-admin-1',
    inputDigest: 'input-digest',
    dataDigest: 'data-digest',
    revision: 17,
    generatedAt: '2026-09-25T00:00:00.000Z',
    activatedAt: '2026-09-25T00:01:00.000Z',
    policyParity: 'COMPLETE',
    missingPolicyOfferIds: [],
    invalidPolicyFactRefs: [],
  },
  data: [{
    productId: 'product-1',
    productRevision: 7,
    updatedAt: '2026-09-24T23:59:00.000Z',
    displayName: '싼타페 MX5 캘리그래피',
    commercialType: 'USED_RENT',
    vehicleModel: {
      id: 'vm-1',
      maker: '현대',
      model: '싼타페',
      generation: '5세대',
      subModel: 'MX5',
      trim: '캘리그래피',
      fuel: '하이브리드',
      drive: 'AWD',
      seats: 6,
    },
    vehicleAsset: {
      id: 'asset-1',
      status: 'AVAILABLE',
      plateNumber: '123하4567',
      vin: 'VIN-1',
      odometerKm: 21000,
    },
    offers: [{
      offerId: 'offer-a',
      offerRevision: 3,
      supplierId: 'supplier-a',
      policyId: 'policy-a',
      policyState: 'COMPLETE',
      policyValues: [
        { policyId: 'basic_driver_age', type: 'NUMBER', value: 21 },
        { policyId: 'deposit_card_payment', type: 'BOOLEAN', value: true },
      ],
      invalidPolicyFactRefs: [],
      priceTerms: [{
        termKey: '36_2만',
        termMonths: 36,
        monthlyRent: { amount: 920000, currency: 'KRW' },
        deposit: { amount: 0, currency: 'KRW' },
        depositState: 'ZERO',
        mileageLimitKmPerYear: 20000,
      }, {
        termKey: '48_2만',
        termMonths: 48,
        monthlyRent: { amount: 850000, currency: 'KRW' },
        depositState: 'UNKNOWN',
        mileageLimitKmPerYear: 20000,
      }],
    }],
  }],
};

test('Admin Catalog V1 validates release evidence, policy state and explicit deposit semantics', () => {
  expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
});

test('Admin Catalog V1 rejects empty release data', () => {
  const copy = structuredClone(sample);
  copy.data = [];
  expect(validate(copy)).toBe(false);
});

test('Admin Catalog V1 rejects KNOWN deposit without money', () => {
  const copy = structuredClone(sample);
  copy.data[0]!.offers[0]!.priceTerms[0]!.depositState = 'KNOWN';
  delete copy.data[0]!.offers[0]!.priceTerms[0]!.deposit;
  expect(validate(copy)).toBe(false);
});

test('Admin Catalog V1 rejects amount on UNKNOWN deposit', () => {
  const copy = structuredClone(sample);
  copy.data[0]!.offers[0]!.priceTerms[1]!.deposit = { amount: 0, currency: 'KRW' };
  expect(validate(copy)).toBe(false);
});

test('Admin Catalog V1 includes current OGONG subscription commercial type', () => {
  const copy = structuredClone(sample);
  copy.data[0]!.commercialType = 'OGONG_SUBSCRIPTION';
  expect(validate(copy), JSON.stringify(validate.errors)).toBe(true);
});
