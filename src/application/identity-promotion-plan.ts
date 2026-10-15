/** 정체성 승격 «계획서 생성기»(순수·읽기 전용) — 커맨드 센터 2026-10-14 확정: 하나로 특정되는 것만 정정 경로(repair:vehicle-name-parity)의 계획서 후보로 낸다.
 * 입력은 운영 문서·차종 마스터의 «스냅샷»(이 PC 는 운영 Firestore 를 읽지 못하므로 B3Q 가 만든 JSON)이고, 출력은 VehicleNameRepairPlan 후보와 보류 목록이다.
 * 규칙(기준 한 장): 지어내지 않는다·별칭은 조건 없이 하나로 이어질 때만·후보가 둘 이상이거나 근거가 비면 보류. 마스터는 읽기만 하고 쓰지 않는다. */
import { stableDigest } from '../shared/stable-digest.js';
import type { VehicleIdentityRefinement } from '../ports/source-cycle.js';
import { aliasCandidates, generationFamilies, generationGuard, type AliasCandidate, type GenerationFamily, type GenerationGuardReason } from './identity-generation-guard.js';

/** 정정 경로(repair:vehicle-name-parity)의 계획서 모양 중 이 생성기가 «내는» 부분만 구조적으로 선언한다. application 층은 infra 에 의존하지 않는다(아키텍처 가드):
 * 출력은 infra 의 VehicleNameRepairPlan 에 그대로 대입 가능한 모양이고, 호환은 시험(구조적 대입)이 지킨다. */
export type IdentityRepairItem = { id: string; from: { maker: string; model: string; sub_model: string }; to: { maker: string; model: string; sub_model: string }; evidence: string };
export type TrimRepairItem = { id: string; from: string; to: string; evidence?: string };
export type VehicleNameRepairPlan = {
  sourceDigest: string; masterRepairs: Array<{ id: string; from: string; to: string; evidence?: string }>; productRepairs: Array<{ id: string; from: string; to: string; evidence?: string }>;
  productIdentityRepairs?: IdentityRepairItem[]; productTrimRepairs?: TrimRepairItem[];
};

export type IdentityProduct = {
  /** 상품 문서 id(정정 경로가 쓰는 그대로). */ id: string;
  /** 번호 끝 4자리(보고용, 전체 번호는 두지 않는다). */ plate4: string;
  maker: string; model: string; sub_model: string; trim_name: string;
  /** 공급사 원문 차명(근거 문구). */ rawName: string;
  /** 연식(4자리) 또는 최초등록 연도, 없으면 ''. */ year: string;
  listable: boolean;
  /** 엔진 임시 표식 문서(vehicle_review_required·RAW_VEHICLE_TEXT): 칸 값이 «원문 덩어리» 임시 값이라 근거가 유일하면 덮어써도 된다. 없으면 false. */
  engineTemp?: boolean;
};
export type IdentityMasterTrim = { name: string; aliases: string[] };
export type IdentityMaster = {
  id: string; maker: string; model: string; sub_model: string; model_aliases: string[]; sub_model_aliases: string[];
  /** 세대 생산 시작·끝 연도(없으면 null = 제한 없음). */ yearFrom: number | null; yearTo: number | null;
  trims: IdentityMasterTrim[];
};
export type IdentityHold = { id: string; plate4: string; reason: 'NO_MASTER_MATCH' | 'AMBIGUOUS_MASTER' | 'YEAR_OUT_OF_RANGE' | 'NO_TRIM_MATCH' | 'AMBIGUOUS_TRIM' | 'ALREADY_MATCHED' | 'TRIM_CONFLICT_EXISTING' | GenerationGuardReason | 'VARIANT_MISMATCH'; candidates: string[] };
export type IdentityPromotionResult = {
  plan: VehicleNameRepairPlan;
  /** 정체성 정정과 같은 상품의 세부트림 정정. 정정 경로는 한 계획에 같은 상품을 겹쳐 받지 않으므로(one product per plan)
   * plan 을 적용·되읽기한 뒤 이 두 번째 계획을 적용한다. 없으면 null. */
  trimPlan: VehicleNameRepairPlan | null;
  held: IdentityHold[];
  stats: { products: number; identityRepairs: number; trimRepairs: number; held: number; alreadyMatched: number };
  /** R3 부록(읽기 전용 제안): 형제 세대가 있는 모델 목록·별칭 후보(규칙 20 — 사람이 승인, 코드에 박지 않음). */
  appendix: { generationFamilies: GenerationFamily[]; aliasCandidates: AliasCandidate[] };
};

