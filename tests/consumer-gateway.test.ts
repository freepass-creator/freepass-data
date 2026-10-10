import { PassThrough } from 'node:stream';
import { createPhotoRequestBucket, PHOTO_REQUEST_LIMITS } from '../src/api/photo-request-limit.js';
process.env.FREEPASS_SHEET_F04_ID = 'test-sheet-f04';
import { createHash } from 'node:crypto';
import { vehiclePhotoKey } from '../src/domain/consumer-output-contract.js';
import { createApprovedDrivePhotoReader, createVehiclePhotoReader, isApprovedVehiclePhotoProduct, VEHICLE_PHOTO_CACHE_TTL_MS } from '../src/infra/erp5-compat-catalog-reader.js';
import { buildAdminCatalogProjection } from '../src/application/admin-catalog.js';
import { updateOfferPrice } from '../src/application/catalog.js';
import { describe, expect, it, vi } from 'vitest';
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

describe('approved Drive original-byte adapter (offline only)', () => {
  const bytes = Buffer.from([255, 216, 255, 1]);
  const product = { listable: true, status_kind: '가용', provider_company_code: 'TEST', supplier_vehicle_id: 'fixture' };
  const ref = { driveFileId: 'fixture-file', sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/jpeg' as const,
    role: 'VEHICLE_PHOTO' as const, zone: '차량사진' as const, approvedAt: '2026-10-10T00:00:00Z', vehicleKey: vehiclePhotoKey(product)!,
    vehiclePhotoVerifiedBy: 'fixture', vehiclePhotoVerificationMethod: 'fixture', vehiclePhotoVerifiedAt: '2026-10-10T00:00:00Z' };
  const metadata = (patch: Record<string, unknown> = {}) => Response.json({ id: ref.driveFileId, mimeType: ref.mediaType, size: String(bytes.length), trashed: false, ...patch });
  const image = (value = bytes, type = ref.mediaType) => new Response(value, { headers: { 'content-type': type } });
  const adapter = (responses: Response[]) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);
    return { read: createApprovedDrivePhotoReader({ token: async () => 'private-fixture-token', fetchImpl }), fetchImpl };
  };
  it('reads only the approved ID via GET and never exposes its token or calls Drive listing', async () => {
    const { read, fetchImpl } = adapter([metadata(), image()]);
    expect(await read(ref)).toEqual({ bytes, contentType: ref.mediaType });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/drive/v3/files/fixture-file', '/drive/v3/files/fixture-file']);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url)).not.toContain('private-fixture-token');
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    }
  });
  it.each([401, 403, 404])('sanitizes HTTP %s without response-body/token leakage', async status => {
    const { read } = adapter([new Response('private-fixture-token upstream secret', { status })]);
    await expect(read(ref)).rejects.toThrow(status === 404 ? 'VEHICLE_PHOTO_NOT_FOUND' : 'VEHICLE_PHOTO_UNAVAILABLE');
  });
  it.each([{ id: 'other-file' }, { trashed: true }, { mimeType: 'text/html' }, { size: '8388609' }, { size: '-1' }])('rejects unsafe metadata %j before downloading', async patch => {
    const { read, fetchImpl } = adapter([metadata(patch)]);
    await expect(read(ref)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects path injection before auth/transport', async () => {
    const { read, fetchImpl } = adapter([]);
    await expect(read({ ...ref, driveFileId: '../files?alt=media' })).rejects.toThrow('VEHICLE_PHOTO_REQUEST_INVALID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['size', 'signature', 'media', 'length'])('rejects %s mismatch in downloaded bytes', async mode => {
    const response = mode === 'media' ? new Response(bytes, { headers: { 'content-type': 'text/html' } })
      : mode === 'length' ? new Response(bytes, { headers: { 'content-type': ref.mediaType, 'content-length': '99' } })
      : image(mode === 'size' ? Buffer.concat([bytes, bytes]) : Buffer.from([0, 0, 0, 0]));
    const { read } = adapter([metadata(), response]);
    await expect(read(ref)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
  });
  it('retains common byte hash and approval revocation checks', async () => {
    let current = { ...product, photo_original_refs: [ref] };
    const { read } = adapter([metadata(), image(Buffer.from([255, 216, 255, 2]))]);
    const common = createVehiclePhotoReader(async () => current, undefined, read);
    await expect(common('erp-com', 'fixture', 0)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    const good = adapter([metadata(), image()]);
    const pipeline = createVehiclePhotoReader(async () => current, undefined, good.read);
    expect((await pipeline('erp-com', 'fixture', 0)).bytes).toEqual(bytes);
    current = { ...current, listable: false };
    await expect(pipeline('erp-com', 'fixture', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    expect(good.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('sanitizes credential and network exception diagnostics without logging', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const read = createApprovedDrivePhotoReader({ token: async () => { throw new Error('private-fixture-token'); } });
      await expect(read(ref)).rejects.toThrow(/^VEHICLE_PHOTO_UNAVAILABLE$/);
      const network = createApprovedDrivePhotoReader({ token: async () => 'private-fixture-token',
        fetchImpl: async () => { throw new Error('upstream private-fixture-token'); } });
      await expect(network(ref)).rejects.toThrow(/^VEHICLE_PHOTO_UNAVAILABLE$/);
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it('cancels a stream that crosses the common 8MiB bound', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    }, cancel });
    const { read } = adapter([metadata({ size: '8388608' }), new Response(body, { headers: { 'content-type': ref.mediaType } })]);
    await expect(read(ref)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
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
    const reader = { read: async () => { throw new Error('unused'); }, readVehiclePhoto: async (_consumer: string, product: string, index?: number) => {
      reads++;
      if (product === 'gone') throw new Error('VEHICLE_PHOTO_NOT_FOUND');
      if (product === 'busy') throw new Error('VEHICLE_PHOTO_BUSY');
      if (product === 'failed') throw new Error('private provider error with credentials');
      return { revalidate: async () => true, count: 2, bytes: index === undefined ? null : Buffer.from([255, 216, 255]), contentType: index === undefined ? 'application/json' : 'image/jpeg' };
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
    expect(logs.events.at(-1)).toMatchObject({ operation: 'READ_PRODUCT_PHOTO', phase: 'SUCCEEDED' });
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


describe('approved vehicle photo proxy', () => {
  const bytes = Buffer.from([255, 216, 255, 1, 2, 3]);
  const ref = { driveFileId: 'fake-file', sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/jpeg' as const,
    vehiclePhotoVerifiedBy: 'synthetic-reviewer', vehiclePhotoVerificationMethod: 'synthetic visual review', vehiclePhotoVerifiedAt: '2026-10-10T00:00:00Z',
    role: 'VEHICLE_PHOTO' as const, zone: '차량사진' as const, approvedAt: '2026-10-10T00:00:00Z', vehicleKey: vehiclePhotoKey({ provider_company_code: 'TEST', supplier_vehicle_id: 'vehicle-a' })! };
  const product = () => ({ provider_company_code: 'TEST', supplier_vehicle_id: 'vehicle-a', listable: true, status_kind: '가용', photo_original_refs: [{ ...ref }] });

  it.each(['vehiclePhotoVerifiedBy', 'vehiclePhotoVerificationMethod', 'vehiclePhotoVerifiedAt'])('requires independent content verification: %s', async field => {
    for (const source of ['approved', 'one']) {
      let current: Record<string, unknown> = product();
      const sourceReader = vi.fn(async () => ({ count: 1, bytes, contentType: ref.mediaType }));
      const read = createVehiclePhotoReader(async () => current,
        source === 'one' ? { eligible: () => true, connection: () => 'synthetic-one', read: sourceReader } : undefined,
        sourceReader);
      for (const missing of [undefined, '', '   ']) {
        current = { ...product(), photo_original_refs: [{ ...ref, [field]: missing }] };
        expect(isApprovedVehiclePhotoProduct(current)).toBe(false);
        await expect(read('erp-com', 'synthetic', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
        await expect(read('erp-com', 'synthetic')).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
      }
      expect(sourceReader).not.toHaveBeenCalled();
      current = product();
      expect((await read('erp-com', 'synthetic', 0)).bytes).toEqual(bytes);
      const response = await read('erp-com', 'synthetic');
      current = { ...product(), photo_original_refs: [{ ...ref, [field]: undefined }] };
      expect(await response.revalidate()).toBe(false);
    }
  });

  it.each(['finish', 'error', 'close'])('holds response slots through onSend and releases once on %s', async terminal => {
    const { app } = withAccess(new MemoryDataStore(), [binding], undefined, {
      read: async () => { throw new Error('unused'); },
      readVehiclePhoto: async () => ({ count: 1, bytes, contentType: ref.mediaType, revalidate: async () => true }),
    });
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    let ready!: () => void;
    const eight = new Promise<void>(resolve => { ready = resolve; });
    const responses: import('node:http').ServerResponse[] = [];
    app.addHook('onSend', async (_request, reply, payload) => {
      if (reply.statusCode === 200 && responses.length < 8) {
        responses.push(reply.raw);
        if (responses.length === 8) ready();
        await gate;
      }
      return payload;
    });
    const url = compatUrl + '/products/synthetic/photos/0';
    const pending = Array.from({ length: 8 }, () => app.inject({ url, headers }).then(value => value.statusCode, () => 0));
    try {
      await eight;
      expect((await app.inject({ url, headers })).statusCode).toBe(429);
      if (terminal !== 'finish') {
        // Transport terminal events while payload delivery is still paused.
        responses[0]!.emit(terminal);
        responses[0]!.emit('close');
        expect((await app.inject({ url, headers })).statusCode).toBe(200);
      }
      unblock();
      expect(await Promise.all(pending)).toEqual(terminal === 'finish' ? Array(8).fill(200) : [0, ...Array(7).fill(200)]);
      expect((await app.inject({ url, headers })).statusCode).toBe(200);
    } finally { unblock(); await Promise.all(pending); await app.close(); }
  });

  it('holds all slots until response streams complete', async () => {
    const { app } = withAccess(new MemoryDataStore(), [binding], undefined, {
      read: async () => { throw new Error('unused'); },
      readVehiclePhoto: async () => ({ count: 1, bytes, contentType: ref.mediaType, revalidate: async () => true }),
    });
    const streams: PassThrough[] = [];
    let ready!: () => void;
    const eight = new Promise<void>(resolve => { ready = resolve; });
    app.addHook('onSend', async (_request, reply, payload) => {
      if (reply.statusCode !== 200 || streams.length >= 8) return payload;
      const stream = new PassThrough();
      streams.push(stream);
      if (streams.length === 8) ready();
      return stream;
    });
    const url = compatUrl + '/products/synthetic/photos/0';
    const pending = Array.from({ length: 8 }, () => app.inject({ url, headers }).then(value => value));
    try {
      await eight;
      expect((await app.inject({ url, headers })).statusCode).toBe(429);
      streams.forEach(stream => stream.end(bytes));
      for (const response of await Promise.all(pending)) expect(response.rawPayload).toEqual(bytes);
      expect((await app.inject({ url, headers })).statusCode).toBe(200);
    } finally { streams.forEach(stream => stream.end()); await Promise.all(pending); await app.close(); }
  });

  it('releases response slots after reader and audit errors', async () => {
    let fail = true;
    const { app, logs } = withAccess(new MemoryDataStore(), [binding], undefined, {
      read: async () => { throw new Error('unused'); },
      readVehiclePhoto: async () => {
        if (fail) throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
        return { count: 1, bytes, contentType: ref.mediaType, revalidate: async () => true };
      },
    });
    const url = compatUrl + '/products/synthetic/photos/0';
    try {
      for (let i = 0; i < 9; i++) expect((await app.inject({ url, headers })).statusCode).toBe(503);
      fail = false;
      const append = vi.spyOn(logs, 'appendDataAccessEvent').mockRejectedValue(new Error('synthetic audit error'));
      for (let i = 0; i < 9; i++) expect((await app.inject({ url, headers })).statusCode).toBe(503);
      append.mockRestore();
      expect((await app.inject({ url, headers })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('rejects copied approval refs from another vehicle and derives fallback keys privately', async () => {
    const other = { ...product(), supplier_vehicle_id: 'vehicle-b' };
    expect(isApprovedVehiclePhotoProduct(other)).toBe(false);
    const read = createVehiclePhotoReader(async () => other, undefined, async () => { throw new Error('must not read'); });
    await expect(read('erp-com', 'fake-product', 0)).rejects.toThrow('NOT_FOUND');
    const fallback = { ...product(), supplier_vehicle_id: '', car_number: 'synthetic-plate-token' };
    const key = createHash('sha256').update(JSON.stringify(['plate', 'TEST', fallback.car_number])).digest('hex');
    expect(vehiclePhotoKey(fallback)).toBe(key);
    expect(key).not.toContain(fallback.car_number);
    expect(isApprovedVehiclePhotoProduct({ ...fallback, photo_original_refs: [{ ...ref, vehicleKey: key }] })).toBe(true);
    expect(isApprovedVehiclePhotoProduct({ ...fallback, provider_company_code: 'OTHER', photo_original_refs: [{ ...ref, vehicleKey: key }] })).toBe(false);
    expect(isApprovedVehiclePhotoProduct({ ...fallback, car_number: '' })).toBe(false);
    expect(vehiclePhotoKey({ ...product(), car_number: 'synthetic-plate-token' })).toBe(ref.vehicleKey);
  });

  it.each(['product', 'file', 'both', 'approval', 'vehicle'])('isolates byte cache by %s and verifies its own reader bytes', async change => {
    let current = product(); let calls = 0;
    const read = createVehiclePhotoReader(async () => current, undefined, async () => {
      calls++; return { bytes: calls === 1 ? bytes : Buffer.from('different-source-bytes'), contentType: ref.mediaType };
    });
    await read('erp-com', 'fake-product', 0);
    if (change === 'file' || change === 'both') current.photo_original_refs[0]!.driveFileId = 'fake-other-file';
    if (change === 'approval') current.photo_original_refs[0]!.approvedAt = '2026-10-10T01:00:00Z';
    if (change === 'vehicle') {
      current.supplier_vehicle_id = 'vehicle-b'; current.photo_original_refs[0]!.vehicleKey = vehiclePhotoKey({ provider_company_code: 'TEST', supplier_vehicle_id: 'vehicle-b' })!;
    }
    const id = change === 'product' || change === 'both' ? 'fake-other-product' : 'fake-product';
    await expect(read('erp-com', id, 0)).rejects.toThrow('UNAVAILABLE');
    await expect(read('erp-com', id, 0)).rejects.toThrow('UNAVAILABLE');
    expect(calls).toBe(3);
  });

  it.each(['refs', 'listable', 'file', 'sha256', 'approvedAt', 'vehicleKey'])('returns 404 without caching when %s changes during source read', async change => {
    let current: Record<string, unknown> = product(); let calls = 0;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const readVehiclePhoto = createVehiclePhotoReader(async () => current, undefined, async () => {
      calls++; started(); await gate; return { bytes, contentType: ref.mediaType };
    });
    const { app } = withAccess(new MemoryDataStore(), [binding], undefined, { read: async () => { throw new Error('unused'); }, readVehiclePhoto });
    try {
      const pending = app.inject({ url: compatUrl + '/products/fake-product/photos/0', headers }).then(value => value);
      await ready;
      if (change === 'refs') current = { ...product(), photo_original_refs: [] };
      else if (change === 'listable') current = { ...product(), listable: false };
      else {
        const patch = change === 'file' ? { driveFileId: 'fake-other-file' }
          : change === 'sha256' ? { sha256: 'a'.repeat(64) }
          : change === 'approvedAt' ? { approvedAt: '2026-10-10T01:00:00Z' }
          : { vehicleKey: vehiclePhotoKey({ provider_company_code: 'TEST', supplier_vehicle_id: 'vehicle-b' })! };
        current = { ...product(), ...(change === 'vehicleKey' ? { supplier_vehicle_id: 'vehicle-b' } : {}), photo_original_refs: [{ ...ref, ...patch }] };
      }
      release();
      expect((await pending).statusCode).toBe(404);
      current = product();
      expect((await readVehiclePhoto('erp-com', 'fake-product', 0)).bytes).toEqual(bytes);
      expect(calls).toBe(2);
    } finally { release(); await app.close(); }
  });

  it.each(['count', 'bytes', 'cached'])('revalidates %s after delayed success audit and records denial on revocation', async mode => {
    let current = product();
    const readVehiclePhoto = createVehiclePhotoReader(async () => current, undefined, async () => ({ bytes, contentType: ref.mediaType }));
    if (mode === 'cached') await readVehiclePhoto('erp-com', 'synthetic', 0);
    const logs = new MemoryDataAccessLogStore();
    const append = logs.appendDataAccessEvent.bind(logs);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(logs, 'appendDataAccessEvent').mockImplementation(async event => {
      await append(event);
      if (event.phase === 'SUCCEEDED') { started(); await gate; }
    });
    const app = createConsumerGateway(new MemoryDataStore(), [binding], new DataAccessGateway(logs), undefined,
      { read: async () => { throw new Error('unused'); }, readVehiclePhoto });
    const url = compatUrl + '/products/synthetic/photos' + (mode === 'count' ? '' : '/0');
    try {
      const pending = app.inject({ url, headers }).then(value => value);
      await ready;
      current = { ...product(), listable: false };
      release();
      const denied = await pending;
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toEqual({ code: 'VEHICLE_PHOTO_NOT_FOUND' });
      expect(logs.events.slice(-2).map(event => event.phase)).toEqual(['SUCCEEDED', 'DENIED']);
      expect(logs.events.at(-1)?.reasonCode).toBe('VEHICLE_PHOTO_NOT_FOUND');
      current = product();
      const normal = await app.inject({ url, headers });
      expect(normal.statusCode).toBe(200);
      if (mode === 'count') expect(normal.json().count).toBe(1);
      else expect(normal.rawPayload).toEqual(bytes);
    } finally { release(); await app.close(); }
  });

  it('shares count slots with byte reads and releases them after success or failure', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    const eight = new Promise<void>(resolve => { ready = resolve; });
    let fail = false;
    const readVehiclePhoto = createVehiclePhotoReader(async () => ({ ...product(), eligible: true }), {
      eligible: value => value?.eligible === true,
      connection: () => 'synthetic-connection',
      read: async (_product, index) => {
        if (++started === 8) ready();
        await gate;
        if (fail) throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
        return { count: 1, bytes: index === undefined ? null : bytes, contentType: ref.mediaType };
      },
    });
    const { app } = withAccess(new MemoryDataStore(), [binding], undefined,
      { read: async () => { throw new Error('unused'); }, readVehiclePhoto });
    const url = compatUrl + '/products/synthetic/photos';
    try {
      const pending = Array.from({ length: 8 }, () => app.inject({ url, headers }).then(value => value));
      await eight;
      for (const suffix of ['', '/0']) {
        const ninth = await app.inject({ url: url + suffix, headers });
        expect(ninth.statusCode).toBe(429);
        expect(ninth.json().code).toBe('VEHICLE_PHOTO_BUSY');
        expect(ninth.headers['retry-after']).toBe('2');
      }
      expect(started).toBe(8);
      release();
      for (const response of await Promise.all(pending)) expect(response.statusCode).toBe(200);
      fail = true;
      for (let i = 0; i < 9; i++) await expect(readVehiclePhoto('erp-com', 'synthetic')).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
      fail = false;
      expect((await app.inject({ url, headers })).statusCode).toBe(200);
    } finally { release(); await app.close(); }
  });

  it('rejects the entire product when any reference or eligibility field is invalid', () => {
    expect(isApprovedVehiclePhotoProduct(product())).toBe(true);
    for (const patch of [{ role: 'DOCUMENT' }, { role: 'doc_images' }, { zone: '원문' }, { zone: 'doc_images' },
      { sha256: ref.sha256.toUpperCase() }, { sha256: 'bad' }, { driveFileId: 'https://example.invalid/file' },
      { driveFileId: '../doc_images' }, { vehicleKey: '' }, { approvedAt: '2026-02-30T00:00:00Z' }, { mediaType: 'text/html' }]) {
      expect(isApprovedVehiclePhotoProduct({ ...product(), photo_original_refs: [ref, { ...ref, ...patch }] })).toBe(false);
    }
    for (const patch of [{ listable: false }, { _deleted: true }, { deletedAt: 'fake' }, { publication_withdrawal: {} },
      { status_kind: 'unavailable' }, { photo_original_refs: [] }, { photo_original_refs: Array(201).fill(ref) }]) {
      expect(isApprovedVehiclePhotoProduct({ ...product(), ...patch })).toBe(false);
    }
  });

  it('serves approved bytes/count and rechecks revocation before cache on every request', async () => {
    let current: Record<string, unknown> = product(); let calls = 0; let reads = 0;
    const read = createVehiclePhotoReader(async () => { reads++; return current; }, undefined, async () => { calls++; return { bytes, contentType: ref.mediaType }; });
    expect((await read('erp-com', 'fake-product')).count).toBe(1);
    expect((await read('erp-com', 'fake-product', 0)).bytes).toEqual(bytes);
    await read('erp-com', 'fake-product', 0); expect(calls).toBe(1);
    current = { ...product(), photo_original_refs: [] };
    await expect(read('erp-com', 'fake-product', 0)).rejects.toThrow('NOT_FOUND');
    current = { ...product(), listable: false };
    await expect(read('erp-com', 'fake-product', 0)).rejects.toThrow('NOT_FOUND');
    expect(reads).toBe(8); expect(calls).toBe(1);
  });

  it.each(['count', 'cached'])('rechecks approval immediately before returning %s responses', async mode => {
    let reads = 0; let calls = 0; let revokeAt = Infinity;
    const read = createVehiclePhotoReader(async () => {
      reads++; return reads >= revokeAt ? { ...product(), listable: false } : product();
    }, undefined, async () => { calls++; return { bytes, contentType: ref.mediaType }; });
    if (mode === 'cached') await read('erp-com', 'fake-product', 0);
    revokeAt = reads + 2;
    await expect(read('erp-com', 'fake-product', mode === 'count' ? undefined : 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    expect(calls).toBe(mode === 'cached' ? 1 : 0);
  });

  it('never caches invalid hashes, oversized bytes or mismatched media', async () => {
    for (const result of [{ bytes: Buffer.from('wrong'), contentType: ref.mediaType },
      { bytes, contentType: 'image/png' }, { bytes: Buffer.alloc(8 * 1024 * 1024 + 1), contentType: ref.mediaType }]) {
      let calls = 0;
      const read = createVehiclePhotoReader(async () => product(), undefined, async () => { calls++; return result; });
      await expect(read('erp-com', 'fake-product', 0)).rejects.toThrow('UNAVAILABLE');
      await expect(read('erp-com', 'fake-product', 0)).rejects.toThrow('UNAVAILABLE');
      expect(calls).toBe(2);
    }
  });

  it('expires cache and does not let callers mutate cached bytes', async () => {
    let now = 0; let calls = 0;
    const read = createVehiclePhotoReader(async () => product(), undefined, async () => { calls++; return { bytes, contentType: ref.mediaType }; }, () => now);
    (await read('erp-com', 'fake-product', 0)).bytes!.fill(0);
    expect((await read('erp-com', 'fake-product', 0)).bytes).toEqual(bytes);
    now = VEHICLE_PHOTO_CACHE_TTL_MS;
    await read('erp-com', 'fake-product', 0); expect(calls).toBe(2);
  });

  it('retains authentication, audit and rejects the ninth concurrent read with Retry-After', async () => {
    let started = 0;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void; const eight = new Promise<void>(resolve => { ready = resolve; });
    const readVehiclePhoto = createVehiclePhotoReader(async () => product(), undefined, async () => {
      if (++started === 8) ready(); await gate; return { bytes, contentType: ref.mediaType };
    });
    const reader = { read: async () => { throw new Error('unused'); }, readVehiclePhoto };
    const { app, logs } = withAccess(new MemoryDataStore(), [binding], undefined, reader);
    const photoUrl = compatUrl + '/products/fake-product/photos/0';
    expect((await app.inject({ url: photoUrl })).statusCode).toBe(401);
    const requests = Array.from({ length: 8 }, () => app.inject({ url: photoUrl, headers }).then(r => r));
    await eight;
    const ninth = await app.inject({ url: photoUrl, headers });
    expect(ninth.statusCode).toBe(429); expect(ninth.headers['retry-after']).toBe('2');
    release();
    for (const result of await Promise.all(requests)) { expect(result.statusCode).toBe(200); expect(result.rawPayload).toEqual(bytes); }
    expect(logs.events.at(-1)).toMatchObject({ operation: 'READ_PRODUCT_PHOTO', phase: 'SUCCEEDED', resource: { name: 'vehicle-product-photo', entityId: 'fake-product' } });
    const count = await app.inject({ url: compatUrl + '/products/fake-product/photos', headers });
    expect(count.json().count).toBe(1); expect(count.body).not.toContain('fake-file');
    await app.close();
    const forbidden = withAccess(new MemoryDataStore(), [{ id: 'internal-ai-test', projectionId: 'erp-public', token, capabilities: ['internal-ai-reference'] }], undefined, reader);
    expect((await forbidden.app.inject({ url: '/v1/consumers/internal-ai-test/catalog-compat/products/fake-product/photos/0', headers })).statusCode).toBe(403);
    await forbidden.app.close();
  });

  it('evicts least recently used bytes at the 64 MiB cap', async () => {
    const buffers = Array.from({ length: 9 }, (_, i) => Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(8 * 1024 * 1024 - 3, i)]));
    const refs = buffers.map((value, i) => ({ ...ref, driveFileId: `fake-file-${i}`, sha256: createHash('sha256').update(value).digest('hex') }));
    let calls = 0;
    const read = createVehiclePhotoReader(async () => ({ ...product(), photo_original_refs: refs }), undefined, async value => {
      calls++; return { bytes: buffers[refs.findIndex(item => item.sha256 === value.sha256)]!, contentType: ref.mediaType };
    });
    for (let i = 0; i < 8; i++) await read('erp-com', 'fake-product', i);
    await read('erp-com', 'fake-product', 0);
    await read('erp-com', 'fake-product', 8);
    expect(calls).toBe(9);
    await read('erp-com', 'fake-product', 0); expect(calls).toBe(9);
    await read('erp-com', 'fake-product', 1); expect(calls).toBe(10);
  });

  it('returns 503 when the approved byte port is disconnected', async () => {
    const readVehiclePhoto = createVehiclePhotoReader(async () => product());
    const { app } = withAccess(new MemoryDataStore(), [binding], undefined, { read: async () => { throw new Error('unused'); }, readVehiclePhoto });
    const result = await app.inject({ url: compatUrl + '/products/fake-product/photos/0', headers });
    expect(result.statusCode).toBe(503); expect(result.json().code).toBe('VEHICLE_PHOTO_READER_UNAVAILABLE');
    await app.close();
  });
});


describe('photo request budgets and opaque keys', () => {
  it('hashes tagged tuples without delimiter or source collisions', () => {
    const key = (supplier: string, id: string) => vehiclePhotoKey({ provider_company_code: supplier, supplier_vehicle_id: id });
    expect(key('A_B', 'C')).not.toBe(key('A', 'B_C'));
    expect(key('A__', 'B')).not.toBe(key('A_', '_B'));
    expect(key('A_B', 'C')).toBe(key('A_B', 'C'));
    expect(key('A', 'B')).not.toBe(vehiclePhotoKey({ provider_company_code: 'A', car_number: 'B' }));
    expect(key('A', 'B')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refills by injected clock, isolates keys and bounds memory without evicting active budgets', () => {
    let now = 0;
    const bucket = createPhotoRequestBucket({ capacity: 1, refillPerSecond: 1 }, () => now);
    expect(bucket.take('a')).toBe(0); expect(bucket.take('a')).toBe(1); expect(bucket.take('b')).toBe(0);
    now = 1000; expect(bucket.take('a')).toBe(0);
    now = 500; expect(bucket.take('a')).toBe(1);
    for (let i = 2; i < PHOTO_REQUEST_LIMITS.maxKeys; i++) bucket.take(String(i));
    expect(bucket.size).toBe(PHOTO_REQUEST_LIMITS.maxKeys);
    expect(bucket.take('overflow')).toBeGreaterThan(0); expect(bucket.take('a')).toBeGreaterThan(0);
    expect(bucket.take('x'.repeat(201))).toBeGreaterThan(0);
    now = PHOTO_REQUEST_LIMITS.idleMs + 1000;
    expect(bucket.take('fresh')).toBe(0); expect(bucket.size).toBe(1);
  });

  it.each([[undefined, '0'], ['0', '0'], ['0', '3']])('limits only failed tokens and ignores spoofed forwarding with photo hops=%s public hops=%s', async (hops, publicHops) => {
    vi.stubEnv('FREEPASS_PUBLIC_TRUST_PROXY_HOPS', publicHops);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    vi.stubEnv('FREEPASS_DATA_TRUST_PROXY_HOPS', hops);
    const reader = { read: async () => { throw new Error('unused'); }, readVehiclePhoto: async () => ({ count: 0, bytes: null, contentType: 'application/json', revalidate: async () => true }) };
    const { app, logs } = withAccess(new MemoryDataStore(), [binding], undefined, reader);
    const url = compatUrl + '/products/synthetic/photos';
    for (let i = 0; i < PHOTO_REQUEST_LIMITS.failedAuth.capacity; i++)
      expect((await app.inject({ url, headers: { authorization: 'Bearer wrong' }, remoteAddress: '192.0.2.1' })).statusCode).toBe(401);
    const before = logs.events.length;
    const denied = await app.inject({ url, headers: { authorization: 'Bearer wrong' }, remoteAddress: '192.0.2.1' });
    expect(denied.statusCode).toBe(429); expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
    expect(logs.events.length).toBe(before);
    expect((await app.inject({ url, headers, remoteAddress: '192.0.2.1' })).statusCode).toBe(200);
    expect((await app.inject({ url, headers: { authorization: 'Bearer wrong', 'x-forwarded-for': '198.51.100.1' }, remoteAddress: '192.0.2.1' })).statusCode).toBe(429);
    expect((await app.inject({ url, remoteAddress: '192.0.2.2' })).statusCode).toBe(401);
    await app.close(); clock.mockRestore(); vi.unstubAllEnvs();
  });

  it.each(['1', '2', '3'])('uses only the configured trusted proxy boundary at hops=%s', async hops => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    vi.stubEnv('FREEPASS_DATA_TRUST_PROXY_HOPS', hops);
    const { app } = withAccess(new MemoryDataStore(), [binding]);
    const url = compatUrl + '/products/synthetic/photos';
    const forwarded = (client: string, spoof: string) => [spoof, client,
      ...Array.from({ length: Number(hops) - 1 }, (_, i) => `192.0.2.${i + 10}`)].join(', ');
    try {
      for (let i = 0; i < PHOTO_REQUEST_LIMITS.failedAuth.capacity; i++)
        expect((await app.inject({ url, remoteAddress: '192.0.2.1', headers: { 'x-forwarded-for': forwarded('198.51.100.1', '203.0.113.1') } })).statusCode).toBe(401);
      expect((await app.inject({ url, remoteAddress: '192.0.2.1', headers: { 'x-forwarded-for': forwarded('198.51.100.1', '203.0.113.2') } })).statusCode).toBe(429);
      expect((await app.inject({ url, remoteAddress: '192.0.2.1', headers: { 'x-forwarded-for': forwarded('198.51.100.2', '203.0.113.1') } })).statusCode).toBe(401);
    } finally { await app.close(); clock.mockRestore(); vi.unstubAllEnvs(); }
  });

  it.each(['0', '1'])('keeps public proxy trust at %s when photo trust is three hops', async publicHops => {
    vi.stubEnv('FREEPASS_DATA_TRUST_PROXY_HOPS', '3');
    vi.stubEnv('FREEPASS_PUBLIC_TRUST_PROXY_HOPS', publicHops);
    const { app } = withAccess(new MemoryDataStore(), [binding]);
    try {
      let response;
      for (let i = 0; i < 121; i++) {
        const forwarded = publicHops === '0' ? `198.51.100.${i}` : `198.51.100.${i}, 203.0.113.10`;
        response = await app.inject({ url: '/v1/public/catalog/feed', remoteAddress: '192.0.2.250', headers: { 'x-forwarded-for': forwarded } });
      }
      expect(response!.statusCode).toBe(429);
    } finally { await app.close(); vi.unstubAllEnvs(); }
  });

  it.each(['-1', '4', '1.5', 'true', '', '01'])('rejects invalid trusted proxy hops %s', value => {
    vi.stubEnv('FREEPASS_DATA_TRUST_PROXY_HOPS', value);
    try { expect(() => withAccess(new MemoryDataStore(), [binding])).toThrow('FREEPASS_DATA_TRUST_PROXY_HOPS_INVALID'); }
    finally { vi.unstubAllEnvs(); }
  });

  it('shares authenticated consumer budgets across IPs but not consumers', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    let reads = 0;
    const reader = { read: async () => { throw new Error('unused'); }, readVehiclePhoto: async () => { reads++; return { count: 0, bytes: null, contentType: 'application/json', revalidate: async () => true }; } };
    const { app } = withAccess(new MemoryDataStore(), [binding, { ...binding, id: 'whitelabel-test', token: 'different-test-token-12345678901234567890' }], undefined, reader);
    const url = compatUrl + '/products/synthetic/photos';
    for (let i = 0; i < PHOTO_REQUEST_LIMITS.consumer.capacity; i++)
      expect((await app.inject({ url, headers, remoteAddress: `192.0.2.${i + 1}` })).statusCode).toBe(200);
    const denied = await app.inject({ url, headers, remoteAddress: '192.0.2.200' });
    expect(denied.statusCode).toBe(429); expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
    expect(reads).toBe(PHOTO_REQUEST_LIMITS.consumer.capacity);
    expect((await app.inject({ url: url.replace('erp-com', 'whitelabel-test'), headers: { authorization: 'Bearer different-test-token-12345678901234567890' } })).statusCode).toBe(200);
    await app.close(); clock.mockRestore();
  });
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

describe('authenticated collected source scope', () => {
  it.each(['kakao-ops', 'internal-ai-fixture'])('requires explicit %s scope grant before source reads and keeps default scope unchanged', async consumerId => {
    const internal = consumerId.startsWith('internal-ai-');
    const source = { consumerId, sourceScope: 'COLLECTED' as const, observedAt: '2026-10-10T00:00:00Z', products: {
      listed: { listable: true, provider_company_code: 'TEMP', provider_name: 'Fixture', car_number: '123가4567', price: { '36': { rent: 500000, deposit: null } } },
      hidden: { listable: false, provider_company_code: 'TEMP', provider_name: 'Fixture', car_number: '123가4567', price: null },
    } };
    const readSource = vi.fn(async () => source);
    const reader = { read: async () => { throw new Error('unused'); }, readKakaoReferenceSource: readSource, readInternalAiReferenceSource: readSource };
    const registration: ConsumerBinding = { id: consumerId, projectionId: 'erp-public', token, capabilities: [internal ? 'internal-ai-reference' : 'catalog-reference'] };
    const endpoint = `/v1/consumers/${consumerId}/${internal ? 'internal-ai-reference' : 'catalog-reference'}`;
    for (const granted of [false, true]) {
      const { app, logs } = withAccess(new MemoryDataStore(), [{ ...registration, ...(granted ? { referenceSourceScopes: ['COLLECTED' as const] } : {}) }], undefined, reader);
      try {
        readSource.mockClear();
        const collected = await app.inject({ url: endpoint + '?sourceScope=COLLECTED&plateNumber=123가4567', headers });
        expect(collected.statusCode).toBe(granted ? 200 : 403);
        if (!granted) {
          expect(collected.json()).toEqual({ code: 'REFERENCE_SOURCE_SCOPE_FORBIDDEN' });
          expect(readSource).not.toHaveBeenCalled();
          expect(logs.events.at(-1)?.phase).toBe('DENIED');
        } else {
          expect(collected.json().data.map((p: { sourceProductId: string }) => p.sourceProductId)).toEqual(['hidden', 'listed']);
          expect(collected.json().data[0].sourceRecord).toMatchObject({ listable: false, conditionState: 'HOLD', reasonCode: 'SOURCE_PRICE_CONDITIONS_MISSING' });
          expect(collected.json().meta).toMatchObject({ authority: 'REFERENCE_ONLY', publicationDecision: 'HOLD', queryResolution: { state: 'HOLD' } });
        }
        const normal = await app.inject({ url: endpoint, headers });
        expect(normal.statusCode).toBe(200);
        expect(normal.json().data.map((p: { sourceProductId: string }) => p.sourceProductId)).toEqual(['listed']);
        expect(normal.json().data[0]).not.toHaveProperty('sourceRecord');
        readSource.mockClear();
        expect((await app.inject({ url: endpoint + '?sourceScope=UNKNOWN', headers })).statusCode).toBe(400);
        expect((await app.inject({ url: endpoint + '?sourceScope=COLLECTED&sourceScope=LISTABLE', headers })).statusCode).toBe(400);
        expect((await app.inject({ url: endpoint + '?sourceScope=COLLECTED', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
        expect(readSource).not.toHaveBeenCalled();
      } finally { await app.close(); }
    }
  });
  it('does not allow a public registration to request collected grants or unsupported/duplicate scope grants', () => {
    for (const scopes of [['COLLECTED'], [], ['COLLECTED', 'COLLECTED'], ['LISTABLE'], 'COLLECTED']) {
      expect(() => parseConsumerBindings(JSON.stringify([{ ...binding, referenceSourceScopes: scopes }]))).toThrow();
    }
    expect(parseConsumerBindings(JSON.stringify([{ id: 'kakao-ops', projectionId: 'erp-public', token, capabilities: ['catalog-reference'], referenceSourceScopes: ['COLLECTED'] }]))[0]).toMatchObject({ referenceSourceScopes: ['COLLECTED'] });
  });
});
