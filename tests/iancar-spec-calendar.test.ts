import { describe, expect, it } from 'vitest';
import { iancarCyclePlugin, validCalendarDate } from '../src/adapters/source-cycle-plugins.js';
import type { IancarOneListCapture } from '../src/adapters/iancar-one-api.js';

// Codex #644: 원문 raw.spec 보존(파생값은 없는 칸만) · 최초등록일은 실제 달력 검증(윤년 포함).
const time = '2026-10-14T03:00:00.000Z';
const rate = { rental_period: 24, monthly_rate: 500000, deposit: 700000, contracted_mileage: 20000, mileage_period: 'year', currency: 'KRW', vat_included: true,
  contract_conditions: { version: 'synthetic-v1' } };
const capture = (extra: Record<string, unknown>): IancarOneListCapture => ({ version: 'iancar-one-api/1', capturedAt: time, origin: 'synthetic', syncedAt: time, stale: false,
  total: 1, pages: 1, sourceDigest: 'synthetic', issues: [], readyForRawIngest: true, factScope: 'FULL_FACTS',
  records: [{ vehicleId: 'V1', fingerprint: 'V1', payload: { vehicle_id: 'V1', plate_number: '123가4567', inventory_status: 'AVAILABLE', available: true, ...extra,
    detail: { data: { vehicle_id: 'V1', name: '합성' } }, rates: { data: [rate] } } as IancarOneListCapture['records'][number]['payload'] }] });
const recordOf = async (extra: Record<string, unknown>) => {
  const plugin = iancarCyclePlugin(0.9, async () => capture(extra), () => time);
  const read = await plugin.read();
  return plugin.toRecords(read).records[0]!;
};

describe('validCalendarDate (최초등록일 확정 조건)', () => {
  it('accepts real dates including leap days and year-month, rejects impossible calendar dates', () => {
    for (const ok of ['2026-10-14', '2024-02-29', '2000-02-29', '2026-10', '1999-12-31']) expect(validCalendarDate(ok), ok).toBe(true);
    for (const bad of ['2026-99-99', '2026-02-31', '2025-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-1', '26-10-14', '2026-10-00', 'x'])
      expect(validCalendarDate(bad), bad).toBe(false);
  });
});

describe('이안카 파생 spec 은 원문 spec 을 덮지 않는다', () => {
  it('keeps source values and extra fields; derived values only fill what the source spec lacks', async () => {
    const record = await recordOf({ year: 2023, fuel: '휘발유', color: '흰색', mileage: 12345, first_registration_date: '2023-05-02',
      spec: { fuel_type: '원문 연료', ext_color: '원문 색상', trim_note: '원문 추가 필드' } });
    expect(record.raw.spec).toEqual({ year: '2023', mileage: '12345', first_registration_date: '2023-05-02',
      fuel_type: '원문 연료', ext_color: '원문 색상', trim_note: '원문 추가 필드' });
  });

  it('a source spec alone is preserved even when nothing can be derived; no spec at all stays absent', async () => {
    expect((await recordOf({ spec: { seats: '5' } })).raw.spec).toEqual({ seats: '5' });
    expect((await recordOf({})).raw.spec).toBeUndefined();
  });

  it('an impossible registration date is not confirmed, a real one is', async () => {
    expect((await recordOf({ first_registration_date: '2026-02-31' })).raw.spec).toBeUndefined();
    expect((await recordOf({ first_registration_date: '2026-99-99' })).raw.spec).toBeUndefined();
    expect((await recordOf({ first_registration_date: '2024-02-29' })).raw.spec).toEqual({ first_registration_date: '2024-02-29' });
  });
});
