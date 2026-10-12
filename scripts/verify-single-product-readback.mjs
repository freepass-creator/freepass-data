import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const SOURCE_SHA = '8af86d3b84020a402e21ec3c34a8498bd3066148';
export const SOURCE_SHAS = Object.freeze([SOURCE_SHA, '7a02e85475ffb4a3f1d417987403a3fa3e6b3be8', '2ebdb18822416847b2019f6506b7b0d65daf0ee2', '57abb8a978457b87068c3c9c9d76cc8116934bd5', 'd42c4f58d939d7899457730cd1a82f419b3eade8', 'bd03f33b9bdedfb8f49ad8717062b32784e9a08a']);
export const PRODUCT_ID = '10하8099';
export const BODY_LIMIT = 1024 * 1024;
const REASONS = new Set(['VALIDATION_FAILED', 'FULL_COMPAT_INVALID', 'PRODUCT_NOT_OBSERVED', 'KEY_CONFLICT', 'REFERENCE_CONFLICT', 'RELATED_CODE_CONFLICT', 'TRUST_BINDING_INVALID', 'AUTH_BINDING_INVALID', 'BODY_LIMIT_EXCEEDED', 'BODY_INVALID', 'HTTP_STATUS_UNEXPECTED', 'DEADLINE_EXCEEDED', 'UNEXPECTED_FAILURE', 'NONE']);
const PHASES = new Set(['TRUST_PREFLIGHT', 'SELECT_PRODUCT', 'AUTH_PREFLIGHT', 'REQUEST_1', 'REQUEST_2', 'REQUEST_3', 'BODY_1', 'BODY_2', 'BODY_3', 'VALIDATE_HEADERS', 'VALIDATE_SCHEMA', 'VALIDATE_META', 'VALIDATE_PRODUCT', 'VALIDATE_PRICE', 'VALIDATE_LINKED', 'SUCCESS']);
class ReadbackError extends Error { constructor(reason) { super('SINGLE_PRODUCT_READBACK_FAILED'); this.reason = reason; } }
const fail = (reason = 'VALIDATION_FAILED') => { throw new ReadbackError(reason); };
export function safeDiagnostic(value) {
  return { phase: PHASES.has(value?.phase) ? value.phase : 'TRUST_PREFLIGHT',
    requestCount: Number.isInteger(value?.requestCount) && value.requestCount >= 0 && value.requestCount <= 3 ? value.requestCount : 0,
    lastStatus: Number.isInteger(value?.lastStatus) && value.lastStatus >= 100 && value.lastStatus <= 599 ? value.lastStatus : 0,
    reason: REASONS.has(value?.reason) ? value.reason : 'UNEXPECTED_FAILURE' };
}
export function diagnosticLines(value, ok) {
  const d = safeDiagnostic(value);
  return `SINGLE_PRODUCT_READBACK_OK=${ok === true}\nSINGLE_PRODUCT_READBACK_PHASE=${d.phase}\nSINGLE_PRODUCT_READBACK_REQUEST_COUNT=${d.requestCount}\nSINGLE_PRODUCT_READBACK_LAST_STATUS=${d.lastStatus}\nSINGLE_PRODUCT_READBACK_REASON=${d.reason}\n`;
}
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const scalar = v => v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)
  || typeof v === 'string' && v.length <= 300 && !/[\u0000-\u001f\u007f]|https?:\/\/|AIza|ya29\./i.test(v);
const fields = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k) && scalar(v[k]));
const priceKey = k => typeof k === 'string' && k.length > 0 && k.length <= 80
  && !['__proto__', 'constructor', 'prototype'].includes(k) && !/[\u0000-\u001f\u007f]|https?:\/\/|<[^>]*>|AIza|ya29\./i.test(k);
