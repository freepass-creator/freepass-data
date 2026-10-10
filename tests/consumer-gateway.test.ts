process.env.FREEPASS_SHEET_F04_ID = 'test-sheet-f04';
import { createHash } from 'node:crypto';
import { buildAdminCatalogProjection } from '../src/application/admin-catalog.js';
import { updateOfferPrice } from '../src/application/catalog.js';
import { describe, expect, it } from 'vitest';
import { createConsumerGateway, parseConsumerBindings, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { buildErpPublicProjection } from '../src/application/catalog.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { buildKakaoCatalogReference } from '../src/application/kakao-catalog-reference.js';

const token = 'test-service-token-0123456789abcdef';
const binding = { id: 'erp-com', projectionId: 'erp-public' as const, token };
const url = '/v1/consumers/erp-com/catalog';
const headers = { authorization: `Bearer ${token}` };
const healthUrl = '/v1/consumers/erp-com/catalog-health';
const compatUrl = '/v1/consumers/erp-com/catalog-compat';
const healthBinding: ConsumerBinding = {
  ...binding,
  capabilities: ['catalog', 'catalog-health']
};

const withAccess = (
  store: Parameters<typeof createConsumerGateway>[0],
  bindings: ConsumerBinding[],
  healthStore?: Parameters<typeof createConsumerGateway>[3],
  compatReader?: Parameters<typeof createConsumerGateway>[4]
) => {
  const logs = new MemoryDataAccessLogStore();
  const access = new DataAccessGateway(logs);
  return {
    logs,
    app: createConsumerGateway(store, bindings, access, healthStore, compatReader)
  };
};

describe('read-only consumer gateway', () => {
  it('delivers source displacement and explicit missing HOLD through both reference HTTP schemas', async () => {
    for (const [consumerId, capability, route] of [
      ['kakao-ops', 'catalog-reference', 'catalog-reference'],
      ['internal-ai-test', 'internal-ai-reference', 'internal-ai-reference'],
    ] as const) {
      const product = { listable: true, provider_company_code: 'RP013', engine_cc: '1,998',
        fuel_type: '가솔린', drive_type: 'AWD', price: { '36': { rent: 500000, deposit: null } } };
      const source = { consumerId, observedAt: '2026-10-10T00:00:00Z', products: {
        knownCc: product, missingCc: { ...product, engine_cc: null, fuel_type: '', drive_type: '' },
      } };
      const { app } = withAccess(new MemoryDataStore(), [{ id: consumerId, projectionId: 'erp-public', token, capabilities: [capability] }], undefined, {
        read: async () => { throw new Error('unused'); },
        readKakaoReferenceSource: async () => source,
        readInternalAiReferenceSource: async () => source,
      });
      const response = await app.inject({ url: `/v1/consumers/${consumerId}/${route}`, headers });
      expect(response.statusCode).toBe(200);
      const rows = response.json().data;
      expect(rows).toHaveLength(2);
      expect(rows.find((row: { sourceProductId: string }) => row.sourceProductId === 'knownCc').vehicle)
        .toMatchObject({ engineCc: 1998, engineCcState: 'KNOWN', fuel: '가솔린', drive: 'AWD' });
      const missing = rows.find((row: { sourceProductId: string }) => row.sourceProductId === 'missingCc');
      expect(missing.vehicle).toMatchObject({ engineCc: null, engineCcState: 'HOLD', fuel: null, drive: null });
      expect(missing.vehicleMasterReference).toMatchObject({ state: 'HOLD', masterId: null, trimId: null });
      expect(missing.offers[0].priceTerms[0].termKey).toBe('source:36');
      await app.close();
    }
  });
  it('keeps an unknown sibling in internal AI ANY_TERM and excludes it from ALL_TERMS', async () => {
    const consumerId = 'internal-ai-test';
    const product = { listable: true, provider_company_code: 'RP013', product_type: '중고렌트', deposit_note: '무보증',
      원문: { 전체: { 장기보증: '무보증' } },
      price: { '36': { rent: 500000, deposit: 0 }, '48': { rent: 450000, deposit: null } } };
    const { app } = withAccess(new MemoryDataStore(), [{ id: consumerId, projectionId: 'erp-public', token, capabilities: ['internal-ai-reference'] }], undefined, {
      read: async () => { throw new Error('unused'); },
      readInternalAiReferenceSource: async () => ({ consumerId, observedAt: '2026-10-09T00:00:00Z', products: { mixed: product } }),
    });
    const endpoint = `/v1/consumers/${consumerId}/internal-ai-reference`;
    const any = await app.inject({ url: endpoint + '?depositState=ZERO&termMonths=36', headers });
    expect(any.statusCode).toBe(200);
    expect(any.json().schema).toBe('freepass-data.internal-ai-reference/v1');
    expect(any.json().data[0].vehicleMediaEvidence).toMatchObject({verdict:'HOLD',consumerReadback:'NOT_CHECKED'});
    expect(any.json().data[0].offers[0].priceTerms.map((t: { depositState: string }) => t.depositState)).toEqual(['ZERO', 'UNKNOWN']);
    expect(any.json().data[0].offers[0].priceTerms[1]).toMatchObject({ termKey: 'source:48', depositAmount: null, deposit: null });
    const all = await app.inject({ url: endpoint + '?depositState=ZERO&termMonths=36&depositScope=ALL_TERMS', headers });
    expect(all.statusCode).toBe(200);
    expect(all.json().data).toEqual([]);
    expect(all.json().meta.depositFilter).toEqual({ state: 'ZERO', termMonths: 36, scope: 'ALL_TERMS' });
    expect((await app.inject({ url: endpoint + '?depositState=ZERO&termMonths=61', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: endpoint + '?depositState=ZERO&termMonths=36&termMonths=48', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: endpoint + '?depositState=ZERO&depositScope=ALL_TERMS&depositScope=ALL_TERMS', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: endpoint + '?depositState=ZERO', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    await app.close();
  });
  it('filters zero deposit through authenticated reference query, accepts no matches, rejects invalid periods', async () => {
    const base = { listable: true, provider_company_code: 'RP013', product_type: '중고렌트' };
    const sourceWaiver = { 원문: { 전체: { 장기보증: '무보증' } } };
    const { app } = withAccess(new MemoryDataStore(), [{ id: 'kakao-ops', projectionId: 'erp-public', token, capabilities: ['catalog-reference'] }], undefined, {
      read: async () => { throw new Error('unused'); },
      readKakaoReferenceSource: async () => ({ consumerId: 'kakao-ops', observedAt: '2026-10-09T00:00:00Z', products: {
        free: { ...base, ...sourceWaiver, deposit_note: '무보증', price: { '36': { rent: 500000, deposit: 0 } } },
        unknown: { ...base, price: { '36': { rent: 500000, deposit: 0 } } },
      } }),
    });
    const endpoint = '/v1/consumers/kakao-ops/catalog-reference';
    const complete = await app.inject({url:endpoint,headers});
    expect(complete.statusCode).toBe(200);
    expect(complete.json().data).toHaveLength(2);
    for (const q of ['supplierId=RP013&termMonths=36&monthlyRentMin=500000','depositState=UNKNOWN']) {
      const found=await app.inject({url:endpoint+'?'+q,headers}); expect(found.statusCode).toBe(200); expect(found.json().data.length).toBeGreaterThan(0);
    }
    const missing=await app.inject({url:endpoint+'?supplierId=absent',headers}); expect(missing.statusCode).toBe(200); expect(missing.json().data).toEqual([]);
    for(const q of ['limit=1','cursor=x','model=A&model=B','monthlyRentMin=bad','mileageKm=1000']) expect((await app.inject({url:endpoint+'?'+q,headers})).statusCode).toBe(400);

    const result = await app.inject({ url: endpoint + '?depositState=ZERO&termMonths=36&depositScope=ALL_TERMS', headers });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.map((p: { sourceProductId: string }) => p.sourceProductId)).toEqual(['free']);
    expect(result.json().meta.depositFilter).toEqual({ state: 'ZERO', termMonths: 36, scope: 'ALL_TERMS' });
    const none = await app.inject({ url: endpoint + '?depositState=ZERO&termMonths=48', headers });
    expect(none.statusCode).toBe(200);
    expect(none.json().data).toEqual([]);
    expect(none.json().meta.projectedCount).toBe(0);
    expect((await app.inject({ url: endpoint + '?depositState=ZERO&termMonths=0', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: endpoint + '?depositState=ZERO&termMonths=36' })).statusCode).toBe(401);
    await app.close();
  });
  it('delivers gallery, representative and color with unverified diagnostics and excludes documents', async () => {
    const image='https://supplier.example/car.jpg', document='https://supplier.example/document.jpg';
    const product={listable:true,provider_company_code:'RP013',provider_name:'Supplier Name',car_number:'000\uac000000',price:{'36':{rent:500000,deposit:null}},image_urls:[document,image],doc_images:[document],ext_color:'black',photo_link:'https://supplier.example/tcar'};
    const {app}=withAccess(new MemoryDataStore(),[{id:'kakao-ops',projectionId:'erp-public',token,capabilities:['catalog-reference']}],undefined,{
      read:async()=>{throw new Error('unused');},readKakaoReferenceSource:async()=>({consumerId:'kakao-ops',observedAt:'2026-10-09T00:00:00Z',products:{withPhotos:product,withoutPhotos:{...product,image_urls:[],ext_color:null}}})});
    const result=await app.inject({url:'/v1/consumers/kakao-ops/catalog-reference',headers});
    expect(result.statusCode).toBe(200);
    const row=result.json().data.find((p:{sourceProductId:string})=>p.sourceProductId==='withPhotos');
    expect(row.vehiclePhotos).toMatchObject({imageUrls:[image],representativeUrl:image,sourceLinkCount:1,accessVerification:'NOT_CHECKED'});
    expect(row.vehicle.exteriorColor).toBe('black');
    expect(row.vehicleMediaEvidence).toMatchObject({verdict:'HOLD',typedColorVerification:'NOT_CHECKED',visualVehicleIdentity:'NOT_CHECKED',consumerReadback:'NOT_CHECKED',imageBytes:'NOT_CHECKED'});
    expect(row.vehicleMediaEvidence.issues).toContain('SOURCE_EVIDENCE_MISSING');
    expect(result.json().meta.dataDigest).toBe(createHash('sha256').update(JSON.stringify(result.json().data)).digest('hex'));
    expect(row.vehicleMediaEvidence.checks).toEqual([expect.objectContaining({state:'DOCUMENT_IMAGE_EXCLUDED',status:null}),expect.objectContaining({state:'HEAD_NOT_CHECKED',status:null})]);
    expect(result.json().data).toHaveLength(2);
    const lookup=await app.inject({url:'/v1/consumers/kakao-ops/catalog-reference?'+new URLSearchParams({supplierName:'SupplierName',plateNumber:'000 \uac00-0000'}),headers});
    expect(lookup.statusCode).toBe(200);expect(lookup.json().data).toHaveLength(2);expect(lookup.json().meta.queryResolution.state).toBe('HOLD');
    expect((await app.inject({url:'/v1/consumers/kakao-ops/catalog-reference?plateNumber=3456',headers})).statusCode).toBe(400);
    expect(result.json().data.find((p:{sourceProductId:string})=>p.sourceProductId==='withoutPhotos').vehicle.exteriorColor).toBeNull();
    expect(product.photo_link).toBe('https://supplier.example/tcar');
    await app.close();
  });
  it('authenticates and audits Iancar photos without exposing provider references or credentials', async () => {
    let reads = 0;
    const reader = { read: async () => { throw new Error('unused'); }, readIancarPhoto: async (_consumer: string, product: string, index?: number) => {
      reads++;
      if (product === 'gone') throw new Error('IANCAR_PHOTO_NOT_FOUND');
      if (product === 'busy') throw new Error('IANCAR_PHOTO_BUSY');
      if (product === 'failed') throw new Error('private provider error with credentials');
      return { count: 2, bytes: index === undefined ? null : Buffer.from([255, 216, 255]), contentType: index === undefined ? 'application/json' : 'image/jpeg' };
    } };
    const { app, logs } = withAccess(new MemoryDataStore(), [binding], undefined, reader);
    const photoUrl = compatUrl + '/products/P1/photos';
    expect((await app.inject({ url: photoUrl })).statusCode).toBe(401);
    expect((await app.inject({ url: photoUrl, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect(reads).toBe(0);
    const manifest = await app.inject({ url: photoUrl, headers });
    expect(manifest.json()).toEqual({ schema: 'freepass-data.product-photos/v1', productId: 'P1', count: 2 });
    const binary = await app.inject({ url: photoUrl + '/0', headers });
    expect(binary.statusCode).toBe(200);
    expect(binary.rawPayload).toEqual(Buffer.from([255, 216, 255]));
    expect(binary.headers['content-type']).toBe('image/jpeg');
    expect(binary.headers['cache-control']).toBe('private, no-store');
    expect(binary.headers['x-content-type-options']).toBe('nosniff');
    expect(logs.events.at(-1)).toMatchObject({ operation: 'READ_IANCAR_PRODUCT_PHOTO', phase: 'SUCCEEDED' });
    for (const index of ['-1', '200', '1e1', '01', 'NaN']) expect((await app.inject({ url: photoUrl + '/' + index, headers })).statusCode).toBe(400);
    expect(reads).toBe(2);
    expect((await app.inject({ url: compatUrl + '/products/gone/photos/0', headers })).statusCode).toBe(404);
    const failure = await app.inject({ url: compatUrl + '/products/failed/photos/0', headers });
    expect(failure.statusCode).toBe(503);
    expect(failure.body).not.toContain('credentials');
    const busy = await app.inject({ url: compatUrl + '/products/busy/photos/0', headers });
    expect(busy.statusCode).toBe(429); expect(busy.headers['retry-after']).toBe('2');
    await app.close();
    const noCatalog = withAccess(new MemoryDataStore(), [{ id: 'internal-ai-test', projectionId: 'erp-public', token, capabilities: ['internal-ai-reference'] }], undefined, reader);
    expect((await noCatalog.app.inject({ url: '/v1/consumers/internal-ai-test/catalog-compat/products/P1/photos/0', headers })).statusCode).toBe(403);
    await noCatalog.app.close();
  });
  it('isolates internal AI project credentials, capabilities and audited typed responses', async () => {
    const ai: ConsumerBinding = { id: 'internal-ai-test-project', projectionId: 'erp-public', token, capabilities: ['internal-ai-reference'] };
    for (const capabilities of [undefined, ['catalog'], ['internal-ai-reference', 'admin-workflow']]) {
      expect(() => parseConsumerBindings(JSON.stringify([{ ...ai, capabilities }]))).toThrow();
    }
    expect(() => parseConsumerBindings(JSON.stringify([{ ...binding, capabilities: ['internal-ai-reference'] }]))).toThrow();
    let reads = 0;
    const compat = { read: async () => { throw new Error('raw bridge must not be used'); },
      readInternalAiReferenceSource: async (consumerId: string) => { reads++; return { consumerId, observedAt: '2026-09-30T01:54:45.805Z',
        products: { P1: { listable: true, provider_company_code: 'RP012', product_type: '픽업구독', deposit_note: '무보증',
          bank_account: 'must-not-leak', price: { '12': { rent: 900000, deposit: 0 } } } } }; } };
    const { app, logs } = withAccess({ getActive: async () => null, getManifest: async () => null, listProjectionLineage: async () => [] }, [ai], undefined, compat);
    const aiUrl = `/v1/consumers/${ai.id}/internal-ai-reference`;
    expect((await app.inject({ url: aiUrl })).statusCode).toBe(401);
    expect((await app.inject({ url: aiUrl, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect(reads).toBe(0);
    const result = await app.inject({ url: aiUrl, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ schema: 'freepass-data.internal-ai-reference/v1', meta: { consumerId: ai.id, authority: 'REFERENCE_ONLY', publicationDecision: 'HOLD' } });
    expect(result.body).not.toContain('must-not-leak');
    expect(result.json().data[0].offers[0].priceTerms[0].depositState).toBe('UNKNOWN');
    expect(logs.events.at(-1)).toMatchObject({ operation: 'READ_INTERNAL_AI_REFERENCE', phase: 'SUCCEEDED' });
    for (const endpoint of ['catalog', 'catalog-compat', 'catalog-reference', 'catalog-health']) {
      expect((await app.inject({ url: `/v1/consumers/${ai.id}/${endpoint}`, headers })).statusCode).toBe(403);
    }
    expect(reads).toBe(1);
    expect((await app.inject({ method: 'POST', url: aiUrl, headers })).statusCode).toBe(404);
    await app.close();
  });
  it('does not read storage before authenticating the registered consumer', async () => {
    let reads = 0;
    const { app, logs } = withAccess(
      { getActive: async () => { reads++; return null; }, getManifest: async () => null, listProjectionLineage: async () => [] },
      [binding]
    );
    for (const request of [{ url }, { url, headers: { authorization: 'Bearer wrong' } }, { url: '/v1/consumers/admin/catalog', headers }]) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    expect(reads).toBe(0);
    expect(logs.events).toHaveLength(3);
    expect(logs.events.every((event) =>
      event.mode === 'READ' &&
      event.phase === 'DENIED' &&
      event.reasonCode === 'UNAUTHORIZED'
    )).toBe(true);
    await app.close();
  });
  it('keeps the compatibility bridge behind consumer authentication and Data Access audit', async () => {
    let reads = 0;
    const compat = {
      read: async (consumerId: string) => {
        reads += 1;
        return {
          schema: 'freepass-data.catalog-compat/v1' as const,
          data: {
            products: { P1: { _key: 'P1', product_code: 'P1' } },
            policies: { POL1: { _key: 'POL1', policy_code: 'POL1' } },
            partners: {},
            users: {},
          },
          meta: {
            consumerId,
            authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE' as const,
            sourceProject: 'freepasserp5' as const,
            observedAt: '2026-09-27T00:00:00.000Z',
            collectionCounts: { products: 1, policy: 1, partner: 0, user: 0 },
            depositEvidenceVersion: 'catalog-compat-deposit/1' as const,
          },
        };
      },
    };

    const { app, logs } = withAccess(
      { getActive: async () => null, getManifest: async () => null, listProjectionLineage: async () => [] },
      [binding],
      undefined,
      compat,
    );

    expect((await app.inject({ url: compatUrl })).statusCode).toBe(401);
    expect(reads).toBe(0);

    const result = await app.inject({ url: compatUrl, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      schema: 'freepass-data.catalog-compat/v1',
      meta: {
        consumerId: 'erp-com',
        authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE',
        sourceProject: 'freepasserp5',
      },
    });
    expect(reads).toBe(1);
    expect(logs.events.at(-1)).toMatchObject({
      mode: 'READ',
      phase: 'SUCCEEDED',
      operation: 'READ_CONSUMER_CATALOG_COMPAT',
      result: { count: 1 },
    });
    await app.close();
  });

  it('serves Kakao typed reference facts only to its dedicated identity', async () => {
    let reads = 0;
    const reference = buildKakaoCatalogReference({
      consumerId: 'kakao-ops',
      observedAt: '2026-09-28T00:00:00.000Z',
      products: {
        P1: {
          listable: true,
          maker: '기아', model: '쏘렌토', trim_name: '시그니처', product_type: '중고렌트',
          provider_company_code: 'RP013', ext_color: '화이트', deposit_note: '국산: 월 대여료×2',
          price: { '36': { rent: 800000, deposit: 0 } },
        },
      },
    });
    const compat = {
      read: async () => { throw new Error('not used'); },
      readKakaoReferenceSource: async () => {
        reads += 1;
        return {
          consumerId: 'kakao-ops',
          observedAt: reference.meta.observedAt,
          products: {
            P1: {
              listable: true,
              maker: '기아', model: '쏘렌토', trim_name: '시그니처', product_type: '중고렌트',
              provider_company_code: 'RP013', ext_color: '화이트', deposit_note: '국산: 월 대여료×2',
              image_urls: ['https://photos.example.test/소나타 사진.jpg', 'https://photos.example.test/interior.jpg'],
              doc_images: ['https://photos.example.test/registration.jpg'],
              price: { '36': { rent: 800000, deposit: 0 } },
            },
          },
        };
      },
    };
    const kakaoBinding: ConsumerBinding = {
      id: 'kakao-ops', projectionId: 'erp-public', token,
      capabilities: ['catalog-reference'],
    };
    const { app, logs } = withAccess(
      { getActive: async () => null, getManifest: async () => null, listProjectionLineage: async () => [] },
      [kakaoBinding],
      undefined,
      compat,
    );
    const referenceUrl = '/v1/consumers/kakao-ops/catalog-reference';

    expect((await app.inject({ url: referenceUrl })).statusCode).toBe(401);
    expect(reads).toBe(0);
    const result = await app.inject({ url: referenceUrl, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      schema: 'freepass-data.kakao-catalog-reference/v1',
      data: [{ vehicle: { exteriorColor: '화이트' }, vehiclePhotos: {
        state: 'URLS_PRESENT', imageUrls: ['https://photos.example.test/%EC%86%8C%EB%82%98%ED%83%80%20%EC%82%AC%EC%A7%84.jpg', 'https://photos.example.test/interior.jpg'],
        representativeUrl: 'https://photos.example.test/%EC%86%8C%EB%82%98%ED%83%80%20%EC%82%AC%EC%A7%84.jpg', accessVerification: 'NOT_CHECKED',
      }, offers: [{ priceTerms: [{ depositAmount: 1600000 }] }] }],
      meta: { consumerId: 'kakao-ops', authority: 'REFERENCE_ONLY', publicationDecision: 'HOLD' },
    });
    expect(reads).toBe(1);
    expect(logs.events.at(-1)).toMatchObject({
      mode: 'READ', phase: 'SUCCEEDED', operation: 'READ_KAKAO_CATALOG_REFERENCE', result: { count: 1 },
    });
    await app.close();
  });

  it('returns HOLD instead of demo data when the operational release is absent', async () => {
    const { app } = withAccess(new MemoryDataStore(), [binding]);
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ code: 'NO_ACTIVE_RELEASE' });
    expect((await app.inject({ method: 'POST', url: '/v1/commands/offers/1/price', payload: {} })).statusCode).toBe(404);
    await app.close();
  });
  it('returns the actual release identity to each separately registered consumer', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const release = await buildErpPublicProjection(store, store);
    const { app, logs } = withAccess(store, [binding, { id: 'whitelabel-test', projectionId: 'erp-public', token: token + '2' }]);
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json().meta.releaseId).toBe(release.releaseId);
    expect(result.json().meta.authority).toBe('CANONICAL_ACTIVE');
    expect(result.json().meta.dataDigest).toBe(release.dataDigest);
    expect(result.json().meta.commercialCoverage).toBe('COMPLETE');
    expect(result.json().meta.commercialMissingOfferIds).toEqual([]);
    expect(result.json().data[0]?.offers[0]?.commercial?.basisRows[0]?.termKey).toBe('36@20000');
    expect(logs.events.slice(0, 2).map((event) => event.phase)).toEqual(['STARTED', 'SUCCEEDED']);
    expect(logs.events[1]).toMatchObject({
      mode: 'READ',
      operation: 'READ_CONSUMER_CATALOG',
      result: {
        count: release.data.length,
        digest: release.dataDigest,
        inputDigest: release.inputDigest,
        releaseId: release.releaseId,
        manifestId: release.manifestId,
        revision: release.canonicalRevision
      }
    });
    expect((await app.inject({ url: '/v1/consumers/whitelabel-test/catalog', headers })).statusCode).toBe(401);
    const other = await app.inject({ url: '/v1/consumers/whitelabel-test/catalog', headers: { authorization: `Bearer ${token}2` } });
    expect(other.json().meta.releaseId).toBe(release.releaseId);
    await app.close();
  });
  it('rejects modified data, missing evidence and cross-projection release pointers', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const release = await buildErpPublicProjection(store, store);
    for (const altered of [
      { ...release, data: [] },
      { ...release, status: 'READY' as const },
      { ...release, projectionId: 'admin-catalog' },
      { ...release, activatedAt: null },
      { ...release, schemaVersion: 'unreviewed-version' },
      { ...release, data: release.data.map((row) => ({ ...row, privateCustomer: 'must-not-be-returned' })) },
    ]) {
      const { app } = withAccess(
        { getActive: async () => altered, getManifest: (id: string) => store.getManifest(id), listProjectionLineage: (id: string) => store.listProjectionLineage(id) } as unknown as Parameters<typeof createConsumerGateway>[0],
        [binding]
      );
      expect((await app.inject({ url, headers })).statusCode).toBe(503);
      await app.close();
    }
    const { app } = withAccess(
      { getActive: async () => release, getManifest: async () => null, listProjectionLineage: (id: string) => store.listProjectionLineage(id) } as unknown as Parameters<typeof createConsumerGateway>[0],
      [binding]
    );
    expect((await app.inject({ url, headers })).statusCode).toBe(503);
    await app.close();
  });

  it('fails closed when release lineage is missing or evidence cannot be read atomically', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const release = await buildErpPublicProjection(store, store);

    const missingLineage = {
      getActive: (projectionId: string) => store.getActive(projectionId),
      getManifest: (releaseId: string) => store.getManifest(releaseId),
      listProjectionLineage: async () => []
    };
    const { app } = withAccess(
      missingLineage as unknown as Parameters<typeof createConsumerGateway>[0],
      [binding]
    );
    const result = await app.inject({ url, headers });

    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ code: 'RELEASE_EVIDENCE_MISMATCH' });
    await app.close();

    const atomicSnapshot = await store.getActiveEvidenceSnapshot('erp-public');
    const tamperedEvidence = {
      ...atomicSnapshot,
      lineage: []
    };
    const { app: atomicApp } = withAccess({
      getActive: (projectionId: string) => store.getActive(projectionId),
      getManifest: (releaseId: string) => store.getManifest(releaseId),
      listProjectionLineage: (releaseId: string) => store.listProjectionLineage(releaseId),
      getActiveEvidenceSnapshot: async () => tamperedEvidence
    } as unknown as Parameters<typeof createConsumerGateway>[0], [binding]);
    const atomicResult = await atomicApp.inject({ url, headers });

    expect(atomicResult.statusCode).toBe(503);
    expect(atomicResult.json().code).toBe('RELEASE_EVIDENCE_MISMATCH');
    expect(atomicResult.json().failures).toEqual(expect.arrayContaining([
      'EVIDENCE_COUNT_MISMATCH',
      'EVIDENCE_DIGEST_MISMATCH'
    ]));
    expect(release.releaseId).toBe(atomicSnapshot.release?.releaseId);
    await atomicApp.close();
  });

  it('authenticates before touching the Data Health reader', async () => {
    let healthReads = 0;
    const healthStore = {
      listVehicleModels: async () => { healthReads++; return []; },
      listVehicleAssets: async () => [],
      listProducts: async () => [],
      listOffers: async () => [],
      listPolicies: async () => [],
      listRevisionHistory: async () => [],
      getActive: async () => null,
      getManifest: async () => null,
      listProjectionLineage: async () => []
    } as any;

    const { app } = withAccess(
      { getActive: async () => null, getManifest: async () => null, listProjectionLineage: async () => [] },
      [healthBinding],
      healthStore
    );

    for (const request of [
      { url: healthUrl },
      { url: healthUrl, headers: { authorization: 'Bearer wrong' } }
    ]) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    expect(healthReads).toBe(0);
    await app.close();
  });

  it('requires an explicit catalog-health capability', async () => {
    const store = new MemoryDataStore();
    const { app } = withAccess(store, [binding], store);

    const result = await app.inject({ url: healthUrl, headers });
    expect(result.statusCode).toBe(403);
    expect(result.json()).toEqual({ code: 'FORBIDDEN' });

    await app.close();
  });

  it('returns DEGRADED as HTTP 200 because the diagnostic read itself succeeded', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);

    const { app } = withAccess(store, [healthBinding], store);
    const result = await app.inject({ url: healthUrl, headers });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      contractVersion: 'catalog-data-health-v1',
      status: 'DEGRADED'
    });

    await app.close();
  });

  it('returns 503 and audits denial when a health-capable registration has no Health reader', async () => {
    const store = new MemoryDataStore();
    const { app, logs } = withAccess(store, [healthBinding]);

    const result = await app.inject({ url: healthUrl, headers });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ code: 'HEALTH_READER_UNAVAILABLE' });
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      mode: 'READ',
      phase: 'DENIED',
      operation: 'READ_CATALOG_HEALTH',
      reasonCode: 'HEALTH_READER_UNAVAILABLE'
    });

    await app.close();
  });

  it('returns a schema-valid HEALTHY report to an explicitly authorized health reader', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(store, store);

    const { app } = withAccess(store, [healthBinding], store);
    const result = await app.inject({ url: healthUrl, headers });

    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json()).toMatchObject({
      contractVersion: 'catalog-data-health-v1',
      schemaVersion: '1.1.0',
      scope: 'catalog-v1',
      status: 'HEALTHY'
    });

    await app.close();
  });

  it('returns HTTP 503 with the report body when Catalog Data Health is BLOCKED', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(store, store);

    const product = await store.getProduct('prod_gv70_demo');
    await store.seed!({
      products: [{
        ...product!,
        vehicleModelId: 'vm_missing'
      }]
    });

    const { app } = withAccess(store, [healthBinding], store);
    const result = await app.inject({ url: healthUrl, headers });

    expect(result.statusCode).toBe(503);
    expect(result.json()).toMatchObject({
      contractVersion: 'catalog-data-health-v1',
      status: 'BLOCKED'
    });
    expect(result.json().issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'MISSING_PRODUCT_VEHICLE_MODEL',
        severity: 'ERROR'
      })
    ]));

    await app.close();
  });

  it('allows a health-only registration without granting catalog data access', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(store, store);

    const healthOnly: ConsumerBinding = {
      ...binding,
      capabilities: ['catalog-health']
    };
    const { app } = withAccess(store, [healthOnly], store);

    expect((await app.inject({ url, headers })).statusCode).toBe(403);
    expect((await app.inject({ url: healthUrl, headers })).statusCode).toBe(200);

    await app.close();
  });

  it('does not silently reuse the ERP contract for Sheets or Admin, or share credentials', () => {
    for (const id of ['f01', 'f86', 'admin']) {
      expect(() => parseConsumerBindings(JSON.stringify([{ ...binding, id }]))).toThrow('not implemented');
    }
    expect(() => parseConsumerBindings(JSON.stringify([binding, { ...binding, id: 'whitelabel-test' }]))).toThrow('shared service token');
    expect(() => parseConsumerBindings(undefined)).toThrow('required');
    expect(parseConsumerBindings(JSON.stringify([{ ...binding, id: 'kakao-ops' }]))[0]?.id).toBe('kakao-ops');
    expect(parseConsumerBindings(JSON.stringify([{ ...binding, id: 'kakao-ops' }]))[0]?.capabilities)
      .toEqual(['catalog']);
    expect(() => parseConsumerBindings(JSON.stringify([{ ...binding, capabilities: ['catalog-reference'] }])))
      .toThrow('requires kakao-ops');
    for (const entries of [
      [],
      [{ ...binding, token: 'short' }],
      [{ ...binding, token: token + ' ' }],
      [{ ...binding, projectionId: 'admin-catalog' }],
      [{ ...binding, capabilities: [] }],
      [{ ...binding, capabilities: ['unknown'] }],
      [{ ...binding, capabilities: ['catalog', 'catalog'] }]
    ]) {
      expect(() => parseConsumerBindings(JSON.stringify(entries))).toThrow();
    }
  });
});


