/** 차종 마스터 추가 후보 목록(순수, 읽기 전용 — 쓰기·마스터 변경 없음).
 * 정체성 승격 계획의 «보류» 중 마스터를 보강해야 풀리는 사유(NO_MASTER_MATCH·AMBIGUOUS_TRIM·VARIANT_MISMATCH 등)를 공급사·원문 차명 단위로 묶어
 * 사람이 예/아니오로 결정할 수 있는 표로 만든다. 차종 기준 한 장(ai-ops docs/차종-기준-한장.md)을 따른다: 이름은 지어내지 않고(규칙 8·«마스터에 없는
 * 이름을 만들지 않는다»), 마스터에 넣는 것은 대표만(8절), 우리 차에 필요한 것만(규칙 11). 이 목록의 «제안»은 후보 문구이며 확정이 아니다 —
 * 세부모델 이름(규칙 1·2·3·14·15·18)과 세부트림(규칙 5)은 엔카·다나와 근거로 차종 마스터 세션이 정한다. 전체 차량번호는 없고 끝 4자리만 나온다. */
import { buildIdentityPromotionPlan, type IdentityMaster, type IdentityProduct } from './identity-promotion-plan.js';
import { generationCode } from './identity-generation-guard.js';

export type CandidateProduct = IdentityProduct & { supplier?: string };
export type CandidateRow = {
  supplier: string; reason: string; count: number; rawName: string;
  decomposed: { maker: string; model: string; code: string; powertrain: string } | null;
  yearRange: string; plate4Samples: string[]; masterCandidates: string[]; proposal: string;
  /** 판정: RULE_CLEAR = 기준 한 장 규칙상 이의가 없는 «세부모델 추가» 후보(코드는 공급사 원문 사실 — 엔카·다나와 대조는 남음), REVIEW = 사람 판단 필요. */
  verdict: 'RULE_CLEAR' | 'REVIEW'; verdictReasons: string[]; suggestedName: string;
  /** 제조사·모델·세부모델이 모두 비어 «차량 정보 확인 중» 으로 보일 상품 수(우선 처리 대상). */
  blankIdentityCount: number;
};

/** 출력에 나가는 모든 문자열의 마스킹(원문 차명에 전체 차량번호·전화번호가 섞여도 끝 4자리 제한을 지킨다, Codex #678 ②). */
export function maskSensitive(value: string): string {
  return value.normalize('NFKC')
    .replace(/(\d{2,3})\s?([가-힣])\s?(\d{4})/g, (_m, _a, _b, last4: string) => `****${last4}`)   // 차량번호 꼴 → 끝 4자리만
    .replace(/0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g, '[전화]')                                      // 전화번호 꼴
    .replace(/\d{7,}/g, '[숫자]');                                                                   // 긴 숫자열(번호·식별자 가능성)
}
const normName = (v: string) => v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
/** 손오공 원문 «제조사_모델(코드)_연료 배기량 …» 의 결정적 분해: 밑줄 3분할 + 모델 뒤 괄호 코드. 형식이 아니면 null(추정하지 않는다). */
export function decomposeSonogongName(raw: string): CandidateRow['decomposed'] {
  const parts = raw.normalize('NFKC').split('_').map(s => s.trim());
  if (parts.length < 3 || !parts[0] || !parts[1]) return null;
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(parts[1]!);
  return { maker: parts[0]!, model: (m ? m[1]! : parts[1]!).trim(), code: m ? m[2]!.trim() : '', powertrain: parts.slice(2).join('_').trim() };
}

const VARIANT_WORDS = /(하이브리드|플러그인|일렉트릭|전기|(?<![A-Z0-9])EV(?![A-Z0-9])|(?<![A-Z0-9])HEV(?![A-Z0-9])|(?<![A-Z0-9])PHEV(?![A-Z0-9])|(?<![A-Z0-9])HYBRID(?![A-Z0-9])|(?<![A-Z0-9])ELECTRIC(?![A-Z0-9]))/i;
const QUALIFIER_WORDS = /(더\s?뉴|올\s?뉴|디\s?올|\bFL\b|F\/L|페이스리프트|신형|뉴\s)/i;
const OLD_MAKER_SPELLINGS = new Set(['르노코리아', 'KG모빌리티']);
const keyOf = (v: string) => v.normalize('NFKC').replace(/[\s_\-·.]/g, '').toLowerCase();

