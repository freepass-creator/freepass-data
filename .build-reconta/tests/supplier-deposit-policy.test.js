import { describe, expect, it } from 'vitest';
import { computeSupplierRuleDeposit, contractYearsMultiplierMax3, preservedDepositOf, supplierDepositPolicy, supplierDepositRuleFor } from '../src/domain/supplier-deposit-policy.js';
import { depositEvidenceInputFromProduct, depositFromYearsRuleNote, resolveDepositWithRuleNote } from '../src/domain/deposit-evidence.js';
import { withCompatibilityDepositEvidence } from '../src/infra/erp5-compat-catalog-reader.js';
import { calculatedDepositFields, nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
import { planSourceCycle } from '../src/application/source-cycle.js';
const RULE = 'RENT_X_CONTRACT_YEARS_MAX3';
describe('공급사 정책 정제 표', () => {
    it('손오공: 중고렌트 = 원문 금액, 구독·픽업구독 = 월 대여료×약정연수(최대 3개월), 오토플러스 = 시트 규칙', () => {
        expect(supplierDepositPolicy('RP012', 'rent')).toMatchObject({ deposit: 'SOURCE_AMOUNT' });
        expect(supplierDepositPolicy('RP012', 'sub')).toMatchObject({ deposit: 'RULE', rules: [RULE] });
        expect(supplierDepositPolicy('RP012', 'pick')).toMatchObject({ deposit: 'RULE', rules: [RULE] });
        expect(supplierDepositPolicy('RP023', '오플구독')).toMatchObject({ deposit: 'RULE', rules: ['AUTOPLUS_RENT_X2_DOMESTIC', 'AUTOPLUS_RENT_X3_IMPORT'] });
        expect(supplierDepositPolicy('RP005', 'rent')).toBeNull();
    });
    it('약정연수 배수: 12 ×1, 24 ×2, 36·48·60 ×3, 12의 배수가 아니면 계산하지 않는다', () => {
        expect([12, 24, 36, 48, 60].map(contractYearsMultiplierMax3)).toEqual([1, 2, 3, 3, 3]);
        expect([0, 6, 18, -12, '24', null].map(contractYearsMultiplierMax3)).toEqual([null, null, null, null, null, null]);
        expect(computeSupplierRuleDeposit(RULE, 24, 500000)).toEqual({ amount: 1000000, multiplier: 2 });
        expect(computeSupplierRuleDeposit(RULE, 36, 500000)?.amount).toBe(1500000);
        expect(computeSupplierRuleDeposit(RULE, 48, 500000)?.amount).toBe(1500000);
        expect(computeSupplierRuleDeposit(RULE, 24, 0)).toBeNull();
        expect(computeSupplierRuleDeposit('AUTOPLUS_RENT_X3_IMPORT', 12, 770000)).toEqual({ amount: 2310000, multiplier: 3 });
        // 비고 문구 해석도 같은 계산 하나를 쓴다(중복 없음)
        expect(depositFromYearsRuleNote('월 대여료 × 약정연수 (최대 3개월)', 48, 500000)).toEqual({ amount: 1500000, multiplier: 3 });
    });
    it('규칙 코드는 그 공급사의 것일 때만 근거다', () => {
        expect(supplierDepositRuleFor('RP012', RULE)).toBe(RULE);
        expect(supplierDepositRuleFor('RP023', RULE)).toBeNull();
        expect(supplierDepositRuleFor('RP012', 'AUTOPLUS_RENT_X2_DOMESTIC')).toBeNull();
        expect(supplierDepositRuleFor('RP005', RULE)).toBeNull();
    });
    it('엔진 보존: 이전 KNOWN 은 규칙 코드와 함께, RP012 의 옛 ZERO(자리채움)는 보존하지 않는다', () => {
        expect(preservedDepositOf('RP012', { deposit: { state: 'KNOWN', value: 1000000 }, raw: { deposit_rule: RULE } }))
            .toEqual({ deposit: { state: 'KNOWN', value: 1000000 }, depositRule: RULE });
        expect(preservedDepositOf('RP012', { deposit: { state: 'KNOWN', value: 700000 }, raw: {} })).toEqual({ deposit: { state: 'KNOWN', value: 700000 }, depositRule: null });
        expect(preservedDepositOf('RP012', { deposit: { state: 'ZERO', value: 0 }, raw: {} })).toBeNull();
        expect(preservedDepositOf('RP018', { deposit: { state: 'ZERO', value: 0 }, raw: {} })).toEqual({ deposit: { state: 'ZERO', value: 0 }, depositRule: null });
    });
});
const term = (months, rent, deposit, raw = {}) => ({ months, monthlyRent: { state: 'KNOWN', value: rent }, deposit, mileage: null, raw });
const rp012 = (tab, terms) => ({ sourceId: 'RP012', uid: '100하1111', plate: '100하1111',
    vehicleText: '현대 아반떼', status: { raw: '출고가능', saleAvailable: true }, observedAt: '2026-10-14T06:00:00.000Z',
    raw: { source: 'sonogong-partner-api', tab, product_type: { rent: '중고렌트', sub: '오공구독', pick: '픽업구독' }[tab] }, terms, vehicleHold: [] });
const write = (r) => nativeCycleFields({ record: r, listable: true, locked_by_contract: false,
    publication_withdrawal: null, publication_withdrawal_prior: null });
const resolveTerm = (doc, months, rent) => {
    const row = doc.price[String(months)];
    return resolveDepositWithRuleNote(depositEvidenceInputFromProduct(doc, row.deposit, { termMonths: months, monthlyRent: rent }));
};
describe('손오공(RP012) 엔진 쓰기 → 표시', () => {
    const sub = rp012('sub', [term(12, 500000, { state: 'KNOWN', value: 500000 }, { deposit_rule: RULE }),
        term(24, 500000, { state: 'KNOWN', value: 1000000 }, { deposit_rule: RULE }), term(36, 500000, { state: 'KNOWN', value: 1500000 }, { deposit_rule: RULE })]);
    it('구독 24개월 대여료 500,000 → 보증금 1,000,000 KNOWN(계산값, CALCULATED_RULE)', () => {
        const fields = write(sub);
        expect(fields).toMatchObject({ deposit_source: 'CALCULATED', deposit_rules: { '12': RULE, '24': RULE, '36': RULE }, deposit_rule: null,
            price: { '24': { rent: 500000, deposit: 1000000 } }, product_type: '오공구독' });
        const doc = { ...fields };
        expect(resolveTerm(doc, 24, 500000)).toMatchObject({ state: 'KNOWN', amount: 1000000, reason: `CALCULATED_RULE:${RULE}`, rule: { code: RULE, multiplier: 2 } });
        expect(resolveTerm(doc, 36, 500000)).toMatchObject({ state: 'KNOWN', amount: 1500000, rule: { multiplier: 3 } });
        const compat = withCompatibilityDepositEvidence(doc);
        expect(compat.price['24']).toMatchObject({ deposit: 1000000, depositState: 'KNOWN', depositStatusLabel: '보증금 있음' });
    });
    it('대여료가 바뀌어 계산값과 맞지 않으면 UNKNOWN(공급사 금액으로 둔갑하지 않는다)', () => {
        const doc = { ...write(sub) };
        expect(resolveTerm(doc, 24, 550000)).toMatchObject({ state: 'UNKNOWN', reason: 'CALCULATED_DEPOSIT_RULE_MISMATCH' });
    });
    it('중고렌트 원문 양수 금액은 계산 표식 없이 SOURCE_AMOUNT, 이전 구독 표식이 남지 않는다(항마다 표식)', () => {
        const rent = rp012('rent', [term(24, 500000, { state: 'KNOWN', value: 3000000 }), term(36, 450000, { state: 'UNKNOWN', value: null })]);
        const fields = write(rent);
        expect(fields).toMatchObject({ deposit_source: null, deposit_rules: null, deposit_rule: null });
        const doc = { ...write(sub), ...fields };
        expect(resolveTerm(doc, 24, 500000)).toMatchObject({ state: 'KNOWN', amount: 3000000, reason: 'SOURCE_AMOUNT' });
        // 한 문서 안에 원문 금액 항과 계산 항이 섞여도 항마다 맞다
        const mixed = write(rp012('sub', [term(12, 500000, { state: 'KNOWN', value: 800000 }), term(24, 500000, { state: 'KNOWN', value: 1000000 }, { deposit_rule: RULE })]));
        expect(mixed.deposit_rules).toEqual({ '24': RULE });
        expect(resolveTerm(mixed, 12, 500000)).toMatchObject({ state: 'KNOWN', amount: 800000, reason: 'SOURCE_AMOUNT' });
        expect(resolveTerm(mixed, 24, 500000)).toMatchObject({ state: 'KNOWN', reason: `CALCULATED_RULE:${RULE}` });
    });
    it('엔진이 쓰지 않은 문서·다른 공급사·RP012 에 오토플러스 규칙은 근거가 아니다', () => {
        const doc = { ...write(sub) };
        expect(resolveTerm({ ...doc, source_cycle_write: { by: 'erp4' } }, 24, 500000).reason).toBe('SOURCE_AMOUNT');
        expect(resolveTerm({ ...doc, provider_company_code: 'RP005' }, 24, 500000).reason).toBe('SOURCE_AMOUNT');
        expect(resolveTerm({ ...doc, deposit_rules: { '24': 'AUTOPLUS_RENT_X2_DOMESTIC' } }, 24, 500000).reason).toBe('SOURCE_AMOUNT');
        expect(calculatedDepositFields({ ...sub, sourceId: 'RP005' })).toEqual({});
    });
    it('계산 항이 없는 RP012 중고렌트 0(자리채움)은 표시에서 무보증이 아니다', () => {
        const doc = { ...write(rp012('rent', [term(24, 500000, { state: 'UNKNOWN', value: null })])) };
        expect(resolveTerm({ ...doc, price: { '24': { rent: 500000, deposit: 0 } } }, 24, 500000).state).toBe('UNKNOWN');
    });
});
describe('엔진 계획: 보존과 정책 정제', () => {
    const config = { sourceId: 'RP012', family: 'OTHER', maxDowngradeRatio: 0.5 };
    const now = Date.parse('2026-10-14T06:10:00.000Z');
    const stored = (r) => ({ record: { ...structuredClone(r), observedAt: '2026-10-14T05:00:00.000Z' }, listable: true,
        locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null,
        supplierFields: { provider_name: '손오공', policy_code: null } });
    const plan = (before, next) => planSourceCycle(config, { records: [next], complete: true, observedAt: next.observedAt, heldCount: 0 }, { complete: true, products: [stored(before)] }, now).plan;
    it('중고렌트 API 0 → UNKNOWN 이고 옛 ZERO(잘못 매핑된 무보증)를 보존하지 않는다', () => {
        const p = plan(rp012('rent', [term(24, 500000, { state: 'ZERO', value: 0 })]), rp012('rent', [term(24, 500000, { state: 'UNKNOWN', value: null })]));
        expect(p.warnings.some(w => w.startsWith('DEPOSIT_PRESERVED'))).toBe(false);
        expect(p.entries[0].after.record.terms[0].deposit).toEqual({ state: 'UNKNOWN', value: null });
    });
    it('UNKNOWN 은 이전 KNOWN 계산값을 지우지 않고 규칙 코드도 함께 남긴다(표식과 금액이 항마다 짝)', () => {
        const before = rp012('sub', [term(24, 500000, { state: 'KNOWN', value: 1000000 }, { deposit_rule: RULE })]);
        const next = rp012('sub', [term(24, 500000, { state: 'UNKNOWN', value: null }), term(36, 500000, { state: 'KNOWN', value: 1500000 }, { deposit_rule: RULE })]);
        const p = plan(before, next);
        expect(p.warnings).toContain('DEPOSIT_PRESERVED:1');
        const after = p.entries[0].after.record;
        expect(after.terms.map(t => [t.months, t.deposit.value, t.raw.deposit_rule])).toEqual([[24, 1000000, RULE], [36, 1500000, RULE]]);
        expect(calculatedDepositFields(after)).toMatchObject({ deposit_rules: { '24': RULE, '36': RULE } });
    });
});
