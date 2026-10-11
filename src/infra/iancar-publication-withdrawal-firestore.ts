import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FieldValue, GeoPoint, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getTargetFirebaseApp } from './firebase-target.js';
import { stableDigest } from '../shared/stable-digest.js';
import { isPublicIancarPhotoProduct } from './erp5-compat-catalog-reader.js';

export type IancarPhotoObservation = { productId: string; vehicleId: string; plate: string; count: number; observedAt: string; illustration?: { url: string; sourceName: string; kind: "MODEL_ILLUSTRATION"; sourcePage: string; mappingVersion: string; observedSha256?: string } };

/** Shared photo mapping; caller owns identity, freshness and public serving gates. */
export function iancarPhotoPatch(original: Record<string, any>, row: IancarPhotoObservation): Record<string, unknown> {
  const ownProxy = (value: unknown) => {
    try { const url = new URL(String(value)); return url.origin === 'https://freepasserp.com' && url.pathname === '/api/img'
      && url.searchParams.get('product') === row.productId; } catch { return false; }
  };
  const liveImages = [original.image_url, ...(Array.isArray(original.image_urls) ? original.image_urls : [])]
    .filter(value => typeof value === 'string' && value.trim());
  const originalSnapshot = liveImages.some(value => !ownProxy(value)) || !original.iancar_photo_source_original
    ? { image_urls: original.image_urls ?? null, image_url: original.image_url ?? null,
      photo_link: original.photo_link ?? null, image_kind: original.image_kind ?? null }
    : original.iancar_photo_source_original;
  // Absolute public ERP proxy references work for Admin/AI and other consumer origins too.
  // format is only a recognizable raster hint; the server always strips metadata and emits JPEG.
  const images = Array.from({ length: row.count }, (_, index) => `https://freepasserp.com/api/img?product=${encodeURIComponent(row.productId)}&photo=${index}&format=.jpg`);
  const patch: Record<string, unknown> = {
    provider_company_code: 'RP031',
    iancar_one_photo_count: row.count, iancar_one_photos_observed_at: row.observedAt,
    iancar_one_photo_state: row.count ? 'AVAILABLE' : 'API_EMPTY_ORIGINAL_PRESERVED',
  };
  // Preserve existing originals, including photos from our own prior storage. Zero never deletes them.
  if (row.count) Object.assign(patch, {
    image_urls: images, image_url: images[0], image_kind: 'VEHICLE_PHOTO',
    iancar_photo_source_original: originalSnapshot,
  });
  else if (original.iancar_photo_source_original && Array.isArray(original.image_urls)
    && original.image_urls.length && [...original.image_urls, original.image_url].every((url: unknown) => {
    try { const u = new URL(String(url)); return u.origin === 'https://freepasserp.com' && u.pathname === '/api/img' && u.searchParams.get('product') === row.productId; }
    catch { return false; }
    })) {
    const saved = original.iancar_photo_source_original as Record<string, unknown>;
    // Restore only our own now-unbacked slots. Never overwrite a new operator/supplier photo.
    Object.assign(patch, { image_urls: saved.image_urls ?? [], image_url: saved.image_url ?? '', image_kind: saved.image_kind ?? null });
  }
  if (!row.count && row.illustration) {
    const evidence = row.illustration;
    const url = new URL(evidence.url);
    if (url.origin !== 'https://eancarone.com' || !/^\/catalog-images\/neutral\/[a-z0-9-]+\.webp$/.test(url.pathname)
    || url.search || url.hash || url.username || url.password || !evidence.sourceName
    || evidence.kind !== 'MODEL_ILLUSTRATION' || evidence.sourcePage !== 'https://eancarone.com/'
    || evidence.mappingVersion !== 'supplier-catalogue-20261002/1') throw new Error('IANCAR_ILLUSTRATION_INVALID');
    const currentImages = patch.image_urls ?? original.image_urls;
    const currentImage = patch.image_url ?? original.image_url;
    const hasOriginal = (Array.isArray(currentImages) && currentImages.some(url => typeof url === 'string' && url.trim()))
    || (typeof currentImage === 'string' && !!currentImage.trim()) || (typeof original.photo_link === 'string' && !!original.photo_link.trim())
    || [original.images, original.photos, original.photo].some(value =>
      typeof value === 'string' ? !!value.trim() : Array.isArray(value) ? value.length > 0 : !!value && typeof value === 'object' && Object.keys(value).length > 0);
    // Never use a stale kind flag as authority to overwrite newly supplied operator photographs.
    if (!hasOriginal) Object.assign(patch, {
    image_urls: [evidence.url], image_url: evidence.url, image_kind: 'MODEL_ILLUSTRATION',
    iancar_model_illustration: evidence, iancar_one_photo_state: 'API_EMPTY_MODEL_ILLUSTRATION',
    iancar_photo_source_original: original.iancar_photo_source_original ?? {
      image_urls: original.image_urls ?? null, image_url: original.image_url ?? null, photo_link: original.photo_link ?? null,
    },
    });
    else if (currentImage === evidence.url && Array.isArray(currentImages)
    && currentImages.length > 0 && currentImages.every(url => url === evidence.url)) Object.assign(patch, {
      image_kind: 'MODEL_ILLUSTRATION', iancar_model_illustration: evidence,
      iancar_one_photo_state: 'API_EMPTY_MODEL_ILLUSTRATION',
    });
  }
  return patch;
}
/** Photo-only publication: immutable backup, exact identity, revision fence, no inventory/price edits. */
export async function publishIancarPhotoReferences(input: {
  records: { productId: string; vehicleId: string; plate: string; count: number; observedAt: string;
    illustration?: { url: string; sourceName: string; kind: 'MODEL_ILLUSTRATION'; sourcePage: string; mappingVersion: string; observedSha256?: string } }[];
  apply: boolean; expectedPlanDigest?: string;
}) {
  const app = getTargetFirebaseApp();
  if (app.options.projectId !== 'freepasserp5') throw new Error('IANCAR_PHOTO_WRONG_PROJECT');
  const db = getFirestore(app);
  if (!input.records.length || input.records.length > 450
    || new Set(input.records.map(row => row.productId)).size !== input.records.length)
    throw new Error('IANCAR_PHOTO_PUBLICATION_INPUT_INVALID');
  const refs = input.records.map(row => {
    if (!row.productId || /[\/\u0000-\u001f\u007f]/.test(row.productId)) throw new Error('IANCAR_PHOTO_ID_INVALID');
    return db.collection('products').doc(row.productId);
  });
  const before = await db.getAll(...refs);
  const assertFresh = () => {
    for (const row of input.records) if (!Number.isFinite(Date.parse(row.observedAt))
      || Date.now() - Date.parse(row.observedAt) > 900_000 || Date.parse(row.observedAt) > Date.now() + 60_000)
      throw new Error('IANCAR_PHOTO_CAPTURE_STALE');
  };
  assertFresh();
  const planned = input.records.map((row, index) => {
    const original = before[index]!.data();
    if (!isPublicIancarPhotoProduct(original) || original!.iancar_one_vehicle_id !== row.vehicleId
      || String(original!.car_number).replace(/\s/g, '') !== row.plate.replace(/\s/g, '')
      || !Number.isSafeInteger(row.count) || row.count < 0 || row.count > 200)
      throw new Error('IANCAR_PHOTO_IDENTITY_OR_COUNT_INVALID');
    const patch = iancarPhotoPatch(original!, row);
    return { row, original: original!, patch, snapshot: before[index]! };
  });
  const planDigest = stableDigest(planned.map(p => ({ id: p.row.productId, revision: p.snapshot.updateTime!.toMillis(), patch: p.patch })));
  const summary = { count: planned.length, withPhotos: planned.filter(p => p.row.count > 0).length,
    withIllustrations: planned.filter(p => p.patch.image_kind === 'MODEL_ILLUSTRATION').length,
    photoCount: input.records.reduce((n, p) => n + p.count, 0), planDigest, inventoryChanges: 0, priceChanges: 0, deletes: 0 };
  if (!input.apply) return { ...summary, status: 'DRY_RUN', writeExecuted: false };
  if (input.expectedPlanDigest !== planDigest) throw new Error('IANCAR_PHOTO_PLAN_CHANGED');
  const runId = randomUUID();
  const directory = join(homedir(), '.codex', 'private', 'freepass-data-iancar-withdrawals');
  await mkdir(directory, { recursive: true });
  const backupPath = join(directory, `photos-${runId}.json`);
  const backup = JSON.stringify({ schema: 'iancar-photo-typed-backup/1', runId, projectId: 'freepasserp5',
    sourceDigest: planDigest, planDigest, capturedAt: new Date().toISOString(),
    documents: planned.map(p => ({ path: p.snapshot.ref.path, exists: true,
      data: encodeIancarBackupValue(p.original), patch: encodeIancarBackupValue(p.patch) })) });
  await writeFile(backupPath, backup, { flag: 'wx', mode: 0o600 });
  if (await readFile(backupPath, 'utf8') !== backup) throw new Error('IANCAR_PHOTO_BACKUP_READBACK_FAILED');
  await db.runTransaction(async tx => {
    const current = await tx.getAll(...refs);
    if (current.some((p, i) => !p.updateTime?.isEqual(before[i]!.updateTime!))) throw new Error('IANCAR_PHOTO_REVISION_CHANGED');
    assertFresh();
    planned.forEach((p, i) => tx.update(refs[i]!, p.patch));
  });
  const after = await db.getAll(...refs);
  for (let i = 0; i < planned.length; i++) {
    const p = planned[i]!; const actual = after[i]!.data()!;
    if (Object.entries(p.patch).some(([key, value]) => stableDigest(actual[key]) !== stableDigest(value)))
      throw Object.assign(new Error('IANCAR_PHOTO_COMMITTED_READBACK_FAILED'), { runId, backupPath, writeExecuted: true });
  }
  return { ...summary, status: 'PHOTO_ATOM_READBACK_VERIFIED', writeExecuted: true, runId, backupPath };
}

