import { readFile } from 'node:fs/promises';
import { validatePolicyCorrectionPlan, type PolicyCorrectionPlan } from '../domain/policy-correction.js';
import { stableDigest } from '../shared/stable-digest.js';
import { createJobDataAccessRuntime } from './data-access-runtime.js';

const planPath = process.env.POLICY_CORRECTION_PLAN?.trim();
if (!planPath) throw new Error('POLICY_CORRECTION_PLAN is required');
const plan = JSON.parse(await readFile(planPath, 'utf8')) as PolicyCorrectionPlan;
const counts = validatePolicyCorrectionPlan(plan);
const planDigest = stableDigest(plan);

if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ status: 'DRY_RUN', ...counts, planDigest }, null, 2));
} else {
  if (process.env.AUTHORIZE_POLICY_CORRECTION !== planDigest) throw new Error('exact plan digest authorization is required');
  const runtime = createJobDataAccessRuntime();
  const result = await runtime.access.write({
    context: {
      actor: { id: 'service:policy-corrector', kind: 'SERVICE' },
      clientId: 'job:apply-policy-correction',
      purpose: 'apply reviewed policy field corrections with evidence, private backup, transaction preconditions, readback, and audit',
    },
    operation: 'WRITE_POLICY_CORRECTION',
    resource: { kind: 'CATALOG', name: 'freepasserp5/policy' },
    requestDigest: planDigest,
    summarize: (value) => ({ count: value.writtenItemCount, digest: stableDigest(value) }),
  }, async () => {
    const { applyPolicyCorrection } = await import('../infra/' + 'policy-correction-firestore.js');
    return applyPolicyCorrection(plan);
  });
  console.log(JSON.stringify({ status: 'APPLIED', result }, null, 2));
}
