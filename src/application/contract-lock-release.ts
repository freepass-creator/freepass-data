import { stableDigest } from '../shared/stable-digest.js';

type Rec = Record<string, unknown>;

export type ContractLockReleaseItem = {
  plate: string;
  supplierCode: string;
  sheetRow: number;
  expectedLockAt: number;
};

export type ContractLockReleasePlan = {
  planId: string;
  items: ContractLockReleaseItem[];
};

/** 접수 시트에서 해제 직전에 다시 읽은 증거(작업 담당이 만든다). */
export type ContractLockSheetEvidence = {
  readAt: string;
  items: Array<{
    plate: string;
    intakeRows: Array<{ row: number; cancel: boolean }>;
    otherTabHits: number;
  }>;
};

export type ContractLockDecision =
  | { plate: string; decision: 'RELEASABLE'; reason: null }
  | { plate: string; decision: 'HOLD'; reason: string };

export const CONTRACT_LOCK_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000;
const RELEASABLE_LOCK_VALUE = 'LEDGER';

export const contractLockPlanDigest = (plan: ContractLockReleasePlan) => stableDigest({
  planId: plan.planId,
  items: [...plan.items].sort((a, b) => a.plate.localeCompare(b.plate)),
});

/** 상품 한 건에 대한 해제 판정. 하나라도 어긋나면 보류(사유 하나만 돌려준다). */
export function decideContractLockRelease(
  item: ContractLockReleaseItem,
  product: Rec | null,
  evidence: ContractLockSheetEvidence | null,
  now: Date,
): ContractLockDecision {
  const hold = (reason: string): ContractLockDecision => ({ plate: item.plate, decision: 'HOLD', reason });
  if (!product) return hold('PRODUCT_NOT_FOUND');
  if (product.provider_company_code !== item.supplierCode) return hold('SUPPLIER_MISMATCH');
  if (product.locked_by_contract !== RELEASABLE_LOCK_VALUE) return hold('LOCK_VALUE_NOT_LEDGER');
  if (product._ledger_lock_at !== item.expectedLockAt) return hold('LOCK_TIME_CHANGED');
  if (!evidence) return hold('SHEET_EVIDENCE_MISSING');
  const readAt = Date.parse(evidence.readAt);
  if (!Number.isFinite(readAt) || now.getTime() - readAt > CONTRACT_LOCK_EVIDENCE_MAX_AGE_MS || readAt - now.getTime() > 60_000) {
    return hold('SHEET_EVIDENCE_STALE');
  }
  const own = evidence.items.find(entry => entry.plate === item.plate);
  if (!own) return hold('SHEET_EVIDENCE_MISSING');
  const target = own.intakeRows.find(row => row.row === item.sheetRow);
  if (!target) return hold('SHEET_ROW_NOT_FOUND');
  if (!target.cancel) return hold('SHEET_CANCEL_NOT_ENTERED');
  if (own.intakeRows.some(row => !row.cancel)) return hold('LIVE_INTAKE_ROW_EXISTS');
  if (own.otherTabHits > 0) return hold('OTHER_TAB_HIT');
  return { plate: item.plate, decision: 'RELEASABLE', reason: null };
}

export function summarizeContractLockDecisions(decisions: ContractLockDecision[]) {
  const reasons: Record<string, number> = {};
  for (const decision of decisions) if (decision.reason) reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
  return {
    total: decisions.length,
    releasable: decisions.filter(decision => decision.decision === 'RELEASABLE').length,
    hold: decisions.filter(decision => decision.decision === 'HOLD').length,
    holdReasons: reasons,
  };
}
