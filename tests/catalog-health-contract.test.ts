import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import healthSchema from '../contracts/catalog-data-health-v1.schema.json' with { type: 'json' };
import { buildErpPublicProjection } from '../src/application/catalog.js';
import { CATALOG_HEALTH_ISSUE_CODES, readCatalogDataHealth } from '../src/application/catalog-health.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateHealth = ajv.compile(healthSchema);

describe('Catalog Data Health contract v1', () => {
  it('validates the generated health report against the versioned JSON Schema', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T10:00:00.000Z'
    );

    const report = await readCatalogDataHealth(
      store,
      store,
      '2026-09-21T10:01:00.000Z'
    );

    expect(report.contractVersion).toBe('catalog-data-health-v1');
    expect(report.schemaVersion).toBe('1.0.0');
    expect(validateHealth(report), JSON.stringify(validateHealth.errors)).toBe(true);
  });

  it('rejects a response that changes the contract identity', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);

    const report = await readCatalogDataHealth(
      store,
      store,
      '2026-09-21T10:01:00.000Z'
    );

    const invalid = {
      ...report,
      contractVersion: 'catalog-data-health-v2'
    };

    expect(validateHealth(invalid)).toBe(false);
  });

  it('keeps JSON Schema issue codes exactly aligned with the TypeScript registry', () => {
    const schemaIssueCodes = [
      ...healthSchema.properties.issues.items.properties.code.enum
    ].sort();
    const runtimeIssueCodes = [...CATALOG_HEALTH_ISSUE_CODES].sort();

    expect(schemaIssueCodes).toEqual(runtimeIssueCodes);
  });

  it('rejects undeclared top-level fields so API drift is explicit', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);

    const report = await readCatalogDataHealth(
      store,
      store,
      '2026-09-21T10:01:00.000Z'
    );

    expect(validateHealth({
      ...report,
      accidentalField: true
    })).toBe(false);
  });
});
