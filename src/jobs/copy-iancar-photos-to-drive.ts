/** 이안카 사진 → 우리 공유 드라이브 압축 사본 복사 잡(설계: docs/IANCAR-PHOTO-DRIVE-DESIGN-20261014.md).
 *   npm run copy:iancar-photos -- [--mode DRY_RUN|PILOT|FULL] [--out <등록용.csv>]
 * 모드 3단: DRY_RUN(기본, 쓰기 0: 상세·드라이브 읽기만) → PILOT(IANCAR_PHOTO_PILOT_ONLY=N, 기본 10대) → FULL.
 * PILOT/FULL 은 IANCAR_PHOTO_COPY_APPROVED=true 가 있어야 쓴다. 쓰기 주체 = 이미 로그인된 gws 계정(키 파일·서비스 계정 없음).
 * 환경: EANCAR_ONE_API_KEY(+선택 BASE_URL), IANCAR_PHOTO_DRIVE_ROOT_ID(공유 드라이브 «이안카» 폴더 id — 저장소에 두지 않는다), GWS_BIN(선택),
 *   한도: IANCAR_PHOTO_COPY_MAX_VEHICLES(40)·MAX_PHOTOS(400)·MAX_PER_VEHICLE(10)·TIME_BUDGET_MIN(40)·INTERVAL_MS(1500, 최소 1000)·PILOT_ONLY(10).
 * 출력: 번호는 끝 4자리만. 키·사진 URL·응답 본문은 어디에도 쓰지 않는다. 등록용 CSV(전체 번호)는 --out(비공개 디렉터리)에만 쓴다. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { collectIancarOneVehicleList, createIancarOneApiClient, iancarOneApiConfigFromEnv, iancarOnePhotoIds,
  readIancarOnePhotoBytes, IancarOneApiError } from '../adapters/iancar-one-api.js';
import { renderVehiclePhotoRendition } from '../adapters/vehicle-photo-rendition.js';
import { createGwsPhotoDrive, gwsRunner } from '../infra/gws-photo-drive.js';
import { resolveGwsBin } from '../infra/gws-bin.js';
import { DEFAULT_PHOTO_COPY_LIMITS, photoCopyCsv, runIancarPhotoCopy, type PhotoCopyLimits, type PhotoCopyMode,
  type PhotoCopySource, type SourceVehicle } from '../application/iancar-photo-drive-copy.js';

/** FULL 모드 승인 확인 값: 대상 «이안카» 폴더 id 에 묶인 해시(다른 폴더·실수로 복사한 값은 통하지 않는다). 파일럿 합격 뒤 사람이 이 값을 환경에 넣는다. */
export const fullApprovalToken = (rootFolderId: string): string =>
  createHash('sha256').update(`iancar-photo-copy-full/1\n${rootFolderId}`).digest('hex').slice(0, 16);

const SELLABLE = new Set(['AVAILABLE', 'PREPARING', 'RESERVED']);   // 판매 노출 상태(IANCAR-ONE-API.md 매핑): 출고가능·상품화중·계약중
const int = (value: string | undefined, fallback: number, min: number, max: number) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('PHOTO_COPY_LIMIT_INVALID');
  return n;
};
export function photoCopyLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): PhotoCopyLimits {
  const d = DEFAULT_PHOTO_COPY_LIMITS;
  return {
    maxVehicles: int(env.IANCAR_PHOTO_COPY_MAX_VEHICLES, d.maxVehicles, 1, 200),
    maxPhotos: int(env.IANCAR_PHOTO_COPY_MAX_PHOTOS, d.maxPhotos, 1, 2000),
    maxPerVehicle: int(env.IANCAR_PHOTO_COPY_MAX_PER_VEHICLE, d.maxPerVehicle, 1, 10),
    timeBudgetMs: int(env.IANCAR_PHOTO_COPY_TIME_BUDGET_MIN, d.timeBudgetMs / 60_000, 1, 180) * 60_000,
    intervalMs: int(env.IANCAR_PHOTO_COPY_INTERVAL_MS, d.intervalMs, 1000, 60_000),
    maxConsecutiveFailures: d.maxConsecutiveFailures,
    pilotOnly: int(env.IANCAR_PHOTO_PILOT_ONLY, d.pilotOnly, 1, 100),
  };
}

/** 502/503/504 를 클라이언트 내장 재시도에 넘기지 않는다(실패 재시도 0): 합성 상태 599 → IANCAR_ONE_API_HTTP_599(일시 오류)로 한 번에 끝난다. */
const noTransientRetry: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if ([502, 503, 504].includes(response.status)) { await response.body?.cancel(); return new Response(null, { status: 599 }); }
  return response;
};

