import { describe, expect, it, vi } from 'vitest';
import { normalizePeriodFeeLedgerRow, readConsistentPeriodFeeLedgerRows } from '../src/infra/period-fee-ledger-firestore-readback.js';
import { listActivePeriodFeeLedgerRows } from '../src/infra/period-fee-ledger-firestore-reader.js';
import { pickLedgerRowForContract, resolveContractFeeLink } from '../src/application/contract-fee-link.js';
import { stableDigest } from '../src/shared/stable-digest.js';
import type { Firestore } from 'firebase-admin/firestore';
import type { PeriodFeeLedgerRow, PeriodFeeSnapshotRun } from '../src/domain/period-fee-ledger.js';
import type { ActorRef, EntityMeta, Offer, PriceTerm, Product, VehicleAsset } from '../src/domain/catalog.js';

const firestoreState = vi.hoisted(() => ({ db: null as FakeFirestore | null }));

vi.mock('firebase-admin/firestore', async importOriginal => ({
  ...(await importOriginal<typeof import('firebase-admin/firestore')>()),
  getFirestore: () => firestoreState.db,
}));

vi.mock('../src/infra/firebase-target.js', () => ({ getTargetFirebaseApp: () => ({}) }));

type Rec = Record<string, unknown>;

class FakeDocSnap {
  constructor(readonly id: string, private readonly value: Rec | undefined) {}
  get exists() { return this.value !== undefined; }
  data() { return this.value; }
}

class FakeQuerySnap {
  readonly size: number;
  constructor(readonly docs: FakeDocSnap[]) {
    this.size = docs.length;
  }
}

class FakeCollection {
  constructor(
    private readonly docs: Map<string, Rec>,
    private readonly filters: Array<[string, unknown]> = [],
    private readonly range: { startAt?: string; endBefore?: string; startAfter?: string; limit?: number } = {},
  ) {}
  doc(id: string) {
    return { get: async () => new FakeDocSnap(id, this.docs.get(id)) };
  }
  where(field: string, op: string, value: unknown) {
    if (op !== '==') throw new Error(`TEST-FAKE_UNSUPPORTED_WHERE_${op}`);
    return new FakeCollection(this.docs, [...this.filters, [field, value]], this.range);
  }
  orderBy(field: string) {
    if (field !== '__name__') throw new Error(`TEST-FAKE_UNSUPPORTED_ORDER_BY_${field}`);
    return this;
  }
  startAt(value: string) {
    return new FakeCollection(this.docs, this.filters, { ...this.range, startAt: value });
  }
  endBefore(value: string) {
    return new FakeCollection(this.docs, this.filters, { ...this.range, endBefore: value });
  }
  startAfter(cursor: FakeDocSnap) {
    return new FakeCollection(this.docs, this.filters, { ...this.range, startAfter: cursor.id });
  }
  limit(value: number) {
    return new FakeCollection(this.docs, this.filters, { ...this.range, limit: value });
  }
  async get() {
    const docs = [...this.docs.entries()]
      .filter(([, data]) => this.filters.every(([field, value]) => data[field] === value))
      .filter(([id]) => this.range.startAt === undefined || id >= this.range.startAt)
      .filter(([id]) => this.range.endBefore === undefined || id < this.range.endBefore)
      .filter(([id]) => this.range.startAfter === undefined || id > this.range.startAfter)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, this.range.limit)
      .map(([id, data]) => new FakeDocSnap(id, data));
    return new FakeQuerySnap(docs);
  }
}

class FakeFirestore {
  constructor(private readonly collections: Record<string, Record<string, Rec>>) {}
  collection(name: string) {
    return new FakeCollection(new Map(Object.entries(this.collections[name] ?? {})));
  }
}

const actor: ActorRef = { id: 'TEST-FAKE-service', kind: 'SERVICE' };

const meta = (): EntityMeta => ({
  schemaVersion: 'TEST-FAKE',
  revision: 1,
  validationStatus: 'VALID',
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  createdBy: actor,
  updatedBy: actor,
  lineageId: 'TEST-FAKE-lineage',
});

const priceTerm = (): PriceTerm => ({
  termKey: 'm24',
  termMonths: 24,
  monthlyRent: { amount: 700000, currency: 'KRW' },
  deposit: { amount: 0, currency: 'KRW' },
  depositState: 'ZERO',
});

