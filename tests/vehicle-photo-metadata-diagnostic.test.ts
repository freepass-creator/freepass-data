import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IancarOneApiError } from '../src/adapters/iancar-one-api.js';
import { classifyPhotoMetadataFailure, logPhotoMetadataFailure } from '../src/api/vehicle-photo-metadata-diagnostic.js';
import { createConsumerDataAccessRuntime } from '../src/api/data-access-runtime.js';

const state = vi.hoisted(() => ({
  source: undefined as undefined | ((vehicle: string, plate: string, index?: number, fresh?: boolean) => Promise<unknown>),
  getVehicle: vi.fn(), getPhoto: vi.fn(), factory: vi.fn(), config: vi.fn(),
}));
vi.mock('../src/adapters/iancar-one-api.js', async original => ({ ...await original<typeof import('../src/adapters/iancar-one-api.js')>(),
  createIancarOneApiClient: (...args: unknown[]) => state.factory(...args), iancarOneApiConfigFromEnv: () => state.config() }));
vi.mock('../src/infra/erp5-compat-catalog-reader.js', () => ({
  createFirestoreCatalogCompatibilityReader: (source: typeof state.source) => { state.source = source; return {}; }, isPublicIancarPhotoProduct: () => false,
}));
vi.mock('../src/infra/firestore-data-access-log.js', () => ({ createFirestoreDataAccessLogStore: () => ({}) }));
vi.mock('../src/infra/admin-workflow-firestore.js', () => ({ createFirestoreAdminWorkflowStore: () => ({}) }));
vi.mock('../src/infra/firestore-data-health-reader.js', () => ({ createFirestoreDataHealthReader: () => ({}) }));
vi.mock('../src/infra/firestore-projection-reader.js', () => ({ createFirestoreProjectionReader: () => ({}) }));
vi.mock('../src/infra/estimate-artifacts-firestore.js', () => ({ createFirestoreEstimateArtifactStore: () => ({}) }));

const vehicle = 'private-vehicle', plate = '99가9999';
const detail = () => ({ data: { vehicle_id: vehicle, plate_number: plate, stale: false, photos: [
  { photo_id: 'private-photo', url: `/v1/vehicles/${vehicle}/photos/private-photo`, representative: true },
] } });
beforeEach(() => {
  vi.clearAllMocks(); state.source = undefined;
  state.getVehicle.mockReset().mockResolvedValue(detail()); state.getPhoto.mockReset();
  state.config.mockReset().mockReturnValue({ apiKey: 'private-token' });
  state.factory.mockReset().mockReturnValue({ getVehicle: state.getVehicle, getPhoto: state.getPhoto });
});
afterEach(() => vi.restoreAllMocks());
const invoke = (index: number | undefined = undefined, fresh = true) => {
  createConsumerDataAccessRuntime(); return state.source!(vehicle, plate, index, fresh);
};
const assertSafe = (value: unknown) => {
  expect(Object.keys(value as object)).toEqual(['event', 'stage', 'reason', 'httpStatus']);
  expect(JSON.stringify(value)).not.toMatch(/private-|99가9999|https?:|token|requestId|stack|message|header|operator/);
};

