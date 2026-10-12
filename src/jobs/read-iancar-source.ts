import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { collectIancarOneVehicleList } from '../adapters/iancar-one-api.js';

// 읽기 전용: 이안카 ONE API 목록을 있는 그대로 읽는다(GET 만, 쓰기 0). 열쇠는 비밀 저장소에서 이 프로세스 안으로만 읽고 출력·저장하지 않는다.
// 사용: tsx src/jobs/read-iancar-source.ts --out <저장소 밖 임시 경로.json>   (차량번호가 들어가므로 저장소 안에 두지 않는다)
const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
const secretName = process.env.IANCAR_ONE_API_SECRET || 'freepass-data-iancar-one-api';
const project = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
const apiKey = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${secretName}`, `--project=${project}`],
  { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const capture = await collectIancarOneVehicleList({ apiKey });
if (out) writeFileSync(out, JSON.stringify({ capturedAt: capture.capturedAt, syncedAt: capture.syncedAt, stale: capture.stale, total: capture.total,
  records: capture.records.map(r => r.payload) }));
console.log(JSON.stringify({ capturedAt: capture.capturedAt, syncedAt: capture.syncedAt, stale: capture.stale, total: capture.total, pages: capture.pages,
  records: capture.records.length, issues: capture.issues, readyForRawIngest: capture.readyForRawIngest,
  fields: Object.keys(capture.records[0]?.payload ?? {}) }, null, 1));
