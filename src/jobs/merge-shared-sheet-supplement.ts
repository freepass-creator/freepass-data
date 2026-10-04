import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isStrictKoreanPlate, plateIdentityKey } from '../domain/vehicle-plate.js';

/**
 * Merges dated correction-history exports (시트 긴급 수정 엔진 «--이력내보내기») into one capture supplement for the
 * daily snapshot. The conflict key uses the same plate identity as the snapshot (supplier code + plateIdentityKey), so two
 * spellings of one car («12가 3456» / «12가3456») cannot both pass. Timestamps become UTC «Z» (snapshot format).
 */
type Correction = { supplierCode?: unknown; plate?: unknown; at?: unknown; column?: unknown; before?: unknown; after?: unknown; source?: unknown };
export type SkippedCorrection = { supplierCode: string; column: string; at: string; plate: unknown; reason: 'PLATE_NOT_ASSIGNED' };
export type Supplement = { corrections: Correction[]; supplierEntered?: unknown[]; skipped?: SkippedCorrection[] };

export class SupplementError extends Error {}
const FIELDS = ['before', 'after', 'source'] as const;

export function mergeSupplements(parts: unknown[]): Supplement {
  const out: Supplement = { corrections: [] };
  const seen = new Map<string, string>();
  for (const part of parts) {
    const p = part as { corrections?: unknown; supplierEntered?: unknown };
    if (!p || typeof p !== 'object' || !Array.isArray(p.corrections)) throw new SupplementError('SUPPLEMENT_INVALID');
    for (const raw of p.corrections as Correction[]) {
      if (!raw || typeof raw !== 'object' || typeof raw.at !== 'string' || typeof raw.supplierCode !== 'string'
        || !raw.supplierCode || typeof raw.column !== 'string') throw new SupplementError('SUPPLEMENT_INVALID');
      const at = new Date(raw.at);
      if (Number.isNaN(at.getTime())) throw new SupplementError('SUPPLEMENT_INVALID');
      // 실제 차량번호 모양(지역명 앞붙임 허용, 공백 무시)이 아닌 줄(«신차»·«미정»·«신차1»·빈칸)의 정정은 붙일 차가 없다 —
      // 박제는 이런 보충값을 통째로 거부하므로 건너뛰되, 무엇을 왜 건너뛰었는지 출력(비공개 증거)에 남긴다.
      // 건너뛴 줄끼리는 충돌을 보지 않는다(어느 차에도 붙지 않으므로).
      if (!isStrictKoreanPlate(plateIdentityKey(raw.plate))) {
        (out.skipped ??= []).push({ supplierCode: raw.supplierCode, column: raw.column, at: at.toISOString(), plate: raw.plate ?? null, reason: 'PLATE_NOT_ASSIGNED' });
        continue;
      }
      const c = { ...raw, at: at.toISOString() };
      const key = [c.supplierCode, plateIdentityKey(c.plate), c.at, c.column].join('|');
      const body = JSON.stringify(FIELDS.map((f) => c[f] ?? null));
      const prior = seen.get(key);
      if (prior !== undefined) {
        if (prior !== body) throw new SupplementError('SUPPLEMENT_CONFLICT');
        continue;
      }
      seen.set(key, body);
      out.corrections.push(c);
    }
    if (p.supplierEntered !== undefined) {
      if (!Array.isArray(p.supplierEntered)) throw new SupplementError('SUPPLEMENT_INVALID');
      (out.supplierEntered ??= []).push(...p.supplierEntered);
    }
  }
  return out;
}

export async function main(args = process.argv.slice(2)) {
  const [outPath, ...inputs] = args;
  if (!outPath) throw new SupplementError('SUPPLEMENT_INVALID');
  const parts: unknown[] = [];
  for (const path of inputs) {
    try { parts.push(JSON.parse(await readFile(path, 'utf8'))); } catch { throw new SupplementError('SUPPLEMENT_INVALID'); }
  }
  const merged = mergeSupplements(parts);
  // 출력은 비공개 증거 버킷에 보존된다(건너뛴 줄 목록 포함) — 박제는 corrections·supplierEntered 만 읽는다.
  await writeFile(outPath, JSON.stringify(merged));
  // Public log: counts only.
  console.log(`supplement corrections ${merged.corrections.length} supplierEntered ${merged.supplierEntered?.length ?? 0} skipped ${merged.skipped?.length ?? 0}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof SupplementError ? e.message : 'SUPPLEMENT_INVALID'); // fixed codes only — never file contents
    process.exitCode = 1;
  });
}
