import { describe, expect, it } from 'vitest';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
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
