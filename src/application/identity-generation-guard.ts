/** 정체성 매칭의 «세대 구분 근거» 점검(순수, 쓰기 0 — 대표 10-15 지적·커맨드 센터 2026-10-15 승인 R1·R2·R3).
 * 목적: 원문 차명 부분 일치가 «다른 세대»를 고르는 틀린 확정을 막는다(더 적게 확정, 틀린 확정 방지). 이름을 짓지 않고 확정을 «보류로 돌릴 뿐»이다.
 *  R1 수식어 일치: 매칭된 마스터 이름 바로 앞에 원문 수식어(디·올·더·뉴·신형·THE·ALL·NEW)가 더 붙어 있으면 부분 일치로 보지 않는다
 *     (예: «디 올 뉴 그랜저» 안의 «뉴 그랜저»). 마스터에 «더 뉴 …» 이름이 따로 있으면 그 이름이 «통째로» 걸려 이 점검을 통과한다.
 *  R2 형제 세대 연식 근거: 같은 제조사·모델에 개발코드가 다른 세대 행(형제)이 있고 원문에 이 세대의 개발코드·전체 이름이 없으면,
 *     상품 연식이 이 세대 범위 «안에만» 있고 형제 범위와 겹치지 않을 때만 확정한다.
 *  R3 점검 목록: 마스터에서 형제 세대가 있는 모델 목록을 자동으로 도출한다. */

export type GuardMaster = { id: string; maker: string; model: string; sub_model: string; sub_model_aliases: string[]; model_aliases?: string[]; yearFrom: number | null; yearTo: number | null };

const norm = (v: string) => v.normalize('NFKC').replace(/[\s_\-·.,()]/g, '').toUpperCase();
const QUALIFIER_TAIL = /(?:신형|THE|ALL|NEW|디|올|더|뉴)+$/;
const CODE_TAIL = /[A-Z]{1,3}\d[A-Z0-9]*$/;
const LEADING_QUALIFIER = /^(?:신형|THE|ALL|NEW|디|올|더|뉴)+/;
/** 수식어를 뗀 «기본 이름»(개발코드도 뗌): 변형(하이브리드 등)은 기본 이름이 다르고, 부분변경은 기본 이름이 같고 앞 수식어만 다르다. */
const baseOf = (subModel: string) => norm(subModel).replace(LEADING_QUALIFIER, '').replace(CODE_TAIL, '');
/** 이름 후보: 이름·별칭, 그리고 개발코드를 뗀 변형(원문에 코드가 없어도 «더 뉴 팰리세이드» 처럼 수식어째로 걸리게). */
const nameList = (m: GuardMaster) => [...new Set([m.sub_model, ...m.sub_model_aliases].map(norm).flatMap(n => [n, n.replace(CODE_TAIL, '')]).filter(n => n.length >= 3))];
/** 마스터 세부모델 이름 끝의 개발코드(예: «그랜저 GN7» → GN7). 없으면 ''. */
export const generationCode = (subModel: string): string => CODE_TAIL.exec(norm(subModel))?.[0] ?? '';

/** 원문(구분자 유지)에서 영숫자 토큰 경계로 코드가 있는가: 앞뒤가 영문·숫자가 아니어야 한다(GN7 은 «GN70»·«XGN7» 이 아니다). */
function containsToken(rawName: string, token: string): boolean {
  const text = rawName.normalize('NFKC').toUpperCase();
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    const before = at > 0 ? text[at - 1]! : '', after = text[at + token.length] ?? '';
    if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) return true;
  }
  return false;
}

export type GenerationGuardReason ='GENERATION_QUALIFIER_MISMATCH' | 'GENERATION_EVIDENCE_MISSING';
const inRange = (m: GuardMaster, year: number) => (m.yearFrom === null || year >= m.yearFrom) && (m.yearTo === null || year <= m.yearTo);

