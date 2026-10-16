import { describe, expect, it } from 'vitest';
import { iancarCyclePlugin } from '../src/adapters/source-cycle-plugins.js';
import { stableIancarPayload, stableIancarPhotos } from '../src/adapters/iancar-stable-facts.js';
import { planSourceCycle, type CycleProduct, type CycleConfig } from '../src/application/source-cycle.js';
import { compactRecord, type SourceProductRecord } from '../src/domain/source-engine.js';
import type { IancarOneListCapture } from '../src/adapters/iancar-one-api.js';

// 1번 커맨드 오더 2026-10-17: 이안카 회차마다 «갱신 113건»이 전부 관측 시각·사진 자격 URL 회전이었다(백업·영수증 대조, 가격·상태 변화 0).
// 값 지문 안정화(SOURCE_CYCLE_IANCAR_STABLE_FACTS=1)는 저장·비교에 같은 규칙을 적용해 값이 같은 문서를 다시 쓰지 않는다. Codex 관문 기준:
// 시각·토큰만 변경 → 0, 실제 가격·상태 변경 → UPDATE/하향, 불완전 읽기 → 기존 차단, 켜는 첫 회차 → 1회 이관 UPDATE 뒤 0.
const t0 = '2026-10-16T14:50:00.000Z', t1 = '2026-10-16T15:50:00.000Z', t2 = '2026-10-16T16:50:00.000Z';
const config: CycleConfig = { sourceId: 'RP031', family: 'IANCAR', maxDowngradeRatio: 0.9 };
const token = (seed: string) => `tok-${seed}-${'x'.repeat(40)}`;
const photos = (seed: string) => [
  { photo_id: token(seed + 'a'), url: `/v1/vehicles/V1/photos/${token(seed + 'a')}`, representative: true },
  { photo_id: token(seed + 'b'), url: `/v1/vehicles/V1/photos/${token(seed + 'b')}`, representative: false }];
const rate = (monthly = 500000) => ({ rental_period: 24, monthly_rate: monthly, deposit: 700000, contracted_mileage: 20000, mileage_period: 'year', currency: 'KRW', vat_included: true });
type Opts = { monthly?: number; status?: string; complete?: boolean };
/** 회차 읽기 결과: seed 가 다르면 사진 토큰·captured_at 만 다르고 값은 같다. */
const capture = (at: string, seed: string, o: Opts = {}): IancarOneListCapture => {
  const status = o.status ?? 'AVAILABLE', available = status === 'AVAILABLE', monthly = o.monthly ?? 500000;
  return { version: 'iancar-one-api/1', capturedAt: at, origin: 'synthetic', syncedAt: at, stale: false, total: 1, pages: 1, sourceDigest: 'synthetic',
    issues: o.complete === false ? ['IANCAR_ONE_PAGINATION_TOTAL_MISMATCH'] : [], readyForRawIngest: o.complete !== false, factScope: 'FULL_FACTS',
    records: o.complete === false ? [] : [{ vehicleId: 'V1', fingerprint: 'V1', payload: {
      vehicle_id: 'V1', plate_number: '123가4567', inventory_status: status, available, synced_at: at, stale: false, photos: photos(seed), name: '합성 차종',
      detail: { success: true, data: { vehicle_id: 'V1', name: '합성 차종', photos: photos(seed + 'd'), synced_at: at } },
      availability: { success: true, data: { vehicle_id: 'V1', available, synced_at: at } },
      rates: { success: true, data: [rate(monthly)] },
      rateRequestEvidence: { vehicle_id: 'V1', path: '/v1/vehicles/V1/rates', captured_at: at, response_digest: `rates-${monthly}`,
        attribution: 'REQUEST_PATH_BOUND_BY_DETAIL_ECHO', coverage: 'UNKNOWN' } } as IancarOneListCapture['records'][number]['payload'] }] };
};
async function records(cap: IancarOneListCapture, stableFacts: boolean): Promise<SourceProductRecord[]> {
  const plugin = iancarCyclePlugin(0.9, async () => cap, () => cap.capturedAt, undefined, { stableFacts });
  return plugin.toRecords(await plugin.read()).records;
}
/** 직전 회차가 문서에 남긴 형태 = compactRecord(원문) (infra nativeCycleFields 와 같은 규칙). */
const stored = (r: SourceProductRecord, listable = true): CycleProduct => ({ record: compactRecord(r), listable, locked_by_contract: false,
  publication_withdrawal: null, publication_withdrawal_prior: null });
const plan = (before: CycleProduct[], rows: SourceProductRecord[], at: string, complete = true) =>
  planSourceCycle(config, { records: rows, complete, observedAt: at, heldCount: 0 }, { products: before, complete: true }, Date.parse(at)).plan;

