import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

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
  contractVersion: 'catalog-data-health-v1',
  schemaVersion: '1.0.0',
  scope: 'catalog-v1',
  generatedAt: '2026-09-21T12:00:00.000Z',
  status: 'HEALTHY',
  observation: { projectionEvidenceConsistency: 'ATOMIC' },
  checks: { activeProjection: { activeReleaseId: 'rel_test' } },
  issues: []
};

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
