import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { applyVehicleUidMigration, dryRunVehicleUidMigration, rollbackVehicleUidMigration, } from '../application/vehicle-uid-migration-apply.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';
function parseArgs(argv) {
    const out = new Map();
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!arg.startsWith('--'))
            continue;
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
            out.set(arg, next);
            index++;
        }
        else {
            out.set(arg, true);
        }
    }
    return out;
}
function requiredString(args, key) {
    const value = args.get(key);
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`VEHICLE_UID_${key.slice(2).toUpperCase().replaceAll('-', '_')}_REQUIRED`);
    return value;
}
function assertOutsideCheckout(path) {
    if (!resolve(path).startsWith(resolve(process.cwd())))
        return;
    throw new Error('PRIVATE_INPUT_MUST_BE_OUTSIDE_CHECKOUT');
}
function approvalOptions(input) {
    return {
        ...(input.approvedDigest !== undefined ? { approvedDigest: input.approvedDigest } : {}),
        ...(input.writeFlag !== undefined ? { writeFlag: input.writeFlag } : {}),
    };
}
function envApproval(writeFlagEnv) {
    const input = {};
    if (process.env.VEHICLE_UID_APPLY_APPROVED_DIGEST !== undefined)
        input.approvedDigest = process.env.VEHICLE_UID_APPLY_APPROVED_DIGEST;
    if (writeFlagEnv !== undefined)
        input.writeFlag = writeFlagEnv;
    return approvalOptions(input);
}
function requireApproval(expectedDigest, writeFlagEnv, requiredFlag) {
    const options = envApproval(writeFlagEnv);
    if (options.approvedDigest !== expectedDigest || options.writeFlag !== requiredFlag) {
        throw new Error(requiredFlag === 'APPLY' ? 'VEHICLE_UID_APPLY_NOT_APPROVED' : 'VEHICLE_UID_ROLLBACK_NOT_APPROVED');
    }
    return options;
}
async function readJson(path) {
    assertOutsideCheckout(path);
    return JSON.parse(await readFile(path, 'utf8'));
}
export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const expectedDigest = requiredString(args, '--expected-digest');
    const rollbackPath = args.get('--rollback');
    if (typeof rollbackPath === 'string') {
        const backup = await readJson(rollbackPath);
        const approval = requireApproval(expectedDigest, process.env.VEHICLE_UID_ROLLBACK_WRITE, 'ROLLBACK');
        const { createVehicleUidMigrationApplyRuntime } = await import('./data-access-runtime.js');
        const runtime = createVehicleUidMigrationApplyRuntime();
        const result = await runtime.write(expectedDigest, () => rollbackVehicleUidMigration(runtime.store, backup, expectedDigest, {
            ...approval,
            lock: { directory: dirname(resolve(rollbackPath)), owner: 'apply-vehicle-uid-migration', now: new Date().toISOString() },
        }));
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    const planPath = requiredString(args, '--plan');
    const plan = await readJson(planPath);
    if (args.get('--apply') !== true) {
        console.log(JSON.stringify(await dryRunVehicleUidMigration(plan, expectedDigest), null, 2));
        return;
    }
    const backupOut = requiredString(args, '--backup-out');
    const approval = requireApproval(expectedDigest, process.env.VEHICLE_UID_APPLY_WRITE, 'APPLY');
    const { createVehicleUidMigrationApplyRuntime } = await import('./data-access-runtime.js');
    const runtime = createVehicleUidMigrationApplyRuntime();
    const result = await runtime.write(expectedDigest, () => applyVehicleUidMigration(runtime.store, plan, expectedDigest, {
        ...approval,
        now: new Date().toISOString(),
        lock: { directory: dirname(resolve(backupOut)), owner: 'apply-vehicle-uid-migration', now: new Date().toISOString() },
    }, async (backup) => writePrivateArtifact(backupOut, backup)));
    console.log(JSON.stringify({ ...result, backup: result.backup ? { backupDigest: result.backup.backupDigest } : undefined }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
