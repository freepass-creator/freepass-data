import { randomUUID } from 'node:crypto';
import { prepareKakaoBundle, type KakaoBundle, type PreparedKakaoMessage, type KakaoQueueInput } from '../adapters/kakao-source-intake.js';
import { stableDigest } from '../shared/stable-digest.js';
import { plateIdentityKey } from '../domain/vehicle-plate.js';
import type { SourceIngestionStore } from '../ports/source-store.js';
import type { KakaoDriveArchivePort, DriveArchiveFile, KakaoProductSnapshot, KakaoPhotoPlan, KakaoPhotoWriterPort } from '../ports/kakao-archive.js';
import { ingestRawSourceBatch, prepareRawSourceBatch } from './ingest-raw-source.js';
import type { FieldLineageRecord } from '../domain/lineage.js';
import type { KakaoQueueReadPort, KakaoQueueReceipt } from '../ports/kakao-archive.js';
import { summarizeSupplierSources, selectKakaoPilotSuppliers, type SupplierSourceObservation } from '../domain/source-event.js';
import { sharedSheetHeaders } from '../adapters/shared-sheet-source.js';

/** Evidence only: these cells are not CatalogCandidate facts and do not approve amounts/specifications. */
export function kakaoTableLineage(item: PreparedKakaoMessage): FieldLineageRecord[] {
  const raw = prepareRawSourceBatch(item.batch).rawRecords[0]!;
  return (item.message.tables ?? []).flatMap((table, tableIndex) => table.verified ? table.rows.flatMap((row, rowIndex) =>
    row.map((value, columnIndex) => {
      const fieldPath = `original.tables[${tableIndex}].rows[${rowIndex}][${columnIndex}]`;
      const id = stableDigest([raw.rawRecordId, fieldPath, table.extractorVersion]);
      return { lineageRecordId: id, lineageId: id, stage: 'RAW_TO_NORMALIZED' as const,
        runId: raw.runId, sourceId: raw.sourceId, sourceRecordId: raw.sourceRecordId,
        sourceFingerprint: raw.sourceFingerprint, observedAt: raw.observedAt,
        source: { fieldPath, value },
        normalized: null, transformId: 'kakao-table-evidence', transformVersion: table.extractorVersion };
    })) : []);
}

export function assertPrivateDrive(file: Pick<DriveArchiveFile, 'permissions' | 'permissionsComplete' | 'ancestorPermissionsChecked'>, organizationDomain: string) {
  if (!organizationDomain || !file.permissionsComplete || !file.ancestorPermissionsChecked || !file.permissions.length
    || file.permissions.some(p => p.type === 'domain'
      ? p.domain !== organizationDomain || p.role !== 'reader' || p.allowFileDiscovery !== false
      : p.type === 'user'
        ? !p.emailAddress?.endsWith(`@${organizationDomain}`) || !['owner', 'reader', 'writer'].includes(p.role)
        : true)) throw new Error('DRIVE_PRIVATE_ACCESS_REQUIRED');
}

