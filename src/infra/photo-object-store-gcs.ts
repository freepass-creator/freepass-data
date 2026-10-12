import { getStorage } from 'firebase-admin/storage';
import { getTargetFirebaseApp } from './firebase-target.js';
import type { PhotoObjectStore } from '../ports/photo-object-store.js';

/** 비공개 버킷 하나에 대한 객체 저장소. 생성은 항상 ifGenerationMatch=0(덮어쓰기 불가). */
export function createGcsPhotoObjectStore(bucketName: string): PhotoObjectStore {
  const bucket = () => getStorage(getTargetFirebaseApp()).bucket(bucketName);
  return {
    async getObject(name) {
      const file = bucket().file(name);
      const [exists] = await file.exists();
      if (!exists) return null;
      const [bytes] = await file.download();
      return bytes;
    },
    async createObject(name, bytes, contentType) {
      try {
        await bucket().file(name).save(bytes, {
          contentType, resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { cacheControl: 'private, max-age=0, no-store' },
        });
        return 'CREATED';
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (code === 412 || code === 409) return 'EXISTS';
        throw error;
      }
    },
  };
}
