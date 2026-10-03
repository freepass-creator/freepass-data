import { describe, expect, it } from 'vitest';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { GeoPoint, Timestamp } from 'firebase-admin/firestore';
import { encodeIancarBackupValue, decodeIancarBackupValue, iancarAbsencePatch, iancarPhotoPatch } from '../src/infra/iancar-publication-withdrawal-firestore.js';
import {
  decodeFirestoreDocument,
  decodeFirestoreIdentityDocument
} from '../src/infra/firestore-document.js';

function snapshot(id: string, value: Record<string, unknown> | null) {
  return {
    id,
    exists: value !== null,
    data: () => value ?? undefined,
    ref: { parent: { id: 'catalog_products' } }
  } as unknown as DocumentSnapshot;
}

describe('Firestore document decoding', () => {
  it('absent source inventory is withdrawn once, never deleted or repeated over locks/history', () => {
    const old = { provider_company_code: 'RP031', listable: true, iancar_one_vehicle_id: 'V1', iancar_phase_one: { sourceDigest: 'old' } };
    const patch = iancarAbsencePatch(old, new Set(), 'new', 'now')!;
    expect(patch).toMatchObject({ listable: false, iancar_phase_one: null, publication_withdrawal: { deleteAuthorized: false } });
    expect(iancarAbsencePatch({ ...old, ...patch }, new Set(), 'next', 'later')).toBeNull();
    for (const extra of [{ locked_by_contract: true }, { _deleted: true }, { deletedAt: 'date' }, { provider_company_code: 'RP999' }])
      expect(iancarAbsencePatch({ ...old, ...extra }, new Set(), 'new', 'now')).toBeNull();
    expect(iancarAbsencePatch(old, new Set(['V1']), 'new', 'now')).toBeNull();
  });
  it('shared photo mapping preserves originals and restores only unbacked own proxy slots', () => {
    const row = { productId: 'P', vehicleId: 'V', plate: '123가4567', count: 2, observedAt: 'now' };
    const original = { image_urls: ['https://original.example/photo.jpg'], image_url: 'https://original.example/photo.jpg' };
    const patch = iancarPhotoPatch(original, row);
    expect(patch).toMatchObject({ image_kind: 'VEHICLE_PHOTO', iancar_one_photo_count: 2,
      iancar_photo_source_original: { image_urls: original.image_urls } });
    expect(iancarPhotoPatch({ ...original, ...patch }, { ...row, count: 0 }).image_urls).toEqual(original.image_urls);
    expect(iancarPhotoPatch(original, { ...row, count: 0 })).not.toHaveProperty('image_urls');
    const operatorPhoto = { ...original, ...patch, image_urls: ['https://operator.example/new.jpg'], image_url: 'https://operator.example/new.jpg' };
    const refreshed = iancarPhotoPatch(operatorPhoto, row);
    expect(refreshed.iancar_photo_source_original).toMatchObject({ image_url: 'https://operator.example/new.jpg' });
    expect(iancarPhotoPatch({ ...operatorPhoto, ...refreshed }, { ...row, count: 0 }).image_url).toBe('https://operator.example/new.jpg');
  });
  it('round-trips operational backups without replacing Timestamp, GeoPoint or bytes with maps', () => {
    const original = { at: new Timestamp(100, 123), point: new GeoPoint(37.5, 127), nested: [Buffer.from('evidence'), { type: 'timestamp', seconds: 9 }], empty: null };
    const restored = decodeIancarBackupValue(JSON.parse(JSON.stringify(encodeIancarBackupValue(original))), () => { throw new Error('unexpected reference'); });
    expect(restored.at).toBeInstanceOf(Timestamp);
    expect(restored.at.isEqual(original.at)).toBe(true);
    expect(restored.point).toBeInstanceOf(GeoPoint);
    expect(restored.point.isEqual(original.point)).toBe(true);
    expect(Buffer.isBuffer(restored.nested[0])).toBe(true);
    expect(restored).toEqual(original);
  });
  it('fails closed before publication for unsupported backup prototypes', () => {
    expect(() => encodeIancarBackupValue({ value: new Date() })).toThrow('IANCAR_BACKUP_UNSUPPORTED_TYPE');
  });
  it('uses the document path as canonical entity identity', () => {
    expect(
      decodeFirestoreIdentityDocument<{ id: string; name: string }>(
        snapshot('prod_path', { name: 'GV70' }),
        'id'
      )
    ).toEqual({ id: 'prod_path', name: 'GV70' });
  });

  it('rejects a payload identity that disagrees with the document path', () => {
    expect(() =>
      decodeFirestoreIdentityDocument(
        snapshot('prod_path', { id: 'prod_payload' }),
        'id'
      )
    ).toThrow('Firestore document identity mismatch');
  });

  it('keeps non-identity documents raw instead of injecting a generic id', () => {
    expect(
      decodeFirestoreDocument<{ sourceId: string }>(
        snapshot('encoded-source', { sourceId: 'source/one' })
      )
    ).toEqual({ sourceId: 'source/one' });
  });
});