const norm = (v: string) => v.normalize('NFKC').replace(/[\s_\-·.,()[\]/]/g, '').toUpperCase();   // 가드 모듈의 norm 과 같아야 한다(괄호·대괄호·슬래시도 구분자)
const names = (m: IdentityMaster) => [m.sub_model, ...m.sub_model_aliases].map(norm).filter(Boolean);
const models = (m: IdentityMaster) => [m.model, ...m.model_aliases].map(norm).filter(Boolean);

/** 상품의 sub_model(없으면 원문 차명)이 가리키는 마스터 후보. 모델 칸이 있으면 모델도 같아야 한다(별칭 포함). */
function masterCandidates(p: IdentityProduct, masters: readonly IdentityMaster[]): IdentityMaster[] {
  // 엔진 편입 문서(제조사·모델 빈칸)는 마스터로 특정되기 전까지 원문 차명을 sub_model 에 임시로 둔다(source-cycle-firestore nativeCycleFields).
  // 그 sub_model 은 마스터 이름이 아니므로 원문 차명 대조 경로로 보낸다.
  const engineRaw = !p.maker.trim() && !p.model.trim();
  const sub = engineRaw ? '' : norm(p.sub_model), model = norm(p.model), raw = norm(p.rawName || (engineRaw ? p.sub_model : ''));
  const hits = masters.filter(m => {
    if (model && !models(m).includes(model) && !names(m).includes(model)) return false;
    if (sub) return names(m).includes(sub);
    // sub_model 이 비어 있으면 원문 차명 안에 마스터 세부모델(별칭)이 «통째로» 들어 있을 때만(가장 긴 이름 기준은 아래에서).
    return names(m).some(n => n.length >= 3 && raw.includes(n));
  });
  if (!sub && hits.length > 1) {
    // 원문에 여러 이름이 들어 있으면 가장 긴 일치만 인정한다(예: «아반떼 하이브리드» 가 «아반떼» 보다 구체적).
    const score = (m: IdentityMaster) => Math.max(...names(m).filter(n => raw.includes(n)).map(n => n.length));
    const best = Math.max(...hits.map(score));
    return hits.filter(m => score(m) === best);
  }
  return hits;
}

/** 한 상품의 마스터 대조 결과(순수). 계획서 생성기와 엔진 회차의 정체성 정제가 «같은 규칙»을 쓰도록 하나로 둔다 — 규칙을 바꾸지 않는다.
 *  - 마스터: 세부모델(별칭) 대조 → 후보가 둘 이상이면 연식이 정확히 하나로 좁힐 때만, 아니면 보류.
 *  - 세부트림: 원문 차명에 통째로 들어 있는 트림 이름(별칭) 중 가장 긴 것이 정확히 하나일 때만(UNIQUE), 둘 이상이면 AMBIGUOUS, 없으면 NONE. */
export type IdentityMatch =
  | { state: 'MATCH'; master: IdentityMaster; trim: { state: 'UNIQUE'; name: string } | { state: 'AMBIGUOUS'; candidates: string[] } | { state: 'NONE' } }
  | { state: 'HOLD'; reason: 'NO_MASTER_MATCH' | 'AMBIGUOUS_MASTER' | 'YEAR_OUT_OF_RANGE' | GenerationGuardReason | 'VARIANT_MISMATCH'; candidates: string[] };
/** 변형 낱말 집합(규칙 15·16): HYBRID(하이브리드·HEV), PHEV(플러그인·PHEV), EV(일렉트릭·단독 EV). 영숫자 단어 경계로만 본다(CHEVROLET 의 HEV·EV6 의 EV 는 변형이 아니다).
 * LPG 는 연료 사양이라 변형으로 보지 않는다. */
