import { IANCAR_PHOTO_RENDITIONS } from '../domain/iancar-photo-store.js';

/** 목록·상세 JPEG 렌디션. 메타데이터(EXIF 등)는 withMetadata 를 쓰지 않아 제거되고, 입력 픽셀 상한으로 압축폭탄을 막는다. */
export async function renderIancarPhotoRenditions(original: Buffer) {
  const { default: sharp } = await import('sharp');
  const render = (width: number, quality: number) => sharp(original, { limitInputPixels: 80_000_000, failOn: 'error' })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  const [list, detail] = await Promise.all([
    render(IANCAR_PHOTO_RENDITIONS.list.width, IANCAR_PHOTO_RENDITIONS.list.quality),
    render(IANCAR_PHOTO_RENDITIONS.detail.width, IANCAR_PHOTO_RENDITIONS.detail.quality),
  ]);
  return { list, detail };
}