export function planKakaoPhotoLink(item: PreparedKakaoMessage, products: KakaoProductSnapshot[], archiveIds: string[] = []) {
  const holds = [...item.issues];
  const vehicle = item.message.vehicle;
  const photoAttachments = item.attachments.filter(x => x.role === 'VEHICLE_PHOTO');
  if (!photoAttachments.length) return { matches: 0, holds, plan: null };
  if (!vehicle || !vehicle.evidenceText || !item.message.text.includes(vehicle.evidenceText)
    || !(vehicle.supplierVehicleId && vehicle.evidenceText.includes(vehicle.supplierVehicleId)
      || vehicle.plate && vehicle.evidenceText.includes(vehicle.plate))) holds.push('VEHICLE_IDENTITY_UNRESOLVED');
  const matches = vehicle ? products.filter(p => p.data.provider_company_code === item.batch.records[0]!.payload.supplierCode
    && (!vehicle.supplierVehicleId || !!p.supplierVehicleIdField && p.data[p.supplierVehicleIdField] === vehicle.supplierVehicleId)
    && (!vehicle.plate || !!plateIdentityKey(vehicle.plate) && plateIdentityKey(p.data.car_number) === plateIdentityKey(vehicle.plate))
    && !!(vehicle.supplierVehicleId || vehicle.plate)) : [];
  if (matches.length !== 1) holds.push('PRODUCT_MATCH_UNRESOLVED');
  const product = matches.length === 1 ? matches[0]! : null;
  if (product && product.data.photo_link != null && product.data.photo_link !== '') holds.push('EXISTING_PHOTO_PRESERVED');
  if (holds.length || !product || !item.eventId) return { matches: matches.length, holds: [...new Set(holds)], plan: null };
  // File links only, never a mixed-document event folder or a public thumbnail URL.
  const after = archiveIds.map(id => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`).join('\n');
  const plan: KakaoPhotoPlan = { eventId: item.eventId, productId: product.id, expectedDigest: stableDigest(product.data),
    field: 'photo_link', before: product.data.photo_link ?? null, after, archiveIds,
    status: 'PLAN_ONLY', holds: [...(!archiveIds.length ? ['DRIVE_ARCHIVE_NOT_VERIFIED'] : []), 'ERP_PRIVATE_MEDIA_DISPLAY_UNVERIFIED'] };
  return { matches: 1, holds: plan.holds, plan };
}

/** A second explicit approval is bound to the existing writer's dry-run digest. */
export async function applyKakaoPhotoPlan(plan: KakaoPhotoPlan, port: KakaoPhotoWriterPort, options: {
  apply: boolean; approval: string | undefined; expectedPlanDigest: string;
}) {
  if (plan.holds.length || !plan.after || !plan.archiveIds.length) throw new Error('PHOTO_PLAN_HOLD');
  if (plan.field !== 'photo_link' || !/^[a-f0-9]{64}$/.test(plan.eventId)
    || (plan.before != null && plan.before !== '')
    || plan.archiveIds.some(id => !/^[A-Za-z0-9_-]+$/.test(id))
    || plan.after !== plan.archiveIds.map(id => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`).join('\n'))
    throw new Error('PHOTO_PLAN_INVALID');
  const dryRun = await port.dryRun(plan);
  if (!options.apply) return dryRun;
  if (options.approval !== 'approved' || !dryRun.ready || dryRun.planDigest !== options.expectedPlanDigest)
    throw new Error('PHOTO_APPLY_NOT_APPROVED');
  const result = await port.apply(plan, { planDigest: dryRun.planDigest });
  if (!result.verified) throw new Error('PHOTO_APPLY_READBACK_UNVERIFIED');
  return result;
}

export function planKakaoIntake(bundle: KakaoBundle, products: KakaoProductSnapshot[] = []) {
  return prepareKakaoBundle(bundle).map(item => ({
    eventId: item.eventId, observationId: item.observationId, coverage: 'PARTIAL',
    attachmentHashes: item.attachments.map(a => a.sha256), directory: item.directory,
    archivePlan: item.archives.map(a => ({ sha256: a.sha256, path: item.directory ? `${item.directory}${a.sha256}` : null,
      appProperties: { eventId: item.eventId, sha256: a.sha256 } })),
    classification: item.classification, issues: item.issues, writes: 0,
    tableEvidenceCellCount: kakaoTableLineage(item).length,
    deletionCount: 0, stockZeroAsserted: false, photo: planKakaoPhotoLink(item, products),
  }));
}

