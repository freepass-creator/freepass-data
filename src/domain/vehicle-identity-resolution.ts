/**
 * «FreePass Data 정리값 먼저 → F03 이름 → 원문과 모순 없을 때만 채택» (AI 상황실·대표 2026-10-04).
 * Pure: the caller supplies the F03 snapshot (main + 별칭 tab) and the existing Data identity for the plate.
 * Nothing here guesses a name from free text; it only maps known names through F03 and rejects contradictions.
 */
export type VehicleIdentity = readonly [maker: string, model: string, subModel: string, trimName: string];
export type F03Row = { maker: string; model: string; subModel: string; trimName: string; start: string; end: string; subModelKey: string };
export type F03Alias = { kind: string; oldName: string; model: string; displayName: string; key: string };
export type F03Snapshot = { rows: F03Row[]; aliases: F03Alias[] };
export type IdentityChoice =
  | { pick: 'DATA' | 'SHEET'; identity: VehicleIdentity; dataIdentity: VehicleIdentity | null; notes: string[] }
  | { pick: 'HOLD'; identity: null; dataIdentity: VehicleIdentity | null; notes: string[] };

export const VEHICLE_IDENTITY_RULE_VERSION = 'data-first-identity/1';
const GENERIC = new Set(['더', '뉴', '올', '디', 'THE', '신형']);
const HYBRID = /하이브리드|HEV|E-?TECH|ECH/i;
const ELECTRIC = /전기|(^|[^A-Z])EV([^A-Z]|$)/i;
const text = (v: unknown) => String(v ?? '').trim();
const compact = (v: string) => v.replace(/\s+/g, '').toUpperCase();

export function indexF03(snapshot: F03Snapshot) {
  const rows = new Map<string, F03Row[]>(), subModels = new Map<string, Set<string>>(), trims = new Map<string, Set<string>>();
  const add = <T>(m: Map<string, Set<T>>, k: string, v: T) => (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v);
  for (const r of snapshot.rows) {
    const k3 = [r.maker, r.model, r.subModel].join('|');
    (rows.get(k3) ?? rows.set(k3, []).get(k3)!).push(r);
    add(subModels, [r.maker, r.model].join('|'), r.subModel);
    add(trims, k3, r.trimName);
  }
  const makers = new Set(snapshot.rows.map(r => r.maker));
  const has = (id: VehicleIdentity) => trims.get(id.slice(0, 3).join('|'))?.has(id[3]) ?? false;
  return { snapshot, rows, subModels, trims, makers, has };
}
export type F03Index = ReturnType<typeof indexF03>;

/** Data value → F03 display names via the 별칭 tab and the 기본형 rule. Returns null when it does not land on an F03 row. */
export function dataIdentityToF03(f03: F03Index, data: VehicleIdentity): VehicleIdentity | null {
  const [rawMaker, model, rawSub, rawTrim] = data.map(text) as unknown as VehicleIdentity;
  const maker = f03.makers.has(rawMaker) ? rawMaker : f03.snapshot.aliases.find(a => a.kind === '제조사' &&
    (a.oldName === rawMaker || a.oldName.replace(/\(.*\)/, '').trim() === rawMaker))?.displayName;
  if (!maker) return null;
  const subs = f03.subModels.get([maker, model].join('|'));
  if (!subs) return null;
  let sub: string | undefined = subs.has(rawSub) ? rawSub : undefined;
  if (!sub) {
    const hits = new Set(f03.snapshot.aliases.filter(a => ['세부모델', '코드', '세대'].includes(a.kind) && a.oldName === rawSub &&
      (a.model === model || a.model === '') && subs.has(a.displayName)).map(a => a.displayName));
    sub = hits.size === 1 ? [...hits][0] : rawSub === model && subs.has('기본형') ? '기본형' : undefined;
  }
  if (!sub || !rawTrim) return null;
  const trims = f03.trims.get([maker, model, sub].join('|'))!;
  let trim: string | undefined = trims.has(rawTrim) ? rawTrim : undefined;
  if (!trim) {
    const key = f03.rows.get([maker, model, sub].join('|'))?.[0]?.subModelKey;
    const hits = new Set(f03.snapshot.aliases.filter(a => a.kind === '세부트림' && a.oldName === rawTrim && a.key === key &&
      trims.has(a.displayName)).map(a => a.displayName));
    const upper = [...trims].filter(x => x.toUpperCase() === rawTrim.toUpperCase());
    trim = hits.size === 1 ? [...hits][0] : upper.length === 1 ? upper[0] : undefined;
  }
  return trim ? [maker, model, sub, trim] : null;
}

