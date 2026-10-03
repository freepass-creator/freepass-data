import { expect, test } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../contracts/kakao-catalog-reference-v1.schema.json' with { type: 'json' };
import { resolveSalesCommission, resolveSupplierBillingFee } from '../src/application/kakao-catalog-reference.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(schema);
const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/commissionResolution` });
const base = { ruleId: null, amount: null, vatTreatment: 'UNKNOWN', vatAmount: null, totalAmount: null, reasonCode: 'NO_MATCHING_RULE' };

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
