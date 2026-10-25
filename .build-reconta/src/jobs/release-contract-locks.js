import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTRACT_LOCK_EVIDENCE_MAX_AGE_MS, contractLockPlanDigest, decideContractLockRelease, parseContractLockReleasePlan, parseContractLockSheetEvidence, summarizeContractLockDecisions, } from '../application/contract-lock-release.js';
import { stableDigest } from '../shared/stable-digest.js';
import { createContractLockRuntime } from './data-access-runtime.js';
const USAGE = 'USAGE: node dist/src/jobs/release-contract-locks.js --plan <plan.json> --evidence <sheet-evidence.json> [--apply --backup-dir <dir>]';
const arg = (args, key) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
/**
 * 시험 실행이 기본(쓰기 0). 적용은 --apply + 환경변수 2개(승인 digest = 계획 digest) + 백업 폴더.
 * 적용 대상 «전체» 백업을 먼저 성공·검증한 뒤에만 쓰기 루프를 시작한다. 터미널 출력에는 끝 4자리만.
 */
export async function runReleaseContractLocks(args, env, deps = {}) {
    const clock = deps.clock ?? (() => new Date());
    const planPath = arg(args, '--plan');
    const evidencePath = arg(args, '--evidence');
    const apply = args.includes('--apply');
    const backupDir = arg(args, '--backup-dir');
    if (!planPath || !evidencePath || (apply && !backupDir))
        throw new Error(USAGE);
    const plan = parseContractLockReleasePlan(JSON.parse(await readFile(resolve(planPath), 'utf8')));
    if (!plan)
        throw new Error('CONTRACT_LOCK_PLAN_INVALID');
    const evidence = parseContractLockSheetEvidence(JSON.parse(await readFile(resolve(evidencePath), 'utf8')));
    if (!evidence)
        throw new Error('CONTRACT_LOCK_EVIDENCE_INVALID');
    const planDigest = contractLockPlanDigest(plan);
    if (apply && (env.FREEPASS_CONTRACT_LOCK_RELEASE !== 'on' || env.FREEPASS_CONTRACT_LOCK_RELEASE_APPROVED !== planDigest)) {
        throw new Error('CONTRACT_LOCK_RELEASE_NOT_APPROVED');
    }
    const runtime = deps.runtime ?? await createContractLockRuntime();
    const products = await runtime.readProducts(plan.items.map(item => item.plate));
    const decisions = plan.items.map(item => decideContractLockRelease(item, products[item.plate] ?? null, evidence, clock()));
    const report = plan.items.map((item, index) => ({ last4: item.plate.slice(-4), supplierCode: item.supplierCode, decision: decisions[index].decision, reason: decisions[index].reason }));
    const out = { mode: apply ? 'APPLY' : 'DRY_RUN', planDigest, summary: summarizeContractLockDecisions(decisions), items: report, writes: 0 };
    if (!apply)
        return out;
    const writeBackup = deps.writeBackup ?? (async (path, text) => { await writeFile(path, text, { flag: 'wx' }); });
    const readBackup = deps.readBackup ?? (async (path) => readFile(path, 'utf8'));
    const dir = resolve(backupDir);
    await mkdir(dir, { recursive: true });
    const targets = plan.items.filter((_, index) => decisions[index].decision === 'RELEASABLE');
    // 1) 쓰기 전에 대상 전체의 백업을 모두 저장하고 되읽어 검증한다. 하나라도 실패하면 운영 쓰기 0 으로 중단.
    const backupPaths = new Map();
    for (const item of targets) {
        const text = JSON.stringify({ planDigest, plate: item.plate, before: products[item.plate] }, null, 2);
        const path = join(dir, `${stableDigest({ planDigest, plate: item.plate }).slice(0, 16)}.json`);
        try {
            await writeBackup(path, text);
            if ((await readBackup(path)) !== text)
                throw new Error('BACKUP_MISMATCH');
        }
        catch {
            return { ...out, mode: 'APPLY', status: 'ABORTED_BACKUP_FAILED', writes: 0 };
        }
        backupPaths.set(item.plate, path);
    }
    // 2) 쓰기 루프: 증거 만료는 시도마다 다시 검사된다(infra 트랜잭션 안).
    let writes = 0;
    const results = [];
    for (const [index, item] of plan.items.entries()) {
        const decision = decisions[index];
        if (decision.decision !== 'RELEASABLE') {
            results.push({ last4: item.plate.slice(-4), result: `SKIPPED_${decision.reason}` });
            continue;
        }
        const before = products[item.plate];
        const result = await runtime.release(stableDigest({ planDigest, plate: item.plate }), {
            id: item.plate, supplierCode: item.supplierCode, expectedLockAt: item.expectedLockAt,
            reason: `취소·접수 시트 ${item.sheetRow}행`, backup: before,
            evidenceReadAt: evidence.readAt, maxEvidenceAgeMs: CONTRACT_LOCK_EVIDENCE_MAX_AGE_MS,
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
