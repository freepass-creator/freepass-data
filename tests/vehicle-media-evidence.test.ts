import { describe, it, expect } from 'vitest';
import { inspectVehicleMediaEvidence, compareVehicleMediaConsumerEvidence, planF01UnavailableMediaRows } from '../src/application/vehicle-media-evidence.js';
import { hashSheetPublicationData, hashSheetPublicationHandoff, type SheetPublicationHandoff } from '../src/domain/sheet-publication-handoff.js';

const product = { car_number: '12가3456', image_urls: ['https://supplier.example/car.jpg'], ext_color: '흰색' };
const source = { plate: '12가3456', sourceRef: 'fixture:detail/1', observedAt: '2026-10-09T00:00:00Z', expectedFreshnessSeconds: 3600, vehicle: product };
const base = { productId: 'fixture-product', product, source, now: '2026-10-09T00:01:00Z', probe: async () => ({ status: 200, contentType: 'image/jpeg' }) };
describe('read-only media evidence', () => {
  it('holds unprobed URLs even when source fields match without making a network request', async () => {
    const { probe: _probe, ...withoutProbe } = base;
    const result = await inspectVehicleMediaEvidence(withoutProbe);
    expect(result.verdict).toBe('HOLD');
    expect(result.issues).toEqual(['HEAD_NOT_CHECKED']);
    expect(result.checks).toEqual([{ urlDigest: expect.any(String), state: 'HEAD_NOT_CHECKED', status: null }]);
    expect(result).toMatchObject({ imageBytes: 'NOT_CHECKED', visualVehicleIdentity: 'NOT_CHECKED', typedColorVerification: 'NOT_CHECKED', consumerReadback: 'NOT_CHECKED' });
    const { source: _source, ...withoutSource } = withoutProbe;
    expect((await inspectVehicleMediaEvidence(withoutSource)).issues).toEqual(expect.arrayContaining(['SOURCE_EVIDENCE_MISSING', 'HEAD_NOT_CHECKED']));
  });
  it('detects original color loss even when the consumer correctly repeats the blank stored color', async () => {
    const stored = { ...product, ext_color: '' };
    const parity = compareVehicleMediaConsumerEvidence({ productId: 'fixture-product', product: stored,
      consumerProductId: 'fixture-product', consumer: stored, consumerSnapshotRef: 'fixture:detail/1', observedAt: base.now, requiresGallery: true });
    expect(parity.verdict).toBe('SPECIFIED_CONSUMER_FIELDS_MATCHED');
    const original = await inspectVehicleMediaEvidence({ ...base, product: stored,
      source: { ...source, vehicle: { ...product, ext_color: '검정' } } });
    expect(original.verdict).toBe('HOLD');
    expect(original.issues).toContain('COLOR_SOURCE_MISMATCH');
  });
  it('holds failed source authentication even when an older payload and photo URL still match', async () => {
    for (const sourceHttpStatus of [401, 403, 302, NaN]) {
      const r = await inspectVehicleMediaEvidence({ ...base, sourceHttpStatus });
      expect(r.verdict).toBe('HOLD');
      expect(r.issues.some(issue => issue.startsWith('SOURCE_ACCESS_'))).toBe(true);
    }
  });
  it('does not attribute a cache to invalid, multiple or changed source links', () => {
    for (const photo_link of ['file:///folder', 'https://drive.example/a\nhttps://drive.example/b', 'https://drive.example/changed']) {
      const r = compareVehicleMediaConsumerEvidence({ productId: 'fixture-product', product: { car_number: product.car_number, photo_link, photo_cache: { src: photo_link === 'https://drive.example/changed' ? 'https://drive.example/old' : photo_link, urls: product.image_urls } }, consumerProductId: 'fixture-product', consumer: product, consumerSnapshotRef: 'fixture:detail/1', observedAt: base.now, requiresGallery: true });
      expect(r.outputEvidence).not.toBe('EXISTING_LINK_BOUND_CACHE');
      expect(r.issues).toContain('CACHE_SOURCE_BINDING_UNVERIFIED');
    }
  });
  it('holds a document URL exposed through an existing cache', () => {
    const folder = 'https://drive.example/folder';
    const r = compareVehicleMediaConsumerEvidence({ productId: 'fixture-product', product: { car_number: product.car_number, photo_link: folder, photo_cache: { src: folder, urls: product.image_urls }, doc_images: product.image_urls }, consumerProductId: 'fixture-product', consumer: product, consumerSnapshotRef: 'fixture:detail/1', observedAt: base.now, requiresGallery: true });
    expect(r.issues).toContain('DOCUMENT_IMAGE_IN_CONSUMER_PHOTOS');
    expect(r.verdict).toBe('HOLD');
  });
  it('cannot claim empty-array parity by silently discarding invalid consumer URLs', () => {
    const r = compareVehicleMediaConsumerEvidence({ productId: 'fixture-product', product: { car_number: product.car_number },
      consumerProductId: 'fixture-product', consumer: { car_number: product.car_number, image_urls: ['http://supplier.example/rejected.jpg'] },
      consumerSnapshotRef: 'fixture:detail/1', observedAt: base.now, requiresGallery: true });
    expect(r.verdict).toBe('HOLD');
    expect(r.issues).toContain('CONSUMER_PHOTO_URL_REJECTED');
  });
  it('distinguishes representative-only consumer parity from required full gallery', () => {
    const input = { productId: 'fixture-product', product, consumerProductId: 'fixture-product', consumer: { car_number: product.car_number, image_url: product.image_urls[0], ext_color: product.ext_color }, consumerSnapshotRef: 'fixture:feed/1', observedAt: base.now, requiresGallery: false };
    expect(compareVehicleMediaConsumerEvidence(input).galleryState).toBe('NOT_EXPOSED');
    expect(compareVehicleMediaConsumerEvidence(input).verdict).toBe('SPECIFIED_CONSUMER_FIELDS_MATCHED');
    expect(compareVehicleMediaConsumerEvidence({ ...input, requiresGallery: true }).issues).toContain('CONSUMER_GALLERY_NOT_EXPOSED');
  });
  it('holds wrong consumer keys, missing snapshot, cache-only representative and color changes', () => {
    const r = compareVehicleMediaConsumerEvidence({ productId: 'fixture-product', product, consumerProductId: 'other', consumer: { car_number: '99나9999', image_url: 'https://drive.example/cache', ext_color: '검정' }, consumerSnapshotRef: '', observedAt: 'invalid', requiresGallery: true });
    expect(r.issues).toEqual(expect.arrayContaining(['CONSUMER_VEHICLE_IDENTITY_MISMATCH', 'CONSUMER_SNAPSHOT_EVIDENCE_MISSING', 'REPRESENTATIVE_DIFFERENT_EVIDENCE', 'CONSUMER_COLOR_MISMATCH']));
  });
  it('identifies an existing link-bound cache without approving its unverified contents', () => {
    const folder = 'https://drive.example/folder';
    const r = compareVehicleMediaConsumerEvidence({ productId: 'fixture-product', product: { car_number: product.car_number, ext_color: product.ext_color, photo_link: folder, photo_cache: { src: folder, urls: product.image_urls } }, consumerProductId: 'fixture-product', consumer: product, consumerSnapshotRef: 'fixture:detail/1', observedAt: base.now, requiresGallery: true });
    expect(r.outputEvidence).toBe('EXISTING_LINK_BOUND_CACHE');
    expect(r.verdict).toBe('HOLD');
    expect(r.issues).toContain('REPRESENTATIVE_DIFFERENT_EVIDENCE');
  });
  it('limits successful HEAD and source matching to the evidence actually checked', async () => {
    const r = await inspectVehicleMediaEvidence(base);
    expect(r.verdict).toBe('HEAD_AND_SOURCE_FIELDS_MATCHED');
    expect(r.visualVehicleIdentity).toBe('NOT_CHECKED');
    expect(r.consumerReadback).toBe('NOT_CHECKED');
    expect(JSON.stringify(r)).not.toContain('supplier.example');
  });
  it('does not count reachable HTML or expired access as images', async () => {
    for (const head of [{ status: 403, contentType: 'image/jpeg' }, { status: 200, contentType: 'text/html' }, { status: 302, contentType: 'image/jpeg' }, { status: NaN, contentType: 'image/jpeg' }]) {
      expect((await inspectVehicleMediaEvidence({ ...base, probe: async () => head })).verdict).toBe('HOLD');
    }
  });
  it('holds an invalid observation time or absent product identity', async () => {
    const r = await inspectVehicleMediaEvidence({ ...base, productId: '', now: 'invalid' });
    expect(r.issues).toEqual(expect.arrayContaining(['OBSERVATION_TIME_INVALID', 'PRODUCT_ID_MISSING']));
  });
  it('excludes document URLs found only in original source evidence', async () => {
    const r = await inspectVehicleMediaEvidence({ ...base, source: { ...source, vehicle: { ...product, doc_images: product.image_urls } } });
    expect(r.checks[0]?.state).toBe('DOCUMENT_IMAGE_EXCLUDED');
  });
  it('excludes a document URL accidentally duplicated into vehicle fields without probing it', async () => {
    let called = false;
    const r = await inspectVehicleMediaEvidence({ ...base, product: { ...product, doc_images: product.image_urls }, probe: async () => { called = true; return { status: 200, contentType: 'image/jpeg' }; } });
    expect(called).toBe(false);
    expect(r.issues).toContain('DOCUMENT_IMAGE_IN_VEHICLE_PHOTOS');
  });
  it('holds missing, future and stale source evidence despite working photos', async () => {
    const { source: omitted, ...withoutSource } = base;
    expect((await inspectVehicleMediaEvidence(withoutSource)).issues).toContain('SOURCE_EVIDENCE_MISSING');
    for (const observedAt of ['invalid', '2026-10-10T00:00:00Z', '2026-10-08T00:00:00Z']) {
      expect((await inspectVehicleMediaEvidence({ ...base, source: { ...source, observedAt } })).issues).toContain('SOURCE_FRESHNESS_UNVERIFIED');
    }
  });
  it('holds cross-vehicle source, reordered gallery and changed color', async () => {
    const r = await inspectVehicleMediaEvidence({ ...base, source: { ...source, plate: '99나9999', vehicle: { ...product, image_urls: ['https://supplier.example/other.jpg'], ext_color: '검정' } } });
    expect(r.issues).toEqual(expect.arrayContaining(['SOURCE_VEHICLE_IDENTITY_MISMATCH', 'PHOTO_SOURCE_ARRAY_MISMATCH', 'COLOR_SOURCE_MISMATCH']));
  });
  it('preserves link-only and unknown color without inventing photos or zero', async () => {
    const r = await inspectVehicleMediaEvidence({ ...base, product: { car_number: product.car_number, photo_link: 'https://drive.example/folder' } });
    expect(r.photoState).toBe('LINK_ONLY');
    expect(r.colorState).toBe('NOT_PROVIDED');
    expect(r.checks).toEqual([]);
  });
  it('redacts failed request details and continues through additional photos', async () => {
    let count = 0;
    const r = await inspectVehicleMediaEvidence({ ...base, product: { ...product, image_urls: [...product.image_urls, 'https://supplier.example/second.jpg'] }, probe: async () => { if (++count === 1) throw new Error('secret URL'); return { status: 200, contentType: 'image/jpeg' }; } });
    expect(r.checks).toHaveLength(2);
    expect(r.checks[1]?.state).toBe('HEAD_IMAGE_AVAILABLE');
    expect(JSON.stringify(r)).not.toContain('secret');
  });
});

