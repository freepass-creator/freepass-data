import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderIancarPhotoRenditions } from '../src/infra/photo-renditioner-sharp.js';

describe('sharp renditions', () => {
  it('makes 480px list and 960px detail JPEGs and strips metadata', async () => {
    const original = await sharp({ create: { width: 2000, height: 1200, channels: 3, background: '#336699' } })
      .jpeg().withExif({ IFD0: { Copyright: 'secret-owner' } }).toBuffer();
    const { list, detail } = await renderIancarPhotoRenditions(original);
    const listMeta = await sharp(list).metadata(), detailMeta = await sharp(detail).metadata();
    expect([listMeta.width, detailMeta.width, listMeta.format, detailMeta.format]).toEqual([480, 960, 'jpeg', 'jpeg']);
    expect(listMeta.exif).toBeUndefined();
    expect(detail.toString('latin1')).not.toContain('secret-owner');
    expect(list.length).toBeLessThan(detail.length);
  });

  it('does not upscale small originals and rejects non-images', async () => {
    const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    expect((await sharp((await renderIancarPhotoRenditions(small)).detail).metadata()).width).toBe(300);
    await expect(renderIancarPhotoRenditions(Buffer.from('not an image'))).rejects.toThrow();
  });
});
