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

const headers = {
  Authorization: `Bearer ${consumerToken}`,
  ...(cloudRunIdToken
    ? { 'X-Serverless-Authorization': `Bearer ${cloudRunIdToken}` }
    : {})
};

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers,
    redirect: 'error'
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON response from ${path}: HTTP ${response.status}`);
  }
  return { response, body };
}

const healthPath =
  `/v1/consumers/${encodeURIComponent(consumerId)}/catalog-health`;
const health = await request(healthPath);

if (
  !health.body ||
  health.body.contractVersion !== 'catalog-data-health-v1' ||
  health.body.schemaVersion !== '1.0.0'
) {
  throw new Error(
    `Unexpected Health response contract: HTTP ${health.response.status}`
  );
}

const healthStatus = health.body.status;
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
  activeReleaseId:
    health.body.checks?.activeProjection?.activeReleaseId ?? null,
  projectionEvidenceConsistency:
    health.body.observation?.projectionEvidenceConsistency ?? null
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
