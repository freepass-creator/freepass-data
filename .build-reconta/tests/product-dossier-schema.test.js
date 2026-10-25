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
    plate: '11가0001',
    supplierCode: 'RP001',
    listable: true,
    fields: [
        { path: 'product.maker', group: 'BASIC', normalizedValue: '기아', rawValue: 'KIA', rawRef: { supplierCode: 'RP001', sourceKind: 'SHEET', sheetTab: 'T', sheetRow: 3, rawPath: '원문.전체.차명' }, source: 'REFINED', asOf: '2026-10-12T00:00:00.000Z', mismatch: 'MATCH' },
        { path: 'billing[source:12].amount', group: 'BILLING_PAYOUT', normalizedValue: null, source: 'LEDGER', asOf: '2026-10-12T00:00:00.000Z', ledgerRunId: 'run-1', mismatch: 'NOT_COMPARED', reasonCode: 'UNCONFIRMED' },
    ],
};
describe('ProductDossier/v1 schema', () => {
    it('accepts a flat fields[] dossier and rejects unknown keys or bad enums', () => {
        expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...sample, customerPhone: 'x' })).toBe(false);
        const bare = { path: 'product.maker', group: 'BASIC', source: 'RAW', asOf: null };
        expect(validate({ ...sample, fields: [bare] })).toBe(false); // mismatch 와 사유 없음
        expect(validate({ ...sample, fields: [{ ...bare, mismatch: 'NOT_COMPARED' }] })).toBe(false); // asOf null 인데 reasonCode 없음
        expect(validate({ ...sample, status: 'PARTIAL', fields: [{ ...bare, mismatch: 'NOT_COMPARED', reasonCode: 'READ_FAILED' }] }), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...sample, fields: [{ ...bare, asOf: '2026-10-12T00:00:00.000Z' }] })).toBe(false); // mismatch 없음
        expect(validate({ ...sample, fields: [{ ...sample.fields[0], source: 'GUESS' }] })).toBe(false);
        expect(validate({ ...sample, candidates: Array.from({ length: 21 }, () => ({ productId: 'p', plateLast4: '0001' })) })).toBe(false);
    });
    it('expresses READ_FAILED and PARTIAL and forbids READ_FAILED fields under status OK', () => {
        const failedField = { path: 'product.maker', group: 'BASIC', source: 'RAW', asOf: null, mismatch: 'NOT_COMPARED', reasonCode: 'READ_FAILED' };
        expect(validate({ ...sample, status: 'OK', fields: [failedField] })).toBe(false);
        expect(validate({ ...sample, status: 'PARTIAL', fields: [failedField] }), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...sample, status: 'PARTIAL', fields: [sample.fields[0]] })).toBe(false);
        expect(validate({ ...sample, status: 'READ_FAILED', fields: [] })).toBe(false);
        expect(validate({ ...sample, status: 'READ_FAILED', reason: '원천 읽기 실패', fields: [] }), JSON.stringify(validate.errors)).toBe(true);
    });
});