// Verification allowlists mirror the bounded response contract; they do not assign policy meaning.
export const PRODUCT_FIELDS = '_key product_code provider_company_code partner_code provider_name partner_name deposit_note policy_id policy_code _deleted deletedAt status vehicle_status status_kind listable publication_withdrawal car_number vehicle_uid maker model sub_model trim_name trim_extra variant fuel_type engine_type engine_cc drive_type transmission vehicle_class product_type year seats mileage annual_mileage ext_color int_color first_registration_date price iancar_phase_one iancar_policy_terms'.split(' ');
export const POLICY_FIELDS = '_key policy_code companyId provider_company_code policy_name policy_type payment_method payment_timing basic_driver_age driver_age_lowering driver_age_upper_limit license_period personal_driver_scope business_driver_scope insurance_included deposit_installment deposit_card_payment rental_card_payment maintenance_service credit_grade'.split(' ');
export const PARTNER_FIELDS = '_key partner_code company_code provider_company_code partner_name company_name name brand_name alias'.split(' ');
export const PRICE_FIELDS = 'rent deposit depositState deposit_state depositStatusLabel depositEvidenceReason depositEvidenceBasis depositRuleDifference'.split(' ');
const ref = (row, primary, secondary) => {
  const a = row[primary], b = row[secondary];
  for (const value of [a, b]) if (value != null && value !== '' && (typeof value !== 'string' || value.trim() !== value || value.length > 200 || /[\/\\\u0000-\u001f\u007f]/.test(value))) fail('REFERENCE_CONFLICT');
  if (a && b && a !== b) fail('REFERENCE_CONFLICT');
  return a || b || undefined;
};
export function selectProduct(full) {
  if (full?.schema !== 'freepass-data.catalog-compat/v1' || !object(full.data?.products)
    || !object(full.data.policies) || !object(full.data.partners)) fail('FULL_COMPAT_INVALID');
  const row = full.data.products[PRODUCT_ID];
  if (!object(row)) fail('PRODUCT_NOT_OBSERVED');
  if (row._key !== PRODUCT_ID) fail('KEY_CONFLICT');
  for (const [name, id, codes] of [['policies', ref(row, 'policy_code', 'policy_id'), ['policy_code']],
    ['partners', ref(row, 'provider_company_code', 'partner_code'), ['partner_code', 'company_code', 'provider_company_code']]]) {
    if (id && Object.hasOwn(full.data[name], id)) {
      const linked = full.data[name][id];
      if (!object(linked) || linked._key !== id || codes.some(code => linked[code] != null && linked[code] !== '' && linked[code] !== id)) fail('RELATED_CODE_CONFLICT');
    }
  }
  return PRODUCT_ID;
}
const stamp = (pair, iso) => exact(pair, ['seconds', 'nanoseconds']) && Number.isSafeInteger(pair.seconds)
  && Number.isInteger(pair.nanoseconds) && pair.nanoseconds >= 0 && pair.nanoseconds < 1e9
  && typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(iso)
  && Date.parse(iso) === pair.seconds * 1000 + Math.floor(pair.nanoseconds / 1e6);
