import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { projectionReader } from '../src/infra/firestore-projection-reader.js';
import type { AdminCatalogProduct } from '../src/domain/catalog.js';

function fakeDb(documents: Record<string, Record<string, unknown>>) {
  const reads: string[] = [];
  // Deliberately has no write/transaction API. Accidental mutation fails the test.
  const db = { collection: (collection: string) => ({ doc: (id: string) => ({ get: async () => {
    const key = collection + '/' + id;
    reads.push(key);
    return { exists: Object.hasOwn(documents, key), data: () => documents[key], get: (field: string) => documents[key]?.[field] };
  } }) }) };
  return { db: db as unknown as Firestore, reads };
}

describe('Firestore projection read boundary', () => {
  it('reads only the requested active release and its manifest', async () => {
    const fixture = fakeDb({
      'projection_active/erp-public': { releaseId: 'rel_test' },
      'projection_releases/rel_test': { releaseId: 'rel_test', projectionId: 'erp-public' },
      'projection_release_manifests/rel_test': { releaseId: 'rel_test' },
    });
    const reader = projectionReader(fixture.db);
    expect(Object.keys(reader).sort()).toEqual(['getActive', 'getManifest']);
    expect((await reader.getActive('erp-public'))?.releaseId).toBe('rel_test');
    expect((await reader.getManifest('rel_test'))?.releaseId).toBe('rel_test');
    expect(fixture.reads).toEqual(['projection_active/erp-public', 'projection_releases/rel_test', 'projection_release_manifests/rel_test']);
  });
  it('preserves the Admin projection type through the read-only boundary', async () => {
    const fixture = fakeDb({
      'projection_active/admin-catalog': { releaseId: 'rel_admin_test' },
      'projection_releases/rel_admin_test': {
        releaseId: 'rel_admin_test',
        projectionId: 'admin-catalog',
        schemaVersion: '1.0.0',
        canonicalRevision: 1,
        manifestId: 'manifest_rel_admin_test',
        inputDigest: 'input',
        dataDigest: 'data',
        status: 'ACTIVE',
        generatedAt: '2026-09-25T00:00:00.000Z',
        activatedAt: '2026-09-25T00:01:00.000Z',
        data: [{
          productId: 'p1', productRevision: 1, updatedAt: '2026-09-25T00:00:00.000Z',
          displayName: '관리자 상품', commercialType: 'USED_RENT',
          vehicleModel: { id: 'vm1', maker: '현대', model: '그랜저' },
          offers: [],
        }],
      },
    });
    const reader = projectionReader(fixture.db);
    const release = await reader.getActive<AdminCatalogProduct>('admin-catalog');
    expect(release?.projectionId).toBe('admin-catalog');
    expect(release?.data[0]?.vehicleModel.model).toBe('그랜저');
    expect(fixture.reads).toEqual([
      'projection_active/admin-catalog',
      'projection_releases/rel_admin_test',
    ]);
  });

  it('does not create a release when no pointer exists', async () => {
    const fixture = fakeDb({});
    expect(await projectionReader(fixture.db).getActive('erp-public')).toBeNull();
    expect(fixture.reads).toEqual(['projection_active/erp-public']);
  });
  it('rejects path injection and a pointer that misidentifies its release', async () => {
    const badPath = fakeDb({ 'projection_active/erp-public': { releaseId: '../private/path' } });
    await expect(projectionReader(badPath.db).getActive('erp-public')).rejects.toThrow('Invalid release pointer');
    expect(badPath.reads).toHaveLength(1);
    const mismatch = fakeDb({
      'projection_active/erp-public': { releaseId: 'rel_expected' },
      'projection_releases/rel_expected': { releaseId: 'rel_other' },
    });
    await expect(projectionReader(mismatch.db).getActive('erp-public')).rejects.toThrow('identity mismatch');
  });
});
