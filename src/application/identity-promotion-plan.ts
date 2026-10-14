/**
 * 엔진 공통 승격기 1단계 — 정체성 승격 «계획서 생성기»(읽기 전용, 2026-10-14).
 *
 * 엔진이 마스터로 특정하지 못한 채 편입한 상품(vehicle_review_required, maker·model 빈칸, 원문 차명이 sub_model 에 임시)을
 * 활성 차종 마스터와 대조해, 원문 차명에 세부모델 이름(또는 등록된 별칭)이 «그대로» 들어 있고 그 후보가 마스터 하나로만
 * 특정될 때만 정체성(제조사·모델·세부모델) 정정 항목을 낸다. 세부트림은 같은 계획에 싣지 않는다(정정 경로 제약: 계획 둘) —
 * 정체성이 특정된 상품에 한해, 그 마스터의 세부트림 이름(또는 별칭)이 원문에 그대로 있고 하나뿐일 때만 «두 번째 계획»(trimPlans)으로 낸다.
 * 적용 순서: plans(정체성) 전부 적용·되읽기 → trimPlans.
 *
 * 차종 기준 한 장(«지어내지 않는다», 별칭은 조건 없이 하나로 이어질 때만)을 따른다: 부분 일치·최장 일치 우선·연식 추정을
 * 하지 않는다. 둘 이상 걸리거나, 원문에 다른 제조사가 보이거나, 원문 동력 표기(하이브리드·전기)가 고른 세부모델과 어긋나면
 * 보류(사유 코드)한다. 이 모듈은 쓰지 않는다 — 적용은 기존 repair:vehicle-name-parity(계획 → 검토 → 백업 → 적용 → 되읽기).
 */
import { canonicalVehicleMakerName } from '../domain/vehicle-maker-name.js';
import type { VehicleMasterRecord } from '../domain/vehicle-identity-resolution.js';
import { stableDigest } from '../shared/stable-digest.js';

export const IDENTITY_PROMOTION_RULE_VERSION = 'identity-promotion-plan/1';
/** repair:vehicle-name-parity 한 계획의 상한(MAX_VEHICLE_NAME_REPAIR_TARGETS)과 같다. 넘으면 계획을 나눈다. */
export const IDENTITY_PROMOTION_PLAN_CHUNK = 200;
/** 이보다 짧은 이름·별칭은 우연 포함 위험이 커서 대조에 쓰지 않는다(공백·기호 제거 후 글자 수). */
export const MIN_SUB_MODEL_NAME_LENGTH = 3;

export type IdentityPromotionHoldReason =
  | 'RAW_NAME_MISSING'
  | 'NO_MASTER_MATCH'
  | 'MULTIPLE_MASTER_MATCH'
  | 'MAKER_CONFLICT'
  | 'HYBRID_SOURCE_CONFLICT'
  | 'ELECTRIC_SOURCE_CONFLICT';

export type IdentityPromotionProduct = { id: string; data: Record<string, unknown> };
export type IdentityTriple = { maker: string; model: string; sub_model: string };
export type IdentityPromotionItem = { id: string; from: IdentityTriple; to: IdentityTriple; evidence: string };
/** repair:vehicle-name-parity 계획(VehicleNameRepairPlan)과 같은 모양 — 정체성 정정만 싣는다. */
export type IdentityPromotionRepairPlan = {
  sourceDigest: string; masterRepairs: []; productRepairs: []; productIdentityRepairs: IdentityPromotionItem[];
};
export type TrimPromotionItem = { id: string; from: string; to: string; evidence: string };
export type TrimPromotionRepairPlan = { sourceDigest: string; masterRepairs: []; productRepairs: []; productTrimRepairs: TrimPromotionItem[] };
export type TrimPromotionHoldReason = 'NO_TRIM_MATCH' | 'MULTIPLE_TRIM_MATCH';
export type IdentityPromotionHold = { id: string; rawName: string; reason: IdentityPromotionHoldReason; candidates?: string[] };
export type IdentityPromotionReport = {
  ruleVersion: typeof IDENTITY_PROMOTION_RULE_VERSION; mode: 'PLAN_ONLY';
  snapshotDigest: string; productsDigest: string;
  counts: { scanned: number; eligible: number; planned: number; held: number; byReason: Partial<Record<IdentityPromotionHoldReason, number>> };
  plans: IdentityPromotionRepairPlan[]; holds: IdentityPromotionHold[];
  /** 정체성 계획을 모두 적용한 뒤에 쓰는 세부트림 계획(같은 상품을 한 계획에 겹치지 않는다). */
  trimPlans: TrimPromotionRepairPlan[]; trimHolds: Array<{ id: string; reason: TrimPromotionHoldReason; candidates?: string[] }>;
};

