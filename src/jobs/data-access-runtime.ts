import { DataAccessGateway } from '../application/data-access-gateway.js';
import { createFirestoreDataAccessLogStore } from '../infra/firestore-data-access-log.js';
import { gcsDataAccessLogStore } from '../infra/gcs-data-access-log.js';
import {
  buildErp5CanonicalDryRun,
  captureErp5Source,
  compareErp5ProductCaptures,
  erp5ReadTransport,
  inspectErp5Capture
} from '../adapters/erp5-source-capture.js';
import { readLegacyProductSnapshot } from '../adapters/legacy-freepasserp3.js';
import { ingestLegacyProductSnapshot } from '../application/ingest-legacy-products.js';
import { prepareSheetBridgeHandoffs } from '../application/sheet-publication-bridge.js';
import {
  assessLatestSheetConsumerCutover,
  recordSheetDeliveryEvidence,
  type SheetEvidenceFreshnessPolicy
} from '../application/sheet-delivery-evidence.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { SheetHandoffWorkbook, SheetPublicationHandoff } from '../domain/sheet-publication-handoff.js';
import type { SheetDeliveryReceipt } from '../domain/consumer-delivery.js';
import type {
  ConsumerCutoverStage,
  ConsumerSwitchRegistration
} from '../domain/consumer-cutover.js';
import { createFirestoreDataStore } from '../infra/firestore-store.js';
import { createFirestoreVehicleMasterStore } from '../infra/vehicle-master-firestore-store.js';
import { createFirebaseVehicleMasterSourceArchive } from '../infra/vehicle-master-source-archive.js';
import { createHttpVehicleMasterSourceFetcher } from '../infra/vehicle-master-source-fetcher.js';

function readOnlyAccess(input: { accessToken: string; evidenceBucket: string }) {
  return new DataAccessGateway(gcsDataAccessLogStore({
    accessToken: input.accessToken,
    bucket: input.evidenceBucket
  }));
}

export function createJobDataAccessRuntime() {
  return {
    access: new DataAccessGateway(createFirestoreDataAccessLogStore())
  };
}

export function createErp5CaptureAnalysisRuntime() {
  return {
    buildCanonicalDryRun: buildErp5CanonicalDryRun,
    compareProductCaptures: compareErp5ProductCaptures
  };
}

export function createErp5InspectionDataAccessRuntime(input: {
  accessToken: string;
  evidenceBucket: string;
}) {
  const access = readOnlyAccess(input);
  const rpc = erp5ReadTransport(input.accessToken);
  return {
    inspectCapture: inspectErp5Capture,
    capture: () => access.read({
      context: {
        actor: { id: 'service:freepass-data-audit', kind: 'SERVICE' },
        clientId: 'job:inspect-erp5-source',
        purpose: 'capture ERP5 source through FreePass Data'
      },
      operation: 'READ_ERP5_SOURCE_CAPTURE',
      resource: {
        kind: 'SOURCE',
        name: 'freepasserp5/(default):products+policy'
      },
      summarize: (value) => ({
        count: value.collections.products.count,
        digest: value.digest
      })
    }, () => captureErp5Source(rpc))
  };
}

export function createSheetBridgeDataAccessRuntime(input: {
  accessToken: string;
  evidenceBucket: string;
}) {
  const access = readOnlyAccess(input);
  const rpc = erp5ReadTransport(input.accessToken);
  return {
    prepare: (targets: readonly SheetHandoffWorkbook[]) => access.read({
      context: {
        actor: { id: 'service:freepass-data-sheet-bridge', kind: 'SERVICE' },
        clientId: 'job:prepare-sheet-bridge',
        purpose: 'prepare F01/F86 source handoff through FreePass Data'
      },
      operation: 'READ_SHEET_BRIDGE_SOURCE',
      resource: {
        kind: 'SOURCE',
        name: 'freepasserp5/(default):products+policy+partner'
      },
      summarize: (value) => ({
        count: value.capture.collections.products.count,
        digest: value.bridge.release.dataDigest,
        releaseId: value.bridge.release.releaseId,
        manifestId: value.bridge.release.manifestId
      })
    }, () => prepareSheetBridgeHandoffs(rpc, targets))
  };
}