type PhaseOneProduct = {
  sourceVehicleId: string; car_number: string; price: Record<string, { rent: number; deposit: number }>;
  vehicle_status: string; status: string; status_kind: string; listable: boolean;
  facts: Record<string, unknown>; evidence: Record<string, unknown>;
  photo?: Omit<IancarPhotoObservation, 'productId' | 'vehicleId' | 'plate'> & { photoIds: string[] };
};

/** Complete source absence withdraws selling only; history and contracts are never deleted. */
export function iancarAbsencePatch(old: Record<string, any>, observedIds: Set<string>, sourceDigest: string, sourceSyncedAt: string) {
  if (old.provider_company_code !== 'RP031' || observedIds.has(old.iancar_one_vehicle_id)
    || (!old.iancar_phase_one && old.listable !== true)) return null;
  if (old.locked_by_contract || old._deleted || old.deletedAt) return null;
  return { provider_company_code: 'RP031', listable: false, vehicle_status: '출고불가', status: '출고불가', status_kind: '불가',
    status_reason: '이안카 최신 API 미관측 / 확인중 / 공개 보류(삭제 아님)', iancar_phase_one: null,
    iancar_phase_one_source_original: old.iancar_phase_one ?? old.iancar_phase_one_source_original ?? null,
    publication_withdrawal_source_original: Object.hasOwn(old, 'publication_withdrawal_source_original')
      ? old.publication_withdrawal_source_original : old.publication_withdrawal ?? null,
    publication_withdrawal: { reason: 'SOURCE_ABSENCE_HOLD', sourceDigest, sourceSyncedAt, deleteAuthorized: false } };
}

