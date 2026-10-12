import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(readFileSync(new URL('../contracts/product-dossier-v1.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

const sample = {
  schema: 'ProductDossier/v1',
  readAt: '2026-10-12T00:00:00.000Z',
  lookup: { kind: 'PLATE_LAST4', value: '0001' },
  status: 'OK',
  productId: 'product-1',
  fields: [
    { path: 'product.maker', group: 'BASIC', normalizedValue: '기아', rawValue: 'KIA', rawRef: { supplierCode: 'RP001', sourceKind: 'SHEET', sheetTab: 'T', sheetRow: 3 }, source: 'REFINED', asOf: '2026-10-12T00:00:00.000Z', mismatch: false },
    { path: 'billing[source:12].amount', group: 'BILLING_PAYOUT', normalizedValue: null, source: 'LEDGER', asOf: '2026-10-12T00:00:00.000Z', ledgerRunId: 'run-1', reasonCode: 'UNCONFIRMED' },
  ],
};

describe('ProductDossier/v1 schema', () => {
  it('accepts a flat fields[] dossier and rejects unknown keys or bad enums', () => {
    expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...sample, customerPhone: 'x' })).toBe(false);
    expect(validate({ ...sample, fields: [{ ...sample.fields[0], source: 'GUESS' }] })).toBe(false);
    expect(validate({ ...sample, candidates: Array.from({ length: 21 }, () => ({ productId: 'p', plateLast4: '0001' })) })).toBe(false);
  });
});
