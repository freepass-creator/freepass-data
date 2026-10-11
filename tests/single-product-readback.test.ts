import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
    expect(deploy.match(/gcloud secrets versions access/g)).toHaveLength(1);
    expect(deploy).toContain('READBACK_CONSUMERS_JSON="$consumers_json" COMPAT_RESPONSE_FILE="$response_file"');
    expect(deploy).toContain('Clean trusted readback helper');
  });
});