const clean = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
/** 대조용: 대소문자·공백·괄호·하이픈 등 표기 차이만 지운다(글자를 바꾸거나 줄이지 않는다). */
export const compactVehicleName = (value: unknown) => clean(value).toLowerCase().replace(/[\s()[\]{}\-_/·.,]/g, '');
const HYBRID = /하이브리드|hev|e-?tech/i;
const ELECTRIC = /전기|(^|[^a-z])ev([^a-z]|$)/i;

type MasterEntry = { masterId: string; maker: string; model: string; subModel: string; names: string[];
  trims: Array<{ name: string; keys: string[] }> };
/** 세부트림 이름·별칭 대조 최소 길이(«LX»·«GT» 같은 2글자 등급명은 허용). */
export const MIN_TRIM_NAME_LENGTH = 2;

function masterEntries(records: VehicleMasterRecord[]): MasterEntry[] {
  const byId = new Map<string, MasterEntry>();
  for (const record of records) {
    const [maker, model, subModel] = record.names;
    const entry = byId.get(record.masterId) ?? { masterId: record.masterId, maker, model, subModel, names: [], trims: [] };
    const trimKeys = [...new Set([record.names[3], ...(record.aliases[3] ?? [])].map(compactVehicleName).filter(k => k.length >= MIN_TRIM_NAME_LENGTH))];
    if (clean(record.names[3]) && !entry.trims.some(t => t.name === clean(record.names[3]))) entry.trims.push({ name: clean(record.names[3]), keys: trimKeys });
    for (const name of [subModel, ...(record.aliases[2] ?? [])]) {
      const key = compactVehicleName(name);
      if (key.length >= MIN_SUB_MODEL_NAME_LENGTH && !entry.names.includes(key)) entry.names.push(key);
    }
    byId.set(record.masterId, entry);
  }
  return [...byId.values()].sort((a, b) => a.masterId.localeCompare(b.masterId));
}

/** 엔진이 원문 차명으로만 편입한 문서(마스터 정리 전)인지. */
export const isIdentityPromotionTarget = (data: Record<string, unknown>) =>
  data.vehicle_review_required === true && !clean(data.maker) && !clean(data.model);

const rawNameOf = (data: Record<string, unknown>) => {
  const original = data.원문 && typeof data.원문 === 'object' && !Array.isArray(data.원문) ? data.원문 as Record<string, unknown> : {};
  return clean(original.차명) || clean(data.car_name);
};

