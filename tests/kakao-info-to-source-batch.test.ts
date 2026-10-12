import { describe, expect, it, vi } from 'vitest';
import { kakaoInfoCandidatesToSourceBatch } from '../src/application/kakao-info-to-source-batch.js';
import { prepareRawSourceBatch } from '../src/application/ingest-raw-source.js';
import type { KakaoInfoCandidateInput } from '../src/domain/kakao-info-candidate.js';

const candidate = (patch: Partial<KakaoInfoCandidateInput> = {}): KakaoInfoCandidateInput => ({
  roomCode: 'K-TEST-FAKE-ROOM',
  source: { sentAt: '2026-10-12T00:00:00.000Z', side: '상대', msgNo: 'TEST-FAKE-MSG-1', excerpt: 'TEST-FAKE masked excerpt' },
  type: '재고',
  vehicle: { plate: 'TEST-FAKE-PLATE-1', model: 'TEST-FAKE-MODEL' },
  fields: { 요약: '재고 확인', 값: '재고 있음' },
  confidence: 0.8,
  needsSupplierConfirm: false,
  aiInvolved: true,
  status: 'CANDIDATE',
  ...patch,
});

describe('kakaoInfoCandidatesToSourceBatch', () => {
  it('maps candidates to the existing SourceBatch shape without calling any store or port', () => {
    const plan = kakaoInfoCandidatesToSourceBatch([candidate()], { now: '2026-10-12T01:00:00.000Z' });
    expect(plan.writes).toBe(0);
    expect(plan.batch.laneId).toBe('PRODUCT_VEHICLE');
    expect(plan.batch.source.authorityScope).toContain('authority:CANDIDATE');
    expect(plan.batch.records[0]?.payload).toMatchObject({
      sourceKind: 'KAKAO',
      authority: 'CANDIDATE',
      aiInvolved: true,
      normalized: { type: '재고', value: '재고 있음', vehicle: { productRef: 'products/TEST-FAKE-PLATE-1' } },
    });
    const store = { appendRaw: vi.fn() };
    prepareRawSourceBatch(plan.batch);
    expect(store.appendRaw).not.toHaveBeenCalled();
  });

  it('keeps plateUnverified as a vehicle-unspecified candidate and forces supplier confirmation', () => {
    const plan = kakaoInfoCandidatesToSourceBatch([candidate({
      vehicle: { model: 'TEST-FAKE-MODEL', plateUnverified: 'TEST-FAKE-PLATE-GUESS' },
      needsSupplierConfirm: false,
    })]);
    expect(plan.candidates[0]).toMatchObject({ productRef: null, vehicleUnspecified: true });
    expect(plan.batch.records[0]?.payload).toMatchObject({
      normalized: {
        vehicle: { productRef: null, plateUnverified: 'TEST-FAKE-PLATE-GUESS', unspecified: true },
        needsSupplierConfirm: true,
      },
    });
    const raw = prepareRawSourceBatch(plan.batch).rawRecords[0]!;
    const normalized = plan.normalize(raw);
    expect(normalized.record.candidate.issues).toContain('VEHICLE_UNSPECIFIED');
    expect(normalized.record.candidate.issues).toContain('SUPPLIER_CONFIRM_REQUIRED');
  });

  it('makes money-like types non-promotable and state signals promotable', () => {
    const plan = kakaoInfoCandidatesToSourceBatch([
      candidate({ type: '가격', fields: { 요약: '가격', 값: 'TEST-FAKE-AMOUNT' }, source: { ...candidate().source, msgNo: 'TEST-FAKE-MSG-1' } }),
      candidate({ type: '조건', fields: { 요약: '조건', 값: 'TEST-FAKE-CONDITION' }, source: { ...candidate().source, msgNo: 'TEST-FAKE-MSG-2' } }),
      candidate({ type: '정책변경', fields: { 요약: '정책', 값: 'TEST-FAKE-POLICY' }, source: { ...candidate().source, msgNo: 'TEST-FAKE-MSG-3' } }),
      candidate({ type: '계약진행', fields: { 요약: '진행', 값: '접수 가능' }, source: { ...candidate().source, msgNo: 'TEST-FAKE-MSG-4' } }),
    ]);
    expect(plan.candidates.map((item) => item.autoPromotable)).toEqual([false, false, false, true]);
    expect(plan.batch.records.map((record) => (record.payload.normalized as { autoPromotable: boolean }).autoPromotable))
      .toEqual([false, false, false, true]);
  });

  it('preserves conflicting same-vehicle values as separate candidates instead of overwriting', () => {
    const plan = kakaoInfoCandidatesToSourceBatch([
      candidate({ source: { ...candidate().source, msgNo: 'TEST-FAKE-MSG-1' }, fields: { 요약: '재고', 값: '재고 있음' } }),
      candidate({ source: { ...candidate().source, msgNo: 'TEST-FAKE-MSG-2' }, fields: { 요약: '재고', 값: '재고 없음' } }),
    ]);
    expect(plan.batch.records).toHaveLength(2);
    expect(new Set(plan.batch.records.map((record) => record.sourceRecordId)).size).toBe(2);
    expect(plan.candidates.map((item) => item.conflict)).toEqual([true, true]);
    const normalized = prepareRawSourceBatch(plan.batch).rawRecords.map((raw) => plan.normalize(raw).record);
    expect(normalized.map((record) => record.candidate.issues.includes('KAKAO_INFO_CONFLICT'))).toEqual([true, true]);
  });

  it('normalizes field lineage as KAKAO candidate evidence and never produces canonical lineage', () => {
    const plan = kakaoInfoCandidatesToSourceBatch([candidate()]);
    const raw = prepareRawSourceBatch(plan.batch).rawRecords[0]!;
    const { lineage } = plan.normalize(raw);
    expect(lineage.length).toBeGreaterThan(0);
    expect(lineage.every((item) => item.stage === 'RAW_TO_NORMALIZED')).toBe(true);
    expect(lineage.every((item) => item.canonical == null)).toBe(true);
    expect(lineage.map((item) => item.transformId)).toEqual(lineage.map(() => 'kakao-info-candidate'));
  });
});
