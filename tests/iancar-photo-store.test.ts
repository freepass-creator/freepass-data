import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createVehiclePhotoReader, type VehiclePhotoRead, type VehiclePhotoSource } from '../src/domain/consumer-output-contract.js';
import {
  IANCAR_PHOTO_STORE_MAX_AGE_MS,
  iancarManifestLayout,
  parseIancarPhotoManifest,
  parseIancarPhotoPointer,
  sha256Hex,
} from '../src/domain/iancar-photo-store.js';
import { createPhotoRequestLimiter } from '../src/application/photo-request-limiter.js';
import { replicateIancarVehicle, type IancarAlbumPhoto, type ReplicateIancarPhotosDeps } from '../src/application/replicate-iancar-photos.js';
import { createStoredIancarPhotoReader } from '../src/application/stored-iancar-photo-reader.js';
import { MemoryPhotoObjectStore } from '../src/infra/photo-object-store-memory.js';

const jpeg = (label: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(label), Buffer.from([0xff, 0xd9])]);
const NOW = Date.parse('2026-10-12T05:00:00.000Z');

const product = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'EANCAR-x', car_number: '12가3456',
  iancar_one_photo_ids: ['r1', 'r2', 'r3'], ...over,
});

function setup(albumLabels = ['rep', 'two', 'three'], opts: { allowPublish?: boolean } = {}) {
  const store = new MemoryPhotoObjectStore();
  let current = product();
  const originals = new Map(albumLabels.map((label, i) => [`photo-${i}`, jpeg(`orig-${label}`)]));
  const album: IancarAlbumPhoto[] = albumLabels.map((_, i) => ({ photoId: `photo-${i}`, sourceOrdinal: i, representative: i === 0 }));
  const getPhotoBytes = vi.fn(async (_vehicleId: string, photoId: string) => ({ bytes: originals.get(photoId)!, contentType: 'image/jpeg' }));
  const deps: ReplicateIancarPhotosDeps = {
    getAlbum: async () => album,
    getPhotoBytes,
    renditioner: async original => ({ list: jpeg(`list-${sha256Hex(original).slice(0, 8)}`), detail: jpeg(`detail-${sha256Hex(original).slice(0, 8)}`) }),
    store,
    now: () => new Date(NOW),
    publish: async (_id, pointer, previous) => {
      if (opts.allowPublish === false) return 'PRECONDITION_FAILED';
      const prev = (current.iancar_photo_store as { manifestSha256?: string } | undefined)?.manifestSha256 ?? null;
      if (prev !== previous) return 'PRECONDITION_FAILED';
      current = { ...current, iancar_photo_store: pointer };
      return 'PUBLISHED';
    },
  };
  return { store, deps, getPhotoBytes, originals, getCurrent: () => current, setCurrent: (value: Record<string, unknown>) => { current = value; } };
}

describe('replicateIancarVehicle', () => {
  it('dry-run reads and renders but writes no objects and publishes nothing', async () => {
    const { store, deps } = setup();
    const result = await replicateIancarVehicle('p1', product(), deps, false);
    expect(result).toMatchObject({ status: 'DRY_RUN_OK', photos: 3, uploadedObjects: 0 });
    expect(result.listBytes).toBeGreaterThan(0);
    expect(store.objects.size).toBe(0);
  });

  it('apply uploads content-addressed objects + immutable manifest, publishes a pointer, and a second run uploads nothing new', async () => {
    const { store, deps, getCurrent, setCurrent } = setup();
    const first = await replicateIancarVehicle('p1', getCurrent(), deps, true);
    expect(first).toMatchObject({ status: 'PUBLISHED', photos: 3, uploadedObjects: 7, existingObjects: 0 });
    expect(store.objects.size).toBe(7);
    const pointer = parseIancarPhotoPointer(getCurrent().iancar_photo_store);
    expect(pointer).not.toBeNull();
    setCurrent(getCurrent());
    const second = await replicateIancarVehicle('p1', getCurrent(), deps, true);
    expect(second.uploadedObjects).toBe(0);
    expect(second.existingObjects).toBe(7);
    expect(store.objects.size).toBe(7);
  });

  it('a changed photo gets new objects and a new manifest; unchanged photos are reused', async () => {
    const { store, deps, getCurrent, originals } = setup();
    await replicateIancarVehicle('p1', getCurrent(), deps, true);
    originals.set('photo-1', jpeg('orig-two-CHANGED'));
    const result = await replicateIancarVehicle('p1', getCurrent(), deps, true);
    expect(result.status).toBe('PUBLISHED');
    expect(result.uploadedObjects).toBe(3); // list + detail of the changed photo + new manifest
    expect(store.objects.size).toBe(10);
  });

  it('keeps the previous pointer when the conditional publish fails and skips ineligible products', async () => {
    const { deps, getCurrent } = setup(undefined, { allowPublish: false });
    expect(await replicateIancarVehicle('p1', getCurrent(), deps, true)).toMatchObject({ status: 'PRECONDITION_FAILED' });
    expect(getCurrent().iancar_photo_store).toBeUndefined();
    expect(await replicateIancarVehicle('p2', product({ publication_withdrawal: { at: 'x' } }), deps, true)).toMatchObject({ status: 'SKIPPED_NOT_ELIGIBLE' });
    expect(await replicateIancarVehicle('p3', product({ listable: false }), deps, true)).toMatchObject({ status: 'SKIPPED_NOT_ELIGIBLE' });
  });

  it('rejects a non-JPEG rendition without writing a pointer', async () => {
    const { deps, getCurrent } = setup();
    const bad = { ...deps, renditioner: async () => ({ list: Buffer.from('nope'), detail: Buffer.from('nope') }) };
    expect(await replicateIancarVehicle('p1', getCurrent(), bad, true)).toMatchObject({ status: 'FAILED', reason: 'RENDITION_INVALID' });
    expect(getCurrent().iancar_photo_store).toBeUndefined();
  });
});

