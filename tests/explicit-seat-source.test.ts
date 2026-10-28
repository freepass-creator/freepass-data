import { describe, expect, it } from 'vitest';
import { explicitSeatCount } from '../src/domain/source-spec-validation.js';
import { aicaSpecFacts } from '../src/adapters/source-cycle-native.js';
import { iancarCyclePlugin } from '../src/adapters/source-cycle-plugins.js';
import { refillableSpecValues } from '../src/domain/spec-refill.js';
import type { IancarOneListCapture } from '../src/adapters/iancar-one-api.js';

describe('명시된 인승 원천 → 기존 raw.spec/빈칸 채움', () => {
  it('독립된 단일 N인승만 읽고 모델명으로 추정하지 않는다', () => {
    for (const [title, seats] of [['합성 라운지 6인승', '6'], ['합성 (8인승)', '8'], ['카고 2 인승', '2'], ['합성 ９인승', '9'], ['합성 7인승 7인승', '7']])
      expect(explicitSeatCount(title), title).toBe(seats);
    for (const title of ['카니발 노블레스', '7인승 9인승', '7/9인승', '7~9인승', '7인승/9인승', '7 또는 9인승',
      '7.5인승', '107인승', '0인승', '07인승', '2인승계', '7인승 아님', '7인승 제외', '7인승 개조 예정', '7인승 이상', '7인승 확인 필요', '약 7인승', '7인승?'])
      expect(explicitSeatCount(title), title).toBeNull();
    expect(explicitSeatCount(null)).toBeNull();
  });

  it('아이카 명시 원문을 spec.seats로 넘기며 기존 값은 빈칸 채움 허용 목록 밖이면 보존한다', () => {
    const spec = aicaSpecFacts(() => undefined, '합성 8인승');
    expect(spec).toEqual({ seats: '8' });
    expect(refillableSpecValues(spec, ['seats'])).toEqual({ seats: '8' });
    expect(refillableSpecValues(spec, ['fuel_type'])).not.toHaveProperty('seats');
    expect(aicaSpecFacts(() => undefined, '합성 7/9인승')).not.toHaveProperty('seats');
  });

  const time = '2026-10-27T10:00:00.000Z';
  const read = async (name: string, extra: Record<string, unknown> = {}, complete = true) => {
    const capture = { version: 'iancar-one-api/1', capturedAt: time, origin: 'synthetic', syncedAt: time, stale: !complete,
      total: 1, pages: 1, sourceDigest: 'synthetic', issues: [], readyForRawIngest: complete, factScope: 'FULL_FACTS',
      records: [{ vehicleId: 'V1', fingerprint: 'V1', payload: { vehicle_id: 'V1', plate_number: '123가4567', inventory_status: 'AVAILABLE',
        detail: { data: { vehicle_id: 'V1', name } }, rates: { data: [] }, ...extra } }] } as IancarOneListCapture;
    const before = structuredClone(capture);
    const plugin = iancarCyclePlugin(0.9, async () => capture, () => time);
    const records = plugin.toRecords(await plugin.read()).records;
    expect(capture).toEqual(before);
    return records;
  };

  it('이안카 완전한 현재 상세에서만 읽고 원문 spec은 그대로 보존한다', async () => {
    expect((await read('합성 카고 2인승'))[0]!.raw.spec).toEqual({ seats: '2' });
    expect((await read('합성 7/9인승'))[0]!.raw.spec).toBeUndefined();
    expect(await read('합성 2인승', {}, false)).toEqual([]);
    expect((await read('합성 2인승', { spec: { seats: '5', note: '원문' } }))[0]!.raw.spec).toEqual({ seats: '5', note: '원문' });
    expect((await read('합성 2인승', { spec: { seats: null } }))[0]!.raw.spec).toEqual({ seats: null });
  });

  it('구조화된 원천 인승이 있으면 해석 불가 값도 차명 파생값으로 가리지 않는다', async () => {
    for (const extra of [{ seats: 5 }, { capacity: '미확인' }, { passengers: {} }])
      expect((await read('합성 2인승', extra))[0]!.raw.spec).toBeUndefined();
  });
});
