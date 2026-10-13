import type { SourceFamily, SourceProductRecord } from '../domain/source-engine.js';

export type SupplierFields = { provider_name: string; policy_code: string | null };
export type CycleProduct = {
  supplierFields?: SupplierFields;
  record: SourceProductRecord;
  locked_by_contract: boolean;
  listable: boolean;
  /** 노출 문서가 원천 값은 같아도 한 번 다시 써야 하는 사유(읽기 경로가 계산, 쓰기 결과에는 남지 않는다):
   * PRICE_LAYOUT 옵션 가격 키 누락 · STATUS_KIND 저장된 vehicle_status 의 계약 값과 다름 · PRODUCT_TYPE 월렌트 상품 구분 누락. */
  rewriteReasons?: Array<'PRICE_LAYOUT' | 'STATUS_KIND' | 'PRODUCT_TYPE'>;
  publication_withdrawal: { reason: string; source: string; observedAt: string; deleteAuthorized: false } | null;
  publication_withdrawal_prior: { listable: boolean; status: SourceProductRecord['status'] } | null;
};
export type CycleSnapshot = { products: CycleProduct[]; complete: boolean; enrollmentSupplier?: SupplierFields | null;
  /** --accept-drift 로 허용된 보정 문서 uid(계획 digest 에 경고로 기록). */ acceptedDrift?: string[];
  /** 가격이 저장 digest 와 달라졌지만 허용되지 않은 문서 uid. 계획이 그 문서를 쓰게 될 때만 막고, 건드리지 않으면 회차를 막지 않는다. */
  driftHeld?: string[] };
/** Implement with CatalogStore transactions, expected revision/digest, receipts and audit.
 * CAS must check the entire envelope, including the contract lock, atomically. No delete API. */
export interface CycleCommands {
  list(sourceId: string): Promise<CycleSnapshot>;
  read(sourceId: string, uid: string): Promise<CycleProduct | null>;
  backup(key: string, before: CycleProduct | null): Promise<void>;
  readBackup(key: string): Promise<CycleProduct | null>;
  compareAndApply(beforeDigest: string, after: CycleProduct, commandKey: string): Promise<void>;
  /** 쓰기 전 일괄 점검(백업·쓰기 시작 전). 저장소가 거절할 쓰기(문서 크기 한도 등)가 있으면 던져 «일부만 적용된 상태»를 막는다. */
  precheck?(afters: readonly CycleProduct[]): Promise<void>;
}
export type CycleConfig = { sourceId: string; family: SourceFamily; maxDowngradeRatio: number; downgradeFloor?: number;
  /** 원천에 없는 노출 문서를 내릴 때의 사유 코드(기본 SOURCE_ABSENT, 대표 지시 공급사는 DECISION_WITHDRAWN). */ absenceReason?: string };
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
