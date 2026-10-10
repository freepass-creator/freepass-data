import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), transaction: vi.fn(), update: vi.fn(), collections: [] as string[],
  mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn(), getApp: vi.fn(), getAll: vi.fn(), save: vi.fn(), download: vi.fn() }));
vi.mock('firebase-admin/firestore', async importOriginal => ({ ...(await importOriginal<typeof import('firebase-admin/firestore')>()), getFirestore: () => ({
  collection: (name: string) => {
    mocks.collections.push(name);
    return { get: mocks.get, doc: (id: string) => ({ path: `${name}/${id}` }), where: (field: string, operator: string, value: string) => {
    expect([name, field, operator, value]).toEqual(['products', 'provider_company_code', '==', 'RP031']);
    return { get: mocks.get };
  } };
  }, doc: (path: string) => ({ path }), runTransaction: mocks.transaction, getAll: mocks.getAll
}) }));
vi.mock('../src/infra/firebase-target.js', () => ({ getTargetFirebaseApp: mocks.getApp, CENTRAL_FIREBASE_PROJECT_ID: 'freepasserp5' }));
vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir, writeFile: mocks.writeFile, readFile: mocks.readFile }));
vi.mock('firebase-admin/storage', () => ({ getStorage: () => ({ bucket: () => ({ file: () => ({ save: mocks.save, download: mocks.download }) }) }) }));
import { withdrawIancarPublication, publishIancarPhotoReferences, publishIancarPhaseOne, restoreIancarPhaseOne, encodeIancarBackupValue } from '../src/infra/iancar-publication-withdrawal-firestore.js';
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
  const result = await new FirestoreCatalogCompatibilityReader(undefined, { readCollections: ['products', 'policy'] }).read('erp-com');
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
