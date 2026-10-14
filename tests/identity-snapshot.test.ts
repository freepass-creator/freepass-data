import { describe, expect, it } from 'vitest';
import { identityMastersFromSnapshot, identityProductsFromCapture } from '../src/adapters/identity-snapshot.js';
import { buildIdentityPromotionPlan, type IdentityMaster, type IdentityProduct } from '../src/application/identity-promotion-plan.js';
import type { Erp5SourceCapture } from '../src/adapters/erp5-source-capture.js';

const sv = (v: string) => ({ stringValue: v });
const doc = (id: string, fields: Record<string, unknown>) => ({ name: `projects/freepasserp5/databases/(default)/documents/products/${id}`, fields });
const capture = (docs: unknown[]) => ({ collections: { products: { count: docs.length, documents: docs } } }) as unknown as Erp5SourceCapture;

describe('정체성 계획서 입력 내보내기(읽기 전용)', () => {
  const cap = capture([
    doc('RP012_A', { car_number: sv('12가3456'), maker: sv(''), model: sv(''), sub_model: sv('아이오닉5 프레스티지'), vehicle_review_required: { booleanValue: true },
      원문: { mapValue: { fields: { 차명: sv('아이오닉5 프레스티지') } } }, first_registration_date: sv('2022-03'), listable: { booleanValue: true } }),
    doc('RP001_B', { car_number: sv('34나5678'), maker: sv('현대'), model: sv('아반떼'), sub_model: sv('더 뉴 아반떼 CN7'), car_name: sv('아반떼') }),
  ]);
  const master = {
    masters: [{ id: 'm1', data: { maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', model_aliases: ['아이오닉5'], sub_model_aliases: ['아이오닉5'] } },
      { id: 'old', data: { maker: '현대', model: 'x', sub_model: 'x', retired: true } }],
    trims: [{ id: 't1', data: { master_id: 'm1', trim: '프레스티지', model_year_start: 2021, model_year_end: '현재' } },
      { id: 't2', data: { master_id: 'm1', trim: '익스클루시브', model_year_start: 2022, model_year_end: 2024, retired: true } }],
  };
  it('takes only engine-raw products by default (all with --all), keeps only the last 4 plate digits, and drops retired masters/trims', () => {
    const products = identityProductsFromCapture(cap);
    expect(products).toEqual([{ id: 'RP012_A', plate4: '3456', maker: '', model: '', sub_model: '아이오닉5 프레스티지', trim_name: '',
      rawName: '아이오닉5 프레스티지', year: '2022', listable: true }]);
    expect(identityProductsFromCapture(cap, { includeAll: true }).map(p => p.id)).toEqual(['RP001_B', 'RP012_A']);
    expect(JSON.stringify(products)).not.toMatch(/\d{2,3}[가-힣]\d{4}/);
    const masters = identityMastersFromSnapshot(master as never);
    expect(masters).toEqual([{ id: 'm1', maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', model_aliases: ['아이오닉5'], sub_model_aliases: ['아이오닉5'],
      yearFrom: 2021, yearTo: null, trims: [{ name: '프레스티지', aliases: [] }] }]);
  });
  it('its output feeds the plan generator directly (structural compatibility + end-to-end plan)', () => {
    const products: IdentityProduct[] = identityProductsFromCapture(cap);
    const masters: IdentityMaster[] = identityMastersFromSnapshot(master as never);
    const r = buildIdentityPromotionPlan(products, masters);
    expect(r.plan.productIdentityRepairs?.[0]?.to).toEqual({ maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE' });
    expect(r.trimPlan?.productTrimRepairs?.[0]).toMatchObject({ id: 'RP012_A', to: '프레스티지' });
  });
});
