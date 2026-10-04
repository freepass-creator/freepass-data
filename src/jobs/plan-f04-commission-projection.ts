import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { planF04CommissionProjection } from '../application/f04-commission-projection.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

/**
 * F04 접수 탭 AE·AJ 투영 «시험 실행»: 계획 파일만 만든다(시트·프리패스 데이터 쓰기 0).
 * 입력은 운영자가 읽기 전용으로 받은 values.batchGet 응답(접수, 회차청구 순서, UNFORMATTED_VALUE)과
 * 프리패스 데이터 products 의 연료(차량번호 → { fuel }). 계획 파일에는 차량번호가 있으므로 저장소 밖 비공개 경로에만 쓴다.
 * 공개 출력은 개수만.
 */
export async function main(args = process.argv.slice(2)) {
  const parsed = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]!, v = args[i + 1];
    if (!['--from-batchget', '--grid-meta', '--facts', '--individual', '--open-from', '--out'].includes(k) || parsed.has(k) || !v || v.startsWith('--')) throw new Error('INVALID_ARGUMENT');
    parsed.set(k, v);
  }
  const batchPath = parsed.get('--from-batchget'), out = parsed.get('--out'), openFromMonth = parsed.get('--open-from');
  if (!batchPath || !out || !openFromMonth) throw new Error('F04_PLAN_ARGUMENTS_REQUIRED');
  const batch = JSON.parse(await readFile(batchPath, 'utf8')) as { valueRanges?: Array<{ range?: string; values?: unknown[][] }> };
  const [intake, installments] = batch.valueRanges ?? [];
  // 행 번호를 시트 행과 맞추려면 두 탭 모두 A1 부터, 그 탭의 마지막 행까지 읽어야 한다(일부만 읽으면 회차청구 대조가 빠진다).
  const meta = JSON.parse(await readFile(parsed.get('--grid-meta') ?? '', 'utf8').catch(() => { throw new Error('F04_GRID_META_REQUIRED'); })) as { sheets?: Array<{ properties?: { title?: string; gridProperties?: { rowCount?: number } } }> };
  const rowsOf = (title: string) => meta.sheets?.find(x => x.properties?.title === title)?.properties?.gridProperties?.rowCount;
  const whole = (range: string | undefined, title: string) => {
    const m = /^'?([^'!]+)'?!A1:[A-Z]+(\d+)$/.exec(range ?? '');
    return !!m && m[1] === title && Number(m[2]) === rowsOf(title);
  };
  if (!whole(intake?.range, '접수') || !whole(installments?.range, '회차청구')) throw new Error('F04_BATCHGET_RANGES_MISMATCH');
  const factsPath = parsed.get('--facts');
  const facts = factsPath ? JSON.parse(await readFile(factsPath, 'utf8')) as Record<string, { fuel?: string }> : {};
  // 개별 합의 계약 목록(차량번호|접수일, 비공개)은 필수 — 없으면 행 번호만으로는 계약을 보호할 수 없다.
  const individualPath = parsed.get('--individual');
  if (!individualPath) throw new Error('F04_INDIVIDUAL_LIST_REQUIRED');
  const individualKeys = JSON.parse(await readFile(individualPath, 'utf8')) as unknown;
  if (!Array.isArray(individualKeys) || individualKeys.some(k => typeof k !== 'string' || !k.includes('|'))) throw new Error('F04_INDIVIDUAL_LIST_INVALID');
  const plan = planF04CommissionProjection({ intake: intake!.values ?? [], installments: installments!.values ?? [], openFromMonth, readAt: new Date().toISOString(), facts, individualKeys });
  await writePrivateArtifact(out, plan);
  const count = <T,>(items: T[], key: (x: T) => string) => items.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});
  console.log(JSON.stringify({ schema: plan.schema, policyId: plan.policyId, openFromMonth, rowsRead: plan.rowsRead,
    fills: count(plan.fills, f => f.column), blanks: count(plan.blanks, b => `${b.column} ${b.reason}`),
    diffs: count(plan.diffs, d => `${d.column}←${d.against}`), closedDiffs: plan.closedDiffs.length, same: plan.same, skipped: plan.skipped }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`F04_PLAN_HOLD ${e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : ''}`.trim()); process.exitCode = 1; });
}