export function encodeIancarBackupValue(value: unknown): any {
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('IANCAR_BACKUP_UNSUPPORTED_SCALAR');
  if (value instanceof Timestamp) return { type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof GeoPoint) return { type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { type: 'bytes', base64: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return { type: 'array', values: value.map(encodeIancarBackupValue) };
  if (value && typeof value === 'object') {
    if ('path' in value && value.constructor.name === 'DocumentReference') throw new Error('IANCAR_BACKUP_REFERENCE_REQUIRES_EXPLICIT_PROJECT_ENCODING');
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('IANCAR_BACKUP_UNSUPPORTED_TYPE');
    return { type: 'object', values: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeIancarBackupValue(item)])) };
  }
  return { type: 'scalar', value };
}

export function decodeIancarBackupValue(value: any, reference: (path: string) => unknown): any {
  if (!value || typeof value !== 'object') throw new Error('IANCAR_BACKUP_UNKNOWN_TYPE');
  if (value.type === 'timestamp') return new Timestamp(value.seconds, value.nanoseconds);
  if (value.type === 'geopoint') return new GeoPoint(value.latitude, value.longitude);
  if (value.type === 'bytes') return Buffer.from(value.base64, 'base64');
  if (value.type === 'array') return value.values.map((item: any) => decodeIancarBackupValue(item, reference));
  if (value.type === 'object') return Object.fromEntries(Object.entries(value.values).map(([key, item]) => [key, decodeIancarBackupValue(item, reference)]));
  if (value.type === 'scalar') return value.value;
  throw new Error('IANCAR_BACKUP_UNKNOWN_TYPE');
}

export const IANCAR_PUBLICATION_MAX_LOCK_SKIP_RATIO = 0.20;