export async function ingestKakaoBundle(bundle: KakaoBundle, ports: {
  store: SourceIngestionStore; drive: KakaoDriveArchivePort; organizationDomain: string;
  products: KakaoProductSnapshot[];
  productReader?: import('../ports/kakao-archive.js').KakaoProductReadPort;
}, options: { apply: boolean; approval: string | undefined; now: string; clock?: () => number }) {
  if (!options.apply || options.approval !== 'approved') throw new Error('KAKAO_APPLY_NOT_APPROVED');
  const products = ports.productReader ? await ports.productReader.readSupplier(bundle.supplierCode) : ports.products;
  const clock = options.clock ?? Date.now;
  const prepared = prepareKakaoBundle(bundle);
  const results = [];
  for (const item of prepared) {
    const { runId, rawRecords } = prepareRawSourceBatch(item.batch);
    const raw = rawRecords[0]!;
    try {
      await ingestRawSourceBatch(ports.store, item.batch, options.now, undefined, () => kakaoTableLineage(item));
    } catch {
      // A lost RAW reply is never repaired by a new run/key or blind append.
      const run = await ports.store.getRun(runId);
      if (run?.status !== 'COMPLETED') {
        results.push({ eventId: item.eventId, status: 'HOLD', issues: ['RAW_RECONCILIATION_REQUIRED'] }); continue;
      }
    }
    const stored = (await ports.store.listRaw(runId)).find(x => x.rawRecordId === raw.rawRecordId);
    if (!stored || stableDigest(stored.payload) !== stableDigest(raw.payload)) throw new Error('KAKAO_RAW_READBACK_FAILED');
    const storedLineage = await ports.store.listLineage(runId);
    for (const lineage of kakaoTableLineage(item))
      if (!storedLineage.some(x => x.lineageRecordId === lineage.lineageRecordId && stableDigest(x) === stableDigest(lineage)))
        throw new Error('KAKAO_LINEAGE_READBACK_FAILED');
    if (!item.eventId || !item.directory) {
      results.push({ eventId: null, status: 'HOLD', issues: item.issues }); continue;
    }
    const claimedAt = clock();
    const claimInput = { eventId: item.eventId, sourceId: item.batch.source.sourceId, owner: randomUUID(),
      now: new Date(claimedAt).toISOString(), leaseUntil: new Date(claimedAt + 300_000).toISOString(),
      observation: { observationId: item.observationId, rawRef: raw.rawRecordId,
        fingerprint: item.fingerprint, version: item.message.version, verified: item.message.captureVerified } };
    let claim;
    try { claim = await ports.store.claimEvent(claimInput); }
    catch {
      // Even an existing receipt cannot prove that THIS caller won the create.
      await ports.store.getEvent(item.eventId);
      results.push({ eventId: item.eventId, status: 'UNKNOWN', issues: ['EVENT_CLAIM_REPLY_UNKNOWN'] }); continue;
    }
    if (claim.conflict) {
      results.push({ eventId: item.eventId, status: 'HOLD', issues: ['CONFLICT'] }); continue;
    }
    const archiveRefs: string[] = [];
    const photoIds: string[] = [];
    try {
      assertPrivateDrive(await ports.drive.inspectDestination(item.directory), ports.organizationDomain);
      for (const attachment of [...new Map(item.archives.map(a => [a.sha256, a])).values()]) {
        const properties = { eventId: item.eventId, sha256: attachment.sha256 };
        const matches = await ports.drive.find(properties);
        if (matches.length > 1) throw new Error('DRIVE_ARCHIVE_CONFLICT');
        let id = matches[0]?.id;
        if (!id) {
          // Only the first successful atomic claimant may upload, within its original lease.
          // Existing/expired/UNKNOWN receipts allow searches only, including after a restart.
          if (!claim.acquired || clock() > Date.parse(claim.receipt.leaseUntil)) throw new Error('DRIVE_RECONCILIATION_REQUIRED');
          id = (await ports.drive.upload({ directory: item.directory, name: attachment.sha256,
            bytes: attachment.bytes, mediaType: attachment.mediaType, appProperties: properties })).id;
        }
        const verified = await ports.drive.verify(id);
        assertPrivateDrive(verified, ports.organizationDomain);
        if (verified.id !== id || !/^[A-Za-z0-9_-]+$/.test(id) || verified.directory !== item.directory
          || verified.sha256 !== attachment.sha256 || verified.appProperties.eventId !== item.eventId
          || verified.appProperties.sha256 !== attachment.sha256) throw new Error('DRIVE_READBACK_FAILED');
        archiveRefs.push(id);
        if (attachment.role === 'VEHICLE_PHOTO') photoIds.push(id);
      }
      // Re-read revision to preserve observations registered by another PC during upload.
      const receipt = await ports.store.getEvent(item.eventId);
      if (!receipt || receipt.fingerprint !== item.fingerprint) throw new Error('EVENT_CHANGED_DURING_ARCHIVE');
      await ports.store.finishEvent(item.eventId, { revision: receipt.revision, state: 'ARCHIVED', archiveRefs });
      results.push({ eventId: item.eventId, status: item.issues.length ? 'HOLD' : 'ARCHIVED', issues: item.issues,
        archiveRefs, photo: planKakaoPhotoLink(item, products, photoIds) });
    } catch (error) {
      // Leave the create-only receipt blocking dispatch even if this acknowledgement also fails.
      try {
        const receipt = await ports.store.getEvent(item.eventId);
        if (receipt && receipt.state !== 'ARCHIVED') await ports.store.finishEvent(item.eventId, {
          revision: receipt.revision, state: 'UNKNOWN', archiveRefs,
        });
      } catch { /* UNKNOWN is not a retry grant. */ }
      const known = error instanceof Error && ['DRIVE_PRIVATE_ACCESS_REQUIRED', 'DRIVE_ARCHIVE_CONFLICT',
        'DRIVE_READBACK_FAILED', 'EVENT_CHANGED_DURING_ARCHIVE'].includes(error.message) ? error.message : null;
      results.push({ eventId: item.eventId, status: known ? 'HOLD' : 'UNKNOWN',
        issues: [known ?? 'ARCHIVE_RECONCILIATION_REQUIRED'] });
    }
  }
  return results;
}

