import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), transaction: vi.fn(), update: vi.fn(),
  mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn(), getApp: vi.fn() }));
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => ({
  collection: (name: string) => ({ where: (field: string, operator: string, value: string) => {
    expect([name, field, operator, value]).toEqual(['products', 'provider_company_code', '==', 'RP031']);
    return { get: mocks.get };
  } }), runTransaction: mocks.transaction
}) }));
vi.mock('../src/infra/firebase-target.js', () => ({ getTargetFirebaseApp: mocks.getApp }));
vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir, writeFile: mocks.writeFile, readFile: mocks.readFile }));
import { withdrawIancarPublication } from '../src/infra/iancar-publication-withdrawal-firestore.js';

const doc = (id: string, extra = {}) => ({ id, ref: { path: `products/${id}` },
  updateTime: { toDate: () => new Date('2026-10-01'), isEqual: () => true },
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
