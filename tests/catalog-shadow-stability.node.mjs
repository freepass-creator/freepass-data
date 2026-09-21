import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCatalogs
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

test('semantic digest is stable across product and nested offer ordering', () => {
  const a = {
    data: [
      {
        productId: 'a',
        displayName: 'a',
        offers: [
          { offerId: 'z', supplierId: 's', priceTerms: [
            { termKey: '48@20000', monthlyRent: { amount: 2, currency: 'KRW' } },
            { termKey: '36@20000', monthlyRent: { amount: 1, currency: 'KRW' } }
          ] },
          { offerId: 'a', supplierId: 's', priceTerms: [
            { termKey: '36@20000', monthlyRent: { amount: 1, currency: 'KRW' } }
          ] }
        ]
      },
      row('b')
    ]
  };
  const b = {
    data: [
      row('b'),
      {
        productId: 'a',
        displayName: 'a',
        offers: [
          { offerId: 'a', supplierId: 's', priceTerms: [
            { termKey: '36@20000', monthlyRent: { amount: 1, currency: 'KRW' } }
          ] },
          { offerId: 'z', supplierId: 's', priceTerms: [
            { termKey: '36@20000', monthlyRent: { amount: 1, currency: 'KRW' } },
            { termKey: '48@20000', monthlyRent: { amount: 2, currency: 'KRW' } }
          ] }
        ]
      }
    ]
  };

  const result = compareCatalogs(a, b);
  assert.equal(result.contentMatches, true);
  assert.equal(result.orderMatches, false);
  assert.equal(
    result.digests.leftSemantic,
    result.digests.rightSemantic
  );
});
