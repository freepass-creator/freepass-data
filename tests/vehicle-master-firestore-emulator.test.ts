import assert from 'node:assert/strict';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { test } from 'vitest';
import {
  promoteVehicleMasterNode,
  type VehicleMasterFieldObservation,
} from '../src/application/vehicle-master-ingestion.js';
import {
  sealVehicleMasterNode,
  sealVehicleMasterSourceDocument,
} from '../src/domain/vehicle-master.js';
import { FirestoreVehicleMasterStore } from '../src/infra/vehicle-master-firestore-store.js';

const emulatorTest = process.env.FIRESTORE_EMULATOR_HOST ? test : test.skip;
const projectId = 'demo-freepass-data-vehicle-master';

async function clearEmulator() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) return;
  const response = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' }
  );
  if (!response.ok) {
    throw new Error(`Failed to clear Firestore emulator: ${response.status}`);
  }
}

async function withStore<T>(
  run: (store: FirestoreVehicleMasterStore) => Promise<T>
): Promise<T> {
  await clearEmulator();
  const app = initializeApp({ projectId }, `vehicle-master-emulator-${process.pid}-${Date.now()}`);
  try {
    return await run(new FirestoreVehicleMasterStore(getFirestore(app)));
  } finally {
    await deleteApp(app);
  }
}

const observedAt = '2026-09-25T00:00:00.000Z';

emulatorTest('Firestore keeps slash IDs distinct from literal double-underscore IDs', async () => {
  await withStore(async (store) => {
    const slash = sealVehicleMasterSourceDocument({
      sourceDocumentId: 'source/a',
      sourceType: 'MANUFACTURER_OFFICIAL',
      sourceName: 'slash source',
      sourceUrl: null,
      publishedAt: null,
      observedAt,
      storagePath: 'synthetic/slash',
      sha256: 'a'.repeat(64),
      mimeType: 'text/plain',
      metadata: {},
    });
    const underscore = sealVehicleMasterSourceDocument({
      sourceDocumentId: 'source__a',
      sourceType: 'MANUFACTURER_OFFICIAL',
      sourceName: 'underscore source',
      sourceUrl: null,
      publishedAt: null,
      observedAt,
      storagePath: 'synthetic/underscore',
      sha256: 'b'.repeat(64),
      mimeType: 'text/plain',
      metadata: {},
    });

    assert.equal(await store.putSourceDocument(slash), 'CREATED');
    assert.equal(await store.putSourceDocument(underscore), 'CREATED');
    assert.deepEqual(await store.getSourceDocument('source/a'), slash);
    assert.deepEqual(await store.getSourceDocument('source__a'), underscore);
  });
});

emulatorTest('Firestore promotion is stable when equivalent observations are reordered', async () => {
  await withStore(async (store) => {
    const sourceDocumentId = 'source/order';
    await store.putSourceDocument(sealVehicleMasterSourceDocument({
      sourceDocumentId,
      sourceType: 'MANUFACTURER_OFFICIAL',
      sourceName: 'order regression',
      sourceUrl: null,
      publishedAt: null,
      observedAt,
      storagePath: 'synthetic/order',
      sha256: 'c'.repeat(64),
      mimeType: 'text/plain',
      metadata: {},
    }));

    const proposal = sealVehicleMasterNode({
      id: 'make_firestore_order',
      nodeType: 'MAKE',
      status: 'ACTIVE',
      canonicalName: 'make_firestore_order',
      refs: {},
      aliases: [],
      attributes: { synthetic: true },
      revision: 1,
      createdAt: observedAt,
      updatedAt: observedAt,
      sourceEvidenceIds: [sourceDocumentId],
    });
    const observations: VehicleMasterFieldObservation[] = [
      { fieldPath: 'canonicalName', value: proposal.canonicalName, sourceDocumentId },
      { fieldPath: 'attributes.synthetic', value: true, sourceDocumentId },
    ];
    const input = {
      proposal,
      observedAt,
      policy: {
        requiredFieldPaths: ['canonicalName', 'attributes.synthetic'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
    };

    const first = await promoteVehicleMasterNode(store, { ...input, observations });
    const retry = await promoteVehicleMasterNode(store, {
      ...input,
      observations: [...observations].reverse(),
    });

    assert.equal(first.decision.status, 'APPROVED');
    assert.equal(first.canonicalWrite, 'CREATED');
    assert.deepEqual(retry, { ...first, canonicalWrite: 'UNCHANGED' });

    const savedCandidate = await store.getPipelineRecord('CANDIDATE_FACT', first.candidateFactId);
    const savedOutcome = await store.getPipelineRecord('PROMOTION_RESULT', first.promotionResultId);
    assert.ok(savedCandidate);
    assert.equal(savedOutcome?.payload.canonicalWrite, 'CREATED');
  });
});
