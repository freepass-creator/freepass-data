import { describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SINGLE_PRODUCT_FACT_FIELDS, SINGLE_POLICY_FACT_FIELDS, SINGLE_PARTNER_FACT_FIELDS, SINGLE_PRODUCT_PRICE_FIELDS } from '../src/infra/erp5-compat-catalog-reader.js';
const helperPath = '../scripts/verify-single-product-readback.mjs';
const helper = await import(helperPath);
const id = helper.PRODUCT_ID;
const sha = 'a'.repeat(40);
const iso = '2026-10-12T00:00:00.000Z';
const pair = { seconds: Date.parse(iso) / 1000, nanoseconds: 123 };
const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
  'x-freepass-read-mode': 'DIRECT_FIRESTORE_REQUIRED', 'x-freepass-migration-status': 'LEGACY_READ_PENDING_RETIREMENT',
  'x-freepass-migration-instruction': 'Read stored canonical data directly from Firestore in your platform server using an authorized read identity; do not recalculate or use legacy fallback.',
  link: '<https://github.com/freepass-creator/freepass-data/blob/main/docs/COMMERCIAL-DATA-CONSUMER-ROLLOUT.md#firestore-direct-read-migration>; rel="deprecation"' };
function snapshot() {
  return { schema: 'freepass-data.catalog-compat/v1', data: { products: { [id]: { _key: id,
    price: { '36_2만': { rent: 100, deposit: null, depositState: 'UNKNOWN' } } } }, policies: {}, partners: {} },
  meta: { consumerId: 'erp-com', authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE', sourceProject: 'freepasserp5',
    observedAt: iso, readAt: iso, readTimeExact: { ...pair }, collectionCounts: { products: 1, policies: 0, partners: 0 },
    depositEvidenceVersion: 'catalog-compat-deposit/1', selection: 'SINGLE_PRODUCT', readScope: 'SINGLE_PRODUCT', selectedProductId: id,
    documentVersions: { product: { id, updateTime: iso, updateTimeExact: { ...pair } }, policies: [], partners: [] },
    linkedFacts: { policy: { state: 'UNKNOWN', reasonCode: 'POLICY_REFERENCE_NOT_OBSERVED' }, partner: { state: 'UNKNOWN', reasonCode: 'PARTNER_REFERENCE_NOT_OBSERVED' } } } };
}
function options(full: unknown = snapshot()) {
  const fetchImpl = vi.fn(async (_url: URL, _init: RequestInit) => {
    const index = fetchImpl.mock.calls.length;
    return new Response(index === 1 ? JSON.stringify(snapshot()) : '{}', { status: [200, 401, 403][index - 1]!, headers });
  });
  return { sourceSha: helper.SOURCE_SHA, workflowSha: sha, helperSha: sha, full,
    consumerJson: JSON.stringify([{ id: 'erp-com', token: 'catalog-secret' }, { id: 'erp5-public-media', token: 'photos-secret' }]),
    baseUrl: 'https://existing-service.run.app', idToken: 'same-cloud-run-token', fetchImpl };
}
describe('trusted bounded single-product runtime readback', () => {
  it.each(['8af86d3b84020a402e21ec3c34a8498bd3066148', '7a02e85475ffb4a3f1d417987403a3fa3e6b3be8', '2ebdb18822416847b2019f6506b7b0d65daf0ee2', '57abb8a978457b87068c3c9c9d76cc8116934bd5', 'd42c4f58d939d7899457730cd1a82f419b3eade8', 'bd03f33b9bdedfb8f49ad8717062b32784e9a08a'])('verifies only reviewed exact source %s with three requests', async sourceSha => {
    const input = options(); expect(await helper.verifyReadback({ ...input, sourceSha })).toBe(true);
    expect(input.fetchImpl).toHaveBeenCalledTimes(3);
    expect(helper.SOURCE_SHAS).toHaveLength(6);
  });
  it('binds all five reviewed source SHAs at every workflow helper gate', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8');
    const gates = workflow.split('\n').filter(line => line.includes("'8af86d3b84020a402e21ec3c34a8498bd3066148'"));
    expect(gates).toHaveLength(5);
    expect(gates.every(line => line.includes("'7a02e85475ffb4a3f1d417987403a3fa3e6b3be8'"))).toBe(true);
    expect(gates.every(line => line.includes("'2ebdb18822416847b2019f6506b7b0d65daf0ee2'"))).toBe(true);
    expect(gates.every(line => line.includes("'57abb8a978457b87068c3c9c9d76cc8116934bd5'"))).toBe(true);
    expect(gates.every(line => line.includes("'d42c4f58d939d7899457730cd1a82f419b3eade8'"))).toBe(true);
    expect(gates.every(line => line.includes("'bd03f33b9bdedfb8f49ad8717062b32784e9a08a'"))).toBe(true);
  });
  it('makes exactly three GETs for one ID, reuses Cloud Run identity and omits consumer authorization for 401', async () => {
    const input = options(); expect(await helper.verifyReadback(input)).toBe(true);
    expect(input.fetchImpl).toHaveBeenCalledTimes(3);
    input.fetchImpl.mock.calls.forEach(([url, init], index) => {
      expect(decodeURIComponent(url.pathname).split('/').at(-1)).toBe(id);
      expect(init.method).toBe('GET'); expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ 'X-Serverless-Authorization': 'Bearer same-cloud-run-token' });
      if (index === 1) expect(init.headers).not.toHaveProperty('Authorization');
    });
    expect(input.fetchImpl.mock.calls[2]![0].pathname).toContain('/erp5-public-media/');
  });
  it.each(['missing', 'key', 'policy', 'partner', 'linked'] as const)('selection %s fails before any GET', async kind => {
    const full = snapshot() as any;
    if (kind === 'missing') delete full.data.products[id];
    if (kind === 'key') full.data.products[id]._key = 'other';
    if (kind === 'policy') Object.assign(full.data.products[id], { policy_code: 'P1', policy_id: 'P2' });
    if (kind === 'partner') Object.assign(full.data.products[id], { provider_company_code: 'RP031', partner_code: 'RP002' });
    if (kind === 'linked') { full.data.products[id].policy_code = 'P1'; full.data.policies.P1 = { _key: 'P1', policy_code: 'P2' }; }
    const input = options(full); await expect(helper.verifyReadback(input)).rejects.toThrow('SINGLE_PRODUCT_READBACK_FAILED');
    expect(input.fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['source', 'helper', 'tokens', 'destination'] as const)('invalid %s binding fails without GET', async kind => {
    const input = options();
    if (kind === 'source') input.sourceSha = sha;
    if (kind === 'helper') input.helperSha = 'b'.repeat(40);
    if (kind === 'tokens') input.consumerJson = '[]';
    if (kind === 'destination') input.baseUrl = 'https://other.invalid';
    await expect(helper.verifyReadback(input)).rejects.toThrow(); expect(input.fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['partner_code', 'company_code', 'provider_company_code'])('linked partner %s conflict stops before any GET', async code => {
    const full = snapshot() as any; full.data.products[id].provider_company_code = 'RP031';
    full.data.partners.RP031 = { _key: 'RP031', [code]: 'RP002' };
    const input = options(full); await expect(helper.verifyReadback(input)).rejects.toThrow(); expect(input.fetchImpl).not.toHaveBeenCalled();
  });
  it('binds known response references and verifies private cache control', () => {
    const value = snapshot() as any;
    value.data.products[id].policy_code = 'P1'; value.data.policies.P2 = { _key: 'P2', policy_code: 'P2' };
    value.meta.collectionCounts.policies = 1;
    value.meta.documentVersions.policies = [{ id: 'P2', updateTime: iso, updateTimeExact: pair }];
    value.meta.linkedFacts.policy = { state: 'KNOWN', reasonCode: null };
    expect(() => helper.validateProduct(value, new Headers(headers))).toThrow();
    expect(() => helper.validateProduct(snapshot(), new Headers({ ...headers, 'cache-control': 'no-store' }))).toThrow();
  });
  it.each([1, 2, 3])('unexpected status in request %i stops without retry', async at => {
    const input = options(); const original = input.fetchImpl.getMockImplementation()!;
    input.fetchImpl.mockImplementation(async (url, init) => input.fetchImpl.mock.calls.length === at
      ? new Response('{}', { status: 500, headers }) : original(url, init));
    await expect(helper.verifyReadback(input)).rejects.toThrow(); expect(input.fetchImpl).toHaveBeenCalledTimes(at);
  });
  it.each(['schema', 'nanos-range', 'nanos-order', 'extra-product', 'linked-count', 'unknown', 'deposit', 'private', 'header'] as const)('rejects %s response', async kind => {
    const value = snapshot() as any; const h = new Headers(headers);
    if (kind === 'schema') value.schema = 'other';
    if (kind === 'nanos-range') value.meta.readTimeExact.nanoseconds = 1e9;
    if (kind === 'nanos-order') value.meta.documentVersions.product.updateTimeExact.nanoseconds = 124;
    if (kind === 'extra-product') value.data.products.other = { _key: 'other' };
    if (kind === 'linked-count') value.meta.collectionCounts.policies = 1;
    if (kind === 'unknown') value.meta.linkedFacts.policy.state = 'KNOWN';
    if (kind === 'deposit') value.data.products[id].price['36_2만'].deposit = 0;
    if (kind === 'private') value.data.products[id].credential = 'hidden';
    if (kind === 'header') h.delete('x-content-type-options');
    expect(() => helper.validateProduct(value, h)).toThrow('SINGLE_PRODUCT_READBACK_FAILED');
  });
  it.each([{ deposit: 0, depositState: 'ZERO' }, { deposit: 100, depositState: 'KNOWN' }])('accepts normalized deposit %j', price => {
    const value = snapshot() as any; value.data.products[id].price['36_2만'] = price;
    expect(helper.validateProduct(value, new Headers(headers))).toBe(true);
  });
  it('bounds streaming bytes even without Content-Length and cancels the reader', async () => {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(helper.BODY_LIMIT)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
    await expect(helper.boundedBody(new Response(body))).rejects.toThrow(); expect(cancelled).toBe(true);
  });
  it('rejects oversized declared bodies', async () => {
    await expect(helper.boundedBody(new Response('small', { headers: { 'content-length': String(helper.BODY_LIMIT + 1) } }))).rejects.toThrow();
  });
  it('aborts one absolute deadline and never starts the remaining requests', async () => {
    const input = options(); input.fetchImpl.mockImplementation(async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await expect(helper.verifyReadback({ ...input, deadlineMs: 5 })).rejects.toThrow(); expect(input.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('keeps verifier positive fields equal to the existing response contract', () => {
    expect(helper.PRODUCT_FIELDS).toEqual([...SINGLE_PRODUCT_FACT_FIELDS]);
    expect(helper.POLICY_FIELDS).toEqual([...SINGLE_POLICY_FACT_FIELDS]);
    expect(helper.PARTNER_FIELDS).toEqual([...SINGLE_PARTNER_FACT_FIELDS]);
    expect(helper.PRICE_FIELDS).toEqual([...SINGLE_PRODUCT_PRICE_FIELDS]);
  });
  it('preserves trusted helper before checkout and reads the deploy secret once', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8');
    const deploy = workflow.split('\n  verify:')[0]!;
    expect(deploy).toContain('git show "$GITHUB_SHA:scripts/verify-single-product-readback.mjs"');
    expect(deploy.indexOf('git show "$GITHUB_SHA:scripts/verify-single-product-readback.mjs"')).toBeLessThan(deploy.indexOf('ref: ${{ steps.runtime-source.outputs.sha }}'));
    // 비밀 읽기는 지정한 두 단계에서만 각각 정확히 1회, 그 밖의 모든 단계에서는 0회:
    //  - 'Verify IAM denial and authenticated compatibility readback'(읽기 확인, 항상)
    //  - 'Verify photo consumer secret before enabling the photo ID gate'(사진 ID 게이트를 켤 때만, 값은 버리고 존재·권한·형식만)
    const stepBlocks = deploy.split(/\n      - (?=name: |uses: )/).slice(1);
    const stepName = (block: string) => /^name: (.+)$/m.exec(block)?.[1]?.trim() ?? '(uses)';
    const reads = stepBlocks.map(block => ({ name: stepName(block), count: (block.match(/gcloud secrets versions access/g) ?? []).length }));
    const allowed = new Set(['Verify IAM denial and authenticated compatibility readback', 'Verify photo consumer secret before enabling the photo ID gate']);
    for (const read of reads) expect({ name: read.name, count: read.count }).toEqual({ name: read.name, count: allowed.has(read.name) ? 1 : 0 });
    expect(reads.filter(read => allowed.has(read.name))).toHaveLength(2);
    // 배포 전 검증 단계: 실행 추적 끔, 조회·검증 명령의 stdout·stderr 모두 폐기, 실패 시 고정 문구만.
    const photoVerify = stepBlocks.find(block => stepName(block) === 'Verify photo consumer secret before enabling the photo ID gate')!;
    expect(photoVerify).toContain('set +x');
    expect(photoVerify.indexOf('set +x')).toBeLessThan(photoVerify.indexOf('gcloud secrets versions access'));
    expect(photoVerify).toMatch(/gcloud secrets versions access[^\n]*2>\/dev\/null/);
    expect(photoVerify).toMatch(/jq -e [^\n]*>\/dev\/null 2>&1/);
    expect(photoVerify).toContain('::error::소비처 비밀');
    expect(photoVerify).not.toMatch(/set -[a-z]*x|echo[^\n]*\$\{?consumers_json/);
    expect(deploy).toContain('READBACK_CONSUMERS_JSON="$consumers_json" COMPAT_RESPONSE_FILE="$response_file"');
    expect(deploy).toContain('Clean trusted readback helper');
  });
  it.each(['missing', 'key', 'ref', 'code'] as const)('reports safe selection reason %s with zero requests', async kind => {
    const full = snapshot() as any;
    const reasons = { missing: 'PRODUCT_NOT_OBSERVED', key: 'KEY_CONFLICT', ref: 'REFERENCE_CONFLICT', code: 'RELATED_CODE_CONFLICT' };
    if (kind === 'missing') delete full.data.products[id];
    if (kind === 'key') full.data.products[id]._key = 'private-id';
    if (kind === 'ref') Object.assign(full.data.products[id], { policy_id: 'private-P1', policy_code: 'private-P2' });
    if (kind === 'code') { full.data.products[id].provider_company_code = 'RP031'; full.data.partners.RP031 = { _key: 'RP031', company_code: 'private-code' }; }
    const input = options(full); const onDiagnostic = vi.fn();
    await expect(helper.verifyReadback({ ...input, onDiagnostic })).rejects.toMatchObject({ diagnostic: { phase: 'SELECT_PRODUCT', requestCount: 0, lastStatus: 0, reason: reasons[kind] } });
    expect(onDiagnostic).toHaveBeenCalledTimes(1); expect(input.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/private-|10가8099/);
  });
  it.each(['VALIDATE_HEADERS', 'VALIDATE_SCHEMA', 'VALIDATE_META', 'VALIDATE_PRODUCT', 'VALIDATE_PRICE', 'VALIDATE_LINKED'])('reports %s after one 200 and starts no further GET', async phase => {
    const value = snapshot() as any; const h = new Headers(headers);
    if (phase === 'VALIDATE_HEADERS') h.delete('cache-control');
    if (phase === 'VALIDATE_SCHEMA') value.schema = 'private-schema';
    if (phase === 'VALIDATE_META') value.meta.readTimeExact.nanoseconds = 1e9;
    if (phase === 'VALIDATE_PRODUCT') value.data.products[id].secret = 'private-secret';
    if (phase === 'VALIDATE_PRICE') value.data.products[id].price['36_2만'].deposit = 0;
    if (phase === 'VALIDATE_LINKED') value.meta.linkedFacts.policy.state = 'KNOWN';
    const input = options(); input.fetchImpl.mockImplementation(async () => new Response(JSON.stringify(value), { status: 200, headers: h }));
    await expect(helper.verifyReadback(input)).rejects.toMatchObject({ diagnostic: { phase, requestCount: 1, lastStatus: 200, reason: 'VALIDATION_FAILED' } });
    expect(input.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([2, 3])('reports actual last status and attempt count for rejected request %i', async at => {
    const input = options(); const original = input.fetchImpl.getMockImplementation()!;
    input.fetchImpl.mockImplementation(async (url, init) => input.fetchImpl.mock.calls.length === at ? new Response('{}', { status: 500 }) : original(url, init));
    await expect(helper.verifyReadback(input)).rejects.toMatchObject({ diagnostic: { phase: `BODY_${at}`, requestCount: at, lastStatus: 500, reason: 'HTTP_STATUS_UNEXPECTED' } });
    expect(input.fetchImpl).toHaveBeenCalledTimes(at);
  });
  it('reports body deadline failure after observing 200 and starts no subsequent GET', async () => {
    const input = options();
    input.fetchImpl.mockImplementation(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener('abort', () => controller.error(new Error('private transport error')), { once: true });
    } }), { status: 200, headers }));
    await expect(helper.verifyReadback({ ...input, deadlineMs: 5 })).rejects.toMatchObject({ diagnostic: { phase: 'BODY_1', requestCount: 1, lastStatus: 200, reason: 'DEADLINE_EXCEEDED' } });
    expect(input.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('sanitizes arbitrary transport errors and forged diagnostic fields', async () => {
    const input = options(); input.fetchImpl.mockImplementation(async () => { throw new Error('https://private.invalid/?token=secret private-id'); });
    await expect(helper.verifyReadback(input)).rejects.toMatchObject({ message: 'SINGLE_PRODUCT_READBACK_FAILED', diagnostic: { phase: 'REQUEST_1', requestCount: 1, lastStatus: 0, reason: 'UNEXPECTED_FAILURE' } });
    const text = helper.diagnosticLines({ phase: 'secret\nINJECT=true', reason: 'private-id', requestCount: 4, lastStatus: 'token' }, false);
    expect(text).toContain('PHASE=TRUST_PREFLIGHT'); expect(text).toContain('REQUEST_COUNT=0');
    expect(text).not.toMatch(/secret|INJECT|private-id|token/);
  });
  it('CLI emits only safe enums/numbers/boolean and no file path, ID, token or raw error', () => {
    const folder = mkdtempSync(join(tmpdir(), 'single-product-diagnostic-')), file = join(folder, 'private-response.json');
    try {
      writeFileSync(file, JSON.stringify({ schema: 'freepass-data.catalog-compat/v1', data: { products: {}, policies: {}, partners: {} } }));
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/verify-single-product-readback.mjs', import.meta.url))], { encoding: 'utf8',
        env: { ...process.env, EXPECTED_SOURCE_SHA: helper.SOURCE_SHA, WORKFLOW_SOURCE_SHA: sha, SINGLE_PRODUCT_HELPER_SHA: sha,
          COMPAT_RESPONSE_FILE: file, READBACK_CONSUMERS_JSON: 'private-json-secret', CLOUD_RUN_ID_TOKEN: 'private-id-token', READ_RUNTIME_DEPLOYED_URL: 'https://private-service.run.app' } });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('SINGLE_PRODUCT_READBACK_REASON=PRODUCT_NOT_OBSERVED');
      expect(result.stdout).toContain('SINGLE_PRODUCT_READBACK_REQUEST_COUNT=0');
      expect(result.stderr).toBe('SINGLE_PRODUCT_READBACK_OK=false\n');
      expect(result.stdout + result.stderr).not.toMatch(/private-|10가8099|https:|Error|\.json|\.mjs/);
    } finally { unlinkSync(file); rmdirSync(folder); }
  });
  it('verify-only restores the trusted helper and reuses one existing secret read without deployment', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8');
    const verify = workflow.split('\n  verify:')[1]!;
    expect(verify).toContain('Preserve trusted verification helper');
    expect(verify).toContain('git show "$GITHUB_SHA:scripts/verify-single-product-readback.mjs"');
    expect(verify).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(verify.match(/gcloud secrets versions access/g)).toHaveLength(1);
    expect(verify).toContain('READBACK_CONSUMERS_JSON="$consumers_json" COMPAT_RESPONSE_FILE="$response_file"');
    expect(verify).toContain('SINGLE_PRODUCT_READBACK_PHASE:-NOT_RUN');
    expect(verify).toContain('Clean trusted verification helper');
    expect(verify).not.toMatch(/gcloud run deploy|gcloud run services update/);
  });
});
