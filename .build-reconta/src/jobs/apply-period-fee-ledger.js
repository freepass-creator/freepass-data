import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyPeriodFeeLedgerPlan, rollbackPeriodFeeLedgerSnapshot, } from '../application/apply-period-fee-ledger.js';
import { stableDigest } from '../shared/stable-digest.js';
function parseArgs(argv) {
    const args = { planPath: null, expectedDigest: null, rollback: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--plan')
            args.planPath = argv[++index] ?? null;
        else if (arg === '--expected-digest')
            args.expectedDigest = argv[++index] ?? null;
        else if (arg === '--rollback')
            args.rollback = true;
        else
            throw new Error(`PERIOD_FEE_APPLY_ARG_UNKNOWN:${arg}`);
    }
    return args;
}
const writesApproved = () => process.env.PERIOD_FEE_LEDGER_APPLY === '1'
    && process.env.PERIOD_FEE_LEDGER_WRITE_APPROVED === '1';
async function readPlan(planPath) {
    const raw = await readFile(planPath, 'utf8');
    return JSON.parse(raw);
}
export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (!args.planPath)
        throw new Error('PERIOD_FEE_PLAN_PATH_REQUIRED');
    if (!args.expectedDigest)
        throw new Error('PERIOD_FEE_EXPECTED_DIGEST_REQUIRED');
    const plan = await readPlan(args.planPath);
    const { createPeriodFeeLedgerApplyRuntime } = await import('./data-access-runtime.js');
    const runtime = createPeriodFeeLedgerApplyRuntime();
    const options = {
        expectedDigest: args.expectedDigest,
        writeApproved: writesApproved(),
    };
    const spec = {
        context: {
            actor: { id: 'service:freepass-data-period-fee', kind: 'SERVICE' },
            clientId: 'job:apply-period-fee-ledger',
            purpose: args.rollback ? 'rollback a reviewed period fee ledger snapshot' : 'apply a reviewed period fee ledger snapshot',
        },
        operation: options.writeApproved
            ? (args.rollback ? 'ROLLBACK_PERIOD_FEE_LEDGER' : 'WRITE_PERIOD_FEE_LEDGER')
            : (args.rollback ? 'READ_PERIOD_FEE_LEDGER_ROLLBACK_PLAN' : 'READ_PERIOD_FEE_LEDGER_APPLY_PLAN'),
        resource: { kind: 'SOURCE', name: plan.snapshotId },
        requestDigest: stableDigest({ snapshotId: plan.snapshotId, expectedDigest: args.expectedDigest, rollback: args.rollback }),
        summarize: (value) => ({
            count: 'counts' in value ? value.counts.ledgerCreated : value.deletedRows,
            digest: stableDigest(value),
        }),
    };
    const run = () => args.rollback
        ? rollbackPeriodFeeLedgerSnapshot(runtime.store, plan, options)
        : applyPeriodFeeLedgerPlan(runtime.store, plan, options);
    const result = options.writeApproved
        ? await runtime.access.write(spec, run)
        : await runtime.access.read(spec, run);
    console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : 'PERIOD_FEE_LEDGER_APPLY_FAILED');
        process.exitCode = 1;
    });
}
