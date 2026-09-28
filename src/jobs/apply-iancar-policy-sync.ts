import { stableDigest } from '../shared/stable-digest.js';
import { applyIancarPolicySync, type IancarPolicySyncInput } from '../infra/iancar-policy-sync-firestore.js';
import { createJobDataAccessRuntime } from './data-access-runtime.js';

const raw = await new Promise<string>((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (x) => { data += x; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});
const input = JSON.parse(raw) as IancarPolicySyncInput;
const runtime = createJobDataAccessRuntime();
const result = await runtime.access.write({
  context: {
    actor: { id: 'service:freepass-data-iancar-policy-sync', kind: 'SERVICE' },
    clientId: 'job:apply-iancar-policy-sync',
    purpose: 'apply the approved exact Iancar policy mapping with private backup and readback',
  },
  operation: 'WRITE_IANCAR_POLICY_SYNC',
  resource: { kind: 'SOURCE', name: 'freepasserp5/iancar-policy' },
  requestDigest: stableDigest(input),
  summarize: (value) => ({
    count: value.matched,
    digest: stableDigest({ counts: value.counts, policies: value.policies }),
  }),
}, () => applyIancarPolicySync(input));

console.log(JSON.stringify(result));
