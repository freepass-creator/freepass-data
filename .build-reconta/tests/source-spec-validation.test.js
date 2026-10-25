import { describe, expect, it } from 'vitest';
import { validateSourceSpec } from '../src/domain/source-spec-validation.js';
import { planSourceCycle } from '../src/application/source-cycle.js';
// 규격 검증(대표 2026-10-16 승인): 쓰기 직전 순수 검증, 위반 칸만 보류·원문 보존. 값은 합성.
const time = '2026-10-16T09:00:00.000Z', now = Date.parse('2026-10-16T09:05:00.000Z');
const rec = (plate, spec = {}, deposit = 1_000_000) => ({
    sourceId: 'RP012', uid: plate, plate, vehicleText: '기아 타스만', status: { raw: '출고가능', saleAvailable: true }, observedAt: time, vehicleHold: [],
    raw: { source: 'sonogong-partner-api', product_type: '중고렌트', list: { fuel: 'GSL', mileageKm: 7113 }, spec: { fuel_type: '가솔린', year: '2026', engine_cc: '2497', mileage: '7113', ...spec } },
    terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 700000 }, deposit: deposit === null ? { state: 'UNKNOWN', value: null } : { state: 'KNOWN', value: deposit }, mileage: null, raw: { priceType: 'RENT_RETURN' } }]
});
describe('validateSourceSpec(순수)', () => {
    it('위반 없음: 같은 레코드를 그대로 돌려준다', () => {
        const r = rec('11가1111');
        const out = validateSourceSpec(r);
        expect(out.violations).toEqual([]);
        expect(out.record).toBe(r);
    });
    it('연료 표기·배기량 단위·연식 자리수·최초등록 날짜·보증금 원 단위: 위반 칸만 빠지고 원문은 보존된다', () => {
        const r = rec('11가1111', { fuel_type: 'GSL', engine_cc: '2.5', year: '26', first_registration_date: '2026-02-31', ext_color: '빨간색' }, 100);
        const out = validateSourceSpec(r);
        expect(out.violations.map(v => v.field).sort()).toEqual(['deposit', 'engine_cc', 'first_registration_date', 'fuel_type', 'year']);
        const spec = out.record.raw.spec;
        expect(spec).toEqual({ mileage: '7113', ext_color: '빨간색' }); // 위반 칸만 보류
        expect(out.record.terms[0].deposit).toEqual({ state: 'UNKNOWN', value: null });
        expect(out.record.terms[0].raw.deposit_rejected).toBe(100); // 원천 값은 항의 raw 에만
        expect(out.record.raw.list).toEqual(r.raw.list); // 원문 비접촉
        expect(r.raw.spec.fuel_type).toBe('GSL'); // 입력 불변(복사본)
    });
    it('허용 값 밖: 전기·수소 차의 배기량, 숫자 아닌 인승, 너무 긴 색', () => {
        const out = validateSourceSpec(rec('11가1111', { fuel_type: '전기', engine_cc: '1600', seats: '다섯', ext_color: '가'.repeat(25) }));
        expect(out.violations.map(v => v.field).sort()).toEqual(['engine_cc', 'ext_color', 'seats']);
        expect(out.record.raw.spec.fuel_type).toBe('전기');
    });
    it('보증금: 0 과 정상 금액은 통과, 1만원 미만 양수·1억 초과는 위반', () => {
        expect(validateSourceSpec(rec('11가1111', {}, 0)).violations).toEqual([]);
        expect(validateSourceSpec(rec('11가1111', {}, 9_999)).violations.map(v => v.field)).toEqual(['deposit']);
        expect(validateSourceSpec(rec('11가1111', {}, 100_000_001)).violations.map(v => v.field)).toEqual(['deposit']);
        expect(validateSourceSpec(rec('11가1111', {}, 10_000)).violations).toEqual([]);
    });
});
describe('계획 단계: 기본 꺼짐·경고 줄·20% 초과 회차 보류', () => {
    const plan = (records, specValidation) => planSourceCycle({ sourceId: 'RP012', family: 'OTHER', maxDowngradeRatio: 1, ...(specValidation ? { specValidation: true } : {}) }, { records, observedAt: time, heldCount: 0, complete: true }, { products: [], complete: true }, now);
    it('꺼짐이면 아무것도 바꾸지 않는다', () => {
        const built = plan([rec('11가1111', { fuel_type: 'GSL' })], false);
        expect(built.plan.warnings.some(w => w.startsWith('SPEC_VIOLATION'))).toBe(false);
        expect(built.plan.entries[0].after.record.raw.spec.fuel_type).toBe('GSL');
    });
    it('켜지면 위반 칸만 뺀 레코드로 계획하고 필드별 건수 경고를 남긴다(번호 없음)', () => {
        const records = [rec('11가1111', { fuel_type: 'GSL' }), ...Array.from({ length: 9 }, (_, i) => rec(`22나${2000 + i}`))];
        const built = plan(records, true);
        expect(built.plan.warnings).toContain('SPEC_VIOLATION:fuel_type:1');
        expect(built.plan.blockers).not.toContain('SPEC_FORMAT_DRIFT'); // 10% — 한도 안
        const violated = built.plan.entries.find(e => e.after.record.plate === '11가1111');
        expect(violated.after.record.raw.spec.fuel_type).toBeUndefined();
        expect(JSON.stringify(built.plan.warnings)).not.toContain('11가');
    });
    it('위반이 읽은 차의 20% 를 넘으면(최소 5건) SPEC_FORMAT_DRIFT 로 회차를 보류한다', () => {
        const records = [...Array.from({ length: 6 }, (_, i) => rec(`33다${3000 + i}`, { year: '26' })), ...Array.from({ length: 4 }, (_, i) => rec(`44라${4000 + i}`))];
        const built = plan(records, true);
        expect(built.plan.blockers).toContain('SPEC_FORMAT_DRIFT');
        // 4건(5건 미만)은 비율이 높아도 소수라 보류하지 않는다
        const few = plan([...Array.from({ length: 4 }, (_, i) => rec(`55마${5000 + i}`, { year: '26' })), rec('66바6666')], true);
        expect(few.plan.blockers).not.toContain('SPEC_FORMAT_DRIFT');
    });
});
