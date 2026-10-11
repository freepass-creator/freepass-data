import { readVehicleMasterSnapshot } from '../infra/erp5-compat-catalog-reader.js';
export async function captureVehicleMasterSnapshotReadOnly() {
  return createJobDataAccessRuntime().access.read({
    context: { actor: { id: 'service:freepass-data', kind: 'SERVICE' }, clientId: 'job:capture-shared-sheet', purpose: 'read the existing active Data vehicle master snapshot' },
    operation: 'READ_VEHICLE_MASTER_SNAPSHOT', resource: { kind: 'SOURCE', name: 'vehicle-master' },
    summarize: value => ({ count: value.masters.length + value.trims.length, digest: value.digest })
  }, readVehicleMasterSnapshot);
}
import { DataAccessGateway } from '../application/data-access-gateway.js';
import { withdrawIancarPublication, publishIancarPhaseOne, publishIancarPhotoReferences, restoreIancarPhaseOne } from '../infra/iancar-publication-withdrawal-firestore.js';
import { buildIancarOnePublicationProducts, type IancarOneListCapture } from '../adapters/iancar-one-api.js';
import { iancarErpReadTransport, buildIancarErpRawIntakeBatch } from '../adapters/iancar-source-capture.js';
import { createFirestoreDataAccessLogStore } from '../infra/firestore-data-access-log.js';
import { gcsDataAccessLogStore } from '../infra/gcs-data-access-log.js';
import {
  buildErp5CanonicalDryRun,
  captureErp5Source,
  compareErp5ProductCaptures,
  erp5ReadTransport,
  inspectErp5Capture,
  buildErp5RawSourceIntakeBatches
} from '../adapters/erp5-source-capture.js';
import { readLegacyProductSnapshot } from '../adapters/legacy-freepasserp3.js';
import { ingestLegacyProductSnapshot } from '../application/ingest-legacy-products.js';
import { ingestRawSourceBatch } from '../application/ingest-raw-source.js';
import type { SourceIntakeBatch } from '../domain/source-intake.js';
import { prepareSheetBridgeHandoffs } from '../application/sheet-publication-bridge.js';
import {
  assessLatestSheetConsumerCutover,
  recordSheetDeliveryEvidence,
  type SheetEvidenceFreshnessPolicy
} from '../application/sheet-delivery-evidence.js';
import { readSheetConsumerHealth } from '../application/sheet-consumer-health.js';
import {
  readConsumerRuntimeEvidence,
  type ConsumerRuntimeEvidencePolicy
} from '../application/consumer-runtime-evidence.js';
import {
  readConsumerHealth,
  type ConsumerHealthPolicy
} from '../application/consumer-health.js';
import { readConsumerReadiness } from '../application/consumer-readiness.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { SheetHandoffWorkbook, SheetPublicationHandoff } from '../domain/sheet-publication-handoff.js';
import type { SheetDeliveryReceipt } from '../domain/consumer-delivery.js';
import type {
  ConsumerCutoverStage,
  ConsumerSwitchRegistration
} from '../domain/consumer-cutover.js';
import { createFirestoreDataStore } from '../infra/firestore-store.js';
import { readVehicleUidMigrationInputs } from '../infra/vehicle-uid-migration-firestore-reader.js';
import { createFirestoreVehicleMasterStore } from '../infra/vehicle-master-firestore-store.js';
import { createFirebaseVehicleMasterSourceArchive } from '../infra/vehicle-master-source-archive.js';
import { createHttpVehicleMasterSourceFetcher } from '../infra/vehicle-master-source-fetcher.js';
import type { CatalogStore } from '../ports/catalog-store.js';
import type { SourceIngestionStore } from '../ports/source-store.js';
import {
  buildEstimateMasterFromCanonicalVehicleMaster,
  type EstimateMasterCanonicalBridge,
} from '../application/estimate-master-canonical.js';

function readOnlyAccess(input: { accessToken: string; evidenceBucket: string }) {
  return new DataAccessGateway(gcsDataAccessLogStore({
    accessToken: input.accessToken,
    bucket: input.evidenceBucket
  }));
}

