import { describe, it, expect } from 'vitest';
import { inspectVehicleMediaEvidence, compareVehicleMediaConsumerEvidence } from '../src/application/vehicle-media-evidence.js';

const product = { car_number: '12가3456', image_urls: ['https://supplier.example/car.jpg'], ext_color: '흰색' };
const source = { plate: '12가3456', sourceRef: 'fixture:detail/1', observedAt: '2026-10-09T00:00:00Z', expectedFreshnessSeconds: 3600, vehicle: product };
const base = { productId: 'fixture-product', product, source, now: '2026-10-09T00:01:00Z', probe: async () => ({ status: 200, contentType: 'image/jpeg' }) };
describe('read-only media evidence', () => {
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
