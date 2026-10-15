import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import publicSchema from '../contracts/public-product-feed-v1.schema.json' with { type: 'json' };
import { buildPublicProductFeed, buildPublicProductQuote, buildRawNameVocabulary, refineState, sourceRawName } from '../src/api/public-product-feed.js';
import type { CatalogCompatibilitySnapshot } from '../src/infra/erp5-compat-catalog-reader.js';

// 2트랙(대표 2026-10-16): 공개 피드 «원문 표기·정제 상태» 읽기 전용 파생 + 원문 차명 화이트리스트(B3Q 구조 권고). 값은 합성.
// 어휘 = 정제된(REFINED) 차량의 제조사·모델·세부모델·등급·색·연료 낱말. 원문 차명의 모든 낱말이 어휘·숫자·제원 낱말에 속할 때만 나간다.
const seed = (names: string[]): Array<Record<string, unknown>> =>
  names.map((name, i) => ({ _key: `S${i}`, listable: false, maker: '시험', model: '시험', sub_model: name }));
const LEGIT = ['K5 프레스티지', '신형 K5 노블레스', '쏘나타 디 엣지', '임팔라 LT', 'G80 3.5 터보 AWD', '기아 K5 DL3 가솔린', '현대 K5', '한국GM 트랙스', '쉐보레 트레일블레이저',
  '르노코리아 아르카나', '그랜저 하이브리드', '코나 일렉트릭', '현대 캐스퍼 일렉트릭', '제네시스 GV80', 'BMW 5시리즈', 'KGM 토레스', '기아 레이', '현대 아반떼 하이브리드 1.6',
  '벤츠 E 클래스', '아이오닉 6', '그랜저 IG 3.0 프레스티지', '기아 봉고 3', '지프 랭글러', '폭스바겐 제타', '테슬라 모델 3', '메르세데스 마이바흐 S', '서울 현대 쏘나타',
  '아반떼 CN7', '썬팅 자외선 차단', '프리미엄 선루프'];
const VOCAB = buildRawNameVocabulary(seed(LEGIT));

