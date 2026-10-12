import type { PhotoObjectStore } from '../ports/photo-object-store.js';

/** 시험·로컬용 가짜 저장소(버킷 없이 동작). */
export class MemoryPhotoObjectStore implements PhotoObjectStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  async getObject(name: string) { return this.objects.get(name)?.bytes ?? null; }
  async createObject(name: string, bytes: Buffer, contentType: string) {
    if (this.objects.has(name)) return 'EXISTS' as const;
    this.objects.set(name, { bytes, contentType });
    return 'CREATED' as const;
  }
}