const BOUNDED = (word: string) => new RegExp(`(?<![A-Z0-9])${word}(?![A-Z0-9])`);
const variantsOf = (text: string): Set<string> => {
  const t = text.normalize('NFKC').toUpperCase();
  const out = new Set<string>();
  if (/플러그인/.test(t) || BOUNDED('PHEV').test(t)) out.add('PHEV');
  else if (/하이브리드/.test(t) || BOUNDED('HEV').test(t) || BOUNDED('HYBRID').test(t)) out.add('HYBRID');
  if (/일렉트릭/.test(t) || BOUNDED('ELECTRIC').test(t) || BOUNDED('EV').test(t)) out.add('EV');
  return out;
};
/** 원문의 변형 낱말이 모두 마스터(세부모델·모델·별칭) 이름에 있는가. 원문에 변형이 없으면 항상 true.
 * EV 는 EV 전용 모델(아이오닉 5 등: 같은 모델에 EV 변형 형제 마스터가 없음)이 많아, 같은 제조사·모델에 «EV 가 이름에 있는 형제 마스터»가 있을 때만 누락으로 본다(코나 EV → 코나 SX2 보류). */
const variantCovered = (rawText: string, master: IdentityMaster, masters: readonly IdentityMaster[]): boolean => {
  const raw = variantsOf(rawText);
  if (!raw.size) return true;
  const names = (m: IdentityMaster) => [m.sub_model, m.model, ...m.sub_model_aliases, ...m.model_aliases].join(' ');
  const have = variantsOf(names(master));
  return [...raw].every(v => {
    if (have.has(v)) return true;
    if (v !== 'EV') return false;
    const sameFamily = masters.some(m => m.id !== master.id && norm(m.maker) === norm(master.maker) && norm(m.model) === norm(master.model) && variantsOf(names(m)).has('EV'));
    return !sameFamily;
  });
};

export function matchIdentity(p: IdentityProduct, masters: readonly IdentityMaster[]): IdentityMatch {
  let cands = masterCandidates(p, masters);
  if (!cands.length) return { state: 'HOLD', reason: 'NO_MASTER_MATCH', candidates: [] };
  // 연식으로 세대를 좁힌다: 연식이 있고 후보가 둘 이상일 때만, 범위 안에 들어가는 후보가 «정확히 하나»여야 한다.
  const year = /^\d{4}$/.test(p.year) ? Number(p.year) : null;
  if (cands.length > 1 && year !== null) {
    const inRange = cands.filter(m => (m.yearFrom === null || year >= m.yearFrom) && (m.yearTo === null || year <= m.yearTo));
    if (inRange.length === 1) cands = inRange;
    else if (inRange.length === 0) return { state: 'HOLD', reason: 'YEAR_OUT_OF_RANGE', candidates: cands.map(m => m.id) };
    else cands = inRange;
  }
  if (cands.length !== 1) return { state: 'HOLD', reason: 'AMBIGUOUS_MASTER', candidates: cands.map(m => m.id).sort() };
  const master = cands[0]!;
  // 세대 구분 근거(R1·R2): 원문 부분 일치로 마스터를 고른 경우에만 점검한다(상품의 세부모델 칸을 마스터 이름과 «정확히» 대조한 경우는 해당 없음).
  const engineRawProduct = !p.maker.trim() && !p.model.trim();
  // 별칭으로 고른 경우(상품 세부모델 칸이 마스터 세부모델 이름이 아니라 «팰리세이드» 같은 별칭·기본 이름)도 원문 차명이 있으면 같은 점검을 받는다(2026-10-16:
  // 원문 «더 뉴팰리세이드» 상품이 세부모델 칸 «팰리세이드» 별칭으로 일반 «팰리세이드 LX2» 에 매칭되던 우회 — 세부모델 칸이 채워졌다는 이유로 R1 이 건너뛰어졌다).
  const aliasMatched = !!norm(p.sub_model) && norm(p.sub_model) !== norm(master.sub_model) && !!(p.rawName ?? '').trim();
  if (engineRawProduct || !norm(p.sub_model) || aliasMatched) {
    const rawText = p.rawName || (engineRawProduct ? p.sub_model : '');
    const guard = generationGuard({ rawName: rawText, year: p.year, master, masters });
    if (guard) return { state: 'HOLD', reason: guard, candidates: [master.sub_model] };
  }
  // 변형 낱말(규칙 15·16: 하이브리드·플러그인 하이브리드·EV 는 세부모델을 따로 둔다): 원문에 있는데 고른 마스터 이름에 없으면 일반 세대를 잘못 고른 것 — 보류(R4).
  // 이미 세부모델이 채워진 상품도 원문 차명이 있으면 같은 검사를 받는다(빈칸 조건문 안에 두면 채워진 상품이 우회한다).
  const variantText = p.rawName || (engineRawProduct ? p.sub_model : '');
  if (variantText && !variantCovered(variantText, master, masters)) return { state: 'HOLD', reason: 'VARIANT_MISMATCH', candidates: [master.sub_model] };
  // 세부트림: 원문 차명에 «통째로» 들어 있는 트림 이름(별칭 포함) 중 가장 긴 것이 정확히 하나일 때만. 근거가 없으면 지어내지 않고 보류.
  const raw = norm(p.rawName || (!p.maker.trim() && !p.model.trim() ? p.sub_model : ''));
  const trimHits = master.trims.map(t => ({ t, len: Math.max(0, ...[t.name, ...t.aliases].map(norm).filter(n => n.length >= 2 && raw.includes(n)).map(n => n.length)) })).filter(x => x.len > 0);
  const bestLen = Math.max(0, ...trimHits.map(x => x.len));
  // 같은 «이름»의 트림 행이 여럿(파워트레인·연식별 행)이어도 쓰는 값은 이름 하나다 — 이름 기준으로 중복을 합쳐 센다(서로 다른 이름이 같은 길이로 걸릴 때만 모호).
  const bestByName = new Map<string, (typeof trimHits)[number]>();
  for (const x of trimHits) if (x.len === bestLen && !bestByName.has(x.t.name)) bestByName.set(x.t.name, x);
  const bestTrims = [...bestByName.values()];
  return { state: 'MATCH', master, trim: bestTrims.length === 1 ? { state: 'UNIQUE', name: bestTrims[0]!.t.name }
    : bestTrims.length > 1 ? { state: 'AMBIGUOUS', candidates: bestTrims.map(x => x.t.name).sort() } : { state: 'NONE' } };
}