export function createIancarPhotoSource(env: NodeJS.ProcessEnv = process.env): PhotoCopySource {
  const config = iancarOneApiConfigFromEnv(env);
  if (!config.apiKey) throw new Error('IANCAR_ONE_API_KEY_REQUIRED');
  const client = createIancarOneApiClient(config, noTransientRetry);
  const plates = new Map<string, string>();
  return {
    async listVehicles() {
      const capture = await collectIancarOneVehicleList(config, noTransientRetry);
      if (!capture.readyForRawIngest || capture.stale) throw new Error('IANCAR_SOURCE_NOT_READY');   // 상류 정지·신선도 초과 중에는 복사하지 않는다
      const out: SourceVehicle[] = [];
      for (const record of capture.records) {
        const payload = record.payload as Record<string, unknown>;
        const plate = typeof payload.plate_number === 'string' ? payload.plate_number.replace(/\s+/g, '') : '';
        const status = typeof payload.inventory_status === 'string' ? payload.inventory_status : '';
        if (!plate || !SELLABLE.has(status)) continue;
        const labelRaw = payload.model_name ?? payload.name;
        plates.set(record.vehicleId, plate);
        out.push({ vehicleId: record.vehicleId, plate, ...(typeof labelRaw === 'string' && labelRaw.trim() ? { label: labelRaw } : {}) });
      }
      return out;
    },
    async photoIds(vehicle) {
      const detail = await client.getVehicle(vehicle.vehicleId);
      const raw = ((detail as { data?: unknown })?.data ?? detail) as Record<string, unknown>;
      if (raw && Array.isArray(raw.photos) && raw.photos.length === 0 && raw.stale === false) return [];   // 원천에 사진 없음 = «대상 없음»
      return iancarOnePhotoIds(detail, vehicle.vehicleId, plates.get(vehicle.vehicleId) ?? vehicle.plate);
    },
    async download(vehicle, photoId) {
      return readIancarOnePhotoBytes(await client.getPhoto(vehicle.vehicleId, photoId));
    },
  };
}

export async function iancarPhotoCopyCli(argv: string[], env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.log) {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const mode = (flag('--mode') ?? env.IANCAR_PHOTO_COPY_MODE ?? 'DRY_RUN') as PhotoCopyMode;
  if (!['DRY_RUN', 'PILOT', 'FULL'].includes(mode)) throw new Error('PHOTO_COPY_MODE_INVALID');
  if (mode !== 'DRY_RUN' && env.IANCAR_PHOTO_COPY_APPROVED !== 'true') throw new Error('IANCAR_PHOTO_COPY_APPROVAL_REQUIRED');
  const rootFolderId = (env.IANCAR_PHOTO_DRIVE_ROOT_ID ?? '').trim();
  if (!rootFolderId) throw new Error('IANCAR_PHOTO_DRIVE_ROOT_ID_REQUIRED');
  // FULL 은 파일럿 한도(PILOT_ONLY)를 우회하는 모드이므로 «파일럿 합격 후 사람이 만든 확인 값» 이 있어야 한다: 값 = fullApprovalToken(대상 폴더에 묶임).
  if (mode === 'FULL' && env.IANCAR_PHOTO_FULL_APPROVED !== fullApprovalToken(rootFolderId)) throw new Error('IANCAR_PHOTO_FULL_APPROVAL_REQUIRED');
  const bin = resolveGwsBin(env);
  if (!bin) throw new Error('GWS_UNAVAILABLE');
  const limits = photoCopyLimitsFromEnv(env);
  const result = await runIancarPhotoCopy({
    source: createIancarPhotoSource(env),
    compress: input => renderVehiclePhotoRendition(input, 'detail'),
    drive: createGwsPhotoDrive({ run: gwsRunner(bin), rootFolderId, tempDir: join(env.SOURCE_CYCLE_PRIVATE_DIR || tmpdir(), 'iancar-photo-copy-tmp') }),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: Date.now,
  }, mode, limits);
  const out = flag('--out');
  if (out && result.completed.length) writeFileSync(resolve(out), photoCopyCsv(result), { mode: 0o600 });
  // 보고: 번호는 끝 4자리, 코드·건수만. completed(전체 번호)는 출력하지 않는다.
  log(JSON.stringify({ mode, stop: result.stop, vehicles: result.vehicles, counts: result.counts, photosWritten: result.photosWritten,
    // 확인 값은 명시 요청(--print-full-token)이 있을 때만 DRY_RUN 결과에 싣는다(파일럿 합격 뒤 사람이 의도적으로 꺼내 환경에 넣는 값).
    ...(mode === 'DRY_RUN' && argv.includes('--print-full-token') ? { fullApprovalToken: fullApprovalToken(rootFolderId) } : {}),
    bytesWritten: result.bytesWritten, limits: { maxVehicles: limits.maxVehicles, maxPhotos: limits.maxPhotos, maxPerVehicle: limits.maxPerVehicle,
      pilotOnly: mode === 'PILOT' ? limits.pilotOnly : null }, rows: result.rows }, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  iancarPhotoCopyCli(process.argv.slice(2)).then(result => {
    if (['RATE_LIMITED', 'CONSECUTIVE_FAILURES'].includes(result.stop) || result.counts.FAILED > 0) process.exitCode = 1;
  }).catch(error => {
    const code = error instanceof IancarOneApiError ? error.code : error instanceof Error && /^[A-Z0-9_]{3,64}$/.test(error.message) ? error.message : 'PHOTO_COPY_ERROR';
    console.error(code); process.exitCode = 2;
  });
}
