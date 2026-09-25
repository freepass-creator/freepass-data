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
if (
  typeof shadow.contentMatches !== 'boolean' ||
  typeof shadow.orderMatches !== 'boolean'
) {
  throw new Error('Shadow evidence parity flags are missing');
}
const verdictConsistent =
  (shadow.verdict === 'PASS' && shadow.contentMatches && shadow.orderMatches) ||
  (shadow.verdict === 'PASS_CONTENT_ORDER_DIFF_ALLOWED' && shadow.contentMatches && !shadow.orderMatches) ||
  (shadow.verdict === 'FAIL_CONTENT' && !shadow.contentMatches) ||
  (shadow.verdict === 'FAIL_ORDER' && shadow.contentMatches && !shadow.orderMatches);
if (!verdictConsistent) {
  throw new Error('Shadow verdict contradicts parity flags');
}
if (!Number.isFinite(Date.parse(health.generatedAt))) {
  throw new Error('Health evidence generatedAt is missing or invalid');
}
if (!Number.isFinite(Date.parse(shadow.comparedAt))) {
  throw new Error('Shadow evidence comparedAt is missing or invalid');
}
if (!Array.isArray(health.issues)) {
  throw new Error('Health evidence issues must be an array');
}
if (!['ATOMIC', 'PARTIAL_MULTI_READ'].includes(
  health?.observation?.projectionEvidenceConsistency
)) {
  throw new Error('Health projection evidence consistency is missing or invalid');
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

const activeProjection = health?.checks?.activeProjection ?? {};
const activeReleaseId = activeProjection.activeReleaseId ?? null;
if (!activeReleaseId) {
  reasons.push('NO_ACTIVE_RELEASE');
}

const healthRelease = {
  projectionId: activeProjection.projectionId ?? null,
  releaseId: activeReleaseId,
  manifestId: activeProjection.manifestId ?? null,
  inputDigest: activeProjection.canonicalInputDigest?.stored ?? null,
  dataDigest: activeProjection.dataPayloadDigest?.stored ?? null
};
const healthReleaseComplete = Object.values(healthRelease).every(
  (value) => typeof value === 'string' && value.length > 0
);
if (
  activeProjection.status !== 'PASS' ||
  activeProjection.releaseStatus !== 'ACTIVE' ||
  activeProjection.manifestPresent !== true ||
  activeProjection.canonicalInputDigest?.status !== 'PASS' ||
  activeProjection.dataPayloadDigest?.status !== 'PASS' ||
  !healthReleaseComplete
) {
  reasons.push('ACTIVE_RELEASE_EVIDENCE_INCOMPLETE');
}

const shadowRelease = shadow?.freepassRelease ?? null;
const shadowReleaseComplete =
  shadowRelease &&
  ['projectionId', 'releaseId', 'manifestId', 'inputDigest', 'dataDigest']
    .every((key) => typeof shadowRelease[key] === 'string' && shadowRelease[key].length > 0);
if (!shadowReleaseComplete) {
  reasons.push('SHADOW_RELEASE_EVIDENCE_MISSING');
} else if (
  healthReleaseComplete &&
  Object.entries(healthRelease).some(([key, value]) => shadowRelease[key] !== value)
) {
  reasons.push('SHADOW_RELEASE_MISMATCH');
}

const approvedRelease =
  healthReleaseComplete &&
  shadowReleaseComplete &&
  Object.entries(healthRelease).every(([key, value]) => shadowRelease[key] === value)
    ? {
        ...healthRelease,
        observedAt: shadow.comparedAt
      }
    : null;

const result = {
  assessedAt: new Date().toISOString(),
  decision: reasons.length === 0 ? 'GO' : 'HOLD',
  reasons,
  health: {
    status: health.status,
    generatedAt: health.generatedAt ?? null,
    activeReleaseId,
    approvedRelease,
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