it('serves Admin stored fees and coverage with an isolated grant, and no public fee leakage', async () => {
  const store = new MemoryDataStore(); await seedDemoCatalog(store);
  await updateOfferPrice(store, { commandId: 'fees', idempotencyKey: 'fees-admin-unknown',
    offerId: 'offer_gv70_demo', expectedRevision: 1, termKey: '36@20000',
    monthlyRent: { amount: 500000, currency: 'KRW' }, reason: 'test missing supplier policy', actor: { id: 'user:test', kind: 'USER' } });
  const admin = await buildAdminCatalogProjection(store, store);
  await buildErpPublicProjection(store, store);
  const { app } = withAccess(store, [binding, { id: 'freepass-admin-catalog', projectionId: 'admin-catalog', token: token + '-admin' }]);
  const adminUrl = '/v1/consumers/freepass-admin-catalog/catalog';
  expect((await app.inject({ url: adminUrl, headers })).statusCode).toBe(401);
  const response = await app.inject({ url: adminUrl, headers: { authorization: `Bearer ${token}-admin` } });
  expect(response.statusCode).toBe(200);
  expect(response.json().meta).toMatchObject({ ...admin.economics, economicsCoverage: 'INCOMPLETE' });
  expect(response.json().meta.economicsTermCounts.supplierBillingFee.UNKNOWN).toBe(1);
  expect(response.json().data[0].offers[0].priceTerms[0].channelPayoutFee).toMatchObject({ state: 'UNKNOWN', amount: null });
  const publicResponse = await app.inject({ url, headers });
  expect(publicResponse.statusCode).toBe(200);
  expect(publicResponse.body).not.toContain('supplierBillingFee');
  expect(publicResponse.body).not.toContain('economicsCoverage');
  await app.close();
});

