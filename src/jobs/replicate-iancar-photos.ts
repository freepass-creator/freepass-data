import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  eligibleIancarProductIds,
  replicateIancarPhotosPlanDigest,
  replicateIancarVehicle,
  type IancarAlbumPhoto,
  type ReplicateVehicleResult,
} from '../application/replicate-iancar-photos.js';
import { createPhotoRequestLimiter } from '../application/photo-request-limiter.js';
import {
  IancarOneApiError,
  createIancarOneApiClient,
  iancarOneApiConfigFromEnv,
  iancarOnePhotoIds,
  readIancarOnePhotoBytes,
} from '../adapters/iancar-one-api.js';
import { IANCAR_PHOTO_STORE_BUCKET } from '../domain/iancar-photo-store.js';
import { renderIancarPhotoRenditions } from '../infra/photo-renditioner-sharp.js';
import { createIancarPhotoStoreRuntime } from './data-access-runtime.js';

const USAGE = `USAGE: node dist/src/jobs/replicate-iancar-photos.js [--limit N] [--apply --digest <planDigest>]  (key: env EANCAR_ONE_API_KEY, never on the command line; apply bucket: IANCAR_PHOTO_STORE_BUCKET=${IANCAR_PHOTO_STORE_BUCKET})`;
const arg = (args: string[], key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
const observedAtOf = (product: Record<string, unknown>) =>
  Date.parse(String((product.iancar_photo_store as { observedAt?: string } | undefined)?.observedAt ?? '')) || 0;

/** 시험 실행이 기본: ONE 을 읽어 렌디션 크기·시간을 재지만 객체·문서는 쓰지 않는다. 터미널에는 차량번호·상품 ID 를 찍지 않는다. */
export async function runReplicateIancarPhotos(args: string[], env: NodeJS.ProcessEnv) {
  const apply = args.includes('--apply');
  const limit = Number(arg(args, '--limit') ?? '0') || 0;
  const digestArg = arg(args, '--digest');
  if (apply && !digestArg) throw new Error(USAGE);
  const bucket = apply ? (env.IANCAR_PHOTO_STORE_BUCKET ?? '') : null;
  if (apply && bucket !== IANCAR_PHOTO_STORE_BUCKET) throw new Error('IANCAR_PHOTO_STORE_WRONG_BUCKET');
  const config = iancarOneApiConfigFromEnv(env);
  if (!config.apiKey) throw new Error('IANCAR_ONE_API_KEY_REQUIRED');
  const client = createIancarOneApiClient(config);
  const limiter = createPhotoRequestLimiter({ maxConcurrent: 3, minIntervalMs: 300 });
  const runtime = await createIancarPhotoStoreRuntime(bucket);
  const products = await runtime.readProducts();
  const allIds = eligibleIancarProductIds(products);
  const planDigest = replicateIancarPhotosPlanDigest(allIds, IANCAR_PHOTO_STORE_BUCKET);
  if (apply && (env.FREEPASS_IANCAR_PHOTO_STORE_APPLY !== 'on' || env.FREEPASS_IANCAR_PHOTO_STORE_APPROVED !== planDigest || digestArg !== planDigest)) {
    throw new Error('IANCAR_PHOTO_STORE_NOT_APPROVED');
  }
  // 저장본이 없는 차를 먼저, 그다음 오래된 순.
  const ordered = [...allIds].sort((a, b) => observedAtOf(products[a]!) - observedAtOf(products[b]!));
  const targets = limit > 0 ? ordered.slice(0, limit) : ordered;
  const started = Date.now();
  const results: ReplicateVehicleResult[] = [];
  for (const [position, productId] of targets.entries()) {
    const product = products[productId]!;
    const vehicleId = product.iancar_one_vehicle_id as string;
    const result = await replicateIancarVehicle(productId, product, {
      getAlbum: (id, plate) => limiter.run(async () => {
        const detail = await client.getVehicle(id);
        const servingIds = iancarOnePhotoIds(detail, id, plate);
        const raw = ((detail as { data?: unknown }).data ?? detail) as { photos: Array<{ photo_id: string; representative: boolean }> };
        const upstream = raw.photos.map(photo => String(photo.photo_id).trim());
        return servingIds.map<IancarAlbumPhoto>(photoId => {
          const sourceOrdinal = upstream.indexOf(photoId);
          return { photoId, sourceOrdinal, representative: raw.photos[sourceOrdinal]!.representative };
        });
      }),
      getPhotoBytes: (id, photoId) => limiter.run(async () => readIancarOnePhotoBytes(await client.getPhoto(id, photoId))),
      renditioner: renderIancarPhotoRenditions,
      store: runtime.store,
      now: () => new Date(),
      ...(apply ? {
        publish: (pid: string, pointer: Parameters<typeof runtime.publish>[2], previous: string | null) =>
          runtime.publish(createHash('sha256').update(`${planDigest}:${pid}`).digest('hex'), pid, pointer, previous, vehicleId),
      } : {}),
    }, apply);
    results.push(result);
    if (position % 10 === 9) console.error(`progress ${position + 1}/${targets.length}`);
  }
  const sum = (pick: (r: ReplicateVehicleResult) => number) => results.reduce((total, r) => total + pick(r), 0);
  const byStatus: Record<string, number> = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const failures: Record<string, number> = {};
  for (const r of results) if (r.status === 'FAILED') failures[r.reason ?? 'UNKNOWN'] = (failures[r.reason ?? 'UNKNOWN'] ?? 0) + 1;
  return {
    mode: apply ? 'APPLY' : 'DRY_RUN', planDigest, eligibleVehicles: allIds.length, processed: results.length, byStatus, failures,
    photos: sum(r => r.photos), uploadedObjects: sum(r => r.uploadedObjects), existingObjects: sum(r => r.existingObjects),
    listBytes: sum(r => r.listBytes), detailBytes: sum(r => r.detailBytes), seconds: Math.round((Date.now() - started) / 1000),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReplicateIancarPhotos(process.argv.slice(2), process.env)
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof IancarOneApiError ? error.code : error instanceof Error && /^[A-Z0-9_ :<>\[\]\-.\/]+$/i.test(error.message) ? error.message : 'IANCAR_PHOTO_STORE_FAILED');
      process.exitCode = 1;
    });
}
