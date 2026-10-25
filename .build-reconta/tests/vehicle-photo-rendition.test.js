import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { renderVehiclePhotoRendition } from '../src/adapters/vehicle-photo-rendition.js';
const image = (width, height) => sharp({ create: { width, height, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 0.5 } } }).png().toBuffer();
describe('V1/size 사진 압축 출력', () => {
    it.each([['list', 480], ['detail', 960]])('%s는 JPEG와 bounded 비율을 유지하고 원본 buffer를 바꾸지 않는다', async (size, bound) => {
        const bytes = await image(1600, 1000), original = Buffer.from(bytes);
        const result = await renderVehiclePhotoRendition({ bytes, contentType: 'image/png' }, size);
        const metadata = await sharp(result.bytes).metadata();
        expect(result.contentType).toBe('image/jpeg');
        expect(metadata.format).toBe('jpeg');
        expect(metadata.width).toBe(bound);
        expect(metadata.height).toBe(Math.round(bound * 1000 / 1600));
        expect(result.bytes.length).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(metadata.exif).toBeUndefined();
        expect(bytes).toEqual(original);
    });
    it('보관용 사본은 긴 변·품질을 더 줄일 수 있고(800px·72), 범위 밖 값은 거부한다', async () => {
        // 사진처럼 무늬가 있는 입력(단색은 압축 차이가 안 난다)
        const raw = Buffer.alloc(1600 * 1000 * 3);
        for (let i = 0; i < raw.length; i++)
            raw[i] = (i * 2654435761) >>> 24;
        const bytes = await sharp(raw, { raw: { width: 1600, height: 1000, channels: 3 } }).png().toBuffer();
        const base = await renderVehiclePhotoRendition({ bytes, contentType: 'image/png' }, 'detail');
        const small = await renderVehiclePhotoRendition({ bytes, contentType: 'image/png' }, 'detail', { maxEdge: 800, quality: 72 });
        expect((await sharp(small.bytes).metadata()).width).toBe(800);
        expect(small.bytes.length).toBeLessThan(base.bytes.length);
        await expect(renderVehiclePhotoRendition({ bytes, contentType: 'image/png' }, 'detail', { maxEdge: 100 })).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
        await expect(renderVehiclePhotoRendition({ bytes, contentType: 'image/png' }, 'detail', { quality: 99 })).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    });
    it('세로 사진도 inside 범위를 넘지 않고 작은 사진을 확대하지 않는다', async () => {
        for (const [width, height, expectedWidth, expectedHeight] of [[1000, 1600, 300, 480], [100, 80, 100, 80]]) {
            const result = await renderVehiclePhotoRendition({ bytes: await image(width, height), contentType: 'image/png' }, 'list');
            const metadata = await sharp(result.bytes).metadata();
            expect([metadata.width, metadata.height]).toEqual([expectedWidth, expectedHeight]);
        }
    });
    it('방향을 적용하고 EXIF를 제거한다', async () => {
        const bytes = await sharp(await image(800, 400)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
        const result = await renderVehiclePhotoRendition({ bytes, contentType: 'image/jpeg' }, 'list');
        const metadata = await sharp(result.bytes).metadata();
        expect([metadata.width, metadata.height]).toEqual([240, 480]);
        expect(metadata.exif).toBeUndefined();
    });
    it('24MP 합성 입력을 bounded 출력으로 변환한다', async () => {
        const bytes = await image(6000, 4000);
        const start = performance.now(), before = process.memoryUsage().rss;
        let sampledRss = before;
        const sample = setInterval(() => { sampledRss = Math.max(sampledRss, process.memoryUsage().rss); }, 10);
        let result;
        try {
            result = await renderVehiclePhotoRendition({ bytes, contentType: 'image/png' }, 'detail');
        }
        finally {
            clearInterval(sample);
        }
        const after = process.memoryUsage().rss;
        console.info(JSON.stringify({ test: 'synthetic_24mp', inputBytes: bytes.length, outputBytes: result.bytes.length,
            elapsedMs: Math.round(performance.now() - start), rssBefore: before, rssAfter: after,
            sampledMaxRss: Math.max(sampledRss, after) }));
        const metadata = await sharp(result.bytes).metadata();
        expect([metadata.width, metadata.height]).toEqual([960, 640]);
    });
    it('초과 pixel·손상 입력은 원본 fallback 없이 고정 오류로 끝난다', async () => {
        for (const bytes of [await image(6001, 4000), Buffer.from([255, 216, 255, 1])]) {
            await expect(renderVehiclePhotoRendition({ bytes, contentType: bytes[0] === 255 ? 'image/jpeg' : 'image/png' }, 'list'))
                .rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
        }
    });
    it('허용하지 않은 MIME·signature·size·8MiB 초과를 거부한다', async () => {
        const bytes = await image(40, 40);
        for (const input of [{ bytes, contentType: 'image/svg+xml' }, { bytes, contentType: 'image/jpeg' },
            { bytes: Buffer.alloc(0), contentType: 'image/png' }, { bytes: Buffer.alloc(8 * 1024 * 1024 + 1), contentType: 'image/png' }])
            await expect(renderVehiclePhotoRendition(input, 'list')).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
        await expect(renderVehiclePhotoRendition({ bytes, contentType: 'image/png' }, 'full')).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    });
    it('동시 렌더는 대기 없이 BUSY로 차단하고 완료 뒤 slot을 반환한다', async () => {
        const input = { bytes: await image(1600, 1000), contentType: 'image/png' };
        const first = renderVehiclePhotoRendition(input, 'list');
        await expect(renderVehiclePhotoRendition(input, 'detail')).rejects.toThrow('VEHICLE_PHOTO_BUSY');
        await first;
        await expect(renderVehiclePhotoRendition(input, 'list')).resolves.toHaveProperty('contentType', 'image/jpeg');
    });
    it('이미 취소된 요청은 decode 전에 차단한다', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(renderVehiclePhotoRendition({ bytes: await image(40, 40), contentType: 'image/png' }, 'list', { signal: controller.signal }))
            .rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    });
    it.each(['abort', 'timeout'])('native work 대기 중 %s는 fail-closed하며 slot을 일찍 재사용하지 않는다', async (mode) => {
        const bytes = await image(40, 40), controller = new AbortController();
        let finish;
        const spy = vi.spyOn(sharp.prototype, 'toBuffer').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const start = performance.now();
        try {
            const pending = renderVehiclePhotoRendition({ bytes, contentType: 'image/png' }, 'list', { signal: controller.signal });
            if (mode === 'abort')
                controller.abort();
            await expect(pending).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
            expect(performance.now() - start).toBeLessThan(4000);
            await expect(renderVehiclePhotoRendition({ bytes, contentType: 'image/png' }, 'list')).rejects.toThrow('VEHICLE_PHOTO_BUSY');
            finish(Buffer.from([255, 216, 255, 1]));
            await new Promise(resolve => setImmediate(resolve));
        }
        finally {
            spy.mockRestore();
        }
        await expect(renderVehiclePhotoRendition({ bytes, contentType: 'image/png' }, 'list')).resolves.toHaveProperty('contentType', 'image/jpeg');
    });
});
