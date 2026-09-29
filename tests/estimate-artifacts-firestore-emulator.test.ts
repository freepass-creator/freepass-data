import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { expect, test } from 'vitest';
import {
  QUOTE_REVISION_CONTRACT_V1,
  QUOTE_SNAPSHOT_CONTRACT_V2,
  estimateArtifactDigest,
  quoteIdempotencyKey,
  quoteSnapshotFromIssuedQuote,
  type IssuedQuoteV2,
} from '../src/domain/estimate-artifacts.js';
import { estimateArtifactStore } from '../src/infra/estimate-artifacts-firestore.js';

const emulatorTest = process.env.FIRESTORE_EMULATOR_HOST ? test : test.skip;
const projectId = 'demo-freepass-data-estimate-artifacts';

async function clearEmulator() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) return;
  const response = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new Error(`Failed to clear Firestore emulator: ${response.status}`);
}

async function withStore<T>(run: (store: ReturnType<typeof estimateArtifactStore>) => Promise<T>) {
  await clearEmulator();
  const app = initializeApp({ projectId }, `estimate-artifacts-emulator-${process.pid}-${Date.now()}`);
  try {
    return await run(estimateArtifactStore(getFirestore(app)));
  } finally {
    await deleteApp(app);
  }
}

function issuedQuote(): IssuedQuoteV2 {
  const snapshot = {
    contract: QUOTE_SNAPSHOT_CONTRACT_V2,
    vehicleModelId: 'vm_niro',
    modelYearId: 'my_niro_2026',
    trimId: 'trim_niro_signature',
    powertrainId: 'pt_niro_hev',
    selectedOptionIds: ['opt_drivewise'],
    exteriorColorId: 'ext_white',
    interiorColorId: 'int_charcoal',
    contractTerm: 48,
    mileageCondition: '20000',
    conditionSnapshot: { credit: 'A' },
    deposit: 0,
    prepayment: 0,
    depositRatePct: 0,
    prepaymentRatePct: 0,
    vehiclePriceSnapshot: { basePrice: 35020000 },
    optionPriceSnapshot: [{ optionId: 'opt_drivewise', price: 700000 }],
    totalVehiclePrice: 35720000,
    monthlyRental: 620000,
    pricingEngineVersion: 'freepass-standard/v1',
    calculationProvenance: { providerKey: 'freepass-standard', verified: true },
    sourceRevision: 'vehicle-master:r7',
  };
  const snapshotHash = estimateArtifactDigest(snapshot);
  const { contract: _snapshotContract, ...facts } = snapshot;
  return {
    contract: 'freepass-quote/v2',
    quoteId: `q_${snapshotHash.slice(0, 24)}`,
    quoteVersion: 1,
    createdAt: '2026-09-29T00:00:00.000Z',
    ...facts,
    snapshotHash,
    revision: null,
    revisionHash: null,
  };
}

function reviseQuote(previous: IssuedQuoteV2, monthlyRental: number): IssuedQuoteV2 {
  const snapshot = {
    ...quoteSnapshotFromIssuedQuote(previous),
    monthlyRental,
  };
  const snapshotHash = estimateArtifactDigest(snapshot);
  const { contract: _snapshotContract, ...facts } = snapshot;
  const revision = {
    contract: QUOTE_REVISION_CONTRACT_V1,
    previousQuoteVersion: previous.quoteVersion,
    previousSnapshotHash: previous.snapshotHash,
    previousRevisionHash: previous.revisionHash ?? null,
  };
  const quoteVersion = previous.quoteVersion + 1;
  const revisionHash = estimateArtifactDigest({
    contract: QUOTE_REVISION_CONTRACT_V1,
    quoteId: previous.quoteId,
    quoteVersion,
    snapshotHash,
    revision,
  });
  return {
    contract: 'freepass-quote/v2',
    quoteId: previous.quoteId,
    quoteVersion,
    createdAt: '2026-09-29T00:01:00.000Z',
    ...facts,
    snapshotHash,
    revision,
    revisionHash,
  };
}

emulatorTest('Firestore concurrent exact retries produce one immutable persistence event', async () => {
  await withStore(async (store) => {
    const quote = issuedQuote();
    const key = quoteIdempotencyKey(quote);
    const laterRetry = {
      ...structuredClone(quote),
      createdAt: '2026-09-29T00:05:00.000Z',
    };
    const receipts = await Promise.all([
      store.putIssuedQuote(quote, key),
      store.putIssuedQuote(laterRetry, key),
    ]);

    expect(receipts.map((item) => item.status).sort()).toEqual(['CREATED', 'EXISTING']);
    expect(new Set(receipts.map((item) => item.persistedAt))).toHaveLength(1);
    expect(receipts[0]?.persistedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const read = await store.getIssuedQuote(quote.quoteId, quote.quoteVersion);
    expect(read).toMatchObject({
      status: 'FOUND',
      quoteId: quote.quoteId,
      quoteVersion: quote.quoteVersion,
      snapshotHash: quote.snapshotHash,
    });
  });
});

emulatorTest('Firestore permits only one competing next Quote revision', async () => {
  await withStore(async (store) => {
    const first = issuedQuote();
    await store.putIssuedQuote(first, quoteIdempotencyKey(first));
    const candidates = [reviseQuote(first, 630000), reviseQuote(first, 640000)];

    const results = await Promise.allSettled(
      candidates.map((quote) => store.putIssuedQuote(quote, quoteIdempotencyKey(quote))),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'QUOTE_REPOSITORY_CONFLICT' }),
    });

    const winner = results.find((result) => result.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('missing winning revision');
    const read = await store.getIssuedQuote(first.quoteId);
    expect(read).toMatchObject({
      status: 'FOUND',
      quoteVersion: 2,
      snapshotHash: winner.value.snapshotHash,
    });
  });
});
