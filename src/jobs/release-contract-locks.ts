import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  contractLockPlanDigest,
  decideContractLockRelease,
  summarizeContractLockDecisions,
  type ContractLockReleasePlan,
  type ContractLockSheetEvidence,
} from '../application/contract-lock-release.js';
import { stableDigest } from '../shared/stable-digest.js';
import { createContractLockRuntime } from './data-access-runtime.js';

const USAGE = 'USAGE: node dist/src/jobs/release-contract-locks.js --plan <plan.json> --evidence <sheet-evidence.json> [--apply --backup-dir <dir>]';
const arg = (args: string[], key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };

/** 시험 실행이 기본(쓰기 0). 적용은 --apply + 환경변수 2개(승인 digest = 계획 digest) + 백업 폴더. 터미널 출력에는 끝 4자리만. */
export async function runReleaseContractLocks(args: string[], env: NodeJS.ProcessEnv, now = new Date()) {
  const planPath = arg(args, '--plan');
  const evidencePath = arg(args, '--evidence');
  const apply = args.includes('--apply');
  const backupDir = arg(args, '--backup-dir');
  if (!planPath || !evidencePath || (apply && !backupDir)) throw new Error(USAGE);
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf8')) as ContractLockReleasePlan;
  const evidence = JSON.parse(await readFile(resolve(evidencePath), 'utf8')) as ContractLockSheetEvidence;
  const planDigest = contractLockPlanDigest(plan);
  if (apply && (env.FREEPASS_CONTRACT_LOCK_RELEASE !== 'on' || env.FREEPASS_CONTRACT_LOCK_RELEASE_APPROVED !== planDigest)) {
    throw new Error('CONTRACT_LOCK_RELEASE_NOT_APPROVED');
  }
  const runtime = await createContractLockRuntime();
  const products = await runtime.readProducts(plan.items.map(item => item.plate));
  const decisions = plan.items.map(item => decideContractLockRelease(item, products[item.plate] ?? null, evidence, now));
  const report = plan.items.map((item, index) => ({ last4: item.plate.slice(-4), supplierCode: item.supplierCode, ...decisions[index]!, plate: undefined }));
  const out: Record<string, unknown> = { mode: apply ? 'APPLY' : 'DRY_RUN', planDigest, summary: summarizeContractLockDecisions(decisions), items: report, writes: 0 };
  if (!apply) return out;

  await mkdir(resolve(backupDir!), { recursive: true });
  let writes = 0;
  const results: Array<{ last4: string; result: string }> = [];
  for (const [index, item] of plan.items.entries()) {
    const decision = decisions[index]!;
    if (decision.decision !== 'RELEASABLE') { results.push({ last4: item.plate.slice(-4), result: `SKIPPED_${decision.reason}` }); continue; }
    const before = products[item.plate]!;
    // 이전 값 백업(저장소 밖 비공개 폴더, 번호 포함) — 쓰기 전에 먼저 남긴다.
    await writeFile(join(resolve(backupDir!), `${stableDigest({ planDigest, plate: item.plate }).slice(0, 16)}.json`), JSON.stringify({ planDigest, plate: item.plate, before }, null, 2), { flag: 'wx' });
    const result = await runtime.release(stableDigest({ planDigest, plate: item.plate }), {
      id: item.plate, supplierCode: item.supplierCode, expectedLockAt: item.expectedLockAt,
      reason: `취소·접수 시트 ${item.sheetRow}행`, backup: before,
    });
    if (result === 'RELEASED') {
      const after = (await runtime.readProducts([item.plate]))[item.plate];
      if (!after || after.locked_by_contract !== null || after.status !== before.status) {
        results.push({ last4: item.plate.slice(-4), result: 'READBACK_MISMATCH' });
        continue;
      }
      writes += 1;
    }
    results.push({ last4: item.plate.slice(-4), result });
  }
  return { ...out, writes, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runReleaseContractLocks(process.argv.slice(2), process.env)
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error && /^[A-Z0-9_ :<>\[\]\-.\/]+$/i.test(error.message) ? error.message : 'CONTRACT_LOCK_RELEASE_FAILED');
      process.exitCode = 1;
    });
}