const contractData = (ledgerRows: PeriodFeeLedgerRow[]) => {
  const term = priceTerm();
  const assets: VehicleAsset[] = [{ ...meta(), id: 'asset-1', vehicleModelId: 'model-1', status: 'AVAILABLE', plateNumber: 'TEST-FAKE-001' }];
  const products: Product[] = [{ ...meta(), id: 'product-1', vehicleModelId: 'model-1', vehicleAssetId: 'asset-1', commercialType: 'USED_RENT', status: 'ACTIVE', displayName: 'TEST-FAKE product' }];
  const offers: Offer[] = [{
    ...meta(),
    id: 'offer-1',
    productId: 'product-1',
    supplierId: 'RP001',
    status: 'ACTIVE',
    priceTerms: [term],
    internalEconomicsTerms: [{
      termKey: term.termKey,
      termMonths: term.termMonths,
      monthlyRent: term.monthlyRent,
      depositCalculation: { state: 'ZERO', amount: { amount: 0, currency: 'KRW' }, sourceRefs: ['TEST-FAKE'] },
      supplierBillingFee: { state: 'KNOWN', amount: { amount: 100000, currency: 'KRW' }, sourceRefs: ['TEST-FAKE'] },
      channelPayoutFee: { state: 'KNOWN', amount: { amount: 50000, currency: 'KRW' }, sourceRefs: ['TEST-FAKE'] },
    }],
  }];
  return { assets, products, offers, ledgerRows };
};

const row = (override: Partial<PeriodFeeLedgerRow> = {}): PeriodFeeLedgerRow => ({
  schemaVersion: 'period-fee-ledger/v1',
  snapshotId: 'period-fee-2026-10-09',
  snapshotDateKst: '2026-10-09',
  computedAt: '2026-10-09T00:00:00.000Z',
  valueBasis: 'CURRENT_AT_SNAPSHOT',
  valueAsOf: '2026-10-09',
  evidenceScope: 'OBSERVED_AT_SNAPSHOT',
  engineRevision: 'TEST-FAKE-engine',
  sourceDigest: 'TEST-FAKE-digest',
  documentKey: 'asset-1__m24',
  applyState: 'READY',
  holdReasonCode: null,
  vehicleUid: 'asset-1',
  assetId: 'asset-1',
  plateLookupKey: null,
  plateLast4ForReport: null,
  supplierId: 'RP001',
  productId: 'product-1',
  offerId: 'offer-1',
  offerRevision: 1,
  productUpdateTime: '2026-10-09T00:00:00.000Z',
  termKey: 'm24',
  termMonths: 24,
  monthlyRent: { amount: 700000, currency: 'KRW', state: 'KNOWN', reasonCode: null },
  deposit: {
    state: 'ZERO',
    amount: { amount: 0, currency: 'KRW' },
    reasonCode: null,
    sourceRefs: ['TEST-FAKE'],
    depositEvidence: { kind: 'VERIFIED_ZERO_TEXT', ruleCode: 'ZERO_DEPOSIT', noteField: 'deposit_note', noteText: '무보증', sourcePriceKey: 'm24', calculationBasis: 'TEST-FAKE', policyCode: null },
  },
  supplierBillingFee: { state: 'CALCULATED', amount: { amount: 100000, currency: 'KRW' }, vatTreatment: 'EXCLUDED', vatAmount: 10000, totalAmount: 110000, reasonCode: null, ruleId: 'rule', policyId: 'policy', sourceRefs: ['TEST-FAKE'] },
  channelPayoutFee: { state: 'CALCULATED', amount: { amount: 50000, currency: 'KRW' }, vatTreatment: 'EXCLUDED', vatAmount: 5000, totalAmount: 55000, reasonCode: null, ruleId: 'rule', policyId: 'policy', sourceRefs: ['TEST-FAKE'] },
  ruleIds: ['rule'],
  policyIds: ['policy'],
  priceSourceRefs: ['TEST-FAKE'],
  inputRefs: { productPath: 'products/product-1', offerPath: 'products/product-1/offers/offer-1', priceTermRef: 'products/product-1/price/m24', internalEconomicsRef: null },
  ...override,
});

const rowStorageKey = (runId: string, documentKey: string) => `${runId}__${documentKey}`;

const run = (rows: Record<string, Rec>, override: Partial<PeriodFeeSnapshotRun> = {}): PeriodFeeSnapshotRun => {
  const runId = override.runId ?? 'run-1';
  const rowKeys = Object.keys(rows).sort((left, right) => left.localeCompare(right));
  const rowTargets = rowKeys.map(documentKey => {
    const { digest: _digest, ...data } = rows[documentKey]!;
    return [documentKey, stableDigest(normalizePeriodFeeLedgerRow(data))] as const;
  });
  return {
    schemaVersion: 'period-fee-snapshot-run/v1',
    runId,
    snapshotId: 'period-fee-2026-10-09',
    planDigest: 'TEST-FAKE-plan',
    status: 'ACTIVE',
    active: true,
    previousActiveRunId: null,
    preparedAt: '2026-10-09T00:00:00.000Z',
    activatedAt: '2026-10-09T00:00:00.000Z',
    rowCount: rowKeys.length,
    rowKeysDigest: stableDigest(rowKeys),
    rowContentDigest: stableDigest(rowTargets),
    readyRowCount: rowKeys.length,
    holdNoUidCount: 0,
    historyRowCount: 0,
    historyKeysDigest: stableDigest([]),
    historyContentDigest: stableDigest([]),
    readbackSampleCount: rowKeys.length,
    readbackDigest: 'TEST-FAKE-readback',
    ...override,
  };
};