/** Shared-sheet operator jobs: read mode has zero durable audit writes; apply is gateway audited.
 * Reads use an ephemeral access log and deny all mutation capabilities at the port boundary.
 */
export async function withSharedSheetCatalogAccess<T>(
  apply: boolean,
  requestDigest: string,
  run: (catalog: CatalogStore, source: SourceIngestionStore) => Promise<T>,
  preflight?: (catalog: CatalogStore) => Promise<void>,
): Promise<T> {
  const { createFirestoreSourceStore } = await import('../infra/source-firestore-store.js');
  const { MemoryDataAccessLogStore } = await import('../infra/memory-data-access-log.js');
  // Read mode keeps only an in-process gateway log (no durable write). Apply opens the durable audit only after preflight.
  const access = new DataAccessGateway(apply ? createFirestoreDataAccessLogStore() : new MemoryDataAccessLogStore());
  const catalog = await createFirestoreDataStore();
  const source = createFirestoreSourceStore();
  const denyWrites = <S extends object>(store: S): S => new Proxy(store, { get(target, key) {
    if (typeof key === 'string' && !key.startsWith('get') && !key.startsWith('list'))
      return () => { throw new Error('READ_ONLY_PORT'); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const spec = { context: { actor: { id: 'service:freepass-data', kind: 'SERVICE' as const },
    clientId: 'job:shared-sheet-catalog', purpose: 'operator shared-sheet Canonical evidence' },
    operation: apply ? 'WRITE_SHARED_SHEET_CANONICAL' : 'READ_SHARED_SHEET_CANONICAL',
    resource: { kind: 'CATALOG' as const, name: 'shared-sheet-canonical' }, requestDigest,
    summarize: (value: T) => ({ digest: stableDigest(value) }) };
  if (apply && preflight) await new DataAccessGateway(new MemoryDataAccessLogStore()).read(
    { ...spec, operation: 'PREFLIGHT_SHARED_SHEET_CANONICAL', summarize: () => ({ digest: requestDigest }) },
    () => preflight(denyWrites(catalog)));
  return apply ? access.write(spec, () => run(catalog, source))
    : access.read(spec, () => run(denyWrites(catalog), denyWrites(source)));
}

/** Catalog writer ownership operator job: read/dry-run uses an in-process log only; apply/rollback is
 * gateway audited and opens the durable audit only after the read-only preflight passes.
 */
export async function withCatalogOwnershipAccess<T>(
  write: boolean,
  requestDigest: string,
  run: (catalog: CatalogStore) => Promise<T>,
  preflight?: (catalog: CatalogStore) => Promise<void>,
): Promise<T> {
  const { MemoryDataAccessLogStore } = await import('../infra/memory-data-access-log.js');
  const catalog = await createFirestoreDataStore();
  const readOnly = new Proxy(catalog, { get(target, key) {
    if (typeof key === 'string' && !key.startsWith('get') && !key.startsWith('list'))
      return () => { throw new Error('READ_ONLY_PORT'); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const spec = { context: { actor: { id: 'service:freepass-data', kind: 'SERVICE' as const },
    clientId: 'job:catalog-writer-ownership', purpose: 'operator Catalog writer ownership transfer' },
    operation: write ? 'WRITE_CATALOG_WRITER_OWNERSHIP' : 'READ_CATALOG_WRITER_OWNERSHIP',
    resource: { kind: 'CATALOG' as const, name: 'catalog-writer-ownership' }, requestDigest,
    summarize: (value: T) => ({ digest: stableDigest(value) }) };
  if (!write) return new DataAccessGateway(new MemoryDataAccessLogStore()).read(spec, () => run(readOnly));
  if (preflight) await new DataAccessGateway(new MemoryDataAccessLogStore()).read(
    { ...spec, operation: 'PREFLIGHT_CATALOG_WRITER_OWNERSHIP', summarize: () => ({ digest: requestDigest }) },
    () => preflight(readOnly));
  return new DataAccessGateway(createFirestoreDataAccessLogStore()).write(spec, () => run(catalog));
}

export function createIancarErpInspectionDataAccessRuntime(input: {
  accessToken: string; evidenceBucket: string; accountJson: string;
}) {
  const access = readOnlyAccess(input);
  const readErp = iancarErpReadTransport(input);
  return {
    buildRawIntakeBatch: buildIancarErpRawIntakeBatch,
    capture: () => access.read({
      context: { actor: { id: 'service:freepass-data-iancar-source', kind: 'SERVICE' },
        clientId: 'job:ingest-erp5-source', purpose: 'read supplier ERP inventory directly, not a Sheet mirror' },
      operation: 'READ_IANCAR_ERP_INVENTORY', resource: { kind: 'SOURCE', name: 'supplier/RP031/erp-inventory' },
      summarize: value => ({ count: value.vehicles.length, digest: value.sourceRevision })
    }, readErp)
  };
}

export function createJobDataAccessRuntime() {
  return {
    access: new DataAccessGateway(createFirestoreDataAccessLogStore())
  };
}

export function createVehicleUidMigrationPlanRuntime() {
  const { access } = createJobDataAccessRuntime();
  return {
    readInputs: () => access.read({
      context: {
        actor: { id: 'service:freepass-data-vehicle-uid', kind: 'SERVICE' },
        clientId: 'job:plan-vehicle-uid-migration',
        purpose: 'read products, catalog vehicle assets, and source bindings to prepare a zero-write UID migration plan',
      },
      operation: 'READ_VEHICLE_UID_MIGRATION_INPUTS',
      resource: { kind: 'CATALOG', name: 'vehicle-uid-migration' },
      summarize: (value) => ({
        count: Object.keys(value.products).length + value.assets.length + value.bindings.length,
        digest: stableDigest({
          productKeys: Object.keys(value.products).sort(),
          assetIds: value.assets.map(asset => asset.id).sort(),
          bindingIds: value.bindings.map(binding => binding.bindingId).sort(),
        }),
      }),
    }, readVehicleUidMigrationInputs),
  };
}

export async function runIancarPublicationWithdrawal(input: {
  apply: boolean; expectedCount: number; expectedOpen: number;
}) {
  const runtime = createJobDataAccessRuntime();
  const context = { actor: { id: 'service:freepass-data-iancar-withdrawal', kind: 'SERVICE' as const },
    clientId: 'job:withdraw-iancar-publication', purpose: 'user-directed temporary RP031 publication withdrawal' };
  const resource = { kind: 'SOURCE' as const, name: 'freepasserp5/products/RP031' };
  const summarize = (value: Awaited<ReturnType<typeof withdrawIancarPublication>>) =>
    ({ count: value.changedCount, digest: stableDigest(value) });
  if (!input.apply) return runtime.access.read({ context, resource,
    operation: 'READ_IANCAR_PUBLICATION_WITHDRAWAL_PLAN', summarize }, () => withdrawIancarPublication(input));
  return runtime.access.write({ context, resource, operation: 'WRITE_IANCAR_PUBLICATION_WITHDRAWAL',
    requestDigest: stableDigest(input), summarize }, () => withdrawIancarPublication(input));
}

export async function runIancarPhaseOnePublication(input: {
  capture: IancarOneListCapture; apply: boolean; expectedPlanDigest?: string; mirrorInventory?: boolean; privateEvidenceBucket?: string;
}) {
  const prepared = { products: buildIancarOnePublicationProducts(input.capture),
    sourceDigest: input.capture.sourceDigest, sourceSyncedAt: input.capture.syncedAt,
    apply: input.apply, sourceEvidence: JSON.stringify(input.capture),
    ...(input.mirrorInventory !== undefined ? { mirrorInventory: input.mirrorInventory } : {}),
    ...(input.privateEvidenceBucket ? { privateEvidenceBucket: input.privateEvidenceBucket } : {}),
    ...(input.expectedPlanDigest ? { expectedPlanDigest: input.expectedPlanDigest } : {}) };
  const runtime = createJobDataAccessRuntime();
  const context = { actor: { id: 'service:freepass-data-iancar-publication', kind: 'SERVICE' as const },
    clientId: 'job:publish-iancar-phase-one', purpose: 'user-directed RP031 API vehicle/rental publication; policy deferred' };
  const resource = { kind: 'SOURCE' as const, name: 'freepasserp5/products/RP031' };
  const summarize = (value: Awaited<ReturnType<typeof publishIancarPhaseOne>>) =>
    ({ count: value.sourceCount, digest: stableDigest(value) });
  if (!input.apply) return runtime.access.read({ context, resource,
    operation: 'READ_IANCAR_PHASE_ONE_PLAN', summarize }, () => publishIancarPhaseOne(prepared));
  return runtime.access.write({ context, resource, operation: 'WRITE_IANCAR_PHASE_ONE_PUBLICATION',
    requestDigest: stableDigest(input), summarize }, () => publishIancarPhaseOne(prepared));
}

export async function runIancarPhotoPublication(input: Parameters<typeof publishIancarPhotoReferences>[0]) {
  const runtime = createJobDataAccessRuntime();
  const spec = { context: { actor: { id: 'service:freepass-data-iancar-photos', kind: 'SERVICE' as const },
    clientId: 'job:collect-iancar-one-api', purpose: 'user-directed photo-only publication preserving prices and inventory' },
    resource: { kind: 'SOURCE' as const, name: 'freepasserp5/products/RP031/photos' },
    operation: input.apply ? 'WRITE_IANCAR_PHOTO_REFERENCES' : 'READ_IANCAR_PHOTO_PLAN',
    summarize: (value: Awaited<ReturnType<typeof publishIancarPhotoReferences>>) => ({ count: value.count, digest: value.planDigest }) };
  return input.apply ? runtime.access.write({ ...spec, requestDigest: stableDigest(input) }, () => publishIancarPhotoReferences(input))
    : runtime.access.read(spec, () => publishIancarPhotoReferences(input));
}

export async function runIancarPhotoRestore(input: Parameters<typeof restoreIancarPhaseOne>[0]) {
  const prepared = { ...input, expectedSchema: 'iancar-photo-typed-backup/1' };
  const runtime = createJobDataAccessRuntime();
  const spec = { context: { actor: { id: 'service:freepass-data-iancar-photos', kind: 'SERVICE' as const }, clientId: 'job:restore-iancar-photos', purpose: 'restore verified RP031 photo-only backup' },
    resource: { kind: 'SOURCE' as const, name: 'freepasserp5/products/RP031/photos' }, operation: input.apply ? 'RESTORE_IANCAR_PHOTOS' : 'READ_IANCAR_PHOTO_RESTORE_PLAN',
    summarize: (value: Awaited<ReturnType<typeof restoreIancarPhaseOne>>) => ({ count: value.count }) };
  return input.apply ? runtime.access.write({ ...spec, requestDigest: stableDigest(input) }, () => restoreIancarPhaseOne(prepared)) : runtime.access.read(spec, () => restoreIancarPhaseOne(prepared));
}

export async function createConsumerHealthReadOnlyDataAccessRuntime(input: {
  accessToken: string;
  evidenceBucket: string;
}) {
  const logs = createFirestoreDataAccessLogStore();
  const access = readOnlyAccess(input);
  const store = await createFirestoreDataStore();

  return {
    health: (policy: ConsumerHealthPolicy) => access.read({
      context: {
        actor: { id: 'service:freepass-data-consumer-health-audit', kind: 'SERVICE' },
        clientId: 'job:check-consumer-health',
        purpose: 'read unified consumer health without Firestore audit writes'
      },
      operation: 'READ_CONSUMER_HEALTH',
      resource: {
        kind: 'HEALTH',
        name: 'consumer-health'
      },
      summarize: (value) => ({
        count: value.consumers.length,
        digest: stableDigest(value)
      })
    }, () => readConsumerHealth(logs, store, policy))
  };
}

export async function createConsumerReadinessReadOnlyDataAccessRuntime(input: {
  accessToken: string;
  evidenceBucket: string;
}) {
  const logs = createFirestoreDataAccessLogStore();
  const access = readOnlyAccess(input);
  const store = await createFirestoreDataStore();

  return {
    readiness: (policy: ConsumerHealthPolicy) => access.read({
      context: {
        actor: { id: 'service:freepass-data-consumer-readiness-audit', kind: 'SERVICE' },
        clientId: 'job:check-consumer-readiness',
        purpose: 'derive consumer readiness without Firestore audit writes'
      },
      operation: 'READ_CONSUMER_READINESS',
      resource: {
        kind: 'HEALTH',
        name: 'consumer-readiness'
      },
      summarize: (value) => ({
        count: value.consumers.length,
        digest: stableDigest(value)
      })
    }, () => readConsumerReadiness(logs, store, policy))
  };
}

export async function createConsumerReadinessDataAccessRuntime() {
  const logs = createFirestoreDataAccessLogStore();
  const access = new DataAccessGateway(logs);
  const store = await createFirestoreDataStore();

  return {
    readiness: (policy: ConsumerHealthPolicy) => access.read({
      context: {
        actor: { id: 'service:freepass-data-consumer-readiness', kind: 'SERVICE' },
        clientId: 'job:check-consumer-readiness',
        purpose: 'derive next-stage consumer readiness from reviewed and runtime evidence'
      },
      operation: 'READ_CONSUMER_READINESS',
      resource: {
        kind: 'HEALTH',
        name: 'consumer-readiness'
      },
      summarize: (value) => ({
        count: value.consumers.length,
        digest: stableDigest(value)
      })
    }, () => readConsumerReadiness(logs, store, policy))
  };
}

export async function createConsumerHealthDataAccessRuntime() {
  const logs = createFirestoreDataAccessLogStore();
  const access = new DataAccessGateway(logs);
  const store = await createFirestoreDataStore();

  return {
    health: (policy: ConsumerHealthPolicy) => access.read({
      context: {
        actor: { id: 'service:freepass-data-consumer-health', kind: 'SERVICE' },
        clientId: 'job:check-consumer-health',
        purpose: 'read unified consumer runtime and Sheet delivery health'
      },
      operation: 'READ_CONSUMER_HEALTH',
      resource: {
        kind: 'HEALTH',
        name: 'consumer-health'
      },
      summarize: (value) => ({
        count: value.consumers.length,
        digest: stableDigest(value)
      })
    }, () => readConsumerHealth(logs, store, policy))
  };
}

export function createConsumerRuntimeEvidenceDataAccessRuntime() {
  const logs = createFirestoreDataAccessLogStore();
  const access = new DataAccessGateway(logs);
  return {
    report: (policy: ConsumerRuntimeEvidencePolicy) => access.read({
      context: {
        actor: { id: 'service:freepass-data-consumer-evidence', kind: 'SERVICE' },
        clientId: 'job:consumer-runtime-evidence',
        purpose: 'derive consumer cutover evidence from audited runtime reads'
      },
      operation: 'READ_CONSUMER_RUNTIME_EVIDENCE',
      resource: {
        kind: 'HEALTH',
        name: 'consumer-runtime-evidence'
      },
      summarize: (value) => ({
        count: value.consumers.length,
        digest: stableDigest(value)
      })
    }, () => readConsumerRuntimeEvidence(logs, policy))
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
    buildRawIntakeBatches: buildErp5RawSourceIntakeBatches,
    capture: () => access.read({
      context: {
        actor: { id: 'service:freepass-data-audit', kind: 'SERVICE' },
        clientId: 'job:inspect-erp5-source',
        purpose: 'capture ERP5 source through FreePass Data'
      },
      operation: 'READ_ERP5_SOURCE_CAPTURE',
      resource: {
        kind: 'SOURCE',
        name: 'freepasserp5/(default):products+policy+partner'
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

export async function createSheetConsumerHealthReadOnlyDataAccessRuntime(input: {
  accessToken: string;
  evidenceBucket: string;
}) {
  const access = readOnlyAccess(input);
  const store = await createFirestoreDataStore();

  return {
    health: (freshnessPolicy: SheetEvidenceFreshnessPolicy) => access.read({
      context: {
        actor: { id: 'service:freepass-data-sheet-health-audit', kind: 'SERVICE' },
        clientId: 'job:check-sheet-consumer-health',
        purpose: 'read F01/F86 delivery and cutover health without Firestore audit writes'
      },
      operation: 'READ_SHEET_CONSUMER_HEALTH',
      resource: {
        kind: 'PROJECTION',
        name: 'sheet-consumer-health'
      },
      summarize: (value) => ({
        count: value.consumers.length,
        digest: stableDigest(value)
      })
    }, () => readSheetConsumerHealth(store, freshnessPolicy))
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

    health: (freshnessPolicy: SheetEvidenceFreshnessPolicy) => access.read({
      context: {
        actor: { id: 'service:freepass-data-sheet-health', kind: 'SERVICE' },
        clientId: 'job:check-sheet-consumer-health',
        purpose: 'read F01/F86 delivery and cutover health'
      },
      operation: 'READ_SHEET_CONSUMER_HEALTH',
      resource: {
        kind: 'PROJECTION',
        name: 'sheet-consumer-health'
      },
      summarize: (value) => ({
        count: value.consumers.length,
        digest: stableDigest(value)
      })
    }, () => readSheetConsumerHealth(store, freshnessPolicy)),

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
,

    ingestRawBatch: (batch: SourceIntakeBatch) =>
      access.write({
        context: {
          actor: { id: 'service:freepass-data-source-intake', kind: 'SERVICE' },
          clientId: 'job:raw-source-intake',
          purpose: 'persist raw-first source evidence through FreePass Data',
          correlationId: batch.source.sourceId
        },
        operation: 'WRITE_RAW_SOURCE_INGEST',
        resource: {
          kind: 'SOURCE',
          name: batch.source.sourceId
        },
        requestDigest: stableDigest({
          laneId: batch.laneId,
          sourceId: batch.source.sourceId,
          observedAt: batch.observedAt,
          sourceRevision: batch.sourceRevision ?? null,
          checksum: batch.checksum ?? null,
          coverage: batch.coverage,
          records: batch.records.map((record) => [
            record.sourceRecordId,
            record.sourceFingerprint ?? stableDigest(record.payload)
          ])
        }),
        summarize: (value) => ({
          count: value.rawCount,
          digest: stableDigest({
            runId: value.runId,
            sourceId: value.sourceId,
            rawCount: value.rawCount,
            headStatus: value.headStatus,
            checkpoint: value.checkpoint
          })
        })
      }, () => ingestRawSourceBatch(sourceStore, batch))
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

export function createVehicleMasterReadOnlyDataAccessRuntime(input: {
  accessToken: string;
  evidenceBucket: string;
}) {
  const access = readOnlyAccess(input);
  const store = createFirestoreVehicleMasterStore();

  return {
    estimateMasterReadiness: (bridge: EstimateMasterCanonicalBridge = {}) => access.read({
      context: {
        actor: { id: 'service:freepass-data-estimate-master-readiness', kind: 'SERVICE' },
        clientId: 'job:check-estimate-master-readiness',
        purpose: 'derive Estimate master readiness from canonical Vehicle Master without Firestore audit writes'
      },
      operation: 'READ_ESTIMATE_MASTER_READINESS',
      resource: {
        kind: 'PROJECTION',
        name: 'estimate-newcar-master-readiness',
        projectionId: 'estimate-newcar-master'
      },
      requestDigest: stableDigest({ bridge }),
      summarize: (value) => ({
        count: value.summary.total,
        digest: stableDigest(value.records),
        inputDigest: value.summary.inputDigest
      })
    }, () => buildEstimateMasterFromCanonicalVehicleMaster(store, { bridge }))
  };
}
