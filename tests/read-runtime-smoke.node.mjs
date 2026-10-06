import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const healthContract = JSON.parse(await readFile(
  new URL('../contracts/catalog-data-health-v1.schema.json', import.meta.url),
  'utf8'
));
const healthContractVersion = healthContract.properties.contractVersion.const;
const healthSchemaVersion = healthContract.properties.schemaVersion.const;

function run(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['scripts/check-read-runtime.mjs'],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address missing');
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

const baseHealth = {
  contractVersion: healthContractVersion,
  schemaVersion: healthSchemaVersion,
  scope: 'catalog-v1',
  generatedAt: '2026-09-21T12:00:00.000Z',
  status: 'HEALTHY',
  observation: { projectionEvidenceConsistency: 'ATOMIC' },
  checks: { activeProjection: { activeReleaseId: 'rel_test' } },
  issues: []
};

const compat = {
  schema: 'freepass-data.catalog-compat/v1',
  data: { products: { privateVehicle: { plate: 'PRIVATE_RAW_VALUE' } }, policies: {}, partners: {} },
  meta: { consumerId: 'erp-com', authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE',
    sourceProject: 'freepasserp5', observedAt: '2026-10-06T00:00:00Z',
    collectionCounts: { products: 1, policy: 0, partner: 0 } }
};
test('compatibility-only checks existing transport without claiming ACTIVE or exposing payload', async () => {
  await withServer((request, response) => {
    assert.equal(request.url, '/v1/consumers/erp-com/catalog-compat');
    assert.equal(request.headers.authorization, 'Bearer app-secret');
    assert.equal(request.headers['x-serverless-authorization'], 'Bearer google-secret');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(compat));
  }, async url => {
    const result = await run({ READ_RUNTIME_URL: url, READ_RUNTIME_CONSUMER_ID: 'erp-com',
      READ_RUNTIME_TOKEN: 'app-secret', READ_RUNTIME_CLOUD_RUN_ID_TOKEN: 'google-secret',
      READ_RUNTIME_CHECK_COMPAT_ONLY: '1', READ_RUNTIME_CHECK_CATALOG: '0' });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.canonicalReleaseVerified, false);
    assert.equal(report.cutoverAuthorized, false);
    assert.deepEqual(report.collectionCounts, { products: 1, policies: 0, partners: 0 });
    for (const value of ['PRIVATE_RAW_VALUE', 'privateVehicle', 'app-secret', 'google-secret'])
      assert.equal((result.stdout + result.stderr).includes(value), false);
  });
});
test('compatibility-only rejects identity, authority, collection shape and count drift', async () => {
  for (const mutate of [
    x => { x.meta.consumerId = 'another-tenant'; },
    x => { x.meta.authority = 'CANONICAL_ACTIVE'; },
    x => { x.meta.sourceProject = 'another-project'; },
    x => { x.meta.observedAt = 'invalid'; },
    x => { x.data.products = []; },
    x => { x.data.products.privateVehicle = 'raw'; },
    x => { delete x.data.policies; },
    x => { x.meta.collectionCounts.products = 2; },
    x => { x.data.partners = []; }
  ]) {
    const payload = structuredClone(compat); mutate(payload);
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(payload));
    }, async url => {
      const result = await run({ READ_RUNTIME_URL: url, READ_RUNTIME_CONSUMER_ID: 'erp-com',
        READ_RUNTIME_TOKEN: 'secret', READ_RUNTIME_CHECK_COMPAT_ONLY: '1', READ_RUNTIME_CHECK_CATALOG: '0' });
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.includes('PRIVATE_RAW_VALUE'), false);
    });
  }
});

test('smoke checker rejects the retired catalog health schema version', async () => {
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ...baseHealth, schemaVersion: '1.0.0' }));
  }, async (url) => {
    const result = await run({
      READ_RUNTIME_URL: url,
      READ_RUNTIME_CONSUMER_ID: 'erp-com',
      READ_RUNTIME_TOKEN: 'secret'
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unexpected Health response contract/);
  });
});

test('smoke checker succeeds on HEALTHY and never prints tokens', async () => {
  await withServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer app-secret');
    assert.equal(request.headers['x-serverless-authorization'], 'Bearer google-id-token');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(baseHealth));
  }, async (url) => {
    const result = await run({
      READ_RUNTIME_URL: url,
      READ_RUNTIME_CONSUMER_ID: 'erp-com',
      READ_RUNTIME_TOKEN: 'app-secret',
      READ_RUNTIME_CLOUD_RUN_ID_TOKEN: 'google-id-token'
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"healthStatus": "HEALTHY"/);
    assert.equal(result.stdout.includes('app-secret'), false);
    assert.equal(result.stdout.includes('google-id-token'), false);
  });
});

test('BLOCKED returns non-zero while accepting HTTP 503 as valid transport', async () => {
  await withServer((_request, response) => {
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ...baseHealth, status: 'BLOCKED' }));
  }, async (url) => {
    const result = await run({
      READ_RUNTIME_URL: url,
      READ_RUNTIME_CONSUMER_ID: 'erp-com',
      READ_RUNTIME_TOKEN: 'secret'
    });
    assert.equal(result.code, 2);
    assert.match(result.stdout, /"healthStatus": "BLOCKED"/);
  });
});

test('DEGRADED fails by default and passes only with explicit approval', async () => {
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ...baseHealth, status: 'DEGRADED' }));
  }, async (url) => {
    const common = {
      READ_RUNTIME_URL: url,
      READ_RUNTIME_CONSUMER_ID: 'erp-com',
      READ_RUNTIME_TOKEN: 'secret'
    };
    const denied = await run(common);
    assert.equal(denied.code, 2);

    const allowed = await run({
      ...common,
      READ_RUNTIME_ALLOW_DEGRADED: '1'
    });
    assert.equal(allowed.code, 0, allowed.stderr);
  });
});

test('missing required environment fails before network access', async () => {
  const result = await run({
    READ_RUNTIME_URL: '',
    READ_RUNTIME_CONSUMER_ID: '',
    READ_RUNTIME_TOKEN: ''
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /READ_RUNTIME_URL is required/);
});

test('smoke checker rejects unknown status and missing ACTIVE release', async () => {
  const invalidStatusServer = await startJsonServerForSmoke({
    ...baseHealth,
    status: 'UNKNOWN'
  });
  const missingReleaseServer = await startJsonServerForSmoke({
    ...baseHealth,
    checks: { activeProjection: { activeReleaseId: null } }
  });
  try {
    for (const url of [invalidStatusServer.url, missingReleaseServer.url]) {
      const result = await run({
        READ_RUNTIME_URL: url,
        READ_RUNTIME_CONSUMER_ID: 'erp-com',
        READ_RUNTIME_TOKEN: 'secret'
      });
      assert.notEqual(result.code, 0);
    }
  } finally {
    await Promise.all([invalidStatusServer.close(), missingReleaseServer.close()]);
  }
});

async function startJsonServerForSmoke(payload) {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address missing');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    )
  };
}
