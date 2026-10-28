/** 정체성 승격 «계획서 생성기»(순수·읽기 전용) — 커맨드 센터 2026-10-14 확정: 하나로 특정되는 것만 정정 경로(repair:vehicle-name-parity)의 계획서 후보로 낸다.
 * 입력은 운영 문서·차종 마스터의 «스냅샷»(이 PC 는 운영 Firestore 를 읽지 못하므로 B3Q 가 만든 JSON)이고, 출력은 VehicleNameRepairPlan 후보와 보류 목록이다.
 * 규칙(기준 한 장): 지어내지 않는다·별칭은 조건 없이 하나로 이어질 때만·후보가 둘 이상이거나 근거가 비면 보류. 마스터는 읽기만 하고 쓰지 않는다. */
import { validSheetIdentity, type SheetIdentity } from '../domain/sheet-identity.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { VehicleIdentityRefinement } from '../ports/source-cycle.js';
import { aliasCandidates, generationFamilies, generationGuard, type AliasCandidate, type GenerationFamily, type GenerationGuardReason } from './identity-generation-guard.js';
import { normalizedMasterCandidate } from './identity-normalized-match.js';

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
  /** 제조사·모델이 «원천 필드로 채운 값»(입구 매핑 표식 SOURCE_FIELDS): 마스터 대조에서는 빈칸으로 본다(원천 표기가 마스터 이름과 달라 후보에서 떨어지지 않게). */
  makerModelFromSource?: boolean;
  /** 문서 연료 칸(제원, «차 한 대 사실» — 기준 한 장 3절). 원문이 파워트레인을 안 적어도 하이브리드·전기 변형 근거가 된다. 없으면 ''. */
  fuel?: string;
};
export type IdentityMasterTrim = { name: string; aliases: string[] };
export type IdentityMaster = {
  id: string; maker: string; model: string; sub_model: string; model_aliases: string[]; sub_model_aliases: string[];
  /** 세대 생산 시작·끝 연도(없으면 null = 제한 없음). */ yearFrom: number | null; yearTo: number | null;
  trims: IdentityMasterTrim[];
};
export type IdentityHold = { id: string; plate4: string; reason: 'NO_MASTER_MATCH' | 'NORMALIZED_CANDIDATE' | 'AMBIGUOUS_MASTER' | 'YEAR_OUT_OF_RANGE' | 'NO_TRIM_MATCH' | 'AMBIGUOUS_TRIM' | 'ALREADY_MATCHED' | 'TRIM_CONFLICT_EXISTING' | GenerationGuardReason | 'VARIANT_MISMATCH'; candidates: string[] };
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
  // 원문 형태 판정(B3Q 2026-10-16 18:00 회차 후 NO_MASTER_MATCH 88→196): 입구 매핑이 제조사·모델을 채운 뒤에는 세부모델 칸이 아직 원문 차명 그대로여도 «제조사·모델이 있다» 로 보여
  // 마스터 세부모델 이름과 정확 비교하는 경로로 갔고(원문 형태는 마스터 이름이 아니라 항상 불일치), 채움 표식(makerModelFromSource)이 입력에 없을 때(문서 덤프 등) 그대로였다.
  // 엔진 임시 표식 문서이고 세부모델이 원문 차명과 같으면(원문 덩어리) 제조사·모델이 채워져 있어도 원문 대조 경로를 쓴다 — 제조사는 제약으로 남기고(다르면 불일치)
  // 원천이 준 모델 표기는 마스터 모델 이름과 다를 수 있어 제약에서 뺀다. 마스터에 없는 이름은 만들지 않는다(후보가 없으면 NO_MASTER_MATCH).
  const rawShaped = p.engineTemp === true && !!p.maker.trim() && !!p.rawName.trim() && norm(p.sub_model) === norm(p.rawName);
  const engineRaw = (!p.maker.trim() && !p.model.trim()) || rawShaped;
  const sub = engineRaw ? '' : norm(p.sub_model), model = rawShaped ? '' : norm(p.model), raw = norm(p.rawName || (engineRaw ? p.sub_model : ''));
  const makerKey = rawShaped ? norm(p.maker) : '';
  const hits = masters.filter(m => {
    if (makerKey && norm(m.maker) !== makerKey) return false;
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
  | { state: 'HOLD'; reason: 'NO_MASTER_MATCH' | 'NORMALIZED_CANDIDATE' | 'AMBIGUOUS_MASTER' | 'YEAR_OUT_OF_RANGE' | GenerationGuardReason | 'VARIANT_MISMATCH'; candidates: string[] };
/** 변형 낱말 집합(규칙 15·16): HYBRID(하이브리드·HEV), PHEV(플러그인·PHEV), EV(일렉트릭·단독 EV). 영숫자 단어 경계로만 본다(CHEVROLET 의 HEV·EV6 의 EV 는 변형이 아니다).
 * LPG 는 연료 사양이라 변형으로 보지 않는다. */
/** 연료 칸 → 변형 낱말(변형 점검 입력). 가솔린·디젤·LPG 는 변형이 아니다. */
export function fuelVariantWord(fuel: string): string {
  const f = fuel.normalize('NFKC').replace(/\s+/g, '');
  if (!f) return '';
  if (/플러그인|PHEV|PLUG-?IN/i.test(f)) return '플러그인 하이브리드';
  if (/하이브리드|HEV|HYBRID/i.test(f) || (/(가솔린|디젤|휘발유|경유)/.test(f) && /전기/.test(f))) return '하이브리드';
  if (/^(전기|전기차|일렉트릭|EV|BEV|ELECTRIC)$/i.test(f)) return 'EV';
  return '';
}
const BOUNDED = (word: string) => new RegExp(`(?<![A-Z0-9])${word}(?![A-Z0-9])`);
const variantsOf = (text: string): Set<string> => {
  const t = text.normalize('NFKC').toUpperCase();
  const out = new Set<string>();
  if (/플러그인/.test(t) || BOUNDED('PHEV').test(t) || /(?<![A-Z0-9])PLUG[-\s]?IN(?![A-Z0-9])/.test(t)) out.add('PHEV');
  else if (/하이브리드/.test(t) || BOUNDED('HEV').test(t) || BOUNDED('HYBRID').test(t)
    || (/(가솔린|디젤|휘발유|경유)/.test(t) && /(?<![가-힣])전기(?![가-힣])/.test(t))) out.add('HYBRID');   // «가솔린+전기» 는 하이브리드 표기
  // «전기»·«전기차» 낱말(한글 경계)도 전기 변형이다(Codex #682): 가솔린·디젤과 같이 적힌 하이브리드 표기는 위에서 이미 HYBRID 로 읽었다.
  if (/일렉트릭/.test(t) || BOUNDED('ELECTRIC').test(t) || BOUNDED('EV').test(t) || BOUNDED('BEV').test(t)
    || /전기차/.test(t) || (!out.has('HYBRID') && !out.has('PHEV') && /(?<![가-힣])전기(?![가-힣])/.test(t))) out.add('EV');
  return out;
};
/** 원문의 변형 낱말이 모두 마스터(세부모델·모델·별칭) 이름에 있는가. 원문에 변형이 없으면 항상 true.
 * EV 는 EV 전용 모델(아이오닉 5 등: 같은 모델에 EV 변형 형제 마스터가 없음)이 많아, 같은 제조사·모델에 «EV 가 이름에 있는 형제 마스터»가 있을 때만 누락으로 본다(코나 EV → 코나 SX2 보류). */
const variantCovered = (rawText: string, master: IdentityMaster, masters: readonly IdentityMaster[]): boolean => {
  const raw = variantsOf(rawText);
  if (!raw.size) return true;
  const names = (m: IdentityMaster) => [m.sub_model, m.model, ...m.sub_model_aliases, ...m.model_aliases].join(' ');
  const have = variantsOf(names(master));
  // 마스터 쪽도 같은 규칙(Codex #682 ③): 르노 계열 마스터 이름에 E-TECH 가 있으면 하이브리드 이름으로 본다.
  const renaultMaker = ['르노', '르노코리아'].includes(master.maker.normalize('NFKC').replace(/\s+/g, ''));
  if (renaultMaker && /(?<![A-Z0-9])E[-\s]?TECH(?![A-Z0-9])/i.test(names(master).normalize('NFKC'))) have.add('HYBRID');
  return [...raw].every(v => {
    if (have.has(v)) return true;
    if (v !== 'EV') return false;
    const sameFamily = masters.some(m => m.id !== master.id && norm(m.maker) === norm(master.maker) && norm(m.model) === norm(master.model) && variantsOf(names(m)).has('EV'));
    return !sameFamily;
  });
};

/** 엔진·파워트레인 이름(스마트스트림·감마·누우·쎄타·람다·카파·T-GDi·e-VGT·VGT·CRDi·MPI)은 차종이 아니라 «차종 기준 한 장»상 마스터에 쓰지 않는 낱말이다.
 * 원문에 섞여 있으면 마스터 이름의 일부(예 «스마트스트림» 안의 «스트림»)에 걸려 엉뚱한 행으로 연결되므로 대조 전에 뗀다(대표 2026-10-22). 원문 자체는 건드리지 않는다. 마스터 트림 이름에 쓰이는 TCe·dCi·GDi 는 일부러 뺐다(트림 대조가 깨진다). */
const KO = '가-힣', AL = 'A-Za-z0-9', DASH = '\\s\\-\\u2010-\\u2015';
const POWERTRAIN_WORDS = new RegExp([
  '스마트\\s*스트림', 'smart\\s*stream',
  `(?<![${KO}])(?:감마|누우|쎄타|람다|카파)(?![${KO}])`,
  `(?<![${AL}])T[${DASH}]?GDI(?![${AL}])`, `(?<![${AL}])e[${DASH}]?VGT(?![${AL}])`, `(?<![${AL}])VGT(?![${AL}])`, `(?<![${AL}])CRDI(?![${AL}])`, `(?<![${AL}])MPI(?![${AL}])`,
].join('|'), 'gi');
export const stripPowertrainWords = (text: string): string => text.replace(POWERTRAIN_WORDS, ' ').replace(/\s{2,}/g, ' ').trim();

export function matchIdentity(rawInput: IdentityProduct, masters: readonly IdentityMaster[]): IdentityMatch {
  const engineShaped = norm(rawInput.sub_model ?? '') === norm(rawInput.rawName ?? '');   // 엔진 임시 문서: 세부모델 칸이 원문 차명 그대로
  const cleanRaw = stripPowertrainWords(rawInput.rawName ?? '');
  const input: IdentityProduct = cleanRaw === (rawInput.rawName ?? '') ? rawInput : { ...rawInput, rawName: cleanRaw, ...(engineShaped ? { sub_model: cleanRaw } : {}) };
  const p: IdentityProduct = input.makerModelFromSource ? { ...input, maker: '', model: '' } : input;
  let cands = masterCandidates(p, masters);
  if (!cands.length) {
    // 정규화 후보(확정 아님): 접두·개발코드·세대 표기·짧은 모델 이름·붙여쓴 표기를 느슨히 정규화해 마스터 세부모델이 «정확히 하나» 잡히면 사유만 달리한다 —
    // MATCH 가 아니므로 적용되지 않고(엔진 정제기도 null), 사람이 확인하거나 정밀도 측정(golden set) 뒤 승격한다. 마스터에 없는 이름은 만들지 않는다.
    const nc = normalizedMasterCandidate({ rawName: p.rawName || p.sub_model, year: p.year, maker: p.maker, fuel: fuelVariantWord(p.fuel ?? '') }, masters);
    if (nc) return { state: 'HOLD', reason: 'NORMALIZED_CANDIDATE', candidates: [nc.master.id] };
    return { state: 'HOLD', reason: 'NO_MASTER_MATCH', candidates: [] };
  }
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
  // 원문 근거가 없으면(rawName 누락·빈 문자열·공백) 별칭 일치를 확정하지 않고 보류한다(Codex #679: 근거 없는 별칭 일치가 세대 점검을 우회해 기존 세부모델을 바꾸던 경로).
  const aliasMatched = !!norm(p.sub_model) && norm(p.sub_model) !== norm(master.sub_model);
  if (aliasMatched && !(p.rawName ?? '').trim() && !engineRawProduct) return { state: 'HOLD', reason: 'GENERATION_EVIDENCE_MISSING', candidates: [master.sub_model] };
  if (engineRawProduct || !norm(p.sub_model) || aliasMatched) {
    const rawText = p.rawName || (engineRawProduct ? p.sub_model : '');
    const guard = generationGuard({ rawName: rawText, year: p.year, master, masters });
    if (guard) return { state: 'HOLD', reason: guard, candidates: [master.sub_model] };
  }
  // 변형 낱말(규칙 15·16: 하이브리드·플러그인 하이브리드·EV 는 세부모델을 따로 둔다): 원문에 있는데 고른 마스터 이름에 없으면 일반 세대를 잘못 고른 것 — 보류(R4).
  // 이미 세부모델이 채워진 상품도 원문 차명이 있으면 같은 검사를 받는다(빈칸 조건문 안에 두면 채워진 상품이 우회한다).
  // 변형 근거는 원문 낱말 + (르노 계열) E-TECH + 문서 연료 칸(하이브리드·플러그인·전기). 연료는 차 한 대 사실이라 원문이 침묵해도 쓴다.
  const baseVariantText = p.rawName || (engineRawProduct ? p.sub_model : '');
  // 영숫자 단어 경계로만(RETECH·E-TECHNOLOGY 는 E-TECH 가 아니다, Codex #682).
  const etech = /(?<![A-Z0-9])E[-\s]?TECH(?![A-Z0-9])/i.test(baseVariantText.normalize('NFKC')) && ['르노', '르노코리아'].includes(master.maker.normalize('NFKC').replace(/\s+/g, ''));
  const fuelWord = fuelVariantWord(p.fuel ?? '');
  // 상충 근거는 합치지 않고 보류한다(Codex #682): 원문의 변형과 연료 칸의 변형이 서로 다르면(원문 «전기» + 연료 «하이브리드» 등) 어느 쪽이 맞는지 모르므로 확정하지 않는다.
  const rawSet = variantsOf([baseVariantText, etech ? '하이브리드' : ''].filter(Boolean).join(' ')), fuelSet = variantsOf(fuelWord);
  if (rawSet.size && fuelSet.size && (rawSet.size !== fuelSet.size || [...rawSet].some(v => !fuelSet.has(v)))) return { state: 'HOLD', reason: 'VARIANT_MISMATCH', candidates: [master.sub_model] };
  const variantText = [baseVariantText, fuelWord, etech ? '하이브리드' : ''].filter(Boolean).join(' ');
  if (variantText.trim() && !variantCovered(variantText, master, masters)) return { state: 'HOLD', reason: 'VARIANT_MISMATCH', candidates: [master.sub_model] };
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
      // 원천 필드로 제조사·모델만 채운 문서(makerModelFromSource)의 비어 있지 않은 트림은 엔진이 쓴 적이 없다 — 사람 입력이므로 engineTemp 여도 덮어쓰지 않는다(Codex #685 ②).
      const humanTrimOnSourceFilled = p.makerModelFromSource === true && p.trim_name.trim() !== '';
      if (p.trim_name.trim() && p.trim_name !== trim && norm(p.trim_name) !== norm(trim) && (p.engineTemp !== true || humanTrimOnSourceFilled)) {
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
export function refineEngineIdentity(input: { rawName: string; year: string; sheet?: SheetIdentity }, masters: readonly IdentityMaster[]): VehicleIdentityRefinement | null {
  const byName = refineByName(input, masters);
  const sheet = validSheetIdentity(input.sheet);
  if (!sheet) return byName;
  const bySheet = matchSheetIdentity({ rawName: input.rawName, year: input.year, sheet }, masters);
  if (byName) return bySheet && bySheet.master_id !== byName.master_id ? null : byName;   // 이름 대조가 이미 하나로 정했으면 그대로, 시트와 다른 행이면 모순이라 보류
  return bySheet;
}

/** F05 시트의 차종 4칸 후보(대표 2026-10-22 승인): 제조사·모델·세부모델이 마스터 한 행과 «정확히» 같고, 원문과 모순되지 않으며(세대 한정어·개발코드 충돌·변형 낱말), 연식이 세대 범위를 1년 넘게 벗어나지 않을 때만(연식이 없거나 형식이 틀리면 연식 점검은 건너뛴다).
 * 세부트림은 그 행의 트림 이름과 정확히 같을 때만, 아니면 비운다. 세대 근거 부족(EVIDENCE_MISSING)은 허용한다 — 시트의 세부모델이 근거다. */
export function matchSheetIdentity(input: { rawName: string; year: string; sheet: SheetIdentity }, masters: readonly IdentityMaster[]): VehicleIdentityRefinement | null {
  const s = input.sheet;
  const exact = masters.filter(m => norm(m.maker) === norm(s.maker) && norm(m.model) === norm(s.model) && norm(m.sub_model) === norm(s.sub_model));
  if (exact.length !== 1) return null;
  const master = exact[0]!;
  const year = /^\d{4}$/.test(input.year) ? Number(input.year) : null;
  if (year !== null && ((master.yearFrom !== null && year < master.yearFrom - 1) || (master.yearTo !== null && year > master.yearTo + 1))) return null;
  const raw = stripPowertrainWords(input.rawName ?? '');
  // 원문이 시트의 모델과 모순되지 않아야 한다: 원문에 그 행의 모델 이름(별칭 포함)이 들어 있어야 한다(없으면 시트 값이 다른 차의 것일 수 있다).
  const rawN = norm(raw);
  if (!rawN || ![master.model, ...master.model_aliases].map(norm).filter(n => n.length >= 2).some(n => rawN.includes(n))) return null;
  if (raw) {
    const guard = generationGuard({ rawName: raw, year: input.year, master, masters });
    if (guard === 'GENERATION_QUALIFIER_MISMATCH' || guard === 'GENERATION_CODE_CONFLICT') return null;
    // 변형 낱말(하이브리드·EV…) 점검은 이름 대조와 같은 규칙: 정확 이름 경로로 한 번 더 통과해야 한다.
    const checked = matchIdentity({ id: '', plate4: '', maker: master.maker, model: master.model, sub_model: master.sub_model, trim_name: '', rawName: raw, year: input.year, listable: true } as IdentityProduct, masters);
    if (checked.state !== 'MATCH' || checked.master.id !== master.id) return null;
  }
  const trim = master.trims.find(t => norm(t.name) === norm(s.trim_name));
  return { maker: master.maker, model: master.model, sub_model: master.sub_model, trim_name: trim ? trim.name : null, master_id: master.id };
}

function refineByName(input: { rawName: string; year: string }, masters: readonly IdentityMaster[]): VehicleIdentityRefinement | null {
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
  return dropVariantAliasCollisions(out);
}

/** 변형 행(하이브리드·플러그인·EV)이 «같은 제조사·모델의 일반 행 이름과 똑같은» 별칭을 갖고 있으면 그 별칭만 대조에서 뺀다(순수, 마스터 문서는 건드리지 않는다).
 * 마스터 트림 문서에는 변형 행도 원래 세부모델 이름(예 «아반떼 CN7»)을 별칭으로 들고 있어, 원문 «아반떼 CN7» 이 일반 행(이름)과 변형 행(별칭)에 똑같이 걸려 가장 긴 일치가 동률이 되고
 * 연식 범위도 같아 매번 AMBIGUOUS_MASTER 로 보류됐다(대표 2026-10-22 «99대 정리»). 변형 낱말이 원문에 있으면 변형 행의 정식 이름(…하이브리드 CN7)이 더 길게 걸려 그대로 변형 행으로 간다.
 * 세대 쌍(더 뉴 X ↔ X: 연식으로 구분)의 별칭은 일부러 두 행을 가르는 근거라 건드리지 않는다. */
const VARIANT_NAME = /하이브리드|플러그인|일렉트릭|전기|\bEV\b|PHEV|\bHEV\b|HYBRID|ELECTRIC|E-?TECH/i;
const rangesOverlap = (a: IdentityMaster, b: IdentityMaster) => (a.yearFrom === null || b.yearTo === null || a.yearFrom <= b.yearTo) && (b.yearFrom === null || a.yearTo === null || b.yearFrom <= a.yearTo);
export function dropVariantAliasCollisions(masters: IdentityMaster[]): IdentityMaster[] {
  const byModel = new Map<string, IdentityMaster[]>();
  for (const m of masters) { const k = `${norm(m.maker)}|${norm(m.model)}`; (byModel.get(k) ?? byModel.set(k, []).get(k)!).push(m); }
  return masters.map(m => {
    if (!VARIANT_NAME.test(m.sub_model)) return m;
    const siblings = byModel.get(`${norm(m.maker)}|${norm(m.model)}`)!.filter(o => o.id !== m.id && !VARIANT_NAME.test(o.sub_model));
    // 연식 범위가 겹치는 일반 행과만 충돌이다(범위가 갈리면 그 별칭은 연식으로 두 행을 가르는 근거라 남긴다).
    // 일반 행의 «이름»뿐 아니라 «별칭»과 같아도 충돌이다(2026-10-28: 하이브리드 LJL 트림 기록의 별칭 «아르카나»가 일반 아르카나 LJL 의 별칭과 같아
    // 원문 «아르카나»가 매번 AMBIGUOUS_MASTER). 변형 낱말이 든 별칭은 변형 행만 가리키므로 남긴다.
    const kept = m.sub_model_aliases.filter(a => VARIANT_NAME.test(a)
      || !siblings.some(o => rangesOverlap(m, o) && [o.sub_model, ...o.sub_model_aliases].some(n => norm(n) === norm(a))));
    return kept.length === m.sub_model_aliases.length ? m : { ...m, sub_model_aliases: kept };
  });
}
