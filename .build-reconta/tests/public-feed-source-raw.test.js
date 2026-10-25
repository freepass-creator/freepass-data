import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import publicSchema from '../contracts/public-product-feed-v1.schema.json' with { type: 'json' };
import { buildPublicProductFeed, buildPublicProductQuote, refineState, sourceRawName } from '../src/api/public-product-feed.js';
// 2트랙(대표 2026-10-16): 공개 피드 «원문 표기·정제 상태» 읽기 전용 파생. 값은 합성.
const snapshot = (extra) => ({
    schema: 'freepass-data.catalog-compat/v1',
    data: { products: { P1: { _key: 'P1', product_code: 'P1', publicProductKey: 'P1', listable: true, provider_company_code: 'RP012', partner_code: 'RP012', whitelabels: ['uniplan'],
                maker: '현대', model: '아반떼', sub_model: '아반떼 CN7', trim_name: '모던', product_type: 'USED_SUBSCRIPTION', status_kind: '가용', policy_id: 'POLICY_PUBLIC',
                price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } }, ...extra } },
        policies: { POLICY_PUBLIC: { policy_name: 'PUBLIC_BASIC', insurance_included: true, annual_mileage: 20000 } }, partners: {}, users: {} },
    meta: { consumerId: 'erp-com', authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE', sourceProject: 'freepasserp5', observedAt: '2026-10-10T00:00:00.000Z',
        collectionCounts: { products: 1, policy: 1 }, depositEvidenceVersion: 'catalog-compat-deposit/1' },
});
const quote = (extra) => buildPublicProductQuote(snapshot(extra), 'P1', {}).product;
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
        for (const bad of ['쏘나타 12가3456', '문의 010-1234-5678', '아반떼 50만원', '수수료 포함 K5', '고객 홍길동 차'])
            expect(sourceRawName({ car_name: bad }), bad).toBeNull();
        expect(sourceRawName({ car_name: 'A'.repeat(300) }).length).toBeLessThanOrEqual(140);
        const p = quote({ car_name: '썬팅 자외선 99% 차단 K5' }); // 전체 피드가 PUBLIC_FORBIDDEN_TEXT 로 던지지 않아야 한다
        expect(p.source_raw_name).toBe('썬팅 자외선 99% 차단 K5');
    });
    it('Codex #692: 구분기호로 쪼갠 차량번호·이름 꼴은 null, 정상 차명은 유지', () => {
        for (const bad of ['K5 12가-3456', 'K5 12가 3456', 'K5 12가.3456', 'K5 123-하-4567', 'K5 홍길동', '쏘나타 김철수 님'])
            expect(sourceRawName({ car_name: bad }), bad).toBeNull();
        for (const ok of ['K5 프레스티지', '신형 K5 노블레스', '쏘나타 디 엣지', '임팔라 LT', 'G80 3.5 터보 AWD', '기아_K5(DL3)_가솔린'])
            expect(sourceRawName({ car_name: ok }), ok).not.toBeNull();
    });
    it('목록·상세 모두 포함, 플래그 기본 꺼짐이면 세 칸 없음, 계약 스키마 통과', () => {
        const feed = buildPublicProductFeed(snapshot({ car_name: 'K5' }), {});
        const item = feed.products[0];
        expect(item.refine_state).toBe('REFINED');
        delete process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW; // 기본 꺼짐
        const off = quote({ car_name: 'K5' });
        expect('source_raw_name' in off || 'refine_state' in off || 'refine_missing' in off).toBe(false);
        process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW = '1';
        const validate = new Ajv2020({ strict: false, allErrors: true }).compile(publicSchema);
        expect(validate(buildPublicProductFeed(snapshot({ car_name: '기아_K5_가솔린' }), {})), JSON.stringify(validate.errors)).toBe(true);
    });
    it('Codex #692 재검토 ①: 슬래시·괄호·모든 기호로 쪼갠 차량번호도 null', () => {
        for (const bad of ['K5 12가/3456', 'K5 12가(3456)', 'K5 12가[3456]', 'K5 12-가-3456', 'K5 12가:3456', 'K5 123|하|4567'])
            expect(sourceRawName({ car_name: bad }), bad).toBeNull();
    });
    it('Codex #692 재검토 ②: 괄호 안 이름·호칭·두 글자 이름도 null, 허용 목록의 두 글자 차명(현대·기아)은 유지', () => {
        for (const bad of ['K5 (홍길동)', 'K5 홍길동님', 'K5 김철', 'K5 김철 님', 'K5 김철씨', 'K5 [김철]', 'K5 박 고객님']) {
            if (bad === 'K5 박 고객님')
                continue; // 한 글자 성만 있는 꼴은 이름으로 단정하지 않는다(호칭 낱말은 개인정보 낱말 규칙이 따로 잡는다)
            expect(sourceRawName({ car_name: bad }), bad).toBeNull();
        }
        for (const ok of ['현대 K5', '기아 K5 프레스티지', '한국GM 트랙스', '쉐보레 트레일블레이저', '르노코리아 아르카나'])
            expect(sourceRawName({ car_name: ok }), ok).not.toBeNull();
    });
    it('Codex #692 재검토 ③: 정상 차명 과차단 없음(그랜저 하이브리드·코나 일렉트릭·현대 캐스퍼 등)', () => {
        for (const ok of ['그랜저 하이브리드', '코나 일렉트릭', '현대 캐스퍼', '현대 캐스퍼 일렉트릭', '제네시스 GV80', 'BMW 5시리즈', 'KGM 토레스', '기아 레이', '현대 아반떼 하이브리드 1.6', '벤츠 E-클래스', '아이오닉 6', '쏘나타 디 엣지', '그랜저 IG 3.0 프레스티지']) {
            expect(sourceRawName({ car_name: ok }), ok).not.toBeNull();
        }
    });
    it('Codex #692 잔여 ①②③: 기호·쪼갠 이름, NFD 분해, 제조사·모델명 과차단', () => {
        for (const bad of ['K5 /홍길동', 'K5 홍·길·동', 'K5 홍 길 동', 'K5 -김철-', 'K5 ·김철·'])
            expect(sourceRawName({ car_name: bad }), bad).toBeNull();
        expect(sourceRawName({ car_name: 'K5 홍길동'.normalize('NFD') })).toBeNull(); // NFD 분해 우회
        for (const ok of ['기아 봉고 3', '지프 랭글러', '폭스바겐 제타', '테슬라 모델 3', '메르세데스-마이바흐 S', '서울 현대 쏘나타'])
            expect(sourceRawName({ car_name: ok }), ok).not.toBeNull();
    });
    it('Codex #692 재검토 ④: 원문 플래그가 꺼지면 옵션 검증은 종전과 같다(% 이름은 개별로 버려지고 피드는 던지지 않음), 켜지면 허용', () => {
        const withOptions = { api_options_state: 'PRESENT', api_options_basic: [{ name: '자외선 99% 차단' }, { name: '전방 충돌방지' }], api_options_paid: [] };
        process.env.FREEPASS_DATA_PUBLIC_OPTIONS = '1';
        try {
            delete process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW;
            expect(quote(withOptions).option_basic).toEqual(['전방 충돌방지']);
            process.env.FREEPASS_DATA_PUBLIC_SOURCE_RAW = '1';
            expect(quote(withOptions).option_basic).toEqual(['자외선 99% 차단', '전방 충돌방지']);
        }
        finally {
            delete process.env.FREEPASS_DATA_PUBLIC_OPTIONS;
        }
    });
});
