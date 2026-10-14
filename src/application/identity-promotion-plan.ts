/** 정체성 승격 «계획서 생성기»(순수·읽기 전용) — 커맨드 센터 2026-10-14 확정: 하나로 특정되는 것만 정정 경로(repair:vehicle-name-parity)의 계획서 후보로 낸다.
 * 입력은 운영 문서·차종 마스터의 «스냅샷»(이 PC 는 운영 Firestore 를 읽지 못하므로 B3Q 가 만든 JSON)이고, 출력은 VehicleNameRepairPlan 후보와 보류 목록이다.
 * 규칙(기준 한 장): 지어내지 않는다·별칭은 조건 없이 하나로 이어질 때만·후보가 둘 이상이거나 근거가 비면 보류. 마스터는 읽기만 하고 쓰지 않는다. */
import { stableDigest } from '../shared/stable-digest.js';
import type { VehicleNameRepairPlan } from '../infra/vehicle-name-reference-repair-firestore.js';

export type IdentityProduct = {
  /** 상품 문서 id(정정 경로가 쓰는 그대로). */ id: string;
  /** 번호 끝 4자리(보고용, 전체 번호는 두지 않는다). */ plate4: string;
  maker: string; model: string; sub_model: string; trim_name: string;
  /** 공급사 원문 차명(근거 문구). */ rawName: string;
  /** 연식(4자리) 또는 최초등록 연도, 없으면 ''. */ year: string;
  listable: boolean;
};
export type IdentityMasterTrim = { name: string; aliases: string[] };
export type IdentityMaster = {
  id: string; maker: string; model: string; sub_model: string; model_aliases: string[]; sub_model_aliases: string[];
  /** 세대 생산 시작·끝 연도(없으면 null = 제한 없음). */ yearFrom: number | null; yearTo: number | null;
  trims: IdentityMasterTrim[];
};
export type IdentityHold = { id: string; plate4: string; reason: 'NO_MASTER_MATCH' | 'AMBIGUOUS_MASTER' | 'YEAR_OUT_OF_RANGE' | 'NO_TRIM_MATCH' | 'AMBIGUOUS_TRIM' | 'ALREADY_MATCHED'; candidates: string[] };
export type IdentityPromotionResult = {
  plan: VehicleNameRepairPlan; held: IdentityHold[];
  stats: { products: number; identityRepairs: number; trimRepairs: number; held: number; alreadyMatched: number };
};

const norm = (v: string) => v.normalize('NFKC').replace(/[\s_\-·.,()]/g, '').toUpperCase();
const names = (m: IdentityMaster) => [m.sub_model, ...m.sub_model_aliases].map(norm).filter(Boolean);
const models = (m: IdentityMaster) => [m.model, ...m.model_aliases].map(norm).filter(Boolean);