async function published(over: Record<string, unknown> = {}) {
  const ctx = setup();
  await replicateIancarVehicle('p1', ctx.getCurrent(), ctx.deps, true);
  const doc = { ...ctx.getCurrent(), ...over };
  return { ...ctx, doc };
}

describe('stored photo reader', () => {
  it('serves verified stored bytes with a gate-compatible layout and no upstream calls', async () => {
    const { store, doc } = await published();
    const read = createStoredIancarPhotoReader({ store, now: () => NOW });
    const meta = await read(doc);
    expect(meta).toMatchObject({ count: 3, bytes: null, contentType: 'application/json' });
    expect(new Set(meta!.photoIds).size).toBe(3);
    const image = await read(doc, 1);
    expect(image!.contentType).toBe('image/jpeg');
    expect(image!.bytes!.toString('latin1')).toContain('detail-');
  });

  it.each([
    ['no pointer', (d: Record<string, unknown>) => { delete d.iancar_photo_store; return d; }],
    ['count mismatch with registered ids', (d: Record<string, unknown>) => ({ ...d, iancar_one_photo_ids: ['a', 'b'] })],
    ['different vehicle', (d: Record<string, unknown>) => ({ ...d, iancar_one_vehicle_id: 'EANCAR-other' })],
    ['different plate', (d: Record<string, unknown>) => ({ ...d, car_number: '99허0000' })],
  ])('falls back (null) on %s', async (_name, mutate) => {
    const { store, doc } = await published();
    const read = createStoredIancarPhotoReader({ store, now: () => NOW });
    expect(await read(mutate({ ...doc }), 0)).toBeNull();
  });

  it('falls back when the stored copy is older than 24 hours', async () => {
    const { store, doc } = await published();
    const read = createStoredIancarPhotoReader({ store, now: () => NOW + IANCAR_PHOTO_STORE_MAX_AGE_MS + 1000 });
    expect(await read(doc, 0)).toBeNull();
  });

  it('falls back when a rendition object or the manifest is tampered or missing', async () => {
    const { store, doc } = await published();
    const names = [...store.objects.keys()];
    const detail = names.find(name => name.endsWith('-detail.jpg'))!;
    const manifest = names.find(name => name.includes('/manifests/'))!;
    const original = store.objects.get(detail)!;
    store.objects.set(detail, { ...original, bytes: jpeg('tampered') });
    const read = createStoredIancarPhotoReader({ store, now: () => NOW, manifestCacheTtlMs: 0 });
    expect(await read(doc, 0)).toBeNull();
    store.objects.set(detail, original);
    expect(await read(doc, 0)).not.toBeNull();
    store.objects.set(manifest, { bytes: Buffer.from('{}'), contentType: 'application/json' });
    expect(await read(doc)).toBeNull();
    store.objects.delete(manifest);
    expect(await read(doc)).toBeNull();
  });

  it('never trusts a pointer that names another vehicle\'s manifest path', () => {
    const forged = { version: 1, manifestObject: `iancar/${'a'.repeat(32)}/manifests/${'b'.repeat(64)}.json`, manifestSha256: 'c'.repeat(64), count: 1, observedAt: new Date(NOW).toISOString() };
    expect(parseIancarPhotoPointer(forged)).toBeNull();
    expect(parseIancarPhotoManifest({ version: 1, vehicleId: 'v', plateDigest: 'd'.repeat(64), observedAt: new Date(NOW).toISOString(), count: 1, items: [{}] })).toBeNull();
  });

  it('duplicate photos still get unique gate ids', async () => {
    const ctx = setup(['same', 'same', 'same']);
    await replicateIancarVehicle('p1', ctx.getCurrent(), ctx.deps, true);
    const read = createStoredIancarPhotoReader({ store: ctx.store, now: () => NOW });
    const meta = await read(ctx.getCurrent());
    expect(new Set(meta!.photoIds).size).toBe(3);
    expect(iancarManifestLayout(parseIancarPhotoManifest(JSON.parse([...ctx.store.objects].find(([name]) => name.includes('/manifests/'))![1].bytes.toString()))!).count).toBe(3);
  });
});

