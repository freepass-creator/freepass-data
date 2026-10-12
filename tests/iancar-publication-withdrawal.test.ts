import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), transaction: vi.fn(), update: vi.fn(), collections: [] as string[],
  mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn(), getApp: vi.fn(), getAll: vi.fn(), save: vi.fn(), download: vi.fn() }));
vi.mock('firebase-admin/firestore', async importOriginal => ({ ...(await importOriginal<typeof import('firebase-admin/firestore')>()), getFirestore: () => ({
  collection: (name: string) => {
    mocks.collections.push(name);
    return { get: mocks.get, doc: (id: string) => ({ path: `${name}/${id}`, get: mocks.get }), where: (field: string, operator: string, value: string) => {
    expect([name, field, operator, value]).toEqual(['products', 'provider_company_code', '==', 'RP031']);
    return { get: mocks.get };
  } };
  }, doc: (path: string) => ({ path }), runTransaction: mocks.transaction, getAll: mocks.getAll
}) }));
vi.mock('../src/infra/firebase-target.js', () => ({ getTargetFirebaseApp: mocks.getApp, CENTRAL_FIREBASE_PROJECT_ID: 'freepasserp5' }));
vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir, writeFile: mocks.writeFile, readFile: mocks.readFile }));
vi.mock('firebase-admin/storage', () => ({ getStorage: () => ({ bucket: () => ({ file: () => ({ save: mocks.save, download: mocks.download }) }) }) }));
import { withdrawIancarPublication, publishIancarPhotoReferences, publishIancarPhaseOne, restoreIancarPhaseOne, encodeIancarBackupValue, planIancarPhotoReviewPatch, type IancarOnePhotoReview } from '../src/infra/iancar-publication-withdrawal-firestore.js';
import { orderedJsonDigest } from '../src/shared/stable-digest.js';
import { createHash } from 'node:crypto';
import { createVehiclePhotoReader, iancarReviewedContentSetDigest } from '../src/domain/consumer-output-contract.js';

function reviewedAlbum() {
  const observedAt = new Date(Date.now() - 1000).toISOString();
  const original = { provider_company_code: 'RP031', listable: true, status_kind: '가용',
    iancar_one_vehicle_id: 'synthetic-one', car_number: 'synthetic-plate', image_url: 'preserved', price: 123 };
  const row = { productId: 'synthetic-product', vehicleId: 'synthetic-one', plate: 'synthetic-plate', count: 2, observedAt };
  const binding = orderedJsonDigest(['RP031', row.productId, row.vehicleId, row.plate]);
  const upstreamPhotoIds = ['synthetic-a', 'synthetic-b'];
  const servingPhotoIds = [...upstreamPhotoIds].reverse();
  const set = orderedJsonDigest(['ONE_PHOTO_SET/1', binding, upstreamPhotoIds, servingPhotoIds]);
  const review: IancarOnePhotoReview = { upstreamPhotoIds, servingPhotoIds, refs: servingPhotoIds.map((id, index) => ({
    sourceKind: 'IANCAR_ONE', sourceApiVersion: 'iancar-one-api/1', sourceBindingDigest: binding,
    photoSetDigest: set, sourcePhotoIdDigest: orderedJsonDigest(id), sourceOrdinal: upstreamPhotoIds.indexOf(id), servingIndex: index,
    mediaType: 'image/jpeg', photoSha256: 'a'.repeat(64), sourceObservedAt: observedAt,
    vehiclePhotoVerifiedBy: 'synthetic-reviewer', vehiclePhotoVerificationMethod: 'ONE 차량사진 전용 확인; 범위=synthetic album; 방법=synthetic manual fixture; 근거=synthetic private fixture',
    vehiclePhotoVerifiedAt: observedAt,
  })) };
  return { original, row, review };
}

function contentReviewedAlbum() {
  const fixture = reviewedAlbum();
  fixture.review.basis = 'CONTENT_ORDINAL/1';
  fixture.review.sourceRepresentatives = [false, true];
  const bytes = Buffer.from([255, 216, 255, 1]);
  fixture.review.refs.forEach(ref => {
    ref.reviewBasis = 'CONTENT_ORDINAL/1'; ref.representative = fixture.review.sourceRepresentatives![ref.sourceOrdinal]!;
    ref.photoSha256 = createHash('sha256').update(bytes).digest('hex');
  });
  const set = iancarReviewedContentSetDigest(fixture.review.refs[0]!.sourceBindingDigest, fixture.review.refs);
  fixture.review.refs.forEach(ref => { ref.photoSetDigest = set; });
  return { ...fixture, bytes };
}

it('content review keeps opaque capture handles as evidence and preserves legacy live-ID fields', () => {
  const { original, row, review } = contentReviewedAlbum();
  const patch = planIancarPhotoReviewPatch({ ...original, iancar_one_photo_ids: ['preserved-live-handle'] }, row, review);
  expect(Object.keys(patch).sort()).toEqual(['photo_original_refs', 'provider_company_code']);
  expect(review.refs[0]!.sourcePhotoIdDigest).toBe(orderedJsonDigest('synthetic-b'));
});
it('content review without retained capture handles preserves the exact approved references', () => {
  const { original, row, review } = contentReviewedAlbum();
  const before = structuredClone(review.refs);
  delete review.upstreamPhotoIds; delete review.servingPhotoIds;
  const patch = planIancarPhotoReviewPatch(original, row, review);
  expect(patch.photo_original_refs).toEqual(before);
  expect(Object.keys(patch).sort()).toEqual(['photo_original_refs', 'provider_company_code']);
  expect(review).not.toHaveProperty('upstreamPhotoIds');
  expect(review).not.toHaveProperty('servingPhotoIds');
});
it('the legacy ID-bound review still requires both retained ID arrays', () => {
  const { original, row, review } = reviewedAlbum();
  delete review.upstreamPhotoIds; delete review.servingPhotoIds;
  expect(() => planIancarPhotoReviewPatch(original, row, review)).toThrow('REVIEW_INVALID');
});
it.each(['one-array', 'legacy', 'digest', 'duplicate-digest', 'duplicate-ordinal', 'range', 'serving-order', 'human', 'current-handles'])
  ('absent capture handles do not weaken %s validation', condition => {
    const { original, row, review } = contentReviewedAlbum();
    delete review.upstreamPhotoIds; delete review.servingPhotoIds;
    if (condition === 'one-array') review.upstreamPhotoIds = ['synthetic-a', 'synthetic-b'];
    if (condition === 'legacy') delete review.basis;
    if (condition === 'digest') review.refs[0]!.sourcePhotoIdDigest = '';
    if (condition === 'duplicate-digest') review.refs[0]!.sourcePhotoIdDigest = review.refs[1]!.sourcePhotoIdDigest;
    if (condition === 'duplicate-ordinal') review.refs[0]!.sourceOrdinal = review.refs[1]!.sourceOrdinal;
    if (condition === 'range') review.refs[0]!.sourceOrdinal = 2;
    if (condition === 'serving-order') review.refs.reverse().forEach((ref, index) => { ref.servingIndex = index; });
    if (condition === 'human') review.refs[0]!.vehiclePhotoVerifiedBy = '';
    if (condition === 'current-handles') { review.upstreamPhotoIds = ['current-a', 'current-b']; review.servingPhotoIds = ['current-b', 'current-a']; }
    // Recompute only the set digest to reach geometry/provenance guards rather than a stale envelope.
    const set = iancarReviewedContentSetDigest(review.refs[0]!.sourceBindingDigest, review.refs);
    review.refs.forEach(ref => { ref.photoSetDigest = set; });
    expect(() => planIancarPhotoReviewPatch(original, row, review)).toThrow('REVIEW_INVALID');
  });

it.each(['representative', 'partial-basis', 'content-hash'])('content review rejects %s authority changes', condition => {
  const { original, row, review } = contentReviewedAlbum();
  if (condition === 'representative') review.sourceRepresentatives = [true, false];
  if (condition === 'partial-basis') delete review.refs[0]!.reviewBasis;
  if (condition === 'content-hash') review.refs[0]!.photoSha256 = 'b'.repeat(64);
  expect(() => planIancarPhotoReviewPatch(original, row, review)).toThrow('REVIEW_INVALID');
});

it('content reader accepts rotating access handles only with matching current layout and approved raw bytes', async () => {
  const { original, row, review, bytes } = contentReviewedAlbum();
  const product = { ...original, ...planIancarPhotoReviewPatch(original, row, review) };
  let request = 0;
  const reader = createVehiclePhotoReader(async () => product, { eligible: () => true, connection: () => 'synthetic-binding',
    read: async (_product, index) => {
      const suffix = ++request;
      return { count: 2, photoIds: [`opaque-b-${suffix}`, `opaque-a-${suffix}`],
        upstreamPhotoIds: [`opaque-a-${suffix}`, `opaque-b-${suffix}`], upstreamRepresentatives: [false, true],
        servingSourceOrdinals: [1, 0], bytes: index === undefined ? null : bytes,
        contentType: index === undefined ? 'application/json' : 'image/jpeg' };
    } });
  const image = await reader('erp5-public-media', row.productId, 0);
  expect(image.bytes).toEqual(bytes); expect(await image.revalidate()).toBe(true);
  const count = await reader('erp5-public-media', row.productId);
  expect(count.count).toBe(2); expect(await count.revalidate()).toBe(true);
});