/** 상품의 sub_model(없으면 원문 차명)이 가리키는 마스터 후보. 모델 칸이 있으면 모델도 같아야 한다(별칭 포함). */
function masterCandidates(p: IdentityProduct, masters: readonly IdentityMaster[]): IdentityMaster[] {
  const sub = norm(p.sub_model), model = norm(p.model), raw = norm(p.rawName);
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

export function buildIdentityPromotionPlan(products: readonly IdentityProduct[], masters: readonly IdentityMaster[], options: { sourceLabel?: string } = {}): IdentityPromotionResult {
  const identityRepairs: NonNullable<VehicleNameRepairPlan['productIdentityRepairs']> = [];
  const trimRepairs: NonNullable<VehicleNameRepairPlan['productTrimRepairs']> = [];
  const held: IdentityHold[] = [];
  let alreadyMatched = 0;
  for (const p of [...products].sort((a, b) => a.id.localeCompare(b.id))) {
    let cands = masterCandidates(p, masters);
    if (!cands.length) { held.push({ id: p.id, plate4: p.plate4, reason: 'NO_MASTER_MATCH', candidates: [] }); continue; }
    // 연식으로 세대를 좁힌다: 연식이 있고 후보가 둘 이상일 때만, 범위 안에 들어가는 후보가 «정확히 하나»여야 한다.
    const year = /^\d{4}$/.test(p.year) ? Number(p.year) : null;
    if (cands.length > 1 && year !== null) {
      const inRange = cands.filter(m => (m.yearFrom === null || year >= m.yearFrom) && (m.yearTo === null || year <= m.yearTo));
      if (inRange.length === 1) cands = inRange;
      else if (inRange.length === 0) { held.push({ id: p.id, plate4: p.plate4, reason: 'YEAR_OUT_OF_RANGE', candidates: cands.map(m => m.id) }); continue; }
      else cands = inRange;
    }
    if (cands.length !== 1) { held.push({ id: p.id, plate4: p.plate4, reason: 'AMBIGUOUS_MASTER', candidates: cands.map(m => m.id).sort() }); continue; }
    const master = cands[0]!;
    // 세부트림: 원문 차명에 «통째로» 들어 있는 트림 이름(별칭 포함) 중 가장 긴 것이 정확히 하나일 때만. 근거가 없으면 지어내지 않고 보류.
    const raw = norm(p.rawName);
    const trimHits = master.trims.map(t => ({ t, len: Math.max(0, ...[t.name, ...t.aliases].map(norm).filter(n => n.length >= 2 && raw.includes(n)).map(n => n.length)) })).filter(x => x.len > 0);
    const bestLen = Math.max(0, ...trimHits.map(x => x.len));
    const bestTrims = trimHits.filter(x => x.len === bestLen);
    const currentTrim = norm(p.trim_name);
    const identityOk = norm(p.sub_model) === norm(master.sub_model) && norm(p.model) === norm(master.model) && norm(p.maker) === norm(master.maker) &&
      p.sub_model === master.sub_model && p.model === master.model && p.maker === master.maker;
    if (!identityOk) {
      identityRepairs.push({ id: p.id, from: { maker: p.maker, model: p.model, sub_model: p.sub_model },
        to: { maker: master.maker, model: master.model, sub_model: master.sub_model }, evidence: `원문 차명: ${p.rawName}`.slice(0, 200) });
    }
    if (bestTrims.length === 1) {
      const trim = bestTrims[0]!.t.name;
      if (p.trim_name !== trim) {
        trimRepairs.push({ id: p.id, from: p.trim_name, to: trim, ...(p.trim_name.trim() ? {} : { evidence: `원문 차명: ${p.rawName}`.slice(0, 200) }) });
      }
    } else if (bestTrims.length > 1) {
      held.push({ id: p.id, plate4: p.plate4, reason: 'AMBIGUOUS_TRIM', candidates: bestTrims.map(x => x.t.name).sort() });
    } else if (!currentTrim) {
      held.push({ id: p.id, plate4: p.plate4, reason: 'NO_TRIM_MATCH', candidates: [] });
    }
    if (identityOk && bestTrims.length === 1 && p.trim_name === bestTrims[0]!.t.name) alreadyMatched++;
  }
  const plan: VehicleNameRepairPlan = {
    sourceDigest: stableDigest({ label: options.sourceLabel ?? 'identity-promotion',
      products: [...products].sort((a, b) => a.id.localeCompare(b.id)).map(p => [p.id, p.maker, p.model, p.sub_model, p.trim_name]),
      masters: [...masters].sort((a, b) => a.id.localeCompare(b.id)).map(m => [m.id, m.sub_model, m.trims.map(t => t.name)]) }),
    masterRepairs: [], productRepairs: [],
    ...(identityRepairs.length ? { productIdentityRepairs: identityRepairs } : {}),
    ...(trimRepairs.length ? { productTrimRepairs: trimRepairs } : {}),
  };
  return { plan, held, stats: { products: products.length, identityRepairs: identityRepairs.length, trimRepairs: trimRepairs.length, held: held.length, alreadyMatched } };
}
