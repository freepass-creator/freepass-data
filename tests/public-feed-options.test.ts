import { afterEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import publicSchema from '../contracts/public-product-feed-v1.schema.json' with { type: 'json' };
import { buildPublicProductFeed, buildPublicProductQuote, publicOptions } from '../src/api/public-product-feed.js';
import type { CatalogCompatibilitySnapshot } from '../src/infra/erp5-compat-catalog-reader.js';

// 공개 피드 옵션 선택 필드(대표 2026-10-16): 기본 꺼짐(FREEPASS_DATA_PUBLIC_OPTIONS=1), 목록 모드 제외, 금액 있음/«금액 확인 중» 구분, 이름 단위 안전 거름. 값은 합성.
const snapshot = (extra: Record<string, unknown>): CatalogCompatibilitySnapshot => ({
  schema: 'freepass-data.catalog-compat/v1',
  data: { products: { P1: { _key: 'P1', product_code: 'P1', publicProductKey: 'P1', listable: true, provider_company_code: 'RP012', partner_code: 'RP012', whitelabels: ['uniplan'],
    maker: '현대', model: '아반떼', trim_name: '모던', product_type: 'USED_SUBSCRIPTION', status_kind: '가용', policy_id: 'POLICY_PUBLIC',
    price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } }, ...extra } },
  policies: { POLICY_PUBLIC: { policy_name: 'PUBLIC_BASIC', insurance_included: true, annual_mileage: 20000 } }, partners: {}, users: {} },
  meta: { consumerId: 'erp-com', authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE', sourceProject: 'freepasserp5', observedAt: '2026-10-10T00:00:00.000Z',
    collectionCounts: { products: 1, policy: 1 }, depositEvidenceVersion: 'catalog-compat-deposit/1' },
}) as unknown as CatalogCompatibilitySnapshot;
const withOptions = {
  api_options_state: 'PRESENT',
  api_options_basic: [{ category: 'SAFETY', name: '전방 충돌방지' }, { category: 'SAFETY', name: '전방 충돌방지' }, { category: 'CONVENIENCE', name: '수수료 포함 패키지' }, { category: 'X', name: '1,000원 할인' }],
  api_options_paid: [{ name: '파노라마 선루프', amount_krw: 1_200_000, amount_state: 'KNOWN', amount_raw: 1_200_000 }, { name: '패키지', amount_krw: null, amount_state: 'UNKNOWN', amount_raw: null }],
};
afterEach(() => { delete process.env.FREEPASS_DATA_PUBLIC_OPTIONS; });

describe('공개 피드 옵션 선택 필드', () => {
  it('기본 꺼짐: 플래그가 없으면 옵션 필드가 나가지 않는다', () => {
    const p = buildPublicProductQuote(snapshot(withOptions), 'P1', {})!.product as Record<string, unknown>;
    expect(p).not.toHaveProperty('option_state');
    expect(p).not.toHaveProperty('option_basic');
    expect(p).not.toHaveProperty('option_paid');
  });

  it('켜면 이름 단위로 안전하게 거르고(금액·수수료 꼴 이름 제외, 중복 제거), 유상은 금액 있음/없음(null)을 구분한다', () => {
    process.env.FREEPASS_DATA_PUBLIC_OPTIONS = '1';
    const p = buildPublicProductQuote(snapshot(withOptions), 'P1', {})!.product;
    expect(p.option_state).toBe('PRESENT');
    expect(p.option_basic).toEqual(['전방 충돌방지']);
    expect(p.option_paid).toEqual([{ name: '파노라마 선루프', amount_krw: 1_200_000 }, { name: '패키지', amount_krw: null }]);
    // 스키마 통과(추가 선택 필드): 목록 피드에는 나가지 않고, 상세(quote)의 product 가 product 정의를 통과한다.
    const feed = buildPublicProductFeed(snapshot(withOptions), {});
    expect(feed.products[0]).not.toHaveProperty('option_state');
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(publicSchema as object);
    expect(validate({ product: p }), JSON.stringify(validate.errors?.slice(0, 2))).toBe(true);
  });

  it('원천에 옵션 칸이 없거나(이안카 등) NO_DETAIL·TOO_MANY 면 UNKNOWN(미확인), 빈 옵션(NONE)은 NONE', () => {
    process.env.FREEPASS_DATA_PUBLIC_OPTIONS = '1';
    for (const state of [undefined, 'NO_DETAIL', 'TOO_MANY']) {
      const p = buildPublicProductQuote(snapshot(state ? { api_options_state: state } : {}), 'P1', {})!.product;
      expect(p).toMatchObject({ option_state: 'UNKNOWN', option_basic: [], option_paid: [] });
    }
    expect(buildPublicProductQuote(snapshot({ api_options_state: 'NONE', api_options_basic: [], api_options_paid: [] }), 'P1', {})!.product.option_state).toBe('NONE');
  });

  it('Codex #687: 전화·개인정보 낱말·금액(공백 단위)·쪼갠 금지어는 이름 단위로 거른다', () => {
    const bad = ['HUD 010-1234-5678', 'HUD 010 1234 5678', '고객 홍길동', '고 객 홍길동', '담당자 연락처', 'HUD 100,000 원', 'HUD 100,000 KRW', 'HUD 5 만 원', '₩50,000 상당', '₩ 50000', 'KRW 100000', '수 수 료', '수-수-료 포함', '청 구', '１０％ 할인'];
    const ok = ['HUD(헤드업디스플레이)', '17인치 알로이 휠', '파노라마 선루프', 'LED 헤드램프', '스마트 크루즈 컨트롤', '휴대폰 무선충전', '블루투스 핸즈프리 전화', '문의형 아님 스마트키'];
    const r = publicOptions({ api_options_state: 'PRESENT', api_options_basic: [...bad, ...ok].map(name => ({ name })), api_options_paid: [] });
    expect(r.option_basic).toEqual(ok);
  });

  it('Codex #687 재지적: 괄호·하이픈이 낀 금액과 제로폭 문자로 쪼갠 개인정보·전화는 거른다', () => {
    const zw = String.fromCharCode(0x200b), soft = String.fromCharCode(0x00ad);
    const bad = ['HUD ₩(50,000)', 'HUD 50,000-원', 'HUD (50,000) 원', '고' + zw + '객 홍길동', '010' + zw + '-1234' + zw + '-5678', '수' + soft + '수료'];
    const ok = ['HUD(헤드업디스플레이)', '휴대폰 무선충전'];
    const r = publicOptions({ api_options_state: 'PRESENT', api_options_basic: [...bad, ...ok].map(name => ({ name })), api_options_paid: [] });
    expect(r.option_basic).toEqual(ok);
  });

  it('이름 하나가 규칙에 걸려도 피드 전체는 던지지 않는다; 숫자·번호 꼴은 개별로 버림', () => {
    const r = publicOptions({ api_options_state: 'PRESENT', api_options_basic: [{ name: '12가3456 전용' }, { name: 'A'.repeat(17) }, { name: '정상 옵션' }, { name: 3 }, null],
      api_options_paid: [{ name: '유상', amount_state: 'KNOWN', amount_krw: -5 }, { name: '유상2', amount_state: 'KNOWN', amount_krw: 700000 }] });
    expect(r.option_basic).toEqual(['정상 옵션']);
    expect(r.option_paid).toEqual([{ name: '유상', amount_krw: null }, { name: '유상2', amount_krw: 700000 }]);
  });
});
