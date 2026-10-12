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
  supplierCode: 'RP001',
  roomCode: 'K-TESTFAKE',
  source: { sentAt: '2026-10-12T00:00:00.000Z', side: '상대', msgNo: '100', excerpt: '99허0000 재고 확인' },
  type: '재고',
  vehicle: {
    plate: '99허0000',
    model: 'TEST-FAKE-MODEL',
    plateEvidenceMsgNo: 100,
    plateEvidence: { source: 'LITERAL_IN_UTTERANCE', distance: 0 },
    plateStatusSameSentence: true,
  },
  fields: { 항목: '재고 확인', 요약: '재고 확인', 값: '재고 있음' },
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

  it('bounds supplierCode to short supplier ids', () => {
    expect(createKakaoInfoCandidate(base({ supplierCode: 'RP01012345678' })))
      .toEqual({ ok: false, reason: 'INVALID_FIELDS' });
    expect(createKakaoInfoCandidate(base({ supplierCode: 'PT-01012345678' })))
      .toEqual({ ok: false, reason: 'INVALID_FIELDS' });
  });

  it('rejects PII from every candidate string field except roomCode', () => {
    for (const patch of [
      { fields: { 항목: 'TEST-FAKE-ITEM', 요약: '가격', 값: '010.1234.5678' } },
      { fields: { 항목: 'TEST-FAKE-ITEM', 요약: '가격', 값: '+82 10-1234-5678' } },
      { fields: { 항목: 'TEST-FAKE-ITEM', 요약: '가격', 값: '010 1234 5678' } },
      { fields: { 항목: 'TEST-FAKE-ITEM', 요약: '가격', 값: '010-1234-5678' } },
      { fields: { 항목: 'TEST-FAKE-ITEM', 요약: '가격', 값: '(010) 1234 5678' } },
      { fields: { 항목: 'TEST-FAKE-ITEM', 요약: '가격', 값: 'test@example.com' } },
      { fields: { 항목: 'TEST-FAKE-ITEM', 요약: '가격', 값: '주민번호 900101-1234567' } },
      { fields: { 항목: 'TEST-FAKE-ITEM', 요약: '가격', 값: '9001011234567' } },
      { fields: { 항목: 'TEST-FAKE-ITEM', 요약: '가격', 값: '은행 계좌 1234567890' } },
      { fields: { 항목: 'TEST-FAKE-ITEM', 요약: '가격', 값: '123-456-789012' } },
      {
        fields: { 항목: 'TEST-FAKE-ITEM', 요약: '계좌', 값: '123456789012' },
      },
      { vehicle: { plate: '99허0000', model: '010 1234 5678', plateEvidenceMsgNo: 100, plateEvidence: { source: 'LITERAL_IN_UTTERANCE' } } },
    ] satisfies Partial<KakaoInfoCandidateInput>[]) {
      expect(createKakaoInfoCandidate(base(patch))).toEqual({ ok: false, reason: 'PII_DETECTED' });
    }
    expect(createKakaoInfoCandidate(base({ fields: { 항목: 'TEST-FAKE-ITEM', 요약: '금액', 값: '1,000,000' } })).ok).toBe(true);
    expect(createKakaoInfoCandidate(base({ fields: { 항목: 'TEST-FAKE-ITEM', 요약: '금액', 값: '1000000' } })).ok).toBe(true);
    expect(createKakaoInfoCandidate(base({ fields: { 항목: 'TEST-FAKE-ITEM', 요약: '금액', 값: '100만원' } })).ok).toBe(true);
    expect(createKakaoInfoCandidate(base({ roomCode: 'K-A010B123' })).ok).toBe(true);
    const allowed = createKakaoInfoCandidate(base({ supplierCode: 'RP012' }));
    expect(allowed.ok).toBe(true);
    expect(JSON.stringify(allowed)).not.toContain('01012345678');
  });

  it('rejects candidates sent more than five minutes in the future', () => {
    const future = new Date(Date.now() + 6 * 60 * 1000).toISOString();
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, sentAt: future } })))
      .toEqual({ ok: false, reason: 'FUTURE_SENT_AT' });
  });

  it('re-checks personal data on the final trimmed output so whitespace cannot hide split identifiers', () => {
    for (const fields of [{ 항목: 'TEST-FAKE-ITEM', 요약: 'alice@ ', 값: 'example.com' }, { 항목: 'TEST-FAKE-ITEM', 요약: '010-1234	', 값: '　5678' }, { 항목: 'TEST-FAKE-ITEM', 요약: ' alice@	', 값: '　example.com ' }]) {
      expect(createKakaoInfoCandidate(base({ fields }))).toEqual({ ok: false, reason: 'PII_DETECTED' });
    }
  });

  it('re-checks personal data after vehicle fields are normalized too', () => {
    const input = base({ fields: { 항목: 'TEST-FAKE-ITEM', 요약: '재고', 값: 'user@' }, vehicle: { ...base().vehicle, model: ' example.com' } });
    expect(createKakaoInfoCandidate(input)).toEqual({ ok: false, reason: 'PII_DETECTED' });
  });
  it('rejects identifiers split across non-adjacent fields or msgNo using a residual digit budget while allowing amounts', () => {
    expect(createKakaoInfoCandidate(base({ fields: { 항목: 'TEST-FAKE-ITEM', 요약: '010-1234', 값: '재고 있음' }, vehicle: { ...base().vehicle, model: '5678' } })))
      .toEqual({ ok: false, reason: 'PII_DETECTED' });
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, msgNo: '345678', excerpt: '99허0000 010-12' } })))
      .toEqual({ ok: false, reason: 'PII_DETECTED' });
    const ok = createKakaoInfoCandidate(base({ fields: { 항목: 'TEST-FAKE-ITEM', 요약: '월 대여료 1,000,000원', 값: '24개월 보증금 500,000원' } }));
    expect(ok.ok).toBe(true);
  });
  it('rejects phone fragments spread over excerpt and vehicle model (non-adjacent fields)', () => {
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, excerpt: '010-1234' }, fields: { 항목: 'TEST-FAKE-ITEM', 요약: '재고', 값: '확인' }, vehicle: { model: '5678' } })))
      .toEqual({ ok: false, reason: 'PII_DETECTED' });
  });
  it('rejects a phone number split into 6- and 5-digit fragments across non-adjacent fields', () => {
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, excerpt: '010123' }, fields: { 항목: 'TEST-FAKE-ITEM', 요약: '재고', 값: '45678' } })))
      .toEqual({ ok: false, reason: 'PII_DETECTED' });
  });
  it('does not strip supplier-code-shaped text from free strings before residual digit checks', () => {
    expect(createKakaoInfoCandidate(base({
      fields: { 항목: 'TEST-FAKE-ITEM', 요약: 'RP01012', 값: 'TEST' },
      vehicle: { model: '345678' },
    }))).toEqual({ ok: false, reason: 'PII_DETECTED' });
  });
  it('rejects email fragments in any field regardless of field order', () => {
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, excerpt: 'alice@' }, fields: { 항목: '서류', 요약: 'example.com', 값: '등본' } } as never)))
      .toEqual({ ok: false, reason: 'PII_DETECTED' });
  });
  it('rejects out-of-range plateEvidenceMsgNo such as a resident-number shaped value', () => {
    for (const bad of [9001011234567, -1, 1000000, 1.5]) {
      expect(createKakaoInfoCandidate(base({ vehicle: { ...base().vehicle, plateEvidenceMsgNo: bad } })))
        .toEqual({ ok: false, reason: 'INVALID_PLATE_EVIDENCE' });
    }
  });
  it('does not let long digit runs through confidence or grouped-amount look-alikes', () => {
    const ok = createKakaoInfoCandidate(base({ confidence: 0.9001011234567 }));
    expect(ok.ok && ok.candidate.confidence).toBe(0.9);
    for (const v of ['9,912,311,234,567', '9001011234567원', '900101만1234567원', '900101가1234567', '010가1234나5678', '010가1234 5678', '02/12345678', '9001-01-12T3:4567']) {
      const r = createKakaoInfoCandidate(base({ fields: { ...base().fields, 값: v } }));
      expect([v, r]).toEqual([v, { ok: false, reason: 'PII_DETECTED' }]);
    }
  });
  it('accepts valid ISO dates and times but still rejects resident-number shaped digits', () => {
    for (const v of ['2026-10-12T01:00:00Z', '2026-10-12', '출고 2026-10-12T01:00:00.000Z']) {
      expect(createKakaoInfoCandidate(base({ fields: { ...base().fields, 값: v } })).ok).toBe(true);
    }
    for (const v of ['9001-01-12T3:4567', '2001-01-12T3:4567', '9001011234567']) {
      expect(createKakaoInfoCandidate(base({ fields: { ...base().fields, 값: v } }))).toEqual({ ok: false, reason: 'PII_DETECTED' });
    }
  });
  it('accepts lowercase hex room codes like the real collection ones', () => {
    expect(createKakaoInfoCandidate(base({ roomCode: 'K-59ca74' })).ok).toBe(true);
    expect(createKakaoInfoCandidate(base({ roomCode: 'K-d5b7fe' })).ok).toBe(true);
  });
  it('allows natural insurance and age wording with ranges and units', () => {
    const r = createKakaoInfoCandidate(base({
      source: { ...base().source, excerpt: '만26세이상 대인,대물 30만원 / 자차면책금 50~100만원 차량수리비가액 30%입니다.' },
      fields: { 항목: '조건', 요약: '대인·대물 30만원 / 자차면책금 50~100만원 / 차량수리비 30%', 값: '만26세이상 50~100만원' },
    }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  it('does not over-reject return-condition percentages or repeated model digits', () => {
    const a = createKakaoInfoCandidate(base({
      source: { ...base().source, excerpt: '0~3개월이내 반납시 100% 환수조건! 3~6개월이내 반납시 50%환수조건!' },
      fields: { 항목: '조건', 요약: '0~3개월이내 반납시 100% 환수, 3~6개월 50% 환수', 값: '0~3개월 100% 환수, 3~6개월 50% 환수' },
    }));
    expect(a.ok, JSON.stringify(a)).toBe(true);
    const b = createKakaoInfoCandidate(base({
      source: { ...base().source, excerpt: 'K8 2.5가솔린 2WD 베스트셀렉션 → 수수료 140만원' },
      fields: { 항목: '가격', 요약: 'K8 2.5가솔린 2WD 베스트셀렉션 → 수수료 140만원', 값: '수수료 140만원' },
      vehicle: { ...base().vehicle, plate: '', model: 'K8 2.5가솔린 2WD 베스트셀렉션' },
    }));
    expect(b.ok, JSON.stringify(b)).toBe(true);
  });
  it('still rejects account-number-shaped repeated digits even though repeated runs count once in the budget', () => {
    for (const v of ['5555-5555-5555', '555555555555', '입금 5555 5555 5555']) {
      expect(createKakaoInfoCandidate(base({ fields: { ...base().fields, 값: v } })), v).toEqual({ ok: false, reason: 'PII_DETECTED' });
    }
  });
  it('accepts EN1_SUMMARY only as a confirm-needed, vehicle-unspecified summary and never as raw proof', () => {
    const summary = (patch: Record<string, unknown> = {}, vehicle: Record<string, unknown> = { plate: '', model: 'TEST-FAKE-MODEL' }) => base({
      source: { ...base().source, channel: 'EN1_SUMMARY', sentAtApprox: true, excerpt: '담당자 요약: 재고 있음', ...patch } as never,
      vehicle: vehicle as never,
      needsSupplierConfirm: true,
    });
    const ok = createKakaoInfoCandidate(summary());
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(ok.ok && ok.candidate.source).toMatchObject({ channel: 'EN1_SUMMARY', sentAtApprox: true });
    expect(createKakaoInfoCandidate({ ...summary(), needsSupplierConfirm: false })).toEqual({ ok: false, reason: 'INVALID_FIELDS' });
    expect(createKakaoInfoCandidate(summary({}, { plate: '99허0000', plateEvidence: { source: 'LITERAL_IN_UTTERANCE', distance: 0 } }))).toEqual({ ok: false, reason: 'INVALID_PLATE_EVIDENCE' });
    expect(createKakaoInfoCandidate(summary({ sentAtApprox: 'before' }))).toEqual({ ok: false, reason: 'INVALID_SOURCE' });
    expect(createKakaoInfoCandidate(summary({ channel: 'UNKNOWN_CHANNEL' }))).toEqual({ ok: false, reason: 'INVALID_SOURCE' });
    const dateInferred = createKakaoInfoCandidate(summary({ sentAtApprox: 'dateInferred' }));
    expect(dateInferred.ok && dateInferred.candidate.source.sentAtApprox).toBe('dateInferred');
  });
  it('gives fixed notices a 90-day validity, but only for KAKAO_NOTICE', () => {
    const notice = createKakaoInfoCandidate(base({ source: { ...base().source, channel: 'KAKAO_NOTICE', noticeFixed: true } as never, type: '조건', vehicle: undefined }));
    expect(notice.ok, JSON.stringify(notice)).toBe(true);
    if (!notice.ok) return;
    const signal = classifyKakaoInfoSignal(notice.candidate, '2026-10-20T00:00:00.000Z');
    expect(signal.ttlSeconds).toBe(90 * 24 * 60 * 60);
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, channel: 'KAKAO_RAW', noticeFixed: true } as never }))).toEqual({ ok: false, reason: 'INVALID_SOURCE' });
    expect(createKakaoInfoCandidate(base({ source: { ...base().source, noticeFixed: false } as never }))).toEqual({ ok: false, reason: 'INVALID_SOURCE' });
  });
  it('never auto-promotes non-raw channels or approximate send times', () => {
    const plain = createKakaoInfoCandidate(base());
    expect(plain.ok && isKakaoStateAutoPromotable(plain.candidate, true)).toBe(true);
    const approx = createKakaoInfoCandidate(base({ source: { ...base().source, sentAtApprox: true } as never }));
    expect(approx.ok && isKakaoStateAutoPromotable(approx.candidate, true)).toBe(false);
    const notice = createKakaoInfoCandidate(base({ source: { ...base().source, channel: 'KAKAO_NOTICE' } as never }));
    expect(notice.ok && isKakaoStateAutoPromotable(notice.candidate, true)).toBe(false);
  });
  it('rejects phone-like digit-heavy room codes', () => {
    expect(createKakaoInfoCandidate(base({ roomCode: 'K-010A12345678' }))).toEqual({ ok: false, reason: 'INVALID_ROOM_CODE' });
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
      fields: { 항목: 'TEST-FAKE-ITEM', 요약: '010-1234', 값: '5678' },
    }))).toEqual({ ok: false, reason: 'PII_DETECTED' });
    expect(createKakaoInfoCandidate(base({
      source: { ...base().source, sentAt: '2026-10-12T00:00:00.000Z', excerpt: '99허0000 재고 있음' },
      vehicle: { ...base().vehicle!, plate: '99허0000' },
      fields: { 항목: 'TEST-FAKE-ITEM', 요약: '계좌 확인', 값: '정상 후보' },
    })).ok).toBe(true);
    expect(createKakaoInfoCandidate(base({
      source: { ...base().source, excerpt: '99허0000 재고 있음' },
      vehicle: { ...base().vehicle!, plate: '99허0000' },
      fields: { 항목: 'TEST-FAKE-ITEM', 요약: '금액', 값: '1,000,000' },
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

    const price = assertKakaoInfoCandidate(base({ type: '가격', fields: { 항목: 'TEST-FAKE-ITEM', 요약: '가격', 값: 'TEST-FAKE-AMOUNT' } }));
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
