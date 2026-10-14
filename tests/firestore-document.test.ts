import { describe, expect, it } from 'vitest';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { GeoPoint, Timestamp } from 'firebase-admin/firestore';
import { encodeIancarBackupValue, decodeIancarBackupValue, iancarAbsencePatch, iancarPhotoPatch, iancarPhotoPendingPatch, iancarFactsRefreshPatch } from '../src/infra/iancar-publication-withdrawal-firestore.js';
import {
  decodeFirestoreDocument,
  decodeFirestoreIdentityDocument
} from '../src/infra/firestore-document.js';

function snapshot(id: string, value: Record<string, unknown> | null) {
  return {
    id,
    exists: value !== null,
    data: () => value ?? undefined,
    ref: { parent: { id: 'catalog_products' } }
  } as unknown as DocumentSnapshot;
}

describe('Firestore document decoding', () => {
  it('absent source inventory is withdrawn once, never deleted or repeated over locks/history', () => {
    const old = { provider_company_code: 'RP031', listable: true, iancar_one_vehicle_id: 'V1', iancar_phase_one: { sourceDigest: 'old' } };
    const patch = iancarAbsencePatch(old, new Set(), 'new', 'now')!;
    expect(patch).toMatchObject({ listable: false, iancar_phase_one: null, publication_withdrawal: { deleteAuthorized: false } });
    expect(iancarAbsencePatch({ ...old, ...patch }, new Set(), 'next', 'later')).toBeNull();
    for (const extra of [{ locked_by_contract: true }, { _deleted: true }, { deletedAt: 'date' }, { provider_company_code: 'RP999' }])
      expect(iancarAbsencePatch({ ...old, ...extra }, new Set(), 'new', 'now')).toBeNull();
    expect(iancarAbsencePatch(old, new Set(['V1']), 'new', 'now')).toBeNull();
  });
  it('shared photo mapping preserves originals and restores only unbacked own proxy slots', () => {
    const row = { productId: 'P', vehicleId: 'V', plate: '123가4567', count: 2, observedAt: 'now' };
    const original = { image_urls: ['https://original.example/photo.jpg'], image_url: 'https://original.example/photo.jpg' };
    const patch = iancarPhotoPatch(original, row);
    expect(patch).toMatchObject({ image_kind: 'VEHICLE_PHOTO', iancar_one_photo_count: 2,
      iancar_photo_source_original: { image_urls: original.image_urls } });
    expect(iancarPhotoPatch({ ...original, ...patch }, { ...row, count: 0 }).image_urls).toEqual(original.image_urls);
    expect(iancarPhotoPatch(original, { ...row, count: 0 })).not.toHaveProperty('image_urls');
    const operatorPhoto = { ...original, ...patch, image_urls: ['https://operator.example/new.jpg'], image_url: 'https://operator.example/new.jpg' };
    const refreshed = iancarPhotoPatch(operatorPhoto, row);
    expect(refreshed.iancar_photo_source_original).toMatchObject({ image_url: 'https://operator.example/new.jpg' });
    expect(iancarPhotoPatch({ ...operatorPhoto, ...refreshed }, { ...row, count: 0 }).image_url).toBe('https://operator.example/new.jpg');
  });
  it('round-trips operational backups without replacing Timestamp, GeoPoint or bytes with maps', () => {
    const original = { at: new Timestamp(100, 123), point: new GeoPoint(37.5, 127), nested: [Buffer.from('evidence'), { type: 'timestamp', seconds: 9 }], empty: null };
    const restored = decodeIancarBackupValue(JSON.parse(JSON.stringify(encodeIancarBackupValue(original))), () => { throw new Error('unexpected reference'); });
    expect(restored.at).toBeInstanceOf(Timestamp);
    expect(restored.at.isEqual(original.at)).toBe(true);
    expect(restored.point).toBeInstanceOf(GeoPoint);
    expect(restored.point.isEqual(original.point)).toBe(true);
    expect(Buffer.isBuffer(restored.nested[0])).toBe(true);
    expect(restored).toEqual(original);
  });
  it('fails closed before publication for unsupported backup prototypes', () => {
    expect(() => encodeIancarBackupValue({ value: new Date() })).toThrow('IANCAR_BACKUP_UNSUPPORTED_TYPE');
  });
  it('uses the document path as canonical entity identity', () => {
    expect(
      decodeFirestoreIdentityDocument<{ id: string; name: string }>(
        snapshot('prod_path', { name: 'GV70' }),
        'id'
      )
    ).toEqual({ id: 'prod_path', name: 'GV70' });
  });

  it('rejects a payload identity that disagrees with the document path', () => {
    expect(() =>
      decodeFirestoreIdentityDocument(
        snapshot('prod_path', { id: 'prod_payload' }),
        'id'
      )
    ).toThrow('Firestore document identity mismatch');
  });

  it('keeps non-identity documents raw instead of injecting a generic id', () => {
    expect(
      decodeFirestoreDocument<{ sourceId: string }>(
        snapshot('encoded-source', { sourceId: 'source/one' })
      )
    ).toEqual({ sourceId: 'source/one' });
  });
});

