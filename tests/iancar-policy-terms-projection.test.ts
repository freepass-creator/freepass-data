import { describe, expect, it } from 'vitest';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { projectIancarPolicyTerms } from '../src/domain/iancar-policy-terms-projection.js';
import { readSingleProductCompatibility } from '../src/infra/erp5-compat-catalog-reader.js';

const terms = (over: Record<string, unknown> = {}) => ({ source: 'ONE_RATES', observedAt: '2026-10-07T09:37:10.295Z', minimumDriverAge: 26, maximumDriverAge: 65, minimumLicenseMonths: 12,
  ownDamageIncluded: true, ownDamageDeductible: 500000, ownDamageMinimumFaultPercent: 30, personalInjuryDeductible: 500000, propertyDamageDeductible: 500000, repairLimit: 5000000,
  age24Surcharge: 60000, perPanelRepair: 300000, excessMileageFeePerKm: 100, dailyLossOrLateReturnFeeByTerm: { '12_연20000km': 130000, '1_월2000km': 130000 }, vatIncluded: true, ...over });

describe('이안카 차량별 조건 투영(고정 키·자료형만)', () => {
  it('정상 값은 사본으로 통과, null 은 없음으로 통과', () => {
    const value = terms();
    const out = projectIancarPolicyTerms(value) as Record<string, unknown>;
    expect(out).toEqual(value);
    expect(out).not.toBe(value);
    expect((out.dailyLossOrLateReturnFeeByTerm as object)).not.toBe(value.dailyLossOrLateReturnFeeByTerm);
    expect(projectIancarPolicyTerms(null)).toBeNull();
    expect(projectIancarPolicyTerms(terms({ age24Surcharge: '불가' }))).toMatchObject({ age24Surcharge: '불가' });
    expect(projectIancarPolicyTerms(terms({ age24Surcharge: null }))).toMatchObject({ age24Surcharge: null });
  });
  it.each([
    ['알 수 없는 키(수수료·원가 등)', terms({ commission: 900 })],
    ['키 누락', (() => { const { vatIncluded, ...rest } = terms(); return rest; })()],
    ['출처가 다름', terms({ source: 'SHEET' })],
    ['관측 시각이 날짜가 아님', terms({ observedAt: 'x' })],
    ['정수가 아님(소수)', terms({ repairLimit: 1.5 })],
    ['음수', terms({ ownDamageDeductible: -1 })],
    ['문자열 금액', terms({ repairLimit: '5000000' })],
    ['불리언 자리에 문자열', terms({ ownDamageIncluded: 'yes' })],
    ['24세 추가요금이 너무 긴 문자열', terms({ age24Surcharge: 'x'.repeat(21) })],
    ['휴차료 키 형식 오류', terms({ dailyLossOrLateReturnFeeByTerm: { 'bad key': 1 } })],
    ['휴차료 값이 정수가 아님', terms({ dailyLossOrLateReturnFeeByTerm: { '12_연20000km': 'x' } })],
    ['휴차료가 객체가 아님', terms({ dailyLossOrLateReturnFeeByTerm: [] })],
    ['중첩 객체', terms({ minimumDriverAge: { v: 26 } })],
    ['배열', [] as unknown as Record<string, unknown>],
  ])('%s → 거부', (_name, value) => expect(projectIancarPolicyTerms(value)).toBeUndefined());
});

describe('단일 상품 호환 응답: iancar_policy_terms', () => {
  const time = '2026-10-12T00:00:00.000Z';
  const stamp = () => new Timestamp(Math.floor(Date.parse(time) / 1000), 123);
  const scope = new Set<'products' | 'policy' | 'partner'>(['products', 'policy', 'partner']);
  const dbWith = (product: Record<string, unknown>) => {
    const records: Record<string, Record<string, unknown>> = { 'products/machine-id': product, 'policy/P1': { policy_code: 'P1', policy_name: 'known' }, 'partner/RP031': { partner_code: 'RP031', partner_name: 'supplier' } };
    return { collection: (c: string) => ({ doc: (id: string) => ({ path: `${c}/${id}`, id }) }),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ get: async (ref: { path: string; id: string }) => ({ id: ref.id, exists: records[ref.path] !== undefined, data: () => records[ref.path], readTime: stamp(), updateTime: stamp() }) }) } as unknown as Firestore;
  };
  const base = { product_code: 'c', provider_company_code: 'RP031', policy_code: 'P1', price: { '12_0': { rent: 1, deposit: null, depositState: 'UNKNOWN' } } };
  it('올바른 모양이면 응답에 포함되고, 같은 문서의 수수료·원가 필드는 계속 빠진다', async () => {
    const result = await readSingleProductCompatibility(dbWith({ ...base, iancar_policy_terms: terms(), commission: 900, internal_fee: 5 }), 'erp-com', 'machine-id', scope);
    const product = result.data.products['machine-id'] as Record<string, unknown>;
    expect(product.iancar_policy_terms).toEqual(terms());
    expect(product).not.toHaveProperty('commission');
    expect(product).not.toHaveProperty('internal_fee');
  });
  it('null 은 null 로, 필드가 없으면 키도 없다', async () => {
    expect(((await readSingleProductCompatibility(dbWith({ ...base, iancar_policy_terms: null }), 'erp-com', 'machine-id', scope)).data.products['machine-id'] as Record<string, unknown>).iancar_policy_terms).toBeNull();
    expect(((await readSingleProductCompatibility(dbWith({ ...base }), 'erp-com', 'machine-id', scope)).data.products['machine-id'] as Record<string, unknown>)).not.toHaveProperty('iancar_policy_terms');
  });
  it('모양이 틀리면(알 수 없는 키·비정상 값) 응답하지 않는다', async () => {
    await expect(readSingleProductCompatibility(dbWith({ ...base, iancar_policy_terms: terms({ commission: 900 }) }), 'erp-com', 'machine-id', scope)).rejects.toMatchObject({ statusCode: expect.any(Number) });
  });
});
