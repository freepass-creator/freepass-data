import { describe, expect, it } from 'vitest';
import { maskPersonal, rawKeyOf, rawEntryOfRecord, rawEntryOfHeld } from '../src/domain/source-raw.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';

const rec = (over: Partial<SourceProductRecord> = {}): SourceProductRecord => ({ sourceId: 'RP999', uid: '12가3456', plate: '12가3456', vehicleText: '현대 그랜저',
  status: { raw: '출고가능', saleAvailable: true }, terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 700000 }, deposit: { state: 'UNKNOWN', value: null }, mileage: '20000km/year', raw: {} }],
  observedAt: '2026-10-14T00:00:00.000Z', raw: { source_tab: '스타', source_row: 7, cells: ['12가3456', '010-1234-5678', '1,000,000'] }, vehicleHold: [], ...over });

describe('원천 원문 계층 규칙', () => {
  it('개인정보 모양(전화·주민번호·긴 숫자열)만 가리고 금액·차량번호는 그대로 둔다', () => {
    expect(maskPersonal('연락처 010-1234-5678 / 900101-1234567 / 계좌 110123456789')).toBe('연락처 *** / *** / 계좌 ***');
    expect(maskPersonal(['12가3456', '1,000,000', 1000000, 770000])).toEqual(['12가3456', '1,000,000', 1000000, 770000]);
    expect(maskPersonal({ a: { b: ['02-345-6789'] } })).toEqual({ a: { b: ['***'] } });
    expect((maskPersonal('x'.repeat(5000)) as string).length).toBe(4000);
  });
  it('시트 머리글이 개인정보 열이면 그 열의 값을 가리고, 너무 큰 원문은 digest 로 접는다', async () => {
    const { maskRaw, boundRaw } = await import('../src/domain/source-raw.js');
    const masked = maskRaw({ headers: ['차량번호', '고객명', '연락처', '월렌트'], cells: ['12가3456', '홍길동', '대표 번호', '770,000'] }) as { cells: string[] };
    expect(masked.cells).toEqual(['12가3456', '***', '***', '770,000']);
    expect(boundRaw({ a: 'x'.repeat(700_000) })).toMatchObject({ __oversize: true });
    expect(boundRaw({ a: 'small' })).toEqual({ a: 'small' });
  });
  it('키는 원천__차량번호, 번호가 없으면 UID, 그것도 없으면 행 해시', () => {
    expect(rawKeyOf('RP999', rec())).toBe('RP999__12가3456');
    expect(rawKeyOf('RP999', rec({ plate: null, uid: 'RP004:MONTHLY:K5' }))).toBe('RP999__RP004:MONTHLY:K5');
    expect(rawKeyOf('RP999', rec({ plate: null, uid: '' }))).toMatch(/^RP999__row-[0-9a-f]{16}$/);
  });
  it('레코드 항목은 원문(마스킹)·요금·상태를 담고 같은 입력이면 같은 digest', () => {
    const a = rawEntryOfRecord('RP999', rec()), b = rawEntryOfRecord('RP999', rec());
    expect(a.rawDigest).toBe(b.rawDigest);
    expect(JSON.stringify(a.raw)).not.toContain('5678');
    expect(a.terms).toEqual([{ months: 36, rent: 700000, depositState: 'UNKNOWN', mileage: '20000km/year' }]);
    expect(a.kind).toBe('RECORD');
  });
  it('번호·UID 를 못 만든 보류 행도 행 번호와 사유로 남긴다', () => {
    const h = rawEntryOfHeld('RP999', { row: 9, reasons: ['UID_REQUIRED'] });
    expect(h.kind).toBe('HELD');
    expect(h.key).toMatch(/^RP999__held-9-[0-9a-f]{8}$/);
    expect(h.heldReasons).toEqual(['UID_REQUIRED']);
  });
});