describe('iancarPhotoPendingPatch — 죽은 ERP4 별칭만 «사진 확인 중» 으로', () => {
  const alias = (n: number) => `https://freepasserp.com/api/img?product=P1&photo=${n}&format=.jpg`;
  it('별칭 주소만 있으면 비우고 원래 값을 보존한다', () => {
    const old = { image_url: alias(0), image_urls: [alias(0), alias(1)], image_kind: 'VEHICLE_PHOTO' };
    const patch = iancarPhotoPendingPatch(old) as any;
    expect(patch).toMatchObject({ image_url: '', image_urls: [], image_kind: 'PHOTO_PENDING' });
    expect(patch.iancar_photo_source_original).toEqual({ image_urls: old.image_urls, image_url: old.image_url, photo_link: null, image_kind: 'VEHICLE_PHOTO' });
  });
  it('이미 보존 칸이 있으면 덮지 않는다', () => {
    const saved = { image_urls: null, image_url: null, photo_link: 'https://drive.example/f' };
    expect((iancarPhotoPendingPatch({ image_url: alias(0), image_urls: [alias(0)], iancar_photo_source_original: saved }) as any).iancar_photo_source_original).toBe(saved);
  });
  it('드라이브 캐시·폴더 링크·별칭이 아닌 주소가 있으면 건드리지 않는다', () => {
    expect(iancarPhotoPendingPatch({ image_url: alias(0), image_urls: [alias(0)], photo_cache: { urls: ['https://drive.example/t'] } })).toEqual({});
    expect(iancarPhotoPendingPatch({ image_url: alias(0), image_urls: [alias(0)], photo_link: 'https://drive.example/f' })).toEqual({});
    expect(iancarPhotoPendingPatch({ image_url: 'https://eancarone.com/catalog-images/neutral/x.webp', image_urls: ['https://eancarone.com/catalog-images/neutral/x.webp'] })).toEqual({});
  });
  it('사진이 전혀 없는 새 문서는 «사진 확인 중»', () => {
    expect(iancarPhotoPendingPatch({})).toMatchObject({ image_kind: 'PHOTO_PENDING', image_urls: [] });
  });
});

describe('iancarFactsRefreshPatch — 주행거리·연식은 ONE 값(옛 값 보존, 최초등록은 별도 칸)', () => {
  it('문자열 주행거리 형식을 유지하고 옛 값을 보존한다', () => {
    const patch = iancarFactsRefreshPatch({ mileage: '10', year: '2026' }, { mileage: 1380, year: '2027' }, 'T') as any;
    expect(patch).toMatchObject({ mileage: '1,380', mileage_source_original: '10', model_year_source: '2027', iancar_mileage_observed_at: 'T', year: '2027', year_source_original: '2026' });
    expect('first_registration_date' in patch).toBe(false);   // 최초등록은 별도 칸 — 건드리지 않는다
  });
  it('연식이 원천과 같으면 year 를 바꾸지 않고, 옛 보존 칸이 이미 있으면 다시 쓰지 않는다', () => {
    expect('year' in (iancarFactsRefreshPatch({ year: '2026' }, { year: '2026' }, 'T') as any)).toBe(false);
    const again = iancarFactsRefreshPatch({ year: '2025', year_source_original: '2024' }, { year: '2026' }, 'T') as any;
    expect(again.year).toBe('2026');
    expect('year_source_original' in again).toBe(false);
  });
  it('숫자 형식·같은 값·옛 보존 칸은 건드리지 않는다', () => {
    expect((iancarFactsRefreshPatch({ mileage: 5, mileage_source_original: 1 }, { mileage: 7 }, 'T') as any)).toMatchObject({ mileage: 7 });
    expect('mileage_source_original' in (iancarFactsRefreshPatch({ mileage: 5, mileage_source_original: 1 }, { mileage: 7 }, 'T') as any)).toBe(false);
    expect('mileage' in (iancarFactsRefreshPatch({ mileage: '1,380' }, { mileage: 1380 }, 'T') as any)).toBe(false);
  });
  it('ONE 값이 없으면 주행거리를 지우지 않는다', () => {
    expect(iancarFactsRefreshPatch({ mileage: '10' }, { mileage: null, year: null }, 'T')).toEqual({});
  });
});