const dbWithRows = (logicalRows: Record<string, Rec>, snapshotRun?: PeriodFeeSnapshotRun) => {
  const runId = snapshotRun?.runId ?? 'run-1';
  const rows = Object.fromEntries(Object.entries(logicalRows).map(([key, value]) => [rowStorageKey(runId, key), value]));
  const runDoc = snapshotRun ?? run(rows);
  return new FakeFirestore({
    period_fee_snapshot_runs: { [runDoc.runId]: runDoc as unknown as Rec },
    period_fee_ledger: rows,
  });
};

const asFirestore = (db: FakeFirestore) => db as unknown as Firestore;

const pick = (rows: PeriodFeeLedgerRow[]) => pickLedgerRowForContract({
  rows,
  contractDate: '2026-10-10',
  termMonths: 24,
  monthlyRent: 700000,
  deposit: 0,
});

describe('period fee ledger Firestore reader evidenceScope normalization', () => {
  it('normalizes legacy rows without evidenceScope to UNKNOWN_SCOPE and keeps them out of contract evidence', async () => {
    const legacy = { ...row() } as Rec;
    delete legacy.evidenceScope;

    const readback = await readConsistentPeriodFeeLedgerRows(asFirestore(dbWithRows({ legacy })), 'period-fee-2026-10-09', 'run-1');
    expect(readback.rows[0]!.evidenceScope).toBe('UNKNOWN_SCOPE');
    expect(pick(readback.rows)).toMatchObject({
      status: 'HOLD',
      reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE',
      detail: { candidateCount: 0, baselineExcludedCount: 1 },
    });

    const adminResult = resolveContractFeeLink(
      { plate: 'TEST-FAKE-001', supplierId: 'RP001', termMonths: 24, monthlyRent: 700000, deposit: 0, contractDate: '2026-10-10' },
      contractData(readback.rows),
    );
    expect(adminResult.ledgerFee).toMatchObject({
      status: 'HOLD',
      reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE',
      baselineExcludedCount: 1,
    });
    expect(adminResult.ledgerFee).not.toHaveProperty('snapshotId');
  });

  it.each([
    ['typo', 'OBSERVED_AT_SNAPSHT'],
    ['null', null],
    ['number', 7],
  ])('treats invalid evidenceScope %s as UNKNOWN_SCOPE and never confirms it', async (_label, evidenceScope) => {
    const readback = await readConsistentPeriodFeeLedgerRows(
      asFirestore(dbWithRows({ invalid: { ...row(), documentKey: 'invalid', evidenceScope } })),
      'period-fee-2026-10-09',
      'run-1',
    );

    expect(readback.rows[0]!.evidenceScope).toBe('UNKNOWN_SCOPE');
    expect(pick(readback.rows)).toMatchObject({
      status: 'HOLD',
      reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE',
      detail: { candidateCount: 0, baselineExcludedCount: 1 },
    });
  });

  it('preserves normal BASELINE and OBSERVED rows through readback and active reader', async () => {
    const baseline = row({
      snapshotId: 'period-fee-2026-10-09',
      documentKey: 'baseline',
      evidenceScope: 'BASELINE_NOT_CONTRACT_EVIDENCE',
      valueAsOf: '2026-10-08',
    });
    const observed = row({
      snapshotId: 'period-fee-2026-10-09',
      documentKey: 'observed',
      evidenceScope: 'OBSERVED_AT_SNAPSHOT',
      valueAsOf: '2026-10-09',
    });
    firestoreState.db = dbWithRows({ baseline: baseline as unknown as Rec, observed: observed as unknown as Rec });

    const readback = await readConsistentPeriodFeeLedgerRows(asFirestore(firestoreState.db), 'period-fee-2026-10-09', 'run-1', { requireActive: true });
    expect(readback.rows.map(readRow => readRow.evidenceScope).sort()).toEqual(['BASELINE_NOT_CONTRACT_EVIDENCE', 'OBSERVED_AT_SNAPSHOT']);
    expect(readback.rows.find(readRow => readRow.documentKey === 'baseline')).toMatchObject(baseline);
    expect(readback.rows.find(readRow => readRow.documentKey === 'observed')).toMatchObject(observed);

    const activeRows = await listActivePeriodFeeLedgerRows();
    expect(activeRows.map(readRow => readRow.documentKey).sort()).toEqual(['baseline', 'observed']);
    expect(pick(activeRows)).toMatchObject({ status: 'CONFIRMED', row: { documentKey: 'observed' } });
  });
});
