import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConsumerDataAccessRuntime } from '../src/api/data-access-runtime.js';
import type { VehiclePhotoRead } from '../src/domain/consumer-output-contract.js';

const state = vi.hoisted(() => ({
  source: undefined as undefined | ((vehicle: string, plate: string, index?: number, fresh?: boolean, expected?: readonly string[]) => Promise<VehiclePhotoRead>),
  getVehicle: vi.fn(), getPhoto: vi.fn(),
}));
vi.mock('../src/adapters/iancar-one-api.js', async original => ({ ...await original<typeof import('../src/adapters/iancar-one-api.js')>(),
  createIancarOneApiClient: () => ({ getVehicle: state.getVehicle, getPhoto: state.getPhoto }),
  iancarOneApiConfigFromEnv: () => ({ apiKey: 'fake-key' }),
}));
vi.mock('../src/infra/erp5-compat-catalog-reader.js', () => ({
  createFirestoreCatalogCompatibilityReader: (source: typeof state.source) => { state.source = source; return {}; },
  isPublicIancarPhotoProduct: () => false,
}));
vi.mock('../src/infra/firestore-data-access-log.js', () => ({ createFirestoreDataAccessLogStore: () => ({}) }));
vi.mock('../src/infra/admin-workflow-firestore.js', () => ({ createFirestoreAdminWorkflowStore: () => ({}) }));
vi.mock('../src/infra/firestore-data-health-reader.js', () => ({ createFirestoreDataHealthReader: () => ({}) }));
vi.mock('../src/infra/firestore-projection-reader.js', () => ({ createFirestoreProjectionReader: () => ({}) }));
vi.mock('../src/infra/estimate-artifacts-firestore.js', () => ({ createFirestoreEstimateArtifactStore: () => ({}) }));

const vehicle = 'fake-vehicle', plate = '12가3456';
const detail = () => ({ data: { vehicle_id: vehicle, plate_number: plate, stale: false, photos: [
  { photo_id: 'other', representative: false, url: `/v1/vehicles/${vehicle}/photos/other` },
  { photo_id: 'main', representative: true, url: `/v1/vehicles/${vehicle}/photos/main` },
] } });
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1]);
beforeEach(() => {
  state.getVehicle.mockReset().mockResolvedValue(detail());
  state.getPhoto.mockReset().mockImplementation(async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }));
  createConsumerDataAccessRuntime();
});

describe('실제 runtime callback의 사진 바이트 조회 전 등록 순서 검사', () => {
  it.each([['missing', 'other'], ['other', 'main'], ['main']])('틀린 등록 ID·순서·수량은 getPhoto 전에 거부: %j', async (...ids) => {
    await expect(state.source!(vehicle, plate, 0, true, ids)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    expect(state.getVehicle).toHaveBeenCalledTimes(1);
    expect(state.getPhoto).not.toHaveBeenCalled();
  });
  it.each([[], ['main', 'main'], [' main', 'other'], ['main', ''], ['x'.repeat(2049)], Array(201).fill('x')])('잘못된 기대 ID는 원천 조회도 시작하지 않는다: %j', async (...ids) => {
    await expect(state.source!(vehicle, plate, 0, true, ids)).rejects.toThrow('VEHICLE_PHOTO_REQUEST_INVALID');
    expect(state.getVehicle).not.toHaveBeenCalled();
    expect(state.getPhoto).not.toHaveBeenCalled();
  });
  it.each([-1, 2, 0.5, NaN])('잘못된 index %j는 바이트 조회 전에 거부', async index => {
    await expect(state.source!(vehicle, plate, index, true, ['main', 'other'])).rejects.toThrow('VEHICLE_PHOTO_REQUEST_INVALID');
    expect(state.getPhoto).not.toHaveBeenCalled();
  });
  it('nonfresh 기대 ID는 캐시 경로로 우회하지 않는다', async () => {
    await expect(state.source!(vehicle, plate, 0, false, ['main', 'other'])).rejects.toThrow('VEHICLE_PHOTO_REQUEST_INVALID');
    expect(state.getVehicle).not.toHaveBeenCalled();
    expect(state.getPhoto).not.toHaveBeenCalled();
  });
  it.each([null, 'main', [31], Array(1)])('비배열·비문자열·sparse 기대값은 원천 조회 전에 거부: %j', async expected => {
    await expect(state.source!(vehicle, plate, 0, true, expected as unknown as readonly string[])).rejects.toThrow('VEHICLE_PHOTO_REQUEST_INVALID');
    expect(state.getVehicle).not.toHaveBeenCalled(); expect(state.getPhoto).not.toHaveBeenCalled();
  });
  it.each(['identity', 'stale', 'representative'])('현재 원천 %s 검증 실패는 getPhoto0', async fault => {
    const current = detail();
    if (fault === 'identity') current.data.vehicle_id = 'other-vehicle';
    if (fault === 'stale') current.data.stale = true;
    if (fault === 'representative') current.data.photos[0]!.representative = true;
    state.getVehicle.mockResolvedValue(current);
    await expect(state.source!(vehicle, plate, 0, true, ['main', 'other'])).rejects.toThrow();
    expect(state.getPhoto).not.toHaveBeenCalled();
  });
  it('유효한 대표 우선 순서면 같은 detail의 선택 ID만 한 번 읽는다', async () => {
    const result = await state.source!(vehicle, plate, 1, true, ['main', 'other']);
    expect(state.getVehicle).toHaveBeenCalledTimes(1);
    expect(state.getPhoto).toHaveBeenCalledExactlyOnceWith(vehicle, 'other');
    expect(result.bytes).toEqual(jpeg);
    expect(result.upstreamPhotoIds).toEqual(['other', 'main']);
    expect(result.servingSourceOrdinals).toEqual([1, 0]);
  });
  it('기대 ID는 첫 await 전에 복사되고 metadata 검사에는 바이트 조회가 없다', async () => {
    const ids = ['main', 'other'];
    let release!: (value: ReturnType<typeof detail>) => void;
    state.getVehicle.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = state.source!(vehicle, plate, undefined, true, ids);
    ids.reverse(); release(detail());
    expect((await pending).photoIds).toEqual(['main', 'other']);
    expect(state.getPhoto).not.toHaveBeenCalled();
  });
  it('기대 ID 없는 기존 fresh 및 cache 경로의 호출 수를 유지한다', async () => {
    await state.source!(vehicle, plate, 0, true);
    expect(state.getVehicle).toHaveBeenCalledTimes(1); expect(state.getPhoto).toHaveBeenCalledTimes(1);
    state.getVehicle.mockClear(); state.getPhoto.mockClear();
    await state.source!(vehicle, plate, 0, false);
    await state.source!(vehicle, plate, 0, false);
    expect(state.getVehicle).toHaveBeenCalledTimes(1); expect(state.getPhoto).toHaveBeenCalledTimes(1);
  });
});
