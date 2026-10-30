import { releasableLockToken } from '../domain/contract-lock-release-update.js';
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
  /** 다른 탭(분납·완납 등) 조회에 «성공한» 탭 이름 목록. 비어 있으면 증거로 인정하지 않는다. */
  otherTabsRead: string[];
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
/** 해제 증거는 최소한 이 탭들을 «모두» 조회해 성공했어야 한다(분납·완납에 살아 있는 계약이 있으면 해제하면 안 된다). */
export const CONTRACT_LOCK_REQUIRED_OTHER_TABS = ['분납실적', '완납실적'] as const;

/** JSON 에서 읽은 증거를 형식까지 검증한다(문자열 "FALSE"·누락·null·음수 등은 증거가 아니다). 틀리면 null. */
export function parseContractLockSheetEvidence(value: unknown): ContractLockSheetEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.readAt !== 'string' || !Number.isFinite(Date.parse(input.readAt))) return null;
  if (!Array.isArray(input.otherTabsRead) || !input.otherTabsRead.length
    || input.otherTabsRead.some(tab => typeof tab !== 'string' || !tab)) return null;
  if (!CONTRACT_LOCK_REQUIRED_OTHER_TABS.every(tab => (input.otherTabsRead as string[]).includes(tab))) return null;
  if (!Array.isArray(input.items)) return null;
  const items: ContractLockSheetEvidence['items'] = [];
  const seen = new Set<string>();
  for (const raw of input.items) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.plate !== 'string' || !item.plate || !Array.isArray(item.intakeRows) || seen.has(item.plate)) return null;
    seen.add(item.plate);
    if (typeof item.otherTabHits !== 'number' || !Number.isInteger(item.otherTabHits) || item.otherTabHits < 0) return null;
    const intakeRows: Array<{ row: number; cancel: boolean }> = [];
    for (const rawRow of item.intakeRows) {
      if (!rawRow || typeof rawRow !== 'object') return null;
      const row = rawRow as Record<string, unknown>;
      if (typeof row.row !== 'number' || !Number.isInteger(row.row) || row.row < 1 || typeof row.cancel !== 'boolean') return null;
      intakeRows.push({ row: row.row, cancel: row.cancel });
    }
    items.push({ plate: item.plate, intakeRows, otherTabHits: item.otherTabHits });
  }
  return { readAt: input.readAt, otherTabsRead: input.otherTabsRead as string[], items };
}

/** 계획 JSON 형식 검증: 번호·공급사 코드 문자열, 시트 행·잠금 시각 정수(생략·null 불가), 같은 차량 중복 불가. 틀리면 null. */
export function parseContractLockReleasePlan(value: unknown): ContractLockReleasePlan | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.planId !== 'string' || !input.planId || !Array.isArray(input.items) || !input.items.length) return null;
  const items: ContractLockReleaseItem[] = [];
  const seen = new Set<string>();
  for (const raw of input.items) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.plate !== 'string' || !entry.plate || seen.has(entry.plate)) return null;
    if (typeof entry.supplierCode !== 'string' || !entry.supplierCode) return null;
    if (typeof entry.sheetRow !== 'number' || !Number.isInteger(entry.sheetRow) || entry.sheetRow < 1) return null;
    if (typeof entry.expectedLockAt !== 'number' || !Number.isInteger(entry.expectedLockAt) || entry.expectedLockAt <= 0) return null;
    seen.add(entry.plate);
    items.push({ plate: entry.plate, supplierCode: entry.supplierCode, sheetRow: entry.sheetRow, expectedLockAt: entry.expectedLockAt });
  }
  return { planId: input.planId, items };
}

export const isContractLockEvidenceFresh = (evidence: Pick<ContractLockSheetEvidence, 'readAt'>, now: Date) => {
  const readAt = Date.parse(evidence.readAt);
  return Number.isFinite(readAt) && now.getTime() - readAt <= CONTRACT_LOCK_EVIDENCE_MAX_AGE_MS && readAt - now.getTime() <= 60_000;
};

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
  const token = releasableLockToken(product);
  if (!token) return hold('LOCK_VALUE_NOT_LEDGER');
  if (token.value !== item.expectedLockAt) return hold('LOCK_TIME_CHANGED');
  if (!evidence) return hold('SHEET_EVIDENCE_MISSING');
  if (!isContractLockEvidenceFresh(evidence, now)) return hold('SHEET_EVIDENCE_STALE');
  if (!Array.isArray(evidence.otherTabsRead) || !CONTRACT_LOCK_REQUIRED_OTHER_TABS.every(tab => evidence.otherTabsRead.includes(tab))) return hold('SHEET_EVIDENCE_MISSING');
  const own = evidence.items.find(entry => entry.plate === item.plate);
  if (!own) return hold('SHEET_EVIDENCE_MISSING');
  const target = own.intakeRows.find(row => row.row === item.sheetRow);
  if (!target) return hold('SHEET_ROW_NOT_FOUND');
  if (target.cancel !== true) return hold('SHEET_CANCEL_NOT_ENTERED');
  if (own.intakeRows.some(row => row.cancel !== true)) return hold('LIVE_INTAKE_ROW_EXISTS');
  if (!Number.isInteger(own.otherTabHits) || own.otherTabHits !== 0) return hold('OTHER_TAB_HIT');
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

