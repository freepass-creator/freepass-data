import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function startJsonServer(payload) {
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

const row = (id, amount = 1000) => ({
  productId: id,
  displayName: id,
  offers: [{
    offerId: `offer-${id}`,
    supplierId: 'supplier',
    priceTerms: [{
      termKey: '36@20000',
      monthlyRent: { amount, currency: 'KRW' }
    }]
  }]
});

test('shadow CLI passes matching catalogs and fails content mismatch', async () => {
  const oldServer = await startJsonServer({ data: [row('a'), row('b')] });
  const sameServer = await startJsonServer({ data: [row('a'), row('b')] });
  const changedServer = await startJsonServer({ data: [row('a', 2000), row('c')] });

  try {
    const common = {
      SHADOW_OLD_URL: oldServer.url,
      SHADOW_MAX_IDS: '10'
    };

    const pass = await run('scripts/check-catalog-shadow.mjs', {
      ...common,
      SHADOW_NEW_URL: sameServer.url
    });
    assert.equal(pass.code, 0, pass.stderr);
    assert.match(pass.stdout, /"verdict": "PASS"/);

    const fail = await run('scripts/check-catalog-shadow.mjs', {
      ...common,
      SHADOW_NEW_URL: changedServer.url
    });
    assert.equal(fail.code, 2);
    assert.match(fail.stdout, /"verdict": "FAIL_CONTENT"/);
    assert.match(fail.stdout, /"mismatched": 1/);
    assert.equal(fail.stdout.includes('2000'), false);
  } finally {
    await Promise.all([
      oldServer.close(),
      sameServer.close(),
      changedServer.close()
    ]);
  }
});

test('shadow CLI separates content parity from order parity', async () => {
  const oldServer = await startJsonServer({ data: [row('a'), row('b')] });
  const reorderedServer = await startJsonServer({ data: [row('b'), row('a')] });

  try {
    const env = {
      SHADOW_OLD_URL: oldServer.url,
      SHADOW_NEW_URL: reorderedServer.url
    };

    const strict = await run('scripts/check-catalog-shadow.mjs', env);
    assert.equal(strict.code, 2);
    assert.match(strict.stdout, /"verdict": "FAIL_ORDER"/);

    const relaxed = await run('scripts/check-catalog-shadow.mjs', {
      ...env,
      SHADOW_REQUIRE_ORDER: '0'
    });
    assert.equal(relaxed.code, 0, relaxed.stderr);
    assert.match(
      relaxed.stdout,
      /"verdict": "PASS_CONTENT_ORDER_DIFF_ALLOWED"/
    );
  } finally {
    await Promise.all([oldServer.close(), reorderedServer.close()]);
  }
});

test('cutover readiness CLI returns GO/HOLD from evidence summaries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'freepass-cutover-'));
  try {
    const healthPath = path.join(dir, 'health.json');
    const shadowPath = path.join(dir, 'shadow.json');

    const healthy = {
      contractVersion: 'catalog-data-health-v1',
      schemaVersion: '1.0.0',
      generatedAt: '2026-09-21T12:00:00.000Z',
      status: 'HEALTHY',
      observation: { projectionEvidenceConsistency: 'ATOMIC' },
      checks: { activeProjection: { activeReleaseId: 'rel_test' } },
      issues: []
    };
    const shadowPass = {
      verdict: 'PASS',
      contentMatches: true,
      orderMatches: true,
      counts: { left: 2, right: 2 },
      comparedAt: '2026-09-21T12:01:00.000Z'
    };

    await writeFile(healthPath, JSON.stringify(healthy));
    await writeFile(shadowPath, JSON.stringify(shadowPass));

    const common = {
      CUTOVER_HEALTH_JSON: healthPath,
      CUTOVER_SHADOW_JSON: shadowPath
    };

    const go = await run('scripts/assess-cutover-readiness.mjs', common);
    assert.equal(go.code, 0, go.stderr);
    assert.match(go.stdout, /"decision": "GO"/);

    await writeFile(
      healthPath,
      JSON.stringify({ ...healthy, status: 'BLOCKED' })
    );
    const blocked = await run('scripts/assess-cutover-readiness.mjs', common);
    assert.equal(blocked.code, 2);
    assert.match(blocked.stdout, /"HEALTH_BLOCKED"/);

    await writeFile(
      healthPath,
      JSON.stringify({ ...healthy, status: 'DEGRADED' })
    );
    const degraded = await run('scripts/assess-cutover-readiness.mjs', common);
    assert.equal(degraded.code, 2);
    assert.match(degraded.stdout, /"HEALTH_DEGRADED_NOT_APPROVED"/);

    const approved = await run('scripts/assess-cutover-readiness.mjs', {
      ...common,
      CUTOVER_ALLOW_DEGRADED: '1'
    });
    assert.equal(approved.code, 0, approved.stderr);
    assert.match(approved.stdout, /"decision": "GO"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cutover readiness fails closed on invalid evidence contracts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'freepass-cutover-invalid-'));
  try {
    const healthPath = path.join(dir, 'health.json');
    const shadowPath = path.join(dir, 'shadow.json');
    await writeFile(healthPath, JSON.stringify({
      contractVersion: 'wrong',
      schemaVersion: '1.0.0',
      status: 'HEALTHY'
    }));
    await writeFile(shadowPath, JSON.stringify({ verdict: 'PASS' }));

    const result = await run('scripts/assess-cutover-readiness.mjs', {
      CUTOVER_HEALTH_JSON: healthPath,
      CUTOVER_SHADOW_JSON: shadowPath
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unsupported Health evidence contract/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cutover readiness rejects a PASS verdict that contradicts parity evidence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'freepass-cutover-contradiction-'));
  try {
    const healthPath = path.join(dir, 'health.json');
    const shadowPath = path.join(dir, 'shadow.json');
    await writeFile(healthPath, JSON.stringify({
      contractVersion: 'catalog-data-health-v1',
      schemaVersion: '1.0.0',
      generatedAt: '2026-09-21T12:00:00.000Z',
      status: 'HEALTHY',
      observation: { projectionEvidenceConsistency: 'ATOMIC' },
      checks: { activeProjection: { activeReleaseId: 'rel_test' } },
      issues: []
    }));
    await writeFile(shadowPath, JSON.stringify({
      verdict: 'PASS',
      contentMatches: false,
      orderMatches: true,
      comparedAt: '2026-09-21T12:01:00.000Z'
    }));

    const result = await run('scripts/assess-cutover-readiness.mjs', {
      CUTOVER_HEALTH_JSON: healthPath,
      CUTOVER_SHADOW_JSON: shadowPath
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /contradicts parity flags/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
