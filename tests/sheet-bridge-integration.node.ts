/** Manual, secret-free peer integration test. No Sheets/Firestore writes.
 * FREEPASS_ERP4_ROOT must point at PR #495's reviewed source checkout.
 * Run from FreePass Data with:
 * npx --no-install tsx --tsconfig "$FREEPASS_ERP4_ROOT/tsconfig.json" --test tests/sheet-bridge-integration.node.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildSheetBridgeHandoff,
  prepareSheetBridgeHandoffs
} from '../src/application/sheet-publication-bridge.js';
import {
  hashSheetPublicationData,
  hashSheetPublicationHandoff,
  validateSheetPublicationHandoff,
  type SheetPublicationHandoff
} from '../src/domain/sheet-publication-handoff.js';
import { ERP5_DOCUMENTS, type Erp5ReadRpc } from '../src/adapters/erp5-source-capture.js';

const peerRoot = process.env.FREEPASS_ERP4_ROOT;
if (!peerRoot) throw new Error('FREEPASS_ERP4_ROOT is required; missing peer is not a PASS');
const pinnedPeer = {
  'lib/server/freepass-data-sheet-handoff.ts': '509bfc35f29b2731aef382b4566baa349102bdc5',
  'lib/server/sales-publish-snapshot.ts': '69db3e8c048ae45c8ef6b6fbe85e9ed13128d2fa',
  'lib/domain/inventory-contract.ts': '2b29adb650b5b08cebc44549a8e0539601ecb52f',
  'lib/domain/plate-registry.ts': '3245e40507f87e3e62583948e3e9170118ca0b38'
};
for (const [file, expected] of Object.entries(pinnedPeer)) {
  const bytes: Buffer = readFileSync(path.join(peerRoot, file));
  const hash: string = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(hash, expected, `Peer source changed: ${file}. Review before updating this pin.`);
}
const peerRequire = createRequire(path.resolve(peerRoot, 'package.json'));
const { materializeFreePassDataSalesSnapshot } = peerRequire(
  path.resolve(peerRoot, 'lib/server/freepass-data-sheet-handoff.ts')
);
const { readSalesPublishSnapshot } = peerRequire(path.resolve(peerRoot, 'lib/server/sales-publish-snapshot.ts'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_SYNTHETIC_TEST'); };
after(() => { globalThis.fetch = originalFetch; });

type Fields = Record<string, unknown>;
function source(options: { idMismatch?: boolean; failPartner?: boolean; drift?: boolean; truncated?: boolean } = {}) {
  const readTime = new Date().toISOString();
  const calls: Array<{ method: string; body: Fields }> = [];
  const first = {
    car_number: { stringValue: '12가3456' },
    vehicle_status: { stringValue: '즉시출고' }, listable: { booleanValue: true },
    status_kind: { stringValue: '가용' }, provider_company_code: { stringValue: 'RP999' },
    source: { stringValue: 'synthetic-only' },
    policy_reference_checked_at: { timestampValue: '2026-09-25T08:00:00.123456789Z' },
    deposit_note: { stringValue: '월 대여료 × 약정연수 (최대 3개월)' },
    price: { mapValue: { fields: {
      '24': { mapValue: { fields: { rent: { integerValue: '700000' }, deposit: { integerValue: '0' } } } }
    } } },
    unknown: { nullValue: null }, disabled: { booleanValue: false }, rawText: { stringValue: '' },
    ...(options.idMismatch ? { _key: { stringValue: 'wrong-document' } } : {})
  };
  const second = {
    car_number: { stringValue: '34나7890' }, vehicle_status: { stringValue: '출고불가' },
    listable: { booleanValue: false }, status_kind: { stringValue: '불가' },
    provider_company_code: { stringValue: 'RP999' }, source: { stringValue: 'synthetic-only' }
  };
  const docs: Record<string, Array<{ id: string; fields: Fields }>> = {
    products: [{ id: 'product-a', fields: first }, { id: 'product-b', fields: second }],
    policy: [{ id: 'policy-a', fields: { policy_code: { stringValue: 'POL-A' } } }],
    partner: [{ id: 'partner-a', fields: { partner_code: { stringValue: 'RP999' } } }]
  };
  const rpc: Erp5ReadRpc = async (method, body) => {
    calls.push({ method, body: structuredClone(body) });
    if (method === 'beginTransaction') {
      assert.deepEqual(body, { options: { readOnly: {} } });
      return { transaction: 'synthetic-read-only-tx' };
    }
    assert.equal(body.transaction, 'synthetic-read-only-tx');
    if (method === 'rollback') return {};
    const query = (body.structuredQuery ?? (body.structuredAggregationQuery as { structuredQuery: unknown }).structuredQuery) as { from: [{ collectionId: string }] };
    assert.deepEqual(Object.keys(query), ['from']);
    const collection = query.from[0].collectionId;
    const group = docs[collection]!;
    if (options.failPartner && collection === 'partner') throw new Error('SYNTHETIC_PARTNER_UNAVAILABLE');
    if (method === 'runAggregationQuery') return [{
      readTime: options.drift && collection === 'partner' ? '2001-01-01T00:00:00Z' : readTime,
      result: { aggregateFields: { total: { integerValue: String(group.length) } } }
    }];
    assert.equal(method, 'runQuery', 'Only read-only RPCs are allowed');
    const rows = options.truncated && collection === 'products' ? group.slice(0, 1) : group;
    return rows.map(({ id, fields }) => ({ readTime, document: {
      name: `${ERP5_DOCUMENTS}/${collection}/${id}`, createTime: readTime, updateTime: readTime, fields
    } }));
  };
  return { rpc, calls, readTime };
}
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function rehash(value: SheetPublicationHandoff) {
  const { handoffHash: _previous, ...unsigned } = value;
  value.handoffHash = hashSheetPublicationHandoff(unsigned);
  return value;
}

test('one capture produces both consumers and round-trips through the actual ERP4 reader', async () => {
  const input = source();
  const prepared = await prepareSheetBridgeHandoffs(input.rpc);
  assert.deepEqual(input.calls.map(x => x.method), [
    'beginTransaction', 'runAggregationQuery', 'runQuery', 'runAggregationQuery', 'runQuery',
    'runAggregationQuery', 'runQuery', 'rollback'
  ]);
  assert.equal(prepared.handoffs.length, 2);
  const [f01, f86] = prepared.handoffs;
  assert.deepEqual(f01!.approvedRelease, f86!.approvedRelease);
  assert.equal(f01!.manifest.sourceReadTime, input.readTime);
  assert.equal(f01!.generatedAt, f86!.generatedAt);
  assert.notEqual(f01!.handoffHash, f86!.handoffHash, 'Target identity belongs to the envelope hash');
  const directory = mkdtempSync(path.join(tmpdir(), 'freepass-peer-test-'));
  try {
    for (const handoff of prepared.handoffs) {
      assert.deepEqual(validateSheetPublicationHandoff(wire(handoff)), { status: 'PASS', violations: [] });
      const adapted = materializeFreePassDataSalesSnapshot(wire(handoff));
      assert.equal(adapted.releaseAuthority, 'LEGACY_VERIFIED_BRIDGE');
      assert.deepEqual(adapted.products, handoff.snapshot.products);
      assert.deepEqual(adapted.policies, handoff.snapshot.policies);
      assert.deepEqual(adapted.partners, handoff.snapshot.partners);
      const file = path.join(directory, `${handoff.workbook}.json`);
      writeFileSync(file, JSON.stringify(adapted));
      const readback = readSalesPublishSnapshot(file);
      assert.deepEqual(readback, adapted);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unknown and zero values remain distinct; a deposit rule is not rewritten as no-deposit', async () => {
  const { handoffs } = await prepareSheetBridgeHandoffs(source().rpc);
  const row = materializeFreePassDataSalesSnapshot(wire(handoffs[0]!)).products[0];
  assert.equal(row.unknown, null);
  assert.equal(row.disabled, false);
  assert.equal(row.rawText, '');
  assert.equal('year' in row, false);
  assert.equal('trim_name' in row, false);
  assert.equal((row.price as any)['24'].deposit, 0);
  assert.equal((row.price as any)['24'].rent, 700000);
  assert.equal(row.deposit_note, '월 대여료 × 약정연수 (최대 3개월)');
  assert.deepEqual(row.policy_reference_checked_at, {
    _seconds: Date.parse('2026-09-25T08:00:00Z') / 1000,
    _nanoseconds: 123456789
  });
});

test('same capture, target and generation time give deterministic bytes', async () => {
  const { bridge, handoffs } = await prepareSheetBridgeHandoffs(source().rpc);
  assert.deepEqual(buildSheetBridgeHandoff(bridge, 'F01', handoffs[0]!.generatedAt), handoffs[0]);
  const f01 = handoffs[0]!, f86 = handoffs[1]!;
  f01.snapshot.products[0]!.rawText = 'local mutation';
  assert.equal(f86.snapshot.products[0]!.rawText, '');
  assert.equal(bridge.products[0]!.rawText, '');
});

test('data digest excludes envelope metadata, while handoff digest still covers it', async () => {
  const { handoffs } = await prepareSheetBridgeHandoffs(source().rpc);
  const original = handoffs[0]!;
  const changed = wire(original);
  changed.snapshot.snapshotId = 'different-envelope';
  assert.equal(hashSheetPublicationData(changed.snapshot), original.approvedRelease.dataDigest);
  assert.ok(validateSheetPublicationHandoff(changed).violations.includes('HANDOFF_HASH_MISMATCH'));
});

test('crossed F01/F86 identity is rejected after rehashing the envelope', async () => {
  const { handoffs } = await prepareSheetBridgeHandoffs(source().rpc);
  const value = wire(handoffs[0]!); value.consumerId = 'google-sheets-f86'; rehash(value);
  assert.ok(validateSheetPublicationHandoff(value).violations.includes('CONSUMER_WORKBOOK_MISMATCH'));
  assert.throws(() => materializeFreePassDataSalesSnapshot(value), /consumer\/workbook mismatch/);
});

test('payload tampering is caught even after the outer handoff hash is recomputed', async () => {
  const { handoffs } = await prepareSheetBridgeHandoffs(source().rpc);
  const value = wire(handoffs[0]!); value.snapshot.products[0]!.rawText = 'changed'; rehash(value);
  assert.ok(validateSheetPublicationHandoff(value).violations.includes('SNAPSHOT_DATA_DIGEST_MISMATCH'));
  assert.throws(() => materializeFreePassDataSalesSnapshot(value), /data digest mismatch/);
});

test('wrong manifest count is rejected by both implementations', async () => {
  const { handoffs } = await prepareSheetBridgeHandoffs(source().rpc);
  const value = wire(handoffs[0]!); value.manifest.partnerCount++; rehash(value);
  assert.ok(validateSheetPublicationHandoff(value).violations.includes('MANIFEST_EVIDENCE_MISMATCH'));
  assert.throws(() => materializeFreePassDataSalesSnapshot(value), /manifest evidence mismatch/);
});

test('missing manifest returns explicit HOLD rather than TypeError', async () => {
  const { handoffs } = await prepareSheetBridgeHandoffs(source().rpc);
  const value = wire(handoffs[0]!); delete (value as Partial<SheetPublicationHandoff>).manifest; rehash(value);
  assert.equal(validateSheetPublicationHandoff(value).status, 'HOLD');
  assert.throws(() => materializeFreePassDataSalesSnapshot(value), /manifest missing/);
});

test('Firestore path and payload _key mismatch is not silently corrected', async () => {
  await assert.rejects(prepareSheetBridgeHandoffs(source({ idMismatch: true }).rpc), /SHEET_SOURCE_DOCUMENT_ID_MISMATCH/);
});

for (const [name, options, pattern] of [
  ['partner failure', { failPartner: true }, /SYNTHETIC_PARTNER_UNAVAILABLE/],
  ['read-time drift', { drift: true }, /SHEET_SOURCE_READ_TIME_DRIFT/],
  ['truncated collection', { truncated: true }, /INCOMPLETE_SHEET_SOURCE_COLLECTION/]
] as const) {
  test(`${name} aborts both outputs and closes the read-only transaction`, async () => {
    const input = source(options);
    await assert.rejects(prepareSheetBridgeHandoffs(input.rpc), pattern);
    assert.equal(input.calls.filter(x => x.method === 'rollback').length, 1);
    assert.equal(input.calls.at(-1)!.method, 'rollback');
  });
}

test('invalid target sets fail before reading storage', async () => {
  const input = source();
  for (const targets of [[], ['F01', 'F01'], ['F99']]) {
    await assert.rejects(prepareSheetBridgeHandoffs(input.rpc, targets as Array<'F01' | 'F86'>), /INVALID_SHEET_HANDOFF_TARGETS/);
  }
  assert.equal(input.calls.length, 0);
});

test('existing single-workbook use remains supported', async () => {
  const { handoffs } = await prepareSheetBridgeHandoffs(source().rpc, ['F86']);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0]!.workbook, 'F86');
  assert.doesNotThrow(() => materializeFreePassDataSalesSnapshot(wire(handoffs[0]!)));
});
