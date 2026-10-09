import { createHash } from 'node:crypto';
import { resolveReferenceVehiclePhotos } from './kakao-catalog-reference.js';
import { plateIdentityKey } from '../domain/vehicle-plate.js';
import { resolveErp5InventoryStatus } from '../domain/erp5-inventory-status.js';
import { validateSheetPublicationHandoff, type SheetPublicationHandoff } from '../domain/sheet-publication-handoff.js';

type RecordValue = Record<string, unknown>;
export type VehicleMediaSourceEvidence = {
  plate: string;
  sourceRef: string;
  observedAt: string;
  expectedFreshnessSeconds: number;
  vehicle: RecordValue;
};
export type ImageHeadEvidence = { status: number; contentType: string | null };

/** Compare a specified consumer snapshot without treating a card feed as a full gallery. */
export function compareVehicleMediaConsumerEvidence(input: {
  productId: string;
  product: RecordValue;
  consumerProductId: string;
  consumer: RecordValue;
  consumerSnapshotRef: string;
  observedAt: string;
  requiresGallery: boolean;
}) {
  const issues: string[] = [];
  const key = plateIdentityKey(input.product.car_number);
  if (!input.productId.trim() || input.productId !== input.consumerProductId
    || !key || key !== plateIdentityKey(input.consumer.car_number)) issues.push('CONSUMER_VEHICLE_IDENTITY_MISMATCH');
  if (!input.consumerSnapshotRef.trim() || !Number.isFinite(Date.parse(input.observedAt))) issues.push('CONSUMER_SNAPSHOT_EVIDENCE_MISSING');
  const original = resolveReferenceVehiclePhotos(input.product);
  const output = resolveReferenceVehiclePhotos(input.consumer);
  if (original.rejectedCount) issues.push('SOURCE_PHOTO_URL_REJECTED');
  if (output.rejectedCount) issues.push('CONSUMER_PHOTO_URL_REJECTED');
  const cache = input.product.photo_cache;
  const cacheRecord = cache && typeof cache === 'object' && !Array.isArray(cache)
    ? cache as RecordValue : null;
  const cachePhotos = resolveReferenceVehiclePhotos({ image_urls: cacheRecord?.urls });
  const cacheBoundToLink = original.state === 'LINK_ONLY' && original.sourceLinkCount === 1
    && original.rejectedCount === 0 && typeof input.product.photo_link === 'string' && !!input.product.photo_link.trim()
    && cacheRecord?.src === input.product.photo_link;
  const cacheMatchesOutput = original.imageUrls.length === 0 && cacheBoundToLink
    && cachePhotos.imageUrls.length > 0 && cachePhotos.rejectedCount === 0
    && JSON.stringify(cachePhotos.imageUrls) === JSON.stringify(output.imageUrls);
  const documentUrls = resolveReferenceVehiclePhotos({ image_urls: [input.product.doc_images, input.consumer.doc_images] }).imageUrls;
  if (output.imageUrls.some(url => documentUrls.includes(url))) issues.push('DOCUMENT_IMAGE_IN_CONSUMER_PHOTOS');
  if (cacheRecord && !cacheBoundToLink && output.imageUrls.length && !original.imageUrls.length) issues.push('CACHE_SOURCE_BINDING_UNVERIFIED');
  if (cacheRecord && cachePhotos.rejectedCount && output.imageUrls.length && !original.imageUrls.length) issues.push('CACHE_PHOTO_URL_REJECTED');
  if (original.representativeUrl !== output.representativeUrl) issues.push('REPRESENTATIVE_DIFFERENT_EVIDENCE');
  const color = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
  if (color(input.product.ext_color) !== color(input.consumer.ext_color)) issues.push('CONSUMER_COLOR_MISMATCH');
  const galleryExposed = Array.isArray(input.consumer.image_urls);
  if (input.requiresGallery && !galleryExposed) issues.push('CONSUMER_GALLERY_NOT_EXPOSED');
  if (galleryExposed && JSON.stringify(original.imageUrls) !== JSON.stringify(output.imageUrls)) issues.push('CONSUMER_GALLERY_MISMATCH');
  return {
    productKeyDigest: createHash('sha256').update(input.productId).digest('hex'),
    observedAt: input.observedAt,
    verdict: issues.length ? 'HOLD' as const : 'SPECIFIED_CONSUMER_FIELDS_MATCHED' as const,
    issues,
    galleryState: galleryExposed ? 'COMPARED' as const : 'NOT_EXPOSED' as const,
    // Describe existing consumer behavior; cache/link agreement does not certify its contents.
    outputEvidence: cacheMatchesOutput ? 'EXISTING_LINK_BOUND_CACHE' as const
      : original.imageUrls.length ? 'DIRECT_URL_COMPARISON' as const : 'NO_DIRECT_URL_EVIDENCE' as const,
    typedColorVerification: 'NOT_CHECKED' as const,
    visualVehicleIdentity: 'NOT_CHECKED' as const,
  };
}

