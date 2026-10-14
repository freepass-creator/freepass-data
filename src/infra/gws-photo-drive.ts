/** 이안카 사진 복사용 드라이브 포트 — 이미 로그인된 gws 주체로 Drive API 를 부른다(키 파일·서비스 계정 없음). 공유 드라이브 지원(supportsAllDrives).
 * 쓰기는 폴더 생성·파일 올리기·폴더 속성 기록뿐이고 삭제·이동·공유 변경은 없다. 로그·오류에는 파일 id·이름·내용을 싣지 않는다(코드만). */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DriveFileInfo, DriveVehicleFolder, PhotoCopyDrive } from '../ports/iancar-photo-copy.js';

export type GwsRunner = (args: string[]) => unknown;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHARED = { supportsAllDrives: true, includeItemsFromAllDrives: true } as const;
const quote = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
/** 폴더 이름의 첫 토큰이 번호다: «161허1397 쏘나타 DN8» → «161허1397». 번호 안의 공백(«161 허 1397»)은 없는 것으로 본다. */
const plateOfName = (name: string) => normalize(name).split(' ')[0] ?? '';
const plateKey = (plate: string) => normalize(plate).replace(/\s+/g, '');
const safeLabel = (label: string) => normalize(label).replace(/[\\/:*?"<>|]/g, '').slice(0, 40).trim();

/** 드라이브 호출 한도·쿼터 신호(429 와 rateLimitExceeded·userRateLimitExceeded·quotaExceeded 이유). 본문은 어디에도 남기지 않고 이 판정에만 쓴다. */
export const isDriveRateLimitSignal = (text: string): boolean =>
  /\b429\b|rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/i.test(text);

/** gws 실행기: 실행 파일 경로를 받아 stdout 의 JSON 만 읽는다(stderr 의 keyring 안내는 무시). 오류 본문은 던지지 않는다.
 * 한도 초과(429·쿼터)는 전용 코드 DRIVE_RATE_LIMITED 로 올려 잡이 회차를 즉시 종료하게 한다. */
/** gws 의 --upload 는 «현재 작업 폴더 안» 파일만 허용한다(validationError: outside the current directory). 이 신호는 일반 실패로 뭉개지 않고 전용 코드로 올린다. */
export const isUploadOutsideCwdSignal = (text: string): boolean => /outside the current directory|validationError/i.test(text);

export function gwsRunner(bin: string, options: { timeoutMs?: number; cwd?: string } = {}): GwsRunner {
  return args => {
    let out: string;
    // cwd = 업로드 임시 폴더: --upload 에는 이 폴더 안의 «상대 파일명»만 넘긴다(작업 폴더 밖 파일은 gws 가 거부).
    try { out = execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: options.timeoutMs ?? 120_000,
      ...(options.cwd ? { cwd: options.cwd } : {}) }); }
    catch (error) {
      const e = error as { stdout?: unknown; stderr?: unknown };
      const text = `${typeof e.stdout === 'string' ? e.stdout : Buffer.isBuffer(e.stdout) ? e.stdout.toString('utf8') : ''}\n${typeof e.stderr === 'string' ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : ''}`;
      throw new Error(isDriveRateLimitSignal(text) ? 'DRIVE_RATE_LIMITED' : isUploadOutsideCwdSignal(text) ? 'GWS_UPLOAD_PATH_OUTSIDE_CWD' : 'GWS_DRIVE_CALL_FAILED');
    }
    const at = out.indexOf('{');
    if (at < 0) throw new Error('GWS_DRIVE_RESPONSE_INVALID');
    let json: unknown;
    try { json = JSON.parse(out.slice(at)); } catch { throw new Error('GWS_DRIVE_RESPONSE_INVALID'); }
    if (json && typeof json === 'object' && 'error' in json) {
      const errorText = JSON.stringify((json as { error?: unknown }).error ?? '');
      throw new Error(isDriveRateLimitSignal(errorText) ? 'DRIVE_RATE_LIMITED' : isUploadOutsideCwdSignal(errorText) ? 'GWS_UPLOAD_PATH_OUTSIDE_CWD' : 'GWS_DRIVE_API_ERROR');
    }
    return json;
  };
}

type Item = { id?: string; name?: string; mimeType?: string; sha256Checksum?: string; appProperties?: Record<string, string> };
const asItems = (v: unknown): Item[] => (v && typeof v === 'object' && Array.isArray((v as { files?: unknown }).files) ? (v as { files: Item[] }).files : []);

