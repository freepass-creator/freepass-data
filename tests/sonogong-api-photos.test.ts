import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields, apiPhotoFields } from '../src/infra/source-cycle-firestore.js';
import { planSourceCycle, applySourceCycle } from '../src/application/source-cycle.js';
import { compactRaw, compactRecord, type SourceProductRecord } from '../src/domain/source-engine.js';
import { sonogongPhotoUrls, SONOGONG_PHOTO_POLICY } from '../src/adapters/sonogong-api.js';
import { buildPublicProductQuote, buildPublicProductFeed } from '../src/api/public-product-feed.js';
import type { CatalogCompatibilitySnapshot } from '../src/infra/erp5-compat-catalog-reader.js';

// 대표 2026-10-15 «손오공은 API 연동을 해야지» — 손오공(RP012) 사진은 API 주소 그대로(10-14 «URL 그대로 노출») image_urls 로. 값은 전부 합성.
const time = '2026-10-15T01:00:00.000Z', now = Date.parse('2026-10-15T01:05:00.000Z'), source = 'RP012';
const A = 'https://img.example.invalid/car/a.jpg', B = 'https://img.example.invalid/car/b.jpg', C = 'https://img.example.invalid/car/c.jpg';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const rec = (plate: string, images: string[], rent = 500000): SourceProductRecord => ({ sourceId: source, uid: plate, plate, vehicleText: '합성 차명',
  status: { raw: '출고가능', saleAvailable: true }, observedAt: time, vehicleHold: [],
  raw: { source: 'sonogong-partner-api', product_type: '중고렌트', images },
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: rent }, deposit: { state: 'ZERO', value: 0 }, mileage: null, raw: { priceType: 'RENT_RETURN' } }] });

function fakeFirestore() {
  const docs = new Map<string, any>(); let version = 0; let patches = 0;
  const doc = (uid: string, fields: any) => ({ name: `projects/synthetic-test/databases/(default)/documents/products/${uid}`, updateTime: `${time}:${++version}`, fields });
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), uid = decodeURIComponent(url.pathname.split('/').at(-1)!);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (!init.method || init.method === 'GET') {
      let result: any = uid === 'products' ? { documents: [...docs.values()] } : docs.get(uid);
      if (!result) return new Response('{}', { status: 404 });
      result = structuredClone(result);
      const masked = url.searchParams.getAll('mask.fieldPaths').map(p => p.replace(/`/g, ''));
      if (uid === 'products' && masked.length) for (const d of result.documents) d.fields = Object.fromEntries(Object.entries(d.fields ?? {}).filter(([k]) => masked.includes(k)));
      return Response.json(result);
    }
    const current = docs.get(uid);
    if (url.searchParams.get('currentDocument.exists') === 'false' ? !!current : current?.updateTime !== url.searchParams.get('currentDocument.updateTime')) return new Response('{}', { status: 412 });
    patches++;
    const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
    const after = doc(uid, fields); docs.set(uid, after); return Response.json(after);
  }) as unknown as typeof fetch;
  return { docs, fetcher, put: (uid: string, f: Record<string, unknown>) => docs.set(uid, doc(uid, encodeFields(f as never))), patches: () => patches };
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'sonogong-photos-')); dirs.push(dir);
  const fake = fakeFirestore();
  const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
    supplierDefaults: { RP012: { provider_name: '합성손오공', policy_code: 'SYNTHETIC_POLICY' } } });
  return { commands, fake };
}
const run = async (commands: Awaited<ReturnType<typeof setup>>['commands'], records: SourceProductRecord[]) => {
  const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records, observedAt: time, heldCount: 0, complete: true },
    await commands.list(source), now);
  const applied = built.plan.entries.length ? await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now }) : null;
  return { kinds: built.plan.entries.map(e => e.kind), applied };
};
/** 옛 엔진이 저장한 문서: source_cycle_record.raw.images 가 digest(이번 변경 전 형태). 사진 칸 없음. */
const legacyDoc = (r: SourceProductRecord, extra: Record<string, unknown> = {}) => {
  const fields = nativeCycleFields({ record: compactRecord(r), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null },
    { car_number: r.plate, provider_company_code: source, provider_name: '합성손오공' });
  delete fields.image_urls; delete fields.image_url;
  return { provider_name: '합성손오공', ...fields, source_cycle_record: { ...compactRecord(r), raw: compactRaw(r.raw) }, ...extra };
};

describe('손오공 API 사진 주소 목록(어댑터)', () => {
  it('detail images first (source order, deduped, https only), list thumbnail only as fallback, max 20', () => {
    const detail = { images: [{ url: A }, { url: 'http://img.example.invalid/x.jpg' }, { url: B }, { url: A }, { url: 'https://u:p@img.example.invalid/y.jpg' }, { url: 'nope' }] };
    expect(sonogongPhotoUrls(detail, { thumbnailUrl: C })).toEqual([A, B]);
    expect(sonogongPhotoUrls(null, { images: [{ url: B }], thumbnailUrl: C })).toEqual([B]);   // 상세가 없으면 목록 images
    expect(sonogongPhotoUrls({ images: [] }, { thumbnailUrl: C })).toEqual([C]);              // 사진이 없으면 목록 썸네일
    expect(sonogongPhotoUrls({ images: [] }, { thumbnailUrl: null })).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => ({ url: `https://img.example.invalid/car/${i}.jpg` }));
    expect(sonogongPhotoUrls({ images: many }, {})).toHaveLength(SONOGONG_PHOTO_POLICY.maxPhotos);
    expect(SONOGONG_PHOTO_POLICY.maxPhotos).toBe(20);
  });
});