/** Read-only diagnostics. HEAD proves declared accessibility, never visual identity or image bytes. */
export async function inspectVehicleMediaEvidence(input: {
  productId: string;
  product: RecordValue;
  source?: VehicleMediaSourceEvidence;
  sourceHttpStatus?: number;
  now: string;
  probe?: (url: string) => Promise<ImageHeadEvidence>;
}) {
  const photos = resolveReferenceVehiclePhotos(input.product);
  const issues: string[] = [];
  if (input.sourceHttpStatus === 401) issues.push('SOURCE_ACCESS_UNAUTHORIZED');
  else if (input.sourceHttpStatus === 403) issues.push('SOURCE_ACCESS_FORBIDDEN');
  else if (input.sourceHttpStatus !== undefined && (!Number.isInteger(input.sourceHttpStatus)
    || input.sourceHttpStatus < 200 || input.sourceHttpStatus >= 300)) issues.push('SOURCE_ACCESS_FAILED');
  if (!Number.isFinite(Date.parse(input.now))) issues.push('OBSERVATION_TIME_INVALID');
  if (!input.productId.trim()) issues.push('PRODUCT_ID_MISSING');
  if (!photos.imageUrls.length) issues.push(photos.state === 'LINK_ONLY' ? 'PHOTO_LINK_ONLY' : 'PHOTO_NOT_USABLE');
  if (photos.rejectedCount) issues.push('PHOTO_URL_REJECTED');
  const color = typeof input.product.ext_color === 'string' && input.product.ext_color.trim()
    ? input.product.ext_color : null;
  if (color === null) issues.push('COLOR_NOT_PROVIDED');
  const source = input.source;
  if (!source) issues.push('SOURCE_EVIDENCE_MISSING');
  else {
    const age = Date.parse(input.now) - Date.parse(source.observedAt);
    if (!Number.isFinite(age) || age < 0 || !Number.isFinite(source.expectedFreshnessSeconds)
      || source.expectedFreshnessSeconds <= 0 || age > source.expectedFreshnessSeconds * 1000)
      issues.push('SOURCE_FRESHNESS_UNVERIFIED');
    const productPlate = plateIdentityKey(input.product.car_number);
    if (!productPlate || !plateIdentityKey(source.plate) || productPlate !== plateIdentityKey(source.plate)
      || plateIdentityKey(source.vehicle.car_number) !== productPlate) issues.push('SOURCE_VEHICLE_IDENTITY_MISMATCH');
    if (!source.sourceRef.trim()) issues.push('SOURCE_REF_MISSING');
    const original = resolveReferenceVehiclePhotos(source.vehicle);
    if (JSON.stringify(original.imageUrls) !== JSON.stringify(photos.imageUrls)) issues.push('PHOTO_SOURCE_ARRAY_MISMATCH');
    const sourceColor = typeof source.vehicle.ext_color === 'string' && source.vehicle.ext_color.trim()
      ? source.vehicle.ext_color : null;
    if (sourceColor !== color) issues.push('COLOR_SOURCE_MISMATCH');
    if (original.rejectedCount) issues.push('SOURCE_PHOTO_URL_REJECTED');
  }
  const documentUrls = new Set(resolveReferenceVehiclePhotos({
    image_urls: [input.product.doc_images, source?.vehicle.doc_images],
  }).imageUrls);
  const checks: Array<{ urlDigest: string; state: string; status: number | null }> = [];
  for (const url of photos.imageUrls) {
    const urlDigest = createHash('sha256').update(url).digest('hex');
    if (documentUrls.has(url)) {
      issues.push('DOCUMENT_IMAGE_IN_VEHICLE_PHOTOS');
      checks.push({ urlDigest, state: 'DOCUMENT_IMAGE_EXCLUDED', status: null });
      continue;
    }
    if (!input.probe) {
      issues.push('HEAD_NOT_CHECKED');
      checks.push({ urlDigest, state: 'HEAD_NOT_CHECKED', status: null });
      continue;
    }
    // Sequential probes are intentional; callers own provider allowlists, deadlines and pacing.
    try {
      const head = await input.probe(url);
      const state = !Number.isInteger(head.status) || head.status < 200 || head.status >= 300 ? 'HTTP_FAILURE'
        : /^image\/[a-z0-9.+-]+(?:\s*;|$)/i.test(head.contentType?.trim() ?? '') ? 'HEAD_IMAGE_AVAILABLE' : 'NON_IMAGE_CONTENT_TYPE';
      if (state !== 'HEAD_IMAGE_AVAILABLE') issues.push(state);
      checks.push({ urlDigest, state, status: head.status });
    } catch {
      // Never retain URL-bearing error messages or credential-bearing provider responses.
      issues.push('HEAD_REQUEST_FAILED');
      checks.push({ urlDigest, state: 'HEAD_REQUEST_FAILED', status: null });
    }
  }
  return {
    productKeyDigest: createHash('sha256').update(input.productId).digest('hex'),
    observedAt: input.now,
    verdict: issues.length ? 'HOLD' as const : 'HEAD_AND_SOURCE_FIELDS_MATCHED' as const,
    issues: [...new Set(issues)],
    photoState: photos.state,
    colorState: color === null ? 'NOT_PROVIDED' as const : source ? 'SOURCE_COMPARISON_ATTEMPTED' as const : 'VALUE_PRESENT_SOURCE_UNVERIFIED' as const,
    typedColorVerification: 'NOT_CHECKED' as const,
    checks,
    visualVehicleIdentity: 'NOT_CHECKED' as const,
    imageBytes: 'NOT_CHECKED' as const,
    consumerReadback: 'NOT_CHECKED' as const,
  };
}