export function buildIdentityPromotionPlan(products: readonly IdentityProduct[], masters: readonly IdentityMaster[], options: { sourceLabel?: string } = {}): IdentityPromotionResult {
  const identityRepairs: IdentityRepairItem[] = [];
  const trimRepairs: TrimRepairItem[] = [];
  const held: IdentityHold[] = [];
  let alreadyMatched = 0;
  for (const p of [...products].sort((a, b) => a.id.localeCompare(b.id))) {
    const m = matchIdentity(p, masters);
    if (m.state === 'HOLD') { held.push({ id: p.id, plate4: p.plate4, reason: m.reason, candidates: m.candidates }); continue; }
    const master = m.master;
    const currentTrim = norm(p.trim_name);
    const identityOk = norm(p.sub_model) === norm(master.sub_model) && norm(p.model) === norm(master.model) && norm(p.maker) === norm(master.maker) &&
      p.sub_model === master.sub_model && p.model === master.model && p.maker === master.maker;
    if (!identityOk) {
      identityRepairs.push({ id: p.id, from: { maker: p.maker, model: p.model, sub_model: p.sub_model },
        to: { maker: master.maker, model: master.model, sub_model: master.sub_model }, evidence: `원문 차명: ${p.rawName}`.slice(0, 200) });
    }
    if (m.trim.state === 'UNIQUE') {
      const trim = m.trim.name;
      // 이미 값이 있는 트림은 근거 없이 다른 등급으로 바꾸지 않는다(적용기 규칙 (c)와 같은 취지): 철자만 다른(정규화 같음) 경우만 정정, 그 밖은 보류.
      if (p.trim_name.trim() && p.trim_name !== trim && norm(p.trim_name) !== norm(trim) && p.engineTemp !== true) {
        held.push({ id: p.id, plate4: p.plate4, reason: 'TRIM_CONFLICT_EXISTING', candidates: [trim] });
      } else if (p.trim_name !== trim) {
        trimRepairs.push({ id: p.id, from: p.trim_name, to: trim, ...(p.trim_name.trim() ? {} : { evidence: `원문 차명: ${p.rawName}`.slice(0, 200) }) });
      }
    } else if (m.trim.state === 'AMBIGUOUS') {
      held.push({ id: p.id, plate4: p.plate4, reason: 'AMBIGUOUS_TRIM', candidates: m.trim.candidates });
    } else if (!currentTrim) {
      held.push({ id: p.id, plate4: p.plate4, reason: 'NO_TRIM_MATCH', candidates: [] });
    }
    if (identityOk && m.trim.state === 'UNIQUE' && p.trim_name === m.trim.name) alreadyMatched++;
  }
  // 정체성 정정을 받는 상품의 세부트림은 두 번째 계획으로(정정 경로 «one product per plan»).
  const identityIds = new Set(identityRepairs.map(r => r.id));
  const laterTrims = trimRepairs.filter(r => identityIds.has(r.id)), nowTrims = trimRepairs.filter(r => !identityIds.has(r.id));
  const baseDigest = stableDigest({ label: options.sourceLabel ?? 'identity-promotion',
      products: [...products].sort((a, b) => a.id.localeCompare(b.id)).map(p => [p.id, p.maker, p.model, p.sub_model, p.trim_name]),
      masters: [...masters].sort((a, b) => a.id.localeCompare(b.id)).map(m => [m.id, m.sub_model, m.trims.map(t => t.name)]) });
  const plan: VehicleNameRepairPlan = { sourceDigest: baseDigest, masterRepairs: [], productRepairs: [],
    ...(identityRepairs.length ? { productIdentityRepairs: identityRepairs } : {}),
    ...(nowTrims.length ? { productTrimRepairs: nowTrims } : {}),
  };
  const trimPlan: VehicleNameRepairPlan | null = laterTrims.length
    ? { sourceDigest: stableDigest({ base: baseDigest, part: 'trim-after-identity' }), masterRepairs: [], productRepairs: [], productTrimRepairs: laterTrims }
    : null;
  // R3 부록: 세대 근거 보류 상품을 별칭 후보로 묶는다(어느 마스터로 이을지는 연식으로 좁힌 «후보»일 뿐이다).
  const byId = new Map(products.map(p => [p.id, p]));
  const guardHeld = held.filter(h => h.reason === 'GENERATION_QUALIFIER_MISMATCH' || h.reason === 'GENERATION_EVIDENCE_MISSING' || h.reason === 'GENERATION_CODE_CONFLICT').flatMap(h => {
    const p = byId.get(h.id);
    const master = masters.find(m => m.sub_model === h.candidates[0]);
    return p && master ? [{ rawName: p.rawName || p.sub_model, year: p.year, reason: h.reason as GenerationGuardReason, master }] : [];
  });
  return { plan, trimPlan, held, stats: { products: products.length, identityRepairs: identityRepairs.length, trimRepairs: trimRepairs.length, held: held.length, alreadyMatched },
    appendix: { generationFamilies: generationFamilies(masters), aliasCandidates: aliasCandidates(guardHeld, masters) } };
}

