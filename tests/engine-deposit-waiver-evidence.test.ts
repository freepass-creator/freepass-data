import { describe, expect, it } from 'vitest';
import { ironDepositWaiverText, sharedSheetEngineWaiverBasis } from '../src/domain/deposit-evidence.js';
import { withCompatibilityDepositEvidence } from '../src/infra/erp5-compat-catalog-reader.js';

// 값은 전부 가짜. 원천 엔진이 쓴 아이카·아이언 문서의 명시 «무보증» 글자를 보증금 0원 근거로 인정한다(PC3 커맨드 10-28, #815 와 같은 근거).
const AT = '2026-10-28T06:00:00.000Z';
const NOW = '2026-10-28T06:10:00.000Z';
type Doc = Record<string, unknown> & { source_cycle_record: Record<string, unknown> };
const doc = (kind: 'iron' | 'aica', depositRaw: Record<string, unknown>, over: Record<string, unknown> = {}): Doc => {
  const sourceId = kind === 'iron' ? 'RP006' : 'RP004';
  const months = kind === 'iron' ? [36, 48] : [48];
  return {
    _key: 'uid-1', provider_company_code: sourceId, car_number: '12가3456', listable: true, status: '즉시출고', product_type: '신차렌트',
    source_cycle_write: { by: 'source-engine', at: AT },
    source_cycle_record: { sourceId, uid: 'uid-1', plate: '12가3456', observedAt: AT, status: { raw: '출고가능', saleAvailable: true },
      raw: { source: kind === 'iron' ? 'ironrentcar-web' : 'aica-sheet' },
      terms: months.map(m => ({ months: m, monthlyRent: { state: 'KNOWN', value: 500000 + m }, deposit: { state: 'ZERO', value: 0 }, mileage: null, raw: depositRaw })) },
    price: Object.fromEntries(months.map(m => [String(m), { rent: 500000 + m, deposit: 0 }])),
    ...over,
  };
};
const states = (d: Doc) => Object.values(withCompatibilityDepositEvidence(d, NOW).price as Record<string, { depositState: string }>).map(r => r.depositState);
const IRON_TEXT = '보증금 0원 무보증, 운전경력증명서, 소득확인필수, 환수조건있음';

describe('원천 엔진 명시 «무보증» 글자 → 보증금 0원 근거(아이카·아이언)', () => {
  it('아이언 보증금 글자: «무보증» + 숫자는 0 뿐일 때만', () => {
    expect(ironDepositWaiverText(IRON_TEXT)).toBe(true);
    expect(ironDepositWaiverText('무보증')).toBe(true);
    expect(ironDepositWaiverText('보증금 300만원(무보증 가능)')).toBe(false);
    expect(ironDepositWaiverText('보증금 1,000,000원 / 무보증 상품 문의')).toBe(false);
    expect(ironDepositWaiverText('보증금 0원')).toBe(false);   // 0 숫자만으로는 무보증 근거가 아니다
    expect(ironDepositWaiverText(null)).toBe(false);
  });

  it('아이언: 모든 기간이 ZERO(이전에는 DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE 로 확인 필요)', () => {
    const d = doc('iron', { deposit_text: IRON_TEXT });
    expect(states(d)).toEqual(['ZERO', 'ZERO']);
    expect(sharedSheetEngineWaiverBasis(d, 0, 36, 500036, NOW)).toEqual({ field: 'source_cycle_record.terms', text: '무보증', source: 'source-engine', at: AT });
  });

  it('아이언: 금액 글자와 엇갈리거나·계약중·다른 원천·다른 공급사면 무보증으로 단정하지 않는다', () => {
    expect(states(doc('iron', { deposit_text: '보증금 300만원(무보증 가능)' }))).toEqual(['UNKNOWN', 'UNKNOWN']);
    expect(states(doc('iron', { deposit_text: IRON_TEXT }, { status: '계약중' }))).toEqual(['UNKNOWN', 'UNKNOWN']);
    const other = doc('iron', { deposit_text: IRON_TEXT });
    other.source_cycle_record = { ...other.source_cycle_record, raw: { source: 'iron-homepage-other' } };
    expect(states(other)).toEqual(['UNKNOWN', 'UNKNOWN']);
    const wrongSupplier = doc('iron', { deposit_text: IRON_TEXT });
    wrongSupplier.source_cycle_record = { ...wrongSupplier.source_cycle_record, sourceId: 'RP005' };
    expect(states({ ...wrongSupplier, provider_company_code: 'RP005' })).toEqual(['UNKNOWN', 'UNKNOWN']);
  });

  it('아이카: 항 원문 «무보증» 이면 ZERO, 같은 문서 원문 «장기보증»이 금액이면 무보증으로 단정하지 않는다(2904 유형)', () => {
    expect(states(doc('aica', { deposit: '무보증' }))).toEqual(['ZERO']);
    expect(states(doc('aica', { deposit: '무보증' }, { 원문: { 전체: { 장기보증: '500,000' } } }))).not.toContain('ZERO');
    expect(states(doc('aica', { deposit: '무보증' }, { status: '계약중' }))).toEqual(['UNKNOWN']);
  });
});