export async function createSheetDeliveryEvidenceDataAccessRuntime() {
  const access = new DataAccessGateway(createFirestoreDataAccessLogStore());
  const store = await createFirestoreDataStore();

  return {
    record: (input: {
      handoff: SheetPublicationHandoff;
      receipt: SheetDeliveryReceipt;
      recordedAt?: string;
    }) => access.write({
      context: {
        actor: { id: 'service:freepass-data-sheet-delivery', kind: 'SERVICE' },
        clientId: 'job:record-sheet-delivery-evidence',
        purpose: 'persist validated F01/F86 delivery evidence'
      },
      operation: 'WRITE_SHEET_DELIVERY_EVIDENCE',
      resource: {
        kind: 'PROJECTION',
        name: 'sheet-delivery-evidence',
        projectionId: input.receipt.approvedRelease.projectionId
      },
      requestDigest: stableDigest({
        handoffHash: input.handoff.handoffHash,
        receipt: input.receipt
      }),
      summarize: (value) => ({
        count: 1,
        digest: stableDigest(value),
        releaseId: value.receipt.approvedRelease.releaseId
      })
    }, () => recordSheetDeliveryEvidence(store, input)),

    assess: (
      registration: ConsumerSwitchRegistration,
      target: ConsumerCutoverStage,
      freshnessPolicy: SheetEvidenceFreshnessPolicy
    ) => access.read({
      context: {
        actor: { id: 'service:freepass-data-sheet-cutover', kind: 'SERVICE' },
        clientId: 'job:assess-sheet-consumer-cutover',
        purpose: 'assess Sheet consumer cutover from durable FreePass Data evidence'
      },
      operation: 'READ_SHEET_CUTOVER_EVIDENCE',
      resource: {
        kind: 'PROJECTION',
        name: 'sheet-delivery-evidence'
      },
      summarize: (value) => ({
        count: value.record ? 1 : 0,
        digest: stableDigest({
          receiptId: value.record?.receiptId ?? null,
          decision: value.decision
        }),
        ...(value.registration.evidence.approvedRelease
          ? { releaseId: value.registration.evidence.approvedRelease.releaseId }
          : {})
      })
    }, () => assessLatestSheetConsumerCutover(
      store,
      registration,
      target,
      freshnessPolicy
    ))
  };
}

export async function createSourceIngestDataAccessRuntime() {
  const { createFirestoreSourceStore } = await import('../infra/source-firestore-store.js');
  const access = new DataAccessGateway(createFirestoreDataAccessLogStore());
  const sourceStore = createFirestoreSourceStore();

  return {
    readLegacySnapshot: () => access.read({
      context: {
        actor: { id: 'service:freepass-data-ingest', kind: 'SERVICE' },
        clientId: 'job:ingest-legacy-products',
        purpose: 'read legacy source snapshot through FreePass Data'
      },
      operation: 'READ_LEGACY_SOURCE_SNAPSHOT',
      resource: {
        kind: 'SOURCE',
        name: 'freepasserp3/firestore/products'
      },
      summarize: (value) => ({
        count: value.records.length,
        digest: stableDigest({
          checkpoint: value.checkpoint,
          coverage: value.coverage,
          recordFingerprints: value.records.map(
            (record) => [record.sourceRecordId, record.fingerprint]
          )
        })
      })
    }, () => readLegacyProductSnapshot()),

    ingestLegacySnapshot: (snapshot: Awaited<ReturnType<typeof readLegacyProductSnapshot>>) =>
      access.write({
        context: {
          actor: { id: 'service:freepass-data-ingest', kind: 'SERVICE' },
          clientId: 'job:ingest-legacy-products',
          purpose: 'ingest reviewed legacy source snapshot through FreePass Data',
          correlationId: snapshot.checkpoint.sourceId
        },
        operation: 'WRITE_LEGACY_SOURCE_INGEST',
        resource: {
          kind: 'SOURCE',
          name: snapshot.checkpoint.sourceId
        },
        requestDigest: stableDigest({
          sourceId: snapshot.checkpoint.sourceId,
          checkpoint: snapshot.checkpoint,
          coverage: snapshot.coverage,
          recordCount: snapshot.records.length
        }),
        summarize: (value) => value ? {
          count: value.rawCount,
          digest: stableDigest({
            runId: value.runId,
            sourceId: value.sourceId,
            rawCount: value.rawCount,
            candidateCount: value.candidateCount,
            lineageCount: value.lineageCount,
            warningCount: value.warningCount
          })
        } : { count: 0 }
      }, () => ingestLegacyProductSnapshot(sourceStore, snapshot))
  };
}

export async function createCentralDiagnosticDataAccessRuntime() {
  const {
    CENTRAL_ACTIVE_PROJECTION_COLLECTION,
    CENTRAL_CANONICAL_COLLECTIONS,
    readCentralFirestoreCounts
  } = await import('../infra/central-firestore-diagnostic.js');
  return {
    ...createJobDataAccessRuntime(),
    canonicalCollections: CENTRAL_CANONICAL_COLLECTIONS,
    activeProjectionCollection: CENTRAL_ACTIVE_PROJECTION_COLLECTION,
    readCounts: readCentralFirestoreCounts
  };
}


export function createVehicleMasterJobRuntime() {
  return {
    access: new DataAccessGateway(createFirestoreDataAccessLogStore()),
    store: createFirestoreVehicleMasterStore(),
    archive: createFirebaseVehicleMasterSourceArchive(),
    fetcher: createHttpVehicleMasterSourceFetcher(),
  };
}