/** Publisher review only: exclude from the next projection, never delete source records or sheet cells. */
export function planF01UnavailableMediaRows(input: {
  handoff?: SheetPublicationHandoff;
  readback: {
    snapshotId: string | null;
    dataDigest: string | null;
    observedAt: string;
    complete: boolean;
    rows: Array<{ rowNumber: number; productId: string; plate: string }>;
  };
  now: string;
  maxAgeSeconds: number;
}) {
  const issues: string[] = [];
  const exclusions: Array<{ rowNumber: number; productKeyDigest: string; action: 'EXCLUDE_FROM_NEXT_PUBLICATION' }> = [];
  const handoff = input.handoff;
  if (!handoff) issues.push('RELEASE_BOUND_HANDOFF_MISSING');
  else {
    try {
      const check = validateSheetPublicationHandoff(handoff);
      if (check.status !== 'PASS') issues.push(...check.violations);
    } catch { issues.push('INVALID_RELEASE_BOUND_HANDOFF'); }
    if (handoff.workbook !== 'F01') issues.push('F01_WORKBOOK_REQUIRED');
    if (input.readback.snapshotId !== handoff.snapshot?.snapshotId
      || input.readback.dataDigest !== handoff.manifest?.dataDigest) issues.push('READBACK_SNAPSHOT_MISMATCH');
    const age = Date.parse(input.now) - Date.parse(handoff.manifest?.sourceReadTime);
    if (!Number.isFinite(age) || age < 0 || age > input.maxAgeSeconds * 1000) issues.push('SOURCE_SNAPSHOT_STALE');
  }
  const readbackAge = Date.parse(input.now) - Date.parse(input.readback.observedAt);
  if (!Number.isFinite(readbackAge) || readbackAge < 0 || !Number.isFinite(input.maxAgeSeconds)
    || input.maxAgeSeconds <= 0 || readbackAge > input.maxAgeSeconds * 1000) issues.push('READBACK_FRESHNESS_UNVERIFIED');
  if (!input.readback.complete) issues.push('READBACK_INCOMPLETE');
  if (issues.length) return {
    verdict: 'HOLD' as const, issues: [...new Set(issues)], exclusions,
    sourceMutation: 'NONE' as const, directSheetMutation: 'NONE' as const,
  };
  const rowKeys = new Set<string>();
  const rowNumbers = new Set<number>();
  const rowPlates = new Set<string>();
  for (const row of input.readback.rows) {
    const plate = plateIdentityKey(row.plate);
    if (!row.productId.trim() || !plate || !Number.isSafeInteger(row.rowNumber) || row.rowNumber < 2
      || rowKeys.has(row.productId) || rowNumbers.has(row.rowNumber) || rowPlates.has(plate)) issues.push('READBACK_ROW_IDENTITY_AMBIGUOUS');
    rowKeys.add(row.productId); rowNumbers.add(row.rowNumber); rowPlates.add(plate);
    if (!handoff?.snapshot?.products) continue;
    const matches = handoff.snapshot.products.filter(p => p._key === row.productId);
    if (matches.length !== 1 || plateIdentityKey(matches[0]?.car_number) !== plate
      || handoff.snapshot.products.filter(p => plateIdentityKey(p.car_number) === plate).length !== 1) {
      issues.push('READBACK_PRODUCT_IDENTITY_MISMATCH'); continue;
    }
    const product = matches[0]!;
    const status = resolveErp5InventoryStatus(product.vehicle_status);
    if (typeof product.listable !== 'boolean' || !status.known || product.listable !== status.listable
      || product.status_kind !== status.statusKind) { issues.push('PUBLICATION_STATUS_UNVERIFIED'); continue; }
    if (product.listable === false) exclusions.push({ rowNumber: row.rowNumber,
      productKeyDigest: createHash('sha256').update(row.productId).digest('hex'), action: 'EXCLUDE_FROM_NEXT_PUBLICATION' });
  }
  return {
    verdict: issues.length ? 'HOLD' as const : 'PLAN_ONLY' as const,
    issues: [...new Set(issues)],
    exclusions: issues.length ? [] : exclusions,
    sourceMutation: 'NONE' as const,
    directSheetMutation: 'NONE' as const,
  };
}
