/** «정규화 후보»(박대표 2026-10-16 «못 집어넣는 건 매칭 쪽 문제», B3Q #708 재분류 36대): 엄격 매칭(마스터 세부모델 이름 전체가 원문에 통째로 있어야 함)이 놓치는
 * 원문 표기(접두 «신형/더 뉴/디 올뉴/올뉴», 개발코드·N세대 표기 없음, 붙여 쓴 «신형K5», 짧은 모델 이름 «K5»·«K8», 밑줄 구분)를 느슨하게 정규화해
 * 마스터 세부모델 «후보»를 찾는다. 이 모듈은 **후보만** 낸다 — 확정(MATCH)이 아니다. 정밀도 측정(golden set) 전에는 보류 사유(NORMALIZED_CANDIDATE)로만 쓰인다.
 * 이름을 만들지 않고, 후보는 마스터에 있는 세부모델만이다. 후보가 «정확히 하나»일 때만 낸다(0·여럿은 null). */
import type { IdentityMaster } from './identity-promotion-plan.js';

const squash = (v: string): string => v.normalize('NFKC').toLowerCase().replace(/[\s_/,·\-]+/g, '');
const PREFIX_GLUED = /^(신형|구형|디올뉴|더올뉴|더뉴|올뉴|뉴)(?=[가-힣a-z0-9])/;
const PREFIX_WORDS = /(^|[\s_(])(신형|구형|더\s?뉴|디\s?올\s?뉴|더\s?올\s?뉴|올\s?뉴|뉴)(?=[가-힣A-Za-z0-9])/g;
const stripPrefixWords = (v: string): string => { let out = v.normalize('NFKC'); for (let i = 0; i < 3; i++) out = out.replace(PREFIX_WORDS, '$1'); return out; };
/** 개발코드(영문 1~3자 + 숫자 1~2자 + 영문 1자 선택, 또는 끝의 대문자 2~4자)와 세대 표기를 뗀 핵심어. */
const CODE = /(?<![A-Za-z0-9])([A-Za-z]{1,3}\d{1,2}[A-Za-z]?)(?![A-Za-z0-9])/g;
const coreOf = (v: string): string => squash(stripPrefixWords(v).replace(/\([^)]*\)/g, ' ').replace(CODE, ' ').replace(/\d+\s?세대/g, ' '));
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
export function normalizedMasterCandidate(input: { rawName: string; year: string; maker?: string }, masters: readonly IdentityMaster[]): NormalizedCandidate | null {
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
  const rawVariant = variant(raw.normalize('NFKC').toLowerCase());
  const filtered = hits.filter(h => variant([h.m.sub_model, ...h.m.sub_model_aliases].join(' ').normalize('NFKC').toLowerCase()) === rawVariant);
  let pool = filtered.length ? filtered : [];
  if (!pool.length) return null;
  // 더 긴 핵심어가 더 구체적(예: «아반떼 하이브리드» > «아반떼») — 긴 일치만 남긴다.
  const score = (h: { m: IdentityMaster }) => Math.max(...[h.m.sub_model, ...h.m.sub_model_aliases].map(masterCoreOf).filter(c => c && (rawCore.includes(c) || tokens.includes(c))).map(c => c.length), 0);
  const best = Math.max(...pool.map(score));
  pool = pool.filter(h => score(h) === best);
  const year = /^\d{4}$/.test(input.year) ? Number(input.year) : null;
  let via: NormalizedCandidate['via'];
  if (pool.length > 1 && year !== null) {
    const inRange = pool.filter(h => (h.m.yearFrom === null || year >= h.m.yearFrom) && (h.m.yearTo === null || year <= h.m.yearTo));
    if (inRange.length === 1) pool = inRange;
    else return null;
  }
  if (pool.length !== 1) return null;
  const hit = pool[0]!;
  via = hits.length > 1 || year !== null ? (hit.short ? '짧은 이름 낱말+연식' : '핵심어+연식') : (hit.short ? '짧은 이름 낱말' : '핵심어');
  return { master: hit.m, via };
}
