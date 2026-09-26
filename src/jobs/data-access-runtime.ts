import { DataAccessGateway } from '../application/data-access-gateway.js';
import { createFirestoreDataAccessLogStore } from '../infra/firestore-data-access-log.js';
import { gcsDataAccessLogStore } from '../infra/gcs-data-access-log.js';
import {
  captureErp5Source,
  erp5ReadTransport,
  inspectErp5Capture
} from '../adapters/erp5-source-capture.js';
import { readLegacyProductSnapshot } from '../adapters/legacy-freepasserp3.js';
import { ingestLegacyProductSnapshot } from '../application/ingest-legacy-products.js';
import { prepareSheetBridgeHandoffs } from '../application/sheet-publication-bridge.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { SheetHandoffWorkbook } from '../domain/sheet-publication-handoff.js';

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
  const { readCentralFirestoreCounts } = await import('../infra/central-firestore-diagnostic.js');
  return {
    ...createJobDataAccessRuntime(),
    readCounts: readCentralFirestoreCounts
  };
}
