/** 정체성 매칭의 «세대 구분 근거» 점검(순수, 쓰기 0 — 대표 10-15 지적·커맨드 센터 2026-10-15 승인 R1·R2·R3).
 * 목적: 원문 차명 부분 일치가 «다른 세대»를 고르는 틀린 확정을 막는다(더 적게 확정, 틀린 확정 방지). 이름을 짓지 않고 확정을 «보류로 돌릴 뿐»이다.
 *  R1 수식어 일치: 매칭된 마스터 이름 바로 앞에 원문 수식어(디·올·더·뉴·신형·THE·ALL·NEW)가 더 붙어 있으면 부분 일치로 보지 않는다
 *     (예: «디 올 뉴 그랜저» 안의 «뉴 그랜저»). 마스터에 «더 뉴 …» 이름이 따로 있으면 그 이름이 «통째로» 걸려 이 점검을 통과한다.
 *  R2 형제 세대 연식 근거: 같은 제조사·모델에 개발코드가 다른 세대 행(형제)이 있고 원문에 이 세대의 개발코드·전체 이름이 없으면,
 *     상품 연식이 이 세대 범위 «안에만» 있고 형제 범위와 겹치지 않을 때만 확정한다.
 *  R3 점검 목록: 마스터에서 형제 세대가 있는 모델 목록을 자동으로 도출한다. */

export type GuardMaster = { id: string; maker: string; model: string; sub_model: string; sub_model_aliases: string[]; model_aliases?: string[]; yearFrom: number | null; yearTo: number | null };

const norm = (v: string) => v.normalize('NFKC').replace(/[\s_\-·.,()[\]/]/g, '').toUpperCase();
const QUALIFIER_TAIL = /(?:신형|THE|ALL|NEW|디|올|더|뉴)+$/;
/** 개발코드: 이름 «마지막 낱말»이 영문 1~3자+숫자…(GN7·LX2·MQ4) 또는 영문 2~3자(HG·IG·TG·DG)일 때. 파워트레인·등급 약어(EV·HEV·LPI·GDI·GT …)는 코드가 아니다.
 * 원래 표기(공백 유지)의 낱말 경계로 판정한다 — 공백을 지운 문자열에서는 «K5 LPI» 가 «K5LPI» 라는 하나의 코드처럼 보인다. */
const DIGIT_CODE = /^[A-Z]{1,3}\d[A-Z0-9]*$/;
const LETTER_CODE = /^[A-Z]{2,3}$/;
const NON_CODE_WORDS: ReadonlySet<string> = new Set(['EV', 'HEV', 'PHEV', 'MHEV', 'FHEV', 'LPG', 'LPI', 'GDI', 'TDI', 'TSI', 'TFSI', 'TGDI', 'GT', 'AMG', 'RS', 'SE', 'XL', 'LE', 'ST']);
const splitCode = (original: string): { base: string; code: string } => {
  const whole = norm(original);
  // 괄호·대괄호·슬래시·쉼표·하이픈도 낱말 구분으로 본다(«그랜저(HG)»·«그랜저 [IG]» — 기준 한 장은 괄호 없음이 원칙이나 마스터·별칭·원문에는 있다, Codex #663 3차).
  const tokens = original.normalize('NFKC').trim().toUpperCase().split(/[\s()[\]/,\-]+/).filter(Boolean);
  const last = (tokens[tokens.length - 1] ?? '').replace(/^[([-]+|[)\]\-.,]+$/g, '');
  let code = '';
  if (DIGIT_CODE.test(last)) code = last;
  else if (tokens.length > 1 && LETTER_CODE.test(last) && !NON_CODE_WORDS.has(last)) code = last;
  else if (/[가-힣]/.test(last)) {   // 한글에 붙어 쓴 코드(«그랜저GN7»)
    const m = /[A-Z]{1,3}\d[A-Z0-9]*$/.exec(last);
    if (m) code = m[0];
  }
  if (!code || !whole.endsWith(code)) return { base: whole, code: '' };
  return { base: whole.slice(0, whole.length - code.length), code };
};
const LEADING_QUALIFIER = /^(?:신형|THE|ALL|NEW|디|올|더|뉴)+/;
/** 수식어를 뗀 «기본 이름»(개발코드도 뗌): 변형(하이브리드 등)은 기본 이름이 다르고, 부분변경은 기본 이름이 같고 앞 수식어만 다르다. */
const baseOf = (subModel: string) => splitCode(subModel).base.replace(LEADING_QUALIFIER, '');
/** 이름 후보: 이름·별칭, 그리고 개발코드를 뗀 변형(원문에 코드가 없어도 «더 뉴 팰리세이드» 처럼 수식어째로 걸리게). */
const nameList = (m: GuardMaster) => [...new Set([m.sub_model, ...m.sub_model_aliases].flatMap(n => [norm(n), splitCode(n).base]).filter(n => n.length >= 3))];
/** 마스터 세부모델 이름 끝의 개발코드(예: «그랜저 GN7» → GN7). 없으면 ''. */
export const generationCode = (subModel: string): string => splitCode(subModel).code;

