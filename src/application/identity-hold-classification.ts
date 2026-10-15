/** 정체성 보류 재분류(읽기 전용·쓰기 0, 박대표 2026-10-16 «5~7년 안쪽 차종 마스터는 다 돼 있다, 못 넣는 건 매칭 문제»를 숫자로 검증):
 * 계획서가 NO_MASTER_MATCH 로 보류한 문서를 «마스터에 해당 모델 행이 있는데 규칙이 못 잡은 것(매칭 실패)» 과 «마스터에 정말 없는 것» 으로 다시 나눈다.
 * 이 모듈은 이름을 만들거나 쓰지 않는다 — 더 느슨한 정규화(접두·괄호·세대·띄어쓰기)로 후보를 «찾아 보기만» 하고 결과를 분류 보고로 낸다. 확정은 별도 규칙·승인 몫. */
import { buildIdentityPromotionPlan, type IdentityMaster, type IdentityProduct } from './identity-promotion-plan.js';

export type HoldClass =
  | 'MATCH_FAILURE_UNIQUE'        // 정규화하면 마스터 세부모델이 «유일»하게 잡힘(규칙 보강으로 풀릴 후보)
  | 'MATCH_FAILURE_AMBIGUOUS'     // 모델은 있고 세부모델(세대) 후보가 여럿 — 연식·세대 순번으로도 하나로 못 줄임
  | 'MODEL_ONLY'                  // 모델 행은 있으나 세대 근거가 없음
  | 'MASTER_MISSING';             // 모델 행도 못 찾음(마스터 보강 후보)
export type YearBucket = 'RECENT_2019_PLUS' | 'OLDER' | 'UNKNOWN';
export type ClassifiedHold = { id: string; plate4: string; reason: string; cls: HoldClass; yearBucket: YearBucket; patterns: string[]; via: string; candidates: string[] };
export type HoldClassificationReport = { total: number; byClass: Record<HoldClass, number>; byClassYear: Record<string, number>; byReasonClass: Record<string, number>;
  patterns: Array<{ pattern: string; count: number; resolved: number }>; held: ClassifiedHold[] };

const squash = (v: string): string => v.normalize('NFKC').toLowerCase().replace(/[\s_/,·\-]+/g, '');
const PREFIX = /(^|[\s_(])(신형|구형|더\s?뉴|디\s?올\s?뉴|더\s?올\s?뉴|올\s?뉴|뉴)(?=[가-힣A-Za-z0-9])/g;
/** 접두(«신형/더 뉴/디 올뉴/올뉴»)를 낱말 앞에서만 떼어 낸다(붙여 쓴 «더뉴싼타페» 포함). */
const stripPrefix = (v: string): string => { let out = v.normalize('NFKC'); for (let i = 0; i < 3; i++) out = out.replace(PREFIX, '$1'); return out; };
const CODE = /(?<![A-Za-z0-9])([A-Za-z]{1,3}\d{1,2}[A-Za-z]?)(?![A-Za-z0-9])/g;
const codesOf = (v: string): string[] => [...v.normalize('NFKC').matchAll(CODE)].map(m => m[1]!.toUpperCase());
const coreOf = (v: string): string => squash(stripPrefix(v).replace(/\([^)]*\)/g, ' ').replace(CODE, ' ').replace(/\d+\s?세대/g, ' '));
const ordinalOf = (v: string): number | null => { const m = /(\d+)\s?세대/.exec(v.normalize('NFKC')); return m ? Number(m[1]) : null; };
const yearBucket = (year: string): YearBucket => (/^\d{4}$/.test(year) ? (Number(year) >= 2019 ? 'RECENT_2019_PLUS' : 'OLDER') : 'UNKNOWN');

function patternsOf(raw: string): string[] {
  const n = raw.normalize('NFKC'), out: string[] = [];
  if (/\([^)]*\)/.test(n)) out.push('괄호·코드');
  if (/\d+\s?세대/.test(n)) out.push('N세대 표기');
  if (/(신형|구형|더\s?뉴|디\s?올\s?뉴|더\s?올\s?뉴|올\s?뉴)/.test(n)) out.push('신형/더뉴/올뉴 접두');
  if (/(더뉴|올뉴|디올뉴)[가-힣]/.test(squash(n))) out.push('붙여쓴 접두');
  if (/하이브리드|HEV|PHEV|플러그인/i.test(n)) out.push('하이브리드 낱말');
  if (/EV|전기|일렉트릭/i.test(n)) out.push('EV 낱말');
  if (/_/.test(n)) out.push('밑줄 구분');
  return out;
}