/** 하이브리드 행 이름 도출(규칙 15·16·18, 기계적): 기존 일반 행 이름에서 «모델명 뒤·개발코드 앞»에 «하이브리드» 를 넣는다. 앞 수식어(더 뉴 등)는 그대로(규칙 18).
 * 국산·쉐보레만(규칙 15: 제조사가 하이브리드를 모델 이름에 쓰는 차). 개발코드가 없으면 이름 끝에 붙인다. */
const HYBRID_DOMESTIC_MAKERS = new Set(['현대', '기아', 'KGM', '쉐보레']);
export function deriveHybridName(subModel: string): string {
  const name = subModel.trim().replace(/\s+/g, ' ');
  const code = generationCode(name);
  if (code && name.length > code.length && name.toUpperCase().endsWith(code.toUpperCase())) return `${name.slice(0, name.length - code.length).trim()} 하이브리드 ${code}`;
  return `${name} 하이브리드`;
}
/** 변형 낱말이 «하이브리드 하나뿐»인가(플러그인·전기가 섞이면 아님). */
const isHybridOnly = (text: string) => /(하이브리드|(?<![A-Z0-9])HEV(?![A-Z0-9])|(?<![A-Z0-9])HYBRID(?![A-Z0-9]))/i.test(text) && !/(플러그인|(?<![A-Z0-9])PHEV(?![A-Z0-9])|일렉트릭|(?<![A-Z0-9])EV(?![A-Z0-9])|전기)/i.test(text);

/** VARIANT_MISMATCH 후보: 가장 가까운 일반 행에서 하이브리드 행 이름을 도출한다. 이름은 규칙 15·18 로 기계 도출되고, 그 세대에 하이브리드가 실제로 있는지는 엔카·다나와 대조가 남는다(규칙 8). */
export function classifyVariantCandidate(rawText: string, fuel: string, nearest: IdentityMaster | undefined, masters: readonly IdentityMaster[]): { verdict: CandidateRow['verdict']; reasons: string[]; suggestedName: string } {
  const review = (...why: string[]) => ({ verdict: 'REVIEW' as const, reasons: why, suggestedName: '' });
  if (!nearest) return review('NO_NEAREST_MASTER');
  const evidence = `${rawText} ${/(하이브리드|HEV)/i.test(fuel) ? '하이브리드' : ''}`;
  if (!isHybridOnly(evidence)) return review('VARIANT_NOT_HYBRID_ONLY');
  if (!HYBRID_DOMESTIC_MAKERS.has(nearest.maker.trim())) return review('MAKER_NOT_DOMESTIC_RULE_15');
  if (/(하이브리드|HEV|EV|일렉트릭|플러그인|PHEV)/i.test(nearest.sub_model)) return review('NEAREST_ROW_ALREADY_VARIANT');
  const name = deriveHybridName(nearest.sub_model);
  if (masters.some(m => m.maker === nearest.maker && m.model === nearest.model && m.sub_model.replace(/\s+/g, ' ') === name)) return review('HYBRID_ROW_EXISTS_NAME_MATCH_ISSUE');
  return { verdict: 'RULE_CLEAR', reasons: ['HYBRID_ROW_DERIVED_RULE_15_18'], suggestedName: name };
}