function month(v: string): number | null {
  const m = /^(\d{2}|\d{4})\D+(\d{1,2})/.exec(v);
  if (!m) return null;
  const y = Number(m[1]) + (m[1]!.length === 2 ? 2000 : 0), mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? y * 12 + mo : null;
}
function inPeriod(f03: F03Index, id: VehicleIdentity, firstRegistration: string, modelYear: string): boolean {
  const at = month(firstRegistration) ?? (/^\d{4}$/.test(modelYear) ? Number(modelYear) * 12 + 6 : null);
  const periods = f03.rows.get(id.slice(0, 3).join('|')) ?? [];
  if (at === null || !periods.length) return true;
  return periods.some(p => {
    const start = /^\d{4}$/.test(p.start) ? Number(p.start) * 12 + 1 : month(p.start);
    const end = ['현재', ''].includes(p.end) ? Infinity : /^\d{4}$/.test(p.end) ? Number(p.end) * 12 + 12 : month(p.end);
    // Not before production start (1 month tolerance); late registration up to 18 months after the end.
    return start === null || end === null || (at >= start - 1 && at <= end + 18);
  });
}
/** Machine-checkable contradictions between a candidate identity and the supplier source text. */
export function identityContradictions(f03: F03Index, id: VehicleIdentity, raw: string, firstRegistration: string, modelYear: string): string[] {
  const out: string[] = [];
  if (!inPeriod(f03, id, firstRegistration, modelYear)) out.push('PERIOD');
  const name = `${id[2]} ${id[3]}`;
  const siblings = [...f03.rows.entries()].filter(([k]) => k.startsWith(`${id[0]}|${id[1]}|`)).flatMap(([, v]) => v);
  for (const [tag, rx] of [['HYBRID', HYBRID], ['ELECTRIC', ELECTRIC]] as const) {
    if (rx.test(raw) && !rx.test(name) && siblings.some(r => rx.test(`${r.subModel} ${r.trimName}`))) out.push(`${tag}_MISSING`);
    if (rx.test(name) && !rx.test(raw)) out.push(`${tag}_NOT_IN_SOURCE`);
  }
  const source = compact(raw);
  for (const token of id[2].split(/\s+/)) {
    const t = token.toUpperCase();
    if (!t || GENERIC.has(t) || t === '기본형' || compact(id[1]).includes(t)) continue;
    if (!source.includes(t)) out.push(`TOKEN_NOT_IN_SOURCE:${token}`);
  }
  return out;
}
/** How well a name agrees with the source text: words found minus distinctive words absent (「더 뉴」 omissions are not penalised). */
export function sourceAgreement(id: VehicleIdentity, raw: string): number {
  const source = compact(raw);
  const tokens = `${id[2]} ${id[3]}`.split(/\s+/).filter(t => t && t !== '기본형' && !compact(id[1]).includes(t.toUpperCase()));
  return tokens.filter(t => source.includes(t.toUpperCase())).length -
    tokens.filter(t => !source.includes(t.toUpperCase()) && !GENERIC.has(t.toUpperCase())).length;
}

export function chooseVehicleIdentity(f03: F03Index, input: { sheet: VehicleIdentity; data: VehicleIdentity | null;
  raw: string; firstRegistration: string; modelYear: string }): IdentityChoice {
  const dataIdentity = input.data ? dataIdentityToF03(f03, input.data) : null;
  const sheetOk = f03.has(input.sheet);
  const notes = dataIdentity ? identityContradictions(f03, dataIdentity, input.raw, input.firstRegistration, input.modelYear)
    : [input.data ? 'DATA_NOT_F03' : 'DATA_ABSENT'];
  if (dataIdentity && sheetOk && dataIdentity.join('|') !== input.sheet.join('|')) {
    const better = sourceAgreement(dataIdentity, input.raw) - sourceAgreement(input.sheet, input.raw);
    if (better < 0) notes.push('SHEET_MATCHES_SOURCE_BETTER');
    else if (better > 0 && notes.includes('PERIOD')) return { pick: 'HOLD', identity: null, dataIdentity, notes: [...notes, 'SOURCE_VS_PERIOD_CONFLICT'] };
  }
  if (dataIdentity && !notes.length) return { pick: 'DATA', identity: dataIdentity, dataIdentity, notes };
  if (sheetOk) return { pick: 'SHEET', identity: input.sheet, dataIdentity, notes };
  return { pick: 'HOLD', identity: null, dataIdentity, notes };
}
