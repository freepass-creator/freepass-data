import { pathToFileURL } from 'node:url';
import { planVehicleUidMigration } from '../application/vehicle-uid-migration-plan.js';
import { stableDigest } from '../shared/stable-digest.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

export async function main() {
  const out = process.env.VEHICLE_UID_PLAN_OUT?.trim();
  if (!out) throw new Error('VEHICLE_UID_PLAN_OUT_REQUIRED');
  const { createVehicleUidMigrationPlanRuntime } = await import('./data-access-runtime.js');
  const input = await createVehicleUidMigrationPlanRuntime().readInputs();
  const plan = planVehicleUidMigration({
    ...input,
    clock: () => new Date(input.observedAt),
    random: Math.random,
  });
  await writePrivateArtifact(out, plan);
  console.log(JSON.stringify({
    status: 'PLANNED',
    writes: 0,
    products: plan.summary.totalProducts,
    assets: plan.summary.totalAssets,
    byKind: plan.summary.byKind,
    byReason: plan.summary.byReason,
    planDigest: plan.planDigest,
    publicReportDigest: stableDigest(plan.summary.publicReport),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('VEHICLE_UID_PLAN_HOLD');
    process.exitCode = 1;
  });
}
