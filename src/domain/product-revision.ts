import { stableDigest } from '../shared/stable-digest.js';

/**
 * 상품 변경 이력(product_revisions) 한 건 — 대표 2026-10-25 «모든 정정은 이력: 누가·언제·전/후·근거».
 * 순수 함수만 둔다(쓰기는 infra/product-revision-writer). 엔진·정정 도구·앞으로의 관리자 편집이 모두 이 모양으로 남긴다.
 * 쓰기 주체는 프리패스 직원(STAFF)과 서비스(엔진·도구)뿐이다 — 대표 10-25 «관리자(편집)=프리패스 직원, 영업자·공급사=보기 전용».
 * 공급사·영업자의 요청을 직원이 반영할 때는 onBehalfOf 에 출처만 남긴다(쓰기 주체가 아니다).
 */
export const PRODUCT_REVISION_SCHEMA = 'product-revision/v1';
export const PRODUCT_REVISIONS_COLLECTION = 'product_revisions';
/** 리비전 문서 1MiB 한도 보호(상품 문서 크기 점검과 같은 기준). */
export const PRODUCT_REVISION_MAX_BYTES = 900_000;

/** off(기본): 아무것도 남기지 않는다. shadow: 기존 쓰기는 그대로 두고 리비전을 «비공식»으로 따로 남긴다(실패해도 쓰기는 계속).
 * on(원자 기록)은 아직 열지 않는다 — 운영 전환은 커맨드 확인 뒤 별도 변경으로. */
export type ProductRevisionMode = 'off' | 'shadow';
export function productRevisionModeOf(env: Record<string, string | undefined> | undefined): ProductRevisionMode {
  const value = (env?.PRODUCT_REVISIONS ?? '').trim();
  if (value === '' || value === 'off') return 'off';
  if (value === 'shadow') return 'shadow';
  throw new Error('PRODUCT_REVISIONS_MODE_INVALID');
}

export type ProductRevisionActorKind = 'ENGINE' | 'TOOL' | 'STAFF' | 'SYSTEM';
export type ProductRevisionActorRole = 'FREEPASS_STAFF' | 'FREEPASS_ADMIN' | 'SERVICE';
export type ProductRevisionActor = {
  kind: ProductRevisionActorKind;
  id: string;
  role: ProductRevisionActorRole;
  /** 어떤 경로로 썼나(source-cycle, repair:vehicle-name-parity, admin-sheet …). */
  via: string;
  /** 공급사·영업자 요청을 직원이 반영했을 때의 출처(쓰기 주체가 아니다). */
  onBehalfOf?: { kind: 'SUPPLIER' | 'SALES'; id: string };
  /** 도구 실행을 승인한 직원(계획 digest 승인자). */
  approvedBy?: string;
  host?: string;
  gitSha?: string;
};
const ACTOR_KINDS: readonly string[] = ['ENGINE', 'TOOL', 'STAFF', 'SYSTEM'];
const STAFF_ROLES: readonly string[] = ['FREEPASS_STAFF', 'FREEPASS_ADMIN'];
const text = (v: unknown, max = 200) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

/** 쓰기 주체 검증: 영업자·공급사 역할은 존재하지 않는다(목록 밖이면 거부). */
export function assertProductRevisionActor(actor: ProductRevisionActor): void {
  if (!actor || !ACTOR_KINDS.includes(actor.kind) || !text(actor.id) || !text(actor.via)) throw new Error('ACTOR_INVALID');
  const staff = actor.kind === 'STAFF';
  if (staff ? !STAFF_ROLES.includes(actor.role) : actor.role !== 'SERVICE') throw new Error('ACTOR_ROLE_NOT_WRITER');
  if (actor.onBehalfOf !== undefined && (!['SUPPLIER', 'SALES'].includes(actor.onBehalfOf?.kind) || !text(actor.onBehalfOf?.id))) throw new Error('ACTOR_ON_BEHALF_INVALID');
  if (actor.approvedBy !== undefined && !text(actor.approvedBy)) throw new Error('ACTOR_APPROVED_BY_INVALID');
}

export type ProductRevisionKind = 'BASELINE' | 'CREATE' | 'UPDATE' | 'WITHDRAW' | 'ROLLBACK' | 'IDENTITY_CORRECTION' | 'SPEC_CORRECTION' | 'LOCK_RELEASE' | 'UID_MIGRATION';
const KINDS: readonly string[] = ['BASELINE', 'CREATE', 'UPDATE', 'WITHDRAW', 'ROLLBACK', 'IDENTITY_CORRECTION', 'SPEC_CORRECTION', 'LOCK_RELEASE', 'UID_MIGRATION'];

/** 리비전에 담을 수 있는 JSON 값으로 바꾼다. Admin SDK 의 FieldValue·Timestamp 같은 특수 객체는 이름만 남긴다(값을 지어내지 않는다). */
export function revisionValue(v: unknown, depth = 0): unknown {
  if (depth > 20) return { $unserializable: 'DEPTH' };
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $unserializable: 'NUMBER' };
  if (Array.isArray(v)) return v.map(x => revisionValue(x, depth + 1));
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => [k, revisionValue(x, depth + 1)]));
    }
    const name = (v as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
    const iso = typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : undefined;
    return iso ? { $timestamp: iso } : { $sentinel: name };
  }
  return { $unserializable: typeof v };
}