/** Plan shape follows the existing blank-fill writer (before='', row guard); never executes writes. */
export function planKakaoSheetPhoto(input: {
  headers: string[]; capturedAt: string; now: string; product: KakaoProductSnapshot;
  row: { supplierCode: string; supplierVehicleId: string; range: string; identityRange: string;
    identityValue: string; value: unknown; formula: boolean; metadataComplete: boolean; hasLink: boolean };
}) {
  const holds: string[] = [];
  const target = sharedSheetHeaders.includes('사진링크') ? '사진링크' : sharedSheetHeaders.includes('비고') ? '비고' : null;
  const row = input.row;
  const age = Date.parse(input.now) - Date.parse(input.capturedAt);
  if (!Number.isFinite(age) || age < 0 || age > 900_000) holds.push('SHEET_CAPTURE_STALE');
  if (!target || input.headers.filter(h => h === target).length !== 1) holds.push('SHEET_PHOTO_SPEC_DESIGN_REQUIRED');
  if (stableDigest(input.headers) !== stableDigest(sharedSheetHeaders)) holds.push('SHEET_LAYOUT_MISMATCH');
  const column = target ? input.headers.indexOf(target) + 1 : 0;
  const colName = (columnNumber: number) => {
    let n = columnNumber, letters = '';
    while (n > 0) { n--; letters = String.fromCharCode(65 + n % 26) + letters; n = Math.floor(n / 26); }
    return letters;
  };
  const cell = /^('(?:[^']|'')+'|[^'!]+)!([A-Z]+)([1-9][0-9]*)$/;
  const destination = cell.exec(row.range), identity = cell.exec(row.identityRange);
  if (!destination || !identity || !row.identityValue || Number(destination[3]) < 2
    || !Number.isSafeInteger(Number(destination[3])) || destination[2] !== colName(column)
    || identity[2] !== colName(sharedSheetHeaders.indexOf('차량번호') + 1)
    || destination[1] !== identity[1] || destination[3] !== identity[3]) holds.push('SHEET_ROW_BINDING_REQUIRED');
  if (!row.metadataComplete || row.formula || row.hasLink || row.value != null && row.value !== '')
    holds.push('EXISTING_SHEET_VALUE_PRESERVED');
  const field = input.product.supplierVehicleIdField;
  if (!row.supplierCode || !row.supplierVehicleId || !field
    || input.product.data.provider_company_code !== row.supplierCode
    || input.product.data[field] !== row.supplierVehicleId
    || row.identityValue !== input.product.data.car_number)
    holds.push('PRODUCT_MATCH_UNRESOLVED');
  const photo = input.product.data.photo_link;
  if (typeof photo !== 'string' || !photo || photo.split('\n').some(link =>
    !/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(link))) holds.push('PRODUCT_PHOTO_LINK_UNRESOLVED');
  return { status: 'PLAN_ONLY' as const, writes: 0, target, holds,
    productDigest: stableDigest(input.product.data), rowDigest: stableDigest(row),
    바꿀칸: holds.length ? [] : [{ 범위: row.range, 전: '', 후: photo as string }],
    줄확인: holds.length ? [] : [{ 범위: row.identityRange, 값: row.identityValue }],
    // A private link is not a proof that a sheet viewer can open it.
    applyHolds: ['SHEET_PRIVATE_MEDIA_DISPLAY_UNVERIFIED', 'SHEET_WRITE_NOT_AUTHORIZED'] };
}

