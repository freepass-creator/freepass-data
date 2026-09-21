import { readFile } from 'node:fs/promises';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const healthPath = required('CUTOVER_HEALTH_JSON');
const shadowPath = required('CUTOVER_SHADOW_JSON');
const allowDegraded = process.env.CUTOVER_ALLOW_DEGRADED === '1';
const allowOrderDiff = process.env.CUTOVER_ALLOW_ORDER_DIFF === '1';

async function load(path, label) {
  const raw = await readFile(path, 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return value;
}

const [health, shadow] = await Promise.all([
  load(healthPath, 'Health evidence'),
  load(shadowPath, 'Shadow evidence')
]);

if (
  health?.contractVersion !== 'catalog-data-health-v1' ||
  health?.schemaVersion !== '1.0.0'
) {
  throw new Error('Unsupported Health evidence contract');
}

if (!['HEALTHY', 'DEGRADED', 'BLOCKED'].includes(health.status)) {
  throw new Error('Invalid Health status');
}

const allowedShadow = new Set([
  'PASS',
  'PASS_CONTENT_ORDER_DIFF_ALLOWED',
  'FAIL_CONTENT',
  'FAIL_ORDER'
]);
if (!allowedShadow.has(shadow?.verdict)) {
  throw new Error('Invalid shadow verdict');
}

const reasons = [];

if (health.status === 'BLOCKED') {
  reasons.push('HEALTH_BLOCKED');
} else if (health.status === 'DEGRADED' && !allowDegraded) {
  reasons.push('HEALTH_DEGRADED_NOT_APPROVED');
}

if (shadow.verdict === 'FAIL_CONTENT') {
  reasons.push('SHADOW_CONTENT_MISMATCH');
}
if (
  shadow.verdict === 'FAIL_ORDER' ||
  (shadow.verdict === 'PASS_CONTENT_ORDER_DIFF_ALLOWED' && !allowOrderDiff)
) {
  reasons.push('SHADOW_ORDER_MISMATCH');
}

const activeReleaseId =
  health?.checks?.activeProjection?.activeReleaseId ?? null;
if (!activeReleaseId) {
  reasons.push('NO_ACTIVE_RELEASE');
}

const result = {
  assessedAt: new Date().toISOString(),
  decision: reasons.length === 0 ? 'GO' : 'HOLD',
  reasons,
  health: {
    status: health.status,
    generatedAt: health.generatedAt ?? null,
    activeReleaseId,
    projectionEvidenceConsistency:
      health?.observation?.projectionEvidenceConsistency ?? null,
    issueCount: Array.isArray(health.issues)
      ? health.issues.length
      : null
  },
  shadow: {
    verdict: shadow.verdict,
    contentMatches: shadow.contentMatches ?? null,
    orderMatches: shadow.orderMatches ?? null,
    counts: shadow.counts ?? null,
    comparedAt: shadow.comparedAt ?? null
  },
  approvals: {
    allowDegraded,
    allowOrderDiff
  }
};

console.log(JSON.stringify(result, null, 2));

if (result.decision !== 'GO') {
  process.exitCode = 2;
}