export function validateProduct(value, headers, note = () => {}) {
  note('VALIDATE_HEADERS');
  const cache = headers.get('cache-control')?.split(',').map(v => v.trim().toLowerCase());
  if (!cache?.includes('private') || !cache.includes('no-store')) fail();
  for (const [key, wanted] of [['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'],
    ['x-freepass-read-mode', 'DIRECT_FIRESTORE_REQUIRED'], ['x-freepass-migration-status', 'LEGACY_READ_PENDING_RETIREMENT']]) {
    const actual = headers.get(key);
    if (key === 'cache-control' ? !actual?.split(',').map(v => v.trim().toLowerCase()).includes(wanted) : actual !== wanted) fail();
  }
  if (headers.get('x-freepass-migration-instruction') !== 'Read stored canonical data directly from Firestore in your platform server using an authorized read identity; do not recalculate or use legacy fallback.'
    || headers.get('link') !== '<https://github.com/freepass-creator/freepass-data/blob/main/docs/COMMERCIAL-DATA-CONSUMER-ROLLOUT.md#firestore-direct-read-migration>; rel="deprecation"') fail();
  note('VALIDATE_SCHEMA');
  if (!exact(value, ['schema', 'data', 'meta']) || value.schema !== 'freepass-data.catalog-compat/v1'
    || !exact(value.data, ['products', 'policies', 'partners']) || !exact(value.data.products, [PRODUCT_ID])) fail();
  const { data, meta } = value;
  note('VALIDATE_META');
  if (!exact(meta, ['consumerId', 'authority', 'sourceProject', 'observedAt', 'collectionCounts', 'depositEvidenceVersion', 'selection', 'readScope', 'selectedProductId', 'readAt', 'readTimeExact', 'documentVersions', 'linkedFacts'])
    || meta.consumerId !== 'erp-com' || meta.authority !== 'FREEPASS_DATA_COMPATIBILITY_BRIDGE' || meta.sourceProject !== 'freepasserp5'
    || meta.depositEvidenceVersion !== 'catalog-compat-deposit/1' || meta.selection !== 'SINGLE_PRODUCT' || meta.readScope !== 'SINGLE_PRODUCT'
    || meta.selectedProductId !== PRODUCT_ID || meta.observedAt !== meta.readAt || !stamp(meta.readTimeExact, meta.readAt)
    || !exact(meta.collectionCounts, ['products', 'policies', 'partners']) || meta.collectionCounts.products !== 1
    || !exact(meta.documentVersions, ['product', 'policies', 'partners']) || !exact(meta.linkedFacts, ['policy', 'partner'])) fail();
  const version = v => exact(v, ['id', 'updateTime', 'updateTimeExact']) && stamp(v.updateTimeExact, v.updateTime)
    && (v.updateTimeExact.seconds < meta.readTimeExact.seconds || v.updateTimeExact.seconds === meta.readTimeExact.seconds && v.updateTimeExact.nanoseconds <= meta.readTimeExact.nanoseconds);
  if (!version(meta.documentVersions.product) || meta.documentVersions.product.id !== PRODUCT_ID) fail();
  const product = data.products[PRODUCT_ID];
  note('VALIDATE_PRODUCT');
  if (!object(product) || product._key !== PRODUCT_ID || !fields(Object.fromEntries(Object.entries(product).filter(([k]) => !['price', 'iancar_phase_one', 'iancar_policy_terms'].includes(k))), PRODUCT_FIELDS)) fail();
  note('VALIDATE_PRICE');
  if (product.price != null) {
    if (!object(product.price) || Object.keys(product.price).length > 200) fail();
    for (const [key, row] of Object.entries(product.price)) {
      if (!priceKey(key) || !object(row) || Object.keys(row).some(k => !PRICE_FIELDS.includes(k)
        || (k === 'depositEvidenceBasis' ? !fields(row[k], ['field', 'text', 'source', 'at'])
          : k === 'depositRuleDifference' ? !fields(row[k], ['ruleAmount', 'ruleCode', 'differs']) : !scalar(row[k])))) fail();
      if (!Object.hasOwn(row, 'deposit') || !['KNOWN', 'ZERO', 'UNKNOWN'].includes(row.depositState)
        || row.depositState === 'UNKNOWN' && row.deposit !== null || row.depositState === 'ZERO' && row.deposit !== 0
        || row.depositState === 'KNOWN' && !(typeof row.deposit === 'number' && Number.isFinite(row.deposit) && row.deposit > 0)
        || Object.hasOwn(row, 'deposit_state') && row.deposit_state !== row.depositState) fail();
    }
  }
  if (product.iancar_phase_one != null) {
    note('VALIDATE_PRODUCT');
    const phase = product.iancar_phase_one;
    if (!object(phase) || !fields(Object.fromEntries(Object.entries(phase).filter(([k]) => k !== 'priceAliases')), ['policyStage'])
      || Object.hasOwn(phase, 'priceAliases') && (!object(phase.priceAliases) || Object.keys(phase.priceAliases).length > 200
        || Object.entries(phase.priceAliases).some(([k, v]) => !priceKey(k) || !priceKey(v)))) fail();
  }
  if (product.iancar_policy_terms != null) {
    // 이안카 차량별 보험·추가요금 조건: 고정 키·자료형만(src/domain/iancar-policy-terms-projection.ts 와 같은 규칙).
    note('VALIDATE_PRODUCT');
    const t = product.iancar_policy_terms;
    const ints = ['minimumDriverAge', 'maximumDriverAge', 'minimumLicenseMonths', 'ownDamageDeductible', 'ownDamageMinimumFaultPercent', 'personalInjuryDeductible', 'propertyDamageDeductible', 'repairLimit', 'perPanelRepair', 'excessMileageFeePerKm'];
    const all = ['source', 'observedAt', ...ints, 'ownDamageIncluded', 'vatIncluded', 'age24Surcharge', 'dailyLossOrLateReturnFeeByTerm'];
    const int = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000;
    if (!object(t) || Object.keys(t).length !== all.length || Object.keys(t).some(k => !all.includes(k)) || t.source !== 'ONE_RATES'
      || typeof t.observedAt !== 'string' || t.observedAt.length > 40 || !Number.isFinite(Date.parse(t.observedAt)) || !ints.every(k => int(t[k]))
      || typeof t.ownDamageIncluded !== 'boolean' || typeof t.vatIncluded !== 'boolean'
      || !(t.age24Surcharge === null || int(t.age24Surcharge) || (typeof t.age24Surcharge === 'string' && t.age24Surcharge.length > 0 && t.age24Surcharge.length <= 20))
      || !object(t.dailyLossOrLateReturnFeeByTerm) || Object.keys(t.dailyLossOrLateReturnFeeByTerm).length > 200
      || Object.entries(t.dailyLossOrLateReturnFeeByTerm).some(([k, v]) => !/^[0-9]{1,3}_(월|연)[0-9]{1,6}km$/.test(k) || k.length > 40 || !int(v))) fail();
  }
  note('VALIDATE_LINKED');
  for (const [name, singular, allowed] of [['policies', 'policy', POLICY_FIELDS], ['partners', 'partner', PARTNER_FIELDS]]) {
    const rows = data[name], versions = meta.documentVersions[name], fact = meta.linkedFacts[singular];
    const reference = singular === 'policy' ? ref(product, 'policy_code', 'policy_id') : ref(product, 'provider_company_code', 'partner_code');
    const codes = singular === 'policy' ? ['policy_code'] : ['partner_code', 'company_code', 'provider_company_code'];
    if (!object(rows) || !Array.isArray(versions) || versions.length !== Object.keys(rows).length
      || meta.collectionCounts[name] !== versions.length || new Set(versions.map(v => v?.id)).size !== versions.length
      || versions.some(v => !version(v) || typeof v.id !== 'string' || v.id !== reference || !Object.hasOwn(rows, v.id) || !fields(rows[v.id], allowed) || rows[v.id]._key !== v.id
        || codes.some(code => rows[v.id][code] != null && rows[v.id][code] !== '' && rows[v.id][code] !== v.id))
      || !exact(fact, ['state', 'reasonCode']) || !(fact.state === 'KNOWN' && fact.reasonCode === null && versions.length === 1
        || fact.state === 'UNKNOWN' && versions.length === 0 && fact.reasonCode === `${singular.toUpperCase()}_${reference ? '' : 'REFERENCE_'}NOT_OBSERVED`)) fail();
  }
  return true;
}
export async function boundedBody(response) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) { await response.body?.cancel(); fail('BODY_LIMIT_EXCEEDED'); }
  if (!response.body) fail('BODY_INVALID');
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > BODY_LIMIT) { await reader.cancel(); fail('BODY_LIMIT_EXCEEDED'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function verifyReadback({ sourceSha, workflowSha, helperSha, full, consumerJson, baseUrl, idToken, fetchImpl = fetch, deadlineMs = 30000, onDiagnostic = () => {} }) {
  const state = { phase: 'TRUST_PREFLIGHT', requestCount: 0, lastStatus: 0, reason: 'NONE' };
  let controller, timer;
  try {
  if (!SOURCE_SHAS.includes(sourceSha) || !/^[a-f0-9]{40}$/.test(workflowSha ?? '') || helperSha !== workflowSha) fail('TRUST_BINDING_INVALID');
  state.phase = 'SELECT_PRODUCT';
  const selected = selectProduct(full); // Selection must finish before the first request.
  state.phase = 'AUTH_PREFLIGHT';
  const consumers = JSON.parse(consumerJson);
  if (!Array.isArray(consumers)) fail('AUTH_BINDING_INVALID');
  const token = id => {
    const matches = consumers.filter(v => v?.id === id);
    if (matches.length !== 1 || typeof matches[0].token !== 'string' || !matches[0].token || /[\r\n]/.test(matches[0].token)) fail('AUTH_BINDING_INVALID');
    return matches[0].token;
  };
  const erp = token('erp-com'), photos = token('erp5-public-media');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.run.app') || base.username || base.password || base.pathname !== '/' || base.search || base.hash || !idToken || /[\r\n]/.test(idToken)) fail('AUTH_BINDING_INVALID');
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30000) fail();
  controller = new AbortController(); timer = setTimeout(() => controller.abort(), deadlineMs);
  const deadline = Date.now() + deadlineMs;
    for (const [consumer, auth, status] of [['erp-com', erp, 200], ['erp-com', undefined, 401], ['erp5-public-media', photos, 403]]) {
      if (controller.signal.aborted || Date.now() >= deadline) fail('DEADLINE_EXCEEDED');
      const headers = { 'X-Serverless-Authorization': `Bearer ${idToken}` };
      if (auth) headers.Authorization = `Bearer ${auth}`;
      state.requestCount++; state.phase = `REQUEST_${state.requestCount}`;
      const response = await fetchImpl(new URL(`/v1/consumers/${consumer}/catalog-compat/products/${encodeURIComponent(selected)}`, base),
        { method: 'GET', headers, redirect: 'error', signal: controller.signal });
      state.lastStatus = response.status; state.phase = `BODY_${state.requestCount}`;
      const body = await boundedBody(response);
      if (controller.signal.aborted || Date.now() >= deadline) fail('DEADLINE_EXCEEDED');
      if (response.status !== status) fail('HTTP_STATUS_UNEXPECTED');
      if (status === 200) { state.phase = 'VALIDATE_SCHEMA'; validateProduct(JSON.parse(body), response.headers, phase => { state.phase = phase; }); }
    }
    state.phase = 'SUCCESS'; onDiagnostic(safeDiagnostic(state));
    return true;
  } catch (error) {
    state.reason = controller?.signal.aborted ? 'DEADLINE_EXCEEDED' : error instanceof ReadbackError ? error.reason : 'UNEXPECTED_FAILURE';
    const diagnostic = safeDiagnostic(state); onDiagnostic(diagnostic);
    const safe = new ReadbackError(diagnostic.reason); safe.diagnostic = diagnostic; throw safe;
  } finally { if (timer) clearTimeout(timer); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let diagnostic;
    await verifyReadback({ sourceSha: process.env.EXPECTED_SOURCE_SHA, workflowSha: process.env.WORKFLOW_SOURCE_SHA,
      helperSha: process.env.SINGLE_PRODUCT_HELPER_SHA, full: JSON.parse(await readFile(process.env.COMPAT_RESPONSE_FILE, 'utf8')),
      consumerJson: process.env.READBACK_CONSUMERS_JSON, baseUrl: process.env.READ_RUNTIME_DEPLOYED_URL, idToken: process.env.CLOUD_RUN_ID_TOKEN,
      onDiagnostic: value => { diagnostic = value; } });
    process.stdout.write(diagnosticLines(diagnostic, true));
  } catch (error) { process.stdout.write(diagnosticLines(error?.diagnostic, false)); process.stderr.write('SINGLE_PRODUCT_READBACK_OK=false\n'); process.exitCode = 1; }
}
