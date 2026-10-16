/** «정규화 후보»(박대표 2026-10-16 «못 집어넣는 건 매칭 쪽 문제», B3Q #708 재분류 36대): 엄격 매칭(마스터 세부모델 이름 전체가 원문에 통째로 있어야 함)이 놓치는
 * 원문 표기(접두 «신형/더 뉴/디 올뉴/올뉴», 개발코드·N세대 표기 없음, 붙여 쓴 «신형K5», 짧은 모델 이름 «K5»·«K8», 밑줄 구분)를 느슨하게 정규화해
 * 마스터 세부모델 «후보»를 찾는다. 이 모듈은 **후보만** 낸다 — 확정(MATCH)이 아니다. 정밀도 측정(golden set) 전에는 보류 사유(NORMALIZED_CANDIDATE)로만 쓰인다.
 * 이름을 만들지 않고, 후보는 마스터에 있는 세부모델만이다. 후보가 «정확히 하나»일 때만 낸다(0·여럿은 null). */
import type { IdentityMaster } from './identity-promotion-plan.js';

const squash = (v: string): string => v.normalize('NFKC').toLowerCase().replace(/[\s_/,·\-]+/g, '');
const PREFIX_GLUED = /^(신형|구형|디올뉴|더올뉴|더뉴|올뉴|뉴)(?=[가-힣a-z0-9])/;
const PREFIX_WORDS = /(^|[\s_(])(신형|구형|더\s?뉴|디\s?올\s?뉴|더\s?올\s?뉴|올\s?뉴|뉴)(?=[가-힣A-Za-z0-9])/g;
const stripPrefixWords = (v: string): string => { let out = v.normalize('NFKC'); for (let i = 0; i < 3; i++) out = out.replace(PREFIX_WORDS, '$1'); return out; };
// 원문 핵심어: 접두·괄호(코드)·N세대 표기를 뗀다. 영숫자 낱말(K5·K8)은 모델 이름일 수 있어 지우지 않는다.
const coreOf = (v: string): string => squash(stripPrefixWords(v).replace(/\([^)]*\)/g, ' ').replace(/\d+\s?세대/g, ' '));
const masterCoreOf = (v: string): string => coreOf(v.normalize('NFKC').replace(/\s[A-Z]{2,4}\d{0,2}[A-Z]?\s*$/, ''));
/** 원문 낱말(영숫자·한글 단위). 접두가 글자에 붙은 «신형K5» 는 접두를 뗀 낱말도 함께 둔다. */
const tokensOf = (raw: string): string[] => {
  const out = new Set<string>();
  for (const t of raw.normalize('NFKC').toLowerCase().split(/[^0-9a-z가-힣]+/u).filter(Boolean)) {
    out.add(t);
    const stripped = t.replace(PREFIX_GLUED, '');
    if (stripped && stripped !== t) out.add(stripped);
  }
  return [...out];
};
const isShortModelName = (core: string): boolean => core.length >= 2 && core.length <= 3 && /^[a-z0-9]+$/.test(core);

export type NormalizedCandidate = { master: IdentityMaster; via: '핵심어+연식' | '핵심어' | '짧은 이름 낱말+연식' | '짧은 이름 낱말' };