/** 이미 확정된 상품(세부모델 칸이 마스터 이름과 정확히 같은 문서)을 R1·R2 로 다시 점검하는 읽기 전용 감사(쓰기 0, 되돌림 없음 — «검토 필요» 후보만 낸다).
 * 원문 차명이 비어 있거나 마스터 이름·별칭이 원문에 하나도 없으면 UNVERIFIABLE(근거 없음 ≠ 오류). */
export type ConfirmedAuditRow = { id: string; plate4: string; supplier: string; verdict: 'OK' | 'UNVERIFIABLE' | GenerationGuardReason; sub_model: string };
export function auditConfirmedIdentities(products: ReadonlyArray<IdentityProduct & { supplier?: string }>, masters: readonly IdentityMaster[]): {
  rows: ConfirmedAuditRow[]; bySupplier: Record<string, Record<string, number>>; total: number; unmatchedMaster: number } {
  const rows: ConfirmedAuditRow[] = [];
  let unmatchedMaster = 0, total = 0;
  for (const p of products) {
    if (!p.sub_model.trim() || !p.maker.trim() || !p.model.trim()) continue;
    const hits = masters.filter(m => norm(m.sub_model) === norm(p.sub_model) && norm(m.maker) === norm(p.maker) && norm(m.model) === norm(p.model));
    total++;
    if (hits.length !== 1) { unmatchedMaster++; continue; }
    const master = hits[0]!;
    const raw = p.rawName.trim();
    const supplier = p.supplier?.trim() || '(미상)';
    const mentioned = raw && [master.sub_model, ...master.sub_model_aliases].map(norm).some(n => n.length >= 3 && norm(raw).includes(n));
    const verdict = !raw || !mentioned ? 'UNVERIFIABLE' as const : generationGuard({ rawName: raw, year: p.year, master, masters }) ?? 'OK' as const;
    rows.push({ id: p.id, plate4: p.plate4, supplier, verdict, sub_model: master.sub_model });
  }
  const bySupplier: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const entry = bySupplier[r.supplier] ??= {};
    entry[r.verdict] = (entry[r.verdict] ?? 0) + 1;
  }
  return { rows, bySupplier, total, unmatchedMaster };
}