describe('private photo metadata diagnostic classification', () => {
  it.each([100, 200, 429, 503, 599])('keeps only verified numeric HTTP %i', status => {
    const value = classifyPhotoMetadataFailure('FETCH_DETAIL', new IancarOneApiError(`IANCAR_ONE_API_HTTP_${status}`, status, 'private-request', 12), true);
    expect(value).toEqual({ event: 'vehicle_photo_metadata_failure', stage: 'FETCH_DETAIL', reason: 'HTTP_FAILURE', httpStatus: status }); assertSafe(value);
  });
  it.each([0, 99, 600, NaN, Infinity, 503.5, '503', { token: 'private-token' }])('does not expose invalid or unverified HTTP status %j', status => {
    const value = classifyPhotoMetadataFailure('FETCH_DETAIL', new IancarOneApiError('IANCAR_ONE_API_HTTP_503', status as number), true);
    expect(value.reason).toBe('UNKNOWN'); expect(value.httpStatus).toBeNull(); assertSafe(value);
  });
  it.each(['IANCAR_ONE_API_EMPTY_RESPONSE', 'IANCAR_ONE_API_NON_JSON_RESPONSE', 'IANCAR_ONE_API_UNSUPPORTED_JSON'])('maps recognised JSON failure %s without body or request ID', code => {
    const value = classifyPhotoMetadataFailure('FETCH_DETAIL', new IancarOneApiError(code, 200, 'private-request'), true);
    expect(value.reason).toBe('JSON_FAILURE'); expect(value.httpStatus).toBe(200); assertSafe(value);
  });
  it.each(['TimeoutError', 'AbortError'])('recognises native %s and ignores an overridden name getter', name => {
    const error = new DOMException('private-url private-token', name);
    let reads = 0; Object.defineProperty(error, 'name', { get() { reads++; throw new Error('private-getter'); } });
    const value = classifyPhotoMetadataFailure('FETCH_DETAIL', error, true);
    expect(value.reason).toBe('TIMEOUT'); expect(reads).toBe(0); assertSafe(value);
  });
  it('classifies transport only after a request attempt, not factory or metadata TypeErrors', () => {
    const error = new TypeError('private transport details');
    expect(classifyPhotoMetadataFailure('FETCH_DETAIL', error, true).reason).toBe('TRANSPORT');
    expect(classifyPhotoMetadataFailure('FETCH_DETAIL', error).reason).toBe('UNKNOWN');
    expect(classifyPhotoMetadataFailure('VALIDATE_METADATA', error, true).reason).toBe('UNKNOWN');
  });
  it.each([
    ['IANCAR_PHOTO_IDENTITY_MISMATCH', 'IDENTITY_MISMATCH'], ['IANCAR_PHOTO_DETAIL_STALE', 'STALE_DETAIL'],
    ['IANCAR_PHOTO_LIST_MISSING', 'LIST_INVALID'], ['IANCAR_PHOTO_LIMIT_EXCEEDED', 'LIST_INVALID'],
    ['IANCAR_PHOTO_REFERENCE_INVALID', 'LIST_INVALID'], ['IANCAR_PHOTO_REPRESENTATIVE_AMBIGUOUS', 'LIST_INVALID'],
  ])('maps only recognised metadata %s to a fixed reason', (code, reason) => {
    const value = classifyPhotoMetadataFailure('VALIDATE_METADATA', new IancarOneApiError(code!, 503, 'private-request'));
    expect(value.reason).toBe(reason); expect(value.httpStatus).toBeNull(); assertSafe(value);
  });
  it('ignores arbitrary error strings, spoofed names/statuses and getters', () => {
    for (const error of ['private-token', { name: 'TimeoutError', code: 'IANCAR_ONE_API_HTTP_503', status: 503 },
      Object.assign(new Error('private-message'), { name: 'TimeoutError', code: 'private-code', status: 503 }),
      new IancarOneApiError('private-code', 503, 'private-request')]) {
      const value = classifyPhotoMetadataFailure('FETCH_DETAIL', error, true); expect(value.reason).toBe('UNKNOWN'); expect(value.httpStatus).toBeNull(); assertSafe(value);
    }
    const error = new IancarOneApiError('private-code'); let reads = 0;
    Object.defineProperty(error, 'code', { get() { reads++; throw new Error('private-getter'); } });
    expect(classifyPhotoMetadataFailure('FETCH_DETAIL', error, true).reason).toBe('UNKNOWN'); expect(reads).toBe(0);
    const proxy = new Proxy(error, { getOwnPropertyDescriptor() { throw new Error('private-proxy'); } });
    assertSafe(classifyPhotoMetadataFailure('FETCH_DETAIL', proxy, true));
  });
  it('contains synchronous and asynchronous sink failures', async () => {
    expect(() => logPhotoMetadataFailure('FETCH_DETAIL', new Error('private-error'), false, () => { throw new Error('private-sink'); })).not.toThrow();
    logPhotoMetadataFailure('FETCH_DETAIL', new Error('private-error'), false, async () => { throw new Error('private-async-sink'); });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});

describe('runtime callback metadata observation boundaries', () => {
  it('logs one detail failure and preserves the exact original exception', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {}), error = new IancarOneApiError('IANCAR_ONE_API_HTTP_503', 503, 'private-request');
    state.getVehicle.mockRejectedValue(error);
    await expect(invoke()).rejects.toBe(error); expect(output).toHaveBeenCalledTimes(1);
    const value = JSON.parse(output.mock.calls[0]![0] as string); assertSafe(value);
    expect(value).toMatchObject({ stage: 'FETCH_DETAIL', reason: 'HTTP_FAILURE', httpStatus: 503 });
    expect(state.getVehicle).toHaveBeenCalledTimes(1); expect(state.getPhoto).not.toHaveBeenCalled();
  });
  it.each(['factory', 'config', 'missing-key'])('logs factory/preflight %s exactly once without detail or byte reads', async kind => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {}), error = new Error('private-factory');
    if (kind === 'factory') state.factory.mockImplementation(() => { throw error; });
    if (kind === 'config') state.config.mockImplementation(() => { throw error; });
    if (kind === 'missing-key') state.config.mockReturnValue({ apiKey: '' });
    const promise = invoke();
    if (kind === 'missing-key') await expect(promise).rejects.toThrow('VEHICLE_PHOTO_READER_UNAVAILABLE'); else await expect(promise).rejects.toBe(error);
    expect(output).toHaveBeenCalledTimes(1); expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ stage: 'FETCH_DETAIL', reason: 'UNKNOWN', httpStatus: null });
    expect(state.getVehicle).not.toHaveBeenCalled(); expect(state.getPhoto).not.toHaveBeenCalled();
  });
  it.each(['identity', 'stale', 'list'])('logs one metadata %s failure without original detail output', async kind => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {}), input = detail() as any;
    if (kind === 'identity') input.data.vehicle_id = 'private-other';
    if (kind === 'stale') input.data.stale = true;
    if (kind === 'list') input.data.photos = 'private-body';
    state.getVehicle.mockResolvedValue(input);
    await expect(invoke()).rejects.toBeInstanceOf(IancarOneApiError); expect(output).toHaveBeenCalledTimes(1);
    const value = JSON.parse(output.mock.calls[0]![0] as string); assertSafe(value); expect(value.stage).toBe('VALIDATE_METADATA'); expect(state.getPhoto).not.toHaveBeenCalled();
  });
  it('returns the original successful metadata with no diagnostics or byte reads', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await invoke()).toEqual({ count: 1, photoIds: ['private-photo'], upstreamPhotoIds: ['private-photo'], upstreamRepresentatives: [true], servingSourceOrdinals: [0], bytes: null, contentType: 'application/json' });
    expect(output).not.toHaveBeenCalled(); expect(state.getPhoto).not.toHaveBeenCalled();
  });
  it('keeps the original error when the observation sink throws', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('private-sink'); }), error = new IancarOneApiError('IANCAR_ONE_API_HTTP_503', 503);
    state.getVehicle.mockRejectedValue(error); await expect(invoke()).rejects.toBe(error); expect(output).toHaveBeenCalledTimes(1);
  });
  it.each([{ index: 0, fresh: true }, { index: undefined, fresh: false }, { index: 0, fresh: false }])('does not log detail failures outside fresh index-less metadata: %j', async ({ index, fresh }) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {}), error = new Error('private-detail');
    state.getVehicle.mockRejectedValue(error); await expect(invoke(index, fresh)).rejects.toBe(error); expect(output).not.toHaveBeenCalled();
  });
  it('does not log original byte acquisition failures', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {}), error = new Error('private-bytes');
    state.getPhoto.mockRejectedValue(error); await expect(invoke(0, true)).rejects.toBe(error);
    expect(output).not.toHaveBeenCalled(); expect(state.getPhoto).toHaveBeenCalledTimes(1);
  });
  it('does not log byte decoding failures', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    state.getPhoto.mockResolvedValue(new Response('private-not-image', { headers: { 'content-type': 'image/jpeg' } }));
    await expect(invoke(0, true)).rejects.toMatchObject({ code: 'IANCAR_PHOTO_MEDIA_SIGNATURE_INVALID' });
    expect(output).not.toHaveBeenCalled(); expect(state.getPhoto).toHaveBeenCalledTimes(1);
  });
});
