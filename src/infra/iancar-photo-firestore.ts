import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { stableDigest } from '../shared/stable-digest.js';
import { isPublicIancarPhotoProduct } from './erp5-compat-catalog-reader.js';
import { planIancarPhotoReviewPatch, type IancarOnePhotoReview } from '../domain/consumer-output-contract.js';
import { decodeIancarBackupValue, encodeIancarBackupValue } from './iancar-backup-value.js';
export { planIancarPhotoReviewPatch, type IancarOnePhotoReview } from '../domain/consumer-output-contract.js';

/** 이안카(RP031) 사진 전용 경로. 가격·재고·상태는 쓰지 않는다 — 이안카 상품 문서의 유일한 작성 주체는 원천 엔진(source-engine)이다. */

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
    review?: IancarOnePhotoReview;
    illustration?: { url: string; sourceName: string; kind: 'MODEL_ILLUSTRATION'; sourcePage: string; mappingVersion: string; observedSha256?: string } }[];
  apply: boolean; expectedPlanDigest?: string; verificationOnly?: boolean;
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
    if (row.review && !input.verificationOnly) throw new Error('IANCAR_PHOTO_REVIEW_MODE_REQUIRED');
    if (input.verificationOnly && !row.review) throw new Error('IANCAR_PHOTO_REVIEW_REQUIRED');
    const patch = input.verificationOnly ? planIancarPhotoReviewPatch(original!, row, row.review!)
      : iancarPhotoPatch(original!, row);
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
    if (input.verificationOnly && Object.entries(p.original).some(([key, value]) => !(key in p.patch)
      && stableDigest(actual[key]) !== stableDigest(value)))
      throw Object.assign(new Error('IANCAR_PHOTO_UNEXPECTED_FIELD_CHANGE'), { runId, backupPath, writeExecuted: true });
  }
  return { ...summary, status: 'PHOTO_ATOM_READBACK_VERIFIED', writeExecuted: true, runId, backupPath };
}

/** 죽은 ERP4 별칭 주소만 비우고 «사진 확인 중» 으로 표시한다. 드라이브 사진·폴더 링크가 있거나 별칭이 아닌 주소가 있으면 건드리지 않는다.
 * 원래 값은 iancar_photo_source_original 에 남기고(이미 있으면 유지), 되돌리기는 이 칸으로 한다. */
export function iancarPhotoPendingPatch(old: Record<string, any>): Record<string, unknown> {
  const isAlias = (value: unknown) => {
    try { const url = new URL(String(value)); return url.origin === 'https://freepasserp.com' && url.pathname === '/api/img'; } catch { return false; }
  };
  const urls: unknown[] = [old.image_url, ...(Array.isArray(old.image_urls) ? old.image_urls : [])]
    .filter(value => typeof value === 'string' && value.trim());
  const cacheUrls = Array.isArray(old.photo_cache?.urls) ? old.photo_cache.urls : [];
  const hasDrive = cacheUrls.length > 0 || (typeof old.photo_link === 'string' && !!old.photo_link.trim());
  // 별칭 주소만 있는 문서(또는 사진이 전혀 없는 새 문서)만 대상.
  if (hasDrive || urls.some(value => !isAlias(value))) return {};
  return {
    image_urls: [], image_url: '', image_kind: 'PHOTO_PENDING',
    iancar_photo_source_original: old.iancar_photo_source_original
      ?? { image_urls: old.image_urls ?? null, image_url: old.image_url ?? null, photo_link: old.photo_link ?? null, image_kind: old.image_kind ?? null },
  };
}

const IANCAR_PHOTO_RESTORE_KEYS: ReadonlySet<string> = new Set(['provider_company_code', 'iancar_one_photo_count', 'iancar_one_photos_observed_at',
  'iancar_one_photo_state', 'image_urls', 'image_url', 'image_kind', 'iancar_model_illustration', 'iancar_photo_source_original',
  'photo_original_refs', 'iancar_one_photo_ids']);

/** 사진 전용 백업(iancar-photo-typed-backup/1)만 되돌린다. 사진 칸 밖의 키가 든 백업은 거절한다(가격·재고 복구 경로 없음). */
export async function restoreIancarPhotoReferences(input: { backupPath: string; apply: boolean; expectedSourceDigest: string }) {
  const backup = JSON.parse(await readFile(input.backupPath, 'utf8'));
  if (backup.schema !== 'iancar-photo-typed-backup/1' || backup.projectId !== 'freepasserp5'
    || backup.sourceDigest !== input.expectedSourceDigest || !Array.isArray(backup.documents))
    throw new Error('IANCAR_RESTORE_BACKUP_INVALID');
  const app = getTargetFirebaseApp();
  if (app.options.projectId !== 'freepasserp5') throw new Error('IANCAR_RESTORE_WRONG_PROJECT');
  const db = getFirestore(app);
  for (const row of backup.documents) {
    row.data = decodeIancarBackupValue(row.data, path => db.doc(path));
    row.patch = decodeIancarBackupValue(row.patch, path => db.doc(path));
  }
  const refs = backup.documents.map((row: any) => {
    if (!/^products\/[^/]+$/.test(row.path) || row.patch.provider_company_code !== 'RP031' || !row.exists
      || Object.keys(row.patch).some(key => !IANCAR_PHOTO_RESTORE_KEYS.has(key))) throw new Error('IANCAR_RESTORE_SCOPE_INVALID');
    return db.doc(row.path);
  });
  await db.runTransaction(async tx => {
    const current = await tx.getAll(...refs);
    for (let i = 0; i < current.length; i++) {
      const data = current[i]!.data() as Record<string, unknown> | undefined; const row = backup.documents[i];
      if (!data || Object.entries(row.patch).some(([key, value]) => stableDigest(data[key]) !== stableDigest(value)))
        throw new Error('IANCAR_RESTORE_REVISION_CHANGED');
      if (data.provider_company_code !== 'RP031' || data.iancar_one_vehicle_id !== row.data.iancar_one_vehicle_id || data.car_number !== row.data.car_number)
        throw new Error('IANCAR_RESTORE_IDENTITY_CHANGED');
    }
    if (!input.apply) return;
    for (let i = 0; i < refs.length; i++) {
      const row = backup.documents[i];
      tx.update(refs[i]!, Object.fromEntries(Object.keys(row.patch).map(key => [key, key in row.data ? row.data[key] : FieldValue.delete()])));
    }
  });
  if (!input.apply) return { status: 'RESTORE_PLAN_VERIFIED', count: refs.length, deletes: 0 };
  const restored = await db.getAll(...refs);
  for (let i = 0; i < restored.length; i++) {
    const actual = restored[i]!.data(); const row = backup.documents[i];
    if (!actual || Object.keys(row.patch).some(key => key in row.data ? stableDigest(actual[key]) !== stableDigest(row.data[key]) : key in actual))
      throw new Error('IANCAR_PHOTO_RESTORE_READBACK_FAILED');
  }
  return { status: 'PHOTO_RESTORE_READBACK_VERIFIED', count: refs.length, deletes: 0 };
}
