import { readFile } from 'node:fs/promises';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const baseUrl = required('READ_RUNTIME_URL').replace(/\/+$/, '');
const consumerId = required('READ_RUNTIME_CONSUMER_ID');
const consumerToken = required('READ_RUNTIME_TOKEN');
const cloudRunIdToken = process.env.READ_RUNTIME_CLOUD_RUN_ID_TOKEN;
const allowDegraded = process.env.READ_RUNTIME_ALLOW_DEGRADED === '1';
const checkCatalog = process.env.READ_RUNTIME_CHECK_CATALOG === '1';
const checkCompatOnly = process.env.READ_RUNTIME_CHECK_COMPAT_ONLY === '1';
if (checkCompatOnly && checkCatalog) throw new Error('Select compatibility transport or Canonical release check');
const requiredCompatCollections = (process.env.READ_RUNTIME_REQUIRED_COMPAT_COLLECTIONS ?? 'products,policies')
  .split(',').map(value => value.trim());
if (requiredCompatCollections.some(key => !['products', 'policies', 'partners', 'users', 'vehicleMaster'].includes(key)))
  throw new Error('Invalid required compatibility collection');
const healthContract = JSON.parse(await readFile(
  new URL('../contracts/catalog-data-health-v1.schema.json', import.meta.url),
  'utf8'
));
const expectedHealthContractVersion = healthContract?.properties?.contractVersion?.const;
const expectedHealthSchemaVersion = healthContract?.properties?.schemaVersion?.const;
if (
  typeof expectedHealthContractVersion !== 'string' || !expectedHealthContractVersion ||
  typeof expectedHealthSchemaVersion !== 'string' || !expectedHealthSchemaVersion
) {
  throw new Error('Catalog Health schema has no fixed contract identity');
}

