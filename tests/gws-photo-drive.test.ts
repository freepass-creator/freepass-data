import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGwsPhotoDrive, isDriveRateLimitSignal, type GwsRunner } from '../src/infra/gws-photo-drive.js';
import { fullApprovalToken, iancarPhotoCopyCli, photoCopyLimitsFromEnv } from '../src/jobs/copy-iancar-photos-to-drive.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gws-photo-')); dirs.push(d); return d; };
const ROOT = 'ROOTFOLDERID1234567890';
const param = (args: string[]) => JSON.parse(args[args.indexOf('--params') + 1]!) as Record<string, unknown>;
const json = (args: string[]) => JSON.parse(args[args.indexOf('--json') + 1]!) as Record<string, any>;

describe('gws 드라이브 포트(공유 드라이브, 삭제 없음)', () => {
  it('matches existing folders by the first name token (number), lists images inside, and reads shared drives', async () => {
    const calls: string[][] = [];
    const run: GwsRunner = args => {
      calls.push(args);
      const p = param(args);
      if (String(p.q).includes(`'${ROOT}' in parents`)) return { files: [
        { id: 'A', name: '161허1397 쏘나타' }, { id: 'B', name: '161허1397 쏘나타 DN8 디 엣지', appProperties: { iancarPhotoSet: 'fp' } },
        { id: 'C', name: '133호5567' }, { id: 'D', name: '161허13970 기타' }] };
      return { files: [{ id: `img-${p.q}`.slice(0, 12), name: '01.jpg', sha256Checksum: 'abc', appProperties: { srcKey: 'k' } }] };
    };
    const drive = createGwsPhotoDrive({ run, rootFolderId: ROOT, tempDir: tmp() });
    const found = await drive.findVehicleFolders('161허1397');
    expect(found.map(f => f.name)).toEqual(['161허1397 쏘나타', '161허1397 쏘나타 DN8 디 엣지']);   // 번호 접두 우연 일치(13970)·다른 번호는 제외
    expect(found[1]!.fingerprint).toBe('fp');
    expect(found[0]!.files[0]).toMatchObject({ name: '01.jpg', srcKey: 'k', image: true });
    expect(await drive.findVehicleFolders('133호5567')).toHaveLength(1);
    expect(calls.every(c => param(c).supportsAllDrives === true)).toBe(true);
    expect(calls.some(c => c.includes('delete'))).toBe(false);
  });

  it('creates a folder named «번호 차종» only under the configured root and uploads with source properties, verifying the checksum', async () => {
    const calls: string[][] = [];
    const bytes = Buffer.from('jpeg-bytes');
    const sha = createHash('sha256').update(bytes).digest('hex');
    let uploadedFile = '';
    const dir = tmp();
    const run: GwsRunner = args => {
      calls.push(args);
      if (args.includes('--upload')) { uploadedFile = args[args.indexOf('--upload') + 1]!; expect(readFileSync(uploadedFile).equals(bytes)).toBe(true); return { id: 'FILE1', sha256Checksum: sha }; }
      if (args.includes('create')) return { id: 'FOLDER1', name: json(args).name };
      return {};
    };
    const drive = createGwsPhotoDrive({ run, rootFolderId: ROOT, tempDir: dir });
    const folder = await drive.createVehicleFolder('161허1397', '쏘나타 DN8/디 엣지');
    expect(folder.name).toBe('161허1397 쏘나타 DN8디 엣지');                       // 이름에 못 쓰는 문자 제거
    expect(json(calls[0]!)).toMatchObject({ mimeType: 'application/vnd.google-apps.folder', parents: [ROOT] });
    const file = await drive.upload('FOLDER1', '01.jpg', bytes, 'srcKeyX');
    expect(file).toMatchObject({ fileId: 'FILE1', name: '01.jpg', srcKey: 'srcKeyX', sha256: sha });
    const upload = calls.find(c => c.includes('--upload'))!;
    expect(json(upload)).toMatchObject({ name: '01.jpg', parents: ['FOLDER1'], appProperties: { srcKey: 'srcKeyX' } });
    expect(existsSync(uploadedFile)).toBe(false);                                   // 임시 파일은 지운다
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fails the upload (no silent success) when the drive checksum differs from the local bytes, and still removes the temp file', async () => {
    const dir = tmp();
    const run: GwsRunner = args => (args.includes('--upload') ? { id: 'FILE1', sha256Checksum: 'deadbeef' } : {});
    const drive = createGwsPhotoDrive({ run, rootFolderId: ROOT, tempDir: dir });
    await expect(drive.upload('F', '01.jpg', Buffer.from('x'), 'k')).rejects.toThrow('DRIVE_UPLOAD_CHECKSUM_MISMATCH');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('Codex ②/③: drive rate-limit signals become a dedicated code; the upload carries the local checksum as the completion mark', () => {
    expect(isDriveRateLimitSignal('{"error":{"code":429,"message":"Too Many Requests"}}')).toBe(true);
    expect(isDriveRateLimitSignal('{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}')).toBe(true);
    expect(isDriveRateLimitSignal('{"error":{"code":404,"message":"File not found"}}')).toBe(false);
    expect(isDriveRateLimitSignal('size 14290')).toBe(false);
  });

  it('records the completion mark (copySha256) on upload and reads it back when listing', async () => {
    const bytes = Buffer.from('photo');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const calls: string[][] = [];
    const run: GwsRunner = args => { calls.push(args); return args.includes('--upload') ? { id: 'F', sha256Checksum: sha } : { files: [] }; };
    const drive = createGwsPhotoDrive({ run, rootFolderId: ROOT, tempDir: tmp() });
    const info = await drive.upload('FOLDER', '01.jpg', bytes, 'k');
    expect(info.copySha256).toBe(sha);
    expect(json(calls.find(c => c.includes('--upload'))!).appProperties).toMatchObject({ srcKey: 'k', copySha256: sha });
  });

  it('Codex 재검토 ①: an upload whose remote checksum cannot be confirmed (even after a re-read) is a failure, never a success with the local hash', async () => {
    const dir = tmp();
    const run: GwsRunner = args => (args.includes('--upload') ? { id: 'FILE1' } : args.includes('get') ? {} : { files: [] });
    const drive = createGwsPhotoDrive({ run, rootFolderId: ROOT, tempDir: dir });
    await expect(drive.upload('F', '01.jpg', Buffer.from('x'), 'k')).rejects.toThrow('DRIVE_UPLOAD_CHECKSUM_UNVERIFIED');
    expect(readdirSync(dir)).toEqual([]);
    // 응답에 없어도 재조회로 확인되면 성공(대소문자 무관)
    const sha = createHash('sha256').update(Buffer.from('x')).digest('hex');
    const ok = createGwsPhotoDrive({ run: a => (a.includes('--upload') ? { id: 'F' } : a.includes('get') ? { sha256Checksum: sha.toUpperCase() } : {}), rootFolderId: ROOT, tempDir: dir });
    expect((await ok.upload('F', '01.jpg', Buffer.from('x'), 'k')).sha256).toBe(sha);
  });

  it('writes the album fingerprint to the folder properties and rejects an invalid root id', async () => {
    const calls: string[][] = [];
    const drive = createGwsPhotoDrive({ run: a => { calls.push(a); return {}; }, rootFolderId: ROOT, tempDir: tmp() });
    await drive.setFingerprint('FOLDER1', 'fp16', '2026-10-14T20:00:00.000Z');
    expect(json(calls[0]!)).toEqual({ appProperties: { iancarPhotoSet: 'fp16', copiedAt: '2026-10-14T20:00:00.000Z' } });
    expect(() => createGwsPhotoDrive({ run: () => ({}), rootFolderId: 'x', tempDir: tmp() })).toThrow('DRIVE_ROOT_FOLDER_ID_INVALID');
  });
});

describe('복사 잡 설정·승인', () => {
  it('validates limits and keeps the supplier interval at 1 second or more', () => {
    expect(photoCopyLimitsFromEnv({})).toMatchObject({ maxVehicles: 40, maxPhotos: 400, maxPerVehicle: 10, intervalMs: 1500, pilotOnly: 10 });
    expect(() => photoCopyLimitsFromEnv({ IANCAR_PHOTO_COPY_INTERVAL_MS: '200' })).toThrow('PHOTO_COPY_LIMIT_INVALID');
    expect(() => photoCopyLimitsFromEnv({ IANCAR_PHOTO_COPY_MAX_PER_VEHICLE: '11' })).toThrow('PHOTO_COPY_LIMIT_INVALID');
  });

  it('refuses to write without explicit approval, and requires the drive root id', async () => {
    await expect(iancarPhotoCopyCli(['--mode', 'PILOT'], { IANCAR_PHOTO_DRIVE_ROOT_ID: ROOT })).rejects.toThrow('IANCAR_PHOTO_COPY_APPROVAL_REQUIRED');
    await expect(iancarPhotoCopyCli(['--mode', 'FULL'], { IANCAR_PHOTO_COPY_APPROVED: 'true' })).rejects.toThrow('IANCAR_PHOTO_DRIVE_ROOT_ID_REQUIRED');
    await expect(iancarPhotoCopyCli(['--mode', 'NOPE'], {})).rejects.toThrow('PHOTO_COPY_MODE_INVALID');
  });

  it('Codex 재검토 ②: the registration list is reset to a header-only CSV at the start, so a failed or empty run never leaves the previous list behind', async () => {
    const { writeFileSync } = await import('node:fs');
    const out = join(tmp(), 'register.csv');
    writeFileSync(out, '번호,폴더\n12가1001,OLDFOLDER\n');
    await expect(iancarPhotoCopyCli(['--mode', 'DRY_RUN', '--out', out], { IANCAR_PHOTO_DRIVE_ROOT_ID: ROOT, GWS_BIN: 'gws-test' }))
      .rejects.toThrow('IANCAR_ONE_API_KEY_REQUIRED');                       // 원천 키가 없어 회차가 시작도 못 한다
    expect(readFileSync(out, 'utf8')).toBe('번호,폴더\n');                    // 이전 목록은 남지 않는다
  });

  it('Codex ⑤: FULL cannot bypass the pilot limit — it needs the confirmation value bound to the target folder', async () => {
    const base = { IANCAR_PHOTO_COPY_APPROVED: 'true', IANCAR_PHOTO_DRIVE_ROOT_ID: ROOT };
    await expect(iancarPhotoCopyCli(['--mode', 'FULL'], base)).rejects.toThrow('IANCAR_PHOTO_FULL_APPROVAL_REQUIRED');
    await expect(iancarPhotoCopyCli(['--mode', 'FULL'], { ...base, IANCAR_PHOTO_FULL_APPROVED: 'true' })).rejects.toThrow('IANCAR_PHOTO_FULL_APPROVAL_REQUIRED');
    await expect(iancarPhotoCopyCli(['--mode', 'FULL'], { ...base, IANCAR_PHOTO_FULL_APPROVED: fullApprovalToken('OTHERFOLDERID1234567890') })).rejects.toThrow('IANCAR_PHOTO_FULL_APPROVAL_REQUIRED');
    expect(fullApprovalToken(ROOT)).toMatch(/^[a-f0-9]{16}$/);
    expect(fullApprovalToken(ROOT)).not.toBe(fullApprovalToken('OTHERFOLDERID1234567890'));
    // 올바른 값이면 승인 검사는 통과하고 그 다음 단계(GWS·API 키)에서 멈춘다 — 승인 검사 자체가 거부 사유가 아니다.
    await expect(iancarPhotoCopyCli(['--mode', 'FULL'], { ...base, IANCAR_PHOTO_FULL_APPROVED: fullApprovalToken(ROOT), GWS_BIN: 'gws-test-missing' }))
      .rejects.not.toThrow('IANCAR_PHOTO_FULL_APPROVAL_REQUIRED');
  });
});
