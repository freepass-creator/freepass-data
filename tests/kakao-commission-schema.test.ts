process.env.FREEPASS_SHEET_F04_ID = 'test-sheet-f04';
import { expect, test } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import schema from '../contracts/kakao-catalog-reference-v1.schema.json' with { type: 'json' };
import { resolveSalesCommission, resolveSupplierBillingFee } from '../src/application/kakao-catalog-reference.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const addFormats = (
  typeof addFormatsModule === 'function'
    ? addFormatsModule
    : (addFormatsModule as unknown as { default: FormatsPlugin }).default
) as FormatsPlugin;
addFormats(ajv);
ajv.addSchema(schema);
const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/commissionResolution` });
const validatePriceTerm = ajv.compile({ $ref: `${schema.$id}#/$defs/priceTerm` });
const base = { ruleId: null, amount: null, vatTreatment: 'UNKNOWN', vatAmount: null, totalAmount: null, reasonCode: 'NO_MATCHING_RULE' };
const zeroTerm = () => ({
  termKey: '24',
  termMonths: 24,
  monthlyRent: { amount: 500000, currency: 'KRW' },
  deposit: { amount: 0, currency: 'KRW' },
  depositAmount: 0,
  depositState: 'ZERO',
  depositStatusLabel: '무보증',
  depositRule: { code: 'ZERO_DEPOSIT', multiplier: 0, label: '무보증', depositEvidenceBasis: { field: 'deposit_note', text: '무보증' } },
  mileageLimitKmPerYear: 20000,
  settlement: 'RETURN',
  salesCommission: { ...base, state: 'UNKNOWN' },
  supplierBillingFee: { ...base, state: 'UNKNOWN' },
  channelPayoutFee: { ...base, state: 'UNKNOWN' },
  expectedGrossMargin: { state: 'UNKNOWN', amount: null, currency: 'KRW', basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: 'MISSING_INPUT' },
});

test('deposit schema: ZERO requires evidence basis and confirmation basis requires source time', () => {
  expect(validatePriceTerm(zeroTerm()), JSON.stringify(validatePriceTerm.errors)).toBe(true);
  const missingBasis = zeroTerm();
  delete (missingBasis.depositRule as Record<string, unknown>).depositEvidenceBasis;
  expect(validatePriceTerm(missingBasis)).toBe(false);
  expect(validatePriceTerm.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ keyword: 'required', params: { missingProperty: 'depositEvidenceBasis' } })
  ]));

  const confirmed = zeroTerm();
  const confirmedRule = confirmed.depositRule as { depositEvidenceBasis: Record<string, unknown> };
  confirmedRule.depositEvidenceBasis = { field: 'deposit_free_confirmation', text: '무보증', source: '공급사 확인', at: '2026-10-10T12:00:00+09:00' };
  expect(validatePriceTerm(confirmed), JSON.stringify(validatePriceTerm.errors)).toBe(true);
  delete confirmedRule.depositEvidenceBasis.source;
  expect(validatePriceTerm(confirmed)).toBe(false);
  expect(validatePriceTerm.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ keyword: 'required', params: { missingProperty: 'source' } })
  ]));

  confirmedRule.depositEvidenceBasis = { field: 'deposit_free_confirmation', text: '무보증', source: '   ', at: '2026-10-10T12:00:00+09:00' };
  expect(validatePriceTerm(confirmed)).toBe(false);
  expect(validatePriceTerm.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ keyword: 'pattern', instancePath: expect.stringContaining('/source') })
  ]));

  confirmedRule.depositEvidenceBasis = { field: 'deposit_free_confirmation', text: '무보증', source: '공급사 확인', at: '어제' };
  expect(validatePriceTerm(confirmed)).toBe(false);
  expect(validatePriceTerm.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ keyword: 'format', instancePath: expect.stringContaining('/at') })
  ]));
});

test('commission schema: UNKNOWN·NOT_APPLICABLE·협의 결과에 sourceRefs 가 있으면 계약 위반, 계산된 결과는 sourceRefs 필수', () => {
  for (const state of ['UNKNOWN', 'NOT_APPLICABLE', 'COORDINATION_REQUIRED']) {
    expect(validate({ ...base, state })).toBe(true);
    expect(validate({ ...base, state, sourceRefs: ['F04:수수료표!A177:M177'] })).toBe(false);
  }
  const calculated = { state: 'CALCULATED', ruleId: 'R', amount: 100, vatTreatment: 'EXCLUDED', vatAmount: 10, totalAmount: 110, reasonCode: null };
  expect(validate(calculated)).toBe(false);
  expect(validate({ ...calculated, sourceRefs: ['F04:수수료표!A3:M3'] })).toBe(true);
});

test('commission schema: 엔진 실제 출력이 계약을 지킨다(미등록 공급사·마음카·계산 결과)', () => {
  for (const supplierId of ['XX-9999', 'RP034', 'RP013', 'RP018']) for (const f of [resolveSalesCommission, resolveSupplierBillingFee]) {
    const r = f({ supplierId, productType: '중고렌트', fuel: '가솔린', termMonths: 36, monthlyRent: 500000 });
    expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
  }
});
