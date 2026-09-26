import assert from 'node:assert/strict';
import { test } from 'vitest';
import { vehicleMasterFirestoreDocumentId } from '../src/infra/vehicle-master-firestore-store.js';

test('Firestore document ID encoding is injective for slash-like source IDs', () => {
  const slash = vehicleMasterFirestoreDocumentId('source/a');
  const doubleUnderscore = vehicleMasterFirestoreDocumentId('source__a');

  assert.equal(slash, 'source%2Fa');
  assert.equal(doubleUnderscore, 'source__a');
  assert.notEqual(slash, doubleUnderscore);
});

test('Firestore document ID encoding preserves canonical deterministic IDs', () => {
  assert.equal(
    vehicleMasterFirestoreDocumentId('make_0123456789abcdef01234567'),
    'make_0123456789abcdef01234567'
  );
  assert.equal(
    vehicleMasterFirestoreDocumentId('candidate_0123456789abcdef01234567'),
    'candidate_0123456789abcdef01234567'
  );
});

test('Firestore document ID encoding does not alias literal percent escapes', () => {
  assert.notEqual(
    vehicleMasterFirestoreDocumentId('source/a'),
    vehicleMasterFirestoreDocumentId('source%2Fa')
  );
  assert.equal(vehicleMasterFirestoreDocumentId('source%2Fa'), 'source%252Fa');
});
