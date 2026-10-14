/** 정체성 승격 계획서 입력 내보내기(읽기 전용, 쓰기 0). B3Q 에서:
 *   npm run export:identity-snapshot -- --erp5-capture <캡처.json> [--master <마스터 스냅샷.json>] --out <snapshot.json> [--all]
 * --master 가 없으면 활성 차종 마스터를 Data 게이트웨이로 읽는다(읽기 전용 트랜잭션). 결과를 그대로
 *   node dist/src/jobs/build-identity-promotion-plan.js --input <snapshot.json> --out <plan.json>
 * 에 넣는다(전체 번호 없음, 끝 4자리만). */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifiedErp5CaptureFromJson, type VehicleMasterSnapshot } from '../adapters/vehicle-identity-inputs.js';
import { identityMastersFromSnapshot, identityProductsFromCapture } from '../adapters/identity-snapshot.js';
import { captureVehicleMasterSnapshotReadOnly } from './data-access-runtime.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

export async function exportIdentitySnapshot(input: { erp5Capture: string; master?: string | undefined; out: string; includeAll?: boolean;
  readMaster?: () => Promise<Pick<VehicleMasterSnapshot, 'masters' | 'trims' | 'digest'>> }) {
  const capture = verifiedErp5CaptureFromJson(JSON.parse(await readFile(input.erp5Capture, 'utf8')));
  const master = input.master ? JSON.parse(await readFile(input.master, 'utf8')) as VehicleMasterSnapshot
    : await (input.readMaster ?? captureVehicleMasterSnapshotReadOnly)();
  const products = identityProductsFromCapture(capture, { includeAll: input.includeAll === true });
  const masters = identityMastersFromSnapshot(master);
  const label = `identity-snapshot capture ${capture.digest.slice(0, 12)} master ${String(master.digest ?? '').slice(0, 12)}`;
  await writeFile(input.out, JSON.stringify({ label, products, masters }, null, 2), { mode: 0o600 });
  return { status: 'EXPORTED' as const, writes: 0, products: products.length, masters: masters.length, label };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const erp5Capture = arg('--erp5-capture'), out = arg('--out');
  if (!erp5Capture || !out) { console.error('IDENTITY_SNAPSHOT_ARGS_REQUIRED'); process.exitCode = 1; }
  else exportIdentitySnapshot({ erp5Capture, master: arg('--master'), out, includeAll: process.argv.includes('--all') })
    .then(r => console.log(JSON.stringify(r)))
    .catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'IDENTITY_SNAPSHOT_FAILED'); process.exitCode = 1; });
}
