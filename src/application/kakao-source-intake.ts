import { randomUUID } from 'node:crypto';
import { prepareKakaoBundle, type KakaoBundle, type PreparedKakaoMessage } from '../adapters/kakao-source-intake.js';
import { stableDigest } from '../shared/stable-digest.js';
import { plateIdentityKey } from '../domain/vehicle-plate.js';
import type { SourceIngestionStore } from '../ports/source-store.js';
import type { KakaoDriveArchivePort, DriveArchiveFile, KakaoProductSnapshot, KakaoPhotoPlan, KakaoPhotoWriterPort } from '../ports/kakao-archive.js';
import { ingestRawSourceBatch, prepareRawSourceBatch } from './ingest-raw-source.js';
import type { FieldLineageRecord } from '../domain/lineage.js';

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
}, options: { apply: boolean; approval: string | undefined; now: string }) {
  if (!options.apply || options.approval !== 'approved') throw new Error('KAKAO_APPLY_NOT_APPROVED');
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
    const claimInput = { eventId: item.eventId, sourceId: item.batch.source.sourceId, owner: randomUUID(),
      now: options.now, leaseUntil: new Date(Date.parse(options.now) + 300_000).toISOString(),
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
          if (!claim.acquired || Date.now() > Date.parse(claim.receipt.leaseUntil)) throw new Error('DRIVE_RECONCILIATION_REQUIRED');
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
        archiveRefs, photo: planKakaoPhotoLink(item, ports.products, photoIds) });
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
