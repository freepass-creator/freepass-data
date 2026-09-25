import { describe, expect, it } from 'vitest';
import { createConsumerGateway, parseConsumerBindings, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import {
  ESTIMATE_NEWCAR_MASTER_PROJECTION_ID,
  validateEstimateMasterSemantics,
  type EstimateNewcarMasterRecord
} from '../src/domain/estimate-master.js';
import { stableDigest } from '../src/shared/stable-digest.js';

const token = 'estimate-service-token-0123456789abcdef';
const binding: ConsumerBinding = {
  id: 'freepass-estimate',
  projectionId: ESTIMATE_NEWCAR_MASTER_PROJECTION_ID,
  token,
  capabilities: ['estimate-newcar-master']
};
const url = '/v1/consumers/freepass-estimate/estimate-newcar-master';
const headers = { authorization: `Bearer ${token}` };

function record(overrides: Partial<EstimateNewcarMasterRecord> = {}): EstimateNewcarMasterRecord {
  return {
    productId: 'prod_niro_signature',
    vehicleModelId: 'vm_niro',
    modelYearId: 'my_niro_2026',
    trimId: 'trim_niro_signature',
    powertrainId: 'pt_niro_hev',
    maker: '기아',
    model: '니로',
    modelYear: 2026,
    trimName: '시그니처',
    powertrainName: '1.6 하이브리드',
    basePrice: { amount: 35020000, currency: 'KRW' },
    options: [
      {
        optionId: 'opt_drivewise',
        name: '드라이브 와이즈',
        price: { amount: 700000, currency: 'KRW' },
        requires: [],
        excludes: [],
        exclusiveGroupId: null
      }
    ],
    exteriorColors: [
      { colorId: 'ext_snow_white', name: '스노우 화이트 펄', code: null, price: { amount: 80000, currency: 'KRW' } }
    ],
    interiorColors: [
      { colorId: 'int_charcoal', name: '차콜', code: null, price: { amount: 0, currency: 'KRW' } }
    ],
    configuration: { drivetrain: 'FWD', seats: 5, bodyConfiguration: null },
    status: 'ACTIVE',
    holdReasons: [],
    ...overrides
  };
}

function release(records: EstimateNewcarMasterRecord[]) {
  const inputDigest = stableDigest([{ entityType: 'VehicleModel', entityId: 'vm_niro', revision: 7, validationStatus: 'VALID' }]);
  const dataDigest = stableDigest(records);
  return {
    releaseId: 'rel_estimate-master-001',
    projectionId: ESTIMATE_NEWCAR_MASTER_PROJECTION_ID,
    schemaVersion: '1.0.0',
    canonicalRevision: 7,
    manifestId: 'manifest_estimate-master-001',
    inputDigest,
    dataDigest,
    status: 'ACTIVE',
    generatedAt: '2026-09-25T08:00:00.000Z',
    activatedAt: '2026-09-25T08:01:00.000Z',
    data: records
  } as any;
}

function manifest(r: ReturnType<typeof release>) {
  const canonicalInputs = [{ entityType: 'VehicleModel', entityId: 'vm_niro', revision: 7, validationStatus: 'VALID' }];
  return {
    manifestId: r.manifestId,
    releaseId: r.releaseId,
    projectionId: r.projectionId,
    schemaVersion: r.schemaVersion,
    generatedAt: r.generatedAt,
    canonicalInputs,
    productCount: r.data.length,
    offerCount: 0,
    fieldEvidenceCount: 0,
    inputDigest: stableDigest(canonicalInputs),
    dataDigest: stableDigest(r.data)
  } as any;
}

describe('Estimate new-car master consumer contract', () => {
  it('requires a dedicated FreePass Estimate registration and projection', () => {
    expect(parseConsumerBindings(JSON.stringify([binding]))[0]).toMatchObject({
      id: 'freepass-estimate',
      projectionId: 'estimate-newcar-master',
      capabilities: ['estimate-newcar-master']
    });
    expect(() => parseConsumerBindings(JSON.stringify([{ ...binding, projectionId: 'erp-public' }]))).toThrow('Unsupported consumer projection');
    expect(() => parseConsumerBindings(JSON.stringify([{ ...binding, capabilities: ['catalog'] }]))).toThrow('may only use');
    expect(() => parseConsumerBindings(JSON.stringify([{
      id: 'erp-com', projectionId: 'erp-public', token: token + '2', capabilities: ['estimate-newcar-master']
    }]))).toThrow('requires freepass-estimate');
  });

  it('authenticates before reading the projection store', async () => {
    let reads = 0;
    const app = createConsumerGateway({
      getActive: async () => { reads += 1; return null; },
      getManifest: async () => null
    }, [binding]);

    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect(reads).toBe(0);
    await app.close();
  });

  it('fails closed when no ACTIVE master release exists', async () => {
    const app = createConsumerGateway({
      getActive: async () => null,
      getManifest: async () => null
    }, [binding]);
    expect((await app.inject({ url, headers })).statusCode).toBe(503);
    await app.close();
  });

  it('returns only schema-valid, semantically valid, evidence-matching master data', async () => {
    const records = [record()];
    const r = release(records);
    const m = manifest(r);
    const app = createConsumerGateway({
      getActive: async () => r,
      getManifest: async () => m
    }, [binding]);

    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      data: [{ productId: 'prod_niro_signature', modelYearId: 'my_niro_2026' }],
      meta: {
        contract: 'estimate-newcar-master/v1',
        authority: 'CANONICAL_ACTIVE',
        projectionId: 'estimate-newcar-master',
        releaseId: r.releaseId,
        inputDigest: r.inputDigest,
        dataDigest: r.dataDigest
      }
    });
    await app.close();
  });

  it('rejects unknown option references and incomplete ACTIVE colors', async () => {
    const badRecords = [record({
      options: [{
        optionId: 'opt_a',
        name: 'A',
        price: { amount: 1, currency: 'KRW' },
        requires: ['missing'],
        excludes: []
      }],
      interiorColors: []
    })];
    expect(validateEstimateMasterSemantics(badRecords)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'OPTION_REQUIRES_UNKNOWN' }),
      expect.objectContaining({ code: 'ACTIVE_INTERIOR_COLOR_REQUIRED' })
    ]));

    const r = release(badRecords);
    const app = createConsumerGateway({
      getActive: async () => r,
      getManifest: async () => manifest(r)
    }, [binding]);
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('ESTIMATE_MASTER_SEMANTIC_INVALID');
    await app.close();
  });

  it('rejects mutated payloads even when release IDs still look valid', async () => {
    const records = [record()];
    const r = release(records);
    const m = manifest(r);
    const mutated = {
      ...r,
      data: [record({ basePrice: { amount: 1, currency: 'KRW' } })]
    };
    const app = createConsumerGateway({
      getActive: async () => mutated,
      getManifest: async () => m
    }, [binding]);

    expect((await app.inject({ url, headers })).statusCode).toBe(503);
    await app.close();
  });

  it('requires HOLD records to explain why they are unavailable', () => {
    expect(validateEstimateMasterSemantics([record({ status: 'HOLD', holdReasons: [] })]))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'HOLD_REASON_REQUIRED' })]));
  });
});
