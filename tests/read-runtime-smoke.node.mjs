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

test('local price command retries return the same receipt and already-delivered ACTIVE revision', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/run-memory.mjs', 'api'], {
    cwd: process.cwd(), env: { ...process.env, PORT: '0', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('memory API startup timeout: ' + output)), 10000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); reject(new Error('memory API exited: ' + code + output)); });
      const collect = chunk => {
        output += chunk;
        const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
    });
    const command = { commandId: 'cmd_local_retry', idempotencyKey: 'idem_local_retry',
      expectedRevision: 1, termKey: '36@20000', monthlyRent: { amount: 731000, currency: 'KRW' },
      reason: 'local retry regression', actor: { id: 'user:test', kind: 'USER' } };
    const send = () => fetch(base + '/v1/commands/offers/offer_gv70_demo/price', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command)
    });
    const first = await send();
    assert.equal(first.status, 200, await first.clone().text());
    const receipt = await first.json();
    const before = await fetch(base + '/v1/views/erp-public/products').then(r => r.json());
    const retry = await send();
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.deepEqual(await retry.json(), receipt);
    const after = await fetch(base + '/v1/views/erp-public/products').then(r => r.json());
    assert.deepEqual(after, before);
    assert.match(JSON.stringify(after), /731000/);
  } finally {
    child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  }
});

test('Docker build supplies the script and contract inputs required by packaging', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const buildStage = dockerfile.split('FROM node:22-bookworm-slim AS runtime')[0];
  const beforeBuild = buildStage.split('RUN npm run build')[0];
  assert.match(beforeBuild, /^COPY scripts\/supplier-input-sheet\.mjs scripts\/sheet-presentation\.mjs \.\/scripts\/$/m);
  assert.match(beforeBuild, /^COPY contracts \.\/contracts$/m);
  for (const path of ['scripts/supplier-input-sheet.mjs', 'scripts/sheet-presentation.mjs',
    'contracts/supplier-input-sheet-spec.v1.json', 'contracts/f01-f86-sheet-spec.v1.json']) {
    assert.ok((await readFile(new URL('../' + path, import.meta.url))).length, path);
  }
  assert.match(dockerfile, /^COPY --from=build \/app\/dist \.\/dist$/m);
});

test('built shared-sheet canonical job imports without tsx or source scripts', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      "await import('./dist/src/jobs/ingest-shared-sheet-canonical.js'); console.log('DIST_IMPORT_OK');"],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /DIST_IMPORT_OK/);
});

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

test('ERP required partner/user collections fail closed even when core compatibility payload is valid', async () => {
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(compat));
  }, async url => {
    const result = await run({ READ_RUNTIME_URL: url, READ_RUNTIME_CONSUMER_ID: 'erp-com',
      READ_RUNTIME_TOKEN: 'secret', READ_RUNTIME_CHECK_COMPAT_ONLY: '1', READ_RUNTIME_CHECK_CATALOG: '0',
      READ_RUNTIME_REQUIRED_COMPAT_COLLECTIONS: 'products,policies,partners,users' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Required compatibility collection missing: users/);
    assert.equal(result.stdout, '');
  });
});

test('Canonical checker rejects matching release ID with bridge authority or missing manifest', async () => {
  const catalog = { data: [{}], meta: { consumerId: 'erp-com', projectionId: 'erp-public',
    authority: 'CANONICAL_ACTIVE', schemaVersion: '1.0.0', releaseId: 'rel_test',
    manifestId: 'manifest_test', inputDigest: 'input_digest', dataDigest: 'data_digest' } };
  for (const mutate of [
    x => {},
    x => { x.meta.authority = 'FREEPASS_DATA_COMPATIBILITY_BRIDGE'; },
    x => { delete x.meta.manifestId; },
    x => { x.meta.consumerId = 'another-tenant'; },
    x => { x.data = []; }
  ]) {
    const payload = structuredClone(catalog); mutate(payload);
    await withServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url.endsWith('/catalog-health') ? baseHealth : payload));
    }, async url => {
      const result = await run({ READ_RUNTIME_URL: url, READ_RUNTIME_CONSUMER_ID: 'erp-com',
        READ_RUNTIME_TOKEN: 'secret', READ_RUNTIME_CHECK_COMPAT_ONLY: '0', READ_RUNTIME_CHECK_CATALOG: '1' });
      assert.equal(result.code === 0, payload.meta.authority === 'CANONICAL_ACTIVE' &&
        !!payload.meta.manifestId && payload.meta.consumerId === 'erp-com' && payload.data.length > 0);
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
