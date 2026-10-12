import { describe, expect, it } from 'vitest';
import {
  assertKakaoInfoCandidate,
  classifyKakaoInfoSignal,
  createKakaoInfoCandidate,
  kakaoInfoCandidateId,
  type KakaoInfoCandidateInput,
} from '../src/domain/kakao-info-candidate.js';

const base = (patch: Partial<KakaoInfoCandidateInput> = {}): KakaoInfoCandidateInput => ({
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

describe('KakaoInfoCandidate/v1 validation', () => {
  it('rejects sender failures, unknown side and our own messages as SENDER_UNVERIFIED', () => {
    for (const side of ['우리', '불명', '판정실패']) {
      expect(createKakaoInfoCandidate(base({ source: { ...base().source, side } })))
        .toEqual({ ok: false, reason: 'SENDER_UNVERIFIED' });
    }
  });

  it('rejects sensitive and overlong excerpts before making a candidate', () => {
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, excerpt: '전화 010-1234-5678' } })))
      .toEqual({ ok: false, reason: 'SENSITIVE_EXCERPT' });
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, excerpt: 'A'.repeat(81) } })))
      .toEqual({ ok: false, reason: 'INVALID_EXCERPT' });
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
