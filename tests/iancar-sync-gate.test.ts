import { describe, expect, it } from 'vitest';
import { checkIancarSyncExpect } from '../src/domain/iancar-sync-gate.js';

const plan = { created: 6, absenceHeld: 12, withdrawalHoldsReleased: 8, open: 96, deletes: 0, contractChanges: 0, skippedCount: 1 };
const good = { created: [5, 6], absenceHeld: [12, 12], withdrawalHoldsReleased: [8, 8], open: [95, 97], deletes: [0, 0], contractChanges: [0, 0], skippedCount: [0, 1] };
const run = (expectValue: unknown, p: Record<string, unknown> = plan) => checkIancarSyncExpect(expectValue === undefined ? undefined : typeof expectValue === 'string' ? expectValue : JSON.stringify(expectValue), p);

describe('이안카 단발 적용 건수 관문 (fail-closed)', () => {
  it('모든 필수 범위 안이면 통과', () => expect(run(good)).toEqual({ ok: true }));
  it.each([['미설정', undefined], ['빈 문자열', ''], ['공백', '   '], ['JSON 아님', 'abc'], ['배열', '[]'], ['null', 'null'], ['빈 객체', {}]])('%s → 중단', (_name, value) => {
    expect(run(value as any).ok).toBe(false);
  });
  it('일부 키만 지정하면 나머지 필수 조건 누락으로 중단', () => {
    const r = run({ created: [5, 6] });
    expect(r.ok).toBe(false);
    expect((r as any).reasons).toEqual(expect.arrayContaining(['EXPECT_RANGE_INVALID:absenceHeld', 'EXPECT_RANGE_INVALID:deletes']));
  });
  it.each([[[]], [[1]], [[1, 2, 3]], [[2, 1]], [[-1, 5]], [[1.5, 2]], [['1', '2']], [[null, 3]], [[NaN, 3]], [[0, Infinity]]])('잘못된 범위 %j → 중단', range => {
    expect(run({ ...good, created: range }).ok).toBe(false);
  });
  it('모르는 키가 있으면 중단', () => expect(run({ ...good, extra: [0, 1] }).ok).toBe(false));
  it('범위 밖·계획 값 NaN/누락/음수/소수는 중단', () => {
    expect(run(good, { ...plan, created: 7 })).toMatchObject({ ok: false, reasons: ['OUT_OF_RANGE:created=7'] });
    for (const bad of [Number.NaN, undefined, -1, 1.5, '6', Infinity]) expect(run(good, { ...plan, created: bad }).ok).toBe(false);
    const missing: Record<string, unknown> = { ...plan }; delete missing.contractChanges;
    expect(run(good, missing).ok).toBe(false);
  });
  it('삭제·계약변경이 0이 아니면 중단', () => {
    expect(run(good, { ...plan, deletes: 1 }).ok).toBe(false);
    expect(run(good, { ...plan, contractChanges: 1 }).ok).toBe(false);
  });
  it('중복 키는 마지막 값으로 덮이지 않고 중단한다', () => {
    const dup = '{"created":[5,6],"absenceHeld":[12,12],"withdrawalHoldsReleased":[8,8],"open":[95,97],"deletes":[0,0],"contractChanges":[0,0],"skippedCount":[0,1],"deletes":[0,1]}';
    expect(run(dup, { ...plan, deletes: 1 })).toEqual({ ok: false, reasons: ['DUPLICATE_KEY:deletes'] });
    expect(run(dup)).toEqual({ ok: false, reasons: ['DUPLICATE_KEY:deletes'] });
    // 이스케이프로 철자만 다른 같은 키도 같은 키로 본다(e = e).
    const escaped = JSON.stringify(good).slice(0, -1) + ',"delet\\u0065s":[0,1]}';
    expect(run(escaped, { ...plan, deletes: 1 })).toEqual({ ok: false, reasons: ['DUPLICATE_KEY:deletes'] });
    // 키가 한 번씩이면 영향 없음
    expect(run(JSON.stringify(good))).toEqual({ ok: true });
  });
});