export type ProductRevisionInput = {
  uid: string;
  /** 재시도해도 바뀌지 않는 작업 식별자(예: 엔진 백업 키 digest, 정정 계획 digest+문서). 리비전 id 는 이것으로만 정한다(멱등). */
  operationId: string;
  kind: ProductRevisionKind;
  actor: ProductRevisionActor;
  tool: { name: string; version?: string; runId?: string; planDigest?: string };
  reason: string;
  evidence?: Record<string, unknown>;
  /** 이번 쓰기가 덮는 칸의 쓰기 전 값(문서가 없었으면 null). */
  before: Record<string, unknown> | null;
  /** 이번 쓰기가 쓴 칸(updateMask 와 같은 칸). replace=true 면 쓰기 뒤 문서 전체. */
  after: Record<string, unknown>;
  /** 문서 전체 교체(롤백 등 updateMask 없는 쓰기): 전·후 칸의 합집합을 보고, 사라진 칸은 afterPresent=false 로 남긴다. */
  replace?: boolean;
  expectedUpdateTime?: string | null;
  committedUpdateTime?: string | null;
  /** 관측 시각(호출자가 넣는다 — digest 에는 넣지 않는다). */
  at: string;
  mode: ProductRevisionMode;
};
export type ProductRevision = {
  schema: typeof PRODUCT_REVISION_SCHEMA;
  revId: string; uid: string; operationId: string; kind: ProductRevisionKind;
  official: boolean; at: string;
  actor: ProductRevisionActor; tool: ProductRevisionInput['tool']; reason: string; evidence: Record<string, unknown>;
  changes: Array<{ path: string; before: unknown; after: unknown; beforePresent: boolean; afterPresent: boolean }>;
  beforeDigest: string; afterDigest: string; inputDigest: string;
  expectedUpdateTime: string | null; committedUpdateTime: string | null;
};

export const productRevisionId = (uid: string, operationId: string) => `rev_${stableDigest({ uid, operationId }).slice(0, 40)}`;

/** 리비전 문서를 만든다(순수). 같은 uid+operationId 는 언제나 같은 revId, 같은 입력은 같은 inputDigest. */
export function buildProductRevision(input: ProductRevisionInput): ProductRevision {
  if (!text(input.uid, 1500) || input.uid.includes('/')) throw new Error('REVISION_UID_INVALID');
  if (!text(input.operationId, 500)) throw new Error('REVISION_OPERATION_ID_REQUIRED');
  if (!KINDS.includes(input.kind)) throw new Error('REVISION_KIND_INVALID');
  if (!text(input.reason, 2000)) throw new Error('REVISION_REASON_REQUIRED');
  if (!text(input.tool?.name)) throw new Error('REVISION_TOOL_REQUIRED');
  if (!Number.isFinite(Date.parse(input.at))) throw new Error('REVISION_AT_INVALID');
  assertProductRevisionActor(input.actor);
  const before = input.before ?? null;
  // 부분 갱신은 쓴 칸만, 전체 교체는 전·후 칸의 합집합을 본다(교체로 사라진 칸도 이력에 남긴다).
  const keys = [...new Set([...Object.keys(input.after), ...(input.replace === true && before ? Object.keys(before) : [])])].sort();
  const changes = keys.flatMap(path => {
    const beforePresent = !!before && Object.hasOwn(before, path), afterPresent = Object.hasOwn(input.after, path);
    const b = beforePresent ? revisionValue(before![path]) : null, a = afterPresent ? revisionValue(input.after[path]) : null;
    return beforePresent === afterPresent && stableDigest(b) === stableDigest(a) ? [] : [{ path, before: b, after: a, beforePresent, afterPresent }];
  });
  const beforePicked = before ? Object.fromEntries(keys.filter(k => Object.hasOwn(before, k)).map(k => [k, revisionValue(before[k])])) : null;
  const afterPicked = Object.fromEntries(keys.filter(k => Object.hasOwn(input.after, k)).map(k => [k, revisionValue(input.after[k])]));
  // 멱등 판정의 «같은 작업»: 무엇을·누가·어떤 근거로. 재시도마다 달라질 수 있는 칸(at·runId·host·gitSha·committedUpdateTime)은 뺀다.
  const { host: _host, gitSha: _gitSha, ...actorMeaning } = input.actor;
  const { runId: _runId, ...toolMeaning } = input.tool;
  const revision: ProductRevision = {
    schema: PRODUCT_REVISION_SCHEMA,
    revId: productRevisionId(input.uid, input.operationId), uid: input.uid, operationId: input.operationId, kind: input.kind,
    official: false, at: input.at,
    actor: revisionValue(input.actor) as ProductRevisionActor, tool: revisionValue(input.tool) as ProductRevisionInput['tool'],
    reason: input.reason, evidence: (revisionValue(input.evidence ?? {}) ?? {}) as Record<string, unknown>,
    changes,
    beforeDigest: stableDigest(beforePicked), afterDigest: stableDigest(afterPicked),
    inputDigest: stableDigest({ uid: input.uid, operationId: input.operationId, kind: input.kind, changes,
      actor: revisionValue(actorMeaning), tool: revisionValue(toolMeaning), reason: input.reason, evidence: revisionValue(input.evidence ?? {}),
      expectedUpdateTime: input.expectedUpdateTime ?? null }),
    expectedUpdateTime: input.expectedUpdateTime ?? null, committedUpdateTime: input.committedUpdateTime ?? null,
  };
  if (Buffer.byteLength(JSON.stringify(revision), 'utf8') > PRODUCT_REVISION_MAX_BYTES) throw new Error('REVISION_TOO_LARGE');
  return revision;
}
