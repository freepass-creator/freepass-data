/** 차종 마스터 추가 후보 목록(순수, 읽기 전용 — 쓰기·마스터 변경 없음).
 * 정체성 승격 계획의 «보류» 중 마스터를 보강해야 풀리는 사유(NO_MASTER_MATCH·AMBIGUOUS_TRIM·VARIANT_MISMATCH 등)를 공급사·원문 차명 단위로 묶어
 * 사람이 예/아니오로 결정할 수 있는 표로 만든다. 차종 기준 한 장(ai-ops docs/차종-기준-한장.md)을 따른다: 이름은 지어내지 않고(규칙 8·«마스터에 없는
 * 이름을 만들지 않는다»), 마스터에 넣는 것은 대표만(8절), 우리 차에 필요한 것만(규칙 11). 이 목록의 «제안»은 후보 문구이며 확정이 아니다 —
 * 세부모델 이름(규칙 1·2·3·14·15·18)과 세부트림(규칙 5)은 엔카·다나와 근거로 차종 마스터 세션이 정한다. 전체 차량번호는 없고 끝 4자리만 나온다. */
import { buildIdentityPromotionPlan, type IdentityMaster, type IdentityProduct } from './identity-promotion-plan.js';

export type CandidateProduct = IdentityProduct & { supplier?: string };
export type CandidateRow = {
  supplier: string; reason: string; count: number; rawName: string;
  decomposed: { maker: string; model: string; code: string; powertrain: string } | null;
  yearRange: string; plate4Samples: string[]; masterCandidates: string[]; proposal: string;
};

const normName = (v: string) => v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
/** 손오공 원문 «제조사_모델(코드)_연료 배기량 …» 의 결정적 분해: 밑줄 3분할 + 모델 뒤 괄호 코드. 형식이 아니면 null(추정하지 않는다). */
export function decomposeSonogongName(raw: string): CandidateRow['decomposed'] {
  const parts = raw.normalize('NFKC').split('_').map(s => s.trim());
  if (parts.length < 3 || !parts[0] || !parts[1]) return null;
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(parts[1]!);
  return { maker: parts[0]!, model: (m ? m[1]! : parts[1]!).trim(), code: m ? m[2]!.trim() : '', powertrain: parts.slice(2).join('_').trim() };
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
  const reasonCounts: Record<string, number> = {};
  for (const hold of result.held) {
    if (!REASONS.has(hold.reason)) continue;
    const p = byId.get(hold.id);
    if (!p) continue;
    reasonCounts[hold.reason] = (reasonCounts[hold.reason] ?? 0) + 1;
    const supplier = p.supplier ?? '';
    const rawName = (p.rawName || p.sub_model || '').trim();
    const key = [supplier, hold.reason, normName(rawName)].join('\u0000');
    let g = groups.get(key);
    if (!g) {
      const decomposed = supplier === 'RP012' ? decomposeSonogongName(rawName) : null;
      g = { row: { supplier, reason: hold.reason, count: 0, rawName, decomposed, yearRange: '', plate4Samples: [], masterCandidates: [...hold.candidates],
        proposal: proposalFor(hold.reason, decomposed, hold.candidates) }, years: [], plates: new Set() };
      groups.set(key, g);
    }
    g.row.count++;
    if (/^\d{4}$/.test(p.year)) g.years.push(Number(p.year));
    if (g.plates.size < 3 && /^\d{4}$/.test(p.plate4)) g.plates.add(p.plate4);
  }
  const rows = [...groups.values()].map(({ row, years, plates }) => ({ ...row,
    yearRange: years.length ? `${Math.min(...years)}-${Math.max(...years)}` : '', plate4Samples: [...plates].sort() }))
    .sort((a, b) => b.count - a.count || a.supplier.localeCompare(b.supplier) || a.rawName.localeCompare(b.rawName));
  return { rows, reasonCounts, heldTotal: result.held.length, products: products.length };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** 승인표 CSV: 마지막 «승인(예/아니오)» 칸은 비워 둔다 — 대표가 채운다. */
export function candidatesToCsv(rows: readonly CandidateRow[]): string {
  const header = ['공급사', '보류사유', '대수', '원문차명', '분해_제조사', '분해_모델', '분해_코드', '분해_파워트레인', '연식', '끝4샘플', '마스터후보', '제안(미확정)', '승인(예/아니오)'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.supplier, r.reason, r.count, r.rawName, r.decomposed?.maker ?? '', r.decomposed?.model ?? '', r.decomposed?.code ?? '', r.decomposed?.powertrain ?? '',
      r.yearRange, r.plate4Samples.join(' '), r.masterCandidates.slice(0, 5).join(' | '), r.proposal, ''].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
