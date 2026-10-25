import { createConsumerGateway, parseConsumerBindings } from './consumer-gateway.js';
import { createConsumerDataAccessRuntime } from './data-access-runtime.js';
import { assertConsumerRuntime } from './runtime-policy.js';
import { approvedPhotoReaderFromEnv } from '../infra/drive-approved-photo-reader.js';
// Dedicated read service: no demo seed, worker, command route, or release publication.
assertConsumerRuntime();
const bindings = parseConsumerBindings(process.env.FREEPASS_DATA_CONSUMERS_JSON);
// 승인 사진(photo_original_refs) 읽기: FREEPASS_DATA_APPROVED_PHOTO_READER=drive-public 일 때만 주입(기본 꺼짐 → VEHICLE_PHOTO_READER_UNAVAILABLE 유지).
const runtime = createConsumerDataAccessRuntime(approvedPhotoReaderFromEnv());
const app = createConsumerGateway(runtime.projection, bindings, runtime.access, runtime.health, runtime.compat, runtime.workflow, runtime.estimateArtifacts);
await app.listen({ port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? '127.0.0.1' });
