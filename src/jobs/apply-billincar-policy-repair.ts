import { stableDigest } from '../shared/stable-digest.js';
import { applyBillincarPolicyRepair } from '../infra/billincar-policy-repair-firestore.js';
import { createJobDataAccessRuntime } from './data-access-runtime.js';

const runtime = createJobDataAccessRuntime();
const result = await runtime.access.write({
  context: { actor: { id: 'service:freepass-data-billincar-policy-repair', kind: 'SERVICE' },
    clientId: 'job:apply-billincar-policy-repair', purpose: 'align RP021 canonical policy to the supplier sheet and link products by the preserved source policy UID' },
  operation: 'WRITE_BILLINCAR_POLICY_REPAIR', resource: { kind: 'SOURCE', name: 'freepasserp5/billincar-policy' },
  requestDigest: stableDigest({ provider: 'RP021', products: 47, unlinked: 12, sourceUid: 'pol_freepassstd' }),
  summarize: (value) => ({ count: value.productCount + 2, digest: stableDigest(value) }),
}, () => applyBillincarPolicyRepair());
console.log(JSON.stringify(result));