function publicationFixture() {
  const snapshot = {
    version: 1 as const, snapshotId: 'fixture-release', capturedAt: base.now,
    products: [{ _key: 'fixture-product', ...product, listable: false, vehicle_status: '출고불가', status_kind: '불가' }],
    policies: [], partners: [],
    inventory: { registered: 1, unavailable: 1, open: 0, listableDrift: 0, statusKindDrift: 0,
      sourceIdentityViolations: 0, deletedMarkerViolations: 0, blankPlateViolations: 0,
      invalidPlateViolations: 0, duplicatePlateViolations: 0, depositRuleViolations: 0, byStatus: { 출고불가: 1 } },
  };
  const dataDigest = hashSheetPublicationData(snapshot);
  const unsigned: Omit<SheetPublicationHandoff, 'handoffHash'> = {
    contractVersion: 'freepass-sheet-handoff-v1', consumerId: 'google-sheets-f01', workbook: 'F01',
    generatedAt: base.now, releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
    approvedRelease: { projectionId: 'sheet-publication-bridge', releaseId: snapshot.snapshotId, manifestId: 'fixture-manifest', inputDigest: 'fixture-source', dataDigest, observedAt: source.observedAt },
    manifest: { contractVersion: 'freepass-sheet-manifest-v1', manifestId: 'fixture-manifest', releaseId: snapshot.snapshotId,
      projectionId: 'sheet-publication-bridge', releaseAuthority: 'LEGACY_VERIFIED_BRIDGE', sourceCaptureDigest: 'fixture-source', sourceReadTime: source.observedAt,
      productCount: 1, policyCount: 0, partnerCount: 0, dataDigest, generatedAt: base.now }, snapshot,
  };
  const handoff = { ...unsigned, handoffHash: hashSheetPublicationHandoff(unsigned) };
  return { handoff, readback: { snapshotId: snapshot.snapshotId, dataDigest, observedAt: base.now, complete: true,
    rows: [{ rowNumber: 6, productId: 'fixture-product', plate: product.car_number }] }, now: base.now, maxAgeSeconds: 3600 };
}