/** RP031-only compatibility publication. Canonical Catalog writer ownership is not cut over here. */
export async function publishIancarPhaseOne(input: {
  products: PhaseOneProduct[]; sourceDigest: string; sourceSyncedAt: string;
  apply: boolean; expectedPlanDigest?: string; mirrorInventory?: boolean; privateEvidenceBucket?: string; sourceEvidence?: string;
}) {
  const products = input.products;
  if (input.mirrorInventory) {
    // A mirror cannot withdraw stock on an unbound/truncated list or a bare SHA-shaped string.
    let capture: any;
    try { capture = JSON.parse(input.sourceEvidence ?? ''); } catch { throw new Error('IANCAR_MIRROR_COMPLETE_EVIDENCE_REQUIRED'); }
    if (capture.readyForRawIngest !== true || capture.stale !== false || !Array.isArray(capture.issues) || capture.issues.length
      || capture.factScope !== 'PHASE_ONE_FACTS' || capture.sourceDigest !== input.sourceDigest || capture.syncedAt !== input.sourceSyncedAt
      || capture.total !== products.length || !Array.isArray(capture.records) || capture.records.length !== products.length
      || capture.pages !== Math.ceil(capture.total / 100)
      || new Set(capture.records.map((r: any) => r.vehicleId)).size !== products.length
      || capture.records.some((r: any) => !products.some(p => p.sourceVehicleId === r.vehicleId
        && p.car_number.replace(/\s/g, '') === String(r.payload?.plate_number ?? '').replace(/\s/g, ''))))
      throw new Error('IANCAR_MIRROR_COMPLETE_EVIDENCE_REQUIRED');
  }
  const assertFresh = () => {
    const synced = Date.parse(input.sourceSyncedAt);
    if (!/^[a-f0-9]{64}$/.test(input.sourceDigest) || !products.length || !Number.isFinite(synced)
      || Date.now() - synced > 900000 || synced - Date.now() > 60000)
      throw new Error('IANCAR_PUBLICATION_SOURCE_STALE_OR_INVALID');
    for (const product of products) if (product.photo && (!Number.isFinite(Date.parse(product.photo.observedAt))
      || Date.now() - Date.parse(product.photo.observedAt) > 900_000 || Date.parse(product.photo.observedAt) > Date.now() + 60_000
      || !Number.isSafeInteger(product.photo.count) || product.photo.count < 0 || product.photo.count > 200
      || product.photo.photoIds.length !== product.photo.count || new Set(product.photo.photoIds).size !== product.photo.count))
      throw new Error('IANCAR_PHOTO_CAPTURE_STALE_OR_INVALID');
  };
  assertFresh();
  if (products.length > 450 || new Set(products.map(p => p.car_number.replace(/\s/g, ''))).size !== products.length
    || new Set(products.map(p => p.sourceVehicleId)).size !== products.length)
    throw new Error('IANCAR_PUBLICATION_DUPLICATE_OR_OVERSIZED_INPUT');
  const app = getTargetFirebaseApp();
  if (app.options.projectId !== 'freepasserp5') throw new Error('IANCAR_PUBLICATION_WRONG_PROJECT');
  const db = getFirestore(app);
  const all = await db.collection('products').get();
  const plates = (value: unknown) => String(value ?? '').replace(/\s/g, '');
  const originals = new Map(all.docs.map(doc => [doc.id, doc]));
  const skipped: { id: string; reason: string; revision: number }[] = [];
  const skippedByReason = { CONTRACT_LOCK: 0, DELETION_LOCK: 0, CONTRACT_AND_DELETION_LOCK: 0 };
  const candidates = products.map(product => {
    const plate = plates(product.car_number);
    if (!/^\d{2,3}[가-힣]\d{4}$/.test(plate) || !product.sourceVehicleId) throw new Error('IANCAR_PUBLICATION_IDENTITY_INVALID');
    const matches = all.docs.filter(doc => plates(doc.data().car_number) === plate);
    if (matches.length > 1 || matches.some(doc => doc.data().provider_company_code !== 'RP031'))
      throw new Error('IANCAR_PUBLICATION_PLATE_COLLISION');
    const prior = matches[0];
    const old = prior?.data() ?? {};
    if (all.docs.some(doc => doc.data().iancar_one_vehicle_id === product.sourceVehicleId && doc.id !== prior?.id))
      throw new Error('IANCAR_PUBLICATION_SOURCE_ID_COLLISION');
    if (old.iancar_one_vehicle_id && old.iancar_one_vehicle_id !== product.sourceVehicleId)
      throw new Error('IANCAR_PUBLICATION_SOURCE_ID_COLLISION');
    const id = prior?.id ?? `iancar_${stableDigest(['RP031', product.sourceVehicleId]).slice(0, 24)}`;
    if (!prior && originals.has(id)) throw new Error('IANCAR_PUBLICATION_ID_COLLISION');
    if (old.locked_by_contract || old._deleted || old.deletedAt) {
      const reason = old.locked_by_contract
        ? (old._deleted || old.deletedAt ? 'CONTRACT_AND_DELETION_LOCK' : 'CONTRACT_LOCK') : 'DELETION_LOCK';
      skippedByReason[reason]++;
      skipped.push({ id, reason, revision: prior!.updateTime.toMillis() });
      return null;
    }
    const fields: Record<string, unknown> = {
      provider_company_code: 'RP031', partner_code: 'RP031', provider_name: '이안카',
      car_number: plate, product_code: old.product_code ?? id,
      vehicle_status: product.vehicle_status, status: product.status, status_kind: product.status_kind,
      listable: product.listable, price: product.price, policy_code: null,
      policy_code_source_original: old.policy_code ?? old.policy_code_source_original ?? null,
      policy_reference_state: 'DEFERRED', iancar_one_vehicle_id: product.sourceVehicleId,
      iancar_phase_one: product.evidence, publication_withdrawal: null,
      publication_withdrawal_source_original: Object.hasOwn(old, 'publication_withdrawal_source_original')
        ? old.publication_withdrawal_source_original : old.publication_withdrawal ?? null,
      status_reason: '이안카 ONE API 1차 차량·요금 반영 / 정책 확인중',
      source: 'EANCAR_ONE_API', source_schema: 'iancar-one-phase-one-product/1',
      _direct_ingest_at: Date.parse(input.sourceSyncedAt),
      deposit_note: '기간·주행거리별 보증금 상이: 상품 요금 조건 확인'
    };
    if (typeof product.facts.rawName === 'string' && product.facts.rawName.trim()
      && (old.원문 == null || (typeof old.원문 === 'object' && !Array.isArray(old.원문))))
      fields.원문 = { ...(old.원문 ?? {}), 차명: product.facts.rawName };
    // Existing refined identity/specs are preserved; unknown new facts stay null, never guessed.
    if (!prior) for (const [key, value] of Object.entries(product.facts)) {
      if (['maker', 'model', 'year', 'fuel_type', 'ext_color', 'mileage'].includes(key)) fields[key] = value;
    }
    if (product.photo) Object.assign(fields, iancarPhotoPatch(old, { ...product.photo,
      productId: id, vehicleId: product.sourceVehicleId, plate }), { iancar_one_photo_ids: product.photo.photoIds });
    return { id, prior, fields };
  });
  const skippedCount = skipped.length;
  const skippedRatio = skippedCount / products.length;
  if (skippedRatio > IANCAR_PUBLICATION_MAX_LOCK_SKIP_RATIO)
    throw Object.assign(new Error('IANCAR_PUBLICATION_LOCK_SKIP_RATIO_EXCEEDED'), {
      skippedCount, skippedByReason, sourceCount: products.length, skippedRatio,
      maxSkippedRatio: IANCAR_PUBLICATION_MAX_LOCK_SKIP_RATIO, writeExecuted: false,
    });
  const planned = candidates.filter(row => row !== null);
  if (input.mirrorInventory) {
    const observedIds = new Set(products.map(p => p.sourceVehicleId));
    const observedPlates = new Set(products.map(p => plates(p.car_number)));
    for (const prior of all.docs) {
      if (observedPlates.has(plates(prior.data().car_number))) continue;
      const fields = iancarAbsencePatch(prior.data(), observedIds, input.sourceDigest, input.sourceSyncedAt);
      if (fields) planned.push({ id: prior.id, prior, fields });
    }
  }
  if (planned.length > 450) throw new Error('IANCAR_PUBLICATION_OVERSIZED_PLAN');
  const planDigest = stableDigest({ sourceDigest: input.sourceDigest, skipped,
    records: planned.map(row => ({ id: row.id, updateTime: row.prior?.updateTime.toMillis() ?? null, fields: row.fields })) });
  const appliedProducts = products.filter((_, index) => candidates[index] !== null);
  const summary = { provider: 'RP031', sourceCount: products.length,
    skippedCount, skippedByReason, skippedRatio, maxSkippedRatio: IANCAR_PUBLICATION_MAX_LOCK_SKIP_RATIO,
    warnings: skippedCount ? ['IANCAR_PUBLICATION_LOCKED_PRODUCTS_SKIPPED'] : [],
    matched: planned.filter(row => row.prior && row.fields.iancar_phase_one).length, created: planned.filter(row => !row.prior).length,
    absenceHeld: planned.filter(row => row.fields.publication_withdrawal).length,
    withPhotos: appliedProducts.filter(row => row.photo && row.photo.count > 0).length,
    photoCount: appliedProducts.reduce((count, row) => count + (row.photo?.count ?? 0), 0),
    open: appliedProducts.filter(row => row.listable).length, deletes: 0, contractChanges: 0, policyDocumentChanges: 0,
    policyReferencesDeferred: planned.filter(row => row.prior?.data().policy_code).length,
    policyDeferredTotal: planned.length,
    unobservedHistoricalPreserved: all.docs.filter(doc => doc.data().provider_company_code === 'RP031' && !planned.some(row => row.id === doc.id)).length,
    withdrawalHoldsReleased: planned.filter(row => row.prior?.data().publication_withdrawal && row.fields.listable).length, planDigest };
  if (!input.apply) return { ...summary, status: 'DRY_RUN', writeExecuted: false };
  if (input.expectedPlanDigest !== planDigest) throw new Error('IANCAR_PUBLICATION_PLAN_CHANGED');
  if (input.mirrorInventory && !input.privateEvidenceBucket) throw new Error('IANCAR_MIRROR_DURABLE_BACKUP_REQUIRED');
  const runId = randomUUID();
  const directory = join(homedir(), '.codex', 'private', 'freepass-data-iancar-withdrawals');
  await mkdir(directory, { recursive: true });
  const backupPath = join(directory, `phase-one-${runId}.json`);
  const backup = JSON.stringify({ schema: 'iancar-phase-one-typed-backup/1', runId, projectId: 'freepasserp5', planDigest,
    sourceDigest: input.sourceDigest, capturedAt: new Date().toISOString(), sourceEvidence: input.sourceEvidence ?? null,
    documents: planned.map(row => ({ path: `products/${row.id}`, exists: !!row.prior,
      updateTime: row.prior?.updateTime.toDate().toISOString() ?? null,
      data: encodeIancarBackupValue(row.prior?.data() ?? null), patch: encodeIancarBackupValue(row.fields) })) });
  await writeFile(backupPath, backup, { flag: 'wx', mode: 0o600 });
  if (await readFile(backupPath, 'utf8') !== backup) throw new Error('IANCAR_BACKUP_READBACK_FAILED');
  let privateBackupObject: string | null = null;
  if (input.privateEvidenceBucket) {
    if (input.privateEvidenceBucket !== 'freepasserp5-data-audit-evidence') throw new Error('IANCAR_BACKUP_WRONG_BUCKET');
    privateBackupObject = `iancar-one/${runId}/backup.json`;
    const file = getStorage(app).bucket(input.privateEvidenceBucket).file(privateBackupObject);
    await file.save(backup, { resumable: false, contentType: 'application/json', preconditionOpts: { ifGenerationMatch: 0 } });
    const [bytes] = await file.download();
    if (bytes.toString('utf8') !== backup) throw new Error('IANCAR_PRIVATE_BACKUP_READBACK_FAILED');
  }
  if ((process.env.GITHUB_ACTIONS === 'true' || process.env.NODE_ENV === 'production') && !privateBackupObject)
    throw new Error('IANCAR_HOSTED_DURABLE_BACKUP_REQUIRED');
  await db.runTransaction(async tx => {
    // Read the complete collision/contract scope before any write.
    const current = await tx.get(db.collection('products'));
    if (current.size !== all.size || current.docs.some(doc => !originals.get(doc.id)?.updateTime.isEqual(doc.updateTime)))
      throw new Error('IANCAR_PUBLICATION_REVISION_CHANGED');
    assertFresh();
    for (const row of planned) {
      const ref = db.collection('products').doc(row.id);
      if (row.prior) tx.update(ref, row.fields);
      else tx.create(ref, row.fields);
    }
  });
  try {
  const after = await db.getAll(...planned.map(row => db.collection('products').doc(row.id)));
  for (let i = 0; i < planned.length; i++) {
    const row = planned[i]!; const data = after[i]!.data();
    if (!data || Object.entries(row.fields).some(([key, value]) => stableDigest(data[key]) !== stableDigest(value)))
      throw new Error('IANCAR_PUBLICATION_READBACK_FAILED');
    if (row.prior) for (const [key, value] of Object.entries(row.prior.data())) {
      if (!(key in row.fields) && stableDigest(data[key]) !== stableDigest(value))
        throw new Error('IANCAR_PUBLICATION_UNEXPECTED_FIELD_CHANGE');
    }
  }
  } catch (error) {
    throw Object.assign(new Error('IANCAR_PUBLICATION_COMMITTED_READBACK_FAILED'), { cause: error, runId, backupPath, writeExecuted: true });
  }
  return { ...summary, status: 'PHASE_ONE_ATOM_READBACK_VERIFIED', writeExecuted: true,
    runId, backupPath, privateBackupObject, sourceDigest: input.sourceDigest, consumerReadback: 'NOT_VERIFIED' };
}

