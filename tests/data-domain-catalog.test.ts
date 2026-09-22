import { describe, expect, it } from 'vitest';
import {
  DATA_ASSETS,
  DATA_DOMAINS,
  auditCatalogCoverage,
  classifyObservedDataAsset,
  searchDataCatalog
} from '../src/domain/data-domain-catalog.js';

describe('data domain catalog', () => {
  it('has stable unique domain and asset identifiers', () => {
    expect(new Set(DATA_DOMAINS.map((item) => item.domainId)).size).toBe(DATA_DOMAINS.length);
    expect(new Set(DATA_ASSETS.map((item) => item.assetId)).size).toBe(DATA_ASSETS.length);
    for (const asset of DATA_ASSETS) {
      expect(DATA_DOMAINS.some((domain) => domain.domainId === asset.domainId)).toBe(true);
    }
  });

  it('finds Korean and implementation aliases without collection knowledge', () => {
    expect(searchDataCatalog('정산').domains.map((item) => item.domainId)).toContain('settlement-finance');
    expect(searchDataCatalog('F86').assets.map((item) => item.assetId)).toContain('sheet-f86');
    const products = searchDataCatalog('products');
    expect(products.assets.map((item) => item.assetId)).toContain('erp5-products-source');
    expect(products.domains.map((item) => item.domainId)).toContain('catalog');
    expect(searchDataCatalog('통화').assets.map((item) => item.assetId)).toContain('sales-leads');
  });

  it('classifies an exact registered observation', () => {
    const result = classifyObservedDataAsset({
      kind: 'FIRESTORE_COLLECTION', system: 'firebase:freepasserp5', locator: 'products',
      observedAt: '2026-09-21T09:00:00.000Z', recordCount: 1659
    }, '2026-09-21T09:01:00.000Z', 120_000);
    expect(result.status).toBe('CLASSIFIED');
    expect(result.asset?.assetId).toBe('erp5-products-source');
    expect(result.domain?.domainId).toBe('catalog');
  });

  it('holds an unknown collection instead of guessing a domain', () => {
    const result = classifyObservedDataAsset({
      kind: 'FIRESTORE_COLLECTION', system: 'firebase:freepasserp5', locator: 'surprise_records',
      observedAt: '2026-09-21T09:00:00.000Z', recordCount: 3
    }, '2026-09-21T09:01:00.000Z', 120_000);
    expect(result.status).toBe('UNCLASSIFIED');
    expect(result.asset).toBeNull();
  });

  it('holds stale inventory evidence', () => {
    const result = classifyObservedDataAsset({
      kind: 'FIRESTORE_COLLECTION', system: 'firebase:freepasserp5', locator: 'products',
      observedAt: '2026-09-21T08:00:00.000Z', recordCount: 1659
    }, '2026-09-21T09:01:00.000Z', 120_000);
    expect(result.status).toBe('STALE');
  });

  it('fails coverage when any observed asset is unknown', () => {
    const result = auditCatalogCoverage([
      { kind: 'FIRESTORE_COLLECTION', system: 'firebase:freepasserp5', locator: 'products', observedAt: '2026-09-21T09:00:00.000Z' },
      { kind: 'FIRESTORE_COLLECTION', system: 'firebase:freepasserp5', locator: 'unknown', observedAt: '2026-09-21T09:00:00.000Z' }
    ], '2026-09-21T09:01:00.000Z', 120_000);
    expect(result.status).toBe('HOLD');
    expect(result.classified).toBe(1);
    expect(result.unclassified).toBe(1);
  });
});