describe('F01 unavailable row publisher review', () => {
  it('plans next-publication exclusion without source deletion or direct sheet mutation', () => {
    const r = planF01UnavailableMediaRows(publicationFixture());
    expect(r.verdict).toBe('PLAN_ONLY');
    expect(r.exclusions).toHaveLength(1);
    expect(r.exclusions[0]?.action).toBe('EXCLUDE_FROM_NEXT_PUBLICATION');
    expect(r.sourceMutation).toBe('NONE');
    expect(r.directSheetMutation).toBe('NONE');
  });
  it('holds absent or mismatched snapshot proof and partial or stale readback', () => {
    const input = publicationFixture();
    const { handoff: omitted, ...withoutHandoff } = input;
    const cases = [withoutHandoff, { ...input, readback: { ...input.readback, dataDigest: null } },
      { ...input, readback: { ...input.readback, snapshotId: 'other' } },
      { ...input, readback: { ...input.readback, complete: false } },
      { ...input, now: '2026-10-10T00:01:00Z' }];
    for (const value of cases) {
      expect(planF01UnavailableMediaRows(value).verdict).toBe('HOLD');
      expect(planF01UnavailableMediaRows(value).exclusions).toEqual([]);
    }
  });
  it('holds ambiguous row identity, wrong vehicle and a status/listable conflict', () => {
    const input = publicationFixture();
    const conflict = publicationFixture();
    conflict.handoff.snapshot.products[0]!.listable = true;
    const dataDigest = hashSheetPublicationData(conflict.handoff.snapshot);
    conflict.handoff.approvedRelease.dataDigest = dataDigest;
    conflict.handoff.manifest.dataDigest = dataDigest;
    conflict.readback.dataDigest = dataDigest;
    const { handoffHash: ignored, ...unsigned } = conflict.handoff;
    conflict.handoff.handoffHash = hashSheetPublicationHandoff(unsigned);
    for (const value of [
      { ...input, readback: { ...input.readback, rows: [...input.readback.rows, ...input.readback.rows] } },
      { ...input, readback: { ...input.readback, rows: [{ ...input.readback.rows[0]!, plate: '99나9999' }] } }, conflict,
    ]) {
      expect(planF01UnavailableMediaRows(value).verdict).toBe('HOLD');
      expect(planF01UnavailableMediaRows(value).exclusions).toEqual([]);
    }
    expect(planF01UnavailableMediaRows(conflict).issues).toContain('PUBLICATION_STATUS_UNVERIFIED');
  });
  it('fails closed for malformed handoff evidence rather than throwing or suggesting exclusions', () => {
    const r = planF01UnavailableMediaRows({ ...publicationFixture(), handoff: {} as SheetPublicationHandoff });
    expect(r.verdict).toBe('HOLD');
    expect(r.exclusions).toEqual([]);
  });
});
