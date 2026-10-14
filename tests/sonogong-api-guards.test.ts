import { describe, expect, it } from 'vitest';
import { judgeSonogongApiRead, claimEnrollCapOnce, uniquePlateCount } from '../src/adapters/sonogong-api-guards.js';
import type { SonogongApiRead } from '../src/adapters/sonogong-api.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';

const rec = (plate: string): SourceProductRecord => ({ sourceId: 'RP012', uid: plate, plate, vehicleText: 'x', status: { raw: '출고가능', saleAvailable: true },
  terms: [], observedAt: '2026-10-14T06:00:00.000Z', raw: {}, vehicleHold: [] });
const read = (n: number, over: Partial<SonogongApiRead> = {}): SonogongApiRead => ({ observedAt: '2026-10-14T06:00:00.000Z', complete: true,
  tabsRead: ['rent', 'sub', 'pick'], records: Array.from({ length: n }, (_, i) => rec(`12가${1000 + i}`)), held: [], duplicatePlates: [],
  listed: n, detailsRead: n, notes: [], ...over });

describe('손오공 API 읽기 판정(#601 독립 검토 결함 ①②)', () => {
  it('① a shrunk read is incomplete and its count is NEVER saved as the new baseline', () => {
    const shrunk = judgeSonogongApiRead(read(60), { exposedUnlockedDocs: 100, previousCount: 100, stateError: null });
    expect(shrunk).toEqual({ complete: false, incompleteReason: 'API_SHRUNK', saveCount: null });
    // 그 뒤에도 기준은 100 그대로라 같은 축소 읽기가 다음 회차에 «정상»으로 통과하지 못한다
    expect(judgeSonogongApiRead(read(60), { exposedUnlockedDocs: 100, previousCount: 100, stateError: null }).complete).toBe(false);
    expect(judgeSonogongApiRead(read(95), { exposedUnlockedDocs: 100, previousCount: 100, stateError: null })).toEqual({ complete: true, saveCount: 95 });
  });

  it('① an incomplete raw read (detail failure etc.) never saves a baseline either', () => {
    const bad = judgeSonogongApiRead(read(100, { complete: false, incompleteReason: 'API_DETAIL_FAILED' }), { exposedUnlockedDocs: 100, previousCount: 100, stateError: null });
    expect(bad).toEqual({ complete: false, incompleteReason: 'API_DETAIL_FAILED', saveCount: null });
  });

  it('② the floor counts unique plates: cross-tab duplicate rows (listed) cannot push a short unique list over the floor', () => {
    // 목록 행은 120(탭 간 중복 포함) 이지만 고유 번호는 70 → 기준 100 의 80% = 80 미만이라 불완전
    const dupHeavy = read(70, { listed: 120, notes: ['CROSS_TAB_DUPLICATE:50'] });
    expect(uniquePlateCount(dupHeavy)).toBe(70);
    expect(judgeSonogongApiRead(dupHeavy, { exposedUnlockedDocs: 100, previousCount: 100, stateError: null })).toEqual({ complete: false, incompleteReason: 'API_SHRUNK', saveCount: null });
    // 고유 번호 수로 저장한다(listed 가 아니다)
    expect(judgeSonogongApiRead(read(90, { listed: 140 }), { exposedUnlockedDocs: 100, previousCount: 100, stateError: null })).toEqual({ complete: true, saveCount: 90 });
  });

  it('a damaged baseline fails only this cycle and recovers the count from a read that clears the exposed-document floor', () => {
    expect(judgeSonogongApiRead(read(95), { exposedUnlockedDocs: 100, previousCount: 0, stateError: 'API_COUNT_STATE_INVALID' }))
      .toEqual({ complete: false, incompleteReason: 'API_COUNT_STATE_INVALID', saveCount: 95 });
    // 노출 문서 하한도 못 넘는 읽기로는 복구 저장하지 않는다
    expect(judgeSonogongApiRead(read(40), { exposedUnlockedDocs: 100, previousCount: 0, stateError: 'API_COUNT_STATE_INVALID' }))
      .toMatchObject({ complete: false, saveCount: null });
  });
});

describe('한 회차 한정 편입 상한 표식(#601 독립 검토 결함 ③)', () => {
  const io = (initial: string | null | 'THROW', failWrite = false) => {
    let stored: string | null = initial === 'THROW' ? null : initial;
    return { stored: () => stored, io: {
      read: async () => { if (initial === 'THROW') throw new Error('EACCES'); return stored; },
      write: async (t: string) => { if (failWrite) return false; stored = t; return true; } } };
  };

  it('grants once, writing the marker BEFORE the cap is raised; the second claim is refused', async () => {
    const f = io(null);
    expect(await claimEnrollCapOnce(f.io, 400, '2026-10-14T06:00:00Z')).toEqual({ granted: true, reason: 'GRANTED' });
    expect(JSON.parse(f.stored()!)).toMatchObject({ cap: 400, state: 'CLAIMED_BEFORE_APPLY' });
    expect(await claimEnrollCapOnce(f.io, 400, '2026-10-14T07:00:00Z')).toEqual({ granted: false, reason: 'ALREADY_CLAIMED' });
  });

  it('never raises the cap when the marker cannot be written or read (conservative)', async () => {
    expect(await claimEnrollCapOnce(io(null, true).io, 400, 't')).toEqual({ granted: false, reason: 'MARKER_WRITE_FAILED' });
    expect(await claimEnrollCapOnce(io('THROW').io, 400, 't')).toEqual({ granted: false, reason: 'MARKER_UNREADABLE' });
    expect(await claimEnrollCapOnce(io('{broken').io, 400, 't')).toEqual({ granted: false, reason: 'MARKER_UNREADABLE' });
  });

  it('a different cap value is an explicit new authorization by the operator', async () => {
    const f = io(JSON.stringify({ cap: 400 }));
    expect(await claimEnrollCapOnce(f.io, 400, 't')).toMatchObject({ granted: false });
    expect(await claimEnrollCapOnce(f.io, 500, 't')).toEqual({ granted: true, reason: 'GRANTED' });
  });
});
