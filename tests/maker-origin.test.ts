import { afterEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import publicSchema from '../contracts/public-product-feed-v1.schema.json' with { type: 'json' };
import { originOfMaker } from '../src/domain/maker-origin.js';
import { buildPublicProductFeed } from '../src/api/public-product-feed.js';
import type { CatalogCompatibilitySnapshot } from '../src/infra/erp5-compat-catalog-reader.js';

// 원산지(대표 2026-10-16): 제조사 단위 읽기 전용 파생, 표에 없으면 null(확인 필요). 값은 합성.
const snapshot = (maker: unknown, model = '아반떼'): CatalogCompatibilitySnapshot => ({
  schema: 'freepass-data.catalog-compat/v1',
  data: { products: { P1: { _key: 'P1', product_code: 'P1', publicProductKey: 'P1', listable: true, provider_company_code: 'RP012', partner_code: 'RP012', whitelabels: ['uniplan'],
    maker, model, product_type: 'USED_SUBSCRIPTION', status_kind: '가용', policy_id: 'POLICY_PUBLIC',
    price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } } } },
  policies: { POLICY_PUBLIC: { policy_name: 'PUBLIC_BASIC', insurance_included: true, annual_mileage: 20000 } }, partners: {}, users: {} },
  meta: { consumerId: 'erp-com', authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE', sourceProject: 'freepasserp5', observedAt: '2026-10-10T00:00:00.000Z',
    collectionCounts: { products: 1, policy: 1 }, depositEvidenceVersion: 'catalog-compat-deposit/1' },
}) as unknown as CatalogCompatibilitySnapshot;
const item = (maker: unknown) => (buildPublicProductFeed(snapshot(maker), {}) as unknown as { products: Array<Record<string, unknown>> }).products[0]!;
afterEach(() => { delete process.env.FREEPASS_DATA_PUBLIC_ORIGIN; });

describe('제조사 원산지 구분', () => {
  it('국산·수입 표와 정본 별칭(KG모빌리티·르노코리아·토요타·메르세데스-벤츠)', () => {
    for (const m of ['현대', '기아', '제네시스', 'KGM', 'KG모빌리티', '쌍용']) expect(originOfMaker(m), m).toBe('국산');
    expect(originOfMaker('르노코리아','SM6')).toBe('국산');
    expect(originOfMaker('한국GM','말리부')).toBe('국산');
    for (const m of ['BMW', '벤츠', '메르세데스-벤츠', '아우디', '폭스바겐', '도요타', '토요타', '테슬라', 'BYD', '볼보', '마즈다']) expect(originOfMaker(m), m).toBe('수입');
  });
  it('does not call a mixed manufacturer model domestic solely from its maker', () => {
    for(const model of ['볼트 EV','볼트 EUV','트래버스','타호','콜로라도','이쿼녹스','블레이저','더 뉴 볼트 EV']) expect(originOfMaker('한국GM',model)).toBeNull();
    for(const model of ['마스터','조에','캡처','QM3']) expect(originOfMaker('르노코리아',model)).toBeNull();
    expect(originOfMaker('쉐보레')).toBeNull();
    expect(originOfMaker('현대','쏘나타')).toBe('국산');
    const feed=buildPublicProductFeed(snapshot('쉐보레','볼트 EV'),{});
    expect(feed.products[0]!.origin).toBeNull();
  });

  it('표에 없거나 비어 있으면 추정하지 않고 null(확인 필요)', () => {
    for (const m of ['', '  ', null, undefined, 123, '처음보는제조사', '현대자동차 신형']) expect(originOfMaker(m), String(m)).toBeNull();
  });

  it('공개 피드에 origin 파생 칸이 나가고(플래그 0 이면 없음), 계약 스키마를 통과한다', () => {
    expect(item('기아').origin).toBe('국산');
    expect(item('벤츠').origin).toBe('수입');
    expect(item('').origin).toBeNull();
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(publicSchema);
    for (const maker of ['기아', '벤츠', '']) expect(validate(buildPublicProductFeed(snapshot(maker), {})), JSON.stringify(validate.errors)).toBe(true);
    process.env.FREEPASS_DATA_PUBLIC_ORIGIN = '0';
    expect('origin' in item('기아')).toBe(false);
  });
});
