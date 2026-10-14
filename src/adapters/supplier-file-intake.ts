/** 공급사가 카톡으로 올리는 일일 엑셀 파일 원천의 «도착 감지·중복 방지·차이표» (레이아웃 무관 부분).
 * 대표 2026-10-14: 마춤카(RP034)는 매일 아침 올라오는 «마춤카 엑셀자료 YYMMDD.xlsx» 를 전용 수집 엔진이 읽어 직접 반영한다.
 * 엑셀 해석(칸 매핑)은 샘플 확인 뒤 별도 모듈이 한다. 이 모듈은 파일 시스템·해시·차이표만 다룬다(네트워크·쓰기 없음). */
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const SUPPLIER_FILE_LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, maxRows: 2000 });
const NAME = /^마춤카\s*엑셀자료\s*(\d{6})(?:\s*\(\d+\))?\.xlsx$/i;

/** 한국 시간(KST, UTC+9) 기준 오늘의 YYMMDD. */
export function kstYymmdd(nowMs: number): string {
  const d = new Date(nowMs + 9 * 3_600_000);
  return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

export type IntakeFile = { path: string; name: string; yymmdd: string; size: number; mtimeMs: number };
export type FindResult =
  | { status: 'FOUND'; file: IntakeFile; duplicates: number }
  | { status: 'NO_FILE' | 'OLDER_FILE_ONLY' | 'TOO_LARGE'; newestYymmdd: string | null };

/** 오늘 날짜(KST) 파일만 인정한다. 같은 날짜가 여러 개(내려받기 중복 «(1)»)면 가장 늦게 수정된 것을 쓰고 개수를 알린다. */
export async function findTodaysFile(dir: string, nowMs: number,
  io: { readdir: typeof readdir; stat: typeof stat } = { readdir, stat }): Promise<FindResult> {
  const today = kstYymmdd(nowMs);
  const found: IntakeFile[] = [];
  for (const name of await io.readdir(dir)) {
    const m = NAME.exec(name);
    if (!m) continue;
    const path = join(dir, name), s = await io.stat(path);
    if (s.isFile()) found.push({ path, name, yymmdd: m[1]!, size: s.size, mtimeMs: s.mtimeMs });
  }
  const newest = found.map(f => f.yymmdd).sort().at(-1) ?? null;
  const todays = found.filter(f => f.yymmdd === today).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!todays.length) return { status: found.length ? 'OLDER_FILE_ONLY' : 'NO_FILE', newestYymmdd: newest };
  const pick = todays[0]!;
  if (pick.size > SUPPLIER_FILE_LIMITS.maxBytes) return { status: 'TOO_LARGE', newestYymmdd: pick.yymmdd };
  return { status: 'FOUND', file: pick, duplicates: todays.length - 1 };
}

export const fileSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export type DiffEntry = { key: string; fingerprint: string };
export type DiffTable = { NEW: string[]; CHANGED: string[]; MISSING: string[]; SAME: string[] };
/** 새 목록 ↔ 현재 데이터 차이표. key 는 차량번호(또는 번호 없는 신차의 차종+트림+색상 묶음 키), fingerprint 는 비교할 업무 값의 해시. 결과는 정렬해 결정적이다. */
export function diffTable(current: readonly DiffEntry[], next: readonly DiffEntry[]): DiffTable {
  const before = new Map(current.map(e => [e.key, e.fingerprint])), after = new Map(next.map(e => [e.key, e.fingerprint]));
  const out: DiffTable = { NEW: [], CHANGED: [], MISSING: [], SAME: [] };
  for (const [key, fp] of after) {
    if (!before.has(key)) out.NEW.push(key);
    else if (before.get(key) !== fp) out.CHANGED.push(key);
    else out.SAME.push(key);
  }
  for (const key of before.keys()) if (!after.has(key)) out.MISSING.push(key);
  for (const list of Object.values(out)) list.sort();
  return out;
}
