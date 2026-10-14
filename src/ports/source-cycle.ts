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
  driftHeld?: string[];
  /** 다른 공급사(provider_company_code 가 다른) 문서가 이미 쓰고 있는 문서 ID(= uid, 번호 키). 같은 번호가 두 공급사에 있으면 이 원천의 편입은
   * 문서 ID 충돌(CAS_CONFLICT → APPLY_UNCERTAIN 로 회차 정지)이 되므로 계획 단계에서 그 행만 보류한다. */
  foreignUids?: string[] };
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
  /** 원천 원문 계층(source_raw) 저장. 게이트 0 — 판정·마스터·가격·상태·잠금과 무관하게 읽은 레코드를 그대로 upsert 한다(개인정보 마스킹만).
   * complete=true 일 때만 «이번에 안 보인 키» 에 absent_since 를 남긴다. 실패해도 회차를 막지 않는다. */
  storeRaw?(input: { sourceId: string; records: readonly import('../domain/source-engine.js').SourceProductRecord[];
    held: ReadonlyArray<{ row: number; reasons: string[] }>; observedAt: string; complete: boolean }): Promise<{ stored: number; absentMarked: number }>;
}
export type CycleConfig = { sourceId: string; family: SourceFamily; maxDowngradeRatio: number; downgradeFloor?: number;
  /** 회차당 신규 편입 상한(기본 100)과 하한 보장(기본 30, 원천 판매가능의 25% 가 이보다 작을 때). 초과분은 다음 회차로 이월한다. */
  maxEnrollPerCycle?: number; minEnrollPerCycle?: number;
  /** 이번 한 회차에 한해 신규 편입 상한을 이 값(≤1000)으로 올린다. 운영 변수 + 회차 후 표식 파일로 자동 원복한다(최초 대량 편입용). */
  enrollCapOnce?: number;
  /** 원천에 없는 노출 문서를 내릴 때의 사유 코드(기본 SOURCE_ABSENT, 대표 지시 공급사는 DECISION_WITHDRAWN). */ absenceReason?: string };
export type CycleEvidence = { records: SourceProductRecord[]; complete: boolean; observedAt: string | null; heldCount: number;
  unassignedPlateCount?: number;
  /** 읽기 단계 보류 중 «이미 반영된 행의 동일 복사본»(DUPLICATE_UID_SUSPECT) 수 — 다른 차의 존재를 가리지 않으므로 부재 하향을 막지 않는다(커맨드 센터 승인 2026-10-14). */
  benignHeldCount?: number };
export type CycleEntry = { kind: 'DOWNGRADE' | 'ENROLL' | 'REEXPOSE' | 'UPDATE'; before: CycleProduct | null; after: CycleProduct };
export type CyclePlan = {
  schema: 'source-cycle/v1'; config: CycleConfig; plannedAt: number; evidence: CycleEvidence;
  entries: CycleEntry[]; held: number; blockers: string[]; sourceCount: number; exposedBefore: number;
  warnings: string[]; unassignedPlateCount: number;
};
export type CycleState = { failures: number; stopped: boolean; lastSyncedAt: string | null;
  observationOnlyCount?: number;
  /** 읽기 단계 보류 사유 코드별 건수(대수 대조에서 «왜 못 들어왔나» 를 가르는 근거). 번호·원문은 담지 않는다. */
  heldReasons?: Record<string, number>;
  /** 원천 ↔ ERP5 판매 가능 차량 키 집합 비교(SAME/NEW/MISSING/값 불일치, 끝4만). 회차 기록·감독 점검이 읽는다. */
  reconciliation?: import('../application/source-reconciliation.js').SourceReconciliation;
  observedSellableCount?: number; unassignedPlateCount?: number;
  /** 이번 회차 원문 계층 저장 건수·사라짐 표식 건수(보고 «원문 저장 N»). */
  rawStored?: number; rawAbsentMarked?: number;
  lastAttemptAt: string | null; lastCompleteAt: string | null; readCount: number; heldCount: number; error: string | null };
export const emptyCycleState = (): CycleState => ({ failures: 0, stopped: false, lastSyncedAt: null,
  lastAttemptAt: null, lastCompleteAt: null, readCount: 0, heldCount: 0, error: null });
/** 저장된 회차 상태 검증(파일·Firestore 제어 저장소 공용). 형식이 틀리면 던진다 — 손상된 상태로 회차를 돌리지 않는다. */
export function assertCycleState(value: CycleState): CycleState {
  const nullableTime = (v: unknown) => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));
  if (!value || !Number.isSafeInteger(value.failures) || value.failures < 0 || typeof value.stopped !== 'boolean' ||
      (value.failures >= 3 && !value.stopped) || !nullableTime(value.lastSyncedAt) || !nullableTime(value.lastAttemptAt) ||
      !nullableTime(value.lastCompleteAt) || !Number.isSafeInteger(value.readCount) || value.readCount < 0 ||
      !Number.isSafeInteger(value.heldCount) || value.heldCount < 0 ||
      !(value.error === null || typeof value.error === 'string')) throw new Error('CYCLE_STATE_INVALID');
  return value;
}
export interface CycleControl {
  acquire(sourceId: string): Promise<null | (() => Promise<void>)>;
  load(sourceId: string): Promise<CycleState>;
  save(sourceId: string, state: CycleState): Promise<void>;
  heartbeat(sourceId: string, state: CycleState, plan: CyclePlan | null): Promise<void>;
  alert(sourceId: string, reason: string): Promise<void>;
}