const headers = {
  Authorization: `Bearer ${consumerToken}`,
  ...(cloudRunIdToken
    ? { 'X-Serverless-Authorization': `Bearer ${cloudRunIdToken}` }
    : {})
};

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000)
  });
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new Error(`Non-JSON response from ${path}: HTTP ${response.status}`);
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON response from ${path}: HTTP ${response.status}`);
  }
  return { response, body };
}

if (checkCompatOnly) {
  const { response, body } = await request(`/v1/consumers/${encodeURIComponent(consumerId)}/catalog-compat`);
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (response.status !== 200 || body?.schema !== 'freepass-data.catalog-compat/v1' ||
      body?.meta?.consumerId !== consumerId || body?.meta?.authority !== 'FREEPASS_DATA_COMPATIBILITY_BRIDGE' ||
      body?.meta?.sourceProject !== 'freepasserp5' || !Number.isFinite(Date.parse(body?.meta?.observedAt)) ||
      !record(body?.data) || !record(body?.meta?.collectionCounts)) {
    throw new Error(`Compatibility response invalid: HTTP ${response.status}`);
  }
  const counts = {};
  for (const key of requiredCompatCollections) {
    if (!record(body.data[key])) throw new Error(`Required compatibility collection missing: ${key}`);
  }
  for (const [key, countKey] of Object.entries({ products: 'products', policies: 'policy',
    partners: 'partner', users: 'user', vehicleMaster: 'vehicle_master' })) {
    const value = body.data[key];
    if (value === undefined && !['products', 'policies'].includes(key)) continue;
    if (!record(value) || !Object.values(value).every(record) ||
        body.meta.collectionCounts[countKey] !== Object.keys(value).length) {
      throw new Error(`Compatibility collection invalid: ${key}`);
    }
    counts[key] = Object.keys(value).length;
  }
  console.log(JSON.stringify({ transportOk: true, httpStatus: response.status,
    authority: body.meta.authority, consumerId, observedAt: body.meta.observedAt,
    collectionCounts: counts, canonicalReleaseVerified: false, cutoverAuthorized: false,
    requiredCollections: requiredCompatCollections,
    status: 'COMPATIBILITY_TRANSPORT_VERIFIED_CANONICAL_HOLD' }, null, 2));
} else {
const healthPath =
  `/v1/consumers/${encodeURIComponent(consumerId)}/catalog-health`;
const health = await request(healthPath);

if (
  !health.body ||
  health.body.contractVersion !== expectedHealthContractVersion ||
  health.body.schemaVersion !== expectedHealthSchemaVersion
) {
  throw new Error(
    `Unexpected Health response contract: HTTP ${health.response.status}`
  );
}

const healthStatus = health.body.status;
if (!['HEALTHY', 'DEGRADED', 'BLOCKED'].includes(healthStatus)) {
  throw new Error(`Invalid Health status: ${String(healthStatus)}`);
}
if (!Number.isFinite(Date.parse(health.body.generatedAt))) {
  throw new Error('Health generatedAt is missing or invalid');
}
if (!Array.isArray(health.body.issues)) {
  throw new Error('Health issues must be an array');
}
const activeReleaseId = health.body.checks?.activeProjection?.activeReleaseId;
if (typeof activeReleaseId !== 'string' || !activeReleaseId) {
  throw new Error('Health has no ACTIVE release identity');
}
const projectionEvidenceConsistency =
  health.body.observation?.projectionEvidenceConsistency;
if (!['ATOMIC', 'PARTIAL_MULTI_READ'].includes(projectionEvidenceConsistency)) {
  throw new Error('Health projection evidence consistency is missing or invalid');
}
const expectedHttp =
  healthStatus === 'BLOCKED' ? 503 : 200;

if (health.response.status !== expectedHttp) {
  throw new Error(
    `Health HTTP/status mismatch: HTTP ${health.response.status}, status ${healthStatus}`
  );
}

const summary = {
  transportOk: true,
  httpStatus: health.response.status,
  healthStatus,
  contractVersion: health.body.contractVersion,
  schemaVersion: health.body.schemaVersion,
  generatedAt: health.body.generatedAt,
  issueCount: Array.isArray(health.body.issues)
    ? health.body.issues.length
    : null,
  activeReleaseId,
  projectionEvidenceConsistency
};

if (checkCatalog) {
  const catalogPath =
    `/v1/consumers/${encodeURIComponent(consumerId)}/catalog`;
  const catalog = await request(catalogPath);
  if (catalog.response.status !== 200) {
    throw new Error(
      `Catalog read failed: HTTP ${catalog.response.status}`
    );
  }
  if (
    !catalog.body ||
    !Array.isArray(catalog.body.data) ||
    catalog.body.data.length === 0 ||
    catalog.body.meta?.consumerId !== consumerId ||
    catalog.body.meta?.projectionId !== 'erp-public' ||
    catalog.body.meta?.authority !== 'CANONICAL_ACTIVE' ||
    catalog.body.meta?.schemaVersion !== '1.0.0' ||
    !['manifestId', 'inputDigest', 'dataDigest'].every(key =>
      typeof catalog.body.meta?.[key] === 'string' && catalog.body.meta[key].trim()) ||
    typeof catalog.body.meta?.releaseId !== 'string' ||
    !catalog.body.meta.releaseId ||
    catalog.body.meta.releaseId !== activeReleaseId
  ) {
    throw new Error('Catalog response metadata is incomplete or does not match Health');
  }
  summary.catalog = {
    releaseId: catalog.body?.meta?.releaseId ?? null,
    schemaVersion: catalog.body?.meta?.schemaVersion ?? null,
    revision: catalog.body?.meta?.revision ?? null,
    productCount: Array.isArray(catalog.body?.data)
      ? catalog.body.data.length
      : null
  };
}

console.log(JSON.stringify(summary, null, 2));

if (healthStatus === 'BLOCKED') {
  process.exitCode = 2;
} else if (healthStatus === 'DEGRADED' && !allowDegraded) {
  process.exitCode = 2;
}
}