describe('손오공 API 사진 → image_urls(원천 엔진 쓰기)', () => {
  it('a new document gets image_urls (and image_url = first photo)', async () => {
    const { commands, fake } = await setup();
    const { kinds, applied } = await run(commands, [rec('12가1001', [A, B])]);
    expect(kinds).toEqual(['ENROLL']);
    expect(applied).toMatchObject({ status: 'APPLIED' });
    expect(decodeFields(fake.docs.get('12가1001').fields)).toMatchObject({ image_urls: [A, B], image_url: A });
  });

  it('an unchanged photo list against a digest-form stored record → no UPDATE (no mass rewrite)', async () => {
    const { commands, fake } = await setup();
    fake.put('12가1002', legacyDoc(rec('12가1002', [A, B]), { image_urls: ['https://legacy.example.invalid/old.jpg'] }));
    expect((await run(commands, [rec('12가1002', [A, B])])).kinds).toEqual([]);
    expect(fake.patches()).toBe(0);
    // 새 형태(실제 목록)로 저장된 문서도 같다.
    const { commands: c2, fake: f2 } = await setup();
    await run(c2, [rec('12가1003', [A, B])]);
    const before = f2.patches();
    expect((await run(c2, [rec('12가1003', [A, B])])).kinds).toEqual([]);
    expect(f2.patches()).toBe(before);
  });

  it('a changed photo list → UPDATE writes the new image_urls', async () => {
    const { commands, fake } = await setup();
    await run(commands, [rec('12가1004', [A, B])]);
    expect((await run(commands, [rec('12가1004', [C, A])])).kinds).toEqual(['UPDATE']);
    expect(decodeFields(fake.docs.get('12가1004').fields)).toMatchObject({ image_urls: [C, A], image_url: C });
  });

  it('an existing document without any photo gets the API photos once (PHOTO_URLS), then stays unchanged', async () => {
    const { commands, fake } = await setup();
    fake.put('12가1005', legacyDoc(rec('12가1005', [A, B])));
    expect((await run(commands, [rec('12가1005', [A, B])])).kinds).toEqual(['UPDATE']);
    expect(decodeFields(fake.docs.get('12가1005').fields)).toMatchObject({ image_urls: [A, B], image_url: A });
    expect((await run(commands, [rec('12가1005', [A, B])])).kinds).toEqual([]);
    // 원천도 사진이 없는(빈 목록 digest) 사진 없는 문서는 다시 쓰지 않는다.
    fake.put('12가1006', legacyDoc(rec('12가1006', [])));
    expect((await run(commands, [rec('12가1005', [A, B]), rec('12가1006', [])])).kinds).toEqual([]);
  });

  it('a document with approved/human photos (photo_original_refs or photo_cache) is never touched', async () => {
    const { commands, fake } = await setup();
    fake.put('12가1007', legacyDoc(rec('12가1007', [A]), { photo_original_refs: [{ driveFileId: 'synthetic' }] }));
    fake.put('12가1008', legacyDoc(rec('12가1008', [A]), { photo_cache: { src: 'synthetic', urls: ['https://drive.example.invalid/t.jpg'] } }));
    expect((await run(commands, [rec('12가1007', [A]), rec('12가1008', [A])])).kinds).toEqual([]);   // PHOTO_URLS 사유 없음
    // 가격이 바뀌어 다시 쓰여도 사진 칸은 건드리지 않는다.
    expect((await run(commands, [rec('12가1007', [B], 510000), rec('12가1008', [B], 510000)])).kinds).toEqual(['UPDATE', 'UPDATE']);
    expect(decodeFields(fake.docs.get('12가1007').fields)).not.toHaveProperty('image_urls');
    expect(decodeFields(fake.docs.get('12가1008').fields)).not.toHaveProperty('image_urls');
  });

  it('an empty API list does not erase existing image_urls (UNKNOWN never overwrites)', async () => {
    const { commands, fake } = await setup();
    await run(commands, [rec('12가1009', [A])]);
    expect((await run(commands, [rec('12가1009', [], 520000)])).kinds).toEqual(['UPDATE']);
    expect(decodeFields(fake.docs.get('12가1009').fields)).toMatchObject({ image_urls: [A], image_url: A, price: { 36: { rent: 520000 } } });
    expect(apiPhotoFields(rec('12가1009', []), {})).toEqual({});
  });

  it('other sources keep the digest form and never get image_urls from this path', () => {
    const iron = { ...rec('12가1010', [A]), sourceId: 'RP006' };
    expect(compactRecord(iron).raw.images).toHaveProperty('__digest');
    expect(apiPhotoFields(compactRecord(iron), {})).toEqual({});
  });
});

describe('소비처 catalog 읽기 경로', () => {
  it('the public catalog shows the written image_urls for an RP012 product', async () => {
    const { commands, fake } = await setup();
    await run(commands, [rec('12가1011', [A, B])]);
    const product = { ...decodeFields(fake.docs.get('12가1011').fields), _key: 'P1', product_code: 'P1' };
    const snapshot = { schema: 'freepass-data.catalog-compat/v1', data: { products: { P1: product }, policies: {}, partners: {}, users: {} },
      meta: { consumerId: 'erp-com', authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE', sourceProject: 'freepasserp5', observedAt: time,
        collectionCounts: { products: 1, policy: 0 }, depositEvidenceVersion: 'catalog-compat-deposit/1' } } as unknown as CatalogCompatibilitySnapshot;
    expect(buildPublicProductQuote(snapshot, 'P1', {})?.product).toMatchObject({ image_url: A, image_urls: [A, B] });
    expect(buildPublicProductFeed(snapshot, {}).products[0]).toMatchObject({ image_url: A });   // 목록은 대표 사진만
  });
});
