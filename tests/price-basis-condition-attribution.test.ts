import { describe, expect, it } from 'vitest';
import type { Offer, Policy } from '../src/domain/catalog.js';
import { resolveOfferCommercialTerms } from '../src/application/resolve-offer-commercial-terms.js';
import { attributePriceBasisConditions } from '../src/application/attribute-price-basis-conditions.js';

const meta = {
  schemaVersion: '1', revision: 1, validationStatus: 'VALID' as const,
  createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
  createdBy: { id: 'service:test', kind: 'SERVICE' as const },
  updatedBy: { id: 'service:test', kind: 'SERVICE' as const },
  lineageId: 'lin_test',
};

function policy(facts: Record<string, unknown>): Policy {
  return {
    ...meta,
    id: 'policy_1',
    kind: 'OTHER',
    version: '1',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    facts,
  };
}

function offer(termKey = 'source:24_2만'): Offer {
  return {
    ...meta,
    id: 'offer_1',
    productId: 'product_1',
    supplierId: 'RP001',
    status: 'ACTIVE',
    policyId: 'policy_1',
    priceTerms: [{
      termKey,
      termMonths: 24,
      monthlyRent: { amount: 700000, currency: 'KRW' },
      deposit: { amount: 3000000, currency: 'KRW' },
      depositState: 'KNOWN',
      ...(termKey.includes('_2만') ? { mileageLimitKmPerYear: 20000 } : {}),
    }],
  };
}

describe('price basis source condition attribution', () => {
  it('marks source-key conditions and linked-policy conditions separately', () => {
    const p = policy({
      annual_mileage: '연 20,000km',
      basic_driver_age: '만 26세 이상',
      personal_driver_scope: '본인+직계가족',
      business_driver_scope: '임직원',
      license_period: '1년 이상',
      insurance_included: '보험료 포함',
      property_compensation_limit: '1억원',
      maintenance_service: '미제공',
    });
    const o = offer();
    const resolved = resolveOfferCommercialTerms(o, p).terms[0]!;
    const out = attributePriceBasisConditions({
      sourceTerm: o.priceTerms[0]!,
      resolvedTerm: resolved,
      policy: p,
    });

    expect(out.conditions.find((x) => x.dimensionKey === 'term_months')).toMatchObject({
      status: 'KNOWN', value: 24, origin: 'SOURCE_PRICE_KEY', sourceRef: 'source:24_2만',
    });
    expect(out.conditions.find((x) => x.dimensionKey === 'annual_mileage_km')).toMatchObject({
      status: 'KNOWN', value: 20000, origin: 'SOURCE_PRICE_KEY',
    });
    expect(out.conditions.find((x) => x.dimensionKey === 'driver_age')).toMatchObject({
      status: 'KNOWN', value: '만 26세 이상', origin: 'LINKED_POLICY_FACT',
      sourceRef: 'policy_1:basic_driver_age',
    });
    expect(out.conditions.find((x) => x.dimensionKey === 'property_compensation_limit')).toMatchObject({
      status: 'KNOWN', value: '1억원', origin: 'LINKED_POLICY_FACT',
    });
    expect(out.conditions.find((x) => x.dimensionKey === 'personal_driver_scope')).toMatchObject({
      status: 'KNOWN', value: '본인+직계가족', origin: 'LINKED_POLICY_FACT',
    });
  });

  it('uses the linked policy as mileage evidence when the source key has no mileage', () => {
    const p = policy({ annual_mileage: 20000 });
    const o = offer('source:24');
    const resolved = resolveOfferCommercialTerms(o, p).terms[0]!;
    const out = attributePriceBasisConditions({
      sourceTerm: o.priceTerms[0]!,
      resolvedTerm: resolved,
      policy: p,
    });
    expect(out.conditions.find((x) => x.dimensionKey === 'annual_mileage_km')).toEqual({
      dimensionKey: 'annual_mileage_km',
      status: 'KNOWN',
      value: 20000,
      origin: 'LINKED_POLICY_FACT',
      sourceRef: 'policy_1:annual_mileage',
    });
  });

  it('surfaces every unproven condition as UNKNOWN instead of filling a default', () => {
    const p = policy({ annual_mileage: 20000, basic_driver_age: '만 26세 이상' });
    const o = offer('source:24');
    const resolved = resolveOfferCommercialTerms(o, p).terms[0]!;
    const out = attributePriceBasisConditions({
      sourceTerm: o.priceTerms[0]!,
      resolvedTerm: resolved,
      policy: p,
    });

    expect(out.status).toBe('PARTIAL');
    expect(out.unknownConditionKeys).toEqual(expect.arrayContaining([
      'additional_driver_count',
      'property_compensation_limit',
      'maintenance_service',
    ]));
    expect(out.conditions.find((x) => x.dimensionKey === 'additional_driver_count')).toEqual({
      dimensionKey: 'additional_driver_count',
      status: 'UNKNOWN',
      origin: 'UNRESOLVED',
    });
  });

  it('marks an unresolved deposit origin separately from a known monthly rent origin', () => {
    const p = policy({ annual_mileage: 20000 });
    const o = offer();
    o.priceTerms[0] = {
      ...o.priceTerms[0]!,
      deposit: null,
      depositState: 'UNKNOWN',
    };
    const resolved = resolveOfferCommercialTerms(o, p).terms[0]!;
    const out = attributePriceBasisConditions({
      sourceTerm: o.priceTerms[0]!,
      resolvedTerm: resolved,
      policy: p,
    });

    expect(out.monthlyRentOrigin).toEqual({
      origin: 'CANONICAL_PRICE_TERM',
      sourceRef: 'source:24_2만',
    });
    expect(out.depositOrigin).toEqual({ origin: 'UNRESOLVED' });
  });
});