export function classifyIdentityHolds(products: readonly IdentityProduct[], masters: readonly IdentityMaster[]): HoldClassificationReport {
  const plan = buildIdentityPromotionPlan(products, masters);
  const byId = new Map(products.map(p => [p.id, p]));
  // 마스터 세부모델 이름 끝의 대문자 개발코드(TM·QL·MQ4 …)는 핵심어에서 뗀다(원문에는 코드가 없는 경우가 많다).
  const masterCore = (v: string): string => coreOf(v.normalize('NFKC').replace(/\s[A-Z]{2,4}\d{0,2}[A-Z]?\s*$/, ''));
  const cores = masters.map(m => ({ m, sub: [m.sub_model, ...m.sub_model_aliases].map(masterCore).filter(c => c.length >= 2), model: [m.model, ...m.model_aliases].map(coreOf).filter(c => c.length >= 2),
    codes: new Set([m.sub_model, ...m.sub_model_aliases].flatMap(codesOf)) }));
  const held: ClassifiedHold[] = [];
  for (const h of plan.held) {
    if (h.reason !== 'NO_MASTER_MATCH' && h.reason !== 'AMBIGUOUS_MASTER') continue;   // 나머지 사유는 마스터가 이미 특정됨(트림·변형·세대 판정 단계)
    const p = byId.get(h.id);
    if (!p) continue;
    const raw = p.rawName || p.sub_model;
    const core = coreOf(raw), year = /^\d{4}$/.test(p.year) ? Number(p.year) : null, codes = new Set(codesOf(raw)), ordinal = ordinalOf(raw);
    // 후보 1: 개발코드가 마스터 세부모델 이름 코드와 같고 모델 낱말이 원문에 있음
    let cands = cores.filter(c => c.model.some(n => core.includes(n)) && [...codes].some(code => c.codes.has(code)));
    let via = cands.length ? '개발코드' : '';
    // 후보 2: 접두·괄호·코드·세대를 뗀 세부모델 핵심어가 원문 핵심어에 들어 있음
    if (!cands.length) { cands = cores.filter(c => c.sub.some(n => n.length >= 3 && core.includes(n))); via = cands.length ? '핵심어' : ''; }
    // 모델 행은 있으나 세대 미특정
    const modelRows = cands.length ? cands : cores.filter(c => c.model.some(n => n.length >= 2 && core.includes(n)));
    let cls: HoldClass = 'MASTER_MISSING';
    let chosen = cands;
    if (chosen.length > 1 && year !== null) {
      const inRange = chosen.filter(c => (c.m.yearFrom === null || year >= c.m.yearFrom) && (c.m.yearTo === null || year <= c.m.yearTo));
      if (inRange.length) { chosen = inRange; via += '+연식'; }
    }
    if (chosen.length > 1 && ordinal !== null) {
      const byModel = new Map<string, typeof chosen>();
      for (const c of chosen) byModel.set(`${c.m.maker}|${c.m.model}`, [...(byModel.get(`${c.m.maker}|${c.m.model}`) ?? []), c]);
      if (byModel.size === 1) {
        const ordered = [...chosen].sort((a, b) => (a.m.yearFrom ?? 0) - (b.m.yearFrom ?? 0));
        if (ordinal >= 1 && ordinal <= ordered.length) { chosen = [ordered[ordinal - 1]!]; via += '+세대순번'; }
      }
    }
    if (chosen.length === 1) cls = 'MATCH_FAILURE_UNIQUE';
    else if (chosen.length > 1) cls = 'MATCH_FAILURE_AMBIGUOUS';
    else if (modelRows.length) { cls = 'MODEL_ONLY'; chosen = modelRows; via = '모델 행만'; }
    held.push({ id: p.id, plate4: p.plate4, reason: h.reason, cls, yearBucket: yearBucket(p.year), patterns: patternsOf(raw), via,
      candidates: [...new Set(chosen.map(c => c.m.sub_model))].slice(0, 5) });
  }
  const byClass = { MATCH_FAILURE_UNIQUE: 0, MATCH_FAILURE_AMBIGUOUS: 0, MODEL_ONLY: 0, MASTER_MISSING: 0 } as Record<HoldClass, number>;
  const byClassYear: Record<string, number> = {}, byReasonClass: Record<string, number> = {};
  const patternStats = new Map<string, { count: number; resolved: number }>();
  for (const h of held) {
    byClass[h.cls]++;
    byClassYear[`${h.cls}|${h.yearBucket}`] = (byClassYear[`${h.cls}|${h.yearBucket}`] ?? 0) + 1;
    byReasonClass[`${h.reason}|${h.cls}`] = (byReasonClass[`${h.reason}|${h.cls}`] ?? 0) + 1;
    for (const pattern of h.patterns.length ? h.patterns : ['(패턴 없음)']) {
      const s = patternStats.get(pattern) ?? { count: 0, resolved: 0 };
      s.count++; if (h.cls === 'MATCH_FAILURE_UNIQUE') s.resolved++;
      patternStats.set(pattern, s);
    }
  }
  return { total: held.length, byClass, byClassYear, byReasonClass,
    patterns: [...patternStats].map(([pattern, s]) => ({ pattern, ...s })).sort((a, b) => b.count - a.count), held };
}
