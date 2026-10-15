/** 차종 마스터 추가 후보 표 생성 CLI(읽기 전용: 스냅샷 JSON 입력, 쓰기·네트워크 없음, 마스터 변경 없음).
 *   node dist/src/jobs/build-master-addition-candidates.js --input <identity 스냅샷.json> --csv <후보.csv> [--summary <요약.json>]
 * 입력은 build-identity-promotion-plan 과 같은 스냅샷({products, masters}; 끝4·원문 차명·연식만). 출력 CSV 는 공급사·보류사유·원문 차명 단위 묶음이며
 * 마지막 «승인(예/아니오)» 칸은 비어 있다. 이 도구는 이름을 정하지 않는다 — 후보 문구일 뿐이며 마스터 반영은 대표 승인 + 차종 마스터 세션 정정 경로로만 한다. */
import { readFile, writeFile } from 'node:fs/promises';
import { buildMasterAdditionCandidates, candidatesToCsv } from '../application/master-addition-candidates.js';
import { parseIdentitySnapshot } from './build-identity-promotion-plan.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

export async function runMasterCandidatesCli(argv: { input?: string | undefined; csv?: string | undefined; summary?: string | undefined }) {
  if (!argv.input || !argv.csv) throw new Error('MASTER_CANDIDATES_ARGS_REQUIRED');
  const snapshot = parseIdentitySnapshot(JSON.parse(await readFile(argv.input, 'utf8')));
  const result = buildMasterAdditionCandidates(snapshot.products, snapshot.masters);
  await writeFile(argv.csv, '﻿' + candidatesToCsv(result.rows), { mode: 0o600 });
  const bySupplier: Record<string, Record<string, number>> = {};
  for (const r of result.rows) { const s = (bySupplier[r.supplier || '(미상)'] ??= {}); s[r.reason] = (s[r.reason] ?? 0) + r.count; }
  const summary = { status: 'MASTER_ADDITION_CANDIDATES', writes: 0, products: result.products, heldTotal: result.heldTotal, groups: result.rows.length,
    reasonCounts: result.reasonCounts, bySupplier };
  if (argv.summary) await writeFile(argv.summary, JSON.stringify(summary, null, 2), { mode: 0o600 });
  return summary;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('build-master-addition-candidates.js')) {
  runMasterCandidatesCli({ input: arg('--input'), csv: arg('--csv'), summary: arg('--summary') }).then(s => console.log(JSON.stringify(s, null, 1)))
    .catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'MASTER_CANDIDATES_FAILED'); process.exitCode = 1; });
}
