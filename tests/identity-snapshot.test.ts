import { describe, expect, it } from 'vitest';
import { identityMastersFromSnapshot, identityProductsFromCapture, identityProductsFromPlainDocs } from '../src/adapters/identity-snapshot.js';
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
      rawName: '아이오닉5 프레스티지', year: '2022', listable: true, engineTemp: true }]);
    expect(identityProductsFromCapture(cap, { includeAll: true }).map(p => p.id)).toEqual(['RP001_B', 'RP012_A']);
    expect(JSON.stringify(products)).not.toMatch(/\d{2,3}[가-힣]\d{4}/);
    const masters = identityMastersFromSnapshot(master as never);
    expect(masters).toEqual([{ id: 'm1', maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', model_aliases: ['아이오닉5'], sub_model_aliases: ['아이오닉5'],
      yearFrom: 2021, yearTo: null, trims: [{ name: '프레스티지', aliases: [] }] }]);
  });
  it('plain docs input gives the same products as the sealed capture, masked to the last 4 digits', () => {
    const docs = [
      { id: 'RP012_A', data: { car_number: '12가3456', maker: '', model: '', sub_model: '아이오닉5 프레스티지', vehicle_review_required: true,
        원문: { 차명: '아이오닉5 프레스티지' }, first_registration_date: '2022-03', listable: true } },
      { id: 'RP001_B', data: { car_number: '34나5678', maker: '현대', model: '아반떼', sub_model: '더 뉴 아반떼 CN7', car_name: '아반떼' } },
    ];
    expect(identityProductsFromPlainDocs(docs)).toEqual(identityProductsFromCapture(cap));
    expect(identityProductsFromPlainDocs(docs, { includeAll: true }).map(p => p.id)).toEqual(['RP001_B', 'RP012_A']);
    expect(JSON.stringify(identityProductsFromPlainDocs(docs, { includeAll: true }))).not.toMatch(/\d{2,3}[가-힣]\d{4}/);
    expect(identityProductsFromPlainDocs([{ id: '', data: {} }, { id: 'x', data: null as never }] as never)).toEqual([]);
  });
  it('master year range: master year_start/year_end first, then trim model_year_* or production_*; trims string list only without trim docs', () => {
    const masters = identityMastersFromSnapshot({
      masters: [
        { id: 'a', data: { maker: '기아', model: '카니발', sub_model: '카니발 KA4', year_start: '2020', year_end: '2023' } },
        { id: 'b', data: { maker: '기아', model: '쏘렌토', sub_model: '쏘렌토 MQ4', year_end: '현재' } },
        { id: 'c', data: { maker: '현대', model: '투싼', sub_model: '투싼 NX4', trims: ['프리미엄', '인스퍼레이션'] } },
      ],
      trims: [
        { id: 'tb', data: { master_id: 'b', trim: '노블레스', production_start: '2020-07', production_end: '현재', trim_aliases: ['노블'] } },
      ],
    } as never);
    const by = Object.fromEntries(masters.map(m => [m.id, m]));
    expect([by.a!.yearFrom, by.a!.yearTo]).toEqual([2020, 2023]);
    expect([by.b!.yearFrom, by.b!.yearTo]).toEqual([2020, null]);                       // 마스터 year_end «현재» → 끝 제한 없음, 시작은 트림 production_start
    expect(by.b!.trims).toEqual([{ name: '노블레스', aliases: ['노블'] }]);
    expect([by.c!.yearFrom, by.c!.yearTo]).toEqual([null, null]);                      // 연식 근거 없음 → 제한 없음
    expect(by.c!.trims).toEqual([{ name: '프리미엄', aliases: [] }, { name: '인스퍼레이션', aliases: [] }]);
  });
  it('its output feeds the plan generator directly (structural compatibility + end-to-end plan)', () => {
    const products: IdentityProduct[] = identityProductsFromCapture(cap);
    const masters: IdentityMaster[] = identityMastersFromSnapshot(master as never);
    const r = buildIdentityPromotionPlan(products, masters);
    expect(r.plan.productIdentityRepairs?.[0]?.to).toEqual({ maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE' });
    expect(r.trimPlan?.productTrimRepairs?.[0]).toMatchObject({ id: 'RP012_A', to: '프레스티지' });
  });
});