/** 정확히 하나의 마스터 후보일 때만 돌려준다. maker 가 있으면 제조사 일치를 제약으로 둔다(정규화된 같은 표기). */
export function normalizedMasterCandidate(input: { rawName: string; year: string; maker?: string; fuel?: string }, masters: readonly IdentityMaster[]): NormalizedCandidate | null {
  const raw = input.rawName.trim();
  if (!raw) return null;
  const rawCore = coreOf(raw), tokens = tokensOf(raw);
  const makerKey = input.maker?.trim() ? squash(input.maker) : '';
  const hits: Array<{ m: IdentityMaster; short: boolean }> = [];
  for (const m of masters) {
    if (makerKey && squash(m.maker) !== makerKey) continue;
    const subCores = [m.sub_model, ...m.sub_model_aliases].map(masterCoreOf).filter(Boolean);
    const longMatch = subCores.some(c => c.length >= 3 && !isShortModelName(c) && rawCore.includes(c));
    const shortMatch = subCores.some(c => isShortModelName(c) && tokens.includes(c));   // «K5»·«K8» 는 낱말 경계로만(K50·K5X 와 섞이지 않게)
    if (longMatch || shortMatch) hits.push({ m, short: !longMatch });
  }
  if (!hits.length) return null;
  // 변형 낱말(하이브리드·EV·PHEV) 충돌 방지: 원문에 변형 낱말이 있으면 변형이 이름에 있는 후보만, 없으면 변형 후보를 뺀다.
  const variant = (t: string): string => (/플러그인|phev/.test(t) ? 'P' : /하이브리드|hev|hybrid/.test(t) ? 'H' : /일렉트릭|electric|(?<![a-z])ev(?![a-z])|전기차/.test(t) ? 'E' : '');
  // 연료 칸(제원)도 변형 근거다: 원문이 파워트레인을 안 적어도 연료가 하이브리드·전기면 일반 후보로 흡수하지 않는다.
  const rawVariant = variant(`${raw} ${input.fuel ?? ''}`.normalize('NFKC').toLowerCase());
  const filtered = hits.filter(h => variant([h.m.sub_model, ...h.m.sub_model_aliases].join(' ').normalize('NFKC').toLowerCase()) === rawVariant);
  let pool = filtered.length ? filtered : [];
  if (!pool.length) return null;
  // 더 긴 핵심어가 더 구체적(예: «아반떼 하이브리드» > «아반떼») — 긴 일치만 남긴다.
  const score = (h: { m: IdentityMaster }) => Math.max(...[h.m.sub_model, ...h.m.sub_model_aliases].map(masterCoreOf).filter(c => c && (rawCore.includes(c) || tokens.includes(c))).map(c => c.length), 0);
  const best = Math.max(...pool.map(score));
  pool = pool.filter(h => score(h) === best);
  const year = /^\d{4}$/.test(input.year) ? Number(input.year) : null;
  let via: NormalizedCandidate['via'];
  // 연식 검증은 후보 수와 무관하게 한다(Codex #712 ①): 연식이 범위 밖이면 후보가 하나여도 내지 않는다. 연식이 없을 때는 후보에 연식 범위가 있으면
  // (세대 구분이 있는 모델) 검증할 수 없으므로 내지 않고, 범위가 없는(단일 세대) 후보만 통과한다.
  const inYear = (m: IdentityMaster): boolean => year !== null
    ? (m.yearFrom === null || year >= m.yearFrom) && (m.yearTo === null || year <= m.yearTo)
    : m.yearFrom === null && m.yearTo === null;
  if (pool.length > 1) {
    const inRange = pool.filter(h => inYear(h.m));
    if (inRange.length === 1) pool = inRange;
    else return null;
  }
  if (pool.length !== 1) return null;
  const hit = pool[0]!;
  if (!inYear(hit.m)) return null;
  // 원문에 명시된 N세대: 마스터에 명시적 세대 번호 메타데이터가 없으므로 «검증 불가»다 → 후보를 내지 않는다(NO_MASTER_MATCH 유지, 세대 증거 보존, Codex #712 ④).
  // 마스터 순서(시작 연도순)로 세대 번호를 추정하지 않는다: 옛 세대가 마스터에 빠져 있으면 순번이 우연히 맞아도 실제 세대가 아니다. 한계: N세대가 적힌 원문은
  // 마스터에 세대 번호 칸이 생기기 전까지(대표 소관) 정규화 후보에서 빠지고 마스터 추가·수동 확인 경로에 남는다.
  if (/\d+\s?세대/.test(raw.normalize('NFKC'))) return null;
  // 원문에 개발코드(괄호 코드·영문 2~4자+숫자)가 있는데 후보 이름에 그 코드가 없으면 후보로 내지 않는다: «아반떼(CN8)» 처럼 마스터에 없는 새 세대를
  // 기존 세대로 잘못 묶어 «마스터 추가 후보» 목록에서 가리지 않게 한다(NO_MASTER_MATCH 유지). 코드가 이름의 일부(GV70·K5)면 통과한다.
  const nameTokens = new Set([hit.m.sub_model, ...hit.m.sub_model_aliases].flatMap(n => n.normalize('NFKC').toUpperCase().split(/[^0-9A-Z]+/u).filter(Boolean)));
  const rawNfkc = raw.normalize('NFKC');
  // 후보 이름의 트림 낱말(GT·LX 등)과 연료·구동 사양 낱말은 개발코드가 아니다. 숫자 없는 대문자 낱말(ZZ)도 코드로 본다(Codex #712 ③) — 괄호 안·밖 판정은 같다.
  const nonCode = new Set(['LPG', 'LPI', 'SUV', 'RV', 'EV', 'HEV', 'PHEV', 'BEV', 'FCEV', 'GDI', 'MPI', 'TCI', 'TGDI', 'CRDI', 'VGT', 'AWD', 'FWD', 'RWD', 'AT', 'MT', 'DCT', 'CVT', 'TOP', 'PE',
    ...hit.m.trims.flatMap(t => [t.name, ...t.aliases]).flatMap(n => n.normalize('NFKC').toUpperCase().split(/[^0-9A-Z]+/u).filter(Boolean))]);
  const codeLike = [
    ...[...rawNfkc.toUpperCase().matchAll(/\(([A-Z]{1,4}\d{0,2}[A-Z]?)\)/gu)].map(m => m[1]!),
    ...[...rawNfkc.toUpperCase().matchAll(/(?<![0-9A-Z])([A-Z]{2,4}\d{1,2}[A-Z]?)(?![0-9A-Z])/gu)].map(m => m[1]!),
    ...[...rawNfkc.matchAll(/(?<![0-9A-Za-z])([A-Z]{2,4})(?![0-9A-Za-z])/gu)].map(m => m[1]!),
  ];
  for (const code of codeLike) if (!nameTokens.has(code) && !nonCode.has(code)) return null;
  via = hits.length > 1 || year !== null ? (hit.short ? '짧은 이름 낱말+연식' : '핵심어+연식') : (hit.short ? '짧은 이름 낱말' : '핵심어');
  return { master: hit.m, via };
}