const snapshot = (extra: Record<string, unknown>, others: Array<Record<string, unknown>> = seed(LEGIT)): CatalogCompatibilitySnapshot => ({
  schema: 'freepass-data.catalog-compat/v1',
  data: { products: { ...Object.fromEntries(others.map(o => [String(o._key), o])),
    P1: { _key: 'P1', product_code: 'P1', publicProductKey: 'P1', listable: true, provider_company_code: 'RP012', partner_code: 'RP012', whitelabels: ['uniplan'],
      maker: '현대', model: '아반떼', sub_model: '아반떼 CN7', trim_name: '모던', product_type: 'USED_SUBSCRIPTION', status_kind: '가용', policy_id: 'POLICY_PUBLIC',
      price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } }, ...extra } },
  policies: { POLICY_PUBLIC: { policy_name: 'PUBLIC_BASIC', insurance_included: true, annual_mileage: 20000 } }, partners: {}, users: {} },
  meta: { consumerId: 'erp-com', authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE', sourceProject: 'freepasserp5', observedAt: '2026-10-10T00:00:00.000Z',
    collectionCounts: { products: 1, policy: 1 }, depositEvidenceVersion: 'catalog-compat-deposit/1' },
}) as unknown as CatalogCompatibilitySnapshot;
const quote = (extra: Record<string, unknown>) => buildPublicProductQuote(snapshot(extra), 'P1', {})!.product as Record<string, unknown>;
const raw = (carName: string, product: Record<string, unknown> = {}) => sourceRawName({ car_name: carName, ...product }, VOCAB);
beforeEach(() => { process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW = '1'; });
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
    expect(refineState({ maker: '현대', model: '쏘나타', sub_model: '쏘나타', car_name: '쏘나타' }).refine_state).toBe('REFINED');
  });

  it('«확인 중» 같은 문자열은 매칭하지 않는다(소비처가 빈 칸일 때 보여 주는 값)', () => {
    expect(refineState({ maker: '현대', model: '아반떼', sub_model: '확인 중' }).refine_state).toBe('REFINED');
    expect(refineState({ maker: '', model: '', sub_model: '', trim_name: '' }).refine_state).toBe('PENDING');
  });

  it('원문.차명 대체, 아이카 제조사 접두(raw.original·headers/cells), 이미 제조사로 시작하면 중복 접두 없음', () => {
    expect(sourceRawName({ 원문: { 차명: '아반떼 CN7' } }, VOCAB)).toBe('아반떼 CN7');
    expect(sourceRawName({ car_name: 'K5 프레스티지', 원문: { source: { original: { 제조사: '기아' } } } }, VOCAB)).toBe('기아 K5 프레스티지');
    expect(sourceRawName({ car_name: 'K5', 원문: { source: { headers: ['배차상태', '제조사'], cells: ['출고가능', '기아'] } } }, VOCAB)).toBe('기아 K5');
    expect(sourceRawName({ car_name: '기아 K5', 원문: { source: { original: { 제조사: '기아' } } } }, VOCAB)).toBe('기아 K5');
    expect(sourceRawName({ car_name: '', 원문: {} }, VOCAB)).toBeNull();
  });

  it('개인정보·번호·금액 꼴·수수료 낱말이 걸리면 null, 길이 상한은 낱말 경계, % 는 허용(피드를 던지지 않음)', () => {
    for (const bad of ['쏘나타 12가3456', '문의 010-1234-5678', '아반떼 50만원', '수수료 포함 K5', '고객 홍길동 차']) expect(raw(bad), bad).toBeNull();
    const long = raw(`K5 ${'프레스티지 '.repeat(40)}`);
    expect(long).not.toBeNull();
    expect(long!.length).toBeLessThanOrEqual(140);
    expect(long!.endsWith('...')).toBe(true);   // NFKC: «…» → «...»
    const p = quote({ car_name: '썬팅 자외선 99% 차단 K5' });   // 전체 피드가 PUBLIC_FORBIDDEN_TEXT 로 던지지 않아야 한다
    expect(p.source_raw_name).toBe('썬팅 자외선 99% 차단 K5');
  });

  it('차량번호(구분기호·슬래시·괄호·기호 전부로 쪼갠 꼴)는 null', () => {
    for (const bad of ['K5 12가-3456', 'K5 12가 3456', 'K5 12가.3456', 'K5 123-하-4567', 'K5 12가/3456', 'K5 12가(3456)', 'K5 12가[3456]', 'K5 12-가-3456', 'K5 12가:3456', 'K5 123|하|4567']) {
      expect(raw(bad), bad).toBeNull();
    }
  });

  it('화이트리스트: 어휘 밖 낱말이 하나라도 있으면 null(인명·이모지·숫자 끼움·분리 자모·전화 꼴·허용어 문맥 우회 모두)', () => {
    const bad = ['K5 홍길동', '쏘나타 김철수 님', 'K5 (홍길동)', 'K5 홍길동님', 'K5 김철', 'K5 김철씨', 'K5 [김철]', 'K5 /홍길동', 'K5 홍·길·동', 'K5 홍 길 동', 'K5 -김철-',
      'K5 홍😀수진', 'K5 홍1수진', 'ㅎㅗㅇㄱㅣㄹㄷㅗㅇ', '010ㄱ1234ㄱ5678', 'K5 강원 씨', 'K5 Hong', 'K5 박 고객님'];
    for (const name of bad) expect(raw(name), name).toBeNull();
    expect(raw('K5 홍길동'.normalize('NFD'))).toBeNull();   // NFD 분해 우회
  });

  it('어휘 안의 정상 차명은 과차단 없이 나간다', () => {
    for (const ok of LEGIT) expect(raw(ok), ok).not.toBeNull();
    expect(raw('아반떼 2.0 터보 17인치 휠')).toBeNull();   // «휠» 이 어휘·제원 낱말 밖 → 보수적으로 null(과차단은 PENDING 확인 중)
    expect(raw('아반떼 2.0 터보 17인치')).not.toBeNull();
  });

  it('어휘를 못 받으면(단독 호출) 문서 자신의 정제 칸만 어휘로 쓴다 — 빈 어휘면 한글 낱말은 null(fail-closed)', () => {
    expect(sourceRawName({ car_name: '쏘나타' })).toBeNull();
    expect(sourceRawName({ car_name: '쏘나타 CN7', maker: '현대', model: '쏘나타', sub_model: '쏘나타 CN7' })).toBe('쏘나타 CN7');
    // 정제되지 않은(PENDING) 문서의 칸은 어휘에 넣지 않는다(원문 오염 방지)
    expect(buildRawNameVocabulary([{ maker: '', model: '쏘나타', sub_model: '홍길동' }]).size).toBe(0);
  });

  it('목록·상세 모두 포함, 플래그 기본 꺼짐이면 세 칸 없음, 계약 스키마 통과', () => {
    const feed = buildPublicProductFeed(snapshot({ car_name: 'K5' }), {});
    const item = (feed as unknown as { products: Array<Record<string, unknown>> }).products[0]!;
    expect(item.refine_state).toBe('REFINED');
    delete process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW;   // 기본 꺼짐
    const off = quote({ car_name: 'K5' });
    expect('source_raw_name' in off || 'refine_state' in off || 'refine_missing' in off).toBe(false);
    process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW = '1';
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(publicSchema);
    expect(validate(buildPublicProductFeed(snapshot({ car_name: '기아_K5_가솔린' }), {})), JSON.stringify(validate.errors)).toBe(true);
  });

  it('원문 플래그가 꺼지면 옵션 검증은 종전과 같다(% 이름은 개별로 버려지고 피드는 던지지 않음), 켜지면 허용', () => {
    const withOptions = { api_options_state: 'PRESENT', api_options_basic: [{ name: '자외선 99% 차단' }, { name: '전방 충돌방지' }], api_options_paid: [] };
    process.env.FREEPASS_DATA_PUBLIC_OPTIONS = '1';
    try {
      delete process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW;
      expect(quote(withOptions).option_basic).toEqual(['전방 충돌방지']);
      process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW = '1';
      expect(quote(withOptions).option_basic).toEqual(['자외선 99% 차단', '전방 충돌방지']);
    } finally { delete process.env.FREEPASS_DATA_PUBLIC_OPTIONS; }
  });
});
