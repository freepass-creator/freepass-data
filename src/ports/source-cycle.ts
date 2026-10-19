import type { SourceFamily, SourceProductRecord, SourceRead } from '../domain/source-engine.js';
import type { VehicleMasterRecord } from '../domain/vehicle-identity-resolution.js';

/** Bounded operating evidence only; never business payloads, vehicle IDs or credentials. */
export type SourceClockReason = 'INVALID_SYNC' | 'NOT_FRESH_FLAG' | 'EXPIRED' | 'FUTURE' | 'BEHIND_LIST';
export type SourceClockDiagnostic = {
  kind: 'IANCAR_DETAIL_CLOCK'; stage: 'INVALID_SYNC' | 'DRIFT_LIMIT';
  listSyncedAt: string | null; checkedAt: string;
  listedVehicles: number; rereadVehicles: number; cachedVehicles: number;
  heldVehicles: number; clockHeldVehicles: number; driftLimit: number;
  /** Per response envelope, not vehicle counts; a response can fail several checks. */
  reasonEnvelopeCounts: Record<SourceClockReason, number>;
  examples: Array<{ envelope: 'DETAIL' | 'AVAILABILITY'; syncedAt: string | null; checkedAt: string;
    /** Optional for receipts recorded before endpoint timing was separated. */
    receivedAt?: string; receivedAgeMs?: number | null;
    ageMs: number | null; behindListMs: number | null; reasons: SourceClockReason[] }>;
};
export type CycleRead<T> = SourceRead<T> & { clockDiagnostic?: SourceClockDiagnostic };

export type SupplierFields = { provider_name: string; policy_code: string | null };
export type CycleProduct = {
  supplierFields?: SupplierFields;
  record: SourceProductRecord;
  locked_by_contract: boolean;
  listable: boolean;
  /** 노출 문서가 원천 값은 같아도 한 번 다시 써야 하는 사유(읽기 경로가 계산, 쓰기 결과에는 남지 않는다):
   * PRICE_LAYOUT 옵션 가격 키 누락 · STATUS_KIND 저장된 vehicle_status 의 계약 값과 다름 · PRODUCT_TYPE 월렌트 상품 구분 누락 ·
   * PHOTO_URLS 사진 없는 문서에 원천 API 사진 주소가 있음(손오공).
   * IANCAR_VEHICLE_ID 이안카 노출 문서의 공급사 차량 ID(iancar_one_vehicle_id) 누락.
   * VEHICLE_IDENTITY 엔진 편입 후 정체성 보류(제조사·모델 빈칸·검토 필요) 문서가 이번 회차 차종 마스터로 «하나로» 특정됨(쓰면 보류가 풀려 되풀이되지 않는다). */
  rewriteReasons?: Array<'PRICE_LAYOUT' | 'STATUS_KIND' | 'PRODUCT_TYPE' | 'PHOTO_URLS' | 'IANCAR_VEHICLE_ID' | 'VEHICLE_IDENTITY' | 'API_OPTIONS' | 'SOURCE_IDENTITY' | 'SOURCE_SPEC' | 'SOURCE_PROVENANCE'>;
  /** 계획이 정한 «이 회차에 입구 매핑(제조사·모델·제원 채움)을 한다»(회차 상한 안, 사유가 있거나 신규 편입인 항목만). 이 표식이 없으면 쓰기가 일어나도 채움은 없다 —
   * 사유 없는 UPDATE·재노출 등에서 채움이 상한을 우회하지 못하게 하는 «양성» 표식이다(Codex #685 ③). */
  fillSourceIdentity?: boolean;
  /** 계획이 정한 «이 회차에 정체성 정제(마스터 이름 채움)를 한다»(기존 문서, 회차 상한 안, VEHICLE_IDENTITY 사유 항목만 — Codex #704 잔여). 이 표식이 없으면 쓰기가 일어나도 기존 문서는 정제하지 않는다(신규 편입은 편입 상한이 따로 건다). */
  refineIdentity?: boolean;
  /** 제원 확인 표식(vehicle_spec_source_checked)이 이미 찍힌 노출 문서의 «빈 제원 칸» 목록(읽기 경로가 계산하는 표시, 쓰기 결과에는 남지 않는다 — 대표 2026-10-19).
   * 계획이 이번 관측 원천(raw.spec)에 그 칸의 형식 맞는 값이 있을 때만 다시 채움(SOURCE_SPEC)으로 고른다(domain/spec-refill). 값이 있는 칸·계약 잠금 문서는 목록에 없다. */
  specRefillKeys?: string[];
  /** 정체성이 확정되고 연료가 빈 노출 문서의 마스터 연료(vehicle_trim_master, 하나로 모일 때만 — 읽기 경로가 계산). 계획 digest·백업 대조에 고정되고,
   * 계획이 검증·압축 전 원문에 연료 원문이 없을 때만(domain/spec-refill masterFuelFallback) after 에 남기고, 쓰기는 after 의 이 값만 쓴다. */
  specMasterFuel?: string;
  publication_withdrawal: { reason: string; source: string; observedAt: string; deleteAuthorized: false } | null;
  publication_withdrawal_prior: { listable: boolean; status: SourceProductRecord['status'] } | null;
};
export type CycleSnapshot = { products: CycleProduct[]; complete: boolean; enrollmentSupplier?: SupplierFields | null;
  /** --accept-drift 로 허용된 보정 문서 uid(계획 digest 에 경고로 기록). */ acceptedDrift?: string[];
  /** 가격이 저장 digest 와 달라졌지만 허용되지 않은 문서 uid. 계획이 그 문서를 쓰게 될 때만 막고, 건드리지 않으면 회차를 막지 않는다. */
  driftHeld?: string[];
  /** 다른 공급사(provider_company_code 가 다른) 문서가 이미 쓰고 있는 문서 ID(= uid, 번호 키). 같은 번호가 두 공급사에 있으면 이 원천의 편입은
   * 문서 ID 충돌(CAS_CONFLICT → APPLY_UNCERTAIN 로 회차 정지)이 되므로 계획 단계에서 그 행만 보류한다. */
  foreignUids?: string[];
  /** 이번 회차 정체성 정제에 쓴 차종 마스터 내용 digest(마스터를 못 읽었으면 없음). 계획 경고에 남아 승인 계획이 같은 마스터로만 재생되게 묶는다. */
  identityMasterDigest?: string };
