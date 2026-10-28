/** Existing shared-sheet fact parsers, shared without changing their accepted formats. */
export function sharedSheetFactNumber(s: string, unit = '', decimal = false): number | null {
  const body = unit ? s.replace(new RegExp(`\\s*${unit}$`, 'i'), '') : s;
  // 소수 칸의 «0.###» 표시 형식은 정수를 «22.»처럼 끝에 점을 붙여 보인다(2026-10-04 서식 통일) — 같은 값으로 받는다.
  if (!(decimal ? /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?$/ : /^(?:\d+|\d{1,3}(?:,\d{3})+)$/).test(body)) return null;
  const n = Number(body.replaceAll(',', '').replace(/\.$/, ''));
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}
export function sharedSheetFactYear(s: string): number | null {
  const m = /^(\d{2}|20\d{2})(?:MY|년식)?$/i.exec(s);
  return m ? Number(m[1]) + (m[1]!.length === 2 ? 2000 : 0) : null;
}
export function sharedSheetFactRegistration(s: string, raw: unknown): string | null {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + raw * 86400000);
    return Number.isFinite(d.getTime()) && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2099 ? d.toISOString().slice(0, 10) : null;
  }
  const m = /^(\d{2}|20\d{2})[.\-/](\d{1,2})(?:[.\-/](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]) + (m[1]!.length === 2 ? 2000 : 0), mo = Number(m[2]), d = m[3] ? Number(m[3]) : null;
  if (mo < 1 || mo > 12 || (d !== null && (d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()))) return null;
  return `${y}-${String(mo).padStart(2, '0')}${d === null ? '' : '-' + String(d).padStart(2, '0')}`;
}