/** 규칙상 이의가 없는 «세부모델 추가» 후보만 RULE_CLEAR. 이름은 모델 + 개발코드(규칙 1)만 제안하며, 마스터에 이미 있는 제조사·모델 안에서 «새 개발코드»일 때만. */
export function classifyCandidate(reason: string, decomposed: CandidateRow['decomposed'], masters: readonly IdentityMaster[]): { verdict: CandidateRow['verdict']; reasons: string[]; suggestedName: string } {
  const review = (...why: string[]) => ({ verdict: 'REVIEW' as const, reasons: why, suggestedName: '' });
  if (reason !== 'NO_MASTER_MATCH') return review('REASON_NEEDS_HUMAN');
  if (!decomposed || !decomposed.model) return review('NO_DECOMPOSITION');
  if (!decomposed.code) return review('NO_DEVELOPMENT_CODE');
  const why: string[] = [];
  if (VARIANT_WORDS.test(decomposed.model) || VARIANT_WORDS.test(decomposed.powertrain)) why.push('VARIANT_WORD_RULE_15_16_18');
  if (QUALIFIER_WORDS.test(decomposed.model) || QUALIFIER_WORDS.test(decomposed.code)) why.push('QUALIFIER_WORD_RULE_2_3_14');
  const family = masters.filter(m => keyOf(m.maker) === keyOf(decomposed.maker) && (keyOf(m.model) === keyOf(decomposed.model) || m.model_aliases.some(a => keyOf(a) === keyOf(decomposed.model))));
  if (!family.length) why.push('MAKER_OR_MODEL_NOT_IN_MASTER');
  if (family.some(m => OLD_MAKER_SPELLINGS.has(m.maker.trim()))) why.push('MAKER_SPELLING_PENDING_RENAME');
  if (family.some(m => generationCode(m.sub_model).toUpperCase() === decomposed.code.toUpperCase())) why.push('CODE_ALREADY_IN_MASTER_ALIAS_OR_NAME_ISSUE');
  if (why.length) return { verdict: 'REVIEW', reasons: why, suggestedName: '' };
  return { verdict: 'RULE_CLEAR', reasons: ['NEW_CODE_IN_KNOWN_MODEL_RULE_1'], suggestedName: `${decomposed.model.trim()} ${decomposed.code.trim()}` };
}

const REASONS = new Set(['NO_MASTER_MATCH', 'AMBIGUOUS_TRIM', 'VARIANT_MISMATCH', 'NO_TRIM_MATCH', 'AMBIGUOUS_MASTER', 'GENERATION_EVIDENCE_MISSING',
  'GENERATION_QUALIFIER_MISMATCH', 'TRIM_CONFLICT_EXISTING']);

export function proposalFor(reason: string, decomposed: CandidateRow['decomposed'], candidates: string[]): string {
  const names = candidates.slice(0, 5).join(' | ');
  switch (reason) {
    case 'NO_MASTER_MATCH':
      return decomposed && decomposed.model
        ? `세부모델 추가 후보(미확정): 제조사=${decomposed.maker} 모델=${decomposed.model}${decomposed.code ? ` 코드=${decomposed.code} → 규칙 1·3·14 적용 이름은 마스터 세션이 정함` : ' (코드 없음 — 개발코드 근거 확인 필요)'}; 근거 엔카·다나와 필요`
        : '원문만 있어 분해 불가 — 엔카·다나와 근거로 제조사·모델·세부모델 조사 필요(지어내지 않음)';
    case 'AMBIGUOUS_TRIM':
      return `세부트림 후보 ${candidates.length}개 중 하나를 고르거나 별칭(규칙 20, 하나로만 이어질 때) 지정: ${names}`;
    case 'VARIANT_MISMATCH':
      return `변형(하이브리드·전기 등) 세부모델 행이 마스터에 없음 — 규칙 15·16·18 로 «모델 변형 코드» 행 추가 후보(근거 확인 필요); 가장 가까운 기존 행: ${names || '없음'}`;
    case 'NO_TRIM_MATCH':
      return '세부모델은 맞고 세부트림이 마스터에 없음/원문에 등급 없음 — 등급 이름 근거 확인 후 세부트림 추가 또는 «기본형»(규칙 3·5)';
    case 'AMBIGUOUS_MASTER':
      return `세부모델 후보가 둘 이상: ${names} — 하나로 정하거나 별칭(규칙 20)`;
    case 'GENERATION_EVIDENCE_MISSING':
    case 'GENERATION_QUALIFIER_MISMATCH':
      return `세대 근거 부족/불일치 — 원문 코드·연식 근거 확인 필요(마스터 후보: ${names || '없음'})`;
    case 'TRIM_CONFLICT_EXISTING':
      return `기존 세부트림과 충돌(덮어쓰지 않음) — 사람 확인: 후보 ${names}`;
    default:
      return '검토';
  }
}