it('serves Admin contract fee links in request order with one catalog read pass', async () => {
  const store = new MemoryDataStore();
  await seedDemoCatalog(store);
  const adminBinding: ConsumerBinding = {
    id: 'freepass-admin-catalog',
    projectionId: 'admin-catalog',
    token: token + '-admin',
    capabilities: ['contract-fee-link-read'],
  };
  const calls = { assets: 0, products: 0, offers: 0, writes: 0 };
  const feeStore = {
    listVehicleAssets: async () => { calls.assets++; return store.listVehicleAssets(); },
    listProducts: async () => { calls.products++; return store.listProducts(); },
    listOffers: async () => { calls.offers++; return store.listOffers(); },
    transact: async () => { calls.writes++; throw new Error('write must not be called'); },
  } as any;
  const { app, logs } = withAccess(store, [binding, adminBinding], feeStore);
  const endpoint = '/v1/consumers/freepass-admin-catalog/contract-fee-links';
  const payload = { items: [
    { key: 'row-2', assetId: 'va_gv70_demo', supplierId: 'supplier_demo', termMonths: 36, monthlyRent: 690000, deposit: 3000000 },
    { key: 'row-1', plate: '00가0000', supplierId: 'supplier_demo', termMonths: 60, monthlyRent: 690000 },
  ] };

  const response = await app.inject({
    method: 'POST',
    url: endpoint,
    headers: { authorization: `Bearer ${token}-admin` },
    payload,
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().contract).toBe('contract-fee-links/v1');
  expect(response.json().results.map((item: { key: string }) => item.key)).toEqual(['row-2', 'row-1']);
  expect(response.json().results[0]).toMatchObject({ key: 'row-2', status: 'LINKED', offerId: 'offer_gv70_demo' });
  expect(response.json().results[0].fees.supplierBillingFee.status).toBe('CONFIRMED');
  expect(response.json().results[1]).toMatchObject({ key: 'row-1', status: 'FAILED', failure: 'NO_TERM' });
  expect(calls).toEqual({ assets: 1, products: 1, offers: 1, writes: 0 });
  expect(logs.events.at(-1)).toMatchObject({
    mode: 'READ',
    phase: 'SUCCEEDED',
    operation: 'READ_CONTRACT_FEE_LINKS',
    result: { count: 2 },
  });
  await app.close();
});

it('rejects invalid contract fee link requests before reading catalog data', async () => {
  const adminBinding: ConsumerBinding = {
    id: 'freepass-admin-catalog',
    projectionId: 'admin-catalog',
    token: token + '-admin',
    capabilities: ['contract-fee-link-read'],
  };
  let reads = 0;
  const feeStore = {
    listVehicleAssets: async () => { reads++; return []; },
    listProducts: async () => { reads++; return []; },
    listOffers: async () => { reads++; return []; },
  } as any;
  const { app } = withAccess(new MemoryDataStore(), [adminBinding], feeStore);
  const endpoint = '/v1/consumers/freepass-admin-catalog/contract-fee-links';
  const auth = { authorization: `Bearer ${token}-admin` };
  const validItem = { key: 'row', supplierId: 'supplier_demo', termMonths: 36, monthlyRent: 690000 };

  expect((await app.inject({ method: 'POST', url: endpoint, headers: auth, payload: { items: Array.from({ length: 501 }, (_, i) => ({ ...validItem, key: `row-${i}` })) } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: endpoint, headers: auth, payload: { items: [{ ...validItem, key: 'dup' }, { ...validItem, key: 'dup' }] } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: endpoint, headers: auth, payload: { items: [{ ...validItem, termMonths: 0 }] } })).statusCode).toBe(400);
  expect(reads).toBe(0);
  await app.close();
});

it('keeps contract fee links internal to Admin identity and rejects bad auth', async () => {
  const adminBinding: ConsumerBinding = {
    id: 'freepass-admin-catalog',
    projectionId: 'admin-catalog',
    token: token + '-admin',
    capabilities: ['contract-fee-link-read'],
  };
  let reads = 0;
  const feeStore = {
    listVehicleAssets: async () => { reads++; return []; },
    listProducts: async () => { reads++; return []; },
    listOffers: async () => { reads++; return []; },
  } as any;
  const { app } = withAccess(new MemoryDataStore(), [binding, adminBinding], feeStore);
  const adminUrl = '/v1/consumers/freepass-admin-catalog/contract-fee-links';
  const erpUrl = '/v1/consumers/erp-com/contract-fee-links';
  const payload = { items: [{ key: 'row', supplierId: 'supplier_demo', termMonths: 36, monthlyRent: 690000 }] };

  expect((await app.inject({ method: 'POST', url: adminUrl, payload })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: adminUrl, headers: { authorization: 'Bearer wrong' }, payload })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: erpUrl, headers, payload })).statusCode).toBe(403);
  expect(reads).toBe(0);
  await app.close();
});
