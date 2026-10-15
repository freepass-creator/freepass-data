import { afterEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import publicSchema from '../contracts/public-product-feed-v1.schema.json' with { type: 'json' };
import { buildPublicProductFeed, buildPublicProductQuote, refineState, sourceRawName } from '../src/api/public-product-feed.js';
import type { CatalogCompatibilitySnapshot } from '../src/infra/erp5-compat-catalog-reader.js';

// 2트랙(대표 2026-10-16): 공개 피드 «원문 표기·정제 상태» 읽기 전용 파생. 값은 합성.
const snapshot = (extra: Record<string, unknown>): CatalogCompatibilitySnapshot => ({
  schema: 'freepass-data.catalog-compat/v1',
  data: { products: { P1: { _key: 'P1', product_code: 'P1', publicProductKey: 'P1', listable: true, provider_company_code: 'RP012', partner_code: 'RP012', whitelabels: ['uniplan'],
    maker: '현대', model: '아반떼', sub_model: '아반떼 CN7', trim_name: '모던', product_type: 'USED_SUBSCRIPTION', status_kind: '가용', policy_id: 'POLICY_PUBLIC',
    price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } }, ...extra } },
  policies: { POLICY_PUBLIC: { policy_name: 'PUBLIC_BASIC', insurance_included: true, annual_mileage: 20000 } }, partners: {}, users: {} },
  meta: { consumerId: 'erp-com', authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE', sourceProject: 'freepasserp5', observedAt: '2026-10-10T00:00:00.000Z',
    collectionCounts: { products: 1, policy: 1 }, depositEvidenceVersion: 'catalog-compat-deposit/1' },
}) as unknown as CatalogCompatibilitySnapshot;
const quote = (extra: Record<string, unknown>) => buildPublicProductQuote(snapshot(extra), 'P1', {})!.product as Record<string, unknown>;
afterEach(() => { delete process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW; });

describe('공개 피드 원문 표기·정제 상태(2트랙)', () => {
  it('정제된 문서는 REFINED·빈 missing, 원문은 car_name 을 표시용으로 가공해 내보낸다(밑줄→공백, 괄호 코드 유지)', () => {
    const p = quote({ car_name: '기아_K5(DL3)_가솔린' });
    expect(p.refine_state).toBe('REFINED');
    expect(p.refine_missing).toEqual([]);
    expect(p.source_raw_name).toBe('기아 K5(DL3) 가솔린');
  });

  it('제조사·모델·세부모델 빈 칸은 PENDING + refine_missing, 원문이 대체 표시용', () => {
    const p = quote({ maker: '', model: '  ', sub_model: '', car_name: '쏘나타 디 엣지' });
    expect(p.refine_state).toBe('PENDING');
    expect(p.refine_missing).toEqual(['maker', 'model', 'sub_model']);
    expect(p.source_raw_name).toBe('쏘나타 디 엣지');
  });

  it('원문 형태(세부모델에 밑줄)는 PENDING', () => {
    expect(refineState({ maker: '기아', model: 'K5', sub_model: 'K5_DL3_가솔린' }).refine_state).toBe('PENDING');
  });

  it('임시 표식은 보조일 뿐: 표식만 남은 정제 완료 문서는 REFINED, 표식 + 세부모델이 원문 그대로면 PENDING', () => {
    const refined = { maker: '제네시스', model: 'G80', sub_model: 'G80 RG3', vehicle_review_required: true, vehicle_title_source: 'RAW_VEHICLE_TEXT', car_name: 'G80 3.5 터보 AWD' };
    expect(refineState(refined).refine_state).toBe('REFINED');
    const temp = { maker: '제네시스', model: 'G80', sub_model: 'G80 3.5 터보 AWD', vehicle_title_source: 'RAW_VEHICLE_TEXT', car_name: 'G80 3.5 터보 AWD' };
    expect(refineState(temp).refine_state).toBe('PENDING');
    // 표식이 없으면 값이 같아도 정제로 본다(공급사 원문이 마스터 이름과 같은 경우)
    expect(refineState({ maker: '현대', model: '쏘나타', sub_model: '쏘나타', car_name: '쏘나타' }).refine_state).toBe('REFINED');
  });

  it('«확인 중» 같은 문자열은 매칭하지 않는다(소비처가 빈 칸일 때 보여 주는 값)', () => {
    expect(refineState({ maker: '현대', model: '아반떼', sub_model: '확인 중' }).refine_state).toBe('REFINED');
    expect(refineState({ maker: '', model: '', sub_model: '', trim_name: '' }).refine_state).toBe('PENDING');
  });

  it('원문.차명 대체, 아이카 제조사 접두(raw.original·headers/cells), 이미 제조사로 시작하면 중복 접두 없음', () => {
    expect(sourceRawName({ 원문: { 차명: '아반떼 CN7' } })).toBe('아반떼 CN7');
    expect(sourceRawName({ car_name: 'K5 프레스티지', 원문: { source: { original: { 제조사: '기아' } } } })).toBe('기아 K5 프레스티지');
    expect(sourceRawName({ car_name: 'K5', 원문: { source: { headers: ['배차상태', '제조사'], cells: ['출고가능', '기아'] } } })).toBe('기아 K5');
    expect(sourceRawName({ car_name: '기아 K5', 원문: { source: { original: { 제조사: '기아' } } } })).toBe('기아 K5');
    expect(sourceRawName({ car_name: '', 원문: {} })).toBeNull();
  });

  it('개인정보·번호·금액 꼴·수수료 낱말이 걸리면 null, 길이 상한, % 는 허용(피드를 던지지 않음)', () => {
    for (const bad of ['쏘나타 12가3456', '문의 010-1234-5678', '아반떼 50만원', '수수료 포함 K5', '고객 홍길동 차']) expect(sourceRawName({ car_name: bad }), bad).toBeNull();
    expect(sourceRawName({ car_name: 'A'.repeat(300) })!.length).toBeLessThanOrEqual(140);
    const p = quote({ car_name: '썬팅 자외선 99% 차단 K5' });   // 전체 피드가 PUBLIC_FORBIDDEN_TEXT 로 던지지 않아야 한다
    expect(p.source_raw_name).toBe('썬팅 자외선 99% 차단 K5');
  });

  it('목록·상세 모두 포함, 플래그 0 이면 세 칸 없음, 계약 스키마 통과', () => {
    const feed = buildPublicProductFeed(snapshot({ car_name: 'K5' }), {});
    const item = (feed as unknown as { products: Array<Record<string, unknown>> }).products[0]!;
    expect(item.refine_state).toBe('REFINED');
    process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW = '0';
    const off = quote({ car_name: 'K5' });
    expect('source_raw_name' in off || 'refine_state' in off || 'refine_missing' in off).toBe(false);
    delete process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW;
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(publicSchema);
    expect(validate(buildPublicProductFeed(snapshot({ car_name: '기아_K5_가솔린' }), {})), JSON.stringify(validate.errors)).toBe(true);
  });
});
