import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createConsumerGateway, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
const render = vi.hoisted(() => vi.fn());
vi.mock('../src/adapters/vehicle-photo-rendition.js', () => ({ renderVehiclePhotoRendition: render }));
const token = 'test-photo-size-token-0123456789abcdef';
const headers = { authorization: `Bearer ${token}` };
const base = '/v1/consumers/erp-com/catalog-compat/products/P1/photos';
const original = Buffer.from([255, 216, 255, 1, 2, 3]);
const derived = Buffer.from([255, 216, 255, 9]);
function setup(binding: ConsumerBinding = { id: 'erp-com', projectionId: 'erp-public', token, capabilities: ['catalog'] }) {
  render.mockReset().mockResolvedValue({ bytes: derived, contentType: 'image/jpeg' });
  const revalidate = vi.fn(async () => true);
  const readVehiclePhoto = vi.fn(async (_consumer: string, _product: string, index?: number) => ({ count: 1,
    bytes: index === undefined ? null : original, contentType: index === undefined ? 'application/json' : 'image/jpeg', revalidate }));
  const logs = new MemoryDataAccessLogStore();
  const read = vi.fn(async () => { throw new Error('unused full catalog'); });
  const app = createConsumerGateway(new MemoryDataStore(), [binding], new DataAccessGateway(logs), undefined,
    { read, readVehiclePhoto });
  return { app, logs, read, readVehiclePhoto, revalidate };
}
describe('WIRE_FREEZE_V1 photo size gateway', () => {
  it.each(['list', 'detail'])('renders %s after audited original read and before final revalidation', async size => {
    const { app, logs, readVehiclePhoto, revalidate } = setup();
    render.mockImplementation(async () => {
      expect(logs.events.some(event => event.phase === 'SUCCEEDED')).toBe(true);
      expect(revalidate).not.toHaveBeenCalled(); return { bytes: derived, contentType: 'image/jpeg' };
    });
    const hash = createHash('sha256').update(original).digest('hex');
    const response = await app.inject({ url: base + '/0?size=' + size, headers });
    expect(response.statusCode).toBe(200); expect(response.rawPayload).toEqual(derived);
    expect(render).toHaveBeenCalledExactlyOnceWith({ bytes: original, contentType: 'image/jpeg' }, size, { signal: expect.any(AbortSignal) });
    expect(readVehiclePhoto).toHaveBeenCalledExactlyOnceWith('erp-com', 'P1', 0); expect(revalidate).toHaveBeenCalledTimes(1);
    expect(createHash('sha256').update(original).digest('hex')).toBe(hash);
    expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });
  it('omitted size preserves original bytes and type without rendering', async () => {
    const { app, revalidate } = setup(); const response = await app.inject({ url: base + '/0', headers });
    expect(response.statusCode).toBe(200); expect(response.rawPayload).toEqual(original);
    expect(response.headers['content-type']).toContain('image/jpeg'); expect(render).not.toHaveBeenCalled(); expect(revalidate).toHaveBeenCalledTimes(1); await app.close();
  });
  it.each(['size=full', 'size=', 'size=unknown', 'size=LIST', 'size=list&size=list', 'size=list&size=detail', 'size[]=list', 'rendition=list', 'other=1', 'size=list&other=1'])('rejects query %s before Domain or bytes access', async query => {
    const { app, readVehiclePhoto, revalidate } = setup();
    expect((await app.inject({ url: base + '/0?' + query, headers })).statusCode).toBe(400);
    expect(readVehiclePhoto).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled(); expect(revalidate).not.toHaveBeenCalled(); await app.close();
  });
  it.each(['size=list', 'size=detail', 'size=full', 'rendition=list', 'other=1'])('rejects manifest query %s without source reads', async query => {
    const { app, readVehiclePhoto } = setup();
    expect((await app.inject({ url: base + '?' + query, headers })).statusCode).toBe(400);
    expect(readVehiclePhoto).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled(); await app.close();
  });
  it('keeps manifest without query unchanged and never renders it', async () => {
    const { app } = setup(); const response = await app.inject({ url: base, headers });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ schema: 'freepass-data.product-photos/v1', productId: 'P1', count: 1 });
    expect(render).not.toHaveBeenCalled(); await app.close();
  });
  it('authenticates before query validation and never transforms unauthorized data', async () => {
    const { app, readVehiclePhoto } = setup();
    expect((await app.inject({ url: base + '/0?size=unknown' })).statusCode).toBe(401);
    expect(readVehiclePhoto).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled(); await app.close();
  });
  it('keeps capability denial before query and rendering', async () => {
    const { app, readVehiclePhoto } = setup({ id: 'erp5-public-catalog', projectionId: 'erp-public', token, capabilities: ['catalog'] });
    expect((await app.inject({ url: base.replace('erp-com', 'erp5-public-catalog') + '/0?size=list', headers })).statusCode).toBe(403);
    expect(readVehiclePhoto).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled(); await app.close();
  });
  it('preserves the existing photos-only consumer grant for sized bytes', async () => {
    const { app, readVehiclePhoto } = setup({ id: 'erp5-public-media', projectionId: 'erp-public', token, capabilities: ['photos'] });
    const response = await app.inject({ url: base.replace('erp-com', 'erp5-public-media') + '/0?size=list', headers });
    expect(response.statusCode).toBe(200); expect(readVehiclePhoto).toHaveBeenCalledExactlyOnceWith('erp5-public-media', 'P1', 0);
    expect(render).toHaveBeenCalledTimes(1); await app.close();
  });
  it('does not render after a success audit failure', async () => {
    const { app, logs } = setup(); vi.spyOn(logs, 'appendDataAccessEvent').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private-audit'));
    expect((await app.inject({ url: base + '/0?size=list', headers })).statusCode).toBe(503);
    expect(render).not.toHaveBeenCalled(); await app.close();
  });
  it.each(['VEHICLE_PHOTO_BUSY', 'VEHICLE_PHOTO_UNAVAILABLE', 'private-renderer-error'])('fails closed on renderer %s without original fallback', async error => {
    const { app, revalidate } = setup(); render.mockRejectedValueOnce(new Error(error));
    const response = await app.inject({ url: base + '/0?size=list', headers });
    expect(response.statusCode).toBe(error === 'VEHICLE_PHOTO_BUSY' ? 429 : 503);
    if (error === 'VEHICLE_PHOTO_BUSY') expect(response.headers['retry-after']).toBe('2');
    expect(response.rawPayload).not.toEqual(original); expect(response.body).not.toContain('private-renderer');
    expect(revalidate).not.toHaveBeenCalled(); await app.close();
  });
  it('blocks withdrawal that happens during the transform await', async () => {
    const { app, revalidate } = setup(); let resolve!: (value: unknown) => void;
    render.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = app.inject({ url: base + '/0?size=detail', headers }).then(v => v);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    expect(revalidate).not.toHaveBeenCalled(); revalidate.mockResolvedValueOnce(false); resolve({ bytes: derived, contentType: 'image/jpeg' });
    const response = await pending; expect(response.statusCode).toBe(404); expect(response.rawPayload).not.toEqual(derived);
    expect(revalidate).toHaveBeenCalledTimes(1); await app.close();
  });
  it('connects response close to render abort and prevents final checks after abort', async () => {
    const { app, revalidate, logs } = setup();
    let raw!: import('node:http').ServerResponse;
    app.addHook('onRequest', async (_request, reply) => { raw = reply.raw; });
    render.mockImplementationOnce(async (_input, _size, options) => {
      expect(options.signal.aborted).toBe(false); raw.emit('close');
      expect(options.signal.aborted).toBe(true);
      return { bytes: derived, contentType: 'image/jpeg' };
    });
    await expect(app.inject({ url: base + '/0?size=list', headers })).rejects.toThrow('response destroyed before completion');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(revalidate).not.toHaveBeenCalled();
    // The existing original-read audit already succeeded before rendering began.
    expect(logs.events.filter(event => event.phase === 'SUCCEEDED')).toHaveLength(1); await app.close();
  });
  it('refuses malformed original media before rendering', async () => {
    const { app, readVehiclePhoto, revalidate } = setup(); readVehiclePhoto.mockResolvedValueOnce({ count: 1, bytes: Buffer.from('bad'), contentType: 'image/jpeg', revalidate });
    expect((await app.inject({ url: base + '/0?size=list', headers })).statusCode).toBe(503); expect(render).not.toHaveBeenCalled(); await app.close();
  });
  it.each([{ bytes: Buffer.from('bad'), contentType: 'image/jpeg' }, { bytes: derived, contentType: 'image/png' }, { bytes: Buffer.alloc(8 * 1024 * 1024 + 1), contentType: 'image/jpeg' }])('refuses invalid derived media', async output => {
    const { app, revalidate } = setup(); render.mockResolvedValueOnce(output);
    expect((await app.inject({ url: base + '/0?size=list', headers })).statusCode).toBe(503);
    expect(revalidate).not.toHaveBeenCalled(); await app.close();
  });
  it.each(['size=list', 'size=', 'size=full', 'size=list&size=detail', 'rendition=list', 'rendition=full'])('rejects photo query on quote before snapshot: %s', async query => {
    const { app, read, readVehiclePhoto } = setup();
    const response = await app.inject({ url: '/v1/public/catalog/quote?code=P1&' + query });
    expect(response.statusCode).toBe(400); expect(read).not.toHaveBeenCalled(); expect(readVehiclePhoto).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled(); await app.close();
  });
  it('keeps unrelated quote query behavior unchanged', async () => {
    const { app, read } = setup();
    const response = await app.inject({ url: '/v1/public/catalog/quote?code=P1&unrelated=1' });
    expect(response.statusCode).toBe(503); expect(read).toHaveBeenCalledTimes(1); expect(render).not.toHaveBeenCalled(); await app.close();
  });
});
