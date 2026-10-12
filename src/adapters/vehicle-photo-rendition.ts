import sharp from 'sharp';
import { validateVehiclePhotoMedia } from '../domain/consumer-output-contract.js';

export type VehiclePhotoRenditionSize = 'list' | 'detail';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;
const BUDGET_MS = 3000;
let active = false;
sharp.concurrency(1);
sharp.cache(false);

/** After original-byte approval only. Reduces Data→ERP5 bytes, not ONE→Data. */
export async function renderVehiclePhotoRendition(
  input: { bytes: Buffer; contentType: string },
  size: VehiclePhotoRenditionSize,
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ bytes: Buffer; contentType: 'image/jpeg' }> {
  if (!input || !Buffer.isBuffer(input.bytes) || !input.bytes.length
    || validateVehiclePhotoMedia(input.contentType, input.bytes.length, input.bytes)
    || (size !== 'list' && size !== 'detail') || signal?.aborted)
    throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
  if (active) throw new Error('VEHICLE_PHOTO_BUSY');
  active = true;
  const bound = size === 'list' ? 480 : 960;
  let pipeline: sharp.Sharp;
  try {
    pipeline = sharp(input.bytes, { limitInputPixels: MAX_PIXELS, animated: false })
      .rotate().resize({ width: bound, height: bound, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: size === 'list' ? 75 : 80 })
      .timeout({ seconds: 3 });
  } catch { active = false; throw new Error('VEHICLE_PHOTO_UNAVAILABLE'); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => { pipeline.destroy(); reject(new Error('VEHICLE_PHOTO_UNAVAILABLE')); };
    timer = setTimeout(cancel, BUDGET_MS);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  // Keep the slot until the native work settles, even if the caller cancels early.
  const work = (async () => {
    try {
      const bytes = await pipeline.toBuffer();
      if (signal?.aborted || !bytes.length || bytes.length > MAX_BYTES
        || validateVehiclePhotoMedia('image/jpeg', bytes.length, bytes))
        throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
      return { bytes, contentType: 'image/jpeg' as const };
    } finally { active = false; }
  })();
  try { return await Promise.race([work, cancelled]); }
  catch { throw new Error('VEHICLE_PHOTO_UNAVAILABLE'); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
