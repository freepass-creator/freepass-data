import { stableDigest } from '../shared/stable-digest.js';
import { applyAutoplusPolicyRepair } from '../infra/autoplus-policy-repair-firestore.js';
import { createJobDataAccessRuntime } from './data-access-runtime.js';

const runtime = createJobDataAccessRuntime();
const result = await runtime.access.write({
  context: {
    actor: { id: 'service:freepass-data-autoplus-policy-repair', kind: 'SERVICE' },
    clientId: 'job:apply-autoplus-policy-repair',
    purpose: 'repair RP023 policies to age 26 or older with no age lowering',
  },
  operation: 'WRITE_AUTOPLUS_POLICY_REPAIR',
  resource: { kind: 'SOURCE', name: 'freepasserp5/autoplus-policy' },
  requestDigest: stableDigest({ providerCompanyCode: 'RP023', policyCodes: ['POL-0047', 'FP-RP023-RENT'] }),
  summarize: (value) => ({ count: value.policies.length, digest: stableDigest(value.policies) }),
}, () => applyAutoplusPolicyRepair());

console.log(JSON.stringify(result));
