import { describe, expect, it } from 'vitest';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { GeoPoint, Timestamp } from 'firebase-admin/firestore';
import { encodeIancarBackupValue, decodeIancarBackupValue, iancarAbsencePatch } from '../src/infra/iancar-publication-withdrawal-firestore.js';
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
  it('holds source-absent Iancar publication without deleting history or guessing sale', () => {
    const original = { provider_company_code: 'RP031', iancar_one_vehicle_id: 'gone', listable: true,
      iancar_phase_one: { sourceDigest: 'old' }, price: { '24': { rent: 500000 } } };
    const patch = iancarAbsencePatch(original, new Set(['present']), 'new', '2026-10-02T00:00:00Z')!;
    expect(patch.listable).toBe(false);
    expect(patch.publication_withdrawal.deleteAuthorized).toBe(false);
    expect(patch.status_reason).toContain('미관측');
    expect(patch.iancar_phase_one_source_original).toEqual(original.iancar_phase_one);
    expect(patch).not.toHaveProperty('price');
    expect(patch).not.toHaveProperty('_deleted');
    expect(original.listable).toBe(true);
    expect(iancarAbsencePatch(original, new Set(['gone']), 'new', 'now')).toBeNull();
    expect(iancarAbsencePatch({ ...original, provider_company_code: 'RP021' }, new Set(), 'new', 'now')).toBeNull();
    expect(iancarAbsencePatch({ provider_company_code: 'RP031', listable: false }, new Set(), 'new', 'now')).toBeNull();
    expect(() => iancarAbsencePatch({ ...original, locked_by_contract: true }, new Set(), 'new', 'now')).toThrow('IANCAR_ABSENCE_CONTRACT_OR_DELETION_LOCK');
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
