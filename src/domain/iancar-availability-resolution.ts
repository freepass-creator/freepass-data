export const IANCAR_AVAILABILITY_RULE_VERSION = 'iancar-availability-resolution/1';

export type IancarAvailabilityInput = {
  erp: { observed: boolean; explicitState?: string | null; sourceRevision: string; observedAt: string;
    coverageComplete: boolean; freshnessVerified: boolean };
  sheet: { observed: boolean; sourceRevision: string; observedAt: string;
    coverageComplete: boolean; freshnessVerified: boolean };
  previouslyRegistered: boolean;
};

export type IancarAvailabilityResolution = {
  ruleVersion: typeof IANCAR_AVAILABILITY_RULE_VERSION;
  sourceDecision: 'IANCAR_ERP' | 'IANCAR_SHEET' | 'HISTORY_ONLY' | 'NONE';
  state: '출고가능' | '출고협의' | '예약중' | '판매완료' | '출고불가' | '미관측';
  canonicalStatus: 'AVAILABLE' | 'RESERVED' | 'SOLD' | 'UNAVAILABLE' | 'HOLD' | 'NO_CANDIDATE';
  reviewRequired: boolean;
  deleteAuthorized: false;
  reasons: string[];
};

const explicit = new Map([
  ['예약', ['예약중', 'RESERVED']], ['예약중', ['예약중', 'RESERVED']], ['계약중', ['예약중', 'RESERVED']],
  ['판매', ['판매완료', 'SOLD']], ['판매완료', ['판매완료', 'SOLD']], ['출고불가', ['출고불가', 'UNAVAILABLE']]
] as const);
const revision = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value === value.trim();
const instant = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
  && Number.isFinite(Date.parse(value));

/**
 * CREATE_NEW_JUSTIFIED: the existing ERP5 mapper interprets one published record. It cannot
 * resolve two independent upstream observations without losing absence and precedence evidence.
 * This pure function performs no reads or writes and never authorizes deletion.
 */
export function resolveIancarAvailability(input: IancarAvailabilityInput): IancarAvailabilityResolution {
  if (!input || typeof input !== 'object' || typeof input.erp?.observed !== 'boolean'
    || typeof input.sheet?.observed !== 'boolean' || typeof input.previouslyRegistered !== 'boolean'
    || typeof input.erp.coverageComplete !== 'boolean' || typeof input.erp.freshnessVerified !== 'boolean'
    || typeof input.sheet.coverageComplete !== 'boolean' || typeof input.sheet.freshnessVerified !== 'boolean'
    || !revision(input.erp.sourceRevision) || !instant(input.erp.observedAt)
    || !revision(input.sheet.sourceRevision) || !instant(input.sheet.observedAt)) {
    throw new Error('INVALID_IANCAR_AVAILABILITY_INPUT');
  }
  const raw = input.erp.explicitState;
  if (raw !== undefined && raw !== null && (typeof raw !== 'string' || !raw.trim() || raw !== raw.trim())) {
    throw new Error('INVALID_IANCAR_ERP_EXPLICIT_STATE');
  }
  const base = { ruleVersion: IANCAR_AVAILABILITY_RULE_VERSION, deleteAuthorized: false } as const;
  if (!input.erp.observed && raw) throw new Error('ERP_STATE_WITHOUT_OBSERVATION');
  const erpTrusted = input.erp.coverageComplete && input.erp.freshnessVerified;
  const sheetTrusted = input.sheet.coverageComplete && input.sheet.freshnessVerified;
  if (input.erp.observed && !erpTrusted) return { ...base, sourceDecision: 'IANCAR_ERP', state: '미관측',
    canonicalStatus: 'HOLD', reviewRequired: true, reasons: ['ERP_OBSERVATION_NOT_CURRENT_AND_COMPLETE'] };
  if (!input.erp.observed && (!erpTrusted || !sheetTrusted)) return {
    ...base, sourceDecision: input.sheet.observed ? 'IANCAR_SHEET' : 'NONE', state: '미관측',
    canonicalStatus: 'HOLD', reviewRequired: true, reasons: ['SOURCE_ABSENCE_NOT_PROVEN_CURRENT_AND_COMPLETE']
  };
  if (input.erp.observed) {
    if (raw) {
      const mapped = explicit.get(raw as never);
      if (!mapped) return { ...base, sourceDecision: 'IANCAR_ERP', state: '미관측', canonicalStatus: 'HOLD',
        reviewRequired: true, reasons: ['UNKNOWN_EXPLICIT_ERP_STATE', 'ERP_VALUE_MUST_NOT_BE_GUESSED'] };
      return { ...base, sourceDecision: 'IANCAR_ERP', state: mapped[0], canonicalStatus: mapped[1],
        reviewRequired: false, reasons: ['EXPLICIT_ERP_STATE'] };
    }
    return { ...base, sourceDecision: 'IANCAR_ERP', state: '출고가능', canonicalStatus: 'AVAILABLE',
      reviewRequired: false, reasons: input.sheet.observed ? ['ERP_PRECEDENCE_OVER_SHEET'] : ['OBSERVED_IN_IANCAR_ERP'] };
  }
  if (input.sheet.observed) return { ...base, sourceDecision: 'IANCAR_SHEET', state: '출고협의',
    canonicalStatus: 'HOLD', reviewRequired: true, reasons: ['SHEET_ONLY_REQUIRES_ERP_CONFIRMATION'] };
  if (input.previouslyRegistered) return { ...base, sourceDecision: 'HISTORY_ONLY', state: '미관측',
    canonicalStatus: 'HOLD', reviewRequired: true, reasons: ['UNOBSERVED_IN_ERP_AND_SHEET', 'PRESERVE_REGISTERED_HISTORY'] };
  return { ...base, sourceDecision: 'NONE', state: '미관측', canonicalStatus: 'NO_CANDIDATE',
    reviewRequired: false, reasons: ['NOT_OBSERVED_OR_REGISTERED'] };
}
