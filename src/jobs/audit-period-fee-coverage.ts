import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { buildFeeCoverageAudit, lookupFeeWithReason, redactMismatchKeys, sampleFeeAuditPlates } from '../application/audit-period-fee-coverage.js';
import { createPeriodFeeCoverageRuntime } from './data-access-runtime.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

export async function main() {
  const runtime = createPeriodFeeCoverageRuntime();
  const lookupArg = process.argv[2] === 'lookup' ? process.argv[3]?.trim() : undefined;
  const ledgerRows = await runtime.readActiveLedgerRows();
  if (lookupArg) {
    console.log(JSON.stringify(lookupFeeWithReason(await runtime.readInputs(), ledgerRows, lookupArg), null, 2));
    return;
  }
  const outDir = process.env.PERIOD_FEE_COVERAGE_OUT_DIR?.trim();
  if (!outDir) throw new Error('PERIOD_FEE_COVERAGE_OUT_DIR_REQUIRED');
  const inputs = await runtime.readInputs();
  const audit = buildFeeCoverageAudit(inputs, ledgerRows);
  const { _mismatchKeys, _scopedRows, ...summary } = audit;
  const sample = sampleFeeAuditPlates(_scopedRows, _mismatchKeys, 20);
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });
  await writePrivateArtifact(join(dir, 'detail.json'), { summary, mismatchKeys: redactMismatchKeys(_mismatchKeys, randomBytes(16).toString('hex')) });
  console.log(JSON.stringify({ summary, sample }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'PERIOD_FEE_COVERAGE_AUDIT_FAILED');
    process.exitCode = 1;
  });
}