/** Restore only a still-unmodified publication. New records are withdrawn, never deleted. */
export async function restoreIancarPhaseOne(input: { backupPath: string; apply: boolean; expectedSourceDigest: string; expectedSchema?: string }) {
  const backup = JSON.parse(await readFile(input.backupPath, 'utf8'));
  const photoOnly = backup.schema === 'iancar-photo-typed-backup/1';
  if (input.expectedSchema && backup.schema !== input.expectedSchema) throw new Error('IANCAR_RESTORE_BACKUP_INVALID');
  if ((!photoOnly && backup.schema !== 'iancar-phase-one-typed-backup/1') || backup.projectId !== 'freepasserp5' || backup.sourceDigest !== input.expectedSourceDigest || !Array.isArray(backup.documents))
    throw new Error('IANCAR_RESTORE_BACKUP_INVALID');
  const app = getTargetFirebaseApp();
  if (app.options.projectId !== 'freepasserp5') throw new Error('IANCAR_RESTORE_WRONG_PROJECT');
  const db = getFirestore(app);
  for (const row of backup.documents) {
    row.data = decodeIancarBackupValue(row.data, path => db.doc(path));
    row.patch = decodeIancarBackupValue(row.patch, path => db.doc(path));
  }
  const refs = backup.documents.map((row: any) => {
    if (!/^products\/[^/]+$/.test(row.path) || row.patch.provider_company_code !== 'RP031') throw new Error('IANCAR_RESTORE_SCOPE_INVALID');
    if (photoOnly && (!row.exists || Object.keys(row.patch).some(key => !['provider_company_code', 'iancar_one_photo_count', 'iancar_one_photos_observed_at', 'iancar_one_photo_state', 'image_urls', 'image_url', 'image_kind', 'iancar_model_illustration', 'iancar_photo_source_original'].includes(key)))) throw new Error('IANCAR_RESTORE_SCOPE_INVALID');
    return db.doc(row.path);
  });
  await db.runTransaction(async tx => {
    const current = await tx.getAll(...refs);
    for (let i = 0; i < current.length; i++) {
      const data = current[i]!.data() as Record<string, unknown> | undefined; const row = backup.documents[i];
      if (!data || (!photoOnly && data.locked_by_contract) || Object.entries(row.patch).some(([key, value]) => stableDigest(data[key]) !== stableDigest(value)))
        throw new Error('IANCAR_RESTORE_REVISION_CHANGED');
      if (photoOnly && (data.provider_company_code !== 'RP031' || data.iancar_one_vehicle_id !== row.data.iancar_one_vehicle_id || data.car_number !== row.data.car_number)) throw new Error('IANCAR_RESTORE_IDENTITY_CHANGED');
      if (!photoOnly && row.exists && Object.entries(row.data).some(([key, value]) => !(key in row.patch) && stableDigest(data[key]) !== stableDigest(value)))
        throw new Error('IANCAR_RESTORE_REVISION_CHANGED');
    }
    if (!input.apply) return;
    for (let i = 0; i < refs.length; i++) {
      const row = backup.documents[i];
      const patch = row.exists ? Object.fromEntries(Object.keys(row.patch).map(key => [key, key in row.data ? row.data[key] : FieldValue.delete()]))
        : { listable: false, vehicle_status: '출고불가', status: '출고불가', status_kind: '불가', status_reason: '이안카 1차 발행 복구: 신규 이력 보존' };
      tx.update(refs[i]!, patch);
    }
  });
  if (input.apply && photoOnly) {
    const restored = await db.getAll(...refs);
    for (let i = 0; i < restored.length; i++) {
      const actual = restored[i]!.data(); const row = backup.documents[i];
      if (!actual || Object.keys(row.patch).some(key => key in row.data ? stableDigest(actual[key]) !== stableDigest(row.data[key]) : key in actual)) throw new Error('IANCAR_PHOTO_RESTORE_READBACK_FAILED');
    }
    return { status: 'PHOTO_RESTORE_READBACK_VERIFIED', count: refs.length, deletes: 0 };
  }
  return { status: input.apply ? 'RESTORED_REQUIRES_READBACK' : 'RESTORE_PLAN_VERIFIED', count: refs.length, deletes: 0 };
}

