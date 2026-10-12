// 원천 신선도 자동 보류 규칙(순수 함수). 설계: ai-ops docs/설계/원천-실시간-설계-20261012.md (Codex 상의, 2026-10-12) — 정책 후보값.
// 수집기가 멈춰도 만료가 작동하도록 «읽는 쪽»(ERP5·카톡)이 매번 valid_until 을 계산해 검사한다. 쓰기·저장 없음.
// 나이는 «유효한 상태 관측 시각»에서 센다. HTTP 200·작업 시작·사진 갱신으로 연장하지 않는다. 관측 시각을 모르면 UNKNOWN(= 판매 가능에서 제외, 0 으로 바꾸지 않음).

export type FreshnessClass = 'F05_SHEET' | 'AICA_SHEET' | 'IANCAR_ONE' | 'OTHER';
export type FreshnessState = 'FRESH' | 'WARN' | 'HOLD' | 'UNKNOWN';

export const SOURCE_FRESHNESS_POLICY_VERSION = 'source-freshness/2026-10-12-candidate';
/** 분 단위. warn = 경고 나이, hold = 판매 가능 자동 보류 나이(운영 정책 후보). */
export const SOURCE_FRESHNESS_MINUTES: Readonly<Record<FreshnessClass, { warn: number; hold: number }>> = {
  F05_SHEET: { warn: 5, hold: 10 },
  AICA_SHEET: { warn: 3, hold: 5 },
  IANCAR_ONE: { warn: 45, hold: 60 },
  OTHER: { warn: 15, hold: 30 },
};

export function freshnessClassOf(supplierCode: string | null | undefined, f05SupplierCodes: ReadonlySet<string>): FreshnessClass {
  if (supplierCode === 'RP004') return 'AICA_SHEET';
  if (supplierCode === 'RP031') return 'IANCAR_ONE';
  if (supplierCode && f05SupplierCodes.has(supplierCode)) return 'F05_SHEET';
  return 'OTHER';
}

const toMs = (value: unknown): number | null => {
  if (typeof value === 'number') return value > 1e12 ? value : value > 1e9 ? value * 1000 : null;
  if (typeof value === 'string' && value.trim()) { const t = Date.parse(value); return Number.isFinite(t) ? t : null; }
  return null;
};

/** 유효한 상태 관측 시각: 가변값(요금·상태)을 다시 물어본 시각과 원천에서 직접 받아 쓴 시각 중 가장 늦은 것. */
export function stateObservedAtMs(product: Record<string, unknown>): number | null {
  const times = ['_var_polled_at', '_direct_ingest_at'].map(key => toMs(product[key])).filter((t): t is number => t != null);
  return times.length ? Math.max(...times) : null;
}

export type FreshnessVerdict = {
  state: FreshnessState; class: FreshnessClass; ageMinutes: number | null; observedAt: string | null;
  validUntil: string | null; sellable: boolean; policyVersion: string;
};

export function evaluateSourceFreshness(product: Record<string, unknown>, now: number, f05SupplierCodes: ReadonlySet<string>): FreshnessVerdict {
  const supplier = String(product.provider_company_code ?? product.partner_code ?? '') || null;
  const cls = freshnessClassOf(supplier, f05SupplierCodes), limit = SOURCE_FRESHNESS_MINUTES[cls];
  const observed = stateObservedAtMs(product);
  if (observed == null || observed > now + 60_000) // 미래 시각은 믿지 않는다
    return { state: 'UNKNOWN', class: cls, ageMinutes: null, observedAt: null, validUntil: null, sellable: false, policyVersion: SOURCE_FRESHNESS_POLICY_VERSION };
  const age = (now - observed) / 60_000;
  const state: FreshnessState = age > limit.hold ? 'HOLD' : age > limit.warn ? 'WARN' : 'FRESH';
  return { state, class: cls, ageMinutes: Math.round(age * 10) / 10, observedAt: new Date(observed).toISOString(),
    validUntil: new Date(observed + limit.hold * 60_000).toISOString(), sellable: state !== 'HOLD', policyVersion: SOURCE_FRESHNESS_POLICY_VERSION };
}
