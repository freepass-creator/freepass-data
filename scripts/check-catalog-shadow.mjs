import { compareCatalogs } from './catalog-shadow-lib.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const oldUrl = required('SHADOW_OLD_URL');
const newUrl = required('SHADOW_NEW_URL');
const requireOrder = process.env.SHADOW_REQUIRE_ORDER !== '0';
const maxIds = Number(process.env.SHADOW_MAX_IDS ?? 50);

if (!Number.isInteger(maxIds) || maxIds < 0 || maxIds > 500) {
  throw new Error('SHADOW_MAX_IDS must be an integer from 0 to 500');
}

function headers(prefix) {
  const appAuth = process.env[`${prefix}_AUTHORIZATION`];
  const serverless = process.env[`${prefix}_SERVERLESS_AUTHORIZATION`];
  return {
    ...(appAuth ? { Authorization: appAuth } : {}),
    ...(serverless ? { 'X-Serverless-Authorization': serverless } : {})
  };
}

async function load(url, prefix) {
  const response = await fetch(url, {
    headers: headers(prefix),
    redirect: 'error'
  });
  if (!response.ok) {
    throw new Error(`${prefix} catalog request failed: HTTP ${response.status}`);
  }
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new Error(`${prefix} catalog response is not JSON`);
  }
  return response.json();
}

const [oldPayload, newPayload] = await Promise.all([
  load(oldUrl, 'SHADOW_OLD'),
  load(newUrl, 'SHADOW_NEW')
]);

const result = compareCatalogs(oldPayload, newPayload);
const trim = (values) => values.slice(0, maxIds);

function releaseEvidence(payload) {
  const meta = payload?.meta;
  if (!meta || typeof meta !== 'object') return null;
  const keys = ['projectionId', 'releaseId', 'manifestId', 'inputDigest', 'dataDigest'];
  for (const key of keys) {
    if (typeof meta[key] !== 'string' || !meta[key]) return null;
  }
  return {
    projectionId: meta.projectionId,
    releaseId: meta.releaseId,
    manifestId: meta.manifestId,
    inputDigest: meta.inputDigest,
    dataDigest: meta.dataDigest
  };
}

const summary = {
  comparedAt: new Date().toISOString(),
  verdict: !result.contentMatches
    ? 'FAIL_CONTENT'
    : requireOrder && !result.orderMatches
      ? 'FAIL_ORDER'
      : result.orderMatches
        ? 'PASS'
        : 'PASS_CONTENT_ORDER_DIFF_ALLOWED',
  contentMatches: result.contentMatches,
  orderMatches: result.orderMatches,
  requireOrder,
  freepassRelease: releaseEvidence(newPayload),
  counts: result.counts,
  sampleIds: {
    missingOnRight: trim(result.ids.missingOnRight),
    missingOnLeft: trim(result.ids.missingOnLeft),
    mismatched: trim(result.ids.mismatched)
  },
  truncated: {
    missingOnRight: result.ids.missingOnRight.length > maxIds,
    missingOnLeft: result.ids.missingOnLeft.length > maxIds,
    mismatched: result.ids.mismatched.length > maxIds
  },
  digests: result.digests
};

console.log(JSON.stringify(summary, null, 2));

if (!result.contentMatches || (requireOrder && !result.orderMatches)) {
  process.exitCode = 2;
}