export function createGwsPhotoDrive(options: { run: GwsRunner; rootFolderId: string; tempDir: string }): PhotoCopyDrive {
  const { run, rootFolderId, tempDir } = options;
  if (!/^[A-Za-z0-9_-]{10,}$/.test(rootFolderId)) throw new Error('DRIVE_ROOT_FOLDER_ID_INVALID');
  const files = (folderId: string): DriveFileInfo[] => {
    const out: DriveFileInfo[] = [];
    let page: string | undefined;
    do {
      const res = run(['drive', 'files', 'list', '--params', JSON.stringify({ ...SHARED, spaces: 'drive', pageSize: 200, ...(page ? { pageToken: page } : {}),
        q: `'${quote(folderId)}' in parents and trashed=false and mimeType contains 'image/'`,
        fields: 'nextPageToken,files(id,name,mimeType,sha256Checksum,appProperties)' })]) as { nextPageToken?: string };
      for (const f of asItems(res)) {
        if (!f.id || !f.name) continue;
        out.push({ fileId: f.id, name: f.name, sha256: f.sha256Checksum ?? null, srcKey: f.appProperties?.srcKey ?? null, image: true,
          copySha256: f.appProperties?.copySha256 ?? null });
      }
      page = typeof res.nextPageToken === 'string' ? res.nextPageToken : undefined;
    } while (page);
    return out;
  };
  const folderRow = (item: Item): DriveVehicleFolder => ({ folderId: item.id!, name: item.name!, fingerprint: item.appProperties?.iancarPhotoSet ?? null, files: files(item.id!) });

  // 이안카 폴더 아래 번호 폴더 목록은 회차당 한 번만 읽는다(이름 검색은 토큰 규칙 때문에 믿지 않고 전체 목록에서 첫 토큰이 번호와 정확히 같은 것만 고른다).
  let roster: Item[] | null = null;
  const loadRoster = (): Item[] => {
    if (roster) return roster;
    const out: Item[] = [];
    let page: string | undefined;
    do {
      const res = run(['drive', 'files', 'list', '--params', JSON.stringify({ ...SHARED, spaces: 'drive', pageSize: 1000, ...(page ? { pageToken: page } : {}),
        q: `'${quote(rootFolderId)}' in parents and trashed=false and mimeType='${FOLDER_MIME}'`, fields: 'nextPageToken,files(id,name,appProperties)' })]) as { nextPageToken?: string };
      out.push(...asItems(res).filter(f => f.id && f.name));
      page = typeof res.nextPageToken === 'string' ? res.nextPageToken : undefined;
    } while (page);
    return (roster = out);
  };

  return {
    async findVehicleFolders(plate) {
      const key = plateKey(plate);
      return loadRoster().filter(f => plateKey(plateOfName(f.name!)) === key).map(folderRow);
    },
    async createVehicleFolder(plate, label) {
      const key = plateKey(plate), suffix = label ? safeLabel(label) : '';
      const name = suffix ? `${key} ${suffix}` : key;
      const res = run(['drive', 'files', 'create', '--params', JSON.stringify({ supportsAllDrives: true, fields: 'id,name' }),
        '--json', JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [rootFolderId] })]) as Item;
      if (!res.id) throw new Error('DRIVE_FOLDER_CREATE_FAILED');
      loadRoster().push({ id: res.id, name: res.name ?? name });   // 같은 회차에서 같은 번호를 두 번 만들지 않는다
      return { folderId: res.id, name: res.name ?? name, fingerprint: null, files: [] };
    },
    async upload(folderId, name, bytes, srcKey) {
      const local = join(tempDir, `${randomUUID()}.jpg`);
      const local256 = createHash('sha256').update(bytes).digest('hex');
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(local, bytes, { mode: 0o600 });
      try {
        // copySha256 = 완료 표식: 드라이브가 계산한 체크섬과 같을 때만 다음 회차가 «완료» 로 인정한다(불일치·부분 파일은 인정하지 않음).
        const res = run(['drive', 'files', 'create', '--params', JSON.stringify({ supportsAllDrives: true, fields: 'id,name,sha256Checksum' }),
          '--json', JSON.stringify({ name, parents: [folderId], mimeType: 'image/jpeg', appProperties: { srcKey, copySha256: local256, copiedBy: 'iancar-photo-copy/1' } }),
          // 상대 파일명: 실행기의 cwd(= tempDir) 안의 파일만 gws 가 받는다.
          '--upload', basename(local)]) as Item;
        if (!res.id) throw new Error('DRIVE_UPLOAD_FAILED');
        // 체크섬은 업로드 응답에 없을 수 있다 — 없으면 한 번 조회한다. 원격 체크섬을 «확인하지 못하면» 성공으로 치지 않는다(Codex 재검토):
        // 로컬 해시로 대체하면 검증 안 된 업로드가 COPIED·등록 CSV 에 들어간다. 불일치·미확인 모두 실패(되돌리지 않음: 지문이 없어 다음 회차에 재검증,
        // 이미 올라간 파일은 드라이브가 체크섬을 계산해 표식과 같아지면 그때 «완료»로 인정된다).
        let remote = res.sha256Checksum ?? null;
        if (!remote) remote = ((run(['drive', 'files', 'get', '--params', JSON.stringify({ fileId: res.id, supportsAllDrives: true, fields: 'sha256Checksum' })]) as Item).sha256Checksum) ?? null;
        if (!remote) throw new Error('DRIVE_UPLOAD_CHECKSUM_UNVERIFIED');
        if (remote.toLowerCase() !== local256) throw new Error('DRIVE_UPLOAD_CHECKSUM_MISMATCH');
        return { fileId: res.id, name, sha256: remote.toLowerCase(), srcKey, image: true, copySha256: local256 };
      } finally { rmSync(local, { force: true }); }
    },
    async setFingerprint(folderId, fingerprint, copiedAtIso) {
      run(['drive', 'files', 'update', '--params', JSON.stringify({ fileId: folderId, supportsAllDrives: true, fields: 'id' }),
        '--json', JSON.stringify({ appProperties: { iancarPhotoSet: fingerprint, copiedAt: copiedAtIso } })]);
    },
  };
}
