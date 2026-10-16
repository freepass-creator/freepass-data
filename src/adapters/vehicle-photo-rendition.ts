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
  { signal, maxEdge, quality }: { signal?: AbortSignal; maxEdge?: number; quality?: number } = {},
): Promise<{ bytes: Buffer; contentType: 'image/jpeg' }> {
  if (!input || !Buffer.isBuffer(input.bytes) || !input.bytes.length
    || validateVehiclePhotoMedia(input.contentType, input.bytes.length, input.bytes)
    || (size !== 'list' && size !== 'detail') || signal?.aborted)
    throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
  // 보관용 사본(드라이브 복사)은 호출자가 긴 변·품질을 더 줄일 수 있다(대표 2026-10-14 «사진 더 줄여서»). 범위 밖 값은 거부.
  if ((maxEdge !== undefined && (!Number.isInteger(maxEdge) || maxEdge < 480 || maxEdge > 1600))
    || (quality !== undefined && (!Number.isInteger(quality) || quality < 50 || quality > 90))) throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
  if (active) throw new Error('VEHICLE_PHOTO_BUSY');
  active = true;
  const bound = maxEdge ?? (size === 'list' ? 480 : 960);
  let pipeline: sharp.Sharp;
  try {
    pipeline = sharp(input.bytes, { limitInputPixels: MAX_PIXELS, animated: false })
      .rotate().resize({ width: bound, height: bound, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: quality ?? (size === 'list' ? 75 : 80), mozjpeg: maxEdge !== undefined || quality !== undefined })
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