/** Verify every message again after ingestion, including the committed Source receipt. */
export async function processKakaoQueueInput(input: KakaoQueueInput,
  ports: Parameters<typeof ingestKakaoBundle>[1],
  options: { apply: boolean; approval: string | undefined; now: string }): Promise<KakaoQueueReceipt> {
  const inputDigest = stableDigest(input);
  const receipt = (status: KakaoQueueReceipt['status'], issues: string[]): KakaoQueueReceipt =>
    ({ inputDigest, status, deleteAllowed: status === 'ACK_ELIGIBLE', issues });
  try {
    const prepared = prepareKakaoBundle(input.bundle);
    if (!options.apply) { planKakaoIntake(input.bundle, input.products); return receipt('DRY_RUN', []); }
    const results = await ingestKakaoBundle(input.bundle, ports, options);
    if (results.some(r => r.status !== 'ARCHIVED')) return receipt(
      results.some(r => r.status === 'UNKNOWN') ? 'UNKNOWN' : 'HOLD', [...new Set(results.flatMap(r => r.issues))]);
    for (const item of prepared) {
      const raw = prepareRawSourceBatch(item.batch).rawRecords[0]!;
      const run = await ports.store.getRun(raw.runId);
      const stored = (await ports.store.listRaw(raw.runId)).find(r => r.rawRecordId === raw.rawRecordId);
      const event = item.eventId ? await ports.store.getEvent(item.eventId) : null;
      if (run?.status !== 'COMPLETED' || !stored || stored.sourceId !== raw.sourceId
        || stored.sourceRecordId !== raw.sourceRecordId || stored.sourceFingerprint !== raw.sourceFingerprint
        || stableDigest(stored.payload) !== stableDigest(raw.payload)
        || !event || event.state !== 'ARCHIVED' || event.sourceId !== raw.sourceId
        || event.fingerprint !== item.fingerprint || !event.observations.some(o =>
          o.observationId === item.observationId && o.rawRef === raw.rawRecordId && o.fingerprint === item.fingerprint))
        return receipt('HOLD', ['CENTRAL_READBACK_REQUIRED']);
      for (const attachment of item.archives) {
        const matches = await ports.drive.find({ eventId: item.eventId!, sha256: attachment.sha256 });
        if (matches.length !== 1 || !event.archiveRefs.includes(matches[0]!.id)) return receipt('HOLD', ['ARCHIVE_READBACK_REQUIRED']);
        const file = await ports.drive.verify(matches[0]!.id);
        assertPrivateDrive(file, ports.organizationDomain);
        if (file.id !== matches[0]!.id || file.directory !== item.directory || file.sha256 !== attachment.sha256
          || file.appProperties.eventId !== item.eventId || file.appProperties.sha256 !== attachment.sha256)
          return receipt('HOLD', ['ARCHIVE_READBACK_REQUIRED']);
      }
    }
    return receipt('ACK_ELIGIBLE', []);
  } catch { return receipt('UNKNOWN', ['QUEUE_PROCESSING_OR_READBACK_FAILED']); }
}

