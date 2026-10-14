import { describe, expect, it } from 'vitest';
import { classifyAutoplusVehicleOrigin, autoplusRuleDeposit } from '../src/domain/autoplus-deposit-rule.js';
import { resolveDepositWithRuleNote, depositEvidenceInputFromProduct } from '../src/domain/deposit-evidence.js';
import { withCompatibilityDepositEvidence } from '../src/infra/erp5-compat-catalog-reader.js';
import { calculatedDepositFields, nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';

describe('오토플러스 국산/수입 판정', () => {
  it.each([
    [['현대', '더 뉴 아반떼 CN7'], 'DOMESTIC'], [['기아', 'K5 2.0'], 'DOMESTIC'], [['', '디 올뉴니로EV 에어'], 'DOMESTIC'],
    [['제네시스', 'GV80 3.0'], 'DOMESTIC'], [['', '토레스 EVX'], 'DOMESTIC'], [['', '더뉴그랜저'], 'DOMESTIC'], [['르노코리아', 'QM6'], 'DOMESTIC'],
    [['BMW', '520i'], 'IMPORT'], [['메르세데스-벤츠', 'E-클래스 E300'], 'IMPORT'], [['', '테슬라 Model Y'], 'IMPORT'], [['', 'Model 3 롱레인지'], 'IMPORT'],
    [['아우디', 'A6 45 TFSI'], 'IMPORT'], [['', '볼보 XC60'], 'IMPORT'], [['', '레인지 로버 벨라'], 'IMPORT'], [['', 'BMW X3 xDrive20i'], 'IMPORT'],
  ] as const)('%j → %s', (texts, origin) => {
    expect(classifyAutoplusVehicleOrigin(...texts).origin).toBe(origin);
  });
  it('모르는 차·양쪽 다 걸림·쉐보레는 UNKNOWN(추측 금지), 영문 숫자 이름은 뒤 숫자가 붙으면 다른 차', () => {
    expect(classifyAutoplusVehicleOrigin('아무차', '모름')).toMatchObject({ origin: 'UNKNOWN', reason: 'NO_MATCH' });
    expect(classifyAutoplusVehicleOrigin('제네시스', 'BMW X3')).toMatchObject({ origin: 'UNKNOWN', reason: 'BOTH_MATCHED' });
    expect(classifyAutoplusVehicleOrigin('쉐보레', '트레일블레이저')).toMatchObject({ origin: 'UNKNOWN', reason: 'AMBIGUOUS_BRAND' });
    expect(classifyAutoplusVehicleOrigin('', '트랙스 크로스오버')).toMatchObject({ origin: 'UNKNOWN', reason: 'AMBIGUOUS_BRAND' });
    expect(classifyAutoplusVehicleOrigin('', 'IX35')).toMatchObject({ origin: 'UNKNOWN' });   // IX(BMW) ≠ IX35
    expect(classifyAutoplusVehicleOrigin('', 'i40')).toMatchObject({ origin: 'UNKNOWN' });    // I4(BMW) ≠ i40
    expect(classifyAutoplusVehicleOrigin(null, undefined, '')).toMatchObject({ origin: 'UNKNOWN', reason: 'NO_MATCH' });
  });
  it('Codex #642 ③: 낱말 경계 — 앞부분만 같다고 같은 차가 아니다(레인지로버·미니밴·레이스), 세대·형식 꼬리는 같은 차', () => {
    expect(classifyAutoplusVehicleOrigin('', '레인지로버 이보크').origin).toBe('IMPORT');    // 레이(기아) 로 읽히지 않는다
    expect(classifyAutoplusVehicleOrigin('', '레인지로버스포츠').origin).toBe('IMPORT');   // 허용 꼬리(스포츠)는 같은 차
    expect(classifyAutoplusVehicleOrigin('', '레인지로버벨라수입').origin).toBe('UNKNOWN');   // 모르는 한글 꼬리는 다른 이름
    expect(classifyAutoplusVehicleOrigin('', '미니밴')).toMatchObject({ origin: 'UNKNOWN', reason: 'NO_MATCH' });   // 미니(수입) 로 읽히지 않는다
    expect(classifyAutoplusVehicleOrigin('', '레이스')).toMatchObject({ origin: 'UNKNOWN' });                       // 레이(기아) 아님
    expect(classifyAutoplusVehicleOrigin('', '레이')).toMatchObject({ origin: 'DOMESTIC' });
    expect(classifyAutoplusVehicleOrigin('', '더뉴레이')).toMatchObject({ origin: 'DOMESTIC' });
    expect(classifyAutoplusVehicleOrigin('', '미니 쿠퍼').origin).toBe('IMPORT');
    expect(classifyAutoplusVehicleOrigin('', '아반떼CN7').origin).toBe('DOMESTIC');
    expect(classifyAutoplusVehicleOrigin('', '쏘나타 하이브리드').origin).toBe('DOMESTIC');
    expect(classifyAutoplusVehicleOrigin('', '쏘나타하이브리드').origin).toBe('DOMESTIC');
    expect(classifyAutoplusVehicleOrigin('', '모닝어반').origin).toBe('UNKNOWN');
  });
  it('계산: 국산 ×2, 수입 ×3, 대여료가 양의 정수가 아니면 null(ZERO 없음)', () => {
    expect(autoplusRuleDeposit('AUTOPLUS_RENT_X2_DOMESTIC', 770000)).toBe(1540000);
    expect(autoplusRuleDeposit('AUTOPLUS_RENT_X3_IMPORT', 770000)).toBe(2310000);
    expect(autoplusRuleDeposit('AUTOPLUS_RENT_X2_DOMESTIC', 0)).toBeNull();
    expect(autoplusRuleDeposit('AUTOPLUS_RENT_X3_IMPORT', '770000')).toBeNull();
  });
});

const engineDoc = (over: Record<string, unknown> = {}) => ({
  provider_company_code: 'RP023', product_type: '오플구독', deposit_source: 'CALCULATED', deposit_rule: 'AUTOPLUS_RENT_X2_DOMESTIC',
  source_cycle_write: { by: 'source-engine', status: '출고가능', at: '2026-10-14T00:00:00Z' },
  price: { '12': { rent: 770000, deposit: 1540000, mileage: '20000km/year' } }, ...over,
});
const resolve = (product: Record<string, unknown>, rent = 770000) => {
  const row = (product.price as Record<string, Record<string, unknown>>)['12']!;
  return resolveDepositWithRuleNote(depositEvidenceInputFromProduct(product, row.deposit, { termMonths: 12, monthlyRent: rent }));
};

describe('계산 보증금 표시(RP023 엔진 문서만)', () => {
  it('RP023 엔진 문서의 계산값은 KNOWN 이고 계산 규칙이 근거로 보인다', () => {
    expect(resolve(engineDoc())).toMatchObject({ state: 'KNOWN', amount: 1540000, reason: 'CALCULATED_RULE:AUTOPLUS_RENT_X2_DOMESTIC',
      rule: { code: 'AUTOPLUS_RENT_X2_DOMESTIC', multiplier: 2 } });
    const compat = withCompatibilityDepositEvidence(engineDoc());
    expect((compat.price as Record<string, Record<string, unknown>>)['12']).toMatchObject({ deposit: 1540000, depositState: 'KNOWN',
      depositStatusLabel: '보증금 있음', depositEvidenceReason: 'CALCULATED_RULE:AUTOPLUS_RENT_X2_DOMESTIC' });
  });
  it('대여료와 맞지 않는 계산값(낡은 값)은 공급사 금액으로 둔갑하지 않고 UNKNOWN', () => {
    expect(resolve(engineDoc(), 800000)).toMatchObject({ state: 'UNKNOWN', reason: 'CALCULATED_DEPOSIT_RULE_MISMATCH' });
  });
  it('다른 공급사·엔진이 쓰지 않은 문서·모르는 규칙은 계산 근거로 쓰지 않는다', () => {
    expect(resolve(engineDoc({ provider_company_code: 'RP005' })).reason).toBe('SOURCE_AMOUNT');
    expect(resolve(engineDoc({ source_cycle_write: { by: 'erp4' } })).reason).toBe('SOURCE_AMOUNT');
    expect(resolve(engineDoc({ deposit_rule: 'RENT_X_9' })).reason).toBe('SOURCE_AMOUNT');
    expect(resolve(engineDoc({ deposit_source: 'SUPPLIER' })).reason).toBe('SOURCE_AMOUNT');
    // 다른 공급사가 금액 없이 같은 표식만 가져도 KNOWN 이 되지 않는다
    expect(resolve(engineDoc({ provider_company_code: 'RP005', price: { '12': { rent: 770000, deposit: null } } })).state).toBe('UNKNOWN');
    // 입력을 직접 만들어도 RP023 이 아니면 무시
    expect(resolveDepositWithRuleNote({ supplierId: 'RP005', productType: '중고렌트', sourceAmount: 1540000, monthlyRent: 770000,
      termMonths: 12, calculatedDepositRule: 'AUTOPLUS_RENT_X2_DOMESTIC' }).reason).toBe('SOURCE_AMOUNT');
  });
});

describe('엔진 쓰기: 계산 보증금 표식', () => {
  const record = (rule: string | null, deposit: number | null): SourceProductRecord => ({ sourceId: 'RP023', uid: '05수4216', plate: '05수4216', vehicleText: '니로',
    status: { raw: '출고가능', saleAvailable: true }, observedAt: '2026-10-14T00:00:00Z', raw: { source: 'autoplus-sheet' }, vehicleHold: [],
    terms: [{ months: 12, monthlyRent: { state: 'KNOWN', value: 770000 }, mileage: '20000km/year',
      deposit: deposit === null ? { state: 'UNKNOWN', value: null } : { state: 'KNOWN', value: deposit }, raw: rule ? { deposit_rule: rule } : {} }] });
  it('계산 항마다 deposit_rules[개월] 을 쓰고(deposit_source=CALCULATED), 계산 항이 없으면 표식을 지운다', () => {
    expect(calculatedDepositFields(record('AUTOPLUS_RENT_X2_DOMESTIC', 1540000))).toEqual({ deposit_source: 'CALCULATED',
      deposit_rules: { '12': 'AUTOPLUS_RENT_X2_DOMESTIC' }, deposit_rule: null });
    // 판정 불가(UNKNOWN) 항에는 규칙이 없다. 엔진 보존은 계획 단계에서 이전 KNOWN 과 그 규칙 코드를 함께 되살린다(source-cycle).
    expect(calculatedDepositFields(record(null, null))).toEqual({ deposit_source: null, deposit_rules: null, deposit_rule: null });
    expect(calculatedDepositFields({ ...record('AUTOPLUS_RENT_X2_DOMESTIC', 1540000), sourceId: 'RP005' })).toEqual({});
    const fields = nativeCycleFields({ record: record('AUTOPLUS_RENT_X3_IMPORT', 2310000), listable: true, locked_by_contract: false,
      publication_withdrawal: null, publication_withdrawal_prior: null } as never);
    expect(fields).toMatchObject({ deposit_source: 'CALCULATED', deposit_rules: { '12': 'AUTOPLUS_RENT_X3_IMPORT' }, price: { '12': { rent: 770000, deposit: 2310000 } } });
    // 엔진이 쓴 문서를 소비처가 읽으면 계산값이 KNOWN 으로 보인다(쓰기→표시 왕복)
    const doc = { ...fields, provider_company_code: 'RP023' };
    expect(resolve(doc as Record<string, unknown>)).toMatchObject({ state: 'KNOWN', amount: 2310000, reason: 'CALCULATED_RULE:AUTOPLUS_RENT_X3_IMPORT' });
  });
});
