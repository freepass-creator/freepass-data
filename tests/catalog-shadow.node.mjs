import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCatalogs,
  extractCatalogPayload
} from '../scripts/catalog-shadow-lib.mjs';

const row = (id, amount = 1000) => ({
  productId: id,
  displayName: id,
  offers: [{
    offerId: `offer-${id}`,
    supplierId: 'supplier',
    priceTerms: [{
      termKey: '36@20000',
      monthlyRent: { amount, currency: 'KRW' }
    }]
  }]
});

test('exact catalogs pass content and order parity', () => {
  const result = compareCatalogs(
    { data: [row('a'), row('b')] },
    { data: [row('a'), row('b')] }
  );
  assert.equal(result.contentMatches, true);
  assert.equal(result.orderMatches, true);
  assert.equal(result.counts.mismatched, 0);
});

test('row and nested offer order do not create content mismatch', () => {
  const left = {
    data: [{
      productId: 'a',
      displayName: 'a',
      offers: [
        {
          offerId: 'offer-2',
          supplierId: 's',
          priceTerms: [
            { termKey: '48@20000', monthlyRent: { amount: 2, currency: 'KRW' } },
            { termKey: '36@20000', monthlyRent: { amount: 1, currency: 'KRW' } }
          ]
        },
        {
          offerId: 'offer-1',
          supplierId: 's',
          priceTerms: [{ termKey: '36@20000', monthlyRent: { amount: 1, currency: 'KRW' } }]
        }
      ]
    }, row('b')]
  };
  const right = {
    data: [row('b'), {
      productId: 'a',
      displayName: 'a',
      offers: [
        {
          offerId: 'offer-1',
          supplierId: 's',
          priceTerms: [{ termKey: '36@20000', monthlyRent: { amount: 1, currency: 'KRW' } }]
        },
        {
          offerId: 'offer-2',
          supplierId: 's',
          priceTerms: [
            { termKey: '36@20000', monthlyRent: { amount: 1, currency: 'KRW' } },
            { termKey: '48@20000', monthlyRent: { amount: 2, currency: 'KRW' } }
          ]
        }
      ]
    }]
  };
  const result = compareCatalogs(left, right);
  assert.equal(result.contentMatches, true);
  assert.equal(result.orderMatches, false);
});

test('content changes are reported by product ID without exposing values', () => {
  const result = compareCatalogs(
    { data: [row('a', 1000), row('b', 1000)] },
    { data: [row('a', 2000), row('c', 1000)] }
  );
  assert.equal(result.contentMatches, false);
  assert.deepEqual(result.ids.mismatched, ['a']);
  assert.deepEqual(result.ids.missingOnRight, ['b']);
  assert.deepEqual(result.ids.missingOnLeft, ['c']);
});

test('duplicate product IDs fail closed', () => {
  assert.throws(
    () => extractCatalogPayload({ data: [row('a'), row('a')] }),
    /Duplicate productId/
  );
});