describe('iancar-stable-facts 정규화', () => {
  it('captured_at 은 null, 사진 목록은 개수·대표 위치 요약으로 바뀌고 나머지는 그대로', () => {
    const p = capture(t0, 's1').records[0]!.payload;
    const s = stableIancarPayload(p);
    expect((s.rateRequestEvidence as { captured_at: unknown }).captured_at).toBeNull();
    expect((s.rateRequestEvidence as { response_digest: unknown }).response_digest).toBe('rates-500000');
    expect(s.photos).toEqual({ count: 2, representative_ordinal: 0, credential_urls_omitted: true });
    expect((s.detail as { data: { photos: unknown } }).data.photos).toEqual({ count: 2, representative_ordinal: 0, credential_urls_omitted: true });
    expect(s.rates).toEqual(p.rates);
    expect(s.synced_at).toBe(t0);
    expect((s.detail as { data: Record<string, unknown> }).data.synced_at).toBeUndefined();
    expect((s.availability as { data: Record<string, unknown> }).data.synced_at).toBeUndefined();
    expect(p.photos).toHaveLength(2);   // 원본은 바꾸지 않는다
    expect(stableIancarPhotos('not-a-list')).toBe('not-a-list');
    expect(stableIancarPhotos([{ representative: false }])).toEqual({ count: 1, representative_ordinal: null, credential_urls_omitted: true });
  });
  it('같은 값·다른 토큰·다른 시각의 두 payload 는 정규화 뒤 captured_at 외 동일, 가격이 다르면 다르다', () => {
    const a = stableIancarPayload(capture(t0, 's1').records[0]!.payload), b = stableIancarPayload(capture(t0, 's2').records[0]!.payload);
    expect(a).toEqual(b);
    expect(stableIancarPayload(capture(t0, 's3', { monthly: 510000 }).records[0]!.payload)).not.toEqual(a);
  });
});

describe('값 지문 안정화 회차 계획', () => {
  it('켜짐: 토큰·시각만 바뀐 다음 회차는 쓰기 0, 끄면(현행) 같은 입력이 UPDATE 로 다시 쓰인다', async () => {
    const first = await records(capture(t0, 's1'), true);
    expect(plan([stored(first[0]!)], await records(capture(t1, 's2'), true), t1).entries).toEqual([]);
    const firstOff = await records(capture(t0, 's1'), false);
    expect(plan([stored(firstOff[0]!)], await records(capture(t1, 's2'), false), t1).entries.map(e => e.kind)).toEqual(['UPDATE']);
  });
  it('켜짐: 실제 가격 변화는 UPDATE, 상태가 판매 불가로 바뀌면 하향', async () => {
    const before = stored((await records(capture(t0, 's1'), true))[0]!);
    const priced = plan([before], await records(capture(t1, 's2', { monthly: 510000 }), true), t1);
    expect(priced.entries.map(e => e.kind)).toEqual(['UPDATE']);
    expect(priced.entries[0]!.after.record.terms[0]!.monthlyRent).toEqual({ state: 'KNOWN', value: 510000 });
    const down = plan([before], await records(capture(t1, 's2', { status: 'SOLD' }), true), t1);
    expect(down.entries.map(e => e.kind)).toEqual(['DOWNGRADE']);
  });
  it('켜짐: 불완전 읽기는 기존대로 차단(SOURCE_INCOMPLETE)', async () => {
    const before = stored((await records(capture(t0, 's1'), true))[0]!);
    const cap = capture(t1, 's2', { complete: false });
    const plugin = iancarCyclePlugin(0.9, async () => cap, () => t1, undefined, { stableFacts: true });
    const read = await plugin.read();
    expect(read.complete).toBe(false);
    expect(plan([before], plugin.toRecords(read).records, t1, false).blockers).toContain('SOURCE_INCOMPLETE');
  });
  it('켜는 첫 회차: 옛 형태(시각·토큰 포함 digest)로 저장된 문서는 한 번 UPDATE, 그다음 회차부터 0', async () => {
    const legacy = stored((await records(capture(t0, 's1'), false))[0]!);
    const migrate = plan([legacy], await records(capture(t1, 's2'), true), t1);
    expect(migrate.entries.map(e => e.kind)).toEqual(['UPDATE']);
    const migrated: CycleProduct = { ...legacy, record: compactRecord(migrate.entries[0]!.after.record) };
    expect(plan([migrated], await records(capture(t2, 's3'), true), t2).entries).toEqual([]);
  });
  it('켜짐은 회차 요약 notes 에 IANCAR_STABLE_FACTS:1 을 남기고, 꺼짐은 남기지 않는다', async () => {
    const on = await iancarCyclePlugin(0.9, async () => capture(t0, 's1'), () => t0, undefined, { stableFacts: true }).read();
    expect((on.raw as { notes?: string[] }).notes).toEqual(['IANCAR_STABLE_FACTS:1']);
    const off = await iancarCyclePlugin(0.9, async () => capture(t0, 's1'), () => t0).read();
    expect((off.raw as { notes?: string[] }).notes).toBeUndefined();
  });
});
