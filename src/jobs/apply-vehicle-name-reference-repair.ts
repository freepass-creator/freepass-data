import { readFile } from 'node:fs/promises';
import {
  applyVehicleNameReferenceRepair,
  validateVehicleNameRepairPlan,
  vehicleNameRepairPlanDigest,
  type VehicleNameRepairPlan,
} from '../infra/vehicle-name-reference-repair-firestore.js';
import { stableDigest } from '../shared/stable-digest.js';
import { createJobDataAccessRuntime } from './data-access-runtime.js';

const planPath = process.env.VEHICLE_NAME_REPAIR_PLAN?.trim();
if (!planPath) throw new Error('VEHICLE_NAME_REPAIR_PLAN is required');
const plan = JSON.parse(await readFile(planPath, 'utf8')) as VehicleNameRepairPlan;
const counts = validateVehicleNameRepairPlan(plan);
// Approval binds the whole reviewed plan (every repair item), not only the sourceDigest label inside it.
const planDigest = vehicleNameRepairPlanDigest(plan);
const isCorrection = plan.kind === 'PRODUCT_IDENTITY_CORRECTION';
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ status: 'DRY_RUN', sourceDigest: plan.sourceDigest, planDigest, ...counts,
    ...(isCorrection ? { kind: plan.kind, projectId: plan.projectId,
      authorization: 'AUTHORIZE_PRODUCT_IDENTITY_CORRECTION',
      targets: plan.productIdentityCorrections!.map(({ id, from, to, expectedUpdateTime, rollbackOf }) => ({ id, from, to, expectedUpdateTime, rollbackOf })),
      liveChecks: 'NOT_CHECKED_OFFLINE',
      refusalConditions: ['LOCKED_BY_CONTRACT', 'PUBLICATION_WITHDRAWN', 'FROM_OR_VERSION_CHANGED', 'EVIDENCE_CHANGED_OR_CONFLICTED', 'MASTER_OR_TRIM_AMBIGUOUS_OR_CHANGED', 'BACKUP_FAILED', 'REPLAY_OR_ROLLBACK_MISMATCH'],
    } : {}),
  }, null, 2));
} else {
  if ((isCorrection ? process.env.AUTHORIZE_PRODUCT_IDENTITY_CORRECTION : process.env.AUTHORIZE_VEHICLE_NAME_REPAIR) !== planDigest) {
    throw new Error('exact plan digest authorization is required');
  }
  const runtime = createJobDataAccessRuntime();
  const result = await runtime.access.write({
    context: {
      actor: { id: 'service:freepass-data-vehicle-name-repair', kind: 'SERVICE' },
      clientId: 'job:apply-vehicle-name-reference-repair',
      purpose: 'apply exact vehicle-name repairs and vehicle-master v1 entries (rename, hybrid move, create) with private backup and readback',
    },
    operation: 'WRITE_VEHICLE_NAME_REFERENCE_REPAIR',
    resource: { kind: 'CATALOG', name: 'freepasserp5/vehicle-name-reference' },
    requestDigest: planDigest,
    summarize: (value) => ({ count: value.readbackCount, digest: stableDigest(value) }),
  // 승인 digest 를 적용기 함수에도 넘겨 적용기가 «자기 계산한 digest» 와 직접 대조한다(작업 스크립트 검사에만 기대지 않음).
  }, () => applyVehicleNameReferenceRepair(plan, isCorrection
    ? { approvedCorrectionDigest: process.env.AUTHORIZE_PRODUCT_IDENTITY_CORRECTION }
    : { approvedPlanDigest: process.env.AUTHORIZE_VEHICLE_NAME_REPAIR }));
  console.log(JSON.stringify({ status: 'APPLIED', result }, null, 2));
}