/** 엔진 회차의 정체성 정제(대표 2026-10-15 «손오공 새로 API 연동해서 땡겨온 애들은 … 모델명도 정제되어 있지 않고»): 위 matchIdentity 를 그대로 쓴다.
 * 엔진 편입 문서(제조사·모델 빈칸, 원문 차명)를 마스터 하나로 특정할 때만 결과를 내고, 아니면 null(= 지금처럼 원문 차명·검토 필요로 둔다).
 * 세부트림은 하나로 특정될 때만 이름, 아니면 null(빈칸 유지). */
export function refineEngineIdentity(input: { rawName: string; year: string }, masters: readonly IdentityMaster[]): VehicleIdentityRefinement | null {
  const rawName = input.rawName.trim();
  if (!rawName) return null;
  const m = matchIdentity({ id: '', plate4: '', maker: '', model: '', sub_model: rawName, trim_name: '', rawName, year: input.year, listable: false }, masters);
  if (m.state !== 'MATCH' || !m.master.maker.trim() || !m.master.model.trim() || !m.master.sub_model.trim()) return null;
  return { maker: m.master.maker, model: m.master.model, sub_model: m.master.sub_model, trim_name: m.trim.state === 'UNIQUE' ? m.trim.name : null, master_id: m.master.id };
}

/** 활성 차종 마스터 스냅샷(vehicle_master 문서 + 검증된 vehicle_trim_master 행) → 대조용 IdentityMaster 목록(순수, 쓰기 0).
 * 행 검증(최신성·digest·이름 일치·퇴역)은 호출하는 쪽이 기존 검증기(verifiedMasterRecords)로 먼저 한다. 여기서는 모양만 옮긴다:
 * 퇴역(retired)이거나 제조사·모델·세부모델이 빈 마스터는 이름으로 쓸 수 없어 뺀다. 세대 연도는 마스터의 year_start·year_end(앞 4자리, «현재»·빈칸은 제한 없음). */
export function identityMastersFromVehicleMaster(input: {
  masters: ReadonlyArray<{ id: string; data: Record<string, unknown> }>;
  records: ReadonlyArray<{ masterId: string; names: readonly string[]; aliases: ReadonlyArray<readonly string[]> }>;
}): IdentityMaster[] {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);
  const year = (v: unknown): number | null => {
    const m = /^(\d{4})/.exec(text(v));
    const n = m ? Number(m[1]) : NaN;
    return n >= 1900 && n <= 2100 ? n : null;
  };
  const byMaster = new Map<string, Array<(typeof input.records)[number]>>();
  for (const r of input.records) (byMaster.get(r.masterId) ?? byMaster.set(r.masterId, []).get(r.masterId)!).push(r);
  const out: IdentityMaster[] = [];
  for (const doc of [...input.masters].sort((a, b) => a.id.localeCompare(b.id))) {
    const d = doc.data;
    if (d.retired === true || !text(d.maker) || !text(d.model) || !text(d.sub_model)) continue;
    const rows = byMaster.get(doc.id) ?? [];
    const trims = new Map<string, Set<string>>();
    for (const r of rows) {
      const name = text(r.names[3]);
      if (!name) continue;
      const aliases = trims.get(name) ?? trims.set(name, new Set()).get(name)!;
      for (const a of (r.aliases[3] ?? []).slice(1)) if (text(a) && text(a) !== name) aliases.add(text(a));
    }
    const subAliases = new Set(list(d.sub_model_aliases));
    for (const r of rows) for (const a of (r.aliases[2] ?? []).slice(1)) if (text(a)) subAliases.add(text(a));
    out.push({ id: doc.id, maker: text(d.maker), model: text(d.model), sub_model: text(d.sub_model),
      model_aliases: list(d.model_aliases), sub_model_aliases: [...subAliases].sort(),
      yearFrom: year(d.year_start), yearTo: year(d.year_end),
      trims: [...trims].sort(([a], [b]) => a.localeCompare(b)).map(([name, aliases]) => ({ name, aliases: [...aliases].sort() })) });
  }
  return out;
}
