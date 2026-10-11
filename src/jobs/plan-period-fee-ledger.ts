import { pathToFileURL } from 'node:url';
import { planPeriodFeeLedger, type PlanPeriodFeeLedgerInput } from '../application/period-fee-ledger-plan.js';
import { stableDigest } from '../shared/stable-digest.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

type PeriodFeeLedgerRuntimeInput = PlanPeriodFeeLedgerInput & { observedAt: string };

export function buildPeriodFeeLedgerJobPlan(input: PeriodFeeLedgerRuntimeInput) {
  const readAt = new Date(input.observedAt);
  if (Number.isNaN(readAt.getTime()) || readAt.toISOString() !== input.observedAt) throw new Error('PERIOD_FEE_LEDGER_READ_TIME_INVALID');
  return planPeriodFeeLedger(input, { clock: () => new Date(readAt.getTime()) });
}

export async function main() {
  const out = process.env.PERIOD_FEE_LEDGER_PLAN_OUT?.trim();
  if (!out) throw new Error('PERIOD_FEE_LEDGER_PLAN_OUT_REQUIRED');
  const { createPeriodFeeLedgerPlanRuntime } = await import('./data-access-runtime.js');
  const input = await createPeriodFeeLedgerPlanRuntime().readInputs();
  const plan = buildPeriodFeeLedgerJobPlan({ ...input, previousSnapshot: null });
  await writePrivateArtifact(out, plan);
  console.log(JSON.stringify({
    status: 'PLANNED',
    writes: 0,
    snapshotId: plan.snapshotId,
    products: plan.summary.totalProducts,
    productsWithPriceRows: plan.summary.productsWithPriceRows,
    rows: plan.summary.rows,
    historyRows: plan.summary.historyRows,
    uidMissing: plan.summary.uid.missing,
    settlementRowsAccessCount: plan.summary.settlementRowsAccessCount,
    planDigest: plan.planDigest,
    publicReportDigest: stableDigest(plan.summary.publicReport),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('PERIOD_FEE_LEDGER_PLAN_HOLD');
    process.exitCode = 1;
  });
}
