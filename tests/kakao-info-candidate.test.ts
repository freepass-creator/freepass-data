import { describe, expect, it } from 'vitest';
import {
  assertKakaoInfoCandidate,
  classifyKakaoInfoSignal,
  createKakaoInfoCandidate,
  isKakaoStateAutoPromotable,
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

  it('re-checks personal data on the final trimmed output so whitespace cannot hide split identifiers', () => {
    for (const fields of [{ 요약: 'alice@ ', 값: 'example.com' }, { 요약: '010-1234	', 값: '　5678' }, { 요약: ' alice@	', 값: '　example.com ' }]) {
      expect(createKakaoInfoCandidate(base({ fields }))).toEqual({ ok: false, reason: 'PII_DETECTED' });
    }
  });

  it('re-checks personal data after vehicle fields are normalized too', () => {
    const input = base({ fields: { 요약: '재고', 값: 'user@' }, vehicle: { ...base().vehicle, model: ' example.com' } });
    expect(createKakaoInfoCandidate(input)).toEqual({ ok: false, reason: 'PII_DETECTED' });
  });
  it('rejects identifiers split across non-adjacent fields or msgNo using a residual digit budget while allowing amounts', () => {
    expect(createKakaoInfoCandidate(base({ fields: { 요약: '010-1234', 값: '재고 있음' }, vehicle: { ...base().vehicle, model: '5678' } })))
      .toEqual({ ok: false, reason: 'PII_DETECTED' });
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, msgNo: '345678', excerpt: '99허0000 010-12' } })))
      .toEqual({ ok: false, reason: 'PII_DETECTED' });
    const ok = createKakaoInfoCandidate(base({ fields: { 요약: '월 대여료 1,000,000원', 값: '24개월 보증금 500,000원' } }));
    expect(ok.ok).toBe(true);
  });
  it('rejects phone fragments spread over excerpt and vehicle model (non-adjacent fields)', () => {
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, excerpt: '010-1234' }, fields: { 요약: '재고', 값: '확인' }, vehicle: { model: '5678' } })))
      .toEqual({ ok: false, reason: 'PII_DETECTED' });
  });
  it('rejects a phone number split into 6- and 5-digit fragments across non-adjacent fields', () => {
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, excerpt: '010123' }, fields: { 요약: '재고', 값: '45678' } })))
      .toEqual({ ok: false, reason: 'PII_DETECTED' });
  });
  it('rejects non-numeric msgNo without echoing the value', () => {
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, msgNo: 'test@example.com' } })))
      .toEqual({ ok: false, reason: 'INVALID_MSG_NO' });
  });

  it('requires strict ISO UTC sentAt instead of parseable free-form dates', () => {
    for (const sentAt of ['2026-10-12', '2026-10-12T00:00:00Z', '2026-10-12 00:00:00']) {
      expect(createKakaoInfoCandidate(base({ source: { ...base().source, sentAt } })))
        .toEqual({ ok: false, reason: 'INVALID_SOURCE' });
    }
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

  it('rejects PII split across candidate string values but allows amounts and structural dates', () => {
    expect(createKakaoInfoCandidate(base({
      source: { ...base().source, excerpt: '99허0000 재고 있음' },
      vehicle: { ...base().vehicle!, plate: '99허0000' },
      fields: { 요약: '010-1234', 값: '5678' },
    }))).toEqual({ ok: false, reason: 'PII_DETECTED' });
    expect(createKakaoInfoCandidate(base({
      source: { ...base().source, sentAt: '2026-10-12T00:00:00.000Z', excerpt: '99허0000 재고 있음' },
      vehicle: { ...base().vehicle!, plate: '99허0000' },
      fields: { 요약: '계좌 확인', 값: '정상 후보' },
    })).ok).toBe(true);
    expect(createKakaoInfoCandidate(base({
      source: { ...base().source, excerpt: '99허0000 재고 있음' },
      vehicle: { ...base().vehicle!, plate: '99허0000' },
      fields: { 요약: '금액', 값: '1,000,000' },
    })).ok).toBe(true);
  });

  it('requires numeric boundaries for literal plate evidence in excerpts', () => {
    for (const excerpt of ['199허0000 재고 있음', '99허00001 재고 있음']) {
      const candidate = assertKakaoInfoCandidate(base({
        source: { ...base().source, excerpt },
        vehicle: { ...base().vehicle!, plate: '99허0000' },
      }));
      expect(candidate.vehicle?.plate).toBeUndefined();
      expect(candidate.vehicle?.plateUnverified).toBe('99허0000');
    }
  });

  it('stores normalized plate text and keeps equivalent plate spellings idempotent', () => {
    const compact = assertKakaoInfoCandidate(base({
      source: { ...base().source, excerpt: '99허0000 재고 있음' },
      vehicle: { ...base().vehicle!, plate: '99허0000' },
    }));
    const spaced = assertKakaoInfoCandidate(base({
      source: { ...base().source, excerpt: '99 허 0000 재고 있음' },
      vehicle: { ...base().vehicle!, plate: '99 허 0000' },
    }));
    expect(compact.vehicle?.plate).toBe('99허0000');
    expect(spaced.vehicle?.plate).toBe('99허0000');
    expect(spaced.candidateId).toBe(compact.candidateId);
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

  it('requires callers to pass explicit freshness for state auto-promotion', () => {
    const stock = assertKakaoInfoCandidate(base());
    expect(() => isKakaoStateAutoPromotable(stock, undefined as unknown as boolean))
      .toThrow('INVALID_KAKAO_INFO_FRESHNESS');
  });
});