it.each(['count', 'representative', 'layout', 'raw-bytes', 'mixed-basis', 'unknown-basis', 'missing-kind', 'vehicle'])('content reader rejects %s mismatch', async condition => {
  const { original, row, review, bytes } = contentReviewedAlbum();
  const product: Record<string, unknown> = { ...original, ...planIancarPhotoReviewPatch(original, row, review) };
  if (condition === 'mixed-basis') delete (product.photo_original_refs as IancarOnePhotoReview['refs'])[1]!.reviewBasis;
  if (condition === 'unknown-basis') Object.assign((product.photo_original_refs as IancarOnePhotoReview['refs'])[0]!, { reviewBasis: 'UNSUPPORTED' });
  if (condition === 'missing-kind') delete (product.photo_original_refs as Record<string, unknown>[])[0]!.sourceKind;
  if (condition === 'vehicle') product.iancar_one_vehicle_id = 'other-vehicle';
  const reader = createVehiclePhotoReader(async () => product, { eligible: () => true, connection: () => 'synthetic-binding',
    read: async () => ({ count: condition === 'count' ? 1 : 2, photoIds: ['opaque-b', 'opaque-a'], upstreamPhotoIds: ['opaque-a', 'opaque-b'],
      upstreamRepresentatives: condition === 'representative' ? [true, false] : [false, true],
      servingSourceOrdinals: condition === 'layout' ? [0, 1] : [1, 0],
      bytes: condition === 'raw-bytes' ? Buffer.from([255, 216, 255, 2]) : bytes, contentType: 'image/jpeg' }) });
  await expect(reader('erp5-public-media', row.productId, 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
});
it('an unsupported basis cannot fall back to the old ID-bound branch', async () => {
  const { original, row, review } = reviewedAlbum();
  const product: Record<string, unknown> = { ...original, ...planIancarPhotoReviewPatch(original, row, review) };
  (product.photo_original_refs as Record<string, unknown>[]).forEach(ref => { ref.reviewBasis = 'UNSUPPORTED'; });
  const sourceRead = vi.fn();
  const reader = createVehiclePhotoReader(async () => product, { eligible: () => true, connection: () => 'synthetic-binding', read: sourceRead });
  await expect(reader('erp5-public-media', row.productId)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
  expect(sourceRead).not.toHaveBeenCalled();
});

it('content manifest is a layout/count check; a changed nonrepresentative image is still denied by its raw hash', async () => {
  const { original, row, review } = contentReviewedAlbum();
  const product = { ...original, ...planIancarPhotoReviewPatch(original, row, review) };
  const reader = createVehiclePhotoReader(async () => product, { eligible: () => true, connection: () => 'synthetic-binding',
    read: async (_product, index) => ({ count: 2, photoIds: ['opaque-b', 'opaque-a'], upstreamPhotoIds: ['opaque-a', 'opaque-b'],
      upstreamRepresentatives: [false, true], servingSourceOrdinals: [1, 0],
      bytes: index === undefined ? null : Buffer.from([255, 216, 255, 2]), contentType: index === undefined ? 'application/json' : 'image/jpeg' }) });
  const manifest = await reader('erp5-public-media', row.productId);
  expect(manifest.count).toBe(2); expect(await manifest.revalidate()).toBe(true);
  await expect(reader('erp5-public-media', row.productId, 1)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
});

it('review plan binds the exact ordered album and changes approval fields only', () => {
  const { original, row, review } = reviewedAlbum();
  const patch = planIancarPhotoReviewPatch(original, row, review);
  expect(Object.keys(patch).sort()).toEqual(['iancar_one_photo_ids', 'photo_original_refs', 'provider_company_code']);
  expect(patch.iancar_one_photo_ids).toEqual(review.servingPhotoIds);
  expect(original.image_url).toBe('preserved');
  (patch.photo_original_refs as IancarOnePhotoReview['refs'])[0]!.vehiclePhotoVerifiedBy = 'changed';
  expect(review.refs[0]!.vehiclePhotoVerifiedBy).toBe('synthetic-reviewer');
});

it.each(['unreviewed', 'binding', 'set', 'order', 'photo', 'bytes', 'time', 'method', 'drive-field'])('review plan rejects %s without fabricating approval', condition => {
  const { original, row, review } = reviewedAlbum();
  const ref = review.refs[0]!;
  if (condition === 'unreviewed') ref.vehiclePhotoVerifiedBy = '';
  if (condition === 'binding') ref.sourceBindingDigest = 'b'.repeat(64);
  if (condition === 'set') review.upstreamPhotoIds!.reverse();
  if (condition === 'order') ref.servingIndex = 1;
  if (condition === 'photo') review.servingPhotoIds![0] = 'unreviewed-id';
  if (condition === 'bytes') ref.photoSha256 = '';
  if (condition === 'time') ref.vehiclePhotoVerifiedAt = '2026-02-30T00:00:00Z';
  if (condition === 'method') ref.vehiclePhotoVerificationMethod = 'supplier trusted';
  if (condition === 'drive-field') Object.assign(ref, { driveFileId: 'fabricated' });
  expect(() => planIancarPhotoReviewPatch(original, row, review)).toThrow('IANCAR_PHOTO_REVIEW_INVALID');
});

it('verification-only publication remains dry-run until exact digest and preserves existing photo/business fields', async () => {
  const { original, row, review } = reviewedAlbum();
  const snapshot = { ref: { path: 'products/synthetic-product' }, updateTime: { toMillis: () => 1, isEqual: () => true }, data: () => original };
  mocks.getAll.mockResolvedValue([snapshot]);
  const input = { records: [{ ...row, review }], verificationOnly: true, apply: false };
  const plan = await publishIancarPhotoReferences(input);
  expect(mocks.update).not.toHaveBeenCalled();
  await expect(publishIancarPhotoReferences({ ...input, apply: true, expectedPlanDigest: 'wrong' })).rejects.toThrow('PLAN_CHANGED');
  expect(mocks.writeFile).not.toHaveBeenCalled();
  const patch = planIancarPhotoReviewPatch(original, row, review);
  mocks.getAll.mockReset().mockResolvedValueOnce([snapshot]).mockResolvedValueOnce([{ ...snapshot, data: () => ({ ...original, ...patch }) }]);
  mocks.transaction.mockImplementation(async callback => callback({ getAll: async () => [snapshot], update: mocks.update }));
  await expect(publishIancarPhotoReferences({ ...input, apply: true, expectedPlanDigest: plan.planDigest })).resolves.toMatchObject({ writeExecuted: true });
  expect(Object.keys(mocks.update.mock.calls[0]![1]).sort()).toEqual(['iancar_one_photo_ids', 'photo_original_refs', 'provider_company_code']);
  expect(JSON.parse(mocks.writeFile.mock.calls[0]![1]).documents[0].exists).toBe(true);
});
it('captureless content publication uses the same backup/CAS/readback and changes only two fields', async () => {
  const fixture = contentReviewedAlbum();
  const original = { ...fixture.original, iancar_one_photo_ids: ['preserved-live-handle'] };
  const review = fixture.review;
  delete review.upstreamPhotoIds; delete review.servingPhotoIds;
  const patch = planIancarPhotoReviewPatch(original, fixture.row, review);
  const snapshot = { ref: { path: 'products/synthetic-product' }, updateTime: { toMillis: () => 1, isEqual: () => true }, data: () => original };
  mocks.getAll.mockResolvedValue([snapshot]);
  const input = { records: [{ ...fixture.row, review }], verificationOnly: true, apply: false };
  const plan = await publishIancarPhotoReferences(input);
  await expect(publishIancarPhotoReferences({ ...input, apply: true, expectedPlanDigest: 'wrong' })).rejects.toThrow('PLAN_CHANGED');
  expect(mocks.writeFile).not.toHaveBeenCalled();
  mocks.getAll.mockReset().mockResolvedValueOnce([snapshot]).mockResolvedValueOnce([{ ...snapshot, data: () => ({ ...original, ...patch }) }]);
  mocks.transaction.mockImplementation(async callback => callback({ getAll: async () => [snapshot], update: mocks.update }));
  await expect(publishIancarPhotoReferences({ ...input, apply: true, expectedPlanDigest: plan.planDigest })).resolves.toMatchObject({ writeExecuted: true });
  expect(mocks.writeFile).toHaveBeenCalledTimes(1);
  expect(Object.keys(mocks.update.mock.calls[0]![1]).sort()).toEqual(['photo_original_refs', 'provider_company_code']);
  expect(original.iancar_one_photo_ids).toEqual(['preserved-live-handle']);
  expect(original.price).toBe(123);
  expect((mocks.update.mock.calls[0]![1].photo_original_refs as IancarOnePhotoReview['refs'])).toEqual(review.refs);
});

it.each(['absent', 'null', 'empty'])('review rollback restores %s approval representation and preserves unrelated changes', async state => {
  const { original, row, review } = reviewedAlbum();
  const before: Record<string, unknown> = { ...original };
  if (state !== 'absent') before.photo_original_refs = state === 'null' ? null : [];
  const patch = planIancarPhotoReviewPatch(before, row, review);
  const backup = { schema: 'iancar-photo-typed-backup/1', projectId: 'freepasserp5', sourceDigest: 'synthetic-digest',
    documents: [{ path: 'products/synthetic-product', exists: true, data: encodeIancarBackupValue(before), patch: encodeIancarBackupValue(patch) }] };
  mocks.readFile.mockResolvedValue(JSON.stringify(backup));
  const current = { ...before, ...patch, price: 456 };
  mocks.transaction.mockImplementation(async callback => callback({
    getAll: async () => [{ data: () => current }], update: mocks.update,
  }));
  mocks.getAll.mockResolvedValue([{ data: () => ({ ...before, price: 456 }) }]);
  await expect(restoreIancarPhaseOne({ backupPath: 'synthetic-private-backup', apply: true, expectedSourceDigest: 'synthetic-digest' }))
    .resolves.toMatchObject({ status: 'PHOTO_RESTORE_READBACK_VERIFIED' });
  const restoredPatch = mocks.update.mock.calls[0]![1];
  expect(restoredPatch).not.toHaveProperty('price');
  if (state === 'absent') expect(restoredPatch.photo_original_refs).toBeDefined(); // explicit deletion sentinel
  else expect(restoredPatch.photo_original_refs).toEqual(state === 'null' ? null : []);
});

it('review rollback refuses a later owner change to approval', async () => {
  const { original, row, review } = reviewedAlbum();
  const patch = planIancarPhotoReviewPatch(original, row, review);
  const backup = { schema: 'iancar-photo-typed-backup/1', projectId: 'freepasserp5', sourceDigest: 'synthetic-digest',
    documents: [{ path: 'products/synthetic-product', exists: true, data: encodeIancarBackupValue(original), patch: encodeIancarBackupValue(patch) }] };
  mocks.readFile.mockResolvedValue(JSON.stringify(backup));
  mocks.transaction.mockImplementation(async callback => callback({ getAll: async () => [{ data: () => ({
    ...original, ...patch, photo_original_refs: [],
  }) }], update: mocks.update }));
  await expect(restoreIancarPhaseOne({ backupPath: 'synthetic-private-backup', apply: true, expectedSourceDigest: 'synthetic-digest' }))
    .rejects.toThrow('REVISION_CHANGED');
  expect(mocks.update).not.toHaveBeenCalled();
});

it('bound ONE reviews freeze approved bytes and recheck the ordered set before transmission', async () => {
  const { original, row, review } = reviewedAlbum();
  const bytes = Buffer.from([255, 216, 255, 1]);
  review.refs.forEach(ref => { ref.photoSha256 = createHash('sha256').update(bytes).digest('hex'); });
  const product: Record<string, unknown> = { ...original, ...planIancarPhotoReviewPatch(original, row, review) };
  const source = { eligible: () => true, connection: () => 'synthetic-source', read: vi.fn(async (_product, index, fresh) => {
    expect(fresh).toBe(true);
    return { count: 2, photoIds: review.servingPhotoIds!, upstreamPhotoIds: review.upstreamPhotoIds!,
      bytes: index === undefined ? null : bytes, contentType: index === undefined ? 'application/json' : 'image/jpeg' };
  }) };
  const reader = createVehiclePhotoReader(async () => product, source);
  const result = await reader('erp5-public-media', row.productId, 0);
  expect(result.bytes).toEqual(bytes);
  expect(await result.revalidate()).toBe(true);
  expect(source.read.mock.calls.map(call => call[1])).toEqual([0, undefined]);
  source.read.mockResolvedValueOnce({ count: 2, photoIds: [...review.servingPhotoIds!].reverse(),
    upstreamPhotoIds: review.upstreamPhotoIds!, bytes: null, contentType: 'application/json' });
  expect(await result.revalidate()).toBe(false);
});

it('fresh application observation does not rewrite the actual human review time', () => {
  const { original, row, review } = reviewedAlbum();
  const earlier = new Date(Date.now() - 1_200_000).toISOString();
  review.refs.forEach(ref => { ref.sourceObservedAt = earlier; ref.vehiclePhotoVerifiedAt = earlier; });
  expect(planIancarPhotoReviewPatch(original, row, review).photo_original_refs).toEqual(review.refs);
  expect(review.refs[0]!.vehiclePhotoVerifiedAt).toBe(earlier);
  expect(() => planIancarPhotoReviewPatch(original, { ...row, observedAt: earlier }, review)).toThrow('REVIEW_INVALID');
});

it.each(['same-id-new-bytes', 'changed-order', 'missing-binding'])('bound ONE review rejects %s', async condition => {
  const { original, row, review } = reviewedAlbum();
  const bytes = Buffer.from([255, 216, 255, 1]);
  review.refs.forEach(ref => { ref.photoSha256 = createHash('sha256').update(bytes).digest('hex'); });
  const product: Record<string, unknown> = { ...original, ...planIancarPhotoReviewPatch(original, row, review) };
  const metadata = { count: 2, photoIds: review.servingPhotoIds!, upstreamPhotoIds: review.upstreamPhotoIds! };
  if (condition === 'changed-order') metadata.photoIds = [...metadata.photoIds].reverse();
  if (condition === 'missing-binding') (product.photo_original_refs as IancarOnePhotoReview['refs'])[0]!.sourceBindingDigest = '';
  const reader = createVehiclePhotoReader(async () => product, { eligible: () => true, connection: () => 'synthetic-source',
    read: async () => ({ ...metadata, bytes: condition === 'same-id-new-bytes' ? Buffer.from([255, 216, 255, 2]) : bytes, contentType: 'image/jpeg' }) });
  await expect(reader('erp5-public-media', row.productId, 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
});
import { isPublicIancarPhotoProduct, FirestoreCatalogCompatibilityReader } from '../src/infra/erp5-compat-catalog-reader.js';

it('compatibility read derives unresolved deposits and performs no transaction or update', async () => {
  mocks.collections.length = 0;
  mocks.get.mockReset().mockResolvedValueOnce(snapshot(doc('synthetic', { provider_company_code: 'RP004', product_type: '중고렌트',
    price: { '12': { rent: 500000, deposit: 0 } } })))
    .mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot());
  const result = await new FirestoreCatalogCompatibilityReader().read('erp-com');
  expect(result.data.products.synthetic!.price).toMatchObject({ '12': { rent: 500000, deposit: null, depositState: 'UNKNOWN',
    depositStatusLabel: '미확인' } });
  expect(result.meta.depositEvidenceVersion).toBe('catalog-compat-deposit/1');
  expect(mocks.collections).toEqual(['products', 'policy', 'partner', 'user']);
  expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
});

it('public compatibility reader option reads no partner or user collections', async () => {
  mocks.collections.length = 0;
  mocks.get.mockReset().mockResolvedValueOnce(snapshot(doc('public-product')))
    .mockResolvedValueOnce(snapshot());
  const result = await new FirestoreCatalogCompatibilityReader(undefined, undefined, { readCollections: ['products', 'policy'] }).read('erp-com');
  expect(result.meta.collectionCounts).toEqual({ products: 1, policy: 0 });
  expect(result.data.partners).toBeUndefined();
  expect(result.data.users).toBeUndefined();
  expect(mocks.collections).toEqual(['products', 'policy']);
  expect(mocks.collections.filter(name => name === 'partner' || name === 'user')).toHaveLength(0);
});

const doc = (id: string, extra = {}) => ({ id, ref: { path: `products/${id}` },
  updateTime: { toDate: () => new Date('2026-10-01'), toMillis: () => 1, isEqual: () => true },
  data: () => ({ provider_company_code: 'RP031', vehicle_status: '출고협의', listable: true,
    plate: 'synthetic', monthly_rate: 123, ...extra }) });
const snapshot = (...docs: ReturnType<typeof doc>[]) => ({ size: docs.length, docs });
const input = { apply: true, expectedCount: 2, expectedOpen: 1 };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getApp.mockReturnValue({ options: { projectId: 'freepasserp5' } });
  const original = snapshot(doc('open'), doc('closed', { vehicle_status: '출고불가', listable: false }));
  mocks.get.mockResolvedValueOnce(original).mockResolvedValueOnce(snapshot(
    doc('open', { vehicle_status: '출고불가', listable: false }), original.docs[1]!));
  mocks.readFile.mockImplementation(async () => mocks.writeFile.mock.calls[0]![1]);
  mocks.transaction.mockImplementation(async callback => callback({ get: async () => original, update: mocks.update }));
});

const syncInput = () => { const now = new Date().toISOString(); return { apply: false, mirrorInventory: true, sourceDigest: 'a'.repeat(64), sourceSyncedAt: now,
  sourceEvidence: JSON.stringify({ readyForRawIngest: true, stale: false, issues: [], factScope: 'PHASE_ONE_FACTS',
    sourceDigest: 'a'.repeat(64), syncedAt: now, total: 1, pages: 1,
    records: [{ vehicleId: 'V1', payload: { plate_number: '123가4567' } }] }),
  products: [{ sourceVehicleId: 'V1', car_number: '123가4567', price: { '24': { rent: 500000, deposit: 700000 } },
    vehicle_status: '출고가능', status: '출고가능', status_kind: '가용', listable: true, facts: {}, evidence: { sourceDigest: 'a'.repeat(64) },
    photo: { count: 1, photoIds: ['PHOTO1'], observedAt: now } }] }; };
function prepareSyncMock() {
  mocks.readFile.mockImplementation(async () => mocks.writeFile.mock.calls.at(-1)![1]);
  const before = snapshot(doc('p1', { car_number: '123가4567', iancar_one_vehicle_id: 'V1', image_url: 'original.jpg' }),
    doc('gone', { car_number: '123가9999', iancar_one_vehicle_id: 'V2', iancar_phase_one: { sourceDigest: 'old' } }));
  mocks.get.mockReset().mockResolvedValue(before);
  mocks.transaction.mockImplementation(async callback => callback({ get: async () => before, update: mocks.update }));
  mocks.getAll.mockImplementation(async (...refs) => refs.map(ref => ({ data: () => ({ ...before.docs.find(d => d.ref.path === ref.path)!.data(),
    ...mocks.update.mock.calls.find(call => call[0].path === ref.path)![1] }) })));
  mocks.download.mockImplementation(async () => [Buffer.from(mocks.save.mock.calls[0]![0])]);
  return before;
}
it('sync atomically updates photo/state/rates and holds absent inventory after durable backup readback', async () => {
  prepareSyncMock(); const input = { ...syncInput(), privateEvidenceBucket: 'freepasserp5-data-audit-evidence' };
  const plan = await publishIancarPhaseOne(input);
  expect(plan).toMatchObject({ sourceCount: 1, matched: 1, absenceHeld: 1, withPhotos: 1, photoCount: 1, deletes: 0 });
  expect(mocks.transaction).not.toHaveBeenCalled();
  const result = await publishIancarPhaseOne({ ...input, apply: true, expectedPlanDigest: plan.planDigest });
  expect(result.status).toBe('PHASE_ONE_ATOM_READBACK_VERIFIED');
  expect(mocks.transaction).toHaveBeenCalledTimes(1); expect(mocks.update).toHaveBeenCalledTimes(2);
  expect(mocks.update.mock.calls[0]![1]).toMatchObject({ iancar_one_photo_ids: ['PHOTO1'], image_kind: 'VEHICLE_PHOTO', price: input.products[0]!.price });
  expect(mocks.download.mock.invocationCallOrder[0]).toBeLessThan(mocks.transaction.mock.invocationCallOrder[0]!);
  expect(mocks.save.mock.calls[0]![1].preconditionOpts.ifGenerationMatch).toBe(0);
});
it('sync refuses wrong digest, corrupted durable backup, revision race and expired photo before writes', async () => {
  const before = prepareSyncMock(); const input = { ...syncInput(), privateEvidenceBucket: 'freepasserp5-data-audit-evidence' };
  const plan = await publishIancarPhaseOne(input);
  await expect(publishIancarPhaseOne({ ...input, apply: true, expectedPlanDigest: 'wrong' })).rejects.toThrow('PLAN_CHANGED');
  mocks.download.mockResolvedValue([Buffer.from('corrupt')]);
  await expect(publishIancarPhaseOne({ ...input, apply: true, expectedPlanDigest: plan.planDigest })).rejects.toThrow('PRIVATE_BACKUP_READBACK_FAILED');
  expect(mocks.transaction).not.toHaveBeenCalled();
  mocks.download.mockImplementation(async () => [Buffer.from(mocks.save.mock.calls.at(-1)![0])]);
  mocks.transaction.mockImplementation(async cb => cb({ get: async () => ({ ...before, size: before.size + 1 }), update: mocks.update }));
  await expect(publishIancarPhaseOne({ ...input, apply: true, expectedPlanDigest: plan.planDigest })).rejects.toThrow('REVISION_CHANGED');
  expect(mocks.update).not.toHaveBeenCalled();
  input.products[0]!.photo.observedAt = new Date(Date.now() - 900_001).toISOString();
  await expect(publishIancarPhaseOne(input)).rejects.toThrow('PHOTO_CAPTURE_STALE');
});
it('mirror requires bound complete source evidence and durable backup in every apply environment', async () => {
  prepareSyncMock(); const input = syncInput(); const plan = await publishIancarPhaseOne(input);
  await expect(publishIancarPhaseOne({ ...input, apply: true, expectedPlanDigest: plan.planDigest })).rejects.toThrow('MIRROR_DURABLE_BACKUP_REQUIRED');
  for (const extra of [{ readyForRawIngest: false }, { total: 2 }, { records: [] }, { pages: 2 }, { stale: true }, { sourceDigest: 'b'.repeat(64) }]) {
    await expect(publishIancarPhaseOne({ ...input, sourceEvidence: JSON.stringify({ ...JSON.parse(input.sourceEvidence), ...extra }) }))
      .rejects.toThrow('MIRROR_COMPLETE_EVIDENCE_REQUIRED');
  }
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it('dry run never writes a backup or transaction', async () => {
  expect(await withdrawIancarPublication({ ...input, apply: false })).toMatchObject({ status: 'DRY_RUN', changedCount: 1 });
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.writeFile).not.toHaveBeenCalled();
});
it('wrong Firebase project aborts before any query or write', async () => {
  mocks.getApp.mockReturnValue({ options: { projectId: 'other-project' } });
  await expect(withdrawIancarPublication(input)).rejects.toThrow('WRONG_PROJECT');
  expect(mocks.get).not.toHaveBeenCalled();
});
it('backs up all originals and changes only open RP031 visibility fields', async () => {
  expect(await withdrawIancarPublication(input)).toMatchObject({ status: 'WITHDRAWN_ATOM_READBACK_VERIFIED', deletes: 0 });
  expect(JSON.parse(mocks.writeFile.mock.calls[0]![1]).documents).toHaveLength(2);
  expect(mocks.writeFile.mock.calls[0]![2]).toEqual({ flag: 'wx', mode: 0o600 });
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(mocks.update.mock.calls[0]![0]).toEqual({ path: 'products/open' });
  expect(mocks.update.mock.calls[0]![1]).not.toHaveProperty('plate');
  expect(mocks.update.mock.calls[0]![1]).not.toHaveProperty('monthly_rate');
});
it('scope drift aborts before backup or writes', async () => {
  await expect(withdrawIancarPublication({ ...input, expectedCount: 3 })).rejects.toThrow('SCOPE_CHANGED');
  expect(mocks.writeFile).not.toHaveBeenCalled();
});
it('contract locks abort before backup or writes', async () => {
  mocks.get.mockReset().mockResolvedValue(snapshot(doc('a', { locked_by_contract: 'contract' })));
  await expect(withdrawIancarPublication({ apply: true, expectedCount: 1, expectedOpen: 1 })).rejects.toThrow('CONTRACT_LOCK');
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it('backup readback failure prevents transactions', async () => {
  mocks.readFile.mockResolvedValue('bad');
  await expect(withdrawIancarPublication(input)).rejects.toThrow('BACKUP_READBACK_FAILED');
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it('revision drift prevents transaction updates', async () => {
  const changed = doc('open'); changed.updateTime.isEqual = () => false;
  mocks.transaction.mockImplementation(async callback => callback({ get: async () => snapshot(changed, doc('closed')), update: mocks.update }));
  await expect(withdrawIancarPublication(input)).rejects.toThrow('REVISION_CHANGED');
  expect(mocks.update).not.toHaveBeenCalled();
});
it('unexpected pricing changes fail readback', async () => {
  mocks.get.mockReset().mockResolvedValueOnce(snapshot(doc('open'), doc('closed', { vehicle_status: '출고불가', listable: false })))
    .mockResolvedValueOnce(snapshot(doc('open', { vehicle_status: '출고불가', listable: false, monthly_rate: 999 }), doc('closed', { vehicle_status: '출고불가', listable: false })));
  await expect(withdrawIancarPublication(input)).rejects.toThrow('UNEXPECTED_FIELD_CHANGE');
});

it('public photo eligibility rejects withdrawn, non-Iancar, closed, deleted and missing identities', () => {
  const p = { provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'V1', car_number: '133호1234' };
  expect(isPublicIancarPhotoProduct(p)).toBe(true);
  expect(isPublicIancarPhotoProduct({ ...p, status_kind: '선점' })).toBe(true);
  for (const patch of [{ provider_company_code: 'RP012' }, { listable: false }, { status_kind: '불가' },
    { publication_withdrawal: {} }, { _deleted: true }, { deletedAt: 1 }, { iancar_one_vehicle_id: '' }, { car_number: '' }])
    expect(isPublicIancarPhotoProduct({ ...p, ...patch })).toBe(false);
});

it('photo-only publication backs up originals, fences revision and preserves all business fields', async () => {
  const original = { provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'V1',
    car_number: '133호1234', image_urls: ['https://old.example/photo.jpg'], price: { '12': { rent: 123, deposit: 456 } } };
  const snapshot = { ref: { path: 'products/p1' }, updateTime: { toMillis: () => 1, isEqual: () => true }, data: () => original };
  const records = [{ productId: 'p1', vehicleId: 'V1', plate: '133호1234', count: 2, observedAt: new Date().toISOString() }];
  mocks.getAll.mockResolvedValue([snapshot]);
  const plan = await publishIancarPhotoReferences({ records, apply: false });
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.writeFile).not.toHaveBeenCalled();
  await expect(publishIancarPhotoReferences({ records, apply: true, expectedPlanDigest: 'wrong' })).rejects.toThrow('PLAN_CHANGED');
  mocks.transaction.mockImplementation(async cb => cb({ getAll: async () => [snapshot], update: mocks.update }));
  mocks.getAll.mockReset().mockResolvedValueOnce([snapshot]).mockImplementation(async () => [{ data: () => ({ ...original, ...mocks.update.mock.calls[0]![1] }) }]);
  const result = await publishIancarPhotoReferences({ records, apply: true, expectedPlanDigest: plan.planDigest });
  expect(result).toMatchObject({ status: 'PHOTO_ATOM_READBACK_VERIFIED', count: 1, withPhotos: 1, inventoryChanges: 0, priceChanges: 0 });
  const patch = mocks.update.mock.calls[0]![1];
  expect(patch.image_urls).toEqual(['https://freepasserp.com/api/img?product=p1&photo=0&format=.jpg', 'https://freepasserp.com/api/img?product=p1&photo=1&format=.jpg']);
  expect(patch.iancar_photo_source_original.image_urls).toEqual(original.image_urls);
  expect(patch).not.toHaveProperty('price'); expect(patch).not.toHaveProperty('listable'); expect(patch).not.toHaveProperty('status_kind');
});

it('photo rollback rehearses deletion of added fields while restoring original photos and preserving contracts', async () => {
  const original = { provider_company_code: 'RP031', image_url: 'original.jpg', price: 123, locked_by_contract: 'unchanged-contract' };
  const patch = { provider_company_code: 'RP031', image_url: '/api/img?product=p1&photo=0', iancar_one_photo_count: 1 };
  const backup = { schema: 'iancar-photo-typed-backup/1', projectId: 'freepasserp5', sourceDigest: 'verified-digest', documents: [{ path: 'products/p1', exists: true, data: encodeIancarBackupValue(original), patch: encodeIancarBackupValue(patch) }] };
  mocks.readFile.mockResolvedValue(JSON.stringify(backup));
  mocks.transaction.mockImplementation(async cb => cb({ getAll: async () => [{ data: () => ({ ...original, ...patch, price: 456 }) }], update: mocks.update }));
  expect(await restoreIancarPhaseOne({ backupPath: 'synthetic', apply: false, expectedSourceDigest: 'verified-digest' })).toMatchObject({ status: 'RESTORE_PLAN_VERIFIED' });
  expect(mocks.update).not.toHaveBeenCalled();
  mocks.getAll.mockResolvedValue([{ data: () => ({ ...original, price: 456 }) }]);
  await restoreIancarPhaseOne({ backupPath: 'synthetic', apply: true, expectedSourceDigest: 'verified-digest' });
  expect(mocks.update.mock.calls[0]![1].image_url).toBe('original.jpg');
  expect(mocks.update.mock.calls[0]![1].iancar_one_photo_count).toBeDefined();
  expect(mocks.update.mock.calls[0]![1]).not.toHaveProperty('price');
  backup.documents[0]!.patch = encodeIancarBackupValue({ ...patch, price: 999 });
  mocks.readFile.mockResolvedValue(JSON.stringify(backup));
  await expect(restoreIancarPhaseOne({ backupPath: 'synthetic', apply: true, expectedSourceDigest: 'verified-digest' })).rejects.toThrow('SCOPE_INVALID');
});

it('a later empty supplier list restores original photos instead of keeping dead API slots', async () => {
  const proxy = 'https://freepasserp.com/api/img?product=p1&photo=0&format=.jpg';
  const original = { provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'V1', car_number: '133호1234', image_urls: [proxy], image_url: proxy,
    iancar_photo_source_original: { image_urls: ['https://old.example/photo.jpg'], image_url: 'https://old.example/photo.jpg', photo_link: null }, price: 123 };
  const snapshot = { ref: { path: 'products/p1' }, updateTime: { toMillis: () => 1, isEqual: () => true }, data: () => original };
  const records = [{ productId: 'p1', vehicleId: 'V1', plate: '133호1234', count: 0, observedAt: new Date().toISOString() }];
  mocks.getAll.mockResolvedValue([snapshot]);
  const plan = await publishIancarPhotoReferences({ records, apply: false });
  mocks.transaction.mockImplementation(async cb => cb({ getAll: async () => [snapshot], update: mocks.update }));
  mocks.getAll.mockReset().mockResolvedValueOnce([snapshot]).mockImplementation(async () => [{ data: () => ({ ...original, ...mocks.update.mock.calls[0]![1], price: 456 }) }]);
  expect(await publishIancarPhotoReferences({ records, apply: true, expectedPlanDigest: plan.planDigest })).toMatchObject({ status: 'PHOTO_ATOM_READBACK_VERIFIED' });
  const patch = mocks.update.mock.calls[0]![1];
  expect(patch.image_urls).toEqual(['https://old.example/photo.jpg']); expect(patch.iancar_one_photo_state).toBe('API_EMPTY_ORIGINAL_PRESERVED');
  expect(patch).not.toHaveProperty('price');
});

it('model illustration fills an empty vehicle but cannot overwrite an original photograph', async () => {
  const illustration = { url: 'https://eancarone.com/catalog-images/neutral/complete-import-108-blue.webp', sourceName: '쿠퍼(4세대) 2.0 C 5 Door 클래식',
    kind: 'MODEL_ILLUSTRATION' as const, sourcePage: 'https://eancarone.com/', mappingVersion: 'supplier-catalogue-20261002/1' };
  for (const image of ['', 'https://old.example/photo.jpg']) {
    mocks.update.mockClear();
    mocks.writeFile.mockClear();
    const original = { provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'V1', car_number: '133호1234', image_url: image, image_urls: image ? [image] : [], price: 123 };
    const snapshot = { ref: { path: 'products/p1' }, updateTime: { toMillis: () => 1, isEqual: () => true }, data: () => original };
    const records = [{ productId: 'p1', vehicleId: 'V1', plate: '133호1234', count: 0, observedAt: new Date().toISOString(), illustration }];
    mocks.getAll.mockReset().mockResolvedValue([snapshot]);
    const plan = await publishIancarPhotoReferences({ records, apply: false });
    mocks.transaction.mockImplementation(async cb => cb({ getAll: async () => [snapshot], update: mocks.update }));
    mocks.getAll.mockReset().mockResolvedValueOnce([snapshot]).mockImplementation(async () => [{ data: () => ({ ...original, ...mocks.update.mock.calls[0]![1] }) }]);
    await publishIancarPhotoReferences({ records, apply: true, expectedPlanDigest: plan.planDigest });
    const patch = mocks.update.mock.calls[0]![1];
    expect(patch.iancar_one_photo_count).toBe(0);
    expect(patch.image_url).toBe(image ? undefined : illustration.url);
    expect(patch.image_kind).toBe(image ? undefined : 'MODEL_ILLUSTRATION');
    expect(patch).not.toHaveProperty('price');
  }
});

it('re-running an illustration reaffirms its state without rewriting images or trusting a stale kind flag', async () => {
  const illustration = { url: 'https://eancarone.com/catalog-images/neutral/complete-import-108-blue.webp', sourceName: '쿠퍼(4세대) 2.0 C 5 Door 클래식',
    kind: 'MODEL_ILLUSTRATION' as const, sourcePage: 'https://eancarone.com/', mappingVersion: 'supplier-catalogue-20261002/1' };
  for (const image of [illustration.url, 'https://operator.example/new-photo.jpg']) {
    mocks.update.mockClear(); mocks.writeFile.mockClear();
    const original = { provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'V1', car_number: '133호1234',
      image_url: image, image_urls: [image], image_kind: 'MODEL_ILLUSTRATION', iancar_model_illustration: illustration };
    const snapshot = { ref: { path: 'products/p1' }, updateTime: { toMillis: () => 1, isEqual: () => true }, data: () => original };
    const records = [{ productId: 'p1', vehicleId: 'V1', plate: '133호1234', count: 0, observedAt: new Date().toISOString(), illustration }];
    mocks.getAll.mockReset().mockResolvedValue([snapshot]);
    const plan = await publishIancarPhotoReferences({ records, apply: false });
    expect(plan.withIllustrations).toBe(image === illustration.url ? 1 : 0);
    mocks.transaction.mockImplementation(async cb => cb({ getAll: async () => [snapshot], update: mocks.update }));
    mocks.getAll.mockReset().mockResolvedValueOnce([snapshot]).mockImplementation(async () => [{ data: () => ({ ...original, ...mocks.update.mock.calls[0]![1] }) }]);
    await publishIancarPhotoReferences({ records, apply: true, expectedPlanDigest: plan.planDigest });
    const patch = mocks.update.mock.calls[0]![1];
    expect(patch).not.toHaveProperty('image_url'); expect(patch).not.toHaveProperty('image_urls');
    expect(patch.iancar_one_photo_state).toBe(image === illustration.url ? 'API_EMPTY_MODEL_ILLUSTRATION' : 'API_EMPTY_ORIGINAL_PRESERVED');
  }
});


it.each(['withdrawal', 'identity', 'plate', 'supplier'])('single photo pipeline rejects ONE %s changes during reads', async change => {
  let current: Record<string, unknown> = { provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'synthetic-vehicle', car_number: 'synthetic-plate',
    photo_original_refs: [{ vehiclePhotoVerifiedBy: 'synthetic-reviewer', vehiclePhotoVerificationMethod: 'synthetic ONE review', vehiclePhotoVerifiedAt: '2026-10-10T00:00:00Z' }] };
  mocks.get.mockReset().mockImplementation(async () => ({ data: () => current }));
  for (const index of [undefined, 0]) {
    current = { ...current, provider_company_code: 'RP031', listable: true, iancar_one_vehicle_id: 'synthetic-vehicle', car_number: 'synthetic-plate',
    photo_original_refs: [{ vehiclePhotoVerifiedBy: 'synthetic-reviewer', vehiclePhotoVerificationMethod: 'synthetic ONE review', vehiclePhotoVerifiedAt: '2026-10-10T00:00:00Z' }] };
    const reader = new FirestoreCatalogCompatibilityReader(async () => {
      current = { ...current, ...(change === 'withdrawal' ? { listable: false } : change === 'identity' ? { iancar_one_vehicle_id: 'changed' }
        : change === 'supplier' ? { provider_company_code: 'OTHER' } : { car_number: 'changed' }) };
      return { count: 1, bytes: index === undefined ? null : Buffer.from([255, 216, 255]), contentType: 'image/jpeg' };
    });
    await expect(reader.readVehiclePhoto('erp-com', 'synthetic-product', index)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
  }
});

it('ONE source shares byte validation, public errors and concurrency without requiring an approval hash', async () => {
  const current = { provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'synthetic-vehicle', car_number: 'synthetic-plate',
    photo_original_refs: [{ vehiclePhotoVerifiedBy: 'synthetic-reviewer', vehiclePhotoVerificationMethod: 'synthetic ONE review', vehiclePhotoVerifiedAt: '2026-10-10T00:00:00Z' }] };
  mocks.get.mockReset().mockImplementation(async () => ({ data: () => current }));
  for (const result of [
    { bytes: Buffer.alloc(0), contentType: 'image/jpeg' },
    { bytes: Buffer.alloc(8 * 1024 * 1024 + 1), contentType: 'image/jpeg' },
    { bytes: Buffer.from('invalid'), contentType: 'image/jpeg' },
    { bytes: Buffer.from([255, 216, 255]), contentType: 'text/html' },
  ]) {
    const reader = new FirestoreCatalogCompatibilityReader(async () => ({ count: 1, ...result }));
    await expect(reader.readVehiclePhoto('erp-com', 'synthetic-product', 0)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
  }
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }); let calls = 0;
  const reader = new FirestoreCatalogCompatibilityReader(async () => {
    if (++calls === 8) ready(); await gate;
    return { count: 1, bytes: Buffer.from([255, 216, 255]), contentType: 'image/jpeg' };
  });
  const pending = Array.from({ length: 8 }, () => reader.readVehiclePhoto('erp-com', 'synthetic-product', 0));
  await started;
  await expect(reader.readVehiclePhoto('erp-com', 'synthetic-product', 0)).rejects.toThrow('VEHICLE_PHOTO_BUSY');
  release(); expect((await Promise.all(pending)).every(result => result.bytes?.length === 3)).toBe(true);
  for (const suffix of ['NOT_FOUND', 'BUSY', 'IDENTITY_MISMATCH']) {
    const failing = new FirestoreCatalogCompatibilityReader(async () => { throw new Error('IANCAR_PHOTO_' + suffix); });
    await expect(failing.readVehiclePhoto('erp-com', 'synthetic-product', 0)).rejects.toThrow('VEHICLE_PHOTO_' + (suffix === 'IDENTITY_MISMATCH' ? 'UNAVAILABLE' : suffix));
  }
});

// Synthetic fixtures only; no database, emulator, credentials or network.
function prepareLockIsolation(lock: Record<string, unknown>, count = 5) {
  const base = syncInput();
  const products = Array.from({ length: count }, (_, index) => ({ ...base.products[0]!,
    sourceVehicleId: `fixture-${index}`, car_number: `123\uac00${1000 + index}` }));
  const input = { ...base, products, privateEvidenceBucket: 'freepasserp5-data-audit-evidence',
    sourceEvidence: JSON.stringify({ ...JSON.parse(base.sourceEvidence), total: count,
      records: products.map(p => ({ vehicleId: p.sourceVehicleId, payload: { plate_number: p.car_number } })) }) };
  const before = snapshot(...products.map((p, index) => doc(`fixture-${index}`, {
    car_number: p.car_number, iancar_one_vehicle_id: p.sourceVehicleId,
    price: { preserved: true }, iancar_phase_one: { old: true }, ...(index === 0 ? lock : {}) })));
  mocks.get.mockReset().mockResolvedValue(before);
  mocks.transaction.mockImplementation(async cb => cb({ get: async () => before, update: mocks.update, create: vi.fn() }));
  mocks.getAll.mockImplementation(async (...refs) => refs.map(ref => ({ data: () => ({
    ...before.docs.find(d => d.ref.path === ref.path)!.data(),
    ...mocks.update.mock.calls.find(call => call[0].path === ref.path)?.[1] }) })));
  mocks.readFile.mockImplementation(async () => mocks.writeFile.mock.calls.at(-1)![1]);
  mocks.download.mockImplementation(async () => [Buffer.from(mocks.save.mock.calls.at(-1)![0])]);
  return { input, before };
}
it.each([
  [{ locked_by_contract: true }, 'CONTRACT_LOCK'],
  [{ _deleted: true }, 'DELETION_LOCK'],
  [{ deletedAt: 'synthetic-deletion-marker' }, 'DELETION_LOCK'],
  [{ locked_by_contract: true, _deleted: true }, 'CONTRACT_AND_DELETION_LOCK'],
] as const)('isolates a locked product and preserves its entire preimage: %j', async (lock, reason) => {
  const { input, before } = prepareLockIsolation(lock);
  const preserved = structuredClone(before.docs[0]!.data());
  const plan = await publishIancarPhaseOne(input);
  expect(plan).toMatchObject({ matched: 4, open: 4, withPhotos: 4, photoCount: 4, skippedCount: 1, skippedRatio: 0.2,
    skippedByReason: { [reason]: 1 }, warnings: ['IANCAR_PUBLICATION_LOCKED_PRODUCTS_SKIPPED'] });
  expect(Object.values(plan.skippedByReason).reduce((a, b) => a + b, 0)).toBe(1);
  const result = await publishIancarPhaseOne({ ...input, apply: true, expectedPlanDigest: plan.planDigest });
  expect(result).toMatchObject({ status: 'PHASE_ONE_ATOM_READBACK_VERIFIED', writeExecuted: true, skippedCount: 1 });
  expect(mocks.update).toHaveBeenCalledTimes(4);
  expect(mocks.update.mock.calls.every(([ref]) => ref.path !== before.docs[0]!.ref.path)).toBe(true);
  expect(before.docs[0]!.data()).toEqual(preserved);
  expect(JSON.parse(mocks.writeFile.mock.calls[0]![1]).documents).toHaveLength(4);
});
it('fails before backup or writes when skipped share exceeds the single threshold', async () => {
  const { input } = prepareLockIsolation({ locked_by_contract: true }, 4);
  await expect(publishIancarPhaseOne({ ...input, apply: true })).rejects.toMatchObject({
    message: 'IANCAR_PUBLICATION_LOCK_SKIP_RATIO_EXCEEDED', skippedCount: 1, skippedRatio: 0.25, writeExecuted: false });
  expect(mocks.writeFile).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
});
it.each(['identity', 'plate', 'source', 'duplicate', 'stale'] as const)(
  'keeps structural %s failures fatal even for locked products', async kind => {
    const { input, before } = prepareLockIsolation({ locked_by_contract: true });
    // Disable only the mirror envelope in this adapter test to reach each publication guard directly.
    input.mirrorInventory = false;
    const errors = { identity: 'IDENTITY_INVALID', plate: 'PLATE_COLLISION', source: 'SOURCE_ID_COLLISION',
      duplicate: 'DUPLICATE_OR_OVERSIZED_INPUT', stale: 'SOURCE_STALE_OR_INVALID' };
    if (kind === 'identity') input.products[0]!.car_number = 'invalid';
    if (kind === 'plate') mocks.get.mockResolvedValue(snapshot(...before.docs,
      doc('collision', { car_number: input.products[0]!.car_number })));
    if (kind === 'source') mocks.get.mockResolvedValue(snapshot(doc('fixture-0', {
      ...before.docs[0]!.data(), iancar_one_vehicle_id: 'different-source' }), ...before.docs.slice(1)));
    if (kind === 'duplicate') input.products[1]!.sourceVehicleId = input.products[0]!.sourceVehicleId;
    if (kind === 'stale') input.sourceSyncedAt = new Date(Date.now() - 900_001).toISOString();
    await expect(publishIancarPhaseOne({ ...input, apply: true })).rejects.toThrow(errors[kind]);
    expect(mocks.writeFile).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
it('fences a newly acquired lock between planning and the transaction', async () => {
  const { input, before } = prepareLockIsolation({ locked_by_contract: true });
  const plan = await publishIancarPhaseOne(input);
  const changed = snapshot(...before.docs.map((d, index) => index === 1
    ? { ...d, updateTime: { ...d.updateTime, isEqual: () => false } } : d));
  // The original snapshot compares its revision with the current snapshot.
  before.docs[1]!.updateTime.isEqual = () => false;
  mocks.transaction.mockImplementation(async cb => cb({ get: async () => changed, update: mocks.update }));
  await expect(publishIancarPhaseOne({ ...input, apply: true, expectedPlanDigest: plan.planDigest })).rejects.toThrow('REVISION_CHANGED');
  expect(mocks.update).not.toHaveBeenCalled();
});

it('collector finishes successfully and reports lock warnings without changing its exit code', async () => {
  const argv = process.argv; const exitCode = process.exitCode;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected exit'); });
  const warnings = ['IANCAR_PUBLICATION_LOCKED_PRODUCTS_SKIPPED'];
  vi.stubEnv('EANCAR_ONE_SYNC_APPROVED', 'true');
  vi.stubEnv('IANCAR_SYNC_EXPECT', JSON.stringify({ created: [0, 0], absenceHeld: [0, 0], withdrawalHoldsReleased: [0, 0], open: [0, 0],
    deletes: [0, 0], contractChanges: [0, 0], skippedCount: [1, 1] }));
  vi.doMock('../src/adapters/iancar-one-api.js', () => ({
    iancarOneApiConfigFromEnv: () => ({ apiKey: 'synthetic-only' }),
    collectIancarOnePhaseOneFacts: async () => ({ readyForRawIngest: true, issues: [], total: 5 }),
    buildIancarOneSourceBatch: () => ({ source: { sourceId: 'synthetic' } }),
    projectIancarOnePhaseOne: () => ({ vehicles: [] }),
  }));
  vi.doMock('../src/domain/source-intake.js', () => ({ inspectSupplierSourceBatch: () => ({}) }));
  vi.doMock('../src/jobs/data-access-runtime.js', () => ({ runIancarPhaseOnePublication: async () => ({
    status: 'PHASE_ONE_ATOM_READBACK_VERIFIED', skippedCount: 1, skippedByReason: { CONTRACT_LOCK: 1 },
    skippedRatio: 0.2, maxSkippedRatio: 0.2, warnings,
    created: 0, absenceHeld: 0, withdrawalHoldsReleased: 0, open: 0, deletes: 0, contractChanges: 0,
  }) }));
  try {
    process.argv = ['node', 'synthetic-collector', '--sync', '--apply-sync']; process.exitCode = 0;
    await import('../src/jobs/collect-iancar-one-api.js');
    expect(process.exitCode).toBe(0); expect(exit).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
      publication: { skippedCount: 1, skippedByReason: { CONTRACT_LOCK: 1 }, warnings } });
  } finally {
    process.argv = argv; process.exitCode = exitCode;
    log.mockRestore(); exit.mockRestore(); vi.unstubAllEnvs();
    vi.doUnmock('../src/adapters/iancar-one-api.js'); vi.doUnmock('../src/domain/source-intake.js');
    vi.doUnmock('../src/jobs/data-access-runtime.js');
  }
});

it('--apply-sync 는 건수 승인 설정(IANCAR_SYNC_EXPECT)이 없으면 쓰기 없이 종료 코드 3 으로 멈춘다', async () => {
  const argv = process.argv; const exitCode = process.exitCode;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
  const publish = vi.fn(async () => ({ status: 'DRY_RUN', skippedCount: 0, created: 0, absenceHeld: 0, withdrawalHoldsReleased: 0, open: 0,
    deletes: 0, contractChanges: 0, planDigest: 'd' }));
  vi.stubEnv('EANCAR_ONE_SYNC_APPROVED', 'true'); vi.stubEnv('IANCAR_SYNC_EXPECT', '');
  vi.doMock('../src/adapters/iancar-one-api.js', () => ({
    iancarOneApiConfigFromEnv: () => ({ apiKey: 'synthetic-only' }),
    collectIancarOnePhaseOneFacts: async () => ({ readyForRawIngest: true, issues: [], total: 5 }),
    buildIancarOneSourceBatch: () => ({ source: { sourceId: 'synthetic' } }),
    projectIancarOnePhaseOne: () => ({ vehicles: [] }),
  }));
  vi.doMock('../src/domain/source-intake.js', () => ({ inspectSupplierSourceBatch: () => ({}) }));
  vi.doMock('../src/jobs/data-access-runtime.js', () => ({ runIancarPhaseOnePublication: publish }));
  try {
    process.argv = ['node', 'synthetic-collector', '--sync', '--apply-sync'];
    vi.resetModules();
    await expect(import('../src/jobs/collect-iancar-one-api.js')).rejects.toThrow('exit:3');
    expect(publish).toHaveBeenCalledTimes(1); // 계획 한 번뿐, 적용 호출 없음
    expect(publish.mock.calls[0]![0]).toMatchObject({ apply: false });
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ status: 'HOLD_PLAN_OUT_OF_APPROVED_RANGE', writeExecuted: false, reasons: ['EXPECT_MISSING'] });
  } finally {
    process.argv = argv; process.exitCode = exitCode;
    log.mockRestore(); exit.mockRestore(); vi.unstubAllEnvs();
    vi.doUnmock('../src/adapters/iancar-one-api.js'); vi.doUnmock('../src/domain/source-intake.js');
    vi.doUnmock('../src/jobs/data-access-runtime.js'); vi.resetModules();
  }
});

function concurrentContentReader() {
  let clock = Date.now();
  const { original, row, review, bytes } = contentReviewedAlbum();
  let product: Record<string, unknown> = { ...original, ...planIancarPhotoReviewPatch(original, row, review) };
  const metadata = { count: 2, photoIds: ['opaque-b', 'opaque-a'], upstreamPhotoIds: ['opaque-a', 'opaque-b'],
    upstreamRepresentatives: [false, true], servingSourceOrdinals: [1, 0] };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sourceRead = vi.fn(async (_product: Record<string, unknown>, index?: number) => {
    if (index !== undefined) await gate;
    return { ...metadata, bytes: index === undefined ? null : bytes, contentType: index === undefined ? 'application/json' : 'image/jpeg' };
  });
  const productRead = vi.fn(async () => product);
  const reader = createVehiclePhotoReader(productRead, { eligible: value => value?.listable === true,
    connection: value => String(value.iancar_one_vehicle_id), read: sourceRead }, undefined, () => clock);
  return { row, review, bytes, metadata, reader, sourceRead, productRead, release, advance: (ms: number) => { clock += ms; }, setProduct: (value: Record<string, unknown>) => { product = value; }, getProduct: () => product };
}

it('concurrent reads share only the ongoing exact approved image and keep independent revalidation', async () => {
  const fixture = concurrentContentReader();
  const calls = [fixture.reader('erp5-public-media', fixture.row.productId, 0), fixture.reader('erp5-public-media', fixture.row.productId, 0)];
  await vi.waitFor(() => expect(fixture.sourceRead).toHaveBeenCalledTimes(1));
  fixture.release();
  const [first, second] = await Promise.all(calls);
  expect(fixture.productRead).toHaveBeenCalledTimes(4);
  first!.bytes![3] = 99;
  expect(second!.bytes).toEqual(fixture.bytes);
  expect(await first!.revalidate()).toBe(true);
  expect(await second!.revalidate()).toBe(true);
  expect(fixture.sourceRead.mock.calls.map(call => call[1])).toEqual([0, undefined, undefined]);
  await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(fixture.sourceRead.mock.calls.map(call => call[1])).toEqual([0, undefined, undefined]);
});

it('failed shared reads are removed so the next request performs a fresh read', async () => {
  const fixture = concurrentContentReader();
  fixture.sourceRead.mockImplementationOnce(async () => { await new Promise<void>(resolve => setTimeout(resolve, 5)); throw new Error('IANCAR_PHOTO_NOT_FOUND'); });
  const calls = [fixture.reader('erp5-public-media', fixture.row.productId, 0), fixture.reader('erp5-public-media', fixture.row.productId, 0)];
  const failed = await Promise.allSettled(calls);
  expect(failed.every(result => result.status === 'rejected')).toBe(true);
  expect(fixture.sourceRead).toHaveBeenCalledTimes(1);
  fixture.release();
  expect((await fixture.reader('erp5-public-media', fixture.row.productId, 0)).bytes).toEqual(fixture.bytes);
  expect(fixture.sourceRead).toHaveBeenCalledTimes(2);
});

it('a changed approval proof does not join an older ongoing request', async () => {
  const fixture = concurrentContentReader();
  const first = fixture.reader('erp5-public-media', fixture.row.productId, 0);
  await vi.waitFor(() => expect(fixture.sourceRead).toHaveBeenCalledTimes(1));
  const changed = structuredClone(fixture.getProduct());
  (changed.photo_original_refs as IancarOnePhotoReview['refs'])[0]!.vehiclePhotoVerifiedBy = 'another-actual-reviewer';
  fixture.setProduct(changed);
  const second = fixture.reader('erp5-public-media', fixture.row.productId, 0);
  await vi.waitFor(() => expect(fixture.sourceRead).toHaveBeenCalledTimes(2));
  fixture.release();
  await expect(first).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
  expect((await second).bytes).toEqual(fixture.bytes);
});

it('withdrawal while a shared image is pending rejects every waiting request', async () => {
  const fixture = concurrentContentReader();
  const calls = [fixture.reader('erp5-public-media', fixture.row.productId, 0), fixture.reader('erp5-public-media', fixture.row.productId, 0)];
  await vi.waitFor(() => expect(fixture.sourceRead).toHaveBeenCalledTimes(1));
  fixture.setProduct({ ...fixture.getProduct(), listable: false });
  fixture.release();
  const results = await Promise.allSettled(calls);
  expect(results.every(result => result.status === 'rejected')).toBe(true);
});

it('consumer and product scopes never share ongoing approved bytes', async () => {
  const fixture = concurrentContentReader();
  const calls = [fixture.reader('erp5-public-media', fixture.row.productId, 0), fixture.reader('erp-com', fixture.row.productId, 0)];
  await vi.waitFor(() => expect(fixture.sourceRead).toHaveBeenCalledTimes(2));
  fixture.release();
  await Promise.all(calls);
  await expect(fixture.reader('unsupported-consumer', fixture.row.productId, 0)).rejects.toThrow('CONSUMER_FORBIDDEN');
  await expect(fixture.reader('erp5-public-media', 'another-product', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
});
it('verified content reuse requires successful final membership and never extends the absolute TTL', async () => {
  const fixture = concurrentContentReader(); fixture.release();
  await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(fixture.sourceRead).toHaveBeenCalledTimes(1);
  const cold = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(fixture.sourceRead).toHaveBeenCalledTimes(2); // no final audit/revalidation, no published cache
  expect(await cold.revalidate()).toBe(true);
  fixture.advance(29_000);
  const warm = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(fixture.sourceRead.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(2);
  expect(await warm.revalidate()).toBe(true);
  fixture.advance(1_000);
  await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(fixture.sourceRead.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(3);
});

it('a failed final membership check evicts verified bytes and returns no success', async () => {
  const fixture = concurrentContentReader(); fixture.release();
  const cold = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(await cold.revalidate()).toBe(true);
  const warm = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  fixture.sourceRead.mockResolvedValueOnce({ ...fixture.metadata, count: 1, bytes: null, contentType: 'application/json' });
  expect(await warm.revalidate()).toBe(false);
  await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(fixture.sourceRead.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(2);
});

it.each(['approval', 'binding', 'withdrawal', 'unknown-basis'])('warm bytes cannot bypass changed %s', async condition => {
  const fixture = concurrentContentReader(); fixture.release();
  const first = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(await first.revalidate()).toBe(true);
  const changed = structuredClone(fixture.getProduct());
  const refs = changed.photo_original_refs as IancarOnePhotoReview['refs'];
  if (condition === 'approval') refs[0]!.vehiclePhotoVerifiedBy = '';
  if (condition === 'binding') changed.iancar_one_vehicle_id = 'changed-vehicle';
  if (condition === 'withdrawal') changed.listable = false;
  if (condition === 'unknown-basis') refs[0]!.reviewBasis = 'UNKNOWN' as any;
  fixture.setProduct(changed);
  await expect(fixture.reader('erp5-public-media', fixture.row.productId, 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
});

it('an audit delay cannot extend the byte validation TTL or publish an expired entry', async () => {
  const fixture = concurrentContentReader(); fixture.release();
  const first = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  fixture.advance(30_000);
  expect(await first.revalidate()).toBe(true);
  await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(fixture.sourceRead.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(2);
});
it.each(['database', 'metadata'])('a final %s failure evicts completed reviewed bytes', async failure => {
  const fixture = concurrentContentReader(); fixture.release();
  const first = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(await first.revalidate()).toBe(true);
  const warm = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  if (failure === 'database') fixture.productRead.mockRejectedValueOnce(new Error('synthetic-db-error'));
  else fixture.sourceRead.mockRejectedValueOnce(new Error('synthetic-source-error'));
  expect(await warm.revalidate()).toBe(false);
  await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(fixture.sourceRead.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(2);
});

it('changing a valid approval proof evicts the previous proof rather than reviving it later', async () => {
  const fixture = concurrentContentReader(); fixture.release();
  const original = structuredClone(fixture.getProduct());
  const first = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(await first.revalidate()).toBe(true);
  const changed = structuredClone(original);
  (changed.photo_original_refs as IancarOnePhotoReview['refs'])[0]!.vehiclePhotoVerifiedBy = 'changed-real-reviewer';
  fixture.setProduct(changed);
  const second = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(await second.revalidate()).toBe(true);
  fixture.setProduct(original);
  await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(fixture.sourceRead.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(3);
});

it('reviewed byte cache evicts old entries at its 32MiB bound', async () => {
  const fixture = concurrentContentReader(); fixture.release();
  const bytes = Buffer.alloc(7 * 1024 * 1024, 1); bytes[0] = 255; bytes[1] = 216; bytes[2] = 255;
  const product = fixture.getProduct();
  const refs = product.photo_original_refs as IancarOnePhotoReview['refs'];
  refs.forEach(ref => { ref.photoSha256 = createHash('sha256').update(bytes).digest('hex'); });
  const set = iancarReviewedContentSetDigest(refs[0]!.sourceBindingDigest, refs);
  refs.forEach(ref => { ref.photoSetDigest = set; });
  fixture.sourceRead.mockImplementation(async (_product, index) => ({ ...fixture.metadata,
    bytes: index === undefined ? null : bytes, contentType: index === undefined ? 'application/json' : 'image/jpeg' }));
  for (let i = 0; i < 5; i++) {
    const image = await fixture.reader(`whitelabel-scope-${i}`, fixture.row.productId, 0);
    expect(await image.revalidate()).toBe(true);
  }
  await fixture.reader('whitelabel-scope-0', fixture.row.productId, 0);
  expect(fixture.sourceRead.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(6);
});

it('reviewed byte cache evicts old entries at its 64-entry bound', async () => {
  const fixture = concurrentContentReader(); fixture.release();
  for (let i = 0; i < 65; i++) {
    const image = await fixture.reader(`whitelabel-scope-${i}`, fixture.row.productId, 0);
    expect(await image.revalidate()).toBe(true);
  }
  await fixture.reader('whitelabel-scope-0', fixture.row.productId, 0);
  expect(fixture.sourceRead.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(66);
});
it('the fixed reuse window serves previously verified frozen bytes and expiry forces a new raw validation', async () => {
  const fixture = concurrentContentReader(); fixture.release();
  const first = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(await first.revalidate()).toBe(true);
  fixture.sourceRead.mockImplementation(async (_product, index) => ({ ...fixture.metadata,
    bytes: index === undefined ? null : Buffer.from([255, 216, 255, 2]), contentType: index === undefined ? 'application/json' : 'image/jpeg' }));
  const warm = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(warm.bytes).toEqual(fixture.bytes);
  expect(await warm.revalidate()).toBe(true);
  fixture.advance(30_000);
  await expect(fixture.reader('erp5-public-media', fixture.row.productId, 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
});
it('ongoing reviewed image requests remain bounded at eight and recover after completion', async () => {
  const fixture = concurrentContentReader();
  const calls = Array.from({ length: 8 }, (_, index) => fixture.reader(`whitelabel-scope-${index}`, fixture.row.productId, 0));
  await vi.waitFor(() => expect(fixture.sourceRead).toHaveBeenCalledTimes(8));
  await expect(fixture.reader('whitelabel-scope-8', fixture.row.productId, 0)).rejects.toThrow('VEHICLE_PHOTO_BUSY');
  fixture.release();
  await Promise.all(calls);
  expect((await fixture.reader('whitelabel-scope-8', fixture.row.productId, 0)).bytes).toEqual(fixture.bytes);
});
it('a warm response expiring during its final membership request is refused', async () => {
  const fixture = concurrentContentReader(); fixture.release();
  const cold = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(await cold.revalidate()).toBe(true);
  fixture.advance(29_000);
  const warm = await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  fixture.sourceRead.mockImplementationOnce(async () => {
    fixture.advance(1_000);
    return { ...fixture.metadata, bytes: null, contentType: 'application/json' };
  });
  expect(await warm.revalidate()).toBe(false);
  await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(fixture.sourceRead.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(2);
});
it('a shared-flight follower cannot reuse validated bytes beyond the fixed window', async () => {
  const fixture = concurrentContentReader();
  const calls = [fixture.reader('erp5-public-media', fixture.row.productId, 0), fixture.reader('erp5-public-media', fixture.row.productId, 0)];
  await vi.waitFor(() => expect(fixture.sourceRead).toHaveBeenCalledTimes(1));
  fixture.release();
  const [initiator, follower] = await Promise.all(calls);
  fixture.advance(30_000);
  expect(await initiator!.revalidate()).toBe(true); // unchanged existing cold-request semantics
  expect(await follower!.revalidate()).toBe(false);
  await fixture.reader('erp5-public-media', fixture.row.productId, 0);
  expect(fixture.sourceRead.mock.calls.filter(call => call[1] !== undefined)).toHaveLength(2);
});