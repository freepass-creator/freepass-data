import { expect, it, vi } from 'vitest';
import { createVehiclePhotoReader } from '../src/domain/consumer-output-contract.js';
import { createHash } from 'node:crypto';
import { iancarReviewedContentSetDigest } from '../src/domain/consumer-output-contract.js';
function fixture(sink = vi.fn()) {
    const bytes = Buffer.from([255, 216, 255, 1]);
    const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
    const binding = digest(['RP031', 'synthetic', 'vehicle', 'plate']);
    const ref = { sourceKind: 'IANCAR_ONE', sourceApiVersion: 'iancar-one-api/1', sourceBindingDigest: binding,
        sourceOrdinal: 0, servingIndex: 0, representative: true, reviewBasis: 'CONTENT_ORDINAL/1',
        mediaType: 'image/jpeg', photoSha256: createHash('sha256').update(bytes).digest('hex'),
        vehiclePhotoVerifiedBy: 'synthetic-reviewer', vehiclePhotoVerificationMethod: 'synthetic-method',
        vehiclePhotoVerifiedAt: '2026-10-11T00:00:00.000Z', photoSetDigest: '' };
    ref.photoSetDigest = iancarReviewedContentSetDigest(binding, [ref]);
    let product = { provider_company_code: 'RP031', listable: true, status_kind: '가용',
        iancar_one_vehicle_id: 'vehicle', car_number: 'plate', photo_original_refs: [ref] };
    let time = 1000;
    const now = vi.fn(() => time);
    const db = vi.fn(async () => product);
    const metadata = { count: 1, photoIds: ['opaque'], upstreamPhotoIds: ['opaque'], upstreamRepresentatives: [true], servingSourceOrdinals: [0] };
    const read = vi.fn(async (_p, index) => ({ ...metadata, bytes: index === undefined ? null : bytes,
        contentType: index === undefined ? 'application/json' : 'image/jpeg' }));
    const source = { eligible: (p) => p?.listable === true, connection: (p) => p.iancar_one_vehicle_id, read };
    const reader = observerReader(db, source, now, sink);
    return { reader, sink, db, now, read, metadata, bytes, product, setProduct: (p) => { product = p; }, advance: (ms) => { time += ms; } };
}
const observerReader = (db, source, now, observer) => createVehiclePhotoReader(db, source, undefined, now, observer);
it('observes an initial database failure once without replacing the original error or touching cache clock', async () => {
    const error = new Error('private sentinel https://secret.invalid/token');
    const sink = vi.fn();
    const now = vi.fn(() => 1000);
    const reader = observerReader(vi.fn().mockRejectedValue(error), undefined, now, sink);
    await expect(reader('erp5-public-media', 'synthetic', 0)).rejects.toBe(error);
    expect(now).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({ operation: 'INDEXED', phase: 'INITIAL_DB', reason: 'DB_FAILURE' });
    expect(Object.keys(sink.mock.calls[0][0]).sort()).toEqual(['elapsedMs', 'operation', 'phase', 'phaseElapsedMs', 'reason']);
    expect(JSON.stringify(sink.mock.calls)).not.toContain('sentinel');
});
it.each([() => { throw new Error('sink'); }, () => Promise.reject(new Error('sink'))])('sink failure cannot change an initial public rejection', async (sink) => {
    const source = { eligible: () => true, connection: () => '', read: vi.fn() };
    const reader = observerReader(async () => ({ provider_company_code: 'RP031', listable: false }), source, Date.now, sink);
    await expect(reader('erp5-public-media', 'synthetic')).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    expect(source.read).not.toHaveBeenCalled();
    await Promise.resolve();
});
it.each(['approval', 'basis', 'withdrawal'])('initial %s failure emits once and never fetches source', async (kind) => {
    const f = fixture();
    if (kind === 'approval')
        f.product.photo_original_refs[0].vehiclePhotoVerifiedBy = '';
    if (kind === 'basis')
        f.product.photo_original_refs[0].reviewBasis = 'UNKNOWN';
    if (kind === 'withdrawal')
        f.product.publication_withdrawal = {};
    await expect(f.reader('erp5-public-media', 'synthetic', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    expect(f.sink).toHaveBeenCalledTimes(1);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.now).not.toHaveBeenCalled();
});
it.each(['layout', 'mime', 'hash'])('reports %s failure without changing original rejection', async (kind) => {
    const f = fixture();
    f.read.mockResolvedValueOnce({ ...f.metadata, count: kind === 'layout' ? 0 : 1,
        bytes: kind === 'hash' ? Buffer.from([255, 216, 255, 2]) : f.bytes, contentType: kind === 'mime' ? 'image/png' : 'image/jpeg' });
    await expect(f.reader('erp5-public-media', 'synthetic', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    expect(f.sink).toHaveBeenCalledTimes(1);
    expect(f.sink.mock.calls[0][0].reason).toBe({ layout: 'LAYOUT_MISMATCH', mime: 'MEDIA_INVALID', hash: 'HASH_MISMATCH' }[kind]);
    expect(f.read).toHaveBeenCalledTimes(1);
});
it.each(['database', 'proof', 'source', 'membership'])('final %s failure preserves false, eviction and emit-once', async (kind) => {
    const f = fixture();
    const result = await f.reader('erp5-public-media', 'synthetic', 0);
    expect(f.sink).not.toHaveBeenCalled();
    if (kind === 'database')
        f.db.mockRejectedValueOnce(new Error('secret'));
    if (kind === 'proof')
        f.setProduct({ ...f.product, publication_withdrawal: {} });
    if (kind === 'source')
        f.read.mockRejectedValueOnce(new Error('secret'));
    if (kind === 'membership')
        f.read.mockResolvedValueOnce({ ...f.metadata, count: 0, bytes: null, contentType: 'application/json' });
    expect(await result.revalidate()).toBe(false);
    expect(f.sink).toHaveBeenCalledTimes(1);
    expect(await result.revalidate()).toBe(kind === 'proof' ? false : true);
    expect(f.sink).toHaveBeenCalledTimes(1);
});
it('warm expiration preserves the absolute cache boundary without diagnostic cache-clock calls', async () => {
    const observed = fixture();
    const plain = fixture(null);
    for (const f of [observed, plain]) {
        const cold = await f.reader('erp5-public-media', 'synthetic', 0);
        expect(await cold.revalidate()).toBe(true);
        f.advance(29_000);
        const warm = await f.reader('erp5-public-media', 'synthetic', 0);
        f.advance(1000);
        expect(await warm.revalidate()).toBe(false);
        await f.reader('erp5-public-media', 'synthetic', 0);
    }
    expect(observed.now.mock.calls.length).toBe(plain.now.mock.calls.length);
    expect(observed.read.mock.calls.map(c => c[1])).toEqual(plain.read.mock.calls.map(c => c[1]));
    expect(observed.sink.mock.calls[0][0]).toMatchObject({ phase: 'REUSE_TTL', reason: 'REUSE_EXPIRED' });
});
it('shared failure emits independently for each caller with only one source read', async () => {
    const f = fixture();
    let release;
    const gate = new Promise(r => { release = r; });
    f.read.mockImplementationOnce(async () => { await gate; throw new Error('private https://secret.invalid'); });
    const calls = [f.reader('erp5-public-media', 'synthetic', 0), f.reader('erp5-public-media', 'synthetic', 0)];
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    release();
    expect((await Promise.allSettled(calls)).every(r => r.status === 'rejected')).toBe(true);
    expect(f.sink).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.sink.mock.calls)).not.toContain('secret');
});
it('successful cold/warm/manifest reads log nothing and preserve source and database calls', async () => {
    const f = fixture();
    const cold = await f.reader('erp5-public-media', 'synthetic', 0);
    expect(await cold.revalidate()).toBe(true);
    const warm = await f.reader('erp5-public-media', 'synthetic', 0);
    expect(await warm.revalidate()).toBe(true);
    const manifest = await f.reader('erp5-public-media', 'synthetic');
    expect(await manifest.revalidate()).toBe(true);
    expect(f.read.mock.calls.map(c => c[1])).toEqual([0, undefined, undefined, undefined, undefined]);
    expect(f.db).toHaveBeenCalledTimes(9);
    expect(f.sink).not.toHaveBeenCalled();
});
it('a hostile observer thenable is isolated and durations are bounded integers', async () => {
    const payloads = [];
    const reader = observerReader(async () => { throw new Error('private'); }, undefined, Date.now, (p) => {
        payloads.push(p);
        return Object.defineProperty({}, 'then', { get() { throw new Error('then'); } });
    });
    await expect(reader('erp5-public-media', 'synthetic')).rejects.toThrow('private');
    await Promise.resolve();
    expect(payloads).toHaveLength(1);
    for (const key of ['elapsedMs', 'phaseElapsedMs']) {
        expect(Number.isInteger(payloads[0][key])).toBe(true);
        expect(payloads[0][key]).toBeGreaterThanOrEqual(0);
        expect(payloads[0][key]).toBeLessThanOrEqual(300_000);
    }
});
it('source error classification does not add reads of a message getter', async () => {
    const f = fixture();
    let reads = 0;
    const error = new Error();
    Object.defineProperty(error, 'message', { get() { reads++; return 'VEHICLE_PHOTO_NOT_FOUND'; } });
    f.read.mockRejectedValueOnce(error);
    await expect(f.reader('erp5-public-media', 'synthetic', 0)).rejects.toBe(error);
    expect(reads).toBe(1);
    expect(f.sink).toHaveBeenCalledTimes(1);
});
it('invalid monotonic timing is clamped without changing the original error', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(NaN);
    try {
        const sink = vi.fn();
        const error = new Error('original');
        const reader = observerReader(async () => { throw error; }, undefined, Date.now, sink);
        await expect(reader('erp5-public-media', 'synthetic')).rejects.toBe(error);
        expect(sink.mock.calls[0][0]).toMatchObject({ elapsedMs: 0, phaseElapsedMs: 0 });
    }
    finally {
        clock.mockRestore();
    }
});
it('selected missing remains a rejection without claiming source identity failure', async () => {
    const f = fixture();
    delete f.product.photo_original_refs[0].sourceKind;
    delete f.product.photo_original_refs[0].reviewBasis;
    await expect(f.reader('erp5-public-media', 'synthetic', 2)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    expect(f.sink.mock.calls[0][0]).toMatchObject({ phase: 'RESULT_LAYOUT', reason: 'SELECTED_MISSING' });
});
it('validation exceptions after a successful source response are not source transport failures', async () => {
    const f = fixture();
    let reads = 0;
    const response = Object.defineProperty({ ...f.metadata, bytes: f.bytes, contentType: 'image/jpeg' }, 'photoIds', {
        get() { reads++; throw new Error('private validation sentinel'); },
    });
    f.read.mockResolvedValueOnce(response);
    await expect(f.reader('erp5-public-media', 'synthetic', 0)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    expect(reads).toBe(1);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.sink.mock.calls[0][0]).toMatchObject({ phase: 'RESULT_LAYOUT', reason: 'UNKNOWN' });
    expect(f.sink).toHaveBeenCalledTimes(1);
});
it('final metadata validation exceptions preserve false and are classified as unknown membership validation', async () => {
    const f = fixture();
    const result = await f.reader('erp5-public-media', 'synthetic', 0);
    let reads = 0;
    f.read.mockResolvedValueOnce(Object.defineProperty({ ...f.metadata, bytes: null, contentType: 'application/json' }, 'photoIds', {
        get() { reads++; throw new Error('private final sentinel'); },
    }));
    expect(await result.revalidate()).toBe(false);
    expect(reads).toBe(1);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.db).toHaveBeenCalledTimes(3);
    expect(f.sink.mock.calls[0][0]).toMatchObject({ phase: 'FINAL_MEMBERSHIP', reason: 'UNKNOWN' });
    expect(f.sink).toHaveBeenCalledTimes(1);
    await f.reader('erp5-public-media', 'synthetic', 0);
    expect(f.read).toHaveBeenCalledTimes(3);
});
it('a shared validation rejection never labels the follower as a source transport failure', async () => {
    const f = fixture();
    let release;
    let reads = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const response = Object.defineProperty({ ...f.metadata, bytes: f.bytes, contentType: 'image/jpeg' }, 'photoIds', {
        get() { reads++; throw new Error('private shared validation'); },
    });
    f.read.mockImplementationOnce(async () => { await gate; return response; });
    const calls = [f.reader('erp5-public-media', 'synthetic', 0), f.reader('erp5-public-media', 'synthetic', 0)];
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    release();
    const results = await Promise.allSettled(calls);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(results[0].reason).toBe(results[1].reason);
    expect(reads).toBe(1);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.sink).toHaveBeenCalledTimes(2);
    expect(f.sink.mock.calls.map(call => [call[0].phase, call[0].reason])).toEqual([
        ['RESULT_LAYOUT', 'UNKNOWN'], ['SOURCE_AWAIT', 'UNKNOWN'],
    ]);
    await f.reader('erp5-public-media', 'synthetic', 0);
    expect(f.read).toHaveBeenCalledTimes(2);
});