export function planIdentityPromotion(input: {
  products: IdentityPromotionProduct[]; records: VehicleMasterRecord[]; snapshotDigest: string;
}): IdentityPromotionReport {
  const masters = masterEntries(input.records);
  const makers = [...new Set(masters.map(m => canonicalVehicleMakerName(m.maker)))];
  const items: IdentityPromotionItem[] = [], holds: IdentityPromotionHold[] = [];
  const trimItems: TrimPromotionItem[] = [], trimHolds: IdentityPromotionReport['trimHolds'] = [];
  const targets = input.products.filter(p => isIdentityPromotionTarget(p.data)).sort((a, b) => a.id.localeCompare(b.id));
  for (const { id, data } of targets) {
    const rawName = rawNameOf(data);
    const hold = (reason: IdentityPromotionHoldReason, candidates?: string[]) =>
      holds.push({ id, rawName, reason, ...(candidates ? { candidates } : {}) });
    const raw = compactVehicleName(rawName);
    if (!raw) { hold('RAW_NAME_MISSING'); continue; }
    const hits = masters.filter(m => m.names.some(name => raw.includes(name)));
    if (!hits.length) { hold('NO_MASTER_MATCH'); continue; }
    if (hits.length > 1) { hold('MULTIPLE_MASTER_MATCH', hits.map(m => `${m.masterId}:${m.maker} ${m.subModel}`)); continue; }
    const hit = hits[0]!;
    const hitMaker = canonicalVehicleMakerName(hit.maker);
    const otherMaker = makers.find(maker => maker !== hitMaker && compactVehicleName(maker).length >= 2 &&
      raw.includes(compactVehicleName(maker)) && !compactVehicleName(hitMaker).includes(compactVehicleName(maker)));
    if (otherMaker) { hold('MAKER_CONFLICT', [otherMaker]); continue; }
    // 원문이 하이브리드·전기를 말하는데 고른 세부모델 이름엔 없고 같은 모델의 형제 세부모델엔 있으면 반대쪽을 고른 것이다.
    const siblings = masters.filter(m => m.maker === hit.maker && m.model === hit.model && m.masterId !== hit.masterId);
    const conflict = ([['HYBRID_SOURCE_CONFLICT', HYBRID], ['ELECTRIC_SOURCE_CONFLICT', ELECTRIC]] as const).find(([, rx]) =>
      rx.test(rawName) && !rx.test(hit.subModel) && siblings.some(s => rx.test(s.subModel)));
    if (conflict) { hold(conflict[0], siblings.filter(s => conflict[1].test(s.subModel)).map(s => `${s.masterId}:${s.maker} ${s.subModel}`)); continue; }
    const to = { maker: clean(hit.maker), model: clean(hit.model), sub_model: clean(hit.subModel) };
    const from = { maker: typeof data.maker === 'string' ? data.maker : '', model: typeof data.model === 'string' ? data.model : '',
      sub_model: typeof data.sub_model === 'string' ? data.sub_model : '' };
    items.push({ id, from, to,
      evidence: `원문 차명 «${rawName}» 에 세부모델 «${hit.subModel}»(또는 등록 별칭)이 그대로 있고 활성 마스터 ${hit.masterId} 하나로만 특정됨 · ${IDENTITY_PROMOTION_RULE_VERSION} · snapshot ${input.snapshotDigest.slice(0, 12)}` });
    // 세부트림: 세부모델 이름 부분을 뺀 원문에서 찾는다(세부모델 이름 안의 글자가 트림으로 잡히지 않게).
    const rest = hit.names.reduce((acc, name) => acc.split(name).join(' '), raw);
    const trimHits = hit.trims.filter(t => t.keys.some(k => rest.includes(k)));
    const currentTrim = typeof data.trim_name === 'string' ? data.trim_name : '';
    if (trimHits.length === 1) {
      if (clean(currentTrim) !== trimHits[0]!.name) trimItems.push({ id, from: currentTrim, to: trimHits[0]!.name,
        evidence: `원문 차명 «${rawName}» 에 세부트림 «${trimHits[0]!.name}»(또는 등록 별칭)이 그대로 있고 마스터 ${hit.masterId} 안에서 하나뿐 · ${IDENTITY_PROMOTION_RULE_VERSION}` });
    } else trimHolds.push({ id, reason: trimHits.length ? 'MULTIPLE_TRIM_MATCH' : 'NO_TRIM_MATCH',
      ...(trimHits.length ? { candidates: trimHits.map(t => t.name) } : {}) });
  }
  const productsDigest = stableDigest(targets.map(p => ({ id: p.id, maker: p.data.maker ?? null, model: p.data.model ?? null,
    sub_model: p.data.sub_model ?? null, rawName: rawNameOf(p.data) })));
  const plans: IdentityPromotionRepairPlan[] = [];
  for (let at = 0; at < items.length; at += IDENTITY_PROMOTION_PLAN_CHUNK) {
    const chunk = items.slice(at, at + IDENTITY_PROMOTION_PLAN_CHUNK);
    plans.push({ sourceDigest: stableDigest({ ruleVersion: IDENTITY_PROMOTION_RULE_VERSION, snapshotDigest: input.snapshotDigest, productsDigest, part: plans.length }),
      masterRepairs: [], productRepairs: [], productIdentityRepairs: chunk });
  }
  const trimPlans: TrimPromotionRepairPlan[] = [];
  for (let at = 0; at < trimItems.length; at += IDENTITY_PROMOTION_PLAN_CHUNK) {
    trimPlans.push({ sourceDigest: stableDigest({ ruleVersion: IDENTITY_PROMOTION_RULE_VERSION, snapshotDigest: input.snapshotDigest, productsDigest, trimPart: trimPlans.length }),
      masterRepairs: [], productRepairs: [], productTrimRepairs: trimItems.slice(at, at + IDENTITY_PROMOTION_PLAN_CHUNK) });
  }
  const byReason: Partial<Record<IdentityPromotionHoldReason, number>> = {};
  for (const h of holds) byReason[h.reason] = (byReason[h.reason] ?? 0) + 1;
  return { ruleVersion: IDENTITY_PROMOTION_RULE_VERSION, mode: 'PLAN_ONLY', snapshotDigest: input.snapshotDigest, productsDigest,
    counts: { scanned: input.products.length, eligible: targets.length, planned: items.length, held: holds.length, byReason },
    plans, holds, trimPlans, trimHolds };
}
