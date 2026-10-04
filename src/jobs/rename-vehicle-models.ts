import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { renameVehicleModel } from '../application/rename-vehicle-model.js';
import type { CatalogStore } from '../ports/catalog-store.js';
import { stableDigest } from '../shared/stable-digest.js';

/** Reviewed plan of Canonical VehicleModel renames to F03 names. Approval binds the whole plan digest. */
export type VehicleModelRenamePlan = {
  schema: 'vehicle-model-rename-plan/v1'; reason: string;
  items: Array<{ vehicleModelId: string; expectedRevision: number; subModel?: string; trim?: string;
    products: Array<{ productId: string; expectedRevision: number }>; evidence: string }>;
};
const actor = { id: 'service:freepass-data', kind: 'SERVICE' } as const;

export function validateVehicleModelRenamePlan(plan: VehicleModelRenamePlan) {
  if (plan?.schema !== 'vehicle-model-rename-plan/v1' || !plan.reason?.trim() || !Array.isArray(plan.items) || !plan.items.length)
    throw new Error('VEHICLE_MODEL_RENAME_PLAN_INVALID');
  const ids = new Set<string>();
  for (const i of plan.items) {
    if (!i.vehicleModelId || ids.has(i.vehicleModelId) || !Number.isSafeInteger(i.expectedRevision) || typeof i.evidence !== 'string' ||
        !i.evidence.trim() || (i.subModel === undefined && i.trim === undefined) || !Array.isArray(i.products)) throw new Error('VEHICLE_MODEL_RENAME_PLAN_INVALID');
    ids.add(i.vehicleModelId);
  }
  return { models: plan.items.length, products: plan.items.reduce((n, i) => n + i.products.length, 0), planDigest: stableDigest(plan) };
}

export async function applyVehicleModelRenamePlan(store: CatalogStore, plan: VehicleModelRenamePlan, planDigest: string) {
  const results = [];
  for (const i of plan.items) {
    const key = `rename-model:${planDigest}:${i.vehicleModelId}`;
    const receipt = await renameVehicleModel(store, { commandId: `cmd-${key}`, idempotencyKey: `idem-${key}`, vehicleModelId: i.vehicleModelId,
      expectedRevision: i.expectedRevision, ...(i.subModel !== undefined ? { subModel: i.subModel } : {}),
      ...(i.trim !== undefined ? { trim: i.trim } : {}), products: i.products, reason: `${plan.reason} · ${i.evidence}`, actor });
    const model = await store.getVehicleModel(i.vehicleModelId);
    const ok = !!model && model.revision === receipt.revision && (i.subModel === undefined || model.subModel === i.subModel) &&
      (i.trim === undefined || model.trim === i.trim);
    results.push({ revision: receipt.revision, readbackOk: ok });
  }
  return { renamed: results.length, readbackOk: results.every((r) => r.readbackOk) };
}

export async function main(args = process.argv.slice(2)) {
  const path = process.env.VEHICLE_MODEL_RENAME_PLAN?.trim();
  if (!path) throw new Error('VEHICLE_MODEL_RENAME_PLAN is required');
  const plan = JSON.parse(await readFile(path, 'utf8')) as VehicleModelRenamePlan;
  const summary = validateVehicleModelRenamePlan(plan);
  if (!args.includes('--apply')) { console.log(JSON.stringify({ status: 'DRY_RUN', ...summary }, null, 2)); return; }
  if (process.env.AUTHORIZE_VEHICLE_MODEL_RENAME !== summary.planDigest) throw new Error('exact plan digest authorization is required');
  const { withCatalogOwnershipAccess } = await import('./data-access-runtime.js');
  const result = await withCatalogOwnershipAccess(true, summary.planDigest, (store) => applyVehicleModelRenamePlan(store, plan, summary.planDigest));
  console.log(JSON.stringify({ status: result.readbackOk ? 'APPLIED' : 'HOLD', ...summary, ...result }, null, 2));
  if (!result.readbackOk) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`VEHICLE_MODEL_RENAME_HOLD ${e instanceof Error && /^[A-Z0-9_ ]+/.test(e.message) ? e.message.split(':')[0] : ''}`.trim()); process.exitCode = 1; });
}