/** One bad bundle cannot drop the rest. Returned alerts contain no source text or queue paths. */
export async function processKakaoQueue(queue: KakaoQueueReadPort<KakaoQueueInput>,
  ports: Parameters<typeof ingestKakaoBundle>[1],
  options: Parameters<typeof processKakaoQueueInput>[2] = { apply: false, approval: undefined, now: new Date().toISOString() }) {
  const results: KakaoQueueReceipt[] = [];
  let entries: Awaited<ReturnType<typeof queue.list>>;
  try { entries = await queue.list(); } catch { throw new Error('QUEUE_LIST_FAILED'); }
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.inputDigest)) {
      results.push({ inputDigest: stableDigest(entry.inputDigest), status: 'HOLD', deleteAllowed: false, issues: ['QUEUE_DIGEST_INVALID'] });
      continue;
    }
    try {
      const input = await queue.read(entry.key);
      if (stableDigest(input) !== entry.inputDigest) {
        results.push({ inputDigest: entry.inputDigest, status: 'HOLD', deleteAllowed: false, issues: ['QUEUE_DIGEST_CONFLICT'] });
      } else results.push(await processKakaoQueueInput(input, ports, options));
    } catch { results.push({ inputDigest: entry.inputDigest, status: 'UNKNOWN', deleteAllowed: false, issues: ['QUEUE_READ_FAILED'] }); }
  }
  return { results, alerts: results.filter(r => r.status === 'HOLD' || r.status === 'UNKNOWN'), deletions: 0 };
}

/** Explicit run manifest, read-only existing Source store. Missing runs are never silently complete. */
export async function readSupplierSourceSummary(store: SourceIngestionStore, runIds: string[],
  options: { now: string; days: number; limit: number }) {
  const observations: SupplierSourceObservation[] = [];
  const holds: string[] = [];
  for (const runId of new Set(runIds)) {
    const run = await store.getRun(runId);
    if (!run || run.status !== 'COMPLETED') { holds.push('SOURCE_RUN_UNAVAILABLE'); continue; }
    const source = await store.getSource(run.sourceId);
    const rows = await store.listRaw(runId);
    if (!source || rows.length !== run.rawCount) { holds.push('SOURCE_READ_INCOMPLETE'); continue; }
    for (const raw of rows) {
      const p = raw.payload;
      if (raw.sourceId !== run.sourceId || raw.runId !== runId || typeof p.supplierCode !== 'string' || !p.supplierCode) {
        holds.push('SOURCE_SUPPLIER_BINDING_UNAVAILABLE'); continue;
      }
      if (p.ruleVersion === 'kakao-intake/1') {
        const original = p.original as Record<string, unknown> | undefined;
        if (typeof p.eventId !== 'string' || !/^[a-f0-9]{64}$/.test(p.eventId) || original?.captureVerified !== true
          || typeof original.sentAt !== 'string' || !Array.isArray(p.issues) || p.issues.length) {
          holds.push('SOURCE_OBSERVATION_UNVERIFIED'); continue;
        }
        const hasTable = Array.isArray(original.tables) && original.tables.some(t => t?.verified === true);
        observations.push({ supplierCode: p.supplierCode, eventKey: p.eventId, observedAt: original.sentAt,
          kind: hasTable ? 'KAKAO_TABLE' : 'KAKAO_MEMO' });
      } else {
        if (run.coverage.completeness !== 'COMPLETE' || p.quarantine != null && p.quarantine !== '') {
          holds.push('SOURCE_OBSERVATION_UNVERIFIED'); continue;
        }
        // One capture per supplier, not one event per inventory row. Re-reading a run cannot inflate counts.
        observations.push({ supplierCode: p.supplierCode, eventKey: `${raw.sourceId}:${runId}`,
          observedAt: run.observedAt ?? raw.observedAt,
          kind: source.kind === 'GOOGLE_SHEET' ? 'SHEET' : source.kind === 'API' ? 'API' : 'OTHER' });
      }
    }
  }
  return { scope: 'PROVIDED_SOURCE_RUNS_ONLY' as const, runIds: [...new Set(runIds)], holds: [...new Set(holds)],
    summaries: summarizeSupplierSources(observations, options),
    pilots: holds.length ? [] : selectKakaoPilotSuppliers(observations, options), writes: 0 };
}