export function buildMasterAdditionCandidates(products: readonly CandidateProduct[], masters: readonly IdentityMaster[]) {
  const result = buildIdentityPromotionPlan(products, masters);
  const byId = new Map(products.map(p => [p.id, p]));
  const groups = new Map<string, { row: CandidateRow; years: number[]; plates: Set<string> }>();
  const reasonCounts: Record<string, number> = {}, excludedReasons: Record<string, number> = {};
  for (const hold of result.held) {
    if (!REASONS.has(hold.reason)) { excludedReasons[hold.reason] = (excludedReasons[hold.reason] ?? 0) + 1; continue; }
    const p = byId.get(hold.id);
    if (!p) { excludedReasons.PRODUCT_NOT_IN_INPUT = (excludedReasons.PRODUCT_NOT_IN_INPUT ?? 0) + 1; continue; }
    reasonCounts[hold.reason] = (reasonCounts[hold.reason] ?? 0) + 1;
    const supplier = p.supplier ?? '';
    const rawName = (p.rawName || p.sub_model || '').trim();
    const key = [supplier, hold.reason, normName(maskSensitive(rawName))].join('\u0000');
    let g = groups.get(key);
    if (!g) {
      const decomposedRaw = supplier === 'RP012' ? decomposeSonogongName(maskSensitive(rawName)) : null;
      const decomposed = decomposedRaw ? { maker: decomposedRaw.maker, model: decomposedRaw.model, code: decomposedRaw.code, powertrain: decomposedRaw.powertrain } : null;
      const candidates = hold.candidates.map(maskSensitive);
      g = { row: { supplier, reason: hold.reason, count: 0, rawName: maskSensitive(rawName), decomposed, yearRange: '', plate4Samples: [], masterCandidates: candidates,
        proposal: proposalFor(hold.reason, decomposed, candidates), ...(() => {
          const c = hold.reason === 'VARIANT_MISMATCH'
            ? classifyVariantCandidate(`${p.rawName} ${p.sub_model}`, (p as { fuel?: string }).fuel ?? '', masters.find(m => m.sub_model === hold.candidates[0]), masters)
            : classifyCandidate(hold.reason, decomposed, masters);
          return { verdict: c.verdict, verdictReasons: c.reasons, suggestedName: c.suggestedName };
        })(),
        blankIdentityCount: 0 }, years: [], plates: new Set() };
      groups.set(key, g);
    }
    g.row.count++;
    if (!p.maker.trim() && !p.model.trim()) g.row.blankIdentityCount++;
    if (/^\d{4}$/.test(p.year)) g.years.push(Number(p.year));
    if (g.plates.size < 3 && /^\d{4}$/.test(p.plate4)) g.plates.add(p.plate4);
  }
  const rows = [...groups.values()].map(({ row, years, plates }) => ({ ...row,
    yearRange: years.length ? `${Math.min(...years)}-${Math.max(...years)}` : '', plate4Samples: [...plates].sort() }))
    .sort((a, b) => Number(b.blankIdentityCount > 0) - Number(a.blankIdentityCount > 0) || b.count - a.count || a.supplier.localeCompare(b.supplier) || a.rawName.localeCompare(b.rawName));
  // 합계 일치: heldTotal = Σ reasonCounts(표에 오른 사유) + Σ excludedReasons(허용 목록 밖 사유·입력에 없는 상품).
  return { rows, reasonCounts, excludedReasons, heldTotal: result.held.length, products: products.length };
}

/** 스프레드시트 수식 주입 방어(Codex #678 ①): =, +, -, @, 탭, 줄머리 CR 로 시작하는 문자열은 앞에 작은따옴표를 붙여 수식으로 해석되지 않게 한다. */
export const neutralizeFormula = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const csvCell = (v: string | number) => {
  const s = typeof v === 'number' ? String(v) : neutralizeFormula(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** 승인표 CSV: 마지막 «승인(예/아니오)» 칸은 비워 둔다 — 대표가 채운다. */
export function candidatesToCsv(rows: readonly CandidateRow[]): string {
  const header = ['우선(확인 중)', '판정', '판정근거', '제안이름(RULE_CLEAR만)', '공급사', '보류사유', '대수', '원문차명', '분해_제조사', '분해_모델', '분해_코드', '분해_파워트레인', '연식', '끝4샘플', '마스터후보', '제안(미확정)', '승인(예/아니오)'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.blankIdentityCount > 0 ? `우선(${r.blankIdentityCount})` : '', r.verdict, r.verdictReasons.join(' '), r.suggestedName, r.supplier, r.reason, r.count, r.rawName, r.decomposed?.maker ?? '', r.decomposed?.model ?? '', r.decomposed?.code ?? '', r.decomposed?.powertrain ?? '',
      r.yearRange, r.plate4Samples.join(' '), r.masterCandidates.slice(0, 5).join(' | '), r.proposal, ''].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