describe('integration with the serving gate', () => {
  async function serving(live?: () => Promise<VehiclePhotoRead>) {
    const ctx = await published();
    const stored = createStoredIancarPhotoReader({ store: ctx.store, now: () => NOW });
    let doc = ctx.doc;
    const liveRead = vi.fn(live ?? (async () => { throw new Error('LIVE_SHOULD_NOT_BE_CALLED'); }));
    const source: VehiclePhotoSource = {
      eligible: () => true,
      connection: p => JSON.stringify([p.provider_company_code, p.iancar_one_vehicle_id, p.car_number]),
      read: async (p, index) => (await stored(p, index)) ?? liveRead(),
    };
    const read = createVehiclePhotoReader(async () => doc, source, undefined, () => NOW, undefined, new Set(['RP031']));
    return { read, liveRead, setDoc: (value: Record<string, unknown>) => { doc = value; }, doc: ctx.doc };
  }

  it('serves a stored image through the gate without calling the live source', async () => {
    const { read, liveRead } = await serving();
    const image = await read('erp5-public-media', 'p1', 0);
    expect(image.contentType).toBe('image/jpeg');
    expect(liveRead).not.toHaveBeenCalled();
    expect((await read('erp5-public-media', 'p1')).bytes).toBeNull();
  });

  it('still blocks withdrawn, unlisted and deleted products even when a stored copy exists', async () => {
    const { read, setDoc, doc } = await serving();
    for (const patch of [{ publication_withdrawal: { at: 'x' } }, { listable: false }, { _deleted: true }, { status_kind: '불가' }]) {
      setDoc({ ...doc, ...patch });
      await expect(read('erp5-public-media', 'p1', 0)).rejects.toThrow();
    }
  });

  it('uses the live source when the stored copy cannot be used', async () => {
    const live = vi.fn(async (): Promise<VehiclePhotoRead> => {
      const ids = ['r1', 'r2', 'r3'];
      return { count: 3, photoIds: ids, upstreamPhotoIds: [...ids], upstreamRepresentatives: ids.map((_, i) => i === 0), servingSourceOrdinals: [0, 1, 2], bytes: jpeg('live'), contentType: 'image/jpeg' };
    });
    const { read, setDoc, doc } = await serving(live);
    setDoc({ ...doc, iancar_photo_store: undefined });
    const image = await read('erp5-public-media', 'p1', 0).catch(() => null);
    expect(live).toHaveBeenCalled();
    expect(image === null || image.contentType === 'image/jpeg').toBe(true);
  });
});

describe('photo request limiter', () => {
  it('backs off on 429 with Retry-After and gives up after the retry cap', async () => {
    const sleeps: number[] = [];
    let t = 0;
    const limiter = createPhotoRequestLimiter({ maxConcurrent: 1, minIntervalMs: 0, maxRetries: 2, sleep: async ms => { sleeps.push(ms); t += ms; }, random: () => 0, now: () => t });
    let calls = 0;
    const value = await limiter.run(async () => { calls += 1; if (calls < 3) throw Object.assign(new Error('x'), { status: 429, retryAfterSeconds: 2 }); return 'ok'; });
    expect(value).toBe('ok');
    expect(sleeps.filter(ms => ms >= 2000)).toHaveLength(2);
    await expect(limiter.run(async () => { throw Object.assign(new Error('rate'), { status: 429, retryAfterSeconds: 1 }); })).rejects.toThrow('rate');
  });

  it('does not retry other errors and limits concurrency', async () => {
    const limiter = createPhotoRequestLimiter({ maxConcurrent: 2, minIntervalMs: 0, sleep: async () => undefined });
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
    })));
    expect(peak).toBeLessThanOrEqual(2);
    let calls = 0;
    await expect(limiter.run(async () => { calls += 1; throw Object.assign(new Error('boom'), { status: 500 }); })).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});

it('content hash is what decides sameness (ids differ per call)', () => {
  expect(createHash('sha256').update(jpeg('a')).digest('hex')).toBe(sha256Hex(jpeg('a')));
});
