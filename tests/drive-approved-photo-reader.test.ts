import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDriveApprovedPhotoReader, approvedPhotoReaderFromEnv } from '../src/infra/drive-approved-photo-reader.js';

const jpeg = Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.from('fake-image-bytes')]);
const sha = createHash('sha256').update(jpeg).digest('hex');
const ref = (over: Record<string, unknown> = {}) => ({ driveFileId: 'FILE_ID_1', sha256: sha, mediaType: 'image/jpeg', vehiclePhotoVerifiedBy: 'x', vehiclePhotoVerificationMethod: 'AUTO_KAKAO_COLLECT',
  vehiclePhotoVerifiedAt: '2026-10-14T00:00:00.000Z', role: 'VEHICLE_PHOTO', zone: '차량사진', approvedAt: '2026-10-14T00:00:00.000Z', vehicleKey: 'k', ...over } as never);
const respond = (bytes: Buffer, status = 200, headers: Record<string, string> = {}) => async () => ({ ok: status >= 200 && status < 300, status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer });

describe('승인 사진 드라이브 reader', () => {
  it('등록된 sha256 과 바이트가 같으면 서빙하고, 다르면(사진이 바뀜) 거절한다', async () => {
    const ok = await createDriveApprovedPhotoReader({ fetchImpl: respond(jpeg) })(ref());
    expect(ok.contentType).toBe('image/jpeg');
    expect(ok.bytes.equals(jpeg)).toBe(true);
    await expect(createDriveApprovedPhotoReader({ fetchImpl: respond(Buffer.concat([jpeg, Buffer.from('x')])) })(ref())).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
  });
  it('형식·시그니처·크기·파일 ID 형식을 검증한다', async () => {
    const png = Buffer.from('not-an-image');
    await expect(createDriveApprovedPhotoReader({ fetchImpl: respond(png) })(ref({ sha256: createHash('sha256').update(png).digest('hex') }))).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    await expect(createDriveApprovedPhotoReader({ fetchImpl: respond(jpeg, 200, { 'content-length': String(9 * 1024 * 1024) }) })(ref())).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    await expect(createDriveApprovedPhotoReader({ fetchImpl: respond(jpeg) })(ref({ driveFileId: '../x' }))).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    await expect(createDriveApprovedPhotoReader({ fetchImpl: respond(jpeg, 404) })(ref())).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
  });
  it('토큰 제공자가 있으면 Drive API(+Bearer), 없으면 공개 다운로드 주소를 쓰고 호스트는 고정이다', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const spy = async (url: string, init?: { headers?: Record<string, string> }) => { seen.push({ url, auth: init?.headers?.authorization }); return respond(jpeg)(); };
    await createDriveApprovedPhotoReader({ fetchImpl: spy as never })(ref());
    await createDriveApprovedPhotoReader({ fetchImpl: spy as never, tokenProvider: async () => 'TOKEN' })(ref());
    expect(seen[0]!.url.startsWith('https://drive.usercontent.google.com/download?id=FILE_ID_1')).toBe(true);
    expect(seen[0]!.auth).toBeUndefined();
    expect(seen[1]!.url.startsWith('https://www.googleapis.com/drive/v3/files/FILE_ID_1?alt=media')).toBe(true);
    expect(seen[1]!.auth).toBe('Bearer TOKEN');
  });
  it('Cloud Run 토큰 제공자: 메타데이터 → 자기 가장 drive.readonly 토큰, 캐시, 실패 폐쇄', async () => {
    const { createCloudRunDriveTokenProvider } = await import('../src/infra/drive-approved-photo-reader.js');
    const calls: string[] = [];
    const fake = async (url: string, init?: { body?: string }) => {
      calls.push(url);
      if (url.endsWith('/email')) return { ok: true, status: 200, text: async () => 'svc@proj.iam.gserviceaccount.com', json: async () => ({}) };
      if (url.endsWith('/token')) return { ok: true, status: 200, text: async () => '', json: async () => ({ access_token: 'BASE' }) };
      expect(JSON.parse(init!.body!).scope).toEqual(['https://www.googleapis.com/auth/drive.readonly']);
      return { ok: true, status: 200, text: async () => '', json: async () => ({ accessToken: 'DRIVE', expireTime: new Date(Date.now() + 900_000).toISOString() }) };
    };
    const provider = createCloudRunDriveTokenProvider(fake as never);
    expect(await provider()).toBe('DRIVE');
    expect(await provider()).toBe('DRIVE');
    expect(calls.filter(u => u.includes('generateAccessToken'))).toHaveLength(1);
    const denied = createCloudRunDriveTokenProvider((async (url: string) => url.includes('generateAccessToken')
      ? { ok: false, status: 403, text: async () => '', json: async () => ({}) }
      : url.endsWith('/email') ? { ok: true, status: 200, text: async () => 'svc@proj.iam.gserviceaccount.com', json: async () => ({}) }
        : { ok: true, status: 200, text: async () => '', json: async () => ({ access_token: 'BASE' }) }) as never);
    await expect(denied()).rejects.toThrow('VEHICLE_PHOTO_READER_UNAVAILABLE');
  });
  it('환경변수: drive-public·drive-api 일 때만 주입, 그 밖은 꺼짐(실패 폐쇄)', () => {
    expect(approvedPhotoReaderFromEnv({ FREEPASS_DATA_APPROVED_PHOTO_READER: 'drive-api' } as never)).toBeTypeOf('function');
    expect(approvedPhotoReaderFromEnv({ FREEPASS_DATA_APPROVED_PHOTO_READER: 'drive-public' } as never)).toBeTypeOf('function');
    for (const v of [undefined, '', 'off', 'DRIVE-PUBLIC', 'drive', ' x ']) expect(approvedPhotoReaderFromEnv({ FREEPASS_DATA_APPROVED_PHOTO_READER: v } as never)).toBeUndefined();
  });
});
