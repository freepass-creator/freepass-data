import { describe, expect, it, vi } from 'vitest';
import { kakaoInfoCandidatesToSourceBatch } from '../src/application/kakao-info-to-source-batch.js';
import { prepareRawSourceBatch } from '../src/application/ingest-raw-source.js';
import type { KakaoInfoCandidateInput } from '../src/domain/kakao-info-candidate.js';

const candidate = (patch: Partial<KakaoInfoCandidateInput> = {}): KakaoInfoCandidateInput => ({
  roomCode: 'K-TESTFAKE',
  source: { sentAt: '2026-10-12T00:00:00.000Z', side: '상대', msgNo: '100', excerpt: '99허0000 재고 확인' },
  type: '재고',
  vehicle: {
    plate: '99허0000',
    model: 'TEST-FAKE-MODEL',
    plateEvidenceMsgNo: 100,
    plateStatusSameSentence: true,
    plateEvidence: { source: 'LITERAL_IN_UTTERANCE' },
  },
  fields: { 요약: '재고 확인', 값: '재고 있음' },
  confidence: 0.8,
  needsSupplierConfirm: false,
  aiInvolved: true,
  status: 'CANDIDATE',
  ...patch,
});

describe('kakaoInfoCandidatesToSourceBatch', () => {
  it('requires caller supplied now and accepts no write port in its public signature', () => {
    type BatchOptions = Parameters<typeof kakaoInfoCandidatesToSourceBatch>[1];
    const valid: BatchOptions = { now: '2026-10-12T01:00:00.000Z' };
    expect(valid.now).toBe('2026-10-12T01:00:00.000Z');
    // @ts-expect-error The transformer does not accept store/write ports.
    const invalid: BatchOptions = { now: '2026-10-12T01:00:00.000Z', store: { appendRaw: vi.fn() } };
    expect(invalid).toBeDefined();
    expect(() => kakaoInfoCandidatesToSourceBatch([candidate()], undefined as unknown as BatchOptions))
      .toThrow('KAKAO_INFO_NOW_REQUIRED');
  });

  it('maps candidates to the existing SourceBatch shape without calling any store or port', () => {
    const plan = kakaoInfoCandidatesToSourceBatch([candidate()], { now: '2026-10-12T01:00:00.000Z' });
    expect(plan.writes).toBe(0);
    expect(plan.batch.laneId).toBe('PRODUCT_VEHICLE');
    expect(plan.batch.source.authorityScope).toContain('authority:CANDIDATE');
    expect(plan.batch.records[0]?.payload).toMatchObject({
      sourceKind: 'KAKAO',
      authority: 'CANDIDATE',
      aiInvolved: true,
      normalized: {
        type: '재고',
        value: '재고 있음',
        vehicle: {
          productRef: 'products/99허0000',
          plateEvidenceMsgNo: 100,
          plateStatusSameSentence: true,
          plateEvidenceSource: 'LITERAL_IN_UTTERANCE',
        },
      },
    });
    const store = { appendRaw: vi.fn() };
    prepareRawSourceBatch(plan.batch);
    expect(store.appendRaw).not.toHaveBeenCalled();
  });

  it('keeps plateUnverified as a vehicle-unspecified candidate and forces supplier confirmation', () => {
    const plan = kakaoInfoCandidatesToSourceBatch([candidate({
      vehicle: { model: 'TEST-FAKE-MODEL', plateUnverified: 'TEST-FAKE-PLATE-GUESS' },
      needsSupplierConfirm: false,
    })], { now: '2026-10-12T01:00:00.000Z' });
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
      candidate({ type: '가격', fields: { 요약: '가격', 값: 'TEST-FAKE-AMOUNT' }, source: { ...candidate().source, msgNo: '100' } }),
      candidate({ type: '조건', fields: { 요약: '조건', 값: 'TEST-FAKE-CONDITION' }, source: { ...candidate().source, msgNo: '101', excerpt: '조건 발언' } }),
      candidate({ type: '정책변경', fields: { 요약: '정책', 값: 'TEST-FAKE-POLICY' }, source: { ...candidate().source, msgNo: '102', excerpt: '정책 발언' } }),
      candidate({
        type: '계약진행',
        fields: { 요약: '진행', 값: '접수 가능' },
        source: { ...candidate().source, msgNo: '103', excerpt: '99허0000 계약 접수 가능' },
        vehicle: { ...candidate().vehicle!, plateEvidenceMsgNo: 103 },
      }),
    ], { now: '2026-10-12T01:00:00.000Z' });
    expect(plan.candidates.map((item) => item.autoPromotable)).toEqual([false, false, false, true]);
    expect(plan.batch.records.map((record) => (record.payload.normalized as { autoPromotable: boolean }).autoPromotable))
      .toEqual([false, false, false, true]);
  });

  it('does not auto-promote negated or mixed state sentences', () => {
    const plan = kakaoInfoCandidatesToSourceBatch([
      candidate({ fields: { 요약: '재고', 값: '출고 불가였다가 가능' } }),
      candidate({ fields: { 요약: '재고', 값: '재고 없음 아님' }, source: { ...candidate().source, msgNo: '101', excerpt: '다음 발언' } }),
    ], { now: '2026-10-12T01:00:00.000Z' });
    expect(plan.candidates.map((item) => item.autoPromotable)).toEqual([false, false]);
  });

  it('requires literal same-utterance plate evidence before auto-promotion', () => {
    const previous = candidate({
      source: { ...candidate().source, msgNo: '101', excerpt: 'B모델 재고 있음' },
      vehicle: {
        plate: '97허0000',
        model: 'TEST-FAKE-MODEL-B',
        plateEvidenceMsgNo: 100,
        plateStatusSameSentence: true,
        plateEvidence: { source: 'LITERAL_IN_PREVIOUS' },
      },
    });
    const ambiguous = candidate({
      source: { ...candidate().source, msgNo: '102', excerpt: '99허0000 98허0000 재고 있음' },
      vehicle: {
        model: 'TEST-FAKE-MODEL',
        plateUnverified: '99허0000',
        plateEvidenceMsgNo: 102,
        plateStatusSameSentence: true,
        plateEvidence: { source: 'LITERAL_IN_UTTERANCE' },
      },
    });
    const otherSentence = candidate({
      source: { ...candidate().source, msgNo: '103', excerpt: '99허0000 확인. 재고 있음' },
      vehicle: {
        plate: '99허0000',
        model: 'TEST-FAKE-MODEL',
        plateEvidenceMsgNo: 103,
        plateStatusSameSentence: false,
        plateEvidence: { source: 'LITERAL_IN_UTTERANCE' },
      },
    });
    const sameSentence = candidate({
      source: { ...candidate().source, msgNo: '104', excerpt: '99허0000 재고 있음' },
      vehicle: { ...candidate().vehicle!, plateEvidenceMsgNo: 104 },
    });
    const plan = kakaoInfoCandidatesToSourceBatch([previous, ambiguous, otherSentence, sameSentence], { now: '2026-10-12T01:00:00.000Z' });

    expect(plan.candidates.map((item) => item.autoPromotable)).toEqual([false, false, false, true]);
    expect(plan.candidates.map((item) => item.vehicleUnspecified)).toEqual([true, true, true, false]);
    expect(plan.batch.records.map((record) => (record.payload.normalized as { autoPromotable: boolean }).autoPromotable))
      .toEqual([false, false, false, true]);
  });

  it('rejects phone-shaped roomCode and strips unknown input fields from payload.candidate without leaking names', () => {
    expect(() => kakaoInfoCandidatesToSourceBatch([candidate({ roomCode: 'K-01012345678' })], { now: '2026-10-12T01:00:00.000Z' }))
      .toThrow('INVALID_ROOM_CODE');

    const plan = kakaoInfoCandidatesToSourceBatch([
      {
        ...candidate(),
        senderName: 'TEST-FAKE-SENDER',
        roomName: 'TEST-FAKE-ROOM',
      } as unknown as KakaoInfoCandidateInput,
    ], { now: '2026-10-12T01:00:00.000Z' });
    const payloadCandidate = plan.batch.records[0]?.payload.candidate as Record<string, unknown>;
    expect(payloadCandidate.senderName).toBeUndefined();
    expect(payloadCandidate.roomName).toBeUndefined();
    expect(payloadCandidate.warnings).toEqual([{ code: 'UNKNOWN_FIELDS_DROPPED', count: 2 }]);
    expect(JSON.stringify(plan.batch)).not.toContain('senderName');
    expect(JSON.stringify(plan.batch)).not.toContain('roomName');
  });

  it('rejects phone-shaped unknown keys without echoing the key in the error or payload', () => {
    expect(() => kakaoInfoCandidatesToSourceBatch([
      {
        ...candidate(),
        '010-1234-5678': 'x',
      } as unknown as KakaoInfoCandidateInput,
    ], { now: '2026-10-12T01:00:00.000Z' })).toThrow('PII_DETECTED');
    expect(() => kakaoInfoCandidatesToSourceBatch([
      {
        ...candidate(),
        vehicle: { ...candidate().vehicle!, '010-1234-5678': 'x' },
      } as unknown as KakaoInfoCandidateInput,
    ], { now: '2026-10-12T01:00:00.000Z' })).toThrow('PII_DETECTED');
  });

  it('demotes blank-normalized or invalid plate text and blocks promotion/productRef', () => {
    for (const plate of ['---', 'ABC123']) {
      const plan = kakaoInfoCandidatesToSourceBatch([candidate({
        source: { ...candidate().source, excerpt: '재고 있음' },
        vehicle: { ...candidate().vehicle!, plate },
      })], { now: '2026-10-12T01:00:00.000Z' });
      expect(plan.candidates[0]).toMatchObject({
        productRef: null,
        vehicleUnspecified: true,
        autoPromotable: false,
      });
      expect(plan.batch.records[0]?.payload).toMatchObject({
        normalized: {
          vehicle: { productRef: null, plate: null, plateUnverified: plate, unspecified: true },
          autoPromotable: false,
          needsSupplierConfirm: true,
        },
      });
    }
  });

  it('uses normalized plate text for productRef across equivalent plate spellings', () => {
    const compact = kakaoInfoCandidatesToSourceBatch([candidate({
      source: { ...candidate().source, excerpt: '99허0000 재고 있음' },
      vehicle: { ...candidate().vehicle!, plate: '99허0000' },
    })], { now: '2026-10-12T01:00:00.000Z' });
    const spaced = kakaoInfoCandidatesToSourceBatch([candidate({
      source: { ...candidate().source, excerpt: '99 허 0000 재고 있음' },
      vehicle: { ...candidate().vehicle!, plate: '99 허 0000' },
    })], { now: '2026-10-12T01:00:00.000Z' });
    expect(compact.candidates[0]?.productRef).toBe('products/99허0000');
    expect(spaced.candidates[0]?.productRef).toBe('products/99허0000');
    expect(spaced.candidates[0]?.candidate.candidateId).toBe(compact.candidates[0]?.candidate.candidateId);
  });

  it('preserves conflicting same-vehicle values as separate candidates instead of overwriting', () => {
    const plan = kakaoInfoCandidatesToSourceBatch([
      candidate({ source: { ...candidate().source, msgNo: '100' }, fields: { 요약: '재고', 값: '재고 있음' } }),
      candidate({
        source: { ...candidate().source, msgNo: '101', excerpt: '99허0000 재고 없음' },
        vehicle: { ...candidate().vehicle!, plateEvidenceMsgNo: 101 },
        fields: { 요약: '재고', 값: '재고 없음' },
      }),
    ], { now: '2026-10-12T01:00:00.000Z' });
    expect(plan.batch.records).toHaveLength(2);
    expect(new Set(plan.batch.records.map((record) => record.sourceRecordId)).size).toBe(2);
    expect(plan.candidates.map((item) => item.conflict)).toEqual([true, true]);
    const normalized = prepareRawSourceBatch(plan.batch).rawRecords.map((raw) => plan.normalize(raw).record);
    expect(normalized.map((record) => record.candidate.issues.includes('KAKAO_INFO_CONFLICT'))).toEqual([true, true]);
  });

  it('normalizes field lineage as KAKAO candidate evidence and never produces canonical lineage', () => {
    const plan = kakaoInfoCandidatesToSourceBatch([candidate()], { now: '2026-10-12T01:00:00.000Z' });
    const raw = prepareRawSourceBatch(plan.batch).rawRecords[0]!;
    const { lineage } = plan.normalize(raw);
    expect(lineage.length).toBeGreaterThan(0);
    expect(lineage.every((item) => item.stage === 'RAW_TO_NORMALIZED')).toBe(true);
    expect(lineage.every((item) => item.canonical == null)).toBe(true);
    expect(lineage.map((item) => item.transformId)).toEqual(lineage.map(() => 'kakao-info-candidate'));
  });

  it('does not use the oldest message time as freshness now', () => {
    const plan = kakaoInfoCandidatesToSourceBatch([candidate({
      source: { sentAt: '2026-10-01T00:00:00.000Z', side: '상대', msgNo: '100', excerpt: '99허0000 재고 확인' },
      vehicle: {
        plate: '99허0000',
        model: 'TEST-FAKE-MODEL',
        plateEvidenceMsgNo: 100,
        plateStatusSameSentence: true,
        plateEvidence: { source: 'LITERAL_IN_UTTERANCE' },
      },
    })], { now: '2026-10-12T00:00:00.000Z' });
    expect(plan.candidates[0]?.isFresh).toBe(false);
    expect(plan.candidates[0]?.autoPromotable).toBe(false);
    expect((plan.batch.records[0]?.payload as { normalized: { isFresh: boolean } }).normalized.isFresh).toBe(false);
    expect((plan.batch.records[0]?.payload as { normalized: { autoPromotable: boolean } }).normalized.autoPromotable).toBe(false);
  });

  it('marks future sentAt as not fresh when classifying already trusted candidates', () => {
    const soonFuture = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    const plan = kakaoInfoCandidatesToSourceBatch([candidate({
      source: { sentAt: soonFuture, side: '상대', msgNo: '100', excerpt: '99허0000 재고 확인' },
    })], { now: new Date(Date.now() - 2 * 60 * 1000).toISOString() });
    expect(plan.candidates[0]?.isFresh).toBe(false);
    expect((plan.batch.records[0]?.payload as { normalized: { isFresh: boolean } }).normalized.isFresh).toBe(false);
  });
});
