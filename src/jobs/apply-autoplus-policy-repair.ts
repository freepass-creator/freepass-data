import { stableDigest } from '../shared/stable-digest.js';
import { applyAutoplusPolicyRepair } from '../infra/autoplus-policy-repair-firestore.js';
import { createJobDataAccessRuntime } from './data-access-runtime.js';

const runtime = createJobDataAccessRuntime();
const result = await runtime.access.write({
  context: {
    actor: { id: 'service:freepass-data-autoplus-policy-repair', kind: 'SERVICE' },
    clientId: 'job:apply-autoplus-policy-repair',
    purpose: 'repair RP023 policies and link all active AutoPlus products to the canonical policy',
  },
  operation: 'WRITE_AUTOPLUS_POLICY_REPAIR',
  resource: { kind: 'SOURCE', name: 'freepasserp5/autoplus-policy' },
  requestDigest: stableDigest({
    providerCompanyCode: 'RP023',
    policyCodes: ['POL-0047', 'FP-RP023-RENT'],
    canonicalPolicyCode: 'POL-0047',
    expectedActiveProductCount: 155,
  }),
  summarize: (value) => ({
    count: value.productCount + value.policies.length,
    digest: stableDigest({
      productCount: value.productCount,
      changedProductCount: value.changedProductCount,
      linkedPolicyCode: value.linkedPolicyCode,
      policies: value.policies,
    }),
  }),
}, () => applyAutoplusPolicyRepair());

console.log(JSON.stringify(result));