/** Operator withdrawal, not supplier absence/retirement or contract cancellation. */
export async function withdrawIancarPublication(input: {
  apply: boolean; expectedCount: number; expectedOpen: number;
}) {
  const app = getTargetFirebaseApp();
  if (app.options.projectId !== 'freepasserp5') throw new Error('IANCAR_WITHDRAWAL_WRONG_PROJECT');
  const db = getFirestore(app);
  const query = db.collection('products').where('provider_company_code', '==', 'RP031');
  const before = await query.get();
  const open = before.docs.filter(doc => doc.data().vehicle_status !== '출고불가' || doc.data().listable === true);
  if (before.size !== input.expectedCount || open.length !== input.expectedOpen)
    throw new Error('IANCAR_WITHDRAWAL_SCOPE_CHANGED');
  if (before.docs.some(doc => doc.data().locked_by_contract))
    throw new Error('IANCAR_WITHDRAWAL_CONTRACT_LOCK_REQUIRES_REVIEW');
  const summary = { provider: 'RP031', productCount: before.size,
    changedCount: open.length, deletes: 0, contractChanges: 0 };
  if (!input.apply) return { ...summary, status: 'DRY_RUN', writeExecuted: false };
  const runId = randomUUID();
  const backupDir = join(homedir(), '.codex', 'private', 'freepass-data-iancar-withdrawals');
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `${runId}.json`);
  const backup = JSON.stringify({ runId, projectId: 'freepasserp5',
    capturedAt: new Date().toISOString(),
    documents: before.docs.map(doc => ({ path: doc.ref.path,
      updateTime: doc.updateTime.toDate().toISOString(), data: doc.data() })) });
  await writeFile(backupPath, backup, { flag: 'wx', mode: 0o600 });
  if (await readFile(backupPath, 'utf8') !== backup) throw new Error('IANCAR_BACKUP_READBACK_FAILED');
  const originals = new Map(before.docs.map(doc => [doc.id, doc]));
  const changedIds = new Set(open.map(doc => doc.id));
  await db.runTransaction(async transaction => {
    const current = await transaction.get(query);
    if (current.size !== before.size) throw new Error('IANCAR_WITHDRAWAL_SCOPE_CHANGED');
    for (const doc of current.docs) {
      const original = originals.get(doc.id);
      if (!original || !doc.updateTime.isEqual(original.updateTime))
        throw new Error('IANCAR_WITHDRAWAL_REVISION_CHANGED');
      if (doc.data().provider_company_code !== 'RP031' || doc.data().locked_by_contract)
        throw new Error('IANCAR_WITHDRAWAL_AUTHORITY_CHANGED');
    }
    for (const doc of current.docs) {
      if (!changedIds.has(doc.id)) continue;
      transaction.update(doc.ref, {
        vehicle_status: '출고불가', status: '출고불가', status_kind: '불가', listable: false,
        status_reason: '사용자 요청: 이안카 API 연동 검증 전 임시 노출 중단',
        publication_withdrawal: { runId, reason: 'IANCAR_API_CUTOVER_HOLD',
          previousVehicleStatus: originals.get(doc.id)!.data().vehicle_status ?? null }
      });
    }
  });
  const after = await query.get();
  if (after.size !== before.size || after.docs.some(doc => doc.data().listable === true
    || doc.data().vehicle_status !== '출고불가')) throw new Error('IANCAR_WITHDRAWAL_READBACK_FAILED');
  for (const doc of after.docs) {
    const original = originals.get(doc.id)!;
    const data = doc.data();
    const prior = original.data();
    const allowed = new Set(['vehicle_status', 'status', 'status_kind', 'listable', 'status_reason', 'publication_withdrawal']);
    const untouched = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
      .filter(([key]) => !allowed.has(key)));
    if (stableDigest(untouched(data)) !== stableDigest(untouched(prior)))
      throw new Error('IANCAR_WITHDRAWAL_UNEXPECTED_FIELD_CHANGE');
  }
  return { ...summary, status: 'WITHDRAWN_ATOM_READBACK_VERIFIED', writeExecuted: true,
    runId, backupPath, backupDigest: stableDigest(backup), consumerReadback: 'NOT_VERIFIED' };
}
