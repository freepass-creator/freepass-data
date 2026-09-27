import { describe, expect, it } from 'vitest';
import type { Policy } from '../src/domain/catalog.js';
import type { PriceBasisAttribution } from '../src/domain/commercial-product-view.js';
import {
  enrichUnknownConditionsFromUniquePolicyMatch,
  matchPriceBasisToPolicyCandidates,
} from '../src/application/match-price-basis-policy.js';

const meta = {
  schemaVersion: '1', revision: 1, validationStatus: 'VALID' as const,
  createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
  createdBy: { id: 'service:test', kind: 'SERVICE' as const },
  updatedBy: { id: 'service:test', kind: 'SERVICE' as const },
  lineageId: 'lin_test',
};

function policy(id: string, facts: Record<string, unknown>): Policy {
  return {
    ...meta,
    id,
    kind: 'OTHER',
    version: '1',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    facts,
  };
}

const attribution: PriceBasisAttribution = {
  status: 'PARTIAL',
  conditions: [
    {
      dimensionKey: 'annual_mileage_km',
      status: 'KNOWN',
      value: 20000,
      origin: 'SOURCE_PRICE_KEY',
      sourceRef: 'source:24_2만',
    },
    {
      dimensionKey: 'driver_age',
      status: 'UNKNOWN',
      origin: 'UNRESOLVED',
    },
    {
      dimensionKey: 'property_compensation_limit',
      status: 'UNKNOWN',
      origin: 'UNRESOLVED',
    },
  ],
  unknownConditionKeys: ['driver_age', 'property_compensation_limit'],
  monthlyRentOrigin: {
    origin: 'CANONICAL_PRICE_TERM',
    sourceRef: 'source:24_2만',
  },
  depositOrigin: {
    origin: 'CANONICAL_PRICE_TERM',
    sourceRef: 'source:24_2만',
  },
};

describe('reverse price-basis policy matching', () => {
  it('uniquely matches within the same supplier and can fill unknown insurance facts', () => {
    const p1 = policy('POL-A', {
      annual_mileage: '연 20,000km',
      basic_driver_age: '만 26세 이상',
      property_compensation_limit: '1억원',
    });
    const p2 = policy('POL-B', {
      annual_mileage: '연 30,000km',
      basic_driver_age: '만 26세 이상',
      property_compensation_limit: '2억원',
    });

    const match = matchPriceBasisToPolicyCandidates({
      supplierId: 'RP001',
      attribution,
      candidates: [
        { supplierId: 'RP001', policy: p1 },
        { supplierId: 'RP001', policy: p2 },
      ],
    });

    expect(match).toMatchObject({
      status: 'UNIQUE_MATCH',
      matchedPolicyId: 'POL-A',
      candidatePolicyIds: ['POL-A'],
      matchedDimensionKeys: ['annual_mileage_km'],
    });

    const enriched = enrichUnknownConditionsFromUniquePolicyMatch({
      attribution,
      match,
      policy: p1,
    });

    expect(enriched.conditions.find((x) => x.dimensionKey === 'driver_age')).toEqual({
      dimensionKey: 'driver_age',
      status: 'KNOWN',
      value: '만 26세 이상',
      origin: 'MATCHED_POLICY_FACT',
      sourceRef: 'POL-A:basic_driver_age',
    });
    expect(enriched.conditions.find((x) => x.dimensionKey === 'property_compensation_limit')).toEqual({
      dimensionKey: 'property_compensation_limit',
      status: 'KNOWN',
      value: '1억원',
      origin: 'MATCHED_POLICY_FACT',
      sourceRef: 'POL-A:property_compensation_limit',
    });
  });

  it('never matches a policy from a different supplier', () => {
    const match = matchPriceBasisToPolicyCandidates({
      supplierId: 'RP001',
      attribution,
      candidates: [
        { supplierId: 'RP999', policy: policy('POL-X', { annual_mileage: '연 20,000km' }) },
      ],
    });
    expect(match.status).toBe('NO_MATCH');
  });

  it('keeps ambiguous supplier policies unresolved', () => {
    const match = matchPriceBasisToPolicyCandidates({
      supplierId: 'RP001',
      attribution,
      candidates: [
        { supplierId: 'RP001', policy: policy('POL-A', { annual_mileage: '연 20,000km' }) },
        { supplierId: 'RP001', policy: policy('POL-C', { annual_mileage: '연 20,000km' }) },
      ],
    });
    expect(match).toEqual({
      status: 'AMBIGUOUS',
      candidatePolicyIds: ['POL-A', 'POL-C'],
      matchedDimensionKeys: ['annual_mileage_km'],
      sourceRefs: ['source:24_2만'],
    });

    const enriched = enrichUnknownConditionsFromUniquePolicyMatch({
      attribution,
      match,
      policy: policy('POL-A', {
        annual_mileage: '연 20,000km',
        property_compensation_limit: '1억원',
      }),
    });
    expect(enriched.unknownConditionKeys).toContain('property_compensation_limit');
  });

  it('refuses reverse matching when there is no independent comparable evidence', () => {
    const noEvidence: PriceBasisAttribution = {
      ...structuredClone(attribution),
      conditions: attribution.conditions.map((condition) => {
        const { value: _value, sourceRef: _sourceRef, ...rest } = condition;
        return {
          ...rest,
          status: 'UNKNOWN' as const,
          origin: 'UNRESOLVED' as const,
        };
      }),
      unknownConditionKeys: ['annual_mileage_km', 'driver_age', 'property_compensation_limit'],
    };
    const match = matchPriceBasisToPolicyCandidates({
      supplierId: 'RP001',
      attribution: noEvidence,
      candidates: [{ supplierId: 'RP001', policy: policy('POL-A', { annual_mileage: '연 20,000km' }) }],
    });
    expect(match.status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('does not use facts already sourced from a policy as circular reverse-match evidence', () => {
    const circular: PriceBasisAttribution = {
      ...structuredClone(attribution),
      conditions: [
        {
          dimensionKey: 'annual_mileage_km',
          status: 'KNOWN',
          value: 20000,
          origin: 'LINKED_POLICY_FACT',
          sourceRef: 'POL-OLD:annual_mileage',
        },
      ],
      unknownConditionKeys: [],
    };
    const match = matchPriceBasisToPolicyCandidates({
      supplierId: 'RP001',
      attribution: circular,
      candidates: [{ supplierId: 'RP001', policy: policy('POL-A', { annual_mileage: '연 20,000km' }) }],
    });
    expect(match.status).toBe('INSUFFICIENT_EVIDENCE');
  });
});