/** 마스터 하나가 원문 차명의 근거로 충분한가. null = 통과, 아니면 보류 사유. rawPath = 원문 부분 일치로 고른 경우(이름을 정확히 대조한 경우는 점검 대상이 아니다). */
export function generationGuard(input: { rawName: string; year: string; master: GuardMaster; masters: readonly GuardMaster[] }): GenerationGuardReason | null {
  const raw = norm(input.rawName);
  const { master } = input;
  // R1: 원문에서 가장 긴 매칭 이름의 모든 출현이 앞 수식어를 더 달고 있으면 부분 일치.
  const names = nameList(master).filter(n => raw.includes(n)).sort((a, b) => b.length - a.length);
  if (names.length) {
    const name = names[0]!;
    let cleanOccurrence = false;
    for (let at = raw.indexOf(name); at >= 0; at = raw.indexOf(name, at + 1)) {
      const before = raw.slice(0, at);
      if (!QUALIFIER_TAIL.test(before)) { cleanOccurrence = true; break; }
    }
    if (!cleanOccurrence) return 'GENERATION_QUALIFIER_MISMATCH';
  }
  // R2: 개발코드가 다른 형제 세대가 있을 때만.
  const code = generationCode(master.sub_model);
  // 형제 세대 = 같은 제조사·모델의 다른 마스터 중 (개발코드가 다르거나) (코드가 같아도 기본 이름이 같고 앞 수식어만 다른 부분변경). 하이브리드 같은 변형은 형제가 아니다.
  const baseName = baseOf(master.sub_model);
  const siblings = input.masters.filter(m => m.id !== master.id && norm(m.maker) === norm(master.maker) && norm(m.model) === norm(master.model)
    && (generationCode(m.sub_model) !== code || (baseOf(m.sub_model) === baseName && norm(m.sub_model) !== norm(master.sub_model))));
  if (!siblings.length) return null;
  // 세대 근거는 «하나»면 된다(Codex #663): ① 형제와 겹치지 않는 개발코드가 원문에 «토큰 경계로» 있다(그랜저 GN7 근거가 «그랜저 GN70» 이면 안 됨)
  // ② 이 세대만의 앞 수식어가 이름째로 원문에 있다(«더 뉴 …», 형제 이름에는 없음) ③ 연식이 이 세대 범위 안에만 있고 형제 범위와 겹치지 않는다.
  // 마스터 이름이 원문에 «포함»된다는 것만으로는 근거가 아니다(코드 없는 이름 «그랜저»는 형제 세대에도 들어맞는다). 코드를 형제와 공유하면 코드만으로는 구분되지 않는다.
  const codeShared = code !== '' && siblings.some(s => generationCode(s.sub_model) === code);
  if (code !== '' && !codeShared && containsToken(input.rawName, code)) return null;
  const leading = LEADING_QUALIFIER.exec(norm(master.sub_model))?.[0] ?? '';
  const siblingLeadings = siblings.map(s => LEADING_QUALIFIER.exec(norm(s.sub_model))?.[0] ?? '');
  if (leading !== '' && siblingLeadings.every(l => l !== leading) && raw.includes(norm(master.sub_model).replace(CODE_TAIL, ''))) return null;
  const year = /^\d{4}$/.test(input.year) ? Number(input.year) : null;
  if (year !== null && inRange(master, year) && siblings.every(s => !inRange(s, year))) return null;
  return 'GENERATION_EVIDENCE_MISSING';
}

/** R3: 형제 세대(개발코드가 다른 같은 제조사·모델 마스터)가 있는 모델 목록. 사람이 목록을 만들지 않는다 — 마스터에서 도출한다. */
export type GenerationFamily = { maker: string; model: string; generations: Array<{ id: string; sub_model: string; code: string; yearFrom: number | null; yearTo: number | null }> };
export function generationFamilies(masters: readonly GuardMaster[]): GenerationFamily[] {
  const groups = new Map<string, GuardMaster[]>();
  for (const m of masters) {
    const key = `${norm(m.maker)}|${norm(m.model)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
  }
  const out: GenerationFamily[] = [];
  for (const group of groups.values()) {
    // 세대 형제: 개발코드가 다르거나, 코드가 같아도 기본 이름이 같고 앞 수식어만 다른 부분변경 쌍이 하나라도 있는 모델.
    const sibling = group.some((a, i) => group.slice(i + 1).some(b => generationCode(a.sub_model) !== generationCode(b.sub_model)
      || (baseOf(a.sub_model) === baseOf(b.sub_model) && norm(a.sub_model) !== norm(b.sub_model))));
    if (!sibling) continue;
    out.push({ maker: group[0]!.maker, model: group[0]!.model,
      generations: group.map(m => ({ id: m.id, sub_model: m.sub_model, code: generationCode(m.sub_model), yearFrom: m.yearFrom, yearTo: m.yearTo }))
        .sort((a, b) => (a.yearFrom ?? 0) - (b.yearFrom ?? 0) || a.id.localeCompare(b.id)) });
  }
  return out.sort((a, b) => `${a.maker}${a.model}`.localeCompare(`${b.maker}${b.model}`));
}

/** 별칭 «후보»(규칙 20: 마스터 별칭은 조건 없이 하나로 이어질 때만 — 사람이 승인하며 코드에 박지 않는다). 보류 상품의 원문을 마스터 후보에 잇는 제안이다. */
export type AliasCandidate = { rawName: string; count: number; reason: GenerationGuardReason; targets: string[]; unique: boolean };
export function aliasCandidates(held: ReadonlyArray<{ rawName: string; year: string; reason: GenerationGuardReason; master: GuardMaster }>, masters: readonly GuardMaster[]): AliasCandidate[] {
  const grouped = new Map<string, AliasCandidate & { key: string }>();
  for (const h of held) {
    const year = /^\d{4}$/.test(h.year) ? Number(h.year) : null;
    const family = masters.filter(m => norm(m.maker) === norm(h.master.maker) && norm(m.model) === norm(h.master.model));
    const byYear = year === null ? [] : family.filter(m => inRange(m, year));
    const targets = [...new Set(byYear.map(m => m.sub_model))].sort();
    const key = `${norm(h.rawName)}|${h.reason}|${targets.join('/')}`;
    const row = grouped.get(key) ?? { key, rawName: h.rawName, count: 0, reason: h.reason, targets, unique: targets.length === 1 };
    row.count++;
    grouped.set(key, row);
  }
  return [...grouped.values()].map(({ key: _key, ...rest }) => rest).sort((a, b) => b.count - a.count || a.rawName.localeCompare(b.rawName));
}
