import { describe, expect, it } from 'vitest';
import { resolveVehicleValueEvidence } from '../src/application/vehicle-value-evidence.js';

describe('아이언·우리캐피탈 신차 차량가액 (원문 전체.차량가격)', () => {
  it('신차렌트의 원문 전체.차량가격은 CONFIRMED 로 읽는다', () => {
    for (const supplier of ['RP006', 'RP020']) {
      expect(resolveVehicleValueEvidence({ provider_company_code: supplier, product_type: '신차렌트', 원문: { 전체: { 차량가격: '40,250,000' } } }, undefined))
        .toMatchObject({ grade: 'CONFIRMED', source: 'SUPPLIER_RAW', amount: 40250000 });
    }
  });
  it('중고렌트이거나 값이 없으면 읽지 않고, 손오공은 전체 아래를 보지 않는다', () => {
    expect(resolveVehicleValueEvidence({ provider_company_code: 'RP006', product_type: '중고렌트', 원문: { 전체: { 차량가격: '40,250,000' } } }, undefined)).toBeNull();
    expect(resolveVehicleValueEvidence({ provider_company_code: 'RP006', product_type: '신차렌트', 원문: { 전체: {} } }, undefined)).toBeNull();
    expect(resolveVehicleValueEvidence({ provider_company_code: 'RP012', product_type: '신차렌트', 원문: { 전체: { 차량가격: '40,250,000' } } }, undefined)).toBeNull();
  });
});
