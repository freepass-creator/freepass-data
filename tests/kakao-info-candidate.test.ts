import { describe, expect, it } from 'vitest';
import {
  assertKakaoInfoCandidate,
  classifyKakaoInfoSignal,
  createKakaoInfoCandidate,
  kakaoInfoCandidateId,
  type KakaoInfoCandidateInput,
} from '../src/domain/kakao-info-candidate.js';

const base = (patch: Partial<KakaoInfoCandidateInput> = {}): KakaoInfoCandidateInput => ({
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

describe('KakaoInfoCandidate/v1 validation', () => {
  it('rejects sender failures, unknown side and our own messages as SENDER_UNVERIFIED', () => {
    for (const side of ['우리', '불명', '판정실패']) {
      expect(createKakaoInfoCandidate(base({ source: { ...base().source, side } })))
        .toEqual({ ok: false, reason: 'SENDER_UNVERIFIED' });
    }
  });

  it('rejects sensitive and overlong excerpts before making a candidate', () => {
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, excerpt: '전화 010-1234-5678' } })))
      .toEqual({ ok: false, reason: 'PII_DETECTED' });
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, excerpt: 'A'.repeat(81) } })))
      .toEqual({ ok: false, reason: 'INVALID_EXCERPT' });
  });

  it('rejects PII from every candidate string field except roomCode', () => {
    for (const patch of [
      { fields: { 요약: '가격', 값: '010.1234.5678' } },
      { fields: { 요약: '가격', 값: '+82 10-1234-5678' } },
      { fields: { 요약: '가격', 값: '010 1234 5678' } },
      { fields: { 요약: '가격', 값: '010-1234-5678' } },
      { fields: { 요약: '가격', 값: '(010) 1234 5678' } },
      { fields: { 요약: '가격', 값: 'test@example.com' } },
      { fields: { 요약: '가격', 값: '주민번호 900101-1234567' } },
      { fields: { 요약: '가격', 값: '9001011234567' } },
      { fields: { 요약: '가격', 값: '은행 계좌 1234567890' } },
      { fields: { 요약: '가격', 값: '123-456-789012' } },
      {
        fields: { 요약: '계좌', 값: '123456789012' },
      },
      { vehicle: { plate: '99허0000', model: '010 1234 5678', plateEvidenceMsgNo: 100, plateEvidence: { source: 'LITERAL_IN_UTTERANCE' } } },
    ] satisfies Partial<KakaoInfoCandidateInput>[]) {
      expect(createKakaoInfoCandidate(base(patch))).toEqual({ ok: false, reason: 'PII_DETECTED' });
    }
    expect(createKakaoInfoCandidate(base({ fields: { 요약: '금액', 값: '1,000,000' } })).ok).toBe(true);
    expect(createKakaoInfoCandidate(base({ fields: { 요약: '금액', 값: '1000000' } })).ok).toBe(true);
    expect(createKakaoInfoCandidate(base({ fields: { 요약: '금액', 값: '100만원' } })).ok).toBe(true);
    expect(createKakaoInfoCandidate(base({ roomCode: 'K-A010B123' })).ok).toBe(true);
  });

  it('rejects candidates sent more than five minutes in the future', () => {
    const future = new Date(Date.now() + 6 * 60 * 1000).toISOString();
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, sentAt: future } })))
      .toEqual({ ok: false, reason: 'FUTURE_SENT_AT' });
  });

  it('demotes plate to plateUnverified unless nearby message evidence proves it', () => {
    expect(assertKakaoInfoCandidate(base()).vehicle).toMatchObject({
      plate: '99허0000',
      plateEvidenceMsgNo: 100,
      plateEvidence: { source: 'LITERAL_IN_UTTERANCE' },
    });
    for (const input of [
      base({ vehicle: { plate: '99허0000', model: 'TEST-FAKE-MODEL' } }),
      base({ vehicle: { plate: '99허0000', model: 'TEST-FAKE-MODEL', plateEvidenceMsgNo: 100 } }),
      base({ source: { ...base().source, msgNo: '102', excerpt: '다른 발언' } }),
      base({ source: { ...base().source, msgNo: '99' } }),
      base({ source: { ...base().source, msgNo: '103' } }),
      base({ source: { ...base().source, excerpt: '번호 없음' } }),
    ]) {
      const candidate = assertKakaoInfoCandidate(input);
      expect(candidate.vehicle?.plate).toBeUndefined();
      expect(candidate.vehicle?.plateUnverified).toBe('99허0000');
      expect(candidate.needsSupplierConfirm).toBe(true);
    }
  });

  it('keeps candidateId idempotent and changes it when fields change', () => {
    const input = base();
    expect(kakaoInfoCandidateId(input)).toBe(kakaoInfoCandidateId(structuredClone(input)));
    expect(assertKakaoInfoCandidate(input).candidateId).toBe(assertKakaoInfoCandidate(structuredClone(input)).candidateId);
    expect(assertKakaoInfoCandidate({ ...input, fields: { ...input.fields, 값: '재고 없음' } }).candidateId)
      .not.toBe(assertKakaoInfoCandidate(input).candidateId);
  });

  it('uses UNSPECIFIED vehicle key when plate is absent', () => {
    const withModel = assertKakaoInfoCandidate(base({ vehicle: { model: 'TEST-FAKE-MODEL' } }));
    const withoutVehicle = base();
    delete withoutVehicle.vehicle;
    const noVehicle = assertKakaoInfoCandidate(withoutVehicle);
    expect(withModel.candidateId).toBe(noVehicle.candidateId);
  });

  it('calculates 24h TTL for state signals and 7d TTL for price or terms signals', () => {
    const stock = assertKakaoInfoCandidate(base({ type: '재고' }));
    expect(classifyKakaoInfoSignal(stock, '2026-10-12T23:59:59.999Z').isFresh).toBe(true);
    expect(classifyKakaoInfoSignal(stock, '2026-10-13T00:00:00.001Z').isFresh).toBe(false);
    expect(classifyKakaoInfoSignal(stock, '2026-10-12T00:00:00.000Z').expiresAt).toBe('2026-10-13T00:00:00.000Z');

    const price = assertKakaoInfoCandidate(base({ type: '가격', fields: { 요약: '가격', 값: 'TEST-FAKE-AMOUNT' } }));
    expect(classifyKakaoInfoSignal(price, '2026-10-18T23:59:59.999Z').isFresh).toBe(true);
    expect(classifyKakaoInfoSignal(price, '2026-10-19T00:00:00.001Z').isFresh).toBe(false);
    expect(classifyKakaoInfoSignal(price, '2026-10-12T00:00:00.000Z').expiresAt).toBe('2026-10-19T00:00:00.000Z');
  });
});
