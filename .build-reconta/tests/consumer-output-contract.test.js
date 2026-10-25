import { describe, expect, it } from 'vitest';
import { F86_OUTPUT_CONTRACT, SONOKONG_DEPOSIT_RULE_TEXT, classifySonokongRecord, hasSonokongDepositRuleViolation, validateF86FeeColumns, selectF01PriceTerms } from '../src/domain/consumer-output-contract.js';
describe('consumer output contracts', () => {
    it('F01 selects only actual return tuples and never changes ERP5 source terms', () => {
        const term = (termKey, termMonths, mileageLimitKmPerYear) => ({ termKey, termMonths,
            settlement: (termKey.includes('_인수형') ? 'BUYOUT' : 'RETURN'),
            monthlyRent: { currency: 'KRW', amount: 700000 }, depositState: 'UNKNOWN', deposit: null, ...(mileageLimitKmPerYear === undefined ? {} : { mileageLimitKmPerYear }) });
        const terms = [term('1', 1), term('6', 6), term('12', 12), term('36_인수형', 36), term('72', 72), term('84', 84)];
        const before = structuredClone(terms);
        const result = selectF01PriceTerms({ supplierId: 'RP012', sourceRef: 'source:test#1', observedAt: '2026-10-17T00:00:00Z', terms });
        expect(result.cells.map(c => [c.months, c.rent])).toEqual([[1, 700000], [6, 700000], [12, 700000], [24, null], [36, null], [48, null], [60, null]]);
        expect(result.cells[0].deposit).toBeNull();
        expect(result.excluded.map(x => x.reason)).toEqual(['NOT_RETURN', 'PERIOD_EXCLUDED', 'PERIOD_EXCLUDED']);
        expect(terms).toEqual(before);
        const autoplus = selectF01PriceTerms({ supplierId: 'RP023', sourceRef: 'source:test#2', observedAt: '2026-10-17T00:00:00Z', terms: [term('12_2만', 12, 20000), term('24_3만', 24, 30000), term('36_월20000km', 36), term('48', 48), term('60_2만', 60, 30000)] });
        expect(autoplus.cells.filter(c => c.rent !== null).map(c => c.months)).toEqual([12]);
        expect(autoplus.excluded.map(x => x.reason)).toEqual(['AUTOPLUS_NOT_ANNUAL_20000', 'AUTOPLUS_NOT_ANNUAL_20000', 'AUTOPLUS_NOT_ANNUAL_20000', 'MILEAGE_CONFLICT']);
        const conflict = selectF01PriceTerms({ supplierId: 'RP023', sourceRef: 'source:test#3', observedAt: '2026-10-17T00:00:00Z', terms: [term('12_2만', 12), term('12_연20000km', 12)] });
        expect(conflict.cells.every(c => c.rent === null)).toBe(true);
        expect(conflict.excluded.map(x => x.reason)).toEqual(['MULTIPLE_SOURCE_TUPLES', 'MULTIPLE_SOURCE_TUPLES']);
        expect(conflict.cells.find(c => c.months === 12).state).toBe('HOLD');
        expect(conflict.cells.find(c => c.months === 6).state).toBe('ABSENT');
        const monthly = selectF01PriceTerms({ supplierId: 'RP031', sourceRef: 'source:test#4', observedAt: '2026-10-17T00:00:00Z', terms: [term('36_월1000km', 36)] });
        expect(monthly.cells.find(c => c.months === 36).contractedMileage).toEqual({ km: 1000, period: 'month' });
        const alias = selectF01PriceTerms({ supplierId: 'RP023', sourceRef: 'source:test#5', observedAt: '2026-10-17T00:00:00Z', terms: [term('12', 12, 20000)] });
        expect(alias.cells.find(c => c.months === 12)).toMatchObject({ state: 'READY', rent: 700000, contractedMileage: { km: 20000, period: 'year' } });
        for (const observedAt of ['2999-01-01T00:00:00Z', '2026-10-17T00:00']) {
            expect(selectF01PriceTerms({ supplierId: 'RP012', sourceRef: 'source:test#6', observedAt, terms }).cells.find(c => c.months === 1).state).toBe('HOLD');
        }
        const missing = selectF01PriceTerms({ supplierId: 'RP012', sourceRef: '', observedAt: '', terms });
        expect(missing.cells.every(c => c.rent === null)).toBe(true);
        expect(missing.cells.every(c => c.state === 'HOLD')).toBe(true);
        expect(result.cells[0]).toMatchObject({ sourceRef: 'source:test#1', observedAt: '2026-10-17T00:00:00Z' });
        for (const amount of [0, -1, 0.5]) {
            const invalid = { ...term('12', 12), monthlyRent: { currency: 'KRW', amount } };
            expect(selectF01PriceTerms({ supplierId: 'RP012', sourceRef: 'source:test', observedAt: '2026-10-17T00:00:00Z', terms: [invalid] }).cells.find(c => c.months === 12).reasons).toContain('RENT_UNCONFIRMED');
        }
        const unknown = { ...term('12', 12), settlement: 'UNKNOWN' };
        const wrongCurrency = { ...term('12', 12), monthlyRent: { currency: 'USD', amount: 700000 } };
        expect(selectF01PriceTerms({ supplierId: 'RP012', sourceRef: 'source:test', observedAt: '2026-10-17T00:00:00Z', terms: [wrongCurrency] }).cells.find(c => c.months === 12).reasons).toContain('RENT_UNCONFIRMED');
        expect(selectF01PriceTerms({ supplierId: 'RP012', sourceRef: 'source:test', observedAt: '2026-10-17T00:00:00Z', terms: [unknown] }).cells.find(c => c.months === 12).reasons).toContain('SETTLEMENT_EVIDENCE_MISSING');
        const conflicting = { ...term('12_인수형', 12), settlement: 'RETURN' };
        expect(selectF01PriceTerms({ supplierId: 'RP012', sourceRef: 'source:test', observedAt: '2026-10-17T00:00:00Z', terms: [conflicting] }).cells.find(c => c.months === 12).reasons).toContain('SETTLEMENT_CONFLICT');
        const wrongMonth = selectF01PriceTerms({ supplierId: 'RP012', sourceRef: 'source:test', observedAt: '2026-10-17T00:00:00Z', terms: [term('12', 12), term('12', 24)] });
        expect(wrongMonth.cells.find(c => c.months === 12).state).toBe('HOLD');
        const excludedWrongMonth = selectF01PriceTerms({ supplierId: 'RP012', sourceRef: 'source:test', observedAt: '2026-10-17T00:00:00Z', terms: [term('12', 12), term('12', 72)] });
        expect(excludedWrongMonth.cells.find(c => c.months === 12).reasons).toContain('TERM_KEY_UNRESOLVED');
        const depositMismatch = { ...term('12', 12), depositState: 'KNOWN', deposit: null };
        expect(selectF01PriceTerms({ supplierId: 'RP012', sourceRef: 'source:test', observedAt: '2026-10-17T00:00:00Z', terms: [depositMismatch] }).cells.find(c => c.months === 12))
            .toMatchObject({ rent: 700000, deposit: null, depositState: 'UNKNOWN' });
        expect(wrongMonth.cells.find(c => c.months === 24).state).toBe('HOLD');
    });
    it('separates Sonogong products from TCar pickup subscription', () => {
        const rent = classifySonokongRecord({ bucket: 'SON_NO_KONG', plateNumber: '123하4567' });
        const subscription = classifySonokongRecord({ bucket: 'SON_NO_KONG', plateNumber: '123가4567' });
        const pickup = classifySonokongRecord({ bucket: 'TCAR_EXTERNAL', plateNumber: '123나4567' });
        expect([rent, subscription, pickup].map((item) => item.supplierGroup)).toEqual([
            'SONOKONG', 'SONOKONG', 'SONOKONG'
        ]);
        expect([rent, subscription, pickup].map((item) => item.outputGroup)).toEqual([
            'SONOGONG_PRODUCTS', 'SONOGONG_PRODUCTS', 'PICKUP_SUBSCRIPTION'
        ]);
        expect(rent.status === 'CLASSIFIED' && rent.commercialType).toBe('USED_RENT');
        expect(subscription.status === 'CLASSIFIED' && subscription.commercialType).toBe('OGONG_SUBSCRIPTION');
        expect(pickup.status === 'CLASSIFIED' && pickup.commercialType).toBe('PICKUP_SUBSCRIPTION');
    });
    it('holds an unknown bucket or a missing plate instead of guessing', () => {
        expect(classifySonokongRecord({ bucket: 'UNKNOWN', plateNumber: '123하4567' })).toMatchObject({
            status: 'HOLD', outputGroup: 'HOLD', reason: 'UNKNOWN_SONOKONG_BUCKET'
        });
        expect(classifySonokongRecord({ bucket: 'SON_NO_KONG' })).toMatchObject({
            status: 'HOLD', outputGroup: 'HOLD', reason: 'MISSING_PLATE_FOR_RENT_DECISION'
        });
    });
    it('locks F86 to the retro supplier view and long-term fee columns', () => {
        expect(F86_OUTPUT_CONTRACT).toMatchObject({
            owner: 'freepass-data',
            presentation: 'RETRO',
            groupBy: 'SUPPLIER',
            minimumLongTermMonths: 24
        });
        expect(validateF86FeeColumns(F86_OUTPUT_CONTRACT.commonFeeColumns)).toEqual({
            status: 'PASS', violations: []
        });
        expect(validateF86FeeColumns(F86_OUTPUT_CONTRACT.supplierFeeColumns.RP012)).toEqual({
            status: 'PASS', violations: []
        });
        expect(validateF86FeeColumns(F86_OUTPUT_CONTRACT.supplierFeeColumns.RP023)).toEqual({
            status: 'PASS', violations: []
        });
    });
    it('owns the Sonokong deposit rule and blocks stale numeric deposits', () => {
        expect(SONOKONG_DEPOSIT_RULE_TEXT).toBe('월 대여료 × 약정연수 (최대 3개월)');
        expect(hasSonokongDepositRuleViolation({
            depositNote: SONOKONG_DEPOSIT_RULE_TEXT,
            productType: '오공구독',
            price: { '24': { deposit: 1 } }
        })).toBe(true);
        expect(hasSonokongDepositRuleViolation({
            depositNote: SONOKONG_DEPOSIT_RULE_TEXT,
            productType: '오공구독',
            price: { '24': { deposit: 0 } }
        })).toBe(false);
        expect(hasSonokongDepositRuleViolation({
            depositNote: SONOKONG_DEPOSIT_RULE_TEXT,
            productType: '중고렌트',
            price: { '24': { deposit: 1000000 } }
        })).toBe(false);
        expect(hasSonokongDepositRuleViolation({
            depositNote: '무보증',
            productType: '오공구독',
            price: { '24': { deposit: 1000000 } }
        })).toBe(false);
    });
    it('blocks short-term exceptions from F86, including supplier-specific columns', () => {
        expect(validateF86FeeColumns([
            '1개월', '6개월', '12개월', '12개월 반납형', '18개월 2만km', '24개월'
        ])).toEqual({
            status: 'HOLD',
            violations: [
                { column: '1개월', reason: 'F86_LONG_TERM_ONLY' },
                { column: '6개월', reason: 'F86_LONG_TERM_ONLY' },
                { column: '12개월', reason: 'F86_LONG_TERM_ONLY' },
                { column: '12개월 반납형', reason: 'F86_LONG_TERM_ONLY' },
                { column: '18개월 2만km', reason: 'F86_LONG_TERM_ONLY' }
            ]
        });
    });
});
