import type { SourceFamily, SourceProductRecord } from '../domain/source-engine.js';

export type SupplierFields = { provider_name: string; policy_code: string | null };
export type CycleProduct = {
  supplierFields?: SupplierFields;
  record: SourceProductRecord;
  locked_by_contract: boolean;
  listable: boolean;
  publication_withdrawal: { reason: string; source: string; observedAt: string; deleteAuthorized: false } | null;
  publication_withdrawal_prior: { listable: boolean; status: SourceProductRecord['status'] } | null;
};
export type CycleSnapshot = { products: CycleProduct[]; complete: boolean; enrollmentSupplier?: SupplierFields | null;
  /** --accept-drift 로 허용된 보정 문서 uid(계획 digest 에 경고로 기록). */ acceptedDrift?: string[] };
/** Implement with CatalogStore transactions, expected revision/digest, receipts and audit.
 * CAS must check the entire envelope, including the contract lock, atomically. No delete API. */
export interface CycleCommands {
  list(sourceId: string): Promise<CycleSnapshot>;
  read(sourceId: string, uid: string): Promise<CycleProduct | null>;
  backup(key: string, before: CycleProduct | null): Promise<void>;
  readBackup(key: string): Promise<CycleProduct | null>;
  compareAndApply(beforeDigest: string, after: CycleProduct, commandKey: string): Promise<void>;
}
export type CycleConfig = { sourceId: string; family: SourceFamily; maxDowngradeRatio: number; downgradeFloor?: number };
export type CycleEvidence = { records: SourceProductRecord[]; complete: boolean; observedAt: string | null; heldCount: number;
  unassignedPlateCount?: number };
export type CycleEntry = { kind: 'DOWNGRADE' | 'ENROLL' | 'REEXPOSE' | 'UPDATE'; before: CycleProduct | null; after: CycleProduct };
export type CyclePlan = {
  schema: 'source-cycle/v1'; config: CycleConfig; plannedAt: number; evidence: CycleEvidence;
  entries: CycleEntry[]; held: number; blockers: string[]; sourceCount: number; exposedBefore: number;
  warnings: string[]; unassignedPlateCount: number;
};
export type CycleState = { failures: number; stopped: boolean; lastSyncedAt: string | null;
  observationOnlyCount?: number;
  observedSellableCount?: number; unassignedPlateCount?: number;
  lastAttemptAt: string | null; lastCompleteAt: string | null; readCount: number; heldCount: number; error: string | null };
export const emptyCycleState = (): CycleState => ({ failures: 0, stopped: false, lastSyncedAt: null,
  lastAttemptAt: null, lastCompleteAt: null, readCount: 0, heldCount: 0, error: null });
export interface CycleControl {
  acquire(sourceId: string): Promise<null | (() => Promise<void>)>;
  load(sourceId: string): Promise<CycleState>;
  save(sourceId: string, state: CycleState): Promise<void>;
  heartbeat(sourceId: string, state: CycleState, plan: CyclePlan | null): Promise<void>;
  alert(sourceId: string, reason: string): Promise<void>;
}