/** 원문(구분자 유지)에서 영숫자 토큰 경계로 코드가 있는가: 앞뒤가 영문·숫자가 아니어야 한다(GN7 은 «GN70»·«XGN7» 이 아니다). */
function containsToken(rawName: string, token: string): boolean {
  const text = rawName.normalize('NFKC').toUpperCase();
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    const before = at > 0 ? text[at - 1]! : '', after = text[at + token.length] ?? '';
    if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) return true;
  }
  return false;
}

/** 정규화 원문의 at 자리 출현이 «앞 수식어 없이» 걸렸는가. 앞에 수식어가 붙어 있어도, 같은 마스터의 등록 이름(registered) 중 하나가 그 수식어 자리에서
 * 시작해 이 출현까지 이어지면(수식어가 등록 이름의 일부) 깨끗한 출현이다. 등록 이름 자신의 앞은 수식어 꼬리가 아니다(QUALIFIER_TAIL 은 꼬리 전체를 잡는다). */
function cleanAt(raw: string, at: number, registered: readonly string[]): boolean {
  const before = raw.slice(0, at);
  const tail = QUALIFIER_TAIL.exec(before)?.[0];
  if (!tail) return true;
  const start = at - tail.length;
  return registered.some(n => n.length > tail.length && raw.startsWith(n, start) && start + n.length > at);
}

export type GenerationGuardReason = 'GENERATION_QUALIFIER_MISMATCH' | 'GENERATION_EVIDENCE_MISSING' | 'GENERATION_CODE_CONFLICT';
const inRange = (m: GuardMaster, year: number) => (m.yearFrom === null || year >= m.yearFrom) && (m.yearTo === null || year <= m.yearTo);

/** 마스터 하나가 원문 차명의 근거로 충분한가. null = 통과, 아니면 보류 사유. rawPath = 원문 부분 일치로 고른 경우(이름을 정확히 대조한 경우는 점검 대상이 아니다). */
export function generationGuard(input: { rawName: string; year: string; master: GuardMaster; masters: readonly GuardMaster[] }): GenerationGuardReason | null {
  const raw = norm(input.rawName);
  const { master } = input;
  // R1: 원문에서 가장 긴 매칭 이름의 모든 출현이 앞 수식어를 더 달고 있으면 부분 일치.
  // 단, 그 앞 수식어가 «이 마스터의 등록 이름(별칭)»에 들어 있어 같은 자리에서 수식어째로 걸리면 수식어 불일치가 아니다
  // (2026-10-28: 원문 «신형 K5(DL3)» — «신형 K5» 는 K5 DL3 의 등록 별칭인데 «K5DL3» 앞 «신형»을 다른 세대 수식어로 보고 보류했다).
  const names = nameList(master).filter(n => raw.includes(n)).sort((a, b) => b.length - a.length);
  if (names.length) {
    const name = names[0]!;
    let cleanOccurrence = false;
    for (let at = raw.indexOf(name); at >= 0; at = raw.indexOf(name, at + 1)) {
      if (cleanAt(raw, at, names)) { cleanOccurrence = true; break; }
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
  // 상충·유사 코드(Codex #663 재검토 B): 원문에 형제 세대의 코드(자기 코드와 다른 것)가 있거나, 어떤 코드와 «접두 관계»인 다른 토큰(GN70 ↔ GN7)이 있으면
  // 연식으로 구제하지 않고 보류한다.
  const siblingCodes = [...new Set(siblings.map(s => generationCode(s.sub_model)).filter(c => c !== ''))];
  const knownCodes = [...new Set([code, ...siblingCodes].filter(c => c !== ''))];
  for (const token of new Set(input.rawName.normalize('NFKC').toUpperCase().split(/[^A-Z0-9]+/).filter(t => t.length >= 2))) {
    if (token === code) continue;
    if (siblingCodes.includes(token)) return 'GENERATION_CODE_CONFLICT';
    if (knownCodes.some(c => token.startsWith(c) || c.startsWith(token))) return 'GENERATION_CODE_CONFLICT';
  }
  const codeShared = code !== '' && siblings.some(s => generationCode(s.sub_model) === code);
  if (code !== '' && !codeShared && containsToken(input.rawName, code)) return null;
  const leading = LEADING_QUALIFIER.exec(norm(master.sub_model))?.[0] ?? '';
  const siblingLeadings = siblings.map(s => LEADING_QUALIFIER.exec(norm(s.sub_model))?.[0] ?? '');
  if (leading !== '' && siblingLeadings.every(l => l !== leading) && raw.includes(splitCode(master.sub_model).base)) return null;
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