/** 엔진 회차 정체성 정제 결과: 차종 마스터 하나로 특정된 이름(세부트림은 하나로 특정될 때만, 아니면 null). */
export type VehicleIdentityRefinement = { maker: string; model: string; sub_model: string; trim_name: string | null; master_id: string };
/** 회차마다 한 번 읽은 활성 차종 마스터로 만든 대조기(순수 함수). 같은 입력이면 같은 결과다. */
export type VehicleIdentityRefiner = { digest: string; match(input: { rawName: string; year: string }): VehicleIdentityRefinement | null;
  /** Verified same-snapshot records for the existing structured shared-sheet normalizer; never a second name authority. */
  sourceYearEvidence?: { records: VehicleMasterRecord[]; snapshotDigest: string; readAt: string };
  /** Reviewed exact UID scope for F05 year carry-through. Runtime always supplies it; empty means no year writes. */
  sourceYearUids?: ReadonlySet<string>;
  /** Explicit source-year admission against the matched active master's recorded range.
   * Identity matching alone may accept a sole candidate outside its years; that is not year evidence. */
  allowsYear?: (masterId: string, year: number) => boolean;
  /** 활성 차종 마스터에 있는 제조사 이름 목록(입구 매핑이 마스터에 없는 원천 표기를 maker 에 넣지 않게 하는 근거). 없으면 입구 매핑은 채우지 않는다. */
  makers?: readonly string[];
  /** 제조사별 마스터 «모델 이름 + 별칭» 목록(입구 매핑이 모델을 마스터에 있는 이름일 때만 쓰게 하는 근거, 차종 기준 한 장: 이름은 마스터에 있는 이름만, 괄호·세대·수식어 안 씀). 없으면 입구 매핑은 모델을 쓰지 않는다(fail-closed). */
  models?: Readonly<Record<string, readonly string[]>>;
  /** 제조사별 «별칭 → 정식 모델 이름». 원천 표기가 마스터에 등록된 별칭이면 «정식 이름»으로 바꿔 쓴다(별칭 문자열 자체는 쓰지 않는다 — Codex #706). */
  modelAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** 정체성이 마스터로 확정된 차(제조사·모델·세부모델·세부트림)의 vehicle_trim_master 연료가 표준 이름으로 «하나로» 모일 때만 그 값(대표 2026-10-19 요령 «마스터» 열).
   * 연식·배기량이 있으면 그것과 어긋나는 행을 뺀다(남는 행이 없으면 null). 없거나 갈리면 null. */
  trimFuel?: (identity: { maker: string; model: string; sub_model: string; trim_name: string; year?: string; engine_cc?: string }) => string | null };
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
  /** 옵션 칸 채움(API_OPTIONS 사유 전용) 회차 상한 상향(기본 100, 운영 변수 SOURCE_CYCLE_API_OPTIONS_CAP, 최대 400). 다른 쓰기와 합산 상한은 그대로 적용된다. */
  optionsRewriteCap?: number;
  /** 규격 검증(대표 2026-10-16 승인, 기본 꺼짐·원천별): 쓰기 직전 위반 칸만 보류하고 SPEC_VIOLATION 경고를 남긴다. 위반이 읽은 차의 20% 를 넘으면 SPEC_FORMAT_DRIFT 로 회차 보류. */
  specValidation?: boolean;
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
  /** Existing F05 producer's write-ahead reconciliation pointer; never source values or credentials. */
  sourceObservationIntent?: { sourceId: string; runId: string; sourceDigest: string; observedAt: string };
  /** Most recent clock diagnosis, retained on success. checkedAt is history, never the current health status. */
  lastReadClockDiagnostic?: SourceClockDiagnostic;
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
export interface CycleControl {
  acquire(sourceId: string): Promise<null | (() => Promise<void>)>;
  load(sourceId: string): Promise<CycleState>;
  save(sourceId: string, state: CycleState): Promise<void>;
  heartbeat(sourceId: string, state: CycleState, plan: CyclePlan | null): Promise<void>;
  alert(sourceId: string, reason: string): Promise<void>;
}
