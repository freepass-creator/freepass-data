import { describe, expect, it } from 'vitest';
import { buildFirstRegistrationPlan, judgeFirstRegistration } from '../src/domain/first-registration-normalize.js';

const NOW = Date.UTC(2026, 9, 23);
const j = (v: unknown, y: unknown = 2022) => judgeFirstRegistration(v, y, NOW);

describe('judgeFirstRegistration', () => {
  it('빈 칸은 대상이 아니다', () => { expect(j(null)).toBeNull(); expect(j('  ')).toBeNull(); expect(j(undefined)).toBeNull(); });
  it('표준 형식은 유지하고 정밀도만 단다', () => {
    expect(j('2022-03-15')).toEqual({ kind: 'KEEP', to: '2022-03-15', precision: 'day' });
    expect(j('2022-03')).toEqual({ kind: 'KEEP', to: '2022-03', precision: 'month' });
    expect(j('2022')).toEqual({ kind: 'KEEP', to: '2022', precision: 'year' });
  });
  it('월만 있는 한 자리 월은 월 정밀도로 맞추고 날을 지어내지 않는다', () => {
    expect(j('2022-3')).toMatchObject({ kind: 'NORMALIZE', to: '2022-03', precision: 'month' });
    expect(j('22-03', 2022)).toMatchObject({ kind: 'NORMALIZE', to: '2022-03', precision: 'month' });
  });
  it('점 구분·두 자리 연도 날짜를 YYYY-MM-DD 로 맞춘다(연식 ±1 안일 때만)', () => {
    expect(j('2022.3.5')).toMatchObject({ kind: 'NORMALIZE', to: '2022-03-05', precision: 'day' });
    expect(j('22.03.05', 2022)).toMatchObject({ kind: 'NORMALIZE', to: '2022-03-05' });
    expect(j('21-12-31', 2022)).toMatchObject({ kind: 'NORMALIZE', to: '2021-12-31' });
    expect(j('18-03-05', 2022)).toEqual({ kind: 'HOLD', reason: 'TWO_DIGIT_YEAR_CONFLICTS_MODEL_YEAR' });
  });
  it('연식이 없으면 두 자리 연도는 20YY 로 단정하지 않는다 — 연식 없음은 충돌 검사를 건너뛴다(보수적으로 허용 안 함)', () => {
    expect(j('22-03', null)).toEqual({ kind: 'HOLD', reason: 'TWO_DIGIT_YEAR_CONFLICTS_MODEL_YEAR' });
  });
  it('미래·잘못된 날짜는 보류, 날짜가 아닌 문자열은 비운다', () => {
    expect(j('26-11', 2026)).toEqual({ kind: 'HOLD', reason: 'FUTURE_DATE' });
    expect(j('2022-13')).toEqual({ kind: 'HOLD', reason: 'INVALID_MONTH' });
    expect(j('2022-02-30')).toEqual({ kind: 'HOLD', reason: 'INVALID_DATE' });
    expect(j('흰색')).toMatchObject({ kind: 'CLEAR' });
    expect(j('2022년식')).toEqual({ kind: 'HOLD', reason: 'UNRECOGNIZED_FORMAT' });
    expect(j('2024/01/02')).toMatchObject({ kind: 'NORMALIZE', to: '2024-01-02' });
    expect(j('20240102')).toMatchObject({ kind: 'NORMALIZE', to: '2024-01-02' });
    expect(j('2099-1')).toEqual({ kind: 'HOLD', reason: 'FUTURE_DATE' });
    expect(j('2099-01-01')).toEqual({ kind: 'HOLD', reason: 'FUTURE_DATE' });
    expect(j(12345)).toEqual({ kind: 'HOLD', reason: 'NOT_A_STRING' });
  });
});

describe('buildFirstRegistrationPlan', () => {
  const doc = (id: string, data: Record<string, unknown>) => ({ id, updateTimeMs: 1, data: { listable: true, year: 2022, ...data } });
  it('원문은 건드리지 않고 정리값만 패치하며 이전 값을 남긴다', () => {
    const plan = buildFirstRegistrationPlan({ nowMs: NOW, products: [
      doc('a', { first_registration_date: '2022-03-15' }), doc('b', { first_registration_date: '2022-3' }), doc('c', { first_registration_date: '흰색' }),
      doc('d', { first_registration_date: '2022-03-15', first_registration_date_precision: 'day' }), doc('e', {}), doc('f', { first_registration_date: '26-11', year: 2026 }),
      doc('g', { first_registration_date: '2022-3', locked_by_contract: true }), { id: 'h', updateTimeMs: 1, data: { listable: false, first_registration_date: '2022-3' } } ] });
    expect(plan.summary).toEqual({ toWrite: 3, tag: 1, normalize: 1, clear: 1, held: 1, skipped: 1, deletes: 0 });
    const b = plan.patches.find(p => p.id === 'b')!;
    expect(b.patch).toMatchObject({ first_registration_date: '2022-03', first_registration_date_precision: 'month', first_registration_date_correction: { before: '2022-3', reason: 'FORMAT_NORMALIZED' } });
    const c = plan.patches.find(p => p.id === 'c')!;
    expect(c.patch).toMatchObject({ first_registration_date: null, first_registration_date_precision: null, first_registration_date_correction: { before: '흰색' } });
    expect(plan.patches.find(p => p.id === 'a')!.verdict).toBe('TAG');
    expect(plan.patches.find(p => p.id === 'd')).toBeUndefined();   // 이미 정밀도 표시가 있는 문서는 다시 쓰지 않는다
  });
  it('같은 입력이면 digest 가 같고 입력이 바뀌면 달라진다', () => {
    const p = [doc('b', { first_registration_date: '2022-3' })];
    const a = buildFirstRegistrationPlan({ nowMs: NOW, products: p }), b = buildFirstRegistrationPlan({ nowMs: NOW, products: p });
    expect(a.planDigest).toBe(b.planDigest);
    expect(buildFirstRegistrationPlan({ nowMs: NOW, products: [{ ...p[0]!, updateTimeMs: 2 }] }).planDigest).not.toBe(a.planDigest);
  });
});
