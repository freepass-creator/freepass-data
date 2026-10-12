import { describe, expect, it, vi } from 'vitest';
import { PHOTO_READ_FAILURE_PHASES, PHOTO_READ_FAILURE_REASONS, type VehiclePhotoReadFailure } from '../src/domain/consumer-output-contract.js';
import { createVehiclePhotoReadFailureObserver, serializeVehiclePhotoReadFailure } from '../src/api/vehicle-photo-read-diagnostic.js';

const observation = (): VehiclePhotoReadFailure => ({ operation: 'INDEXED', phase: 'FINAL_DB', reason: 'DB_FAILURE', elapsedMs: 120, phaseElapsedMs: 20 });
const keys = ['event', 'operation', 'phase', 'reason', 'elapsedMs', 'phaseElapsedMs'];

describe('private indexed and manifest diagnostic privacy', () => {
  it.each(['INDEXED', 'MANIFEST'] as const)('serializes only six fixed fields for %s', operation => {
    const result = serializeVehiclePhotoReadFailure({ ...observation(), operation });
    expect(result).toEqual({ event: 'vehicle_photo_read_failure', ...observation(), operation });
    expect(Object.keys(result!)).toEqual(keys); expect(Object.isFrozen(result)).toBe(true);
  });
  it('accepts the entire shared phase and reason vocabulary', () => {
    for (const phase of PHOTO_READ_FAILURE_PHASES) for (const reason of PHOTO_READ_FAILURE_REASONS) {
      expect(serializeVehiclePhotoReadFailure({ ...observation(), phase, reason })).toMatchObject({ phase, reason });
    }
  });
  it('does not inspect or copy extra sensitive properties and getters', () => {
    let reads = 0;
    const input = { ...observation(), productId: 'private-id', index: 9, count: 51, url: 'https://private.invalid',
      token: 'private-token', body: 'private-body', hash: 'private-hash', refs: ['private-ref'], requestId: 'private-request',
      event: 'private-event' };
    Object.defineProperty(input, 'error', { get() { reads++; throw new Error('private-error'); } });
    Object.defineProperty(input, 'toJSON', { get() { reads++; throw new Error('private-json'); } });
    const result = serializeVehiclePhotoReadFailure(input);
    expect(Object.keys(result!)).toEqual(keys); expect(JSON.stringify(result)).not.toMatch(/private|https|count|index|token|body|hash|refs|requestId/);
    expect(reads).toBe(0);
  });
  it.each(['operation', 'phase', 'reason', 'elapsedMs', 'phaseElapsedMs'])('drops required accessor %s without calling it', key => {
    let reads = 0; const input = observation();
    Object.defineProperty(input, key, { get() { reads++; throw new Error('private-accessor'); } });
    expect(serializeVehiclePhotoReadFailure(input)).toBeUndefined(); expect(reads).toBe(0);
  });
  it('rejects inherited required fields and catches hostile proxy descriptors', () => {
    expect(serializeVehiclePhotoReadFailure(Object.create(observation()))).toBeUndefined();
    expect(serializeVehiclePhotoReadFailure(new Proxy(observation(), { getOwnPropertyDescriptor() { throw new Error('private-proxy'); } }))).toBeUndefined();
    const revoked = Proxy.revocable(observation(), {}); revoked.revoke();
    expect(serializeVehiclePhotoReadFailure(revoked.proxy)).toBeUndefined();
  });
  it.each(['operation', 'phase', 'reason'])('drops unknown %s without coercion', key => {
    for (const value of ['private-value', 'FINAL_DB\nTOKEN=secret', null, 1, { toString() { throw new Error('private-coercion'); } }]) {
      expect(serializeVehiclePhotoReadFailure({ ...observation(), [key]: value })).toBeUndefined();
    }
  });
  it.each([-1, 300001, 0.5, NaN, Infinity, '100', null])('rejects invalid time %j', value => {
    for (const key of ['elapsedMs', 'phaseElapsedMs']) expect(serializeVehiclePhotoReadFailure({ ...observation(), [key]: value })).toBeUndefined();
  });
  it.each([0, 300000])('preserves valid time boundary %i', value => {
    expect(serializeVehiclePhotoReadFailure({ ...observation(), elapsedMs: value, phaseElapsedMs: value })).toMatchObject({ elapsedMs: value, phaseElapsedMs: value });
  });
  it('does not send invalid observations to the sink', () => {
    const sink = vi.fn(), observer = createVehiclePhotoReadFailureObserver(sink);
    observer({ ...observation(), operation: 'private-operation' } as unknown as VehiclePhotoReadFailure);
    expect(sink).not.toHaveBeenCalled();
  });
  it('calls the sink once with a detached immutable whitelist copy', () => {
    const sink = vi.fn(), input = observation();
    createVehiclePhotoReadFailureObserver(sink)(input);
    expect(sink).toHaveBeenCalledTimes(1); expect(sink.mock.calls[0]![0]).not.toBe(input);
    expect(sink.mock.calls[0]![0]).toEqual({ event: 'vehicle_photo_read_failure', ...input });
  });
  it('contains synchronous, asynchronous and malicious thenable sink failures', async () => {
    const then = vi.fn();
    const outcomes = [() => { throw new Error('private-sync'); }, () => Promise.reject(new Error('private-async')),
      () => Object.defineProperty({}, 'then', { get() { then(); throw new Error('private-then'); } }),
      () => ({ then(_resolve: unknown, reject: (error: Error) => void) { reject(new Error('private-reject')); } })];
    for (const sink of outcomes) {
      const observer = createVehiclePhotoReadFailureObserver(sink as () => Promise<void>);
      expect(() => observer(observation())).not.toThrow();
    }
    await new Promise(resolve => setTimeout(resolve, 0)); expect(then).toHaveBeenCalledTimes(1);
  });
  it('default sink prints only the serialized payload', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { createVehiclePhotoReadFailureObserver()(observation()); expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'vehicle_photo_read_failure', ...observation() })); }
    finally { output.mockRestore(); }
  });
});
